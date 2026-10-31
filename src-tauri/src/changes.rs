//! The Changes panel's reads: the checkout a directory sits in with its
//! files and commits, the files one commit changed, and one file's diff. Every read runs Git on Tauri's
//! blocking pool under a deadline and contacts no remote; nothing here writes.

mod parse;

use crate::git;
use parse::{Commit, FileChange, Kind};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

/// How long one read may take before Git is stopped.
const DEADLINE: Duration = Duration::from_secs(5);
/// Diff bytes kept for one file; a larger diff is refused, not cut.
pub const MAX_DIFF_BYTES: usize = 1024 * 1024;
/// An untracked file's bytes shown at most.
const MAX_TEXT_BYTES: u64 = 1024 * 1024;
/// Files listed per checkout; the rest are only counted.
const MAX_FILES: usize = 50;
/// Commits listed per checkout.
const MAX_COMMITS: usize = 50;
/// Files listed per commit; the rest are only counted.
const MAX_COMMIT_FILES: usize = 300;
/// Commits listed per direction of a push or pull; the panel counts the rest.
const MAX_MOVING: usize = 500;
/// One commit as `parse::log` reads it.
const LOG_FORMAT: &str = "--format=%H%x1f%ct%x1f%an%x1f%s";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Git(#[from] git::Error),
    #[error("the diff is larger than {} KiB", MAX_DIFF_BYTES / 1024)]
    TooLarge,
    #[error("{0} is not a path inside the checkout")]
    OutsideCheckout(String),
    #[error("the file is binary, too large, or a symlink")]
    NotText,
    #[error("{0} is not a commit name")]
    InvalidCommit(String),
    #[error("the Git worker stopped")]
    Worker(#[source] tauri::Error),
}

#[derive(Debug, Serialize)]
pub struct CheckoutView {
    path: String,
    branch: Option<String>,
    upstream: Option<String>,
    /// The upstream's ref is gone, deleted on the remote and pruned here.
    upstream_gone: bool,
    ahead: u32,
    behind: u32,
    /// HEAD has a commit.
    born: bool,
    /// `rebase`, `merge` or `cherry-pick` while one is under way.
    operation: Option<&'static str>,
    /// A rebase's step and its steps in all.
    operation_step: Option<(u32, u32)>,
    /// Files with unresolved conflicts, all of them though `files` stops at [`MAX_FILES`].
    conflicts: usize,
    remotes: Vec<String>,
    /// Commits the remote's default branch lacks, and that branch.
    unmerged: Option<(String, u32)>,
    files: Vec<FileView>,
    total_files: usize,
    added: u64,
    removed: u64,
    commits: Vec<CommitView>,
}

#[derive(Debug, Serialize)]
pub struct FileView {
    path: String,
    /// `git status --short`'s letter: A, U, D, M, R, or ?.
    mark: &'static str,
    additions: Option<u64>,
    deletions: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct CommitView {
    sha: String,
    short: String,
    subject: String,
    author: String,
    time: i64,
}

impl From<FileChange> for FileView {
    fn from(file: FileChange) -> Self {
        Self {
            mark: file.kind.mark(),
            path: file.path,
            additions: file.additions,
            deletions: file.deletions,
        }
    }
}

impl From<Commit> for CommitView {
    fn from(commit: Commit) -> Self {
        Self {
            short: commit.sha.get(..7).unwrap_or(&commit.sha).to_owned(),
            sha: commit.sha,
            subject: commit.subject,
            author: commit.author,
            time: commit.time,
        }
    }
}

/// One commit's whole message and the files it changed, against its first parent.
#[derive(Debug, Serialize)]
pub struct CommitFilesView {
    message: String,
    files: Vec<FileView>,
    total_files: usize,
}

/// One file's change: a unified diff, or an untracked file's whole text.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FileDiff {
    Patch { text: String },
    Untracked { text: String },
}

/// `None` when `directory` is outside Git, which the panel shows as an
/// empty state rather than an error.
pub fn read_checkout(directory: &str) -> Result<Option<CheckoutView>, Error> {
    let deadline = Instant::now() + DEADLINE;
    let Ok(path) = git::text(
        directory,
        &["rev-parse", "--path-format=absolute", "--show-toplevel"],
        "find the checkout",
        deadline,
    ) else {
        return Ok(None);
    };
    let status = parse::status(&git::text(
        &path,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=normal",
        ],
        "read the working tree",
        deadline,
    )?);
    let mut files = status.files;
    let mut commits = Vec::new();
    let mut unmerged = None;
    // An unborn branch has no HEAD to count lines against or log from.
    if status.born {
        // Counts are a nicety: a failure keeps the files without them.
        if let Ok(numstat) = git::text(
            &path,
            &["diff", "--numstat", "-z", "HEAD"],
            "count changed lines",
            deadline,
        ) {
            parse::apply_numstat(&mut files, &numstat);
        }
        let format = format!("--max-count={MAX_COMMITS}");
        commits = parse::log(&git::text(
            &path,
            &["log", &format, "-z", LOG_FORMAT],
            "read recent commits",
            deadline,
        )?);
        // The branch tracking the default branch already says this through ahead.
        unmerged = default_branch(&path, deadline)
            .filter(|base| status.upstream.as_ref() != Some(base))
            .and_then(|base| {
                let range = format!("{base}..HEAD");
                let count = git::text(
                    &path,
                    &["rev-list", "--count", &range],
                    "count unmerged commits",
                    deadline,
                )
                .ok()?
                .trim()
                .parse()
                .ok()?;
                Some((base, count))
            });
    }
    // Neither is worth losing the panel for: without them it offers less.
    let under_way = find_operation(&path, deadline);
    let remotes = git::text(&path, &["remote"], "list the remotes", deadline)
        .map(|remotes| remotes.lines().map(str::to_owned).collect())
        .unwrap_or_default();
    let total_files = files.len();
    let conflicts = files.iter().filter(|file| file.kind == Kind::Conflicted).count();
    files.truncate(MAX_FILES);
    let (added, removed) = files.iter().fold((0, 0), |(added, removed), file| {
        (
            added + file.additions.unwrap_or(0),
            removed + file.deletions.unwrap_or(0),
        )
    });
    Ok(Some(CheckoutView {
        path,
        branch: status.branch,
        upstream_gone: status.born && status.upstream.is_some() && !status.compared,
        upstream: status.upstream,
        ahead: status.ahead,
        behind: status.behind,
        born: status.born,
        operation: under_way.as_ref().map(|(operation, _)| *operation),
        operation_step: under_way.as_ref().and_then(|(_, state)| rebase_step(state)),
        conflicts,
        remotes,
        unmerged,
        files: files.into_iter().map(FileView::from).collect(),
        total_files,
        added,
        removed,
        commits: commits.into_iter().map(CommitView::from).collect(),
    }))
}

/// `rebase`, `merge` or `cherry-pick` while one is under way.
pub fn operation_in_progress(checkout: &str, deadline: Instant) -> Option<&'static str> {
    find_operation(checkout, deadline).map(|(operation, _)| operation)
}

/// The operation under way and where Git keeps its state. Asked of Git, since
/// these live under `.git/worktrees/<name>` in a linked worktree, where `.git`
/// is a file. A rebase comes first: stopped on a commit, it also has the head
/// file of the pick or merge it was replaying.
fn find_operation(checkout: &str, deadline: Instant) -> Option<(&'static str, PathBuf)> {
    let paths = git::text(
        checkout,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "rebase-merge",
            "--git-path",
            "rebase-apply",
            "--git-path",
            "MERGE_HEAD",
            "--git-path",
            "CHERRY_PICK_HEAD",
        ],
        "look for a rebase or merge",
        deadline,
    )
    .ok()?;
    paths
        .lines()
        .zip(["rebase", "rebase", "merge", "cherry-pick"])
        .find(|(path, _)| Path::new(path).exists())
        .map(|(path, operation)| (operation, PathBuf::from(path)))
}

/// A rebase's step and total from its state folder: `msgnum` and `end` for the
/// merge backend, `next` and `last` for the apply one. `None` for anything else.
fn rebase_step(state: &Path) -> Option<(u32, u32)> {
    let number = |name: &str| fs::read_to_string(state.join(name)).ok()?.trim().parse::<u32>().ok();
    number("msgnum")
        .zip(number("end"))
        .or_else(|| number("next").zip(number("last")))
}

/// A commit's full name, as the webview sends it back: 40 lowercase hex
/// digits, or 64 in a SHA-256 repository, so Git cannot take it for an
/// option, a range, or a ref.
fn commit_name(sha: &str) -> Result<&str, Error> {
    let valid = matches!(sha.len(), 40 | 64)
        && sha
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    valid
        .then_some(sha)
        .ok_or_else(|| Error::InvalidCommit(sha.into()))
}

/// What `git show` compares a commit with: a merge with its first parent,
/// a root commit with the empty tree.
const SHOW: [&str; 4] = ["show", "--format=", "-M", "--diff-merges=first-parent"];

/// The message of `sha` in the checkout at `checkout` and the files it
/// changed, with their counts.
pub fn read_commit(checkout: &str, sha: &str) -> Result<CommitFilesView, Error> {
    let sha = commit_name(sha)?;
    let deadline = Instant::now() + DEADLINE;
    let message = git::text(
        checkout,
        &["show", "--no-patch", "--format=%B", sha],
        "read the commit's message",
        deadline,
    )?;
    let mut files = parse::name_status(&git::text(
        checkout,
        &[&SHOW[..], &["-z", "--name-status", sha]].concat(),
        "read the commit's files",
        deadline,
    )?);
    // Counts are a nicety: a failure keeps the files without them.
    if let Ok(numstat) = git::text(
        checkout,
        &[&SHOW[..], &["-z", "--numstat", sha]].concat(),
        "count the commit's lines",
        deadline,
    ) {
        parse::apply_numstat(&mut files, &numstat);
    }
    let total_files = files.len();
    files.truncate(MAX_COMMIT_FILES);
    Ok(CommitFilesView {
        message,
        files: files.into_iter().map(FileView::from).collect(),
        total_files,
    })
}

/// The first `count` commits after `since`, newest first, as far as HEAD: what
/// one queued prompt committed, however many came after it.
pub fn read_commits_after(checkout: &str, since: &str, count: usize) -> Result<Vec<CommitView>, Error> {
    let since = commit_name(since)?;
    let range = format!("{since}..HEAD");
    let log = git::text(
        checkout,
        &["log", "-z", LOG_FORMAT, &range],
        "read the commits",
        Instant::now() + DEADLINE,
    )?;
    let commits = parse::log(&log);
    let later = commits.len().saturating_sub(count);
    Ok(commits.into_iter().skip(later).map(CommitView::from).collect())
}

/// Which way commits would move between a branch and its upstream.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Outgoing,
    Incoming,
}

/// The commits `git push` (`Outgoing`) or `git pull` (`Incoming`) would move,
/// newest first, as far as the last fetch knows.
pub fn read_moving(checkout: &str, direction: Direction) -> Result<Vec<CommitView>, Error> {
    let range = match direction {
        Direction::Outgoing => "@{upstream}..HEAD",
        Direction::Incoming => "HEAD..@{upstream}",
    };
    let limit = format!("--max-count={MAX_MOVING}");
    let log = git::text(
        checkout,
        &["log", &limit, "-z", LOG_FORMAT, range],
        "read the commits that would move",
        Instant::now() + DEADLINE,
    )?;
    Ok(parse::log(&log).into_iter().map(CommitView::from).collect())
}

/// The remote's default branch as last fetched: what `origin/HEAD` names,
/// else `origin/main` or `origin/master`, whichever exists.
pub fn default_branch(checkout: &str, deadline: Instant) -> Option<String> {
    if let Ok(head) = git::text(
        checkout,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
        "find the default branch",
        deadline,
    ) {
        return Some(head);
    }
    ["origin/main", "origin/master"]
        .into_iter()
        .find_map(|base| {
            let reference = format!("refs/remotes/{base}");
            git::text(
                checkout,
                &["rev-parse", "--verify", "--quiet", &reference],
                "find the default branch",
                deadline,
            )
            .ok()
            .map(|_| base.to_owned())
        })
}

/// Directories one count request may ask about, so the webview cannot queue
/// an unbounded number of Git processes.
pub const MAX_COUNTED: usize = 64;

/// How many files each directory's checkout has changed, untracked ones
/// included, as `git status` lists them: the sidebar's per-workspace count.
/// `None` for a directory outside Git or whose read failed, so one broken
/// checkout does not blank the others.
pub fn count_changes(directories: &[String]) -> Vec<Option<usize>> {
    directories
        .iter()
        .take(MAX_COUNTED)
        .map(|directory| count_in(directory, Instant::now() + DEADLINE))
        .collect()
}

/// How many files the checkout `directory` sits in has changed, untracked
/// ones included; `None` outside Git or when the read failed.
pub fn count_in(directory: &str, deadline: Instant) -> Option<usize> {
    git::text(
        directory,
        &["status", "--porcelain", "--untracked-files=normal", "-z"],
        "count working tree changes",
        deadline,
    )
    .ok()
    .map(|status| parse::count_porcelain(&status))
}

/// A regular file's text: not through a symlink, at most 1 MiB, UTF-8,
/// and with no NUL early on, which marks a binary.
fn read_text(path: &Path) -> Option<String> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_TEXT_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(MAX_TEXT_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_TEXT_BYTES || bytes.iter().take(8000).any(|&b| b == 0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// `path` is relative to `checkout`, as Git status lists it. The webview
/// sends it back, so a path that could leave the checkout is refused.
/// With `commit`, the file's change in that commit; else its uncommitted one.
pub fn read_diff(
    checkout: &str,
    path: &str,
    untracked: bool,
    commit: Option<&str>,
) -> Result<FileDiff, Error> {
    if !Path::new(path)
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(Error::OutsideCheckout(path.into()));
    }
    let commit = commit.map(commit_name).transpose()?;
    if untracked && commit.is_none() {
        let text = read_text(&Path::new(checkout).join(path)).ok_or(Error::NotText)?;
        return Ok(FileDiff::Untracked { text });
    }
    let args = match commit {
        Some(sha) => [&SHOW[..], &["--no-color", "--no-ext-diff", sha, "--", path]].concat(),
        None => vec![
            "diff",
            "--no-color",
            "--no-ext-diff",
            "-M",
            "HEAD",
            "--",
            path,
        ],
    };
    let bytes = git::run(
        checkout,
        &args,
        "read the diff",
        Instant::now() + DEADLINE,
        MAX_DIFF_BYTES,
    )
    .map_err(|error| match error {
        git::Error::TooLarge { .. } => Error::TooLarge,
        error => error.into(),
    })?;
    Ok(FileDiff::Patch {
        text: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
