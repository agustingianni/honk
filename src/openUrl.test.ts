import { expect, test } from "bun:test";
import { openUrl } from "./openUrl.ts";

function spy() {
  const calls: string[][] = [];
  return { calls, spawn: (cmd: string[]) => void calls.push(cmd) };
}

test("a link opens with open on macOS and xdg-open on Linux", () => {
  const mac = spy();
  expect(openUrl("https://example.com/a?b=1", "darwin", mac.spawn, {})).toBe(true);
  expect(mac.calls).toEqual([["open", "https://example.com/a?b=1"]]);

  const linux = spy();
  expect(openUrl("http://example.com", "linux", linux.spawn, {})).toBe(true);
  expect(linux.calls).toEqual([["xdg-open", "http://example.com/"]]);
});

test("only http and https links open", () => {
  const { calls, spawn } = spy();
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ssh://host", "not a url"]) {
    expect(openUrl(url, "darwin", spawn, {})).toBe(false);
  }
  expect(calls).toEqual([]);
});

test("a platform without an open command does nothing", () => {
  const { calls, spawn } = spy();
  expect(openUrl("https://example.com", "win32", spawn, {})).toBe(false);
  expect(calls).toEqual([]);
});

test("a missing command is not an error", () => {
  const fail = () => {
    throw new Error("ENOENT: xdg-open");
  };
  expect(openUrl("https://example.com", "linux", fail, {})).toBe(false);
});

test("a link with non-ASCII letters opens in its encoded form", () => {
  const { calls, spawn } = spy();
  openUrl("https://example.com/café", "darwin", spawn, {});
  expect(calls).toEqual([["open", "https://example.com/caf%C3%A9"]]);
});

test("nothing opens over SSH", () => {
  const { calls, spawn } = spy();
  expect(openUrl("https://example.com", "linux", spawn, { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" })).toBe(false);
  expect(openUrl("https://example.com", "darwin", spawn, { SSH_TTY: "/dev/ttys001" })).toBe(false);
  expect(calls).toEqual([]);
});
