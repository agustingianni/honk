import { NICK_COL_MIN } from "../config.ts";
import type { ChatMessage, NickEntry, ServerState } from "../types.ts";
import { bufferDisplayName, cellWidth, noticeLabel, unreadBadge } from "./display.ts";
import { glyphs } from "./glyphs.ts";

/** The time (5 cells) and a space, before the nick column. */
const TIME_COL = 5 + 1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The cells of the nick column in the chat: the longest label of a message or a
 * notice ("-NickServ-"), between NICK_COL_MIN and `max`. Events such as joins
 * don't count: their label is one symbol.
 */
export function nickColumnWidth(messages: readonly ChatMessage[], max: number): number {
  let longest = 0;
  for (const m of messages) {
    if (m.kind === "message" && m.from) longest = Math.max(longest, cellWidth(m.from));
    else if (m.kind === "notice") longest = Math.max(longest, cellWidth(noticeLabel(m.from)));
  }
  return clamp(longest, NICK_COL_MIN, max);
}

/**
 * The nick column of `width` cells, made smaller when the time and the nick
 * would take more than half of a chat pane `paneWidth` cells wide, so the text
 * keeps room. Never less than NICK_COL_MIN.
 */
export function nickColumnInPane(width: number, paneWidth: number): number {
  return clamp(Math.floor(paneWidth / 2) - TIME_COL, NICK_COL_MIN, width);
}

export const SIDEBAR_MIN = 16;
const SIDEBAR_MAX = 32;
/** A scrollbar takes one column of a panel when its list is longer than the panel. */
const SCROLLBAR = 1;

/** A buffer row: the selection mark, a space, the name, then 1 cell of padding. */
function bufferRowChrome(): number {
  return cellWidth(glyphs.selectedRow) + 1 + 1 + SCROLLBAR;
}

/** A space and the widest unread count, "99+". */
function badgeRoom(): number {
  return 1 + cellWidth(unreadBadge(100));
}

/** A server row: 1 cell of padding, the status glyph and a space, the name, 1 cell of padding. */
function serverRowChrome(): number {
  return 1 + cellWidth(glyphs.statusOn) + 1 + 1 + SCROLLBAR;
}

/** The cells a server name gets in a sidebar `width` cells wide. */
export function serverNameRoom(width: number): number {
  return width - serverRowChrome();
}

/**
 * The cells a buffer name gets in a sidebar `width` cells wide. A row with an
 * unread count gives the count its room.
 */
export function bufferNameRoom(width: number, hasBadge: boolean): number {
  return width - bufferRowChrome() - (hasBadge ? badgeRoom() : 0);
}

/**
 * The cells of the sidebar: the longest server or buffer name, and room for an
 * unread count beside every buffer, so the width does not change when one comes in.
 * Between SIDEBAR_MIN and SIDEBAR_MAX.
 */
export function sidebarWidth(servers: readonly ServerState[]): number {
  let server = 0;
  let buffer = 0;
  for (const s of servers) {
    server = Math.max(server, cellWidth(s.name));
    for (const name of s.bufferOrder) {
      const buf = s.buffers[name];
      if (buf) buffer = Math.max(buffer, cellWidth(bufferDisplayName(buf)));
    }
  }
  const need = Math.max(serverRowChrome() + server, bufferRowChrome() + badgeRoom() + buffer);
  return clamp(need, SIDEBAR_MIN, SIDEBAR_MAX);
}

export const NICKLIST_MIN = 12;
const NICKLIST_MAX = 24;
/** A user row: 1 cell of padding, the mode prefix, the nick, 1 cell of padding. */
const NICK_ROW_CHROME = 1 + 1 + 1 + SCROLLBAR;

/** The text of the user list header. */
export function nicklistHeader(count: number): string {
  return `USERS (${count})`;
}

/** The cells a nick gets in a user list `width` cells wide. */
export function nicklistNickRoom(width: number): number {
  return width - NICK_ROW_CHROME;
}

/**
 * The cells of the user list: the longest nick in the channel, or the header
 * with its padding, between NICKLIST_MIN and NICKLIST_MAX.
 */
export function nicklistWidth(users: readonly NickEntry[]): number {
  let need = 2 + cellWidth(nicklistHeader(users.length)) + 1;
  for (const u of users) need = Math.max(need, NICK_ROW_CHROME + cellWidth(u.nick));
  return clamp(need, NICKLIST_MIN, NICKLIST_MAX);
}

/** The chat pane never gets fewer columns than this while a panel is open. */
export const CHAT_MIN = 40;

/** The panels to show and the widths they want. A missing panel is off. */
export interface WantedPanels {
  sidebar?: number;
  nicklist?: number;
}

/** Whether a terminal `width` columns wide has room for the chat and panels of these widths. */
export function panelsFit(width: number, ...panels: number[]): boolean {
  return width - panels.reduce((sum, p) => sum + p, 0) >= CHAT_MIN;
}

/** Columns of each pane. A panel with 0 is hidden. */
export interface PanelLayout {
  sidebar: number;
  nicklist: number;
  chat: number;
}

/**
 * Splits a terminal `width` columns wide between the panels and the chat. The
 * chat keeps CHAT_MIN columns: the user list shrinks first, then the sidebar,
 * each down to its minimum. When that is not enough, the user list is hidden,
 * then the sidebar.
 */
export function panelLayout(width: number, wanted: WantedPanels): PanelLayout {
  let sidebar = wanted.sidebar ?? 0;
  let nicklist = wanted.nicklist ?? 0;
  let over = sidebar + nicklist - (width - CHAT_MIN);
  const shrink = (size: number, min: number) => {
    const cut = Math.max(0, Math.min(over, size - min));
    over -= cut;
    return size - cut;
  };
  nicklist = shrink(nicklist, NICKLIST_MIN);
  sidebar = shrink(sidebar, SIDEBAR_MIN);
  if (over > 0) {
    if (wanted.nicklist !== undefined) return panelLayout(width, { sidebar: wanted.sidebar });
    return { sidebar: 0, nicklist: 0, chat: width };
  }
  return { sidebar, nicklist, chat: width - sidebar - nicklist };
}
