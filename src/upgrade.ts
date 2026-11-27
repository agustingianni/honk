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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { TARGET, VERSION } from "./version.ts";

export const REPO = "agustingianni/honk";
const INSTALL_COMMAND = "curl -fsSL https://agustingianni.github.io/honk/install.sh | sh";

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
    throw new UpgradeError(`could not find the latest release (${pageUrl}: ${networkReason(err)})`);
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

async function fetchOk(url: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new UpgradeError(`download failed: ${url}: ${networkReason(err)}`);
  }
  if (!res.ok) throw new UpgradeError(`download failed: ${url} answered ${res.status}`);
  return res;
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

/** Downloads a small text file, such as SHA256SUMS. */
async function downloadText(url: string): Promise<string> {
  const res = await fetchOk(url);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    throw new UpgradeError(`download failed: ${url}: ${networkReason(err)}`);
  }
  checkLength(url, res, bytes.length);
  return new TextDecoder().decode(bytes);
}

function cannotWrite(path: string, err: unknown): UpgradeError {
  const code = (err as NodeJS.ErrnoException).code;
  const sudo = code === "EACCES" || code === "EPERM" || code === "EROFS";
  return new UpgradeError(
    `cannot write to ${dirname(path)} (${code ?? String(err)}).${sudo ? " honk upgrade never uses sudo." : ""}`,
  );
}

/**
 * Downloads `url` into the file `path`. Bun.write streams the body to the file.
 * With Bun 1.3.10 it never returned on the release download from GitHub
 * (oven-sh/bun#13237). It works with Bun 1.4.5, which the release needs.
 */
async function downloadFile(url: string, path: string): Promise<void> {
  const res = await fetchOk(url);
  let written: number;
  try {
    written = await Bun.write(path, res);
  } catch (err) {
    // A file system error names its system call, such as "open" or "write".
    // A network error has none.
    if ((err as NodeJS.ErrnoException).syscall) throw cannotWrite(path, err);
    throw new UpgradeError(`download failed: ${url}: ${networkReason(err)}`);
  }
  checkLength(url, res, written);
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
  const latest = await latestRelease(o.githubUrl);
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
  const sums = await downloadText(`${base}/SHA256SUMS`);
  const expected = checksumFor(sums, asset);
  if (!expected) throw new UpgradeError(`the ${latest} SHA256SUMS has no entry for ${asset}`);

  // Download and unpack next to the binary, then rename over it. On one file
  // system the rename is atomic, and a honk that is running keeps its old copy.
  const dir = dirname(self);
  const gz = join(dir, `.honk.new-${process.pid}.gz`);
  const tmp = join(dir, `.honk.new-${process.pid}`);
  try {
    o.log(`downloading ${asset} ${latest}`);
    await downloadFile(`${base}/${asset}`, gz);

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
