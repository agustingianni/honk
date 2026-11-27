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
  bufferKindFor,
  isChannelName,
  normalizeNick,
  nameKey,
  sameNick,
  STATUS_BUFFER,
  UNKNOWN_SENDER,
} from "./names.ts";
import type { MentionEvent } from "../notify.ts";
import { findSlashCommand, SLASH_COMMANDS, syntax } from "./commands.ts";
import { DELIVERY_TIMEOUT_MS, DeliveryTracker, type SentLine } from "./delivery.ts";
import {
  dmTargets,
  historyTimestamp,
  isMissedLine,
  isMissedMention,
  MISSED_MARGIN_MS,
  type MissedWindow,
  TARGETS_BATCH_TYPES,
} from "./missed.ts";
import { NetworkWatcher } from "./netwatch.ts";
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
import { commandOf, parseLine } from "./ircLine.ts";
import { createNodeRuntime, describeLineError } from "./runtime.ts";

/** Messages kept per buffer from live traffic. */
const MAX_MESSAGES = 500;
/** Hard cap once history (/history, CHATHISTORY playback) has grown a buffer past MAX_MESSAGES. */
const MAX_MESSAGES_WITH_HISTORY = 5000;
/** A paste with more lines than this is refused, so a wrong paste can't flood a channel. */
const MAX_PASTE_LINES = 10;
/** Reports of a bug in honk's line handling, per connection. See createNodeRuntime. */
const MAX_LINE_ERROR_REPORTS = 5;

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
  /** Set when a registered connection is lost. See missed.ts. */
  missed?: MissedWindow;
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
    pendingWhois: new Set(),
    historyRequests: [],
    awayShown: new Map(),
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

function tagTime(tags?: { time?: string }): Date {
  return tags?.time ? new Date(tags.time) : new Date();
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
  void client.send(
    label === undefined ? {} : { label },
    "CHATHISTORY" as never,
    subcommand as never,
    target as never,
    anchor as never,
    String(limit) as never,
  );
}

/** A /history request waiting for its reply. */
interface HistoryRequest {
  /** The buffer it was typed in, as nameKey. */
  target: string;
  /**
   * The label tag sent with it, when the server has labeled-response. The server copies
   * it onto the reply, so a FAIL or a batch matches this request and no other.
   */
  label?: string;
}

/** Counts the labels sent with /history, so each one is new on its connection. */
let historyLabels = 0;

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
  target: string,
): HistoryRequest | undefined {
  const key = nameKey(target);
  const i =
    label !== undefined
      ? pending.findIndex((r) => r.label === label)
      : pending.findIndex((r) => r.label === undefined && r.target === key);
  return i === -1 ? undefined : pending.splice(i, 1)[0];
}

/** The CHATHISTORY subcommands, which come before the target in a FAIL's context. */
const HISTORY_SUBCOMMANDS = new Set(["LATEST", "BEFORE", "AFTER", "AROUND", "BETWEEN", "TARGETS"]);

/**
 * The target a FAIL CHATHISTORY names: the first context param, after the subcommand,
 * for which `known` says yes. The spec form is
 * `FAIL CHATHISTORY <code> <subcommand> <target> :<description>`, but some servers leave
 * out the subcommand, so this looks at each param, not at a fixed position.
 *
 *   ["LATEST", "#a", "*"], known #a -> "#a"
 *   ["#a"],                known #a -> "#a"
 *   ["LATEST", "#a"],      known -  -> undefined
 */
function historyFailTarget(
  context: string[],
  known: (name: string) => boolean,
): string | undefined {
  return context.find((p) => !HISTORY_SUBCOMMANDS.has(p.toUpperCase()) && known(p));
}

/**
 * Takes the /history request a FAIL CHATHISTORY answers out of `pending`, the way
 * takeHistoryRequest does for a batch. A labeled FAIL matches by label. An unlabeled one
 * matches an unlabeled request for the target it names. An unlabeled FAIL that names no
 * target can't say which request it answers, so every unlabeled request stops waiting;
 * labeled ones still get their own reply.
 *
 *   [#a h1, #b h2], FAIL label h2      -> the #b request, leaves [#a h1]
 *   [#a, #b],       FAIL no label, #b  -> the #b request, leaves [#a]
 *   [#a h1],        FAIL no label, #a  -> undefined, leaves [#a h1]  (the join fetch failed)
 *   [#a, #b h2],    FAIL no label, none -> undefined, leaves [#b h2]
 */
function takeFailedHistoryRequest(
  pending: HistoryRequest[],
  label: string | undefined,
  target: string | undefined,
): HistoryRequest | undefined {
  if (label !== undefined || target !== undefined) {
    return takeHistoryRequest(pending, label, target ?? "");
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

/** Characters allowed in IRC nicks. A mention must not touch one on either side. */
const NICK_CHAR = String.raw`[\w\[\]\\` + "`" + String.raw`^{}|-]`;

/** True if `text` contains `nick` as a whole word. `\b` fails for nicks like `goose[m]`. */
function mentionsNick(text: string, nick: string): boolean {
  if (!nick) return false;
  const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!${NICK_CHAR})${escaped}(?!${NICK_CHAR})`, "i").test(text);
}

/** The buffer a chat line belongs to: the channel, or for a DM the other person. */
function routeTarget(rawTarget: string, from: string, isSelf: boolean): string {
  return isChannelName(rawTarget) || isSelf ? rawTarget : from;
}

/**
 * Runs `hook` before each event reaches any listener. The library's own plugins (nicklist)
 * listen before the app does and change state first, so state "before the event" must be
 * read here.
 */
function beforeEmit(
  client: Client,
  hook: (event: string, payload: unknown) => void,
): void {
  (
    client as unknown as {
      hooks: { beforeCall(key: "emit", hook: (event: string, payload: unknown) => void): void };
    }
  ).hooks.beforeCall("emit", hook);
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
  if (!users.some((u) => sameNick(u.nick, DEMO_NICK))) {
    users.push({ prefix: "", nick: DEMO_NICK });
  }
  return sortUsers(users);
}

function joinKey(serverId: string, channel: string): string {
  return `${serverId}\n${nameKey(channel)}`;
}

function channelsWithNick(server: ServerState, nick: string): string[] {
  const lower = nameKey(nick);
  return server.bufferOrder.filter((name) => {
    const buf = server.buffers[name];
    return buf?.kind === "channel" && buf.users.some((u) => nameKey(u.nick) === lower);
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
  /** Confirms that the lines you send reach the server. See delivery.ts. */
  private delivery = new DeliveryTracker({
    delivered: (serverId, lines) => this.setDelivery(serverId, lines, undefined),
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

  constructor() {
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
          makeMessage("system", "The computer woke from sleep. Reconnecting…"),
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
          makeMessage("system", "The network changed. Reconnecting now…"),
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

  /** True (and forgets the request) if the user ran /join for this channel and it hasn't expired. */
  /** Remembers that you asked to join `channel`, so its JOIN moves the view there. */
  private noteRequestedJoin(serverId: string, channel: string): void {
    this.requestedJoins.set(joinKey(serverId, channel), Date.now() + REQUESTED_JOIN_TTL_MS);
  }

  private takeRequestedJoin(serverId: string, channel: string): boolean {
    const key = joinKey(serverId, channel);
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
    const prefix = joinKey(serverId, "");
    for (const key of this.requestedJoins.keys()) {
      if (key.startsWith(prefix)) this.requestedJoins.delete(key);
    }
  }

  /** Forgets which "is away" texts were shown for this nick, in every buffer. */
  private forgetAwayShown(serverId: string, nick: string): void {
    this.getControl(serverId).awayShown.delete(nameKey(nick));
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
        `Connecting to ${cfg.host}:${port} (${tls ? "TLS" : "no TLS"}) as ${cfg.nick}…`,
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
    (client as unknown as { runtime: ReturnType<typeof createNodeRuntime> }).runtime =
      createNodeRuntime(
        abort.signal,
        (line) => {
          if (this.clients.get(serverId) === client) this.onRawLine(serverId, line);
        },
        // A bug in honk, not in the server: say so, show the line, and keep going.
        // irc-client-ts still reads the line.
        (line, err) => {
          if (this.clients.get(serverId) !== client) return;
          const { key, text } = describeLineError(line, err);
          if (reported.has(key) || reported.size >= MAX_LINE_ERROR_REPORTS) return;
          reported.add(key);
          this.pushMessage(serverId, STATUS_BUFFER, makeMessage("system", text));
        },
      );

    // Request IRCv3 draft/chathistory when advertised by server/bouncer (e.g. soju)
    if (!client.state.caps.requested.includes("draft/chathistory")) {
      client.state.caps.requested.push("draft/chathistory");
    }
    // Without it, Ergo plays joins, parts and mode changes back as fake messages from
    // "HistServ" ("alice joined the channel"). With it, they come as real JOIN and MODE
    // lines inside the history batch, which the batch handler skips.
    if (!client.state.caps.requested.includes("draft/event-playback")) {
      client.state.caps.requested.push("draft/event-playback");
    }

    this.clients.set(serverId, client);
    this.bindClientEvents(serverId, client);

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
      makeMessage("system", `Reconnecting in ${secs}s (attempt ${attempt})…`),
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

  private bindClientEvents(serverId: string, client: Client): void {
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
    beforeEmit(client, (event, payload) => {
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
    client.on("raw", () => {
      if (isStale()) return;
      this.getControl(serverId).lastHeardAt = Date.now();
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
        makeMessage("system", "Connected. Registering…"),
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
      const isReconnect = ctrl.hasEverConnected;
      ctrl.hasEverConnected = true;
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

      // Ask who sent you DMs while the connection was down. Channel history comes with
      // the rejoin; DMs have no rejoin. The reply is handled in the batch_end below.
      if (ctrl.missed && client.state.caps.enabled.has("draft/chathistory")) {
        void client.send(
          "CHATHISTORY" as never,
          "TARGETS" as never,
          historyTimestamp(ctrl.missed.since - MISSED_MARGIN_MS) as never,
          historyTimestamp(Date.now()) as never,
          "50" as never,
        );
      }
    });

    // The nicks that wrote to you while the connection was down. Load each DM from that
    // time; the missed-line checks in pushMessage then badge and notify it. See missed.ts.
    client.on("batch_end", (batch) => {
      if (!TARGETS_BATCH_TYPES.has(batch.params.type)) return;
      const server = live();
      const ctrl = this.controls.get(serverId);
      if (!server || !ctrl?.missed) return;
      const nicks = dmTargets(batch.params.messages, [ctrl.missed.nick, server.nick]);
      if (nicks.length === 0) return;
      const buffers = new Set(ctrl.missed.buffers);
      for (const nick of nicks) buffers.add(this.bufferKey(serverId, nick));
      ctrl.missed = { ...ctrl.missed, buffers };
      const since = historyTimestamp(ctrl.missed.since - MISSED_MARGIN_MS);
      for (const nick of nicks) requestHistory(client, "AFTER", nick, since, 50);
    });

    client.on("isupport:network", (msg) => {
      const server = live();
      const net = msg.params.value?.trim();
      if (!server || !net) return;
      server.networkName = net;
      server.name = net;
      this.emit();
    });

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
      this.noteOffline(serverId, "Connection lost. Reconnecting…");
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
      this.ensureBuffer(serverId, channel, "channel");
      if (sameNick(who, server.nick)) {
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
        // Fetch recent scrollback from bouncer/server if draft/chathistory is enabled
        if (client.state.caps.enabled.has("draft/chathistory")) {
          requestHistory(client, "LATEST", channel, "*", 50);
        }
      } else {
        this.pushMessage(
          serverId,
          channel,
          makeMessage("join", `${who} joined ${channel}`),
        );
      }
    });

    client.on("part", (msg) => {
      const server = live();
      if (!server) return;
      const channel = msg.params.channel;
      const who = normalizeNick(msg.source?.name);
      if (sameNick(who, server.nick)) {
        this.removeBuffer(serverId, channel);
      } else {
        const reason = msg.params.comment ? ` (${msg.params.comment})` : "";
        this.pushMessage(
          serverId,
          channel,
          makeMessage("part", `${who} left ${channel}${reason}`),
        );
      }
    });

    client.on("quit", (msg) => {
      const server = live();
      if (!server) return;
      const who = normalizeNick(msg.source?.name);
      const reason = msg.params.comment ? ` (${msg.params.comment})` : "";
      for (const bufName of priorChannels.get(msg) ?? channelsWithNick(server, who)) {
        this.pushMessage(serverId, bufName, makeMessage("part", `${who} quit${reason}`));
      }
    });

    client.on("kick", (msg) => {
      const server = live();
      if (!server) return;
      const { channel, nick, comment } = msg.params;
      const by = normalizeNick(msg.source?.name) || "someone";
      const reason = comment ? ` (${comment})` : "";
      if (sameNick(nick, server.nick)) {
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
        makeMessage("error", `${nick} was kicked by ${by}${reason}`),
      );
    });

    client.on("nick", (msg) => {
      const server = live();
      if (!server) return;
      const oldNick = normalizeNick(msg.source?.name);
      const newNick = msg.params.nick;
      if (sameNick(oldNick, server.nick)) {
        server.nick = newNick;
        this.pushMessage(
          serverId,
          STATUS_BUFFER,
          makeMessage("system", `You are now known as ${newNick}`),
        );
        return;
      }
      const line = `${oldNick} is now known as ${newNick}`;
      for (const bufName of priorChannels.get(msg) ?? channelsWithNick(server, oldNick)) {
        this.pushMessage(serverId, bufName, makeMessage("system", line));
      }
      // An open DM follows the person to the new nick. If a DM with the new nick is
      // already open, the old one is merged into it, so one person has one DM.
      if (this.hasBuffer(serverId, oldNick)) {
        if (this.hasBuffer(serverId, newNick) && !sameNick(oldNick, newNick)) {
          this.mergeBuffer(serverId, oldNick, newNick);
        } else {
          this.renameBuffer(serverId, oldNick, newNick);
        }
        this.pushMessage(serverId, newNick, makeMessage("system", line));
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
      this.pushMessage(
        serverId,
        msg.params.channel,
        makeMessage(
          "system",
          buf.topic ? `${who} changed the topic to: ${buf.topic}` : `${who} cleared the topic`,
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
      // A /history that found nothing older says so, instead of nothing happening.
      // The label is on this BATCH line, or on a labeled-response batch around it.
      const parentRef = batch.params.tags?.batch;
      const label =
        batch.params.tags?.label ?? (parentRef && client.state.batches.get(parentRef)?.tags?.label);
      const ctrl = this.getControl(serverId);
      if (batchTarget && takeHistoryRequest(ctrl.historyRequests, label, batchTarget)) {
        const any = batch.params.messages.some(
          (m) => m.command === "privmsg" || m.command === "notice",
        );
        if (!any) {
          this.pushMessage(
            serverId,
            batchTarget,
            makeMessage("system", `The server has no older messages in ${batchTarget}.`),
          );
        }
      }
      for (const raw of batch.params.messages) {
        const cmd = raw.command;
        if (cmd !== "privmsg" && cmd !== "notice") continue;

        const from = normalizeNick(raw.source?.name) || UNKNOWN_SENDER;
        const rawText = raw.params[1] ?? "";
        const isSelf = sameNick(from, server.nick);
        const target =
          batchTarget ||
          routeTarget(raw.params[0] ?? STATUS_BUFFER, from, isSelf);

        // Detect CTCP ACTION (\x01ACTION text\x01)
        const actionMatch = /^\x01ACTION ([\s\S]*?)\x01?$/.exec(rawText);
        const msgKind: MessageKind =
          cmd === "notice" ? "notice" : actionMatch ? "action" : "message";
        const text = actionMatch ? actionMatch[1]! : rawText;

        this.pushMessage(
          serverId,
          target,
          makeMessage(msgKind, text, {
            from,
            msgid: raw.tags?.msgid,
            timestamp: tagTime(raw.tags),
            isSelf,
            isHistory: true,
          }),
        );
      }
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
      const isSelf = sameNick(from, server.nick);
      const target = routeTarget(msg.params.target, from, isSelf);
      // A DM opened as "/msg dave" takes the sender's real casing ("Dave") when they write.
      if (!isSelf && !isChannelName(target)) this.renameBuffer(serverId, target, target);
      const isHistory = isHistoryBatch(tags);
      // Someone who writes is back, so their next "is away" shows again, even with the same text.
      if (!isSelf && !isHistory) this.forgetAwayShown(serverId, from);
      const isMention =
        !isSelf &&
        !isHistory &&
        (!isChannelName(target) || mentionsNick(msg.params.text, server.nick));

      if (!isHistory && isSelf && this.wasRecentlyEchoed(serverId, target, msg.params.text)) {
        return;
      }

      this.pushMessage(
        serverId,
        target,
        makeMessage(kind, msg.params.text, {
          from,
          msgid: tags?.msgid,
          timestamp: tagTime(tags),
          isMention,
          isSelf,
          isHistory,
        }),
      );
    };

    client.on("privmsg", (msg) => onChat("message", msg));
    client.on("ctcp_action", (msg) => onChat("action", msg));

    // With echo-message, the library reports our own lines (typed here, or sent from
    // another client on the same bouncer account) as echo:* instead of privmsg/notice.
    // onChat drops the echo of a line this client already showed.
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
      this.pushMessage(
        serverId,
        target,
        makeMessage("notice", msg.params.text, {
          from,
          msgid: tags?.msgid,
          timestamp: tagTime(tags),
          isHistory: isHistoryBatch(tags),
        }),
      );
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
      if (nick) this.getControl(serverId).pendingWhois.add(nameKey(nick));
    });
    client.on("raw:rpl_endofwhois", (msg) => {
      if (isStale()) return;
      const nick = msg.params[1];
      if (nick) this.getControl(serverId).pendingWhois.delete(nameKey(nick));
    });

    // "alice is away": the server answers a message to someone who is away. It says so
    // on every message, so a DM shows it only when the away text changes.
    client.on("raw:rpl_away", (msg) => {
      if (isStale()) return;
      const [, nick, away] = msg.params;
      if (!nick) return;
      const ctrl = this.getControl(serverId);
      const key = nameKey(nick);
      if (ctrl.pendingWhois.has(key)) return;
      const where = this.hasBuffer(serverId, nick) ? nick : this.replyTarget(serverId);
      const text = away ?? "";
      let shown = ctrl.awayShown.get(key);
      if (!shown) ctrl.awayShown.set(key, (shown = new Map()));
      if (shown.get(nameKey(where)) === text) return;
      shown.set(nameKey(where), text);
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
    // other errors.
    //   FAIL <command> <code> [<context>...] :<description>
    client.on("raw:fail", (msg) => {
      if (isStale()) return;
      const command = msg.params[0] ?? "";
      const description = msg.params.length > 2 ? (msg.params.at(-1) ?? "") : "";
      let where = this.replyTarget(serverId);
      if (command.toUpperCase() === "CHATHISTORY") {
        const ctrl = this.getControl(serverId);
        const label = msg.tags?.label;
        const target = historyFailTarget(
          msg.params.slice(2, -1),
          (name) =>
            name !== STATUS_BUFFER &&
            (this.hasBuffer(serverId, name) ||
              ctrl.historyRequests.some((r) => r.target === nameKey(name))),
        );
        const failed = takeFailedHistoryRequest(ctrl.historyRequests, label, target);
        const buffer = failed?.target ?? target;
        if (buffer !== undefined && this.hasBuffer(serverId, buffer)) where = buffer;
      }
      this.pushMessage(
        serverId,
        where,
        makeMessage("error", describeStandardReply(command, description)),
      );
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
   * Shows a line you just sent as "sending" and starts confirming it with a PING.
   * See delivery.ts.
   */
  private pushSent(serverId: string, client: Client, target: string, message: ChatMessage): void {
    message.isSelf = true;
    message.delivery = "pending";
    this.pushMessage(serverId, target, message);
    const line: SentLine = { bufferName: this.bufferKey(serverId, target), messageId: message.id };
    this.delivery.track(serverId, line, (token) => void client.send("PING", token));
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
      const buf = server.buffers[name];
      if (!buf) continue;
      const messages = buf.messages.map((m) => {
        if (!ids.has(m.id)) return m;
        const { delivery: _, ...rest } = m;
        return state ? { ...rest, delivery: state } : rest;
      });
      server.buffers = { ...server.buffers, [name]: { ...buf, messages } };
    }
    this.emit();
  }

  /** Lines still waiting for their PONG when the connection closes may not have arrived. */
  private failPendingLines(serverId: string): void {
    this.setDelivery(serverId, this.delivery.drop(serverId), "failed");
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
      const refused = this.delivery.reject(serverId, subject[0]);
      if (refused) this.setDelivery(serverId, [refused], "failed");
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
   * A raw line from the server, before irc-client-ts parses it. Only numerics the library
   * doesn't know are handled here, because it drops their number. See replies.ts.
   */
  private onRawLine(serverId: string, line: string): void {
    // Every line passes here, so look at the command before parsing the whole line.
    const name = NUMERICS_MISSING_FROM_LIBRARY[commandOf(line)];
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
        makeMessage("system", `Nick ${subject[0] ?? ""} is not available, trying ${fallback}…`),
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

  private wasRecentlyEchoed(
    serverId: string,
    target: string,
    text: string,
  ): boolean {
    const buf = this.servers.get(serverId)?.buffers[this.bufferKey(serverId, target)];
    if (!buf || buf.messages.length === 0) return false;
    const now = Date.now();
    for (
      let i = buf.messages.length - 1;
      i >= Math.max(0, buf.messages.length - 5);
      i--
    ) {
      const m = buf.messages[i]!;
      if (m.isSelf && m.text === text && now - m.timestamp.getTime() < 5000) {
        return true;
      }
    }
    return false;
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
    server.buffers = { ...server.buffers, [name]: buf };
    server.bufferOrder = sortBufferOrder(server, [...server.bufferOrder, name]);
    return buf;
  }

  /**
   * The key of the buffer called `name`, ignoring case (IRC nicks and channels are
   * case-insensitive), or `name` itself if there is none yet.
   */
  private bufferKey(serverId: string, name: string): string {
    const server = this.servers.get(serverId);
    if (!server || server.buffers[name]) return name;
    return server.bufferOrder.find((b) => sameNick(b, name)) ?? name;
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
    if (key === STATUS_BUFFER || sameNick(to, STATUS_BUFFER)) return;
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

  private pushMessage(
    serverId: string,
    targetName: string,
    message: ChatMessage,
  ): void {
    const server = this.servers.get(serverId);
    const bufferName = this.bufferKey(serverId, targetName);
    const buf = this.ensureBuffer(serverId, bufferName);
    if (!server || !buf) return;

    // Deduplicate history / replay messages by msgid or (timestamp + sender + text)
    if (message.isHistory) {
      const msgTime = message.timestamp.getTime();
      const isDup = buf.messages.some(
        (m) =>
          (message.msgid && m.msgid === message.msgid) ||
          (m.from === message.from &&
            m.text === message.text &&
            Math.abs(m.timestamp.getTime() - msgTime) < 2000),
      );
      if (isDup) return;
    }

    // A history line that arrived while the connection was down counts as unread, and
    // as a mention if it is for you. See missed.ts.
    const ctrl = this.controls.get(serverId);
    const missed = isMissedLine(ctrl?.missed, bufferName, message);
    if (missed && isMissedMention(ctrl!.missed!, buf.kind, message, server.nick, mentionsNick)) {
      message = { ...message, isMention: true };
    }

    // Live lines go at the end. History lines (CHATHISTORY playback, /history BEFORE)
    // are inserted in time order; the scan from the end replaces a full re-sort.
    const messages = [...buf.messages];
    let at = messages.length;
    if (message.isHistory) {
      const t = message.timestamp.getTime();
      while (at > 0 && messages[at - 1]!.timestamp.getTime() > t) at--;
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
    const countsAsUnread =
      !isActive &&
      (!message.isHistory || missed) &&
      !message.isSelf &&
      (message.kind === "message" || message.kind === "action");

    server.buffers = {
      ...server.buffers,
      [bufferName]: {
        ...buf,
        messages,
        messageLimit: limit,
        unread: countsAsUnread ? buf.unread + 1 : buf.unread,
        hasMention: countsAsUnread && message.isMention ? true : buf.hasMention,
        firstUnreadId:
          countsAsUnread && !buf.firstUnreadId ? message.id : buf.firstUnreadId,
      },
    };
    this.emit();

    if (message.isMention && !message.isHistory && !message.isSelf) {
      const event: MentionEvent = {
        serverId,
        bufferName,
        bufferKind: buf.kind,
        kind: message.kind,
        from: message.from ?? "",
        text: message.text,
        isActiveBuffer: isActive,
      };
      for (const listener of this.mentionListeners) listener(event);
    } else if (missed && message.isMention) {
      this.queueMissedMention(serverId, {
        serverId,
        bufferName,
        bufferKind: buf.kind,
        kind: message.kind,
        from: message.from ?? "",
        text: message.text,
        isActiveBuffer: isActive,
      });
    }
  }

  /** Remembers what honk knew when a registered connection is lost. See missed.ts. */
  private noteConnectionLost(serverId: string, ctrl: ServerControl): void {
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

  private clearUnreadDivider(serverId: string, bufferName: string): void {
    const server = this.servers.get(serverId);
    const buf = server?.buffers[bufferName];
    if (server && buf?.firstUnreadId) {
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
    const buf = server.buffers[bufferName];
    if (!buf) return;

    // Clear the unread divider on the buffer we are leaving
    if (
      this.active &&
      (this.active.serverId !== serverId || this.active.buffer !== bufferName)
    ) {
      this.clearUnreadDivider(this.active.serverId, this.active.buffer);
    }

    this.active = { serverId, buffer: bufferName };
    if (buf.unread > 0 || buf.hasMention) {
      server.buffers = {
        ...server.buffers,
        [bufferName]: { ...buf, unread: 0, hasMention: false },
      };
    }
    this.emit();
  }

  openDm(serverId: string, nick: string): void {
    this.ensureBuffer(serverId, nick, "dm");
    this.setActive(serverId, nick);
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
              (kind === "dm" || mentionsNick(line.text, DEMO_NICK)),
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
    if (this.active) this.clearUnreadDivider(this.active.serverId, this.active.buffer);
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
        isMention: isDm || mentionsNick(event.text, server.nick),
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
      const others = buf.users.filter((u) => !sameNick(u.nick, server.nick));
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
            this.pushMessage(id, target, makeMessage("join", `${server.nick} joined ${target}`));
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
              buf.users.map((u) => (sameNick(u.nick, old) ? { ...u, nick: next } : u)),
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
          const user = server.buffers[name]?.users.find((u) => sameNick(u.nick, args[0]));
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
      this.clearUnreadDivider(serverId, buffer);
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

    client.privmsg(buffer, raw);
    this.clearUnreadDivider(serverId, buffer);
    this.pushSent(serverId, client, buffer, makeMessage("message", raw, { from: server.nick }));
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
        reply("Press Ctrl+K for the omnibox, then ? to see what it does.");
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
          client.privmsg(target, text);
          this.pushSent(server.id, client, target, makeMessage("message", text, { from: server.nick }));
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
        client.action(activeBuffer, rest);
        this.pushSent(server.id, client, activeBuffer, makeMessage("action", rest, { from: server.nick }));
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
        const oldest = buf?.messages.find(
          (m) => m.kind === "message" || m.kind === "action" || m.kind === "notice",
        );
        const label = client.state.caps.enabled.has("labeled-response")
          ? `history-${++historyLabels}`
          : undefined;
        this.getControl(server.id).historyRequests.push({ target: nameKey(activeBuffer), label });
        const [subcommand, anchor] = oldest
          ? (["BEFORE", `timestamp=${oldest.timestamp.toISOString()}`] as const)
          : (["LATEST", "*"] as const);
        requestHistory(client, subcommand, activeBuffer, anchor, limit, label);
        return;
      }

      case "clear": {
        if (!server) return;
        const buf = server.buffers[activeBuffer];
        if (!buf) return;
        server.buffers = {
          ...server.buffers,
          [activeBuffer]: { ...buf, messages: [], messageLimit: undefined },
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
