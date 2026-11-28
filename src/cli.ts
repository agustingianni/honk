// What to do with the command line, decided before honk reads the config or
// takes over the terminal.

export type CliAction =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "upgrade" }
  /** A first word that is not a command, such as a typo of "upgrade". */
  | { kind: "unknown"; word: string }
  /** Start the client. config.ts reads the flags. */
  | { kind: "run" };

export const COMMANDS = ["upgrade"] as const;

export function cliAction(args: string[]): CliAction {
  if (args.includes("--help") || args.includes("-h")) return { kind: "help" };
  if (args.includes("--version") || args.includes("-v")) return { kind: "version" };
  const first = args[0];
  // Every option starts with "-". A first word that does not is a command.
  if (first !== undefined && !first.startsWith("-")) {
    return first === "upgrade" ? { kind: "upgrade" } : { kind: "unknown", word: first };
  }
  return { kind: "run" };
}

export const HELP = `honk: an IRC client for your terminal

Usage:
  honk [options]          start honk
  honk upgrade            install the latest release, if the install script
                          installed honk

Options:
  --server host[:port]    connect to this server (TLS on port 6697 by default)
  --port port             the server's port
  --nick nick             your nick
  --channel name          join this channel (repeat for more channels)
  --password password     log in with SASL
  --sasl                  use SASL
  --no-tls                connect without TLS
  --config path           read this config file
  --theme name            use this color theme, such as nord
  --timestamps format     the time on chat lines: HH:mm, HH:mm:ss, "h:mm a"
                          or none
  --ascii                 draw only ASCII symbols, for fonts or terminals
                          that show the Unicode ones wrong
  --no-mouse              leave the mouse to the terminal, to select text
  --demo                  the offline demo, with made-up networks and people
  -v, --version           print the version
  -h, --help              print this help

Environment:
  HONK_NO_UPDATE_CHECK=1  do not check for new releases

More: https://github.com/agustingianni/honk#readme`;

export function unknownCommandText(word: string): string {
  return `honk: unknown command "${word}". The commands are: ${COMMANDS.join(", ")}. Run honk --help for more.`;
}
