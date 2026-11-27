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
 */

import type { Database } from "bun:sqlite";
import { type Casemapping, nameKey } from "../irc/names.ts";
import { CHAT_KINDS, sqlList } from "./schema.ts";

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

/** One Line of a Context view. */
export interface ContextLine {
  id: number;
  /** Unix ms. */
  time: number;
  kind: string;
  nick: string;
  subject?: string;
  /** As received, with formatting codes. */
  text: string;
  self: boolean;
  mention: boolean;
}

/** The Lines around a search hit. */
export interface LogContext {
  serverId: string;
  network: string;
  buffer: string;
  bufferKind: "channel" | "dm";
  lines: ContextLine[];
  /** The index of the hit in `lines`. */
  match: number;
}

/** How many hits a search shows. */
export const SEARCH_LIMIT = 100;
/** How many Lines a Context view shows before and after the hit. */
export const CONTEXT_LINES = 50;

const CASEMAPPINGS: readonly Casemapping[] = ["ascii", "rfc1459", "rfc1459-strict", "rfc8265"];
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

/** Runs a search: the newest `limit` Chat lines that match, and whether there are more. */
export function searchLog(db: Database, query: SearchQuery, limit = SEARCH_LIMIT): SearchResult {
  const match = ftsMatch(query.words);
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
  if (query.in !== undefined) {
    // Each Buffer is kept folded with its Network's casemapping, so try each one.
    const keys = [...new Set(CASEMAPPINGS.map((c) => nameKey(query.in!, c)))];
    where.push(`b.name IN (${keys.map(() => "?").join(", ")})`);
    params.push(...keys);
  }
  if (query.on !== undefined) {
    where.push("(n.config_id = ? COLLATE NOCASE OR n.display = ? COLLATE NOCASE)");
    params.push(query.on, query.on);
  }
  if (query.before !== undefined) {
    where.push("m.ts < ?");
    params.push(query.before);
  }
  if (query.after !== undefined) {
    where.push("m.ts >= ?");
    params.push(query.after);
  }
  // Words or a filter, or nothing is found.
  if (params.length === 0) return { hits: [], more: false };

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
       ORDER BY m.ts DESC, m.id DESC
       LIMIT ?`,
    )
    .all(...params, limit + 1) as HitRow[];
  return {
    hits: rows.slice(0, limit).map((r) => ({
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

interface ContextRow {
  id: number;
  ts: number;
  kind: string;
  nick: string;
  subject: string | null;
  text: string;
  self: number;
  mention: number;
}

function contextLine(r: ContextRow): ContextLine {
  return {
    id: r.id,
    time: r.ts,
    kind: r.kind,
    nick: r.nick,
    ...(r.subject !== null && { subject: r.subject }),
    text: r.text,
    self: r.self === 1,
    mention: r.mention === 1,
  };
}

/**
 * The Line with row id `id` and up to `around` Lines on each side of it, from its
 * Buffer, Events too. Redacted Lines are left out. Undefined if the Line is gone or
 * was redacted after the search.
 */
export function logContext(db: Database, id: number, around = CONTEXT_LINES): LogContext | undefined {
  const hit = db
    .query(
      `SELECT m.buffer_id, m.ts, b.display AS buffer, b.kind AS bkind,
              n.config_id AS server, n.display AS network
       FROM message m JOIN buffer b ON b.id = m.buffer_id JOIN network n ON n.id = b.network_id
       WHERE m.id = ? AND m.redacted_at IS NULL`,
    )
    .get(id) as
    | { buffer_id: number; ts: number; buffer: string; bkind: "channel" | "dm"; server: string; network: string }
    | null;
  if (!hit) return undefined;
  const cols = "id, ts, kind, nick, subject, text, self, mention";
  const side = (cmp: "<" | ">", order: "DESC" | "ASC") =>
    db
      .query(
        `SELECT ${cols} FROM message
         WHERE buffer_id = ? AND redacted_at IS NULL AND (ts ${cmp} ? OR (ts = ? AND id ${cmp} ?))
         ORDER BY ts ${order}, id ${order} LIMIT ?`,
      )
      .all(hit.buffer_id, hit.ts, hit.ts, id, around) as ContextRow[];
  const self = db.query(`SELECT ${cols} FROM message WHERE id = ?`).get(id) as ContextRow;
  const before = side("<", "DESC").reverse();
  const after = side(">", "ASC");
  return {
    serverId: hit.server,
    network: hit.network,
    buffer: hit.buffer,
    bufferKind: hit.bkind,
    lines: [...before, self, ...after].map(contextLine),
    match: before.length,
  };
}
