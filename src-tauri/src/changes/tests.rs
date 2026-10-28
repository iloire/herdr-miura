use super::*;
use std::{fs, process::Command};

/// A repository with one committed file, in a fresh temporary directory.
fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        let status = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(status.status.success(), "{status:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "first"]);
    dir
}

fn path(dir: &tempfile::TempDir) -> String {
    dir.path().to_string_lossy().into_owned()
}

#[test]
fn outside_git_is_no_checkout() {
    let dir = tempfile::tempdir().unwrap();
    assert!(matches!(read_checkout(&path(&dir)), Ok(None)));
}

#[test]
fn lists_changed_and_untracked_files() {
    let dir = repo();
    fs::write(dir.path().join("a.txt"), "one\nTWO\nthree\n").unwrap();
    fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();
    let view = read_checkout(&path(&dir)).unwrap().unwrap();
    assert_eq!(view.branch.as_deref(), Some("main"));
    assert_eq!(view.total_files, 2);
    let marks: Vec<_> = view.files.iter().map(|f| (f.path.as_str(), f.mark)).collect();
    assert!(marks.contains(&("a.txt", "M")));
    assert!(marks.contains(&("new.txt", "?")));
    assert_eq!((view.added, view.removed), (2, 1));
    assert_eq!(view.commits[0].subject, "first");
}

#[test]
fn reads_a_tracked_files_patch() {
    let dir = repo();
    fs::write(dir.path().join("a.txt"), "one\nTWO\n").unwrap();
    let Ok(FileDiff::Patch { text }) = read_diff(&path(&dir), "a.txt", false) else {
        panic!("no patch");
    };
    assert!(text.contains("-two\n+TWO"), "{text}");
}

#[test]
fn reads_an_untracked_files_text() {
    let dir = repo();
    fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();
    let Ok(FileDiff::Untracked { text }) = read_diff(&path(&dir), "new.txt", true) else {
        panic!("no text");
    };
    assert_eq!(text, "fresh\n");
}

#[test]
fn refuses_paths_that_leave_the_checkout() {
    let dir = repo();
    for escape in ["../etc/passwd", "/etc/passwd", "a/../../b"] {
        assert!(
            matches!(read_diff(&path(&dir), escape, true), Err(Error::OutsideCheckout(_))),
            "{escape}"
        );
    }
}

#[test]
fn counts_changed_files_per_directory() {
    let dir = repo();
    fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
    fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();
    let clean = repo();
    let outside = tempfile::tempdir().unwrap();
    assert_eq!(
        count_changes(&[path(&dir), path(&clean), path(&outside)]),
        vec![Some(2), Some(0), None]
    );
}

#[test]
fn a_rename_counts_once() {
    assert_eq!(count_porcelain("R  new.txt\0old.txt\0 M a.txt\0?? b.txt\0"), 3);
    assert_eq!(count_porcelain(""), 0);
}
