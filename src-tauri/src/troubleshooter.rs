//! Evidence-based local checks. No telemetry, sponsor request, credentials or remote diagnosis.
use crate::{
    App,
    error::{AppError, Result},
    model::{CrashKind, InstanceState},
};
use serde::{Deserialize, Serialize};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Repair {
    RescanInstallation,
    CancelPendingLaunches,
    RetryAutomation,
    ReinstallRoblox,
}
impl Repair {
    pub fn major(self) -> bool {
        self == Self::ReinstallRoblox
    }
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Diagnosis {
    pub id: String,
    pub title: String,
    pub cause: String,
    pub solutions: Vec<String>,
    pub severity: String,
    pub fix: Option<Repair>,
    pub needs_confirmation: bool,
}
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TroubleshootReport {
    pub findings: Vec<Diagnosis>,
    pub checks: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Failure {
    Connection,
    Refused,
    SignIn,
    RateLimit,
    Dependency,
    Storage,
    Other,
}
static RECENT: Mutex<Option<(Instant, Failure)>> = Mutex::new(None);
pub fn record_error(error: &AppError) {
    let failure = match error {
        AppError::Network(_) => Failure::Connection,
        AppError::Roblox(_) if error.is_forbidden() => Failure::Refused,
        AppError::CookieInvalid | AppError::Challenge | AppError::BoundSessionRequired => {
            Failure::SignIn
        }
        AppError::RateLimited(_) => Failure::RateLimit,
        AppError::Crypto | AppError::Storage(_) => Failure::Storage,
        AppError::Internal(why) if why.contains("WebView2") => Failure::Dependency,
        AppError::Internal(_) | AppError::Roblox(_) => Failure::Other,
        _ => return,
    };
    *RECENT.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), failure));
}

#[derive(Default)]
struct Evidence {
    missing_client: bool,
    missing_runtime: bool,
    damaged_client: bool,
    stalled: bool,
    frozen: bool,
    confirmed_crash: bool,
    unconfirmed_exit: bool,
    disconnected: bool,
    sign_in: bool,
    public_guard: bool,
    resource_wait: bool,
    paused: bool,
    recent: Option<Failure>,
}
fn finding(
    id: &str,
    title: &str,
    cause: &str,
    solutions: &[&str],
    fix: Option<Repair>,
    severe: bool,
) -> Diagnosis {
    Diagnosis {
        id: id.into(),
        title: title.into(),
        cause: cause.into(),
        solutions: solutions.iter().map(|s| (*s).into()).collect(),
        severity: if severe { "error" } else { "warning" }.into(),
        needs_confirmation: fix.is_some_and(Repair::major),
        fix,
    }
}
fn assess(e: &Evidence) -> Vec<Diagnosis> {
    let mut out = Vec::new();
    if e.missing_runtime || e.recent == Some(Failure::Dependency) {
        out.push(finding("webview2","WebView2 dependency needs attention","The required browser runtime could not be detected or initialized.",
            &["Run the UnknownAlt installer again to repair its Microsoft WebView2 prerequisite.","Keep Windows 10 1809 or newer and use the x64 build. Do not disable Windows security protections."],None,true));
    }
    if e.missing_client || e.damaged_client {
        out.push(finding("roblox-install","Roblox installation issue",if e.missing_client {"No usable Roblox launcher was found."}else{"The detected Roblox executable is missing or empty."},
            &["Rescan if Roblox was just installed or a different launcher was selected.","Reinstall Roblox using its verified official installer. Running clients must be closed by you first."],Some(Repair::ReinstallRoblox),true));
    }
    if e.stalled {
        out.push(finding("stalled-launch","Roblox launch is taking too long","A tracked process has not reached a game within two minutes. This is not proof of a crash; its window remains open.",
            &["Look for a Roblox update, sign-in or error dialog in that window.","Rescan the Roblox installation. If the client is damaged, close it yourself and use the installation repair.","Cancel pending launches to stop the queue without closing running windows."],Some(Repair::RescanInstallation),false));
    }
    if e.frozen {
        out.push(finding(
            "frozen-window",
            "Roblox window is not responding",
            "Windows repeatedly reported that a managed Roblox window was not responding.",
            &[
                "Check the window for a prompt and allow it time to finish loading.",
                "Try lowering graphics or client count if this repeats.",
                "Retry configured recovery only if you want the existing restart rules to run.",
            ],
            Some(Repair::RetryAutomation),
            false,
        ));
    }
    if e.confirmed_crash {
        out.push(finding("confirmed-crash","Confirmed Roblox crash","A matching Windows process fault or associated crash-handler dump was recorded.",
            &["Use the crash details to inspect the affected client's log.","Try Roblox defaults or lower the client count. If failures repeat, repair Roblox after closing its windows."],Some(Repair::RescanInstallation),true));
    } else if e.unconfirmed_exit {
        out.push(finding("unconfirmed-exit","Client closed; cause unconfirmed","The process ended, but no matching crash evidence was found. A manual close, update or another program can cause this.",
            &["Check the affected client's window/log and any Roblox update prompt.","No automatic reinstall or destructive repair is needed solely because of an unconfirmed exit."],None,false));
    }
    if e.sign_in || e.recent == Some(Failure::SignIn) || e.recent == Some(Failure::Refused) {
        out.push(finding("sign-in","Roblox sign-in or refusal","Roblox rejected a session, requested verification or refused the launch. This does not establish an application crash.",
            &["Use Add account → Sign in with Roblox to refresh that account's session.","Complete any human verification yourself. Never share your cookie or password.","A game/private-server permission refusal must be resolved with the account or game owner."],None,false));
    }
    if e.disconnected || e.recent == Some(Failure::Connection) {
        out.push(finding("connection","Recent connection failure","A network request failed or a managed client disconnected. This event alone does not identify which service or part of the connection failed.",
            &["Check your internet connection and the affected service's status, such as Roblox or GitHub for Unknown alt updates.","Retry after the connection returns; leave firewall and antivirus protection enabled.","Retry configured automation without bypassing Pause All, Take control or the resource queue."],Some(Repair::RetryAutomation),false));
    }
    if e.recent == Some(Failure::RateLimit) {
        out.push(finding(
            "rate-limit",
            "Roblox is limiting requests",
            "Roblox returned a rate-limit response.",
            &[
                "Wait for the retry interval before trying again.",
                "Increase the launch delay or launch fewer accounts at a time.",
            ],
            None,
            false,
        ));
    }
    if e.public_guard {
        out.push(finding("network-policy","Launch blocked by your network policy","The current Windows network category is blocked by your existing app setting.",
            &["Use a network you trust, or review the existing Public network setting yourself. Unknown alt will not change it automatically."],None,false));
    }
    if e.resource_wait {
        out.push(finding("resource-queue","Launch queue is waiting for resources","CPU/RAM readings have insufficient headroom, are warming up or are unavailable. Existing Roblox windows remain running.",
            &["Reduce other work or the number of clients, or wait for usage to fall.","Review the CPU/RAM thresholds in Settings → Launching → Smart Launch Queue.","Cancel only the pending launches if you no longer want them."],Some(Repair::CancelPendingLaunches),false));
    }
    if e.paused {
        out.push(finding("paused","Client management is paused","Pause All is active. Automation and new launches wait until Resume All.",
            &["Use Resume All when you want automation to continue. Individual Take control choices are preserved."],None,false));
    }
    if e.recent == Some(Failure::Storage) {
        out.push(finding("storage","Local encrypted data needs attention","A database or encryption operation failed. No key, account or settings file will be deleted automatically.",
            &["Check free disk space and that this is the same Windows user who owns the data.","Close Unknown alt before restoring a complete encrypted local backup. Keep its database and wrapped key together.","Never delete or reset the vault to try to repair a launch."],None,true));
    }
    if e.recent == Some(Failure::Other) {
        out.push(finding(
            "launch-error",
            "Recent operation failed",
            "The operation returned an error that does not establish a specific crash cause.",
            &[
                "Read the operation's error message, then rescan the detected installation.",
                "Use the local Debug report if the problem repeats; review it before sharing.",
            ],
            Some(Repair::RescanInstallation),
            false,
        ));
    }
    out
}

fn collect(s: &App) -> Result<TroubleshootReport> {
    let client = crate::launcher::client::find().ok();
    let runtime = tauri::webview_version().is_ok();
    let instances = s.tracker.list();
    let crashes = s.db.crashes()?;
    let now = crate::commands::now_ms();
    let recent_crashes: Vec<_> = crashes
        .iter()
        .filter(|c| now.saturating_sub(c.at) < 300_000 && c.kind == CrashKind::Crash)
        .collect();
    let latest = RECENT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .filter(|(at, _)| at.elapsed() < Duration::from_secs(300))
        .map(|(_, f)| *f);
    let management = s.management.status();
    let evidence = Evidence {
        missing_client: client.is_none(),
        missing_runtime: !runtime,
        damaged_client: client.as_ref().is_some_and(|c| {
            std::fs::metadata(&c.path).map_or(true, |m| !m.is_file() || m.len() == 0)
        }),
        stalled: instances.iter().any(|i| i.launch_stalled),
        frozen: instances.iter().any(|i| i.state != InstanceState::Exited
            && i.note.as_deref() == Some(crate::instances::hung().as_str())),
        confirmed_crash: recent_crashes
            .iter()
            .any(|c| c.verdict.as_deref() == Some("crashed")),
        unconfirmed_exit: recent_crashes
            .iter()
            .any(|c| c.verdict.as_deref() != Some("crashed")),
        disconnected: instances
            .iter()
            .any(|i| i.state == InstanceState::Disconnected),
        sign_in: instances.iter().any(|i| i.sign_in_problem),
        public_guard: crate::network::blocked(s).is_some(),
        resource_wait: management.waiting > 0 && !management.config.paused,
        paused: management.config.paused,
        recent: latest,
    };
    Ok(TroubleshootReport {
        findings: assess(&evidence),
        checks: vec![
            if runtime {
                "Microsoft WebView2 runtime detected."
            } else {
                "Microsoft WebView2 runtime not detected."
            }
            .into(),
            if client.is_some() {
                "Roblox launcher detection completed."
            } else {
                "Roblox launcher not found."
            }
            .into(),
            "Checks run locally. No diagnostic data is uploaded.".into(),
        ],
    })
}

fn permit_repair(action: Repair, confirmed: bool, running: bool) -> Result<()> {
    if action.major() && !confirmed {
        return Err(AppError::Invalid(
            "This repair requires your confirmation. Nothing was changed.".into(),
        ));
    }
    if action.major() && running {
        return Err(AppError::Invalid(
            "Close running Roblox clients yourself before reinstalling. No windows were closed."
                .into(),
        ));
    }
    Ok(())
}
#[tauri::command]
pub async fn troubleshoot_diagnose(app: AppHandle) -> Result<TroubleshootReport> {
    crate::launcher::update::blocking(move || collect(&app.state::<App>())).await
}
#[tauri::command]
pub async fn troubleshoot_fix(
    app: AppHandle,
    action: Repair,
    confirmed: bool,
) -> Result<TroubleshootReport> {
    let s = app.state::<App>();
    permit_repair(
        action,
        confirmed,
        s.tracker.any_running() || !crate::instances::process::roblox_processes().is_empty(),
    )?;
    match action {
        Repair::RescanInstallation => {
            crate::launcher::update::publish(&app);
        }
        Repair::CancelPendingLaunches => s.management.cancel_pending(),
        Repair::RetryAutomation => crate::instances::rejoin::retry_now(),
        Repair::ReinstallRoblox => {
            let handle = app.clone();
            crate::launcher::update::blocking(move || {
                crate::automatic_backup::create_at(
                    &handle.state::<App>().db,
                    &crate::automatic_backup::root()?,
                    "before-repair",
                )
            })
            .await?;
            crate::launcher::update::install(&app).await?;
        }
    }
    troubleshoot_diagnose(app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_exits_are_not_presented_as_confirmed_crashes() {
        let findings = assess(&Evidence {
            unconfirmed_exit: true,
            ..Default::default()
        });
        assert_eq!(findings[0].id, "unconfirmed-exit");
        assert_eq!(findings[0].severity, "warning");
        assert!(findings[0].fix.is_none());
        let findings = assess(&Evidence {
            confirmed_crash: true,
            ..Default::default()
        });
        assert_eq!(findings[0].id, "confirmed-crash");
    }
    #[test]
    fn diagnostics_explain_all_supported_failure_classes() {
        for e in [
            Evidence {
                missing_client: true,
                ..Default::default()
            },
            Evidence {
                missing_runtime: true,
                ..Default::default()
            },
            Evidence {
                stalled: true,
                ..Default::default()
            },
            Evidence {
                recent: Some(Failure::Connection),
                ..Default::default()
            },
            Evidence {
                recent: Some(Failure::Refused),
                ..Default::default()
            },
            Evidence {
                resource_wait: true,
                ..Default::default()
            },
        ] {
            let findings = assess(&e);
            assert!(!findings.is_empty());
            assert!(!findings[0].cause.is_empty());
            assert!(!findings[0].solutions.is_empty());
        }
        assert!(assess(&Evidence::default()).is_empty());
    }
    #[test]
    fn major_repairs_require_confirmation_and_never_close_running_windows() {
        assert!(permit_repair(Repair::ReinstallRoblox, false, false).is_err());
        assert!(permit_repair(Repair::ReinstallRoblox, true, true).is_err());
        assert!(permit_repair(Repair::ReinstallRoblox, true, false).is_ok());
        for action in [
            Repair::CancelPendingLaunches,
            Repair::RescanInstallation,
            Repair::RetryAutomation,
        ] {
            assert!(permit_repair(action, false, true).is_ok());
        }
    }
}
