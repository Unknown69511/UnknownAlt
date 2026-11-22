import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type BulletinSource } from "../../api";
import { readStored, writeStored } from "../../ui/stored";
import { toastError } from "../../ui/Toast";
import { useOwnedUpdate } from "./OwnedUpdate";

const sources: Record<BulletinSource, string> = {
  unknownAlt: "Unknown alt releases", roblox: "Roblox release notes", devForum: "DevForum announcements",
};
const readKey = "UnknownAlt.updates.read";

function initialRead(): string[] {
  try {
    const saved: unknown = JSON.parse(readStored(readKey) ?? "[]");
    return Array.isArray(saved) ? saved.filter((v): v is string => typeof v === "string").slice(0, 500) : [];
  } catch { return []; }
}

export function UpdatesPage({ packageVersion }: { packageVersion?: string }) {
  const feed = useQuery({ queryKey: ["updateBulletins"], queryFn: api.updateBulletins, staleTime: 15 * 60_000, refetchOnWindowFocus: false, retry: false });
  const [source, filter] = useState<BulletinSource | "all">("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [read, setRead] = useState(initialRead);
  const list = (feed.data?.items ?? []).filter((item) => source === "all" || item.source === source);
  const markRead = (ids: string[]) => {
    const next = [...new Set([...ids, ...read])].slice(0, 500);
    setRead(next);
    writeStored(readKey, JSON.stringify(next));
  };
  return <main className="flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-3">
    <h1 className="text-xl font-semibold">Updates</h1>
    {packageVersion ? <p>Installed {packageVersion} · Install new builds from the official Unknown alt release page.</p> : <InstallPanel />}
    <div className="flex flex-wrap gap-2 items-center">
      <select className="field" aria-label="Update source" value={source} onChange={(e) => filter(e.target.value as typeof source)}>
        <option value="all">All sources</option>
        {Object.entries(sources).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
      <label><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only</label>
      <button className="btn btn-sm" onClick={() => markRead(list.map((item) => item.id))}>Mark shown as read</button>
      <button className="btn btn-sm" disabled={feed.isFetching} onClick={() => void feed.refetch()}>Refresh feeds</button>
    </div>
    {feed.isFetching && <p role="status">Checking feeds…</p>}
    {feed.error && <p role="alert">Could not load updates.</p>}
    {feed.data?.unavailable.map((id) => <p key={id} className="text-fg-2">{sources[id]} are temporarily unavailable.</p>)}
    {list.filter((item) => !unreadOnly || !read.includes(item.id)).map((item) => (
      <article className="panel p-3 space-y-2" key={item.id}>
        <p className="text-xs text-fg-2">{sources[item.source]} · {item.published.slice(0, 10)}{read.includes(item.id) ? "" : " · Unread"}</p>
        <h2 className="font-semibold">{item.title}</h2>
        {item.summary && <details onToggle={(e) => { if (e.currentTarget.open && !read.includes(item.id)) markRead([item.id]); }}>
          <summary>Changelog</summary><p className="whitespace-pre-wrap break-words mt-2">{item.summary}</p>
        </details>}
        <button className="btn btn-sm" onClick={() => { markRead([item.id]); openUrl(item.url).catch(toastError); }}>Open source</button>
      </article>
    ))}
    {feed.data && !list.some((item) => !unreadOnly || !read.includes(item.id)) && <p>No updates match this filter.</p>}
  </main>;
}

function InstallPanel() {
  const update = useOwnedUpdate();
  const status = update.status;
  const label = status?.state === "installing" ? "Installing…" : status?.state === "verifying" ? "Verifying…" :
    status?.state === "downloading" ? "Downloading…" : update.checking ? "Checking…" :
    status?.available ? `Version ${status.available} is available` : "Check for a signed Unknown alt update";
  if (status?.configured === false) return <p role="status">{status.error ?? "Updates are unavailable for this package."}</p>;
  return <section className="panel p-3 flex items-center flex-wrap gap-3">
    <p role="status">Installed {status?.current ?? "—"} · {label}</p>
    {status?.state === "downloading" && <progress aria-label="Download progress" value={status.total ? status.downloaded : undefined} max={status.total ?? undefined} />}
    <button className="btn btn-primary" disabled={update.busy} onClick={update.start}>{status?.available ? "Install update" : "Check for updates"}</button>
    {status?.error && <p role="status">{status.error}</p>}
  </section>;
}
