import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type AccountSummary, type Instance, type AudioChange } from "../../api";
import { useInstances } from "../../data";
import { requestNavigation } from "../../app/navigation";
import { toastError } from "../../ui/Toast";
import { TroubleshooterDialog } from "./Management";

export function FarmView({ accounts = [] }: { accounts?: AccountSummary[] }) {
  const query = useQuery({ queryKey: ["farmStatus"], queryFn: api.farmStatus, refetchInterval: 4000 });
  const instances = useInstances().data?.filter((client) => client.state !== "exited") ?? [];
  const [troubleshoot, openTroubleshoot] = useState(false);
  const [saving, save] = useState(false);
  const settings = query.data?.settings;
  const configure = async (change: Partial<NonNullable<typeof settings>>) => {
    if (!settings) return;
    save(true);
    try { await api.farmConfigure({ ...settings, ...change }); await query.refetch(); }
    catch (e) { toastError(e); }
    finally { save(false); }
  };
  return <main className="flex flex-col flex-1 min-h-0 overflow-auto gap-4 p-4">
    <h1 className="text-xl font-semibold">Farm Control Center</h1>
    <section className="panel p-3 flex flex-col gap-2">
      <h2 className="font-semibold">Smart Performance</h2>
      <p>CPU {query.data?.usage?.cpuPct == null ? "—" : `${Math.round(query.data.usage.cpuPct)}%`} · RAM {query.data?.usage ? `${Math.round(query.data.usage.memUsedMb)} / ${Math.round(query.data.usage.memTotalMb)} MB` : "—"}</p>
      <label className="flex gap-2 items-center">Priority account
        <select className="field" disabled={saving || !settings} value={settings?.priorityAccount ?? ""} onChange={(e) => void configure({ priorityAccount: e.target.value ? Number(e.target.value) : null })}>
          <option value="">None</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.alias || a.username}</option>)}
        </select>
      </label>
      <p className="text-sm text-fg-2">The priority account is exempt from automatic background CPU limits and RAM throttling. Explicit client limits still apply.</p>
      <div className="flex gap-2 flex-wrap">
        <button className="btn btn-sm" onClick={() => requestNavigation("settings", "performance")}>Performance settings</button>
        <button className="btn btn-sm" onClick={() => requestNavigation("settings", "launching")}>Launch queue settings</button>
      </div>
    </section>
    <section className="panel p-3 flex flex-col gap-2">
      <h2 className="font-semibold">Recovery and alerts</h2>
      {instances.filter((i) => i.note || i.launchStalled || i.state === "disconnected").map((i) => (
        <p key={i.id}>{accounts.find((a) => a.id === i.accountId)?.alias || accounts.find((a) => a.id === i.accountId)?.username || "Managed client"} · {i.note ?? "Disconnected"}</p>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-sm" onClick={() => openTroubleshoot(true)}>Smart Troubleshooter</button>
        <label><input type="checkbox" checked={settings?.localAlerts ?? false} disabled={saving || !settings} onChange={(e) => void configure({ localAlerts: e.target.checked })} /> Local alerts</label>
        <button className="btn btn-sm" onClick={() => requestNavigation("discord")}>Discord alerts</button>
      </div>
    </section>
    <section className="panel p-3 flex flex-col gap-2">
      <h2 className="font-semibold">Audio Mixer</h2>
      {instances.length === 0 && <p>No managed clients running.</p>}
      {instances.map((i) => <Mixer key={i.id} instance={i} name={accounts.find((a) => a.id === i.accountId)?.username ?? "Managed client"} />)}
    </section>
    <StorageDashboard />
    <TroubleshooterDialog open={troubleshoot} onClose={() => openTroubleshoot(false)} />
  </main>;
}

function Mixer({ instance, name }: { instance: Instance; name: string }) {
  const query = useQuery({ queryKey: ["farmAudio", instance.id], queryFn: () => api.farmAudio(instance.id, null), enabled: instance.pid > 0, retry: false });
  const [pending, setPending] = useState(false);
  const [volume, setVolume] = useState<number | null>(null);
  const change = async (next: AudioChange) => {
    setPending(true);
    try { await api.farmAudio(instance.id, next); setVolume(null); await query.refetch(); }
    catch (e) { toastError(e); }
    finally { setPending(false); }
  };
  const audio = query.data;
  return <div className="flex items-center flex-wrap gap-2">
    <strong>{name}</strong>
    {audio?.sessions ? <>
      <input type="range" min={0} max={100} aria-label={`Volume for ${name}`} value={volume ?? audio.volume} onChange={(e) => setVolume(Number(e.target.value))} />
      <span>{volume ?? audio.volume}%</span>
      <button className="btn btn-sm" disabled={pending || volume === null} onClick={() => volume !== null && void change({ volume, muted: null })}>Apply volume</button>
      <button className="btn btn-sm" disabled={pending} onClick={() => void change({ volume: null, muted: !audio.muted })}>{audio.muted ? "Unmute" : "Mute"}</button>
    </> : <span className="text-fg-2">Waiting for a Windows audio session</span>}
    <button className="btn btn-sm" disabled={pending || query.isFetching} onClick={() => void query.refetch()}>Refresh audio</button>
  </div>;
}

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(2)} MB`;

function StorageDashboard() {
  const query = useQuery({ queryKey: ["diskUsage"], queryFn: api.diskUsage, staleTime: 60_000, refetchOnWindowFocus: false });
  const [busy, setBusy] = useState(false);
  const clean = async (cache: boolean) => {
    setBusy(true);
    try { await api.diskCleanup(cache, !cache); await query.refetch(); }
    catch (e) { toastError(e); }
    finally { setBusy(false); }
  };
  const data = query.data;
  return <section className="panel p-3 flex flex-col gap-2">
    <h2 className="font-semibold">Storage Dashboard</h2>
    {query.isFetching && <p role="status">Measuring files…</p>}
    {query.error && <p role="alert">Could not measure all storage.</p>}
    {data && <>
      <p>Data {mb(data.dataBytes)} · Database {mb(data.databaseBytes)} · Backups {mb(data.backupBytes)} · Logs {mb(data.logBytes)}</p>
      <p className="text-sm text-fg-2">{data.cacheRows} cached results · {mb(data.removableLogBytes)} of rotated logs eligible for cleanup</p>
      {data.partial && <p>Some entries could not be counted or were redirected.</p>}
      <div className="flex gap-2">
        <button className="btn btn-sm" disabled={busy || !data.cacheRows} onClick={() => void clean(true)}>Clear cached results</button>
        <button className="btn btn-sm" disabled={busy || !data.removableLogBytes} onClick={() => void clean(false)}>Remove rotated logs</button>
      </div>
      <p className="text-sm text-fg-2">Database space from cleared results is reused by the app. Accounts, settings, backups and the current log are kept.</p>
    </>}
    <button className="btn btn-sm self-start" disabled={busy || query.isFetching} onClick={() => void query.refetch()}>Refresh storage</button>
  </section>;
}
