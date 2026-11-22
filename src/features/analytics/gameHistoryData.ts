import { DAY, HOUR, at, measurements, number, type CcuArchive, type Daily, type SeriesArchive, type VisitReading } from "./archive";
import type { Sample } from "./HistoryChart";
import type { GameRecord } from "./store";

export const utcDay = (time: number) => Math.floor(time / DAY) * DAY;
const WATCH_DAILY = "RoWatcher · recorded daily aggregates (UTC) · CC BY 4.0";
const CCU_DAILY = "CCUCheck · 24 recorded hourly averages (UTC)";
const ROBLOX = "Roblox · saved observation";
const TEN_MINUTES = 10 * 60_000;

export type DailyRecord = Daily & {
  source: string;
  recorded: Sample | undefined;
  visits: number | null;
  totalVisits: number | null;
  visitObservedAt?: number;
  visitProvider?: "Roblox" | "RoWatcher";
  session: number | null;
  approval: number | null;
  favorites: number | null;
  likes: number | null;
};

export type GameTimeline = {
  daily: DailyRecord[];
  hourly: Sample[];
  recent: Sample[];
  local: NonNullable<GameRecord["totals"]>;
  checked: number;
  disagreements: number;
};

export const metrics = { players: "Players", peak: "Daily peak", visits: "Daily visits", total: "Total visits",
  session: "Est. session minutes", favorites: "Favorites", likes: "Likes", approval: "Approval" };
export type HistoryMetric = keyof typeof metrics;

type Input = {
  days?: Daily[] | null;
  totals?: VisitReading[] | null;
  stats?: SeriesArchive | null;
  statsLong?: SeriesArchive | null;
  hourly?: CcuArchive | null;
  recent?: CcuArchive | null;
  saved?: GameRecord;
  created?: string | null;
};

function finiteDate(timestamp: number | null, from: number, to: number): timestamp is number {
  return timestamp != null && timestamp >= from && timestamp <= to;
}

function mergeSamples(buckets: number, ...sources: Sample[][]) {
  const result = new Map<number, Sample>();
  for (const points of sources) {
    const used = new Set<number>();
    for (const point of [...points].reverse()) {
      const key = Math.floor(point.at / buckets);
      if (used.has(key)) continue;
      result.set(key, point);
      used.add(key);
    }
  }
  return [...result.values()].sort((a, b) => a.at - b.at);
}

export function assembleGameTimeline(input: Input, now = Date.now()): GameTimeline {
  const created = at(input.created ?? input.saved?.game.created) ?? 0;
  const begin = utcDay(created);
  const validDay = (date: number | null): date is number => finiteDate(date, begin, now) && date % DAY === 0;
  const days = new Map<number, DailyRecord>();
  const day = (date: number) => {
    let current = days.get(date);
    if (!current) {
      current = { at: date, average: null, low: null, high: null, source: "", recorded: undefined,
        visits: null, totalVisits: null, session: null, approval: null, favorites: null, likes: null };
      days.set(date, current);
    }
    return current;
  };
  for (const row of input.days ?? []) {
    const stamp = at(row?.at);
    if (!validDay(stamp)) continue;
    Object.assign(day(stamp), {
      average: number(row.average), low: number(row.low), high: number(row.high), source: WATCH_DAILY,
    });
  }

  const hourlyBuckets = new Map<number, Map<number, { average: number; low: number | null; high: number | null }>>();
  for (const point of input.hourly?.points ?? []) {
    const stamp = at(point?.t);
    const average = number(point?.players);
    if (!finiteDate(stamp, created, now) || stamp % HOUR !== 0 || average == null) continue;
    const key = utcDay(stamp);
    const bucket = hourlyBuckets.get(key) ?? new Map();
    bucket.set(stamp, { average, low: number(point.low), high: number(point.peak) });
    hourlyBuckets.set(key, bucket);
  }

  let disagreements = 0;
  for (const [date, bucket] of hourlyBuckets) {
    if (bucket.size !== 24 || date + DAY > now) continue;
    const rows = [...bucket.values()];
    const average = rows.reduce((sum, value) => sum + value.average, 0) / rows.length;
    const record = day(date);
    if (record.average != null) {
      const max = Math.max(record.average, average);
      if (max >= 100 && Math.abs(record.average - average) / max > .20) disagreements++;
      continue;
    }
    const lows = rows.flatMap((row) => row.low != null && row.low <= row.average ? [row.low] : []);
    const highs = rows.flatMap((row) => row.high != null && row.high >= row.average ? [row.high] : []);
    Object.assign(record, { average, low: lows.length === 24 ? Math.min(...lows) : null,
      high: highs.length === 24 ? Math.max(...highs) : null, source: CCU_DAILY });
  }

  for (const stats of [input.statsLong, input.stats]) {
    for (const row of stats?.days ?? []) {
      const date = at(row?.t);
      if (!validDay(date)) continue;
      const daily = day(date);
      daily.visits = number(row.visits) ?? daily.visits;
      daily.session = number(row.session) ?? daily.session;
      const approval = number(row.likes);
      if (approval != null && approval <= 100) daily.approval = approval;
    }
    if (stats?.bucketHours !== 24) continue;
    for (const item of stats.hours) {
      const stamp = at(item?.t);
      const value = number(item?.v);
      if (validDay(stamp) && value != null) day(stamp).recorded = { at: stamp, value, source: "RobloxGameStats · daily reading (UTC)" };
    }
  }
  const saved = (input.saved?.totals ?? []).filter((entry) => finiteDate(at(entry.at), created, now));
  for (const row of input.totals ?? []) {
    const stamp = at(row?.at);
    const visits = number(row?.value);
    if (!finiteDate(stamp, created, now) || visits == null) continue;
    const daily = day(utcDay(stamp));
    if (stamp >= (daily.visitObservedAt ?? 0)) {
      daily.totalVisits = visits;
      daily.visitObservedAt = stamp;
      daily.visitProvider = "RoWatcher";
    }
  }
  for (const item of [...saved].reverse()) {
    const daily = day(utcDay(item.at));
    const visits = number(item.visits);
    if (visits != null && item.at >= (daily.visitObservedAt ?? 0)) {
      daily.totalVisits = visits;
      daily.visitObservedAt = item.at;
      daily.visitProvider = "Roblox";
    }
    daily.favorites ??= number(item.favorites);
    daily.likes ??= number(item.likes);
    daily.approval ??= number(item.approval);
  }
  const actual = (rows: Sample[]) => rows.filter((point) => finiteDate(point.at, created, now));
  const local = actual(measurements(input.saved?.samples, (row) => row?.at, (row) => row?.players, ROBLOX));
  const statsHours = input.stats?.bucketHours === 1
    ? actual(measurements(input.stats.hours, (row) => row?.t, (row) => row?.v, "RobloxGameStats · hourly reading")) : [];
  const ccuHours = actual(measurements(input.hourly?.points, (row) => row?.t, (row) => row?.players, "CCUCheck · recorded hourly average"));
  const ccuRecent = actual(measurements(input.recent?.points, (row) => row?.t, (row) => row?.players, "CCUCheck · recorded 10-minute average"));
  // Keep the newest actual Roblox sample even when its current hour is present in an archive.
  const latest = local.at(-1);
  const hours = mergeSamples(HOUR, local, statsHours, ccuHours);
  if (latest && latest.at > (hours.at(-1)?.at ?? -Infinity)) hours.push(latest);
  const detailed = mergeSamples(TEN_MINUTES, ccuRecent, local);
  const coveredHours = new Set(detailed.map((point) => Math.floor(point.at / HOUR)));
  return {
    daily: [...days.values()].sort((a, b) => a.at - b.at),
    hourly: hours,
    recent: [...hours.filter((point) => !coveredHours.has(Math.floor(point.at / HOUR))), ...detailed].sort((a, b) => a.at - b.at),
    local: saved,
    checked: Math.max(at(input.hourly?.asOf) ?? 0, at(input.recent?.asOf) ?? 0, input.saved?.observedAt ?? 0),
    disagreements,
  };
}

export function metricHistory(timeline: GameTimeline, metric: HistoryMetric, daily: boolean, precise = false): Sample[] {
  if (!daily) {
    if (metric === "players") return precise ? timeline.recent : timeline.hourly;
    if (metric === "total" || metric === "favorites" || metric === "likes" || metric === "approval") {
      return measurements(timeline.local, (item) => item.at, (item) => item[metric === "total" ? "visits" : metric], ROBLOX);
    }
  }
  return timeline.daily.flatMap((record) => {
    if (metric === "players" && record.average == null) return record.recorded ? [record.recorded] : [];
    const value = record[metric === "players" ? "average" : metric === "peak" ? "high" : metric === "total" ? "totalVisits" : metric];
    if (value == null) return [];
    const source = metric === "players" || metric === "peak" ? record.source :
      metric === "visits" || metric === "session" ? "RobloxGameStats · daily record (UTC)" :
      metric === "total" ? `${record.visitProvider ?? "Roblox"} · recorded visit total (UTC)` : "Roblox / RobloxGameStats · recorded daily value (UTC)";
    return [{ at: record.at, value, source, observedAt: metric === "total" ? record.visitObservedAt : undefined }];
  });
}

export function coveredAverage(rows: DailyRecord[], days: number, end: number, metric: "average" | "visits" = "average") {
  const entries = rows.filter(({ at }) => at >= end - days * DAY && at < end)
    .flatMap((row) => row[metric] == null ? [] : [row[metric]]);
  const average = entries.length >= Math.ceil(days * .7) ? entries.reduce((sum, value) => sum + value, 0) / entries.length : null;
  return { average, days: entries.length };
}

export function dailyGrowth(rows: DailyRecord[], days: number, end: number, metric: "average" | "visits" = "average") {
  const current = coveredAverage(rows, days, end, metric).average;
  const prior = coveredAverage(rows, days, end - days * DAY, metric).average;
  return current != null && prior != null && prior > 0 ? (current / prior - 1) * 100 : null;
}
