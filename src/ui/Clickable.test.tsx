import { describe, expect, test } from "bun:test";
import type { MousePointerStyle } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { useRenderer } from "@opentui/react";
import { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import {
  Clickable,
  isPlainClick,
  LinkArea,
  NameText,
  PointerTracker,
  type NameActions,
} from "./Clickable.tsx";

function track() {
  const shapes: MousePointerStyle[] = [];
  return { shapes, tracker: new PointerTracker((shape) => shapes.push(shape)) };
}

/** The tracker picks the shape in a microtask. */
const settle = () => Promise.resolve();

test("the pointer is a hand over a clickable row and goes back when the mouse leaves", async () => {
  const { shapes, tracker } = track();
  tracker.enter();
  await settle();
  tracker.leave();
  await settle();
  expect(shapes).toEqual(["pointer", "default"]);
});

test("moving to the next row keeps the hand without a flicker, in either order", async () => {
  const a = track();
  a.tracker.enter();
  await settle();
  a.tracker.leave(); // the old row first
  a.tracker.enter();
  await settle();
  expect(a.shapes).toEqual(["pointer"]);

  const b = track();
  b.tracker.enter();
  await settle();
  b.tracker.enter(); // the new row first
  b.tracker.leave();
  await settle();
  expect(b.shapes).toEqual(["pointer"]);
});

// Mouse events change React state, so each one runs inside act().
describe("isPlainClick", () => {
  // A nick next to message text, as in a chat row: "alice" at x 0-4, the text after it.
  async function setup() {
    const clicks: string[] = [];
    function Row() {
      const renderer = useRenderer();
      return (
        <box flexDirection="row">
          <Clickable
            onMouseUp={(event) => {
              if (isPlainClick(renderer, event)) clicks.push("alice");
            }}
          >
            <text>alice</text>
          </Clickable>
          <text> hello there</text>
        </box>
      );
    }
    const rendered = await testRender(<Row />, { width: 30, height: 3 });
    await rendered.renderOnce();
    return { ...rendered, clicks };
  }

  test("a click on the nick counts", async () => {
    const { mockMouse, clicks, dispose } = await setup();
    await act(() => mockMouse.click(2, 0));
    expect(clicks).toEqual(["alice"]);
    await act(() => dispose());
  });

  test("a drag that selects text does not count, inside the nick or past it", async () => {
    const { mockMouse, clicks, renderer, dispose } = await setup();
    await act(() => mockMouse.drag(0, 0, 3, 0));
    expect(renderer.getSelection()?.getSelectedText()).toBe("alic");
    await act(() => mockMouse.drag(1, 0, 12, 0));
    expect(clicks).toEqual([]);
    await act(() => dispose());
  });

  test("a press elsewhere that is released on the nick does not count", async () => {
    const { mockMouse, clicks, dispose } = await setup();
    await act(() => mockMouse.drag(10, 0, 2, 0));
    expect(clicks).toEqual([]);
    await act(() => dispose());
  });

  test("a click with a modifier key does not count", async () => {
    const { mockMouse, clicks, dispose } = await setup();
    await act(() => mockMouse.click(2, 0, MouseButtons.LEFT, { modifiers: { shift: true } }));
    await act(() => mockMouse.click(2, 0, MouseButtons.LEFT, { modifiers: { alt: true } }));
    expect(clicks).toEqual([]);
    await act(() => dispose());
  });
});

describe("LinkArea", () => {
  // A click waits this long for a second one before it opens the link.
  const DOUBLE_CLICK_MS = 100;
  /** A click, then the wait for the open. */
  const click = async (mouse: { click: (x: number, y: number) => Promise<void> }, x: number, y: number) => {
    await act(() => mouse.click(x, y));
    await Bun.sleep(DOUBLE_CLICK_MS * 3);
  };

  // "see " then a link 26 cells long, in a box 10 cells wide, so the link
  // wraps onto three lines: "see https:", "//example.", "com/abcdef" ...
  const URL = "https://example.com/abcdef";
  async function setup({ canOpen = true } = {}) {
    const opened: string[] = [];
    const rendered = await testRender(
      <LinkArea
        onOpenLink={canOpen ? (href) => opened.push(href) : undefined}
        doubleClickMs={DOUBLE_CLICK_MS}
        width={10}
      >
        <text>
          see <a href={URL}>{URL}</a>
        </text>
      </LinkArea>,
      { width: 20, height: 5 },
    );
    const pointers: MousePointerStyle[] = [];
    rendered.renderer.setMousePointer = (shape: MousePointerStyle) => void pointers.push(shape);
    await rendered.renderOnce();
    return { ...rendered, opened, pointers };
  }

  test("a plain click on a link opens it, from every line it wraps onto", async () => {
    const { mockMouse, opened, captureCharFrame, dispose } = await setup();
    expect(captureCharFrame().split("\n").slice(0, 3).map((l) => l.trimEnd())).toEqual([
      "see https:",
      "//example.",
      "com/abcdef",
    ]);
    await click(mockMouse, 6, 0);
    await click(mockMouse, 3, 1);
    await click(mockMouse, 8, 2);
    expect(opened).toEqual([URL, URL, URL]);
    await act(() => dispose());
  });

  test("a click on plain text next to a link opens nothing", async () => {
    const { mockMouse, opened, dispose } = await setup();
    await click(mockMouse, 1, 0);
    expect(opened).toEqual([]);
    await act(() => dispose());
  });

  test("a drag across a link selects text and does not open it", async () => {
    const { mockMouse, opened, renderer, dispose } = await setup();
    await act(() => mockMouse.drag(0, 0, 7, 0));
    expect(renderer.getSelection()?.getSelectedText()).toBe("see http");
    await act(() => mockMouse.drag(5, 0, 8, 0)); // inside the link
    expect(renderer.getSelection()?.getSelectedText()).toBe("ttps");
    expect(opened).toEqual([]);
    await act(() => dispose());
  });

  test("Shift+click and Alt+click leave the link to the terminal", async () => {
    const { mockMouse, opened, dispose } = await setup();
    await act(() => mockMouse.click(6, 0, MouseButtons.LEFT, { modifiers: { shift: true } }));
    await act(() => mockMouse.click(6, 0, MouseButtons.LEFT, { modifiers: { alt: true } }));
    expect(opened).toEqual([]);
    await act(() => dispose());
  });

  test("the pointer is a hand over a link and goes back off it", async () => {
    const { mockMouse, pointers, dispose } = await setup();
    await act(() => mockMouse.moveTo(1, 0)); // "see"
    await act(() => mockMouse.moveTo(6, 0)); // the link
    await act(() => mockMouse.moveTo(3, 1)); // still the link, on its second line
    await act(() => mockMouse.moveTo(1, 0)); // back on "see"
    expect(pointers).toEqual(["pointer", "default"]);
    await act(() => dispose());
  });

  test("where links cannot open (over SSH), there is no hand pointer", async () => {
    const { mockMouse, pointers, dispose } = await setup({ canOpen: false });
    await act(() => mockMouse.moveTo(6, 0));
    await act(() => mockMouse.click(6, 0));
    expect(pointers).toEqual([]);
    await act(() => dispose());
  });

  test("a link that moved under the mouse after the press does not open", async () => {
    // New lines scroll the feed: the press was on plain text, the release is on a link.
    const opened: string[] = [];
    let setText: (text: string) => void = () => {};
    function Feed() {
      const [text, set] = useState("plain text");
      setText = set;
      return (
        <LinkArea onOpenLink={(href) => opened.push(href)} width={30}>
          <text>{text.startsWith("https://") ? <a href={text}>{text}</a> : text}</text>
        </LinkArea>
      );
    }
    const { mockMouse, renderOnce, dispose } = await testRender(<Feed />, { width: 30, height: 3 });
    await renderOnce();
    await act(() => mockMouse.pressDown(2, 0));
    await act(async () => setText("https://evil.example/"));
    await renderOnce();
    await act(() => mockMouse.release(2, 0));
    expect(opened).toEqual([]);
    await act(() => dispose());
  });

  test("a double-click on a link, to select it, does not open it", async () => {
    const { mockMouse, opened, dispose } = await setup();
    await act(() => mockMouse.doubleClick(6, 0, MouseButtons.LEFT, { delayMs: 1 }));
    await Bun.sleep(DOUBLE_CLICK_MS * 3);
    expect(opened).toEqual([]);
    await act(() => dispose());
  });

  test("the click that focuses the terminal window does not open a link", async () => {
    const { mockMouse, opened, renderer, dispose } = await setup();
    renderer.emit("focus");
    await click(mockMouse, 6, 0);
    expect(opened).toEqual([]);
    await act(() => dispose());
  });
});

describe("NameText", () => {
  const names = (opened: string[]): NameActions => ({
    findNick: (word) => (word === "bob" ? "bob" : undefined),
    openNick: (nick) => opened.push(`dm ${nick}`),
    openChannel: (channel) => opened.push(`join ${channel}`),
  });

  test("a name that moved under the mouse after the press does not open", async () => {
    // New lines scroll the feed: the press was on plain text, the release is on a channel name.
    const opened: string[] = [];
    let setText: (text: string) => void = () => {};
    function Line() {
      const [text, set] = useState("plain text");
      setText = set;
      return (
        <NameText names={names(opened)} namesEnd={text.length}>
          {() => text}
        </NameText>
      );
    }
    const { mockMouse, renderOnce, dispose } = await testRender(<Line />, { width: 30, height: 3 });
    await renderOnce();
    await act(() => mockMouse.pressDown(2, 0));
    await act(async () => setText("#evil"));
    await renderOnce();
    await act(() => mockMouse.release(2, 0));
    expect(opened).toEqual([]);
    await act(() => dispose());
  });

  test("the click that focuses the terminal window does not open a name", async () => {
    const opened: string[] = [];
    const { mockMouse, renderOnce, renderer, dispose } = await testRender(
      <NameText names={names(opened)} namesEnd={9}>
        {() => "bob #rust"}
      </NameText>,
      { width: 30, height: 3 },
    );
    await renderOnce();
    renderer.emit("focus");
    await act(() => mockMouse.click(1, 0));
    expect(opened).toEqual([]);
    await act(() => mockMouse.click(6, 0)); // still within the focus guard
    expect(opened).toEqual([]);
    await Bun.sleep(550);
    await act(() => mockMouse.click(1, 0));
    await act(() => mockMouse.click(6, 0));
    expect(opened).toEqual(["dm bob", "join #rust"]);
    await act(() => dispose());
  });
});
