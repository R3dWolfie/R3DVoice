// Required-update gate. The server publishes MIN_CLIENT_VERSION via /health;
// clients older than it are blocked behind a full-screen "update required" wall
// so an outdated build can't talk to a server it's no longer compatible with.

/** Compare dotted versions. <0 if a<b, 0 if equal, >0 if a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True when `current` is older than the required `min` (and min is a real floor). */
export function isUpdateRequired(current: string, min: string | null): boolean {
  if (!min || min === "0.0.0") return false;
  return compareVersions(current, min) < 0;
}

/** Fetch the server's minimum client version, or null on any failure. */
export async function fetchMinClientVersion(serverUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/health`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { minClientVersion?: unknown };
    return typeof body.minClientVersion === "string" ? body.minClientVersion : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the server's own (latest) build version, or null on any failure. Drives
 * the ambient, non-blocking "update available" affordance — unlike
 * fetchMinClientVersion, this never gates the app.
 */
export async function fetchLatestClientVersion(serverUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/health`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { latestClientVersion?: unknown };
    return typeof body.latestClientVersion === "string" ? body.latestClientVersion : null;
  } catch {
    return null;
  }
}
