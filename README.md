# Unknown alt

A local Windows account manager and multi-client launcher. The display name is **Unknown alt**; code identifiers, executable names and data filenames use **UnknownAlt**. The charcoal coffee mascot is used in the app, native icons and shortcuts. Brown (`#8b5e3c`) is the factory accent, alongside all existing selectable colors. Donate, News and Upstream navigation are removed. The top Discord button opens https://discord.gg/8EVsaWTH8S. See [the 1.2.0 changes](CHANGELOG.md) for first-run setup, Take control, lighter previews, session locking, Discord controls, group defaults and safer sign-in.

## Download and signed updates

Source and Windows installers are public at [Unknown69511/UnknownAlt](https://github.com/Unknown69511/UnknownAlt). Download the Windows x64 installer from [Releases](https://github.com/Unknown69511/UnknownAlt/releases/latest). The small installer downloads Microsoft's WebView2 runtime if it is missing; an optional offline installer bundles it. Neither needs developer tools or the publisher PC.

Public builds check for updates without a GitHub account, sign-in, token or publisher credentials. Accounts, sessions, settings and encryption keys stay independent and local to each Windows user. No creator accounts, cookies, passwords, private keys, local databases or personal settings are included in source or release packages.

The app verifies the owner's pinned P-256 signature and installer hash/size. It never uses the original product's feeds or signing key. Checks run on startup and hourly. **Update** stays visible beside **Refresh**: clicking checks for a release, tells you when you are up to date, and installs a verified newer version when available. The owner reviews and signs releases locally; CI builds unsigned candidates and never receives the private signing key or publishes automatically. See [updates and publication](docs/UPDATES.md).

Public read access does not grant repository write access. The owner invites collaborators only by exact approved GitHub username. Private-only 1.1.3 clients need one manual installation of the public 1.1.4 or newer bootstrap to switch channels; existing encrypted accounts/settings remain compatible.

## Windows locations

| Item | Default location |
| --- | --- |
| Installed app | `%LOCALAPPDATA%\Programs\UnknownAlt\UnknownAlt.exe` |
| Accounts and settings | `%LOCALAPPDATA%\UnknownAlt\UnknownAlt.db` and its `.key`/WAL/SHM siblings |
| Window state | `%APPDATA%\com.unknownalt.desktop` |

Every Windows user generates independent local keys and data. A chosen custom data location is still supported. Existing database/key/journal filenames migrate together through a resumable, no-overwrite migration. Back up the complete closed data folder before upgrading. Do not rename or delete individual encrypted files, and do not downgrade by replacing the executable alone; recovery uses the complete matching application/data snapshot.

## Build

Build requirements: Windows x64, Node.js 24, Rust 1.95+, MSVC C++ Build Tools/Windows SDK, native Strawberry Perl and Inno Setup 6.6+. Recipients need no developer tools or publisher PC.

```powershell
npm ci
.\scripts\build-installer.ps1
```

The script builds the embedded production UI with `src-tauri/tauri.release.conf.json`, verifies Microsoft's WebView2 prerequisite, then creates the canonical `dist-installer\UnknownAlt-Setup-X.Y.Z.exe` update installer. A short, neutral Cargo registry/target path is recommended for Windows native builds and privacy.

For the full first-installation package with the offline Microsoft x64 WebView2 Runtime:

```powershell
.\scripts\build-installer.ps1 -OfflineRuntime
```

This creates `UnknownAlt-Setup-X.Y.Z-Windows-x64.exe`. It is a separate bootstrap download; future canonical update installers remain below the channel's size bound. Portable compiler locations can be provided with `-InnoCompiler` and `-PerlBin`. See [clean distribution](docs/DISTRIBUTION.md) for source-only staging and package audits.

Checks include `npm run build`, `node scripts/release-test.mjs` and `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-update-helper.ps1`. Native targeted tests cover encrypted-data migration, update authentication/signatures, compatibility readers and recovery behavior. Never point tests at real account data.

## License and compatibility

Derived from [inspectsoftware/RoALT v1.1.0](https://github.com/inspectsoftware/RoALT/tree/d16b3e277ce24859a5159354a6f289891b09fe2f); original copyright and [MIT license](LICENSE) are retained. Old-name strings remain only where required to read existing encrypted records/imports, reject original-product update sources, identify external service contracts, or document provenance. See [rebranding and compatibility](REBRANDING.md).

