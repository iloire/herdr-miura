use super::*;

fn github(path: &str) -> WebRepo {
    WebRepo {
        kind: Forge::Github,
        host: "github.com".into(),
        path: path.into(),
        url: format!("https://github.com/{path}"),
    }
}

#[test]
fn github_remotes_in_every_form() {
    for remote in [
        "git@github.com:iloire/herdr.git",
        "git@github.com:iloire/herdr",
        "ssh://git@github.com/iloire/herdr.git",
        "ssh://git@ssh.github.com:443/iloire/herdr.git",
        "https://github.com/iloire/herdr.git",
        "https://github.com/iloire/herdr",
        "https://github.com/iloire/herdr/",
        "https://user:token@github.com/iloire/herdr.git",
        "git://github.com/iloire/herdr.git",
        "  https://GitHub.com/iloire/herdr.git\n",
    ] {
        assert_eq!(parse_remote(remote), Some(github("iloire/herdr")), "{remote}");
    }
}

#[test]
fn dots_and_dashes_stay_in_names() {
    assert_eq!(
        parse_remote("git@github.com:my-org/site.github.io.git"),
        Some(github("my-org/site.github.io"))
    );
}

#[test]
fn gitlab_keeps_its_groups() {
    let repo = parse_remote("git@gitlab.com:group/sub/project.git").unwrap();
    assert_eq!(repo.kind, Forge::Gitlab);
    assert_eq!(repo.url, "https://gitlab.com/group/sub/project");
    let own = parse_remote("https://gitlab.example.org/team/app").unwrap();
    assert_eq!((own.kind, own.host.as_str()), (Forge::Gitlab, "gitlab.example.org"));
}

#[test]
fn enterprise_github_is_github() {
    let repo = parse_remote("git@github.acme.com:team/app.git").unwrap();
    assert_eq!(repo.kind, Forge::Github);
    assert_eq!(repo.url, "https://github.acme.com/team/app");
}

#[test]
fn other_hosts_and_shapes_are_not_recognised() {
    for remote in [
        "",
        "/srv/git/app.git",
        "./a:b",
        "file:///srv/git/app.git",
        "git@bitbucket.org:team/app.git",
        "https://example.com/team/app.git",
        "git@github.com:onlyowner",
        "https://github.com/a/b/c",
        "https://github.com/../etc",
        "https://github.com/a/.hidden",
        "git@github.com:a/b c",
        "git@evil host:a/b",
    ] {
        assert_eq!(parse_remote(remote), None, "{remote}");
    }
}

#[test]
fn reads_an_open_pr_and_passing_checks() {
    let json = r#"{"data":{"repository":{
        "pullRequests":{"nodes":[{"number":42,"url":"https://github.com/iloire/herdr/pull/42","isDraft":true,"reviewDecision":"CHANGES_REQUESTED"}]},
        "object":{"statusCheckRollup":{"state":"SUCCESS"}}}}}"#;
    assert_eq!(
        parse_status(json, &github("iloire/herdr")),
        Some(ForgeStatus {
            pr: Some(PullRequest {
                number: 42,
                url: "https://github.com/iloire/herdr/pull/42".into(),
                draft: true,
                review: Some(Decision::ChangesRequested),
            }),
            checks: Some(Checks::Pass),
        })
    );
}

#[test]
fn check_states_map_to_three() {
    let with = |state: &str| {
        let json = format!(
            r#"{{"data":{{"repository":{{"pullRequests":{{"nodes":[]}},"object":{{"statusCheckRollup":{{"state":"{state}"}}}}}}}}}}"#
        );
        parse_status(&json, &github("a/b")).unwrap().checks
    };
    assert_eq!(with("FAILURE"), Some(Checks::Fail));
    assert_eq!(with("ERROR"), Some(Checks::Fail));
    assert_eq!(with("PENDING"), Some(Checks::Running));
    assert_eq!(with("EXPECTED"), Some(Checks::Running));
    assert_eq!(with("SOMETHING_NEW"), None);
}

#[test]
fn no_pr_no_checks_and_an_unknown_commit() {
    let json = r#"{"data":{"repository":{"pullRequests":{"nodes":[]},"object":null}}}"#;
    assert_eq!(
        parse_status(json, &github("a/b")),
        Some(ForgeStatus { pr: None, checks: None })
    );
    let json = r#"{"data":{"repository":{"pullRequests":{"nodes":[]},"object":{"statusCheckRollup":null}}}}"#;
    assert_eq!(parse_status(json, &github("a/b")).unwrap().checks, None);
}

#[test]
fn a_pr_elsewhere_is_dropped() {
    let json = r#"{"data":{"repository":{"pullRequests":{"nodes":[{"number":1,"url":"https://evil.example/pull/1","isDraft":false,"reviewDecision":null}]},"object":null}}}"#;
    assert_eq!(parse_status(json, &github("a/b")).unwrap().pr, None);
}

#[test]
fn errors_and_garbage_say_nothing() {
    assert_eq!(parse_status("", &github("a/b")), None);
    assert_eq!(parse_status("not json", &github("a/b")), None);
    let json = r#"{"data":{"repository":null},"errors":[{"message":"Could not resolve to a Repository"}]}"#;
    assert_eq!(parse_status(json, &github("a/b")), None);
}
