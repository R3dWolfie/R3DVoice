import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { makeTestApp } from "./helpers/app.js";
import type { FastifyInstance } from "fastify";

// Mirror version.ts: the server publishes its own package version as
// `latestClientVersion`, so assert against the real manifest (bump-proof).
const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { version: string };
const serverVersion = process.env["npm_package_version"] ?? pkg.version;

describe("GET /health", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns status ok", async () => {
    app = await makeTestApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    // Carries the required-update floor (minClientVersion) plus the server's
    // own build version (latestClientVersion) for the ambient update button.
    expect(res.json()).toEqual({
      status: "ok",
      minClientVersion: "0.0.0",
      latestClientVersion: serverVersion,
    });
  });
});
