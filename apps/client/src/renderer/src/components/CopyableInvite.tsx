import { useCallback, type ReactElement } from "react";
import { pushToast } from "../lib/toast-store.js";

type Props = { code: string; serverUrl: string; onClose(): void };

export function CopyableInvite({ code, serverUrl, onClose }: Props): ReactElement {
  const url = `${serverUrl.replace(/\/$/, "")}/invite/${code}`;
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      // Deck copy (system/toasts.html): "Invite link copied" + mono URL sub.
      pushToast({ kind: "success", text: "Invite link copied", sub: url });
    } catch {
      pushToast({ kind: "error", text: "Couldn't access the clipboard" });
    }
  }, [url]);

  return (
    <div>
      <p style={{ color: "var(--text-mid)", marginBottom: "var(--s-3)" }}>
        Anyone with this link can redeem until it expires or you revoke it.
      </p>
      <div style={{ display: "flex", gap: "var(--s-2)" }}>
        <input className="rv-input" readOnly value={url} style={{ flex: 1, fontFamily: "var(--font-mono)" }} />
        <button className="rv-btn" data-variant="primary" onClick={() => void copy()}>
          Copy
        </button>
      </div>
      <button className="rv-btn" onClick={onClose} style={{ marginTop: "var(--s-4)", width: "100%" }}>Done</button>
    </div>
  );
}
