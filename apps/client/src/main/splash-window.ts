import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import type { SplashStatus } from "../shared/bridge-types.js";
import { resolveIconPath } from "./desktop-integration.js";

const RENDERER_DEV_URL = process.env["ELECTRON_RENDERER_URL"];

export type { SplashStatus } from "../shared/bridge-types.js";

/**
 * Open the splash window. Frameless, fixed-size, always-on-top while visible.
 * Loads `splash.html` from the renderer build/dev server.
 */
export function openSplashWindow(): BrowserWindow {
  const iconPath = resolveIconPath();
  const primary = screen.getPrimaryDisplay().workArea;
  const splashW = 420;
  const splashH = 320;
  const win = new BrowserWindow({
    width: splashW,
    height: splashH,
    x: primary.x + Math.round((primary.width - splashW) / 2),
    y: primary.y + Math.round((primary.height - splashH) / 2),
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: true,
    backgroundColor: "#101014",
    title: "R3DVoice",
    ...(iconPath && { icon: iconPath }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (RENDERER_DEV_URL) {
    void win.loadURL(`${RENDERER_DEV_URL}/splash.html`);
  } else {
    void win.loadFile(join(import.meta.dirname, "../renderer/splash.html"));
  }

  return win;
}

/**
 * Send a status update to the splash window. No-op if the window is gone.
 */
export function sendSplashStatus(win: BrowserWindow | null, status: SplashStatus): void {
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isDestroyed()) return;
  win.webContents.send("splash:status", status);
}

/**
 * Close the splash window if it's still open.
 */
export function closeSplash(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  win.close();
}
