import { openUrl } from "@tauri-apps/plugin-opener";
import { DISCORD_INVITE } from "../../../app/links";
import { t } from "../../../i18n";
import { Button } from "../../../ui/Button";
import { useRow } from "../kit/rowError";
import { SettingRow } from "../kit/SettingRow";

/** The local product version; the distributed license retains developer attribution. */
export function VersionRow() {
  const version = import.meta.env.APP_VERSION;
  return (
    <SettingRow id="version" name={`Unknown alt ${version}`} title={<span className="set-label">Unknown alt</span>} detail="MIT licensed · inspectsoftware">
      <span className="mono text-fg-2">v{version}</span>
    </SettingRow>
  );
}

function Support() {
  const row = useRow();
  return <Button size="md" iconEnd="external" onClick={() => openUrl(DISCORD_INVITE).catch(row.fail)}>{t("app.joinDiscord")}</Button>;
}

export function SupportRow() {
  return (
    <SettingRow id="support" title={<span className="set-label">{t("app.joinDiscord")}</span>}>
      <Support />
    </SettingRow>
  );
}
