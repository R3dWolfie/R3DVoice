import { describe, it, expect, afterEach } from "vitest";
import { makeTestApp } from "./helpers/app.js";
import type { FastifyInstance } from "fastify";

describe("GET /health", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns status ok", async () => {
    app = await makeTestApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    // Also carries the required-update floor for the client version gate.
    expect(res.json()).toEqual({ status: "ok", minClientVersion: "0.0.0" });
  });
});
