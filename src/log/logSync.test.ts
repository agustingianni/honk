import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClock } from "../fakeClock.ts";
import { LogSync, MARK_EVERY_MS, MAX_FILL_PAGES, SETTLE_MS, SYNC_FUZZ_MS } from "./logSync.ts";
import { DEFAULT_LOG_SETTINGS, type MessageLog, openLog } from "./messageLog.ts";

const T = Date.parse("2026-11-27T21:00:00Z");
let dir: string;
let log: MessageLog;
let clock: ReturnType<typeof fakeClock>;
let heard: number | undefined;
let sync: LogSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "honk-sync-"));
  clock = fakeClock(T);
  log = openLog(join(dir, "logs.db"), DEFAULT_LOG_SETTINGS, { clock }).log!;
  heard = T;
  sync = new LogSync(log, () => heard, clock);
});

afterEach(() => {
  log.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Moves the clock, and the last line heard with it. */
function wait(ms: number) {
  clock.advance(ms);
  heard = clock.now();
}

test("a Network without a marker gets one once the joins have settled", () => {
  sync.start("libera");
  sync.joined("libera", "#honk");
  expect(sync.batchEnded("libera", "#honk", [T - 60_000])).toBeUndefined();
  sync.check("libera");
  expect(log.syncMarker("libera")).toBeUndefined();
  wait(SETTLE_MS);
  sync.check("libera");
  expect(log.syncMarker("libera")).toBe(T + SETTLE_MS);
});

test("the marker follows the last line heard, not the clock", () => {
  sync.start("libera");
  wait(SETTLE_MS);
  clock.advance(60_000); // the connection is dead, but honk does not know yet
  sync.check("libera");
  expect(log.syncMarker("libera")).toBe(T + SETTLE_MS);
});

test("after a gap, honk asks for the History between the marker and the screen's lines", () => {
  log.setSyncMarker("libera", T - 3_600_000);
  sync.start("libera");
  sync.joined("libera", "#honk");
  const first = sync.batchEnded("libera", "#honk", [T - 600_000, T - 60_000]);
  expect(first).toEqual({ after: T - 3_600_000 - SYNC_FUZZ_MS, until: T - 600_000, pages: 1 });
  sync.fillSent("libera", { target: "#honk", until: first!.until, pages: 1 });

  // The marker waits while the gap is open.
  wait(SETTLE_MS);
  sync.check("libera");
  expect(log.syncMarker("libera")).toBe(T - 3_600_000);

  // A full page: ask for the next one, after its newest line.
  const fill = sync.takeFill("libera", undefined, "#honk")!;
  const second = sync.batchEnded("libera", "#honk", [T - 3_000_000, T - 2_000_000], fill);
  expect(second).toEqual({ after: T - 2_000_000, until: T - 600_000, pages: 2 });
  sync.fillSent("libera", { target: "#honk", until: second!.until, pages: 2 });

  // This page reaches the screen's lines: the gap is closed and the marker moves.
  const last = sync.takeFill("libera", undefined, "#honk")!;
  expect(sync.batchEnded("libera", "#honk", [T - 700_000, T - 600_000], last)).toBeUndefined();
  expect(log.syncMarker("libera")).toBe(T + SETTLE_MS);
});

test("no fill when the screen's History reaches back past the marker", () => {
  log.setSyncMarker("libera", T - 3_600_000);
  sync.start("libera");
  sync.joined("libera", "#honk");
  expect(sync.batchEnded("libera", "#honk", [T - 4_000_000, T - 10])).toBeUndefined();
  expect(sync.batchEnded("libera", "#quiet", [])).toBeUndefined();
});

test("a fill stops after MAX_FILL_PAGES pages", () => {
  const fill = { target: "#honk", until: T, pages: MAX_FILL_PAGES };
  sync.start("libera");
  expect(sync.batchEnded("libera", "#honk", [T - 10_000], fill)).toBeUndefined();
});

test("a labeled batch takes the fill with its label, an unlabeled one the fill for its target", () => {
  sync.start("libera");
  sync.fillSent("libera", { target: "#a", label: "L1", until: T, pages: 1 });
  sync.fillSent("libera", { target: "#b", until: T, pages: 1 });
  expect(sync.takeFill("libera", "L2", "#a")).toBeUndefined();
  expect(sync.takeFill("libera", undefined, "#a")).toBeUndefined();
  expect(sync.takeFill("libera", "L1", "#a")?.label).toBe("L1");
  expect(sync.takeFill("libera", undefined, "#b")?.target).toBe("#b");
});

test("while connected, the marker moves at most every MARK_EVERY_MS, and at the end", () => {
  sync.start("libera");
  wait(SETTLE_MS);
  sync.check("libera");
  wait(1000);
  sync.check("libera");
  expect(log.syncMarker("libera")).toBe(T + SETTLE_MS);
  wait(MARK_EVERY_MS);
  sync.check("libera");
  expect(log.syncMarker("libera")).toBe(T + SETTLE_MS + 1000 + MARK_EVERY_MS);
  wait(3000);
  sync.stop("libera");
  expect(log.syncMarker("libera")).toBe(T + SETTLE_MS + 4000 + MARK_EVERY_MS);
});

test("a connection that never synced leaves the marker where it was", () => {
  log.setSyncMarker("libera", T - 1000);
  sync.start("libera");
  sync.joined("libera", "#honk");
  wait(SETTLE_MS);
  sync.stop("libera");
  expect(log.syncMarker("libera")).toBe(T - 1000);
});
