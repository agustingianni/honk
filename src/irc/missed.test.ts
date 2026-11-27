import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../types.ts";
import {
  dmTargets,
  isMissedLine,
  isMissedMention,
  MISSED_MARGIN_MS,
  type MissedWindow,
} from "./missed.ts";

const SINCE = Date.parse("2026-11-26T22:00:00Z");

const window: MissedWindow = {
  since: SINCE,
  nick: "goose",
  buffers: new Set(["#honk", "alice"]),
};

function line(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "1",
    kind: "message",
    from: "alice",
    text: "goose: you there?",
    timestamp: new Date(SINCE + 60_000),
    isHistory: true,
    ...overrides,
  };
}

/** A simple stand-in for the manager's nick matcher. */
const mentions = (text: string, nick: string) => new RegExp(`\\b${nick}\\b`, "i").test(text);

describe("isMissedLine", () => {
  test("a history line newer than the window is missed", () => {
    expect(isMissedLine(window, "#honk", line())).toBe(true);
  });

  test("a line a little before the window still counts, for clock differences", () => {
    const at = (ms: number) => line({ timestamp: new Date(SINCE + ms) });
    expect(isMissedLine(window, "#honk", at(-MISSED_MARGIN_MS))).toBe(true);
    expect(isMissedLine(window, "#honk", at(-MISSED_MARGIN_MS - 1))).toBe(false);
  });

  test.each([
    ["no window (first connect)", undefined, "#honk", line()],
    ["a live line", window, "#honk", line({ isHistory: false })],
    ["your own line", window, "#honk", line({ isSelf: true })],
    ["a notice", window, "#honk", line({ kind: "notice" })],
    ["a join", window, "#honk", line({ kind: "join" })],
    ["a channel joined after the drop", window, "#new", line()],
    ["Ergo's replayed join", window, "#honk", line({ from: "HistServ", text: "goose_ joined the channel" })],
  ] as const)("not missed: %s", (_name, win, buffer, msg) => {
    expect(isMissedLine(win, buffer, msg)).toBe(false);
  });

  test("an action is missed like a message", () => {
    expect(isMissedLine(window, "#honk", line({ kind: "action" }))).toBe(true);
  });
});

describe("isMissedMention", () => {
  test("a line naming the nick you had when the connection dropped", () => {
    // After the reconnect the server gave you "goose_".
    expect(isMissedMention(window, "channel", line(), "goose_", mentions)).toBe(true);
  });

  test("a line naming your current nick", () => {
    const msg = line({ text: "goose_: welcome back" });
    expect(isMissedMention(window, "channel", msg, "goose_", mentions)).toBe(true);
  });

  test("a channel line that names nobody is not a mention", () => {
    const msg = line({ text: "anyone around?" });
    expect(isMissedMention(window, "channel", msg, "goose", mentions)).toBe(false);
  });

  test("every DM line is a mention", () => {
    const msg = line({ text: "anyone around?" });
    expect(isMissedMention(window, "dm", msg, "goose", mentions)).toBe(true);
  });
});

describe("dmTargets", () => {
  // The shape irc-client-ts gives: CHATHISTORY is not in its command table.
  const target = (name: string) => ({
    command: undefined,
    params: ["TARGETS", name, "timestamp=2026-11-26T22:02:00.000Z"],
  });

  test("lists the nicks and leaves out channels", () => {
    expect(dmTargets([target("alice"), target("#honk"), target("bob")], ["goose"])).toEqual([
      "alice",
      "bob",
    ]);
  });

  test("leaves out your own nicks, old and new", () => {
    expect(dmTargets([target("Goose"), target("goose_"), target("alice")], ["goose", "goose_"])).toEqual([
      "alice",
    ]);
  });

  test("also reads lines from a parser that names the command", () => {
    const line = { command: "CHATHISTORY", params: ["TARGETS", "alice", "timestamp=x"] };
    expect(dmTargets([line], ["goose"])).toEqual(["alice"]);
  });

  test("lists a nick once", () => {
    expect(dmTargets([target("alice"), target("Alice")], ["goose"])).toEqual(["alice"]);
  });

  test("ignores other lines", () => {
    expect(
      dmTargets(
        [
          { command: "privmsg", params: ["goose", "hi"] },
          { command: undefined, params: ["LATEST", "alice"] },
          { command: undefined, params: ["TARGETS"] },
        ],
        ["goose"],
      ),
    ).toEqual([]);
  });
});
