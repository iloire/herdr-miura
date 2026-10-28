//! Where the daemon's client socket is, by Herdr 0.9.5's own rules
//! (`src/server/socket_paths.rs`, `src/session.rs`, `src/config/io.rs`):
//!
//! 1. `HERDR_SOCKET_PATH` (the API socket) names its sibling `<stem>-client.sock`;
//! 2. else `HERDR_CLIENT_SOCKET_PATH`;
//! 3. else `herdr-client.sock` in the config directory, under
//!    `sessions/<name>` when `HERDR_SESSION` names a valid session other
//!    than `default`.
//!
//! The config directory is `$XDG_CONFIG_HOME/herdr`, else `~/.config/herdr`.
//! This app always dials the release daemon, never Herdr's `herdr-dev`.

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

pub fn client_socket_path() -> PathBuf {
    resolve(|name| std::env::var_os(name))
}

fn resolve(var: impl Fn(&str) -> Option<OsString>) -> PathBuf {
    if let Some(api) = var("HERDR_SOCKET_PATH") {
        return beside_api_socket(Path::new(&api));
    }
    if let Some(client) = var("HERDR_CLIENT_SOCKET_PATH") {
        return client.into();
    }
    let config = match var("XDG_CONFIG_HOME") {
        Some(dir) => PathBuf::from(dir).join("herdr"),
        None => match var("HOME") {
            Some(home) => PathBuf::from(home).join(".config/herdr"),
            None => std::env::temp_dir().join("herdr"),
        },
    };
    let session = var("HERDR_SESSION")
        .and_then(|name| name.into_string().ok())
        .filter(|name| name != "default" && valid_session(name));
    match session {
        Some(name) => config.join("sessions").join(name).join("herdr-client.sock"),
        None => config.join("herdr-client.sock"),
    }
}

fn beside_api_socket(api: &Path) -> PathBuf {
    let stem = api.file_stem().and_then(|s| s.to_str()).unwrap_or("herdr");
    api.parent()
        .unwrap_or_else(|| Path::new(""))
        .join(format!("{stem}-client.sock"))
}

/// Herdr's session names: 1–64 bytes of ASCII letters, digits, `.`, `_`, or
/// `-`, and not `.` or `..`. Anything else is ignored, as Herdr ignores it.
fn valid_session(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

#[cfg(test)]
mod tests;
