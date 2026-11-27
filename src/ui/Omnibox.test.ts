import { expect, test } from "bun:test";
import { applyGlyphs } from "./glyphs.ts";
import { highlightRuns, rankActions, type RecentActions } from "./Omnibox.tsx";

type Action = { id: string; label: string; detail?: string; historyKey?: string };

/** The ">" list inside #honk on alpha (active), with beta also connected, in the code's order. */
const ACTIONS: Action[] = [
  { id: "cmd-join", label: "Channel: Join a Channel..." },
  { id: "cmd-dm", label: "User: Open a DM..." },
  { id: "cmd-topic", label: "Channel: Set Topic...", detail: "#honk" },
  { id: "cmd-part", label: "Channel: Part #honk", detail: "alpha" },
  { id: "cmd-history", label: "Chat: Load Older Messages", detail: "/history" },
  { id: "cmd-clear", label: "Chat: Clear Buffer", detail: "#honk" },
  { id: "cmd-theme", label: "Preferences: Color Theme...", detail: "Tokyo Night" },
  { id: "cmd-sidebar", label: "View: Toggle Sidebar" },
  { id: "cmd-nicklist", label: "View: Toggle User List" },
  { id: "cmd-nick", label: "Server: Change Nick...", detail: "goose, alpha" },
  { id: "cmd-reconnect-alpha", label: "Server: Reconnect alpha", historyKey: "cmd-reconnect" },
  { id: "cmd-disconnect-alpha", label: "Server: Disconnect alpha", historyKey: "cmd-disconnect" },
  { id: "cmd-reconnect-beta", label: "Server: Reconnect beta", historyKey: "cmd-reconnect" },
  { id: "cmd-disconnect-beta", label: "Server: Disconnect beta", historyKey: "cmd-disconnect" },
  { id: "cmd-connect", label: "Server: Connect to a New Server..." },
  { id: "cmd-slash", label: "IRC: Slash Commands..." },
  { id: "cmd-quit", label: "App: Quit" },
];

const labels = (q: string, recent: RecentActions = {}) =>
  rankActions(q, ACTIONS, recent).map((a) => a.label);
/** The ranked labels, keeping only `keep`, to check their order among themselves. */
const orderOf = (q: string, keep: string[], recent: RecentActions = {}) =>
  labels(q, recent).filter((l) => keep.includes(l));

test("a match at a word start ranks above one inside a word", () => {
  // "re" is inside "Preferences" but starts "Reconnect".
  expect(labels("re")[0]).toBe("Server: Reconnect alpha");
  expect(labels("re").indexOf("Preferences: Color Theme...")).toBeGreaterThan(1);
  // "connect" starts a word in "Connect to a New Server", not in "Reconnect".
  expect(labels("connect")[0]).toBe("Server: Connect to a New Server...");
});

test("equal matches go by the action used last, then by list order", () => {
  // "ch" starts "Chat" and "Channel" in all five rows: a tie, so the list order decides.
  const chat = ["Chat: Load Older Messages", "Chat: Clear Buffer"];
  expect(labels("ch")[0]).toBe("Channel: Join a Channel...");
  expect(orderOf("ch", chat)).toEqual(chat);
  // Clear used last: it comes first.
  const recent = { "cmd-history": 1, "cmd-clear": 2 };
  expect(labels("ch", recent)[0]).toBe("Chat: Clear Buffer");
  expect(orderOf("ch", chat, recent)).toEqual(["Chat: Clear Buffer", "Chat: Load Older Messages"]);
});

test("a recent action does not beat a better match", () => {
  expect(labels("re", { "cmd-theme": 9 })[0]).toBe("Server: Reconnect alpha");
});

test("server rows stay grouped by server, the active one first", () => {
  const rows = ACTIONS.filter((a) => a.historyKey).map((a) => a.label);
  expect(orderOf("server", rows)).toEqual([
    "Server: Reconnect alpha",
    "Server: Disconnect alpha",
    "Server: Reconnect beta",
    "Server: Disconnect beta",
  ]);
  // Reconnect used lately: those rows rise together, alpha's still first.
  expect(labels("server", { "cmd-reconnect": 1 })[0]).toBe("Server: Reconnect alpha");
  expect(orderOf("server", rows, { "cmd-reconnect": 1 })).toEqual([
    "Server: Reconnect alpha",
    "Server: Reconnect beta",
    "Server: Disconnect alpha",
    "Server: Disconnect beta",
  ]);
});

test("the detail matches too, but only label characters are highlighted", () => {
  const [first] = rankActions("history", ACTIONS);
  expect(first?.label).toBe("Chat: Load Older Messages");
  expect(first?.highlights).toEqual([]);
  const [clear] = rankActions("clear", ACTIONS);
  expect(clear?.highlights).toEqual([6, 7, 8, 9, 10]);
});

test("an empty query keeps every action, in list order", () => {
  expect(labels("")).toEqual(ACTIONS.map((a) => a.label));
});

test("highlight runs split the label into matched and plain parts", () => {
  expect(highlightRuns("Chat: Clear", false, [6, 7])).toEqual([
    { text: "Chat: ", hit: false },
    { text: "Cl", hit: true },
    { text: "ear", hit: false },
  ]);
  // Cut short: the "…" and what it hides are not highlighted.
  expect(highlightRuns("Server: Re…", true, [8, 9, 10, 15])).toEqual([
    { text: "Server: ", hit: false },
    { text: "Re", hit: true },
    { text: "…", hit: false },
  ]);
  applyGlyphs(true);
  try {
    expect(highlightRuns("Server: Re...", true, [8, 9, 10, 11, 15])).toEqual([
      { text: "Server: ", hit: false },
      { text: "Re", hit: true },
      { text: "...", hit: false },
    ]);
    // As long as the full label "田中さん", but still cut.
    expect(highlightRuns("田...", true, [0, 1, 2])).toEqual([
      { text: "田", hit: true },
      { text: "...", hit: false },
    ]);
  } finally {
    applyGlyphs(false);
  }
});

test("a match in the label ranks above one in the detail", () => {
  // "#honk" is in the label of Part, but only in the detail of Set Topic and Clear.
  expect(labels("honk")[0]).toBe("Channel: Part #honk");
  // "alpha" is only ever in a label for the server rows.
  expect(labels("alpha").slice(0, 2)).toEqual(["Server: Reconnect alpha", "Server: Disconnect alpha"]);
});
