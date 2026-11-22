use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::time::SystemTime;

const PAGE_ID: &str = "59db90dbcdeb2f04dadcf16d";
static CLIENT: std::sync::LazyLock<Option<reqwest::Client>> =
    std::sync::LazyLock::new(|| crate::http::client("Roblox service status"));

#[derive(Deserialize, Serialize)]
struct Service {
    id: String,
    name: String,
    status: String,
    status_code: u16,
    #[serde(default)]
    containers: Vec<Service>,
}

#[derive(Deserialize, Serialize)]
struct Overall {
    status: String,
    status_code: u16,
    updated: String,
}

#[derive(Deserialize, Serialize)]
struct Update {
    details: String,
    state: u16,
    datetime: String,
}

#[derive(Deserialize, Serialize)]
struct Incident {
    #[serde(rename(deserialize = "_id"))]
    id: String,
    name: String,
    datetime_open: String,
    #[serde(default)]
    messages: Vec<Update>,
}

#[derive(Deserialize, Serialize)]
struct Status {
    status_overall: Overall,
    status: Vec<Service>,
    incidents: Vec<Incident>,
}

#[derive(Deserialize)]
struct Response {
    result: Status,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    current: Option<Status>,
    history_html: Option<String>,
    checked_at: i64,
}

fn read_current(raw: &str) -> Option<Status> {
    let status = serde_json::from_str::<Response>(raw).ok()?.result;
    (!status.status.is_empty() && !status.status_overall.status.trim().is_empty()).then_some(status)
}

#[tauri::command]
pub async fn roblox_service_status() -> Result<StatusReport> {
    let client = CLIENT.as_ref().ok_or_else(|| AppError::Network("Roblox Status is unavailable.".into()))?;
    let current = format!("https://api.status.io/1.0/status/{PAGE_ID}");
    let history = format!("https://status.roblox.com/pages/history/{PAGE_ID}");
    let get = |url| async move {
        crate::http::text("Roblox service status", client.get(url).send().await, 1_500_000).await
    };
    let (a, b) = tokio::join!(get(current), get(history));
    let status = a.as_deref().and_then(read_current);
    let history = b.filter(|html| html.contains("status.io/public/statuspage") && html.contains(PAGE_ID));
    if status.is_none() && history.is_none() {
        return Err(AppError::Network("Could not reach the official Roblox Status service.".into()));
    }
    Ok(StatusReport {
        current: status,
        history_html: history,
        checked_at: chrono::DateTime::<chrono::Utc>::from(SystemTime::now()).timestamp_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_unknown_status_are_not_operational() {
        assert!(read_current("{}").is_none());
        assert!(read_current(r#"{"result":{"status_overall":{"status":"Operational","status_code":100,"updated":"2026-11-22T01:00:00Z"},"status":[],"incidents":[]}}"#).is_none());
    }

    #[tokio::test]
    #[ignore = "uses the official public status provider"]
    async fn live_status_provider_and_history() {
        let data = roblox_service_status().await.unwrap();
        assert!(data.current.is_some_and(|status| !status.status.is_empty()));
        assert!(data.history_html.is_some_and(|page| page.contains("/pages/incident/")));
    }
}
