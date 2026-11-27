// All themes honk knows: honk's own Tokyo Night, the schemes bundled from
// tinted-theming (see SOURCE.md and catalog.json), and the user's
// scheme files in ~/.config/honk/themes/.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkScheme, schemeToTheme, type Theme } from "./scheme.ts";

import { BUNDLED } from "./bundled.ts";

export type { Theme } from "./scheme.ts";

export interface ThemeEntry {
  /** What the user writes in config: "theme": "nord". */
  id: string;
  /** Display name, such as "Nord". */
  name: string;
  author: string;
  variant: "dark" | "light";
  source: "builtin" | "bundled" | "user";
  theme: Theme;
}

export const DEFAULT_THEME_ID = "tokyo-night";

// honk's own, hand-tuned theme. No scheme file for Tokyo Night follows the
// Base16 slot meanings, so this one is written out in full.
const TOKYO_NIGHT: Theme = {
  bgBase: "#1a1b26",
  bgSidebar: "#13141c",
  bgNicklist: "#15161f",
  bgHeader: "#16161e",
  bgFooter: "#12131a",
  bgInput: "#222436",
  bgActiveRow: "#24283b",
  bgMention: "#2b2135",
  bgOverlay: "#1f2335",
  bgOverlaySel: "#292e42",
  bgRowHover: "#1c1e2c",
  bgActiveRowHover: "#272b3e",
  bgOverlayHover: "#24293c",
  borderOverlay: "#3b4261",
  gutter: "#3b4261",

  fgPrimary: "#c0caf5",
  fgBright: "#e2e8ff",
  fgSecondary: "#a9b1d6",
  fgMuted: "#565f89",
  fgDim: "#414868",

  accent: "#7aa2f7",
  accentAlt: "#bb9af7",
  green: "#9ece6a",
  yellow: "#e0af68",
  red: "#f7768e",
  cyan: "#7dcfff",
  orange: "#ff9e64",

  nickPalette: [
    "#7aa2f7", // blue
    "#bb9af7", // purple
    "#7dcfff", // cyan
    "#9ece6a", // green
    "#e0af68", // gold
    "#f7768e", // coral
    "#ff9e64", // orange
    "#2ac3de", // teal
    "#73daca", // mint
    "#b4f9f8", // ice
    "#c099ff", // lavender
    "#ff757f", // rose
    "#ffc777", // peach
    "#4fd6be", // seafoam
  ],
};

export function builtinThemes(): ThemeEntry[] {
  const entries: ThemeEntry[] = [
    {
      id: DEFAULT_THEME_ID,
      name: "Tokyo Night",
      author: "honk, based on Tokyo Night by enkia",
      variant: "dark",
      source: "builtin",
      theme: TOKYO_NIGHT,
    },
  ];
  for (const [id, value] of Object.entries(BUNDLED)) {
    const checked = checkScheme(value);
    // scripts/fetch-themes.ts and src/themes/themes.test.ts run the same
    // check, so this only fails if someone edits a file by hand.
    if (!checked.ok) throw new Error(`bundled theme ${id}: ${checked.problems.join("; ")}`);
    const { scheme } = checked;
    entries.push({
      id,
      name: scheme.name,
      author: scheme.author,
      variant: scheme.variant,
      source: "bundled",
      theme: schemeToTheme(scheme),
    });
  }
  return entries;
}

export function userThemesDir(): string {
  return join(homedir(), ".config", "honk", "themes");
}

/**
 * Reads every *.yaml and *.yml file in `dir`. A file that cannot be read or
 * fails the checks is skipped, with a warning that says why.
 */
export function loadUserThemes(dir: string = userThemesDir()): {
  entries: ThemeEntry[];
  warnings: string[];
} {
  const entries: ThemeEntry[] = [];
  const warnings: string[] = [];
  if (!existsSync(dir)) return { entries, warnings };
  for (const file of readdirSync(dir).sort()) {
    const match = /^(.+)\.ya?ml$/.exec(file);
    if (!match) continue;
    const id = match[1]!;
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(readFileSync(join(dir, file), "utf-8"));
    } catch (err) {
      warnings.push(`theme ${file} skipped: ${(err as Error).message}`);
      continue;
    }
    const checked = checkScheme(parsed);
    if (!checked.ok) {
      warnings.push(`theme ${file} skipped: ${checked.problems.join("; ")}`);
      continue;
    }
    const { scheme } = checked;
    entries.push({
      id,
      name: scheme.name,
      author: scheme.author,
      variant: scheme.variant,
      source: "user",
      theme: schemeToTheme(scheme),
    });
  }
  return { entries, warnings };
}

/**
 * The theme for a config "theme" value. An unknown id gives the default theme
 * and a warning.
 */
export function selectTheme(
  id: string | undefined,
  themes: ThemeEntry[],
): { entry: ThemeEntry; warning?: string } {
  const fallback = themes.find((t) => t.id === DEFAULT_THEME_ID)!;
  if (id === undefined) return { entry: fallback };
  const entry = themes.find((t) => t.id === id);
  if (entry) return { entry };
  return {
    entry: fallback,
    warning: `unknown theme "${id}", using ${DEFAULT_THEME_ID}. The themes are: ${themes.map((t) => t.id).join(", ")}`,
  };
}

/** Built-in themes and user themes. A user theme replaces a built-in one with the same id. */
export function allThemes(user: ThemeEntry[]): ThemeEntry[] {
  const byId = new Map<string, ThemeEntry>();
  for (const entry of [...builtinThemes(), ...user]) byId.set(entry.id, entry);
  return [...byId.values()];
}
