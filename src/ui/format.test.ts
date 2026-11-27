import { describe, expect, test } from "bun:test";
import { theme } from "../theme.ts";
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
    { text: "https://docs.inspircd.org", href: "https://docs.inspircd.org/" },
    { text: " now" },
  ]);
});

describe("truncateSegments", () => {
  const shown = (segs: { text: string }[]) => segs.map((s) => s.text).join("");

  test("text that fits is kept as it is", () => {
    const segs = parseIrcText("hi https://a.io");
    expect(truncateSegments(segs, 15)).toBe(segs);
  });

  test("a cut link is not a link: what is left could hide the real host", () => {
    const segs = truncateSegments(parseIrcText("docs at https://github.com.evil.example/x"), 27);
    expect(shown(segs)).toBe("docs at https://github.com…");
    expect(segs.some((s) => s.href)).toBe(false);
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

describe("links from other people", () => {
  test("a link always has the link color on the normal background", () => {
    // Text and background in the chat background color: an invisible link.
    for (const text of ["\x041a1b26https://evil.example/", "\x0301,01https://evil.example/", "\x16https://evil.example/"]) {
      const link = parseIrcText(text).find((s) => s.href)!;
      expect(link.bg).toBeUndefined();
      expect(link.fg).toBe(theme.cyan);
    }
  });

  test("a URL that is not safe to open is plain text", () => {
    expect(plainSegments("https://github.com@evil.example/ x")).toEqual([
      { text: "https://github.com@evil.example/" },
      { text: " x" },
    ]);
  });

  test("the href is the encoded URL", () => {
    const link = parseIrcText("https://example.com/?q\\040--incognito").find((s) => s.href)!;
    expect(link.href).toBe("https://example.com/?q%5C040--incognito");
  });
});
