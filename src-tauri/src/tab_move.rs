//! Moving a tab to another workspace, ported from herdr-gpui's `pane_move`.
//!
//! Herdr does not advertise `pane.move` to GUI clients, so the move runs the
//! `herdr` CLI, which reaches the same session through the environment this
//! app inherited (`HERDR_SESSION`, `HERDR_SOCKET_PATH`). The first pane opens
//! a new tab in the destination; the others join it on its right, and a tab
//! that was named keeps its name. The snapshot that follows shows the result.

use serde::Deserialize;
use std::{
    env,
    path::{Path, PathBuf},
};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("`{0}` is not a pane, tab, or workspace id")]
    InvalidId(String),
    #[error("the tab has no panes")]
    Empty,
    #[error("could not find the `herdr` command")]
    MissingCli,
    #[error("could not run `herdr`")]
    Spawn(#[source] std::io::Error),
    /// Herdr's message, and its error code when it gave one.
    #[error("Herdr refused: {message}")]
    Refused { code: Option<String>, message: String },
    #[error("Herdr did not move the pane")]
    Unchanged,
    #[error("Herdr answered in a form this app does not read")]
    Decode(#[source] serde_json::Error),
    #[error("moved the first pane, but {pane} did not follow: {source}")]
    Partial {
        pane: String,
        #[source]
        source: Box<Error>,
    },
}

/// Where a GUI app opened from the Dock may not look, as herdr-gpui's host
/// scripts add them.
const EXTRA_DIRS: &[&str] = &[
    ".local/bin",
    ".local/share/mise/shims",
    ".bun/bin",
    ".cargo/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ".nix-profile/bin",
];

/// An id the CLI takes as one argument: non-empty, never read as an option,
/// and free of control characters.
pub(crate) fn checked(id: &str) -> Result<&str, Error> {
    if id.is_empty() || id.starts_with('-') || id.chars().any(char::is_control) {
        return Err(Error::InvalidId(id.into()));
    }
    Ok(id)
}

pub(crate) fn herdr() -> Result<PathBuf, Error> {
    let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let path = env::var_os("PATH").unwrap_or_default();
    env::split_paths(&path)
        .chain(EXTRA_DIRS.iter().map(|dir| {
            if Path::new(dir).is_absolute() {
                PathBuf::from(dir)
            } else {
                home.join(dir)
            }
        }))
        .map(|dir| dir.join("herdr"))
        .find(|candidate| candidate.is_file())
        .ok_or(Error::MissingCli)
}

#[derive(Deserialize)]
struct Envelope {
    result: Option<serde_json::Value>,
    error: Option<ErrorBody>,
}

#[derive(Deserialize)]
struct ErrorBody {
    #[serde(default)]
    code: Option<String>,
    message: String,
}

#[derive(Deserialize)]
struct MoveResult {
    move_result: Outcome,
}

#[derive(Deserialize)]
struct Outcome {
    changed: bool,
    #[serde(default)]
    pane: Option<Moved>,
    #[serde(default)]
    created_tab: Option<Moved>,
}

#[derive(Deserialize)]
struct Moved {
    tab_id: String,
}

/// Runs `herdr args…` and returns its result, or Herdr's own error message,
/// which the CLI prints as the last line of either stream.
pub(crate) fn run(cli: &Path, args: &[&str]) -> Result<serde_json::Value, Error> {
    let output = crate::process::command(cli)
        .args(args)
        .output()
        .map_err(Error::Spawn)?;
    let text = [&output.stdout[..], &output.stderr[..]].concat();
    let text = String::from_utf8_lossy(&text);
    let envelope = text
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Envelope>(line.trim()).ok());
    match envelope {
        Some(Envelope {
            error: Some(error), ..
        }) => Err(Error::Refused {
            code: error.code,
            message: error.message,
        }),
        Some(Envelope {
            result: Some(result),
            ..
        }) if output.status.success() => Ok(result),
        _ => Err(Error::Refused {
            code: None,
            message: text.trim().chars().take(300).collect(),
        }),
    }
}

/// The tab a move left the pane in.
fn moved_to(result: serde_json::Value) -> Result<String, Error> {
    let outcome = serde_json::from_value::<MoveResult>(result)
        .map_err(Error::Decode)?
        .move_result;
    if !outcome.changed {
        return Err(Error::Unchanged);
    }
    outcome
        .created_tab
        .or(outcome.pane)
        .map(|moved| moved.tab_id)
        .ok_or(Error::Unchanged)
}

/// Moves `panes`, a tab's panes in order, into a new tab of `workspace`, and
/// names it `label` when the tab had been named. Blocking: run off the main thread.
pub fn move_tab(panes: &[String], workspace: &str, label: Option<&str>) -> Result<(), Error> {
    let (first, rest) = panes.split_first().ok_or(Error::Empty)?;
    for id in panes.iter().map(String::as_str).chain([workspace]) {
        checked(id)?;
    }
    let label = label.map(str::trim).filter(|label| !label.is_empty());
    if let Some(label) = label
        && label.chars().any(char::is_control)
    {
        return Err(Error::InvalidId(label.into()));
    }
    let cli = herdr()?;
    let tab = moved_to(run(
        &cli,
        &[
            "pane",
            "move",
            first,
            "--new-tab",
            "--workspace",
            workspace,
            "--focus",
        ],
    )?)?;
    for pane in rest {
        run(
            &cli,
            &[
                "pane", "move", pane, "--tab", &tab, "--split", "right", "--focus",
            ],
        )
        .and_then(moved_to)
        .map_err(|source| Error::Partial {
            pane: pane.clone(),
            source: Box::new(source),
        })?;
    }
    if let Some(label) = label {
        run(&cli, &["tab", "rename", &tab, label])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids_that_could_be_options_or_carry_controls_are_refused() {
        assert!(checked("w3P:tK").is_ok());
        for bad in ["", "--new-workspace", "w1\n", "w\u{1b}1"] {
            assert!(matches!(checked(bad), Err(Error::InvalidId(_))), "{bad:?}");
        }
    }

    #[test]
    fn a_move_reports_the_tab_it_created_or_joined() {
        let created = json!({"move_result": {"changed": true, "created_tab": {"tab_id": "w2:t9"}, "pane": {"tab_id": "w2:t9"}}});
        assert_eq!(moved_to(created).ok().as_deref(), Some("w2:t9"));
        let joined = json!({"move_result": {"changed": true, "pane": {"tab_id": "w2:t9"}}});
        assert_eq!(moved_to(joined).ok().as_deref(), Some("w2:t9"));
        let unchanged = json!({"move_result": {"changed": false, "reason": "same_tab"}});
        assert!(matches!(moved_to(unchanged), Err(Error::Unchanged)));
    }

    #[test]
    fn a_tab_without_panes_does_not_move() {
        assert!(matches!(move_tab(&[], "w2", None), Err(Error::Empty)));
    }
}
