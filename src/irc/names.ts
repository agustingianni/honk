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

export function isChannelName(name: string): boolean {
  return /^[#&+!]/.test(name);
}

export function bufferKindFor(name: string): BufferKind {
  if (name === STATUS_BUFFER) return "status";
  return isChannelName(name) ? "channel" : "dm";
}

/**
 * A nick or channel name folded for case-insensitive lookup, for use as a map key.
 * The one place to add IRC casemapping later.
 */
export function nameKey(name: string): string {
  return name.toLowerCase();
}

/** Case-insensitive nick comparison. See nameKey. */
export function sameNick(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && nameKey(a) === nameKey(b);
}

/** Strips `!user` if a bouncer/server omits `@host` (e.g. `goose!goose` -> `goose`). */
export function normalizeNick(name?: string): string {
  if (!name) return "";
  const bang = name.indexOf("!");
  return bang === -1 ? name : name.slice(0, bang);
}
