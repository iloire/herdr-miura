//! Running Git for reads: no prompts, no optional locks, no file monitor,
//! under a deadline and a cap on what it may print. A child that overruns
//! either is killed rather than waited on.

use crate::process;
use std::{
    io::{self, Read},
    process::{Child, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

/// Output one call keeps by default.
pub const OUTPUT: usize = 2 * 1024 * 1024;
/// Stderr kept as a failure's details; the rest is noise.
const DETAILS: usize = 4096;
const POLL: Duration = Duration::from_millis(5);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not start git to {operation}")]
    Spawn {
        operation: &'static str,
        #[source]
        source: io::Error,
    },
    #[error("git could not {operation}: {details}")]
    Failed {
        operation: &'static str,
        details: String,
    },
    #[error("git took too long to {operation}")]
    Timeout { operation: &'static str },
    #[error("git printed more than {limit} bytes to {operation}")]
    TooLarge {
        operation: &'static str,
        limit: usize,
    },
}

/// Git's stdout for `args` in `directory`, at most `limit` bytes.
pub fn run(
    directory: &str,
    args: &[&str],
    operation: &'static str,
    deadline: Instant,
    limit: usize,
) -> Result<Vec<u8>, Error> {
    let mut child = process::command("git")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.quotepath=off",
            "--no-optional-locks",
            "-C",
            directory,
        ])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|source| Error::Spawn { operation, source })?;
    // Both pipes drain on their own threads, so a chatty stderr can never
    // block Git while stdout is being read, or the other way round.
    let stdout = child
        .stdout
        .take()
        .map(|pipe| thread::spawn(move || read_bounded(pipe, limit + 1)));
    let stderr = child
        .stderr
        .take()
        .map(|pipe| thread::spawn(move || read_bounded(pipe, DETAILS)));
    let status = wait(&mut child, deadline);
    let output = stdout
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    let details = stderr
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    let Some(status) = status else {
        return Err(Error::Timeout { operation });
    };
    if output.len() > limit {
        return Err(Error::TooLarge { operation, limit });
    }
    if !status.success() {
        return Err(Error::Failed {
            operation,
            details: clean(&String::from_utf8_lossy(&details)),
        });
    }
    Ok(output)
}

/// [`run`] as text, trailing newlines trimmed. Git prints UTF-8 paths with
/// `core.quotepath` off; anything else is replaced rather than refused.
pub fn text(
    directory: &str,
    args: &[&str],
    operation: &'static str,
    deadline: Instant,
) -> Result<String, Error> {
    let bytes = run(directory, args, operation, deadline, OUTPUT)?;
    Ok(String::from_utf8_lossy(&bytes)
        .trim_end_matches(['\r', '\n'])
        .to_owned())
}

/// The exit status, or `None` once the deadline passed and the child was killed.
pub fn wait(child: &mut Child, deadline: Instant) -> Option<ExitStatus> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(POLL),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// Up to `limit` bytes, then drains the rest so the writer never blocks.
pub fn read_bounded(mut pipe: impl Read, limit: usize) -> Vec<u8> {
    let mut kept = Vec::new();
    let _ = (&mut pipe).take(limit as u64).read_to_end(&mut kept);
    let _ = io::copy(&mut pipe, &mut io::sink());
    kept
}

/// Stderr as one line of display text, without controls.
fn clean(details: &str) -> String {
    details
        .trim()
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
