use super::*;

fn ours(text: &str) -> HashMap<String, Vec<Port>> {
    parse(text, |socket| {
        socket.is_empty() || socket == "/h/herdr.sock"
    })
    .unwrap()
}

fn numbers(ports: &HashMap<String, Vec<Port>>, workspace: &str) -> Vec<u16> {
    ports[workspace].iter().map(|port| port.port).collect()
}

#[test]
fn listeners_go_to_the_workspace_their_pane_names() {
    let ports = ours(
        "L 10 *:5173 node\n\
         L 11 127.0.0.1:3000 next-server\n\
         L 12 *:7000 ControlCenter\n\
         E 10 w1 w1:p1 /h/herdr.sock\n\
         E 11 w2 w2:p1 /h/herdr.sock\n",
    );
    assert_eq!(
        ports.len(),
        2,
        "a listener outside Herdr belongs to no workspace"
    );
    assert_eq!(numbers(&ports, "w1"), [5173]);
    let next = &ports["w2"][0];
    assert_eq!(next.process, "next-server");
    assert_eq!(next.address, "localhost:3000");
    assert_eq!(next.url, "http://localhost:3000/");
}

#[test]
fn another_daemons_panes_are_not_ours() {
    let ports = ours(
        "L 10 *:5173 node\nL 11 *:8080 node\n\
         E 10 w1 w1:p1 /h/sessions/dev/herdr.sock\nE 11 w1\n",
    );
    assert_eq!(
        numbers(&ports, "w1"),
        [8080],
        "a pane that names no daemon is given the benefit of the doubt"
    );
}

#[test]
fn one_server_on_both_families_shows_once_at_its_widest() {
    let ports = ours(
        "L 10 [::1]:5173 node\nL 10 *:5173 node\nL 10 127.0.0.1:4000 node\nL 10 *:80 nginx\n\
         E 10 w1 w1:p1 /h/herdr.sock\n",
    );
    assert_eq!(numbers(&ports, "w1"), [80, 4000, 5173]);
    assert_eq!(ports["w1"][2].address, "*:5173");
}

#[test]
fn a_specific_address_opens_at_that_address() {
    let ports = ours(
        "L 10 192.168.1.5:8000 python\nL 10 [fe80::1%en0]:9000 x\nE 10 w1 w1:p1 /h/herdr.sock\n",
    );
    assert_eq!(ports["w1"][0].url, "http://192.168.1.5:8000/");
    assert_eq!(ports["w1"][1].url, "http://[fe80::1]:9000/");
}

#[test]
fn junk_is_skipped_and_a_missing_tool_is_an_error() {
    let ports = ours(
        "L x *:1 a\nL 10 nope\nL 10 *:0 a\nL 10 *:22 sshd\nE 10 w=1 w1:p1 /h/herdr.sock\nE 10 w1\n",
    );
    assert_eq!(numbers(&ports, "w1"), [22]);
    assert!(matches!(parse("N\n", |_| true), Err(Error::Tool)));
}

#[test]
fn a_listener_names_its_pane() {
    let ports = ours(
        "L 10 *:5173 node\nL 11 *:3000 node\nL 12 *:4000 node\n\
         E 10 w1 w1:p2Z /h/herdr.sock\n\
         E 11 w1  /h/herdr.sock\n\
         E 12 w1 w=1 /h/herdr.sock\n",
    );
    let pane = |port: usize| ports["w1"][port].pane.as_deref();
    assert_eq!(pane(0), None, "a pane from an older Herdr names none");
    assert_eq!(pane(1), None, "a bad id is no pane, but the port stays");
    assert_eq!(pane(2), Some("w1:p2Z"));
    assert_eq!(numbers(&ports, "w1"), [3000, 4000, 5173]);
}

#[test]
fn a_socket_and_a_process_keep_their_spaces() {
    let ports = parse(
        "L 13 *:6000 Google Chrome He\nE 13 w1 w1:p3 /h/a dir/herdr.sock\n",
        |socket| socket == "/h/a dir/herdr.sock",
    )
    .unwrap();
    assert_eq!(ports["w1"][0].pane.as_deref(), Some("w1:p3"));
    assert_eq!(ports["w1"][0].process, "Google Chrome He");
}

#[test]
fn the_wider_socket_brings_its_own_pane() {
    let ports = ours(
        "L 10 127.0.0.1:3000 node\nL 11 *:3000 node\n\
         E 10 w1 w1:p1 /h/herdr.sock\nE 11 w1 w1:p2 /h/herdr.sock\n",
    );
    assert_eq!(ports["w1"][0].pane.as_deref(), Some("w1:p2"));
}

#[test]
fn a_port_serializes_its_pane_and_keeps_reach_private() {
    let ports = ours("L 10 *:3000 node\nE 10 w1 w1:p1 /h/herdr.sock\n");
    let json = serde_json::to_value(&ports["w1"][0]).unwrap();
    assert_eq!(json["pane"], "w1:p1");
    assert!(json.get("reach").is_none());
    let old = ours("L 10 *:3000 node\nE 10 w1\n");
    let json = serde_json::to_value(&old["w1"][0]).unwrap();
    assert!(json["pane"].is_null(), "a pane the webview reads as null");
}

/// Scans this machine for real: `cargo test live_scan -- --ignored --nocapture`.
#[test]
#[ignore = "lists this machine's real listeners"]
fn live_scan() {
    let ports = scan().unwrap();
    println!("{ports:#?}");
}
