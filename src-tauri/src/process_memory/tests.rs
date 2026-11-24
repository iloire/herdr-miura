use super::*;

fn row(ppid: u32, kb: u64, name: &str, env: Option<&str>) -> Row {
    Row {
        ppid,
        kb,
        name: name.to_owned(),
        command: name.to_owned(),
        env: env.map(str::to_owned),
    }
}

fn ours(rows: Vec<(u32, Row)>) -> HashMap<String, Vec<Process>> {
    attribute(
        rows.into_iter().collect(),
        |socket| socket.is_empty() || socket == "/h/herdr.sock",
        |_, kb| kb * 1024,
    )
}

fn pids(list: &[Process]) -> Vec<u32> {
    list.iter().map(|process| process.pid).collect()
}

#[test]
fn processes_go_to_their_pane_largest_first() {
    let pane = Some("HERDR_PANE_ID=w1:p1 HERDR_SOCKET_PATH=/h/herdr.sock");
    let panes = ours(vec![
        (10, row(1, 900, "herdr", None)),
        (11, row(10, 5_000, "zsh", pane)),
        (12, row(11, 400_000, "claude", pane)),
        // Renamed itself, so its environment reads empty: its parent tells.
        (13, row(12, 90_000, "next-server", Some(""))),
        (20, row(1, 1_000_000, "Safari", Some("HOME=/h"))),
    ]);
    assert_eq!(panes.len(), 1, "a process outside Herdr belongs to no pane");
    assert_eq!(pids(&panes["w1:p1"]), [12, 13, 11]);
    assert_eq!(panes["w1:p1"][0].bytes, 400_000 * 1024);
}

#[test]
fn another_daemons_panes_are_not_ours() {
    let panes = ours(vec![
        (11, row(1, 5_000, "zsh", Some("HERDR_PANE_ID=w1:p1 HERDR_SOCKET_PATH=/other/herdr.sock"))),
        (12, row(11, 5_000, "vim", None)),
        (21, row(1, 5_000, "zsh", Some("HERDR_PANE_ID=w2:p1 HERDR_SOCKET_PATH=/h/herdr.sock"))),
    ]);
    assert_eq!(panes.keys().collect::<Vec<_>>(), ["w2:p1"]);
}

#[test]
fn a_parent_loop_ends() {
    let panes = ours(vec![(5, row(6, 1, "a", None)), (6, row(5, 1, "b", None))]);
    assert!(panes.is_empty());
}

#[test]
fn values_end_at_the_next_entry() {
    let env = "HERDR_SOCKET_PATH=/Users/a b/herdr.sock HERDR_PANE_ID=w1:p2 TERM=xterm";
    assert_eq!(var(env, "HERDR_SOCKET_PATH"), Some("/Users/a b/herdr.sock"));
    assert_eq!(var(env, "HERDR_PANE_ID"), Some("w1:p2"));
    assert_eq!(var("XHERDR_PANE_ID=w1", "HERDR_PANE_ID"), None);
    assert_eq!(var("PATH=/bin", "HERDR_PANE_ID"), None);
}
