/**
 * Lines as the Log keeps them, read a page at a time for scrollback and Context views.
 * Pages go by (time, row id), so two Lines in the same millisecond are neither skipped
 * nor read twice:
 *
 *   older than (21:35:07.000, 42)  ->  ts < 21:35:07.000, or ts = 21:35:07.000 and id < 42
 */

import type { Database } from "bun:sqlite";

/** One Line as the Log keeps it, for a Context view or scrollback. */
export interface StoredLine {
  /** The row id. */
  id: number;
  /** Unix ms. */
  time: number;
  /** True if `time` is the server's, false if honk's clock. */
  timeFromServer: boolean;
  kind: string;
  nick: string;
  subject?: string;
  /** As received, with formatting codes. */
  text: string;
  msgid?: string;
  self: boolean;
  mention: boolean;
  /** Who deleted it, for a Redacted line. A Context view leaves those out. */
  redactedBy?: string;
}

/** Where a page starts: next to the Line with this time and row id. */
export interface LineCursor {
  time: number;
  id: number;
}

/** The columns of a StoredLine. */
export const STORED_COLUMNS =
  "id, ts, ts_server, kind, nick, subject, text, msgid, self, mention, redacted_by";

/** A row read with STORED_COLUMNS. */
export interface StoredRow {
  id: number;
  ts: number;
  ts_server: number;
  kind: string;
  nick: string;
  subject: string | null;
  text: string;
  msgid: string | null;
  self: number;
  mention: number;
  redacted_by: string | null;
}

/** A row as a StoredLine. */
export function storedLine(r: StoredRow): StoredLine {
  return {
    id: r.id,
    time: r.ts,
    timeFromServer: r.ts_server === 1,
    kind: r.kind,
    nick: r.nick,
    subject: r.subject ?? undefined,
    text: r.text,
    msgid: r.msgid ?? undefined,
    self: r.self === 1,
    mention: r.mention === 1,
    redactedBy: r.redacted_by ?? undefined,
  };
}

/**
 * Up to `limit` Lines of the Buffer with row id `bufferId`, oldest first: the ones
 * older or newer than `from`, or with no `from`, the newest ones. Redacted lines come
 * only with `withRedacted`.
 */
export function linesBeside(
  db: Database,
  bufferId: number,
  side: "older" | "newer",
  from: LineCursor | undefined,
  limit: number,
  withRedacted: boolean,
): StoredLine[] {
  const [cmp, order] = side === "older" ? (["<", "DESC"] as const) : ([">", "ASC"] as const);
  const page = from ? `AND (ts ${cmp} ? OR (ts = ? AND id ${cmp} ?))` : "";
  const redacted = withRedacted ? "" : "AND redacted_at IS NULL";
  const params = from ? [bufferId, from.time, from.time, from.id, limit] : [bufferId, limit];
  const rows = db
    .query(
      `SELECT ${STORED_COLUMNS} FROM message WHERE buffer_id = ? ${redacted} ${page}
       ORDER BY ts ${order}, id ${order} LIMIT ?`,
    )
    .all(...params) as StoredRow[];
  const lines = rows.map(storedLine);
  return side === "older" ? lines.reverse() : lines;
}
