use crate::{
    App,
    error::{AppError, Result},
    model::SystemUsage,
    storage::Db,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use ts_rs::TS;

const SETTING: &str = "UnknownAlt.farm";
static SETTINGS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct FarmSettings {
    pub priority_account: Option<i64>,
    pub local_alerts: bool,
}

pub fn settings(db: &Db) -> Result<FarmSettings> {
    match db.setting_value(SETTING)? {
        Some(value) => serde_json::from_str(&value)
            .map_err(|_| AppError::Storage("Farm settings could not be read.".into())),
        None => Ok(FarmSettings {
            priority_account: None,
            local_alerts: true,
        }),
    }
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FarmStatus {
    settings: FarmSettings,
    usage: Option<SystemUsage>,
}

#[tauri::command]
pub fn farm_status(s: tauri::State<'_, App>) -> Result<FarmStatus> {
    Ok(FarmStatus {
        settings: settings(&s.db)?,
        usage: s.metrics.system(),
    })
}

#[tauri::command]
pub fn farm_configure(s: tauri::State<'_, App>, settings: FarmSettings) -> Result<()> {
    if let Some(id) = settings.priority_account {
        s.db.account(id)?;
    }
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    s.db.set_setting_value(
        SETTING,
        Some(&serde_json::to_string(&settings).map_err(|_| AppError::Crypto)?),
    )
}

#[tauri::command]
pub async fn farm_audio(
    app: AppHandle,
    id: String,
    change: Option<crate::instances::audio::AudioChange>,
) -> Result<crate::instances::audio::AudioLevel> {
    crate::launcher::update::blocking(move || {
        let s = app.state::<App>();
        let (_, pid, started, _) = s
            .tracker
            .clients()
            .into_iter()
            .find(|client| client.0 == id)
            .ok_or(AppError::NotFound)?;
        crate::instances::audio::mix(pid, started, change)
    })
    .await
}

pub fn alert_on_transition(
    app: &AppHandle,
    previous: &crate::model::Instance,
    current: &crate::model::Instance,
) {
    let message = if current.launch_stalled && !previous.launch_stalled {
        "A Roblox launch is taking longer than expected. Open Farm Control Center for details."
    } else if current.note.as_deref() == Some(crate::instances::hung().as_str())
        && previous.note != current.note
    {
        "A managed Roblox client stopped responding. Open Farm Control Center for details."
    } else if current.sign_in_problem && !previous.sign_in_problem {
        "A managed Roblox client needs sign-in attention. Open Farm Control Center for details."
    } else {
        return;
    };
    if settings(&app.state::<App>().db).is_ok_and(|value| value.local_alerts) {
        crate::commands::notice(app, true, message);
    }
}
