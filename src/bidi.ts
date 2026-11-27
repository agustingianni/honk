/**
 * C1 controls and Unicode bidi controls. OpenTUI draws them as nothing, but
 * other programs show text with bidi, so U+202E (RIGHT-TO-LEFT OVERRIDE) in a
 * nick or a message could turn the text after it around: "photo" U+202E
 * "gpj.exe" shows as "photoexe.jpg". Text leaves honk without them:
 * notifications and copied text.
 */
const BIDI_AND_C1 = /[\x80-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** `text` without C1 controls and bidi controls. */
export function withoutBidiControls(text: string): string {
  return text.replace(BIDI_AND_C1, "");
}
