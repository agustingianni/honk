import type { Renderable, Selection, TextRenderable } from "@opentui/core";
import type { ChatMessage } from "../types.ts";
import { formatTime } from "./display.ts";

// The chat rows tag their renderables, so a copy can tell which message each
// selected piece of text belongs to, and find the message body.
const rowMessages = new WeakMap<Renderable, ChatMessage>();
const messageBodies = new WeakMap<ChatMessage, TextRenderable>();

/** Marks `box` as the row that draws `msg`. Call it from the row box's `ref`. */
export function tagRow(box: Renderable | null, msg: ChatMessage): void {
  if (box) rowMessages.set(box, msg);
}

/** Marks `text` as the body of `msg`. Call it from the body text's `ref`. */
export function tagBody(text: TextRenderable | null, msg: ChatMessage): void {
  if (text) messageBodies.set(msg, text);
}

/** The row `piece` is in, and its message, if it is in a chat row. */
function rowOf(piece: Renderable): { row: Renderable; msg: ChatMessage } | undefined {
  for (let r: Renderable | null = piece; r; r = r.parent) {
    const msg = rowMessages.get(r);
    if (msg) return { row: r, msg };
  }
  return undefined;
}

/** A line like an irssi or weechat log: "14:02 <kai> hello". */
export function logLine(msg: ChatMessage, body: string): string {
  const time = formatTime(msg.timestamp);
  switch (msg.kind) {
    case "message":
      return `${time} <${msg.from ?? ""}> ${body}`;
    case "action":
      // The body starts with the sender already: "kai waves".
      return `${time} * ${body}`;
    case "notice":
      return `${time} -${msg.from ?? "notice"}- ${body}`;
    default:
      return `${time} -!- ${body}`;
  }
}

/**
 * The text a copy puts on the clipboard. The chat draws a message as a time,
 * a padded nick column, a gutter, and a body that wraps, so the selected
 * cells as they are would hold the padding and hard breaks. Instead:
 *
 * - One piece of text (a word, a nick, part of one body) copies just that.
 * - Anything bigger copies one log line per message, with the time and the
 *   sender, and the selected part of each body. A triple-click copies the
 *   whole message this way.
 * - Selected text outside the chat (the topic, the status line) copies as
 *   OpenTUI gives it, in screen order with the log lines.
 */
export function selectionText(selection: Selection): string {
  const pieces = selection.selectedRenderables.filter((r) => !r.isDestroyed);
  const line = selection.behavior === "line";
  if (!line && pieces.length === 1) return pieces[0]!.getSelectedText();

  // Screen rows, each with its text. A message is one row, however many it wraps to.
  const rows = new Map<number, { x: number; text: string }[]>();
  const add = (y: number, x: number, text: string | undefined) => {
    if (!text) return;
    let parts = rows.get(y);
    if (!parts) rows.set(y, (parts = []));
    parts.push({ x, text });
  };
  const messages = new Map<Renderable, ChatMessage>();
  for (const piece of pieces) {
    const found = rowOf(piece);
    if (found) messages.set(found.row, found.msg);
    else add(piece.y, piece.x, piece.getSelectedText());
  }
  for (const [row, msg] of messages) {
    // A row whose body has no selected text (only its time or nick) adds nothing.
    const body = messageBodies.get(msg);
    const text = line ? body?.plainText : body?.getSelectedText();
    if (text) add(row.y, row.x, logLine(msg, text));
  }
  if (rows.size === 0) return selection.getSelectedText();
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, parts]) => parts.sort((a, b) => a.x - b.x).map((p) => p.text).join(""))
    .join("\n");
}
