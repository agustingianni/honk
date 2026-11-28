/**
 * How search hits and Context views look. The search itself is in src/log/search.ts.
 */

import type { Log } from "../log/log.ts";
import { joinText, kickText, nickText, partText, quitText, topicText } from "../irc/eventText.ts";
import type { LogContext, SearchHit } from "../log/search.ts";
import type { ChatMessage, MessageKind } from "../types.ts";
import { sameDay } from "./dayDivider.ts";
import { glyphs } from "./glyphs.ts";
import { formatTime } from "./timeFormat.ts";

/** The Log to search, or why there is none, such as "logs.enabled is false in the config". */
export type LogSearch = Pick<Log, "search" | "context"> | { off: string };

const SAME_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

const pad = (n: number) => String(n).padStart(2, "0");

/** When a hit was written: "14:02" today, "Oct 1 14:02" this year, "2025-12-31" before. */
export function hitTime(time: number, now: Date): string {
  const date = new Date(time);
  // Always HH:mm, whatever the format of chat lines: the date goes beside it.
  const clock = formatTime(date, "HH:mm");
  if (sameDay(date, now)) return clock;
  if (date.getFullYear() === now.getFullYear()) return `${SAME_YEAR.format(date)} ${clock}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** How many characters before the first match stay when the text is cut to show it. */
const LEAD = 14;

/**
 * One result row: "09:05  #rust  alice: the borrow checker", and the indexes of the
 * matched characters in it. When the first match would fall past `width`, the text
 * starts a little before it, after an ellipsis.
 */
export function hitRow(hit: SearchHit, now: Date, width: number): { label: string; highlights: number[] } {
  const who = hit.kind === "action" ? `* ${hit.nick} ` : `${hit.nick}: `;
  const prefix = `${hitTime(hit.time, now)}  ${hit.buffer}  ${who}`;
  let parts = hit.text;
  const firstHit = parts.findIndex((p) => p.hit);
  if (firstHit !== -1) {
    const before = parts.slice(0, firstHit).reduce((n, p) => n + p.text.length, 0);
    const end = prefix.length + before + parts[firstHit]!.text.length;
    if (end > width && before > LEAD) {
      const cut = before - LEAD;
      let skipped = 0;
      parts = parts.flatMap((p) => {
        const keep = Math.max(0, skipped + p.text.length - cut);
        const piece = p.text.slice(p.text.length - keep);
        skipped += p.text.length;
        return piece ? [{ ...p, text: piece }] : [];
      });
      if (parts[0] && !parts[0].hit) parts[0] = { ...parts[0], text: parts[0].text.trimStart() };
      parts = [{ text: glyphs.ellipsis, hit: false }, ...parts];
    }
  }
  let label = prefix;
  const highlights: number[] = [];
  for (const part of parts) {
    if (part.hit) for (let i = 0; i < part.text.length; i++) highlights.push(label.length + i);
    label += part.text;
  }
  return { label, highlights };
}

/** The Lines of a Context view as chat lines, worded as the chat pane words them. */
export function contextMessages(context: LogContext): ChatMessage[] {
  return context.lines.map((row) => {
    const line = (kind: MessageKind, text: string, from?: string): ChatMessage => ({
      id: `log-${row.id}`,
      timestamp: new Date(row.time),
      kind,
      from,
      text,
      isSelf: row.self,
      isMention: row.mention,
    });
    switch (row.kind) {
      case "message":
      case "action":
      case "notice":
        return line(row.kind, row.text, row.nick);
      case "join":
        return line("join", joinText(row.nick, context.buffer));
      case "part":
        return line("part", partText(row.nick, context.buffer, row.text));
      case "quit":
        return line("part", quitText(row.nick, row.text));
      case "nick":
        return line("system", nickText(row.nick, row.subject ?? ""));
      case "kick":
        return line("error", kickText(row.subject ?? "", row.nick, row.text));
      default:
        return line("system", topicText(row.nick, row.text));
    }
  });
}
