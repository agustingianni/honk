/**
 * Lines you missed while the connection was down.
 *
 * When a registered connection is lost, honk notes when it last heard from the server,
 * your nick, and the buffers you had open. After the reconnect, the server's chat
 * history (CHATHISTORY) fills those buffers again. A history line newer than that time
 * was never shown live, so it counts as unread, and as a mention if it names you or is
 * a DM.
 *
 * The nick matters because after a reconnect the server often gives you "goose_": the
 * dead connection still holds "goose". A line sent while you were away says "goose:".
 */

import type { BufferKind, ChatMessage } from "../types.ts";
import { isChannelName, sameNick } from "./names.ts";
import { isReadableLine } from "./readMarker.ts";

/** What honk knew when the connection was lost. */
export interface MissedWindow {
  /** When honk last heard from the server (local clock, ms). */
  since: number;
  /** Your nick at that time. */
  nick: string;
  /** The buffers open at that time. A channel joined later has no "missed" lines. */
  buffers: ReadonlySet<string>;
}

/**
 * History timestamps come from the server's clock and `since` from ours. Start the
 * window a little early, so a small clock difference doesn't hide a line. A line that
 * honk did show live is dropped as a duplicate before this check.
 */
export const MISSED_MARGIN_MS = 5_000;

/** True if `message`, going into `bufferName`, arrived while the connection was down. */
export function isMissedLine(
  window: MissedWindow | undefined,
  bufferName: string,
  message: ChatMessage,
): boolean {
  return (
    window !== undefined &&
    Boolean(message.isHistory) &&
    isReadableLine(message) &&
    window.buffers.has(bufferName) &&
    message.timestamp.getTime() >= window.since - MISSED_MARGIN_MS
  );
}

/** True if a missed line is for you: any line in a DM, or one that names you in a channel. */
export function isMissedMention(
  window: MissedWindow,
  bufferKind: BufferKind,
  message: ChatMessage,
  currentNick: string,
  mentionsNick: (text: string, nick: string) => boolean,
): boolean {
  if (bufferKind === "dm") return true;
  return mentionsNick(message.text, window.nick) || mentionsNick(message.text, currentNick);
}

/** The batch types a server uses for a CHATHISTORY TARGETS reply. */
export const TARGETS_BATCH_TYPES: ReadonlySet<string> = new Set([
  "draft/chathistory-targets",
  "chathistory-targets",
]);

/**
 * The nicks that wrote to you, from the lines of a CHATHISTORY TARGETS reply:
 *
 *   CHATHISTORY TARGETS bob timestamp=2026-11-26T22:02:00.000Z
 *
 * irc-client-ts only names the commands in its own table, and CHATHISTORY isn't one,
 * so these lines arrive with `command` undefined. They are recognized by "TARGETS".
 *
 * Channels are left out: honk loads their history when it rejoins them. So is your own
 * nick (`ownNicks`), which some servers list for notes to yourself.
 */
export function dmTargets(
  lines: readonly { command?: string; params: readonly string[] }[],
  ownNicks: readonly string[],
): string[] {
  const nicks: string[] = [];
  for (const line of lines) {
    if (line.command !== undefined && line.command.toUpperCase() !== "CHATHISTORY") continue;
    const [sub, target] = line.params;
    if (sub?.toUpperCase() !== "TARGETS" || !target || isChannelName(target)) continue;
    if (ownNicks.some((n) => sameNick(n, target))) continue;
    if (!nicks.some((n) => sameNick(n, target))) nicks.push(target);
  }
  return nicks;
}
