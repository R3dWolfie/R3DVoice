import React from "react";
import ReactDOM from "react-dom/client";
import { installWebBridgeIfNeeded } from "./lib/web-bridge.js";
import { App } from "./App.js";
import { ScreenPickerDialog } from "./screens/ScreenPickerDialog.js";
import "./styles.css";

// In Electron the preload provides window.r3dvoice before any script runs;
// in a plain browser tab (web client) this installs the browser bridge.
// Must run before anything touches the bridge.
installWebBridgeIfNeeded();

declare const __APP_VERSION__: string;
const VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
// eslint-disable-next-line no-console
console.log(`[r3dvoice] renderer boot — v${VERSION}`);

// Pipe uncaught errors and rejected promises into the main-process crash log
// so we have a record even when the user can't open DevTools fast enough.
// `window.r3dvoice` is exposed via the preload bridge.
type Bridge = { logError?: (line: string) => unknown };
function bridgeLog(line: string): void {
  try {
    const b = (window as unknown as { r3dvoice?: Bridge }).r3dvoice;
    void b?.logError?.(`[renderer v${VERSION}] ${line}`);
  } catch { /* */ }
}
bridgeLog(`boot ok — userAgent=${navigator.userAgent}`);
window.addEventListener("error", (evt) => {
  bridgeLog(
    `window.error: ${evt.message} @ ${evt.filename}:${evt.lineno}:${evt.colno}` +
      (evt.error?.stack ? `\nstack: ${evt.error.stack}` : ""),
  );
});
window.addEventListener("unhandledrejection", (evt) => {
  const reason = evt.reason;
  const msg = reason instanceof Error
    ? `${reason.message}\nstack: ${reason.stack ?? "(none)"}`
    : String(reason);
  bridgeLog(`unhandledrejection: ${msg}`);
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

const isPicker = new URLSearchParams(window.location.search).get("picker") === "1";

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    {isPicker ? <ScreenPickerDialog /> : <App />}
  </React.StrictMode>,
);
