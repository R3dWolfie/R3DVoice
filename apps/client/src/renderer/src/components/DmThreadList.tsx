import { type ReactElement } from "react";
import type { DmThreadEntry } from "@r3dvoice/shared";
import { Avatar } from "./Avatar.js";
import { UnreadDot } from "./UnreadDot.js";
import { useUnreadStore } from "../lib/unread-store.js";
import { decryptDM, type EncryptedDMPayload, type KeyPair } from "../lib/crypto.js";

type Props = {
  threads: DmThreadEntry[];
  activeThreadId: string | null;
  /** Second highlighted thread while split view (2.4f) is open. */
  splitThreadId?: string | null;
  onSelect(threadId: string): void;
  /** Right-click on a row (2.4d user context menu). */
  onContextMenu?(threadId: string, x: number, y: number): void;
  /** This device's E2EE keypair (to decrypt the last-message preview). */
  myKeyPair?: KeyPair | null;
  /** peerId → their public key, for decrypting our OWN sent previews. */
  peerKeys?: Record<string, string | null>;
};

function avatarTone(seed: string): 1 | 2 | 3 | 4 | 5 {
  return ((seed.charCodeAt(0) % 5) + 1) as 1 | 2 | 3 | 4 | 5;
}

// E2EE DM bodies are stored as ciphertext envelopes. Decrypt the preview here
// too (peerKey is needed for our own sent messages); fall back to the masked
// placeholder only when the key isn't available or decryption fails.
function previewText(
  body: string | null,
  myKeyPair: KeyPair | null | undefined,
  peerKey: string | null | undefined,
): string {
  if (body === null) return "(deleted)";
  if (body.startsWith("{")) {
    try {
      const parsed = JSON.parse(body) as EncryptedDMPayload;
      if (parsed && typeof parsed === "object" && parsed.v === 1) {
        if (!myKeyPair) return "🔒 Encrypted message";
        return decryptDM(parsed, myKeyPair, peerKey ?? undefined) ?? "🔒 Encrypted message";
      }
    } catch {
      /* plaintext that happens to start with { */
    }
  }
  return body;
}

export function DmThreadList({ threads, activeThreadId, splitThreadId, onSelect, onContextMenu, myKeyPair, peerKeys }: Props): ReactElement {
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
            className="rv-dm-row"
            data-active={active ? "true" : undefined}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(t.threadId)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(t.threadId);
              }
            }}
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
              // background (hover + active) handled by .rv-dm-row in styles.css
              border: active
                ? "1px solid color-mix(in srgb, var(--accent) 35%, var(--border))"
                : "1px solid transparent",
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
                {previewText(t.lastMessage.body, myKeyPair, peerKeys?.[peer.id])}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
