//! What fills a Claude Code session's context, for the Context dialog. The API
//! reports one number per response; which memory file, skill or tool result
//! that number is made of can only be worked out from the transcript, which
//! keeps each part of the prompt: the system prompt and tool definitions in
//! `api-request-shape` lines, the memory files and listings in `attachment`
//! lines, and the conversation in `user` and `assistant` lines.
//!
//! Characters are shared out over the measured tokens, so the totals are real
//! and the split is an estimate. The first response's prompt is the startup
//! load, and everything the last response's prompt holds beyond that is the
//! conversation. Compaction leaves more in the prompt than the transcript can
//! itemize, and what is left over is reported as such rather than spread over
//! the rest.

use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

/// Tokens a character of conversation is worth at most. Measured over 45
/// sessions it took 1.7 to 2.3 characters, and only compacted sessions fall
/// outside that, where a share computed from what is left would inflate it.
const TOKENS_PER_CHAR: f64 = 0.5;
/// An image counts as this many characters, about 1,500 tokens: its base64 is
/// not what the model is charged for, and the transcript holds no dimensions.
const IMAGE_CHARS: u64 = 3000;
/// Rows kept per tool, the rest going into one `N more`.
const MAX_CALLS: usize = 24;
/// Characters kept of a tool call's label, such as a long command.
const MAX_LABEL_CHARS: usize = 120;

/// One thing in the context, and what it is made of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Node {
    pub name: String,
    pub tokens: u64,
    /// How many times it went in: a file read four times counts four.
    pub count: u32,
    /// The file it comes from, when it has one to open.
    pub path: Option<String>,
    pub children: Vec<Node>,
}

/// A session's context, as the last response's prompt held it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionContext {
    /// Measured: the last response's prompt.
    pub context: u64,
    /// Measured: the first response's prompt, what opening a session costs.
    pub opening: u64,
    /// `claude-code`, `memory`, `skills`, `mcp`, `agents` and `session`.
    pub startup: Vec<Node>,
    /// `tools`, `prompts`, `replies`, `injected` and `unitemized`.
    pub conversation: Vec<Node>,
}

/// Characters counted so far, by name at every level.
#[derive(Default)]
struct Tally {
    chars: u64,
    count: u32,
    path: Option<String>,
    children: BTreeMap<String, Tally>,
}

impl Tally {
    /// Adds `chars` along `names`, and returns the node they lead to.
    fn add(&mut self, names: &[&str], chars: u64) -> &mut Tally {
        self.chars += chars;
        match names.split_first() {
            Some((name, rest)) => self
                .children
                .entry((*name).to_owned())
                .or_default()
                .add(rest, chars),
            None => {
                self.count += 1;
                self
            }
        }
    }

    fn node(self, name: String, scale: f64) -> Node {
        let mut children: Vec<Node> = self
            .children
            .into_iter()
            .map(|(name, tally)| tally.node(name, scale))
            .collect();
        children.sort_by(|a, b| b.tokens.cmp(&a.tokens).then_with(|| a.name.cmp(&b.name)));
        Node {
            name,
            tokens: (self.chars as f64 * scale).round() as u64,
            count: self.count,
            path: self.path,
            children,
        }
    }

    fn nodes(self, scale: f64) -> Vec<Node> {
        self.node(String::new(), scale).children
    }
}

/// A tool's calls, the largest kept and the rest in one `N more`: a long session
/// makes thousands, and only the large ones are worth a row.
fn trim_calls(tools: &mut Node) {
    for tool in &mut tools.children {
        if tool.children.len() > MAX_CALLS {
            let rest = tool.children.split_off(MAX_CALLS - 1);
            tool.children.push(Node {
                name: format!("{} more", rest.len()),
                tokens: rest.iter().map(|node| node.tokens).sum(),
                count: rest.iter().map(|node| node.count).sum(),
                path: None,
                children: Vec::new(),
            });
        }
    }
}

/// What the transcript at `path` says fills the session's context; `None` when
/// it cannot be read or holds no response yet.
pub fn read(transcript: &Path) -> Option<SessionContext> {
    let bytes = std::fs::read(transcript).ok()?;
    let lines: Vec<Value> = bytes
        .split(|&byte| byte == b'\n')
        // The largest lines, and copies of what other lines say.
        .filter(|line| !line.starts_with(br#"{"type":"api-request-blob""#))
        .filter_map(|line| serde_json::from_slice(line).ok())
        .filter(|line: &Value| !flag(line, "isSidechain"))
        .collect();
    breakdown(&lines)
}

fn breakdown(lines: &[Value]) -> Option<SessionContext> {
    let responses: Vec<(usize, u64)> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, line)| Some((i, prompt_tokens(line)?)))
        .collect();
    let (first_at, opening) = *responses.first()?;
    let context = responses.last()?.1;
    let shape = lines
        .iter()
        .rev()
        .find(|line| kind(line) == "api-request-shape")?
        .get("shape")?;

    let boundary = lines.iter().rposition(is_boundary);
    let kept = boundary.map_or_else(HashSet::new, |at| kept_lines(lines, &lines[at]));
    // Compaction sends the startup listings again, just past the boundary.
    let resent_until = boundary
        .and_then(|at| responses.iter().find(|(i, _)| *i > at))
        .map(|(i, _)| *i);

    let mut startup = Tally::default();
    add_shape(&mut startup, shape);
    let mut conversation = Tally::default();
    let mut calls = BTreeMap::new();
    let mut opening_prompt = 0;
    for (i, line) in lines.iter().enumerate() {
        let live = boundary.is_none_or(|at| i > at)
            || line
                .get("uuid")
                .and_then(Value::as_str)
                .is_some_and(|uuid| kept.contains(uuid));
        match kind(line) {
            "attachment" => {
                let Some(attachment) = line.get("attachment") else {
                    continue;
                };
                let chars = rendered_chars(line);
                let what = text(attachment, "type");
                if chars == 0 {
                    continue;
                }
                if i < first_at {
                    add_attachment(&mut startup, attachment, chars);
                } else if live {
                    let resent = boundary.is_some_and(|at| i > at)
                        && resent_until.is_some_and(|until| i < until)
                        && is_startup_listing(what);
                    if !resent {
                        conversation.add(&["injected", injected_name(what)], chars);
                    }
                }
            }
            "assistant" if live => add_assistant(&mut conversation, line, &mut calls),
            "user" if live => add_user(&mut conversation, line, &calls),
            _ => {}
        }
        if i + 1 == first_at {
            opening_prompt = conversation.chars;
        }
    }

    let startup_scale = opening as f64 / (startup.chars + opening_prompt).max(1) as f64;
    let startup_tokens = (startup.chars as f64 * startup_scale).round() as u64;
    let measured = context.saturating_sub(startup_tokens);
    let mut scale = measured as f64 / conversation.chars.max(1) as f64;
    if boundary.is_some() {
        scale = scale.min(TOKENS_PER_CHAR);
    }
    let itemized = (conversation.chars as f64 * scale).round() as u64;
    let mut parts = conversation.nodes(scale);
    parts
        .iter_mut()
        .filter(|part| part.name == "tools")
        .for_each(trim_calls);
    if measured > itemized && boundary.is_some() {
        parts.push(Node {
            name: "unitemized".to_owned(),
            tokens: measured - itemized,
            count: 0,
            path: None,
            children: Vec::new(),
        });
    }
    Some(SessionContext {
        context,
        opening,
        startup: startup.nodes(startup_scale),
        conversation: parts,
    })
}

/// The prompt of a main-thread response that reports one.
fn prompt_tokens(line: &Value) -> Option<u64> {
    if kind(line) != "assistant" {
        return None;
    }
    let usage = line.get("message")?.get("usage")?;
    let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    let tokens = count("input_tokens")
        + count("cache_read_input_tokens")
        + count("cache_creation_input_tokens");
    (tokens > 0).then_some(tokens)
}

fn kind(line: &Value) -> &str {
    text(line, "type")
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn chars(text: &str) -> u64 {
    text.chars().count() as u64
}

/// Compact JSON's length: what a tool definition or a call's input weighs.
fn json_chars(value: &Value) -> u64 {
    value.to_string().len() as u64
}

fn strings<'a>(value: &'a Value, key: &str) -> Vec<&'a str> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

fn is_boundary(line: &Value) -> bool {
    kind(line) == "system" && text(line, "subtype") == "compact_boundary"
}

/// The lines compaction kept whole: a chain of `parentUuid` from the segment's
/// tail back to its head, written before the boundary.
fn kept_lines<'a>(lines: &'a [Value], boundary: &Value) -> HashSet<&'a str> {
    let segment = boundary
        .get("compactMetadata")
        .and_then(|metadata| metadata.get("preservedSegment"));
    let mut kept = HashSet::new();
    let Some(segment) = segment else {
        return kept;
    };
    let by_uuid: BTreeMap<&str, &Value> = lines
        .iter()
        .filter_map(|line| Some((line.get("uuid")?.as_str()?, line)))
        .collect();
    let head = text(segment, "headUuid");
    let mut at = text(segment, "tailUuid");
    while let Some((&uuid, line)) = by_uuid.get_key_value(at) {
        // A chain that loops would otherwise never reach its head.
        if !kept.insert(uuid) || uuid == head {
            break;
        }
        at = text(line, "parentUuid");
    }
    kept
}

/// The system prompt and tool definitions.
fn add_shape(startup: &mut Tally, shape: &Value) {
    let blocks = shape.get("system").and_then(Value::as_array);
    let system = blocks
        .into_iter()
        .flatten()
        .map(|block| chars(text(block, "text")))
        .sum();
    startup.add(&["claude-code", "System prompt"], system);
    let tools = shape.get("tools").and_then(Value::as_array);
    for tool in tools.into_iter().flatten() {
        let name = text(tool, "name");
        match mcp_server(name) {
            Some(server) => startup.add(&["mcp", server, "Tool definitions"], json_chars(tool)),
            None => startup.add(&["claude-code", name], json_chars(tool)),
        };
    }
}

/// `rea` from `mcp__rea__open_binary`.
fn mcp_server(tool: &str) -> Option<&str> {
    tool.strip_prefix("mcp__")?.split("__").next()
}

fn rendered_chars(line: &Value) -> u64 {
    let blocks = line.get("rendered").and_then(Value::as_array);
    blocks
        .into_iter()
        .flatten()
        .map(|block| chars(text(block, "content")))
        .sum()
}

fn is_startup_listing(what: &str) -> bool {
    matches!(
        what,
        "instructions"
            | "skill_listing"
            | "deferred_tools_delta"
            | "mcp_instructions_delta"
            | "agent_listing_delta"
            | "environment"
            | "session_context"
            | "date"
            | "model"
    )
}

fn add_attachment(startup: &mut Tally, attachment: &Value, rendered: u64) {
    match text(attachment, "type") {
        "instructions" => add_instructions(startup, attachment),
        "skill_listing" => add_skills(startup, text(attachment, "content")),
        "deferred_tools_delta" => add_deferred(startup, attachment),
        "mcp_instructions_delta" => add_mcp_instructions(startup, attachment),
        "agent_listing_delta" => add_agents(startup, attachment),
        what => {
            startup.add(&["session", session_name(what)], rendered);
        }
    }
}

/// Each memory file by its `##` sections, which is the grain they get cut at.
fn add_instructions(startup: &mut Tally, attachment: &Value) {
    let files = attachment.get("files").and_then(Value::as_array);
    for file in files.into_iter().flatten() {
        let path = text(file, "path");
        for (section, size) in sections(text(file, "content")) {
            startup.add(&["memory", path, &section], size);
        }
        if let Some(node) = startup
            .children
            .get_mut("memory")
            .and_then(|memory| memory.children.get_mut(path))
        {
            node.path = Some(path.to_owned());
        }
    }
}

/// A Markdown file's `##` sections with their sizes in file order. What comes
/// before the first goes under `Top of file`; a `##` in a code fence is code.
fn sections(content: &str) -> Vec<(String, u64)> {
    let mut found = vec![("Top of file".to_owned(), 0)];
    let mut fenced = false;
    for line in content.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
        }
        if let Some(heading) = line.strip_prefix("## ").filter(|_| !fenced) {
            found.push((heading.trim().to_owned(), 0));
        }
        if let Some((_, size)) = found.last_mut() {
            *size += chars(line) + 1;
        }
    }
    found.retain(|(_, size)| *size > 0);
    found
}

/// A listing's `- name: description` entries, a plugin's skills under its name.
fn add_skills(startup: &mut Tally, content: &str) {
    let mut entries: Vec<(&str, u64)> = Vec::new();
    for line in content.lines() {
        let name = line
            .strip_prefix("- ")
            .and_then(|rest| rest.split_once(": "));
        match (name, entries.last_mut()) {
            (Some((name, _)), _) => entries.push((name, chars(line) + 1)),
            (None, Some((_, size))) => *size += chars(line) + 1,
            (None, None) => {}
        }
    }
    for (name, size) in entries {
        match name.split_once(':') {
            Some((plugin, skill)) => startup.add(&["skills", plugin, skill], size),
            None => startup.add(&["skills", name], size),
        };
    }
}

/// The names of tools loaded on demand, which every session lists whole, and
/// the definitions of the few it surfaces at once.
fn add_deferred(startup: &mut Tally, attachment: &Value) {
    for line in strings(attachment, "addedLines") {
        match mcp_server(line.split_whitespace().next().unwrap_or("")) {
            Some(server) => startup.add(&["mcp", server, "Tool names"], chars(line) + 1),
            None => startup.add(&["claude-code", "Tool names"], chars(line) + 1),
        };
    }
    let surfaced = attachment
        .get("surfacedDefinitions")
        .and_then(Value::as_array);
    for tool in surfaced.into_iter().flatten() {
        let size = tool.get("definition").map_or(0, json_chars);
        match mcp_server(text(tool, "name")) {
            Some(server) => startup.add(&["mcp", server, "Tool definitions"], size),
            None => startup.add(&["claude-code", text(tool, "name")], size),
        };
    }
}

/// An instruction block names its server as people do, `claude.ai Claude Docs`,
/// and a tool name as `claude_ai_Claude_Docs`.
fn add_mcp_instructions(startup: &mut Tally, attachment: &Value) {
    let names = strings(attachment, "addedNames");
    for (name, block) in names.iter().zip(strings(attachment, "addedBlocks")) {
        let server = name.replace(['.', ' '], "_");
        startup.add(&["mcp", &server, "Instructions"], chars(block));
    }
}

fn add_agents(startup: &mut Tally, attachment: &Value) {
    let types = strings(attachment, "addedTypes");
    for (name, line) in types.iter().zip(strings(attachment, "addedLines")) {
        startup.add(&["agents", name], chars(line) + 1);
    }
}

fn session_name(what: &str) -> &'static str {
    match what {
        "environment" => "Working folders and platform",
        "session_context" => "Git status",
        "credential_org" => "Account",
        "date" => "Date",
        "model" => "Model",
        _ => "Reminders",
    }
}

fn injected_name(what: &str) -> &'static str {
    match what {
        "file" | "compact_file_reference" => "Attached files",
        "invoked_skills" => "Skills used",
        "edited_text_file" => "Notices of edited files",
        "queued_command" => "Messages sent while working",
        what if is_startup_listing(what) => "Listing updates",
        _ => "Reminders",
    }
}

/// A tool call: the tool, and what it was called on.
struct Call {
    tool: String,
    label: String,
    path: Option<String>,
}

impl Call {
    fn read(block: &Value) -> Self {
        let input = block.get("input").unwrap_or(&Value::Null);
        let label = [
            "file_path",
            "notebook_path",
            "path",
            "command",
            "pattern",
            "query",
            "url",
            "description",
            "skill",
            "prompt",
        ]
        .iter()
        .map(|key| text(input, key))
        .find(|value| !value.is_empty())
        .unwrap_or("(no input)");
        let line = label.lines().next().unwrap_or(label);
        let path = text(input, "file_path");
        Self {
            tool: text(block, "name").to_owned(),
            label: line.chars().take(MAX_LABEL_CHARS).collect(),
            path: path.starts_with('/').then(|| path.to_owned()),
        }
    }

    fn add<'a>(&self, conversation: &'a mut Tally, size: u64) -> &'a mut Tally {
        let node = conversation.add(&["tools", &self.tool, &self.label], size);
        node.path = self.path.clone();
        node
    }
}

fn add_assistant(conversation: &mut Tally, line: &Value, calls: &mut BTreeMap<String, Call>) {
    let content = line
        .get("message")
        .and_then(|message| message.get("content"));
    for block in content.and_then(Value::as_array).into_iter().flatten() {
        match text(block, "type") {
            "text" => {
                conversation.add(&["replies"], chars(text(block, "text")));
            }
            "tool_use" => {
                // A response can be written twice; a call counts once.
                let id = text(block, "id");
                if calls.contains_key(id) {
                    continue;
                }
                let call = Call::read(block);
                call.add(conversation, block.get("input").map_or(0, json_chars));
                calls.insert(id.to_owned(), call);
            }
            _ => {}
        }
    }
}

fn add_user(conversation: &mut Tally, line: &Value, calls: &BTreeMap<String, Call>) {
    let message_text: &[&str] = if flag(line, "isCompactSummary") {
        &["injected", "Compaction summary"]
    } else if line
        .get("origin")
        .is_some_and(|origin| text(origin, "kind") == "human")
    {
        &["prompts"]
    } else {
        &["injected", "Skill text and hook output"]
    };
    let content = line
        .get("message")
        .and_then(|message| message.get("content"));
    match content {
        Some(Value::String(text)) => {
            conversation.add(message_text, chars(text));
        }
        Some(Value::Array(blocks)) => {
            for block in blocks {
                if text(block, "type") != "tool_result" {
                    conversation.add(message_text, block_chars(block));
                    continue;
                }
                let size = result_chars(block.get("content"));
                match calls.get(text(block, "tool_use_id")) {
                    // A call and its result are one use of the tool.
                    Some(call) => call.add(conversation, size).count -= 1,
                    None => {
                        conversation.add(&["injected", "Results of earlier calls"], size);
                    }
                }
            }
        }
        _ => {}
    }
}

fn result_chars(content: Option<&Value>) -> u64 {
    match content {
        Some(Value::String(text)) => chars(text),
        Some(Value::Array(blocks)) => blocks.iter().map(block_chars).sum(),
        _ => 0,
    }
}

fn block_chars(block: &Value) -> u64 {
    match text(block, "type") {
        "text" => chars(text(block, "text")),
        "image" => IMAGE_CHARS,
        _ => json_chars(block),
    }
}

#[cfg(test)]
mod tests;
