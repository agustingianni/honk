import {
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  type RendererClipboardBoundary,
} from "@opentui/core";

/**
 * How a copy went:
 * - "copied": the system clipboard has the text.
 * - "sent": only the terminal got it (OSC 52), as over SSH. The terminal may
 *   still ignore it: iTerm2 does by default, and tmux without
 *   `set-clipboard on`. There is no answer to tell.
 * - "failed": neither one.
 */
export type CopyResult = "copied" | "sent" | "failed";

export type CopyText = (text: string) => Promise<CopyResult>;

/**
 * Copies text to the system clipboard and to the terminal (OSC 52) together.
 * OSC 52 alone fails in tmux without `set-clipboard on`, in Zellij, and in
 * terminals that block it. OpenTUI talks to the system clipboard itself
 * (macOS, Wayland, X11, Windows), and skips it over SSH, where it would fill
 * the clipboard of the wrong machine.
 *
 * Keep one for the life of the program: on Linux, honk owns the clipboard and
 * other programs ask it for the text when they paste.
 */
export function createCopyText(renderer: RendererClipboardBoundary): CopyText {
  const clipboard = createClipboard({
    host: createHostClipboard(),
    terminal: createRendererClipboardAdapter(renderer),
  });
  return async (text) => {
    // OpenTUI rejects NUL and empty text; the system clipboard cannot hold NUL.
    const clean = text.replaceAll("\0", "");
    if (!clean) return "failed";
    try {
      const result = await clipboard.writeText(clean, {
        destination: "all-available",
        selection: "clipboard",
      });
      if (result.host.status === "written") return "copied";
      if (result.terminal.status === "attempted") return "sent";
      return "failed";
    } catch {
      return "failed";
    }
  };
}
