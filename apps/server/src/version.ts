import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The server's own build version, published to clients via /health as
 * `latestClientVersion`. The ambient in-app "update available" affordance
 * compares it against the running client's APP_VERSION - unlike
 * MIN_CLIENT_VERSION (a blocking floor), this is purely informational.
 *
 * Prefer the npm/pnpm-provided env var; fall back to reading the packaged
 * manifest. package.json sits one directory above this module whether we run
 * from `src` via tsx (src/version.ts) or the compiled build (dist/version.js),
 * so a single `../package.json` resolves in both.
 */
function readServerVersion(): string {
  const fromEnv = process.env["npm_package_version"];
  if (fromEnv) return fromEnv;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const SERVER_VERSION = readServerVersion();
