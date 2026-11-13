//! Todoist tasks for the Todoist panel, read with the account's API token
//! through Todoist's API v1. The token is the login keychain's generic
//! password for the service `todoist` (read with `/usr/bin/security`, as
//! `claude_usage` reads Claude Code's sign-in, so a rebuilt app is not asked
//! for access again), else `TODOIST_TOKEN` in the app's environment. It is
//! never written, and never leaves this side: the webview only gets tasks.
//! See docs/plan-todoist.md.

use crate::process;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
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

fn get<T: for<'de> Deserialize<'de>>(token: &str, path: &str, query: &[(&str, &str)]) -> Result<T, Error> {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .http_status_as_error(false)
        .build()
        .new_agent();
    let mut request = agent.get(format!("{API}{path}")).header("Authorization", &format!("Bearer {token}"));
    for (key, value) in query {
        request = request.query(*key, *value);
    }
    let mut response = request.call().map_err(|error| Error::Request(error.to_string()))?;
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|error| Error::Request(error.to_string()))?;
    match status {
        200 => serde_json::from_str(&body).map_err(|error| Error::Shape(error.to_string())),
        401 | 403 => Err(Error::Refused(status)),
        400 => Err(Error::Filter(error_words(&body))),
        _ => Err(Error::Request(format!("HTTP {status}: {}", error_words(&body)))),
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

#[cfg(test)]
mod tests {
    use super::*;

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
