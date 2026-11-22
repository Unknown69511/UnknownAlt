# UnknownALT 1.2.7

- Rebuilt Roblox Analytics with a platform activity dashboard, game records,
  official Roblox charts, studio portfolios, and an activity calendar.
- Added recorded history from RoWatcher and RobloxGameStats, chart zoom,
  date ranges, comparison overlays, and CSV source attribution.
- Added labeled spending estimates and coverage notes. Existing watchlists,
  account data, and Roblox Open Cloud Creator Analytics remain compatible.

# UnknownALT 1.2.6

- Rebuilt Roblox Analytics around individual game pages, public chart and genre
  views, player comparisons, CSV exports and a customizable creator dashboard.
- Discover adds observed player records, game previews and interactive player
  history. Game pages show public passes, badges, thumbnails and update dates.
- Added notification preferences and clickable history. On Windows, alerts can
  use native notifications while the app is in the background.
- Simplified Farm Control Center navigation and fixed official announcement
  image loading. The updater uses the UnknownALT mascot in the taskbar and
  reports verified backup progress with faster file validation.

# UnknownALT 1.2.5

- Added Discover with Roblox's trending and popular charts, local growth and
  underrated rankings, recent experience creation dates, category filters,
  watchlist actions and similar games.
- Added official Roblox Status with current service health, incident history,
  a saved offline view and optional in-app alerts.
- Fixed Analytics search results disappearing, added comparison timelines,
  and added game follow alerts and player activity around Roblox update dates.
- F11 toggles real fullscreen, including inside Browse on Windows. Escape
  restores the previous window placement.

# UnknownALT 1.2.4

- Rebranded the UI, shortcuts, installers and application filenames as UnknownALT.
- Updates now includes formatted official announcement text, permitted images,
  source tabs, unread filters, cached articles and automatic refresh.
- The update window shows measured verification progress, white progress fill
  and recovery instructions when installation fails.
- Simplified Farm Control Center with a client overview and separate sections
  for warnings, recovery, performance, alerts, audio and storage.
- Added Roblox public game analytics, a local watchlist and player history, and
  read-only Roblox Open Cloud creator metrics with CSV export.

# UnknownALT 1.2.3

- In-app Windows EXE updates open a separate, centered progress window. It reports
  download and installer progress and stays open while UnknownALT restarts.
- Opening UnknownALT again during an update brings the progress window forward.

# UnknownALT 1.2.2

- Farm Control Center brings together managed-client problems, recovery actions,
  CPU and RAM readings, a priority account, session alerts and the audio mixer.
- Storage Dashboard measures app data, database, logs and encrypted snapshots.
  Cleanup targets cached results and rotated app logs.
- Updates shows UnknownALT release notes, Roblox release notes and DevForum
  announcements with filters and unread status. The pinned updater controls
  Windows EXE installation and progress.
- Added Windows MSIX packaging and native archive build targets for macOS and
  Linux. The GitHub release includes the Windows EXE. Store certification and
  native macOS/Linux builds are pending. See [platform builds](docs/PLATFORMS.md).

## Reliability improvements included in 1.2.2

- Treat unconfirmed client exits separately from confirmed crashes. Match Windows
  fault records to both process ID and creation time; require an associated crash
  handler log before treating a nearby dump as crash evidence.
- Give slow initial launches two minutes before showing a stalled-launch diagnosis.
  Keep their windows open and recover the displayed state if they finish loading.
- Smart Troubleshooter checks local installation/runtime, recent errors, launch
  state and resource/pause conditions. Safe repairs are explicit; reinstalling Roblox
  requires confirmation, an encrypted data snapshot and no running Roblox clients.
- Create verified encrypted local snapshots before built-in application updates,
  retaining the five newest completed snapshots. Failed backups stop that update.
  Manual snapshots are available in Settings > Data. No private data is uploaded.
- Pause All and Resume All suspend/resume management without closing or suspending
  Roblox processes. Individual Take control choices remain intact.
- Smart Launch Queue waits for CPU/RAM headroom, uses stable recovery thresholds,
  and supports cancellation while paused. Configure it in Settings > Launching.

See [local safeguards](docs/LOCAL-SAFEGUARDS.md) for recovery limits and the
isolated verification procedure. Windows
Authenticode signing remains separate from the existing owner-signed update feed.

# UnknownALT 1.2.0

Ported from inspectsoftware/RoALT through `59b027b`, retaining the MIT license and
upstream notices. UnknownALT keeps its independent application identity, custom
mascot, Brown factory accent, Discord community and verified owner-controlled
release channel. Original authenticated vault/backup markers remain only for data
compatibility; they are not release feeds or visible branding.

- First-run language, appearance, protection and account setup, with a four-view
  tour; replay at Settings > About > Setup and tour.
- Take control per client suspends automation, CPU management and layout, restores
  and focuses its window, and unmutes it. Give control back by unticking it.
- Off/1 FPS previews, bounded nonblocking capture, slower background work and
  Windows 10 change-driven drawing. Off is recommended for busy PCs.
- Managed-client quit question, tray option, lock/sleep master-vault protection
  with the documented automation exception and locked-session anti-AFK alerts.
- Discord ping severity and Rich Presence visibility, timer, buttons and two
  template lines supporting {game} and {count}.
- Running-client limits for all, group defaults with override clearing, additional
  Roblox share/invite targets and key-recording/clearing hotkey controls.
- Removed unused private-server ownership/purchase and friend-request interfaces;
  keep private link joining, private server listing, Limiteds, account befriending
  and Browse purchase lock. Clips, Trades and Outfits are absent.
- Restricted isolated sign-in profile, restricted Browse, expiring exports with a
  protected current-user-only directory, and cookie cleanup on quit.
- Serialized settings updates, background backup restoration and language-safe
  pending crash restarts. Corrected F13/minimized-client anti-AFK explanation.
- News, Donate, Upstream and their background/supporter feeds remain absent.
- Log messages are sanitized before writing to disk or the UI. Public commits use
  Unknown69511, the GitHub no-reply address and UTC dates.

Windows Authenticode signing is not enabled. A SignPath Foundation application is
pending review; the independent update manifest signature is a different mechanism.
See docs/BUILD.md for build, verification and release instructions.
