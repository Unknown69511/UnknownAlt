use std::{collections::VecDeque, sync::Mutex};
use tauri::{AppHandle, Emitter, State};
use windows::{
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    UI::Notifications::{ToastNotification, ToastNotificationManager},
    core::HSTRING,
};
use crate::{App, commands::stored_cookie, error::{AppError, Result}};

static TOASTS: Mutex<VecDeque<(ToastNotification, i64)>> = Mutex::new(VecDeque::new());

fn toast_text(text: &str, cap: usize) -> String {
    text.chars().filter(|c| !c.is_control()).take(cap).collect::<String>()
        .replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[tauri::command]
pub fn native_notification(app: AppHandle, id: String, title: String, body: String) -> Result<()> {
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err(AppError::Invalid("Invalid notification ID.".into()));
    }
    let send = || -> windows::core::Result<()> {
        let doc = XmlDocument::new()?;
        let body = format!("<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
            toast_text(&title, 100), toast_text(&body, 240));
        doc.LoadXml(&HSTRING::from(body))?;
        let toast = ToastNotification::CreateToastNotification(&doc)?;
        let handle = app.clone();
        let token = toast.Activated(&TypedEventHandler::new(move |_, _| {
            let app = handle.clone();
            let target = id.clone();
            handle.run_on_main_thread(move || {
                crate::tray::show_main(&app);
                let _ = app.emit("notification://open", target);
            }).ok();
            Ok(())
        }))?;
        let notifier = if crate::store_package::active() {
            ToastNotificationManager::CreateToastNotifier()?
        } else {
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from("com.unknownalt.desktop"))?
        };
        notifier.Show(&toast)?;
        let mut toasts = TOASTS.lock().unwrap_or_else(|e| e.into_inner());
        toasts.push_back((toast, token));
        if toasts.len() > 100 {
            if let Some((old, token)) = toasts.pop_front() { let _ = old.RemoveActivated(token); }
        }
        Ok(())
    };
    send().map_err(|_| AppError::Internal("Windows could not show the notification.".into()))
}

#[tauri::command]
pub async fn friend_request_counts(s: State<'_, App>, ids: Vec<i64>) -> Result<Vec<(i64, u64)>> {
    let mut result = Vec::new();
    for id in ids.into_iter().take(8) {
        let Ok(cookie) = stored_cookie(&s, id) else { continue };
        if let Ok(count) = s.api.pending_friend_count(id, &cookie).await {
            result.push((id, count));
        }
    }
    Ok(result)
}
