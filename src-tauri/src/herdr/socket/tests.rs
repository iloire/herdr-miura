use super::*;
use std::collections::HashMap;

fn path(vars: &[(&str, &str)]) -> PathBuf {
    let vars: HashMap<_, _> = vars.iter().copied().collect();
    resolve(|name| vars.get(name).map(OsString::from))
}

#[test]
fn the_api_socket_names_its_client_sibling_first() {
    let found = path(&[
        ("HERDR_SOCKET_PATH", "/tmp/hd/a.sock"),
        ("HERDR_CLIENT_SOCKET_PATH", "/tmp/other.sock"),
    ]);
    assert_eq!(found, PathBuf::from("/tmp/hd/a-client.sock"));
}

#[test]
fn the_client_override_comes_next() {
    assert_eq!(
        path(&[
            ("HERDR_CLIENT_SOCKET_PATH", "/tmp/c.sock"),
            ("HOME", "/home/u")
        ]),
        PathBuf::from("/tmp/c.sock")
    );
}

#[test]
fn the_default_lives_in_the_config_directory() {
    assert_eq!(
        path(&[("HOME", "/home/u")]),
        PathBuf::from("/home/u/.config/herdr/herdr-client.sock")
    );
    assert_eq!(
        path(&[("HOME", "/home/u"), ("XDG_CONFIG_HOME", "/cfg")]),
        PathBuf::from("/cfg/herdr/herdr-client.sock")
    );
}

#[test]
fn a_named_session_has_its_own_directory() {
    assert_eq!(
        path(&[("HOME", "/h"), ("HERDR_SESSION", "work")]),
        PathBuf::from("/h/.config/herdr/sessions/work/herdr-client.sock")
    );
}

#[test]
fn default_or_invalid_session_names_mean_the_default_session() {
    for name in ["default", "..", "a/b", ""] {
        assert_eq!(
            path(&[("HOME", "/h"), ("HERDR_SESSION", name)]),
            PathBuf::from("/h/.config/herdr/herdr-client.sock"),
            "{name}"
        );
    }
}
