use serde::{Deserialize, Serialize};
use ts_rs::TS;

const ANNOUNCEMENTS: &str = "https://devforum.roblox.com/c/updates/announcements/36.rss";
const RELEASE_NOTES: &str = "https://devforum.roblox.com/c/updates/release-notes/62.rss";

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
                    title: format!("UnknownALT {version}"),
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
struct Rss {
    channel: RssChannel,
}
#[derive(Deserialize)]
struct RssChannel {
    #[serde(default)]
    item: Vec<Topic>,
}
#[derive(Deserialize)]
struct Topic {
    title: String,
    link: String,
    #[serde(rename = "pubDate")]
    published: String,
    #[serde(default)]
    description: String,
}

fn topics(raw: &str, source: BulletinSource) -> Option<Vec<Bulletin>> {
    let rss: Rss = quick_xml::de::from_str(raw).ok()?;
    Some(rss.channel.item.into_iter().filter_map(|t| {
        let url = url::Url::parse(&t.link).ok()?;
        if url.origin().ascii_serialization() != "https://devforum.roblox.com"
            || !url.username().is_empty() || url.password().is_some() {
            return None;
        }
        let mut path = url.path_segments()?;
        if path.next()? != "t" || path.next()?.starts_with("about-the-") {
            return None;
        }
        let id = path.next()?.parse::<u64>().ok().filter(|id| *id > 0)?;
        let published = chrono::DateTime::parse_from_rfc2822(&t.published)
            .ok()?.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        Some(Bulletin {
            id: format!("devforum:{id}"),
            source: source.clone(),
            title: t.title.chars().take(240).collect(),
            summary: t.description.chars().take(24_000).collect(),
            url: format!("https://devforum.roblox.com/t/topic/{id}"),
            published,
        })
    }).take(12).collect())
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
        let raw = r#"<rss><channel><item><title>Test</title><link>https://devforum.roblox.com/t/a-topic/42</link><pubDate>Thu, 01 Jan 2026 12:00:00 +0000</pubDate><description><![CDATA[<p>A release &amp; screenshot.</p>]]></description></item></channel></rss>"#;
        let decoded = topics(raw, BulletinSource::Roblox).unwrap();
        assert_eq!(decoded[0].summary, "<p>A release &amp; screenshot.</p>");
        assert_eq!(
            decoded[0].url,
            "https://devforum.roblox.com/t/topic/42"
        );
        assert!(topics(&raw.replace("devforum.roblox.com", "example.invalid"), BulletinSource::Roblox).unwrap().is_empty());
    }

    #[tokio::test]
    #[ignore = "uses signed release repository metadata and public official Roblox RSS feeds"]
    async fn official_feeds_supply_article_content() {
        let feed = update_bulletins().await;
        assert!(feed.unavailable.is_empty());
        for source in [BulletinSource::UnknownAlt, BulletinSource::Roblox, BulletinSource::DevForum] {
            assert!(feed.items.iter().any(|item|
                std::mem::discriminant(&item.source) == std::mem::discriminant(&source) &&
                !item.summary.is_empty() && !item.title.is_empty()));
        }
        let ids: std::collections::HashSet<_> = feed.items.iter().map(|item| &item.id).collect();
        assert_eq!(feed.items.len(), ids.len());
    }
}
