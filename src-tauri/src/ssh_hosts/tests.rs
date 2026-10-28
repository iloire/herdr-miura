use super::*;

#[test]
fn hosts_come_from_config_and_its_includes_without_patterns() {
    let home = tempfile::tempdir().unwrap();
    let ssh_dir = home.path().join(".ssh");
    std::fs::create_dir_all(ssh_dir.join("config.d")).unwrap();
    std::fs::write(
        ssh_dir.join("config"),
        "# mine\nHost build box.local\n  User ivan\nHost *.corp !bad *\nHost=gpu\nInclude config.d/*\nInclude config\n",
    )
    .unwrap();
    std::fs::write(ssh_dir.join("config.d/work"), "host nas -oProxyCommand=x\n").unwrap();
    let mut hosts = BTreeSet::new();
    read_config(&ssh_dir.join("config"), &ssh_dir, 0, &mut hosts);
    let hosts: Vec<_> = hosts.into_iter().collect();
    assert_eq!(hosts, ["box.local", "build", "gpu", "nas"]);
}

#[test]
fn ssh_g_output_names_the_host_its_port_and_known_hosts() {
    let config = "user ivan\nhostname 10.0.0.5\nport 2222\nuserknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\n";
    let resolved = parse_resolved(config, Path::new("/home/i")).unwrap();
    assert_eq!(
        resolved,
        Resolved {
            known_as: "10.0.0.5".into(),
            hostname: "10.0.0.5".into(),
            port: 2222,
            known_hosts: "/home/i/.ssh/known_hosts".into(),
        }
    );
    assert_eq!(known_hosts_name(&resolved.known_as, resolved.port), "[10.0.0.5]:2222");
    assert_eq!(known_hosts_name("box", 22), "box");
    let aliased = format!("{config}hostkeyalias shared\n");
    assert_eq!(parse_resolved(&aliased, Path::new("/h")).unwrap().known_as, "shared");
}

#[test]
fn only_plain_scanned_keys_become_known_hosts_lines() {
    let scanned = "# box:22 SSH-2.0-OpenSSH_9.6\nbox ssh-ed25519 AAAAC3Nza+/=\nbox ssh-rsa AAAAB3 extra field\nbox ssh-ed25519 AAAA\\nevil\nbox ssh-ed25519 AAAAC3Nza+/=\n";
    assert_eq!(key_lines(scanned, "[box]:2222"), ["[box]:2222 ssh-ed25519 AAAAC3Nza+/="]);
}

#[test]
fn fingerprints_are_read_from_ssh_keygen() {
    let text = "256 SHA256:abcDEF123 [box]:2222 (ED25519)\n3072 SHA256:xyz box (RSA)\nnonsense\n";
    assert_eq!(
        parse_fingerprints(text),
        [
            Fingerprint { key_type: "ED25519".into(), fingerprint: "SHA256:abcDEF123".into() },
            Fingerprint { key_type: "RSA".into(), fingerprint: "SHA256:xyz".into() },
        ]
    );
}

#[test]
fn approval_writes_only_the_scanned_keys_of_that_host() {
    let dir = tempfile::tempdir().unwrap();
    let known_hosts = dir.path().join("ssh/known_hosts");
    std::fs::create_dir_all(known_hosts.parent().unwrap()).unwrap();
    std::fs::write(&known_hosts, "old ssh-ed25519 AAAA").unwrap();
    let pending = PendingKeys::default();
    *pending.0.lock().unwrap() = Some(Scan {
        host: "box".into(),
        known_hosts: known_hosts.clone(),
        lines: vec!["box ssh-ed25519 BBBB".into()],
    });
    assert!(matches!(trust(&pending, "other"), Err(Error::NotScanned { .. })));
    trust(&pending, "box").unwrap();
    assert_eq!(std::fs::read_to_string(&known_hosts).unwrap(), "old ssh-ed25519 AAAA\nbox ssh-ed25519 BBBB\n");
    assert!(matches!(trust(&pending, "box"), Err(Error::NotScanned { .. })), "an approval is used once");
}

#[cfg(unix)]
#[test]
fn a_new_known_hosts_file_is_private() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("known_hosts");
    append(&path, &["box ssh-ed25519 AAAA".into()]).unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
}
