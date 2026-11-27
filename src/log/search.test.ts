import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClock } from "../fakeClock.ts";
import { DEFAULT_LOG_SETTINGS, type Log, type LogLine, openLog } from "./log.ts";
import { ftsMatch, parseSearch, type SearchQuery } from "./search.ts";

/** The query `text` parses to. Fails the test on a parse error. */
function query(text: string): SearchQuery {
  const parsed = parseSearch(text);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.query;
}

describe("parseSearch", () => {
  test("words and filters", () => {
    expect(query("from:alice in:#rust on:libera borrow check*")).toEqual({
      words: [
        { text: "borrow", prefix: false },
        { text: "check", prefix: true },
      ],
      from: "alice",
      in: "#rust",
      on: "libera",
    });
  });

  test("filter names ignore case, and a filter with no value yet is left out", () => {
    expect(query("FROM:alice in: lol")).toEqual({
      words: [{ text: "lol", prefix: false }],
      from: "alice",
    });
  });

  test("dates are local days: before: ends before the day, after: starts with it", () => {
    expect(query("after:2026-09-01 before:2026-10-01")).toEqual({
      words: [],
      after: new Date(2026, 8, 1).getTime(),
      before: new Date(2026, 9, 1).getTime(),
    });
  });

  test("a date honk can't read is an error", () => {
    expect(parseSearch("before:yesterday")).toEqual({
      error: "before: takes a date such as 2026-10-01",
    });
    expect(parseSearch("after:2026-02-30")).toEqual({
      error: "after: takes a date such as 2026-10-01",
    });
  });

  test("a word that is only * means nothing", () => {
    expect(query("* lol")).toEqual({ words: [{ text: "lol", prefix: false }] });
  });
});

describe("ftsMatch", () => {
  test("quotes each word, so FTS5 syntax in it is text", () => {
    expect(ftsMatch([{ text: 'say "NEAR(a b)" OR', prefix: false }])).toBe(
      '"say ""NEAR(a b)"" OR"',
    );
  });

  test("a * only where the user typed one", () => {
    expect(
      ftsMatch([
        { text: "borrow", prefix: false },
        { text: "che", prefix: true },
      ]),
    ).toBe('"borrow" "che"*');
  });

  test("no words: no match", () => {
    expect(ftsMatch([])).toBeUndefined();
  });
});

let dir: string;
const opened: Log[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "honk-search-"));
});

afterEach(() => {
  for (const log of opened.splice(0)) log.close();
  rmSync(dir, { recursive: true, force: true });
});

const T = Date.parse("2026-11-27T21:35:07.412Z");
const MINUTE = 60_000;

function open(pid = 1000, isAlive: (pid: number) => boolean = () => false): Log {
  const { log } = openLog(join(dir, "logs.db"), DEFAULT_LOG_SETTINGS, {
    pid,
    clock: fakeClock(T),
    isAlive,
  });
  opened.push(log!);
  return log!;
}

const line = (text: string, extra: Partial<LogLine> = {}): LogLine => ({
  kind: "message",
  nick: "alice",
  text,
  time: T,
  timeFromServer: true,
  ...extra,
});

const rust = { name: "#Rust", kind: "channel" } as const;
const honk = { name: "#honk", kind: "channel" } as const;

/** The texts of the hits for `text`, newest first. */
function texts(log: Log, text: string): string[] {
  const result = log.search(query(text));
  if ("error" in result) throw new Error(result.error);
  return result.hits.map((h) => h.text.map((part) => part.text).join(""));
}

describe("Log.search", () => {
  test("every word must match; newest first; formatting is left out", () => {
    const log = open();
    log.add("libera", rust, line("the \x02borrow\x02 checker", { time: T - 2 * MINUTE }));
    log.add("libera", rust, line("borrow checker again", { time: T }));
    log.add("libera", rust, line("borrow only", { time: T - MINUTE }));
    expect(texts(log, "borrow checker")).toEqual(["borrow checker again", "the borrow checker"]);
  });

  test("a trailing * matches the start of a word; without it the whole word must match", () => {
    const log = open();
    log.add("libera", rust, line("checking"));
    expect(texts(log, "check")).toEqual([]);
    expect(texts(log, "check*")).toEqual(["checking"]);
  });

  test("FTS5 operators in the query are plain words", () => {
    const log = open();
    log.add("libera", rust, line("cats OR dogs"));
    log.add("libera", rust, line("cats only"));
    expect(texts(log, "cats OR dogs")).toEqual(["cats OR dogs"]);
    expect(texts(log, 'NEAR("cats"')).toEqual([]);
  });

  test("an empty query finds nothing", () => {
    const log = open();
    log.add("libera", rust, line("hello"));
    expect(texts(log, "")).toEqual([]);
    expect(texts(log, "*")).toEqual([]);
  });

  test("the matched words are marked", () => {
    const log = open();
    log.add("libera", rust, line("Café au lait, cafe noir"));
    const result = log.search(query("cafe"));
    if ("error" in result) throw new Error(result.error);
    expect(result.hits[0]!.text).toEqual([
      { text: "Café", hit: true },
      { text: " au lait, ", hit: false },
      { text: "cafe", hit: true },
      { text: " noir", hit: false },
    ]);
  });

  test("a hit says where it is", () => {
    const log = open();
    log.setNetwork("libera", { display: "Libera.Chat" });
    log.add("libera", rust, line("lol", { kind: "action", nick: "bob" }));
    const result = log.search(query("lol"));
    if ("error" in result) throw new Error(result.error);
    expect(result.hits).toEqual([
      expect.objectContaining({
        time: T,
        serverId: "libera",
        network: "Libera.Chat",
        buffer: "#Rust",
        kind: "action",
        nick: "bob",
      }),
    ]);
  });

  test("filters: from:, in:, on:, before:, after:", () => {
    const log = open();
    const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
    log.add("libera", rust, line("x from alice", { time: day(2026, 9, 15) }));
    log.add("libera", rust, line("x from bob", { nick: "Bob", time: day(2026, 9, 16) }));
    log.add("libera", honk, line("x in honk", { time: day(2026, 9, 17) }));
    log.add("oftc", rust, line("x on oftc", { time: day(2026, 9, 18) }));
    log.add("libera", rust, line("x in august", { time: day(2026, 8, 31) }));
    log.add("libera", rust, line("x in october", { time: day(2026, 10, 1) }));
    expect(texts(log, "x from:bob")).toEqual(["x from bob"]);
    expect(texts(log, "x in:#honk")).toEqual(["x in honk"]);
    // Buffer names compare as the server compares them.
    expect(texts(log, "x in:#RUST on:oftc")).toEqual(["x on oftc"]);
    expect(texts(log, "x after:2026-09-01 before:2026-10-01")).toEqual([
      "x on oftc",
      "x in honk",
      "x from bob",
      "x from alice",
    ]);
  });

  test("filters alone list the lines they keep", () => {
    const log = open();
    log.add("libera", rust, line("one", { nick: "bob", time: T - MINUTE }));
    log.add("libera", rust, line("two", { nick: "bob" }));
    log.add("libera", rust, line("three"));
    log.add("libera", rust, { ...line(""), kind: "join", nick: "bob" });
    expect(texts(log, "from:bob")).toEqual(["two", "one"]);
  });

  test("redacted lines are not found", () => {
    const log = open();
    log.add("libera", rust, line("secret", { msgid: "a" }));
    log.add("libera", rust, line("secret too", { msgid: "b", nick: "bob" }));
    log.redact("libera", "a", "alice", T);
    expect(texts(log, "secret")).toEqual(["secret too"]);
    expect(texts(log, "from:alice")).toEqual([]);
  });

  test("only `limit` hits, and whether there are more", () => {
    const log = open();
    for (let i = 0; i < 5; i++) log.add("libera", rust, line(`lol ${i}`, { time: T + i }));
    const result = log.search(query("lol"), 3);
    if ("error" in result) throw new Error(result.error);
    expect(result.hits.length).toBe(3);
    expect(result.more).toBe(true);
  });

  test("a honk that only reads the Log searches it too", () => {
    const writer = open(1000);
    writer.add("libera", rust, line("hello"));
    writer.flush();
    const reader = open(2000, () => true);
    expect(reader.writable).toBe(false);
    expect(texts(reader, "hello")).toEqual(["hello"]);
  });
});

describe("Log.context", () => {
  test("the Lines around a hit, in order, from its Buffer only", () => {
    const log = open();
    for (let i = 0; i < 8; i++) {
      log.add("libera", rust, line(`rust ${i}`, { time: T + i * MINUTE }));
      log.add("libera", honk, line(`honk ${i}`, { time: T + i * MINUTE }));
    }
    const result = log.search(query("rust 4"));
    if ("error" in result) throw new Error(result.error);
    const context = log.context(result.hits[0]!.id, 2)!;
    expect(context.lines.map((l) => l.text)).toEqual(["rust 2", "rust 3", "rust 4", "rust 5", "rust 6"]);
    expect(context.match).toBe(2);
    expect(context).toMatchObject({ serverId: "libera", buffer: "#Rust", bufferKind: "channel" });
  });

  test("Events show in the context; redacted Lines do not", () => {
    const log = open();
    log.add("libera", rust, { ...line(""), kind: "join", nick: "bob", time: T - 2 });
    log.add("libera", rust, line("gone", { msgid: "x", time: T - 1 }));
    log.add("libera", rust, line("hello"));
    log.redact("libera", "x", "alice", T);
    const result = log.search(query("hello"));
    if ("error" in result) throw new Error(result.error);
    const context = log.context(result.hits[0]!.id)!;
    expect(context.lines.map((l) => l.kind)).toEqual(["join", "message"]);
    expect(context.match).toBe(1);
  });

  test("Lines at the same time keep the order they were written in", () => {
    const log = open();
    for (const text of ["a", "b", "c"]) log.add("libera", rust, line(text));
    const result = log.search(query("b"));
    if ("error" in result) throw new Error(result.error);
    expect(log.context(result.hits[0]!.id)!.lines.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });
});
