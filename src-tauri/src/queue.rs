//! The prompt queue's Rust half: the file it is kept in, and starting one
//! queued prompt in a fresh agent. The webview decides what runs when
//! (`src/app/queue.ts`); this side only stores and starts.
//!
//! Starting runs the `herdr` CLI, as `team` does, since `tab.create` over the
//! socket answers only later and cannot start a program: `tab create` hands
//! back the new tab's pane, `agent start` starts the agent there and waits
//! until it takes input, and `agent prompt` submits the prompt as one paste.

use crate::tab_move::{Error, checked, herdr, run};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::Path,
    time::{Duration, Instant},
};

/// The agent kinds `herdr agent start --kind` accepts in Herdr 0.9.5.
const KINDS: &[&str] = &[
    "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp", "mastracode", "opencode",
    "copilot", "kimi", "kiro", "droid", "amp", "grok", "hermes", "kilo", "qodercli", "qwen", "letta", "maki",
    "muse",
];
/// Well under the argument limit the prompt travels within.
const MAX_PROMPT: usize = 100_000;
const MAX_ARGS: usize = 16;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("could not find the app's data folder")]
    NoDataDir,
    #[error("could not read the queue file")]
    Read(#[source] std::io::Error),
    #[error("could not write the queue file")]
    Write(#[source] std::io::Error),
    #[error("the queue is not in a form this app writes")]
    Shape,
}

/// The queue file, or an empty queue when there is none. A file that does
/// not parse is kept beside it as `.bak` rather than lost to the next save.
pub fn load(path: &Path) -> Result<Value, StoreError> {
    let empty = serde_json::json!({ "version": 1, "seq": 0, "queues": {} });
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(empty),
        Err(error) => return Err(StoreError::Read(error)),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(data) if valid(&data) => Ok(data),
        _ => {
            std::fs::rename(path, path.with_extension("json.bak")).map_err(StoreError::Write)?;
            Ok(empty)
        }
    }
}

/// Writes the whole queue: to a temporary file first, then renamed over the
/// old one, so a crash mid-write never leaves half a queue.
pub fn save(path: &Path, data: &Value) -> Result<(), StoreError> {
    if !valid(data) {
        return Err(StoreError::Shape);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(StoreError::Write)?;
    }
    let temporary = path.with_extension("json.tmp");
    let text = serde_json::to_vec_pretty(data).map_err(|error| StoreError::Write(error.into()))?;
    std::fs::write(&temporary, text).map_err(StoreError::Write)?;
    std::fs::rename(&temporary, path).map_err(StoreError::Write)
}

fn valid(data: &Value) -> bool {
    data["version"] == 1 && data["queues"].is_object()
}

/// What `open` made: the tab and its pane, whether the agent is ready for its
/// prompt, why not when it is not, and the checkout's commit before it ran.
#[derive(Debug, Serialize)]
pub struct Opened {
    pub tab_id: String,
    pub pane_id: String,
    pub ready: bool,
    pub note: Option<String>,
    pub head: Option<String>,
}

#[derive(Deserialize)]
struct Created {
    root_pane: CreatedPane,
}

#[derive(Deserialize)]
struct CreatedPane {
    pane_id: String,
    tab_id: String,
}

/// An agent's name: `q` and the item's number, never read as an option.
fn agent_name(name: &str) -> Result<&str, Error> {
    let digits = name.strip_prefix('q').unwrap_or_default();
    if (1..=9).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit()) {
        Ok(name)
    } else {
        Err(Error::InvalidId(name.into()))
    }
}

/// Text that reaches a terminal: no control characters, which could act on it.
fn plain(text: &str, max: usize, allow_lines: bool) -> Result<&str, Error> {
    let controls = text
        .chars()
        .any(|c| c.is_control() && !(allow_lines && matches!(c, '\n' | '\t' | '\r')));
    if text.trim().is_empty() || text.len() > max || controls {
        return Err(Error::InvalidId(text.chars().take(40).collect()));
    }
    Ok(text)
}

/// Opens a tab labelled `label` in `workspace` at `directory` and starts the
/// agent `kind` in it under `name`. An agent that is not ready in time, such
/// as one asking whether to trust the folder, still leaves its tab: `ready`
/// is false and `note` says why, and the prompt waits until it is idle.
/// Blocking: run off the main thread.
pub fn open(
    workspace: &str,
    directory: &str,
    label: &str,
    name: &str,
    kind: &str,
    args: &[String],
) -> Result<Opened, Error> {
    checked(workspace)?;
    agent_name(name)?;
    plain(label, 120, false)?;
    if !KINDS.contains(&kind) {
        return Err(Error::InvalidId(kind.into()));
    }
    if args.len() > MAX_ARGS {
        return Err(Error::InvalidId("too many agent arguments".into()));
    }
    for arg in args {
        plain(arg, 200, false)?;
    }
    if !Path::new(directory).is_absolute() || !Path::new(directory).is_dir() {
        return Err(Error::InvalidId(directory.into()));
    }
    let cli = herdr()?;
    let created = run(
        &cli,
        &[
            "tab", "create", "--workspace", workspace, "--cwd", directory, "--label", label, "--no-focus",
        ],
    )?;
    let pane = serde_json::from_value::<Created>(created)
        .map_err(Error::Decode)?
        .root_pane;
    let mut start = vec![
        "agent",
        "start",
        name,
        "--kind",
        kind,
        "--pane",
        checked(&pane.pane_id)?,
        "--timeout",
        "60000",
    ];
    if !args.is_empty() {
        start.push("--");
        start.extend(args.iter().map(String::as_str));
    }
    let started = run(&cli, &start);
    Ok(Opened {
        tab_id: pane.tab_id,
        pane_id: pane.pane_id,
        ready: started.is_ok(),
        note: started.err().map(|error| error.to_string()),
        head: head(directory),
    })
}

/// Submits `text` to the agent `name` as one prompt and returns once it has
/// started working on it, or is waiting on you. Blocking.
pub fn prompt(name: &str, text: &str) -> Result<(), Error> {
    agent_name(name)?;
    plain(text, MAX_PROMPT, true)?;
    let cli = herdr()?;
    // Herdr's CLI takes `--` only with nothing after the text, and the wait
    // options must follow it, so the text goes first, kept from reading as one.
    let text = positional(text);
    run(
        &cli,
        &[
            "agent", "prompt", name, &text, "--wait", "--until", "working", "--until", "blocked", "--timeout",
            "20000",
        ],
    )?;
    Ok(())
}

/// `text` as an argument the CLI cannot take for an option: one that starts
/// with `-` gains a leading space, which the agent ignores.
fn positional(text: &str) -> std::borrow::Cow<'_, str> {
    if text.starts_with('-') { format!(" {text}").into() } else { text.into() }
}

/// The checkout's current commit, if it is a Git checkout with one.
fn head(directory: &str) -> Option<String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let out = crate::git::run(directory, &["rev-parse", "HEAD"], "read HEAD", deadline, 256).ok()?;
    let sha = String::from_utf8(out).ok()?.trim().to_owned();
    commit_id(&sha).then_some(sha)
}

/// A full commit name, so Git cannot read it as an option or a range.
fn commit_id(sha: &str) -> bool {
    matches!(sha.len(), 40 | 64) && sha.bytes().all(|b| b.is_ascii_hexdigit())
}

/// How many commits `directory`'s HEAD has that `since` did not: what one
/// queued prompt committed. Blocking.
pub fn commits(directory: &str, since: &str) -> Result<u32, crate::git::Error> {
    let failed = |details: &str| crate::git::Error::Failed {
        operation: "count commits",
        details: details.into(),
    };
    if !commit_id(since) {
        return Err(failed("not a commit"));
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let range = format!("{since}..HEAD");
    let out = crate::git::run(directory, &["rev-list", "--count", &range], "count commits", deadline, 64)?;
    String::from_utf8_lossy(&out)
        .trim()
        .parse()
        .map_err(|_| failed("unreadable count"))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("herdr-queue-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_queue_survives_a_round_trip() {
        let dir = temp("trip");
        let path = dir.join("queue.json");
        assert_eq!(load(&path).unwrap()["queues"], serde_json::json!({}));
        let data = serde_json::json!({ "version": 1, "seq": 3, "queues": { "local:/x": { "items": [] } } });
        save(&path, &data).unwrap();
        assert_eq!(load(&path).unwrap(), data);
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_corrupt_file_is_kept_aside_not_overwritten() {
        let dir = temp("corrupt");
        let path = dir.join("queue.json");
        std::fs::write(&path, "{ half a queue").unwrap();
        assert_eq!(load(&path).unwrap()["version"], 1);
        assert_eq!(std::fs::read_to_string(path.with_extension("json.bak")).unwrap(), "{ half a queue");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_the_queue_shape_is_saved() {
        let dir = temp("shape");
        let path = dir.join("queue.json");
        for bad in [serde_json::json!({ "version": 2, "queues": {} }), serde_json::json!({ "version": 1 })] {
            assert!(matches!(save(&path, &bad), Err(StoreError::Shape)));
        }
        assert!(!path.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn agent_names_are_q_and_a_number() {
        assert!(agent_name("q12").is_ok());
        for bad in ["", "q", "12", "q1a", "-q1", "q1234567890", "qq1"] {
            assert!(agent_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn prompts_keep_their_lines_but_not_terminal_controls() {
        assert!(plain("fix it\n\tthen commit", MAX_PROMPT, true).is_ok());
        for bad in ["", "  \n", "\u{1b}[2J", "a\u{7}b"] {
            assert!(plain(bad, MAX_PROMPT, true).is_err(), "{bad:?}");
        }
        assert!(plain("two\nlines", 120, false).is_err());
        assert!(plain(&"x".repeat(121), 120, false).is_err());
    }

    #[test]
    fn a_prompt_is_never_read_as_an_option() {
        assert_eq!(positional("--wait now"), " --wait now");
        assert_eq!(positional("fix -x"), "fix -x");
    }

    #[test]
    fn open_refuses_what_it_would_pass_to_the_cli_unchecked() {
        let dir = std::env::temp_dir();
        let dir = dir.to_str().unwrap();
        assert!(open("w1", dir, "⧗ 1", "q1", "bash", &[]).is_err());
        assert!(open("w1", "relative", "⧗ 1", "q1", "claude", &[]).is_err());
        assert!(open("--w", dir, "⧗ 1", "q1", "claude", &[]).is_err());
        assert!(open("w1", dir, "⧗ 1", "q1", "claude", &["\u{1b}x".into()]).is_err());
    }

    #[test]
    fn a_tab_create_result_names_its_tab_and_pane() {
        let result = serde_json::json!({"root_pane": {"pane_id": "w1:p9", "tab_id": "w1:t9"}, "tab": {}});
        let created: Created = serde_json::from_value(result).unwrap();
        assert_eq!((created.root_pane.tab_id.as_str(), created.root_pane.pane_id.as_str()), ("w1:t9", "w1:p9"));
    }

    #[test]
    fn commits_take_only_full_commit_names() {
        assert!(commit_id(&"a".repeat(40)));
        for bad in ["HEAD", "abc123", "--all", &"g".repeat(40)] {
            assert!(!commit_id(bad), "{bad:?}");
        }
        assert!(commits("/tmp", "HEAD~3").is_err());
    }
}
