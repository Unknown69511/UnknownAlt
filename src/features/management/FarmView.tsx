import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type AccountSummary, type Instance, type AudioChange } from "../../api";
import { useInstances } from "../../data";
import { requestNavigation } from "../../app/navigation";
import { toastError } from "../../ui/Toast";
import { SmartQueueRow, TroubleshooterDialog, useDiagnosis } from "./Management";
import { Icon, type IconName } from "../../ui/Icon";

function Panel({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return <section className="panel p-4 flex flex-col gap-3 min-w-0">
    <h2 className="font-semibold flex items-center gap-2"><Icon name={icon} />{title}</h2>
    {children}
  </section>;
}

function problem(client: Instance): string | null {
  if (client.signInProblem) return "Sign-in needs attention";
  if (client.state === "disconnected") return "Connection lost";
  if (client.launchStalled) return "Still waiting for Roblox to start";
  return client.note || null;
}

export function FarmView({ accounts = [] }: { accounts?: AccountSummary[] }) {
  const query = useQuery({ queryKey: ["farmStatus"], queryFn: api.farmStatus, refetchInterval: 4000 });
  const diagnosis = useDiagnosis();
  const clients = useInstances();
  const instances = clients.data?.filter((client) => client.state !== "exited") ?? [];
  const warnings = instances.flatMap((client) => {
    const issue = problem(client);
    return issue ? [{ client, issue }] : [];
  });
  const healthy = instances.filter((client) => client.state === "inGame" && !problem(client)).length;
  const preparing = instances.length - healthy - warnings.length;
  const accountName = (id: number) => {
    const account = accounts.find((value) => value.id === id);
    return account?.alias || account?.username || "Managed client";
  };
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
  const usage = query.data?.usage;
  const ram = usage && usage.memTotalMb > 0 ? Math.min(100, 100 * usage.memUsedMb / usage.memTotalMb) : null;
  return <main className="flex flex-col flex-1 min-h-0 overflow-auto gap-4 p-4">
    <header><h1 className="text-xl font-semibold">Farm Control Center</h1><p className="text-fg-2 text-sm">See which clients are running and what needs your attention.</p></header>
    <Panel icon="grid" title="Overview">
      <div className="grid grid-cols-3 gap-3">
        {[[instances.filter((client) => client.pid > 0).length, "Running clients", ""], [healthy, "Healthy sessions", "text-ok"], [warnings.length, "Need attention", warnings.length ? "text-[var(--warn)]" : ""]].map(([count, label, color]) =>
          <div key={label} className="min-w-0 rounded-lg border border-line p-3"><div className={`text-2xl font-semibold tabular-nums ${color}`}>{clients.data ? count : "—"}</div><div className="text-sm text-fg-2">{label}</div></div>)}
      </div>
      {preparing > 0 && <p className="text-sm text-fg-2">{preparing} starting or joining</p>}
      {clients.error && <p role="alert">Could not read running clients.</p>}
    </Panel>
    <div className="grid gap-3 xl:grid-cols-2">
    <Panel icon="alert" title="Problem Detection">
      {clients.data && !warnings.length && <p className="text-sm text-fg-2">{instances.length ? "No client warnings." : "No clients are running."}</p>}
      {warnings.map(({ client, issue }) => <div key={client.id} className="border-s-2 border-[var(--warn)] ps-3">
        <strong className="text-sm">{accountName(client.accountId)}</strong><p className="text-sm text-fg-2">{issue}</p>
      </div>)}
    </Panel>
    <Panel icon="check" title="Recovery Panel">
      {diagnosis.data?.findings.length ? (
        <div><h3 className="text-sm font-medium">{diagnosis.data.findings[0].title}</h3>
          <p className="text-sm text-fg-2">{diagnosis.data.findings[0].solutions[0] ?? diagnosis.data.findings[0].cause}</p></div>
      ) : <p className="text-sm text-fg-2">{diagnosis.isPending ? "Checking for recommended repairs…" : diagnosis.error ? "Run the troubleshooter to check again." : "No repairs recommended."}</p>}
      <button className="btn btn-sm self-start" onClick={() => openTroubleshoot(true)}>{diagnosis.data?.findings.length ? "Review repairs" : "Run troubleshooter"}</button>
    </Panel>
    <Panel icon="gauge" title="Smart Performance">
      <div className="grid grid-cols-2 gap-3">
        {[["CPU", usage?.cpuPct ?? null], ["RAM", ram]].map(([label, value]) => <div key={label} className="text-sm flex flex-col gap-1">
          <p className="flex justify-between"><span>{label}</span><span>{typeof value === "number" ? `${Math.round(value)}%` : "—"}</span></p>
          {typeof value === "number" && <div role="meter" aria-label={String(label)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}
            className="h-1.5 rounded-full bg-[var(--line)] overflow-hidden">
            <div className={`h-full rounded-full ${value >= 85 ? "bg-[var(--warn)]" : "bg-[var(--user-accent)]"}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
          </div>}
        </div>)}
      </div>
      <p className="text-sm text-fg-2">Pause new launches when the PC is busy.</p>
      <details><summary className="cursor-pointer text-sm font-medium">CPU and RAM limits</summary><div className="mt-3"><SmartQueueRow inFarm /></div></details>
      <button className="btn btn-sm self-start" onClick={() => requestNavigation("settings", "performance")}>Advanced performance settings</button>
    </Panel>
    <Panel icon="star" title="Priority Account">
      <p className="text-sm text-fg-2">Keep one account responsive by skipping automatic background limits for it.</p>
      <label className="flex gap-2 items-center text-sm">Account
        <select className="field" disabled={saving || !settings} value={settings?.priorityAccount ?? ""} onChange={(e) => void configure({ priorityAccount: e.target.value ? Number(e.target.value) : null })}>
          <option value="">None</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.alias || a.username}</option>)}
        </select>
      </label>
    </Panel>
    <Panel icon="bell" title="Farm Alerts">
      <p className="text-sm text-fg-2">Get a notification when a session needs attention.</p>
      <div className="flex flex-wrap items-center gap-3">
        <label><input type="checkbox" checked={settings?.localAlerts ?? false} disabled={saving || !settings} onChange={(e) => void configure({ localAlerts: e.target.checked })} /> Local alerts</label>
        <button className="btn btn-sm" onClick={() => requestNavigation("discord")}>Configure Discord alerts</button>
      </div>
    </Panel>
    <Panel icon="sliders" title="Audio Mixer">
      {instances.length === 0 && <p className="text-sm text-fg-2">Volume controls appear when a Roblox client starts.</p>}
      {instances.map((i) => <Mixer key={i.id} instance={i} name={accountName(i.accountId)} />)}
    </Panel>
    <StorageDashboard />
    </div>
    <TroubleshooterDialog open={troubleshoot} onClose={() => openTroubleshoot(false)} />
  </main>;
}

function Mixer({ instance, name }: { instance: Instance; name: string }) {
  const query = useQuery({ queryKey: ["farmAudio", instance.id], queryFn: () => api.farmAudio(instance.id, null), enabled: instance.pid > 0, retry: false, refetchInterval: 5000 });
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
  return <Panel icon="servers" title="Storage Dashboard">
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
  </Panel>;
}
