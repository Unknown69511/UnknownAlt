import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../../ui/Icon";
import { useGameSearch } from "../discover/catalog";
import { GameDetails } from "./GameDetails";
import { GameUpdateTracker } from "./GameUpdateTracker";
import { MarketOverview, MarketSection, RankedGames, sections, type Section } from "./Market";
import { MyGames } from "./MyGames";
import { trackGame, useAnalyticsStore, useWatchlistCollector } from "./store";
import { count } from "../discover/catalog";
import "./analytics.css";

const icons: Record<Section, IconName> = {
  Overview: "grid", Studios: "accounts", "Top Earners": "star", Games: "play",
  Rising: "rocket", Trends: "bolt", Genres: "palette", Charts: "chart",
  "New Games": "plus", "New Highs": "gauge", Calendar: "clock", Watchlist: "heart", "My Games": "lock",
};

export function AnalyticsView({ initialGame }: { initialGame?: number }) {
  const [tab, chooseTab] = useState<Section>("Overview");
  const [picked, setPicked] = useState<string>();
  const [selection, setSelection] = useState<number[]>(initialGame ? [initialGame] : []);
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  const scroll = useRef<HTMLElement>(null);
  const search = useGameSearch(term);
  const selected = selection.at(-1);
  const saved = useAnalyticsStore().records;
  const open = (id: number) => setSelection((rows) => rows.at(-1) === id ? rows : [...rows, id].slice(-20));
  const go = (section: Section, filter?: string) => {
    chooseTab(section);
    setPicked(filter);
    setSelection([]);
    setTerm("");
    setInput("");
  };
  useEffect(() => { if (initialGame != null) setSelection([initialGame]); }, [initialGame]);
  useEffect(() => { scroll.current?.scrollTo({ top: 0 }); }, [selected, tab, picked, term]);
  const hits = search.data?.games ?? (search.isError ? Object.values(saved).map((row) => row.game)
    .filter((game) => game.name.toLowerCase().includes(term.toLowerCase())) : []);
  return <main ref={scroll} className="analytics-shell flex-1 min-h-0 overflow-auto">
    <div className="analytics-content">
      <header className="analytics-header">
        <div className="analytics-title"><span className="analytics-title-icon"><Icon name="chart" size={23} /></span>
          <div><h1>Roblox Analytics</h1><p className="text-sm text-fg-2">Experience performance, records, and creator insights</p></div></div>
        <form className="analytics-search" onSubmit={(event) => {
          event.preventDefault();
          const next = input.trim();
          setSelection([]);
          if (term === next && next) void search.refetch(); else setTerm(next);
        }}>
          <Icon name="search" /><input type="search" className="field" aria-label="Find a Roblox game" data-find=""
            placeholder="Search games by name or Roblox URL" maxLength={300} value={input} onChange={(event) => setInput(event.target.value)} />
          <button type="submit" className="btn btn-primary">Search</button>
          {term && <button type="button" className="btn" aria-label="Clear game search" onClick={() => { setInput(""); setTerm(""); setSelection([]); }}><Icon name="x" /></button>}
        </form>
      </header>
      <nav className="analytics-nav" aria-label="Analytics sections">
        {sections.map((name) => <button key={name} aria-current={tab === name && !term && !selected ? "page" : undefined}
          onClick={() => go(name)}><Icon name={icons[name]} size={14} />{name}</button>)}
      </nav>
      {selected != null ? <GameDetails key={selected} id={selected} select={open} back={() => setSelection((rows) => rows.slice(0, -1))} />
        : term ? <section className="panel analytics-market-card">
          <header className="analytics-panel-heading"><h2>Results for “{term}”</h2></header>
          {search.isFetching && <p role="status" className="analytics-feedback analytics-loading">Searching Roblox…</p>}
          {search.isError && <p role="status" className="analytics-feedback">Roblox search is unavailable. {hits.length ? "Showing saved matches." : ""}</p>}
          {search.isSuccess && !hits.length && <p role="status" className="analytics-feedback">No accessible games matched the search.</p>}
          <RankedGames games={hits.map((game) => ({ ...game, creator: game.creator.name ?? undefined, iconUrl: game.icon ?? undefined,
            genre: game.genre ?? undefined, playing: game.playing ?? undefined, visits: game.visits ?? undefined }))} select={open} position={false} />
        </section> : tab === "My Games" ? <MyGames /> : tab === "Watchlist" ? <Watchlist select={open} />
          : tab === "Overview" ? <MarketOverview select={open} go={go} /> : <MarketSection key={`${tab}:${picked}`} section={tab} select={open} picked={picked} />}
    </div>
  </main>;
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
