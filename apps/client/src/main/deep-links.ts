import { app, BrowserWindow, ipcMain } from "electron";
import type { DeepLinkEvent } from "../shared/bridge-types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVITE_CODE_RE = /^[A-Za-z2-9]{8}$/;

let pending: DeepLinkEvent | null = null;

/** Parse a r3dvoice:// URL into a typed event, or null if it doesn't match a known shape.
 * Legacy redvoice:// links (pre-rename) are accepted forever — they exist in old chats. */
export function parseDeepLink(raw: string): DeepLinkEvent | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "r3dvoice:" && url.protocol !== "redvoice:") return null;

  // r3dvoice://join/<uuid> — `host` is "join", pathname is "/<uuid>"
  if (url.host === "join") {
    const id = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    if (UUID_RE.test(id)) return { type: "join-room", roomId: id };
  }

  // r3dvoice://invite/<code> — `host` is "invite", pathname is "/<code>"
  if (url.host === "invite") {
    const code = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    if (INVITE_CODE_RE.test(code)) return { type: "invite-code", code };
  }

  return null;
}

/** Scan argv (process argv or second-instance argv) for a r3dvoice:// URL. */
export function extractDeepLinkFromArgv(argv: string[]): DeepLinkEvent | null {
  for (const arg of argv) {
    if (arg.startsWith("r3dvoice://") || arg.startsWith("redvoice://")) {
      const link = parseDeepLink(arg);
      if (link) return link;
    }
  }
  return null;
}

/** Send a deep-link event to the main window if present, otherwise queue it. */
export function dispatchDeepLink(link: DeepLinkEvent, mainWin: BrowserWindow | null): void {
  if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isDestroyed()) {
    mainWin.webContents.send("deep-link", link);
  } else {
    pending = link;
  }
}

/** Register the r3dvoice:// scheme as a protocol handler + IPC for the renderer to poll pending. */
export function registerDeepLinkHandlers(): void {
  // Electron's protocol-client API handles cross-platform plumbing.
  // In dev (unpackaged), we must pass execPath + the script path so the OS knows how to relaunch.
  // Both schemes register: r3dvoice:// is canonical, redvoice:// keeps old links alive.
  for (const scheme of ["r3dvoice", "redvoice"]) {
    if (process.defaultApp) {
      if (process.argv.length >= 2 && typeof process.argv[1] === "string") {
        app.setAsDefaultProtocolClient(scheme, process.execPath, [process.argv[1]]);
      }
    } else {
      app.setAsDefaultProtocolClient(scheme);
    }
  }

  ipcMain.handle("deep-link:consume-pending", () => {
    const link = pending;
    pending = null;
    return link;
  });
}
