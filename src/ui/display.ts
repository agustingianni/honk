import { measureEditText, type WidthMethod } from "@opentui/core";
import { theme } from "../theme.ts";
import type { BufferState, ConnectionStatus } from "../types.ts";

/**
 * Rows of the three top headers (sidebar, chat, user list). They must match so the
 * headers line up as one bar: a row of padding, the text, a row of padding.
 */
export const HEADER_HEIGHT = 3;

const graphemes = new Intl.Segmenter();
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
/** Control characters, except the tab: <text> draws a tab as 2 cells. */
const CONTROLS = /^[\x00-\x08\x0a-\x1f\x7f-\x9f]+$/;
/** Each grapheme the server sends adds an entry, so start over past this many. */
const MAX_CACHED_WIDTHS = 4096;

/**
 * How the renderer counts the cells of a grapheme. It depends on the terminal:
 * a ZWJ family emoji takes 2 cells with "unicode" (Ghostty, kitty, iTerm2) and 8
 * with "wcwidth" (Terminal.app, Alacritty, tmux before 3.6). `App` sets it from
 * the renderer.
 */
let widthMethod: WidthMethod = "unicode";
const graphemeWidths = new Map<string, number>();

/**
 * Measures from now on as the renderer does with `method`. Returns true when the
 * method changed, so text measured before must be measured again.
 */
export function setWidthMethod(method: WidthMethod): boolean {
  if (method === widthMethod) return false;
  widthMethod = method;
  graphemeWidths.clear();
  return true;
}

function graphemeWidth(grapheme: string): number {
  let width = graphemeWidths.get(grapheme);
  if (width === undefined) {
    // <text> hides control characters, but measureEditText shows them as "^X".
    width = CONTROLS.test(grapheme) ? 0 : measureEditText(grapheme, { widthMethod });
    if (graphemeWidths.size >= MAX_CACHED_WIDTHS) graphemeWidths.clear();
    graphemeWidths.set(grapheme, width);
  }
  return width;
}

/** The terminal cells that `str` takes, counted as the renderer counts them. */
export function cellWidth(str: string): number {
  if (PRINTABLE_ASCII.test(str)) return str.length;
  let width = 0;
  for (const { segment } of graphemes.segment(str)) width += graphemeWidth(segment);
  return width;
}

/**
 * The index in `str` of the grapheme that covers cell `col` (counted from 0),
 * or -1 when `str` ends before that cell. In "日本" cells 0 and 1 are "日"
 * (index 0), and cells 2 and 3 are "本" (index 1).
 */
export function indexAtCell(str: string, col: number): number {
  if (col < 0) return -1;
  if (PRINTABLE_ASCII.test(str)) return col < str.length ? col : -1;
  let width = 0;
  for (const { segment, index } of graphemes.segment(str)) {
    width += graphemeWidth(segment);
    if (col < width) return index;
  }
  return -1;
}

/**
 * Cuts `str` to at most `max` terminal cells, with "…" at the end when it cuts.
 * It measures cells, not UTF-16 code units: "田中さん" is 4 code units and 8 cells.
 * It cuts between graphemes, so an emoji with a skin tone or a ZWJ stays whole.
 * When a wide character does not fit, the result can be one cell short of `max`.
 */
export function truncate(str: string, max: number): string {
  if (max <= 0) return "";
  if (PRINTABLE_ASCII.test(str)) return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
  // Where the text ends if it gets cut: the most that fits before the "…".
  let cutAt = -1;
  let width = 0;
  for (const { segment, index } of graphemes.segment(str)) {
    width += graphemeWidth(segment);
    if (cutAt < 0 && width > max - 1) cutAt = index;
    if (width > max) return `${str.slice(0, cutAt)}…`;
  }
  return str;
}

export function statusIndicator(status: ConnectionStatus): { glyph: string; color: string } {
  switch (status) {
    case "connected":
      return { glyph: "●", color: theme.green };
    case "connecting":
    case "reconnecting":
      return { glyph: "◐", color: theme.yellow };
    case "error":
      return { glyph: "●", color: theme.red };
    default:
      return { glyph: "○", color: theme.fgMuted };
  }
}

/** "14:02": the time column of the chat, and of a copied line. */
export function formatTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function bufferDisplayName(buf: BufferState): string {
  return buf.kind === "dm" ? `@${buf.name}` : buf.name;
}

export function unreadBadge(unread: number): string {
  return unread > 99 ? "99+" : String(unread);
}

export function scrollboxStyle(bg: string) {
  return {
    rootOptions: { backgroundColor: bg },
    viewportOptions: { backgroundColor: bg },
    contentOptions: { backgroundColor: bg },
    scrollbarOptions: {
      showArrows: false,
      trackOptions: { foregroundColor: theme.gutter, backgroundColor: bg },
    },
  };
}
