import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import type { BufferState, ChatMessage } from "../types.ts";
import { ChatPane } from "./ChatPane.tsx";

function message(i: number): ChatMessage {
  return {
    id: `m${i}`,
    timestamp: new Date(2026, 10, 27, 12, 0),
    kind: "message",
    from: "fern",
    text: `line ${i}`,
  };
}

/**
 * Renders a ChatPane for `buffer` (a #honk channel by default). Call `destroy`
 * when done: it unmounts the React tree, which is a state update.
 */
async function renderPane(
  buffer: Partial<BufferState>,
  width = 60,
  onOpenLink?: (href: string) => void,
) {
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
  const { renderOnce, captureCharFrame, mockMouse, renderer } = await testRender(
    <ChatPane
      server={undefined}
      buffer={full}
      inputFocused={false}
      paneWidth={width}
      onSubmit={() => {}}
      onPasteLines={() => {}}
      onSelectUser={() => {}}
      onOpenLink={onOpenLink}
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
  return { screen: captureCharFrame().split("\n"), mockMouse, destroy };
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
    (href) => opened.push(href),
  );
  try {
    const at = (text: string) => {
      const y = screen.findIndex((line) => line.includes(text));
      return { x: screen[y]!.indexOf(text) + 2, y };
    };
    const topic = at("https://honk.example/docs");
    const body = at("https://example.com/x");
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
    (href) => opened.push(href),
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
    const y = screen.findIndex((line) => line.includes("https://github.com"));
    await act(() => mockMouse.click(screen[y]!.indexOf("https://github.com") + 3, y));
    await Bun.sleep(400);
    expect(opened).toEqual(["https://github.com/agustingianni/honk"]);
  } finally {
    act(() => renderer.destroy());
  }
});
