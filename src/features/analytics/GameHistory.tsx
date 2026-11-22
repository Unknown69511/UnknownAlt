import { useState } from "react";
import { fmtDate, fmtExact, fmtNum } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { toastError } from "../../ui/Toast";
import { percent, useGameSearch } from "../discover/catalog";
import { CCU, DAY, HOUR, STATS, WATCH, at, number, useArchive } from "./archive";
import { saveAnalyticsCsv } from "./csv";
import { HistoryChart, type Sample, type Series } from "./HistoryChart";
import { coveredAverage, dailyGrowth, metricHistory, metrics, utcDay, type GameTimeline, type HistoryMetric } from "./gameHistoryData";
import { monthlyEstimate, Revenue, RevenueAssumptions } from "./revenue";
import { Timeline, type TimeWindow } from "./Timeline";
import { Source } from "./Platform";
import { summary } from "./history";
import type { GameRecord } from "./store";
import type { PublicGame } from "./types";
import type { useGameTimelines } from "./useGameTimelines";

const ranges = [["Live", 15 * 60_000], ["1H", HOUR], ["6H", 6 * HOUR], ["1D", DAY], ["1W", 7 * DAY],
  ["1M", 30 * DAY], ["1Y", 365 * DAY], ["All time", Infinity]] as const;
const dailyOnly = (metric: HistoryMetric) => metric === "peak" || metric === "visits" || metric === "session";
const dateLabel = (time: number) => fmtDate(time, { dateStyle: "medium", timeZone: "UTC" });
const labelValue = (value: number | null) => value == null ? "Unavailable" : fmtNum(value, { maximumFractionDigits: 1 });
type GameTrace = Series & { universe: number };

function sourceUrl(trace: GameTrace, point: Sample, placeId: number) {
  if (point.source?.startsWith("CCUCheck")) return `${CCU}/games/${placeId}`;
  if (point.source?.startsWith("RobloxGameStats")) return `${STATS}/game/${trace.universe}`;
  if (point.source?.startsWith("RoWatcher")) return `${WATCH}/api/v1/games/${trace.universe}/${point.source.includes("visit total") ? "history" : "history.csv?days=730"}`;
  return `https://www.roblox.com/games/${placeId}`;
}

export function GameHistory({ game, records, ids, history, setComparison, updates, selectedUpdate, selectUpdate, loadVisits }: {
  game: PublicGame; records: Record<number, GameRecord>; ids: number[]; history: ReturnType<typeof useGameTimelines>;
  setComparison: (update: (current: number[]) => number[]) => void;
  updates: string[]; selectedUpdate?: string; selectUpdate: (at: string) => void; loadVisits: () => void;
}) {
  const [range, setRange] = useState(5);
  const [metric, setMetric] = useState<HistoryMetric>("players");
  const [prior, setPrior] = useState(false);
  const [zoom, setZoom] = useState<TimeWindow | null>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  const search = useGameSearch(term);
  const isDaily = range >= 4 || dailyOnly(metric);
  const selectRange = (index: number) => { setRange(index); setZoom(null); setStart(""); setEnd(""); };
  const duration = ranges[range][1];
  const now = Date.now();
  const today = utcDay(now);
  const created = at(game.created) ?? 0;
  const earliestAllowed = isDaily ? utcDay(created) : created;
  const sources = history.timelines.map((timeline) => metricHistory(timeline, metric, isDaily, range < 3));
  const endDate = new Date(now).toISOString().slice(0, 10);
  const recordInputs = sources.flatMap((items) => items.length ? [items[0].at] : []);
  const earliest = recordInputs.length ? Math.min(...recordInputs) : Math.max(earliestAllowed, now - DAY);
  const rangeFrom = duration === Infinity ? earliest : isDaily ? today - (duration - DAY) : now - duration;
  const from = Math.min(now - 1, Math.max(earliestAllowed, zoom?.from ?? rangeFrom));
  const to = Math.max(from + 1, Math.min(now, zoom?.to ?? now));
  const bounds = { from: Math.min(earliest, Math.max(earliestAllowed, rangeFrom), from), to: now };
  const contains = (point: Sample) => point.at >= from && point.at <= to;
  const traces: GameTrace[] = ids.map((id, i) => ({
    label: records[id]?.game.name ?? (i === 0 ? game.name : `Game ${id}`), universe: id, points: sources[i].filter(contains),
  }));
  const points = traces[0].points;
  // Calendar comparisons align UTC daily buckets, even with a partial current day on screen.
  const shift = isDaily ? (utcDay(to) - utcDay(from) + DAY) : to - from;
  if (prior) traces.push({
    label: "Previous period", universe: game.universeId, dashed: true,
    points: sources[0].filter((point) => point.at >= from - shift && point.at < from)
      .map((point) => ({ ...point, at: point.at + shift, observedAt: point.observedAt ?? point.at })).filter(contains),
  });
  const recordedAverages = points.filter((p) => !p.source?.includes("daily reading"));
  const stats = summary((isDaily && metric === "players" ? recordedAverages : points).map((point) => point.value));
  const dailies = history.timelines[0].daily.filter((row) => row.at >= from && row.at <= to);
  const highs = dailies.flatMap(({ high }) => high == null ? [] : [high]);
  const lows = dailies.flatMap(({ low }) => low == null ? [] : [low]);
  const highest = metric === "players" && isDaily ? (highs.length ? Math.max(...highs) : null) : stats.high;
  const lowest = metric === "players" && isDaily ? (lows.length ? Math.min(...lows) : null) : stats.low;
  const format = (value: number) => metric === "approval"
    ? fmtNum(value / 100, { style: "percent", maximumFractionDigits: 2 }) : fmtNum(value, { maximumFractionDigits: 1 });
  const exact = (value: number) => metric === "approval"
    ? fmtExact(value / 100, { style: "percent", maximumFractionDigits: 4 }) : fmtExact(value, { maximumFractionDigits: 4 });
  const value = (reading: number | null) => reading == null ? "Unavailable" : format(reading);
  const compareGame = (id: number) => setComparison((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id].slice(-3));
  const { requests } = history;
  const failed = requests.filter((query) => query.isError);
  const working = requests.some((query) => query.isFetching);
  const paused = requests.some((query) => query.fetchStatus === "paused");
  const lastRefresh = Math.max(0, ...requests.map((query) => query.dataUpdatedAt), ...history.timelines.map((row) => row.checked));
  const covered = new Set(points.map((point) => utcDay(point.at)));
  const missingDays = isDaily ? Math.max(0, (utcDay(to) - utcDay(from)) / DAY + 1 - covered.size) : 0;
  const available = sources[0];
  const minWidth = isDaily ? DAY : 60_000;
  const gap = isDaily ? DAY * 1.25 : range === 0 ? 12 * 60_000 : HOUR * 1.25;
  return <section className="panel analytics-market-card">
    <header className="analytics-panel-heading"><div><h2>Player and Engagement History</h2>
      <p className="text-sm text-fg-2">Drag across the chart to zoom. {isDaily ? "Dates use UTC." : "Hover for an exact reading."}</p></div>
      <div className="analytics-toolbar">
        <button className="btn btn-sm" disabled={working} onClick={() => {
          for (const query of requests) void query.refetch({ cancelRefetch: false });
        }}><Icon name="refresh" />Refresh history</button>
        <button className="btn btn-sm" disabled={!traces.some((trace) => trace.points.length)} onClick={() => void saveAnalyticsCsv(
          `UnknownALT-${game.universeId}-${metric}.csv`, ["game", "metric", "observed_at_utc", "value", "source", "source_url"], traces.flatMap((trace) =>
            trace.points.map((point) => [trace.label, metrics[metric], new Date(point.observedAt ?? point.at).toISOString(), point.value, point.source ?? "",
              sourceUrl(trace, point, records[trace.universe]?.game.rootPlaceId ?? (trace.universe === game.universeId ? game.rootPlaceId : trace.universe))]))).catch(toastError)}>
          <Icon name="download" />Export chart CSV</button>
      </div>
    </header>
    <div className="analytics-toolbar">
      <div className="analytics-segment" role="group" aria-label="Game chart range">{ranges.map(([label], i) =>
        <button key={label} aria-pressed={range === i && !zoom} disabled={i < 4 && dailyOnly(metric)}
          onClick={() => selectRange(i)}>{label}</button>)}</div>
      <select className="field" aria-label="Chart metric" value={metric} onChange={(event) => {
        const next = event.target.value as HistoryMetric;
        setMetric(next);
        if (next === "total") loadVisits();
        if (dailyOnly(next) && range < 4) selectRange(4);
      }}>{Object.entries(metrics).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      <label className="analytics-check"><input type="checkbox" checked={prior} onChange={(event) => setPrior(event.target.checked)} />Previous period</label>
      {zoom && <button className="btn btn-sm" onClick={() => selectRange(range)}>Reset zoom</button>}
    </div>
    <HistoryChart points={points} from={from} to={to} format={format} exact={exact} series={traces.length > 1 ? traces : undefined}
      size="large" gap={gap} utc={isDaily} loading={working} axis={metric === "approval" ? format : undefined}
      onZoom={(window) => { if (window.to - window.from >= minWidth) setZoom(window); }}
      markers={updates.map((update) => ({ at: Date.parse(update), label: `Roblox update · ${fmtDate(Date.parse(update))}` }))} />
    <Timeline bounds={bounds} viewing={{ from, to }} update={setZoom} minWidth={minWidth} utc={isDaily} />
    <p className="analytics-feedback" role="status">
      {paused ? "Offline. Showing previously loaded records." : working ? "Refreshing history…" :
        failed.length ? "Some history sources are unavailable. Previously loaded records remain visible." : ""}
      {lastRefresh > 0 && ` Last refreshed ${fmtDate(lastRefresh, { dateStyle: "medium", timeStyle: "short" })}.`}
    </p>
    <dl className="analytics-stat-grid">
      {[[ "Average", value(stats.average) ], ["Highest", value(highest)], ["Lowest", value(lowest)],
        [ "Change in view", stats.growth == null ? "Unavailable" : percent(stats.growth) ]].map(([label, reading]) =>
        <div key={label}><dt>{label}</dt><dd>{reading}</dd></div>)}
    </dl>
    <form className="analytics-toolbar" onSubmit={(event) => {
      event.preventDefault();
      const begin = Math.max(utcDay(created), Date.parse(start));
      const until = Math.min(Date.parse(end) + DAY - 1, Date.now());
      if (Number.isFinite(begin) && until > begin) { setRange(7); setZoom({ from: begin, to: until }); }
    }}>
      <label>From <input className="field" type="date" required min={created ? new Date(created).toISOString().slice(0, 10) : undefined}
        max={end || endDate} value={start} onChange={(event) => setStart(event.target.value)} /></label>
      <label>To <input className="field" type="date" required max={endDate} min={start} value={end} onChange={(event) => setEnd(event.target.value)} /></label>
      <button className="btn btn-sm">Apply dates</button>
    </form>
    <details open={ids.length > 1 || undefined}>
      <summary className="cursor-pointer font-medium">Compare games</summary>
      <form className="flex gap-2 mt-2" onSubmit={(event) => { event.preventDefault(); const next = input.trim(); if (next === term && next) void search.refetch(); else setTerm(next); }}>
        <input className="field flex-1" aria-label="Find a game to compare" placeholder="Game name, ID or Roblox URL" value={input} maxLength={300} onChange={(event) => setInput(event.target.value)} />
        <button className="btn">Find</button>
      </form>
      <div className="flex flex-wrap gap-2 py-2">
        {ids.slice(1).map((id) => <button className="btn btn-sm" key={id} aria-label={`Remove comparison ${records[id]?.game.name ?? id}`} onClick={() => compareGame(id)}><Icon name="x" />{records[id]?.game.name ?? id}</button>)}
        {search.data?.games.filter((item) => !ids.includes(item.universeId)).slice(0, 6).map((item) =>
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
          setZoom({ from: utcDay(time) - 4 * DAY, to: Math.min(utcDay(time) + 5 * DAY - 1, Date.now()) });
        }
      }}><option value="">Select an update</option>{[...updates].reverse().map((update) => <option key={update} value={update}>{fmtDate(Date.parse(update))}</option>)}</select>
    </label>}
    <footer className="analytics-chart-foot">
      <span>{fmtNum(points.length)} readings in view.
        {missingDays > 0 && ` No records for ${fmtNum(missingDays)} UTC ${missingDays === 1 ? "day" : "days"} in this view.`}
        {available.length > 0 && ` Recorded coverage: ${dateLabel(available[0].at)} to ${dateLabel(available.at(-1)!.at)}.`}
        {isDaily && metric === "players" && points.some((p) => p.source?.includes("daily reading")) && " Some dates have individual readings only. Those are excluded from average and growth statistics."}
      </span>
      <Source url={`${WATCH}/api/v1/games/${game.universeId}/history.csv?days=730`}>RoWatcher (CC BY 4.0)</Source>
      <Source url={`${CCU}/games/${game.rootPlaceId}`}>CCUCheck</Source>
      <Source url={`${STATS}/game/${game.universeId}`}>RobloxGameStats</Source>
    </footer>
  </section>;
}

export function GameMarketStats({ id, timeline }: { id: number; timeline: GameTimeline }) {
  const profile = useArchive("gameProfile", id);
  const model = useArchive("gameEstimate", id);
  const end = utcDay(Date.now());
  const averages = [1, 7, 30].map((period) => ({ period, ...coveredAverage(timeline.daily, period, end) }));
  const playersGrowth = dailyGrowth(timeline.daily, 7, end);
  const visitsGrowth = dailyGrowth(timeline.daily, 7, end, "visits");
  const monthGrowth = dailyGrowth(timeline.daily, 30, end);
  const archivePeaks = timeline.daily.flatMap((row) => row.high == null ? [] : [{ at: row.at, value: row.high, source: row.source }]);
  const providerPeak = number(profile.data?.peakAll);
  if (providerPeak != null) archivePeaks.push({ at: at(profile.data?.peakAllAt) ?? 0, value: providerPeak, source: "RobloxGameStats" });
  const peak = archivePeaks.reduce<(typeof archivePeaks)[number] | undefined>((best, row) => !best || row.value > best.value ? row : best, undefined);
  const estimate = monthlyEstimate(model.data?.estimate, model.data?.robuxPerDay);
  const growth = (value: number | null) => value == null ? "Unavailable" : percent(value);
  return <section className="panel analytics-market-card">
    <header className="analytics-panel-heading"><div><h2>Performance Snapshot</h2><p className="text-sm text-fg-2">Averages use complete UTC dates with sufficient recorded coverage.</p></div></header>
    <dl className="analytics-stat-grid">
      {averages.map(({ period, days, average }) => {
        return <div key={period}><dt>{period}-day average players</dt><dd>{labelValue(average)}</dd>
          <span className="text-xs text-fg-2">{fmtNum(days)} of {fmtNum(period)} days recorded</span></div>;
      })}
      <div><dt>Historical peak</dt><dd>{labelValue(peak?.value ?? null)}</dd>
        {peak && <span className="text-xs text-fg-2">{peak.at ? dateLabel(peak.at) + " · " : ""}{peak.source}</span>}</div>
      <div><dt>7-day player growth</dt><dd>{growth(playersGrowth)}</dd></div>
      <div><dt>30-day player growth</dt><dd>{growth(monthGrowth)}</dd></div>
      <div><dt>7-day visit growth</dt><dd>{growth(visitsGrowth)}</dd></div>
      <div><dt>Est. session duration</dt><dd>{profile.data?.session == null ? "Unavailable" : `${labelValue(number(profile.data.session))} min`}</dd></div>
      <div><dt>Estimated monthly revenue</dt><dd><Revenue estimate={estimate} /></dd></div>
      <div><dt>Genre percentile</dt><dd>{model.data?.genrePercentile == null ? "Unavailable" : `${labelValue(number(model.data.genrePercentile))}%`}</dd></div>
    </dl>
    {timeline.disagreements > 0 && <p className="analytics-feedback">
      RoWatcher and CCUCheck differed by more than 20% on {fmtNum(timeline.disagreements)} overlapping dates. The daily figures use RoWatcher on those dates.</p>}
    {profile.data?.ranks?.length ? <div className="analytics-toolbar"><strong>Roblox chart positions recorded by RobloxGameStats</strong>
      {profile.data.ranks.filter((item) => number(item.rank) != null).map((item) => <span className="analytics-rank-chip" key={item.id}>
        {item.id.replaceAll("-", " ")} · #{fmtNum(item.rank)}</span>)}</div> : null}
    <RevenueAssumptions />
    <footer className="analytics-chart-foot">
      <span>Growth compares against the preceding period.{model.data?.confidence ? ` Model confidence · ${model.data.confidence}.` : ""}</span>
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
