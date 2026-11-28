/**
 * Search in the Log: what the user types in the omnibox's search mode, and the SQL it
 * runs.
 *
 *   from:alice in:#rust borrow check*
 *
 * finds the Chat lines alice wrote in #rust that hold the word "borrow" and a word that
 * starts with "check", newest first. Every word must match. There is no OR, NOT, or
 * quoted phrase: the user's text never reaches FTS5 as syntax. Each word goes in double
 * quotes (a `"` in it doubled), and only a `*` the user typed at its end makes it a
 * prefix:
 *
 *   borrow check*   ->   "borrow" "check"*
 *
 * Redacted Lines are not found: the search index leaves them out (see schema.ts).
 *
 * With words, the search takes the Lines written last, by row id, and then shows them
 * newest first. SQLite then walks the index backwards and stops at the limit, instead
 * of sorting every Line that has the word by time: 0.3 ms instead of 1 s for "the" in
 * a Log of 1,000,000 Lines. The two differ only for History written after newer Lines
 * (a fill after a restart), which can come before them in the page.
 */

import type { Database } from "bun:sqlite";
import { CASEMAPPINGS, nameKey } from "../irc/names.ts";
import { CHAT_KINDS, sqlList } from "./schema.ts";
import { linesBeside, STORED_COLUMNS, type StoredLine, type StoredRow, storedLine } from "./storedLine.ts";

export interface SearchWord {
  text: string;
  /** Typed with a `*` at its end: it matches the start of a word. */
  prefix: boolean;
}

/** A search, as `parseSearch` reads it. */
export interface SearchQuery {
  words: SearchWord[];
  /** from:alice, a nick. */
  from?: string;
  /** in:#rust, a Buffer name. */
  in?: string;
  /** on:libera, a Server id or its Network's name. */
  on?: string;
  /** before:2026-10-01: earlier than that day, in Unix ms. */
  before?: number;
  /** after:2026-09-01: that day or later, in Unix ms. */
  after?: number;
}

const FILTERS = ["from", "in", "on", "before", "after"] as const;
type Filter = (typeof FILTERS)[number];

/** "2026-10-01" as the start of that day in local time, or undefined if it is no date. */
function localDay(text: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const date = new Date(y, mo, d);
  // new Date rolls 2026-02-30 over to March 2.
  if (date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d) return undefined;
  return date.getTime();
}

/** The start of a YYYY-MM-DD date, such as "2026-1": the user is still typing it. */
const PARTIAL_DAY = /^\d{1,4}(-(\d{1,2}(-\d?)?)?)?$/;

/**
 * Reads what the user typed. A filter with no value yet ("from:") or half a date
 * ("before:2026-1") is left out, so the results stay while the user types it. A date
 * that is not YYYY-MM-DD is an error.
 */
export function parseSearch(text: string): { query: SearchQuery } | { error: string } {
  const query: SearchQuery = { words: [] };
  for (const token of text.split(/\s+/)) {
    if (!token) continue;
    const colon = token.indexOf(":");
    const name = token.slice(0, colon).toLowerCase() as Filter;
    if (colon > 0 && FILTERS.includes(name)) {
      const value = token.slice(colon + 1);
      if (!value) continue;
      if (name === "before" || name === "after") {
        const day = localDay(value);
        if (day === undefined && PARTIAL_DAY.test(value) && value.length < 10) continue;
        if (day === undefined) return { error: `${name}: takes a date such as 2026-10-01` };
        query[name] = day;
      } else {
        query[name] = value;
      }
      continue;
    }
    const prefix = token.endsWith("*");
    const word = prefix ? token.slice(0, -1) : token;
    if (word) query.words.push({ text: word, prefix });
  }
  return { query };
}

/** The FTS5 MATCH text for `words`, or undefined for no words. See the top of this file. */
export function ftsMatch(words: readonly SearchWord[]): string | undefined {
  if (words.length === 0) return undefined;
  return words.map((w) => `"${w.text.replaceAll('"', '""')}"${w.prefix ? "*" : ""}`).join(" ");
}

/** A part of a hit's text: `hit` marks the words the search matched. */
export interface TextPart {
  text: string;
  hit: boolean;
}

/** One Line that a search found. */
export interface SearchHit {
  /** The Line's row id, for `Log.context`. */
  id: number;
  /** Unix ms. */
  time: number;
  serverId: string;
  /** The Network's name, for display. */
  network: string;
  /** The Buffer's name as last seen, such as "#Rust". */
  buffer: string;
  kind: string;
  nick: string;
  /** The Line's text without formatting, cut into matched and other parts. */
  text: TextPart[];
}

export interface SearchResult {
  hits: SearchHit[];
  /** More Lines matched than `limit`. */
  more: boolean;
}

/** The Lines around a search hit. */
export interface LogContext {
  serverId: string;
  network: string;
  buffer: string;
  bufferKind: "channel" | "dm";
  lines: StoredLine[];
  /** The index of the hit in `lines`. */
  match: number;
}

/** How many hits a search shows. */
export const SEARCH_LIMIT = 100;
/** How many Lines a Context view shows before and after the hit. */
export const CONTEXT_LINES = 50;

/** Marks the matched words in FTS5's highlight(). Formatting codes are gone from `plain`. */
const HIT_START = "\x01";
const HIT_END = "\x02";

/** Cuts highlight() output into parts. */
function textParts(marked: string): TextPart[] {
  const parts: TextPart[] = [];
  let hit = false;
  for (const piece of marked.split(/([\x01\x02])/)) {
    if (piece === HIT_START) hit = true;
    else if (piece === HIT_END) hit = false;
    else if (piece) parts.push({ text: piece, hit });
  }
  return parts;
}

interface HitRow {
  id: number;
  ts: number;
  kind: string;
  nick: string;
  marked: string;
  buffer: string;
  server: string;
  network: string;
}

/**
 * The row ids of the Buffers that `in:` and `on:` name, or undefined when neither is
 * given. Looked up first, so the search can walk each Buffer's Lines by time.
 */
function bufferIds(db: Database, query: SearchQuery): number[] | undefined {
  const where: string[] = [];
  const params: string[] = [];
  if (query.in !== undefined) {
    // Each Buffer is kept folded with its Network's casemapping, so try each one.
    const keys = [...new Set(CASEMAPPINGS.map((c) => nameKey(query.in!, c)))];
    where.push(`name IN (${keys.map(() => "?").join(", ")})`);
    params.push(...keys);
  }
  if (query.on !== undefined) {
    where.push(
      "network_id IN (SELECT id FROM network WHERE config_id = ? COLLATE NOCASE OR display = ? COLLATE NOCASE)",
    );
    params.push(query.on, query.on);
  }
  if (where.length === 0) return undefined;
  const rows = db.query(`SELECT id FROM buffer WHERE ${where.join(" AND ")}`).all(...params);
  return (rows as { id: number }[]).map((r) => r.id);
}

/**
 * Runs a search: `limit` Chat lines that match, newest first, and whether there are
 * more. With words, they are the ones written last (see the top of this file).
 */
export function searchLog(db: Database, query: SearchQuery, limit: number): SearchResult {
  const match = ftsMatch(query.words);
  const buffers = bufferIds(db, query);
  // Words or a filter, or nothing is found.
  const filtered = [query.from, buffers, query.before, query.after].some((f) => f !== undefined);
  if ((!match && !filtered) || buffers?.length === 0) return { hits: [], more: false };

  const where = [`m.kind IN (${sqlList(CHAT_KINDS)})`, "m.redacted_at IS NULL"];
  const params: (string | number)[] = [];
  if (match) {
    where.push("message_fts MATCH ?");
    params.push(match);
  }
  if (query.from !== undefined) {
    where.push("m.nick = ? COLLATE NOCASE");
    params.push(query.from);
  }
  // Row ids from the file: numbers, safe in the SQL text.
  if (buffers) where.push(`m.buffer_id IN (${buffers.join(", ")})`);
  if (query.before !== undefined) {
    where.push("m.ts < ?");
    params.push(query.before);
  }
  if (query.after !== undefined) {
    where.push("m.ts >= ?");
    params.push(query.after);
  }

  const marked = match ? `highlight(message_fts, 0, '${HIT_START}', '${HIT_END}')` : "m.plain";
  const from = match
    ? "message_fts JOIN message m ON m.id = message_fts.rowid"
    : "message m";
  const rows = db
    .query(
      `SELECT m.id, m.ts, m.kind, m.nick, ${marked} AS marked,
              b.display AS buffer, n.config_id AS server, n.display AS network
       FROM ${from}
       JOIN buffer b ON b.id = m.buffer_id
       JOIN network n ON n.id = b.network_id
       WHERE ${where.join(" AND ")}
       ORDER BY ${match ? "message_fts.rowid DESC" : "m.ts DESC, m.id DESC"}
       LIMIT ?`,
    )
    .all(...params, limit + 1) as HitRow[];
  const page = rows.slice(0, limit);
  if (match) page.sort((a, b) => b.ts - a.ts || b.id - a.id);
  return {
    hits: page.map((r) => ({
      id: r.id,
      time: r.ts,
      serverId: r.server,
      network: r.network,
      buffer: r.buffer,
      kind: r.kind,
      nick: r.nick,
      text: textParts(r.marked),
    })),
    more: rows.length > limit,
  };
}

/**
 * The Line with row id `id` and up to `around` Lines on each side of it, from its
 * Buffer, Events too. Redacted Lines are left out. Undefined if the Line is gone or
 * was redacted after the search.
 */
export function logContext(db: Database, id: number, around: number): LogContext | undefined {
  const hit = db
    .query(
      `SELECT ${STORED_COLUMNS.replace(/(\w+)/g, "m.$1")}, m.buffer_id, b.display AS buffer, b.kind AS bkind,
              n.config_id AS server, n.display AS network
       FROM message m JOIN buffer b ON b.id = m.buffer_id JOIN network n ON n.id = b.network_id
       WHERE m.id = ? AND m.redacted_at IS NULL`,
    )
    .get(id) as
    | (StoredRow & { buffer_id: number; buffer: string; bkind: "channel" | "dm"; server: string; network: string })
    | null;
  if (!hit) return undefined;
  const from = { time: hit.ts, id };
  const before = linesBeside(db, hit.buffer_id, "older", from, around, { withRedacted: false });
  const after = linesBeside(db, hit.buffer_id, "newer", from, around, { withRedacted: false });
  return {
    serverId: hit.server,
    network: hit.network,
    buffer: hit.buffer,
    bufferKind: hit.bkind,
    lines: [...before, storedLine(hit), ...after],
    match: before.length,
  };
}
