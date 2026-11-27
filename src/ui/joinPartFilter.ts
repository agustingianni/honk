/**
 * Hides join, part, quit and nick change lines in a channel, as the `joinPart`
 * config key says. The lines stay in the buffer; only the chat pane skips them,
 * so changing the setting brings them back.
 *
 * "smart" works like WeeChat's smart filter: a line shows only if that person
 * sent a message, an action or a notice in the channel within ACTIVE_WINDOW_MS
 * before or after it. So a netsplit's quits from people who never talk stay
 * hidden, and someone who joins and then talks gets their join line shown.
 */
import type { JoinPartMode } from "../config.ts";
import { nameKey } from "../irc/names.ts";
import type { ChatMessage } from "../types.ts";

export const ACTIVE_WINDOW_MS = 10 * 60_000;

/** A line the filter may hide: someone else joining, leaving, quitting or changing nick. Kicks are "error" lines. */
function isJoinPartLine(m: ChatMessage): boolean {
  return (m.kind === "join" || m.kind === "part" || m.kind === "nick") && !m.isSelf;
}

function isSpokenLine(m: ChatMessage): boolean {
  return m.kind === "message" || m.kind === "action" || m.kind === "notice";
}

/** The messages to draw, given the mode. Returns `messages` itself when it hides nothing. */
export function visibleMessages(messages: ChatMessage[], mode: JoinPartMode): ChatMessage[] {
  if (mode === "all") return messages;
  if (mode === "none") return sameIfAll(messages, messages.filter((m) => !isJoinPartLine(m)));

  // One person can have several nicks: after "alice is now known as alice_",
  // both names map to the same person, so talk under either name counts. This
  // holds for the whole buffer, so if someone else takes the freed nick later,
  // their talk counts for both. That is rare, and costs only a shown line.
  const parent = new Map<string, string>();
  const person = (nick: string): string => {
    // Only roots get a parent, so there are no cycles.
    let key = nameKey(nick);
    for (let up = parent.get(key); up !== undefined; up = parent.get(key)) key = up;
    return key;
  };
  for (const m of messages) {
    if (m.kind !== "nick" || !m.nick || !m.newNick) continue;
    const a = person(m.nick);
    const b = person(m.newNick);
    if (a !== b) parent.set(a, b);
  }

  // When each person spoke.
  const spoke = new Map<string, number[]>();
  for (const m of messages) {
    if (!isSpokenLine(m) || !m.from) continue;
    const who = person(m.from);
    const times = spoke.get(who);
    if (times) times.push(m.timestamp.getTime());
    else spoke.set(who, [m.timestamp.getTime()]);
  }

  const shown = messages.filter((m) => {
    if (!isJoinPartLine(m)) return true;
    const times = m.nick ? spoke.get(person(m.nick)) : undefined;
    const at = m.timestamp.getTime();
    return times?.some((t) => Math.abs(t - at) <= ACTIVE_WINDOW_MS) ?? false;
  });
  return sameIfAll(messages, shown);
}

/** `messages` itself when nothing was hidden, so callers can tell by identity. */
function sameIfAll(messages: ChatMessage[], shown: ChatMessage[]): ChatMessage[] {
  return shown.length === messages.length ? messages : shown;
}
