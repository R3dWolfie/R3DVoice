import { useId, type CSSProperties, type ReactElement } from "react";

export interface IconProps {
  size?: number;
  style?: CSSProperties;
  className?: string;
}

function Mic({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

function MicOff({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M9 9V6a3 3 0 0 1 6 0v5" />
      <path d="M15 14a3 3 0 0 1-5.83 1" />
      <path d="M5 11a7 7 0 0 0 11 5" />
      <path d="M19 11a7 7 0 0 1-.5 2.6" />
      <path d="M12 18v3" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

function Speaker({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M3 10v4a1 1 0 0 0 1 1h3l4 4V5L7 9H4a1 1 0 0 0-1 1z" />
      <path d="M16 8a5 5 0 0 1 0 8" />
      <path d="M19 5a9 9 0 0 1 0 14" />
    </svg>
  );
}

function Info({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-5" />
      <path d="M12 8.01l.01-.011" />
    </svg>
  );
}

function StarFilled({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function Home({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h5v-6h4v6h5V9.5" />
    </svg>
  );
}

function Users({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5" />
      <path d="M16 5.2a3.5 3.5 0 0 1 0 5.6" />
      <path d="M17.5 15.3c2 .7 3.5 2.3 4 4.7" />
    </svg>
  );
}

function Bell({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9" />
      <path d="M10 19.5a2.2 2.2 0 0 0 4 0" />
    </svg>
  );
}

function Lock({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function Screen({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
    </svg>
  );
}

function ScreenOff({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

function Leave({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
      <path d="M9 17l-5-5 5-5" />
      <path d="M4 12h11" />
    </svg>
  );
}

function Settings({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

function Logout({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

function Copy({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function Check({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function Plus({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function Link({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 1 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 1 0 7 7l1-1" />
    </svg>
  );
}

function X({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M6 6l12 12M6 18L18 6" />
    </svg>
  );
}

function Chevron({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function ChevronDown({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function Grid({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function Star({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M12 3l2.7 5.5 6.3.9-4.5 4.4 1 6.2L12 17l-5.5 3 1-6.2-4.5-4.4 6.3-.9z" />
    </svg>
  );
}

function Clock({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function Headphones({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
      <path d="M21 19a2 2 0 0 1-2 2h-1v-6h3z" />
      <path d="M3 19a2 2 0 0 0 2 2h1v-6H3z" />
    </svg>
  );
}

function Wave({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h-1" />
    </svg>
  );
}

function Pin({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M12 17v5" />
      <path d="M9 3h6l-1 5 3 3v3H7v-3l3-3z" />
    </svg>
  );
}

function Chat({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M21 12a8 8 0 0 1-12.3 6.7L3 21l2.3-5.7A8 8 0 1 1 21 12z" />
    </svg>
  );
}

function Smile({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <path d="M9 9h.01M15 9h.01" />
    </svg>
  );
}

function Send({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

function Pip({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function Camera({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </svg>
  );
}

function CameraOff({ size = 18, style, className }: IconProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>
      <path d="M16 16V19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" />
      <path d="M21 9.5L23 7v10l-7-5" />
      <path d="M1 1l22 22" />
    </svg>
  );
}

// Monogram R Refined: bold custom-cut "R" on a red squircle with a record-dot
// punched into the bowl. useId() for gradient IDs keeps SSR/hydration stable
// across renders (replacing the original Math.random() suffix).
export function Logo({ size = 22, style, className }: IconProps): ReactElement {
  const rawId = useId();
  const id = `rv-mg-${rawId.replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 28 28" width={size} height={size} fill="none" style={style} className={className}>
      <defs>
        <radialGradient id={`${id}-bg`} cx="32%" cy="22%" r="90%">
          <stop offset="0" stopColor="oklch(0.72 0.21 16)" />
          <stop offset=".55" stopColor="oklch(0.59 0.22 13)" />
          <stop offset="1" stopColor="oklch(0.40 0.16 13)" />
        </radialGradient>
        <linearGradient id={`${id}-r`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="oklch(0.97 0.012 25)" />
          <stop offset="1" stopColor="oklch(0.88 0.030 25)" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="28" height="28" rx="6.4" fill={`url(#${id}-bg)`} />
      <rect x="0.5" y="0.5" width="27" height="27" rx="6" fill="none" stroke="rgba(255,255,255,.10)" strokeWidth=".6" />
      <path
        transform="translate(0.35,0.5)"
        fill="rgba(0,0,0,.20)"
        d="M8.1 5.9 h8.4 a4.7 4.7 0 0 1 4.7 4.7 v.95
           a4.7 4.7 0 0 1 -3.45 4.55 l4.4 6.4 h-4.05
           l-3.9 -5.95 h-2.35 v5.95 h-3.75 z
           M11.85 9.3 v3.45 h4.4 a1.72 1.72 0 0 0 0 -3.45 z"
      />
      <path
        fill={`url(#${id}-r)`}
        d="M8.1 5.9 h8.4 a4.7 4.7 0 0 1 4.7 4.7 v.95
           a4.7 4.7 0 0 1 -3.45 4.55 l4.4 6.4 h-4.05
           l-3.9 -5.95 h-2.35 v5.95 h-3.75 z
           M11.85 9.3 v3.45 h4.4 a1.72 1.72 0 0 0 0 -3.45 z"
      />
      <circle cx="16.25" cy="11.05" r=".62" fill="oklch(0.59 0.22 13)" />
    </svg>
  );
}

export const I = {
  Home,
  Users,
  Bell,
  Mic,
  MicOff,
  Speaker,
  Screen,
  ScreenOff,
  Leave,
  Settings,
  Logout,
  Copy,
  Check,
  Plus,
  Link,
  X,
  Chevron,
  ChevronDown,
  Grid,
  Star,
  Clock,
  Headphones,
  Wave,
  Pin,
  Chat,
  Smile,
  Send,
  Pip,
  Camera,
  CameraOff,
  Logo,
  Info,
  StarFilled,
  Lock,
};
