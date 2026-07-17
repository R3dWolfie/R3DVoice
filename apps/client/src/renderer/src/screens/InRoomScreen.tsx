import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { ApiClient } from "../lib/api.js";
import { useAuthStore } from "../lib/auth-context.js";
import { openMicPipeline, listVideoInputs, type DeviceInfo, type MicPipeline } from "../lib/media.js";
import {
  LiveKitRoom,
  RoomEvent,
  Track,
  type LocalParticipant,
  type RemoteParticipant,
  type RoomStateSnapshot,
} from "../lib/livekit-room.js";
import type { JoinSelection } from "../lib/join-selection.js";
import { SettingsModal } from "../components/SettingsModal.js";
import { usePrefs, prefsActions } from "../lib/prefs-singleton.js";
import type { LinuxAudioSourceSummary, WindowsAudioSessionInfo } from "../../../shared/bridge-types.js";
import { Avatar } from "../components/Avatar.js";
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

function Tile({
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

  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
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
  roomWrapper,
}: {
  cameraOn: boolean;
  roomWrapper: LiveKitRoom;
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
        icon={cameraOn ? <I.CameraOff size={20} /> : <I.Camera size={20} />}
        label={cameraOn ? "Stop camera" : "Camera"}
        active={cameraOn}
        emphasis={cameraOn}
        onClick={() => {
          void roomWrapper.setCamera(!cameraOn, selectedDeviceId ?? undefined).catch((err) => {
            if (err instanceof DOMException && err.name === "NotAllowedError") {
              pushToast({ kind: "error", text: "Camera permission denied", sub: "Allow camera access for this site, then try again." });
            } else {
              pushToast({ kind: "error", text: "Couldn't start camera", sub: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
            }
          });
        }}
      />
      <button
        type="button"
        aria-label="Pick camera"
        title="Switch camera"
        data-rv-pop=""
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setPickerOpen((v) => !v)}
        style={{
          appearance: "none",
          border: 0,
          background: "transparent",
          color: cameraOn ? "var(--text)" : "var(--text-faint)",
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
function AudioCircle({
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
  onClick,
  title,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  danger?: boolean;
  leave?: boolean;
  emphasis?: boolean;
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
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        appearance: "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        padding: 0,
        background: "transparent",
        border: 0,
        cursor: "pointer",
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
          transition: "all var(--d-base) var(--ease-out)",
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

export function InRoomScreen(props: InRoomScreenProps): ReactElement {
  const token = useAuthStore((s) => s.token);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const user = useAuthStore((s) => s.user);

  const roomWrapper = useMemo(() => new LiveKitRoom(), []);
  const [conn, setConn] = useState<ConnectionState>({ phase: "connecting" });
  const [connSteps, setConnSteps] = useState<ConnStep[]>(freshConnSteps);
  const cancelRequestedRef = useRef(false);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const persistedParticipantVolumes = usePrefs((s) => s.participantVolumes);
  const persistedScreenVolumes = usePrefs((s) => s.participantScreenVolumes);
  const [voiceVolumes, setVoiceVolumes] = useState<Record<string, number>>(persistedParticipantVolumes);
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
  const [roomInfoOpen, setRoomInfoOpen] = useState(false);
  const [psearch, setPsearch] = useState("");

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
        }
      } catch { /* */ }
    };
    void tick();
    const interval = setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
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
  }, [roomWrapper, props.roomId, props.selection, token, serverUrl]);

  useEffect(() => {
    const room = roomWrapper.room;
    const mount = audioMountRef.current;
    if (!mount) return;

    const onTrackSubscribed = (track: Track): void => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach() as HTMLAudioElement;
      el.autoplay = true;
      (el as HTMLElement & { playsInline?: boolean }).playsInline = true;
      mount.appendChild(el);
      routeElement(el); // no-op unless mono output has been enabled
    };
    const onTrackUnsubscribed = (track: Track): void => {
      if (track.kind !== Track.Kind.Audio) return;
      track.detach().forEach((el) => el.remove());
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
    const isSharing = hasScreenShare(snapshot.local);
    try {
      await roomWrapper.setScreenShare(!isSharing);
    } catch (err) {
      // getDisplayMedia rejects on cancel (fine) or a real failure (surface it).
      if (err instanceof DOMException && err.name === "NotAllowedError") return;
      pushToast({ kind: "error", text: "Couldn't start screen share", sub: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    }
  }

  // Wire prefs-driven keybinds for the in-room actions. PTT remains separate
  // (uses globalShortcut so it works when unfocused).
  useKeybind(muteKeybind, () => {
    void roomWrapper.setMuted(!(snapshot.local?.isMicrophoneEnabled ?? true));
  });
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
    const v = clampVol(volume);
    // Dragging a slider implicitly lifts a local "Mute for me".
    setMutedForMe((prev) => (prev[id] ? { ...prev, [id]: false } : prev));
    setVoiceVolumes((prev) => ({ ...prev, [id]: v }));
    prefsActions().setParticipantVolume(id, v);
    const participant = snapshot.remotes.find((r) => r.identity === id);
    if (participant) {
      participant.setVolume(v, Track.Source.Microphone);
    }
  }

  // Apply saved per-participant volumes whenever a remote subscribes — keeps
  // user-set volumes sticky across rejoins / new sessions. Participants the
  // user muted-for-me stay at 0 until they unmute them.
  useEffect(() => {
    if (deafened) return; // ghost/deafen zeroes everything (effect below)
    for (const remote of snapshot.remotes) {
      if (mutedForMe[remote.identity]) continue;
      const raw = persistedParticipantVolumes[remote.identity];
      if (raw === undefined) continue;
      const v = clampVol(raw);
      if (v === 1) continue;
      remote.setVolume(v, Track.Source.Microphone);
    }
  }, [snapshot.remotes, persistedParticipantVolumes, mutedForMe, deafened]);

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
      participant.setVolume(clampVol(voiceVolumes[id] ?? 1), Track.Source.Microphone);
      participant.setVolume(clampVol(screenVolumes[id] ?? 1), Track.Source.ScreenShareAudio);
    }
  }

  const tileCallbacks: TileCallbacks = {
    onClick: (id) => {
      // Single-click focuses a tile in speaker layout. Click the same tile
      // again to clear focus and let the auto-pick (sharer/speaker) take over.
      setFocusedId((current) => (current === id ? null : id));
    },
    onDoubleClick: (id, videoEl) => {
      // If the tile has a <video> element and isn't already fullscreen,
      // request true OS-level fullscreen on it. Otherwise toggle the in-app
      // maximize (useful for avatar-only tiles).
      if (videoEl && !document.fullscreenElement) {
        setMaximizedId(id);
        void videoEl.requestFullscreen().catch(() => {
          // Fallback to in-app maximize if OS fullscreen refused
        });
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
  };

  const muted = !(snapshot.local?.isMicrophoneEnabled ?? true);
  const localGhost = snapshot.local?.attributes?.["ghost"] === "1";

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
  const cameraOn = snapshot.local?.isCameraEnabled ?? false;
  // Deck 2.5: only participants with a live video/share go in the tile grid;
  // everyone else renders as a compact audio circle (names live in the sidebar).
  const videoTiles = tiles.filter((t) => t.screenTrack !== null || t.cameraTrack !== null);
  const audioOnlyTiles = tiles.filter((t) => t.screenTrack === null && t.cameraTrack === null);
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
                      style={{
                        gridTemplateColumns: "30px 1fr auto",
                        ...(tile.ghost ? { opacity: 0.65 } : null),
                        ...(tile.isSpeaking ? { background: "var(--bg-elev-2)" } : null),
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
          {useSpeaker ? (
            <SpeakerLayout
              people={tiles}
              sharer={focusSharer}
              focusedId={effectiveFocusedId}
              callbacks={tileCallbacks}
            />
          ) : videoTiles.length > 0 ? (
            <GridLayout people={videoTiles} callbacks={tileCallbacks} />
          ) : (
            /* Voice-only room (2.5b): centered large circles */
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
              {audioOnlyTiles.map((t) => (
                <AudioCircle key={t.id} tile={t} size={72} callbacks={tileCallbacks} />
              ))}
            </div>
          )}

          {!useSpeaker && videoTiles.length > 0 && audioOnlyTiles.length > 0 && (
            <div
              className="rv-scroll"
              style={{
                display: "flex",
                gap: "var(--s-3)",
                alignItems: "center",
                overflowX: "auto",
                padding: "2px",
              }}
            >
              {audioOnlyTiles.map((t) => (
                <AudioCircle key={t.id} tile={t} size={52} callbacks={tileCallbacks} />
              ))}
            </div>
          )}
        </main>

        {/* Layout switcher (floating) */}
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
        >
          <button
            onClick={() => {
              const order: LayoutMode[] = ["auto", "grid", "speaker"];
              const next = order[(order.indexOf(layout) + 1) % order.length]!;
              setLayout(next);
            }}
            title={`Layout: ${layout} — click to cycle`}
            style={{
              appearance: "none",
              border: 0,
              cursor: "pointer",
              padding: "5px 11px",
              borderRadius: 5,
              background: "transparent",
              color: "var(--text-dim)",
              fontSize: "var(--t-xs)",
              fontFamily: "var(--font-mono)",
              letterSpacing: ".06em",
              textTransform: "uppercase",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <I.Grid size={12} /> {layout}
          </button>
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
              onClick={() => {
                void roomWrapper.setMuted(!muted).catch((err) => {
                  if (err instanceof DOMException && err.name === "NotAllowedError") {
                    pushToast({ kind: "error", text: "Microphone permission denied", sub: "Allow mic access for this site in your browser, then try again." });
                  } else {
                    pushToast({ kind: "error", text: "Couldn't open microphone", sub: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
                  }
                });
              }}
            />
            <CameraControl cameraOn={cameraOn} roomWrapper={roomWrapper} />
            <ControlButton
              icon={<span style={{ fontSize: 20, lineHeight: 1 }}>👻</span>}
              label="Ghost"
              danger={localGhost}
              title="Ghost — mic and camera off together"
              onClick={() => void roomWrapper.setGhost(!localGhost)}
            />
          </div>
          <span style={{ width: 1, height: "2rem", background: "var(--border)" }} />
          <div style={{ display: "flex", gap: "var(--s-3)" }}>
            <ControlButton
              icon={sharing ? <I.ScreenOff size={20} /> : <I.Screen size={20} />}
              label={sharing ? "Stop share" : "Share"}
              active={sharing}
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
              onClick={() => setChatOpen((c) => !c)}
            />
            <ControlButton
              icon={<I.Leave size={20} />}
              label="Leave"
              leave
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
            <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>
              You can&apos;t adjust your own volume. Right-click someone else&apos;s tile to change
              their voice or screen audio level.
            </div>
          ) : (
            <>
              <VolumeRow
                label="Voice"
                value={voiceVolumes[menu.participantId] ?? 1}
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

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function VolumeRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}): ReactElement {
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
        <span>{Math.round(value * 100)}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={Math.round(Math.min(value, 1) * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        style={{ width: "100%", accentColor: "var(--accent)" }}
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
        <span>100</span>
      </div>
    </div>
  );
}
