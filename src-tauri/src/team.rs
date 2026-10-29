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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

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
