import { describe, expect, test } from "bun:test";
import { linkOpener, safeLinkUrl } from "./openUrl.ts";

const DESKTOP = { DISPLAY: ":0" };

/** The opener for `platform` and `env`, and the commands it ran. */
function opener(platform: NodeJS.Platform, env: Record<string, string> = DESKTOP) {
  const calls: string[][] = [];
  const open = linkOpener(platform, env, (cmd) => void calls.push(cmd));
  return { calls, open };
}

test("a link opens with open on macOS and xdg-open on Linux", () => {
  const mac = opener("darwin", {});
  mac.open!("https://example.com/a?b=1");
  expect(mac.calls).toEqual([["/usr/bin/open", "https://example.com/a?b=1"]]);

  const linux = opener("linux", { WAYLAND_DISPLAY: "wayland-0" });
  linux.open!("http://example.com");
  expect(linux.calls).toEqual([["xdg-open", "http://example.com/"]]);
});

test("only safe URLs reach the command", () => {
  const { calls, open } = opener("linux");
  open!("file:///etc/passwd");
  open!("https://example.com/?q\\040--proxy-server=evil.example:8080");
  expect(calls).toEqual([
    ["xdg-open", "https://example.com/?q%5C040--proxy-server=evil.example:8080"],
  ]);
});

test("there is no opener over SSH, without a display, or on an unknown platform", () => {
  expect(opener("linux", { ...DESKTOP, SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }).open).toBeUndefined();
  expect(opener("darwin", { SSH_TTY: "/dev/ttys001" }).open).toBeUndefined();
  expect(opener("linux", {}).open).toBeUndefined();
  expect(opener("win32").open).toBeUndefined();
});

test("a missing command is not an error", () => {
  const open = linkOpener("linux", DESKTOP, () => {
    throw new Error("ENOENT: xdg-open");
  });
  expect(() => open!("https://example.com")).not.toThrow();
});

describe("safeLinkUrl", () => {
  test("http and https URLs are kept, normalized", () => {
    expect(safeLinkUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(safeLinkUrl("http://Example.COM")).toBe("http://example.com/");
  });

  test("other schemes and text that is not a URL are not links", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ssh://host", "not a url"]) {
      expect(safeLinkUrl(url)).toBeUndefined();
    }
  });

  test("a URL with a user name or password is not a link", () => {
    // Looks like github.com, opens evil.example.
    expect(safeLinkUrl("https://github.com@evil.example/")).toBeUndefined();
    expect(safeLinkUrl("https://user:pass@example.com/")).toBeUndefined();
  });

  test("the result is plain ASCII with no character a shell, awk, or a browser reads specially", () => {
    expect(safeLinkUrl("https://example.com/café")).toBe("https://example.com/caf%C3%A9");
    // xdg-open 1.3 passes the URL through `awk -v`, which turns "\040" into a space.
    expect(safeLinkUrl("https://example.com/?q\\040--incognito")).toBe(
      "https://example.com/?q%5C040--incognito",
    );
    expect(safeLinkUrl("https://a.com/x#a|b{c}^d")).toBe("https://a.com/x#a%7Cb%7Bc%7D%5Ed");
    expect(safeLinkUrl("https://a.com/\u202Emoc")).toBe("https://a.com/%E2%80%AEmoc");
  });

  test("every character that can reach the command is in the RFC 3986 set", () => {
    // Every BMP character (but the surrogates), in the path, the query, and the fragment.
    for (let code = 0x20; code <= 0xffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const c = String.fromCharCode(code);
      for (const url of [`https://a.com/x${c}y`, `https://a.com/?x${c}y`, `https://a.com/#x${c}y`]) {
        const safe = safeLinkUrl(url);
        if (safe !== undefined) expect(safe).toMatch(/^https:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/);
      }
    }
  });
});
