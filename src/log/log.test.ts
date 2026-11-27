import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClock } from "../fakeClock.ts";
import { HistoryBatch } from "../irc/replay.ts";
import {
  DEFAULT_LOG_SETTINGS,
  defaultLogPath,
  type LogLine,
  type LogSettings,
  type Log,
  openLog,
} from "./log.ts";
import { SCHEMA_VERSION } from "./schema.ts";

let dir: string;
let path: string;
const opened: Log[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "honk-log-"));
  path = join(dir, "honk", "logs.db");
});

afterEach(() => {
  for (const log of opened.splice(0)) log.close();
  rmSync(dir, { recursive: true, force: true });
});

const T = Date.parse("2026-11-27T21:35:07.412Z");
const SECOND = Math.floor(T / 1000) * 1000;

function open(
  settings: Partial<LogSettings> = {},
  pid = 1000,
  isAlive: (pid: number) => boolean = () => false,
) {
  const clock = fakeClock(T);
  const result = openLog(path, { ...DEFAULT_LOG_SETTINGS, ...settings }, {
    pid,
    clock,
    isAlive,
  });
  if (result.log) opened.push(result.log);
  return { ...result, log: result.log!, clock };
}

const line = (text: string, extra: Partial<LogLine> = {}): LogLine => ({
  kind: "message",
  nick: "alice",
  text,
  time: T,
  timeFromServer: true,
  ...extra,
});

const honk = { name: "#honk", kind: "channel" } as const;

/** The rows of the file, read with a second connection. */
function rows(sql = "SELECT kind, nick, text, msgid, ts FROM message ORDER BY ts, id") {
  const db = new Database(path, { readonly: true });
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
}

/** Runs FTS5's own check of the index. Throws if the index is corrupt. */
function checkIndex() {
  const db = new Database(path);
  try {
    db.run("INSERT INTO message_fts (message_fts) VALUES ('integrity-check')");
  } finally {
    db.close();
  }
}

function search(word: string) {
  return rows(
    `SELECT m.text FROM message_fts JOIN message m ON m.id = message_fts.rowid
     WHERE message_fts MATCH '"${word}"'`,
  ).map((r) => (r as { text: string }).text);
}

const texts = () => rows().map((r) => (r as { text: string }).text);

test("the path follows XDG_DATA_HOME", () => {
  expect(defaultLogPath({ XDG_DATA_HOME: "/x" })).toBe("/x/honk/logs.db");
  expect(defaultLogPath({ HOME: "/h" })).toEndWith("/.local/share/honk/logs.db");
});

test("a new file is private and named once in *status", () => {
  const first = open();
  expect(first.notices).toEqual([`honk keeps a log of your chats in ${path}.`]);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "honk")).mode & 0o777).toBe(0o700);
  first.log.close();
  expect(open().notices).toEqual([]);
});

test("logs: enabled false keeps no file", () => {
  const result = open({ enabled: false });
  expect(result.log).toBeUndefined();
  expect(result.off).toBe("logs.enabled is false in the config");
  expect(() => statSync(path)).toThrow();
});

test("a file from a newer honk is left alone and logging turns off", () => {
  open().log.close();
  const db = new Database(path);
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  db.close();
  const again = open();
  expect(again.log).toBeUndefined();
  expect(again.notices[0]).toContain("from a newer honk");
  expect(again.off).toStartWith("the log is from a newer honk");
});

test("lines wait about a second, or until 100 lines, then go to the file in one write", () => {
  const { log, clock } = open();
  log.add("libera", honk, line("one"));
  expect(texts()).toEqual([]);
  clock.advance(1000);
  expect(texts()).toEqual(["one"]);
  for (let i = 0; i < 100; i++) log.add("libera", honk, line(`n${i}`, { time: T + i }));
  expect(texts()).toHaveLength(101);
});

test("close writes the lines still waiting", () => {
  const { log } = open();
  log.add("libera", honk, line("bye"));
  log.close();
  expect(texts()).toEqual(["bye"]);
});

test("two identical lines in one second are both kept, and a Replay of them adds none", () => {
  const { log } = open();
  log.add("libera", honk, line("lol", { time: T }));
  log.add("libera", honk, line("lol", { time: T + 300 }));
  // soju's file store: whole seconds, no msgid.
  const batch = new HistoryBatch();
  log.add("libera", honk, line("lol", { time: SECOND, history: true }), batch);
  log.add("libera", honk, line("lol", { time: SECOND, history: true }), batch);
  log.flush();
  expect(texts()).toEqual(["lol", "lol"]);
  // A third copy in History is a real third line.
  const more = new HistoryBatch();
  for (let i = 0; i < 3; i++) {
    log.add("libera", honk, line("lol", { time: SECOND, history: true }), more);
  }
  log.flush();
  expect(texts()).toEqual(["lol", "lol", "lol"]);
  checkIndex();
});

test("the same msgid is stored once, live or in History", () => {
  const { log } = open();
  log.add("libera", honk, line("hi", { msgid: "AB12" }));
  log.add("libera", honk, line("hi", { msgid: "AB12" }));
  log.add("libera", honk, line("hi", { msgid: "AB12", history: true }));
  log.flush();
  expect(rows()).toHaveLength(1);
});

test("a Replay with a msgid gives it to the stored line without one", () => {
  const { log } = open();
  log.add("libera", honk, line("hi"));
  log.add("libera", honk, line("hi", { time: SECOND, msgid: "AB12", history: true }));
  log.flush();
  expect(rows()).toEqual([{ kind: "message", nick: "alice", text: "hi", msgid: "AB12", ts: T }]);
});

test("ZNC playback (time, no msgid) of lines stored with msgids adds nothing", () => {
  const { log } = open();
  log.add("libera", honk, line("one", { msgid: "m1" }));
  log.add("libera", honk, line("two", { msgid: "m2", time: T + 10 }));
  const batch = new HistoryBatch();
  log.add("libera", honk, line("one", { history: true }), batch);
  log.add("libera", honk, line("two", { time: T + 10, history: true }), batch);
  log.add("libera", honk, line("three", { time: T + 20, history: true }), batch);
  log.flush();
  expect(texts()).toEqual(["one", "two", "three"]);
});

test("a line timed by honk's clock matches History less than 2 seconds away", () => {
  const { log } = open();
  log.add("libera", honk, line("brb", { time: T + 1500, timeFromServer: false, self: true }));
  log.add("libera", honk, line("brb", { time: SECOND, history: true, msgid: "x" }));
  log.flush();
  expect(rows()).toEqual([{ kind: "message", nick: "alice", text: "brb", msgid: "x", ts: T + 1500 }]);
});

test("formatting does not hide a Replay", () => {
  const { log } = open();
  log.add("libera", honk, line("\x02bold\x02"));
  log.add("libera", honk, line("bold", { history: true }));
  log.flush();
  expect(texts()).toEqual(["\x02bold\x02"]);
});

test("on an rfc1459 server, #a[b] and #A{B} are one Buffer", () => {
  const { log } = open();
  log.setNetwork("libera", { casemapping: "rfc1459" });
  log.add("libera", { name: "#a[b]", kind: "channel" }, line("one"));
  log.add("libera", { name: "#A{B}", kind: "channel" }, line("two", { time: T + 1 }));
  log.flush();
  expect(rows("SELECT name, display FROM buffer")).toEqual([{ name: "#a{b}", display: "#A{B}" }]);
});

test("each soju network behind one Server has its own Buffers", () => {
  const { log } = open();
  log.setNetwork("soju", { bouncerNetId: "1", display: "Libera.Chat" });
  log.add("soju", honk, line("on libera"));
  log.setNetwork("soju", { bouncerNetId: "2", display: "OFTC" });
  log.add("soju", honk, line("on oftc"));
  log.flush();
  expect(rows("SELECT config_id, bouncer_net, display FROM network ORDER BY id")).toEqual([
    { config_id: "soju", bouncer_net: "1", display: "Libera.Chat" },
    { config_id: "soju", bouncer_net: "2", display: "OFTC" },
  ]);
  expect(rows("SELECT count(*) AS n FROM buffer")).toEqual([{ n: 2 }]);
});

test("excluded Buffers are never logged, folded by the server's casemapping", () => {
  const { log } = open({ exclude: ["NickServ"] });
  log.setNetwork("libera", { exclude: ["#secret"] });
  log.add("libera", { name: "nickserv", kind: "dm" }, line("identify"));
  log.add("libera", { name: "#SECRET", kind: "channel" }, line("shh"));
  log.add("oftc", { name: "#secret", kind: "channel" }, line("not secret here"));
  log.flush();
  expect(texts()).toEqual(["not secret here"]);
});

test("search finds Chat lines without accents or formatting, and no Events", () => {
  const { log } = open();
  log.add("libera", honk, line("Café \x0304rouge"));
  log.add("libera", honk, line("rouge", { kind: "quit", time: T + 1 }));
  log.flush();
  expect(search("cafe")).toEqual(["Café \x0304rouge"]);
  expect(search("rouge")).toEqual(["Café \x0304rouge"]);
  checkIndex();
});

test("a redacted line stays, marked with who and when, and search no longer finds it", () => {
  const { log } = open({ retentionDays: 1 });
  log.add("libera", honk, line("oops secret", { msgid: "m1" }));
  log.redact("libera", "m1", "alice", T + 5000);
  log.redact("libera", "m1", "alice", T + 6000);
  log.flush();
  expect(rows("SELECT text, redacted_at, redacted_by FROM message")).toEqual([
    { text: "oops secret", redacted_at: T + 5000, redacted_by: "alice" },
  ]);
  expect(search("secret")).toEqual([]);
  checkIndex();
  // Retention deletes it later without a second index delete.
  expect(log.pruneBatch(T + 2 * 86_400_000)).toBe(1);
  checkIndex();
});

test("retention removes old Events after 30 days and keeps Chat lines", () => {
  const { log } = open();
  const old = T - 31 * 86_400_000;
  log.add("libera", honk, line("joined", { kind: "join", time: old }));
  log.add("libera", honk, line("ancient chat", { time: old }));
  log.add("libera", honk, line("recent join", { kind: "join", time: T - 1000 }));
  log.flush();
  expect(log.pruneBatch(T)).toBe(1);
  expect(texts()).toEqual(["ancient chat", "recent join"]);
  checkIndex();
});

test("retentionDays removes old Chat lines too", () => {
  const { log } = open({ retentionDays: 7 });
  log.add("libera", honk, line("old", { time: T - 8 * 86_400_000 }));
  log.add("libera", honk, line("new"));
  log.flush();
  expect(log.pruneBatch(T)).toBe(1);
  expect(texts()).toEqual(["new"]);
  checkIndex();
});

test("a second honk reads the file but does not write it", () => {
  const first = open({}, 1000);
  const second = open({}, 2000, (pid) => pid === 1000);
  expect(second.notices).toEqual([
    "Another honk (pid 1000) writes the log, so this one does not write to it.",
  ]);
  expect(second.log.writable).toBe(false);
  second.log.add("libera", honk, line("from the second"));
  second.log.flush();
  first.log.add("libera", honk, line("from the first"));
  first.log.flush();
  expect(texts()).toEqual(["from the first"]);
});

test("the writer row of a process that is gone is taken over", () => {
  open({}, 1000);
  const second = open({}, 2000, () => false);
  expect(second.log.writable).toBe(true);
  expect(second.notices).toEqual([]);
});

test("the Sync marker is per Network and never moves back", () => {
  const { log } = open();
  expect(log.syncMarker("libera")).toBeUndefined();
  log.setSyncMarker("libera", T);
  log.setSyncMarker("libera", T - 5000);
  expect(log.syncMarker("libera")).toBe(T);
  log.setNetwork("libera", { bouncerNetId: "7" });
  expect(log.syncMarker("libera")).toBeUndefined();
});

test("a REDACT that comes before its Line marks the Line when it comes", () => {
  const { log } = open();
  log.redact("libera", "m9", "alice", T + 5000);
  log.add("libera", honk, line("too late", { msgid: "m9", history: true }));
  log.flush();
  expect(rows("SELECT text, redacted_by FROM message")).toEqual([
    { text: "too late", redacted_by: "alice" },
  ]);
  expect(search("late")).toEqual([]);
  checkIndex();
});

test("an existing folder for the Log becomes private too", () => {
  mkdirSync(join(dir, "honk"), { mode: 0o755 });
  chmodSync(join(dir, "honk"), 0o755);
  open();
  expect(statSync(join(dir, "honk")).mode & 0o777).toBe(0o700);
});
