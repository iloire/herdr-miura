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

/// Git in `dir` running `script` as a shell alias, under `deadline`.
fn alias(dir: &tempfile::TempDir, script: &str, deadline: Instant) -> Result<Finished, Error> {
    let alias = format!("alias.probe=!{script}");
    supervised(
        &dir.path().to_string_lossy(),
        &["-c", &alias, "probe"],
        "probe",
        deadline,
    )
}

#[test]
fn supervised_returns_a_failure_with_both_streams() {
    let dir = tempfile::tempdir().unwrap();
    let done = alias(&dir, "echo out; echo first >&2; echo second >&2; exit 3", soon()).unwrap();
    assert!(!done.success);
    assert_eq!(done.stdout, "out");
    assert_eq!(done.stderr, "first\nsecond");
}

#[test]
fn supervised_keeps_the_end_of_a_long_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let script = "yes 'hook noise' | head -c 300000 >&2; echo 'the reason' >&2; exit 1";
    let done = alias(&dir, script, soon()).unwrap();
    assert!(done.stderr.ends_with("the reason"), "{}", &done.stderr[..40]);
    assert!(done.stderr.len() <= TAIL_OUTPUT);
    assert!(done.stderr.starts_with("hook noise"), "cut line kept");
}

#[test]
fn supervised_messages_are_in_english_whatever_the_locale() {
    let dir = tempfile::tempdir().unwrap();
    let done = alias(&dir, "echo $LC_ALL", soon()).unwrap();
    assert_eq!(done.stdout, "C");
}

#[test]
fn an_overrun_stops_everything_git_started_and_returns_on_time() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("survived");
    // The grandchild would write the marker if it outlived the deadline.
    let script = format!("(sleep 2; touch '{}') & wait", marker.display());
    let start = Instant::now();
    let error = alias(&dir, &script, start + Duration::from_millis(300)).unwrap_err();
    assert!(matches!(error, Error::Timeout { .. }), "{error:?}");
    assert!(start.elapsed() < Duration::from_millis(1500), "{:?}", start.elapsed());
    thread::sleep(Duration::from_millis(2300));
    assert!(!marker.exists(), "a child of Git outlived it");
}

#[test]
fn a_stopped_git_gets_to_clean_up_first() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("cleaned");
    let script = format!("trap \"touch '{}'; exit 1\" TERM; sleep 30 & wait", marker.display());
    alias(&dir, &script, Instant::now() + Duration::from_millis(300)).unwrap_err();
    assert!(marker.exists(), "SIGKILL went first");
}

#[test]
fn a_background_job_holding_the_pipes_does_not_block_a_finished_git() {
    let dir = tempfile::tempdir().unwrap();
    let start = Instant::now();
    let done = alias(&dir, "echo said; sleep 5 & exit 0", soon()).unwrap();
    assert!(done.success);
    assert_eq!(done.stdout, "said");
    assert!(start.elapsed() < Duration::from_secs(2), "{:?}", start.elapsed());
}

#[test]
fn shell_keeps_the_script_output_and_its_failure() {
    let dir = tempfile::tempdir().unwrap();
    let far = Instant::now() + Duration::from_secs(30);
    let done = shell(dir.path().to_str().unwrap(), "echo out; echo err >&2; exit 3", "test", far).unwrap();
    assert!(!done.success);
    assert_eq!(done.stdout, "out");
    assert_eq!(done.stderr, "err");
}

#[test]
fn the_logout_a_login_shell_adds_is_dropped() {
    assert_eq!(without_logout("err\nlogout".to_owned()), "err");
    assert_eq!(without_logout("logout".to_owned()), "");
    assert_eq!(without_logout("blogout".to_owned()), "blogout");
    assert_eq!(without_logout("logout failed\n".to_owned()), "logout failed\n");
}

#[test]
fn what_startup_files_print_is_dropped() {
    let printed = format!("welcome banner\n{STARTED}\nthe reason\n");
    assert_eq!(after_start(printed), "the reason");
    assert_eq!(after_start("no marker".to_owned()), "no marker");
}
