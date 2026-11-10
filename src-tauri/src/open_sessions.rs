//! Which Claude Code session is open in which pane, kept on disk so a restart
//! of the daemon (a reboot, most often) can resume each one in the pane it was
//! in. Herdr restores its workspaces, tabs and panes with their ids and
//! folders, but not the agents in them, and a pane's `claude_session` token
//! goes with its agent.
//!
//! One file, `~/.config/herdr/open-sessions-tauri.json`, beside the settings,
//! so Stable, Edge and a dev window share it. Each window sends what it sees
//! with the daemon's boot id. The first to send a new boot id gets the old
//! boot's panes back and replaces them, under a lock, so only one window
//! resumes them.

use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenSession {
    pub session: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub pane_id: String,
    /// The pane's folder, so a pane id handed to another pane is not taken for it.
    pub cwd: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Record {
    boot_id: String,
    panes: Vec<OpenSession>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no home folder to keep open sessions in")]
    NoHome,
    #[error("could not keep the open sessions: {0}")]
    Io(#[from] std::io::Error),
}

/// `~/.config/herdr/open-sessions-tauri.json`.
pub fn path() -> Result<PathBuf, Error> {
    let config = crate::settings::path().map_err(|_| Error::NoHome)?;
    Ok(config.with_file_name("open-sessions-tauri.json"))
}

/// Saves `panes` as the boot `boot_id`'s. When the file holds another boot,
/// returns that boot's panes, once: the caller resumes them.
pub fn sync(path: &Path, boot_id: &str, panes: Vec<OpenSession>) -> Result<Vec<OpenSession>, Error> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let lock = OpenOptions::new().create(true).truncate(false).write(true).open(path.with_extension("lock"))?;
    lock.lock()?;
    let saved = read(path);
    let left = match saved {
        Some(saved) if saved.boot_id == boot_id && saved.panes == panes => return Ok(Vec::new()),
        Some(saved) if saved.boot_id != boot_id => saved.panes,
        _ => Vec::new(),
    };
    let record = Record { boot_id: boot_id.to_owned(), panes };
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&record).unwrap_or_default())?;
    std::fs::rename(&tmp, path)?;
    Ok(left)
}

/// A file that cannot be read or parsed counts as none: nothing to resume.
fn read(path: &Path) -> Option<Record> {
    let mut text = String::new();
    File::open(path).ok()?.read_to_string(&mut text).ok()?;
    serde_json::from_str(&text).ok()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn pane(session: &str) -> OpenSession {
        OpenSession {
            session: session.into(),
            workspace_id: "w1".into(),
            tab_id: "w1:t2".into(),
            pane_id: "w1:p3".into(),
            cwd: "/code".into(),
        }
    }

    #[test]
    fn a_new_boot_gets_the_old_boots_panes_once() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("open.json");
        assert!(sync(&file, "a", vec![pane("s1")]).unwrap().is_empty());
        assert!(sync(&file, "a", vec![pane("s1"), pane("s2")]).unwrap().is_empty());
        assert_eq!(sync(&file, "b", vec![]).unwrap(), vec![pane("s1"), pane("s2")]);
        assert!(sync(&file, "b", vec![]).unwrap().is_empty());
    }

    #[test]
    fn a_first_run_or_a_broken_file_has_nothing_to_resume() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("open.json");
        assert!(sync(&file, "a", vec![pane("s1")]).unwrap().is_empty());
        std::fs::write(&file, "not json").unwrap();
        assert!(sync(&file, "b", vec![]).unwrap().is_empty());
    }
}
