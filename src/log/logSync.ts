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
 * logs every live Line, so the marker follows the last time honk heard from the
 * server (not the clock: a dead connection can look open for a while, and lines sent
 * then never arrived). It never moves back. A crash
 * in the middle of a fill leaves the marker where it was, and the next start asks for
 * the same History again; the Replay rule drops what the Log has.
 */

import { systemClock, type Clock } from "../clock.ts";
import type { MessageLog } from "./messageLog.ts";

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

/** A Log-only History request waiting for its batch. */
export interface Fill {
  /** The Buffer, as nameKey. */
  target: string;
  label?: string;
  /** The oldest Line the screen's batch had: the gap ends there. */
  until: number;
  /** Pages asked for so far, this one included. */
  pages: number;
}

interface ServerSync {
  /** The marker when this connection began; null if the Network has none yet. */
  since: number | null | undefined;
  registeredAt: number;
  /** Buffers whose gap is not filled yet, as nameKey. */
  pending: Set<string>;
  fills: Fill[];
  synced: boolean;
  lastMarkAt: number;
}

/** A Log-only History request to send: CHATHISTORY AFTER <target> timestamp=<after>. */
export interface FillRequest {
  after: number;
  until: number;
  pages: number;
}

export class LogSync {
  private servers = new Map<string, ServerSync>();

  /**
   * `heardAt(serverId)`: when honk last received anything on that connection, in ms
   * on `clock`.
   */
  constructor(
    private readonly log: MessageLog,
    private readonly heardAt: (serverId: string) => number | undefined,
    private readonly clock: Clock = systemClock,
  ) {}

  /** A connection with chathistory registered. */
  start(serverId: string): void {
    this.servers.set(serverId, {
      since: undefined,
      registeredAt: this.clock.now(),
      pending: new Set(),
      fills: [],
      synced: false,
      lastMarkAt: 0,
    });
  }

  /**
   * The connection is gone. If its History was all in the Log, the marker moves to the
   * last time honk heard from the server.
   */
  stop(serverId: string): void {
    const s = this.servers.get(serverId);
    const heard = this.heardAt(serverId);
    if (s?.synced && heard !== undefined) this.log.setSyncMarker(serverId, heard);
    this.servers.delete(serverId);
  }

  /** The marker for this connection, read once, after 005 named the bouncer network. */
  private since(serverId: string, s: ServerSync): number | null {
    if (s.since === undefined) s.since = this.log.syncMarker(serverId) ?? null;
    return s.since;
  }

  /** You joined Buffer `target` (nameKey), and honk asked for its latest History. */
  joined(serverId: string, target: string): void {
    const s = this.servers.get(serverId);
    if (!s || s.synced || this.since(serverId, s) === null) return;
    s.pending.add(target);
  }

  /** Remembers a fill request that was just sent. */
  fillSent(serverId: string, fill: Fill): void {
    this.servers.get(serverId)?.fills.push(fill);
  }

  /**
   * The fill that a History batch for `target` answers, taken out of the waiting ones,
   * or undefined if the batch is not a fill. A labeled batch matches by label, an
   * unlabeled one by target.
   */
  takeFill(serverId: string, label: string | undefined, target: string): Fill | undefined {
    const fills = this.servers.get(serverId)?.fills;
    if (!fills) return undefined;
    const i =
      label !== undefined
        ? fills.findIndex((f) => f.label === label)
        : fills.findIndex((f) => f.label === undefined && f.target === target);
    return i === -1 ? undefined : fills.splice(i, 1)[0];
  }

  /**
   * A History batch for `target` ended, with Lines at server times `times`. `fill` is
   * the fill it answers, if it is one. Returns the next fill to ask for, if any.
   */
  batchEnded(
    serverId: string,
    target: string,
    times: number[],
    fill?: Fill,
  ): FillRequest | undefined {
    const s = this.servers.get(serverId);
    if (!s) return undefined;
    const next = fill ? this.nextPage(fill, times) : this.firstPage(serverId, s, target, times);
    if (!next) {
      s.pending.delete(target);
      this.check(serverId);
    }
    return next;
  }

  /** The gap between the marker and the oldest Line of the screen's batch, if any. */
  private firstPage(
    serverId: string,
    s: ServerSync,
    target: string,
    times: number[],
  ): FillRequest | undefined {
    if (!s.pending.has(target)) return undefined;
    const since = this.since(serverId, s);
    const oldest = times.length > 0 ? Math.min(...times) : undefined;
    if (since === null || oldest === undefined || oldest <= since) return undefined;
    return { after: since - SYNC_FUZZ_MS, until: oldest, pages: 1 };
  }

  /** The page after `fill`, until a page is empty or reaches the screen's batch. */
  private nextPage(fill: Fill, times: number[]): FillRequest | undefined {
    if (times.length === 0 || fill.pages >= MAX_FILL_PAGES) return undefined;
    const newest = Math.max(...times);
    if (newest >= fill.until) return undefined;
    return { after: newest, until: fill.until, pages: fill.pages + 1 };
  }

  /**
   * Call now and then while connected. Once no gap waits and the joins have settled,
   * the marker moves to the last time honk heard from the server, at most every
   * MARK_EVERY_MS.
   */
  check(serverId: string): void {
    const s = this.servers.get(serverId);
    const heard = this.heardAt(serverId);
    if (!s || heard === undefined || s.pending.size > 0 || s.fills.length > 0) return;
    const now = this.clock.now();
    if (now - s.registeredAt < SETTLE_MS) return;
    if (s.synced && now - s.lastMarkAt < MARK_EVERY_MS) return;
    s.synced = true;
    s.lastMarkAt = now;
    this.log.setSyncMarker(serverId, heard);
  }
}
