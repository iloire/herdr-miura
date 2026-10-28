use super::*;

fn soon() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

#[test]
fn prints_what_git_prints() {
    let dir = tempfile::tempdir().unwrap();
    let version = text(
        &dir.path().to_string_lossy(),
        &["--version"],
        "report its version",
        soon(),
    )
    .unwrap();
    assert!(version.starts_with("git version"), "{version}");
}

#[test]
fn a_failure_carries_gits_message() {
    let dir = tempfile::tempdir().unwrap();
    let error = text(
        &dir.path().to_string_lossy(),
        &["rev-parse", "HEAD"],
        "find HEAD",
        soon(),
    )
    .unwrap_err();
    let Error::Failed { operation, details } = error else {
        panic!("{error:?}");
    };
    assert_eq!(operation, "find HEAD");
    assert!(details.contains("not a git repository"), "{details}");
}

#[test]
fn output_past_the_limit_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let error = run(
        &dir.path().to_string_lossy(),
        &["--version"],
        "report its version",
        soon(),
        4,
    )
    .unwrap_err();
    assert!(
        matches!(error, Error::TooLarge { limit: 4, .. }),
        "{error:?}"
    );
}

#[test]
fn a_passed_deadline_stops_git() {
    let dir = tempfile::tempdir().unwrap();
    let error = run(
        &dir.path().to_string_lossy(),
        &["--version"],
        "report its version",
        Instant::now(),
        OUTPUT,
    );
    // Git may finish before the first poll; if not, it is killed.
    assert!(
        matches!(error, Ok(_) | Err(Error::Timeout { .. })),
        "{error:?}"
    );
}
