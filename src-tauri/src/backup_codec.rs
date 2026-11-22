use crate::archive_master as master;
use crate::error::{AppError, Result};
use crate::secret_types::Kdf;
use std::{fs, path::Path};
use zeroize::Zeroizing;

pub const MAGIC: &[u8; 8] = b"UNALTBK1";
pub const LEGACY_MAGIC: &[u8; 8] = b"ROALTBK1";
const HEADER_LEN: usize = MAGIC.len() + 3 * 4 + 16;
/// Nonce and tag around the sealed JSON.
const SEAL_OVERHEAD: usize = 12 + 16;
/// Caps on the file's own KDF cost, so a crafted file cannot eat the machine.
const MAX_M_KIB: u32 = 1024 * 1024;
const MAX_T: u32 = 20;
const MAX_P: u32 = 16;

pub fn seal_payload(password: &str, json: &[u8], magic: &[u8; 8]) -> Result<Vec<u8>> {
    if json.len() > (64 << 20) - HEADER_LEN - SEAL_OVERHEAD {
        return Err(AppError::Invalid("The archive is too large.".into()));
    }
    let kdf = master::new_recovery_kdf();
    let mut header = magic.to_vec();
    for part in [kdf.m_kib, kdf.t, kdf.p] {
        header.extend_from_slice(&part.to_le_bytes());
    }
    header.extend_from_slice(&kdf.salt);
    let key = master::derive_key(password, &kdf)?;
    let sealed = master::seal(&key, &header, json)?;
    header.extend_from_slice(&sealed);
    Ok(header)
}

/// `WrongPassword` when the password (or file) does not authenticate,
/// `Invalid("This isn't an Unknown alt backup.")` on a bad magic / truncated file.
pub fn open_file(path: &Path, password: &str) -> Result<Zeroizing<Vec<u8>>> {
    let not_backup = || AppError::Invalid(tr!("This isn't an Unknown alt backup."));
    // About 2 KB per account: far above anyone's vault, and it isn't all read into memory first.
    if fs::metadata(path)?.len() > 64 << 20 {
        return Err(not_backup());
    }
    let bytes = fs::read(path)?;
    if bytes.len() < HEADER_LEN + SEAL_OVERHEAD
        || !(bytes.starts_with(MAGIC) || bytes.starts_with(LEGACY_MAGIC))
    {
        log::debug!(
            "not a backup: bad magic or truncated ({} bytes)",
            bytes.len()
        );
        return Err(not_backup());
    }
    let (header, sealed) = bytes.split_at(HEADER_LEN);
    let word =
        |i: usize| u32::from_le_bytes([header[i], header[i + 1], header[i + 2], header[i + 3]]);
    let kdf = Kdf {
        m_kib: word(8),
        t: word(12),
        p: word(16),
        salt: header[20..].to_vec(),
    };
    if kdf.m_kib > MAX_M_KIB || kdf.t > MAX_T || kdf.p > MAX_P {
        log::debug!(
            "not a backup: absurd KDF cost (m {} KiB, t {}, p {})",
            kdf.m_kib,
            kdf.t,
            kdf.p
        );
        return Err(not_backup());
    }
    let key = master::derive_key(password, &kdf).map_err(|e| {
        log::debug!("not a backup: key derivation failed: {e}");
        not_backup()
    })?;
    master::open(&key, header, sealed).map_err(|_| AppError::WrongPassword)
}
