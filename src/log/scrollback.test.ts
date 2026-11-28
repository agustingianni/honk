import { expect, test } from "bun:test";
import { storedMessages } from "./scrollback.ts";
import type { StoredLine } from "./search.ts";

test("storedMessages: Events read as they do on screen, and a Redacted line says who deleted it", () => {
  const lines: StoredLine[] = [
    { id: 1, time: 0, kind: "message", nick: "me", text: "hi", self: true, mention: false },
    { id: 2, time: 0, kind: "join", nick: "bob", text: "", self: false, mention: false },
    { id: 3, time: 0, kind: "part", nick: "bob", text: "bye", self: false, mention: false },
    { id: 4, time: 0, kind: "quit", nick: "carol", text: "", self: false, mention: false },
    { id: 5, time: 0, kind: "nick", nick: "dave", subject: "dave_", text: "", self: false, mention: false },
    { id: 6, time: 0, kind: "kick", nick: "op", subject: "eve", text: "spam", self: false, mention: false },
    { id: 7, time: 0, kind: "topic", nick: "op", text: "Rust talk", self: false, mention: false },
    { id: 8, time: 0, kind: "message", nick: "eve", text: "spam", self: false, mention: false, redactedBy: "op" },
  ].map((l) => ({ timeFromServer: true, ...l }));
  expect(storedMessages("#rust", lines).map((m) => [m.kind, m.from, m.text, m.isSelf])).toEqual([
    ["message", "me", "hi", true],
    ["join", undefined, "bob joined #rust", false],
    ["part", undefined, "bob left #rust (bye)", false],
    ["part", undefined, "carol quit", false],
    ["system", undefined, "dave is now known as dave_", false],
    ["error", undefined, "eve was kicked by op (spam)", false],
    ["system", undefined, "op changed the topic to: Rust talk", false],
    ["message", "eve", "[message deleted by op]", false],
  ]);
});
