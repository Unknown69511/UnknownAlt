# Unknown alt 1.2.2

- Farm Control Center brings together managed-client problems, recovery actions,
  CPU and RAM readings, a priority account, session alerts and the audio mixer.
- Storage Dashboard measures app data, database, logs and encrypted snapshots.
  Cleanup targets cached results and rotated app logs.
- Updates shows Unknown alt release notes, Roblox release notes and DevForum
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

# Unknown alt 1.2.0

Ported from inspectsoftware/RoALT through `59b027b`, retaining the MIT license and
upstream notices. UnknownAlt keeps its independent application identity, custom
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
