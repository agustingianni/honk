/**
 * The tables of the Log (logs.db) and how a file is opened and upgraded. See ADR 0001
 * (docs/adr/0001-log-in-sqlite-with-fts5.md) and docs/research/message-log.md.
 *
 * The SQL uses nothing newer than SQLite 3.39, because on macOS Bun loads Apple's
 * SQLite, and macOS 13 ships about 3.39. So, for example, no FTS5
 * `contentless_delete` (3.43).
 */

import type { Database } from "bun:sqlite";

/** The schema version this honk writes, kept in `PRAGMA user_version`. */
export const SCHEMA_VERSION = 1;

/** The oldest SQLite honk keeps a Log with. */
export const MIN_SQLITE = "3.39.0";

/** Chat lines: these kinds go in the full-text index. The other kinds are Events. */
export const CHAT_KINDS = ["message", "action", "notice", "topic"] as const;
/** Events, which the Log keeps for `eventRetentionDays`. */
export const EVENT_KINDS = ["join", "part", "quit", "nick", "kick"] as const;

/** `kinds` as an SQL list: "'message', 'action'". */
export function sqlList(kinds: readonly string[]): string {
  return kinds.map((k) => `'${k}'`).join(", ");
}

const chatKindList = sqlList(CHAT_KINDS);

/**
 * Version 1. Times are Unix ms (UTC).
 *
 * The index holds exactly the Chat lines that are not redacted, and only the triggers
 * change it. A second FTS 'delete' of one row corrupts the index, so each trigger
 * checks the same condition:
 *
 *   insert a Chat line               -> added to the index
 *   redact it (redacted_at is set)   -> removed from the index
 *   delete it (retention)            -> removed, unless a redaction removed it already
 */
const SCHEMA_V1 = `
CREATE TABLE network (
  id             INTEGER PRIMARY KEY,
  config_id      TEXT NOT NULL,
  bouncer_net    TEXT NOT NULL DEFAULT '',
  display        TEXT NOT NULL,
  casemapping    TEXT NOT NULL DEFAULT 'rfc1459',
  synced_until   INTEGER,
  UNIQUE (config_id, bouncer_net)
);

CREATE TABLE buffer (
  id         INTEGER PRIMARY KEY,
  network_id INTEGER NOT NULL REFERENCES network(id),
  name       TEXT NOT NULL,
  display    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  UNIQUE (network_id, name)
);

CREATE TABLE message (
  id          INTEGER PRIMARY KEY,
  buffer_id   INTEGER NOT NULL REFERENCES buffer(id),
  ts          INTEGER NOT NULL,
  ts_server   INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  nick        TEXT NOT NULL DEFAULT '',
  subject     TEXT,
  text        TEXT NOT NULL,
  plain       TEXT NOT NULL,
  msgid       TEXT,
  self        INTEGER NOT NULL DEFAULT 0,
  mention     INTEGER NOT NULL DEFAULT 0,
  redacted_at INTEGER,
  redacted_by TEXT
);

CREATE INDEX message_buffer_ts ON message (buffer_id, ts);
CREATE INDEX message_buffer_nick_ts ON message (buffer_id, nick, ts);
CREATE INDEX message_kind_ts ON message (kind, ts);
CREATE UNIQUE INDEX message_buffer_msgid ON message (buffer_id, msgid)
  WHERE msgid IS NOT NULL;

CREATE VIRTUAL TABLE message_fts USING fts5 (
  plain,
  content = 'message', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER message_fts_ai AFTER INSERT ON message
WHEN new.redacted_at IS NULL AND new.kind IN (${chatKindList}) BEGIN
  INSERT INTO message_fts (rowid, plain) VALUES (new.id, new.plain);
END;

CREATE TRIGGER message_fts_redact AFTER UPDATE OF redacted_at ON message
WHEN old.redacted_at IS NULL AND new.redacted_at IS NOT NULL
  AND old.kind IN (${chatKindList}) BEGIN
  INSERT INTO message_fts (message_fts, rowid, plain) VALUES ('delete', old.id, old.plain);
END;

CREATE TRIGGER message_fts_ad AFTER DELETE ON message
WHEN old.redacted_at IS NULL AND old.kind IN (${chatKindList}) BEGIN
  INSERT INTO message_fts (message_fts, rowid, plain) VALUES ('delete', old.id, old.plain);
END;

CREATE TABLE writer (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  pid   INTEGER NOT NULL,
  since INTEGER NOT NULL
);
`;

/** One function per version: MIGRATIONS[n] upgrades a file at version n to n + 1. */
const MIGRATIONS: ((db: Database) => void)[] = [(db) => db.run(SCHEMA_V1)];

/** -1, 0 or 1, comparing two "3.39.0" versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/**
 * Why this SQLite can't hold the Log, or undefined if it can: too old, or built
 * without FTS5.
 */
export function checkSqlite(db: Database): string | undefined {
  const { v } = db.query("SELECT sqlite_version() AS v").get() as { v: string };
  if (compareVersions(v, MIN_SQLITE) < 0) {
    return `SQLite ${v} is older than ${MIN_SQLITE}`;
  }
  try {
    db.run("CREATE VIRTUAL TABLE temp.fts5_check USING fts5 (x)");
    db.run("DROP TABLE temp.fts5_check");
  } catch {
    return `SQLite ${v} has no FTS5`;
  }
  return undefined;
}

/** The file's schema version is newer than this honk knows. */
export class NewerSchemaError extends Error {
  constructor(readonly version: number) {
    super(`it is from a newer honk (schema ${version}, this honk knows ${SCHEMA_VERSION})`);
  }
}

/**
 * Sets the connection up and brings the schema to SCHEMA_VERSION. Throws
 * NewerSchemaError for a file from a newer honk, and leaves it unchanged.
 */
export function prepare(db: Database): void {
  db.run("PRAGMA busy_timeout = 5000");
  const version = userVersion(db);
  if (version > SCHEMA_VERSION) throw new NewerSchemaError(version);
  // Only before the first table: it changes how the file is laid out.
  if (version === 0) db.run("PRAGMA auto_vacuum = INCREMENTAL");
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  for (let v = version; v < SCHEMA_VERSION; v++) {
    db.transaction(() => {
      MIGRATIONS[v]!(db);
      db.run(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

/** The schema version of the open file: 0 for a new file. */
export function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}
