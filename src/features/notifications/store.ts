import { useSyncExternalStore } from "react";
import { api } from "../../api";
import { openNotificationTarget, type Request } from "../../app/navigation";
import { readStored, writeStored } from "../../ui/stored";
import { toast } from "../../ui/Toast";
import { afterStartup, dropStartupNotices } from "./startup";

export const categories = {
  friends: "Friend requests", game: "Game updates", app: "UnknownALT updates", announcements: "Roblox announcements",
  outages: "Roblox outages", crashes: "Client crashes", disconnects: "Disconnects", watch: "Watchlist alerts",
} as const;
export type Category = keyof typeof categories;
type Target = Pick<Request, "view" | "game" | "bulletin">;
type Notice = { id: string; key: string; type: Category; text: string; at: number; target: Target; read: boolean };
type State = { options: Record<Category, boolean>; history: Notice[] };
const storageKey = "UnknownAlt.notifications.v1";
const defaults = { friends: false, game: true, app: true, announcements: false, outages: false, crashes: true, disconnects: true, watch: false };
function initial(): State {
  try {
    const existing = JSON.parse(readStored(storageKey) ?? "null") as State | null;
    const legacyOutages = JSON.parse(readStored("UnknownAlt.robloxStatus.v1") ?? "{}")?.alerts === true;
    const options = { ...defaults, outages: legacyOutages };
    for (const type of Object.keys(categories) as Category[]) {
      if (typeof existing?.options?.[type] === "boolean") options[type] = existing.options[type];
    }
    const history = Array.isArray(existing?.history) ? existing.history.slice(0, 100).map((notice) => {
      const view: string = notice.target?.view;
      // Old game alerts still open the saved game from Discover.
      return view === "analytics" ? { ...notice, target: { ...notice.target, view: "discover" as const } } : notice;
    }) : [];
    return { options, history };
  } catch { return { options: defaults, history: [] }; }
}

let state = initial();
const listeners = new Set<() => void>();
const read = () => state;
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function save(next: State) {
  state = next;
  writeStored(storageKey, JSON.stringify(state));
  listeners.forEach((fn) => fn());
}
export function useNotifications() { return useSyncExternalStore(subscribe, read, read); }
export function setNotification(type: Category, enabled: boolean) {
  if (!enabled) dropStartupNotices(`notice:${type}:`);
  save({ ...state, options: { ...state.options, [type]: enabled } });
}
export function openNotice(id: string) {
  const item = state.history.find((notice) => notice.id === id);
  if (!item) return;
  if (!item.read) save({ ...state, history: state.history.map((notice) => notice.id === id ? { ...notice, read: true } : notice) });
  openNotificationTarget(item.target);
}

export function notify(type: Category, key: string, text: string, target: Target) {
  if (!state.options[type]) return;
  afterStartup(`notice:${type}:${key}`, () => deliver(type, key, text, target));
}

function deliver(type: Category, key: string, text: string, target: Target) {
  if (!state.options[type] || state.history.some((notice) => notice.key === key && notice.type === type)) return;
  const item = { id: crypto.randomUUID(), key, type, text: text.slice(0, 240), target, at: Date.now(), read: false };
  save({ ...state, history: [item, ...state.history].slice(0, 100) });
  const popup = () => toast(item.text, "ok", false, "notification", () => openNotice(item.id));
  if (document.visibilityState === "visible" && document.hasFocus()) popup();
  else void api.nativeNotification(item.id, categories[type], item.text).catch(() => {
    if (document.visibilityState === "visible") popup();
  });
}
