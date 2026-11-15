# Maintainer privacy policy

Use the public alias Unknown69511 and GitHub no-reply email for commits.
Commit author and committer dates must use Pacific Time (PST/PDT). Local time offsets
can disclose regional information even when names and emails are private.
Set TZ=America/Los_Angeles when committing, or explicitly supply PST/PDT author/committer dates.
Browser-created commits may record the browser's timezone: run the owner-only
metadata normalization action after such edits, and verify the result.

Never commit accounts, sessions, cookies, credentials, personal configuration,
databases, logs, caches, local paths, machine identifiers, or signing keys.
Keep private backups outside the repository. Use neutral build directories
and the existing build-path remapping and release artifact privacy checks.
Inspect image metadata and packaged resources before publishing releases.
Preserve required third-party copyright and license notices.

History normalization changes commit IDs and removes invalidated commit
signatures, while preserving source trees, commit times and parent order.
Existing clones must be refreshed carefully; do not merge the old history
back into the cleaned branch. Published installer bytes and update signatures
remain unchanged unless an artifact itself requires a separately signed fix.

Rewriting refs cannot erase other people's downloads, clones, screenshots,
GitHub event records or cached/unreachable commit pages. Contact GitHub Support
when server-side removal is required. Revoke exposed credentials immediately;
deleting their text is not sufficient. Never post credential values in reports.
