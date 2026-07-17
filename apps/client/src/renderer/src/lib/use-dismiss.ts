import { useEffect, type RefObject } from "react";

/**
 * Close a menu/popover on pointerdown outside the given refs, or on Escape.
 * Listeners run in the CAPTURE phase: several panels stopPropagation on
 * mousedown (RoomInfoPanel etc.), which silently defeats bubble-phase
 * outside-click handlers and leaves menus stranded open.
 */
export function useDismiss(
  open: boolean,
  onClose: () => void,
  refs: Array<RefObject<HTMLElement | null>> = [],
): void {
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent): void {
      const t = e.target;
      if (t instanceof Node && refs.some((r) => r.current?.contains(t))) return;
      onClose();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose]);
}
