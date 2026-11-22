import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { readStored, writeStored } from "../../ui/stored";
import { compactSamples, type Observation } from "./history";
import type { PublicGame, PublicSnapshot } from "./types";

type Record = { game: PublicGame; observedAt: number; samples: Observation[]; updates: string[] };
type Data = { watch: number[]; records: { [id: number]: Record } };
const key = "UnknownAlt.analytics.public.v1";
const empty: Data = { watch: [], records: {} };
const maxWatch = 20;
const listeners = new Set<() => void>();

function load(): Data {
  try {
    const raw = readStored(key);
    if (!raw) return empty;
    const data = JSON.parse(raw) as Data;
    return data && Array.isArray(data.watch) && data.records && typeof data.records === "object" ? data : empty;
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
  if (state.watch.includes(id)) save({ ...state, watch: state.watch.filter((value) => value !== id) });
  else if (state.watch.length < maxWatch) save({ ...state, watch: [...state.watch, id] });
  else return false;
  return true;
}

export function record(snapshot: PublicSnapshot, hasMedia: boolean) {
  const records = { ...state.records };
  for (const game of snapshot.games) {
    const old = records[game.universeId];
    if (old && old.observedAt > snapshot.observedAt) continue;
    const previous = old?.game;
    const updates = [...(old?.updates ?? [])];
    if (game.updated && !updates.includes(game.updated)) updates.push(game.updated);
    updates.sort();
    records[game.universeId] = {
      observedAt: snapshot.observedAt,
      game: hasMedia || !previous ? game : { ...game, icon: previous.icon, thumbnail: previous.thumbnail,
        likes: previous.likes, dislikes: previous.dislikes },
      updates: updates.slice(-24),
      samples: compactSamples(old?.samples ?? [], game.playing == null ? null :
        { at: snapshot.observedAt, players: game.playing }, snapshot.observedAt),
    };
  }
  const unwatched = Object.values(records).filter((row) => !state.watch.includes(row.game.universeId))
    .sort((a, b) => b.observedAt - a.observedAt);
  for (const row of unwatched.slice(30)) delete records[row.game.universeId];
  save({ ...state, records });
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
