// Persists the main window's position, size, and maximized state across
// launches. State lives in userData/window-state.json so it survives
// updates and uninstall-reinstall cycles.

import { app, screen, type BrowserWindow, type Rectangle } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

const DEFAULTS: WindowState = { width: 1200, height: 800 };
const SAVE_DEBOUNCE_MS = 500;

function statePath(): string {
  const userData = process.env["R3DVOICE_USER_DATA_DIR"] ?? app.getPath("userData");
  return join(userData, "window-state.json");
}

function readState(): WindowState {
  try {
    const raw = readFileSync(statePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<WindowState>;
    if (typeof parsed.width !== "number" || typeof parsed.height !== "number") {
      return DEFAULTS;
    }
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

function writeState(state: WindowState): void {
  try {
    writeFileSync(statePath(), JSON.stringify(state), "utf8");
  } catch {
    /* best effort; not worth crashing the app over */
  }
}

/**
 * Returns initial BrowserWindow bounds - saved state if it falls within a
 * currently-connected display, otherwise centered defaults. Guarding against
 * off-screen position is important: a saved bound on a now-disconnected
 * monitor would put the window where the user can't reach it.
 */
export function getInitialWindowBounds(): {
  x?: number;
  y?: number;
  width: number;
  height: number;
} {
  const saved = readState();
  const displays = screen.getAllDisplays();
  const fitsOnDisplay = (rect: Partial<Rectangle>): boolean => {
    if (typeof rect.x !== "number" || typeof rect.y !== "number") return false;
    return displays.some((d) => {
      const wa = d.workArea;
      // At least 100×100 of the saved bound must overlap a display so we
      // don't restore behind the edge of a screen we no longer have.
      const overlapW = Math.max(0, Math.min(rect.x! + (rect.width ?? 1200), wa.x + wa.width) - Math.max(rect.x!, wa.x));
      const overlapH = Math.max(0, Math.min(rect.y! + (rect.height ?? 800), wa.y + wa.height) - Math.max(rect.y!, wa.y));
      return overlapW >= 100 && overlapH >= 100;
    });
  };

  if (saved.x !== undefined && saved.y !== undefined && fitsOnDisplay(saved)) {
    return { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
  }

  // Center on primary.
  const primary = screen.getPrimaryDisplay().workArea;
  return {
    width: saved.width,
    height: saved.height,
    x: primary.x + Math.round((primary.width - saved.width) / 2),
    y: primary.y + Math.round((primary.height - saved.height) / 2),
  };
}

/** Whether the saved state requested maximized. */
export function shouldStartMaximized(): boolean {
  return readState().maximized === true;
}

/**
 * Hook resize / move / maximize events on the window so any change is
 * persisted (debounced). Skip persisting while maximized for the bounds -
 * we want to remember the "restore" size, not the maximized rectangle.
 */
export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;
  const flush = (): void => {
    if (win.isDestroyed()) return;
    const isMax = win.isMaximized();
    const next: WindowState = isMax
      ? { ...readState(), maximized: true }
      : { ...win.getBounds(), maximized: false };
    writeState(next);
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };
  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("maximize", flush);
  win.on("unmaximize", flush);
  win.on("close", () => {
    if (timer) clearTimeout(timer);
    flush();
  });
}
