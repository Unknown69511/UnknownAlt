# Unknown alt — branding and compatibility

The app's human-readable name is **Unknown alt**. Internal identifiers and new files use **UnknownAlt**, with application identity `com.unknownalt.desktop`. The existing coffee mascot remains the app icon. Brown is the factory accent. Other palettes and layouts remain available. Donate, News and Upstream UI/routes are removed.

## Data preservation

Version 1.1.3 introduces `UnknownAlt.db`, `UnknownAlt.db.key`, `UnknownAlt.db-wal` and `UnknownAlt.db-shm`. Old database basenames are moved together only after the previous process has closed, using a persistent resumable journal, write-through moves and no replacement of unexpected target files. The encrypted contents and wrapped key bytes stay unchanged. Custom data locations remain supported. A bare older executable is not a safe downgrade after filename migration; restore the complete matching pre-upgrade application and data snapshot.

Browser preference keys migrate to `UnknownAlt.*` with legacy read fallbacks. New splash/global identifiers, temporary files and cleanup markers use UnknownAlt. Older markers and shared profiles remain readable. New backup magic is `UNALTBK1`; the old encrypted-backup magic and `.roalt` import extension remain accepted. New performance exports use UnknownAlt formats; legacy readers remain for saved/shared profiles.

DPAPI entropy and authenticated-encryption AAD are compatibility inputs, not visible branding. The legacy values (`RoALT/db/v1`, `RoALT/vault/v1`, `roalt.cookie:{user_id}`, `roalt.vault.key`, `roalt.vault.recovery`, `roalt.favourite`, `roalt.discord.webhook`) are intentionally retained where needed to decrypt existing data. Replacing those bytes blindly would make saved secrets unreadable. Tests verify SQLCipher/DPAPI vault/account/settings preservation across filename migration.

## Public releases

Source and release assets are public in `Unknown69511/UnknownAlt`. Public builds need no GitHub login and never load or transmit old update credentials. Only the pinned public verification key is included. The owner signs locally, outside source/history/CI. See `docs/UPDATES.md`.

The independent installer AppId remains `{25C70510-83BD-4A26-B6AA-7D831FC934F3}`. Original-product release sources and signing trust are rejected. Private-only 1.1.3 clients need one manual installation of public 1.1.4; later public releases use the same pinned key and encrypted-data compatibility.

## External ownership and attribution

Discord Rich Presence's registered application name, application ID and remote artwork belong to an external Developer Application. They cannot be renamed locally. Existing presence behavior and genuine external community endpoints remain intact; a fully owned Discord presence needs an owned Discord Developer Application ID and uploaded artwork. The top Discord invite and local release buttons use the owner's specified destinations.

The base was [inspectsoftware/RoALT v1.1.0](https://github.com/inspectsoftware/RoALT/tree/d16b3e277ce24859a5159354a6f289891b09fe2f), commit `d16b3e277ce24859a5159354a6f289891b09fe2f`. Copyright (c) 2026 inspectsoftware; the MIT license is retained. Unused original documentation, screenshots and publishing archives are removed from the active project. Remaining original-name references are reviewed compatibility/provenance/external-contract or negative-security-test literals, not active app branding.
