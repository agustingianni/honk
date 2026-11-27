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

import type { ActiveBuffer, ChatMessage } from "../types.ts";
import { systemClock, type Clock } from "../clock.ts";
import { parseTimestampParam } from "./ircLine.ts";
import { type Casemapping, nameKey } from "./names.ts";

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

/**
 * How long honk waits before sending MARKREAD for the buffer on screen, so a burst of
 * lines, or flipping through buffers, sends one. Tests pass a shorter one.
 */
export const MARK_READ_DELAY_MS = 1_000;
/** In a terminal that doesn't report focus, how long after a key press you count as reading. */
export const PRESENT_AFTER_KEY_MS = 2 * 60_000;

export interface ReadMarkerCallbacks {
  /** The buffer on screen, asked when the timer fires. */
  onScreen(): ActiveBuffer | null;
  /**
   * The time to send as the marker for `buffer`: newestServerTime of its lines.
   * Undefined when honk can't send one now: no connection, a buffer that has no
   * marker (*status), or a server without the draft/read-marker cap.
   */
  newestTime(serverId: string, buffer: string): number | undefined;
  /** Sends `MARKREAD <buffer> timestamp=<time>`. */
  send(serverId: string, buffer: string, time: number): void;
  /** The server's casemapping, which decides which buffer names are one. See nameKey. */
  casemapping(serverId: string): Casemapping;
  /**
   * `buffer` now counts as read: honk clears its badge here. Called each time honk
   * would send MARKREAD for it, also when it can't send one (see newestTime), so honk's
   * badge and your other clients agree.
   */
  markedRead(serverId: string, buffer: string): void;
}

/**
 * Decides when to move your read marker for the buffer on screen.
 *
 * - It sends only while you are reading: the window has focus, or, in a terminal that
 *   never reports focus, you pressed a key in the last PRESENT_AFTER_KEY_MS.
 * - It waits `delayMs` after a new line, and new lines don't push the time back, so a
 *   busy channel is marked once per delay.
 * - A buffer switch starts the wait over. The buffer you leave is marked at once if you
 *   read it for at least `delayMs`, and not at all if you only flipped past it.
 *   See startReading for when reading starts.
 * - It never sends a marker at or before one the server said or honk already sent on
 *   this connection.
 * - Each time it would send, it calls markedRead first, even when it can't send.
 *
 *   tracker.setFocused(true);
 *   tracker.onActiveChanged(null);   // #honk is on screen
 *   // 1 s later: markedRead("libera", "#honk")
 *   //            send("libera", "#honk", <time of its newest line>)
 */
export class ReadMarkerTracker {
  /** What the terminal last said about focus. "unknown" until it says anything. See isReading. */
  private focus: "unknown" | "focused" | "blurred" = "unknown";
  /** When you last pressed a key (ms). See noteKeyPress. */
  private lastKeyAt = 0;
  /** Waits before sending MARKREAD for the buffer on screen. See schedule. */
  private timer: unknown = null;
  /**
   * When you started reading the buffer on screen (ms). See startReading.
   */
  private readingSince = 0;
  /**
   * Per server, how far you have read each buffer (ms), by buffer name folded with the
   * server's casemapping (see key), as the server last said in a MARKREAD. Kept across
   * reconnects while the casemapping stays the same.
   */
  private serverMarkers = new Map<string, Map<string, number>>();
  /**
   * Per server, the markers honk sent on this connection, which the server may not have
   * taken yet, so the same one isn't sent twice. Cleared at each new connection, so a
   * marker that was lost with the old one is sent again.
   */
  private sentMarkers = new Map<string, Map<string, number>>();
  private readonly delayMs: number;
  private readonly clock: Clock;

  constructor(
    private readonly callbacks: ReadMarkerCallbacks,
    options: { delayMs?: number; clock?: Clock } = {},
  ) {
    this.delayMs = options.delayMs ?? MARK_READ_DELAY_MS;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * The terminal window got or lost focus. While it doesn't have focus, the buffer on
   * screen is not being read, so its marker doesn't move.
   */
  setFocused(focused: boolean): void {
    const wasReading = this.isReading();
    this.focus = focused ? "focused" : "blurred";
    if (!wasReading && this.isReading()) this.startReading();
  }

  /**
   * You pressed a key. A terminal that never reports focus (tmux without focus-events,
   * for one) gives no other sign that you are there.
   */
  noteKeyPress(): void {
    const wasReading = this.isReading();
    this.lastKeyAt = this.clock.now();
    if (!wasReading && this.isReading()) this.startReading();
  }

  /** A line went into the buffer on screen. */
  onNewLine(): void {
    this.schedule();
  }

  /**
   * Call after the buffer on screen is set. `leaving` is the buffer that was on screen
   * before, when the switch went to a different one, and null otherwise.
   */
  onActiveChanged(leaving: ActiveBuffer | null): void {
    if (!leaving) {
      this.schedule();
      return;
    }
    // You read its last lines long enough: mark them now. A buffer you only flipped
    // past is not marked.
    if (this.clock.now() - this.readingSince >= this.delayMs) {
      this.markRead(leaving.serverId, leaving.buffer);
    }
    this.startReading();
  }

  /** A new connection to the server registered: send again what the old one may have lost. */
  onConnected(serverId: string): void {
    this.sentMarkers.get(serverId)?.clear();
  }

  /**
   * The server said how far you have read `target`. Returns true if that moved the
   * marker forward; the server never moves it back, so an older time is a stale one.
   */
  onServerMarker(serverId: string, target: string, time: number): boolean {
    const known = this.serverMarker(serverId, target);
    if (known !== undefined && known >= time) return false;
    markersOf(this.serverMarkers, serverId).set(this.key(serverId, target), time);
    return true;
  }

  /** How far you have read `buffer` (ms), as the server last said. */
  serverMarker(serverId: string, buffer: string): number | undefined {
    return this.serverMarkers.get(serverId)?.get(this.key(serverId, buffer));
  }

  /**
   * Forgets a server's markers: when its ServerControl goes away, and when its
   * casemapping changes, since keys folded with the old one may no longer match.
   */
  forget(serverId: string): void {
    this.serverMarkers.delete(serverId);
    this.sentMarkers.delete(serverId);
  }

  /** Cancels the timer: when reading starts over, and when honk shuts down. */
  stop(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  /** `name` folded with the server's casemapping, as the markers are keyed. */
  private key(serverId: string, name: string): string {
    return nameKey(name, this.callbacks.casemapping(serverId));
  }

  /**
   * Whether you are reading the buffer on screen: the window has focus. If the terminal
   * never said, a key pressed in the last few minutes stands in for focus, so a honk
   * left open in a detached tmux doesn't mark everything read overnight.
   */
  isReading(): boolean {
    if (this.focus !== "unknown") return this.focus === "focused";
    return this.clock.now() - this.lastKeyAt < PRESENT_AFTER_KEY_MS;
  }

  /**
   * You started reading the buffer on screen: you switched to it, focus came back, or
   * you pressed a key after a time without one. It counts as read only once you have
   * read it for `delayMs` since then, so the lines that came while you were away are
   * not marked when you come back and switch away at once. A timer set before starts
   * over too.
   */
  private startReading(): void {
    this.readingSince = this.clock.now();
    this.stop();
    this.schedule();
  }

  /** Counts the buffer on screen as read after the delay (markRead), unless that is already waiting. */
  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      const onScreen = this.callbacks.onScreen();
      if (onScreen) this.markRead(onScreen.serverId, onScreen.buffer);
    }, this.delayMs);
  }

  /**
   * Counts a buffer as read, if you are reading: honk clears its badge (markedRead),
   * and your read marker moves up to its newest line. The server tells your other
   * clients, so they stop showing it as unread.
   */
  private markRead(serverId: string, buffer: string): void {
    if (!this.isReading()) return;
    this.callbacks.markedRead(serverId, buffer);
    const time = this.callbacks.newestTime(serverId, buffer);
    if (time === undefined) return;
    const key = this.key(serverId, buffer);
    const sent = markersOf(this.sentMarkers, serverId);
    const known = Math.max(
      this.serverMarkers.get(serverId)?.get(key) ?? -Infinity,
      sent.get(key) ?? -Infinity,
    );
    if (time <= known) return;
    sent.set(key, time);
    this.callbacks.send(serverId, buffer, time);
  }
}

function markersOf(
  byServer: Map<string, Map<string, number>>,
  serverId: string,
): Map<string, number> {
  let markers = byServer.get(serverId);
  if (!markers) {
    markers = new Map();
    byServer.set(serverId, markers);
  }
  return markers;
}
