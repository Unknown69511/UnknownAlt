import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { record, useAnalyticsStore } from "../analytics/store";
import type { PublicGame } from "../analytics/types";
import { category, nearbyGames } from "./catalog";

export function RelatedGames({ game, select, compare }: { game: PublicGame; select: (game: PublicGame) => void; compare?: (game: PublicGame) => void }) {
  const { records } = useAnalyticsStore();
  const official = useQuery({
    queryKey: ["publicSimilarGames", game.universeId], retry: false, staleTime: 600_000,
    queryFn: async () => {
      const snapshot = await api.publicSimilarGames(game.universeId);
      record(snapshot, true);
      return snapshot.games;
    },
  });
  const fromRoblox = !!official.data?.length;
  const related = fromRoblox ? official.data! : nearbyGames(game, Object.values(records).map((item) => item.game));
  return <section className="space-y-2" aria-label="Similar games">
    <h3 className="font-medium">Similar games</h3>
    <p className="text-sm text-fg-2">{fromRoblox ? "Public recommendations from Roblox." : related.length ? "Matches from your loaded games by genre and description." : official.isPending ? "Checking for similar games…" : "No recommendations are available for this game."}</p>
    {!!related.length && <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {related.map((item) => <div className="flex gap-1 min-w-0" key={item.universeId}><button className="btn flex-1 min-w-0 justify-start text-left" onClick={() => select(item)}>
        {item.icon && <img src={item.icon} alt="" width={26} height={26} className="rounded shrink-0" loading="lazy" />}
        <span className="min-w-0"><span className="block truncate">{item.name}</span>{category(item) && <span className="block text-xs text-fg-2 truncate">{category(item)}</span>}</span>
      </button>{compare && <button className="btn btn-sm shrink-0" aria-label={`Compare ${item.name}`} onClick={() => compare(item)}>Compare</button>}</div>)}
    </div>}
  </section>;
}
