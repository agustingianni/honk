import type { UpdateNotice } from "../types.ts";
import { glyphs } from "./glyphs.ts";

export interface Hint {
  /** Drawn in the accent color, such as "^K", or the new version "v0.3.0". */
  key: string;
  label: string;
  /** Lower stays longer when space runs out. */
  priority: number;
}

/** The hints that fit in `room` columns, in display order, dropping the least important first. */
export function fitHints(hints: Hint[], room: number): Hint[] {
  const cost = (h: Hint) => h.key.length + 1 + h.label.length + 2;
  const kept = [...hints];
  let used = kept.reduce((n, h) => n + cost(h), 0);
  while (kept.length > 0 && used > room) {
    const drop = kept.reduce((a, b) => (b.priority > a.priority ? b : a));
    kept.splice(kept.indexOf(drop), 1);
    used -= cost(drop);
  }
  return kept;
}

export interface StatusHintOptions {
  /** False when the terminal is too narrow for the panel, so its key does nothing. */
  sidebarFits: boolean;
  nicklistFits: boolean;
  update: UpdateNotice | null;
}

/**
 * The right side of the status bar. A newer release shows first, as
 * "v0.3.0 available: honk upgrade". It stays longer than every key hint but
 * ^K omnibox and ^C quit, and when the long form does not fit, it shortens to
 * "v0.3.0 available".
 */
export function statusHints(o: StatusHintOptions, room: number): Hint[] {
  const withUpdate = (update: Hint | undefined): Hint[] => [
    ...(update ? [update] : []),
    { key: "^K", label: "omnibox", priority: 0 },
    ...(o.sidebarFits ? [{ key: "^B", label: "sidebar", priority: 3 }] : []),
    ...(o.nicklistFits ? [{ key: "Alt+U", label: "users", priority: 4 }] : []),
    { key: `Alt+${glyphs.upDown}`, label: "switch", priority: 2 },
    { key: "^C", label: "quit", priority: 1 },
  ];

  if (!o.update) return fitHints(withUpdate(undefined), room);

  const short: Hint = { key: o.update.latest, label: "available", priority: 1.5 };
  if (o.update.upgradeable) {
    const long: Hint = { ...short, label: "available: honk upgrade" };
    const fitted = fitHints(withUpdate(long), room);
    if (fitted.includes(long)) return fitted;
  }
  return fitHints(withUpdate(short), room);
}
