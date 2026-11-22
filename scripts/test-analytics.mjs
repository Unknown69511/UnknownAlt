import assert from "node:assert/strict";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true, hmr: false },
  appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { DAY, HOUR, archiveOptions, reconcileArchive } = await server.ssrLoadModule("/src/features/analytics/archive.ts");
  const { assembleGameTimeline, coveredAverage, metricHistory } = await server.ssrLoadModule("/src/features/analytics/gameHistoryData.ts");
  const { groupHistoryMarkers } = await server.ssrLoadModule("/src/features/analytics/HistoryChart.tsx");
  const day = Date.UTC(2025, 0, 10);
  const now = day + 4 * DAY + 4 * HOUR;
  const ccu = { asOf: new Date(now).toISOString(), points: Array.from({ length: 24 }, (_, i) => ({
    t: new Date(day + DAY + i * HOUR).toISOString(), players: 0, low: 0, peak: 0,
  })) };
  const timeline = assembleGameTimeline({
    created: new Date(day + 2 * HOUR).toISOString(),
    days: [{ at: day - DAY, average: 99, low: 1, high: 100 }, { at: day, average: 5, low: 2, high: 7 }],
    hourly: ccu,
    statsLong: { bucketHours: 24, hours: [{ t: day, v: 9999 }, { t: day + 3 * DAY, v: 40 }],
      updates: [], days: [] },
  }, now);
  const points = metricHistory(timeline, "players", true);
  assert.deepEqual(points.map((x) => x.at), [day, day + DAY, day + 3 * DAY], "Merge sources by UTC day without synthetic dates");
  assert.deepEqual(points.map((x) => x.value), [5, 0, 40], "Preserve measured zero and primary provider precedence");
  assert.equal(coveredAverage(timeline.daily, 1, day + 4 * DAY).average, null, "Fallback sample is not a daily average");
  assert.equal(coveredAverage(timeline.daily, 1, day + 2 * DAY).average, 0, "Average of verified zeroes is zero");
  const competing = assembleGameTimeline({ days: [{ at: day + DAY, average: 500, low: 420, high: 600 }], hourly: ccu }, now);
  assert.equal(competing.disagreements, 1);
  assert.equal(metricHistory(competing, "players", true)[0].value, 500);
  const complete = [{ at: day, average: 89 }, { at: day + DAY, average: 0 }];
  const partial = [{ at: day + DAY, average: null }, { at: day + 2 * DAY, average: 42 }];
  assert.deepEqual(reconcileArchive("gameDaily", complete, partial).map((x) => x.average), [89, 0, 42]);
  assert.throws(() => reconcileArchive("gameDaily", complete, null), /Previously recorded/);
  assert.throws(() => reconcileArchive("gameDaily", complete, []), /empty archive/);
  assert.throws(() => reconcileArchive("gameHourly", ccu, {
    asOf: new Date(now - HOUR).toISOString(), points: [],
  }), /older snapshot/);
  assert.deepEqual(groupHistoryMarkers([
    { at: 3, label: "A" }, { at: 1, label: "B" }, { at: 3, label: "A" },
    { at: 16, label: "Too close" }, { at: 60, label: "C" }, { at: 150, label: "Outside" },
  ], 0, 100, 1).map((group) => group.labels), [["B", "A", "Too close"], ["C"]]);
  const savedAt = Date.now() - 45 * DAY;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => JSON.stringify({
    "gameDaily:42::1": { at: savedAt, revision: 2, body: complete },
    "gameEstimate:42::1": { at: savedAt, revision: 2, body: { estimate: 10 } },
  }) } });
  assert.deepEqual(archiveOptions("gameDaily", 42).initialData, complete, "Keep recorded history when the network is unavailable");
  assert.equal(archiveOptions("gameDaily", 42).initialDataUpdatedAt, savedAt);
  assert.equal(archiveOptions("gameEstimate", 42).initialData, undefined, "Leave expired estimates unavailable");
  console.log("Analytics normalization, gaps, cache reconciliation, and marker grouping passed.");
} finally {
  await server.close();
}
