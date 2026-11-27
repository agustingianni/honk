import { expect, test } from "bun:test";
import {
  commandOf,
  LineSplitter,
  parseLine,
  parseTimestampParam,
  timestampParam,
} from "./ircLine.ts";

test("parseLine splits tags, source, command and the trailing param", () => {
  expect(parseLine("@time=x;msgid=1 :a!b@c PRIVMSG #honk :hi there")).toEqual({
    tags: { time: "x", msgid: "1" },
    source: "a!b@c",
    command: "PRIVMSG",
    params: ["#honk", "hi there"],
  });
  expect(parseLine("NICK goose")).toEqual({ tags: {}, command: "NICK", params: ["goose"] });
});

test("LineSplitter cuts on \\n, drops \\r, and keeps a split UTF-8 character whole", () => {
  const lines: string[] = [];
  const split = new LineSplitter((l) => lines.push(l));
  const bytes = new TextEncoder().encode("PRIVMSG #a :café\r\nPING x\n");
  split.push(bytes.subarray(0, 16)); // ends inside the two bytes of "é"
  split.push(bytes.subarray(16));
  expect(lines).toEqual(["PRIVMSG #a :café", "PING x"]);
});

test("commandOf finds the same command as parseLine", () => {
  const lines = [
    "@time=x;msgid=1 :a!b@c PRIVMSG #honk :hi there",
    ":srv 470 goose #old #new :Forwarding",
    "@time=x :srv 717 goose alice :has been informed",
    "NICK goose",
    "ping :123",
    ":srv  433  *  goose :in use",
    "",
  ];
  for (const line of lines) expect(commandOf(line)).toBe(parseLine(line).command);
});

test("timestampParam and parseTimestampParam write and read the IRCv3 timestamp", () => {
  const ms = Date.parse("2026-11-26T22:00:00Z");
  expect(timestampParam(ms)).toBe("timestamp=2026-11-26T22:00:00.000Z");
  expect(parseTimestampParam(timestampParam(ms))).toBe(ms);
  expect(parseTimestampParam("*")).toBeUndefined();
  expect(parseTimestampParam("timestamp=soon")).toBeUndefined();
  expect(parseTimestampParam("msgid=abc")).toBeUndefined();
  expect(parseTimestampParam(undefined)).toBeUndefined();
});
