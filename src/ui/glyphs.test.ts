import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cellWidth } from "./display.ts";
import { ASCII_GLYPHS, UNICODE_GLYPHS, wantsAscii } from "./glyphs.ts";

test("only glyphs.ts in src/ui holds characters outside ASCII", () => {
  // New symbols go through glyphs.ts, so --ascii covers them. Tests may hold
  // any text, since they check how honk shows text from other people.
  const found: string[] = [];
  for (const name of readdirSync(import.meta.dir)) {
    if (name === "glyphs.ts" || /\.test\.tsx?$/.test(name) || !/\.tsx?$/.test(name)) continue;
    readFileSync(join(import.meta.dir, name), "utf-8")
      .split("\n")
      .forEach((line, i) => {
        if (/[^\x00-\x7f]/.test(line)) found.push(`src/ui/${name}:${i + 1}: ${line.trim()}`);
      });
  }
  expect(found).toEqual([]);
});

test("the ASCII set is ASCII, and draws no scrollbar", () => {
  const { border, scrollbar, ...symbols } = ASCII_GLYPHS;
  for (const glyph of [...Object.values(symbols), ...Object.values(border!)]) {
    expect(glyph).toMatch(/^[\x20-\x7e]+$/);
  }
  expect(scrollbar).toBe(false);
});

test("both sets have a glyph for each symbol, of the same width where the layout needs it", () => {
  expect(Object.keys(ASCII_GLYPHS).sort()).toEqual(Object.keys(UNICODE_GLYPHS).sort());
  // The status dot, the selected row mark and the rule are each 1 cell wide.
  for (const key of ["statusOn", "statusConnecting", "statusOff", "selectedRow", "rule"] as const) {
    expect(cellWidth(ASCII_GLYPHS[key])).toBe(1);
    expect(cellWidth(UNICODE_GLYPHS[key])).toBe(1);
  }
});

test("the config decides when it is set", () => {
  const utf8 = { TERM: "xterm-256color", LANG: "en_US.UTF-8" };
  expect(wantsAscii(true, utf8)).toBe(true);
  expect(wantsAscii(false, { TERM: "dumb" })).toBe(false);
  expect(wantsAscii(undefined, utf8)).toBe(false);
});

test("ASCII is on by itself for a dumb terminal or the Linux console", () => {
  expect(wantsAscii(undefined, { TERM: "dumb", LANG: "en_US.UTF-8" })).toBe(true);
  expect(wantsAscii(undefined, { TERM: "linux", LANG: "en_US.UTF-8" })).toBe(true);
});

test("ASCII is on by itself when the locale is not UTF-8", () => {
  expect(wantsAscii(undefined, { TERM: "xterm" })).toBe(true);
  expect(wantsAscii(undefined, { TERM: "xterm", LANG: "C" })).toBe(true);
  expect(wantsAscii(undefined, { TERM: "xterm", LC_CTYPE: "UTF-8" })).toBe(false);
  expect(wantsAscii(undefined, { TERM: "xterm", LC_ALL: "de_DE.utf8" })).toBe(false);
  // LC_ALL wins over LANG, as in setlocale.
  expect(wantsAscii(undefined, { TERM: "xterm", LC_ALL: "C", LANG: "en_US.UTF-8" })).toBe(true);
});
