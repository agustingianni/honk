import { describe, expect, test } from "bun:test";
import {
  MARK_READ_DELAY_MS,
  PRESENT_AFTER_KEY_MS,
  ReadMarkerTracker,
} from "./readMarker.ts";
import { fakeClock } from "../fakeClock.ts";
import type { ActiveBuffer } from "../types.ts";
import type { Casemapping } from "./names.ts";

const DELAY = MARK_READ_DELAY_MS;

/**
 * A tracker with one server, "libera". `newest` is the newest line's time per buffer,
 * which a test moves forward to stand for a new line. `sent` collects each MARKREAD.
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
  const markers = new ReadMarkerTracker(
    {
      onScreen: () => onScreen,
      newestTime: (_serverId, buffer) => newest.get(buffer),
      send: (serverId, buffer, time) => sent.push([serverId, buffer, time]),
      casemapping: (serverId) => casemappings.get(serverId) ?? "rfc1459",
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
