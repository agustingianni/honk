import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CASEMAPPING,
  isUserSender,
  nameKey,
  parseCasemapping,
  sameNick,
  UNKNOWN_SENDER,
} from "./names.ts";

test("only a nick counts as a person to message, not a server or a missing source", () => {
  expect(isUserSender("alice")).toBe(true);
  expect(isUserSender("[m]bob|away")).toBe(true);
  expect(isUserSender("irc.example.net")).toBe(false);
  expect(isUserSender(UNKNOWN_SENDER)).toBe(false);
  expect(isUserSender("")).toBe(false);
});

describe("nameKey", () => {
  test("rfc1459 folds A-Z and [ \\ ] ^ onto a-z and { | } ~", () => {
    expect(nameKey("#FOO[", "rfc1459")).toBe("#foo{");
    expect(nameKey("Alice^", "rfc1459")).toBe(nameKey("alice~", "rfc1459"));
    expect(nameKey("[M]Bob\\", "rfc1459")).toBe("{m}bob|");
  });

  test("rfc1459-strict folds [ \\ ] but keeps ^ and ~ apart", () => {
    expect(nameKey("#FOO[", "rfc1459-strict")).toBe("#foo{");
    expect(nameKey("Alice^", "rfc1459-strict")).toBe("alice^");
    expect(nameKey("alice~", "rfc1459-strict")).toBe("alice~");
  });

  test("ascii folds only A-Z", () => {
    expect(nameKey("#FOO[", "ascii")).toBe("#foo[");
    expect(nameKey("Alice^", "ascii")).toBe("alice^");
  });

  test("rfc8265 folds letters outside A-Z and width forms too", () => {
    expect(nameKey("Ärger", "rfc8265")).toBe(nameKey("ärger", "rfc8265"));
    expect(nameKey("ＡＢＣ", "rfc8265")).toBe("abc");
    expect(nameKey("#FOO[", "rfc8265")).toBe("#foo[");
  });

  test("the byte mappings fold no letter outside A-Z", () => {
    expect(nameKey("#CAFÉ", "rfc1459")).toBe("#cafÉ");
    expect(nameKey("#CAFÉ", "ascii")).toBe("#cafÉ");
  });
});

test("sameNick compares with the mapping it is given", () => {
  expect(sameNick("Alice^", "alice~", "rfc1459")).toBe(true);
  expect(sameNick("Alice^", "alice~", "ascii")).toBe(false);
  expect(sameNick("Alice^", "alice~", "rfc1459-strict")).toBe(false);
  expect(sameNick("bob[m]", "BOB{M}", "rfc1459-strict")).toBe(true);
  expect(sameNick(undefined, "bob", "rfc1459")).toBe(false);
});

describe("parseCasemapping", () => {
  test("reads the three mappings honk knows", () => {
    expect(parseCasemapping("ascii")).toBe("ascii");
    expect(parseCasemapping("rfc1459")).toBe("rfc1459");
    expect(parseCasemapping("rfc1459-strict")).toBe("rfc1459-strict");
  });

  test("a server that sends none gets rfc1459", () => {
    expect(parseCasemapping(undefined)).toBe("rfc1459");
    expect(parseCasemapping("")).toBe("rfc1459");
    expect(DEFAULT_CASEMAPPING).toBe("rfc1459");
  });

  test("reads the older spelling strict-rfc1459, and any case", () => {
    expect(parseCasemapping("strict-rfc1459")).toBe("rfc1459-strict");
    expect(parseCasemapping("RFC1459")).toBe("rfc1459");
    expect(parseCasemapping("Ascii")).toBe("ascii");
  });

  test("reads PRECIS as rfc8265, also under its older name rfc7613", () => {
    expect(parseCasemapping("rfc8265")).toBe("rfc8265");
    expect(parseCasemapping("rfc7613")).toBe("rfc8265");
  });

  test("an unknown mapping folds as ascii", () => {
    expect(parseCasemapping("made-up")).toBe("ascii");
  });
});
