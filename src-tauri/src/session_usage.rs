//! Token use of each Claude Code session in a pane, for the tab header. A
//! session's pane carries its id (the `claude_session` token dotfiles'
//! `herdr-attention` reports from Claude Code's hooks; Herdr cuts a token at
//! 80 characters, too short for the transcript's path), its transcript is
//! `~/.claude/projects/<project>/<id>.jsonl`, and every response in it
//! records its `usage`. Subagents write
//! theirs beside it, in `<session>/subagents/*.jsonl`, and count toward the
//! session. Files are read from where the last read stopped, so polling is
//! cheap once a transcript has been read whole.

use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

/// Minutes of history returned: the plan's 5-hour window and some slack.
const HISTORY_MINUTES: i64 = 6 * 60;
/// How far back [`Cache::history`] reaches: the dialog's seven calendar days
/// begin up to eight days ago.
const WEEK_SECONDS: i64 = 8 * 86_400;
/// The grain of [`Cache::history`]: fine enough for the 5-hour chart, coarse
/// enough to send a week of it every poll.
const BUCKET_SECONDS: i64 = 5 * 60;

/// Tokens by kind, as the API's `usage` reports them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    /// Cache writes kept 5 minutes and 1 hour, which cost differently.
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,
}

impl Tokens {
    fn add(&mut self, other: Tokens) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write_5m += other.cache_write_5m;
        self.cache_write_1h += other.cache_write_1h;
    }

    fn sub(&mut self, other: Tokens) {
        self.input = self.input.saturating_sub(other.input);
        self.output = self.output.saturating_sub(other.output);
        self.cache_read = self.cache_read.saturating_sub(other.cache_read);
        self.cache_write_5m = self.cache_write_5m.saturating_sub(other.cache_write_5m);
        self.cache_write_1h = self.cache_write_1h.saturating_sub(other.cache_write_1h);
    }

    /// The prompt this response was given: what the session's context holds.
    fn prompt(&self) -> u64 {
        self.input + self.cache_read + self.cache_write_5m + self.cache_write_1h
    }
}

/// One minute's tokens; `at` is its start in Unix seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Minute {
    pub at: i64,
    #[serde(flatten)]
    pub tokens: Tokens,
}

/// A session's use, as the webview shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionUsage {
    /// The model of its last response, e.g. `claude-opus-5-5`.
    pub model: Option<String>,
    /// The last response's prompt: the context the next turn starts from.
    pub context: u64,
    /// Its tokens, subagents included, by minute over the last six hours.
    pub minutes: Vec<Minute>,
}

/// A project's use over the last week, in five-minute buckets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectUsage {
    pub name: String,
    pub minutes: Vec<Minute>,
}

/// What has been read of one file.
#[derive(Debug, Default)]
struct FileState {
    offset: u64,
    /// Each response's minute and tokens by message id. A response can be
    /// written more than once as it streams; the last copy counts.
    responses: HashMap<String, (i64, Tokens)>,
    minutes: BTreeMap<i64, Tokens>,
    model: Option<String>,
    context: u64,
    /// Where it started: the session may `cd` into a subfolder later.
    cwd: Option<String>,
}

impl FileState {
    /// Reads what was appended since the last call; starts over when the
    /// file shrank, as a rewritten transcript does.
    fn update(&mut self, path: &Path) -> std::io::Result<()> {
        let mut file = File::open(path)?;
        let len = file.metadata()?.len();
        if len < self.offset {
            *self = FileState::default();
        }
        if len == self.offset {
            return Ok(());
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        // A line still being written is left for the next read.
        let Some(end) = bytes.iter().rposition(|&b| b == b'\n') else {
            return Ok(());
        };
        for line in bytes[..end].split(|&b| b == b'\n') {
            self.line(line);
        }
        self.offset += end as u64 + 1;
        Ok(())
    }

    fn line(&mut self, line: &[u8]) {
        // Most lines are not responses; skip them before parsing.
        if !contains(line, b"\"usage\"") {
            return;
        }
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        let Some(response) = Response::read(&value) else {
            return;
        };
        if self.cwd.is_none() {
            self.cwd = value.get("cwd").and_then(Value::as_str).map(str::to_owned);
        }
        if let Some((minute, tokens)) = self
            .responses
            .insert(response.id, (response.minute, response.tokens))
            && let Some(bucket) = self.minutes.get_mut(&minute)
        {
            bucket.sub(tokens);
        }
        self.minutes
            .entry(response.minute)
            .or_default()
            .add(response.tokens);
        if !response.sidechain {
            self.context = response.tokens.prompt();
            if let Some(model) = response.model {
                self.model = Some(model);
            }
        }
    }
}

/// One response line of a transcript.
struct Response {
    id: String,
    minute: i64,
    tokens: Tokens,
    model: Option<String>,
    sidechain: bool,
}

impl Response {
    fn read(value: &Value) -> Option<Self> {
        if value.get("type")?.as_str()? != "assistant" {
            return None;
        }
        let message = value.get("message")?;
        let usage = message.get("usage")?;
        let count =
            |object: &Value, key: &str| object.get(key).and_then(Value::as_u64).unwrap_or(0);
        let written = count(usage, "cache_creation_input_tokens");
        let (cache_write_5m, cache_write_1h) = match usage.get("cache_creation") {
            Some(split) => (
                count(split, "ephemeral_5m_input_tokens"),
                count(split, "ephemeral_1h_input_tokens"),
            ),
            None => (written, 0),
        };
        let model = message
            .get("model")
            .and_then(Value::as_str)
            .filter(|model| !model.starts_with('<'))
            .map(str::to_owned);
        Some(Self {
            id: message.get("id")?.as_str()?.to_owned(),
            minute: unix_seconds(value.get("timestamp")?.as_str()?)? / 60 * 60,
            tokens: Tokens {
                input: count(usage, "input_tokens"),
                output: count(usage, "output_tokens"),
                cache_read: count(usage, "cache_read_input_tokens"),
                cache_write_5m,
                cache_write_1h,
            },
            model,
            sidechain: value
                .get("isSidechain")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// `2026-10-29T09:33:17.123Z` in Unix seconds; transcripts write UTC.
fn unix_seconds(timestamp: &str) -> Option<i64> {
    let field = |range: std::ops::Range<usize>| timestamp.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (field(0..4)?, field(5..7)?, field(8..10)?);
    let (hour, minute, second) = (field(11..13)?, field(14..16)?, field(17..19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Days from the civil date, after Howard Hinnant's `days_from_civil`.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hour * 3600 + minute * 60 + second)
}

/// What has been read so far, kept between polls.
#[derive(Default)]
pub struct Cache(Mutex<State>);

#[derive(Default)]
struct State {
    /// Each session's transcript, once found.
    transcripts: HashMap<String, PathBuf>,
    files: HashMap<PathBuf, FileState>,
}

impl Cache {
    /// Each session's use, by id; `None` for an id that is not a UUID or
    /// whose transcript is not under `projects` or cannot be read.
    pub fn read(
        &self,
        projects: &Path,
        sessions: &[String],
        now: i64,
    ) -> Vec<Option<SessionUsage>> {
        let Ok(mut state) = self.0.lock() else {
            return vec![None; sessions.len()];
        };
        sessions
            .iter()
            .map(|id| {
                let transcript = state.transcript(projects, id)?;
                session(&mut state.files, &transcript, now)
            })
            .collect()
    }

    /// Every project's use over the last week, closed sessions included, from
    /// the transcripts changed in that time. A resumed session repeats
    /// responses in a new file, so each message id counts once across files.
    pub fn history(&self, projects: &Path, now: i64) -> Vec<ProjectUsage> {
        let Ok(mut state) = self.0.lock() else {
            return Vec::new();
        };
        let since = now - WEEK_SECONDS;
        let paths = recent_transcripts(projects, since);
        for path in &paths {
            // One unreadable file should not cost the chart the others.
            let _ = state.files.entry(path.clone()).or_default().update(path);
        }
        let mut seen = HashSet::new();
        let mut buckets = BTreeMap::<&str, BTreeMap<i64, Tokens>>::new();
        for file in paths.iter().filter_map(|path| state.files.get(path)) {
            let name = project_name(file.cwd.as_deref().unwrap_or("unknown"));
            for (id, (minute, tokens)) in &file.responses {
                if *minute >= since && seen.insert(id.as_str()) {
                    buckets
                        .entry(name)
                        .or_default()
                        .entry(minute / BUCKET_SECONDS * BUCKET_SECONDS)
                        .or_default()
                        .add(*tokens);
                }
            }
        }
        buckets
            .into_iter()
            .map(|(name, minutes)| ProjectUsage {
                name: name.to_owned(),
                minutes: minutes
                    .into_iter()
                    .map(|(at, tokens)| Minute { at, tokens })
                    .collect(),
            })
            .collect()
    }
}

/// The transcripts under `projects`, subagents' included, last written from
/// `since` on, in a fixed order so a repeated response always counts for the
/// same file.
fn recent_transcripts(projects: &Path, since: i64) -> Vec<PathBuf> {
    let children = |folder: &Path| {
        std::fs::read_dir(folder)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .collect::<Vec<_>>()
    };
    let written_since = |path: &PathBuf| {
        std::fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .is_some_and(|age| age.as_secs() as i64 >= since)
    };
    let mut paths: Vec<_> = children(projects)
        .iter()
        .flat_map(|project| children(project))
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .flat_map(|transcript| {
            let mut paths = subagents(&transcript);
            paths.push(transcript);
            paths
        })
        .filter(written_since)
        .collect();
    paths.sort();
    paths
}

/// The folder a project goes by: a worktree counts as its main checkout.
fn project_name(cwd: &str) -> &str {
    let root = cwd.split("/.claude/worktrees/").next().unwrap_or(cwd);
    root.rsplit('/').next().unwrap_or(root)
}

impl State {
    /// `<projects>/*/<id>.jsonl`, looked for once and then remembered while
    /// it exists.
    fn transcript(&mut self, projects: &Path, id: &str) -> Option<PathBuf> {
        // The id comes from a pane's metadata, which anything in the pane can set.
        if !is_session_id(id) {
            return None;
        }
        if let Some(path) = self.transcripts.get(id).filter(|path| path.is_file()) {
            return Some(path.clone());
        }
        let name = format!("{id}.jsonl");
        let path = std::fs::read_dir(projects)
            .ok()?
            .filter_map(|entry| entry.ok().map(|entry| entry.path().join(&name)))
            .find(|path| path.is_file())?;
        self.transcripts.insert(id.to_owned(), path.clone());
        Some(path)
    }
}

/// A Claude Code session id: a UUID, so never a path.
fn is_session_id(id: &str) -> bool {
    id.len() == 36
        && id.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn session(
    files: &mut HashMap<PathBuf, FileState>,
    transcript: &Path,
    now: i64,
) -> Option<SessionUsage> {
    let main = files.entry(transcript.to_owned()).or_default();
    main.update(transcript).ok()?;
    let (model, context) = (main.model.clone(), main.context);
    let mut minutes = main.minutes.clone();
    for path in subagents(transcript) {
        let state = files.entry(path.clone()).or_default();
        if state.update(&path).is_ok() {
            for (at, tokens) in &state.minutes {
                minutes.entry(*at).or_default().add(*tokens);
            }
        }
    }
    let since = now - HISTORY_MINUTES * 60;
    Some(SessionUsage {
        model,
        context,
        minutes: minutes
            .range(since..)
            .filter(|(_, tokens)| **tokens != Tokens::default())
            .map(|(at, tokens)| Minute {
                at: *at,
                tokens: *tokens,
            })
            .collect(),
    })
}

/// `<session>.jsonl`'s subagent transcripts, in `<session>/subagents/`.
fn subagents(transcript: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(transcript.with_extension("").join("subagents")) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .collect()
}

#[cfg(test)]
mod tests;
