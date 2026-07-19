import { shell, type WebContents } from "electron";

// Lock a window's webContents to the app's own content. Without this, a link
// clicked in chat (or any renderer-driven navigation) could load a REMOTE page
// inside a window that still carries our privileged preload (window.r3dvoice) -
// letting a hostile page call getToken() and steal the session JWT (account
// takeover). Real navigations away from the local renderer are blocked; http(s)
// targets are handed to the user's actual browser instead.
//
// Client-side React routing uses history.pushState (not a document navigation),
// so this never interferes with in-app screen changes - only genuine loads.
const DEV_URL = process.env["ELECTRON_RENDERER_URL"];

function isAppUrl(url: string): boolean {
  // Prod renders from file://; dev from the electron-vite dev server origin.
  if (url.startsWith("file://")) return true;
  if (DEV_URL) {
    try {
      return new URL(url).origin === new URL(DEV_URL).origin;
    } catch {
      return false;
    }
  }
  return false;
}

function openExternalIfWeb(url: string): void {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

/** Harden a BrowserWindow's webContents against navigation/window-open escapes. */
export function hardenWebContents(wc: WebContents): void {
  // Deny every window.open / target=_blank / renderer-requested new window;
  // route web URLs to the external browser.
  wc.setWindowOpenHandler(({ url }) => {
    openExternalIfWeb(url);
    return { action: "deny" };
  });
  // Block navigating the window itself to any non-app origin.
  const guard = (event: { preventDefault: () => void }, url: string): void => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      openExternalIfWeb(url);
    }
  };
  wc.on("will-navigate", guard);
  wc.on("will-redirect", guard);
  // Belt-and-suspenders: never let a foreign webview attach.
  wc.on("will-attach-webview", (event) => event.preventDefault());
}
