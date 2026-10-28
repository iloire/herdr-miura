//! The connection worker and the handle the app drives it with. Two threads
//! per connection: one only reads whole frames off the socket, so a frame is
//! never left half-read, and one owns the [`Session`], writing commands in
//! order and applying what the reader hands it. The handle queues work on a
//! bounded channel and never blocks or touches the socket itself.
//!
//! Nothing here reconnects or replays: a failed connection reports why and
//! stops, and the app decides whether to connect again.

use super::{
    Error, Result, codec,
    endpoint::{
        BLOB_CODEC_V1, ENDPOINT_HELLO_KIND, ENDPOINT_PROTOCOL_GENERATION, EndpointClientHello,
        INPUT_CODEC_V1, SNAPSHOT_CODEC_V1, SURFACE_CODEC_V1,
    },
    session::{Command, Event, Request, Session},
    socket,
    wire::{ClientMessage, ClientPaneInputEvent, ClientSurfaceSize, ServerMessage},
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError},
    },
    thread,
    time::{Duration, Instant},
};

/// Commands and inbound frames the worker has not taken yet.
const INBOX: usize = 256;
/// Events the app has not drained yet. The worker waits when it is full.
const EVENTS: usize = 64;
/// Longest the worker sleeps with no deadline due.
const IDLE: Duration = Duration::from_secs(5);
/// A daemon that stops reading fails the connection after this long.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// The grid the app shows and its cell size in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectOptions {
    pub surface_size: ClientSurfaceSize,
    pub cell_width_px: u32,
    pub cell_height_px: u32,
}

impl ConnectOptions {
    /// Herdr's own bounds on a client grid.
    fn validate(&self) -> Result<()> {
        let size = self.surface_size;
        if size.cols == 0 || size.rows == 0 {
            return Err(Error::EmptySurface);
        }
        if size.cols > 4096
            || size.rows > 4096
            || u32::from(size.cols) * u32::from(size.rows) > 1_000_000
            || self.cell_width_px > 4096
            || self.cell_height_px > 4096
        {
            return Err(Error::GeometryLimit);
        }
        Ok(())
    }
}

enum Input {
    Command(Command),
    Inbound(ServerMessage),
    ReadFailed(codec::Error),
    Stop,
}

pub struct Client {
    pub handle: ClientHandle,
    pub events: Receiver<Event>,
}

#[derive(Clone)]
pub struct ClientHandle {
    inbox: SyncSender<Input>,
    stop: Arc<AtomicBool>,
    next_request: Arc<AtomicU64>,
}

/// Starts a connection to the local daemon. It returns at once; the socket
/// is opened on the worker, and a failure arrives as `Disconnected`.
pub fn connect(options: ConnectOptions) -> Result<Client> {
    connect_at(socket::client_socket_path(), options)
}

pub(crate) fn connect_at(path: PathBuf, options: ConnectOptions) -> Result<Client> {
    options.validate()?;
    let (inbox, worker_inbox) = mpsc::sync_channel(INBOX);
    let (events_tx, events) = mpsc::sync_channel(EVENTS);
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = stop.clone();
    let reader_inbox = inbox.clone();
    thread::Builder::new()
        .name("herdr-session".into())
        .spawn(move || {
            let emit = |event| {
                // A dropped receiver means the app let this connection go.
                let _ = events_tx.send(event);
            };
            let result = run(
                &path,
                options,
                &worker_inbox,
                reader_inbox,
                &worker_stop,
                emit,
            );
            if worker_stop.load(Ordering::Acquire) {
                return;
            }
            let reason = match result {
                Ok(()) => "the connection closed".to_owned(),
                Err(error) => {
                    if let Some((outdated, server_version)) = error.outdated() {
                        emit(Event::VersionMismatch {
                            outdated,
                            server_version: server_version.map(str::to_owned),
                        });
                    }
                    display(&error)
                }
            };
            emit(Event::Disconnected { reason });
        })
        .map_err(Error::Thread)?;
    Ok(Client {
        handle: ClientHandle {
            inbox,
            stop,
            next_request: Arc::new(AtomicU64::new(1)),
        },
        events,
    })
}

/// The error and its causes on one line, bounded and free of controls,
/// since the daemon's own text can be part of it.
fn display(error: &Error) -> String {
    let mut text = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text.chars()
        .filter(|c| !c.is_control())
        .take(1024)
        .collect()
}

#[cfg(unix)]
fn run(
    path: &Path,
    options: ConnectOptions,
    inbox: &Receiver<Input>,
    reader_inbox: SyncSender<Input>,
    stop: &AtomicBool,
    mut emit: impl FnMut(Event),
) -> Result<()> {
    use std::{net::Shutdown, os::unix::net::UnixStream};

    let mut stream = UnixStream::connect(path).map_err(|source| Error::Connect {
        path: path.to_owned(),
        source,
    })?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
    let mut reader = stream.try_clone()?;
    thread::Builder::new()
        .name("herdr-reader".into())
        .spawn(move || {
            loop {
                let input = match codec::read(&mut reader) {
                    Ok(message) => Input::Inbound(message),
                    Err(error) => Input::ReadFailed(error),
                };
                let failed = matches!(input, Input::ReadFailed(_));
                if reader_inbox.send(input).is_err() || failed {
                    return;
                }
            }
        })
        .map_err(Error::Thread)?;
    // Shutting the socket down also ends the reader's blocking read.
    let result = drive(options, &mut stream, inbox, stop, &mut emit);
    let _ = stream.shutdown(Shutdown::Both);
    result
}

#[cfg(not(unix))]
fn run(
    _: &Path,
    _: ConnectOptions,
    _: &Receiver<Input>,
    _: SyncSender<Input>,
    _: &AtomicBool,
    _: impl FnMut(Event),
) -> Result<()> {
    Err(Error::UnsupportedPlatform)
}

#[cfg_attr(not(unix), allow(dead_code))]
fn drive(
    options: ConnectOptions,
    stream: &mut impl std::io::Write,
    inbox: &Receiver<Input>,
    stop: &AtomicBool,
    emit: &mut impl FnMut(Event),
) -> Result<()> {
    codec::write(stream, &hello(options)?)?;
    let mut session = Session::new(Instant::now());
    while !stop.load(Ordering::Acquire) {
        let now = Instant::now();
        let wait = session
            .deadline()
            .map_or(IDLE, |due| due.saturating_duration_since(now).min(IDLE));
        match inbox.recv_timeout(wait) {
            Ok(Input::Stop) | Err(RecvTimeoutError::Disconnected) => return Ok(()),
            Ok(Input::Command(command)) => {
                if let Err(request_id) = session.enqueue(command) {
                    emit(Event::Rejected {
                        request_id,
                        reason: Error::QueueFull,
                    });
                }
            }
            Ok(Input::Inbound(message)) => session.handle(message, &mut *emit)?,
            Ok(Input::ReadFailed(codec::Error::Closed)) => return Ok(()),
            Ok(Input::ReadFailed(error)) => return Err(error.into()),
            Err(RecvTimeoutError::Timeout) => {}
        }
        if stop.load(Ordering::Acquire) {
            return Ok(());
        }
        let now = Instant::now();
        session.check_timeouts(now)?;
        session.flush(stream, now, &mut *emit)?;
    }
    Ok(())
}

/// The optional surface encodings stay off, so every surface arrives whole
/// or as a plain row patch; over a local socket the extra bytes are cheap.
fn hello(options: ConnectOptions) -> Result<ClientMessage> {
    let hello = EndpointClientHello {
        generation: ENDPOINT_PROTOCOL_GENERATION,
        cell_width_px: options.cell_width_px,
        cell_height_px: options.cell_height_px,
        surface_size: options.surface_size,
        pixel_mouse: false,
        direct_graphics: false,
        endpoint_keybindings: false,
        mouse_capture: false,
        surface_active: true,
        surface_reuse: false,
        surface_delta: false,
        surface_scroll: false,
        snapshot_codecs: vec![SNAPSHOT_CODEC_V1.into()],
        surface_codecs: vec![SURFACE_CODEC_V1.into()],
        input_codecs: vec![INPUT_CODEC_V1.into()],
        blob_codecs: vec![BLOB_CODEC_V1.into()],
    };
    Ok(ClientMessage::EndpointControl {
        kind: ENDPOINT_HELLO_KIND.into(),
        data: serde_json::to_string(&hello)?,
    })
}

impl ClientHandle {
    fn enqueue(
        &self,
        boot_id: &str,
        message: ClientMessage,
        request: Option<Request>,
    ) -> Result<()> {
        if self.stop.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let command = Command {
            boot_id: boot_id.into(),
            message,
            request,
        };
        self.inbox
            .try_send(Input::Command(command))
            .map_err(|error| match error {
                TrySendError::Full(_) => Error::QueueFull,
                TrySendError::Disconnected(_) => Error::Closed,
            })
    }

    /// Queues an endpoint request and returns its ID; the answer arrives as
    /// an [`Event::Response`] carrying it.
    pub fn request(&self, boot_id: &str, method: &str, params: Value) -> Result<String> {
        let id = format!(
            "tauri-{}",
            self.next_request.fetch_add(1, Ordering::Relaxed)
        );
        let request = json!({"id": id, "method": method, "params": params}).to_string();
        self.enqueue(
            boot_id,
            ClientMessage::ClientShellEndpointRequest {
                boot_id: boot_id.into(),
                request,
            },
            Some(Request {
                id: id.clone(),
                method: method.into(),
            }),
        )?;
        Ok(id)
    }

    pub fn send_input(
        &self,
        boot_id: &str,
        pane_id: &str,
        events: Vec<ClientPaneInputEvent>,
    ) -> Result<()> {
        let message = ClientMessage::ClientShellPaneInput {
            pane_id: pane_id.into(),
            events,
        };
        self.enqueue(boot_id, message, None)
    }

    pub fn send_popup_input(
        &self,
        boot_id: &str,
        terminal_id: &str,
        events: Vec<ClientPaneInputEvent>,
    ) -> Result<()> {
        let message = ClientMessage::ClientShellPopupInput {
            terminal_id: terminal_id.into(),
            events,
        };
        self.enqueue(boot_id, message, None)
    }

    pub fn resize(&self, boot_id: &str, options: ConnectOptions) -> Result<()> {
        options.validate()?;
        let message = ClientMessage::ClientShellResize {
            cell_width_px: options.cell_width_px,
            cell_height_px: options.cell_height_px,
            surface_size: options.surface_size,
            pixel_mouse: false,
        };
        self.enqueue(boot_id, message, None)
    }

    pub fn set_focus(&self, boot_id: &str, focused: bool) -> Result<()> {
        self.enqueue(boot_id, ClientMessage::ClientShellFocus { focused }, None)
    }

    /// Stops the connection without sending what is still queued. The worker
    /// winds down on its own; nothing here waits for it.
    pub fn disconnect(&self) {
        self.stop.store(true, Ordering::Release);
        // A full inbox still sees `stop` on the worker's next wake.
        let _ = self.inbox.try_send(Input::Stop);
    }
}

#[cfg(all(test, unix))]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
