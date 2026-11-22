import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "../../ui/Icon";
import { toastError } from "../../ui/Toast";
import { incidentUrl, STATUS_HOME, type Service } from "./status-data";
import { setStatusAlerts, useRobloxStatus } from "./useRobloxStatus";

const link = (url: string) => void openUrl(url).catch(toastError);

function ServiceState({ service }: { service: Service }) {
  return <span className={service.status_code === 100 ? "text-ok" : "text-warn"}>{service.status}</span>;
}

export function StatusView() {
  const { stored, query, stale } = useRobloxStatus(true);
  const current = stored.current;
  const active = current?.incidents ?? [];
  const history = stored.history?.filter((item) => !active.some((incident) => incident.id === item.id));
  return <main className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
    <header className="flex flex-wrap justify-between items-start gap-3">
      <div><h1 className="text-xl font-semibold">Roblox Status</h1><p className="text-sm text-fg-2">Service health from the official Roblox status page.</p></div>
      <div className="flex gap-2">
        <button className="btn btn-sm" disabled={query.isFetching} onClick={() => void query.refetch()}><Icon name="refresh" />Refresh</button>
        <button className="btn btn-sm" onClick={() => link(STATUS_HOME)}>Official status <Icon name="external" /></button>
      </div>
    </header>
    <section className="panel p-4 space-y-2" aria-label="Service health">
      <div className="flex justify-between items-center gap-3 flex-wrap">
        <h2 className="font-semibold">{current?.status_overall.status ?? (query.isPending ? "Checking Roblox…" : "Current status unavailable")}</h2>
        <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={stored.alerts === true} onChange={(event) => setStatusAlerts(event.target.checked)} /> Notify me in UnknownALT</label>
      </div>
      {stored.currentAt && <p className="text-xs text-fg-2">{stale ? "Last saved status" : "Last checked"} {new Date(stored.currentAt).toLocaleString()}</p>}
      {current?.status.map((service) => <details className="border-t border-line py-2" key={service.id}>
        <summary className="cursor-pointer"><span className="font-medium">{service.name}</span><span className="ml-3 text-sm"><ServiceState service={service} /></span></summary>
        <ul className="mt-2 text-sm space-y-1">{service.containers.map((child) => <li key={child.id} className="flex justify-between gap-3"><span>{child.name}</span><ServiceState service={child} /></li>)}</ul>
      </details>)}
    </section>
    <section className="panel p-4 space-y-3">
      <h2 className="font-semibold">Active incidents</h2>
      {active.map((item) => <article key={item.id} className="space-y-1 border-t border-line pt-2">
        <button className="font-medium text-left" onClick={() => link(incidentUrl(item.id))}>{item.name} ↗</button>
        <p className="text-sm whitespace-pre-wrap">{item.messages.at(-1)?.details ?? "See official status for details."}</p>
      </article>)}
      {!active.length && <p className="text-sm text-fg-2">{current ? stale ? "No active incidents in the last saved report." : "Roblox reports no active incidents." : "Active incidents are unavailable."}</p>}
    </section>
    <section className="panel p-4 space-y-3">
      <h2 className="font-semibold">Incident history</h2>
      {(!history || !history.length) && <p className="text-sm text-fg-2">No incident history was available from Roblox.</p>}
      {history?.map((item) => <details key={item.id} className="border-t border-line pt-2">
        <summary className="cursor-pointer"><span className="font-medium">{item.title}</span> <span className="text-sm text-fg-2">{[item.resolved ? "Resolved" : "", item.impact, item.date].filter(Boolean).join(" · ")}</span></summary>
        <p className="my-2 text-sm whitespace-pre-wrap">{item.details}</p>
        <button className="btn btn-sm" onClick={() => link(incidentUrl(item.id))}>View original <Icon name="external" /></button>
      </details>)}
    </section>
  </main>;
}
