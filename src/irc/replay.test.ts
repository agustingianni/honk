import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeIrcd } from "../../dev/fakeircd/server.ts";
import { until } from "../../dev/fakeircd/testing.ts";
import type { ChatMessage } from "../types.ts";
import { IrcManager } from "./manager.ts";
import { checkReplay, HistoryBatch, wholeSecond } from "./replay.ts";

const T = Date.parse("2026-11-27T21:35:07.412Z");

let nextId = 0;
function line(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: String(++nextId),
    kind: "message",
    from: "alice",
    text: "lol",
    timestamp: new Date(T),
    ...overrides,
  };
}

const history = (overrides: Partial<ChatMessage> = {}) => line({ isHistory: true, ...overrides });

/**
 * Runs Lines through the rule the way a Buffer would: a new Line is kept, a Replay is
 * dropped, and a msgid given to a kept Line is set on it. One HistoryBatch per call,
 * like one CHATHISTORY batch. Returns the kept Lines.
 */
function receive(kept: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const lines = [...kept];
  const batch = new HistoryBatch();
  for (const l of incoming) {
    const verdict = checkReplay(lines, l, batch);
    if (verdict.type === "new") lines.push(l);
    if (verdict.type === "give-msgid") {
      const at = lines.indexOf(verdict.line);
      lines[at] = { ...verdict.line, msgid: verdict.msgid };
    }
  }
  return lines;
}

const summary = (lines: ChatMessage[]) => lines.map((l) => `${l.from} ${l.text} ${l.msgid ?? "-"}`);

describe("checkReplay", () => {
  test("Ergo: a Replay with the same msgid is dropped (rule 1)", () => {
    const kept = receive([], [line({ msgid: "AB12" }), line({ text: "hi", msgid: "CD34" })]);
    const after = receive(kept, [history({ msgid: "AB12" }), history({ text: "hi", msgid: "CD34" })]);
    expect(summary(after)).toEqual(["alice lol AB12", "alice hi CD34"]);
  });

  test("Ergo: a History Line with a msgid honk does not have is new", () => {
    const kept = receive([], [line({ msgid: "AB12" })]);
    const after = receive(kept, [history({ msgid: "EF56" })]);
    expect(summary(after)).toEqual(["alice lol AB12", "alice lol EF56"]);
  });

  test("Ergo: a played-back event (msgid with _) is dropped when it comes again", () => {
    const event = { from: "HistServ", text: "bob joined the channel", msgid: "_AB12" };
    const kept = receive([], [history(event)]);
    const after = receive(kept, [history(event)]);
    expect(summary(after)).toEqual(["HistServ bob joined the channel _AB12"]);
  });

  test("soju file store: a Replay without msgid, cut to whole seconds, is dropped (rule 2)", () => {
    const kept = receive([], [line({ msgid: "AB12" })]);
    const after = receive(kept, [
      history({ timestamp: new Date("2026-11-27T21:35:07.000Z") }),
    ]);
    expect(summary(after)).toEqual(["alice lol AB12"]);
  });

  test("soju file store: the same text in another second is new", () => {
    const kept = receive([], [line()]);
    const after = receive(kept, [history({ timestamp: new Date("2026-11-27T21:35:08.000Z") })]);
    expect(after).toHaveLength(2);
  });

  test("ZNC: the live Line had a msgid, the Replay has none and the same time", () => {
    const kept = receive([], [line({ msgid: "AB12" })]);
    const after = receive(kept, [history()]);
    expect(summary(after)).toEqual(["alice lol AB12"]);
  });

  test("rule 2 compares text without formatting, the nick and the kind", () => {
    const kept = receive([], [line({ text: "\x02lol\x02" })]);
    expect(receive(kept, [history({ text: "lol" })])).toHaveLength(1);
    expect(receive(kept, [history({ from: "bob" })])).toHaveLength(2);
    expect(receive(kept, [history({ kind: "action" })])).toHaveLength(2);
  });

  test("OFTC: live Lines without tags are always new (rule 4)", () => {
    const after = receive([], [line(), line(), line()]);
    expect(after).toHaveLength(3);
  });

  test("a live Line with a msgid honk already has is dropped", () => {
    // A line to yourself can come as the Echo and again as a message.
    const after = receive([], [line({ msgid: "AB12" }), line({ msgid: "AB12" })]);
    expect(after).toHaveLength(1);
  });

  test("the old bug: a real 'lol' repeated within 2 seconds stays", () => {
    const kept = receive([], [line({ timestamp: new Date(T - 1500) })]);
    const after = receive(kept, [history({ timestamp: new Date(T) })]);
    expect(after).toHaveLength(2);
  });

  describe("counting (rule 2)", () => {
    const second = (ms: number) => new Date(Date.parse("2026-11-27T21:35:07.000Z") + ms);

    test("History has 'lol' twice in one second and honk has it once: one more is kept", () => {
      const kept = receive([], [line({ timestamp: second(100) })]);
      const after = receive(kept, [history({ timestamp: second(0) }), history({ timestamp: second(0) })]);
      expect(after).toHaveLength(2);
    });

    test("History has it twice and honk has it twice: none is kept", () => {
      const kept = receive([], [line({ timestamp: second(100) }), line({ timestamp: second(400) })]);
      const after = receive(kept, [history({ timestamp: second(0) }), history({ timestamp: second(0) })]);
      expect(after).toHaveLength(2);
    });

    test("History has it three times and honk has it twice: one more is kept", () => {
      const kept = receive([], [line({ timestamp: second(100) }), line({ timestamp: second(400) })]);
      const three = [0, 0, 0].map(() => history({ timestamp: second(0) }));
      expect(receive(kept, three)).toHaveLength(3);
    });

    test("an empty Buffer keeps both copies of a batch", () => {
      // The second copy must not match the first copy that this same batch just kept.
      const after = receive([], [history(), history()]);
      expect(after).toHaveLength(2);
    });

    test("the same batch again keeps nothing more", () => {
      const kept = receive([], [history(), history()]);
      expect(receive(kept, [history(), history()])).toHaveLength(2);
    });

    test("copies in a batch are counted per nick, text, kind, and second", () => {
      const kept = receive([], [line()]);
      const after = receive(kept, [
        history(),
        history({ from: "bob" }),
        history({ timestamp: new Date(T + 1000) }),
      ]);
      expect(summary(after)).toEqual(["alice lol -", "bob lol -", "alice lol -"]);
    });

    test("without a batch, each History Line is counted alone", () => {
      const kept = [line()];
      expect(checkReplay(kept, history()).type).toBe("replay");
      expect(checkReplay(kept, history()).type).toBe("replay");
    });
  });

  describe("rule 3: a History Line gives its msgid to a kept Line without one", () => {
    test("the kept Line gets the msgid and the History Line is dropped", () => {
      const kept = receive([], [line()]);
      const after = receive(kept, [history({ msgid: "AB12" })]);
      expect(summary(after)).toEqual(["alice lol AB12"]);
      expect(after[0]!.id).toBe(kept[0]!.id);
    });

    test("two kept Lines get one msgid each, oldest first", () => {
      const kept = receive([], [line({ text: "lol" }), line({ text: "lol" })]);
      const after = receive(kept, [history({ msgid: "M1" }), history({ msgid: "M2" })]);
      expect(summary(after)).toEqual(["alice lol M1", "alice lol M2"]);
    });

    test("more History Lines than kept Lines: the rest are new", () => {
      const kept = receive([], [line()]);
      const after = receive(kept, [history({ msgid: "M1" }), history({ msgid: "M2" })]);
      expect(summary(after)).toEqual(["alice lol M1", "alice lol M2"]);
      expect(after).toHaveLength(2);
    });

    test("a kept Line that already has a msgid keeps it", () => {
      const kept = receive([], [line({ msgid: "AB12" })]);
      const after = receive(kept, [history({ msgid: "EF56" })]);
      expect(summary(after)).toEqual(["alice lol AB12", "alice lol EF56"]);
    });

    test("a live Line never gives its msgid to a kept Line", () => {
      const kept = receive([], [line()]);
      const after = receive(kept, [line({ msgid: "AB12" })]);
      expect(summary(after)).toEqual(["alice lol -", "alice lol AB12"]);
    });
  });
});

describe("wholeSecond", () => {
  test("cuts a time to the second, as soju's file store does", () => {
    expect(wholeSecond(new Date("2026-11-27T21:35:07.999Z"))).toBe(wholeSecond(new Date("2026-11-27T21:35:07.000Z")));
    expect(wholeSecond(new Date("2026-11-27T21:35:07.999Z"))).not.toBe(wholeSecond(new Date("2026-11-27T21:35:08.000Z")));
  });
});

describe("through the manager", () => {
  let irc: FakeIrcd;
  let m: IrcManager;

  beforeEach(async () => {
    irc = await FakeIrcd.start({ network: "alpha" });
    m = new IrcManager();
  });

  afterEach(async () => {
    m.disconnectAll();
    await irc.stop();
  });

  const lines = () =>
    m.getSnapshot().servers.find((s) => s.id === "alpha")!.buffers["#honk"]?.messages ?? [];
  const lols = () => lines().filter((l) => l.text === "lol");

  async function inHonk(): Promise<void> {
    m.addServer({
      id: "alpha",
      name: "alpha",
      host: "127.0.0.1",
      port: irc.port,
      tls: false,
      nick: "goose",
      channels: ["#honk"],
      autoConnect: false,
    });
    await m.connectServer("alpha");
    await until(() => lines().some((l) => l.kind === "join"));
    // Let the History that honk asks for after the join arrive first.
    await Bun.sleep(100);
  }

  /** Sends `batchLines` as one CHATHISTORY batch, then a live line to know it arrived. */
  async function replay(ref: string, batchLines: string[]): Promise<void> {
    irc.sendRaw(`BATCH +${ref} chathistory #honk`);
    for (const l of batchLines) irc.sendRaw(`@batch=${ref};${l}`);
    irc.sendRaw(`BATCH -${ref}`);
    irc.sendRaw(`:bob!b@host PRIVMSG #honk :${ref} done`);
    await until(() => lines().some((l) => l.text === `${ref} done`));
  }

  test("a 'lol' said twice in one second survives a Replay of both", async () => {
    await inHonk();
    // Live, as soju passes it on: msgid and ms.
    irc.sendRaw("@msgid=AB12;time=2026-11-27T21:35:07.412Z :alice!a@host PRIVMSG #honk :lol");
    await until(() => lols().length === 1);
    // soju's file store sends both lines of that second again, without msgid.
    await replay("r1", [
      "time=2026-11-27T21:35:07.000Z :alice!a@host PRIVMSG #honk :lol",
      "time=2026-11-27T21:35:07.000Z :alice!a@host PRIVMSG #honk :lol",
    ]);
    expect(lols()).toHaveLength(2);
    // The same batch again adds nothing.
    await replay("r2", [
      "time=2026-11-27T21:35:07.000Z :alice!a@host PRIVMSG #honk :lol",
      "time=2026-11-27T21:35:07.000Z :alice!a@host PRIVMSG #honk :lol",
    ]);
    expect(lols()).toHaveLength(2);
  });

  test("History gives its msgid to a line shown without one", async () => {
    await inHonk();
    irc.sendRaw("@time=2026-11-27T21:35:07.412Z :alice!a@host PRIVMSG #honk :lol");
    await until(() => lols().length === 1);
    await replay("r1", ["msgid=AB12;time=2026-11-27T21:35:07.412Z :alice!a@host PRIVMSG #honk :lol"]);
    expect(lols().map((l) => l.msgid)).toEqual(["AB12"]);
  });
});
