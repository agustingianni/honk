import { expect, test } from "bun:test";
import { nickColor } from "./theme.ts";

test("one nick gets one color however the server spells its case", () => {
  expect(nickColor("Alice^")).toBe(nickColor("alice~"));
  expect(nickColor("[m]Bob")).toBe(nickColor("{M}bob"));
  expect(nickColor("Ärger")).toBe(nickColor("ärger"));
});
