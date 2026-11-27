/**
 * Reading raw IRC lines: cutting a byte stream into lines, and splitting a line into its
 * parts. honk uses it for the numerics irc-client-ts drops (IrcManager.onRawLine); the
 * fake server in dev/fakeircd and its tests use it too.
 */

/**
 * The longest line LineSplitter keeps, "\r\n" included. A normal IRC line is at most
 * 8191 bytes of IRCv3 tags and a 512-byte message, but a server may allow longer
 * messages (ISUPPORT LINELEN), so the limit leaves plenty of room.
 */
export const MAX_LINE_BYTES = 64 * 1024;

/**
 * Cuts a byte stream into lines, without "\r\n". A UTF-8 character split across chunks
 * stays whole.
 *
 * A line longer than MAX_LINE_BYTES is dropped, up to and including its "\n", and
 * `onTooLong` is called. So a server that never sends "\n" can't make honk keep more
 * than MAX_LINE_BYTES:
 *
 *   push("PING a\r\n" + 100_000 x "x" + "\r\nPING b\r\n")
 *   -> onLine("PING a"), onTooLong(), onLine("PING b")
 */
// Each line is decoded on its own, so a U+FEFF at the start of a line must stay.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export class LineSplitter {
  /** The start of a line whose "\n" has not come yet. */
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  /** True while skipping the rest of a line that was too long. */
  private dropping = false;

  constructor(
    private onLine: (line: string) => void,
    private onTooLong?: () => void,
  ) {}

  /**
   * Calls onLine for each line that `bytes` completes. Returns the bytes of those lines,
   * "\r\n" included, in a new array: the stream without the lines that were too long
   * and without the start of a line that has not ended yet.
   */
  push(bytes: Uint8Array): Uint8Array {
    const whole: Uint8Array[] = [];
    let start = 0;
    while (start < bytes.length) {
      const nl = bytes.indexOf(10, start);
      const end = nl === -1 ? bytes.length : nl + 1;
      const part = bytes.subarray(start, end);
      start = end;

      if (this.dropping) {
        if (nl !== -1) this.dropping = false;
        continue;
      }
      if (this.pendingBytes + part.length > MAX_LINE_BYTES) {
        this.pending = [];
        this.pendingBytes = 0;
        this.dropping = nl === -1;
        this.onTooLong?.();
        continue;
      }
      if (nl === -1) {
        // Copied: the caller may reuse `bytes`, as node:net does with its buffers.
        this.pending.push(part.slice());
        this.pendingBytes += part.length;
        continue;
      }

      const lineBytes = this.pending.length > 0 ? concat([...this.pending, part]) : part;
      this.pending = [];
      this.pendingBytes = 0;
      whole.push(lineBytes);
      // Without "\n", and without "\r" before it.
      let n = lineBytes.length - 1;
      if (n > 0 && lineBytes[n - 1] === 13) n--;
      const line = decoder.decode(lineBytes.subarray(0, n));
      if (line) this.onLine(line);
    }
    return concat(whole);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface IrcLine {
  tags: Record<string, string>;
  /** The source without its ":", such as "alice!a@host" or "irc.example.org". */
  source?: string;
  /** Uppercase: "PRIVMSG", "470". */
  command: string;
  /** The trailing param, after " :", is the last one. */
  params: string[];
}

/**
 * Only the command of an IRC line, uppercase, without parsing the rest:
 *
 *   "@time=x :srv 470 goose #old #new :Forwarding" -> "470"
 */
export function commandOf(raw: string): string {
  let start = 0;
  // Skip "@tags " and ":source ", and the spaces after each.
  for (const lead of ["@", ":"]) {
    while (raw[start] === " ") start++;
    if (raw[start] !== lead) continue;
    const sp = raw.indexOf(" ", start);
    if (sp === -1) return "";
    start = sp + 1;
  }
  while (raw[start] === " ") start++;
  const end = raw.indexOf(" ", start);
  return raw.slice(start, end === -1 ? undefined : end).toUpperCase();
}

/**
 * Splits an IRC line into its parts:
 *
 *   "@time=x :srv 470 goose #old #new :Forwarding"
 *   -> { tags: { time: "x" }, source: "srv", command: "470",
 *        params: ["goose", "#old", "#new", "Forwarding"] }
 */
export function parseLine(raw: string): IrcLine {
  let rest = raw;
  const tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    for (const part of rest.slice(1, sp).split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) tags[part] = "";
      else tags[part.slice(0, eq)] = part.slice(eq + 1);
    }
    rest = rest.slice(sp + 1).trimStart();
  }
  let source: string | undefined;
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    source = rest.slice(1, sp);
    rest = rest.slice(sp + 1).trimStart();
  }
  const trailAt = rest.indexOf(" :");
  const head = trailAt === -1 ? rest : rest.slice(0, trailAt);
  const words = head.split(" ").filter(Boolean);
  const params = words.slice(1);
  if (trailAt !== -1) params.push(rest.slice(trailAt + 2));
  return { tags, source, command: (words[0] ?? "").toUpperCase(), params };
}

/**
 * The IRCv3 timestamp parameter that CHATHISTORY and MARKREAD use, for a time in ms:
 *
 *   timestampParam(Date.parse("2026-11-26T22:00:00Z"))
 *   -> "timestamp=2026-11-26T22:00:00.000Z"
 */
export function timestampParam(ms: number): string {
  return `timestamp=${new Date(ms).toISOString()}`;
}

/** The IRCv3 tags honk reads from a line. */
export type TimeTags = { time?: string; msgid?: string };

/** The tags of an event payload from irc-client-ts. Its types leave them out. */
export function tagsOf(msg: unknown): TimeTags | undefined {
  return (msg as { tags?: TimeTags }).tags;
}

/**
 * When a line was sent: its IRCv3 server-time tag, or now when it has none.
 * A tag that does not parse also gives now, because an Invalid Date breaks
 * the date formatting in the chat. `timeFromServer` says the time came from the
 * tag; a time from honk's own clock can be a little off. See replay.ts.
 */
export function lineTime(tags?: { time?: string }): { timestamp: Date; timeFromServer?: true } {
  const ms = tags?.time ? Date.parse(tags.time) : NaN;
  return Number.isNaN(ms)
    ? { timestamp: new Date() }
    : { timestamp: new Date(ms), timeFromServer: true };
}

/** The time in ms of a "timestamp=..." parameter. Undefined for "*" or anything else. */
export function parseTimestampParam(value: string | undefined): number | undefined {
  if (!value?.startsWith("timestamp=")) return undefined;
  const ms = Date.parse(value.slice("timestamp=".length));
  return Number.isNaN(ms) ? undefined : ms;
}
