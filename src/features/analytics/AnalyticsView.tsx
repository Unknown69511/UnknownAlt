import { useEffect, useState } from "react";
import { Icon } from "../../ui/Icon";
import { DiscoverView } from "../discover/DiscoverView";
import { category, count, useDiscovery, useGameSearch } from "../discover/catalog";
import { GameDetails } from "./GameDetails";
import { GameUpdateTracker } from "./GameUpdateTracker";
import { MyGames } from "./MyGames";
import { trackGame, useAnalyticsStore, useWatchlistCollector } from "./store";
import type { PublicGame } from "./types";

const tabs = ["Overview", "Trending", "Charts", "Genres", "Watchlist", "My Games"] as const;
type Tab = typeof tabs[number];

export function AnalyticsView({ initialGame }: { initialGame?: number }) {
  const [tab, chooseTab] = useState<Tab>("Overview");
  const [selected, open] = useState<number | null>(initialGame ?? null);
  useEffect(() => { if (initialGame != null) open(initialGame); }, [initialGame]);
  return <main className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
    <header className="space-y-3">
      <div><h1 className="text-xl font-semibold">Roblox Analytics</h1></div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Analytics views">
        {tabs.map((name) => <button key={name} className={tab === name ? "btn btn-primary" : "btn"} aria-pressed={tab === name}
          onClick={() => { chooseTab(name); open(null); }}>{name}</button>)}
      </div>
    </header>
    {selected != null ? <GameDetails key={selected} id={selected} select={open} back={() => open(null)} />
      : tab === "My Games" ? <MyGames />
      : tab === "Genres" ? <Genres select={open} />
      : tab === "Watchlist" ? <Watchlist select={open} />
      : tab === "Overview" ? <Overview select={open} />
      : <DiscoverView key={tab} embedded initialList={tab === "Charts" ? "Most popular" : "Trending"} analyze={open} />}
  </main>;
}

function GameList({ games, select }: { games: PublicGame[]; select: (id: number) => void }) {
  return <div className="grid gap-2 md:grid-cols-2">{games.map((game) =>
    <button key={game.universeId} className="panel flex gap-3 p-3 items-center text-start min-w-0" onClick={() => select(game.universeId)}>
      {game.icon && <img src={game.icon} alt="" width={44} height={44} className="rounded-md shrink-0" loading="lazy" />}
      <span className="min-w-0 flex-1"><span className="block font-medium truncate">{game.name}</span>
        <span className="text-sm text-fg-2">{[game.creator.name, category(game)].filter(Boolean).join(" · ")}</span></span>
      <span className="text-sm tabular-nums">{game.playing == null ? "Unavailable" : `${count(game.playing)} playing`}</span>
    </button>)}</div>;
}

function Overview({ select }: { select: (id: number) => void }) {
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  const catalog = useDiscovery(!term);
  const search = useGameSearch(term);
  const { records, watch, follows } = useAnalyticsStore();
  const games = catalog.data?.snapshot.games ?? [];
  const trending = catalog.data?.trending.flatMap((id) => games.filter((game) => game.universeId === id)) ?? [];
  const hits = search.data?.games ?? (search.isError ? Object.values(records).map((row) => row.game)
    .filter((game) => game.name.toLowerCase().includes(term.toLowerCase())) : []);
  const ranked = term ? hits : trending;
  const current = term ? search : catalog;
  return <section className="space-y-4">
    <form className="flex items-center gap-2" onSubmit={(event) => {
      event.preventDefault(); const next = input.trim(); if (term === next) void current.refetch(); else setTerm(next);
    }}>
      <input type="search" className="field flex-1" aria-label="Find a Roblox game" data-find="" placeholder="Game name, place ID, or Roblox URL" maxLength={300}
        value={input} onChange={(event) => setInput(event.target.value)} />
      <button type="submit" className="btn btn-primary"><Icon name="search" />Search</button>
      {term && <button className="btn" type="button" onClick={() => { setTerm(""); setInput(""); }}>Clear</button>}
    </form>
    {!term && <div className="grid gap-2 sm:grid-cols-3">
      <div className="panel p-4"><p className="text-sm text-fg-2">Games in current catalog</p><strong className="text-xl">{catalog.data ? games.length : "—"}</strong></div>
      <div className="panel p-4"><p className="text-sm text-fg-2">Watchlist</p><strong className="text-xl">{watch.length}</strong></div>
      <div className="panel p-4"><p className="text-sm text-fg-2">Following updates</p><strong className="text-xl">{follows.length}</strong></div>
    </div>}
    <h2 className="font-semibold">{term ? "Search results" : "Trending on Roblox"}</h2>
    {current.isFetching && <p role="status" className="text-sm text-fg-2">Loading public Roblox data…</p>}
    {current.isError && <p role="status" className="text-sm text-fg-2">Roblox could not be reached. Saved observations remain available.</p>}
    {current.isSuccess && !ranked.length && <p role="status" className="text-sm text-fg-2">{term ? "No accessible games matched that search." : "No trending games were returned."}</p>}
    <GameList games={ranked} select={select} />
  </section>;
}

function Genres({ select }: { select: (id: number) => void }) {
  const catalog = useDiscovery();
  const [chosen, choose] = useState("");
  const genres = new Map<string, number>();
  for (const game of catalog.data?.snapshot.games ?? []) {
    const name = category(game);
    if (name) genres.set(name, (genres.get(name) ?? 0) + 1);
  }
  return <section className="space-y-3">
    <div className="flex flex-wrap gap-2" role="group" aria-label="Roblox genres">
      {[...genres.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([genre, size]) =>
        <button key={genre} className={chosen === genre ? "btn btn-primary" : "btn"} aria-pressed={chosen === genre}
          onClick={() => choose(genre)}>{genre}<span className="text-xs text-fg-2">{size}</span></button>)}
    </div>
    {catalog.isError && <p className="text-sm">Roblox genres are temporarily unavailable. <button className="btn btn-sm" onClick={() => void catalog.refetch()}>Retry</button></p>}
    {!chosen && <p className="text-sm text-fg-2">{genres.size ? "Choose a genre to browse experiences from the loaded Roblox catalog." : "Waiting for Roblox genre data."}</p>}
    {chosen && <DiscoverView key={chosen} analyze={select} initialGenre={chosen} embedded />}
  </section>;
}

function Watchlist({ select }: { select: (id: number) => void }) {
  const { watch, records } = useAnalyticsStore();
  const query = useWatchlistCollector();
  const [sort, setSort] = useState("added");
  const ids = sort === "players" ? [...watch].sort((a, b) => (records[b]?.game.playing ?? -1) - (records[a]?.game.playing ?? -1)) : watch;
  return <section className="space-y-4">
    <div className="flex items-center flex-wrap gap-2">
      <h2 className="font-semibold flex-1">Saved games</h2>
      <select className="field max-w-40" aria-label="Sort watchlist" value={sort} onChange={(event) => setSort(event.target.value)}>
        <option value="added">Added order</option><option value="players">Most players</option>
      </select>
      <button className="btn btn-sm" disabled={!watch.length || query.isFetching} onClick={() => void query.refetch()}><Icon name="refresh" />Refresh watchlist</button>
    </div>
    {query.isError && <p className="text-sm text-fg-2" role="status">Roblox is unavailable. Showing saved observations.</p>}
    {!ids.length && <p className="text-sm text-fg-2">Save a game from its details or Discover to begin collecting history.</p>}
    <div className="grid gap-2 sm:grid-cols-2">{ids.map((id) => <div className="panel p-3 flex items-center gap-2" key={id}>
      <button className="flex-1 text-start min-w-0" onClick={() => select(id)}><span className="block font-medium truncate">{records[id]?.game.name ?? `Game ${id}`}</span>
        <span className="text-xs text-fg-2">{records[id]?.game.playing == null ? "Waiting for Roblox data" : `${count(records[id].game.playing)} playing`}</span>
      </button>
      <button className="btn btn-sm" aria-label={`Remove ${records[id]?.game.name ?? id} from watchlist`} onClick={() => trackGame(id)}><Icon name="star" fill /></button>
    </div>)}</div>
    <GameUpdateTracker open={select} />
  </section>;
}
