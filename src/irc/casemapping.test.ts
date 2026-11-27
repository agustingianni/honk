import { afterEach, expect, test } from "bun:test";
import { FakeIrcd } from "../../dev/fakeircd/server.ts";
import { until } from "../../dev/fakeircd/testing.ts";
import { IrcManager } from "./manager.ts";
import type { ServerState } from "../types.ts";
import type { Casemapping } from "./names.ts";

let irc: FakeIrcd | undefined;
let m: IrcManager | undefined;

afterEach(async () => {
  m?.disconnectAll();
  await irc?.stop();
  irc = undefined;
  m = undefined;
});

/** honk connected to a FakeIrcd that sends `casemapping` in 005, in #foo[. */
async function connect(casemapping: Casemapping) {
  irc = await FakeIrcd.start({ casemapping });
  const manager = new IrcManager();
  m = manager;
  manager.addServer({
    id: "net",
    name: "net",
    host: "127.0.0.1",
    port: irc.port,
    tls: false,
    nick: "goose",
    channels: ["#foo["],
    autoConnect: false,
  });
  await manager.connectServer("net");
  const server = () => manager.getSnapshot().servers.find((s) => s.id === "net")!;
  await until(() => Boolean(server().buffers["#foo["]));
  const texts = (buffer: string) => server().buffers[buffer]?.messages.map((x) => x.text) ?? [];
  return { fake: irc, server, texts };
}

test("on an rfc1459 server, #foo[ and #FOO{ are one Buffer", async () => {
  const { fake, server, texts } = await connect("rfc1459");
  expect(server().casemapping).toBe("rfc1459");
  fake.sendRaw(":alice!alice@fake.host PRIVMSG #FOO{ :hello");
  await until(() => texts("#foo[").includes("hello"));
  expect(server().bufferOrder).toEqual(["*status", "#foo["]);
});

test("on an ascii server, #foo[ and #FOO{ are two Buffers", async () => {
  const { fake, server, texts } = await connect("ascii");
  expect(server().casemapping).toBe("ascii");
  fake.sendRaw(":alice!alice@fake.host PRIVMSG #FOO{ :hello");
  await until(() => texts("#FOO{").includes("hello"));
  expect(server().bufferOrder.toSorted()).toEqual(["#FOO{", "#foo[", "*status"].toSorted());
  expect(texts("#foo[")).not.toContain("hello");
});

/** Each DM's name and its lines. */
const dms = (server: () => ServerState) =>
  Object.values(server().buffers)
    .filter((b) => b.kind === "dm")
    .map((b) => [b.name, b.messages.map((x) => x.text)]);

test("on an rfc1459 server, Alice^ and alice~ write in one DM", async () => {
  const { fake, server, texts } = await connect("rfc1459");
  fake.sendRaw(":Alice^!a@fake.host PRIVMSG $NICK :one");
  await until(() => texts("Alice^").includes("one"));
  fake.sendRaw(":alice~!a@fake.host PRIVMSG $NICK :two");
  // The DM takes the casing the sender wrote with last.
  await until(() => texts("alice~").includes("two"));
  expect(dms(server)).toEqual([["alice~", ["one", "two"]]]);
});

test("on an rfc1459-strict server, Alice^ and alice~ are two DMs", async () => {
  const { fake, server, texts } = await connect("rfc1459-strict");
  fake.sendRaw(":Alice^!a@fake.host PRIVMSG $NICK :one");
  fake.sendRaw(":alice~!a@fake.host PRIVMSG $NICK :two");
  await until(() => texts("alice~").includes("two"));
  expect(dms(server)).toEqual([
    ["Alice^", ["one"]],
    ["alice~", ["two"]],
  ]);
});
