import { readFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import type { Conn } from "irc-client-ts";

import { commandOf, LineSplitter } from "./ircLine.ts";

/** Called with each line the server sends, without "\r\n", before irc-client-ts reads it. */
type LineListener = (line: string) => void;

/** Called with a line, and what the LineListener threw for it. */
type LineErrorListener = (line: string, err: unknown) => void;

/** Called when the server sends a line longer than MAX_LINE_BYTES, which is dropped. */
type TooLongListener = () => void;

/** The longest part of a line that a report shows. An IRC message is 512 bytes. */
const MAX_LINE_IN_REPORT = 512;

/**
 * How to report what a LineListener threw for `line`: the text for *status, and a key
 * that is the same for the same bug on the same kind of line.
 *
 *   "A bug in honk: it could not handle this line from the server
 *    (no buffer, at onNumeric (manager.ts:1620:11)): :srv 470 goose #a #b :Forwarding"
 */
export function describeLineError(line: string, err: unknown): { key: string; text: string } {
  const { reason, where } = describeError(err);
  const shown =
    line.length > MAX_LINE_IN_REPORT ? `${line.slice(0, MAX_LINE_IN_REPORT)}...` : line;
  return {
    key: `${commandOf(line)} ${reason}`,
    text: `A bug in honk: it could not handle this line from the server (${reason}${where}): ${shown}`,
  };
}

/**
 * How to report what a listener of an irc-client-ts event threw, as describeLineError
 * does for a line. The key is the same for the same bug on the same event.
 *
 *   "A bug in honk: it could not handle the privmsg event (no buffer, at onChat (manager.ts:1480:9))"
 */
export function describeEventError(event: string, err: unknown): { key: string; text: string } {
  const { reason, where } = describeError(err);
  return {
    key: `event ${event} ${reason}`,
    text: `A bug in honk: it could not handle the ${event} event (${reason}${where})`,
  };
}

/** What `err` says, and ", at <first stack frame>" (paths cut to the file name) or "". */
function describeError(err: unknown): { reason: string; where: string } {
  const reason = err instanceof Error ? err.message || err.name : String(err);
  // The first stack frame says which function failed.
  const frame =
    err instanceof Error
      ? err.stack
          ?.split("\n")
          .find((l) => l.trimStart().startsWith("at "))
          ?.trim()
          .replace(/[^\s(]*\//g, "")
      : undefined;
  return { reason, where: frame ? `, ${frame}` : "" };
}

/**
 * Calls `onLine` for each line, and gives what it throws to `onLineError`.
 *
 * The lines are split inside the socket's "data" listener. Since Bun 1.4.3, as in
 * Node, an error thrown there goes to uncaughtException, which would end honk. It
 * would also skip the rest of the chunk, so irc-client-ts would lose those bytes.
 */
export function guardLines(onLine: LineListener, onLineError: LineErrorListener): LineListener {
  const report = neverThrow(onLineError);
  return (line) => {
    try {
      onLine(line);
    } catch (err) {
      report(line, err);
    }
  };
}

/**
 * `fn`, but what it throws is dropped. For a callback that only reports something and
 * runs where a throw would end honk or the connection: inside the socket's "data"
 * listener (see guardLines), or inside irc-client-ts's read loop.
 */
export function neverThrow<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    try {
      fn(...args);
    } catch {
      // Dropped on purpose.
    }
  };
}

class NodeSocketConn implements Conn {
  private socket: Socket;
  private chunks: Uint8Array[] = [];
  private pendingRead: {
    resolve: (n: number | null) => void;
    reject: (err: unknown) => void;
    buffer: Uint8Array;
  } | null = null;
  private ended = false;
  private error: unknown = null;

  constructor(socket: Socket, onLine: LineListener, onTooLong: TooLongListener) {
    this.socket = socket;
    const lines = new LineSplitter(onLine, onTooLong);

    socket.on("data", (chunk: Buffer) => {
      // irc-client-ts gets only whole lines, without the ones that were too long. Its
      // own buffer for an unfinished line has no limit, so it must never get one.
      const bytes = lines.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if (bytes.length === 0) return;
      if (this.pendingRead) {
        const req = this.pendingRead;
        this.pendingRead = null;
        const len = Math.min(bytes.length, req.buffer.length);
        req.buffer.set(bytes.subarray(0, len));
        if (bytes.length > req.buffer.length) {
          this.chunks.push(bytes.subarray(req.buffer.length));
        }
        req.resolve(len);
      } else {
        this.chunks.push(bytes);
      }
    });

    const onFinish = () => {
      this.ended = true;
      if (this.pendingRead) {
        const req = this.pendingRead;
        this.pendingRead = null;
        req.resolve(null);
      }
    };

    socket.on("end", onFinish);
    socket.on("close", onFinish);

    socket.on("error", (err) => {
      this.error = err;
      if (this.pendingRead) {
        const req = this.pendingRead;
        this.pendingRead = null;
        req.reject(err);
      }
    });
  }

  read(buffer: Uint8Array): Promise<number | null> {
    if (this.chunks.length > 0) {
      const chunk = this.chunks.shift()!;
      const len = Math.min(chunk.length, buffer.length);
      buffer.set(chunk.subarray(0, len));
      if (chunk.length > buffer.length) {
        this.chunks.unshift(chunk.subarray(buffer.length));
      }
      return Promise.resolve(len);
    }
    if (this.ended) return Promise.resolve(null);
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.pendingRead = { resolve, reject, buffer };
    });
  }

  write(bytes: Uint8Array): Promise<number> {
    return new Promise((resolve, reject) => {
      this.socket.write(bytes, (err) => {
        if (err) reject(err);
        else resolve(bytes.length);
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

const sharedRuntime = {
  readTextFileSync(path: string): string {
    return readFileSync(path, "utf-8");
  },

  isSilentError(error: unknown): boolean {
    if (error instanceof Error && "code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ERR_STREAM_DESTROYED" || code === "ECONNRESET";
    }
    return false;
  },
};

/**
 * Waits for `socket` to connect. If `signal` aborts first, the socket is destroyed
 * and the promise rejects, so a slow handshake can't finish after the caller gave up.
 */
function whenConnected(
  socket: Socket,
  connectEvent: "connect" | "secureConnect",
  signal: AbortSignal | undefined,
  onLine: LineListener,
  onTooLong: TooLongListener,
): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      socket.destroy();
      reject(new Error("Connection attempt aborted"));
    };
    const cleanup = () => {
      socket.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    socket.once(connectEvent, () => {
      cleanup();
      resolve(new NodeSocketConn(socket, onLine, onTooLong));
    });
    socket.once("error", onError);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A node:net / node:tls runtime for irc-client-ts. Aborting `signal` cancels a pending
 * connect. `onLine` sees every line from the server first (see IrcManager.onRawLine).
 * When it throws, `onLineError` gets the line and the error, and the connection goes on.
 * A line longer than MAX_LINE_BYTES is dropped, and `onTooLong` is called.
 */
export function createNodeRuntime(
  signal: AbortSignal | undefined,
  onLine: LineListener,
  onLineError: LineErrorListener,
  onTooLong: TooLongListener,
) {
  onLine = guardLines(onLine, onLineError);
  onTooLong = neverThrow(onTooLong);
  return {
    connect(opts: { hostname: string; port: number }): Promise<Conn> {
      return whenConnected(netConnect(opts.port, opts.hostname), "connect", signal, onLine, onTooLong);
    },

    connectTls(opts: {
      hostname: string;
      port: number;
      caCerts?: string[];
      cert?: string;
      key?: string;
    }): Promise<Conn> {
      const tlsOpts: ConnectionOptions = {
        host: opts.hostname,
        port: opts.port,
        servername: opts.hostname,
        ...(opts.caCerts ? { ca: opts.caCerts.join("\n") } : {}),
        ...(opts.cert ? { cert: opts.cert } : {}),
        ...(opts.key ? { key: opts.key } : {}),
      };
      return whenConnected(tlsConnect(tlsOpts), "secureConnect", signal, onLine, onTooLong);
    },

    ...sharedRuntime,
  };
}
