#![allow(clippy::unwrap_used)]

use super::*;

const ID: &str = "0f2736ab-56ae-454c-ad08-fc76c65f788f";
const OTHER: &str = "1f2736ab-56ae-454c-ad08-fc76c65f788f";

struct Fixture {
    dir: tempfile::TempDir,
    projects: PathBuf,
    sessions: PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path().join("projects");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(projects.join("-code")).unwrap();
    std::fs::create_dir_all(&sessions).unwrap();
    Fixture { dir, projects, sessions }
}

impl Fixture {
    /// A folder that exists, as a string.
    fn folder(&self, name: &str) -> String {
        let folder = self.dir.path().join(name);
        std::fs::create_dir_all(&folder).unwrap();
        folder.to_str().unwrap().to_owned()
    }

    fn write(&self, id: &str, lines: &[String]) -> PathBuf {
        let path = self.projects.join(format!("-code/{id}.jsonl"));
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        path
    }

    fn list(&self, cache: &Cache, folder: &str) -> Vec<RecentSession> {
        cache.list(&self.projects, &self.sessions, &[folder.to_owned()])
    }
}

/// A user line, as Claude Code writes the first prompt.
fn user(content: &str, cwd: &str) -> String {
    let content = serde_json::to_string(content).unwrap();
    format!(
        r#"{{"parentUuid":null,"type":"user","message":{{"role":"user","content":{content}}},"origin":{{"kind":"human"}},"entrypoint":"cli","cwd":"{cwd}","gitBranch":"main"}}"#
    )
}

fn title(text: &str) -> String {
    format!(r#"{{"type":"ai-title","aiTitle":"{text}","sessionId":"{ID}"}}"#)
}

fn last_prompt(text: &str) -> String {
    format!(r#"{{"type":"last-prompt","lastPrompt":"{text}","leafUuid":"x","sessionId":"{ID}"}}"#)
}

#[test]
fn a_row_has_the_title_last_prompt_branch_and_folder() {
    let f = fixture();
    let code = f.folder("code");
    f.write(ID, &[user("fix it", &code), title("Fix it"), last_prompt("and the tests")]);
    let rows = f.list(&Cache::default(), &code);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, ID);
    assert_eq!(rows[0].title.as_deref(), Some("Fix it"));
    assert_eq!(rows[0].prompt, "and the tests");
    assert_eq!(rows[0].branch.as_deref(), Some("main"));
    assert_eq!(rows[0].folder, code);
    assert_eq!(rows[0].opens_in.as_deref(), Some(code.as_str()));
    assert!(!rows[0].queue && !rows[0].running);
}

#[test]
fn a_session_without_a_title_still_gets_a_row() {
    let f = fixture();
    let code = f.folder("code");
    f.write(ID, &[user("fix it", &code), last_prompt("fix it")]);
    assert_eq!(f.list(&Cache::default(), &code)[0].title, None);
}

#[test]
fn its_own_name_beats_claudes_title() {
    let f = fixture();
    let code = f.folder("code");
    let custom = format!(r#"{{"type":"custom-title","customTitle":"Mine","sessionId":"{ID}"}}"#);
    f.write(ID, &[user("fix it", &code), custom, title("Theirs"), last_prompt("fix it")]);
    assert_eq!(f.list(&Cache::default(), &code)[0].title.as_deref(), Some("Mine"));
}

#[test]
fn only_this_folder_its_subfolders_and_worktrees_count() {
    let f = fixture();
    let code = f.folder("code");
    let worktree = f.folder("code/.claude/worktrees/x");
    let sibling = f.folder("code-two");
    f.write(ID, &[user("a", &worktree), last_prompt("a")]);
    f.write(OTHER, &[user("b", &sibling), last_prompt("b")]);
    let rows = f.list(&Cache::default(), &code);
    assert_eq!(rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), [ID]);
}

#[test]
fn the_newest_comes_first() {
    let f = fixture();
    let code = f.folder("code");
    let old = f.write(ID, &[user("a", &code), last_prompt("a")]);
    f.write(OTHER, &[user("b", &code), last_prompt("b")]);
    let week_ago = SystemTime::now() - std::time::Duration::from_secs(7 * 86_400);
    File::options().write(true).open(&old).unwrap().set_modified(week_ago).unwrap();
    let rows = f.list(&Cache::default(), &code);
    assert_eq!(rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), [OTHER, ID]);
}

#[test]
fn a_session_nobody_spoke_in_has_no_row() {
    let f = fixture();
    let code = f.folder("code");
    // What `/clear` alone leaves: a last-prompt line with no prompt in it.
    let cleared = format!(r#"{{"type":"last-prompt","leafUuid":"x","sessionId":"{ID}"}}"#);
    f.write(ID, &[format!(r#"{{"type":"system","cwd":"{code}","entrypoint":"cli"}}"#), cleared]);
    assert!(f.list(&Cache::default(), &code).is_empty());
}

#[test]
fn a_headless_run_has_no_row() {
    let f = fixture();
    let code = f.folder("code");
    let line = format!(r#"{{"type":"user","entrypoint":"sdk-cli","cwd":"{code}"}}"#);
    f.write(ID, &[line, last_prompt("generate a thing")]);
    assert!(f.list(&Cache::default(), &code).is_empty());
}

#[test]
fn a_session_that_went_on_under_another_id_has_no_row() {
    let f = fixture();
    let code = f.folder("code");
    let moved = format!(r#"{{"type":"continued-in","sessionId":"{ID}","continuedInSessionId":"{OTHER}"}}"#);
    f.write(ID, &[user("a", &code), last_prompt("a"), moved]);
    assert!(f.list(&Cache::default(), &code).is_empty());
}

#[test]
fn lines_it_does_not_know_are_passed_over() {
    let f = fixture();
    let code = f.folder("code");
    let lines = [
        "not json at all".to_owned(),
        r#"{"type":"from-the-future","aiTitle":7,"cwd":[]}"#.to_owned(),
        "[1,2,3]".to_owned(),
        r#"{"type":"last-prompt","lastPrompt":{"nested":true}}"#.to_owned(),
        user("a", &code),
        last_prompt("a"),
        r#"{"type":"half a line"#.to_owned(),
    ];
    f.write(ID, &lines);
    assert_eq!(f.list(&Cache::default(), &code)[0].prompt, "a");
}

#[test]
fn only_the_ends_of_a_large_file_are_read() {
    let f = fixture();
    let code = f.folder("code");
    // A title in the middle, past the tail's reach, is not looked for, and a
    // long line the tail starts inside of is dropped rather than misread.
    let filler = format!(r#"{{"type":"assistant","text":"{}"}}"#, "x".repeat(TAIL as usize * 2));
    f.write(ID, &[user("a", &code), title("Too far back"), filler, user("b", &code), last_prompt("b")]);
    let rows = f.list(&Cache::default(), &code);
    assert_eq!((rows[0].title.as_deref(), rows[0].prompt.as_str()), (None, "b"));
}

#[test]
fn a_tail_that_names_no_folder_takes_it_from_the_start() {
    let f = fixture();
    let code = f.folder("code");
    let filler = format!(r#"{{"type":"assistant","text":"{}"}}"#, "x".repeat(TAIL as usize * 2));
    f.write(ID, &[user("a", &code), filler, last_prompt("b")]);
    let rows = f.list(&Cache::default(), &code);
    assert_eq!(rows[0].branch.as_deref(), Some("main"));
    assert_eq!(rows[0].folder, code);
}

#[test]
fn a_transcript_is_read_again_only_when_it_changes() {
    let f = fixture();
    let code = f.folder("code");
    let path = f.write(ID, &[user("a", &code), last_prompt("first")]);
    let cache = Cache::default();
    assert_eq!(f.list(&cache, &code)[0].prompt, "first");
    let stamp_before = stamp(&path).unwrap();

    // Same size and time: what was read stands.
    let same_size = std::fs::read_to_string(&path).unwrap().replace("first", "other");
    std::fs::write(&path, same_size).unwrap();
    File::options().write(true).open(&path).unwrap().set_modified(stamp_before.1).unwrap();
    assert_eq!(f.list(&cache, &code)[0].prompt, "first");

    f.write(ID, &[user("a", &code), last_prompt("a later prompt")]);
    assert_eq!(f.list(&cache, &code)[0].prompt, "a later prompt");
}

#[test]
fn a_copied_project_lists_a_session_once() {
    let f = fixture();
    let code = f.folder("code");
    let lines = [user("a", &code), last_prompt("a")];
    f.write(ID, &lines);
    std::fs::create_dir_all(f.projects.join("-copy")).unwrap();
    std::fs::copy(f.projects.join(format!("-code/{ID}.jsonl")), f.projects.join(format!("-copy/{ID}.jsonl"))).unwrap();
    assert_eq!(f.list(&Cache::default(), &code).len(), 1);
}

#[test]
fn a_file_that_is_not_a_session_is_ignored() {
    let f = fixture();
    let code = f.folder("code");
    f.write("agent-abc", &[user("a", &code), last_prompt("a")]);
    f.write("../escape", &[user("a", &code), last_prompt("a")]);
    assert!(f.list(&Cache::default(), &code).is_empty());
}

#[test]
fn a_queued_prompt_is_told_by_its_first_message_being_a_paste() {
    let f = fixture();
    let code = f.folder("code");
    let queued = "\n\n<pasted_content id=\"c028\">\nAdd a list\n</pasted_content id=\"c028\">\n";
    f.write(ID, &[user(queued, &code), last_prompt("Add a list")]);
    f.write(OTHER, &[user("look at <pasted_content id=\"a\">this</pasted_content>", &code), last_prompt("x")]);
    let rows = f.list(&Cache::default(), &code);
    let queue = |id: &str| rows.iter().find(|row| row.id == id).unwrap().queue;
    assert!(queue(ID));
    assert!(!queue(OTHER));
}

#[test]
fn a_first_message_of_text_blocks_can_be_a_paste_too() {
    let line = r#"{"type":"user","message":{"content":[{"type":"text","text":"\n\n<pasted_content id=\"a\">"#;
    assert!(queue_run(line.as_bytes()), "cut off by the head's end");
    assert!(!queue_run(br#"{"type":"mode"}"#));
}

#[test]
fn a_last_prompt_loses_paste_tags_and_line_breaks() {
    assert_eq!(one_line("<pasted_content id=\"a\">\nfix\n\tit\u{1b}\n</pasted_content id=\"a\">", 100), "fix it");
    assert_eq!(one_line("abcdefgh", 3), "abc…");
}

#[test]
fn a_gone_folder_says_where_it_can_open_instead() {
    let f = fixture();
    let code = f.folder("code");
    assert_eq!(opens_in(&code).as_deref(), Some(code.as_str()));
    assert_eq!(opens_in(&format!("{code}/.claude/worktrees/gone")).as_deref(), Some(code.as_str()));
    assert_eq!(opens_in(&format!("{code}/.claude/worktrees/gone/deep")).as_deref(), Some(code.as_str()));
    assert_eq!(opens_in(&format!("{code}-gone")), None);
    assert_eq!(opens_in(&format!("{code}-gone/.claude/worktrees/x")), None);
}

fn live(session: &str, pid: u32, start: Option<&str>) -> Live {
    Live {
        pid,
        session_id: session.to_owned(),
        proc_start: start.map(str::to_owned),
        pid_domain: Some("darwin".to_owned()),
    }
}

#[test]
fn a_session_runs_while_its_process_does() {
    let ps = "  37090 Mon Nov  2 12:16:35 2026\n";
    let running = running_from(vec![live(ID, 37090, Some("Mon Nov  2 12:16:35 2026")), live(OTHER, 2, None)], Some(ps));
    assert_eq!(running, HashSet::from([ID.to_owned()]));
}

#[test]
fn a_crashed_sessions_pid_used_by_another_program_does_not_count() {
    let ps = "  2977 Tue Nov  3 08:00:01 2026\n";
    assert!(running_from(vec![live(ID, 2977, Some("Thu Oct 29 17:01:20 2026"))], Some(ps)).is_empty());
}

#[test]
fn a_start_time_in_another_format_is_not_compared() {
    let mut file = live(ID, 2977, Some("1793293283"));
    file.pid_domain = Some("linux".to_owned());
    assert!(running_from(vec![file], Some("2977 Tue Nov  3 08:00:01 2026\n")).contains(ID));
}

#[test]
fn without_ps_every_file_counts() {
    assert!(running_from(vec![live(ID, 1, None)], None).contains(ID));
}

#[test]
fn this_process_shows_as_running_and_key_files_are_left_unopened() {
    let f = fixture();
    let code = f.folder("code");
    f.write(ID, &[user("a", &code), last_prompt("a")]);
    let pid = std::process::id();
    // No `procStart`: only the pid is compared.
    std::fs::write(f.sessions.join(format!("{pid}.json")), format!(r#"{{"pid":{pid},"sessionId":"{ID}"}}"#)).unwrap();
    std::fs::write(f.sessions.join(format!("{pid}.abc.key")), [0xff, 0xfe]).unwrap();
    std::fs::write(f.sessions.join("broken.json"), "{ half").unwrap();
    let cache = Cache::default();
    assert!(f.list(&cache, &code)[0].running);
    assert!(matches!(cache.target(&f.projects, &f.sessions, ID), Err(Error::Running)));
}

#[test]
fn resuming_takes_the_folder_from_the_transcript() {
    let f = fixture();
    let code = f.folder("code");
    f.write(ID, &[user("a", &code), title("Fix it"), last_prompt("a")]);
    let target = Cache::default().target(&f.projects, &f.sessions, ID).unwrap();
    assert_eq!(target, Target { folder: code, label: "Fix it".to_owned() });
}

#[test]
fn resuming_refuses_what_it_cannot_open() {
    let f = fixture();
    let code = f.folder("code");
    let cache = Cache::default();
    for bad in ["../../etc/passwd", "--help", ""] {
        assert!(matches!(cache.target(&f.projects, &f.sessions, bad), Err(Error::Unknown(_))), "{bad:?}");
    }
    assert!(matches!(cache.target(&f.projects, &f.sessions, ID), Err(Error::Unknown(_))));
    f.write(ID, &[user("a", &format!("{code}-gone")), last_prompt("a")]);
    assert!(matches!(cache.target(&f.projects, &f.sessions, ID), Err(Error::FolderGone(_))));
}

/// An assistant line with one text block and its usage.
fn answer(text: &str) -> String {
    let text = serde_json::to_string(text).unwrap();
    format!(
        r#"{{"type":"assistant","message":{{"model":"claude-opus-5-5","content":[{{"type":"thinking","thinking":"hidden"}},{{"type":"text","text":{text}}}],"usage":{{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30}}}}}}"#
    )
}

#[test]
fn a_preview_shows_the_conversation_with_its_model_and_context() {
    let f = fixture();
    f.write(ID, &[user("first question", "/code"), answer("first answer")]);
    let found = preview(&f.projects, ID).unwrap();
    let words: Vec<(bool, &str)> = found.messages.iter().map(|m| (m.from_user, m.text.as_str())).collect();
    assert_eq!(words, [(true, "first question"), (false, "first answer")]);
    assert_eq!(found.model.as_deref(), Some("claude-opus-5-5"));
    assert_eq!(found.context_tokens, Some(60));
}

#[test]
fn a_preview_leaves_out_what_no_person_typed_or_read() {
    let f = fixture();
    let tool = r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"secret output"}]}}"#;
    let meta = r#"{"type":"user","isMeta":true,"message":{"content":"caveat"}}"#;
    let side = r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"subagent"}]}}"#;
    let summary = r#"{"type":"user","isCompactSummary":true,"message":{"content":"long summary"}}"#;
    let lines = [tool.to_owned(), meta.to_owned(), side.to_owned(), summary.to_owned(), user("<command-name>/clear</command-name>", "/code"), user("kept", "/code"), "not json".to_owned()];
    f.write(ID, &lines);
    let found = preview(&f.projects, ID).unwrap();
    assert_eq!(found.messages, [Message { from_user: true, text: "kept".to_owned() }]);
}

#[test]
fn a_preview_takes_the_paste_tags_off_and_keeps_the_latest_messages() {
    let f = fixture();
    let mut lines = vec![user("<pasted_content id=\"a\">queued</pasted_content>", "/code")];
    assert_eq!(without_paste_tags("<pasted_content id=\"a\">queued</pasted_content>"), "queued");
    lines.extend((0..20).map(|n| user(&format!("message {n}"), "/code")));
    f.write(ID, &lines);
    let found = preview(&f.projects, ID).unwrap();
    assert_eq!(found.messages.len(), PREVIEW_MESSAGES);
    assert_eq!(found.messages[0].text, "message 8");
    assert_eq!(found.messages.last().unwrap().text, "message 19");
}

#[test]
fn a_preview_cuts_a_long_message_and_a_torn_first_line_does_no_harm() {
    let f = fixture();
    let filler = "x".repeat(PREVIEW_TAIL as usize + 10);
    f.write(ID, &[user(&filler, "/code"), user(&"y".repeat(MAX_PREVIEW_CHARS + 5), "/code")]);
    let found = preview(&f.projects, ID).unwrap();
    assert_eq!(found.messages.len(), 1);
    assert_eq!(found.messages[0].text.chars().count(), MAX_PREVIEW_CHARS + 1);
    assert!(found.messages[0].text.ends_with('…'));
}

#[test]
fn a_preview_refuses_an_id_that_is_not_a_uuid_and_one_it_cannot_find() {
    let f = fixture();
    assert!(matches!(preview(&f.projects, "../../etc/passwd"), Err(Error::Unknown(_))));
    assert!(matches!(preview(&f.projects, OTHER), Err(Error::Unknown(_))));
}
