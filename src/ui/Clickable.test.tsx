import { describe, expect, test } from "bun:test";
import type { MousePointerStyle } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { useRenderer } from "@opentui/react";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { Clickable, isPlainClick, PointerTracker } from "./Clickable.tsx";

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
