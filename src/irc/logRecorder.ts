/**
 * Turns what happens on a connection into Lines for the Log (src/log/log.ts). IrcManager
 * says what happened; this decides what enters the Log, and when:
 *
 *   alice: hello goose          -> a Chat line, a Mention
 *   bob left #honk              -> an Event
 *   you: brb                    -> logged when its Echo comes, with the server's msgid;
 *                                  without echo-message, when the delivery check confirms it
 *   REDACT #honk <msgid>        -> the Line is marked, and kept
 *   a CHATHISTORY batch         -> each Line gets the Replay check (ADR 0003), its
 *                                  Events too (draft/event-playback)
 *
 * *status is never logged. It also asks for the History the Log misses after a
 * reconnect (see logSync.ts).
 */

import { DEFAULT_CASEMAPPING, isChannelName, normalizeNick } from "./names.ts";
import type { ChatMessage } from "../types.ts";
import { lineTime, parseLine, tagsOf, type TimeTags } from "./ircLine.ts";
import { isHistoryService } from "./readMarker.ts";
import { HistoryBatch } from "./replay.ts";
import type { SentLine } from "./delivery.ts";
import type { Log, LogLine, LogNetwork } from "../log/log.ts";
import { type Fill, LogSync } from "../log/logSync.ts";

/** The IRCv3 cap that sends REDACT, so the Log can mark a deleted Line. */
const REDACTION_CAP = "draft/message-redaction";

type Tags = TimeTags | undefined;

/** A Line's time for the Log, from its time tag or honk's clock. */
function logTime(tags: Tags): Pick<LogLine, "time" | "timeFromServer"> {
  const t = lineTime(tags);
  return { time: t.timestamp.getTime(), timeFromServer: t.timeFromServer === true };
}

/** A Chat line as IrcManager hands it over. */
export interface ChatInput {
  kind: "message" | "action" | "notice";
  from: string;
  text: string;
  tags: Tags;
  self: boolean;
}

/** What LogRecorder needs from IrcManager. */
export interface LogHost {
  /** The name of the Buffer as honk shows it ("Dave" for "dave"), or `name` if none is open. */
  bufferName(serverId: string, name: string): string;
  /** True if `name` is the server's *status buffer. */
  isStatus(serverId: string, name: string): boolean;
  /** `name` folded with the server's casemapping. See nameKey. */
  key(serverId: string, name: string): string;
  /** True if the server sees `a` and `b` as one name. */
  same(serverId: string, a: string | undefined, b: string | undefined): boolean;
  /** Your nick on the server. */
  nick(serverId: string): string | undefined;
  /** True if a line with `text` in `target` is a Mention: it names your nick, or it is in a DM. */
  isMentionIn(serverId: string, target: string, text: string): boolean;
  /** Your line `messageId` in `bufferName`, as the screen shows it now. */
  shownLine(serverId: string, bufferName: string, messageId: string): ChatMessage | undefined;
  /** The server time of the newest live Line on the connection. */
  newestServerTime(serverId: string): number | undefined;
  /** True if the connection has this IRCv3 cap. */
  hasCap(serverId: string, cap: string): boolean;
  /**
   * Sends CHATHISTORY AFTER <target> timestamp=<fill.after> FILL_LIMIT, and keeps it with
   * the other History requests. Its batch comes back to `history` with this fill.
   */
  requestFill(serverId: string, target: string, fill: Fill): void;
  /** Shows a line in the server's *status. */
  notice(serverId: string, text: string): void;
}

/** An IRC line inside a CHATHISTORY batch, as irc-client-ts gives it. */
interface HistoryLine {
  command?: string;
  params: readonly string[];
  source?: { name?: string };
  tags?: Tags;
}

/** What an Event is, without its time. */
type EventInput = Pick<LogLine, "kind" | "nick" | "subject" | "text">;

/**
 * The Event (or topic) a History line stands for, and the channel it names. A QUIT or
 * NICK names no channel. Undefined for a line that is not an Event or a topic.
 *
 *   :dave JOIN #honk           -> join by dave, in #honk
 *   :alice KICK #honk dave :x  -> kick by alice of dave, reason "x", in #honk
 *   :dave NICK dave_           -> nick change of dave to dave_, no channel
 */
function historyEvent(line: HistoryLine): { channel?: string; event: EventInput } | undefined {
  const nick = normalizeNick(line.source?.name);
  const [first, second, third] = line.params;
  if (!nick) return undefined;
  switch (line.command) {
    case "join":
      return { channel: first, event: { kind: "join", nick, text: "" } };
    case "part":
      return { channel: first, event: { kind: "part", nick, text: second ?? "" } };
    case "kick":
      return { channel: first, event: { kind: "kick", nick, subject: second, text: third ?? "" } };
    case "topic":
      return { channel: first, event: { kind: "topic", nick, text: second ?? "" } };
    case "quit":
      return { event: { kind: "quit", nick, text: first ?? "" } };
    case "nick":
      return { event: { kind: "nick", nick, subject: first, text: "" } };
    default:
      return undefined;
  }
}

/** One CHATHISTORY batch on its way to the Log. */
export interface LogHistory {
  add(target: string, line: ChatInput): void;
  /**
   * An Event or topic of the batch (any line but PRIVMSG and NOTICE). One with no
   * channel, such as a QUIT, goes in the batch's target. Other lines are left out.
   */
  event(line: HistoryLine): void;
  /** Call after the last Line: asks for the next page of a gap, if one is open. */
  end(): void;
}

export class LogRecorder {
  private readonly sync: LogSync;

  constructor(
    private readonly log: Log,
    private readonly host: LogHost,
  ) {
    this.sync = new LogSync(log, (serverId) => host.newestServerTime(serverId));
  }

  /** Adds the caps the Log wants to a connection's list of requested caps. */
  requestCaps(requested: string[]): void {
    if (!requested.includes(REDACTION_CAP)) requested.push(REDACTION_CAP);
  }

  /** Updates what the Log knows about a Server's Network (see Log.setNetwork). */
  setNetwork(serverId: string, info: Partial<LogNetwork>): void {
    this.log.setNetwork(serverId, info);
  }

  /**
   * A connection registered. Its 005 lines come next: CASEMAPPING, and BOUNCER_NETID
   * from a bouncer. Until then the defaults hold.
   */
  registered(serverId: string): void {
    this.log.setNetwork(serverId, { bouncerNetId: "", casemapping: DEFAULT_CASEMAPPING });
    if (this.host.hasCap(serverId, "draft/chathistory")) this.sync.start(serverId);
  }

  /** The connection is gone. */
  connectionLost(serverId: string): void {
    this.sync.stop(serverId);
  }

  /** Call every few seconds: moves the Sync markers that may move. */
  tick(serverIds: readonly string[]): void {
    for (const id of serverIds) this.sync.moveMarker(id);
  }

  /**
   * The time to ask the latest History after when you join a channel: a little before
   * the Sync marker, since the Log has the Lines up to it. Undefined: ask for all.
   */
  historySince(serverId: string): number | undefined {
    return this.sync.historySince(serverId);
  }

  /**
   * honk asked for the latest History of `target`: a channel you joined, or a DM that
   * wrote to you while you were away.
   */
  askedLatest(serverId: string, target: string): void {
    this.sync.askedLatest(serverId, this.host.key(serverId, target));
  }

  /** The server sent a FAIL instead of the History of `target`. See LogSync.historyFailed. */
  historyFailed(serverId: string, target: string): void {
    this.sync.historyFailed(serverId, this.host.key(serverId, target));
  }

  /** The Sync marker of the connection's Network, or undefined if it has none. */
  syncMarker(serverId: string): number | undefined {
    return this.sync.syncMarker(serverId);
  }

  /** honk asked who wrote to you (CHATHISTORY TARGETS). The Sync marker waits for the reply. */
  askedTargets(serverId: string): void {
    this.sync.askedTargets(serverId);
  }

  /**
   * The reply to TARGETS came (`nicks`: the DMs honk asked the latest History of), or a
   * FAIL (no nicks).
   */
  answeredTargets(serverId: string, nicks: readonly string[]): void {
    this.sync.answeredTargets(serverId, nicks.map((nick) => this.host.key(serverId, nick)));
  }

  /** Adds a Line to the Log of Buffer `bufferName`, unless it is *status. */
  private add(serverId: string, bufferName: string, line: LogLine, batch?: HistoryBatch): void {
    if (this.host.isStatus(serverId, bufferName)) return;
    const name = this.host.bufferName(serverId, bufferName);
    this.log.add(serverId, { name, kind: isChannelName(name) ? "channel" : "dm" }, line, batch);
  }

  /** A Chat line as the Log stores it. Every Chat line in a DM is a Mention. */
  private chatLine(serverId: string, target: string, input: ChatInput): LogLine {
    return {
      kind: input.kind,
      nick: input.from,
      text: input.text,
      ...logTime(input.tags),
      msgid: input.tags?.msgid,
      self: input.self,
      mention: !input.self && this.host.isMentionIn(serverId, target, input.text),
    };
  }

  /** A live Chat line in `target`. */
  chat(serverId: string, target: string, input: ChatInput): void {
    this.add(serverId, target, this.chatLine(serverId, target, input));
  }

  /** An Event in `bufferName`, with the time and msgid of the IRC line `msg`. */
  event(serverId: string, bufferName: string, msg: unknown, event: EventInput): void {
    this.add(serverId, bufferName, this.eventLine(serverId, event, tagsOf(msg)));
  }

  /** An Event as the Log stores it. */
  private eventLine(serverId: string, event: EventInput, tags: Tags): LogLine {
    return {
      ...event,
      ...logTime(tags),
      msgid: tags?.msgid,
      self: this.host.same(serverId, event.nick, this.host.nick(serverId)),
    };
  }

  /**
   * A CHATHISTORY batch for `target` (empty for one without a target) begins. `fill`:
   * the Log's own request it answers, if it is one.
   */
  history(serverId: string, target: string, fill: Fill | undefined): LogHistory {
    const targetKey = target ? this.host.key(serverId, target) : undefined;
    // The Replay counts of this batch, per Buffer. See replay.ts.
    const batches = new Map<string, HistoryBatch>();
    // The server times of its Lines, for the gap check.
    const times: number[] = [];
    const noteTime = (line: Pick<LogLine, "time" | "timeFromServer">) => {
      if (line.timeFromServer) times.push(line.time);
    };
    const addLine = (lineTarget: string, line: LogLine) => {
      noteTime(line);
      const key = this.host.key(serverId, lineTarget);
      let batch = batches.get(key);
      if (!batch) batches.set(key, (batch = new HistoryBatch()));
      this.add(serverId, lineTarget, { ...line, history: true }, batch);
    };
    return {
      add: (lineTarget, input) => {
        // An Ergo HistServ line is an Event played back as a PRIVMSG, for a client without
        // draft/event-playback. Its text is translated, so honk can't read the Event back
        // out of it. It still counts for the gap check.
        if (isHistoryService(input.from)) noteTime(logTime(input.tags));
        else addLine(lineTarget, this.chatLine(serverId, lineTarget, input));
      },
      event: (raw) => {
        const found = historyEvent(raw);
        const lineTarget = found?.channel ?? target;
        if (found && lineTarget) addLine(lineTarget, this.eventLine(serverId, found.event, raw.tags));
      },
      end: () => {
        if (targetKey !== undefined) this.afterHistory(serverId, target, targetKey, times, fill);
      },
    };
  }

  /** Asks for the next page of a gap, or says in *status that honk stopped filling it. */
  private afterHistory(
    serverId: string,
    target: string,
    targetKey: string,
    times: number[],
    fill: Fill | undefined,
  ): void {
    const step = this.sync.batchEnded(serverId, targetKey, times, fill);
    if (step.type === "gave-up") {
      this.host.notice(
        serverId,
        `The log misses older lines of ${target}: honk stopped asking the server after ${fill!.pages} pages. It asks again at the next connect.`,
      );
    } else if (step.type === "next") {
      this.host.requestFill(serverId, target, step.request);
    }
  }

  /**
   * The delivery check confirmed these lines. A line the server echoes enters the Log
   * with its Echo instead, with the server's text and msgid (ADR 0003, rule 5).
   */
  delivered(serverId: string, lines: SentLine[]): void {
    for (const line of lines) {
      if (!line.echoed) this.echoed(serverId, line.bufferName, line.messageId);
    }
  }

  /**
   * Your line `messageId` is confirmed: its Echo arrived and the screen took its text,
   * msgid and time, or the delivery check confirmed a line with no Echo.
   */
  echoed(serverId: string, bufferName: string, messageId: string): void {
    const m = this.host.shownLine(serverId, bufferName, messageId);
    if (!m || (m.kind !== "message" && m.kind !== "action")) return;
    this.add(serverId, bufferName, {
      kind: m.kind,
      nick: m.from ?? this.host.nick(serverId) ?? "",
      text: m.text,
      time: m.timestamp.getTime(),
      timeFromServer: m.timeFromServer === true,
      msgid: m.msgid,
      self: true,
    });
  }

  /**
   * Someone deleted a Line: "@time=... :alice!a@h REDACT #honk <msgid> :reason". The Log
   * marks it and keeps it. A REDACT inside a History batch can come before the batch's
   * Lines reach the Log; the Log keeps it until the Line comes.
   */
  redact(serverId: string, rawLine: string): void {
    const { tags, source, params } = parseLine(rawLine);
    const msgid = params[1];
    if (!msgid) return;
    this.log.redact(serverId, msgid, normalizeNick(source), logTime(tags).time);
  }
}
