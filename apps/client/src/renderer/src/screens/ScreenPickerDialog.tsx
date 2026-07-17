import { useEffect, useState, type ReactElement } from "react";

interface Source {
  id: string;
  name: string;
  thumbnailDataUrl: string;
}

export function ScreenPickerDialog(): ReactElement {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await window.r3dvoice.listScreenSources();
        if (cancelled) return;
        setSources(list);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "failed to list sources");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function pick(id: string): Promise<void> {
    await window.r3dvoice.selectScreenSource(id);
  }

  async function cancel(): Promise<void> {
    await window.r3dvoice.cancelScreenPicker();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") void cancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const screens = sources.filter((s) => s.id.startsWith("screen:"));
  const windows = sources.filter((s) => s.id.startsWith("window:"));

  return (
    <div style={{ padding: 20, height: "100vh", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>Choose what to share</strong>
        <button className="rv-btn" onClick={() => void cancel()}>Cancel</button>
      </div>

      {loading && <div style={{ color: "var(--text-dim)" }}>Loading sources…</div>}
      {error && <div className="rv-err-banner" role="alert"><span className="ic">!</span><div>{error}</div></div>}

      {!loading && !error && (
        <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
          {screens.length > 0 && (
            <div>
              <div className="rv-label" style={{ margin: "var(--s-3) 0 var(--s-2)" }}>Screens</div>
              <SourceGrid sources={screens} onPick={(id) => void pick(id)} />
            </div>
          )}
          {windows.length > 0 && (
            <div>
              <div className="rv-label" style={{ margin: "var(--s-3) 0 var(--s-2)" }}>Windows</div>
              <SourceGrid sources={windows} onPick={(id) => void pick(id)} />
            </div>
          )}
          {sources.length === 0 && (
            <div style={{ color: "var(--text-dim)" }}>No sources available.</div>
          )}
        </div>
      )}
    </div>
  );
}

function SourceGrid({
  sources,
  onPick,
}: {
  sources: Source[];
  onPick: (id: string) => void;
}): ReactElement {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
        gap: 12,
      }}
    >
      {sources.map((s) => (
        <button
          key={s.id}
          onClick={() => onPick(s.id)}
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 8,
            cursor: "pointer",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            color: "var(--text)",
            font: "inherit",
          }}
        >
          <img
            src={s.thumbnailDataUrl}
            alt={s.name}
            style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "contain", background: "black", borderRadius: 4 }}
          />
          <div style={{ fontSize: 12, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {s.name}
          </div>
        </button>
      ))}
    </div>
  );
}
