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
fn reads_a_commits_whole_message() {
    let dir = repo();
    fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
    git(&dir, &["commit", "-qam", "title", "-m", "first paragraph\n\nsecond paragraph"]);
    let view = read_commit(&path(&dir), &head(&dir)).unwrap();
    assert_eq!(view.message, "title\n\nfirst paragraph\n\nsecond paragraph");
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

/// Two branches that both change `a.txt`, `work` checked out with `count`
/// commits on top of `main`'s conflicting one. The first conflicts.
fn diverged(dir: &tempfile::TempDir, count: u32) {
    git(dir, &["switch", "-q", "-c", "work"]);
    for step in 1..=count {
        fs::write(dir.path().join("a.txt"), format!("work {step}\n")).unwrap();
        git(dir, &["commit", "-qam", "work"]);
    }
    git(dir, &["switch", "-q", "main"]);
    fs::write(dir.path().join("a.txt"), "main\n").unwrap();
    git(dir, &["commit", "-qam", "main"]);
    git(dir, &["switch", "-q", "work"]);
}

/// Runs Git expecting it to stop on a conflict.
fn stops(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap()
        .status;
    assert!(!status.success(), "{args:?}");
}

#[test]
fn a_clean_checkout_has_no_operation() {
    let view = read_checkout(&path(&repo())).unwrap().unwrap();
    assert_eq!((view.operation, view.operation_step, view.conflicts), (None, None, 0));
}

#[test]
fn a_stopped_rebase_says_its_step_and_conflict() {
    let dir = repo();
    diverged(&dir, 3);
    stops(dir.path(), &["rebase", "main"]);
    let view = read_checkout(&path(&dir)).unwrap().unwrap();
    assert_eq!(view.operation, Some("rebase"));
    assert_eq!(view.operation_step, Some((1, 3)));
    assert_eq!(view.conflicts, 1);
}

#[test]
fn a_rebase_in_a_linked_worktree_is_found_through_its_git_dir() {
    let dir = repo();
    diverged(&dir, 2);
    git(&dir, &["switch", "-q", "main"]);
    let parent = tempfile::tempdir().unwrap();
    let linked = parent.path().join("linked");
    git(&dir, &["worktree", "add", "-q", linked.to_str().unwrap(), "work"]);
    stops(&linked, &["rebase", "main"]);
    let view = read_checkout(linked.to_str().unwrap()).unwrap().unwrap();
    assert_eq!(view.operation, Some("rebase"));
    assert_eq!(view.operation_step, Some((1, 2)));
    // The rebase is the worktree's: the checkout it came from has none.
    assert_eq!(read_checkout(&path(&dir)).unwrap().unwrap().operation, None);
}

#[test]
fn a_merge_has_no_step() {
    let dir = repo();
    diverged(&dir, 1);
    stops(dir.path(), &["merge", "main"]);
    let view = read_checkout(&path(&dir)).unwrap().unwrap();
    assert_eq!((view.operation, view.operation_step), (Some("merge"), None));
    assert_eq!(view.conflicts, 1);
}

#[test]
fn a_cherry_pick_is_an_operation() {
    let dir = repo();
    diverged(&dir, 1);
    stops(dir.path(), &["cherry-pick", "main"]);
    let view = read_checkout(&path(&dir)).unwrap().unwrap();
    assert_eq!((view.operation, view.conflicts), (Some("cherry-pick"), 1));
}

#[test]
fn counts_conflicts_past_the_files_it_lists() {
    let dir = repo();
    let names: Vec<String> = (0..MAX_FILES + 5).map(|n| format!("file{n}.txt")).collect();
    let write = |text: &str| {
        for name in &names {
            fs::write(dir.path().join(name), text).unwrap();
        }
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "write"]);
    };
    write("base\n");
    git(&dir, &["switch", "-q", "-c", "work"]);
    write("work\n");
    git(&dir, &["switch", "-q", "main"]);
    write("main\n");
    stops(dir.path(), &["merge", "work"]);
    let view = read_checkout(&path(&dir)).unwrap().unwrap();
    assert_eq!(view.files.len(), MAX_FILES);
    assert_eq!(view.conflicts, MAX_FILES + 5);
}
