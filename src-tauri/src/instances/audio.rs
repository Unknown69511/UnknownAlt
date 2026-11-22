//! "Mute clients on launch": sets one client's own Windows audio session muted or not (Core Audio,
//! by process id); Roblox's settings file is untouched. Windows may remember a mute for the next
//! session of the same exe, so every UnknownALT client gets set, unmuted when the setting is off; a
//! Roblox started outside UnknownALT can still inherit one. The user can change it in the volume mixer.

use std::time::Duration;

use windows::Win32::Media::Audio::{
    DEVICE_STATE_ACTIVE, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume,
    MMDeviceEnumerator, eRender,
};
use windows::Win32::System::Com::{CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize};
use windows::core::{Interface, Result};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AudioChange { volume: Option<u8>, muted: Option<bool> }

#[derive(Serialize, TS)]
#[ts(export)]
pub struct AudioLevel { sessions: u32, volume: u8, muted: bool }

pub fn mix(pid: u32, started: u64, change: Option<AudioChange>) -> crate::error::Result<AudioLevel> {
    use crate::error::AppError;
    if change.as_ref().and_then(|c| c.volume).is_some_and(|v| v > 100) {
        return Err(AppError::Invalid("Volume must be from 0 to 100.".into()));
    }
    let current = || super::process::start_time(pid) == Some(started);
    if !current() { return Err(AppError::NotFound); }
    let mut level = AudioLevel { sessions: 0, volume: 100, muted: false };
    sessions_for(pid, |session| {
        if !current() { return Ok(()); }
        unsafe {
            if let Some(change) = &change {
                if let Some(volume) = change.volume { session.SetMasterVolume(f32::from(volume) / 100.0, std::ptr::null())?; }
                if let Some(muted) = change.muted { session.SetMute(muted, std::ptr::null())?; }
            }
            if level.sessions == 0 {
                level.volume = (session.GetMasterVolume()?.clamp(0.0, 1.0) * 100.0).round() as u8;
                level.muted = session.GetMute()?.as_bool();
            }
            level.sessions += 1;
        }
        Ok(())
    }).map_err(|_| AppError::Invalid("Windows could not read or change this client's audio session.".into()))?;
    if !current() { return Err(AppError::NotFound); }
    if change.is_some() && level.sessions == 0 {
        return Err(AppError::Invalid("The client has not opened a Windows audio session yet.".into()));
    }
    Ok(level)
}

/// A client can open its audio session a moment after it reaches a game: tries this often.
const TRIES: u32 = 5;
const STEP: Duration = Duration::from_secs(2);

/// Mutes (or unmutes) every audio session of process `pid` on every active output device.
/// Blocking (it retries while the client has none yet); true when one was set. Failures are logged.
pub fn set_mute(pid: u32, mute: bool) -> bool {
    for attempt in 1..=TRIES {
        match set_once(pid, mute) {
            Ok(n) if n > 0 => return true,
            Ok(_) => {}
            Err(e) => log::debug!("client {pid}: setting muted: {mute} failed (try {attempt}): {e}"),
        }
        if attempt < TRIES {
            std::thread::sleep(STEP);
        }
    }
    false
}

/// How many of `pid`'s sessions were set.
fn set_once(pid: u32, mute: bool) -> Result<u32> {
    let mut count = 0;
    sessions_for(pid, |session| {
        unsafe { session.SetMute(mute, std::ptr::null())?; }
        count += 1;
        Ok(())
    })?;
    Ok(count)
}

fn sessions_for(pid: u32, mut visit: impl FnMut(ISimpleAudioVolume) -> Result<()>) -> Result<()> {
    struct Apartment(bool);
    impl Drop for Apartment {
        fn drop(&mut self) { if self.0 { unsafe { CoUninitialize() }; } }
    }
    // SAFETY: COM on this (blocking-pool) thread's own multithreaded apartment, as network.rs;
    // every interface comes from COM and is released on drop.
    unsafe {
        let _apartment = Apartment(CoInitializeEx(None, COINIT_MULTITHREADED).is_ok());
        let devices = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)?
            .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        for d in 0..devices.GetCount()? {
            let sessions = devices.Item(d)?.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None)?.GetSessionEnumerator()?;
            for i in 0..sessions.GetCount()? {
                let session = sessions.GetSession(i)?;
                if session.cast::<IAudioSessionControl2>()?.GetProcessId().is_ok_and(|p| p == pid) {
                    visit(session.cast::<ISimpleAudioVolume>()?)?;
                }
            }
        }
        Ok(())
    }
}
