import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { applyAccent, DEFAULT_ACCENT, GROUNDS } from "../../app/theme";
import { useNavigationRequests, type Request } from "../../app/navigation";
import { applyNumberFormat, readNumberFormat, t } from "../../i18n";
import { queryClient } from "../../data";
import { Dialog } from "../../ui/Dialog";
import { toast, toastError, Toaster } from "../../ui/Toast";
import { finishStartupNotices } from "../notifications/startup";
import { UpdatesPage } from "../update/UpdatesPage";
import { useFollowedGameUpdates } from "../discover/store";
import { DiscoverView } from "../discover/DiscoverView";
import { StatusView } from "../discover/StatusView";
import { useRobloxStatus } from "../discover/useRobloxStatus";

type Account = { userId: number; username: string; displayName: string; alias: string };
type PortableStatus = {
  hasArchive: boolean;
  accounts: Account[];
  appearance: { theme: string | null; accent: string | null } | null;
  storageBytes: number;
  backups: number;
  version: string;
};

export function PortableApp() {
  useEffect(() => { finishStartupNotices(); }, []);
  return <QueryClientProvider client={queryClient}><PortableShell /><Toaster /></QueryClientProvider>;
}

function PortableShell() {
  useFollowedGameUpdates();
  const query = useQuery({ queryKey: ["portableStatus"], queryFn: () => invoke<PortableStatus>("portable_status"), retry: false });
  useRobloxStatus();
  const [view, setView] = useState<"archive" | "updates" | "discover" | "status" | "support" | "settings">("archive");
  const [game, setGame] = useState<number>();
  useNavigationRequests(useCallback((request: Request) => {
    if (request.view === "discover") {
      setGame(request.game);
      setView("discover");
    }
  }, []));
  const [format, setFormat] = useState(readNumberFormat);
  const [action, setAction] = useState<{ type: "import" | "export"; path: string } | null>(null);
  const [password, setPassword] = useState("");
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const data = query.data;

  useEffect(() => {
    const theme = data?.appearance?.theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    const color = data?.appearance?.accent ?? DEFAULT_ACCENT;
    applyAccent(/^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_ACCENT, GROUNDS[theme]);
  }, [data?.appearance]);

  const pick = async (type: "import" | "export") => {
    try {
      const filters = [{ name: "UnknownALT backup", extensions: ["unknownalt", "roalt"] }];
      const path = type === "import" ? await open({ multiple: false, directory: false, filters }) :
        await save({ defaultPath: "UnknownAlt-Backup.unknownalt", filters });
      if (typeof path !== "string") return;
      setPassword("");
      setReplace(false);
      setAction({ type, path });
    } catch (e) { toastError(e); }
  };
  const submit = async () => {
    if (!action || !password) return;
    setBusy(true);
    try {
      await invoke(action.type === "import" ? "portable_import" : "portable_export", {
        path: action.path, password, ...(action.type === "import" ? { replace } : {}),
      });
      setPassword("");
      setAction(null);
      await query.refetch();
      toast(action.type === "import" ? "Archive imported." : "Encrypted backup exported.");
    } catch (e) { toastError(e); }
    finally { setBusy(false); }
  };
  const snapshot = async () => {
    setBusy(true);
    try { await invoke("portable_backup"); await query.refetch(); toast("Encrypted snapshot saved."); }
    catch (e) { toastError(e); }
    finally { setBusy(false); }
  };
  return <div className="app">
    <header className="flex flex-wrap items-center gap-3 p-3 border-b border-line">
      <h1 className="font-semibold">UnknownALT</h1>
      {([["archive", "Account archive"], ["discover", "Discover"], ["status", "Roblox Status"], ["updates", "Updates"], ["support", "Platform support"], ["settings", t("app.nav.settings")]] as const).map(([item, label]) => (
        <button key={item} className="btn btn-sm" aria-pressed={view === item} onClick={() => setView(item)}>{label}</button>
      ))}
      <button className="btn btn-sm ml-auto" onClick={() => openUrl("https://discord.gg/8EVsaWTH8S").catch(toastError)}>Discord</button>
    </header>
    {view === "updates" ? <UpdatesPage packageVersion={data?.version ?? "—"} />
      : view === "discover" ? <DiscoverView openGame={game} />
      : view === "status" ? <StatusView />
      : view === "settings" ? <main className="flex-1 overflow-auto p-4">
      <section className="panel p-4 space-y-3"><label className="flex flex-wrap items-center gap-2">{t("settings.numberFormat")}
        <select className="field max-w-40" value={format} onChange={(event) => {
          const next = event.target.value === "full" ? "full" : "compact";
          applyNumberFormat(next);
          setFormat(next);
        }}><option value="compact">{t("settings.numberCompact")}</option><option value="full">{t("settings.numberFull")}</option></select>
      </label><p className="text-sm text-fg-2">{t("settings.numberFormatHint")}</p></section>
    </main> : view === "support" ? <main className="flex-1 overflow-auto p-4 space-y-3">
      <h2 className="text-xl font-semibold">Platform support</h2>
      <p>This build supports encrypted account archives, local snapshots, account profile links, Updates and Roblox game discovery.</p>
      <p>Roblox sign-in and Browse, managed launches, Farm Control Center, client previews and limits, Audio Mixer, anti-AFK, session alerts and automatic app installation require the Windows EXE build.</p>
      <p>macOS uses Keychain for the archive key. Linux requires an unlocked Secret Service keyring.</p>
    </main> : <main className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
      <h2 className="text-xl font-semibold">Account archive</h2>
      <p>Import a password-protected UnknownALT backup. The archive preserves accounts, settings and other data for export.</p>
      {query.isPending && <p role="status">Opening archive…</p>}
      {query.error && <p role="alert">Could not open the archive. Check that your system keyring is available. <button className="btn btn-sm" onClick={() => void query.refetch()}>Retry</button></p>}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={busy || !data} onClick={() => void pick("import")}>Import backup</button>
        <button className="btn" disabled={busy || !data?.hasArchive} onClick={() => void pick("export")}>Export encrypted backup</button>
        <button className="btn" disabled={busy || !data?.hasArchive} onClick={() => void snapshot()}>Back up now</button>
      </div>
      <p className="text-sm text-fg-2">Stored data {((data?.storageBytes ?? 0) / 1048576).toFixed(2)} MB · Local snapshots {data?.backups ?? 0} of 5</p>
      {data?.accounts.map((account) => <section className="panel p-3 flex justify-between gap-2" key={account.userId}>
        <div><strong>{account.alias || account.displayName || account.username}</strong><p className="text-sm text-fg-2">@{account.username}</p></div>
        <button className="btn btn-sm" onClick={() => openUrl(`https://www.roblox.com/users/${account.userId}/profile`).catch(toastError)}>Open profile</button>
      </section>)}
    </main>}
    <Dialog open={action !== null} title={action?.type === "import" ? "Import encrypted backup" : "Export encrypted backup"} onClose={() => { if (!busy) { setAction(null); setPassword(""); } }} width={480}>
      <div className="dlg-body space-y-2">
        <label className="flex flex-col gap-1">Backup password<input className="field" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {action?.type === "import" && <label><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace any existing archive after saving an encrypted snapshot</label>}
      </div>
      <div className="dlg-foot"><button className="btn btn-primary" disabled={busy || !password} onClick={() => void submit()}>{action?.type === "import" ? "Import" : "Export"}</button></div>
    </Dialog>
  </div>;
}
