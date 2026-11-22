#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[macro_use]
mod i18n;
mod bulletins;
mod disk_usage;
mod error;
mod http;
mod secret_types;
mod backup_codec;

#[cfg(windows)]
use vault::master as archive_master;
#[cfg(not(windows))]
#[path = "vault/master.rs"]
mod archive_master;
#[cfg(not(windows))]
use secret_types::{Kdf, Secret};

#[cfg(windows)]
include!("desktop_windows.rs");

#[cfg(any(test, target_os = "macos", target_os = "linux"))]
mod portable;

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn main() {
    portable::run();
}
