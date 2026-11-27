import { describe, expect, test } from "bun:test";
import { parseIrcText, plainSegments, truncateSegments } from "./format.tsx";

const plain = (text: string) =>
  plainSegments(text)
    .map((s) => s.text)
    .join("");

test("system lines lose mIRC color codes, digits and all", () => {
  // From Ergo's default MOTD: \x03 starts a color, then fg[,bg] digits.
  expect(plain("- this is \x034red\x03 and \x032blue\x03 text.")).toBe(
    "- this is red and blue text.",
  );
  expect(plain("\x031,0 00 \x030,1 01")).toBe(" 00  01");
});

test("bold, italics, underline and reset codes go too", () => {
  expect(plain("\x02bold\x02 \x1Ditalic\x1D \x1Funder\x1F\x0F done")).toBe(
    "bold italic under done",
  );
});

test("URLs are still links", () => {
  expect(plainSegments("see https://docs.inspircd.org now")).toEqual([
    { text: "see " },
    { text: "https://docs.inspircd.org", href: "https://docs.inspircd.org" },
    { text: " now" },
  ]);
});

describe("truncateSegments", () => {
  const shown = (segs: { text: string }[]) => segs.map((s) => s.text).join("");

  test("text that fits is kept as it is", () => {
    const segs = parseIrcText("hi https://a.io");
    expect(truncateSegments(segs, 15)).toBe(segs);
  });

  test("a cut link keeps its full href", () => {
    const segs = truncateSegments(parseIrcText("docs at https://example.com/long/path"), 15);
    expect(shown(segs)).toBe("docs at https:…");
    expect(segs.at(-1)!.href).toBe("https://example.com/long/path");
  });

  test("formatting codes take no room", () => {
    const segs = truncateSegments(parseIrcText("\x034red\x03 and more text"), 8);
    expect(shown(segs)).toBe("red and…");
  });

  test("a segment that fills the room exactly still ends in an ellipsis", () => {
    const segs = truncateSegments(parseIrcText("\x02abcd\x02efgh"), 4);
    expect(shown(segs)).toBe("abc…");
  });
});
