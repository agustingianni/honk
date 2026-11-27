/**
 * How Events read in a Buffer, such as "alice joined #honk". The chat pane and the
 * Context view of a search both use these, so the two read the same.
 */

/** " (reason)", or nothing for no reason. */
const reason = (text: string | undefined) => (text ? ` (${text})` : "");

export const joinText = (who: string, channel: string) => `${who} joined ${channel}`;
export const partText = (who: string, channel: string, why?: string) =>
  `${who} left ${channel}${reason(why)}`;
export const quitText = (who: string, why?: string) => `${who} quit${reason(why)}`;
export const nickText = (oldNick: string, newNick: string) => `${oldNick} is now known as ${newNick}`;
export const kickText = (nick: string, by: string, why?: string) =>
  `${nick} was kicked by ${by}${reason(why)}`;
export const topicText = (who: string, topic: string) =>
  topic ? `${who} changed the topic to: ${topic}` : `${who} cleared the topic`;
