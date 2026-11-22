import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Icon } from "../../ui/Icon";
import { toastError } from "../../ui/Toast";
import { percent, useGameSearch } from "../discover/catalog";
import { DAY, HOUR, STATS, WATCH, archiveOptions, at, growthBetween, measurements, number, useArchive, type Daily } from "./archive";
import { saveAnalyticsCsv } from "./csv";
import { HistoryChart, type Sample, type Series } from "./HistoryChart";
import { Source } from "./Platform";
import { summary } from "./history";
import type { GameRecord } from "./store";
import type { PublicGame } from "./types";

const ranges = [["Live", 15 * 60_000], ["1H", HOUR], ["6H", 6 * HOUR], ["1D", DAY], ["1W", 7 * DAY],
  ["1M", 30 * DAY], ["1Y", 365 * DAY], ["All time", Infinity]] as const;
const metrics = { players: "Players", peak: "Daily peak", visits: "Daily visits", total: "Total visits", session: "Est. session minutes",
  favorites: "Favorites", likes: "Likes", approval: "Approval" };
type Metric = keyof typeof metrics;
type Window = { from: number; to: number };

function dailySamples(daily: Daily[] | null | undefined, peak: boolean) {
  return measurements(daily, (row) => row.at, (row) => peak ? row.high : row.average,
    peak ? "RoWatcher · daily peak (UTC) · CC BY 4.0" : "RoWatcher · daily average (UTC) · CC BY 4.0");
}

function useHistory(ids: number[]) {
  const daily = useQueries({ queries: ids.map((id) => archiveOptions("gameDaily", id)) });
  const recent = useQueries({ queries: ids.map((id) => archiveOptions("gameSeries", id)) });
  return { daily, recent };
}

export function GameHistory({ game, records, comparison, setComparison, updates, selectedUpdate, selectUpdate }: {
  game: PublicGame; records: Record<number, GameRecord>; comparison: number[];
  setComparison: (update: (current: number[]) => number[]) => void;
  updates: string[]; selectedUpdate?: string; selectUpdate: (at: string) => void;
}) {
  const ids = [game.universeId, ...comparison];
  const { daily, recent } = useHistory(ids);
  const [range, setRange] = useState(5);
  const [metric, setMetric] = useState<Metric>("players");
  const [week, setWeek] = useState(false);
  const [zoom, setZoom] = useState<Window | null>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  const search = useGameSearch(term);
  const selectRange = (index: number) => { setRange(index); setZoom(null); setStart(""); setEnd(""); };
  const duration = ranges[range][1];
  const isDaily = range >= 4 || !!start && !!end && !!zoom;
  const sources = ids.map((id, i) => {
    const row = records[id];
    const archive = recent[i].data;
    if (metric === "peak") return dailySamples(daily[i].data, true);
    if (metric === "players") {
      const dailyPoints = dailySamples(daily[i].data, false);
      const hourly = measurements(archive?.hours, (item) => item.t, (item) => item.v, "RobloxGameStats · hourly record");
      const local = measurements(row?.samples, (item) => item.at, (item) => item.players, "Roblox · saved sample");
      if (isDaily && dailyPoints.length) return dailyPoints;
      // Use compatible time buckets. Local high-frequency recordings stay separate
      // from hourly aggregates even when both sources have data.
      if (range < 2) return local.some((p) => p.at > Date.now() - duration) ? local : hourly;
      return hourly.length && hourly.at(-1)!.at > Date.now() - 6 * HOUR ? hourly : local.length ? local : hourly;
    }
    if (metric === "visits" || metric === "session" || metric === "approval") {
      const field = metric === "approval" ? "likes" : metric;
      const recorded = measurements(archive?.days, (item) => item.t, (item) => item[field],
        metric === "session" ? "RobloxGameStats · estimated daily session (UTC)" : "RobloxGameStats · daily value (UTC)");
      if (recorded.length && (isDaily || metric !== "approval")) return recorded;
    }
    if (metric === "visits" || metric === "session") return [];
    const field = metric === "total" ? "visits" : metric;
    return measurements(row?.totals, (item) => item.at, (item) => item[field], "Roblox · saved snapshot");
  });
  const now = Date.now();
  const endDate = new Date(now).toISOString().slice(0, 10);
  const source = sources[0];
  const from = zoom?.from ?? (duration === Infinity ? Math.min(...sources.map((points) => points[0]?.at ?? now - DAY)) : now - duration);
  const to = zoom?.to ?? now;
  const inside = (point: Sample) => point.at >= from && point.at <= to;
  const points = source.filter(inside);
  const stats = summary(points.map((point) => point.value));
  const useDailyExtremes = metric === "players" && isDaily && points.some((point) => point.source?.startsWith("RoWatcher"));
  const dailiesInRange = (daily[0].data ?? []).filter((point) => point.at >= from && point.at <= to);
  const highest = useDailyExtremes ? Math.max(...dailiesInRange.map((point) => point.high)) : stats.high;
  const lowest = useDailyExtremes ? Math.min(...dailiesInRange.map((point) => point.low)) : stats.low;
  const traces: Series[] = ids.map((id, i) => ({ label: records[id]?.game.name ?? (i === 0 ? game.name : `Game ${id}`), points: sources[i].filter(inside) }));
  if (week) traces.push({ label: "Previous week", dashed: true,
    points: source.map((point) => ({ ...point, at: point.at + 7 * DAY, observedAt: point.at })).filter(inside) });
  const format = (value: number) => Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) + (metric === "approval" ? "%" : "") : "Unavailable";
  const value = (x: number | null) => x == null ? "Unavailable" : format(x);
  const compareGame = (id: number) => setComparison((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id].slice(-3));
  const errors = [...daily, ...recent].filter((query) => query.isError);
  const pending = daily[0].isPending || recent[0].isPending;
  const dailyChart = isDaily || ["peak", "visits", "session"].includes(metric);
  return <section className="panel analytics-market-card">
    <header className="analytics-panel-heading"><div><h2>Player and Engagement History</h2>
      <p className="text-sm text-fg-2">{dailyChart ? "Daily records use UTC." : "Move over the chart to inspect an observation."} Drag across the chart to zoom.</p></div>
      <button className="btn btn-sm" disabled={!traces.some((trace) => trace.points.length)} onClick={() => void saveAnalyticsCsv(
        `UnknownALT-${game.universeId}-${metric}.csv`, ["game", "metric", "observed_at_utc", "value", "source", "source_url"], traces.flatMap((trace) =>
          trace.points.map((point) => [trace.label, metrics[metric], new Date(point.observedAt ?? point.at).toISOString(), point.value, point.source ?? "",
            point.source?.startsWith("RoWatcher") ? `${WATCH}/api/v1/games/${ids[traces.indexOf(trace)] ?? game.universeId}/history.csv?days=730`
            : point.source?.startsWith("RobloxGameStats") ? `${STATS}/game/${ids[traces.indexOf(trace)] ?? game.universeId}` : "https://games.roblox.com/"]))).catch(toastError)}>
        <Icon name="download" />Export CSV</button></header>
    <div className="analytics-toolbar">
      <div className="analytics-segment" role="group" aria-label="Game chart range">{ranges.map(([label], i) =>
        <button key={label} aria-pressed={range === i && !zoom} onClick={() => selectRange(i)}>{label}</button>)}</div>
      <select className="field" aria-label="Chart metric" value={metric} onChange={(event) => {
        const next = event.target.value as Metric;
        setMetric(next);
        if (["peak", "visits", "session"].includes(next) && range < 4) selectRange(4);
      }}>{Object.entries(metrics).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      <label className="analytics-check"><input type="checkbox" checked={week} onChange={(event) => setWeek(event.target.checked)} />Previous week</label>
      {zoom && <button className="btn btn-sm" onClick={() => selectRange(range)}>Reset zoom</button>}
    </div>
    {pending && !points.length ? <p className="analytics-chart-empty analytics-loading" role="status">Loading recorded history…</p>
      : <HistoryChart key={`${metric}:${range}`} points={points} from={from} to={to} format={format} series={traces.length > 1 ? traces : undefined}
        size="large" gap={dailyChart ? DAY * 1.6 : range < 2 ? 25 * 60_000 : HOUR * 3} onZoom={setZoom}
        markers={updates.map((update) => ({ at: Date.parse(update), label: `Roblox update · ${new Date(update).toLocaleString()}` }))} />}
    {pending && points.length > 0 && <p role="status" className="analytics-feedback">Loading provider history…</p>}
    {!!errors.length && <p className="analytics-feedback" role="status">A history source is unavailable. Existing records are available offline.
      {" "}<button className="btn btn-sm" onClick={() => { for (const query of errors) void query.refetch(); }}>Retry</button></p>}
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
      {[[ "Average", value(stats.average) ], ["Highest", value(highest)], ["Lowest", value(lowest)],
        [ "Change in view", stats.growth == null ? "Unavailable" : percent(stats.growth) ]].map(([label, reading]) =>
        <div key={label} className="border border-line rounded-lg p-2"><dt className="text-fg-2">{label}</dt><dd className="font-semibold">{reading}</dd></div>)}
    </dl>
    <form className="analytics-toolbar" onSubmit={(event) => {
      event.preventDefault();
      const from = Date.parse(start);
      const to = Math.min(Date.parse(end) + DAY - 1, Date.now());
      if (Number.isFinite(from) && to > from) { setRange(7); setZoom({ from, to }); }
    }}>
      <label>From <input className="field" type="date" required max={end || endDate} value={start} onChange={(event) => setStart(event.target.value)} /></label>
      <label>To <input className="field" type="date" required max={endDate} min={start} value={end} onChange={(event) => setEnd(event.target.value)} /></label>
      <button className="btn btn-sm">Apply dates</button>
    </form>
    <details open={comparison.length > 0 || undefined}>
      <summary className="cursor-pointer font-medium">Compare games</summary>
      <form className="flex gap-2 mt-2" onSubmit={(event) => { event.preventDefault(); const next = input.trim(); if (next === term && next) void search.refetch(); else setTerm(next); }}>
        <input className="field flex-1" aria-label="Find a game to compare" placeholder="Game name, ID or Roblox URL" value={input} maxLength={300} onChange={(event) => setInput(event.target.value)} />
        <button className="btn">Find</button>
      </form>
      <div className="flex flex-wrap gap-2 py-2">
        {comparison.map((id) => <button className="btn btn-sm" key={id} aria-label={`Remove comparison ${records[id]?.game.name ?? id}`} onClick={() => compareGame(id)}><Icon name="x" />{records[id]?.game.name ?? id}</button>)}
        {search.data?.games.filter((item) => item.universeId !== game.universeId && !comparison.includes(item.universeId)).slice(0, 6).map((item) =>
          <button className="btn btn-sm" key={item.universeId} onClick={() => compareGame(item.universeId)}>Compare {item.name}</button>)}
      </div>
      {search.isFetching && <p role="status" className="text-sm">Searching Roblox…</p>}
      {search.isError && <p role="status" className="text-sm text-fg-2">Comparison search is unavailable.</p>}
      {term && search.isSuccess && !search.data.games.length && <p role="status" className="text-sm text-fg-2">No games matched.</p>}
    </details>
    {!!updates.length && <label className="analytics-toolbar text-sm">Jump to update
      <select className="field" aria-label="Show an update on the chart" value={selectedUpdate ?? ""} onChange={(event) => {
        const update = event.target.value;
        selectUpdate(update);
        const time = Date.parse(update);
        if (Number.isFinite(time)) {
          setRange(4);
          setZoom({ from: time - 4 * DAY, to: Math.min(time + 4 * DAY, Date.now()) });
        }
      }}><option value="">Select an update</option>{[...updates].reverse().map((update) => <option key={update} value={update}>{new Date(update).toLocaleString()}</option>)}</select>
    </label>}
    <footer className="analytics-chart-foot">
      <span>{points.length} records in view. {points[0]?.source?.startsWith("Roblox ·") && "Saved samples can include retained peaks."}</span>
      <Source url={`${WATCH}/api/v1/games/${game.universeId}/history.csv?days=730`}>RoWatcher (CC BY 4.0)</Source>
      <Source url={`${STATS}/game/${game.universeId}`}>RobloxGameStats</Source>
    </footer>
  </section>;
}

export function GameMarketStats({ id }: { id: number }) {
  const daily = useArchive("gameDaily", id);
  const stats = useArchive("gameSeries", id);
  const profile = useArchive("gameProfile", id);
  const model = useArchive("gameEstimate", id);
  const samples = dailySamples(daily.data, false);
  const last = samples.at(-1)?.at;
  const recent = last == null ? [] : samples.filter((row) => row.at > last - 7 * DAY);
  const visitSamples = measurements(stats.data?.days, (item) => item.t, (item) => item.visits, "RobloxGameStats");
  const playersGrowth = growthBetween(samples, 7);
  const visitsGrowth = growthBetween(visitSamples, 7);
  const peak = (daily.data ?? []).reduce<number | null>((high, row) => Math.max(high ?? 0, row.high), null);
  const providerPeak = number(profile.data?.peakAll);
  const providerPeakDate = at(profile.data?.peakAllAt);
  const observedPeak = peak == null ? providerPeak : providerPeak == null ? peak : Math.max(peak, providerPeak);
  const estimate = number(model.data?.estimate);
  const session = number(profile.data?.session);
  const p = (n: number | null, suffix = "") => n == null ? "Unavailable" : n.toLocaleString(undefined, { maximumFractionDigits: 2 }) + suffix;
  const w = (n: number | null) => n == null ? "Unavailable" : percent(n);
  return <section className="panel analytics-market-card">
    <header className="analytics-panel-heading"><div><h2>Performance Snapshot</h2><p className="text-sm text-fg-2">Public history and independently modeled figures.</p></div></header>
    {(daily.isPending || profile.isPending) && <p role="status" className="analytics-feedback analytics-loading">Loading public performance records…</p>}
    <dl className="analytics-stat-grid">
      {[["7-day avg. concurrent", p(summary(recent.map((row) => row.value)).average)], ["Recorded peak", p(observedPeak)],
        ["7-day player growth", w(playersGrowth)], ["7-day visit growth", w(visitsGrowth)],
        ["Est. session duration", p(session, " min")], ["Est. monthly spending", estimate == null ? "Unavailable" : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(estimate)],
        ["Genre percentile", p(number(model.data?.genrePercentile), "%")]].map(([label, reading]) =>
        <div key={label}><dt>{label}</dt><dd>{reading}</dd></div>)}
    </dl>
    {profile.data?.ranks?.length ? <div className="analytics-toolbar"><strong>Roblox chart positions recorded by RobloxGameStats</strong>
      {profile.data.ranks.filter((item) => number(item.rank) != null).map((item) => <span className="analytics-rank-chip" key={item.id}>
        {item.id.replaceAll("-", " ")} · #{item.rank}</span>)}</div> : null}
    {providerPeakDate != null && providerPeak != null && <p className="text-sm text-fg-2">
      RobloxGameStats recorded {p(providerPeak)} players on {new Date(providerPeakDate).toLocaleDateString()}.</p>}
    <footer className="analytics-chart-foot">
      <span>Monthly spending is a model estimate{model.data?.confidence ? ` · ${model.data.confidence} model confidence` : ""}. Peak covers the source’s available records.</span>
      <Source url={`${WATCH}/methodology`}>RoWatcher methodology</Source><Source url={`${STATS}/game/${id}`}>RobloxGameStats</Source>
    </footer>
  </section>;
}

export function historicalUpdates(remote: (number[] | null | undefined)[], saved: (string | null | undefined)[]) {
  const times = new Set<number>();
  for (const value of [...remote.flatMap((rows) => Array.isArray(rows) ? rows : []), ...saved]) {
    const when = at(value);
    if (when != null) times.add(when);
  }
  return [...times].sort((a, b) => a - b).map((time) => new Date(time).toISOString());
}
