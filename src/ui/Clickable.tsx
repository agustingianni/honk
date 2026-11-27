import type { MousePointerStyle } from "@opentui/core";
import { useRenderer, type BoxProps } from "@opentui/react";
import { useEffect, useState } from "react";

/**
 * Decides the mouse pointer from how many clickable elements are under the
 * mouse, and calls `set` only when the shape changes.
 *
 * Moving from one row to the next fires the old row's "out" and the new row's
 * "over" in the same mouse move, and React may render after each one. Setting
 * the pointer right away would send "default" and then "pointer", a flicker.
 * So the tracker counts, and picks the shape one microtask later, after both.
 */
export class PointerTracker {
  private count = 0;
  private shape: MousePointerStyle = "default";
  private scheduled = false;

  constructor(private readonly set: (shape: MousePointerStyle) => void) {}

  enter(): void {
    this.count++;
    this.update();
  }

  leave(): void {
    this.count--;
    this.update();
  }

  private update(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const shape = this.count > 0 ? "pointer" : "default";
      if (shape === this.shape) return;
      this.shape = shape;
      this.set(shape);
    });
  }
}

// honk has one renderer, so one tracker, set up on the first hover.
let tracker: PointerTracker | undefined;
// How to clear each row under the mouse. A terminal sends no mouse event when
// its window loses focus, so on the renderer's "blur", every row is cleared.
const hoveredRows = new Set<() => void>();

type ClickableProps = Omit<BoxProps, "onMouseOver" | "onMouseOut" | "onMouseMove"> & {
  /** The background under the mouse, from the theme. Leave it out to keep `backgroundColor`, as for the selected row. */
  hoverColor?: string;
};

/**
 * A box that shows it can be clicked: under the mouse, it gets `hoverColor`
 * and the terminal shows the hand pointer. Terminals without the pointer
 * escape (OSC 22) ignore it. A box without `onMouseDown` does nothing on a
 * click (your own nick), so it gets no hover look.
 */
export function Clickable({ hoverColor, ...props }: ClickableProps) {
  const renderer = useRenderer();
  const [mouseOver, setMouseOver] = useState(false);
  const hovered = mouseOver && props.onMouseDown !== undefined;

  useEffect(() => {
    if (!hovered) return;
    if (!tracker) {
      tracker = new PointerTracker((shape) => renderer.setMousePointer(shape));
      renderer.on("blur", () => {
        for (const clear of hoveredRows) clear();
      });
    }
    const rowTracker = tracker;
    const clear = () => setMouseOver(false);
    hoveredRows.add(clear);
    rowTracker.enter();
    // Also runs when the box goes away while the mouse is over it.
    return () => {
      hoveredRows.delete(clear);
      rowTracker.leave();
    };
  }, [hovered, renderer]);

  return (
    <box
      {...props}
      backgroundColor={hovered && hoverColor ? hoverColor : props.backgroundColor}
      // "over" and "out" bubble up from the text inside the box, like in the DOM.
      // Moving onto the box's own text fires "out" then "over"; both land in one render.
      onMouseOver={() => setMouseOver(true)}
      onMouseOut={() => setMouseOver(false)}
      // After a blur cleared the row, OpenTUI still counts the mouse as over it
      // and sends no new "over" when the mouse comes back. A move lights it again.
      onMouseMove={() => setMouseOver(true)}
    />
  );
}
