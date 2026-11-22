import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { readStored, writeStored } from "../../ui/stored";
import { notify } from "../notifications/store";
import { compactSamples, compactTotals, HOUR, type Observation, type Total } from "./history";
import type { PublicGame, PublicSnapshot } from "./types";

export type MediaVersion = { at: number; urls: string[] };
type MediaHistory = { icons?: MediaVersion[]; thumbnails?: MediaVersion[] };
export type GameRecord = { game: PublicGame; observedAt: number; samples: Observation[]; updates: string[]; totals?: Total[];
  media?: MediaHistory; votesAt?: number };
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

function observedImages(previous: MediaVersion[] | undefined, values: (string | null)[], at: number) {
  const urls = [...new Set(values.filter((raw): raw is string => {
    try {
      const url = new URL(raw ?? "");
      return url.protocol === "https:" && !url.port && !url.username && !url.password && url.hostname.endsWith(".rbxcdn.com");
    } catch { return false; }
  }))].slice(0, 5);
  const last = previous?.at(-1);
  if (!urls.length || last && (at <= last.at || JSON.stringify(last.urls) === JSON.stringify(urls))) return previous;
  return [...previous ?? [], { at, urls }].slice(-12);
}

export function recordThumbnails(id: number, thumbnails: string[], at: number) {
  const old = state.records[id];
  if (!old) return;
  const next = observedImages(old.media?.thumbnails, thumbnails, at);
  if (next === old.media?.thumbnails) return;
  save({ ...state, records: { ...state.records, [id]: { ...old, media: { ...old.media, thumbnails: next } } } });
}

export function record(snapshot: PublicSnapshot, hasMedia: boolean) {
  if (!snapshot.games.length) return;
  const records = { ...state.records };
  const notices: GameUpdate[] = [];
  for (const game of snapshot.games) {
    const old = records[game.universeId];
    const previous = old?.game;
    const icons = hasMedia ? observedImages(old?.media?.icons, [game.icon], snapshot.observedAt) : old?.media?.icons;
    const mediaChanged = icons !== old?.media?.icons;
    const newerVotes = hasMedia && game.likes != null && game.dislikes != null && snapshot.observedAt >= (old?.votesAt ?? 0);
    const media = mediaChanged ? { ...old?.media, icons } : old?.media;
    if (old && old.observedAt > snapshot.observedAt) {
      if (mediaChanged || newerVotes) records[game.universeId] = { ...old, media,
        votesAt: newerVotes ? snapshot.observedAt : old.votesAt,
        game: { ...old.game, icon: mediaChanged ? icons?.at(-1)?.urls[0] ?? old.game.icon : old.game.icon,
          thumbnail: old.game.thumbnail ?? game.thumbnail, likes: newerVotes ? game.likes : old.game.likes,
          dislikes: newerVotes ? game.dislikes : old.game.dislikes } };
      continue;
    }
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
        likes: newerVotes ? game.likes : previous.likes,
        dislikes: newerVotes ? game.dislikes : previous.dislikes },
      media, votesAt: newerVotes ? snapshot.observedAt : old?.votesAt,
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
    sum + row.samples.length * 44 + (row.totals?.length ?? 0) * 102 + JSON.stringify(row.media ?? {}).length + 2500, 0);
  for (const row of unwatched.slice(0, 64).reverse()) {
    if (estimated < 3_600_000) break;
    delete records[row.game.universeId];
    estimated -= row.samples.length * 44 + (row.totals?.length ?? 0) * 102 + JSON.stringify(row.media ?? {}).length + 2500;
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
