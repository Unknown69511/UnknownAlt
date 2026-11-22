import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../../api";
import { playTarget } from "../../app/navigation";
import { Icon } from "../../ui/Icon";
import { toast, toastError } from "../../ui/Toast";
import { RelatedGames } from "../discover/RelatedGames";
import { approval, category, count } from "../discover/catalog";
import { GameHistory, GameMarketStats, historicalUpdates } from "./GameHistory";
import { STATS, at, number, useArchive } from "./archive";
import { DailyHistoryTable, GameMediaHistory } from "./GameArchivePanels";
import { useGameTimelines } from "./useGameTimelines";
import { Source } from "./Platform";
import { FollowButton, ObservedUpdates } from "./GameUpdateTracker";
import { record, recordThumbnails, trackGame, useAnalyticsStore } from "./store";
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
  const [includeVisits, setIncludeVisits] = useState(false);
  const loadVisits = () => {
    if (!includeVisits) setIncludeVisits(true);
    else if (history.primaryVisits.isError) void history.primaryVisits.refetch({ cancelRefetch: false });
  };
  const profile = useArchive("gameProfile", id);
  const ids = [...new Set([id, ...comparison])];
  const stats = useQuery({
    queryKey: ["analyticsLive", ids], staleTime: 45_000, refetchInterval: 45_000, retry: false,
    queryFn: async ({ signal }) => {
      const snapshot = await api.publicAnalyticsSnapshot(ids, false);
      signal.throwIfAborted();
      record(snapshot, false);
      return snapshot;
    },
  });
  const media = useQuery({
    queryKey: ["analyticsMedia", id], staleTime: 300_000, refetchInterval: 300_000, retry: false,
    queryFn: async ({ signal }) => {
      const snapshot = await api.publicAnalyticsSnapshot([id], true);
      signal.throwIfAborted();
      record(snapshot, true);
      return snapshot;
    },
  });
  const extras = useQuery({ queryKey: ["publicGameExtras", id], staleTime: 15 * 60_000, retry: false, queryFn: async ({ signal }) => {
    const observedAt = Date.now();
    const data = await api.publicGameExtras(id);
    signal.throwIfAborted();
    return { ...data, observedAt };
  } });
  const row = records[id];
  const game = row?.game ?? stats.data?.games.find((item) => item.universeId === id) ?? media.data?.games[0];
  const history = useGameTimelines(game, ids, records, includeVisits);
  const timeline = history.timelines[0];
  const hasGame = !!game;
  useEffect(() => {
    if (hasGame && extras.data?.thumbnails.length) recordThumbnails(id, extras.data.thumbnails, extras.data.observedAt);
  }, [hasGame, extras.data, id]);
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
  const updates = historicalUpdates([profile.data?.updates, ...history.providerUpdates], [...row?.updates ?? [], game.updated])
    .filter((update) => Date.parse(update) >= (at(game.created) ?? 0) && Date.parse(update) <= Date.now());
  const readings = timeline.hourly.map((p) => ({ at: p.at, players: p.value }));
  const milestones = (profile.data?.milestones ?? []).flatMap((entry) => {
    const date = at(entry.at);
    const value = number(entry.value);
    return date != null && value != null ? [{ date, value, kind: "visits" }] : [];
  });
  let highest = -1;
  for (const day of timeline.daily) {
    if (day.high == null || day.high <= highest) continue;
    if (highest >= 0) milestones.push({ date: day.at, value: day.high, kind: "player record" });
    highest = day.high;
  }
  milestones.sort((a, b) => b.date - a.date);
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
        {[[stale ? "Last recorded players" : "Live players", count(game.playing)], ["Visits", count(game.visits)], ["Favorites", count(game.favorites)],
          ["Approval", rating == null ? "Unavailable" : `${(rating * 100).toFixed(1)}%`], ["Created", shortDate(game.created)], ["Updated", shortDate(game.updated)]].map(([label, value]) =>
          <div key={label} className="border border-line rounded-lg p-2"><dt className="text-fg-2">{label}</dt><dd className="font-semibold">{value}</dd></div>)}
      </dl>
      {checked && <p className="text-xs text-fg-2">{stale ? "Last saved snapshot" : "Roblox snapshot"} · {new Date(checked).toLocaleString()}</p>}
    </section>
    <GameMarketStats id={id} timeline={timeline} />
    <GameHistory game={game} ids={ids} history={history} setComparison={setComparison} records={records}
      updates={updates} selectedUpdate={selectedUpdate} selectUpdate={setSelectedUpdate} loadVisits={loadVisits} />
    <DailyHistoryTable game={game} days={timeline.daily} loadVisits={loadVisits} visitStatus={includeVisits ? history.primaryVisits.status : undefined} />
    {game.creator.id && (game.creator.kind === "Group" || game.creator.kind === "User") && <section className="panel analytics-market-card">
      <header className="analytics-panel-heading"><div><h2>{game.creator.name || "Creator"}</h2><p className="text-sm text-fg-2">Public Roblox portfolio</p></div>
        <button className="btn btn-sm" aria-expanded={showStudio} onClick={() => setShowStudio(!showStudio)}>{showStudio ? "Hide games" : "Show creator's games"}</button>
      </header>
      {showStudio && <StudioList creators={[game.creator]} select={select} expanded />}
    </section>}
    <section className="panel p-4 space-y-3">
      <RelatedGames game={game} select={(related) => select(related.universeId)} compare={(related) => setComparison((current) =>
        related.universeId === id || current.includes(related.universeId) ? current : [...current, related.universeId].slice(-3))} />
    </section>
    <section className="panel analytics-market-card">
      <header className="analytics-panel-heading"><div><h2>Update History</h2><p className="text-sm text-fg-2">Roblox timestamps and public archive records.</p></div></header>
      <ObservedUpdates game={game} samples={readings} updates={updates} selected={selectedUpdate} onSelect={setSelectedUpdate} daily={timeline.daily} />
      <Source url={`${STATS}/game/${id}`}>RobloxGameStats</Source>
    </section>
    {!!milestones.length && <section className="panel analytics-market-card">
      <header className="analytics-panel-heading"><div><h2>Historical Milestones</h2>
        <p className="text-sm text-fg-2">Visit milestones and new peaks within the available daily archive.</p></div></header>
      <ul className="analytics-ranked">{milestones.slice(0, 12).map(({ date, value, kind }) => <li key={`${date}:${value}:${kind}`} className="p-2">
        {count(value)} {kind === "visits" ? "visits" : "players · new recorded high"} · {shortDate(new Date(date).toISOString())}
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
    <GameMediaHistory current={thumbs} record={row} />
  </div>;
}
