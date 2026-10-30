//! Landing a finished worktree: run the repo's check, rebase its branch onto
//! main, fast-forward main in the main checkout, then remove the worktree and
//! delete the branch. It stops at the first failure and says what it left.
//!
//! This module never forces, resets, stashes or pushes. `git rebase` and
//! `git merge` say so on their command lines, since the user's config can turn
//! autostash and friends on, and conflicts are aborted, not resolved.
//!
//! The webview confirms a [`Target`], and every run reads the repo again and
//! refuses if the worktree is no longer that target, because the card's view
//! is up to 10 s old and another agent may be at work. One land runs per repo,
//! across windows too: Stable, Edge and a dev build are separate processes, so
//! the claim is a file lock in Git's common directory, not a set in memory.

use crate::{
    changes,
    git::{self, Finished},
    worktrees,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, TryLockError},
    io::ErrorKind,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

/// How long a repo's check may run: a Rust build from nothing is minutes.
const CHECK_LIMIT: Duration = Duration::from_secs(30 * 60);
/// How long one Git step may take, hooks included.
const STEP_LIMIT: Duration = Duration::from_secs(120);
/// How long the reads before a step may take.
const READS: Duration = Duration::from_secs(5);
/// The explicit check of a repo, in the worktree being landed.
const CONFIG: &str = ".herdr/land.json";

/// What the user confirmed: this branch at this commit, with this check.
#[derive(Debug, Clone, Deserialize)]
pub struct Target {
    pub worktree: String,
    pub branch: String,
    pub head: String,
    pub check: Option<String>,
}

/// The step a land is on, or stopped at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Step {
    /// Before anything ran: a refusal, so nothing changed.
    Start,
    Check,
    Rebase,
    FastForward,
    Remove,
    DeleteBranch,
    Confirm,
}

/// What the confirmation shows, or why it would be pointless to ask.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Plan {
    Ready {
        branch: String,
        head: String,
        main: String,
        commits: u32,
        /// The command that will run; `None` when the repo has no check.
        check: Option<String>,
    },
    Refused {
        message: String,
    },
}

/// A failure is an answer, not an error: `message` says why it stopped,
/// `left` what state things are in, and `details` is what was printed.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Outcome {
    /// The check passed, or there is none.
    Passed,
    /// On main, with the worktree and branch gone.
    Landed { main: String, commits: u32 },
    Failed {
        step: Step,
        message: String,
        left: String,
        details: String,
    },
}

fn failed(step: Step, message: impl Into<String>, left: impl Into<String>, details: String) -> Outcome {
    Outcome::Failed {
        step,
        message: message.into(),
        left: left.into(),
        details,
    }
}

fn refused(message: impl Into<String>) -> Outcome {
    failed(Step::Start, message, "Nothing changed.", String::new())
}

/// The repo as read now, for a worktree that may land.
#[derive(Debug)]
struct Repo {
    worktree: String,
    main_checkout: String,
    main: String,
    branch: String,
    head: String,
    commits: u32,
}

impl Repo {
    fn reference(branch: &str) -> String {
        format!("refs/heads/{branch}")
    }

    /// The state before any step has run.
    fn untouched(&self) -> String {
        format!(
            "{} is as it was, at {}. {} did not move.",
            self.branch,
            short(&self.head),
            self.main
        )
    }

    fn rebased(&self) -> String {
        format!(
            "{} is rebased onto {} (it was at {}). {} did not move and the worktree is still there.",
            self.branch,
            self.main,
            short(&self.head),
            self.main
        )
    }
}

fn short(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

/// The repo if the worktree can land, else why not. Everything here is checked
/// again right before work starts, not trusted from the confirmation.
fn read(worktree: &str, deadline: Instant) -> Result<Repo, String> {
    let listing = git::text(
        worktree,
        &["worktree", "list", "--porcelain", "-z"],
        "list worktrees",
        deadline,
    )
    .map_err(|_| format!("{worktree} is not a Git worktree any more."))?;
    let main_checkout = worktrees::main_checkout(&listing)
        .ok_or("Git did not name a main checkout.")?
        .to_owned();
    let entry = worktrees::parse(&listing)
        .into_iter()
        .find(|entry| entry.path == worktree)
        .ok_or("Only a linked worktree can land, not the main checkout.")?;
    // First: a rebase detaches HEAD, and that is not what to tell the user.
    if let Some(operation) = changes::operation_in_progress(worktree, deadline) {
        return Err(format!("A {operation} is in progress in the worktree."));
    }
    let branch = entry
        .branch
        .ok_or("Its HEAD is detached, so there is no branch to land.")?;
    if entry.locked {
        return Err("The worktree is locked, and Land never forces its removal.".to_owned());
    }
    let main = worktrees::main_branch(worktree, deadline).ok_or("The repo has no main branch to land on.")?;
    ensure_on_main(&main_checkout, &main, deadline)?;
    if let Some(operation) = changes::operation_in_progress(&main_checkout, deadline) {
        return Err(format!("A {operation} is in progress in the main checkout."));
    }
    match changes::count_in(worktree, deadline) {
        Some(0) => {}
        Some(1) => return Err("The worktree has 1 uncommitted file.".to_owned()),
        Some(count) => return Err(format!("The worktree has {count} uncommitted files.")),
        None => return Err("Could not read the worktree's uncommitted files.".to_owned()),
    }
    let commits = ahead(worktree, &main, &entry.head, deadline)?;
    if commits == 0 {
        return Err(format!("{branch} has no commits {main} lacks."));
    }
    Ok(Repo {
        worktree: entry.path,
        main_checkout,
        main,
        branch,
        head: entry.head,
        commits,
    })
}

/// Read before every write to it: the main checkout may be someone else's.
fn ensure_on_main(main_checkout: &str, main: &str, deadline: Instant) -> Result<(), String> {
    let current = git::text(
        main_checkout,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        "read the main checkout's branch",
        deadline,
    );
    match current {
        Ok(current) if current == main => Ok(()),
        Ok(current) => Err(format!("The main checkout is on {current}, not {main}.")),
        Err(_) => Err(format!("The main checkout's HEAD is detached, not on {main}.")),
    }
}

fn ahead(worktree: &str, main: &str, head: &str, deadline: Instant) -> Result<u32, String> {
    let range = format!("{}..{head}", Repo::reference(main));
    git::text(worktree, &["rev-list", "--count", &range], "count commits", deadline)
        .ok()
        .and_then(|count| count.parse().ok())
        .ok_or_else(|| format!("Could not count the commits {main} lacks."))
}

fn head_of(directory: &str, reference: &str, deadline: Instant) -> Option<String> {
    git::text(
        directory,
        &["rev-parse", "--verify", "--quiet", reference],
        "read a commit",
        deadline,
    )
    .ok()
}

/// What the confirmation shows.
pub fn plan(worktree: &str) -> Plan {
    let repo = match read(worktree, Instant::now() + READS) {
        Ok(repo) => repo,
        Err(message) => return Plan::Refused { message },
    };
    match find_check(Path::new(&repo.worktree)) {
        Ok(check) => Plan::Ready {
            branch: repo.branch,
            head: repo.head,
            main: repo.main,
            commits: repo.commits,
            check,
        },
        Err(message) => Plan::Refused { message },
    }
}

/// The repo if `target` is still what it says, else the refusal.
fn confirmed(target: &Target, deadline: Instant) -> Result<Repo, Outcome> {
    let repo = read(&target.worktree, deadline).map_err(refused)?;
    if repo.branch != target.branch {
        return Err(refused(format!(
            "The worktree moved to {} after you confirmed.",
            repo.branch
        )));
    }
    if repo.head != target.head {
        return Err(refused(format!(
            "{} moved to {} after you confirmed.",
            repo.branch,
            short(&repo.head)
        )));
    }
    Ok(repo)
}

/// Step 3. `Passed` when the repo has no check, which the confirmation said.
pub fn check(target: &Target) -> Outcome {
    let reads = Instant::now() + READS;
    let _claim = match claim(&target.worktree, reads) {
        Ok(claim) => claim,
        Err(refusal) => return refusal,
    };
    let repo = match confirmed(target, reads) {
        Ok(repo) => repo,
        Err(refusal) => return refusal,
    };
    match find_check(Path::new(&repo.worktree)) {
        Ok(found) if found == target.check => match found {
            Some(command) => run_check(&repo, &command, CHECK_LIMIT),
            None => Outcome::Passed,
        },
        Ok(_) => refused("The repo's check changed after you confirmed."),
        Err(message) => refused(message),
    }
}

fn run_check(repo: &Repo, command: &str, limit: Duration) -> Outcome {
    let ran = git::shell(&repo.worktree, command, "run the check", Instant::now() + limit);
    match ran {
        Ok(done) if done.success => Outcome::Passed,
        Ok(done) => failed(
            Step::Check,
            format!("The check failed: {command}"),
            repo.untouched(),
            printed(&done),
        ),
        Err(git::Error::Timeout { .. }) => failed(
            Step::Check,
            format!("The check was stopped after {} min: {command}", limit.as_secs() / 60),
            repo.untouched(),
            String::new(),
        ),
        Err(error) => failed(Step::Check, error.to_string(), repo.untouched(), String::new()),
    }
}

/// Steps 4 to 7, one lock held across them all. `progress` hears each as it starts.
pub fn finish(target: &Target, progress: impl Fn(Step)) -> Outcome {
    finish_within(target, progress, STEP_LIMIT)
}

fn finish_within(target: &Target, progress: impl Fn(Step), limit: Duration) -> Outcome {
    let reads = Instant::now() + READS;
    let _claim = match claim(&target.worktree, reads) {
        Ok(claim) => claim,
        Err(refusal) => return refusal,
    };
    let repo = match confirmed(target, reads) {
        Ok(repo) => repo,
        Err(refusal) => return refusal,
    };
    let steps = || {
        progress(Step::Rebase);
        rebase(&repo, limit)?;
        let reads = Instant::now() + READS;
        // A commit main already has is dropped by the rebase, so count again.
        let landed = head_of(&repo.worktree, "HEAD", reads).unwrap_or_else(|| repo.head.clone());
        let commits = ahead(&repo.worktree, &repo.main, &landed, reads).unwrap_or(repo.commits);
        progress(Step::FastForward);
        fast_forward(&repo, limit)?;
        progress(Step::Remove);
        remove(&repo, limit)?;
        progress(Step::DeleteBranch);
        delete_branch(&repo, limit)?;
        progress(Step::Confirm);
        confirm_gone(&repo, &landed)?;
        Ok(Outcome::Landed {
            main: repo.main.clone(),
            commits,
        })
    };
    steps().unwrap_or_else(|stopped: Outcome| stopped)
}

/// Rebases in the worktree. Any failure aborts, so a conflict is never left
/// for the app to resolve, and the branch is checked to be back where it was.
fn rebase(repo: &Repo, limit: Duration) -> Result<(), Outcome> {
    let onto = Repo::reference(&repo.main);
    let args = ["rebase", "--no-autostash", "--no-update-refs", &onto];
    let ran = git::supervised(&repo.worktree, &args, "rebase", Instant::now() + limit);
    let (reason, details) = match ran {
        Ok(done) if done.success => return Ok(()),
        Ok(done) if done.stdout.contains("CONFLICT") || done.stderr.contains("CONFLICT") => (
            format!("Rebasing onto {} hit a conflict, so it was aborted.", repo.main),
            printed(&done),
        ),
        Ok(done) => ("The rebase failed.".to_owned(), printed(&done)),
        Err(error) => (error.to_string(), String::new()),
    };
    let aborted = abort_rebase(repo, limit);
    let reads = Instant::now() + READS;
    let at = head_of(&repo.worktree, &Repo::reference(&repo.branch), reads);
    let left = if aborted && at.as_deref() == Some(&repo.head) {
        format!("{} The worktree is still there.", repo.untouched())
    } else {
        format!(
            "The rebase could not be undone: look at {} before anything else. {} did not move, and {} was at {}.",
            repo.worktree,
            repo.main,
            repo.branch,
            short(&repo.head)
        )
    };
    Err(failed(Step::Rebase, reason, left, details))
}

/// Whether no rebase is left in progress.
fn abort_rebase(repo: &Repo, limit: Duration) -> bool {
    let reads = Instant::now() + READS;
    if changes::operation_in_progress(&repo.worktree, reads).is_some() {
        let _ = git::supervised(
            &repo.worktree,
            &["rebase", "--abort"],
            "abort the rebase",
            Instant::now() + limit,
        );
    }
    changes::operation_in_progress(&repo.worktree, Instant::now() + READS).is_none()
}

/// `--no-autostash` overrules `merge.autoStash`, which would otherwise stash
/// the main checkout's uncommitted work even under `--ff-only`.
fn fast_forward(repo: &Repo, limit: Duration) -> Result<(), Outcome> {
    let stop = |message: String, details: String| failed(Step::FastForward, message, repo.rebased(), details);
    ensure_on_main(&repo.main_checkout, &repo.main, Instant::now() + READS)
        .map_err(|message| stop(message, String::new()))?;
    let branch = Repo::reference(&repo.branch);
    let args = ["merge", "--ff-only", "--no-autostash", "--no-edit", &branch];
    let ran = git::supervised(&repo.main_checkout, &args, "fast-forward", Instant::now() + limit);
    match ran {
        Ok(done) if done.success => Ok(()),
        Ok(done) if done.stderr.contains("would be overwritten by merge") => Err(stop(
            format!(
                "Uncommitted changes in the main checkout touch the same files, so {} was not moved.",
                repo.main
            ),
            printed(&done),
        )),
        Ok(done) if done.stderr.contains("Not possible to fast-forward") => Err(stop(
            format!("{} moved during the land, so it cannot fast-forward.", repo.main),
            printed(&done),
        )),
        Ok(done) => Err(stop("The fast-forward failed.".to_owned(), printed(&done))),
        Err(error) => Err(stop(error.to_string(), String::new())),
    }
}

fn remove(repo: &Repo, limit: Duration) -> Result<(), Outcome> {
    let args = ["worktree", "remove", &repo.worktree];
    let ran = git::supervised(&repo.main_checkout, &args, "remove the worktree", Instant::now() + limit);
    let (message, details) = match ran {
        Ok(done) if done.success => return Ok(()),
        Ok(done) => ("Git would not remove the worktree.".to_owned(), printed(&done)),
        Err(error) => (error.to_string(), String::new()),
    };
    let left = format!(
        "{} has the commits. The worktree and {} are still there.",
        repo.main, repo.branch
    );
    Err(failed(Step::Remove, message, left, details))
}

/// `-d` compares with the branch's upstream when it has one, so a published
/// branch is kept here: its rebased commits are not on the remote.
fn delete_branch(repo: &Repo, limit: Duration) -> Result<(), Outcome> {
    let args = ["branch", "-d", &repo.branch];
    let ran = git::supervised(&repo.main_checkout, &args, "delete the branch", Instant::now() + limit);
    let (message, details) = match ran {
        Ok(done) if done.success => return Ok(()),
        Ok(done) => (format!("Git would not delete {}.", repo.branch), printed(&done)),
        Err(error) => (error.to_string(), String::new()),
    };
    let left = format!(
        "{} has the commits and the worktree is gone. {} is still there.",
        repo.main, repo.branch
    );
    Err(failed(Step::DeleteBranch, message, left, details))
}

/// Git said it did all this; see that it is so, by asking again.
fn confirm_gone(repo: &Repo, landed: &str) -> Result<(), Outcome> {
    let reads = Instant::now() + READS;
    let listing = git::text(
        &repo.main_checkout,
        &["worktree", "list", "--porcelain", "-z"],
        "list worktrees",
        reads,
    )
    .unwrap_or_default();
    let listed = worktrees::parse(&listing).iter().any(|entry| entry.path == repo.worktree);
    let on_main = git::text(
        &repo.main_checkout,
        &["merge-base", "--is-ancestor", landed, &Repo::reference(&repo.main)],
        "look for the commits",
        reads,
    )
    .is_ok();
    let branch = head_of(&repo.main_checkout, &Repo::reference(&repo.branch), reads);
    if !listed && !Path::new(&repo.worktree).exists() && branch.is_none() && on_main {
        return Ok(());
    }
    Err(failed(
        Step::Confirm,
        "Git reported success, but the result is not what it should be.",
        format!(
            "Worktree still listed or on disk: {}. Branch {} still there: {}. Commits on {}: {on_main}.",
            listed || Path::new(&repo.worktree).exists(),
            repo.branch,
            branch.is_some(),
            repo.main
        ),
        String::new(),
    ))
}

/// Both streams, the error last, where a reader looks first.
fn printed(done: &Finished) -> String {
    [done.stdout.as_str(), done.stderr.as_str()]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Holds a repo's land until it is dropped; the OS drops it with the process,
/// even a crashed one.
struct Claim(#[allow(dead_code)] File);

/// `Err` is the refusal when another land holds the repo, in any window.
fn claim(worktree: &str, deadline: Instant) -> Result<Claim, Outcome> {
    let common = git::text(
        worktree,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        "find the repo",
        deadline,
    )
    .map_err(|error| refused(error.to_string()))?;
    let file = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(PathBuf::from(common).join("herdr-land.lock"))
        .map_err(|error| refused(format!("Could not take the land lock: {error}")))?;
    match file.try_lock() {
        Ok(()) => Ok(Claim(file)),
        Err(TryLockError::WouldBlock) => Err(refused("Another land is running in this repo.")),
        Err(TryLockError::Error(error)) => Err(refused(format!("Could not take the land lock: {error}"))),
    }
}

/// How the repo in `worktree` says it is checked, first match wins:
///
/// 1. `.herdr/land.json`, `{ "check": "<shell command>" }`, for any repo;
/// 2. a `check` script in `package.json`, run with the lockfile's manager;
/// 3. a `check:` target in a Makefile.
///
/// `Ok(None)` means it has none, which the confirmation says. Read from the
/// worktree, so a branch can change its own check, and the confirmation shows
/// exactly what will run. A `.herdr/land.json` that cannot be used refuses
/// rather than falling through to a check nobody asked for.
fn find_check(worktree: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(worktree.join(CONFIG)) {
        Ok(text) => configured_check(&text).map(Some),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            Ok(package_check(worktree).or_else(|| make_check(worktree)))
        }
        Err(error) => Err(format!("Could not read {CONFIG}: {error}")),
    }
}

fn configured_check(text: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Config {
        check: String,
    }
    let config: Config = serde_json::from_str(text).map_err(|error| format!("{CONFIG} is not usable: {error}"))?;
    let check = config.check.trim();
    if check.is_empty() {
        return Err(format!("{CONFIG} has an empty check."));
    }
    Ok(check.to_owned())
}

fn package_check(worktree: &Path) -> Option<String> {
    let text = fs::read_to_string(worktree.join("package.json")).ok()?;
    let package: serde_json::Value = serde_json::from_str(&text).ok()?;
    package.get("scripts")?.get("check")?.as_str()?;
    let manager = [
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lock", "bun"),
        ("bun.lockb", "bun"),
    ]
    .into_iter()
    .find(|(lockfile, _)| worktree.join(lockfile).exists())
    .map_or("npm", |(_, manager)| manager);
    Some(format!("{manager} run check"))
}

fn make_check(worktree: &Path) -> Option<String> {
    ["GNUmakefile", "makefile", "Makefile"]
        .iter()
        .filter_map(|name| fs::read_to_string(worktree.join(name)).ok())
        .any(|text| text.lines().any(|line| line.starts_with("check:")))
        .then(|| "make check".to_owned())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
