//! Public Roblox game discovery. Requests never use account cookies.
use std::{collections::{HashMap, HashSet}, time::SystemTime};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use url::Url;
use crate::error::{AppError, Result};

const API: &str = "https://apis.roblox.com";
const GAMES: &str = "https://games.roblox.com";
const THUMBS: &str = "https://thumbnails.roblox.com";
const PUBLIC_BATCH: usize = 50;
static CLIENT: std::sync::LazyLock<Option<reqwest::Client>> =
    std::sync::LazyLock::new(|| crate::http::client("discovery"));

fn client() -> Result<&'static reqwest::Client> {
    CLIENT.as_ref().ok_or_else(|| AppError::Network("Game discovery is unavailable.".into()))
}

fn invalid(message: &str) -> AppError { AppError::Invalid(message.into()) }

async fn json<T: DeserializeOwned>(request: reqwest::RequestBuilder) -> Result<T> {
    let sent = request.send().await.map_err(|_| AppError::Network("Could not reach Roblox.".into()))?;
    let status = sent.status().as_u16();
    if matches!(status, 401 | 403) {
        return Err(AppError::Roblox(format!("HTTP {status}")));
    }
    if status == 429 { return Err(AppError::RateLimited(60)); }
    if !sent.status().is_success() { return Err(AppError::Roblox(format!("HTTP {status}"))); }
    let raw = crate::http::text("discovery", Ok(sent), 2_000_000).await.ok_or_else(|| AppError::Network("Roblox returned an incomplete game discovery response.".into()))?;
    serde_json::from_str(&raw).map_err(|_| AppError::Roblox("unrecognized game discovery response".into()))
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
    name: Option<String>,
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

async fn game_snapshot(universes: Vec<u64>, details: bool) -> Result<PublicSnapshot> {
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
    let mut games: Vec<PublicGame> = rows.into_iter()
        .filter_map(|row| serde_json::from_value::<PublicGame>(row).ok())
        .filter(|row| universe_ids.contains(&row.universe_id)).collect();
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
pub async fn public_discovery_search(query: String) -> Result<PublicSnapshot> {
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
    game_snapshot(found, true).await
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
    let snapshot = game_snapshot(candidates, true).await?;
    Ok(Discovery { snapshot, trending, popular, rising })
}

#[tauri::command]
pub async fn public_similar_games(universe: u64) -> Result<PublicSnapshot> {
    if ids([universe], 1).is_empty() { return Err(invalid("Invalid experience universe ID.")); }
    #[derive(Deserialize)]
    struct Recommendation { games: Vec<Candidate> }
    let related: Recommendation = json(client()?.get(format!("{GAMES}/v1/games/recommendations/game/{universe}"))).await?;
    game_snapshot(ids(related.games.into_iter().filter(|g| !g.is_sponsored)
        .filter_map(|g| g.universe_id).filter(|id| *id != universe), 10), true).await
}

#[tauri::command]
pub async fn public_discovery_games(universes: Vec<u64>) -> Result<PublicSnapshot> {
    game_snapshot(ids(universes, 20), true).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameUpdate {
    universe_id: u64,
    name: String,
    updated: String,
}

#[tauri::command]
pub async fn public_discovery_updates(universes: Vec<u64>) -> Result<Vec<GameUpdate>> {
    Ok(game_snapshot(ids(universes, 20), false).await?.games.into_iter()
        .filter_map(|game| Some(GameUpdate {
            universe_id: game.universe_id,
            name: game.name,
            updated: game.updated?,
        })).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_only_accepts_public_roblox_game_links() {
        assert_eq!(place_id("https://www.roblox.com/games/123/A-game?privateServerLinkCode=example").unwrap(), Some(123));
        assert!(place_id("https://roblox.com.example.invalid/games/123").is_err());
        assert!(place_id("https://user@roblox.com/games/123").is_err());
        assert_eq!(place_id("Example game").unwrap(), None);
        assert_eq!(ids([12, 12, 0, u64::MAX, 42], 4), vec![12, 42]);
    }

    #[test]
    fn absent_player_count_stays_unknown() {
        let sample: PublicGame = serde_json::from_str(r#"{"id":1,"rootPlaceId":2,"name":"Example"}"#).unwrap();
        assert!(sample.playing.is_none());
    }

    #[tokio::test]
    #[ignore = "uses the official public Roblox service"]
    async fn public_search_catalog_and_recommendations() {
        let result = public_discovery_search("https://www.roblox.com/games/4924922222/Brookhaven".into()).await.unwrap();
        assert!(result.games.iter().any(|row| row.universe_id == 1686885941 && row.playing.is_some()));
        assert!(!public_discovery_search("Brookhaven".into()).await.unwrap().games.is_empty());
        let discovery = public_discovery().await.unwrap();
        assert!(!discovery.trending.is_empty() && !discovery.popular.is_empty());
        let related = public_similar_games(1686885941).await.unwrap();
        assert!(related.games.iter().all(|candidate| candidate.universe_id != 1686885941));
        let updates = public_discovery_updates(vec![1686885941]).await.unwrap();
        assert!(updates.iter().any(|row| row.universe_id == 1686885941 && !row.updated.is_empty()));
    }
}
