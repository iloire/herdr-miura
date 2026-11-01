#![allow(clippy::unwrap_used)]

use super::*;
use serde_json::json;

fn shape() -> Value {
    json!({"type": "api-request-shape", "shape": {
        "system": [{"type": "text", "text": "x".repeat(1000)}],
        "tools": [
            {"name": "Read", "description": "y".repeat(500)},
            {"name": "mcp__rea__open", "description": "y".repeat(500)},
        ],
    }})
}

fn instructions(content: &str) -> Value {
    json!({
        "type": "attachment",
        "attachment": {"type": "instructions", "files": [{"path": "/h/CLAUDE.md", "content": content}]},
        "rendered": [{"content": content}],
    })
}

fn response(prompt: u64) -> Value {
    json!({"type": "assistant", "message": {
        "usage": {"input_tokens": 1, "cache_read_input_tokens": prompt - 1},
        "content": [],
    }})
}

fn prompt(text: &str) -> Value {
    json!({"type": "user", "origin": {"kind": "human"}, "message": {"content": text}})
}

fn read_call(id: &str, path: &str) -> Value {
    json!({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": id, "name": "Read", "input": {"file_path": path}},
    ]}})
}

fn result(id: &str, content: Value) -> Value {
    json!({"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": id, "content": content},
    ]}})
}

fn part<'a>(nodes: &'a [Node], name: &str) -> &'a Node {
    nodes.iter().find(|node| node.name == name).unwrap()
}

#[test]
fn splits_the_opening_prompt_over_what_it_held() {
    let found = breakdown(&[
        shape(),
        instructions("## One\nbody\n## Two\nbody body"),
        prompt("hi"),
        response(1000),
    ])
    .unwrap();
    assert_eq!((found.opening, found.context), (1000, 1000));
    let memory = part(&found.startup, "memory");
    assert_eq!(memory.children[0].path.as_deref(), Some("/h/CLAUDE.md"));
    let names: Vec<_> = memory.children[0]
        .children
        .iter()
        .map(|node| &node.name[..])
        .collect();
    assert_eq!(names, ["Two", "One"], "ranked, largest first");
    assert!(part(&found.startup, "claude-code").tokens > 0);
    assert!(part(&part(&found.startup, "mcp").children, "rea").tokens > 0);
    let shared: u64 = found.startup.iter().map(|node| node.tokens).sum();
    assert!(shared.abs_diff(1000) < 10, "{shared}");
}

#[test]
fn the_conversation_is_what_the_context_holds_beyond_the_opening() {
    let lines = [
        shape(),
        prompt("hi"),
        response(1000),
        read_call("a", "/src/App.tsx"),
        result("a", json!("z".repeat(3000))),
        read_call("b", "/src/App.tsx"),
        result("b", json!("z".repeat(3000))),
        read_call("c", "/shot.png"),
        result(
            "c",
            json!([{"type": "image", "source": {"data": "A".repeat(90_000)}}]),
        ),
        response(4000),
    ];
    let found = breakdown(&lines).unwrap();
    let read = part(&part(&found.conversation, "tools").children, "Read");
    assert_eq!(
        part(&read.children, "/src/App.tsx").count,
        2,
        "a call and its result count once"
    );
    assert_eq!(
        part(&read.children, "/src/App.tsx").path.as_deref(),
        Some("/src/App.tsx")
    );
    let image = part(&read.children, "/shot.png").tokens;
    let text = part(&read.children, "/src/App.tsx").tokens;
    assert!(
        image < text,
        "an image counts by its estimate, not its base64: {image} {text}"
    );
    let total: u64 = found.conversation.iter().map(|node| node.tokens).sum();
    assert!(total.abs_diff(3000) < 50, "{total}");
    assert!(
        found
            .conversation
            .iter()
            .all(|node| node.name != "unitemized")
    );
}

#[test]
fn compaction_drops_what_it_replaced_and_keeps_its_segment() {
    let mut kept = result("gone", json!("k".repeat(1000)));
    kept["uuid"] = json!("kept");
    let mut dropped = prompt(&"d".repeat(50_000));
    dropped["uuid"] = json!("dropped");
    let boundary = json!({"type": "system", "subtype": "compact_boundary", "compactMetadata": {
        "preservedSegment": {"headUuid": "kept", "tailUuid": "kept"},
    }});
    let resent = instructions(&"m".repeat(5000));
    let summary =
        json!({"type": "user", "isCompactSummary": true, "message": {"content": "s".repeat(2000)}});
    let lines = [
        shape(),
        prompt("hi"),
        response(1000),
        dropped,
        kept,
        boundary,
        resent,
        summary,
        response(9000),
    ];
    let found = breakdown(&lines).unwrap();
    assert!(
        found.conversation.iter().all(|node| node.name != "prompts"),
        "what was replaced is gone"
    );
    let injected = part(&found.conversation, "injected");
    assert_eq!(
        injected.children.len(),
        2,
        "the kept result and the summary, not the resent memory: {injected:?}"
    );
    let itemized = part(&injected.children, "Compaction summary").tokens;
    assert_eq!(itemized, 1000, "at most two characters a token");
    assert!(part(&found.conversation, "unitemized").tokens > 6000);
}

#[test]
fn a_transcript_without_a_response_has_no_breakdown() {
    assert_eq!(breakdown(&[shape(), prompt("hi")]), None);
}

#[test]
fn sections_ignore_a_heading_in_a_code_fence() {
    let found = sections("intro\n## Real\n```\n## Not\n```\n");
    let names: Vec<_> = found.iter().map(|(name, _)| &name[..]).collect();
    assert_eq!(names, ["Top of file", "Real"]);
}

#[test]
fn skills_group_under_their_plugin_and_keep_a_description_s_later_lines() {
    let mut startup = Tally::default();
    add_skills(
        &mut startup,
        "- solo: short\n- docs:pdf: long\nsecond line of it\n- docs:xlsx: x",
    );
    let nodes = startup.nodes(1.0);
    let skills = part(&nodes, "skills");
    assert_eq!(part(&skills.children, "solo").tokens, 14);
    let docs = part(&skills.children, "docs");
    assert_eq!(part(&docs.children, "pdf").tokens, 35);
    assert_eq!(docs.children.len(), 2);
}

#[test]
fn a_tool_s_long_list_ends_in_one_row_for_the_rest() {
    let mut tally = Tally::default();
    for i in 0..30 {
        tally.add(&["tools", "Bash", &format!("t{i}")], 10);
    }
    let mut nodes = tally.nodes(1.0);
    trim_calls(&mut nodes[0]);
    let bash = part(&nodes[0].children, "Bash");
    assert_eq!(bash.children.len(), MAX_CALLS);
    assert_eq!(bash.children[MAX_CALLS - 1].name, "7 more");
    assert_eq!(bash.children[MAX_CALLS - 1].tokens, 70);
}
