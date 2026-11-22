use std::fs::OpenOptions;
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, FindWindowW, FlashWindow, SW_RESTORE, SetForegroundWindow,
    ShowWindowAsync, PostMessageW,
};
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::core::PCWSTR;

use crate::error::{AppError, Result};
use crate::update_handoff::parent_start_time;

const WINDOW_EXE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/UnknownALT-Update.exe"));
const TITLE: &str = "UnknownALT Update - ";
const NO_CONSOLE: u32 = 0x0800_0000;
static ACTIVE: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status<'a> {
    phase: &'a str,
    current: u64,
    total: u64,
    owner_pid: u32,
    owner_start: String,
}

pub struct Progress {
    stage: PathBuf,
    child: Option<Child>,
    owner_start: u64,
    transferred: bool,
}

fn write_new(path: &Path, content: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(content)?;
    Ok(())
}

fn title(stage: &Path) -> Option<String> {
    let token = stage
        .file_name()?
        .to_str()?
        .strip_prefix("unknownalt-update-")?;
    let uuid = uuid::Uuid::parse_str(token).ok()?;
    Some(format!("{TITLE}{uuid}"))
}

fn window(stage: &Path) -> Option<windows::Win32::Foundation::HWND> {
    let title: Vec<u16> = title(stage)?.encode_utf16().chain(Some(0)).collect();
    // SAFETY: the title is UTF-16 and terminated for the duration of this call.
    unsafe { FindWindowW(PCWSTR::null(), PCWSTR(title.as_ptr())).ok() }
}

/// The transaction remains authoritative. This only redirects a duplicate launch's attention.
pub fn focus(stage: &Path) -> bool {
    let Some(hwnd) = window(stage) else {
        return false;
    };
    unsafe {
        let _ = ShowWindowAsync(hwnd, SW_RESTORE);
        if !SetForegroundWindow(hwnd).as_bool() {
            let _ = FlashWindow(hwnd, true);
        }
    }
    true
}

pub fn focus_active() -> bool {
    let active = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(stage) = active.as_ref() {
        focus(stage);
        // Initial creation takes a moment. Do not show the main window again during that gap.
        true
    } else {
        false
    }
}

pub fn clear(stage: &Path) {
    let mut active = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
    if active.as_deref() == Some(stage) {
        *active = None;
    }
}

impl Progress {
    pub fn start(stage: &Path) -> Result<Self> {
        let executable = stage.join("UnknownALT-Update.exe");
        write_new(&executable, WINDOW_EXE)?;
        let mut progress = Self {
            stage: stage.to_owned(),
            child: None,
            owner_start: parent_start_time()?,
            transferred: false,
        };
        progress.write("preparing", 0, 0)?;
        *ACTIVE.lock().unwrap_or_else(|e| e.into_inner()) = Some(stage.to_owned());

        // This private copy of the branded executable continues to
        // display the transaction while the original executable closes and is replaced.
        let child = Command::new(executable)
            .arg(stage)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(NO_CONSOLE)
            .spawn()?;
        unsafe {
            let _ = AllowSetForegroundWindow(child.id());
        }
        progress.child = Some(child);
        let until = Instant::now() + Duration::from_secs(8);
        loop {
            if window(stage).is_some() {
                return Ok(progress);
            }
            if progress
                .child
                .as_mut()
                .is_some_and(|child| child.try_wait().ok().flatten().is_some())
                || Instant::now() >= until
            {
                return Err(AppError::Invalid(
                    "UnknownALT could not open its update window. Try again.".into(),
                ));
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    }

    fn write(&self, phase: &str, current: u64, total: u64) -> Result<()> {
        Self::write_status(&self.stage, self.owner_start, phase, current, total)
    }

    fn write_status(stage: &Path, owner_start: u64, phase: &str, current: u64, total: u64) -> Result<()> {
        let status = Status {
            phase,
            current,
            total,
            owner_pid: std::process::id(),
            owner_start: owner_start.to_string(),
        };
        let bytes = serde_json::to_vec(&status)
            .map_err(|_| AppError::Internal("Could not encode update progress.".into()))?;
        crate::vault::backup::write_atomic(&stage.join("update-progress.json"), &bytes)
    }

    pub fn reporter(&self) -> impl Fn(&str, u64, u64) + use<> {
        let stage = self.stage.clone();
        let owner = self.owner_start;
        move |phase, current, total| {
            if Self::write_status(&stage, owner, phase, current, total).is_err() {
                log::debug!("Could not refresh the local update window status.");
            }
        }
    }

    pub fn set(&self, phase: &str, current: u64, total: u64) {
        if self.write(phase, current, total).is_err() {
            log::debug!("Could not refresh the local update window status.");
        }
    }

    /// The helper publishes all phases after it acknowledges the handoff.
    pub fn transfer(mut self) {
        self.transferred = true;
    }
}

impl Drop for Progress {
    fn drop(&mut self) {
        if self.transferred {
            return;
        }
        if let Some(mut child) = self.child.take() {
            // The stage can be cleaned immediately. The failure text uses no staged data.
            let delivered = window(&self.stage).is_some_and(|hwnd| unsafe {
                PostMessageW(Some(hwnd), 0x8145, WPARAM(0), LPARAM(0)).is_ok()
            });
            if !delivered {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        clear(&self.stage);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_titles_are_scoped_to_an_owned_transaction_id() {
        assert!(title(Path::new("unknownalt-update-invalid")).is_none());
        assert_eq!(
            title(Path::new(
                "unknownalt-update-00000000-0000-0000-0000-000000000001"
            ))
            .as_deref(),
            Some("UnknownALT Update - 00000000-0000-0000-0000-000000000001")
        );
    }
}
