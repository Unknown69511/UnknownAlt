//! UnknownAlt's owner-controlled, signed stable release channel.
//! Configuration and its verification key are embedded in the binary. No upstream feed,
//! key, asset name or fallback can be selected. Account/vault formats are independent.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use reqwest::Url;
use reqwest::header::{ACCEPT, AUTHORIZATION, LOCATION};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Security::Cryptography::{
    BCRYPT_ALG_HANDLE, BCRYPT_ECCPUBLIC_BLOB, BCRYPT_ECDSA_P256_ALGORITHM, BCRYPT_ECDSA_PUBLIC_P256_MAGIC, BCRYPT_FLAGS,
    BCRYPT_KEY_HANDLE, BCRYPT_OPEN_ALGORITHM_PROVIDER_FLAGS, BCRYPT_SHA256_ALG_HANDLE, BCryptHash, BCryptImportKeyPair,
    BCryptOpenAlgorithmProvider, BCryptVerifySignature,
};
use windows::core::{Owned, PCWSTR};

use crate::App;
use crate::error::{AppError, Result};
use crate::launcher::update::{FILE_SHARE_READ, TempDir, blocking};
use crate::model::AppUpdate;

#[path = "update_auth.rs"]
pub(crate) mod auth;
pub use auth::UpdateAuth;

pub const UPDATE_EVENT: &str = "app://update";
pub const MANIFEST_FILE: &str = "UnknownAlt-update.json";
pub const SIGNATURE_FILE: &str = "UnknownAlt-update.json.sig";
pub const SIGNED_PREFIX: &[u8] = b"UnknownAlt update manifest v1\n";
const CURRENT: &str = env!("CARGO_PKG_VERSION");
const APP_ID: &str = "com.unknownalt.desktop";
const PLATFORM: &str = "windows-x86_64";
const CHECK_EVERY: Duration = Duration::from_secs(60 * 60);
const MAX_MANIFEST: u64 = 128_000;
pub const MAX_INSTALLER: u64 = 200_000_000;
const MAX_SIGNATURE: u64 = 4_096;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Channel {
    pub schema_version: u32,
    pub owner: String,
    pub repository: String,
    pub channel: String,
    pub public_key_p256: String,
    #[serde(default = "private_visibility")]
    pub visibility: String,
    #[serde(default)]
    pub github_app_client_id: String,
}

fn private_visibility() -> String { "private".into() }

impl Channel {
    /// Blank owner/repository is an intentional disconnected build, never a fallback.
    pub fn parse(raw: &str) -> std::result::Result<Option<Self>, String> {
        let c: Self = serde_json::from_str(raw).map_err(|_| "The Unknown alt update-channel configuration is invalid.".to_owned())?;
        if c.schema_version != 1 || c.channel != "stable" || !matches!(c.visibility.as_str(), "private" | "public") {
            return Err("Unknown alt requires update channel schema 1 and the stable channel.".into());
        }
        if c.owner.is_empty() && c.repository.is_empty() {
            return Ok(None);
        }
        if c.owner.is_empty() || c.repository.is_empty() {
            return Err("Connect both the owner and repository in Unknown alt's update channel.".into());
        }
        let owner_ok = c.owner.len() <= 39
            && !c.owner.starts_with('-') && !c.owner.ends_with('-')
            && c.owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
        let repo_ok = c.repository.len() <= 100 && c.repository != "." && c.repository != ".."
            && c.repository.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b));
        if !owner_ok || !repo_ok {
            return Err("The Unknown alt release owner or repository name is invalid.".into());
        }
        // This source cannot be repointed at the original product, even accidentally.
        if c.owner.eq_ignore_ascii_case("inspectsoftware") || c.repository.eq_ignore_ascii_case("roalt") {
            return Err("Unknown alt updates must use your own Unknown alt release repository.".into());
        }
        if public_key(&c.public_key_p256).is_none() {
            return Err("Unknown alt's release verification key is missing or invalid.".into());
        }
        if !c.github_app_client_id.is_empty() && (!c.github_app_client_id.starts_with("Iv") || !(10..=128).contains(&c.github_app_client_id.len())
            || !c.github_app_client_id.bytes().all(|b|b.is_ascii_alphanumeric()||b"._-".contains(&b))) {
            return Err("Configure the public client ID of the read-only GitHub App, never a client secret or token.".into());
        }
        Ok(Some(c))
    }

    fn installer_url(&self, version: &str, file: &str) -> String {
        format!("https://github.com/{}/{}/releases/download/v{version}/{file}", self.owner, self.repository)
    }

    fn requires_auth(&self) -> bool { self.visibility == "private" }
}

fn channel() -> std::result::Result<Option<Channel>, String> {
    static CHANNEL: OnceLock<std::result::Result<Option<Channel>, String>> = OnceLock::new();
    CHANNEL.get_or_init(|| Channel::parse(include_str!("../update-channel.json"))).clone()
}

pub struct SelfUpdater {
    status: Mutex<AppUpdate>,
    checking: AtomicBool,
    installing: AtomicBool,
    prepared: Mutex<Option<File>>,
    auth: auth::Auth,
}

impl SelfUpdater {
    pub fn new() -> Self {
        let (configured, state, error) = if crate::store_package::active() {
            (false, "unconfigured", Some(crate::store_package::UPDATE_NOTICE.into()))
        } else { match channel() {
            Ok(Some(_)) => (true, "idle", None),
            Ok(None) => (false, "unconfigured", None),
            Err(e) => (false, "error", Some(e)),
        }};
        Self {
            status: Mutex::new(AppUpdate {
                configured, current: CURRENT.into(), available: None, state: state.into(),
                downloaded: 0, total: None, error,
            }),
            checking: AtomicBool::new(false),
            installing: AtomicBool::new(false),
            prepared: Mutex::new(None),
            auth: auth::Auth::default(),
        }
    }

    pub fn installing(&self) -> bool {
        self.installing.load(Ordering::SeqCst)
    }
}

pub fn update_auth_status(s: &App) -> UpdateAuth { auth::status(s) }
pub async fn update_auth_start(app: &AppHandle) -> Result<UpdateAuth> { auth::start(app).await }
pub async fn update_auth_poll(app: &AppHandle) -> Result<UpdateAuth> {
    let status=auth::poll(app).await?;
    if status.connected {let _=check(app).await;}
    Ok(status)
}
pub fn update_auth_disconnect(s: &App) -> Result<UpdateAuth> {
    let result=auth::disconnect(s)?;
    let mut status=lock(&s.self_update.status);
    status.available=None;status.state="idle".into();status.error=None;
    Ok(result)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Installer {
    pub file_name: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    app_id: String,
    channel: String,
    version: String,
    platform: String,
    installer: Installer,
}

/// Trusted only after manifest signature and every product/source field have been checked.
#[derive(Clone, Debug)]
pub struct Release {
    pub version: String,
    pub installer: Installer,
    pub manifest: Vec<u8>,
    /// The original base64 signature-file bytes, preserved for the helper's re-verification.
    pub signature: Vec<u8>,
    pub config: Channel,
    installer_asset_id: Option<u64>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Invalid(message.into())
}

/// Stable, bounded three-part SemVer only. Reject ambiguous and path-like versions.
fn version_key(s: &str) -> Option<(u64, u64, u64)> {
    let num = |p: &str| {
        (!p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit()) && (p == "0" || !p.starts_with('0')))
            .then(|| p.parse().ok()).flatten()
    };
    let mut parts = s.split('.');
    let key = (num(parts.next()?)?, num(parts.next()?)?, num(parts.next()?)?);
    parts.next().is_none().then_some(key)
}

pub fn newer(current: &str, tag: &str) -> Option<String> {
    let version = tag.strip_prefix('v')?;
    (version_key(version)? > version_key(current)?).then(|| version.to_owned())
}

fn public_key(hex: &str) -> Option<[u8; 64]> {
    if hex.len() != 128 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
    let mut key = [0; 64];
    for (i, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[2*i..2*i+2], 16).ok()?;
    }
    key.iter().any(|&b| b != 0).then_some(key)
}

/// Base64 with canonical padding; signature files are ASCII, bounded, and exactly 64 bytes.
fn signature(text: &[u8]) -> Option<[u8; 64]> {
    let s = std::str::from_utf8(text).ok()?.trim().as_bytes();
    if s.len() != 88 || !s.ends_with(b"==") { return None; }
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c-b'A'), b'a'..=b'z' => Some(c-b'a'+26),
        b'0'..=b'9' => Some(c-b'0'+52), b'+' => Some(62), b'/' => Some(63), _ => None,
    };
    let mut out = Vec::with_capacity(64);
    for (i, chunk) in s.chunks_exact(4).enumerate() {
        let a=value(chunk[0])?; let b=value(chunk[1])?;
        out.push((a<<2)|(b>>4));
        if i == 21 {
            if chunk[2] != b'=' || chunk[3] != b'=' || b & 15 != 0 { return None; }
        } else {
            let c=value(chunk[2])?; let d=value(chunk[3])?;
            out.push((b<<4)|(c>>2)); out.push((c<<6)|d);
        }
    }
    out.try_into().ok()
}

fn digest(bytes: &[u8]) -> Result<[u8; 32]> {
    let mut hash = [0; 32];
    // SAFETY: BCryptHash reads the live input slice and writes the fixed-size SHA-256 buffer.
    unsafe { BCryptHash(BCRYPT_SHA256_ALG_HANDLE, None, bytes, &mut hash) }
        .ok().map_err(|_| AppError::Internal("Windows could not hash the Unknown alt update.".into()))?;
    Ok(hash)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn verify(public: &[u8; 64], bytes: &[u8], signature: &[u8; 64]) -> bool {
    let Ok(hash) = digest(bytes) else { return false };
    let mut blob = Vec::with_capacity(72);
    blob.extend_from_slice(&BCRYPT_ECDSA_PUBLIC_P256_MAGIC.to_le_bytes());
    blob.extend_from_slice(&32u32.to_le_bytes()); blob.extend_from_slice(public);
    // SAFETY: provider/key handles are owned and every input points at a live bounded slice.
    unsafe {
        let mut alg = BCRYPT_ALG_HANDLE::default();
        if BCryptOpenAlgorithmProvider(&mut alg, BCRYPT_ECDSA_P256_ALGORITHM, PCWSTR::null(), BCRYPT_OPEN_ALGORITHM_PROVIDER_FLAGS(0)).is_err() { return false; }
        let alg = Owned::new(alg);
        let mut key = BCRYPT_KEY_HANDLE::default();
        if BCryptImportKeyPair(*alg, None, BCRYPT_ECCPUBLIC_BLOB, &mut key, &blob, 0).is_err() { return false; }
        let key = Owned::new(key);
        BCryptVerifySignature(*key, None, &hash, signature, BCRYPT_FLAGS(0)).is_ok()
    }
}

fn clean_https(url: &Url) -> bool {
    url.scheme() == "https" && url.port().is_none() && url.username().is_empty()
        && url.password().is_none() && url.fragment().is_none()
}

fn installer_name(version: &str) -> String {
    format!("UnknownAlt-Setup-{version}.exe")
}

/// Redirects may remain in the configured repository or reach GitHub's asset storage.
/// A redirect to another repository, arbitrary website, HTTP or credential-bearing URL fails.
fn allowed_redirect(url: &Url, c: &Channel) -> bool {
    if !clean_https(url) { return false; }
    match url.host_str() {
        Some("objects.githubusercontent.com" | "release-assets.githubusercontent.com") => true,
        Some("github.com") => {
            if url.query().is_some() { return false; }
            let parts = url.path_segments().map(|p| p.collect::<Vec<_>>()).unwrap_or_default();
            if parts.len() != 6 || parts[0] != c.owner || parts[1] != c.repository
                || parts[2] != "releases" || parts[3] != "download" { return false; }
            let Some(version) = parts[4].strip_prefix('v').filter(|v| version_key(v).is_some()) else { return false };
            parts[5] == MANIFEST_FILE || parts[5] == SIGNATURE_FILE || parts[5] == installer_name(version)
        }
        _ => false,
    }
}

/// Pure product/source validation after the detached signature is accepted.
fn validate_manifest(m: Manifest, c: &Channel, current: &str) -> Result<Option<Release>> {
    if m.schema_version != 1 || m.app_id != APP_ID || m.channel != c.channel || m.platform != PLATFORM {
        return Err(invalid("The signed release does not belong to this Unknown alt installation."));
    }
    let new = version_key(&m.version).ok_or_else(|| invalid("The signed Unknown alt release version is invalid."))?;
    let old = version_key(current).ok_or_else(|| invalid("This Unknown alt build has an invalid version."))?;
    let expected_name = installer_name(&m.version);
    if m.installer.file_name != expected_name
        || m.installer.url != c.installer_url(&m.version, &expected_name)
        || !(1..=MAX_INSTALLER).contains(&m.installer.size)
        || m.installer.sha256.len() != 64
        || !m.installer.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid("The signed Unknown alt installer identity, location, size or hash is invalid."));
    }
    let url = Url::parse(&m.installer.url).map_err(|_| invalid("The signed Unknown alt installer URL is invalid."))?;
    if !allowed_redirect(&url, c) { return Err(invalid("The signed installer is outside your Unknown alt release source.")); }
    if new <= old { return Ok(None); }
    Ok(Some(Release { version:m.version, installer:m.installer, manifest:Vec::new(), signature:Vec::new(), config:c.clone(), installer_asset_id:None }))
}

fn verified_manifest(bytes: &[u8], sig: &[u8], c: &Channel, current: &str) -> Result<Option<Release>> {
    if bytes.len() as u64 > MAX_MANIFEST { return Err(invalid("Unknown alt's release manifest is too large.")); }
    let sig_decoded = signature(sig).ok_or_else(|| invalid("Unknown alt's update signature is malformed."))?;
    let key = public_key(&c.public_key_p256).ok_or_else(|| invalid("Unknown alt's verification key is invalid."))?;
    let mut signed = SIGNED_PREFIX.to_vec(); signed.extend_from_slice(bytes);
    if !verify(&key, &signed, &sig_decoded) { return Err(invalid("Unknown alt's update signature did not verify. Nothing was installed.")); }
    let m: Manifest = serde_json::from_slice(bytes).map_err(|_| invalid("Unknown alt's signed release manifest is invalid."))?;
    let mut release = validate_manifest(m,c,current)?;
    if let Some(r) = &mut release { r.manifest=bytes.to_vec(); r.signature=sig.to_vec(); }
    Ok(release)
}

fn network(error: reqwest::Error) -> AppError {
    let message=if error.is_timeout() { "The Unknown alt update request timed out. Try again." }
        else { "Unknown alt could not reach your release source. Check the connection and try again." };
    log::info!("Unknown alt update request failed: {}", error.without_url());
    invalid(message)
}

#[derive(Deserialize)]
struct ApiAsset {id:u64,name:String,size:u64}
#[derive(Deserialize)]
struct ApiRelease {tag_name:String,draft:bool,prerelease:bool,assets:Vec<ApiAsset>}

fn asset<'a>(release:&'a ApiRelease,name:&str,max:u64)->Result<&'a ApiAsset>{
    let mut found=release.assets.iter().filter(|a|a.name==name);
    let item=found.next().ok_or_else(||invalid("The private release is incomplete. Wait for the publisher to finish uploading it."))?;
    if found.next().is_some() || item.id==0 || !(1..=max).contains(&item.size){return Err(invalid("The private release asset metadata is invalid."));}
    Ok(item)
}

fn private_asset_redirect(url:&Url)->bool{
    clean_https(url) && matches!(url.host_str(),Some("objects.githubusercontent.com"|"release-assets.githubusercontent.com"))
}

/// Authentication is attached ONLY to the generated api.github.com URL. Redirects
/// are followed manually without credentials; short-lived GitHub storage URLs are
/// kept in memory and never written into the stage, logs, manifest or helper request.
async fn asset_response(s:&App,c:&Channel,id:u64,timeout:Duration)->Result<reqwest::Response>{
    if id==0{return Err(invalid("The private release asset ID is invalid."));}
    let client=auth::client()?;
    // Public mode never loads, refreshes or transmits a saved GitHub credential.
    let mut request=client.get(format!("https://api.github.com/repos/{}/{}/releases/assets/{id}",c.owner,c.repository))
        .header(ACCEPT,"application/octet-stream").header("X-GitHub-Api-Version","2022-11-28")
        .timeout(timeout);
    let token=if c.requires_auth(){Some(auth::authenticated_token(s,c).await?)}else{None};
    if let Some(token)=&token{request=request.header(AUTHORIZATION,auth::authorization(token)?);}
    let mut response=request.send().await.map_err(network)?;
    if response.status().as_u16()==401{
        if let Some(token)=&token{auth::expired_if_current(s,token);}
        return Err(invalid("GitHub refused the update download. Try again."));
    }
    for _ in 0..5{
        if !response.status().is_redirection(){
            if !response.status().is_success(){return Err(invalid("GitHub refused the update download. Try again later."));}
            return Ok(response);
        }
        let location=response.headers().get(LOCATION).and_then(|x|x.to_str().ok()).filter(|x|x.len()<=16384)
            .ok_or_else(||invalid("GitHub returned an invalid private download redirect."))?;
        let next=Url::parse(location).map_err(|_|invalid("GitHub returned an invalid private download URL."))?;
        if !private_asset_redirect(&next){return Err(invalid("The private download redirect is outside GitHub's secure asset storage."));}
        // This new request deliberately has no Authorization header.
        response=client.get(next).timeout(timeout).send().await.map_err(network)?;
    }
    Err(invalid("The private update download exceeded its redirect limit."))
}

async fn api_get(s:&App,c:&Channel,path:&str,max:u64)->Result<Option<zeroize::Zeroizing<Vec<u8>>>>{
    if c.requires_auth(){return auth::api_get(s,c,path,max).await;}
    // These routes are generated internally, never accepted from a manifest or IPC.
    if !matches!(path,""|"releases/latest"){return Err(invalid("Invalid update metadata route."));}
    let suffix=if path.is_empty(){String::new()}else{format!("/{path}")};
    let response=auth::client()?.get(format!("https://api.github.com/repos/{}/{}{suffix}",c.owner,c.repository))
        .header(ACCEPT,"application/vnd.github+json").header("X-GitHub-Api-Version","2022-11-28")
        .timeout(Duration::from_secs(30)).send().await.map_err(network)?;
    if response.status().as_u16()==404 && path=="releases/latest"{return Ok(None);}
    if !response.status().is_success(){return Err(invalid("The Unknown alt release source is unavailable. Try again later."));}
    Ok(Some(auth::bounded_response(response,max).await?))
}

fn repository_matches(c:&Channel,private:bool,name:&str)->bool{
    private==c.requires_auth() && name.eq_ignore_ascii_case(&format!("{}/{}",c.owner,c.repository))
}

async fn latest(s:&App,c: &Channel) -> Result<Option<Release>> {
    #[derive(Deserialize)]struct Repository{private:bool,full_name:String}
    let metadata=api_get(s,c,"",128_000).await?.ok_or_else(||invalid("The configured Unknown alt update repository is unavailable."))?;
    let metadata:Repository=serde_json::from_slice(&metadata).map_err(|_|invalid("The private update repository returned invalid metadata."))?;
    if !repository_matches(c,metadata.private,&metadata.full_name){
        return Err(invalid("The update repository identity or visibility differs from this build's configuration."));
    }
    let Some(raw)=api_get(s,c,"releases/latest",1_000_000).await?else{return Ok(None)};
    let release:ApiRelease=serde_json::from_slice(&raw).map_err(|_|invalid("The private release metadata is invalid."))?;
    if release.draft||release.prerelease||release.assets.len()>128{return Err(invalid("The private release is not a valid stable update."));}
    let tag=release.tag_name.strip_prefix('v').filter(|v|version_key(v).is_some()).ok_or_else(||invalid("The private release tag must be vX.Y.Z."))?;
    if version_key(tag)<=version_key(CURRENT){return Ok(None);}
    let manifest_asset=asset(&release,MANIFEST_FILE,MAX_MANIFEST)?;
    let signature_asset=asset(&release,SIGNATURE_FILE,MAX_SIGNATURE)?;
    let bytes=auth::bounded_response(asset_response(s,c,manifest_asset.id,Duration::from_secs(30)).await?,MAX_MANIFEST).await?;
    let signature=auth::bounded_response(asset_response(s,c,signature_asset.id,Duration::from_secs(30)).await?,MAX_SIGNATURE).await?;
    let mut verified=verified_manifest(&bytes,&signature,c,CURRENT)?;
    if let Some(value)=&mut verified{
        if value.version!=tag{return Err(invalid("The signed update version does not match its private release tag."));}
        let installer=asset(&release,&value.installer.file_name,MAX_INSTALLER)?;
        if installer.size!=value.installer.size{return Err(invalid("The private installer size differs from its signed manifest."));}
        value.installer_asset_id=Some(installer.id);
    }
    Ok(verified)
}

pub fn status(s: &App) -> AppUpdate { lock(&s.self_update.status).clone() }

fn publish(app: &AppHandle,f: impl FnOnce(&mut AppUpdate)) {
    let s=app.state::<App>();
    let next={let mut state=lock(&s.self_update.status); f(&mut state); state.clone()};
    let _=app.emit(UPDATE_EVENT,next);
}

struct Reset<'a>(&'a AtomicBool);
impl Drop for Reset<'_> { fn drop(&mut self){self.0.store(false,Ordering::SeqCst);} }

pub async fn check(app: &AppHandle) -> Result<AppUpdate> {
    let s=app.state::<App>();
    if crate::store_package::active() { return Ok(status(&s)); }
    if s.self_update.installing() || s.self_update.checking.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).is_err() { return Ok(status(&s)); }
    let _checking=Reset(&s.self_update.checking);
    let c=match channel() {
        Ok(Some(c))=>c,
        Ok(None)=>{publish(app,|u|{u.configured=false;u.state="unconfigured".into();u.error=None;});return Ok(status(&s));}
        Err(e)=>{publish(app,|u|{u.configured=false;u.state="error".into();u.error=Some(e.clone());});return Err(invalid(e));}
    };
    publish(app,|u|{u.state="checking".into();u.error=None;});
    let result=latest(&s,&c).await;
    // A user may start installing the previously offered version while the check was in flight.
    if s.self_update.installing() { return Ok(status(&s)); }
    match result {
        Ok(release)=>{
            publish(app,|u|{u.available=release.map(|r|r.version);u.state=if u.available.is_some(){"available"}else{"idle"}.into();u.downloaded=0;u.total=None;u.error=None;});
            Ok(status(&s))
        }
        Err(e)=>{publish(app,|u|{u.state="error".into();u.error=Some(e.message());});Err(e)}
    }
}

/// The legacy serialized toggle remains readable but no longer gates the owned channel.
pub fn switched(app: &AppHandle,_on: bool) {
    let app=app.clone();
    tauri::async_runtime::spawn(async move {let _=check(&app).await;});
}

/// Every installed copy checks immediately, then hourly, including while hidden in the tray.
pub fn spawn(app: AppHandle) {
    if crate::store_package::active() { return; }
    tauri::async_runtime::spawn(async move {
        loop { let _=check(&app).await; tokio::time::sleep(CHECK_EVERY).await; }
    });
}

fn idle(s: &App) -> Result<()> {
    if s.bulk.any_busy() { return Err(invalid("Wait for the running launch, batch or auto-rejoin to finish, then update Unknown alt.")); }
    if s.update.installing() { return Err(invalid("Wait for Roblox's installer to finish, then update Unknown alt.")); }
    if s.tracker.any_running() { return Err(invalid("Close the running Roblox clients before updating Unknown alt, so their controls and sessions are not interrupted.")); }
    Ok(())
}

async fn download(app: &AppHandle,release: &Release,path: &Path,progress: &crate::update_progress::Progress) -> Result<File> {
    let s=app.state::<App>();
    let asset=release.installer_asset_id.ok_or_else(||invalid("The verified private installer asset is missing."))?;
    let mut response=asset_response(&s,&release.config,asset,Duration::from_secs(600)).await?;
    if !response.status().is_success() { return Err(invalid(format!("The Unknown alt installer download returned HTTP {}.",response.status().as_u16()))); }
    if response.content_length().is_some_and(|n|n!=release.installer.size) { return Err(invalid("The Unknown alt installer size differs from its signed manifest.")); }
    let mut file=File::create_new(path)?;
    let mut downloaded=0u64;
    let mut sent=Instant::now();
    while let Some(chunk)=response.chunk().await.map_err(network)? {
        downloaded=downloaded.checked_add(chunk.len() as u64).ok_or_else(||invalid("Unknown alt update size overflow."))?;
        if downloaded>release.installer.size || downloaded>MAX_INSTALLER { return Err(invalid("The Unknown alt installer exceeds its signed size.")); }
        file.write_all(&chunk)?;
        if sent.elapsed()>=Duration::from_millis(200) {
            publish(app,|u|u.downloaded=downloaded);
            progress.set("downloading",downloaded,release.installer.size);
            sent=Instant::now();
        }
    }
    file.sync_all()?; drop(file);
    if downloaded!=release.installer.size { return Err(invalid("The Unknown alt installer download was incomplete. Try again.")); }
    publish(app,|u|{u.downloaded=downloaded;u.state="verifying".into();});
    progress.set("verifying",0,0);
    let path=path.to_owned(); let expected_hash=release.installer.sha256.clone(); let size=release.installer.size;
    blocking(move || verified_file(&path,&expected_hash,size)).await
}

fn verified_file(path: &Path,expected_hash: &str,size: u64) -> Result<File> {
    if !(1..=MAX_INSTALLER).contains(&size) {return Err(invalid("The Unknown alt installer size is invalid."));}
    // Deny writes/deletes after this point until the app exits. The helper re-verifies too.
    let mut pinned=OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(path)?;
    let mut bytes=Vec::with_capacity(size as usize);
    (&mut pinned).take(size+1).read_to_end(&mut bytes)?;
    if bytes.len() as u64!=size || !hex(&digest(&bytes)?).eq_ignore_ascii_case(expected_hash) {
        return Err(invalid("The downloaded Unknown alt installer failed verification. Nothing was installed."));
    }
    Ok(pinned)
}

pub async fn install(app: &AppHandle) -> Result<()> {
    if crate::store_package::active() { return Err(invalid(crate::store_package::UPDATE_NOTICE)); }
    let s=app.state::<App>();
    s.self_update.installing.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst)
        .map_err(|_|invalid("Unknown alt is already preparing an update."))?;
    let result=run_install(app,&s).await;
    if let Err(e)=&result {
        s.self_update.installing.store(false,Ordering::SeqCst);
        publish(app,|u|{u.state="error".into();u.error=Some(e.message());});
        log::warn!("Unknown alt update was not applied: {}",e.message());
    }
    result
}

async fn run_install(app: &AppHandle,s: &App) -> Result<()> {
    idle(s)?;
    let c=channel().map_err(invalid)?.ok_or_else(||invalid("Unknown alt updates are not connected yet. Configure your release repository and verification key first."))?;
    let stage=TempDir(blocking(crate::update_handoff::new_stage).await?);
    let stage_for_window=stage.0.clone();
    let progress=blocking(move || crate::update_progress::Progress::start(&stage_for_window)).await?;
    let release=latest(s,&c).await?.ok_or_else(||invalid("Unknown alt is already up to date."))?;
    publish(app,|u|{u.available=Some(release.version.clone());u.state="downloading".into();u.downloaded=0;u.total=Some(release.installer.size);u.error=None;});
    progress.set("downloading",0,release.installer.size);
    for (name,bytes) in [(MANIFEST_FILE,release.manifest.as_slice()),(SIGNATURE_FILE,release.signature.as_slice())] {
        let mut f=File::create_new(stage.0.join(name))?; f.write_all(bytes)?; f.sync_all()?;
    }
    let installer=stage.0.join(&release.installer.file_name);
    let pinned=download(app,&release,&installer,&progress).await?;
    idle(s)?;
    publish(app,|u|u.state="installing".into());
    progress.set("backing-up",0,0);
    let backup_app=app.clone();
    blocking(move || {
        crate::automatic_backup::create_at(&backup_app.state::<App>().db,&crate::automatic_backup::root()?,"before-update").map(|_|())
    }).await?;
    let (handle,release_for_helper,installer_for_helper,stage_for_helper)=(app.clone(),release.clone(),installer.clone(),stage.0.clone());
    blocking(move || crate::update_handoff::handoff(&handle,&release_for_helper,&installer_for_helper,&stage_for_helper)).await?;
    // The helper has acknowledged readiness and waits for the graceful exit below. Browse's
    // ExitRequested hook saves its session before the process actually exits. No force termination.
    *lock(&s.self_update.prepared)=Some(pinned);
    let abandoned_stage=stage.0.clone();
    progress.transfer();
    std::mem::forget(stage);
    let recovery=app.clone();
    tauri::async_runtime::spawn(async move {
        // The helper never forces an exit and aborts at 120 seconds. If Browse or a close
        // hook kept this old process alive, recover its UI/launch controls rather than
        // leaving the application permanently disabled.
        tokio::time::sleep(Duration::from_secs(150)).await;
        let s=recovery.state::<App>();
        if let Some(pinned)=lock(&s.self_update.prepared).take() {
            drop(pinned);
            crate::update_handoff::release_pins();
            crate::update_progress::clear(&abandoned_stage);
            s.self_update.installing.store(false,Ordering::SeqCst);
            publish(&recovery,|u|{u.state="error".into();u.error=Some("Unknown alt could not close cleanly for the update. Nothing was replaced; try again after closing Browse.".into());});
            if let Err(e)=std::fs::remove_dir_all(&abandoned_stage) {
                log::info!("could not remove abandoned Unknown alt update stage: {e}");
            }
        }
    });
    app.exit(0);
    Ok(())
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_,T> { m.lock().unwrap_or_else(|e|e.into_inner()) }

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture() -> (Channel,Vec<u8>,Vec<u8>) {
        let c=Channel::parse(include_str!("../fixtures/updater/channel.json")).unwrap().unwrap();
        (c,include_bytes!("../fixtures/updater/UnknownAlt-update.json").to_vec(),include_bytes!("../fixtures/updater/UnknownAlt-update.json.sig").to_vec())
    }

    #[test]
    fn versions_are_strict_stable_and_never_downgrade() {
        for (old,new,want) in [("1.1.0","v1.1.1",Some("1.1.1")),("1.9.9","v1.10.0",Some("1.10.0")),("2.0.0","v1.9.9",None),("1.1.0","v1.1.0",None),("1.1.0","v01.2.3",None),("1.1.0","v1.2.3-beta",None),("1.1.0","v1.2.3+build",None),("1.1.0","v1.2.3/evil",None),("1.1.0","v1.2",None)] {
            assert_eq!(newer(old,new).as_deref(),want,"{old} -> {new}");
        }
        assert!(version_key(CURRENT).is_some());
    }

    #[test]
    fn disconnected_and_original_sources_fail_closed() {
        let (c,_,_)=fixture();
        let mut j=serde_json::json!({"schemaVersion":1,"owner":"","repository":"","channel":"stable","publicKeyP256":c.public_key_p256});
        assert!(Channel::parse(&j.to_string()).unwrap().is_none());
        for (owner,repo) in [("inspectsoftware","UnknownAlt"),("INSPECTSOFTWARE","Other"),("Owner","RoALT"),("Owner","rOaLt"),("../bad","UnknownAlt"),("Owner","../UnknownAlt")] {
            j["owner"]=owner.into();j["repository"]=repo.into();
            assert!(Channel::parse(&j.to_string()).is_err(),"{owner}/{repo}");
        }
    }

    #[test]
    fn node_p1363_signature_verifies_and_tampering_fails() {
        let (c,bytes,sig)=fixture();
        let release=verified_manifest(&bytes,&sig,&c,"1.1.0").unwrap().unwrap();
        assert_eq!(release.version,"9.8.7");
        let mut changed=bytes.clone();changed[0]^=1;
        assert!(verified_manifest(&changed,&sig,&c,"1.1.0").is_err());
        let mut wrong_key=c.clone();wrong_key.public_key_p256.replace_range(..2,"00");
        assert!(verified_manifest(&bytes,&sig,&wrong_key,"1.1.0").is_err());
        assert!(verified_manifest(&bytes,b"bad signature",&c,"1.1.0").is_err());
        assert!(verified_manifest(&bytes,&sig,&c,"9.8.7").unwrap().is_none());
    }

    #[test]
    fn manifest_product_and_source_binding_rejects_substitution() {
        let (c,bytes,_)=fixture();
        let j:Value=serde_json::from_slice(&bytes).unwrap();
        for (field,value) in [("appId","wrong.product"),("platform","linux-x86_64"),("channel","beta"),("version","9.8.7/../evil")] {
            let mut bad=j.clone();bad[field]=value.into();
            assert!(validate_manifest(serde_json::from_value(bad).unwrap(),&c,"1.1.0").is_err());
        }
        for (field,value) in [("fileName","RoALT-Setup-9.8.7.exe"),("url","https://github.com/inspectsoftware/RoALT/releases/download/v9.8.7/UnknownAlt-Setup-9.8.7.exe"),("url","https://example.com/UnknownAlt-Setup-9.8.7.exe"),("sha256","bad")] {
            let mut bad=j.clone();bad["installer"][field]=value.into();
            assert!(validate_manifest(serde_json::from_value(bad).unwrap(),&c,"1.1.0").is_err());
        }
        for size in [0,MAX_INSTALLER+1] {
            let mut bad=j.clone();bad["installer"]["size"]=size.into();
            assert!(validate_manifest(serde_json::from_value(bad).unwrap(),&c,"1.1.0").is_err());
        }
    }

    #[test]
    fn redirect_policy_is_https_repo_pinned_and_storage_bounded() {
        let (c,_,_)=fixture();
        assert!(allowed_redirect(&Url::parse(&c.installer_url("9.8.7",&installer_name("9.8.7"))).unwrap(),&c));
        for u in ["http://github.com/Owner/UnknownAlt/releases/download/v9.8.7/UnknownAlt-Setup-9.8.7.exe","https://github.com/Other/UnknownAlt/releases/download/v9.8.7/UnknownAlt-Setup-9.8.7.exe","https://github.com/inspectsoftware/RoALT/releases/download/v9.8.7/RoALT.exe","https://release-assets.githubusercontent.com.evil.test/a","https://evil@release-assets.githubusercontent.com/a","https://github.com/Owner/UnknownAlt/releases/download/v9.8.7/UnknownAlt-Setup-9.8.7.exe?other=1"] {
            assert!(!allowed_redirect(&Url::parse(u).unwrap(),&c),"{u}");
        }
        assert!(allowed_redirect(&Url::parse("https://release-assets.githubusercontent.com/asset?token=opaque").unwrap(),&c));
    }

    #[test]
    fn private_asset_redirects_never_receive_a_github_authorization_header() {
        for text in ["https://release-assets.githubusercontent.com/one?jwt=short-lived","https://objects.githubusercontent.com/one"]{
            assert!(private_asset_redirect(&Url::parse(text).unwrap()));
        }
        for text in ["http://objects.githubusercontent.com/a","https://api.github.com/repos/Owner/UnknownAlt/releases/assets/1",
            "https://github.com/Owner/UnknownAlt/releases/download/v1.2.3/UnknownAlt.exe","https://objects.githubusercontent.com.evil.test/a",
            "https://token@objects.githubusercontent.com/a","https://objects.githubusercontent.com:444/a"]{
            assert!(!private_asset_redirect(&Url::parse(text).unwrap()),"{text}");
        }
    }

    #[test]
    fn private_release_assets_are_unique_bounded_and_generated_from_ids() {
        let good=ApiRelease{tag_name:"v9.8.7".into(),draft:false,prerelease:false,assets:vec![ApiAsset{id:42,name:MANIFEST_FILE.into(),size:123}]};
        assert_eq!(asset(&good,MANIFEST_FILE,MAX_MANIFEST).unwrap().id,42);
        assert!(asset(&good,SIGNATURE_FILE,MAX_SIGNATURE).is_err());
        let duplicate=ApiRelease{assets:vec![ApiAsset{id:42,name:MANIFEST_FILE.into(),size:123},ApiAsset{id:43,name:MANIFEST_FILE.into(),size:123}],..good};
        assert!(asset(&duplicate,MANIFEST_FILE,MAX_MANIFEST).is_err());
    }

    #[test]
    fn public_channel_needs_no_login_and_still_pins_repository_identity() {
        let (mut c,_,_)=fixture();
        c.visibility="public".into();c.github_app_client_id.clear();
        assert!(!c.requires_auth());
        assert!(repository_matches(&c,false,&format!("{}/{}",c.owner,c.repository)));
        assert!(!repository_matches(&c,true,&format!("{}/{}",c.owner,c.repository)));
        assert!(!repository_matches(&c,false,"Other/UnknownAlt"));
        let raw=serde_json::json!({"schemaVersion":1,"owner":c.owner,"repository":c.repository,
            "channel":"stable","publicKeyP256":c.public_key_p256,"visibility":"public"}).to_string();
        let parsed=Channel::parse(&raw).unwrap().unwrap();
        assert!(!parsed.requires_auth());assert!(parsed.github_app_client_id.is_empty());
        assert!(Channel::parse(&raw.replace("\"public\"","\"unknown\"")).is_err());
    }

    #[test]
    fn payload_hash_matches_the_signed_fixture() {
        let (c,bytes,sig)=fixture();
        let release=verified_manifest(&bytes,&sig,&c,"1.1.0").unwrap().unwrap();
        let installer=include_bytes!("../fixtures/updater/installer.bin");
        assert_eq!(release.installer.size,installer.len() as u64);
        assert_eq!(release.installer.sha256,hex(&digest(installer).unwrap()));
        assert_ne!(release.installer.sha256,hex(&digest(b"tampered installer").unwrap()));
    }

    #[test]
    fn verified_payload_is_write_locked_and_bad_downloads_are_refused() {
        let (c,bytes,sig)=fixture();
        let release=verified_manifest(&bytes,&sig,&c,"1.1.0").unwrap().unwrap();
        let dir=TempDir::new("unknownalt-update-test-").unwrap();
        let path=dir.0.join(&release.installer.file_name);
        std::fs::write(&path,include_bytes!("../fixtures/updater/installer.bin")).unwrap();
        let pinned=verified_file(&path,&release.installer.sha256,release.installer.size).unwrap();
        assert!(OpenOptions::new().write(true).open(&path).is_err(),"verified executable cannot be changed while staged");
        assert!(std::fs::remove_file(&path).is_err(),"verified executable cannot be replaced while staged");
        drop(pinned);
        std::fs::write(&path,b"incomplete").unwrap();
        assert!(verified_file(&path,&release.installer.sha256,release.installer.size).is_err());
        let mut tampered=include_bytes!("../fixtures/updater/installer.bin").to_vec();tampered[0]^=1;
        std::fs::write(&path,tampered).unwrap();
        assert!(verified_file(&path,&release.installer.sha256,release.installer.size).is_err());
    }
}
