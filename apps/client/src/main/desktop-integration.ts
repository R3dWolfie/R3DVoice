import { writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Best-effort path to a usable window icon.
 * - Packaged (AppImage): the user-dir icon copied by `writeDesktopEntry`
 *   from inside the AppImage squashfs.
 * - Dev: the source `build/icon.png` relative to the compiled main dir.
 * Returns undefined if nothing resolves - caller should treat as "no icon."
 */
export function resolveIconPath(): string | undefined {
  const userIcon = join(homedir(), ".local/share/icons/hicolor/512x512/apps/r3dvoice.png");
  if (existsSync(userIcon)) return userIcon;
  // Dev fallback. import.meta.dirname = apps/client/out/main at runtime.
  try {
    const devIcon = join(import.meta.dirname, "..", "..", "build", "icon.png");
    if (existsSync(devIcon)) return devIcon;
  } catch {
    // import.meta.dirname may be undefined in some contexts
  }
  return undefined;
}

/**
 * electron-builder stores the icon inside the AppImage at
 * `usr/share/icons/hicolor/<size>/apps/<sanitized-package-name>.png`.
 * For scoped names like @r3dvoice/client it becomes `@r3dvoiceclient.png`.
 * Find whatever's there without hardcoding the sanitized name.
 */
function findAppIcon(appDir: string): string | null {
  const iconRoot = join(appDir, "usr/share/icons/hicolor");
  if (!existsSync(iconRoot)) return null;
  for (const size of ["1024x1024", "512x512", "256x256", "128x128", "64x64", "48x48", "32x32"]) {
    const appsDir = join(iconRoot, size, "apps");
    if (!existsSync(appsDir)) continue;
    try {
      const pngs = readdirSync(appsDir).filter((f) => f.endsWith(".png"));
      if (pngs[0]) return join(appsDir, pngs[0]);
    } catch {
      // ignore and try next size
    }
  }
  return null;
}

/**
 * On Linux AppImage builds, writes a `.desktop` file on every launch pointing
 * at the currently-running AppImage. Survives auto-update: after electron-updater
 * replaces the AppImage, the next launch rewrites the entry to the new path.
 *
 * No-op on X11-non-AppImage, non-Linux, or dev runs (when APPIMAGE env is unset).
 */
export function writeDesktopEntry(): void {
  if (process.platform !== "linux") return;
  const appImagePath = process.env["APPIMAGE"];
  if (!appImagePath) return;

  const home = homedir();

  // Copy icon from the AppImage's mounted squashfs ($APPDIR) to a persistent
  // user icon dir. electron-builder stores the icon at a path derived from the
  // package name; findAppIcon locates whichever PNG is there.
  try {
    const appDir = process.env["APPDIR"];
    if (appDir) {
      const sourceIcon = findAppIcon(appDir);
      if (sourceIcon) {
        const iconDir = join(home, ".local/share/icons/hicolor/512x512/apps");
        mkdirSync(iconDir, { recursive: true });
        copyFileSync(sourceIcon, join(iconDir, "r3dvoice.png"));
      }
    }
  } catch {
    // Icon is cosmetic - proceed without it.
  }

  // Write .desktop. X-AppImage-Integrate=false tells AppImageLauncher to leave
  // this entry alone (no renaming/moving). We manage it ourselves.
  try {
    const appsDir = join(home, ".local/share/applications");
    mkdirSync(appsDir, { recursive: true });
    const desktopContent = [
      "[Desktop Entry]",
      "Name=R3DVoice",
      "GenericName=Voice Chat",
      "Comment=Open-source screenshare + voice chat",
      `Exec="${appImagePath}" %U`,
      `Icon=${join(home, ".local/share/icons/hicolor/512x512/apps/r3dvoice.png")}`,
      "Type=Application",
      "Categories=Network;Chat;AudioVideo;",
      "StartupWMClass=R3DVoice",
      "X-AppImage-Integrate=false",
      "MimeType=x-scheme-handler/r3dvoice;x-scheme-handler/redvoice;",
      "",
    ].join("\n");
    writeFileSync(join(appsDir, "r3dvoice.desktop"), desktopContent, { mode: 0o644 });
    // Clean up the pre-rename entry so launchers don't show two apps.
    for (const stale of [
      join(appsDir, "redvoice.desktop"),
      join(home, ".local/share/icons/hicolor/512x512/apps/redvoice.png"),
    ]) {
      try {
        unlinkSync(stale);
      } catch {
        /* absent - fine */
      }
    }
  } catch {
    // Desktop entry is a convenience - if writing fails, app still runs.
  }
}
