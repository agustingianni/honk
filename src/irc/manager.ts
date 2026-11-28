import { Client } from "irc-client-ts";
import { defaultNick, parsePortArg, sameHost, serverIdFromHost } from "../config.ts";
import type {
  ActiveBuffer,
  BufferKind,
  BufferState,
  ChatMessage,
  MessageKind,
  NickEntry,
  ServerConfig,
  ServerState,
  StoreSnapshot,
  UpdateNotice,
} from "../types.ts";
import {
  type Casemapping,
  bufferKindFor,
  casemappingOf,
  DEFAULT_CASEMAPPING,
  isChannelName,
  isUserSender,
  NICK_CHAR,
  normalizeNick,
  nameKey,
  parseCasemapping,
  sameNick,
  STATUS_BUFFER,
  UNKNOWN_SENDER,
} from "./names.ts";
import type { MentionEvent } from "../notify.ts";
import { findSlashCommand, SLASH_COMMANDS, syntax } from "./commands.ts";
import { joinText, kickText, nickText, partText, quitText, topicText } from "./eventText.ts";
import { DELIVERY_TIMEOUT_MS, DeliveryTracker, type SentLine } from "./delivery.ts";
import { EchoTracker, type SentPart } from "./echo.ts";
import {
  dmTargets,
  isMissedLine,
  isMissedMention,
  MISSED_MARGIN_MS,
  type MissedWindow,
  TARGETS_BATCH_TYPES,
} from "./missed.ts";
import { NetworkWatcher } from "./netwatch.ts";
import { checkReplay, HistoryBatch, LOCAL_CLOCK_WINDOW_MS } from "./replay.ts";
import {
  DEMO_AMBIENT,
  DEMO_HISTORY,
  DEMO_NETWORKS,
  DEMO_NICK,
  DEMO_REPLIES,
  DEMO_START,
  DEMO_TIMELINE,
  demoWhois,
  type DemoEvent,
} from "./demo.ts";
import {
  describeCertError,
  describeConnectionError,
  describeErrorReply,
  describeStandardReply,
  isErrorKind,
  NUMERICS_MISSING_FROM_LIBRARY,
  replyKind,
  whoisLines,
  type Endpoint,
} from "./replies.ts";
import {
  commandOf,
  lineTime,
  MAX_LINE_BYTES,
  parseLine,
  tagsOf,
  timestampParam,
} from "./ircLine.ts";
import {
  isAfterMarker,
  isMarkedRead,
  isReadableLine,
  newestServerTime,
  parseMarkRead,
  READ_MARKER_CAP,
  ReadMarkerTracker,
  unreadAfter,
} from "./readMarker.ts";
import { createNodeRuntime, describeEventError, describeLineError, neverThrow } from "./runtime.ts";
import { type Log, tooFarAhead } from "../log/log.ts";
import { FILL_LIMIT, type Fill, LATEST_LIMIT, PAGE_OVERLAP_MS } from "../log/logSync.ts";
import { SCROLLBACK_LINES, storedMessages } from "../log/scrollback.ts";
import { LogRecorder } from "./logRecorder.ts";

/** Messages kept per buffer from live traffic. */
const MAX_MESSAGES = 500;
/** Hard cap once history (/history, CHATHISTORY playback) has grown a buffer past MAX_MESSAGES. */
const MAX_MESSAGES_WITH_HISTORY = 5000;
/** A paste with more lines than this is refused, so a wrong paste can't flood a channel. */
const MAX_PASTE_LINES = 10;
/**
 * Reports of a bug in honk per connection: in its line handling (see createNodeRuntime)
 * or in an event listener (see bindClientEvents).
 */
const MAX_BUG_REPORTS = 5;

/** In the demo: how long someone takes to answer you, and the gap between ambient lines. */
const DEMO_REPLY_DELAY_MS = 1_200;
const DEMO_AMBIENT_EVERY_MS = 7_000;
/** Mode prefixes, highest first, for sorting the demo's user lists. */
const PREFIX_ORDER = "~&@%+";

// Reconnect & health tuning
const CONNECT_TIMEOUT_MS = 15_000;
const STABLE_RESET_MS = 10_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const WAKE_CHECK_INTERVAL_MS = 5_000;
const WAKE_JUMP_THRESHOLD_MS = 15_000;
/**
 * How long a /join waits for the server's JOIN before it no longer takes focus. Join
 * errors and forwards end the request early; this limit covers a server that never answers.
 */
const REQUESTED_JOIN_TTL_MS = 30_000;
/** Nick errors at login that another nick can get past: 433 (in use) and 437 (held by the network). */
const NICK_RETRY_ERRORS = new Set(["err_nicknameinuse", "err_unavailresource"]);
interface ServerControl {
  manualDisconnect: boolean;
  fatalError: boolean;
  attempts: number;
  registered: boolean;
  hasEverConnected: boolean;
  nickCollisionTries: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connectTimer: ReturnType<typeof setTimeout> | null;
  stableTimer: ReturnType<typeof setTimeout> | null;
  /** When this connection last received anything from the server (local clock, ms). */
  lastHeardAt?: number;
  /** The server time of the newest live line on this connection, in ms. See logSync.ts. */
  newestServerTime?: number;
  /**
   * Set when a registered connection is lost, or at the start from the Log's Sync
   * marker. See missed.ts.
   */
  missed?: MissedWindow;
  /** True once this connection asked who wrote to you while it was down (TARGETS). */
  targetsAsked: boolean;
  /** Missed mentions found in history, waiting to be reported as one batch. */
  missedMentions: MentionEvent[];
  missedTimer: ReturnType<typeof setTimeout> | null;
  /** Lowercase nicks whose WHOIS reply is arriving (311 to 318): their "is away" goes in the WHOIS lines. */
  pendingWhois: Set<string>;
  /** The /history requests waiting for their batch (or FAIL), oldest first. */
  historyRequests: HistoryRequest[];
  /**
   * The away text last shown, by nick (see nameKey) and then by buffer, so a DM says
   * "is away" once, not per message.
   */
  awayShown: Map<string, Map<string, string>>;
  /**
   * True once a FAIL MARKREAD was shown on this connection. honk sends MARKREAD on its
   * own about once a second, so a server that keeps refusing it would flood *status.
   */
  markReadFailShown: boolean;
  /**
   * The casemapping that the name keys above (whois, away texts, /history requests),
   * and the read markers in ReadMarkerTracker, were made with. See settleCasemapping.
   */
  keyCasemapping: Casemapping;
}

function createControl(): ServerControl {
  return {
    manualDisconnect: false,
    fatalError: false,
    attempts: 0,
    registered: false,
    hasEverConnected: false,
    nickCollisionTries: 0,
    reconnectTimer: null,
    connectTimer: null,
    stableTimer: null,
    missedMentions: [],
    missedTimer: null,
    targetsAsked: false,
    pendingWhois: new Set(),
    historyRequests: [],
    awayShown: new Map(),
    markReadFailShown: false,
    keyCasemapping: DEFAULT_CASEMAPPING,
  };
}

/**
 * History for all channels arrives in separate batches after the rejoin. Wait this long
 * after the last missed mention before reporting them, so they go out as one summary.
 */
const MISSED_REPORT_DELAY_MS = 3_000;

/**
 * The TLS error code if the server's certificate was rejected (self-signed, expired,
 * wrong host...). Retrying can't fix these. Node and Bun put the reason only in `code`;
 * the message is free text such as "self signed certificate".
 */
function tlsCertErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return undefined;
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)
    ? code
    : undefined;
}

function isFatalErrorMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("sasl auth failed") ||
    m.includes("sasl authentication failed") ||
    m.includes("err_saslfail") ||
    m.includes("k-lined") ||
    m.includes("g-lined") ||
    m.includes("z-lined") ||
    m.includes("you are banned")
  );
}

/** "Usage: /whois <nick>", from the command table, so it matches /help and the omnibox. */
function usage(name: string): string {
  const cmd = findSlashCommand(name);
  return `Usage: ${cmd ? syntax(cmd) : `/${name}`}`;
}

/** The error for a command that needs a channel or DM, used from *status. */
function insideOnly(name: string): string {
  return `Use /${name} inside a channel or DM.`;
}

function computeBackoffMs(attempt: number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
  // ±25% random jitter
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(exp * jitter);
}

/**
 * Where a line with time `t` goes in `messages`, which are in time order: after every
 * line that is not newer. The scan starts at the end, where new lines usually go.
 */
function timeOrderIndex(messages: readonly ChatMessage[], t: number): number {
  let at = messages.length;
  while (at > 0 && messages[at - 1]!.timestamp.getTime() > t) at--;
  return at;
}

/**
 * Moves your line `id`, whose time the Echo just set, to its place in time order among
 * other people's lines. It never passes another line of yours, because the server got
 * your lines in the order you sent them:
 *
 *   before: hi, one (t), two (t), between (t+3)      echoes say t+5
 *   after:  hi, between, one, two
 *
 * When the line moves, your line next to it on the side it left may now follow, so
 * that one is placed again too. Changes `messages`; returns true if a line moved.
 */
function placeOwnLine(messages: ChatMessage[], id: string): boolean {
  const from = messages.findLastIndex((m) => m.id === id);
  if (from < 0) return false;
  const line = messages[from]!;
  const t = line.timestamp.getTime();
  // How far it may go: up to, not past, your next line on either side.
  let first = from;
  while (first > 0 && !messages[first - 1]!.isSelf) first--;
  let last = from;
  while (last < messages.length - 1 && !messages[last + 1]!.isSelf) last++;

  let at = from;
  while (at < last && messages[at + 1]!.timestamp.getTime() <= t) at++;
  if (at === from) while (at > first && messages[at - 1]!.timestamp.getTime() > t) at--;
  if (at === from) return false;
  messages.splice(from, 1);
  messages.splice(at, 0, line);

  const neighbor = at > from ? messages[first - 1] : messages[last + 1];
  if (neighbor?.timeFromServer) placeOwnLine(messages, neighbor.id);
  return true;
}

let nextMsgId = 1;
function makeMessage(
  kind: MessageKind,
  text: string,
  extra?: Partial<Omit<ChatMessage, "id" | "timestamp" | "kind" | "text">> & {
    timestamp?: Date;
  },
): ChatMessage {
  return {
    ...extra,
    id: String(nextMsgId++),
    timestamp: extra?.timestamp ?? new Date(),
    kind,
    text,
  };
}

/**
 * MARKREAD for `target`: with a time, moves your read marker there; without one, asks
 * the server for it. See readMarker.ts.
 */
function requestMarkRead(client: Client, target: string, time?: number): void {
  void client.send(
    "MARKREAD" as never,
    target as never,
    ...((time === undefined ? [] : [timestampParam(time)]) as never[]),
  );
}

/** Cancels a pending connect for each client, so a dropped attempt can't register late. */
const connectAborts = new WeakMap<Client, AbortController>();

/** Closes the client's socket, or cancels its connect if the socket isn't open yet. */
function safeDisconnect(client: Client): void {
  connectAborts.get(client)?.abort();
  try {
    client.disconnect();
  } catch {
    // ignore
  }
}

function requestHistory(
  client: Client,
  subcommand: "LATEST" | "BEFORE" | "AFTER",
  target: string,
  anchor: string,
  limit: number,
  label?: string,
): void {
  const command = "CHATHISTORY" as never;
  const params = [subcommand, target, anchor, String(limit)] as never[];
  // send writes a tag section for any object, also an empty one ("@ CHATHISTORY ..."),
  // which the message-tags grammar does not allow. Pass tags only when there is a label.
  if (label === undefined) void client.send(command, ...params);
  else void client.send({ label }, command, ...params);
}

/** A History request waiting for its reply: a /history, or a fill for the Log. */
interface HistoryRequest {
  /** The buffer it was typed in, or the one it fills, as nameKey. */
  target: string;
  /**
   * The label tag sent with it, when the server has labeled-response. The server copies
   * it onto the reply, so a FAIL or a batch matches this request and no other.
   */
  label?: string;
  /** Set for the Log's own request, which fills a gap in the Log. See logSync.ts. */
  fill?: Fill;
  /** Set for a /history. */
  history?: {
    /** How many lines it asked for. */
    asked: number;
    /** The oldest Line on screen when it was asked: the batch's Lines go before it. */
    beforeLineId?: string;
  };
}

/** Counts the labels sent with History requests, so each one is new on its connection. */
let historyLabels = 0;

/** A new label for a History request, or none if the server has no labeled-response. */
function historyLabel(client: Client): string | undefined {
  return client.state.caps.enabled.has("labeled-response")
    ? `history-${++historyLabels}`
    : undefined;
}

/**
 * Takes the /history request that a history batch answers out of `pending`. A labeled
 * batch matches by label. An unlabeled one (the server has no labeled-response) matches
 * an unlabeled request for the same target. Returns undefined when the batch answers no
 * /history, such as the history honk fetches on join.
 *
 *   pending [{ target: "#a", label: "h1" }], batch label "h1"         -> the #a request
 *   pending [{ target: "#a" }],              no label, batch target #a -> the #a request
 *   pending [{ target: "#a", label: "h1" }], no label, batch target #a -> undefined
 */
function takeHistoryRequest(
  pending: HistoryRequest[],
  label: string | undefined,
  targetKey: string,
): HistoryRequest | undefined {
  const i =
    label !== undefined
      ? pending.findIndex((r) => r.label === label)
      : pending.findIndex((r) => r.label === undefined && r.target === targetKey);
  return i === -1 ? undefined : pending.splice(i, 1)[0];
}

/** The CHATHISTORY subcommands, which come before the target in a FAIL's context. */
const HISTORY_SUBCOMMANDS = new Set(["LATEST", "BEFORE", "AFTER", "AROUND", "BETWEEN", "TARGETS"]);

/**
 * The target a FAIL CHATHISTORY names. The spec form is
 * `FAIL CHATHISTORY <code> <subcommand> <target> :<description>`, so after a subcommand
 * the next param is the target, even one honk has no buffer for. Some servers leave out
 * the subcommand; then the target is the first param for which `known` says yes.
 *
 *   ["LATEST", "#a", "*"], known -  -> "#a"
 *   ["BEFORE", "after"],   known -  -> "after"  (a DM with the nick "after")
 *   ["#a"],                known #a -> "#a"
 *   ["#a"],                known -  -> undefined
 */
function historyFailTarget(
  context: string[],
  known: (name: string) => boolean,
): string | undefined {
  if (HISTORY_SUBCOMMANDS.has((context[0] ?? "").toUpperCase())) {
    const target = context[1];
    return target && target !== "*" ? target : undefined;
  }
  return context.find(known);
}

/**
 * Takes the /history request a FAIL CHATHISTORY answers out of `pending`, the way
 * takeHistoryRequest does for a batch. A labeled FAIL matches by label. An unlabeled one
 * matches an unlabeled request for the target it names. An unlabeled FAIL that names no
 * target can't say which request it answers, so every unlabeled request stops waiting;
 * labeled ones still get their own reply.
 *
 * Without labels, a FAIL for the history honk fetches on join looks the same as a FAIL
 * for a /history in that channel, so it can take that /history request. Its own reply
 * then shows nothing.
 *
 *   [#a h1, #b h2], FAIL label h2      -> the #b request, leaves [#a h1]
 *   [#a, #b],       FAIL no label, #b  -> the #b request, leaves [#a]
 *   [#a h1],        FAIL no label, #a  -> undefined, leaves [#a h1]  (the join fetch failed)
 *   [#a, #b h2],    FAIL no label, none -> undefined, leaves [#b h2]
 */
function takeFailedHistoryRequest(
  pending: HistoryRequest[],
  label: string | undefined,
  targetKey: string | undefined,
): HistoryRequest | undefined {
  if (label !== undefined || targetKey !== undefined) {
    return takeHistoryRequest(pending, label, targetKey ?? "");
  }
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i]!.label === undefined) pending.splice(i, 1);
  }
  return undefined;
}

function createBuffer(name: string, kind: BufferKind): BufferState {
  return {
    name,
    kind,
    topic: "",
    messages: [],
    users: [],
    unread: 0,
    hasMention: false,
  };
}

/**
 * True if the buffer still shows as unread: a count, or the mention mark. It clears
 * when the buffer counts as read (see IrcManager.markedRead).
 */
function hasBadge(buf: BufferState): boolean {
  return buf.unread > 0 || buf.hasMention;
}

/**
 * True if `text` contains `nick` as a whole word, touching no nick character on either
 * side. `\b` fails for nicks like `goose[m]`. Both are folded with the server's
 * casemapping first, so on rfc1459 "GOOSE{M}: hi" names goose[m].
 */
function mentionsNick(text: string, nick: string, mapping: Casemapping): boolean {
  if (!nick) return false;
  const escaped = nameKey(nick, mapping).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!${NICK_CHAR.source})${escaped}(?!${NICK_CHAR.source})`).test(
    nameKey(text, mapping),
  );
}

/** The buffer a chat line belongs to: the channel, or for a DM the other person. */
function routeTarget(rawTarget: string, from: string, isSelf: boolean): string {
  return isChannelName(rawTarget) || isSelf ? rawTarget : from;
}

/**
 * Calls `hook` with the arguments of every `client.send`, before the line goes out. The
 * first argument is the tags object when the call has tags.
 */
function beforeSend(client: Client, hook: (...args: unknown[]) => void): void {
  beforeCall(client, "send", hook);
}

/** Runs `hook` before each call of a client method. */
function beforeCall(client: Client, key: "emit" | "send", hook: (...args: unknown[]) => void): void {
  hookCall(client, key, (fn, ...args) => {
    hook(...args);
    return fn(...args);
  });
}

type Method = (...args: unknown[]) => unknown;

/**
 * Replaces a client method with `hook`, which gets the method and the arguments, through
 * irc-client-ts's own hooks.
 */
function hookCall(
  client: Client,
  key: "emit" | "send",
  hook: (fn: Method, ...args: unknown[]) => unknown,
): void {
  (
    client as unknown as {
      hooks: { hookCall(key: string, hook: (fn: Method, ...args: unknown[]) => unknown): void };
    }
  ).hooks.hookCall(key, hook);
}

/** A PRIVMSG text as a line: "\x01ACTION waves\x01" is the action "waves". */
function sentPart(text: string): SentPart {
  if (!text.startsWith("\x01ACTION ")) return { kind: "message", text };
  return { kind: "action", text: text.slice(8, text.endsWith("\x01") ? -1 : undefined) };
}

/** Buffer order for the sidebar: *status, then channels, then DMs, each sorted by name. */
function sortBufferOrder(server: ServerState, order: string[]): string[] {
  return order.sort((a, b) => {
    if (a === STATUS_BUFFER) return -1;
    if (b === STATUS_BUFFER) return 1;
    const ka = server.buffers[a]?.kind ?? "dm";
    const kb = server.buffers[b]?.kind ?? "dm";
    if (ka !== kb) return ka === "channel" ? -1 : 1;
    return a.localeCompare(b);
  });
}

/** Sorts a user list by mode (ops, then voice, then everyone else), then by nick. */
function sortUsers(users: NickEntry[]): NickEntry[] {
  const rank = (p: string) => (p ? PREFIX_ORDER.indexOf(p[0]!) : PREFIX_ORDER.length);
  return [...users].sort(
    (a, b) => rank(a.prefix) - rank(b.prefix) || a.nick.localeCompare(b.nick),
  );
}

/** A demo channel's users from "@alice"-style entries, with the demo user added. */
function demoUsers(entries: string[]): NickEntry[] {
  const users = entries.map((entry): NickEntry => {
    const prefix = PREFIX_ORDER.includes(entry[0]!) ? entry[0]! : "";
    return { prefix, nick: entry.slice(prefix.length) };
  });
  // Demo servers never send a CASEMAPPING, so they keep the default.
  if (!users.some((u) => sameNick(u.nick, DEMO_NICK, DEFAULT_CASEMAPPING))) {
    users.push({ prefix: "", nick: DEMO_NICK });
  }
  return sortUsers(users);
}

/** The start of every joinKey on a server. */
function joinPrefix(serverId: string): string {
  return `${serverId}\n`;
}

/** A /join request's key: the server and the channel's key (see nameKey). */
function joinKey(serverId: string, channelKey: string): string {
  return joinPrefix(serverId) + channelKey;
}

function channelsWithNick(server: ServerState, nick: string): string[] {
  return server.bufferOrder.filter((name) => {
    const buf = server.buffers[name];
    return (
      buf?.kind === "channel" && buf.users.some((u) => sameNick(u.nick, nick, server.casemapping))
    );
  });
}

export class IrcManager {
  private clients = new Map<string, Client>();
  private servers = new Map<string, ServerState>();
  private controls = new Map<string, ServerControl>();
  private serverOrder: string[] = [];
  private active: ActiveBuffer | null = null;
  private listeners = new Set<() => void>();
  private mentionListeners = new Set<(event: MentionEvent) => void>();
  private missedListeners = new Set<(events: MentionEvent[]) => void>();
  /** Moves your read marker for the buffer on screen. See readMarker.ts. */
  private readonly readMarkerTracker: ReadMarkerTracker;
  /** Matches the echo of each line you send to the line already shown. See echo.ts. */
  private echoes = new EchoTracker();
  /** While pushSent sends one of your lines: each PRIVMSG that went out. See beforeSend. */
  private outgoing: SentPart[] | null = null;
  /** Confirms that the lines you send reach the server. See delivery.ts. */
  private delivery = new DeliveryTracker({
    delivered: (serverId, lines) => {
      this.setDelivery(serverId, lines, undefined);
      this.logRecorder?.delivered(serverId, lines);
    },
    timedOut: (serverId, lines) => this.deliveryTimedOut(serverId, lines),
  });
  /** Notices Wi-Fi going off and on, or a move to another network. See netwatch.ts. */
  private netWatcher = new NetworkWatcher({
    onChange: (online) => this.handleNetworkChange(online),
  });
  private snapshot: StoreSnapshot = { servers: [], active: null, update: null };
  private update: UpdateNotice | null = null;
  private wakeInterval: ReturnType<typeof setInterval> | null = null;
  /** Channels the user asked to /join, with when the request expires. The join switches to them. See joinKey. */
  private requestedJoins = new Map<string, number>();
  private lastWakeTick = Date.now();
  /** Writes Lines to the Log, if honk keeps one. See logRecorder.ts. */
  private readonly logRecorder: LogRecorder | undefined;
  /** The Log that Buffers load their scrollback from. See src/log/scrollback.ts. */
  private readonly log: Log | undefined;

  /**
   * `markReadDelayMs`: see MARK_READ_DELAY_MS in readMarker.ts. Tests pass a shorter one.
   * `log`: the Log to write Lines to; none keeps no Log.
   */
  constructor(options: { markReadDelayMs?: number; log?: Log } = {}) {
    this.log = options.log;
    this.logRecorder = options.log && this.createLogRecorder(options.log);
    this.readMarkerTracker = new ReadMarkerTracker(
      {
        onScreen: () => this.active,
        newestTime: (serverId, bufferName) => this.markReadTime(serverId, bufferName),
        send: (serverId, bufferName, time) => {
          const client = this.clients.get(serverId);
          if (client) requestMarkRead(client, bufferName, time);
        },
        casemapping: (serverId) => this.casemapping(serverId),
        markedRead: (serverId, bufferName) => this.markedRead(serverId, bufferName),
      },
      { delayMs: options.markReadDelayMs },
    );
    this.startWakeWatcher();
    this.netWatcher.start();
  }

  private startWakeWatcher(): void {
    if (this.wakeInterval) return;
    this.lastWakeTick = Date.now();
    this.wakeInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastWakeTick;
      this.lastWakeTick = now;
      if (elapsed > WAKE_JUMP_THRESHOLD_MS) {
        this.handleSystemWake();
      }
      this.logRecorder?.tick(this.serverOrder);
    }, WAKE_CHECK_INTERVAL_MS);
  }

  private handleSystemWake(): void {
    for (const id of this.serverOrder) {
      const server = this.servers.get(id);
      const ctrl = this.controls.get(id);
      if (!server || !ctrl || !server.config.host) continue;
      if (ctrl.manualDisconnect || ctrl.fatalError) continue;
      if (
        server.status === "connected" ||
        server.status === "connecting" ||
        server.status === "reconnecting"
      ) {
        this.pushMessage(
          id,
          STATUS_BUFFER,
          makeMessage("system", "The computer woke from sleep. Reconnecting..."),
        );
        void this.connectServer(id, { manual: true });
      }
    }
  }

  /**
   * The computer's addresses changed. A server waiting to retry tries now, instead of
   * after its backoff (up to a minute). A connected server gets a PING: if the change
   * killed its connection, the PING times out and honk reconnects. honk doesn't drop
   * the connection outright, because one to this machine (a local bouncer) still works.
   */
  private handleNetworkChange(online: boolean): void {
    for (const id of this.serverOrder) {
      const server = this.servers.get(id);
      const ctrl = this.controls.get(id);
      if (!server || !ctrl || !server.config.host) continue;
      if (ctrl.manualDisconnect || ctrl.fatalError) continue;
      if (server.status === "reconnecting" && online) {
        this.pushMessage(
          id,
          STATUS_BUFFER,
          makeMessage("system", "The network changed. Reconnecting now..."),
        );
        void this.connectServer(id, { manual: true });
      } else if (server.status === "connected") {
        const client = this.clients.get(id);
        if (client) this.delivery.probe(id, (token) => void client.send("PING", token));
      }
    }
  }

  private getControl(serverId: string): ServerControl {
    let ctrl = this.controls.get(serverId);
    if (!ctrl) {
      ctrl = createControl();
      this.controls.set(serverId, ctrl);
    }
    return ctrl;
  }

  /** The server's casemapping, which decides which names are the same. See nameKey. */
  private casemapping(serverId: string): Casemapping {
    return casemappingOf(this.servers.get(serverId));
  }

  /** `name` folded with the server's casemapping, for use as a map key. See nameKey. */
  private key(serverId: string, name: string): string {
    return nameKey(name, this.casemapping(serverId));
  }

  /** True when the server sees `a` and `b` as one name. See sameNick. */
  private same(serverId: string, a: string | undefined, b: string | undefined): boolean {
    return sameNick(a, b, this.casemapping(serverId));
  }

  /**
   * Call once a connection knows its server's casemapping. If it differs from the one
   * the kept name keys were made with, those keys no longer match, so they are dropped:
   * read markers (the server sends them again for each JOIN), and whatever still waits
   * for an answer. Folding them again can't work: a key folded with rfc1459 no longer
   * says whether the name had "[" or "{".
   */
  private settleCasemapping(serverId: string): void {
    const server = this.servers.get(serverId);
    const ctrl = this.getControl(serverId);
    if (!server || server.casemapping === ctrl.keyCasemapping) return;
    ctrl.keyCasemapping = server.casemapping;
    this.readMarkerTracker.forget(serverId);
    this.forgetPendingRequests(serverId);
    this.echoes.drop(serverId);
  }

  /** True (and forgets the request) if the user ran /join for this channel and it hasn't expired. */
  /** Remembers that you asked to join `channel`, so its JOIN moves the view there. */
  private noteRequestedJoin(serverId: string, channel: string): void {
    const key = joinKey(serverId, this.key(serverId, channel));
    this.requestedJoins.set(key, Date.now() + REQUESTED_JOIN_TTL_MS);
  }

  private takeRequestedJoin(serverId: string, channel: string): boolean {
    const key = joinKey(serverId, this.key(serverId, channel));
    const expires = this.requestedJoins.get(key);
    this.requestedJoins.delete(key);
    return expires !== undefined && expires > Date.now();
  }

  /** Forgets the requests waiting for an answer: the connection that would answer is gone. */
  private forgetPendingRequests(serverId: string): void {
    const ctrl = this.getControl(serverId);
    ctrl.historyRequests = [];
    ctrl.pendingWhois.clear();
    ctrl.awayShown.clear();
    const prefix = joinPrefix(serverId);
    for (const key of this.requestedJoins.keys()) {
      if (key.startsWith(prefix)) this.requestedJoins.delete(key);
    }
  }

  /** Forgets which "is away" texts were shown for this nick, in every buffer. */
  private forgetAwayShown(serverId: string, nick: string): void {
    this.getControl(serverId).awayShown.delete(this.key(serverId, nick));
  }

  private clearServerTimers(ctrl: ServerControl): void {
    if (ctrl.reconnectTimer) {
      clearTimeout(ctrl.reconnectTimer);
      ctrl.reconnectTimer = null;
    }
    if (ctrl.connectTimer) {
      clearTimeout(ctrl.connectTimer);
      ctrl.connectTimer = null;
    }
    if (ctrl.stableTimer) {
      clearTimeout(ctrl.stableTimer);
      ctrl.stableTimer = null;
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): StoreSnapshot => this.snapshot;

  /** Calls `listener` for each live mention or DM, not for history playback or your own lines. */
  onMention(listener: (event: MentionEvent) => void): () => void {
    this.mentionListeners.add(listener);
    return () => this.mentionListeners.delete(listener);
  }

  /**
   * Calls `listener` with the mentions and DMs you missed while a connection was down,
   * once the history after the reconnect has arrived. See missed.ts.
   */
  onMissedMentions(listener: (events: MentionEvent[]) => void): () => void {
    this.missedListeners.add(listener);
    return () => this.missedListeners.delete(listener);
  }

  private emitQueued = false;

  /** Coalesces all state changes made in one tick (a socket read, a history batch) into one render. */
  private emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      this.flush();
    });
  }

  private flush(): void {
    const servers: ServerState[] = [];
    for (const id of this.serverOrder) {
      const s = this.servers.get(id);
      if (s) servers.push({ ...s });
    }
    this.snapshot = {
      servers,
      active: this.active ? { ...this.active } : null,
      update: this.update,
    };
    for (const listener of this.listeners) {
      listener();
    }
  }

  initWelcome(): void {
    if (this.serverOrder.length > 0) return;
    const id = "local";
    const status = createBuffer(STATUS_BUFFER, "status");
    status.messages.push(
      makeMessage("system", "Welcome to honk, a terminal IRC client."),
      makeMessage(
        "system",
        "Connect to a server with: /connect irc.libera.chat 6697 yournick",
      ),
      makeMessage(
        "system",
        "Or list your servers in honk.json (see honk.example.json) to connect at startup. Type /help to list the commands.",
      ),
      makeMessage("system", "To look around without connecting anywhere, type /demo."),
    );
    const server: ServerState = {
      id,
      name: "local",
      config: { id, host: "", nick: defaultNick() },
      status: "disconnected",
      nick: defaultNick(),
      casemapping: DEFAULT_CASEMAPPING,
      tls: false,
      buffers: { [STATUS_BUFFER]: status },
      bufferOrder: [STATUS_BUFFER],
    };
    this.servers.set(id, server);
    this.controls.set(id, createControl());
    this.serverOrder.push(id);
    this.active = { serverId: id, buffer: STATUS_BUFFER };
    this.emit();
  }

  /**
   * Shows a line from honk itself, not from a server, such as the update notice.
   * It goes to the first server's *status buffer, which is where honk starts.
   * As a system line, it does not count as unread.
   */
  addAppNotice(text: string): void {
    const id = this.serverOrder[0];
    if (!id) return;
    this.pushMessage(id, STATUS_BUFFER, makeMessage("system", text));
  }

  /**
   * Shows that a newer release exists: a short label in the status bar, which
   * stays visible in every buffer, and the full lines in *status.
   */
  showUpdate(update: UpdateNotice, lines: string[]): void {
    this.update = { ...update };
    for (const line of lines) this.addAppNotice(line);
    this.emit();
  }

  addServer(config: ServerConfig): void {
    if (
      this.servers.has("local") &&
      this.serverOrder.length === 1 &&
      config.id !== "local"
    ) {
      this.servers.delete("local");
      this.controls.delete("local");
      this.readMarkerTracker.forget("local");
      this.serverOrder = [];
      this.active = null;
    }

    const existing = this.servers.get(config.id);
    const via =
      config.via || (config.username?.includes("/") ? config.host : undefined);
    if (existing) {
      existing.config = config;
      existing.name = existing.networkName || config.name || config.host;
      existing.via = via;
      existing.nick = config.nick;
      existing.tls = config.tls ?? true;
    } else {
      const statusBuf = createBuffer(STATUS_BUFFER, "status");
      const server: ServerState = {
        id: config.id,
        name: config.name || config.host,
        via,
        config,
        status: "disconnected",
        nick: config.nick,
        casemapping: DEFAULT_CASEMAPPING,
        tls: config.tls ?? true,
        buffers: { [STATUS_BUFFER]: statusBuf },
        bufferOrder: [STATUS_BUFFER],
      };
      this.servers.set(config.id, server);
      this.controls.set(config.id, createControl());
      this.serverOrder.push(config.id);
    }

    if (!this.active) {
      this.active = { serverId: config.id, buffer: STATUS_BUFFER };
    }
    this.logRecorder?.setNetwork(config.id, {
      display: config.name || config.host,
      exclude: config.logExclude ?? [],
    });
    this.emit();

    if (config.autoConnect !== false && config.host) {
      void this.connectServer(config.id, { manual: true });
    }
  }

  async connectServer(
    serverId: string,
    opts: { manual?: boolean } = {},
  ): Promise<void> {
    const server = this.servers.get(serverId);
    if (!server || !server.config.host) return;

    const ctrl = this.getControl(serverId);
    this.clearServerTimers(ctrl);
    ctrl.manualDisconnect = false;
    ctrl.fatalError = false;
    this.noteConnectionLost(serverId, ctrl);
    ctrl.registered = false;
    ctrl.nickCollisionTries = 0;
    if (opts.manual) {
      ctrl.attempts = 0;
    }

    // Tear down any previous client cleanly before replacing
    this.failPendingLines(serverId);
    const prev = this.clients.get(serverId);
    this.clients.delete(serverId);
    if (prev) safeDisconnect(prev);

    const cfg = server.config;
    const { port, tls } = this.endpoint(serverId);

    // Determine channels to join:
    // - On bouncers (soju), only send config.channels on first connect when no channels are open;
    //   on reconnect, soju replays joined channels automatically.
    // - On direct servers, rejoin all currently open channels merged with config.channels.
    const openChannels = server.bufferOrder.filter(
      (b) => server.buffers[b]?.kind === "channel",
    );
    const skipJoin =
      Boolean(server.via) && ctrl.hasEverConnected && openChannels.length > 0;
    const channelsToJoin = skipJoin
      ? []
      : [...new Set([...(cfg.channels ?? []), ...openChannels])];

    server.status = "connecting";
    server.reconnectInfo = undefined;
    server.tls = tls;
    this.pushMessage(
      serverId,
      STATUS_BUFFER,
      makeMessage(
        "system",
        `Connecting to ${cfg.host}:${port} (${tls ? "TLS" : "no TLS"}) as ${cfg.nick}...`,
      ),
    );

    const client = new Client({
      nick: cfg.nick,
      username: cfg.username ?? cfg.nick,
      realname: cfg.realname ?? cfg.nick,
      password: cfg.password,
      serverPassword: cfg.serverPassword,
      authMethod: cfg.authMethod ?? (cfg.password ? "sasl" : undefined),
      // No automatic CTCP replies. Each request would get a NOTICE back with no rate
      // limit, so a burst of requests from many users makes the server drop us for
      // flooding ("RecvQ exceeded"). TIME also gives away the local time. /me (ACTION)
      // and the server's PING/PONG keepalive don't use this option.
      ctcpReplies: { version: false, time: false, ping: false, clientinfo: false },
      ...(channelsToJoin.length > 0
        ? { channels: channelsToJoin as [string, ...string[]] }
        : {}),
    });

    // Use node:net / node:tls adapter for reliable TLS on Bun. safeDisconnect aborts
    // a connect that is still pending (e.g. after the connect timeout below).
    const abort = new AbortController();
    connectAborts.set(client, abort);
    // Each bug once per connection, and a few at most: a bug that hits every line of
    // one kind, such as each NAMES reply, would otherwise push everything else out of
    // *status.
    const reported = new Set<string>();
    const reportBug = neverThrow(({ key, text }: { key: string; text: string }) => {
      if (this.clients.get(serverId) !== client) return;
      if (reported.has(key) || reported.size >= MAX_BUG_REPORTS) return;
      this.pushMessage(serverId, STATUS_BUFFER, makeMessage("system", text));
      // Only now: if showing the report threw, the next one may still get through.
      reported.add(key);
    });
    let reportedTooLong = false;
    (client as unknown as { runtime: ReturnType<typeof createNodeRuntime> }).runtime =
      createNodeRuntime(
        abort.signal,
        (line) => {
          if (this.clients.get(serverId) === client) this.onRawLine(serverId, line);
        },
        // A bug in honk, not in the server: say so, show the line, and keep going.
        // irc-client-ts still reads the line.
        (line, err) => reportBug(describeLineError(line, err)),
        // Once per connection: a broken server may send many.
        () => {
          if (this.clients.get(serverId) !== client || reportedTooLong) return;
          reportedTooLong = true;
          this.pushMessage(
            serverId,
            STATUS_BUFFER,
            makeMessage(
              "system",
              `The server sent a line longer than ${MAX_LINE_BYTES} bytes. honk dropped it, and drops any more like it.`,
            ),
          );
        },
      );

    // Request IRCv3 draft/chathistory when advertised by server/bouncer (e.g. soju)
    if (!client.state.caps.requested.includes("draft/chathistory")) {
      client.state.caps.requested.push("draft/chathistory");
    }
    // Without it, Ergo plays joins, parts and mode changes back as fake messages from
    // "HistServ" ("alice joined the channel"). With it, they come as real JOIN and MODE
    // lines inside the history batch, which the batch handler gives to the Log only.
    if (!client.state.caps.requested.includes("draft/event-playback")) {
      client.state.caps.requested.push("draft/event-playback");
    }
    // The server keeps how far you have read each buffer. See readMarker.ts.
    if (!client.state.caps.requested.includes(READ_MARKER_CAP)) {
      client.state.caps.requested.push(READ_MARKER_CAP);
    }
    // REDACT, so the Log marks a deleted Line. The screen does not show it yet.
    this.logRecorder?.requestCaps(client.state.caps.requested);

    // The text of each PRIVMSG as it goes out: irc-client-ts splits a long line into
    // several. The echo has these parts, not what you typed.
    beforeSend(client, (...args) => {
      if (!this.outgoing) return;
      const [command, , text] = typeof args[0] === "object" ? args.slice(1) : args;
      if (command === "PRIVMSG" && typeof text === "string") this.outgoing.push(sentPart(text));
    });

    this.clients.set(serverId, client);
    this.bindClientEvents(serverId, client, reportBug);

    // Per-attempt connect + registration timeout (catches DNS/TCP/TLS blackholes)
    ctrl.connectTimer = setTimeout(() => {
      if (this.clients.get(serverId) !== client || ctrl.registered) return;
      this.pushMessage(
        serverId,
        STATUS_BUFFER,
        makeMessage("error", `Connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s.`),
      );
      this.clients.delete(serverId);
      safeDisconnect(client);
      this.scheduleReconnect(serverId);
    }, CONNECT_TIMEOUT_MS);

    const conn = await client.connect(cfg.host, { port, tls });
    if (!conn && this.clients.get(serverId) === client) {
      // connect() failed and emitted an error event; ensure reconnect is scheduled if non-fatal
      this.scheduleReconnect(serverId);
    }
  }

  private scheduleReconnect(serverId: string): void {
    const server = this.servers.get(serverId);
    const ctrl = this.controls.get(serverId);
    if (!server || !ctrl || !server.config.host) return;
    if (ctrl.manualDisconnect || ctrl.fatalError) return;
    // Idempotent: if a retry is already scheduled, don't double-schedule
    if (ctrl.reconnectTimer) return;
    this.clearServerTimers(ctrl);

    const delayMs = computeBackoffMs(ctrl.attempts);
    ctrl.attempts += 1;
    const attempt = ctrl.attempts;
    const nextRetryAt = Date.now() + delayMs;

    server.status = "reconnecting";
    server.reconnectInfo = { attempt, nextRetryAt };

    const secs = Math.max(1, Math.round(delayMs / 1000));
    this.pushMessage(
      serverId,
      STATUS_BUFFER,
      makeMessage("system", `Reconnecting in ${secs}s (attempt ${attempt})...`),
    );

    ctrl.reconnectTimer = setTimeout(() => {
      ctrl.reconnectTimer = null;
      if (ctrl.manualDisconnect || ctrl.fatalError) return;
      void this.connectServer(serverId, { manual: false });
    }, delayMs);
  }

  disconnectServer(serverId: string, reason = "Leaving"): void {
    const ctrl = this.getControl(serverId);
    ctrl.manualDisconnect = true;
    this.noteConnectionLost(serverId, ctrl);
    ctrl.registered = false;
    this.clearServerTimers(ctrl);
    this.forgetPendingRequests(serverId);

    const client = this.clients.get(serverId);
    this.clients.delete(serverId);
    this.failPendingLines(serverId);
    const server = this.servers.get(serverId);
    if (client) {
      try {
        client.quit(reason);
      } catch {
        // ignore
      }
      safeDisconnect(client);
    }
    if (server) {
      server.status = "disconnected";
      server.reconnectInfo = undefined;
      this.pushMessage(
        serverId,
        STATUS_BUFFER,
        makeMessage("system", "Disconnected."),
      );
      if (client) this.noteOffline(serverId, "Disconnected. Type /connect to reconnect.");
    }
  }

  disconnectAll(): void {
    this.readMarkerTracker.stop();
    if (this.wakeInterval) {
      clearInterval(this.wakeInterval);
      this.wakeInterval = null;
    }
    this.netWatcher.stop();
    for (const id of [...this.serverOrder]) {
      if (this.clients.has(id) || this.controls.get(id)?.reconnectTimer) {
        this.disconnectServer(id);
      }
    }
  }

  private bindClientEvents(
    serverId: string,
    client: Client,
    reportBug: (report: { key: string; text: string }) => void,
  ): void {
    const isStale = () => this.clients.get(serverId) !== client;
    /** The server state, or undefined if this client was replaced. */
    const live = () => (isStale() ? undefined : this.servers.get(serverId));

    // The channels a quitting/renamed nick was in, read before the nicklist plugin
    // removes the nick. Keyed by the event payload.
    const priorChannels = new WeakMap<object, string[]>();
    // The privmsg/notice plugins emit { source, params } without the IRCv3 tags (server
    // time, msgid). They emit inside the raw event, so link each payload to the raw tags.
    type Tags = Record<string, string | undefined>;
    const chatTags = new WeakMap<object, Tags>();
    let rawChatTags: Tags | undefined;
    // Runs before each event reaches any listener. The library's own plugins (nicklist)
    // listen before the app does and change state first, so state "before the event"
    // must be read here.
    const notePayload = (event: string, payload: unknown) => {
      const server = live();
      if (!server || typeof payload !== "object" || payload === null) return;
      if (event === "raw:privmsg" || event === "raw:notice") {
        rawChatTags = (payload as { tags?: Tags }).tags;
        return;
      }
      if (/^(privmsg|notice):|^ctcp_action$/.test(event)) {
        if (rawChatTags) chatTags.set(payload, rawChatTags);
        return;
      }
      if (event === "quit" || event === "nick") {
        const source = (payload as { source?: { name?: string } }).source;
        priorChannels.set(payload, channelsWithNick(server, normalizeNick(source?.name)));
      }
    };

    // irc-client-ts emits from its read loop, without await and without a catch: a
    // listener that throws, honk's or one of the library's plugins, would end the loop,
    // and nothing more would come from this server. So each emit is guarded. A nested
    // emit, such as privmsg inside raw:privmsg, is caught at the inner one.
    hookCall(client, "emit", (emit, event, payload) => {
      try {
        notePayload(event as string, payload);
      } catch (err) {
        reportBug(describeEventError(event as string, err));
      }
      try {
        return emit(event, payload);
      } catch (err) {
        reportBug(describeEventError(event as string, err));
      }
    });

    client.on("error", (err) => {
      if (isStale()) return;
      const server = this.servers.get(serverId);
      const ctrl = this.getControl(serverId);
      const errText = err.message || String(err);
      const at = this.endpoint(serverId);
      const certCode = tlsCertErrorCode(err);
      const fatal = Boolean(certCode) || isFatalErrorMessage(errText);
      this.pushMessage(
        serverId,
        STATUS_BUFFER,
        makeMessage(
          "error",
          certCode ? describeCertError(certCode, at) : describeConnectionError(err, at, fatal),
        ),
      );

      if (fatal) {
        ctrl.fatalError = true;
        this.clearServerTimers(ctrl);
        if (server) {
          server.status = "error";
          server.reconnectInfo = undefined;
        }
        return;
      }

      if (err.type === "connect" || errText.includes("Ping timeout")) {
        this.scheduleReconnect(serverId);
      }
    });

    // Anything from the server shows the connection worked until now. See missed.ts.
    client.on("raw", (msg) => {
      if (isStale()) return;
      const ctrl = this.getControl(serverId);
      ctrl.lastHeardAt = Date.now();
      // For the Log's Sync marker. Lines inside a batch don't come here: the batch
      // plugin keeps them.
      const time = this.logRecorder && tagsOf(msg)?.time;
      if (time) {
        const ms = Date.parse(time);
        // A time far ahead of honk's clock is a broken server clock: not the newest.
        if (ms > (ctrl.newestServerTime ?? 0) && !tooFarAhead(ms, Date.now())) {
          ctrl.newestServerTime = ms;
        }
      }
    });

    // The PONG for a PING sent after your line: the line reached the server.
    client.on("pong", (msg) => {
      if (isStale()) return;
      this.delivery.pong(serverId, msg.params.key ?? msg.params.daemon);
    });

    client.on("connected", () => {
      if (isStale()) return;
      this.pushMessage(
        serverId,
        STATUS_BUFFER,
        makeMessage("system", "Connected. Registering..."),
      );
    });

    client.on("register", (msg) => {
      const server = live();
      if (!server) return;
      const ctrl = this.getControl(serverId);

      if (ctrl.connectTimer) {
        clearTimeout(ctrl.connectTimer);
        ctrl.connectTimer = null;
      }
      ctrl.registered = true;
      ctrl.targetsAsked = false;
      // Each connection starts from the default, whatever an earlier one said: a server
      // that sends no CASEMAPPING uses rfc1459. The 005 lines that follow may change it.
      server.casemapping = DEFAULT_CASEMAPPING;
      this.logRecorder?.registered(serverId);
      const isReconnect = ctrl.hasEverConnected;
      ctrl.hasEverConnected = true;
      this.readMarkerTracker.onConnected(serverId);
      ctrl.markReadFailShown = false;
      ctrl.nickCollisionTries = 0;

      // Only reset backoff after staying registered stably for STABLE_RESET_MS
      if (ctrl.stableTimer) clearTimeout(ctrl.stableTimer);
      ctrl.stableTimer = setTimeout(() => {
        ctrl.stableTimer = null;
        if (this.clients.get(serverId) === client && ctrl.registered) {
          ctrl.attempts = 0;
        }
      }, STABLE_RESET_MS);

      server.status = "connected";
      server.reconnectInfo = undefined;
      server.nick = msg.params.nick || server.nick;
      this.pushMessage(
        serverId,
        STATUS_BUFFER,
        makeMessage("system", `Registered as ${server.nick}.`),
      );
      // Channels show "You joined" when the server re-joins them; DMs get a line here.
      if (isReconnect) {
        for (const name of server.bufferOrder) {
          if (server.buffers[name]?.kind === "dm") {
            this.pushMessage(serverId, name, makeMessage("system", "Reconnected."));
          }
        }
      }
    });

    client.on("batch_end", (batch) => {
      if (!TARGETS_BATCH_TYPES.has(batch.params.type) || !live()) return;
      this.loadMissedDms(serverId, client, batch.params.messages);
    });

    client.on("isupport:network", (msg) => {
      const server = live();
      const net = msg.params.value?.trim();
      if (!server || !net) return;
      server.networkName = net;
      server.name = net;
      this.logRecorder?.setNetwork(serverId, { display: net });
      this.emit();
    });

    // soju's id for the network behind this connection. Part of the Log's key for the
    // Network (ADR 0002). Same event shape as isupport:network.
    client.on("isupport:bouncer_netid" as "isupport:network", (msg) => {
      if (!live()) return;
      this.logRecorder?.setNetwork(serverId, { bouncerNetId: msg.params.value?.trim() ?? "" });
    });

    // Which names the server sees as the same (see nameKey). 005 comes right after 001,
    // before any JOIN or message. "register" set the default first.
    // irc-client-ts emits "isupport:<key>" for every token, but its types list only a
    // few keys. The event is the same shape as isupport:network.
    client.on("isupport:casemapping" as "isupport:network", (msg) => {
      const server = live();
      if (!server) return;
      server.casemapping = parseCasemapping(msg.params.value);
      this.logRecorder?.setNetwork(serverId, { casemapping: server.casemapping });
      this.settleCasemapping(serverId);
      this.emit();
    });
    // A server has sent all its 005 lines by the end of the MOTD. Without CASEMAPPING the
    // default stands, and the Log knows the Network (and its Sync marker) by then.
    for (const end of ["raw:rpl_endofmotd", "raw:err_nomotd"] as const) {
      client.on(end, () => {
        if (!live()) return;
        this.settleCasemapping(serverId);
        this.askMissedDms(serverId, client);
      });
    }

    client.on("disconnected", () => {
      const server = live();
      if (!server) return;
      const ctrl = this.getControl(serverId);

      this.noteConnectionLost(serverId, ctrl);
      ctrl.registered = false;
      this.forgetPendingRequests(serverId);
      this.failPendingLines(serverId);
      if (ctrl.stableTimer) {
        clearTimeout(ctrl.stableTimer);
        ctrl.stableTimer = null;
      }

      if (ctrl.manualDisconnect || ctrl.fatalError) {
        if (server.status !== "disconnected" && !ctrl.fatalError) {
          server.status = "disconnected";
          server.reconnectInfo = undefined;
          this.emit();
        }
        return;
      }

      this.pushMessage(
        serverId,
        STATUS_BUFFER,
        makeMessage("system", "Connection lost."),
      );
      this.noteOffline(serverId, "Connection lost. Reconnecting...");
      this.scheduleReconnect(serverId);
    });

    client.on("motd_reply", (msg) => {
      if (isStale()) return;
      for (const line of msg.params.motd ?? []) {
        if (line.trim()) {
          this.pushMessage(serverId, STATUS_BUFFER, makeMessage("system", line));
        }
      }
    });

    client.on("error_reply", (msg) => {
      if (isStale()) return;
      // The first param is your own nick.
      this.onNumeric(serverId, msg.command, msg.params.args.slice(1), msg.params.text ?? "");
    });

    client.on("join", (msg) => {
      const server = live();
      if (!server) return;
      const channel = msg.params.channel;
      const who = normalizeNick(msg.source?.name);
      const buf = this.ensureBuffer(serverId, channel, "channel");
      this.logRecorder?.event(serverId, channel, msg, { kind: "join", nick: who, text: "" });
      if (this.same(serverId, who, server.nick)) {
        // Switch for a /join, or from this server's *status (auto-join at startup).
        // Auto-joins and reconnect re-joins never take focus from another buffer.
        const requested = this.takeRequestedJoin(serverId, channel);
        if (
          requested ||
          (this.active?.serverId === serverId && this.active.buffer === STATUS_BUFFER)
        ) {
          this.setActive(serverId, channel);
        }
        this.pushMessage(
          serverId,
          channel,
          makeMessage("join", `You joined ${channel}`),
        );
        // Ask for the latest History. The Sync marker is for the whole Network: when the
        // Buffer has Lines from the Log, the Log holds this channel up to the marker, so
        // ask only for the newer ones. A channel the Log never held gets the latest 50.
        // (/join opens the Buffer before the server's JOIN, so being open says nothing.)
        if (client.state.caps.enabled.has("draft/chathistory")) {
          const held = buf?.messages.some((m) => m.logId !== undefined) === true;
          const since = held ? this.logRecorder?.historySince(serverId) : undefined;
          requestHistory(client, "LATEST", channel, since === undefined ? "*" : timestampParam(since), LATEST_LIMIT);
          this.logRecorder?.askedLatest(serverId, channel);
        }
      } else {
        this.pushMessage(
          serverId,
          channel,
          makeMessage("join", joinText(who, channel)),
        );
      }
    });

    client.on("part", (msg) => {
      const server = live();
      if (!server) return;
      const channel = msg.params.channel;
      const who = normalizeNick(msg.source?.name);
      this.logRecorder?.event(serverId, channel, msg, { kind: "part", nick: who, text: msg.params.comment ?? "" });
      if (this.same(serverId, who, server.nick)) {
        this.removeBuffer(serverId, channel);
      } else {
        this.pushMessage(
          serverId,
          channel,
          makeMessage("part", partText(who, channel, msg.params.comment)),
        );
      }
    });

    client.on("quit", (msg) => {
      const server = live();
      if (!server) return;
      const who = normalizeNick(msg.source?.name);
      for (const bufName of priorChannels.get(msg) ?? channelsWithNick(server, who)) {
        this.pushMessage(serverId, bufName, makeMessage("part", quitText(who, msg.params.comment)));
        this.logRecorder?.event(serverId, bufName, msg, { kind: "quit", nick: who, text: msg.params.comment ?? "" });
      }
    });

    client.on("kick", (msg) => {
      const server = live();
      if (!server) return;
      const { channel, nick, comment } = msg.params;
      const by = normalizeNick(msg.source?.name) || "someone";
      const reason = comment ? ` (${comment})` : "";
      this.logRecorder?.event(serverId, channel, msg, { kind: "kick", nick: by, subject: nick, text: comment ?? "" });
      if (this.same(serverId, nick, server.nick)) {
        // The channel's buffer goes away, so say why in *status, where the view lands.
        this.removeBuffer(serverId, channel);
        this.pushMessage(
          serverId,
          STATUS_BUFFER,
          makeMessage("error", `You were kicked from ${channel} by ${by}${reason}`),
        );
        return;
      }
      this.pushMessage(
        serverId,
        channel,
        makeMessage("error", kickText(nick, by, comment)),
      );
    });

    client.on("nick", (msg) => {
      const server = live();
      if (!server) return;
      const oldNick = normalizeNick(msg.source?.name);
      const newNick = msg.params.nick;
      if (this.same(serverId, oldNick, server.nick)) {
        server.nick = newNick;
        this.pushMessage(
          serverId,
          STATUS_BUFFER,
          makeMessage("system", `You are now known as ${newNick}`),
        );
        return;
      }
      const line = nickText(oldNick, newNick);
      const event = { kind: "nick", nick: oldNick, subject: newNick, text: "" } as const;
      for (const bufName of priorChannels.get(msg) ?? channelsWithNick(server, oldNick)) {
        this.pushMessage(serverId, bufName, makeMessage("system", line));
        this.logRecorder?.event(serverId, bufName, msg, event);
      }
      // An open DM follows the person to the new nick. If a DM with the new nick is
      // already open, the old one is merged into it, so one person has one DM.
      if (this.hasBuffer(serverId, oldNick)) {
        if (this.hasBuffer(serverId, newNick) && !this.same(serverId, oldNick, newNick)) {
          this.mergeBuffer(serverId, oldNick, newNick);
        } else {
          this.renameBuffer(serverId, oldNick, newNick);
        }
        this.pushMessage(serverId, newNick, makeMessage("system", line));
        this.logRecorder?.event(serverId, newNick, msg, event);
      }
    });

    client.on("topic_reply", (msg) => {
      if (isStale()) return;
      const buf = this.ensureBuffer(serverId, msg.params.channel, "channel");
      if (!buf) return;
      const nextTopic = msg.params.topic ?? "";
      const changed = buf.topic !== nextTopic;
      buf.topic = nextTopic;
      if (nextTopic && changed) {
        this.pushMessage(
          serverId,
          msg.params.channel,
          makeMessage("system", `Topic: ${nextTopic}`),
        );
      } else {
        this.emit();
      }
    });

    client.on("topic", (msg) => {
      if (isStale()) return;
      const buf = this.ensureBuffer(serverId, msg.params.channel, "channel");
      if (!buf) return;
      const who = msg.source?.name ?? "someone";
      buf.topic = msg.params.topic ?? "";
      this.logRecorder?.event(serverId, msg.params.channel, msg, { kind: "topic", nick: normalizeNick(msg.source?.name) || who, text: buf.topic });
      this.pushMessage(
        serverId,
        msg.params.channel,
        makeMessage(
          "system",
          topicText(who, buf.topic),
        ),
      );
    });

    client.on("nicklist", (msg) => {
      if (isStale()) return;
      const buf = this.ensureBuffer(serverId, msg.params.channel, "channel");
      if (!buf) return;
      // The plugin builds a fresh array on every change, so no copy is needed.
      buf.users = msg.params.nicklist;
      this.emit();
    });

    client.on("batch_end", (batch) => {
      if (batch.params.type !== "chathistory") return;
      const server = live();
      if (!server) return;

      const batchTarget = batch.params.params[0];
      // The label is on this BATCH line, or on a labeled-response batch around it.
      const parentRef = batch.params.tags?.batch;
      const label =
        batch.params.tags?.label ?? (parentRef && client.state.batches.get(parentRef)?.tags?.label);
      const ctrl = this.getControl(serverId);
      const request = batchTarget
        ? takeHistoryRequest(ctrl.historyRequests, label, this.key(serverId, batchTarget))
        : undefined;
      // A request of the Log's own (a fill) goes to the screen too: the screen shows the
      // Log's Lines, so a gap the fill closes in the Log must close on screen. See logSync.ts.
      const logHistory = this.logRecorder?.history(serverId, batchTarget ?? "", request?.fill);
      // Whether the screen got a Line it did not have, and how many Lines came. A /history
      // asks from the time of the oldest Line on screen, so it may bring only Replays.
      let anyNew = false;
      let lines = 0;
      // The Replay counts of this batch, per buffer. See replay.ts.
      const batchReplays = new Map<string, HistoryBatch>();
      for (const raw of batch.params.messages) {
        const cmd = raw.command;
        // Events and topics (draft/event-playback) go to the Log only. See logRecorder.ts.
        if (cmd !== "privmsg" && cmd !== "notice") {
          logHistory?.event(raw);
          continue;
        }

        lines++;
        const from = normalizeNick(raw.source?.name) || UNKNOWN_SENDER;
        const rawText = raw.params[1] ?? "";
        const isSelf = this.same(serverId, from, server.nick);
        const target =
          batchTarget ||
          routeTarget(raw.params[0] ?? STATUS_BUFFER, from, isSelf);

        // Detect CTCP ACTION (\x01ACTION text\x01)
        const actionMatch = /^\x01ACTION ([\s\S]*?)\x01?$/.exec(rawText);
        const msgKind =
          cmd === "notice" ? "notice" : actionMatch ? "action" : "message";
        const text = actionMatch ? actionMatch[1]! : rawText;
        const bufferKey = this.bufferKey(serverId, target);
        let replays = batchReplays.get(bufferKey);
        if (!replays) batchReplays.set(bufferKey, (replays = new HistoryBatch()));

        const isNew = this.pushMessage(
          serverId,
          target,
          makeMessage(msgKind, text, {
            from,
            msgid: raw.tags?.msgid,
            ...lineTime(raw.tags),
            isSelf,
            isHistory: true,
          }),
          replays,
          request?.history?.beforeLineId,
        );
        anyNew ||= isNew;
        // After the screen: a Buffer this opens loads the Log, and must not find this
        // Line there already, or the screen drops it as a Replay without its badge.
        logHistory?.add(target, { kind: msgKind, from, text, tags: raw.tags, self: isSelf });
      }
      // A /history that found nothing older says so, instead of nothing happening. A full
      // batch of Replays may have more behind it, so it does not say so.
      const history = request?.history;
      if (history && batchTarget && !anyNew && lines < history.asked) {
        this.pushMessage(
          serverId,
          batchTarget,
          makeMessage("system", `The server has no older messages in ${batchTarget}.`),
        );
      }
      // Asks for the History the Log misses, if any. See logSync.ts.
      logHistory?.end(batch.params.messages.length);
    });

    const isHistoryBatch = (tags?: Record<string, string | undefined>): boolean => {
      const ref = tags?.batch;
      if (!ref) return false;
      const batch = client.state.batches.get(ref);
      return batch?.type === "chathistory";
    };

    const onChat = (
      kind: "message" | "action",
      msg: {
        source?: { name?: string };
        params: { target: string; text: string };
        tags?: Record<string, string | undefined>;
      },
    ) => {
      const server = live();
      if (!server) return;
      const tags = msg.tags ?? chatTags.get(msg);
      const from = normalizeNick(msg.source?.name) || UNKNOWN_SENDER;
      const isSelf = this.same(serverId, from, server.nick);
      const target = routeTarget(msg.params.target, from, isSelf);
      // A DM opened as "/msg dave" takes the sender's real casing ("Dave") when they write.
      if (!isSelf && !isChannelName(target)) this.renameBuffer(serverId, target, target);
      const isHistory = isHistoryBatch(tags);
      // Someone who writes is back, so their next "is away" shows again, even with the same text.
      if (!isSelf && !isHistory) this.forgetAwayShown(serverId, from);
      const isMention = !isSelf && !isHistory && this.isMentionIn(serverId, target, msg.params.text);

      // The echo of a line you sent here takes over the line already shown, so it
      // shows once, with the server's text and msgid. Only the first part of a split
      // line does; the other parts are new lines, as everyone else sees them.
      if (isSelf && !isHistory) {
        const echo = { kind, text: msg.params.text };
        const shownId = this.echoes.take(serverId, this.key(serverId, target), echo);
        if (shownId) {
          this.applyEcho(serverId, target, shownId, msg.params.text, tags?.msgid, lineTime(tags));
          return;
        }
      }

      this.pushMessage(
        serverId,
        target,
        makeMessage(kind, msg.params.text, {
          from,
          msgid: tags?.msgid,
          ...lineTime(tags),
          isMention,
          isSelf,
          isHistory,
        }),
      );
      // History reaches the Log through the batch_end handler.
      if (!isHistory) {
        this.logRecorder?.chat(serverId, target, {
          kind,
          from,
          text: msg.params.text,
          tags,
          self: isSelf,
        });
      }
    };

    client.on("privmsg", (msg) => onChat("message", msg));
    client.on("ctcp_action", (msg) => onChat("action", msg));

    // With echo-message, the library reports our own lines (typed here, or sent from
    // another client on the same bouncer account) as echo:* instead of privmsg/notice.
    // onChat merges the echo of a line this client already showed. See echo.ts.
    client.on("echo:privmsg", (msg) => onChat("message", msg));

    const onNotice = (msg: {
      source?: { name?: string };
      params: { target: string; text: string };
      tags?: Record<string, string | undefined>;
    }) => {
      if (isStale()) return;
      const tags = msg.tags ?? chatTags.get(msg);
      const from = normalizeNick(msg.source?.name) || "server";
      const target = isChannelName(msg.params.target)
        ? msg.params.target
        : STATUS_BUFFER;
      const isHistory = isHistoryBatch(tags);
      const self = this.same(serverId, from, this.servers.get(serverId)?.nick);
      const logTarget = this.noticeLogTarget(serverId, msg.params.target, from, self);
      this.pushMessage(
        serverId,
        target,
        makeMessage("notice", msg.params.text, {
          from,
          msgid: tags?.msgid,
          ...lineTime(tags),
          isHistory,
        }),
      );
      // After the screen: a Buffer the notice opens loads the Log, which must not have it yet.
      if (!isHistory && logTarget) {
        this.logRecorder?.chat(serverId, logTarget, {
          kind: "notice",
          from,
          text: msg.params.text,
          tags,
          self,
        });
      }
    };
    client.on("notice", onNotice);
    client.on("echo:notice", onNotice);

    client.on("whois_reply", (msg) => {
      if (isStale()) return;
      const target = this.replyTarget(serverId);
      for (const line of whoisLines(msg.params)) {
        this.pushMessage(serverId, target, makeMessage("system", line));
      }
    });

    // A WHOIS reply runs from 311 to 318. Its "is away" (301) goes in the WHOIS lines,
    // not on its own. Tracked by the reply itself, so a /raw WHOIS works the same.
    client.on("raw:rpl_whoisuser", (msg) => {
      if (isStale()) return;
      const nick = msg.params[1];
      if (nick) this.getControl(serverId).pendingWhois.add(this.key(serverId, nick));
    });
    client.on("raw:rpl_endofwhois", (msg) => {
      if (isStale()) return;
      const nick = msg.params[1];
      if (nick) this.getControl(serverId).pendingWhois.delete(this.key(serverId, nick));
    });

    // "alice is away": the server answers a message to someone who is away. It says so
    // on every message, so a DM shows it only when the away text changes.
    client.on("raw:rpl_away", (msg) => {
      if (isStale()) return;
      const [, nick, away] = msg.params;
      if (!nick) return;
      const ctrl = this.getControl(serverId);
      const key = this.key(serverId, nick);
      if (ctrl.pendingWhois.has(key)) return;
      const where = this.hasBuffer(serverId, nick) ? nick : this.replyTarget(serverId);
      const text = away ?? "";
      let shown = ctrl.awayShown.get(key);
      if (!shown) ctrl.awayShown.set(key, (shown = new Map()));
      const whereKey = this.key(serverId, where);
      if (shown.get(whereKey) === text) return;
      shown.set(whereKey, text);
      this.pushMessage(
        serverId,
        where,
        makeMessage("system", text ? `${nick} is away: ${text}` : `${nick} is away.`),
      );
    });

    // 900: the SASL login worked. Worth saying, since a wrong password stops honk.
    client.on("raw:rpl_loggedin", (msg) => {
      if (isStale()) return;
      const account = msg.params[2];
      if (!account) return;
      this.pushMessage(
        serverId,
        STATUS_BUFFER,
        makeMessage("system", `Logged in to the account ${account}.`),
      );
    });

    client.on("invite", (msg) => {
      if (isStale()) return;
      const by = normalizeNick(msg.source?.name) || "Someone";
      const channel = msg.params.channel;
      this.pushMessage(
        serverId,
        this.replyTarget(serverId),
        makeMessage("system", `${by} invited you to ${channel}. Type /join ${channel} to accept.`),
      );
    });

    // IRCv3 FAIL, an error. This reads the raw line, not the "fail" event, because only
    // the raw line has tags. A failed CHATHISTORY sends no batch, so its /history request
    // waits for nothing. Its label, or without one the target it names, picks the request,
    // so the error goes to the buffer where /history was typed, not the one you switched
    // to since. The history honk fetches on join has no request, so its error goes to the
    // target's buffer. When that buffer is closed, the error goes to the reply target like
    // other errors. honk sends MARKREAD on its own, not because of something you typed,
    // so its FAIL goes to *status, once per connection.
    //   FAIL <command> <code> [<context>...] :<description>
    client.on("raw:fail", (msg) => {
      if (isStale()) return;
      const command = msg.params[0] ?? "";
      const description = msg.params.length > 2 ? (msg.params.at(-1) ?? "") : "";
      const ctrl = this.getControl(serverId);
      let where = this.replyTarget(serverId);
      if (command.toUpperCase() === "MARKREAD") {
        if (ctrl.markReadFailShown) return;
        ctrl.markReadFailShown = true;
        where = STATUS_BUFFER;
      } else if (command.toUpperCase() === "CHATHISTORY") {
        const label = msg.tags?.label;
        const target = historyFailTarget(
          msg.params.slice(2, -1),
          (name) =>
            name !== STATUS_BUFFER &&
            (this.hasBuffer(serverId, name) ||
              ctrl.historyRequests.some(
                (r) => r.target === this.key(serverId, name),
              )),
        );
        const failed = takeFailedHistoryRequest(
          ctrl.historyRequests,
          label,
          target === undefined ? undefined : this.key(serverId, target),
        );
        const buffer = failed?.target ?? target;
        if (msg.params[2]?.toUpperCase() === "TARGETS") {
          // No list comes. The DMs open on screen still ask.
          this.loadMissedDms(serverId, client, []);
        } else if (buffer !== undefined && (!failed || failed.fill)) {
          // Not a /history you typed: the Log stops waiting for this History.
          this.logRecorder?.historyFailed(serverId, buffer);
        }
        if (buffer !== undefined && this.hasBuffer(serverId, buffer)) where = buffer;
      }
      this.pushMessage(
        serverId,
        where,
        makeMessage("error", describeStandardReply(command, description)),
      );
    });

    // Your read marker for a buffer, from the server. Not in onRawLine: that sees a whole
    // network read first, so a MARKREAD would land before a PRIVMSG it covers in the same
    // read. The event exists only through patches/irc-client-ts@0.23.1.patch. Like any raw
    // event it skips lines inside a batch (#44); honk labels nothing a MARKREAD answers.
    client.on("raw:markread" as never, (msg: { params: string[] }) => {
      if (isStale()) return;
      const mark = parseMarkRead(msg.params);
      if (mark) this.onReadMarker(serverId, mark.target, mark.time);
    });

    // IRCv3 WARN and NOTE, information.
    for (const kind of ["warn", "note"] as const) {
      client.on(kind, (msg) => {
        if (isStale()) return;
        this.pushMessage(
          serverId,
          this.replyTarget(serverId),
          makeMessage("system", describeStandardReply(msg.params.command, msg.params.description)),
        );
      });
    }
  }

  /**
   * Tells every open channel and DM that the connection is gone, and empties the user
   * lists, which are stale until the server re-joins (and sends NAMES again).
   */
  /**
   * Sends one of your lines, shows it as "sending", and starts confirming it with a
   * PING (see delivery.ts). With echo-message, its echo is awaited (see echo.ts).
   */
  private pushSent(
    serverId: string,
    client: Client,
    target: string,
    kind: "message" | "action",
    text: string,
  ): void {
    const parts: SentPart[] = [];
    this.outgoing = parts;
    try {
      if (kind === "action") client.action(target, text);
      else client.privmsg(target, text);
    } finally {
      this.outgoing = null;
    }
    const nick = this.servers.get(serverId)?.nick;
    const message = makeMessage(kind, text, { from: nick, isSelf: true });
    message.delivery = "pending";
    this.pushMessage(serverId, target, message);
    const bufferName = this.bufferKey(serverId, target);
    // With echo-message the server sends the line back. A line to yourself comes back
    // even without it; a second copy of it is dropped by msgid in pushMessage.
    const echoed =
      client.state.caps.enabled.has("echo-message") || this.same(serverId, target, nick);
    const line: SentLine = { bufferName, messageId: message.id, echoed };
    this.delivery.track(serverId, line, (token) => void client.send("PING", token));
    if (echoed) this.echoes.add(serverId, this.key(serverId, bufferName), message.id, parts);
  }

  /**
   * The echo of a line you sent: the line shows the text the server has (trimmed, or
   * the first part of a split line) and gets its msgid and time, so history doesn't add
   * it again. With the server's time it also moves to its place in time order: History
   * is matched by the server's time (see replay.ts), and honk's clock can be off.
   */
  private applyEcho(
    serverId: string,
    target: string,
    messageId: string,
    text: string,
    msgid: string | undefined,
    time: ReturnType<typeof lineTime>,
  ): void {
    const bufferName = this.bufferKey(serverId, target);
    this.updateMessages(serverId, bufferName, new Set([messageId]), (m) => ({
      ...m,
      text,
      ...(msgid ? { msgid } : {}),
      ...(time.timeFromServer ? time : {}),
    }));
    if (time.timeFromServer) this.moveToTimeOrder(serverId, bufferName, messageId);
    this.logRecorder?.echoed(serverId, bufferName, messageId);
    this.emit();
  }

  /** Moves your line whose Echo set its time to its place among other lines. See placeOwnLine. */
  private moveToTimeOrder(serverId: string, bufferName: string, messageId: string): void {
    const server = this.servers.get(serverId);
    const buf = server?.buffers[bufferName];
    if (!server || !buf) return;
    const messages = [...buf.messages];
    if (!placeOwnLine(messages, messageId)) return;
    server.buffers = { ...server.buffers, [bufferName]: { ...buf, messages } };
  }

  /** Sets the delivery state of sent lines. `undefined` means the server has them. */
  private setDelivery(
    serverId: string,
    lines: SentLine[],
    state: ChatMessage["delivery"],
  ): void {
    const server = this.servers.get(serverId);
    if (!server || lines.length === 0) return;
    const idsByBuffer = new Map<string, Set<string>>();
    for (const l of lines) {
      const ids = idsByBuffer.get(l.bufferName) ?? new Set<string>();
      ids.add(l.messageId);
      idsByBuffer.set(l.bufferName, ids);
    }
    for (const [name, ids] of idsByBuffer) {
      this.updateMessages(serverId, name, ids, (m) => {
        const { delivery: _, ...rest } = m;
        return state ? { ...rest, delivery: state } : rest;
      });
    }
    this.emit();
  }

  /** Replaces the messages with these ids in one buffer by `update(message)`. */
  private updateMessages(
    serverId: string,
    bufferName: string,
    ids: Set<string>,
    update: (m: ChatMessage) => ChatMessage,
  ): void {
    const server = this.servers.get(serverId);
    const buf = server?.buffers[bufferName];
    if (!server || !buf) return;
    const messages = buf.messages.map((m) => (ids.has(m.id) ? update(m) : m));
    server.buffers = { ...server.buffers, [bufferName]: { ...buf, messages } };
  }

  /** Lines still waiting for their PONG when the connection closes may not have arrived. */
  private failPendingLines(serverId: string): void {
    this.echoes.drop(serverId);
    const lines = this.delivery.drop(serverId);
    this.setDelivery(serverId, lines, "failed");
  }

  /** No PONG in time: the connection is dead even though the socket looks open. */
  private deliveryTimedOut(serverId: string, lines: SentLine[]): void {
    this.setDelivery(serverId, lines, "failed");
    const client = this.clients.get(serverId);
    const server = this.servers.get(serverId);
    if (!client || server?.status !== "connected") return;
    this.pushMessage(
      serverId,
      STATUS_BUFFER,
      makeMessage(
        "error",
        `No reply from the server in ${DELIVERY_TIMEOUT_MS / 1000}s. The connection looks dead.`,
      ),
    );
    // The "disconnected" handler notes the loss and schedules the reconnect. Schedule it
    // here too, in case a dead socket never reports "disconnected".
    safeDisconnect(client);
    this.scheduleReconnect(serverId);
  }

  private noteOffline(serverId: string, text: string): void {
    const server = this.servers.get(serverId);
    if (!server) return;
    for (const name of server.bufferOrder) {
      const buf = server.buffers[name];
      if (!buf || buf.kind === "status") continue;
      if (buf.users.length > 0) {
        server.buffers = { ...server.buffers, [name]: { ...buf, users: [] } };
      }
      this.pushMessage(serverId, name, makeMessage("system", text));
    }
  }

  /** The host, port and TLS setting a server connects with. TLS is on unless the config turns it off. */
  private endpoint(serverId: string): Endpoint & { tls: boolean } {
    const cfg = this.servers.get(serverId)?.config;
    const tls = cfg?.tls ?? true;
    return { host: cfg?.host || serverId, port: cfg?.port ?? (tls ? 6697 : 6667), tls };
  }

  /** Why a command or a message can't go out now, and what to do about it. */
  private notConnectedText(server: ServerState | undefined): string {
    if (!server?.config.host) {
      return "Not connected. Connect with /connect <host> [port] [nick].";
    }
    switch (server.status) {
      case "connecting":
        return `Still connecting to ${server.name}. Wait a moment and try again.`;
      case "reconnecting":
        return `Reconnecting to ${server.name}. Wait a moment, or type /connect to retry now.`;
      default:
        return `Not connected to ${server.name}. Type /connect to reconnect.`;
    }
  }

  /**
   * Shows a numeric reply in plain words (see replies.ts), as an error or, for one that
   * reports something that worked, as a normal line. It goes to the buffer it is
   * about (the channel or DM it names) when that is open, else where you are. A JOIN you
   * asked for on another server (from the omnibox) also shows where you are.
   */
  private showNumericReply(serverId: string, name: string, subject: string[], text: string): void {
    // The bookkeeping runs even for an error that shows nothing.
    const requested =
      isErrorKind(name, "join") && subject[0] ? this.takeRequestedJoin(serverId, subject[0]) : false;
    // A message the server refused: mark that line "not sent" instead of letting the
    // next PONG mark it delivered.
    if (isErrorKind(name, "message") && subject[0]) {
      const refused = this.delivery.reject(serverId, subject[0], this.casemapping(serverId));
      if (refused) {
        this.setDelivery(serverId, [refused], "failed");
        this.echoes.forget(serverId, refused.messageId);
      }
    }
    const described = describeErrorReply(name, subject, text);
    if (described === null) return;
    const about = isErrorKind(name, "nick")
      ? undefined
      : subject.find((word) => word !== STATUS_BUFFER && this.hasBuffer(serverId, word));
    const kind = replyKind(name);
    this.pushMessage(serverId, about ?? this.replyTarget(serverId), makeMessage(kind, described));
    if (requested) this.showInActiveFrom(serverId, kind, described);
  }

  /**
   * Also shows a line from another server where you are, with that server's name in
   * front ("beta: Can't join #x..."). Nothing happens if you are on that server.
   */
  private showInActiveFrom(serverId: string, kind: MessageKind, text: string): void {
    if (!this.active || this.active.serverId === serverId) return;
    const name = this.servers.get(serverId)?.name ?? serverId;
    this.pushMessage(this.active.serverId, this.active.buffer, makeMessage(kind, `${name}: ${text}`));
  }

  /**
   * A raw line from the server, before irc-client-ts parses it. Handled here: numerics
   * the library doesn't know, because it drops their number (see replies.ts).
   */
  private onRawLine(serverId: string, line: string): void {
    // Every line passes here, so look at the command before parsing the whole line.
    const command = commandOf(line);
    if (command === "REDACT") {
      this.logRecorder?.redact(serverId, line);
      return;
    }
    const name = NUMERICS_MISSING_FROM_LIBRARY[command];
    if (!name) return;
    const { params } = parseLine(line);
    // ":srv 470 goose #old #new :Forwarding": your nick first, the text last.
    this.onNumeric(serverId, name, params.slice(1, -1), params.at(-1) ?? "");
  }

  /**
   * A numeric reply by name, from either irc-client-ts ("error_reply") or onRawLine.
   * `subject` is the words between your nick and the text.
   */
  private onNumeric(serverId: string, name: string, subject: string[], text: string): void {
    const server = this.servers.get(serverId);
    const ctrl = this.getControl(serverId);
    const client = this.clients.get(serverId);

    // At login, a nick that is taken (433) or held by the network (437) is retried
    // with "_" added, up to 3 times.
    if (
      NICK_RETRY_ERRORS.has(name) &&
      !ctrl.registered &&
      server &&
      client &&
      ctrl.nickCollisionTries < 3
    ) {
      ctrl.nickCollisionTries += 1;
      const fallback = `${server.config.nick}${"_".repeat(ctrl.nickCollisionTries)}`;
      server.nick = fallback;
      this.pushMessage(
        serverId,
        STATUS_BUFFER,
        makeMessage("system", `Nick ${subject[0] ?? ""} is not available, trying ${fallback}...`),
      );
      client.nick(fallback);
      return;
    }

    if (name === "err_linkchannel") {
      // "#old is forwarded to #new": the JOIN for #new follows. If you asked for #old,
      // treat it as a request for #new, so the view moves there.
      const [from = "", to = ""] = subject;
      if (to && this.takeRequestedJoin(serverId, from)) {
        this.noteRequestedJoin(serverId, to);
      }
      this.pushMessage(
        serverId,
        this.replyTarget(serverId),
        makeMessage("system", `${from} forwards to ${to}, so you are joining ${to} instead.`),
      );
      return;
    }
    this.showNumericReply(serverId, name, subject, text);
  }

  /** Where replies to a command (errors, WHOIS) go: the active buffer if it is on this server. */
  private replyTarget(serverId: string): string {
    return this.active?.serverId === serverId ? this.active.buffer : STATUS_BUFFER;
  }

  private ensureBuffer(
    serverId: string,
    name: string,
    kind: BufferKind = bufferKindFor(name),
  ): BufferState | null {
    const server = this.servers.get(serverId);
    if (!server) return null;
    const existing = server.buffers[this.bufferKey(serverId, name)];
    if (existing) return existing;

    const buf = createBuffer(name, kind);
    // A new Buffer starts with its last Lines from the Log, from before this run.
    if (this.log && kind !== "status") {
      buf.messages = storedMessages(name, this.log.scrollback(serverId, name));
    }
    server.buffers = { ...server.buffers, [name]: buf };
    server.bufferOrder = sortBufferOrder(server, [...server.bufferOrder, name]);
    return buf;
  }

  /**
   * Up to `limit` Lines from the Log before the first of `messages`. A Line that did
   * not come from the Log (live, or History) has no row id, so the page includes the
   * Lines of its time, and the ones `messages` has already are dropped as Replays:
   *
   *   screen: z (live, 21:35:07)     Log: x, y, z (21:35:07)     -> x, y
   */
  private olderFromLog(
    serverId: string,
    name: string,
    messages: ChatMessage[],
    limit: number,
  ): ChatMessage[] {
    const oldest = messages[0]!;
    const time = oldest.timestamp.getTime();
    const before = { time, id: oldest.logId ?? Number.MAX_SAFE_INTEGER };
    const older = storedMessages(name, this.log!.scrollback(serverId, name, before, limit));
    if (oldest.logId !== undefined) return older;
    // Only Lines near that time can match. They are the first ones.
    const end = messages.findIndex((m) => m.timestamp.getTime() > time + LOCAL_CLOCK_WINDOW_MS);
    const kept = end === -1 ? messages : messages.slice(0, end);
    const batch = new HistoryBatch();
    return older.filter(
      (m) => checkReplay(kept, { ...m, isHistory: true }, batch).type === "new",
    );
  }

  /**
   * Loads up to SCROLLBACK_LINES Lines from the Log that are older than the oldest one
   * Buffer `bufferName` holds, and puts them at its top. Returns how many came. The
   * chat pane calls it when you scroll to the top. A Buffer holds at most
   * MAX_MESSAGES_WITH_HISTORY Lines: the limit is on memory, and the Log keeps the rest.
   */
  loadOlder(serverId: string, bufferName: string): number {
    const server = this.servers.get(serverId);
    const name = this.bufferKey(serverId, bufferName);
    const buf = server?.buffers[name];
    // An empty Buffer was cleared with /clear, or has nothing to scroll.
    const oldest = buf?.messages[0];
    if (!this.log || !server || !buf || !oldest || buf.kind === "status") return 0;
    const room = Math.min(SCROLLBACK_LINES, MAX_MESSAGES_WITH_HISTORY - buf.messages.length);
    if (room <= 0) {
      if (!buf.scrollbackFull) {
        server.buffers = { ...server.buffers, [name]: { ...buf, scrollbackFull: true } };
        this.emit();
      }
      return 0;
    }
    const older = this.olderFromLog(serverId, name, buf.messages, room);
    if (older.length === 0) return 0;
    const messages = [...older, ...buf.messages];
    const messageLimit = Math.max(buf.messageLimit ?? MAX_MESSAGES, messages.length);
    server.buffers = { ...server.buffers, [name]: { ...buf, messages, messageLimit } };
    this.emit();
    return older.length;
  }

  /**
   * The key of the buffer called `name`, ignoring case (IRC nicks and channels are
   * case-insensitive), or `name` itself if there is none yet.
   */
  private bufferKey(serverId: string, name: string): string {
    const server = this.servers.get(serverId);
    if (!server || server.buffers[name]) return name;
    return server.bufferOrder.find((b) => this.same(serverId, b, name)) ?? name;
  }

  private hasBuffer(serverId: string, name: string): boolean {
    const key = this.bufferKey(serverId, name);
    return Boolean(this.servers.get(serverId)?.buffers[key]);
  }

  /** Renames a buffer (a DM after a nick change). Does nothing if `to` already exists. */
  private renameBuffer(serverId: string, from: string, to: string): void {
    const server = this.servers.get(serverId);
    const key = this.bufferKey(serverId, from);
    const buf = server?.buffers[key];
    if (!server || !buf || key === to) return;
    // "*Status" from a bouncer matches "*status" ignoring case; the status buffer keeps its name.
    if (key === STATUS_BUFFER || this.same(serverId, to, STATUS_BUFFER)) return;
    const toKey = this.bufferKey(serverId, to);
    if (toKey !== key && server.buffers[toKey]) return;

    const { [key]: _, ...rest } = server.buffers;
    server.buffers = { ...rest, [to]: { ...buf, name: to } };
    server.bufferOrder = sortBufferOrder(
      server,
      server.bufferOrder.map((b) => (b === key ? to : b)),
    );
    if (this.active?.serverId === serverId && this.active.buffer === key) {
      this.active = { serverId, buffer: to };
    }
    this.emit();
  }

  /** Moves the lines of DM `from` into DM `into` (in time order) and removes `from`. */
  private mergeBuffer(serverId: string, from: string, into: string): void {
    const server = this.servers.get(serverId);
    const fromKey = this.bufferKey(serverId, from);
    const intoKey = this.bufferKey(serverId, into);
    const src = server?.buffers[fromKey];
    const dst = server?.buffers[intoKey];
    if (!server || !src || !dst || fromKey === intoKey) return;
    if (fromKey === STATUS_BUFFER || intoKey === STATUS_BUFFER) return;

    const limit = Math.max(
      src.messageLimit ?? MAX_MESSAGES,
      dst.messageLimit ?? MAX_MESSAGES,
    );
    // Array.prototype.sort is stable, so lines with the same time keep their order.
    const messages = [...src.messages, ...dst.messages].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
    if (messages.length > limit) messages.splice(0, messages.length - limit);
    const unreadIds = new Set([src.firstUnreadId, dst.firstUnreadId]);
    const firstUnreadId = messages.find((m) => unreadIds.has(m.id))?.id;

    const { [fromKey]: _, ...rest } = server.buffers;
    server.buffers = {
      ...rest,
      [intoKey]: {
        ...dst,
        messages,
        messageLimit: limit,
        unread: src.unread + dst.unread,
        hasMention: src.hasMention || dst.hasMention,
        firstUnreadId,
      },
    };
    server.bufferOrder = server.bufferOrder.filter((b) => b !== fromKey);
    if (this.active?.serverId === serverId && this.active.buffer === fromKey) {
      this.active = { serverId, buffer: intoKey };
    }
    this.emit();
  }

  private removeBuffer(serverId: string, bufferName: string): void {
    const server = this.servers.get(serverId);
    const name = this.bufferKey(serverId, bufferName);
    if (!server || name === STATUS_BUFFER) return;
    const { [name]: _, ...rest } = server.buffers;
    server.buffers = rest;
    server.bufferOrder = server.bufferOrder.filter((b) => b !== name);
    if (this.active?.serverId === serverId && this.active.buffer === name) {
      this.active = { serverId, buffer: STATUS_BUFFER };
    }
    this.emit();
  }

  /**
   * Where the Log files a notice: its channel, or the DM with the other person. The
   * screen shows a notice to you in *status; the Log keeps it in the DM with the
   * sender. A notice from the server itself ("irc.libera.chat") stays out.
   */
  private noticeLogTarget(
    serverId: string,
    target: string,
    from: string,
    self: boolean,
  ): string | undefined {
    if (isChannelName(target) || self) return target;
    const toYou = this.same(serverId, target, this.servers.get(serverId)?.nick);
    return toYou && isUserSender(from) ? from : undefined;
  }

  /**
   * True if a line with `text` in `target` is a Mention: it names your nick, or it is
   * in a DM. Your own lines never are; the callers check that.
   */
  private isMentionIn(serverId: string, target: string, text: string): boolean {
    const nick = this.servers.get(serverId)?.nick;
    return (
      !isChannelName(target) ||
      (nick !== undefined && mentionsNick(text, nick, this.casemapping(serverId)))
    );
  }

  /** The LogRecorder for `log`, with what it needs to know about each server. */
  private createLogRecorder(log: Log): LogRecorder {
    return new LogRecorder(log, {
      bufferName: (serverId, name) => this.bufferKey(serverId, name),
      isStatus: (serverId, name) => this.same(serverId, name, STATUS_BUFFER),
      key: (serverId, name) => this.key(serverId, name),
      same: (serverId, a, b) => this.same(serverId, a, b),
      nick: (serverId) => this.servers.get(serverId)?.nick,
      isMentionIn: (serverId, target, text) => this.isMentionIn(serverId, target, text),
      shownLine: (serverId, bufferName, messageId) =>
        this.servers
          .get(serverId)
          ?.buffers[bufferName]?.messages.findLast((m) => m.id === messageId),
      newestServerTime: (serverId) => this.controls.get(serverId)?.newestServerTime,
      hasCap: (serverId, cap) => this.clients.get(serverId)?.state.caps.enabled.has(cap) === true,
      requestFill: (serverId, target, fill) => {
        const client = this.clients.get(serverId);
        if (!client) return;
        const label = historyLabel(client);
        this.getControl(serverId).historyRequests.push({
          target: this.key(serverId, target),
          label,
          fill,
        });
        requestHistory(client, "AFTER", target, timestampParam(fill.after), FILL_LIMIT, label);
      },
      notice: (serverId, text) =>
        this.pushMessage(serverId, STATUS_BUFFER, makeMessage("system", text)),
    });
  }

  /**
   * `batch` is the History batch `message` came in, if any. See replay.ts. A History
   * Line goes before the Line with id `beforeLineId`, if the Buffer still has it.
   * Returns true if the Buffer got the Line.
   */
  private pushMessage(
    serverId: string,
    targetName: string,
    message: ChatMessage,
    batch?: HistoryBatch,
    beforeLineId?: string,
  ): boolean {
    const server = this.servers.get(serverId);
    const bufferName = this.bufferKey(serverId, targetName);
    const buf = this.ensureBuffer(serverId, bufferName);
    if (!server || !buf) return false;

    // A Replay of a line the buffer already has is dropped. See replay.ts.
    const verdict = checkReplay(buf.messages, message, batch);
    if (verdict.type === "replay") return false;
    if (verdict.type === "give-msgid") {
      const { msgid } = verdict;
      this.updateMessages(serverId, bufferName, new Set([verdict.line.id]), (m) => ({ ...m, msgid }));
      this.emit();
      return false;
    }

    // A history line that arrived while the connection was down counts as unread, and
    // as a mention if it is for you. See missed.ts. Not if your read marker is past it:
    // you read it on another client. See readMarker.ts.
    const ctrl = this.controls.get(serverId);
    const marker = this.readMarkerTracker.serverMarker(serverId, bufferName);
    const missed =
      isMissedLine(ctrl?.missed, bufferName, message) && !isMarkedRead(marker, message);
    const mapping = this.casemapping(serverId);
    const mentions = (text: string, nick: string) => mentionsNick(text, nick, mapping);
    if (missed && isMissedMention(ctrl!.missed!, buf.kind, message, server.nick, mentions)) {
      message = { ...message, isMention: true };
    }

    // Live lines go at the end. History lines (CHATHISTORY playback, /history BEFORE)
    // are inserted in time order; the scan from the end replaces a full re-sort.
    // Lines with the same time keep the batch's order: a /history's Lines also go before
    // the Line it was asked before, which is near the top.
    const messages = [...buf.messages];
    let at = messages.length;
    if (message.isHistory) {
      at = timeOrderIndex(messages, message.timestamp.getTime());
      const askedBefore =
        beforeLineId === undefined ? -1 : messages.findIndex((m) => m.id === beforeLineId);
      if (askedBefore >= 0) at = Math.min(at, askedBefore);
    }
    messages.splice(at, 0, message);
    // History lines go in front of older lines, so trimming the oldest would drop them
    // right away. Grow the buffer's limit for them instead.
    let limit = buf.messageLimit ?? MAX_MESSAGES;
    if (message.isHistory && messages.length > limit) {
      limit = Math.min(MAX_MESSAGES_WITH_HISTORY, messages.length);
    }
    if (messages.length > limit) messages.splice(0, messages.length - limit);

    const isActive =
      this.active?.serverId === serverId && this.active.buffer === bufferName;
    // A history line is unread if it is newer than your read marker, or if it came
    // while the connection was down. You see a line in the buffer on screen while you
    // are reading (see ReadMarkerTracker.isReading); it is read at once only if the
    // buffer has no badge. See markedRead.
    const afterMarker = isAfterMarker(marker, message);
    const seen = isActive && this.readMarkerTracker.isReading();
    const readAtOnce = seen && !hasBadge(buf);
    const countsAsUnread =
      !readAtOnce && isReadableLine(message) && (!message.isHistory || afterMarker || missed);
    // History you have not read gets the divider even when you see it come in.
    // History can arrive out of order, so the divider goes on the oldest unread line.
    // The first unread line in a buffer with no badge starts the divider over: the
    // line it was on has been read.
    let movesDivider = countsAsUnread || (isActive && afterMarker && message.isHistory === true);
    if (movesDivider && buf.firstUnreadId && (hasBadge(buf) || !countsAsUnread)) {
      // The divider's line is usually near the end, so look from there.
      const first = messages.findLast((m) => m.id === buf.firstUnreadId);
      movesDivider = first !== undefined && message.timestamp < first.timestamp;
    }
    const hasMention =
      buf.hasMention ||
      (countsAsUnread &&
        (Boolean(message.isMention) ||
          (afterMarker && this.isForYou(serverId, buf.kind, message))));

    server.buffers = {
      ...server.buffers,
      [bufferName]: {
        ...buf,
        messages,
        messageLimit: limit,
        unread: countsAsUnread ? buf.unread + 1 : buf.unread,
        hasMention,
        firstUnreadId: movesDivider ? message.id : buf.firstUnreadId,
      },
    };
    this.emit();
    if (isActive) this.readMarkerTracker.onNewLine();

    if (!message.isMention) return true;
    const event: MentionEvent = {
      serverId,
      bufferName,
      bufferKind: buf.kind,
      kind: message.kind,
      from: message.from ?? "",
      text: message.text,
      seen,
    };
    if (!message.isHistory && !message.isSelf) {
      for (const listener of this.mentionListeners) listener(event);
    } else if (missed) {
      this.queueMissedMention(serverId, event);
    }
    return true;
  }

  /**
   * The server says how far you have read `target`, at connect or because another
   * client of yours moved the marker. A buffer gets its badge and divider from the
   * lines after the marker, unless it is on screen with no badge. See readMarker.ts.
   */
  private onReadMarker(serverId: string, target: string, time: number): void {
    if (!this.readMarkerTracker.onServerMarker(serverId, target, time)) return;

    const server = this.servers.get(serverId);
    const bufferName = this.bufferKey(serverId, target);
    const buf = server?.buffers[bufferName];
    if (!server || !buf) return;
    const isActive = this.active?.serverId === serverId && this.active.buffer === bufferName;
    if (isActive && !hasBadge(buf)) return;
    const state = unreadAfter(buf.messages, time, (m) => this.isForYou(serverId, buf.kind, m));
    if (
      state.unread === buf.unread &&
      state.hasMention === buf.hasMention &&
      state.firstUnreadId === buf.firstUnreadId
    ) {
      return;
    }
    server.buffers = { ...server.buffers, [bufferName]: { ...buf, ...state } };
    this.emit();
  }

  /**
   * True if an unread line is for you: a mention, any DM line, or a line that names
   * you. That is your nick now, or the one you had when the connection dropped ("goose"
   * while you are back as "goose_"), as missed.ts checks.
   */
  private isForYou(serverId: string, kind: BufferKind, message: ChatMessage): boolean {
    if (message.isMention || kind === "dm") return true;
    const nicks = [this.servers.get(serverId)?.nick, this.controls.get(serverId)?.missed?.nick];
    const mapping = this.casemapping(serverId);
    return nicks.some((nick) => nick !== undefined && mentionsNick(message.text, nick, mapping));
  }

  /** Tells honk whether the terminal window has focus. See ReadMarkerTracker.isReading. */
  setFocused(focused: boolean): void {
    this.readMarkerTracker.setFocused(focused);
  }

  /** Tells honk you gave input. See ReadMarkerTracker.isReading for what counts. */
  noteInput(): void {
    this.readMarkerTracker.noteInput();
  }

  /**
   * The time to send as your read marker for a buffer: its newest line from someone
   * else. Undefined when honk can't send MARKREAD for it now. See ReadMarkerTracker.
   */
  private markReadTime(serverId: string, bufferName: string): number | undefined {
    const client = this.clients.get(serverId);
    const ctrl = this.getControl(serverId);
    const buf = this.servers.get(serverId)?.buffers[bufferName];
    if (!client || !ctrl.registered || !buf || buf.kind === "status") return undefined;
    if (!client.state.caps.enabled.has(READ_MARKER_CAP)) return undefined;
    return newestServerTime(buf.messages);
  }

  /**
   * Asks who sent you DMs while the connection was down, or since the Log's Sync marker
   * when honk was closed. Channel history comes with the join; DMs have no join. The
   * reply is handled in the TARGETS batch_end. Once per connection: /motd ends with the
   * same reply.
   */
  private askMissedDms(serverId: string, client: Client): void {
    const ctrl = this.getControl(serverId);
    const server = this.servers.get(serverId);
    if (!server || ctrl.targetsAsked || !client.state.caps.enabled.has("draft/chathistory")) return;
    ctrl.targetsAsked = true;
    const marker = this.logRecorder?.syncMarker(serverId);
    // The first connection of this run: what you missed is what the Log misses. No
    // channel counts as missed, the same as on any start.
    if (!ctrl.missed && marker !== undefined) {
      ctrl.missed = { since: marker, nick: server.nick, buffers: new Set() };
    }
    if (!ctrl.missed) return;
    // From the earlier of the two, so a DM the Log misses is found too.
    const from = Math.min(ctrl.missed.since, marker ?? Infinity) - MISSED_MARGIN_MS;
    void client.send(
      "CHATHISTORY" as never,
      "TARGETS" as never,
      timestampParam(from) as never,
      timestampParam(Date.now()) as never,
      "50" as never,
    );
    this.logRecorder?.askedTargets(serverId);
  }

  /**
   * The reply to TARGETS came (`lines`), or a FAIL (no lines). Loads each DM that wrote
   * to you since the missed window began: the missed-line checks in pushMessage then
   * badge and notify it. See missed.ts.
   */
  private loadMissedDms(
    serverId: string,
    client: Client,
    lines: readonly { command?: string; params: readonly string[] }[],
  ): void {
    const server = this.servers.get(serverId);
    const ctrl = this.controls.get(serverId);
    if (!server || !ctrl?.missed) return;
    const missed = ctrl.missed;
    const nicks = dmTargets(lines, [missed.nick, server.nick], this.casemapping(serverId));
    // The list is a hint, not complete (ircv3-specifications#604), so the DMs open on
    // screen ask too.
    const named = new Set(nicks.map((n) => this.key(serverId, n)));
    for (const name of server.bufferOrder) {
      if (server.buffers[name]?.kind === "dm" && !named.has(this.key(serverId, name))) nicks.push(name);
    }
    const buffers = new Set(missed.buffers);
    for (const nick of nicks) buffers.add(this.bufferKey(serverId, nick));
    ctrl.missed = { ...missed, buffers };
    const since = timestampParam(missed.since - MISSED_MARGIN_MS);
    const markers = client.state.caps.enabled.has(READ_MARKER_CAP);
    for (const nick of nicks) {
      // A DM has no JOIN to bring its marker, so ask for it. The server answers before
      // the history, so a line you read on another client isn't counted as missed.
      if (markers) requestMarkRead(client, nick);
      // The newest Lines, as on a join. The Log asks for the rest. See logSync.ts.
      requestHistory(client, "LATEST", nick, since, LATEST_LIMIT);
    }
    this.logRecorder?.answeredTargets(serverId, nicks);
  }

  /** Remembers what honk knew when a registered connection is lost. See missed.ts. */
  private noteConnectionLost(serverId: string, ctrl: ServerControl): void {
    this.logRecorder?.connectionLost(serverId);
    const server = this.servers.get(serverId);
    if (!server || !ctrl.registered || ctrl.lastHeardAt === undefined) return;
    ctrl.missed = {
      since: ctrl.lastHeardAt,
      nick: server.nick,
      buffers: new Set(server.bufferOrder),
    };
  }

  private queueMissedMention(serverId: string, event: MentionEvent): void {
    const ctrl = this.getControl(serverId);
    ctrl.missedMentions.push(event);
    if (ctrl.missedTimer) clearTimeout(ctrl.missedTimer);
    ctrl.missedTimer = setTimeout(() => {
      ctrl.missedTimer = null;
      const events = ctrl.missedMentions;
      ctrl.missedMentions = [];
      for (const listener of this.missedListeners) listener(events);
    }, MISSED_REPORT_DELAY_MS);
  }

  /**
   * You read `bufferName`: ReadMarkerTracker says so when it would send MARKREAD for it.
   * Its badge clears now, not when you switch to it, so a buffer you only flipped past
   * keeps its badge, the same as on your other clients. The badge is the one sign of
   * "not read yet":
   *
   * - The divider stays while you read, and goes when you leave or send a line, once
   *   the badge is gone (clearReadDivider). A buffer you flipped past keeps it.
   * - A line in the buffer on screen counts as unread while the badge is there
   *   (pushMessage), and a marker from another client can still lower it (onReadMarker).
   */
  private markedRead(serverId: string, bufferName: string): void {
    const server = this.servers.get(serverId);
    const buf = server?.buffers[bufferName];
    if (!server || !buf || !hasBadge(buf)) return;
    server.buffers = { ...server.buffers, [bufferName]: { ...buf, unread: 0, hasMention: false } };
    this.emit();
  }

  /**
   * Clears a buffer's divider when you leave it or send a line to it, unless it still
   * has a badge. See markedRead.
   */
  private clearReadDivider(serverId: string, bufferName: string): void {
    const server = this.servers.get(serverId);
    const buf = server?.buffers[bufferName];
    if (server && buf?.firstUnreadId && !hasBadge(buf)) {
      server.buffers = {
        ...server.buffers,
        [bufferName]: { ...buf, firstUnreadId: undefined },
      };
    }
  }

  setActive(serverId: string, name: string): void {
    const server = this.servers.get(serverId);
    if (!server) return;
    const bufferName = this.bufferKey(serverId, name);
    if (!server.buffers[bufferName]) return;

    const leaving =
      this.active?.serverId !== serverId || this.active.buffer !== bufferName
        ? this.active
        : null;
    this.active = { serverId, buffer: bufferName };
    // The tracker may count the buffer you leave as read first. See markedRead.
    this.readMarkerTracker.onActiveChanged(leaving);
    if (leaving) this.clearReadDivider(leaving.serverId, leaving.buffer);
    this.emit();
  }

  openDm(serverId: string, nick: string): void {
    this.ensureBuffer(serverId, nick, "dm");
    this.setActive(serverId, nick);
  }

  /**
   * A click on a channel name in the chat: switches to the channel when it has
   * a buffer on this server, and joins it otherwise. A typed "/join" sends JOIN
   * even then, to get back into a channel whose rejoin failed; a click should
   * not send one JOIN per click.
   */
  openChannel(serverId: string, channel: string): void {
    const key = this.bufferKey(serverId, channel);
    if (this.servers.get(serverId)?.buffers[key]?.kind === "channel") {
      this.setActive(serverId, key);
      return;
    }
    const on = this.active?.serverId === serverId ? this.active : undefined;
    this.handleCommand(`join ${channel}`, on);
  }

  cycleBuffer(delta: 1 | -1): void {
    const flat: ActiveBuffer[] = [];
    for (const id of this.serverOrder) {
      const s = this.servers.get(id);
      if (!s) continue;
      for (const b of s.bufferOrder) {
        flat.push({ serverId: id, buffer: b });
      }
    }
    if (flat.length === 0) return;
    const idx = this.active
      ? flat.findIndex(
          (x) =>
            x.serverId === this.active!.serverId &&
            x.buffer === this.active!.buffer,
        )
      : 0;
    const nextIdx = (idx + delta + flat.length) % flat.length;
    const next = flat[nextIdx]!;
    this.setActive(next.serverId, next.buffer);
  }

  // ---- The offline demo (honk --demo, /demo). The data is in demo.ts. ----

  /** Servers that belong to the demo. They have no client; the methods below answer for them. */
  private demoServers = new Set<string>();
  private demoReplyCount = 0;

  /** Adds the demo networks, opens #honk, and starts the timeline of incoming messages. */
  startDemo(): void {
    if (this.demoServers.size > 0) {
      this.setActive(DEMO_START.serverId, DEMO_START.buffer);
      return;
    }
    // The welcome screen's placeholder server goes away, as it does for a real server.
    if (this.servers.has("local") && this.serverOrder.length === 1) {
      this.servers.delete("local");
      this.controls.delete("local");
      this.readMarkerTracker.forget("local");
      this.serverOrder = [];
    }

    const now = Date.now();
    for (const net of DEMO_NETWORKS) {
      const buffers: Record<string, BufferState> = {};
      for (const def of net.buffers) {
        const kind = bufferKindFor(def.name);
        const buf = createBuffer(def.name, kind);
        buf.topic = def.topic ?? "";
        if (kind === "channel") buf.users = demoUsers(def.users ?? []);
        for (const line of def.lines) {
          const msg = makeMessage(line.kind, line.text, {
            from: line.from,
            timestamp: new Date(now - line.mins * 60_000),
            isMention:
              line.from !== undefined &&
              (kind === "dm" || mentionsNick(line.text, DEMO_NICK, DEFAULT_CASEMAPPING)),
          });
          buf.messages.push(msg);
          if (line.unread) {
            buf.unread += 1;
            buf.hasMention ||= Boolean(msg.isMention);
            buf.firstUnreadId ??= msg.id;
          }
        }
        buffers[def.name] = buf;
      }
      const server: ServerState = {
        id: net.id,
        name: net.name,
        via: net.via,
        // No host: nothing can connect it, and the wake check skips it.
        config: { id: net.id, host: "", nick: DEMO_NICK, autoConnect: false },
        status: "connected",
        nick: DEMO_NICK,
        casemapping: DEFAULT_CASEMAPPING,
        tls: true,
        buffers,
        bufferOrder: [],
      };
      server.bufferOrder = sortBufferOrder(server, Object.keys(buffers));
      this.servers.set(net.id, server);
      this.controls.set(net.id, createControl());
      this.serverOrder.push(net.id);
      this.demoServers.add(net.id);
    }

    // The start buffer is on screen, so it has no badge. Its divider stays until you leave.
    const start = this.servers.get(DEMO_START.serverId)!;
    const startBuf = start.buffers[DEMO_START.buffer]!;
    start.buffers = {
      ...start.buffers,
      [DEMO_START.buffer]: { ...startBuf, unread: 0, hasMention: false },
    };
    if (this.active) this.clearReadDivider(this.active.serverId, this.active.buffer);
    this.active = { ...DEMO_START };
    this.emit();

    for (const event of DEMO_TIMELINE) {
      setTimeout(() => this.demoIncoming(event), event.afterMs);
    }
    const lastMs = Math.max(...DEMO_TIMELINE.map((e) => e.afterMs));
    let next = 0;
    setTimeout(() => {
      setInterval(() => {
        this.demoIncoming(DEMO_AMBIENT[next % DEMO_AMBIENT.length]!);
        next += 1;
      }, DEMO_AMBIENT_EVERY_MS);
    }, lastMs);
  }

  /** A message from a demo person. Skipped if it is for a channel you have left. */
  private demoIncoming(event: DemoEvent): void {
    const server = this.servers.get(event.serverId);
    if (!server) return;
    const isDm = bufferKindFor(event.buffer) === "dm";
    if (!isDm && !this.hasBuffer(event.serverId, event.buffer)) return;
    this.pushMessage(
      event.serverId,
      event.buffer,
      makeMessage(event.kind ?? "message", event.text, {
        from: event.from,
        isMention: isDm || mentionsNick(event.text, server.nick, this.casemapping(event.serverId)),
      }),
    );
  }

  /** Someone answers what you said: the other person in a DM, someone in the channel otherwise. */
  private demoRespond(serverId: string, bufferName: string): void {
    const server = this.servers.get(serverId);
    const buf = server?.buffers[this.bufferKey(serverId, bufferName)];
    if (!server || !buf) return;
    let from = bufferName;
    if (buf.kind === "channel") {
      const others = buf.users.filter((u) => !this.same(serverId, u.nick, server.nick));
      if (others.length === 0) return;
      from = others[this.demoReplyCount % others.length]!.nick;
    }
    const text = DEMO_REPLIES[this.demoReplyCount % DEMO_REPLIES.length]!;
    this.demoReplyCount += 1;
    setTimeout(
      () => this.demoIncoming({ serverId, buffer: bufferName, from, text }),
      DEMO_REPLY_DELAY_MS,
    );
  }

  /**
   * Runs a command on a demo server without a connection. True if it handled the command;
   * false lets the normal handler run it (/help, /clear, /quit...).
   */
  private demoCommand(
    cmd: string,
    args: string[],
    rest: string,
    server: ServerState,
    activeBuffer: string,
    reply: (text: string, kind?: MessageKind) => void,
  ): boolean {
    const id = server.id;
    switch (cmd) {
      case "j":
      case "join": {
        if (!args[0]) {
          reply(usage("join"), "error");
          return true;
        }
        const targets = args[0]
          .split(",")
          .filter(Boolean)
          .map((c) => (isChannelName(c) ? c : `#${c}`));
        for (const target of targets) {
          if (!this.hasBuffer(id, target)) {
            this.ensureBuffer(id, target, "channel");
            const buf = server.buffers[target]!;
            server.buffers = {
              ...server.buffers,
              [target]: { ...buf, users: demoUsers([]) },
            };
            this.pushMessage(id, target, makeMessage("join", joinText(server.nick, target)));
          }
          this.setActive(id, target);
        }
        return true;
      }

      case "p":
      case "part":
      case "leave": {
        const target = args[0] && isChannelName(args[0]) ? args[0] : activeBuffer;
        if (target === STATUS_BUFFER) {
          reply(insideOnly("part"), "error");
        } else {
          this.removeBuffer(id, target);
        }
        return true;
      }

      case "msg":
      case "query": {
        const target = args[0];
        const text = args.slice(1).join(" ");
        if (!target) {
          reply(usage("msg"), "error");
          return true;
        }
        this.ensureBuffer(id, target);
        this.setActive(id, target);
        if (text) {
          this.pushMessage(id, target, makeMessage("message", text, { from: server.nick, isSelf: true }));
          this.demoRespond(id, target);
        }
        return true;
      }

      case "me": {
        if (activeBuffer === STATUS_BUFFER) {
          reply(insideOnly("me"), "error");
          return true;
        }
        if (!rest) {
          reply(usage("me"), "error");
          return true;
        }
        this.pushMessage(id, activeBuffer, makeMessage("action", rest, { from: server.nick, isSelf: true }));
        this.demoRespond(id, activeBuffer);
        return true;
      }

      case "nick": {
        const next = args[0];
        if (!next) {
          reply(usage("nick"), "error");
          return true;
        }
        const old = server.nick;
        const buffers = { ...server.buffers };
        for (const name of server.bufferOrder) {
          const buf = buffers[name];
          if (buf?.kind !== "channel") continue;
          buffers[name] = {
            ...buf,
            users: sortUsers(
              buf.users.map((u) =>
                this.same(server.id, u.nick, old) ? { ...u, nick: next } : u,
              ),
            ),
          };
        }
        server.buffers = buffers;
        server.nick = next;
        server.config = { ...server.config, nick: next };
        reply(`You are now known as ${next}`);
        return true;
      }

      case "topic": {
        const buf = server.buffers[activeBuffer];
        if (buf?.kind !== "channel") {
          reply("Use /topic inside a channel.", "error");
          return true;
        }
        if (!rest) {
          reply(buf.topic ? `Topic: ${buf.topic}` : "No topic is set.");
          return true;
        }
        server.buffers = { ...server.buffers, [activeBuffer]: { ...buf, topic: rest } };
        reply(`${server.nick} changed the topic to: ${rest}`);
        return true;
      }

      case "whois": {
        if (!args[0]) {
          reply(usage("whois"), "error");
          return true;
        }
        // The channels the nick is in, as a real WHOIS lists them: "@#honk #bun".
        const channels = server.bufferOrder.flatMap((name) => {
          const user = server.buffers[name]?.users.find((u) =>
            this.same(server.id, u.nick, args[0]),
          );
          return user ? [`${user.prefix}${name}`] : [];
        });
        for (const line of whoisLines(demoWhois(args[0], server.name, channels))) reply(line);
        return true;
      }

      case "history": {
        const buf = server.buffers[activeBuffer];
        if (!buf || buf.kind === "status") {
          reply(insideOnly("history"), "error");
          return true;
        }
        const oldest = buf.messages[0]?.timestamp.getTime() ?? Date.now();
        DEMO_HISTORY.forEach((line, i) => {
          const minsBefore = DEMO_HISTORY.length - i;
          this.pushMessage(
            id,
            activeBuffer,
            makeMessage("message", line.text, {
              from: line.from,
              timestamp: new Date(oldest - minsBefore * 60_000),
              isHistory: true,
            }),
          );
        });
        return true;
      }

      case "connect":
      case "server":
      case "disconnect":
      case "raw": {
        reply(`/${cmd} does not work in the offline demo. Quit and start honk without --demo.`, "error");
        return true;
      }

      default:
        return false;
    }
  }

  handleInput(raw: string): "quit" | void {
    const trimmed = raw.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("/")) {
      return this.handleCommand(trimmed.slice(1));
    }
    this.sendText(raw);
  }

  /**
   * Sends pasted lines to the active buffer, one message each. A line that starts with
   * "/" is sent as text, not run as a command.
   */
  sendLines(lines: string[]): void {
    if (!this.active) return;
    if (lines.length > MAX_PASTE_LINES) {
      this.pushMessage(
        this.active.serverId,
        this.active.buffer,
        makeMessage(
          "error",
          `The paste has ${lines.length} lines; at most ${MAX_PASTE_LINES} are sent at once. Nothing was sent.`,
        ),
      );
      return;
    }
    for (const line of lines) {
      if (!this.sendText(line)) return;
    }
  }

  /** Sends one message to the active buffer. False (with an error shown) if it can't. */
  private sendText(raw: string): boolean {
    if (!raw.trim() || !this.active) return false;
    const { serverId, buffer } = this.active;
    const server = this.servers.get(serverId);
    if (server && this.demoServers.has(serverId) && buffer !== STATUS_BUFFER) {
      this.clearReadDivider(serverId, buffer);
      this.pushMessage(
        serverId,
        buffer,
        makeMessage("message", raw, { from: server.nick, isSelf: true }),
      );
      this.demoRespond(serverId, buffer);
      return true;
    }
    const client = this.clients.get(serverId);
    if (!server || !client || server.status !== "connected") {
      this.pushMessage(
        serverId,
        buffer,
        makeMessage(
          "error",
          this.notConnectedText(server),
        ),
      );
      return false;
    }

    if (buffer === STATUS_BUFFER) {
      this.pushMessage(
        serverId,
        buffer,
        makeMessage(
          "system",
          "Messages can't be sent from *status. Join a channel with /join #channel, or open a DM with /msg <nick>.",
        ),
      );
      return false;
    }

    this.clearReadDivider(serverId, buffer);
    // The library would trim the end anyway; show what it sends.
    this.pushSent(serverId, client, buffer, "message", raw.trimEnd());
    return true;
  }

  /**
   * Runs a slash command ("/join #x", "/connect") on a server that may not be the active
   * one, as if typed in its *status. The omnibox uses it for rows such as "Join #x on beta".
   * Replies go to the buffer you are in, named after the server, so you see them.
   */
  runCommandOn(serverId: string, line: string): "quit" | void {
    if (!this.servers.has(serverId) || !line.startsWith("/")) return;
    return this.handleCommand(line.slice(1), { serverId, buffer: STATUS_BUFFER });
  }

  private handleCommand(line: string, on?: ActiveBuffer): "quit" | void {
    const spaceIdx = line.indexOf(" ");
    const cmd = (spaceIdx === -1 ? line : line.slice(0, spaceIdx)).toLowerCase();
    const rest = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1).trim();
    const args = rest ? rest.split(/\s+/) : [];

    const target = on ?? this.active;
    const activeServerId = target?.serverId;
    const activeBuffer = target?.buffer ?? STATUS_BUFFER;
    const server = activeServerId ? this.servers.get(activeServerId) : undefined;
    const client = activeServerId ? this.clients.get(activeServerId) : undefined;
    // A command for another server answers in the buffer you are in, not in its *status.
    const elsewhere = Boolean(on && this.active && on.serverId !== this.active.serverId);

    const reply = (text: string, kind: MessageKind = "system") => {
      if (!activeServerId) return;
      if (elsewhere) this.showInActiveFrom(activeServerId, kind, text);
      else this.pushMessage(activeServerId, activeBuffer, makeMessage(kind, text));
    };

    if (server && this.demoServers.has(server.id)) {
      if (this.demoCommand(cmd, args, rest, server, activeBuffer, reply)) return;
    }

    switch (cmd) {
      case "help": {
        // One line per command. No padding: the chat column can be narrow, and padded
        // columns would wrap every line.
        reply("Commands:");
        for (const c of SLASH_COMMANDS) {
          reply(`${syntax(c)} - ${c.summary}`);
        }
        reply("Press Ctrl+K for the omnibox, then ? to see what it does. Ctrl+F searches your chat logs.");
        return;
      }

      case "connect": {
        const hostArg = args[0];
        if (!hostArg) {
          if (server && server.config.host) {
            void this.connectServer(server.id, { manual: true });
          } else {
            reply(`${usage("connect")} (port 6697, or +port, uses TLS)`, "error");
          }
          return;
        }
        const [host = "", inlinePort] = hostArg.split(":");
        const portArg = inlinePort ?? (parsePortArg(args[1]) ? args[1] : undefined);
        const parsedPort = parsePortArg(portArg);
        if (portArg !== undefined && !parsedPort) {
          return reply(`Invalid port: ${portArg}`, "error");
        }
        const nickArg = inlinePort || !parsedPort ? args[1] : args[2];

        // Reconnect a known server rather than replace its config (SASL, channels...).
        const known = this.serverOrder
          .map((id) => this.servers.get(id))
          .find(
            (s) =>
              s &&
              sameHost(s.config.host, host) &&
              (!parsedPort || s.config.port === parsedPort.port),
          );
        if (known) {
          if (nickArg) known.config = { ...known.config, nick: nickArg };
          this.setActive(known.id, STATUS_BUFFER);
          void this.connectServer(known.id, { manual: true });
          return;
        }

        const { port, tls } = parsedPort ?? { port: 6697, tls: true };
        let id = serverIdFromHost(host);
        if (this.servers.has(id)) id = `${id}:${port}`;
        this.addServer({
          id,
          name: host,
          host,
          port,
          tls,
          nick: nickArg || server?.nick || defaultNick(),
          autoConnect: true,
        });
        this.setActive(id, STATUS_BUFFER);
        return;
      }

      case "disconnect": {
        if (activeServerId) {
          this.disconnectServer(activeServerId, rest || "Leaving");
        }
        return;
      }

      case "j":
      case "join": {
        if (!client || !server) return reply(this.notConnectedText(server), "error");
        if (!args[0]) return reply(usage("join"), "error");
        // "/join #a,#b keyA": the server sends one JOIN per channel.
        const keys = args[1]?.split(",") ?? [];
        const targets = args[0]
          .split(",")
          .filter(Boolean)
          .map((c) => (isChannelName(c) ? c : `#${c}`));
        const descriptions = targets.map((target, i): string | [string, string] =>
          keys[i] ? [target, keys[i]] : target,
        );
        if (descriptions.length === 0) return reply(usage("join"), "error");
        for (const target of targets) {
          // Already in it: the server sends no JOIN, so switch now.
          if (server.buffers[this.bufferKey(server.id, target)]?.kind === "channel") {
            this.setActive(server.id, target);
          } else {
            this.noteRequestedJoin(server.id, target);
          }
        }
        client.join(...(descriptions as [string, ...(string | [string, string])[]]));
        return;
      }

      case "p":
      case "part":
      case "leave": {
        const target =
          args[0] && isChannelName(args[0]) ? args[0] : activeBuffer;
        const reason =
          args[0] && isChannelName(args[0]) ? args.slice(1).join(" ") : rest;
        if (target === STATUS_BUFFER) return reply(insideOnly("part"), "error");
        // Closing a DM is local, so it works offline too.
        if (!isChannelName(target)) {
          if (server) this.removeBuffer(server.id, target);
          return;
        }
        if (!client || !server) return reply(this.notConnectedText(server), "error");
        client.part(target, reason || undefined);
        return;
      }

      case "msg":
      case "query": {
        if (!client || !server) return reply(this.notConnectedText(server), "error");
        // Before registration the server would not answer the delivery PING.
        if (server.status !== "connected" && args.length > 1) {
          return reply(this.notConnectedText(server), "error");
        }
        const target = args[0];
        const text = args.slice(1).join(" ");
        if (!target)
          return reply(usage("msg"), "error");
        this.ensureBuffer(server.id, target);
        this.setActive(server.id, target);
        if (text) {
          this.pushSent(server.id, client, target, "message", text);
        }
        return;
      }

      case "me": {
        if (!client || !server) return reply(this.notConnectedText(server), "error");
        if (activeBuffer === STATUS_BUFFER) return reply(insideOnly("me"), "error");
        if (!rest) return reply(usage("me"), "error");
        if (server.status !== "connected") {
          return reply(this.notConnectedText(server), "error");
        }
        this.pushSent(server.id, client, activeBuffer, "action", rest);
        return;
      }

      case "nick": {
        if (!client) return reply(this.notConnectedText(server), "error");
        if (!args[0]) return reply(usage("nick"), "error");
        client.nick(args[0]);
        return;
      }

      case "topic": {
        if (!client || !isChannelName(activeBuffer)) {
          return reply("Use /topic inside a channel.", "error");
        }
        if (rest) {
          client.topic(activeBuffer, rest);
        } else {
          client.topic(activeBuffer);
        }
        return;
      }

      case "whois": {
        if (!client) return reply(this.notConnectedText(server), "error");
        if (!args[0]) return reply(usage("whois"), "error");
        client.whois(args[0]);
        return;
      }

      case "raw": {
        if (!client) return reply(this.notConnectedText(server), "error");
        if (!rest) return reply(usage("raw"), "error");
        const [rawCmd, ...rawParams] = rest.split(" ");
        void client.send(rawCmd as never, ...(rawParams as never[]));
        return;
      }

      case "history": {
        if (!client || !server) return reply(this.notConnectedText(server), "error");
        if (!client.state.caps.enabled.has("draft/chathistory")) {
          return reply("This server does not keep history, so /history can't load older messages.", "error");
        }
        if (activeBuffer === STATUS_BUFFER) {
          return reply(insideOnly("history"), "error");
        }
        const wanted = Math.min(200, Math.max(1, Number(args[0]) || 50));
        const buf = server.buffers[activeBuffer];
        // Older lines past the cap would be fetched and then trimmed right away.
        // When the request must shrink, the notice below takes one line of the room too.
        const room = MAX_MESSAGES_WITH_HISTORY - (buf?.messages.length ?? 0);
        const limit = wanted <= room ? wanted : room - 1;
        if (limit <= 0) {
          return reply(
            `Scrollback is full (${MAX_MESSAGES_WITH_HISTORY} lines). Use /clear to start over.`,
            "error",
          );
        }
        if (limit < wanted) {
          reply(
            `Fetching only ${limit} lines: scrollback holds at most ${MAX_MESSAGES_WITH_HISTORY}.`,
          );
        }
        const messages = buf?.messages ?? [];
        const first = messages.findIndex(
          (m) => m.kind === "message" || m.kind === "action" || m.kind === "notice",
        );
        const oldest = messages[first];
        // It asks just after the oldest Line, as a fill's page does (see PAGE_OVERLAP_MS).
        // The Lines on screen with its time come back as Replays, so they are asked for
        // on top. The buffer is in time order, so they follow it.
        const time = oldest?.timestamp.getTime();
        let replays = 0;
        while (oldest && messages[first + replays]?.timestamp.getTime() === time) replays++;
        const asked = limit + replays;
        const label = historyLabel(client);
        this.getControl(server.id).historyRequests.push({
          target: this.key(server.id, activeBuffer),
          label,
          history: { asked, beforeLineId: oldest?.id },
        });
        const [subcommand, anchor] =
          time !== undefined
            ? (["BEFORE", timestampParam(time + PAGE_OVERLAP_MS)] as const)
            : (["LATEST", "*"] as const);
        requestHistory(client, subcommand, activeBuffer, anchor, asked, label);
        return;
      }

      case "clear": {
        if (!server) return;
        const buf = server.buffers[activeBuffer];
        if (!buf) return;
        server.buffers = {
          ...server.buffers,
          [activeBuffer]: { ...buf, messages: [], messageLimit: undefined, scrollbackFull: undefined },
        };
        this.emit();
        return;
      }

      case "demo": {
        this.startDemo();
        return;
      }

      case "quit":
      case "exit": {
        this.disconnectAll();
        return "quit";
      }

      default:
        reply(
          `/${cmd} is not a command. Type /help to list the commands.`,
          "error",
        );
    }
  }
}
