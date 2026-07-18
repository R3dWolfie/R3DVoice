import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
  type RefObject,
  type ReactNode,
} from "react";
import { ApiClient } from "../lib/api.js";
import { useAuthStore } from "../lib/auth-context.js";
import { openMicPipeline, listVideoInputs, type DeviceInfo, type MicPipeline } from "../lib/media.js";
import {
  LiveKitRoom,
  RoomEvent,
  Track,
  setParticipantGain,
  registerParticipantGainElement,
  unregisterParticipantGain,
  setParticipantGainSink,
  type LocalParticipant,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type RoomStateSnapshot,
  type ScreenShareQuality,
  type ReceiverQuality,
} from "../lib/livekit-room.js";
import { RESOLUTIONS, type JoinSelection } from "../lib/join-selection.js";
import { SettingsModal } from "../components/SettingsModal.js";
import { usePrefs, prefsActions } from "../lib/prefs-singleton.js";
import type { LinuxAudioSourceSummary, WindowsAudioSessionInfo } from "../../../shared/bridge-types.js";
import { Avatar } from "../components/Avatar.js";
import { getPointersForShare, videoContentRect, pointerColor, type RemotePointer } from "../lib/pointer-overlay.js";
import { CopyLinkButton } from "../components/CopyLinkButton.js";
import { PeerProfilePopover } from "../components/PeerProfilePopover.js";
import { RoomInfoPanel } from "../components/RoomInfoPanel.js";
import { RoomE2EE } from "../lib/room-e2ee.js";
import { loadKeyPair } from "../lib/key-storage.js";
import { I } from "../components/Icons.js";
import { Spinner } from "../components/Primitives.js";
import { RoomChatPanel } from "../components/RoomChatPanel.js";
import { useKeybind } from "../lib/keybinds.js";
import { routeElement, setMonoOutput, setMonoOutputSink } from "../lib/mono-output.js";
import { pushToast } from "../lib/toast-store.js";
import { setCallStats } from "../lib/telemetry.js";

// True when the event started inside an element marked data-rv-pop — a menu,
// picker, or panel (or its trigger) that must survive the capture-phase
// outside-click closers below. stopPropagation can't do this job: the closers
// listen in the capture phase precisely so stray panels can't block them.
function inPop(e: Event): boolean {
  return e.composedPath().some((n) => n instanceof HTMLElement && n.dataset.rvPop !== undefined);
}


export interface InRoomScreenProps {
  roomId: string;
  selection: JoinSelection;
  onLeave(): void;
}

interface ConnectionState {
  phase: "connecting" | "connected" | "error";
  message?: string;
}

// 2.5j connecting overlay — real join phases, deck copy.
interface ConnStep {
  label: string;
  state: "pending" | "active" | "done";
  ms: number | null;
}

const CONN_STEP_LABELS = [
  "Authenticating",
  "Resolving SFU node",
  "Negotiating media",
  "Joining as muted",
] as const;

function freshConnSteps(): ConnStep[] {
  return CONN_STEP_LABELS.map((label, i) => ({
    label,
    state: i === 0 ? ("active" as const) : ("pending" as const),
    ms: null,
  }));
}

interface ParticipantView {
  id: string;
  name: string;
  isSpeaking: boolean;
  isLocal: boolean;
  muted: boolean;
  ghost: boolean;
  screenTrack: Track | null;
  cameraTrack: Track | null;
  /** LiveKit ConnectionQuality string: "unknown"|"poor"|"good"|"excellent"|"lost". */
  quality: string;
}

interface TileCallbacks {
  onClick(id: string): void;
  onDoubleClick(id: string, videoEl: HTMLVideoElement | null): void;
  onContextMenu(id: string, x: number, y: number): void;
  /** Pointer moved over a share tile — normalized [0..1] within the content. */
  onPointerMove?(shareId: string, x: number, y: number): void;
  onPointerLeave?(shareId: string): void;
}

// Renders remote viewers' pointers over a screenshare (the web version of
// "remote control"). Reads the pointer store on its own timer so it never
// re-renders the memoized Tile.
function PointerLayer({ shareId, videoRef }: { shareId: string; videoRef: RefObject<HTMLVideoElement | null> }): ReactElement | null {
  const [pointers, setPointers] = useState<RemotePointer[]>([]);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number }>({ x: 0, y: 0, w: 0, h: 0 });
  useEffect(() => {
    const t = setInterval(() => {
      // Bail out of both setStates when nothing actually moved — otherwise the
      // sharing tile re-renders ~22×/sec even with no pointers on screen.
      setPointers((prev) => {
        const next = getPointersForShare(shareId);
        if (
          prev.length === next.length &&
          prev.every((p, i) => {
            const q = next[i]!;
            return p.id === q.id && p.x === q.x && p.y === q.y && p.name === q.name;
          })
        ) {
          return prev;
        }
        return next;
      });
      if (videoRef.current) {
        const r = videoContentRect(videoRef.current);
        setRect((prev) =>
          prev.x === r.x && prev.y === r.y && prev.w === r.w && prev.h === r.h ? prev : r,
        );
      }
    }, 45);
    return () => clearInterval(t);
  }, [shareId, videoRef]);
  if (pointers.length === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 6 }}>
      {pointers.map((p) => {
        const color = pointerColor(p.id);
        return (
          <div
            key={p.id}
            style={{
              position: "absolute",
              left: rect.x + p.x * rect.w,
              top: rect.y + p.y * rect.h,
              transition: "left 45ms linear, top 45ms linear",
              transform: "translate(-2px, -2px)",
              display: "flex",
              alignItems: "flex-start",
              gap: 3,
            }}
          >
            {/* arrow cursor */}
            <svg width="16" height="16" viewBox="0 0 16 16" style={{ filter: "drop-shadow(0 1px 1px rgba(0,0,0,.5))" }}>
              <path d="M1 1 L1 12 L4.5 8.7 L7 14 L9 13 L6.6 7.9 L11 7.7 Z" fill={color} stroke="#fff" strokeWidth="1" />
            </svg>
            <span
              style={{
                background: color,
                color: "#fff",
                fontSize: 10,
                fontWeight: 600,
                padding: "1px 5px",
                borderRadius: 4,
                whiteSpace: "nowrap",
                boxShadow: "0 1px 2px rgba(0,0,0,.4)",
              }}
            >
              {p.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface VolumeMenu {
  participantId: string;
  x: number;
  y: number;
}

type LayoutMode = "auto" | "grid" | "speaker";

// Designer's kbd inline style — duplicated locally; will lift in a refactor.
const kbdStyle: CSSProperties = {
  display: "inline-block",
  padding: "1px 6px",
  border: "1px solid var(--border-strong)",
  borderRadius: 4,
  background: "var(--bg-elev-2)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--text)",
};

function fmtTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h > 0 ? String(h).padStart(2, "0") + ":" : ""}${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// Pretty-print an Electron-accelerator keybind for a tooltip: "Control+Shift+M"
// → "Ctrl+Shift+M". Returns `label (bind)` when a bind exists, else `label`.
function withBind(label: string, bind: string | null | undefined): string {
  if (!bind) return label;
  const pretty = bind.replace(/Control/g, "Ctrl").replace(/Super/g, "Cmd");
  return `${label} (${pretty})`;
}

// Screenshare tiers the in-room quality dialog offers (join-time also supports
// 4K, but the quick dialog keeps to the three most-used resolutions).
type ShareRes = "720p" | "1080p" | "1440p";
const SHARE_RES: ShareRes[] = ["720p", "1080p", "1440p"];
// Voice can be boosted to 200% (rides a GainNode above 100%); screen audio stays 0–100%.
const MAX_VOICE_PCT = 200;

function MaximizeIcon({ size = 14 }: { size?: number }): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

// Stable 1..5 avatar tone bucket from id.
function toneOf(id: string): 1 | 2 | 3 | 4 | 5 {
  return ((id.charCodeAt(0) % 5) + 1) as 1 | 2 | 3 | 4 | 5;
}

// Mirror of server-side dmThreadId — canonical-pair so both participants
// resolve the same thread. Server validates participation; this is just for
// constructing the URL/threadId on the client side.
function canonicalDmThreadId(a: string, b: string): string {
  const [first, second] = a < b ? [a, b] : [b, a];
  return `${first}:${second}`;
}

function findScreenTrack(p: LocalParticipant | RemoteParticipant): Track | null {
  for (const pub of p.trackPublications.values()) {
    // Muted publications still hold a track but produce no frames — the
    // <video> attached to it stays black. Treat them as absent so the tile
    // falls back to the avatar instead of showing a dead black rectangle.
    if (pub.source === Track.Source.ScreenShare && pub.track && !pub.isMuted) {
      return pub.track;
    }
  }
  return null;
}

function hasScreenShare(p: LocalParticipant | null): boolean {
  if (!p) return false;
  for (const pub of p.trackPublications.values()) {
    if (pub.source === Track.Source.ScreenShare) return true;
  }
  return false;
}

function findCameraTrack(p: LocalParticipant | RemoteParticipant): Track | null {
  for (const pub of p.trackPublications.values()) {
    if (pub.source === Track.Source.Camera && pub.track && !pub.isMuted) {
      return pub.track;
    }
  }
  return null;
}

// Best-effort remote-mic-muted check via audio publication state. Defaults to
// false when no audio publication is found (e.g. remote with no mic published).
function isRemoteMuted(p: RemoteParticipant): boolean {
  for (const pub of p.trackPublications.values()) {
    if (pub.source === Track.Source.Microphone) {
      return pub.isMuted;
    }
  }
  return false;
}

function MiniVu({ active }: { active: boolean }): ReactElement {
  // Off state: 4 flat bars (no animation, no varying height) — communicates
  // "mic on, not speaking" without distracting motion.
  // On state: varying heights with the live-pulse animation.
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 14 }}>
      {[0.4, 0.7, 1, 0.55].map((h, i) => (
        <span
          key={i}
          style={{
            width: 2,
            height: active ? `${h * 100}%` : "20%",
            background: active ? "var(--rv-live)" : "var(--rv-ink-400)",
            borderRadius: 1,
            animation: active ? `rv-vu-bar 0.${6 + i}s ease-in-out infinite alternate` : "none",
            animationDelay: `${i * 0.05}s`,
            boxShadow: active ? "0 0 4px var(--rv-live)" : "none",
          }}
        />
      ))}
    </div>
  );
}

// LiveKit ConnectionQuality enum: "unknown" | "poor" | "good" | "excellent" | "lost".
// Map to bar-count + tone for the NetMeter visualization.
function qualityToMeter(quality: string | undefined): { bars: number; tone: string } {
  switch (quality) {
    case "excellent":
      return { bars: 4, tone: "var(--rv-live)" };
    case "good":
      return { bars: 3, tone: "var(--rv-live)" };
    case "poor":
      return { bars: 2, tone: "var(--rv-amber)" };
    case "lost":
      return { bars: 1, tone: "var(--accent)" };
    default:
      return { bars: 0, tone: "var(--rv-ink-400)" };
  }
}

function NetMeter({ quality, height = 14 }: { quality: string | undefined; height?: number }): ReactElement {
  const { bars, tone } = qualityToMeter(quality);
  const sizes = height === 14 ? [6, 9, 12, 15] : [4, 6, 8, 10];
  return (
    <span style={{ display: "flex", alignItems: "flex-end", gap: 2, height, padding: "0 4px" }}>
      {sizes.map((h, i) => (
        <span
          key={i}
          style={{
            width: 3,
            height: h,
            background: i < bars ? tone : "var(--rv-ink-400)",
            borderRadius: 1,
            opacity: i < bars ? 1 : 0.4,
          }}
        />
      ))}
    </span>
  );
}

function KV({ label, value }: { label: string; value: ReactNode }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "4px 0",
        fontSize: "var(--t-xs)",
      }}
    >
      <span
        style={{
          color: "var(--text-faint)",
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: ".1em",
          fontSize: 10,
        }}
      >
        {label}
      </span>
      <span style={{ color: "var(--text-mid)" }}>{value}</span>
    </div>
  );
}

function CtxItem({
  children,
  danger,
  onClick,
  title,
}: {
  children: ReactNode;
  danger?: boolean;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  title?: string;
}): ReactElement {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "6px 8px",
        borderRadius: 6,
        border: 0,
        background: "transparent",
        cursor: "pointer",
        color: danger ? "var(--accent-glow)" : "var(--text)",
        fontSize: "var(--t-sm)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "color-mix(in oklch, var(--accent) 14%, transparent)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}

function TileImpl({
  tile,
  fill = false,
  big,
  callbacks,
}: {
  tile: ParticipantView;
  fill?: boolean;
  big: boolean;
  callbacks: TileCallbacks;
}): ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const camRef = useRef<HTMLVideoElement | null>(null);
  const [hover, setHover] = useState(false);
  const sharing = tile.screenTrack !== null;
  // Primary track to attach: screen if sharing, else camera. Camera-as-PiP-overlay
  // when both is rendered separately via camRef below.
  const primaryTrack = tile.screenTrack ?? tile.cameraTrack;
  const showCameraOverlay = sharing && tile.cameraTrack !== null;

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !primaryTrack) return;
    primaryTrack.attach(el);
    const applyDimensions = (): void => {
      const settings = primaryTrack.mediaStreamTrack.getSettings();
      if (settings.width && settings.height) {
        el.width = settings.width;
        el.height = settings.height;
      }
    };
    applyDimensions();
    const retry = setTimeout(applyDimensions, 500);
    return () => {
      clearTimeout(retry);
      primaryTrack.detach(el);
    };
  }, [primaryTrack]);

  useEffect(() => {
    const el = camRef.current;
    const track = tile.cameraTrack;
    if (!el || !track || !showCameraOverlay) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [tile.cameraTrack, showCameraOverlay]);

  function onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    callbacks.onContextMenu(tile.id, e.clientX, e.clientY);
  }

  function onDoubleClick(): void {
    callbacks.onDoubleClick(tile.id, videoRef.current);
  }

  function onClick(): void {
    callbacks.onClick(tile.id);
  }

  function onPointerMove(e: MouseEvent): void {
    if (!sharing || !callbacks.onPointerMove) return;
    const v = videoRef.current;
    if (!v) return;
    const box = v.getBoundingClientRect();
    const cr = videoContentRect(v);
    if (cr.w <= 0 || cr.h <= 0) return;
    const x = (e.clientX - box.left - cr.x) / cr.w;
    const y = (e.clientY - box.top - cr.y) / cr.h;
    if (x < 0 || x > 1 || y < 0 || y > 1) return; // pointer is in the letterbox
    callbacks.onPointerMove(tile.id, x, y);
  }

  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseMove={sharing ? onPointerMove : undefined}
      onMouseLeave={() => {
        setHover(false);
        if (sharing) callbacks.onPointerLeave?.(tile.id);
      }}
      title="Click to focus · double-click to fullscreen · right-click for volume"
      className={sharing ? "rv-scanlines" : ""}
      style={{
        position: "relative",
        // In fill mode, the parent grid drives sizing — tile stretches to
        // fill the cell and the video uses objectFit: contain so nothing
        // gets cropped (screenshares stay readable, cameras may letterbox).
        ...(fill
          ? { width: "100%", height: "100%", minHeight: 0 }
          : { aspectRatio: big ? "16/9" : "16/10" }),
        borderRadius: "var(--r-lg)",
        background: sharing
          ? "linear-gradient(180deg, oklch(0.18 0.04 22), oklch(0.10 0.02 22))"
          : "linear-gradient(180deg, var(--bg-elev), var(--bg-elev-2))",
        border:
          tile.isSpeaking && !sharing
            ? "1px solid color-mix(in oklch, var(--rv-live) 60%, var(--border))"
            : "1px solid var(--border-soft)",
        boxShadow:
          tile.isSpeaking && !sharing
            ? "0 0 0 2px color-mix(in oklch, var(--rv-live) 35%, transparent), 0 0 24px -8px var(--rv-live)"
            : sharing
              ? "0 0 0 2px color-mix(in oklch, var(--accent) 30%, transparent), 0 0 30px -10px var(--accent)"
              : "var(--shadow-2)",
        overflow: "hidden",
        transition: "box-shadow var(--d-mid) var(--ease-out), border-color var(--d-mid) var(--ease-out)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
      }}
    >
      {primaryTrack ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={tile.isLocal}
          style={{
            width: "100%",
            height: "100%",
            objectFit: sharing ? "contain" : "cover",
            background: "black",
            // Mirror only the local self-view of the camera (not screenshare)
            // so it reads like a mirror — raising your right hand shows on
            // the screen's right. Other participants still receive the
            // unmirrored feed.
            ...(tile.isLocal && !sharing
              ? { transform: "scaleX(-1)" }
              : {}),
          }}
        />
      ) : (
        <Avatar
          src={null}
          fallbackInitials={tile.name}
          fallbackColorSeed={tile.id}
          size={big ? 72 : 48}
        />
      )}
      {sharing && <PointerLayer shareId={tile.id} videoRef={videoRef} />}

      {showCameraOverlay && (
        <video
          ref={camRef}
          autoPlay
          playsInline
          muted={tile.isLocal}
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            width: "22%",
            aspectRatio: "16/9",
            borderRadius: "var(--r-md)",
            border: "1px solid var(--border)",
            objectFit: "cover",
            background: "black",
            boxShadow: "var(--shadow-2)",
          }}
        />
      )}

      <div
        style={{
          position: "absolute",
          left: 10,
          bottom: 10,
          right: 10,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          background: "color-mix(in oklch, var(--rv-ink-0) 65%, transparent)",
          backdropFilter: "blur(8px)",
          borderRadius: 999,
          border: "1px solid var(--border-soft)",
          fontSize: "var(--t-xs)",
          width: "fit-content",
        }}
      >
        {tile.muted ? (
          <I.MicOff size={10} style={{ color: "var(--accent-glow)" }} />
        ) : (
          <MiniVu active={tile.isSpeaking} />
        )}
        <span style={{ fontWeight: 500 }}>{tile.name}</span>
        {tile.isLocal && <span style={{ color: "var(--text-faint)" }}>· you</span>}
        <NetMeter quality={tile.quality} height={10} />
      </div>

      {sharing && (
        <div
          className="rv-corner-tag"
          style={{
            background: "color-mix(in oklch, var(--accent) 25%, transparent)",
            color: "var(--text)",
          }}
        >
          ◉ SHARING
        </div>
      )}

      {/* Hover maximize — fullscreen was previously double-click-only. Sits
          left of the PiP button when sharing so the two never overlap. */}
      <button
        type="button"
        aria-label="Maximize"
        title="Maximize (fullscreen)"
        onClick={(e) => {
          e.stopPropagation();
          callbacks.onDoubleClick(tile.id, videoRef.current);
        }}
        style={{
          position: "absolute",
          top: 8,
          right: sharing ? 44 : 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          background: "color-mix(in oklch, var(--rv-ink-0) 70%, transparent)",
          backdropFilter: "blur(8px)",
          border: "1px solid var(--border-soft)",
          borderRadius: 6,
          color: "var(--text)",
          cursor: "pointer",
          opacity: hover ? 1 : 0,
          transition: "opacity var(--d-mid) var(--ease-out)",
          pointerEvents: hover ? "auto" : "none",
        }}
      >
        <MaximizeIcon size={14} />
      </button>

      {sharing && (
        <button
          type="button"
          aria-label="Picture-in-picture"
          title="Picture-in-picture"
          onClick={async (e) => {
            e.stopPropagation();
            const v = videoRef.current;
            if (!v) return;
            try {
              if (document.pictureInPictureElement === v) {
                await document.exitPictureInPicture();
              } else {
                await v.requestPictureInPicture();
              }
            } catch {
              // PiP can fail if the video has no frame yet, or the OS denied.
              // Silent — the user can try again.
            }
          }}
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            background: "color-mix(in oklch, var(--rv-ink-0) 70%, transparent)",
            backdropFilter: "blur(8px)",
            border: "1px solid var(--border-soft)",
            borderRadius: 6,
            color: "var(--text)",
            cursor: "pointer",
          }}
        >
          <I.Pip size={14} />
        </button>
      )}
    </div>
  );
}

function GridLayout({
  people,
  callbacks,
}: {
  people: ParticipantView[];
  callbacks: TileCallbacks;
}): ReactElement {
  // Pick column count from container shape + tile count so tiles end up
  // roughly square in their grid cell — that's the rule that produces
  // "stack vertically in portrait, side-by-side in landscape" without
  // hardcoding orientation.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      const r = e.contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = Math.max(1, people.length);
  const cols = pickGridColumns(n, size.w, size.h);
  return (
    <div
      ref={containerRef}
      style={{
        display: "grid",
        gap: "var(--s-3)",
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridAutoRows: "minmax(0, 1fr)",
        height: "100%",
        minHeight: 0,
      }}
    >
      {people.map((p) => (
        <Tile key={p.id} tile={p} fill big={false} callbacks={callbacks} />
      ))}
    </div>
  );
}

/**
 * Pick the column count that gives the most cell-area for `n` tiles in
 * a `w×h` container. Each layout is scored by the area each cell can
 * occupy without distorting beyond a 16:9-ish ratio. Pure function so it
 * runs on every render — cheap.
 */
function pickGridColumns(n: number, w: number, h: number): number {
  if (n <= 1 || w <= 0 || h <= 0) return 1;
  let bestCols = 1;
  let bestArea = -1;
  for (let cols = 1; cols <= n; cols += 1) {
    const rows = Math.ceil(n / cols);
    const cellW = w / cols;
    const cellH = h / rows;
    // Tiles look best when the cell isn't extremely lopsided — penalise
    // wild aspect ratios so we don't prefer "1 tall column" just because
    // it gives more pixels.
    const aspect = cellW / cellH;
    const aspectPenalty = aspect > 3 || aspect < 1 / 3 ? 0.3 : 1;
    const area = cellW * cellH * aspectPenalty;
    if (area > bestArea) {
      bestArea = area;
      bestCols = cols;
    }
  }
  return bestCols;
}

function SpeakerLayout({
  people,
  sharer,
  focusedId,
  callbacks,
}: {
  people: ParticipantView[];
  sharer: ParticipantView | null;
  focusedId: string | null;
  callbacks: TileCallbacks;
}): ReactElement {
  // User's explicit click-to-focus wins over auto-pick (sharer → speaker → first).
  const userFocused = focusedId ? people.find((p) => p.id === focusedId) ?? null : null;
  const focus = userFocused ?? sharer ?? people.find((p) => p.isSpeaking) ?? people[0];
  if (!focus) {
    return <div />;
  }
  const rest = people.filter((p) => p.id !== focus.id);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr",
        gridTemplateRows: "1fr auto",
        gap: "var(--s-3)",
        height: "100%",
        minHeight: 420,
      }}
    >
      <Tile tile={focus} big callbacks={callbacks} />
      <div
        className="rv-scroll"
        style={{
          display: "grid",
          gridAutoFlow: "column",
          gridAutoColumns: "minmax(140px, 180px)",
          gap: "var(--s-3)",
          overflowX: "auto",
          paddingBottom: 4,
        }}
      >
        {rest.map((p) => (
          <div key={p.id} style={{ width: 180 }}>
            <Tile tile={p} big={false} callbacks={callbacks} />
          </div>
        ))}
      </div>
    </div>
  );
}

interface AudioSourceOption {
  pid: string;
  label: string;
}

function CameraControl({
  cameraOn,
  starting = false,
  disabled = false,
  roomWrapper,
  onToggle,
}: {
  cameraOn: boolean;
  starting?: boolean;
  disabled?: boolean;
  roomWrapper: LiveKitRoom;
  /** Toggle camera on/off — owned by the parent so it can flip optimistically. */
  onToggle: () => void;
}): ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [cameras, setCameras] = useState<DeviceInfo[]>([]);
  const selectedDeviceId = usePrefs((s) => s.cameraDeviceId);

  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      // If labels are blank (camera never accessed yet), prompt once so the
      // user gets named entries instead of "(unnamed device)".
      let list = await listVideoInputs();
      if (list.length > 0 && list.every((d) => d.label === "(unnamed device)")) {
        try {
          const probe = await navigator.mediaDevices.getUserMedia({ video: true });
          probe.getTracks().forEach((t) => t.stop());
          list = await listVideoInputs();
        } catch { /* permission denied — show whatever we have */ }
      }
      if (!cancelled) setCameras(list);
    };
    void load();
    return () => { cancelled = true; };
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    function onMouseDown(e: globalThis.MouseEvent): void {
      if (inPop(e)) return;
      setPickerOpen(false);
    }
    window.addEventListener("mousedown", onMouseDown, true);
    return () => window.removeEventListener("mousedown", onMouseDown, true);
  }, [pickerOpen]);

  async function pickCamera(deviceId: string): Promise<void> {
    setPickerOpen(false);
    prefsActions().setCameraDeviceId(deviceId);
    await roomWrapper.switchCamera(deviceId);
  }

  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 0 }}>
      <ControlButton
        icon={starting ? <Spinner /> : cameraOn ? <I.CameraOff size={20} /> : <I.Camera size={20} />}
        label={starting ? "Starting…" : cameraOn ? "Stop camera" : "Camera"}
        active={cameraOn}
        emphasis={cameraOn}
        disabled={disabled}
        title={starting ? "Starting camera…" : cameraOn ? "Stop camera" : "Start camera"}
        onClick={onToggle}
      />
      <button
        type="button"
        aria-label="Pick camera"
        title="Switch camera"
        data-rv-pop=""
        disabled={disabled}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setPickerOpen((v) => !v)}
        style={{
          appearance: "none",
          border: 0,
          background: "transparent",
          color: cameraOn ? "var(--text)" : "var(--text-faint)",
          cursor: disabled ? "not-allowed" : "pointer",
          padding: "0 4px",
          marginLeft: -6,
          height: "100%",
          display: "inline-flex",
          alignItems: "center",
        }}
      >
        <I.ChevronDown size={12} />
      </button>
      {pickerOpen && (
        <div
          data-rv-pop=""
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            zIndex: 30,
            minWidth: 240,
            maxHeight: 280,
            overflowY: "auto",
            padding: 4,
            background: "var(--bg-elev-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-md)",
            boxShadow: "var(--shadow-2)",
          }}
        >
          {cameras.length === 0 ? (
            <div style={{ padding: 10, color: "var(--text-faint)", fontSize: "var(--t-xs)" }}>
              No cameras detected.
            </div>
          ) : (
            cameras.map((c) => (
              <SourceMenuItem
                key={c.deviceId}
                active={selectedDeviceId === c.deviceId}
                onClick={() => void pickCamera(c.deviceId)}
              >
                {c.label}
              </SourceMenuItem>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ShareAudioControl({
  enabled,
  roomWrapper,
}: {
  enabled: boolean;
  roomWrapper: LiveKitRoom;
}): ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sources, setSources] = useState<AudioSourceOption[]>([]);
  const [selectedPid, setSelectedPid] = useState<string | null>(null);
  const platform = window.r3dvoice?.platform();
  const showPicker = platform === "linux" || platform === "win32";

  useEffect(() => {
    if (!pickerOpen || !showPicker) return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      let opts: AudioSourceOption[] = [];
      if (platform === "linux") {
        const list: LinuxAudioSourceSummary[] = await window.r3dvoice.listLinuxAudioSources();
        opts = list.map((s) => ({ pid: s.processId, label: s.appName }));
      } else if (platform === "win32") {
        const list: WindowsAudioSessionInfo[] = await window.r3dvoice.listWindowsAudioSessions();
        opts = list.map((s) => ({
          pid: String(s.pid),
          label: s.displayName?.trim() || s.imageName.replace(/\.exe$/i, ""),
        }));
      }
      if (!cancelled) setSources(opts);
    };
    void load();
    return () => { cancelled = true; };
  }, [pickerOpen, showPicker, platform]);

  // Close picker on outside click via the existing global handler.
  useEffect(() => {
    if (!pickerOpen) return;
    function onMouseDown(e: globalThis.MouseEvent): void {
      if (e.button !== 0 || inPop(e)) return;
      setPickerOpen(false);
    }
    window.addEventListener("mousedown", onMouseDown, true);
    return () => window.removeEventListener("mousedown", onMouseDown, true);
  }, [pickerOpen]);

  async function pickSource(pid: string | null): Promise<void> {
    setSelectedPid(pid);
    setPickerOpen(false);
    if (!enabled) return;
    // Re-link with new scope.
    await roomWrapper.disableScreenShareAudio();
    await roomWrapper.enableScreenShareAudio(pid ?? undefined);
  }

  const selectedLabel = selectedPid
    ? sources.find((s) => s.pid === selectedPid)?.label ?? `PID ${selectedPid}`
    : "All apps";

  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 0 }}>
      <ControlButton
        icon={<I.Speaker size={20} />}
        label={enabled ? "Stop audio" : "Share audio"}
        active={enabled}
        emphasis={enabled}
        title={
          enabled
            ? `Source: ${selectedLabel} — click to stop`
            : "Add system audio to your screen share"
        }
        onClick={() => {
          void (enabled
            ? roomWrapper.disableScreenShareAudio()
            : roomWrapper.enableScreenShareAudio(selectedPid ?? undefined));
        }}
      />
      {showPicker && (
        <button
          type="button"
          aria-label="Pick audio source"
          title="Pick which app's audio to share"
          onMouseDown={(e) => e.stopPropagation()}
          data-rv-pop=""
          onClick={() => setPickerOpen((v) => !v)}
          style={{
            appearance: "none",
            border: 0,
            background: "transparent",
            color: enabled ? "var(--text)" : "var(--text-faint)",
            cursor: "pointer",
            padding: "0 4px",
            marginLeft: -6,
            height: "100%",
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          <I.ChevronDown size={12} />
        </button>
      )}
      {pickerOpen && showPicker && (
        <div
          data-rv-pop=""
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            zIndex: 30,
            minWidth: 220,
            maxHeight: 280,
            overflowY: "auto",
            padding: 4,
            background: "var(--bg-elev-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-md)",
            boxShadow: "var(--shadow-2)",
          }}
        >
          <SourceMenuItem
            active={selectedPid === null}
            onClick={() => void pickSource(null)}
          >
            All apps <span style={{ color: "var(--text-faint)" }}>(except R3DVoice)</span>
          </SourceMenuItem>
          {sources.length === 0 ? (
            <div style={{ padding: 10, color: "var(--text-faint)", fontSize: "var(--t-xs)" }}>
              No apps producing audio right now.
            </div>
          ) : (
            sources.map((s) => (
              <SourceMenuItem
                key={`${s.label}-${s.pid}`}
                active={selectedPid === s.pid}
                onClick={() => void pickSource(s.pid)}
              >
                {s.label}
              </SourceMenuItem>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SourceMenuItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: "none",
        border: 0,
        cursor: "pointer",
        width: "100%",
        textAlign: "left",
        padding: "8px 10px",
        borderRadius: "var(--r-sm)",
        background: active ? "color-mix(in oklch, var(--accent) 20%, transparent)" : "transparent",
        color: active ? "var(--text)" : "var(--text-mid)",
        fontSize: "var(--t-sm)",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--bg-elev-3)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}

// Audio-only participant circle (2.5 audio-only-strip / 2.5b voice-only):
// dark plate, mono initials, mute-strike + ghost badge, speaking ring.
function AudioCircleImpl({
  tile,
  size,
  callbacks,
}: {
  tile: ParticipantView;
  size: number;
  callbacks: TileCallbacks;
}): ReactElement {
  const initials =
    tile.name
      .split(" ")
      .map((s) => s[0] ?? "")
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";
  return (
    <div
      title={`${tile.name}${tile.isLocal ? " (you)" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        callbacks.onContextMenu(tile.id, e.clientX, e.clientY);
      }}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--tile-bg)",
        border: "2px solid rgba(255,255,255,0.10)",
        display: "grid",
        placeItems: "center",
        fontFamily: "var(--font-mono)",
        fontSize: Math.round(size * 0.25),
        fontWeight: 700,
        color: "rgba(255,255,255,0.92)",
        position: "relative",
        flexShrink: 0,
        ...(tile.ghost ? { opacity: 0.55, filter: "saturate(0.4)" } : null),
        ...(tile.isSpeaking ? { boxShadow: "0 0 0 2px var(--rv-live)", borderColor: "transparent" } : null),
      }}
    >
      {initials}
      {tile.ghost ? (
        <span
          style={{
            position: "absolute",
            top: -4,
            right: -4,
            width: Math.max(18, size * 0.3),
            height: Math.max(18, size * 0.3),
            borderRadius: "50%",
            background: "var(--rv-amber)",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            fontSize: Math.max(10, size * 0.16),
            border: "2px solid var(--bg-elev-2)",
            lineHeight: 1,
          }}
        >
          👻
        </span>
      ) : tile.muted ? (
        <span
          style={{
            position: "absolute",
            top: -3,
            right: -3,
            width: Math.max(16, size * 0.26),
            height: Math.max(16, size * 0.26),
            borderRadius: "50%",
            background: "color-mix(in srgb, var(--danger) 95%, transparent)",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            border: "2px solid var(--bg-elev-2)",
          }}
        >
          <I.MicOff size={Math.max(9, Math.round(size * 0.15))} />
        </span>
      ) : null}
    </div>
  );
}

function ControlButton({
  icon,
  label,
  active,
  danger,
  leave,
  emphasis,
  disabled,
  onClick,
  title,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  danger?: boolean;
  leave?: boolean;
  emphasis?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
}): ReactElement {
  // Deck control bar (2.5): 48px circles, tiny mono label underneath.
  // active = filled ink · danger = red-tinted outline · leave = filled --leave.
  const bg = leave
    ? "var(--leave)"
    : danger
      ? "color-mix(in srgb, var(--danger) 10%, transparent)"
      : active || emphasis
        ? "var(--text)"
        : "var(--bg-elev)";
  const br = leave
    ? "var(--leave)"
    : danger
      ? "var(--danger)"
      : active || emphasis
        ? "var(--text)"
        : "var(--border)";
  const co = leave ? "#fff" : danger ? "var(--danger)" : active || emphasis ? "var(--bg)" : "var(--text)";
  // Instant hover + press feedback. Without this the buttons looked dead —
  // their state only changed after the LiveKit event round-tripped, so a click
  // felt like nothing happened. The press transform registers on pointerdown.
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={{
        appearance: "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        padding: 0,
        background: "transparent",
        border: 0,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        minWidth: "3.5rem",
      }}
    >
      <span
        style={{
          width: "3rem",
          height: "3rem",
          borderRadius: "50%",
          background: bg,
          border: `1px solid ${br}`,
          color: co,
          display: "grid",
          placeItems: "center",
          transition: "transform 80ms var(--ease-out), box-shadow 120ms var(--ease-out), filter 120ms var(--ease-out)",
          transform: pressed ? "scale(0.9)" : hover ? "scale(1.06)" : "scale(1)",
          filter: hover && !active && !emphasis && !leave && !danger ? "brightness(1.08)" : "none",
          boxShadow: hover ? "0 2px 10px rgba(0,0,0,0.18)" : "none",
        }}
      >
        {icon}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          letterSpacing: ".08em",
          textTransform: "uppercase",
          color: leave ? "var(--leave)" : "var(--text-dim)",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
    </button>
  );
}

// Memoized tile boundaries — the fix for the in-call re-render storm. The
// parent re-renders many times/sec (speaker/RTT/quality events); without these
// every tile's large style tree reconciled on each render, starving click
// handlers. The comparator checks only the fields the tiles read; screenTrack/
// cameraTrack are stable LiveKit Track refs so === is correct.
function tilePropsEqual(
  a: { tile: ParticipantView; callbacks: TileCallbacks; fill?: boolean; big?: boolean; size?: number },
  b: { tile: ParticipantView; callbacks: TileCallbacks; fill?: boolean; big?: boolean; size?: number },
): boolean {
  return (
    a.callbacks === b.callbacks &&
    a.fill === b.fill &&
    a.big === b.big &&
    a.size === b.size &&
    a.tile.id === b.tile.id &&
    a.tile.name === b.tile.name &&
    a.tile.isSpeaking === b.tile.isSpeaking &&
    a.tile.isLocal === b.tile.isLocal &&
    a.tile.muted === b.tile.muted &&
    a.tile.ghost === b.tile.ghost &&
    a.tile.quality === b.tile.quality &&
    a.tile.screenTrack === b.tile.screenTrack &&
    a.tile.cameraTrack === b.tile.cameraTrack
  );
}
const Tile = memo(TileImpl, tilePropsEqual);
const AudioCircle = memo(AudioCircleImpl, tilePropsEqual);

// Small 3-ish-segment control (Auto/Grid/Speaker, resolution, fps). The active
// segment is filled with --accent so it reads as "lit".
function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  translucent = false,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
  translucent?: boolean;
}): ReactElement {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      style={{
        display: "inline-flex",
        padding: 3,
        gap: 2,
        background: translucent ? "transparent" : "var(--bg-elev)",
        border: translucent ? 0 : "1px solid var(--border-soft)",
        borderRadius: "var(--r-md)",
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={active}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => onChange(o.value)}
            style={{
              appearance: "none",
              border: 0,
              cursor: "pointer",
              padding: "5px 11px",
              borderRadius: 5,
              background: active ? "var(--accent)" : "transparent",
              color: active ? "var(--on-accent)" : "var(--text-dim)",
              fontSize: "var(--t-xs)",
              fontFamily: "var(--font-mono)",
              letterSpacing: ".06em",
              textTransform: "uppercase",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              transition: "background var(--d-fast) var(--ease-out), color var(--d-fast) var(--ease-out)",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// In-call screenshare quality picker (2.x): resolution · fps · system audio.
// Reuses the persisted resolution/frameRate/shareAudio prefs as the last-used
// defaults and writes them back on confirm.
function ScreenShareDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (q: ScreenShareQuality) => void;
  onCancel: () => void;
}): ReactElement {
  const prefRes = usePrefs((s) => s.resolution);
  const prefFps = usePrefs((s) => s.frameRate);
  const prefShareAudio = usePrefs((s) => s.shareAudio);
  const [res, setRes] = useState<ShareRes>(
    SHARE_RES.includes(prefRes as ShareRes) ? (prefRes as ShareRes) : "1080p",
  );
  const [fps, setFps] = useState<30 | 60>(prefFps === 60 ? 60 : 30);
  const [withAudio, setWithAudio] = useState(prefShareAudio);

  function confirm(): void {
    const dims = RESOLUTIONS[res] ?? RESOLUTIONS["1080p"]!;
    prefsActions().setResolution(res);
    prefsActions().setFrameRate(fps);
    prefsActions().setShareAudio(withAudio);
    onConfirm({
      width: dims.width,
      height: dims.height,
      frameRate: fps,
      audioSource: withAudio ? "all" : null,
    });
  }

  return (
    <div
      data-rv-pop=""
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in oklch, var(--rv-ink-0) 70%, transparent)",
        zIndex: 400,
        display: "grid",
        placeItems: "center",
      }}
    >
      <div
        className="rv-card"
        style={{ padding: "var(--s-6)", width: "min(100%, 26rem)" }}
      >
        <div style={{ fontSize: "var(--t-lg)", fontWeight: 600, marginBottom: "var(--s-2)" }}>
          Share your screen
        </div>
        <div style={{ color: "var(--text-mid)", fontSize: "var(--t-sm)", marginBottom: "var(--s-5)" }}>
          Pick a quality — higher settings need more upload bandwidth.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="rv-label" style={{ fontSize: "var(--t-2xs)" }}>Resolution</span>
            <Segmented
              ariaLabel="Resolution"
              value={res}
              onChange={setRes}
              options={SHARE_RES.map((r) => ({ value: r, label: r }))}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="rv-label" style={{ fontSize: "var(--t-2xs)" }}>Frame rate</span>
            <Segmented<30 | 60>
              ariaLabel="Frame rate"
              value={fps}
              onChange={setFps}
              options={[
                { value: 30, label: "30 fps" },
                { value: 60, label: "60 fps" },
              ]}
            />
          </label>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--s-3)",
              cursor: "pointer",
              fontSize: "var(--t-sm)",
            }}
          >
            <input
              type="checkbox"
              checked={withAudio}
              onChange={(e) => setWithAudio(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: "var(--accent)" }}
            />
            Also share app / system audio
          </label>
        </div>

        <div style={{ display: "flex", gap: "var(--s-3)", justifyContent: "flex-end", marginTop: "var(--s-6)" }}>
          <button type="button" className="rv-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="rv-btn" data-variant="primary" onClick={confirm}>
            Share
          </button>
        </div>
      </div>
    </div>
  );
}

export function InRoomScreen(props: InRoomScreenProps): ReactElement {
  const token = useAuthStore((s) => s.token);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const user = useAuthStore((s) => s.user);

  const roomWrapper = useMemo(() => new LiveKitRoom(), []);
  const [conn, setConn] = useState<ConnectionState>({ phase: "connecting" });
  const [connSteps, setConnSteps] = useState<ConnStep[]>(freshConnSteps);
  // Bumped by the error state's "Try again" to re-run the join effect.
  const [retryNonce, setRetryNonce] = useState(0);
  const cancelRequestedRef = useRef(false);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  // Click your own tile to minimize your self-view out of the grid (Discord
  // behaviour); a floating thumbnail restores it.
  const [selfMinimized, setSelfMinimized] = useState(false);
  // Collaborative pointer ("remote control", web-realistic): show my cursor on
  // a screenshare to everyone. Ref mirror so the memoized tileCallbacks can read
  // it without rebuilding; throttle ref caps broadcast to ~25 Hz.
  const [showMyPointer, setShowMyPointer] = useState(false);
  const showMyPointerRef = useRef(false);
  showMyPointerRef.current = showMyPointer;
  const lastPtrSentRef = useRef(0);
  const persistedParticipantVolumes = usePrefs((s) => s.participantVolumes);
  const persistedScreenVolumes = usePrefs((s) => s.participantScreenVolumes);
  const persistedParticipantGains = usePrefs((s) => s.participantGains);
  // Local voice-volume state holds the COMBINED 0–2 value (element.volume ≤1
  // plus any GainNode boost >1). Reconstruct it from the two persisted maps:
  // a stored gain >1 means the slider was above 100%.
  const [voiceVolumes, setVoiceVolumes] = useState<Record<string, number>>(() => {
    const out: Record<string, number> = { ...persistedParticipantVolumes };
    for (const [id, g] of Object.entries(persistedParticipantGains)) {
      if (g > 1) out[id] = Math.min(g, MAX_VOICE_PCT / 100);
    }
    return out;
  });
  const [screenVolumes, setScreenVolumes] = useState<Record<string, number>>(persistedScreenVolumes);
  // 2.5g "Mute for me" — local-only silence per participant (not persisted).
  const [mutedForMe, setMutedForMe] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<VolumeMenu | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [roomInCall, setRoomInCall] = useState<number | null>(null);
  const [profileTarget, setProfileTarget] = useState<{ id: string; handle: string | null; displayName: string } | null>(null);
  const [dmTarget, setDmTarget] = useState<{ id: string; name: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [netStats, setNetStats] = useState<{
    rttMs: number | null;
    jitterMs: number | null;
    packetsLost: number | null;
  } | null>(null);
  const [layout, setLayout] = useState<LayoutMode>("auto");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // #8 two-sided resolution — per-participant receiver-side quality override.
  const [receiverQuality, setReceiverQuality] = useState<Record<string, ReceiverQuality>>({});
  const applyReceiverQuality = (participantId: string, q: ReceiverQuality): void => {
    setReceiverQuality((m) => ({ ...m, [participantId]: q }));
    // Applies to whichever video they're sending; the other is a harmless no-op.
    roomWrapper.setRemoteVideoQuality(participantId, "screen", q);
    roomWrapper.setRemoteVideoQuality(participantId, "camera", q);
  };
  const [roomInfoOpen, setRoomInfoOpen] = useState(false);
  const [psearch, setPsearch] = useState("");
  // In-call screenshare quality dialog (2.x).
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  // Owner-only participant actions (remove / transfer) live behind an inline
  // confirm so a stray click can't eject someone.
  const [isRoomOwner, setIsRoomOwner] = useState(false);
  const [ownerConfirm, setOwnerConfirm] = useState<{
    kind: "remove" | "transfer";
    id: string;
    name: string;
  } | null>(null);
  // One-time "you're muted" nudge (first ~minute, until the first unmute).
  const [muteHintDismissed, setMuteHintDismissed] = useState(false);
  const [everUnmuted, setEverUnmuted] = useState(false);
  // Optimistic mic/camera state — flips on click, reconciles when the real
  // LiveKit snapshot catches up (null = trust the snapshot).
  const [pendingMute, setPendingMute] = useState<boolean | null>(null);
  const [pendingCam, setPendingCam] = useState<boolean | null>(null);

  const snapshot: RoomStateSnapshot = useSyncExternalStore(
    (cb) => roomWrapper.subscribe(() => cb()),
    () => roomWrapper.snapshot(),
    () => roomWrapper.snapshot(),
  );

  // Ghost also deafens (silences all incoming audio). Hoisted here so the
  // volume-apply effects below can respect it.
  const deafened = snapshot.local?.attributes?.["ghost"] === "1";

  const audioMountRef = useRef<HTMLDivElement | null>(null);
  const e2eeSessionRef = useRef<RoomE2EE | null>(null);
  const micPipelineRef = useRef<MicPipeline | null>(null);

  useEffect(() => {
    const api = new ApiClient(serverUrl); api.setToken(token);
    void api.setPresence(props.roomId);
    return () => { void api.setPresence(null); };
  }, [props.roomId, serverUrl, token]);

  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const stats = await roomWrapper.getNetworkStats();
        if (!cancelled && stats) {
          setNetStats({
            rttMs: stats.rttMs,
            jitterMs: stats.jitterMs,
            packetsLost: stats.packetsLost,
          });
          // Feed the diagnostics HUD (Ctrl+Shift+D).
          setCallStats({
            rttMs: stats.rttMs != null ? Math.round(stats.rttMs) : null,
            packetLossPct: null,
            videoFps: null,
            videoRes: null,
            freezes: null,
            bitrateKbps: stats.bitrateKbps ?? null,
          });
        }
      } catch { /* */ }
    };
    void tick();
    const interval = setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      setCallStats(null);
    };
  }, [roomWrapper, conn.phase]);

  useEffect(() => {
    let cancelled = false;
    // 2.5j step-list: reset, then mark real phases done as they complete.
    setConnSteps(freshConnSteps());
    let stepStart = performance.now();
    const stepDone = (i: number): void => {
      const now = performance.now();
      const ms = Math.round(now - stepStart);
      stepStart = now;
      if (cancelled) return;
      setConnSteps((prev) =>
        prev.map((s, j) =>
          j === i ? { ...s, state: "done", ms } : j === i + 1 && s.state === "pending" ? { ...s, state: "active" } : s,
        ),
      );
    };
    (async () => {
      try {
        const api = new ApiClient(serverUrl);
        api.setToken(token);
        const { token: lkToken, url } = await api.mintLiveKitToken(props.roomId);
        stepDone(0); // Authenticating — server minted our LiveKit token
        if (cancelled) return;
        let micStream: MediaStream | undefined;
        if (props.selection.micDeviceId) {
          const pipeline = await openMicPipeline(props.selection.micDeviceId, {
            noiseSuppression: micProcessing.noiseSuppression,
            echoCancellation: micProcessing.echoCancellation,
            autoGainControl: micProcessing.autoGainControl,
            gain: micProcessing.gain,
            mono: micProcessing.mono,
            vad: { enabled: micProcessing.vadEnabled, threshold: micProcessing.inputSensitivity },
          });
          micPipelineRef.current = pipeline;
          micStream = pipeline.stream;
        }
        stepDone(1); // Resolving SFU node — url in hand, local media prepped

        await roomWrapper.join({
          wsUrl: url,
          token: lkToken,
          ...(micStream !== undefined && { micStream }),
          publishAudio: true,
          publishScreen: props.selection.publishScreen,
          screenQuality: props.selection.screenQuality,
        });
        stepDone(2); // Negotiating media — SFU connection is up

        // Deck rule (4.5 removed): every join starts muted. Mute right after
        // publish so no audio frames leave before the user opts in.
        if (props.selection.startMuted && !cancelled) {
          await roomWrapper.setMuted(true);
        }
        stepDone(3); // Joining as muted

        // Kick off E2EE key distribution. Owner generates the room key;
        // members request it from peers. Best-effort: if our keypair is
        // missing or the server/owner hasn't authorized us, the room
        // simply runs in plaintext.
        try {
          const roomMeta = await api.getRoom(props.roomId);
          const keyPair = loadKeyPair();
          if (keyPair) {
            const e2ee = new RoomE2EE({
              roomWrapper,
              isOwner: roomMeta.isOwner,
              keyPair,
              onKeyApplied: () => {
                // eslint-disable-next-line no-console
                console.log("[e2ee] room key applied — frames now SFrame-encrypted");
              },
              onError: (err) => {
                // eslint-disable-next-line no-console
                console.warn("[e2ee] failed to apply key:", err.message);
              },
            });
            await e2ee.start();
            e2eeSessionRef.current = e2ee;
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[e2ee] setup skipped:", err);
        }

        if (!cancelled) setConn({ phase: "connected" });
      } catch (err) {
        if (cancelled || cancelRequestedRef.current) return;
        setConn({
          phase: "error",
          message: err instanceof Error ? err.message : "failed to connect",
        });
      }
    })();
    return () => {
      cancelled = true;
      void roomWrapper.leave();
    };
  }, [roomWrapper, props.roomId, props.selection, token, serverUrl, retryNonce]);

  useEffect(() => {
    const room = roomWrapper.room;
    const mount = audioMountRef.current;
    if (!mount) return;

    const onTrackSubscribed = (
      track: Track,
      pub: RemoteTrackPublication,
      participant: RemoteParticipant,
    ): void => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach() as HTMLAudioElement;
      el.autoplay = true;
      (el as HTMLElement & { playsInline?: boolean }).playsInline = true;
      mount.appendChild(el);
      routeElement(el); // no-op unless mono output has been enabled
      // Register the mic element with the gain graph so a saved/new >100%
      // boost can ride a GainNode (element.volume can't exceed 1).
      if (pub.source === Track.Source.Microphone) {
        registerParticipantGainElement(participant.identity, el);
        const g = prefsActions().participantGains[participant.identity];
        if (g !== undefined && g > 1) {
          setParticipantGain(participant.identity, Math.min(g, MAX_VOICE_PCT / 100));
        }
      }
    };
    const onTrackUnsubscribed = (
      track: Track,
      pub: RemoteTrackPublication,
      participant: RemoteParticipant,
    ): void => {
      if (track.kind !== Track.Kind.Audio) return;
      track.detach().forEach((el) => el.remove());
      if (pub.source === Track.Source.Microphone) {
        unregisterParticipantGain(participant.identity);
      }
    };

    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
    return () => {
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      room.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
    };
  }, [roomWrapper]);

  // Room name for the deck top bar (2.5: title, click for room panel).
  useEffect(() => {
    let cancelled = false;
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    api
      .getRoom(props.roomId)
      .then((r) => {
        if (!cancelled) {
          setRoomName(r.name);
          setRoomInCall(r.inCall ?? null);
          setIsRoomOwner(r.isOwner);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [props.roomId, serverUrl, token]);

  const pttKeybind = usePrefs((s) => s.pttKeybind);
  const muteKeybind = usePrefs((s) => s.muteKeybind);
  const deafenKeybind = usePrefs((s) => s.deafenKeybind);
  const shareScreenKeybind = usePrefs((s) => s.shareScreenKeybind);
  const openSettingsKeybind = usePrefs((s) => s.openSettingsKeybind);
  const leaveRoomKeybind = usePrefs((s) => s.leaveRoomKeybind);
  const prefMic = usePrefs((s) => s.micDeviceId);
  const cameraDeviceId = usePrefs((s) => s.cameraDeviceId);
  // Select primitives individually — a selector that returns a fresh object
  // literal triggers React #185 because useSyncExternalStore's Object.is
  // snapshot check sees a new reference every render and loops forever.
  const noiseSuppression = usePrefs((s) => s.noiseSuppression);
  const echoCancellation = usePrefs((s) => s.echoCancellation);
  const autoGainControl = usePrefs((s) => s.autoGainControl);
  const micGain = usePrefs((s) => s.micGain);
  const monoInput = usePrefs((s) => s.monoInput);
  const vadEnabled = usePrefs((s) => s.vadEnabled);
  const inputSensitivity = usePrefs((s) => s.inputSensitivity);
  const micProcessing = useMemo(
    () => ({ noiseSuppression, echoCancellation, autoGainControl, gain: micGain, mono: monoInput, vadEnabled, inputSensitivity }),
    [noiseSuppression, echoCancellation, autoGainControl, micGain, monoInput, vadEnabled, inputSensitivity],
  );
  useEffect(() => {
    if (conn.phase === "connected" && prefMic) {
      void roomWrapper.room.switchActiveDevice("audioinput", prefMic);
    }
  }, [prefMic, conn.phase, roomWrapper]);

  const prefSpeaker = usePrefs((s) => s.speakerDeviceId);
  const monoOutput = usePrefs((s) => s.monoOutput);
  useEffect(() => {
    setMonoOutput(monoOutput, audioMountRef.current);
    if (monoOutput) void setMonoOutputSink(prefSpeaker);
  }, [monoOutput, prefSpeaker]);
  const favoriteRoomIds = usePrefs((s) => s.favoriteRoomIds);
  const isFavorite = favoriteRoomIds.includes(props.roomId);
  useEffect(() => {
    if (conn.phase === "connected" && prefSpeaker) {
      void roomWrapper.room.switchActiveDevice("audiooutput", prefSpeaker);
    }
    // Captured (boosted) mic elements play through the gain graph's
    // AudioContext, whose sink LiveKit's switchActiveDevice can't reach.
    void setParticipantGainSink(prefSpeaker);
  }, [prefSpeaker, conn.phase, roomWrapper]);

  useEffect(() => {
    const cleanup = window.r3dvoice.onPttEvent((pressed) => {
      void roomWrapper.setMuted(!pressed);
    });
    return cleanup;
  }, [roomWrapper]);

  // ESC closes maximize / menu.
  // Left-click (button 0) outside the menu closes it — ignore right-clicks
  // and middle-clicks so the menu doesn't close the moment it opens.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        setMaximizedId(null);
        setMenu(null);
        setFocusedId(null);
        setRoomInfoOpen(false);
      }
    }
    function onMouseDown(e: globalThis.MouseEvent): void {
      if (e.button !== 0 || inPop(e)) return;
      setMenu(null);
      setRoomInfoOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown, true);
    };
  }, []);

  // Sync maximizedId with the browser fullscreen state: if user presses ESC or
  // exits OS fullscreen by other means, clear our maximized state too.
  useEffect(() => {
    function onFsChange(): void {
      if (!document.fullscreenElement) {
        setMaximizedId(null);
      }
    }
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  async function handleLeave(): Promise<void> {
    if (e2eeSessionRef.current) {
      e2eeSessionRef.current.stop();
      e2eeSessionRef.current = null;
    }
    if (micPipelineRef.current) {
      micPipelineRef.current.close();
      micPipelineRef.current = null;
    }
    await roomWrapper.leave();
    props.onLeave();
  }

  // Owner-only moderation. The LiveKit participant identity == the server
  // userId (see mintLiveKitToken), so the tile id is exactly what the room
  // member APIs expect. The SFU disconnect is driven by the server on removal.
  async function handleRemoveMember(id: string): Promise<void> {
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    try {
      await api.removeRoomMember(props.roomId, id);
      pushToast({ kind: "success", text: "Removed from room" });
    } catch (err) {
      pushToast({ kind: "error", text: "Couldn't remove member", sub: err instanceof Error ? err.message : String(err) });
    }
  }
  async function handleTransferOwnership(id: string): Promise<void> {
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    try {
      await api.transferRoomOwnership(props.roomId, id);
      setIsRoomOwner(false);
      pushToast({ kind: "success", text: "Ownership transferred" });
    } catch (err) {
      pushToast({ kind: "error", text: "Couldn't transfer ownership", sub: err instanceof Error ? err.message : String(err) });
    }
  }

  // Live-apply mic-gain pref changes: when the user moves the slider in
  // Settings, the change reaches the published track via the GainNode in
  // the MicPipeline without re-opening the mic.
  useEffect(() => {
    micPipelineRef.current?.setGain(micProcessing.gain);
  }, [micProcessing.gain]);

  // Live-apply VAD (Advanced Voice Activity + input sensitivity) without
  // re-opening the mic.
  useEffect(() => {
    micPipelineRef.current?.setVad(micProcessing.vadEnabled, micProcessing.inputSensitivity);
  }, [micProcessing.vadEnabled, micProcessing.inputSensitivity]);

  // Server-initiated disconnect (owner removed us, owner deleted the room,
  // server shutdown) — show a banner for a beat then bounce back to lobby.
  useEffect(() => {
    if (!snapshot.disconnectKind) return;
    const t = setTimeout(() => {
      void handleLeave();
    }, 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.disconnectKind]);

  async function handleToggleScreen(): Promise<void> {
    if (hasScreenShare(snapshot.local)) {
      // Already sharing → stop immediately (no dialog).
      try {
        await roomWrapper.setScreenShare(false);
      } catch (err) {
        pushToast({ kind: "error", text: "Couldn't stop screen share", sub: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      }
      return;
    }
    // Not sharing → open the quality/source picker before publishing.
    setShareDialogOpen(true);
  }

  async function startScreenShareWithQuality(q: ScreenShareQuality): Promise<void> {
    setShareDialogOpen(false);
    try {
      await roomWrapper.setScreenShare(true, q);
    } catch (err) {
      // getDisplayMedia rejects on cancel (fine) or a real failure (surface it).
      if (err instanceof DOMException && err.name === "NotAllowedError") return;
      pushToast({ kind: "error", text: "Couldn't start screen share", sub: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    }
  }

  // Wire prefs-driven keybinds for the in-room actions. PTT remains separate
  // (uses globalShortcut so it works when unfocused).
  useKeybind(muteKeybind, () => handleToggleMute());
  // Deck: Ghost replaces Deafen — the old deafen keybind now toggles ghost.
  useKeybind(deafenKeybind, () => void roomWrapper.setGhost(!(snapshot.local?.attributes?.["ghost"] === "1")));
  useKeybind(shareScreenKeybind, () => void handleToggleScreen());
  useKeybind(openSettingsKeybind, () => setSettingsOpen(true));
  useKeybind(leaveRoomKeybind, () => void handleLeave());

  // LiveKit's setVolume eventually writes HTMLMediaElement.volume which is
  // clamped to [0, 1] *and throws IndexSizeError* if outside that range —
  // so anything we forward must be clamped first. (Earlier versions of the
  // slider went to 200%; saved values like 1.1 then crashed remotes' React
  // tree on track-subscribe.)
  function clampVol(v: number): number {
    if (!Number.isFinite(v) || v < 0) return 0;
    return v > 1 ? 1 : v;
  }

  function setVoiceVolume(id: string, volume: number): void {
    // Combined 0..2. element.volume carries 0..1 (LiveKit setVolume); the
    // 100–200% band rides a per-participant GainNode (element.volume throws
    // above 1). elVol × gain reconstructs the combined value at the output.
    const combined =
      Number.isFinite(volume) && volume > 0 ? Math.min(volume, MAX_VOICE_PCT / 100) : 0;
    const elVol = Math.min(combined, 1);
    const gain = combined > 1 ? combined : 1;
    // Dragging a slider implicitly lifts a local "Mute for me".
    setMutedForMe((prev) => (prev[id] ? { ...prev, [id]: false } : prev));
    setVoiceVolumes((prev) => ({ ...prev, [id]: combined }));
    prefsActions().setParticipantVolume(id, elVol);
    prefsActions().setParticipantGain(id, gain);
    const participant = snapshot.remotes.find((r) => r.identity === id);
    if (participant) participant.setVolume(elVol, Track.Source.Microphone);
    setParticipantGain(id, gain);
    // A boost may have just created the gain graph's AudioContext — point it at
    // the selected speaker (its sink defaults to the system output otherwise).
    if (gain > 1) void setParticipantGainSink(prefSpeaker);
  }

  // Apply saved per-participant volumes whenever a remote subscribes — keeps
  // user-set volumes sticky across rejoins / new sessions. Participants the
  // user muted-for-me stay at 0 until they unmute them.
  useEffect(() => {
    if (deafened) return; // ghost/deafen zeroes everything (effect below)
    for (const remote of snapshot.remotes) {
      if (mutedForMe[remote.identity]) continue;
      const raw = persistedParticipantVolumes[remote.identity];
      if (raw !== undefined) {
        const v = clampVol(raw);
        if (v !== 1) remote.setVolume(v, Track.Source.Microphone);
      }
      // Re-apply any saved >100% boost onto the GainNode (0..1 rode setVolume).
      const g = persistedParticipantGains[remote.identity];
      if (g !== undefined && g > 1) setParticipantGain(remote.identity, Math.min(g, MAX_VOICE_PCT / 100));
    }
  }, [snapshot.remotes, persistedParticipantVolumes, persistedParticipantGains, mutedForMe, deafened]);

  // Ghost = deafen (Red's ask): silence all incoming mic + screen audio while
  // ghosted; when un-ghosting, restore saved per-participant volumes (and
  // full volume for anyone without a saved override), unless muted-for-me.
  useEffect(() => {
    for (const remote of snapshot.remotes) {
      if (deafened) {
        remote.setVolume(0, Track.Source.Microphone);
        remote.setVolume(0, Track.Source.ScreenShareAudio);
      } else if (!mutedForMe[remote.identity]) {
        remote.setVolume(clampVol(persistedParticipantVolumes[remote.identity] ?? 1), Track.Source.Microphone);
        remote.setVolume(clampVol(persistedScreenVolumes[remote.identity] ?? 1), Track.Source.ScreenShareAudio);
        const g = persistedParticipantGains[remote.identity] ?? 1;
        setParticipantGain(remote.identity, g > 1 ? Math.min(g, MAX_VOICE_PCT / 100) : 1);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deafened, snapshot.remotes]);

  function setScreenVolume(id: string, volume: number): void {
    const v = clampVol(volume);
    setMutedForMe((prev) => (prev[id] ? { ...prev, [id]: false } : prev));
    setScreenVolumes((prev) => ({ ...prev, [id]: v }));
    prefsActions().setParticipantScreenVolume(id, v);
    const participant = snapshot.remotes.find((r) => r.identity === id);
    if (participant) {
      participant.setVolume(v, Track.Source.ScreenShareAudio);
    }
  }

  // Apply saved screen-audio volumes whenever a remote subscribes.
  useEffect(() => {
    if (deafened) return;
    for (const remote of snapshot.remotes) {
      if (mutedForMe[remote.identity]) continue;
      const raw = persistedScreenVolumes[remote.identity];
      if (raw === undefined) continue;
      const v = clampVol(raw);
      if (v === 1) continue;
      remote.setVolume(v, Track.Source.ScreenShareAudio);
    }
  }, [snapshot.remotes, persistedScreenVolumes, mutedForMe, deafened]);

  // 2.5g "Mute for me": local-only — zero this participant's audio on our
  // end via RemoteParticipant.setVolume; nothing changes for anyone else.
  // Restores the previously saved per-source volumes on unmute.
  function setMuteForMe(id: string, mute: boolean): void {
    setMutedForMe((prev) => ({ ...prev, [id]: mute }));
    const participant = snapshot.remotes.find((r) => r.identity === id);
    if (!participant) return;
    if (mute) {
      participant.setVolume(0, Track.Source.Microphone);
      participant.setVolume(0, Track.Source.ScreenShareAudio);
    } else {
      const combined = voiceVolumes[id] ?? 1;
      participant.setVolume(clampVol(combined), Track.Source.Microphone);
      participant.setVolume(clampVol(screenVolumes[id] ?? 1), Track.Source.ScreenShareAudio);
      setParticipantGain(id, combined > 1 ? Math.min(combined, MAX_VOICE_PCT / 100) : 1);
    }
  }

  // Stable callbacks — required for the Tile memo comparator to skip renders.
  // The only render-varying read (our own identity) goes through a ref so the
  // object itself can be built once ([] deps; setState updaters are stable).
  const localIdentityRef = useRef<string | undefined>(undefined);
  localIdentityRef.current = snapshot.local?.identity;
  const tileCallbacks: TileCallbacks = useMemo(
    () => ({
      onClick: (id) => {
        // Discord mechanic: left-click ANY tile (including your own) toggles
        // the spotlight — focus one person big, click the same tile again to
        // drop back to the grid showing everyone; click a different tile to
        // switch focus. Uniform for all tiles. Per-person actions (volume,
        // mute-for-me, hide-my-video, …) live in the right-click menu, so
        // left-click stays a pure focus toggle.
        setFocusedId((current) => (current === id ? null : id));
      },
      onDoubleClick: (id, videoEl) => {
        if (videoEl && !document.fullscreenElement) {
          setMaximizedId(id);
          void videoEl.requestFullscreen().catch(() => {});
          return;
        }
        if (document.fullscreenElement) {
          void document.exitFullscreen();
          return;
        }
        setMaximizedId((current) => (current === id ? null : id));
      },
      onContextMenu: (id, x, y) => {
        setMenu({ participantId: id, x, y });
      },
      onPointerMove: (shareId, x, y) => {
        if (!showMyPointerRef.current) return;
        const t = performance.now();
        if (t - lastPtrSentRef.current < 40) return; // ~25 Hz
        lastPtrSentRef.current = t;
        void roomWrapper.broadcastPointer(shareId, x, y);
      },
      onPointerLeave: () => {
        if (showMyPointerRef.current) void roomWrapper.clearPointer();
      },
    }),
    [roomWrapper],
  );

  // Retract our pointer when the toggle goes off (or we leave).
  useEffect(() => {
    if (!showMyPointer) void roomWrapper.clearPointer();
    return () => {
      void roomWrapper.clearPointer();
    };
  }, [showMyPointer, roomWrapper]);

  // Optimistic mic/camera: show the pending state instantly on click; clear
  // the pending flag once the real snapshot reports the same value.
  const actualMuted = !(snapshot.local?.isMicrophoneEnabled ?? true);
  const muted = pendingMute ?? actualMuted;
  const actualCameraOn = snapshot.local?.isCameraEnabled ?? false;
  const cameraOn = pendingCam ?? actualCameraOn;
  // Camera acquisition (getUserMedia + warmup + encoder) can take a few
  // seconds; show a spinner in the button so it doesn't feel dead.
  const cameraStarting = pendingCam === true && !actualCameraOn;
  const localGhost = snapshot.local?.attributes?.["ghost"] === "1";

  useEffect(() => {
    if (pendingMute !== null && pendingMute === actualMuted) setPendingMute(null);
  }, [pendingMute, actualMuted]);
  useEffect(() => {
    if (pendingCam !== null && pendingCam === actualCameraOn) setPendingCam(null);
  }, [pendingCam, actualCameraOn]);
  // Track the first-ever unmute (via any path: button, keybind, PTT) so the
  // "you're muted" nudge stops for good.
  useEffect(() => {
    if (!actualMuted) setEverUnmuted(true);
  }, [actualMuted]);

  function handleToggleMute(): void {
    const next = !muted;
    setPendingMute(next);
    if (!next) setEverUnmuted(true);
    void roomWrapper.setMuted(next).catch((err) => {
      setPendingMute(null);
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        pushToast({ kind: "error", text: "Microphone permission denied", sub: "Allow mic access for this site in your browser, then try again." });
      } else {
        pushToast({ kind: "error", text: "Couldn't open microphone", sub: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      }
    });
  }

  function handleToggleCamera(): void {
    const next = !cameraOn;
    setPendingCam(next);
    void roomWrapper.setCamera(next, cameraDeviceId ?? undefined).catch((err) => {
      setPendingCam(null);
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        pushToast({ kind: "error", text: "Camera permission denied", sub: "Allow camera access for this site, then try again." });
      } else {
        pushToast({ kind: "error", text: "Couldn't start camera", sub: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      }
    });
  }

  const tiles: ParticipantView[] = [];
  if (snapshot.local) {
    tiles.push({
      id: snapshot.local.identity,
      name: snapshot.local.name || snapshot.local.identity,
      isSpeaking: snapshot.local.isSpeaking,
      isLocal: true,
      muted,
      ghost: localGhost,
      screenTrack: findScreenTrack(snapshot.local),
      cameraTrack: findCameraTrack(snapshot.local),
      quality: snapshot.local.connectionQuality ?? "unknown",
    });
  }
  for (const remote of snapshot.remotes as RemoteParticipant[]) {
    tiles.push({
      id: remote.identity,
      name: remote.name || remote.identity,
      isSpeaking: remote.isSpeaking,
      isLocal: false,
      muted: isRemoteMuted(remote),
      ghost: remote.attributes?.["ghost"] === "1",
      screenTrack: findScreenTrack(remote),
      cameraTrack: findCameraTrack(remote),
      quality: remote.connectionQuality ?? "unknown",
    });
  }

  const sharing = hasScreenShare(snapshot.local);
  // Deck 2.5: only participants with a live video/share go in the tile grid;
  // everyone else renders as a compact audio circle (names live in the sidebar).
  const allVideoTiles = tiles.filter((t) => t.screenTrack !== null || t.cameraTrack !== null);
  const localVideoTile = allVideoTiles.find((t) => t.isLocal) ?? null;
  // "Hide my video" only bites when you actually have video — so turning your
  // camera off (or a voice-only room) can't strand you off-grid with no way
  // back. The preference persists and re-applies when video returns.
  const selfHidden = selfMinimized && localVideoTile !== null;
  // Discord model: ONE grid of EVERYONE — a Tile renders video when present,
  // otherwise an avatar (no separate audio-only strip).
  const gridTiles = selfHidden ? tiles.filter((t) => !t.isLocal) : tiles;
  const anyoneHasVideo = gridTiles.some((t) => t.screenTrack !== null || t.cameraTrack !== null);
  const sharingParticipants = tiles.filter((t) => t.screenTrack !== null);
  const maximizedTile = maximizedId ? tiles.find((t) => t.id === maximizedId) : null;
  const menuParticipant = menu ? tiles.find((t) => t.id === menu.participantId) : null;
  const menuParticipantName = menuParticipant?.name ?? "participant";
  const menuIsLocal = menuParticipant?.isLocal ?? false;

  // Speaker layout activates when: user picked it, user click-focused a tile,
  // or auto + EXACTLY ONE person is sharing. With 2+ sharers, fall through
  // to grid so all shares get equal real estate. focusedId is dropped if
  // its participant left.
  const focusedTileExists = focusedId !== null && tiles.some((t) => t.id === focusedId);
  const effectiveFocusedId = focusedTileExists ? focusedId : null;
  const useSpeaker =
    layout === "speaker" ||
    effectiveFocusedId !== null ||
    (layout === "auto" && sharingParticipants.length === 1);
  const focusSharer = sharingParticipants[0] ?? null;

  // 4g: remote sharers who aren't the tile currently on the big view → "Watch"
  // chips. Whoever is focused (explicitly, or auto-focused in speaker mode) is
  // already being watched, so no chip for them.
  const shownFocusId = effectiveFocusedId ?? (useSpeaker ? focusSharer?.id ?? null : null);
  const watchableSharers = sharingParticipants.filter(
    (s) => !s.isLocal && s.id !== shownFocusId,
  );
  // 4e: one-time "you're muted" nudge — connected, still muted, never unmuted,
  // not dismissed, within the first minute.
  const showMuteHint =
    conn.phase === "connected" && muted && !everUnmuted && !muteHintDismissed && elapsed < 60;

  // Full-viewport maximized layout — no sidebar/topbar/control bar, single tile
  // fills the whole app window. OS fullscreen (requestFullscreen) is preferred
  // when the tile has a video; this layout is the fallback for avatar tiles or
  // when OS fullscreen is unavailable.
  if (maximizedTile && !document.fullscreenElement) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "black",
          display: "flex",
          flexDirection: "column",
          zIndex: 500,
        }}
      >
        <div style={{ flex: 1, minHeight: 0, padding: 24 }}>
          <Tile tile={maximizedTile} big callbacks={tileCallbacks} />
        </div>
        <button
          onClick={() => setMaximizedId(null)}
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            background: "rgba(0,0,0,0.7)",
            border: "1px solid var(--border)",
            color: "white",
            borderRadius: 6,
            padding: "6px 14px",
            cursor: "pointer",
            font: "inherit",
            zIndex: 501,
          }}
        >
          ✕ Exit (ESC)
        </button>
      </div>
    );
  }

  const localDisplayName = user?.displayName ?? snapshot.local?.name ?? snapshot.local?.identity ?? "You";

  // Server-initiated disconnect overlay — shows for ~4 s before auto-bouncing.
  if (snapshot.disconnectKind) {
    const message =
      snapshot.disconnectKind === "removed-by-owner"
        ? "You were removed from the room by the owner."
        : snapshot.disconnectKind === "room-deleted"
          ? "The owner closed this room."
          : snapshot.disconnectKind === "server-shutdown"
            ? "The server shut down."
            : snapshot.disconnectKind === "duplicate-identity"
              ? "You signed in from another device. Closing this session."
              : "Disconnected from the server.";
    return (
      <div
        style={{
          display: "grid",
          placeItems: "center",
          height: "100%",
          padding: "var(--s-7)",
          background: "var(--bg)",
        }}
      >
        <div
          className="rv-card"
          style={{ padding: "var(--s-7)", width: "min(100%, 32rem)", textAlign: "center" }}
        >
          <div style={{ fontSize: "var(--t-xl)", marginBottom: "var(--s-3)" }}>{message}</div>
          <div style={{ color: "var(--text-mid)", fontSize: "var(--t-sm)", marginBottom: "var(--s-5)" }}>
            Returning to the lobby…
          </div>
          <button
            type="button"
            className="rv-btn"
            data-variant="primary"
            onClick={() => void handleLeave()}
          >
            Back to lobby
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{ display: "grid", gridTemplateRows: "auto 1fr auto", height: "100%", position: "relative" }}
      onClick={() => setMenu(null)}
    >
      {/* Top bar (2.5): room title ▾ opens the room panel; live + E2EE pills */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-4)",
          height: "3.25rem",
          padding: "0 var(--s-4) 0 var(--s-5)",
          borderBottom: "1px solid var(--border-soft)",
          background: "var(--bg)",
        }}
      >
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          data-rv-pop=""
          onClick={() => setRoomInfoOpen((v) => !v)}
          title="Room info + settings"
          style={{
            appearance: "none",
            background: "transparent",
            border: 0,
            padding: 0,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: "var(--t-base)",
            fontWeight: 600,
            color: "var(--text)",
            letterSpacing: "-0.005em",
          }}
        >
          {roomName ?? "Room"}
          <span style={{ fontSize: 9, color: "var(--text-dim)" }}>▾</span>
        </button>
        <span
          style={{
            height: "1.4rem",
            padding: "0 var(--s-3)",
            borderRadius: "var(--r-pill)",
            background: "color-mix(in srgb, var(--accent) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--accent) 45%, transparent)",
            color: "var(--accent)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: ".14em",
            textTransform: "uppercase",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }} />
          Live · {fmtTime(elapsed)}
        </span>
        {snapshot.e2eeEnabled && (
          <span
            title="Calls in this room are end-to-end encrypted. The server can't read them."
            style={{
              height: "1.25rem",
              padding: "0 var(--s-2)",
              borderRadius: "var(--r-pill)",
              background: "color-mix(in srgb, var(--ok) 8%, transparent)",
              border: "1px solid color-mix(in srgb, var(--ok) 40%, transparent)",
              color: "var(--ok)",
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              letterSpacing: ".14em",
              textTransform: "uppercase",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <I.Lock size={10} />
            E2EE
          </span>
        )}
        <button
          className="rv-btn rv-btn-icon"
          data-variant="ghost"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => prefsActions().toggleFavoriteRoom(props.roomId)}
          title={isFavorite ? "Unfavorite this room" : "Favorite this room"}
          data-active={isFavorite}
          style={{ padding: "0 var(--s-2)", height: "1.75rem", width: "1.75rem" }}
        >
          {isFavorite ? (
            <I.StarFilled size={14} style={{ color: "var(--rv-amber)" }} />
          ) : (
            <I.Star size={14} style={{ color: "var(--text-mid)" }} />
          )}
        </button>

        <span style={{ flex: 1 }} />

        {conn.phase === "connecting" ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--s-2)",
              color: "var(--text-mid)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--t-2xs)",
              letterSpacing: ".06em",
              textTransform: "uppercase",
            }}
          >
            <Spinner /> Connecting…
          </span>
        ) : conn.phase === "error" ? (
          <span className="rv-mono" style={{ color: "var(--danger)", fontSize: "var(--t-2xs)" }}>
            Error: {conn.message}
          </span>
        ) : null}
        <CopyLinkButton roomId={props.roomId} serverUrl={serverUrl} />
        <button
          className="rv-btn rv-btn-icon"
          data-variant="ghost"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
        >
          <I.Settings size={16} />
        </button>
      </header>

      {/* Media reconnection banner (task 1). `connected` stays true through a
          blip, so RoomEvent.Reconnecting is the only signal audio has cut —
          surface it prominently. Auto-clears on Reconnected. */}
      {snapshot.reconnecting && (
        <div
          role="status"
          aria-live="assertive"
          style={{
            position: "absolute",
            top: "3.25rem",
            left: 0,
            right: 0,
            zIndex: 200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "var(--s-3)",
            padding: "var(--s-3) var(--s-4)",
            background: "color-mix(in srgb, var(--rv-amber) 22%, var(--bg-elev))",
            borderBottom: "1px solid color-mix(in srgb, var(--rv-amber) 55%, transparent)",
            color: "var(--text)",
            boxShadow: "var(--shadow-2)",
          }}
        >
          <Spinner />
          <span style={{ fontWeight: 600 }}>Reconnecting…</span>
          <span style={{ color: "var(--text-mid)", fontSize: "var(--t-sm)" }}>
            Your connection dropped — audio and video will resume automatically.
          </span>
        </div>
      )}

      {/* Body */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(220px, 260px) 1fr",
          minHeight: 0,
          position: "relative",
        }}
      >
        {/* Participant sidebar (2.5 pside) */}
        <aside
          style={{
            borderRight: "1px solid var(--border-soft)",
            background: "var(--bg)",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div style={{ padding: "var(--s-3)", borderBottom: "1px solid var(--border-soft)", flexShrink: 0 }}>
            <input
              className="rv-input"
              placeholder="Find participant…"
              value={psearch}
              onChange={(e) => setPsearch(e.target.value)}
              style={{ height: "1.9rem", fontSize: "var(--t-xs)" }}
            />
          </div>
          <div className="rv-scroll" style={{ flex: 1, overflow: "auto", padding: "var(--s-3) var(--s-2)" }}>
            <div
              className="rv-label"
              style={{
                padding: "var(--s-1) var(--s-2) var(--s-2)",
                fontSize: "var(--t-2xs)",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>Participants</span>
              <span style={{ color: "var(--text-faint)", fontWeight: 500 }}>{tiles.length}</span>
            </div>
            <div className="rv-list">
              {tiles
                .filter((t) => t.name.toLowerCase().includes(psearch.trim().toLowerCase()))
                .map((tile) => {
                  const tileSharing = tile.screenTrack !== null;
                  const rtt = snapshot.rttByParticipant[tile.id];
                  const metaBits: string[] = [];
                  if (tileSharing) metaBits.push("sharing");
                  if (tile.ghost) metaBits.push("ghost");
                  if (rtt !== undefined) metaBits.push(`${Math.round(rtt)}ms`);
                  return (
                    <div
                      key={tile.id}
                      className="rv-list-item"
                      role="button"
                      title="Click for volume, mute-for-me, profile"
                      style={{
                        gridTemplateColumns: "30px 1fr auto",
                        cursor: "pointer",
                        ...(tile.ghost ? { opacity: 0.65 } : null),
                        ...(tile.isSpeaking ? { background: "var(--bg-elev-2)" } : null),
                      }}
                      onClick={(e) => {
                        // Left-click a row → open the same menu the tile's
                        // right-click shows. stopPropagation so the container's
                        // click-to-close doesn't immediately dismiss it.
                        e.stopPropagation();
                        setMenu({ participantId: tile.id, x: e.clientX, y: e.clientY });
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ participantId: tile.id, x: e.clientX, y: e.clientY });
                      }}
                    >
                      {/* Fixed square box so the grid cell can't stretch it
                          vertically — otherwise the speaking ring (inset:-2 on
                          a stretched parent) renders as an oval. */}
                      <div style={{ position: "relative", width: 28, height: 28, flexShrink: 0, alignSelf: "center" }}>
                        <Avatar
                          src={null}
                          fallbackInitials={tile.name}
                          fallbackColorSeed={tile.id}
                          size={28}
                        />
                        {tile.isSpeaking && (
                          <span
                            style={{
                              position: "absolute",
                              inset: -3,
                              borderRadius: "50%",
                              boxShadow: "0 0 0 2px var(--rv-live)",
                              pointerEvents: "none",
                            }}
                          />
                        )}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                        <span
                          style={{
                            fontSize: "var(--t-sm)",
                            display: "flex",
                            alignItems: "baseline",
                            gap: 4,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {tile.name}
                          {tile.isLocal && (
                            <span style={{ color: "var(--text-dim)", fontSize: "var(--t-xs)" }}>(you)</span>
                          )}
                        </span>
                        {metaBits.length > 0 && (
                          <span className="rv-mono" style={{ fontSize: 9, color: "var(--text-faint)" }}>
                            {metaBits.join(" · ")}
                          </span>
                        )}
                      </div>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {tile.ghost ? (
                          <span title="Ghost" style={{ fontSize: 11, color: "var(--rv-amber)" }}>👻</span>
                        ) : tileSharing ? (
                          <I.Screen size={11} style={{ color: "var(--ok)" }} />
                        ) : null}
                        {tile.muted ? (
                          <I.MicOff size={12} style={{ color: "var(--text-faint)" }} />
                        ) : (
                          <MiniVu active={tile.isSpeaking} />
                        )}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        </aside>

        {/* Tiles (2.5): video/share tiles in the grid, audio-only as circles */}
        <main
          className="rv-scroll"
          style={{
            padding: "var(--s-4)",
            overflow: "auto",
            minHeight: 0,
            containerType: "inline-size",
            background: "var(--bg-elev-2)",
            display: "grid",
            gridTemplateRows: "1fr auto",
            gap: "var(--s-3)",
          }}
        >
          {showMyPointer && (
            <button
              type="button"
              onClick={() => setShowMyPointer(false)}
              title="Your cursor is shown on shared screens. Click to stop."
              style={{
                position: "absolute",
                left: "50%",
                bottom: "var(--s-4)",
                transform: "translateX(-50%)",
                zIndex: 20,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 12px",
                borderRadius: "var(--r-pill)",
                border: "1px solid var(--accent)",
                background: "var(--accent-tint)",
                color: "var(--accent)",
                fontSize: "var(--t-xs)",
                fontWeight: 600,
                cursor: "pointer",
                boxShadow: "var(--shadow-2)",
              }}
            >
              ➤ Pointer on — hover a shared screen · click to stop
            </button>
          )}
          {selfHidden && localVideoTile && (
            <button
              type="button"
              onClick={() => setSelfMinimized(false)}
              title="Restore your video"
              style={{
                position: "absolute",
                right: "var(--s-4)",
                bottom: "5rem",
                zIndex: 20,
                width: 132,
                height: 78,
                borderRadius: "var(--r-md)",
                overflow: "hidden",
                border: "1px solid var(--border)",
                boxShadow: "var(--shadow-2)",
                background: "var(--bg-elev-3)",
                color: "var(--text-mid)",
                cursor: "pointer",
                display: "grid",
                placeItems: "center",
                fontSize: "var(--t-xs)",
                padding: 0,
              }}
            >
              <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                <I.Camera size={16} />
                <span>You · click to restore</span>
              </span>
            </button>
          )}
          {useSpeaker ? (
            <SpeakerLayout
              people={gridTiles}
              sharer={focusSharer}
              focusedId={effectiveFocusedId}
              callbacks={tileCallbacks}
            />
          ) : anyoneHasVideo ? (
            /* Everyone in one grid — camera-off participants render as avatar
               tiles (Discord model), no separate audio strip. */
            <GridLayout people={gridTiles} callbacks={tileCallbacks} />
          ) : (
            /* Pure-voice room: nicer centered circles instead of empty tiles. */
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "var(--s-5)",
                alignItems: "center",
                justifyContent: "center",
                alignContent: "center",
              }}
            >
              {gridTiles.map((t) => (
                <AudioCircle
                  key={t.id}
                  tile={t}
                  size={gridTiles.length <= 2 ? 140 : gridTiles.length <= 6 ? 104 : 76}
                  callbacks={tileCallbacks}
                />
              ))}
            </div>
          )}
        </main>

        {/* Layout switcher (floating) — 3-segment Auto/Grid/Speaker, active lit */}
        <div
          style={{
            position: "absolute",
            top: "var(--s-5)",
            right: "var(--s-5)",
            display: "flex",
            padding: 3,
            background: "color-mix(in oklch, var(--bg-elev) 80%, transparent)",
            border: "1px solid var(--border-soft)",
            borderRadius: "var(--r-md)",
            backdropFilter: "blur(8px)",
            zIndex: 5,
          }}
          title="Video layout"
        >
          <Segmented<LayoutMode>
            translucent
            ariaLabel="Video layout"
            value={layout}
            onChange={setLayout}
            options={[
              { value: "auto", label: "Auto" },
              { value: "grid", label: "Grid" },
              { value: "speaker", label: "Speaker" },
            ]}
          />
        </div>

        {chatOpen && (
          <RoomChatPanel
            threadType="room"
            threadId={props.roomId}
            localIdentity={snapshot.local?.identity ?? "you"}
            localName={localDisplayName}
            onClose={() => setChatOpen(false)}
          />
        )}

        {dmTarget && snapshot.local && (
          <RoomChatPanel
            threadType="dm"
            threadId={canonicalDmThreadId(snapshot.local.identity, dmTarget.id)}
            localIdentity={snapshot.local.identity}
            localName={localDisplayName}
            onClose={() => setDmTarget(null)}
          />
        )}

        {/* 2.5g "View profile" → 2.4a peer profile popover */}
        {profileTarget && (
          <PeerProfilePopover peer={profileTarget} onClose={() => setProfileTarget(null)} />
        )}
      </div>

      {/* Room info popover */}
      {roomInfoOpen && (
        <RoomInfoPanel
          roomId={props.roomId}
          onDeparture={() => {
            setRoomInfoOpen(false);
            void handleLeave();
          }}
          onClose={() => setRoomInfoOpen(false)}
        />
      )}

      {/* Control bar (2.5): three clusters — [mic·cam·ghost] | [share·audio] | [chat·leave] */}
      <footer
        style={{
          height: "5.5rem",
          padding: "0 var(--s-5)",
          borderTop: "1px solid var(--border-soft)",
          background: "var(--bg)",
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          {muted && !localGhost && (
            <span
              className="rv-mono"
              style={{
                fontSize: 10,
                letterSpacing: ".12em",
                textTransform: "uppercase",
                color: "var(--danger)",
                padding: "3px 8px",
                border: "1px solid color-mix(in srgb, var(--danger) 45%, transparent)",
                borderRadius: 999,
                background: "color-mix(in srgb, var(--danger) 10%, transparent)",
              }}
            >
              ● muted
            </span>
          )}
          {localGhost && (
            <span
              className="rv-mono"
              style={{
                fontSize: 10,
                letterSpacing: ".12em",
                textTransform: "uppercase",
                color: "var(--rv-amber)",
                padding: "3px 8px",
                border: "1px solid color-mix(in srgb, var(--rv-amber) 45%, transparent)",
                borderRadius: 999,
                background: "color-mix(in srgb, var(--rv-amber) 10%, transparent)",
              }}
            >
              👻 ghost
            </span>
          )}
        </div>

        <div style={{ display: "flex", gap: "var(--s-4)", alignItems: "center" }}>
          <div style={{ display: "flex", gap: "var(--s-3)" }}>
            <ControlButton
              icon={muted ? <I.MicOff size={20} /> : <I.Mic size={20} />}
              label={muted ? "Unmute" : "Mute"}
              danger={muted}
              disabled={conn.phase !== "connected"}
              title={withBind(muted ? "Unmute" : "Mute", muteKeybind)}
              onClick={handleToggleMute}
            />
            <CameraControl cameraOn={cameraOn} starting={cameraStarting} disabled={conn.phase !== "connected"} roomWrapper={roomWrapper} onToggle={handleToggleCamera} />
            <ControlButton
              icon={<span style={{ fontSize: 20, lineHeight: 1 }}>👻</span>}
              label="Ghost"
              danger={localGhost}
              disabled={conn.phase !== "connected"}
              title={withBind("Ghost — mic and camera off together", deafenKeybind)}
              onClick={() => void roomWrapper.setGhost(!localGhost)}
            />
          </div>
          <span style={{ width: 1, height: "2rem", background: "var(--border)" }} />
          <div style={{ display: "flex", gap: "var(--s-3)" }}>
            <ControlButton
              icon={sharing ? <I.ScreenOff size={20} /> : <I.Screen size={20} />}
              label={sharing ? "Stop share" : "Share"}
              active={sharing}
              disabled={conn.phase !== "connected"}
              title={withBind(sharing ? "Stop sharing" : "Share screen", shareScreenKeybind)}
              onClick={() => void handleToggleScreen()}
            />
            {sharing && (
              <ShareAudioControl
                enabled={snapshot.screenShareAudioEnabled}
                roomWrapper={roomWrapper}
              />
            )}
          </div>
          <span style={{ width: 1, height: "2rem", background: "var(--border)" }} />
          <div style={{ display: "flex", gap: "var(--s-3)" }}>
            <ControlButton
              icon={<I.Chat size={20} />}
              label="Chat"
              active={chatOpen}
              title="Toggle room chat"
              onClick={() => setChatOpen((c) => !c)}
            />
            <ControlButton
              icon={<I.Leave size={20} />}
              label="Leave"
              leave
              title={withBind("Leave call", leaveRoomKeybind)}
              onClick={() => void handleLeave()}
            />
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: "var(--s-3)",
            color: "var(--text-faint)",
          }}
        >
          {netStats?.rttMs !== null && netStats?.rttMs !== undefined && (
            <span
              className="rv-mono"
              title={`RTT ${Math.round(netStats.rttMs)}ms · jitter ${netStats.jitterMs?.toFixed(1) ?? "—"}ms · lost ${netStats.packetsLost ?? "—"}`}
              style={{
                fontSize: 10,
                letterSpacing: ".1em",
                textTransform: "uppercase",
                color:
                  netStats.rttMs < 150
                    ? "var(--text-faint)"
                    : netStats.rttMs < 400
                      ? "var(--rv-amber)"
                      : "var(--accent-glow)",
              }}
            >
              ↔ {Math.round(netStats.rttMs)} ms
            </span>
          )}
          {pttKeybind && (
            <>
              <kbd style={kbdStyle}>{pttKeybind}</kbd>
              <span
                className="rv-mono"
                style={{
                  fontSize: 10,
                  letterSpacing: ".1em",
                  textTransform: "uppercase",
                }}
              >
                push to talk
              </span>
            </>
          )}
        </div>
      </footer>

      {/* Right-click volume menu */}
      {menu && (
        <div
          data-rv-pop=""
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            top: menu.y,
            left: menu.x,
            width: 240,
            background: "var(--bg-elev-2)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--r-md)",
            padding: "var(--s-3)",
            boxShadow: "var(--shadow-3)",
            zIndex: 100,
          }}
        >
          <div className="rv-label" style={{ fontSize: 10, marginBottom: 8 }}>
            VOLUME · {menuParticipantName}
            {menuIsLocal && " (you)"}
          </div>

          {menuIsLocal ? (
            <>
              {localVideoTile && (
                <CtxItem
                  onClick={() => {
                    setSelfMinimized((v) => !v);
                    setMenu(null);
                  }}
                >
                  {selfMinimized ? "Show my video" : "Hide my video"}{" "}
                  <span style={{ color: "var(--text-dim)" }}>{selfMinimized ? "◱" : "◲"}</span>
                </CtxItem>
              )}
              <div style={{ fontSize: 11, color: "var(--text-faint)", lineHeight: 1.5, marginTop: 6 }}>
                Left-click your tile to spotlight yourself. Your own volume is set on each
                listener&apos;s end.
              </div>
            </>
          ) : (
            <>
              <VolumeRow
                label="Voice"
                value={voiceVolumes[menu.participantId] ?? 1}
                maxPercent={MAX_VOICE_PCT}
                onChange={(v) => setVoiceVolume(menu.participantId, v)}
              />
              <VolumeRow
                label="Screen audio"
                value={screenVolumes[menu.participantId] ?? 1}
                onChange={(v) => setScreenVolume(menu.participantId, v)}
              />
            </>
          )}

          {/* 2.5g: Open DM · Mute for me · View profile */}
          {!menuIsLocal && menuParticipant && (
            <>
              <hr className="rv-rule" />
              {(menuParticipant.screenTrack !== null || menuParticipant.cameraTrack !== null) && (
                <div style={{ marginBottom: 6 }}>
                  <div className="rv-label" style={{ fontSize: 10, margin: "2px 0 4px" }}>
                    INCOMING VIDEO QUALITY
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {(["auto", "high", "medium", "low"] as ReceiverQuality[]).map((q) => {
                      const active = (receiverQuality[menu.participantId] ?? "auto") === q;
                      return (
                        <button
                          key={q}
                          type="button"
                          onClick={() => applyReceiverQuality(menu.participantId, q)}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            fontSize: 11,
                            textTransform: "capitalize",
                            borderRadius: "var(--r-sm)",
                            cursor: "pointer",
                            border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
                            background: active ? "var(--accent-tint)" : "transparent",
                            color: active ? "var(--accent)" : "var(--text-mid)",
                          }}
                        >
                          {q === "medium" ? "Med" : q}
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 4, lineHeight: 1.4 }}>
                    Lower saves bandwidth on your end — only affects your view.
                  </div>
                </div>
              )}
              {menuParticipant.screenTrack !== null && (
                <CtxItem
                  title="Show your cursor on their shared screen for everyone (a shared laser pointer — no actual control)"
                  onClick={() => {
                    setShowMyPointer((v) => !v);
                    setMenu(null);
                  }}
                >
                  <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    {showMyPointer ? "Hide my pointer" : "Show my pointer"}{" "}
                    <span style={{ color: "var(--text-dim)" }}>➤</span>
                  </span>
                </CtxItem>
              )}
              <CtxItem
                onClick={() => {
                  setDmTarget({ id: menuParticipant.id, name: menuParticipant.name });
                  setMenu(null);
                }}
              >
                <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  Open DM <span style={{ color: "var(--text-dim)" }}>✉</span>
                </span>
              </CtxItem>
              <CtxItem
                title="Silence this person just for you — nobody else is affected"
                onClick={() => {
                  setMuteForMe(menuParticipant.id, !mutedForMe[menuParticipant.id]);
                  setMenu(null);
                }}
              >
                <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  {mutedForMe[menuParticipant.id] ? "Unmute for me" : "Mute for me"}
                  <span style={{ color: "var(--text-dim)" }}>🔇</span>
                </span>
              </CtxItem>
              <CtxItem
                onClick={() => {
                  setProfileTarget({ id: menuParticipant.id, handle: null, displayName: menuParticipant.name });
                  setMenu(null);
                }}
              >
                <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  View profile <span style={{ color: "var(--text-dim)" }}>👤</span>
                </span>
              </CtxItem>

              {/* Owner-only moderation — inline two-step confirm so a stray
                  click can't eject or hand off the room. */}
              {isRoomOwner && (
                <>
                  <hr className="rv-rule" />
                  {ownerConfirm && ownerConfirm.id === menuParticipant.id ? (
                    <div style={{ padding: "6px 8px" }}>
                      <div style={{ fontSize: "var(--t-xs)", color: "var(--text-mid)", marginBottom: 6 }}>
                        {ownerConfirm.kind === "remove"
                          ? `Remove ${ownerConfirm.name} from the room?`
                          : `Make ${ownerConfirm.name} the room owner?`}
                      </div>
                      <div style={{ display: "flex", gap: "var(--s-2)", justifyContent: "flex-end" }}>
                        <button
                          type="button"
                          className="rv-btn"
                          style={{ height: "1.6rem", fontSize: "var(--t-2xs)" }}
                          onClick={() => setOwnerConfirm(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="rv-btn"
                          data-variant="primary"
                          style={{
                            height: "1.6rem",
                            fontSize: "var(--t-2xs)",
                            ...(ownerConfirm.kind === "remove"
                              ? { background: "var(--danger)", borderColor: "var(--danger)", color: "#fff" }
                              : {}),
                          }}
                          onClick={() => {
                            const { kind, id } = ownerConfirm;
                            setOwnerConfirm(null);
                            setMenu(null);
                            if (kind === "remove") void handleRemoveMember(id);
                            else void handleTransferOwnership(id);
                          }}
                        >
                          {ownerConfirm.kind === "remove" ? "Remove" : "Transfer"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <CtxItem
                        title="Hand the room over to this member"
                        onClick={() =>
                          setOwnerConfirm({ kind: "transfer", id: menuParticipant.id, name: menuParticipant.name })
                        }
                      >
                        <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          Transfer ownership <span style={{ color: "var(--text-dim)" }}>👑</span>
                        </span>
                      </CtxItem>
                      <CtxItem
                        danger
                        title="Remove this person from the room"
                        onClick={() =>
                          setOwnerConfirm({ kind: "remove", id: menuParticipant.id, name: menuParticipant.name })
                        }
                      >
                        <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          Remove from room <span style={{ color: "var(--text-dim)" }}>⛔</span>
                        </span>
                      </CtxItem>
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Hidden audio mount */}
      <div ref={audioMountRef} style={{ display: "none" }} aria-hidden="true" />

      {/* 2.5j connecting overlay: step list over the room while we negotiate */}
      {conn.phase === "connecting" && (
        <div className="rv-conn-mask">
          <div className="rv-conn-card">
            <div className="rv-conn-spinner" />
            <span className="rv-conn-title">Connecting to room…</span>
            <span className="rv-conn-room">
              {roomName ?? "…"}
              {roomInCall !== null && roomInCall > 0 ? ` · ${roomInCall} in call` : ""}
            </span>
            <div className="rv-conn-steps">
              {connSteps.map((s) => (
                <div key={s.label} className="rv-conn-step" data-state={s.state}>
                  <span className="ic">{s.state === "done" ? "✓" : s.state === "active" ? "" : "·"}</span>
                  <span className="label">{s.label}</span>
                  <span className="t">
                    {s.state === "done" && s.ms !== null ? `${s.ms} ms` : s.state === "active" ? "…" : ""}
                  </span>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="rv-btn"
              onClick={() => {
                cancelRequestedRef.current = true;
                void handleLeave();
              }}
              style={{ marginTop: "var(--s-2)", minWidth: "6rem" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Join-failure overlay — a real recovery surface instead of a tiny header
          note with a dead control bar behind it. */}
      {conn.phase === "error" && (
        <div className="rv-conn-mask">
          <div className="rv-conn-card">
            <div
              aria-hidden
              style={{
                width: 40,
                height: 40,
                borderRadius: "50%",
                display: "grid",
                placeItems: "center",
                marginBottom: "var(--s-3)",
                color: "var(--danger)",
                background: "color-mix(in srgb, var(--danger) 10%, transparent)",
                border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)",
                fontSize: 20,
                fontWeight: 700,
              }}
            >
              !
            </div>
            <span className="rv-conn-title">Couldn’t join the room</span>
            <span
              className="rv-conn-room"
              style={{ color: "var(--danger)", maxWidth: "18rem", textAlign: "center" }}
            >
              {conn.message ?? "Something went wrong connecting."}
            </span>
            <div style={{ display: "flex", gap: "var(--s-3)", marginTop: "var(--s-4)" }}>
              <button
                type="button"
                className="rv-btn"
                data-variant="primary"
                onClick={() => {
                  // Re-arm the join effect: clear any stale cancel, drop back to
                  // "connecting", and bump the nonce so the effect re-runs.
                  cancelRequestedRef.current = false;
                  setConn({ phase: "connecting" });
                  setRetryNonce((n) => n + 1);
                }}
                style={{ minWidth: "6rem" }}
              >
                Try again
              </button>
              <button
                type="button"
                className="rv-btn"
                onClick={() => void handleLeave()}
                style={{ minWidth: "6rem" }}
              >
                Back to lobby
              </button>
            </div>
          </div>
        </div>
      )}

      {/* In-call screenshare quality/source picker (task 2) */}
      {shareDialogOpen && (
        <ScreenShareDialog
          onConfirm={(q) => void startScreenShareWithQuality(q)}
          onCancel={() => setShareDialogOpen(false)}
        />
      )}

      {/* One-time "you're muted" nudge (task 4e) */}
      {showMuteHint && (
        <div
          role="status"
          style={{
            // Anchored just above the control bar so it points at the mic
            // button it's telling you to click — not floating mid-screen.
            position: "fixed",
            left: "50%",
            bottom: "5.75rem",
            transform: "translateX(-50%)",
            zIndex: 90,
            display: "flex",
            alignItems: "center",
            gap: "var(--s-3)",
            padding: "var(--s-3) var(--s-4)",
            background: "var(--bg-elev-2)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--r-pill)",
            boxShadow: "var(--shadow-3)",
            maxWidth: "min(92vw, 32rem)",
          }}
        >
          <I.MicOff size={16} style={{ color: "var(--danger)", flexShrink: 0 }} />
          <span style={{ fontSize: "var(--t-sm)" }}>
            You&apos;re muted —{" "}
            {muteKeybind ? (
              <>
                press{" "}
                <kbd style={kbdStyle}>
                  {muteKeybind.replace(/Control/g, "Ctrl").replace(/Super/g, "Cmd")}
                </kbd>{" "}
                or{" "}
              </>
            ) : null}
            click the mic to talk.
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setMuteHintDismissed(true)}
            style={{
              appearance: "none",
              border: 0,
              background: "transparent",
              color: "var(--text-faint)",
              cursor: "pointer",
              padding: 2,
              flexShrink: 0,
            }}
          >
            <I.X size={12} />
          </button>
        </div>
      )}

      {/* "is sharing — Watch" chip near the control bar (task 4g) */}
      {conn.phase === "connected" && watchableSharers.length > 0 && (
        <div
          style={{
            position: "fixed",
            left: "50%",
            bottom: "6.25rem",
            transform: "translateX(-50%)",
            zIndex: 40,
            display: "flex",
            gap: "var(--s-2)",
            pointerEvents: "none",
          }}
        >
          {watchableSharers.map((s) => (
            <button
              key={s.id}
              type="button"
              title={`Focus ${s.name}'s screen share`}
              onClick={() => setFocusedId(s.id)}
              style={{
                pointerEvents: "auto",
                appearance: "none",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 12px",
                borderRadius: "var(--r-pill)",
                background: "var(--bg-elev-2)",
                border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
                color: "var(--text)",
                fontSize: "var(--t-xs)",
                boxShadow: "var(--shadow-2)",
                backdropFilter: "blur(8px)",
              }}
            >
              <span style={{ color: "var(--danger)" }}>🔴</span>
              <span>
                <b>{s.name}</b> is sharing
              </span>
              <span style={{ color: "var(--accent)", fontWeight: 600 }}>— Watch</span>
            </button>
          ))}
        </div>
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function VolumeRow({
  label,
  value,
  onChange,
  maxPercent = 100,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  /** Slider ceiling. Voice goes to 200% (rides a GainNode above 100%). */
  maxPercent?: number;
}): ReactElement {
  const pct = Math.round(value * 100);
  const boosted = pct > 100;
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          marginBottom: 4,
          display: "flex",
          justifyContent: "space-between",
          fontFamily: "var(--font-mono)",
        }}
      >
        <span>{label}</span>
        <span style={boosted ? { color: "var(--rv-amber)" } : undefined}>{pct}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={maxPercent}
        step={5}
        value={Math.min(pct, maxPercent)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        style={{ width: "100%", accentColor: boosted ? "var(--rv-amber)" : "var(--accent)" }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--text-faint)",
        }}
      >
        <span>0</span>
        {maxPercent > 100 && <span>100</span>}
        <span>{maxPercent}</span>
      </div>
    </div>
  );
}
