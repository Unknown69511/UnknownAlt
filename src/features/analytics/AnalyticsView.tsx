import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../../api";
import { Icon } from "../../ui/Icon";
import { toast, toastError } from "../../ui/Toast";
import { HistoryChart } from "./HistoryChart";
import { HOUR, historyStats, ranges } from "./history";
import { record, trackGame, useAnalyticsStore, useWatchlistCollector } from "./store";
import type { Creator, PublicGame } from "./types";
import { MyGames } from "./MyGames";

const integer = new Intl.NumberFormat();
const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const number = (value: number | null) => value == null ? "Unavailable" : integer.format(value);
function time(value: number | string) {
  const parsed = typeof value === "string" ? Date.parse(value) : value;
  return Number.isFinite(parsed) ? date.format(parsed) : "Unavailable";
}
function approval(game: PublicGame) {
  const { likes, dislikes } = game;
  return likes != null && dislikes != null && likes + dislikes > 0 ? `${Math.round(likes / (likes + dislikes) * 100)}%` : "Unavailable";
}

export function AnalyticsView() {
  const [view, setView] = useState<"Explore" | "Watchlist" | "My Games">("Explore");
  return <main className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
    <header>
      <h1 className="text-xl font-semibold">Roblox Analytics</h1>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Analytics views">
        {(["Explore", "Watchlist", "My Games"] as const).map((name) =>
          <button key={name} className={view === name ? "btn btn-primary" : "btn"} aria-pressed={view === name} onClick={() => setView(name)}>{name}</button>)}
      </div>
    </header>
    {view === "My Games" ? <MyGames /> : <PublicGames watchOnly={view === "Watchlist"} />}
  </main>;
}

function PublicGames({ watchOnly }: { watchOnly: boolean }) {
  const { watch, records } = useAnalyticsStore();
  const collector = useWatchlistCollector();
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [compare, setCompare] = useState<number[]>([]);
  const query = useQuery({
    queryKey: ["analyticsDiscovery", term], enabled: !watchOnly, retry: false, staleTime: 300_000,
    queryFn: async () => {
      const snapshot = await (term ? api.publicAnalyticsSearch(term) : api.publicAnalyticsTrending());
      record(snapshot, true);
      return snapshot;
    },
  });
  const focused = useQuery({
    queryKey: ["analyticsLive", selected], enabled: selected !== null, retry: false,
    refetchInterval: 60_000, staleTime: 60_000,
    queryFn: async () => {
      const snapshot = await api.publicAnalyticsSnapshot([selected!], true);
      record(snapshot, true);
      return snapshot;
    },
  });
  useEffect(() => {
    if (selected !== null && watchOnly && !watch.includes(selected)) setSelected(null);
  }, [watchOnly, watch, selected]);
  const fallback = !watchOnly && !query.data && query.isError && term === ""
    ? Object.values(records).sort((a, b) => b.observedAt - a.observedAt).slice(0, 12).map((item) => item.game.universeId) : [];
  const visible = watchOnly ? watch : (query.data?.games.map((game) => game.universeId) ?? fallback);
  const details = selected === null ? null : records[selected];
  const picked = compare.flatMap((id) => records[id] ? [records[id].game] : []);
  const toggleWatch = (id: number) => {
    if (!trackGame(id)) toast("The watchlist holds up to 20 games.");
  };
  return <div className="space-y-4">
    {!watchOnly && <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => {
      e.preventDefault();
      const next = input.trim();
      setSelected(null);
      if (next === term) void query.refetch();
      else setTerm(next);
    }}>
      <input className="field flex-1 min-w-40" value={input} maxLength={300} placeholder="Game name, place ID, or Roblox URL" aria-label="Find a Roblox game" onChange={(e) => setInput(e.target.value)} />
      <button className="btn btn-primary" type="submit"><Icon name="search" />Search</button>
      {term && <button className="btn" type="button" onClick={() => { setInput(""); setTerm(""); setSelected(null); }}>Trending games</button>}
    </form>}
    <section className="panel p-4 space-y-3">
      <header className="flex justify-between flex-wrap gap-2 items-center">
        <h2 className="font-semibold">{watchOnly ? "Your watchlist" : term ? "Search results" : "Trending on Roblox"}</h2>
        <button className="btn btn-sm" disabled={watchOnly ? !watch.length || collector.isFetching : query.isFetching}
          onClick={() => void (watchOnly ? collector.refetch() : query.refetch())}><Icon name="refresh" />Refresh</button>
      </header>
      {watchOnly && <p className="text-sm text-fg-2">Watched games are sampled every five minutes while UnknownALT runs.</p>}
      {!watchOnly && query.isPending && <p role="status">Fetching public stats…</p>}
      {(watchOnly ? collector.error : query.error) && <p className="text-sm text-fg-2" role="status">Roblox could not be reached or did not return this data. Saved observations remain available.</p>}
      {!visible.length && (watchOnly || query.isSuccess) && <p className="text-sm text-fg-2">{watchOnly ? "Star a game in Explore to start a watchlist." : term ? "No accessible games matched that search." : "Roblox did not return a trending list."}</p>}
      <div className="grid gap-2 xl:grid-cols-2">
        {visible.map((id) => {
          const entry = records[id];
          if (!entry) return null;
          const { game, observedAt } = entry;
          return <div className="flex items-center gap-3 border border-line rounded-lg p-2 min-w-0" key={id}>
            {game.icon && <img src={game.icon} alt="" width={44} height={44} loading="lazy" className="rounded-md shrink-0" />}
            <button className="flex-1 min-w-0 text-left" type="button" aria-pressed={selected === id} onClick={() => setSelected(selected === id ? null : id)}>
              <span className="block font-medium truncate">{game.name}</span>
              <span className="block text-xs text-fg-2" title={time(observedAt)}>{game.creator.name ?? "Creator unavailable"} · {number(game.playing)}{game.playing != null ? " playing" : ""}</span>
            </button>
            <button className="btn btn-sm" aria-label={watch.includes(id) ? `Remove ${game.name} from watchlist` : `Watch ${game.name}`}
              aria-pressed={watch.includes(id)} onClick={() => toggleWatch(id)}><Icon name="star" fill={watch.includes(id)} /></button>
          </div>;
        })}
      </div>
    </section>
    {details && <GameDetails key={details.game.universeId} {...details} stale={!!focused.error || (focused.isSuccess && !focused.data.games.length)}
      comparing={compare.includes(details.game.universeId)} onCompare={() => {
        const id = details.game.universeId;
        if (compare.includes(id)) setCompare(compare.filter((value) => value !== id));
        else if (compare.length < 3) setCompare([...compare, id]);
        else toast("Compare up to three games at a time.");
      }} />}
    {picked.length > 0 && <Comparison games={picked} remove={(id) => setCompare((list) => list.filter((value) => id !== value))} />}
  </div>;
}

function GameDetails({ game, observedAt, samples, updates, stale, comparing, onCompare }: ReturnType<typeof useAnalyticsStore>["records"][number] &
  { stale: boolean; comparing: boolean; onCompare: () => void }) {
  const [range, setRange] = useState(1);
  const to = Math.max(observedAt, Date.now());
  const from = to - ranges[range][1];
  const recent = samples.filter((point) => point.at >= from);
  const { growth, peak } = historyStats(recent);
  const points = recent.map((point) => ({ at: point.at, value: point.players }));
  return <section className="panel space-y-4 p-4">
    <header className="space-y-2">
      {game.thumbnail && <img src={game.thumbnail} alt="" className="w-full max-h-48 object-cover rounded-lg" />}
      <h2 className="text-lg font-semibold">{game.name}</h2>
      <p className="text-sm text-fg-2">{game.creator.name ?? "Creator unavailable"} · {stale || Date.now() - observedAt > 5 * 60_000 ? "Last saved" : "Roblox snapshot"} {time(observedAt)}</p>
    </header>
    <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
      {([["Concurrent players", number(game.playing)], ["Visits", number(game.visits)], ["Favorites", number(game.favorites)],
        ["Likes", number(game.likes)], ["Approval", approval(game)], ["Latest game update", game.updated ? time(game.updated) : "Unavailable"]] as const).map(([label, value]) =>
        <div className="border border-line rounded-lg p-2" key={label}><dt className="text-fg-2">{label}</dt><dd className="font-semibold">{value}</dd></div>)}
    </dl>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-medium">Concurrent players over time</h3>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Historical range">
        {ranges.map(([label], i) => <button className={range === i ? "btn btn-sm btn-primary" : "btn btn-sm"} key={label} aria-pressed={range === i} onClick={() => setRange(i)}>{label}</button>)}
      </div>
    </div>
    <HistoryChart points={points} from={from} to={to} format={(value) => `${number(value)} players`} gap={ranges[range][1] > 30 * 24 * HOUR ? 72 * HOUR : range > 1 ? 3 * HOUR : 20 * 60_000} />
    <p className="text-sm text-fg-2">Observed peak {number(peak)} · Growth {growth == null ? "Unavailable" : `${growth > 0 ? "+" : ""}${growth.toFixed(1)}%`} · {recent.length} local samples</p>
    <p className="text-xs text-fg-2">Growth compares the first and last observation in this range. Older buckets show observed peaks. Gaps remain when samples were unavailable.</p>
    <details>
      <summary className="font-medium cursor-pointer">Observed game updates</summary>
      {!updates.length && <p className="text-sm text-fg-2">Roblox has no public update timestamp for this game.</p>}
      <ul className="mt-2 space-y-1 text-sm">{[...updates].reverse().map((update) => {
        const at = Date.parse(update);
        const before = samples.slice().reverse().find((point) => point.at < at && point.at >= at - 24 * HOUR);
        const after = samples.find((point) => point.at >= at && point.at <= at + 24 * HOUR);
        return <li key={update}>{time(update)} · {before && after ? `${number(before.players)} → ${number(after.players)} concurrent players around the update` : "No comparable before and after samples"}</li>;
      })}</ul>
    </details>
    <div className="flex flex-wrap gap-2">
      <button className="btn btn-sm" aria-pressed={comparing} onClick={onCompare}>{comparing ? "Remove from comparison" : "Add to comparison"}</button>
      <button className="btn btn-sm" onClick={() => void openUrl(`https://www.roblox.com/games/${game.rootPlaceId}`).catch(toastError)}>Open on Roblox <Icon name="external" /></button>
    </div>
  </section>;
}

function Comparison({ games, remove }: { games: PublicGame[]; remove: (id: number) => void }) {
  const creators = games.flatMap((game, i) => {
    const { creator } = game;
    return creator.id != null && creator.kind && games.findIndex((other) => other.creator.id === creator.id && other.creator.kind === creator.kind) === i ? [creator] : [];
  });
  return <section className="panel p-4 space-y-3">
    <h2 className="font-semibold">Game comparison</h2>
    <div className="overflow-x-auto"><table className="w-full text-sm text-left">
      <thead className="text-fg-2"><tr>{["Game", "Players", "Visits", "Favorites", "Approval", ""].map((label, i) => <th key={i} className="p-2" scope="col">{label}</th>)}</tr></thead>
      <tbody>{games.map((game) => <tr key={game.universeId} className="border-t border-line">
        <th scope="row" className="p-2">{game.name}</th><td>{number(game.playing)}</td><td>{number(game.visits)}</td><td>{number(game.favorites)}</td><td>{approval(game)}</td>
        <td><button className="btn btn-sm" onClick={() => remove(game.universeId)}>Remove</button></td>
      </tr>)}</tbody>
    </table></div>
    <details><summary className="font-medium cursor-pointer">Studio comparison</summary>
      <p className="text-sm text-fg-2 mt-2">Compare up to 25 public games per creator. Totals cover only the returned games.</p>
      <StudioList key={creators.map((creator) => `${creator.kind}:${creator.id}`).join(",")} creators={creators} />
    </details>
  </section>;
}

function StudioList({ creators }: { creators: Creator[] }) {
  const [loaded, setLoaded] = useState(false);
  const query = useQuery({ queryKey: ["analyticsStudios", creators.map((creator) => [creator.id, creator.kind])], enabled: loaded && creators.length > 0,
    retry: false, staleTime: 300_000, queryFn: () => Promise.allSettled(creators.map((creator) => api.publicAnalyticsStudio(creator.id!, creator.kind === "Group"))) });
  return <div className="mt-2 space-y-2">
    <button className="btn btn-sm" disabled={query.isFetching || !creators.length} onClick={() => loaded ? void query.refetch() : setLoaded(true)}>Load studio stats</button>
    {query.isFetching && <p role="status" className="text-sm text-fg-2">Reading Roblox studio stats…</p>}
    {query.data?.map((entry, index) => {
      const label = creators[index].name ?? "Creator";
      if (entry.status === "rejected" || !entry.value.games.length) return <p key={index} className="text-sm">{label} · No public stats available</p>;
      const games = entry.value.games;
      const readings = games.flatMap((game) => game.playing == null ? [] : [game.playing]);
      return <p key={index} className="text-sm">{label} · {readings.length ? number(readings.reduce((a, b) => a + b, 0)) : "Unavailable"} players across {readings.length} of {games.length} games · {time(entry.value.observedAt)}</p>;
    })}
  </div>;
}
