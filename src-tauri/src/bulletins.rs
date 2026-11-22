use serde::{Deserialize, Serialize};
use ts_rs::TS;

const ANNOUNCEMENTS: &str = "https://devforum.roblox.com/c/updates/announcements/36.json";
const RELEASE_NOTES: &str = "https://devforum.roblox.com/c/updates/release-notes/62.json";

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BulletinSource {
    UnknownAlt,
    Roblox,
    DevForum,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Bulletin {
    id: String,
    source: BulletinSource,
    title: String,
    summary: String,
    url: String,
    published: String,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Bulletins {
    items: Vec<Bulletin>,
    unavailable: Vec<BulletinSource>,
}

#[derive(Deserialize)]
struct PublicChannel {
    owner: String,
    repository: String,
    visibility: String,
}

fn public_channel() -> Option<PublicChannel> {
    let channel: PublicChannel =
        serde_json::from_str(include_str!("../update-channel.json")).ok()?;
    let valid = |s: &str| {
        !s.is_empty()
            && s.len() < 100
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
            && !matches!(s, "." | "..")
    };
    (channel.visibility == "public" && valid(&channel.owner) && valid(&channel.repository))
        .then_some(channel)
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    body: Option<String>,
    published_at: Option<String>,
    draft: bool,
    prerelease: bool,
}

fn releases(raw: &str, channel: &PublicChannel) -> Option<Vec<Bulletin>> {
    let list: Vec<Release> = serde_json::from_str(raw).ok()?;
    Some(
        list.into_iter()
            .filter_map(|r| {
                let version = r.tag_name.strip_prefix('v')?;
                let components: Vec<_> = version.split('.').collect();
                if r.draft
                    || r.prerelease
                    || components.len() != 3
                    || !components
                        .iter()
                        .all(|s| s.parse::<u32>().is_ok() && s.bytes().all(|c| c.is_ascii_digit()))
                {
                    return None;
                }
                Some(Bulletin {
                    id: format!("unknownalt:{version}"),
                    source: BulletinSource::UnknownAlt,
                    title: format!("Unknown alt {version}"),
                    summary: r.body.unwrap_or_default().chars().take(20_000).collect(),
                    url: format!(
                        "https://github.com/{}/{}/releases/tag/v{version}",
                        channel.owner, channel.repository
                    ),
                    published: r.published_at?,
                })
            })
            .take(8)
            .collect(),
    )
}

#[derive(Deserialize)]
struct Category {
    topic_list: TopicList,
}
#[derive(Deserialize)]
struct TopicList {
    topics: Vec<Topic>,
}
#[derive(Deserialize)]
struct Topic {
    id: u64,
    title: String,
    slug: String,
    created_at: String,
}

fn topics(raw: &str, source: BulletinSource) -> Option<Vec<Bulletin>> {
    let mut topics = serde_json::from_str::<Category>(raw)
        .ok()?
        .topic_list
        .topics;
    topics.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Some(
        topics
            .into_iter()
            .filter(|t| !t.slug.starts_with("about-the-") && t.id > 0)
            .take(12)
            .map(|t| Bulletin {
                id: format!("devforum:{}", t.id),
                source: source.clone(),
                title: t.title.chars().take(240).collect(),
                summary: String::new(),
                url: format!("https://devforum.roblox.com/t/topic/{}", t.id),
                published: t.created_at,
            })
            .collect(),
    )
}

async fn get(client: &reqwest::Client, url: &str) -> Option<String> {
    crate::http::text("updates page", client.get(url).send().await, 2_000_000).await
}

#[tauri::command]
pub async fn update_bulletins() -> Bulletins {
    let mut feed = Bulletins {
        items: Vec::new(),
        unavailable: Vec::new(),
    };
    let Some(client) = crate::http::client("updates page") else {
        feed.unavailable = vec![
            BulletinSource::UnknownAlt,
            BulletinSource::Roblox,
            BulletinSource::DevForum,
        ];
        return feed;
    };
    let owned = async {
        let channel = public_channel()?;
        let url = format!(
            "https://api.github.com/repos/{}/{}/releases?per_page=8",
            channel.owner, channel.repository
        );
        releases(&get(&client, &url).await?, &channel)
    };
    let (app, roblox, forum) = tokio::join!(
        owned,
        get(&client, RELEASE_NOTES),
        get(&client, ANNOUNCEMENTS)
    );
    for (source, list) in [
        (BulletinSource::UnknownAlt, app),
        (
            BulletinSource::Roblox,
            roblox.and_then(|raw| topics(&raw, BulletinSource::Roblox)),
        ),
        (
            BulletinSource::DevForum,
            forum.and_then(|raw| topics(&raw, BulletinSource::DevForum)),
        ),
    ] {
        match list {
            Some(items) => feed.items.extend(items),
            None => feed.unavailable.push(source),
        }
    }
    feed.items.sort_by(|a, b| b.published.cmp(&a.published));
    let mut seen = std::collections::HashSet::new();
    feed.items.retain(|item| seen.insert(item.id.clone()));
    feed
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn editorial_inputs_cannot_choose_download_or_external_link() {
        let channel = public_channel().unwrap();
        let raw = r#"[{"tag_name":"v1.2.0","body":"notes","published_at":"2026-01-01","draft":false,"prerelease":false,"html_url":"https://example.invalid"},{"tag_name":"v1.2.1","published_at":"2026-01-01","draft":true,"prerelease":false}]"#;
        let list = releases(raw, &channel).unwrap();
        assert_eq!(list.len(), 1);
        assert!(
            list[0]
                .url
                .starts_with("https://github.com/Unknown69511/UnknownAlt/releases/tag/")
        );
        let raw = r#"{"topic_list":{"topics":[{"id":42,"title":"Test","slug":"//example.invalid","created_at":"2026-01-01"}]}}"#;
        assert_eq!(
            topics(raw, BulletinSource::Roblox).unwrap()[0].url,
            "https://devforum.roblox.com/t/topic/42"
        );
    }
}
