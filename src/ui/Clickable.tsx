import type { CliRenderer, MouseEvent, MousePointerStyle } from "@opentui/core";
import { useRenderer, type BoxProps } from "@opentui/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

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

interface RendererHover {
  tracker: PointerTracker;
  /**
   * How to clear each row under the mouse. A terminal sends no mouse event
   * when its window loses focus, so on the renderer's "blur", every row is
   * cleared.
   */
  rows: Set<() => void>;
}

// One per renderer, set up on its first hover. honk has one renderer; the
// tests make a new one for each test.
const hoverByRenderer = new WeakMap<CliRenderer, RendererHover>();

function hoverFor(renderer: CliRenderer): RendererHover {
  let hover = hoverByRenderer.get(renderer);
  if (!hover) {
    const rows = new Set<() => void>();
    hover = {
      rows,
      tracker: new PointerTracker((shape) => {
        // The pointer is picked a microtask later; the renderer may be gone by then.
        if (!renderer.isDestroyed) renderer.setMousePointer(shape);
      }),
    };
    renderer.on("blur", () => {
      for (const clear of rows) clear();
    });
    hoverByRenderer.set(renderer, hover);
  }
  return hover;
}

/**
 * True for a mouse up that ends a plain left click on text: no drag, no
 * double-click, no modifier key. A press on text always starts a selection,
 * so a click arrives with `isDragging` too; a selection that is still at its
 * start in "cell" mode means the mouse never moved. A mouse up without
 * `isDragging` did not start on this text (a press elsewhere, released here),
 * so it is not a click. Use it in `onMouseUp` on text that people may also
 * want to select and copy. (The same rule as opencode's plainClick.)
 */
export function isPlainClick(renderer: CliRenderer, event: MouseEvent): boolean {
  if (!event.isDragging) return false;
  if (event.modifiers.ctrl || event.modifiers.alt || event.modifiers.shift) return false;
  const selection = renderer.getSelection();
  return selection?.isStart === true && selection.behavior === "cell";
}

/**
 * Shows the hand pointer while `hovered` is true. `clear` sets it back to
 * false on the renderer's "blur".
 */
function usePointer(hovered: boolean, clear: (hovered: false) => void): void {
  const renderer = useRenderer();
  useEffect(() => {
    if (!hovered) return;
    const { tracker, rows } = hoverFor(renderer);
    const clearRow = () => clear(false);
    rows.add(clearRow);
    tracker.enter();
    // Also runs when the box goes away while the mouse is over it.
    return () => {
      rows.delete(clearRow);
      tracker.leave();
    };
  }, [hovered, renderer, clear]);
}

type ClickableProps = Omit<BoxProps, "onMouseOver" | "onMouseOut" | "onMouseMove" | "children"> & {
  /** The background under the mouse, from the theme. Leave it out to keep `backgroundColor`, as for the selected row. */
  hoverColor?: string;
  /** A function gets whether the mouse is over the box, to change the text (an underline). */
  children?: ReactNode | ((hovered: boolean) => ReactNode);
};

/**
 * A box that shows it can be clicked: under the mouse, it gets `hoverColor`
 * and the terminal shows the hand pointer. Terminals without the pointer
 * escape (OSC 22) ignore it. A box without `onMouseDown` or `onMouseUp` does
 * nothing on a click (your own nick), so it gets no hover look.
 */
export function Clickable({ hoverColor, children, ...props }: ClickableProps) {
  const [mouseOver, setMouseOver] = useState(false);
  const hovered =
    mouseOver && (props.onMouseDown !== undefined || props.onMouseUp !== undefined);
  usePointer(hovered, setMouseOver);

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
    >
      {typeof children === "function" ? children(hovered) : children}
    </box>
  );
}

/** A click this soon after the terminal window got focus may be the click that focused it. */
const FOCUS_CLICK_MS = 500;

type LinkAreaProps = Omit<
  BoxProps,
  "onMouseOver" | "onMouseOut" | "onMouseMove" | "onMouseDown" | "onMouseUp"
> & {
  /** Opens a link. Without it (over SSH), links get no hand pointer and a click is left to the terminal. */
  onOpenLink: ((href: string) => void) | undefined;
};

/**
 * A box whose links (the `<a href>` in its text) open with a plain click,
 * and show the hand pointer under the mouse. The terminal draws the links
 * itself (OSC 8), so the box asks the renderer which link is at the mouse:
 * that also finds both lines of a link that wraps.
 *
 * A drag across a link still selects text, and Shift, Alt, or Ctrl with a
 * click leaves the link to the terminal (Cmd+click in most of them).
 *
 * The links come from other people, so a click opens one only when it is
 * clearly meant for it:
 *
 * - The same link is under the mouse at press and at release. New lines can
 *   scroll the feed in between, and someone flooding links could otherwise
 *   slide their link under a click that started on plain text.
 * - The terminal window did not just get focus: some terminals pass the click
 *   that focuses the window on to honk.
 *
 * The pointer is checked only when the mouse moves. After a wheel scroll or a
 * new line under a still mouse, it is updated on the next move.
 */
export function LinkArea({ onOpenLink, children, ...props }: LinkAreaProps) {
  const renderer = useRenderer();
  const [overLink, setOverLink] = useState(false);
  usePointer(overLink, setOverLink);

  // The link under the mouse when the button went down.
  const pressedLink = useRef<string | null>(null);
  // When the window last got focus; never, until it does.
  const focusedAt = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    const onFocus = () => {
      focusedAt.current = performance.now();
    };
    renderer.on("focus", onFocus);
    return () => {
      renderer.off("focus", onFocus);
    };
  }, [renderer]);

  // Only whether there is a link: the id is enough, without copying its URL.
  const check = (event: MouseEvent) =>
    setOverLink(onOpenLink !== undefined && renderer.getLinkIdAt(event.x, event.y) !== 0);

  return (
    <box
      {...props}
      // Mouse events bubble up from the text inside, like in the DOM. Moving
      // from one text to the next fires "out" then "over"; both land in one render.
      onMouseOver={check}
      onMouseMove={check}
      onMouseOut={() => setOverLink(false)}
      onMouseDown={(event) => {
        pressedLink.current = renderer.getLinkAt(event.x, event.y);
      }}
      onMouseUp={(event) => {
        const pressed = pressedLink.current;
        pressedLink.current = null;
        if (!onOpenLink || !pressed || !isPlainClick(renderer, event)) return;
        if (performance.now() - focusedAt.current < FOCUS_CLICK_MS) return;
        if (renderer.getLinkAt(event.x, event.y) === pressed) onOpenLink(pressed);
      }}
    >
      {children}
    </box>
  );
}
