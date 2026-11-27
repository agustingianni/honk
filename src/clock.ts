/**
 * The time now and timers, in one object, so a tracker can run on a fake clock in a
 * test (see fakeClock.ts) instead of on real time:
 *
 *   const clock = fakeClock();
 *   const tracker = new DeliveryTracker(callbacks, clock);
 *   clock.advance(DELIVERY_TIMEOUT_MS);   // the timeout fires, with no real wait
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real time: Date.now and the global timers. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
