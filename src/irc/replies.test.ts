import { describe, expect, test } from "bun:test";
// Not exported by the package. Read here only to check the list below against it.
import { PROTOCOL } from "../../node_modules/irc-client-ts/dist/core/protocol.js";
import {
  describeCertError,
  describeConnectionError,
  describeErrorReply,
  describeStandardReply,
  formatDuration,
  NUMERICS_MISSING_FROM_LIBRARY,
  whoisLines,
} from "./replies.ts";

const at = { host: "irc.example.org", port: 6697 };

describe("NUMERICS_MISSING_FROM_LIBRARY", () => {
  test("irc-client-ts still doesn't know them, so no line is shown twice", () => {
    const known = (PROTOCOL as { ALL: Record<string, string> }).ALL;
    for (const numeric of Object.keys(NUMERICS_MISSING_FROM_LIBRARY)) {
      expect(known[numeric]).toBeUndefined();
    }
  });
});

describe("describeErrorReply", () => {
  test.each([
    [
      "err_bannedfromchan",
      ["#x"],
      "Cannot join channel (+b)",
      "Can't join #x: you are banned from it.",
    ],
    [
      "err_badchannelkey",
      ["#x"],
      "Cannot join channel (+k)",
      "Can't join #x: it needs a key. Type /join #x <key>.",
    ],
    [
      "err_inviteonlychan",
      ["#x"],
      "",
      "Can't join #x: it is invite-only. Someone in it must /invite you.",
    ],
    [
      "err_needreggednick",
      ["#x"],
      "",
      "Can't join #x: you must be logged in to a registered account (SASL).",
    ],
    ["err_nicknameinuse", ["alice"], "Nickname is already in use", "The nick alice is taken."],
    ["err_nosuchnick", ["zed"], "No such nick/channel", "zed is not on this server."],
    [
      "err_chanoprivsneeded",
      ["#x"],
      "You're not channel operator",
      "You must be a channel operator in #x to do that.",
    ],
    ["err_usernotinchannel", ["bob", "#x"], "They aren't on that channel", "bob is not in #x."],
    [
      "err_nicktoofast",
      ["new"],
      "Nick change too fast. Please wait 30 seconds.",
      "Nick change too fast. Please wait 30 seconds.",
    ],
  ])("%s", (name, subject, text, want) => {
    expect(describeErrorReply(name, subject, text)).toBe(want);
  });

  test("a bare 'Cannot send to channel' isn't repeated, a real reason is kept", () => {
    expect(describeErrorReply("err_cannotsendtochan", ["#x"], "Cannot send to channel")).toBe(
      "Your message was not sent to #x.",
    );
    expect(describeErrorReply("err_cannotsendtochan", ["#x"], "Cannot send to channel (+m)")).toBe(
      "Your message was not sent to #x: Cannot send to channel (+m).",
    );
  });

  test("an unknown user mode is named when the server says which", () => {
    // InspIRCd: ":server 501 goose x :is not a recognised user mode."
    expect(
      describeErrorReply("err_umodeunknownflag", ["x"], "is not a recognised user mode."),
    ).toBe("The server does not know the user mode x.");
    expect(describeErrorReply("err_umodeunknownflag", [], "Unknown MODE flag")).toBe(
      "The server does not know that user mode.",
    );
  });

  test("a missing MOTD shows nothing", () => {
    expect(describeErrorReply("err_nomotd", [], "MOTD File is missing")).toBeNull();
  });

  test("an error with no wording of its own shows the server's text, never its raw name", () => {
    expect(describeErrorReply("err_dontcheat", ["X"], "Don't cheat")).toBe("X: Don't cheat");
    expect(describeErrorReply("err_somethingnew", [], "Something broke")).toBe("Something broke");
  });
});

describe("describeConnectionError", () => {
  test.each([
    [
      { code: "ECONNREFUSED" },
      "irc.example.org:6697 refused the connection. Check the host and port.",
    ],
    [
      { code: "ENOTFOUND" },
      "Could not find the host irc.example.org. Check the name and your network.",
    ],
    [{ code: "ENETUNREACH" }, "Can't reach irc.example.org:6697. Check your network."],
    [{ message: "ERROR: Ping timeout" }, "The server stopped answering (ping timeout)."],
    [
      { message: "ERROR: Closing Link: x (Quit)" },
      "The server closed the connection: Closing Link: x (Quit).",
    ],
    [{ message: "something odd" }, "Connection problem with irc.example.org:6697: something odd."],
  ])("%o", (err, want) => {
    expect(describeConnectionError(err, at)).toBe(want);
  });

  test("a fatal error says that honk stopped, and what to do", () => {
    expect(describeConnectionError({ message: "ERROR: Closing Link: x (K-Lined)" }, at, true)).toBe(
      "The server closed the connection: Closing Link: x (K-Lined). honk stopped reconnecting. Type /connect to try again.",
    );
    expect(describeConnectionError({ message: "ERROR: SASL auth failed" }, at, true)).toBe(
      "Login failed: the server rejected the account name or password. honk stopped reconnecting. Check the account and password in your config, then type /connect.",
    );
  });
});

describe("describeCertError", () => {
  test("names the reason in words", () => {
    expect(describeCertError("CERT_HAS_EXPIRED", at)).toBe(
      "The TLS certificate of irc.example.org:6697 was rejected: it has expired. honk stopped reconnecting. Check the host and port, then type /connect.",
    );
  });

  test("an unknown code is still shown", () => {
    expect(describeCertError("ODD_CODE", at)).toContain("rejected: the check failed (ODD_CODE).");
  });
});

describe("whoisLines", () => {
  test("one fact per line", () => {
    expect(
      whoisLines({
        nick: "alice",
        username: "~alice",
        host: "example.org",
        realname: "Alice Liddell",
        channels: ["@#honk", "#rust"],
        server: "irc.example.org",
        serverInfo: "Example",
        idle: 300,
        away: "Gone fishing",
      }),
    ).toEqual([
      "alice is ~alice@example.org (Alice Liddell)",
      "alice is in @#honk #rust",
      "alice is on irc.example.org (Example)",
      "alice has been idle 5 minutes",
      "alice is away: Gone fishing",
    ]);
  });

  test("a real name equal to the nick is not repeated", () => {
    expect(whoisLines({ nick: "bob", username: "bob", host: "h", realname: "bob" })).toEqual([
      "bob is bob@h",
    ]);
  });
});

test("formatDuration", () => {
  expect([1, 59, 60, 3_600, 7_200, 86_400 * 3].map(formatDuration)).toEqual([
    "1 second",
    "59 seconds",
    "1 minute",
    "1 hour",
    "2 hours",
    "3 days",
  ]);
});

test("describeStandardReply", () => {
  expect(describeStandardReply("CHATHISTORY", "Messages could not be retrieved")).toBe(
    "Could not load history: Messages could not be retrieved.",
  );
  expect(describeStandardReply("MARKREAD", "Internal error")).toBe(
    "Could not save your read position: Internal error.",
  );
  expect(describeStandardReply("SOMETHING", "It went wrong.")).toBe("It went wrong.");
});
