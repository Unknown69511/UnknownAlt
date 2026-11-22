import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { PublicGame } from "./types";
import type { Sample } from "./HistoryChart";

export const WATCH = "https://rowatcher.com";
export const STATS = "https://robloxgamestats.com";
export const CCU = "https://ccucheck.com";
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
export type SeriesArchive = { bucketHours: number; hours: Interval[]; updates: number[]; days: { t: number; visits: number | null; session: number | null; likes: number | null }[] };
export type CcuArchive = { asOf: string; points: { t: string; players: number | null; peak: number | null; low: number | null }[] };
export type VisitReading = { at: number; value: number };
type Profile = { peakAll: number | null; peakAllAt: number | null; session: number | null; ranks: { id: string; rank: number }[] | null;
  updates: number[] | null; milestones: { at?: number; value?: number; type?: string }[] | null; trackingSince: number | null };
type Estimate = { estimate: number | null; robuxPerDay?: number | null; confidence: string | null; genrePercentile: number | null; recordedAt: string | null };
type Archive = {
  platformLive: LivePlatform; platformHistory: PlatformArchive; gameDaily: Daily[]; gameTotals: VisitReading[]; gameSeries: SeriesArchive; gameArchive: SeriesArchive;
  gameHourly: CcuArchive; gameRecent: CcuArchive;
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
      .filter(([name, item]) => name !== key && cacheUsable(name.split(":", 1)[0] as Kind, item))
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

const historyLists = new Set<Kind>(["gameDaily", "gameTotals"]);
const historySeries = new Set<Kind>(["gameSeries", "gameArchive"]);
const ccuSeries = new Set<Kind>(["gameHourly", "gameRecent"]);
const lists = new Set<Kind>(["gameDaily", "gameTotals", "officialChart", "games", "studios", "studioEstimates", "trends"]);

function cacheUsable(kind: Kind, saved: Saved | undefined): saved is Saved {
  if (!saved || !Number.isFinite(saved.at) || !recognized(kind, saved.body)) return false;
  // Historical observations remain useful offline beyond the freshness window for live data.
  const archived = saved.body != null && (historyLists.has(kind) || historySeries.has(kind) || ccuSeries.has(kind));
  return archived || saved.at > Date.now() - CACHE_AGE;
}
function recognized(kind: Kind, value: unknown) {
  if (value == null) return value === null;
  if (lists.has(kind)) return Array.isArray(value);
  if (typeof value !== "object" || Array.isArray(value)) return false;
  if (historySeries.has(kind)) {
    const row = value as SeriesArchive;
    return [1, 2, 6, 24].includes(row.bucketHours) && Array.isArray(row.hours) && Array.isArray(row.days) && Array.isArray(row.updates);
  }
  if (ccuSeries.has(kind)) {
    const row = value as CcuArchive;
    return at(row.asOf) != null && Array.isArray(row.points);
  }
  return true;
}

function mergeArchiveRows<T>(prior: readonly T[], next: readonly T[], date: (row: T) => unknown, limit: number,
    merge: (previous: T, next: T) => T = (_, row) => row) {
  const rows = new Map<number, T>();
  for (const item of [...prior, ...next]) {
    if (item == null) continue;
    const timestamp = at(date(item));
    if (timestamp == null) continue;
    const old = rows.get(timestamp);
    rows.set(timestamp, old == null ? item : merge(old, item));
  }
  return [...rows].sort(([a], [b]) => a - b).slice(-limit).map(([, row]) => row);
}

/** Retain recorded dates across rolling archives, partial responses and provider outages. */
export function reconcileArchive(kind: Kind, previous: unknown, response: unknown): unknown {
  if (!recognized(kind, response)) throw new Error("The analytics provider sent an unsupported response.");
  if (previous == null || !recognized(kind, previous)) return response;
  if (response == null && (historyLists.has(kind) || historySeries.has(kind) || ccuSeries.has(kind))) {
    throw new Error("The provider did not return history. Previously recorded data is still available.");
  }
  if (kind === "gameDaily") {
    if (!(response as Daily[]).length && (previous as Daily[]).length) throw new Error("The provider temporarily returned an empty archive.");
    return mergeArchiveRows(previous as Daily[], response as Daily[], (row) => row.at, 730, (old, row) => {
      // Keep whole aggregates together when their daily reading changes.
      if (number(row.average) != null) return row;
      return number(old.average) == null ? row : old;
    });
  }
  if (kind === "gameTotals") {
    return mergeArchiveRows(previous as VisitReading[], response as VisitReading[], (row) => row.at, 730);
  }
  if (historySeries.has(kind) && response != null) {
    const old = previous as SeriesArchive;
    const incoming = response as SeriesArchive;
    return {
      ...incoming,
      hours: mergeArchiveRows(old.bucketHours === incoming.bucketHours ? old.hours : [], incoming.hours, (row) => row.t, 1500),
      days: mergeArchiveRows(old.days, incoming.days, (row) => row.t, 730, (previous, row) => ({
        t: row.t, visits: number(row.visits) ?? previous.visits, session: number(row.session) ?? previous.session,
        likes: number(row.likes) ?? previous.likes,
      })),
      updates: mergeArchiveRows(old.updates, incoming.updates, (value) => value, 730),
    };
  }
  if (ccuSeries.has(kind) && response != null) {
    const old = previous as CcuArchive;
    const incoming = response as CcuArchive;
    if (Date.parse(incoming.asOf) < Date.parse(old.asOf)) {
      throw new Error("The provider returned an older snapshot. The more recent records are still available.");
    }
    return { ...incoming, points: mergeArchiveRows(old.points, incoming.points.filter((item) => number(item?.players) != null),
      (row) => row.t, kind === "gameHourly" ? 720 : 288) };
  }
  return response;
}

export function archiveOptions<K extends Kind>(kind: K, universe?: number, filter?: string, page?: number) {
  const params = [kind, universe ?? null, filter ?? "", page ?? 1] as const;
  const key = params.join(":");
  const saved = cached()[key];
  const valid = cacheUsable(kind, saved);
  const live = kind === "platformLive" || ccuSeries.has(kind);
  const staleTime = kind === "gameDaily" || kind === "gameArchive" || kind === "gameTotals" ? 6 * HOUR : kind === "trends" ? DAY :
    kind === "gameRecent" ? 10 * 60_000 : kind === "gameHourly" ? 30 * 60_000 :
    ["gameSeries", "gameProfile", "gameEstimate", "studios", "studioEstimates"].includes(kind) ? HOUR : live ? 5 * 60_000 : 15 * 60_000;
  return queryOptions({
    queryKey: ["analyticsArchive", ...params], staleTime, gcTime: 20 * 60_000, retry: false,
    initialData: valid ? saved.body as Archive[K] | null : undefined,
    initialDataUpdatedAt: valid ? (saved.revision === 2 ? saved.at : 0) : undefined,
    refetchInterval: live ? staleTime : false, refetchOnWindowFocus: true,
    queryFn: async ({ signal, client, queryKey }) => {
      const response = await api.analyticsArchive(kind, universe, filter, page);
      // Tauri requests cannot be aborted from the UI. A cancelled request must not write its result
      // to local storage, even though React Query already ignores it in memory.
      signal.throwIfAborted();
      const previous = client.getQueryData(queryKey) ?? cached()[key]?.body;
      const body = reconcileArchive(kind, previous, response);
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
