import { describe, expect, test } from "bun:test";
import {
  MARK_READ_DELAY_MS,
  PRESENT_AFTER_KEY_MS,
  ReadMarkerTracker,
  type Clock,
} from "./readMarker.ts";
import type { ActiveBuffer } from "../types.ts";

const DELAY = MARK_READ_DELAY_MS;

/** A clock whose timers only fire when the test advances it. */
function fakeClock() {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  return { clock, advance, active: () => timers.size };
}

/**
 * A tracker with one server, "libera". `newest` is the newest line's time per buffer,
 * which a test moves forward to stand for a new line. `sent` collects each MARKREAD.
 */
function setup() {
  const { clock, advance, active } = fakeClock();
  let onScreen: ActiveBuffer | null = null;
  const newest = new Map<string, number>([
    ["#honk", 100],
    ["#bun", 200],
  ]);
  const sent: [string, string, number][] = [];
  const markers = new ReadMarkerTracker(
    {
      onScreen: () => onScreen,
      newestTime: (_serverId, buffer) => newest.get(buffer),
      send: (serverId, buffer, time) => sent.push([serverId, buffer, time]),
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
  return { markers, advance, active, show, line, sent, newest };
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

  test("with focus unknown, a key press in the last 2 minutes counts as reading", () => {
    const { markers, advance, show, line, sent } = setup();
    show("#honk");
    advance(DELAY * 3);
    expect(sent).toEqual([]);

    markers.noteKeyPress();
    advance(DELAY);
    expect(sent).toEqual([["libera", "#honk", 100]]);

    advance(PRESENT_AFTER_KEY_MS);
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

  test("onServerMarker says whether the marker moved forward, by name in any case", () => {
    const { markers } = setup();
    expect(markers.onServerMarker("libera", "#Honk", 100)).toBe(true);
    expect(markers.onServerMarker("libera", "#honk", 100)).toBe(false);
    expect(markers.onServerMarker("libera", "#honk", 90)).toBe(false);
    expect(markers.serverMarker("libera", "#HONK")).toBe(100);
    expect(markers.serverMarker("other", "#honk")).toBeUndefined();
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
