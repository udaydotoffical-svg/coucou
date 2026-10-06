// GitHub in the notch: open pull requests with their CI and reviews, review requests, the
// default branch's CI, and the contribution calendar. The Rust side of GithubPoller's pulse
// and activity (GitHubPulse.swift, GitHubActivity.swift).
//
// Same GraphQL queries and cadence as the Mac: the pulse every 5 minutes (every minute while a
// check is still running), the activity every 30 minutes. The island gets the parsed result as
// `github-pulse` / `github-activity` events and works out the alerts itself by comparing with the
// previous pulse. Nothing is fetched unless the GitHub pill is on and a token is stored, and
// only api.github.com is ever contacted.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;
use crate::{integrations, log, secrets};

const PULSE_QUERY: &str = r#"
query {
  viewer {
    login
    pullRequests(states: OPEN, first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url isDraft reviewDecision
        repository { nameWithOwner url }
        commits(last: 1) {
          nodes { commit { oid statusCheckRollup { state } } }
        }
      }
    }
    repositories(first: 10, ownerAffiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes {
        nameWithOwner url isArchived
        defaultBranchRef {
          name
          target { ... on Commit { oid statusCheckRollup { state } } }
        }
      }
    }
  }
  reviewRequested: search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: 20) {
    issueCount
    nodes {
      ... on PullRequest {
        number title url isDraft
        author { login }
        repository { nameWithOwner url }
      }
    }
  }
}
"#;

const ACTIVITY_QUERY: &str = r#"
query {
  viewer {
    login
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            date contributionCount contributionLevel weekday
          }
        }
      }
    }
  }
}
"#;

/// Set while a request is in flight, so a refresh button pressed during a poll does not double up.
static PULSE_BUSY: AtomicBool = AtomicBool::new(false);
static ACTIVITY_BUSY: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Starts the two loops. Both stay quiet until the pill is on and a token exists.
pub fn start(app: AppHandle) {
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        loop {
            let mut pending = false;
            if integrations::wanted(&a, "integration_github") {
                pending = pulse(&a).await;
            }
            tokio::time::sleep(Duration::from_secs(if pending { 60 } else { 300 })).await;
        }
    });
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(15)).await;
        loop {
            if integrations::wanted(&app, "integration_github") {
                activity(&app).await;
            }
            tokio::time::sleep(Duration::from_secs(1800)).await;
        }
    });
}

/// The refresh buttons and opening the GitHub card: both are fetched right away.
pub async fn refresh(app: AppHandle) {
    pulse(&app).await;
    activity(&app).await;
}

async fn graphql(token: &str, query: &str) -> Option<Value> {
    let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().ok()?;
    let response = http
        .post("https://api.github.com/graphql")
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", "Coucou")
        .json(&json!({ "query": query }))
        .send()
        .await
        .ok()?;
    let code = response.status().as_u16();
    if code != 200 {
        log::line(format!("github: graphql HTTP {code}"));
        return None;
    }
    let root: Value = response.json().await.ok()?;
    if let Some(errors) = root.get("errors").and_then(Value::as_array) {
        if !errors.is_empty() {
            log::line(format!("github: graphql returned {} error(s)", errors.len()));
        }
    }
    // A partial answer still has "data"; no data at all is a failure.
    root.get("data").filter(|d| d.is_object())?;
    Some(root)
}

/// Fetches and publishes the pulse. Returns whether a check is still running.
async fn pulse(app: &AppHandle) -> bool {
    if integrations::PAUSED.load(Ordering::Relaxed) {
        return false;
    }
    let Some(token) = secrets::get("github-token") else { return false };
    if PULSE_BUSY.swap(true, Ordering::AcqRel) {
        return false;
    }
    let result = graphql(&token, PULSE_QUERY).await.and_then(|root| parse_pulse(&root));
    PULSE_BUSY.store(false, Ordering::Release);
    let Some(p) = result else { return false };
    let pending = p.get("hasPending").and_then(Value::as_bool).unwrap_or(false);
    let _ = app.emit_to(WINDOW_LABEL, "github-pulse", p);
    pending
}

async fn activity(app: &AppHandle) {
    if integrations::PAUSED.load(Ordering::Relaxed) {
        return;
    }
    let Some(token) = secrets::get("github-token") else { return };
    if ACTIVITY_BUSY.swap(true, Ordering::AcqRel) {
        return;
    }
    let result = graphql(&token, ACTIVITY_QUERY).await.and_then(|root| parse_activity(&root));
    ACTIVITY_BUSY.store(false, Ordering::Release);
    if let Some(a) = result {
        let _ = app.emit_to(WINDOW_LABEL, "github-activity", a);
    }
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/// "pending" | "success" | "failure" | "unknown", from a GitHub status rollup state.
fn ci_state(raw: Option<&str>) -> &'static str {
    match raw.map(str::to_uppercase).as_deref() {
        Some("PENDING") | Some("EXPECTED") => "pending",
        Some("SUCCESS") => "success",
        Some("ERROR") | Some("FAILURE") => "failure",
        _ => "unknown",
    }
}

/// "approved" | "changesRequested" | "pending" | "unknown".
fn review_state(raw: Option<&str>) -> &'static str {
    match raw.map(str::to_uppercase).as_deref() {
        Some("APPROVED") => "approved",
        Some("CHANGES_REQUESTED") => "changesRequested",
        Some("REVIEW_REQUIRED") => "pending",
        _ => "unknown",
    }
}

fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn pr_node(node: &Value, with_ci: bool) -> Option<Value> {
    let number = node.get("number")?.as_i64()?;
    let title = s(node, "title")?;
    let url = s(node, "url")?;
    let repo = s(node.get("repository")?, "nameWithOwner")?;
    let (ci, head) = if with_ci {
        let commit = node
            .get("commits")
            .and_then(|c| c.get("nodes"))
            .and_then(Value::as_array)
            .and_then(|n| n.last())
            .and_then(|n| n.get("commit"));
        (
            ci_state(commit.and_then(|c| c.get("statusCheckRollup")).and_then(|r| s(r, "state"))),
            commit.and_then(|c| s(c, "oid")).map(str::to_string),
        )
    } else {
        ("unknown", None)
    };
    Some(json!({
        "id": format!("{repo}#{number}"),
        "title": title,
        "url": url,
        "repo": repo,
        "number": number,
        "isDraft": node.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        "ci": ci,
        "review": if with_ci { review_state(s(node, "reviewDecision")) } else { "pending" },
        "headSha": head,
    }))
}

/// Parses the pulse answer; duplicates are dropped, archived repositories skipped.
pub fn parse_pulse(root: &Value) -> Option<Value> {
    let viewer = root.get("data")?.get("viewer")?;
    let login = s(viewer, "login").unwrap_or("");

    let mut seen = std::collections::HashSet::new();
    let my_prs: Vec<Value> = viewer
        .get("pullRequests")
        .and_then(|c| c.get("nodes"))
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|n| pr_node(n, true))
                .filter(|p| seen.insert(s(p, "id").unwrap_or("").to_string()))
                .collect()
        })
        .unwrap_or_default();

    let main_ci: Vec<Value> = viewer
        .get("repositories")
        .and_then(|c| c.get("nodes"))
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter(|n| !n.get("isArchived").and_then(Value::as_bool).unwrap_or(false))
                .filter_map(|n| {
                    let repo = s(n, "nameWithOwner")?;
                    let url = s(n, "url")?;
                    let branch_ref = n.get("defaultBranchRef")?;
                    let branch = s(branch_ref, "name")?;
                    let target = branch_ref.get("target");
                    Some(json!({
                        "repo": repo,
                        "url": url,
                        "branch": branch,
                        "ci": ci_state(target.and_then(|t| t.get("statusCheckRollup")).and_then(|r| s(r, "state"))),
                        "headSha": target.and_then(|t| s(t, "oid")),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    let mut seen_review = std::collections::HashSet::new();
    let to_review: Vec<Value> = root
        .get("data")?
        .get("reviewRequested")
        .and_then(|c| c.get("nodes"))
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|n| pr_node(n, false))
                .filter(|p| seen_review.insert(s(p, "id").unwrap_or("").to_string()))
                .collect()
        })
        .unwrap_or_default();

    let has_pending = my_prs.iter().any(|p| s(p, "ci") == Some("pending"))
        || main_ci.iter().any(|p| s(p, "ci") == Some("pending"));

    Some(json!({
        "login": login,
        "myPRs": my_prs,
        "toReview": to_review,
        "mainCI": main_ci,
        "hasPending": has_pending,
        "fetchedAt": now_ms(),
    }))
}

/// Parses the contribution calendar into weeks of days (level 0-4).
pub fn parse_activity(root: &Value) -> Option<Value> {
    let cal = root
        .get("data")?
        .get("viewer")?
        .get("contributionsCollection")?
        .get("contributionCalendar")?;
    let total = cal.get("totalContributions")?.as_i64()?;
    let weeks: Vec<Value> = cal
        .get("weeks")?
        .as_array()?
        .iter()
        .filter_map(|week| {
            let days: Vec<Value> = week
                .get("contributionDays")?
                .as_array()?
                .iter()
                .filter_map(|d| {
                    let level = match s(d, "contributionLevel")? {
                        "FIRST_QUARTILE" => 1,
                        "SECOND_QUARTILE" => 2,
                        "THIRD_QUARTILE" => 3,
                        "FOURTH_QUARTILE" => 4,
                        _ => 0,
                    };
                    Some(json!({
                        "date": s(d, "date")?,
                        "count": d.get("contributionCount")?.as_i64()?,
                        "level": level,
                        "weekday": d.get("weekday")?.as_i64()?,
                    }))
                })
                .collect();
            (!days.is_empty()).then(|| Value::Array(days))
        })
        .collect();
    Some(json!({ "total": total, "weeks": weeks, "fetchedAt": now_ms() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pulse_keeps_pull_requests_ci_and_reviews() {
        let root = json!({ "data": {
            "viewer": {
                "login": "uday",
                "pullRequests": { "nodes": [
                    { "number": 7, "title": "Fix it", "url": "https://github.com/a/b/pull/7", "isDraft": false,
                      "reviewDecision": "APPROVED", "repository": { "nameWithOwner": "a/b" },
                      "commits": { "nodes": [ { "commit": { "oid": "abc", "statusCheckRollup": { "state": "PENDING" } } } ] } },
                    { "number": 7, "title": "Same again", "url": "https://github.com/a/b/pull/7", "isDraft": true,
                      "repository": { "nameWithOwner": "a/b" } }
                ] },
                "repositories": { "nodes": [
                    { "nameWithOwner": "a/b", "url": "https://github.com/a/b", "isArchived": false,
                      "defaultBranchRef": { "name": "main", "target": { "oid": "def", "statusCheckRollup": { "state": "FAILURE" } } } },
                    { "nameWithOwner": "a/old", "url": "https://github.com/a/old", "isArchived": true,
                      "defaultBranchRef": { "name": "main", "target": { "oid": "x" } } }
                ] }
            },
            "reviewRequested": { "nodes": [
                { "number": 3, "title": "Look", "url": "https://github.com/c/d/pull/3", "isDraft": false,
                  "repository": { "nameWithOwner": "c/d" } }
            ] }
        } });
        let p = parse_pulse(&root).unwrap();
        assert_eq!(p["login"], "uday");
        // The duplicate PR is dropped.
        assert_eq!(p["myPRs"].as_array().unwrap().len(), 1);
        assert_eq!(p["myPRs"][0]["id"], "a/b#7");
        assert_eq!(p["myPRs"][0]["ci"], "pending");
        assert_eq!(p["myPRs"][0]["review"], "approved");
        assert_eq!(p["myPRs"][0]["headSha"], "abc");
        // The archived repository is skipped.
        assert_eq!(p["mainCI"].as_array().unwrap().len(), 1);
        assert_eq!(p["mainCI"][0]["ci"], "failure");
        assert_eq!(p["toReview"][0]["id"], "c/d#3");
        // A running check means the next poll comes sooner.
        assert_eq!(p["hasPending"], true);
    }

    #[test]
    fn the_calendar_maps_levels() {
        let root = json!({ "data": { "viewer": { "contributionsCollection": { "contributionCalendar": {
            "totalContributions": 12,
            "weeks": [ { "contributionDays": [
                { "date": "2026-10-04", "contributionCount": 0, "contributionLevel": "NONE", "weekday": 0 },
                { "date": "2026-10-05", "contributionCount": 9, "contributionLevel": "FOURTH_QUARTILE", "weekday": 1 }
            ] }, { "contributionDays": [] } ]
        } } } } });
        let a = parse_activity(&root).unwrap();
        assert_eq!(a["total"], 12);
        // The empty week is dropped.
        assert_eq!(a["weeks"].as_array().unwrap().len(), 1);
        assert_eq!(a["weeks"][0][0]["level"], 0);
        assert_eq!(a["weeks"][0][1]["level"], 4);
        assert_eq!(a["weeks"][0][1]["count"], 9);
    }

    #[test]
    fn no_data_is_no_pulse() {
        assert!(parse_pulse(&json!({ "errors": [] })).is_none());
        assert!(parse_activity(&json!({ "data": { "viewer": null } })).is_none());
    }
}
