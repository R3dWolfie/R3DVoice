import type { R3DVoiceBridge } from "../../shared/bridge-types.js";

declare global {
  interface Window {
    r3dvoice: R3DVoiceBridge;
  }
}

export {};
