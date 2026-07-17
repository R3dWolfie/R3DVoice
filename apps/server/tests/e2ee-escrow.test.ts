import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTestApp } from "./helpers/app.js";
import { registerUser, authHeader, resetDb, type RegisteredUser } from "./helpers/fixtures.js";
import { disconnectDb } from "./helpers/db.js";

describe("E2EE key escrow (hybrid)", () => {
  let app: FastifyInstance;
  let user: RegisteredUser;

  beforeEach(async () => {
    await resetDb();
    app = await makeTestApp();
    user = await registerUser(app, { email: "escrow@test.local" });
  });
  afterEach(async () => {
    if (app) await app.close();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("returns wrapped:null before anything is escrowed", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/e2ee/wrapped-key", headers: authHeader(user.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().wrapped).toBeNull();
  });

  it("stores and returns the wrapped blob for the owner", async () => {
    const blob = { wrapped: "d3JhcHBlZA==", salt: "c2FsdA==", nonce: "bm9uY2U=" };
    const put = await app.inject({
      method: "PUT",
      url: "/auth/e2ee/wrapped-key",
      headers: authHeader(user.token),
      payload: blob,
    });
    expect(put.statusCode).toBe(204);

    const get = await app.inject({ method: "GET", url: "/auth/e2ee/wrapped-key", headers: authHeader(user.token) });
    expect(get.json()).toEqual(blob);
  });

  it("is per-user — another account can't read the blob", async () => {
    await app.inject({
      method: "PUT",
      url: "/auth/e2ee/wrapped-key",
      headers: authHeader(user.token),
      payload: { wrapped: "aaa", salt: "bbb", nonce: "ccc" },
    });
    const other = await registerUser(app, { email: "other@test.local" });
    const get = await app.inject({ method: "GET", url: "/auth/e2ee/wrapped-key", headers: authHeader(other.token) });
    expect(get.json().wrapped).toBeNull();
  });

  it("requires auth", async () => {
    expect((await app.inject({ method: "GET", url: "/auth/e2ee/wrapped-key" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "PUT", url: "/auth/e2ee/wrapped-key", payload: { wrapped: "a", salt: "b", nonce: "c" } }))
        .statusCode,
    ).toBe(401);
  });

  it("rejects a malformed blob", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/auth/e2ee/wrapped-key",
      headers: authHeader(user.token),
      payload: { wrapped: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});
