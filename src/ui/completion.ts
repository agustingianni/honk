import { SLASH_COMMANDS } from "../irc/commands.ts";
import { type Casemapping, nameKey } from "../irc/names.ts";
import type { ChatMessage, NickEntry } from "../types.ts";

interface CompletionContext {
  users: NickEntry[];
  messages: ChatMessage[];
  channels: string[];
  myNick: string;
  /** The server's casemapping. Nicks it sees as one are offered once. See nameKey. */
  casemapping: Casemapping;
}

function isFuzzyMatch(query: string, target: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}

/**
 * Ranks candidates:
 *  1. Prefix matches (prioritizing recent speakers when provided)
 *  2. Substring matches
 *  3. Fuzzy subsequence matches
 */
function rankCandidates(
  query: string,
  candidates: string[],
  /** Recent speakers first, by candidate. */
  recentOrder?: Map<string, number>,
): string[] {
  const sortBucket = (arr: string[]) =>
    arr.sort((a, b) => {
      const ra = recentOrder?.get(a) ?? Number.POSITIVE_INFINITY;
      const rb = recentOrder?.get(b) ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });

  const q = query.toLowerCase();
  if (!q) return sortBucket([...candidates]);

  const prefix: string[] = [];
  const substr: string[] = [];
  const fuzzy: string[] = [];

  for (const c of candidates) {
    const lower = c.toLowerCase();
    if (lower.startsWith(q)) {
      prefix.push(c);
    } else if (lower.includes(q)) {
      substr.push(c);
    } else if (isFuzzyMatch(q, lower)) {
      fuzzy.push(c);
    }
  }

  return [...sortBucket(prefix), ...sortBucket(substr), ...sortBucket(fuzzy)];
}

/**
 * Computes full-line replacement candidates for the trailing token in `input`.
 */
export function getCompletions(
  input: string,
  ctx: CompletionContext,
): string[] {
  // Don't complete if input ends with whitespace
  if (!input || /\s$/.test(input)) return [];

  const lastSpace = input.lastIndexOf(" ");
  const before = lastSpace === -1 ? "" : input.slice(0, lastSpace + 1);
  const token = lastSpace === -1 ? input : input.slice(lastSpace + 1);
  if (!token) return [];

  // 1. Slash command at start of line
  if (before === "" && token.startsWith("/")) {
    const q = token.slice(1);
    const matches = rankCandidates(q, SLASH_COMMANDS.map((c) => c.name));
    return matches.map((cmd) => `/${cmd} `);
  }

  // 2. Channel name (#...)
  if (token.startsWith("#")) {
    const matches = rankCandidates(token, ctx.channels);
    return matches.map((ch) => `${before}${ch} `);
  }

  // 3. Nick completion (channel users + recent speakers, excluding self)
  const key = (nick: string) => nameKey(nick, ctx.casemapping);
  const myKey = key(ctx.myNick);
  const recentOrder = new Map<string, number>();
  let rank = 0;
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const from = ctx.messages[i]!.from;
    if (!from) continue;
    const k = key(from);
    if (k === myKey || recentOrder.has(k)) continue;
    recentOrder.set(k, rank++);
  }

  const nickMap = new Map<string, string>();
  for (const u of ctx.users) {
    const k = key(u.nick);
    if (k !== myKey) nickMap.set(k, u.nick);
  }
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const from = ctx.messages[i]!.from;
    if (!from) continue;
    const k = key(from);
    if (k !== myKey && !nickMap.has(k)) {
      nickMap.set(k, from);
    }
  }

  // Ranks by the nick as offered, so the sort does not fold names again.
  const rankOf = new Map<string, number>();
  for (const [k, nick] of nickMap) {
    const rank = recentOrder.get(k);
    if (rank !== undefined) rankOf.set(nick, rank);
  }
  const matches = rankCandidates(token, [...nickMap.values()], rankOf);
  const suffix = before === "" ? ": " : " ";
  return matches.map((nick) => `${before}${nick}${suffix}`);
}
