use super::*;
use std::{fs, process::Command};

/// Runs Git in `dir` as a throwaway author, failing the test if it fails.
fn git(dir: &tempfile::TempDir, args: &[&str]) -> String {
    let output = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir.path())
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    String::from_utf8(output.stdout).unwrap()
}

/// A repository with one committed file, in a fresh temporary directory.
fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "first"]);
    dir
}

fn head(dir: &tempfile::TempDir) -> String {
    git(dir, &["rev-parse", "HEAD"]).trim().to_owned()
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
    let marks: Vec<_> = view
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.mark))
        .collect();
    assert!(marks.contains(&("a.txt", "M")));
    assert!(marks.contains(&("new.txt", "?")));
    assert_eq!((view.added, view.removed), (2, 1));
    assert_eq!(view.commits[0].subject, "first");
}

#[test]
fn reads_a_tracked_files_patch() {
    let dir = repo();
    fs::write(dir.path().join("a.txt"), "one\nTWO\n").unwrap();
    let Ok(FileDiff::Patch { text }) = read_diff(&path(&dir), "a.txt", false, None) else {
        panic!("no patch");
    };
    assert!(text.contains("-two\n+TWO"), "{text}");
}

#[test]
fn reads_an_untracked_files_text() {
    let dir = repo();
    fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();
    let Ok(FileDiff::Untracked { text }) = read_diff(&path(&dir), "new.txt", true, None) else {
        panic!("no text");
    };
    assert_eq!(text, "fresh\n");
}

#[test]
fn refuses_paths_that_leave_the_checkout() {
    let dir = repo();
    for escape in ["../etc/passwd", "/etc/passwd", "a/../../b"] {
        assert!(
            matches!(
                read_diff(&path(&dir), escape, true, None),
                Err(Error::OutsideCheckout(_))
            ),
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
fn lists_a_commits_files_with_their_counts() {
    let dir = repo();
    fs::write(dir.path().join("a.txt"), "one\nTWO\nthree\n").unwrap();
    fs::write(dir.path().join("b.txt"), "bee\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "second"]);
    let view = read_commit(&path(&dir), &head(&dir)).unwrap();
    let files: Vec<_> = view
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.mark, f.additions, f.deletions))
        .collect();
    assert_eq!(
        files,
        vec![
            ("a.txt", "M", Some(2), Some(1)),
            ("b.txt", "A", Some(1), Some(0))
        ]
    );
    assert_eq!(view.total_files, 2);
}

#[test]
fn a_root_commit_adds_its_files() {
    let dir = repo();
    let view = read_commit(&path(&dir), &head(&dir)).unwrap();
    assert_eq!(view.files[0].path, "a.txt");
    assert_eq!(view.files[0].mark, "A");
}

#[test]
fn reads_a_files_patch_in_a_commit_not_the_working_tree() {
    let dir = repo();
    fs::write(dir.path().join("a.txt"), "one\nTWO\n").unwrap();
    git(&dir, &["commit", "-qam", "second"]);
    let commit = head(&dir);
    // A later uncommitted edit stays out of the commit's diff.
    fs::write(dir.path().join("a.txt"), "uncommitted\n").unwrap();
    let Ok(FileDiff::Patch { text }) = read_diff(&path(&dir), "a.txt", false, Some(&commit)) else {
        panic!("no patch");
    };
    assert!(text.contains("-two\n+TWO"), "{text}");
    assert!(!text.contains("uncommitted"), "{text}");
}

#[test]
fn refuses_anything_but_a_full_commit_name() {
    let dir = repo();
    for name in ["HEAD", "--output=x", "abc1234", &"A".repeat(40)] {
        assert!(
            matches!(read_commit(&path(&dir), name), Err(Error::InvalidCommit(_))),
            "{name}"
        );
        assert!(
            matches!(
                read_diff(&path(&dir), "a.txt", false, Some(name)),
                Err(Error::InvalidCommit(_))
            ),
            "{name}"
        );
    }
}

#[test]
fn commits_after_stop_at_the_count_and_ignore_what_came_later() {
    let dir = repo();
    let since = git(&dir, &["rev-parse", "HEAD"]);
    for subject in ["mine one", "mine two", "someone else's"] {
        git(&dir, &["commit", "-q", "--allow-empty", "-m", subject]);
    }
    let path = dir.path().to_str().unwrap();
    let subjects = |count| -> Vec<String> {
        read_commits_after(path, since.trim(), count)
            .unwrap()
            .into_iter()
            .map(|commit| commit.subject)
            .collect()
    };
    assert_eq!(subjects(2), ["mine two", "mine one"]);
    assert_eq!(subjects(9).len(), 3);
    assert!(read_commits_after(path, "HEAD", 1).is_err());
}
