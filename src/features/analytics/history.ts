export type Observation = { at: number; players: number };
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
    if (age > 365 * DAY) continue;
    const size = age <= DAY ? 5 * 60_000 : age <= 30 * DAY ? HOUR : DAY;
    const key = `${size}:${Math.floor(point.at / size)}`;
    const old = buckets.get(key);
    if (!old || (size <= 5 * 60_000 ? point.at >= old.at : point.players >= old.players)) buckets.set(key, point);
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at);
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
  const average = (rows: Observation[]) => rows.length ? Math.round(rows.reduce((sum, point) => sum + point.players, 0) / rows.length) : null;
  return { before, after, beforeAverage: average(before), afterAverage: average(after) };
}
