import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { readStored, writeStored } from "../../ui/stored";
import { notify } from "../notifications/store";
import { compactSamples, compactTotals, HOUR, type Observation, type Total } from "./history";
import type { PublicGame, PublicSnapshot } from "./types";

export type GameRecord = { game: PublicGame; observedAt: number; samples: Observation[]; updates: string[]; totals?: Total[] };
export type GameUpdate = { id: number; updated: string; name: string };
type Data = { watch: number[]; follows: number[]; records: { [id: number]: GameRecord }; notices: GameUpdate[] };
const key = "UnknownAlt.analytics.public.v1";
const empty: Data = { watch: [], follows: [], records: {}, notices: [] };
const maxWatch = 20;
const listeners = new Set<() => void>();

function load(): Data {
  try {
    const raw = readStored(key);
    if (!raw) return empty;
    const data = JSON.parse(raw) as Data;
    return data && Array.isArray(data.watch) && data.records && typeof data.records === "object" ? {
      watch: [...new Set(data.watch.filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, maxWatch),
      records: data.records,
      follows: Array.isArray(data.follows) ? data.follows.filter((id) => data.watch.includes(id)) : [],
      notices: Array.isArray(data.notices) ? data.notices.slice(0, 50) : [],
    } : empty;
  } catch { return empty; }
}

let state = load();
const read = () => state;
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};
function save(next: Data) {
  state = next;
  writeStored(key, JSON.stringify(next));
  listeners.forEach((fn) => fn());
}

export function useAnalyticsStore() { return useSyncExternalStore(subscribe, read, read); }

export function trackGame(id: number) {
  if (state.watch.includes(id)) save({ ...state, watch: state.watch.filter((value) => value !== id),
    follows: state.follows.filter((value) => value !== id) });
  else if (state.watch.length < maxWatch) save({ ...state, watch: [...state.watch, id] });
  else return false;
  return true;
}

export function followGame(id: number) {
  if (state.follows.includes(id)) save({ ...state, follows: state.follows.filter((value) => value !== id) });
  else {
    if (!state.watch.includes(id) && state.watch.length >= maxWatch) return false;
    const watch = state.watch.includes(id) ? state.watch : [...state.watch, id];
    save({ ...state, watch, follows: [...state.follows, id] });
  }
  return true;
}

export function record(snapshot: PublicSnapshot, hasMedia: boolean) {
  if (!snapshot.games.length) return;
  const records = { ...state.records };
  const notices: GameUpdate[] = [];
  for (const game of snapshot.games) {
    const old = records[game.universeId];
    if (old && old.observedAt > snapshot.observedAt) continue;
    const previous = old?.game;
    const total: Total = { at: snapshot.observedAt };
    for (const metric of ["visits", "favorites", "likes"] as const) {
      if (game[metric] != null) total[metric] = game[metric];
    }
    if (game.likes != null && game.dislikes != null && game.likes + game.dislikes > 0) {
      total.approval = game.likes / (game.likes + game.dislikes) * 100;
    }
    const updates = [...(old?.updates ?? [])];
    if (game.updated && Number.isFinite(Date.parse(game.updated)) && !updates.includes(game.updated)) {
      const latest = updates.reduce((max, at) => Math.max(max, Date.parse(at) || 0), 0);
      if (latest && Date.parse(game.updated) > latest && state.follows.includes(game.universeId)) {
        notices.push({ id: game.universeId, updated: game.updated, name: game.name });
      }
      updates.push(game.updated);
    }
    updates.sort((a, b) => Date.parse(a) - Date.parse(b));
    records[game.universeId] = {
      observedAt: snapshot.observedAt,
      game: !previous ? game : { ...game, icon: game.icon ?? previous.icon, thumbnail: game.thumbnail ?? previous.thumbnail,
        likes: hasMedia ? game.likes ?? previous.likes : previous.likes,
        dislikes: hasMedia ? game.dislikes ?? previous.dislikes : previous.dislikes },
      updates: updates.slice(-24),
      samples: compactSamples(old?.samples ?? [], game.playing == null ? null :
        { at: snapshot.observedAt, players: game.playing }, snapshot.observedAt),
      totals: compactTotals(old?.totals ?? [], total),
    };
    const peak = old?.samples?.reduce((highest, row) => Math.max(highest, row.players), 0) ?? 0;
    if (state.watch.includes(game.universeId) && old && old.samples.length >= 3 &&
        snapshot.observedAt - old.samples[0].at >= HOUR && peak > 0 && game.playing != null && game.playing > peak) {
      notify("watch", `peak:${game.universeId}:${new Date(snapshot.observedAt).toISOString().slice(0, 10)}`,
        `${game.name} reached a new observed player peak.`, { view: "analytics", game: game.universeId });
    }
  }
  const unwatched = Object.values(records).filter((row) => !state.watch.includes(row.game.universeId))
    .sort((a, b) => b.observedAt - a.observedAt);
  for (const row of unwatched.slice(64)) delete records[row.game.universeId];
  // Make room for watched histories and other WebView storage. Trim only the
  // oldest temporary, unwatched catalogue entries if the store grows large.
  let estimated = Object.values(records).reduce((sum, row) =>
    sum + row.samples.length * 44 + (row.totals?.length ?? 0) * 102 + 2500, 0);
  for (const row of unwatched.slice(0, 64).reverse()) {
    if (estimated < 3_600_000) break;
    delete records[row.game.universeId];
    estimated -= row.samples.length * 44 + (row.totals?.length ?? 0) * 102 + 2500;
  }
  save({ ...state, records, notices: [...notices, ...state.notices].slice(0, 50) });
  for (const item of notices) notify("game", `${item.id}:${item.updated}`, `${item.name} was updated on Roblox.`, { view: "analytics", game: item.id });
}

/** A single batched refresh every five minutes while the app is open. */
export function useWatchlistCollector() {
  const { watch } = useAnalyticsStore();
  return useQuery({
    queryKey: ["analyticsWatch", watch], enabled: watch.length > 0, retry: false,
    refetchInterval: 300_000, refetchIntervalInBackground: true, staleTime: 300_000,
    queryFn: async () => {
      const snapshot = await api.publicAnalyticsSnapshot(watch, false);
      record(snapshot, false);
      return snapshot.observedAt;
    },
  });
}
