/**
 * Reading raw IRC lines: cutting a byte stream into lines, and splitting a line into its
 * parts. honk uses it for the numerics irc-client-ts drops (IrcManager.onRawLine); the
 * fake server in dev/fakeircd and its tests use it too.
 */

/** Cuts a byte stream into lines, without "\r\n". A UTF-8 character split across chunks stays whole. */
export class LineSplitter {
  private decoder = new TextDecoder();
  private pending = "";

  constructor(private onLine: (line: string) => void) {}

  push(bytes: Uint8Array): void {
    this.pending += this.decoder.decode(bytes, { stream: true });
    let end: number;
    while ((end = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, end).replace(/\r$/, "");
      this.pending = this.pending.slice(end + 1);
      if (line) this.onLine(line);
    }
  }
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

/** The time in ms of a "timestamp=..." parameter. Undefined for "*" or anything else. */
export function parseTimestampParam(value: string | undefined): number | undefined {
  if (!value?.startsWith("timestamp=")) return undefined;
  const ms = Date.parse(value.slice("timestamp=".length));
  return Number.isNaN(ms) ? undefined : ms;
}
