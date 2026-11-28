/**
 * honk against fakeircd, writing a real logs.db. Each test checks the rows, and the
 * full-text index with FTS5's own integrity check.
 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeIrcd } from "../../dev/fakeircd/server.ts";
import { until } from "../../dev/fakeircd/testing.ts";
import { IrcManager } from "../irc/manager.ts";
import type { Casemapping } from "../irc/names.ts";
import { DEFAULT_LOG_SETTINGS, type Log, openLog } from "./log.ts";

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
  /** Quits honk and starts it again on the same Log. */
  const restart = async () => {
    m!.disconnectAll();
    log!.close();
    return start();
  };

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
  return { fake: irc, manager, server, query, rows, texts, checkIndex, search, restart };
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
  manager.disconnectServer("net");
  // 60 lines while away: more than the 50 the screen asks for on join.
  for (let i = 1; i <= 60; i++) fake.say("alice", "#honk", `away ${i}`);
  await manager.connectServer("net");
  await until(() => texts().includes("away 1"), 5000);

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
        seeding.add("net", { name: "#honk", kind: "channel" }, { ...line, time: start + i * 1000 });
      }
      seeding.add("net", { name: "#honk", kind: "channel" }, {
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
      seeding.add("net", { name: "#honk", kind: "channel" }, {
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
  const { fake, texts, restart } = await connect();
  fake.say("alice", "#honk", "before");
  await until(() => texts().includes("before"));
  // As if this connection had synced up to now. See logSync.ts.
  log!.setSyncMarker("net", Date.now());
  m!.disconnectAll();
  log!.close();
  // 60 lines while honk is closed: more than the 50 the screen asks for on join.
  for (let i = 1; i <= 60; i++) fake.say("alice", "#honk", `away ${i}`);
  await restart();
  const onScreen = () => shown(m!.getSnapshot().servers[0]!.buffers["#honk"]!.messages);
  await until(() => onScreen().includes("away 1"), 5000);

  expect(onScreen().filter((t) => t === "before")).toHaveLength(1);
  const away = onScreen().filter((t) => t.startsWith("away "));
  expect(away.toSorted()).toEqual(Array.from({ length: 60 }, (_, i) => `away ${i + 1}`).toSorted());
  expect(onScreen()[0]).toBe("before");
});

test("loadOlder above a Line not from the Log keeps the Log's Lines of the same time", async () => {
  const t = Date.parse("2026-11-27T21:35:07Z");
  const honk = { name: "#honk", kind: "channel" } as const;
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

test("a Buffer holds at most 5000 Lines, and then says that search finds the older ones", async () => {
  const start = Date.parse("2026-11-01T10:00:00Z");
  const { manager, server } = await connect({
    noCaps: true,
    seed: (seeding) => {
      for (let i = 1; i <= 5100; i++) {
        seeding.add("net", { name: "#honk", kind: "channel" }, {
          kind: "message", nick: "alice", text: `old ${i}`, time: start + i * 1000, timeFromServer: true,
        });
      }
    },
  });
  while (manager.loadOlder("net", "#honk") > 0);
  await Promise.resolve();
  const messages = server().buffers["#honk"]!.messages;
  expect(messages[0]!.text).toBe("honk holds 5000 lines of #honk. Search the log (Ctrl+F) for older ones.");
  expect(messages).toHaveLength(5001);
  expect(messages[1]!.text).toBe("old 102");
  // Once.
  manager.loadOlder("net", "#honk");
  await Promise.resolve();
  expect(server().buffers["#honk"]!.messages).toHaveLength(5001);
});
