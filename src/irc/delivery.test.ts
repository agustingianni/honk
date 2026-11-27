import { describe, expect, test } from "bun:test";
import { DELIVERY_TIMEOUT_MS, DeliveryTracker, type SentLine } from "./delivery.ts";
import { fakeClock } from "../fakeClock.ts";

function setup() {
  const timers = fakeClock();
  const delivered: [string, SentLine[]][] = [];
  const timedOut: [string, SentLine[]][] = [];
  const pings: string[] = [];
  const tracker = new DeliveryTracker(
    {
      delivered: (s, lines) => delivered.push([s, lines]),
      timedOut: (s, lines) => timedOut.push([s, lines]),
    },
    timers,
  );
  const send = (serverId: string, messageId: string, bufferName = "#honk") =>
    tracker.track(serverId, { bufferName, messageId }, (token) => pings.push(token));
  return { tracker, timers, delivered, timedOut, pings, send };
}

const line = (messageId: string, bufferName = "#honk"): SentLine => ({ bufferName, messageId });

describe("DeliveryTracker", () => {
  test("sends a PING with its own token after each line", () => {
    const { pings, send } = setup();
    send("libera", "1");
    send("libera", "2");
    expect(pings).toEqual(["honk-1", "honk-2"]);
  });

  test("a PONG confirms its line", () => {
    const { tracker, delivered, timers, send } = setup();
    send("libera", "1");
    tracker.pong("libera", "honk-1");
    expect(delivered).toEqual([["libera", [line("1")]]]);
    expect(timers.active()).toBe(0);
  });

  test("a PONG also confirms every line sent before it", () => {
    const { tracker, delivered, send } = setup();
    send("libera", "1");
    send("libera", "2", "alice");
    send("libera", "3");
    tracker.pong("libera", "honk-2");
    expect(delivered).toEqual([["libera", [line("1"), line("2", "alice")]]]);
    tracker.pong("libera", "honk-3");
    expect(delivered[1]).toEqual(["libera", [line("3")]]);
  });

  test("ignores PONGs that are not ours, and repeated PONGs", () => {
    const { tracker, delivered, send } = setup();
    send("libera", "1");
    tracker.pong("libera", "1732650000000"); // the library's keepalive
    tracker.pong("libera", undefined);
    tracker.pong("libera", "honk-x");
    expect(delivered).toEqual([]);
    tracker.pong("libera", "honk-1");
    tracker.pong("libera", "honk-1");
    expect(delivered.length).toBe(1);
  });

  test("with no PONG in time, every waiting line on that server times out", () => {
    const { tracker, timedOut, timers, send } = setup();
    send("libera", "1");
    timers.advance(5_000);
    send("libera", "2");
    send("oftc", "3");
    timers.advance(DELIVERY_TIMEOUT_MS - 5_000 - 1);
    expect(timedOut).toEqual([]);
    timers.advance(1);
    expect(timedOut).toEqual([["libera", [line("1"), line("2")]]]);
    // The other server is still waiting, and its PONG still counts.
    tracker.pong("oftc", "honk-3");
    expect(timedOut.length).toBe(1);
  });

  test("a PONG in time stops the timeout", () => {
    const { tracker, timedOut, timers, send } = setup();
    send("libera", "1");
    timers.advance(DELIVERY_TIMEOUT_MS - 1);
    tracker.pong("libera", "honk-1");
    timers.advance(DELIVERY_TIMEOUT_MS);
    expect(timedOut).toEqual([]);
  });

  test("a probe with no PONG times out with no lines", () => {
    const { tracker, timedOut, timers, pings } = setup();
    tracker.probe("libera", (token) => pings.push(token));
    expect(pings).toEqual(["honk-1"]);
    timers.advance(DELIVERY_TIMEOUT_MS);
    expect(timedOut).toEqual([["libera", []]]);
  });

  test("a probe's PONG confirms earlier lines but reports no line of its own", () => {
    const { tracker, delivered, timedOut, timers, pings, send } = setup();
    send("libera", "1");
    tracker.probe("libera", (token) => pings.push(token));
    tracker.pong("libera", "honk-2");
    expect(delivered).toEqual([["libera", [line("1")]]]);
    // A probe alone is confirmed quietly.
    tracker.probe("libera", (token) => pings.push(token));
    tracker.pong("libera", "honk-3");
    expect(delivered.length).toBe(1);
    timers.advance(DELIVERY_TIMEOUT_MS);
    expect(timedOut).toEqual([]);
  });

  test("drop returns the waiting lines and cancels their timers", () => {
    const { tracker, timedOut, timers, send } = setup();
    send("libera", "1");
    send("libera", "2");
    expect(tracker.drop("libera")).toEqual([line("1"), line("2")]);
    expect(tracker.drop("libera")).toEqual([]);
    timers.advance(DELIVERY_TIMEOUT_MS);
    expect(timedOut).toEqual([]);
    expect(timers.active()).toBe(0);
  });

  test("reject takes the oldest waiting line to that buffer, and its PONG no longer confirms it", () => {
    const { tracker, delivered, send } = setup();
    send("libera", "1", "#quiet");
    send("libera", "2", "#honk");
    send("libera", "3", "#quiet");
    expect(tracker.reject("libera", "#QUIET", "rfc1459")).toEqual(line("1", "#quiet"));
    tracker.pong("libera", "honk-3");
    expect(delivered).toEqual([["libera", [line("2"), line("3", "#quiet")]]]);
    expect(tracker.reject("libera", "#quiet", "rfc1459")).toBeUndefined();
  });
});
