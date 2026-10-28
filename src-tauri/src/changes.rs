//! The Changes panel's reads, through herdr-gpui's `herdr-vcs`: the checkout
//! a directory sits in with its files and commits, and one file's diff. Every
//! read runs Git on Tauri's blocking pool under a deadline and contacts no
//! remote; nothing here writes.

use herdr_vcs::{
    changes::{self, Checkout, Commit, FileChange},
    host::Session,
};
use serde::Serialize;
use std::{
    path::{Component, Path},
    time::{Duration, Instant},
};

/// How long one read may take before Git is stopped.
const DEADLINE: Duration = Duration::from_secs(5);
/// Diff bytes kept for one file; a larger diff is refused, not cut.
pub const MAX_DIFF_BYTES: usize = 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Vcs(#[from] herdr_vcs::Error),
    #[error("the diff is larger than {} KiB", MAX_DIFF_BYTES / 1024)]
    TooLarge,
    #[error("{0} is not a path inside the checkout")]
    OutsideCheckout(String),
    #[error("the file is binary, too large, or a symlink")]
    NotText,
    #[error("the Git worker stopped")]
    Worker(#[source] tauri::Error),
}

#[derive(Debug, Serialize)]
pub struct CheckoutView {
    path: String,
    branch: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
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
            short: commit.short().to_owned(),
            sha: commit.sha,
            subject: commit.subject,
            author: commit.author,
            time: commit.time,
        }
    }
}

impl From<Checkout> for CheckoutView {
    fn from(checkout: Checkout) -> Self {
        let (added, removed) = checkout.lines();
        Self {
            unmerged: checkout.unmerged.map(|unmerged| (unmerged.base, unmerged.count)),
            path: checkout.path,
            branch: checkout.branch,
            upstream: checkout.upstream,
            ahead: checkout.ahead,
            behind: checkout.behind,
            files: checkout.files.into_iter().map(FileView::from).collect(),
            total_files: checkout.total_files,
            added,
            removed,
            commits: checkout.commits.into_iter().map(CommitView::from).collect(),
        }
    }
}

/// One file's change: a unified diff, or an untracked file's whole text.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FileDiff {
    Patch { text: String },
    Untracked { text: String },
}

fn never() -> bool {
    false
}

/// `None` when `directory` is outside Git, which the panel shows as an
/// empty state rather than an error.
pub fn read_checkout(directory: &str) -> Result<Option<CheckoutView>, Error> {
    let deadline = Instant::now() + DEADLINE;
    let session = &mut Session::local();
    let Ok(located) = changes::locate(session, directory, deadline, &never) else {
        return Ok(None);
    };
    Ok(Some(changes::read(session, located, deadline, &never)?.into()))
}

/// `path` is relative to `checkout`, as Git status lists it. The webview
/// sends it back, so a path that could leave the checkout is refused.
pub fn read_diff(checkout: &str, path: &str, untracked: bool) -> Result<FileDiff, Error> {
    if !Path::new(path)
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(Error::OutsideCheckout(path.into()));
    }
    let deadline = Instant::now() + DEADLINE;
    let session = &mut Session::local();
    if untracked {
        let full = Path::new(checkout).join(path);
        let text = session
            .read_text(&full.to_string_lossy(), deadline, &never)?
            .ok_or(Error::NotText)?;
        return Ok(FileDiff::Untracked { text });
    }
    // One byte past the cap tells a diff that fits from one that was cut.
    let bytes = session.git_bytes(
        checkout,
        &["diff", "--no-color", "--no-ext-diff", "-M", "HEAD", "--", path],
        "read the diff",
        deadline,
        &never,
        MAX_DIFF_BYTES + 1,
    )?;
    if bytes.len() > MAX_DIFF_BYTES {
        return Err(Error::TooLarge);
    }
    Ok(FileDiff::Patch {
        text: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
