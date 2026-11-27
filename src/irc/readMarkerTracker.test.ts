import { describe, expect, test } from "bun:test";
import {
  MARK_READ_DELAY_MS,
  PRESENT_AFTER_INPUT_MS,
  ReadMarkerTracker,
} from "./readMarker.ts";
import { fakeClock } from "../fakeClock.ts";
import type { ActiveBuffer } from "../types.ts";
import type { Casemapping } from "./names.ts";

const DELAY = MARK_READ_DELAY_MS;

/**
 * A tracker with one server, "libera". `newest` is the newest line's time per buffer,
 * which a test moves forward to stand for a new line. `sent` collects each MARKREAD.
 * `read` collects each buffer that counts as read, in order.
 * `casemappings` sets a server's casemapping; a server not in it uses rfc1459.
 */
function setup() {
  const casemappings = new Map<string, Casemapping>();
  const clock = fakeClock(1_000_000);
  let onScreen: ActiveBuffer | null = null;
  const newest = new Map<string, number>([
    ["#honk", 100],
    ["#bun", 200],
  ]);
  const sent: [string, string, number][] = [];
  const read: string[] = [];
  const markers = new ReadMarkerTracker(
    {
      onScreen: () => onScreen,
      newestTime: (_serverId, buffer) => newest.get(buffer),
      send: (serverId, buffer, time) => sent.push([serverId, buffer, time]),
      casemapping: (serverId) => casemappings.get(serverId) ?? "rfc1459",
      markedRead: (_serverId, buffer) => read.push(buffer),
    },
    { delayMs: DELAY, clock },
  );
  /** Switches the buffer on screen, as IrcManager.setActive does. */
  const show = (buffer: string) => {
    const leaving = onScreen;
    onScreen = { serverId: "libera", buffer };
    markers.onActiveChanged(leaving);
  };
  /** A new line in `buffer` while it is on screen. */
  const line = (buffer: string, time: number) => {
    newest.set(buffer, time);
    markers.onNewLine();
  };
  return {
    markers,
    read,
    advance: clock.advance,
    active: clock.active,
    show,
    line,
    sent,
    newest,
    casemappings,
  };
}

describe("ReadMarkerTracker", () => {
  test("a burst of lines sends one MARKREAD per delay", () => {
    const { markers, advance, show, line, sent } = setup();
    markers.setFocused(true);
    show("#honk");
    advance(DELAY);
    expect(sent).toEqual([["libera", "#honk", 100]]);

    line("#honk", 101);
    advance(300);
    line("#honk", 102);
    advance(300);
    line("#honk", 103);
    expect(sent.length).toBe(1);
    advance(400);
    expect(sent).toEqual([
      ["libera", "#honk", 100],
      ["libera", "#honk", 103],
    ]);
  });

  test("leaving a buffer after the delay sends at once", () => {
    const { markers, advance, show, line, sent } = setup();
    markers.setFocused(true);
    show("#honk");
    advance(DELAY);
    line("#honk", 150);
    advance(DELAY / 2);
    show("#bun");
    expect(sent).toEqual([
      ["libera", "#honk", 100],
      ["libera", "#honk", 150],
    ]);
  });

  test("a buffer counts as read when its MARKREAD would go out, even if none can", () => {
    const { markers, advance, show, newest, read, sent } = setup();
    markers.setFocused(true);
    newest.delete("#honk");
    show("#honk");
    advance(DELAY - 1);
    expect(read).toEqual([]);
    advance(1);
    expect(read).toEqual(["#honk"]);
    expect(sent).toEqual([]);
  });

  test("a buffer you flipped past, or did not read, does not count as read", () => {
    const { markers, advance, show, read } = setup();
    markers.setFocused(true);
    show("#honk");
    advance(DELAY);
    show("#bun");
    advance(DELAY / 2);
    show("#honk");
    markers.setFocused(false);
    advance(DELAY * 3);
    show("#bun");
    advance(DELAY * 3);
    expect(read.filter((buffer) => buffer === "#bun")).toEqual([]);
  });

  test("leaving a buffer you read for the delay counts it as read at once", () => {
    const { markers, advance, show, read } = setup();
    markers.setFocused(true);
    show("#honk");
    advance(DELAY);
    show("#bun");
    expect(read).toEqual(["#honk", "#honk"]);
  });

  test("flipping past a buffer (less than the delay) sends nothing for it", () => {
    const { markers, advance, show, sent } = setup();
    markers.setFocused(true);
    show("#honk");
    advance(DELAY);
    show("#bun");
    advance(DELAY / 2);
    show("#honk");
    advance(DELAY * 3);
    expect(sent.filter(([, buffer]) => buffer === "#bun")).toEqual([]);
  });

  test("without focus nothing is sent, and focus coming back sends", () => {
    const { markers, advance, show, sent } = setup();
    markers.setFocused(false);
    show("#honk");
    advance(DELAY * 3);
    expect(sent).toEqual([]);

    markers.setFocused(true);
    advance(DELAY);
    expect(sent).toEqual([["libera", "#honk", 100]]);
  });

  test("coming back and switching at once does not mark the lines that came while away", () => {
    const { markers, advance, show, line, sent } = setup();
    markers.setFocused(true);
    show("#bun");
    advance(DELAY * 2);
    markers.setFocused(false);
    line("#bun", 300);
    advance(DELAY * 3);
    markers.setFocused(true);
    advance(DELAY / 2);
    show("#honk");
    expect(sent).toEqual([["libera", "#bun", 200]]);
  });

  test("coming back, the buffer on screen is marked only after a full delay", () => {
    const { markers, advance, show, line, sent } = setup();
    markers.setFocused(true);
    show("#bun");
    advance(DELAY * 2);
    markers.setFocused(false);
    line("#bun", 300);
    advance(DELAY / 2);
    markers.setFocused(true);
    // The timer the line set while you were away would fire here.
    advance(DELAY / 2);
    expect(sent).toEqual([["libera", "#bun", 200]]);
    advance(DELAY / 2);
    expect(sent).toEqual([
      ["libera", "#bun", 200],
      ["libera", "#bun", 300],
    ]);

    line("#bun", 301);
    show("#honk");
    expect(sent.at(-1)).toEqual(["libera", "#bun", 301]);
  });

  test("a focus event while already focused does not restart the time", () => {
    const { markers, advance, show, line, sent } = setup();
    markers.setFocused(true);
    show("#bun");
    advance(DELAY * 2);
    line("#bun", 300);
    markers.setFocused(true);
    show("#honk");
    expect(sent).toEqual([
      ["libera", "#bun", 200],
      ["libera", "#bun", 300],
    ]);
  });

  test("with focus unknown, input after a time away and a switch at once marks nothing", () => {
    const { markers, advance, show, line, sent } = setup();
    markers.noteInput();
    show("#bun");
    advance(DELAY * 2);
    advance(PRESENT_AFTER_INPUT_MS);
    line("#bun", 300);
    markers.noteInput();
    show("#honk");
    expect(sent).toEqual([["libera", "#bun", 200]]);
  });

  test("with focus unknown, input while reading does not restart the time", () => {
    const { markers, advance, show, line, sent } = setup();
    markers.noteInput();
    show("#bun");
    advance(DELAY * 2);
    line("#bun", 300);
    markers.noteInput();
    show("#honk");
    expect(sent).toEqual([
      ["libera", "#bun", 200],
      ["libera", "#bun", 300],
    ]);
  });

  test("a focused window with no input for 2 minutes does not count as reading", () => {
    const { markers, advance, show, line, sent } = setup();
    markers.setFocused(true);
    show("#honk");
    advance(DELAY);
    expect(sent).toEqual([["libera", "#honk", 100]]);

    advance(PRESENT_AFTER_INPUT_MS);
    line("#honk", 101);
    advance(DELAY * 3);
    expect(sent.length).toBe(1);

    // Input brings you back; the wait starts over.
    markers.noteInput();
    advance(DELAY - 1);
    expect(sent.length).toBe(1);
    advance(1);
    expect(sent.at(-1)).toEqual(["libera", "#honk", 101]);
  });

  test("focus coming back counts as input", () => {
    const { markers, advance, show, line, sent } = setup();
    markers.setFocused(true);
    show("#honk");
    advance(DELAY);
    markers.setFocused(false);
    advance(PRESENT_AFTER_INPUT_MS * 2);
    line("#honk", 101);
    markers.setFocused(true);
    advance(DELAY);
    expect(sent.at(-1)).toEqual(["libera", "#honk", 101]);
  });

  test("with focus unknown, input in the last 2 minutes counts as reading", () => {
    const { markers, advance, show, line, sent } = setup();
    show("#honk");
    advance(DELAY * 3);
    expect(sent).toEqual([]);

    markers.noteInput();
    advance(DELAY);
    expect(sent).toEqual([["libera", "#honk", 100]]);

    advance(PRESENT_AFTER_INPUT_MS);
    line("#honk", 101);
    advance(DELAY);
    expect(sent.length).toBe(1);
  });

  test("a marker at or before the known or sent one is not sent again", () => {
    const { markers, advance, show, line, sent } = setup();
    markers.setFocused(true);
    markers.onServerMarker("libera", "#honk", 100);
    show("#honk");
    advance(DELAY);
    expect(sent).toEqual([]);

    line("#honk", 120);
    advance(DELAY);
    line("#honk", 120);
    advance(DELAY);
    expect(sent).toEqual([["libera", "#honk", 120]]);
  });

  test("onConnected makes a lost marker go out again", () => {
    const { markers, advance, show, line, sent } = setup();
    markers.setFocused(true);
    show("#honk");
    advance(DELAY);
    markers.onConnected("libera");
    line("#honk", 100);
    advance(DELAY);
    expect(sent).toEqual([
      ["libera", "#honk", 100],
      ["libera", "#honk", 100],
    ]);
  });

  test("onServerMarker says whether the marker moved forward, by name as the server folds it", () => {
    const { markers } = setup();
    expect(markers.onServerMarker("libera", "#Honk[", 100)).toBe(true);
    expect(markers.onServerMarker("libera", "#honk{", 100)).toBe(false);
    expect(markers.onServerMarker("libera", "#honk{", 90)).toBe(false);
    expect(markers.serverMarker("libera", "#HONK[")).toBe(100);
    expect(markers.serverMarker("other", "#honk[")).toBeUndefined();
  });

  test("on an ascii server, #honk[ and #honk{ have their own markers", () => {
    const { markers, casemappings } = setup();
    casemappings.set("libera", "ascii");
    expect(markers.onServerMarker("libera", "#Honk[", 100)).toBe(true);
    expect(markers.serverMarker("libera", "#honk[")).toBe(100);
    expect(markers.serverMarker("libera", "#honk{")).toBeUndefined();
  });

  test("a marker the server said under another spelling is not sent again", () => {
    const { markers, advance, show, sent, newest } = setup();
    markers.setFocused(true);
    newest.set("#HONK[", 100);
    markers.onServerMarker("libera", "#honk{", 100);
    show("#HONK[");
    advance(DELAY);
    expect(sent).toEqual([]);
  });

  test("a buffer that cannot be marked sends nothing", () => {
    const { markers, advance, show, newest, sent } = setup();
    markers.setFocused(true);
    newest.delete("#honk");
    show("#honk");
    advance(DELAY);
    expect(sent).toEqual([]);
  });

  test("forget drops a server's markers", () => {
    const { markers } = setup();
    markers.onServerMarker("libera", "#honk", 100);
    markers.forget("libera");
    expect(markers.serverMarker("libera", "#honk")).toBeUndefined();
  });

  test("stop cancels the timer", () => {
    const { markers, active, advance, show, sent } = setup();
    markers.setFocused(true);
    show("#honk");
    markers.stop();
    expect(active()).toBe(0);
    advance(DELAY);
    expect(sent).toEqual([]);
  });
});
