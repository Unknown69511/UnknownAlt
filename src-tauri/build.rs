fn main() {
    // Keep the linker's CodeView record independent of the build computer.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-bin=unknownalt=/PDBALTPATH:UnknownALT.pdb");
    }
    // Native Windows resources must refresh when the app icon changes.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
