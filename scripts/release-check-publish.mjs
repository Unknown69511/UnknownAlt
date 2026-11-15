import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_NAME, SIGNATURE_NAME, assertReleaseAdvance, installerName, options, projectVersion, readChannel, validateManifest, verifyInstaller, verifyManifestSignature } from "./release-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const args = options(process.argv.slice(2));
  const channel = readChannel(root);
  const version = projectVersion(root);
  const repository = `${channel.owner}/${channel.repository}`;
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("This workflow does not belong to the configured release repository.");
  }
  const output = path.join(root, "dist-installer");
  const raw = fs.readFileSync(path.join(output, MANIFEST_NAME));
  if (!verifyManifestSignature(raw, fs.readFileSync(path.join(output, SIGNATURE_NAME), "utf8"), channel)) throw new Error("Release manifest signature is invalid.");
  const manifest = validateManifest(JSON.parse(raw.toString("utf8")), channel);
  if (manifest.version !== version || !verifyInstaller(fs.readFileSync(path.join(output, installerName(version))), manifest)) throw new Error("Release installer differs from the signed manifest.");
  if (args.get("--offline")) {
    console.log(`Local signed-asset verification passed for ${repository} v${version}. Before upload, verify ${channel.visibility} repository visibility and that this version has never been published.`);
    process.exit(0);
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Provide an owner-authorized GitHub token only to this LOCAL preflight, or use --offline and verify private repository/version in GitHub before manual upload. Never ship that token or add the signing key to an unprotected workflow.");
  const identity = await fetch("https://api.github.com/user", {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "UnknownAlt-Release" },
    redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  if (!identity.ok || (await identity.json()).login?.toLowerCase() !== channel.owner.toLowerCase()) throw new Error("Only the configured repository owner may pass the publication preflight.");
  const metadata = await fetch(`https://api.github.com/repos/${repository}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "UnknownAlt-Release" },
    redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  if (!metadata.ok || (await metadata.json()).private !== (channel.visibility === "private")) throw new Error("Refusing publication: repository visibility differs from the configured release channel.");
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "UnknownAlt-Release" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) assertReleaseAdvance(version, null);
  else {
    if (!response.ok) throw new Error(`GitHub latest-release check failed (${response.status}); publishing was stopped.`);
    assertReleaseAdvance(version, (await response.json()).tag_name);
  }
  console.log(`Release preflight passed for ${repository} v${version}; artifacts are signed and newer than the published latest release.`);
} catch (error) {
  console.error(`release-check-publish: ${error.message}`);
  process.exitCode = 1;
}
