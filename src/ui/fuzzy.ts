/**
 * Fuzzy matching for the omnibox, scored the way fzf scores (its "v2" algorithm, see
 * junegunn/fzf src/algo/algo.go). Every query character must appear in the target, in
 * order. A match scores higher when its characters start words and sit next to each
 * other, and lower for the characters skipped between them:
 *
 *   "re" in "Server: Reconnect alpha"  -> R starts a word:        high score
 *   "re" in "Preferences: Color..."    -> r is inside a word:     lower score
 *   "tgsb" in "View: Toggle Sidebar"   -> letters spread out:     matches, ranks low
 *
 * The best way to place the query is found by dynamic programming over all placements,
 * so "ab" in "a_____ab" uses the "ab" at the end, not the first "a".
 */

export interface FuzzyMatch {
  score: number;
  /** Where each query character matched in the target, in order. */
  positions: number[];
}

// fzf's numbers. A matched character is worth 16; a word start adds up to 10, which is
// about what an 8-character gap costs, so a match far away can't win by a boundary alone.
const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTENSION = -1;
const BONUS_BOUNDARY = SCORE_MATCH / 2;
const BONUS_BOUNDARY_WHITE = BONUS_BOUNDARY + 2;
const BONUS_BOUNDARY_DELIMITER = BONUS_BOUNDARY + 1;
const BONUS_NON_WORD = SCORE_MATCH / 2;
const BONUS_CAMEL_123 = BONUS_BOUNDARY + SCORE_GAP_EXTENSION;
const BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION);
const BONUS_FIRST_CHAR_MULTIPLIER = 2;

const enum CharClass {
  White,
  NonWord,
  Delimiter,
  Lower,
  Upper,
  Number,
}

const DELIMITERS = "/,:;|";

function charClass(ch: string): CharClass {
  if (ch >= "a" && ch <= "z") return CharClass.Lower;
  if (ch >= "A" && ch <= "Z") return CharClass.Upper;
  if (ch >= "0" && ch <= "9") return CharClass.Number;
  if (/\s/.test(ch)) return CharClass.White;
  if (DELIMITERS.includes(ch)) return CharClass.Delimiter;
  // Letters outside ASCII ("é", "ñ") are word characters too.
  if (ch.toLowerCase() !== ch.toUpperCase()) return CharClass.Lower;
  return CharClass.NonWord;
}

/** The bonus for a character, given the class of the one before it. */
function bonusFor(prev: CharClass, cur: CharClass): number {
  if (cur > CharClass.NonWord) {
    if (prev === CharClass.White) return BONUS_BOUNDARY_WHITE;
    if (prev === CharClass.Delimiter) return BONUS_BOUNDARY_DELIMITER;
    if (prev === CharClass.NonWord) return BONUS_BOUNDARY;
  }
  if (
    (prev === CharClass.Lower && cur === CharClass.Upper) ||
    (prev !== CharClass.Number && cur === CharClass.Number)
  ) {
    return BONUS_CAMEL_123;
  }
  if (cur === CharClass.NonWord || cur === CharClass.Delimiter) return BONUS_NON_WORD;
  if (cur === CharClass.White) return BONUS_BOUNDARY_WHITE;
  return 0;
}

/**
 * How well `query` matches `target`, ignoring case, or null if it doesn't. An empty
 * query matches everything with score 0.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const n = q.length;
  const m = t.length;
  if (n === 0) return { score: 0, positions: [] };
  if (n > m) return null;

  // Quick reject, and the first and last place the query can fit.
  let first = -1;
  for (let i = 0, j = 0; j < m; j++) {
    if (t[j] === q[i]) {
      if (i === 0) first = j;
      if (++i === n) break;
    }
    if (j === m - 1) return null;
  }

  const bonus = new Array<number>(m);
  let prev = CharClass.White;
  for (let j = 0; j < m; j++) {
    const cls = charClass(target[j]!);
    bonus[j] = bonusFor(prev, cls);
    prev = cls;
  }

  // score[i][j]: the best score with query[i] matched at target[j] (or -Infinity).
  // runBonus[i][j]: the bonus that a run ending there passes on to the next character.
  // from[i][j]: where query[i - 1] matched on that best path.
  const NONE = Number.NEGATIVE_INFINITY;
  const score: Float64Array[] = [];
  const runBonus: Float64Array[] = [];
  const from: Int32Array[] = [];
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(m).fill(NONE);
    const runs = new Float64Array(m);
    const back = new Int32Array(m).fill(-1);
    const prevRow = i > 0 ? score[i - 1]! : null;
    const prevRuns = i > 0 ? runBonus[i - 1]! : null;
    // The best score of a match of query[i - 1] before j - 1, with the gap up to j paid.
    let gapBest = NONE;
    let gapFrom = -1;
    for (let j = first + i; j < m; j++) {
      if (prevRow && j >= 2) {
        // Extend every open gap by one character, or open a new one after j - 2.
        const extended = gapBest + SCORE_GAP_EXTENSION;
        const opened = prevRow[j - 2]! + SCORE_GAP_START;
        if (opened >= extended) {
          gapBest = opened;
          gapFrom = j - 2;
        } else {
          gapBest = extended;
        }
      }
      if (t[j] !== q[i]) continue;
      const b = bonus[j]!;
      if (i === 0) {
        row[j] = SCORE_MATCH + b * BONUS_FIRST_CHAR_MULTIPLIER;
        runs[j] = b;
        continue;
      }
      // Right after the previous character: a run keeps the bonus of its first character,
      // unless this one starts a stronger word boundary.
      let best = NONE;
      if (prevRow![j - 1]! !== NONE && j >= 1) {
        const carried = prevRuns![j - 1]!;
        const runStart = b >= BONUS_BOUNDARY && b > carried ? b : carried;
        best = prevRow![j - 1]! + SCORE_MATCH + Math.max(b, runStart, BONUS_CONSECUTIVE);
        row[j] = best;
        runs[j] = runStart;
        back[j] = j - 1;
      }
      // After a gap: a new run starts here.
      if (gapBest !== NONE) {
        const withGap = gapBest + SCORE_MATCH + b;
        if (withGap > best) {
          row[j] = withGap;
          runs[j] = b;
          back[j] = gapFrom;
        }
      }
    }
    score.push(row);
    runBonus.push(runs);
    from.push(back);
  }

  // The best end, then walk back to find each character's place.
  const last = score[n - 1]!;
  let end = -1;
  for (let j = 0; j < m; j++) {
    if (last[j]! !== NONE && (end === -1 || last[j]! > last[end]!)) end = j;
  }
  if (end === -1) return null;
  const positions = new Array<number>(n);
  for (let i = n - 1, j = end; i >= 0; i--) {
    positions[i] = j;
    j = from[i]![j]!;
  }
  return { score: last[end]!, positions };
}

/** Added to a match found in the label alone, so it ranks above any that needs the extra text. */
const LABEL_MATCH = 100_000;

/**
 * Matches `query` in the label, as in VS Code's Quick Open: a match there ranks above any
 * match that needs `extra` (a server name, a description). Only when the label alone does
 * not match is the query tried on "label extra", so "alice beta" still finds alice on beta.
 * Positions count from the start of the label either way.
 *
 *   "al" on ("alice", "alpha") -> a label match: ranks first
 *   "al" on ("bob", "alpha")   -> needs the server name: ranks after
 */
export function matchLabel(query: string, label: string, extra?: string): FuzzyMatch | null {
  const inLabel = fuzzyMatch(query, label);
  if (inLabel) return { score: inLabel.score + LABEL_MATCH, positions: inLabel.positions };
  return extra ? fuzzyMatch(query, `${label} ${extra}`) : null;
}

/**
 * The items that match `query` (see matchLabel), best first. Equal scores go by
 * `tiebreak`, then keep the list order. An empty query keeps every item, in list order.
 */
export function rankMatches<T>(
  query: string,
  items: readonly T[],
  text: (item: T) => readonly [label: string, extra?: string],
  tiebreak: (a: T, b: T) => number = () => 0,
): { item: T; match: FuzzyMatch }[] {
  const found: { item: T; match: FuzzyMatch }[] = [];
  for (const item of items) {
    const match = matchLabel(query, ...text(item));
    if (match) found.push({ item, match });
  }
  if (!query) return found;
  // Array.prototype.sort is stable, so the list order breaks the last ties.
  return found.sort((a, b) => b.match.score - a.match.score || tiebreak(a.item, b.item));
}

/** A tiebreak for rankMatches: the shorter text first, as fzf does ("#rust" before "#rust-dev"). */
export function shorterFirst<T>(text: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => text(a).length - text(b).length;
}
