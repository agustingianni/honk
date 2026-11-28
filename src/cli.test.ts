import { describe, expect, test } from "bun:test";
import { cliAction, HELP, unknownCommandText } from "./cli.ts";

describe("cliAction", () => {
  test.each([
    [[], { kind: "run" }],
    [["--demo"], { kind: "run" }],
    [["--server", "irc.libera.chat", "--channel", "#honk"], { kind: "run" }],
    [["--help"], { kind: "help" }],
    [["-h"], { kind: "help" }],
    [["upgrade", "--help"], { kind: "help" }],
    [["--version"], { kind: "version" }],
    [["-v"], { kind: "version" }],
    [["upgrade"], { kind: "upgrade" }],
    [["upgarde"], { kind: "unknown", word: "upgarde" }],
    [["irc.libera.chat"], { kind: "unknown", word: "irc.libera.chat" }],
  ] as const)("%j", (args, expected) => {
    expect(cliAction([...args])).toEqual(expected);
  });
});

describe("help text", () => {
  test("lists every flag that config.ts reads", () => {
    for (const flag of ["--server", "--port", "--nick", "--channel", "--password", "--sasl", "--no-tls", "--config", "--timestamps", "--demo"]) {
      expect(HELP).toContain(flag);
    }
  });

  test("names the commands for an unknown word", () => {
    expect(unknownCommandText("upgarde")).toBe(
      'honk: unknown command "upgarde". The commands are: upgrade. Run honk --help for more.',
    );
  });
});
