//! Running Git: no prompts, no optional locks, no file monitor, under a
//! deadline and a cap on what it may print. A child that overruns either is
//! stopped rather than waited on. [`run`] is for reads; [`supervised`] is for
//! commands that spawn helpers or write, and print their reason last;
//! [`shell`] runs a repo's own check the same way.

use crate::process;
use std::{
    env,
    io::{self, Read},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex, PoisonError},
    thread,
    time::{Duration, Instant},
};

/// Output one call keeps by default.
pub const OUTPUT: usize = 2 * 1024 * 1024;
/// Stderr kept as a failure's details; the rest is noise.
const DETAILS: usize = 4096;
const POLL: Duration = Duration::from_millis(5);
/// What a supervised command keeps of each stream: the end of it, where Git
/// puts its reason, after whatever a hook or the remote printed.
const TAIL_OUTPUT: usize = 64 * 1024;
/// How long a stopped command has to clean up its lock files.
const STOP_GRACE: Duration = Duration::from_secs(2);
/// How long to wait for the pipes once Git is done. A hook's background job
/// can hold them open for as long as it likes.
const PIPE_GRACE: Duration = Duration::from_millis(500);
/// What [`shell`] prints once the user's startup files are done.
const STARTED: &str = "herdr-script-starts";

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

/// How a supervised command ended. Both streams are text with their lines kept,
/// since Git's reason is often several of them.
#[derive(Debug)]
pub struct Finished {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

fn git(directory: &str, args: &[&str]) -> Command {
    let mut command = process::command("git");
    command
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
        .stderr(Stdio::piped());
    command
}

/// Git's stdout for `args` in `directory`, at most `limit` bytes.
pub fn run(
    directory: &str,
    args: &[&str],
    operation: &'static str,
    deadline: Instant,
    limit: usize,
) -> Result<Vec<u8>, Error> {
    let mut child = git(directory, args)
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

/// Runs a command that talks to a remote or writes. It differs from [`run`]
/// in three ways those commands need. Git and everything it starts (`ssh`, a
/// transport helper, the `fetch` inside a `pull`, hooks) share a process
/// group, so an overrun stops them all, and gently, so no lock file stays
/// behind for whoever else works in the checkout. Each stream keeps its end,
/// not its start. And a failure is returned, not an error, since a caller has
/// to read stdout as well to say why. Messages are in English so they can be
/// recognized. `Err` means Git did not finish.
pub fn supervised(
    directory: &str,
    args: &[&str],
    operation: &'static str,
    deadline: Instant,
) -> Result<Finished, Error> {
    let mut command = git(directory, args);
    command.env("LC_ALL", "C");
    group(command, operation, deadline)
}

/// Runs `script` in `directory` under the user's shell, as [`supervised`]
/// runs Git. Interactive and login, since an app started from the Dock has
/// neither `npm` nor `cargo` on its `PATH` until the shell's startup files
/// put them there. What those files print is dropped, so a failure's output
/// is the script's own.
pub fn shell(
    directory: &str,
    script: &str,
    operation: &'static str,
    deadline: Instant,
) -> Result<Finished, Error> {
    let shell = env::var_os("SHELL")
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| "/bin/sh".into());
    let mut command = process::command(shell);
    command
        .args(["-ilc", &format!("printf '%s\\n' {STARTED}; printf '%s\\n' {STARTED} >&2; {script}")])
        .current_dir(directory)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let done = group(command, operation, deadline)?;
    Ok(Finished {
        success: done.success,
        stdout: after_start(done.stdout),
        stderr: after_start(done.stderr),
    })
}

/// `text` after [`STARTED`], or all of it if the start was cut off.
fn after_start(text: String) -> String {
    match text.split_once(STARTED) {
        Some((_, rest)) => rest.trim().to_owned(),
        None => text,
    }
}

fn group(
    mut command: Command,
    operation: &'static str,
    deadline: Instant,
) -> Result<Finished, Error> {
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = command
        .spawn()
        .map_err(|source| Error::Spawn { operation, source })?;
    let stdout = child.stdout.take().map(Tail::read);
    let stderr = child.stderr.take().map(Tail::read);
    let status = wait_until(&mut child, deadline);
    if status.is_none() {
        stop_group(&mut child);
    }
    let settled = Instant::now() + PIPE_GRACE;
    while Instant::now() < settled
        && [&stdout, &stderr]
            .into_iter()
            .flatten()
            .any(|tail| !tail.reader.is_finished())
    {
        thread::sleep(POLL);
    }
    let Some(status) = status else {
        return Err(Error::Timeout { operation });
    };
    Ok(Finished {
        success: status.success(),
        stdout: stdout.map(|tail| tail.text()).unwrap_or_default(),
        stderr: stderr.map(|tail| tail.text()).unwrap_or_default(),
    })
}

/// The end of what a pipe printed, read on a thread of its own. It is kept
/// outside the thread so it can be taken while the pipe is still open.
struct Tail {
    kept: Arc<Mutex<Vec<u8>>>,
    reader: thread::JoinHandle<()>,
}

impl Tail {
    fn read(pipe: impl Read + Send + 'static) -> Self {
        let kept = Arc::new(Mutex::new(Vec::new()));
        let shared = Arc::clone(&kept);
        let reader = thread::spawn(move || keep_tail(pipe, &shared));
        Self { kept, reader }
    }

    /// As text without controls but with its lines, and if the start was
    /// dropped, without the line that cut through.
    fn text(&self) -> String {
        let kept = self.kept.lock().unwrap_or_else(PoisonError::into_inner);
        let text = String::from_utf8_lossy(&kept);
        let text = if kept.len() >= TAIL_OUTPUT {
            text.split_once('\n').map_or(&*text, |(_, rest)| rest)
        } else {
            &*text
        };
        clean_lines(text)
    }
}

fn keep_tail(mut pipe: impl Read, kept: &Mutex<Vec<u8>>) {
    let mut chunk = [0; 8192];
    while let Ok(read @ 1..) = pipe.read(&mut chunk) {
        let mut kept = kept.lock().unwrap_or_else(PoisonError::into_inner);
        kept.extend_from_slice(&chunk[..read]);
        let excess = kept.len().saturating_sub(TAIL_OUTPUT);
        kept.drain(..excess);
    }
}

/// Asks the group to stop, which lets Git remove its lock files, and kills
/// whatever is left after the grace.
fn stop_group(child: &mut Child) {
    signal_group(child, "TERM");
    wait_until(child, Instant::now() + STOP_GRACE);
    signal_group(child, "KILL");
    let _ = child.kill();
    let _ = child.wait();
}

/// By the `kill` command: the crate has no `unsafe` and a signal is not worth it.
#[cfg(unix)]
fn signal_group(child: &Child, signal: &str) {
    let group = format!("-{}", child.id());
    let _ = process::command("kill")
        .args(["-s", signal, "--", &group])
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(unix))]
fn signal_group(_child: &Child, _signal: &str) {}

/// The exit status, or `None` once the deadline passed with the child running.
fn wait_until(child: &mut Child, deadline: Instant) -> Option<ExitStatus> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(POLL),
            _ => return None,
        }
    }
}

/// The exit status, or `None` once the deadline passed and the child was killed.
pub fn wait(child: &mut Child, deadline: Instant) -> Option<ExitStatus> {
    let status = wait_until(child, deadline);
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    status
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

/// Display text with its lines. A carriage return ends a line too, since a
/// remote's progress is drawn with them; other controls go.
fn clean_lines(text: &str) -> String {
    text.trim()
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
