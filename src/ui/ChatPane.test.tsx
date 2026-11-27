import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { TextAttributes, type MousePointerStyle } from "@opentui/core";
import type { BufferState, ChatMessage, ServerState } from "../types.ts";
import { ChatPane } from "./ChatPane.tsx";
import { dayLabel } from "./dayDivider.ts";

/** Noon today, so the buffer starts on today and gets no day divider. */
function noonToday(): Date {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  return date;
}

function message(i: number): ChatMessage {
  return {
    id: `m${i}`,
    timestamp: noonToday(),
    kind: "message",
    from: "fern",
    text: `line ${i}`,
  };
}

interface Handlers {
  onOpenLink?: (href: string) => void;
  onSelectUser?: (nick: string) => void;
  onJoinChannel?: (channel: string) => void;
}

/**
 * Renders a ChatPane for `buffer` (a #honk channel by default), on a server
 * where your nick is "me". Call `destroy` when done: it unmounts the React
 * tree, which is a state update.
 */
async function renderPane(buffer: Partial<BufferState>, width = 60, handlers: Handlers = {}) {
  const full: BufferState = {
    name: "#honk",
    kind: "channel",
    topic: "",
    messages: [],
    users: [],
    unread: 0,
    hasMention: false,
    ...buffer,
  };
  const server: ServerState = {
    id: "test",
    name: "test",
    config: { id: "test", host: "127.0.0.1", nick: "me" },
    status: "connected",
    nick: "me",
    casemapping: "rfc1459",
    tls: false,
    buffers: { [full.name]: full },
    bufferOrder: [full.name],
  };
  const { renderOnce, captureCharFrame, captureSpans, mockMouse, renderer } = await testRender(
    <ChatPane
      server={server}
      buffer={full}
      inputFocused={false}
      paneWidth={width}
      onSubmit={() => {}}
      onPasteLines={() => {}}
      onSelectUser={handlers.onSelectUser ?? (() => {})}
      onJoinChannel={handlers.onJoinChannel ?? (() => {})}
      onOpenLink={handlers.onOpenLink}
    />,
    { width, height: 24 },
  );
  const destroy = () => act(() => renderer.destroy());
  try {
    await renderOnce();
  } catch (error) {
    destroy();
    throw error;
  }
  return { screen: captureCharFrame().split("\n"), mockMouse, renderer, renderOnce, captureSpans, destroy };
}

/** The cell of the `nth` (from 0) `text` on `screen`, plus `dx` cells. */
function cellOf(screen: string[], text: string, nth = 0, dx = 1) {
  let seen = 0;
  for (let y = 0; y < screen.length; y++) {
    for (let x = screen[y]!.indexOf(text); x !== -1; x = screen[y]!.indexOf(text, x + 1)) {
      if (seen++ === nth) return { x: x + dx, y };
    }
  }
  throw new Error(`"${text}" is not on screen`);
}

/** Renders a ChatPane for `buffer` and returns the screen lines. */
async function renderLines(buffer: Partial<BufferState>, width = 60): Promise<string[]> {
  const { screen, destroy } = await renderPane(buffer, width);
  destroy();
  return screen;
}

// 60 messages overflow the feed, so the scrollbar takes one column.
for (const count of [3, 60]) {
  for (const width of [12, 80, 1200]) {
    test(`the unread divider is one full line at width ${width} with ${count} messages`, async () => {
      const screen = await renderLines(
        {
          messages: Array.from({ length: count }, (_, i) => message(i)),
          unread: 1,
          firstUnreadId: `m${count - 1}`,
        },
        width,
      );
      // The lines that hold the divider, with the scrollbar cut off.
      const lines = screen
        .filter((line) => line.includes("─") || line.includes(" new "))
        .map((line) => line.replace(/█/g, "").trimEnd());
      expect(lines).toHaveLength(1);
      // One space of padding, the rule, then the scrollbar column if there is one.
      expect(lines[0]).toMatch(/^ ─+ new ─+$/);
      expect(lines[0]!.length).toBe(width - 1 - (count === 60 ? 1 : 0));
    });
  }
}

test("a day divider goes above the first line of each day, and above the new divider", async () => {
  const today = noonToday();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 23, 59);
  const label = (d: Date) => dayLabel(d, today);
  const screen = await renderLines(
    {
      messages: [
        { ...message(0), timestamp: yesterday, text: "late" },
        { ...message(1), text: "early" },
        { ...message(2), text: "later" },
      ],
      unread: 1,
      firstUnreadId: "m1",
    },
    80,
  );
  const rows = screen
    .map((line) => line.trim())
    .filter((line) => line.includes("─") || line.includes("│"))
    .map((line) => (line.includes("─") ? line.replace(/─+/g, "-") : line.replace(/\s+/g, " ")));
  // The day change ends grouping, so "early" shows its time and nick.
  expect(rows).toEqual([
    `- ${label(yesterday)} -`,
    "23:59 fern │ late",
    `- ${label(today)} -`,
    "- new -",
    "12:00 fern │ early",
    "│ later",
  ]);
});

test("nicks with wide characters keep the message text in line", async () => {
  const nicks = ["fern", "田中さん", "Zoë", "田中さん田中さん田中"];
  const screen = await renderLines({
    messages: nicks.map((from, i) => ({ ...message(i), from, text: `hello ${i}` })),
  });
  // The time, then the nick right-aligned in its 12 cells, then the gutter.
  const labels = screen
    .filter((line) => line.includes("hello"))
    .map((line) => line.slice(0, line.indexOf("│") + 1));
  expect(labels).toEqual([
    " 12:00         fern │",
    " 12:00     田中さん │",
    " 12:00          Zoë │",
    " 12:00  田中さん田… │",
  ]);
});

test("a wide channel name and topic fit the header", async () => {
  const screen = await renderLines({
    name: "#日本語",
    topic: "日本語のチャンネルへようこそ。ルールを読んでください。".repeat(2),
  });
  expect(screen.find((line) => line.includes("#日本語"))).toBe(
    "  #日本語 — 日本語のチャンネルへようこそ。ルール…  0 users  ",
  );
});

test("a click opens a link in a message and in the topic", async () => {
  const opened: string[] = [];
  const { screen, mockMouse, destroy } = await renderPane(
    {
      topic: "docs at https://honk.example/docs",
      messages: [{ ...message(0), text: "see https://example.com/x for more" }],
    },
    80,
    { onOpenLink: (href) => opened.push(href) },
  );
  try {
    const topic = cellOf(screen, "https://honk.example/docs", 0, 2);
    const body = cellOf(screen, "https://example.com/x", 0, 2);
    // Each click waits for a possible second click before it opens the link.
    await act(() => mockMouse.click(topic.x, topic.y));
    await Bun.sleep(400);
    await act(() => mockMouse.click(body.x, body.y));
    await Bun.sleep(400);
    expect(opened).toEqual(["https://honk.example/docs", "https://example.com/x"]);
  } finally {
    destroy();
  }
});

test("a topic link that is cut to fit is not a link", async () => {
  // "https://github.com…" must not open https://github.com.evil.example/.
  const opened: string[] = [];
  const { screen, mockMouse, destroy } = await renderPane(
    { topic: "docs at https://github.com.evil.example/login" },
    48,
    { onOpenLink: (href) => opened.push(href) },
  );
  try {
    const y = screen.findIndex((line) => line.includes("https://"));
    expect(screen[y]).toContain("https://github.com…");
    await act(() => mockMouse.click(screen[y]!.indexOf("https://") + 2, y));
    await Bun.sleep(400);
    expect(opened).toEqual([]);
  } finally {
    destroy();
  }
});

test("after the topic changes, a click opens the link it shows now", async () => {
  // OpenTUI reads a link's URL only when it creates it, so a reused link kept the old one.
  const opened: string[] = [];
  let setTopic: (topic: string) => void = () => {};
  function Pane() {
    const [topic, set] = useState("docs: https://evil.example/phish");
    setTopic = set;
    const buffer: BufferState = {
      name: "#honk",
      kind: "channel",
      topic,
      messages: [],
      users: [],
      unread: 0,
      hasMention: false,
    };
    return (
      <ChatPane
        server={undefined}
        buffer={buffer}
        inputFocused={false}
        paneWidth={80}
        onSubmit={() => {}}
        onPasteLines={() => {}}
        onSelectUser={() => {}}
        onJoinChannel={() => {}}
        onOpenLink={(href) => opened.push(href)}
      />
    );
  }
  const { renderOnce, captureCharFrame, mockMouse, renderer } = await testRender(<Pane />, {
    width: 80,
    height: 12,
  });
  try {
    await renderOnce();
    await act(async () => setTopic("docs: https://github.com/agustingianni/honk"));
    await renderOnce();
    const screen = captureCharFrame().split("\n");
    // A few cells into the URL, which starts after "docs: ".
    const y = screen.findIndex((line) => line.includes("docs: "));
    await act(() => mockMouse.click(screen[y]!.indexOf("docs: ") + 9, y));
    await Bun.sleep(400);
    expect(opened).toEqual(["https://github.com/agustingianni/honk"]);
  } finally {
    act(() => renderer.destroy());
  }
});

test("bidi and control characters from the server never reach the screen", async () => {
  // OpenTUI draws cells, and these characters take no cell, so the terminal
  // never sees them. If that ever changes, a nick or a topic could turn the text
  // after it around in a terminal with bidi support (U+202E, "Trojan Source").
  const bad = "\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u200E\u200F\u061C\u009B\u007F";
  const screen = await renderLines({
    name: `#ho${bad}nk`,
    topic: `the ${bad}topic`,
    messages: [{ ...message(0), from: `ev${bad}e`, text: `see ${bad}gpj.exe \u05E9\u05DC\u05D5\u05DD` }],
  });
  const text = screen.join("\n");
  expect([...text].filter((c) => bad.includes(c))).toEqual([]);
  expect(text).toContain("#honk");
  expect(text).toContain("the topic");
  expect(text).toContain("eve");
  // Right-to-left letters are kept, in the order they were sent.
  expect(text).toContain("see gpj.exe \u05E9\u05DC\u05D5\u05DD");
});

describe("names in messages", () => {
  const users = ["alice", "bob", "Hello_", "me", "sent"].map((nick) => ({ prefix: "", nick }));
  const lines: ChatMessage[] = [
    { ...message(0), from: "carol", text: "bob: look at #rust, or ask me" },
    { ...message(1), kind: "action", from: "alice", text: "waves at BOB" },
    { ...message(2), from: "carol", text: "hello see https://example.com/bob" },
    {
      ...message(3),
      from: "carol",
      text: "a long line that wraps onto the next screen line, where bob is",
    },
    { ...message(4), from: "me", isSelf: true, delivery: "failed", text: "ok bob" },
    { ...message(5), from: "carol", text: "x\u202E\u2066 y alice z" },
  ];

  async function setup() {
    const clicked: string[] = [];
    const pane = await renderPane({ users, messages: lines }, 60, {
      onSelectUser: (nick) => clicked.push(`dm ${nick}`),
      onJoinChannel: (channel) => clicked.push(`join ${channel}`),
      onOpenLink: (href) => clicked.push(`open ${href}`),
    });
    const at = (text: string, nth = 0, dx = 1) => cellOf(pane.screen, text, nth, dx);
    /** A click, then the wait for a possible second click, after which it opens. */
    const click = async (text: string, nth = 0, dx = 1) => {
      const { x, y } = at(text, nth, dx);
      await act(() => pane.mockMouse.click(x, y));
      await Bun.sleep(400);
    };
    return { ...pane, clicked, at, click };
  }

  test("a click on a nick opens a DM, and a click on a channel joins it", async () => {
    const { screen, click, clicked, destroy } = await setup();
    try {
      expect(screen.find((l) => l.includes("where bob is"))).toBeDefined();
      await click("bob:"); // a nick before a colon
      await click("#rust"); // the comma after it is not part of the name
      await click("alice"); // the sender of an action
      await click("BOB"); // nicks match without case
      await click("bob is"); // on the second line of a wrapped message
      await click("y alice", 0, 3); // after characters that take no cell
      // "BOB" opens the DM under the nick as the user list spells it.
      expect(clicked).toEqual(["dm bob", "join #rust", "dm alice", "dm bob", "dm bob", "dm alice"]);
    } finally {
      destroy();
    }
  });

  test("words that are not names of others in the channel do nothing", async () => {
    const { click, clicked, destroy } = await setup();
    try {
      await click("hello"); // no one has this nick: Hello_ is not hello
      await click("ask me", 0, 5); // your own nick
      await click("look"); // a plain word
      await click(", or", 0, 0); // the comma after #rust
      await click("(not sent)", 0, 6); // "sent" is a nick, but not part of the message
      expect(clicked).toEqual([]);
      await click("ok bob", 0, 3); // the message before it still has names
      expect(clicked).toEqual(["dm bob"]);
      clicked.length = 0;
      await click("example.com/bob", 0, 13); // a nick inside a link is the link
      expect(clicked).toEqual(["open https://example.com/bob"]);
    } finally {
      destroy();
    }
  });

  test("a drag across a nick selects text and opens nothing", async () => {
    const { at, mockMouse, renderer, clicked, destroy } = await setup();
    try {
      const { x, y } = at("bob:", 0, 0);
      await act(() => mockMouse.drag(x, y, x + 3, y));
      expect(renderer.getSelection()?.getSelectedText()).toBe("bob:");
      expect(clicked).toEqual([]);
    } finally {
      destroy();
    }
  });

  test("a name under the mouse is underlined and shows the hand pointer", async () => {
    const { at, mockMouse, renderer, renderOnce, captureSpans, destroy } = await setup();
    try {
      const pointers: MousePointerStyle[] = [];
      renderer.setMousePointer = (shape: MousePointerStyle) => void pointers.push(shape);
      const nick = at("bob:");
      const plain = at("look");
      /** True when the cell at (x, y) is underlined. */
      const underlined = (x: number, y: number) => {
        let left = x;
        for (const span of captureSpans().lines[y]!.spans) {
          if (left < span.width) return (span.attributes & TextAttributes.UNDERLINE) !== 0;
          left -= span.width;
        }
        return false;
      };
      await act(() => mockMouse.moveTo(nick.x, nick.y));
      await renderOnce();
      expect(underlined(nick.x, nick.y)).toBe(true);
      expect(underlined(plain.x, plain.y)).toBe(false);
      await act(() => mockMouse.moveTo(plain.x, plain.y));
      await renderOnce();
      expect(underlined(nick.x, nick.y)).toBe(false);
      expect(pointers).toEqual(["pointer", "default"]);
    } finally {
      destroy();
    }
  });
});
