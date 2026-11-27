/** The slash commands that IrcManager.handleCommand runs, for completion, /help and the omnibox. */
export interface SlashCommand {
  name: string;
  /** Argument syntax. An argument in <angle brackets> is required. */
  args?: string;
  summary: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "join", args: "<#channel>[,#more] [key]", summary: "Join channels" },
  { name: "part", args: "[reason]", summary: "Leave this channel, or close this DM" },
  { name: "msg", args: "<nick|#channel> [text]", summary: "Open a DM, and send text if given" },
  { name: "query", args: "<nick|#channel> [text]", summary: "Same as /msg" },
  { name: "me", args: "<action>", summary: "Send an action" },
  { name: "nick", args: "<newnick>", summary: "Change your nick" },
  { name: "topic", args: "[text]", summary: "Show or set this channel's topic" },
  { name: "whois", args: "<nick>", summary: "Look up a user" },
  { name: "history", args: "[count]", summary: "Load older messages" },
  {
    name: "connect",
    args: "<host> [port|+tlsport] [nick]",
    summary: "Connect to a server (no host: reconnect this one)",
  },
  { name: "disconnect", args: "[reason]", summary: "Disconnect from this server" },
  { name: "raw", args: "<COMMAND ...>", summary: "Send a raw IRC line" },
  { name: "clear", summary: "Clear this buffer" },
  { name: "search", args: "[words]", summary: "Search your chat logs (also Ctrl+F)" },
  { name: "demo", summary: "Open the offline demo" },
  { name: "help", summary: "List the commands" },
  { name: "quit", summary: "Quit the app" },
];

/** True if the command can't run without arguments ("/whois" alone only prints its usage). */
export function needsArgs(cmd: SlashCommand): boolean {
  return cmd.args?.startsWith("<") ?? false;
}

/** How to type it, as /help and the omnibox show it: "/whois <nick>", "/clear". */
export function syntax(cmd: SlashCommand): string {
  return cmd.args ? `/${cmd.name} ${cmd.args}` : `/${cmd.name}`;
}

/** The words after "/search", or undefined if `line` is not a /search command. */
export function searchCommand(line: string): string | undefined {
  const m = /^\/search(?:\s+(.*))?$/i.exec(line.trim());
  return m ? (m[1] ?? "") : undefined;
}

export function findSlashCommand(name: string): SlashCommand | undefined {
  const lower = name.toLowerCase();
  return SLASH_COMMANDS.find((c) => c.name === lower);
}
