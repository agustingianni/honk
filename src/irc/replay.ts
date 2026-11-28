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
 * Some kept Lines have a time from honk's own clock: your line whose Echo never came,
 * or a live line without a time tag. That clock can be a little off from the server's,
 * so in rule 2 such a Line matches History less than 2 seconds away instead:
 *
 *   kept:    "lol" at 21:35:07.950, honk's clock
 *   History: "lol" at 21:35:08.100, the server's    -> Replay
 *
 * The code here reads Lines and changes nothing, so the screen and a Log on disk can
 * use it the same way: pass the kept Lines that could match, and act on the verdict.
 */

import { stripIrcFormatting } from "../notify.ts";

/** The parts of a Line the rule reads. A ChatMessage has them all. */
export interface ReplayLine {
  kind: string;
  from?: string;
  /** What an Event was done to: the kicked nick, or the new nick of a nick change. */
  subject?: string;
  text: string;
  timestamp: Date;
  /** True if `timestamp` came from the server, false or unset if from honk's clock. */
  timeFromServer?: boolean;
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
function wholeSecond(time: Date): number {
  return Math.floor(time.getTime() / 1000);
}

/** What rule 2 compares: kind, nick, text without formatting, and the whole second. */
interface MatchKey {
  kind: string;
  from: string;
  subject: string;
  plain: string;
  second: number;
}

function matchKey(line: ReplayLine): MatchKey {
  return {
    kind: line.kind,
    from: line.from ?? "",
    subject: line.subject ?? "",
    plain: stripIrcFormatting(line.text),
    second: wholeSecond(line.timestamp),
  };
}

/** How far apart a time from honk's clock and the server's time can be. */
export const LOCAL_CLOCK_WINDOW_MS = 2000;

/**
 * True if the kept Line `kept` matches `line`, whose match key is `key`. Whole seconds
 * when both times came from the server, else within LOCAL_CLOCK_WINDOW_MS. The cheap
 * fields are compared first.
 */
function matches(kept: ReplayLine, line: ReplayLine, key: MatchKey): boolean {
  if (kept.kind !== key.kind || (kept.from ?? "") !== key.from) return false;
  if ((kept.subject ?? "") !== key.subject) return false;
  const sameTime =
    kept.timeFromServer && line.timeFromServer
      ? wholeSecond(kept.timestamp) === key.second
      : Math.abs(kept.timestamp.getTime() - line.timestamp.getTime()) < LOCAL_CLOCK_WINDOW_MS;
  return sameTime && stripIrcFormatting(kept.text) === key.plain;
}

/**
 * The History Lines of one batch, such as one CHATHISTORY batch, for one Buffer.
 *
 * The Lines of a batch arrive one at a time, and a Line the batch keeps is in the kept
 * Lines when the next one is checked. A full Buffer can also drop its oldest Lines
 * during the batch. So the batch counts against the kept Lines as they were when it
 * first saw each match key: how many matched then ("before"), and how many copies it
 * has seen since. A copy is a Replay while the copies seen are no more than "before":
 *
 *   kept before: "lol"         batch: "lol", "lol"
 *   1st copy: seen 1, before 1  -> Replay
 *   2nd copy: seen 2, before 1  -> new
 */
export class HistoryBatch {
  private copies = new Map<string, { seen: number; before: number }>();

  /**
   * Counts one more copy with match key `key`, and says whether it is more than the
   * `before` kept Lines that matched. `before` is used the first time the key comes.
   */
  isExtra(key: MatchKey, before: number): boolean {
    const k = [key.kind, key.from, key.subject, key.plain, key.second].join("\0");
    let c = this.copies.get(k);
    if (!c) {
      c = { seen: 0, before };
      this.copies.set(k, c);
    }
    return ++c.seen > c.before;
  }
}

/**
 * Decides what to do with `line`, coming into a Buffer that keeps `kept` (oldest
 * first). `kept` may be the whole Buffer, or only the Lines that could match: the same
 * msgid, or the same kind, nick, and text without formatting, at about the same time.
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
  // Rule 1. Not counted in the batch: a Line with a known msgid takes no other's place.
  if (line.msgid && kept.some((k) => k.msgid === line.msgid)) return { type: "replay" };
  // Rule 4, and a live Line with a msgid honk does not have.
  if (!line.isHistory) return { type: "new" };

  const key = matchKey(line);
  const same = kept.filter((k) => matches(k, line, key));
  // More copies than honk had before the batch: this one is new.
  if (batch.isExtra(key, same.length)) return { type: "new" };
  // Rule 2.
  if (!line.msgid) return { type: "replay" };
  // Rule 3. A kept Line with another msgid is another Line, so this one is new.
  const without = same.find((k) => !k.msgid);
  return without ? { type: "give-msgid", line: without, msgid: line.msgid } : { type: "new" };
}
