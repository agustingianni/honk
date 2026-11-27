// Every symbol the UI draws, in a Unicode set and an ASCII set. Some fonts have
// no glyph for these symbols, and some terminals draw them 2 cells wide (their
// East Asian Width is "Ambiguous"), which breaks the layout. With --ascii, or
// "ascii": true in the config, honk draws only ASCII.
//
// This is the only file in src/ui/ that may hold a character outside ASCII.
// glyphs.test.ts checks that.

import type { BorderCharacters } from "@opentui/core";

export interface Glyphs {
  /** Connection status in the status bar: connected (green) or error (red). */
  statusOn: string;
  statusConnecting: string;
  statusOff: string;
  /** Marks the selected row in the sidebar and the omnibox. */
  selectedRow: string;
  /** Labels of join, part and system lines in the chat. */
  join: string;
  part: string;
  system: string;
  /** Repeated to draw the "new" divider. */
  rule: string;
  /** Ends a cut name or label. */
  ellipsis: string;
  /** Between the channel name and the topic. */
  topicSeparator: string;
  /** Before the input in the chat and the omnibox. */
  prompt: string;
  /** The keys that switch buffers, in the status bar hints. */
  upDown: string;
  /** The characters of box borders. Undefined draws the box's `borderStyle`. */
  border: BorderCharacters | undefined;
  /**
   * Whether scrollbars show. OpenTUI draws the thumb with block characters
   * (U+2584, U+2588) and has no option for other ones, so ASCII hides it.
   */
  scrollbar: boolean;
}

export const UNICODE_GLYPHS: Readonly<Glyphs> = {
  statusOn: "●",
  statusConnecting: "◐",
  statusOff: "○",
  selectedRow: "▎",
  join: "→",
  part: "←",
  system: "·",
  rule: "─",
  ellipsis: "…",
  topicSeparator: "—",
  prompt: "❯",
  upDown: "↑/↓",
  border: undefined,
  scrollbar: true,
};

export const ASCII_GLYPHS: Readonly<Glyphs> = {
  statusOn: "*",
  statusConnecting: "~",
  statusOff: "o",
  selectedRow: ">",
  // The nick column is right-aligned, so 2 characters fit.
  join: "->",
  part: "<-",
  system: "-",
  rule: "-",
  ellipsis: "...",
  topicSeparator: "-",
  prompt: ">",
  upDown: "Up/Down",
  border: {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
    topT: "+",
    bottomT: "+",
    leftT: "+",
    rightT: "+",
    cross: "+",
  },
  scrollbar: false,
};

// The symbols in use. Components read this object directly. applyGlyphs copies
// the other set into it, as applyTheme does for colors.
export const glyphs: Glyphs = { ...UNICODE_GLYPHS };

export function applyGlyphs(ascii: boolean): void {
  Object.assign(glyphs, ascii ? ASCII_GLYPHS : UNICODE_GLYPHS);
}

/**
 * Whether to draw ASCII. The config ("ascii" or --ascii, --no-ascii) decides
 * when it is set. Otherwise ASCII is on for a terminal that likely can't draw
 * the symbols: TERM is "dumb" or "linux" (the Linux console), or the locale does
 * not say UTF-8. The locale is the first one set of LC_ALL, LC_CTYPE and LANG,
 * so LC_ALL=C wins over LANG=en_US.UTF-8.
 */
export function wantsAscii(
  setting: boolean | undefined,
  env: Record<string, string | undefined>,
): boolean {
  if (setting !== undefined) return setting;
  if (env.TERM === "dumb" || env.TERM === "linux") return true;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return !/utf-?8/i.test(locale);
}
