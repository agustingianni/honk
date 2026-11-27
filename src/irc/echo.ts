/**
 * Matches the server's echo of a line you sent to the line honk already shows.
 *
 * Honk shows a line as soon as you send it. With IRCv3 echo-message the server sends
 * it back, and that echo must not show as a second line. The echo can differ from what
 * you typed, so honk remembers the text as it went out, after irc-client-ts split a
 * long line into several PRIVMSGs:
 *
 *   you type:   "\x02brb\x02"            -> waiting: ["\x02brb\x02"]
 *   echo:       "brb" (channel is +c)    -> matches your line
 *
 *   you type:   a 600-character line     -> waiting: [part 0, part 1]
 *   echoes:     part 0, then part 1      -> part 0 takes over your line, part 1 is a new line
 *
 * Texts are compared without IRC formatting and without spaces at either end: some
 * channels strip colors, and the library sends " ok" so that the server reads "ok".
 *
 * Labels (IRCv3 labeled-response) would be exact, but soju doesn't pass them back.
 */

import { stripIrcFormatting } from "../notify.ts";
import { systemClock, type Clock } from "../clock.ts";

/** Parts kept per server, so lines that never match can't pile up. */
export const MAX_WAITING_ECHOES = 200;
/**
 * How long a part waits for its echo. A bouncer echoes only after the network does, so
 * this is long; a line the server refuses stops waiting at once (see forget).
 */
export const ECHO_WAIT_MS = 5 * 60_000;

/** One PRIVMSG as sent: a line, or one part of a split line. */
export interface SentPart {
  kind: "message" | "action";
  text: string;
}

interface Waiting extends SentPart {
  /** The buffer name, folded (see nameKey). */
  buffer: string;
  /** The id of the line honk showed when you sent it. */
  messageId: string;
  /** The first part of the line, whose echo takes over the line shown. */
  first: boolean;
  sentAt: number;
}

/** The text as compared: "\x02hi\x02 " and "hi" are the same line. */
function comparable(text: string): string {
  return stripIrcFormatting(text).trim();
}

export class EchoTracker {
  /** Per server, the parts still waiting for their echo, oldest first. */
  private waiting = new Map<string, Waiting[]>();

  constructor(private readonly clock: Clock = systemClock) {}

  /**
   * Call after sending a line, with each PRIVMSG it was sent as. `bufferKey` is the
   * buffer's name folded with the server's casemapping (see nameKey).
   */
  add(serverId: string, bufferKey: string, messageId: string, parts: SentPart[]): void {
    const list = this.current(serverId);
    const sentAt = this.clock.now();
    parts.forEach(({ kind, text }, i) =>
      list.push({
        buffer: bufferKey,
        kind,
        text: comparable(text),
        messageId,
        first: i === 0,
        sentAt,
      }),
    );
    if (list.length > MAX_WAITING_ECHOES) list.splice(0, list.length - MAX_WAITING_ECHOES);
    this.set(serverId, list);
  }

  /**
   * Takes the oldest waiting part that this echo matches. Returns the id of the line
   * shown if it is the line's first part; the echo of a later part is a new line.
   */
  take(serverId: string, bufferKey: string, echo: SentPart): string | undefined {
    const list = this.current(serverId);
    const want = comparable(echo.text);
    const i = list.findIndex(
      (w) => w.buffer === bufferKey && w.kind === echo.kind && w.text === want,
    );
    const [w] = i === -1 ? [] : list.splice(i, 1);
    this.set(serverId, list);
    return w?.first ? w.messageId : undefined;
  }

  /** Stops waiting for the echo of one line, such as one the server refused. */
  forget(serverId: string, messageId: string): void {
    this.set(serverId, this.current(serverId).filter((w) => w.messageId !== messageId));
  }

  /** Call when the connection closes: the server won't echo lines sent on it. */
  drop(serverId: string): void {
    this.waiting.delete(serverId);
  }

  /** The parts still waiting, without the ones that waited too long. */
  private current(serverId: string): Waiting[] {
    const oldest = this.clock.now() - ECHO_WAIT_MS;
    return (this.waiting.get(serverId) ?? []).filter((w) => w.sentAt >= oldest);
  }

  private set(serverId: string, list: Waiting[]): void {
    if (list.length > 0) this.waiting.set(serverId, list);
    else this.waiting.delete(serverId);
  }
}
