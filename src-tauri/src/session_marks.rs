//! What a person put on a Claude Code session in the Sessions panel: a star,
//! and a name of their own. Herdr's alone, never written into a transcript,
//! as that file is Claude Code's.
//!
//! One file, `~/.config/herdr/session-marks.json`, beside the settings, so
//! Stable, Edge and a dev window share it. Each change rereads it under a lock,
//! so two windows marking at once both keep their mark.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

use crate::session_usage::is_session_id;

/// Characters of a name kept.
const MAX_NAME_CHARS: usize = 200;

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mark {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub starred: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Each marked session's mark, by session id.
pub type Marks = HashMap<String, Mark>;

/// A change to one session's mark.
pub enum Change {
    Star(bool),
    /// `None` or an empty name takes the name off.
    Name(Option<String>),
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no home folder to keep session marks in")]
    NoHome,
    #[error("not a session id: {0:?}")]
    BadId(String),
    #[error("could not keep the session marks: {0}")]
    Io(#[from] std::io::Error),
}

/// `~/.config/herdr/session-marks.json`.
pub fn path() -> Result<PathBuf, Error> {
    let config = crate::settings::path().map_err(|_| Error::NoHome)?;
    Ok(config.with_file_name("session-marks.json"))
}

/// The marks, or none when the file is missing or cannot be parsed.
pub fn read(path: &Path) -> Marks {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

/// Applies `change` to `session`'s mark. A mark with nothing left on it goes.
pub fn change(path: &Path, session: &str, change: Change) -> Result<Mark, Error> {
    if !is_session_id(session) {
        return Err(Error::BadId(session.to_owned()));
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let lock = OpenOptions::new().create(true).truncate(false).write(true).open(path.with_extension("lock"))?;
    lock.lock()?;
    let mut marks = read(path);
    let mark = marks.entry(session.to_owned()).or_default();
    match change {
        Change::Star(starred) => mark.starred = starred,
        Change::Name(name) => {
            let name = name.map(|name| name.split_whitespace().collect::<Vec<_>>().join(" "));
            mark.name = name.filter(|name| !name.is_empty()).map(|name| name.chars().take(MAX_NAME_CHARS).collect());
        }
    }
    let mark = mark.clone();
    if mark == Mark::default() {
        marks.remove(session);
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&marks).unwrap_or_default())?;
    std::fs::rename(&tmp, path)?;
    Ok(mark)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const ID: &str = "0f2736ab-56ae-454c-ad08-fc76c65f788f";

    #[test]
    fn a_star_and_a_name_are_kept_together() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("marks.json");
        change(&file, ID, Change::Star(true)).unwrap();
        change(&file, ID, Change::Name(Some("  the  favicon one ".into()))).unwrap();
        assert_eq!(read(&file)[ID], Mark { starred: true, name: Some("the favicon one".into()) });
    }

    #[test]
    fn a_mark_with_nothing_on_it_goes() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("marks.json");
        change(&file, ID, Change::Star(true)).unwrap();
        change(&file, ID, Change::Name(Some(String::new()))).unwrap();
        assert!(read(&file)[ID].name.is_none());
        change(&file, ID, Change::Star(false)).unwrap();
        assert!(read(&file).is_empty());
    }

    #[test]
    fn only_a_session_id_is_marked() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("marks.json");
        assert!(matches!(change(&file, "../x", Change::Star(true)), Err(Error::BadId(_))));
    }

    #[test]
    fn a_broken_file_reads_as_no_marks() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("marks.json");
        std::fs::write(&file, "not json").unwrap();
        assert!(read(&file).is_empty());
    }
}
