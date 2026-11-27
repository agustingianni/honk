import { describe, expect, test } from "bun:test";
import { isMouseInput } from "./terminalInput.ts";

describe("isMouseInput", () => {
  test.each([
    ["a left click", "\x1b[<0;10;5M"],
    ["its release", "\x1b[<0;10;5m"],
    ["a drag with the left button", "\x1b[<32;11;5M"],
    ["the wheel, up", "\x1b[<64;10;5M"],
    ["the wheel, down, with shift", "\x1b[<69;10;5M"],
    ["a click after a motion report in one read", "\x1b[<35;9;5M\x1b[<0;10;5M"],
  ])("%s counts", (_name, data) => {
    expect(isMouseInput(Buffer.from(data, "latin1"))).toBe(true);
  });

  test.each([
    ["the pointer moving with no button", "\x1b[<35;10;5M"],
    ["a key", "a"],
    ["focus coming back", "\x1b[I"],
    ["a light or dark mode report", "\x1b[?997;2n"],
    ["a color reply", "\x1b]11;rgb:1e1e/1e1e/2e2e\x07"],
    ["a pixel size reply", "\x1b[4;800;1200t"],
  ])("%s does not count", (_name, data) => {
    expect(isMouseInput(Buffer.from(data, "latin1"))).toBe(false);
  });
});
