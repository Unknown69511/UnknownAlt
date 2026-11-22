import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../../api";
import { Icon } from "../../ui/Icon";
import { toast, toastError } from "../../ui/Toast";
import { HistoryChart } from "./HistoryChart";
import { HOUR } from "./history";
import type { CreatorMetric, MetricSeries } from "./types";

const metrics: Record<CreatorMetric, string> = {
  active: "Daily active users", newPlayers: "New players", session: "Average session duration (minutes)",
  dayOne: "Day 1 retention", daySeven: "Day 7 retention", revenue: "Revenue (Robux)",
  traffic: "Players by traffic source", payers: "Payer conversion", engagement: "Players by engagement level",
};
const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
const label = (series: MetricSeries) => series.breakdowns.map((part) => part.value).join(" · ") || "All players";
const today = () => new Date().toISOString().slice(0, 10);
const lastWeek = () => new Date(Date.now() - 7 * 24 * HOUR).toISOString().slice(0, 10);

function csvCell(value: string) {
  const safe = /^[\s]*[=+\-@]|^[\t\r\n]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

export function MyGames() {
  const input = useRef<HTMLInputElement>(null);
  const [connected, setConnected] = useState(false);
  const [universe, setUniverse] = useState("");
  const [gameChoices, setGameChoices] = useState<{ id: number; name: string }[]>([]);
  const [lookup, setLookup] = useState("");
  const [metric, setMetric] = useState<CreatorMetric>("active");
  const [start, setStart] = useState(lastWeek);
  const [end, setEnd] = useState(today);
  const [busy, setBusy] = useState(false);
  const [finding, setFinding] = useState(false);
  const [seriesIndex, setSeriesIndex] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ universe: number; metric: CreatorMetric; from: string; to: string; rows: MetricSeries[] } | null>(null);
  const requestVersion = useRef(0);
  useEffect(() => () => {
    requestVersion.current++;
    void api.creatorAnalyticsDisconnect().catch(() => {});
  }, []);

  async function connect() {
    const key = input.current?.value.trim() ?? "";
    if (input.current) input.current.value = "";
    const version = ++requestVersion.current;
    setBusy(true);
    setError("");
    try {
      await api.creatorAnalyticsConnect(key);
      if (requestVersion.current === version) setConnected(true);
      else await api.creatorAnalyticsDisconnect();
    } catch { if (requestVersion.current === version) setError("Enter a valid Roblox Open Cloud API key."); }
    finally { if (requestVersion.current === version) setBusy(false); }
  }

  function disconnect() {
    requestVersion.current++;
    setConnected(false);
    setBusy(false);
    setResult(null);
    setError("");
    void api.creatorAnalyticsDisconnect().catch(toastError);
  }

  async function findGame() {
    setFinding(true);
    setError("");
    try {
      const matches = await api.publicAnalyticsSearch(lookup);
      setGameChoices(matches.games.map((game) => ({ id: game.universeId, name: game.name })));
      if (matches.games.length === 1) setUniverse(String(matches.games[0].universeId));
      if (!matches.games.length) setError("Roblox did not return an accessible experience.");
    } catch { setError("Could not find the experience. You can enter its universe ID directly."); }
    finally { setFinding(false); }
  }

  async function run() {
    const id = Number(universe);
    if (!/^\d+$/.test(universe.trim()) || !Number.isSafeInteger(id) || id < 1) {
      setError("Select a game or enter its universe ID.");
      return;
    }
    const version = ++requestVersion.current;
    setBusy(true); setError(""); setResult(null);
    try {
      const rows = await api.creatorAnalyticsMetrics(id, metric, start, end);
      if (requestVersion.current !== version) return;
      setSeriesIndex(0);
      setResult({ universe: id, metric, from: start, to: end, rows });
    } catch (e) {
      if (requestVersion.current === version) setError(
        typeof e === "object" && e && "message" in e && typeof e.message === "string" ? e.message :
          "Roblox did not provide analytics. Check your connection and experience permissions."
      );
    } finally { if (requestVersion.current === version) setBusy(false); }
  }

  async function exportCsv() {
    if (!result) return;
    try {
      const path = await save({ defaultPath: `UnknownALT-${result.universe}-${result.metric}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
      if (!path) return;
      const rows = result.rows.flatMap((series) => series.dataPoints.map((point) =>
        [String(result.universe), csvCell(metrics[result.metric]), csvCell(label(series)), csvCell(point.time), point.value ?? ""].join(",")));
      await api.creatorAnalyticsExport(path, ["universe,metric,series,time_utc,value", ...rows, ""].join("\r\n"));
      toast("Analytics CSV saved.");
    } catch (e) { toastError(e); }
  }

  const series = result?.rows[seriesIndex];
  const points = series?.dataPoints.flatMap((point) => point.value == null ? [] : [{ at: Date.parse(point.time), value: point.value }]) ?? [];
  return <section className="panel p-4 space-y-4">
    <h2 className="font-semibold">Creator analytics</h2>
    {!connected ? <>
      <p className="text-sm text-fg-2">Use a Roblox Open Cloud API key with only Analytics read permission for the games you choose.</p>
      <form className="flex gap-2 flex-wrap" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
        <input ref={input} className="field flex-1 min-w-40" type="password" aria-label="Read-only Roblox Analytics API key"
          placeholder="Open Cloud API key" required autoComplete="off" spellCheck={false} maxLength={2048} />
        <button className="btn btn-primary" type="submit" disabled={busy}>Connect for this session</button>
        <button className="btn" type="button" onClick={() => void openUrl("https://create.roblox.com/dashboard/credentials").catch(toastError)}>Create a key <Icon name="external" /></button>
      </form>
      <p className="text-xs text-fg-2">The key is kept in memory while this page is open. Creator data is saved only if you export a CSV.</p>
    </> : <>
      <div className="flex items-center gap-2 flex-wrap">
        <p className="text-sm text-fg-2">Connected for this session</p>
        <button className="btn btn-sm" onClick={disconnect}>Forget key</button>
      </div>
      <details>
        <summary className="cursor-pointer font-medium">Find an experience by name or URL</summary>
        <form className="flex gap-2 flex-wrap mt-2" onSubmit={(e) => { e.preventDefault(); void findGame(); }}>
          <input className="field flex-1 min-w-40" aria-label="Find your experience" required maxLength={300} value={lookup} onChange={(e) => setLookup(e.target.value)} />
          <button className="btn" type="submit" disabled={finding}>Find game</button>
        </form>
        {gameChoices.length > 0 && <select className="field mt-2" value={universe} aria-label="Select experience" onChange={(e) => setUniverse(e.target.value)}>
          <option value="">Choose a game</option>
          {gameChoices.map((game) => <option key={game.id} value={game.id}>{game.name}</option>)}
        </select>}
      </details>
      <form className="flex flex-wrap gap-3 items-end" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <label className="text-sm flex flex-col gap-1">Universe ID<input className="field" required inputMode="numeric" value={universe} onChange={(e) => setUniverse(e.target.value)} /></label>
        <label className="text-sm flex flex-col gap-1">Metric<select className="field" value={metric} onChange={(e) => setMetric(e.target.value as CreatorMetric)}>
          {Object.entries(metrics).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        <label className="text-sm flex flex-col gap-1">From (UTC)<input className="field" type="date" value={start} required max={end} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="text-sm flex flex-col gap-1">Through (UTC)<input className="field" type="date" value={end} required min={start} max={today()} onChange={(e) => setEnd(e.target.value)} /></label>
        <button className="btn btn-primary" disabled={busy} type="submit">Load analytics</button>
      </form>
      {busy && <p role="status" className="text-sm text-fg-2">Waiting for Roblox Analytics…</p>}
    </>}
    {error && <p role="alert" className="text-sm text-[var(--warn)]">{error}</p>}
    {result && <div className="space-y-3">
      <header className="flex items-center flex-wrap gap-2 justify-between">
        <div><h3 className="font-medium">{metrics[result.metric]}</h3><p className="text-xs text-fg-2">Roblox Open Cloud · {result.from} to {result.to} (UTC)</p></div>
        <button className="btn btn-sm" disabled={!result.rows.some((row) => row.dataPoints.length)} onClick={() => void exportCsv()}><Icon name="download" />Export CSV</button>
      </header>
      {!result.rows.length && <p className="text-sm text-fg-2">Roblox returned no data for this metric or date range.</p>}
      {result.rows.length > 1 && <label className="flex gap-2 items-center text-sm">Series <select className="field" value={seriesIndex} onChange={(e) => setSeriesIndex(Number(e.target.value))}>
        {result.rows.map((row, i) => <option key={i} value={i}>{label(row)}</option>)}
      </select></label>}
      {!!result.rows.length && <HistoryChart key={seriesIndex} points={points} from={Date.parse(result.from)} to={Date.parse(result.to) + 24 * HOUR}
        format={(value) => format.format(value)} gap={36 * HOUR} />}
    </div>}
  </section>;
}
