//! The Recent sessions list and Reopen Closed Session: which Claude Code
//! sessions of a folder can be brought back, and where. Nothing records a
//! close, so a session counts as closed when no tab holds it, which also covers
//! a crash or a quit.
//!
//! `~/.claude/projects` runs to gigabytes, so a transcript is never read whole:
//! Claude Code repeats its title and last prompt as it goes, and each of 1,090
//! transcripts had them within 36 KiB of its end. The answer is kept by file
//! size and modification time, in a cache of its own: `session_usage::Cache`
//! can be held for seconds by the usage dialog's history.
//!
//! The format is not a public API, so a line this does not know, or cannot
//! parse, is passed over.

use crate::session_usage::{contains, is_session_id, without_paste_tags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// How much of a transcript's end is read.
const TAIL: u64 = 64 * 1024;
/// How much of its start is read, to see how its first message opens.
const HEAD: u64 = 16 * 1024;
/// How far a session with no folder in its tail is looked for one. The first
/// line to name a folder is the first prompt, whose paste or image can be
/// large: the longest of 1,090 ended 1.7 MiB in.
const MAX_FOLDER_SEARCH: u64 = 2 * 1024 * 1024;
/// Characters of a last prompt kept: more than a row shows.
const MAX_PROMPT_CHARS: usize = 300;
/// Characters of a tab's label.
const MAX_LABEL_CHARS: usize = 60;
/// Rows sent to the webview, newest first.
const MAX_ROWS: usize = 200;
/// A session file is a few hundred bytes.
const MAX_LIVE_FILE: u64 = 64 * 1024;

/// How much of a transcript's end a preview reads. Tool results fill most of a
/// transcript, so it takes this much to find a few messages of conversation.
const PREVIEW_TAIL: u64 = 2 * 1024 * 1024;
/// Messages a preview shows, the latest ones.
const PREVIEW_MESSAGES: usize = 12;
/// Characters of one message in a preview.
const MAX_PREVIEW_CHARS: usize = 4000;
/// What Claude Code writes as a user's message and no person typed.
const NOT_TYPED: [&str; 5] = ["<command-", "<local-command-", "<task-notification", "<system-reminder", "<bash-"];

/// Linked worktrees made by Claude Code or the queue live here, so the main
/// checkout of one that is gone can still be told from its path.
const WORKTREES: &str = "/.claude/worktrees/";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no transcript for session `{0}`")]
    Unknown(String),
    #[error("that session is already running, in a tab or a terminal")]
    Running,
    #[error("the session's folder `{0}` no longer exists")]
    FolderGone(String),
}

/// A row of the list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecentSession {
    pub id: String,
    /// `/rename`'s name, else Claude Code's own title; a session can have neither.
    pub title: Option<String>,
    pub prompt: String,
    pub branch: Option<String>,
    /// Where it last worked.
    pub folder: String,
    /// Where a tab would open: `folder`, or the main checkout when `folder` was
    /// a worktree since removed. `None` when there is nowhere to open it.
    pub opens_in: Option<String>,
    /// When its transcript last changed, in Unix seconds.
    pub updated_at: i64,
    /// Its first message was one whole paste, as a queued prompt arrives.
    pub queue: bool,
    /// A Claude Code process has it open, in a tab or a plain terminal.
    pub running: bool,
}

/// A session's latest conversation, to decide whether to resume it.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct Preview {
    /// Oldest first.
    pub messages: Vec<Message>,
    pub model: Option<String>,
    /// How full its context was at its last response.
    pub context_tokens: Option<u64>,
}

/// Something a person typed or Claude answered. Thinking and tools are left out.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Message {
    pub from_user: bool,
    pub text: String,
}

/// Where to resume a session.
#[derive(Debug, PartialEq, Eq)]
pub struct Target {
    pub folder: String,
    pub label: String,
}

/// What a transcript says about itself. `None` in place of one means it should
/// not be listed.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Summary {
    title: Option<String>,
    prompt: String,
    folder: String,
    branch: Option<String>,
    queue: bool,
}

/// What has been seen in a transcript's lines, the latest of each.
#[derive(Debug, Default)]
struct Facts {
    custom_title: Option<String>,
    ai_title: Option<String>,
    prompt: Option<String>,
    cwd: Option<String>,
    branch: Option<String>,
    entrypoint: Option<String>,
    continued: bool,
}

impl Facts {
    fn read(&mut self, line: &[u8]) {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        let text = |key: &str| value.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned);
        let keep = |slot: &mut Option<String>, key: &str| {
            if let Some(found) = text(key) {
                *slot = Some(found);
            }
        };
        match value.get("type").and_then(Value::as_str) {
            Some("custom-title") => keep(&mut self.custom_title, "customTitle"),
            Some("ai-title") => keep(&mut self.ai_title, "aiTitle"),
            Some("last-prompt") => keep(&mut self.prompt, "lastPrompt"),
            Some("continued-in") => self.continued = true,
            _ => {}
        }
        keep(&mut self.cwd, "cwd");
        keep(&mut self.branch, "gitBranch");
        keep(&mut self.entrypoint, "entrypoint");
    }

    /// A tail made only of long lines names no folder, so it comes from the
    /// first line that does.
    fn search_start(&mut self, path: &Path) -> std::io::Result<()> {
        let mut reader = BufReader::new(File::open(path)?.take(MAX_FOLDER_SEARCH));
        let mut line = Vec::new();
        let mut first = Facts::default();
        while first.cwd.is_none() {
            line.clear();
            if reader.read_until(b'\n', &mut line)? == 0 || line.last() != Some(&b'\n') {
                return Ok(());
            }
            first.read(&line);
        }
        self.cwd = first.cwd;
        self.branch = self.branch.take().or(first.branch);
        self.entrypoint = self.entrypoint.take().or(first.entrypoint);
        Ok(())
    }

    /// The summary, unless the session had no real conversation or went on
    /// elsewhere. A session with only `/clear` in it writes `last-prompt` with
    /// no prompt, and a headless `claude -p` run has no person behind it.
    fn summary(self, queue: bool) -> Option<Summary> {
        if self.continued || self.entrypoint.as_deref().is_some_and(|entry| entry.starts_with("sdk")) {
            return None;
        }
        let prompt = one_line(&self.prompt?, MAX_PROMPT_CHARS);
        if prompt.is_empty() {
            return None;
        }
        Some(Summary {
            title: self.custom_title.or(self.ai_title).map(|title| one_line(&title, MAX_PROMPT_CHARS)),
            prompt,
            folder: self.cwd?,
            branch: self.branch,
            queue,
        })
    }
}

/// `text` as one line of plain words, cut to `max` characters. Titles and
/// prompts reach a tab's label, which refuses control characters.
fn one_line(text: &str, max: usize) -> String {
    let text = without_paste_tags(text);
    let words: Vec<&str> = text.split_whitespace().collect();
    let line: String = words.join(" ").chars().filter(|c| !c.is_control()).collect();
    cut(&line, max)
}

/// Whether a transcript's first user message opens with a paste, with nothing
/// typed before it. `herdr agent prompt` pastes, so every queued prompt arrives
/// this way; of the 1,080 first messages looked at, a few people's own did too.
/// The queue keeps only its last 20 prompts, so it could not say. Raw bytes, as
/// that line can run on far past `HEAD`.
fn queue_run(head: &[u8]) -> bool {
    head.split(|&byte| byte == b'\n')
        .find(|line| contains(line, br#""type":"user""#))
        .is_some_and(|line| {
            contains(line, br#""content":"\n\n<pasted_content"#) || contains(line, br#""text":"\n\n<pasted_content"#)
        })
}

/// The whole lines of the last `length` bytes of a file of `size` bytes.
fn read_tail(mut file: File, size: u64, length: u64) -> std::io::Result<Vec<u8>> {
    let start = size.saturating_sub(length);
    file.seek(SeekFrom::Start(start))?;
    let mut tail = Vec::new();
    file.take(length).read_to_end(&mut tail)?;
    if start > 0 {
        // The read began partway through this line.
        let first = tail.iter().position(|&byte| byte == b'\n').map_or(tail.len(), |at| at + 1);
        tail.drain(..first);
    }
    Ok(tail)
}

fn summarize(path: &Path, size: u64) -> std::io::Result<Option<Summary>> {
    let mut file = File::open(path)?;
    let mut head = Vec::new();
    (&mut file).take(HEAD).read_to_end(&mut head)?;
    let tail = read_tail(file, size, TAIL)?;
    let mut facts = Facts::default();
    tail.split(|&byte| byte == b'\n').for_each(|line| facts.read(line));
    if facts.prompt.is_some() && facts.cwd.is_none() {
        facts.search_start(path)?;
    }
    Ok(facts.summary(queue_run(&head)))
}

/// The text of a message's `content`, a string or a list of blocks.
fn message_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_owned();
    }
    let blocks = content.as_array().map(Vec::as_slice).unwrap_or_default();
    let text = blocks.iter().filter(|block| block.get("type").and_then(Value::as_str) == Some("text"));
    text.filter_map(|block| block.get("text")?.as_str()).collect::<Vec<_>>().join("\n\n")
}

fn cut(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((end, _)) => format!("{}…", text[..end].trim_end()),
        None => text.to_owned(),
    }
}

impl Preview {
    fn read(&mut self, line: &[u8]) {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        let flag = |key: &str| value.get(key).and_then(Value::as_bool).unwrap_or(false);
        let from_user = match value.get("type").and_then(Value::as_str) {
            Some("user") => true,
            Some("assistant") => false,
            _ => return,
        };
        if flag("isMeta") || flag("isSidechain") || flag("isCompactSummary") {
            return;
        }
        let Some(message) = value.get("message") else {
            return;
        };
        if !from_user {
            let model = message.get("model").and_then(Value::as_str).filter(|model| !model.starts_with('<'));
            self.model = model.map(str::to_owned).or(self.model.take());
            if let Some(usage) = message.get("usage") {
                let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
                let tokens = count("input_tokens") + count("cache_creation_input_tokens") + count("cache_read_input_tokens");
                self.context_tokens = Some(tokens);
            }
        }
        let text = without_paste_tags(&message_text(message.get("content").unwrap_or(&Value::Null)));
        let text = text.trim();
        if text.is_empty() || (from_user && NOT_TYPED.iter().any(|mark| text.starts_with(mark))) {
            return;
        }
        self.messages.push(Message { from_user, text: cut(text, MAX_PREVIEW_CHARS) });
    }
}

/// The newest transcript of `id`, as a copied project folder files one id twice.
fn newest_transcript(projects: &Path, id: &str) -> Option<PathBuf> {
    let name = format!("{id}.jsonl");
    std::fs::read_dir(projects)
        .ok()?
        .filter_map(|entry| Some(entry.ok()?.path().join(&name)))
        .filter_map(|path| Some((stamp(&path)?.1, path)))
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

/// The end of `id`'s conversation, read only as far as `PREVIEW_TAIL`: a session
/// whose last stretch is all tools has few messages to show, or none.
pub fn preview(projects: &Path, id: &str) -> Result<Preview, Error> {
    if !is_session_id(id) {
        return Err(Error::Unknown(id.to_owned()));
    }
    let path = newest_transcript(projects, id).ok_or_else(|| Error::Unknown(id.to_owned()))?;
    let (size, _) = stamp(&path).ok_or_else(|| Error::Unknown(id.to_owned()))?;
    let tail = File::open(&path).and_then(|file| read_tail(file, size, PREVIEW_TAIL));
    let tail = tail.map_err(|_| Error::Unknown(id.to_owned()))?;
    let mut preview = Preview::default();
    tail.split(|&byte| byte == b'\n').for_each(|line| preview.read(line));
    let extra = preview.messages.len().saturating_sub(PREVIEW_MESSAGES);
    preview.messages.drain(..extra);
    Ok(preview)
}

/// Where a tab for a session that last worked in `folder` can open. Resuming
/// works from any folder, as `claude --resume <id>` finds a transcript wherever
/// it is filed, and goes back into a worktree it entered if that is still there.
/// So a removed worktree's session can go on in its main checkout; only a folder
/// with nothing left to stand in is a dead end, since `tab create` needs a
/// folder that exists.
fn opens_in(folder: &str) -> Option<String> {
    if Path::new(folder).is_dir() {
        return Some(folder.to_owned());
    }
    let (main, _) = folder.split_once(WORKTREES)?;
    Path::new(main).is_dir().then(|| main.to_owned())
}

fn is_under(folder: &str, parent: &str) -> bool {
    let parent = parent.trim_end_matches('/');
    folder.strip_prefix(parent).is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

fn unix_seconds(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs() as i64)
}

/// One entry of `~/.claude/sessions/`, where each running Claude Code keeps
/// `<pid>.json`. It carries the session in use, following `--resume` and
/// `/clear`, and a process that crashed leaves its file behind.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Live {
    pid: u32,
    session_id: String,
    proc_start: Option<String>,
    pid_domain: Option<String>,
}

/// The session files in `dir`. The `.key` files beside them are never opened.
fn live_files(dir: &Path) -> Vec<Live> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
        .filter(|path| std::fs::metadata(path).is_ok_and(|meta| meta.len() <= MAX_LIVE_FILE))
        .filter_map(|path| serde_json::from_slice(&std::fs::read(path).ok()?).ok())
        .collect()
}

/// `ps`'s word on `pids`, in UTC as `procStart` is written, or `None` if it
/// could not be asked.
fn ask_ps(pids: &[u32]) -> Option<String> {
    let list = pids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let out = crate::process::command("ps")
        .args(["-o", "pid=,lstart=", "-p", &list])
        .env("TZ", "UTC")
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The sessions whose process still runs, from `ps`'s output. A file's pid must
/// be alive and, where `procStart` is `ps`'s own format, have started when the
/// file says: after a crash and a reboot, a stale file's low pid is soon some
/// other program's. Without `ps` every file counts, as two writers on one
/// session cost more than a row that cannot be resumed.
fn running_from(live: Vec<Live>, ps: Option<&str>) -> HashSet<String> {
    let Some(ps) = ps else {
        return live.into_iter().map(|file| file.session_id).collect();
    };
    let words = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let started: HashMap<&str, String> = ps
        .lines()
        .filter_map(|line| line.trim().split_once(char::is_whitespace))
        .map(|(pid, start)| (pid, words(start)))
        .collect();
    live.into_iter()
        .filter(|file| {
            let Some(start) = started.get(file.pid.to_string().as_str()) else {
                return false;
            };
            file.pid_domain.as_deref() != Some("darwin") || file.proc_start.as_ref().is_none_or(|own| words(own) == *start)
        })
        .map(|file| file.session_id)
        .collect()
}

fn running(dir: &Path) -> HashSet<String> {
    let live = live_files(dir);
    if live.is_empty() {
        return HashSet::new();
    }
    let pids: Vec<u32> = live.iter().map(|file| file.pid).collect();
    running_from(live, ask_ps(&pids).as_deref())
}

/// A transcript as last read, kept until its size or time changes.
#[derive(Debug)]
struct Seen {
    size: u64,
    modified: SystemTime,
    summary: Option<Summary>,
}

/// One session's newest transcript.
struct Found {
    id: String,
    updated_at: i64,
    summary: Summary,
}

/// What has been read, kept between reads.
#[derive(Default)]
pub struct Cache(Mutex<HashMap<PathBuf, Seen>>);

impl Cache {
    /// Every listable session under `projects`. A copied project folder files
    /// one id twice, so each counts once, by its newest transcript.
    fn scan(&self, projects: &Path) -> Vec<Found> {
        let Ok(mut seen) = self.0.lock() else {
            return Vec::new();
        };
        let children = |folder: &Path| {
            std::fs::read_dir(folder)
                .into_iter()
                .flatten()
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .collect::<Vec<_>>()
        };
        let mut newest = HashMap::<String, Found>::new();
        let mut current = HashSet::new();
        for path in children(projects).iter().flat_map(|project| children(project)) {
            let Some(id) = transcript_id(&path) else {
                continue;
            };
            let Some((size, modified)) = stamp(&path) else {
                continue;
            };
            current.insert(path.clone());
            let known = seen.get(&path).is_some_and(|entry| entry.size == size && entry.modified == modified);
            if !known {
                let Ok(summary) = summarize(&path, size) else {
                    continue;
                };
                seen.insert(path.clone(), Seen { size, modified, summary });
            }
            let Some(summary) = seen.get(&path).and_then(|entry| entry.summary.clone()) else {
                continue;
            };
            let updated_at = unix_seconds(modified);
            if newest.get(id).is_none_or(|found| found.updated_at < updated_at) {
                newest.insert(id.to_owned(), Found { id: id.to_owned(), updated_at, summary });
            }
        }
        seen.retain(|path, _| current.contains(path));
        newest.into_values().collect()
    }

    /// The sessions that worked in `folders` or under them, newest first.
    /// `sessions` is the folder of `<pid>.json` files.
    pub fn list(&self, projects: &Path, sessions: &Path, folders: &[String]) -> Vec<RecentSession> {
        let mut found = self.scan(projects);
        found.retain(|session| folders.iter().any(|folder| is_under(&session.summary.folder, folder)));
        found.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.id.cmp(&b.id)));
        found.truncate(MAX_ROWS);
        let live = running(sessions);
        found
            .into_iter()
            .map(|Found { id, updated_at, summary }| RecentSession {
                running: live.contains(&id),
                opens_in: opens_in(&summary.folder),
                id,
                title: summary.title,
                prompt: summary.prompt,
                branch: summary.branch,
                folder: summary.folder,
                updated_at,
                queue: summary.queue,
            })
            .collect()
    }

    /// Where to resume `id`, read again at the moment of asking: the webview's
    /// row can be seconds old, and two Claude Codes must not write one session.
    pub fn target(&self, projects: &Path, sessions: &Path, id: &str) -> Result<Target, Error> {
        if !is_session_id(id) {
            return Err(Error::Unknown(id.to_owned()));
        }
        let found = self.scan(projects).into_iter().find(|session| session.id == id);
        let summary = found.ok_or_else(|| Error::Unknown(id.to_owned()))?.summary;
        if running(sessions).contains(id) {
            return Err(Error::Running);
        }
        let folder = opens_in(&summary.folder).ok_or(Error::FolderGone(summary.folder))?;
        let label = one_line(summary.title.as_deref().unwrap_or(&summary.prompt), MAX_LABEL_CHARS);
        Ok(Target { folder, label })
    }
}

/// The session a project's file holds: `<uuid>.jsonl`, nothing else there.
fn transcript_id(path: &Path) -> Option<&str> {
    if path.extension()? != "jsonl" {
        return None;
    }
    path.file_stem()?.to_str().filter(|stem| is_session_id(stem))
}

fn stamp(path: &Path) -> Option<(u64, SystemTime)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

#[cfg(test)]
mod tests;
