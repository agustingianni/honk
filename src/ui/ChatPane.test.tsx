import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
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

/** Renders a ChatPane for `buffer` (a #honk channel by default) and returns the screen lines. */
async function renderLines(buffer: Partial<BufferState>, width = 60): Promise<string[]> {
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
  const { renderOnce, captureCharFrame, renderer } = await testRender(
    <ChatPane
      server={undefined}
      buffer={full}
      inputFocused={false}
      paneWidth={width}
      onSubmit={() => {}}
      onPasteLines={() => {}}
      onSelectUser={() => {}}
    />,
    { width, height: 24 },
  );
  try {
    await renderOnce();
    return captureCharFrame().split("\n");
  } finally {
    // Destroying the renderer unmounts the React tree, which is a state update.
    act(() => renderer.destroy());
  }
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
