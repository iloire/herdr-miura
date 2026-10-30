use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Changes(#[from] crate::changes::Error),
    #[error(transparent)]
    ClaudeUsage(#[from] crate::claude_usage::Error),
    #[error(transparent)]
    Files(#[from] crate::files::Error),
    #[error(transparent)]
    TabMove(#[from] crate::tab_move::Error),
    #[error(transparent)]
    PromptCreate(#[from] crate::prompts::CreateError),
    #[error(transparent)]
    Queue(#[from] crate::queue::StoreError),
    #[error(transparent)]
    TeamCreate(#[from] crate::team::CreateError),
    #[error(transparent)]
    Settings(#[from] crate::settings::Error),
    #[error(transparent)]
    SshHosts(#[from] crate::ssh_hosts::Error),
    #[error(transparent)]
    Folder(#[from] crate::folder::Error),
    #[error(transparent)]
    Herdr(#[from] crate::herdr::Error),
    #[error(transparent)]
    ListeningPorts(#[from] crate::listening_ports::Error),
    #[error("event pump not started")]
    Pump(#[source] std::io::Error),
    #[error("not connected to a Herdr daemon")]
    NotConnected,
    #[error("that workspace is on another machine, so this Mac cannot open or read it")]
    RemoteHost,
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
