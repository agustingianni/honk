import { afterEach, describe, expect, test } from "bun:test";
import { type AddressInfo, createServer, type Server } from "node:net";
import { until } from "../../dev/fakeircd/testing.ts";
import { LineSplitter } from "./ircLine.ts";
import { createNodeRuntime, describeLineError, guardLines } from "./runtime.ts";

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

/** A server that sends `data` to each client that connects. Returns its port. */
async function serve(data: string): Promise<number> {
  server = createServer((socket) => socket.write(data));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** Everything irc-client-ts would read from `conn`, until `text` has arrived. */
async function readUntil(conn: { read(b: Uint8Array): Promise<number | null> }, text: string) {
  let got = "";
  const buffer = new Uint8Array(1024);
  while (!got.includes(text)) {
    const n = await conn.read(buffer);
    if (n === null) break;
    got += new TextDecoder().decode(buffer.subarray(0, n));
  }
  return got;
}

test("a line that throws does not stop the lines after it in the same chunk", () => {
  const seen: string[] = [];
  const errors: string[] = [];
  const lines = new LineSplitter(
    guardLines(
      (line) => {
        seen.push(line);
        if (line === "BOOM") throw new Error("cannot handle it");
      },
      (line, err) => errors.push(`${line}: ${(err as Error).message}`),
    ),
  );
  // One chunk, as one "data" event delivers it.
  expect(() => lines.push(new TextEncoder().encode("one\r\nBOOM\r\nthree\r\n"))).not.toThrow();
  expect(seen).toEqual(["one", "BOOM", "three"]);
  expect(errors).toEqual(["BOOM: cannot handle it"]);
});

test("an error from the error listener itself is dropped", () => {
  const listener = guardLines(
    () => {
      throw new Error("first");
    },
    () => {
      throw new Error("second");
    },
  );
  expect(() => listener("BOOM")).not.toThrow();
});

test("a line listener that throws does not stop the data for irc-client-ts", async () => {
  const port = await serve("one\r\nBOOM\r\nthree\r\n");
  const seen: string[] = [];
  const errors: string[] = [];
  const runtime = createNodeRuntime(
    undefined,
    (line) => {
      seen.push(line);
      if (line === "BOOM") throw new Error("cannot handle it");
    },
    (line, err) => errors.push(`${line}: ${(err as Error).message}`),
  );

  const conn = await runtime.connect({ hostname: "127.0.0.1", port });
  try {
    // irc-client-ts still gets every byte, the bad line included.
    expect(await readUntil(conn, "three\r\n")).toBe("one\r\nBOOM\r\nthree\r\n");
    await until(() => seen.length === 3);
    expect(seen).toEqual(["one", "BOOM", "three"]);
    expect(errors).toEqual(["BOOM: cannot handle it"]);
  } finally {
    conn.close();
  }
});

test("irc-client-ts does not get a line that is too long", async () => {
  const port = await serve(`one\r\n${"x".repeat(100_000)}\r\ntwo\r\n`);
  const seen: string[] = [];
  let tooLong = 0;
  const runtime = createNodeRuntime(
    undefined,
    (line) => seen.push(line),
    () => {},
    () => tooLong++,
  );

  const conn = await runtime.connect({ hostname: "127.0.0.1", port });
  try {
    expect(await readUntil(conn, "two\r\n")).toBe("one\r\ntwo\r\n");
    expect(seen).toEqual(["one", "two"]);
    expect(tooLong).toBe(1);
  } finally {
    conn.close();
  }
});

test("an onTooLong that throws does not stop the data for irc-client-ts", async () => {
  const port = await serve(`${"x".repeat(100_000)}\r\ntwo\r\n`);
  const runtime = createNodeRuntime(
    undefined,
    () => {},
    () => {},
    () => {
      throw new Error("cannot report it");
    },
  );

  const conn = await runtime.connect({ hostname: "127.0.0.1", port });
  try {
    expect(await readUntil(conn, "two\r\n")).toBe("two\r\n");
  } finally {
    conn.close();
  }
});

describe("describeLineError", () => {
  function throwInOnNumeric(message: string): unknown {
    function onNumeric() {
      throw new Error(message);
    }
    try {
      onNumeric();
    } catch (err) {
      return err;
    }
  }

  test("says what failed and where, with the file name only", () => {
    const { text } = describeLineError(":srv 470 goose #a #b :Forwarding", throwInOnNumeric("no buffer"));
    expect(text).toStartWith("A bug in honk: it could not handle this line from the server (no buffer, at onNumeric (runtime.test.ts:");
    expect(text).toEndWith("): :srv 470 goose #a #b :Forwarding");
  });

  test("gives the same key for the same bug on the same command", () => {
    const a = describeLineError(":srv 470 goose #a #b :x", new Error("no buffer"));
    const b = describeLineError("@time=1 :srv 470 goose #c #d :y", new Error("no buffer"));
    const other = describeLineError(":srv 477 goose #a :x", new Error("no buffer"));
    expect(a.key).toBe(b.key);
    expect(other.key).not.toBe(a.key);
  });

  test("names an error without a message, and a thrown value that is not an Error", () => {
    expect(describeLineError("PING :x", new TypeError("")).text).toContain("(TypeError, at ");
    expect(describeLineError("PING :x", "just a string").text).toContain("(just a string): PING :x");
  });

  test("cuts a long line to 512 characters", () => {
    const line = `:srv NOTICE goose :${"x".repeat(2000)}`;
    const { text } = describeLineError(line, "bug");
    expect(text).toEndWith(`${line.slice(0, 512)}...`);
  });
});
