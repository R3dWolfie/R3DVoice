import { useEffect, useRef, useState, type ReactElement } from "react";
import { pushToast } from "../lib/toast-store.js";
import { I } from "./Icons.js";

/**
 * Single button that copies the room link by default; chevron opens a small
 * menu with "Copy link" and "Copy ID" so the room ID is reachable without
 * cluttering the top bar with extra UI.
 */
export function CopyLinkButton({
  roomId,
  serverUrl,
}: {
  roomId: string;
  serverUrl: string;
}): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onMouseDown(e: globalThis.MouseEvent): void {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    window.addEventListener("mousedown", onMouseDown, true);
    return () => window.removeEventListener("mousedown", onMouseDown, true);
  }, [menuOpen]);

  async function copy(kind: "link" | "id"): Promise<void> {
    const value =
      kind === "link" ? `${serverUrl.replace(/\/$/, "")}/join/${roomId}` : roomId;
    try {
      await navigator.clipboard.writeText(value);
      pushToast({
        kind: "success",
        text: kind === "link" ? "Room link copied" : "Room ID copied",
        sub: value,
      });
    } catch {
      pushToast({ kind: "error", text: "Couldn't access the clipboard" });
    }
  }

  return (
    <div ref={wrapperRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        className="rv-btn"
        onClick={() => void copy("link")}
        title="Copy room link to clipboard"
        style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0, paddingRight: "var(--s-2)" }}
      >
        Copy
      </button>
      <button
        className="rv-btn"
        onClick={() => setMenuOpen((v) => !v)}
        title="More copy options"
        aria-label="More copy options"
        style={{
          borderTopLeftRadius: 0,
          borderBottomLeftRadius: 0,
          borderLeft: 0,
          padding: "0 var(--s-2)",
        }}
      >
        <I.ChevronDown size={12} />
      </button>
      {menuOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 30,
            minWidth: 160,
            padding: 4,
            background: "var(--bg-elev-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-md)",
            boxShadow: "var(--shadow-2)",
          }}
        >
          <MenuItem
            onClick={() => {
              void copy("link");
              setMenuOpen(false);
            }}
          >
            Copy link
          </MenuItem>
          <MenuItem
            onClick={() => {
              void copy("id");
              setMenuOpen(false);
            }}
          >
            Copy ID
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: "none",
        border: 0,
        background: "transparent",
        color: "var(--text)",
        cursor: "pointer",
        width: "100%",
        textAlign: "left",
        padding: "8px 10px",
        borderRadius: "var(--r-sm)",
        fontSize: "var(--t-sm)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-elev-3)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}
