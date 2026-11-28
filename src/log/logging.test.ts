/**
 * honk against fakeircd, writing a real logs.db. Each test checks the rows, and the
 * full-text index with FTS5's own integrity check.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeIrcd } from "../../dev/fakeircd/server.ts";
import { until } from "../../dev/fakeircd/testing.ts";
import { IrcManager } from "../irc/manager.ts";
import type { Casemapping } from "../irc/names.ts";
import { DEFAULT_LOG_SETTINGS, type Log, openLog } from "./log.ts";

/** How long a test waits for History after a reconnect. */
const HISTORY_WAIT_MS = 5000;
// Longer than a few HISTORY_WAIT_MS waits, so a slow wait fails in `until` with its own
// message, and stops polling before afterEach removes the Log file.
setDefaultTimeout(3 * HISTORY_WAIT_MS);

let irc: FakeIrcd | undefined;
let m: IrcManager | undefined;
let log: Log | undefined;
let dir: string | undefined;

afterEach(async () => {
  m?.disconnectAll();
  log?.close();
  await irc?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  irc = m = log = dir = undefined;
});

interface Row {
  buffer: string;
  kind: string;
  nick: string;
  subject: string | null;
  text: string;
  msgid: string | null;
  ts_server: number;
  self: number;
  mention: number;
  redacted_by: string | null;
}

async function connect(
  opts: {
    withhold?: string[];
    /** A server from before IRCv3: no caps, no tags, no History. */
    noCaps?: boolean;
    casemapping?: Casemapping;
    channel?: string;
    /** Writes to the Log before honk connects, as a past run did. */
    seed?: (log: Log) => void;
  } = {},
) {
  irc = await FakeIrcd.start({ casemapping: opts.casemapping ?? "ascii" });
  for (const cap of opts.withhold ?? []) irc.withheldCaps.add(cap);
  irc.rejectCap = opts.noCaps ?? false;
  dir = mkdtempSync(join(tmpdir(), "honk-logging-"));
  const path = join(dir, "logs.db");
  const channel = opts.channel ?? "#honk";
  const port = irc.port;
  /** Starts honk on the Log at `path`, connects, and waits for the join. */
  const start = async () => {
    log = openLog(path, DEFAULT_LOG_SETTINGS).log!;
    const manager = new IrcManager({ log });
    m = manager;
    manager.addServer({
      id: "net",
      name: "net",
      host: "127.0.0.1",
      port,
      tls: false,
      nick: "goose",
      channels: [channel],
      autoConnect: false,
    });
    await manager.connectServer("net");
    await until(() => server().buffers[channel]?.messages.some((x) => x.kind === "join") === true);
    manager.setActive("net", channel);
    return manager;
  };
  const server = () => m!.getSnapshot().servers.find((s) => s.id === "net")!;
  if (opts.seed) {
    const seeding = openLog(path, DEFAULT_LOG_SETTINGS).log!;
    opts.seed(seeding);
    seeding.close();
  }
  const manager = await start();

  const query = <T>(sql: string): T[] => {
    log!.flush();
    const db = new Database(path, { readonly: true });
    try {
      return db.query(sql).all() as T[];
    } finally {
      db.close();
    }
  };
  const rows = () =>
    query<Row>(
      `SELECT b.display AS buffer, m.kind, m.nick, m.subject, m.text, m.msgid, m.ts_server,
              m.self, m.mention, m.redacted_by
       FROM message m JOIN buffer b ON b.id = m.buffer_id ORDER BY m.ts, m.id`,
    );
  const texts = (kind = "message") => rows().filter((r) => r.kind === kind).map((r) => r.text);
  const checkIndex = () => {
    log!.flush();
    const db = new Database(path);
    try {
      db.run("INSERT INTO message_fts (message_fts) VALUES ('integrity-check')");
    } finally {
      db.close();
    }
  };
  const search = (word: string) =>
    query<{ text: string }>(
      `SELECT m.text FROM message_fts JOIN message m ON m.id = message_fts.rowid
       WHERE message_fts MATCH '"${word}"'`,
    ).map((r) => r.text);
  return { fake: irc, manager, server, query, rows, texts, checkIndex, search, start };
}

/** Quits honk after it synced up to now, as at the end of a run. See logSync.ts. */
function quitSynced() {
  log!.setSyncMarker("net", Date.now());
  m!.disconnectAll();
  log!.close();
}

/** A time tag in the whole second `s` seconds after a fixed start. */
const at = (s: number, ms = 0) => new Date(Date.parse("2026-11-27T21:35:00Z") + s * 1000 + ms).toISOString();

test("live lines, Events, and your line with its Echo each enter the Log once", async () => {
  const { fake, manager, rows, texts, checkIndex } = await connect();
  fake.say("alice", "#honk", "hello goose");
  await until(() => texts().includes("hello goose"));
  manager.handleInput("hi all");
  await until(() => texts().includes("hi all"));
  fake.part("bob", "#honk", "bye");
  fake.renick("carol", "caroline");
  await until(() => rows().some((r) => r.kind === "nick"));

  const all = rows();
  expect(all.map((r) => [r.kind, r.nick, r.text])).toEqual([
    ["join", "goose", ""],
    ["message", "alice", "hello goose"],
    ["message", "goose", "hi all"],
    ["part", "bob", "bye"],
    ["nick", "carol", ""],
  ]);
  expect(all.every((r) => r.buffer === "#honk")).toBe(true);
  expect(all[1]).toMatchObject({ mention: 1, self: 0, ts_server: 1 });
  // The Echo gave your line the server's msgid and time.
  expect(all[2]).toMatchObject({ self: 1, ts_server: 1 });
  expect(all[2]!.msgid).toStartWith("m");
  expect(all[4]!.subject).toBe("caroline");
  checkIndex();
});

test("without echo-message, your line enters the Log when the delivery check confirms it", async () => {
  const { manager, rows, texts } = await connect({ withhold: ["echo-message"] });
  manager.handleInput("no echo here");
  await until(() => texts().includes("no echo here"));
  expect(rows().find((r) => r.text === "no echo here")).toMatchObject({
    self: 1,
    msgid: null,
    ts_server: 0,
  });
});

test("your line whose Echo never came is not logged", async () => {
  const { fake, manager, server, texts } = await connect();
  fake.holdEchoes = true;
  manager.handleInput("lost in the void");
  await until(() => fake.heldEchoCount === 1);
  // The PONG after it came back; the line still waits for its Echo.
  await until(() =>
    server().buffers["#honk"]!.messages.some((x) => x.text === "lost in the void" && !x.delivery),
  );
  fake.drop();
  await until(() => server().status !== "connected");
  expect(texts()).not.toContain("lost in the void");
});

test("a DM is its own Buffer, and every line in it is a Mention", async () => {
  const { fake, rows } = await connect();
  fake.say("alice", "goose", "psst");
  await until(() => rows().some((r) => r.text === "psst"));
  expect(rows().find((r) => r.text === "psst")).toMatchObject({ buffer: "alice", mention: 1 });
});

test("two identical lines in one second stay two after a Replay without msgids", async () => {
  const { fake, texts, checkIndex } = await connect({ withhold: ["message-tags"] });
  fake.sendRaw(`@time=${at(7, 100)} :alice!a@h PRIVMSG #honk :lol`);
  fake.sendRaw(`@time=${at(7, 600)} :alice!a@h PRIVMSG #honk :lol`);
  await until(() => texts().length === 2);
  // soju's file store plays them back cut to the second, with one new line.
  fake.sendRaw(":fake.irc BATCH +r1 chathistory #honk");
  fake.sendRaw(`@batch=r1;time=${at(7)} :alice!a@h PRIVMSG #honk :lol`);
  fake.sendRaw(`@batch=r1;time=${at(7)} :alice!a@h PRIVMSG #honk :lol`);
  fake.sendRaw(`@batch=r1;time=${at(8)} :bob!b@h PRIVMSG #honk :new`);
  fake.sendRaw(":fake.irc BATCH -r1");
  await until(() => texts().includes("new"));
  expect(texts()).toEqual(["lol", "lol", "new"]);
  checkIndex();
});

test("a Replay with a msgid gives it to the line logged without one", async () => {
  const { fake, rows, texts } = await connect();
  fake.sendRaw(`@time=${at(7, 412)} :alice!a@h PRIVMSG #honk :hi`);
  await until(() => texts().includes("hi"));
  fake.sendRaw(":fake.irc BATCH +r1 chathistory #honk");
  fake.sendRaw(`@batch=r1;time=${at(7, 412)};msgid=AB12 :alice!a@h PRIVMSG #honk :hi`);
  fake.sendRaw(":fake.irc BATCH -r1");
  await until(() => rows().some((r) => r.msgid === "AB12"));
  expect(texts()).toEqual(["hi"]);
});

test("each line of the multiline fallback is its own Line, and the first has the msgid", async () => {
  const { fake, rows } = await connect();
  fake.sendRaw(`@msgid=ml1;time=${at(9)} :alice!a@h PRIVMSG #honk :how is`);
  fake.sendRaw(`@time=${at(9)} :alice!a@h PRIVMSG #honk :everyone?`);
  await until(() => rows().some((r) => r.text === "everyone?"));
  expect(rows().filter((r) => r.kind === "message").map((r) => [r.text, r.msgid])).toEqual([
    ["how is", "ml1"],
    ["everyone?", null],
  ]);
});

test("a redacted line stays, marked, and search no longer finds it", async () => {
  const { fake, rows, search, checkIndex } = await connect();
  fake.say("alice", "#honk", "my password is hunter2");
  await until(() => rows().some((r) => r.text.includes("hunter2")));
  expect(search("hunter2")).toHaveLength(1);
  const msgid = rows().find((r) => r.text.includes("hunter2"))!.msgid!;
  fake.sendRaw(`:alice!a@h REDACT #honk ${msgid} :oops`);
  await until(() => rows().some((r) => r.redacted_by === "alice"));
  expect(search("hunter2")).toEqual([]);
  checkIndex();
});

test("on an rfc1459 server, #foo[ and #FOO{ are one Buffer in the Log", async () => {
  const { fake, query } = await connect({ casemapping: "rfc1459", channel: "#foo[" });
  fake.sendRaw(":alice!a@h PRIVMSG #FOO{ :hello");
  await until(() => query("SELECT 1 FROM message WHERE text = 'hello'").length === 1);
  expect(query("SELECT name FROM buffer")).toEqual([{ name: "#foo{" }]);
});

test("after a reconnect, honk asks for the History the Log misses and stores and shows it once", async () => {
  const { fake, manager, server, texts, checkIndex } = await connect();
  fake.say("alice", "#honk", "before");
  await until(() => texts().includes("before"));
  // As if this connection had synced up to now. See logSync.ts.
  log!.setSyncMarker("net", Date.now());
  // 60 lines while away: more than the 50 the screen asks for on join.
  await whileAway(manager, () => {
    for (let i = 1; i <= 60; i++) fake.say("alice", "#honk", `away ${i}`);
  });
  await until(() => texts().includes("away 1"), HISTORY_WAIT_MS);

  // Each line once. fakeircd gives many of them the same millisecond, so the order of
  // those depends on which request stored them first.
  const away = texts().filter((t) => t.startsWith("away "));
  expect(away.toSorted()).toEqual(Array.from({ length: 60 }, (_, i) => `away ${i + 1}`).toSorted());
  expect(texts().filter((t) => t === "before")).toHaveLength(1);
  // The Log's own requests reached the screen too, so it has no hole.
  const onScreen = shown(server().buffers["#honk"]!.messages);
  expect(onScreen.filter((t) => t.startsWith("away ")).toSorted()).toEqual(away.toSorted());
  checkIndex();
});

test("after a reconnect, Lines in the same millisecond as the Sync marker are filled too", async () => {
  const { fake, manager, texts } = await connect();
  await whileAway(manager, () => {
    for (let i = 1; i <= 60; i++) fake.say("alice", "#honk", `away ${i}`);
    // The marker has the time of "away 11", the oldest Line of the screen's 50. Lines
    // of that same millisecond before it are not in that batch.
    log!.setSyncMarker("net", fake.storedTime("away 11")!);
  });
  await until(() => texts().includes("away 1"), HISTORY_WAIT_MS);
  expect(texts().filter((t) => t.startsWith("away "))).toHaveLength(60);
});

test("after a reconnect, a channel with a few Lines while away gets them with no fill", async () => {
  const { fake, manager, texts } = await connect();
  fake.say("alice", "#honk", "before");
  await until(() => texts().includes("before"));
  log!.setSyncMarker("net", Date.now());
  await whileAway(manager, () => {
    for (let i = 1; i <= 3; i++) fake.say("alice", "#honk", `away ${i}`);
  });
  await until(() => texts().includes("away 3"), HISTORY_WAIT_MS);
  const fills = fake.received.filter((l) => l.command === "CHATHISTORY" && l.params[0] === "AFTER");
  expect(fills).toEqual([]);
  expect(texts().filter((t) => t.startsWith("away ")).toSorted()).toEqual(["away 1", "away 2", "away 3"]);
});

test("a server without IRCv3: every live Line is logged with honk's time, and no History is asked", async () => {
  const { fake, rows, texts } = await connect({ noCaps: true });
  fake.say("alice", "#honk", "plain old irc");
  fake.say("alice", "#honk", "plain old irc");
  await until(() => texts().length === 2);
  expect(rows().filter((r) => r.kind === "message").map((r) => [r.msgid, r.ts_server])).toEqual([
    [null, 0],
    [null, 0],
  ]);
  expect(fake.received.some((l) => l.command === "CHATHISTORY")).toBe(false);
});

test("an Echo with changed text: the Log keeps the server's text", async () => {
  const { fake, manager, rows, texts } = await connect();
  // The channel strips colors (+c), so the server echoes the line without them.
  fake.holdEchoes = true;
  manager.handleInput("\x0304red alert");
  await until(() => fake.heldEchoCount === 1);
  fake.sendRaw(`@msgid=e1;time=${new Date().toISOString()} :goose!g@h PRIVMSG #honk :red alert`);
  await until(() => texts().length === 1);
  expect(rows().filter((r) => r.kind === "message")).toMatchObject([
    { text: "red alert", msgid: "e1", self: 1 },
  ]);
});

test("a notice to you goes in the DM with its sender; one from the server stays out", async () => {
  const { fake, rows } = await connect();
  fake.sendRaw(":NickServ!services@services.fake NOTICE $NICK :You are now identified");
  fake.sendRaw(":fake.irc NOTICE $NICK :*** Server restarting soon");
  fake.say("alice", "#honk", "after");
  await until(() => rows().some((r) => r.text === "after"));
  expect(rows().filter((r) => r.kind === "notice")).toMatchObject([
    { buffer: "NickServ", nick: "NickServ", text: "You are now identified", mention: 1 },
  ]);
});

test("a REDACT inside a History batch marks a Line of the same batch", async () => {
  const { fake, rows, search } = await connect();
  fake.sendRaw(":fake.irc BATCH +r1 chathistory #honk");
  fake.sendRaw(`@batch=r1;time=${at(1)};msgid=h1 :alice!a@h PRIVMSG #honk :secret token`);
  fake.sendRaw(`@batch=r1;time=${at(2)};msgid=h2 :alice!a@h REDACT #honk h1`);
  fake.sendRaw(":fake.irc BATCH -r1");
  await until(() => rows().some((r) => r.msgid === "h1"));
  expect(rows().find((r) => r.msgid === "h1")?.redacted_by).toBe("alice");
  expect(search("token")).toEqual([]);
});



const honk = { name: "#honk", kind: "channel" } as const;

/** The texts of the Chat lines in a Buffer on screen. */
const shown = (messages: { kind: string; text: string }[]) =>
  messages.filter((x) => x.kind === "message").map((x) => x.text);

test("a Buffer opens with its last 200 Lines from the Log, and loadOlder pages back", async () => {
  const start = Date.parse("2026-11-01T10:00:00Z");
  const { manager, server } = await connect({
    noCaps: true,
    seed: (seeding) => {
      for (let i = 1; i <= 250; i++) {
        const line = { kind: "message" as const, nick: "alice", text: `old ${i}`, timeFromServer: true };
        seeding.add("net", honk, { ...line, time: start + i * 1000 });
      }
      seeding.add("net", honk, {
        kind: "message", nick: "bob", text: "oops", time: start + 300_000, timeFromServer: true, msgid: "x1",
      });
      seeding.redact("net", "x1", "bob", start + 301_000);
    },
  });
  const messages = () => server().buffers["#honk"]!.messages;
  const first = shown(messages());
  expect(first).toHaveLength(200);
  expect(first[0]).toBe("old 52");
  expect(first.slice(-2)).toEqual(["old 250", "[message deleted by bob]"]);
  // Lines from the Log come before this run's own.
  expect(messages().at(-1)?.text).toBe("You joined #honk");

  expect(manager.loadOlder("net", "#HONK")).toBe(51);
  await Promise.resolve();
  expect(shown(messages()).slice(0, 2)).toEqual(["old 1", "old 2"]);
  expect(shown(messages())).toHaveLength(251);
  expect(manager.loadOlder("net", "#honk")).toBe(0);
});

test("with a Sync marker, a Buffer with Lines in the Log asks only for the History after it", async () => {
  const marker = Date.parse("2026-11-27T21:00:00Z");
  const { fake, manager } = await connect({
    seed: (seeding) => {
      seeding.add("net", honk, {
        kind: "message", nick: "alice", text: "earlier", time: marker - 60_000, timeFromServer: true,
      });
      seeding.setSyncMarker("net", marker);
    },
  });
  const request = (target: string) =>
    fake.received.find((l) => l.command === "CHATHISTORY" && l.params[1] === target)?.params;
  await until(() => request("#honk") !== undefined);
  expect(request("#honk")).toEqual(["LATEST", "#honk", "timestamp=2026-11-27T20:59:55.000Z", "50"]);
  // The Log has nothing of #new, so the marker says nothing about it.
  manager.handleInput("/join #new");
  await until(() => request("#new") !== undefined);
  expect(request("#new")).toEqual(["LATEST", "#new", "*", "50"]);
});

test("after a restart, the screen shows the Log and then the History it missed, each Line once", async () => {
  const { fake, texts, start } = await connect();
  fake.say("alice", "#honk", "before");
  await until(() => texts().includes("before"));
  quitSynced();
  // 60 lines while honk is closed: more than the 50 the screen asks for on join.
  for (let i = 1; i <= 60; i++) fake.say("alice", "#honk", `away ${i}`);
  await start();
  const onScreen = () => shown(m!.getSnapshot().servers[0]!.buffers["#honk"]!.messages);
  await until(() => onScreen().includes("away 1"), HISTORY_WAIT_MS);

  expect(onScreen().filter((t) => t === "before")).toHaveLength(1);
  const away = onScreen().filter((t) => t.startsWith("away "));
  expect(away.toSorted()).toEqual(Array.from({ length: 60 }, (_, i) => `away ${i + 1}`).toSorted());
  expect(onScreen()[0]).toBe("before");
});

test("loadOlder above a Line not from the Log keeps the Log's Lines of the same time", async () => {
  const t = Date.parse("2026-11-27T21:35:07Z");
  
  const { fake, manager, server } = await connect({
    seed: (seeding) => {
      for (const [text, msgid] of [["x", "m1"], ["y", "m2"]]) {
        seeding.add("net", honk, { kind: "message", nick: "alice", text: text!, msgid, time: t, timeFromServer: true });
      }
    },
  });
  manager.handleInput("/clear");
  // A live Line in the same second as the Log's Lines. It enters the Log too.
  fake.sendRaw(`@msgid=m3;time=${new Date(t).toISOString()} :alice!a@h PRIVMSG #honk :z`);
  const messages = () => server().buffers["#honk"]!.messages;
  await until(() => shown(messages()).includes("z"));
  expect(manager.loadOlder("net", "#honk")).toBe(2);
  await Promise.resolve();
  expect(shown(messages())).toEqual(["x", "y", "z"]);
});

test("scrolling to the top of a channel you just joined shows your join once", async () => {
  const { manager, server, rows } = await connect();
  await until(() => rows().some((r) => r.kind === "join" && r.self === 1));
  expect(manager.loadOlder("net", "#honk")).toBe(0);
  await Promise.resolve();
  const joins = server().buffers["#honk"]!.messages.filter((x) => x.kind === "join");
  expect(joins.map((x) => x.text)).toEqual(["You joined #honk"]);
});

test("a Buffer holds at most 5000 Lines, and then is marked full", async () => {
  const start = Date.parse("2026-11-01T10:00:00Z");
  const { manager, server } = await connect({
    noCaps: true,
    seed: (seeding) => {
      for (let i = 1; i <= 5100; i++) {
        seeding.add("net", honk, {
          kind: "message", nick: "alice", text: `old ${i}`, time: start + i * 1000, timeFromServer: true,
        });
      }
    },
  });
  while (manager.loadOlder("net", "#honk") > 0);
  await Promise.resolve();
  const messages = server().buffers["#honk"]!.messages;
  expect(messages).toHaveLength(5000);
  expect(messages[0]!.text).toBe("old 102");
  expect(server().buffers["#honk"]!.scrollbackFull).toBe(true);
});

test("a DM sent while honk was closed enters the Log once after the next start, and opens with a badge", async () => {
  const { fake, rows, start } = await connect();
  quitSynced();
  fake.say("dave", "goose", "you there?");
  await start();
  const dm = () => m!.getSnapshot().servers[0]!.buffers["dave"];
  await until(() => dm()?.messages.some((x) => x.text === "you there?") === true, HISTORY_WAIT_MS);

  expect(rows().filter((r) => r.text === "you there?").map((r) => [r.buffer, r.mention])).toEqual([
    ["dave", 1],
  ]);
  expect(dm()!.hasMention).toBe(true);
});

test("60 DMs while honk was closed: the Log fills the gap past the first 50, each Line once", async () => {
  const { fake, texts, start } = await connect();
  quitSynced();
  for (let i = 1; i <= 60; i++) fake.say("dave", "goose", `dm ${i}`);
  await start();
  await until(() => texts().includes("dm 1"), HISTORY_WAIT_MS);

  const all = Array.from({ length: 60 }, (_, i) => `dm ${i + 1}`).toSorted();
  expect(texts().filter((t) => t.startsWith("dm ")).toSorted()).toEqual(all);
  const onScreen = shown(m!.getSnapshot().servers[0]!.buffers["dave"]!.messages);
  expect(onScreen.filter((t) => t.startsWith("dm ")).toSorted()).toEqual(all);
});

test("on the first start, with no Sync marker, honk does not ask who wrote to you", async () => {
  const { fake, server } = await connect();
  fake.say("alice", "#honk", "a live line after the MOTD");
  await until(() => shown(server().buffers["#honk"]!.messages).includes("a live line after the MOTD"));
  expect(fake.received.some((l) => l.command === "CHATHISTORY" && l.params[0] === "TARGETS")).toBe(false);
});

test.each([
  ["leaves it out", (fake: FakeIrcd) => fake.hiddenTargets.add("dave")],
  ["fails", (fake: FakeIrcd) => (fake.failTargets = true)],
])("a DM open on screen gets the History it missed when TARGETS %s", async (_, setUp) => {
  const { fake, manager, server, texts } = await connect();
  fake.say("dave", "goose", "hi");
  await until(() => texts().includes("hi"));
  log!.setSyncMarker("net", Date.now());
  await whileAway(manager, () => {
    fake.say("dave", "goose", "while away");
    setUp(fake);
  });
  await until(() => texts().includes("while away"), HISTORY_WAIT_MS);

  expect(shown(server().buffers["dave"]!.messages)).toEqual(["hi", "while away"]);
});

/**
 * Puts the Sync marker back to `start` and reconnects, so the History after it plays
 * again. Waits until #honk has had `requests` History requests in all, and a moment more.
 */
async function replayHistory(fake: FakeIrcd, manager: IrcManager, start: number, requests: number) {
  log!.setSyncMarker("net", start);
  await whileAway(manager, () => {});
  const asked = () => fake.received.filter((l) => l.command === "CHATHISTORY" && l.params[1] === "#honk");
  await until(() => asked().length === requests, HISTORY_WAIT_MS);
  await Bun.sleep(100);
}

/** Disconnects, lets `away` happen on the server, and connects again. */
async function whileAway(manager: IrcManager, away: () => void) {
  manager.disconnectServer("net");
  away();
  await manager.connectServer("net");
}

test("a JOIN in a History batch enters the Log once, and still once after the batch plays again", async () => {
  const { fake, manager, rows } = await connect();
  const joins = () => rows().filter((r) => r.kind === "join" && r.nick === "dave");
  const start = Date.now();
  log!.setSyncMarker("net", start);
  await whileAway(manager, () => fake.join("dave", "#honk"));
  await until(() => joins().length > 0, HISTORY_WAIT_MS);
  expect(joins().map((r) => [r.buffer, r.ts_server, r.msgid !== null])).toEqual([["#honk", 1, true]]);

  // The same History again: the marker is back before the JOIN.
  await replayHistory(fake, manager, start, 3);
  expect(joins()).toHaveLength(1);
});

test("PART, KICK, QUIT and NICK Events and topics in History enter the Log as they do live", async () => {
  const { fake, manager, rows } = await connect();
  for (const nick of ["dave", "erin", "frank", "gina"]) fake.join(nick, "#honk");
  await until(() => rows().filter((r) => r.kind === "join").length === 5);
  log!.setSyncMarker("net", Date.now());
  await whileAway(manager, () => {
    fake.part("dave", "#honk", "bye");
    fake.kick("alice", "#honk", "erin", "spam");
    fake.quit("frank", "gone");
    fake.renick("gina", "gina_");
    fake.setTopic("#honk", "new topic", "alice");
  });
  const events = () =>
    rows()
      .filter((r) => r.kind !== "join" && r.kind !== "message")
      .map((r) => [r.buffer, r.kind, r.nick, r.subject, r.text]);
  await until(() => events().length === 5, HISTORY_WAIT_MS);
  expect(events()).toEqual([
    ["#honk", "part", "dave", null, "bye"],
    ["#honk", "kick", "alice", "erin", "spam"],
    ["#honk", "quit", "frank", null, "gone"],
    ["#honk", "nick", "gina", "gina_", ""],
    ["#honk", "topic", "alice", null, "new topic"],
  ]);
});

test("without draft/event-playback, Ergo's HistServ lines stay out of the Log", async () => {
  const { fake, manager, rows, texts } = await connect({ withhold: ["draft/event-playback"] });
  log!.setSyncMarker("net", Date.now());
  await whileAway(manager, () => {
    fake.join("dave", "#honk");
    fake.say("dave", "#honk", "hi");
  });
  await until(() => texts().includes("hi"), HISTORY_WAIT_MS);
  expect(rows().filter((r) => r.nick === "HistServ" || r.nick === "dave").map((r) => [r.kind, r.text])).toEqual([
    ["message", "hi"],
  ]);
});

test("an Event seen live and then again in History is one Line", async () => {
  const { fake, manager, rows } = await connect();
  const start = Date.now();
  fake.join("dave", "#honk");
  fake.part("dave", "#honk", "bye");
  const dave = () => rows().filter((r) => r.nick === "dave").map((r) => r.kind);
  await until(() => dave().length === 2);
  // The marker is back before them, so the reconnect's History holds them again.
  await replayHistory(fake, manager, start, 2);
  expect(dave()).toEqual(["join", "part"]);
});
