import { afterEach, expect, test } from "bun:test";
import { cellWidth, indexAtCell, setWidthMethod, truncate } from "./display.ts";
import { applyGlyphs } from "./glyphs.ts";

const FAMILY = "👨‍👩‍👧‍👦";

afterEach(() => {
  setWidthMethod("unicode");
  applyGlyphs(false);
});

test("truncate leaves a string that fits alone", () => {
  expect(truncate("fern", 12)).toBe("fern");
  expect(truncate("#日本語", 7)).toBe("#日本語");
});

test("truncate counts terminal cells, not code units", () => {
  // 4 code units, 8 cells: it does not fit in 6 cells.
  expect(truncate("田中さん", 6)).toBe("田中…");
  expect(cellWidth(truncate("田中さん", 6))).toBe(5);
  expect(truncate("abcdefgh", 6)).toBe("abcde…");
});

test("truncate never cuts an emoji in half", () => {
  expect(truncate("👍🏽👍🏽👍🏽", 4)).toBe("👍🏽…");
  expect(truncate("🇯🇵🇯🇵🇯🇵", 5)).toBe("🇯🇵🇯🇵…");
});

test("truncate gives nothing for no room, and only the ellipsis for one cell", () => {
  expect(truncate("fern", 0)).toBe("");
  expect(truncate("fern", -3)).toBe("");
  expect(truncate("fern", 1)).toBe("…");
});

test("with --ascii, truncate leaves room for the 3 cells of ...", () => {
  applyGlyphs(true);
  expect(truncate("abcdefgh", 6)).toBe("abc...");
  expect(truncate("abcdef", 6)).toBe("abcdef");
  expect(truncate("田中さん", 6)).toBe("田...");
  // 8 cells: the emoji takes 2.
  expect(truncate(`ab${FAMILY}cdef`, 7)).toBe(`ab${FAMILY}...`);
  expect(truncate(`ab${FAMILY}cdef`, 6)).toBe("ab...");
  expect(truncate(`ab${FAMILY}cdef`, 4)).toBe("a...");
});

test("truncate gives the part of the marker that fits when the whole one does not", () => {
  applyGlyphs(true);
  expect(truncate("fern", 1)).toBe(".");
  expect(truncate("fernando", 2)).toBe("..");
  expect(truncate("fernando", 3)).toBe("...");
  expect(truncate("田中さん", 2)).toBe("..");
});

test("a ZWJ emoji takes 2 cells with the unicode method", () => {
  expect(cellWidth(FAMILY)).toBe(2);
  expect(truncate(`ab${FAMILY}cd`, 6)).toBe(`ab${FAMILY}cd`);
  expect(truncate(`ab${FAMILY}cd`, 5)).toBe(`ab${FAMILY}…`);
});

test("a ZWJ emoji takes 8 cells with the wcwidth method", () => {
  expect(setWidthMethod("wcwidth")).toBe(true);
  expect(cellWidth(FAMILY)).toBe(8);
  expect(cellWidth("❤️")).toBe(1);
  expect(cellWidth("田中")).toBe(4);
  // The emoji does not fit in the 3 cells left before the ellipsis.
  expect(truncate(`ab${FAMILY}cd`, 6)).toBe("ab…");
});

test("setWidthMethod says whether the method changed", () => {
  expect(setWidthMethod("unicode")).toBe(false);
  expect(setWidthMethod("wcwidth")).toBe(true);
  expect(setWidthMethod("wcwidth")).toBe(false);
});

test("control characters take no cells, as <text> hides them", () => {
  expect(cellWidth("a\x01b")).toBe(2);
  expect(cellWidth("a\x9bb")).toBe(2);
});

test("a tab takes 2 cells, as <text> draws it", () => {
  expect(cellWidth("a\tb")).toBe(4);
  expect(truncate("rules:\tbe nice", 9)).toBe("rules:\t…");
});

test("indexAtCell finds the character that covers a cell", () => {
  expect(indexAtCell("abc", 1)).toBe(1);
  expect(indexAtCell("abc", 3)).toBe(-1);
  // Each of these takes 2 cells.
  expect([0, 1, 2, 3, 4].map((col) => indexAtCell("日本a", col))).toEqual([0, 0, 1, 1, 2]);
  // The family emoji is 11 code units and 2 cells.
  expect(indexAtCell(`${FAMILY}x`, 2)).toBe(FAMILY.length);
});
