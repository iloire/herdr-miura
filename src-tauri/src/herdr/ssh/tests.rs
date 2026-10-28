use super::*;
use std::io::Cursor;

#[test]
fn targets_that_could_be_options_or_split_are_refused() {
    for good in ["box", "ivan@box.local", "build-01", "[::1]"] {
        validate_target(good).unwrap();
    }
    for bad in ["", "-oProxyCommand=x", "box; rm -rf ~", "a b", "box\n", "$(id)"] {
        assert!(validate_target(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn quoting_survives_single_quotes() {
    assert_eq!(quote("it's"), r"'it'\''s'");
}

#[test]
fn the_script_runs_in_sh_and_finds_herdr_where_herdr_looks() {
    let script = bridge_script();
    assert!(script.contains("exec \"$path\" remote-client-bridge"));
    assert!(script.contains(READY_MARKER));
    for place in ["/opt/homebrew/bin/herdr", "$HOME/.local/bin/herdr", "mise/shims/herdr"] {
        assert!(script.contains(place), "{place}");
    }
    // The quoted script must come back intact through a real shell.
    let echoed = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(format!("printf %s {}", quote(&script)))
        .output()
        .unwrap();
    assert_eq!(String::from_utf8(echoed.stdout).unwrap(), script);
}

#[test]
fn the_command_never_prompts_and_never_trusts_a_new_key() {
    let command = command("box", Some(Path::new("/tmp/c")));
    let args: Vec<_> = command.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
    for option in ["BatchMode=yes", "StrictHostKeyChecking=yes", "NumberOfPasswordPrompts=0", "ControlPath=/tmp/c/%C"] {
        assert!(args.iter().any(|a| a == option), "{option}");
    }
    let dashes = args.iter().position(|a| a == "--").unwrap();
    assert_eq!(args[dashes + 1], "box", "the host follows `--`, never read as an option");
}

#[test]
fn the_preamble_is_skipped_up_to_the_marker_and_no_further() {
    let mut stream = Cursor::new(format!("Welcome to box\r\nlast login\n\n{READY_MARKER}\r\nFRAMES").into_bytes());
    assert_eq!(skip_preamble(&mut stream, "box").unwrap(), Some(Ok(())));
    let mut rest = String::new();
    std::io::Read::read_to_string(&mut stream, &mut rest).unwrap();
    assert_eq!(rest, "FRAMES");
}

#[test]
fn a_stream_without_the_marker_is_a_failure_or_too_long() {
    assert_eq!(skip_preamble(&mut Cursor::new(b"banner\n".to_vec()), "box").unwrap(), None);
    let noise = vec![b'x'; MAX_PREAMBLE + 10];
    assert!(matches!(skip_preamble(&mut Cursor::new(noise), "box").unwrap(), Some(Err(Error::Preamble { .. }))));
}

#[test]
fn ssh_failures_read_as_what_went_wrong() {
    let cases = [
        ("No ED25519 host key is known for box and you have requested strict checking.\nHost key verification failed.", "UnknownHostKey"),
        ("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.", "HostKeyChanged"),
        ("ivan@box: Permission denied (publickey).", "AuthFailed"),
        ("ssh: Could not resolve hostname box: nodename nor servname provided", "UnknownHost"),
        ("ssh: connect to host box port 22: Connection refused", "Unreachable"),
        (NOT_FOUND, "HerdrMissing"),
        ("something new", "Failed"),
    ];
    for (stderr, kind) in cases {
        let error = format!("{:?}", classify("box", stderr));
        assert!(error.starts_with(kind), "{stderr:?} -> {error}");
    }
}

#[test]
fn without_a_private_directory_logins_are_not_shared() {
    let args: Vec<_> = command("box", None).get_args().map(|a| a.to_string_lossy().into_owned()).collect();
    assert!(!args.iter().any(|a| a.starts_with("ControlPath") || a.starts_with("ControlMaster")));
}

#[cfg(unix)]
#[test]
fn the_control_directory_is_private() {
    use std::os::unix::fs::PermissionsExt;
    let dir = control_dir().unwrap();
    assert!(dir.as_os_str().len() < 40, "room for %C under the socket path limit");
    assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
}
