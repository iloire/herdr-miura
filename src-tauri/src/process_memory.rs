//! How much memory the processes of each Herdr pane hold, for the tab header,
//! the workspace cards, and the dialog that lists them largest first.
//!
//! A process belongs to the pane its own environment names in `HERDR_PANE_ID`,
//! as the listening ports do, and a process whose environment says nothing (a
//! server that renamed itself, which on macOS overwrites what `ps -E` reads,
//! or another user's, which cannot be read) to its parent's pane. One whose
//! `HERDR_SOCKET_PATH` names another daemon belongs to that daemon, not here.
//!
//! On macOS the figure is each process's physical footprint, what Activity
//! Monitor's Memory column shows: resident size leaves out what macOS has
//! compressed, a third of an idle Claude Code. Elsewhere, and for a process
//! whose footprint cannot be read, it is the resident set size `ps` reports,
//! which counts a shared library once per process. Only this machine is scanned.

use crate::{git, herdr, process};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    thread,
    time::{Duration, Instant},
};

/// Three `ps` runs over every process; one that hangs is stopped.
const DEADLINE: Duration = Duration::from_secs(10);
/// `ps -E` prints every environment: about 1 MB on a busy Mac.
const OUTPUT: usize = 16 * 1024 * 1024;
/// Processes kept per pane, largest first.
const MAX_PROCESSES: usize = 200;
/// Display text only.
const MAX_NAME: usize = 64;
const MAX_COMMAND: usize = 512;
/// Ancestors walked to find a pane; a longer chain is a loop or not ours.
const MAX_DEPTH: usize = 64;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not run ps to read memory use")]
    Ps,
    #[error("the memory scanner stopped")]
    Worker(#[source] tauri::Error),
}

/// One process of a pane, as the webview shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Process {
    pub pid: u32,
    /// The program's short name.
    pub name: String,
    /// Its command line, for telling two `node`s apart.
    pub command: String,
    /// Resident memory, in bytes.
    pub bytes: u64,
}

/// What `ps` says of one process before it is given a pane.
struct Row {
    ppid: u32,
    kb: u64,
    name: String,
    command: String,
    /// Its environment as text, `None` where it could not be read.
    env: Option<String>,
}

/// Each pane's processes on this machine's daemon, largest first; a pane
/// with none is absent.
pub fn scan() -> Result<HashMap<String, Vec<Process>>, Error> {
    let rows = read()?;
    let client = herdr::client_socket_path();
    Ok(attribute(
        rows,
        |api| api.is_empty() || herdr::beside_api_socket(Path::new(api)) == client,
        |pid, kb| footprint(pid).unwrap_or(kb * 1024),
    ))
}

fn read() -> Result<HashMap<u32, Row>, Error> {
    let table = ps(&["-Ao", "pid=,ppid=,rss=,comm="])?;
    let args = ps(&["-ww", "-Ao", "pid=,args="])?;
    let args = by_pid(&args);
    // macOS prints the environment after the arguments; Linux keeps it in /proc.
    let envs = if cfg!(target_os = "macos") {
        ps(&["-E", "-ww", "-Ao", "pid=,command="])?
    } else {
        String::new()
    };
    let envs = by_pid(&envs);
    let mut rows = HashMap::new();
    for line in table.lines() {
        let mut words = line.split_whitespace();
        let (Some(pid), Some(ppid), Some(kb)) = (words.next(), words.next(), words.next()) else {
            continue;
        };
        let (Ok(pid), Ok(ppid), Ok(kb)) = (pid.parse(), ppid.parse(), kb.parse()) else {
            continue;
        };
        let path = words.collect::<Vec<_>>().join(" ");
        let command = args.get(&pid).copied().unwrap_or_default();
        let env = if cfg!(target_os = "macos") {
            envs.get(&pid).map(|full| full.strip_prefix(command).unwrap_or(full).to_owned())
        } else {
            std::fs::read(format!("/proc/{pid}/environ"))
                .ok()
                .map(|raw| String::from_utf8_lossy(&raw).replace('\0', " "))
        };
        rows.insert(
            pid,
            Row {
                ppid,
                kb,
                name: display(path.rsplit('/').next().unwrap_or(&path), MAX_NAME),
                command: display(command, MAX_COMMAND),
                env,
            },
        );
    }
    Ok(rows)
}

fn ps(args: &[&str]) -> Result<String, Error> {
    let mut child = process::command("ps")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| Error::Ps)?;
    let stdout = child
        .stdout
        .take()
        .map(|pipe| thread::spawn(move || git::read_bounded(pipe, OUTPUT)));
    let status = git::wait(&mut child, Instant::now() + DEADLINE);
    let output = stdout
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    status.ok_or(Error::Ps)?;
    Ok(String::from_utf8_lossy(&output).into_owned())
}

/// `<pid> <text>` lines by pid.
fn by_pid(text: &str) -> HashMap<u32, &str> {
    text.lines()
        .filter_map(|line| {
            let (pid, rest) = line.trim_start().split_once(' ')?;
            Some((pid.parse().ok()?, rest))
        })
        .collect()
}

fn display(text: &str, max: usize) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// Gives each process the pane it or its nearest telling ancestor names, kept
/// when `owns` that pane's daemon by its API socket.
/// `measure` gives a process's bytes from its pid and resident kilobytes.
fn attribute(
    rows: HashMap<u32, Row>,
    owns: impl Fn(&str) -> bool,
    measure: impl Fn(u32, u64) -> u64,
) -> HashMap<String, Vec<Process>> {
    let mut panes: HashMap<u32, Option<String>> = HashMap::new();
    let pids: Vec<u32> = rows.keys().copied().collect();
    for pid in pids {
        let mut chain = Vec::new();
        let mut at = pid;
        let pane = loop {
            if let Some(known) = panes.get(&at) {
                break known.clone();
            }
            let Some(row) = rows.get(&at) else { break None };
            chain.push(at);
            if let Some(pane) = row.env.as_deref().and_then(|env| var(env, "HERDR_PANE_ID")) {
                let socket = row.env.as_deref().and_then(|env| var(env, "HERDR_SOCKET_PATH"));
                break owns(socket.unwrap_or_default()).then(|| pane.to_owned());
            }
            if row.ppid <= 1 || row.ppid == at || chain.len() >= MAX_DEPTH {
                break None;
            }
            at = row.ppid;
        };
        for pid in chain {
            panes.insert(pid, pane.clone());
        }
    }
    let mut out: HashMap<String, Vec<Process>> = HashMap::new();
    for (pid, row) in rows {
        let Some(Some(pane)) = panes.remove(&pid) else { continue };
        out.entry(pane).or_default().push(Process {
            pid,
            name: row.name,
            command: row.command,
            bytes: measure(pid, row.kb),
        });
    }
    for list in out.values_mut() {
        list.sort_by(|a, b| b.bytes.cmp(&a.bytes).then(a.pid.cmp(&b.pid)));
        list.truncate(MAX_PROCESSES);
    }
    out
}

/// A process's physical footprint in bytes, where the system says.
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
fn footprint(pid: u32) -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
    let pid = libc::c_int::try_from(pid).ok()?;
    // SAFETY: the buffer is a `rusage_info_v2`, the flavor asked for, and it
    // is read only after the call says it filled it.
    let done = unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, info.as_mut_ptr().cast()) };
    (done == 0).then(|| unsafe { info.assume_init() }.ri_phys_footprint)
}

#[cfg(not(target_os = "macos"))]
fn footprint(_pid: u32) -> Option<u64> {
    None
}

/// The value of `name` in an environment printed as `A=1 B=two words`: up to
/// the next ` NAME=`, since `ps` joins the entries with spaces.
fn var<'a>(env: &'a str, name: &str) -> Option<&'a str> {
    let marker = format!("{name}=");
    let start = env
        .match_indices(&marker)
        .find(|(at, _)| *at == 0 || env.as_bytes()[at - 1] == b' ')
        .map(|(at, _)| at + marker.len())?;
    let rest = &env[start..];
    let end = rest
        .match_indices(' ')
        .map(|(at, _)| at)
        .find(|&at| starts_entry(&rest[at + 1..]))
        .unwrap_or(rest.len());
    Some(rest[..end].trim_end()).filter(|value| !value.is_empty())
}

/// Whether `text` opens with `NAME=`, a shell variable's name.
fn starts_entry(text: &str) -> bool {
    let name_len = text
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
        .count();
    name_len > 0
        && !text.as_bytes()[0].is_ascii_digit()
        && text.as_bytes().get(name_len) == Some(&b'=')
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
