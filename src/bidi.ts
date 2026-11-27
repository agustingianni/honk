/**
 * C1 controls and Unicode bidi controls. OpenTUI draws them as nothing, but
 * other programs show text with bidi, so U+202E (RIGHT-TO-LEFT OVERRIDE) in a
 * nick or a message could turn the text after it around: "photo‮gpj.exe"
 * shows as "photoexe.jpg". Text leaves honk without them: notifications and
 * copied text.
 */
const BIDI_AND_C1 = /[\x80-\x9f؜‎‏‪-‮⁦-⁩]/g;

/** `text` without C1 controls and bidi controls. */
export function withoutBidiControls(text: string): string {
  return text.replace(BIDI_AND_C1, "");
}
