import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClock } from "../fakeClock.ts";
import {
  FILL_LIMIT,
  LATEST_LIMIT,
  LogSync,
  MARK_EVERY_MS,
  MAX_FILL_PAGES,
  PAGE_OVERLAP_MS,
  SETTLE_MS,
  SYNC_FUZZ_MS,
} from "./logSync.ts";
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

/** A full batch: as many Lines as honk asked for, at these server times. */
const full = (...times: number[]) => ({ times, lines: LATEST_LIMIT });
/** A full page of a fill: as many Lines as a fill asks for. */
const fullPage = (...times: number[]) => ({ times, lines: FILL_LIMIT });
/** A batch with fewer Lines than honk asked for. */
const short = (...times: number[]) => ({ times, lines: times.length });

/** Moves the clock, and a live Line arrives with the same server time. */
function wait(ms: number) {
  clock.advance(ms);
  serverTime = clock.now();
}

test("a Network without a marker gets one once the joins have settled", () => {
  sync.start("libera");
  sync.askedLatest("libera", "#honk");
  expect(sync.batchEnded("libera", "#honk", short(T - 60_000))).toEqual({ type: "done" });
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
  const first = sync.batchEnded("libera", "#honk", full(T - 600_000, T - 60_000));
  const request = { after: T - 3_600_000 - SYNC_FUZZ_MS, until: T - 600_000, pages: 1 };
  expect(first).toEqual({ type: "next", request });

  // The marker waits while the gap is open.
  wait(SETTLE_MS);
  sync.moveMarker("libera");
  expect(log.syncMarker("libera")).toBe(T - 3_600_000);

  // A full page: ask for the next one, from just before its newest line, so the rest of
  // that line's millisecond is not skipped.
  const second = sync.batchEnded("libera", "#honk", fullPage(T - 3_000_000, T - 2_000_000), request);
  const next = { after: T - 2_000_000 - PAGE_OVERLAP_MS, until: T - 600_000, pages: 2, newestBefore: T - 2_000_000 };
  expect(second).toEqual({ type: "next", request: next });

  // This page goes past the screen's oldest line: the gap is closed and the marker moves.
  expect(sync.batchEnded("libera", "#honk", fullPage(T - 700_000, T - 500_000), next)).toEqual({
    type: "done",
  });
  expect(log.syncMarker("libera")).toBe(T + SETTLE_MS);
});

test("no fill when the screen's History reaches back past the marker", () => {
  log.setSyncMarker("libera", T - 3_600_000);
  sync.start("libera");
  sync.askedLatest("libera", "#honk");
  expect(sync.batchEnded("libera", "#honk", full(T - 4_000_000, T - 10))).toEqual({ type: "done" });
  expect(sync.batchEnded("libera", "#quiet", short())).toEqual({ type: "done" });
});

test("a full batch whose oldest Line has the marker's time still asks for a fill", () => {
  // Lines in the same millisecond as the marker may come after it, and a full batch can
  // cut them off.
  const marker = T - 3_600_000;
  log.setSyncMarker("libera", marker);
  sync.start("libera");
  sync.askedLatest("libera", "#honk");
  expect(sync.batchEnded("libera", "#honk", full(marker, T - 10))).toEqual({
    type: "next",
    request: { after: marker - SYNC_FUZZ_MS, until: marker, pages: 1 },
  });
});

test("a full batch that starts in the marker's second asks for a fill, as with a store of whole seconds", () => {
  // soju's file store gives Lines whole seconds: one sent 0.2 s after the marker comes
  // back 0.7 s before it.
  const second = T - 3_600_000;
  const marker = second + 700;
  log.setSyncMarker("libera", marker);
  sync.start("libera");
  sync.askedLatest("libera", "#honk");
  expect(sync.batchEnded("libera", "#honk", full(second, second + 60_000)).type).toBe("next");
});

test("a batch with fewer Lines than honk asked for holds all since the marker: no fill", () => {
  // A quiet channel: the screen's batch holds only the last Line honk saw.
  const marker = T - 3_600_000;
  log.setSyncMarker("libera", marker);
  sync.start("libera");
  sync.askedLatest("libera", "#honk");
  expect(sync.batchEnded("libera", "#honk", short(marker))).toEqual({ type: "done" });
});

test("a fill gives up after MAX_FILL_PAGES pages, and the marker stays before the gap", () => {
  log.setSyncMarker("libera", T - 3_600_000);
  sync.start("libera");
  sync.askedLatest("libera", "#honk");
  sync.batchEnded("libera", "#honk", full(T - 60_000));
  const fill = { after: 0, until: T - 60_000, pages: MAX_FILL_PAGES };
  expect(sync.batchEnded("libera", "#honk", fullPage(T - 1_000_000), fill)).toEqual({ type: "gave-up" });
  wait(SETTLE_MS);
  sync.moveMarker("libera");
  sync.stop("libera");
  expect(log.syncMarker("libera")).toBe(T - 3_600_000);
});

test("an empty fill page ends the fill", () => {
  log.setSyncMarker("libera", T - 3_600_000);
  sync.start("libera");
  sync.askedLatest("libera", "#honk");
  const fill = { after: T - 3_605_000, until: T - 600_000, pages: 1 };
  expect(sync.batchEnded("libera", "#honk", short(), fill)).toEqual({ type: "done" });
});

test("a fill page that is short but does not reach the screen's batch asks for more", () => {
  // A server may cap its pages below FILL_LIMIT, so a short page is not the end.
  log.setSyncMarker("libera", T - 3_600_000);
  sync.start("libera");
  sync.askedLatest("libera", "#honk");
  const fill = { after: T - 3_605_000, until: T - 600_000, pages: 1 };
  expect(sync.batchEnded("libera", "#honk", short(T - 3_000_000), fill).type).toBe("next");
});

test("a fill page with lines but no server times gives up, and the marker stays", () => {
  log.setSyncMarker("libera", T - 3_600_000);
  sync.start("libera");
  sync.askedLatest("libera", "#honk");
  const fill = { after: T - 3_605_000, until: T - 600_000, pages: 1 };
  expect(sync.batchEnded("libera", "#honk", { times: [], lines: FILL_LIMIT }, fill)).toEqual({ type: "gave-up" });
});

test("a fill page that ends at the time of the screen's oldest Line asks for one more", () => {
  // The page may be cut inside that millisecond: Lines of it can be in neither batch.
  log.setSyncMarker("libera", T - 3_600_000);
  sync.start("libera");
  sync.askedLatest("libera", "#honk");
  const fill = { after: T - 3_605_000, until: T - 600_000, pages: 1 };
  expect(sync.batchEnded("libera", "#honk", fullPage(T - 3_000_000, T - 600_000), fill)).toEqual({
    type: "next",
    request: { after: T - 600_000 - PAGE_OVERLAP_MS, until: T - 600_000, pages: 2, newestBefore: T - 600_000 },
  });
});

test("a fill page with no Line newer than the page before goes on past that millisecond", () => {
  // More than FILL_LIMIT Lines in one millisecond: asking with the overlap brings the
  // same page, so the next one starts after it. Only that millisecond can lose Lines.
  log.setSyncMarker("libera", T - 3_600_000);
  sync.start("libera");
  sync.askedLatest("libera", "#honk");
  const fill = { after: T - 2_000_001, until: T - 600_000, pages: 2, newestBefore: T - 2_000_000 };
  expect(sync.batchEnded("libera", "#honk", fullPage(T - 2_000_000, T - 2_000_000), fill)).toEqual({
    type: "next",
    request: { after: T - 2_000_000, until: T - 600_000, pages: 3, newestBefore: T - 2_000_000 },
  });
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

  expect(sync.batchEnded("libera", "dave", full(T - 4_000_000, T - 10))).toEqual({ type: "done" });
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
