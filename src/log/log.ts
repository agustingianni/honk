/**
 * The Log: honk's own record of the Lines from every Network, in one SQLite file:
 *
 *   $XDG_DATA_HOME/honk/logs.db, or ~/.local/share/honk/logs.db
 *
 * IrcManager hands each Line to `add` as it comes. Lines wait in memory and go to the
 * file in one transaction about once a second, or at 100 Lines, and at `close`. If
 * another program locks the file or the disk is full, the Lines stay in memory (up to
 * 10,000) and honk tries again every 5 seconds.
 *
 * Keys (ADR 0002): a Network is the Server `id` plus soju's BOUNCER_NETID ('' when there
 * is none). A Buffer is its name folded with the server's CASEMAPPING, so #Foo[ and
 * #foo{ are one Buffer on an rfc1459 server.
 *
 * Replays (ADR 0003) are decided by the same rule the screen uses, in replay.ts, with
 * the Lines already in the file as the kept Lines:
 *
 *   live:     @msgid=AB12;time=...07.412Z :alice PRIVMSG #honk :lol    -> stored
 *   History:  @time=...07.000Z :alice PRIVMSG #honk :lol               -> Replay, dropped
 *
 * Only one honk writes the file. A second one opens it, says which process writes it,
 * and stores nothing: two writers would store each Line without a msgid twice.
 */

import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { systemClock, type Clock } from "../clock.ts";
import { stripIrcFormatting } from "../notify.ts";
import { type Casemapping, DEFAULT_CASEMAPPING, nameKey } from "../irc/names.ts";
import { checkReplay, type HistoryBatch, type ReplayLine } from "../irc/replay.ts";
import { CHAT_KINDS, checkSqlite, EVENT_KINDS, NewerSchemaError, prepare, sqlList } from "./schema.ts";
import {
  CONTEXT_LINES,
  type LogContext,
  logContext,
  SEARCH_LIMIT,
  type SearchQuery,
  type SearchResult,
  searchLog,
} from "./search.ts";
import { SCROLLBACK_LINES } from "./scrollback.ts";
import { type LineCursor, linesBeside, type StoredLine } from "./storedLine.ts";

/** The `logs` settings in the config file. */
export interface LogSettings {
  /** False turns the Log off. */
  enabled: boolean;
  /** Days to keep Chat lines. 0 keeps them forever. */
  retentionDays: number;
  /** Days to keep Events (joins, parts, quits, nick changes, kicks). 0 keeps them forever. */
  eventRetentionDays: number;
  /** Buffer names never logged on any Server, such as "nickserv". */
  exclude: string[];
}

export const DEFAULT_LOG_SETTINGS: LogSettings = {
  enabled: true,
  retentionDays: 0,
  eventRetentionDays: 30,
  exclude: [],
};

type ChatKind = (typeof CHAT_KINDS)[number];
type EventKind = (typeof EVENT_KINDS)[number];

/** One Line for the Log. */
export interface LogLine {
  kind: ChatKind | EventKind;
  /** Who wrote it or did it. For a nick change, the old nick. */
  nick: string;
  /**
   * What it was done to: the new nick of a nick change, the nick a kick removed.
   * Unset for other kinds.
   */
  subject?: string;
  /** As received, with formatting codes. The reason of a part, quit or kick. */
  text: string;
  /** Unix ms. */
  time: number;
  /** True if `time` is the server's (a time tag), false if honk's clock. */
  timeFromServer: boolean;
  msgid?: string;
  /** Your own Line, confirmed by the server. */
  self?: boolean;
  mention?: boolean;
  /** It came in History, so it may be a Replay. */
  history?: boolean;
}

/** The Buffer a Line goes in. The Log folds `name` with the Network's CASEMAPPING. */
export interface LogBuffer {
  /** As the server sent it, such as "#Honk" or "Alice". */
  name: string;
  kind: "channel" | "dm";
}

/** What the Log knows about the Network a Server reaches. */
export interface LogNetwork {
  /** soju's BOUNCER_NETID, or '' with no bouncer network. */
  bouncerNetId: string;
  /** The NETWORK name, or the Server's name. Shown, never a key. */
  display: string;
  casemapping: Casemapping;
  /** Buffer names this Server never logs (the Server's `logExclude`). */
  exclude: string[];
}

/** Where the Log lives: `$XDG_DATA_HOME/honk/logs.db`, or `~/.local/share/honk/logs.db`. */
export function defaultLogPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "honk", "logs.db");
}

/** How many Lines wait in memory before a write. */
const FLUSH_LINES = 100;
const FLUSH_MS = 1000;
/** How long after a failed write the next try waits. */
const RETRY_MS = 5000;
/** The most Lines kept in memory while writes fail. The oldest go first. */
const MAX_QUEUE = 10_000;
/** How long a write waits for a file another program locks, on the UI thread. */
const WRITE_BUSY_MS = 250;
/**
 * Errors that come from one Line, such as a time that is not a number. Other errors,
 * such as a locked file or a full disk, may go away: the Lines wait for the next try.
 */
const ONE_LINE_ERROR = /^SQLITE_(CONSTRAINT|MISMATCH|TOOBIG|RANGE)/;

function isOneLineError(err: unknown): boolean {
  return ONE_LINE_ERROR.test((err as { code?: string }).code ?? "");
}
/** How many Lines one retention step deletes, so a long delete never stalls the screen. */
const PRUNE_BATCH = 500;
/**
 * How many redactions are kept for Lines the Log does not have yet. A REDACT can come
 * before its Line: in a History batch, the Lines are written when the batch ends.
 */
const MAX_EARLY_REDACTIONS = 500;
const PRUNE_PAUSE_MS = 50;
/**
 * How many free pages one step gives back to the system: about 20 ms. One
 * incremental_vacuum with no count frees them all at once, 0.9 s after a large prune.
 */
const VACUUM_PAGES = 1000;
/** The first retention run waits out the connect and join burst at startup. */
const FIRST_PRUNE_MS = 60_000;
/** How often old Lines are removed while honk runs. */
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The farthest apart a kept Line and History can be and still match (see replay.ts). */
const MATCH_WINDOW_MS = 2000;

interface NetworkSnapshot extends LogNetwork {
  serverId: string;
  /** The `logs.exclude` and `logExclude` names, folded with `casemapping`. */
  excludeKeys: Set<string>;
}

type Op =
  | {
      type: "line";
      net: NetworkSnapshot;
      buffer: LogBuffer & { key: string };
      line: LogLine;
      batch?: HistoryBatch;
    }
  | { type: "redact"; net: NetworkSnapshot; msgid: string; by: string; time: number }
  | { type: "sync"; net: NetworkSnapshot; time: number };

interface KeptRow {
  id: number;
  kind: string;
  nick: string;
  subject: string | null;
  text: string;
  ts: number;
  ts_server: number;
  msgid: string | null;
}

/** A kept row as the Replay rule reads it. */
type KeptLine = ReplayLine & { id: number };

function keptLine(row: KeptRow): KeptLine {
  return {
    id: row.id,
    kind: row.kind,
    from: row.nick,
    subject: row.subject ?? undefined,
    text: row.text,
    timestamp: new Date(row.ts),
    timeFromServer: row.ts_server === 1,
    msgid: row.msgid ?? undefined,
  };
}

/** True if process `pid` runs. EPERM: it runs, as another user. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What `openLog` takes besides the path and the settings. Tests replace the defaults. */
interface OpenOptions {
  pid?: number;
  clock?: Clock;
  /** Whether a process runs. Tests replace it. */
  isAlive?: (pid: number) => boolean;
  /** Called with a line for *status when a write fails. Once per kind of failure. */
  onError?: (text: string) => void;
}

/**
 * Opens the Log at `path`. Returns the Log, or none if honk keeps no Log, and the lines
 * to show in *status: where a new file is, why there is no Log, or that another honk
 * writes it. Without a Log, `off` says why, for search. honk works the same without a
 * Log.
 */
export function openLog(
  path: string,
  settings: LogSettings,
  options: OpenOptions = {},
): { log: Log; notices: string[] } | { log?: undefined; notices: string[]; off: string } {
  if (!settings.enabled) return { notices: [], off: "logs.enabled is false in the config" };
  const created = !existsSync(path);
  let db: Database | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Also when the folder existed: mkdir sets the mode only on a new one.
    chmodSync(dirname(path), 0o700);
    // The file holds private messages. SQLite gives the -wal and -shm files the same mode.
    if (created) closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    db = new Database(path, { create: true, strict: true });
    const unfit = checkSqlite(db);
    if (unfit) {
      db.close();
      return { notices: [`honk keeps no log: ${unfit}.`], off: unfit };
    }
    prepare(db);
  } catch (err) {
    db?.close();
    // "<path> is from a newer honk (...)", or the error.
    const message = (err as Error).message;
    const newer = err instanceof NewerSchemaError;
    return {
      notices: [`honk keeps no log: ${newer ? `${path} ${message}` : message}.`],
      off: newer ? `the log ${message}` : message,
    };
  }
  let log: Log;
  try {
    log = new Log(db, settings, options);
  } catch (err) {
    db.close();
    const message = (err as Error).message;
    return { notices: [`honk keeps no log: ${message}.`], off: message };
  }
  const notices: string[] = [];
  if (created) notices.push(`honk keeps a log of your chats in ${path}.`);
  if (log.otherWriter !== undefined) {
    notices.push(
      `Another honk (pid ${log.otherWriter}) writes the log, so this one does not write to it.`,
    );
  }
  return { log, notices };
}

/**
 * An open Log. `add` queues a Line; `flush` writes the queue in one transaction. See the
 * top of this file.
 */
export class Log {
  /** The process that writes the file, when it is not this one. */
  readonly otherWriter: number | undefined;
  private readonly clock: Clock;
  private readonly pid: number;
  private readonly onError: (text: string) => void;
  private readonly reportedErrors = new Set<string>();
  private queue: Op[] = [];
  private flushTimer: unknown;
  /** The last write failed: the next one waits RETRY_MS, not for 100 Lines. */
  private failing = false;
  /**
   * Servers whose Lines were dropped from a full queue this run. Their Sync markers no
   * longer move, so the next start asks for the lost History again.
   */
  private lostLines = new Set<string>();
  private pruneTimer: unknown;
  private closed = false;
  /**
   * The file frees pages with incremental_vacuum. A file made with tables before honk
   * set auto_vacuum (by an outside tool, say) can't, and keeps its free pages.
   */
  private readonly incrementalVacuum: boolean;
  private networks = new Map<string, NetworkSnapshot>();
  /** Row ids, cached. A snapshot is replaced whenever its Network changes. */
  private networkIds = new WeakMap<NetworkSnapshot, number>();
  /** By network id and Buffer key: the row id and the display name it was written with. */
  private bufferIds = new Map<string, { id: number; display: string }>();
  /** Redactions whose Line is not in the Log yet, by network id and msgid. */
  private earlyRedactions = new Map<string, { by: string; time: number }>();
  /** Keys of the early redactions the write in progress used: gone once it commits. */
  private usedRedactions: string[] = [];

  constructor(
    private readonly db: Database,
    private readonly settings: LogSettings,
    options: OpenOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.pid = options.pid ?? process.pid;
    this.onError = options.onError ?? (() => {});
    this.incrementalVacuum =
      (db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum === 2;
    this.otherWriter = this.takeWriter(options.isAlive ?? processAlive);
    // Opening waits longer (see prepare); a write waits for its next try instead.
    db.run(`PRAGMA busy_timeout = ${WRITE_BUSY_MS}`);
    if (this.writable) this.schedulePrune(FIRST_PRUNE_MS);
  }

  /** False while another honk writes the file: then nothing is stored. */
  get writable(): boolean {
    return this.otherWriter === undefined && !this.closed;
  }

  /**
   * Takes the writer row, unless a running process other than this one holds it.
   * Returns that process's pid.
   */
  private takeWriter(isAlive: (pid: number) => boolean): number | undefined {
    return this.db
      .transaction(() => {
        const row = this.db.query("SELECT pid FROM writer WHERE id = 1").get() as
          | { pid: number }
          | null;
        if (row && row.pid !== this.pid && isAlive(row.pid)) return row.pid;
        this.db
          .query("INSERT OR REPLACE INTO writer (id, pid, since) VALUES (1, ?, ?)")
          .run(this.pid, this.clock.now());
        return undefined;
      })
      .immediate();
  }

  /** Updates what the Log knows about a Server's Network. Lines added later use it. */
  setNetwork(serverId: string, info: Partial<LogNetwork>): void {
    this.networks.set(serverId, this.snapshot(serverId, { ...this.networkOf(serverId), ...info }));
  }

  private networkOf(serverId: string): NetworkSnapshot {
    let net = this.networks.get(serverId);
    if (!net) {
      const fresh = { bouncerNetId: "", display: serverId, casemapping: DEFAULT_CASEMAPPING, exclude: [] };
      this.networks.set(serverId, (net = this.snapshot(serverId, fresh)));
    }
    return net;
  }

  /** A Network as Lines carry it, with its exclude names folded once. */
  private snapshot(serverId: string, net: LogNetwork): NetworkSnapshot {
    const names = [...this.settings.exclude, ...net.exclude];
    const excludeKeys = new Set(names.map((name) => nameKey(name, net.casemapping)));
    return { ...net, serverId, excludeKeys };
  }

  /**
   * Adds one Line to Buffer `buffer` of Server `serverId`. A Line from History gets its
   * Replay check when it is written; `batch` holds the counts of its History batch for
   * this Buffer (see HistoryBatch).
   */
  add(serverId: string, buffer: LogBuffer, line: LogLine, batch?: HistoryBatch): void {
    if (!this.writable) return;
    const net = this.networkOf(serverId);
    const key = nameKey(buffer.name, net.casemapping);
    if (net.excludeKeys.has(key)) return;
    this.push({ type: "line", net, buffer: { ...buffer, key }, line, batch });
  }

  /** Marks the Line with `msgid` on this Server as redacted by `by`. It stays in the Log. */
  redact(serverId: string, msgid: string, by: string, time: number): void {
    this.push({ type: "redact", net: this.networkOf(serverId), msgid, by, time });
  }

  /**
   * Moves the Sync marker of the Server's Network to `time`: History up to then is in
   * the Log. It never moves back. Written with the Lines added before it.
   */
  setSyncMarker(serverId: string, time: number): void {
    this.push({ type: "sync", net: this.networkOf(serverId), time });
  }

  /** The Sync marker of the Server's Network, or undefined if it has none yet. */
  syncMarker(serverId: string): number | undefined {
    this.flushUnlessFailing();
    const net = this.networkOf(serverId);
    const row = this.db
      .query("SELECT synced_until AS t FROM network WHERE config_id = ? AND bouncer_net = ?")
      .get(serverId, net.bouncerNetId) as { t: number | null } | null;
    return row?.t ?? undefined;
  }

  /**
   * The newest Chat lines that match `query` (see search.ts), with what waits in memory
   * written first. Works in a honk that only reads the file.
   */
  search(query: SearchQuery, limit = SEARCH_LIMIT): SearchResult | { error: string } {
    return this.read(() => searchLog(this.db, query, limit));
  }

  /** The Lines around the Line with row id `id`, from a search hit. */
  context(id: number, around = CONTEXT_LINES): LogContext | undefined {
    const result = this.read(() => logContext(this.db, id, around));
    return result && !("error" in result) ? result : undefined;
  }

  /**
   * Up to `limit` Lines of Buffer `name` on the Server's Network, oldest first: the
   * newest ones, or the ones before `before`. Empty if the Log has none, or on a failed
   * read. See scrollback.ts.
   */
  scrollback(
    serverId: string,
    name: string,
    before?: LineCursor,
    limit = SCROLLBACK_LINES,
  ): StoredLine[] {
    const net = this.networkOf(serverId);
    const result = this.read(() => {
      const row = this.db
        .query(
          `SELECT b.id FROM buffer b JOIN network n ON n.id = b.network_id
           WHERE n.config_id = ? AND n.bouncer_net = ? AND b.name = ?`,
        )
        .get(serverId, net.bouncerNetId, nameKey(name, net.casemapping)) as { id: number } | null;
      return row ? linesBeside(this.db, row.id, "older", before, limit, { withRedacted: true }) : [];
    });
    return Array.isArray(result) ? result : [];
  }

  /**
   * Runs a read after a flush, or right away while writes fail: the next try is on its
   * timer. A failure (such as a busy file) comes back as an error.
   */
  private read<T>(run: () => T): T | { error: string } {
    if (this.closed) return { error: "the log is closed" };
    this.flushUnlessFailing();
    try {
      return run();
    } catch (err) {
      return { error: `could not read the log: ${(err as Error).message}` };
    }
  }

  private push(op: Op): void {
    if (!this.writable) return;
    this.queue.push(op);
    this.trimQueue();
    if (this.queue.length >= FLUSH_LINES) this.flushUnlessFailing();
    if (this.queue.length > 0) this.scheduleFlush();
  }

  /** Writes what waits, unless writes fail: then the next try waits for its timer. */
  private flushUnlessFailing(): void {
    if (!this.failing) this.flush();
  }

  /**
   * While writes fail, a full queue drops its oldest tenth. The Sync markers of the
   * Servers those Lines came from stop for this run (see apply), so the next start asks
   * for that History again.
   */
  private trimQueue(): void {
    if (this.queue.length <= MAX_QUEUE) return;
    while (this.queue.length > MAX_QUEUE) {
      for (const op of this.queue.splice(0, MAX_QUEUE / 10)) this.lostLines.add(op.net.serverId);
    }
    this.report(
      "lost",
      `the log lost lines: honk keeps at most ${MAX_QUEUE.toLocaleString("en-US")} in memory while it can't write. A server that keeps History sends them again at the next start.`,
    );
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = this.clock.setTimeout(
      () => {
        this.flushTimer = undefined;
        this.flush();
      },
      this.failing ? RETRY_MS : FLUSH_MS,
    );
  }

  /**
   * Writes every waiting Line, in one transaction. If the file is busy or full, the
   * Lines wait and honk tries again; a Line that can't be stored is left out.
   */
  flush(): void {
    if (this.flushTimer !== undefined) {
      this.clock.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.queue.length === 0 || this.closed) return;
    const ops = this.queue;
    this.queue = [];
    const stopped = this.writeAll(ops);
    if (!stopped) return this.recovered();
    this.queue = ops.concat(this.queue);
    this.trimQueue();
    this.failing = true;
    this.scheduleFlush();
    this.report(
      "write",
      `could not write to the log: ${stopped.err.message}. honk keeps new lines and tries again.`,
    );
  }

  /**
   * Writes `ops` in one transaction. If one of them can't be stored, writes the others
   * without it, still in one transaction. Returns the error that stopped it, which may
   * go away: then nothing is written.
   */
  private writeAll(ops: Op[]): { err: Error } | undefined {
    try {
      this.write(ops);
      return undefined;
    } catch (err) {
      if (!isOneLineError(err)) return { err: err as Error };
    }
    const bad: Error[] = [];
    try {
      this.write(ops, (op) => {
        try {
          // A nested transaction is a savepoint: a bad op rolls back only itself.
          this.db.transaction(() => this.apply(op))();
        } catch (err) {
          if (!isOneLineError(err)) throw err;
          this.forgetIds();
          bad.push(err as Error);
        }
      });
    } catch (err) {
      return { err: err as Error };
    }
    if (bad.length > 0) {
      const what = bad.length === 1 ? "a line" : `${bad.length} lines`;
      this.onError(`could not write ${what} to the log: ${bad[0]!.message}`);
    }
    return undefined;
  }

  /** Applies `ops` in one transaction, each with `each`. On a failure nothing is written. */
  private write(ops: Op[], each = (op: Op) => this.apply(op)): void {
    this.usedRedactions = [];
    try {
      this.db.transaction(() => {
        for (const op of ops) each(op);
      })();
    } catch (err) {
      this.forgetIds();
      throw err;
    }
    for (const key of this.usedRedactions) this.earlyRedactions.delete(key);
  }

  /** The cached ids may name rows a rollback removed. */
  private forgetIds(): void {
    this.networkIds = new WeakMap();
    this.bufferIds.clear();
  }

  /** A write worked. After failed ones, says so, and the next failure is reported again. */
  private recovered(): void {
    if (!this.failing) return;
    this.failing = false;
    this.reportedErrors.delete("write");
    this.onError("honk writes the log again.");
  }

  private report(kind: string, text: string): void {
    if (this.reportedErrors.has(kind)) return;
    this.reportedErrors.add(kind);
    this.onError(text);
  }

  private apply(op: Op): void {
    const networkId = this.networkId(op.net);
    if (op.type === "sync") {
      // Lines of this Server were lost: the marker must stay before them.
      if (this.lostLines.has(op.net.serverId)) return;
      this.db
        .query(
          "UPDATE network SET synced_until = max(coalesce(synced_until, 0), ?) WHERE id = ?",
        )
        .run(op.time, networkId);
    } else if (op.type === "redact") {
      this.applyRedact(networkId, op.msgid, op.by, op.time);
    } else {
      this.applyLine(networkId, this.bufferId(networkId, op.buffer), op.line, op.batch);
    }
  }

  /** The row id of the Network, written or updated when the snapshot is new. */
  private networkId(net: NetworkSnapshot): number {
    const cached = this.networkIds.get(net);
    if (cached !== undefined) return cached;
    const { id } = this.db
      .query(
        `INSERT INTO network (config_id, bouncer_net, display, casemapping) VALUES (?, ?, ?, ?)
         ON CONFLICT (config_id, bouncer_net)
         DO UPDATE SET display = excluded.display, casemapping = excluded.casemapping
         RETURNING id`,
      )
      .get(net.serverId, net.bouncerNetId, net.display, net.casemapping) as { id: number };
    this.networkIds.set(net, id);
    return id;
  }

  /** The row id of the Buffer, written again when its display name changed. */
  private bufferId(networkId: number, buffer: LogBuffer & { key: string }): number {
    const cacheKey = `${networkId}\0${buffer.key}`;
    const cached = this.bufferIds.get(cacheKey);
    if (cached?.display === buffer.name) return cached.id;
    const { id } = this.db
      .query(
        `INSERT INTO buffer (network_id, name, display, kind) VALUES (?, ?, ?, ?)
         ON CONFLICT (network_id, name) DO UPDATE SET display = excluded.display
         RETURNING id`,
      )
      .get(networkId, buffer.key, buffer.name, buffer.kind) as { id: number };
    this.bufferIds.set(cacheKey, { id, display: buffer.name });
    return id;
  }

  /** The kept Lines that could match `line`: the same msgid, or the same nick near its time. */
  private keptNear(bufferId: number, line: LogLine): KeptLine[] {
    const cols = "id, kind, nick, subject, text, ts, ts_server, msgid";
    const rows = this.db
      .query(
        `SELECT ${cols} FROM message WHERE buffer_id = ? AND nick = ? AND ts BETWEEN ? AND ?
         ORDER BY ts, id`,
      )
      .all(bufferId, line.nick, line.time - MATCH_WINDOW_MS, line.time + MATCH_WINDOW_MS) as KeptRow[];
    if (line.msgid && !rows.some((r) => r.msgid === line.msgid)) {
      const same = this.db
        .query(`SELECT ${cols} FROM message WHERE buffer_id = ? AND msgid = ?`)
        .get(bufferId, line.msgid) as KeptRow | null;
      if (same) rows.push(same);
    }
    return rows.map(keptLine);
  }

  private applyLine(networkId: number, bufferId: number, line: LogLine, batch?: HistoryBatch): void {
    if (line.history) {
      const verdict = checkReplay(
        this.keptNear(bufferId, line),
        {
          kind: line.kind,
          from: line.nick,
          subject: line.subject,
          text: line.text,
          timestamp: new Date(line.time),
          timeFromServer: line.timeFromServer,
          msgid: line.msgid,
          isHistory: true,
        },
        batch,
      );
      if (verdict.type === "replay") return;
      if (verdict.type === "give-msgid") {
        this.db.query("UPDATE message SET msgid = ? WHERE id = ?").run(verdict.msgid, verdict.line.id);
        return;
      }
    }
    // A REDACT that came before this Line.
    const early = line.msgid ? this.takeEarlyRedaction(networkId, line.msgid) : undefined;
    // A live Line with a msgid the Log has is dropped by the unique index.
    this.db
      .query(
        `INSERT INTO message
           (buffer_id, ts, ts_server, kind, nick, subject, text, plain, msgid, self, mention,
            redacted_at, redacted_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        bufferId,
        line.time,
        line.timeFromServer ? 1 : 0,
        line.kind,
        line.nick,
        line.subject ?? null,
        line.text,
        stripIrcFormatting(line.text),
        line.msgid ?? null,
        line.self ? 1 : 0,
        line.mention ? 1 : 0,
        early?.time ?? null,
        early?.by ?? null,
      );
  }

  /** A redaction that waits for this Line. It is removed once the write commits. */
  private takeEarlyRedaction(networkId: number, msgid: string) {
    const key = `${networkId}\0${msgid}`;
    const early = this.earlyRedactions.get(key);
    if (early) this.usedRedactions.push(key);
    return early;
  }

  /**
   * Marks the Line with `msgid` redacted. A trigger takes its text out of the index, so
   * search no longer finds it. If the Log does not have the Line yet, the redaction
   * waits for it.
   */
  private applyRedact(networkId: number, msgid: string, by: string, time: number): void {
    const { changes } = this.db
      .query(
        `UPDATE message SET redacted_at = ?, redacted_by = ?
         WHERE msgid = ? AND redacted_at IS NULL
           AND buffer_id IN (SELECT id FROM buffer WHERE network_id = ?)`,
      )
      .run(time, by, msgid, networkId);
    if (changes > 0) return;
    // Already redacted, or not in the Log yet.
    const known = this.db
      .query(
        `SELECT 1 FROM message WHERE msgid = ?
           AND buffer_id IN (SELECT id FROM buffer WHERE network_id = ?)`,
      )
      .get(msgid, networkId);
    if (known) return;
    this.earlyRedactions.set(`${networkId}\0${msgid}`, { by, time });
    if (this.earlyRedactions.size > MAX_EARLY_REDACTIONS) {
      this.earlyRedactions.delete(this.earlyRedactions.keys().next().value!);
    }
  }

  private schedulePrune(ms: number): void {
    this.pruneTimer = this.clock.setTimeout(() => this.pruneStep(), ms);
  }

  /**
   * Deletes one batch of old rows, or once none is left, frees one batch of the pages
   * they used. Then schedules the next step.
   */
  private pruneStep(): void {
    if (!this.writable) return;
    let more = false;
    try {
      more = this.pruneBatch(this.clock.now()) > 0 || this.vacuumBatch();
    } catch (err) {
      this.report("prune", `could not remove old lines from the log: ${(err as Error).message}`);
    }
    this.schedulePrune(more ? PRUNE_PAUSE_MS : PRUNE_EVERY_MS);
  }

  /** Gives up to VACUUM_PAGES free pages back to the system. True if more are left. */
  private vacuumBatch(): boolean {
    if (!this.incrementalVacuum) return false;
    this.db.run(`PRAGMA incremental_vacuum(${VACUUM_PAGES})`);
    return (this.db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count > 0;
  }

  /** Deletes up to PRUNE_BATCH rows older than their retention. Returns how many. */
  pruneBatch(now: number): number {
    let deleted = 0;
    const rules: [readonly string[], number][] = [
      [EVENT_KINDS, this.settings.eventRetentionDays],
      [CHAT_KINDS, this.settings.retentionDays],
    ];
    for (const [kinds, days] of rules) {
      if (days <= 0 || deleted >= PRUNE_BATCH) continue;
      const list = sqlList(kinds);
      deleted += this.db
        .query(
          `DELETE FROM message WHERE id IN (
             SELECT id FROM message WHERE kind IN (${list}) AND ts < ? LIMIT ?)`,
        )
        .run(now - days * DAY_MS, PRUNE_BATCH - deleted).changes;
    }
    return deleted;
  }

  /**
   * Writes what waits, gives up the writer row, and closes the file. Never throws: it
   * runs as honk exits, when a busy or missing file can only lose what waits.
   */
  close(): void {
    if (this.closed) return;
    this.flush();
    if (this.flushTimer !== undefined) this.clock.clearTimeout(this.flushTimer);
    if (this.pruneTimer !== undefined) this.clock.clearTimeout(this.pruneTimer);
    try {
      if (this.otherWriter === undefined) {
        this.db.query("DELETE FROM writer WHERE pid = ?").run(this.pid);
      }
    } catch {
      // The next honk takes over the row of a process that is gone.
    }
    this.closed = true;
    this.db.close();
  }
}
