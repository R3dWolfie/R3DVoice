/**
 * Theme token editor plumbing (Settings › Theme, deck 3.6 + 4.14).
 *
 * The deck names eight editable tokens; each maps onto one of the app's CSS
 * custom properties. Overrides live in prefs (`themeOverrides`) keyed by the
 * REAL CSS var so applying them is a straight setProperty loop on <html> —
 * inline styles win over both :root and [data-theme] preset blocks.
 */

export interface ThemeTokenSpec {
  /** Real CSS custom property the override applies to. */
  cssVar: string;
  /** Deck 3.6 display name. */
  deckName: string;
  /** Deck 3.6 row description. */
  desc: string;
}

export const THEME_TOKENS: ThemeTokenSpec[] = [
  { cssVar: "--bg", deckName: "--bg", desc: "Page / canvas background" },
  { cssVar: "--bg-elev", deckName: "--surface", desc: "Cards, modals, inputs" },
  { cssVar: "--text", deckName: "--ink", desc: "Primary text + accent buttons" },
  { cssVar: "--text-mid", deckName: "--ink-2", desc: "Secondary text + helper labels" },
  { cssVar: "--border", deckName: "--line", desc: "Borders, dividers, input outlines" },
  { cssVar: "--accent", deckName: "--accent", desc: "Primary buttons, highlights, active state" },
  { cssVar: "--ok", deckName: "--success", desc: 'Online dots, "Live" pips, success toasts' },
  { cssVar: "--danger", deckName: "--danger", desc: "DND, leave/delete actions, error toasts" },
];

/** #RGB or #RRGGBB (deck hex inputs). */
export function isValidHex(value: string): boolean {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

/**
 * Sync <html>'s inline custom properties with the given override map:
 * clears every editable token first, then applies the map. Idempotent.
 */
export function applyThemeOverrides(overrides: Record<string, string>): void {
  const root = document.documentElement;
  for (const t of THEME_TOKENS) root.style.removeProperty(t.cssVar);
  for (const [k, v] of Object.entries(overrides)) {
    if (k.startsWith("--") && isValidHex(v)) root.style.setProperty(k, v.trim());
  }
}

/** Effective value of a token right now (override or preset), as the browser reports it. */
export function readTokenValue(cssVar: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
}

export interface ThemeExport {
  v: 1;
  r3dvoice: "theme";
  preset: string;
  overrides: Record<string, string>;
  exportedAt: string;
}

export function buildThemeExport(preset: string, overrides: Record<string, string>): ThemeExport {
  return { v: 1, r3dvoice: "theme", preset, overrides: { ...overrides }, exportedAt: new Date().toISOString() };
}

export function downloadThemeJson(preset: string, overrides: Record<string, string>): void {
  const blob = new Blob([JSON.stringify(buildThemeExport(preset, overrides), null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "theme.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Parse a theme.json backup. Returns null when it isn't one of ours. */
export function parseThemeJson(json: string): { preset: string | null; overrides: Record<string, string> } | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.r3dvoice !== "theme") return null;
    const overrides: Record<string, string> = {};
    if (obj.overrides && typeof obj.overrides === "object") {
      for (const [k, v] of Object.entries(obj.overrides as Record<string, unknown>)) {
        if (typeof v === "string" && k.startsWith("--") && isValidHex(v)) overrides[k] = v;
      }
    }
    return { preset: typeof obj.preset === "string" ? obj.preset : null, overrides };
  } catch {
    return null;
  }
}
