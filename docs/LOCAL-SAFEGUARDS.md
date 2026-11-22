# Local safeguards

## Encrypted snapshots

The built-in Unknown alt updater creates a consistent encrypted database snapshot
after verifying the downloaded installer and before handing off installation.
An unsuccessful snapshot stops that update. No vault unlock is required: accounts
remain encrypted inside the encrypted database, and its key stays wrapped by
Windows DPAPI for the current Windows user. Reinstalling Roblox through Smart
Troubleshooter also requires a snapshot first.

Snapshots are kept in `%LOCALAPPDATA%\UnknownAlt-backups`, with an inherited
current-user-only access rule. Only the five newest completed snapshots are
retained. A new snapshot is verified and committed before older ones are pruned.
The active data location can be customized without moving this recovery folder.
Settings > Data > Automatic backups provides manual snapshots and opens the folder.

These local snapshots contain the database and its wrapped key, including accounts,
vault records, settings and saved app history. Treat them as private data. They do
not include browser profiles or the installed executable. They are not portable
to another Windows identity. Use the existing password-protected export when
moving to another PC or user. Do not include the snapshot folder in a distribution.

To recover, quit Unknown alt completely and rename the current complete data folder
aside so it stays available. Create an empty replacement at that same active data
path, then copy a snapshot's `UnknownAlt.db` and `UnknownAlt.db.key` into it together.
Start a compatible app version. Do not mix old WAL/SHM journals with restored data
or overwrite an open database. The automatic snapshot hook
covers the built-in updater; manually running a downloaded installer still requires
you to make a snapshot first in Settings > Data.

## Management and launch queue

Pause All stops managed automation and new launch admission; it leaves Roblox
processes and windows running and releases app-applied CPU/memory limits. Resume
All returns automation to the saved policy. Individual Take control choices and
manual per-client limit settings are preserved. Pause state survives app restarts.

Smart Launch Queue measures system CPU and RAM before starting a client and again
before using a launch ticket. Defaults pause at 90% CPU or RAM, or below 512 MB
available RAM. Recovery needs two healthy samples at least 10 CPU percentage points
and 5 RAM percentage points below the selected thresholds, with 768 MB free RAM.
Unavailable readings hold admission with an explanation. Existing clients are never
closed to free resources. Thresholds and the resource guard are configurable in
Settings > Launching. Pending launches can be cancelled without resuming automation.

## Diagnosis and isolated verification

Smart Troubleshooter automatically checks local runtime/launcher detection, recent
typed errors, tracked client state, crash evidence, network policy and launch queue
conditions. It shows the evidence and suggested next steps. A connection error is
not enough to infer the exact network cause; an exit is not enough to prove a crash.
No diagnostic data is uploaded. Safe fixes rescan, cancel pending launches, or
retry configured automation. Roblox reinstallation requires confirmation, a backup
and no running Roblox clients. It never deletes or resets the account vault.

Run `npm run build`, `node scripts/release-test.mjs`, the native suite and
`scripts/test-update-helper.ps1` in isolated fixtures. Native regression coverage
includes slow starts, process-identity fault matching, pause/control semantics,
resource admission/cancellation, repair confirmation and encrypted retention/restore.
Hardware-dependent tests stay ignored unless a suitable disposable environment is
explicitly authorized. Never point tests at real account data or existing sessions.
