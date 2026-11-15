import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, events, type AppUpdate } from "../../api";
import { qk } from "../../data";
import { t } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { toastError } from "../../ui/Toast";

const active = (state: AppUpdate["state"] | undefined) => state === "downloading" || state === "verifying" || state === "installing";

/** Native code owns checks, downloads and trust decisions. This hook only observes state and
 * asks it to install; a failed check never blocks accounts or the rest of the interface. */
export function useOwnedUpdate() {
  const qc = useQueryClient();
  const [eventFallback, setEventFallback] = useState(false);
  const query = useQuery({
    queryKey: qk.appUpdate,
    queryFn: api.selfUpdateStatus,
    retry: false,
    refetchInterval: (q) => active(q.state.data?.state) || q.state.data?.state === "checking" ? 1000 : eventFallback || !q.state.data ? 30_000 : false,
    refetchIntervalInBackground: true,
  });
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const lastAttempt = useRef<string | null>(null);
  const status = query.data;

  useEffect(() => {
    let stopped = false;
    let unlisten: (() => void) | undefined;
    events.onAppUpdate((state) => {
      if (!stopped) qc.setQueryData(qk.appUpdate, state);
    }).then((un) => {
      if (stopped) return un();
      unlisten = un;
      // A startup check may finish between the first status read and listener registration.
      void qc.invalidateQueries({ queryKey: qk.appUpdate });
    }).catch(() => {
      // Local status polling remains a fallback if the event bridge is temporarily unavailable.
      if (!stopped) {
        setEventFallback(true);
        void qc.invalidateQueries({ queryKey: qk.appUpdate });
      }
    });
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, [qc]);

  useEffect(() => {
    if (status?.available && status.available !== lastAttempt.current) setFailed(false);
  }, [status?.available]);

  const busy = starting || active(status?.state);
  const canRetry = failed && lastAttempt.current !== null;
  const visible = !!status?.configured && (!!status.available || busy || canRetry);
  const start = async () => {
    if (!status?.configured || (!status.available && !canRetry) || busy || inFlight.current) return;
    inFlight.current = true;
    lastAttempt.current = status.available ?? lastAttempt.current;
    setStarting(true);
    setFailed(false);
    try {
      // No URL, path, version or other trust-sensitive input comes from the UI.
      await api.selfUpdateInstall();
      await query.refetch();
    } catch (e) {
      setFailed(true);
      toastError(e);
      void query.refetch();
    } finally {
      inFlight.current = false;
      setStarting(false);
    }
  };

  return { status, busy, failed, visible, start: () => void start() };
}

export type OwnedUpdateControl = ReturnType<typeof useOwnedUpdate>;

/** Same .wc height, shape, colour and hover treatment as Refresh, with room for a visible label. */
export function OwnedUpdateButton({ update }: { update: OwnedUpdateControl }) {
  const { status, busy, failed, visible } = update;
  if (!visible || !status) return null;
  const version = status.available;
  const percent = status.total && status.total > 0 ? Math.min(100, Math.max(0, Math.floor(status.downloaded * 100 / status.total))) : null;
  const progress = percent === null ? "" : ` ${percent}%`;
  const detail = status.state === "downloading" ? t("updates.downloading", { progress })
    : status.state === "verifying" ? t("updates.verifying")
    : status.state === "installing" ? t("updates.installing")
    : busy ? t("updates.preparing")
    : failed || status.state === "error" ? t("updates.retry")
    : t("updates.available", { version: version ?? "" });
  const tooltip = status.error && !busy ? `${detail} · ${status.error}` : detail;

  return (
    <>
      <button
        type="button"
        className="wc"
        style={{ width: "auto", minWidth: "var(--h-md)", display: "inline-flex", alignItems: "center", justifyContent: "center", paddingInline: 9, gap: 6, fontSize: 12, fontWeight: 600 }}
        aria-label={t("updates.action")}
        aria-busy={busy || undefined}
        data-tip={tooltip}
        disabled={busy}
        onClick={update.start}
      >
        <Icon name={busy ? "refresh" : failed || status.state === "error" ? "alert" : "download"} className={busy ? "spin" : undefined} size={16} />
        <span>{t("updates.action")}</span>
      </button>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{detail}</span>
    </>
  );
}
