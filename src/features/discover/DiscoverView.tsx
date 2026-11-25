import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "../../ui/Icon";
import { toast, toastError } from "../../ui/Toast";
import { followGame, recordDiscovery, trackGame, useDiscoveryStore } from "./store";
import type { PublicGame } from "./types";
import { approval, category, count, gamesInList, growth, lists, percent, useDiscovery, useGameSearch, useWatchedGames, type List } from "./catalog";
import { RelatedGames } from "./RelatedGames";

const descriptions: Record<List | "Watchlist", string> = {
  Trending: "From the Roblox Trending chart.",
  "Most popular": "From the Roblox Top Playing Now chart.",
  "Fastest-growing": "Based on 24-hour growth in games sampled in Discover. Games need an earlier reading to qualify.",
  "Newly released": "Ordered by Roblox experience creation date in this catalog. Roblox does not report the public launch date here.",
  "Record-breaking": "Games above their recent player counts observed in Discover.",
  Underrated: "Games in this catalog with at least 100 votes and 80% approval, starting with the smallest current audience.",
  Watchlist: "Saved games and updates for the games you follow.",
};

const openRoblox = (game: PublicGame) => void openUrl(`https://www.roblox.com/games/${game.rootPlaceId}`).catch(toastError);

export function DiscoverView({ openGame }: { openGame?: number }) {
  const [list, setList] = useState<List | "Watchlist">(openGame ? "Watchlist" : "Trending");
  const [genre, setGenre] = useState("");
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  const [similar, setSimilar] = useState<PublicGame | null>(null);
  const { watch, follows, records, updates } = useDiscoveryStore();
  const watching = !term && list === "Watchlist";
  const catalog = useDiscovery(!term && !watching);
  const search = useGameSearch(term);
  const watched = useWatchedGames(watch, watching);
  const query = term ? search : watching ? watched : catalog;
  const games = term ? search.data?.games ?? (search.isError
    ? Object.values(records).map(({ game }) => game).filter((game) => game.name.toLowerCase().includes(term.toLowerCase())) : [])
    : watching ? watch.flatMap((id) => records[id] ? [records[id].game] : [])
    : catalog.data ? gamesInList(catalog.data, list as List, records) : [];
  const genres = [...new Set(games.map(category).filter(Boolean))].sort();
  const visible = genre ? games.filter((game) => category(game) === genre) : games;
  const sampled = term ? search.data?.observedAt : watching ? watched.data?.observedAt : catalog.data?.snapshot.observedAt;

  useEffect(() => {
    if (!openGame) return;
    setList("Watchlist");
    setGenre("");
    setTerm("");
    setInput("");
  }, [openGame]);

  const focusGame = watching && !!openGame && !!records[openGame];
  useEffect(() => {
    if (focusGame) document.getElementById(`discover-game-${openGame}`)?.scrollIntoView({ block: "nearest" });
  }, [focusGame, openGame]);

  const loading = query.isPending && (!watching || watch.length > 0);
  return <main className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
    <header className="flex justify-between items-center gap-2">
      <div><h1 className="text-xl font-semibold">Discover</h1><p className="text-sm text-fg-2">Find Roblox games and follow the ones you play.</p></div>
      <button className="btn btn-sm" disabled={query.isFetching || (watching && !watch.length)} onClick={() => void query.refetch()}><Icon name="refresh" />Refresh</button>
    </header>
    <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => {
      event.preventDefault();
      const next = input.trim();
      if (next === term) void query.refetch();
      setTerm(next);
      setGenre("");
    }}>
      <input className="field flex-1 min-w-40" aria-label="Search Discover" placeholder="Game name, place ID, or Roblox URL" value={input} maxLength={300} onChange={(event) => setInput(event.target.value)} />
      <button className="btn btn-primary"><Icon name="search" />Search</button>
      {term && <button type="button" className="btn" onClick={() => { setTerm(""); setInput(""); setGenre(""); }}>Clear search</button>}
      <select className="field md:max-w-48" aria-label="Filter by genre" value={genre} onChange={(event) => setGenre(event.target.value)}>
        <option value="">All categories</option>{genres.map((name) => <option key={name}>{name}</option>)}
      </select>
    </form>
    <div className="flex flex-wrap gap-2" role="group" aria-label="Discovery lists">{[...lists, "Watchlist" as const].map((name) => {
      const active = !term && list === name;
      return <button key={name} className={active ? "btn btn-sm btn-primary" : "btn btn-sm"} aria-pressed={active} onClick={() => {
        setList(name); setGenre(""); setTerm(""); setInput("");
      }}>{name}</button>;
    })}</div>
    {similar && <section className="panel p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{similar.name}</h2>
        <div className="flex gap-1"><button className="btn btn-sm" onClick={() => openRoblox(similar)}>Open game</button>
          <button className="btn btn-sm" onClick={() => setSimilar(null)}>Close</button></div>
      </div>
      <RelatedGames game={similar} select={setSimilar} />
    </section>}
    <p className="text-sm text-fg-2">{term ? `Search results for “${term}”` : descriptions[list]}</p>
    {loading && <p role="status">Loading Roblox games…</p>}
    {(query.isError || (sampled != null && Date.now() - sampled > 600_000)) && <p role="status" className="text-sm text-fg-2">Current Roblox readings are unavailable. Saved readings are shown where available.</p>}
    {!visible.length && !loading && <p className="text-sm text-fg-2">{query.isError ? "No matching saved games." : watching && !watch.length ? "No saved games yet. Use the star on a game to save it." : !term && list === "Fastest-growing" ? "No games have enough observed growth history yet." : "No games match this view."}</p>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {visible.map((game) => {
        const id = game.universeId;
        const rating = approval(game);
        const at = watching ? records[id]?.observedAt : sampled ?? records[id]?.observedAt;
        const change = at == null ? null : growth(game, at, records);
        const saved = watch.includes(id);
        const following = follows.includes(id);
        const dates = updates[id] ?? [];
        const art = game.thumbnail ?? game.icon;
        const preserveGame = () => {
          if (!records[id] && at != null) recordDiscovery({ games: [game], observedAt: at });
        };
        return <article id={`discover-game-${id}`} className="panel overflow-hidden min-w-0 flex flex-col" key={id}>
          {art ? <img src={art} alt="" loading="lazy" className="w-full aspect-video object-cover" /> : <div className="aspect-video grid place-items-center border-b border-line text-fg-2"><Icon name="play" /></div>}
          <div className="p-3 flex flex-col gap-2 flex-1">
            <h2 className="font-semibold line-clamp-2">{game.name}</h2>
            <p className="truncate text-xs text-fg-2">{[game.creator.name, category(game)].filter(Boolean).join(" · ")}</p>
            <dl className="grid grid-cols-3 gap-2 text-xs">
              <div><dt className="text-fg-2">Playing</dt><dd>{count(game.playing)}</dd></div>
              <div><dt className="text-fg-2">Approval</dt><dd>{rating == null ? "Unavailable" : `${Math.round(rating * 100)}%`}</dd></div>
              <div><dt className="text-fg-2">24h growth</dt><dd>{change == null ? "Needs history" : percent(change)}</dd></div>
            </dl>
            {!term && list === "Newly released" && game.created && <p className="text-xs text-fg-2">Created {new Date(game.created).toLocaleDateString()}</p>}
            {watching && at != null && <p className="text-xs text-fg-2">Last read {new Date(at).toLocaleString()}</p>}
            {watching && dates.length > 0 && <details className="text-xs text-fg-2">
              <summary className="cursor-pointer">Last updated {new Date(dates.at(-1)!).toLocaleDateString()}</summary>
              <ul className="my-2 space-y-1">{[...dates].reverse().map((date) => <li key={date}>{new Date(date).toLocaleString()}</li>)}</ul>
            </details>}
            <div className="flex flex-wrap gap-1 mt-auto">
              <button className="btn btn-sm" onClick={() => openRoblox(game)}>Open game</button>
              <button className="btn btn-sm" aria-pressed={saved} aria-label={saved ? `Remove ${game.name} from watchlist` : `Watch ${game.name}`} onClick={() => {
                if (!saved) preserveGame();
                if (!trackGame(id)) toast("The watchlist holds up to 20 games.", "error");
              }}><Icon name="star" fill={saved} /></button>
              <button className="btn btn-sm" onClick={() => setSimilar(game)}>Similar</button>
              <button className="btn btn-sm" aria-pressed={following} onClick={() => {
                preserveGame();
                if (!followGame(id)) toast("The watchlist holds up to 20 games.", "error");
              }}>{following ? "Unfollow updates" : "Follow updates"}</button>
            </div>
          </div>
        </article>;
      })}
    </div>
  </main>;
}
