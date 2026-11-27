// `honk upgrade`: replaces this binary with the latest GitHub release.
//
// It does the same steps as site/install.sh: it downloads the gzipped binary,
// checks its SHA-256 checksum against the release's SHA256SUMS file, unpacks
// it, and checks the build provenance attestation of the unpacked binary when
// the GitHub CLI (gh) is installed and logged in. It only replaces a binary that
// install.sh installed, as recorded in its receipt, so it never overwrites a
// copy that Homebrew or another package manager owns.

import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { TARGET, VERSION } from "./version.ts";

export const REPO = "agustingianni/honk";
const INSTALL_COMMAND = "curl -fsSL https://agustingianni.github.io/honk/install.sh | sh";
/** A download that sends no data for this long fails. */
const IDLE_TIMEOUT_MS = 30_000;

/** An error with a message for the user, printed without a stack trace. */
export class UpgradeError extends Error {}

export type AttestationResult = "ok" | "failed" | "skipped";

export interface UpgradeOptions {
  /** The running version, such as "v0.2.0". */
  version: string;
  /** The release asset name without "honk-", such as "darwin-arm64". */
  target: string | undefined;
  /** The path of the running binary. It may be a symlink. */
  execPath: string;
  receiptPath: string;
  /** "https://github.com". Tests pass a local server. */
  githubUrl: string;
  /**
   * Each request fails when no data arrives for this long. It is not a limit on
   * the whole download, so a slow download that keeps sending goes on.
   */
  idleTimeoutMs: number;
  verifyAttestation: (file: string) => Promise<AttestationResult>;
  log: (line: string) => void;
}

/** Where install.sh writes its receipt. Matches write_receipt in site/install.sh. */
export function defaultReceiptPath(env: NodeJS.ProcessEnv = process.env): string {
  // Like ${XDG_STATE_HOME:-...} in sh: an empty value counts as unset.
  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "honk", "receipt.json");
}

/** Returns the path install.sh recorded, or undefined when there is no receipt. */
export function readReceipt(path: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UpgradeError(`the install receipt ${path} is not valid JSON`);
  }
  const recorded = (parsed as { path?: unknown } | null)?.path;
  if (typeof recorded !== "string" || recorded === "") {
    throw new UpgradeError(`the install receipt ${path} has no "path"`);
  }
  return recorded;
}

/**
 * Finds the tag of the latest release. It reads the redirect of the
 * github.com/<repo>/releases/latest web page instead of calling the REST API,
 * because unauthenticated API calls are limited to 60 an hour per IP address.
 *
 *   /agustingianni/honk/releases/latest -> /agustingianni/honk/releases/tag/v0.2.0
 */
export async function latestRelease(githubUrl: string, signal?: AbortSignal): Promise<string> {
  const pageUrl = `${githubUrl}/${REPO}/releases/latest`;
  let res: Response;
  try {
    res = await fetch(pageUrl, { method: "HEAD", redirect: "manual", signal });
  } catch (err) {
    const reason = failureReason(err, signal);
    throw new UpgradeError(`could not find the latest release (${pageUrl}: ${reason})`);
  }
  const location = res.headers.get("location");
  if (res.status < 300 || res.status >= 400 || !location) {
    throw new UpgradeError(`could not find the latest release (${pageUrl} answered ${res.status})`);
  }
  const match = /\/releases\/tag\/([^/]+)$/.exec(new URL(location, pageUrl).pathname);
  if (!match) {
    // With no releases at all, GitHub redirects to the list of releases instead.
    throw new UpgradeError(`could not find the latest release (${pageUrl} redirects to ${location})`);
  }
  return decodeURIComponent(match[1]!);
}

/**
 * Compares two release tags such as "v0.2.0" and "v0.10.0-rc.1". Returns a
 * negative number when a is older, 0 when they are the same, and a positive
 * number when a is newer. Returns NaN when either one is not of that form.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(v);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a === b ? 0 : NaN;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  // A release comes after its own pre-releases: v0.2.0 is newer than v0.2.0-rc.1.
  const preA = pa[4];
  const preB = pb[4];
  if (preA === preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  return preA < preB ? -1 : 1;
}

/** Reads the checksum of `asset` from a SHA256SUMS file in `sha256sum` format. */
export function checksumFor(sums: string, asset: string): string | undefined {
  for (const line of sums.split("\n")) {
    // "<64 hex digits>  <name>", or "<hex> *<name>" for sha256sum's binary mode.
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match && match[2] === asset) return match[1];
  }
  return undefined;
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  // Read in chunks: the binary is over 100 MB.
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * The text of a network error, without the advice Bun adds for developers:
 * "The socket connection was closed unexpectedly. For more information, pass
 * `verbose: true` in the second argument to fetch()" -> its first sentence.
 */
function networkReason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/ For more information, pass `verbose: true`[\s\S]*$/, "");
}

/** The text of a network error, or the abort reason when `signal` caused it. */
function failureReason(err: unknown, signal?: AbortSignal): string {
  // An aborted fetch() rejects with the signal's reason, but say it either way.
  return networkReason(signal?.aborted ? signal.reason : err);
}

/**
 * Aborts a request when no data arrives for `ms`. Each chunk that arrives
 * restarts the timer, so it covers a server that never answers and a download
 * that stops halfway without closing the connection.
 */
class IdleTimeout {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly reason: Error;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ms: number) {
    const seconds = ms / 1000;
    this.reason = new Error(`no data for ${seconds} second${seconds === 1 ? "" : "s"}`);
    this.restart();
  }

  restart(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.controller.abort(this.reason), this.ms);
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

/** Runs `fn` with an IdleTimeout of `ms`, and stops the timer when `fn` ends. */
async function withIdleTimeout<T>(ms: number, fn: (idle: IdleTimeout) => Promise<T>): Promise<T> {
  const idle = new IdleTimeout(ms);
  try {
    return await fn(idle);
  } finally {
    idle.stop();
  }
}

/**
 * Throws when the number of bytes that arrived differs from Content-Length.
 * Bun 1.4.5 reports a connection that closes early as an error, but older
 * versions sometimes ended the body as if it were complete.
 */
export function checkLength(url: string, res: Response, received: number) {
  // With a Content-Encoding, fetch() unpacks the body, and Content-Length
  // counts the packed bytes. GitHub sends release assets without one.
  if (res.headers.get("content-encoding")) return;
  const promised = Number(res.headers.get("content-length"));
  if (!(promised > 0)) return; // no Content-Length
  if (received < promised) {
    throw new UpgradeError(
      `download failed: ${url}: the connection closed after ${received} of ${promised} bytes`,
    );
  }
  if (received > promised) {
    throw new UpgradeError(
      `download failed: ${url}: got ${received} bytes, but the server said ${promised}`,
    );
  }
}

/**
 * Downloads `url` and passes each chunk of the body to `onChunk`. It fails when
 * no data arrives for `idleMs`. An error that `onChunk` throws passes through
 * as is.
 */
function download(
  url: string,
  idleMs: number,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
): Promise<void> {
  return withIdleTimeout(idleMs, async (idle) => {
    const failed = (err: unknown) =>
      new UpgradeError(`download failed: ${url}: ${failureReason(err, idle.signal)}`);
    let res: Response;
    try {
      res = await fetch(url, { signal: idle.signal });
    } catch (err) {
      throw failed(err);
    }
    // The headers are data too: the wait for the first body chunk starts now.
    idle.restart();
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw new UpgradeError(`download failed: ${url} answered ${res.status}`);
    }
    let received = 0;
    const reader = res.body?.getReader();
    while (reader) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (err) {
        throw failed(err);
      }
      if (next.done) break;
      received += next.value.length;
      // A slow disk is not a network stall: the timer waits while the chunk is written.
      idle.stop();
      try {
        await onChunk(next.value);
      } catch (err) {
        // Close the connection too, not only the file.
        reader.cancel().catch(() => {});
        throw err;
      }
      idle.restart();
    }
    checkLength(url, res, received);
  });
}

/** Downloads a small text file, such as SHA256SUMS. */
async function downloadText(url: string, idleMs: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  await download(url, idleMs, (chunk) => {
    chunks.push(chunk);
  });
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function cannotWrite(path: string, err: unknown): UpgradeError {
  const code = (err as NodeJS.ErrnoException).code;
  const sudo = code === "EACCES" || code === "EPERM" || code === "EROFS";
  return new UpgradeError(
    `cannot write to ${dirname(path)} (${code ?? String(err)}).${sudo ? " honk upgrade never uses sudo." : ""}`,
  );
}

/**
 * Downloads `url` into the file `path`. It writes each chunk itself instead of
 * using Bun.write(path, res), because Bun.write reports no progress, and the
 * idle timer needs to see each chunk arrive.
 */
async function downloadFile(url: string, path: string, idleMs: number): Promise<void> {
  const toCannotWrite = (err: unknown): never => {
    throw cannotWrite(path, err);
  };
  const file = await open(path, "w").catch(toCannotWrite);
  try {
    await download(url, idleMs, async (chunk) => {
      // One write() may write only part of the chunk.
      for (let done = 0; done < chunk.length; ) {
        done += (await file.write(chunk, done).catch(toCannotWrite)).bytesWritten;
      }
    });
  } catch (err) {
    // The first error is the one to report, not one from closing.
    await file.close().catch(() => {});
    throw err;
  }
  // close() can report a write that failed late, such as on a full disk.
  await file.close().catch(toCannotWrite);
}

/** Checks the attestation with gh, like install.sh does. Skips it when gh is missing or logged out. */
export async function verifyAttestationWithGh(file: string): Promise<AttestationResult> {
  if (!Bun.which("gh")) return "skipped";
  const run = (args: string[]) =>
    Bun.spawn(["gh", ...args], { stdout: "ignore", stderr: "ignore" }).exited;
  if ((await run(["auth", "status"])) !== 0) return "skipped";
  return (await run(["attestation", "verify", file, "--repo", REPO])) === 0 ? "ok" : "failed";
}

export async function upgrade(o: UpgradeOptions): Promise<void> {
  if (o.version === "dev" || !o.target) {
    throw new UpgradeError(
      "this honk was not built by the release workflow, so it cannot upgrade itself. " +
        "If you run it from source, use git pull.",
    );
  }

  // Compare real paths, with symlinks resolved, as install.sh records them.
  const self = realpathSync(o.execPath);
  const installed = readReceipt(o.receiptPath);
  if (installed === undefined) {
    throw new UpgradeError(
      `honk upgrade only replaces a copy that install.sh installed, and there is no install receipt at ${o.receiptPath}. ` +
        `If a package manager installed honk, upgrade it there. To install with the script instead, run: ${INSTALL_COMMAND}`,
    );
  }
  if (installed !== self) {
    throw new UpgradeError(
      `install.sh installed honk at ${installed}, but this copy is ${self}. ` +
        `Upgrade this copy the way you installed it, or run: ${installed} upgrade`,
    );
  }

  o.log("checking for a new release");
  const latest = await withIdleTimeout(o.idleTimeoutMs, (idle) =>
    latestRelease(o.githubUrl, idle.signal),
  );
  // NaN (a tag we cannot compare) is not <= 0, so a different tag still upgrades.
  if (compareVersions(latest, o.version) <= 0) {
    o.log(`honk ${o.version} is up to date (the latest release is ${latest})`);
    return;
  }

  // A release ships each binary gzipped, and SHA256SUMS lists the .gz files.
  const binary = `honk-${o.target}`;
  const asset = `${binary}.gz`;
  const base = `${o.githubUrl}/${REPO}/releases/download/${encodeURIComponent(latest)}`;

  // The small file first, so a release without this asset fails before the big download.
  const sums = await downloadText(`${base}/SHA256SUMS`, o.idleTimeoutMs);
  const expected = checksumFor(sums, asset);
  if (!expected) throw new UpgradeError(`the ${latest} SHA256SUMS has no entry for ${asset}`);

  // Download and unpack next to the binary, then rename over it. On one file
  // system the rename is atomic, and a honk that is running keeps its old copy.
  const dir = dirname(self);
  const gz = join(dir, `.honk.new-${process.pid}.gz`);
  const tmp = join(dir, `.honk.new-${process.pid}`);
  try {
    o.log(`downloading ${asset} ${latest}`);
    await downloadFile(`${base}/${asset}`, gz, o.idleTimeoutMs);

    const actual = await sha256OfFile(gz);
    if (actual !== expected) {
      throw new UpgradeError(`checksum mismatch for ${asset} (expected ${expected}, got ${actual})`);
    }
    o.log("checksum OK");

    // In a stream: the unpacked binary is over 100 MB.
    try {
      await pipeline(createReadStream(gz), createGunzip(), createWriteStream(tmp));
    } catch (err) {
      throw new UpgradeError(`could not unpack ${asset}: ${(err as Error).message}`);
    }

    // The release attests the unpacked binaries too, like install.sh checks them.
    const attestation = await o.verifyAttestation(tmp);
    if (attestation === "failed") {
      throw new UpgradeError(`the attestation check failed for ${binary}. The download was deleted.`);
    }
    if (attestation === "ok") o.log(`attestation OK (built by GitHub Actions from ${REPO})`);

    chmodSync(tmp, 0o755);
    renameSync(tmp, self);
  } finally {
    rmSync(gz, { force: true });
    rmSync(tmp, { force: true });
  }
  o.log(`upgraded honk from ${o.version} to ${latest}`);
}

/** Runs `honk upgrade` for this binary and returns the process exit code. */
export async function runUpgrade(): Promise<number> {
  try {
    await upgrade({
      version: VERSION,
      target: TARGET,
      execPath: process.execPath,
      receiptPath: defaultReceiptPath(),
      githubUrl: "https://github.com",
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      verifyAttestation: verifyAttestationWithGh,
      log: (line) => console.log(`honk: ${line}`),
    });
    return 0;
  } catch (err) {
    const message = err instanceof UpgradeError ? err.message : String(err);
    console.error(`honk: error: ${message}`);
    return 1;
  }
}
