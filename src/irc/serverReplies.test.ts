import { afterEach, beforeEach, expect, test } from "bun:test";
import { FakeIrcd } from "../../dev/fakeircd/server.ts";
import { until } from "../../dev/fakeircd/testing.ts";
import { IrcManager } from "./manager.ts";
import { STATUS_BUFFER } from "./names.ts";

let irc: FakeIrcd;
let m: IrcManager;

const server = () => m.getSnapshot().servers.find((s) => s.id === "alpha")!;
const texts = (buffer: string) =>
  server()
    .buffers[buffer]?.messages.filter((x) => !x.isHistory)
    .map((x) => x.text) ?? [];
const allTexts = () => Object.keys(server().buffers).flatMap(texts);

async function connect(extra: { password?: string } = {}): Promise<void> {
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
}

beforeEach(async () => {
  irc = await FakeIrcd.start({ network: "alpha" });
  m = new IrcManager();
});

afterEach(async () => {
  m.disconnectAll();
  await irc.stop();
});

async function inHonk(): Promise<void> {
  await connect();
  await until(() => Boolean(server().buffers["#honk"]));
  m.setActive("alpha", "#honk");
}

test("a failed join is said in words, without the raw numeric name", async () => {
  await inHonk();
  irc.ban("#secret");
  m.handleInput("/join #secret");
  await until(() => texts("#honk").some((t) => t.includes("#secret")));
  expect(texts("#honk").at(-1)).toBe("Can't join #secret: you are banned from it.");
  expect(allTexts().some((t) => t.includes("err_"))).toBe(false);
});

test("a forwarded join says where it went and moves there", async () => {
  await inHonk();
  irc.forward("#old", "#new");
  m.handleInput("/join #old");
  await until(() => m.getSnapshot().active?.buffer === "#new");
  expect(texts("#honk")).toContain("#old forwards to #new, so you are joining #new instead.");
});

test("someone away is said once in the DM, not on every message", async () => {
  await inHonk();
  irc.setAway("alice", "Gone fishing");
  m.handleInput("/msg alice one");
  await until(() => texts("alice").includes("alice is away: Gone fishing"));
  m.handleInput("/msg alice two");
  await until(() => irc.received.some((l) => l.command === "PRIVMSG" && l.params[1] === "two"));
  await Bun.sleep(100);
  expect(texts("alice").filter((t) => t.includes("is away"))).toHaveLength(1);
});

test("WHOIS shows one fact per line, with the away text once", async () => {
  await inHonk();
  irc.setAway("alice", "Gone fishing");
  m.handleInput("/whois alice");
  await until(() => texts("#honk").some((t) => t.startsWith("alice is on")));
  const lines = texts("#honk").filter((t) => t.startsWith("alice "));
  expect(lines).toEqual([
    "alice is ~alice@fake.host (alice the fake user)",
    "alice is in @#honk",
    "alice is on fake.irc (alpha)",
    "alice is away: Gone fishing",
  ]);
});

test("/history with nothing older says so", async () => {
  await inHonk();
  m.handleInput("/history 5");
  await until(() => texts("#honk").some((t) => t.includes("no older messages")));
  expect(texts("#honk").at(-1)).toBe("The server has no older messages in #honk.");
});

/**
 * Stores alice's lines in #honk before you join, as a store of whole seconds keeps
 * them: old 1..10 a minute before `second`, then `same` at `second`, then new 1..`newer`
 * 5 s after. Then you join #honk, and it waits for the screen's latest 50 Lines.
 */
async function joinAfterOneSecond(same: string[], newer: number): Promise<void> {
  const second = Math.floor(Date.now() / 1000) * 1000 - 60_000;
  const say = (time: number, text: string) => {
    irc.now = () => time;
    irc.say("alice", "#honk", text);
  };
  for (let i = 1; i <= 10; i++) say(second - 60_000, `old ${i}`);
  for (const text of same) say(second, text);
  for (let i = 1; i <= newer; i++) say(second + 5_000, `new ${i}`);
  irc.now = () => Date.now();
  await inHonk();
  await until(() => shown().includes(`new ${newer}`));
}

/** Every line of #honk on screen, History too. */
const shown = () => server().buffers["#honk"]!.messages.map((x) => x.text);

test("/history brings the Lines of the second where the screen begins", async () => {
  // A store of whole seconds: a, b and c share one second. The screen's latest 50
  // begin at c (your JOIN is one of them), so a and b are older but have c's time.
  await joinAfterOneSecond(["a", "b", "c"], 48);
  expect(shown()).not.toContain("a");
  m.handleInput("/history 50");
  await until(() => shown().includes("old 1"));
  const lines = shown().filter((t) => /^(old \d+|[abc]|new \d+)$/.test(t));
  expect(lines).toEqual([
    ...Array.from({ length: 10 }, (_, i) => `old ${i + 1}`),
    "a",
    "b",
    "c",
    ...Array.from({ length: 48 }, (_, i) => `new ${i + 1}`),
  ]);
});

test("/history gets past a second with more Lines on screen than it asks for", async () => {
  // A store of whole seconds: t1..t20 share one second, and the screen begins at t2,
  // so 19 Lines on screen have that time. /history 5 must still bring t1 and older.
  await joinAfterOneSecond(Array.from({ length: 20 }, (_, i) => `t${i + 1}`), 30);
  expect(shown()).not.toContain("t1");
  m.handleInput("/history 5");
  await until(() => shown().includes("t1") || shown().some((t) => t.includes("no older messages")));
  expect(shown().filter((t) => t.startsWith("old ") || t === "t1")).toEqual([
    "old 7",
    "old 8",
    "old 9",
    "old 10",
    "t1",
  ]);
  expect(shown().some((t) => t.includes("no older messages"))).toBe(false);
});

test("/history says so when the server has only the Lines on screen", async () => {
  await inHonk();
  irc.say("alice", "#honk", "only line");
  await until(() => texts("#honk").includes("only line"));
  m.handleInput("/history 5");
  await until(() => texts("#honk").some((t) => t.includes("no older messages")));
  expect(texts("#honk").filter((t) => t === "only line")).toHaveLength(1);
});

test("a rejected SASL login is one line that says what to do", async () => {
  irc.rejectSasl = true;
  await connect({ password: "wrong" });
  await until(() => server().status === "error");
  await Bun.sleep(100);
  const errors = server().buffers["*status"]!.messages.filter((x) => x.kind === "error");
  expect(errors.map((x) => x.text)).toEqual([
    "Login failed: the server rejected the account name or password. honk stopped reconnecting. Check the account and password in your config, then type /connect.",
  ]);
});

test("commands offline say how to reconnect", async () => {
  await inHonk();
  m.handleInput("/disconnect");
  await until(() => server().status === "disconnected");
  m.handleInput("/join #x");
  await until(() => texts("#honk").some((t) => t.startsWith("Not connected")));
  expect(texts("#honk").at(-1)).toBe("Not connected to alpha. Type /connect to reconnect.");
});

test("/part and /me in *status say where they work", async () => {
  await inHonk();
  m.setActive("alpha", "*status");
  m.handleInput("/part");
  m.handleInput("/me waves");
  await until(() => texts("*status").some((t) => t.startsWith("Use /me")));
  expect(texts("*status").slice(-2)).toEqual([
    "Use /part inside a channel or DM.",
    "Use /me inside a channel or DM.",
  ]);
});

test("a message the server refuses is marked not sent, even after the PONG", async () => {
  await inHonk();
  irc.join("dave", "#other"); // a channel goose is not in: the fake server answers 404
  m.handleInput("/msg #other hello");
  await until(() => texts("#other").includes("Your message was not sent to #other."));
  await Bun.sleep(200); // the PONG for the PING after the line arrives too
  const sent = server().buffers["#other"]!.messages.find((x) => x.text === "hello");
  expect(sent?.delivery).toBe("failed");
});

test("a nick error stays where you are, not in a DM with that nick", async () => {
  await inHonk();
  irc.join("alice", "#honk");
  m.openDm("alpha", "alice");
  m.setActive("alpha", "#honk");
  m.handleInput("/nick alice");
  await until(() => texts("#honk").includes("The nick alice is taken."));
  expect(texts("alice").some((t) => t.includes("taken"))).toBe(false);
});

test("a SASL login that works says which account", async () => {
  await connect({ password: "right" });
  await until(() => texts("*status").some((t) => t.startsWith("Logged in")));
  expect(texts("*status")).toContain("Logged in to the account goose.");
});

/**
 * Joins #other and waits until fakeircd has answered the history honk fetches on join,
 * so a later failHistoryIn.add("#other") fails only the /history a test types.
 */
async function joinOther(): Promise<void> {
  m.handleInput("/join #other");
  await until(() =>
    irc.received.some((l) => l.command === "CHATHISTORY" && l.params[1] === "#other"),
  );
  await until(() => Boolean(server().buffers["#other"]));
}

test("/history sends a label, and a FAIL for one channel leaves another /history waiting", async () => {
  await inHonk();
  await joinOther();
  irc.failHistoryIn.add("#other");
  // Both requests leave before any reply comes back. The FAIL for #other arrives first.
  m.setActive("alpha", "#other");
  m.handleInput("/history 5");
  m.setActive("alpha", "#honk");
  m.handleInput("/history 5");
  await until(() => texts("#honk").some((t) => t.includes("no older messages")));
  expect(texts("#honk").at(-1)).toBe("The server has no older messages in #honk.");
  const sent = irc.received.filter((l) => l.command === "CHATHISTORY" && l.params[0] === "LATEST");
  expect(sent.slice(-2).every((l) => l.raw.startsWith("@label="))).toBe(true);
});

test("history requests without a label start with the command, not an empty tag section", async () => {
  // The fetch on join never has a label, and /history has one only with labeled-response.
  irc.labeledResponse = false;
  await inHonk();
  m.handleInput("/history 5");
  await until(
    () => irc.received.filter((l) => l.command === "CHATHISTORY" && l.params[1] === "#honk").length >= 2,
  );
  const sent = irc.received.filter((l) => l.command === "CHATHISTORY");
  expect(sent.filter((l) => !l.raw.startsWith("CHATHISTORY "))).toEqual([]);
});

test.each([true, false])(
  "a failed /history shows its error once, where it was typed (labeled-response: %p)",
  async (labeledResponse) => {
    // With a label, the label names the request. Without one, the target in the FAIL does.
    irc.labeledResponse = labeledResponse;
    await inHonk();
    await joinOther();
    irc.failHistoryIn.add("#other");
    m.setActive("alpha", "#other");
    m.handleInput("/history 5");
    // You switch away before the FAIL arrives.
    m.setActive("alpha", "#honk");
    await until(() => texts("#other").some((t) => t.startsWith("Could not load history")));
    await Bun.sleep(100);
    expect(allTexts().filter((t) => t.startsWith("Could not load history"))).toHaveLength(1);
  },
);

test.each([true, false])(
  "a failed history fetch on join shows its error in that channel (labeled-response: %p)",
  async (labeledResponse) => {
    // The fetch on join never has a label, so only the target says where the error goes.
    irc.labeledResponse = labeledResponse;
    await inHonk();
    irc.failHistoryIn.add("#b");
    irc.holdHistoryIn.add("#b");
    m.handleInput("/join #b");
    await until(() =>
      irc.received.some((l) => l.command === "CHATHISTORY" && l.params[1] === "#b"),
    );
    await until(() => Boolean(server().buffers["#b"]));
    // You switch away before the FAIL arrives.
    m.setActive("alpha", "#honk");
    irc.releaseHistory();
    await until(() => allTexts().some((t) => t.startsWith("Could not load history")));
    await Bun.sleep(100);
    expect(texts("#b").filter((t) => t.startsWith("Could not load history"))).toHaveLength(1);
    expect(texts("#honk").some((t) => t.startsWith("Could not load history"))).toBe(false);
  },
);

test("an unlabeled FAIL for one channel leaves /history in another channel waiting", async () => {
  irc.labeledResponse = false;
  await inHonk();
  irc.holdHistoryIn.add("#honk");
  irc.failHistoryIn.add("#b");
  m.handleInput("/history 5");
  // The history fetch for #b fails while the reply for #honk is held.
  m.handleInput("/join #b");
  await until(() => texts("#b").some((t) => t.startsWith("Could not load history")));
  irc.releaseHistory();
  await until(() => texts("#honk").some((t) => t.includes("no older messages")));
  expect(texts("#honk").at(-1)).toBe("The server has no older messages in #honk.");
});

test("an unlabeled FAIL for a target with no buffer leaves /history elsewhere waiting", async () => {
  irc.labeledResponse = false;
  await inHonk();
  irc.holdHistoryIn.add("#honk");
  m.handleInput("/history 5");
  await until(() =>
    irc.received.some((l) => l.command === "CHATHISTORY" && l.params[1] === "#honk"),
  );
  // Like the fetch honk sends on reconnect for a nick that wrote while you were away.
  irc.sendRaw(":fake.irc FAIL CHATHISTORY MESSAGE_ERROR AFTER bob :Messages could not be retrieved");
  await until(() => texts("#honk").some((t) => t.startsWith("Could not load history")));
  irc.releaseHistory();
  await until(() => texts("#honk").some((t) => t.includes("no older messages")));
  expect(texts("#honk").at(-1)).toBe("The server has no older messages in #honk.");
});

test("an unlabeled FAIL for a DM with a nick like a subcommand goes to that DM", async () => {
  irc.labeledResponse = false;
  await inHonk();
  m.openDm("alpha", "after");
  m.setActive("alpha", "#honk");
  irc.sendRaw(":fake.irc FAIL CHATHISTORY MESSAGE_ERROR BEFORE after :Messages could not be retrieved");
  await until(() => allTexts().some((t) => t.startsWith("Could not load history")));
  expect(texts("after").some((t) => t.startsWith("Could not load history"))).toBe(true);
});

test("history plays back without HistServ lines (draft/event-playback)", async () => {
  irc.join("dave", "#honk"); // a JOIN in the history, as Ergo keeps it
  irc.say("dave", "#honk", "hello from before");
  await connect();
  await until(() => server().buffers["#honk"]?.messages.some((x) => x.isHistory) ?? false);
  const req = irc.received.find((l) => l.command === "CAP" && l.params[0] === "REQ");
  expect(req?.params[1]?.split(" ")).toContain("draft/event-playback");
  const history = server().buffers["#honk"]!.messages.filter((x) => x.isHistory);
  expect(history.map((x) => `${x.from}: ${x.text}`)).toEqual(["dave: hello from before"]);
});

test("someone away with no away text is said once too", async () => {
  await inHonk();
  irc.join("alice", "#honk");
  m.openDm("alpha", "alice");
  m.setActive("alpha", "#honk");
  for (const _ of [1, 2]) {
    irc.sendRaw(":fake.irc 301 $NICK alice");
    await until(() => texts("alice").includes("alice is away."));
  }
  await Bun.sleep(100);
  expect(texts("alice").filter((t) => t.startsWith("alice is away"))).toEqual(["alice is away."]);
});

test.each([true, false])(
  "a /history the server failed is not answered by a later history batch (labeled-response: %p)",
  async (labeledResponse) => {
    irc.labeledResponse = labeledResponse;
    await inHonk();
    irc.failHistory = true;
    m.handleInput("/history 5");
    await until(() => texts("#honk").some((t) => t.startsWith("Could not load history")));
    irc.failHistory = false;
    // A rejoin on the same connection asks for history on its own, and finds nothing older.
    // Its batch must not be taken as the reply to the /history that failed.
    m.handleInput("/part #honk");
    await until(() => !server().buffers["#honk"]);
    m.handleInput("/join #honk");
    await until(() => irc.received.filter((l) => l.command === "CHATHISTORY").length >= 3);
    await Bun.sleep(100);
    expect(texts("#honk").some((t) => t.includes("no older messages"))).toBe(false);
  },
);

test("a WHOIS cut off by a dropped connection does not hide later away replies", async () => {
  await inHonk();
  m.openDm("alpha", "alice");
  m.setActive("alpha", "#honk");
  // The WHOIS starts (311) but the connection drops before it ends (318).
  irc.sendRaw(":fake.irc 311 $NICK alice ~alice fake.host * :alice the fake user");
  await Bun.sleep(100);
  m.handleInput("/disconnect");
  await until(() => server().status === "disconnected");
  m.handleInput("/connect");
  await until(() => server().status === "connected");
  irc.sendRaw(":fake.irc 301 $NICK alice :Gone fishing");
  await until(() => texts("alice").includes("alice is away: Gone fishing"));
});

test("someone away is said again after they write, even with the same text", async () => {
  await inHonk();
  m.openDm("alpha", "alice");
  m.setActive("alpha", "#honk");
  irc.sendRaw(":fake.irc 301 $NICK alice :lunch");
  await until(() => texts("alice").includes("alice is away: lunch"));
  irc.sendRaw(":alice!~alice@fake.host PRIVMSG $NICK :back");
  await until(() => texts("alice").includes("back"));
  irc.sendRaw(":fake.irc 301 $NICK alice :lunch");
  await until(() => texts("alice").filter((t) => t === "alice is away: lunch").length === 2);
});

test("someone away is said again after a reconnect, even with the same text", async () => {
  await inHonk();
  m.openDm("alpha", "alice");
  m.setActive("alpha", "#honk");
  irc.sendRaw(":fake.irc 301 $NICK alice :lunch");
  await until(() => texts("alice").includes("alice is away: lunch"));
  m.handleInput("/disconnect");
  await until(() => server().status === "disconnected");
  m.handleInput("/connect");
  await until(() => server().status === "connected");
  irc.sendRaw(":fake.irc 301 $NICK alice :lunch");
  await until(() => texts("alice").filter((t) => t === "alice is away: lunch").length === 2);
});

/**
 * Matches a numeric reply code as a whole number. A plain includes("437") would
 * also match the random port in "Connecting to 127.0.0.1:43712", and the test
 * would fail now and then.
 */
const numericCode = (code: string) => new RegExp(`\\b${code}\\b`);

test("a nick in use at login is retried with an underscore", async () => {
  irc.join("goose", "#elsewhere");
  await connect();
  await until(() => server().status === "connected");
  expect(server().nick).toBe("goose_");
  expect(allTexts().some((t) => t.includes("err_") || numericCode("433").test(t))).toBe(false);
});

test("a nick the network holds (437) at login is retried like one in use", async () => {
  irc.holdNick("goose");
  await connect();
  await until(() => server().status === "connected");
  expect(server().nick).toBe("goose_");
  expect(allTexts().some((t) => t.includes("err_") || numericCode("437").test(t))).toBe(false);
});

test("717 (they were told you wrote) is an ordinary line, not an error", async () => {
  await inHonk();
  irc.sendRaw(":fake.server 717 $NICK alice :has been informed that you messaged them");
  await until(() => texts("#honk").includes("alice was told that you wrote."));
  const line = server().buffers["#honk"]!.messages.find((x) => x.text === "alice was told that you wrote.");
  expect(line?.kind).toBe("system");
});

test("a line honk cannot handle is shown once in *status, and the connection goes on", async () => {
  await inHonk();
  // Make honk's own line handling throw on one line, like a bug would.
  const raw = m as unknown as { onRawLine(serverId: string, line: string): void };
  const onRawLine = raw.onRawLine.bind(m);
  raw.onRawLine = (serverId, line) => {
    if (line.includes("trigger")) throw new Error("cannot handle it");
    onRawLine(serverId, line);
  };

  irc.sendRaw(":irc.alpha NOTICE $NICK :trigger");
  irc.sendRaw(":irc.alpha NOTICE $NICK :trigger again");
  irc.sendRaw(":alice!a@host PRIVMSG #honk :still connected");
  await until(() => texts("#honk").includes("still connected"));
  // The same error is reported once per connection, not for every line.
  const reports = texts(STATUS_BUFFER).filter((t) => t.startsWith("A bug in honk:"));
  expect(reports).toHaveLength(1);
  const report = reports[0];
  expect(report).toStartWith("A bug in honk: it could not handle this line from the server (cannot handle it, at ");
  expect(report).toEndWith(":irc.alpha NOTICE goose :trigger"); // after the @time tag
  // irc-client-ts still read the line: the notice itself is shown too.
  expect(texts(STATUS_BUFFER)).toContain("trigger");
});

test("an event listener that throws is shown once in *status, and the connection goes on", async () => {
  await inHonk();
  // Make the privmsg listener throw on one text, like a bug would. irc-client-ts calls
  // it from its read loop, which would end without the guard.
  const raw = m as unknown as { pushMessage(serverId: string, buffer: string, msg: { text: string }): void };
  const pushMessage = raw.pushMessage.bind(m);
  raw.pushMessage = (serverId, buffer, msg) => {
    if (msg.text.startsWith("trigger")) throw new Error("cannot show it");
    pushMessage(serverId, buffer, msg);
  };

  irc.sendRaw(":alice!a@host PRIVMSG #honk :trigger");
  irc.sendRaw(":alice!a@host PRIVMSG #honk :trigger again");
  irc.sendRaw(":alice!a@host PRIVMSG #honk :still connected");
  await until(() => texts("#honk").includes("still connected"));
  const reports = texts(STATUS_BUFFER).filter((t) => t.startsWith("A bug in honk:"));
  expect(reports).toHaveLength(1);
  expect(reports[0]).toStartWith("A bug in honk: it could not handle the privmsg:channel event (cannot show it, at ");
});

test("a library listener that throws is shown in *status, and the connection goes on", async () => {
  await inHonk();
  // A listener that honk did not add, as one of irc-client-ts's plugins adds it.
  const clients = (m as unknown as { clients: Map<string, { on(e: string, l: (p: { params: string[] }) => void): void }> }).clients;
  clients.get("alpha")!.on("raw:privmsg", (msg) => {
    if (msg.params[1] === "trigger") throw new Error("plugin broke");
  });

  irc.sendRaw(":alice!a@host PRIVMSG #honk :trigger");
  irc.sendRaw(":alice!a@host PRIVMSG #honk :still connected");
  await until(() => texts("#honk").includes("still connected"));
  const reports = texts(STATUS_BUFFER).filter((t) => t.startsWith("A bug in honk:"));
  expect(reports).toHaveLength(1);
  expect(reports[0]).toStartWith("A bug in honk: it could not handle the raw:privmsg event (plugin broke, at ");
});

test("a bug that hits many lines is reported 5 times at most", async () => {
  await inHonk();
  const raw = m as unknown as { onRawLine(serverId: string, line: string): void };
  raw.onRawLine = (_serverId, line) => {
    // A different message each time, so each line looks like a new bug.
    if (line.includes("trigger")) throw new Error(`cannot handle ${line.slice(-2)}`);
  };
  for (let i = 10; i < 20; i++) irc.sendRaw(`:irc.alpha NOTICE $NICK :trigger ${i}`);
  irc.sendRaw(":alice!a@host PRIVMSG #honk :still connected");
  await until(() => texts("#honk").includes("still connected"));
  expect(texts(STATUS_BUFFER).filter((t) => t.startsWith("A bug in honk:"))).toHaveLength(5);
});

test("a click on a channel name joins it once, then only switches to it", async () => {
  await inHonk();
  m.openChannel("alpha", "#rust");
  await until(() => m.getSnapshot().active?.buffer === "#rust");
  m.setActive("alpha", "#honk");
  m.openChannel("alpha", "#RUST"); // channel names match without case
  expect(m.getSnapshot().active?.buffer).toBe("#rust");
  await Bun.sleep(100);
  const joins = irc.received.filter((l) => l.command === "JOIN" && l.params[0] === "#rust");
  expect(joins.length).toBe(1);
});
