/**
 * Keeps the Sync marker of each Network: the time up to which its History is in the
 * Log. With it, honk fills the gap after a restart or a reconnect:
 *
 *   last run ended at 21:00 (marker), honk starts at 23:00
 *   JOIN #honk -> CHATHISTORY LATEST #honk timestamp=20:59:55 50   (the newest 50
 *                 after the marker; the screen has the Log's Lines up to it)
 *   the batch is full (50 lines), and its oldest is 22:40, after the marker: a gap
 *   CHATHISTORY AFTER #honk timestamp=20:59:55 100   (a fill, for the Log and the
 *   screen; more pages until a page is empty or reaches 22:40)
 *
 * DMs have no JOIN. At the start, honk asks the server who wrote to you since the marker
 * (CHATHISTORY TARGETS), and each DM it names goes the same way as a channel:
 *
 *   CHATHISTORY TARGETS timestamp=20:59:55 timestamp=23:00 50   (the marker waits)
 *   the reply names dave -> CHATHISTORY LATEST dave timestamp=20:59:55 50, then fills
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

/** Lines the screen asks for in the latest History of a channel you join, or of a DM. */
export const LATEST_LIMIT = 50;
/** Lines asked for in each page of a fill. */
export const FILL_LIMIT = 100;
/**
 * How far before the newest Line of a full page the next page starts. AFTER leaves out
 * its own time, so a page cut inside a millisecond would skip the rest of it. On a store
 * of whole seconds every time ends in .000, so 1 ms before brings that whole second
 * again. The Replay rule drops the Lines asked twice.
 */
export const PAGE_OVERLAP_MS = 1;
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
  /** The newest Line of the page before, if any: the next page must bring a newer one. */
  reached?: number;
}

/** What a History batch held: the server times of its Lines, and how many lines in all. */
export interface HistoryPage {
  times: number[];
  /** Every line of the batch, also those with no server time or that are not Lines. */
  lines: number;
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
  /**
   * When honk asked CHATHISTORY TARGETS, while its reply has not come: it may name more
   * gaps. A reply that never comes stops counting after SETTLE_MS.
   */
  targetsAskedAt?: number;
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

  /** The marker of this connection's Network, or undefined if it has none yet. */
  syncMarker(serverId: string): number | undefined {
    const s = this.servers.get(serverId);
    return s && this.marker(serverId, s);
  }

  /** The marker for this connection, read once, after 005 named the bouncer network. */
  private marker(serverId: string, s: ServerSync): number | undefined {
    if (!s.markerRead) {
      s.marker = this.log.syncMarker(serverId);
      s.markerRead = true;
    }
    return s.marker;
  }

  /**
   * SYNC_FUZZ_MS before the marker of this connection, or undefined if the Network has
   * no marker yet or the connection has no chathistory. The Replay rule drops the
   * overlap.
   */
  historySince(serverId: string): number | undefined {
    const marker = this.syncMarker(serverId);
    return marker === undefined ? undefined : marker - SYNC_FUZZ_MS;
  }

  /**
   * honk asked for the latest History of Buffer `target` (nameKey): a channel you
   * joined, or a DM the reply to TARGETS named.
   */
  askedLatest(serverId: string, target: string): void {
    this.unsynced(serverId)?.pending.add(target);
  }

  /** honk asked who wrote to you since the marker. The marker waits for the reply. */
  askedTargets(serverId: string): void {
    const s = this.unsynced(serverId);
    if (s) s.targetsAskedAt = this.clock.now();
  }

  /**
   * The reply to CHATHISTORY TARGETS came, or a FAIL. `targets` (nameKeys): the DMs
   * honk then asked the latest History of. The marker waits for their gaps instead.
   */
  answeredTargets(serverId: string, targets: readonly string[]): void {
    for (const target of targets) this.askedLatest(serverId, target);
    const s = this.servers.get(serverId);
    if (s?.targetsAskedAt === undefined) return;
    s.targetsAskedAt = undefined;
    this.moveMarker(serverId);
  }

  /** The connection, if its marker may still wait for gaps: it has one, and is not synced. */
  private unsynced(serverId: string): ServerSync | undefined {
    const s = this.servers.get(serverId);
    return s && !s.synced && this.marker(serverId, s) !== undefined ? s : undefined;
  }

  /**
   * The server sent a FAIL instead of the History of `target`. Asking again would most
   * likely fail again (a service nick keeps no History), so its gap stops holding the
   * marker. The FAIL itself is shown on screen.
   */
  historyFailed(serverId: string, target: string): void {
    const s = this.servers.get(serverId);
    if (!s?.pending.delete(target)) return;
    this.moveMarker(serverId);
  }

  /**
   * A History batch for `target` ended. `fill` is the fill it answers, if it is one.
   * Says whether to ask for another page.
   */
  batchEnded(serverId: string, target: string, page: HistoryPage, fill?: Fill): FillStep {
    const s = this.servers.get(serverId);
    if (!s) return { type: "done" };
    const step = fill ? this.nextPage(fill, page) : this.firstPage(serverId, s, target, page);
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
    page: HistoryPage,
  ): FillStep {
    if (!s.pending.has(target)) return { type: "done" };
    // Fewer lines than asked for: the server had no more, so nothing is missing.
    if (page.lines < LATEST_LIMIT) return { type: "done" };
    const marker = this.marker(serverId, s);
    const oldest = page.times.length > 0 ? Math.min(...page.times) : undefined;
    // A full batch may have cut off older Lines. It reaches back far enough only past the
    // SYNC_FUZZ_MS before the marker: Lines in the marker's own millisecond may have come
    // after it, and a store of whole seconds gives a Line sent after the marker an older
    // time in the same second.
    if (marker === undefined || oldest === undefined || oldest < marker - SYNC_FUZZ_MS) {
      return { type: "done" };
    }
    return { type: "next", request: { after: marker - SYNC_FUZZ_MS, until: oldest, pages: 1 } };
  }

  /**
   * The page after `fill`, until a page is not full (the server had no more) or goes
   * past the oldest Line of the screen's batch. A full page that only reaches that time
   * may be cut inside its second, so one more page comes.
   */
  private nextPage(fill: Fill, page: HistoryPage): FillStep {
    if (page.lines < FILL_LIMIT || page.times.length === 0) return { type: "done" };
    const newest = Math.max(...page.times);
    if (newest > fill.until) return { type: "done" };
    // The same page again: more than FILL_LIMIT Lines in one millisecond (one second on
    // a store of whole seconds), so asking again can't get past them.
    if (fill.reached !== undefined && newest <= fill.reached) return { type: "gave-up" };
    if (fill.pages >= MAX_FILL_PAGES) return { type: "gave-up" };
    const request = { after: newest - PAGE_OVERLAP_MS, until: fill.until, pages: fill.pages + 1, reached: newest };
    return { type: "next", request };
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
    if (s.targetsAskedAt !== undefined && now - s.targetsAskedAt < SETTLE_MS) return;
    if (now - s.registeredAt < SETTLE_MS) return;
    if (s.synced && now - s.lastMarkAt < MARK_EVERY_MS) return;
    s.synced = true;
    s.lastMarkAt = now;
    this.log.setSyncMarker(serverId, time);
  }
}
