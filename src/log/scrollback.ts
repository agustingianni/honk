/**
 * Scrollback from the Log: the Lines a Buffer shows when it opens, and the older pages
 * it loads when you scroll to its top. Pages go by (time, row id), so two Lines in the
 * same millisecond are neither skipped nor shown twice:
 *
 *   open #honk           -> the newest 200 Lines, oldest first
 *   scroll to the top    -> the 200 Lines before the oldest one shown, and so on
 *
 * Redacted lines come too, with who deleted them; the screen words them.
 */

import type { Database } from "bun:sqlite";
import { joinText, kickText, nickText, partText, quitText, topicText } from "../irc/eventText.ts";
import type { ChatMessage, MessageKind } from "../types.ts";
import { STORED_COLUMNS, type StoredLine, type StoredRow, storedLine } from "./search.ts";

/** How many Lines a Buffer loads when it opens, and with each older page. */
export const SCROLLBACK_LINES = 200;

/** Where an older page starts: before the Line with this time and row id. */
export interface LineCursor {
  time: number;
  id: number;
}

/**
 * Up to `limit` Lines of the Buffer with row id `bufferId`, oldest first: the newest
 * ones, or with `before`, the ones before it.
 */
export function scrollbackLines(
  db: Database,
  bufferId: number,
  before: LineCursor | undefined,
  limit: number,
): StoredLine[] {
  const after = before ? "AND (ts < ? OR (ts = ? AND id < ?))" : "";
  const params = before ? [bufferId, before.time, before.time, before.id, limit] : [bufferId, limit];
  const rows = db
    .query(
      `SELECT ${STORED_COLUMNS} FROM message WHERE buffer_id = ? ${after}
       ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(...params) as StoredRow[];
  return rows.reverse().map(storedLine);
}

/**
 * Lines of Buffer `buffer` from the Log as chat lines, worded as the chat pane words
 * them live. A Redacted line reads "[message deleted by alice]".
 */
export function storedMessages(buffer: string, lines: readonly StoredLine[]): ChatMessage[] {
  return lines.map((row) => {
    const line = (kind: MessageKind, text: string, from?: string): ChatMessage => ({
      id: `log-${row.id}`,
      logId: row.id,
      msgid: row.msgid,
      timestamp: new Date(row.time),
      timeFromServer: row.timeFromServer,
      kind,
      from,
      text,
      isSelf: row.self,
      isMention: row.mention,
    });
    if (row.redactedBy !== undefined) {
      // It keeps its msgid, so a Replay of the deleted text is dropped (ADR 0003).
      return { ...line("message", `[message deleted by ${row.redactedBy}]`, row.nick), isMention: false };
    }
    switch (row.kind) {
      case "message":
      case "action":
      case "notice":
        return line(row.kind, row.text, row.nick);
      case "join":
        return line("join", joinText(row.nick, buffer));
      case "part":
        return line("part", partText(row.nick, buffer, row.text));
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
