/**
 * Tells the mouse input a person makes apart from everything else the terminal sends.
 *
 * honk counts you as present after any key, click or wheel turn (see
 * ReadMarkerTracker.isReading). OpenTUI gives keys as events but has no event for
 * every mouse report: a scrollbar keeps the clicks on it to itself. So honk also reads
 * the raw input and looks for mouse reports in it. The terminal sends other things on
 * the same stream that are not you: replies to OpenTUI's queries, a report when the
 * system switches between light and dark mode, and, with mode 1003, the pointer
 * passing over the window. Those must not count.
 *
 * OpenTUI turns on SGR mouse reports (mode 1006):
 *
 *   ESC [ < button ; x ; y M     a press, a drag, or a wheel turn
 *   ESC [ < button ; x ; y m     a release
 *
 * In `button`, 32 marks motion, and the low two bits 3 mean no button is down.
 */

const SGR_MOUSE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
const MOTION = 32;
const NO_BUTTON = 3;

/**
 * True if `data`, one read from the terminal, holds a mouse report you made: a
 * click, a release, a drag or a wheel turn. Pointer motion with no button down is
 * not one.
 *
 *   isMouseInput("\x1b[<64;10;5M")   -> true   (the wheel)
 *   isMouseInput("\x1b[<35;10;5M")   -> false  (the pointer moving)
 *   isMouseInput("\x1b[?997;2n")     -> false  (dark mode turned on)
 */
export function isMouseInput(data: string | Uint8Array): boolean {
  const text = typeof data === "string" ? data : Buffer.from(data).toString("latin1");
  for (const match of text.matchAll(SGR_MOUSE)) {
    const button = Number(match[1]);
    const hover = (button & MOTION) !== 0 && (button & 3) === NO_BUTTON;
    if (!hover) return true;
  }
  return false;
}
