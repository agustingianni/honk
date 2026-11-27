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
 */
export function openUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawn: (cmd: string[]) => void = (cmd) => {
    Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  },
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const cmd = openCommand(platform, url);
  if (!cmd) return false;
  try {
    spawn(cmd);
    return true;
  } catch {
    return false;
  }
}
