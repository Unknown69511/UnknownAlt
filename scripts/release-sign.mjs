import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { MANIFEST_NAME, SIGNATURE_NAME, createManifest, installerName, manifestBytes, options, projectVersion, readChannel, signManifest, signingKey, verifyManifestSignature } from "./release-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const args = options(process.argv.slice(2));
  const channel = readChannel(root, args.get("--channel") || "src-tauri/update-channel.json");
  const version = projectVersion(root);
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY.toLowerCase() !== `${channel.owner}/${channel.repository}`.toLowerCase()) throw new Error("This workflow is not running in the configured owner's release repository.");
  const installer = path.resolve(root, args.get("--installer") || `dist-installer/${installerName(version)}`);
  if (path.basename(installer) !== installerName(version)) throw new Error("Installer must have the exact UnknownAlt versioned filename.");
  const bytes = fs.readFileSync(installer);
  const manifest = createManifest(channel, version, path.basename(installer), bytes);
  const raw = manifestBytes(manifest);
  const key = signingKey(args.get("--key-file") ? fs.readFileSync(path.resolve(root, args.get("--key-file")), "utf8") : process.env.UNKNOWNALT_UPDATE_PRIVATE_KEY, channel);
  const signature = signManifest(raw, key);
  if (!verifyManifestSignature(raw, signature, channel)) throw new Error("Self-verification failed; no release was produced.");
  const output = path.resolve(root, args.get("--out") || "dist-installer");
  fs.mkdirSync(output, { recursive: true });
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
