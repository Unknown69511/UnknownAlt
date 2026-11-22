import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { count as number } from "../discover/catalog";
import type { Creator } from "./types";

function time(at: number) { return new Date(at).toLocaleString(); }

export function StudioList({ creators, select, expanded = false }: { creators: Creator[]; select?: (universe: number) => void; expanded?: boolean }) {
  const [loaded, setLoaded] = useState(expanded);
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
      return <div key={index} className="space-y-2">
        <p className="text-sm">{label} · {readings.length ? number(readings.reduce((a, b) => a + b, 0)) : "Unavailable"} players across {readings.length} of {games.length} games · {time(entry.value.observedAt)}</p>
        {select && <ul className="analytics-ranked">{[...games].sort((a, b) => (b.playing ?? -1) - (a.playing ?? -1)).map((game) =>
          <li key={game.universeId}><button className="analytics-rank-row" onClick={() => select(game.universeId)}>
            {game.icon && <img className="analytics-game-icon" src={game.icon} width={42} height={42} alt="" loading="lazy" />}
            <span className="analytics-rank-text"><strong>{game.name}</strong><small>{game.genre}</small></span>
            <span className="analytics-rank-value"><strong>{number(game.playing)}</strong><small>Playing</small></span>
          </button></li>)}</ul>}
      </div>;
    })}
  </div>;
}
