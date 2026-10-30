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
    fs::{File, TryLockError},
    path::Path,
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
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
/// How long Git may take to say where one folder's main checkout is.
const HOME_DEADLINE: Duration = Duration::from_secs(5);
/// In bytes: `tabLabel`'s 200 UTF-16 units take up to 600, plus its `⧗ n · `.
const MAX_TAB_LABEL: usize = 640;
/// A copy of the queue file is kept at most this often, and this many are kept.
const BACKUP_EVERY: Duration = Duration::from_secs(60 * 60);
const BACKUPS_KEPT: usize = 48;
/// How long a taken inbox file is kept in `taken/`.
const TAKEN_KEPT: Duration = Duration::from_secs(30 * 24 * 60 * 60);

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
    #[error("Your queue is open in another Herdr Tauri window, the one you use every day. This one cannot show, add to or run it, and takes it over once that window closes.")]
    Owned,
}

/// Which window keeps the queue. Every window that runs this app (the one in
/// daily use and each worktree's dev build) shares the one data folder, and
/// each holds the queue in memory and saves it whole, so two at once lose
/// each other's prompts. The first to load it takes an exclusive lock on
/// `queue.lock` for as long as it runs; any other may not load, save or
/// drain the inbox. The OS drops the lock with the process, even a crashed one.
#[derive(Default)]
pub struct Owner(Mutex<Option<File>>);

impl Owner {
    /// Takes the lock beside the queue file at `path`, unless held already.
    pub fn claim(&self, path: &Path) -> Result<(), StoreError> {
        let mut held = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if held.is_some() {
            return Ok(());
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(StoreError::Write)?;
        }
        let file = File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path.with_file_name("queue.lock"))
            .map_err(StoreError::Write)?;
        match file.try_lock() {
            Ok(()) => {
                *held = Some(file);
                Ok(())
            }
            Err(TryLockError::WouldBlock) => Err(StoreError::Owned),
            Err(TryLockError::Error(error)) => Err(StoreError::Write(error)),
        }
    }

    /// Refuses unless this window holds the lock.
    pub fn check(&self) -> Result<(), StoreError> {
        let held = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        held.as_ref().map(|_| ()).ok_or(StoreError::Owned)
    }
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
    // A backup that fails must not stop the save it guards.
    let _ = backup(path, SystemTime::now());
    std::fs::rename(&temporary, path).map_err(StoreError::Write)
}

/// Copies the queue file as it is, before a save replaces it, into
/// `queue-backups/queue-tauri-<unix ms>.json`, unless the newest copy is
/// under `BACKUP_EVERY` old; keeps the newest `BACKUPS_KEPT`.
fn backup(path: &Path, now: SystemTime) -> std::io::Result<()> {
    let dir = path.with_file_name("queue-backups");
    std::fs::create_dir_all(&dir)?;
    let stamp = |name: &str| name.strip_prefix("queue-tauri-")?.strip_suffix(".json")?.parse::<u128>().ok();
    let mut copies: Vec<(u128, String)> = std::fs::read_dir(&dir)?
        .filter_map(Result::ok)
        .filter_map(|file| file.file_name().into_string().ok())
        .filter_map(|name| Some((stamp(&name)?, name)))
        .collect();
    copies.sort();
    let now = now.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis();
    if copies.last().is_some_and(|(newest, _)| now.saturating_sub(*newest) < BACKUP_EVERY.as_millis()) {
        return Ok(());
    }
    let name = format!("queue-tauri-{now}.json");
    match std::fs::copy(path, dir.join(&name)) {
        Ok(_) => copies.push((now, name)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    for (_, old) in &copies[..copies.len().saturating_sub(BACKUPS_KEPT)] {
        std::fs::remove_file(dir.join(old))?;
    }
    Ok(())
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

/// Ends an inbox file's stay: once its prompt is in the saved queue (`reason`
/// none) it moves to `taken/`, kept for `TAKEN_KEPT` so the prompt's text
/// outlives the queue file, or with `reason` it moves to `rejected/`.
pub fn settle(dir: &Path, name: &str, reason: Option<&str>) -> Result<(), StoreError> {
    let name = entry_name(name)?;
    match reason {
        None => take(dir, name, SystemTime::now()),
        Some(reason) => reject(dir, name, reason),
    }
}

fn take(dir: &Path, name: &str, now: SystemTime) -> Result<(), StoreError> {
    let taken = dir.join("taken");
    std::fs::create_dir_all(&taken).map_err(StoreError::Inbox)?;
    std::fs::rename(dir.join(name), taken.join(name)).map_err(StoreError::Inbox)?;
    // A rename keeps the time the file was sent, which is what ages it out.
    for file in std::fs::read_dir(&taken).map_err(StoreError::Inbox)?.filter_map(Result::ok) {
        let sent = file.metadata().and_then(|meta| meta.modified());
        if sent.is_ok_and(|sent| now.duration_since(sent).is_ok_and(|age| age > TAKEN_KEPT)) {
            std::fs::remove_file(file.path()).map_err(StoreError::Inbox)?;
        }
    }
    Ok(())
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

/// The folder a queue for `directory` is kept on: the main checkout of a linked
/// worktree, at the same place inside it, else `directory` itself. A worktree
/// can be removed at any moment, taking its queue with it. `None` when
/// `directory` is gone, since Git can then no longer say whose it was.
pub fn home(directory: &str) -> Option<String> {
    if !Path::new(directory).is_dir() {
        return None;
    }
    let deadline = Instant::now() + HOME_DEADLINE;
    let asked = crate::git::text(directory, HOME_ARGS, "find the main checkout", deadline);
    Some(asked.ok().and_then(|text| main_checkout(&text)).unwrap_or_else(|| directory.to_owned()))
}

const HOME_ARGS: &[&str] = &["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--show-prefix"];

/// The folder `HOME_ARGS` points at, when they describe a linked worktree of a
/// checkout with a working tree. A bare repository has none to go to.
fn main_checkout(text: &str) -> Option<String> {
    let mut lines = text.lines();
    let (common, git_dir) = (lines.next()?, lines.next()?);
    if common == git_dir {
        return None;
    }
    let root = common.strip_suffix("/.git")?;
    let inside = lines.next().unwrap_or_default().trim_end_matches('/');
    Some(if inside.is_empty() { root.to_owned() } else { format!("{root}/{inside}") })
}

/// An agent's name: `q` and a queued item's number, or `p` and a number for
/// one the prompt library started, never read as an option.
fn agent_name(name: &str) -> Result<&str, Error> {
    let digits = name.strip_prefix(['q', 'p']).unwrap_or_default();
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
    check_start(directory, label, name, kind, args)?;
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
    start_agent(&cli, &pane, directory, name, kind, args)
}

/// Makes the worktree `path` of `directory` on a new branch `feat/` plus its
/// folder's name, as `worktreeBranch` shows it, in a workspace of its own labelled `label`, and starts the agent in its first
/// tab. Its Git state stays with the worktree: removing that closes the
/// workspace and keeps the branch. Blocking: run off the main thread.
pub fn worktree(
    directory: &str,
    path: &str,
    label: &str,
    name: &str,
    kind: &str,
    args: &[String],
) -> Result<Opened, Error> {
    check_start(directory, label, name, kind, args)?;
    let folder = Path::new(path).file_name().and_then(|name| name.to_str()).unwrap_or_default();
    let branch = format!("feat/{folder}");
    if !worktree_inside(directory, path) || !branch_name(&branch) {
        return Err(Error::InvalidId(path.into()));
    }
    exclude_worktrees(directory);
    let cli = herdr()?;
    let created = run(
        &cli,
        &[
            "worktree", "create", "--cwd", directory, "--branch", &branch, "--path", path, "--label", label, "--no-focus",
        ],
    )?;
    let pane = serde_json::from_value::<Created>(created)
        .map_err(Error::Decode)?
        .root_pane;
    // The worktree exists now, so a slow shell is no reason to report that
    // nothing happened: a second try would find its branch taken. The item
    // fails as an agent that never started, with this note as the reason.
    start_agent(&cli, &pane, path, name, kind, args).or_else(|error| {
        Ok(Opened {
            tab_id: pane.tab_id,
            pane_id: pane.pane_id,
            ready: false,
            note: Some(error.to_string()),
            head: head(path),
        })
    })
}

/// A worktree may only go in `.claude/worktrees/` of the checkout it is for.
fn worktree_inside(directory: &str, path: &str) -> bool {
    Path::new(path).parent() == Some(&Path::new(directory).join(".claude/worktrees"))
        && !path.ends_with("/..")
        && !path.ends_with("/.")
}

fn branch_name(branch: &str) -> bool {
    branch.strip_prefix("feat/").is_some_and(|rest| {
        !rest.is_empty() && !rest.starts_with('-') && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

/// A worktree in the checkout must not read as a change in it, or "wait for a
/// clean tree" would pause the queue, so `.git/info/exclude` gains a line if it
/// lacks one. Failing costs only that pause, whose reason says what to do.
fn exclude_worktrees(directory: &str) {
    const LINE: &str = "**/.claude/worktrees/";
    let deadline = Instant::now() + Duration::from_secs(5);
    let args = ["rev-parse", "--git-path", "info/exclude"];
    let Ok(out) = crate::git::run(directory, &args, "find the exclude file", deadline, 4096) else {
        return;
    };
    let file = Path::new(directory).join(String::from_utf8_lossy(&out).trim());
    let text = std::fs::read_to_string(&file).unwrap_or_default();
    if text.lines().any(|line| line.trim() == LINE) {
        return;
    }
    let gap = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&file, format!("{text}{gap}{LINE}\n"));
}

fn check_start(directory: &str, label: &str, name: &str, kind: &str, args: &[String]) -> Result<(), Error> {
    agent_name(name)?;
    plain(label, MAX_TAB_LABEL, false)?;
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
        return Err(Error::NoFolder(directory.into()));
    }
    Ok(())
}

/// Starts the agent `kind` under `name` in `pane`, which sits in `directory`.
fn start_agent(
    cli: &Path,
    pane: &CreatedPane,
    directory: &str,
    name: &str,
    kind: &str,
    args: &[String],
) -> Result<Opened, Error> {
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
    // A shell that never came up is not an agent asking a question; waiting
    // on it would wait forever, so the item fails with Herdr's reason.
    let started = match while_busy(Instant::now() + SHELL_START, || run(cli, &start), std::thread::sleep) {
        Err(error) if busy(&error) => return Err(error),
        other => other,
    };
    Ok(Opened {
        tab_id: pane.tab_id.clone(),
        pane_id: pane.pane_id.clone(),
        ready: started.is_ok(),
        note: started.err().map(|error| error.to_string()),
        head: head(directory),
    })
}

/// How long a new tab's shell gets to start before its agent can, as
/// herdr-gpui allows: a prompt that prints a banner first takes a moment.
const SHELL_START: Duration = Duration::from_secs(10);
const SHELL_POLL: Duration = Duration::from_millis(200);

/// Herdr's answer to `agent start` on a pane whose shell is still starting.
fn busy(error: &Error) -> bool {
    matches!(error, Error::Refused { code: Some(code), .. } if code == "agent_pane_busy")
}

/// Runs `attempt` again while Herdr says the pane's shell is busy, until
/// `deadline`; any other answer is returned as it is.
fn while_busy<T>(
    deadline: Instant,
    mut attempt: impl FnMut() -> Result<T, Error>,
    mut pause: impl FnMut(Duration),
) -> Result<T, Error> {
    loop {
        match attempt() {
            Err(error) if busy(&error) && Instant::now() + SHELL_POLL < deadline => pause(SHELL_POLL),
            other => return other,
        }
    }
}

/// Submits `text` to the agent `name` as one prompt and returns once it has
/// started working on it, or is waiting on you. Blocking.
pub fn prompt(name: &str, text: &str) -> Result<(), Error> {
    submit(agent_name(name)?, text)
}

/// Submits `text` to the agent in the pane `pane`, whatever it is named, as
/// `prompt` does. Blocking.
pub fn send(pane: &str, text: &str) -> Result<(), Error> {
    submit(checked(pane)?, text)
}

fn submit(target: &str, text: &str) -> Result<(), Error> {
    plain(text, MAX_PROMPT, true)?;
    let cli = herdr()?;
    // Herdr's CLI takes `--` only with nothing after the text, and the wait
    // options must follow it, so the text goes first, kept from reading as one.
    let text = positional(text);
    run(
        &cli,
        &[
            "agent", "prompt", target, &text, "--wait", "--until", "working", "--until", "blocked", "--timeout",
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

    fn git(dir: &Path, args: &[&str]) {
        let done = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(done.status.success(), "{args:?}: {}", String::from_utf8_lossy(&done.stderr));
    }

    #[test]
    fn a_queue_goes_home_to_the_main_checkout_of_a_worktree() {
        let dir = temp("home");
        let dir = dir.canonicalize().unwrap();
        let repo = dir.join("repo");
        let tree = dir.join("elsewhere/feature");
        std::fs::create_dir_all(repo.join("code")).unwrap();
        std::fs::write(repo.join("code/a"), "a").unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-qm", "a"]);
        git(&repo, &["worktree", "add", "-q", tree.to_str().unwrap()]);
        let path = |p: &Path| p.to_str().unwrap().to_owned();
        let home = |p: &Path| super::home(&path(p));

        assert_eq!(home(&repo), Some(path(&repo)));
        assert_eq!(home(&repo.join("code")), Some(path(&repo.join("code"))));
        assert_eq!(home(&tree), Some(path(&repo)));
        assert_eq!(home(&tree.join("code")), Some(path(&repo.join("code"))));
        assert_eq!(home(&dir), Some(path(&dir)), "outside Git");

        git(&repo, &["worktree", "remove", tree.to_str().unwrap()]);
        assert_eq!(home(&tree), None);
    }

    #[test]
    fn a_worktree_of_a_bare_repository_stays_where_it_is() {
        assert_eq!(main_checkout("/r/repo.git\n/r/repo.git/worktrees/a\n"), None);
        assert_eq!(main_checkout("/r/.git\n/r/.git\n"), None);
    }

    #[test]
    fn a_worktree_goes_only_in_its_checkouts_own_folder() {
        assert!(worktree_inside("/r/app", "/r/app/.claude/worktrees/fix-q1"));
        assert!(!worktree_inside("/r/app", "/r/app/.claude/worktrees/.."));
        assert!(!worktree_inside("/r/app", "/r/app/.claude/worktrees/a/b"));
        assert!(!worktree_inside("/r/app", "/r/other/.claude/worktrees/a"));
        assert!(branch_name("feat/fix-the-login-q12"));
        assert!(!branch_name("feat/"));
        assert!(!branch_name("feat/-x"));
        assert!(!branch_name("feat/a b"));
        assert!(!branch_name("main"));
    }

    #[test]
    fn a_worktree_never_makes_its_checkout_look_changed() {
        let dir = temp("exclude").canonicalize().unwrap();
        git(&dir, &["init", "-q"]);
        std::fs::create_dir_all(dir.join(".claude/worktrees/a")).unwrap();
        std::fs::write(dir.join(".claude/worktrees/a/f"), "f").unwrap();
        let status = || {
            let out = std::process::Command::new("git").args(["status", "--short"]).current_dir(&dir).output().unwrap();
            String::from_utf8(out.stdout).unwrap()
        };
        assert!(!status().is_empty());
        let file = dir.join(".git/info/exclude");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "*.log").unwrap();
        exclude_worktrees(dir.to_str().unwrap());
        exclude_worktrees(dir.to_str().unwrap());
        assert_eq!(status(), "");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "*.log\n**/.claude/worktrees/\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_folder_that_is_gone_says_so() {
        let args: [String; 0] = [];
        let gone = "/nonexistent/worktrees/agent-age";
        let error = open("w1", gone, "label", "q1", "claude", &args).unwrap_err();
        assert_eq!(error.to_string(), format!("the folder `{gone}` no longer exists"));
    }

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
    fn agent_names_are_q_or_p_and_a_number() {
        assert!(agent_name("q12").is_ok());
        assert!(agent_name("p123456789").is_ok());
        for bad in ["", "q", "p", "12", "q1a", "-q1", "q1234567890", "qq1", "pq1", "x1"] {
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
    fn a_tab_label_fits_the_longest_title_in_any_script() {
        let label = format!("⧗ 999999999 · {}…", "語".repeat(199));
        assert!(plain(&label, MAX_TAB_LABEL, false).is_ok());
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
    fn agent_start_waits_out_a_busy_shell_but_nothing_else() {
        let refused = |code: &str| Error::Refused { code: Some(code.into()), message: code.into() };
        let later = Instant::now() + Duration::from_secs(60);
        let mut tries = 0;
        let started = while_busy(
            later,
            || {
                tries += 1;
                if tries < 3 { Err(refused("agent_pane_busy")) } else { Ok(tries) }
            },
            |_| {},
        );
        assert_eq!(started.unwrap(), 3);

        let mut tries = 0;
        let other = while_busy(later, || -> Result<(), _> { tries += 1; Err(refused("timeout")) }, |_| {});
        assert!(matches!(other, Err(Error::Refused { .. })) && tries == 1);

        let mut tries = 0;
        let late = while_busy(Instant::now(), || -> Result<(), _> { tries += 1; Err(refused("agent_pane_busy")) }, |_| {});
        assert!(late.as_ref().is_err_and(busy) && tries == 1);
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

    #[test]
    fn a_taken_inbox_file_is_kept_until_it_ages_out() {
        let dir = temp("take");
        std::fs::write(dir.join("1-a.json"), "{}").unwrap();
        settle(&dir, "1-a.json", None).unwrap();
        assert!(!dir.join("1-a.json").exists());
        assert!(dir.join("taken/1-a.json").exists());
        std::fs::write(dir.join("2-b.json"), "{}").unwrap();
        take(&dir, "2-b.json", SystemTime::now() + TAKEN_KEPT + Duration::from_secs(60)).unwrap();
        assert!(std::fs::read_dir(dir.join("taken")).unwrap().next().is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_one_owner_holds_the_queue_and_the_lock_goes_with_it() {
        let dir = temp("owner");
        let path = dir.join("queue-tauri.json");
        let (first, second) = (Owner::default(), Owner::default());
        assert!(matches!(second.check(), Err(StoreError::Owned)));
        first.claim(&path).unwrap();
        first.claim(&path).unwrap();
        first.check().unwrap();
        assert!(matches!(second.claim(&path), Err(StoreError::Owned)));
        assert!(matches!(second.check(), Err(StoreError::Owned)));
        drop(first);
        // A child that another test forks shares the lock until it execs, as
        // one the app forks would; the window retries its load for the same reason.
        let deadline = Instant::now() + Duration::from_secs(2);
        while matches!(second.claim(&path), Err(StoreError::Owned)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        second.check().unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_save_keeps_an_hourly_copy_of_the_file_it_replaces() {
        let dir = temp("backup");
        let path = dir.join("queue-tauri.json");
        let copies = || {
            let mut names: Vec<String> = std::fs::read_dir(dir.join("queue-backups"))
                .unwrap()
                .map(|file| file.unwrap().file_name().into_string().unwrap())
                .collect();
            names.sort();
            names
        };
        let start = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        backup(&path, start).unwrap();
        assert!(copies().is_empty(), "nothing to copy before the first save");
        std::fs::write(&path, "v1").unwrap();
        backup(&path, start).unwrap();
        std::fs::write(&path, "v2").unwrap();
        backup(&path, start + Duration::from_secs(60)).unwrap();
        assert_eq!(copies().len(), 1, "a minute later is too soon for another copy");
        assert_eq!(std::fs::read_to_string(dir.join("queue-backups").join(&copies()[0])).unwrap(), "v1");
        for hour in 1..=BACKUPS_KEPT as u64 + 2 {
            backup(&path, start + BACKUP_EVERY * hour as u32).unwrap();
        }
        let kept = copies();
        assert_eq!(kept.len(), BACKUPS_KEPT);
        assert!(!kept.contains(&format!("queue-tauri-{}.json", 1_800_000_000_000u128)), "the oldest went first");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
