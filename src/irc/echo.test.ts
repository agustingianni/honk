import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { FakeIrcd } from "../../dev/fakeircd/server.ts";
import { until } from "../../dev/fakeircd/testing.ts";
import { ECHO_WAIT_MS, EchoTracker, MAX_WAITING_ECHOES, type SentPart } from "./echo.ts";
import { fakeClock } from "../fakeClock.ts";
import { IrcManager } from "./manager.ts";

/** A plain message part. */
const msg = (text: string): SentPart => ({ kind: "message", text });

describe("EchoTracker", () => {
  test("takes the oldest waiting part with the same text and buffer", () => {
    const t = new EchoTracker();
    t.add("s", "#a", "m1", [msg("hi")]);
    t.add("s", "#b", "m2", [msg("hi")]);
    t.add("s", "#a", "m3", [msg("hi")]);
    expect(t.take("s", "#a", msg("hi"))).toBe("m1");
    expect(t.take("s", "#a", msg("hi"))).toBe("m3");
    expect(t.take("s", "#a", msg("hi"))).toBeUndefined();
  });

  test("an action matches an action, not a message", () => {
    const t = new EchoTracker();
    t.add("s", "#a", "m1", [{ kind: "action", text: "waves" }]);
    expect(t.take("s", "#a", msg("waves"))).toBeUndefined();
    expect(t.take("s", "#a", { kind: "action", text: "waves" })).toBe("m1");
  });

  test("only the first part of a split line takes over the line shown", () => {
    const t = new EchoTracker();
    t.add("s", "#a", "m1", [msg("one"), msg("two")]);
    expect(t.take("s", "#a", msg("two"))).toBeUndefined();
    expect(t.take("s", "#a", msg("one"))).toBe("m1");
    // "two" was taken: it no longer waits.
    t.add("s", "#a", "m2", [msg("x")]);
    expect(t.take("s", "#a", msg("two"))).toBeUndefined();
  });

  test("keeps at most MAX_WAITING_ECHOES, dropping the oldest", () => {
    const t = new EchoTracker();
    for (let i = 0; i <= MAX_WAITING_ECHOES; i++) {
      t.add("s", "#a", `m${i}`, [msg(`line ${i}`)]);
    }
    expect(t.take("s", "#a", msg("line 0"))).toBeUndefined();
    expect(t.take("s", "#a", msg("line 1"))).toBe("m1");
  });

  test("matches without formatting and spaces at the ends", () => {
    const t = new EchoTracker();
    t.add("s", "#a", "m1", [msg("\x0304red\x03 ")]);
    t.add("s", "#a", "m2", [msg(" ok")]);
    expect(t.take("s", "#a", msg("red"))).toBe("m1");
    expect(t.take("s", "#a", msg("ok"))).toBe("m2");
  });

  test("stops waiting after ECHO_WAIT_MS", () => {
    const clock = fakeClock();
    const t = new EchoTracker(clock);
    t.add("s", "#a", "m1", [msg("hi")]);
    clock.advance(ECHO_WAIT_MS + 1);
    expect(t.take("s", "#a", msg("hi"))).toBeUndefined();
  });

  test("forget stops waiting for one line", () => {
    const t = new EchoTracker();
    t.add("s", "#a", "m1", [msg("hi"), msg("there")]);
    t.add("s", "#a", "m2", [msg("hi")]);
    t.forget("s", "m1");
    expect(t.take("s", "#a", msg("hi"))).toBe("m2");
    t.add("s", "#a", "m3", [msg("x")]);
    expect(t.take("s", "#a", msg("there"))).toBeUndefined();
  });

  test("forgets a server's lines when its connection closes", () => {
    const t = new EchoTracker();
    t.add("s", "#a", "m1", [msg("hi")]);
    t.drop("s");
    expect(t.take("s", "#a", msg("hi"))).toBeUndefined();
  });
});

describe("your own lines with echo-message", () => {
  let irc: FakeIrcd;
  let m: IrcManager;
  const lines = (buffer = "dave") =>
    (m.getSnapshot().servers[0]!.buffers[buffer]?.messages ?? []).filter(
      (x) => x.kind === "message" || x.kind === "action",
    );
  const texts = (buffer = "dave") => lines(buffer).map((x) => x.text);

  beforeEach(async () => {
    irc = await FakeIrcd.start({ network: "alpha" });
    m = new IrcManager();
    m.addServer({
      id: "alpha",
      name: "alpha",
      host: "127.0.0.1",
      port: irc.port,
      tls: false,
      nick: "goose",
      channels: [],
      autoConnect: false,
    });
    await m.connectServer("alpha");
    await until(() => m.getSnapshot().servers[0]!.status === "connected");
    // dave must exist, or the server answers "No such nick" and echoes nothing.
    irc.join("dave", "#lobby");
    irc.say("dave", "goose", "hi");
    await until(() => lines().length === 1);
    m.setActive("alpha", "dave");
  });

  afterEach(async () => {
    setSystemTime();
    m.disconnectAll();
    await irc.stop();
  });

  /** Waits until the echo of every line goose sent has set its msgid. */
  const echoed = (count: number, buffer = "dave") =>
    until(() => lines(buffer).filter((x) => x.isSelf && x.msgid).length === count);

  test("a line shows once and gets the msgid of its echo", async () => {
    m.handleInput("hello");
    await echoed(1);
    expect(texts()).toEqual(["hi", "hello"]);
  });

  test("a line ending in a space shows once, as sent", async () => {
    // irc-client-ts trims the line it sends, so the echo is "brb".
    m.handleInput("brb ");
    await echoed(1);
    expect(texts()).toEqual(["hi", "brb"]);
  });

  test("an echo that comes back after a minute still matches", async () => {
    irc.holdEchoes = true;
    m.handleInput("slow line");
    await until(() => irc.heldEchoCount === 1);
    setSystemTime(new Date(Date.now() + 60_000));
    irc.releaseEchoes();
    await echoed(1);
    expect(texts()).toEqual(["hi", "slow line"]);
  });

  test("many lines sent before their echoes each show once, in the order sent", async () => {
    // Two lines go out in one ms and the rest in the next. The server stamps every echo
    // with the later ms, so no echo may move its line past the lines sent after it.
    const t = Date.now();
    irc.holdEchoes = true;
    setSystemTime(new Date(t));
    for (let i = 0; i < 2; i++) m.handleInput(`line ${i}`);
    setSystemTime(new Date(t + 5));
    for (let i = 2; i < 8; i++) m.handleInput(`line ${i}`);
    await until(() => irc.heldEchoCount === 8);
    irc.releaseEchoes();
    await echoed(8);
    expect(texts()).toEqual(["hi", ...Array.from({ length: 8 }, (_, i) => `line ${i}`)]);
  });

  test("an echo moves your lines past someone else's older line, in the order sent", async () => {
    const t = Date.now();
    irc.holdEchoes = true;
    setSystemTime(new Date(t));
    m.handleInput("one");
    m.handleInput("two");
    m.handleInput("three");
    // The server gets them later: their echoes say t + 5.
    setSystemTime(new Date(t + 5));
    await until(() => irc.heldEchoCount === 3);
    irc.sendRaw(`@time=${new Date(t + 3).toISOString()} :dave!d@fake PRIVMSG goose :between`);
    await until(() => texts().includes("between"));
    irc.releaseEchoes();
    await echoed(3);
    expect(texts()).toEqual(["hi", "between", "one", "two", "three"]);
  });

  test("a line the library splits shows as its parts, as others see it", async () => {
    const long = Array.from({ length: 90 }, (_, i) => `word${i}`).join(" ");
    m.handleInput(long);
    await echoed(2);
    expect(texts().length).toBe(3);
    expect(texts().slice(1).join(" ")).toBe(long);
  });

  test("/me shows once", async () => {
    m.handleInput("/me waves");
    await echoed(1);
    expect(lines().map((x) => [x.kind, x.text])).toEqual([
      ["message", "hi"],
      ["action", "waves"],
    ]);
  });

  test("a line you sent from another client on the bouncer shows", async () => {
    m.handleInput("same text");
    await echoed(1);
    irc.sendRaw(":goose!goose@fake PRIVMSG dave :same text");
    await until(() => lines().length === 3);
    expect(texts()).toEqual(["hi", "same text", "same text"]);
  });

  test("a line that starts with a space shows once", async () => {
    // irc-client-ts sends "PRIVMSG dave  ok" without ":", so the server reads "ok".
    m.handleInput(" ok");
    await echoed(1);
    expect(texts()).toEqual(["hi", "ok"]);
  });

  test("a line the server refused doesn't hide the same text later", async () => {
    m.handleInput("/msg nobody hi");
    await until(() => lines("nobody")[0]?.delivery === "failed");
    // The same text, sent from another client on the bouncer.
    irc.sendRaw(":goose!goose@fake PRIVMSG nobody :hi");
    await until(() => lines("nobody").length === 2);
    expect(texts("nobody")).toEqual(["hi", "hi"]);
  });

  test("a line to yourself shows once, even if it comes twice", async () => {
    m.handleInput("/msg goose note");
    await echoed(1, "goose");
    const msgid = lines("goose")[0]!.msgid!;
    // Some servers send it twice with echo-message: as the echo and as a message to you.
    irc.sendRaw(`@msgid=${msgid} :goose!goose@fake PRIVMSG goose :note`);
    irc.sendRaw(":goose!goose@fake PRIVMSG goose :later");
    await until(() => texts("goose").includes("later"));
    expect(texts("goose")).toEqual(["note", "later"]);
  });
});
