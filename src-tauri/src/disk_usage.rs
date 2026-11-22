use crate::error::{AppError, Result};
use serde::Serialize;
use std::{fs, path::Path};
use ts_rs::TS;

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiskUsage {
    pub data_bytes: u64,
    pub database_bytes: u64,
    pub log_bytes: u64,
    pub removable_log_bytes: u64,
    pub backup_bytes: u64,
    pub cache_rows: u64,
    pub partial: bool,
}

fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

pub fn safe_path(path: &Path) -> bool {
    path.is_absolute()
        && path.ancestors().all(|p| match fs::symlink_metadata(p) {
            Ok(meta) => !linked(&meta),
            Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        })
}

pub fn size(path: &Path) -> (u64, bool) {
    if !safe_path(path) {
        return (0, true);
    }
    let mut pending = vec![path.to_owned()];
    let mut total = 0_u64;
    let mut partial = false;
    let mut count = 0;
    while let Some(path) = pending.pop() {
        count += 1;
        if count > 50_000 {
            return (total, true);
        }
        match fs::symlink_metadata(&path) {
            Ok(m) if linked(&m) => partial = true,
            Ok(m) if m.is_file() => total = total.saturating_add(m.len()),
            Ok(m) if m.is_dir() => match fs::read_dir(&path) {
                Ok(entries) => {
                    for entry in entries {
                        if pending.len() + count >= 50_000 {
                            partial = true;
                            break;
                        }
                        match entry {
                            Ok(e) => pending.push(e.path()),
                            Err(_) => partial = true,
                        }
                    }
                }
                Err(_) => partial = true,
            },
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => partial = true,
        }
    }
    (total, partial)
}

fn rotated_log(name: &str) -> bool {
    let Some(date) = name
        .strip_prefix("unknownalt_")
        .and_then(|n| n.strip_suffix(".log"))
    else {
        return false;
    };
    date.len() >= 15
        && date.len() <= 32
        && date
            .bytes()
            .all(|c| c.is_ascii_digit() || matches!(c, b'-' | b'_' | b'T'))
}

fn rotated_logs(path: &Path, remove: bool) -> Result<u64> {
    if !safe_path(path) {
        return Err(AppError::Invalid(
            "The log folder is redirected or unavailable.".into(),
        ));
    }
    if !path.exists() {
        return Ok(0);
    }
    let mut bytes = 0_u64;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if !rotated_log(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let target = entry.path();
        let metadata = fs::symlink_metadata(&target)?;
        if !metadata.is_file() || linked(&metadata) || !safe_path(&target) {
            continue;
        }
        if remove {
            fs::remove_file(target)?;
        }
        bytes = bytes.saturating_add(metadata.len());
    }
    Ok(bytes)
}

#[cfg(windows)]
pub mod windows {
    use super::*;
    use crate::App;
    use tauri::{AppHandle, Manager};

    fn read(s: &App) -> Result<DiskUsage> {
        let (data_bytes, partial) = size(&s.data_dir);
        let (backup_bytes, backup_partial) = size(&crate::automatic_backup::root()?);
        let logs = s.data_dir.join("logs");
        let (log_bytes, log_partial) = size(&logs);
        Ok(DiskUsage {
            data_bytes,
            backup_bytes,
            log_bytes,
            database_bytes: crate::DB_FILES
                .iter()
                .map(|f| size(&s.data_dir.join(f)).0)
                .sum(),
            removable_log_bytes: rotated_logs(&logs, false)?,
            cache_rows: s.db.cache_rows()?,
            partial: partial || backup_partial || log_partial,
        })
    }

    #[tauri::command]
    pub async fn disk_usage(app: AppHandle) -> Result<DiskUsage> {
        crate::launcher::update::blocking(move || read(&app.state::<App>())).await
    }

    #[tauri::command]
    pub async fn disk_cleanup(app: AppHandle, cache: bool, logs: bool) -> Result<DiskUsage> {
        crate::launcher::update::blocking(move || {
            let s = app.state::<App>();
            if logs {
                rotated_logs(&s.data_dir.join("logs"), true)?;
            }
            if cache {
                s.db.clear_cache()?;
            }
            read(&s)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn active_logs_and_private_files_are_never_cleanup_targets() {
        assert!(rotated_log("unknownalt_2026-11-22_02-20-30.log"));
        for name in [
            "unknownalt.log",
            "UnknownAlt.db",
            "unknownalt_../../outside.log",
            "unknownalt_personal.log",
        ] {
            assert!(!rotated_log(name));
        }
    }
}
