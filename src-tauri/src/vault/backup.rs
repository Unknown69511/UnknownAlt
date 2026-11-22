//! Password-protected `.unknownalt` backups; legacy `.UnknownAlt` files use the same format.
//! Portable (no DPAPI); filenames are not involved in authentication or validation.
//!
//! Layout: `magic[8] | m_kib u32le | t u32le | p u32le | salt[16] | seal(key, header, json)`
//! where `header` is every byte before the sealed part and `key = Argon2id(password, salt)`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{AppError, Result};

pub use crate::backup_codec::MAGIC;
#[cfg(test)] use crate::backup_codec::LEGACY_MAGIC;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPayload {
    pub version: u32,
    pub exported_at: i64,
    pub accounts: Vec<BackupAccount>,
    pub groups: Vec<BackupGroup>,
    #[serde(default)]
    pub favourites: Vec<BackupFavourite>,
    /// The settings as stored (`model::Settings`), absent in older backups. Restored only when the
    /// import asks for it, and then through the same checks as a change made in the UI.
    #[serde(default)]
    pub settings: Option<serde_json::Value>,
    /// The Discord webhook URL, if one was set.
    #[serde(default)]
    pub discord_webhook: Option<Zeroizing<String>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFavourite {
    pub name: String,
    pub target: crate::model::LaunchTarget,
    pub user_ids: Vec<i64>,
    pub in_tray: bool,
    // Absent in backups from before favourites kept their launch options.
    #[serde(default)]
    pub options: crate::model::FavouriteOptions,
    /// Its groups by name (`options.group_ids` are this PC's ids, and travel empty).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupAccount {
    pub user_id: i64,
    pub username: String,
    pub display_name: String,
    pub alias: String,
    pub notes: String,
    pub color: Option<String>,
    pub favourite: bool,
    pub sort_order: i64,
    /// Group names.
    pub groups: Vec<String>,
    pub cookie: Zeroizing<String>,
    // Absent in backups from before 0.7; `allow_disconnect` always there after that.
    #[serde(default)]
    pub allow_disconnect: Option<bool>,
    #[serde(default)]
    pub launch_args: Option<String>,
    #[serde(default)]
    pub discord_muted: bool,
    #[serde(default)]
    pub fps_cap: Option<u32>,
    #[serde(default)]
    pub full_quality: bool,
    #[serde(default)]
    pub main: bool,
    // Absent in backups from before custom FFlags: the account's own flags stay then.
    #[serde(default)]
    pub custom_flags: Option<std::collections::BTreeMap<String, String>>,
    // Absent in backups from before account profiles: the account's own profile stays then.
    #[serde(default)]
    pub profile: Option<crate::performance::Profile>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupGroup {
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i64,
    /// What it gives its accounts; a backup from before 1.2 holds none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defaults: Option<crate::model::GroupDefaults>,
}

pub fn write(path: &Path, password: &str, payload: &BackupPayload) -> Result<()> {
    write_with_magic(path, password, payload, MAGIC)
}

fn write_with_magic(path: &Path, password: &str, payload: &BackupPayload, magic: &[u8; 8]) -> Result<()> {
    let json = Zeroizing::new(serde_json::to_vec(payload).map_err(|_| AppError::Internal(tr!("Could not encode the backup.")))?);
    write_atomic(path, &crate::backup_codec::seal_payload(password, &json, magic)?)
}

pub fn read(path: &Path, password: &str) -> Result<BackupPayload> {
    let json = crate::backup_codec::open_file(path, password)?;
    serde_json::from_slice(&json).map_err(|_| AppError::Invalid(tr!("This isn't an Unknown alt backup.")))
}
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let res = fs::File::create(&tmp)
        .and_then(|mut f| {
            f.write_all(bytes)?;
            f.sync_all()
        })
        .and_then(|()| fs::rename(&tmp, path));
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    Ok(res?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWORD: &str = "backup pass";

    fn tmp_path() -> PathBuf {
        std::env::temp_dir().join(format!("UnknownAlt-test-{}.UnknownAlt", uuid::Uuid::new_v4()))
    }

    fn sample() -> BackupPayload {
        BackupPayload {
            favourites: Vec::new(),
            settings: Some(serde_json::json!({ "fpsCap": 30 })),
            discord_webhook: Some(Zeroizing::new("https://discord.com/api/webhooks/1/x".into())),
            version: 1,
            exported_at: 1_700_000_000,
            accounts: vec![BackupAccount {
                user_id: 42,
                username: "builder".into(),
                display_name: "Builder".into(),
                alias: "main".into(),
                notes: String::new(),
                color: Some("#ff0000".into()),
                favourite: true,
                sort_order: 0,
                groups: vec!["Mains".into()],
                cookie: Zeroizing::new("fake-cookie".into()),
                allow_disconnect: Some(true),
                launch_args: Some("--x".into()),
                discord_muted: true,
                fps_cap: Some(30),
                full_quality: true,
                main: true,
                custom_flags: Some([("FFlagDebugSkyGray".into(), "True".into())].into()),
                profile: Some(crate::performance::Profile { fps_cap: Some(10), ..Default::default() }),
            }],
            groups: vec![BackupGroup { name: "Mains".into(), color: None, sort_order: 0, defaults: None }],
        }
    }

    #[test]
    fn older_backups_have_no_custom_flags() {
        let mut v = serde_json::to_value(&sample().accounts[0]).unwrap();
        v.as_object_mut().unwrap().remove("customFlags");
        v.as_object_mut().unwrap().remove("profile");
        let a: BackupAccount = serde_json::from_value(v).unwrap();
        assert!(a.custom_flags.is_none(), "None keeps the account's own flags on import");
        assert!(a.profile.is_none(), "and its own profile");
    }

    #[test]
    fn round_trip_and_wrong_password() {
        let path = tmp_path();
        write(&path, PASSWORD, &sample()).unwrap();
        let tmp_left = PathBuf::from(format!("{}.tmp", path.display())).exists();
        let back = read(&path, PASSWORD);
        let wrong = read(&path, "other pass");
        let _ = fs::remove_file(&path);

        assert!(!tmp_left);
        let back = back.unwrap();
        assert_eq!((back.version, back.exported_at), (1, 1_700_000_000));
        assert_eq!(back.accounts[0].cookie.as_str(), "fake-cookie");
        assert_eq!(back.accounts[0].groups, ["Mains"]);
        assert_eq!(back.accounts[0].custom_flags.as_ref().unwrap()["FFlagDebugSkyGray"], "True");
        assert_eq!(back.groups[0].name, "Mains");
        assert_eq!(back.settings.unwrap()["fpsCap"], 30);
        assert_eq!(back.discord_webhook.unwrap().as_str(), "https://discord.com/api/webhooks/1/x");
        assert!(matches!(wrong, Err(AppError::WrongPassword)));
    }

    #[test]
    fn new_backup_identity_keeps_legacy_authenticated_imports() {
        let path=tmp_path();
        write(&path,PASSWORD,&sample()).unwrap();
        assert!(fs::read(&path).unwrap().starts_with(MAGIC));
        write_with_magic(&path,PASSWORD,&sample(),LEGACY_MAGIC).unwrap();
        assert!(fs::read(&path).unwrap().starts_with(LEGACY_MAGIC));
        assert_eq!(read(&path,PASSWORD).unwrap().accounts[0].cookie.as_str(),"fake-cookie");
        let _=fs::remove_file(&path);
    }

    #[test]
    fn a_backup_with_the_removed_macros_still_reads() {
        let old: BackupPayload = serde_json::from_str(r#"{"version":1,"exportedAt":5,"accounts":[],"groups":[],"favourites":[],"macros":[{"name":"x","body":"Send 'w'"}]}"#).unwrap();
        assert_eq!(old.exported_at, 5);
        assert!(old.settings.is_none() && old.discord_webhook.is_none(), "a backup from before settings were in it");
    }

    #[test]
    fn rejects_files_that_are_not_backups() {
        let path = tmp_path();
        write(&path, PASSWORD, &sample()).unwrap();
        let good = fs::read(&path).unwrap();
        let check = |bytes: &[u8]| {
            fs::write(&path, bytes).unwrap();
            read(&path, PASSWORD)
        };
        let mut bad_magic = good.clone();
        bad_magic[0] = b'X';
        let mut absurd_cost = good.clone();
        absurd_cost[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        let rejected = [check(&bad_magic), check(&good[..30]), check(&absurd_cost), check(b"")];
        let cut_body = check(&good[..good.len() - 1]);
        let _ = fs::remove_file(&path);

        for r in rejected {
            assert!(matches!(r, Err(AppError::Invalid(m)) if m == "This isn't an Unknown alt backup."));
        }
        assert!(matches!(cut_body, Err(AppError::WrongPassword)));
    }
}
