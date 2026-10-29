//! Starting a workspace's team: one tab per role, named after the role, that
//! runs `claude --agent <agent>` in the workspace's folder. The roles come
//! from the folder's `.herdr/team.json`, which the webview reads and parses.
//!
//! Herdr answers `tab.create` over the socket only later, as an event, and
//! cannot start a program in the tab it makes, so this runs the `herdr` CLI
//! as `tab_move` does: `tab create` hands back the tab's pane, and `pane run`
//! types the command into it.

use crate::tab_move::{Error, checked, herdr, run};
use serde::Deserialize;
use std::path::Path;

/// More roles than this is a mistake in the file, not a team.
pub const MAX_MEMBERS: usize = 12;

/// One role to start: the tab's name and the Claude Code agent it runs.
#[derive(Debug, Clone, Deserialize)]
pub struct Member {
    pub role: String,
    pub agent: String,
}

/// A role or agent name: what `.claude/agents/<name>.md` can be called, so it
/// can never be read as an option or carry anything a terminal would act on.
fn name(text: &str) -> Result<&str, Error> {
    let fits = (1..=32).contains(&text.len())
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !text.starts_with('-');
    if fits { Ok(text) } else { Err(Error::InvalidId(text.into())) }
}

#[derive(Deserialize)]
struct Created {
    root_pane: CreatedPane,
}

#[derive(Deserialize)]
struct CreatedPane {
    pane_id: String,
}

/// Opens a tab in `workspace` at `directory` for each member and starts its
/// agent there, in order. Blocking: run off the main thread.
pub fn start(workspace: &str, directory: &str, members: &[Member]) -> Result<(), Error> {
    checked(workspace)?;
    if members.is_empty() || members.len() > MAX_MEMBERS {
        return Err(Error::Empty);
    }
    for member in members {
        name(&member.role)?;
        name(&member.agent)?;
    }
    if !Path::new(directory).is_absolute() || !Path::new(directory).is_dir() {
        return Err(Error::InvalidId(directory.into()));
    }
    let cli = herdr()?;
    for member in members {
        let created = run(
            &cli,
            &[
                "tab",
                "create",
                "--workspace",
                workspace,
                "--cwd",
                directory,
                "--label",
                &member.role,
                "--no-focus",
            ],
        )?;
        let pane = serde_json::from_value::<Created>(created)
            .map_err(Error::Decode)?
            .root_pane
            .pane_id;
        run(
            &cli,
            &["pane", "run", checked(&pane)?, "claude", "--agent", &member.agent],
        )?;
    }
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum CreateError {
    #[error("`{0}` is not a folder on this Mac")]
    NotFolder(String),
    #[error("this workspace already has a team: edit {0}")]
    Exists(String),
    #[error("could not write {path}")]
    Write {
        path: String,
        #[source]
        source: std::io::Error,
    },
}

/// The starter team New team writes: the team file, then an agent per role.
const STARTER: &[(&str, &str)] = &[
    (".herdr/team.json", include_str!("../templates/team/team.json")),
    (".claude/agents/lead.md", include_str!("../templates/team/lead.md")),
    (".claude/agents/reviewer.md", include_str!("../templates/team/reviewer.md")),
    (".claude/agents/qa.md", include_str!("../templates/team/qa.md")),
];

/// Writes the starter team into the folder `directory`, refusing a folder
/// that already has a team file and keeping any agent file already there,
/// so the repo's own roles win. Returns the files it wrote.
pub fn create(directory: &str) -> Result<Vec<String>, CreateError> {
    let root = Path::new(directory);
    if !root.is_absolute() || !root.is_dir() {
        return Err(CreateError::NotFolder(directory.into()));
    }
    let mut written = Vec::new();
    for (i, (path, text)) in STARTER.iter().enumerate() {
        let full = root.join(path);
        let write = || {
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::io::Write::write_all(
                &mut std::fs::OpenOptions::new().write(true).create_new(true).open(&full)?,
                text.as_bytes(),
            )
        };
        match write() {
            Ok(()) => written.push((*path).to_owned()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // The team file comes first, so an existing one stops here, before any agent.
                if i == 0 {
                    return Err(CreateError::Exists((*path).to_owned()));
                }
            }
            Err(source) => {
                return Err(CreateError::Write {
                    path: (*path).to_owned(),
                    source,
                });
            }
        }
    }
    Ok(written)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn new_team_writes_the_starter_and_keeps_what_is_there() {
        let dir = std::env::temp_dir().join(format!("herdr-team-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude/agents")).unwrap();
        std::fs::write(dir.join(".claude/agents/qa.md"), "mine").unwrap();
        let root = dir.to_str().unwrap();
        let written = create(root).unwrap();
        assert_eq!(written, [".herdr/team.json", ".claude/agents/lead.md", ".claude/agents/reviewer.md"]);
        assert_eq!(std::fs::read_to_string(dir.join(".claude/agents/qa.md")).unwrap(), "mine");
        assert!(matches!(create(root), Err(CreateError::Exists(_))));
        assert!(matches!(create("relative"), Err(CreateError::NotFolder(_))));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_starter_team_names_an_agent_file_for_every_role() {
        let team: serde_json::Value = serde_json::from_str(STARTER[0].1).unwrap();
        for member in team["members"].as_array().unwrap() {
            let file = format!(".claude/agents/{}.md", member["role"].as_str().unwrap());
            assert!(STARTER.iter().any(|(path, _)| *path == file), "{file}");
        }
    }

    #[test]
    fn names_are_plain_words() {
        for good in ["cto", "front-end", "qa_2"] {
            assert!(name(good).is_ok(), "{good:?}");
        }
        for bad in ["", "-x", "a b", "a;b", "a\n", "../cto", &"x".repeat(33)] {
            assert!(name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_team_must_have_members() {
        assert!(matches!(start("w1", "/tmp", &[]), Err(Error::Empty)));
    }

    #[test]
    fn a_tab_create_result_names_its_pane() {
        let result = serde_json::json!({"type": "tab_created", "tab": {"tab_id": "w1:t9"}, "root_pane": {"pane_id": "w1:p9"}});
        let created: Created = serde_json::from_value(result).unwrap();
        assert_eq!(created.root_pane.pane_id, "w1:p9");
    }
}
