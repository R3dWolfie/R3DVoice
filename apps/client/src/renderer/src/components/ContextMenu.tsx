import { useEffect, useRef, type ReactElement, type ReactNode } from "react";

// Generic right-click / anchored menu per the deck's .menu pattern (2.1b,
// 2.4d, 2.5g, 2.5k): fixed-position surface, optional header, items via
// MenuItem, closes on outside click / ESC / scroll.
export function ContextMenu({
  x,
  y,
  onClose,
  header,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  header?: ReactNode;
  children: ReactNode;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  // Keep the menu on-screen: flip up/left when it would overflow.
  const style: React.CSSProperties = { position: "fixed", zIndex: 60 };
  if (typeof window !== "undefined") {
    const MENU_W = 240;
    const MENU_H = 320;
    style.left = Math.min(x, window.innerWidth - MENU_W - 8);
    style.top = Math.min(y, window.innerHeight - MENU_H - 8);
  } else {
    style.left = x;
    style.top = y;
  }

  return (
    <div ref={ref} className="rv-menu rv-fade-in" style={{ ...style, width: 230 }} role="menu">
      {header && (
        <div
          style={{
            padding: "var(--s-2) var(--s-2)",
            display: "flex",
            alignItems: "center",
            gap: "var(--s-2)",
            borderBottom: "1px solid var(--border-soft)",
            marginBottom: 4,
          }}
        >
          {header}
        </div>
      )}
      {children}
    </div>
  );
}

export function MenuItem({
  icon,
  label,
  kbd,
  tone,
  disabled,
  disabledHint,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  kbd?: string;
  tone?: "danger";
  disabled?: boolean;
  disabledHint?: string;
  onClick?: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      className="rv-menu-item"
      data-tone={tone}
      data-disabled={disabled || undefined}
      title={disabled ? disabledHint : undefined}
      onClick={disabled ? undefined : onClick}
      style={disabled ? { opacity: 0.45, cursor: "default" } : undefined}
    >
      {icon && (
        <span style={{ width: 16, textAlign: "center", color: tone === "danger" ? "var(--danger)" : "var(--text-dim)" }}>
          {icon}
        </span>
      )}
      <span style={{ flex: 1 }}>{label}</span>
      {kbd && <span className="rv-kbd">{kbd}</span>}
    </button>
  );
}

export function MenuDivider(): ReactElement {
  return <div className="rv-menu-sep" />;
}

export function MenuSection({ label }: { label: string }): ReactElement {
  return (
    <div
      className="rv-label"
      style={{ padding: "var(--s-1) var(--s-3)", fontSize: "var(--t-2xs)" }}
    >
      {label}
    </div>
  );
}
