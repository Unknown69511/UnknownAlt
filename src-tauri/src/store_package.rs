//! Detect an MSIX identity even when this is the same executable used in the EXE installer.
pub const UPDATE_NOTICE: &str = "Install updates for this package from its distribution channel.";

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentPackageFullName(length: *mut u32, name: *mut u16) -> i32;
}

pub fn active() -> bool {
    const ERROR_INSUFFICIENT_BUFFER: i32 = 122;
    let mut length = 0;
    // SAFETY: the length is initialized and a null buffer with size zero is a documented probe.
    unsafe {
        GetCurrentPackageFullName(&mut length, std::ptr::null_mut()) == ERROR_INSUFFICIENT_BUFFER
    }
}
