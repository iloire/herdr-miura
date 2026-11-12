//! The outcome ledger: every `herdr-outcome` an agent reported, one JSON line
//! each, so what a session left outlives its pane (docs/plan-inbox.md).
//!
//! The external script appends entries; windows append what was done with
//! one (`{"resolves": id, "how": …}`). Append-only, a line a write, so the
//! script and several windows share the file without a lock. It sits outside
//! the app's data folder, so Stable, Edge and a dev build read the same one:
//! `$HERDR_OUTCOME_LEDGER`, else `$XDG_STATE_HOME/herdr/outcomes.jsonl`, else
//! `~/.local/state/herdr/outcomes.jsonl`.

use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Read no more than this of the file's end. At a few hundred bytes a line
/// that is thousands of outcomes, months of them.
const READ_CAP: u64 = 4 * 1024 * 1024;

const HOWS: &[&str] = &["queued", "dismissed", "todo", "cleared"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    /// UTC, `2026-11-12T10:00:00Z`.
    pub at: String,
    /// `verified`, `unverified`, `left`, `you` or `not-started`.
    pub kind: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub cwd: String,
    /// The main checkout of the repo it ran in.
    #[serde(default)]
    pub home: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub head: String,
    #[serde(default)]
    pub session: String,
    #[serde(default)]
    pub workspace: String,
    #[serde(default)]
    pub pane: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resolution {
    pub resolves: String,
    pub how: String,
    pub at: String,
}

/// What the file holds, in its order.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct Ledger {
    pub entries: Vec<Entry>,
    pub resolutions: Vec<Resolution>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no home folder for the outcome ledger")]
    NoHome,
    #[error("not a ledger id: {0:?}")]
    BadId(String),
    #[error("not a way to resolve an outcome: {0:?}")]
    BadHow(String),
    #[error("could not use the outcome ledger: {0}")]
    Io(#[from] std::io::Error),
}

pub fn path() -> Result<PathBuf, Error> {
    let var = |name: &str| std::env::var_os(name).map(PathBuf::from).filter(|p| p.is_absolute());
    if let Some(file) = var("HERDR_OUTCOME_LEDGER") {
        return Ok(file);
    }
    let state = match var("XDG_STATE_HOME") {
        Some(state) => state,
        None => var("HOME").ok_or(Error::NoHome)?.join(".local/state"),
    };
    Ok(state.join("herdr/outcomes.jsonl"))
}

/// The ledger's last `READ_CAP` bytes, empty when there is no file. A line
/// that does not parse, or is cut by the cap, is passed over.
pub fn read(path: &Path) -> Result<Ledger, Error> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Ledger::default()),
        Err(error) => return Err(error.into()),
    };
    let size = file.metadata()?.len();
    if size > READ_CAP {
        file.seek(SeekFrom::Start(size - READ_CAP))?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(parse(&String::from_utf8_lossy(&bytes)))
}

fn parse(text: &str) -> Ledger {
    let mut ledger = Ledger::default();
    for line in text.lines() {
        if let Ok(resolution) = serde_json::from_str::<Resolution>(line) {
            ledger.resolutions.push(resolution);
        } else if let Ok(entry) = serde_json::from_str::<Entry>(line) {
            ledger.entries.push(entry);
        }
    }
    ledger
}

/// Appends that the entry `id` was dealt with, `how`.
pub fn resolve(path: &Path, id: &str, how: &str) -> Result<(), Error> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(Error::BadId(id.to_owned()));
    }
    if !HOWS.contains(&how) {
        return Err(Error::BadHow(how.to_owned()));
    }
    let line = serde_json::to_string(&serde_json::json!({ "v": 1, "resolves": id, "how": how, "at": now_utc() }))
        .map_err(std::io::Error::other)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    // One write, so a line never interleaves with the script's.
    file.write_all(format!("{line}\n").as_bytes())?;
    Ok(())
}

/// `2026-11-12T10:00:00Z`, as the script writes `at`.
fn now_utc() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default();
    utc(secs)
}

fn utc(secs: u64) -> String {
    let (days, rest) = (secs / 86_400, secs % 86_400);
    // Howard Hinnant's civil_from_days.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEFT: &str = r#"{"v":1,"id":"1762941600000-42","at":"2026-11-12T10:00:00Z","kind":"left","note":"test on GTK","cwd":"/r/wt","home":"/r","branch":"x","head":"abc","session":"s1","workspace":"w1","pane":"w1:p1"}"#;

    #[test]
    fn it_reads_entries_and_resolutions_and_skips_the_rest() {
        let text = format!("{LEFT}\nnot json\n{{\"v\":1,\"resolves\":\"1762941600000-42\",\"how\":\"queued\",\"at\":\"2026-11-12T11:00:00Z\"}}\n{{\"half\":");
        let ledger = parse(&text);
        assert_eq!(ledger.entries.len(), 1);
        assert_eq!(ledger.entries[0].note, "test on GTK");
        assert_eq!(ledger.entries[0].home, "/r");
        assert_eq!(ledger.resolutions.len(), 1);
        assert_eq!(ledger.resolutions[0].how, "queued");
    }

    #[test]
    fn a_missing_file_is_an_empty_ledger() -> Result<(), Error> {
        let dir = tempfile::tempdir()?;
        assert_eq!(read(&dir.path().join("none.jsonl"))?, Ledger::default());
        Ok(())
    }

    #[test]
    fn resolve_appends_a_line_the_reader_takes_back() -> Result<(), Error> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("state/outcomes.jsonl");
        std::fs::create_dir_all(dir.path().join("state"))?;
        std::fs::write(&path, format!("{LEFT}\n"))?;
        resolve(&path, "1762941600000-42", "dismissed")?;
        let ledger = read(&path)?;
        assert_eq!(ledger.entries.len(), 1);
        assert_eq!(ledger.resolutions[0].resolves, "1762941600000-42");
        assert_eq!(ledger.resolutions[0].how, "dismissed");
        Ok(())
    }

    #[test]
    fn resolve_refuses_an_odd_id_or_how() {
        let path = Path::new("/nonexistent/outcomes.jsonl");
        assert!(matches!(resolve(path, "a\nb", "queued"), Err(Error::BadId(_))));
        assert!(matches!(resolve(path, "", "queued"), Err(Error::BadId(_))));
        assert!(matches!(resolve(path, "1-2", "deleted"), Err(Error::BadHow(_))));
    }

    #[test]
    fn utc_formats_as_the_script_does() {
        assert_eq!(utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc(1_762_941_600), "2025-11-12T10:00:00Z");
        assert_eq!(utc(951_782_400), "2000-02-29T00:00:00Z");
    }
}
