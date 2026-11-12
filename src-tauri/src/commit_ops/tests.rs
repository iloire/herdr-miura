use super::*;
use std::{fs, path::Path, process::Command};

/// Runs Git in `dir`, failing the test if it fails.
fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(output.status.success(), "{args:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn commit(dir: &Path, file: &str, text: &str, message: &str) -> String {
    fs::write(dir.join(file), text).unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", message]);
    git(dir, &["rev-parse", "HEAD"])
}

/// A repo on `main` with three commits, returned oldest first. The app's
/// own revert reads the identity from the repo's config, as it would a person's.
fn repo() -> (tempfile::TempDir, [String; 3]) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    git(path, &["init", "-q", "-b", "main"]);
    git(path, &["config", "user.name", "t"]);
    git(path, &["config", "user.email", "t@t"]);
    git(path, &["config", "commit.gpgsign", "false"]);
    let first = commit(path, "a.txt", "one\n", "first");
    let second = commit(path, "b.txt", "two\n", "second");
    let third = commit(path, "a.txt", "one\nmore\n", "third");
    (dir, [first, second, third])
}

fn checkout(dir: &tempfile::TempDir) -> String {
    dir.path().to_string_lossy().into_owned()
}

fn head(dir: &tempfile::TempDir) -> String {
    git(dir.path(), &["rev-parse", "HEAD"])
}

fn failure(outcome: Outcome) -> String {
    match outcome {
        Outcome::Failed { message, .. } => message,
        Outcome::Done => panic!("expected a refusal"),
    }
}

#[test]
fn checks_a_commit_out_detached() {
    let (dir, [first, ..]) = repo();
    assert_eq!(
        checkout_commit(&sync::Running::default(), &checkout(&dir), &first),
        Outcome::Done
    );
    assert_eq!(head(&dir), first);
    let symbolic = Command::new("git")
        .args(["symbolic-ref", "-q", "HEAD"])
        .current_dir(dir.path())
        .status()
        .unwrap();
    assert!(!symbolic.success(), "HEAD should be detached");
}

#[test]
fn starts_a_branch_at_a_commit() {
    let (dir, [first, ..]) = repo();
    assert_eq!(
        branch_from(
            &sync::Running::default(),
            &checkout(&dir),
            &first,
            "fix/old"
        ),
        Outcome::Done
    );
    assert_eq!(
        git(dir.path(), &["symbolic-ref", "--short", "HEAD"]),
        "fix/old"
    );
    assert_eq!(head(&dir), first);
}

#[test]
fn a_dirty_tree_refuses_checkout_and_branch() {
    let (dir, [first, ..]) = repo();
    let running = sync::Running::default();
    fs::write(dir.path().join("a.txt"), "agent's edit\n").unwrap();
    assert!(failure(checkout_commit(&running, &checkout(&dir), &first)).contains("uncommitted"));
    fs::write(dir.path().join("new.txt"), "untracked\n").unwrap();
    assert!(failure(branch_from(&running, &checkout(&dir), &first, "x")).contains("2 files"));
    assert_eq!(
        git(dir.path(), &["symbolic-ref", "--short", "HEAD"]),
        "main"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "agent's edit\n"
    );
    assert!(git(dir.path(), &["branch", "--list", "x"]).is_empty());
}

#[test]
fn a_bad_or_taken_name_or_sha_is_refused() {
    let (dir, [first, ..]) = repo();
    let running = sync::Running::default();
    for name in ["-f", "a..b", "@{-1}", "", "main"] {
        failure(branch_from(&running, &checkout(&dir), &first, name));
    }
    failure(checkout_commit(&running, &checkout(&dir), "HEAD~1"));
    failure(checkout_commit(&running, &checkout(&dir), &"0".repeat(40)));
    assert_eq!(
        git(dir.path(), &["symbolic-ref", "--short", "HEAD"]),
        "main"
    );
}

#[test]
fn reverts_with_a_new_commit() {
    let (dir, [_, second, third]) = repo();
    assert_eq!(
        revert_commit(
            &sync::Running::default(),
            &checkout(&dir),
            &second,
            Some("main")
        ),
        Outcome::Done
    );
    assert_eq!(git(dir.path(), &["rev-parse", "HEAD~1"]), third);
    assert!(git(dir.path(), &["log", "-1", "--format=%s"]).starts_with("Revert \"second\""));
    assert!(!dir.path().join("b.txt").exists());
}

#[test]
fn a_revert_needs_a_clean_tree_and_the_branch_on_show() {
    let (dir, [_, second, _]) = repo();
    let running = sync::Running::default();
    let before = head(&dir);
    assert!(
        failure(revert_commit(
            &running,
            &checkout(&dir),
            &second,
            Some("other")
        ))
        .contains("moved")
    );
    fs::write(dir.path().join("new.txt"), "untracked\n").unwrap();
    assert!(
        failure(revert_commit(
            &running,
            &checkout(&dir),
            &second,
            Some("main")
        ))
        .contains("uncommitted")
    );
    assert_eq!(head(&dir), before);
}

#[test]
fn a_merge_commit_is_not_reverted() {
    let (dir, _) = repo();
    let path = dir.path();
    git(path, &["switch", "-q", "-c", "side", "HEAD~1"]);
    commit(path, "c.txt", "side\n", "side");
    git(path, &["switch", "-q", "main"]);
    git(path, &["merge", "-q", "--no-ff", "--no-edit", "side"]);
    let merge = head(&dir);
    let message = failure(revert_commit(
        &sync::Running::default(),
        &checkout(&dir),
        &merge,
        Some("main"),
    ));
    assert!(message.contains("merge commit"), "{message}");
    assert_eq!(head(&dir), merge);
}

#[test]
fn a_commit_off_the_branch_is_not_reverted() {
    let (dir, _) = repo();
    let path = dir.path();
    git(path, &["switch", "-q", "-c", "side"]);
    let elsewhere = commit(path, "c.txt", "side\n", "side");
    git(path, &["switch", "-q", "main"]);
    assert!(
        failure(revert_commit(
            &sync::Running::default(),
            &checkout(&dir),
            &elsewhere,
            Some("main")
        ))
        .contains("history")
    );
}

#[test]
fn a_conflicted_revert_is_left_for_the_panel_to_show() {
    let (dir, [_, _, third]) = repo();
    commit(dir.path(), "a.txt", "one\nchanged again\n", "fourth");
    let running = sync::Running::default();
    let message = failure(revert_commit(
        &running,
        &checkout(&dir),
        &third,
        Some("main"),
    ));
    assert!(message.contains("conflict"), "{message}");
    // Left as Git left it: under way, and in the way of the next write.
    assert_eq!(
        changes::operation_in_progress(&checkout(&dir), Instant::now() + CHECKS),
        Some("revert")
    );
    assert!(dir.path().join(".git/REVERT_HEAD").exists());
    assert!(
        failure(checkout_commit(&running, &checkout(&dir), &third))
            .contains("revert is in progress")
    );
}

#[test]
fn a_busy_checkout_is_refused() {
    let (dir, [first, ..]) = repo();
    let running = sync::Running::default();
    let root = git(dir.path(), &["rev-parse", "--show-toplevel"]);
    let _held = running.claim(&root).unwrap();
    assert!(failure(checkout_commit(&running, &checkout(&dir), &first)).contains("still running"));
}
