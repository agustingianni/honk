import type { BufferKind } from "../types.ts";

export const STATUS_BUFFER = "*status";

/** The sender of a message whose source has no name. */
export const UNKNOWN_SENDER = "unknown";

/**
 * True when a message's sender is a person you could message. A server name
 * (irc.example.net) has a dot, and a nick cannot (RFC 2812).
 */
export function isUserSender(from: string): boolean {
  return from !== "" && from !== UNKNOWN_SENDER && !from.includes(".");
}

/** One character that a nick can hold (RFC 2812, with digits and "-" anywhere). */
export const NICK_CHAR = /[\w[\]\\`^{}|-]/;

export function isChannelName(name: string): boolean {
  return /^[#&+!]/.test(name);
}

export function bufferKindFor(name: string): BufferKind {
  if (name === STATUS_BUFFER) return "status";
  return isChannelName(name) ? "channel" : "dm";
}

/**
 * How a server decides which nick and channel names are the same, from CASEMAPPING
 * in ISUPPORT (005). Each one folds a run of uppercase bytes onto the bytes 32 above:
 *
 *   ascii           A-Z         -> a-z
 *   rfc1459-strict  A-Z [ \ ]   -> a-z { | }
 *   rfc1459         A-Z [ \ ] ^ -> a-z { | } ~
 *
 * RFC 2812 words it as if ~ were the uppercase one, but servers fold ^ to ~. Both
 * make the same names equal; only the key differs, and keys are stored (ADR 0002).
 */
export type Casemapping = "ascii" | "rfc1459" | "rfc1459-strict";

/** The mapping of a server that sends no CASEMAPPING, as the spec says. */
export const DEFAULT_CASEMAPPING: Casemapping = "rfc1459";

/** The mapping a CASEMAPPING value from ISUPPORT names. Undefined: the server sent none. */
export function parseCasemapping(value: string | undefined): Casemapping {
  if (!value) return DEFAULT_CASEMAPPING;
  if (value === "ascii" || value === "rfc1459" || value === "rfc1459-strict") return value;
  // An unknown mapping, such as rfc7613, which also folds letters outside A-Z. Every
  // mapping folds A-Z, so ascii folds only what the server surely folds. honk may then
  // show one name as two Buffers, but it never puts two of the server's names in one.
  return "ascii";
}

/** The bytes each mapping folds, as a pattern. See Casemapping. */
const UPPER: Record<Casemapping, RegExp> = {
  ascii: /[A-Z]/g,
  "rfc1459-strict": /[A-Z[\\\]]/g,
  rfc1459: /[A-Z[\\\]^]/g,
};

const lowerOf = (c: string) => String.fromCharCode(c.charCodeAt(0) + 32);

/**
 * A nick or channel name folded with the server's casemapping, for use as a map key.
 *
 *   nameKey("#FOO[", "rfc1459") -> "#foo{"
 *   nameKey("#FOO[", "ascii")   -> "#foo["
 */
export function nameKey(name: string, mapping: Casemapping): string {
  return name.replace(UPPER[mapping], lowerOf);
}

/** True when the server sees two nicks (or channel names) as one. See nameKey. */
export function sameNick(
  a: string | undefined,
  b: string | undefined,
  mapping: Casemapping,
): boolean {
  return a !== undefined && b !== undefined && nameKey(a, mapping) === nameKey(b, mapping);
}

/** Strips `!user` if a bouncer/server omits `@host` (e.g. `goose!goose` -> `goose`). */
export function normalizeNick(name?: string): string {
  if (!name) return "";
  const bang = name.indexOf("!");
  return bang === -1 ? name : name.slice(0, bang);
}
