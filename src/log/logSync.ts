/**
 * Keeps the Sync marker of each Network: the time up to which its History is in the
 * Log. With it, honk fills the gap after a restart or a reconnect:
 *
 *   last run ended at 21:00 (marker), honk starts at 23:00
 *   JOIN #honk -> CHATHISTORY LATEST #honk * 50   (for the screen, as before)
 *   the batch's oldest line is 22:40, after the marker: a gap
 *   CHATHISTORY AFTER #honk timestamp=20:59:55 100   (for the Log only; more pages
 *   until a page is empty or reaches 22:40)
 *
 * The marker moves only once no gap waits to be filled. Then, while connected, honk
 * logs every live Line, so the marker follows the server time of the newest live Line.
 * It is the server's time, not honk's clock, because fills compare it with the times
 * of History: with honk's clock 7 minutes fast, a marker from it would skip 7 minutes
 * of Lines. It never moves back.
 *
 * A crash in the middle of a fill leaves the marker where it was, and the next start
 * asks for the same History again; the Replay rule drops what the Log has. A fill that
 * stops at MAX_FILL_PAGES also leaves it there, so the gap is not forgotten.
 */

import { systemClock, type Clock } from "../clock.ts";
import type { Log } from "./log.ts";

/** Lines asked for in each page of a fill. */
export const FILL_LIMIT = 100;
/** The most pages one fill asks for, so a long absence can't flood the connection. */
export const MAX_FILL_PAGES = 20;
/** How far before the marker a fill starts: the clocks of honk and the server differ. */
export const SYNC_FUZZ_MS = 5_000;
/**
 * How long after registering the marker waits before moving: the joins (and their
 * History) of a new connection come in the first seconds.
 */
export const SETTLE_MS = 15_000;
/** How often the marker moves while connected. */
export const MARK_EVERY_MS = 10_000;

/**
 * A Log-only History request: CHATHISTORY AFTER <target> timestamp=<after>. IrcManager
 * keeps the ones it sent with its other History requests, so their batch (or FAIL)
 * finds them.
 */
export interface Fill {
  after: number;
  /** The oldest Line the screen's batch had: the gap ends there. */
  until: number;
  /** Pages asked for so far, this one included. */
  pages: number;
}

/** What `batchEnded` says to do next. */
type FillStep =
  | { type: "done" }
  | { type: "next"; request: Fill }
  /** MAX_FILL_PAGES pages came and the gap is still open. */
  | { type: "gave-up" };

interface ServerSync {
  /** True once `marker` was read from the Log. */
  markerRead: boolean;
  /** The marker when this connection began; undefined if the Network has none yet. */
  marker?: number;
  registeredAt: number;
  /** Buffers whose gap is not filled yet, as nameKey. A fill keeps its Buffer here. */
  pending: Set<string>;
  synced: boolean;
  lastMarkAt: number;
}

export class LogSync {
  private servers = new Map<string, ServerSync>();

  /**
   * `serverTime(serverId)`: the server time of the newest live Line on that connection,
   * or undefined before the first one.
   */
  constructor(
    private readonly log: Log,
    private readonly serverTime: (serverId: string) => number | undefined,
    private readonly clock: Clock = systemClock,
  ) {}

  /** A connection with chathistory registered. */
  start(serverId: string): void {
    this.servers.set(serverId, {
      markerRead: false,
      registeredAt: this.clock.now(),
      pending: new Set(),
      synced: false,
      lastMarkAt: 0,
    });
  }

  /**
   * The connection is gone. If its History was all in the Log, the marker moves to the
   * newest live Line.
   */
  stop(serverId: string): void {
    const s = this.servers.get(serverId);
    const time = this.serverTime(serverId);
    if (s?.synced && time !== undefined) this.log.setSyncMarker(serverId, time);
    this.servers.delete(serverId);
  }

  /** The marker for this connection, read once, after 005 named the bouncer network. */
  private marker(serverId: string, s: ServerSync): number | undefined {
    if (!s.markerRead) {
      s.marker = this.log.syncMarker(serverId);
      s.markerRead = true;
    }
    return s.marker;
  }

  /** You joined Buffer `target` (nameKey), and honk asked for its latest History. */
  joined(serverId: string, target: string): void {
    const s = this.servers.get(serverId);
    if (!s || s.synced || this.marker(serverId, s) === undefined) return;
    s.pending.add(target);
  }

  /**
   * A History batch for `target` ended, with Lines at server times `times`. `fill` is
   * the fill it answers, if it is one. Says whether to ask for another page.
   */
  batchEnded(serverId: string, target: string, times: number[], fill?: Fill): FillStep {
    const s = this.servers.get(serverId);
    if (!s) return { type: "done" };
    const step = fill ? this.nextPage(fill, times) : this.firstPage(serverId, s, target, times);
    // A gap left open keeps the Buffer pending, so the marker stays before it.
    if (step.type === "done") {
      s.pending.delete(target);
      this.moveMarker(serverId);
    }
    return step;
  }

  /** The gap between the marker and the oldest Line of the screen's batch, if any. */
  private firstPage(
    serverId: string,
    s: ServerSync,
    target: string,
    times: number[],
  ): FillStep {
    if (!s.pending.has(target)) return { type: "done" };
    const marker = this.marker(serverId, s);
    const oldest = times.length > 0 ? Math.min(...times) : undefined;
    if (marker === undefined || oldest === undefined || oldest <= marker) return { type: "done" };
    return { type: "next", request: { after: marker - SYNC_FUZZ_MS, until: oldest, pages: 1 } };
  }

  /** The page after `fill`, until a page is empty or reaches the screen's batch. */
  private nextPage(fill: Fill, times: number[]): FillStep {
    if (times.length === 0) return { type: "done" };
    const newest = Math.max(...times);
    if (newest >= fill.until) return { type: "done" };
    if (fill.pages >= MAX_FILL_PAGES) return { type: "gave-up" };
    return { type: "next", request: { after: newest, until: fill.until, pages: fill.pages + 1 } };
  }

  /**
   * Moves the marker to the newest live Line, if it may move now: no gap waits, the
   * joins have settled, and MARK_EVERY_MS passed since the last move. Call it now and
   * then while connected.
   */
  moveMarker(serverId: string): void {
    const s = this.servers.get(serverId);
    const time = this.serverTime(serverId);
    if (!s || time === undefined || s.pending.size > 0) return;
    const now = this.clock.now();
    if (now - s.registeredAt < SETTLE_MS) return;
    if (s.synced && now - s.lastMarkAt < MARK_EVERY_MS) return;
    s.synced = true;
    s.lastMarkAt = now;
    this.log.setSyncMarker(serverId, time);
  }
}
