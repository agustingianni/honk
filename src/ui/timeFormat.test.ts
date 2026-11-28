import { describe, expect, test } from "bun:test";
import { formatTime, selectTimeFormat, TIME_FORMATS, TIME_WIDTHS } from "./timeFormat.ts";

const at = (hours: number, minutes: number, seconds = 0) => new Date(2026, 10, 28, hours, minutes, seconds);

describe("formatTime", () => {
  test("HH:mm is the 24-hour clock", () => {
    expect(formatTime(at(9, 5, 42), "HH:mm")).toBe("09:05");
    expect(formatTime(at(0, 0), "HH:mm")).toBe("00:00");
    expect(formatTime(at(23, 59), "HH:mm")).toBe("23:59");
  });

  test("HH:mm:ss adds the seconds", () => {
    expect(formatTime(at(9, 5, 42), "HH:mm:ss")).toBe("09:05:42");
    expect(formatTime(at(0, 0, 0), "HH:mm:ss")).toBe("00:00:00");
  });

  test("h:mm a is the 12-hour clock, padded so the times line up", () => {
    expect(formatTime(at(9, 5), "h:mm a")).toBe(" 9:05 AM");
    expect(formatTime(at(0, 0), "h:mm a")).toBe("12:00 AM");
    expect(formatTime(at(12, 0), "h:mm a")).toBe("12:00 PM");
    expect(formatTime(at(13, 30), "h:mm a")).toBe(" 1:30 PM");
    expect(formatTime(at(23, 59), "h:mm a")).toBe("11:59 PM");
  });

  test("none shows no time", () => {
    expect(formatTime(at(9, 5), "none")).toBe("");
  });

  test("every time of a format is as wide as TIME_WIDTHS says", () => {
    for (const format of TIME_FORMATS) {
      for (const hours of [0, 1, 9, 10, 12, 13, 23]) {
        expect(formatTime(at(hours, 7, 3), format).length, `${format} at ${hours}`).toBe(TIME_WIDTHS[format]);
      }
    }
  });
});

describe("selectTimeFormat", () => {
  test("takes a known format, and HH:mm when the key is missing", () => {
    expect(selectTimeFormat("h:mm a")).toEqual({ format: "h:mm a" });
    expect(selectTimeFormat(undefined)).toEqual({ format: "HH:mm" });
  });

  test("an unknown format falls back to HH:mm and says so", () => {
    expect(selectTimeFormat("hh:mm")).toEqual({
      format: "HH:mm",
      warning: 'unknown timestamps format "hh:mm", using HH:mm. The formats are: "HH:mm", "HH:mm:ss", "h:mm a", "none"',
    });
  });
});
