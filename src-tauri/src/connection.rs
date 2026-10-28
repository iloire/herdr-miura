//! One connection to the local Herdr daemon. `crate::herdr` runs the socket on
//! its own worker; this module drains its events on a pump thread and hands
//! them to the webview through the `Channel` the webview opened the
//! connection with. A reconnect gets a new channel, so events an old
//! connection still delivers can never reach the new one's listener.

use crate::{
    Error, Result,
    frame::{self, FrameUpdate},
    osc52,
};
use crate::herdr::{
    self, ClientHandle, ConnectOptions, Event, Outdated, Target,
    wire::{ClientShellSnapshot, PaneSurfaceFrame, ServerMessage},
};
use serde::Serialize;
use serde_json::Value;
use std::{
    sync::{Arc, Mutex, PoisonError, mpsc::Receiver},
    thread,
};
use tauri::{
    AppHandle,
    ipc::{Channel, InvokeResponseBody},
};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// What the webview hears. Protocol types serialize as they are, so the
/// TypeScript types in `src/protocol.ts` mirror Herdr's field names.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Outbound<'a> {
    Connected {
        server_version: &'a str,
        methods: &'a [String],
    },
    Snapshot {
        snapshot: &'a ClientShellSnapshot,
    },
    Frame(FrameUpdate<'a>),
    Response {
        request_id: &'a str,
        response: &'a Value,
    },
    Rejected {
        request_id: Option<&'a str>,
        reason: String,
    },
    Notify {
        title: &'a str,
        body: Option<&'a str>,
    },
    Bell,
    Title {
        title: Option<&'a str>,
    },
    ShellError {
        message: &'a str,
    },
    /// `outdated` names the side that must be updated.
    VersionMismatch {
        outdated: &'static str,
        server_version: Option<&'a str>,
    },
    UnknownHostKey {
        host: &'a str,
    },
    Disconnected {
        reason: &'a str,
    },
}

#[derive(Default)]
struct Live {
    handle: Option<ClientHandle>,
    /// The daemon is on another machine, so paths in its snapshot are not
    /// this machine's.
    remote: bool,
}

/// The live client's handle; the webview keeps the snapshot it acts on.
#[derive(Default)]
pub struct Connection(Mutex<Live>);

impl Connection {
    fn live(&self) -> std::sync::MutexGuard<'_, Live> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn handle(&self) -> Result<ClientHandle> {
        self.live().handle.clone().ok_or(Error::NotConnected)
    }

    /// Refuses work that reads this machine's disk or runs its `herdr` for a
    /// workspace that lives on another machine: the same path here is a
    /// different folder, or none, and the CLI would act on the local daemon.
    pub fn ensure_local(&self) -> Result<()> {
        if self.live().remote {
            return Err(Error::RemoteHost);
        }
        Ok(())
    }

    pub fn is_remote(&self) -> bool {
        self.live().remote
    }

    /// Replaces any current connection. The old worker is told to stop and
    /// winds down on its own thread; nothing here waits for it.
    pub fn connect(
        &self,
        app: AppHandle,
        target: Target,
        options: ConnectOptions,
        events: Channel<InvokeResponseBody>,
    ) -> Result<()> {
        let remote = matches!(target, Target::Ssh(_));
        let client = herdr::connect(target, options)?;
        {
            let mut live = self.live();
            if let Some(old) = live.handle.replace(client.handle) {
                old.disconnect();
            }
            live.remote = remote;
        }
        thread::Builder::new()
            .name("herdr-tauri-events".into())
            .spawn(move || pump(&client.events, &events, &app))
            .map_err(Error::Pump)?;
        Ok(())
    }

    pub fn disconnect(&self) {
        if let Some(handle) = self.live().handle.take() {
            handle.disconnect();
        }
    }
}

fn pump(
    events: &Receiver<Event>,
    channel: &Channel<InvokeResponseBody>,
    app: &AppHandle,
) {
    let mut shown: Option<Arc<PaneSurfaceFrame>> = None;
    for event in events {
        let outbound = match &event {
            Event::Connected(welcome) => Outbound::Connected {
                server_version: &welcome.server_version,
                methods: &welcome.methods,
            },
            Event::Snapshot(snapshot) => Outbound::Snapshot { snapshot },
            Event::Surface(surface) => {
                let update = frame::update(shown.as_deref(), surface);
                if send(channel, &Outbound::Frame(update)).is_err() {
                    return;
                }
                shown = Some(surface.clone());
                continue;
            }
            Event::Response {
                request_id,
                response,
            } => Outbound::Response {
                request_id,
                response,
            },
            Event::Rejected { request_id, reason } => Outbound::Rejected {
                request_id: request_id.as_deref(),
                reason: reason.to_string(),
            },
            Event::Message(message) => match message {
                ServerMessage::Clipboard { data } => {
                    // Only bounded UTF-8 text reaches the pasteboard.
                    if let Some(text) = osc52::decode(data) {
                        let _ = app.clipboard().write_text(text);
                    }
                    continue;
                }
                ServerMessage::Notify { message, body, .. } => Outbound::Notify {
                    title: message,
                    body: body.as_deref(),
                },
                ServerMessage::SemanticNotification(note) => Outbound::Notify {
                    title: &note.title,
                    body: note.body.as_deref(),
                },
                ServerMessage::TerminalBell { .. } => Outbound::Bell,
                ServerMessage::WindowTitle { title } => Outbound::Title {
                    title: title.as_deref(),
                },
                ServerMessage::ClientShellError { message } => Outbound::ShellError { message },
                _ => continue,
            },
            Event::VersionMismatch {
                outdated,
                server_version,
            } => Outbound::VersionMismatch {
                outdated: match outdated {
                    Outdated::Daemon => "daemon",
                    Outdated::Client => "client",
                },
                server_version: server_version.as_deref(),
            },
            Event::UnknownHostKey { host } => Outbound::UnknownHostKey { host },
            Event::Disconnected { reason } => Outbound::Disconnected { reason },
        };
        if send(channel, &outbound).is_err() {
            return;
        }
    }
}

fn send(channel: &Channel<InvokeResponseBody>, event: &Outbound<'_>) -> tauri::Result<()> {
    let json = serde_json::to_string(event)?;
    channel.send(InvokeResponseBody::Json(json))
}
