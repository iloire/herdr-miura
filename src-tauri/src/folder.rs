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
    #[error("{0} is not a file")]
    NotLooseFile(String),
    #[error("{0} could run a program, so it is not opened from a link")]
    Runnable(String),
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

/// What a terminal link to a file can do with it, wherever it is.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileAction {
    /// The app the system opens this kind of file in.
    Default,
    VsCode,
    /// Shown selected in the file manager.
    Reveal,
}

/// Extensions macOS runs rather than shows when opened.
const RUNNABLE: &[&str] = &[
    "command", "tool", "terminal", "sh", "bash", "zsh", "csh", "ksh", "fish", "pkg", "mpkg",
    "workflow", "scpt", "scptd", "applescript", "jar", "fileloc", "webloc", "inetloc", "action",
    "prefpane", "desktop", "appimage", "run",
];

/// Whether opening `file` in its default app would run something: an
/// executable, or a kind of file the system runs.
fn runnable(file: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if file.metadata().is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0) {
            return true;
        }
    }
    file.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| RUNNABLE.contains(&extension.to_ascii_lowercase().as_str()))
}

/// `path` when it is an existing absolute file.
fn loose_file(path: &str) -> Result<&Path, Error> {
    let file = Path::new(path);
    if path.len() > MAX_PATH_BYTES || !file.is_absolute() || !file.is_file() {
        return Err(Error::NotLooseFile(path.into()));
    }
    Ok(file)
}

/// Acts on a file a terminal link names, in a checkout or not. The default
/// app is refused for anything it would run, as a link is only text a
/// program printed.
pub fn open_link_file(path: &str, with: FileAction) -> Result<(), Error> {
    let file = loose_file(path)?;
    match with {
        FileAction::Reveal => tauri_plugin_opener::reveal_item_in_dir(file).map_err(Error::Open),
        FileAction::VsCode => tauri_plugin_opener::open_path(file, Opener::VsCode.app()).map_err(Error::Open),
        FileAction::Default if runnable(file) => Err(Error::Runnable(path.into())),
        FileAction::Default => tauri_plugin_opener::open_path(file, None::<&str>).map_err(Error::Open),
    }
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
    fn runnable_files_are_told_apart() {
        let dir = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let write = |name: &str| {
            let file = dir.path().join(name);
            std::fs::write(&file, "").unwrap_or_else(|error| panic!("{error}"));
            file
        };
        assert!(!runnable(&write("shot.png")));
        assert!(runnable(&write("run.command")));
        assert!(runnable(&write("Install.SH")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let tool = write("tool");
            std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755))
                .unwrap_or_else(|error| panic!("{error}"));
            assert!(runnable(&tool));
        }
        assert!(loose_file(&dir.path().to_string_lossy()).is_err());
        assert!(loose_file("shot.png").is_err());
        assert!(loose_file(&dir.path().join("shot.png").to_string_lossy()).is_ok());
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
