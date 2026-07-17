import { describe, it, expect, beforeEach } from "vitest";
import { createPrefsStore, type PrefsStorage } from "../src/renderer/src/lib/prefs-store.js";

function makeStorage(): PrefsStorage & { raw: string | null } {
  let data: string | null = null;
  return {
    get raw() { return data; },
    read: () => data,
    write: (v) => { data = v; },
  };
}

describe("prefs store", () => {
  let storage: ReturnType<typeof makeStorage>;
  beforeEach(() => {
    storage = makeStorage();
  });

  it("returns defaults when storage empty", () => {
    const store = createPrefsStore(storage);
    expect(store.getState().resolution).toBe("1080p");
    expect(store.getState().frameRate).toBe(30);
    // Deck 3.2 keybind defaults ship populated (ghost/leave stay unbound).
    expect(store.getState().pttKeybind).toBe("Control+Space");
    expect(store.getState().deafenKeybind).toBeNull();
  });

  it("keeps a persisted null keybind (user cleared it) over the default", () => {
    storage.write(JSON.stringify({ pttKeybind: null }));
    const store = createPrefsStore(storage);
    expect(store.getState().pttKeybind).toBeNull();
  });

  it("sanitizes theme overrides on load", () => {
    storage.write(
      JSON.stringify({ themeOverrides: { "--bg": "#123456", "bad": "#fff", "--n": 3 } }),
    );
    const store = createPrefsStore(storage);
    expect(store.getState().themeOverrides).toEqual({ "--bg": "#123456" });
  });

  it("persists changes to storage", () => {
    const store = createPrefsStore(storage);
    store.getState().setResolution("4K");
    store.getState().setFrameRate(60);
    expect(storage.raw).not.toBeNull();
    const parsed = JSON.parse(storage.raw!);
    expect(parsed.resolution).toBe("4K");
    expect(parsed.frameRate).toBe(60);
  });

  it("loads persisted values on init", () => {
    storage.write(JSON.stringify({ resolution: "1440p", frameRate: 60, shareAudio: false }));
    const store = createPrefsStore(storage);
    expect(store.getState().resolution).toBe("1440p");
    expect(store.getState().frameRate).toBe(60);
    expect(store.getState().shareAudio).toBe(false);
  });

  it("ignores malformed JSON gracefully", () => {
    storage.write("not json");
    const store = createPrefsStore(storage);
    expect(store.getState().resolution).toBe("1080p");
  });
});
