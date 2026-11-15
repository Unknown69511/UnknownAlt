fn main() {
    // Native Windows resources must refresh when the app icon changes.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
