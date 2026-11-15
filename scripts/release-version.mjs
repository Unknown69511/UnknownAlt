import path from "node:path";
import { fileURLToPath } from "node:url";
import { setProjectVersion, stableVersion } from "./release-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/release-version.mjs X.Y.Z");
  const next = stableVersion(process.argv[2]);
  const current = setProjectVersion(root, next);
  console.log(`Updated all package, lockfile, Cargo and Tauri version fields: ${current} -> ${next}. Review and commit before tagging v${next}.`);
} catch (error) {
  console.error(`release-version: ${error.message}`);
  process.exitCode = 1;
}
