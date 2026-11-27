/**
 * Desktop notifications for mentions and DMs.
 *
 * honk does not talk to macOS or Linux directly. It asks the terminal to show the
 * notification with an escape sequence (OSC 9, OSC 777 or OSC 99), through OpenTUI's
 * `renderer.triggerNotification`. OpenTUI picks the sequence the terminal supports and
 * wraps it for tmux and screen. This works over SSH (the notification shows on the
 * machine you sit at) and needs no signed app bundle on macOS. Inside tmux and
 * zellij, OpenTUI can't tell the terminal, so honk picks the sequence: see
 * src/notifyProtocol.ts.
 */

import { withoutBidiControls } from "./bidi.ts";
import type { BufferKind, MessageKind } from "./types.ts";

/** A mention or DM that just arrived, as the IRC manager reports it. */
export interface MentionEvent {
  serverId: string;
  bufferName: string;
  bufferKind: BufferKind;
  kind: MessageKind;
  from: string;
  text: string;
  /** True when this buffer is the one shown on screen. */
  isActiveBuffer: boolean;
}

/** Sends one notification. Returns false when the terminal can't show it. */
export type SendNotification = (message: string, title: string) => boolean;

/** At most one notification per buffer in this time, so a busy conversation doesn't flood the desktop. */
export const NOTIFY_COOLDOWN_MS = 10_000;

/** Longest body we send. Notification banners show only a few lines anyway. */
export const MAX_BODY_LENGTH = 200;

/**
 * Removes mIRC formatting codes (bold, colors and so on), so the notification shows
 * the text and not "04,01hello".
 */
export function stripIrcFormatting(text: string): string {
  return text
    .replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, "")
    .replace(/\x04([0-9a-fA-F]{6}(,[0-9a-fA-F]{6})?)?/g, "")
    .replace(/[\x00-\x08\x0a-\x1f\x7f]/g, "");
}

/** The title and body for one event. */
export function formatNotification(event: MentionEvent): { title: string; body: string } {
  const title =
    event.bufferKind === "dm" ? event.from : `${event.from} in ${event.bufferName}`;
  let body = stripIrcFormatting(event.text).trim();
  if (event.kind === "action") body = `* ${event.from} ${body}`;
  if (body.length > MAX_BODY_LENGTH) body = `${body.slice(0, MAX_BODY_LENGTH - 3)}...`;
  return { title, body };
}

export class Notifier {
  /**
   * Whether the terminal window has focus. OpenTUI reports this with focus tracking
   * (mode 1004). A terminal without it never reports, so we treat it as focused, and
   * notify only for buffers that are not on screen.
   */
  private focused = true;
  private lastSent = new Map<string, number>();

  private readonly send: SendNotification;

  constructor(
    send: SendNotification,
    private readonly now: () => number = Date.now,
  ) {
    this.send = (message, title) =>
      // The system shows notifications with bidi. See src/bidi.ts.
      send(withoutBidiControls(message), withoutBidiControls(title));
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
  }

  /** Shows a notification for `event` unless the user is already looking at it. Returns true if one was sent. */
  notify(event: MentionEvent): boolean {
    if (this.focused && event.isActiveBuffer) return false;

    const key = `${event.serverId}\0${event.bufferName}`;
    const now = this.now();
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < NOTIFY_COOLDOWN_MS) return false;

    const { title, body } = formatNotification(event);
    if (!this.send(body, title)) return false;
    this.lastSent.set(key, now);
    return true;
  }

  /**
   * Mentions you missed while the connection was down, found in the chat history after
   * the reconnect. One mention gets the usual notification; several get one summary,
   * not a burst of banners.
   */
  notifyMissed(events: MentionEvent[]): boolean {
    const unseen = events.filter((e) => !(this.focused && e.isActiveBuffer));
    if (unseen.length === 0) return false;
    if (unseen.length === 1) return this.notify(unseen[0]!);
    return this.send(formatMissedSummary(unseen), "Missed mentions");
  }
}

/** "3 mentions while you were away, in #honk and alice". */
export function formatMissedSummary(events: MentionEvent[]): string {
  const places = [...new Set(events.map((e) => (e.bufferKind === "dm" ? e.from : e.bufferName)))];
  const where =
    places.length === 1
      ? places[0]
      : `${places.slice(0, -1).join(", ")} and ${places[places.length - 1]}`;
  let body = `${events.length} mentions while you were away, in ${where}`;
  if (body.length > MAX_BODY_LENGTH) body = `${body.slice(0, MAX_BODY_LENGTH - 3)}...`;
  return body;
}
