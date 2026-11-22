import { fmtNum } from "../../i18n";
import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toastError } from "../../ui/Toast";
import { saveAnalyticsCsv } from "./csv";
import { HistoryChart, type Sample, type Series } from "./HistoryChart";
import { DAY, HOUR, STATS, WATCH, at, measurements, number, useArchive } from "./archive";
import { Timeline, type TimeWindow } from "./Timeline";
import { summary } from "./history";

const modes = [["Live", 3 * HOUR], ["1D", DAY], ["1W", 7 * DAY], ["1M", 30 * DAY], ["1Y", 365 * DAY], ["All time", Infinity]] as const;
const format = (n: number) => fmtNum(n, { maximumFractionDigits: 1 });
const change = (n: number) => (n > 0 ? "+" : "") + format(n);
const isoDay = (n: number) => new Date(n).toISOString().slice(0, 10);

export function Source({ url, children }: { url: string; children: string }) {
  return <a href={url} className="analytics-source" onClick={(event) => {
    event.preventDefault();
    void openUrl(url).catch(toastError);
  }}>{children}</a>;
}

export function Platform({ expand, full = false }: { expand?: () => void; full?: boolean }) {
  const live = useArchive("platformLive");
  const older = useArchive("platformHistory");
  const [range, setRange] = useState("1D");
  const [metric, setMetric] = useState("players");
  const [compare, setCompare] = useState(false);
  const [zoom, setZoom] = useState<TimeWindow | null>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const recent = measurements(live.data?.history, (row) => row.recordedAt, (row) => row.totalCCU, "RoWatcher · recorded sample");
  const hourly = measurements(older.data?.hours, (row) => row.t, (row) => row.v, "RobloxGameStats · hourly record");
  const daily = measurements(older.data?.days, (row) => row.t, (row) => metric === "peak" ? row.peak : row.avg,
    metric === "peak" ? "RobloxGameStats · daily peak (UTC)" : "RobloxGameStats · daily average (UTC)");
  const short = range === "Live" || range === "1D";
  const fromRecentProvider = recent.length > 0;
  const source = short ? fromRecentProvider ? recent : hourly : daily;
  const newest = at(live.data?.recordedAt);
  const current = number(live.data?.current);
  const duration = modes.find(([label]) => label === range)?.[1] ?? DAY;
  const last = source.at(-1)?.at ?? newest ?? Date.now();
  const allFrom = source[0]?.at ?? last - DAY;
  const now = Date.now();
  const to = zoom?.to ?? now;
  const rangeStart = duration === Infinity ? allFrom : (short ? now : Math.floor(now / DAY) * DAY + DAY) - duration;
  const from = zoom?.from ?? Math.min(to - 1, rangeStart);
  const bounds = { from: Math.min(allFrom, rangeStart, from), to: now };
  const filter = (sample: Sample) => sample.at >= from && sample.at <= to;
  const points = source.filter(filter);
  const first = points[0]?.value;
  const final = points.at(-1)?.value;
  const delta = first != null && final != null && points.length > 1 ? final - first : null;
  const stats = summary(points.map((p) => p.value));
  const coveredDays = new Set(points.map((p) => Math.floor(p.at / DAY)));
  const missingDays = short ? 0 : Math.max(0, Math.floor((to - 1) / DAY) - Math.floor(from / DAY) + 1 - coveredDays.size);
  const traces: Series[] = [{ label: metric === "peak" ? "Daily peak" : short ? "Concurrent players" : "Daily average", points }];
  const durationCompare = to - from;
  if (compare) traces.push({ label: "Previous period", dashed: true, points: source.filter((p) => p.at < from).map((point) =>
    ({ ...point, at: point.at + durationCompare, observedAt: point.at })).filter(filter) });
  const select = (value: string) => { setRange(value); setZoom(null); setStart(""); setEnd(""); };
  const recordDate = newest == null ? null : new Date(newest);
  return <section className="panel analytics-platform">
    <header className="analytics-panel-heading">
      <div><p className="analytics-kicker">Platform activity</p><h2>Concurrent Roblox players</h2>
        <p className="text-sm text-fg-2">Independent counts across each provider’s tracked experiences.</p></div>
      {expand && <button className="btn btn-sm" onClick={expand}>Open chart</button>}
    </header>
    <div className="analytics-platform-count">
      <strong>{current == null ? "Unavailable" : format(current)}</strong>
      {delta != null && <span className={delta >= 0 ? "analytics-positive" : "analytics-negative"}>
        {change(delta)}{first ? ` · ${change(delta / first * 100)}%` : ""} in view
      </span>}
      {recordDate && <time dateTime={recordDate.toISOString()} className="text-xs text-fg-2">RoWatcher sample · {recordDate.toLocaleString()}</time>}
    </div>
    <div className="analytics-toolbar">
      <div className="analytics-segment" role="group" aria-label="Platform chart range">{modes.map(([label]) =>
        <button type="button" key={label} aria-pressed={range === label && !zoom} onClick={() => {
          if (label === "Live" || label === "1D") setMetric("players");
          select(label);
        }}>{label}</button>)}</div>
      <select className="field" aria-label="Platform metric" value={metric} onChange={(event) => {
        setMetric(event.target.value);
        if (short && event.target.value === "peak") select("1W");
      }}><option value="players">Players</option><option value="peak">Daily peak</option></select>
      <label className="analytics-check"><input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} />Compare prior period</label>
      {zoom && <button className="btn btn-sm" onClick={() => select(range)}>Reset zoom</button>}
    </div>
    <HistoryChart from={from} to={to} points={points} size="large" format={format} series={compare ? traces : undefined}
      utc={!short} loading={live.isFetching || older.isFetching}
      gap={short ? fromRecentProvider ? 25 * 60_000 : HOUR * 3 : DAY * 1.6} onZoom={(interval) => {
        if (interval.to - interval.from >= (short ? 10 * 60_000 : 2 * DAY)) setZoom(interval);
      }} />
    {full && <Timeline bounds={bounds} viewing={{ from, to }} update={setZoom} minWidth={short ? 10 * 60_000 : 2 * DAY} />}
    {(live.isError || older.isError) && <div className="analytics-toolbar text-sm" role="status">
      <span>A platform feed is unavailable. Recorded data is shown where available.</span>
      <button className="btn btn-sm" onClick={() => { void live.refetch(); void older.refetch(); }}>Retry</button>
    </div>}
    {full && <div className="analytics-toolbar">
      <form className="analytics-toolbar" onSubmit={(event) => {
        event.preventDefault();
        const from = Date.parse(start); const to = Math.min(Date.parse(end) + DAY - 1, Date.now());
        if (Number.isFinite(from) && to > from) {
          setRange("All time");
          setZoom({ from, to });
        }
      }}>
        <label>From <input className="field" required type="date" value={start} max={end || isoDay(Date.now())} onChange={(event) => setStart(event.target.value)} /></label>
        <label>To <input className="field" required type="date" value={end} min={start} max={isoDay(Date.now())} onChange={(event) => setEnd(event.target.value)} /></label>
        <button className="btn btn-sm">Apply dates</button>
      </form>
      <button className="btn btn-sm" disabled={!points.length} onClick={() => void saveAnalyticsCsv("UnknownALT-platform-players.csv",
        ["series", "metric", "observed_at_utc", "value", "source", "source_url"], traces.flatMap((trace) =>
          trace.points.map((p) => [trace.label, metric, new Date(p.observedAt ?? p.at).toISOString(), p.value, p.source ?? "",
            p.source?.startsWith("RoWatcher") ? `${WATCH}/roblox-player-count` : `${STATS}/docs/api`]))).catch(toastError)}>Export CSV</button>
    </div>}
    <footer className="analytics-chart-foot">
      <span>Average <strong>{stats.average == null ? "—" : format(stats.average)}</strong></span>
      <span>High <strong>{stats.high == null ? "—" : format(stats.high)}</strong></span>
      <span>Low <strong>{stats.low == null ? "—" : format(stats.low)}</strong></span>
      <span className="basis-full">{missingDays > 0 && `No records for ${fmtNum(missingDays)} UTC days in this view. `}Coverage varies by source. This series starts {source.length ? new Date(allFrom).toLocaleDateString() : "when records become available"}.
        {" "}<Source url={`${WATCH}/roblox-player-count`}>RoWatcher</Source> · <Source url={`${STATS}/docs/api`}>RobloxGameStats</Source></span>
    </footer>
  </section>;
}
