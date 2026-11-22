import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type Bulletin, type Bulletins, type BulletinSource } from "../../api";
import { readStored, writeStored } from "../../ui/stored";
import { toastError } from "../../ui/Toast";
import { useOwnedUpdate } from "./OwnedUpdate";
import { Announcement } from "./Announcement";
import { notify } from "../notifications/store";

const sources: Record<BulletinSource, string> = {
  unknownAlt: "UnknownALT", roblox: "Roblox", devForum: "DevForum",
};
const readKey = "UnknownAlt.updates.read";
const cacheKey = "UnknownAlt.updates.cache.v1";
const refreshEvery = 15 * 60_000;
const categories = ["all", "roblox", "devForum", "unknownAlt"] as const;

function cachedFeed(): Bulletins | undefined {
  try {
    const cached = JSON.parse(readStored(cacheKey) ?? "null") as Bulletin[] | null;
    if (!Array.isArray(cached)) return undefined;
    return { items: cached.filter((row) => row && Object.hasOwn(sources, row.source) &&
      [row.id, row.title, row.published, row.summary, row.url].every((value) => typeof value === "string") &&
      /^https:\/\/(?:devforum\.roblox\.com\/t\/topic\/\d+|github\.com\/Unknown69511\/UnknownAlt\/releases\/tag\/v[\d.]+)$/.test(row.url)),
      unavailable: [...categories.slice(1)] as BulletinSource[] };
  } catch { return undefined; }
}

async function refreshFeed(): Promise<Bulletins> {
  const incoming = await api.updateBulletins();
  const previous = cachedFeed()?.items ?? [];
  const items = new Map(incoming.items.map((item) => [item.url, item]));
  for (const item of previous) {
    if (incoming.unavailable.includes(item.source) && !items.has(item.url)) items.set(item.url, item);
  }
  const published = previous.filter((item) => item.source !== "unknownAlt").reduce((latest, item) => item.published > latest ? item.published : latest, "");
  const next = [...items.values()].sort((a, b) => b.published.localeCompare(a.published));
  if (published) for (const item of next.filter((row) => row.source !== "unknownAlt" && row.published > published && !previous.some((old) => old.id === row.id)).slice(0, 3)) {
    notify("announcements", item.id, item.title, { view: "updates", bulletin: item.id });
  }
  writeStored(cacheKey, JSON.stringify(next));
  return { items: next, unavailable: incoming.unavailable };
}

function initialRead(): string[] {
  try {
    const saved: unknown = JSON.parse(readStored(readKey) ?? "[]");
    return Array.isArray(saved) ? saved.filter((v): v is string => typeof v === "string").slice(0, 500) : [];
  } catch { return []; }
}

export function useAnnouncementFeed(enabled = true) {
  return useQuery({ queryKey: ["updateBulletins"], enabled, queryFn: refreshFeed, placeholderData: cachedFeed,
    staleTime: refreshEvery, refetchInterval: refreshEvery, refetchIntervalInBackground: true, retry: false });
}

export function UpdatesPage({ packageVersion, openedBulletin }: { packageVersion?: string; openedBulletin?: string }) {
  const feed = useAnnouncementFeed();
  const [source, filter] = useState<BulletinSource | "all">("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [read, setRead] = useState(initialRead);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  useEffect(() => {
    if (openedBulletin) {
      filter("all");
      setUnreadOnly(false);
      setTerm("");
      setExpanded(openedBulletin);
    }
  }, [openedBulletin]);
  const list = (feed.data?.items ?? []).filter((item) => source === "all" || item.source === source);
  const shown = list.filter((item) => (!unreadOnly || !read.includes(item.id) || expanded === item.id) &&
    item.title.toLocaleLowerCase().includes(term.trim().toLocaleLowerCase()));
  const markRead = (ids: string[]) => {
    setRead((old) => {
      const next = [...new Set([...ids, ...old])].slice(0, 500);
      writeStored(readKey, JSON.stringify(next));
      return next;
    });
  };
  return <main className="flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-3">
    <h1 className="text-xl font-semibold">Updates</h1>
    {packageVersion ? <p>Installed {packageVersion} · Install new builds from the official UnknownALT release page.</p> : <InstallPanel />}
    <div className="flex flex-wrap gap-2" role="group" aria-label="Announcement categories">
      {categories.map((id) => {
        const unread = (feed.data?.items ?? []).filter((item) => (id === "all" || item.source === id) && !read.includes(item.id)).length;
        return <button key={id} className={source === id ? "btn btn-primary" : "btn"} aria-pressed={source === id}
          onClick={() => { filter(id); setExpanded(null); }}>{id === "all" ? "All" : sources[id]}{unread > 0 && <span className="text-xs tabular-nums">{unread}</span>}</button>;
      })}
    </div>
    <div className="flex flex-wrap gap-3 items-center">
      <input type="search" className="field" aria-label="Filter announcements by title" placeholder="Filter by title" value={term} onChange={(e) => setTerm(e.target.value)} />
      <label><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only</label>
      <button className="btn btn-sm" disabled={!shown.some((item) => !read.includes(item.id))} onClick={() => markRead(shown.map((item) => item.id))}>Mark shown as read</button>
      <button className="btn btn-sm" disabled={feed.isFetching} onClick={() => void feed.refetch()}>Refresh feeds</button>
    </div>
    {feed.isFetching && <p role="status">Checking feeds…</p>}
    {feed.error && <p role="alert">Could not load updates.</p>}
    {!feed.isFetching && feed.data?.unavailable.length ? <p className="text-fg-2" role="status">Could not refresh {feed.data.unavailable.map((id) => sources[id]).join(", ")}. Showing saved announcements where available.</p> : null}
    {shown.map((item) => (
      <article className="panel p-4 space-y-3" key={item.id} ref={openedBulletin === item.id && expanded === item.id ?
        (node) => { if (node) requestAnimationFrame(() => node.scrollIntoView({ block: "nearest" })); } : undefined}>
        <p className="text-xs text-fg-2">{sources[item.source]} · <time dateTime={item.published}>{item.published.slice(0, 10)}</time>{read.includes(item.id) ? "" : " · Unread"}</p>
        <h2 className="font-semibold">
          <button className="text-left w-full" aria-expanded={expanded === item.id} onClick={() => {
            setExpanded(expanded === item.id ? null : item.id);
            if (!read.includes(item.id)) markRead([item.id]);
          }}>{item.title}</button>
        </h2>
        {expanded === item.id && <Announcement item={item} />}
        <div className="flex gap-2 flex-wrap">
          <button className="btn btn-sm" aria-expanded={expanded === item.id} onClick={() => {
            setExpanded(expanded === item.id ? null : item.id);
            if (!read.includes(item.id)) markRead([item.id]);
          }}>{expanded === item.id ? "Collapse" : "Read announcement"}</button>
          <button className="btn btn-sm" onClick={() => { markRead([item.id]); void openUrl(item.url).catch(toastError); }}>Open original</button>
        </div>
      </article>
    ))}
    {feed.data && !shown.length && <p>No announcements match this filter.</p>}
  </main>;
}

function InstallPanel() {
  const update = useOwnedUpdate();
  const status = update.status;
  const label = status?.state === "installing" ? "Installing…" : status?.state === "verifying" ? "Verifying…" :
    status?.state === "downloading" ? "Downloading…" : update.checking ? "Checking…" :
    status?.available ? `Version ${status.available} is available` : "Check for a signed UnknownALT update";
  if (status?.configured === false) return <p role="status">{status.error ?? "Updates are unavailable for this package."}</p>;
  return <section className="panel p-3 flex items-center flex-wrap gap-3">
    <p role="status">Installed {status?.current ?? "—"} · {label}</p>
    {status?.state === "downloading" && <progress aria-label="Download progress" value={status.total ? status.downloaded : undefined} max={status.total ?? undefined} />}
    <button className="btn btn-primary" disabled={update.busy} onClick={update.start}>{status?.available ? "Install update" : "Check for updates"}</button>
    {status?.error && <p role="status">{status.error}</p>}
  </section>;
}
