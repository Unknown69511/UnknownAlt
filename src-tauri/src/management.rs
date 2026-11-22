//! Local management pause and resource admission. No process is suspended or closed here.
use crate::{
    App,
    error::{AppError, Result},
    model::SystemUsage,
    storage::Db,
};
use serde::{Deserialize, Serialize};
use std::sync::{
    Mutex,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};
use std::time::Duration;
use ts_rs::TS;

const KEY: &str = "UnknownAlt.management";

#[derive(Clone, Debug, Serialize, Deserialize, TS, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ManagementConfig {
    pub paused: bool,
    pub resource_guard: bool,
    pub cpu_limit: u8,
    pub memory_limit: u8,
}
impl Default for ManagementConfig {
    fn default() -> Self {
        Self {
            paused: false,
            resource_guard: true,
            cpu_limit: 90,
            memory_limit: 90,
        }
    }
}
impl ManagementConfig {
    fn validate(&self) -> Result<()> {
        if !(50..=99).contains(&self.cpu_limit) || !(50..=99).contains(&self.memory_limit) {
            return Err(AppError::Invalid(
                "Resource thresholds must be between 50% and 99%.".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ManagementStatus {
    pub config: ManagementConfig,
    pub waiting: usize,
    pub reason: Option<String>,
}

pub struct Management {
    config: Mutex<ManagementConfig>,
    waiting: AtomicUsize,
    cancel: AtomicU64,
    reason: Mutex<Option<String>>,
    changed: tokio::sync::Notify,
}
impl Management {
    pub fn new(db: &Db) -> Result<Self> {
        let config = db.setting_value(KEY)?.map(|j| serde_json::from_str::<ManagementConfig>(&j))
            .transpose().map_err(|_| AppError::Invalid("Unknown alt's management settings are invalid. No client automation was started.".into()))?.unwrap_or_default();
        config.validate()?;
        Ok(Self {
            config: Mutex::new(config),
            waiting: AtomicUsize::new(0),
            cancel: AtomicU64::new(0),
            reason: Mutex::new(None),
            changed: tokio::sync::Notify::new(),
        })
    }
    pub fn config(&self) -> ManagementConfig {
        self.config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn status(&self) -> ManagementStatus {
        let config = self.config();
        let waiting = self.waiting.load(Ordering::SeqCst);
        ManagementStatus {
            reason: if config.paused {
                Some("Management paused. Running Roblox windows stay open.".into())
            } else if waiting == 0 {
                None
            } else {
                self.reason
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone()
            },
            config,
            waiting,
        }
    }
    pub fn save(&self, db: &Db, mut config: ManagementConfig) -> Result<()> {
        config.validate()?;
        let mut current = self.config.lock().unwrap_or_else(|e| e.into_inner());
        config.paused = current.paused;
        db.set_setting_value(
            KEY,
            Some(
                &serde_json::to_string(&config).map_err(|_| {
                    AppError::Internal("Could not save management settings.".into())
                })?,
            ),
        )?;
        *current = config;
        self.changed.notify_waiters();
        Ok(())
    }
    pub fn set_paused(&self, db: &Db, paused: bool, apply: impl FnOnce()) -> Result<()> {
        // Serialize with threshold edits; a Pause click cannot overwrite a concurrent policy edit.
        let mut current = self.config.lock().unwrap_or_else(|e| e.into_inner());
        let mut config = current.clone();
        config.paused = paused;
        db.set_setting_value(
            KEY,
            Some(
                &serde_json::to_string(&config)
                    .map_err(|_| AppError::Internal("Could not save management pause.".into()))?,
            ),
        )?;
        *current = config;
        // Publish the matching tracker policy before any queued launch can wake.
        apply();
        self.changed.notify_waiters();
        Ok(())
    }
    /// Serialize the final process-start boundary with Pause/Resume. A pause arriving
    /// after async admission defers the launch, rather than failing or consuming it.
    pub fn start_if_admitted<T>(
        &self,
        epoch: u64,
        cancelled: bool,
        start: impl FnOnce() -> Result<T>,
    ) -> Option<Result<T>> {
        let config = self.config.lock().unwrap_or_else(|e| e.into_inner());
        if self.epoch() != epoch || cancelled {
            return Some(Err(AppError::Cancelled));
        }
        if config.paused {
            return None;
        }
        Some(start())
    }
    pub fn epoch(&self) -> u64 {
        self.cancel.load(Ordering::SeqCst)
    }
    pub fn cancel_pending(&self) {
        self.cancel.fetch_add(1, Ordering::SeqCst);
        self.changed.notify_waiters();
    }
}

#[tauri::command]
pub fn management_status(s: tauri::State<'_, App>) -> ManagementStatus {
    s.management.status()
}

#[tauri::command]
pub async fn management_pause(app: tauri::AppHandle, paused: bool) -> Result<ManagementStatus> {
    use tauri::Manager;
    crate::launcher::update::blocking(move || {
        let s = app.state::<App>();
        s.management
            .set_paused(&s.db, paused, || s.tracker.set_paused(paused))?;
        let mut limit_error = None;
        if paused {
            for (id, pid, t0, _) in s.tracker.clients() {
                if let Err(error) = s
                    .limiter
                    .apply(&id, pid, t0, crate::model::Limits::default())
                {
                    // One inaccessible process must not prevent releasing the other clients.
                    limit_error.get_or_insert(error);
                }
            }
        }
        crate::instances::rejoin::retry_now();
        crate::commands::instances_changed(&app);
        if let Some(error) = limit_error {
            return Err(error);
        }
        Ok(s.management.status())
    })
    .await
}

#[tauri::command]
pub fn management_configure(
    s: tauri::State<'_, App>,
    config: ManagementConfig,
) -> Result<ManagementStatus> {
    s.management.save(&s.db, config)?;
    Ok(s.management.status())
}

#[tauri::command]
pub fn management_cancel_pending(s: tauri::State<'_, App>) {
    s.management.cancel_pending();
}

#[derive(Default)]
struct Admission {
    held: bool,
    healthy: u8,
}
impl Admission {
    fn step(
        &mut self,
        config: &ManagementConfig,
        sample: Option<SystemUsage>,
    ) -> Option<&'static str> {
        if config.paused {
            return Some("Management paused. Pending launches will resume with Resume All.");
        }
        if !config.resource_guard {
            return None;
        }
        let Some(sample) = sample else {
            self.held = true;
            self.healthy = 0;
            return Some(
                "Waiting for Windows resource readings. Check Smart Troubleshooter if this continues.",
            );
        };
        let Some(cpu) = sample
            .cpu_pct
            .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 100.0)
        else {
            return Some("Measuring CPU usage before launching…");
        };
        if !sample.mem_total_mb.is_finite()
            || sample.mem_total_mb <= 0.0
            || !sample.mem_used_mb.is_finite()
            || sample.mem_used_mb < 0.0
        {
            self.held = true;
            self.healthy = 0;
            return Some("Waiting for a valid Windows memory reading.");
        }
        let memory = sample.mem_used_mb / sample.mem_total_mb * 100.0;
        let available = sample.mem_total_mb - sample.mem_used_mb;
        let cpu_high = cpu >= f64::from(config.cpu_limit);
        let mem_high = memory >= f64::from(config.memory_limit) || available < 512.0;
        if cpu_high || mem_high {
            self.held = true;
            self.healthy = 0;
            return Some(if mem_high {
                "Launch queue paused: RAM usage is high. Running windows stay open."
            } else {
                "Launch queue paused: CPU usage is high. Running windows stay open."
            });
        }
        if self.held {
            let low = cpu <= f64::from(config.cpu_limit - 10)
                && memory <= f64::from(config.memory_limit - 5)
                && available >= 768.0;
            self.healthy = if low { self.healthy + 1 } else { 0 };
            if self.healthy < 2 {
                return Some("Waiting for stable CPU and RAM headroom before resuming…");
            }
            self.held = false;
        }
        None
    }
}

struct Waiting<'a>(&'a Management);
impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        if self.0.waiting.fetch_sub(1, Ordering::SeqCst) == 1 {
            *self.0.reason.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }
}

/// Every single/batch/tray/rejoin launch waits here before acquiring a ticket. `cancelled`
/// additionally covers the owning batch/rejoin. Dropping this future releases its wait count.
pub async fn wait(s: &App, epoch: u64, cancelled: impl Fn() -> bool) -> Result<()> {
    wait_control(
        &s.management,
        epoch,
        || s.vault.is_locked(),
        || s.metrics.system(),
        cancelled,
    )
    .await
}

async fn wait_control(
    control: &Management,
    epoch: u64,
    locked: impl Fn() -> bool,
    sample: impl Fn() -> Option<SystemUsage>,
    cancelled: impl Fn() -> bool,
) -> Result<()> {
    let mut admission = Admission::default();
    let mut waiting = None;
    loop {
        if control.epoch() != epoch || cancelled() {
            return Err(AppError::Cancelled);
        }
        if locked() {
            return Err(AppError::Locked);
        }
        let config = control.config();
        let reading = if config.resource_guard && !config.paused {
            sample()
        } else {
            None
        };
        let Some(reason) = admission.step(&config, reading) else {
            return Ok(());
        };
        if waiting.is_none() {
            control.waiting.fetch_add(1, Ordering::SeqCst);
            waiting = Some(Waiting(control));
        }
        *control.reason.lock().unwrap_or_else(|e| e.into_inner()) = Some(reason.into());
        // Windows samples are cached for two seconds. Wake promptly on Pause/Resume/Cancel.
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(2)) => {},
            _ = control.changed.notified() => {},
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn usage(cpu: f64, memory: f64) -> Option<SystemUsage> {
        Some(SystemUsage {
            cpu_pct: Some(cpu),
            mem_used_mb: memory * 100.0,
            mem_total_mb: 10000.0,
        })
    }
    #[tokio::test]
    async fn pending_launch_waits_for_resume_and_keeps_its_place() {
        let db = Db::open_in_memory().unwrap();
        let control = Management::new(&db).unwrap();
        control.set_paused(&db, true, || {}).unwrap();
        let epoch = control.epoch();
        let mut waiting = Box::pin(wait_control(
            &control,
            epoch,
            || false,
            || usage(20.0, 30.0),
            || false,
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiting)
                .await
                .is_err()
        );
        assert_eq!(control.status().waiting, 1);
        control.set_paused(&db, false, || {}).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), &mut waiting)
                .await
                .unwrap()
                .is_ok()
        );
        assert_eq!(control.status().waiting, 0);
        assert_eq!(
            control.epoch(),
            epoch,
            "Pause does not cancel a queued launch"
        );
    }
    #[tokio::test]
    async fn cancelling_a_resource_wait_does_not_require_resume() {
        let db = Db::open_in_memory().unwrap();
        let control = Management::new(&db).unwrap();
        let mut waiting = Box::pin(wait_control(
            &control,
            control.epoch(),
            || false,
            || usage(99.0, 99.0),
            || false,
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiting)
                .await
                .is_err()
        );
        control.cancel_pending();
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), waiting)
                .await
                .unwrap(),
            Err(AppError::Cancelled)
        ));
        assert_eq!(control.status().waiting, 0);
    }
    #[test]
    fn pause_at_process_start_defers_without_consuming_the_launch() {
        let db = Db::open_in_memory().unwrap();
        let control = Management::new(&db).unwrap();
        let epoch = control.epoch();
        let tracker_paused = std::sync::atomic::AtomicBool::new(false);
        control
            .set_paused(&db, true, || tracker_paused.store(true, Ordering::SeqCst))
            .unwrap();
        assert!(tracker_paused.load(Ordering::SeqCst));
        assert!(
            control
                .start_if_admitted::<()>(epoch, false, || panic!("must not start while paused"))
                .is_none()
        );
        control
            .set_paused(&db, false, || tracker_paused.store(false, Ordering::SeqCst))
            .unwrap();
        assert_eq!(control.epoch(), epoch);
        assert_eq!(
            control
                .start_if_admitted(epoch, false, || {
                    assert!(!tracker_paused.load(Ordering::SeqCst));
                    Ok(42)
                })
                .unwrap()
                .unwrap(),
            42
        );
        control.cancel_pending();
        assert!(matches!(
            control.start_if_admitted::<()>(epoch, false, || panic!("cancelled launch")),
            Some(Err(AppError::Cancelled))
        ));
    }
    #[test]
    fn guard_holds_high_cpu_or_ram_and_requires_stable_headroom() {
        let cfg = ManagementConfig::default();
        let mut a = Admission::default();
        assert!(a.step(&cfg, usage(95.0, 50.0)).is_some());
        assert!(a.step(&cfg, usage(85.0, 50.0)).is_some());
        assert!(a.step(&cfg, usage(60.0, 70.0)).is_some());
        assert!(a.step(&cfg, usage(60.0, 70.0)).is_none());
        assert!(a.step(&cfg, usage(10.0, 96.0)).is_some());
        assert!(a.step(&cfg, usage(10.0, 70.0)).is_some());
        assert!(a.step(&cfg, usage(10.0, 70.0)).is_none());
    }
    #[test]
    fn manual_pause_wins_even_when_guard_is_off() {
        let cfg = ManagementConfig {
            paused: true,
            resource_guard: false,
            ..Default::default()
        };
        assert!(
            Admission::default()
                .step(&cfg, usage(0.0, 0.0))
                .unwrap()
                .starts_with("Management paused")
        );
    }
    #[test]
    fn missing_or_invalid_metrics_never_launch_blindly() {
        let cfg = ManagementConfig::default();
        let mut a = Admission::default();
        for sample in [
            None,
            usage(f64::NAN, 40.0),
            usage(20.0, f64::NAN),
            Some(SystemUsage {
                cpu_pct: None,
                mem_used_mb: 1.0,
                mem_total_mb: 2.0,
            }),
        ] {
            assert!(a.step(&cfg, sample).is_some());
        }
    }
    #[test]
    fn pause_and_thresholds_survive_restart_without_losing_other_settings() {
        let db = Db::open_in_memory().unwrap();
        let control = Management::new(&db).unwrap();
        control
            .save(
                &db,
                ManagementConfig {
                    cpu_limit: 80,
                    memory_limit: 85,
                    ..Default::default()
                },
            )
            .unwrap();
        control.set_paused(&db, true, || {}).unwrap();
        let restored = Management::new(&db).unwrap().config();
        assert!(restored.paused);
        assert_eq!(restored.cpu_limit, 80);
        assert_eq!(restored.memory_limit, 85);
        assert!(
            ManagementConfig {
                cpu_limit: 0,
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert_eq!(control.status().waiting, 0);
        let epoch = control.epoch();
        control.cancel_pending();
        assert_ne!(epoch, control.epoch());
    }
}
