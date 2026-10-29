//! Claude plan usage for the status bar: how much of the 5-hour and weekly
//! windows the account Claude Code is signed in with on this Mac has used,
//! read with Claude Code's own OAuth sign-in (the login keychain, else
//! `~/.claude/.credentials.json`). Ported from herdr-gpui's
//! `herdr-usage/src/providers/claude.rs`, without its other accounts.
//!
//! The usage endpoint is rate limited and the numbers move slowly, so a
//! reading is kept and asked again only after [`REFRESH`], or sooner after a
//! failure; the webview may poll as often as it likes.

use crate::process;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

const URL: &str = "https://api.anthropic.com/api/oauth/usage";
const BETA: &str = "oauth-2025-04-20";
/// The usage endpoint serves Claude Code's OAuth clients.
const AGENT: &str = "claude-code/2.1.0";
const KEYCHAIN: &str = "Claude Code-credentials";

const REFRESH: Duration = Duration::from_secs(10 * 60);
const RATE_LIMITED: Duration = Duration::from_secs(30 * 60);
/// A network failure or a rejected sign-in is retried sooner than a refresh
/// but not on every poll: a dead token sent each minute reads as abuse.
const ERROR_BACKOFF: Duration = Duration::from_secs(5 * 60);
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Claude Code is not signed in on this Mac")]
    SignedOut,
    #[error("Anthropic is rate limiting usage reads")]
    RateLimited,
    #[error("could not read Claude usage: {0}")]
    Request(String),
    #[error("Claude usage answered in an unknown shape")]
    Shape(#[source] serde_json::Error),
    #[error("the usage reader stopped")]
    Worker(#[source] tauri::Error),
}

/// One limit window. `resets_at` is passed on as Anthropic wrote it, an ISO
/// time or epoch seconds, for the webview to count down from.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Window {
    pub percent: f64,
    pub resets_at: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Usage {
    /// `Max 20x`, `Pro`.
    pub plan: Option<String>,
    pub session: Option<Window>,
    pub weekly: Option<Window>,
}

/// The last reading, kept until it is due again. A failed refresh keeps the
/// last good reading rather than blanking the bar.
#[derive(Default)]
pub struct Cache(Mutex<Option<Entry>>);

struct Entry {
    usage: Option<Usage>,
    due: Instant,
}

impl Cache {
    /// The kept reading if it is still fresh, else a new one; `None` when
    /// Claude Code is signed out or no reading has succeeded yet.
    pub fn read(&self) -> Option<Usage> {
        let mut entry = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = entry.as_ref().filter(|entry| Instant::now() < entry.due) {
            return entry.usage.clone();
        }
        let kept = entry.as_ref().and_then(|entry| entry.usage.clone());
        let (usage, wait) = match fetch() {
            Ok(usage) => (Some(usage), REFRESH),
            Err(Error::RateLimited) => (kept, RATE_LIMITED),
            Err(Error::SignedOut) => (None, ERROR_BACKOFF),
            Err(_) => (kept, ERROR_BACKOFF),
        };
        *entry = Some(Entry {
            usage: usage.clone(),
            due: Instant::now() + wait,
        });
        usage
    }
}

fn fetch() -> Result<Usage, Error> {
    let credentials = keychain().or_else(file).ok_or(Error::SignedOut)?;
    let oauth = &credentials["claudeAiOauth"];
    let token = oauth["accessToken"].as_str().ok_or(Error::SignedOut)?;
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .http_status_as_error(false)
        .build()
        .new_agent();
    let mut response = agent
        .get(URL)
        .header("Authorization", &format!("Bearer {token}"))
        .header("anthropic-beta", BETA)
        .header("User-Agent", AGENT)
        .call()
        .map_err(|error| Error::Request(error.to_string()))?;
    match response.status().as_u16() {
        200 => {}
        429 => return Err(Error::RateLimited),
        status => return Err(Error::Request(format!("HTTP {status}"))),
    }
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|error| Error::Request(error.to_string()))?;
    let mut usage = parse(&body)?;
    usage.plan = plan(
        oauth["subscriptionType"].as_str(),
        oauth["rateLimitTier"].as_str(),
    );
    Ok(usage)
}

/// Claude Code keeps its sign-in under the user's account name; asked by
/// service alone, `security` may answer with another account's item first,
/// such as one `sudo claude` left under `root`.
fn keychain() -> Option<Value> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let user = std::env::var("USER").ok();
    [user.as_deref(), None].into_iter().find_map(|account| {
        let mut command = process::command("/usr/bin/security");
        command.args(["find-generic-password", "-s", KEYCHAIN, "-w"]);
        if let Some(account) = account {
            command.args(["-a", account]);
        }
        let output = command
            .output()
            .ok()
            .filter(|output| output.status.success())?;
        let credentials: Value = serde_json::from_slice(&output.stdout).ok()?;
        credentials["claudeAiOauth"]["accessToken"].as_str()?;
        Some(credentials)
    })
}

fn file() -> Option<Value> {
    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home).join(".claude/.credentials.json");
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// The 5-hour and weekly windows, from `limits` where Anthropic sends it,
/// else from the older `five_hour` and `seven_day` fields.
fn parse(body: &str) -> Result<Usage, Error> {
    let raw: Raw = serde_json::from_str(body).map_err(Error::Shape)?;
    let limit = |kind: &str| {
        raw.limits
            .iter()
            .flatten()
            .find(|limit| limit.kind == kind)
            .and_then(|limit| {
                Some(Window {
                    percent: limit.percent?,
                    resets_at: limit.resets_at.clone(),
                })
            })
    };
    let fixed = |window: &Option<Fixed>| {
        window.as_ref().and_then(|window| {
            Some(Window {
                percent: window.utilization?,
                resets_at: window.resets_at.clone(),
            })
        })
    };
    Ok(Usage {
        plan: None,
        session: limit("session").or_else(|| fixed(&raw.five_hour)),
        weekly: limit("weekly_all").or_else(|| fixed(&raw.seven_day)),
    })
}

/// `max` on tier `default_claude_max_20x` is `Max 20x`.
fn plan(subscription: Option<&str>, tier: Option<&str>) -> Option<String> {
    let mut letters = subscription?.trim().chars();
    let name: String = letters.next()?.to_uppercase().chain(letters).collect();
    let multiple = tier
        .and_then(|tier| tier.rsplit('_').next())
        .filter(|last| {
            last.strip_suffix('x')
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        });
    Some(match multiple {
        Some(multiple) => format!("{name} {multiple}"),
        None => name,
    })
}

#[derive(Deserialize)]
struct Raw {
    limits: Option<Vec<Limit>>,
    five_hour: Option<Fixed>,
    seven_day: Option<Fixed>,
}

#[derive(Deserialize)]
struct Limit {
    kind: String,
    percent: Option<f64>,
    resets_at: Option<Value>,
}

#[derive(Deserialize)]
struct Fixed {
    utilization: Option<f64>,
    resets_at: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_limits_over_the_fixed_windows() -> Result<(), Error> {
        let usage = parse(
            r#"{"limits":[
                {"kind":"session","percent":9,"resets_at":"2026-10-29T18:00:00Z"},
                {"kind":"weekly_scoped","percent":50},
                {"kind":"weekly_all","percent":34.5,"resets_at":1793000000}],
              "five_hour":{"utilization":99}}"#,
        )?;
        assert_eq!(
            usage.session,
            Some(Window {
                percent: 9.,
                resets_at: Some(Value::from("2026-10-29T18:00:00Z"))
            })
        );
        assert_eq!(usage.weekly.map(|w| w.percent), Some(34.5));
        Ok(())
    }

    #[test]
    fn falls_back_to_the_fixed_windows() -> Result<(), Error> {
        let usage = parse(r#"{"five_hour":{"utilization":12,"resets_at":null},"seven_day":null}"#)?;
        assert_eq!(usage.session.map(|w| w.percent), Some(12.));
        assert_eq!(usage.weekly, None);
        Ok(())
    }

    #[test]
    fn names_the_plan_with_its_multiple() {
        assert_eq!(
            plan(Some("max"), Some("default_claude_max_20x")).as_deref(),
            Some("Max 20x")
        );
        assert_eq!(
            plan(Some("pro"), Some("default_claude_ai")).as_deref(),
            Some("Pro")
        );
        assert_eq!(plan(None, None), None);
    }
}
