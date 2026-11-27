import { expect, test } from "bun:test";
import { linkOpener } from "./openUrl.ts";

/** The opener for `platform` and `env`, and the commands it ran. */
function opener(platform: NodeJS.Platform, env: Record<string, string> = {}) {
  const calls: string[][] = [];
  const open = linkOpener(platform, env, (cmd) => void calls.push(cmd));
  return { calls, open };
}

test("a link opens with open on macOS and xdg-open on Linux", () => {
  const mac = opener("darwin");
  mac.open!("https://example.com/a?b=1");
  expect(mac.calls).toEqual([["open", "https://example.com/a?b=1"]]);

  const linux = opener("linux");
  linux.open!("http://example.com");
  expect(linux.calls).toEqual([["xdg-open", "http://example.com/"]]);
});

test("a link with non-ASCII letters opens in its encoded form", () => {
  const { calls, open } = opener("darwin");
  open!("https://example.com/café");
  expect(calls).toEqual([["open", "https://example.com/caf%C3%A9"]]);
});

test("only http and https links open", () => {
  const { calls, open } = opener("darwin");
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ssh://host", "not a url"]) {
    open!(url);
  }
  expect(calls).toEqual([]);
});

test("there is no opener over SSH or on a platform without an open command", () => {
  expect(opener("linux", { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }).open).toBeUndefined();
  expect(opener("darwin", { SSH_TTY: "/dev/ttys001" }).open).toBeUndefined();
  expect(opener("win32").open).toBeUndefined();
});

test("a missing command is not an error", () => {
  const open = linkOpener("linux", {}, () => {
    throw new Error("ENOENT: xdg-open");
  });
  expect(() => open!("https://example.com")).not.toThrow();
});
