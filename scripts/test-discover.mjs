import assert from "node:assert/strict";
import { createServer } from "vite";

const stamp = Date.UTC(2025, 0, 10);
const game = {
  universeId: 10, rootPlaceId: 100, name: "Fixture", creator: { name: "Studio" },
  playing: 100, updated: "2025-01-09T00:00:00Z", genre: "Action",
  likes: 90, dislikes: 10, icon: null, thumbnail: null,
};
const oldState = {
  watch: [10], follows: [10], records: {
    10: { game: { ...game, visits: 500 }, observedAt: stamp,
      samples: [{ at: stamp, players: 100 }], totals: [{ at: stamp, visits: 500 }], updates: [game.updated] },
    11: { game: { ...game, universeId: 11 }, observedAt: stamp },
  },
};
const saved = new Map([
  ["UnknownAlt.analytics.public.v1", JSON.stringify(oldState)],
  ["UnknownALT.analytics.archive.v1", "archive"],
  ["UnknownALT.analytics.revenueCurrency", "Both"],
  ["UnknownAlt.notifications.v1", JSON.stringify({ options: { game: false } })],
  ["Unrelated.settings", "retain"],
]);
globalThis.localStorage = {
  getItem: (key) => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, value),
  removeItem: (key) => saved.delete(key),
};
const server = await createServer({ server: { middlewareMode: true, hmr: false },
  appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { recordDiscovery, trackGame, HOUR } = await server.ssrLoadModule("/src/features/discover/store.ts");
  const { growth, gamesInList, nearbyGames } = await server.ssrLoadModule("/src/features/discover/catalog.ts");
  const storageKey = "UnknownAlt.discovery.watchlist.v1";
  const state = () => JSON.parse(saved.get(storageKey));
  assert.equal(saved.has("UnknownAlt.analytics.public.v1"), false);
  assert.equal(saved.has("UnknownALT.analytics.archive.v1"), false);
  assert.equal(saved.has("UnknownALT.analytics.revenueCurrency"), false);
  assert.equal(saved.get("Unrelated.settings"), "retain");
  assert.deepEqual(state().watch, [10]);
  assert.deepEqual(state().follows, [10]);
  assert.deepEqual(state().updates[10], [game.updated]);
  assert.deepEqual(state().records[10].samples, []);
  assert.equal(state().records[10].game.visits, undefined);
  assert.equal(state().records[11], undefined);

  recordDiscovery({ observedAt: stamp + HOUR, games: [game] });
  const current = { ...game, playing: 150, updated: "2025-01-11T00:00:00Z" };
  const snapshot = { observedAt: stamp + 25 * HOUR, games: [current] };
  recordDiscovery(snapshot);
  recordDiscovery({ observedAt: stamp + 2 * HOUR, games: [game] });
  assert.equal(state().records[10].game.playing, 150);
  assert.equal(growth(current, snapshot.observedAt, state().records), 50);
  assert.equal(growth({ ...current, playing: null }, snapshot.observedAt, state().records), null);
  const catalog = { snapshot, trending: [10], popular: [10], rising: [] };
  assert.deepEqual(gamesInList(catalog, "Trending", state().records), [current]);
  assert.deepEqual(gamesInList(catalog, "Fastest-growing", state().records), [current]);
  assert.deepEqual(state().updates[10], [game.updated, current.updated]);
  const related = { ...game, universeId: 11 };
  assert.deepEqual(nearbyGames(game, [game, related]), [related]);
  assert.equal(trackGame(10), true);
  assert.deepEqual(state().watch, []);
  assert.deepEqual(state().follows, []);

  const { afterStartup, dropStartupNotices, finishStartupNotices } = await server.ssrLoadModule("/src/features/notifications/startup.ts");
  const delivered = [];
  afterStartup("game:a", () => delivered.push("first"), 10_000);
  afterStartup("game:a", () => delivered.push("duplicate"), 11_000);
  afterStartup("app:old", () => delivered.push("superseded"), 11_000);
  afterStartup("game:expired", () => delivered.push("expired"), 0);
  dropStartupNotices("app:");
  assert.deepEqual(delivered, []);
  finishStartupNotices(35_000);
  finishStartupNotices(36_000);
  afterStartup("game:new", () => delivered.push("next"), 36_000);
  assert.deepEqual(delivered, ["first", "next"]);
  console.log("Discovery rankings, cache retirement, watchlist migration, and notification queue passed.");
} finally {
  await server.close();
}
