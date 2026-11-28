import { expect, test } from "bun:test";
import { searchCommand } from "../irc/commands.ts";
import type { SearchHit } from "../log/search.ts";
import { applyGlyphs } from "./glyphs.ts";
import { hitRow, hitTime } from "./logSearch.ts";

applyGlyphs(true);

const now = new Date(2026, 10, 28, 15, 0);

test("hitTime: the time today, the day this year, the date before", () => {
  expect(hitTime(new Date(2026, 10, 28, 9, 5).getTime(), now)).toBe("09:05");
  expect(hitTime(new Date(2026, 9, 1, 14, 2).getTime(), now)).toBe("Oct 1 14:02");
  expect(hitTime(new Date(2025, 11, 31, 23, 0).getTime(), now)).toBe("2025-12-31");
});

const hit = (extra: Partial<SearchHit>): SearchHit => ({
  id: 1,
  time: new Date(2026, 10, 28, 9, 5).getTime(),
  serverId: "libera",
  network: "Libera.Chat",
  buffer: "#rust",
  kind: "message",
  nick: "alice",
  text: [
    { text: "the ", hit: false },
    { text: "borrow", hit: true },
    { text: " checker", hit: false },
  ],
  ...extra,
});

/** The label with the highlighted characters in [brackets]. */
function marked(row: { label: string; highlights: number[] }): string {
  const set = new Set(row.highlights);
  return [...row.label].map((c, i) => (set.has(i) ? `[${c}]` : c)).join("").replaceAll("][", "");
}

test("hitRow: time, buffer, nick and text, with the matched words highlighted", () => {
  expect(marked(hitRow(hit({}), now, 80))).toBe("09:05  #rust  alice: the [borrow] checker");
});

test("hitRow: an action reads as one", () => {
  expect(hitRow(hit({ kind: "action" }), now, 80).label).toBe("09:05  #rust  * alice the borrow checker");
});

test("hitRow: a match past the row's end moves into view", () => {
  const long = hit({
    text: [
      { text: `${"word ".repeat(20)}and then the `, hit: false },
      { text: "borrow", hit: true },
      { text: " checker", hit: false },
    ],
  });
  expect(marked(hitRow(long, now, 50))).toBe("09:05  #rust  alice: ...and then the [borrow] checker");
});

test("searchCommand: the words after /search", () => {
  expect(searchCommand("/search borrow checker")).toBe("borrow checker");
  expect(searchCommand("/SEARCH")).toBe("");
  expect(searchCommand("/searching")).toBeUndefined();
  expect(searchCommand("search")).toBeUndefined();
});
