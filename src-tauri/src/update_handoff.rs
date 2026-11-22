//! Trusted update-helper handoff and startup health commit barrier.
//! Neither paths nor release fields come from the WebView. Only the signed release and
//! this running binary's embedded channel can select an installation.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::FILETIME;
use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};

use crate::App;
use crate::error::{AppError, Result};
use crate::self_update::{Channel, MANIFEST_FILE, Release, SIGNATURE_FILE};

const PREFIX: &str = "unknownalt-update-";
const HEALTH_FILE_ENV: &str = "UNKNOWNALT_UPDATE_HEALTH_FILE";
const HEALTH_NONCE_ENV: &str = "UNKNOWNALT_UPDATE_HEALTH_NONCE";
const NO_WINDOW: u32 = 0x0800_0000;
const SHARE_READ: u32 = 1;
const REPARSE_POINT: u32 = 0x400;
static HEALTH_PENDING: AtomicBool = AtomicBool::new(false);
static PROBE: OnceLock<HealthProbe> = OnceLock::new();
// Deny writes/deletes while the helper starts. Handles live until the old process exits.
static HANDOFF_PINS: Mutex<Vec<File>> = Mutex::new(Vec::new());
// Unit tests never spawn an installer/helper. Production always embeds the reviewed script.
#[cfg(test)]
const HELPER_SCRIPT: &str = "";
#[cfg(not(test))]
const HELPER_SCRIPT: &str = include_str!("../update-helper.ps1");

pub fn release_pins() {HANDOFF_PINS.lock().unwrap_or_else(|e|e.into_inner()).clear();}

#[derive(Clone)]
struct HealthProbe { file: PathBuf, nonce: String }

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct UpdateLock {stage_dir:PathBuf,nonce:String}

#[derive(Deserialize)]
struct JournalHeader {schema:u32,nonce:String,phase:String}

#[derive(Debug, PartialEq)]
enum StartupDecision {Continue,Wait,Recover}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Health { nonce: String, pid: u32, version: String }

#[derive(Clone, Serialize, Deserialize)]
pub struct UpdateOutcome { pub status: String, pub message: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    schema: u32,
    parent_pid: u32,
    parent_start_file_time: u64,
    current_version: &'static str,
    current_exe: PathBuf,
    install_dir: PathBuf,
    data_dir: PathBuf,
    default_data_dir: PathBuf,
    stage_dir: PathBuf,
    expected_version: String,
    installer_file: PathBuf,
    manifest_file: PathBuf,
    signature_file: PathBuf,
    ready_file: PathBuf,
    outcome_file: PathBuf,
    health_file: PathBuf,
    health_nonce: String,
}

fn invalid(message: &str) -> AppError { AppError::Invalid(message.into()) }

pub fn health_pending() -> bool { HEALTH_PENDING.load(Ordering::Acquire) }

pub fn staging_root() -> Result<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA").filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("Windows could not locate Unknown alt's update staging folder."))?;
    let local = PathBuf::from(local);
    if !local.is_absolute() { return Err(invalid("Unknown alt's update staging folder must be absolute.")); }
    Ok(local.join("UnknownAlt-update-staging"))
}

fn system32() -> Result<PathBuf> {
    let mut buffer = [0u16; 32768];
    // SAFETY: the API writes only to the supplied writable buffer.
    let size = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
    if size == 0 || size >= buffer.len() { return Err(invalid("Windows could not locate its trusted system tools.")); }
    Ok(PathBuf::from(String::from_utf16_lossy(&buffer[..size])))
}

fn regular_dir(path: &Path) -> Result<()> {
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_dir() || meta.file_attributes() & REPARSE_POINT != 0 {
        return Err(invalid("Unknown alt's update folder cannot be a link or junction."));
    }
    Ok(())
}

fn canonical(path: &Path) -> Result<PathBuf> {
    let path=path.canonicalize()?;
    let text=path.to_string_lossy();
    // PowerShell 5.1's .NET filesystem APIs expect ordinary absolute Windows paths.
    if let Some(unc)=text.strip_prefix(r"\\?\UNC\") {return Ok(PathBuf::from(format!(r"\\{unc}")));}
    Ok(text.strip_prefix(r"\\?\").map(PathBuf::from).unwrap_or(path))
}

fn private_dir(path: &Path) -> Result<()> {
    regular_dir(path)?;
    let user = std::env::var("USERNAME").map_err(|_| invalid("Windows could not identify the update folder owner."))?;
    if user.is_empty() { return Err(invalid("Windows could not identify the update folder owner.")); }
    let icacls=system32()?.join("icacls.exe");
    // Remove pre-existing explicit grants as well as inheritance. A precreated staging
    // root must not retain another user's write access after a successful grant command.
    let reset=Command::new(&icacls).arg(path).arg("/reset").creation_flags(NO_WINDOW).output()?;
    if !reset.status.success() {return Err(invalid("Unknown alt could not secure its update folder. Nothing was installed."));}
    let result = Command::new(icacls).arg(path)
        .args(["/inheritance:r", "/grant:r", &format!("{user}:(OI)(CI)F"), "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"])
        .creation_flags(NO_WINDOW).output()?;
    if !result.status.success() { return Err(invalid("Unknown alt could not secure its update folder. Nothing was installed.")); }
    Ok(())
}

pub fn new_stage() -> Result<PathBuf> {
    let root = staging_root()?;
    std::fs::create_dir_all(&root)?;
    private_dir(&root)?;
    let stage = root.join(format!("{PREFIX}{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&stage)?;
    if let Err(e) = private_dir(&stage) { let _=std::fs::remove_dir(&stage); return Err(e); }
    Ok(stage)
}

fn valid_probe_path(file: &Path, root: &Path) -> bool {
    if !file.is_absolute() || file.file_name().and_then(|s|s.to_str()) != Some("health.json") { return false; }
    let Some(stage)=file.parent() else {return false};
    if stage.parent() != Some(root) {return false;}
    let Some(name)=stage.file_name().and_then(|s|s.to_str()).and_then(|s|s.strip_prefix(PREFIX)) else {return false};
    uuid::Uuid::parse_str(name).is_ok()
}

/// Call first in main, before any thread exists. The values must never reach child processes.
pub fn capture_health_probe() {
    let file=std::env::var_os(HEALTH_FILE_ENV);
    let nonce=std::env::var(HEALTH_NONCE_ENV).ok();
    // SAFETY: main invokes this before Tauri, runtime, logging or other threads start.
    unsafe {std::env::remove_var(HEALTH_FILE_ENV);std::env::remove_var(HEALTH_NONCE_ENV);}
    if file.is_none() && nonce.is_none() {return;}
    // Malformed probes fail closed too: they must not let a partially installed app mutate data.
    HEALTH_PENDING.store(true,Ordering::Release);
    let (Some(file),Some(nonce),Ok(root))=(file,nonce,staging_root()) else {return};
    let file=PathBuf::from(file);
    if uuid::Uuid::parse_str(&nonce).is_err() {return;}
    let Some(stage)=file.parent() else {return};
    if regular_dir(&root).is_err() || regular_dir(stage).is_err() {return;}
    let (Ok(actual_root),Ok(actual_stage))=(canonical(&root),canonical(stage)) else {return};
    let actual_file=actual_stage.join("health.json");
    if !valid_probe_path(&actual_file,&actual_root) || file.file_name().and_then(|s|s.to_str())!=Some("health.json") {return;}
    let _=PROBE.set(HealthProbe{file:actual_file,nonce});
}

fn startup_decision(live:bool,matching_probe:bool,journal:Option<&JournalHeader>,nonce:&str)->Result<StartupDecision> {
    if matching_probe {return Ok(StartupDecision::Continue);}
    if live {return Ok(StartupDecision::Wait);}
    match journal {
        None=>Ok(StartupDecision::Continue), // Dead helper preflight never started installation.
        Some(j) if j.schema!=1 || j.nonce!=nonce || j.phase.is_empty()=>Err(recovery_required()),
        Some(j) if matches!(j.phase.as_str(),"committed"|"rolled_back")=>Ok(StartupDecision::Continue),
        Some(_)=>Ok(StartupDecision::Recover),
    }
}

fn recovery_required()->AppError {
    invalid("Unknown alt has an interrupted update awaiting recovery. Restart Windows to run its retained recovery helper before opening Unknown alt. The previous version and saved-data backups are preserved.")
}

fn helper_script(channel:&Channel)->Result<String> {
    let script=HELPER_SCRIPT
        .replace("__UNKNOWNALT_PUBLIC_KEY__",&channel.public_key_p256)
        .replace("__UNKNOWNALT_OWNER__",&channel.owner)
        .replace("__UNKNOWNALT_REPOSITORY__",&channel.repository)
        .replace("__UNKNOWNALT_CHANNEL__",&channel.channel);
    if script.trim().is_empty() || script.contains("__UNKNOWNALT_") {return Err(invalid("Unknown alt's trusted update helper is incomplete."));}
    Ok(script)
}

fn begin_recovery(stage:&Path,nonce:&str,install:&Path)->Result<()> {
    #[derive(Deserialize)] #[serde(rename_all="camelCase")]
    struct RecoveryRequest {schema:u32,stage_dir:PathBuf,health_nonce:String,install_dir:PathBuf,current_exe:PathBuf}
    let script_file=stage.join("update-helper.ps1");
    let request_file=stage.join("request.json");
    // Never execute a path supplied by metadata. Pin and compare the fixed staged helper
    // against this binary's embedded code and pinned channel before starting recovery.
    for path in [&script_file,&request_file] {
        let meta=std::fs::symlink_metadata(path).map_err(|_|recovery_required())?;
        if !meta.is_file() || meta.file_attributes()&REPARSE_POINT!=0 {return Err(recovery_required());}
    }
    let mut pinned_script=OpenOptions::new().read(true).share_mode(SHARE_READ).open(&script_file).map_err(|_|recovery_required())?;
    let pinned_request=OpenOptions::new().read(true).share_mode(SHARE_READ).open(&request_file).map_err(|_|recovery_required())?;
    let channel=Channel::parse(include_str!("../update-channel.json")).ok().flatten().ok_or_else(recovery_required)?;
    let expected=helper_script(&channel).map_err(|_|recovery_required())?;
    let mut actual=Vec::new();(&mut pinned_script).take(1_000_001).read_to_end(&mut actual)?;
    if actual.len()>1_000_000 || actual!=expected.as_bytes() {return Err(recovery_required());}
    let request=bounded_json_limit::<RecoveryRequest>(&request_file,32768).map_err(|_|recovery_required())?;
    if request.schema!=1 || request.health_nonce!=nonce || !crate::same_dir(&request.stage_dir,stage)
        || !crate::same_dir(&request.install_dir,install) || !crate::same_dir(&request.current_exe,&install.join("UnknownAlt.exe")) {return Err(recovery_required());}
    // The trusted helper takes its exclusive transaction/install locks, re-verifies the
    // signed payload and complete request, restores backups, and reopens the old app.
    let child=Command::new(system32()?.join(r"WindowsPowerShell\v1.0\powershell.exe"))
        .args(["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File"]).arg(script_file)
        .arg("-RequestFile").arg(request_file).arg("-Recover")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(NO_WINDOW).spawn().map_err(|_|recovery_required())?;
    HANDOFF_PINS.lock().unwrap_or_else(|e|e.into_inner()).extend([pinned_script,pinned_request]);
    drop(child);
    // This manual startup has not opened the DB. Recovery must be the only writer.
    std::process::exit(0)
}

/// A manual launch must not open the database during replacement or while an interrupted
/// transaction could later restore older data. A dead OS lock alone does not mean safety.
pub fn guard_startup() -> Result<()> {
    let exe=std::env::current_exe()?;
    let install=exe.parent().ok_or_else(||invalid("Unknown alt's installation folder is unavailable."))?;
    let lock=install.join(".unknownalt-update.lock");
    if !lock.exists() {return Ok(());}
    // The helper denies FileShare.Write; stale locks still carry the durable transaction.
    let live=OpenOptions::new().read(true).write(true).share_mode(7).open(&lock).is_err();
    let held=bounded_json::<UpdateLock>(&lock).map_err(|_|recovery_required())?;
    if uuid::Uuid::parse_str(&held.nonce).is_err() {return Err(recovery_required());}
    let root=staging_root()?;
    if !valid_probe_path(&held.stage_dir.join("health.json"),&root)
        && !(held.stage_dir.parent().is_some_and(|p|crate::same_dir(p,&root))
            && held.stage_dir.file_name().and_then(|s|s.to_str()).and_then(|s|s.strip_prefix(PREFIX)).is_some_and(|s|uuid::Uuid::parse_str(s).is_ok())) {return Err(recovery_required());}
    if !held.stage_dir.try_exists().map_err(|_|recovery_required())? {
        return if live {Err(invalid("Unknown alt is finishing an update. Wait for it to restart before opening it again."))} else {Ok(())};
    }
    regular_dir(&root).map_err(|_|recovery_required())?;regular_dir(&held.stage_dir).map_err(|_|recovery_required())?;
    let stage=canonical(&held.stage_dir).map_err(|_|recovery_required())?;
    if stage.parent()!=Some(canonical(&root)?.as_path()) {return Err(recovery_required());}
    let matching_probe=PROBE.get().is_some_and(|p|held.nonce==p.nonce && Some(stage.as_path())==p.file.parent());
    let journal_file=stage.join("transaction.json");
    let journal=if journal_file.try_exists().map_err(|_|recovery_required())? {
        Some(bounded_json_limit::<JournalHeader>(&journal_file,16_000_000).map_err(|_|recovery_required())?)
    } else {None};
    match startup_decision(live,matching_probe,journal.as_ref(),&held.nonce)? {
        StartupDecision::Continue=>Ok(()),
        StartupDecision::Wait=>Err(invalid("Unknown alt is finishing an update. Wait for it to restart before opening it again.")),
        StartupDecision::Recover=>begin_recovery(&stage,&held.nonce,install),
    }
}

/// While the helper can still roll back data, allow only UI boot reads and window/event plumbing.
pub fn command_allowed(command: &str) -> bool {
    if !health_pending() {return true;}
    if command.starts_with("plugin:event|") || command.starts_with("plugin:window|") || command.starts_with("plugin:webview|") {return true;}
    matches!(command,
        "management_status" | "troubleshoot_diagnose" | "automatic_backups_list" | "farm_status" |
        "update_health_ready" | "vault_status" | "settings_get" | "app_activity" | "splash_done" |
        "self_update_status" | "update_auth_status" | "network_status" | "background_get" | "accounts_list" | "groups_list" |
        "instances_list" | "favourites_list" | "bulk_current" | "roblox_client" | "multi_instance_status" |
        "crashes_list" | "instances_metrics" | "system_usage" | "bandwidth_status" | "discord_get" |
        "data_dir_info" | "shutdown_status" | "playtime_list" | "server_history" | "debug_tail")
}

fn bounded_json<T: for<'a> Deserialize<'a>>(path: &Path) -> Result<T> {
    bounded_json_limit(path,8192)
}

fn bounded_json_limit<T: for<'a> Deserialize<'a>>(path: &Path,limit:u64) -> Result<T> {
    let meta=std::fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.file_attributes() & REPARSE_POINT != 0 || meta.len()>limit {return Err(invalid("Unknown alt's update metadata is invalid."));}
    let mut bytes=Vec::new(); File::open(path)?.take(limit+1).read_to_end(&mut bytes)?;
    if bytes.len() as u64>limit {return Err(invalid("Unknown alt's update metadata is too large."));}
    serde_json::from_slice(&bytes).map_err(|_|invalid("Unknown alt's update acknowledgement could not be read."))
}

fn atomic_health(path: &Path, health: &Health) -> Result<()> {
    let pending=path.with_extension("pending");
    let mut file=File::create_new(&pending)?;
    file.write_all(&serde_json::to_vec(health).map_err(|_|invalid("Unknown alt could not write its startup acknowledgement."))?)?;
    file.sync_all()?; drop(file); std::fs::rename(pending,path)?; Ok(())
}

pub async fn health_ready() -> Result<Option<UpdateOutcome>> {
    crate::launcher::update::blocking(|| {
        if health_pending() {
            let probe=PROBE.get().ok_or_else(||invalid("Unknown alt's update startup information is invalid. Close the app to recover the previous version."))?;
            let health=Health{nonce:probe.nonce.clone(),pid:std::process::id(),version:env!("CARGO_PKG_VERSION").into()};
            if !probe.file.exists() {atomic_health(&probe.file,&health)?;}
            let ack=PathBuf::from(format!("{}.ack",probe.file.display()));
            let start=Instant::now();
            loop {
                if let Ok(reply)=bounded_json::<Health>(&ack) {
                    if reply.nonce!=health.nonce || reply.pid!=health.pid || reply.version!=health.version {return Err(invalid("Unknown alt's update commit acknowledgement did not match this process."));}
                    HEALTH_PENDING.store(false,Ordering::Release);break;
                }
                if start.elapsed()>Duration::from_secs(65) {return Err(invalid("Unknown alt's update did not finish committing. Close the app so the previous version can be recovered."));}
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        take_outcome()
    }).await
}

fn take_outcome() -> Result<Option<UpdateOutcome>> {
    let file=crate::default_dir().join("update-result.json");
    if !file.exists() {return Ok(None);}
    let value=bounded_json::<UpdateOutcome>(&file)?;
    if !matches!(value.status.as_str(),"success"|"rolled_back"|"failed") || value.message.len()>2048 {return Err(invalid("Unknown alt's update result is invalid."));}
    std::fs::remove_file(file)?;Ok(Some(value))
}

fn write_pinned(path: &Path, bytes: &[u8]) -> Result<File> {
    let mut f=File::create_new(path)?;f.write_all(bytes)?;f.sync_all()?;drop(f);
    Ok(OpenOptions::new().read(true).share_mode(SHARE_READ).open(path)?)
}

fn parent_start_time() -> Result<u64> {
    let(mut creation,mut exit,mut kernel,mut user)=(FILETIME::default(),FILETIME::default(),FILETIME::default(),FILETIME::default());
    // SAFETY: pseudo-handle is valid for this process and all out pointers are writable.
    unsafe{GetProcessTimes(GetCurrentProcess(),&mut creation,&mut exit,&mut kernel,&mut user)}
        .map_err(|_|invalid("Windows could not identify this Unknown alt process for a safe restart."))?;
    Ok((u64::from(creation.dwHighDateTime)<<32)|u64::from(creation.dwLowDateTime))
}

fn wait_ready(child: &mut Child,path: &Path,nonce: &str) -> Result<()> {
    #[derive(Deserialize)] struct Ready{status:String,nonce:String}
    let start=Instant::now();
    loop {
        if child.try_wait()?.is_some() {return Err(invalid("Unknown alt's update helper could not prepare a safe restart. Nothing was installed."));}
        if let Ok(ready)=bounded_json::<Ready>(path) {
            if ready.status=="ready" && ready.nonce==nonce {return Ok(());}
            return Err(invalid("Unknown alt's update helper returned an invalid readiness acknowledgement."));
        }
        if start.elapsed()>Duration::from_secs(10) {return Err(invalid("Unknown alt's update helper did not become ready. Nothing was installed."));}
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub fn handoff(app:&AppHandle,release:&Release,installer:&Path,stage:&Path)->Result<()> {
    let root=canonical(&staging_root()?)?;
    regular_dir(stage)?;let stage=canonical(stage)?;
    if stage.parent()!=Some(root.as_path()) || !valid_probe_path(&stage.join("health.json"),&root) {return Err(invalid("Unknown alt's update staging path is invalid."));}
    let installer=canonical(installer)?;
    if installer.parent()!=Some(stage.as_path()) || installer.file_name().and_then(|s|s.to_str())!=Some(release.installer.file_name.as_str()) {return Err(invalid("Unknown alt's verified installer path is invalid."));}
    let current_exe=canonical(&std::env::current_exe()?)?;
    let install_dir=current_exe.parent().ok_or_else(||invalid("Unknown alt's installation folder could not be identified."))?.to_owned();
    let health_nonce=uuid::Uuid::new_v4().to_string();
    let s=app.state::<App>();
    let request=Request{schema:1,parent_pid:std::process::id(),parent_start_file_time:parent_start_time()?,current_version:env!("CARGO_PKG_VERSION"),
        current_exe,install_dir,data_dir:canonical(&s.data_dir)?,default_data_dir:crate::default_dir(),stage_dir:stage.clone(),expected_version:release.version.clone(),
        installer_file:installer,manifest_file:stage.join(MANIFEST_FILE),signature_file:stage.join(SIGNATURE_FILE),ready_file:stage.join("ready.json"),
        outcome_file:crate::default_dir().join("update-result.json"),health_file:stage.join("health.json"),health_nonce};
    let script=helper_script(&release.config)?;
    let script_file=stage.join("update-helper.ps1");let request_file=stage.join("request.json");
    let mut pins=vec![write_pinned(&script_file,script.as_bytes())?,write_pinned(&request_file,&serde_json::to_vec(&request).map_err(|_|invalid("Unknown alt's update restart request could not be prepared."))?)?];
    for file in [&request.manifest_file,&request.signature_file] {pins.push(OpenOptions::new().read(true).share_mode(SHARE_READ).open(file)?);}
    let mut child=Command::new(system32()?.join(r"WindowsPowerShell\v1.0\powershell.exe"))
        .args(["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File"]).arg(script_file).arg("-RequestFile").arg(request_file)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(NO_WINDOW).spawn()?;
    if let Err(e)=wait_ready(&mut child,&request.ready_file,&request.health_nonce) {let _=child.kill();let _=child.wait();return Err(e);}
    HANDOFF_PINS.lock().unwrap_or_else(|e|e.into_inner()).extend(pins);
    Ok(())
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn probe_paths_require_own_uuid_stage_and_exact_health_file(){
        let root=PathBuf::from(r"C:\Local\UnknownAlt-update-staging");
        let stage=root.join(format!("{PREFIX}{}",uuid::Uuid::new_v4()));
        assert!(valid_probe_path(&stage.join("health.json"),&root));
        assert!(!valid_probe_path(&stage.join("elsewhere.json"),&root));
        assert!(!valid_probe_path(&root.join("unknownalt-update-invalid/health.json"),&root));
        assert!(!valid_probe_path(&stage.join("child/health.json"),&root));
        assert!(!valid_probe_path(&PathBuf::from("health.json"),&root));
    }
    #[test] fn stale_locks_never_bypass_pending_data_rollback(){
        let nonce="f9077c98-87ae-49df-b582-f5449aacb385";
        for phase in ["backing_up","backed_up","installing","probing","rolling_back","future_pending_phase"] {
            let journal=JournalHeader{schema:1,nonce:nonce.into(),phase:phase.into()};
            assert_eq!(startup_decision(false,false,Some(&journal),nonce).unwrap(),StartupDecision::Recover, "{phase}");
            assert_eq!(startup_decision(true,false,Some(&journal),nonce).unwrap(),StartupDecision::Wait);
            assert_eq!(startup_decision(true,true,Some(&journal),nonce).unwrap(),StartupDecision::Continue);
        }
        for phase in ["committed","rolled_back"] {
            let journal=JournalHeader{schema:1,nonce:nonce.into(),phase:phase.into()};
            assert_eq!(startup_decision(false,false,Some(&journal),nonce).unwrap(),StartupDecision::Continue);
            assert_eq!(startup_decision(true,false,Some(&journal),nonce).unwrap(),StartupDecision::Wait);
        }
        assert_eq!(startup_decision(false,false,None,nonce).unwrap(),StartupDecision::Continue);
        for (schema,value,phase) in [(2,nonce,"probing"),(1,"wrong-nonce","probing"),(1,nonce,"")] {
            let journal=JournalHeader{schema,nonce:value.into(),phase:phase.into()};
            assert!(startup_decision(false,false,Some(&journal),nonce).is_err());
        }
    }
}
