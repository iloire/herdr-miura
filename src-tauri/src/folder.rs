//! A workspace folder's right-click actions: open it in a known app, or copy
//! its path. The webview names the app from a fixed list rather than passing
//! a program, and the path must be an existing absolute directory.

use serde::Deserialize;
use std::path::Path;

/// Paths longer than this are not anyone's folder.
const MAX_PATH_BYTES: usize = 4096;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0} is not a folder")]
    NotFolder(String),
    #[error("could not open the folder")]
    Open(#[source] tauri_plugin_opener::Error),
    #[error("could not copy to the clipboard")]
    Clipboard(#[source] tauri_plugin_clipboard_manager::Error),
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Opener {
    /// The system's file manager.
    Files,
    VsCode,
    GithubDesktop,
}

impl Opener {
    /// The app to hand the folder to; `None` is the system default.
    fn app(self) -> Option<&'static str> {
        match self {
            Self::Files => None,
            Self::VsCode if cfg!(target_os = "macos") => Some("Visual Studio Code"),
            Self::VsCode => Some("code"),
            Self::GithubDesktop if cfg!(target_os = "macos") => Some("GitHub Desktop"),
            Self::GithubDesktop => Some("github-desktop"),
        }
    }
}

/// `path` when it is an existing absolute directory, which is all these
/// actions ever act on.
pub fn folder(path: &str) -> Result<&Path, Error> {
    let folder = Path::new(path);
    if path.len() > MAX_PATH_BYTES || !folder.is_absolute() || !folder.is_dir() {
        return Err(Error::NotFolder(path.into()));
    }
    Ok(folder)
}

pub fn open(path: &str, with: Opener) -> Result<(), Error> {
    tauri_plugin_opener::open_path(folder(path)?, with.app()).map_err(Error::Open)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_existing_absolute_directories_are_folders() {
        let dir = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "").unwrap_or_else(|error| panic!("{error}"));
        assert!(folder(&dir.path().to_string_lossy()).is_ok());
        for refused in [
            file.to_string_lossy().into_owned(),
            dir.path().join("missing").to_string_lossy().into_owned(),
            "relative/dir".to_owned(),
            String::new(),
        ] {
            assert!(matches!(folder(&refused), Err(Error::NotFolder(_))), "{refused}");
        }
    }

    #[test]
    fn files_uses_the_system_default() {
        assert_eq!(Opener::Files.app(), None);
        assert!(Opener::VsCode.app().is_some());
    }
}
