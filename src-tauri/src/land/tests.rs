use super::*;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};

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

/// A repo on `main` with one commit, and a linked worktree on `feat/x` with
/// one more. The check is a `.herdr/land.json` when a test commits one.
struct World {
    _root: tempfile::TempDir,
    /// Canonical, as Git lists it: a temporary folder can be behind a symlink.
    base: PathBuf,
    tree: PathBuf,
}

impl World {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        fs::create_dir(base.join("repo")).unwrap();
        let tree = base.join("wt");
        let world = Self { _root: root, base, tree };
        let main = world.main();
        git(&main, &["init", "-q", "-b", "main"]);
        // The app's own rebase and merge read this, as they would a person's.
        git(&main, &["config", "user.name", "t"]);
        git(&main, &["config", "user.email", "t@t"]);
        world.commit(&main, "a.txt", "one\n", "first");
        git(&main, &["worktree", "add", "-q", "-b", "feat/x", world.tree_str()]);
        world.commit(&world.tree(), "b.txt", "work\n", "the work");
        world
    }

    fn main(&self) -> PathBuf {
        self.base.join("repo")
    }

    fn tree(&self) -> PathBuf {
        self.tree.clone()
    }

    fn tree_str(&self) -> &str {
        self.tree.to_str().unwrap()
    }

    fn commit(&self, dir: &Path, file: &str, text: &str, subject: &str) {
        let path = dir.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-q", "-m", subject]);
    }

    fn head(&self, dir: &Path) -> String {
        git(dir, &["rev-parse", "HEAD"])
    }

    fn branch_exists(&self, branch: &str) -> bool {
        !git(&self.main(), &["branch", "--list", branch]).is_empty()
    }

    fn plan(&self) -> Plan {
        plan(self.tree_str())
    }

    /// What the confirmation would hand back right now.
    fn target(&self) -> Target {
        let Plan::Ready { branch, head, check, .. } = self.plan() else {
            panic!("not ready: {:?}", self.plan());
        };
        Target {
            worktree: self.tree_str().to_owned(),
            branch,
            head,
            check,
        }
    }

    fn land(&self) -> Outcome {
        let target = self.target();
        match check(&target) {
            Outcome::Passed => finish(&target, |_| {}),
            stopped => stopped,
        }
    }

    fn refusal(&self) -> String {
        match self.plan() {
            Plan::Refused { message } => message,
            ready => panic!("offered: {ready:?}"),
        }
    }
}

/// The step a failure stopped at, then why, then what it left.
fn stopped(outcome: Outcome) -> (Step, String, String, String) {
    match outcome {
        Outcome::Failed { step, message, left, details } => (step, message, left, details),
        other => panic!("did not fail: {other:?}"),
    }
}

#[test]
fn the_plan_names_the_branch_count_and_check() {
    let world = World::new();
    world.commit(&world.tree(), "c.txt", "more\n", "more");
    assert_eq!(
        world.plan(),
        Plan::Ready {
            branch: "feat/x".to_owned(),
            head: world.head(&world.tree()),
            main: "main".to_owned(),
            commits: 2,
            check: None,
        }
    );
}

#[test]
fn a_clean_land_ends_with_main_on_the_commits_and_the_worktree_gone() {
    let world = World::new();
    let main = world.main();
    // Main moved since the branch was cut, so the rebase has real work.
    world.commit(&main, "m.txt", "main\n", "on main");
    let outcome = world.land();
    assert_eq!(
        outcome,
        Outcome::Landed {
            main: "main".to_owned(),
            commits: 1
        }
    );
    assert_eq!(git(&main, &["log", "-1", "--format=%s"]), "the work");
    assert_eq!(git(&main, &["rev-list", "--count", "HEAD"]), "3", "rebased, not merged");
    assert!(!git(&main, &["worktree", "list"]).contains("/wt"));
    assert!(!world.tree().exists());
    assert!(!world.branch_exists("feat/x"));
    assert_eq!(git(&main, &["stash", "list"]), "");
}

#[test]
fn each_step_is_reported_in_order() {
    let world = World::new();
    let target = world.target();
    let steps = Mutex::new(Vec::new());
    finish(&target, |step| steps.lock().unwrap().push(step));
    assert_eq!(
        *steps.lock().unwrap(),
        [Step::Rebase, Step::FastForward, Step::Remove, Step::DeleteBranch, Step::Confirm]
    );
}

#[test]
fn the_main_checkout_is_refused() {
    let world = World::new();
    let message = match plan(world.main().to_str().unwrap()) {
        Plan::Refused { message } => message,
        ready => panic!("offered: {ready:?}"),
    };
    assert!(message.contains("Only a linked worktree"), "{message}");
}

#[test]
fn a_detached_worktree_is_refused() {
    let world = World::new();
    git(&world.tree(), &["checkout", "-q", "--detach"]);
    assert!(world.refusal().contains("detached"));
}

#[test]
fn a_locked_worktree_is_refused_before_anything_moves() {
    let world = World::new();
    git(&world.main(), &["worktree", "lock", world.tree_str()]);
    assert!(world.refusal().contains("locked"));
}

#[test]
fn a_branch_with_nothing_main_lacks_is_refused() {
    let world = World::new();
    let tree = world.tree();
    git(&tree, &["reset", "-q", "--hard", "HEAD~1"]);
    assert!(world.refusal().contains("no commits"));
}

#[test]
fn a_dirty_worktree_is_refused_for_edits_and_untracked_files() {
    let world = World::new();
    fs::write(world.tree().join("b.txt"), "edited\n").unwrap();
    assert!(world.refusal().contains("1 uncommitted file"));
    fs::write(world.tree().join("new.txt"), "new\n").unwrap();
    assert!(world.refusal().contains("2 uncommitted files"));
}

#[test]
fn a_worktree_dirtied_after_the_confirmation_is_refused_at_each_run() {
    let world = World::new();
    let target = world.target();
    fs::write(world.tree().join("new.txt"), "new\n").unwrap();
    assert_eq!(stopped(check(&target)).0, Step::Start);
    let (step, message, left, _) = stopped(finish(&target, |_| {}));
    assert_eq!(step, Step::Start);
    assert!(message.contains("uncommitted"));
    assert_eq!(left, "Nothing changed.");
    assert!(world.tree().join("new.txt").exists());
}

#[test]
fn a_rebase_in_progress_in_the_worktree_is_refused() {
    let world = World::new();
    world.commit(&world.tree(), "a.txt", "mine\n", "conflicts");
    world.commit(&world.main(), "a.txt", "theirs\n", "conflicts too");
    let output = Command::new("git")
        .args(["rebase", "main"])
        .current_dir(world.tree())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(world.refusal().contains("rebase is in progress"));
}

#[test]
fn a_merge_in_progress_in_the_main_checkout_is_refused() {
    let world = World::new();
    let main = world.main();
    let side = world.head(&main);
    world.commit(&main, "a.txt", "ours\n", "ours");
    git(&main, &["checkout", "-q", "-b", "side", &side]);
    world.commit(&main, "a.txt", "theirs\n", "theirs");
    git(&main, &["checkout", "-q", "main"]);
    let merge = Command::new("git").args(["merge", "side"]).current_dir(&main).output().unwrap();
    assert!(!merge.status.success());
    assert!(world.refusal().contains("merge is in progress in the main checkout"));
}

#[test]
fn a_main_checkout_on_another_branch_is_refused_before_the_branch_is_touched() {
    let world = World::new();
    let head = world.head(&world.tree());
    let target = world.target();
    git(&world.main(), &["checkout", "-q", "-b", "elsewhere"]);
    assert!(world.refusal().contains("on elsewhere, not main"));
    assert_eq!(stopped(finish(&target, |_| {})).0, Step::Start);
    assert_eq!(world.head(&world.tree()), head);
}

#[test]
fn a_main_checkout_that_leaves_main_mid_land_stops_the_fast_forward() {
    let world = World::new();
    let main = world.main();
    let before = world.head(&main);
    let target = world.target();
    let outcome = finish(&target, |step| {
        if step == Step::FastForward {
            git(&main, &["checkout", "-q", "-b", "elsewhere"]);
        }
    });
    let (step, message, left, _) = stopped(outcome);
    assert_eq!(step, Step::FastForward);
    assert!(message.contains("on elsewhere"), "{message}");
    assert!(left.contains("did not move"), "{left}");
    assert_eq!(world.head(&main), before);
    assert!(world.tree().exists());
}

#[test]
fn a_moved_branch_is_refused_as_not_what_was_confirmed() {
    let world = World::new();
    let target = world.target();
    world.commit(&world.tree(), "c.txt", "more\n", "more");
    assert!(stopped(check(&target)).1.contains("after you confirmed"));
    assert!(stopped(finish(&target, |_| {})).1.contains("after you confirmed"));
}

#[test]
fn a_different_branch_is_refused_as_not_what_was_confirmed() {
    let world = World::new();
    let mut target = world.target();
    target.branch = "feat/other".to_owned();
    assert!(stopped(finish(&target, |_| {})).1.contains("moved to feat/x"));
}

#[test]
fn a_changed_check_is_refused_as_not_what_was_confirmed() {
    let world = World::new();
    let mut target = world.target();
    target.check = Some("true".to_owned());
    assert!(stopped(check(&target)).1.contains("check changed"));
}

#[test]
fn a_failing_check_stops_before_the_rebase_and_shows_its_output() {
    let world = World::new();
    world.commit(&world.tree(), CONFIG, r#"{"check": "echo the reason; exit 3"}"#, "check");
    world.commit(&world.main(), "m.txt", "main\n", "on main");
    let head = world.head(&world.tree());
    let main_head = world.head(&world.main());
    let (step, message, left, details) = stopped(world.land());
    assert_eq!(step, Step::Check);
    assert!(message.contains("exit 3"), "{message}");
    assert!(details.contains("the reason"), "{details}");
    assert!(left.contains("as it was"), "{left}");
    assert_eq!(world.head(&world.tree()), head, "not rebased");
    assert_eq!(world.head(&world.main()), main_head);
    assert!(world.branch_exists("feat/x"));
}

#[test]
fn the_check_runs_in_the_worktree() {
    let world = World::new();
    world.commit(&world.tree(), CONFIG, r#"{"check": "pwd > where.out"}"#, "check");
    let target = world.target();
    assert_eq!(check(&target), Outcome::Passed);
    let written = fs::read_to_string(world.tree().join("where.out")).unwrap();
    assert_eq!(written.trim(), world.tree_str());
}

#[test]
fn a_check_that_leaves_files_behind_is_refused_at_the_rebase() {
    let world = World::new();
    world.commit(&world.tree(), CONFIG, r#"{"check": "touch left-behind"}"#, "check");
    let target = world.target();
    assert_eq!(check(&target), Outcome::Passed);
    let (step, message, ..) = stopped(finish(&target, |_| {}));
    assert_eq!(step, Step::Start);
    assert!(message.contains("uncommitted"), "{message}");
}

#[test]
fn a_check_past_its_limit_is_stopped() {
    let world = World::new();
    let repo = read(world.tree_str(), Instant::now() + READS).unwrap();
    let started = Instant::now();
    let (step, message, ..) = stopped(run_check(&repo, "sleep 30", Duration::from_secs(2)));
    assert_eq!(step, Step::Check);
    assert!(message.contains("stopped after"), "{message}");
    assert!(started.elapsed() < Duration::from_secs(15));
}

#[test]
fn a_conflict_aborts_the_rebase_and_leaves_the_branch_as_it_was() {
    let world = World::new();
    let (main, tree) = (world.main(), world.tree());
    world.commit(&tree, "a.txt", "mine\n", "conflicts");
    world.commit(&main, "a.txt", "theirs\n", "conflicts too");
    let head = world.head(&tree);
    let main_head = world.head(&main);
    let (step, message, left, details) = stopped(world.land());
    assert_eq!(step, Step::Rebase);
    assert!(message.contains("conflict"), "{message}");
    assert!(details.contains("a.txt"), "{details}");
    assert!(left.contains("as it was"), "{left}");
    assert_eq!(world.head(&tree), head);
    assert_eq!(git(&tree, &["symbolic-ref", "--short", "HEAD"]), "feat/x");
    assert_eq!(changes::operation_in_progress(world.tree_str(), Instant::now() + READS), None);
    assert_eq!(git(&tree, &["status", "--porcelain"]), "");
    assert_eq!(world.head(&main), main_head);
}

#[test]
fn a_refused_rebase_leaves_the_branch_as_it_was() {
    let world = World::new();
    world.commit(&world.main(), "m.txt", "main\n", "on main");
    let hooks = world.main().join(".git/hooks");
    fs::create_dir_all(&hooks).unwrap();
    let hook = hooks.join("pre-rebase");
    fs::write(&hook, "#!/bin/sh\necho no thanks >&2\nexit 1\n").unwrap();
    let chmod = Command::new("chmod").args(["+x", hook.to_str().unwrap()]).status().unwrap();
    assert!(chmod.success());
    let head = world.head(&world.tree());
    let (step, message, left, details) = stopped(world.land());
    assert_eq!(step, Step::Rebase);
    assert_eq!(message, "The rebase failed.");
    assert!(details.contains("no thanks"), "{details}");
    assert!(left.contains("as it was"), "{left}");
    assert_eq!(world.head(&world.tree()), head);
}

#[test]
fn a_rebase_past_its_limit_is_stopped_and_the_branch_stays() {
    let world = World::new();
    world.commit(&world.main(), "m.txt", "main\n", "on main");
    let hooks = world.main().join(".git/hooks");
    fs::create_dir_all(&hooks).unwrap();
    let hook = hooks.join("pre-rebase");
    fs::write(&hook, "#!/bin/sh\nsleep 30\n").unwrap();
    let chmod = Command::new("chmod").args(["+x", hook.to_str().unwrap()]).status().unwrap();
    assert!(chmod.success());
    let head = world.head(&world.tree());
    let target = world.target();
    let (step, _, left, _) = stopped(finish_within(&target, |_| {}, Duration::from_secs(1)));
    assert_eq!(step, Step::Rebase);
    assert!(left.contains("as it was"), "{left}");
    assert_eq!(world.head(&world.tree()), head);
}

#[test]
fn a_rebase_never_stashes_what_appeared_after_the_last_look() {
    let world = World::new();
    let tree = world.tree();
    git(&tree, &["config", "rebase.autoStash", "true"]);
    world.commit(&world.main(), "m.txt", "main\n", "on main");
    let head = world.head(&tree);
    let target = world.target();
    let outcome = finish(&target, |step| {
        if step == Step::Rebase {
            fs::write(tree.join("b.txt"), "just edited\n").unwrap();
        }
    });
    assert_eq!(stopped(outcome).0, Step::Rebase);
    assert_eq!(fs::read_to_string(tree.join("b.txt")).unwrap(), "just edited\n");
    assert_eq!(git(&tree, &["stash", "list"]), "");
    assert_eq!(world.head(&tree), head);
}

#[test]
fn a_rebase_moves_no_other_branch_whatever_the_config_says() {
    let world = World::new();
    let tree = world.tree();
    git(&tree, &["config", "rebase.updateRefs", "true"]);
    git(&tree, &["branch", "stacked"]);
    world.commit(&tree, "c.txt", "more\n", "more");
    world.commit(&world.main(), "m.txt", "main\n", "on main");
    let stacked = git(&tree, &["rev-parse", "stacked"]);
    assert!(matches!(world.land(), Outcome::Landed { .. }));
    assert_eq!(git(&world.main(), &["rev-parse", "stacked"]), stacked);
}

#[test]
fn a_rebase_keeps_every_commit_whatever_the_config_says() {
    let world = World::new();
    let tree = world.tree();
    git(&tree, &["config", "rebase.autoSquash", "true"]);
    world.commit(&tree, "b.txt", "fixed\n", "fixup! the work");
    world.commit(&world.main(), "m.txt", "main\n", "on main");
    assert!(matches!(world.land(), Outcome::Landed { commits: 2, .. }));
}

#[test]
fn a_commit_main_already_has_is_not_counted_as_landed() {
    let world = World::new();
    world.commit(&world.main(), "b.txt", "work\n", "same change");
    assert!(matches!(world.land(), Outcome::Landed { commits: 0, .. }));
}

#[test]
fn uncommitted_changes_in_the_main_checkout_survive_a_land() {
    let world = World::new();
    let main = world.main();
    fs::write(main.join("a.txt"), "someone else's\n").unwrap();
    fs::write(main.join("theirs.txt"), "untracked\n").unwrap();
    assert!(matches!(world.land(), Outcome::Landed { .. }));
    assert_eq!(fs::read_to_string(main.join("a.txt")).unwrap(), "someone else's\n");
    assert_eq!(fs::read_to_string(main.join("theirs.txt")).unwrap(), "untracked\n");
    assert_eq!(fs::read_to_string(main.join("b.txt")).unwrap(), "work\n");
}

#[test]
fn a_fast_forward_that_would_touch_uncommitted_changes_refuses_and_never_stashes() {
    let world = World::new();
    let main = world.main();
    git(&main, &["config", "merge.autoStash", "true"]);
    world.commit(&world.tree(), "a.txt", "from the branch\n", "touches a");
    fs::write(main.join("a.txt"), "someone else's\n").unwrap();
    let before = world.head(&main);
    let (step, message, left, _) = stopped(world.land());
    assert_eq!(step, Step::FastForward);
    assert!(message.contains("Uncommitted changes"), "{message}");
    assert!(left.contains("rebased"), "{left}");
    assert_eq!(fs::read_to_string(main.join("a.txt")).unwrap(), "someone else's\n");
    assert_eq!(git(&main, &["stash", "list"]), "");
    assert_eq!(world.head(&main), before);
    assert!(world.tree().exists());
}

#[test]
fn an_untracked_file_in_the_way_of_the_fast_forward_is_left_alone() {
    let world = World::new();
    let main = world.main();
    fs::write(main.join("b.txt"), "someone else's\n").unwrap();
    let (step, ..) = stopped(world.land());
    assert_eq!(step, Step::FastForward);
    assert_eq!(fs::read_to_string(main.join("b.txt")).unwrap(), "someone else's\n");
}

#[test]
fn main_moving_after_the_rebase_stops_the_fast_forward() {
    let world = World::new();
    let main = world.main();
    let target = world.target();
    let outcome = finish(&target, |step| {
        if step == Step::FastForward {
            world.commit(&main, "late.txt", "late\n", "late");
        }
    });
    let (step, message, ..) = stopped(outcome);
    assert_eq!(step, Step::FastForward);
    assert!(message.contains("moved during the land"), "{message}");
    assert!(world.tree().exists());
    assert!(world.branch_exists("feat/x"));
}

#[test]
fn a_worktree_git_will_not_remove_is_reported_and_kept() {
    let world = World::new();
    let main = world.main();
    let target = world.target();
    let outcome = finish(&target, |step| {
        if step == Step::Remove {
            git(&main, &["worktree", "lock", world.tree_str()]);
        }
    });
    let (step, _, left, details) = stopped(outcome);
    assert_eq!(step, Step::Remove);
    assert!(left.contains("main has the commits"), "{left}");
    assert!(details.contains("locked"), "{details}");
    assert!(world.tree().exists());
    assert!(world.branch_exists("feat/x"));
}

#[test]
fn a_branch_ahead_of_its_upstream_is_kept_rather_than_forced() {
    let world = World::new();
    let main = world.main();
    git(world.base.as_path(), &["init", "-q", "--bare", "origin.git"]);
    git(&main, &["remote", "add", "origin", "../origin.git"]);
    git(&world.tree(), &["push", "-q", "-u", "origin", "feat/x"]);
    world.commit(&main, "m.txt", "main\n", "on main");
    let (step, _, left, details) = stopped(world.land());
    assert_eq!(step, Step::DeleteBranch);
    assert!(left.contains("the worktree is gone"), "{left}");
    assert!(details.contains("not fully merged") || details.contains("not yet merged"), "{details}");
    assert!(!world.tree().exists());
    assert!(world.branch_exists("feat/x"));
    assert_eq!(git(&main, &["log", "-1", "--format=%s"]), "the work");
}

#[test]
fn a_result_that_does_not_hold_is_reported() {
    let world = World::new();
    let main = world.main();
    let target = world.target();
    let outcome = finish(&target, |step| {
        if step == Step::Confirm {
            git(&main, &["branch", "feat/x"]);
        }
    });
    let (step, _, left, _) = stopped(outcome);
    assert_eq!(step, Step::Confirm);
    assert!(left.contains("Branch feat/x still there: true"), "{left}");
}

#[test]
fn one_land_runs_per_repo() {
    let world = World::new();
    let target = world.target();
    let held = claim(world.main().to_str().unwrap(), Instant::now() + READS).unwrap();
    assert!(stopped(check(&target)).1.contains("Another land"));
    assert!(stopped(finish(&target, |_| {})).1.contains("Another land"));
    assert!(world.tree().exists());
    drop(held);
    assert!(matches!(finish(&target, |_| {}), Outcome::Landed { .. }));
}

#[test]
fn the_card_counts_against_local_main_not_the_remote() {
    let world = World::new();
    let main = world.main();
    git(world.base.as_path(), &["init", "-q", "--bare", "origin.git"]);
    git(&main, &["remote", "add", "origin", "../origin.git"]);
    git(&main, &["push", "-q", "-u", "origin", "main"]);
    world.commit(&main, "m.txt", "main\n", "not pushed");
    git(&world.tree(), &["rebase", "-q", "main"]);
    let lists = worktrees::list(&[main.to_str().unwrap().to_owned()]);
    let listed = &lists[0].as_ref().unwrap()[0];
    assert_eq!(listed.ahead, Some(1));
    assert_eq!(listed.unmerged, Some(2));
    assert_eq!(listed.main.as_deref(), Some("main"));
    assert_eq!(listed.repo, main.to_str().unwrap());
}

#[test]
fn the_check_is_found_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let at = dir.path();
    assert_eq!(find_check(at), Ok(None));

    fs::write(at.join("Makefile"), "build:\n\tcc\ncheck: build\n\ttrue\n").unwrap();
    assert_eq!(find_check(at), Ok(Some("make check".to_owned())));

    fs::write(at.join("package.json"), r#"{"scripts":{"test":"vitest"}}"#).unwrap();
    assert_eq!(find_check(at), Ok(Some("make check".to_owned())), "test is not check");

    fs::write(at.join("package.json"), r#"{"scripts":{"check":"tsc"}}"#).unwrap();
    assert_eq!(find_check(at), Ok(Some("npm run check".to_owned())));

    fs::write(at.join("pnpm-lock.yaml"), "").unwrap();
    assert_eq!(find_check(at), Ok(Some("pnpm run check".to_owned())));

    fs::create_dir(at.join(".herdr")).unwrap();
    fs::write(at.join(CONFIG), r#"{"check": " cargo test "}"#).unwrap();
    assert_eq!(find_check(at), Ok(Some("cargo test".to_owned())));
}

#[test]
fn a_makefile_mentioning_check_has_no_check_target() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("Makefile"), "# check: not a target\nall:\n\ttrue\n").unwrap();
    assert_eq!(find_check(dir.path()), Ok(None));
}

#[test]
fn a_config_that_cannot_be_used_refuses_rather_than_skipping_the_check() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join(".herdr")).unwrap();
    fs::write(dir.path().join("package.json"), r#"{"scripts":{"check":"tsc"}}"#).unwrap();
    for text in ["not json", "{}", r#"{"check": "  "}"#] {
        fs::write(dir.path().join(CONFIG), text).unwrap();
        assert!(find_check(dir.path()).is_err(), "{text}");
    }
    fs::remove_file(dir.path().join(CONFIG)).unwrap();
    fs::create_dir(dir.path().join(CONFIG)).unwrap();
    assert!(find_check(dir.path()).is_err(), "unreadable");
}
