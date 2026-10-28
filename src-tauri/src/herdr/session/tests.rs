use super::*;
use crate::herdr::{
    surface::tests::{patch, surface},
    wire::ClientShellSnapshot,
};

pub(crate) fn welcome_message(generation: u32, methods: &[&str]) -> ServerMessage {
    let welcome = EndpointServerWelcome {
        generation,
        server_version: "0.9.5".into(),
        snapshot_codec: SNAPSHOT_CODEC_V1.into(),
        surface_codec: SURFACE_CODEC_V1.into(),
        input_codec: INPUT_CODEC_V1.into(),
        blob_codec: BLOB_CODEC_V1.into(),
        methods: methods.iter().map(|m| (*m).into()).collect(),
        capabilities: Vec::new(),
        error: None,
    };
    ServerMessage::EndpointControl {
        kind: ENDPOINT_WELCOME_KIND.into(),
        data: serde_json::to_string(&welcome).unwrap(),
    }
}

pub(crate) fn snapshot_message(boot_id: &str, revision: u64) -> ServerMessage {
    let snapshot = serde_json::json!({
        "boot_id": boot_id, "revision": revision, "config_diagnostic": null,
        "product_announcement": null, "update_available": null, "update_install_command": "",
        "server_keybindings_toml": null, "latest_release_notes_available": false,
        "integration_updates_available": false, "worktree_directory": "", "release_notes": null,
        "focused_workspace_id": null, "focused_tab_id": null, "focused_pane_id": null,
        "tab_bar_right": [], "tab_bar_right_separator": "", "agent_view_label": null,
        "agent_order": [], "workspaces": [], "tabs": [], "panes": [], "agents": [], "commands": [],
    });
    let snapshot: ClientShellSnapshot = serde_json::from_value(snapshot).unwrap();
    ServerMessage::EndpointControl {
        kind: ENDPOINT_SNAPSHOT_KIND.into(),
        data: serde_json::to_string(&snapshot).unwrap(),
    }
}

/// A session past its handshake, on boot `b` at revision 1.
fn connected(methods: &[&str]) -> (Session, Vec<Event>) {
    let mut session = Session::new(Instant::now());
    let mut events = Vec::new();
    session
        .handle(welcome_message(1, methods), |e| events.push(e))
        .unwrap();
    session
        .handle(snapshot_message("b", 1), |e| events.push(e))
        .unwrap();
    (session, events)
}

fn request(id: &str, method: &str) -> Command {
    Command {
        boot_id: "b".into(),
        message: ClientMessage::ClientShellEndpointRequest {
            boot_id: "b".into(),
            request: format!(r#"{{"id":"{id}"}}"#),
        },
        request: Some(Request {
            id: id.into(),
            method: method.into(),
        }),
    }
}

fn focus(boot_id: &str) -> Command {
    Command {
        boot_id: boot_id.into(),
        message: ClientMessage::ClientShellFocus { focused: true },
        request: None,
    }
}

/// The messages `bytes` holds, decoded frame by frame.
fn sent(bytes: &[u8]) -> Vec<ClientMessage> {
    let mut reader = bytes;
    let mut messages = Vec::new();
    while !reader.is_empty() {
        messages.push(codec::read(&mut reader).unwrap());
    }
    messages
}

fn chunk(request_id: &str, final_chunk: bool, data: &str) -> ServerMessage {
    ServerMessage::ClientShellEndpointResponseChunk {
        boot_id: "b".into(),
        request_id: request_id.into(),
        final_chunk,
        data: data.as_bytes().to_vec(),
    }
}

#[test]
fn the_handshake_announces_the_welcome_then_the_snapshot() {
    let (_, events) = connected(&[]);
    assert!(matches!(events[0], Event::Connected(_)));
    assert!(matches!(&events[1], Event::Snapshot(s) if s.boot_id == "b"));
}

#[test]
fn a_mismatched_or_legacy_daemon_says_which_side_is_old() {
    let mut session = Session::new(Instant::now());
    let error = session.handle(welcome_message(2, &[]), |_| {}).unwrap_err();
    assert_eq!(
        error.outdated().map(|(side, _)| side),
        Some(crate::herdr::Outdated::Client)
    );
    let error = welcome(welcome_message(0, &[])).unwrap_err();
    assert_eq!(
        error.outdated().map(|(side, _)| side),
        Some(crate::herdr::Outdated::Daemon)
    );
    let legacy = ServerMessage::Welcome {
        version: 1,
        encoding: crate::herdr::wire::RenderEncoding::SemanticFrame,
        error: None,
    };
    assert!(matches!(welcome(legacy), Err(Error::LegacyDaemon)));
}

#[test]
fn a_snapshot_never_changes_boot_or_goes_back() {
    let (mut session, _) = connected(&[]);
    session.handle(snapshot_message("b", 3), |_| {}).unwrap();
    assert!(matches!(
        session.handle(snapshot_message("b", 2), |_| {}),
        Err(Error::SnapshotIdentity)
    ));
    let (mut session, _) = connected(&[]);
    assert!(matches!(
        session.handle(snapshot_message("other", 2), |_| {}),
        Err(Error::SnapshotIdentity)
    ));
}

#[test]
fn a_surface_waits_for_its_projection_then_shows() {
    let (mut session, _) = connected(&[]);
    let mut ahead = surface();
    ahead.projection_revision = 2;
    let mut events = Vec::new();
    session
        .handle(ServerMessage::PaneSurface(ahead), |e| events.push(e))
        .unwrap();
    assert!(events.is_empty(), "projection 2 is not the snapshot's yet");
    session
        .handle(snapshot_message("b", 2), |e| events.push(e))
        .unwrap();
    assert!(matches!(
        events.as_slice(),
        [Event::Snapshot(_), Event::Surface(_)]
    ));
}

#[test]
fn surfaces_must_follow_the_snapshot_and_move_forward() {
    let mut session = Session::new(Instant::now());
    session.handle(welcome_message(1, &[]), |_| {}).unwrap();
    assert!(matches!(
        session.handle(ServerMessage::PaneSurface(surface()), |_| {}),
        Err(Error::SurfaceBeforeSnapshot)
    ));
    let (mut session, _) = connected(&[]);
    session
        .handle(ServerMessage::PaneSurface(surface()), |_| {})
        .unwrap();
    assert!(matches!(
        session.handle(ServerMessage::PaneSurface(surface()), |_| {}),
        Err(Error::SurfaceIdentity)
    ));
}

#[test]
fn a_patch_needs_a_base_and_shows_the_patched_surface() {
    let (mut session, _) = connected(&[]);
    assert!(matches!(
        session.handle(ServerMessage::PaneSurfacePatch(patch(Vec::new())), |_| {}),
        Err(Error::PatchBeforeBaseline)
    ));
    session
        .handle(ServerMessage::PaneSurface(surface()), |_| {})
        .unwrap();
    let mut events = Vec::new();
    session
        .handle(ServerMessage::PaneSurfacePatch(patch(Vec::new())), |e| {
            events.push(e)
        })
        .unwrap();
    assert!(matches!(&events[..], [Event::Surface(s)] if s.surface_revision == 2));
}

#[test]
fn an_encoding_never_asked_for_ends_the_connection() {
    let (mut session, _) = connected(&[]);
    let delta = ServerMessage::EndpointControl {
        kind: "endpoint.surface-delta.v1".into(),
        data: String::new(),
    };
    assert!(matches!(
        session.handle(delta, |_| {}),
        Err(Error::Encoding(_))
    ));
    let unknown = ServerMessage::EndpointControl {
        kind: "endpoint.something-new.v1".into(),
        data: String::new(),
    };
    session.handle(unknown, |_| {}).unwrap();
}

#[test]
fn one_request_at_a_time_with_input_kept_behind_it_in_order() {
    let (mut session, _) = connected(&["tab.focus"]);
    for command in [
        request("1", "tab.focus"),
        focus("b"),
        request("2", "tab.focus"),
    ] {
        session.enqueue(command).unwrap();
    }
    let mut out = Vec::new();
    session.flush(&mut out, Instant::now(), |_| {}).unwrap();
    assert_eq!(
        sent(&out).len(),
        2,
        "the second request waits, and so does nothing after it"
    );

    let mut events = Vec::new();
    session
        .handle(chunk("1", false, r#"{"id":"1","#), |e| events.push(e))
        .unwrap();
    session
        .handle(chunk("1", true, r#""result":{}}"#), |e| events.push(e))
        .unwrap();
    assert!(matches!(&events[..], [Event::Response { request_id, .. }] if request_id == "1"));
    let mut out = Vec::new();
    session.flush(&mut out, Instant::now(), |_| {}).unwrap();
    assert_eq!(
        sent(&out).len(),
        1,
        "the answer frees the lease for the next request"
    );
}

#[test]
fn stale_boots_and_unoffered_methods_are_dropped_not_sent() {
    let (mut session, _) = connected(&["tab.focus"]);
    session.enqueue(focus("old")).unwrap();
    session.enqueue(request("1", "pane.nuke")).unwrap();
    session.enqueue(focus("b")).unwrap();
    let (mut out, mut events) = (Vec::new(), Vec::new());
    session
        .flush(&mut out, Instant::now(), |e| events.push(e))
        .unwrap();
    assert_eq!(sent(&out).len(), 1);
    assert!(matches!(
        &events[0],
        Event::Rejected {
            request_id: None,
            reason: Error::CommandBoot
        }
    ));
    assert!(
        matches!(&events[1], Event::Rejected { request_id: Some(id), reason: Error::UnsupportedMethod(_) } if id == "1")
    );
}

#[test]
fn the_queue_is_bounded() {
    let (mut session, _) = connected(&["tab.focus"]);
    for _ in 0..MAX_QUEUED {
        session.enqueue(focus("b")).unwrap();
    }
    assert!(session.enqueue(focus("b")).is_err());
}

#[test]
fn responses_must_match_the_request_on_screen() {
    let (mut session, _) = connected(&["tab.focus"]);
    assert!(matches!(
        session.handle(chunk("9", true, "{}"), |_| {}),
        Err(Error::UnsolicitedResponse)
    ));
    session.enqueue(request("1", "tab.focus")).unwrap();
    session
        .flush(&mut Vec::new(), Instant::now(), |_| {})
        .unwrap();
    assert!(matches!(
        session.handle(chunk("1", true, r#"{"id":"2"}"#), |_| {}),
        Err(Error::ResponseId)
    ));
}

#[test]
fn a_response_is_bounded() {
    let (mut session, _) = connected(&["tab.focus"]);
    session.enqueue(request("1", "tab.focus")).unwrap();
    session
        .flush(&mut Vec::new(), Instant::now(), |_| {})
        .unwrap();
    let big = "x".repeat(MAX_RESPONSE_BYTES / 2 + 1);
    session.handle(chunk("1", false, &big), |_| {}).unwrap();
    assert!(matches!(
        session.handle(chunk("1", false, &big), |_| {}),
        Err(Error::ResponseLimit)
    ));
}

#[test]
fn a_silent_daemon_times_out() {
    let start = Instant::now();
    let session = Session::new(start);
    assert_eq!(session.deadline(), Some(start + HANDSHAKE_TIMEOUT));
    assert!(matches!(
        session.check_timeouts(start + HANDSHAKE_TIMEOUT),
        Err(Error::HandshakeTimeout)
    ));

    let (mut session, _) = connected(&["tab.focus"]);
    assert_eq!(session.deadline(), None);
    session.enqueue(request("1", "tab.focus")).unwrap();
    session.flush(&mut Vec::new(), start, |_| {}).unwrap();
    session.check_timeouts(start + REQUEST_TIMEOUT / 2).unwrap();
    assert!(matches!(
        session.check_timeouts(start + REQUEST_TIMEOUT),
        Err(Error::RequestTimeout)
    ));
}

#[test]
fn shutdown_ends_the_connection_with_its_reason() {
    let (mut session, _) = connected(&[]);
    let error = session
        .handle(
            ServerMessage::ServerShutdown {
                reason: Some("upgrade".into()),
            },
            |_| {},
        )
        .unwrap_err();
    assert!(matches!(error, Error::ServerShutdown(reason) if reason == "upgrade"));
}
