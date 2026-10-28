use super::*;

const STATUS: &str = concat!(
    "# branch.oid 1234567890abcdef\0",
    "# branch.head main\0",
    "# branch.upstream origin/main\0",
    "# branch.ab +2 -1\0",
    "1 .M N... 100644 100644 100644 aaaa bbbb src/a file.rs\0",
    "1 A. N... 000000 100644 100644 0000 cccc new.rs\0",
    "1 .D N... 100644 100644 000000 dddd dddd gone.rs\0",
    "2 R. N... 100644 100644 100644 eeee eeee R100 renamed.rs\0old.rs\0",
    "u UU N... 100644 100644 100644 100644 ffff gggg hhhh both.rs\0",
    "? untracked.txt\0",
);

#[test]
fn reads_branch_headers() {
    let status = status(STATUS);
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(status.upstream.as_deref(), Some("origin/main"));
    assert_eq!((status.ahead, status.behind), (2, 1));
    assert!(status.born);
}

#[test]
fn reads_every_kind_of_entry() {
    let files: Vec<_> = status(STATUS)
        .files
        .into_iter()
        .map(|f| (f.path, f.kind))
        .collect();
    assert_eq!(
        files,
        [
            ("src/a file.rs".to_owned(), Kind::Modified),
            ("new.rs".to_owned(), Kind::Added),
            ("gone.rs".to_owned(), Kind::Deleted),
            ("renamed.rs".to_owned(), Kind::Renamed),
            ("both.rs".to_owned(), Kind::Conflicted),
            ("untracked.txt".to_owned(), Kind::Untracked),
        ]
    );
}

#[test]
fn an_unborn_or_detached_head_has_no_branch_or_commit() {
    let unborn = status("# branch.oid (initial)\0# branch.head main\0");
    assert!(!unborn.born);
    let detached = status("# branch.oid abc\0# branch.head (detached)\0");
    assert_eq!(detached.branch, None);
}

#[test]
fn numstat_counts_land_on_their_files_and_renames() {
    let mut files = status(STATUS).files;
    apply_numstat(
        &mut files,
        "3\t1\tsrc/a file.rs\0-\t-\tnew.rs\0\
         0\t0\t\0old.rs\0renamed.rs\0",
    );
    let counts: Vec<_> = files
        .iter()
        .map(|f| (f.path.as_str(), f.additions, f.deletions))
        .collect();
    assert_eq!(counts[0], ("src/a file.rs", Some(3), Some(1)));
    assert_eq!(counts[1], ("new.rs", None, None), "binary keeps no counts");
    assert_eq!(counts[3], ("renamed.rs", Some(0), Some(0)));
}

#[test]
fn log_splits_records_and_fields() {
    let commits =
        log("aaa\x1f100\x1fAda\x1ffirst\0\nbbb\x1f200\x1fBo\x1fsecond: with \x1f in it\0");
    assert_eq!(commits.len(), 2);
    assert_eq!(
        commits[0],
        Commit {
            sha: "aaa".into(),
            time: 100,
            author: "Ada".into(),
            subject: "first".into()
        }
    );
    assert_eq!(commits[1].subject, "second: with \x1f in it");
}

#[test]
fn porcelain_count_skips_a_renames_old_path() {
    assert_eq!(count_porcelain(" M a\0R  new\0old\0?? b\0"), 3);
    assert_eq!(count_porcelain(""), 0);
}

#[test]
fn name_status_reads_every_kind_and_the_new_path_of_a_rename() {
    let files = name_status(
        "M\0src/a file.rs\0A\0new.rs\0D\0gone.rs\0R087\0old.rs\0moved.rs\0C100\0src.rs\0copy.rs\0",
    );
    let marks: Vec<_> = files.iter().map(|f| (f.path.as_str(), f.kind)).collect();
    assert_eq!(
        marks,
        vec![
            ("src/a file.rs", Kind::Modified),
            ("new.rs", Kind::Added),
            ("gone.rs", Kind::Deleted),
            ("moved.rs", Kind::Renamed),
            ("copy.rs", Kind::Added),
        ]
    );
}
