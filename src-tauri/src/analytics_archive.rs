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

fn daily_csv(raw: &str) -> Result<Value> {
    let mut lines = raw.lines();
    if lines.next().map(str::trim) != Some("date,playing_avg,playing_min,playing_max") {
        return Err(AppError::Invalid("RoWatcher returned an unrecognized history format.".into()));
    }
    let mut points = std::collections::BTreeMap::new();
    for row in lines.take(731) {
        let mut cells = row.split(',');
        let Some(date) = cells.next().and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()) else { continue; };
        let value = || cells.next().and_then(|s| s.parse::<u64>().ok()).filter(|&n| n <= 10_000_000_000);
        let mut value = value;
        let (Some(average), Some(low), Some(high)) = (value(), value(), value()) else { continue; };
        if low > average || average > high || cells.next().is_some() { continue; }
        let Some(at) = date.and_hms_opt(0, 0, 0) else { continue; };
        points.insert(date, json!({"at": at.and_utc().timestamp_millis(), "average": average, "low": low, "high": high}));
    }
    Ok(Value::Array(points.into_values().collect()))
}

#[tauri::command]
pub async fn analytics_archive(kind: String, universe: Option<u64>, filter: Option<String>, page: Option<u16>) -> Result<Value> {
    let id = || universe.filter(|id| (1..=(1_u64 << 53) - 1).contains(id)).ok_or_else(invalid);
    let filter = filter.as_deref().unwrap_or("");
    let (provider, mut url, decode_csv) = match kind.as_str() {
        "platformLive" => (Provider::Watch, format!("{WATCH}/platform/ccu"), false),
        "platformHistory" => (Provider::Stats, format!("{STATS}/platform"), false),
        "gameDaily" => (Provider::Watch, format!("{WATCH}/games/{}/history.csv?days=730", id()?), true),
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
    let raw = crate::http::text("analytics archive", Ok(sent), 1_500_000).await
        .ok_or_else(|| AppError::Network("The analytics provider did not return usable data.".into()))?;
    if decode_csv { return daily_csv(&raw); }
    let mut data: Value = serde_json::from_str(&raw).map_err(|_| AppError::Invalid("The analytics provider returned an unrecognized response.".into()))?;
    if matches!(provider, Provider::Watch) {
        if kind == "gameEstimate" { return Ok(json!({"estimate": data["data"]["estimatedMonthlyRevenueUsd"], "confidence": data["data"]["revenueEstimate"]["confidence"], "genrePercentile": data["data"]["genrePercentile"], "recordedAt": data["data"]["lastScraped"]})); }
        let mut result = data["data"].take();
        if kind == "games" {
            if let Some(rows) = result.as_array_mut() {
                for row in rows {
                    if let Some(fields) = row.as_object_mut() {
                        fields.retain(|name, _| matches!(name.as_str(), "universeId" | "name" | "creatorName" | "genre" | "playing"
                            | "iconUrl" | "robloxCreatedAt" | "robloxUpdatedAt" | "estimatedMonthlyRevenueUsd"));
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
        let ids = games.iter().filter_map(|row| row["universeId"].as_u64()).take(100)
            .map(|id| id.to_string()).collect::<Vec<_>>().join(",");
        if !ids.is_empty() {
            let url = format!("https://thumbnails.roblox.com/v1/games/icons?universeIds={ids}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false");
            let text = crate::http::text("analytics chart images", client.get(url).send().await, 300_000).await;
            let images: Value = text.as_deref().and_then(|raw| serde_json::from_str(raw).ok()).unwrap_or(Value::Null);
            if let Some(images) = images["data"].as_array() {
                let lookup: std::collections::HashMap<_, _> = images.iter().filter_map(|image| {
                    Some((image["targetId"].as_u64()?, image["imageUrl"].as_str()?))
                }).collect();
                for row in games.iter_mut() {
                    if let Some(icon) = row["universeId"].as_u64().and_then(|id| lookup.get(&id)) {
                        row["iconUrl"] = json!(icon);
                    }
                }
            }
        }
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
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["average"], 3);
        assert_eq!(rows[1]["high"], 11);
        assert!(daily_csv("<html>not a provider response</html>").is_err());
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
        let chart = analytics_archive("officialChart".into(), None, Some("top-earning".into()), None).await.unwrap();
        assert!(chart.as_array().is_some_and(|rows| !rows.is_empty() && rows.iter().all(|row| row["isSponsored"] != true)));
    }
}
