/** The command that opens a URL in the browser on each platform, or undefined where honk has none. */
export function openCommand(platform: NodeJS.Platform, url: string): string[] | undefined {
  if (platform === "darwin") return ["open", url];
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    return ["xdg-open", url];
  }
  return undefined;
}

/**
 * Opens `url` in the browser, without waiting. Only http and https URLs open:
 * a link comes from someone else's message, and `open` would also run a
 * "file:" URL or launch the app behind any other scheme. The URL is one
 * argument, so no shell reads it. A missing `xdg-open` is ignored.
 *
 * Over SSH nothing opens: the browser would start on the remote machine, not
 * in front of the user. The terminal's own Cmd+click still works there.
 */
export function openUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawn: (cmd: string[]) => void = (cmd) => {
    Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  },
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // The encoded form: "https://example.com/café" becomes ".../caf%C3%A9",
  // which older versions of `open` need to see a URL and not a file name.
  const cmd = openCommand(platform, parsed.href);
  if (!cmd) return false;
  try {
    spawn(cmd);
    return true;
  } catch {
    return false;
  }
}
