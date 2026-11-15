import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { APP_ID, MANIFEST_NAME, SIGNATURE_NAME, assertReleaseAdvance, createManifest, installerName, manifestBytes, newerVersion, projectVersion, publicHex, setProjectVersion, signManifest, signingKey, stableVersion, validateChannel, validateManifest, verifyInstaller, verifyManifestSignature } from "./release-lib.mjs";

const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const key = privateKey.export({ type: "pkcs8", format: "pem" });
const channel = { schemaVersion: 1, owner: "UnknownAltTests", repository: "UnknownAlt", channel: "stable", publicKeyP256: publicHex(privateKey) };
const payload = Buffer.from("UnknownAlt updater conformance test payload\n", "utf8");
const manifest = createManifest(channel, "9.8.7", installerName("9.8.7"), payload);
const raw = manifestBytes(manifest);
const signature = signManifest(raw, signingKey(key, channel));

assert.equal(validateChannel(channel).owner, "UnknownAltTests");
assert.equal(validateChannel(channel).visibility, "public");
assert.equal(validateChannel({ ...channel, visibility: "private" }).visibility, "private");
assert.throws(() => validateChannel({ ...channel, visibility: "unknown" }));
assert.throws(() => validateChannel({ ...channel, githubAppClientId: "ghp_not_a_public_client_id" }));
assert.equal(validateChannel({ ...channel, githubAppClientId: "Iv23liSyntheticPublicId" }).githubAppClientId, "Iv23liSyntheticPublicId");
assert.equal(validateManifest(manifest, channel).appId, APP_ID);
assert.equal(verifyManifestSignature(raw, signature, channel), true);
assert.equal(verifyInstaller(payload, manifest), true);
assert.equal(verifyManifestSignature(Buffer.concat([raw, Buffer.from(" ")]), signature, channel), false, "exact raw bytes are authenticated");
const changed = Buffer.from(raw); changed[15] ^= 1;
assert.equal(verifyManifestSignature(changed, signature, channel), false);
const damagedSignature = Buffer.from(signature, "base64"); damagedSignature[12] ^= 1;
assert.equal(verifyManifestSignature(raw, damagedSignature.toString("base64"), channel), false);
const other = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
assert.throws(() => signingKey(other.privateKey.export({ type: "pkcs8", format: "pem" }), channel), /does not match/);
assert.equal(verifyManifestSignature(raw, signature, { ...channel, publicKeyP256: publicHex(other.privateKey) }), false);
const wrongDomain = crypto.sign("sha256", raw, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
assert.equal(verifyManifestSignature(raw, wrongDomain, channel), false, "a signature without UnknownAlt's domain prefix is rejected");
assert.equal(verifyManifestSignature(raw, "!!", channel), false);
assert.equal(verifyInstaller(Buffer.concat([payload, Buffer.from("extra")]), manifest), false);
const modifiedPayload = Buffer.from(payload); modifiedPayload[0] ^= 1;
assert.equal(verifyInstaller(modifiedPayload, manifest), false);
assert.throws(() => validateManifest({ ...manifest, appId: "com.inspectsoftware.roalt" }, channel));
assert.throws(() => validateManifest({ ...manifest, channel: "beta" }, channel));
assert.throws(() => validateManifest({ ...manifest, platform: "windows-arm64" }, channel));
for (const installer of [
  { ...manifest.installer, fileName: "RoALT-Setup-9.8.7.exe" },
  { ...manifest.installer, url: manifest.installer.url.replace("UnknownAltTests/UnknownAlt", "inspectsoftware/RoALT") },
  { ...manifest.installer, url: manifest.installer.url.replace("https:", "http:") },
  { ...manifest.installer, url: manifest.installer.url + "?other=true" },
  { ...manifest.installer, url: "https://github.com/attacker/UnknownAlt/releases/download/v9.8.7/UnknownAlt-Setup-9.8.7.exe" },
  { ...manifest.installer, sha256: "not-a-hash" },
  { ...manifest.installer, size: -1 },
  { ...manifest.installer, size: 200_000_001 },
]) assert.throws(() => validateManifest({ ...manifest, installer }, channel));
for (const owner of ["inspectsoftware", "INSPECTSOFTWARE", "../attacker", "bad/name"]) assert.throws(() => validateChannel({ ...channel, owner }));
for (const repository of ["RoALT", "rOaLt", "../UnknownAlt", "repo?url=evil"]) assert.throws(() => validateChannel({ ...channel, repository }));
assert.throws(() => validateChannel({ ...channel, owner: "", repository: "" }));
assert.throws(() => validateChannel({ ...channel, publicKeyP256: "" }));
for (const version of ["1.0", "v1.2.3", "01.2.3", "1.2.3-beta.1", "1.2.3+meta", "1.2.9999999999", "1.2.-1"]) assert.throws(() => stableVersion(version));
assert.equal(newerVersion("1.1.1", "1.1.0"), true);
assert.equal(newerVersion("2.0.0", "1.999.999"), true);
assert.equal(newerVersion("1.1.0", "1.1.0"), false);
assert.equal(newerVersion("1.0.9", "1.1.0"), false);
assert.doesNotThrow(() => assertReleaseAdvance("1.1.1", "v1.1.0"));
assert.doesNotThrow(() => assertReleaseAdvance("1.1.0", null));
assert.throws(() => assertReleaseAdvance("1.1.0", "v1.1.0"));
assert.throws(() => assertReleaseAdvance("1.1.0", "v2.0.0"));
assert.throws(() => assertReleaseAdvance("1.1.0", "latest"));

// Exercise the publisher CLI and all version metadata in a task-local scratch directory.
// No real project version or production key is changed by these tests.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = path.resolve(root, "..");
const temp = fs.mkdtempSync(path.join(tempRoot, "release-tests-"));
try {
  const version = projectVersion(root);
  const input = path.join(temp, installerName(version));
  const channelFile = path.join(temp, "channel.json");
  const output = path.join(temp, "signed");
  fs.writeFileSync(input, payload);
  fs.writeFileSync(channelFile, JSON.stringify(channel));
  const run = (pem, out) => spawnSync(process.execPath, [path.join(root, "scripts/release-sign.mjs"), "--channel", channelFile, "--installer", input, "--out", out], {
    encoding: "utf8", env: { ...process.env, UNKNOWNALT_UPDATE_PRIVATE_KEY: pem, GITHUB_REPOSITORY: `${channel.owner}/${channel.repository}` },
  });
  const signed = run(key, output);
  assert.equal(signed.status, 0, signed.stderr);
  const published = fs.readFileSync(path.join(output, MANIFEST_NAME));
  const parsed = validateManifest(JSON.parse(published), channel);
  assert.equal(parsed.version, version);
  assert.equal(verifyManifestSignature(published, fs.readFileSync(path.join(output, SIGNATURE_NAME), "utf8"), channel), true);
  assert.equal(verifyInstaller(payload, parsed), true);
  const refused = run(other.privateKey.export({ type: "pkcs8", format: "pem" }), path.join(temp, "refused"));
  assert.notEqual(refused.status, 0);
  assert.equal(fs.existsSync(path.join(temp, "refused", SIGNATURE_NAME)), false);

  const fixture = path.join(temp, "version-project");
  fs.mkdirSync(path.join(fixture, "src-tauri"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "unknownalt", version: "1.0.0" }));
  fs.writeFileSync(path.join(fixture, "package-lock.json"), JSON.stringify({ name: "unknownalt", version: "1.0.0", packages: { "": { version: "1.0.0" }, "node_modules/other": { version: "1.9.9" } } }));
  fs.writeFileSync(path.join(fixture, "src-tauri/tauri.conf.json"), JSON.stringify({ productName: "UnknownAlt", version: "1.0.0" }));
  fs.writeFileSync(path.join(fixture, "src-tauri/Cargo.toml"), '[package]\nname = "unknownalt"\nversion = "1.0.0"\n\n[dependencies]\nother = "1.9.9"\n');
  fs.writeFileSync(path.join(fixture, "src-tauri/Cargo.lock"), 'version = 4\n\n[[package]]\nname = "other"\nversion = "1.9.9"\n\n[[package]]\nname = "unknownalt"\nversion = "1.0.0"\n');
  assert.equal(setProjectVersion(fixture, "1.2.3"), "1.0.0");
  assert.equal(projectVersion(fixture), "1.2.3");
  assert.match(fs.readFileSync(path.join(fixture, "src-tauri/Cargo.lock"), "utf8"), /name = "other"\nversion = "1.9.9"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, "package-lock.json"))).packages["node_modules/other"].version, "1.9.9");
  assert.throws(() => setProjectVersion(fixture, "1.2.3"));
  assert.throws(() => setProjectVersion(fixture, "1.2.2"));
  const damaged = JSON.parse(fs.readFileSync(path.join(fixture, "package.json"))); damaged.version = "1.2.4";
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify(damaged));
  assert.throws(() => projectVersion(fixture));
} finally {
  const resolved = fs.realpathSync(temp);
  if (path.dirname(resolved) !== fs.realpathSync(tempRoot) || !path.basename(resolved).startsWith("release-tests-")) throw new Error("Refusing an unexpected test cleanup path.");
  fs.rmSync(resolved, { recursive: true, force: true });
}

if (process.argv[2] === "--write-fixture") {
  if (!process.argv[3]) throw new Error("Provide a fixture output directory.");
  const dir = path.resolve(process.argv[3]);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "channel.json"), `${JSON.stringify(channel, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), raw);
  fs.writeFileSync(path.join(dir, SIGNATURE_NAME), `${signature}\n`);
  fs.writeFileSync(path.join(dir, "installer.bin"), payload);
  // Only the public key, manifest, signature and harmless bytes are written. The generated
  // test private key is never persisted or printed and cannot sign future production updates.
  console.log(`Wrote public conformance fixtures to ${dir}.`);
}
console.log("UnknownAlt release checks passed: owner/repository pinning, stable versions, domain-separated signatures, key match, tampering, payload hash/size and fail-closed configuration.");
