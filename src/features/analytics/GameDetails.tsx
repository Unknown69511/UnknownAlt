import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../../api";
import { playTarget } from "../../app/navigation";
import { Icon } from "../../ui/Icon";
import { toast, toastError } from "../../ui/Toast";
import { RelatedGames } from "../discover/RelatedGames";
import { approval, category, count, percent, useGameSearch } from "../discover/catalog";
import { saveAnalyticsCsv } from "./csv";
import { FollowButton, ObservedUpdates } from "./GameUpdateTracker";
import { HistoryChart, type Sample, type Series } from "./HistoryChart";
import { HOUR, summary } from "./history";
import { record, trackGame, useAnalyticsStore, type GameRecord } from "./store";
import { StudioList } from "./StudioList";
import type { PublicGame } from "./types";
import "./analytics.css";

const DAY = 24 * HOUR;
const ranges = [["Live", 15 * 60_000], ["1H", HOUR], ["6H", 6 * HOUR], ["1D", DAY], ["1W", 7 * DAY],
  ["1M", 30 * DAY], ["1Y", 365 * DAY], ["All time", Infinity]] as const;
const metricLabels = { players: "Players", visits: "Visits", favorites: "Favorites", likes: "Likes", approval: "Approval" };
type Metric = keyof typeof metricLabels;

function seriesFor(row: GameRecord | undefined, metric: Metric): Sample[] {
  if (metric === "players") return (row?.samples ?? []).map((sample) => ({ at: sample.at, value: sample.players }));
  return (row?.totals ?? []).flatMap((sample) => sample[metric] == null ? [] : [{ at: sample.at, value: sample[metric] }]);
}

function shortDate(value?: string | null) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? new Date(time).toLocaleDateString() : "Unavailable";
}

function openRoblox(path: string) { void openUrl(`https://www.roblox.com/${path}`).catch(toastError); }

export function GameDetails({ id, select, back }: { id: number; select: (id: number) => void; back: () => void }) {
  const { records, watch } = useAnalyticsStore();
  const [comparison, setComparison] = useState<number[]>([]);
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
    <PlayerChart game={game} row={row} comparison={comparison} setComparison={setComparison} records={records} />
    <section className="panel p-4 space-y-3">
      <RelatedGames game={game} select={(related) => select(related.universeId)} compare={(related) => setComparison((current) =>
        current.includes(related.universeId) ? current : [...current, related.universeId].slice(-3))} />
    </section>
    {row && <section className="panel p-4 space-y-3"><h3 className="font-semibold">Update history</h3><ObservedUpdates {...row} /></section>}
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

function PlayerChart({ game, row, comparison, setComparison, records }: { game: PublicGame; row?: GameRecord;
  comparison: number[]; setComparison: (update: (current: number[]) => number[]) => void; records: Record<number, GameRecord> }) {
  const [range, chooseRange] = useState(3);
  const [metric, chooseMetric] = useState<Metric>("players");
  const [week, setWeek] = useState(false);
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  const search = useGameSearch(term);
  const to = Date.now();
  const source = seriesFor(row, metric);
  const from = ranges[range][1] === Infinity ? Math.min(source[0]?.at ?? to - DAY, to - HOUR) : to - ranges[range][1];
  const inside = (point: Sample) => point.at >= from && point.at <= to;
  const points = source.filter(inside);
  const stats = summary(points.map((point) => point.value));
  const traces: Series[] = [{ label: game.name, points }];
  if (week) traces.push({ label: "Previous week", dashed: true,
    points: source.map((point) => ({ ...point, at: point.at + 7 * DAY, observedAt: point.at })).filter(inside) });
  for (const id of comparison) traces.push({ label: records[id]?.game.name ?? `Game ${id}`, points: seriesFor(records[id], metric).filter(inside) });
  const format = (value: number) => metric === "approval" ? `${value.toFixed(2)}%` : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const stat = (value: number | null) => value == null ? "Unavailable" : format(value);
  const compareGame = (id: number) => setComparison((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id].slice(-3));
  return <section className="panel p-4 space-y-4">
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <h3 className="font-semibold">Player and engagement history</h3>
      <button className="btn btn-sm" disabled={!traces.some((trace) => trace.points.length)} onClick={() => void saveAnalyticsCsv(
        `UnknownALT-${game.universeId}-${metric}.csv`, ["game", "metric", "observed_at_utc", "value"], traces.flatMap((trace) =>
          trace.points.map((point) => [trace.label, metric, new Date(point.observedAt ?? point.at).toISOString(), point.value]))).catch(toastError)}><Icon name="download" />Export CSV</button>
    </div>
    <div className="flex flex-wrap gap-2 items-center">
      <select className="field max-w-36" aria-label="Chart metric" value={metric} onChange={(event) => chooseMetric(event.target.value as Metric)}>
        {Object.entries(metricLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
      <div className="flex gap-1 flex-wrap" role="group" aria-label="Chart range">{ranges.map(([label], i) => <button key={label} className={i === range ? "btn btn-sm btn-primary" : "btn btn-sm"} aria-pressed={range === i} onClick={() => chooseRange(i)}>{label}</button>)}</div>
      <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={week} onChange={(event) => setWeek(event.target.checked)} />Previous week</label>
    </div>
    <HistoryChart key={`${metric}:${range}`} points={points} from={from} to={to} format={format} series={traces.length > 1 ? traces : undefined}
      size="large" gap={range < 4 ? 25 * 60_000 : range < 6 ? 3 * HOUR : 8 * DAY}
      markers={row?.updates.map((at) => ({ at: Date.parse(at), label: `Experience updated · ${shortDate(at)}` }))} />
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
      {[["Average", stat(stats.average)], ["Highest", stat(stats.high)], ["Lowest", stat(stats.low)], ["Growth", stats.growth == null ? "Unavailable" : percent(stats.growth)]].map(([label, value]) =>
        <div key={label} className="rounded-lg border border-line p-2"><dt className="text-fg-2">{label}</dt><dd className="font-semibold">{value}</dd></div>)}
    </dl>
    <p className="text-xs text-fg-2">{points.length} observations saved on this device. Older player readings represent retained peaks. Dashed markers show Roblox update dates.</p>
    <details open={comparison.length > 0 || undefined}>
      <summary className="cursor-pointer font-medium">Compare games</summary>
      <form className="flex gap-2 mt-2" onSubmit={(event) => { event.preventDefault(); const next = input.trim(); if (next === term) void search.refetch(); else setTerm(next); }}>
        <input className="field flex-1" aria-label="Find a game to compare" placeholder="Game name, ID or Roblox URL" value={input} maxLength={300} onChange={(event) => setInput(event.target.value)} />
        <button className="btn">Find</button>
      </form>
      <div className="flex flex-wrap gap-2 py-2">
        {comparison.map((id) => <button className="btn btn-sm" key={id} onClick={() => compareGame(id)}><Icon name="x" />{records[id]?.game.name ?? id}</button>)}
        {search.data?.games.filter((item) => item.universeId !== game.universeId && !comparison.includes(item.universeId)).slice(0, 6).map((item) =>
          <button className="btn btn-sm" key={item.universeId} onClick={() => compareGame(item.universeId)}>Compare {item.name}</button>)}
      </div>
      {search.isFetching && <p className="text-sm">Searching Roblox…</p>}
      {search.isError && <p className="text-sm text-fg-2">Comparison search is unavailable.</p>}
    </details>
    {comparison.length > 0 && <details>
      <summary className="cursor-pointer font-medium">Compare creators</summary>
      <p className="text-sm text-fg-2 mt-2">Totals cover up to 25 public experiences per creator.</p>
      <StudioList creators={[game, ...comparison.flatMap((id) => records[id] ? [records[id].game] : [])].map((item) => item.creator)
        .filter((creator, index, all) => creator.id != null && creator.kind && all.findIndex((item) => item.id === creator.id && item.kind === creator.kind) === index)} />
    </details>}
  </section>;
}
