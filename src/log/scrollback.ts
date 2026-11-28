/**
 * Scrollback from the Log: the Lines a Buffer shows when it opens, and the older pages
 * it loads when you scroll to its top (see Log.scrollback):
 *
 *   open #honk           -> the newest 200 Lines, oldest first
 *   scroll to the top    -> the 200 Lines before the oldest one shown, and so on
 *
 * Redacted lines come too, with who deleted them; storedMessages words them.
 */

import { joinText, kickText, nickText, partText, quitText, topicText } from "../irc/eventText.ts";
import type { ChatMessage, MessageKind } from "../types.ts";
import type { StoredLine } from "./storedLine.ts";

/** How many Lines a Buffer loads when it opens, and with each older page. */
export const SCROLLBACK_LINES = 200;

/**
 * Lines of Buffer `buffer` from the Log as ChatMessages, worded as the chat pane words
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
