//! The commit row's three writes: checking a commit out on a detached HEAD,
//! starting a branch at it, and reverting it. Each takes the checkout's
//! one-operation claim, as a sync does, and runs Git through
//! [`git::supervised`].
//!
//! All three need a clean tree, untracked files included, and no rebase,
//! merge, cherry-pick or revert under way: every agent in the checkout works
//! on that tree, and nothing is stashed to make room. A revert that stops on a
//! conflict is left as Git leaves it, for the panel to show and a person to
//! finish; nothing here aborts or resolves it.

use crate::{
    changes, git,
    herdr::Target,
    sync::{self, Outcome, Reason},
};
use std::time::{Duration, Instant};

/// How long the reads before a write may take.
const CHECKS: Duration = Duration::from_secs(5);

/// Refuses unless nothing is under way and `git status` lists nothing.
fn clean_and_idle(root: &str, deadline: Instant) -> Result<(), Outcome> {
    if let Some(operation) = changes::operation_in_progress(root, deadline) {
        return Err(Outcome::other(format!(
            "A {operation} is in progress, so nothing ran."
        )));
    }
    match changes::read_status(&Target::Local, root, deadline) {
        Ok(status) if status.files.is_empty() => Ok(()),
        Ok(status) => {
            let count = status.files.len();
            let files = if count == 1 { "file has" } else { "files have" };
            Err(Outcome::other(format!(
                "{count} {files} uncommitted changes, so nothing ran."
            )))
        }
        Err(error) => Err(Outcome::other(error.to_string())),
    }
}

/// Claims the checkout, checks `sha` names a commit there and the tree is
/// clean, and hands back the root with the claim held.
fn prepare<'a>(
    running: &'a sync::Running,
    checkout: &str,
    sha: &str,
    checks: Instant,
) -> Result<(String, sync::Claim<'a>), Outcome> {
    let sha = changes::commit_name(sha).map_err(|error| Outcome::other(error.to_string()))?;
    let (root, claim) = sync::claim_checkout(running, checkout, checks)?;
    let object = format!("{sha}^{{commit}}");
    git::text(
        &root,
        &["rev-parse", "--verify", "--quiet", &object],
        "find the commit",
        checks,
    )
    .map_err(|_| Outcome::other("That commit is not in this repository."))?;
    clean_and_idle(&root, checks)?;
    Ok((root, claim))
}

fn finish(root: &str, args: &[&str], operation: &'static str, failed: String) -> Outcome {
    match git::supervised(root, args, operation, Instant::now() + sync::LIMIT) {
        Ok(done) if done.success => Outcome::Done,
        Ok(done) => Outcome::failed(Reason::Other, failed, done.stderr),
        Err(error) => sync::timed_out(error),
    }
}

/// Moves HEAD to `sha`, detached.
pub fn checkout_commit(running: &sync::Running, checkout: &str, sha: &str) -> Outcome {
    let (root, _claim) = match prepare(running, checkout, sha, Instant::now() + CHECKS) {
        Ok(prepared) => prepared,
        Err(refused) => return refused,
    };
    let args = ["switch", "--detach", "--no-progress", sha];
    finish(
        &root,
        &args,
        "check out the commit",
        "Git did not check the commit out.".into(),
    )
}

/// `name` would make a new branch: a valid name, not an option, and not one
/// that exists.
fn new_branch_name(root: &str, name: &str, deadline: Instant) -> Result<(), Outcome> {
    // `check-ref-format --branch` would read `@{-1}` as the previous branch.
    let plain = !name.is_empty()
        && !name.starts_with('-')
        && !name.contains("@{")
        && !name.chars().any(char::is_control);
    let valid = plain
        && git::text(
            root,
            &["check-ref-format", "--branch", name],
            "check the name",
            deadline,
        )
        .is_ok();
    if !valid {
        return Err(Outcome::other(format!(
            "{name} is not a valid branch name."
        )));
    }
    let reference = format!("refs/heads/{name}");
    if git::text(
        root,
        &["show-ref", "--verify", "--quiet", &reference],
        "find the branch",
        deadline,
    )
    .is_ok()
    {
        return Err(Outcome::other(format!(
            "A branch named {name} exists already."
        )));
    }
    Ok(())
}

/// Starts the branch `name` at `sha` and switches the checkout to it.
pub fn branch_from(running: &sync::Running, checkout: &str, sha: &str, name: &str) -> Outcome {
    let checks = Instant::now() + CHECKS;
    let (root, _claim) = match prepare(running, checkout, sha, checks) {
        Ok(prepared) => prepared,
        Err(refused) => return refused,
    };
    if let Err(refused) = new_branch_name(&root, name, checks) {
        return refused;
    }
    let args = ["switch", "--no-progress", "-c", name, sha];
    finish(
        &root,
        &args,
        "start the branch",
        format!("Git did not start {name}."),
    )
}

/// Whether `sha` has more than one parent.
fn is_merge(root: &str, sha: &str, deadline: Instant) -> Result<bool, Outcome> {
    let line = git::text(
        root,
        &["rev-list", "--parents", "--max-count=1", sha],
        "read the parents",
        deadline,
    )
    .map_err(|error| Outcome::other(error.to_string()))?;
    Ok(line.split_whitespace().count() > 2)
}

/// Adds a commit on `shown`, the branch the panel showed, that undoes `sha`.
/// A merge commit is refused, as Git would need to be told which parent to
/// keep; so is a commit that is not in the branch's history.
pub fn revert_commit(
    running: &sync::Running,
    checkout: &str,
    sha: &str,
    shown: Option<&str>,
) -> Outcome {
    let checks = Instant::now() + CHECKS;
    let (root, _claim) = match prepare(running, checkout, sha, checks) {
        Ok(prepared) => prepared,
        Err(refused) => return refused,
    };
    let branch = match sync::current_branch(&root, shown, checks) {
        Ok(branch) => branch,
        Err(refused) => return refused,
    };
    match is_merge(&root, sha, checks) {
        Ok(false) => {}
        Ok(true) => {
            return Outcome::other(
                "It is a merge commit, and reverting one means choosing which parent to keep. Revert it from a terminal.",
            );
        }
        Err(refused) => return refused,
    }
    let ancestor = git::text(
        &root,
        &["merge-base", "--is-ancestor", sha, "HEAD"],
        "check the history",
        checks,
    );
    if ancestor.is_err() {
        return Outcome::other(format!(
            "That commit is not in {branch}'s history, so there is nothing to revert."
        ));
    }
    match git::supervised(
        &root,
        &["revert", "--no-edit", sha],
        "revert the commit",
        Instant::now() + sync::LIMIT,
    ) {
        Ok(done) if done.success => Outcome::Done,
        Ok(done)
            if changes::operation_in_progress(&root, Instant::now() + CHECKS) == Some("revert") =>
        {
            Outcome::failed(
                Reason::Other,
                "The revert stopped on a conflict. Resolve it, or run git revert --abort, in a terminal.",
                done.stderr,
            )
        }
        Ok(done) => Outcome::failed(Reason::Other, "Git did not revert the commit.", done.stderr),
        Err(error) => sync::timed_out(error),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
