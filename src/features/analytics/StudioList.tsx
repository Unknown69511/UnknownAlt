import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { count as number } from "../discover/catalog";
import type { Creator } from "./types";

function time(at: number) { return new Date(at).toLocaleString(); }

export function StudioList({ creators }: { creators: Creator[] }) {
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
