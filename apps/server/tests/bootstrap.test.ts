import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTestApp } from "./helpers/app.js";
import { registerUser, authHeader, resetDb, type RegisteredUser } from "./helpers/fixtures.js";
import { disconnectDb } from "./helpers/db.js";

describe("GET /bootstrap (READY payload)", () => {
  let app: FastifyInstance;
  let user: RegisteredUser;

  beforeEach(async () => {
    await resetDb();
    app = await makeTestApp();
    user = await registerUser(app, { email: "ready@test.local" });
  });
  afterEach(async () => {
    if (app) await app.close();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("returns all six sections in one round trip", async () => {
    await app.inject({
      method: "POST",
      url: "/rooms",
      headers: authHeader(user.token),
      payload: { name: "Ready Room" },
    });
    const res = await app.inject({ method: "GET", url: "/bootstrap", headers: authHeader(user.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.me.id).toBe(user.id);
    expect(body.rooms.owned).toHaveLength(1);
    expect(body.rooms.owned[0].name).toBe("Ready Room");
    expect(body.friends.friends).toEqual([]);
    expect(body.dmThreads).toBeTruthy();
    expect(body.unread).toBeTruthy();
    expect(body.notifications.invites).toEqual([]);
    expect(body.notifications.mentions).toEqual([]);
  });

  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/bootstrap" });
    expect(res.statusCode).toBe(401);
  });
});
