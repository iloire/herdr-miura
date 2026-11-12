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
    assert!(matches!(read_checkout(&Target::Local, &path(&dir), 0), Ok(None)));
}

#[test]
fn commits_carry_the_names_that_point_at_them() {
    let dir = repo();
    git(&dir, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(&dir, &["update-ref", "refs/remotes/origin/HEAD", "HEAD"]);
    git(&dir, &["tag", "v1"]);
    fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
    git(&dir, &["commit", "-q", "-am", "second"]);
    let view = read_checkout(&Target::Local, &path(&dir), 0).unwrap().unwrap();
    let refs = |index: usize| -> Vec<&str> {
        let mut names: Vec<_> = view.commits[index].refs.iter().map(|name| name.name.as_str()).collect();
        names.sort_unstable();
        names
    };
    assert_eq!(refs(0), ["main"]);
    assert!(view.commits[0].refs[0].current);
    assert_eq!(refs(1), ["origin/main", "v1"]);
}

#[test]
fn lists_changed_and_untracked_files() {
    let dir = repo();
    fs::write(dir.path().join("a.txt"), "one\nTWO\nthree\n").unwrap();
    fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();
    let view = read_checkout(&Target::Local, &path(&dir), 0).unwrap().unwrap();
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
    let Ok(FileDiff::Patch { text }) = read_diff(&Target::Local, &path(&dir), "a.txt", false, None) else {
        panic!("no patch");
    };
    assert!(text.contains("-two\n+TWO"), "{text}");
}

#[test]
fn reads_an_untracked_files_text() {
    let dir = repo();
    fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();
    let Ok(FileDiff::Untracked { text }) = read_diff(&Target::Local, &path(&dir), "new.txt", true, None) else {
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
                read_diff(&Target::Local, &path(&dir), escape, true, None),
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
    let view = read_commit(&Target::Local, &path(&dir), &head(&dir)).unwrap();
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
fn finds_a_commit_by_its_short_hash_from_inside_the_checkout() {
    let dir = repo();
    fs::create_dir(dir.path().join("sub")).unwrap();
    fs::write(dir.path().join("sub/a.txt"), "one\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-m", "first"]);
    let sha = head(&dir);
    let inside = dir.path().join("sub").to_str().unwrap().to_owned();
    let found = find_commit(&Target::Local, &inside, &sha[..7]).unwrap().unwrap();
    assert_eq!(found.commit.sha, sha);
    assert_eq!(found.commit.subject, "first");
    assert_eq!(found.checkout, checkout_root(&Target::Local, &path(&dir), Instant::now() + DEADLINE).unwrap());
}

#[test]
fn a_hash_that_is_no_commit_here_finds_nothing() {
    let dir = repo();
    fs::write(dir.path().join("a.txt"), "one\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-m", "first"]);
    let blob = git(&dir, &["rev-parse", "HEAD:a.txt"]);
    assert!(find_commit(&Target::Local, &path(&dir), "0000000").unwrap().is_none());
    assert!(find_commit(&Target::Local, &path(&dir), blob.trim()).unwrap().is_none());
    let outside = tempfile::tempdir().unwrap();
    assert!(find_commit(&Target::Local, &path(&outside), "abcdef1").unwrap().is_none());
    assert!(find_commit(&Target::Local, &path(&dir), "--all").is_err());
}

#[test]
fn reads_a_commits_whole_message() {
    let dir = repo();
    fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
    git(&dir, &["commit", "-qam", "title", "-m", "first paragraph\n\nsecond paragraph"]);
    let view = read_commit(&Target::Local, &path(&dir), &head(&dir)).unwrap();
    assert_eq!(view.message, "title\n\nfirst paragraph\n\nsecond paragraph");
}

#[test]
fn a_root_commit_adds_its_files() {
    let dir = repo();
    let view = read_commit(&Target::Local, &path(&dir), &head(&dir)).unwrap();
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
    let Ok(FileDiff::Patch { text }) = read_diff(&Target::Local, &path(&dir), "a.txt", false, Some(&commit)) else {
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
            matches!(read_commit(&Target::Local, &path(&dir), name), Err(Error::InvalidCommit(_))),
            "{name}"
        );
        assert!(
            matches!(
                read_diff(&Target::Local, &path(&dir), "a.txt", false, Some(name)),
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
    let view = read_checkout(&Target::Local, &path(&repo()), 0).unwrap().unwrap();
    assert_eq!((view.operation, view.operation_step, view.conflicts), (None, None, 0));
}

#[test]
fn a_stopped_rebase_says_its_step_and_conflict() {
    let dir = repo();
    diverged(&dir, 3);
    stops(dir.path(), &["rebase", "main"]);
    let view = read_checkout(&Target::Local, &path(&dir), 0).unwrap().unwrap();
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
    let view = read_checkout(&Target::Local, linked.to_str().unwrap(), 0).unwrap().unwrap();
    assert_eq!(view.operation, Some("rebase"));
    assert_eq!(view.operation_step, Some((1, 2)));
    // The rebase is the worktree's: the checkout it came from has none.
    assert_eq!(read_checkout(&Target::Local, &path(&dir), 0).unwrap().unwrap().operation, None);
}

#[test]
fn a_linked_worktree_names_its_main_checkout() {
    let dir = repo();
    let parent = tempfile::tempdir().unwrap();
    let linked = parent.path().join("linked");
    git(&dir, &["worktree", "add", "-q", "-b", "side", linked.to_str().unwrap()]);
    let main = dir.path().canonicalize().unwrap();
    let view = read_checkout(&Target::Local, linked.to_str().unwrap(), 0).unwrap().unwrap();
    assert_eq!(view.worktree_of.as_deref(), main.to_str());
    assert_eq!(read_checkout(&Target::Local, &path(&dir), 0).unwrap().unwrap().worktree_of, None);
}

#[test]
fn only_a_folder_under_the_common_worktrees_is_a_linked_worktree() {
    let layout = |git_dir: &str, common_dir: &str| Layout {
        git_dir: git_dir.into(),
        common_dir: common_dir.into(),
        states: Vec::new(),
    };
    let submodule = layout("/r/super/.git/modules/lib", "/r/super/.git/modules/lib");
    assert_eq!(worktree_of(&submodule), None);
    assert_eq!(worktree_of(&layout("/r/main/.git", "/r/main/.git")), None);
    let linked = layout("/r/main/.git/worktrees/side", "/r/main/.git");
    assert_eq!(worktree_of(&linked).as_deref(), Some("/r/main"));
    let of_bare = layout("/r/repo.git/worktrees/side", "/r/repo.git");
    assert_eq!(worktree_of(&of_bare).as_deref(), Some("/r/repo.git"));
}

#[test]
fn a_merge_has_no_step() {
    let dir = repo();
    diverged(&dir, 1);
    stops(dir.path(), &["merge", "main"]);
    let view = read_checkout(&Target::Local, &path(&dir), 0).unwrap().unwrap();
    assert_eq!((view.operation, view.operation_step), (Some("merge"), None));
    assert_eq!(view.conflicts, 1);
}

#[test]
fn a_cherry_pick_is_an_operation() {
    let dir = repo();
    diverged(&dir, 1);
    stops(dir.path(), &["cherry-pick", "main"]);
    let view = read_checkout(&Target::Local, &path(&dir), 0).unwrap().unwrap();
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
    let view = read_checkout(&Target::Local, &path(&dir), 0).unwrap().unwrap();
    assert_eq!(view.files.len(), MAX_FILES);
    assert_eq!(view.conflicts, MAX_FILES + 5);
}

fn json(view: impl serde::Serialize) -> serde_json::Value {
    serde_json::to_value(view).unwrap()
}

#[test]
fn a_remote_host_reads_the_checkout_as_this_machine_does() {
    let dir = repo();
    let parent = tempfile::tempdir().unwrap();
    let linked = parent.path().join("linked");
    git(&dir, &["worktree", "add", "-q", "-b", "side", linked.to_str().unwrap()]);
    fs::write(linked.join("a.txt"), "one\nTWO\n").unwrap();
    fs::write(linked.join("it's new.txt"), "fresh\n").unwrap();
    let remote = Target::Ssh(crate::herdr::ssh::LOOPBACK.into());
    let linked = linked.to_str().unwrap();
    assert_eq!(
        json(read_checkout(&remote, linked, 0).unwrap()),
        json(read_checkout(&Target::Local, linked, 0).unwrap())
    );
    for (path, untracked) in [("a.txt", false), ("it's new.txt", true)] {
        assert_eq!(
            json(read_diff(&remote, linked, path, untracked, None).unwrap()),
            json(read_diff(&Target::Local, linked, path, untracked, None).unwrap())
        );
    }
    let sha = head(&dir);
    assert_eq!(
        json(read_commit(&remote, linked, &sha).unwrap()),
        json(read_commit(&Target::Local, linked, &sha).unwrap())
    );
    assert_eq!(
        json(find_commit(&remote, linked, &sha[..7]).unwrap()),
        json(find_commit(&Target::Local, linked, &sha[..7]).unwrap())
    );
}

#[test]
fn a_remote_rebase_shows_its_step() {
    let dir = repo();
    diverged(&dir, 2);
    stops(dir.path(), &["rebase", "main"]);
    let remote = Target::Ssh(crate::herdr::ssh::LOOPBACK.into());
    let view = read_checkout(&remote, &path(&dir), 0).unwrap().unwrap();
    assert_eq!((view.operation, view.operation_step), (Some("rebase"), Some((1, 2))));
}

#[test]
fn commits_carry_their_line_counts_and_the_limit_grows() {
    let dir = repo();
    for round in 0..60 {
        fs::write(dir.path().join("a.txt"), format!("{round}\nline\n")).unwrap();
        git(&dir, &["commit", "-q", "-am", &format!("round {round}")]);
    }
    let view = read_checkout(&Target::Local, &path(&dir), 0).unwrap().unwrap();
    assert_eq!(view.commits.len(), 50);
    assert_eq!((view.commits[0].additions, view.commits[0].deletions), (Some(1), Some(1)));
    let more = read_checkout(&Target::Local, &path(&dir), 100).unwrap().unwrap();
    assert_eq!(more.commits.len(), 61);
    assert_eq!(more.commits[60].additions, Some(2), "the first commit added two lines");
}

#[test]
fn lists_the_stash_and_the_origin_url() {
    let dir = repo();
    git(&dir, &["remote", "add", "origin", "git@github.com:me/repo.git"]);
    fs::write(dir.path().join("a.txt"), "stashed\n").unwrap();
    git(&dir, &["stash", "push", "-q", "-m", "keep this"]);
    let view = read_checkout(&Target::Local, &path(&dir), 0).unwrap().unwrap();
    assert_eq!(view.origin_url.as_deref(), Some("git@github.com:me/repo.git"));
    assert_eq!(view.stashes.len(), 1);
    assert_eq!(view.stashes[0].name, "stash@{0}");
    assert!(view.stashes[0].message.ends_with("keep this"), "{}", view.stashes[0].message);
}

#[test]
fn a_files_history_lists_only_its_commits() {
    let dir = repo();
    fs::write(dir.path().join("b*.txt"), "b\n").unwrap();
    fs::write(dir.path().join("bc.txt"), "bc\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "add b"]);
    fs::write(dir.path().join("bc.txt"), "bc2\n").unwrap();
    git(&dir, &["commit", "-q", "-am", "bc only"]);
    let history = read_history(&Target::Local, &path(&dir), "b*.txt").unwrap();
    let subjects: Vec<_> = history.iter().map(|commit| commit.subject.as_str()).collect();
    assert_eq!(subjects, ["add b"], "the glob reaches no other file");
    assert_eq!(read_history(&Target::Local, &path(&dir), "a.txt").unwrap().len(), 1);
    assert!(read_history(&Target::Local, &path(&dir), "../x").is_err());
}

#[test]
fn branches_list_newest_first_with_the_merged_ones() {
    let dir = repo();
    git(&dir, &["branch", "merged"]);
    git(&dir, &["switch", "-q", "-c", "ahead"]);
    fs::write(dir.path().join("b.txt"), "b\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["-c", "committer.date=2030-01-01T00:00:00", "commit", "-q", "-m", "later"]);
    git(&dir, &["switch", "-q", "main"]);
    let view = serde_json::to_value(branches::read_branches(&Target::Local, &path(&dir)).unwrap()).unwrap();
    assert_eq!(view["branches"][0]["name"], "ahead");
    assert_eq!(view["base"], "main");
    assert_eq!(view["merged"], serde_json::json!(["merged"]));
    let current: Vec<_> = view["branches"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|branch| branch["current"] == true)
        .map(|branch| branch["name"].as_str().unwrap())
        .collect();
    assert_eq!(current, ["main"]);
}
