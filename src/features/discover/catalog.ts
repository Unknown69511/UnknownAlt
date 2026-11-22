import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { dayChange } from "../analytics/history";
import { record, type GameRecord } from "../analytics/store";
import type { Discovery, PublicGame } from "../analytics/types";

export const lists = ["Trending", "Most popular", "Fastest-growing", "Newly released", "Record-breaking", "Underrated"] as const;
export type List = (typeof lists)[number];
const catalogKey = "UnknownAlt.discovery.v1";
function savedCatalog(): Discovery | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(catalogKey) ?? "null") as Discovery | null;
    return saved?.snapshot?.games?.length ? saved : undefined;
  } catch { return undefined; }
}
export const count = (value: number | null) => value == null ? "Unavailable" : value.toLocaleString();
export function approval(game: PublicGame) {
  const votes = (game.likes ?? 0) + (game.dislikes ?? 0);
  return votes && game.likes != null && game.dislikes != null ? game.likes / votes : null;
}
export const percent = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
export function growth(game: PublicGame, at: number, records: Record<number, GameRecord>) {
  return dayChange(records[game.universeId]?.samples ?? [], at, game.playing);
}
export function category(game: PublicGame) {
  return game.genre && game.genre !== "All" ? game.genre : "";
}
export function gamesInList(catalog: Discovery, list: List, records: Record<number, GameRecord>) {
  const { games, observedAt } = catalog.snapshot;
  if (list === "Trending" || list === "Most popular") {
    const ranks = new Map((list === "Trending" ? catalog.trending : catalog.popular).map((id, i) => [id, i]));
    return games.filter((game) => ranks.has(game.universeId)).sort((a, b) => ranks.get(a.universeId)! - ranks.get(b.universeId)!);
  }
  if (list === "Fastest-growing") {
    return games.flatMap((game) => {
      const change = growth(game, observedAt, records);
      return change != null && change > 0 ? [{ game, change }] : [];
    }).sort((a, b) => b.change - a.change).map((item) => item.game);
  }
  if (list === "Newly released") return games.filter((game) => Number.isFinite(Date.parse(game.created ?? "")))
    .sort((a, b) => Date.parse(b.created!) - Date.parse(a.created!));
  if (list === "Record-breaking") return games.filter((game) => {
    const past = records[game.universeId]?.samples.filter((point) => point.at < observedAt) ?? [];
    return past.length >= 3 && observedAt - past[0].at >= 3_600_000 && game.playing != null && game.playing > Math.max(...past.map((point) => point.players));
  }).sort((a, b) => b.playing! - a.playing!);
  const ranked = games.flatMap((game) => {
    const rating = approval(game);
    return game.playing != null && rating != null && rating >= .8 && (game.likes ?? 0) + (game.dislikes ?? 0) >= 100
      ? [{ game, rating, playing: game.playing }] : [];
  });
  return ranked.sort((a, b) => a.playing - b.playing || b.rating - a.rating).map((item) => item.game);
}
export function useDiscovery(enabled = true) {
  return useQuery({
    queryKey: ["publicDiscovery"], enabled, initialData: savedCatalog,
    initialDataUpdatedAt: () => savedCatalog()?.snapshot.observedAt,
    refetchInterval: 300_000, retry: false, staleTime: 300_000,
    queryFn: async () => {
      const feed = await api.publicDiscovery();
      record(feed.snapshot, true);
      try { localStorage.setItem(catalogKey, JSON.stringify(feed)); } catch { /* caching is optional */ }
      return feed;
    },
  });
}
export function useGameSearch(term: string) {
  return useQuery({
    queryKey: ["publicGameSearch", term], enabled: !!term, retry: false, staleTime: 120_000,
    queryFn: async () => {
      const snapshot = await api.publicAnalyticsSearch(term);
      record(snapshot, true);
      return snapshot;
    },
  });
}
export function nearbyGames(game: PublicGame, catalog: PublicGame[]) {
  const words = (text: string) => (text.toLowerCase().match(/[\p{L}\d]{4,}/gu) ?? []).slice(0, 80);
  const terms = new Set(words(`${game.name} ${game.description ?? ""}`));
  return catalog.flatMap((candidate) => {
    if (candidate.universeId === game.universeId) return [];
    const sameGenre = !!category(game) && category(game) === category(candidate);
    const sameSubgenre = !!game.subgenre && game.subgenre === candidate.subgenre;
    const shared = [...new Set(words(`${candidate.name} ${candidate.description ?? ""}`))].filter((word) => terms.has(word)).length;
    if (!sameGenre && !sameSubgenre && shared < 3) return [];
    return [{ candidate, score: (sameSubgenre ? 8 : 0) + (sameGenre ? 4 : 0) + Math.min(6, shared) }];
  }).sort((a, b) => b.score - a.score).slice(0, 6).map((item) => item.candidate);
}
