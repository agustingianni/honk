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

export const READ_MARKER_CAP = "draft/read-marker";

/** A MARKREAD from the server: the target, and the marker in ms (null for "*"). */
export interface MarkRead {
  target: string;
  time: number | null;
}

/**
 * Reads the params of a server MARKREAD, such as ["#honk", "timestamp=2026-..."].
 * Returns undefined when the line has no target or a time that does not parse.
 */
export function parseMarkRead(params: readonly string[]): MarkRead | undefined {
  const [target, value] = params;
  if (!target) return undefined;
  if (value === undefined || value === "*") return { target, time: null };
  if (!value.startsWith("timestamp=")) return undefined;
  const time = Date.parse(value.slice("timestamp=".length));
  return Number.isNaN(time) ? undefined : { target, time };
}

/** The MARKREAD param for a time in ms: "timestamp=2026-11-27T09:02:41.008Z". */
export function markReadParam(ms: number): string {
  return `timestamp=${new Date(ms).toISOString()}`;
}

/** Lines that can be unread: chat from someone else. Joins, notices and your own lines are not. */
export function isReadableLine(message: ChatMessage): boolean {
  return !message.isSelf && (message.kind === "message" || message.kind === "action");
}

/** True if `message` is chat from someone else that is newer than the marker. */
export function isAfterMarker(marker: number | undefined, message: ChatMessage): boolean {
  return (
    marker !== undefined && isReadableLine(message) && message.timestamp.getTime() > marker
  );
}

/**
 * The time to send as your marker for a buffer you are looking at: its newest line
 * that came from the server. Lines honk made itself ("You joined") have the local
 * clock's time, and a line still being sent has no server time yet, so both are
 * skipped. Undefined when there is no such line.
 */
export function newestServerTime(messages: readonly ChatMessage[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.delivery) continue;
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
 * mention, for the badge.
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
    if (isForYou(m)) hasMention = true;
  }
  return { unread, hasMention, firstUnreadId };
}
