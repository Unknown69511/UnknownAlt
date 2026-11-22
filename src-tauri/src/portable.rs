use crate::{
    archive_master as crypto, backup_codec, disk_usage,
    error::{AppError, Result},
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use zeroize::Zeroizing;

const AAD: &[u8] = b"UnknownAlt/portable/archive/v1";
const MAX_BYTES: u64 = 64 << 20;
const ARCHIVE: &str = "UnknownAlt.vault";
static VAULT_IO: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Archive {
    version: u32,
    accounts: Vec<PortableAccount>,
    settings: Option<Appearance>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortableAccount {
    user_id: i64,
    username: String,
    display_name: String,
    alias: String,
}

#[derive(Deserialize, Serialize)]
struct Appearance {
    theme: Option<String>,
    accent: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PortableStatus {
    has_archive: bool,
    accounts: Vec<PortableAccount>,
    appearance: Option<Appearance>,
    storage_bytes: u64,
    backups: usize,
    version: &'static str,
}

fn invalid() -> AppError {
    AppError::Invalid("Choose a compatible password-protected UnknownALT backup.".into())
}

fn decode(bytes: &[u8]) -> Result<Archive> {
    let parsed: Archive = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if parsed.version != 1
        || parsed.accounts.len() > 10_000
        || parsed.accounts.iter().any(|a| a.user_id <= 0)
    {
        return Err(invalid());
    }
    Ok(parsed)
}

fn replace_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_extension(format!("{}.pending", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok::<(), std::io::Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    Ok(result?)
}

fn owned_snapshots(root: &Path) -> Result<Vec<PathBuf>> {
    if !disk_usage::safe_path(root) {
        return Err(invalid());
    }
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some((stamp, id)) = name
            .to_str()
            .and_then(|n| n.strip_prefix("UnknownAlt-backup-"))
            .and_then(|n| n.strip_suffix(".vault"))
            .and_then(|n| n.split_once('-'))
        else {
            continue;
        };
        if stamp.len() == 13
            && stamp.bytes().all(|b| b.is_ascii_digit())
            && uuid::Uuid::parse_str(id).is_ok()
            && entry.file_type()?.is_file()
            && disk_usage::safe_path(&entry.path())
        {
            result.push(entry.path());
        }
    }
    result.sort_unstable_by(|a, b| b.cmp(a));
    Ok(result)
}

fn save_snapshot(root: &Path, current: &[u8]) -> Result<()> {
    if !disk_usage::safe_path(root) {
        return Err(invalid());
    }
    fs::create_dir_all(root)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let name = format!("UnknownAlt-backup-{now:013}-{}.vault", uuid::Uuid::new_v4());
    replace_file(&root.join(name), current)?;
    for old in owned_snapshots(root)?.into_iter().skip(5) {
        fs::remove_file(old)?;
    }
    Ok(())
}

#[cfg(any(not(windows), test))]
mod native {
    use super::*;
    use tauri::{AppHandle, Manager};

    #[cfg(not(windows))]
    fn native_key(existing: bool) -> Result<Zeroizing<[u8; 32]>> {
        let unavailable = || {
            AppError::Invalid("Unlock your system Keychain or Secret Service keyring and try again. The archive was not changed.".into())
        };
        let entry = keyring::Entry::new("com.unknownalt.desktop", "archive-key-v1")
            .map_err(|_| unavailable())?;
        match entry.get_secret() {
            Ok(raw) => {
                let raw = Zeroizing::new(raw);
                Ok(Zeroizing::new(
                    raw.as_slice().try_into().map_err(|_| unavailable())?,
                ))
            }
            Err(keyring::Error::NoEntry) if !existing => {
                let key = Zeroizing::new(crypto::random_bytes::<32>());
                entry.set_secret(key.as_ref()).map_err(|_| unavailable())?;
                let stored = Zeroizing::new(entry.get_secret().map_err(|_| unavailable())?);
                if stored.as_slice() != key.as_ref() {
                    return Err(unavailable());
                }
                Ok(key)
            }
            Err(_) => Err(unavailable()),
        }
    }

    #[cfg(all(windows, test))]
    fn native_key(_existing: bool) -> Result<Zeroizing<[u8; 32]>> {
        // Compile the portable commands during Windows tests without using a real system keyring.
        Err(AppError::Crypto)
    }

    fn root(app: &AppHandle) -> Result<PathBuf> {
        let root = app.path().app_local_data_dir().map_err(|_| invalid())?;
        if !disk_usage::safe_path(&root) {
            return Err(invalid());
        }
        Ok(root)
    }

    fn encrypted(path: &Path) -> Result<Option<Vec<u8>>> {
        if !disk_usage::safe_path(path) {
            return Err(invalid());
        }
        match fs::metadata(path) {
            Ok(m) if m.is_file() && m.len() <= MAX_BYTES => Ok(Some(fs::read(path)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            _ => Err(invalid()),
        }
    }

    async fn worker<T: Send + 'static>(
        f: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> Result<T> {
        tauri::async_runtime::spawn_blocking(f)
            .await
            .map_err(|_| AppError::Internal("The archive operation failed.".into()))?
    }

    #[tauri::command]
    pub async fn portable_status(app: AppHandle) -> Result<PortableStatus> {
        worker(move || {
            let _operation = VAULT_IO.lock().unwrap_or_else(|e| e.into_inner());
            let root = root(&app)?;
            let archive = encrypted(&root.join(ARCHIVE))?
                .map(|blob| decode(&crypto::open(&*native_key(true)?, AAD, &blob)?))
                .transpose()?;
            let backups = owned_snapshots(&root.join("backups"))?.len();
            let has_archive = archive.is_some();
            let (accounts, appearance) = archive
                .map(|a| (a.accounts, a.settings))
                .unwrap_or_default();
            Ok(PortableStatus {
                has_archive,
                accounts,
                appearance,
                storage_bytes: disk_usage::size(&root).0,
                backups,
                version: env!("CARGO_PKG_VERSION"),
            })
        })
        .await
    }

    #[tauri::command]
    pub async fn portable_import(
        app: AppHandle,
        path: PathBuf,
        password: String,
        replace: bool,
    ) -> Result<()> {
        worker(move || {
            let password = Zeroizing::new(password);
            let _operation = VAULT_IO.lock().unwrap_or_else(|e| e.into_inner());
            let root = root(&app)?;
            let destination = root.join(ARCHIVE);
            let old = encrypted(&destination)?;
            if old.is_some() && !replace {
                return Err(AppError::Invalid(
                    "Confirm replacement of the existing archive first.".into(),
                ));
            }
            let payload = backup_codec::open_file(&path, &password)?;
            decode(&payload)?;
            let key =
                native_key(old.is_some() || !owned_snapshots(&root.join("backups"))?.is_empty())?;
            let sealed = crypto::seal(&key, AAD, &payload)?;
            fs::create_dir_all(&root)?;
            if let Some(old) = old {
                decode(&crypto::open(&key, AAD, &old)?)?;
                save_snapshot(&root.join("backups"), &old)?;
            }
            replace_file(&destination, &sealed)
        })
        .await
    }

    #[tauri::command]
    pub async fn portable_export(app: AppHandle, path: PathBuf, password: String) -> Result<()> {
        worker(move || {
            let password = Zeroizing::new(password);
            if password.chars().count() < 8 {
                return Err(AppError::Invalid(
                    "Use an export password of at least eight characters.".into(),
                ));
            }
            let _operation = VAULT_IO.lock().unwrap_or_else(|e| e.into_inner());
            let root = root(&app)?;
            if !disk_usage::safe_path(&path) || path.starts_with(&root) || path.exists() {
                return Err(AppError::Invalid(
                    "Choose a new export file outside the app data folder.".into(),
                ));
            }
            let blob = encrypted(&root.join(ARCHIVE))?.ok_or(AppError::NotFound)?;
            let payload = crypto::open(&*native_key(true)?, AAD, &blob)?;
            let content = backup_codec::seal_payload(&password, &payload, backup_codec::MAGIC)?;
            let temporary = path.with_extension(format!("{}.pending", uuid::Uuid::new_v4()));
            replace_file(&temporary, &content)?;
            // An atomic hard-link publishes the finished file without replacing an existing file.
            let result = fs::hard_link(&temporary, path);
            let _ = fs::remove_file(temporary);
            Ok(result?)
        })
        .await
    }

    #[tauri::command]
    pub async fn portable_backup(app: AppHandle) -> Result<()> {
        worker(move || {
            let _operation = VAULT_IO.lock().unwrap_or_else(|e| e.into_inner());
            let root = root(&app)?;
            let blob = encrypted(&root.join(ARCHIVE))?.ok_or(AppError::NotFound)?;
            decode(&crypto::open(&*native_key(true)?, AAD, &blob)?)?;
            save_snapshot(&root.join("backups"), &blob)
        })
        .await
    }

    pub fn run() {
        tauri::Builder::default()
            .plugin(tauri_plugin_single_instance::init(|app, _, _| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                }
            }))
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_dialog::init())
            .setup(|app| {
                tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("UnknownALT")
                .inner_size(1080.0, 720.0)
                .min_inner_size(640.0, 480.0)
                .initialization_script("window.__UNKNOWNALT_PORTABLE__ = true;")
                .build()?;
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                portable_status,
                portable_import,
                portable_export,
                portable_backup,
                crate::bulletins::update_bulletins,
                crate::analytics::public_analytics_search,
                crate::analytics_archive::analytics_archive,
                crate::analytics::public_analytics_snapshot,
                crate::analytics::public_analytics_trending,
                crate::analytics::public_analytics_studio,
                crate::analytics::public_discovery,
                crate::analytics::public_similar_games,
                crate::analytics::public_game_extras,
                crate::roblox_status::roblox_service_status,
                crate::analytics::creator_analytics_connect,
                crate::analytics::creator_analytics_disconnect,
                crate::analytics::creator_analytics_metrics,
                crate::analytics::creator_analytics_export
            ])
            .run(tauri::generate_context!())
            .expect("UnknownALT could not start");
    }
}

#[cfg(not(windows))]
pub use native::run;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_portable_archive_preserves_unknown_settings_and_exports() {
        let original = br#"{"version":1,"accounts":[{"userId":1,"username":"example","displayName":"Example","alias":"","cookie":"synthetic-fixture"}],"settings":{"theme":"dark","anotherSetting":2},"groups":[],"exportedAt":1}"#;
        let k = crypto::random_bytes::<32>();
        let sealed = crypto::seal(&k, AAD, original).unwrap();
        assert!(!sealed.windows(17).any(|b| b == b"synthetic-fixture"));
        let opened = crypto::open(&k, AAD, &sealed).unwrap();
        assert_eq!(opened.as_slice(), original);
        assert_eq!(decode(&opened).unwrap().accounts[0].username, "example");
        assert!(crypto::open(&[0; 32], AAD, &sealed).is_err());
    }

    #[test]
    fn snapshots_keep_five_and_leave_unrelated_files_alone() {
        let path =
            std::env::temp_dir().join(format!("UnknownAlt-portable-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        fs::write(path.join("keep.txt"), b"unrelated").unwrap();
        for i in 0..7 {
            save_snapshot(&path, &[i]).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let snapshots = owned_snapshots(&path).unwrap();
        assert_eq!(snapshots.len(), 5);
        assert_eq!(fs::read(&snapshots[0]).unwrap(), vec![6]);
        assert!(path.join("keep.txt").exists());
        for file in snapshots.into_iter().chain([path.join("keep.txt")]) {
            fs::remove_file(file).unwrap();
        }
        fs::remove_dir(path).unwrap();
    }
}
