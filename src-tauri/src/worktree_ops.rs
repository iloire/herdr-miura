//! The Changes panel's writes to the working tree. `changes.rs` promises it
//! never writes and `sync.rs` is for what crosses the network, so discarding a
//! file is here. It runs under the same one-operation-per-checkout claim and
//! the same check of the branch as a sync.
//!
//! A discard is two calls, as a land is: [`discard_plan`] reads what it would
//! do and a fingerprint of the file, and [`discard_file`] refuses if the file
//! no longer matches it, since an agent may have written to it while the
//! dialog was open. What is thrown away goes to the Trash first, which is the
//! only undo there is, so a failure there stops the discard.
//!
//! Every path Git reads here is literal: `*` is a legal filename character,
//! and without `--literal-pathspecs` a file named `a*` takes `abc` with it.

use crate::{
    changes::{
        self,
        parse::{self, FileChange, Kind},
    },
    git,
    sync::{self, Outcome, Reason},
};
use serde::Serialize;
use std::{
    fs, io,
    path::Path,
    time::{Duration, Instant},
};

/// How long the reads before a write may take.
const CHECKS: Duration = Duration::from_secs(5);
/// Stands in the fingerprint for a file that is not on disk.
const ABSENT: &str = "-";
/// A Git file mode that is not a plain file.
const SYMLINK_MODE: &str = "120000";
const SUBMODULE_MODE: &str = "160000";

/// What a discard does to a file, for the dialog to say.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    /// Goes back to the last commit.
    Revert,
    /// New since the last commit, so it goes away.
    Remove,
    /// Goes back to its old name and the last commit's content.
    RenameBack,
    /// Comes back from the last commit.
    BringBack,
    /// Untracked, so it moves to the Trash.
    Trash,
}

/// What the confirmation shows, or why asking would be pointless.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Plan {
    Ready {
        effect: Effect,
        old_path: Option<String>,
        additions: Option<u64>,
        deletions: Option<u64>,
        /// The index holds a version of its own, which is not kept.
        drops_staged: bool,
        /// A copy of the working file goes to the Trash.
        keeps_copy: bool,
        fingerprint: String,
    },
    Refused {
        message: String,
    },
}

/// A file a discard can act on, as it is now.
struct Found {
    file: FileChange,
    born: bool,
    /// Its paths that hold a file on disk, which is what must be saved first.
    on_disk: Vec<String>,
    fingerprint: String,
}

impl Found {
    /// Its paths, a rename's old one too: restoring only the new one deletes it
    /// and leaves the old one deleted.
    fn paths(&self) -> Vec<&str> {
        let old = self.file.old_path.as_deref();
        std::iter::once(self.file.path.as_str()).chain(old).collect()
    }
}

/// `field` of a status entry: `<type> <XY> <submodule> <mH> <mI> <mW> ...`.
fn field(file: &FileChange, field: usize) -> &str {
    file.entry.split(' ').nth(field).unwrap_or_default()
}

fn has_mode(file: &FileChange, mode: &str) -> bool {
    file.kind != Kind::Untracked && (3..=5).any(|index| field(file, index) == mode)
}

/// Why this entry cannot be discarded whatever is on disk.
fn refusal(file: &FileChange, born: bool) -> Option<String> {
    let path = &file.path;
    if file.kind == Kind::Conflicted {
        Some(format!("{path} has a conflict. Resolve it first."))
    } else if field(file, 2).starts_with('S') || has_mode(file, SUBMODULE_MODE) {
        Some(format!("{path} is a submodule, which can't be discarded here."))
    } else if has_mode(file, SYMLINK_MODE) {
        Some(format!("{path} is a symlink, which can't be discarded here."))
    } else if path.ends_with('/') {
        Some(format!("{path} is a folder, which can't be discarded here."))
    } else if !born && file.kind != Kind::Untracked {
        Some(format!("{path} has no commit to go back to, since this branch has none yet."))
    } else {
        None
    }
}

/// Whether a plain file is at `path`. Anything else there is refused, a parent
/// that is not a folder too, or Git would replace it to make the path.
fn plain_file(root: &str, path: &str) -> Result<bool, String> {
    let root = Path::new(root);
    for parent in Path::new(path).ancestors().skip(1) {
        match fs::symlink_metadata(root.join(parent)) {
            Ok(metadata) if !metadata.is_dir() => {
                return Err(format!("{path} sits under {}, which is not a folder.", parent.display()));
            }
            _ => {}
        }
    }
    match fs::symlink_metadata(root.join(path)) {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(metadata) if metadata.is_symlink() => {
            Err(format!("{path} is a symlink, which can't be discarded here."))
        }
        Ok(metadata) if metadata.is_dir() => {
            Err(format!("{path} is a folder, which can't be discarded here."))
        }
        Ok(_) => Err(format!("{path} is not a plain file.")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Could not read {path}: {error}")),
    }
}

fn working_hash(root: &str, path: &str, deadline: Instant) -> Result<String, git::Error> {
    git::text(
        root,
        &["hash-object", "--no-filters", "--", path],
        "hash the file",
        deadline,
    )
}

/// Reads the file now, from the whole status: `status -- <path>` hides a
/// rename. The entry holds the HEAD and index hashes and the hash covers the
/// working file, so the fingerprint covers all three versions.
fn inspect(root: &str, path: &str, deadline: Instant) -> Result<Found, String> {
    if !changes::stays_inside(path) {
        return Err(format!("{path} is not a path inside the checkout."));
    }
    let status = changes::read_status(root, deadline).map_err(|error| error.to_string())?;
    let born = status.born;
    let file = status
        .files
        .into_iter()
        .find(|file| file.path == path)
        .ok_or_else(|| format!("{path} has no changes any more."))?;
    if let Some(refused) = refusal(&file, born) {
        return Err(refused);
    }
    let mut found = Found {
        born,
        on_disk: Vec::new(),
        fingerprint: format!("{}\0{}", file.entry, file.old_path.as_deref().unwrap_or(ABSENT)),
        file,
    };
    let paths: Vec<String> = found.paths().into_iter().map(str::to_owned).collect();
    for path in paths {
        let hash = if plain_file(root, &path)? {
            let hash = working_hash(root, &path, deadline).map_err(|error| error.to_string())?;
            found.on_disk.push(path);
            hash
        } else {
            ABSENT.to_owned()
        };
        found.fingerprint.push('\0');
        found.fingerprint.push_str(&hash);
    }
    // Only a deletion or a rename whose new name was then deleted has none.
    if found.on_disk.is_empty() && !matches!(found.file.kind, Kind::Deleted | Kind::Renamed) {
        return Err(format!("{path} is gone from disk."));
    }
    Ok(found)
}

fn effect_of(file: &FileChange) -> Effect {
    let added = field(file, 1).starts_with('A');
    match file.kind {
        Kind::Untracked => Effect::Trash,
        Kind::Renamed if file.old_path.is_some() => Effect::RenameBack,
        Kind::Deleted if !added => Effect::BringBack,
        Kind::Modified => Effect::Revert,
        Kind::Added | Kind::Deleted | Kind::Renamed | Kind::Conflicted => Effect::Remove,
    }
}

/// The index and the working file both differ from what is below them.
fn drops_staged(file: &FileChange) -> bool {
    let mut sides = field(file, 1).chars();
    file.kind != Kind::Untracked
        && sides.next().is_some_and(|staged| staged != '.')
        && sides.next().is_some_and(|working| working != '.')
}

/// Line counts are a nicety: a failure keeps the plan without them.
fn counted(mut found: Found, root: &str, deadline: Instant) -> Found {
    if found.born && found.file.kind != Kind::Untracked {
        let start = ["--literal-pathspecs", "diff", "--numstat", "-z", "-M", "HEAD", "--"];
        let args = [&start[..], &found.paths()].concat();
        if let Ok(numstat) = git::text(root, &args, "count changed lines", deadline) {
            parse::apply_numstat(std::slice::from_mut(&mut found.file), &numstat);
        }
    }
    found
}

/// What a discard of `path` would do, read when the dialog opens.
pub fn discard_plan(checkout: &str, path: &str, branch: Option<&str>) -> Plan {
    let deadline = Instant::now() + CHECKS;
    let read = || {
        let root = changes::checkout_root(checkout, deadline).map_err(|error| error.to_string())?;
        sync::current_branch(&root, branch, deadline).map_err(|refused| match refused {
            Outcome::Failed { message, .. } => message,
            Outcome::Done => String::new(),
        })?;
        let found = inspect(&root, path, deadline)?;
        Ok::<_, String>(counted(found, &root, deadline))
    };
    match read() {
        Ok(found) => Plan::Ready {
            effect: effect_of(&found.file),
            drops_staged: drops_staged(&found.file),
            keeps_copy: !found.on_disk.is_empty(),
            old_path: found.file.old_path,
            additions: found.file.additions,
            deletions: found.file.deletions,
            fingerprint: found.fingerprint,
        },
        Err(message) => Plan::Refused { message },
    }
}

/// Sends a file to the Trash; what [`discard_file`] does through a parameter,
/// so tests leave the real one alone.
type Bin<'a> = &'a dyn Fn(&Path) -> Result<(), String>;

/// The Finder method the `trash` crate defaults to scripts the Finder through
/// `osascript`; see plan-git-actions.md for why it is not used.
fn to_trash(path: &Path) -> Result<(), String> {
    #[allow(unused_mut)]
    let mut context = trash::TrashContext::new();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        context.set_delete_method(DeleteMethod::NsFileManager);
    }
    context.delete(path).map_err(|error| error.to_string())
}

/// Puts a copy of the working file in the Trash under its own name, leaving the
/// file where it is. The copy is made inside the Git folder: it is on the same
/// volume as the file, and no status or agent will see it there.
fn copy_to_trash(root: &str, git_dir: &str, path: &str, bin: Bin) -> Result<(), String> {
    let name = Path::new(path)
        .file_name()
        .ok_or_else(|| format!("{path} has no file name."))?;
    let holder = tempfile::Builder::new()
        .prefix("herdr-discard-")
        .tempdir_in(git_dir)
        .map_err(|error| error.to_string())?;
    let copy = holder.path().join(name);
    fs::copy(Path::new(root).join(path), &copy).map_err(|error| error.to_string())?;
    bin(&copy)
}

/// Discards `path`, if it still matches `fingerprint` and the checkout is on
/// the branch on show with no rebase or merge under way.
pub fn discard_file(
    running: &sync::Running,
    checkout: &str,
    path: &str,
    fingerprint: &str,
    branch: Option<&str>,
) -> Outcome {
    discard_into(running, checkout, path, fingerprint, branch, &to_trash)
}

fn discard_into(
    running: &sync::Running,
    checkout: &str,
    path: &str,
    fingerprint: &str,
    branch: Option<&str>,
    bin: Bin,
) -> Outcome {
    let checks = Instant::now() + CHECKS;
    let (root, _claim) = match sync::claim_checkout(running, checkout, checks) {
        Ok(claimed) => claimed,
        Err(refused) => return refused,
    };
    if let Err(refused) = sync::current_branch(&root, branch, checks) {
        return refused;
    }
    let found = match inspect(&root, path, checks) {
        Ok(found) => found,
        Err(message) => return Outcome::other(message),
    };
    if found.fingerprint != fingerprint {
        return Outcome::other(format!(
            "{path} changed after this dialog opened, so nothing was discarded."
        ));
    }
    if found.file.kind == Kind::Untracked {
        return match bin(&Path::new(&root).join(path)) {
            Ok(()) => Outcome::Done,
            Err(error) => not_trashed(path, error),
        };
    }
    let git_dir = match git::text(&root, &["rev-parse", "--absolute-git-dir"], "find the Git folder", checks) {
        Ok(git_dir) => git_dir,
        Err(error) => return Outcome::other(error.to_string()),
    };
    for saved in &found.on_disk {
        if let Err(error) = copy_to_trash(&root, &git_dir, saved, bin) {
            return not_trashed(path, error);
        }
    }
    let start = ["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--"];
    let args = [&start[..], &found.paths()].concat();
    match git::supervised(&root, &args, "discard the change", Instant::now() + sync::LIMIT) {
        Ok(done) if done.success => Outcome::Done,
        Ok(done) => Outcome::failed(
            Reason::Other,
            format!("Git did not discard {path}. It may hold a copy in the Trash too."),
            done.stderr,
        ),
        Err(error) => sync::timed_out(error),
    }
}

fn not_trashed(path: &str, error: String) -> Outcome {
    Outcome::failed(
        Reason::Other,
        format!("{path} could not go to the Trash, so it was left as it was."),
        error,
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
