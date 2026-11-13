//! Todoist tasks for the Todoist panel, read with the account's API token
//! through Todoist's API v1. The token is the login keychain's generic
//! password for the service `todoist` (read with `/usr/bin/security`, as
//! `claude_usage` reads Claude Code's sign-in, so a rebuilt app is not asked
//! for access again), else `TODOIST_TOKEN` in the app's environment. It is
//! never written, and never leaves this side: the webview only gets tasks.
//! See docs/plan-todoist.md.

use crate::{ledger::Entry, process};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::{ErrorKind, Write as _},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

const API: &str = "https://api.todoist.com/api/v1";
/// The keychain item: `security add-generic-password -s todoist -a "$USER" -w`.
pub const KEYCHAIN: &str = "todoist";
const ENV: &str = "TODOIST_TOKEN";
const TIMEOUT: Duration = Duration::from_secs(15);
/// Project names change rarely; tasks are read on every refresh.
const PROJECTS_FRESH: Duration = Duration::from_secs(10 * 60);
/// Pages of 200; a filter matching more than this is cut, and says so.
const MAX_PAGES: usize = 5;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no Todoist token: add it to the keychain with `security add-generic-password -s todoist -a \"$USER\" -w`")]
    NoToken,
    #[error("Todoist refused the token (HTTP {0})")]
    Refused(u16),
    #[error("Todoist does not accept the filter: {0}")]
    Filter(String),
    #[error("could not read Todoist: {0}")]
    Request(String),
    #[error("Todoist answered in an unknown shape: {0}")]
    Shape(String),
    #[error("the Todoist reader stopped")]
    Worker(#[source] tauri::Error),
    #[error("not a Todoist link: {0}")]
    BadLink(String),
    #[error("Todoist has nothing to do for a `{0}` outcome")]
    Kind(String),
    #[error("could not use the Todoist links file: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Ledger(#[from] crate::ledger::Error),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: String,
    pub project: Option<String>,
    pub labels: Vec<String>,
    /// Todoist's 1 (normal) to 4 (urgent).
    pub priority: u8,
    /// `YYYY-MM-DD` or a full date-time, as Todoist wrote it.
    pub due: Option<String>,
    /// How Todoist says it: `24 Sep`, `every day`.
    pub due_words: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Tasks {
    pub tasks: Vec<Task>,
    /// More matched than were read.
    pub truncated: bool,
}

#[derive(Deserialize)]
struct Page<T> {
    results: Vec<T>,
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct RawTask {
    id: String,
    content: String,
    #[serde(default)]
    description: String,
    project_id: Option<String>,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default = "normal")]
    priority: u8,
    due: Option<RawDue>,
}

fn normal() -> u8 {
    1
}

#[derive(Deserialize)]
struct RawDue {
    date: String,
    string: Option<String>,
}

#[derive(Deserialize)]
struct RawProject {
    id: String,
    name: String,
}

/// Project names by id, kept a while: the panel rereads tasks often.
#[derive(Default)]
pub struct Cache(Mutex<Option<(Instant, HashMap<String, String>)>>);

fn token() -> Result<String, Error> {
    keychain()
        .or_else(|| std::env::var(ENV).ok().map(|token| token.trim().to_owned()).filter(|token| !token.is_empty()))
        .ok_or(Error::NoToken)
}

fn keychain() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let user = std::env::var("USER").ok();
    [user.as_deref(), None].into_iter().find_map(|account| {
        let mut command = process::command("/usr/bin/security");
        command.args(["find-generic-password", "-s", KEYCHAIN, "-w"]);
        if let Some(account) = account {
            command.args(["-a", account]);
        }
        let output = command.output().ok().filter(|output| output.status.success())?;
        let token = String::from_utf8(output.stdout).ok()?.trim().to_owned();
        (!token.is_empty()).then_some(token)
    })
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .http_status_as_error(false)
        .build()
        .new_agent()
}

/// The status and body of an answer, read whole.
fn answer(response: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Result<(u16, String), Error> {
    let mut response = response.map_err(|error| Error::Request(error.to_string()))?;
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|error| Error::Request(error.to_string()))?;
    Ok((status, body))
}

fn get<T: for<'de> Deserialize<'de>>(token: &str, path: &str, query: &[(&str, &str)]) -> Result<T, Error> {
    let mut request = agent().get(format!("{API}{path}")).header("Authorization", &format!("Bearer {token}"));
    for (key, value) in query {
        request = request.query(*key, *value);
    }
    match answer(request.call())? {
        (200, body) => serde_json::from_str(&body).map_err(|error| Error::Shape(error.to_string())),
        (400, body) => Err(Error::Filter(error_words(&body))),
        (status, body) => Err(refused(status, &body)),
    }
}

fn refused(status: u16, body: &str) -> Error {
    match status {
        401 | 403 => Error::Refused(status),
        _ => Error::Request(format!("HTTP {status}: {}", error_words(body))),
    }
}

/// Sends one write: a POST with its JSON body, if any.
fn post(token: &str, request: &Write) -> Result<(), Error> {
    let call = agent()
        .post(format!("{API}{}", request.path))
        .header("Authorization", &format!("Bearer {token}"));
    let sent = match &request.body {
        Some(body) => call.header("Content-Type", "application/json").send(body.to_string()),
        None => call.send_empty(),
    };
    match answer(sent)? {
        (200..=299, _) => Ok(()),
        (status, body) => Err(refused(status, &body)),
    }
}

/// Todoist's own words for a failure: `{"error": "…"}`, else the body cut short.
fn error_words(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value["error"].as_str().map(str::to_owned))
        .unwrap_or_else(|| body.chars().take(200).collect())
}

fn pages<T: for<'de> Deserialize<'de>>(token: &str, path: &str, query: &[(&str, &str)]) -> Result<(Vec<T>, bool), Error> {
    let mut all = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut asked: Vec<(&str, &str)> = query.to_vec();
        asked.push(("limit", "200"));
        if let Some(cursor) = cursor.as_deref() {
            asked.push(("cursor", cursor));
        }
        let page: Page<T> = get(token, path, &asked)?;
        all.extend(page.results);
        match page.next_cursor {
            Some(next) if !next.is_empty() => cursor = Some(next),
            _ => return Ok((all, false)),
        }
    }
    Ok((all, true))
}

impl Cache {
    fn projects(&self, token: &str) -> Result<HashMap<String, String>, Error> {
        let mut kept = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((_, names)) = kept.as_ref().filter(|(read, _)| read.elapsed() < PROJECTS_FRESH) {
            return Ok(names.clone());
        }
        let (projects, _) = pages::<RawProject>(token, "/projects", &[])?;
        let names: HashMap<String, String> = projects.into_iter().map(|project| (project.id, project.name)).collect();
        *kept = Some((Instant::now(), names.clone()));
        Ok(names)
    }

    /// The tasks `filter` matches, in Todoist's filter syntax.
    pub fn tasks(&self, filter: &str) -> Result<Tasks, Error> {
        let token = token()?;
        let (raw, truncated) = pages::<RawTask>(&token, "/tasks/filter", &[("query", filter)])?;
        // A task without its project's name is still worth listing.
        let projects = self.projects(&token).unwrap_or_default();
        let tasks = raw.into_iter().map(|task| shape(task, &projects)).collect();
        Ok(Tasks { tasks, truncated })
    }
}

fn shape(task: RawTask, projects: &HashMap<String, String>) -> Task {
    Task {
        url: format!("https://app.todoist.com/app/task/{}", task.id),
        project: task.project_id.and_then(|id| projects.get(&id).cloned()),
        id: task.id,
        title: task.content,
        description: task.description,
        labels: task.labels,
        priority: task.priority.clamp(1, 4),
        due: task.due.as_ref().map(|due| due.date.clone()),
        due_words: task.due.and_then(|due| due.string),
    }
}

// Closing the loop (docs/plan-todoist.md, idea 3): which task a prompt came
// from, and what was written back to it when its agent reported. Kept in
// `todoist.jsonl` beside the outcome ledger, append-only as the ledger is, so
// Stable, Edge and a dev build share it.

/// A prompt sent from `task` to the agent in `pane`, at `at`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    pub task: String,
    pub title: String,
    pub pane: String,
    /// The checkout's commit when it was sent, so a `done` can name what it committed.
    #[serde(default)]
    pub head: Option<String>,
    pub at: String,
}

/// What was written back to `task` for the ledger entry `entry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Written {
    pub entry: String,
    pub task: String,
    /// `closed`, `subtask` or `commented`.
    pub did: String,
    pub at: String,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct Links {
    pub links: Vec<Link>,
    pub written: Vec<Written>,
}

pub fn links_path() -> Result<PathBuf, Error> {
    Ok(crate::ledger::path()?.with_file_name("todoist.jsonl"))
}

/// The links file, empty when there is none; a line that does not parse is passed over.
pub fn read_links(path: &Path) -> Result<Links, Error> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Links::default()),
        Err(error) => return Err(error.into()),
    };
    let mut links = Links::default();
    for line in text.lines() {
        if let Ok(written) = serde_json::from_str::<Written>(line) {
            links.written.push(written);
        } else if let Ok(link) = serde_json::from_str::<Link>(line) {
            links.links.push(link);
        }
    }
    Ok(links)
}

fn append(path: &Path, line: &serde_json::Value) -> Result<(), Error> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    // One write, so a line never interleaves with another window's.
    file.write_all(format!("{line}\n").as_bytes())?;
    Ok(())
}

/// A Todoist or ledger id: it goes into a URL path.
fn plain_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Records that a prompt from `task` went to the agent in `pane`, with the
/// commit `directory` is on.
pub fn link(path: &Path, task: &str, title: &str, pane: &str, directory: Option<&str>) -> Result<(), Error> {
    let fine_pane = !pane.is_empty() && pane.len() <= 64 && !pane.starts_with('-') && !pane.chars().any(char::is_control);
    if !plain_id(task) || !fine_pane {
        return Err(Error::BadLink(format!("{task} → {pane}")));
    }
    let title: String = title.chars().filter(|c| !c.is_control()).take(300).collect();
    let head = directory.and_then(crate::queue::head);
    let line = serde_json::json!({ "v": 1, "task": task, "title": title, "pane": pane, "head": head, "at": crate::ledger::now_utc() });
    append(path, &line)
}

/// One write to Todoist: a POST to `path`, with `body` as JSON.
#[derive(Debug, PartialEq)]
struct Write {
    path: String,
    body: Option<serde_json::Value>,
}

fn comment(task: &str, content: String) -> Write {
    Write { path: "/comments".into(), body: Some(serde_json::json!({ "task_id": task, "content": content })) }
}

fn on_branch(entry: &Entry) -> String {
    if entry.branch.is_empty() { String::new() } else { format!(" on `{}`", entry.branch) }
}

/// What an outcome becomes in Todoist, by its kind, and the name the links
/// file keeps it under: a verified `done` closes the task with a comment
/// naming its commits; a `left` becomes a subtask; a `you` a comment.
fn writes(task: &str, entry: &Entry, commits: &[String]) -> Result<(&'static str, Vec<Write>), Error> {
    let note = entry.note.trim();
    match entry.kind.as_str() {
        "verified" => {
            let mut lines = vec![format!("Done by an agent in Herdr Miura{}, verified against Git.", on_branch(entry))];
            if !note.is_empty() {
                lines.extend([String::new(), note.to_owned()]);
            }
            if !commits.is_empty() {
                lines.extend([String::new(), "Commits:".to_owned()]);
                lines.extend(commits.iter().map(|commit| format!("- {commit}")));
            } else if crate::queue::commit_id(&entry.head) {
                lines.extend([String::new(), format!("At commit {}.", &entry.head[..12])]);
            }
            let close = Write { path: format!("/tasks/{task}/close"), body: None };
            Ok(("closed", vec![comment(task, lines.join("\n")), close]))
        }
        "left" => {
            let content = if note.is_empty() { "Left for later by an agent" } else { note };
            let description = format!("Left for later by an agent in Herdr Miura{}, {}.", on_branch(entry), entry.at);
            let body = serde_json::json!({ "content": content, "description": description, "parent_id": task });
            Ok(("subtask", vec![Write { path: "/tasks".into(), body: Some(body) }]))
        }
        "you" => {
            let what = if note.is_empty() { "an agent needs you" } else { note };
            Ok(("commented", vec![comment(task, format!("Waiting on you in Herdr Miura{}: {what}", on_branch(entry)))]))
        }
        other => Err(Error::Kind(other.to_owned())),
    }
}

/// The commits `entry`'s head has that `from` did not, as `<short sha> <subject>`, newest first.
fn commits(entry: &Entry, from: Option<&str>) -> Vec<String> {
    let Some(from) = from.filter(|from| crate::queue::commit_id(from) && crate::queue::commit_id(&entry.head)) else {
        return Vec::new();
    };
    // The worktree may be gone; its main checkout holds the same commits.
    let directory = [&entry.cwd, &entry.home].into_iter().find(|dir| !dir.is_empty() && Path::new(dir).is_dir());
    let Some(directory) = directory else { return Vec::new() };
    let range = format!("{from}..{}", entry.head);
    let deadline = Instant::now() + Duration::from_secs(5);
    crate::git::text(directory, &["log", "--format=%h %s", "-n", "20", &range], "list the commits", deadline)
        .map(|text| text.lines().map(str::to_owned).collect())
        .unwrap_or_default()
}

/// Writes the outcome `entry` back to `task`, unless the links file says it
/// was already: under a lock, so two windows reading the same ledger write it
/// once. `from` is the commit the link recorded. False when it was written before.
pub fn write_back(path: &Path, task: &str, entry: &Entry, from: Option<&str>) -> Result<bool, Error> {
    if !plain_id(task) || !plain_id(&entry.id) {
        return Err(Error::BadLink(format!("{task} ← {}", entry.id)));
    }
    let (did, requests) = writes(task, entry, &commits(entry, from))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let lock = OpenOptions::new().create(true).truncate(false).write(true).open(path.with_file_name("todoist.lock"))?;
    lock.lock()?;
    if read_links(path)?.written.iter().any(|w| w.entry == entry.id && w.did == did) {
        return Ok(false);
    }
    let token = token()?;
    for request in &requests {
        post(&token, request)?;
    }
    let line = serde_json::json!({ "v": 1, "entry": entry.id, "task": task, "did": did, "at": crate::ledger::now_utc() });
    append(path, &line)?;
    Ok(true)
}

#[derive(Deserialize)]
struct Completed {
    items: Vec<serde::de::IgnoredAny>,
    next_cursor: Option<String>,
}

/// How many tasks were completed between `since` and `until` (UTC, `2026-11-13T00:00:00Z`).
pub fn completed(since: &str, until: &str) -> Result<usize, Error> {
    let fine = |time: &str| time.len() <= 40 && time.bytes().all(|b| b.is_ascii_alphanumeric() || b":.-+".contains(&b));
    if !fine(since) || !fine(until) {
        return Err(Error::BadLink(format!("{since}..{until}")));
    }
    let token = token()?;
    let mut count = 0;
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut query = vec![("since", since), ("until", until), ("limit", "200")];
        if let Some(cursor) = cursor.as_deref() {
            query.push(("cursor", cursor));
        }
        let page: Completed = get(&token, "/tasks/completed/by_completion_date", &query)?;
        count += page.items.len();
        match page.next_cursor {
            Some(next) if !next.is_empty() => cursor = Some(next),
            _ => break,
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: &str, note: &str) -> Entry {
        serde_json::from_value(serde_json::json!({
            "id": "1762941600000-42", "at": "2026-11-12T10:00:00Z", "kind": kind, "note": note,
            "branch": "fix-x", "head": "0123456789abcdef0123456789abcdef01234567",
        }))
        .unwrap_or_else(|error| panic!("{error}"))
    }

    #[test]
    fn a_verified_done_comments_with_its_commits_then_closes() -> Result<(), Error> {
        let commits = ["abc1234 feat: one".to_owned(), "def5678 fix: two".to_owned()];
        let (did, requests) = writes("6gv", &entry("verified", "shipped it"), &commits)?;
        assert_eq!(did, "closed");
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].path, "/comments");
        let body = requests[0].body.clone().unwrap_or_default();
        assert_eq!(body["task_id"], "6gv");
        assert_eq!(
            body["content"],
            "Done by an agent in Herdr Miura on `fix-x`, verified against Git.\n\nshipped it\n\nCommits:\n- abc1234 feat: one\n- def5678 fix: two"
        );
        assert_eq!(requests[1], Write { path: "/tasks/6gv/close".into(), body: None });
        let (_, bare) = writes("6gv", &entry("verified", ""), &[])?;
        assert_eq!(bare[0].body.clone().unwrap_or_default()["content"], "Done by an agent in Herdr Miura on `fix-x`, verified against Git.\n\nAt commit 0123456789ab.");
        Ok(())
    }

    #[test]
    fn a_left_becomes_a_subtask_and_a_you_a_comment() -> Result<(), Error> {
        let (did, requests) = writes("6gv", &entry("left", "test it on GTK"), &[])?;
        assert_eq!((did, requests[0].path.as_str()), ("subtask", "/tasks"));
        let body = requests[0].body.clone().unwrap_or_default();
        assert_eq!((body["content"].as_str(), body["parent_id"].as_str()), (Some("test it on GTK"), Some("6gv")));
        let (did, requests) = writes("6gv", &entry("you", "pick a name"), &[])?;
        assert_eq!((did, requests[0].path.as_str()), ("commented", "/comments"));
        assert_eq!(requests[0].body.clone().unwrap_or_default()["content"], "Waiting on you in Herdr Miura on `fix-x`: pick a name");
        assert!(matches!(writes("6gv", &entry("unverified", ""), &[]), Err(Error::Kind(_))));
        Ok(())
    }

    #[test]
    fn links_round_trip_and_odd_ids_are_refused() -> Result<(), Error> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("state/todoist.jsonl");
        link(&path, "6gv", "Fix\u{7} it", "w3A:p1", None)?;
        append(&path, &serde_json::json!({ "v": 1, "entry": "1-2", "task": "6gv", "did": "closed", "at": "2026-11-13T10:00:00Z" }))?;
        std::fs::OpenOptions::new().append(true).open(&path)?.write_all(b"{\"half\":\n")?;
        let links = read_links(&path)?;
        assert_eq!(links.links.len(), 1);
        assert_eq!((links.links[0].title.as_str(), links.links[0].pane.as_str(), links.links[0].head.as_ref()), ("Fix it", "w3A:p1", None));
        assert_eq!(links.written[0].did, "closed");
        assert!(matches!(link(&path, "../x", "t", "w1:p1", None), Err(Error::BadLink(_))));
        assert!(matches!(link(&path, "6gv", "t", "--all", None), Err(Error::BadLink(_))));
        assert_eq!(read_links(&dir.path().join("none.jsonl"))?, Links::default());
        Ok(())
    }

    #[test]
    fn a_write_already_recorded_is_not_sent_again() -> Result<(), Error> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("todoist.jsonl");
        let done = entry("you", "x");
        append(&path, &serde_json::json!({ "v": 1, "entry": done.id, "task": "6gv", "did": "commented", "at": "2026-11-13T10:00:00Z" }))?;
        // No token is read, so no request could have gone.
        assert!(!write_back(&path, "6gv", &done, None)?);
        assert!(matches!(write_back(&path, "6/gv", &done, None), Err(Error::BadLink(_))));
        Ok(())
    }

    #[test]
    fn shapes_a_task_with_its_project_name() {
        let raw: RawTask = serde_json::from_str(
            r#"{"id":"6gv","content":"Fix it","description":"why","project_id":"p1","labels":["agent"],
                "priority":4,"due":{"date":"2026-09-24","string":"24 Sep","is_recurring":false}}"#,
        )
        .unwrap_or_else(|error| panic!("{error}"));
        let projects = HashMap::from([("p1".to_owned(), "Herdr".to_owned())]);
        let task = shape(raw, &projects);
        assert_eq!(task.project.as_deref(), Some("Herdr"));
        assert_eq!(task.due.as_deref(), Some("2026-09-24"));
        assert_eq!(task.due_words.as_deref(), Some("24 Sep"));
        assert_eq!(task.url, "https://app.todoist.com/app/task/6gv");
        assert_eq!(task.priority, 4);
    }

    #[test]
    fn a_task_with_little_set_still_reads() {
        let raw: RawTask = serde_json::from_str(r#"{"id":"1","content":"x","project_id":null}"#)
            .unwrap_or_else(|error| panic!("{error}"));
        let task = shape(raw, &HashMap::new());
        assert_eq!((task.project, task.due, task.priority), (None, None, 1));
    }

    #[test]
    fn error_words_prefers_todoists_message() {
        assert_eq!(error_words(r#"{"error":"Invalid filter"}"#), "Invalid filter");
        assert_eq!(error_words("plain"), "plain");
    }
}
