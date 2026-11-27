/**
 * Decides whether an incoming Line is a Replay of a Line honk already keeps.
 * The rule is ADR 0003 (docs/adr/0003-one-rule-for-replays.md), for one Buffer:
 *
 *   1. Both have a msgid: the same msgid means the same Line.
 *   2. A History Line without a msgid matches a kept Line with the same kind, nick,
 *      text without formatting, and time in whole seconds. Matches are counted.
 *   3. A History Line with a msgid that matches a kept Line without one gives that
 *      Line its msgid.
 *   4. A live Line without a msgid is always new.
 *
 * Whole seconds, because soju's file store cuts times to the second and drops msgids,
 * and ZNC drops msgids:
 *
 *   live:    @msgid=AB12;time=2026-11-27T21:35:07.412Z :alice PRIVMSG #honk :lol
 *   soju:    @time=2026-11-27T21:35:07.000Z :alice PRIVMSG #honk :lol    -> Replay
 *   ZNC:     @time=2026-11-27T21:35:07.412Z :alice PRIVMSG #honk :lol    -> Replay
 *
 * Counting: if History holds "lol" twice in one second and honk keeps it once, the
 * first copy is a Replay and the second is new.
 *
 * The code here reads Lines and changes nothing, so the screen and a Log on disk can
 * use it the same way: pass the kept Lines that could match, and act on the verdict.
 */

import { stripIrcFormatting } from "../notify.ts";

/** The parts of a Line the rule reads. A ChatMessage has them all. */
export interface ReplayLine {
  kind: string;
  from?: string;
  text: string;
  timestamp: Date;
  msgid?: string;
  isHistory?: boolean;
}

/**
 * What to do with an incoming Line:
 * - "new": keep it.
 * - "replay": drop it, honk has it already.
 * - "give-msgid": drop it, and set `msgid` on the kept `line` (rule 3).
 */
export type ReplayVerdict<T> =
  | { type: "new" }
  | { type: "replay" }
  | { type: "give-msgid"; line: T; msgid: string };

/** A time cut to the second, as soju's file store keeps it. */
export function wholeSecond(time: Date): number {
  return Math.floor(time.getTime() / 1000);
}

/** What rule 2 compares: kind, nick, text without formatting, and the whole second. */
export interface MatchKey {
  kind: string;
  from: string;
  plain: string;
  second: number;
}

function matchKey(line: ReplayLine): MatchKey {
  return {
    kind: line.kind,
    from: line.from ?? "",
    plain: stripIrcFormatting(line.text),
    second: wholeSecond(line.timestamp),
  };
}

/** True if `line` has the match key `key`. The cheap fields are compared first. */
function hasKey(line: ReplayLine, key: MatchKey): boolean {
  return (
    line.kind === key.kind &&
    (line.from ?? "") === key.from &&
    wholeSecond(line.timestamp) === key.second &&
    stripIrcFormatting(line.text) === key.plain
  );
}

/**
 * The History Lines of one batch, such as one CHATHISTORY batch, for one Buffer.
 *
 * The Lines of a batch arrive one at a time, and a Line the batch keeps is in the
 * kept Lines when the next one is checked. So the second "lol" of a batch would match
 * the first one, and be dropped. The batch remembers, per match key, how many copies
 * it has seen and how many it kept, so that only Lines from before it are counted:
 *
 *   kept before: "lol"         batch: "lol", "lol"
 *   1st copy: 1 match before it, copy 1  -> Replay
 *   2nd copy: 1 match before it, copy 2  -> new
 */
export class HistoryBatch {
  private copies = new Map<string, { seen: number; kept: number }>();

  /** The counts for one match key. */
  count(key: MatchKey): { seen: number; kept: number } {
    const k = [key.kind, key.from, key.plain, key.second].join("\0");
    let c = this.copies.get(k);
    if (!c) {
      c = { seen: 0, kept: 0 };
      this.copies.set(k, c);
    }
    return c;
  }
}

/**
 * Decides what to do with `line`, coming into a Buffer that keeps `kept` (oldest
 * first). `kept` may be the whole Buffer, or only the Lines that could match: the same
 * msgid, or the same kind, nick, text without formatting, and whole second.
 *
 * `batch` holds the counts for History that comes in several Lines. The caller must
 * act on each verdict before it checks the next Line of the batch. Without a batch,
 * the Line is a batch of its own.
 */
export function checkReplay<T extends ReplayLine>(
  kept: readonly T[],
  line: ReplayLine,
  batch: HistoryBatch = new HistoryBatch(),
): ReplayVerdict<T> {
  // Rule 1.
  if (line.msgid && kept.some((k) => k.msgid === line.msgid)) return { type: "replay" };
  // Rule 4, and a live Line with a msgid honk does not have.
  if (!line.isHistory) return { type: "new" };

  const key = matchKey(line);
  const copies = batch.count(key);
  copies.seen++;
  const matches = kept.filter((k) => hasKey(k, key));
  // Rule 3.
  if (line.msgid) {
    const without = matches.find((k) => !k.msgid);
    if (without) return { type: "give-msgid", line: without, msgid: line.msgid };
  } else if (copies.seen <= matches.length - copies.kept) {
    // Rule 2. Lines this batch kept came after the copies it is counting.
    return { type: "replay" };
  }
  copies.kept++;
  return { type: "new" };
}
