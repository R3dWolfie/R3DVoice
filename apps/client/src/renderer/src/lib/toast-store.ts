import { create } from "zustand";

/**
 * Runtime toast manager (system/toasts.html): anchored bottom-right,
 * auto-dismisses after 4–6s, stacks newest-on-top, × dismisses early, and an
 * optional Action button gives one quick recovery / follow-up (Undo pattern).
 * Push from anywhere — React or plain libs — via pushToast().
 */

export type ToastKind = "success" | "info" | "warn" | "error" | "undo";

export interface ToastAction {
  label: string;
  onAction: () => void;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  /** Second line — mono metadata (URLs, countdowns) per the deck. */
  sub?: string | undefined;
  action?: ToastAction | undefined;
  /** Auto-dismiss window in ms (deck: 4–6s). */
  durationMs: number;
}

interface ToastState {
  toasts: ToastItem[];
  push(input: {
    kind: ToastKind;
    text: string;
    sub?: string | undefined;
    action?: ToastAction | undefined;
    durationMs?: number | undefined;
  }): number;
  dismiss(id: number): void;
}

let nextId = 1;
const MAX_STACK = 5;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  push(input) {
    const id = nextId++;
    const item: ToastItem = {
      id,
      kind: input.kind,
      text: input.text,
      sub: input.sub,
      action: input.action,
      durationMs: input.durationMs ?? (input.kind === "undo" ? 5000 : 4500),
    };
    // Newest-on-top; cap the stack so a burst can't wallpaper the corner.
    set((s) => ({ toasts: [item, ...s.toasts].slice(0, MAX_STACK) }));
    return id;
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

/** Imperative helper for non-component callers. */
export function pushToast(input: {
  kind: ToastKind;
  text: string;
  sub?: string | undefined;
  action?: ToastAction | undefined;
  durationMs?: number | undefined;
}): number {
  return useToastStore.getState().push(input);
}

export function dismissToast(id: number): void {
  useToastStore.getState().dismiss(id);
}
