import { useEffect, useRef, useState, type ReactElement } from "react";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { Avatar } from "./Avatar.js";

export type HandleMatch = { id: string; handle: string | null; displayName: string };

// Mirrors shared userHandleSchema (3–24 chars, [A-Za-z0-9_]) with an
// optional leading @. Emails never pass (dots / mid-string @).
const HANDLE_RE = /^[A-Za-z0-9_]{3,24}$/;

/**
 * Debounced live @handle lookup (deck 2.2a): as the user types a handle,
 * resolve it against /users/by-handle and surface the match. Returns null
 * while idle, for non-handle input, or when nothing matches. A sequence
 * counter drops stale responses so fast typing can't show the wrong user.
 */
export function useHandleMatch(query: string): HandleMatch | null {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const [match, setMatch] = useState<HandleMatch | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const raw = query.trim().replace(/^@/, "");
    const mine = ++seq.current;
    if (!token || !HANDLE_RE.test(raw)) {
      setMatch(null);
      return;
    }
    const timer = setTimeout(() => {
      const api = new ApiClient(serverUrl);
      api.setToken(token);
      api
        .getUserByHandle(raw)
        .then((u) => {
          if (seq.current === mine) setMatch(u);
        })
        .catch(() => {
          if (seq.current === mine) setMatch(null);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, serverUrl, token]);

  return match;
}

/** The 2.2a match preview card: avatar · name/@handle · "Match" badge. */
export function HandleMatchCard({
  match,
  onClick,
}: {
  match: HandleMatch;
  onClick?: (() => void) | undefined;
}): ReactElement {
  const inner = (
    <>
      <Avatar src={null} fallbackInitials={match.displayName} fallbackColorSeed={match.id} size={30} />
      <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        <span
          style={{
            fontSize: "var(--t-xs)",
            fontWeight: 600,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {match.displayName}
        </span>
        {match.handle && (
          <span className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>
            @{match.handle}
          </span>
        )}
      </span>
      <span className="rv-match-badge">Match</span>
    </>
  );
  if (onClick) {
    return (
      <button type="button" className="rv-match-card" onClick={onClick}>
        {inner}
      </button>
    );
  }
  return <div className="rv-match-card">{inner}</div>;
}
