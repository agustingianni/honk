import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttestationResult,
  checkLength,
  checksumFor,
  compareVersions,
  defaultReceiptPath,
  REPO,
  upgrade,
  type UpgradeOptions,
} from "./upgrade.ts";

// A fake github.com with one release. Tests change `release` to shape it.
const release = {
  tag: "v0.3.0" as string | undefined, // undefined: the repo has no releases
  asset: new Uint8Array(), // the bytes of honk-linux-x64.gz
  sums: "", // filled from `asset` unless a test sets it
  // Which download goes to rawServer, and how that server breaks it (see there).
  broken: undefined as { file: "asset" | "sums"; how: Break } | undefined,
  refused: false, // true: the asset download goes to a port where nothing listens
};
const requests: string[] = [];

// How rawServer sends a file:
// - cut: promises the whole file with Content-Length, sends half, and closes.
// - stall: sends half and keeps the connection open without sending more.
// - silent: accepts the connection and never answers.
// - slow: sends the whole file in 5 parts, 100 ms apart.
// - late: sends the headers after 200 ms, and the whole file 200 ms after that.
type Break = "cut" | "stall" | "silent" | "slow" | "late";
const SLOW_GAP_MS = 100;

// Bun.serve cannot do these, because it fixes up the Content-Length. node:net,
// because its write() buffers all the bytes and end() sends them before it closes.
// The request path is /<how>/<file>.
const rawSockets = new Set<Socket>();
const rawServer = createServer((socket) => {
  rawSockets.add(socket);
  socket.on("close", () => rawSockets.delete(socket));
  socket.on("error", () => {}); // the client aborts stalled requests
  socket.once("data", (request) => {
    const [, how, file] = /^\S+ \/(\w+)\/(\S*)/.exec(request.toString()) ?? [];
    if (how === "silent") return;
    const whole = file === "sums" ? new TextEncoder().encode(release.sums) : release.asset;
    // It answers one request per connection, so fetch() must not reuse one.
    const headers = `HTTP/1.1 200 OK\r\nContent-Length: ${whole.length}\r\nConnection: close\r\n\r\n`;
    if (how === "late") {
      setTimeout(() => socket.write(headers), 200);
      setTimeout(() => socket.end(whole), 400);
      return;
    }
    socket.write(headers);
    const half = whole.subarray(0, Math.floor(whole.length / 2));
    if (how === "cut") socket.end(half);
    else if (how === "stall") socket.write(half);
    else if (how === "slow") {
      const part = Math.ceil(whole.length / 5);
      for (let i = 0; i < 5; i++) {
        setTimeout(() => {
          if (!socket.destroyed) socket.write(whole.subarray(i * part, (i + 1) * part));
        }, i * SLOW_GAP_MS);
      }
    }
  });
});
await new Promise<void>((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
const rawUrl = `http://127.0.0.1:${(rawServer.address() as AddressInfo).port}`;

// A URL where nothing listens. The OS never hands out port 1 as a free port,
// and almost nothing listens on it.
const refusedUrl = "http://127.0.0.1:1";

const server = Bun.serve({
  port: 0,
  fetch(req): Response {
    const { origin, pathname: path } = new URL(req.url);
    requests.push(`${req.method} ${path}`);
    if (path === `/${REPO}/releases/latest`) {
      const to = release.tag ? `/${REPO}/releases/tag/${release.tag}` : `/${REPO}/releases`;
      // GitHub sends an absolute URL.
      return new Response(null, { status: 302, headers: { location: `${origin}${to}` } });
    }
    const download = `/${REPO}/releases/download/${release.tag}/`;
    // GitHub redirects downloads to another host. Send the one to break to rawServer.
    const broken = release.broken;
    if (path === `${download}SHA256SUMS`) {
      if (broken?.file === "sums") return Response.redirect(`${rawUrl}/${broken.how}/sums`, 302);
      return new Response(release.sums);
    }
    if (path === `${download}honk-linux-x64.gz`) {
      if (broken?.file === "asset") return Response.redirect(`${rawUrl}/${broken.how}/asset.gz`, 302);
      if (release.refused) return Response.redirect(`${refusedUrl}/asset.gz`, 302);
      return new Response(release.asset);
    }
    return new Response("not found", { status: 404 });
  },
});
const githubUrl = server.url.origin;

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Makes `bytes` the release's honk-linux-x64.gz, with a matching SHA256SUMS. */
function setAsset(bytes: typeof release.asset) {
  release.asset = bytes;
  release.sums = `${sha256(bytes)}  honk-linux-x64.gz\n`;
}
const root = mkdtempSync(join(tmpdir(), "honk-upgrade-test-"));
let dir: string;
let binary: string;
let receipt: string;
let logs: string[];

function options(overrides: Partial<UpgradeOptions> = {}): UpgradeOptions {
  return {
    version: "v0.2.0",
    target: "linux-x64",
    execPath: binary,
    receiptPath: receipt,
    githubUrl,
    idleTimeoutMs: 5_000,
    verifyAttestation: async (): Promise<AttestationResult> => "skipped",
    log: (line) => logs.push(line),
    ...overrides,
  };
}

function writeReceipt(path: string) {
  writeFileSync(receipt, JSON.stringify({ installer: "install.sh", path, target: "linux-x64" }));
}

beforeEach(() => {
  release.tag = "v0.3.0";
  release.asset = Bun.gzipSync("new honk binary");
  release.sums = `${sha256(release.asset)}  honk-linux-x64.gz\n${"0".repeat(64)}  honk-darwin-arm64.gz\n`;
  release.broken = undefined;
  release.refused = false;
  requests.length = 0;
  logs = [];
  // realpath, because macOS puts tmpdir behind the /var -> /private/var symlink.
  dir = realpathSync(mkdtempSync(join(root, "case-")));
  mkdirSync(join(dir, "bin"));
  binary = join(dir, "bin", "honk");
  writeFileSync(binary, "old honk binary");
  chmodSync(binary, 0o755);
  receipt = join(dir, "receipt.json");
  writeReceipt(binary);
});

afterAll(() => {
  server.stop(true);
  for (const socket of rawSockets) socket.destroy();
  rawServer.close();
  rmSync(root, { recursive: true, force: true });
});

const binaryText = () => readFileSync(binary, "utf-8");
const leftovers = () => readdirSync(join(dir, "bin")).filter((f) => f !== "honk");

describe("upgrade", () => {
  test("replaces the binary with the latest release", async () => {
    await upgrade(options());
    expect(binaryText()).toBe("new honk binary");
    expect(statSync(binary).mode & 0o777).toBe(0o755);
    expect(leftovers()).toEqual([]);
    expect(logs.at(-1)).toBe("upgraded honk from v0.2.0 to v0.3.0");
  });

  test("does nothing when this is already the latest release", async () => {
    await upgrade(options({ version: "v0.3.0" }));
    expect(binaryText()).toBe("old honk binary");
    expect(logs.at(-1)).toBe("honk v0.3.0 is up to date (the latest release is v0.3.0)");
    expect(requests).toEqual([`HEAD /${REPO}/releases/latest`]);
  });

  test("does not go back to an older release", async () => {
    await upgrade(options({ version: "v0.10.0" }));
    expect(binaryText()).toBe("old honk binary");
  });

  test("replaces the real file when it runs through a symlink", async () => {
    const link = join(dir, "honk-link");
    symlinkSync(binary, link);
    await upgrade(options({ execPath: link }));
    expect(binaryText()).toBe("new honk binary");
    expect(readFileSync(link, "utf-8")).toBe("new honk binary");
  });

  test("refuses when there is no receipt", async () => {
    rmSync(receipt);
    await expect(upgrade(options())).rejects.toThrow(/no install receipt/);
    expect(binaryText()).toBe("old honk binary");
    expect(requests).toEqual([]);
  });

  test("refuses a copy that install.sh did not install", async () => {
    writeReceipt("/somewhere/else/honk");
    await expect(upgrade(options())).rejects.toThrow(
      /install.sh installed honk at \/somewhere\/else\/honk, but this copy is/,
    );
    expect(binaryText()).toBe("old honk binary");
  });

  test("refuses a broken receipt", async () => {
    writeFileSync(receipt, "{not json");
    await expect(upgrade(options())).rejects.toThrow(/not valid JSON/);
  });

  test("refuses a build that is not a release", async () => {
    await expect(upgrade(options({ version: "dev", target: undefined }))).rejects.toThrow(
      /not built by the release workflow/,
    );
  });

  test("keeps the old binary when the checksum does not match", async () => {
    release.asset = Bun.gzipSync("tampered honk binary"); // SHA256SUMS still lists the real one
    await expect(upgrade(options())).rejects.toThrow(/checksum mismatch for honk-linux-x64\.gz/);
    expect(binaryText()).toBe("old honk binary");
    expect(leftovers()).toEqual([]);
  });

  test("keeps the old binary when the download is not valid gzip", async () => {
    setAsset(new TextEncoder().encode("not gzip data"));
    await expect(upgrade(options())).rejects.toThrow(/could not unpack honk-linux-x64\.gz/);
    expect(binaryText()).toBe("old honk binary");
    expect(leftovers()).toEqual([]);
  });

  // The error that upgrade() throws, or undefined.
  const failure = (opts = options()) => upgrade(opts).then(() => undefined, (err: Error) => err.message);
  const assetUrl = () => `${githubUrl}/${REPO}/releases/download/v0.3.0/honk-linux-x64.gz`;

  // Bun can report the break from fetch() itself or while it reads the body.
  // Two sizes make both likely. Older Bun versions sometimes ended a short
  // body without an error instead. Then checkLength reports it, so these tests
  // still pass, and the checkLength tests below check its messages.
  test.each([
    ["a small", 100],
    ["a big", 4_000_000],
  ])("names the download when the connection breaks halfway through %s download", async (_, size) => {
    setAsset(crypto.getRandomValues(new Uint8Array(size)));
    release.broken = { file: "asset", how: "cut" };
    const message = await failure();
    expect(message?.startsWith(`download failed: ${assetUrl()}: `)).toBe(true);
    expect(message).not.toContain("verbose: true"); // Bun's advice for developers
    expect(binaryText()).toBe("old honk binary");
    expect(leftovers()).toEqual([]);
  });

  test("names SHA256SUMS when the connection breaks halfway through it", async () => {
    release.broken = { file: "sums", how: "cut" };
    expect(await failure()).toStartWith(`download failed: ${githubUrl}/${REPO}/releases/download/v0.3.0/SHA256SUMS: `);
  });

  test("names the release page when GitHub cannot be reached", async () => {
    const message = await failure(options({ githubUrl: refusedUrl }));
    expect(message).toStartWith(`could not find the latest release (${refusedUrl}/${REPO}/releases/latest: `);
  });

  // The idle timeout for the tests below. The slow server's gap must stay below it.
  const IDLE_MS = 300;
  const idleOptions = () => options({ idleTimeoutMs: IDLE_MS });
  const noData = "no data for 0.3 seconds";

  const sumsUrl = () => `${githubUrl}/${REPO}/releases/download/v0.3.0/SHA256SUMS`;
  test.each([
    ["a download that stops sending data halfway", "asset", "stall", assetUrl],
    ["SHA256SUMS when it stops sending data halfway", "sums", "stall", sumsUrl],
    ["a download host that never answers", "asset", "silent", assetUrl],
  ] as const)("gives up on %s", async (_, file, how, url) => {
    release.broken = { file, how };
    expect(await failure(idleOptions())).toBe(`download failed: ${url()}: ${noData}`);
    expect(binaryText()).toBe("old honk binary");
    expect(leftovers()).toEqual([]);
  });

  test("gives up on a release page that never answers", async () => {
    const pageUrl = `${rawUrl}/silent/${REPO}/releases/latest`;
    const message = await failure(options({ githubUrl: `${rawUrl}/silent`, idleTimeoutMs: IDLE_MS }));
    expect(message).toBe(`could not find the latest release (${pageUrl}: ${noData})`);
  });

  test("keeps a slow download going while data still arrives", async () => {
    // 5 parts, 100 ms apart: the whole download takes longer than the idle timeout.
    setAsset(Bun.gzipSync(new TextEncoder().encode(`new honk binary${" ".repeat(50_000)}`)));
    release.broken = { file: "asset", how: "slow" };
    const started = Date.now();
    await upgrade(idleOptions());
    expect(Date.now() - started).toBeGreaterThan(IDLE_MS);
    expect(binaryText().trimEnd()).toBe("new honk binary");
  });

  test("restarts the timer when the headers arrive", async () => {
    // 200 ms to the headers, 200 ms more to the body: no gap is as long as the
    // timeout, but the whole download is longer.
    release.broken = { file: "asset", how: "late" };
    await upgrade(idleOptions());
    expect(binaryText()).toBe("new honk binary");
  });

  test("names the download when its host cannot be reached", async () => {
    release.refused = true;
    expect(await failure()).toStartWith(`download failed: ${assetUrl()}: `);
  });

  test("checks the attestation of the unpacked binary", async () => {
    let checked = "";
    const opts = options({
      verifyAttestation: async (file) => {
        checked = readFileSync(file, "utf-8");
        return "ok";
      },
    });
    await upgrade(opts);
    expect(checked).toBe("new honk binary");
  });

  test("keeps the old binary when the attestation check fails", async () => {
    const opts = options({ verifyAttestation: async () => "failed" });
    await expect(upgrade(opts)).rejects.toThrow(/attestation check failed for honk-linux-x64\./);
    expect(binaryText()).toBe("old honk binary");
    expect(leftovers()).toEqual([]);
  });

  test("fails before the big download when SHA256SUMS has no entry for this target", async () => {
    release.sums = `${"0".repeat(64)}  honk-darwin-arm64.gz\n`;
    await expect(upgrade(options())).rejects.toThrow(/no entry for honk-linux-x64\.gz/);
    expect(requests.some((r) => r.endsWith("/honk-linux-x64.gz"))).toBe(false);
  });

  test("does not take an entry for the unpacked binary as the .gz checksum", async () => {
    // A SHA256SUMS in the old format, with names without .gz.
    release.sums = `${sha256(release.asset)}  honk-linux-x64\n`;
    await expect(upgrade(options())).rejects.toThrow(/no entry for honk-linux-x64\.gz/);
  });

  test("reports a repo with no releases", async () => {
    release.tag = undefined;
    await expect(upgrade(options())).rejects.toThrow(/could not find the latest release/);
  });

  test("reports a folder it cannot write to", async () => {
    if (process.getuid?.() === 0) return; // root can write anywhere
    chmodSync(join(dir, "bin"), 0o555);
    try {
      await expect(upgrade(options())).rejects.toThrow(/cannot write to/);
      expect(binaryText()).toBe("old honk binary");
    } finally {
      chmodSync(join(dir, "bin"), 0o755);
    }
  });
});

describe("compareVersions", () => {
  test.each([
    ["v0.3.0", "v0.2.0", 1],
    ["v0.2.0", "v0.3.0", -1],
    ["v0.10.0", "v0.9.0", 1], // numbers, not text
    ["v1.0.0", "v1.0.0", 0],
    ["v1.0.0", "v1.0.0-rc.1", 1], // a release is newer than its pre-release
    ["v1.0.0-rc.1", "v1.0.0-rc.2", -1],
  ])("%s vs %s", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });

  test("returns NaN for tags it cannot read", () => {
    expect(compareVersions("nightly", "v1.0.0")).toBeNaN();
    expect(compareVersions("nightly", "nightly")).toBe(0);
  });
});

// Bun 1.4.5 reports a connection that breaks halfway as an error, so the
// upgrade tests above cannot reach this check. It is there for a Bun that
// ends a cut body as if it were complete, as some versions did.
describe("checkLength", () => {
  const response = (headers: Record<string, string>) => new Response(null, { headers });

  test("throws when fewer bytes arrived than Content-Length promised", () => {
    expect(() => checkLength("https://x/a.gz", response({ "content-length": "10" }), 4)).toThrow(
      "download failed: https://x/a.gz: the connection closed after 4 of 10 bytes",
    );
  });

  test("throws when more bytes arrived than Content-Length promised", () => {
    expect(() => checkLength("https://x/a.gz", response({ "content-length": "10" }), 12)).toThrow(
      "download failed: https://x/a.gz: got 12 bytes, but the server said 10",
    );
  });

  test("accepts the promised length, and a response without one", () => {
    expect(() => checkLength("u", response({ "content-length": "10" }), 10)).not.toThrow();
    expect(() => checkLength("u", response({}), 4)).not.toThrow();
  });

  test("skips the check when fetch() unpacked a Content-Encoding", () => {
    const gzipped = response({ "content-length": "10", "content-encoding": "gzip" });
    expect(() => checkLength("u", gzipped, 40)).not.toThrow();
  });
});

describe("checksumFor", () => {
  const hash = "a".repeat(64);
  test("reads both sha256sum formats", () => {
    expect(checksumFor(`${hash}  honk-linux-x64\n`, "honk-linux-x64")).toBe(hash);
    expect(checksumFor(`${hash} *honk-linux-x64\n`, "honk-linux-x64")).toBe(hash);
  });
  test("does not match a name that only starts the same", () => {
    expect(checksumFor(`${hash}  honk-linux-x64-musl\n`, "honk-linux-x64")).toBeUndefined();
  });
});

describe("defaultReceiptPath", () => {
  test("uses XDG_STATE_HOME, and treats an empty value as unset", () => {
    expect(defaultReceiptPath({ XDG_STATE_HOME: "/state" })).toBe("/state/honk/receipt.json");
    expect(defaultReceiptPath({ XDG_STATE_HOME: "" })).toMatch(/\.local\/state\/honk\/receipt\.json$/);
  });
});
