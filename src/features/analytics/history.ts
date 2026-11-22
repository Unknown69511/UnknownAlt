export type Observation = { at: number; players: number };
export type Total = { at: number; visits?: number; favorites?: number; likes?: number; approval?: number };
export const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const ranges = [["1h", HOUR], ["6h", 6 * HOUR], ["24h", DAY], ["7d", 7 * DAY], ["30d", 30 * DAY], ["1y", 365 * DAY]] as const;

// Keep exact observed samples in recent buckets and the observed maximum of
// older buckets. No data is generated for gaps when the app was offline.
export function compactSamples(previous: Observation[], current: Observation | null, now: number): Observation[] {
  const buckets = new Map<string, Observation>();
  for (const point of current ? [...previous, current] : previous) {
    if (!Number.isFinite(point.at) || !Number.isFinite(point.players) || point.players < 0 || point.at > now + HOUR) continue;
    const age = now - point.at;
    const size = age <= 90 * 60_000 ? 30_000 : age <= DAY ? 5 * 60_000 : age <= 30 * DAY ? HOUR : age <= 365 * DAY ? DAY : 7 * DAY;
    const key = `${size}:${Math.floor(point.at / size)}`;
    const old = buckets.get(key);
    if (!old || (size <= 5 * 60_000 ? point.at >= old.at : point.players >= old.players)) buckets.set(key, point);
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at).slice(-2500);
}

export function compactTotals(previous: Total[], reading: Total) {
  const buckets = new Map<string, Total>();
  for (const point of [...previous, reading]) {
    if (!Number.isFinite(point.at) || point.at > reading.at || Object.keys(point).length < 2) continue;
    const age = reading.at - point.at;
    const width = age <= DAY ? 5 * 60_000 : age <= 30 * DAY ? HOUR : age <= 365 * DAY ? DAY : 7 * DAY;
    for (const metric of ["visits", "favorites", "likes", "approval"] as const) {
      if (point[metric] == null) continue;
      const key = `${metric}:${width}:${Math.floor(point.at / width)}`;
      if ((buckets.get(key)?.at ?? -Infinity) <= point.at) buckets.set(key, point);
    }
  }
  return [...new Set(buckets.values())].sort((a, b) => a.at - b.at).slice(-950);
}

export function summary(values: number[]) {
  if (!values.length) return { average: null, high: null, low: null, growth: null };
  return {
    average: values.reduce((sum, row) => sum + row, 0) / values.length,
    high: Math.max(...values), low: Math.min(...values),
    growth: values.length > 1 && values[0] > 0 ? (values.at(-1)! / values[0] - 1) * 100 : null,
  };
}

export function historyStats(samples: Observation[]) {
  if (!samples.length) return { peak: null, growth: null };
  const first = samples[0].players;
  const last = samples[samples.length - 1].players;
  return {
    peak: samples.reduce((peak, point) => Math.max(peak, point.players), 0),
    growth: samples.length > 1 && first > 0 ? (last - first) / first * 100 : null,
  };
}

export function dayChange(samples: Observation[], at: number, playing: number | null) {
  if (playing == null) return null;
  const expected = at - DAY;
  let baseline: Observation | undefined;
  for (const point of samples) {
    if (Math.abs(point.at - expected) > HOUR) continue;
    if (!baseline || Math.abs(point.at - expected) < Math.abs(baseline.at - expected)) baseline = point;
  }
  if (!baseline || baseline.players === 0) return null;
  return (playing - baseline.players) / baseline.players * 100;
}

export function updateActivity(samples: Observation[], update: string) {
  const at = Date.parse(update);
  const before = samples.filter((point) => point.at >= at - DAY && point.at < at);
  const after = samples.filter((point) => point.at >= at && point.at <= at + DAY);
  const average = (rows: Observation[]) => rows.length ? rows.reduce((sum, point) => sum + point.players, 0) / rows.length : null;
  return { before, after, beforeAverage: average(before), afterAverage: average(after) };
}
