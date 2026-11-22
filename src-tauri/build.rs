fn main() {
    // Keep the linker's CodeView record independent of the build computer.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-bin=unknownalt=/PDBALTPATH:UnknownALT.pdb");
    }
    // Native Windows resources must refresh when the app icon changes.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        build_update_window();
    }
    tauri_build::build()
}

fn build_update_window() {
    use std::{env, path::PathBuf, process::Command};

    println!("cargo:rerun-if-changed=update-progress.cs");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    let compiler = PathBuf::from(env::var_os("SystemRoot").expect("Windows system root"))
        .join(r"Microsoft.NET\Framework64\v4.0.30319\csc.exe");
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo build output"))
        .join("UnknownALT-Update.exe");
    // Windows includes this compiler and the same .NET Framework WinForms runtime
    // the update window already used. The helper ships embedded in the app.
    let status = Command::new(compiler)
        .args([
            "/nologo",
            "/target:winexe",
            "/optimize+",
            "/debug-",
            "/win32icon:icons/icon.ico",
            "/resource:icons/128x128.png,UnknownALT.Mascot",
            "/reference:System.Windows.Forms.dll,System.Drawing.dll,System.Web.Extensions.dll",
        ])
        .arg(format!("/out:{}", output.display()))
        .arg("update-progress.cs")
        .status()
        .expect("could not start the Windows .NET Framework C# compiler");
    assert!(status.success(), "could not build the UnknownALT update window");
}
