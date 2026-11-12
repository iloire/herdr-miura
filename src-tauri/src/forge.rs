//! Where a checkout lives on the web, and what GitHub says about its branch.
//!
//! [`parse_remote`] turns `origin`'s URL into the repository's web address, for
//! the Changes panel's links; reading the URL is local, so `changes.rs` does it.
//! [`status`] asks GitHub, through the `gh` CLI, for the branch's open pull
//! request and the check state of HEAD. That contacts a remote, so it lives
//! here, off the panel's reads, and answers `None` whenever it cannot say:
//! no `gh`, not logged in, no network, not GitHub. It only reads.

use crate::{changes, git, herdr::Target, process};
use serde::Serialize;
use serde_json::Value;
use std::{
    process::Stdio,
    time::{Duration, Instant},
};

/// How long `gh` may take before it is stopped.
const LIMIT: Duration = Duration::from_secs(10);
/// What `gh` may print; the answer is a few hundred bytes.
const OUTPUT: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Forge {
    Github,
    Gitlab,
}

/// A repository's home on the web.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WebRepo {
    pub kind: Forge,
    pub host: String,
    /// `owner/repo`, or a GitLab project's whole group path.
    pub path: String,
    /// `https://<host>/<path>`.
    pub url: String,
}

/// The web home of a remote URL in any form Git takes: `https://`, `ssh://`,
/// `git://` or scp-like `git@host:owner/repo`, with or without `.git`. `None`
/// for a local path or a host that is neither GitHub nor GitLab.
pub fn parse_remote(remote: &str) -> Option<WebRepo> {
    let remote = remote.trim();
    let (authority, path) = match remote.split_once("://") {
        Some((scheme, rest)) => {
            if !matches!(scheme, "https" | "http" | "ssh" | "git" | "git+ssh" | "ssh+git") {
                return None;
            }
            let (authority, path) = rest.split_once('/')?;
            // Credentials before the host, a port after it: `user:token@host:22`.
            let host = authority.rsplit('@').next()?;
            (host.split(':').next()?, path)
        }
        None => {
            let (authority, path) = remote.split_once(':')?;
            // `./a:b` or `/srv/a:b` is a local path.
            if authority.contains('/') {
                return None;
            }
            (authority, path)
        }
    };
    let host = authority.rsplit('@').next()?.to_ascii_lowercase();
    let host = match host.as_str() {
        "ssh.github.com" => "github.com".to_owned(),
        "altssh.gitlab.com" => "gitlab.com".to_owned(),
        _ => host,
    };
    if host.is_empty() || !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return None;
    }
    let kind = if host == "github.com" || host.starts_with("github.") {
        Forge::Github
    } else if host == "gitlab.com" || host.starts_with("gitlab.") {
        Forge::Gitlab
    } else {
        return None;
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let parts: Vec<&str> = path.split('/').collect();
    let named = |part: &&str| {
        !part.is_empty()
            && !part.starts_with('.')
            && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    let shaped = match kind {
        Forge::Github => parts.len() == 2,
        Forge::Gitlab => parts.len() >= 2,
    };
    if !shaped || !parts.iter().all(named) {
        return None;
    }
    Some(WebRepo {
        kind,
        url: format!("https://{host}/{path}"),
        host,
        path: path.to_owned(),
    })
}

/// What GitHub says about a branch.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct ForgeStatus {
    /// The branch's open pull request, if it has one.
    pub pr: Option<PullRequest>,
    /// The combined state of HEAD's checks and statuses; `None` when GitHub
    /// has none for it, or does not have the commit.
    pub checks: Option<Checks>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct PullRequest {
    pub number: u64,
    pub url: String,
    pub draft: bool,
    pub review: Option<Decision>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Approved,
    ChangesRequested,
    ReviewRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Checks {
    Pass,
    Fail,
    Running,
}

/// One GraphQL call for both, so a refresh costs one request.
const QUERY: &str = "query($owner: String!, $name: String!, $branch: String!, $sha: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, states: OPEN, first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number url isDraft reviewDecision }
    }
    object(oid: $sha) { ... on Commit { statusCheckRollup { state } } }
  }
}";

/// The open pull request of `branch` in `origin`'s GitHub repository and the
/// checks of `sha`, through `gh`. `None` when anything stands in the way.
pub fn status(checkout: &str, branch: &str, sha: &str) -> Option<ForgeStatus> {
    if branch.is_empty() || branch.chars().any(char::is_control) || changes::commit_name(sha).is_err() {
        return None;
    }
    let deadline = Instant::now() + LIMIT;
    let repo = changes::origin_repo(&Target::Local, checkout, deadline)?;
    if repo.kind != Forge::Github {
        return None;
    }
    let (owner, name) = repo.path.split_once('/')?;
    let mut command = process::command(process::find("gh")?);
    command
        .args(["api", "graphql", "--hostname", &repo.host])
        .arg("-f")
        .arg(format!("query={QUERY}"))
        .args(["-f", &format!("owner={owner}"), "-f", &format!("name={name}")])
        .args(["-f", &format!("branch={branch}"), "-f", &format!("sha={sha}")])
        .current_dir(checkout)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let done = git::capture(command, deadline, OUTPUT).ok()??;
    if !done.status.success() || done.stdout.len() > OUTPUT {
        return None;
    }
    parse_status(&String::from_utf8_lossy(&done.stdout), &repo)
}

/// The answer to [`QUERY`]. A pull request whose URL is not on `repo` is
/// dropped, since the panel opens it.
pub fn parse_status(json: &str, repo: &WebRepo) -> Option<ForgeStatus> {
    let answer: Value = serde_json::from_str(json).ok()?;
    let repository = answer.pointer("/data/repository").filter(|value| !value.is_null())?;
    let prefix = format!("{}/pull/", repo.url);
    let pr = repository.pointer("/pullRequests/nodes/0").and_then(|node| {
        let url = node.get("url")?.as_str()?;
        if !url.starts_with(&prefix) {
            return None;
        }
        Some(PullRequest {
            number: node.get("number")?.as_u64()?,
            url: url.to_owned(),
            draft: node.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
            review: match node.get("reviewDecision").and_then(Value::as_str) {
                Some("APPROVED") => Some(Decision::Approved),
                Some("CHANGES_REQUESTED") => Some(Decision::ChangesRequested),
                Some("REVIEW_REQUIRED") => Some(Decision::ReviewRequired),
                _ => None,
            },
        })
    });
    let checks = match repository
        .pointer("/object/statusCheckRollup/state")
        .and_then(Value::as_str)
    {
        Some("SUCCESS") => Some(Checks::Pass),
        Some("FAILURE" | "ERROR") => Some(Checks::Fail),
        Some("PENDING" | "EXPECTED") => Some(Checks::Running),
        _ => None,
    };
    Some(ForgeStatus { pr, checks })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
