use super::*;
use std::{fs, path::Path, process::Command};

/// Runs Git in `dir` as a throwaway author, failing the test if it fails.
fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(output.status.success(), "{args:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

/// A repo on `main` with one commit, `merged` level with it, and `ahead` one
/// commit past it.
fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    git(path, &["init", "-q", "-b", "main"]);
    fs::write(path.join("a.txt"), "one\n").unwrap();
    git(path, &["add", "."]);
    git(path, &["commit", "-q", "-m", "first"]);
    git(path, &["branch", "merged"]);
    git(path, &["switch", "-q", "-c", "ahead"]);
    fs::write(path.join("b.txt"), "two\n").unwrap();
    git(path, &["add", "."]);
    git(path, &["commit", "-q", "-m", "second"]);
    git(path, &["switch", "-q", "main"]);
    dir
}

fn checkout(dir: &tempfile::TempDir) -> String {
    dir.path().to_string_lossy().into_owned()
}

fn branch(dir: &tempfile::TempDir) -> String {
    git(dir.path(), &["symbolic-ref", "--short", "HEAD"])
}

fn exists(dir: &tempfile::TempDir, name: &str) -> bool {
    !git(dir.path(), &["branch", "--list", name]).is_empty()
}

fn failure(outcome: Outcome) -> String {
    match outcome {
        Outcome::Failed { message, .. } => message,
        Outcome::Done => panic!("expected a refusal"),
    }
}

#[test]
fn switches_on_a_clean_tree() {
    let dir = repo();
    let running = sync::Running::default();
    assert_eq!(switch_branch(&running, &checkout(&dir), "ahead", Some("main")), Outcome::Done);
    assert_eq!(branch(&dir), "ahead");
}

#[test]
fn a_changed_file_refuses_the_switch() {
    let dir = repo();
    fs::write(dir.path().join("a.txt"), "edited\n").unwrap();
    let message = failure(switch_branch(&sync::Running::default(), &checkout(&dir), "ahead", Some("main")));
    assert!(message.contains("uncommitted"), "{message}");
    assert_eq!(branch(&dir), "main");
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "edited\n");
}

#[test]
fn an_untracked_file_refuses_the_switch() {
    let dir = repo();
    fs::write(dir.path().join("new.txt"), "agent's\n").unwrap();
    failure(switch_branch(&sync::Running::default(), &checkout(&dir), "ahead", Some("main")));
    assert_eq!(branch(&dir), "main");
}

#[test]
fn a_moved_checkout_or_an_option_is_not_switched() {
    let dir = repo();
    let running = sync::Running::default();
    let message = failure(switch_branch(&running, &checkout(&dir), "ahead", Some("other")));
    assert!(message.contains("moved"), "{message}");
    failure(switch_branch(&running, &checkout(&dir), "--orphan", Some("main")));
    failure(switch_branch(&running, &checkout(&dir), "origin/ahead", Some("main")));
    assert_eq!(branch(&dir), "main");
}

#[test]
fn a_merge_under_way_refuses_the_switch() {
    let dir = repo();
    let path = dir.path();
    git(path, &["switch", "-q", "-c", "clash"]);
    fs::write(path.join("a.txt"), "theirs\n").unwrap();
    git(path, &["commit", "-q", "-am", "theirs"]);
    git(path, &["switch", "-q", "main"]);
    fs::write(path.join("a.txt"), "ours\n").unwrap();
    git(path, &["commit", "-q", "-am", "ours"]);
    let merge = Command::new("git").args(["merge", "clash"]).current_dir(path).output().unwrap();
    assert!(!merge.status.success());
    let message = failure(switch_branch(&sync::Running::default(), &checkout(&dir), "ahead", Some("main")));
    assert!(message.contains("merge"), "{message}");
}

#[test]
fn deletes_a_merged_branch() {
    let dir = repo();
    assert_eq!(delete_branch(&sync::Running::default(), &checkout(&dir), "merged"), Outcome::Done);
    assert!(!exists(&dir, "merged"));
}

#[test]
fn keeps_an_unmerged_branch() {
    let dir = repo();
    let message = failure(delete_branch(&sync::Running::default(), &checkout(&dir), "ahead"));
    assert!(message.contains("not merged"), "{message}");
    assert!(exists(&dir, "ahead"));
}

#[test]
fn keeps_the_base_and_a_branch_checked_out_in_a_worktree() {
    let dir = repo();
    let running = sync::Running::default();
    failure(delete_branch(&running, &checkout(&dir), "main"));
    let linked = tempfile::tempdir().unwrap();
    let linked_path = linked.path().join("wt");
    git(dir.path(), &["worktree", "add", "-q", linked_path.to_str().unwrap(), "merged"]);
    let message = failure(delete_branch(&running, &checkout(&dir), "merged"));
    assert!(message.contains("checked out"), "{message}");
    assert!(exists(&dir, "main"));
    assert!(exists(&dir, "merged"));
}

#[test]
fn measures_against_the_remote_default_branch() {
    let dir = repo();
    // origin/main is behind local main, which holds `ahead` once merged.
    git(dir.path(), &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(dir.path(), &["merge", "-q", "--ff-only", "ahead"]);
    let message = failure(delete_branch(&sync::Running::default(), &checkout(&dir), "ahead"));
    assert!(message.contains("origin/main"), "{message}");
    assert!(exists(&dir, "ahead"));
}
