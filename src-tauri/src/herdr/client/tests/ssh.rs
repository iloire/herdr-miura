//! The SSH path with a shell standing in for `ssh`: a login banner, the
//! marker, then `nc` relaying to a fake daemon's socket.

use super::*;
use crate::herdr::{endpoint::EndpointServerWelcome, health, ssh::READY_MARKER};

fn fake_ssh(script: &str) -> process::Command {
    let mut command = process::Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(script)
        .stdin(process::Stdio::piped())
        .stdout(process::Stdio::piped())
        .stderr(process::Stdio::piped());
    command
}

fn relay_to(path: &Path) -> process::Command {
    fake_ssh(&format!(
        "printf 'Welcome to box\\r\\nLast login: never\\n\\n%s\\n' '{READY_MARKER}'; exec nc -U '{}'",
        path.display()
    ))
}

/// The daemon's half of the handshake, offering health checks or not.
fn welcome(listener: &UnixListener, health_check: bool) -> UnixStream {
    let (mut daemon, _) = listener.accept().unwrap();
    let ClientMessage::EndpointControl { kind, .. } = codec::read(&mut daemon).unwrap() else {
        panic!("the first message must be the hello");
    };
    assert_eq!(kind, ENDPOINT_HELLO_KIND);
    let ServerMessage::EndpointControl { kind, data } = welcome_message(1, &[]) else {
        unreachable!()
    };
    let mut welcome: EndpointServerWelcome = serde_json::from_str(&data).unwrap();
    if health_check {
        welcome.capabilities.push(health::CAPABILITY.into());
    }
    let data = serde_json::to_string(&welcome).unwrap();
    codec::write(&mut daemon, &ServerMessage::EndpointControl { kind, data }).unwrap();
    daemon
}

fn reason(events: &Receiver<Event>) -> String {
    loop {
        if let Event::Disconnected { reason } = next(events) {
            return reason;
        }
    }
}

#[test]
fn a_banner_is_skipped_and_a_quiet_link_is_pinged() {
    let (_dir, path, listener) = listener();
    let client = connect_through("box", relay_to(&path), options()).unwrap();
    let mut daemon = welcome(&listener, true);
    codec::write(&mut daemon, &snapshot_message("b", 1)).unwrap();
    assert!(matches!(next(&client.events), Event::Connected(_)));
    assert!(matches!(next(&client.events), Event::Snapshot(_)));

    daemon.set_read_timeout(Some(health::QUIET * 2)).unwrap();
    let ClientMessage::EndpointControl { kind, .. } = codec::read(&mut daemon).unwrap() else {
        panic!("expected a ping");
    };
    assert_eq!(kind, health::PING_KIND);
    client.handle.disconnect();
}

#[test]
fn a_daemon_without_health_checks_is_refused_over_ssh() {
    let (_dir, path, listener) = listener();
    let client = connect_through("box", relay_to(&path), options()).unwrap();
    let _daemon = welcome(&listener, false);
    assert!(reason(&client.events).contains("no health checks"));
}

#[test]
fn ssh_failures_say_what_went_wrong() {
    let cases = [
        ("ssh: Could not resolve hostname box: nodename nor servname", "cannot find box"),
        ("No ED25519 host key is known for box.\nHost key verification failed.", "approve its key"),
        ("box: Permission denied (publickey).", "could not sign in"),
    ];
    for (stderr, expected) in cases {
        let script = format!("printf '%s\\n' '{stderr}' >&2; exit 255");
        let client = connect_through("box", fake_ssh(&script), options()).unwrap();
        let unknown_key = expected == "approve its key";
        if unknown_key {
            let Event::UnknownHostKey { host } = next(&client.events) else {
                panic!("an unknown key is announced before the disconnect");
            };
            assert_eq!(host, "box");
        }
        let reason = reason(&client.events);
        assert!(reason.contains(expected), "{stderr:?} -> {reason}");
    }
}

/// Through the real `ssh`, as the app dials: run with
/// `HERDR_TEST_SSH_HOST=<alias> cargo test live_ssh_host -- --ignored`.
/// The host's key must already be known and Herdr installed there.
#[test]
#[ignore = "needs an ssh host running Herdr, named by HERDR_TEST_SSH_HOST"]
fn live_ssh_host() {
    let host = std::env::var("HERDR_TEST_SSH_HOST").unwrap();
    let client = connect(Target::Ssh(host), options()).unwrap();
    let wait = crate::herdr::session::REMOTE_HANDSHAKE_TIMEOUT;
    let mut connected = false;
    loop {
        match client.events.recv_timeout(wait).unwrap() {
            Event::Connected(_) => connected = true,
            Event::Snapshot(_) => break,
            Event::Disconnected { reason } => panic!("disconnected: {reason}"),
            _ => {}
        }
    }
    assert!(connected);
    // Quiet past a ping: the link must still be up after its pong.
    std::thread::sleep(health::QUIET + Duration::from_secs(2));
    assert!(!matches!(client.events.try_recv(), Ok(Event::Disconnected { .. })));
    client.handle.disconnect();
}
