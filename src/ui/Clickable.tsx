import type { CliRenderer, MouseEvent, MousePointerStyle, Selection, TextRenderable } from "@opentui/core";
import { useRenderer, type BoxProps } from "@opentui/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { indexAtCell } from "./display.ts";
import type { TextRange } from "./format.tsx";
import { nameAt, type NameInText } from "./nameAt.ts";

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
 * True for a selection that never moved from where the mouse went down. A press
 * on text always starts a selection, so a plain click leaves one too: still at
 * its start, in "cell" mode, with no text.
 */
export function isUnmovedSelection(selection: Selection): boolean {
  return selection.isStart && selection.behavior === "cell";
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
  return selection !== null && isUnmovedSelection(selection);
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
/** How long a click on a link waits for a second click, which makes it a double-click. */
const DOUBLE_CLICK_MS = 250;

// When each renderer's window last got focus. One listener per renderer, not
// one per message row: a long scrollback has thousands of rows.
const focusedAtByRenderer = new WeakMap<CliRenderer, { at: number }>();

/** Starts tracking when the window gets focus. Call it while rendering, before any click. */
function trackFocus(renderer: CliRenderer): { at: number } {
  let focused = focusedAtByRenderer.get(renderer);
  if (!focused) {
    // Never, until it does.
    const state = { at: Number.NEGATIVE_INFINITY };
    renderer.on("focus", () => {
      state.at = performance.now();
    });
    focusedAtByRenderer.set(renderer, state);
    focused = state;
  }
  return focused;
}

/**
 * True when the terminal window got focus less than FOCUS_CLICK_MS ago: some
 * terminals pass the click that focuses the window on to honk, and it should
 * not open anything.
 */
function justFocused(renderer: CliRenderer): boolean {
  return performance.now() - trackFocus(renderer).at < FOCUS_CLICK_MS;
}

/**
 * Runs an open `delayMs` after a click, unless a second press comes first:
 * then the click was the first half of a double-click, which people use to
 * select a word, often to look at it before they trust it. Nothing runs after
 * the component is gone.
 */
function useOpenAfterClick(delayMs: number): { later: (open: () => void) => void; cancel: () => void } {
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useCallback(() => {
    clearTimeout(pending.current);
    pending.current = undefined;
  }, []);
  useEffect(() => cancel, [cancel]);
  const later = (open: () => void) => {
    cancel();
    pending.current = setTimeout(() => {
      pending.current = undefined;
      open();
    }, delayMs);
  };
  return { later, cancel };
}

type LinkAreaProps = Omit<
  BoxProps,
  "onMouseOver" | "onMouseOut" | "onMouseMove" | "onMouseDown" | "onMouseUp"
> & {
  /** Opens a link. Without it (over SSH), links get no hand pointer and a click is left to the terminal. */
  onOpenLink: ((href: string) => void) | undefined;
  /** How long a click waits for a second one. The tests make it short. */
  doubleClickMs?: number;
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
 * - It is not the first half of a double-click. People double-click a link to
 *   select it, often to look at it before they trust it. So a click waits
 *   DOUBLE_CLICK_MS, and a second press in that time cancels the open.
 *
 * The pointer is checked only when the mouse moves. After a wheel scroll or a
 * new line under a still mouse, it is updated on the next move.
 */
export function LinkArea({
  onOpenLink,
  doubleClickMs = DOUBLE_CLICK_MS,
  children,
  ...props
}: LinkAreaProps) {
  const renderer = useRenderer();
  const [overLink, setOverLink] = useState(false);
  usePointer(overLink, setOverLink);

  // The link under the mouse when the button went down.
  const pressedLink = useRef<string | null>(null);
  const open = useOpenAfterClick(doubleClickMs);
  trackFocus(renderer);

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
        open.cancel();
        pressedLink.current = renderer.getLinkAt(event.x, event.y);
      }}
      onMouseUp={(event) => {
        const pressed = pressedLink.current;
        pressedLink.current = null;
        if (!onOpenLink || !pressed || !isPlainClick(renderer, event)) return;
        if (justFocused(renderer)) return;
        if (renderer.getLinkAt(event.x, event.y) === pressed) open.later(() => onOpenLink(pressed));
      }}
    >
      {children}
    </box>
  );
}

/** What a click on a name in the chat does. */
export interface NameActions {
  /** The nick of someone in the channel (other than you) that `word` names, as the user list spells it. */
  findNick: (word: string) => string | undefined;
  /** Opens a DM with `nick`. */
  openNick: (nick: string) => void;
  /** Joins `channel`, or switches to it when honk is in it already. */
  openChannel: (channel: string) => void;
}

/**
 * The name at cell (x, y) of `text`, a single line of chat, if there is one.
 * OpenTUI wraps the line, and its `lineInfo` tells the column where each
 * screen row starts, so honk does not do the wrapping math again. A cell
 * inside a link has no name: the link opens there.
 */
function nameAtCell(
  renderer: CliRenderer,
  text: TextRenderable,
  x: number,
  y: number,
  findNick: (word: string) => string | undefined,
  namesEnd: number,
): NameInText | undefined {
  if (renderer.getLinkIdAt(x, y) !== 0) return undefined;
  const info = text.lineInfo;
  const row = y - text.y + text.scrollY;
  const col = x - text.x;
  const start = info.lineStartCols[row];
  if (start === undefined || col < 0 || col >= info.lineWidthCols[row]!) return undefined;
  const line = text.plainText.slice(0, namesEnd);
  return nameAt(line, indexAtCell(line, start + col), findNick);
}

type NameTextProps = {
  names: NameActions;
  /** Where the message ends in the text. Names stop there: " (not sent)" may follow. */
  namesEnd: number;
  /** The text's content, with the name under the mouse (if any) to underline. */
  children: (hovered: TextRange | undefined) => ReactNode;
  /** How long a click waits for a second one. The tests make it short. */
  doubleClickMs?: number;
  /** Also gets the text renderable, as a `ref` would. */
  textRef?: (text: TextRenderable | null) => void;
};

/**
 * A line of chat whose nicks and channel names work like links: under the
 * mouse a name is underlined and the pointer is a hand, and a plain click
 * opens a DM with the nick or joins the channel. The text is drawn as usual,
 * not as terminal links, so the terminal's own Cmd+click never sees them.
 *
 * Names come from other people's messages, so a click guards like LinkArea:
 * the same name must be under the mouse at press and at release, a click that
 * may have focused the window opens nothing, and a double-click (to select the
 * name) opens nothing. As with LinkArea, the hover is checked only when the
 * mouse moves.
 */
export function NameText({
  names,
  namesEnd,
  children,
  doubleClickMs = DOUBLE_CLICK_MS,
  textRef,
}: NameTextProps) {
  const renderer = useRenderer();
  const ref = useRef<TextRenderable | null>(null);
  const setRef = useCallback(
    (text: TextRenderable | null) => {
      ref.current = text;
      textRef?.(text);
    },
    [textRef],
  );
  const [hovered, setHovered] = useState<TextRange | undefined>(undefined);
  const clear = useCallback(() => setHovered(undefined), []);
  usePointer(hovered !== undefined, clear);
  // The name under the mouse when the button went down.
  const pressed = useRef<NameInText | undefined>(undefined);
  const open = useOpenAfterClick(doubleClickMs);
  trackFocus(renderer);

  const at = (event: MouseEvent) =>
    ref.current
      ? nameAtCell(renderer, ref.current, event.x, event.y, names.findNick, namesEnd)
      : undefined;
  const check = (event: MouseEvent) => {
    const name = at(event);
    setHovered((prev) => (prev?.start === name?.start && prev?.end === name?.end ? prev : name));
  };

  return (
    <text
      ref={setRef}
      onMouseOver={check}
      onMouseMove={check}
      onMouseOut={clear}
      onMouseDown={(event) => {
        open.cancel();
        pressed.current = at(event);
      }}
      onMouseUp={(event) => {
        const before = pressed.current;
        pressed.current = undefined;
        if (!before || !isPlainClick(renderer, event) || justFocused(renderer)) return;
        const name = at(event);
        if (name?.start !== before.start || name.name !== before.name) return;
        open.later(() =>
          name.kind === "nick" ? names.openNick(name.name) : names.openChannel(name.name),
        );
      }}
    >
      {children(hovered)}
    </text>
  );
}
