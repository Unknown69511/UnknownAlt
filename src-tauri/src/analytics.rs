//! Read-only Roblox analytics. Public requests never use account cookies.
use std::{collections::{HashMap, HashSet}, sync::Mutex, time::{Duration, SystemTime}};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use url::Url;
use crate::{error::{AppError, Result}, secret_types::Secret};

const API: &str = "https://apis.roblox.com";
const GAMES: &str = "https://games.roblox.com";
const THUMBS: &str = "https://thumbnails.roblox.com";
const PUBLIC_BATCH: usize = 50;
static CLIENT: std::sync::LazyLock<Option<reqwest::Client>> =
    std::sync::LazyLock::new(|| crate::http::client("analytics"));
static CREATOR_KEY: Mutex<Option<Secret>> = Mutex::new(None);

fn client() -> Result<&'static reqwest::Client> {
    CLIENT.as_ref().ok_or_else(|| AppError::Network("Analytics is unavailable.".into()))
}

fn invalid(message: &str) -> AppError { AppError::Invalid(message.into()) }

async fn json<T: DeserializeOwned>(request: reqwest::RequestBuilder) -> Result<T> {
    let sent = request.send().await.map_err(|_| AppError::Network("Could not reach Roblox Analytics.".into()))?;
    let status = sent.status().as_u16();
    if matches!(status, 401 | 403) {
        return Err(AppError::Roblox(format!("HTTP {status}")));
    }
    if status == 429 { return Err(AppError::RateLimited(60)); }
    if !sent.status().is_success() { return Err(AppError::Roblox(format!("HTTP {status}"))); }
    let raw = crate::http::text("analytics", Ok(sent), 2_000_000).await.ok_or_else(|| AppError::Network("Roblox returned an incomplete analytics response.".into()))?;
    serde_json::from_str(&raw).map_err(|_| AppError::Roblox("unrecognized analytics response".into()))
}

#[derive(Deserialize)]
struct Rows<T> { data: Vec<T> }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicGame {
    #[serde(rename(deserialize = "id"))]
    universe_id: u64,
    root_place_id: u64,
    name: String,
    #[serde(default, deserialize_with = "nullable_creator")]
    creator: Creator,
    playing: Option<u64>,
    visits: Option<u64>,
    #[serde(rename(deserialize = "favoritedCount"))]
    favorites: Option<u64>,
    updated: Option<String>,
    created: Option<String>,
    #[serde(rename(deserialize = "genre_l1"))]
    genre: Option<String>,
    #[serde(rename(deserialize = "genre_l2"))]
    subgenre: Option<String>,
    description: Option<String>,
    #[serde(skip_deserializing)]
    icon: Option<String>,
    #[serde(skip_deserializing)]
    thumbnail: Option<String>,
    #[serde(skip_deserializing)]
    likes: Option<u64>,
    #[serde(skip_deserializing)]
    dislikes: Option<u64>,
}

#[derive(Default, Serialize, Deserialize)]
struct Creator {
    id: Option<u64>,
    name: Option<String>,
    #[serde(rename(deserialize = "type"))]
    kind: Option<String>,
}
fn nullable_creator<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Creator, D::Error> {
    Ok(Option::<Creator>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicSnapshot {
    observed_at: i64,
    games: Vec<PublicGame>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PassRows { game_passes: Vec<PublicPass> }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublicPass {
    id: u64,
    name: String,
    display_name: Option<String>,
    price: Option<u64>,
    is_for_sale: Option<bool>,
}

#[derive(Serialize, Deserialize)]
struct PublicBadge { id: u64, name: String, description: Option<String> }

#[derive(Serialize)]
pub struct GameExtras { passes: Option<Vec<PublicPass>>, badges: Option<Vec<PublicBadge>>, thumbnails: Vec<String> }

#[tauri::command]
pub async fn public_game_extras(universe: u64) -> Result<GameExtras> {
    if ids([universe], 1).is_empty() { return Err(invalid("Invalid Roblox universe.")); }
    let client = client()?;
    let passes = json::<PassRows>(client.get(format!("{API}/game-passes/v1/universes/{universe}/game-passes?pageSize=10")));
    let badges = json::<Rows<PublicBadge>>(client.get(format!("https://badges.roblox.com/v1/universes/{universe}/badges?limit=10&sortOrder=Asc")));
    let thumbs = json::<Rows<Thumbnail>>(client.get(format!("{THUMBS}/v1/games/multiget/thumbnails?universeIds={universe}&countPerUniverse=5&size=768x432&format=Png")));
    let (passes, badges, thumbs) = tokio::join!(passes, badges, thumbs);
    Ok(GameExtras {
        passes: passes.ok().map(|rows| rows.game_passes.into_iter().take(10).collect()),
        badges: badges.ok().map(|rows| rows.data.into_iter().take(10).collect()),
        thumbnails: thumbs.ok().into_iter().flat_map(|rows| rows.data)
            .filter(|row| row.universe_id == universe).flat_map(|row| row.thumbnails)
            .filter_map(image_url).take(5).collect(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vote { id: u64, up_votes: u64, down_votes: u64 }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Image { target_id: u64, image_url: Option<String>, state: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Thumbnail { universe_id: u64, #[serde(default)] thumbnails: Vec<Image> }

fn image_url(image: Image) -> Option<String> {
    if image.state != "Completed" { return None; }
    let raw = image.image_url?;
    let url = Url::parse(&raw).ok()?;
    (url.scheme() == "https" && url.port().is_none() && url.password().is_none() &&
        url.username().is_empty() && url.host_str()?.ends_with(".rbxcdn.com")).then_some(raw)
}

fn ids(values: impl IntoIterator<Item = u64>, limit: usize) -> Vec<u64> {
    let mut seen = HashSet::new();
    values.into_iter().filter(|id| *id > 0 && *id <= (1_u64 << 53)-1 && seen.insert(*id)).take(limit).collect()
}

#[tauri::command]
pub async fn public_analytics_snapshot(universes: Vec<u64>, details: bool) -> Result<PublicSnapshot> {
    let universe_ids = ids(universes, PUBLIC_BATCH);
    let mut result = PublicSnapshot { observed_at: DateTime::<Utc>::from(SystemTime::now()).timestamp_millis(), games: vec![] };
    if universe_ids.is_empty() { return Ok(result); }
    let requested = universe_ids.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
    let client = client()?;
    let games = json::<Rows<serde_json::Value>>(client.get(format!("{GAMES}/v1/games?universeIds={requested}")));
    let media = async {
        let votes = json::<Rows<Vote>>(client.get(format!("{GAMES}/v1/games/votes?universeIds={requested}")));
        let icons = json::<Rows<Image>>(client.get(format!("{THUMBS}/v1/games/icons?universeIds={requested}&size=150x150&format=Png")));
        let thumbnails = async {
            let mut images = Vec::new();
            for chunk in universe_ids.chunks(20) {
                let selected = chunk.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
                if let Ok(rows) = json::<Rows<Thumbnail>>(client.get(format!("{THUMBS}/v1/games/multiget/thumbnails?universeIds={selected}&countPerUniverse=1&size=768x432&format=Png"))).await {
                    images.extend(rows.data);
                }
            }
            Ok::<_,AppError>(Rows { data: images })
        };
        tokio::join!(votes, icons, thumbnails)
    };
    let (rows, (votes, icons, thumbnails)) = if details {
        let (games, media) = tokio::join!(games, media);
        (games?.data, media)
    } else {
        (games.await?.data, (Err(AppError::Cancelled), Err(AppError::Cancelled), Err(AppError::Cancelled)))
    };
    let had_results = !rows.is_empty();
    let mut games: Vec<PublicGame> = rows.into_iter().filter_map(|row| serde_json::from_value(row).ok()).collect();
    if had_results && games.is_empty() { return Err(AppError::Roblox("game details are unavailable".into())); }
    let mut votes: HashMap<_, _> = votes.ok().into_iter().flat_map(|v| v.data).map(|v| (v.id, v)).collect();
    let mut icons: HashMap<_, _> = icons.ok().into_iter().flat_map(|v| v.data).filter_map(|img| Some((img.target_id, image_url(img)?))).collect();
    let mut thumbnails: HashMap<_, _> = thumbnails.ok().into_iter().flat_map(|v| v.data)
        .filter_map(|row| Some((row.universe_id, row.thumbnails.into_iter().find_map(image_url)?))).collect();
    for game in &mut games {
        if let Some(text) = &mut game.description {
            if let Some((end, _)) = text.char_indices().nth(700) {
                text.truncate(end);
            }
        }
        game.icon = icons.remove(&game.universe_id);
        game.thumbnail = thumbnails.remove(&game.universe_id);
        if let Some(vote) = votes.remove(&game.universe_id) {
            game.likes = Some(vote.up_votes);
            game.dislikes = Some(vote.down_votes);
        }
    }
    games.retain(|game| universe_ids.contains(&game.universe_id) && game.root_place_id > 0);
    games.sort_by_key(|game| universe_ids.iter().position(|id| *id == game.universe_id));
    result.games = games;
    result.observed_at = DateTime::<Utc>::from(SystemTime::now()).timestamp_millis();
    Ok(result)
}

// Resolve only trusted Roblox experience URLs. Never fetch the text the user pasted.
fn place_id(query: &str) -> Result<Option<u64>> {
    let valid = |value: u64| value > 0 && value <= (1_u64 << 53)-1;
    if let Ok(value) = query.parse::<u64>() {
        return if valid(value) { Ok(Some(value)) } else { Err(invalid("Enter a valid Roblox place ID.")) };
    }
    let normalized = if query.starts_with("www.roblox.com/") || query.starts_with("roblox.com/") {
        format!("https://{query}")
    } else if query.contains("://") { query.to_owned() } else { return Ok(None); };
    let parsed = Url::parse(&normalized).ok().filter(|url| url.scheme() == "https" &&
        matches!(url.host_str(), Some("www.roblox.com" | "roblox.com")) &&
        url.port().is_none() && url.username().is_empty() && url.password().is_none());
    let value = parsed.and_then(|url| {
        let mut parts = url.path_segments()?;
        (parts.next()? == "games").then_some(())?;
        parts.next()?.parse::<u64>().ok().filter(|value| valid(*value))
    });
    value.map(Some).ok_or_else(|| invalid("Use a Roblox game URL such as https://www.roblox.com/games/12345."))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Candidate { universe_id: Option<u64>, #[serde(default)] is_sponsored: bool }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Search { search_results: Vec<SearchGroup> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchGroup { #[serde(default)] content_group_type: String, #[serde(default)] contents: Vec<Candidate> }
#[derive(Deserialize)]
struct Explore { sorts: Vec<Sort> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sort { sort_id: Option<String>, #[serde(default)] games: Vec<Candidate> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Universe { universe_id: Option<u64> }

#[tauri::command]
pub async fn public_analytics_search(query: String) -> Result<PublicSnapshot> {
    let query = query.trim();
    let client = client()?;
    if query.is_empty() || query.chars().count() > 300 { return Err(invalid("Enter a game name or Roblox URL.")); }
    let found = if let Some(place) = place_id(query)? {
        let found: Universe = json(client.get(format!("{API}/universes/v1/places/{place}/universe"))).await?;
        found.universe_id.into_iter().collect()
    } else {
        let mut url = Url::parse(&format!("{API}/search-api/omni-search")).unwrap();
        url.query_pairs_mut().append_pair("searchQuery", query)
            .append_pair("sessionId", &uuid::Uuid::new_v4().to_string()).append_pair("pageType", "games");
        let found: Search = json(client.get(url)).await?;
        ids(found.search_results.into_iter().filter(|group| group.content_group_type == "Game")
            .flat_map(|group| group.contents).filter(|game| !game.is_sponsored).filter_map(|game| game.universe_id), 16)
    };
    public_analytics_snapshot(found, true).await
}

#[tauri::command]
pub async fn public_analytics_trending() -> Result<PublicSnapshot> {
    let explore = explore().await?;
    let trending = explore.sorts.into_iter()
        .filter(|sort| sort.sort_id.as_deref() == Some("top-trending"))
        .flat_map(|sort| sort.games).filter(|game| !game.is_sponsored).filter_map(|game| game.universe_id);
    public_analytics_snapshot(ids(trending, 16), true).await
}

async fn explore() -> Result<Explore> {
    json(client()?.get(format!("{API}/explore-api/v1/get-sorts?sessionId={}", uuid::Uuid::new_v4()))).await
}

#[derive(Serialize)]
pub struct Discovery {
    snapshot: PublicSnapshot,
    trending: Vec<u64>,
    popular: Vec<u64>,
    rising: Vec<u64>,
}

#[tauri::command]
pub async fn public_discovery() -> Result<Discovery> {
    let explore = explore().await?;
    let chart = |key: &str| ids(explore.sorts.iter().filter(|sort| sort.sort_id.as_deref() == Some(key))
        .flat_map(|sort| &sort.games).filter(|game| !game.is_sponsored).filter_map(|game| game.universe_id), 16);
    let (trending, popular, rising) = (chart("top-trending"), chart("top-playing-now"), chart("up-and-coming"));
    let candidates = ids(trending.iter().chain(&popular).chain(&rising).copied(), PUBLIC_BATCH);
    if candidates.is_empty() { return Err(AppError::Roblox("public charts are unavailable".into())); }
    let snapshot = public_analytics_snapshot(candidates, true).await?;
    Ok(Discovery { snapshot, trending, popular, rising })
}

#[tauri::command]
pub async fn public_similar_games(universe: u64) -> Result<PublicSnapshot> {
    if ids([universe], 1).is_empty() { return Err(invalid("Invalid experience universe ID.")); }
    #[derive(Deserialize)]
    struct Recommendation { games: Vec<Candidate> }
    let related: Recommendation = json(client()?.get(format!("{GAMES}/v1/games/recommendations/game/{universe}"))).await?;
    public_analytics_snapshot(ids(related.games.into_iter().filter(|g| !g.is_sponsored)
        .filter_map(|g| g.universe_id).filter(|id| *id != universe), 10), true).await
}

#[tauri::command]
pub async fn public_analytics_studio(creator: u64, group: bool) -> Result<PublicSnapshot> {
    if ids([creator], 1).is_empty() { return Err(invalid("Invalid Roblox creator.")); }
    #[derive(Deserialize)]
    struct Published { id: u64 }
    let route = if group { format!("groups/{creator}/gamesV2") } else { format!("users/{creator}/games") };
    let list: Rows<Published> = json(client()?.get(format!("{GAMES}/v2/{route}?accessFilter=Public&limit=25&sortOrder=Desc"))).await?;
    public_analytics_snapshot(ids(list.data.into_iter().map(|game| game.id), 25), false).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StudioPortfolio {
    games: Vec<PublicGame>,
    published_games: usize,
    complete: bool,
    active_players: Option<u64>,
    visits: Option<u64>,
    observed_at: i64,
}

pub(crate) async fn studio_portfolio(creator: u64, group: bool) -> Result<StudioPortfolio> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Page { data: Vec<Published>, next_page_cursor: Option<String> }
    #[derive(Deserialize)]
    struct Published { id: u64 }

    let route = if group { format!("groups/{creator}/gamesV2") } else { format!("users/{creator}/games") };
    let client = client()?;
    let url = Url::parse(&format!("{GAMES}/v2/{route}?accessFilter=Public&limit=50&sortOrder=Desc"))
        .map_err(|_| invalid("Invalid Roblox creator route."))?;
    let mut cursor: Option<String> = None;
    let mut seen = HashSet::new();
    let mut universes = Vec::new();
    let mut has_last_page = false;
    for _ in 0..4 {
        let mut request = url.clone();
        if let Some(next) = &cursor { request.query_pairs_mut().append_pair("cursor", next); }
        let page: Page = json(client.get(request)).await?;
        universes.extend(ids(page.data.into_iter().map(|row| row.id), 50).into_iter().filter(|id| seen.insert(*id)));
        let Some(next) = page.next_page_cursor.filter(|value| !value.is_empty()) else {
            has_last_page = true;
            break;
        };
        if cursor.as_ref() == Some(&next) || next.len() > 512 { break; }
        cursor = Some(next);
    }
    let mut games = Vec::new();
    for chunk in universes.chunks(PUBLIC_BATCH) {
        games.extend(public_analytics_snapshot(chunk.to_vec(), false).await?.games);
    }
    let sum = |metric: fn(&PublicGame) -> Option<u64>| -> Option<u64> {
        if games.len() != universes.len() { return None; }
        games.iter().try_fold(0_u64, |total, game| total.checked_add(metric(game)?))
    };
    let active_players = sum(|game| game.playing);
    let visits = sum(|game| game.visits);
    Ok(StudioPortfolio { active_players, visits, games, published_games: universes.len(), complete: has_last_page,
        observed_at: DateTime::<Utc>::from(SystemTime::now()).timestamp_millis() })
}

#[tauri::command]
pub fn creator_analytics_connect(key: String) -> Result<()> {
    let key = Secret::new(key);
    if !(16..=2048).contains(&key.expose().len()) || !key.expose().bytes().all(|b| b.is_ascii_graphic()) {
        return Err(invalid("Enter a valid Roblox Open Cloud API key."));
    }
    *CREATOR_KEY.lock().unwrap_or_else(|e| e.into_inner()) = Some(key);
    Ok(())
}

#[tauri::command]
pub fn creator_analytics_disconnect() {
    CREATOR_KEY.lock().unwrap_or_else(|e| e.into_inner()).take();
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Metric { Active, NewPlayers, Session, DayOne, DaySeven, Revenue, Traffic, Payers, Engagement }

impl Metric {
    fn query(&self) -> (&'static str, &'static [&'static str]) {
        match self {
            Self::Active => ("DailyActiveUsers", &[]),
            Self::NewPlayers => ("DailyActiveUsers", &["IsNewUser"]),
            Self::Session => ("AverageSessionLengthMinutes", &[]),
            Self::DayOne => ("ForwardD1Retention", &[]),
            Self::DaySeven => ("ForwardD7Retention", &[]),
            Self::Revenue => ("DailyRevenue", &[]),
            Self::Traffic => ("UniqueUsersWithPlaySessions", &["AcquisitionSource"]),
            Self::Payers => ("PayingUsersCVR", &[]),
            Self::Engagement => ("DailyActiveUsers", &["UserSegmentationEngagementLevel"]),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Breakdown { dimension: String, value: String }

#[derive(Serialize, Deserialize)]
struct Point { time: String, value: Option<f64>, status: Option<String> }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    #[serde(default)]
    breakdowns: Vec<Breakdown>,
    #[serde(default)]
    data_points: Vec<Point>,
}

#[derive(Deserialize)]
struct MetricResponse { values: Vec<Series> }
#[derive(Deserialize)]
struct Operation { done: bool, path: Option<String>, response: Option<MetricResponse> }

fn metric_dates(start: &str, end: &str) -> Result<(NaiveDate, NaiveDate)> {
    let parse = |text| NaiveDate::parse_from_str(text, "%Y-%m-%d").ok().filter(|d| d.format("%Y-%m-%d").to_string() == text);
    let start = parse(start).ok_or_else(|| invalid("Choose a valid starting date."))?;
    let end = parse(end).ok_or_else(|| invalid("Choose a valid ending date."))?;
    let today = DateTime::<Utc>::from(SystemTime::now()).date_naive();
    if start > end || end > today || (end - start).num_days() > 365 {
        return Err(invalid("Select an ordered date range of up to 366 days ending today or earlier."));
    }
    Ok((start, end.succ_opt().ok_or_else(|| invalid("Invalid ending date."))?))
}

fn operation_id(path: &str, universe: u64) -> Result<&str> {
    path.strip_prefix(&format!("v1/universes/{universe}/operations/metrics/"))
        .filter(|id| (1..=256).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'))
        .ok_or_else(|| AppError::Roblox("unrecognized analytics operation".into()))
}

#[tauri::command]
pub async fn creator_analytics_metrics(universe: u64, metric: Metric, start: String, end: String) -> Result<Vec<Series>> {
    if ids([universe], 1).is_empty() { return Err(invalid("Enter a valid experience universe ID.")); }
    let (start, end) = metric_dates(&start, &end)?;
    let secret = CREATOR_KEY.lock().unwrap_or_else(|e| e.into_inner()).clone()
        .ok_or_else(|| invalid("Connect a read-only Roblox Analytics key first."))?;
    let mut key = reqwest::header::HeaderValue::from_str(secret.expose())
        .map_err(|_| invalid("Enter a valid Roblox Open Cloud API key."))?;
    key.set_sensitive(true);
    let client = client()?;
    let (name, breakdown) = metric.query();
    let url = format!("{API}/analytics-query-api/v1/universes/{universe}");
    let mut request = serde_json::json!({
        "metric": name, "granularity": "OneDay",
        "startTime": format!("{start}T00:00:00Z"), "endTime": format!("{end}T00:00:00Z")
    });
    if !breakdown.is_empty() { request["breakdown"] = serde_json::json!(breakdown); }
    let mut operation: Operation = json(client.post(format!("{url}/metrics")).header("x-api-key", key.clone()).json(&request)).await.map_err(creator_permission)?;
    for _ in 0..5 {
        if operation.done { break; }
        let id = operation_id(operation.path.as_deref().unwrap_or_default(), universe)?;
        tokio::time::sleep(Duration::from_secs(2)).await;
        operation = json(client.get(format!("{url}/operations/metrics/{id}")).header("x-api-key", key.clone()).timeout(Duration::from_secs(5))).await.map_err(creator_permission)?;
    }
    if !operation.done { return Err(AppError::Wait("Roblox is still processing this request. Try a shorter date range.".into())); }
    let mut values = operation.response.ok_or_else(|| AppError::Roblox("analytics results unavailable for this request".into()))?.values;
    if matches!(metric, Metric::NewPlayers) {
        values.retain(|series| series.breakdowns.iter().any(|field|
            field.dimension == "IsNewUser" && (field.value.eq_ignore_ascii_case("true") || field.value == "1")));
    }
    for series in &mut values {
        series.data_points.retain(|point| DateTime::parse_from_rfc3339(&point.time).is_ok());
        series.data_points.sort_by(|a, b| a.time.cmp(&b.time));
    }
    Ok(values)
}

fn creator_permission(error: AppError) -> AppError {
    match error {
        AppError::Roblox(ref status) if matches!(status.as_str(), "HTTP 401" | "HTTP 403") =>
            invalid("Roblox denied access. Check the selected experience and its read-only Analytics permission."),
        other => other,
    }
}

#[tauri::command]
pub async fn creator_analytics_export(path: String, content: String) -> Result<()> {
    let path = std::path::PathBuf::from(path);
    if !path.is_absolute() || !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("csv")) || content.len() > 2_000_000 {
        return Err(invalid("Choose a CSV file for the analytics export."));
    }
    tokio::task::spawn_blocking(move || std::fs::write(path, content).map_err(|_| AppError::Storage("Could not save the analytics CSV.".into())))
        .await.map_err(|_| AppError::Internal("Could not finish the analytics export.".into()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lookup_and_polling_stay_on_the_authorized_resource() {
        assert_eq!(place_id("https://www.roblox.com/games/123/A-game?privateServerLinkCode=example").unwrap(), Some(123));
        assert!(place_id("https://roblox.com.example.invalid/games/123").is_err());
        assert!(place_id("https://user@roblox.com/games/123").is_err());
        assert_eq!(place_id("Example game").unwrap(), None);
        assert_eq!(operation_id("v1/universes/123/operations/metrics/abc-123", 123).unwrap(), "abc-123");
        assert!(operation_id("v1/universes/124/operations/metrics/abc-123", 123).is_err());
        assert!(operation_id("v1/universes/123/operations/metrics/../../private", 123).is_err());
    }
    #[test]
    fn empty_metrics_and_missing_public_counts_stay_missing() {
        let snapshot: Rows<PublicGame> = serde_json::from_str(r#"{"data":[{"id":1,"rootPlaceId":2,"name":"Test","creator":{"id":1,"type":"Group","name":"Fixture"},"visits":0}]}"#).unwrap();
        assert!(snapshot.data[0].playing.is_none());
        assert_eq!(snapshot.data[0].visits, Some(0));
        let payload: Operation = serde_json::from_str(r#"{"done":true,"response":{"values":[]}}"#).unwrap();
        assert!(payload.response.unwrap().values.is_empty());
        assert!(metric_dates("2026-10-10", "2026-10-01").is_err());
        assert!(metric_dates("2010-01-01", "2026-10-01").is_err());
        assert_eq!(ids([12, 12, 0, u64::MAX, 42], 4), vec![12, 42]);
    }

    #[tokio::test]
    #[ignore = "uses the public Roblox service; no account credentials required"]
    async fn official_public_analytics_and_creator_permission_denial() {
        let game = public_analytics_search("https://www.roblox.com/games/4924922222/Brookhaven".into()).await.unwrap();
        assert!(game.games.iter().any(|r| r.universe_id == 1686885941 && r.playing.is_some() &&
            r.visits.is_some() && r.favorites.is_some() && r.likes.is_some() &&
            r.icon.is_some() && r.thumbnail.is_some()));
        assert!(!public_analytics_search("Brookhaven".into()).await.unwrap().games.is_empty());
        assert!(!public_analytics_trending().await.unwrap().games.is_empty());
        let discovery = public_discovery().await.unwrap();
        assert!(!discovery.trending.is_empty() && !discovery.popular.is_empty() && !discovery.rising.is_empty());
        assert!(discovery.snapshot.games.iter().any(|game| game.playing.is_some() && game.created.is_some()));
        let similar = public_similar_games(game.games[0].universe_id).await.unwrap();
        assert!(similar.games.iter().all(|candidate| candidate.universe_id != game.games[0].universe_id));
        let extras = public_game_extras(game.games[0].universe_id).await.unwrap();
        assert!(extras.passes.is_some_and(|rows| !rows.is_empty()));
        assert!(extras.badges.is_some() && !extras.thumbnails.is_empty());
        let creator = &game.games[0].creator;
        assert!(!public_analytics_studio(creator.id.unwrap(), creator.kind.as_deref() == Some("Group")).await.unwrap().games.is_empty());

        let end = DateTime::<Utc>::from(SystemTime::now()).date_naive();
        let start = end.pred_opt().unwrap().to_string();
        let end = end.to_string();
        creator_analytics_disconnect();
        let error = creator_analytics_metrics(1686885941, Metric::Active, start.clone(), end.clone()).await.err().unwrap();
        assert!(error.to_string().contains("Connect"));
        creator_analytics_connect("fixture-key-not-authorized-to-read".into()).unwrap();
        let result = creator_analytics_metrics(1686885941, Metric::Active, start, end).await;
        creator_analytics_disconnect();
        assert!(result.err().unwrap().to_string().contains("denied access"));
    }
}
