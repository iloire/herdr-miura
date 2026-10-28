use super::{codec, surface};
use std::{io, path::PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    // keep-sorted start
    #[error("the connection worker has stopped")]
    Closed,
    #[error(transparent)]
    Codec(#[from] codec::Error),
    #[error("the daemon offers codecs this app does not speak")]
    Codecs,
    #[error("a command for another daemon boot was dropped")]
    CommandBoot,
    #[error("could not reach the Herdr daemon at {}", path.display())]
    Connect {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("the terminal grid is empty")]
    EmptySurface,
    #[error("the daemon sent `{0}`, an encoding this connection did not ask for")]
    Encoding(String),
    #[error("the daemon's first message was not its welcome")]
    ExpectedWelcome,
    #[error("the daemon speaks endpoint generation {generation} (Herdr {server_version})")]
    Generation {
        generation: u32,
        server_version: String,
    },
    #[error("the terminal grid or cell is larger than Herdr allows")]
    GeometryLimit,
    #[error("the daemon sent no snapshot in time")]
    HandshakeTimeout,
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error("a daemon message was not valid JSON")]
    Json(#[from] serde_json::Error),
    #[error("the daemon is too old for this app: it predates the endpoint protocol")]
    LegacyDaemon,
    #[error("a patch arrived before any surface")]
    PatchBeforeBaseline,
    #[error("too many commands are waiting; this one was dropped")]
    QueueFull,
    #[error("the daemon did not answer a request in time")]
    RequestTimeout,
    #[error("a response came for another daemon boot")]
    ResponseBoot,
    #[error("a response does not carry its request's ID")]
    ResponseId,
    #[error("a response is larger than {} MiB", super::session::MAX_RESPONSE_BYTES >> 20)]
    ResponseLimit,
    #[error("the daemon shut down: {0}")]
    ServerShutdown(String),
    #[error("the daemon replaced its snapshot out of order")]
    SnapshotIdentity,
    #[error(transparent)]
    Surface(#[from] surface::Error),
    #[error("a surface arrived before the snapshot")]
    SurfaceBeforeSnapshot,
    #[error("a surface is older than the one shown, or for another boot")]
    SurfaceIdentity,
    #[error("could not start the connection worker")]
    Thread(#[source] io::Error),
    #[error("a response came for no request")]
    UnsolicitedResponse,
    #[error("this daemon does not offer `{0}`")]
    UnsupportedMethod(String),
    #[error("this platform has no Unix socket to reach Herdr through")]
    UnsupportedPlatform,
    #[error("the daemon sent an unexpected welcome kind")]
    WelcomeKind,
    #[error("the daemon refused the connection: {message} ({code})")]
    WelcomeRejected { code: String, message: String },
    // keep-sorted end
}

/// Which side of a generation mismatch must be updated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outdated {
    Client,
    Daemon,
}

impl Error {
    pub fn outdated(&self) -> Option<(Outdated, Option<&str>)> {
        match self {
            Self::LegacyDaemon => Some((Outdated::Daemon, None)),
            Self::Generation {
                generation,
                server_version,
            } => Some((
                if *generation > super::endpoint::ENDPOINT_PROTOCOL_GENERATION {
                    Outdated::Client
                } else {
                    Outdated::Daemon
                },
                Some(server_version),
            )),
            _ => None,
        }
    }
}
