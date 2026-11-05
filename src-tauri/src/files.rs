//! The Files panel's reads: every file a checkout holds, as Git lists them
//! (tracked, and untracked ones not ignored), on request the ignored ones with
//! the folders they fill read one at a time, and one file's contents for
//! the file view: its text, or an image's bytes. `write` saves an edited
//! text file back, unless something else changed it first.

use crate::git;
use base64::Engine;
use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

/// How long one listing may take before Git is stopped.
const DEADLINE: Duration = Duration::from_secs(10);
/// Files listed per checkout; the rest are only counted.
const MAX_FILES: usize = 50_000;
/// Listing bytes Git may print, NUL-separated paths.
const MAX_LISTING_BYTES: usize = 16 << 20;
/// A text file's bytes shown at most.
const MAX_TEXT_BYTES: u64 = 1 << 20;
/// An image's bytes shown at most.
const MAX_IMAGE_BYTES: u64 = 8 << 20;
/// Entries listed per ignored folder; `node_modules` can hold a great many.
const MAX_FOLDER_ENTRIES: usize = 5_000;
/// Bytes looked at for a NUL, which marks a binary.
const BINARY_SNIFF: usize = 8000;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Git(#[from] git::Error),
    #[error("{0} is not a path inside the checkout")]
    OutsideCheckout(String),
    #[error("{0} is not a file")]
    NotFile(String),
    #[error("could not read the file")]
    Read(#[source] std::io::Error),
    #[error("could not write the file")]
    Write(#[source] std::io::Error),
}

#[derive(Debug, Serialize)]
pub struct Listing {
    /// The checkout's top folder, which every path is relative to.
    root: String,
    /// Sorted, with `/` between parts.
    files: Vec<String>,
    total_files: usize,
    /// Ignored files, and ignored folders whole with a trailing `/`, when
    /// asked for; empty otherwise.
    ignored: Vec<String>,
}

/// A file named in a pane's text: its checkout, and its path inside that.
#[derive(Debug, Serialize)]
pub struct FoundFile {
    root: String,
    path: String,
}

/// What the file view shows for one file.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Contents {
    Text {
        text: String,
    },
    /// Base64 bytes with their media type, shown as an image.
    Image {
        mime: &'static str,
        data: String,
    },
    Binary {
        size: u64,
    },
    TooLarge {
        size: u64,
    },
}

/// The top folder of the checkout `directory` sits in.
fn toplevel(directory: &str, deadline: Instant) -> Result<String, git::Error> {
    git::text(
        directory,
        &["rev-parse", "--path-format=absolute", "--show-toplevel"],
        "find the checkout",
        deadline,
    )
}

/// NUL-separated paths as sorted strings.
fn paths(listing: &[u8]) -> Vec<String> {
    let mut paths: Vec<String> = listing
        .split(|&byte| byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect();
    paths.sort_unstable();
    paths.dedup();
    paths
}

/// The files of the checkout `directory` sits in, or `None` outside Git. With
/// `ignored`, the ignored ones too, a folder Git ignores whole as one entry so
/// `node_modules` costs a line.
pub fn list(directory: &str, ignored: bool) -> Result<Option<Listing>, Error> {
    let deadline = Instant::now() + DEADLINE;
    let Ok(root) = toplevel(directory, deadline) else {
        return Ok(None);
    };
    let listing = git::run(
        &root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--deduplicate",
        ],
        "list the files",
        deadline,
        MAX_LISTING_BYTES,
    )?;
    let mut files = paths(&listing);
    let total_files = files.len();
    files.truncate(MAX_FILES);
    let ignored = if ignored {
        let listing = git::run(
            &root,
            &[
                "ls-files",
                "-z",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
            ],
            "list the ignored files",
            deadline,
            MAX_LISTING_BYTES,
        )?;
        let mut ignored = paths(&listing);
        ignored.truncate(MAX_FILES);
        ignored
    } else {
        Vec::new()
    };
    Ok(Some(Listing {
        root,
        files,
        total_files,
        ignored,
    }))
}

/// What the folder at `path` in the checkout at `root` holds, one level, as
/// paths from the checkout with a trailing `/` on folders. For a folder Git
/// ignores whole, whose files it never lists.
pub fn list_folder(root: &str, path: &str) -> Result<Vec<String>, Error> {
    let full = inside(root, path)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&full).map_err(Error::Read)?.flatten() {
        if entries.len() == MAX_FOLDER_ENTRIES {
            break;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        // A symlinked folder is followed only by `inside`, on opening it.
        let folder = fs::metadata(entry.path()).is_ok_and(|meta| meta.is_dir());
        entries.push(format!("{path}/{name}{}", if folder { "/" } else { "" }));
    }
    entries.sort_unstable();
    Ok(entries)
}

/// The file `name` means from `directory`: an absolute or `~/` path as it is, a
/// relative one from there, then from that checkout's top, as agents write
/// them. Its checkout is its own, which need not be `directory`'s. `None` when
/// no such file is in a checkout.
pub fn find(directory: &str, name: &str) -> Option<FoundFile> {
    let deadline = Instant::now() + DEADLINE;
    let named = match name.strip_prefix("~/") {
        Some(rest) => PathBuf::from(std::env::var_os("HOME")?).join(rest),
        None => PathBuf::from(name),
    };
    let top = toplevel(directory, deadline).ok();
    let full = [Some(directory), top.as_deref()]
        .into_iter()
        .flatten()
        .filter_map(|folder| fs::canonicalize(Path::new(folder).join(&named)).ok())
        .find(|full| full.is_file())?;
    let root = toplevel(full.parent()?.to_str()?, deadline).ok()?;
    let path = full.strip_prefix(fs::canonicalize(&root).ok()?).ok()?;
    Some(FoundFile {
        path: path.to_str()?.to_owned(),
        root,
    })
}

/// `path` under `root`, after resolving symlinks, refused when it leaves
/// the checkout. The webview sends both back, so neither is trusted.
pub fn inside(root: &str, path: &str) -> Result<PathBuf, Error> {
    let outside = || Error::OutsideCheckout(path.into());
    if path.is_empty()
        || !Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(outside());
    }
    let root = fs::canonicalize(root).map_err(|_| outside())?;
    let full = fs::canonicalize(root.join(path)).map_err(Error::Read)?;
    if !full.starts_with(&root) {
        return Err(outside());
    }
    Ok(full)
}

/// The media type an image file is shown with, by its extension.
fn image_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        // An <img> never runs an SVG's scripts.
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// Up to `limit` bytes of `path`, or `None` when it holds more.
fn read_bounded(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, Error> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(limit + 1).read_to_end(&mut bytes))
        .map_err(Error::Read)?;
    Ok((bytes.len() as u64 <= limit).then_some(bytes))
}

/// The file at `path` in the checkout at `root`, as the file view shows it.
pub fn read(root: &str, path: &str) -> Result<Contents, Error> {
    let full = inside(root, path)?;
    let metadata = fs::metadata(&full).map_err(Error::Read)?;
    if !metadata.is_file() {
        return Err(Error::NotFile(path.into()));
    }
    let size = metadata.len();
    if let Some(mime) = image_type(&full) {
        return Ok(match read_bounded(&full, MAX_IMAGE_BYTES)? {
            Some(bytes) => Contents::Image {
                mime,
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            },
            None => Contents::TooLarge { size },
        });
    }
    let Some(bytes) = read_bounded(&full, MAX_TEXT_BYTES)? else {
        return Ok(Contents::TooLarge { size });
    };
    if bytes.iter().take(BINARY_SNIFF).any(|&byte| byte == 0) {
        return Ok(Contents::Binary { size });
    }
    Ok(match String::from_utf8(bytes) {
        Ok(text) => Contents::Text { text },
        Err(_) => Contents::Binary { size },
    })
}

/// Puts `text` in the existing file at `path`, unless it no longer holds
/// `base`, which agents working in the same checkout make likely. No `base`
/// overwrites. Answers whether it wrote. It goes through a file beside the real
/// one and a rename, so a full disk leaves the old contents whole.
pub fn write(root: &str, path: &str, text: &str, base: Option<&str>) -> Result<bool, Error> {
    let full = inside(root, path)?;
    let metadata = fs::metadata(&full).map_err(Error::Read)?;
    if !metadata.is_file() {
        return Err(Error::NotFile(path.into()));
    }
    if let Some(base) = base
        && fs::read(&full).map_err(Error::Read)? != base.as_bytes()
    {
        return Ok(false);
    }
    let mut temp = full.clone().into_os_string();
    temp.push(".herdr-save");
    let temp = PathBuf::from(temp);
    let written = fs::write(&temp, text)
        .and_then(|()| fs::set_permissions(&temp, metadata.permissions()))
        .and_then(|()| fs::rename(&temp, &full));
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written.map(|()| true).map_err(Error::Write)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(["-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    }

    /// A checkout with a committed file, an untracked one, and an ignored one.
    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        fs::create_dir(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/a.rs"), "fn a() {}\n").unwrap();
        fs::write(dir.path().join(".gitignore"), "target/\n").unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-q", "-m", "first"]);
        fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();
        fs::create_dir(dir.path().join("target")).unwrap();
        fs::write(dir.path().join("target/out"), "built\n").unwrap();
        dir
    }

    fn root(dir: &tempfile::TempDir) -> String {
        dir.path().to_string_lossy().into_owned()
    }

    #[test]
    fn lists_tracked_and_untracked_files_but_not_ignored_ones() {
        let dir = repo();
        let listing = list(&dir.path().join("src").to_string_lossy(), false)
            .unwrap()
            .unwrap();
        assert_eq!(listing.files, [".gitignore", "new.txt", "src/a.rs"]);
        assert_eq!(listing.total_files, 3);
        assert!(listing.ignored.is_empty());
        assert_eq!(
            fs::canonicalize(&listing.root).unwrap(),
            fs::canonicalize(dir.path()).unwrap()
        );
    }

    #[test]
    fn lists_ignored_files_on_request_with_ignored_folders_whole() {
        let dir = repo();
        fs::write(dir.path().join(".gitignore"), "target/\n.env.local\n").unwrap();
        fs::write(dir.path().join(".env.local"), "SECRET=1\n").unwrap();
        fs::create_dir(dir.path().join("target/deep")).unwrap();
        fs::write(dir.path().join("target/deep/x"), "x\n").unwrap();
        let listing = list(&root(&dir), true).unwrap().unwrap();
        assert_eq!(listing.ignored, [".env.local", "target/"]);
        assert_eq!(
            list_folder(&listing.root, "target").unwrap(),
            ["target/deep/", "target/out"]
        );
        assert!(list_folder(&listing.root, "../x").is_err());
    }

    #[test]
    fn finds_a_file_from_the_folder_then_the_checkouts_top() {
        let dir = repo();
        let top = list(&root(&dir), false).unwrap().unwrap().root;
        let sub = format!("{top}/src");
        for (from, name) in [(&top, "src/a.rs"), (&sub, "a.rs"), (&sub, "src/a.rs"), (&sub, "../src/a.rs")] {
            let found = find(from, name).unwrap();
            assert_eq!((found.root.as_str(), found.path.as_str()), (top.as_str(), "src/a.rs"));
        }
        assert_eq!(find(&sub, &format!("{top}/src/a.rs")).unwrap().path, "src/a.rs");
        assert_eq!(find(&top, "target/out").unwrap().path, "target/out");
    }

    #[test]
    fn a_file_in_a_worktree_belongs_to_the_worktree() {
        let dir = repo();
        let top = list(&root(&dir), false).unwrap().unwrap().root;
        let worktree = format!("{top}/target/wt");
        git(dir.path(), &["worktree", "add", "-q", "-b", "wt", &worktree]);
        let found = find(&top, &format!("{worktree}/src/a.rs")).unwrap();
        assert_eq!((found.root.as_str(), found.path.as_str()), (worktree.as_str(), "src/a.rs"));
    }

    #[test]
    fn finds_no_folder_missing_file_or_file_outside_git() {
        let dir = repo();
        let top = root(&dir);
        assert!(find(&top, "src").is_none());
        assert!(find(&top, "and/or").is_none());
        assert!(find(&top, &format!("{top}/.git/config")).is_none());
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("a.txt"), "one\n").unwrap();
        assert!(find(&top, &format!("{}/a.txt", root(&outside))).is_none());
    }

    #[test]
    fn outside_git_is_no_listing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list(&root(&dir), false).unwrap().is_none());
    }

    #[test]
    fn reads_text_images_and_binaries() {
        let dir = repo();
        let root = root(&dir);
        assert!(
            matches!(read(&root, "src/a.rs").unwrap(), Contents::Text { text } if text == "fn a() {}\n")
        );
        fs::write(dir.path().join("dot.png"), [0x89, b'P', b'N', b'G', 0]).unwrap();
        assert!(
            matches!(read(&root, "dot.png").unwrap(), Contents::Image { mime: "image/png", data } if data == "iVBORwA=")
        );
        fs::write(dir.path().join("blob.bin"), [1, 0, 2]).unwrap();
        assert!(matches!(
            read(&root, "blob.bin").unwrap(),
            Contents::Binary { size: 3 }
        ));
        let big = vec![b'a'; (MAX_TEXT_BYTES + 1) as usize];
        fs::write(dir.path().join("big.txt"), big).unwrap();
        assert!(matches!(
            read(&root, "big.txt").unwrap(),
            Contents::TooLarge { .. }
        ));
    }

    #[test]
    fn refuses_paths_that_leave_the_checkout() {
        let dir = repo();
        let root = root(&dir);
        for path in ["../etc/passwd", "/etc/passwd", "src/../../x", ""] {
            assert!(
                matches!(read(&root, path), Err(Error::OutsideCheckout(_))),
                "{path}"
            );
        }
        assert!(matches!(read(&root, "src"), Err(Error::NotFile(_))));
    }

    #[test]
    fn writes_over_what_it_was_told_is_there() {
        let dir = repo();
        let root = root(&dir);
        assert!(write(&root, "src/a.rs", "fn b() {}\n", Some("fn a() {}\n")).unwrap());
        assert_eq!(
            fs::read_to_string(dir.path().join("src/a.rs")).unwrap(),
            "fn b() {}\n"
        );
        assert_eq!(fs::read_dir(dir.path().join("src")).unwrap().count(), 1);
    }

    #[test]
    fn leaves_a_file_that_changed_since_it_was_read() {
        let dir = repo();
        let root = root(&dir);
        assert!(!write(&root, "src/a.rs", "mine\n", Some("stale\n")).unwrap());
        assert_eq!(
            fs::read_to_string(dir.path().join("src/a.rs")).unwrap(),
            "fn a() {}\n"
        );
        assert!(write(&root, "src/a.rs", "mine\n", None).unwrap());
        assert_eq!(
            fs::read_to_string(dir.path().join("src/a.rs")).unwrap(),
            "mine\n"
        );
    }

    #[test]
    fn writes_only_files_inside_the_checkout() {
        let dir = repo();
        let root = root(&dir);
        assert!(matches!(
            write(&root, "../x", "", None),
            Err(Error::OutsideCheckout(_))
        ));
        assert!(matches!(
            write(&root, "src", "", None),
            Err(Error::NotFile(_))
        ));
        assert!(matches!(
            write(&root, "missing.txt", "", None),
            Err(Error::Read(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn saving_keeps_a_file_executable_and_a_symlink_a_link() {
        use std::os::unix::fs::PermissionsExt;
        let dir = repo();
        let root = root(&dir);
        let script = dir.path().join("run.sh");
        fs::write(&script, "old\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink("run.sh", dir.path().join("link")).unwrap();
        assert!(write(&root, "link", "new\n", Some("old\n")).unwrap());
        assert_eq!(fs::read_to_string(&script).unwrap(), "new\n");
        let mode = fs::metadata(&script).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
        assert!(fs::symlink_metadata(dir.path().join("link"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_out_of_the_checkout() {
        let dir = repo();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "x").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), dir.path().join("link")).unwrap();
        assert!(matches!(
            read(&root(&dir), "link"),
            Err(Error::OutsideCheckout(_))
        ));
    }
}
