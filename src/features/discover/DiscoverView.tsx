import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "../../ui/Icon";
import { toast, toastError } from "../../ui/Toast";
import { record, trackGame, useAnalyticsStore } from "../analytics/store";
import type { PublicGame } from "../analytics/types";
import { approval, category, count, gamesInList, growth, lists, percent, useDiscovery, useGameSearch, type List } from "./catalog";
import { RelatedGames } from "./RelatedGames";
import { FollowButton } from "../analytics/GameUpdateTracker";

const descriptions: Record<List, string> = {
  Trending: "From the Roblox Trending chart.",
  "Most popular": "From the Roblox Top Playing Now chart.",
  "Fastest-growing": "Based on 24-hour growth in games sampled by UnknownALT. Games need an earlier reading to qualify.",
  "Newly released": "Ordered by Roblox experience creation date in this catalog. Roblox does not report the public launch date here.",
  Underrated: "Games in this catalog with at least 100 votes and 80% approval, starting with the smallest current audience.",
};

export function DiscoverView({ analyze }: { analyze: (id: number) => void }) {
  const [list, setList] = useState<List>("Trending");
  const [genre, setGenre] = useState("");
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  const [similar, setSimilar] = useState<PublicGame | null>(null);
  const { watch, records } = useAnalyticsStore();
  const catalog = useDiscovery();
  const search = useGameSearch(term);
  const query = term ? search : catalog;
  const games = term ? search.data?.games ?? (search.isError
    ? Object.values(records).map((item) => item.game).filter((game) => game.name.toLowerCase().includes(term.toLowerCase())) : [])
    : catalog.data ? gamesInList(catalog.data, list, records) : [];
  const genres = [...new Set(games.map(category).filter(Boolean))].sort();
  const visible = genre ? games.filter((game) => category(game) === genre) : games;
  const sampled = term ? search.data?.observedAt : catalog.data?.snapshot.observedAt;
  return <main className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
    <header className="flex justify-between items-center gap-2">
      <div><h1 className="text-xl font-semibold">Discover</h1><p className="text-sm text-fg-2">Find Roblox games and follow the ones you play.</p></div>
      <button className="btn btn-sm" disabled={query.isFetching} onClick={() => void query.refetch()}><Icon name="refresh" />Refresh</button>
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
      <select className="field" aria-label="Filter by category" value={genre} onChange={(event) => setGenre(event.target.value)}>
        <option value="">All categories</option>{genres.map((name) => <option key={name}>{name}</option>)}
      </select>
    </form>
    {!term && <div className="flex flex-wrap gap-2" role="group" aria-label="Discovery charts">{lists.map((name) => <button
      key={name} className={list === name ? "btn btn-sm btn-primary" : "btn btn-sm"} aria-pressed={list === name} onClick={() => { setList(name); setGenre(""); }}>{name}</button>)}</div>}
    {similar && <section className="panel p-4 space-y-2">
      <div className="flex justify-between gap-2"><h2 className="font-semibold">{similar.name}</h2><button className="btn btn-sm" onClick={() => setSimilar(null)}>Close</button></div>
      <RelatedGames game={similar} select={(game) => analyze(game.universeId)} />
    </section>}
    <p className="text-sm text-fg-2">{term ? `Search results for “${term}”` : descriptions[list]}</p>
    {query.isPending && <p role="status">Loading Roblox games…</p>}
    {(query.isError || (sampled != null && Date.now() - sampled > 600_000)) && <p role="status" className="text-sm text-fg-2">Current Roblox readings are unavailable. Saved readings are shown where available.</p>}
    {!visible.length && !query.isPending && <p className="text-sm text-fg-2">{query.isError ? "No matching saved games." : !term && list === "Fastest-growing" ? "No games have enough observed growth history yet." : "No games match this view."}</p>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {visible.map((game) => {
        const rating = approval(game);
        const at = sampled ?? records[game.universeId]?.observedAt;
        const change = at == null ? null : growth(game, at, records);
        const saved = watch.includes(game.universeId);
        const art = game.thumbnail ?? game.icon;
        return <article className="panel overflow-hidden min-w-0 flex flex-col" key={game.universeId}>
          {art ? <img src={art} alt="" loading="lazy" className="w-full aspect-video object-cover" /> : <div className="aspect-video grid place-items-center border-b border-line text-fg-2"><Icon name="play" /></div>}
          <div className="p-3 flex flex-col gap-2 flex-1">
            <button className="text-left font-semibold line-clamp-2" onClick={() => analyze(game.universeId)}>{game.name}</button>
            <p className="truncate text-xs text-fg-2">{[game.creator.name, category(game)].filter(Boolean).join(" · ")}</p>
            <dl className="grid grid-cols-3 gap-2 text-xs">
              <div><dt className="text-fg-2">Playing</dt><dd>{count(game.playing)}</dd></div>
              <div><dt className="text-fg-2">Approval</dt><dd>{rating == null ? "Unavailable" : `${Math.round(rating * 100)}%`}</dd></div>
              <div><dt className="text-fg-2">24h growth</dt><dd>{change == null ? "Needs history" : percent(change)}</dd></div>
            </dl>
            {!term && list === "Newly released" && game.created && <p className="text-xs text-fg-2">Created {new Date(game.created).toLocaleDateString()}</p>}
            <div className="flex flex-wrap gap-1 mt-auto">
              <button className="btn btn-sm" onClick={() => void openUrl(`https://www.roblox.com/games/${game.rootPlaceId}`).catch(toastError)}>Open game</button>
              <button className="btn btn-sm" aria-pressed={saved} aria-label={saved ? `Remove ${game.name} from watchlist` : `Watch ${game.name}`} onClick={() => {
                if (!trackGame(game.universeId)) toast("The watchlist holds up to 20 games.", "error");
                else if (at != null && !saved && !records[game.universeId]) record({ games: [game], observedAt: at }, true);
              }}><Icon name="star" fill={saved} /></button>
              <button className="btn btn-sm" onClick={() => setSimilar(game)}>Similar</button>
              <FollowButton id={game.universeId} />
            </div>
          </div>
        </article>;
      })}
    </div>
  </main>;
}
