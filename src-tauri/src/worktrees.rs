//! The linked worktrees beside each workspace's checkout, for the `⑂3` on
//! its card. Git is asked from the workspace's folder, so worktrees an agent
//! made under `.claude/worktrees/` count although no pane sits in them. Each
//! is read for its branch, its last commit, the commits the remote's default
//! branch lacks and its uncommitted files: together, what the work is and
//! whether it is still pending.

use crate::{changes, git};
use serde::Serialize;
use std::time::{Duration, Instant};

/// How long one checkout's worktrees may take to read, all of them.
const DEADLINE: Duration = Duration::from_secs(5);
/// Worktrees read per checkout; the rest are dropped.
const MAX_WORKTREES: usize = 16;

/// One linked worktree, as the webview shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Worktree {
    pub path: String,
    /// `None` when its HEAD is detached.
    pub branch: Option<String>,
    /// Its last commit's subject and Unix time; `None` when unread.
    pub subject: Option<String>,
    pub time: Option<i64>,
    /// The remote's default branch `unmerged` counts against, as `origin/main`.
    pub base: Option<String>,
    /// Commits the remote's default branch lacks; `None` when there is no
    /// such branch or the count failed.
    pub unmerged: Option<u32>,
    /// Files changed in it, untracked ones included; `None` when unread.
    pub changed: Option<usize>,
}

/// The linked worktrees of each directory's checkout, the main one left
/// out; `None` for a directory outside Git or whose listing failed.
pub fn list(directories: &[String]) -> Vec<Option<Vec<Worktree>>> {
    directories
        .iter()
        .take(changes::MAX_COUNTED)
        .map(|directory| read(directory))
        .collect()
}

fn read(directory: &str) -> Option<Vec<Worktree>> {
    let deadline = Instant::now() + DEADLINE;
    let listing = git::text(
        directory,
        &["worktree", "list", "--porcelain", "-z"],
        "list worktrees",
        deadline,
    )
    .ok()?;
    let linked = parse(&listing);
    if linked.is_empty() {
        return Some(Vec::new());
    }
    let base = changes::default_branch(directory, deadline);
    Some(
        linked
            .into_iter()
            .take(MAX_WORKTREES)
            .map(|entry| {
                let (time, subject) = last_commit(directory, &entry.head, deadline).unzip();
                Worktree {
                    unmerged: base
                        .as_deref()
                        .and_then(|base| unmerged(directory, base, &entry.head, deadline)),
                    changed: changes::count_in(&entry.path, deadline),
                    base: base.clone(),
                    subject,
                    time,
                    path: entry.path,
                    branch: entry.branch,
                }
            })
            .collect(),
    )
}

fn last_commit(directory: &str, head: &str, deadline: Instant) -> Option<(i64, String)> {
    let line = git::text(
        directory,
        &["log", "-1", "--format=%ct%x1f%s", head],
        "read the last commit",
        deadline,
    )
    .ok()?;
    parse_commit(&line)
}

/// `%ct%x1f%s`: the commit's Unix time, then its subject.
fn parse_commit(line: &str) -> Option<(i64, String)> {
    let (time, subject) = line.split_once('\x1f')?;
    Some((time.parse().ok()?, subject.to_owned()))
}

fn unmerged(directory: &str, base: &str, head: &str, deadline: Instant) -> Option<u32> {
    let range = format!("{base}..{head}");
    git::text(
        directory,
        &["rev-list", "--count", &range],
        "count unmerged commits",
        deadline,
    )
    .ok()?
    .parse()
    .ok()
}

#[derive(Debug, Default, PartialEq, Eq)]
struct Entry {
    path: String,
    head: String,
    branch: Option<String>,
}

/// `git worktree list --porcelain -z`: one NUL-ended line per attribute, an
/// empty one ending each worktree. The first is the main worktree and is
/// skipped, as are bare ones, ones whose folder is gone (`prunable`), and
/// ones with no commit to count from.
fn parse(text: &str) -> Vec<Entry> {
    let mut entries = Vec::new();
    let mut entry = Entry::default();
    let mut skip = false;
    let mut first = true;
    for line in text.split('\0') {
        if line.is_empty() {
            if !entry.path.is_empty() {
                if !first && !skip && !entry.head.is_empty() {
                    entries.push(entry);
                }
                first = false;
            }
            entry = Entry::default();
            skip = false;
            continue;
        }
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        match key {
            "worktree" => entry.path = value.to_owned(),
            // An unborn branch's HEAD is all zeros: nothing to count.
            "HEAD" if value.bytes().any(|byte| byte != b'0') => entry.head = value.to_owned(),
            "branch" => {
                entry.branch = Some(
                    value
                        .strip_prefix("refs/heads/")
                        .unwrap_or(value)
                        .to_owned(),
                );
            }
            "bare" | "prunable" => skip = true,
            _ => {}
        }
    }
    entries
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
