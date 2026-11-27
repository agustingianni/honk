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

/** The screen lines that hold the unread divider, with the scrollbar cut off. */
async function dividerLines(width: number, count: number): Promise<string[]> {
  const buffer: BufferState = {
    name: "#honk",
    kind: "channel",
    topic: "",
    messages: Array.from({ length: count }, (_, i) => message(i)),
    users: [],
    unread: 1,
    hasMention: false,
    firstUnreadId: `m${count - 1}`,
  };
  const { renderOnce, captureCharFrame, renderer } = await testRender(
    <ChatPane
      server={undefined}
      buffer={buffer}
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
    return captureCharFrame()
      .split("\n")
      .filter((line) => line.includes("─") || line.includes(" new "))
      .map((line) => line.replace(/█/g, "").trimEnd());
  } finally {
    // Destroying the renderer unmounts the React tree, which is a state update.
    act(() => renderer.destroy());
  }
}

// 60 messages overflow the feed, so the scrollbar takes one column.
for (const count of [3, 60]) {
  for (const width of [12, 80, 1200]) {
    test(`the unread divider is one full line at width ${width} with ${count} messages`, async () => {
      const lines = await dividerLines(width, count);
      expect(lines).toHaveLength(1);
      // One space of padding, the rule, then the scrollbar column if there is one.
      expect(lines[0]).toMatch(/^ ─+ new ─+$/);
      expect(lines[0]!.length).toBe(width - 1 - (count === 60 ? 1 : 0));
    });
  }
}
