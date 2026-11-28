/**
 * A fake IRC server for testing honk by hand and from `bun test`. It is not a real ircd:
 * it keeps just enough state (clients, channels, fake users, history) to look like one,
 * and it has methods to make things happen (someone talks, a join fails, the link drops).
 *
 *   const irc = await FakeIrcd.start({ port: 0, network: "alpha" });
 *   irc.say("alice", "#honk", "hi there");
 *   irc.ban("#secret");          // JOIN #secret now gets 474
 *   await irc.stop();
 *
 * dev/fakeircd/cli.ts runs it from the command line, with an HTTP control port.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { type Clock, systemClock } from "../../src/clock.ts";
import {
  LineSplitter,
  parseLine,
  parseTimestampParam,
  timestampParam,
} from "../../src/irc/ircLine.ts";
import { type Casemapping, DEFAULT_CASEMAPPING, nameKey } from "../../src/irc/names.ts";

export interface FakeIrcdOptions {
  /** 0 picks a free port. Default 0. */
  port?: number;
  /** Default 127.0.0.1. */
  host?: string;
  /** The NETWORK= name in 005, which honk shows as the server name. Default "FakeNet". */
  network?: string;
  /** Speak TLS with a self-signed cert made by openssl at start. See `certPath`. */
  tls?: boolean;
  /** Users in a channel the first time someone joins it. Default ["@alice", "+bob", "carol"]. */
  defaultUsers?: string[];
  /** Called with every line in and out, such as "[1] << NICK goose". */
  log?: (line: string) => void;
  /** Wait this long after a TCP connect before answering anything. Default 0. */
  acceptDelayMs?: number;
  /**
   * The CASEMAPPING= in 005, which also decides which names are the same here. null
   * sends none, and names fold as rfc1459, as the spec says. Default "ascii".
   */
  casemapping?: Casemapping | null;
}

export interface ClientInfo {
  id: number;
  nick: string | null;
  registered: boolean;
  caps: string[];
  channels: string[];
  account: string | null;
}

/** A line a client sent, as parsed by the server. */
export interface ReceivedLine {
  client: number;
  raw: string;
  command: string;
  params: string[];
}

interface Client {
  id: number;
  sock: Socket;
  nick: string | null;
  user: string | null;
  registered: boolean;
  capNegotiating: boolean;
  caps: Set<string>;
  saslPending: boolean;
  account: string | null;
}

interface Member {
  nick: string;
  /** Mode prefix: "@", "+" or "". */
  prefix: string;
  client?: Client;
}

interface Channel {
  name: string;
  topic: string;
  topicBy: string;
  key: string | null;
  members: Map<string, Member>;
}

interface StoredMessage {
  time: number;
  msgid: string;
  from: string;
  /** An EVENT plays back as `text`, such as "JOIN #honk": see onChathistory. */
  command: "PRIVMSG" | "NOTICE" | "EVENT";
  /** The channel. A QUIT or NICK is kept once in each channel the nick was in. */
  target: string;
  text: string;
}

const SERVER_NAME = "fake.irc";
const CAPS = [
  "batch",
  "draft/chathistory",
  "draft/event-playback",
  "draft/message-redaction",
  "draft/read-marker",
  "echo-message",
  "labeled-response",
  "message-tags",
  "sasl",
  "server-time",
];
/** Mode letters and prefixes, highest first, as sent in 005 PREFIX. */
const PREFIXES = "@+";
const FILLER_NICKS = ["alice", "bob", "carol"];

const isChannel = (s: string) => s.startsWith("#");
const hostmask = (nick: string) => `${nick}!${nick.toLowerCase()}@fake.host`;

/** Makes a self-signed cert for localhost and 127.0.0.1. Needs openssl on the PATH. */
function makeCert(): { cert: string; key: string; certPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "fakeircd-"));
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  return {
    cert: readFileSync(certPath, "utf-8"),
    key: readFileSync(keyPath, "utf-8"),
    certPath,
    dir,
  };
}

export class FakeIrcd {
  readonly network: string;
  /** See FakeIrcdOptions.casemapping. Tests may change it; new clients see the change. */
  casemapping: Casemapping | null;
  readonly host: string;
  /** The port it listens on (useful with `port: 0`). */
  port = 0;
  /** With `tls`: the cert to trust, for example NODE_EXTRA_CA_CERTS=<certPath> honk. */
  certPath: string | null = null;
  /** Every line clients sent, oldest first. */
  readonly received: ReceivedLine[] = [];
  /** Milliseconds to wait before answering a new connection. */
  acceptDelayMs: number;
  /** SASL logins fail with 904 while this is true. */
  rejectSasl = false;
  /** CHATHISTORY gets a FAIL and no batch while this is true. */
  failHistory = false;
  /** While set, echo-message echoes wait in heldEchoes until releaseEchoes(). */
  holdEchoes = false;
  private heldEchoes: (() => void)[] = [];
  /** Lowercase targets whose CHATHISTORY gets a FAIL and no batch, as failHistory does. */
  readonly failHistoryIn = new Set<string>();
  /** CHATHISTORY TARGETS gets a FAIL and no batch while this is true. */
  failTargets = false;
  /** Lowercase nicks that CHATHISTORY TARGETS leaves out, as a server may (ircv3-specifications#604). */
  readonly hiddenTargets = new Set<string>();
  /** Lowercase targets whose CHATHISTORY gets no reply until releaseHistory(). */
  readonly holdHistoryIn = new Set<string>();
  private heldHistory: (() => void)[] = [];
  /**
   * Offer labeled-response, so CHATHISTORY's reply carries the request's label. Set it
   * before a client connects: CAP LS reads it.
   */
  labeledResponse = true;
  /** Offer draft/read-marker. Set it before a client connects: CAP LS reads it. */
  readMarkerCap = true;
  /** MARKREAD from clients is dropped without a reply while this is true, like a lost line. */
  ignoreMarkRead = false;
  /** MARKREAD from clients gets "FAIL MARKREAD INTERNAL_ERROR" while this is true, like a soju database error. */
  failMarkRead = false;
  /** CAP gets 421 (unknown command) while this is true, like a server from before IRCv3. */
  rejectCap = false;
  /**
   * Capabilities CAP LS leaves out, such as "echo-message" for a server without it. Set
   * it before a client connects.
   */
  readonly withheldCaps = new Set<string>();

  private server: Server | null = null;
  /**
   * With `tls`: the listener that speaks TLS, on a free port. The public port forwards to it,
   * because Bun can't start TLS on a socket a plain server accepted.
   */
  private tlsServer: TlsServer | null = null;
  private tlsPort = 0;
  private tlsCert: { cert: string; key: string; dir: string } | null = null;
  private clients = new Set<Client>();
  /** Every TCP socket, also ones still waiting out `acceptDelayMs`, so stop() can close them. */
  private sockets = new Set<Socket>();
  private channels = new Map<string, Channel>();
  private history: StoredMessage[] = [];
  private banned = new Set<string>();
  private silent = new Set<string>();
  private forwards = new Map<string, string>();
  /** Nicks NICK gets 437 for, like a network that holds a nick for a while after its user leaves. */
  private held = new Set<string>();
  /** Away messages by folded nick (see lower). */
  private away = new Map<string, string>();
  /**
   * Read markers (draft/read-marker) in ms, by folded target. Shared by every client,
   * like one bouncer user's clients: one reads #honk, the others hear about it.
   */
  private readMarkers = new Map<string, number>();
  private defaultUsers: string[];
  private logFn: (line: string) => void;
  private nextClientId = 1;
  private nextMsgId = 1;
  private nextBatch = 1;
  private waiters: { match: (l: ReceivedLine) => boolean; resolve: (l: ReceivedLine) => void }[] =
    [];

  /** A nick or channel name folded with this server's CASEMAPPING, for use as a map key. */
  private lower(name: string): string {
    return nameKey(name, this.casemapping ?? DEFAULT_CASEMAPPING);
  }

  private constructor(opts: FakeIrcdOptions) {
    this.network = opts.network ?? "FakeNet";
    this.casemapping = opts.casemapping ?? "ascii";
    this.host = opts.host ?? "127.0.0.1";
    this.defaultUsers = opts.defaultUsers ?? ["@alice", "+bob", "carol"];
    this.logFn = opts.log ?? (() => {});
    this.acceptDelayMs = opts.acceptDelayMs ?? 0;
  }

  static async start(opts: FakeIrcdOptions = {}): Promise<FakeIrcd> {
    const irc = new FakeIrcd(opts);
    if (opts.tls) {
      const made = makeCert();
      irc.tlsCert = made;
      irc.certPath = made.certPath;
      const inner = createTlsServer({ cert: made.cert, key: made.key }, (sock) => irc.attach(sock));
      inner.on("tlsClientError", () => {});
      irc.tlsServer = inner;
      await new Promise<void>((resolve) => inner.listen(0, "127.0.0.1", () => resolve()));
      const innerAddr = inner.address();
      irc.tlsPort = typeof innerAddr === "object" && innerAddr ? innerAddr.port : 0;
    }
    const server = createServer((sock) => irc.accept(sock));
    irc.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 0, irc.host, () => resolve());
    });
    const addr = server.address();
    irc.port = typeof addr === "object" && addr ? addr.port : 0;
    irc.log(`-- ${irc.network} listening on ${irc.host}:${irc.port}${opts.tls ? " (TLS)" : ""}`);
    return irc;
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.sock.destroy();
    for (const s of this.sockets) s.destroy();
    this.clients.clear();
    this.sockets.clear();
    for (const srv of [this.server, this.tlsServer]) {
      if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    this.server = null;
    this.tlsServer = null;
    if (this.tlsCert) rmSync(this.tlsCert.dir, { recursive: true, force: true });
  }

  // ---- What tests and the control port use ----

  clientList(): ClientInfo[] {
    return [...this.clients].map((c) => ({
      id: c.id,
      nick: c.nick,
      registered: c.registered,
      caps: [...c.caps],
      channels: [...this.channels.values()]
        .filter((ch) => c.nick && ch.members.get(this.lower(c.nick))?.client === c)
        .map((ch) => ch.name),
      account: c.account,
    }));
  }

  /** The channels and their members, such as { "#honk": ["@alice", "+bob", "goose"] }. */
  channelList(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const ch of this.channels.values()) out[ch.name] = this.names(ch);
    return out;
  }

  /** Resolves with the next line a client sends that matches. Rejects after `timeoutMs`. */
  waitFor(match: (l: ReceivedLine) => boolean, timeoutMs = 2000): Promise<ReceivedLine> {
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i === -1) return;
        this.waiters.splice(i, 1);
        reject(new Error(`fakeircd: no matching line within ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  /** A fake user (or any nick) speaks in a channel or to a client. `ctcp` wraps it, as in "VERSION". */
  say(
    from: string,
    target: string,
    text: string,
    opts: { notice?: boolean; ctcp?: string } = {},
  ): void {
    const command = opts.notice ? "NOTICE" : "PRIVMSG";
    const body = opts.ctcp ? `\x01${opts.ctcp}${text ? ` ${text}` : ""}\x01` : text;
    if (isChannel(target)) {
      const ch = this.ensureChannel(target);
      if (!ch.members.has(this.lower(from))) this.addMember(ch, from, "");
      this.deliver(from, command, ch.name, body, null);
    } else {
      this.deliver(from, command, target, body, null);
    }
  }

  /**
   * Sets the read marker for a target, as another client of yours would. Clients with
   * draft/read-marker hear about it.
   */
  setReadMarker(target: string, ms: number): void {
    this.readMarkers.set(this.lower(target), ms);
    for (const c of this.clients) this.sendMarkRead(c, target);
  }

  /**
   * The server's clock, for every server time it sends or stores. A test sets it to put
   * many messages in one millisecond.
   */
  now: Clock["now"] = systemClock.now;

  /** The server time, in ms, of the stored message with this text, or undefined. */
  storedTime(text: string): number | undefined {
    return this.history.find((m) => m.text === text)?.time;
  }

  /** The read marker for a target in ms, or undefined if nobody set one. */
  readMarker(target: string): number | undefined {
    return this.readMarkers.get(this.lower(target));
  }

  /** A fake user joins a channel. */
  join(nick: string, channel: string, prefix = ""): void {
    const ch = this.ensureChannel(channel);
    if (ch.members.has(this.lower(nick))) return;
    this.addMember(ch, nick, prefix);
    this.channelEvent(ch, nick, `JOIN ${ch.name}`);
  }

  /** Sends `event`, such as "PART #honk :bye", by `nick` to the members of `ch`, and keeps it. */
  private channelEvent(ch: Channel, nick: string, event: string): void {
    this.toMembers(ch, `:${hostmask(nick)} ${event}`, undefined, this.storeEvent(nick, [ch.name], event));
  }

  /**
   * Keeps an Event, such as "PART #honk :bye", in the history of each of `channels`, as
   * Ergo does. Returns the tags for the live line: the same msgid and time.
   */
  private storeEvent(nick: string, channels: string[], event: string): { msgid: string; time: string } {
    const time = this.now();
    const msgid = `m${this.nextMsgId++}`;
    for (const target of channels) {
      this.history.push({ time, msgid, from: nick, command: "EVENT", target, text: event });
    }
    return { msgid, time: new Date(time).toISOString() };
  }

  part(nick: string, channel: string, reason = ""): void {
    const ch = this.channels.get(this.lower(channel));
    const m = ch?.members.get(this.lower(nick));
    if (!ch || !m) return;
    this.channelEvent(ch, m.nick, `PART ${ch.name}${reason ? ` :${reason}` : ""}`);
    ch.members.delete(this.lower(nick));
  }

  /** A fake user, or a client by nick, quits the network. A client's connection is closed. */
  quit(nick: string, reason = "Quit"): void {
    const client = this.clientByNick(nick);
    if (client) {
      this.dropClient(client, reason);
      return;
    }
    const event = `QUIT :${reason}`;
    this.leaveAll(nick, `:${hostmask(nick)} ${event}`, undefined, this.storeEvent(nick, this.channelsOf(nick), event));
  }

  /** The names of the channels `nick` is in. */
  private channelsOf(nick: string): string[] {
    return [...this.channels.values()].filter((ch) => ch.members.has(this.lower(nick))).map((ch) => ch.name);
  }

  /** A fake user changes nick. */
  renick(from: string, to: string): void {
    if (this.clientByNick(from))
      throw new Error(`fakeircd: ${from} is a client; it changes its own nick`);
    const event = `NICK :${to}`;
    const line = `:${hostmask(from)} ${event}`;
    const tags = this.storeEvent(from, this.channelsOf(from), event);
    const told = new Set<Client>();
    for (const ch of this.channels.values()) {
      const m = ch.members.get(this.lower(from));
      if (!m) continue;
      ch.members.delete(this.lower(from));
      ch.members.set(this.lower(to), { ...m, nick: to });
      for (const other of ch.members.values()) if (other.client) told.add(other.client);
    }
    for (const c of told) this.send(c, line, tags);
  }

  kick(by: string, channel: string, nick: string, reason = ""): void {
    const ch = this.channels.get(this.lower(channel));
    const m = ch?.members.get(this.lower(nick));
    if (!ch || !m) return;
    this.channelEvent(ch, by, `KICK ${ch.name} ${m.nick} :${reason || by}`);
    ch.members.delete(this.lower(nick));
  }

  setTopic(channel: string, text: string, by = "alice"): void {
    const ch = this.ensureChannel(channel);
    ch.topic = text;
    ch.topicBy = by;
    this.channelEvent(ch, by, `TOPIC ${ch.name} :${text}`);
  }

  /** Replaces the fake users of a channel, such as ["@alice", "dave"]. Clients stay. */
  setUsers(channel: string, users: string[]): void {
    const ch = this.ensureChannel(channel);
    for (const [key, m] of ch.members) if (!m.client) ch.members.delete(key);
    for (const u of users) {
      const prefix = PREFIXES.includes(u[0]!) ? u[0]! : "";
      this.addMember(ch, u.slice(prefix.length), prefix);
    }
  }

  /** JOIN gets 475 without this key. null removes it. */
  setKey(channel: string, key: string | null): void {
    this.ensureChannel(channel).key = key;
  }

  /** Marks a nick away: messages to it get 301, and WHOIS shows it. null comes back. */
  setAway(nick: string, text: string | null): void {
    if (text) this.away.set(this.lower(nick), text);
    else this.away.delete(this.lower(nick));
  }

  /** NICK `nick` gets 437 (temporarily unavailable). */
  holdNick(nick: string): void {
    this.held.add(this.lower(nick));
  }

  /** JOIN gets 474 (banned). */
  ban(channel: string): void {
    this.banned.add(this.lower(channel));
  }
  unban(channel: string): void {
    this.banned.delete(this.lower(channel));
  }
  /** JOIN gets no reply at all. */
  silence(channel: string): void {
    this.silent.add(this.lower(channel));
  }
  unsilence(channel: string): void {
    this.silent.delete(this.lower(channel));
  }
  /** JOIN `from` gets 470 and lands in `to`. null removes it. */
  forward(from: string, to: string | null): void {
    if (to) this.forwards.set(this.lower(from), to);
    else this.forwards.delete(this.lower(from));
  }

  /**
   * Adds `count` made-up older lines to a channel's history, before everything stored,
   * one minute apart. CHATHISTORY serves them like real ones.
   */
  fillHistory(channel: string, count: number): void {
    const ch = this.ensureChannel(channel);
    const oldest =
      this.history.find((m) => this.lower(m.target) === this.lower(ch.name))?.time ?? this.now();
    const lines: StoredMessage[] = [];
    for (let i = count; i >= 1; i--) {
      const from = FILLER_NICKS[i % FILLER_NICKS.length]!;
      lines.push({
        time: oldest - i * 60_000,
        msgid: `fill${this.nextMsgId++}`,
        from,
        command: "PRIVMSG",
        target: ch.name,
        text: `older line ${count - i + 1} of ${count}`,
      });
    }
    this.history = [...lines, ...this.history];
  }

  /**
   * Sends a raw line to every registered client, or one. "$NICK" becomes the client's
   * nick. Tags the line starts with replace the server's own, but only those the client
   * asked for go out, as from a real server (batch, time, msgid, label):
   * "@time=2026-11-27T21:35:07.000Z :alice!a@h PRIVMSG #honk :lol".
   */
  sendRaw(line: string, clientId?: number): number {
    let n = 0;
    for (const c of this.clients) {
      if (!c.registered || (clientId !== undefined && c.id !== clientId)) continue;
      const out = line.replaceAll("$NICK", c.nick ?? "*");
      if (!out.startsWith("@")) {
        this.send(c, out);
      } else {
        const space = out.indexOf(" ");
        const tags: Record<string, string> = {};
        for (const tag of out.slice(1, space).split(";")) {
          const [key = "", ...value] = tag.split("=");
          tags[key] = value.join("=");
        }
        this.send(c, out.slice(space + 1), tags);
      }
      n++;
    }
    return n;
  }

  /** Closes client connections without a QUIT, like a dropped link. All clients if no id. */
  drop(clientId?: number): number {
    let n = 0;
    for (const c of [...this.clients]) {
      if (clientId !== undefined && c.id !== clientId) continue;
      this.log(`[${c.id}] -- dropped`);
      c.sock.destroy();
      n++;
    }
    return n;
  }

  // ---- Connections ----

  private accept(raw: Socket): void {
    raw.on("error", () => {});
    this.sockets.add(raw);
    raw.on("close", () => this.sockets.delete(raw));
    if (this.acceptDelayMs > 0) {
      raw.pause();
      this.log(`-- accepted, answering in ${this.acceptDelayMs}ms`);
      setTimeout(() => {
        if (raw.destroyed) return;
        this.handOff(raw);
      }, this.acceptDelayMs);
    } else {
      this.handOff(raw);
    }
  }

  /** Plain: serve the socket here. TLS: pipe it to the TLS listener, which serves it. */
  private handOff(raw: Socket): void {
    if (!this.tlsServer) {
      raw.resume();
      this.attach(raw);
      return;
    }
    const inner = netConnect(this.tlsPort, "127.0.0.1");
    this.sockets.add(inner);
    inner.on("close", () => {
      this.sockets.delete(inner);
      raw.destroy();
    });
    inner.on("error", () => raw.destroy());
    raw.on("close", () => inner.destroy());
    raw.pipe(inner);
    inner.pipe(raw);
    raw.resume();
  }

  private attach(sock: Socket): void {
    sock.on("error", () => {});
    const c: Client = {
      id: this.nextClientId++,
      sock,
      nick: null,
      user: null,
      registered: false,
      capNegotiating: false,
      caps: new Set(),
      saslPending: false,
      account: null,
    };
    this.clients.add(c);
    this.log(`[${c.id}] -- connected`);
    const lines = new LineSplitter((line) => this.onLine(c, line));
    sock.on("data", (data: Buffer) => lines.push(data));
    const gone = () => this.forget(c, "Connection closed");
    sock.on("close", gone);
    sock.on("error", gone);
  }

  /** Removes a client from the network and tells the channels it shared. Runs once. */
  private forget(c: Client, reason: string): void {
    if (!this.clients.delete(c)) return;
    this.log(`[${c.id}] -- gone (${c.nick ?? "no nick"}): ${reason}`);
    if (c.nick && c.registered) this.leaveAll(c.nick, `:${hostmask(c.nick)} QUIT :${reason}`, c);
  }

  /**
   * Closes a client's link with an ERROR line. Like a real server, the nick is free at
   * once, not when the socket finishes closing, so a quick reconnect can take it back.
   */
  private dropClient(c: Client, reason: string): void {
    this.send(c, `ERROR :Closing link (${reason})`);
    c.sock.end();
    this.forget(c, reason);
  }

  private log(line: string): void {
    this.logFn(line);
  }

  private send(c: Client, line: string, tags: Record<string, string> = {}): void {
    const all: Record<string, string> = {};
    if (tags.batch && c.caps.has("batch")) all.batch = tags.batch;
    if (c.caps.has("server-time")) all.time = tags.time ?? new Date(this.now()).toISOString();
    if (tags.msgid && c.caps.has("message-tags")) all.msgid = tags.msgid;
    if (tags.label && c.caps.has("labeled-response")) all.label = tags.label;
    const tagStr = Object.entries(all)
      .map(([k, v]) => (v ? `${k}=${v}` : k))
      .join(";");
    const out = tagStr ? `@${tagStr} ${line}` : line;
    this.log(`[${c.id}] >> ${out}`);
    if (!c.sock.destroyed) c.sock.write(out + "\r\n");
  }

  private reply(c: Client, numeric: string, rest: string): void {
    this.send(c, `:${SERVER_NAME} ${numeric} ${c.nick ?? "*"} ${rest}`);
  }

  private clientByNick(nick: string): Client | undefined {
    for (const c of this.clients) if (c.nick && this.lower(c.nick) === this.lower(nick)) return c;
    return undefined;
  }

  private nickTaken(nick: string, except: Client): boolean {
    const c = this.clientByNick(nick);
    return (c !== undefined && c !== except) || this.isFakeUser(nick);
  }

  // ---- Channels ----

  private ensureChannel(name: string): Channel {
    let ch = this.channels.get(this.lower(name));
    if (!ch) {
      ch = { name, topic: "", topicBy: "", key: null, members: new Map() };
      this.channels.set(this.lower(name), ch);
      for (const u of this.defaultUsers) {
        const prefix = PREFIXES.includes(u[0]!) ? u[0]! : "";
        this.addMember(ch, u.slice(prefix.length), prefix);
      }
    }
    return ch;
  }

  private addMember(ch: Channel, nick: string, prefix: string, client?: Client): void {
    ch.members.set(this.lower(nick), { nick, prefix, client });
  }

  private names(ch: Channel): string[] {
    const rank = (p: string) => (p ? PREFIXES.indexOf(p) : PREFIXES.length);
    return [...ch.members.values()]
      .sort((a, b) => rank(a.prefix) - rank(b.prefix) || a.nick.localeCompare(b.nick))
      .map((m) => m.prefix + m.nick);
  }

  private toMembers(
    ch: Channel,
    line: string,
    except?: Client,
    tags?: Record<string, string>,
  ): void {
    for (const m of ch.members.values()) {
      if (m.client && m.client !== except) this.send(m.client, line, tags);
    }
  }

  /** Removes a nick from every channel and tells everyone who shared one. */
  private leaveAll(nick: string, line: string, except?: Client, tags?: Record<string, string>): void {
    const told = new Set<Client>();
    for (const ch of this.channels.values()) {
      if (!ch.members.delete(this.lower(nick))) continue;
      for (const m of ch.members.values()) if (m.client && m.client !== except) told.add(m.client);
    }
    for (const c of told) this.send(c, line, tags);
  }

  /** Delivers a PRIVMSG or NOTICE, stores it for CHATHISTORY, and echoes it to `sender`. */
  private deliver(
    from: string,
    command: "PRIVMSG" | "NOTICE",
    target: string,
    text: string,
    sender: Client | null,
  ): void {
    const msg: StoredMessage = {
      time: this.now(),
      msgid: `m${this.nextMsgId++}`,
      from,
      command,
      target,
      text,
    };
    this.history.push(msg);
    const tags = { msgid: msg.msgid, time: new Date(msg.time).toISOString() };
    const line = `:${hostmask(from)} ${command} ${target} :${text}`;
    if (isChannel(target)) {
      const ch = this.channels.get(this.lower(target));
      if (ch) this.toMembers(ch, line, sender ?? undefined, tags);
    } else {
      const to = this.clientByNick(target);
      if (to && to !== sender) this.send(to, line, tags);
    }
    if (sender?.caps.has("echo-message")) {
      if (this.holdEchoes) this.heldEchoes.push(() => this.send(sender, line, tags));
      else this.send(sender, line, tags);
    }
  }

  /** Sends the echoes held by holdEchoes, in order, and stops holding them. */
  releaseEchoes(): void {
    this.holdEchoes = false;
    for (const send of this.heldEchoes.splice(0)) send();
  }

  /** How many echoes holdEchoes is holding. */
  get heldEchoCount(): number {
    return this.heldEchoes.length;
  }

  // ---- Client commands ----

  private onLine(c: Client, raw: string): void {
    this.log(`[${c.id}] << ${raw}`);
    const { tags, command, params } = parseLine(raw);
    const rec: ReceivedLine = { client: c.id, raw, command, params };
    this.received.push(rec);
    for (const w of [...this.waiters]) {
      if (w.match(rec)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(rec);
      }
    }

    const before = ["CAP", "NICK", "USER", "PASS", "AUTHENTICATE", "PING", "PONG", "QUIT"];
    if (!c.registered && !before.includes(command)) {
      return this.reply(c, "451", ":You have not registered");
    }
    switch (command) {
      case "CAP":
        return this.onCap(c, params);
      case "PASS":
        return;
      case "AUTHENTICATE":
        return this.onAuthenticate(c, params[0] ?? "");
      case "NICK":
        return this.onNick(c, params[0] ?? "");
      case "USER":
        c.user = params[0] ?? "user";
        return this.tryRegister(c);
      case "PING":
        return this.send(c, `:${SERVER_NAME} PONG ${SERVER_NAME} :${params[0] ?? ""}`);
      case "PONG":
        return;
      case "QUIT":
        return this.dropClient(c, params[0] ?? "Quit");
      case "JOIN":
        return this.onJoin(c, params);
      case "PART":
        return this.onPart(c, params);
      case "PRIVMSG":
      case "NOTICE":
        return this.onMessage(c, command, params);
      case "TAGMSG":
      case "AWAY":
        return;
      case "TOPIC":
        return this.onTopic(c, params);
      case "NAMES": {
        const ch = this.channels.get(this.lower(params[0] ?? ""));
        if (ch) return this.sendNames(c, ch);
        return this.reply(c, "366", `${params[0] ?? "*"} :End of /NAMES list.`);
      }
      case "WHOIS":
        return this.onWhois(c, params[params.length - 1] ?? "");
      case "WHO":
        return this.reply(c, "315", `${params[0] ?? "*"} :End of /WHO list.`);
      case "MODE": {
        const target = params[0] ?? "";
        if (isChannel(target) && params.length === 1) return this.reply(c, "324", `${target} +nt`);
        return;
      }
      case "CHATHISTORY":
        return this.onChathistory(c, params, tags.label);
      case "MARKREAD":
        return this.onMarkRead(c, params);
      default:
        return this.unknownCommand(c, command);
    }
  }

  private unknownCommand(c: Client, command: string): void {
    this.reply(c, "421", `${command} :Unknown command`);
  }

  /** The capabilities CAP LS offers. */
  private caps(): string[] {
    return CAPS.filter(
      (x) =>
        !this.withheldCaps.has(x) &&
        (this.labeledResponse || x !== "labeled-response") &&
        (this.readMarkerCap || x !== "draft/read-marker"),
    );
  }

  private onCap(c: Client, params: string[]): void {
    if (this.rejectCap) return this.unknownCommand(c, "CAP");
    const sub = (params[0] ?? "").toUpperCase();
    const me = c.registered ? c.nick! : "*";
    if (sub === "LS") {
      c.capNegotiating = true;
      this.send(c, `:${SERVER_NAME} CAP ${me} LS :${this.caps().join(" ")}`);
    } else if (sub === "LIST") {
      this.send(c, `:${SERVER_NAME} CAP ${me} LIST :${[...c.caps].join(" ")}`);
    } else if (sub === "REQ") {
      c.capNegotiating = true;
      const wanted = (params[1] ?? "").split(" ").filter(Boolean);
      const ok = wanted.every((w) => this.caps().includes(w.replace(/^-/, "")));
      if (!ok) {
        this.send(c, `:${SERVER_NAME} CAP ${me} NAK :${wanted.join(" ")}`);
        return;
      }
      for (const w of wanted) {
        if (w.startsWith("-")) c.caps.delete(w.slice(1));
        else c.caps.add(w);
      }
      this.send(c, `:${SERVER_NAME} CAP ${me} ACK :${wanted.join(" ")}`);
    } else if (sub === "END") {
      c.capNegotiating = false;
      this.tryRegister(c);
    }
  }

  /** SASL PLAIN. Any account and password is accepted. */
  private onAuthenticate(c: Client, arg: string): void {
    if (arg.toUpperCase() === "PLAIN") {
      c.saslPending = true;
      this.send(c, "AUTHENTICATE +");
      return;
    }
    if (!c.saslPending) {
      this.reply(c, "904", ":SASL authentication failed");
      return;
    }
    c.saslPending = false;
    if (this.rejectSasl) {
      this.reply(c, "904", ":SASL authentication failed");
      return;
    }
    const parts = Buffer.from(arg, "base64").toString("utf-8").split("\0");
    const account = parts[1] || parts[0] || "user";
    c.account = account;
    this.reply(
      c,
      "900",
      `${hostmask(c.nick ?? account)} ${account} :You are now logged in as ${account}`,
    );
    this.reply(c, "903", ":SASL authentication successful");
  }

  private onNick(c: Client, nick: string): void {
    if (!nick) return this.reply(c, "431", ":No nickname given");
    if (this.nickTaken(nick, c)) return this.reply(c, "433", `${nick} :Nickname is already in use`);
    if (this.held.has(this.lower(nick))) {
      return this.reply(c, "437", `${nick} :Nick/channel is temporarily unavailable`);
    }
    if (!c.registered || !c.nick) {
      c.nick = nick;
      return this.tryRegister(c);
    }
    const old = c.nick;
    const line = `:${hostmask(old)} NICK :${nick}`;
    c.nick = nick;
    const told = new Set<Client>([c]);
    for (const ch of this.channels.values()) {
      const m = ch.members.get(this.lower(old));
      if (!m || m.client !== c) continue;
      ch.members.delete(this.lower(old));
      ch.members.set(this.lower(nick), { ...m, nick });
      for (const other of ch.members.values()) if (other.client) told.add(other.client);
    }
    for (const t of told) this.send(t, line);
  }

  /**
   * Registers the client as soon as NICK and USER are in and CAP negotiation is over, like
   * soju and Ergo. A CAP LS that comes after NICK and USER is too late to hold it.
   */
  private tryRegister(c: Client): void {
    if (c.registered || !c.nick || !c.user || c.capNegotiating) return;
    c.registered = true;
    this.reply(c, "001", `:Welcome to ${this.network}, ${c.nick}`);
    this.reply(c, "002", `:Your host is ${SERVER_NAME}, running fakeircd`);
    this.reply(c, "003", ":This server was created just now");
    this.reply(c, "004", `${SERVER_NAME} fakeircd io bklnt`);
    this.reply(
      c,
      "005",
      [
        `NETWORK=${this.network}`,
        ...(this.casemapping ? [`CASEMAPPING=${this.casemapping}`] : []),
        `CHANTYPES=# PREFIX=(ov)${PREFIXES} CHATHISTORY=200 :are supported by this server`,
      ].join(" "),
    );
    this.reply(c, "375", `:- ${SERVER_NAME} Message of the day -`);
    this.reply(c, "372", `:- This is ${this.network}, a fake IRC server for testing honk.`);
    this.reply(c, "376", ":End of /MOTD command.");
  }

  private onJoin(c: Client, params: string[]): void {
    const names = (params[0] ?? "").split(",").filter(Boolean);
    const keys = (params[1] ?? "").split(",");
    names.forEach((name, i) => {
      const key = this.lower(name);
      if (!isChannel(name)) return this.reply(c, "403", `${name} :No such channel`);
      if (this.silent.has(key)) return;
      if (this.banned.has(key)) return this.reply(c, "474", `${name} :Cannot join channel (+b)`);
      const to = this.forwards.get(key);
      if (to) {
        this.reply(c, "470", `${name} ${to} :Forwarding to another channel`);
        return this.joinClient(c, to);
      }
      const ch = this.channels.get(key);
      if (ch?.key && ch.key !== keys[i])
        return this.reply(c, "475", `${name} :Cannot join channel (+k)`);
      this.joinClient(c, name);
    });
  }

  private joinClient(c: Client, name: string): void {
    const ch = this.ensureChannel(name);
    const nick = c.nick!;
    if (ch.members.get(this.lower(nick))?.client === c) return;
    this.addMember(ch, nick, "", c);
    this.channelEvent(ch, nick, `JOIN ${ch.name}`);
    // draft/read-marker: the marker goes after the JOIN and before the end of NAMES.
    this.sendMarkRead(c, ch.name);
    if (ch.topic) this.sendTopic(c, ch);
    this.sendNames(c, ch);
  }

  /**
   * MARKREAD <target> [timestamp=...]: without a time, asks for the marker. With one,
   * moves it forward (never back) and tells every client. Like soju, a time in the
   * future becomes now.
   */
  private onMarkRead(c: Client, params: string[]): void {
    if (this.ignoreMarkRead) return;
    const [target, value] = params;
    if (!target) return this.send(c, `:${SERVER_NAME} FAIL MARKREAD NEED_MORE_PARAMS :Missing target`);
    if (this.failMarkRead) {
      return this.send(c, `:${SERVER_NAME} FAIL MARKREAD INTERNAL_ERROR ${target} :Internal error`);
    }
    if (value === undefined) return this.sendMarkRead(c, target);
    const ms = parseTimestampParam(value);
    if (ms === undefined) {
      return this.send(c, `:${SERVER_NAME} FAIL MARKREAD INVALID_PARAMS ${target} :Bad timestamp`);
    }
    const known = this.readMarkers.get(this.lower(target));
    if (known !== undefined && known >= ms) return this.sendMarkRead(c, target);
    this.setReadMarker(target, Math.min(ms, this.now()));
  }

  /** Tells a client with draft/read-marker the marker for a target ("*" if none). */
  private sendMarkRead(c: Client, target: string): void {
    if (!c.registered || !c.nick || !c.caps.has("draft/read-marker")) return;
    const ms = this.readMarkers.get(this.lower(target));
    const value = ms === undefined ? "*" : timestampParam(ms);
    this.send(c, `:${hostmask(c.nick)} MARKREAD ${target} ${value}`);
  }

  /** 332 and 333: the topic and who set it. */
  private sendTopic(c: Client, ch: Channel): void {
    this.reply(c, "332", `${ch.name} :${ch.topic}`);
    this.reply(c, "333", `${ch.name} ${ch.topicBy} ${Math.floor(this.now() / 1000)}`);
  }

  private sendNames(c: Client, ch: Channel): void {
    this.reply(c, "353", `= ${ch.name} :${this.names(ch).join(" ")}`);
    this.reply(c, "366", `${ch.name} :End of /NAMES list.`);
  }

  private onPart(c: Client, params: string[]): void {
    for (const name of (params[0] ?? "").split(",").filter(Boolean)) {
      const ch = this.channels.get(this.lower(name));
      if (!ch || ch.members.get(this.lower(c.nick!))?.client !== c) {
        this.reply(c, "442", `${name} :You're not on that channel`);
        continue;
      }
      this.toMembers(
        ch,
        `:${hostmask(c.nick!)} PART ${ch.name}${params[1] ? ` :${params[1]}` : ""}`,
      );
      ch.members.delete(this.lower(c.nick!));
    }
  }

  private onMessage(c: Client, command: "PRIVMSG" | "NOTICE", params: string[]): void {
    const [targets = "", text = ""] = params;
    for (const target of targets.split(",").filter(Boolean)) {
      if (isChannel(target)) {
        const ch = this.channels.get(this.lower(target));
        if (!ch) {
          if (command === "PRIVMSG") this.reply(c, "403", `${target} :No such channel`);
          continue;
        }
        if (ch.members.get(this.lower(c.nick!))?.client !== c) {
          if (command === "PRIVMSG") this.reply(c, "404", `${target} :Cannot send to channel`);
          continue;
        }
        this.deliver(c.nick!, command, ch.name, text, c);
      } else if (this.clientByNick(target) || this.isFakeUser(target)) {
        this.deliver(c.nick!, command, target, text, c);
        const away = this.away.get(this.lower(target));
        if (away && command === "PRIVMSG") this.reply(c, "301", `${target} :${away}`);
      } else if (command === "PRIVMSG") {
        this.reply(c, "401", `${target} :No such nick/channel`);
      }
    }
  }

  private isFakeUser(nick: string): boolean {
    for (const ch of this.channels.values()) {
      const m = ch.members.get(this.lower(nick));
      if (m && !m.client) return true;
    }
    return false;
  }

  private onTopic(c: Client, params: string[]): void {
    const ch = this.channels.get(this.lower(params[0] ?? ""));
    if (!ch) return this.reply(c, "403", `${params[0] ?? "*"} :No such channel`);
    if (params.length < 2) {
      if (!ch.topic) return this.reply(c, "331", `${ch.name} :No topic is set`);
      return this.sendTopic(c, ch);
    }
    ch.topic = params[1]!;
    ch.topicBy = c.nick!;
    this.toMembers(ch, `:${hostmask(c.nick!)} TOPIC ${ch.name} :${ch.topic}`);
  }

  private onWhois(c: Client, nick: string): void {
    const client = this.clientByNick(nick);
    if (!client && !this.isFakeUser(nick)) {
      this.reply(c, "401", `${nick} :No such nick/channel`);
      return this.reply(c, "318", `${nick} :End of /WHOIS list.`);
    }
    const shown = client?.nick ?? nick;
    const chans = [...this.channels.values()]
      .filter((ch) => ch.members.has(this.lower(nick)))
      .map((ch) => ch.members.get(this.lower(nick))!.prefix + ch.name);
    this.reply(
      c,
      "311",
      `${shown} ~${this.lower(shown)} fake.host * :${shown} the ${client ? "client" : "fake user"}`,
    );
    if (chans.length) this.reply(c, "319", `${shown} :${chans.join(" ")}`);
    this.reply(c, "312", `${shown} ${SERVER_NAME} :${this.network}`);
    const away = this.away.get(this.lower(nick));
    if (away) this.reply(c, "301", `${shown} :${away}`);
    if (client?.account) this.reply(c, "330", `${shown} ${client.account} :is logged in as`);
    this.reply(c, "318", `${shown} :End of /WHOIS list.`);
  }

  /** Answers the CHATHISTORY requests that holdHistoryIn held, and stops holding. */
  releaseHistory(): void {
    this.holdHistoryIn.clear();
    for (const answer of this.heldHistory.splice(0)) answer();
  }

  /**
   * CHATHISTORY LATEST, BEFORE, AFTER and TARGETS, from the stored messages. With
   * labeled-response, the `label` goes on the FAIL or on the opening BATCH line.
   */
  private onChathistory(c: Client, params: string[], label?: string): void {
    const sub = (params[0] ?? "").toUpperCase();
    const labelTag = { label: label ?? "" };
    if (this.holdHistoryIn.has(this.lower(params[1] ?? ""))) {
      this.heldHistory.push(() => this.onChathistory(c, params, label));
      return;
    }
    if (
      this.failHistory ||
      this.failHistoryIn.has(this.lower(params[1] ?? "")) ||
      (this.failTargets && sub === "TARGETS")
    ) {
      this.send(
        c,
        `:${SERVER_NAME} FAIL CHATHISTORY MESSAGE_ERROR ${sub || "*"} ${params[1] ?? "*"} :Messages could not be retrieved`,
        labelTag,
      );
      return;
    }
    const me = this.lower(c.nick!);
    if (sub === "TARGETS") {
      const from = this.anchorTime(params[1]) ?? 0;
      const to = this.anchorTime(params[2]) ?? this.now();
      const latest = new Map<string, number>();
      for (const m of this.history) {
        if (m.time < Math.min(from, to) || m.time > Math.max(from, to) || isChannel(m.target))
          continue;
        const other =
          this.lower(m.from) === me ? m.target : this.lower(m.target) === me ? m.from : null;
        if (other && !this.hiddenTargets.has(this.lower(other))) latest.set(other, m.time);
      }
      const ref = `t${this.nextBatch++}`;
      this.send(c, `:${SERVER_NAME} BATCH +${ref} draft/chathistory-targets`, labelTag);
      for (const [nick, time] of latest) {
        this.send(c, `CHATHISTORY TARGETS ${nick} ${timestampParam(time)}`, {
          batch: ref,
        });
      }
      this.send(c, `:${SERVER_NAME} BATCH -${ref}`);
      return;
    }

    const target = params[1] ?? "";
    const limit = Math.min(200, Number(sub === "BETWEEN" ? params[4] : params[3]) || 50);
    const inTarget = (m: StoredMessage) =>
      isChannel(target)
        ? this.lower(m.target) === this.lower(target)
        : (this.lower(m.from) === me && this.lower(m.target) === this.lower(target)) ||
          (this.lower(m.from) === this.lower(target) && this.lower(m.target) === me);
    let lines = this.history.filter(inTarget);
    const anchor = this.anchorTime(params[2], lines);
    if (sub === "LATEST") {
      if (anchor !== undefined) lines = lines.filter((m) => m.time > anchor);
      lines = lines.slice(-limit);
    } else if (sub === "BEFORE") {
      lines = lines.filter((m) => anchor === undefined || m.time < anchor).slice(-limit);
    } else if (sub === "AFTER") {
      lines = lines.filter((m) => anchor === undefined || m.time > anchor).slice(0, limit);
    } else {
      return this.send(
        c,
        `:${SERVER_NAME} FAIL CHATHISTORY INVALID_PARAMS ${sub} :Unsupported subcommand`,
        labelTag,
      );
    }

    const ref = `h${this.nextBatch++}`;
    this.send(c, `:${SERVER_NAME} BATCH +${ref} chathistory ${target}`, labelTag);
    for (const m of lines) {
      const tags = { batch: ref, time: new Date(m.time).toISOString(), msgid: m.msgid };
      if (m.command !== "EVENT") {
        this.send(c, `:${hostmask(m.from)} ${m.command} ${m.target} :${m.text}`, tags);
      } else if (c.caps.has("draft/event-playback")) {
        this.send(c, `:${hostmask(m.from)} ${m.text}`, tags);
      } else {
        // Like Ergo: without event-playback, an Event plays back as a message from
        // HistServ, with "_" before its msgid. Ergo's text differs per kind ("dave
        // joined the channel"); this one only names the command.
        this.send(
          c,
          `:HistServ!HistServ@${SERVER_NAME} PRIVMSG ${m.target} :${m.from} ${m.text.split(" ")[0]!.toLowerCase()}`,
          { ...tags, msgid: `_${m.msgid}` },
        );
      }
    }
    this.send(c, `:${SERVER_NAME} BATCH -${ref}`);
  }

  /** "timestamp=..." or "msgid=..." to milliseconds. "*" and anything unknown give undefined. */
  private anchorTime(
    anchor: string | undefined,
    lines: StoredMessage[] = this.history,
  ): number | undefined {
    if (!anchor || anchor === "*") return undefined;
    if (anchor.startsWith("timestamp=")) return parseTimestampParam(anchor);
    if (anchor.startsWith("msgid=")) {
      return lines.find((m) => m.msgid === anchor.slice("msgid=".length))?.time;
    }
    return undefined;
  }
}
