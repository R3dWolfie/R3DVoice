// Generate R3DVoice app icons from the Monogram R Refined logo.
//
// The SVG markup below mirrors `src/renderer/src/components/Icons.tsx`
// (the `Logo` component) with three changes:
//   1. `useId()` is replaced by stable string IDs (`rv-mg-bg`, `rv-mg-r`).
//   2. The outer <svg> declares `xmlns` and a 1024x1024 default size.
//   3. `oklch(...)` colors are pre-converted to sRGB hex — librsvg (the SVG
//      renderer sharp uses) doesn't support the CSS Color 4 `oklch()`
//      function, so the original gradient stops would render as black.
//      Conversion done via the OKLab->sRGB matrix; see commit history for
//      the inline derivation.
//
// Output:
//   - build/icons/icon-{16,32,48,64,128,256,512,1024}.png
//   - build/icon.png  (1024x1024 master; electron-builder auto-derives from it)
//
// Follow-up: .icns (macOS) and .ico (Windows) generation requires multi-image
// container assembly (e.g. png2icns + png2ico, or icon-gen). Skipped for now —
// electron-builder produces working Linux + Windows builds from PNG sources.

import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const buildDir = join(projectRoot, "build");
const iconsDir = join(buildDir, "icons");

const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];

// sRGB equivalents of the Logo's oklch palette:
//   oklch(0.72 0.19 22)   -> #ff696d   (bg gradient: lightest)
//   oklch(0.58 0.18 22)   -> #cf4047   (bg gradient: mid; record-dot)
//   oklch(0.38 0.14 22)   -> #7c111d   (bg gradient: deepest)
//   oklch(0.97 0.012 25)  -> #fdf2f1   (R fill: top)
//   oklch(0.88 0.030 25)  -> #ebd0ce   (R fill: bottom)
const SVG = `<svg viewBox="0 0 28 28" width="1024" height="1024" xmlns="http://www.w3.org/2000/svg" fill="none">
  <defs>
    <radialGradient id="rv-mg-bg" cx="32%" cy="22%" r="90%">
      <stop offset="0" stop-color="#ff696d" />
      <stop offset=".55" stop-color="#cf4047" />
      <stop offset="1" stop-color="#7c111d" />
    </radialGradient>
    <linearGradient id="rv-mg-r" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fdf2f1" />
      <stop offset="1" stop-color="#ebd0ce" />
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="28" height="28" rx="6.4" fill="url(#rv-mg-bg)" />
  <rect x="0.5" y="0.5" width="27" height="27" rx="6" fill="none" stroke="rgba(255,255,255,.10)" stroke-width=".6" />
  <path
    transform="translate(0.35,0.5)"
    fill="rgba(0,0,0,.20)"
    d="M8.1 5.9 h8.4 a4.7 4.7 0 0 1 4.7 4.7 v.95
       a4.7 4.7 0 0 1 -3.45 4.55 l4.4 6.4 h-4.05
       l-3.9 -5.95 h-2.35 v5.95 h-3.75 z
       M11.85 9.3 v3.45 h4.4 a1.72 1.72 0 0 0 0 -3.45 z"
  />
  <path
    fill="url(#rv-mg-r)"
    d="M8.1 5.9 h8.4 a4.7 4.7 0 0 1 4.7 4.7 v.95
       a4.7 4.7 0 0 1 -3.45 4.55 l4.4 6.4 h-4.05
       l-3.9 -5.95 h-2.35 v5.95 h-3.75 z
       M11.85 9.3 v3.45 h4.4 a1.72 1.72 0 0 0 0 -3.45 z"
  />
  <circle cx="16.25" cy="11.05" r=".62" fill="#cf4047" />
</svg>
`;

async function main() {
  mkdirSync(iconsDir, { recursive: true });
  const svgBuffer = Buffer.from(SVG, "utf8");

  const written = [];
  for (const size of SIZES) {
    const out = join(iconsDir, `icon-${size}.png`);
    await sharp(svgBuffer, { density: Math.max(72, Math.round((size / 512) * 384)) })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(out);
    written.push(out);
  }

  // Master icon at the build/ root — electron-builder picks this up for Linux
  // and uses it as the source for derived sizes. 1024×1024 PNG is the
  // recommended master.
  const masterPath = join(buildDir, "icon.png");
  await sharp(svgBuffer, { density: 768 })
    .resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(masterPath);
  written.push(masterPath);

  // eslint-disable-next-line no-console
  console.log("[generate-icon] wrote:");
  for (const p of written) {
    // eslint-disable-next-line no-console
    console.log("  -", p);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[generate-icon] failed:", err);
  process.exit(1);
});
