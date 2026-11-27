import { expect, test } from "bun:test";
import { dayLabel, dayLabelBefore } from "./dayDivider.ts";

const NOW = new Date(2026, 10, 27, 15, 0);
const thursday = dayLabel(new Date(2026, 10, 26, 12, 0), NOW);
const friday = dayLabel(new Date(2026, 10, 27, 12, 0), NOW);

test("no divider between two messages on the same day", () => {
  const prev = new Date(2026, 10, 26, 0, 1);
  expect(dayLabelBefore(prev, new Date(2026, 10, 26, 23, 59), NOW)).toBeNull();
});

test("a divider between 23:59 and 00:01", () => {
  const prev = new Date(2026, 10, 26, 23, 59);
  expect(dayLabelBefore(prev, new Date(2026, 10, 27, 0, 1), NOW)).toBe(friday);
});

test("a divider above a first message from another day", () => {
  expect(dayLabelBefore(undefined, new Date(2026, 10, 26, 9, 14), NOW)).toBe(thursday);
});

test("no divider above a first message from today", () => {
  expect(dayLabelBefore(undefined, new Date(2026, 10, 27, 0, 0), NOW)).toBeNull();
});

test("the label names the weekday, month and day, and the year only for another year", () => {
  const sameYear = dayLabel(new Date(2026, 10, 26, 12, 0), NOW);
  expect(sameYear).toContain("Thursday");
  expect(sameYear).toContain("November");
  expect(sameYear).toContain("26");
  expect(sameYear).not.toContain("2026");

  const otherYear = dayLabel(new Date(2025, 11, 26, 12, 0), NOW);
  expect(otherYear).toContain("Friday");
  expect(otherYear).toContain("December");
  expect(otherYear).toContain("2025");
});

test("a change to or from summer time adds no divider", () => {
  // Real clock changes in Europe and the US. The local date stays the same
  // across them in every time zone that has them at night.
  const days = [new Date(2026, 2, 8), new Date(2026, 2, 29), new Date(2026, 9, 25), new Date(2026, 10, 1)];
  for (const day of days) {
    const morning = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 30);
    const evening = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 30);
    expect(dayLabelBefore(morning, evening, NOW)).toBeNull();
  }
});
