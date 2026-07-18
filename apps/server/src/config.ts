import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  LIVEKIT_URL: z.string().url().or(z.string().startsWith("ws")),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z
    .string()
    .min(32, "LIVEKIT_API_SECRET must be at least 32 chars"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // Base URL the client is served from — used to build verify/reset links in
  // outbound email. Defaults to the deployed origin.
  APP_URL: z.string().url().default("https://voice.r3dwolfie.com"),

  // SMTP is optional: email flows (verify, password reset) are ENABLED only
  // when SMTP_HOST is set. Self-hosters without a mail server keep working —
  // registration auto-verifies and the reset link is simply unavailable.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("R3DVoice <noreply@r3dwolfie.com>"),

  // Minimum client version allowed to use the app. Clients older than this get
  // a blocking "update required" gate (and, once they send X-Client-Version,
  // are refused at the API). "0.0.0" (default) disables the floor.
  MIN_CLIENT_VERSION: z.string().default("0.0.0"),

  // Where uploaded files (avatars, message attachments) are written and served
  // from at /uploads. Keep it OUTSIDE the app checkout so deploys don't wipe it.
  UPLOADS_DIR: z.string().default("uploads"),
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Config {
  return configSchema.parse(env);
}

let cached: Config | undefined;
export function getConfig(): Config {
  if (!cached) cached = parseConfig(process.env);
  return cached;
}

// Test-only reset
export function __resetConfigForTests(): void {
  cached = undefined;
}
