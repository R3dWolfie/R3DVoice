import { useState, type ReactElement } from "react";

type Props = {
  src?: string | null;
  fallbackInitials: string;
  fallbackColorSeed: string;
  size: number;
  shape?: "circle" | "rounded";
};

/**
 * Unified avatar. If `src` is set, render an <img> that falls back to the
 * initials circle on error. Otherwise render the initials directly.
 *
 * fallbackColorSeed is hashed to pick one of a fixed palette so the same
 * user always gets the same circle color across the UI.
 */
export function Avatar({
  src,
  fallbackInitials,
  fallbackColorSeed,
  size,
  shape = "circle",
}: Props): ReactElement {
  const [broken, setBroken] = useState(false);
  const radius = shape === "circle" ? "50%" : "20%";

  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        onError={() => setBroken(true)}
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          objectFit: "cover",
          flexShrink: 0,
        }}
      />
    );
  }

  const letter = (fallbackInitials.replace(/[^\p{L}\p{N}]/gu, "").charAt(0) || "?").toUpperCase();
  const bg = colorForSeed(fallbackColorSeed);

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: bg,
        color: "white",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.42,
        fontWeight: 600,
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      {letter}
    </div>
  );
}

const PALETTE = [
  "#e07a5f", "#3d5a80", "#81b29a", "#f2cc8f",
  "#8a6cd1", "#d96c75", "#5b8bd6", "#5fa667",
];

function colorForSeed(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}
