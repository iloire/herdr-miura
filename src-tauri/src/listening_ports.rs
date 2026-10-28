//! The TCP ports each workspace's processes listen on, as herdr-gpui shows
//! them under a workspace card and in the status bar.
//!
//! Herdr exports `HERDR_WORKSPACE_ID` into every pane it starts, and a server
//! launched from a pane inherits it, so a listener's own environment names
//! its workspace exactly; no working directory is guessed. A listener whose
//! own environment lacks the variable takes the nearest of its parents' (up
//! to four): on macOS `ps -E` reads the environment from the argument area,
//! which a server that renames its process (`next-server`) overwrites.
//! Listeners with no such ancestor (system services, containers, anything
//! started outside Herdr) belong to no workspace and are dropped. Only this
//! machine is scanned; a remote host's ports are refused like its folders.

use crate::{git, herdr, process};
use serde::Serialize;
use std::{
    collections::HashMap,
    net::IpAddr,
    path::Path,
    process::Stdio,
    thread,
    time::{Duration, Instant},
};

/// `lsof` is not free on a busy machine; one that hangs is stopped.
const DEADLINE: Duration = Duration::from_secs(15);
/// Scan output kept; a machine with more listeners than this is cut short.
const OUTPUT: usize = 256 * 1024;
/// Ports kept per workspace, lowest first.
const MAX_PORTS: usize = 32;
/// Process names are display text only.
const MAX_PROCESS: usize = 32;
/// Workspace ids are short daemon tokens such as `w7V`.
const MAX_WORKSPACE_ID: usize = 64;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not start sh to list listening ports")]
    Spawn(#[source] std::io::Error),
    #[error("listing listening ports took too long")]
    Timeout,
    #[error("this machine has neither ss nor lsof to list listening ports")]
    Tool,
    #[error("the port scanner stopped")]
    Worker(#[source] tauri::Error),
}

/// Prints `L <pid> <address:port> <process>` per listening socket, then
/// `E <pid> <workspace> <api socket>` for each listener started inside a
/// Herdr pane, the socket naming which daemon's pane that was, or `N` when
/// the machine has neither `ss` nor `lsof`. Linux prefers `ss`, which is
/// quicker; macOS has only `lsof`. Both list only this user's processes.
/// Ported from herdr-gpui's `listening_ports/scan.rs`.
const COMMAND: &str = r#"PATH="$PATH:/usr/sbin:/sbin"
if command -v ss >/dev/null 2>&1; then
    herdr_ports=$(ss -ltnp 2>/dev/null | awk '{
        rest = $0
        while (match(rest, /\("[^"]*",pid=[0-9]+/)) {
            entry = substr(rest, RSTART + 2, RLENGTH - 2)
            rest = substr(rest, RSTART + RLENGTH)
            split(entry, part, "\",pid=")
            print "L", part[2], $4, part[1]
        }
    }')
elif command -v lsof >/dev/null 2>&1; then
    herdr_ports=$(lsof -nP -iTCP -sTCP:LISTEN -Fpcn 2>/dev/null | awk '
        /^p/ { pid = substr($0, 2) }
        /^c/ { name = substr($0, 2) }
        /^n/ { print "L", pid, substr($0, 2), name }')
else
    herdr_ports=N
fi
printf '%s\n' "$herdr_ports"
for herdr_pid in $(printf '%s\n' "$herdr_ports" | awk '$1 == "L" { print $2 }' | sort -un | head -n 128); do
    herdr_env_pid=$herdr_pid
    herdr_depth=0
    herdr_workspace=
    herdr_socket=
    while [ -z "$herdr_workspace" ] && [ "$herdr_depth" -lt 5 ] && [ "${herdr_env_pid:-0}" -gt 1 ]; do
        if [ -r "/proc/$herdr_env_pid/environ" ]; then
            herdr_env=$(tr '\0' '\n' < "/proc/$herdr_env_pid/environ")
        else
            herdr_env=$(ps -E -ww -o command= -p "$herdr_env_pid" 2>/dev/null | tr ' ' '\n')
        fi
        herdr_workspace=$(printf '%s\n' "$herdr_env" | sed -n 's/^HERDR_WORKSPACE_ID=//p' | head -n 1)
        herdr_socket=$(printf '%s\n' "$herdr_env" | sed -n 's/^HERDR_SOCKET_PATH=//p' | head -n 1)
        herdr_env_pid=$(ps -o ppid= -p "$herdr_env_pid" 2>/dev/null | tr -d ' ')
        herdr_depth=$((herdr_depth + 1))
    done
    if [ -n "$herdr_workspace" ]; then
        printf 'E %s %s %s\n' "$herdr_pid" "$herdr_workspace" "$herdr_socket"
    fi
done
true"#;

/// One listening port, as the webview shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Port {
    pub port: u16,
    /// `*:3000`, `localhost:3000`, `192.168.1.5:3000`, for a tooltip.
    pub address: String,
    /// The listening process's short name.
    pub process: String,
    /// Where a browser on this machine reaches it.
    pub url: String,
    /// How widely it listens, to keep the wider of two sockets on one port.
    #[serde(skip)]
    reach: u8,
}

/// The ports each workspace of this machine's daemon listens on, lowest
/// first; a workspace that listens on none is absent.
pub fn scan() -> Result<HashMap<String, Vec<Port>>, Error> {
    let output = run()?;
    let client = herdr::client_socket_path();
    parse(&String::from_utf8_lossy(&output), |api| {
        // A pane from an older Herdr does not say whose it is.
        api.is_empty() || herdr::beside_api_socket(Path::new(api)) == client
    })
}

fn run() -> Result<Vec<u8>, Error> {
    let mut child = process::command("/bin/sh")
        .args(["-c", COMMAND])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(Error::Spawn)?;
    let stdout = child
        .stdout
        .take()
        .map(|pipe| thread::spawn(move || git::read_bounded(pipe, OUTPUT)));
    let status = git::wait(&mut child, Instant::now() + DEADLINE);
    let output = stdout
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    status.map(|_| output).ok_or(Error::Timeout)
}

/// Parses what [`COMMAND`] printed, keeping listeners whose pane's daemon
/// `owns` names by its API socket, so two daemons never claim each other's.
fn parse(text: &str, owns: impl Fn(&str) -> bool) -> Result<HashMap<String, Vec<Port>>, Error> {
    let mut listeners: Vec<(u32, Port)> = Vec::new();
    let mut owners: HashMap<u32, String> = HashMap::new();
    for line in text.lines() {
        let mut words = line.splitn(4, ' ');
        match words.next() {
            Some("N") => return Err(Error::Tool),
            Some("L") => {
                let (Some(pid), Some(address)) = (words.next(), words.next()) else {
                    continue;
                };
                if let (Ok(pid), Some(port)) = (pid.parse(), listener(address, words.next())) {
                    listeners.push((pid, port));
                }
            }
            Some("E") => {
                let (Some(pid), Some(workspace)) = (words.next(), words.next()) else {
                    continue;
                };
                let plain = !workspace.is_empty()
                    && workspace.len() <= MAX_WORKSPACE_ID
                    && workspace.chars().all(|c| c.is_ascii_graphic() && c != '=');
                let socket = words.next().unwrap_or_default().trim_end();
                if let (Ok(pid), true, true) = (pid.parse(), plain, owns(socket)) {
                    owners.insert(pid, workspace.to_owned());
                }
            }
            _ => {}
        }
    }
    let mut ports: HashMap<String, Vec<Port>> = HashMap::new();
    for (pid, port) in listeners {
        let Some(workspace) = owners.get(&pid) else {
            continue;
        };
        let list = ports.entry(workspace.clone()).or_default();
        match list.iter_mut().find(|known| known.port == port.port) {
            // IPv4 and IPv6 sockets of one server share its number.
            Some(known) => {
                if port.reach > known.reach {
                    *known = port;
                }
            }
            None => list.push(port),
        }
    }
    for list in ports.values_mut() {
        list.sort_by_key(|port| port.port);
        list.truncate(MAX_PORTS);
    }
    Ok(ports)
}

/// `127.0.0.1:3000`, `[::1]:3000`, `*:3000`, `0.0.0.0:3000`, `[fe80::1%en0]:3000`.
fn listener(address: &str, process: Option<&str>) -> Option<Port> {
    let (host, number) = address.rsplit_once(':')?;
    let port: u16 = number.parse().ok().filter(|port| *port > 0)?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let host = host.split('%').next().unwrap_or(host);
    // Every address, the loopback only, or one specific address.
    let (reach, name) = if host == "*" {
        (2, None)
    } else {
        let ip: IpAddr = host.parse().ok()?;
        if ip.is_unspecified() {
            (2, None)
        } else if ip.is_loopback() {
            (1, None)
        } else {
            (0, Some(ip))
        }
    };
    let (address, url_host) = match name {
        None if reach == 2 => (format!("*:{port}"), "localhost".to_owned()),
        None => (format!("localhost:{port}"), "localhost".to_owned()),
        Some(IpAddr::V6(ip)) => (format!("[{ip}]:{port}"), format!("[{ip}]")),
        Some(IpAddr::V4(ip)) => (format!("{ip}:{port}"), ip.to_string()),
    };
    Some(Port {
        port,
        address,
        process: process
            .unwrap_or_default()
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_PROCESS)
            .collect::<String>()
            .trim()
            .to_owned(),
        url: format!("http://{url_host}:{port}/"),
        reach,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
