#![allow(clippy::unwrap_used)]

use super::*;
use std::io::Write;

/// One response line, as Claude Code writes it.
fn response(id: &str, at: &str, output: u64, cache_read: u64, sidechain: bool) -> String {
    format!(
        r#"{{"type":"assistant","isSidechain":{sidechain},"timestamp":"{at}","message":{{"id":"{id}","model":"claude-opus-5-5","usage":{{"input_tokens":2,"output_tokens":{output},"cache_read_input_tokens":{cache_read},"cache_creation_input_tokens":300,"cache_creation":{{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":300}}}}}}}}"#
    ) + "\n"
}

fn append(path: &Path, text: &str) {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
}

/// 2026-10-29 09:33 UTC.
const MINUTE: i64 = 1_793_266_380;
const NOW: i64 = MINUTE + 600;

const ID: &str = "0f2736ab-56ae-454c-ad08-fc76c65f788f";

struct Fixture {
    _dir: tempfile::TempDir,
    projects: PathBuf,
    transcript: PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    std::fs::create_dir_all(projects.join("-other")).unwrap();
    std::fs::create_dir_all(projects.join("-code")).unwrap();
    let transcript = projects.join(format!("-code/{ID}.jsonl"));
    Fixture {
        _dir: dir,
        projects,
        transcript,
    }
}

fn read(cache: &Cache, fixture: &Fixture) -> Option<SessionUsage> {
    cache
        .read(&fixture.projects, &[ID.to_owned()], NOW)
        .pop()
        .unwrap()
}

#[test]
fn reads_utc_timestamps() {
    assert_eq!(unix_seconds("1970-01-01T00:00:00.000Z"), Some(0));
    assert_eq!(unix_seconds("2026-10-29T09:33:17.123Z"), Some(MINUTE + 17));
    assert_eq!(unix_seconds("2024-02-29T12:00:00Z"), Some(1_709_208_000));
    assert_eq!(unix_seconds("not a time"), None);
}

#[test]
fn sums_a_minute_and_takes_the_context_and_model_from_the_last_response() {
    let fixture = fixture();
    append(
        &fixture.transcript,
        r#"{"type":"user","message":{"content":"hi"}}"#,
    );
    append(&fixture.transcript, "\n");
    append(
        &fixture.transcript,
        &response("a", "2026-10-29T09:33:01.000Z", 10, 1000, false),
    );
    append(
        &fixture.transcript,
        &response("b", "2026-10-29T09:33:40.000Z", 20, 2000, false),
    );
    let usage = read(&Cache::default(), &fixture).unwrap();
    assert_eq!(usage.model.as_deref(), Some("claude-opus-5-5"));
    assert_eq!(usage.context, 2 + 2000 + 300);
    assert_eq!(
        usage.minutes,
        vec![Minute {
            at: MINUTE,
            tokens: Tokens {
                input: 4,
                output: 30,
                cache_read: 3000,
                cache_write_5m: 0,
                cache_write_1h: 600
            },
        }]
    );
}

#[test]
fn a_response_written_twice_counts_once_with_its_last_copy() {
    let fixture = fixture();
    append(
        &fixture.transcript,
        &response("a", "2026-10-29T09:33:01.000Z", 5, 1000, false),
    );
    append(
        &fixture.transcript,
        &response("a", "2026-10-29T09:33:02.000Z", 50, 1000, false),
    );
    let usage = read(&Cache::default(), &fixture).unwrap();
    assert_eq!(usage.minutes.len(), 1);
    assert_eq!(usage.minutes[0].tokens.output, 50);
    assert_eq!(usage.minutes[0].tokens.cache_read, 1000);
}

#[test]
fn reads_on_from_where_it_stopped_and_leaves_a_half_written_line() {
    let fixture = fixture();
    let cache = Cache::default();
    append(
        &fixture.transcript,
        &response("a", "2026-10-29T09:33:01.000Z", 10, 0, false),
    );
    let half = response("b", "2026-10-29T09:34:01.000Z", 20, 0, false);
    let (start, rest) = half.split_at(40);
    append(&fixture.transcript, start);
    assert_eq!(read(&cache, &fixture).unwrap().minutes.len(), 1);
    append(&fixture.transcript, rest);
    let usage = read(&cache, &fixture).unwrap();
    assert_eq!(
        usage
            .minutes
            .iter()
            .map(|m| m.tokens.output)
            .collect::<Vec<_>>(),
        vec![10, 20]
    );
}

#[test]
fn subagents_add_to_the_session_but_not_to_its_context() {
    let fixture = fixture();
    append(
        &fixture.transcript,
        &response("a", "2026-10-29T09:33:01.000Z", 10, 1000, false),
    );
    let subagents = fixture.projects.join(format!("-code/{ID}/subagents"));
    std::fs::create_dir_all(&subagents).unwrap();
    append(
        &subagents.join("agent-1.jsonl"),
        &response("s", "2026-10-29T09:33:30.000Z", 7, 90_000, true),
    );
    let usage = read(&Cache::default(), &fixture).unwrap();
    assert_eq!(usage.context, 2 + 1000 + 300);
    assert_eq!(usage.minutes[0].tokens.output, 17);
    assert_eq!(usage.minutes[0].tokens.cache_read, 91_000);
}

#[test]
fn leaves_out_minutes_older_than_the_history() {
    let fixture = fixture();
    append(
        &fixture.transcript,
        &response("old", "2026-10-28T09:33:01.000Z", 10, 0, false),
    );
    append(
        &fixture.transcript,
        &response("new", "2026-10-29T09:33:01.000Z", 20, 0, false),
    );
    let usage = read(&Cache::default(), &fixture).unwrap();
    assert_eq!(
        usage
            .minutes
            .iter()
            .map(|m| m.tokens.output)
            .collect::<Vec<_>>(),
        vec![20]
    );
}

#[test]
fn finds_a_session_in_any_project_and_takes_only_uuids() {
    let fixture = fixture();
    let cache = Cache::default();
    append(
        &fixture.transcript,
        &response("a", "2026-10-29T09:33:01.000Z", 10, 0, false),
    );
    assert!(read(&cache, &fixture).is_some());
    let ids = [
        "../-code/0f2736ab-56ae-454c-ad08-fc76c65f788f",
        "0f2736ab-56ae-454c-ad08-fc76c65f788g",
        "missing",
        "1f2736ab-56ae-454c-ad08-fc76c65f788f",
    ]
    .map(str::to_owned);
    assert_eq!(
        cache.read(&fixture.projects, &ids, NOW),
        vec![None, None, None, None]
    );
}

/// One response line carrying the folder its session ran in.
fn response_in(cwd: &str, id: &str, at: &str, output: u64) -> String {
    format!(
        r#"{{"type":"assistant","cwd":"{cwd}","timestamp":"{at}","message":{{"id":"{id}","usage":{{"output_tokens":{output}}}}}}}"#
    ) + "\n"
}

/// A transcript in its own project folder.
fn project_file(projects: &Path, folder: &str, id: &str, text: &str) -> PathBuf {
    let path = projects.join(folder).join(format!("{id}.jsonl"));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    append(&path, text);
    path
}

const TIME: &str = "2026-10-29T09:33:17.000Z";

fn outputs(usage: &ProjectUsage) -> u64 {
    usage.minutes.iter().map(|minute| minute.tokens.output).sum()
}

#[test]
fn history_sums_a_project_and_folds_its_worktrees() {
    let fixture = fixture();
    let text = response_in("/code/app", "a", TIME, 10);
    project_file(&fixture.projects, "-a", "main", &text);
    let text = response_in("/code/app/.claude/worktrees/x/src", "b", TIME, 5);
    project_file(&fixture.projects, "-b", "tree", &text);
    let text = response_in("/code/other", "c", TIME, 1);
    project_file(&fixture.projects, "-c", "other", &text);

    let history = Cache::default().history(&fixture.projects, NOW);
    let totals: Vec<_> = history.iter().map(|p| (p.name.as_str(), outputs(p))).collect();
    assert_eq!(totals, [("app", 15), ("other", 1)]);
    assert_eq!(history[0].minutes[0].at % BUCKET_SECONDS, 0);
}

#[test]
fn history_counts_a_resumed_sessions_repeats_once() {
    let fixture = fixture();
    let text = response_in("/code/app", "a", TIME, 10);
    project_file(&fixture.projects, "-a", "first", &text);
    project_file(&fixture.projects, "-a", "resumed", &text);

    let history = Cache::default().history(&fixture.projects, NOW);
    assert_eq!(outputs(&history[0]), 10);
}

#[test]
fn history_names_a_session_after_where_it_started() {
    let fixture = fixture();
    let text = response_in("/code/app", "a", TIME, 1) + &response_in("/code/app/src", "b", TIME, 1);
    project_file(&fixture.projects, "-a", "main", &text);

    let history = Cache::default().history(&fixture.projects, NOW);
    assert_eq!(history[0].name, "app");
}

#[test]
fn history_includes_subagents_and_leaves_out_the_old() {
    let fixture = fixture();
    let main = project_file(&fixture.projects, "-a", "main", &response_in("/code/app", "a", TIME, 1));
    let subagents = main.with_extension("").join("subagents");
    std::fs::create_dir_all(&subagents).unwrap();
    append(&subagents.join("agent.jsonl"), &response_in("/code/app", "b", TIME, 2));
    // Before the week, in a file written today.
    let old = response_in("/code/app", "c", "2026-10-01T09:33:17.000Z", 4);
    project_file(&fixture.projects, "-a", "older", &old);
    // Inside the week, in a file last written before it.
    let stale = project_file(&fixture.projects, "-a", "stale", &response_in("/code/app", "d", TIME, 8));
    let long_ago = UNIX_EPOCH + std::time::Duration::from_secs((NOW - WEEK_SECONDS - 60) as u64);
    File::options().write(true).open(&stale).unwrap().set_modified(long_ago).unwrap();

    let history = Cache::default().history(&fixture.projects, NOW);
    assert_eq!(outputs(&history[0]), 3);
}

/// A user line, as Claude Code writes one you typed.
fn human(content: &str) -> String {
    format!(
        r#"{{"parentUuid":null,"isSidechain":false,"type":"user","message":{{"role":"user","content":{content}}},"origin":{{"kind":"human"}},"timestamp":"2026-10-29T09:33:17.123Z"}}"#
    ) + "\n"
}

/// A response line in `cwd`, a subagent's when `sidechain`.
fn moved_response(id: &str, cwd: &str, sidechain: bool) -> String {
    response(id, "2026-10-29T09:33:17.123Z", 1, 1, sidechain).replacen('{', &format!(r#"{{"cwd":"{cwd}","#), 1)
}

#[test]
fn folders_come_latest_first_and_each_once() {
    let fixture = fixture();
    let lines = [("a", "/repo"), ("b", "/repo/.claude/worktrees/x"), ("c", "/tmp/scratch"), ("d", "/repo/.claude/worktrees/x")];
    for (id, cwd) in lines {
        append(&fixture.transcript, &moved_response(id, cwd, false));
    }
    append(&fixture.transcript, &moved_response("e", "/elsewhere", true));
    let usage = read(&Cache::default(), &fixture).unwrap();
    assert_eq!(usage.cwds, ["/repo/.claude/worktrees/x", "/tmp/scratch", "/repo"]);
}

fn latest_prompt(fixture: &Fixture) -> Option<String> {
    read(&Cache::default(), fixture).unwrap().prompt
}

#[test]
fn the_prompt_is_the_last_one_typed_past_a_tool_result() {
    let fixture = fixture();
    append(&fixture.transcript, &human(r#""first""#));
    append(&fixture.transcript, &human(r#""Fix the sidebar contrast""#));
    append(
        &fixture.transcript,
        concat!(
            r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t","type":"tool_result","content":"Exit code 1"}]},"toolUseResult":"Error","sourceToolAssistantUUID":"a"}"#,
            "\n"
        ),
    );
    assert_eq!(latest_prompt(&fixture).as_deref(), Some("Fix the sidebar contrast"));
}

#[test]
fn the_prompt_skips_everything_nobody_typed() {
    let fixture = fixture();
    append(&fixture.transcript, &human(r#""the real one""#));
    for line in [
        // Skill text, an image's note and a hook's reminder.
        r#"{"type":"user","isMeta":true,"message":{"content":"Base directory for this skill: /x"}}"#,
        r#"{"type":"user","isMeta":true,"origin":{"kind":"human"},"message":{"content":"hook output"}}"#,
        // A task finishing in the background.
        r#"{"type":"user","origin":{"kind":"task-notification"},"message":{"content":"<task-notification>"}}"#,
        // A slash command's wrapper and its output, without an origin and with one.
        r#"{"type":"user","message":{"content":"<command-name>/exit</command-name>"}}"#,
        r#"{"type":"user","origin":{"kind":"human"},"message":{"content":"<command-name>/queue</command-name>"}}"#,
        r#"{"type":"user","origin":{"kind":"human"},"message":{"content":"<local-command-stdout>Goodbye!</local-command-stdout>"}}"#,
        r#"{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#,
        r#"{"type":"user","isCompactSummary":true,"message":{"content":"This session is being continued"}}"#,
        // A subagent's prompt, had it landed in the main file.
        r#"{"type":"user","isSidechain":true,"origin":{"kind":"human"},"message":{"content":"a subagent's brief"}}"#,
        // The marker somewhere other than the line's origin.
        r#"{"type":"user","toolUseResult":{"kind":"human"},"message":{"content":"a tool's text"}}"#,
        // An assistant line quoting the marker in its text is escaped, so is no prompt.
        r#"{"type":"assistant","message":{"content":"\"kind\":\"human\""}}"#,
    ] {
        append(&fixture.transcript, &format!("{line}\n"));
    }
    assert_eq!(latest_prompt(&fixture).as_deref(), Some("the real one"));
}

#[test]
fn the_prompt_ignores_a_subagents_file() {
    let fixture = fixture();
    append(&fixture.transcript, &human(r#""main thread""#));
    let subagents = fixture.transcript.with_extension("").join("subagents");
    std::fs::create_dir_all(&subagents).unwrap();
    append(&subagents.join("agent-a.jsonl"), &human(r#""subagent""#));
    assert_eq!(latest_prompt(&fixture).as_deref(), Some("main thread"));
}

#[test]
fn the_prompt_reads_text_blocks_and_unwraps_a_paste() {
    let fixture = fixture();
    append(
        &fixture.transcript,
        &human(r#"[{"type":"text","text":"[Image #1] look"},{"type":"image","source":{}}]"#),
    );
    assert_eq!(latest_prompt(&fixture).as_deref(), Some("[Image #1] look"));
    append(
        &fixture.transcript,
        &human(r#""\n\n<pasted_content id=\"2985\">\nRedesign the toggles\n</pasted_content id=\"2985\">\n""#),
    );
    assert_eq!(latest_prompt(&fixture).as_deref(), Some("Redesign the toggles"));
}

#[test]
fn paste_tags_go_but_the_words_stay() {
    assert_eq!(
        without_paste_tags("the pasted_content rule <pasted_content id=\"1\">x</pasted_content id=\"1\">"),
        "the pasted_content rule x"
    );
}

#[test]
fn a_wall_of_text_is_cut_on_a_character() {
    let fixture = fixture();
    append(&fixture.transcript, &human(&format!("\"{}\"", "é".repeat(5000))));
    let prompt = latest_prompt(&fixture).unwrap();
    assert_eq!(prompt.chars().count(), MAX_PROMPT_CHARS + 1);
    assert!(prompt.ends_with('…'));
}

#[test]
fn the_last_write_counts_a_subagents_file() {
    let fixture = fixture();
    append(&fixture.transcript, &response("a", "2026-10-29T09:33:17.123Z", 1, 0, false));
    let set = |path: &Path, at: i64| {
        let time = UNIX_EPOCH + std::time::Duration::from_secs(at as u64);
        File::options().write(true).open(path).unwrap().set_modified(time).unwrap();
    };
    set(&fixture.transcript, MINUTE);
    let written = |fixture: &Fixture| read(&Cache::default(), fixture).unwrap().written_at;
    assert_eq!(written(&fixture), Some(MINUTE));

    let subagents = fixture.transcript.with_extension("").join("subagents");
    std::fs::create_dir_all(&subagents).unwrap();
    let agent = subagents.join("agent-a.jsonl");
    append(&agent, &response("b", "2026-10-29T09:33:17.123Z", 1, 0, true));
    set(&agent, MINUTE + 300);
    assert_eq!(written(&fixture), Some(MINUTE + 300));
    // An old subagent does not move it back.
    set(&agent, MINUTE - 300);
    assert_eq!(written(&fixture), Some(MINUTE));
}
