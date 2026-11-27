import { useMemo, type ReactNode } from "react";
import { theme, useThemeVersion } from "../theme.ts";
import { safeLinkUrl } from "../openUrl.ts";
import { cellWidth, truncate } from "./display.ts";
import { glyphs } from "./glyphs.ts";

// Standard mIRC 0-15 colors (tuned slightly for dark TrueColor backgrounds)
const IRC_COLORS_16: readonly string[] = [
  "#e2e8ff", // 0  white
  "#565f89", // 1  black (readable slate on dark bg)
  "#3d59a1", // 2  navy
  "#41a6b5", // 3  green
  "#f7768e", // 4  red
  "#a9445a", // 5  brown/maroon
  "#9d7cd8", // 6  purple
  "#ff9e64", // 7  orange
  "#e0af68", // 8  yellow
  "#9ece6a", // 9  light green
  "#2ac3de", // 10 teal
  "#7dcfff", // 11 light cyan
  "#7aa2f7", // 12 light blue
  "#bb9af7", // 13 pink/magenta
  "#737aa2", // 14 grey
  "#a9b1d6", // 15 light grey
];

// Extended mIRC colors 16-98 (official IRC modern spec)
const IRC_COLORS_EXT: readonly string[] = [
  "#470000", "#472100", "#474700", "#324700", "#004700", "#00472c", "#004747", "#002747", "#000047", "#2e0047", "#470047", "#47002a",
  "#740000", "#743a00", "#747400", "#517400", "#007400", "#007449", "#007474", "#004074", "#000074", "#4b0074", "#740074", "#740045",
  "#b50000", "#b56300", "#b5b500", "#7db500", "#00b500", "#00b571", "#00b5b5", "#0063b5", "#0000b5", "#7500b5", "#b500b5", "#b5006b",
  "#ff0000", "#ff8c00", "#ffff00", "#b2ff00", "#00ff00", "#00ffa0", "#00ffff", "#008cff", "#0000ff", "#a500ff", "#ff00ff", "#ff0098",
  "#ff5959", "#ffb459", "#ffff71", "#cfff60", "#6fff6f", "#65ffc9", "#6dffff", "#59b4ff", "#5959ff", "#c459ff", "#ff66ff", "#ff59bc",
  "#ff9c9c", "#ffd39c", "#ffff9c", "#e2ff9c", "#9cff9c", "#9cffdb", "#9cffff", "#9cd3ff", "#9c9cff", "#dc9cff", "#ff9cff", "#ff94d3",
  "#000000", "#131313", "#282828", "#363636", "#4d4d4d", "#656565", "#818181", "#9f9f9f", "#bcbcbc", "#e2e2e2", "#ffffff",
];

function ircColorToHex(code: number): string | undefined {
  if (code === 99) return undefined;
  if (code >= 0 && code < 16) return IRC_COLORS_16[code];
  if (code >= 16 && code < 16 + IRC_COLORS_EXT.length) {
    return IRC_COLORS_EXT[code - 16];
  }
  return undefined;
}

export interface FormattedSegment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  href?: string;
}

// A link ends at a control or format character, such as U+202E (RIGHT-TO-LEFT
// OVERRIDE). The screen does not show them, so a link that kept them would open
// an address other than the one you read.
const URL_RE = /https?:\/\/[^\s<>"'`\p{Cc}\p{Cf}]+/gu;

function trimUrlTrailingPunct(url: string): { url: string; trailing: string } {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if (/[.,;:!?]/.test(ch)) {
      end--;
      continue;
    }
    if (ch === ")") {
      const opens = (url.slice(0, end).match(/\(/g) ?? []).length;
      const closes = (url.slice(0, end).match(/\)/g) ?? []).length;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    if (ch === "]") {
      const opens = (url.slice(0, end).match(/\[/g) ?? []).length;
      const closes = (url.slice(0, end).match(/\]/g) ?? []).length;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return { url: url.slice(0, end), trailing: url.slice(end) };
}

function splitSegmentUrls(seg: FormattedSegment): FormattedSegment[] {
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let lastIdx = 0;
  const out: FormattedSegment[] = [];

  while ((match = URL_RE.exec(seg.text)) !== null) {
    if (match.index > lastIdx) {
      out.push({ ...seg, text: seg.text.slice(lastIdx, match.index) });
    }
    const { url, trailing } = trimUrlTrailingPunct(match[0]);
    const href = url ? safeLinkUrl(url) : undefined;
    if (href) {
      // Always the link color on the normal background: the sender's colors
      // could make a link invisible, so that a click on "empty" space opens it.
      out.push({ ...seg, text: url, href, underline: true, fg: theme.cyan, bg: undefined });
    } else if (url) {
      out.push({ ...seg, text: url });
    }
    if (trailing) {
      out.push({ ...seg, text: trailing });
    }
    lastIdx = match.index + match[0].length;
  }

  if (out.length === 0) return [seg];
  if (lastIdx < seg.text.length) {
    out.push({ ...seg, text: seg.text.slice(lastIdx) });
  }
  return out;
}

/**
 * Parses mIRC formatting codes (\x02 bold, \x1D italic, \x1F underline,
 * \x16 reverse, \x03 color, \x04 hex color, \x0F reset) and splits out URLs.
 */
export function parseIrcText(input: string): FormattedSegment[] {
  const rawSegments: FormattedSegment[] = [];
  let bold = false;
  let italic = false;
  let underline = false;
  let reverse = false;
  let fg: string | undefined;
  let bg: string | undefined;
  let buf = "";

  const flush = () => {
    if (!buf) return;
    const effFg = reverse ? (bg ?? theme.bgBase) : fg;
    const effBg = reverse ? (fg ?? theme.fgPrimary) : bg;
    rawSegments.push({
      text: buf,
      ...(effFg ? { fg: effFg } : {}),
      ...(effBg ? { bg: effBg } : {}),
      ...(bold ? { bold: true } : {}),
      ...(italic ? { italic: true } : {}),
      ...(underline ? { underline: true } : {}),
    });
    buf = "";
  };

  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);

    switch (code) {
      case 0x02: // Bold
        flush();
        bold = !bold;
        break;
      case 0x1d: // Italic
        flush();
        italic = !italic;
        break;
      case 0x1f: // Underline
        flush();
        underline = !underline;
        break;
      case 0x16: // Reverse
        flush();
        reverse = !reverse;
        break;
      case 0x0f: // Reset all
        flush();
        bold = false;
        italic = false;
        underline = false;
        reverse = false;
        fg = undefined;
        bg = undefined;
        break;
      case 0x1e: // Strikethrough (no native tag, strip cleanly)
      case 0x11: // Monospace (already monospace terminal, strip cleanly)
        break;
      case 0x03: {
        // mIRC color: \x03[fg[,bg]]
        flush();
        const rest = input.slice(i + 1);
        const m = /^(\d{1,2})(?:,(\d{1,2}))?/.exec(rest);
        if (!m) {
          fg = undefined;
          bg = undefined;
        } else {
          fg = ircColorToHex(Number(m[1]));
          if (m[2] !== undefined) {
            bg = ircColorToHex(Number(m[2]));
          }
          i += m[0].length;
        }
        break;
      }
      case 0x04: {
        // Hex color: \x04[RRGGBB[,RRGGBB]]
        flush();
        const rest = input.slice(i + 1);
        const m = /^([0-9a-fA-F]{6})(?:,([0-9a-fA-F]{6}))?/.exec(rest);
        if (!m) {
          fg = undefined;
          bg = undefined;
        } else {
          fg = `#${m[1]}`;
          if (m[2] !== undefined) {
            bg = `#${m[2]}`;
          }
          i += m[0].length;
        }
        break;
      }
      default:
        // Strip other low ASCII control characters (except tab)
        if (code < 0x20 && code !== 0x09) break;
        buf += input[i]!;
        break;
    }
  }
  flush();

  const finalSegments: FormattedSegment[] = [];
  for (const seg of rawSegments) {
    finalSegments.push(...splitSegmentUrls(seg));
  }
  return finalSegments;
}

/**
 * Cuts the shown text of `segments` to at most `max` terminal cells, with
 * `glyphs.ellipsis` at the end when it cuts. A link that is cut stops being a link.
 */
export function truncateSegments(segments: FormattedSegment[], max: number): FormattedSegment[] {
  const total = segments.reduce((sum, seg) => sum + cellWidth(seg.text), 0);
  if (total <= max) return segments;
  const out: FormattedSegment[] = [];
  const markerWidth = cellWidth(glyphs.ellipsis);
  let room = max;
  for (const seg of segments) {
    const width = cellWidth(seg.text);
    // The last segment that fits must leave room for the ellipsis.
    if (width + markerWidth <= room) {
      out.push(seg);
      room -= width;
      continue;
    }
    // More text follows, so this segment must end in the ellipsis, even when
    // the segment alone fits in the room.
    const text =
      room < markerWidth
        ? truncate(glyphs.ellipsis, room, "")
        : `${truncate(seg.text, room - markerWidth, "")}${glyphs.ellipsis}`;
    const cut = { ...seg, text };
    // A cut link is not a link: "https://github.com..." could hide the real host,
    // as in "https://github.com.evil.example/".
    if (cut.href) {
      delete cut.href;
      delete cut.underline;
    }
    out.push(cut);
    break;
  }
  return out;
}

/** The characters from `start` up to (not including) `end` of the shown text. */
export interface TextRange {
  start: number;
  end: number;
}

/**
 * Underlines the characters of `range` in `segments`, counted in the shown
 * text (formatting codes left out). It splits the segments the range starts or
 * ends inside. A range outside the text changes nothing.
 */
export function underlineRange(segments: FormattedSegment[], range: TextRange): FormattedSegment[] {
  const out: FormattedSegment[] = [];
  let at = 0;
  for (const seg of segments) {
    const from = Math.max(range.start - at, 0);
    const to = Math.min(range.end - at, seg.text.length);
    at += seg.text.length;
    if (from >= to) {
      out.push(seg);
      continue;
    }
    if (from > 0) out.push({ ...seg, text: seg.text.slice(0, from) });
    out.push({ ...seg, text: seg.text.slice(from, to), underline: true });
    if (to < seg.text.length) out.push({ ...seg, text: seg.text.slice(to) });
  }
  return out;
}

interface FormattedTextProps {
  text: string;
  defaultFg?: string;
  forceItalic?: boolean;
  /** Cut the text to this many terminal cells, after the formatting codes are removed. */
  maxWidth?: number;
}

export function FormattedText({
  text,
  defaultFg = theme.fgPrimary,
  forceItalic = false,
  maxWidth,
}: FormattedTextProps) {
  // Links get theme.cyan while parsing, so parse again when the theme changes.
  const themeVersion = useThemeVersion();
  const segments = useMemo(() => {
    const parsed = parseIrcText(text);
    return maxWidth === undefined ? parsed : truncateSegments(parsed, maxWidth);
  }, [text, themeVersion, maxWidth]);
  return <Segments segments={segments} defaultFg={defaultFg} forceItalic={forceItalic} />;
}

/** `text` without mIRC formatting codes, split into plain runs and URLs. For LinkedText. */
export function plainSegments(text: string): { text: string; href?: string }[] {
  return parseIrcText(text).map(({ text, href }) => (href ? { text, href } : { text }));
}

/**
 * Plain text in one color, with its URLs as links. For system lines, such as honk's
 * own notices and the MOTD. mIRC formatting codes are removed, not shown: a MOTD with
 * "\x034red" shows "red", not "4red".
 */
export function LinkedText({ text, fg }: { text: string; fg: string }) {
  const themeVersion = useThemeVersion();
  const segments = useMemo(() => plainSegments(text), [text, themeVersion]);
  return <Segments segments={segments} defaultFg={fg} forceItalic={false} />;
}

export function Segments({
  segments,
  defaultFg,
  forceItalic,
}: {
  segments: FormattedSegment[];
  defaultFg: string;
  forceItalic: boolean;
}) {
  return (
    <>
      {segments.map((seg, idx) => {
        let node: ReactNode = seg.text;
        if (seg.underline) node = <u>{node}</u>;
        if (seg.italic || forceItalic) node = <em>{node}</em>;
        if (seg.bold) node = <strong>{node}</strong>;

        if (seg.href) {
          return (
            // Keyed by the URL too: OpenTUI reads `href` only when it creates
            // the link, so a reused <a> would show new text but open the old URL.
            <a key={`${idx}:${seg.href}`} href={seg.href} fg={seg.fg ?? theme.cyan} bg={seg.bg}>
              {node}
            </a>
          );
        }

        return (
          <span key={idx} fg={seg.fg ?? defaultFg} bg={seg.bg}>
            {node}
          </span>
        );
      })}
    </>
  );
}
