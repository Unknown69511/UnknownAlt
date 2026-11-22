//! Read-only, anonymous public history and ranking providers. No account credentials leave this path.
use std::{collections::VecDeque, sync::{LazyLock, Mutex}, time::{Duration, Instant}};
use chrono::NaiveDate;
use serde_json::{Value, json};
use crate::error::{AppError, Result};

const WATCH: &str = "https://rowatcher.com/api/v1";
const STATS: &str = "https://robloxgamestats.com/api/v1";
const ROBLOX: &str = "https://apis.roblox.com/explore-api/v1";
static CLIENT: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| crate::http::client("analytics archive"));
static REQUESTS: Mutex<[VecDeque<Instant>; 3]> = Mutex::new([VecDeque::new(), VecDeque::new(), VecDeque::new()]);
static NEXT_ALLOWED: Mutex<[Option<Instant>; 3]> = Mutex::new([None; 3]);
static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

#[derive(Clone, Copy)]
enum Provider { Watch, Stats, Roblox }

impl Provider {
    fn reserve(self) -> Result<()> {
        let (max, window) = match self {
            Self::Watch => (425, Duration::from_secs(86_400)),
            Self::Stats => (45, Duration::from_secs(60)),
            Self::Roblox => (24, Duration::from_secs(60)),
        };
        let now = Instant::now();
        if let Some(delay) = NEXT_ALLOWED.lock().unwrap_or_else(|e| e.into_inner())[self as usize] {
            if delay > now { return Err(AppError::RateLimited(delay.duration_since(now).as_secs() + 1)); }
        }
        let mut requests = REQUESTS.lock().unwrap_or_else(|e| e.into_inner());
        let queue = &mut requests[self as usize];
        while queue.front().is_some_and(|at| now.duration_since(*at) >= window) { queue.pop_front(); }
        if queue.len() >= max {
            let wait = window.saturating_sub(now.duration_since(queue[0])).as_secs().saturating_add(1);
            return Err(AppError::RateLimited(wait));
        }
        queue.push_back(now);
        Ok(())
    }
}

fn invalid() -> AppError { AppError::Invalid("Unknown Roblox analytics request.".into()) }

fn numeric_id(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str()?.parse().ok()).filter(|id| (1..=(1_u64 << 53) - 1).contains(id))
}

async fn add_icons(client: &reqwest::Client, rows: &mut [Value], field: &str, route: &str, parameter: &str) {
    let ids = rows.iter().filter_map(|row| numeric_id(&row[field])).take(100)
        .map(|id| id.to_string()).collect::<Vec<_>>().join(",");
    if ids.is_empty() { return; }
    let url = format!("https://thumbnails.roblox.com/v1/{route}?{parameter}={ids}&size=150x150&format=Png&isCircular=false");
    let raw = crate::http::text("analytics images", client.get(url).send().await, 300_000).await;
    let Some(images) = raw.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) else { return; };
    let Some(images) = images["data"].as_array() else { return; };
    let lookup: std::collections::HashMap<_, _> = images.iter()
        .filter(|image| image["state"] == "Completed")
        .filter_map(|image| Some((numeric_id(&image["targetId"])?, image["imageUrl"].as_str()?))).collect();
    for row in rows {
        if let Some(icon) = numeric_id(&row[field]).and_then(|id| lookup.get(&id)) { row["iconUrl"] = json!(icon); }
    }
}

fn daily_csv(raw: &str) -> Result<Value> {
    let mut lines = raw.lines();
    if lines.next().map(|line| line.trim().trim_start_matches('\u{feff}')) != Some("date,playing_avg,playing_min,playing_max") {
        return Err(AppError::Invalid("RoWatcher returned an unrecognized history format.".into()));
    }
    let mut points = std::collections::BTreeMap::new();
    for row in lines.take(731) {
        let mut cells = row.split(',');
        let Some(date) = cells.next().and_then(|s| NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok()) else { continue; };
        // A provider can report an average without a valid min/max. Keep each independently.
        let mut value = || cells.next().and_then(|s| s.trim().parse::<f64>().ok())
            .filter(|&n| (0.0..=10_000_000_000.0).contains(&n));
        let (average, low, high) = (value(), value(), value());
        if cells.next().is_some() || (average.is_none() && low.is_none() && high.is_none()) { continue; }
        let low = low.filter(|v| average.is_none_or(|avg| *v <= avg) && high.is_none_or(|max| *v <= max));
        let high = high.filter(|v| average.is_none_or(|avg| *v >= avg));
        let Some(at) = date.and_hms_opt(0, 0, 0) else { continue; };
        points.insert(date, json!({"at": at.and_utc().timestamp_millis(), "average": average, "low": low, "high": high}));
    }
    Ok(Value::Array(points.into_values().collect()))
}

fn daily_visits(raw: &str) -> Result<Value> {
    #[derive(serde::Deserialize)]
    struct Rows { data: Vec<Reading> }
    #[derive(serde::Deserialize)]
    struct Reading { time: String, visits: Value }
    let rows: Rows = serde_json::from_str(raw)
        .map_err(|_| AppError::Invalid("RoWatcher returned an unrecognized visit history.".into()))?;
    let mut days = std::collections::BTreeMap::new();
    for row in rows.data {
        let Some(time) = chrono::DateTime::parse_from_rfc3339(&row.time).ok() else { continue; };
        let Some(visits) = row.visits.as_u64().or_else(|| row.visits.as_str()?.parse().ok()) else { continue; };
        if visits > (1_u64 << 53) - 1 { continue; }
        let millis = time.timestamp_millis();
        let day = millis.div_euclid(86_400_000);
        let stored = days.entry(day).or_insert((millis, visits));
        if stored.0 < millis { *stored = (millis, visits); }
    }
    Ok(Value::Array(days.into_values().map(|(at, visits)| json!({"at": at, "value": visits})).collect()))
}

#[tauri::command]
pub async fn analytics_archive(kind: String, universe: Option<u64>, filter: Option<String>, page: Option<u16>) -> Result<Value> {
    let id = || universe.filter(|id| (1..=(1_u64 << 53) - 1).contains(id)).ok_or_else(invalid);
    let filter = filter.as_deref().unwrap_or("");
    if kind == "studioPortfolio" && matches!(filter, "Group" | "User") {
        let _slot = SLOTS.acquire().await.map_err(|_| invalid())?;
        Provider::Roblox.reserve()?;
        return serde_json::to_value(crate::analytics::studio_portfolio(id()?, filter == "Group").await?)
            .map_err(|_| invalid());
    }
    let (provider, mut url, decode_csv) = match kind.as_str() {
        "platformLive" => (Provider::Watch, format!("{WATCH}/platform/ccu"), false),
        "platformHistory" => (Provider::Stats, format!("{STATS}/platform"), false),
        "gameTotals" => (Provider::Watch, format!("{WATCH}/games/{}/history", id()?), false),
        "gameDaily" => (Provider::Watch, format!("{WATCH}/games/{}/history.csv?days=730", id()?), true),
        "gameArchive" => (Provider::Stats, format!("{STATS}/games/{}/series?days=400", id()?), false),
        "gameSeries" => (Provider::Stats, format!("{STATS}/games/{}/series?days=14", id()?), false),
        "gameProfile" => (Provider::Stats, format!("{STATS}/games/{}", id()?), false),
        "gameEstimate" => (Provider::Watch, format!("{WATCH}/games/{}", id()?), false),
        "records" => (Provider::Stats, format!("{STATS}/records"), false),
        "newGames" => (Provider::Stats, format!("{STATS}/new?days=7&sort=players"), false),
        "trends" => (Provider::Watch, format!("{WATCH}/trends"), false),
        "studios" if matches!(filter, "" | "Group" | "User") => {
            let kind = if filter == "User" { "User" } else { "Group" };
            (Provider::Watch, format!("{WATCH}/creators?type={kind}&limit=40"), false)
        }
        "studioEstimates" => (Provider::Watch, format!("{WATCH}/games?sort=playing&pageSize=100&page=1"), false),
        "games" if filter.len() <= 70 && !filter.chars().any(char::is_control) => {
            (Provider::Watch, format!("{WATCH}/games?sort=playing&pageSize=50&page={}", page.unwrap_or(1).clamp(1, 200)), false)
        }
        "officialChart" if matches!(filter, "top-earning" | "top-playing-now" | "top-trending" | "up-and-coming" | "most-popular" | "top-rated" | "top-revisited" | "fun-with-friends" | "top-paid-access") => {
            // An ephemeral request ID is required by this public endpoint. It is never reused.
            (Provider::Roblox, format!("{ROBLOX}/get-sort-content?device=computer&country=all&sessionId={}&sortId={filter}", uuid::Uuid::new_v4()), false)
        }
        _ => return Err(invalid()),
    };
    if kind == "games" && !filter.is_empty() {
        url = url::Url::parse_with_params(&url, [("genre", filter)]).map_err(|_| invalid())?.to_string();
    }
    let _slot = SLOTS.acquire().await.map_err(|_| invalid())?;
    provider.reserve()?;
    let client = CLIENT.as_ref().ok_or_else(|| AppError::Network("Analytics provider is unavailable.".into()))?;
    let sent = client.get(url).send().await.map_err(|_| AppError::Network("Could not reach the analytics provider.".into()))?;
    let status = sent.status().as_u16();
    if status == 404 { return Ok(Value::Null); }
    if status == 429 {
        let wait = sent.headers().get(reqwest::header::RETRY_AFTER).and_then(|s| s.to_str().ok()).and_then(|s| s.parse::<u64>().ok());
        let seconds = wait.unwrap_or(60).clamp(60, 86_400);
        NEXT_ALLOWED.lock().unwrap_or_else(|e| e.into_inner())[provider as usize] = Some(Instant::now() + Duration::from_secs(seconds));
        return Err(AppError::RateLimited(seconds));
    }
    let limit = if kind == "gameTotals" { 12_000_000 } else { 1_500_000 };
    let raw = crate::http::text("analytics archive", Ok(sent), limit).await
        .ok_or_else(|| AppError::Network("The analytics provider did not return usable data.".into()))?;
    if decode_csv { return daily_csv(&raw); }
    if kind == "gameTotals" { return daily_visits(&raw); }
    let mut data: Value = serde_json::from_str(&raw).map_err(|_| AppError::Invalid("The analytics provider returned an unrecognized response.".into()))?;
    if matches!(provider, Provider::Watch) {
        if kind == "gameEstimate" { return Ok(json!({"estimate": data["data"]["estimatedMonthlyRevenueUsd"], "robuxPerDay": data["data"]["estimatedDailyRevenueRobux"], "confidence": data["data"]["revenueEstimate"]["confidence"], "genrePercentile": data["data"]["genrePercentile"], "recordedAt": data["data"]["lastScraped"]})); }
        let mut result = data["data"].take();
        if kind == "studios" {
            if let Some(rows) = result.as_array_mut() {
                let (route, parameter) = if filter == "User" { ("users/avatar-headshot", "userIds") } else { ("groups/icons", "groupIds") };
                add_icons(client, rows, "creatorId", route, parameter).await;
            }
        }
        if matches!(kind.as_str(), "games" | "studioEstimates") {
            if let Some(rows) = result.as_array_mut() {
                for row in rows {
                    if let Some(fields) = row.as_object_mut() {
                        fields.retain(|name, _| matches!(name.as_str(), "universeId" | "name" | "creatorName" | "genre" | "playing"
                            | "iconUrl" | "robloxCreatedAt" | "robloxUpdatedAt" | "estimatedMonthlyRevenueUsd" |
                            "estimatedDailyRevenueRobux" | "creatorId" | "creatorType" | "lastScraped"));
                    }
                }
            }
        }
        return Ok(result);
    }
    // Keep only the fields used for the detailed profile. Values requiring provider sign-in
    // stay unavailable, and only official Roblox Open Cloud credentials are accepted elsewhere.
    if kind == "gameProfile" {
        return Ok(json!({"peakAll": data["peakAll"], "peakAllAt": data["peakAllAt"], "session": data["session"], "ranks": data["ranks"], "updates": data["updates"], "milestones": data["milestones"], "trackingSince": data["trackingSince"]}));
    }
    if kind == "officialChart" {
        let games = data["games"].as_array_mut().ok_or_else(invalid)?;
        games.retain(|row| row["isSponsored"].as_bool() != Some(true));
        add_icons(client, games, "universeId", "games/icons", "universeIds").await;
        return Ok(data["games"].take());
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_recorded_daily_data_without_interpolating() {
        let raw = "date,playing_avg,playing_min,playing_max\n2024-01-01,2,1,3\n2024-01-01,3,2,4\n2024-01-02,1,4,2\n2024-01-05,4,1,11\n";
        let result = daily_csv(raw).unwrap();
        let rows = result.as_array().unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["average"].as_f64(), Some(3.0));
        assert!(rows[1]["low"].is_null());
        assert_eq!(rows[2]["high"].as_f64(), Some(11.0));
        assert!(daily_csv("<html>not a provider response</html>").is_err());
    }
    #[test]
    fn keeps_the_latest_recorded_visit_total_per_utc_day() {
        let raw = r#"{"data":[
            {"time":"2025-05-01T22:55:00Z","visits":"160"},
            {"time":"2025-05-01T03:01:00Z","visits":"151"},
            {"time":"2025-05-03T01:00:00Z","visits":201},
            {"time":"2025-05-04T01:00:00Z","visits":null}]}"#;
        let result = daily_visits(raw).unwrap();
        assert_eq!(result.as_array().unwrap().len(), 2);
        assert_eq!(result[0]["value"], 160);
        assert_eq!(result[1]["value"], 201);
    }

    #[tokio::test]
    async fn refuses_invalid_routes_before_requesting() {
        assert!(analytics_archive("gameDaily".into(), Some(0), None, None).await.is_err());
        assert!(analytics_archive("officialChart".into(), None, Some("../other".into()), None).await.is_err());
    }
    #[tokio::test]
    #[ignore = "live provider contract"]
    async fn reads_public_archives_and_official_chart() {
        let history = analytics_archive("gameDaily".into(), Some(994732206), None, None).await.unwrap();
        let range = history.as_array().unwrap();
        assert!(range.len() > 365);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        assert!(range[0]["at"].as_i64().unwrap() < now - 365 * 86_400_000);
        assert!(analytics_archive("platformLive".into(), None, None, None).await.unwrap()["current"].is_number());
        assert!(analytics_archive("platformHistory".into(), None, None, None).await.unwrap()["days"].as_array().is_some_and(|p| p.len() > 2));
        let fallback = analytics_archive("gameArchive".into(), Some(994732206), None, None).await.unwrap();
        assert_eq!(fallback["bucketHours"], 24);
        assert!(fallback["hours"].as_array().is_some_and(|rows| !rows.is_empty()));
        let visits = analytics_archive("gameTotals".into(), Some(994732206), None, None).await.unwrap();
        assert!(visits.as_array().is_some_and(|rows| rows.len() > 30));
        let studios = analytics_archive("studios".into(), None, Some("Group".into()), None).await.unwrap();
        assert!(studios.as_array().is_some_and(|rows| rows.iter().any(|row| row["iconUrl"].as_str().is_some_and(|url| url.contains(".rbxcdn.com/")))));
        let portfolio = analytics_archive("studioPortfolio".into(), Some(4372130), Some("Group".into()), None).await.unwrap();
        assert!(portfolio["complete"].as_bool().unwrap());
        assert!(portfolio["publishedGames"].as_u64().unwrap() > 0);
        let chart = analytics_archive("officialChart".into(), None, Some("top-earning".into()), None).await.unwrap();
        assert!(chart.as_array().is_some_and(|rows| !rows.is_empty() && rows.iter().all(|row| row["isSponsored"] != true)));
    }
}
