import { useEffect, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { notify, setNotification, useNotifications } from "../notifications/store";
import { incidentHistory, type CurrentStatus, type PastIncident } from "./status-data";

const interval = 15 * 60_000;
const key = "UnknownAlt.robloxStatus.v1";
type Cache = { current?: CurrentStatus; currentAt?: number; history?: PastIncident[]; historyAt?: number; alerts?: boolean };
function loadStatus(): Cache {
  try { return JSON.parse(localStorage.getItem(key) ?? "{}") ?? {}; }
  catch { return {}; }
}
let cache = loadStatus();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function save(next: Cache) {
  cache = next;
  try { localStorage.setItem(key, JSON.stringify(cache)); } catch { /* caching is optional */ }
  for (const listener of listeners) listener();
}
function noteChanges(previous: CurrentStatus, next: CurrentStatus) {
  const incident = next.incidents.find((item) => !previous.incidents.some((old) => old.id === item.id));
  if (incident) notify("outages", incident.id, `Roblox Status: ${incident.name}`, { view: "status" });
  else if (previous.status_overall.status_code !== next.status_overall.status_code) {
    notify("outages", `status:${next.status_overall.updated}:${next.status_overall.status_code}`, `Roblox Status: ${next.status_overall.status}`, { view: "status" });
  } else if (previous.incidents.some((item) => !next.incidents.some((current) => current.id === item.id))) {
    notify("outages", `cleared:${previous.incidents.map((item) => item.id).sort().join(",")}`, "Roblox Status cleared a previously active incident.", { view: "status" });
  }
}
export function setStatusAlerts(alerts: boolean) {
  setNotification("outages", alerts);
}
export function useRobloxStatus(visible = false) {
  const saved = useSyncExternalStore(subscribe, () => cache);
  const alerts = useNotifications().options.outages;
  const stored = { ...saved, alerts };
  const query = useQuery({
    queryKey: ["robloxServiceStatus"], enabled: visible || stored.alerts === true, retry: false,
    refetchInterval: interval, refetchIntervalInBackground: stored.alerts === true, staleTime: interval,
    queryFn: async () => {
      const response = await api.robloxServiceStatus();
      const next = { ...cache };
      if (response.current) {
        if (cache.current) noteChanges(cache.current, response.current);
        next.current = response.current;
        next.currentAt = response.checkedAt;
      }
      if (response.historyHtml) {
        const history = incidentHistory(response.historyHtml);
        if (history.length) {
          next.history = history;
          next.historyAt = response.checkedAt;
        }
      }
      save(next);
      return response.checkedAt;
    },
  });
  const stale = stored.currentAt != null && (query.isError || stored.currentAt !== query.data || Date.now() - stored.currentAt > 2 * interval);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible" && (visible || stored.alerts)) void query.refetch({ cancelRefetch: false }); };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [visible, stored.alerts, query.refetch]);
  return { query, stored, stale };
}
