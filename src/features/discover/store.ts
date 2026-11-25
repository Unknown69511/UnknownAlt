import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { json, readStored, writeStored } from "../../ui/stored";
import { signal } from "../../ui/signal";
import { notify } from "../notifications/store";
import type { GameUpdate, PublicGame, PublicSnapshot } from "./types";

export const HOUR = 3_600_000;
const keepFor = 30 * HOUR;
const maxWatch = 20;
const key = "UnknownAlt.discovery.watchlist.v1";
const retiredStore = "UnknownAlt.analytics.public.v1";
type Reading = { at: number; players: number };
export type GameRecord = { game: PublicGame; observedAt: number; samples: Reading[] };
type Data = { watch: number[]; follows: number[]; records: Record<number, GameRecord>; updates: Record<number, string[]> };
type SavedData = Partial<Data> & { records?: Record<number, GameRecord & { updates?: string[] }> };

function readData(data: SavedData | null, migrate: boolean): Data {
  const watch = Array.isArray(data?.watch)
    ? [...new Set(data.watch.filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, maxWatch) : [];
  const follows = Array.isArray(data?.follows)
    ? [...new Set(data.follows.filter((id) => watch.includes(id)))] : [];
  const records: Data["records"] = {};
  const updates: Data["updates"] = {};
  for (const [id, row] of Object.entries(data?.records ?? {})) {
    if (!row?.game || (migrate && !watch.includes(Number(id)))) continue;
    const { universeId, rootPlaceId, name, creator, playing, updated, created, genre, subgenre, description, icon, thumbnail, likes, dislikes } = row.game;
    records[universeId] = {
      game: { universeId, rootPlaceId, name, creator: { name: creator?.name ?? null }, playing, updated, created, genre, subgenre, description, icon, thumbnail, likes, dislikes },
      observedAt: row.observedAt,
      samples: migrate ? [] : (row.samples ?? []),
    };
  }
  for (const id of watch) {
    const dates = migrate ? data?.records?.[id]?.updates : data?.updates?.[id];
    if (Array.isArray(dates)) updates[id] = dates.filter((date) => Number.isFinite(Date.parse(date))).slice(-24);
  }
  return { watch, follows, records, updates };
}

function load() {
  // Only saved games and their Roblox update dates survive. Retire archives and
  // estimates at startup, including on an installation whose Discover page is never opened.
  writeStored("UnknownALT.analytics.archive.v1", null);
  writeStored("UnknownALT.analytics.revenueCurrency", null);
  const saved = json(readStored(key)) as SavedData | null;
  if (saved) {
    writeStored(retiredStore, null);
    return readData(saved, false);
  }
  const legacy = json(readStored(retiredStore)) as SavedData | null;
  const next = readData(legacy, true);
  try {
    // Keep the only copy of the user's watchlist if local storage cannot write.
    if (legacy) localStorage.setItem(key, JSON.stringify(next));
    writeStored(retiredStore, null);
  } catch { /* Migrated saved games remain available for this session. */ }
  return next;
}

let state = load();
const changed = signal();
const read = () => state;
export function useDiscoveryStore() { return useSyncExternalStore(changed.subscribe, read, read); }

function save(next: Data) {
  state = next;
  writeStored(key, JSON.stringify(next));
  changed.notify();
}

export function trackGame(id: number) {
  if (state.watch.includes(id)) {
    const updates = { ...state.updates };
    delete updates[id];
    save({ ...state, updates, watch: state.watch.filter((value) => value !== id), follows: state.follows.filter((value) => value !== id) });
  } else if (state.watch.length >= maxWatch) return false;
  else {
    const date = state.records[id]?.game.updated;
    const updates = date && Number.isFinite(Date.parse(date)) ? { ...state.updates, [id]: [date] } : state.updates;
    save({ ...state, updates, watch: [...state.watch, id] });
  }
  return true;
}

export function followGame(id: number) {
  if (state.follows.includes(id)) save({ ...state, follows: state.follows.filter((value) => value !== id) });
  else {
    if (!state.watch.includes(id) && !trackGame(id)) return false;
    save({ ...state, follows: [...state.follows, id] });
  }
  return true;
}

function recordUpdates(items: GameUpdate[]) {
  const updates = { ...state.updates };
  let updated = false;
  for (const item of items) {
    const id = item.universeId;
    const at = Date.parse(item.updated);
    if (!state.watch.includes(id) || !Number.isFinite(at)) continue;
    const prior = updates[id] ?? [];
    const previous = prior.at(-1);
    if (previous && Date.parse(previous) >= at) continue;
    updates[id] = [...prior, item.updated].slice(-24);
    updated = true;
    if (previous && state.follows.includes(id)) {
      notify("game", `${id}:${item.updated}`, `${item.name} was updated on Roblox.`, { view: "discover", game: id });
    }
  }
  if (updated) save({ ...state, updates });
}

export function recordDiscovery({ games, observedAt }: PublicSnapshot) {
  if (!games.length || !Number.isFinite(observedAt)) return;
  const records = { ...state.records };
  for (const game of games) {
    const id = game.universeId;
    const old = records[id];
    if (old && observedAt <= old.observedAt) continue;
    const samples = (old?.samples ?? []).filter((sample) => observedAt - sample.at <= keepFor);
    if (game.playing != null && game.playing >= 0) {
      const bucket = (at: number) => Math.floor(at / 600_000);
      if (samples.length && bucket(samples.at(-1)!.at) === bucket(observedAt)) samples.pop();
      samples.push({ at: observedAt, players: game.playing });
    }
    const peak = Math.max(0, ...(old?.samples ?? []).filter((sample) => observedAt - sample.at <= keepFor).map((sample) => sample.players));
    if (state.watch.includes(id) && old && old.samples.length >= 3 && observedAt - old.samples[0].at >= HOUR &&
        peak > 0 && game.playing != null && game.playing > peak) {
      notify("watch", `peak:${id}:${new Date(observedAt).toISOString().slice(0, 10)}`,
        `${game.name} reached a new observed player peak.`, { view: "discover", game: id });
    }
    records[id] = { game, observedAt, samples };
  }
  const unwatched = Object.values(records).filter(({ game }) => !state.watch.includes(game.universeId));
  unwatched.sort((a, b) => b.observedAt - a.observedAt);
  for (const row of unwatched.slice(64)) delete records[row.game.universeId];
  save({ ...state, records });
  recordUpdates(games.flatMap(({ universeId, name, updated }) => updated ? [{ universeId, name, updated }] : []));
}

export function useFollowedGameUpdates() {
  const { follows } = useDiscoveryStore();
  useQuery({
    queryKey: ["followedGameUpdates", follows], enabled: follows.length > 0, retry: false,
    refetchInterval: 300_000, refetchIntervalInBackground: true, staleTime: 300_000,
    queryFn: async () => {
      const updates = await api.publicDiscoveryUpdates(follows);
      recordUpdates(updates);
      return updates;
    },
  });
}
