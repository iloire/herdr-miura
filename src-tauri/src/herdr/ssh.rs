//! Reaching a daemon on another machine: one `ssh` child per connection,
//! running Herdr's own `herdr remote-client-bridge` there, which relays its
//! standard streams to that machine's client socket. The protocol on top is
//! the same as on a local socket.
//!
//! The policy is Herdr's non-interactive one (`src/remote/attach.rs` in Herdr
//! 0.9.5): keys or an agent only, never a password prompt, a host key that
//! must already be known, bounded connect time, and keepalives. A host key
//! is never accepted here; the app asks the user (see `crate::host_key`).
//! POSIX hosts only: the bridge starts through `/bin/sh`.

use std::{
    io::{self, BufRead, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

/// The line Herdr prints on the remote just before the bridge's frames, so
/// a login banner or shell noise before it is skipped, not decoded.
pub const READY_MARKER: &str = "herdr-remote-output-ready:1";
/// What the remote script prints to stderr when it finds no `herdr`.
const NOT_FOUND: &str = "herdr-miura: no herdr executable on this host";
/// Preamble bytes skipped at most before the marker.
const MAX_PREAMBLE: usize = 64 * 1024;
/// Stderr kept to explain a failure.
pub const MAX_STDERR: usize = 8 * 1024;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("`{0}` is not a host name this app will pass to ssh")]
    InvalidTarget(String),
    #[error("{host} is not in known_hosts yet; approve its key to connect")]
    UnknownHostKey { host: String },
    #[error("the host key of {host} has changed; check it before connecting again")]
    HostKeyChanged { host: String },
    #[error("ssh could not sign in to {host}: no key or agent identity was accepted")]
    AuthFailed { host: String },
    #[error("ssh cannot find {host}")]
    UnknownHost { host: String },
    #[error("ssh cannot reach {host}: {details}")]
    Unreachable { host: String, details: String },
    #[error("Herdr is not installed on {host}, or not where this app looks")]
    HerdrMissing { host: String },
    #[error("ssh to {host} failed: {details}")]
    Failed { host: String, details: String },
    #[error("{host} sent more than {MAX_PREAMBLE} bytes before starting Herdr")]
    Preamble { host: String },
}

/// An alias or `user@host` as `ssh` takes it. Refused when it could be read
/// as an option or carries anything a shell or ssh would split on.
pub fn validate_target(target: &str) -> Result<(), Error> {
    let fine = !target.is_empty()
        && target.len() <= 255
        && !target.starts_with('-')
        && target
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@' | ':' | '[' | ']'));
    if fine {
        Ok(())
    } else {
        Err(Error::InvalidTarget(target.into()))
    }
}

/// Single quotes for `/bin/sh`, with embedded quotes closed and escaped.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// The script the host runs: find `herdr` where Herdr's own client looks,
/// print the marker, and become the bridge on the default session.
pub fn bridge_script() -> String {
    format!(
        r#"candidate=$(command -v herdr 2>/dev/null)
[ -n "$candidate" ] || candidate=$(sh -lc 'command -v herdr' 2>/dev/null)
for path in "$candidate" "$HOME/.local/bin/herdr" /opt/homebrew/bin/herdr /usr/local/bin/herdr \
    /home/linuxbrew/.linuxbrew/bin/herdr "$HOME/.local/share/mise/shims/herdr" \
    "$HOME/.nix-profile/bin/herdr" "/etc/profiles/per-user/$USER/bin/herdr" \
    /nix/var/nix/profiles/default/bin/herdr /run/current-system/sw/bin/herdr; do
    if [ -n "$path" ] && [ -x "$path" ]; then
        printf '\n%s\n' '{READY_MARKER}'
        exec "$path" remote-client-bridge
    fi
done
echo '{NOT_FOUND}' >&2
exit 127"#
    )
}

/// The `ssh` invocation for `target`. Logins to one host share a master
/// connection under `control_dir`, so reconnecting does not sign in again.
pub fn command(target: &str, control_dir: Option<&Path>) -> Command {
    let mut command = crate::process::command("ssh");
    command.arg("-T").arg("-C");
    for option in [
        "BatchMode=yes",
        "NumberOfPasswordPrompts=0",
        "StrictHostKeyChecking=yes",
        "ConnectTimeout=10",
        "ConnectionAttempts=1",
        "ServerAliveInterval=15",
        "ServerAliveCountMax=4",
        "ClearAllForwardings=yes",
    ] {
        command.arg("-o").arg(option);
    }
    if let Some(dir) = control_dir {
        // `%C` hashes host, port, and user, keeping the socket path short.
        command
            .args(["-o", "ControlMaster=auto", "-o", "ControlPersist=600", "-o"])
            .arg(format!("ControlPath={}/%C", dir.display()));
    }
    command
        .arg("--")
        .arg(target)
        .arg(format!("/bin/sh -c {}", quote(&bridge_script())));
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// A private directory for ssh's shared-login sockets: `/tmp/herdr-miura-<uid>`,
/// short enough for a socket path. It must be a real directory this user
/// owns with no access for anyone else; another user could otherwise plant a
/// socket there and receive the session. `None` turns sharing off.
#[cfg(unix)]
pub fn control_dir() -> Option<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    let uid = std::fs::metadata(std::env::var_os("HOME")?).ok()?.uid();
    let dir = PathBuf::from(format!("/tmp/herdr-miura-{uid}"));
    let _ = std::fs::DirBuilder::new().mode(0o700).create(&dir);
    let meta = std::fs::symlink_metadata(&dir).ok()?;
    (meta.is_dir() && meta.uid() == uid && meta.permissions().mode() & 0o077 == 0).then_some(dir)
}

#[cfg(not(unix))]
pub fn control_dir() -> Option<PathBuf> {
    None
}

/// The first [`MAX_STDERR`] bytes of ssh's stderr, the rest drained so ssh
/// never blocks on it.
pub fn read_stderr(mut stderr: impl Read) -> String {
    let mut kept = Vec::new();
    let _ = (&mut stderr).take(MAX_STDERR as u64).read_to_end(&mut kept);
    let _ = io::copy(&mut stderr, &mut io::sink());
    String::from_utf8_lossy(&kept).into_owned()
}

/// Reads up to and including the marker line. `None` when the stream ended
/// first, which means ssh or the script failed and stderr says why.
pub fn skip_preamble(reader: &mut impl BufRead, host: &str) -> io::Result<Option<Result<(), Error>>> {
    let mut skipped = 0;
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader
            .take((MAX_PREAMBLE - skipped.min(MAX_PREAMBLE)) as u64 + 1)
            .read_until(b'\n', &mut line)?;
        if read == 0 {
            return Ok(None);
        }
        skipped += read;
        if skipped > MAX_PREAMBLE {
            return Ok(Some(Err(Error::Preamble { host: host.into() })));
        }
        let text = line.strip_suffix(b"\n").unwrap_or(&line);
        let text = text.strip_suffix(b"\r").unwrap_or(text);
        if text == READY_MARKER.as_bytes() {
            return Ok(Some(Ok(())));
        }
    }
}

/// What a failed ssh run means, from its stderr.
pub fn classify(host: &str, stderr: &str) -> Error {
    let host = host.to_owned();
    let last = stderr
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or("ssh exited without saying why");
    let details: String = last.chars().filter(|c| !c.is_control()).take(300).collect();
    if stderr.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") {
        Error::HostKeyChanged { host }
    // "No ED25519 host key is known for …", whatever the key type.
    } else if stderr.contains("host key is known for") {
        Error::UnknownHostKey { host }
    } else if stderr.contains("Permission denied") {
        Error::AuthFailed { host }
    } else if stderr.contains("Could not resolve hostname") {
        Error::UnknownHost { host }
    } else if ["Connection refused", "timed out", "No route to host", "Network is unreachable"]
        .iter()
        .any(|needle| stderr.contains(needle))
    {
        Error::Unreachable { host, details }
    } else if stderr.contains(NOT_FOUND) {
        Error::HerdrMissing { host }
    } else {
        Error::Failed { host, details }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
