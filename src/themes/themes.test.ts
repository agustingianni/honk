import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allThemes,
  builtinThemes,
  DEFAULT_THEME_ID,
  loadUserThemes,
  selectTheme,
} from "./index.ts";
import { BUNDLED } from "./bundled.ts";
import {
  checkScheme,
  contrast,
  MIN_ACCENT_CONTRAST,
  MIN_HOVER_CONTRAST,
  MIN_MUTED_CONTRAST,
  MIN_PANEL_CONTRAST,
  MIN_SELECTION_CONTRAST,
  MIN_TEXT_CONTRAST,
  mix,
  schemeToTheme,
  type Theme,
} from "./scheme.ts";

// A valid Base16 palette (Catppuccin Mocha).
const PALETTE16 = {
  base00: "#1e1e2e", base01: "#181825", base02: "#313244", base03: "#45475a",
  base04: "#585b70", base05: "#cdd6f4", base06: "#f5e0dc", base07: "#b4befe",
  base08: "#f38ba8", base09: "#fab387", base0A: "#f9e2af", base0B: "#a6e3a1",
  base0C: "#94e2d5", base0D: "#89b4fa", base0E: "#cba6f7", base0F: "#f2cdcd",
};

const ACCENTS = ["accent", "accentAlt", "red", "green", "yellow", "cyan", "orange"] as const;

/**
 * The lowest contrast of `color` on any background of `t` (every bg* color:
 * text is drawn on all of them), and that background.
 */
function worstContrast(t: Theme, color: string): [number, string] {
  return Object.entries(t)
    .filter(([key]) => key.startsWith("bg"))
    .map(([key, bg]): [number, string] => [contrast(color, bg as string), key])
    .reduce((a, b) => (b[0] < a[0] ? b : a));
}

function scheme16(palette: Record<string, string> = PALETTE16) {
  return { system: "base16", name: "Test", author: "me", variant: "dark", palette };
}

function yaml(palette: Record<string, string> = PALETTE16): string {
  const lines = Object.entries(palette).map(([k, v]) => `  ${k}: "${v}"`);
  return `system: "base16"\nname: "Test"\nauthor: "me"\nvariant: "dark"\npalette:\n${lines.join("\n")}\n`;
}

describe("bundled themes", () => {
  const themes = builtinThemes();

  test("includes Tokyo Night as the default and every bundled file", () => {
    expect(themes[0]!.id).toBe(DEFAULT_THEME_ID);
    expect(themes.length).toBe(1 + Object.keys(BUNDLED).length);
  });

  for (const entry of themes) {
    test(`${entry.id} has readable text, visible panels and only hex colors`, () => {
      const t = entry.theme;
      expect(contrast(t.fgPrimary, t.bgBase)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      // Accents, nicks and muted text are drawn on every background, selected rows included.
      for (const [label, color, min] of [
        ...ACCENTS.map((key) => [key, t[key], MIN_ACCENT_CONTRAST] as const),
        ...t.nickPalette.map((c) => [`nick color ${c}`, c, MIN_ACCENT_CONTRAST] as const),
        ["fgMuted", t.fgMuted, MIN_MUTED_CONTRAST] as const,
      ]) {
        const [worst, surface] = worstContrast(t, color);
        expect(worst, `${label} on ${surface}`).toBeGreaterThanOrEqual(min);
      }
      // Muted text (timestamps, hints) is weaker than secondary text (the nicklist).
      expect(contrast(t.fgMuted, t.bgBase), "fgMuted than fgSecondary").toBeLessThan(
        contrast(t.fgSecondary, t.bgBase),
      );
      expect(contrast(t.bgSidebar, t.bgBase)).toBeGreaterThanOrEqual(MIN_PANEL_CONTRAST);
      expect(t.nickPalette.length).toBeGreaterThanOrEqual(4);
      // The active channel, and the omnibox row that Enter picks, must be easy to see.
      expect(contrast(t.bgActiveRow, t.bgSidebar)).toBeGreaterThanOrEqual(MIN_SELECTION_CONTRAST);
      // bgActiveRow is also the "new messages below" bar over the chat.
      expect(contrast(t.bgActiveRow, t.bgBase)).toBeGreaterThanOrEqual(MIN_SELECTION_CONTRAST);
      expect(contrast(t.bgOverlaySel, t.bgOverlay)).toBeGreaterThanOrEqual(MIN_SELECTION_CONTRAST);
      // A row under the mouse shows, but looks weaker than the selected row.
      // Where the selection color is itself faint, the hover stays at the
      // smallest visible step.
      for (const [background, hover, selection] of [
        [t.bgSidebar, t.bgRowHover, t.bgActiveRow],
        [t.bgNicklist, t.bgRowHover, t.bgActiveRow],
        [t.bgOverlay, t.bgOverlayHover, t.bgOverlaySel],
        [t.bgActiveRow, t.bgActiveRowHover, t.bgActiveRow],
      ] as const) {
        const shown = contrast(hover, background);
        expect(shown, hover).toBeGreaterThanOrEqual(MIN_HOVER_CONTRAST - 0.01);
        const selected = contrast(selection, background);
        if (selection !== background) {
          expect(shown, hover).toBeLessThan(Math.max(selected, MIN_HOVER_CONTRAST + 0.01));
        }
      }
      for (const [key, value] of Object.entries(t)) {
        const colors = Array.isArray(value) ? value : [value];
        for (const c of colors) expect(c, key).toMatch(/^#[0-9a-f]{6}$/);
      }
    });
  }
});

describe("checkScheme", () => {
  test("accepts a valid scheme and lowercases its colors", () => {
    const r = checkScheme(scheme16({ ...PALETTE16, base00: "#1E1E2E" }));
    expect(r.ok && r.scheme.palette.base00).toBe("#1e1e2e");
  });

  test("rejects text that is hard to read", () => {
    const r = checkScheme(scheme16({ ...PALETTE16, base05: "#303040" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems[0]).toContain("hard to read");
  });

  test("rejects a missing slot and a bad color", () => {
    const { base0F: _, ...missing } = PALETTE16;
    const r = checkScheme(scheme16({ ...missing, base08: "red" }));
    expect(!r.ok && r.problems).toEqual([
      'base08 must be a color like "#1a1b26", not "red"',
      'base0F must be a color like "#1a1b26", not undefined',
    ]);
  });

  test("needs the 8 extra slots in a base24 scheme", () => {
    const r = checkScheme({ ...scheme16(), system: "base24" });
    expect(!r.ok && r.problems.length).toBe(8);
  });
});

describe("schemeToTheme", () => {
  test("makes side panel shades when a base16 scheme has none", () => {
    const r = checkScheme(scheme16());
    if (!r.ok) throw new Error("bad test scheme");
    const t = schemeToTheme(r.scheme);
    expect(t.bgSidebar).toBe(mix("#1e1e2e", "#000000", 0.15));
    expect(t.red).toBe("#f38ba8");
  });

  test("ignores base24 backgrounds far from base00", () => {
    // From base24/github.yaml: a near-black "darker background" in a white theme.
    const palette = {
      ...PALETTE16,
      base00: "#ffffff", base05: "#1f2328",
      base10: "#1f2328", base11: "#000000",
      base12: "#a40e26", base13: "#633c01", base14: "#1a7f37",
      base15: "#1b7c83", base16: "#0969da", base17: "#8250df",
    };
    const r = checkScheme({ ...scheme16(palette), system: "base24", variant: "light" });
    if (!r.ok) throw new Error(r.problems.join("; "));
    const t = schemeToTheme(r.scheme);
    expect(t.bgSidebar).toBe(mix("#ffffff", "#000000", 0.03));
    expect(t.bgFooter).toBe(mix("#ffffff", "#000000", 0.06));
  });

  test("makes side panels lighter when the background is pure black", () => {
    const r = checkScheme(scheme16({ ...PALETTE16, base00: "#000000", base01: "#000000" }));
    if (!r.ok) throw new Error(r.problems.join("; "));
    const t = schemeToTheme(r.scheme);
    expect(contrast(t.bgSidebar, "#000000")).toBeGreaterThanOrEqual(MIN_PANEL_CONTRAST);
    expect(contrast(t.bgInput, t.bgFooter)).toBeGreaterThan(1.04);
  });

  test("makes a faint or dark selection a visible step toward the text", () => {
    const lighter = (a: string, b: string) => contrast(a, "#000000") > contrast(b, "#000000");
    for (const [variant, palette] of [
      // base02 is the same as the background.
      ["dark", { ...PALETTE16, base02: "#1e1e2e" }],
      // base02 is darker than the panels: clear contrast, but a dark hole.
      ["dark", { ...PALETTE16, base02: "#0a0a14" }],
      ["light", { ...PALETTE16, base00: "#ffffff", base05: "#1f2328", base02: "#ffffff" }],
    ] as const) {
      const r = checkScheme({ ...scheme16(palette), variant });
      if (!r.ok) throw new Error(r.problems.join("; "));
      const t = schemeToTheme(r.scheme);
      // The active row sits on the sidebar and, as the new-messages bar, on the chat.
      for (const [selected, backgrounds] of [
        [t.bgActiveRow, [t.bgSidebar, t.bgBase]],
        [t.bgOverlaySel, [t.bgOverlay]],
      ] as const) {
        const shown = Math.min(...backgrounds.map((b) => contrast(selected, b)));
        expect(shown).toBeGreaterThanOrEqual(MIN_SELECTION_CONTRAST);
        expect(shown).toBeLessThan(MIN_SELECTION_CONTRAST + 0.03);
        for (const b of backgrounds) expect(lighter(selected, b)).toBe(variant === "dark");
      }
    }
  });

  test("moves a hard-to-read accent toward the text until it reaches 3:1 everywhere", () => {
    // A dark blue accent on a dark background.
    const r = checkScheme(scheme16({ ...PALETTE16, base0D: "#1e3050" }));
    if (!r.ok) throw new Error(r.problems.join("; "));
    const t = schemeToTheme(r.scheme);
    expect(t.accent).not.toBe("#1e3050");
    // On the hardest surface, and only just: the color moves no further than it needs to.
    const [worst] = worstContrast(t, t.accent);
    expect(worst).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
    expect(worst).toBeLessThan(MIN_ACCENT_CONTRAST + 0.2);
  });

  test("does not use a colorful base06 as bright text", () => {
    // catppuccin-latte: base06 is rosewater and base07 is lavender.
    const palette = {
      ...PALETTE16,
      base00: "#eff1f5", base05: "#4c4f69", base06: "#dc8a78", base07: "#7287fd",
    };
    const r = checkScheme({ ...scheme16(palette), variant: "light" });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(schemeToTheme(r.scheme).fgBright).toBe("#4c4f69");
  });
});

describe("user themes", () => {
  test("loads good files and skips bad ones with a warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "honk-themes-"));
    try {
      writeFileSync(join(dir, "mine.yaml"), yaml());
      writeFileSync(join(dir, "nord.yml"), yaml());
      writeFileSync(join(dir, "dim.yaml"), yaml({ ...PALETTE16, base05: "#303040" }));
      writeFileSync(join(dir, "broken.yaml"), "palette: [");
      writeFileSync(join(dir, "notes.txt"), "not a theme");

      const { entries, warnings } = loadUserThemes(dir);
      expect(entries.map((e) => e.id)).toEqual(["mine", "nord"]);
      expect(warnings.length).toBe(2);
      expect(warnings[0]).toStartWith("theme broken.yaml skipped:");
      expect(warnings[1]).toStartWith("theme dim.yaml skipped: text is hard to read");

      // A user file replaces the bundled theme with the same id.
      const nord = allThemes(entries).find((t) => t.id === "nord")!;
      expect(nord.source).toBe("user");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("a missing folder gives no themes and no warnings", () => {
    expect(loadUserThemes("/nonexistent/honk/themes")).toEqual({ entries: [], warnings: [] });
  });
});

describe("selectTheme", () => {
  const themes = builtinThemes();

  test("finds a theme by id", () => {
    expect(selectTheme("nord", themes).entry.id).toBe("nord");
  });

  test("no setting gives the default without a warning", () => {
    expect(selectTheme(undefined, themes)).toEqual({ entry: themes[0]! });
  });

  test("an unknown id gives the default and a warning", () => {
    const r = selectTheme("nrod", themes);
    expect(r.entry.id).toBe(DEFAULT_THEME_ID);
    expect(r.warning).toStartWith('unknown theme "nrod", using tokyo-night.');
  });
});
