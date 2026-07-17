import { type ReactElement } from "react";
import type { DmThreadEntry } from "@r3dvoice/shared";
import { Avatar } from "./Avatar.js";
import { UnreadDot } from "./UnreadDot.js";
import { useUnreadStore } from "../lib/unread-store.js";

type Props = {
  threads: DmThreadEntry[];
  activeThreadId: string | null;
  /** Second highlighted thread while split view (2.4f) is open. */
  splitThreadId?: string | null;
  onSelect(threadId: string): void;
  /** Right-click on a row (2.4d user context menu). */
  onContextMenu?(threadId: string, x: number, y: number): void;
};

function avatarTone(seed: string): 1 | 2 | 3 | 4 | 5 {
  return ((seed.charCodeAt(0) % 5) + 1) as 1 | 2 | 3 | 4 | 5;
}

// E2EE DM bodies are stored as ciphertext envelopes — never show raw JSON
// in the preview. Decryption lives in the chat panel; the rail masks.
function previewText(body: string | null): string {
  if (body === null) return "(deleted)";
  if (body.startsWith("{")) {
    try {
      const parsed = JSON.parse(body) as { v?: unknown };
      if (parsed && typeof parsed === "object" && parsed.v !== undefined) return "🔒 Encrypted message";
    } catch {
      /* plaintext that happens to start with { */
    }
  }
  return body;
}

export function DmThreadList({ threads, activeThreadId, splitThreadId, onSelect, onContextMenu }: Props): ReactElement {
  const counts = useUnreadStore((s) => s.counts);
  if (threads.length === 0) {
    return (
      <div style={{ padding: "var(--s-4)", color: "var(--text-faint)", fontSize: "var(--t-sm)" }}>
        No conversations yet.
      </div>
    );
  }
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {threads.map((t) => {
        const active = t.threadId === activeThreadId || t.threadId === splitThreadId;
        const peer = t.otherParticipant;
        const headline = peer.handle ? `@${peer.handle}` : peer.displayName;
        return (
          <li
            key={t.threadId}
            onClick={() => onSelect(t.threadId)}
            onContextMenu={(e) => {
              if (!onContextMenu) return;
              e.preventDefault();
              onContextMenu(t.threadId, e.clientX, e.clientY);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--s-3)",
              padding: "var(--s-2) var(--s-3)",
              borderRadius: "var(--r-md)",
              cursor: "pointer",
              background: active ? "color-mix(in oklch, var(--accent) 14%, transparent)" : "transparent",
              border: active ? "1px solid var(--accent)" : "1px solid transparent",
            }}
          >
            <Avatar
              src={null}
              fallbackInitials={peer.displayName}
              fallbackColorSeed={peer.id}
              size={32}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)" }}>
                <span style={{ fontSize: "var(--t-sm)", fontWeight: (counts[`dm:${t.threadId}`] ?? 0) > 0 ? 600 : 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>
                  {headline}
                </span>
                <UnreadDot count={counts[`dm:${t.threadId}`] ?? 0} />
              </div>
              <div style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {previewText(t.lastMessage.body)}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
