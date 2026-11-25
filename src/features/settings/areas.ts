import type { Key } from "../../i18n";
import type { IconName } from "../../ui/Icon";
import { SHORTCUTS } from "./shortcuts";

type Category = "general" | "appearance" | "accounts" | "performance" | "farming" | "notifications" | "security" | "storage" | "updates" | "about";
export type SettingsArea = Category | "launching" | "data" | "shortcuts";
export type Panel = "presets" | "bench" | "share" | "keys" | "notifications";

export function settingsCategory(area: SettingsArea): Category {
  if (area === "launching") return "farming";
  if (area === "data") return "storage";
  if (area === "shortcuts") return "general";
  return area;
}

export type AreaDef = { id: Category; label: Key; icon: IconName; description?: Key;
  groups: readonly { label?: Key; ids: readonly string[]; panel?: Panel }[] };

export const AREAS: readonly AreaDef[] = [
  { id: "general", label: "settings.section.general", icon: "settings", groups: [
    { label: "settings.group.window", ids: ["language", "sounds", "motion", "closeToTray", "skipSplash"] },
    { label: "settings.group.ownKeys", ids: SHORTCUTS.map((s) => `key.${s.id}`), panel: "keys" },
    { label: "settings.group.globalKeys", ids: ["keyToggle", "keyTile", "keyMinimize"] },
  ] },
  { id: "appearance", label: "settings.section.appearance", icon: "palette", description: "settings.goal.lookSay", groups: [
    { ids: ["theme", "themes", "look", "lookShare", "accent", "corners", "background", "density", "tabLayout", "numberFormat"] },
  ] },
  { id: "accounts", label: "app.nav.accounts", icon: "accounts", groups: [
    { ids: ["protectLogin", "protectMain", "signInWatch"] },
  ] },
  { id: "performance", label: "performance.title", icon: "gauge", description: "settings.goal.lighterSay", groups: [
    { label: "performance.presets", ids: ["presets", "maxAlts", "balanced", "defaults"], panel: "presets" },
    { label: "performance.bench.title", ids: ["bench"], panel: "bench" },
    { label: "performance.fineTune", ids: ["fpsCap", "lowGraphics", "lighterRendering", "customFlags", "minimize", "tinyOnLaunch", "mute"] },
    { label: "performance.section.cpuMemory", ids: ["adaptive", "fairCap", "spread", "trim", "memThrottle", "memRestart"] },
    { label: "performance.section.UnknownAlt", ids: ["previewFps"] },
    { label: "performance.section.network", ids: ["bandwidth"] },
    { label: "performance.shareTitle", ids: ["share"], panel: "share" },
  ] },
  { id: "farming", label: "settings.section.farming", icon: "wheat", description: "settings.goal.onlineSay", groups: [
    { label: "settings.group.starting", ids: ["multi", "launchDelay", "launchArgs", "smartQueue"] },
    { label: "settings.group.recovery", ids: ["autoRejoin", "autoRestart", "breaker", "restartEvery", "closeAfter", "antiAfk"] },
    { label: "settings.group.stopping", ids: ["panic", "closeGrace", "shutdown"] },
    { label: "settings.client", ids: ["defaultLauncher", "askBrowserLinks"] },
  ] },
  { id: "notifications", label: "settings.section.notifications", icon: "bell", groups: [{ ids: [], panel: "notifications" }] },
  { id: "security", label: "settings.section.security", icon: "shield", description: "settings.goal.protectSay", groups: [
    { ids: ["encryption", "masterPassword", "recoveryCode", "autoLock", "lockOnSessionLock", "clipboard", "lockPurchases", "publicNetworks"] },
  ] },
  { id: "storage", label: "settings.section.storage", icon: "database", description: "settings.goal.dataSay", groups: [
    { ids: ["dataFolder", "backup", "automaticBackups", "cache", "cleanLogs", "browserData"] },
  ] },
  { id: "updates", label: "app.nav.updates", icon: "download", groups: [{ ids: ["privateUpdates", "client", "autoUpdate"] }] },
  { id: "about", label: "settings.section.about", icon: "info", groups: [{ ids: ["rolimons", "version", "replayTour", "support"] }] },
];

export const ROW_IDS: readonly string[] = AREAS.flatMap((a) => a.groups.flatMap((g) => g.panel ? [] : g.ids));
export const CATEGORY_FOR_ROW = new Map(AREAS.flatMap((area) =>
  area.groups.flatMap((group) => group.ids.map((id) => [id, area.id] as const))));
