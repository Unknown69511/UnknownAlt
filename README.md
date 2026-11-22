# UnknownALT

UnknownALT is a local Windows account manager and launcher for Roblox. It includes Farm Control Center, per-client audio, resource-aware launch scheduling, game discovery and analytics, and the Roblox service status monitor. Brown is the default accent. The top Discord button opens the [UnknownALT community](https://discord.gg/8EVsaWTH8S). See the [changelog](CHANGELOG.md) and [app privacy notice](docs/APP-PRIVACY.md).

## Download and signed updates

Source and Windows installers are public at [Unknown69511/UnknownAlt](https://github.com/Unknown69511/UnknownAlt). Download the Windows x64 installer from [Releases](https://github.com/Unknown69511/UnknownAlt/releases/latest). The small installer downloads Microsoft's WebView2 runtime if it is missing; an optional offline installer bundles it. Neither needs developer tools or the publisher PC.

The GitHub release ships the Windows EXE. The Microsoft Store edition uses a separate MSIX package and Store-managed updates. Native macOS and Linux downloads are pending builds and tests on those platforms.

Public builds check for updates without a GitHub account, sign-in, token or publisher credentials. Accounts, sessions, settings and encryption keys stay independent and local to each Windows user. No creator accounts, cookies, passwords, private keys, local databases or personal settings are included in source or release packages.

The app verifies the owner's pinned P-256 signature and installer hash/size. It never uses the original product's feeds or signing key. Checks run on startup and hourly. **Update** stays visible beside **Refresh**: clicking checks for a release, tells you when you are up to date, and installs a verified newer version when available. The owner reviews and signs releases locally; CI builds unsigned candidates and never receives the private signing key or publishes automatically. See [updates and publication](docs/UPDATES.md).

Public read access does not grant repository write access. The owner invites collaborators only by exact approved GitHub username. Private-only 1.1.3 clients need one manual installation of the public 1.1.4 or newer bootstrap to switch channels; existing encrypted accounts/settings remain compatible.

## Windows locations

| Item | Default location |
| --- | --- |
| Installed app | `%LOCALAPPDATA%\Programs\UnknownALT\UnknownAlt.exe` |
| Accounts and settings | `%LOCALAPPDATA%\UnknownALT\UnknownAlt.db` and its `.key`/WAL/SHM siblings |
| Encrypted local snapshots | `%LOCALAPPDATA%\UnknownAlt-backups` (five retained; never distribute) |
| Window state | `%APPDATA%\com.unknownalt.desktop` |

Every Windows user generates independent local keys and data. A chosen custom data location is still supported. Existing database/key/journal filenames migrate together through a resumable, no-overwrite migration. Back up the complete closed data folder before upgrading. Do not rename or delete individual encrypted files, and do not downgrade by replacing the executable alone; recovery uses the complete matching application/data snapshot.

## Build

See [platform builds and signing](docs/PLATFORMS.md) for Windows MSIX, macOS
universal DMG and Linux AppImage/DEB build targets and platform feature limits.

Build requirements: Windows x64, Node.js 24, Rust 1.95+, MSVC C++ Build Tools/Windows SDK, native Strawberry Perl and Inno Setup 6.6+. Recipients need no developer tools or publisher PC.

```powershell
npm ci
.\scripts\build-installer.ps1
```

The script builds the embedded production UI with `src-tauri/tauri.release.conf.json`, verifies Microsoft's WebView2 prerequisite, then writes `dist-installer\UnknownALT-Setup-X.Y.Z.exe`. Release signing stages a legacy-named copy for installed updaters. A short, neutral Cargo registry/target path is recommended for Windows native builds and privacy.

For the full first-installation package with the offline Microsoft x64 WebView2 Runtime:

```powershell
.\scripts\build-installer.ps1 -OfflineRuntime
```

This creates `UnknownALT-Setup-X.Y.Z-Windows-x64.exe`. It includes the full WebView2 runtime. Portable compiler locations can be provided with `-InnoCompiler` and `-PerlBin`. See [clean distribution](docs/DISTRIBUTION.md) for staging and package audits.

## Roblox Analytics

**Tools → Discover** searches Roblox and shows official trending and popular
lists. Growth and underrated rankings cover the displayed catalog. Newly
released uses Roblox's public experience creation dates. Similar games come
from Roblox recommendations or genre and description matches in loaded games.

**Tools → Analytics** shows Roblox's official game charts, independent platform
samples, player records, studios, genres, and a game activity calendar. Search
Roblox by name or link to open a game's analytics. Charts support date ranges,
drag-to-zoom, game comparisons and attributed CSV exports.

Game player history comes from [RoWatcher daily records](https://rowatcher.com/developers)
(CC BY 4.0, up to 730 days) and [RobloxGameStats](https://robloxgamestats.com/docs/api)
hourly and daily records. The long-range charts show gaps when providers lack
records and offer zoom and timeline scrolling. Coverage varies by metric. Platform totals
cover experiences tracked by the named provider. Figures titled **Est.** are
model estimates. The **Official Top Earning** chart shows Roblox ranking order
without dollar amounts. Pick USD, Robux, or Both for estimates. Robux shows
gross spending. USD is the model’s before-tax DevEx equivalent at the standard
rate. Studio estimates cover only games with available models. The global
**Appearance → Number Format** setting changes the display without changing
stored values or CSV exports.

Watched games still support local samples and notifications. A bounded public
history cache enables offline viewing when previously requested records are
available. Public analytics uses anonymous requests and never shares saved
Roblox credentials with either data provider.

**Tools → Roblox Status** shows service health, current incidents and resolved
incident history. In-app alerts can be enabled on that page. Press **F11**
to toggle fullscreen or **Escape** to return to the prior window state.

Use **Settings → Notifications** to choose which alerts you receive and open
their history. The Windows installer registers native notifications for use
while UnknownALT is in the background. Friend request checks are opt-in.

My Games connects with a Roblox Open Cloud API key scoped to selected experiences
and Analytics read access. The key and reports stay in memory while the page
is open. CSV export writes only to the location you choose. Roblox determines
which metrics, breakdowns and dates each authorized experience can return.
See [Analytics Query API](https://create.roblox.com/docs/cloud/guides/analytics)
and [API key configuration](https://create.roblox.com/docs/cloud/auth/api-keys).

Checks include `npm run build`, `node scripts/release-test.mjs` and `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-update-helper.ps1`. Native targeted tests cover encrypted-data migration, update authentication/signatures, compatibility readers and recovery behavior. Never point tests at real account data.

## License and compatibility

Derived from [inspectsoftware/RoALT v1.1.0](https://github.com/inspectsoftware/RoALT/tree/d16b3e277ce24859a5159354a6f289891b09fe2f); original copyright and [MIT license](LICENSE) are retained. Old-name strings remain only where required to read existing encrypted records/imports, reject original-product update sources, identify external service contracts, or document provenance. See [rebranding and compatibility](REBRANDING.md).

