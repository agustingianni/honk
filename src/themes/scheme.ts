// Base16 and Base24 color schemes (https://github.com/tinted-theming), and the
// mapping from a scheme's 16 or 24 slots to honk's colors.
//
// Many scheme files do not follow the slot meanings of the spec exactly. So the
// mapping trusts only what it can check:
// - The text color (base05) must be readable on the background (base00), or
//   the scheme is rejected.
// - base10/base11 (Base24 "darker backgrounds") are used only when they are
//   close to base00. Otherwise honk makes its own shades of base00. The same
//   goes for the selection background, base02.
//   When the side panels would look the same as the chat (a pure black base00
//   cannot get darker), they are made a little lighter instead.
// - The gray text slots (base03, base04) and the bright text (base06, base07)
//   are used only when they are readable and really gray.
// - The accent slots (base08 red, ..., base0E magenta) keep their hue, but one
//   below 3:1 on any background that text is drawn on (the chat, the panels,
//   selected and hovered rows) is moved toward the bright text until it
//   reaches 3:1 on all of them. Muted text is moved the same way to 2:1.
// There is no hue check: Gruvbox's yellow-green "green" or Rose Pine's teal
// cannot be told apart from a mistake.

export interface Theme {
  bgBase: string; // main chat canvas
  bgSidebar: string; // left server/channel rail
  bgNicklist: string; // right user list
  bgHeader: string; // top topic bar
  bgFooter: string; // bottom status bar
  bgInput: string; // prompt input bar
  bgActiveRow: string; // selected channel row
  bgMention: string; // highlighted mention message row
  bgOverlay: string; // floating omnibox surface
  bgOverlaySel: string; // selected omnibox item
  bgRowHover: string; // sidebar or nicklist row under the mouse
  bgActiveRowHover: string; // "new messages below" bar under the mouse
  bgOverlayHover: string; // omnibox item under the mouse
  borderOverlay: string; // omnibox border
  gutter: string; // hairlines and separators

  fgPrimary: string; // main chat text
  fgBright: string; // headings, active channel
  fgSecondary: string; // inactive channel, nicklist
  fgMuted: string; // timestamps, separators, hints
  fgDim: string; // join/part/system noise

  accent: string; // active indicator, channel names, prompt
  accentAlt: string; // actions (/me), notices, DMs
  green: string; // connected dot, +voice
  yellow: string; // connecting dot, @op
  red: string; // disconnected, errors, mention badge
  cyan: string; // links, TLS badge, info
  orange: string; // mode changes, highlights

  nickPalette: readonly string[]; // colors for nick hashing
}

export interface Scheme {
  system: "base16" | "base24";
  name: string;
  author: string;
  variant: "dark" | "light";
  palette: Record<string, string>;
}

const BASE16_SLOTS = Array.from(
  { length: 16 },
  (_, i) => `base0${i.toString(16).toUpperCase()}`,
);
const BASE24_SLOTS = Array.from({ length: 8 }, (_, i) => `base1${i}`);
const HEX = /^#[0-9a-fA-F]{6}$/;

/** WCAG level for normal text. A scheme whose base05 on base00 is below this is rejected. */
export const MIN_TEXT_CONTRAST = 4.5;
/** Accent colors are moved toward the bright text until they reach this on every background. */
export const MIN_ACCENT_CONTRAST = 3;
/** Muted text (timestamps, hints) is moved toward the text color until it reaches this on every background. */
export const MIN_MUTED_CONTRAST = 2;
/** A row under the mouse has at least this contrast with its normal background. */
export const MIN_HOVER_CONTRAST = 1.04;
/** A selected row (active channel, omnibox) has at least this contrast with the other rows, so it stays stronger than hover. */
export const MIN_SELECTION_CONTRAST = 1.08;
/** Side panels closer than this to the chat background cannot be seen apart from it... */
export const MIN_PANEL_CONTRAST = 1.03;
/** ...so they are made lighter, until they reach this. */
const RAISED_PANEL_CONTRAST = 1.05;

/**
 * Checks a parsed scheme file. Returns the scheme, with all colors in lower
 * case, or a list of problems.
 */
export function checkScheme(
  value: unknown,
): { ok: true; scheme: Scheme } | { ok: false; problems: string[] } {
  const s = (value ?? {}) as Partial<Scheme>;
  const problems: string[] = [];
  if (s.system !== "base16" && s.system !== "base24") {
    problems.push(`system must be "base16" or "base24", not ${JSON.stringify(s.system)}`);
  }
  if (typeof s.name !== "string" || s.name === "") problems.push("name is missing");
  if (s.variant !== "dark" && s.variant !== "light") {
    problems.push(`variant must be "dark" or "light", not ${JSON.stringify(s.variant)}`);
  }
  const slots = s.system === "base24" ? [...BASE16_SLOTS, ...BASE24_SLOTS] : BASE16_SLOTS;
  const palette: Record<string, string> = {};
  for (const slot of slots) {
    const color = (s.palette as Record<string, unknown> | undefined)?.[slot];
    if (typeof color === "string" && HEX.test(color)) {
      palette[slot] = color.toLowerCase();
    } else {
      problems.push(`${slot} must be a color like "#1a1b26", not ${JSON.stringify(color)}`);
    }
  }
  if (problems.length === 0) {
    const ratio = contrast(palette.base05!, palette.base00!);
    if (ratio < MIN_TEXT_CONTRAST) {
      problems.push(
        `text is hard to read: base05 on base00 has contrast ${ratio.toFixed(1)}:1, below ${MIN_TEXT_CONTRAST}:1`,
      );
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    scheme: {
      system: s.system!,
      name: s.name!,
      author: typeof s.author === "string" ? s.author : "",
      variant: s.variant!,
      palette,
    },
  };
}

export function schemeToTheme(scheme: Scheme): Theme {
  const p = scheme.palette as Record<string, string> & { base00: string };
  const bg = p.base00;
  const fg = p.base05!;
  // In light and dark themes alike, side panels are a little darker than the chat.
  const shade = (amount: number) => mix(bg, "#000000", amount);

  // Base24 darker backgrounds, when they are close to base00 (the base24
  // github file has a near-black base10 in a white theme).
  const nearBg = (color: string | undefined) =>
    color !== undefined && contrast(color, bg) <= 1.6 ? color : undefined;
  // The eye sees the same step in black as much bigger on a white background.
  const light = scheme.variant === "light";
  let darker = nearBg(p.base10) ?? shade(light ? 0.03 : 0.15);
  let darkest = nearBg(p.base11) ?? shade(light ? 0.06 : 0.25);
  let input = mix(bg, fg, 0.06);
  // Too close to the chat to see (Tokyo Night's panels are 1.07:1): step
  // toward the text color instead, so the panels stand out, lighter in a dark
  // theme. The footer gets the same color, so it does not blend with the
  // input bar above it, which is lighter still.
  if (contrast(darker, bg) < MIN_PANEL_CONTRAST) {
    darker = stepUntil(bg, fg, [bg], RAISED_PANEL_CONTRAST);
    darkest = darker;
    // The input bar sits right above the footer: keep it a visible step
    // lighter (Tokyo Night's input bar is 1.12:1 on the chat).
    input = stepUntil(bg, fg, [bg], 1.12);
  }
  // The selection background, softened when it is far from base00 (solarized
  // puts a strong gray there).
  const selection = nearBg(p.base02) ?? mix(bg, p.base02!, 0.4);
  const overlay = mix(bg, fg, 0.05);
  // The active channel row is also the "new messages below" bar over the
  // chat, so it must be clear on both.
  const activeRow = selectedColor(bg, selectedColor(darker, selection, fg), fg);
  const overlaySel = selectedColor(overlay, selection, fg);

  // Use a text slot only when it is readable and gray; otherwise fade the
  // main text toward the background.
  const grayText = (color: string | undefined, minContrast: number, fade: number) =>
    color !== undefined && chroma(color) < 0.25 && contrast(color, bg) >= minContrast
      ? color
      : mix(fg, bg, fade);
  const fgSecondary = grayText(p.base04, 3, 0.25);
  // Borders and fgDim are made from this gray; fgMuted itself is adjusted below.
  const muted = grayText(p.base03, 2, 0.5);

  // The brightest gray among base05..base07 (in catppuccin-latte, base06 and
  // base07 are accents; in rose-pine-dawn, base07 is a background).
  const fgBright = [p.base06, p.base07].reduce<string>(
    (best, c) =>
      c !== undefined && chroma(c) < 0.25 && contrast(c, bg) > contrast(best, bg) ? c : best,
    fg,
  );

  // Every background that text is drawn on. The text colors below are
  // checked against all of them.
  const backgrounds = {
    bgBase: bg,
    bgSidebar: darker,
    bgNicklist: darker,
    bgHeader: darker,
    bgFooter: darkest,
    bgInput: input,
    bgActiveRow: activeRow,
    bgMention: mix(bg, p.base08!, 0.15),
    bgOverlay: overlay,
    bgOverlaySel: overlaySel,
    bgRowHover: hoverColor(darker, activeRow, fg),
    bgActiveRowHover: hoverColor(activeRow, activeRow, fg),
    bgOverlayHover: hoverColor(overlay, overlaySel, fg),
  };
  const surfaces = Object.values(backgrounds);

  // Accents are used as text (channel names, notices, links), so they must
  // be readable.
  const readable = (color: string) => stepUntil(color, fgBright, surfaces, MIN_ACCENT_CONTRAST);
  // Muted text must be weaker than secondary text. When base03 is below 2:1,
  // its fallback gray can be brighter than the scheme's base04 (carbonfox),
  // and some schemes have base03 brighter than base04. Then start half-way
  // from the secondary text to the background. 2:1 on every surface still
  // wins: where secondary text is itself near 2:1, muted text can match it.
  const mutedStart =
    contrast(muted, bg) < contrast(fgSecondary, bg) ? muted : mix(fgSecondary, bg, 0.5);
  const fgMuted = stepUntil(mutedStart, fg, surfaces, MIN_MUTED_CONTRAST);

  const accents = [
    p.base08, p.base09, p.base0A, p.base0B, p.base0C, p.base0D, p.base0E,
    p.base12, p.base13, p.base14, p.base15, p.base16, p.base17,
  ];
  // Nicks are drawn on the same backgrounds as accents (mention rows, the
  // nicklist, the omnibox), so they get the same adjustment.
  const nickPalette = [
    ...new Set(
      accents.filter((c): c is string => c !== undefined && contrast(c, bg) >= 3).map(readable),
    ),
  ];

  return {
    ...backgrounds,
    borderOverlay: mix(bg, muted, 0.6),
    gutter: mix(bg, muted, 0.6),

    fgPrimary: fg,
    fgBright,
    fgSecondary,
    fgMuted,
    fgDim: mix(muted, bg, 0.35),

    accent: readable(p.base0D!),
    accentAlt: readable(p.base0E!),
    green: readable(p.base0B!),
    yellow: readable(p.base0A!),
    red: readable(p.base08!),
    cyan: readable(p.base0C!),
    orange: readable(p.base09!),

    // A theme with few readable accents still needs some nick colors.
    nickPalette:
      nickPalette.length >= 4
        ? nickPalette
        : [...new Set([p.base08!, p.base0B!, p.base0D!, p.base0E!].map(readable))],
  };
}

// --- color math -------------------------------------------------------------

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mixes `a` toward `b`. amount 0 gives `a`, 1 gives `b`. */
export function mix(a: string, b: string, amount: number): string {
  const ca = channels(a);
  const cb = channels(b);
  return (
    "#" +
    ca
      .map((v, i) => Math.round(v + (cb[i]! - v) * amount).toString(16).padStart(2, "0"))
      .join("")
  );
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Mixes `from` toward `to` in small steps, and returns the first color whose
 * contrast with each of `backgrounds` is at least `target`.
 * Returns `from` if it is already there, and `to` if no step reaches it.
 */
export function stepUntil(
  from: string,
  to: string,
  backgrounds: readonly string[],
  target: number,
): string {
  for (let i = 0; i <= 100; i++) {
    const color = mix(from, to, i / 100);
    if (backgrounds.every((b) => contrast(color, b) >= target)) return color;
  }
  return to;
}

/**
 * The background of a row under the mouse: half-way to the selection color,
 * so it never looks like the selected row. When that is too faint to see, the
 * smallest visible step toward the selection color, or toward the text color
 * when the selection color itself is that faint (or is the row's own color).
 */
export function hoverColor(background: string, selection: string, text: string): string {
  const half = mix(background, selection, 0.5);
  if (contrast(half, background) >= MIN_HOVER_CONTRAST) return half;
  const toward = contrast(selection, background) > MIN_HOVER_CONTRAST ? selection : text;
  return smallestStep(background, toward, background, MIN_HOVER_CONTRAST);
}

/**
 * The background of the selected row: steps toward the text color until it
 * is a clear step from the row color. It starts from the selection color when
 * that is on the text's side, which keeps its hue (gotham's blue), and from
 * the row color otherwise (batman's darker selection looks like a hole).
 */
function selectedColor(background: string, selection: string, text: string): string {
  const lb = luminance(background);
  const towardText = luminance(selection) > lb === luminance(text) > lb;
  return smallestStep(towardText ? selection : background, text, background, MIN_SELECTION_CONTRAST);
}

/**
 * The color nearest `from`, on the way to `to`, with `target` contrast against
 * `bg`. `from` must already be on the side of `bg` that `to` is on, so the
 * contrast only grows along the way. Returns `from` if it is already there.
 * stepUntil moves in 1% steps of the whole distance, and toward the text
 * color one step can overshoot a small target such as 1.04:1 by half; this
 * bisects instead.
 */
function smallestStep(from: string, to: string, bg: string, target: number): string {
  if (contrast(from, bg) >= target) return from;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 20; i++) {
    const middle = (low + high) / 2;
    if (contrast(mix(from, to, middle), bg) >= target) high = middle;
    else low = middle;
  }
  return mix(from, to, high);
}

/** WCAG contrast ratio, from 1 (same color) to 21 (black on white). */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** How colorful a color is: 0 for gray, 1 for a pure color such as #ff0000. */
function chroma(hex: string): number {
  const c = channels(hex);
  return (Math.max(...c) - Math.min(...c)) / 255;
}
