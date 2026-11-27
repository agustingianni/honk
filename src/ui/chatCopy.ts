import type { Renderable, Selection, TextRenderable } from "@opentui/core";
import type { ChatMessage } from "../types.ts";
import { formatTime } from "./display.ts";

// The chat rows tag their boxes, so a copy can tell which message each
// selected piece of text belongs to, and whether it is the message body.
const rowMessages = new WeakMap<Renderable, ChatMessage>();
const bodyBoxes = new WeakSet<Renderable>();
const messageBodies = new WeakMap<ChatMessage, Renderable>();

/** Marks `box` as the row that draws `msg`. Pass it as the row box's `ref`. */
export function tagRow(box: Renderable | null, msg: ChatMessage): void {
  if (box) rowMessages.set(box, msg);
}

/** Marks `box` as the column that holds the body of `msg`. Pass it as a `ref`. */
export function tagBody(box: Renderable | null, msg: ChatMessage): void {
  if (!box) return;
  bodyBoxes.add(box);
  messageBodies.set(msg, box);
}

interface Part {
  row: Renderable;
  msg: ChatMessage;
  /** Set when this piece is the message body, not the time or the nick. */
  body?: Renderable;
}

function partOf(renderable: Renderable): Part | undefined {
  let body: Renderable | undefined;
  for (let r: Renderable | null = renderable; r; r = r.parent) {
    if (bodyBoxes.has(r)) body = r;
    const msg = rowMessages.get(r);
    if (msg) return { row: r, msg, body };
  }
  return undefined;
}

/** The whole body of a row, as drawn: formatting is gone, " (not sent)" stays. */
function wholeBody(bodyBox: Renderable): string {
  return bodyTextRenderable(bodyBox)?.plainText ?? "";
}

/** The selected part of a row's body. */
function bodyText(bodyBox: Renderable): string {
  return bodyTextRenderable(bodyBox)?.getSelectedText() ?? "";
}

function bodyTextRenderable(bodyBox: Renderable): TextRenderable | undefined {
  return bodyBox.getChildren()[0] as TextRenderable | undefined;
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
 * - Part of one piece of one message (a word, a nick, part of the body)
 *   copies just that text.
 * - Anything bigger copies one log line per message, with the time and the
 *   sender, and the selected part of each body. A triple-click copies the
 *   whole message this way.
 * - Selected text outside the chat (the topic, the status line) copies as
 *   OpenTUI gives it, in screen order with the log lines.
 */
export function selectionText(selection: Selection): string {
  const pieces = selection.selectedRenderables.filter((r) => !r.isDestroyed);
  const messages = new Map<Renderable, { msg: ChatMessage; pieces: Renderable[]; body?: Renderable }>();
  const others: Renderable[] = [];
  for (const piece of pieces) {
    const part = partOf(piece);
    if (!part) {
      others.push(piece);
      continue;
    }
    let entry = messages.get(part.row);
    if (!entry) {
      entry = { msg: part.msg, pieces: [] };
      messages.set(part.row, entry);
    }
    entry.pieces.push(piece);
    if (part.body) entry.body = part.body;
  }
  if (messages.size === 0) return selection.getSelectedText();

  const line = selection.behavior === "line";
  if (messages.size === 1 && others.length === 0 && !line) {
    const own = [...messages.values()][0]!.pieces;
    if (own.length === 1) return own[0]!.getSelectedText();
  }

  // Screen rows, each with its text. A message is one row, however many it wraps to.
  const rows = new Map<number, { x: number; text: string }[]>();
  const add = (y: number, x: number, text: string) => {
    if (text) rows.set(y, [...(rows.get(y) ?? []), { x, text }]);
  };
  for (const [row, { msg, body }] of messages) {
    // A row whose body has no selected text (only its time or nick) adds nothing.
    const box = line ? (body ?? messageBodies.get(msg)) : body;
    const text = !box ? "" : line ? wholeBody(box) : bodyText(box);
    if (text) add(row.y, row.x, logLine(msg, text));
  }
  for (const other of others) add(other.y, other.x, other.getSelectedText());
  if (rows.size === 0) return selection.getSelectedText();
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, parts]) => parts.sort((a, b) => a.x - b.x).map((p) => p.text).join(""))
    .join("\n");
}
