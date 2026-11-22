import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { MANIFEST_NAME, SIGNATURE_NAME, brandedInstallerName, createManifest, installerName, manifestBytes, options, projectVersion, readChannel, signManifest, signingKey, verifyManifestSignature } from "./release-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const args = options(process.argv.slice(2));
  const channel = readChannel(root, args.get("--channel") || "src-tauri/update-channel.json");
  const version = projectVersion(root);
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY.toLowerCase() !== `${channel.owner}/${channel.repository}`.toLowerCase()) throw new Error("This workflow is not running in the configured owner's release repository.");
  const installer = path.resolve(root, args.get("--installer") || `dist-installer/${brandedInstallerName(version)}`);
  if (![installerName(version), brandedInstallerName(version)].includes(path.basename(installer))) throw new Error("Installer must have the UnknownALT versioned filename.");
  const bytes = fs.readFileSync(installer);
  const manifest = createManifest(channel, version, installerName(version), bytes);
  const raw = manifestBytes(manifest);
  const key = signingKey(args.get("--key-file") ? fs.readFileSync(path.resolve(root, args.get("--key-file")), "utf8") : process.env.UNKNOWNALT_UPDATE_PRIVATE_KEY, channel);
  const signature = signManifest(raw, key);
  if (!verifyManifestSignature(raw, signature, channel)) throw new Error("Self-verification failed; no release was produced.");
  const output = path.resolve(root, args.get("--out") || "dist-installer");
  fs.mkdirSync(output, { recursive: true });
  // Keep the case-only compatibility alias in a separate directory on Windows.
  fs.mkdirSync(path.join(output, "compat"), { recursive: true });
  fs.writeFileSync(path.join(output, "compat", installerName(version)), bytes);
  fs.writeFileSync(path.join(output, MANIFEST_NAME), raw);
  fs.writeFileSync(path.join(output, SIGNATURE_NAME), `${signature}\n`, "utf8");
  const sigBytes = Buffer.from(`${signature}\n`, "utf8");
  fs.writeFileSync(path.join(output, "SHA256SUMS.txt"), [
    `${manifest.installer.sha256}  ${manifest.installer.fileName}`,
    `${crypto.createHash("sha256").update(raw).digest("hex")}  ${MANIFEST_NAME}`,
    `${crypto.createHash("sha256").update(sigBytes).digest("hex")}  ${SIGNATURE_NAME}`,
    "",
  ].join("\n"), "utf8");
  console.log(`Signed UnknownAlt ${version}: ${MANIFEST_NAME}, ${SIGNATURE_NAME}. Installer SHA-256: ${manifest.installer.sha256}`);
} catch (error) {
  console.error(`release-sign: ${error.message}`);
  process.exitCode = 1;
}
