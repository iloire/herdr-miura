//! One connection to the local Herdr daemon. `herdr-client` runs the socket on
//! its own worker; this module drains its events on a pump thread and hands
//! them to the webview through the `Channel` the webview opened the
//! connection with. A reconnect gets a new channel, so events an old
//! connection still delivers can never reach the new one's listener.

use crate::{
    Error, Result,
    frame::{self, FrameUpdate},
    osc52,
};
use herdr_client::{
    ClientEvent, ClientHandle, ConnectOptions, ConnectTarget, Receiver, VersionMismatch,
    protocol::{ClientShellSnapshot, PaneSurfaceFrame, ServerMessage},
};
use serde::Serialize;
use serde_json::Value;
use std::{
    sync::{Arc, Mutex, PoisonError},
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
    Disconnected {
        reason: &'a str,
    },
}

/// The live client's handle; the webview keeps the snapshot it acts on.
#[derive(Default)]
pub struct Connection(Mutex<Option<ClientHandle>>);

impl Connection {
    fn live(&self) -> std::sync::MutexGuard<'_, Option<ClientHandle>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn handle(&self) -> Result<ClientHandle> {
        self.live().clone().ok_or(Error::NotConnected)
    }

    /// Replaces any current connection. The old worker is told to stop and
    /// winds down on its own thread; nothing here waits for it.
    pub fn connect(
        &self,
        app: AppHandle,
        options: ConnectOptions,
        events: Channel<InvokeResponseBody>,
    ) -> Result<()> {
        let client = herdr_client::connect(ConnectTarget::Local, options)?;
        if let Some(old) = self.live().replace(client.handle) {
            old.disconnect();
        }
        thread::Builder::new()
            .name("herdr-tauri-events".into())
            .spawn(move || pump(&client.events, &events, &app))
            .map_err(Error::Pump)?;
        Ok(())
    }

    pub fn disconnect(&self) {
        if let Some(handle) = self.live().take() {
            handle.disconnect();
        }
    }
}

fn pump(
    events: &Receiver<ClientEvent>,
    channel: &Channel<InvokeResponseBody>,
    app: &AppHandle,
) {
    let mut shown: Option<Arc<PaneSurfaceFrame>> = None;
    for event in events {
        let outbound = match &event {
            ClientEvent::Connected(welcome) => Outbound::Connected {
                server_version: &welcome.server_version,
                methods: &welcome.methods,
            },
            ClientEvent::Snapshot(snapshot) => Outbound::Snapshot { snapshot },
            ClientEvent::Surface(surface) => {
                let update = frame::update(shown.as_deref(), surface);
                if send(channel, &Outbound::Frame(update)).is_err() {
                    return;
                }
                shown = Some(surface.clone());
                continue;
            }
            ClientEvent::Response {
                request_id,
                response,
            } => Outbound::Response {
                request_id,
                response,
            },
            ClientEvent::CommandRejected { request_id, reason } => Outbound::Rejected {
                request_id: request_id.as_deref(),
                reason: reason.to_string(),
            },
            ClientEvent::Message(message) => match message {
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
            ClientEvent::VersionMismatch(mismatch) => Outbound::VersionMismatch {
                outdated: match mismatch {
                    VersionMismatch::DaemonOutdated { .. } => "daemon",
                    VersionMismatch::ClientOutdated { .. } => "client",
                },
                server_version: mismatch.server_version(),
            },
            ClientEvent::Disconnected { reason, .. } => Outbound::Disconnected { reason },
            // Graphics are not drawn yet.
            ClientEvent::SurfaceImages(_) => continue,
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
