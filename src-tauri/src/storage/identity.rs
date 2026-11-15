//! One-time database filename migration. Encryption inputs deliberately stay unchanged:
//! a filename is branding, while DPAPI entropy and authenticated data are file formats.
//! Call only after the application's single-instance lock, before opening SQLite.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

use serde::{Deserialize, Serialize};
use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};

use crate::error::{AppError, Result};

pub const DATABASE: &str = "UnknownAlt.db";
pub const FILES: [&str; 4] = [DATABASE, "UnknownAlt.db-wal", "UnknownAlt.db-shm", "UnknownAlt.db.key"];
// Legacy filenames are inputs to this migration only, never names for a new database.
pub const LEGACY_FILES: [&str; 4] = ["roalt.db", "roalt.db-wal", "roalt.db-shm", "roalt.db.key"];
const JOURNAL: &str = ".UnknownAlt-database-migration.json";
const PENDING: &str = ".UnknownAlt-database-migration.pending";
const LOCK: &str = ".UnknownAlt-database-migration.lock";
const REPARSE_POINT: u32 = 0x400;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal { schema: u32, files: Vec<usize> }

fn invalid(reason: &str) -> AppError {
    AppError::Invalid(format!("Unknown alt could not safely migrate its database filename: {reason}. No files were overwritten. Keep the database, key and journals together and restore the complete saved backup if needed."))
}

fn exists(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_file() || meta.file_attributes() & REPARSE_POINT != 0 => Err(invalid("a database migration file is not a regular file")),
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

fn rename_new(from: &Path, to: &Path) -> Result<()> {
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // No REPLACE_EXISTING: a conflicting destination must never discard either database.
    // SAFETY: both NUL-terminated strings live through the call; this is a same-folder move.
    unsafe { MoveFileExW(PCWSTR(from.as_ptr()), PCWSTR(to.as_ptr()), MOVEFILE_WRITE_THROUGH) }
        .map_err(|_| invalid("a file is still open or a destination already exists"))
}

pub fn has_database(dir: &Path) -> bool {
    dir.join(DATABASE).is_file() || dir.join(LEGACY_FILES[0]).is_file() || dir.join(JOURNAL).is_file()
}

pub fn has_database_files(dir: &Path) -> bool {
    FILES.iter().chain(LEGACY_FILES.iter()).any(|name| dir.join(name).exists()) || dir.join(JOURNAL).exists()
}

fn read_journal(dir: &Path) -> Result<Journal> {
    let path = dir.join(JOURNAL);
    let mut bytes=Vec::new();
    File::open(path)?.take(8193).read_to_end(&mut bytes)?;
    if bytes.len()>8192 {return Err(invalid("migration metadata is too large"));}
    let journal: Journal=serde_json::from_slice(&bytes).map_err(|_|invalid("migration metadata is invalid"))?;
    let mut unique=journal.files.clone();unique.sort_unstable();unique.dedup();
    if journal.schema!=1 || journal.files.is_empty() || journal.files.last()!=Some(&0)
        || journal.files.iter().any(|&n|n>=FILES.len()) || unique.len()!=journal.files.len() {
        return Err(invalid("migration metadata contains an unexpected filename"));
    }
    Ok(journal)
}

fn begin(dir: &Path) -> Result<Option<Journal>> {
    let legacy=LEGACY_FILES.iter().map(|n|exists(&dir.join(n))).collect::<Result<Vec<_>>>()?;
    let current=FILES.iter().map(|n|exists(&dir.join(n))).collect::<Result<Vec<_>>>()?;
    if !legacy.iter().any(|&v|v) {return Ok(None);}
    if !legacy[0] || current.iter().any(|&v|v) {return Err(invalid("both old and new database files exist, or the old database is missing"));}
    // The key and journals move before the database itself. SQLite is never opened
    // between steps, and the durable journal makes an interrupted step resumable.
    let files=[3,1,2,0].into_iter().filter(|&n|legacy[n]).collect();
    let journal=Journal{schema:1,files};
    let pending=dir.join(PENDING);
    if exists(&pending)? {std::fs::remove_file(&pending)?;}
    let mut file=File::create_new(&pending)?;
    file.write_all(&serde_json::to_vec(&journal).map_err(|_|invalid("migration metadata could not be written"))?)?;
    file.sync_all()?;drop(file);
    rename_new(&pending,&dir.join(JOURNAL))?;
    Ok(Some(journal))
}

pub fn migrate(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    // Handles close at return. Windows refuses concurrent migration writers; a stale
    // lock file is harmless because only the live exclusive handle acts as the lock.
    let _lock=OpenOptions::new().create(true).truncate(false).read(true).write(true).share_mode(0).open(dir.join(LOCK))
        .map_err(|_|invalid("another database migration is still running"))?;
    let journal=if exists(&dir.join(JOURNAL))? {Some(read_journal(dir)?)} else {begin(dir)?};
    let Some(journal)=journal else {return Ok(())};
    for n in 0..FILES.len() {
        if !journal.files.contains(&n) && (exists(&dir.join(LEGACY_FILES[n]))? || exists(&dir.join(FILES[n]))?) {
            return Err(invalid("an unrecorded database file appeared during migration"));
        }
    }
    // Validate the entire transaction before resuming any additional move.
    for &n in &journal.files {
        let old=exists(&dir.join(LEGACY_FILES[n]))?;let new=exists(&dir.join(FILES[n]))?;
        if old==new {return Err(invalid("a migration source is missing or conflicts with its destination"));}
    }
    for &n in &journal.files {
        if exists(&dir.join(LEGACY_FILES[n]))? {rename_new(&dir.join(LEGACY_FILES[n]),&dir.join(FILES[n]))?;}
    }
    std::fs::remove_file(dir.join(JOURNAL))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Fixture {fn new()->Self {let p=std::env::temp_dir().join(format!("UnknownAlt-identity-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&p).unwrap();Self(p)}}
    impl Drop for Fixture {fn drop(&mut self){let _=std::fs::remove_dir_all(&self.0);}}
    fn seed(dir:&Path){for (n,name) in LEGACY_FILES.iter().enumerate(){std::fs::write(dir.join(name),format!("original-{n}")).unwrap();}}
    #[test] fn all_database_files_move_without_changing_bytes(){
        let f=Fixture::new();seed(&f.0);std::fs::write(f.0.join("personal-settings.txt"),"keep").unwrap();
        migrate(&f.0).unwrap();migrate(&f.0).unwrap();
        for (n,name) in FILES.iter().enumerate(){assert_eq!(std::fs::read_to_string(f.0.join(name)).unwrap(),format!("original-{n}"));assert!(!f.0.join(LEGACY_FILES[n]).exists());}
        assert_eq!(std::fs::read_to_string(f.0.join("personal-settings.txt")).unwrap(),"keep");
    }
    #[test] fn interrupted_migration_resumes_from_every_boundary(){
        for completed in 0..=4 {
            let f=Fixture::new();seed(&f.0);let j=begin(&f.0).unwrap().unwrap();
            for &n in j.files.iter().take(completed){rename_new(&f.0.join(LEGACY_FILES[n]),&f.0.join(FILES[n])).unwrap();}
            assert!(has_database(&f.0));migrate(&f.0).unwrap();
            for (n,name) in FILES.iter().enumerate(){assert_eq!(std::fs::read_to_string(f.0.join(name)).unwrap(),format!("original-{n}"));}
        }
    }
    #[test] fn ambiguous_or_incomplete_families_fail_without_overwriting(){
        let f=Fixture::new();seed(&f.0);std::fs::write(f.0.join(DATABASE),"newer").unwrap();
        assert!(migrate(&f.0).is_err());assert_eq!(std::fs::read_to_string(f.0.join(DATABASE)).unwrap(),"newer");
        assert_eq!(std::fs::read_to_string(f.0.join(LEGACY_FILES[0])).unwrap(),"original-0");
        let orphan=Fixture::new();std::fs::write(orphan.0.join(LEGACY_FILES[3]),"key").unwrap();assert!(migrate(&orphan.0).is_err());assert!(!orphan.0.join(DATABASE).exists());
    }
    #[test] fn malformed_journal_and_held_source_fail_without_creating_empty_database(){
        let f=Fixture::new();seed(&f.0);std::fs::write(f.0.join(JOURNAL),r#"{"schema":1,"files":[99,0]}"#).unwrap();
        assert!(migrate(&f.0).is_err());assert!(f.0.join(LEGACY_FILES[0]).exists());
        std::fs::remove_file(f.0.join(JOURNAL)).unwrap();
        let held=OpenOptions::new().read(true).share_mode(0).open(f.0.join(LEGACY_FILES[3])).unwrap();
        assert!(migrate(&f.0).is_err());assert!(!f.0.join(DATABASE).exists());drop(held);migrate(&f.0).unwrap();
    }
}
