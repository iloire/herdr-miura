//! The prompt library's files: Claude Code's custom commands, `*.md` under
//! `~/.claude/commands/` and under a workspace folder's `.claude/commands/`.
//! Each file comes back with its text or why it cannot be used, never left
//! out, so the palette can show a broken one. What the text means (its
//! frontmatter, which file wins a name) is the webview's `promptLibrary.ts`.
//! `create` adds a new file and never touches one that exists. `save` replaces
//! one, refused when it is no longer the text the edit began from.

use serde::Serialize;
use std::{
    fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
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

#[derive(Debug, thiserror::Error)]
pub enum CreateError {
    #[error("“{0}” is not a prompt name: use letters, digits, - and _")]
    Name(String),
    #[error("the prompt is over {} KiB", MAX_BYTES >> 10)]
    TooLarge,
    #[error("could not find the folder to put the prompt in")]
    NoFolder,
    #[error("the workspace's .claude/commands is a link out of its folder")]
    Outside,
    #[error("{0} already exists")]
    Exists(String),
    #[error("could not write {0}: {1}")]
    Write(String, #[source] io::Error),
}

#[derive(Debug, thiserror::Error)]
pub enum SaveError {
    #[error("“{0}” is not a prompt in the commands folder")]
    Path(String),
    #[error("the prompt is over {} KiB", MAX_BYTES >> 10)]
    TooLarge,
    #[error("could not find the folder the prompt is in")]
    NoFolder,
    #[error("{0} can't be saved: {1}")]
    Unusable(String, String),
    #[error("{0} changed on disk after you began editing. Your edit is still here: Save again to replace the file with it")]
    Changed(String),
    #[error("could not write {0}: {1}")]
    Write(String, #[source] io::Error),
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

/// Writes a new prompt `<name>.md`: into `directory`'s `.claude/commands/`,
/// or the global folder when there is no `directory`. A file of that name is
/// left alone and refused. Blocking.
pub fn create(home: Option<&Path>, directory: Option<&str>, name: &str, text: &str) -> Result<(), CreateError> {
    let mut chars = name.chars();
    let first = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    if !first || !chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(CreateError::Name(name.to_owned()));
    }
    if text.len() as u64 > MAX_BYTES {
        return Err(CreateError::TooLarge);
    }
    let file = format!("{name}.md");
    let Some(directory) = directory else {
        let dir = home.ok_or(CreateError::NoFolder)?.join(".claude/commands");
        return create_global(&dir, &file, text);
    };
    let root = Path::new(directory);
    if !root.is_absolute() {
        return Err(CreateError::NoFolder);
    }
    let root = fs::canonicalize(root).map_err(|_| CreateError::NoFolder)?;
    let dir = root.join(".claude/commands");
    fs::create_dir_all(&dir).map_err(|error| failed(&dir, error))?;
    if !fs::canonicalize(&dir).is_ok_and(|real| real.starts_with(&root)) {
        return Err(CreateError::Outside);
    }
    write_new(&dir.join(file), text)
}

/// A global folder whose files are links into dotfiles stays that way: the
/// new file goes beside what they point at and is linked here too, so it is
/// not the one loose file a reprovision loses.
fn create_global(dir: &Path, file: &str, text: &str) -> Result<(), CreateError> {
    let link = dir.join(file);
    if link.symlink_metadata().is_ok() {
        return Err(CreateError::Exists(link.display().to_string()));
    }
    let Some(linked) = linked_folder(dir) else {
        fs::create_dir_all(dir).map_err(|error| failed(dir, error))?;
        return write_new(&link, text);
    };
    let real = linked.join(file);
    write_new(&real, text)?;
    std::os::unix::fs::symlink(&real, &link).map_err(|error| {
        let _ = fs::remove_file(&real);
        failed(&link, error)
    })
}

/// The folder the first link among `dir`'s prompts points into.
fn linked_folder(dir: &Path) -> Option<PathBuf> {
    let mut entries: Vec<_> = fs::read_dir(dir).ok()?.flatten().map(|entry| entry.path()).collect();
    entries.sort();
    entries.into_iter().find_map(|path| {
        let link = path.symlink_metadata().ok()?.is_symlink() && path.extension().is_some_and(|e| e == "md");
        link.then(|| fs::canonicalize(&path).ok()?.parent().map(Path::to_path_buf)).flatten()
    })
}

/// Writes a file that must not exist yet.
fn write_new(path: &Path, text: &str) -> Result<(), CreateError> {
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            CreateError::Exists(path.display().to_string())
        } else {
            failed(path, error)
        }
    })?;
    file.write_all(text.as_bytes()).map_err(|error| failed(path, error))
}

/// Replaces the prompt at `path`, relative to `directory`'s `.claude/commands/`
/// or the global folder without a `directory`, when it still holds `expected`.
/// A link is written through, so a prompt in dotfiles stays there, and a
/// project one that leaves its folder is refused as it is when read. The new
/// text arrives whole, by rename, so a failed write leaves the old file. Blocking.
pub fn save(home: Option<&Path>, directory: Option<&str>, path: &str, expected: &str, text: &str) -> Result<(), SaveError> {
    let relative = Path::new(path);
    let inside = relative.components().all(|part| matches!(part, Component::Normal(_)));
    if !inside || relative.extension().is_none_or(|e| e != "md") {
        return Err(SaveError::Path(path.to_owned()));
    }
    if text.len() as u64 > MAX_BYTES {
        return Err(SaveError::TooLarge);
    }
    let root = directory.map(Path::new);
    if root.is_some_and(|root| !root.is_absolute()) {
        return Err(SaveError::NoFolder);
    }
    let root = root.map(fs::canonicalize).transpose().map_err(|_| SaveError::NoFolder)?;
    let base = root.clone().or_else(|| home.map(Path::to_path_buf)).ok_or(SaveError::NoFolder)?;
    let file = base.join(".claude/commands").join(relative);
    let current = read(&file, root.as_deref()).map_err(|problem| SaveError::Unusable(path.to_owned(), problem))?;
    if current != expected {
        return Err(SaveError::Changed(path.to_owned()));
    }
    let real = fs::canonicalize(&file).map_err(|error| SaveError::Write(path.to_owned(), error))?;
    replace(&real, text).map_err(|error| SaveError::Write(real.display().to_string(), error))
}

/// Writes `text` beside `path`, with its permissions, and renames it over.
fn replace(path: &Path, text: &str) -> io::Result<()> {
    let temporary = path.with_extension("md.saving");
    let written = fs::write(&temporary, text)
        .and_then(|()| fs::set_permissions(&temporary, fs::metadata(path)?.permissions()))
        .and_then(|()| fs::rename(&temporary, path));
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

fn failed(path: &Path, error: io::Error) -> CreateError {
    CreateError::Write(path.display().to_string(), error)
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
    fn creates_in_the_project_making_the_folder_and_never_overwrites() {
        let repo = tempfile::tempdir().unwrap();
        let directory = repo.path().to_str();
        create(None, directory, "land-it", "Land it\n").unwrap();
        let path = repo.path().join(".claude/commands/land-it.md");
        assert_eq!(fs::read_to_string(&path).unwrap(), "Land it\n");

        assert!(matches!(create(None, directory, "land-it", "Other"), Err(CreateError::Exists(_))));
        assert_eq!(fs::read_to_string(&path).unwrap(), "Land it\n");
    }

    #[test]
    fn a_name_cannot_leave_the_commands_folder() {
        let repo = tempfile::tempdir().unwrap();
        for name in ["../up", "a/b", "", "-x", "a.b", "a b"] {
            assert!(matches!(create(None, repo.path().to_str(), name, "x"), Err(CreateError::Name(_))), "{name}");
        }
        assert!(matches!(create(None, Some("relative"), "ok", "x"), Err(CreateError::NoFolder)));
    }

    #[test]
    fn creates_globally_in_a_plain_folder() {
        let home = tempfile::tempdir().unwrap();
        create(Some(home.path()), None, "plain", "Plain").unwrap();
        let path = home.path().join(".claude/commands/plain.md");
        assert!(!path.symlink_metadata().unwrap().is_symlink());
        assert_eq!(fs::read_to_string(path).unwrap(), "Plain");
    }

    #[cfg(unix)]
    #[test]
    fn a_global_prompt_follows_the_links_into_dotfiles() {
        let home = tempfile::tempdir().unwrap();
        let dotfiles = tempfile::tempdir().unwrap();
        let global = home.path().join(".claude/commands");
        fs::create_dir_all(&global).unwrap();
        fs::write(dotfiles.path().join("old.md"), "Old").unwrap();
        std::os::unix::fs::symlink(dotfiles.path().join("old.md"), global.join("old.md")).unwrap();

        create(Some(home.path()), None, "new", "New").unwrap();
        assert_eq!(fs::read_to_string(dotfiles.path().join("new.md")).unwrap(), "New");
        assert!(global.join("new.md").symlink_metadata().unwrap().is_symlink());
        assert_eq!(fs::read_to_string(global.join("new.md")).unwrap(), "New");

        assert!(matches!(create(Some(home.path()), None, "new", "Again"), Err(CreateError::Exists(_))));
        assert_eq!(fs::read_to_string(dotfiles.path().join("new.md")).unwrap(), "New");
    }

    #[cfg(unix)]
    #[test]
    fn a_project_commands_link_out_of_the_folder_is_refused() {
        let repo = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        fs::create_dir_all(repo.path().join(".claude")).unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), repo.path().join(".claude/commands")).unwrap();
        assert!(matches!(create(None, repo.path().to_str(), "out", "x"), Err(CreateError::Outside)));
        assert!(!elsewhere.path().join("out.md").exists());
    }

    #[test]
    fn saving_replaces_a_prompt_but_not_one_that_changed_since() {
        let repo = tempfile::tempdir().unwrap();
        let directory = repo.path().to_str();
        create(None, directory, "land", "Old").unwrap();
        let path = repo.path().join(".claude/commands/land.md");

        save(None, directory, "land.md", "Old", "New").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "New");

        assert!(matches!(save(None, directory, "land.md", "Old", "Stale"), Err(SaveError::Changed(_))));
        assert_eq!(fs::read_to_string(&path).unwrap(), "New");
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn saving_reaches_only_a_prompt_that_is_there() {
        let repo = tempfile::tempdir().unwrap();
        let directory = repo.path().to_str();
        fs::create_dir_all(repo.path().join(".claude/commands")).unwrap();
        fs::write(repo.path().join("outside.md"), "Secret").unwrap();
        for path in ["../../outside.md", "/etc/hosts.md", "land.txt"] {
            assert!(matches!(save(None, directory, path, "Secret", "x"), Err(SaveError::Path(_))), "{path}");
        }
        assert!(matches!(save(None, directory, "gone.md", "", "x"), Err(SaveError::Unusable(..))));
        assert!(!repo.path().join(".claude/commands/gone.md").exists());
        assert!(matches!(save(None, Some("relative"), "a.md", "", "x"), Err(SaveError::NoFolder)));
        assert_eq!(fs::read_to_string(repo.path().join("outside.md")).unwrap(), "Secret");
    }

    #[cfg(unix)]
    #[test]
    fn saving_a_global_link_writes_through_it() {
        let home = tempfile::tempdir().unwrap();
        let dotfiles = tempfile::tempdir().unwrap();
        let global = home.path().join(".claude/commands");
        fs::create_dir_all(&global).unwrap();
        let real = dotfiles.path().join("remind.md");
        fs::write(&real, "Old").unwrap();
        std::os::unix::fs::symlink(&real, global.join("remind.md")).unwrap();

        save(Some(home.path()), None, "remind.md", "Old", "New").unwrap();
        assert_eq!(fs::read_to_string(&real).unwrap(), "New");
        assert!(global.join("remind.md").symlink_metadata().unwrap().is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn saving_a_project_link_out_of_the_folder_is_refused() {
        let repo = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let target = elsewhere.path().join("secret.md");
        fs::write(&target, "Secret").unwrap();
        let project = repo.path().join(".claude/commands");
        fs::create_dir_all(&project).unwrap();
        std::os::unix::fs::symlink(&target, project.join("escape.md")).unwrap();

        assert!(matches!(save(None, repo.path().to_str(), "escape.md", "Secret", "x"), Err(SaveError::Unusable(..))));
        assert_eq!(fs::read_to_string(&target).unwrap(), "Secret");
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
