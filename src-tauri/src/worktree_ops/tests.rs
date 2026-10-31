use super::*;
use std::{cell::Cell, fs, process::Command};

/// Runs Git in `dir` as a throwaway author, failing the test if it fails.
fn git(dir: &Path, args: &[&str]) -> String {
    let output = run_git(dir, args);
    assert!(output.status.success(), "{args:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn run_git(dir: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap()
}

/// A repo on `main` with `a.txt` and `dir/b.txt` committed, and a folder
/// standing in for the Trash.
struct World {
    root: tempfile::TempDir,
    bin: tempfile::TempDir,
    binned: Cell<u32>,
    running: sync::Running,
}

impl World {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "-q", "-b", "main"]);
        let world = Self {
            root,
            bin: tempfile::tempdir().unwrap(),
            binned: Cell::new(0),
            running: sync::Running::default(),
        };
        world.write("a.txt", "committed\n");
        world.write("dir/b.txt", "committed b\n");
        world.git(&["add", "."]);
        world.git(&["commit", "-q", "-m", "first"]);
        world
    }

    fn path(&self) -> &Path {
        self.root.path()
    }

    fn checkout(&self) -> String {
        self.path().to_string_lossy().into_owned()
    }

    fn git(&self, args: &[&str]) -> String {
        git(self.path(), args)
    }

    fn write(&self, path: &str, text: &str) {
        let file = self.path().join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }

    fn read(&self, path: &str) -> Option<String> {
        fs::read_to_string(self.path().join(path)).ok()
    }

    fn exists(&self, path: &str) -> bool {
        fs::symlink_metadata(self.path().join(path)).is_ok()
    }

    /// `status --short`, for what the index and tree look like now.
    fn short(&self) -> String {
        self.git(&["status", "--short"])
    }

    fn plan(&self, path: &str) -> Plan {
        discard_plan(&self.checkout(), path, Some("main"))
    }

    fn fingerprint(&self, path: &str) -> String {
        match self.plan(path) {
            Plan::Ready { fingerprint, .. } => fingerprint,
            Plan::Refused { message } => panic!("{message}"),
        }
    }

    fn refusal(&self, path: &str) -> String {
        match self.plan(path) {
            Plan::Refused { message } => message,
            ready @ Plan::Ready { .. } => panic!("{ready:?}"),
        }
    }

    fn effect(&self, path: &str) -> Effect {
        match self.plan(path) {
            Plan::Ready { effect, .. } => effect,
            Plan::Refused { message } => panic!("{message}"),
        }
    }

    /// Moves what it is given to the stand-in Trash, as the real one does.
    fn keep_in_bin(&self, path: &Path) -> Result<(), String> {
        let count = self.binned.get() + 1;
        self.binned.set(count);
        let name = path.file_name().unwrap().to_string_lossy();
        fs::rename(path, self.bin.path().join(format!("{count}-{name}"))).map_err(|e| e.to_string())
    }

    fn binned(&self) -> Vec<(String, String)> {
        let mut files: Vec<_> = fs::read_dir(self.bin.path())
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                let name = entry.file_name().to_string_lossy().into_owned();
                let (_, name) = name.split_once('-').unwrap();
                (name.to_owned(), fs::read_to_string(entry.path()).unwrap())
            })
            .collect();
        files.sort();
        files
    }

    fn discard_with(&self, path: &str, fingerprint: &str) -> Outcome {
        let bin = |file: &Path| self.keep_in_bin(file);
        discard_into(&self.running, &self.checkout(), path, fingerprint, Some("main"), &bin)
    }

    /// Plans and confirms at once, as the dialog does with nothing in between.
    fn discard(&self, path: &str) -> Outcome {
        self.discard_with(path, &self.fingerprint(path))
    }
}

fn failure(outcome: Outcome) -> String {
    match outcome {
        Outcome::Failed { message, .. } => message,
        Outcome::Done => panic!("it went ahead"),
    }
}

fn text(world: &World, path: &str) -> String {
    world.read(path).unwrap_or_else(|| panic!("{path} is gone"))
}

#[test]
fn a_modified_file_is_saved_then_restored() {
    let world = World::new();
    world.write("a.txt", "edited\n");
    assert_eq!(world.effect("a.txt"), Effect::Revert);
    assert_eq!(world.discard("a.txt"), Outcome::Done);
    assert_eq!(text(&world, "a.txt"), "committed\n");
    assert_eq!(world.binned(), [("a.txt".to_owned(), "edited\n".to_owned())]);
    assert_eq!(world.short(), "");
}

#[test]
fn a_file_with_staged_and_unstaged_changes_goes_all_the_way_back() {
    let world = World::new();
    world.write("a.txt", "staged\n");
    world.git(&["add", "a.txt"]);
    world.write("a.txt", "worked on\n");
    let Plan::Ready { drops_staged, .. } = world.plan("a.txt") else { panic!() };
    assert!(drops_staged);
    assert_eq!(world.discard("a.txt"), Outcome::Done);
    assert_eq!(text(&world, "a.txt"), "committed\n");
    assert_eq!(world.short(), "");
    assert_eq!(world.binned(), [("a.txt".to_owned(), "worked on\n".to_owned())]);
}

#[test]
fn a_plain_edit_has_nothing_staged_to_drop() {
    let world = World::new();
    world.write("a.txt", "edited\n");
    let Plan::Ready { drops_staged, additions, deletions, .. } = world.plan("a.txt") else { panic!() };
    assert!(!drops_staged);
    assert_eq!((additions, deletions), (Some(1), Some(1)));
}

#[test]
fn a_staged_new_file_is_saved_then_unstaged_and_deleted() {
    let world = World::new();
    world.write("new.txt", "new\n");
    world.git(&["add", "new.txt"]);
    assert_eq!(world.effect("new.txt"), Effect::Remove);
    assert_eq!(world.discard("new.txt"), Outcome::Done);
    assert!(!world.exists("new.txt"));
    assert_eq!(world.short(), "");
    assert_eq!(world.binned(), [("new.txt".to_owned(), "new\n".to_owned())]);
}

#[test]
fn an_intent_to_add_file_is_saved_then_removed() {
    let world = World::new();
    world.write("new.txt", "new\n");
    world.git(&["add", "-N", "new.txt"]);
    assert_eq!(world.discard("new.txt"), Outcome::Done);
    assert!(!world.exists("new.txt"));
    assert_eq!(world.short(), "");
    assert_eq!(world.binned().len(), 1);
}

#[test]
fn a_rename_restores_both_paths_in_one_go() {
    let world = World::new();
    world.git(&["mv", "a.txt", "moved.txt"]);
    assert_eq!(world.effect("moved.txt"), Effect::RenameBack);
    assert_eq!(world.discard("moved.txt"), Outcome::Done);
    assert_eq!(text(&world, "a.txt"), "committed\n");
    assert!(!world.exists("moved.txt"));
    assert_eq!(world.short(), "");
    assert_eq!(world.binned(), [("moved.txt".to_owned(), "committed\n".to_owned())]);
}

#[test]
fn a_renamed_and_edited_file_keeps_the_edit_in_the_trash() {
    let world = World::new();
    world.git(&["mv", "a.txt", "moved.txt"]);
    world.write("moved.txt", "committed\nedited\n");
    assert_eq!(world.discard("moved.txt"), Outcome::Done);
    assert_eq!(text(&world, "a.txt"), "committed\n");
    assert_eq!(world.short(), "");
    assert_eq!(world.binned(), [("moved.txt".to_owned(), "committed\nedited\n".to_owned())]);
}

#[test]
fn a_new_file_at_a_renames_old_path_is_saved_too() {
    let world = World::new();
    world.git(&["mv", "a.txt", "moved.txt"]);
    world.write("a.txt", "someone's new file\n");
    assert_eq!(world.discard("moved.txt"), Outcome::Done);
    assert_eq!(text(&world, "a.txt"), "committed\n");
    assert_eq!(
        world.binned(),
        [
            ("a.txt".to_owned(), "someone's new file\n".to_owned()),
            ("moved.txt".to_owned(), "committed\n".to_owned()),
        ]
    );
}

#[test]
fn a_deleted_file_comes_back_with_nothing_to_save() {
    let world = World::new();
    fs::remove_file(world.path().join("a.txt")).unwrap();
    assert_eq!(world.effect("a.txt"), Effect::BringBack);
    assert_eq!(world.discard("a.txt"), Outcome::Done);
    assert_eq!(text(&world, "a.txt"), "committed\n");
    assert_eq!(world.short(), "");
    assert!(world.binned().is_empty());
}

#[test]
fn a_staged_deletion_comes_back_too() {
    let world = World::new();
    world.git(&["rm", "-q", "a.txt"]);
    assert_eq!(world.discard("a.txt"), Outcome::Done);
    assert_eq!(text(&world, "a.txt"), "committed\n");
    assert_eq!(world.short(), "");
}

#[test]
fn a_file_left_behind_by_a_staged_deletion_is_saved_first() {
    let world = World::new();
    world.git(&["rm", "-q", "--cached", "a.txt"]);
    world.write("a.txt", "kept on disk\n");
    assert_eq!(world.discard("a.txt"), Outcome::Done);
    assert_eq!(text(&world, "a.txt"), "committed\n");
    assert_eq!(world.binned(), [("a.txt".to_owned(), "kept on disk\n".to_owned())]);
}

#[test]
fn an_untracked_file_moves_to_the_trash() {
    let world = World::new();
    world.write("note.txt", "scratch\n");
    assert_eq!(world.effect("note.txt"), Effect::Trash);
    assert_eq!(world.discard("note.txt"), Outcome::Done);
    assert!(!world.exists("note.txt"));
    assert_eq!(world.binned(), [("note.txt".to_owned(), "scratch\n".to_owned())]);
}

#[test]
fn an_untracked_folder_is_refused() {
    let world = World::new();
    world.write("folder/one.txt", "one\n");
    assert!(world.refusal("folder/").contains("is a folder"));
    assert!(world.exists("folder/one.txt"));
}

#[test]
fn a_tracked_file_replaced_by_a_folder_is_refused() {
    let world = World::new();
    fs::remove_file(world.path().join("a.txt")).unwrap();
    world.write("a.txt/inner.txt", "inner\n");
    assert!(world.refusal("a.txt").contains("is a folder"));
    assert_eq!(text(&world, "a.txt/inner.txt"), "inner\n");
}

#[test]
fn a_tracked_files_parent_replaced_by_a_file_is_refused() {
    let world = World::new();
    fs::remove_dir_all(world.path().join("dir")).unwrap();
    world.write("dir", "now a file\n");
    assert!(world.refusal("dir/b.txt").contains("not a folder"));
    assert_eq!(text(&world, "dir"), "now a file\n");
}

#[cfg(unix)]
#[test]
fn symlinks_are_refused() {
    let world = World::new();
    std::os::unix::fs::symlink("a.txt", world.path().join("link")).unwrap();
    assert!(world.refusal("link").contains("symlink"));
    world.git(&["add", "link"]);
    assert!(world.refusal("link").contains("symlink"));
    // A tracked file turned into a link.
    fs::remove_file(world.path().join("dir/b.txt")).unwrap();
    std::os::unix::fs::symlink("../a.txt", world.path().join("dir/b.txt")).unwrap();
    assert!(world.refusal("dir/b.txt").contains("symlink"));
    assert!(world.exists("link"));
}

#[test]
fn a_submodule_is_refused() {
    let world = World::new();
    let inner = tempfile::tempdir().unwrap();
    git(inner.path(), &["init", "-q", "-b", "main"]);
    git(inner.path(), &["commit", "-q", "--allow-empty", "-m", "inner"]);
    let url = inner.path().to_string_lossy().into_owned();
    world.git(&["-c", "protocol.file.allow=always", "submodule", "add", "-q", &url, "sub"]);
    world.git(&["commit", "-q", "-m", "add sub"]);
    world.write("sub/dirty.txt", "x\n");
    assert!(world.refusal("sub").contains("submodule"));
}

#[test]
fn a_conflict_is_refused() {
    let world = World::new();
    world.git(&["checkout", "-q", "-b", "other"]);
    world.write("a.txt", "theirs\n");
    world.git(&["commit", "-qam", "theirs"]);
    world.git(&["checkout", "-q", "main"]);
    world.write("a.txt", "ours\n");
    world.git(&["commit", "-qam", "ours"]);
    // Without a commit, a pick leaves a conflict and no operation to refuse on.
    let picked = run_git(world.path(), &["cherry-pick", "--no-commit", "other"]);
    assert!(!picked.status.success());
    assert!(world.refusal("a.txt").contains("conflict"));
}

#[test]
fn an_unborn_branch_has_nothing_to_restore_from_but_can_lose_an_untracked_file() {
    let root = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-q", "-b", "main"]);
    let world = World {
        root,
        bin: tempfile::tempdir().unwrap(),
        binned: Cell::new(0),
        running: sync::Running::default(),
    };
    world.write("staged.txt", "x\n");
    world.git(&["add", "staged.txt"]);
    world.write("note.txt", "y\n");
    assert!(world.refusal("staged.txt").contains("no commit"));
    assert_eq!(world.discard("note.txt"), Outcome::Done);
}

#[test]
fn a_glob_named_file_leaves_the_files_it_would_match_alone() {
    let world = World::new();
    for name in ["abc", "adef", "a*"] {
        world.write(name, "committed\n");
    }
    world.git(&["add", "."]);
    world.git(&["commit", "-q", "-m", "more"]);
    for name in ["abc", "adef", "a*"] {
        world.write(name, "edited\n");
    }
    assert_eq!(world.discard("a*"), Outcome::Done);
    assert_eq!(text(&world, "a*"), "committed\n");
    assert_eq!(text(&world, "abc"), "edited\n");
    assert_eq!(text(&world, "adef"), "edited\n");
    assert_eq!(world.binned(), [("a*".to_owned(), "edited\n".to_owned())]);
}

#[test]
fn a_change_after_the_plan_refuses_the_discard() {
    let world = World::new();
    world.write("a.txt", "yours\n");
    let fingerprint = world.fingerprint("a.txt");
    world.write("a.txt", "an agent's\n");
    assert!(failure(world.discard_with("a.txt", &fingerprint)).contains("changed"));
    assert_eq!(text(&world, "a.txt"), "an agent's\n");
    assert!(world.binned().is_empty());
}

#[test]
fn staging_after_the_plan_refuses_the_discard() {
    let world = World::new();
    world.write("a.txt", "yours\n");
    let fingerprint = world.fingerprint("a.txt");
    world.git(&["add", "a.txt"]);
    assert!(failure(world.discard_with("a.txt", &fingerprint)).contains("changed"));
    assert_eq!(text(&world, "a.txt"), "yours\n");
}

#[test]
fn a_commit_after_the_plan_refuses_the_discard() {
    let world = World::new();
    world.write("a.txt", "yours\n");
    let fingerprint = world.fingerprint("a.txt");
    world.git(&["commit", "-qam", "agent committed"]);
    world.write("a.txt", "yours\n ");
    assert!(failure(world.discard_with("a.txt", &fingerprint)).contains("changed"));
}

#[test]
fn an_untracked_file_rewritten_after_the_plan_stays() {
    let world = World::new();
    world.write("note.txt", "one\n");
    let fingerprint = world.fingerprint("note.txt");
    world.write("note.txt", "two\n");
    assert!(failure(world.discard_with("note.txt", &fingerprint)).contains("changed"));
    assert_eq!(text(&world, "note.txt"), "two\n");
}

#[test]
fn a_file_committed_after_the_plan_has_nothing_left_to_discard() {
    let world = World::new();
    world.write("a.txt", "yours\n");
    let fingerprint = world.fingerprint("a.txt");
    world.git(&["commit", "-qam", "agent committed"]);
    assert!(failure(world.discard_with("a.txt", &fingerprint)).contains("no changes"));
    assert_eq!(text(&world, "a.txt"), "yours\n");
}

#[test]
fn a_rebase_under_way_refuses_the_plan_and_the_discard() {
    let world = World::new();
    world.git(&["checkout", "-q", "-b", "other"]);
    world.write("a.txt", "theirs\n");
    world.git(&["commit", "-qam", "theirs"]);
    world.git(&["checkout", "-q", "main"]);
    world.write("a.txt", "ours\n");
    world.git(&["commit", "-qam", "ours"]);
    world.write("note.txt", "x\n");
    let fingerprint = world.fingerprint("note.txt");
    world.git(&["checkout", "-q", "other"]);
    let rebase = run_git(world.path(), &["rebase", "main"]);
    assert!(!rebase.status.success());
    let plan = discard_plan(&world.checkout(), "note.txt", None);
    assert!(matches!(&plan, Plan::Refused { message } if message.contains("rebase")), "{plan:?}");
    let bin = |file: &Path| world.keep_in_bin(file);
    let outcome = discard_into(&world.running, &world.checkout(), "note.txt", &fingerprint, None, &bin);
    assert!(failure(outcome).contains("rebase"));
    assert!(world.exists("note.txt"));
}

#[test]
fn a_checkout_that_moved_branch_is_left_alone() {
    let world = World::new();
    world.write("a.txt", "edited\n");
    let fingerprint = world.fingerprint("a.txt");
    world.git(&["checkout", "-q", "-b", "elsewhere"]);
    assert!(failure(world.discard_with("a.txt", &fingerprint)).contains("moved"));
    assert_eq!(text(&world, "a.txt"), "edited\n");
}

#[test]
fn a_failed_trash_stops_with_the_file_untouched() {
    let world = World::new();
    world.write("a.txt", "edited\n");
    world.write("new.txt", "new\n");
    world.git(&["add", "new.txt"]);
    world.write("note.txt", "untracked\n");
    let bin = |_: &Path| Err("the Trash is full".to_owned());
    for (path, kept) in [("a.txt", "edited\n"), ("new.txt", "new\n"), ("note.txt", "untracked\n")] {
        let fingerprint = world.fingerprint(path);
        let outcome = discard_into(&world.running, &world.checkout(), path, &fingerprint, Some("main"), &bin);
        assert!(failure(outcome).contains("left as it was"));
        assert_eq!(text(&world, path), kept);
    }
    assert!(world.short().contains("A  new.txt"), "{}", world.short());
}

#[test]
fn nothing_of_the_temporary_copy_stays_behind() {
    let world = World::new();
    world.write("a.txt", "edited\n");
    assert_eq!(world.discard("a.txt"), Outcome::Done);
    let left = fs::read_dir(world.path().join(".git"))
        .unwrap()
        .filter(|entry| entry.as_ref().unwrap().file_name().to_string_lossy().starts_with("herdr-discard"))
        .count();
    assert_eq!(left, 0);
}

#[test]
fn another_agents_staged_file_stays_staged() {
    let world = World::new();
    world.write("dir/b.txt", "agent's\n");
    world.git(&["add", "dir/b.txt"]);
    world.write("a.txt", "edited\n");
    assert_eq!(world.discard("a.txt"), Outcome::Done);
    assert_eq!(world.short(), "M  dir/b.txt");
    assert_eq!(text(&world, "dir/b.txt"), "agent's\n");
}

#[test]
fn a_linked_worktree_keeps_its_copy_in_its_own_git_folder() {
    let world = World::new();
    let tree = tempfile::tempdir().unwrap();
    let linked = tree.path().join("linked");
    world.git(&["worktree", "add", "-q", "-b", "feature", &linked.to_string_lossy()]);
    fs::write(linked.join("a.txt"), "edited\n").unwrap();
    let checkout = linked.to_string_lossy().into_owned();
    let Plan::Ready { fingerprint, .. } = discard_plan(&checkout, "a.txt", Some("feature")) else { panic!() };
    let bin = |file: &Path| world.keep_in_bin(file);
    let outcome = discard_into(&world.running, &checkout, "a.txt", &fingerprint, Some("feature"), &bin);
    assert_eq!(outcome, Outcome::Done);
    assert_eq!(fs::read_to_string(linked.join("a.txt")).unwrap(), "committed\n");
}

#[test]
fn a_path_that_leaves_the_checkout_or_has_no_changes_is_refused() {
    let world = World::new();
    world.write("a.txt", "edited\n");
    assert!(world.refusal("../outside").contains("not a path inside"));
    assert!(world.refusal("/etc/hosts").contains("not a path inside"));
    assert!(world.refusal("dir/../a.txt").contains("not a path inside"));
    assert!(world.refusal("dir/b.txt").contains("no changes"));
    assert!(world.refusal(".git/config").contains("no changes"));
}

#[test]
fn a_running_operation_turns_the_discard_away() {
    let world = World::new();
    world.write("a.txt", "edited\n");
    let fingerprint = world.fingerprint("a.txt");
    let root = fs::canonicalize(world.path()).unwrap();
    let _claim = world.running.claim(&root.to_string_lossy()).unwrap();
    let outcome = world.discard_with("a.txt", &fingerprint);
    assert!(matches!(outcome, Outcome::Failed { reason: Reason::Busy, .. }), "{outcome:?}");
    assert_eq!(text(&world, "a.txt"), "edited\n");
}
