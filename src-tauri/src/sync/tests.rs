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

/// A local bare remote, `mine` tracking its main with one commit, and
/// `theirs`, a second clone of it to push from.
struct World {
    root: tempfile::TempDir,
}

impl World {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "-q", "--bare", "-b", "main", "remote.git"]);
        git(root.path(), &["clone", "-q", "remote.git", "mine"]);
        let world = Self { root };
        let mine = world.mine();
        git(&mine, &["checkout", "-q", "-b", "main"]);
        world.commit(&mine, "a.txt", "one\n", "first");
        git(&mine, &["push", "-q", "-u", "origin", "main"]);
        git(world.root.path(), &["clone", "-q", "remote.git", "theirs"]);
        world
    }

    fn mine(&self) -> std::path::PathBuf {
        self.root.path().join("mine")
    }

    fn theirs(&self) -> std::path::PathBuf {
        self.root.path().join("theirs")
    }

    fn commit(&self, dir: &Path, file: &str, text: &str, subject: &str) {
        fs::write(dir.join(file), text).unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-q", "-m", subject]);
    }

    /// Lands a commit on the remote that `mine` does not have.
    fn remote_moves(&self, file: &str) {
        let theirs = self.theirs();
        self.commit(&theirs, file, "theirs\n", "from them");
        git(&theirs, &["push", "-q", "origin", "main"]);
    }

    fn run(&self, op: Op) -> Outcome {
        self.run_as(op, Some("main"))
    }

    fn run_as(&self, op: Op, branch: Option<&str>) -> Outcome {
        run(&Running::default(), &self.mine().to_string_lossy(), op, branch)
    }

    fn head(&self) -> String {
        git(&self.mine(), &["rev-parse", "HEAD"])
    }

    fn on_remote(&self, reference: &str) -> String {
        git(&self.root.path().join("remote.git"), &["rev-parse", reference])
    }

    fn view(&self) -> serde_json::Value {
        let view = changes::read_checkout(&self.mine().to_string_lossy()).unwrap();
        serde_json::to_value(view).unwrap()
    }

    fn counts(&self) -> (u64, u64) {
        let view = self.view();
        (view["ahead"].as_u64().unwrap(), view["behind"].as_u64().unwrap())
    }
}

fn reason(outcome: &Outcome) -> Option<Reason> {
    match outcome {
        Outcome::Failed { reason, .. } => Some(*reason),
        Outcome::Done => None,
    }
}

fn message(outcome: &Outcome) -> &str {
    match outcome {
        Outcome::Failed { message, .. } => message,
        Outcome::Done => "",
    }
}

fn details(outcome: &Outcome) -> &str {
    match outcome {
        Outcome::Failed { details, .. } => details,
        Outcome::Done => "",
    }
}

#[test]
fn fetch_updates_the_behind_count_and_nothing_else() {
    let world = World::new();
    world.remote_moves("b.txt");
    let head = world.head();
    assert_eq!(world.counts(), (0, 0), "before the fetch nothing is known");
    assert_eq!(world.run(Op::Fetch), Outcome::Done);
    assert_eq!(world.counts(), (0, 1));
    assert_eq!(world.head(), head);
}

#[test]
fn fetch_leaves_fetch_head_alone() {
    let world = World::new();
    let fetch_head = world.mine().join(".git/FETCH_HEAD");
    fs::write(&fetch_head, "an agent's\n").unwrap();
    world.remote_moves("b.txt");
    assert_eq!(world.run(Op::Fetch), Outcome::Done);
    assert_eq!(fs::read_to_string(&fetch_head).unwrap(), "an agent's\n");
}

#[test]
fn a_failed_fetch_says_why() {
    let world = World::new();
    git(&world.mine(), &["remote", "set-url", "origin", "/nowhere/at/all.git"]);
    let outcome = world.run(Op::Fetch);
    assert_eq!(reason(&outcome), Some(Reason::Other));
    assert!(details(&outcome).contains("/nowhere/at/all.git"), "{outcome:?}");
}

#[test]
fn push_moves_the_branch() {
    let world = World::new();
    world.commit(&world.mine(), "b.txt", "mine\n", "second");
    assert_eq!(world.counts(), (1, 0));
    assert_eq!(world.run(Op::Push), Outcome::Done);
    assert_eq!(world.counts(), (0, 0));
    assert_eq!(world.on_remote("main"), world.head());
}

#[test]
fn a_rejected_push_says_why_and_leaves_the_remote() {
    let world = World::new();
    world.commit(&world.mine(), "b.txt", "mine\n", "mine");
    world.remote_moves("c.txt");
    let remote = world.on_remote("main");
    let outcome = world.run(Op::Push);
    assert_eq!(reason(&outcome), Some(Reason::Rejected), "{outcome:?}");
    assert_eq!(message(&outcome), "Push rejected: [rejected] (fetch first)");
    assert!(details(&outcome).contains("Updates were rejected"), "{outcome:?}");
    assert_eq!(world.on_remote("main"), remote);
}

#[test]
fn a_hook_that_refuses_a_push_is_a_rejection_with_its_message() {
    let world = World::new();
    let hook = world.root.path().join("remote.git/hooks/pre-receive");
    fs::write(&hook, "#!/bin/sh\necho 'main is frozen' >&2\nexit 1\n").unwrap();
    Command::new("chmod").arg("+x").arg(&hook).status().unwrap();
    world.commit(&world.mine(), "b.txt", "mine\n", "second");
    let outcome = world.run(Op::Push);
    assert_eq!(reason(&outcome), Some(Reason::Rejected), "{outcome:?}");
    assert!(details(&outcome).contains("main is frozen"), "{outcome:?}");
}

#[test]
fn config_that_forces_a_push_is_refused() {
    let world = World::new();
    let mine = world.mine();
    git(&mine, &["config", "remote.origin.push", "+refs/heads/*:refs/heads/*"]);
    world.commit(&mine, "b.txt", "mine\n", "mine");
    world.remote_moves("c.txt");
    let remote = world.on_remote("main");
    assert!(message(&world.run(Op::Push)).contains("force"));
    assert_eq!(world.on_remote("main"), remote, "the remote's commit was overwritten");
}

#[test]
fn recognizes_config_that_forces() {
    assert!(forces_pushes("remote.origin.push +refs/heads/*:refs/heads/*"));
    assert!(forces_pushes("remote.fork.mirror true"));
    assert!(forces_pushes("remote.fork.mirror"), "a bare key is true");
    assert!(!forces_pushes("remote.origin.push refs/heads/*:refs/heads/*"));
    assert!(!forces_pushes("remote.origin.mirror false"));
    assert!(!forces_pushes(""));
}

#[test]
fn publish_pushes_the_branch_and_tracks_it() {
    let world = World::new();
    let mine = world.mine();
    git(&mine, &["checkout", "-q", "-b", "feat/x"]);
    world.commit(&mine, "b.txt", "mine\n", "on a branch");
    assert_eq!(world.view()["upstream"], serde_json::Value::Null);
    assert_eq!(world.run_as(Op::Publish, Some("feat/x")), Outcome::Done);
    assert_eq!(world.view()["upstream"], "origin/feat/x");
    assert_eq!(world.on_remote("feat/x"), world.head());
}

#[test]
fn a_branch_that_tracks_another_name_is_refused_with_gits_reason() {
    // What `git worktree add -b feat/x origin/main` leaves behind.
    let world = World::new();
    let mine = world.mine();
    git(&mine, &["checkout", "-q", "-b", "feat/x", "--track", "origin/main"]);
    world.commit(&mine, "b.txt", "mine\n", "on a branch");
    let outcome = world.run_as(Op::Push, Some("feat/x"));
    assert_eq!(reason(&outcome), Some(Reason::Other), "{outcome:?}");
    assert!(details(&outcome).contains("does not match"), "{outcome:?}");
}

#[test]
fn pull_fast_forwards() {
    let world = World::new();
    world.remote_moves("b.txt");
    assert_eq!(world.run(Op::Pull), Outcome::Done);
    assert_eq!(world.head(), world.on_remote("main"));
    assert!(world.mine().join("b.txt").exists());
}

#[test]
fn diverged_branches_are_refused_and_left_as_they_were() {
    let world = World::new();
    world.commit(&world.mine(), "b.txt", "mine\n", "mine");
    world.remote_moves("c.txt");
    let head = world.head();
    let outcome = world.run(Op::Pull);
    assert_eq!(reason(&outcome), Some(Reason::Diverged), "{outcome:?}");
    assert_eq!(world.head(), head);
    assert_eq!(world.counts(), (1, 1), "the pull's fetch still counts");
    let parents = git(&world.mine(), &["log", "-1", "--format=%P"]);
    assert_eq!(parents.split(' ').count(), 1, "a merge commit appeared");
}

#[test]
fn config_cannot_turn_a_pull_into_a_rebase() {
    let world = World::new();
    git(&world.mine(), &["config", "pull.rebase", "true"]);
    world.commit(&world.mine(), "b.txt", "mine\n", "mine");
    world.remote_moves("c.txt");
    let head = world.head();
    assert_eq!(reason(&world.run(Op::Pull)), Some(Reason::Diverged));
    assert_eq!(world.head(), head);
}

#[test]
fn a_dirty_tree_survives_a_pull_that_does_not_touch_it() {
    let world = World::new();
    let mine = world.mine();
    fs::write(mine.join("a.txt"), "uncommitted\n").unwrap();
    fs::write(mine.join("new.txt"), "untracked\n").unwrap();
    world.remote_moves("b.txt");
    assert_eq!(world.run(Op::Pull), Outcome::Done);
    assert_eq!(world.head(), world.on_remote("main"));
    assert_eq!(fs::read_to_string(mine.join("a.txt")).unwrap(), "uncommitted\n");
    assert_eq!(fs::read_to_string(mine.join("new.txt")).unwrap(), "untracked\n");
    assert_eq!(git(&mine, &["stash", "list"]), "");
}

#[test]
fn a_pull_that_would_overwrite_a_dirty_file_is_refused() {
    let world = World::new();
    let mine = world.mine();
    fs::write(mine.join("a.txt"), "uncommitted\n").unwrap();
    world.remote_moves("a.txt");
    let head = world.head();
    let outcome = world.run(Op::Pull);
    assert!(message(&outcome).contains("uncommitted"), "{outcome:?}");
    assert!(details(&outcome).contains("a.txt"), "{outcome:?}");
    assert_eq!(world.head(), head);
    assert_eq!(fs::read_to_string(mine.join("a.txt")).unwrap(), "uncommitted\n");
}

#[test]
fn config_cannot_make_a_pull_autostash() {
    let world = World::new();
    let mine = world.mine();
    git(&mine, &["config", "merge.autoStash", "true"]);
    git(&mine, &["config", "rebase.autoStash", "true"]);
    fs::write(mine.join("a.txt"), "uncommitted\n").unwrap();
    world.remote_moves("a.txt");
    let head = world.head();
    let outcome = world.run(Op::Pull);
    assert!(message(&outcome).contains("uncommitted"), "{outcome:?}");
    assert_eq!(world.head(), head);
    assert_eq!(git(&mine, &["stash", "list"]), "", "the work went into a stash");
    assert_eq!(fs::read_to_string(mine.join("a.txt")).unwrap(), "uncommitted\n");
}

#[test]
fn one_operation_runs_per_checkout() {
    let world = World::new();
    let mine = world.mine().to_string_lossy().into_owned();
    let root = git(&world.mine(), &["rev-parse", "--path-format=absolute", "--show-toplevel"]);
    let running = Running::default();
    let claim = running.claim(&root).unwrap();
    let outcome = run(&running, &mine, Op::Push, Some("main"));
    assert_eq!(reason(&outcome), Some(Reason::Busy));
    drop(claim);
    assert_eq!(run(&running, &mine, Op::Fetch, None), Outcome::Done, "the claim was not released");
}

#[test]
fn a_subdirectory_of_a_busy_checkout_is_the_same_checkout() {
    let world = World::new();
    let mine = world.mine();
    fs::create_dir(mine.join("sub")).unwrap();
    let root = git(&mine, &["rev-parse", "--path-format=absolute", "--show-toplevel"]);
    let running = Running::default();
    let _claim = running.claim(&root).unwrap();
    let outcome = run(&running, &mine.join("sub").to_string_lossy(), Op::Fetch, None);
    assert_eq!(reason(&outcome), Some(Reason::Busy));
}

#[test]
fn a_checkout_that_moved_off_the_shown_branch_is_left_alone() {
    let world = World::new();
    let mine = world.mine();
    world.commit(&mine, "b.txt", "mine\n", "mine");
    git(&mine, &["checkout", "-q", "-b", "other"]);
    let remote = world.on_remote("main");
    for op in [Op::Push, Op::Publish, Op::Pull] {
        let outcome = world.run_as(op, Some("main"));
        assert!(message(&outcome).contains("moved to other"), "{op:?}: {outcome:?}");
    }
    assert_eq!(world.on_remote("main"), remote);
}

#[test]
fn a_detached_head_is_refused() {
    let world = World::new();
    git(&world.mine(), &["checkout", "-q", "--detach"]);
    for op in [Op::Push, Op::Publish, Op::Pull] {
        assert!(message(&world.run_as(op, None)).contains("detached"), "{op:?}");
    }
}

/// A merge stopped on a conflict in `dir`.
fn stop_in_a_merge(dir: &Path) {
    git(dir, &["checkout", "-q", "-b", "side", "HEAD~1"]);
    fs::write(dir.join("a.txt"), "side\n").unwrap();
    git(dir, &["commit", "-qam", "side"]);
    let merge = Command::new("git").args(["merge", "main"]).current_dir(dir).output().unwrap();
    assert!(!merge.status.success(), "{merge:?}");
}

#[test]
fn a_merge_in_progress_is_reported_and_refused() {
    let world = World::new();
    let mine = world.mine();
    world.commit(&mine, "a.txt", "mine\n", "second");
    stop_in_a_merge(&mine);
    assert_eq!(world.view()["operation"], "merge");
    let outcome = world.run_as(Op::Pull, Some("side"));
    assert!(message(&outcome).contains("merge is in progress"), "{outcome:?}");
}

#[test]
fn a_merge_in_a_linked_worktree_is_found() {
    let world = World::new();
    let mine = world.mine();
    world.commit(&mine, "a.txt", "mine\n", "second");
    let linked = world.root.path().join("linked");
    git(&mine, &["worktree", "add", "-q", "--detach", linked.to_str().unwrap()]);
    stop_in_a_merge(&linked);
    let view = changes::read_checkout(&linked.to_string_lossy()).unwrap();
    assert_eq!(serde_json::to_value(view).unwrap()["operation"], "merge");
    assert_eq!(world.view()["operation"], serde_json::Value::Null, "the main checkout is not merging");
}

#[test]
fn a_rebase_in_progress_is_reported() {
    let world = World::new();
    let mine = world.mine();
    world.commit(&mine, "a.txt", "mine\n", "second");
    git(&mine, &["checkout", "-q", "-b", "side", "HEAD~1"]);
    fs::write(mine.join("a.txt"), "side\n").unwrap();
    git(&mine, &["commit", "-qam", "side"]);
    let rebase = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@t", "rebase", "main"])
        .current_dir(&mine)
        .output()
        .unwrap();
    assert!(!rebase.status.success(), "{rebase:?}");
    let view = world.view();
    assert_eq!(view["operation"], "rebase");
    assert_eq!(view["branch"], serde_json::Value::Null);
}

#[test]
fn an_unborn_branch_reads_and_fetches() {
    let root = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-q", "--bare", "-b", "main", "remote.git"]);
    git(root.path(), &["clone", "-q", "remote.git", "mine"]);
    let mine = root.path().join("mine");
    let directory = mine.to_string_lossy();
    let view = serde_json::to_value(changes::read_checkout(&directory).unwrap()).unwrap();
    assert_eq!(view["born"], false);
    assert_eq!(view["upstream_gone"], false, "nothing was ever there to be gone");
    assert_eq!(view["remotes"], serde_json::json!(["origin"]));
    assert_eq!(run(&Running::default(), &directory, Op::Fetch, None), Outcome::Done);
}

#[test]
fn an_upstream_deleted_on_the_remote_reads_as_gone() {
    let world = World::new();
    let mine = world.mine();
    git(&mine, &["checkout", "-q", "-b", "feat/x"]);
    git(&mine, &["push", "-q", "-u", "origin", "feat/x"]);
    assert_eq!(world.view()["upstream_gone"], false);
    git(&mine, &["push", "-q", "origin", "--delete", "feat/x"]);
    assert_eq!(world.view()["upstream_gone"], true);
}

#[test]
fn a_repository_with_no_remote_lists_none() {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q", "-b", "main"]);
    let view = changes::read_checkout(&dir.path().to_string_lossy()).unwrap();
    assert_eq!(serde_json::to_value(view).unwrap()["remotes"], serde_json::json!([]));
}

#[test]
fn an_overrun_is_stopped_and_releases_the_checkout() {
    let world = World::new();
    let mine = world.mine();
    let hook = mine.join(".git/hooks/pre-push");
    fs::write(&hook, "#!/bin/sh\nsleep 30\n").unwrap();
    Command::new("chmod").arg("+x").arg(&hook).status().unwrap();
    world.commit(&mine, "b.txt", "mine\n", "second");
    let directory = mine.to_string_lossy();
    let running = Running::default();
    let start = Instant::now();
    let limit = Duration::from_millis(300);
    let outcome = run_within(&running, &directory, Op::Push, Some("main"), limit);
    assert!(message(&outcome).contains("stopped"), "{outcome:?}");
    assert!(start.elapsed() < Duration::from_secs(5), "{:?}", start.elapsed());
    fs::remove_file(&hook).unwrap();
    assert_eq!(run(&running, &directory, Op::Push, Some("main")), Outcome::Done);
}

fn subjects(commits: Vec<changes::CommitView>) -> Vec<String> {
    commits
        .into_iter()
        .map(|commit| serde_json::to_value(commit).unwrap()["subject"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn the_lists_hold_exactly_what_would_move() {
    let world = World::new();
    let mine = world.mine();
    for (index, subject) in ["out one", "out two"].into_iter().enumerate() {
        world.commit(&mine, &format!("m{index}.txt"), "mine\n", subject);
    }
    world.remote_moves("c.txt");
    assert_eq!(world.run(Op::Fetch), Outcome::Done);
    let directory = mine.to_string_lossy();
    let outgoing = changes::read_moving(&directory, changes::Direction::Outgoing).unwrap();
    assert_eq!(subjects(outgoing), ["out two", "out one"]);
    let incoming = changes::read_moving(&directory, changes::Direction::Incoming).unwrap();
    assert_eq!(subjects(incoming), ["from them"]);
}

#[test]
fn the_outgoing_list_goes_past_the_recent_five() {
    let world = World::new();
    let mine = world.mine();
    for index in 0..27 {
        git(&mine, &["commit", "-q", "--allow-empty", "-m", &format!("c{index}")]);
    }
    let directory = mine.to_string_lossy();
    let outgoing = changes::read_moving(&directory, changes::Direction::Outgoing).unwrap();
    assert_eq!(outgoing.len(), 27);
}

#[test]
fn outside_git_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let outcome = run(&Running::default(), &dir.path().to_string_lossy(), Op::Fetch, None);
    assert_eq!(reason(&outcome), Some(Reason::Other));
}
