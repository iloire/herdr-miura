//! One connection's state, apart from its socket: the handshake, the snapshot
//! and surface fenced by boot and revision, and the ordered outbound queue
//! with its single API request in flight. Herdr gives each connection one
//! request lease, so a request waits for the previous answer, and input
//! queued behind it waits too, keeping everything in the order it was sent.

use super::{
    Error, Result, codec,
    endpoint::{
        BLOB_CODEC_V1, ENDPOINT_PROTOCOL_GENERATION, ENDPOINT_SNAPSHOT_KIND, ENDPOINT_WELCOME_KIND,
        EndpointServerWelcome, INPUT_CODEC_V1, SNAPSHOT_CODEC_V1, SURFACE_CODEC_V1,
    },
    surface,
    wire::{ClientMessage, ClientShellSnapshot, PaneSurfaceFrame, ServerMessage},
};
use serde_json::Value;
use std::{
    collections::VecDeque,
    io::Write,
    sync::Arc,
    time::{Duration, Instant},
};

/// Commands held behind a request awaiting its answer.
pub const MAX_QUEUED: usize = 64;
/// One response's JSON, assembled from its chunks.
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
/// From connecting to the first snapshot.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// From sending a request to its last chunk.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Optional surface encodings this client never asks for; one arriving
/// anyway would leave the screen stale, so it ends the connection instead.
const UNREQUESTED_ENCODINGS: &[&str] = &[
    "endpoint.surface-delta.v1",
    "endpoint.surface-reuse.v1",
    "endpoint.surface-scroll.v1",
];

/// What a connection tells the app, in the order it happened.
#[derive(Debug)]
pub enum Event {
    Connected(EndpointServerWelcome),
    Snapshot(Arc<ClientShellSnapshot>),
    /// A complete surface for the current snapshot, patches applied.
    Surface(Arc<PaneSurfaceFrame>),
    Response {
        request_id: String,
        response: Value,
    },
    /// A command dropped before it reached the daemon.
    Rejected {
        request_id: Option<String>,
        reason: Error,
    },
    /// Everything else the daemon says, for the app to act on or ignore.
    Message(ServerMessage),
    /// One side must be updated before they can talk.
    VersionMismatch {
        outdated: super::Outdated,
        server_version: Option<String>,
    },
    /// The last event of a connection that was not stopped by its handle.
    Disconnected {
        reason: String,
    },
}

#[derive(Debug)]
pub struct Request {
    pub id: String,
    pub method: String,
}

#[derive(Debug)]
pub struct Command {
    /// The boot the caller saw; a command for an older boot is dropped.
    pub boot_id: String,
    pub message: ClientMessage,
    pub request: Option<Request>,
}

struct Pending {
    id: String,
    bytes: Vec<u8>,
    started: Instant,
}

pub struct Session {
    started: Instant,
    welcome: Option<EndpointServerWelcome>,
    snapshot: Option<Arc<ClientShellSnapshot>>,
    surface: Option<Arc<PaneSurfaceFrame>>,
    pending: Option<Pending>,
    queue: VecDeque<Command>,
}

impl Session {
    pub fn new(started: Instant) -> Self {
        Self {
            started,
            welcome: None,
            snapshot: None,
            surface: None,
            pending: None,
            queue: VecDeque::new(),
        }
    }

    /// Queues `command`. A full queue drops it and returns its request ID,
    /// if it had one, to report the drop by.
    pub fn enqueue(&mut self, command: Command) -> Result<(), Option<String>> {
        if self.queue.len() >= MAX_QUEUED {
            return Err(command.request.map(|r| r.id));
        }
        self.queue.push_back(command);
        Ok(())
    }

    /// When [`Self::check_timeouts`] would next fail the connection.
    pub fn deadline(&self) -> Option<Instant> {
        let handshake = self
            .snapshot
            .is_none()
            .then(|| self.started + HANDSHAKE_TIMEOUT);
        let request = self.pending.as_ref().map(|p| p.started + REQUEST_TIMEOUT);
        handshake.into_iter().chain(request).min()
    }

    pub fn check_timeouts(&self, now: Instant) -> Result<()> {
        if self.snapshot.is_none() && now >= self.started + HANDSHAKE_TIMEOUT {
            return Err(Error::HandshakeTimeout);
        }
        if self
            .pending
            .as_ref()
            .is_some_and(|p| now >= p.started + REQUEST_TIMEOUT)
        {
            return Err(Error::RequestTimeout);
        }
        Ok(())
    }

    fn rejection(&self, command: &Command) -> Option<Error> {
        if self
            .snapshot
            .as_ref()
            .is_none_or(|s| s.boot_id != command.boot_id)
        {
            return Some(Error::CommandBoot);
        }
        let request = command.request.as_ref()?;
        let offered = self
            .welcome
            .as_ref()
            .is_some_and(|w| w.methods.iter().any(|m| m == &request.method));
        (!offered).then(|| Error::UnsupportedMethod(request.method.clone()))
    }

    /// Writes queued commands in order until one must wait for an answer.
    /// A command that cannot be sent is dropped and reported; the rest go on.
    pub fn flush(
        &mut self,
        out: &mut impl Write,
        now: Instant,
        mut emit: impl FnMut(Event),
    ) -> Result<()> {
        while let Some(command) = self.queue.front() {
            if command.request.is_some() && self.pending.is_some() {
                return Ok(());
            }
            let Some(command) = self.queue.pop_front() else {
                return Ok(());
            };
            let request_id = command.request.as_ref().map(|r| r.id.clone());
            let frame = match self.rejection(&command) {
                Some(reason) => Err(reason),
                None => codec::encode(&command.message).map_err(Error::from),
            };
            let frame = match frame {
                Ok(frame) => frame,
                Err(reason) => {
                    emit(Event::Rejected { request_id, reason });
                    continue;
                }
            };
            out.write_all(&frame)?;
            if let Some(id) = request_id {
                self.pending = Some(Pending {
                    id,
                    bytes: Vec::new(),
                    started: now,
                });
            }
        }
        Ok(out.flush()?)
    }

    pub fn handle(&mut self, message: ServerMessage, mut emit: impl FnMut(Event)) -> Result<()> {
        if self.welcome.is_none() {
            let welcome = welcome(message)?;
            emit(Event::Connected(welcome.clone()));
            self.welcome = Some(welcome);
            return Ok(());
        }
        match message {
            ServerMessage::EndpointControl { kind, data } if kind == ENDPOINT_SNAPSHOT_KIND => {
                self.snapshot(serde_json::from_str(&data)?, &mut emit)
            }
            ServerMessage::EndpointControl { kind, .. }
                if UNREQUESTED_ENCODINGS.contains(&kind.as_str()) =>
            {
                Err(Error::Encoding(kind))
            }
            // Unknown named controls are optional, and ignored.
            ServerMessage::EndpointControl { .. } => Ok(()),
            ServerMessage::PaneSurface(next) => self.surface(next, &mut emit),
            ServerMessage::PaneSurfacePatch(patch) => {
                let current = self.surface.as_mut().ok_or(Error::PatchBeforeBaseline)?;
                surface::apply(Arc::make_mut(current), patch)?;
                if self
                    .snapshot
                    .as_ref()
                    .is_some_and(|s| s.revision == current.projection_revision)
                {
                    emit(Event::Surface(current.clone()));
                }
                Ok(())
            }
            ServerMessage::ClientShellEndpointResponseChunk {
                boot_id,
                request_id,
                final_chunk,
                data,
            } => self.response_chunk(&boot_id, request_id, final_chunk, data, &mut emit),
            ServerMessage::ServerShutdown { reason } => Err(Error::ServerShutdown(
                reason.unwrap_or_else(|| "no reason given".into()),
            )),
            other => {
                emit(Event::Message(other));
                Ok(())
            }
        }
    }

    /// A snapshot replaces the last one within a boot, never goes back, and
    /// re-shows a held surface that was waiting for its projection.
    fn snapshot(&mut self, next: ClientShellSnapshot, emit: &mut impl FnMut(Event)) -> Result<()> {
        if next.boot_id.is_empty()
            || self
                .snapshot
                .as_ref()
                .is_some_and(|s| s.boot_id != next.boot_id || next.revision < s.revision)
        {
            return Err(Error::SnapshotIdentity);
        }
        let changed = self
            .snapshot
            .as_ref()
            .is_none_or(|s| s.revision != next.revision);
        let next = Arc::new(next);
        self.snapshot = Some(next.clone());
        emit(Event::Snapshot(next.clone()));
        if changed
            && let Some(held) = self
                .surface
                .as_ref()
                .filter(|s| s.projection_revision == next.revision)
        {
            emit(Event::Surface(held.clone()));
        }
        Ok(())
    }

    /// A whole surface is newer than the last on the same boot, and valid.
    /// It is kept as the base for patches even when its projection is not the
    /// snapshot's yet, and shown once they match.
    fn surface(&mut self, next: PaneSurfaceFrame, emit: &mut impl FnMut(Event)) -> Result<()> {
        let snapshot = self.snapshot.as_ref().ok_or(Error::SurfaceBeforeSnapshot)?;
        if next.boot_id != snapshot.boot_id
            || self
                .surface
                .as_ref()
                .is_some_and(|old| next.surface_revision <= old.surface_revision)
        {
            return Err(Error::SurfaceIdentity);
        }
        surface::validate_surface(&next)?;
        let next = Arc::new(next);
        if next.projection_revision == snapshot.revision {
            emit(Event::Surface(next.clone()));
        }
        self.surface = Some(next);
        Ok(())
    }

    fn response_chunk(
        &mut self,
        boot_id: &str,
        request_id: String,
        final_chunk: bool,
        data: Vec<u8>,
        emit: &mut impl FnMut(Event),
    ) -> Result<()> {
        if self.snapshot.as_ref().is_none_or(|s| s.boot_id != boot_id) {
            return Err(Error::ResponseBoot);
        }
        let pending = self
            .pending
            .as_mut()
            .filter(|p| p.id == request_id)
            .ok_or(Error::UnsolicitedResponse)?;
        if data.len() > MAX_RESPONSE_BYTES.saturating_sub(pending.bytes.len()) {
            return Err(Error::ResponseLimit);
        }
        pending.bytes.extend(data);
        if !final_chunk {
            return Ok(());
        }
        let bytes = self.pending.take().map(|p| p.bytes).unwrap_or_default();
        let response: Value = serde_json::from_slice(&bytes)?;
        if response.get("id").and_then(Value::as_str) != Some(request_id.as_str()) {
            return Err(Error::ResponseId);
        }
        emit(Event::Response {
            request_id,
            response,
        });
        Ok(())
    }
}

/// The daemon's first message: its welcome, at our generation, with the
/// codecs this client speaks.
fn welcome(message: ServerMessage) -> Result<EndpointServerWelcome> {
    let data = match message {
        ServerMessage::EndpointControl { kind, data } if kind == ENDPOINT_WELCOME_KIND => data,
        ServerMessage::EndpointControl { .. } => return Err(Error::WelcomeKind),
        // Only a daemon from before the endpoint protocol answers with this.
        ServerMessage::Welcome { .. } => return Err(Error::LegacyDaemon),
        _ => return Err(Error::ExpectedWelcome),
    };
    let welcome: EndpointServerWelcome = serde_json::from_str(&data)?;
    // A refusal carries the daemon's own generation, so check that first:
    // it says which side is older.
    if welcome.generation != ENDPOINT_PROTOCOL_GENERATION {
        return Err(Error::Generation {
            generation: welcome.generation,
            server_version: welcome.server_version,
        });
    }
    if let Some(error) = welcome.error {
        return Err(Error::WelcomeRejected {
            code: error.code,
            message: error.message,
        });
    }
    if welcome.snapshot_codec != SNAPSHOT_CODEC_V1
        || welcome.surface_codec != SURFACE_CODEC_V1
        || welcome.input_codec != INPUT_CODEC_V1
        || welcome.blob_codec != BLOB_CODEC_V1
    {
        return Err(Error::Codecs);
    }
    Ok(welcome)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
pub(crate) mod tests;
