/**
 * The words honk shows for what servers and the network report: error numerics,
 * connection failures, rejected TLS certificates, WHOIS replies and standard replies.
 * No raw names such as "err_bannedfromchan" reach the screen.
 *
 * These are pure functions, so tests can check every wording. IrcManager decides where
 * each line goes.
 */

/**
 * Numerics irc-client-ts doesn't know. It drops their number, so honk reads them off
 * the raw line instead (see runtime.ts). Names follow the usual ircd source names.
 * replies.test.ts checks that the library still doesn't know them, so an upgrade that
 * adds one can't show a line twice.
 */
export const NUMERICS_MISSING_FROM_LIBRARY: Readonly<Record<string, string>> = {
  "437": "err_unavailresource",
  "438": "err_nicktoofast",
  "470": "err_linkchannel",
  "477": "err_needreggednick",
  "484": "err_restricted",
  "486": "err_nononreg",
  "489": "err_secureonlychan",
  "716": "err_targumodeg",
  "717": "rpl_targnotify",
};

/**
 * What an error numeric answers, which decides where honk shows it:
 *
 * - "join": a JOIN failed. The first word after your nick is the channel.
 * - "message": a PRIVMSG or NOTICE was refused. The first word is its target.
 * - "nick": a nick you asked for. It names a nick, not a buffer, so it stays where you are.
 *
 * Other errors go to the buffer they name, if one is open. err_nosuchchannel answers both
 * a JOIN and a message, so it counts as both.
 */
const ERROR_KINDS: Record<string, readonly ("join" | "message" | "nick")[]> = {
  err_nosuchchannel: ["join", "message"],
  err_toomanychannels: ["join"],
  err_channelisfull: ["join"],
  err_inviteonlychan: ["join"],
  err_bannedfromchan: ["join"],
  err_badchannelkey: ["join"],
  err_badchanmask: ["join"],
  err_badchanname: ["join"],
  err_needreggednick: ["join"],
  err_secureonlychan: ["join"],
  err_cannotsendtochan: ["message"],
  err_nosuchnick: ["message"],
  err_nononreg: ["message"],
  err_targumodeg: ["message"],
  err_nonicknamegiven: ["nick"],
  err_erroneusnickname: ["nick"],
  err_nicknameinuse: ["nick"],
  err_nickcollision: ["nick"],
  err_unavailresource: ["nick"],
  err_nicktoofast: ["nick"],
};

export function isErrorKind(name: string, kind: "join" | "message" | "nick"): boolean {
  return ERROR_KINDS[name]?.includes(kind) ?? false;
}

/** Numerics described here that report something that worked, so they show as normal lines. */
const INFO_REPLIES = new Set(["rpl_targnotify"]);

/** How a numeric's line shows: "error" for a failure, "system" for information. */
export function replyKind(name: string): "error" | "system" {
  return INFO_REPLIES.has(name) ? "system" : "error";
}

type Describe = (subject: string[], text: string) => string | null;

/** "Cannot join channel (+b)" adds nothing to "Can't join #x: you are banned". */
const joinError =
  (reason: string): Describe =>
  ([channel = "the channel"]) =>
    `Can't join ${channel}: ${reason}.`;

const badChannelName: Describe = ([channel = "That"]) => `${channel} is not a valid channel name.`;

/** The server's own reason, without a trailing period, for "...: <reason>." */
const reasonOf = (text: string) => text.replace(/\.+$/, "");

const ERROR_TEXT: Record<string, Describe> = {
  err_nosuchnick: ([target = "That nick"]) => `${target} is not on this server.`,
  err_nosuchserver: ([target = "That server"]) => `${target} is not a server on this network.`,
  err_nosuchchannel: ([channel = "That channel"]) => `${channel} does not exist.`,
  // "Cannot send to channel" alone says nothing new; "(+m)" or "You need voice" does.
  err_cannotsendtochan: ([channel = "the channel"], text) =>
    /^cannot send to (channel|nick\/channel)\.?$/i.test(text.trim()) || !text.trim()
      ? `Your message was not sent to ${channel}.`
      : `Your message was not sent to ${channel}: ${reasonOf(text)}.`,
  err_toomanychannels: joinError("you are in too many channels"),
  err_wasnosuchnick: ([nick = "That nick"]) => `The server has no record of ${nick}.`,
  err_toomanytargets: ([target = "that"], text) =>
    `Too many targets for ${target}: ${reasonOf(text)}.`,
  err_norecipient: () => "The message has no recipient.",
  err_notexttosend: () => "There is no text to send.",
  err_unknowncommand: ([command = "That command"]) =>
    `The server does not know the command ${command}.`,
  // Many servers have no MOTD. That is not something to show as an error.
  err_nomotd: () => null,
  err_nonicknamegiven: () => "No nick was given.",
  err_erroneusnickname: ([nick = "That nick"]) => `${nick} can't be used as a nick.`,
  err_nicknameinuse: ([nick = "That nick"]) => `The nick ${nick} is taken.`,
  err_nickcollision: ([nick = "That nick"]) => `The nick ${nick} collided with another user.`,
  err_unavailresource: ([name = "That nick"]) =>
    `${name} is not available right now. Try again later.`,
  // The server's text says how long to wait, which is the useful part.
  err_nicktoofast: (_, text) =>
    text.trim() ? `${reasonOf(text)}.` : "You changed nick too fast. Wait a little.",
  err_targettoofast: (_, text) =>
    text.trim() ? `${reasonOf(text)}.` : "You are sending too fast. Wait a little.",
  err_usernotinchannel: ([nick = "They", channel = "the channel"]) =>
    `${nick} is not in ${channel}.`,
  err_notonchannel: ([channel = "that channel"]) => `You are not in ${channel}.`,
  err_useronchannel: ([nick = "They", channel = "the channel"]) =>
    `${nick} is already in ${channel}.`,
  err_notregistered: () => "The server has not finished logging you in yet.",
  err_needmoreparams: ([command = "The command"]) => `${command} needs more parameters.`,
  err_alreadyregistered: () => "You are already logged in to this server.",
  err_passwdmismatch: () => "The server password is wrong.",
  err_yourebannedcreep: (_, text) => `You are banned from this server: ${reasonOf(text)}.`,
  err_channelisfull: joinError("it is full"),
  err_unknownmode: ([mode = "That mode"]) => `${mode} is not a mode this server knows.`,
  err_inviteonlychan: joinError("it is invite-only. Someone in it must /invite you"),
  err_bannedfromchan: joinError("you are banned from it"),
  err_badchannelkey: ([channel = "the channel"]) =>
    `Can't join ${channel}: it needs a key. Type /join ${channel} <key>.`,
  err_badchanmask: badChannelName,
  err_badchanname: badChannelName,
  err_needreggednick: joinError("you must be logged in to a registered account (SASL)"),
  err_secureonlychan: joinError("it only allows TLS connections"),
  err_banlistfull: ([channel = "the channel"]) => `The ban list of ${channel} is full.`,
  err_noprivileges: () => "Only IRC operators can do that.",
  err_chanoprivsneeded: ([channel = "the channel"]) =>
    `You must be a channel operator in ${channel} to do that.`,
  err_restricted: () => "Your connection is restricted, so the server refused that.",
  err_nononreg: ([nick = "That user"]) =>
    `${nick} only takes messages from users logged in to a registered account.`,
  err_targumodeg: ([nick = "That user"]) =>
    `${nick} only takes messages from people they allowed. The server told them you wrote.`,
  rpl_targnotify: ([nick = "That user"]) => `${nick} was told that you wrote.`,
  err_umodeunknownflag: ([mode]) =>
    mode
      ? `The server does not know the user mode ${mode}.`
      : "The server does not know that user mode.",
  err_usersdontmatch: () => "You can only change your own user modes.",
  err_nicklocked: () => "Login failed: your account's nick is locked.",
  // honk's SASL modes stop the connection on a failed login, and that connection error
  // already says "Login failed" (see describeConnectionError).
  err_saslfail: () => null,
  err_sasltoolong: () => "Login failed: the SASL message was too long.",
  err_saslaborted: () => "Login was aborted.",
  err_saslalready: () => null,
};

/**
 * The text for an error numeric. `subject` is the params between your nick and the
 * trailing text, such as ["#secret"]. Null means show nothing.
 */
export function describeErrorReply(name: string, subject: string[], text: string): string | null {
  const describe = ERROR_TEXT[name];
  if (describe) return describe(subject, text);
  const reason = text.trim();
  if (!reason) return subject.length ? subject.join(" ") : null;
  return subject.length ? `${subject.join(" ")}: ${reason}` : reason;
}

/** "Where" in connection messages: "irc.libera.chat:6697". */
export interface Endpoint {
  host: string;
  port: number;
}

const UNTRUSTED_ISSUER = "it is signed by an authority this computer does not trust";

const CERT_REASONS: Record<string, string> = {
  DEPTH_ZERO_SELF_SIGNED_CERT: "it is self-signed",
  SELF_SIGNED_CERT_IN_CHAIN: "it is signed by a self-signed certificate",
  CERT_HAS_EXPIRED: "it has expired",
  CERT_NOT_YET_VALID: "it is not valid yet",
  ERR_TLS_CERT_ALTNAME_INVALID: "it is for a different host name",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: UNTRUSTED_ISSUER,
  UNABLE_TO_GET_ISSUER_CERT: UNTRUSTED_ISSUER,
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: UNTRUSTED_ISSUER,
  CERT_REVOKED: "it was revoked",
};

/** One line for a rejected TLS certificate. honk stops reconnecting after it. */
export function describeCertError(code: string, at: Endpoint): string {
  const reason = CERT_REASONS[code] ?? `the check failed (${code})`;
  return `The TLS certificate of ${at.host}:${at.port} was rejected: ${reason}. honk stopped reconnecting. Check the host and port, then type /connect.`;
}

/**
 * One line for a failed or lost connection, from a socket error or the server's ERROR
 * line ("ERROR: Closing link ..."). `fatal` adds why honk stopped reconnecting.
 */
export function describeConnectionError(
  err: { message?: string; code?: unknown },
  at: Endpoint,
  fatal = false,
): string {
  const where = `${at.host}:${at.port}`;
  const code = typeof err.code === "string" ? err.code : "";
  const message = err.message ?? "";
  let text: string;
  if (code === "ECONNREFUSED") {
    text = `${where} refused the connection. Check the host and port.`;
  } else if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME") {
    text = `Could not find the host ${at.host}. Check the name and your network.`;
  } else if (code === "ETIMEDOUT") {
    text = `${where} did not answer.`;
  } else if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ENETDOWN") {
    text = `Can't reach ${where}. Check your network.`;
  } else if (code === "ECONNRESET" || code === "EPIPE") {
    text = `${where} closed the connection.`;
  } else if (/^ERROR: Ping timeout/i.test(message)) {
    text = "The server stopped answering (ping timeout).";
  } else if (/^ERROR: SASL auth failed/i.test(message)) {
    const failed = "Login failed: the server rejected the account name or password.";
    return fatal
      ? `${failed} honk stopped reconnecting. Check the account and password in your config, then type /connect.`
      : failed;
  } else if (message.startsWith("ERROR: ")) {
    text = `The server closed the connection: ${reasonOf(message.slice("ERROR: ".length))}.`;
  } else {
    text = `Connection problem with ${where}: ${reasonOf(message || String(err))}.`;
  }
  if (!fatal) return text;
  return `${text} honk stopped reconnecting. Type /connect to try again.`;
}

/** "3 minutes", "1 hour", "2 days". */
export function formatDuration(seconds: number): string {
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  const s = Math.max(0, Math.floor(seconds));
  return `${s} second${s === 1 ? "" : "s"}`;
}

export interface WhoisInfo {
  nick: string;
  username?: string;
  host?: string;
  realname?: string;
  channels?: string[];
  server?: string;
  serverInfo?: string;
  idle?: number;
  away?: string;
  operator?: string;
}

/**
 * WHOIS as a few short lines:
 *
 *   alice is ~alice@example.org (Alice Liddell)
 *   alice is in @#honk #rust
 *   alice is on irc.example.org (Example network)
 *   alice has been idle 5 minutes
 *   alice is away: Gone fishing
 */
export function whoisLines(p: WhoisInfo): string[] {
  const lines: string[] = [];
  const who = p.nick;
  if (p.username || p.host) {
    const mask = [p.username, p.host].filter(Boolean).join("@");
    const real = p.realname && p.realname !== who ? ` (${p.realname})` : "";
    lines.push(`${who} is ${mask}${real}`);
  }
  if (p.channels?.length) lines.push(`${who} is in ${p.channels.join(" ")}`);
  if (p.server) {
    lines.push(`${who} is on ${p.server}${p.serverInfo ? ` (${p.serverInfo})` : ""}`);
  }
  if (p.operator) lines.push(`${who} ${p.operator}`);
  if (p.idle !== undefined && p.idle > 0)
    lines.push(`${who} has been idle ${formatDuration(p.idle)}`);
  if (p.away) lines.push(`${who} is away: ${p.away}`);
  if (lines.length === 0) lines.push(`No details about ${who}.`);
  return lines;
}

/** What a FAIL for each command means, in front of the server's reason. */
const STANDARD_REPLY_PREFIX: Record<string, string> = {
  CHATHISTORY: "Could not load history",
  MARKREAD: "Could not save your read position",
  NICK: "Could not change nick",
  JOIN: "Could not join",
  REGISTER: "Could not register the account",
  AUTHENTICATE: "Login failed",
};

/**
 * A FAIL, WARN or NOTE standard reply (IRCv3), such as
 * "FAIL CHATHISTORY MESSAGE_ERROR #honk :Messages could not be retrieved".
 */
export function describeStandardReply(command: string, description: string): string {
  const prefix = STANDARD_REPLY_PREFIX[command.toUpperCase()];
  const reason = reasonOf(description.trim());
  if (prefix) return reason ? `${prefix}: ${reason}.` : `${prefix}.`;
  return reason ? `${reason}.` : `${command} failed.`;
}
