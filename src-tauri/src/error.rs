use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Changes(#[from] crate::changes::Error),
    #[error(transparent)]
    Folder(#[from] crate::folder::Error),
    #[error(transparent)]
    Client(#[from] herdr_client::Error),
    #[error("event pump not started")]
    Pump(#[source] std::io::Error),
    #[error("not connected to a Herdr daemon")]
    NotConnected,
    #[error("no snapshot yet, so `{0}` has nothing to act on")]
    NoSnapshot(String),
    #[error("unknown command `{0}`")]
    UnknownCommand(String),
    #[error("`{0}` has no daemon request: it runs in the window, or nothing is focused")]
    WindowCommand(String),
    #[error("unknown method `{0}`")]
    UnknownMethod(String),
}

/// The webview is the display boundary: it receives the message, not the
/// structure, so the source chain stays typed until here.
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
