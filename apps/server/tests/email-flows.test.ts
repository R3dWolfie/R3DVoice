import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTestApp } from "./helpers/app.js";
import { registerUser, authHeader, resetDb } from "./helpers/fixtures.js";
import { disconnectDb } from "./helpers/db.js";
import { prisma } from "../src/db.js";
import { __setMailSinkForTests, type OutgoingMail } from "../src/email/mailer.js";

// Capture emailed links (the raw token only exists in the link).
let sent: OutgoingMail[] = [];
function tokenFromLastMail(param = "token"): string {
  const link = /https?:\/\/\S+/.exec(sent[sent.length - 1]!.text)![0];
  return new URL(link).searchParams.get(param)!;
}

describe("email flows (verify + password reset)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    sent = [];
    __setMailSinkForTests((m) => sent.push(m)); // enables email + captures
    app = await makeTestApp();
  });
  afterEach(async () => {
    __setMailSinkForTests(null);
    if (app) await app.close();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("registration with email enabled sends a verify mail and reports unverified", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "v@test.local", password: "password-password-pw", displayName: "V" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.emailVerified).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/verify/i);
  });

  it("clicking the verify link marks the account verified", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "v2@test.local", password: "password-password-pw", displayName: "V2" },
    });
    const token = tokenFromLastMail();
    const hit = await app.inject({ method: "GET", url: `/auth/verify-email?token=${encodeURIComponent(token)}` });
    expect(hit.statusCode).toBe(200);
    expect(hit.headers["content-type"]).toMatch(/html/);
    expect(hit.body).toMatch(/verified/i);

    // /me now reports verified.
    const me = await app.inject({ method: "GET", url: "/me", headers: authHeader(reg.json().token) });
    expect(me.json().emailVerified).toBe(true);

    // Token is single-use: a second hit renders the expired page.
    const again = await app.inject({ method: "GET", url: `/auth/verify-email?token=${encodeURIComponent(token)}` });
    expect(again.body).toMatch(/expired|invalid/i);
  });

  it("resend issues a fresh verify token", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "v3@test.local", password: "password-password-pw", displayName: "V3" },
    });
    sent = [];
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify-email/resend",
      headers: authHeader(reg.json().token),
    });
    expect(res.statusCode).toBe(204);
    expect(sent).toHaveLength(1);
  });

  it("password reset: request is silent for unknown email, sends for known", async () => {
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "reset@test.local", password: "password-password-pw", displayName: "R" },
    });
    sent = [];

    const unknown = await app.inject({
      method: "POST",
      url: "/auth/password-reset/request",
      payload: { email: "nobody@test.local" },
    });
    expect(unknown.statusCode).toBe(204); // no enumeration
    expect(sent).toHaveLength(0);

    const known = await app.inject({
      method: "POST",
      url: "/auth/password-reset/request",
      payload: { email: "reset@test.local" },
    });
    expect(known.statusCode).toBe(204);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/reset/i);
  });

  it("password reset confirm sets a new password, burns the token, revokes sessions", async () => {
    const reg = await registerUser(app, { email: "flow@test.local", password: "old-password-1234" });
    // Make a second session to prove reset revokes ALL sessions.
    await prisma.session.create({ data: { userId: reg.id } });

    sent = [];
    await app.inject({
      method: "POST",
      url: "/auth/password-reset/request",
      payload: { email: "flow@test.local" },
    });
    const token = tokenFromLastMail();

    const confirm = await app.inject({
      method: "POST",
      url: "/auth/password-reset/confirm",
      payload: { token, password: "brand-new-password-99" },
    });
    expect(confirm.statusCode).toBe(204);

    // All sessions gone.
    expect(await prisma.session.count({ where: { userId: reg.id } })).toBe(0);

    // Old password rejected, new password works.
    const oldLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "flow@test.local", password: "old-password-1234" },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "flow@test.local", password: "brand-new-password-99" },
    });
    expect(newLogin.statusCode).toBe(200);

    // Token cannot be replayed.
    const replay = await app.inject({
      method: "POST",
      url: "/auth/password-reset/confirm",
      payload: { token, password: "another-password-1234" },
    });
    expect(replay.statusCode).toBe(400);
  });

  it("reset confirm rejects a short password and an unknown token", async () => {
    await registerUser(app, { email: "guard@test.local" });
    sent = [];
    await app.inject({
      method: "POST",
      url: "/auth/password-reset/request",
      payload: { email: "guard@test.local" },
    });
    const token = tokenFromLastMail();
    const short = await app.inject({
      method: "POST",
      url: "/auth/password-reset/confirm",
      payload: { token, password: "short" },
    });
    expect(short.statusCode).toBe(400);
    const bogus = await app.inject({
      method: "POST",
      url: "/auth/password-reset/confirm",
      payload: { token: "not-a-real-token", password: "brand-new-password-99" },
    });
    expect(bogus.statusCode).toBe(400);
  });

  it("with email disabled, registration auto-verifies and sends nothing", async () => {
    __setMailSinkForTests(null); // disable email for this case
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "noemail@test.local", password: "password-password-pw", displayName: "N" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.emailVerified).toBe(true);
  });
});
