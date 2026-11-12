//! The branch list's two writes: switching the checkout to another local
//! branch, and deleting a local branch already merged into the default one.
//! Both take the checkout's one-operation claim, as a sync does, and run Git
//! through [`git::supervised`].
//!
//! Switching is refused unless the tree is clean, untracked files included,
//! and no rebase or merge is under way: every agent in the checkout works on
//! that tree, and Git would carry their uncommitted changes across or stop
//! halfway. Nothing is stashed to make room.
//!
//! Deleting is `git branch -d`, never `-D`, so Git refuses a branch whose
//! commits it would lose. The branch must also still be merged into the
//! default branch and checked out nowhere, read again at the click.

use crate::{
    changes::{self, branches},
    git,
    herdr::Target,
    sync::{self, Outcome, Reason},
};
use std::time::{Duration, Instant};

/// How long the reads before a write may take.
const CHECKS: Duration = Duration::from_secs(5);

/// `name` is a local branch: it cannot pass for an option, and
/// `refs/heads/<name>` exists.
fn local_branch(root: &str, name: &str, deadline: Instant) -> Result<(), Outcome> {
    let reference = format!("refs/heads/{name}");
    let plain = !name.is_empty() && !name.starts_with('-') && !name.chars().any(char::is_control);
    let exists = plain
        && git::text(root, &["show-ref", "--verify", "--quiet", &reference], "find the branch", deadline).is_ok();
    if exists {
        Ok(())
    } else {
        Err(Outcome::other(format!("{name} is not a local branch here.")))
    }
}

/// Moves the checkout from `shown`, the branch the panel showed, to `to`.
pub fn switch_branch(running: &sync::Running, checkout: &str, to: &str, shown: Option<&str>) -> Outcome {
    let checks = Instant::now() + CHECKS;
    let (root, _claim) = match sync::claim_checkout(running, checkout, checks) {
        Ok(claimed) => claimed,
        Err(refused) => return refused,
    };
    let current = match sync::current_branch(&root, shown, checks) {
        Ok(current) => current,
        Err(refused) => return refused,
    };
    if current == to {
        return Outcome::other(format!("The checkout is on {to} already."));
    }
    if let Err(refused) = local_branch(&root, to, checks) {
        return refused;
    }
    match changes::read_status(&Target::Local, &root, checks) {
        Ok(status) if status.files.is_empty() => {}
        Ok(status) => {
            let count = status.files.len();
            let files = if count == 1 { "file has" } else { "files have" };
            return Outcome::other(format!(
                "{count} {files} uncommitted changes, so the checkout stayed on {current}."
            ));
        }
        Err(error) => return Outcome::other(error.to_string()),
    }
    let args = ["switch", "--no-guess", "--no-progress", to];
    match git::supervised(&root, &args, "switch branch", Instant::now() + sync::LIMIT) {
        Ok(done) if done.success => Outcome::Done,
        Ok(done) => Outcome::failed(Reason::Other, format!("Git did not switch to {to}."), done.stderr),
        Err(error) => sync::timed_out(error),
    }
}

/// Deletes the local branch `name` if it is merged into the default branch,
/// is not HEAD's and is checked out in no worktree.
pub fn delete_branch(running: &sync::Running, checkout: &str, name: &str) -> Outcome {
    let checks = Instant::now() + CHECKS;
    let (root, _claim) = match sync::claim_checkout(running, checkout, checks) {
        Ok(claimed) => claimed,
        Err(refused) => return refused,
    };
    if let Err(refused) = local_branch(&root, name, checks) {
        return refused;
    }
    let Some(base) = branches::merge_base(&Target::Local, &root, checks) else {
        return Outcome::other("No default branch to check it against, so nothing was deleted.");
    };
    let merged = match branches::local_branches(&Target::Local, &root, Some(&base), checks) {
        Ok(merged) => merged,
        Err(error) => return Outcome::other(error.to_string()),
    };
    let checked_out = merged.iter().find(|branch| branch.name == name).and_then(|branch| branch.worktree.as_ref());
    if let Some(worktree) = checked_out {
        return Outcome::other(format!("{name} is checked out in {worktree}, so it was kept."));
    }
    if !branches::deletable(&merged, &base).iter().any(|branch| branch == name) {
        return Outcome::other(format!("{name} is not merged into {base}, so it was kept."));
    }
    let args = ["branch", "-d", "--", name];
    match git::supervised(&root, &args, "delete the branch", Instant::now() + sync::LIMIT) {
        Ok(done) if done.success => Outcome::Done,
        Ok(done) => Outcome::failed(Reason::Other, format!("Git kept {name}."), done.stderr),
        Err(error) => sync::timed_out(error),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
