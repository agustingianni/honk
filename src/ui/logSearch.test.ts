import { expect, test } from "bun:test";
import { searchCommand } from "../irc/commands.ts";
import type { LogContext, SearchHit } from "../log/search.ts";
import { applyGlyphs } from "./glyphs.ts";
import { contextMessages, hitRow, hitTime } from "./logSearch.ts";

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

test("contextMessages: Events read as they do on screen", () => {
  const context: LogContext = {
    serverId: "libera",
    network: "Libera.Chat",
    buffer: "#rust",
    bufferKind: "channel",
    match: 0,
    lines: [
      { id: 1, time: 0, kind: "message", nick: "me", text: "hi", self: true, mention: false },
      { id: 2, time: 0, kind: "join", nick: "bob", text: "", self: false, mention: false },
      { id: 3, time: 0, kind: "part", nick: "bob", text: "bye", self: false, mention: false },
      { id: 4, time: 0, kind: "quit", nick: "carol", text: "", self: false, mention: false },
      { id: 5, time: 0, kind: "nick", nick: "dave", subject: "dave_", text: "", self: false, mention: false },
      { id: 6, time: 0, kind: "kick", nick: "op", subject: "eve", text: "spam", self: false, mention: false },
      { id: 7, time: 0, kind: "topic", nick: "op", text: "Rust talk", self: false, mention: false },
    ],
  };
  expect(contextMessages(context).map((m) => [m.kind, m.from, m.text, m.isSelf])).toEqual([
    ["message", "me", "hi", true],
    ["join", undefined, "bob joined #rust", false],
    ["part", undefined, "bob left #rust (bye)", false],
    ["part", undefined, "carol quit", false],
    ["system", undefined, "dave is now known as dave_", false],
    ["error", undefined, "eve was kicked by op (spam)", false],
    ["system", undefined, "op changed the topic to: Rust talk", false],
  ]);
});

test("searchCommand: the words after /search", () => {
  expect(searchCommand("/search borrow checker")).toBe("borrow checker");
  expect(searchCommand("/SEARCH")).toBe("");
  expect(searchCommand("/searching")).toBeUndefined();
  expect(searchCommand("search")).toBeUndefined();
});
