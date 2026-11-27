import { NICK_CHAR } from "../irc/names.ts";

/** A nick or a channel name in a line of chat, from `start` up to (not including) `end`. */
export interface NameInText {
  kind: "nick" | "channel";
  /** For a nick, as the user list spells it, which may differ from the text ("BOB" is bob). */
  name: string;
  start: number;
  end: number;
}

/** A channel name ends at a space or a comma (RFC 2812). */
const CHANNEL_END = /[\s,]/;
/** Characters that may come before a channel name, as in "(#rust)". */
const OPENERS = /^[(["'<]+/;
/** Characters that end a sentence after a channel name, as in "join #rust." or "#rust's". */
const CLOSERS = /(?:'s)?[.,;:!?)\]}"'>]*$/;
/** Nick characters that also wrap a nick, as in "[bob]" or "{bob}". */
const NICK_WRAPPERS = /^[[{]*(.*?)[\]}]*$/;

/**
 * The nick or channel name at `index` in `text`, if there is one.
 *
 * A channel name is a word that starts with "#", such as "#rust" or "##linux",
 * without the punctuation around it. "#1" is not one: a number after "#" is
 * more often an issue number than a channel.
 *
 * A nick is a run of nick characters that `findNick` knows, so "bob" in
 * "bob: hi", "@bob" and "[bob]" counts when bob is in the channel, and "hello"
 * does not. `findNick` returns the nick as the user list spells it.
 */
export function nameAt(
  text: string,
  index: number,
  findNick: (word: string) => string | undefined,
): NameInText | undefined {
  if (index < 0 || index >= text.length) return undefined;

  let start = index;
  let end = index;
  while (start > 0 && !CHANNEL_END.test(text[start - 1]!)) start--;
  while (end < text.length && !CHANNEL_END.test(text[end]!)) end++;
  const word = text.slice(start, end);
  const opened = OPENERS.exec(word)?.[0].length ?? 0;
  const closed = CLOSERS.exec(word)?.[0].length ?? 0;
  if (word[opened] === "#") {
    const name = word.slice(opened, word.length - closed);
    if (name.length === 0 || /^#+\d*$/.test(name)) return undefined;
    const nameStart = start + opened;
    const nameEnd = nameStart + name.length;
    if (index < nameStart || index >= nameEnd) return undefined;
    return { kind: "channel", name, start: nameStart, end: nameEnd };
  }

  if (!NICK_CHAR.test(text[index]!)) return undefined;
  start = index;
  end = index;
  while (start > 0 && NICK_CHAR.test(text[start - 1]!)) start--;
  while (end < text.length && NICK_CHAR.test(text[end]!)) end++;
  const run = text.slice(start, end);
  let nick = findNick(run);
  if (nick === undefined) {
    // "[" and "{" can start a nick, so "[bob]" is one run: try it without them.
    const inner = NICK_WRAPPERS.exec(run)![1]!;
    nick = inner ? findNick(inner) : undefined;
    if (nick === undefined) return undefined;
    start += run.indexOf(inner);
    end = start + inner.length;
    if (index < start || index >= end) return undefined;
  }
  return { kind: "nick", name: nick, start, end };
}
