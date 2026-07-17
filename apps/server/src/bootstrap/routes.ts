import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/middleware.js";

/**
 * GET /bootstrap — Discord-style READY payload: everything the client needs
 * for first paint in ONE round trip (me, rooms, friends, DM threads, unread
 * counts, notifications feed) instead of six sequential-ish fetches. Matters
 * most over high-latency links (the prod path is a Cloudflare tunnel).
 *
 * Implemented as an in-process fan-out over the real route handlers via
 * app.inject — zero duplication, so the sections can never drift from the
 * endpoints they mirror. Inject overhead is µs-scale (no network, no TLS);
 * the auth preHandler re-runs per section, which keeps semantics identical.
 */
const SECTIONS: Array<{ key: string; path: string }> = [
  { key: "me", path: "/me" },
  { key: "rooms", path: "/rooms" },
  { key: "friends", path: "/friends" },
  { key: "dmThreads", path: "/chat/dm-threads" },
  { key: "unread", path: "/chat/unread" },
  { key: "notifications", path: "/notifications/feed" },
];

export async function bootstrapRoutes(app: FastifyInstance): Promise<void> {
  app.get("/bootstrap", { preHandler: requireAuth }, async (request) => {
    const authorization = request.headers.authorization!;
    const results = await Promise.all(
      SECTIONS.map(async ({ key, path }) => {
        const res = await app.inject({ method: "GET", url: path, headers: { authorization } });
        // A failing section must not sink the whole READY payload — the
        // client falls back to lazy-fetching whatever came back null.
        return [key, res.statusCode === 200 ? res.json() : null] as const;
      }),
    );
    return Object.fromEntries(results);
  });
}
