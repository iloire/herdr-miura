//! The Changes panel's network operations: fetch, push, publish and pull.
//! `changes.rs` promises it never writes or contacts a remote, so everything
//! that does is here, one operation per checkout at a time, under a limit
//! long enough for a network.
//!
//! This module never force-pushes, merges, rebases or stashes. `git pull`
//! says so on its command line, since the user's config can turn each of
//! those on, and a config that would make a plain push force is refused.

use crate::{changes, git};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    sync::{Mutex, PoisonError},
    time::{Duration, Instant},
};

/// How long one operation may take before Git is stopped.
const LIMIT: Duration = Duration::from_secs(60);
/// How long the local checks before it may take.
const CHECKS: Duration = Duration::from_secs(5);

/// The operation the panel asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Fetch,
    Push,
    Publish,
    Pull,
}

/// Why an operation did not happen, as far as the panel acts on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    /// The remote or a rule refused the push.
    Rejected,
    /// The branches have diverged, so a fast-forward is impossible.
    Diverged,
    /// Another operation is running in this checkout.
    Busy,
    Other,
}

/// A refused or failed operation is an answer, not an error: `message` says
/// what happened and `details` is what Git printed.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Outcome {
    Done,
    Failed {
        reason: Reason,
        message: String,
        details: String,
    },
}

impl Outcome {
    fn failed(reason: Reason, message: impl Into<String>, details: impl Into<String>) -> Self {
        Self::Failed {
            reason,
            message: message.into(),
            details: details.into(),
        }
    }

    fn other(message: impl Into<String>) -> Self {
        Self::failed(Reason::Other, message, "")
    }
}

/// The checkouts with an operation under way. A second one is refused, not
/// queued: it would act on what the first one changes.
#[derive(Default)]
pub struct Running(Mutex<HashSet<String>>);

impl Running {
    fn claim<'a>(&'a self, checkout: &str) -> Option<Claim<'a>> {
        let mut running = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        running.insert(checkout.to_owned()).then(|| Claim {
            running: self,
            checkout: checkout.to_owned(),
        })
    }
}

/// Holds a checkout until the operation ends, however it ends.
struct Claim<'a> {
    running: &'a Running,
    checkout: String,
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        let mut running = self.running.0.lock().unwrap_or_else(PoisonError::into_inner);
        running.remove(&self.checkout);
    }
}

pub fn run(running: &Running, checkout: &str, op: Op, branch: Option<&str>) -> Outcome {
    run_within(running, checkout, op, branch, LIMIT)
}

fn run_within(
    running: &Running,
    checkout: &str,
    op: Op,
    branch: Option<&str>,
    limit: Duration,
) -> Outcome {
    let checks = Instant::now() + CHECKS;
    // By its root, so two paths into one checkout are one checkout.
    let root = match git::text(
        checkout,
        &["rev-parse", "--path-format=absolute", "--show-toplevel"],
        "find the checkout",
        checks,
    ) {
        Ok(root) => root,
        Err(error) => return Outcome::other(error.to_string()),
    };
    let Some(_claim) = running.claim(&root) else {
        return Outcome::failed(
            Reason::Busy,
            "Another Git operation is still running in this checkout.",
            "",
        );
    };
    let deadline = || Instant::now() + limit;
    match op {
        Op::Fetch => fetch(&root, deadline()),
        Op::Pull => match current_branch(&root, branch, checks) {
            Ok(_) => pull(&root, deadline()),
            Err(refused) => refused,
        },
        Op::Push | Op::Publish => {
            let current = match current_branch(&root, branch, checks) {
                Ok(current) => current,
                Err(refused) => return refused,
            };
            if config_forces_pushes(&root, checks) {
                return Outcome::other(
                    "This repository's Git config makes a plain push force, so nothing was pushed.",
                );
            }
            if op == Op::Publish {
                publish(&root, &current, deadline())
            } else {
                push(&root, deadline())
            }
        }
    }
}

/// The branch to act on, read now: the panel's view is up to 5 s old, and an
/// agent may have moved the checkout or started a rebase since.
fn current_branch(root: &str, shown: Option<&str>, deadline: Instant) -> Result<String, Outcome> {
    let current = git::text(
        root,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        "read the branch",
        deadline,
    )
    .map_err(|_| Outcome::other("HEAD is detached, so there is no branch to sync."))?;
    if shown.is_some_and(|shown| shown != current) {
        return Err(Outcome::other(format!(
            "The checkout moved to {current}, so nothing ran."
        )));
    }
    if let Some(operation) = changes::operation_in_progress(root, deadline) {
        return Err(Outcome::other(format!(
            "A {operation} is in progress, so nothing ran."
        )));
    }
    Ok(current)
}

/// A `+` refspec under `remote.<name>.push`, or `remote.<name>.mirror`, makes
/// a plain `git push` overwrite the remote.
fn config_forces_pushes(root: &str, deadline: Instant) -> bool {
    // Exits 1 when no key matches, which is the usual case.
    git::text(
        root,
        &["config", "--get-regexp", r"^remote\..*\.(push|mirror)$"],
        "read the push config",
        deadline,
    )
    .is_ok_and(|config| forces_pushes(&config))
}

fn forces_pushes(config: &str) -> bool {
    config.lines().any(|line| {
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        if key.ends_with(".push") {
            value.starts_with('+')
        } else {
            !matches!(value.to_ascii_lowercase().as_str(), "false" | "no" | "off" | "0")
        }
    })
}

/// Leaves FETCH_HEAD alone, since an agent may be about to merge it, and
/// leaves repacking to Git's own runs: this happens behind everyone's back.
fn fetch(root: &str, deadline: Instant) -> Outcome {
    let args = ["fetch", "--no-write-fetch-head", "--no-auto-maintenance"];
    match git::supervised(root, &args, "fetch", deadline) {
        Ok(done) if done.success => Outcome::Done,
        Ok(done) => Outcome::failed(Reason::Other, "Fetch failed.", done.stderr),
        Err(error) => timed_out(error),
    }
}

fn push(root: &str, deadline: Instant) -> Outcome {
    match git::supervised(root, &["push", "--porcelain"], "push", deadline) {
        Ok(done) => pushed(&done),
        Err(error) => timed_out(error),
    }
}

fn publish(root: &str, branch: &str, deadline: Instant) -> Outcome {
    let args = ["push", "--porcelain", "-u", "origin", "--", branch];
    match git::supervised(root, &args, "publish the branch", deadline) {
        Ok(done) => pushed(&done),
        Err(error) => timed_out(error),
    }
}

fn pushed(done: &git::Finished) -> Outcome {
    if done.success {
        return Outcome::Done;
    }
    match rejection(&done.stdout) {
        Some(reason) => Outcome::failed(
            Reason::Rejected,
            format!("Push rejected: {reason}"),
            done.stderr.clone(),
        ),
        None => Outcome::failed(Reason::Other, "Push failed.", done.stderr.clone()),
    }
}

/// The summary of the first ref `push --porcelain` marks `!`, such as
/// `[rejected] (fetch first)`.
fn rejection(porcelain: &str) -> Option<&str> {
    porcelain
        .lines()
        .find_map(|line| line.strip_prefix("!\t"))
        .and_then(|line| line.split('\t').nth(1))
}

/// Only ever a fast-forward. `--no-rebase` and `--no-autostash` overrule
/// `pull.rebase`, `merge.autoStash` and `rebase.autoStash`: with those set a
/// bare `--ff-only` can stash uncommitted work that may be another agent's.
fn pull(root: &str, deadline: Instant) -> Outcome {
    let args = ["pull", "--ff-only", "--no-rebase", "--no-autostash"];
    match git::supervised(root, &args, "pull", deadline) {
        Ok(done) if done.success => Outcome::Done,
        Ok(done) => pull_failure(done.stderr),
        Err(error) => timed_out(error),
    }
}

fn pull_failure(stderr: String) -> Outcome {
    if stderr.contains("Not possible to fast-forward") {
        Outcome::failed(
            Reason::Diverged,
            "The branches have diverged, so nothing was pulled. Merge or rebase them yourself.",
            stderr,
        )
    } else if stderr.contains("would be overwritten by merge") {
        Outcome::failed(
            Reason::Other,
            "Incoming commits touch files with uncommitted changes, so nothing was pulled.",
            stderr,
        )
    } else {
        Outcome::failed(Reason::Other, "Pull failed.", stderr)
    }
}

fn timed_out(error: git::Error) -> Outcome {
    Outcome::other(match error {
        git::Error::Timeout { .. } => format!("Git was stopped after {} s.", LIMIT.as_secs()),
        error => error.to_string(),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
