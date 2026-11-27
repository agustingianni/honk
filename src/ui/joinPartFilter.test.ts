import { describe, expect, test } from "bun:test";
import type { ChatMessage, MessageKind } from "../types.ts";
import { visibleMessages } from "./joinPartFilter.ts";

const T0 = new Date("2026-01-01T12:00:00Z").getTime();
let nextId = 0;

/**
 * A line `min` minutes after T0. `who` is the sender of a message, action or
 * notice, and the subject (`nick`) of a join, part or nick change.
 */
function line(min: number, kind: MessageKind, who?: string, extra?: Partial<ChatMessage>): ChatMessage {
  const event = kind === "join" || kind === "part" || kind === "nick";
  return {
    id: String(nextId++),
    timestamp: new Date(T0 + min * 60_000),
    kind,
    ...(event ? { nick: who } : { from: who }),
    text: `${kind} ${who ?? ""}`,
    ...extra,
  };
}

describe("visibleMessages smart", () => {
  // alice speaks at minute 0. Is her join or part line at minute `at` shown?
  test.each([
    ["part", 5, true],
    ["part", 10, true],
    ["part", 10.1, false],
    ["part", 20, false],
    ["join", -3, true],
    ["join", -10.1, false],
  ] as const)("a %s %d minutes from her message: shown is %p", (kind, at, shown) => {
    const event = line(at, kind, "alice");
    expect(visibleMessages([line(0, "message", "alice"), event], "smart").includes(event)).toBe(shown);
  });

  test("hides a join from a nick who never speaks", () => {
    const join = line(0, "join", "lurker");
    const shown = visibleMessages([join, line(1, "message", "alice")], "smart");
    expect(shown).not.toContain(join);
  });

  test("actions and notices count as speaking; case does not matter", () => {
    const join1 = line(0, "join", "Alice");
    const join2 = line(0, "join", "bob");
    const shown = visibleMessages(
      [join1, join2, line(1, "action", "alice"), line(2, "notice", "BOB")],
      "smart",
    );
    expect(shown).toContain(join1);
    expect(shown).toContain(join2);
  });

  test("always shows your own join", () => {
    const own = line(0, "join", "goose", { isSelf: true });
    expect(visibleMessages([own], "smart")).toEqual([own]);
  });

  test("always shows a kick, which is an error line", () => {
    const kick = line(0, "error", undefined, { text: "bob was kicked by alice" });
    expect(visibleMessages([kick], "smart")).toEqual([kick]);
  });

  test("talk under either nick counts after a nick change", () => {
    const join = line(0, "join", "alice");
    const nick = line(30, "nick", "alice", { newNick: "alice_" });
    const quit = line(60, "part", "alice_");
    const shown = visibleMessages(
      [join, line(2, "message", "alice"), nick, line(32, "message", "alice_"), quit],
      "smart",
    );
    expect(shown).toContain(join);
    expect(shown).toContain(nick);
    // alice_ last spoke 28 minutes before quitting.
    expect(shown).not.toContain(quit);
  });

  test("the nick change of someone who talks under the new nick is shown", () => {
    const nick = line(0, "nick", "alice", { newNick: "alice_" });
    expect(visibleMessages([nick, line(5, "message", "alice_")], "smart")).toContain(nick);
  });

  test("keeps every other line in order", () => {
    const messages = [
      line(0, "system"),
      line(1, "join", "lurker"),
      line(2, "message", "alice"),
      line(3, "notice", "server"),
    ];
    expect(visibleMessages(messages, "smart").map((m) => m.text)).toEqual(["system ", "message alice", "notice server"]);
  });
});

describe("visibleMessages all and none", () => {
  const messages = [
    line(0, "join", "goose", { isSelf: true }),
    line(1, "join", "alice"),
    line(2, "message", "alice"),
    line(3, "nick", "alice", { newNick: "alice_" }),
    line(4, "error", undefined),
    line(5, "part", "alice_"),
  ];

  test('"all" returns the same array', () => {
    expect(visibleMessages(messages, "all")).toBe(messages);
  });

  test('"none" hides every join, part and nick change except your own', () => {
    expect(visibleMessages(messages, "none").map((m) => m.kind)).toEqual([
      "join",
      "message",
      "error",
    ]);
  });
});
