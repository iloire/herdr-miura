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
