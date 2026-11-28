/**
 * The time at the start of each chat line, set by "timestamps" in the config
 * or by --timestamps. A fixed set of formats keeps the width of the time
 * column known.
 */

export const TIME_FORMATS = ["HH:mm", "HH:mm:ss", "h:mm a", "none"] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];
export const DEFAULT_TIME_FORMAT: TimeFormat = "HH:mm";

const pad = (n: number) => String(n).padStart(2, "0");

/** `date` in `format`: "09:05", "09:05:42", " 9:05 AM", or "" for none. */
export function formatTime(date: Date, format: TimeFormat): string {
  const hours = date.getHours();
  const minutes = pad(date.getMinutes());
  switch (format) {
    case "HH:mm":
      return `${pad(hours)}:${minutes}`;
    case "HH:mm:ss":
      return `${pad(hours)}:${minutes}:${pad(date.getSeconds())}`;
    case "h:mm a": {
      // Padded on the left, so " 9:05 AM" lines up with "12:05 PM".
      const hour = String(hours % 12 || 12).padStart(2, " ");
      return `${hour}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
    }
    case "none":
      return "";
  }
}

/** The cells every time in a format takes. timeFormat.test.ts checks them. */
export const TIME_WIDTHS: Readonly<Record<TimeFormat, number>> = {
  "HH:mm": 5,
  "HH:mm:ss": 8,
  "h:mm a": 8,
  none: 0,
};

// The format in use, and the width of its chat time. Set once at startup,
// like the theme and the glyphs.
let current: TimeFormat = DEFAULT_TIME_FORMAT;
let currentWidth = chatWidth(current);

function chatWidth(format: TimeFormat): number {
  return format === "none" ? 0 : TIME_WIDTHS[format] + 1;
}

export function applyTimeFormat(format: TimeFormat): void {
  current = format;
  currentWidth = chatWidth(format);
}

/** The start of a chat line: the time and a space, such as "09:05 ", or "" for none. */
export function chatTime(date: Date): string {
  return current === "none" ? "" : `${formatTime(date, current)} `;
}

/** The cells that chatTime takes. */
export function chatTimeWidth(): number {
  return currentWidth;
}

/** The format for the config value `value`, or the default with a warning for *status. */
export function selectTimeFormat(value: string | undefined): { format: TimeFormat; warning?: string } {
  if (value === undefined) return { format: DEFAULT_TIME_FORMAT };
  const format = TIME_FORMATS.find((f) => f === value);
  if (format) return { format };
  return {
    format: DEFAULT_TIME_FORMAT,
    warning: `unknown timestamps format "${value}", using ${DEFAULT_TIME_FORMAT}. The formats are: ${TIME_FORMATS.map((f) => `"${f}"`).join(", ")}`,
  };
}
