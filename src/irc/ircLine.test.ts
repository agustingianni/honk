import { describe, expect, test } from "bun:test";
import {
  commandOf,
  LineSplitter,
  MAX_LINE_BYTES,
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

describe("LineSplitter with a line that is too long", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  function splitter() {
    const lines: string[] = [];
    let tooLong = 0;
    const split = new LineSplitter(
      (l) => lines.push(l),
      () => tooLong++,
    );
    const pendingBytes = () => (split as unknown as { pendingBytes: number }).pendingBytes;
    return { split, lines, tooLong: () => tooLong, pendingBytes };
  }

  test("keeps at most MAX_LINE_BYTES of a line with no newline, and drops it", () => {
    const { split, lines, tooLong, pendingBytes } = splitter();
    const kilobyte = encode("x".repeat(1024));
    for (let i = 0; i < 100; i++) {
      split.push(kilobyte);
      expect(pendingBytes()).toBeLessThanOrEqual(MAX_LINE_BYTES);
    }
    // "ok" is the end of the long line, so it goes too. The next line comes through.
    split.push(encode("ok\r\n"));
    split.push(encode("PING next\r\n"));
    expect(lines).toEqual(["PING next"]);
    expect(tooLong()).toBe(1);
    expect(pendingBytes()).toBe(0);
  });

  test("drops a long line inside one chunk, and keeps the lines around it", () => {
    const { split, lines, tooLong } = splitter();
    const returned = split.push(encode(`PING a\r\n${"x".repeat(100_000)}\r\nPING b\r\n`));
    expect(lines).toEqual(["PING a", "PING b"]);
    expect(decode(returned)).toBe("PING a\r\nPING b\r\n");
    expect(tooLong()).toBe(1);
  });

  test("keeps a line of exactly MAX_LINE_BYTES, and drops one byte more", () => {
    const { split, lines, tooLong } = splitter();
    const fits = `@${"t".repeat(MAX_LINE_BYTES - 3)}\r\n`;
    const over = `@${"t".repeat(MAX_LINE_BYTES - 2)}\r\n`;
    split.push(encode(fits.slice(0, 5000)));
    split.push(encode(fits.slice(5000)));
    split.push(encode(over));
    expect(lines).toEqual([fits.slice(0, -2)]);
    expect(tooLong()).toBe(1);
  });

  test("keeps a U+FEFF at the start of a line", () => {
    const { split, lines } = splitter();
    split.push(encode("PING a\r\n\uFEFFPING b\r\n"));
    expect(lines).toEqual(["PING a", "\uFEFFPING b"]);
  });

  test("returns only the bytes of whole lines", () => {
    const { split } = splitter();
    expect(decode(split.push(encode("PING a\r\nPI")))).toBe("PING a\r\n");
    expect(decode(split.push(encode("NG b")))).toBe("");
    expect(decode(split.push(encode("\r\n")))).toBe("PING b\r\n");
  });
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
