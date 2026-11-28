/** @jsxImportSource @opentui/react */
// Shows each color scheme that passes honk's checks in the real honk UI (the
// offline demo), and asks whether to bundle it:
//
//   bun run review-themes
//
//   y  keep: bundle this theme
//   n  skip: do not bundle it (removes it if it is bundled now)
//   b  back to the previous theme, to change the answer
//   q  quit. Every answer is saved at once, so the next run continues here.
//
// All other keys go to honk, so Ctrl+K opens the omnibox in the theme under
// review. While the omnibox is open, y, n, b and q still answer the review.
//
// Answers go to scripts/theme-review.json. Kept themes go to
// src/themes/catalog.json, and the scheme files and src/themes/bundled.ts are
// rewritten after every answer.

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { App } from "../src/App.tsx";
import { NICK_COL_MAX_DEFAULT } from "../src/config.ts";
import { IrcManager } from "../src/irc/manager.ts";
import { applyTheme, theme } from "../src/theme.ts";
import type { ThemeEntry } from "../src/themes/index.ts";
import { schemeToTheme } from "../src/themes/scheme.ts";
import {
  type Candidate,
  downloadRepo,
  findCandidates,
  readCatalog,
  writeBundle,
  writeCatalog,
} from "./themes-lib.ts";

type Answer = "keep" | "skip";
const ANSWERS_PATH = join(import.meta.dir, "theme-review.json");

const catalog = readCatalog();
console.log(`reading tinted-theming/schemes at ${catalog.commit.slice(0, 7)}...`);
const repoDir = await downloadRepo(catalog.commit);
const { candidates: found } = findCandidates(repoDir);

/** repo path -> answer. */
const answers: Record<string, Answer> = existsSync(ANSWERS_PATH)
  ? (JSON.parse(readFileSync(ANSWERS_PATH, "utf-8")) as Record<string, Answer>)
  : {};

// The honk name for each candidate. A theme that is bundled now keeps its
// name ("github-light" for github.yaml). The base16 and base24 files of one
// scheme count as the same theme.
const bundledName = (c: Candidate) =>
  Object.entries(catalog.themes).find(([, path]) => basename(path) === basename(c.path))?.[0];
const usedNames = new Set(Object.keys(catalog.themes));
const items = found.map((c) => {
  const bundled = bundledName(c);
  if (bundled) return { ...c, name: bundled, bundledAtStart: true };
  // Another file already uses this name, such as base24/one-dark.yaml next to
  // the bundled one-dark (base16/onedark.yaml).
  const name = usedNames.has(c.name) ? `${c.name}-${c.path.split("/")[0]}` : c.name;
  usedNames.add(name);
  return { ...c, name, bundledAtStart: false };
});
// Themes bundled now come first, so they get a look too.
items.sort((a, b) => Number(b.bundledAtStart) - Number(a.bundledAtStart));

let index = items.findIndex((item) => answers[item.path] === undefined);
if (index === -1) index = items.length - 1;

async function save(item: (typeof items)[number], answer: Answer): Promise<void> {
  answers[item.path] = answer;
  await Bun.write(ANSWERS_PATH, JSON.stringify(answers, null, 2) + "\n");
  // Drop any other name that points at the same scheme, then add this one.
  for (const [name, path] of Object.entries(catalog.themes)) {
    if (basename(path) === basename(item.path)) delete catalog.themes[name];
  }
  if (answer === "keep") catalog.themes[item.name] = item.path;
  await writeCatalog(catalog);
  await writeBundle(repoDir, catalog);
}

const manager = new IrcManager();
manager.startDemo();

const renderer = await createCliRenderer({ exitOnCtrlC: false, autoFocus: false });
const root = createRoot(renderer);
renderer.on("destroy", () => {
  manager.disconnectAll();
  void renderer.closed.finally(() => process.exit(0));
});

function Bar({ item, position }: { item: (typeof items)[number]; position: string }) {
  const answer = answers[item.path];
  const status =
    answer === "keep" ? "kept" : answer === "skip" ? "skipped" : item.bundledAtStart ? "bundled now" : "new";
  const kept = Object.keys(catalog.themes).length;
  // Authors often include URLs and emails; the name is enough here.
  const author = item.scheme.author.replace(/\s*[(<][^)>]*[)>]/g, "").slice(0, 40);
  return (
    <box height={1} flexDirection="row" backgroundColor={theme.accent} paddingLeft={1} paddingRight={1}>
      <text fg={theme.bgBase} flexGrow={1} flexShrink={1} wrapMode="none">
        {`${position}  ${item.name}  [${status}]  ${item.scheme.variant}, ${item.path}, by ${author}`}
      </text>
      <text fg={theme.bgBase} flexShrink={0}>{`  kept ${kept}   y keep  n skip  b back  q quit`}</text>
    </box>
  );
}

function show(): void {
  const item = items[index]!;
  const entry: ThemeEntry = {
    id: item.name,
    name: item.scheme.name,
    author: item.scheme.author,
    variant: item.scheme.variant,
    source: "bundled",
    theme: schemeToTheme(item.scheme),
  };
  applyTheme(entry.theme);
  root.render(
    <box flexDirection="column" width="100%" height="100%">
      <box flexGrow={1}>
        {/* A new key mounts a fresh App, so every color is read again. */}
        <App
          key={item.path}
          manager={manager}
          themes={[entry]}
          initialThemeId={entry.id}
          onThemeChosen={() => {}}
          initialRecentActions={{}}
          onRecentActionsChanged={() => {}}
          logSearch={{ off: "Search is off while you review themes." }}
          nickColumnMax={NICK_COL_MAX_DEFAULT}
        />
      </box>
      <Bar item={item} position={`${index + 1}/${items.length}`} />
    </box>,
  );
  renderer.requestRender();
}

let busy = false;
// Registered before the App mounts, so this handler sees every key first and
// can stop the ones it uses from reaching honk.
renderer.keyInput.on("keypress", (key) => {
  if (key.ctrl || key.meta || !["y", "n", "b", "q"].includes(key.name)) return;
  key.stopPropagation();
  key.preventDefault();
  if (busy) return;
  if (key.name === "q") {
    renderer.destroy();
    return;
  }
  if (key.name === "b") {
    index = Math.max(0, index - 1);
    show();
    return;
  }
  busy = true;
  void save(items[index]!, key.name === "y" ? "keep" : "skip")
    .then(() => {
      index = Math.min(items.length - 1, index + 1);
      show();
    })
    .finally(() => {
      busy = false;
    });
});

show();
