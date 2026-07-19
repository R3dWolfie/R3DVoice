import { BrowserWindow, desktopCapturer, ipcMain, type DesktopCapturerSource } from "electron";
import { join } from "node:path";
import { hardenWebContents } from "./web-contents-guard.js";

interface PendingRequest {
  resolve: (sourceId: string | null) => void;
}

let pending: PendingRequest | null = null;
let pickerWindow: BrowserWindow | null = null;

export async function openScreenPicker(): Promise<string | null> {
  // Settle any in-flight request before we replace it - otherwise the previous
  // getDisplayMedia promise never resolves and its caller spins forever.
  if (pending) {
    pending.resolve(null);
    pending = null;
  }
  if (pickerWindow) {
    pickerWindow.focus();
    return new Promise((resolve) => (pending = { resolve }));
  }

  const win = new BrowserWindow({
    width: 720,
    height: 520,
    title: "Choose a screen to share",
    resizable: true,
    minimizable: false,
    maximizable: false,
    modal: false,
    backgroundColor: "#101014",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  pickerWindow = win;
  hardenWebContents(win.webContents);

  win.on("closed", () => {
    pickerWindow = null;
    if (pending) {
      pending.resolve(null);
      pending = null;
    }
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    await win.loadURL(`${devUrl}?picker=1`);
  } else {
    await win.loadFile(join(import.meta.dirname, "../renderer/index.html"), {
      search: "picker=1",
    });
  }

  return new Promise<string | null>((resolve) => {
    pending = { resolve };
  });
}

export function registerScreenPickerHandlers(): void {
  ipcMain.handle("screen-picker:list", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
    });
    return sources.map((s: DesktopCapturerSource) => ({
      id: s.id,
      name: s.name,
      thumbnailDataUrl: s.thumbnail.toDataURL(),
    }));
  });
  ipcMain.handle("screen-picker:select", (_evt, sourceId: unknown) => {
    if (pending && typeof sourceId === "string") {
      pending.resolve(sourceId);
      pending = null;
    }
    if (pickerWindow) {
      pickerWindow.close();
      pickerWindow = null;
    }
  });
  ipcMain.handle("screen-picker:cancel", () => {
    if (pending) {
      pending.resolve(null);
      pending = null;
    }
    if (pickerWindow) {
      pickerWindow.close();
      pickerWindow = null;
    }
  });
}
