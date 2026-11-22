import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ManagementConfig, type Repair } from "../../api";
import { t } from "../../i18n";
import { Button } from "../../ui/Button";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { toast, toastError } from "../../ui/Toast";
import { SettingRow } from "../settings/kit/SettingRow";

const MANAGEMENT = ["management"] as const;
const DIAGNOSIS = ["troubleshooter"] as const;
const BACKUPS = ["automaticBackups"] as const;
const useManagement = () => useQuery({ queryKey: MANAGEMENT, queryFn: api.managementStatus, refetchInterval: 2000, refetchIntervalInBackground: true });
const useDiagnosis = () => useQuery({ queryKey: DIAGNOSIS, queryFn: api.troubleshootDiagnose, refetchInterval: 10000, refetchIntervalInBackground: true });

export function ClientManagementBar() {
  const qc = useQueryClient();
  const management = useManagement();
  const diagnosis = useDiagnosis();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const paused = management.data?.config.paused;
  const pause = async (on: boolean) => {
    setBusy(true);
    try { qc.setQueryData(MANAGEMENT, await api.managementPause(on)); void qc.invalidateQueries({ queryKey: DIAGNOSIS }); }
    catch (e) { toastError(e); }
    finally { setBusy(false); }
  };
  const count = diagnosis.data?.findings.length ?? 0;
  return <>
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-line" aria-label={t("management.title")}>
      <Button size="sm" disabled={busy || !management.data || paused} onClick={() => void pause(true)}>{t("management.pause")}</Button>
      <Button size="sm" disabled={busy || !management.data || !paused} onClick={() => void pause(false)}>{t("management.resume")}</Button>
      <span role="status" className="text-xs text-fg-2 flex-1 min-w-[160px]">{management.data?.reason ?? t("management.running")}{!!management.data?.waiting && ` · ${t("management.waiting", { count: management.data.waiting })}`}</span>
      {management.error && <button className="btn btn-sm" onClick={() => void management.refetch()}>{t("common.retry")}</button>}
      <Button size="sm" onClick={() => setOpen(true)}>{t("troubleshooter.title")}{count > 0 ? ` (${count})` : ""}</Button>
    </div>
    <TroubleshooterDialog open={open} onClose={() => setOpen(false)} />
  </>;
}

export function TroubleshooterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const report = useDiagnosis();
  const [confirm, setConfirm] = useState<Repair | null>(null);
  const [busy, setBusy] = useState(false);
  const repair = async (action: Repair, confirmed: boolean) => {
    setBusy(true);
    try {
      qc.setQueryData(DIAGNOSIS, await api.troubleshootFix(action, confirmed));
      void qc.invalidateQueries({ queryKey: MANAGEMENT });
      void qc.invalidateQueries({ queryKey: BACKUPS });
      toast(t("troubleshooter.rechecked"));
      setConfirm(null);
    } catch (e) { toastError(e); }
    finally { setBusy(false); }
  };
  return <>
    <Dialog open={open} onClose={onClose} title={t("troubleshooter.title")} width={720}>
      <div className="dlg-body flex flex-col gap-4 overflow-y-auto max-h-[65vh]">
        <p className="text-sm text-fg-2">{t("troubleshooter.local")}</p>
        {report.isPending && <p role="status">{t("troubleshooter.checking")}</p>}
        {report.error && <p role="alert">{t("troubleshooter.failed")}</p>}
        {report.data?.findings.length === 0 && <p role="status">{t("troubleshooter.clear")}</p>}
        {report.data?.findings.map((f) => <section key={f.id} className="panel p-3 flex flex-col gap-2">
          <h3 className="font-semibold">{f.title}</h3>
          <p className="text-sm text-fg-2">{f.cause}</p>
          <ul className="list-disc pl-5 text-sm text-fg-2">{f.solutions.map((solution) => <li key={solution}>{solution}</li>)}</ul>
          {f.fix && <Button size="sm" disabled={busy} onClick={() => f.needsConfirmation ? setConfirm(f.fix) : void repair(f.fix!, false)}>{t(f.needsConfirmation ? "troubleshooter.reviewFix" : "troubleshooter.fix")}</Button>}
        </section>)}
        {report.data && <ul className="text-xs text-fg-3">{report.data.checks.map((check) => <li key={check}>{check}</li>)}</ul>}
      </div>
      <div className="dlg-foot"><Button size="md" disabled={busy || report.isFetching} onClick={() => void report.refetch()}>{t("troubleshooter.recheck")}</Button><Button size="md" onClick={onClose}>{t("common.close")}</Button></div>
    </Dialog>
    <ConfirmDialog open={confirm !== null} onClose={() => !busy && setConfirm(null)} onConfirm={() => confirm && void repair(confirm, true)} busy={busy}
      title={t("troubleshooter.confirmTitle")} text={t("troubleshooter.confirmText")} confirmLabel={t("troubleshooter.confirmRepair")} />
  </>;
}

export function SmartQueueRow() {
  const qc = useQueryClient();
  const status = useManagement();
  const [draft, setDraft] = useState<ManagementConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const config = status.data?.config;
  useEffect(() => { if (config) setDraft(config); }, [config?.resourceGuard, config?.cpuLimit, config?.memoryLimit]);
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try { qc.setQueryData(MANAGEMENT, await api.managementConfigure(draft)); toast(t("management.saved")); }
    catch (e) { toastError(e); }
    finally { setBusy(false); }
  };
  return <SettingRow id="smartQueue">
    {draft && <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.resourceGuard} onChange={(e) => setDraft({ ...draft, resourceGuard: e.target.checked })} />{t("management.guard")}</label>
      <label className="text-sm">CPU % <input type="number" aria-label={t("management.cpuLimit")} className="input w-16" min={50} max={99} required value={draft.cpuLimit} onChange={(e) => setDraft({ ...draft, cpuLimit: Number(e.target.value) })} /></label>
      <label className="text-sm">RAM % <input type="number" aria-label={t("management.ramLimit")} className="input w-16" min={50} max={99} required value={draft.memoryLimit} onChange={(e) => setDraft({ ...draft, memoryLimit: Number(e.target.value) })} /></label>
      <Button size="sm" type="submit" disabled={busy}>{t("common.save")}</Button>
    </form>}
  </SettingRow>;
}

export function AutomaticBackupsRow() {
  const backups = useQuery({ queryKey: BACKUPS, queryFn: api.automaticBackupsList, refetchInterval: 30000 });
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try { await api.automaticBackupNow(); await backups.refetch(); toast(t("backups.created")); }
    catch (e) { toastError(e); }
    finally { setBusy(false); }
  };
  return <SettingRow id="automaticBackups">
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-fg-2">{t("backups.private")}</p>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => void create()}>{t("backups.now")}</Button><Button size="sm" onClick={() => void api.automaticBackupsOpen().catch(toastError)}>{t("backups.open")}</Button></div>
      {backups.error && <p role="alert">{t("backups.readFailed")}</p>}
      {backups.data?.length === 0 && <p>{t("backups.empty")}</p>}
      <ul className="text-xs text-fg-3">{backups.data?.map((b) => <li key={b.id}>{new Date(b.createdAt).toISOString()} · {b.version} · {(b.bytes / 1048576).toFixed(1)} MB</li>)}</ul>
      <details><summary>{t("backups.restore")}</summary><p className="mt-2 text-fg-2">{t("backups.restoreHelp")}</p></details>
    </div>
  </SettingRow>;
}
