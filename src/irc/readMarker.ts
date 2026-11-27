/**
 * Read markers (IRCv3 draft/read-marker): how far you have read each buffer, kept by
 * the server or bouncer and shared by all your clients.
 *
 * soju sends one after it replays each JOIN, and again whenever another client of
 * yours moves it:
 *
 *   :goose!goose@host MARKREAD #honk timestamp=2026-11-26T22:14:03.120Z
 *   :goose!goose@host MARKREAD #honk *          (never read)
 *
 * honk sends one while you look at a buffer, with the time of its newest line:
 *
 *   MARKREAD #honk timestamp=2026-11-27T09:02:41.008Z
 *
 * The server only moves a marker forward, so an older time is ignored.
 *
 * After a restart, the history lines newer than the marker are the ones you have not
 * read: they get the "new messages" divider and the unread count.
 */

import type { ChatMessage } from "../types.ts";
import { parseTimestampParam } from "./ircLine.ts";

export const READ_MARKER_CAP = "draft/read-marker";

/**
 * Reads the params of a server MARKREAD, such as ["#honk", "timestamp=2026-..."], into
 * the target and the marker in ms. Undefined for "*" (never read), and for a line with
 * no target or a time that does not parse.
 */
export function parseMarkRead(
  params: readonly string[],
): { target: string; time: number } | undefined {
  const [target, value] = params;
  const time = parseTimestampParam(value);
  return target && time !== undefined ? { target, time } : undefined;
}

/**
 * Ergo replays joins, parts and quits in its history as ordinary messages from this
 * service ("goose_ joined the channel") when the client doesn't ask for
 * draft/event-playback. They are not chat, and one that names you is not a mention.
 */
const HISTORY_SERVICE = "histserv";

/**
 * Lines that can be unread: chat from someone else. Joins, notices, your own lines and
 * Ergo's HistServ replays are not. missed.ts uses the same rule.
 */
export function isReadableLine(message: ChatMessage): boolean {
  return (
    !message.isSelf &&
    (message.kind === "message" || message.kind === "action") &&
    message.from?.toLowerCase() !== HISTORY_SERVICE
  );
}

/** True if the marker is at or past `message`: you read it, maybe on another client. */
export function isMarkedRead(marker: number | undefined, message: ChatMessage): boolean {
  return marker !== undefined && message.timestamp.getTime() <= marker;
}

/** True if `message` is chat from someone else that is newer than the marker. */
export function isAfterMarker(marker: number | undefined, message: ChatMessage): boolean {
  return marker !== undefined && isReadableLine(message) && !isMarkedRead(marker, message);
}

/**
 * The time to send as your marker for a buffer you are looking at: its newest line
 * from someone else, with the server's time. Lines honk made itself ("You joined") and
 * lines you sent have the local clock's time, so both are skipped: a clock that runs
 * behind would put the marker before a line you have read. Your own lines never count
 * as unread, so leaving them out loses nothing. Undefined when there is no such line.
 */
export function newestServerTime(messages: readonly ChatMessage[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.isSelf) continue;
    if (m.kind === "message" || m.kind === "action" || m.kind === "notice") {
      return m.timestamp.getTime();
    }
  }
  return undefined;
}

/** What a buffer's badge and divider become when its marker moves. */
export interface UnreadState {
  unread: number;
  hasMention: boolean;
  firstUnreadId?: string;
}

/**
 * Counts the lines newer than `marker`. `isForYou` says whether one of them is a
 * mention, for the badge; it stops being asked once one is.
 *
 *   marker 10:00, lines [alice 09:59, bob 10:01, you 10:02, carol 10:03]
 *   -> { unread: 2, firstUnreadId: <bob's line> }
 */
export function unreadAfter(
  messages: readonly ChatMessage[],
  marker: number,
  isForYou: (message: ChatMessage) => boolean,
): UnreadState {
  let unread = 0;
  let hasMention = false;
  let firstUnreadId: string | undefined;
  for (const m of messages) {
    if (!isAfterMarker(marker, m)) continue;
    unread++;
    firstUnreadId ??= m.id;
    hasMention ||= isForYou(m);
  }
  return { unread, hasMention, firstUnreadId };
}
