# Unknown alt releases and updates

Source and installers are public at [Unknown69511/UnknownAlt](https://github.com/Unknown69511/UnknownAlt). Anyone can view the source and download a release. Public builds need no GitHub account, sign-in, access token or publisher credentials. Public source does not expose local accounts or grant repository write access.

## Trust and privacy

`src-tauri/update-channel.json` contains the owner/repository, stable channel, `visibility: "public"`, and the pinned P-256 public verification key. Public checks and downloads never load, refresh or send a saved GitHub credential. Old private connection files stay local and are ignored. Authentication code remains available for separately configured private builds.

Checks run on startup and hourly, including in the tray. **Update** is always visible beside **Refresh**. Clicking checks the release source, reports when no newer version exists, and otherwise runs the existing verified download/install/restart flow. Checks already in progress are awaited; duplicate clicks cannot start parallel installations. The bounded signed manifest binds `com.unknownalt.desktop`, stable Windows x64, exact owned-repository installer URL, version, size and SHA-256. A P-256/SHA-256 signature in 64-byte IEEE-P1363 encoding covers UTF-8 `UnknownAlt update manifest v1\n` followed by exact JSON bytes.

Only the configured repository and allowlisted GitHub HTTPS asset storage can serve updates. Public downloads still require valid signatures and hashes. A replaced release asset or repository collaborator cannot forge an update without the separate signing key. The original product's feed and key are never trusted.

## Owner-controlled release process

Keep the existing signing private key local and **outside this repository and CI**. Do not generate a replacement casually: installed clients trust the current key.

```powershell
node scripts/release-version.mjs 1.1.5
node scripts/release-configure.mjs --check
node scripts/release-test.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-update-helper.ps1
.\scripts\build-installer.ps1
node scripts/release-sign.mjs --key-file 'C:\YourPrivateFolder\UnknownAlt-update-signing.private.pem'
node scripts/release-check-publish.mjs --offline
```

Review and sign the exact final canonical installer locally. The signer rejects mismatched keys, source identities, filenames, sizes and versions. The offline preflight verifies signatures and bytes; separately verify the correct repository and unused version. Optional authenticated local preflight accepts an owner token only through the current process environment. Never embed that token in source or output.

Commit with a GitHub no-reply email. Create a matching `vX.Y.Z` tag and stable Latest release containing these unchanged files:

```text
UnknownAlt-Setup-X.Y.Z.exe
UnknownAlt-update.json
UnknownAlt-update.json.sig
SHA256SUMS.txt
```

Also publish `UnknownAlt-Setup-X.Y.Z-Windows-x64.exe` for first installations with the full offline Microsoft WebView2 prerequisite. This larger package is separate from the canonical updater installer, which stays below 200 MB. Never reuse a version or replace its signed assets; publish a higher version.

The owner-only release workflow builds unsigned candidates with read-only permissions. It never signs or publishes automatically. Public CI logs and artifacts must contain only clean source and generated app files. No personal profiles, credentials or signing material belong in workflows.

## Private-only client migration and recovery

Version 1.1.3 requires private repository visibility and cannot discover public releases. Install the public 1.1.4 or newer full installer once over that client after a clean quit. The independent AppId and encrypted-data compatibility remain unchanged. Back up the complete closed data directory first; do not rename or delete individual database keys.

Later public versions update without sign-in. Failed checks, invalid signatures and partial downloads leave the installed version usable. The transaction helper verifies complete application/data snapshots, waits for clean exit and restores the previous build/data if installation or uncommitted startup fails. A committed update does not roll back later data changes.

## Privacy before publication

Audit every branch, tag, commit author/committer/message, historical blob, release note and download. If history contains a personal email or private file, keep it private and publish a sanitized copy with fresh history. Use a GitHub no-reply email for new commits.

Exclude `.env`, accounts, cookies, passwords, session tokens, private keys, personal databases, private service configuration, logs, caches and browser profiles. Preserve required license notices. Inspect extracted binaries/installers for personal paths and build metadata. Build from neutral source/registry/target locations, remap Rust paths and follow `DISTRIBUTION.md`.
