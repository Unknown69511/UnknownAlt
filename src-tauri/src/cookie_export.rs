//! "Export cookies": every chosen account's cookie as `username:cookie` lines in a plain-text file
//! in `<data dir>\exports`, selected in Explorer. Anyone with the file can sign into those
//! accounts, so it goes after `DELETE_AFTER`, when UnknownAlt quits (`exit_cleanup`), at the next start
//! if UnknownAlt was killed or crashed, or when the user says. Only files UnknownAlt wrote are ever deleted;
//! neither cookies nor names reach the log.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use zeroize::Zeroizing;

use crate::error::{AppError, Result};
use crate::vault::Secret;

pub const DELETE_AFTER: Duration = Duration::from_secs(10 * 60);
const DIR: &str = "exports";
const PREFIX: &str = "UnknownAlt-cookies-";
// Also clean exports an earlier version left behind: these contain account credentials.
const LEGACY_PREFIX: &str = "RoALT-cookies-";

/// The files this run wrote and hasn't deleted yet, newest last.
static EXPORTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn exports() -> std::sync::MutexGuard<'static, Vec<PathBuf>> {
    EXPORTS.lock().unwrap_or_else(|e| e.into_inner())
}

/// `username:cookie` lines, CRLF-ended, for the accounts whose cookie could be read (pure).
/// Sized once so no growth leaves a copy of a cookie in a freed buffer (Zeroizing scrubs only the
/// live allocation). `name:cookie\r\n` is `name.len() + cookie.len() + 3`.
pub fn lines(accounts: &[(String, Secret)]) -> Zeroizing<String> {
    let total = accounts.iter().map(|(n, c)| n.len() + c.expose().len() + 3).sum();
    let mut out = Zeroizing::new(String::with_capacity(total));
    for (name, cookie) in accounts {
        out.push_str(name);
        out.push(':');
        out.push_str(cookie.expose());
        out.push_str("\r\n");
    }
    out
}

/// `UnknownAlt-cookies-YYYYMMDD-HHMMSS.txt`, in local time (pure).
fn file_name(t: (u16, u16, u16, u16, u16, u16)) -> String {
    let (y, mo, d, h, mi, s) = t;
    format!("{PREFIX}{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}.txt")
}

fn local_now() -> (u16, u16, u16, u16, u16, u16) {
    // SAFETY: GetLocalTime only fills the SYSTEMTIME it returns.
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    (t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}

/// An export file Unknown alt names: `UnknownAlt-cookies-*.txt`, or a `.txt.tmp` left by a write that crashed
/// before the atomic rename (`vault::backup::write_atomic`) (pure).
fn is_export(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| (n.starts_with(PREFIX) || n.starts_with(LEGACY_PREFIX)) && (n.ends_with(".txt") || n.ends_with(".txt.tmp")))
}

/// Writes `text` to a new export file and remembers it; returns its path.
pub fn write(data_dir: &Path, text: &str) -> Result<PathBuf> {
    let dir = data_dir.join(DIR);
    // For this Windows user only: a data folder moved elsewhere may let others read what it holds.
    std::fs::create_dir_all(&dir)?;
    secure_exports(&dir)?;
    let mut path = dir.join(file_name(local_now()));
    // Two exports within a second: the second gets its own file.
    for n in 2.. {
        if !path.exists() {
            break;
        }
        path = dir.join(file_name(local_now()).replace(".txt", &format!("-{n}.txt")));
    }
    crate::vault::backup::write_atomic(&path, text.as_bytes())?;
    exports().push(path.clone());
    Ok(path)
}

/// Deletes `path` if this run wrote it and it's still there.
pub fn forget(path: &Path) {
    let mut list = exports();
    if let Some(i) = list.iter().position(|p| p == path) {
        remove(&list.remove(i));
    }
}

/// Deletes every file this run wrote; how many there were.
pub fn delete_all() -> usize {
    let list = std::mem::take(&mut *exports());
    list.iter().for_each(|p| remove(p));
    list.len()
}

/// The newest file this run wrote that is still there.
pub fn newest() -> Option<PathBuf> {
    exports().iter().rev().find(|p| p.is_file()).cloned()
}

fn remove(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => log::info!("cookie export deleted"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("could not delete a cookie export: {e}"),
    }
}

/// At start: the export files a closed Unknown alt left behind, nothing else in the folder.
pub fn sweep(data_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(data_dir.join(DIR)) else { return };
    for p in entries.filter_map(|e| Some(e.ok()?.path())) {
        if p.is_file() && is_export(&p) {
            remove(&p);
        }
    }
}

/// Refused when no account had a cookie to export.
pub fn none_to_export() -> AppError {
    AppError::Invalid(tr!("None of these accounts has a cookie to export."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_are_username_colon_cookie() {
        let accounts = [("bob123".to_owned(), Secret::new("TOKEN-A")), ("alice".to_owned(), Secret::new("TOKEN-B"))];
        assert_eq!(lines(&accounts).as_str(), "bob123:TOKEN-A\r\nalice:TOKEN-B\r\n");
        assert_eq!(lines(&[]).as_str(), "");
    }

    #[test]
    fn names_its_files_and_sweeps_only_those() {
        assert_eq!(file_name((2026, 11, 4, 9, 5, 7)), "UnknownAlt-cookies-20261104-090507.txt");
        let d = std::env::temp_dir().join(format!("UnknownAlt-export-{}", uuid::Uuid::new_v4()));
        let dir = d.join(DIR);
        std::fs::create_dir_all(&dir).unwrap();
        // A `.txt.tmp` left by a crashed write is swept too; other files are left alone.
        let (ours, tmp, other, note) = (
            dir.join("UnknownAlt-cookies-20261104-090507.txt"),
            dir.join("UnknownAlt-cookies-20261104-090508.txt.tmp"),
            dir.join("mine.txt"),
            dir.join("UnknownAlt-cookies-x.log"),
        );
        for p in [&ours, &tmp, &other, &note] {
            std::fs::write(p, b"x").unwrap();
        }
        sweep(&d);
        let left = (ours.exists(), tmp.exists(), other.exists(), note.exists());
        let _ = std::fs::remove_dir_all(&d);
        assert_eq!(left, (false, false, true, true));
    }

    #[test]
    fn deletes_only_what_it_wrote() {
        let d = std::env::temp_dir().join(format!("UnknownAlt-export-{}", uuid::Uuid::new_v4()));
        let path = write(&d, "a:b\r\n").unwrap();
        let other = d.join(DIR).join("UnknownAlt-cookies-not-ours.txt");
        std::fs::write(&other, b"x").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a:b\r\n");
        assert_eq!(newest().as_ref(), Some(&path));
        forget(&other);
        assert!(other.exists(), "not written by this run");
        assert!(delete_all() >= 1);
        let left = (path.exists(), other.exists());
        let _ = std::fs::remove_dir_all(&d);
        assert_eq!(left, (false, true));
    }
}

/// Replace any previous directory ACL with an inheritable, protected current-user-only ACL.
/// Fail closed before writing credentials, including when a moved data directory already exists.
fn secure_exports(dir: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SetFileSecurityW, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION};
    use windows::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    let sid = crate::self_update::auth::current_user_sid()?;
    let sddl: Vec<u16> = format!("D:P(A;OICI;FA;;;{sid})").encode_utf16().chain(Some(0)).collect();
    let path: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let fail = || AppError::Invalid("Windows could not secure the cookie-export folder. Nothing was exported.".into());
    // SAFETY: input strings are terminated and alive; Windows owns descriptor until LocalFree.
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(sddl.as_ptr()), 1, &mut descriptor, None).map_err(|_| fail())?;
        let result = SetFileSecurityW(PCWSTR(path.as_ptr()), DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, descriptor).ok();
        LocalFree(Some(HLOCAL(descriptor.0)));
        result.map_err(|_| fail())
    }
}
