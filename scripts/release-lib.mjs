import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const APP_ID = "com.unknownalt.desktop";
export const PLATFORM = "windows-x86_64";
export const MANIFEST_NAME = "UnknownAlt-update.json";
export const SIGNATURE_NAME = `${MANIFEST_NAME}.sig`;
export const SIGNING_PREFIX = Buffer.from("UnknownAlt update manifest v1\n", "utf8");
export const MAX_INSTALLER = 200_000_000;

export function stableVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value)) {
    throw new Error("Version must be stable X.Y.Z, without leading zeros or a prerelease suffix.");
  }
  return value;
}

export function newerVersion(next, current) {
  const a = stableVersion(next).split(".").map(BigInt);
  const b = stableVersion(current).split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function validateChannel(input, { configured = true } = {}) {
  if (!input || input.schemaVersion !== 1 || input.channel !== "stable") throw new Error("Unsupported update channel configuration.");
  const { owner, repository, publicKeyP256 } = input;
  const visibility = input.visibility ?? "public";
  const githubAppClientId = input.githubAppClientId ?? "";
  if (!["public", "private"].includes(visibility)) throw new Error("Release visibility must be public or private.");
  if (typeof githubAppClientId !== "string" || (githubAppClientId && !/^Iv[A-Za-z0-9._-]{8,126}$/.test(githubAppClientId))) throw new Error("Configure only the public GitHub App client ID, never a GitHub token or client secret.");
  if (typeof owner !== "string" || typeof repository !== "string" || typeof publicKeyP256 !== "string") throw new Error("Update channel fields must be strings.");
  if (owner.toLowerCase() === "inspectsoftware" || repository.toLowerCase() === "roalt") throw new Error("RoALT/inspectsoftware release sources are forbidden for UnknownAlt.");
  if (configured || owner || repository) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repository)) {
      throw new Error("Set a valid owner and repository in src-tauri/update-channel.json before publishing.");
    }
  }
  if (configured || publicKeyP256) {
    if (!/^[0-9a-f]{128}$/.test(publicKeyP256)) throw new Error("publicKeyP256 must be the pinned 128-character lowercase P-256 X/Y public key.");
    publicKey(publicKeyP256);
  }
  return { schemaVersion: 1, owner, repository, channel: "stable", publicKeyP256, visibility, githubAppClientId };
}

export function publicKey(hex) {
  if (!/^[0-9a-f]{128}$/.test(hex)) throw new Error("Invalid P-256 public key.");
  const xy = Buffer.from(hex, "hex");
  try {
    return crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: xy.subarray(0, 32).toString("base64url"), y: xy.subarray(32).toString("base64url") }, format: "jwk" });
  } catch {
    throw new Error("The configured P-256 public key is invalid.");
  }
}

export function publicHex(key) {
  const jwk = (key?.type === "public" ? key : crypto.createPublicKey(key)).export({ format: "jwk" });
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") throw new Error("The release signing key must use the P-256 curve.");
  const xy = Buffer.concat([Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  if (xy.length !== 64) throw new Error("Invalid P-256 public key coordinates.");
  return xy.toString("hex");
}

export function signingKey(pem, channel) {
  if (!pem) throw new Error("UNKNOWNALT_UPDATE_PRIVATE_KEY is missing; configure the release secret or --key-file.");
  let key;
  try { key = crypto.createPrivateKey(pem); } catch { throw new Error("Signing key is not a valid P-256 PEM private key."); }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("The release signing key must use the P-256 curve.");
  if (publicHex(key) !== channel.publicKeyP256) throw new Error("Signing key does not match publicKeyP256. Existing installations would reject this update.");
  return key;
}

export const installerName = version => `UnknownAlt-Setup-${stableVersion(version)}.exe`;
// The signed updater filename is part of the v1 protocol checked by installed versions.
export const brandedInstallerName = version => `UnknownALT-Setup-${stableVersion(version)}.exe`;
export function releaseUrl(channel, version, fileName = installerName(version)) {
  validateChannel(channel);
  return `https://github.com/${channel.owner}/${channel.repository}/releases/download/v${stableVersion(version)}/${fileName}`;
}

export function createManifest(channel, version, fileName, bytes) {
  validateChannel(channel);
  stableVersion(version);
  if (fileName !== installerName(version)) throw new Error("Installer filename does not match the UnknownAlt version.");
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_INSTALLER) throw new Error(`Installer must be 1..${MAX_INSTALLER} bytes.`);
  return {
    schemaVersion: 1,
    appId: APP_ID,
    channel: "stable",
    version,
    platform: PLATFORM,
    installer: {
      fileName,
      url: releaseUrl(channel, version, fileName),
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    },
  };
}

export const manifestBytes = manifest => Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
export const signedBytes = bytes => Buffer.concat([SIGNING_PREFIX, bytes]);

export function signManifest(bytes, key) {
  return crypto.sign("sha256", signedBytes(bytes), { key, dsaEncoding: "ieee-p1363" }).toString("base64");
}

export function verifyManifestSignature(bytes, signature, channel) {
  try {
    validateChannel(channel);
    if (typeof signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signature.trim())) return false;
    const sig = Buffer.from(signature.trim(), "base64");
    return sig.length === 64 && crypto.verify("sha256", signedBytes(bytes), { key: publicKey(channel.publicKeyP256), dsaEncoding: "ieee-p1363" }, sig);
  } catch { return false; }
}

export function validateManifest(manifest, channel) {
  validateChannel(channel);
  if (!manifest || manifest.schemaVersion !== 1 || manifest.appId !== APP_ID || manifest.channel !== "stable" || manifest.platform !== PLATFORM) throw new Error("Manifest is not for UnknownAlt stable Windows x64.");
  const version = stableVersion(manifest.version);
  const i = manifest.installer;
  if (!i || i.fileName !== installerName(version) || i.url !== releaseUrl(channel, version)) throw new Error("Manifest installer is not from the configured UnknownAlt release source.");
  if (!/^[0-9a-f]{64}$/.test(i.sha256) || !Number.isSafeInteger(i.size) || i.size < 1 || i.size > MAX_INSTALLER) throw new Error("Manifest installer size/hash is invalid.");
  return manifest;
}

export function verifyInstaller(bytes, manifest) {
  return Buffer.isBuffer(bytes) && bytes.length === manifest.installer.size && crypto.createHash("sha256").update(bytes).digest("hex") === manifest.installer.sha256;
}

export function projectVersion(root) {
  const json = p => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
  const pkg = json("package.json"), lock = json("package-lock.json"), tauri = json("src-tauri/tauri.conf.json");
  const cargo = fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8").match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
  const cargoLock = fs.readFileSync(path.join(root, "src-tauri/Cargo.lock"), "utf8").match(/\[\[package\]\]\r?\nname = "unknownalt"\r?\nversion = "([^"]+)"/)?.[1];
  const versions = [pkg.version, lock.version, lock.packages?.[""]?.version, tauri.version, cargo, cargoLock];
  if (!versions.every(v => v === versions[0])) throw new Error("Version fields disagree in package/Cargo/Tauri metadata. Run release-version.mjs first.");
  return stableVersion(versions[0]);
}

export function readChannel(root, file = "src-tauri/update-channel.json") {
  return validateChannel(JSON.parse(fs.readFileSync(path.resolve(root, file), "utf8")));
}

export function setProjectVersion(root, next) {
  stableVersion(next);
  const current = projectVersion(root);
  if (!newerVersion(next, current)) throw new Error(`New version must be greater than ${current}.`);
  const updates = new Map();
  for (const file of ["package.json", "package-lock.json", "src-tauri/tauri.conf.json"]) {
    const value = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    value.version = next;
    if (file === "package-lock.json") value.packages[""].version = next;
    updates.set(file, `${JSON.stringify(value, null, 2)}\n`);
  }
  const toml = fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");
  updates.set("src-tauri/Cargo.toml", toml.replace(/(\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m, `$1"${next}"`));
  const lock = fs.readFileSync(path.join(root, "src-tauri/Cargo.lock"), "utf8");
  updates.set("src-tauri/Cargo.lock", lock.replace(/(\[\[package\]\]\r?\nname = "unknownalt"\r?\nversion = )"[^"]+"/, `$1"${next}"`));
  const previous = new Map([...updates.keys()].map(file => [file, fs.readFileSync(path.join(root, file))]));
  try {
    for (const [file, data] of updates) fs.writeFileSync(path.join(root, file), data);
    if (projectVersion(root) !== next) throw new Error("Version verification failed.");
  } catch (error) {
    for (const [file, data] of previous) fs.writeFileSync(path.join(root, file), data);
    throw error;
  }
  return current;
}

export function assertReleaseAdvance(next, latestTag) {
  stableVersion(next);
  if (latestTag === null) return;
  if (typeof latestTag !== "string" || !latestTag.startsWith("v")) throw new Error("Existing latest release has an unexpected tag; review it before publishing.");
  if (!newerVersion(next, latestTag.slice(1))) throw new Error(`Release version ${next} must be newer than ${latestTag}. Published updates cannot be replaced or downgraded.`);
}

export function options(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--") || args.has(argv[i])) throw new Error("Use unique --option value arguments.");
    const key = argv[i];
    if (argv[i + 1] && !argv[i + 1].startsWith("--")) args.set(key, argv[++i]);
    else args.set(key, true);
  }
  return args;
}
