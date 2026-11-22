import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { PublicGame } from "./types";
import type { Sample } from "./HistoryChart";

export const WATCH = "https://rowatcher.com";
export const STATS = "https://robloxgamestats.com";
export const ROBLOX_CHARTS = "https://www.roblox.com/charts";
export const HOUR = 3_600_000;
export const DAY = HOUR * 24;

export type Daily = { at: number; average: number | null; low: number | null; high: number | null };
type Interval = { t: number; v: number };
export type MarketGame = {
  id?: string | number; universeId?: string | number; name?: string; creator?: string; creatorName?: string;
  creatorId?: string | number; creatorType?: string; genre?: string; genreL1?: string;
  playing?: number; playerCount?: number; iconUrl?: string; thumb?: string; visits?: string | number;
  robloxCreatedAt?: string; robloxUpdatedAt?: string; createdAt?: number; robloxUpdated?: number;
  ccuDeltaPercent24h?: number; change24?: number; estimatedMonthlyRevenueUsd?: number; estimatedDailyRevenueRobux?: number; lastScraped?: string;
  peakAll?: number; recordAt?: number; milestoneAt?: number; milestone?: unknown;
};
export type Studio = { creatorId: string | number; creatorName: string; totalPlaying: string | number; totalVisits: string | number; gameCount: string | number; iconUrl?: string };
export type Portfolio = { games: PublicGame[]; publishedGames: number; complete: boolean; activePlayers: number | null; visits: number | null; observedAt: number };
type Trend = { id: string; name: string; category: string; keywords: string[] };
type LivePlatform = { current: number; recordedAt: string; history: { recordedAt: string; totalCCU: number }[] };
type PlatformArchive = {
  playing: number; hours: Interval[]; days: { t: number; avg: number; peak: number }[];
  genreShare: { genre: string; value: number }[]; trackingSince: number;
};
type SeriesArchive = { bucketHours: number; hours: Interval[]; updates: number[]; days: { t: number; visits: number | null; session: number | null; likes: number | null }[] };
type Profile = { peakAll: number | null; peakAllAt: number | null; session: number | null; ranks: { id: string; rank: number }[] | null;
  updates: number[] | null; milestones: { at?: number; value?: number; type?: string }[] | null; trackingSince: number | null };
type Estimate = { estimate: number | null; robuxPerDay?: number | null; confidence: string | null; genrePercentile: number | null; recordedAt: string | null };
type Archive = {
  platformLive: LivePlatform; platformHistory: PlatformArchive; gameDaily: Daily[]; gameTotals: { at: number; value: number }[]; gameSeries: SeriesArchive; gameArchive: SeriesArchive;
  gameProfile: Profile; gameEstimate: Estimate; officialChart: MarketGame[]; games: MarketGame[];
  records: { recent: MarketGame[]; peaks: MarketGame[]; milestones: MarketGame[]; trackingSince: number };
  newGames: { games: MarketGame[] }; studios: Studio[]; studioPortfolio: Portfolio; studioEstimates: MarketGame[]; trends: Trend[];
};
type Kind = keyof Archive;
type Saved = { at: number; body: unknown; revision?: number };
const CACHE = "UnknownALT.analytics.archive.v1";
const CACHE_AGE = 14 * DAY;
const MAX_CHARACTERS = 1_500_000;

let cacheInMemory: Record<string, Saved> | undefined;
function cached(): Record<string, Saved> {
  if (cacheInMemory) return cacheInMemory;
  try {
    const raw = localStorage.getItem(CACHE);
    if (raw && raw.length <= MAX_CHARACTERS) {
      const saved: unknown = JSON.parse(raw);
      if (saved && typeof saved === "object" && !Array.isArray(saved)) return cacheInMemory = saved as Record<string, Saved>;
    }
  } catch { /* Analytics still works with the in-memory query cache. */ }
  return cacheInMemory = {};
}

function remember(key: string, entry: Saved) {
  try {
    const next = Object.fromEntries(Object.entries(cached())
      .filter(([name, item]) => name !== key && item?.at > Date.now() - CACHE_AGE)
      .sort((a, b) => b[1].at - a[1].at).slice(0, 63));
    const rows: [string, Saved][] = [[key, entry], ...Object.entries(next)];
    while (rows.length) {
      const record = Object.fromEntries(rows);
      const payload = JSON.stringify(record);
      if (payload.length < MAX_CHARACTERS) {
        cacheInMemory = record;
        localStorage.setItem(CACHE, payload);
        return;
      }
      rows.pop();
    }
  } catch { /* A disabled or full cache cannot prevent using the current response. */ }
}

const lists = new Set<Kind>(["gameDaily", "gameTotals", "officialChart", "games", "studios", "studioEstimates", "trends"]);
function recognized(kind: Kind, value: unknown) {
  return value === null || (lists.has(kind) ? Array.isArray(value) : !!value && typeof value === "object" && !Array.isArray(value));
}

export function archiveOptions<K extends Kind>(kind: K, universe?: number, filter?: string, page?: number) {
  const params = [kind, universe ?? null, filter ?? "", page ?? 1] as const;
  const key = params.join(":");
  const saved = cached()[key];
  const valid = saved?.at > Date.now() - CACHE_AGE && recognized(kind, saved.body);
  const live = kind === "platformLive";
  const staleTime = kind === "gameDaily" || kind === "gameArchive" || kind === "gameTotals" ? 12 * HOUR : kind === "trends" ? DAY :
    ["gameSeries", "gameProfile", "gameEstimate", "studios", "studioEstimates"].includes(kind) ? HOUR : live ? 5 * 60_000 : 15 * 60_000;
  return queryOptions({
    queryKey: ["analyticsArchive", ...params], staleTime, gcTime: 20 * 60_000, retry: false,
    initialData: valid ? saved.body as Archive[K] | null : undefined,
    initialDataUpdatedAt: valid ? (saved.revision === 2 ? saved.at : 0) : undefined,
    refetchInterval: live ? staleTime : false, refetchOnWindowFocus: true,
    queryFn: async () => {
      const body = await api.analyticsArchive(kind, universe, filter, page);
      if (!recognized(kind, body)) throw new Error("The analytics provider sent an unsupported response.");
      remember(key, { at: Date.now(), body, revision: 2 });
      return body as Archive[K] | null;
    },
  });
}

export const useArchive = <K extends Kind>(kind: K, universe?: number, filter?: string, page?: number) =>
  useQuery(archiveOptions(kind, universe, filter, page));

export function number(value: unknown): number | null {
  const n = typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
}
export function gameId(game: MarketGame) { return number(game.universeId ?? game.id) ?? 0; }
export function players(game: MarketGame) { return number(game.playing ?? game.playerCount); }
export function thumb(game: MarketGame) {
  const image = game.iconUrl ?? game.thumb;
  try {
    const url = new URL(image ?? "");
    if (url.protocol === "https:" && !url.port && !url.username && !url.password && url.hostname.endsWith(".rbxcdn.com")) return url.href;
  } catch { /* Some games have no public thumbnail. */ }
}
export function at(value: unknown) {
  const time = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(time) && time >= 0 && time <= Date.now() + DAY ? time : null;
}
export function measurements<T>(rows: T[] | undefined | null, timestamp: (item: T) => unknown,
    metric: (item: T) => unknown, source: string): Sample[] {
  const selected = new Map<number, Sample>();
  for (const item of Array.isArray(rows) ? rows : []) {
    const time = at(timestamp(item));
    const value = number(metric(item));
    if (time != null && value != null) selected.set(time, { at: time, value, source });
  }
  return [...selected.values()].sort((a, b) => a.at - b.at);
}
export function growthBetween(data: Sample[], days: number, end = data.at(-1)?.at ?? 0) {
  const start = end - days * DAY;
  const after = data.filter(({ at }) => at > start && at <= end);
  const before = data.filter(({ at }) => at > start - days * DAY && at <= start);
  const required = Math.ceil(days / 2);
  if (after.length < required || before.length < required) return null;
  const avg = (rows: Sample[]) => rows.reduce((sum, point) => sum + point.value, 0) / rows.length;
  const baseline = avg(before);
  return baseline > 0 ? (avg(after) / baseline - 1) * 100 : null;
}
export const charts = [
  ["top-playing-now", "Top Playing Now"], ["top-earning", "Top Earning"], ["top-trending", "Top Trending"],
  ["up-and-coming", "Up-and-Coming"], ["most-popular", "Most Popular"], ["top-revisited", "Top Revisited"],
  ["fun-with-friends", "Fun with Friends"], ["top-rated", "Top Rated"], ["top-paid-access", "Top Paid Access"],
] as const;
