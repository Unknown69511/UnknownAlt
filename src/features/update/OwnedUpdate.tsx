import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, asError, events, type AppUpdate } from "../../api";
import { qk } from "../../data";
import { t } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { toast } from "../../ui/Toast";

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

  const checking = starting || query.isPending || status?.state === "checking";
  const busy = checking || active(status?.state);
  const start = async () => {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    setStarting(true);
    setFailed(false);
    try {
      let next = await api.selfUpdateCheck();
      // The native checker coalesces overlapping startup/hourly/manual checks.
      // Wait for that real result rather than treating "checking" as no update.
      const deadline = Date.now() + 180_000;
      while (next.state === "checking") {
        if (Date.now() >= deadline) throw { kind: "network", message: t("ui.error.generic") };
        await new Promise((resolve) => setTimeout(resolve, 500));
        next = await api.selfUpdateStatus();
      }
      qc.setQueryData(qk.appUpdate, next);
      if (!next.configured || next.state === "error" || next.state === "unconfigured") {
        throw { kind: "invalid", message: next.error ?? t("ui.error.generic") };
      }
      if (active(next.state)) return;
      if (!next.available) {
        toast(t("updates.publicCurrent"));
        return;
      }
      // No URL, path, version or other trust-sensitive input comes from the UI.
      await api.selfUpdateInstall();
      await query.refetch();
    } catch (e) {
      setFailed(true);
      const error = asError(e);
      if (error.kind !== "cancelled") toast(error.message || t("ui.error.generic"), "error");
      void query.refetch();
    } finally {
      inFlight.current = false;
      setStarting(false);
    }
  };

  return { status, busy, checking, failed, start: () => void start() };
}

export type OwnedUpdateControl = ReturnType<typeof useOwnedUpdate>;

/** Same .wc height, shape, colour and hover treatment as Refresh, with room for a visible label. */
export function OwnedUpdateButton({ update }: { update: OwnedUpdateControl }) {
  const { status, busy, checking, failed } = update;
  const version = status?.available;
  const percent = status?.total && status.total > 0 ? Math.min(100, Math.max(0, Math.floor(status.downloaded * 100 / status.total))) : null;
  const progress = percent === null ? "" : ` ${percent}%`;
  const detail = status?.state === "downloading" ? t("updates.downloading", { progress })
    : status?.state === "verifying" ? t("updates.verifying")
    : status?.state === "installing" ? t("updates.installing")
    : checking ? t("settings.checking")
    : failed || status?.state === "error" ? t("updates.retry")
    : version ? t("updates.available", { version }) : t("updates.checkNow");
  const tooltip = status?.error && !busy ? `${detail} · ${status.error}` : detail;

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
        <Icon name={busy ? "refresh" : failed || status?.state === "error" ? "alert" : "download"} className={busy ? "spin" : undefined} size={16} />
        <span>{t("updates.action")}</span>
      </button>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{detail}</span>
    </>
  );
}
