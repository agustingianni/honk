/**
 * A function that opens a URL in the browser, or undefined where honk cannot
 * open one: on a platform without a known command, and over SSH, where the
 * browser would start on the remote machine, not in front of the user. Then
 * links are left to the terminal's own Cmd+click.
 *
 * Only http and https URLs open: a link comes from someone else's message, and
 * `open` would also run a "file:" URL or launch the app behind any other
 * scheme. The URL is one argument, so no shell reads it. It is passed in its
 * encoded form ("https://example.com/café" becomes ".../caf%C3%A9"), which older
 * versions of `open` need to see a URL and not a file name. A missing
 * `xdg-open` is ignored.
 */
export function linkOpener(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  spawn: (cmd: string[]) => void = (cmd) => {
    Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  },
): ((url: string) => void) | undefined {
  if (env.SSH_CONNECTION || env.SSH_TTY) return undefined;
  const command =
    platform === "darwin"
      ? "open"
      : platform === "linux" || platform === "freebsd" || platform === "openbsd"
        ? "xdg-open"
        : undefined;
  if (!command) return undefined;

  return (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    try {
      spawn([command, parsed.href]);
    } catch {
      // No xdg-open: nothing to open with.
    }
  };
}
