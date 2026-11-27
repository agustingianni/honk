import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeIrcd } from "../../dev/fakeircd/server.ts";
import { until } from "../../dev/fakeircd/testing.ts";
import type { ChatMessage } from "../types.ts";
import { IrcManager } from "./manager.ts";
import {
  markReadParam,
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
    [["#honk", "*"], { target: "#honk", time: null }],
    [["#honk"], { target: "#honk", time: null }],
    [["#honk", "timestamp=soon"], undefined],
    [["#honk", "2026-11-26T22:00:00.000Z"], undefined],
    [[], undefined],
  ])("%j", (params, expected) => {
    expect(parseMarkRead(params)).toEqual(expected);
  });
});

test("markReadParam writes the time as the spec wants it", () => {
  expect(markReadParam(T)).toBe("timestamp=2026-11-26T22:00:00.000Z");
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
  test("skips lines honk made itself and lines still being sent", () => {
    const lines = [
      line("chat", 1),
      line("notice", 2, { kind: "notice" }),
      line("sending", 3, { isSelf: true, delivery: "pending" }),
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

beforeEach(async () => {
  irc = await FakeIrcd.start({ network: "alpha" });
  m = new IrcManager();
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
  expect(textOf("#bun", buffer("#bun")!.firstUnreadId)).toBe("goose: are you there?");
});

test("the channel on screen gets the divider and moves the marker", async () => {
  await readUpTo("#honk");
  await connect();
  m.setActive("alpha", "#honk");
  await until(() => buffer("#honk")!.messages.some((x) => x.text === "not read either"));
  expect(textOf("#honk", buffer("#honk")!.firstUnreadId)).toBe("goose: are you there?");
  expect(buffer("#honk")!.unread).toBe(0);

  const sent = await irc.waitFor(isMarkRead("#honk"), 3000);
  const newest = buffer("#honk")!.messages.findLast((x) => x.text === "not read either")!;
  expect(sent.params[1]).toBe(markReadParam(newest.timestamp.getTime()));
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

test("without focus, the channel on screen is not marked read", async () => {
  await connect();
  m.setActive("alpha", "#honk");
  // Let the marker for the join settle first.
  await Bun.sleep(1200);
  m.setFocused(false);
  irc.say("alice", "#honk", "while you were away");
  await until(() => buffer("#honk")!.messages.some((x) => x.text === "while you were away"));
  const sentWhileAway = await irc.waitFor(isMarkRead("#honk"), 1500).then(
    () => true,
    () => false,
  );
  expect(sentWhileAway).toBe(false);

  m.setFocused(true);
  await irc.waitFor(isMarkRead("#honk"), 2000);
});

test("a live line in the channel on screen gets no divider", async () => {
  await connect();
  m.setActive("alpha", "#honk");
  irc.say("alice", "#honk", "live, while you watch");
  await until(() => buffer("#honk")!.messages.some((x) => x.text === "live, while you watch"));
  expect(buffer("#honk")!.firstUnreadId).toBeUndefined();
  expect(buffer("#honk")!.unread).toBe(0);
});
