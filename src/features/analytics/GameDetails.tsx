import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../../api";
import { playTarget } from "../../app/navigation";
import { Icon } from "../../ui/Icon";
import { toast, toastError } from "../../ui/Toast";
import { RelatedGames } from "../discover/RelatedGames";
import { approval, category, count } from "../discover/catalog";
import { GameHistory, GameMarketStats, historicalUpdates } from "./GameHistory";
import { STATS, at, measurements, number, useArchive } from "./archive";
import { Source } from "./Platform";
import { FollowButton, ObservedUpdates } from "./GameUpdateTracker";
import { record, trackGame, useAnalyticsStore } from "./store";
import { StudioList } from "./StudioList";
import "./analytics.css";

function shortDate(value?: string | null) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? new Date(time).toLocaleDateString() : "Unavailable";
}

function openRoblox(path: string) { void openUrl(`https://www.roblox.com/${path}`).catch(toastError); }

export function GameDetails({ id, select, back }: { id: number; select: (id: number) => void; back: () => void }) {
  const { records, watch } = useAnalyticsStore();
  const [comparison, setComparison] = useState<number[]>([]);
  const [selectedUpdate, setSelectedUpdate] = useState<string>();
  const [showStudio, setShowStudio] = useState(false);
  const profile = useArchive("gameProfile", id);
  const series = useArchive("gameSeries", id);
  const daily = useArchive("gameDaily", id);
  const ids = [id, ...comparison];
  const stats = useQuery({
    queryKey: ["analyticsLive", ids], staleTime: 45_000, refetchInterval: 45_000, retry: false,
    queryFn: async () => {
      const snapshot = await api.publicAnalyticsSnapshot(ids, false);
      record(snapshot, false);
      return snapshot;
    },
  });
  const media = useQuery({
    queryKey: ["analyticsMedia", id], staleTime: 300_000, refetchInterval: 300_000, retry: false,
    queryFn: async () => {
      const snapshot = await api.publicAnalyticsSnapshot([id], true);
      record(snapshot, true);
      return snapshot;
    },
  });
  const extras = useQuery({ queryKey: ["publicGameExtras", id], queryFn: () => api.publicGameExtras(id), staleTime: 15 * 60_000, retry: false });
  const row = records[id];
  const game = row?.game ?? stats.data?.games.find((item) => item.universeId === id) ?? media.data?.games[0];
  if (!game) return <section className="panel p-4 space-y-3">
    <button className="btn btn-sm" onClick={back}>Back to games</button>
    <p role="status">{stats.isFetching || media.isFetching ? "Loading Roblox game…" : "Public details for this game are unavailable."}</p>
    {stats.isError && <button className="btn" onClick={() => void stats.refetch()}>Retry</button>}
  </section>;
  const rating = approval(game);
  const thumbs = [...new Set([game.thumbnail, ...(extras.data?.thumbnails ?? [])].filter((url): url is string => !!url))];
  const checked = row?.observedAt ?? stats.data?.observedAt ?? media.data?.observedAt;
  const stale = !!checked && (stats.isError || Date.now() - checked > 180_000);
  const watching = watch.includes(id);
  const updates = historicalUpdates([profile.data?.updates, series.data?.updates], [...row?.updates ?? [], game.updated]);
  const recent = measurements(series.data?.hours, (item) => item.t, (item) => item.v, "RobloxGameStats");
  const recentTimes = new Set(recent.map((point) => Math.floor(point.at / 3_600_000)));
  const readings = [...recent.map((p) => ({ at: p.at, players: p.value })),
    ...(row?.samples ?? []).filter((p) => !recentTimes.has(Math.floor(p.at / 3_600_000)))].sort((a, b) => a.at - b.at);
  const milestones = (profile.data?.milestones ?? []).flatMap((entry) => {
    const date = at(entry.at);
    const value = number(entry.value);
    return date != null && value != null ? [{ date, value }] : [];
  }).sort((a, b) => b.date - a.date);
  return <div className="space-y-4">
    <button className="btn btn-sm" onClick={back}>Back to games</button>
    <section className="panel analytics-hero p-4 space-y-4">
      <div className="flex items-center flex-wrap gap-4">
        {game.icon && <img src={game.icon} alt="" width={76} height={76} className="rounded-xl" />}
        <div className="flex-1 min-w-48"><h2 className="text-2xl font-semibold">{game.name}</h2>
          <p className="text-sm text-fg-2">{[game.creator.name, category(game), game.subgenre].filter(Boolean).join(" · ") || "Creator and genre unavailable"}</p></div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" onClick={() => {
            if ("__UNKNOWNALT_PORTABLE__" in window) openRoblox(`games/${game.rootPlaceId}`);
            else playTarget({ kind: "place", placeId: game.rootPlaceId, launchData: null });
          }}><Icon name="play" />Play</button>
          <button className="btn" aria-pressed={watching} onClick={() => { if (!trackGame(id)) toast("The watchlist holds up to 20 games."); }}><Icon name="star" fill={watching} />{watching ? "Watching" : "Watchlist"}</button>
          <FollowButton id={id} />
        </div>
      </div>
      <dl className="grid grid-cols-2 lg:grid-cols-6 gap-2 text-sm">
        {[["Live players", count(game.playing)], ["Visits", count(game.visits)], ["Favorites", count(game.favorites)],
          ["Approval", rating == null ? "Unavailable" : `${(rating * 100).toFixed(1)}%`], ["Created", shortDate(game.created)], ["Updated", shortDate(game.updated)]].map(([label, value]) =>
          <div key={label} className="border border-line rounded-lg p-2"><dt className="text-fg-2">{label}</dt><dd className="font-semibold">{value}</dd></div>)}
      </dl>
      {checked && <p className="text-xs text-fg-2">{stale ? "Last saved snapshot" : "Roblox snapshot"} · {new Date(checked).toLocaleString()}</p>}
    </section>
    <GameHistory game={game} comparison={comparison} setComparison={setComparison} records={records}
      updates={updates} selectedUpdate={selectedUpdate} selectUpdate={setSelectedUpdate} />
    <GameMarketStats id={id} />
    {game.creator.id && (game.creator.kind === "Group" || game.creator.kind === "User") && <section className="panel analytics-market-card">
      <header className="analytics-panel-heading"><div><h2>{game.creator.name || "Creator"}</h2><p className="text-sm text-fg-2">Public Roblox portfolio</p></div>
        <button className="btn btn-sm" aria-expanded={showStudio} onClick={() => setShowStudio(!showStudio)}>{showStudio ? "Hide games" : "Show creator's games"}</button>
      </header>
      {showStudio && <StudioList creators={[game.creator]} select={select} expanded />}
    </section>}
    <section className="panel p-4 space-y-3">
      <RelatedGames game={game} select={(related) => select(related.universeId)} compare={(related) => setComparison((current) =>
        current.includes(related.universeId) ? current : [...current, related.universeId].slice(-3))} />
    </section>
    <section className="panel analytics-market-card">
      <header className="analytics-panel-heading"><div><h2>Update History</h2><p className="text-sm text-fg-2">Roblox timestamps and public archive records.</p></div></header>
      <ObservedUpdates game={game} samples={readings} updates={updates} selected={selectedUpdate} onSelect={setSelectedUpdate} daily={daily.data ?? []} />
      <Source url={`${STATS}/game/${id}`}>RobloxGameStats</Source>
    </section>
    {!!milestones.length && <section className="panel analytics-market-card">
      <header className="analytics-panel-heading"><h2>Visit Milestones</h2></header>
      <ul className="analytics-ranked">{milestones.map(({ date, value }) => <li key={`${date}:${value}`} className="p-2">
        {count(value)} visits · {shortDate(new Date(date).toISOString())}
      </li>)}</ul>
      <Source url={`${STATS}/game/${id}`}>RobloxGameStats</Source>
    </section>}
    <section className="grid gap-3 lg:grid-cols-2">
      <div className="panel p-4 space-y-3"><h3 className="font-semibold">Game passes</h3>
        {!extras.data?.passes?.length && <p className="text-sm text-fg-2">{extras.isPending ? "Loading passes…" : extras.data?.passes ? "Roblox returned no passes." : "Public passes unavailable."}</p>}
        {extras.data?.passes?.map((item) => <button className="flex gap-3 text-start w-full justify-between py-2 border-b border-line" key={item.id} onClick={() => openRoblox(`game-pass/${item.id}`)}>
          {item.displayName || item.name}<span className="text-sm text-fg-2 shrink-0">{item.price != null ? `${count(item.price)} Robux` : item.isForSale === false ? "Off sale" : "View on Roblox"}</span></button>)}
      </div>
      <div className="panel p-4 space-y-3"><h3 className="font-semibold">Badges</h3>
        {!extras.data?.badges?.length && <p className="text-sm text-fg-2">{extras.isPending ? "Loading badges…" : extras.data?.badges ? "Roblox returned no badges." : "Public badges unavailable."}</p>}
        {extras.data?.badges?.map((item) => <button className="block text-start w-full py-2 border-b border-line" key={item.id} onClick={() => openRoblox(`badges/${item.id}`)}>
          <span className="block">{item.name}</span>{item.description && <span className="text-sm text-fg-2 line-clamp-2">{item.description}</span>}</button>)}
      </div>
    </section>
    {thumbs.length > 0 && <section className="panel p-4 space-y-3"><h3 className="font-semibold">Thumbnails</h3><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {thumbs.map((url) => <img key={url} className="aspect-video w-full object-cover rounded-lg" src={url} alt="" loading="lazy" />)}
    </div></section>}
  </div>;
}
