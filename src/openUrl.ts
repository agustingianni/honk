/** The characters RFC 3986 allows in a URL. Any other is percent-encoded. */
const NOT_URL_CHAR = /[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/g;

/**
 * The URL a link in someone's message may open, or undefined when it must not
 * be a link. The text comes from other people, so this is strict:
 *
 * - Only http and https: `open` would also run a "file:" URL or launch the app
 *   behind any other scheme.
 * - No user name or password: "https://github.com@evil.example/" opens evil.example.
 * - Encoded, plain ASCII. Non-ASCII becomes "%C3%A9", which older versions of
 *   `open` need to see a URL. Characters that WHATWG URLs keep, such as "\" and
 *   "|" in the query, are encoded too: newer xdg-open passes the URL through
 *   `awk -v`, which turns "\040" into a space, and the browser then gets the
 *   rest of the URL as extra arguments, such as "--proxy-server=...".
 */
export function safeLinkUrl(text: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  return parsed.href.replace(
    NOT_URL_CHAR,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/**
 * A function that opens a link in the browser, or undefined where honk should
 * not open one. Then links are left to the terminal's own Cmd+click. That is:
 *
 * - over SSH, where the browser would start on the remote machine;
 * - on Linux and the BSDs without a display, where xdg-open falls back to a
 *   text browser that fetches the URL from this machine, out of sight;
 * - on a platform without a known command.
 *
 * The URL passes through safeLinkUrl again, and goes to the command as one
 * argument, so no shell reads it. A missing xdg-open is ignored.
 */
export function linkOpener(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  spawn: (cmd: string[]) => void = (cmd) => {
    Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  },
): ((url: string) => void) | undefined {
  if (env.SSH_CONNECTION || env.SSH_TTY) return undefined;
  let command: string;
  if (platform === "darwin") {
    // The full path: `bun run` puts node_modules/.bin first on PATH.
    command = "/usr/bin/open";
  } else if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return undefined;
    command = "xdg-open";
  } else {
    return undefined;
  }

  return (url) => {
    const safe = safeLinkUrl(url);
    if (!safe) return;
    try {
      spawn([command, safe]);
    } catch {
      // No xdg-open, or a URL too long for the command line: nothing opens.
    }
  };
}
