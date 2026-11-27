//! Doable tasks for the Doable panel, read with an API token through the
//! Doable server's `/v1` API (`~/code/doable/server`). The token is the login
//! keychain's generic password for the service `doable` (read with
//! `/usr/bin/security`, as `claude_usage` reads Claude Code's sign-in, so a
//! rebuilt app is not asked for access again), else `DOABLE_TOKEN` in the
//! app's environment. It is never written, and never leaves this side: the
//! webview only gets tasks. The server is `DOABLE_URL`, else the deployed one.
//! See docs/plan-doable.md.

use crate::{ledger::Entry, process};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::{ErrorKind, Write as _},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

const SERVER: &str = "https://doable-chi.vercel.app";
const SERVER_ENV: &str = "DOABLE_URL";
/// The keychain item: `security add-generic-password -s doable -a "$USER" -w`.
pub const KEYCHAIN: &str = "doable";
const ENV: &str = "DOABLE_TOKEN";
const TIMEOUT: Duration = Duration::from_secs(15);
/// Project names change rarely; tasks are read on every refresh.
const PROJECTS_FRESH: Duration = Duration::from_secs(10 * 60);
/// Who made a task, as Doable's `source` keeps it.
const SOURCE: &str = "herdr";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no Doable token: add it to the keychain with `security add-generic-password -s doable -a \"$USER\" -w`")]
    NoToken,
    #[error("Doable refused the token (HTTP {0})")]
    Refused(u16),
    #[error("not a Doable view: {0}")]
    View(String),
    #[error("Doable does not read that date: {0}")]
    Due(String),
    #[error("could not reach Doable: {0}")]
    Request(String),
    #[error("Doable answered in an unknown shape: {0}")]
    Shape(String),
    #[error("the Doable reader stopped")]
    Worker(#[source] tauri::Error),
    #[error("not a Doable link: {0}")]
    BadLink(String),
    #[error("Doable has nothing to do for a `{0}` outcome")]
    Kind(String),
    #[error("could not use the Doable links file: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Ledger(#[from] crate::ledger::Error),
}

/// A task as the panel shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    /// Doable's notes.
    pub description: String,
    pub project: Option<String>,
    pub labels: Vec<String>,
    /// 1 (normal) to 4 (urgent): Doable's p4 to p1, turned round.
    pub priority: u8,
    /// The instant Doable keeps (UTC); the webview reads it in local time.
    pub due: Option<String>,
    /// Whether `due` has a time of day, or is a whole day.
    pub due_time: bool,
    /// How it was typed: `tomorrow`, `every monday`.
    pub due_words: Option<String>,
    /// The repo a repo link names, `owner/name` or `name`.
    pub repo: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Tasks {
    pub tasks: Vec<Task>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTask {
    id: String,
    title: String,
    #[serde(default)]
    notes: String,
    #[serde(rename = "projectID")]
    project_id: Option<String>,
    #[serde(default = "lowest")]
    priority: u8,
    #[serde(default)]
    labels: Vec<String>,
    due: Option<RawDue>,
    #[serde(default)]
    links: Vec<Value>,
}

fn lowest() -> u8 {
    4
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDue {
    date: String,
    #[serde(default)]
    has_time: bool,
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawProject {
    id: String,
    name: String,
    #[serde(default)]
    is_inbox: bool,
    deleted_at: Option<String>,
}

#[derive(Clone, Default)]
struct Projects {
    names: HashMap<String, String>,
    inbox: Option<String>,
}

impl Projects {
    fn id_of(&self, want: &str) -> Option<&str> {
        let want = want.trim();
        self.names.iter().find(|(_, name)| name.eq_ignore_ascii_case(want)).map(|(id, _)| id.as_str())
    }
}

/// Project names by id, kept a while: the panel rereads tasks often.
#[derive(Default)]
pub struct Cache(Mutex<Option<(Instant, Projects)>>);

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

fn server() -> String {
    std::env::var(SERVER_ENV)
        .ok()
        .map(|url| url.trim().trim_end_matches('/').to_owned())
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| SERVER.to_owned())
}

/// This machine's time zone (`Europe/Madrid`), from where `/etc/localtime`
/// points, for the views that count "today". None leaves it to the server's.
fn zone() -> Option<String> {
    let target = std::fs::read_link("/etc/localtime").ok()?;
    let target = target.to_string_lossy();
    let (_, zone) = target.split_once("zoneinfo/")?;
    let fine = !zone.is_empty() && zone.bytes().all(|b| b.is_ascii_alphanumeric() || b"/_-+".contains(&b));
    fine.then(|| zone.to_owned())
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .http_status_as_error(false)
        .build()
        .new_agent()
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Method {
    Get,
    Post,
    Patch,
    Delete,
}

/// One call to the API: a method, a path under `/v1` with its query, and a JSON body.
#[derive(Debug, PartialEq)]
struct Request {
    method: Method,
    path: String,
    query: Vec<(String, String)>,
    body: Option<Value>,
}

impl Request {
    fn new(method: Method, path: impl Into<String>, body: Option<Value>) -> Self {
        Self { method, path: path.into(), query: Vec::new(), body }
    }
}

/// Sends `request`, giving back the answer's body.
fn send(token: &str, request: &Request) -> Result<String, Error> {
    let mut url = format!("{}/v1{}", server(), request.path);
    if !request.query.is_empty() {
        let pairs: Vec<String> = request.query.iter().map(|(k, v)| format!("{k}={}", encode(v))).collect();
        url = format!("{url}?{}", pairs.join("&"));
    }
    let auth = format!("Bearer {token}");
    let client = agent();
    let sent = match (request.method, &request.body) {
        (Method::Get, _) => client.get(&url).header("Authorization", &auth).call(),
        (Method::Delete, _) => client.delete(&url).header("Authorization", &auth).call(),
        (Method::Post, None) => client.post(&url).header("Authorization", &auth).send_empty(),
        (Method::Post, Some(body)) => {
            client.post(&url).header("Authorization", &auth).header("Content-Type", "application/json").send(body.to_string())
        }
        (Method::Patch, body) => client
            .patch(&url)
            .header("Authorization", &auth)
            .header("Content-Type", "application/json")
            .send(body.clone().unwrap_or_else(|| json!({})).to_string()),
    };
    let mut response = sent.map_err(|error| Error::Request(error.to_string()))?;
    let status = response.status().as_u16();
    let body = response.body_mut().read_to_string().map_err(|error| Error::Request(error.to_string()))?;
    match status {
        200..=299 => Ok(body),
        401 | 403 => Err(Error::Refused(status)),
        _ => Err(Error::Request(format!("HTTP {status}: {}", error_words(&body)))),
    }
}

fn read<T: for<'de> Deserialize<'de>>(body: &str) -> Result<T, Error> {
    serde_json::from_str(body).map_err(|error| Error::Shape(error.to_string()))
}

/// Percent-encodes a query value.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Doable's own words for a failure: `{"error": "…"}`, else the body cut short.
fn error_words(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value["error"].as_str().map(str::to_owned))
        .unwrap_or_else(|| body.chars().take(200).collect())
}

/// The query that lists `view`: `today`, `upcoming`, `inbox`,
/// `project:<name>`, `label:<name>` or `repo:<name>`.
fn view_query(view: &str, projects: &Projects) -> Result<Vec<(String, String)>, Error> {
    let view = view.trim();
    let pair = |key: &str, value: &str| vec![(key.to_owned(), value.to_owned())];
    if ["today", "upcoming", "inbox"].contains(&view) {
        return Ok(pair("view", view));
    }
    let (kind, name) = view.split_once(':').map(|(kind, name)| (kind, name.trim())).ok_or_else(|| Error::View(view.to_owned()))?;
    if name.is_empty() || name.chars().any(char::is_control) {
        return Err(Error::View(view.to_owned()));
    }
    match kind {
        "project" => projects.id_of(name).map(|id| pair("project", id)).ok_or_else(|| Error::View(format!("no project named {name}"))),
        "label" => Ok(pair("label", name)),
        "repo" => Ok(pair("repo", name)),
        _ => Err(Error::View(view.to_owned())),
    }
}

impl Cache {
    fn projects(&self, token: &str) -> Result<Projects, Error> {
        let mut kept = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((_, projects)) = kept.as_ref().filter(|(read, _)| read.elapsed() < PROJECTS_FRESH) {
            return Ok(projects.clone());
        }
        #[derive(Deserialize)]
        struct Answer {
            projects: Vec<RawProject>,
        }
        let answer: Answer = read(&send(token, &Request::new(Method::Get, "/projects", None))?)?;
        let projects = shape_projects(answer.projects);
        *kept = Some((Instant::now(), projects.clone()));
        Ok(projects)
    }

    /// Every project's name, the Inbox first and then by name, for the panel's view picker.
    pub fn project_names(&self) -> Result<Vec<String>, Error> {
        let token = token()?;
        Ok(sorted_names(self.projects(&token)?.names.into_values()))
    }

    /// The tasks in `view` (see `view_query`).
    pub fn tasks(&self, view: &str) -> Result<Tasks, Error> {
        let token = token()?;
        let projects = self.projects(&token)?;
        let mut request = Request::new(Method::Get, "/tasks", None);
        request.query = view_query(view, &projects)?;
        request.query.extend(zone().map(|zone| ("tz".to_owned(), zone)));
        #[derive(Deserialize)]
        struct Answer {
            tasks: Vec<RawTask>,
        }
        let answer: Answer = read(&send(&token, &request)?)?;
        Ok(Tasks { tasks: answer.tasks.into_iter().map(|task| shape(task, &projects)).collect() })
    }

    /// Adds `new` to the project named `project` (any case), or the Inbox
    /// when that is none or no project has that name. A due date in words is
    /// read by Doable's quick add, so it is added that way and then given its
    /// title, notes and project.
    pub fn add(&self, new: &NewTask, project: Option<&str>) -> Result<Task, Error> {
        let (title, notes, due) = new_task(new)?;
        let token = token()?;
        let projects = self.projects(&token)?;
        let mut fields = json!({ "title": title, "notes": notes });
        if let Some(id) = project.and_then(|want| projects.id_of(want)) {
            fields["projectID"] = id.into();
        }
        let raw: RawTask = match due {
            None => {
                fields["source"] = SOURCE.into();
                read(&send(&token, &Request::new(Method::Post, "/tasks", Some(fields)))?)?
            }
            Some(due) => {
                let dated: RawTask = read(&send(&token, &quick(&format!("Remind {due}"))?)?)?;
                if dated.due.is_none() {
                    // A task with no date would not come back when it should: none at all.
                    send(&token, &Request::new(Method::Delete, format!("/tasks/{}", dated.id), None))?;
                    return Err(Error::Due(due));
                }
                read(&send(&token, &Request::new(Method::Patch, format!("/tasks/{}", dated.id), Some(fields)))?)?
            }
        };
        Ok(shape(raw, &projects))
    }

    /// Adds a task typed as in Doable's quick add, which reads the date,
    /// `p1`–`p4`, `#project` and `@label` out of `text`. One with no date is
    /// due `today` (the local day's start, as UTC), so a today view shows it;
    /// one left in the Inbox moves to the project named `project`, the
    /// workspace's repo, when there is one.
    pub fn quick_add(&self, text: &str, project: Option<&str>, today: &str) -> Result<Task, Error> {
        let request = quick(text)?;
        if !instant(today) {
            return Err(Error::Shape(format!("not an instant: {today:?}")));
        }
        let token = token()?;
        let mut projects = self.projects(&token)?;
        let raw: RawTask = read(&send(&token, &request)?)?;
        // A `#project` it made, or an Inbox made on first need, is not in the kept names yet.
        if raw.project_id.as_ref().is_some_and(|id| !projects.names.contains_key(id)) {
            *self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
            projects = self.projects(&token)?;
        }
        let mapped = project.and_then(|want| projects.id_of(want));
        // The task is in Doable now: a follow-up that fails leaves it as typed, not lost.
        let raw = match follow_up(&raw, &projects, mapped, today) {
            Some(patch) => read(&send(&token, &patch)?)?,
            None => raw,
        };
        Ok(shape(raw, &projects))
    }
}

fn shape_projects(raw: Vec<RawProject>) -> Projects {
    let live: Vec<RawProject> = raw.into_iter().filter(|project| project.deleted_at.is_none()).collect();
    Projects {
        inbox: live.iter().find(|project| project.is_inbox).map(|project| project.id.clone()),
        names: live.into_iter().map(|project| (project.id, project.name)).collect(),
    }
}

/// An ISO-8601 instant as the webview gives one: `2026-11-27T23:00:00Z`.
fn instant(time: &str) -> bool {
    (10..=40).contains(&time.len()) && time.bytes().all(|b| b.is_ascii_alphanumeric() || b":.-+".contains(&b))
}

/// The request that quick-adds `text`, read as Doable's quick add box reads it.
fn quick(text: &str) -> Result<Request, Error> {
    let text: String = text.trim().chars().filter(|c| !c.is_control()).take(MAX_TITLE).collect();
    if text.is_empty() {
        return Err(Error::Shape("a task needs a title".into()));
    }
    let mut request = Request::new(Method::Post, "/quick-add", Some(json!({ "text": text, "source": SOURCE })));
    request.query.extend(zone().map(|zone| ("tz".to_owned(), zone)));
    Ok(request)
}

/// What a quick-added `task` still needs, as one change: `today` as its date
/// when it has none, and a move to `project` (an id) when it is in the Inbox.
fn follow_up(task: &RawTask, projects: &Projects, project: Option<&str>, today: &str) -> Option<Request> {
    let mut patch = serde_json::Map::new();
    if task.due.is_none() {
        patch.insert("due".into(), json!({ "date": today, "hasTime": false, "text": "today" }));
    }
    let in_inbox = task.project_id.is_some() && task.project_id == projects.inbox;
    if let Some(project) = project.filter(|_| in_inbox) {
        patch.insert("projectID".into(), project.into());
    }
    (!patch.is_empty()).then(|| Request::new(Method::Patch, format!("/tasks/{}", task.id), Some(Value::Object(patch))))
}

/// Project names, the Inbox first and then by name, any case.
fn sorted_names(names: impl Iterator<Item = String>) -> Vec<String> {
    let mut names: Vec<String> = names.collect();
    names.sort_by_key(|name| (!name.eq_ignore_ascii_case("inbox"), name.to_lowercase()));
    names.dedup();
    names
}

/// A task to add: its title, and optionally a description (its notes) and a
/// due date in words (`tomorrow 9am`, `next monday`), which Doable reads.
#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
pub struct NewTask {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub due: Option<String>,
}

const MAX_TITLE: usize = 500;
const MAX_NOTES: usize = 16_000;
const MAX_DUE: usize = 100;

/// `new`'s title, notes and due words, trimmed and checked.
fn new_task(new: &NewTask) -> Result<(String, String, Option<String>), Error> {
    let title: String = new.title.trim().chars().filter(|c| !c.is_control()).take(MAX_TITLE).collect();
    if title.is_empty() {
        return Err(Error::Shape("a task needs a title".into()));
    }
    let notes: String = new.description.as_deref().unwrap_or_default().trim().chars().take(MAX_NOTES).collect();
    let due = new.due.as_deref().map(str::trim).filter(|due| !due.is_empty());
    if let Some(due) = due {
        // Read as quick add text, so a `#` or `@` would pick a project or a label.
        if due.len() > MAX_DUE || due.chars().any(|c| c.is_control() || c == '#' || c == '@') {
            return Err(Error::Due(due.to_owned()));
        }
    }
    Ok((title, notes, due.map(str::to_owned)))
}

/// The request that sets `task`'s labels to `labels`, all of them, and, when
/// `repo` is given, its repo link to that repo in place of any other. A
/// label is a short name without control characters, as a triage suggestion
/// accepted in the panel gives. `links` are the task's links now.
fn labels_write(task: &str, labels: &[String], repo: Option<&str>, links: &[Value]) -> Result<Request, Error> {
    let fine = |label: &str| !label.trim().is_empty() && label.chars().count() <= 60 && !label.chars().any(char::is_control);
    if !plain_id(task) || labels.len() > 50 || !labels.iter().all(|label| fine(label)) || !repo.is_none_or(fine) {
        return Err(Error::BadLink(format!("{task}: {labels:?} {repo:?}")));
    }
    let labels: Vec<&str> = labels.iter().map(|label| label.trim()).collect();
    let mut body = json!({ "labels": labels });
    if let Some(repo) = repo {
        let mut kept: Vec<Value> = links.iter().filter(|link| link["type"] != "repo").cloned().collect();
        kept.push(json!({ "type": "repo", "ref": repo.trim() }));
        body["links"] = kept.into();
    }
    Ok(Request::new(Method::Patch, format!("/tasks/{task}"), Some(body)))
}

/// Sets `task`'s labels to `labels`, and its repo link to `repo` when given.
pub fn set_labels(task: &str, labels: &[String], repo: Option<&str>) -> Result<(), Error> {
    labels_write(task, labels, repo, &[])?;
    let token = token()?;
    let links = match repo {
        Some(_) => read::<RawTask>(&send(&token, &Request::new(Method::Get, format!("/tasks/{task}"), None))?)?.links,
        None => Vec::new(),
    };
    send(&token, &labels_write(task, labels, repo, &links)?).map(drop)
}

/// The request that completes `task`, or reopens it when `done` is false
/// (the panel's undo). Completing also completes its open subtasks; a
/// recurring task moves to its next date instead.
fn done_write(task: &str, done: bool) -> Result<Request, Error> {
    if !plain_id(task) {
        return Err(Error::BadLink(task.to_owned()));
    }
    Ok(if done {
        let mut request = Request::new(Method::Post, format!("/tasks/{task}/complete"), None);
        request.query.extend(zone().map(|zone| ("tz".to_owned(), zone)));
        request
    } else {
        Request::new(Method::Patch, format!("/tasks/{task}"), Some(json!({ "completedAt": null })))
    })
}

/// Completes `task` in Doable, or reopens it.
pub fn set_done(task: &str, done: bool) -> Result<(), Error> {
    let request = done_write(task, done)?;
    send(&token()?, &request).map(drop)
}

/// The repo a task's first repo link names.
fn repo_of(links: &[Value]) -> Option<String> {
    links.iter().find(|link| link["type"] == "repo").and_then(|link| link["ref"].as_str()).map(str::to_owned)
}

fn shape(task: RawTask, projects: &Projects) -> Task {
    Task {
        url: format!("{}/", server()),
        project: task.project_id.and_then(|id| projects.names.get(&id).cloned()),
        repo: repo_of(&task.links),
        id: task.id,
        title: task.title,
        description: task.notes,
        labels: task.labels,
        priority: 5 - task.priority.clamp(1, 4),
        due_time: task.due.as_ref().is_some_and(|due| due.has_time),
        due: task.due.as_ref().map(|due| due.date.clone()),
        due_words: task.due.map(|due| due.text).filter(|text| !text.trim().is_empty()),
    }
}

// Closing the loop (docs/plan-doable.md): which task a prompt came from, and
// what was written back to it when its agent reported. Kept in `doable.jsonl`
// beside the outcome ledger, append-only as the ledger is, so Stable, Edge
// and a dev build share it.

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
    /// `closed` or `subtask`.
    pub did: String,
    pub at: String,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct Links {
    pub links: Vec<Link>,
    pub written: Vec<Written>,
}

pub fn links_path() -> Result<PathBuf, Error> {
    Ok(crate::ledger::path()?.with_file_name("doable.jsonl"))
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

fn append(path: &Path, line: &Value) -> Result<(), Error> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    // One write, so a line never interleaves with another window's.
    file.write_all(format!("{line}\n").as_bytes())?;
    Ok(())
}

/// A Doable or ledger id: it goes into a URL path.
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
    let line = json!({ "v": 1, "task": task, "title": title, "pane": pane, "head": head, "at": crate::ledger::now_utc() });
    append(path, &line)
}

fn on_branch(entry: &Entry) -> String {
    if entry.branch.is_empty() { String::new() } else { format!(" on `{}`", entry.branch) }
}

/// What an outcome becomes in Doable, by its kind, and the name the links
/// file keeps it under: a verified `done` adds a note naming its commits to
/// the task's `notes` and completes it; a `left` becomes a subtask in the
/// task's `project`. A `you` writes nothing.
fn writes(task: &str, entry: &Entry, commits: &[String], notes: &str, project: Option<&str>) -> Result<(&'static str, Vec<Request>), Error> {
    let note = entry.note.trim();
    match entry.kind.as_str() {
        "verified" => {
            let mut lines = vec![format!("{}: done by an agent in Herdr Miura{}, verified against Git.", entry.at, on_branch(entry))];
            if !note.is_empty() {
                lines.extend([String::new(), note.to_owned()]);
            }
            if !commits.is_empty() {
                lines.extend([String::new(), "Commits:".to_owned()]);
                lines.extend(commits.iter().map(|commit| format!("- {commit}")));
            } else if crate::queue::commit_id(&entry.head) {
                lines.extend([String::new(), format!("At commit {}.", &entry.head[..12])]);
            }
            let notes = [notes.trim(), &lines.join("\n")].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n\n");
            let patch = Request::new(Method::Patch, format!("/tasks/{task}"), Some(json!({ "notes": notes })));
            Ok(("closed", vec![patch, done_write(task, true)?]))
        }
        "left" => {
            let title = if note.is_empty() { "Left for later by an agent" } else { note };
            let notes = format!("Left for later by an agent in Herdr Miura{}, {}.", on_branch(entry), entry.at);
            let mut body = json!({ "title": title, "notes": notes, "parentID": task, "source": SOURCE });
            if let Some(project) = project {
                body["projectID"] = project.into();
            }
            Ok(("subtask", vec![Request::new(Method::Post, "/tasks", Some(body))]))
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
    // Refuses an outcome with nothing to write before any request.
    let (did, _) = writes(task, entry, &[], "", None)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let lock = OpenOptions::new().create(true).truncate(false).write(true).open(path.with_file_name("doable.lock"))?;
    lock.lock()?;
    if read_links(path)?.written.iter().any(|w| w.entry == entry.id && w.did == did) {
        return Ok(false);
    }
    let token = token()?;
    let current: RawTask = read(&send(&token, &Request::new(Method::Get, format!("/tasks/{task}"), None))?)?;
    let (_, requests) = writes(task, entry, &commits(entry, from), &current.notes, current.project_id.as_deref())?;
    for request in &requests {
        send(&token, request)?;
    }
    let line = json!({ "v": 1, "entry": entry.id, "task": task, "did": did, "at": crate::ledger::now_utc() });
    append(path, &line)?;
    Ok(true)
}

/// How many of `tasks` (Doable's completed view) were completed between `since` and `until`.
fn completed_between(tasks: &[Value], since: &str, until: &str) -> usize {
    tasks
        .iter()
        .filter_map(|task| task["completedAt"].as_str())
        .filter(|at| (since..=until).contains(at))
        .count()
}

/// How many tasks were completed between `since` and `until` (UTC, `2026-11-13T00:00:00Z`).
pub fn completed(since: &str, until: &str) -> Result<usize, Error> {
    if !instant(since) || !instant(until) {
        return Err(Error::BadLink(format!("{since}..{until}")));
    }
    let mut request = Request::new(Method::Get, "/tasks", None);
    request.query.push(("view".into(), "completed".into()));
    #[derive(Deserialize)]
    struct Answer {
        tasks: Vec<Value>,
    }
    let answer: Answer = read(&send(&token()?, &request)?)?;
    Ok(completed_between(&answer.tasks, since, until))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "6F9619FF-8B86-D011-B42D-00C04FC964FF";

    fn entry(kind: &str, note: &str) -> Entry {
        serde_json::from_value(json!({
            "id": "1762941600000-42", "at": "2026-11-12T10:00:00Z", "kind": kind, "note": note,
            "branch": "fix-x", "head": "0123456789abcdef0123456789abcdef01234567",
        }))
        .unwrap_or_else(|error| panic!("{error}"))
    }

    fn projects() -> Projects {
        Projects {
            names: HashMap::from([("IN".to_owned(), "Inbox".to_owned()), ("P1".to_owned(), "Herdr".to_owned())]),
            inbox: Some("IN".to_owned()),
        }
    }

    fn raw(json: &str) -> RawTask {
        serde_json::from_str(json).unwrap_or_else(|error| panic!("{error}"))
    }

    #[test]
    fn a_verified_done_notes_its_commits_then_completes() -> Result<(), Error> {
        let commits = ["abc1234 feat: one".to_owned(), "def5678 fix: two".to_owned()];
        let (did, requests) = writes(ID, &entry("verified", "shipped it"), &commits, "The spec", None)?;
        assert_eq!(did, "closed");
        assert_eq!(requests.len(), 2);
        assert_eq!((requests[0].method, requests[0].path.as_str()), (Method::Patch, format!("/tasks/{ID}").as_str()));
        assert_eq!(
            requests[0].body.clone().unwrap_or_default()["notes"],
            "The spec\n\n2026-11-12T10:00:00Z: done by an agent in Herdr Miura on `fix-x`, verified against Git.\n\nshipped it\n\nCommits:\n- abc1234 feat: one\n- def5678 fix: two"
        );
        assert_eq!((requests[1].method, requests[1].path.clone()), (Method::Post, format!("/tasks/{ID}/complete")));
        let (_, bare) = writes(ID, &entry("verified", ""), &[], "", None)?;
        assert_eq!(
            bare[0].body.clone().unwrap_or_default()["notes"],
            "2026-11-12T10:00:00Z: done by an agent in Herdr Miura on `fix-x`, verified against Git.\n\nAt commit 0123456789ab."
        );
        Ok(())
    }

    #[test]
    fn completing_completes_and_undo_reopens() -> Result<(), Error> {
        let done = done_write(ID, true)?;
        assert_eq!((done.method, done.path), (Method::Post, format!("/tasks/{ID}/complete")));
        assert_eq!(
            done_write(ID, false)?,
            Request::new(Method::Patch, format!("/tasks/{ID}"), Some(json!({ "completedAt": null })))
        );
        assert!(done_write("../projects", true).is_err());
        Ok(())
    }

    #[test]
    fn a_left_becomes_a_subtask_in_its_project_and_a_you_writes_nothing() -> Result<(), Error> {
        let (did, requests) = writes(ID, &entry("left", "test it on GTK"), &[], "", Some("P1"))?;
        assert_eq!((did, requests[0].path.as_str()), ("subtask", "/tasks"));
        let body = requests[0].body.clone().unwrap_or_default();
        assert_eq!((body["title"].as_str(), body["parentID"].as_str(), body["projectID"].as_str()), (Some("test it on GTK"), Some(ID), Some("P1")));
        assert!(matches!(writes(ID, &entry("you", "pick a name"), &[], "", None), Err(Error::Kind(_))));
        assert!(matches!(writes(ID, &entry("unverified", ""), &[], "", None), Err(Error::Kind(_))));
        Ok(())
    }

    #[test]
    fn links_round_trip_and_odd_ids_are_refused() -> Result<(), Error> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("state/doable.jsonl");
        link(&path, ID, "Fix\u{7} it", "w3A:p1", None)?;
        append(&path, &json!({ "v": 1, "entry": "1-2", "task": ID, "did": "closed", "at": "2026-11-13T10:00:00Z" }))?;
        std::fs::OpenOptions::new().append(true).open(&path)?.write_all(b"{\"half\":\n")?;
        let links = read_links(&path)?;
        assert_eq!(links.links.len(), 1);
        assert_eq!((links.links[0].title.as_str(), links.links[0].pane.as_str(), links.links[0].head.as_ref()), ("Fix it", "w3A:p1", None));
        assert_eq!(links.written[0].did, "closed");
        assert!(matches!(link(&path, "../x", "t", "w1:p1", None), Err(Error::BadLink(_))));
        assert!(matches!(link(&path, ID, "t", "--all", None), Err(Error::BadLink(_))));
        assert_eq!(read_links(&dir.path().join("none.jsonl"))?, Links::default());
        Ok(())
    }

    #[test]
    fn a_write_already_recorded_is_not_sent_again() -> Result<(), Error> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("doable.jsonl");
        let done = entry("verified", "x");
        append(&path, &json!({ "v": 1, "entry": done.id, "task": ID, "did": "closed", "at": "2026-11-13T10:00:00Z" }))?;
        // No token is read, so no request could have gone.
        assert!(!write_back(&path, ID, &done, None)?);
        assert!(matches!(write_back(&path, "6/gv", &done, None), Err(Error::BadLink(_))));
        assert!(matches!(write_back(&path, ID, &entry("you", "x"), None), Err(Error::Kind(_))));
        Ok(())
    }

    #[test]
    fn sorts_project_names_inbox_first() {
        let names = ["work", "Inbox", "Errands", "Herdr"].map(String::from);
        assert_eq!(sorted_names(names.into_iter()), ["Inbox", "Errands", "Herdr", "work"]);
    }

    #[test]
    fn projects_keep_the_inbox_and_drop_deleted_ones() {
        let raw: Vec<RawProject> = serde_json::from_value(json!([
            { "id": "IN", "name": "Inbox", "isInbox": true, "deletedAt": null },
            { "id": "P1", "name": "Herdr" },
            { "id": "P2", "name": "Gone", "deletedAt": "2026-11-01T00:00:00Z" },
        ]))
        .unwrap_or_else(|error| panic!("{error}"));
        let projects = shape_projects(raw);
        assert_eq!(projects.inbox.as_deref(), Some("IN"));
        assert_eq!(projects.id_of(" herdr "), Some("P1"));
        assert_eq!(projects.id_of("Gone"), None);
    }

    #[test]
    fn shapes_a_task_with_its_project_repo_and_turned_priority() {
        let task = shape(
            raw(r#"{"id":"A1","title":"Fix it","notes":"why","projectID":"P1","labels":["agent"],"priority":1,
                "due":{"date":"2026-09-23T22:00:00Z","hasTime":false,"text":"tomorrow"},
                "links":[{"type":"url","ref":"https://x"},{"type":"repo","ref":"iloire/herdr-miura","path":"a.rs:3"}],
                "createdAt":"2026-09-01T00:00:00Z","updatedAt":"2026-09-01T00:00:00Z"}"#),
            &projects(),
        );
        assert_eq!(task.project.as_deref(), Some("Herdr"));
        assert_eq!((task.due.as_deref(), task.due_time), (Some("2026-09-23T22:00:00Z"), false));
        assert_eq!(task.due_words.as_deref(), Some("tomorrow"));
        assert_eq!(task.repo.as_deref(), Some("iloire/herdr-miura"));
        assert_eq!((task.description.as_str(), task.priority), ("why", 4));
    }

    #[test]
    fn a_task_with_little_set_still_reads() {
        let task = shape(raw(r#"{"id":"1","title":"x","projectID":null}"#), &Projects::default());
        assert_eq!((task.project, task.due, task.due_words, task.repo, task.priority), (None, None, None, None, 1));
    }

    #[test]
    fn views_become_queries() -> Result<(), Error> {
        let pairs = |view: &str| view_query(view, &projects());
        let one = |k: &str, v: &str| vec![(k.to_owned(), v.to_owned())];
        assert_eq!(pairs("today")?, one("view", "today"));
        assert_eq!(pairs(" upcoming ")?, one("view", "upcoming"));
        assert_eq!(pairs("project:herdr")?, one("project", "P1"));
        assert_eq!(pairs("label:agent")?, one("label", "agent"));
        assert_eq!(pairs("repo:herdr-miura")?, one("repo", "herdr-miura"));
        assert!(matches!(pairs("project:nowhere"), Err(Error::View(_))));
        assert!(matches!(pairs("today | overdue"), Err(Error::View(_))));
        assert!(matches!(pairs("label:"), Err(Error::View(_))));
        assert_eq!(encode("a b&c/é"), "a%20b%26c%2F%C3%A9");
        Ok(())
    }

    #[test]
    fn a_new_task_is_trimmed_and_its_due_words_checked() -> Result<(), Error> {
        let dated = NewTask { title: " Run the prompt ".into(), description: Some(" The prompt\n\nwhole ".into()), due: Some(" tomorrow 9am ".into()) };
        assert_eq!(new_task(&dated)?, ("Run the prompt".into(), "The prompt\n\nwhole".into(), Some("tomorrow 9am".into())));
        let blank = NewTask { description: None, due: Some("".into()), ..dated.clone() };
        assert_eq!(new_task(&blank)?, ("Run the prompt".into(), String::new(), None));
        assert!(matches!(new_task(&NewTask { due: Some("today\nevery day".into()), ..dated.clone() }), Err(Error::Due(_))));
        assert!(matches!(new_task(&NewTask { due: Some("monday #work".into()), ..dated }), Err(Error::Due(_))));
        assert!(matches!(new_task(&NewTask { title: " \n".into(), ..NewTask::default() }), Err(Error::Shape(_))));
        assert_eq!(new_task(&NewTask { title: "x".repeat(600), ..NewTask::default() })?.0.len(), 500);
        Ok(())
    }

    #[test]
    fn a_quick_add_sends_the_text_whole() -> Result<(), Error> {
        let request = quick(" dentista tomorrow 10am p1 #Personal @agent ")?;
        assert_eq!((request.method, request.path.as_str()), (Method::Post, "/quick-add"));
        assert_eq!(request.body, Some(json!({ "text": "dentista tomorrow 10am p1 #Personal @agent", "source": "herdr" })));
        assert!(matches!(quick(" \n"), Err(Error::Shape(_))));
        Ok(())
    }

    #[test]
    fn a_quick_added_task_gets_today_and_leaves_the_inbox() {
        let today = "2026-11-26T23:00:00Z";
        let bare = raw(r#"{"id":"A1","title":"x","projectID":"IN"}"#);
        assert_eq!(
            follow_up(&bare, &projects(), Some("P1"), today),
            Some(Request::new(
                Method::Patch,
                "/tasks/A1",
                Some(json!({ "due": { "date": today, "hasTime": false, "text": "today" }, "projectID": "P1" }))
            ))
        );
        // Typed with a date and a #project: Doable read both, nothing to add.
        let typed = raw(r#"{"id":"A1","title":"x","projectID":"P1","due":{"date":"2026-11-27T23:00:00Z","hasTime":false}}"#);
        assert_eq!(follow_up(&typed, &projects(), Some("IN"), today), None);
    }

    #[test]
    fn labels_are_set_whole_with_the_repo_link_replaced() -> Result<(), Error> {
        let labels = vec!["agent".to_owned(), " plan ".to_owned()];
        assert_eq!(labels_write(ID, &labels, None, &[])?.body, Some(json!({ "labels": ["agent", "plan"] })));
        let links = vec![json!({ "type": "repo", "ref": "old" }), json!({ "type": "url", "ref": "https://x" })];
        assert_eq!(
            labels_write(ID, &labels, Some("herdr-miura"), &links)?.body,
            Some(json!({ "labels": ["agent", "plan"], "links": [{ "type": "url", "ref": "https://x" }, { "type": "repo", "ref": "herdr-miura" }] }))
        );
        assert!(labels_write("6gv/close", &labels, None, &[]).is_err());
        assert!(labels_write(ID, &["".to_owned()], None, &[]).is_err());
        assert!(labels_write(ID, &["a\nb".to_owned()], None, &[]).is_err());
        Ok(())
    }

    #[test]
    fn completed_counts_only_the_span() {
        let tasks = vec![
            json!({ "completedAt": "2026-11-13T09:00:00Z" }),
            json!({ "completedAt": "2026-11-12T22:59:59Z" }),
            json!({ "completedAt": null }),
        ];
        assert_eq!(completed_between(&tasks, "2026-11-12T23:00:00Z", "2026-11-13T10:00:00Z"), 1);
    }

    #[test]
    fn error_words_prefers_doables_message() {
        assert_eq!(error_words(r#"{"error":"no project X"}"#), "no project X");
        assert_eq!(error_words("plain"), "plain");
    }
}
