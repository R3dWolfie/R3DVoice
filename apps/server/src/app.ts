import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import compress from "@fastify/compress";
import { registerErrorHandler } from "./errors.js";
import { authRoutes } from "./auth/routes.js";
import { roomRoutes } from "./rooms/routes.js";
import { chatRoutes } from "./chat/routes.js";
import { chatWsRoutes } from "./chat/ws.js";
import { friendsRoutes } from "./friends/routes.js";
import { landingRoutes } from "./landing.js";
import { userRoutes } from "./users/routes.js";
import { inviteRoutes } from "./invites/routes.js";
import { notificationRoutes } from "./notifications/routes.js";
import { presenceRoutes } from "./presence/routes.js";

export interface BuildAppOptions {
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    disableRequestLogging: true,
    trustProxy: true,
  });

  // The Electron renderer runs on http://localhost:5173 in dev (Vite) and
  // from a `file://` origin in production builds. Reflecting any origin is
  // acceptable for a self-hosted app where authorization is enforced by JWTs.
  await app.register(cors, { origin: true, credentials: true });

  // Speed: brotli/gzip for JSON and the web-client bundle (the main JS chunk
  // shrinks ~4x, and it's the cold-load long pole over the tunnel).
  await app.register(compress, { global: true });

  await app.register(rateLimit, { global: false });

  registerErrorHandler(app);

  app.get("/health", async () => ({ status: "ok" }));

  // Web client: when WEB_CLIENT_DIR points at the built renderer bundle
  // (apps/client/out/renderer), the SPA takes over "/" and unknown GET
  // navigations fall back to index.html so client-side routes deep-link.
  // The marketing landing page only registers when no web client is set.
  const webClientDir = process.env["WEB_CLIENT_DIR"]
    ? resolve(process.env["WEB_CLIENT_DIR"])
    : null;
  const serveWebClient = webClientDir !== null && existsSync(join(webClientDir, "index.html"));
  if (serveWebClient && webClientDir) {
    // wildcard:false enumerates real files at boot instead of a GET /* route,
    // so unknown paths reach the not-found handler below (SPA fallback).
    // Vite assets are content-hashed → cache forever; index.html must
    // revalidate so deploys take effect immediately.
    await app.register(fastifyStatic, {
      root: webClientDir,
      index: "index.html",
      wildcard: false,
      setHeaders: (res, filePath) => {
        if (/[/\\]assets[/\\]/.test(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    });
    app.setNotFoundHandler((request, reply) => {
      const accepts = request.headers.accept ?? "";
      if (request.method === "GET" && accepts.includes("text/html")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "route not found" } });
    });
  } else {
    await app.register(landingRoutes);
  }
  await app.register(authRoutes);
  await app.register(roomRoutes);
  await app.register(chatWsRoutes);
  await app.register(chatRoutes);
  await app.register(friendsRoutes);
  await app.register(userRoutes);
  await app.register(inviteRoutes);
  await app.register(notificationRoutes);
  await app.register(presenceRoutes);

  return app;
}
