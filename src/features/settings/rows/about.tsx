import { openUrl } from "@tauri-apps/plugin-opener";
import { DISCORD_INVITE } from "../../../app/links";
import { t } from "../../../i18n";
import { Button } from "../../../ui/Button";
import { replayOnboarding } from "../../onboarding/qa";
import { toastError } from "../../../ui/Toast";
import { SettingRow } from "../kit/SettingRow";
export function VersionRow() {

 return <SettingRow id="version" name={`UnknownALT ${import.meta.env.APP_VERSION}`} title={<span className="set-label">UnknownALT <span className="mono">{import.meta.env.APP_VERSION}</span></span>} detail="MIT licensed · inspectsoftware">
 <Button size="md" iconEnd="external" onClick={() => openUrl("https://github.com/Unknown69511/UnknownAlt/releases").catch(toastError)}>{t("settings.openReleases")}</Button></SettingRow>;
}
export function ReplayTourRow() { return <SettingRow id="replayTour"><Button size="md" onClick={replayOnboarding}>{t("onboarding.replayButton")}</Button></SettingRow>; }
export function SupportRow() { return <SettingRow id="support" title={<span className="set-label">{t("app.joinDiscord")}</span>}><Button size="md" iconEnd="external" onClick={() => openUrl(DISCORD_INVITE).catch(toastError)}>{t("app.joinDiscord")}</Button></SettingRow>; }

