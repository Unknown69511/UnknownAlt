//! Per-user GitHub App device authorization for private update downloads.
//! The shipped client contains only the public GitHub App client ID. Device/access
//! tokens never cross IPC; the latter is DPAPI-wrapped for this Windows user.

use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

use crate::App;
use crate::error::Result;
use crate::vault::Secret;
use super::{Channel, invalid, lock};

const FILE_NAME: &str = "UnknownAlt.update-auth";
const ENTROPY: &[u8] = b"UnknownAlt/private-updates/v1";
const VERIFY_URI: &str = "https://github.com/login/device";
const MAX_RESPONSE: u64 = 32_768;
const REPARSE_POINT: u32 = 0x400;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAuth {
    pub configured: bool,
    pub connected: bool,
    pub login: Option<String>,
    pub state: String,
    pub user_code: Option<String>,
    pub verification_uri: Option<String>,
    pub expires_at: Option<u64>,
    pub poll_after_ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone)]
pub(super) struct Credential { pub token: Secret, login: String, expires_at: Option<u64>, refresh_token: Option<Secret>, refresh_expires_at: Option<u64> }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stored {
    schema: u32,
    owner: String,
    repository: String,
    client_id: String,
    token: Zeroizing<String>,
    login: String,
    expires_at: Option<u64>,
    #[serde(default)] refresh_token: Option<Zeroizing<String>>,
    #[serde(default)] refresh_expires_at: Option<u64>,
}

#[derive(Clone)]
struct Pending {
    device_code: Secret,
    user_code: String,
    expires_at: u64,
    expires: Instant,
    interval: Duration,
    next_poll: Instant,
}

#[derive(Default)]
struct State { loaded: bool, credential: Option<Credential>, pending: Option<Pending>, error: Option<String> }

#[derive(Default)]
pub(super) struct Auth { state: Mutex<State>, busy: AtomicBool }

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
fn path(s: &App) -> PathBuf { s.data_dir.join(FILE_NAME) }
fn configured(c: &Channel) -> bool { c.requires_auth() && !c.github_app_client_id.is_empty() }
fn valid_token(value: &str) -> bool {
    value.starts_with("ghu_") && (20..=512).contains(&value.len()) && value.bytes().all(|b|b.is_ascii_alphanumeric() || b==b'_')
}
fn valid_refresh(value:&str)->bool {
    value.starts_with("ghr_") && (20..=512).contains(&value.len()) && value.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_')
}
fn can_refresh(value:&Credential)->bool {
    value.refresh_token.is_some() && value.refresh_expires_at.is_none_or(|at|at>now()+30)
}

#[derive(Deserialize)]
struct Grant {
    access_token:Option<Zeroizing<String>>,
    token_type:Option<String>,
    scope:Option<String>,
    expires_in:Option<u64>,
    refresh_token:Option<Zeroizing<String>>,
    refresh_token_expires_in:Option<u64>,
    error:Option<String>,
    interval:Option<u64>,
}

fn credential(reply:Grant,login:String)->Result<Credential>{
    let raw=reply.access_token.ok_or_else(||invalid("GitHub did not issue an update authorization."))?;
    if reply.token_type.as_deref()!=Some("bearer") || reply.scope.as_ref().is_some_and(|s|!s.is_empty()) || !valid_token(&raw)
        || reply.refresh_token.as_ref().is_some_and(|s|!valid_refresh(s)) || reply.expires_in.is_some_and(|v|v<60||v>31_622_400) {
        return Err(invalid("Private updates require the read-only GitHub App, not a broad OAuth repository authorization."));
    }
    if reply.expires_in.is_some() && reply.refresh_token.is_none(){return Err(invalid("GitHub did not issue a refresh connection. Connect the read-only GitHub App again."));}
    Ok(Credential{token:Secret::new(raw.as_str()),login,expires_at:reply.expires_in.map(|v|now().saturating_add(v)),
        refresh_token:reply.refresh_token.map(|x|Secret::new(x.as_str())),refresh_expires_at:reply.refresh_token_expires_in.map(|v|now().saturating_add(v))})
}

fn file_metadata(file: &Path) -> Result<Option<std::fs::Metadata>> {
    match std::fs::symlink_metadata(file) {
        Ok(meta) if meta.is_file() && meta.file_attributes() & REPARSE_POINT == 0 && meta.len() <= MAX_RESPONSE => Ok(Some(meta)),
        Ok(_) => Err(invalid("The private-update connection file is invalid. Disconnect updates and connect again.")),
        Err(e) if e.kind()==std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn load(s: &App, c: &Channel) -> Result<Option<Credential>> {
    load_file(&path(s),c)
}

fn load_file(file:&Path,c:&Channel)->Result<Option<Credential>> {
    if file_metadata(&file)?.is_none() {return Ok(None);}
    let mut bytes=Vec::new();File::open(file)?.take(MAX_RESPONSE+1).read_to_end(&mut bytes)?;
    if bytes.len() as u64>MAX_RESPONSE {return Err(invalid("The private-update connection file is too large."));}
    let raw=crate::vault::unprotect_with(&bytes,ENTROPY)
        .map_err(|_|invalid("The private-update connection belongs to another Windows user or is damaged. Connect again."))?;
    let value:Stored=serde_json::from_slice(&raw).map_err(|_|invalid("The saved private-update connection is invalid. Connect again."))?;
    if value.schema!=1 || value.owner!=c.owner || value.repository!=c.repository || value.client_id!=c.github_app_client_id {
        return Ok(None);
    }
    if !valid_token(&value.token) || value.login.is_empty() || value.login.len()>39 {
        return Err(invalid("The saved private-update connection is invalid. Connect again."));
    }
    if value.refresh_token.as_ref().is_some_and(|x|!valid_refresh(x)){return Err(invalid("The saved update refresh connection is invalid. Connect again."));}
    Ok(Some(Credential{token:Secret::new(value.token.as_str()),login:value.login,expires_at:value.expires_at,refresh_token:value.refresh_token.map(|x|Secret::new(x.as_str())),refresh_expires_at:value.refresh_expires_at}))
}

/// File ACLs need effective grants. The directory helper's (OI)(CI) grants
/// become inheritance-only on a file and can remove our own ability to rename it.
fn secure_file(file:&Path)->Result<()> {
    use std::os::windows::process::CommandExt;
    let sid=current_user_sid()?;
    let root=std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(||r"C:\Windows".into());
    let done=std::process::Command::new(root.join(r"System32\icacls.exe"))
        .arg(file).args(["/inheritance:r","/grant:r",&format!("*{sid}:F"),"*S-1-5-18:F","*S-1-5-32-544:F"])
        .creation_flags(0x0800_0000).output()
        .map_err(|_|invalid("Windows could not secure the private-update connection file."))?;
    if !done.status.success(){return Err(invalid("Windows could not secure the private-update connection file."));}
    Ok(())
}

fn current_user_sid()->Result<String> {
    use windows::Win32::Foundation::{CloseHandle,HANDLE,HLOCAL,LocalFree};
    use windows::Win32::Security::{GetTokenInformation,TOKEN_QUERY,TOKEN_USER,TokenUser};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::System::Threading::{GetCurrentProcess,OpenProcessToken};
    use windows::core::PWSTR;
    let fail=||invalid("Windows could not identify the private-update connection's owner.");
    let mut token=HANDLE::default();
    // SAFETY: token is an output handle. The pseudo process handle stays valid.
    unsafe{OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&mut token)}.map_err(|_|fail())?;
    let result=(||->Result<String>{
        let mut bytes=0;
        // The first call only obtains the required size; an empty buffer is expected.
        let _=unsafe{GetTokenInformation(token,TokenUser,None,0,&mut bytes)};
        if !(std::mem::size_of::<TOKEN_USER>() as u32..=65_536).contains(&bytes){return Err(fail());}
        // usize storage supplies the alignment required by TOKEN_USER and its SID.
        let mut buffer=vec![0usize;(bytes as usize).div_ceil(std::mem::size_of::<usize>())];
        unsafe{GetTokenInformation(token,TokenUser,Some(buffer.as_mut_ptr().cast()),bytes,&mut bytes)}.map_err(|_|fail())?;
        // SAFETY: the successful call initialized TOKEN_USER and a SID inside buffer.
        let user=unsafe{&*buffer.as_ptr().cast::<TOKEN_USER>()};
        let mut text=PWSTR::null();
        unsafe{ConvertSidToStringSidW(user.User.Sid,&mut text)}.map_err(|_|fail())?;
        // SAFETY: Windows allocated a NUL-terminated string; free it after decoding,
        // including the decoding-failure path. No borrowed pointer leaves this scope.
        let decoded=unsafe{text.to_string()}.map_err(|_|fail());
        unsafe{LocalFree(Some(HLOCAL(text.0.cast())))};
        decoded
    })();
    // SAFETY: OpenProcessToken returned this owned handle, closed exactly once.
    let _=unsafe{CloseHandle(token)};
    result
}

fn store(s: &App,c: &Channel,credential:&Credential)->Result<()> {
    store_in(&s.data_dir,c,credential)
}

fn store_in(data_dir:&Path,c:&Channel,credential:&Credential)->Result<()> {
    let file=data_dir.join(FILE_NAME);
    let _=file_metadata(&file).map_err(|_|invalid("The existing private-update connection file could not be inspected."))?;
    let raw=Zeroizing::new(serde_json::to_vec(&Stored{schema:1,owner:c.owner.clone(),repository:c.repository.clone(),client_id:c.github_app_client_id.clone(),token:Zeroizing::new(credential.token.expose().to_owned()),login:credential.login.clone(),expires_at:credential.expires_at,refresh_token:credential.refresh_token.as_ref().map(|x|Zeroizing::new(x.expose().to_owned())),refresh_expires_at:credential.refresh_expires_at})
        .map_err(|_|invalid("The private-update connection could not be saved."))?);
    let wrapped=crate::vault::protect_with(&raw,ENTROPY)
        .map_err(|_|invalid("Windows could not encrypt the private-update connection."))?;
    let temp=data_dir.join(format!("UnknownAlt.update-auth-{}.tmp",uuid::Uuid::new_v4()));
    let done=(||->Result<()>{
        use std::io::Write;
        let mut f=OpenOptions::new().write(true).create_new(true).share_mode(0).open(&temp)
            .map_err(|_|invalid("The private-update connection temporary file could not be created."))?;
        f.write_all(&wrapped).map_err(|_|invalid("The private-update connection temporary file could not be written."))?;
        f.sync_all().map_err(|_|invalid("The private-update connection temporary file could not be flushed."))?;drop(f);
        secure_file(&temp)?;
        std::fs::rename(&temp,&file).map_err(|_|invalid("The private-update connection file could not be replaced. Close apps using it and connect again."))?;
        Ok(())
    })();
    if done.is_err(){let _=std::fs::remove_file(temp);}
    done
}

fn ensure_loaded(s: &App,c:&Channel) {
    let mut state=lock(&s.self_update.auth.state);
    if state.loaded {return;}
    state.loaded=true;
    match load(s,c) {Ok(value)=>state.credential=value,Err(e)=>state.error=Some(e.message())}
}

fn status_with(s:&App,c:Option<&Channel>)->UpdateAuth {
    if c.is_some_and(|c|!c.requires_auth()){
        return UpdateAuth{configured:true,connected:false,login:None,state:"public".into(),
            user_code:None,verification_uri:None,expires_at:None,poll_after_ms:None,error:None};
    }
    if let Some(c)=c {ensure_loaded(s,c);}
    let mut state=lock(&s.self_update.auth.state);
    if state.credential.as_ref().is_some_and(|x|x.expires_at.is_some_and(|at|at<=now()+30) && !can_refresh(x)) {
        state.credential=None;state.error=Some("The GitHub update connection expired. Connect again.".into());
    }
    if state.pending.as_ref().is_some_and(|x|Instant::now()>=x.expires) {
        state.pending=None;state.error=Some("The GitHub verification code expired. Connect again.".into());
    }
    let ready=c.is_some_and(configured);
    let pending=state.pending.as_ref();
    let connected=ready && state.credential.is_some();
    UpdateAuth{
        configured:ready,connected,
        login:state.credential.as_ref().filter(|_|ready).map(|x|x.login.clone()),
        state:if !ready {"unconfigured"}else if connected {"connected"}else if pending.is_some(){"pending"}else if state.error.is_some(){"error"}else{"disconnected"}.into(),
        user_code:pending.map(|x|x.user_code.clone()),verification_uri:pending.map(|_|VERIFY_URI.into()),
        expires_at:pending.map(|x|x.expires_at),
        poll_after_ms:pending.map(|x|x.next_poll.saturating_duration_since(Instant::now()).as_millis().max(250).min(u64::MAX as u128) as u64),
        error:if !ready {Some("The publisher must register the read-only GitHub App and configure its public client ID before private updates can connect.".into())}else{state.error.clone()},
    }
}

pub(super) fn status(s:&App)->UpdateAuth {let c=super::channel().ok().flatten();status_with(s,c.as_ref())}

pub(super) fn token(s:&App,c:&Channel)->Result<Secret> {
    let state=status_with(s,Some(c));
    if !state.configured {return Err(invalid("Private updates need the publisher's read-only GitHub App public client ID. The app remains usable."));}
    lock(&s.self_update.auth.state).credential.as_ref().map(|x|x.token.clone())
        .ok_or_else(||invalid("Connect your GitHub account in Settings > About > Private updates to access this private release source."))
}

pub(super) async fn authenticated_token(s:&App,c:&Channel)->Result<Secret>{
    let _=status_with(s,Some(c));
    let current=lock(&s.self_update.auth.state).credential.clone();
    let Some(current)=current else{return token(s,c)};
    if current.expires_at.is_none_or(|at|at>now()+300){return Ok(current.token);}
    // The first clone only selects the fast path. Disconnect can complete after
    // it, so acquire the mutation guard FIRST and then reload the live record.
    let (_busy,current)=begin_refresh(&s.self_update.auth)?;
    let Some(current)=current else{return token(s,c)};
    if current.expires_at.is_none_or(|at|at>now()+300){return Ok(current.token);}
    if !can_refresh(&current){expired_if_current(s,&current.token);return Err(invalid("The GitHub update connection expired. Connect again."));}
    let refresh=current.refresh_token.as_ref().ok_or_else(||invalid("Connect the private update source again."))?;
    // Device-flow grants can refresh using only the public client ID and this user's
    // DPAPI-protected refresh token. A publisher client secret is never used or shipped.
    let response:Grant=device_post("https://github.com/login/oauth/access_token",&[("client_id",&c.github_app_client_id),("grant_type","refresh_token"),("refresh_token",refresh.expose())]).await?;
    if response.error.is_some(){expired_if_current(s,&current.token);return Err(invalid("GitHub could not renew the update connection. Connect again."));}
    let renewed=credential(response,current.login)?;
    let token=renewed.token.clone();
    if let Err(e)=commit_credential(&s.self_update.auth,renewed.clone(),None,||store(s,c,&renewed)){
        expired_if_current(s,&current.token);return Err(e);
    }
    Ok(token)
}

fn invalidate_current(state:&mut State,expected:&Secret)->bool{
    if !state.credential.as_ref().is_some_and(|x|x.token.expose()==expected.expose()){return false;}
    state.credential=None;
    // A late response from an older request must not cancel a new device flow.
    if state.pending.is_none(){state.error=Some("GitHub no longer accepts the update connection. Connect again.".into());}
    true
}

pub(super) fn expired_if_current(s:&App,expected:&Secret) {
    let mut state=lock(&s.self_update.auth.state);
    if invalidate_current(&mut state,expected) && file_metadata(&path(s)).ok().flatten().is_some(){let _=std::fs::remove_file(path(s));}
}

struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_>{fn drop(&mut self){self.0.store(false,Ordering::Release)}}

fn begin_refresh(auth:&Auth)->Result<(Busy<'_>,Option<Credential>)>{
    if auth.busy.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).is_err(){return Err(invalid("The GitHub update connection is being renewed. Try again in a moment."));}
    let busy=Busy(&auth.busy);
    let current=lock(&auth.state).credential.clone();
    Ok((busy,current))
}

/// File replacement and live-state replacement form one critical section. An
/// old request's 401 can never remove a newly stored, not-yet-published record.
fn commit_credential(auth:&Auth,next:Credential,pending_code:Option<&Secret>,persist:impl FnOnce()->Result<()>)->Result<()>{
    let mut state=lock(&auth.state);
    if let Some(code)=pending_code {
        if !state.pending.as_ref().is_some_and(|p|p.device_code.expose()==code.expose() && Instant::now()<p.expires){
            return Err(invalid("The GitHub authorization expired or was replaced. Connect again."));
        }
    }
    persist()?;
    state.loaded=true;state.credential=Some(next);state.pending=None;state.error=None;
    Ok(())
}

fn commit_device_credential(auth:&Auth,next:Credential,code:&Secret,persist:impl FnOnce()->Result<()>)->Result<()>{
    if let Err(error)=commit_credential(auth,next,Some(code),persist){
        let mut state=lock(&auth.state);
        // GitHub has consumed this one-use grant. A save failure needs a fresh
        // device code; never cancel another flow or discard a prior credential.
        if state.pending.as_ref().is_some_and(|pending|pending.device_code.expose()==code.expose()){
            state.pending=None;state.error=Some(error.message());
        }
        return Err(error);
    }
    Ok(())
}

pub(super) fn client()->Result<reqwest::Client> {
    reqwest::Client::builder().https_only(true).connect_timeout(Duration::from_secs(10))
        .redirect(Policy::none()).user_agent(concat!("UnknownAlt/",env!("CARGO_PKG_VERSION")))
        .build().map_err(|_|invalid("The secure private-update connection could not be created."))
}

pub(super) fn authorization(value:&Secret)->Result<HeaderValue> {
    let mut header=HeaderValue::from_str(&format!("Bearer {}",value.expose())).map_err(|_|invalid("The private-update connection is invalid."))?;
    header.set_sensitive(true);Ok(header)
}

pub(super) async fn bounded_response(mut response:reqwest::Response,max:u64)->Result<Zeroizing<Vec<u8>>> {
    if response.content_length().is_some_and(|x|x>max){return Err(invalid("GitHub returned oversized private-update metadata."));}
    let mut bytes=Zeroizing::new(Vec::new());
    while let Some(chunk)=response.chunk().await.map_err(|_|invalid("The private-update response was interrupted. Try again."))? {
        if bytes.len() as u64+chunk.len() as u64>max{return Err(invalid("GitHub returned oversized private-update metadata."));}
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn device_post<T:for<'a> Deserialize<'a>>(endpoint:&str,fields:&[(&str,&str)])->Result<T> {
    // Endpoint is a source constant, never a URI supplied by the WebView or a server.
    let body=url::form_urlencoded::Serializer::new(String::new()).extend_pairs(fields.iter().copied()).finish();
    let response=client()?.post(endpoint).header(ACCEPT,"application/json").header(CONTENT_TYPE,"application/x-www-form-urlencoded")
        .body(body).timeout(Duration::from_secs(30)).send().await.map_err(|_|invalid("GitHub device authorization could not be reached. Try again."))?;
    if !response.status().is_success(){return Err(invalid("GitHub device authorization was refused. Check the publisher's GitHub App configuration."));}
    serde_json::from_slice(&bounded_response(response,MAX_RESPONSE).await?)
        .map_err(|_|invalid("GitHub returned invalid device-authorization metadata."))
}

pub(super) async fn start(app:&AppHandle)->Result<UpdateAuth> {
    let s=app.state::<App>();
    let c=super::channel().map_err(invalid)?.ok_or_else(||invalid("The private update repository is not configured."))?;
    if !configured(&c){return Err(invalid("The publisher must configure a read-only GitHub App public client ID first."));}
    let current=status_with(&s,Some(&c));
    if current.connected || current.state=="pending" {return Ok(current);}
    if s.self_update.auth.busy.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).is_err(){return Ok(status_with(&s,Some(&c)));}
    let _busy=Busy(&s.self_update.auth.busy);
    #[derive(Deserialize)]struct Device{device_code:Zeroizing<String>,user_code:String,verification_uri:String,expires_in:u64,interval:u64}
    let response:Device=device_post("https://github.com/login/device/code",&[("client_id",&c.github_app_client_id)]).await?;
    if response.verification_uri!=VERIFY_URI || !(60..=1800).contains(&response.expires_in)
        || !(1..=60).contains(&response.interval) || !(16..=256).contains(&response.device_code.len())
        || response.user_code.len()>16 || response.user_code.len()<8 || !response.user_code.bytes().all(|b|b.is_ascii_uppercase()||b.is_ascii_digit()||b==b'-') {
        return Err(invalid("GitHub returned an invalid verification code. Nothing was connected."));
    }
    let interval=Duration::from_secs(response.interval.max(5));
    let mut state=lock(&s.self_update.auth.state);
    state.pending=Some(Pending{device_code:Secret::new(response.device_code.as_str()),user_code:response.user_code,expires_at:now()+response.expires_in,
        expires:Instant::now()+Duration::from_secs(response.expires_in),interval,next_poll:Instant::now()+interval});
    state.error=None;drop(state);
    Ok(status_with(&s,Some(&c)))
}

pub(super) async fn api_get(s:&App,c:&Channel,relative:&str,max:u64)->Result<Option<Zeroizing<Vec<u8>>>> {
    let token=authenticated_token(s,c).await?;
    let base=format!("https://api.github.com/repos/{}/{}",c.owner,c.repository);
    let url=if relative.is_empty(){base}else{format!("{base}/{relative}")};
    let response=client()?.get(url).header(ACCEPT,"application/vnd.github+json").header("X-GitHub-Api-Version","2022-11-28")
        .header(AUTHORIZATION,authorization(&token)?).timeout(Duration::from_secs(30)).send().await
        .map_err(|_|invalid("The private GitHub release source could not be reached. Try again."))?;
    if response.status().as_u16()==401 {expired_if_current(s,&token);return Err(invalid("The GitHub update connection expired. Connect again."));}
    if response.status().as_u16()==404 {return Ok(None);}
    if !response.status().is_success(){return Err(invalid("GitHub refused access to the private release source. Check your repository access."));}
    Ok(Some(bounded_response(response,max).await?))
}

pub(super) async fn poll(app:&AppHandle)->Result<UpdateAuth> {
    let s=app.state::<App>();let c=super::channel().map_err(invalid)?.ok_or_else(||invalid("The private update repository is not configured."))?;
    let current=status_with(&s,Some(&c));
    if current.state!="pending" {return Ok(current);}
    if s.self_update.auth.busy.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).is_err(){return Ok(status_with(&s,Some(&c)));}
    let _busy=Busy(&s.self_update.auth.busy);
    let pending={
        let mut state=lock(&s.self_update.auth.state);
        let Some(pending)=state.pending.as_mut()else{drop(state);return Ok(status_with(&s,Some(&c)))};
        if Instant::now()<pending.next_poll {drop(state);return Ok(status_with(&s,Some(&c)));}
        pending.next_poll=Instant::now()+pending.interval;pending.clone()
    };
    let response:Grant=device_post("https://github.com/login/oauth/access_token",&[("client_id",&c.github_app_client_id),("device_code",pending.device_code.expose()),("grant_type","urn:ietf:params:oauth:grant-type:device_code")]).await?;
    if let Some(error)=response.error.as_deref() {
        let mut state=lock(&s.self_update.auth.state);
        match error{
            "authorization_pending"=>{},
            "slow_down"=>if let Some(p)=state.pending.as_mut(){p.interval=Duration::from_secs(response.interval.unwrap_or(p.interval.as_secs()+5).max(p.interval.as_secs()+5).min(300));p.next_poll=Instant::now()+p.interval;},
            "access_denied"=>{state.pending=None;state.error=Some("GitHub authorization was cancelled. Connect again when ready.".into());},
            "expired_token"|"token_expired"=>{state.pending=None;state.error=Some("The GitHub verification code expired. Connect again.".into());},
            _=>{state.pending=None;state.error=Some("GitHub could not authorize this app. Ask the publisher to check its read-only GitHub App and enable device flow.".into());},
        }
        drop(state);return Ok(status_with(&s,Some(&c)));
    }
    let mut credential=credential(response,String::new())?;
    #[derive(Deserialize)]struct User{login:String}
    let who=client()?.get("https://api.github.com/user").header(ACCEPT,"application/vnd.github+json").header(AUTHORIZATION,authorization(&credential.token)?)
        .timeout(Duration::from_secs(30)).send().await.map_err(|_|invalid("The authorized GitHub user could not be checked."))?;
    if !who.status().is_success(){return Err(invalid("GitHub could not confirm the update user."));}
    let user:User=serde_json::from_slice(&bounded_response(who,MAX_RESPONSE).await?).map_err(|_|invalid("The GitHub update user was invalid."))?;
    if user.login.is_empty()||user.login.len()>39||!user.login.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'){return Err(invalid("The GitHub update user was invalid."));}
    credential.login=user.login;
    // Repository access is checked before persisting any authorization. The App's
    // Contents:read permission and the user's collaborator access must both allow it.
    let repo=client()?.get(format!("https://api.github.com/repos/{}/{}",c.owner,c.repository))
        .header(ACCEPT,"application/vnd.github+json").header(AUTHORIZATION,authorization(&credential.token)?)
        .timeout(Duration::from_secs(30)).send().await.map_err(|_|invalid("The private repository access could not be checked."))?;
    if !repo.status().is_success(){lock(&s.self_update.auth.state).pending=None;return Err(invalid("This GitHub account or App does not have access to the private Unknown alt repository. Only the publisher can invite collaborators."));}
    #[derive(Deserialize)]struct Repo{private:bool,full_name:String}
    let repo:Repo=serde_json::from_slice(&bounded_response(repo,MAX_RESPONSE).await?).map_err(|_|invalid("The private update repository returned invalid metadata."))?;
    if !repo.private || !repo.full_name.eq_ignore_ascii_case(&format!("{}/{}",c.owner,c.repository)){return Err(invalid("The update repository must remain private and match the configured owner."));}
    commit_device_credential(&s.self_update.auth,credential.clone(),&pending.device_code,||store(&s,&c,&credential))?;
    Ok(status_with(&s,Some(&c)))
}

pub(super) fn disconnect(s:&App)->Result<UpdateAuth> {
    if s.self_update.installing(){return Err(invalid("Wait for the current update to finish before disconnecting."));}
    if s.self_update.auth.busy.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).is_err(){return Err(invalid("Wait for the current GitHub authorization request to finish."));}
    let _busy=Busy(&s.self_update.auth.busy);
    if file_metadata(&path(s))?.is_some(){std::fs::remove_file(path(s))?;}
    *lock(&s.self_update.auth.state)=State{loaded:true,..Default::default()};
    Ok(status(s))
}

#[cfg(test)]mod tests{
    use super::*;
    struct FixtureDirectory(PathBuf);
    impl FixtureDirectory{
        fn new()->Self{
            let dir=std::env::temp_dir().join(format!("UnknownAlt-auth-fixture-{}",uuid::Uuid::new_v4()));
            std::fs::create_dir(&dir).unwrap();Self(dir)
        }
    }
    impl Drop for FixtureDirectory{
        fn drop(&mut self){
            // Only this fixture's files are created here; never recurse into another
            // directory or follow a link during cleanup, including a failed test.
            if let Ok(files)=std::fs::read_dir(&self.0){for file in files.flatten(){let _=std::fs::remove_file(file.path());}}
            let _=std::fs::remove_dir(&self.0);
        }
    }
    fn fixture_channel()->Channel{
        Channel{schema_version:1,owner:"FixtureOwner".into(),repository:"UnknownAlt".into(),channel:"stable".into(),
            public_key_p256:String::new(),visibility:"private".into(),github_app_client_id:"IvFixturePublicClient".into()}
    }
    fn fixture_credential(token:&str)->Credential{
        Credential{token:Secret::new(token),login:"FixtureUser".into(),expires_at:Some(now()+60),
            refresh_token:Some(Secret::new("ghr_0123456789abcdefghijklmnop")),refresh_expires_at:Some(now()+86400)}
    }
    #[test]fn only_github_app_tokens_are_accepted(){
        assert!(valid_token("ghu_0123456789abcdefghijklmnop"));
        for value in ["ghp_0123456789abcdefghijklmnop","gho_0123456789abcdefghijklmnop","Bearer token","ghu_short","ghu_0123456789abcdef\r\nleak"]{assert!(!valid_token(value));}
    }
    #[test]fn grants_refresh_without_publisher_secrets_and_reject_broad_scopes(){
        let raw=serde_json::json!({"access_token":"ghu_0123456789abcdefghijklmnop","token_type":"bearer","scope":"","expires_in":28800,
            "refresh_token":"ghr_0123456789abcdefghijklmnop","refresh_token_expires_in":15897600});
        let parsed=credential(serde_json::from_value(raw.clone()).unwrap(),"FixtureUser".into()).unwrap();
        assert!(can_refresh(&parsed));assert!(parsed.expires_at.unwrap()>now());
        assert_eq!(format!("{:?}",parsed.token),"Secret(..)");
        let mut broad=raw.clone();broad["scope"]="repo".into();
        assert!(credential(serde_json::from_value(broad).unwrap(),"FixtureUser".into()).is_err());
        let mut wrong=raw;wrong["refresh_token"]="ghp_0123456789abcdefghijklmnop".into();
        assert!(credential(serde_json::from_value(wrong).unwrap(),"FixtureUser".into()).is_err());
    }
    #[test]fn update_authorization_is_dpapi_bound_to_its_own_purpose(){
        let raw=b"synthetic private update connection";
        let wrapped=crate::vault::protect_with(raw,ENTROPY).unwrap();
        assert_ne!(wrapped.as_slice(),raw);
        assert_eq!(crate::vault::unprotect_with(&wrapped,ENTROPY).unwrap().as_slice(),raw);
        assert!(crate::vault::unprotect_with(&wrapped,b"UnknownAlt/unrelated-test/v1").is_err());
    }
    #[test]fn real_windows_connection_file_round_trips_and_replaces_with_effective_acl(){
        let dir=FixtureDirectory::new();let channel=fixture_channel();
        let first=fixture_credential("ghu_old0123456789abcdefghijklmnop");
        store_in(&dir.0,&channel,&first).unwrap();
        let file=dir.0.join(FILE_NAME);
        let wrapped=std::fs::read(&file).unwrap();
        assert!(!wrapped.windows(first.token.expose().len()).any(|part|part==first.token.expose().as_bytes()));
        assert!(crate::vault::unprotect_with(&wrapped,b"UnknownAlt/unrelated-test/v1").is_err());
        let loaded=load_file(&file,&channel).unwrap().unwrap();
        assert_eq!(loaded.token.expose(),first.token.expose());
        assert_eq!(loaded.login,first.login);
        assert_eq!(loaded.refresh_token.unwrap().expose(),first.refresh_token.unwrap().expose());
        let second=fixture_credential("ghu_new0123456789abcdefghijklmnop");
        store_in(&dir.0,&channel,&second).unwrap();
        assert_eq!(load_file(&file,&channel).unwrap().unwrap().token.expose(),second.token.expose());
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(),1,"successful saves leave no temporary files");
        // The credential must remain readable, replaceable and deletable by this
        // process after ACL hardening; inheritance-only grants fail this contract.
        std::fs::remove_file(&file).unwrap();
        assert!(load_file(&file,&channel).unwrap().is_none());
    }
    #[test]fn locked_connection_file_preserves_previous_ciphertext_and_cleans_failed_temp(){
        let dir=FixtureDirectory::new();let channel=fixture_channel();
        let first=fixture_credential("ghu_old0123456789abcdefghijklmnop");
        store_in(&dir.0,&channel,&first).unwrap();
        let file=dir.0.join(FILE_NAME);let previous=std::fs::read(&file).unwrap();
        let held=OpenOptions::new().read(true).share_mode(0).open(&file).unwrap();
        let second=fixture_credential("ghu_new0123456789abcdefghijklmnop");
        let error=store_in(&dir.0,&channel,&second).unwrap_err().message();
        assert_eq!(error,"The private-update connection file could not be replaced. Close apps using it and connect again.");
        assert!(!error.contains(first.token.expose()) && !error.contains(second.token.expose()));
        assert!(!error.contains(&dir.0.to_string_lossy().into_owned()));
        drop(held);
        assert_eq!(std::fs::read(&file).unwrap(),previous,"failure must preserve the prior encrypted credential");
        assert_eq!(load_file(&file,&channel).unwrap().unwrap().token.expose(),first.token.expose());
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(),1,"failed saves clean their new temporary files");
    }
    #[test]fn connection_file_creation_failure_reports_only_the_save_step(){
        let dir=FixtureDirectory::new();let missing=dir.0.join("not-created");
        let error=store_in(&missing,&fixture_channel(),&fixture_credential("ghu_fixture0123456789abcdefghijklmnop")).unwrap_err().message();
        assert_eq!(error,"The private-update connection temporary file could not be created.");
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(),0);
    }
    #[test]fn failed_consumed_grants_allow_retry_without_cancelling_newer_flows_or_old_credentials(){
        let auth=Auth::default();let old=fixture_credential("ghu_old0123456789abcdefghijklmnop");
        let code=Secret::new("synthetic-consumed-device-code");
        let pending=|device_code:Secret|Pending{device_code,user_code:"ABCD-EFGH".into(),expires_at:now()+900,
            expires:Instant::now()+Duration::from_secs(900),interval:Duration::from_secs(5),next_poll:Instant::now()};
        {let mut state=lock(&auth.state);state.credential=Some(old.clone());state.pending=Some(pending(code.clone()));}
        let next=fixture_credential("ghu_new0123456789abcdefghijklmnop");
        assert!(commit_device_credential(&auth,next.clone(),&code,||Err(invalid("Synthetic save failure."))).is_err());
        {let state=lock(&auth.state);assert!(state.pending.is_none());assert_eq!(state.error.as_deref(),Some("Synthetic save failure."));
            assert_eq!(state.credential.as_ref().unwrap().token.expose(),old.token.expose());}
        let newer_code=Secret::new("synthetic-newer-device-code");
        {let mut state=lock(&auth.state);state.pending=Some(pending(newer_code.clone()));state.error=None;}
        assert!(commit_device_credential(&auth,next,&code,||panic!("an obsolete flow must not persist anything")).is_err());
        let state=lock(&auth.state);
        assert_eq!(state.pending.as_ref().unwrap().device_code.expose(),newer_code.expose());
        assert!(state.error.is_none());assert_eq!(state.credential.as_ref().unwrap().token.expose(),old.token.expose());
    }
    #[test]fn refresh_reloads_after_a_completed_disconnect_instead_of_resurrecting_a_snapshot(){
        use std::sync::Arc;
        let auth=Arc::new(Auth::default());
        lock(&auth.state).credential=Some(fixture_credential("ghu_old0123456789abcdefghijklmnop"));
        let stale=lock(&auth.state).credential.clone();
        assert!(stale.is_some());
        let disconnected=auth.clone();
        std::thread::spawn(move||{
            assert!(disconnected.busy.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).is_ok());
            let busy=Busy(&disconnected.busy);
            *lock(&disconnected.state)=State{loaded:true,..Default::default()};
            drop(busy);
        }).join().unwrap();
        let(_busy,current)=begin_refresh(&auth).unwrap();
        assert!(current.is_none(),"refresh must reload after the busy guard; a pre-disconnect clone must not be reused");
    }
    #[test]fn old_unauthorized_responses_cannot_clear_a_new_connection_or_pending_flow(){
        let old=Secret::new("ghu_old0123456789abcdefghijklmnop");
        let newer=fixture_credential("ghu_new0123456789abcdefghijklmnop");
        let pending=Pending{device_code:Secret::new("synthetic-device-code"),user_code:"ABCD-EFGH".into(),expires_at:now()+900,
            expires:Instant::now()+Duration::from_secs(900),interval:Duration::from_secs(5),next_poll:Instant::now()};
        let mut state=State{loaded:true,credential:Some(newer),pending:Some(pending),error:None};
        assert!(!invalidate_current(&mut state,&old));
        assert!(state.credential.is_some());assert!(state.pending.is_some());
        state.credential=None;
        assert!(!invalidate_current(&mut state,&old));assert!(state.pending.is_some());
        state.credential=Some(fixture_credential(old.expose()));
        assert!(invalidate_current(&mut state,&old));assert!(state.credential.is_none());
        assert!(state.pending.is_some(),"even a matching token failure cannot cancel a different device flow");
    }
    #[test]fn persisted_credentials_and_live_state_are_published_in_one_critical_section(){
        use std::sync::{Arc,mpsc};
        let auth=Arc::new(Auth::default());
        let old=Secret::new("ghu_old0123456789abcdefghijklmnop");
        lock(&auth.state).credential=Some(fixture_credential(old.expose()));
        let file=Arc::new(Mutex::new(Some(old.expose().to_owned())));
        let(started_tx,started_rx)=mpsc::channel();let(release_tx,release_rx)=mpsc::channel();
        let writer_auth=auth.clone();let writer_file=file.clone();
        let writer=std::thread::spawn(move||{
            let next=fixture_credential("ghu_new0123456789abcdefghijklmnop");
            let persisted=next.token.expose().to_owned();
            commit_credential(&writer_auth,next,None,||{
                *lock(&writer_file)=Some(persisted);
                started_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            }).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        // This is the exact old gap: disk already contains the new record but the
        // live replacement has not happened. Old 401 processing must be excluded.
        let state_is_locked=auth.state.try_lock().is_err();
        release_tx.send(()).unwrap();writer.join().unwrap();
        assert!(state_is_locked,"the auth state mutex must cover the persistence callback");
        let mut state=lock(&auth.state);
        assert!(!invalidate_current(&mut state,&old));
        assert_eq!(lock(&file).as_deref(),Some("ghu_new0123456789abcdefghijklmnop"));
    }
}
