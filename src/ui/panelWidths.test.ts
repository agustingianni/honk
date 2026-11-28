import { expect, test } from "bun:test";
import type { BufferState, ChatMessage, ServerState } from "../types.ts";
import { truncate } from "./display.ts";
import { applyTimeFormat, DEFAULT_TIME_FORMAT } from "./timeFormat.ts";
import {
  bufferNameRoom,
  nickColumnInPane,
  nickColumnWidth,
  nicklistNickRoom,
  nicklistWidth,
  panelLayout,
  serverNameRoom,
  sidebarWidth,
} from "./panelWidths.ts";

let nextId = 1;
function said(from: string, kind: ChatMessage["kind"] = "message"): ChatMessage {
  return { id: String(nextId++), timestamp: new Date(0), kind, from, text: "hi" };
}

test("short nicks give the nick column its minimum of 8", () => {
  expect(nickColumnWidth([said("al"), said("bob")], 16)).toBe(8);
  expect(nickColumnWidth([], 16)).toBe(8);
});

test("the nick column fits the longest sender", () => {
  expect(nickColumnWidth([said("al"), said("fernando_cuts")], 16)).toBe(13);
});

test("a 30-character nick gives the nick column its maximum", () => {
  expect(nickColumnWidth([said("a".repeat(30))], 16)).toBe(16);
});

test("the nick column measures a CJK nick in cells", () => {
  // 5 characters, 10 cells.
  expect(nickColumnWidth([said("田中さんだ")], 16)).toBe(10);
});

test("a notice label counts toward the nick column with its dashes", () => {
  // "-NickServ-" is 10 cells.
  expect(nickColumnWidth([said("NickServ", "notice")], 16)).toBe(10);
});

test("events don't count toward the nick column", () => {
  expect(nickColumnWidth([said("x".repeat(12), "join"), said("x".repeat(12), "part")], 16)).toBe(8);
});

test("the nick column takes at most half of a narrow chat pane, and never less than 8", () => {
  expect(nickColumnInPane(16, 100)).toBe(16);
  // 6 cells of time and space, then the nick: 6 + 14 is half of 40.
  expect(nickColumnInPane(16, 40)).toBe(14);
  expect(nickColumnInPane(16, 10)).toBe(8);
});

test("the nick column leaves half of the pane with the time in the format in use", () => {
  try {
    // 9 cells of time and space: 9 + 11 is half of 40.
    applyTimeFormat("HH:mm:ss");
    expect(nickColumnInPane(16, 40)).toBe(11);
    // No time: the nick column can take the whole half.
    applyTimeFormat("none");
    expect(nickColumnInPane(16, 40)).toBe(16);
    expect(nickColumnInPane(30, 40)).toBe(20);
  } finally {
    applyTimeFormat(DEFAULT_TIME_FORMAT);
  }
});

function server(name: string, buffers: Partial<BufferState>[] = []): ServerState {
  const all = buffers.map((b) => ({ name: "", kind: "channel", topic: "", messages: [], users: [], unread: 0, hasMention: false, ...b }) as BufferState);
  return {
    name,
    bufferOrder: all.map((b) => b.name),
    buffers: Object.fromEntries(all.map((b) => [b.name, b])),
  } as unknown as ServerState;
}

test("short names give the sidebar its minimum of 16", () => {
  expect(sidebarWidth([server("libera", [{ name: "#a" }])])).toBe(16);
});

test("the sidebar fits a buffer name and room for its unread count", () => {
  const name = "#rust-beginners-offtopic";
  const width = sidebarWidth([server("libera", [{ name }])]);
  expect(width).toBeLessThanOrEqual(32);
  // Not cut, even when it shows an unread count.
  expect(truncate(name, bufferNameRoom(width, true))).toBe(name);
  expect(truncate(name, bufferNameRoom(width, false))).toBe(name);
});

test("the sidebar fits a long server name", () => {
  const name = "irc.oftc.example.net";
  const width = sidebarWidth([server(name)]);
  expect(truncate(name, serverNameRoom(width))).toBe(name);
});

test("a 30-character buffer name gives the sidebar its maximum", () => {
  expect(sidebarWidth([server("libera", [{ name: "#" + "a".repeat(29) }])])).toBe(32);
});

test("the sidebar measures a CJK buffer name in cells", () => {
  const name = "#日本語のチャンネル"; // 10 characters, 19 cells
  const width = sidebarWidth([server("libera", [{ name }])]);
  expect(width).toBeGreaterThan(sidebarWidth([server("libera", [{ name: "#" + "a".repeat(9) }])]));
  expect(truncate(name, bufferNameRoom(width, true))).toBe(name);
});

test("a DM counts with its @ in the sidebar", () => {
  const name = "a".repeat(20);
  const width = sidebarWidth([server("libera", [{ name, kind: "dm" }])]);
  expect(truncate(`@${name}`, bufferNameRoom(width, true))).toBe(`@${name}`);
});

const users = (...nicks: string[]) => nicks.map((nick) => ({ prefix: "@", nick }));

test("short nicks give the user list its minimum of 12", () => {
  expect(nicklistWidth(users("al", "bob"))).toBe(12);
});

test("the user list fits the longest nick", () => {
  const nick = "fernando_cuts_x"; // 15
  const width = nicklistWidth(users("al", nick));
  expect(width).toBeLessThan(24);
  expect(truncate(nick, nicklistNickRoom(width))).toBe(nick);
});

test("a 30-character nick gives the user list its maximum", () => {
  expect(nicklistWidth(users("a".repeat(30)))).toBe(24);
});

test("the user list measures a CJK nick in cells", () => {
  const nick = "田中さんだよ"; // 6 characters, 12 cells
  const width = nicklistWidth(users(nick));
  expect(width).toBeGreaterThan(nicklistWidth(users("a".repeat(6))));
  expect(truncate(nick, nicklistNickRoom(width))).toBe(nick);
});

test("the user list fits its header with a large count", () => {
  // "USERS (12345)" is 13 cells, with 2 cells of padding on the left and 1 on the right.
  expect(nicklistWidth(Array.from({ length: 12345 }, (_, i) => ({ prefix: "", nick: `u${i}` })))).toBe(16);
});

test("on a wide terminal the panels get the widths they want", () => {
  expect(panelLayout(200, { sidebar: 24, nicklist: 20 })).toEqual({ sidebar: 24, nicklist: 20, chat: 156 });
});

test("a panel that is off gives its room to the chat", () => {
  expect(panelLayout(100, { nicklist: 20 })).toEqual({ sidebar: 0, nicklist: 20, chat: 80 });
  expect(panelLayout(100, {})).toEqual({ sidebar: 0, nicklist: 0, chat: 100 });
});

test("on an 80-column terminal the chat keeps 40 columns beside the widest panels", () => {
  const layout = panelLayout(80, { sidebar: 32, nicklist: 24 });
  expect(layout.chat).toBeGreaterThanOrEqual(40);
  expect(layout.sidebar).toBeGreaterThan(0);
  expect(layout.nicklist).toBeGreaterThan(0);
  expect(layout.sidebar + layout.nicklist + layout.chat).toBe(80);
});

test("the user list shrinks first, then the sidebar, before either is hidden", () => {
  expect(panelLayout(70, { sidebar: 24, nicklist: 20 })).toEqual({ sidebar: 18, nicklist: 12, chat: 40 });
});

test("when both panels don't fit at their smallest, the user list is hidden first", () => {
  expect(panelLayout(60, { sidebar: 24, nicklist: 20 })).toEqual({ sidebar: 20, nicklist: 0, chat: 40 });
});

test("on a narrow terminal both panels are hidden", () => {
  expect(panelLayout(50, { sidebar: 24, nicklist: 20 })).toEqual({ sidebar: 0, nicklist: 0, chat: 50 });
});
