/** The local date as one number, such as 20261127. Equal numbers mean the same day. */
function dayKey(date: Date): number {
  return date.getFullYear() * 10000 + date.getMonth() * 100 + date.getDate();
}

const DAY = { weekday: "long", month: "long", day: "numeric" } as const;
const SAME_YEAR = new Intl.DateTimeFormat(undefined, DAY);
const OTHER_YEAR = new Intl.DateTimeFormat(undefined, { ...DAY, year: "numeric" });

/** "Thursday, November 26", with the year when it is not the year of `now`. */
export function dayLabel(date: Date, now: Date): string {
  const format = date.getFullYear() === now.getFullYear() ? SAME_YEAR : OTHER_YEAR;
  return format.format(date);
}

/**
 * The label of the day divider above a message sent at `date`, or null for
 * none. `prev` is when the message before it was sent, or undefined for the
 * first message of the buffer. A divider goes where the local date changes,
 * and above the first message when it is not from today. Labels are absolute
 * dates, so they stay right when honk runs past midnight.
 */
export function dayLabelBefore(prev: Date | undefined, date: Date, now: Date): string | null {
  return dayKey(date) === dayKey(prev ?? now) ? null : dayLabel(date, now);
}
