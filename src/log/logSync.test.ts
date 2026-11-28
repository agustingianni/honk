import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClock } from "../fakeClock.ts";
import { LogSync, MARK_EVERY_MS, MAX_FILL_PAGES, SETTLE_MS, SYNC_FUZZ_MS } from "./logSync.ts";
import { DEFAULT_LOG_SETTINGS, type Log, openLog } from "./log.ts";

const T = Date.parse("2026-11-27T21:00:00Z");
let dir: string;
let log: Log;
let clock: ReturnType<typeof fakeClock>;
/** The server time of the newest live Line. */
let serverTime: number | undefined;
let sync: LogSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "honk-sync-"));
  clock = fakeClock(T);
  log = openLog(join(dir, "logs.db"), DEFAULT_LOG_SETTINGS, { clock }).log!;
  serverTime = T;
  sync = new LogSync(log, () => serverTime, clock);
});

afterEach(() => {
  log.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Moves the clock, and a live Line arrives with the same server time. */
function wait(ms: number) {
  clock.advance(ms);
  serverTime = clock.now();
}

test("a Network without a marker gets one once the joins have settled", () => {
  sync.start("libera");
  sync.askedLatest("libera", "#honk");
  expect(sync.batchEnded("libera", "#honk", [T - 60_000])).toEqual({ type: "done" });
  sync.moveMarker("libera");
  expect(log.syncMarker("libera")).toBeUndefined();
  wait(SETTLE_MS);
  sync.moveMarker("libera");
  expect(log.syncMarker("libera")).toBe(T + SETTLE_MS);
});

test("the marker is the server time of the newest live Line, not honk's clock", () => {
  sync.start("libera");
  wait(SETTLE_MS);
  // honk's clock runs 7 minutes ahead of the server.
  serverTime = clock.now() - 7 * 60_000;
  sync.moveMarker("libera");
  expect(log.syncMarker("libera")).toBe(T + SETTLE_MS - 7 * 60_000);
});

test("no live Line yet: the marker does not move", () => {
  serverTime = undefined;
  sync.start("libera");
  clock.advance(SETTLE_MS);
  sync.moveMarker("libera");
  expect(log.syncMarker("libera")).toBeUndefined();
});

test("after a gap, honk asks for the History between the marker and the screen's lines", () => {
  log.setSyncMarker("libera", T - 3_600_000);
  sync.start("libera");
  sync.askedLatest("libera", "#honk");
  const first = sync.batchEnded("libera", "#honk", [T - 600_000, T - 60_000]);
  const request = { after: T - 3_600_000 - SYNC_FUZZ_MS, until: T - 600_000, pages: 1 };
  expect(first).toEqual({ type: "next", request });

  // The marker waits while the gap is open.
  wait(SETTLE_MS);
  sync.moveMarker("libera");
  expect(log.syncMarker("libera")).toBe(T - 3_600_000);

  // A full page: ask for the next one, after its newest line.
  const second = sync.batchEnded("libera", "#honk", [T - 3_000_000, T - 2_000_000], request);
  const next = { after: T - 2_000_000, until: T - 600_000, pages: 2 };
  expect(second).toEqual({ type: "next", request: next });

  // This page reaches the screen's lines: the gap is closed and the marker moves.
  expect(sync.batchEnded("libera", "#honk", [T - 700_000, T - 600_000], next)).toEqual({
    type: "done",
  });
  expect(log.syncMarker("libera")).toBe(T + SETTLE_MS);
});

test("no fill when the screen's History reaches back past the marker", () => {
  log.setSyncMarker("libera", T - 3_600_000);
  sync.start("libera");
  sync.askedLatest("libera", "#honk");
  expect(sync.batchEnded("libera", "#honk", [T - 4_000_000, T - 10])).toEqual({ type: "done" });
  expect(sync.batchEnded("libera", "#quiet", [])).toEqual({ type: "done" });
});

test("a batch whose oldest Line has the marker's time still leaves a gap", () => {
  // Lines in the same millisecond as the marker may come after it, and a full batch can
  // cut them off.
  const marker = T - 3_600_000;
  log.setSyncMarker("libera", marker);
  sync.start("libera");
  sync.askedLatest("libera", "#honk");
  expect(sync.batchEnded("libera", "#honk", [marker, T - 10])).toEqual({
    type: "next",
    request: { after: marker - SYNC_FUZZ_MS, until: marker, pages: 1 },
  });
});

test("a fill gives up after MAX_FILL_PAGES pages, and the marker stays before the gap", () => {
  log.setSyncMarker("libera", T - 3_600_000);
  sync.start("libera");
  sync.askedLatest("libera", "#honk");
  sync.batchEnded("libera", "#honk", [T - 60_000]);
  const fill = { after: 0, until: T - 60_000, pages: MAX_FILL_PAGES };
  expect(sync.batchEnded("libera", "#honk", [T - 1_000_000], fill)).toEqual({ type: "gave-up" });
  wait(SETTLE_MS);
  sync.moveMarker("libera");
  sync.stop("libera");
  expect(log.syncMarker("libera")).toBe(T - 3_600_000);
});

test("while connected, the marker moves at most every MARK_EVERY_MS, and at the end", () => {
  sync.start("libera");
  wait(SETTLE_MS);
  sync.moveMarker("libera");
  wait(1000);
  sync.moveMarker("libera");
  expect(log.syncMarker("libera")).toBe(T + SETTLE_MS);
  wait(MARK_EVERY_MS);
  sync.moveMarker("libera");
  expect(log.syncMarker("libera")).toBe(T + SETTLE_MS + 1000 + MARK_EVERY_MS);
  wait(3000);
  sync.stop("libera");
  expect(log.syncMarker("libera")).toBe(T + SETTLE_MS + 4000 + MARK_EVERY_MS);
});

test("a connection that never synced leaves the marker where it was", () => {
  log.setSyncMarker("libera", T - 1000);
  sync.start("libera");
  sync.askedLatest("libera", "#honk");
  wait(SETTLE_MS);
  sync.stop("libera");
  expect(log.syncMarker("libera")).toBe(T - 1000);
});

test("the marker waits for the reply to TARGETS, and then for the gap of each DM it names", () => {
  log.setSyncMarker("libera", T - 3_600_000);
  sync.start("libera");
  wait(SETTLE_MS - 1_000);
  sync.askedTargets("libera");
  wait(1_000);
  sync.moveMarker("libera");
  expect(log.syncMarker("libera")).toBe(T - 3_600_000);

  // The reply names dave.
  sync.answeredTargets("libera", ["dave"]);
  expect(log.syncMarker("libera")).toBe(T - 3_600_000);

  expect(sync.batchEnded("libera", "dave", [T - 4_000_000, T - 10])).toEqual({ type: "done" });
  expect(log.syncMarker("libera")).toBe(T + SETTLE_MS);
});

test("a reply to TARGETS that never comes holds the marker for SETTLE_MS only", () => {
  log.setSyncMarker("libera", T - 3_600_000);
  sync.start("libera");
  wait(SETTLE_MS - 1);
  sync.askedTargets("libera");
  wait(1);
  sync.moveMarker("libera");
  expect(log.syncMarker("libera")).toBe(T - 3_600_000);
  wait(SETTLE_MS);
  sync.moveMarker("libera");
  expect(log.syncMarker("libera")).toBe(T + 2 * SETTLE_MS);
});

test("a FAIL instead of a DM's History stops its gap holding the marker", () => {
  log.setSyncMarker("libera", T - 3_600_000);
  sync.start("libera");
  sync.askedLatest("libera", "nickserv");
  wait(SETTLE_MS);
  sync.moveMarker("libera");
  expect(log.syncMarker("libera")).toBe(T - 3_600_000);
  sync.historyFailed("libera", "nickserv");
  expect(log.syncMarker("libera")).toBe(T + SETTLE_MS);
});
