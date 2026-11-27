import { expect, test } from "bun:test";
import { isUserSender, UNKNOWN_SENDER } from "./names.ts";

test("only a nick counts as a person to message, not a server or a missing source", () => {
  expect(isUserSender("alice")).toBe(true);
  expect(isUserSender("[m]bob|away")).toBe(true);
  expect(isUserSender("irc.example.net")).toBe(false);
  expect(isUserSender(UNKNOWN_SENDER)).toBe(false);
  expect(isUserSender("")).toBe(false);
});
