import { describe, it, expect, afterEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTestApp } from "./helpers/app.js";
import { createTestUser } from "./helpers/fixtures.js";
import { disconnectDb } from "./helpers/db.js";

async function login(app: FastifyInstance, email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password },
  });
  return res.json().token;
}

describe("GET /me and POST /auth/logout", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("GET /me returns the current user", async () => {
    app = await makeTestApp();
    const user = await createTestUser();
    const token = await login(app, user.email, user.password);
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      handle: null,
      avatarUrl: null,
      dndUntil: null,
      emailVerified: true,
      totpEnabled: false,
      hasE2eeKey: false,
    });
  });

  it("POST /auth/logout revokes the session so subsequent /me 401s", async () => {
    app = await makeTestApp();
    const user = await createTestUser();
    const token = await login(app, user.email, user.password);

    const out = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(out.statusCode).toBe(204);

    const me = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(401);
  });
});
