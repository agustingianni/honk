import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeIrcd } from "../../dev/fakeircd/server.ts";
import { until } from "../../dev/fakeircd/testing.ts";
import type { ChatMessage } from "../types.ts";
import { timestampParam } from "./ircLine.ts";
import { IrcManager } from "./manager.ts";
import { STATUS_BUFFER } from "./names.ts";
import {
  newestServerTime,
  parseMarkRead,
  unreadAfter,
} from "./readMarker.ts";

const T = Date.parse("2026-11-26T22:00:00.000Z");

function line(id: string, minutes: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    kind: "message",
    from: "alice",
    text: "hi",
    timestamp: new Date(T + minutes * 60_000),
    isHistory: true,
    ...overrides,
  };
}

describe("parseMarkRead", () => {
  test.each([
    [["#honk", "timestamp=2026-11-26T22:00:00.000Z"], { target: "#honk", time: T }],
    [["#honk", "*"], undefined],
    [["#honk"], undefined],
    [["#honk", "timestamp=soon"], undefined],
    [["#honk", "2026-11-26T22:00:00.000Z"], undefined],
    [[], undefined],
  ])("%j", (params, expected) => {
    expect(parseMarkRead(params)).toEqual(expected);
  });
});

describe("unreadAfter", () => {
  const forYou = (m: ChatMessage) => m.text.includes("goose");

  test("counts chat from others newer than the marker", () => {
    const lines = [
      line("old", -1),
      line("same", 0),
      line("bob", 1, { from: "bob" }),
      line("mine", 2, { from: "goose", isSelf: true }),
      line("join", 3, { kind: "join" }),
      line("histserv", 3, { from: "HistServ", text: "goose joined the channel" }),
      line("notice", 4, { kind: "notice" }),
      line("carol", 5, { from: "carol", kind: "action" }),
    ];
    expect(unreadAfter(lines, T, forYou)).toEqual({
      unread: 2,
      hasMention: false,
      firstUnreadId: "bob",
    });
  });

  test("a line for you after the marker gives a mention", () => {
    const lines = [line("before", -1, { text: "goose: old" }), line("after", 1, { text: "goose: new" })];
    expect(unreadAfter(lines, T, forYou)).toEqual({
      unread: 1,
      hasMention: true,
      firstUnreadId: "after",
    });
  });

  test("a marker past every line leaves nothing unread", () => {
    expect(unreadAfter([line("a", 1), line("b", 2)], T + 3 * 60_000, forYou)).toEqual({
      unread: 0,
      hasMention: false,
      firstUnreadId: undefined,
    });
  });
});

describe("newestServerTime", () => {
  test("skips lines honk made itself and your own lines, which have the local time", () => {
    const lines = [
      line("chat", 1),
      line("notice", 2, { kind: "notice" }),
      line("sending", 3, { isSelf: true, delivery: "pending" }),
      line("sent", 3, { isSelf: true }),
      line("joined", 4, { kind: "join" }),
      line("system", 5, { kind: "system" }),
    ];
    expect(newestServerTime(lines)).toBe(T + 2 * 60_000);
  });

  test("is undefined without a chat line", () => {
    expect(newestServerTime([line("joined", 1, { kind: "join" })])).toBeUndefined();
  });
});

// ---- Against fakeircd, which keeps one marker per target, like soju ----

let irc: FakeIrcd;
let m: IrcManager;

const server = () => m.getSnapshot().servers.find((s) => s.id === "alpha")!;
const buffer = (name: string) => server().buffers[name];
const textOf = (name: string, id: string | undefined) =>
  buffer(name)?.messages.find((x) => x.id === id)?.text;
/** The text of the line the divider is on in `name`. */
const dividerText = (name: string) => textOf(name, buffer(name)!.firstUnreadId);
const isMarkRead = (target: string) => (l: { command: string; params: string[] }) =>
  l.command === "MARKREAD" && l.params[0] === target && l.params.length === 2;

/** Lines in the server's history, then a marker after the first one. */
async function readUpTo(channel: string): Promise<void> {
  irc.say("alice", channel, "already read");
  await Bun.sleep(5);
  irc.setReadMarker(channel, Date.now());
  await Bun.sleep(5);
  irc.say("bob", channel, "goose: are you there?");
  irc.say("carol", channel, "not read either");
}

async function connect(): Promise<void> {
  m.addServer({
    id: "alpha",
    name: "alpha",
    host: "127.0.0.1",
    port: irc.port,
    tls: false,
    nick: "goose",
    channels: ["#honk", "#bun"],
    autoConnect: false,
  });
  await m.connectServer("alpha");
  await until(() => Boolean(buffer("#honk") && buffer("#bun")));
}

/** honk's wait before MARKREAD, shorter than the real 1 s so the tests run fast. */
const DELAY = 200;

/** True if honk sends MARKREAD for `target` within `ms`. */
const sendsMarkRead = (target: string, ms: number) =>
  irc.waitFor(isMarkRead(target), ms).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  irc = await FakeIrcd.start({ network: "alpha" });
  m = new IrcManager({ markReadDelayMs: DELAY });
});

afterEach(async () => {
  m.disconnectAll();
  await irc.stop();
});

test("after a restart, history past the marker is unread in a channel you are not in", async () => {
  await readUpTo("#bun");
  await connect();
  m.setActive("alpha", "#honk");
  await until(() => buffer("#bun")!.unread === 2);
  expect(buffer("#bun")!.hasMention).toBe(true);
  expect(dividerText("#bun")).toBe("goose: are you there?");
});

test("the channel on screen gets the divider and moves the marker", async () => {
  await readUpTo("#honk");
  await connect();
  m.setFocused(true);
  m.setActive("alpha", "#honk");
  await until(() => buffer("#honk")!.messages.some((x) => x.text === "not read either"));
  expect(dividerText("#honk")).toBe("goose: are you there?");

  const sent = await irc.waitFor(isMarkRead("#honk"), 3000);
  expect(buffer("#honk")!.unread).toBe(0);
  const newest = buffer("#honk")!.messages.findLast((x) => x.text === "not read either")!;
  expect(sent.params[1]).toBe(timestampParam(newest.timestamp.getTime()));
  expect(irc.readMarker("#honk")).toBe(newest.timestamp.getTime());
});

test("reading a channel on another client clears its badge here", async () => {
  await connect();
  m.setActive("alpha", "#honk");
  irc.say("alice", "#bun", "goose: ping");
  await until(() => buffer("#bun")!.unread === 1);
  expect(buffer("#bun")!.firstUnreadId).toBeDefined();

  irc.setReadMarker("#bun", Date.now());
  await until(() => buffer("#bun")!.unread === 0);
  expect(buffer("#bun")!.hasMention).toBe(false);
  expect(buffer("#bun")!.firstUnreadId).toBeUndefined();
});

test("a line read on another client stays read when its MARKREAD comes in the same read", async () => {
  await connect();
  m.setActive("alpha", "#honk");
  // One socket write, so honk gets both lines in one network read. fakeircd puts the
  // time tag (now) on the first line; the marker is a little later, so it covers it.
  const marker = Date.now() + 20;
  irc.sendRaw(
    `:alice!a@h PRIVMSG #bun :goose: hi\r\n:$NICK!g@h MARKREAD #bun ${timestampParam(marker)}`,
  );
  // TCP keeps the order: once this later line is in, the MARKREAD has been handled.
  irc.sendRaw(":carol!c@h PRIVMSG #honk :fence");
  await until(() => buffer("#honk")!.messages.some((x) => x.text === "fence"));
  expect(buffer("#bun")!.messages.some((x) => x.text === "goose: hi")).toBe(true);
  expect(buffer("#bun")!.unread).toBe(0);
  expect(buffer("#bun")!.hasMention).toBe(false);

  // A line newer than the marker still counts, with its mention.
  await Bun.sleep(marker - Date.now() + 10);
  irc.sendRaw(":bob!b@h PRIVMSG #bun :goose: still there?");
  await until(() => buffer("#bun")!.unread === 1);
  expect(buffer("#bun")!.hasMention).toBe(true);
});

test("without focus, the channel on screen is not marked read", async () => {
  await connect();
  m.setFocused(true);
  m.setActive("alpha", "#honk");
  // Let the marker for the join settle first.
  await Bun.sleep(DELAY * 1.5);
  m.setFocused(false);
  irc.say("alice", "#honk", "while you were away");
  await until(() => buffer("#honk")!.messages.some((x) => x.text === "while you were away"));
  expect(await sendsMarkRead("#honk", DELAY * 3)).toBe(false);

  m.setFocused(true);
  await irc.waitFor(isMarkRead("#honk"), 2000);
});

test("a live line in the channel on screen gets no divider", async () => {
  await connect();
  m.setFocused(true);
  m.setActive("alpha", "#honk");
  irc.say("alice", "#honk", "live, while you watch");
  await until(() => buffer("#honk")!.messages.some((x) => x.text === "live, while you watch"));
  expect(buffer("#honk")!.firstUnreadId).toBeUndefined();
  expect(buffer("#honk")!.unread).toBe(0);
});

test("a terminal that never reports focus marks read only after some input", async () => {
  await connect();
  m.setActive("alpha", "#honk");
  irc.say("alice", "#honk", "anyone?");
  expect(await sendsMarkRead("#honk", DELAY * 3)).toBe(false);

  m.noteActivity();
  expect(await sendsMarkRead("#honk", 2000)).toBe(true);
});

test("flipping past a channel does not mark it read", async () => {
  await connect();
  m.setFocused(true);
  m.setActive("alpha", "#honk");
  irc.say("alice", "#bun", "you skipped me");
  await until(() => buffer("#bun")!.unread === 1);
  await Bun.sleep(DELAY * 1.5);
  // A line in #honk starts the timer; you switch to #bun just before it fires.
  irc.say("alice", "#honk", "starts the timer");
  await until(() => buffer("#honk")!.messages.some((x) => x.text === "starts the timer"));
  await Bun.sleep(DELAY * 0.8);
  m.setActive("alpha", "#bun");
  expect(await sendsMarkRead("#bun", DELAY * 0.5)).toBe(false);
  m.setActive("alpha", "#honk");
  expect(await sendsMarkRead("#bun", DELAY * 1.5)).toBe(false);
});

test("leaving a channel you stayed on marks its newest line at once", async () => {
  await connect();
  m.setFocused(true);
  m.setActive("alpha", "#honk");
  irc.say("alice", "#honk", "first");
  await irc.waitFor(isMarkRead("#honk"), 2000);

  irc.say("alice", "#honk", "just before you leave");
  await until(() => buffer("#honk")!.messages.some((x) => x.text === "just before you leave"));
  m.setActive("alpha", "#bun");
  const last = buffer("#honk")!.messages.findLast((x) => x.text === "just before you leave")!;
  await until(() => irc.readMarker("#honk") === last.timestamp.getTime(), 300);
});

test("a DM you read on another client while honk was offline is not missed", async () => {
  await connect();
  irc.say("dave", "goose", "hi");
  await until(() => Boolean(buffer("dave")));

  irc.drop();
  await until(() => server().status !== "connected");
  irc.say("dave", "goose", "goose: read this on your phone");
  await Bun.sleep(5);
  irc.setReadMarker("dave", Date.now());

  await until(
    () => buffer("dave")!.messages.some((x) => x.text === "goose: read this on your phone"),
    10_000,
  );
  // The phone read everything up to its marker, "hi" from before the drop too.
  expect(buffer("dave")!.unread).toBe(0);
  expect(buffer("dave")!.hasMention).toBe(false);
}, 15_000);

test("a marker the server never got is sent again after a reconnect", async () => {
  await connect();
  m.setFocused(true);
  m.setActive("alpha", "#honk");
  irc.ignoreMarkRead = true;
  irc.say("alice", "#honk", "read me");
  await irc.waitFor(isMarkRead("#honk"), 2000);
  expect(irc.readMarker("#honk")).toBeUndefined();

  irc.ignoreMarkRead = false;
  irc.drop();
  await until(() => server().status !== "connected");
  await irc.waitFor(isMarkRead("#honk"), 10_000);
  await until(() => irc.readMarker("#honk") !== undefined);
}, 15_000);

describe("a server that refuses MARKREAD", () => {
  const errors = (name: string) =>
    (buffer(name)?.messages ?? []).filter((x) => x.kind === "error").map((x) => x.text);

  /** A new line in #honk, and the MARKREAD it leads to. */
  async function readOneMore(text: string): Promise<void> {
    irc.say("alice", "#honk", text);
    await irc.waitFor(isMarkRead("#honk"), 2000);
  }

  test("shows one error in *status per connection, none in the chat", async () => {
    irc.failMarkRead = true;
    await connect();
    m.setFocused(true);
    m.setActive("alpha", "#honk");
    for (const text of ["one", "two", "three"]) await readOneMore(text);
    await until(() => errors(STATUS_BUFFER).length > 0);
    await Bun.sleep(50);
    expect(errors("#honk")).toEqual([]);
    expect(errors(STATUS_BUFFER)).toEqual(["Could not save your read position: Internal error."]);

    irc.drop();
    await until(() => server().status !== "connected");
    await until(() => server().status === "connected", 10_000);
    await readOneMore("after the reconnect");
    await until(() => errors(STATUS_BUFFER).length === 2);
    await readOneMore("and one more");
    await Bun.sleep(50);
    expect(errors("#honk")).toEqual([]);
    expect(errors(STATUS_BUFFER)).toHaveLength(2);
  }, 15_000);
});

describe("a badge clears only when the buffer counts as read", () => {
  /** #honk on screen with focus, and five lines in #bun, the 2nd one a mention. */
  async function fiveUnreadInBun(): Promise<void> {
    await connect();
    m.setFocused(true);
    m.setActive("alpha", "#honk");
    for (const text of ["one", "goose: two", "three", "four", "five"]) {
      irc.say("alice", "#bun", text);
      // A new ms for each line, so a marker can fall between two of them.
      await Bun.sleep(2);
    }
    await until(() => buffer("#bun")!.unread === 5);
  }
  const timeOf = (text: string) =>
    buffer("#bun")!.messages.find((x) => x.text === text)!.timestamp.getTime();

  test("flipping past a channel keeps its badge, mention and divider", async () => {
    await fiveUnreadInBun();
    m.setActive("alpha", "#bun");
    m.setActive("alpha", "#honk");
    expect(await sendsMarkRead("#bun", DELAY * 2)).toBe(false);
    expect(buffer("#bun")).toMatchObject({ unread: 5, hasMention: true });
    expect(dividerText("#bun")).toBe("one");
  });

  test("staying on a channel for the delay clears its badge as MARKREAD goes out", async () => {
    await fiveUnreadInBun();
    m.setActive("alpha", "#bun");
    expect(buffer("#bun")!.unread).toBe(5);
    await irc.waitFor(isMarkRead("#bun"), 2000);
    expect(buffer("#bun")).toMatchObject({ unread: 0, hasMention: false });
    // The divider stays while you read, and goes when you leave.
    expect(dividerText("#bun")).toBe("one");
    m.setActive("alpha", "#honk");
    await until(() => buffer("#bun")!.firstUnreadId === undefined);
  });

  test("after a flip past, a marker from another client only lowers the count", async () => {
    await fiveUnreadInBun();
    m.setActive("alpha", "#bun");
    m.setActive("alpha", "#honk");
    irc.setReadMarker("#bun", timeOf("goose: two"));
    await until(() => buffer("#bun")!.unread === 3);
    expect(buffer("#bun")!.hasMention).toBe(false);
    expect(dividerText("#bun")).toBe("three");

    irc.setReadMarker("#bun", timeOf("five"));
    await until(() => buffer("#bun")!.unread === 0);
  });

  test("on a server without draft/read-marker, the badge clears after the same delay", async () => {
    irc.readMarkerCap = false;
    await fiveUnreadInBun();
    m.setActive("alpha", "#bun");
    m.setActive("alpha", "#honk");
    await Bun.sleep(DELAY * 2);
    expect(buffer("#bun")!.unread).toBe(5);

    m.setActive("alpha", "#bun");
    await until(() => buffer("#bun")!.unread === 0, DELAY * 5);
  });

  test("without focus, a channel you switch to keeps its badge until you are back", async () => {
    await fiveUnreadInBun();
    m.setFocused(false);
    m.setActive("alpha", "#bun");
    await Bun.sleep(DELAY * 2);
    expect(buffer("#bun")!.unread).toBe(5);

    m.setFocused(true);
    await Bun.sleep(DELAY / 2);
    expect(buffer("#bun")!.unread).toBe(5);
    await until(() => buffer("#bun")!.unread === 0, DELAY * 5);
  });

  test("a line that comes while you are on a channel with a badge counts too", async () => {
    await fiveUnreadInBun();
    m.setActive("alpha", "#bun");
    irc.say("alice", "#bun", "six");
    await until(() => buffer("#bun")!.unread === 6);
    m.setActive("alpha", "#honk");
    expect(buffer("#bun")!.unread).toBe(6);
  });

  test("lines that come after you read a channel get the divider, not the lines you read", async () => {
    await fiveUnreadInBun();
    m.setActive("alpha", "#bun");
    await irc.waitFor(isMarkRead("#bun"), 2000);
    m.setFocused(false);
    for (const text of ["a", "b", "c"]) irc.say("alice", "#bun", text);
    await until(() => buffer("#bun")!.unread === 3);
    expect(dividerText("#bun")).toBe("a");
  });

  test("sending a line before the delay keeps the badge and the divider", async () => {
    await fiveUnreadInBun();
    m.setActive("alpha", "#bun");
    m.handleInput("hi");
    m.setActive("alpha", "#honk");
    await Bun.sleep(10);
    expect(buffer("#bun")!.unread).toBe(5);
    expect(dividerText("#bun")).toBe("one");
  });

  test("a marker from another client lowers the badge of the channel on screen", async () => {
    await fiveUnreadInBun();
    m.setFocused(false);
    m.setActive("alpha", "#bun");
    irc.setReadMarker("#bun", timeOf("four"));
    await until(() => buffer("#bun")!.unread === 1);
    expect(dividerText("#bun")).toBe("five");
  });

  test("lines that come into the channel on screen while you are away stay unread", async () => {
    await connect();
    m.setFocused(true);
    m.setActive("alpha", "#bun");
    await Bun.sleep(DELAY * 1.5);
    m.setFocused(false);
    for (const text of ["a", "b", "c"]) irc.say("alice", "#bun", text);
    await until(() => buffer("#bun")!.unread === 3);
    m.setActive("alpha", "#honk");
    expect(buffer("#bun")!.unread).toBe(3);
    expect(dividerText("#bun")).toBe("a");
  });
});

describe("a mention in the channel on screen", () => {
  /** Collects whether each mention event says you saw the line. */
  function mentions(): boolean[] {
    const seen: boolean[] = [];
    m.onMention((event) => seen.push(event.seen));
    return seen;
  }

  test("counts as seen while you read the channel", async () => {
    const seen = mentions();
    await connect();
    m.setFocused(true);
    m.setActive("alpha", "#honk");
    irc.say("alice", "#honk", "goose: you there?");
    await until(() => seen.length === 1);
    expect(seen).toEqual([true]);
  });

  test("is not seen while the window has no focus", async () => {
    const seen = mentions();
    await connect();
    m.setFocused(false);
    m.setActive("alpha", "#honk");
    irc.say("alice", "#honk", "goose: you there?");
    await until(() => seen.length === 1);
    expect(seen).toEqual([false]);
  });

  test("is not seen in a terminal without focus reporting and no recent input", async () => {
    const seen = mentions();
    await connect();
    m.setActive("alpha", "#honk");
    irc.say("alice", "#honk", "goose: you there?");
    await until(() => seen.length === 1);
    expect(seen).toEqual([false]);

    m.noteActivity();
    irc.say("alice", "#honk", "goose: now?");
    await until(() => seen.length === 2);
    expect(seen).toEqual([false, true]);
  });
});
