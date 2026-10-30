//! A workspace folder's right-click actions: open it in a known app, or copy
//! its path. The webview names the app from a fixed list rather than passing
//! a program, and the path must be an existing absolute directory. One file
//! of a checkout can be opened too, only in VS Code and only inside it.

use crate::files;
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Paths longer than this are not anyone's folder.
const MAX_PATH_BYTES: usize = 4096;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0} is not a folder")]
    NotFolder(String),
    #[error("{0} is not a file in this folder")]
    NotFile(String),
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

/// A path on another machine: only its shape can be checked here.
pub fn remote_path(path: &str) -> Result<(), Error> {
    if path.len() > MAX_PATH_BYTES || !path.starts_with('/') || path.chars().any(char::is_control) {
        return Err(Error::NotFolder(path.into()));
    }
    Ok(())
}

pub fn open(path: &str, with: Opener) -> Result<(), Error> {
    tauri_plugin_opener::open_path(folder(path)?, with.app()).map_err(Error::Open)
}

/// The file at `path` under the folder `root`, resolved through symlinks and
/// refused when it leaves the folder, as the Files panel's reads are.
fn file_in(root: &str, path: &str) -> Result<PathBuf, Error> {
    folder(root)?;
    let file = files::inside(root, path).map_err(|_| Error::NotFile(path.into()))?;
    if !file.is_file() {
        return Err(Error::NotFile(path.into()));
    }
    Ok(file)
}

/// Opens one file of the folder `root` in VS Code, the only editor offered.
pub fn open_file(root: &str, path: &str) -> Result<(), Error> {
    tauri_plugin_opener::open_path(file_in(root, path)?, Opener::VsCode.app()).map_err(Error::Open)
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
            assert!(
                matches!(folder(&refused), Err(Error::NotFolder(_))),
                "{refused}"
            );
        }
    }

    #[test]
    fn only_files_inside_the_folder_are_opened() {
        let dir = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let outside = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let root = dir.path().to_string_lossy().into_owned();
        std::fs::create_dir(dir.path().join("sub")).unwrap_or_else(|error| panic!("{error}"));
        std::fs::write(dir.path().join("sub/a.md"), "").unwrap_or_else(|error| panic!("{error}"));
        std::fs::write(outside.path().join("secret"), "").unwrap_or_else(|error| panic!("{error}"));
        assert!(file_in(&root, "sub/a.md").is_ok());
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path().join("secret"), dir.path().join("link"))
            .unwrap_or_else(|error| panic!("{error}"));
        for refused in ["sub", "missing.md", "../secret", "/etc/hosts", "sub/../../x", "", "link"] {
            assert!(
                matches!(file_in(&root, refused), Err(Error::NotFile(_))),
                "{refused}"
            );
        }
        assert!(matches!(file_in("relative", "sub/a.md"), Err(Error::NotFolder(_))));
    }

    #[test]
    fn files_uses_the_system_default() {
        assert_eq!(Opener::Files.app(), None);
        assert!(Opener::VsCode.app().is_some());
    }
}
