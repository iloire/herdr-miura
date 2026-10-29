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
const MAX_SOURCE: usize = 200;
const MAX_FOLDER: usize = 4096;

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
    #[error("could not read or move a file in the queue inbox")]
    Inbox(#[source] std::io::Error),
    #[error("not a queue inbox file: {0}")]
    InboxName(String),
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

/// One prompt as a writer leaves it in the inbox.
#[derive(Deserialize)]
struct Sent {
    version: u32,
    workspace_id: Option<String>,
    folder: Option<String>,
    prompt: String,
    #[serde(default)]
    front: bool,
    source: Option<String>,
}

/// An inbox file that passed the checks, for the window to add to a queue.
#[derive(Debug, Serialize, PartialEq)]
pub struct Entry {
    /// The file's name, by which the window settles it.
    pub name: String,
    pub workspace_id: Option<String>,
    pub folder: Option<String>,
    pub prompt: String,
    pub front: bool,
    pub source: Option<String>,
    /// How long ago it was written, so one for a workspace that never opens
    /// can be given up on.
    pub age_ms: u64,
}

/// The inbox file `text` as an entry, or why it cannot be one.
fn sent(text: &str) -> Result<Sent, String> {
    let sent: Sent = serde_json::from_str(text).map_err(|error| format!("not a queue inbox file: {error}"))?;
    if sent.version != 1 {
        return Err(format!("version {} is not 1", sent.version));
    }
    if plain(&sent.prompt, MAX_PROMPT, true).is_err() {
        return Err("the prompt is empty, over 100,000 bytes, or holds control characters".into());
    }
    match (&sent.workspace_id, &sent.folder) {
        (None, None) => return Err("it names neither a workspace_id nor a folder".into()),
        (Some(id), _) if checked(id).is_err() => return Err(format!("{id:?} is not a workspace id")),
        (_, Some(folder)) if plain(folder, MAX_FOLDER, false).is_err() || !Path::new(folder).is_absolute() => {
            return Err(format!("the folder {folder:?} is not an absolute path"));
        }
        _ => {}
    }
    if sent.source.as_deref().is_some_and(|source| plain(source, MAX_SOURCE, false).is_err()) {
        return Err("the source is empty, over 200 bytes, or holds control characters".into());
    }
    Ok(sent)
}

/// A name `settle` may act on: a `.json` file directly in the inbox.
fn entry_name(name: &str) -> Result<&str, StoreError> {
    let stem = name.strip_suffix(".json").unwrap_or_default();
    let fine = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.');
    if stem.is_empty() || stem.starts_with('.') || !stem.bytes().all(fine) {
        return Err(StoreError::InboxName(name.into()));
    }
    Ok(name)
}

/// The inbox's prompts, oldest name first, so they keep the order they were
/// sent in. Writers rename a finished `.tmp` file to `.json`, so a half-written
/// one is never read. A file that fails the checks is moved to `rejected/`
/// with its reason beside it, never deleted.
pub fn inbox(dir: &Path) -> Result<Vec<Entry>, StoreError> {
    let listing = match std::fs::read_dir(dir) {
        Ok(listing) => listing,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(StoreError::Inbox(error)),
    };
    let mut names: Vec<String> = listing
        .filter_map(Result::ok)
        .filter(|file| file.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|file| file.file_name().into_string().ok())
        .filter(|name| entry_name(name).is_ok())
        .collect();
    names.sort();
    let mut entries = Vec::new();
    for name in names {
        let path = dir.join(&name);
        // Gone or unreadable for now: the next listing tries again.
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        match sent(&text) {
            Ok(sent) => {
                let modified = std::fs::metadata(&path).and_then(|meta| meta.modified()).ok();
                let age = modified.and_then(|time| time.elapsed().ok()).unwrap_or_default();
                entries.push(Entry {
                    name,
                    workspace_id: sent.workspace_id,
                    folder: sent.folder,
                    prompt: sent.prompt,
                    front: sent.front,
                    source: sent.source,
                    age_ms: u64::try_from(age.as_millis()).unwrap_or(u64::MAX),
                });
            }
            Err(reason) => reject(dir, &name, &reason)?,
        }
    }
    Ok(entries)
}

/// Ends an inbox file's stay: deleted once its prompt is in the saved queue
/// (`reason` none), or moved to `rejected/` with `reason` beside it.
pub fn settle(dir: &Path, name: &str, reason: Option<&str>) -> Result<(), StoreError> {
    let name = entry_name(name)?;
    match reason {
        None => std::fs::remove_file(dir.join(name)).map_err(StoreError::Inbox),
        Some(reason) => reject(dir, name, reason),
    }
}

fn reject(dir: &Path, name: &str, reason: &str) -> Result<(), StoreError> {
    let rejected = dir.join("rejected");
    std::fs::create_dir_all(&rejected).map_err(StoreError::Inbox)?;
    std::fs::rename(dir.join(name), rejected.join(name)).map_err(StoreError::Inbox)?;
    let stem = name.strip_suffix(".json").unwrap_or(name);
    std::fs::write(rejected.join(format!("{stem}.reason.txt")), format!("{reason}\n")).map_err(StoreError::Inbox)
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

    #[test]
    fn the_inbox_lists_good_files_in_name_order_and_skips_temporary_ones() {
        let dir = temp("inbox");
        std::fs::write(dir.join("2-b.json"), r#"{"version":1,"workspace_id":"w4H","folder":null,"prompt":"second","front":true,"source":"tab 3"}"#).unwrap();
        std::fs::write(dir.join("1-a.json"), r#"{"version":1,"folder":"/code/app","prompt":"first\n\tthen this"}"#).unwrap();
        std::fs::write(dir.join("3-c.json.tmp"), "{ half").unwrap();
        let entries = inbox(&dir).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["1-a.json", "2-b.json"]);
        assert_eq!((entries[0].folder.as_deref(), entries[0].front, entries[0].source.as_deref()), (Some("/code/app"), false, None));
        assert_eq!((entries[1].workspace_id.as_deref(), entries[1].front, entries[1].source.as_deref()), (Some("w4H"), true, Some("tab 3")));
        assert!(dir.join("3-c.json.tmp").exists());
        settle(&dir, "1-a.json", None).unwrap();
        assert!(!dir.join("1-a.json").exists() && dir.join("2-b.json").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_bad_inbox_file_is_rejected_with_its_reason_and_kept() {
        let bad = [
            ("not-json", "{ half"),
            ("version", r#"{"version":2,"folder":"/x","prompt":"p"}"#),
            ("empty", r#"{"version":1,"folder":"/x","prompt":"  \n"}"#),
            ("escape", r#"{"version":1,"folder":"/x","prompt":"a\u001b[2Jb"}"#),
            ("nowhere", r#"{"version":1,"prompt":"p"}"#),
            ("relative", r#"{"version":1,"folder":"code/app","prompt":"p"}"#),
            ("option", r#"{"version":1,"workspace_id":"--all","prompt":"p"}"#),
        ];
        let dir = temp("reject");
        for (name, text) in bad {
            std::fs::write(dir.join(format!("{name}.json")), text).unwrap();
        }
        std::fs::write(dir.join("long.json"), serde_json::json!({"version":1,"folder":"/x","prompt":"x".repeat(MAX_PROMPT + 1)}).to_string()).unwrap();
        assert_eq!(inbox(&dir).unwrap(), []);
        for name in bad.iter().map(|(name, _)| *name).chain(["long"]) {
            assert!(!dir.join(format!("{name}.json")).exists(), "{name}");
            assert!(dir.join("rejected").join(format!("{name}.json")).exists(), "{name}");
            let reason = std::fs::read_to_string(dir.join("rejected").join(format!("{name}.reason.txt"))).unwrap();
            assert!(!reason.trim().is_empty(), "{name}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn settle_rejects_with_a_reason_and_acts_only_on_inbox_names() {
        let dir = temp("settle");
        std::fs::write(dir.join("1-a.json"), "{}").unwrap();
        settle(&dir, "1-a.json", Some("workspace w4H never opened")).unwrap();
        assert!(dir.join("rejected/1-a.json").exists());
        assert_eq!(std::fs::read_to_string(dir.join("rejected/1-a.reason.txt")).unwrap(), "workspace w4H never opened\n");
        for bad in ["../queue-tauri.json", "rejected/1-a.json", ".json", "a.json.tmp", "a b.json", ".hidden.json"] {
            assert!(matches!(settle(&dir, bad, None), Err(StoreError::InboxName(_))), "{bad:?}");
        }
        assert!(inbox(&dir.join("missing")).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
