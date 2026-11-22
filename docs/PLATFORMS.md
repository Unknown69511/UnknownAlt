# Platform builds and signing

The Windows EXE is the full UnknownALT application. The macOS and Linux build
targets provide native desktop account archive and Updates views. Use the
in-app Platform support page for the feature limits.

| Feature | Windows EXE | Windows MSIX candidate | macOS / Linux |
| --- | --- | --- | --- |
| Current Windows account data and settings | Yes | Separate app package. Back up before switching formats. | Import and re-export a password-protected `.unknownalt` archive |
| Credential protection | DPAPI and optional master password | DPAPI and optional master password | macOS Keychain or Linux Secret Service holds the AES archive key |
| Client launches, Farm Control Center, audio, previews, hotkeys, anti-AFK, Browse and sign-in | Yes | Present in the Windows executable. Package-specific behavior requires a signed installation test. | Unavailable |
| Troubleshooting, automatic backup and queue | Full Windows controls | Full Windows controls in the executable | Portable encrypted archive snapshots and retention. Windows client controls are unavailable. |
| Updates page | Yes | Yes | Yes |
| In-app verified EXE installation | Yes | Package distribution channel handles installation | Install the native package manually |

## Windows x64

Build and audit the EXE using `scripts/build-installer.ps1`. Pass the resulting
release executable to `scripts/build-msix.ps1 -Executable <exe>`. The script uses
the Windows SDK MakeAppx validator and creates an unsigned MSIX with a local test
identity by default. Its payload contains the executable, mascot assets and
required license notices. The EXE installer still handles the WebView2 prerequisite.
The MSIX assumes WebView2 is already available on the target computer.

For the Microsoft Store, supply the **exact** Identity Name and Publisher values
assigned by Partner Center. For trusted distribution outside the Store, provide
an existing certificate in CurrentUser\\My with an exact matching subject via
`-CertificateThumbprint` and an optional trusted `-TimestampServer`. Verify the
package with SignTool. The EXE can use an approved Authenticode signing provider.
Review the public publisher identity before signing either package. Preserve the
existing installer format for established installations. A Store build must be
tested under its package identity and approved for its full-trust capability.

## macOS, Intel and Apple Silicon

On a macOS build host with Xcode Command Line Tools, Rust and the pinned Node.js
version, run `bash scripts/build-native.sh`. Tauri builds a universal app with
both `x86_64` and `arm64` slices and bundles it in a DMG. Verify with `lipo -archs`
and launch on each architecture. The configuration enables the hardened runtime.
For distribution, use an existing Developer ID Application identity via
`APPLE_SIGNING_IDENTITY` and Tauri's notarization credentials. Verify the app with
`codesign --verify --deep --strict` and verify the notarized DMG with `xcrun stapler validate`.
Use an approved organization identity if protecting a personal publisher name.

## Linux x64

Use a glibc-based Linux build host with Node.js, Rust, a C compiler, OpenSSL
build prerequisites, WebKitGTK 4.1, GTK, Ayatana AppIndicator, libdbus headers,
patchelf and the AppImage packaging prerequisites. Run
`bash scripts/build-native.sh` to produce AppImage and DEB packages. Use a build
distribution at least as old as the oldest supported target and test extraction,
installation and archive operations in a disposable desktop login. The session
must provide an unlocked Secret Service keyring (for example GNOME Keyring).
The app refuses to save an archive if native credential storage fails.

Sign clean Linux artifacts and the checksum file with an existing project
OpenPGP key using a detached signature. For an APT repository, sign its
`InRelease` metadata with the approved repository key. Review the UID on any
public signing key so it contains only the approved project identity.

## Privacy and local validation

Build from an allowlisted source staging directory and inspect both archive
contents and executable metadata before sharing. Exclude runtime data, logs,
keys, personal paths and build history. The update manifest uses only
Unknown69511/UnknownALT and its pinned key. Roblox and DevForum notices are
read-only editorial feeds loaded when the Updates page is opened.

Portable import keeps the authenticated export payload intact, including settings
that are meaningful only on Windows. It snapshots the previous archive before
replacement, and keeps the five newest encrypted snapshots. The snapshots need
the original OS keychain. Export a separate password-protected file to transfer
the data to another login, computer or platform. The portable edition performs
no automatic package replacement.

Build these packages locally with the appropriate host and run native
installation and first-launch tests. A Windows build and schema validation do
not establish macOS or Linux installer compatibility. Any signing credentials
stay in the OS signing store or approved signing service.
