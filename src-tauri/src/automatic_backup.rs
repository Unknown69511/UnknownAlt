//! Consistent, encrypted local snapshots, including settings and the still-encrypted vault.
//! The key remains DPAPI-wrapped to the current Windows user. No password or raw key is exported.
use crate::{
    App,
    error::{AppError, Result},
    storage::Db,
};
use serde::{Deserialize, Serialize};
use std::os::windows::fs::MetadataExt;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use ts_rs::TS;

const PREFIX: &str = "UnknownAlt-backup-";
const META: &str = "backup.json";
const KEEP: usize = 5;
static WRITER: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AutomaticBackup {
    pub id: String,
    pub created_at: i64,
    pub version: String,
    pub reason: String,
    pub bytes: u64,
}
fn invalid() -> AppError {
    AppError::Invalid("UnknownALT could not safely create or verify its encrypted local backup. Existing backups were kept.".into())
}
pub fn root() -> Result<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")
        .filter(|p| !p.is_empty())
        .ok_or_else(invalid)?;
    let local = PathBuf::from(local);
    if !local.is_absolute() {
        return Err(invalid());
    }
    let name = if crate::store_package::active() { "UnknownAlt-MSIX-backups" } else { "UnknownAlt-backups" };
    Ok(local.join(name))
}
fn no_links(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err(invalid());
    }
    for parent in path.ancestors() {
        if let Ok(m) = fs::symlink_metadata(parent) {
            if m.file_attributes() & 0x400 != 0 {
                return Err(invalid());
            }
        }
    }
    Ok(())
}
fn named(id: &str) -> bool {
    let Some(tail) = id.strip_prefix(PREFIX) else {
        return false;
    };
    let Some((time, uuid)) = tail.split_once('-') else {
        return false;
    };
    time.len() == 13
        && time.bytes().all(|c| c.is_ascii_digit())
        && uuid::Uuid::parse_str(uuid).is_ok()
}
fn owned_files(dir: &Path) -> Result<bool> {
    no_links(dir)?;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if !meta.is_file() || meta.file_attributes() & 0x400 != 0 {
            return Ok(false);
        }
        let name = entry.file_name();
        if ![META, crate::DB_FILE, "UnknownAlt.db.key"]
            .iter()
            .any(|n| name == *n)
        {
            return Ok(false);
        }
    }
    Ok(true)
}
pub fn list_at(root: &Path) -> Result<Vec<AutomaticBackup>> {
    no_links(root)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if !named(&id) || !entry.file_type()?.is_dir() {
            continue;
        }
        let dir = entry.path();
        if !owned_files(&dir)? {
            continue;
        }
        let file = dir.join(META);
        if !file.is_file() || fs::metadata(&file)?.len() > 4096 {
            continue;
        }
        let Ok(info) = serde_json::from_slice::<AutomaticBackup>(&fs::read(file)?) else {
            continue;
        };
        if info.id != id
            || !matches!(
                info.reason.as_str(),
                "before-update" | "manual" | "before-repair"
            )
        {
            continue;
        }
        if !dir.join(crate::DB_FILE).is_file() || !dir.join("UnknownAlt.db.key").is_file() {
            continue;
        }
        out.push(info);
    }
    out.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(out)
}
fn remove_snapshot(root: &Path, id: &str) -> Result<()> {
    if !named(id) {
        return Err(invalid());
    }
    let dir = root.join(id);
    no_links(&dir)?;
    if dir.parent() != Some(root) || !owned_files(&dir)? {
        return Err(invalid());
    }
    for name in [META, crate::DB_FILE, "UnknownAlt.db.key"] {
        fs::remove_file(dir.join(name))?;
    }
    fs::remove_dir(dir)?;
    Ok(())
}
pub fn create_at(db: &Db, root: &Path, reason: &str) -> Result<AutomaticBackup> {
    let _writer = WRITER.lock().unwrap_or_else(|e| e.into_inner());
    if !matches!(reason, "before-update" | "manual" | "before-repair") {
        return Err(invalid());
    }
    no_links(root)?;
    fs::create_dir_all(root)?;
    crate::cookie_export::secure_exports(root)?;
    let created_at = crate::commands::now_ms();
    let id = format!("{PREFIX}{created_at:013}-{}", uuid::Uuid::new_v4());
    let pending = root.join(format!(".pending-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&pending)?;
    crate::cookie_export::secure_exports(&pending)?;
    let result = (|| {
        let database = pending.join(crate::DB_FILE);
        db.copy_to(&database, || Ok(()))?;
        // In-memory/plain test DBs cannot accidentally produce an unencrypted automatic backup.
        if !crate::storage::key_path(&database).is_file() {
            return Err(invalid());
        }
        Db::verify_snapshot(&database)?;
        let bytes = fs::metadata(&database)?.len()
            + fs::metadata(crate::storage::key_path(&database))?.len();
        let info = AutomaticBackup {
            id: id.clone(),
            created_at,
            version: env!("CARGO_PKG_VERSION").into(),
            reason: reason.into(),
            bytes,
        };
        crate::vault::backup::write_atomic(
            &pending.join(META),
            &serde_json::to_vec(&info).map_err(|_| invalid())?,
        )?;
        fs::rename(&pending, root.join(&id))?;
        // Only after the new encrypted snapshot was verified and atomically committed.
        let all = list_at(root)?;
        for old in all.iter().skip(KEEP) {
            remove_snapshot(root, &old.id)?;
        }
        Ok(info)
    })();
    if result.is_err() && pending.is_dir() {
        // Only fixed files in the UUID directory created by this call; never recursive deletion.
        for name in [
            META,
            "backup.json.tmp",
            crate::DB_FILE,
            "UnknownAlt.db.key",
            "UnknownAlt.db.partial",
            "UnknownAlt.db.key.tmp",
        ] {
            let file = pending.join(name);
            if file.is_file() && no_links(&file).is_ok() {
                let _ = fs::remove_file(file);
            }
        }
        let _ = fs::remove_dir(&pending);
    }
    result
}

#[tauri::command]
pub async fn automatic_backups_list() -> Result<Vec<AutomaticBackup>> {
    crate::launcher::update::blocking(|| list_at(&root()?)).await
}
#[tauri::command]
pub async fn automatic_backup_now(app: tauri::AppHandle) -> Result<AutomaticBackup> {
    use tauri::Manager;
    crate::launcher::update::blocking(move || create_at(&app.state::<App>().db, &root()?, "manual"))
        .await
}
#[tauri::command]
pub async fn automatic_backups_open(app: tauri::AppHandle) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = root()?;
    no_links(&dir)?;
    fs::create_dir_all(&dir)?;
    crate::cookie_export::secure_exports(&dir)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|_| AppError::Invalid("Windows could not open the backup folder.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_snapshots_retain_five_and_restore_settings() {
        let folder =
            std::env::temp_dir().join(format!("UnknownAlt-backup-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&folder).unwrap();
        let db = Db::open(&folder.join(crate::DB_FILE)).unwrap();
        let (vault, record) = crate::vault::Vault::create().unwrap();
        let master = vault
            .rewrap(
                &record,
                crate::model::VaultMode::Master,
                None,
                Some("fixture-master-password"),
            )
            .unwrap();
        db.save_vault_record(&master).unwrap();
        let aad = crate::vault::cookie_aad(42);
        let cookie = vault
            .encrypt(&aad, b"synthetic-cookie-for-backup-test")
            .unwrap();
        let account = db
            .upsert_account(&crate::storage::NewAccount {
                user_id: 42,
                username: "backup_fixture",
                display_name: "Fixture",
                cookie: &cookie,
                status: crate::model::AccountStatus::Unknown,
                checked_at: None,
            })
            .unwrap();
        drop(vault);
        let vault = crate::vault::Vault::open(&master).unwrap();
        assert!(vault.is_locked());
        let root = folder.join("backups");
        for n in 0..7 {
            db.set_setting_value("test-private-value", Some(&format!("private-fixture-{n}")))
                .unwrap();
            create_at(&db, &root, "before-update").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let all = list_at(&root).unwrap();
        assert_eq!(all.len(), KEEP);
        let before: Vec<_> = all.iter().map(|b| b.id.clone()).collect();
        assert!(create_at(&Db::open_in_memory().unwrap(), &root, "before-update").is_err());
        assert_eq!(
            list_at(&root)
                .unwrap()
                .iter()
                .map(|b| b.id.clone())
                .collect::<Vec<_>>(),
            before,
            "failed backups never prune retained snapshots"
        );
        for info in &all {
            Db::verify_snapshot(&root.join(&info.id).join(crate::DB_FILE)).unwrap();
        }
        let newest = root.join(&all[0].id).join(crate::DB_FILE);
        let bytes = fs::read(&newest).unwrap();
        assert!(!bytes.starts_with(b"SQLite format 3"));
        assert!(!bytes.windows(15).any(|b| b == b"private-fixture"));
        // Restore a copy, leaving the retained snapshot immutable.
        let restored = folder.join("restore");
        fs::create_dir(&restored).unwrap();
        fs::copy(&newest, restored.join(crate::DB_FILE)).unwrap();
        fs::copy(
            crate::storage::key_path(&newest),
            restored.join("UnknownAlt.db.key"),
        )
        .unwrap();
        let opened = Db::open(&restored.join(crate::DB_FILE)).unwrap();
        let saved_vault = opened.vault_record().unwrap().unwrap();
        let reopened = crate::vault::Vault::open(&saved_vault).unwrap();
        assert!(reopened.is_locked());
        reopened
            .unlock(&saved_vault, "fixture-master-password")
            .unwrap();
        let (user, blob) = opened.account_cookie(account).unwrap();
        assert_eq!(user, 42);
        assert_eq!(
            reopened.decrypt(&aad, &blob).unwrap().as_slice(),
            b"synthetic-cookie-for-backup-test"
        );
        assert_eq!(
            opened
                .setting_value("test-private-value")
                .unwrap()
                .as_deref(),
            Some("private-fixture-6")
        );
        fs::write(root.join("keep-me.txt"), b"not a backup").unwrap();
        create_at(&db, &root, "manual").unwrap();
        assert!(root.join("keep-me.txt").exists());
        assert!(create_at(&db, &root, "../escape").is_err());
        drop(opened);
        drop(db);
        fs::remove_dir_all(folder).unwrap();
    }
    #[test]
    fn plaintext_or_failed_snapshots_never_prune_existing_backups() {
        let folder =
            std::env::temp_dir().join(format!("UnknownAlt-failed-backup-{}", uuid::Uuid::new_v4()));
        let db = Db::open_in_memory().unwrap();
        assert!(create_at(&db, &folder, "before-update").is_err());
        assert!(list_at(&folder).unwrap().is_empty());
        assert!(!named("UnknownAlt-backup-../../outside"));
        fs::remove_dir_all(folder).unwrap();
    }
}
