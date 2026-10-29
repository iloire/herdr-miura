//! The Files panel's reads: every file a checkout holds, as Git lists them
//! (tracked, and untracked ones not ignored), and one file's contents for
//! the file view: its text, or an image's bytes. Nothing here writes.

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
}

#[derive(Debug, Serialize)]
pub struct Listing {
    /// The checkout's top folder, which every path is relative to.
    root: String,
    /// Sorted, with `/` between parts.
    files: Vec<String>,
    total_files: usize,
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

/// The files of the checkout `directory` sits in, or `None` outside Git.
pub fn list(directory: &str) -> Result<Option<Listing>, Error> {
    let deadline = Instant::now() + DEADLINE;
    let Ok(root) = git::text(
        directory,
        &["rev-parse", "--path-format=absolute", "--show-toplevel"],
        "find the checkout",
        deadline,
    ) else {
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
    let mut files: Vec<String> = listing
        .split(|&byte| byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect();
    files.sort_unstable();
    files.dedup();
    let total_files = files.len();
    files.truncate(MAX_FILES);
    Ok(Some(Listing {
        root,
        files,
        total_files,
    }))
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
        let listing = list(&dir.path().join("src").to_string_lossy())
            .unwrap()
            .unwrap();
        assert_eq!(listing.files, [".gitignore", "new.txt", "src/a.rs"]);
        assert_eq!(listing.total_files, 3);
        assert_eq!(
            fs::canonicalize(&listing.root).unwrap(),
            fs::canonicalize(dir.path()).unwrap()
        );
    }

    #[test]
    fn outside_git_is_no_listing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list(&root(&dir)).unwrap().is_none());
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
