//! The machines the app offers to connect to, and approving a new host's key.
//!
//! Hosts are the named `Host` entries of `~/.ssh/config` (and the files it
//! `Include`s from `~/.ssh`), the same names `ssh` takes. A host whose key is
//! not in known_hosts is never trusted silently: the app scans its keys,
//! shows their fingerprints, and writes only those exact keys once the user
//! approves them. A changed key is never replaced here.

use std::{
    collections::BTreeSet,
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, PoisonError},
};

use serde::Serialize;

use crate::herdr::ssh::{self, validate_target as validate_ssh_target};

/// Bytes of an ssh config file read at most.
const MAX_CONFIG: u64 = 1024 * 1024;
const MAX_HOSTS: usize = 500;
/// Include depth, as ssh itself bounds it.
const MAX_DEPTH: usize = 16;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("`ssh -G {host}` failed")]
    Config { host: String },
    #[error("{host} offered no host key; it may be unreachable")]
    NoKeys { host: String },
    #[error("there are no scanned keys of {host} to approve; scan them again")]
    NotScanned { host: String },
    #[error("could not run {program}")]
    Run {
        program: &'static str,
        #[source]
        source: std::io::Error,
    },
    #[error(transparent)]
    Target(#[from] ssh::Error),
    #[error("could not write {}", path.display())]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// One key the user is asked to approve.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub key_type: String,
    pub fingerprint: String,
}

/// Keys scanned and shown, waiting for approval: only these are ever written,
/// so what lands in known_hosts is exactly what the user saw.
#[derive(Debug)]
struct Scan {
    host: String,
    known_hosts: PathBuf,
    lines: Vec<String>,
}

/// Shared with the blocking pool, where scans run.
#[derive(Debug, Default, Clone)]
pub struct PendingKeys(Arc<Mutex<Option<Scan>>>);

/// The named hosts in the user's ssh config, sorted and without patterns.
pub fn list() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    let ssh_dir = home.join(".ssh");
    let mut hosts = BTreeSet::new();
    read_config(&ssh_dir.join("config"), &ssh_dir, 0, &mut hosts);
    hosts.into_iter().take(MAX_HOSTS).collect()
}

fn read_config(path: &Path, ssh_dir: &Path, depth: usize, hosts: &mut BTreeSet<String>) {
    use std::io::Read;
    let mut text = String::new();
    let Ok(file) = std::fs::File::open(path) else {
        return;
    };
    if file.take(MAX_CONFIG).read_to_string(&mut text).is_err() {
        return;
    }
    for (keyword, args) in text.lines().filter_map(directive) {
        if keyword.eq_ignore_ascii_case("host") {
            hosts.extend(
                args.split_whitespace()
                    .filter(|name| validate_ssh_target(name).is_ok())
                    .map(str::to_owned),
            );
        } else if keyword.eq_ignore_ascii_case("include") && depth < MAX_DEPTH {
            for pattern in args.split_whitespace() {
                for included in expand_include(pattern, ssh_dir) {
                    read_config(&included, ssh_dir, depth + 1, hosts);
                }
            }
        }
    }
}

/// A config line's keyword and arguments; `Host a b`, or `Host=a`.
fn directive(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let split = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let (keyword, rest) = line.split_at(split);
    Some((keyword, rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=')))
}

/// An `Include` target: relative to `~/.ssh`, with `*` allowed in the last
/// part only, which covers the usual `Include config.d/*`.
fn expand_include(pattern: &str, ssh_dir: &Path) -> Vec<PathBuf> {
    let path = match pattern.strip_prefix("~/") {
        Some(rest) => ssh_dir.parent().map_or_else(|| ssh_dir.join(rest), |home| home.join(rest)),
        None => ssh_dir.join(pattern),
    };
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return Vec::new();
    };
    let Some((prefix, suffix)) = name.split_once('*') else {
        return vec![path];
    };
    let Some(dir) = path.parent() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut matches: Vec<_> = entries
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|n| n.len() >= prefix.len() + suffix.len() && n.starts_with(prefix) && n.ends_with(suffix))
        .map(|n| dir.join(n))
        .collect();
    matches.sort();
    matches
}

/// Where ssh looks for `host`, by its own resolution of the config.
#[derive(Debug, PartialEq, Eq)]
struct Resolved {
    /// The name known_hosts records: the host key alias, else the host name.
    known_as: String,
    hostname: String,
    port: u16,
    known_hosts: PathBuf,
}

fn resolve(host: &str) -> Result<Resolved, Error> {
    let output = crate::process::command("ssh")
        .args(["-G", "--", host])
        .stdin(Stdio::null())
        .output()
        .map_err(|source| Error::Run { program: "ssh", source })?;
    if !output.status.success() {
        return Err(Error::Config { host: host.into() });
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    parse_resolved(&String::from_utf8_lossy(&output.stdout), &home).ok_or_else(|| Error::Config { host: host.into() })
}

fn parse_resolved(config: &str, home: &Path) -> Option<Resolved> {
    let value = |key: &str| {
        config
            .lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix(' ').map(str::trim))
    };
    let hostname = value("hostname")?.to_owned();
    let port = value("port").map_or(Some(22), |p| p.parse().ok())?;
    let known_hosts = value("userknownhostsfile")?.split_whitespace().next()?;
    let known_hosts = match known_hosts.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(known_hosts),
    };
    let known_as = value("hostkeyalias").unwrap_or(&hostname).to_owned();
    // A name that could inject a second entry is not written.
    validate_ssh_target(&known_as).ok()?;
    Some(Resolved { known_as, hostname, port, known_hosts })
}

/// The known_hosts name of a host on `port`: `[name]:port` off port 22.
fn known_hosts_name(name: &str, port: u16) -> String {
    if port == 22 { name.to_owned() } else { format!("[{name}]:{port}") }
}

/// Fetches `host`'s keys and returns their fingerprints for the user to
/// compare, remembering the keys for [`trust`]. Runs `ssh-keyscan`, so call
/// it off the main thread.
pub fn scan(pending: &PendingKeys, host: &str) -> Result<Vec<Fingerprint>, Error> {
    validate_ssh_target(host)?;
    let resolved = resolve(host)?;
    let output = crate::process::command("ssh-keyscan")
        .args(["-T", "5", "-p", &resolved.port.to_string(), "--", &resolved.hostname])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|source| Error::Run { program: "ssh-keyscan", source })?;
    let name = known_hosts_name(&resolved.known_as, resolved.port);
    let lines = key_lines(&String::from_utf8_lossy(&output.stdout), &name);
    if lines.is_empty() {
        return Err(Error::NoKeys { host: host.into() });
    }
    let fingerprints = fingerprints(&lines)?;
    *pending.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(Scan {
        host: host.into(),
        known_hosts: resolved.known_hosts,
        lines,
    });
    Ok(fingerprints)
}

/// `ssh-keyscan` output as known_hosts lines under `name`. Only lines of
/// three plain fields are kept: a key type, its base64, and nothing else.
fn key_lines(scanned: &str, name: &str) -> Vec<String> {
    let mut lines: Vec<String> = scanned
        .lines()
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let (_host, key_type, key) = (fields.next()?, fields.next()?, fields.next()?);
            let plain = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '@' | '+' | '/' | '='));
            (fields.next().is_none() && plain(key_type) && plain(key)).then(|| format!("{name} {key_type} {key}"))
        })
        .collect();
    lines.sort();
    lines.dedup();
    lines
}

fn fingerprints(lines: &[String]) -> Result<Vec<Fingerprint>, Error> {
    let run = |source| Error::Run { program: "ssh-keygen", source };
    let mut child = crate::process::command("ssh-keygen")
        .args(["-l", "-f", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(run)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(format!("{}\n", lines.join("\n")).as_bytes()).map_err(run)?;
    }
    let output = child.wait_with_output().map_err(run)?;
    Ok(parse_fingerprints(&String::from_utf8_lossy(&output.stdout)))
}

/// `256 SHA256:abc… name (ED25519)` lines from `ssh-keygen -l`.
fn parse_fingerprints(text: &str) -> Vec<Fingerprint> {
    text.lines()
        .filter_map(|line| {
            let fingerprint = line.split_whitespace().nth(1)?;
            let key_type = line.rsplit_once('(')?.1.strip_suffix(')')?;
            Some(Fingerprint {
                key_type: key_type.into(),
                fingerprint: fingerprint.into(),
            })
        })
        .collect()
}

/// Writes the keys [`scan`] showed for `host` to the user's known_hosts.
pub fn trust(pending: &PendingKeys, host: &str) -> Result<(), Error> {
    let scan = {
        let mut pending = pending.0.lock().unwrap_or_else(PoisonError::into_inner);
        match pending.take() {
            Some(scan) if scan.host == host => scan,
            other => {
                *pending = other;
                return Err(Error::NotScanned { host: host.into() });
            }
        }
    };
    append(&scan.known_hosts, &scan.lines)
}

fn append(path: &Path, lines: &[String]) -> Result<(), Error> {
    let write = |source| Error::Write { path: path.to_owned(), source };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(write)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path).map_err(write)?;
    // Start on a fresh line if the file's last one has no newline.
    let ends_open = std::fs::read(path).map_err(write)?.last().is_some_and(|b| *b != b'\n');
    let mut text = if ends_open { "\n".to_owned() } else { String::new() };
    for line in lines {
        text.push_str(line);
        text.push('\n');
    }
    file.write_all(text.as_bytes()).map_err(write)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
