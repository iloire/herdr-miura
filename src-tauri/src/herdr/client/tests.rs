use super::*;
use crate::herdr::{
    session::tests::{snapshot_message, welcome_message},
    surface::tests::surface,
    wire::ClientMessage,
};
use std::os::unix::net::{UnixListener, UnixStream};

const WAIT: Duration = Duration::from_secs(5);

fn options() -> ConnectOptions {
    ConnectOptions {
        surface_size: ClientSurfaceSize { cols: 80, rows: 24 },
        cell_width_px: 8,
        cell_height_px: 16,
    }
}

/// A listening socket in a short private directory, as Unix socket paths
/// must stay under about 100 bytes.
fn listener() -> (tempfile::TempDir, PathBuf, UnixListener) {
    let dir = tempfile::Builder::new()
        .prefix("ht")
        .tempdir_in("/tmp")
        .unwrap();
    let path = dir.path().join("c.sock");
    let listener = UnixListener::bind(&path).unwrap();
    (dir, path, listener)
}

fn next(events: &Receiver<Event>) -> Event {
    events.recv_timeout(WAIT).unwrap()
}

/// Accepts the client, checks its hello asks for no optional encoding, and
/// completes the handshake on boot `b`.
fn handshake(listener: &UnixListener) -> UnixStream {
    let (mut daemon, _) = listener.accept().unwrap();
    let ClientMessage::EndpointControl { kind, data } = codec::read(&mut daemon).unwrap() else {
        panic!("the first message must be the hello");
    };
    assert_eq!(kind, ENDPOINT_HELLO_KIND);
    let hello: EndpointClientHello = serde_json::from_str(&data).unwrap();
    assert!(!hello.surface_delta && !hello.surface_reuse && !hello.surface_scroll);
    assert_eq!(hello.surface_size, options().surface_size);
    codec::write(&mut daemon, &welcome_message(1, &["tab.focus"])).unwrap();
    codec::write(&mut daemon, &snapshot_message("b", 1)).unwrap();
    daemon
}

#[test]
fn connects_shows_a_surface_and_answers_a_request() {
    let (_dir, path, listener) = listener();
    let client = connect_at(path, options()).unwrap();
    let mut daemon = handshake(&listener);
    assert!(matches!(next(&client.events), Event::Connected(_)));
    assert!(matches!(next(&client.events), Event::Snapshot(_)));

    codec::write(&mut daemon, &ServerMessage::PaneSurface(surface())).unwrap();
    assert!(matches!(next(&client.events), Event::Surface(_)));

    let id = client
        .handle
        .request("b", "tab.focus", json!({"tab_id": "t"}))
        .unwrap();
    let ClientMessage::ClientShellEndpointRequest { boot_id, request } =
        codec::read(&mut daemon).unwrap()
    else {
        panic!("expected the request");
    };
    assert_eq!(boot_id, "b");
    let request: Value = serde_json::from_str(&request).unwrap();
    assert_eq!(request["method"], "tab.focus");
    assert_eq!(request["id"], id.as_str());
    let answer = json!({"id": id, "result": {}}).to_string().into_bytes();
    let chunk = ServerMessage::ClientShellEndpointResponseChunk {
        boot_id: "b".into(),
        request_id: id.clone(),
        final_chunk: true,
        data: answer,
    };
    codec::write(&mut daemon, &chunk).unwrap();
    let Event::Response { request_id, .. } = next(&client.events) else {
        panic!("expected the response");
    };
    assert_eq!(request_id, id);
}

#[test]
fn a_daemon_that_goes_away_ends_with_a_reason() {
    let (_dir, path, listener) = listener();
    let client = connect_at(path, options()).unwrap();
    drop(handshake(&listener));
    let reason = loop {
        if let Event::Disconnected { reason } = next(&client.events) {
            break reason;
        }
    };
    assert_eq!(reason, "the connection closed");
}

#[test]
fn a_protocol_violation_ends_the_connection() {
    let (_dir, path, listener) = listener();
    let client = connect_at(path, options()).unwrap();
    let mut daemon = handshake(&listener);
    let mut stale = surface();
    stale.boot_id = "other".into();
    codec::write(&mut daemon, &ServerMessage::PaneSurface(stale)).unwrap();
    let reason = loop {
        if let Event::Disconnected { reason } = next(&client.events) {
            break reason;
        }
    };
    assert!(
        reason.contains("older than the one shown, or for another boot"),
        "{reason}"
    );
}

#[test]
fn no_daemon_is_a_connect_error_naming_the_socket() {
    let (_dir, path, listener) = listener();
    drop(listener);
    let client = connect_at(path.clone(), options()).unwrap();
    let Event::Disconnected { reason } = next(&client.events) else {
        panic!("expected a disconnect");
    };
    assert!(reason.contains(&path.display().to_string()), "{reason}");
}

#[test]
fn a_stopped_connection_goes_quiet_and_refuses_more_work() {
    let (_dir, path, listener) = listener();
    let client = connect_at(path, options()).unwrap();
    let _daemon = handshake(&listener);
    client.handle.disconnect();
    assert!(matches!(
        client.handle.set_focus("b", true),
        Err(Error::Closed)
    ));
    // Events already queued may still arrive, but never a Disconnected.
    while let Ok(event) = client.events.recv_timeout(Duration::from_millis(500)) {
        assert!(!matches!(event, Event::Disconnected { .. }), "{event:?}");
    }
}

#[test]
fn an_empty_or_huge_grid_is_refused_before_connecting() {
    let mut empty = options();
    empty.surface_size.rows = 0;
    assert!(matches!(
        connect_at(PathBuf::from("/nonexistent"), empty),
        Err(Error::EmptySurface)
    ));
    let mut huge = options();
    huge.surface_size = ClientSurfaceSize {
        cols: 4096,
        rows: 4096,
    };
    assert!(matches!(
        connect_at(PathBuf::from("/nonexistent"), huge),
        Err(Error::GeometryLimit)
    ));
}

/// Against a real daemon: `HERDR_TEST_CLIENT_SOCKET=/path/herdr-client.sock
/// cargo test live_daemon -- --ignored`. Point it at a sandboxed daemon, never
/// your own: it focuses the workspace that is already focused, which changes
/// nothing, and resizes this connection's own grid.
#[test]
#[ignore = "needs a running Herdr daemon named by HERDR_TEST_CLIENT_SOCKET"]
fn live_daemon() {
    let path = std::env::var_os("HERDR_TEST_CLIENT_SOCKET").expect("HERDR_TEST_CLIENT_SOCKET");
    let client = connect_at(path.into(), options()).unwrap();
    let Event::Connected(welcome) = next(&client.events) else {
        panic!("expected the welcome");
    };
    eprintln!(
        "daemon {} offers {} methods",
        welcome.server_version,
        welcome.methods.len()
    );
    let Event::Snapshot(snapshot) = next(&client.events) else {
        panic!("expected the snapshot");
    };
    let surface = loop {
        match next(&client.events) {
            Event::Surface(surface) => break surface,
            Event::Disconnected { reason } => panic!("{reason}"),
            _ => {}
        }
    };
    assert_eq!(surface.boot_id, snapshot.boot_id);
    assert_eq!(
        (surface.frame.width, surface.frame.height),
        (options().surface_size.cols, options().surface_size.rows)
    );
    eprintln!(
        "{} workspaces, {} panes, surface {}x{}",
        snapshot.workspaces.len(),
        snapshot.panes.len(),
        surface.frame.width,
        surface.frame.height
    );

    let workspace = snapshot
        .focused_workspace_id
        .clone()
        .expect("a focused workspace");
    let id = client
        .handle
        .request(
            &snapshot.boot_id,
            "workspace.focus",
            json!({"workspace_id": workspace}),
        )
        .unwrap();
    let response = loop {
        match next(&client.events) {
            Event::Response {
                request_id,
                response,
            } if request_id == id => break response,
            Event::Disconnected { reason } => panic!("{reason}"),
            _ => {}
        }
    };
    assert!(
        response.get("error").is_none_or(Value::is_null),
        "{response}"
    );

    let mut smaller = options();
    smaller.surface_size = ClientSurfaceSize { cols: 60, rows: 20 };
    client.handle.resize(&snapshot.boot_id, smaller).unwrap();
    let resized = loop {
        match next(&client.events) {
            Event::Surface(surface) if surface.frame.width == 60 => break surface,
            Event::Disconnected { reason } => panic!("{reason}"),
            _ => {}
        }
    };
    assert_eq!(resized.frame.height, 20);

    // Typed text comes back as row patches on top of that surface; the
    // marker must show up in the grid this client rebuilt from them.
    let pane = snapshot.focused_pane_id.clone().expect("a focused pane");
    // Short enough not to wrap in a narrow pane, and new on every run.
    let marker = format!("ht{}", std::process::id() % 100_000);
    client
        .handle
        .send_input(
            &snapshot.boot_id,
            &pane,
            vec![ClientPaneInputEvent::TextCommit(marker.clone())],
        )
        .unwrap();
    let deadline = Instant::now() + WAIT;
    let typed = loop {
        assert!(Instant::now() < deadline, "the typed text never appeared");
        match next(&client.events) {
            Event::Surface(surface) => {
                let width = usize::from(surface.frame.width.max(1));
                let shown = surface.frame.cells.chunks(width).any(|row| {
                    row.iter()
                        .map(|c| c.symbol.as_str())
                        .collect::<String>()
                        .contains(&marker)
                });
                if shown {
                    break surface;
                }
            }
            Event::Disconnected { reason } => panic!("{reason}"),
            _ => {}
        }
    };
    assert!(typed.surface_revision > resized.surface_revision);
    client.handle.disconnect();
}
mod ssh;
