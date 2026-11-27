import { expect, test } from "bun:test";
import type { MousePointerStyle } from "@opentui/core";
import { PointerTracker } from "./Clickable.tsx";

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
