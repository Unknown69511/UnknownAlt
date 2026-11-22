import { useState } from "react";
import { HistoryChart } from "./HistoryChart";
import { HOUR, updateActivity } from "./history";
import { followGame, useAnalyticsStore, type GameRecord } from "./store";
import { toast } from "../../ui/Toast";

export function FollowButton({ id }: { id: number }) {
  const { follows } = useAnalyticsStore();
  const following = follows.includes(id);
  return <button className="btn btn-sm" aria-pressed={following} onClick={() => {
    if (!followGame(id)) toast("The watchlist holds up to 20 games.", "error");
  }}>{following ? "Unfollow updates" : "Follow updates"}</button>;
}

export function ObservedUpdates({ game, samples, updates }: GameRecord) {
  const [chosen, setChosen] = useState<string>();
  const latest = chosen && updates.includes(chosen) ? chosen : updates.at(-1);
  if (!latest) return <p className="text-sm text-fg-2">Roblox has not provided an update date for this game.</p>;
  const at = Date.parse(latest);
  if (!Number.isFinite(at)) return <p className="text-sm text-fg-2">Update activity is unavailable.</p>;
  const activity = updateActivity(samples, latest);
  const points = [...activity.before, ...activity.after].map((sample) => ({ at: sample.at, value: sample.players }));
  const reading = (value: number | null, count: number) => value == null ? "No observations" : `${value.toLocaleString()} players · ${count} ${count === 1 ? "reading" : "readings"}`;
  return <div className="space-y-3" aria-label={`Observed updates for ${game.name}`}>
    <label className="flex flex-wrap items-center gap-2 text-sm">Roblox update date
      <select className="field" value={latest} onChange={(event) => setChosen(event.target.value)}>
        {[...updates].reverse().map((name) => <option key={name} value={name}>{new Date(name).toLocaleString()}</option>)}
      </select>
    </label>
    <dl className="grid gap-2 sm:grid-cols-2 text-sm">
      <div className="border border-line rounded-lg p-2"><dt className="text-fg-2">24h before · observed average</dt><dd>{reading(activity.beforeAverage, activity.before.length)}</dd></div>
      <div className="border border-line rounded-lg p-2"><dt className="text-fg-2">24h after · observed average</dt><dd>{reading(activity.afterAverage, activity.after.length)}</dd></div>
    </dl>
    <HistoryChart points={points} from={at - 24 * HOUR} to={at + 24 * HOUR} format={(value) => `${value.toLocaleString()} players`}
      gap={2 * HOUR} markers={[{ at, label: "Roblox update" }]} />
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
