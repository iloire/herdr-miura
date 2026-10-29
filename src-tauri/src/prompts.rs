//! The prompt library's files: Claude Code's custom commands, `*.md` under
//! `~/.claude/commands/` and under a workspace folder's `.claude/commands/`.
//! Each file comes back with its text or why it cannot be used, never left
//! out, so the palette can show a broken one. What the text means (its
//! frontmatter, which file wins a name) is the webview's `promptLibrary.ts`.
//! Nothing here writes.

use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

/// Files read per folder; the listing says when there were more.
const MAX_FILES: usize = 500;
/// Folders below the commands folder that are read.
const MAX_DEPTH: usize = 3;
/// A prompt's bytes at most.
const MAX_BYTES: u64 = 256 << 10;

#[derive(Debug, Serialize, PartialEq)]
pub struct PromptFile {
    /// Relative to the commands folder, with `/` between parts.
    pub path: String,
    pub text: Option<String>,
    /// Why `text` is missing.
    pub problem: Option<String>,
}

#[derive(Debug, Serialize, Default)]
pub struct Folder {
    /// The commands folder read, absolute.
    pub dir: String,
    pub files: Vec<PromptFile>,
    /// More than `MAX_FILES` were there.
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct Library {
    pub global: Option<Folder>,
    pub project: Option<Folder>,
}

/// The global folder under `home`, and the project folder under `directory`
/// when it is an absolute folder. A project file is resolved through
/// symlinks and refused when it leaves `directory`; global ones may be links
/// into dotfiles, so they are followed. Blocking.
pub fn library(home: Option<&Path>, directory: Option<&str>) -> Library {
    let global = home.map(|home| read_folder(&home.join(".claude/commands"), None));
    let project = directory
        .map(Path::new)
        .filter(|dir| dir.is_absolute() && dir.is_dir())
        .and_then(|dir| fs::canonicalize(dir).ok())
        .map(|root| read_folder(&root.join(".claude/commands"), Some(&root)));
    Library { global, project }
}

fn read_folder(dir: &Path, root: Option<&Path>) -> Folder {
    let mut folder = Folder {
        dir: dir.to_string_lossy().into_owned(),
        ..Folder::default()
    };
    let mut found = Vec::new();
    walk(dir, 0, &mut found);
    found.sort();
    folder.truncated = found.len() > MAX_FILES;
    found.truncate(MAX_FILES);
    folder.files = found
        .into_iter()
        .map(|path| {
            let relative = path
                .strip_prefix(dir)
                .unwrap_or(&path)
                .components()
                .map(|part| part.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            match read(&path, root) {
                Ok(text) => PromptFile {
                    path: relative,
                    text: Some(text),
                    problem: None,
                },
                Err(problem) => PromptFile {
                    path: relative,
                    text: None,
                    problem: Some(problem),
                },
            }
        })
        .collect();
    folder
}

/// Every `.md` file under `dir`, `MAX_DEPTH` folders down at most, symlinks
/// followed (the depth bounds a loop). Stops collecting once past the cap.
fn walk(dir: &Path, depth: usize, found: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if found.len() > MAX_FILES {
            return;
        }
        let path = entry.path();
        let Ok(meta) = fs::metadata(&path) else {
            // A dangling link is still a prompt you meant to have.
            if path.extension().is_some_and(|e| e == "md") {
                found.push(path);
            }
            continue;
        };
        if meta.is_dir() {
            if depth < MAX_DEPTH {
                walk(&path, depth + 1, found);
            }
        } else if path.extension().is_some_and(|e| e == "md") {
            found.push(path);
        }
    }
}

/// A file's text, or why it cannot be a prompt.
fn read(path: &Path, root: Option<&Path>) -> Result<String, String> {
    let full = fs::canonicalize(path).map_err(|_| "it is a link to a file that is not there".to_owned())?;
    if root.is_some_and(|root| !full.starts_with(root)) {
        return Err("it is a link that leaves the workspace folder".into());
    }
    let file = fs::File::open(&full).map_err(|error| format!("it could not be read: {error}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("it could not be read: {error}"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(format!("it is over {} KiB", MAX_BYTES >> 10));
    }
    String::from_utf8(bytes).map_err(|_| "it is not UTF-8 text".into())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn file(path: &str, text: &str) -> PromptFile {
        PromptFile {
            path: path.into(),
            text: Some(text.into()),
            problem: None,
        }
    }

    #[test]
    fn reads_both_folders_and_subfolders_in_path_order() {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let global = home.path().join(".claude/commands");
        let project = repo.path().join(".claude/commands");
        fs::create_dir_all(global.join("git")).unwrap();
        fs::create_dir_all(&project).unwrap();
        fs::write(global.join("review.md"), "Review it").unwrap();
        fs::write(global.join("git/land.md"), "Land it").unwrap();
        fs::write(global.join("notes.txt"), "not a prompt").unwrap();
        fs::write(project.join("review.md"), "Review this repo").unwrap();

        let library = library(Some(home.path()), repo.path().to_str());
        let global = library.global.unwrap();
        assert_eq!(global.files, vec![file("git/land.md", "Land it"), file("review.md", "Review it")]);
        assert!(!global.truncated);
        assert_eq!(library.project.unwrap().files, vec![file("review.md", "Review this repo")]);
    }

    #[test]
    fn missing_folders_are_empty_and_a_relative_directory_is_none() {
        let home = tempfile::tempdir().unwrap();
        let library = library(Some(home.path()), Some("relative/path"));
        assert!(library.global.unwrap().files.is_empty());
        assert!(library.project.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_project_link_out_of_the_folder_is_a_problem_but_a_global_one_is_followed() {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let target = elsewhere.path().join("secret.md");
        fs::write(&target, "outside").unwrap();
        let global = home.path().join(".claude/commands");
        let project = repo.path().join(".claude/commands");
        fs::create_dir_all(&global).unwrap();
        fs::create_dir_all(&project).unwrap();
        std::os::unix::fs::symlink(&target, global.join("dotfiles.md")).unwrap();
        std::os::unix::fs::symlink(&target, project.join("escape.md")).unwrap();
        std::os::unix::fs::symlink(elsewhere.path().join("gone.md"), project.join("gone.md")).unwrap();

        let library = library(Some(home.path()), repo.path().to_str());
        assert_eq!(library.global.unwrap().files, vec![file("dotfiles.md", "outside")]);
        let project = library.project.unwrap().files;
        assert_eq!(project[0].path, "escape.md");
        assert_eq!(project[0].text, None);
        assert!(project[0].problem.as_deref().unwrap().contains("leaves the workspace folder"));
        assert_eq!(project[1].path, "gone.md");
        assert!(project[1].problem.is_some());
    }

    #[test]
    fn large_and_binary_files_are_problems() {
        let home = tempfile::tempdir().unwrap();
        let global = home.path().join(".claude/commands");
        fs::create_dir_all(&global).unwrap();
        fs::write(global.join("big.md"), vec![b'a'; (MAX_BYTES + 1) as usize]).unwrap();
        fs::write(global.join("bytes.md"), [0xff, 0xfe, 0x00]).unwrap();
        let files = library(Some(home.path()), None).global.unwrap().files;
        assert!(files[0].problem.as_deref().unwrap().contains("KiB"));
        assert!(files[1].problem.as_deref().unwrap().contains("UTF-8"));
    }
}
