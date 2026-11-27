import type { Clock } from "./clock.ts";

/**
 * A clock for tests. Time stands still until the test calls `advance`, which moves it
 * forward and runs each timer that is due by then.
 *
 *   const clock = fakeClock();
 *   clock.setTimeout(() => console.log("fired"), 100);
 *   clock.advance(99);    // nothing
 *   clock.advance(1);     // "fired"
 */
export function fakeClock(start = 0): Clock & {
  advance(ms: number): void;
  /** How many timers are still waiting. */
  pending(): number;
} {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
    advance: (ms) => {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}
