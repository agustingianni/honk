import { afterEach, beforeEach, expect, test } from "bun:test";
import { FakeIrcd } from "../../dev/fakeircd/server.ts";
import { until } from "../../dev/fakeircd/testing.ts";
import type { ServerConfig } from "../types.ts";
import { IrcManager } from "./manager.ts";

// Like soju and Ergo, fakeircd registers a client as soon as NICK and USER are in.
// CAP LS must come first, or the caps (chat history, read markers, server-time) are
// turned on only after the JOINs.

let irc: FakeIrcd;
let m: IrcManager;

const server = () => m.getSnapshot().servers.find((s) => s.id === "alpha")!;
const texts = (buffer: string) => server().buffers[buffer]?.messages.map((x) => x.text) ?? [];

async function connect(extra: Partial<ServerConfig> = {}): Promise<void> {
  m.addServer({
    id: "alpha",
    name: "alpha",
    host: "127.0.0.1",
    port: irc.port,
    tls: false,
    nick: "goose",
    channels: ["#honk"],
    autoConnect: false,
    ...extra,
  });
  await m.connectServer("alpha");
  await until(() => Boolean(server().buffers["#honk"]));
}

beforeEach(async () => {
  irc = await FakeIrcd.start({ network: "alpha" });
  m = new IrcManager();
});

afterEach(async () => {
  m.disconnectAll();
  await irc.stop();
});

test.each([
  ["a server password", { serverPassword: "pw" }, ["CAP", "PASS", "NICK", "USER"]],
  ["no login at all", {}, ["CAP", "NICK", "USER"]],
])("with %s, CAP LS goes first and history loads", async (_, auth, first) => {
  irc.say("alice", "#honk", "said before you came");
  await connect(auth);
  await until(() => texts("#honk").includes("said before you came"));
  expect(irc.received.slice(0, first.length).map((l) => l.command)).toEqual(first);
  expect(irc.received[0]?.params).toEqual(["LS", "302"]);
  expect(
    irc.received.some(
      (l) => l.command === "CHATHISTORY" && l.params[0] === "LATEST" && l.params[1] === "#honk",
    ),
  ).toBe(true);
});

test("the read marker the server has at connect reaches honk", async () => {
  irc.say("alice", "#bun", "already read");
  await Bun.sleep(5);
  irc.setReadMarker("#bun", Date.now());
  await Bun.sleep(5);
  irc.say("bob", "#bun", "not read yet");
  await connect({ serverPassword: "pw", channels: ["#honk", "#bun"] });
  m.setActive("alpha", "#honk");
  await until(() => texts("#bun").includes("not read yet"));
  expect(server().buffers["#bun"]!.unread).toBe(1);
});

test("a server that doesn't know CAP still registers honk", async () => {
  irc.rejectCap = true;
  await connect({ serverPassword: "pw" });
  expect(server().status).toBe("connected");
});
