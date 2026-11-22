import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { options, projectVersion, validateChannel } from "./release-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "src-tauri/update-channel.json");
try {
  const args = options(process.argv.slice(2));
  const old = JSON.parse(fs.readFileSync(file, "utf8"));
  const next = {
    schemaVersion: 1,
    owner: args.get("--owner") || old.owner,
    repository: args.get("--repository") || old.repository,
    channel: "stable",
    publicKeyP256: args.get("--public-key") || old.publicKeyP256,
    visibility: args.get("--visibility") || old.visibility || "public",
    githubAppClientId: args.get("--github-app-client-id") || old.githubAppClientId || "",
  };
  if (old.publicKeyP256 && next.publicKeyP256 !== old.publicKeyP256) throw new Error("Do not replace the signing trust key. Existing installations require a planned signed key migration.");
  validateChannel(next);
  if (next.visibility === "private" && !next.githubAppClientId) throw new Error("Private update releases require the registered read-only GitHub App public client ID.");
  if (process.env.GITHUB_REPOSITORY && `${next.owner}/${next.repository}`.toLowerCase() !== process.env.GITHUB_REPOSITORY.toLowerCase()) throw new Error("Configured release source must be this workflow's repository.");
  if (args.get("--check")) {
    console.log(`UnknownALT ${projectVersion(root)} ${next.visibility.toUpperCase()} release channel: ${next.owner}/${next.repository} (stable). ${next.visibility === "public" ? "No login or embedded credentials required." : "GitHub App configured."}`);
  } else {
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log(`Configured ${next.owner}/${next.repository}. Rebuild and distribute the configured bootstrap version before publishing updates.`);
  }
} catch (error) {
  console.error(`release-configure: ${error.message}`);
  process.exitCode = 1;
}
