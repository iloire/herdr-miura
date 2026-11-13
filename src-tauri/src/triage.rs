//! Todoist triage (docs/plan-todoist.md, idea 5): one cheap Claude run that
//! reads the listed tasks and suggests a repo and a template for each. The
//! webview writes the question and reads the answer; this side only runs
//! `claude -p` on Haiku with no tools, no MCP servers and no settings (so no
//! hooks), in an empty folder, and hands back what it printed. It can change
//! nothing: what it suggests is applied only when accepted in the panel.

use crate::process;
use std::{
    io::{Read as _, Write as _},
    process::Stdio,
    time::{Duration, Instant},
};

const MODEL: &str = "haiku";
const TIMEOUT: Duration = Duration::from_secs(120);
/// A question longer than this is a mistake, not a task list.
const MAX_PROMPT: usize = 200_000;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Claude Code's `claude` was not found on this computer")]
    NoClaude,
    #[error("the triage question is too long")]
    TooLong,
    #[error("could not run Claude: {0}")]
    Run(#[from] std::io::Error),
    #[error("Claude took longer than {0} seconds")]
    Timeout(u64),
    #[error("Claude failed: {0}")]
    Failed(String),
    #[error("the triage run stopped")]
    Worker(#[source] tauri::Error),
}

/// The arguments: print mode on Haiku, nothing it could act with.
fn args() -> [&'static str; 11] {
    [
        "-p",
        "--model",
        MODEL,
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--output-format",
        "text",
    ]
}

/// What Claude printed for `prompt`.
pub fn ask(prompt: &str) -> Result<String, Error> {
    if prompt.len() > MAX_PROMPT {
        return Err(Error::TooLong);
    }
    let claude = process::find("claude").ok_or(Error::NoClaude)?;
    let empty = std::env::temp_dir().join("herdr-miura-triage");
    std::fs::create_dir_all(&empty)?;
    let mut child = process::command(claude)
        .args(args())
        .current_dir(&empty)
        // Started from a Claude session (a dev window), it would think it nested.
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes())?;
    }
    let mut stdout = child.stdout.take().ok_or_else(|| Error::Failed("no output".into()))?;
    let mut stderr = child.stderr.take().ok_or_else(|| Error::Failed("no output".into()))?;
    let out = std::thread::spawn(move || {
        let mut text = String::new();
        stdout.read_to_string(&mut text).map(|_| text)
    });
    let err = std::thread::spawn(move || {
        let mut text = String::new();
        stderr.read_to_string(&mut text).map(|_| text)
    });
    let deadline = Instant::now() + TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::Timeout(TIMEOUT.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let joined = |handle: std::thread::JoinHandle<std::io::Result<String>>| {
        handle.join().map_err(|_| Error::Failed("output reader stopped".into()))?.map_err(Error::from)
    };
    let text = joined(out)?;
    let errors = joined(err)?;
    if !status.success() {
        let why = [errors.trim(), text.trim()].into_iter().find(|text| !text.is_empty()).unwrap_or("no message");
        return Err(Error::Failed(why.chars().take(300).collect()));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_haiku_with_nothing_to_act_with() {
        let args = args();
        assert_eq!(args[..3], ["-p", "--model", "haiku"]);
        assert!(args.windows(2).any(|pair| pair == ["--tools", ""]));
        assert!(args.windows(2).any(|pair| pair == ["--setting-sources", ""]));
        assert!(args.contains(&"--strict-mcp-config"));
    }

    #[test]
    fn a_long_question_is_refused_before_running() {
        assert!(matches!(ask(&"x".repeat(MAX_PROMPT + 1)), Err(Error::TooLong)));
    }
}
