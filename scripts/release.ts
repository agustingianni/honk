// Builds a standalone binary for each platform into dist/.
// OpenTUI ships its native code in one package per platform, and a normal
// `bun install` only fetches the one for this machine, so fetch them all first.
import { $ } from "bun";
import pkg from "../package.json";

// Each binary carries the Bun that built it. With Bun 1.3.10 inside, `honk
// upgrade` hangs on the download (oven-sh/bun#13237). The workflows pin 1.4.5.
const MIN_BUN = "1.4.5";
// Bun.semver itself is missing before Bun 1.0.11.
if (!Bun.semver || Bun.semver.order(Bun.version, MIN_BUN) < 0) {
  console.error(`release: this is Bun ${Bun.version}, and a release needs Bun ${MIN_BUN} or later. Run: bun upgrade`);
  process.exit(1);
}

const targets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  // musl libc, for Alpine and other musl-based distros
  "linux-x64-musl",
  "linux-arm64-musl",
];

// The version that `honk --version` prints. The release workflow sets
// HONK_RELEASE_TAG to the tag release-please made, such as "v0.2.0". A local build
// describes the commit instead, such as "v0.1.0-3-gabc1234-dirty".
//
// A release tag must match the version in package.json: tag v0.2.0 needs
// "version": "0.2.0". Otherwise the release stops here, before it builds
// anything, so a binary never reports one version while package.json says another.
async function releaseVersion(): Promise<string> {
  const tag = process.env.HONK_RELEASE_TAG;
  if (tag) {
    const expected = `v${pkg.version}`;
    if (tag !== expected) {
      console.error(
        `release: the tag is ${tag}, but package.json has version ${pkg.version}, so the tag should be ${expected}.\n` +
          `release: release-please sets both, so check that .release-please-manifest.json and package.json agree.`,
      );
      process.exit(1);
    }
    return tag;
  }
  const described = await $`git describe --tags --always --dirty`.nothrow().quiet();
  return described.exitCode === 0 ? described.text().trim() : "dev";
}

const version = await releaseVersion();
console.log(`building honk ${version}`);

const all = "*"; // passed as a value so the shell does not expand it as a glob
// --libc too: since Bun 1.4.4, on Linux, bun install skips the musl packages
// on glibc (and the other way round) once bun.lock records each one's libc.
// --frozen-lockfile: build from the committed bun.lock, never a new one.
await $`bun install --frozen-lockfile --os=${all} --cpu=${all} --libc=${all}`;
await $`rm -rf dist`;

for (const target of targets) {
  // OpenTUI loads its musl native library only when OPENTUI_LIBC is "musl" at
  // run time, and the glibc one otherwise, which fails on Alpine. Fix the value
  // at build time for the musl targets.
  const libc = target.endsWith("-musl")
    ? ["--define", `process.env.OPENTUI_LIBC=${JSON.stringify("musl")}`]
    : [];
  // Do not read a .env or a bunfig.toml from the folder where honk starts. A
  // bunfig.toml there could preload code into honk.
  const noAutoload = ["--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig"];
  // --bytecode compiles the code ahead of time, so honk starts faster. It
  // needs --format=esm, because index.tsx uses a top-level await.
  const bytecode = ["--bytecode", "--format=esm"];
  // --production minifies and sets NODE_ENV, which picks React's production
  // build. The development one is slower, and its debug data for each element
  // grows the memory without end in a busy channel. --compile alone leaves
  // NODE_ENV unset. --define puts these values into src/version.ts. Each value
  // is JSON, so the strings keep their quotes.
  await $`bun build src/index.tsx --compile --production --target=bun-${target} \
    ${noAutoload} \
    ${bytecode} \
    --define __HONK_VERSION__=${JSON.stringify(version)} \
    --define __HONK_TARGET__=${JSON.stringify(target)} \
    ${libc} \
    --outfile dist/honk-${target}`;
  // Releases ship the gzipped file: about a third of the size. -n leaves out the
  // name and time, so the same binary always gives the same .gz. -k keeps the
  // binary, for local testing.
  await $`gzip -9 -n -k dist/honk-${target}`;
}

await $`ls -lh dist`;
