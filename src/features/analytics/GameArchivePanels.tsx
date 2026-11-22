import { useState } from "react";
import { fmtDate, fmtExact, fmtNum } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { toastError } from "../../ui/Toast";
import { CCU, STATS, WATCH } from "./archive";
import { saveAnalyticsCsv } from "./csv";
import type { DailyRecord } from "./gameHistoryData";
import { Source } from "./Platform";
import type { GameRecord, MediaVersion } from "./store";
import type { PublicGame } from "./types";

const columns = ["UTC date", "Average players", "Low", "Peak", "Other player reading", "Daily visits", "Total visits", "Favorites", "Likes", "Est. session min", "Approval"];
const number = (value: number | null) => value == null ? "—" : fmtNum(value, { maximumFractionDigits: 2 });
const date = (at: number) => fmtDate(at, { dateStyle: "medium", timeZone: "UTC" });
const values = (row: DailyRecord) => [row.average, row.low, row.high, row.recorded?.value ?? null, row.visits, row.totalVisits, row.favorites, row.likes, row.session, row.approval];

export function DailyHistoryTable({ game, days, loadVisits, visitStatus }: {
  game: PublicGame; days: DailyRecord[]; loadVisits: () => void; visitStatus?: "pending" | "error" | "success";
}) {
  const [page, setPage] = useState(0);
  const rows = days.filter((row) => values(row).some((value) => value != null));
  const lastPage = Math.max(0, Math.ceil(rows.length / 30) - 1);
  const current = Math.min(page, lastPage);
  const last = rows.length - current * 30;
  const pageRows = rows.slice(Math.max(0, last - 30), last).reverse();
  return <section className="panel analytics-market-card">
    <header className="analytics-panel-heading">
      <div><h2>Daily History</h2><p className="text-sm text-fg-2">UTC dates with recorded results. Dashes indicate unavailable values.</p></div>
      <div className="analytics-toolbar">
      {visitStatus !== "success" && <button className="btn btn-sm" disabled={visitStatus === "pending"} onClick={loadVisits}>
        {visitStatus === "pending" ? "Loading visit totals…" : visitStatus === "error" ? "Retry visit totals" : "Load archived visit totals"}</button>}
      <button className="btn btn-sm" disabled={!rows.length} onClick={() => void saveAnalyticsCsv(
        `UnknownALT-${game.universeId}-daily.csv`, [...columns, "Player source", "Player source URL", "Engagement source URL", "Total visits source URL"], rows.map((row) => [
          new Date(row.at).toISOString().slice(0, 10), ...values(row).map((value) => value ?? ""),
          row.source || row.recorded?.source || "", row.source.startsWith("RoWatcher") ? `${WATCH}/api/v1/games/${game.universeId}/history.csv?days=730` :
            row.source.startsWith("CCUCheck") ? `${CCU}/games/${game.rootPlaceId}` : row.recorded ? `${STATS}/game/${game.universeId}` : "",
          row.visits != null || row.session != null ? `${STATS}/game/${game.universeId}` : "",
          row.visitProvider === "RoWatcher" ? `${WATCH}/api/v1/games/${game.universeId}/history` :
            row.visitProvider === "Roblox" ? `https://www.roblox.com/games/${game.rootPlaceId}` : "",
        ])).catch(toastError)}><Icon name="download" />Export daily CSV</button>
      </div>
    </header>
    {pageRows.length ? <>
      <div className="analytics-table-scroll" tabIndex={0} aria-label="Daily history table">
        <table className="analytics-daily-table">
          <thead><tr>{columns.map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{pageRows.map((row) => <tr key={row.at}>
            <th scope="row" title={row.source || row.recorded?.source}>{date(row.at)}</th>
            {values(row).map((value, index) => <td key={columns[index + 1]} title={value == null ? "No recorded value" : [fmtExact(value, { maximumFractionDigits: 4 }),
                columns[index + 1] === "Total visits" ? row.visitProvider : null].filter(Boolean).join(" · ")}>
              {number(value)}{columns[index + 1] === "Approval" && value != null ? "%" : ""}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
      <div className="analytics-toolbar">
        <button className="btn btn-sm" disabled={current === 0} onClick={() => setPage(current - 1)}>Newer dates</button>
        <button className="btn btn-sm" disabled={current >= lastPage} onClick={() => setPage(current + 1)}>Older dates</button>
        <span className="text-xs text-fg-2">{date(pageRows.at(-1)!.at)} – {date(pageRows[0].at)} · {fmtNum(rows.length)} dates recorded</span>
      </div>
    </> : <p className="text-sm text-fg-2">Daily records are unavailable for this game.</p>}
    <footer className="analytics-chart-foot">
      <Source url={`${WATCH}/api/v1/games/${game.universeId}/history.csv?days=730`}>RoWatcher (CC BY 4.0)</Source>
      <Source url={`${CCU}/games/${game.rootPlaceId}`}>CCUCheck</Source>
      <Source url={`${STATS}/game/${game.universeId}`}>RobloxGameStats</Source>
    </footer>
  </section>;
}

export function GameMediaHistory({ current, record }: { current: string[]; record?: GameRecord }) {
  const groups: [string, MediaVersion[] | undefined][] = [
    ["Icons", record?.media?.icons], ["Thumbnail sets", record?.media?.thumbnails],
  ];
  return <section className="panel analytics-market-card">
    <header className="analytics-panel-heading"><div><h2>Game Art</h2>
      <p className="text-sm text-fg-2">Current Roblox thumbnails and changes observed by UnknownALT.</p></div></header>
    {current.length > 0 && <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {current.map((url) => <img key={url} className="aspect-video w-full object-cover rounded-lg" src={url} alt="" loading="lazy" />)}
    </div>}
    <details>
      <summary className="cursor-pointer font-medium">Icon and thumbnail history</summary>
      <div className="space-y-3 mt-3">
        {groups.map(([label, versions]) => <section key={label} className="space-y-2"><h3 className="font-semibold text-sm">{label}</h3>
          {versions?.length ? [...versions].reverse().map((entry) => <div className="analytics-media-row" key={entry.at}>
            <time dateTime={new Date(entry.at).toISOString()}>{date(entry.at)}</time>
            <div className="flex flex-wrap gap-2">{entry.urls.map((url) => <img src={url} alt="" loading="lazy" key={url} />)}</div>
          </div>) : <p className="text-sm text-fg-2">No local observations yet.</p>}
        </section>)}
        <p className="text-xs text-fg-2">Dates are first sightings on this PC. Earlier artwork is unavailable through the connected sources.</p>
      </div>
    </details>
  </section>;
}
