
## 1.2.0 Windows build and release

Use a clean source checkout; never copy an installed app's data/profile directories.
The installer builder checks the Microsoft signature of its WebView2 prerequisite
and includes it only as a prerequisite payload. The application executable and
mascot, license and notices are explicit installer inputs. Windows 10 build 17763
(1809) or later and Windows 11 x64 remain the target platforms.

Run `npm ci`, `npm run build`, `node scripts/check-ipc.mjs`,
`node scripts/release-test.mjs`, and `cargo test --manifest-path src-tauri/Cargo.toml`.
Native tests use synthetic accounts/temporary databases; live service checks marked
ignored are optional and must not use personal credentials in public logs.
Then use `scripts/build-installer.ps1` (Inno Setup 6.6+, MSVC, Rust and Strawberry
Perl). Optional `-OfflineRuntime` bundles the larger standalone WebView2 runtime.
The canonical updater installer is `UnknownAlt-Setup-1.2.0.exe`.

Inspect the final executable/installer for private metadata and use
`Get-AuthenticodeSignature` to report actual Windows signing status. Do not claim
SignPath signing before provider approval and integration. Sign the final update
manifest with `node scripts/release-sign.mjs --key-file <private-key-outside-repo>`.
The pinned public key and owner/repository restrictions must remain unchanged.
Publish the canonical installer, `UnknownAlt-update.json`, its `.sig`, and
`SHA256SUMS.txt` together under tag `v1.2.0` in Unknown69511/UnknownAlt. Never replace
existing versioned installer bytes. The offline installer is not an updater asset.

Commit as Unknown69511 with `275345990+Unknown69511@users.noreply.github.com` and UTC
author/committer dates. Preserve LICENSE and NOTICE.md. Exclude vaults, databases,
keys, session profiles, exports, logs, caches and developer environment files.
