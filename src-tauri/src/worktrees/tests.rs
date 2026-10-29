use super::*;

const SHA: &str = "8cdd3d4a1b2c3d4e5f60718293a4b5c6d7e8f901";

#[test]
fn the_main_worktree_is_left_out_and_linked_ones_kept() {
    let text = format!(
        "worktree /r\0HEAD {SHA}\0branch refs/heads/master\0\0\
         worktree /r/.claude/worktrees/venice\0HEAD {SHA}\0branch refs/heads/venice\0\0\
         worktree /r/.claude/worktrees/probe\0HEAD {SHA}\0detached\0\0"
    );
    let entries = parse(&text);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].path, "/r/.claude/worktrees/venice");
    assert_eq!(entries[0].branch.as_deref(), Some("venice"));
    assert_eq!(entries[0].head, SHA);
    assert_eq!(entries[1].branch, None, "a detached HEAD has no branch");
}

#[test]
fn gone_bare_and_unborn_worktrees_are_skipped() {
    let zeros = "0".repeat(40);
    let text = format!(
        "worktree /r\0bare\0\0\
         worktree /gone\0HEAD {SHA}\0branch refs/heads/old\0prunable gitdir file points to non-existent location\0\0\
         worktree /new\0HEAD {zeros}\0branch refs/heads/new\0\0\
         worktree /kept\0HEAD {SHA}\0branch refs/heads/kept\0\0"
    );
    let paths: Vec<_> = parse(&text).into_iter().map(|entry| entry.path).collect();
    assert_eq!(paths, ["/kept"]);
}

#[test]
fn a_checkout_without_linked_worktrees_lists_none() {
    assert!(
        parse(&format!(
            "worktree /r\0HEAD {SHA}\0branch refs/heads/main\0\0"
        ))
        .is_empty()
    );
    assert!(parse("").is_empty());
}

#[test]
fn paths_with_spaces_survive() {
    let text = format!(
        "worktree /r\0HEAD {SHA}\0\0worktree /My Drive/w t\0HEAD {SHA}\0branch refs/heads/a/b\0\0"
    );
    let entries = parse(&text);
    assert_eq!(entries[0].path, "/My Drive/w t");
    assert_eq!(entries[0].branch.as_deref(), Some("a/b"));
}

#[test]
fn a_last_commit_reads_as_its_time_and_subject() {
    assert_eq!(
        parse_commit("1761700000\x1ffeat: venice - canals at dusk"),
        Some((1_761_700_000, "feat: venice - canals at dusk".to_owned()))
    );
    assert_eq!(parse_commit("no separator"), None);
    assert_eq!(parse_commit("soon\x1fsubject"), None);
}
