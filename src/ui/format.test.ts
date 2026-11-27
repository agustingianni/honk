import { describe, expect, test } from "bun:test";
import { theme } from "../theme.ts";
import { applyGlyphs } from "./glyphs.ts";
import { parseIrcText, plainSegments, truncateSegments, underlineRange } from "./format.tsx";

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

  test("a colored text that does not fit is cut at the room, and keeps its colors", () => {
    const segs = parseIrcText("\x0304red\x03 \x0309green\x03 \x0312blue\x03 rules: be nice");
    const cut = truncateSegments(segs, 12);
    expect(cut.map((s) => s.text)).toEqual(["red", " ", "green", " ", "b…"]);
    expect(cut.map((s) => s.fg)).toEqual(segs.slice(0, 5).map((s) => s.fg));
  });

  test("a wide colored text is cut between graphemes, and keeps its color", () => {
    // 4 cells, then 10 cells of CJK.
    const segs = parseIrcText("\x0304red \x0312日本語です");
    const cut = truncateSegments(segs, 9);
    expect(shown(cut)).toBe("red 日本…");
    expect(cut[1]!.fg).toBe(segs[1]!.fg);
    // An even room cannot fit a wide character before the ellipsis: one cell short.
    expect(shown(truncateSegments(segs, 10))).toBe("red 日本…");
  });

  test("a segment that fills the room exactly still ends in an ellipsis", () => {
    const segs = truncateSegments(parseIrcText("\x02abcd\x02efgh"), 4);
    expect(shown(segs)).toBe("abc…");
  });

  test("with --ascii, the segment before the cut leaves room for ...", () => {
    applyGlyphs(true);
    try {
      expect(shown(truncateSegments(parseIrcText("\x02abcd\x02efgh"), 6))).toBe("abc...");
      expect(shown(truncateSegments(parseIrcText("\x034red\x03 and more text"), 8))).toBe("red a...");
    } finally {
      applyGlyphs(false);
    }
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

test("a link ends at an invisible character, so it opens what it shows", () => {
  expect(plainSegments("get https://example.com/\u202Egpj.exe")).toEqual([
    { text: "get " },
    { text: "https://example.com/", href: "https://example.com/" },
    { text: "\u202Egpj.exe" },
  ]);
});

test("a link with right-to-left letters is still one link", () => {
  const url = "https://he.wikipedia.org/wiki/\u05E2\u05D1";
  expect(plainSegments(url)).toEqual([
    { text: url, href: "https://he.wikipedia.org/wiki/%D7%A2%D7%91" },
  ]);
});

test("underlineRange underlines a range that crosses segments", () => {
  const segs = underlineRange(parseIrcText("hi \x02bob\x02: yo"), { start: 2, end: 6 });
  expect(segs.map(({ text, bold, underline }) => ({ text, bold, underline }))).toEqual([
    { text: "hi", bold: undefined, underline: undefined },
    { text: " ", bold: undefined, underline: true },
    { text: "bob", bold: true, underline: true },
    { text: ": yo", bold: undefined, underline: undefined },
  ]);
  // Nothing changes for a range outside the text, such as one moved before it.
  const plain = parseIrcText("hi");
  expect(underlineRange(plain, { start: -4, end: -1 })).toEqual(plain);
});
