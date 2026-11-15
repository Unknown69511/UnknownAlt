import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, asError, type UpdateAuth } from "../../api";
import { qk } from "../../data";
import { t } from "../../i18n";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { friendly } from "../../ui/Toast";
import { useRow } from "../settings/kit/rowError";
import { SettingRow } from "../settings/kit/SettingRow";

// Never open a provider address or arbitrary URL received through a status payload.
const GITHUB_DEVICE_URL = "https://github.com/login/device";

function PrivateUpdateControls() {
  const qc = useQueryClient();
  const row = useRow();
  const query = useQuery({ queryKey: qk.updateAuth, queryFn: api.updateAuthStatus, retry: false, staleTime: 0, refetchOnWindowFocus: true });
  const auth = query.data;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const accept = (next: UpdateAuth) => {
    qc.setQueryData(qk.updateAuth, next);
    row.setError(next.error);
    if (next.connected) {
      setOpen(false);
      row.setResult(t("updates.authSuccess"));
      void api.selfUpdateCheck().then((status) => qc.setQueryData(qk.appUpdate, status)).catch(() => {});
    }
  };

  useEffect(() => {
    if (auth?.state !== "pending") return;
    let stopped = false;
    // A native-enforced delay is also observed by the UI; there is never an interval
    // overlapping an in-flight request or an automatic request after unmount.
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay: number | null) => {
      timer = setTimeout(() => {
        void api.updateAuthPoll().then((next) => {
          if (stopped) return;
          accept(next);
          // Query structural sharing may keep an identical pending response by reference.
          // Reschedule explicitly so that does not stop authorization after its first poll.
          if (next.state === "pending") schedule(next.pollAfterMs);
        }, (error) => {
          if (!stopped) {
            row.fail(error);
            qc.setQueryData<UpdateAuth>(qk.updateAuth, { ...auth, state: "error", error: friendly(asError(error)) });
          }
        });
      }, Math.max(1000, delay ?? 5000));
    };
    schedule(auth.pollAfterMs);
    return () => { stopped = true; clearTimeout(timer); };
  }, [auth, qc]);

  const start = async () => {
    if (busy) return;
    setBusy(true);
    row.setError(null);
    row.setResult(null);
    try {
      const next = await api.updateAuthStart();
      accept(next);
      if (next.state === "pending") setOpen(true);
    } catch (error) { row.fail(error); }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    row.setError(null);
    row.setResult(null);
    try {
      qc.setQueryData(qk.updateAuth, await api.updateAuthDisconnect());
      void qc.invalidateQueries({ queryKey: qk.appUpdate });
      setOpen(false);
    } catch (error) { row.fail(error); }
    finally { setBusy(false); }
  };

  const status = query.error ? friendly(asError(query.error))
    : !auth ? t("common.loading")
    : auth.state === "public" ? t("updates.publicStatus")
    : !auth.configured ? t("updates.privateUnconfigured")
    : auth.connected ? t("updates.privateConnected", { login: auth.login ?? "GitHub" })
    : auth.state === "pending" ? t("updates.privatePending")
    : auth.error ?? t("updates.privateDisconnected");

  return (
    <>
      <span className="text-[13px] text-fg-3" role="status">{status}</span>
      {auth?.state === "public" ? (
        <Button size="md" disabled={busy} onClick={() => {
          setBusy(true); row.setError(null); row.setResult(null);
          void api.selfUpdateCheck().then((next) => {
            qc.setQueryData(qk.appUpdate, next);
            row.setResult(t(next.available ? "updates.action" : "updates.publicCurrent"));
          }).catch(row.fail).finally(() => setBusy(false));
        }}>{t("updates.checkNow")}</Button>
      ) : auth?.configured && (auth.connected ? (
        <Button size="md" disabled={busy} onClick={() => void disconnect()}>{t("updates.disconnect")}</Button>
      ) : (
        <Button size="md" disabled={busy} onClick={() => auth.state === "pending" ? setOpen(true) : void start()}>
          {t(auth.state === "pending" ? "updates.finish" : "updates.connect")}
        </Button>
      ))}
      <Dialog open={open} onClose={() => setOpen(false)} title={t("updates.authTitle")} width={460}>
        <p className="text-fg-2">{t("updates.authInstructions")}</p>
        {auth?.userCode && <div className="field mono selectable text-center text-[24px] my-4" role="group" aria-label={t("updates.authCode")}>{auth.userCode}</div>}
        <p className="text-fg-3 text-[13px]" role="status">{auth?.state === "pending" ? t("updates.privatePending") : auth?.error ?? t("updates.privateDisconnected")}</p>
        <div className="flex justify-end gap-2 mt-5">
          <Button size="md" onClick={() => setOpen(false)}>{t("common.close")}</Button>
          {auth?.state === "pending" ? (
            <Button size="md" iconEnd="external" onClick={() => openUrl(GITHUB_DEVICE_URL).catch(row.fail)}>{t("updates.authOpen")}</Button>
          ) : <Button size="md" disabled={busy} onClick={() => void start()}>{t("updates.authRetry")}</Button>}
        </div>
      </Dialog>
    </>
  );
}

export function PrivateUpdatesRow() {
  return <SettingRow id="privateUpdates"><PrivateUpdateControls /></SettingRow>;
}
