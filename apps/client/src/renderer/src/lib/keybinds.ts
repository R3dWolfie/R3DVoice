import { useEffect, useRef } from "react";

/**
 * Match a KeyboardEvent against an Electron-Accelerator-style string like
 * "Control+Shift+M". Returns true on exact match (modifier set + final key).
 */
export function matchAccelerator(e: KeyboardEvent, accelerator: string | null): boolean {
  if (!accelerator) return false;
  const parts = accelerator.split("+").map((p) => p.trim());
  if (parts.length === 0) return false;
  const finalKey = parts[parts.length - 1]!;
  const mods = new Set(parts.slice(0, -1));

  if (mods.has("Control") !== e.ctrlKey) return false;
  if (mods.has("Shift") !== e.shiftKey) return false;
  if (mods.has("Alt") !== e.altKey) return false;
  if (mods.has("Super") !== e.metaKey) return false;

  const eventKey = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (eventKey === finalKey) return true;
  // Allow Space ↔ " " interchangeably (DOM key for spacebar is " ").
  if (finalKey === "Space" && e.key === " ") return true;
  return false;
}

/**
 * Subscribe to a global keydown matching the given accelerator and run handler.
 * No-op when accelerator is null/empty. Calls preventDefault on match.
 */
export function useKeybind(
  accelerator: string | null,
  handler: () => void,
  options: { enabled?: boolean } = {},
): void {
  const enabled = options.enabled ?? true;
  // Hold the handler in a ref so callers can pass a fresh inline arrow each
  // render WITHOUT re-binding the global listener. Previously `handler` was in
  // the dep array, so all five in-room keybinds tore down + re-added a window
  // keydown listener on every render (5-15×/sec during a call) — pure churn.
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    if (!enabled || !accelerator) return;
    function onKey(e: KeyboardEvent): void {
      if (!matchAccelerator(e, accelerator)) return;
      // Skip if the user is mid-edit in an input/textarea/contenteditable —
      // typing should never trigger app shortcuts.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      e.preventDefault();
      handlerRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [accelerator, enabled]);
}
