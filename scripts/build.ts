// The flags of every honk binary build. `bun run build` runs this file to build
// a binary for this machine into dist/honk, and scripts/release.ts imports
// buildFlags to build one for each platform. CI runs `bun run build`, so it
// builds with the same flags as the binaries that ship.
import { $ } from "bun";

export const buildFlags = [
  "--compile",
  // --production minifies and sets NODE_ENV, which picks React's production
  // build. The development one is slower, and its debug data for each element
  // grows the memory without end in a busy channel. --compile alone leaves
  // NODE_ENV unset.
  "--production",
  // Do not read a .env or a bunfig.toml from the folder where honk starts. A
  // bunfig.toml there could preload code into honk.
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  // --bytecode compiles the code ahead of time, so honk starts faster. It
  // needs --format=esm, because index.tsx uses a top-level await.
  "--bytecode",
  "--format=esm",
];

if (import.meta.main) {
  await $`bun build src/index.tsx ${buildFlags} --outfile dist/honk`;
}
