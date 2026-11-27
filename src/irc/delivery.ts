/**
 * Confirms that lines you send reach the server.
 *
 * A server handles a client's commands in the order they arrive. So after each line
 * honk sends `PING :honk-<n>`, and when `PONG :honk-<n>` comes back, every line sent
 * before that PING has arrived:
 *
 *   honk -> server:  PRIVMSG #honk :brb
 *   honk -> server:  PING :honk-7
 *   server -> honk:  PONG irc.example.net :honk-7   <- "brb" arrived
 *
 * If the PONG doesn't come back in DELIVERY_TIMEOUT_MS, the connection is dead (Wi-Fi
 * off, a dropped route) and the lines are reported as not sent. This works on every
 * server, with or without IRCv3 echo-message.
 */

import { systemClock, type Clock } from "../clock.ts";
import { type Casemapping, sameNick } from "./names.ts";

/** How long to wait for the PONG. Long enough for a slow link, short enough to notice a dead one. */
export const DELIVERY_TIMEOUT_MS = 15_000;

/** One line the user sent, as shown in a buffer. */
export interface SentLine {
  bufferName: string;
  messageId: string;
}

export interface DeliveryCallbacks {
  /** These lines reached the server. */
  delivered(serverId: string, lines: SentLine[]): void;
  /**
   * No PONG in time: the connection looks dead, and these lines may not have arrived.
   * `lines` is empty when only a probe (see `probe`) was waiting.
   */
  timedOut(serverId: string, lines: SentLine[]): void;
}

const TOKEN_PREFIX = "honk-";

interface Probe {
  seq: number;
  /** Unset for a probe that only checks the connection. */
  line?: SentLine;
  timer: unknown;
}

function linesOf(probes: Probe[]): SentLine[] {
  return probes.flatMap((p) => (p.line ? [p.line] : []));
}

export class DeliveryTracker {
  private nextSeq = 1;
  /** Per server, the probes still waiting for a PONG, oldest first. */
  private pending = new Map<string, Probe[]>();

  constructor(
    private readonly callbacks: DeliveryCallbacks,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Call right after sending `line`. Sends the PING through `sendPing` and starts the
   * timer.
   */
  track(serverId: string, line: SentLine, sendPing: (token: string) => void): void {
    this.add(serverId, line, sendPing);
  }

  /**
   * Checks that the connection still works, with no line attached. Used when the
   * network changes under a connection that looks open.
   */
  probe(serverId: string, sendPing: (token: string) => void): void {
    this.add(serverId, undefined, sendPing);
  }

  private add(
    serverId: string,
    line: SentLine | undefined,
    sendPing: (token: string) => void,
  ): void {
    const seq = this.nextSeq++;
    const timer = this.clock.setTimeout(() => this.timeout(serverId), DELIVERY_TIMEOUT_MS);
    const probes = this.pending.get(serverId) ?? [];
    probes.push({ seq, line, timer });
    this.pending.set(serverId, probes);
    sendPing(`${TOKEN_PREFIX}${seq}`);
  }

  /** Call for each PONG. A PONG that isn't ours (the library's keepalive) is ignored. */
  pong(serverId: string, token: string | undefined): void {
    if (!token?.startsWith(TOKEN_PREFIX)) return;
    const seq = Number(token.slice(TOKEN_PREFIX.length));
    const probes = this.pending.get(serverId);
    if (!probes || !Number.isInteger(seq)) return;
    // The server answers in order, so this PONG also confirms every earlier probe.
    const done = probes.filter((p) => p.seq <= seq);
    if (done.length === 0) return;
    for (const p of done) this.clock.clearTimeout(p.timer);
    this.setPending(serverId, probes.filter((p) => p.seq > seq));
    const lines = linesOf(done);
    if (lines.length > 0) this.callbacks.delivered(serverId, lines);
  }

  /**
   * The server refused a line to `bufferName` (such as 404 "Cannot send to channel").
   * It answers in order, so the refusal is for the oldest line to that buffer still
   * waiting. Returns that line and stops tracking it, so the PONG after it can't mark
   * it delivered. Its PING stays, to keep confirming the lines around it. `mapping` is
   * the server's casemapping, which decides which buffer names are the same.
   */
  reject(serverId: string, bufferName: string, mapping: Casemapping): SentLine | undefined {
    const probe = this.pending
      .get(serverId)
      ?.find((p) => sameNick(p.line?.bufferName, bufferName, mapping));
    const line = probe?.line;
    if (probe) probe.line = undefined;
    return line;
  }

  /**
   * Forgets every line still waiting on `serverId` and returns them. Call when the
   * connection closes: those lines may not have arrived.
   */
  drop(serverId: string): SentLine[] {
    return linesOf(this.takeAll(serverId));
  }

  private takeAll(serverId: string): Probe[] {
    const probes = this.pending.get(serverId) ?? [];
    for (const p of probes) this.clock.clearTimeout(p.timer);
    this.pending.delete(serverId);
    return probes;
  }

  private timeout(serverId: string): void {
    const probes = this.takeAll(serverId);
    if (probes.length > 0) this.callbacks.timedOut(serverId, linesOf(probes));
  }

  private setPending(serverId: string, probes: Probe[]): void {
    if (probes.length > 0) this.pending.set(serverId, probes);
    else this.pending.delete(serverId);
  }
}
