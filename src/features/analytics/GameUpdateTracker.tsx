import { fmtNum } from "../../i18n";
import { useState } from "react";
import { HistoryChart } from "./HistoryChart";
import { HOUR, updateActivity, type Observation } from "./history";
import { DAY, type Daily } from "./archive";
import type { PublicGame } from "./types";
import { followGame, useAnalyticsStore } from "./store";
import { toast } from "../../ui/Toast";

export function FollowButton({ id }: { id: number }) {
  const { follows } = useAnalyticsStore();
  const following = follows.includes(id);
  return <button className="btn btn-sm" aria-pressed={following} onClick={() => {
    if (!followGame(id)) toast("The watchlist holds up to 20 games.", "error");
  }}>{following ? "Unfollow updates" : "Follow updates"}</button>;
}

export function ObservedUpdates({ game, samples, updates, selected, onSelect, daily = [] }: {
  game: PublicGame; samples: Observation[]; updates: string[]; selected?: string;
  onSelect?: (value: string) => void; daily?: Daily[];
}) {
  const [chosen, setChosen] = useState<string>();
  const requested = onSelect ? selected : chosen;
  const latest = requested && updates.includes(requested) ? requested : updates.at(-1);
  if (!latest) return <p className="text-sm text-fg-2">Roblox has not provided an update date for this game.</p>;
  const at = Date.parse(latest);
  if (!Number.isFinite(at)) return <p className="text-sm text-fg-2">Update activity is unavailable.</p>;
  const activity = updateActivity(samples, latest);
  const day = Math.floor(at / DAY) * DAY;
  const available = daily.filter((row): row is Daily & { average: number } => row.average != null);
  const beforeDays = available.filter((row) => row.at >= day - 3 * DAY && row.at < day);
  const afterDays = available.filter((row) => row.at > day && row.at <= day + 3 * DAY);
  const canUseDays = (activity.before.length < 2 || activity.after.length < 2) && beforeDays.length >= 2 && afterDays.length >= 2;
  const avg = (rows: typeof available) => Math.round(rows.reduce((sum, row) => sum + row.average, 0) / rows.length);
  const points = canUseDays
    ? [...beforeDays, ...afterDays].map((row) => ({ at: row.at, value: row.average, source: "RoWatcher · daily average (UTC)" }))
    : [...activity.before, ...activity.after].map((sample) => ({ at: sample.at, value: sample.players, source: "Recorded reading" }));
  const comparison = canUseDays
    ? [[ "Days before", avg(beforeDays), beforeDays.length ], [ "Days after", avg(afterDays), afterDays.length ]] as const
    : [[ "24h before", activity.beforeAverage, activity.before.length ], [ "24h after", activity.afterAverage, activity.after.length ]] as const;
  const reading = (value: number | null, count: number) => value == null ? "No observations" : `${fmtNum(value)} players · ${count} ${canUseDays ? "days" : count === 1 ? "reading" : "readings"}`;
  return <div className="space-y-3" aria-label={`Observed updates for ${game.name}`}>
    <label className="flex flex-wrap items-center gap-2 text-sm">Roblox update date
      <select className="field" value={latest} onChange={(event) => (onSelect ?? setChosen)(event.target.value)}>
        {[...updates].reverse().map((name) => <option key={name} value={name}>{new Date(name).toLocaleString()}</option>)}
      </select>
    </label>
    <dl className="grid gap-2 sm:grid-cols-2 text-sm">
      {comparison.map(([label, value, count]) => <div key={label} className="border border-line rounded-lg p-2"><dt className="text-fg-2">{label} · observed average</dt><dd>{reading(value, count)}</dd></div>)}
    </dl>
    {canUseDays && <p className="text-xs text-fg-2">Up to three complete UTC days on each side. The update date is excluded.</p>}
    {points.length < 4 && <p className="text-xs text-fg-2">There are too few readings to compare the periods reliably.</p>}
    <HistoryChart points={points} from={canUseDays ? day - 3 * DAY : at - DAY} to={canUseDays ? day + 3 * DAY : at + DAY}
      format={(value) => `${fmtNum(value)} players`} gap={canUseDays ? DAY * 1.5 : 2 * HOUR} markers={[{ at, label: "Roblox update" }]} />
  </div>;
}

export function GameUpdateTracker({ open }: { open: (id: number) => void }) {
  const { follows, records, notices } = useAnalyticsStore();
  return <section className="space-y-3">
    <header><h2 className="font-semibold">Game updates</h2><p className="text-sm text-fg-2">Follow games for in-app alerts when Roblox reports a new update date.</p></header>
    {!follows.length && <p className="text-sm text-fg-2">Open a game in Explore or Discover to follow it.</p>}
    {follows.map((id) => {
      const row = records[id];
      return <article className="panel p-4 space-y-3" key={id}>
        <div className="flex flex-wrap gap-2 justify-between items-center">
          <button className="font-semibold text-left" onClick={() => open(id)}>{row?.game.name ?? `Game ${id}`}</button>
          <FollowButton id={id} />
        </div>
        {row ? <ObservedUpdates {...row} /> : <p className="text-sm text-fg-2">Waiting for the first Roblox reading.</p>}
      </article>;
    })}
    {!!notices.length && <details className="panel p-4">
      <summary className="cursor-pointer font-medium">Recent update alerts</summary>
      <ul className="mt-2 space-y-1 text-sm">{notices.map((notice) => <li key={`${notice.id}:${notice.updated}`}>{notice.name} · {new Date(notice.updated).toLocaleString()}</li>)}</ul>
    </details>}
  </section>;
}
