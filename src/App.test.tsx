import { afterEach, beforeEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./App.tsx";
import { IrcManager } from "./irc/manager.ts";
import { DEFAULT_LOG_SETTINGS, type Log, openLog } from "./log/log.ts";
import { allThemes } from "./themes/index.ts";
import type { LogSearch } from "./ui/logSearch.ts";

let dir: string;
let log: Log;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "honk-app-"));
  log = openLog(join(dir, "logs.db"), DEFAULT_LOG_SETTINGS).log!;
});

afterEach(() => {
  log.close();
  rmSync(dir, { recursive: true, force: true });
});

const themes = allThemes([]);

function welcome(): IrcManager {
  const manager = new IrcManager();
  manager.initWelcome();
  return manager;
}

/** Renders App, with no servers unless `manager` has some. Returns the screen as text after each step. */
async function renderApp(logSearch: LogSearch, manager = welcome()) {
  const { renderOnce, captureCharFrame, mockInput, mockMouse, renderer } = await testRender(
    <App
      manager={manager}
      themes={themes}
      initialThemeId={themes[0]!.id}
      onThemeChosen={() => {}}
      initialRecentActions={{}}
      onRecentActionsChanged={() => {}}
      logSearch={logSearch}
    />,
    { width: 100, height: 30 },
  );
  const screen = async () => {
    await act(async () => {
      await renderOnce();
    });
    return captureCharFrame();
  };
  const destroy = () => act(() => renderer.destroy());
  // A lone ESC byte could start an escape sequence, so the key comes after a short wait.
  const escape = () =>
    act(async () => {
      mockInput.pressEscape();
      await Bun.sleep(50);
    });
  return { screen, mockInput, mockMouse, escape, destroy, manager };
}

test("Ctrl+F searches the Log; Enter shows the Context view; Esc goes back, then out", async () => {
  const T = Date.now() - 60_000;
  const rust = { name: "#rust", kind: "channel" } as const;
  // 60 Lines before the hit: more than the screen holds, and more than the view shows.
  for (let i = 0; i < 80; i++) {
    log.add("libera", rust, {
      kind: "message",
      nick: i === 60 ? "alice" : "bob",
      text: i === 60 ? "the borrow checker is happy" : `filler ${i}`,
      time: T + i * 1000,
      timeFromServer: true,
    });
  }
  log.flush();

  const app = await renderApp(log);
  try {
    expect(await app.screen()).toContain("Welcome to honk");

    await act(async () => app.mockInput.pressKey("f", { ctrl: true }));
    expect(await app.screen()).toContain("from:alice  in:#rust  on:libera");

    await act(async () => app.mockInput.typeText("borrow"));
    let screen = await app.screen();
    expect(screen).toContain("#rust  alice: the borrow checker is happy");

    await act(async () => app.mockInput.pressEnter());
    screen = await app.screen();
    expect(screen).toContain("#rust on libera, from the log");
    expect(screen).toContain("filler 59");
    expect(screen).toContain("the borrow checker is happy");
    expect(screen).toContain("filler 61");
    expect(screen).not.toContain("Welcome to honk");

    await app.escape();
    screen = await app.screen();
    expect(screen).toContain("#rust  alice: the borrow checker is happy");
    expect(screen).not.toContain("from the log");

    await app.escape();
    screen = await app.screen();
    expect(screen).toContain("Welcome to honk");
    expect(screen).not.toContain("borrow");
  } finally {
    app.destroy();
  }
});

test("/search typed in the input opens search with its words", async () => {
  log.add("libera", { name: "#rust", kind: "channel" }, {
    kind: "message",
    nick: "alice",
    text: "lifetimes again",
    time: Date.now(),
    timeFromServer: true,
  });
  const app = await renderApp(log);
  try {
    await act(async () => app.mockInput.typeText("/search lifetimes"));
    await act(async () => app.mockInput.pressEnter());
    expect(await app.screen()).toContain("alice: lifetimes again");
  } finally {
    app.destroy();
  }
});

test("with no Log, search mode says why", async () => {
  const app = await renderApp({ off: "logs.enabled is false in the config" });
  try {
    await act(async () => app.mockInput.pressKey("f", { ctrl: true }));
    await act(async () => app.mockInput.typeText("x"));
    expect(await app.screen()).toContain("Search is off: logs.enabled is false in the config");
  } finally {
    app.destroy();
  }
});

test("an IRC update while search is open does not read the Log again", async () => {
  let searches = 0;
  const counting: LogSearch = {
    search: (query) => {
      searches++;
      return log.search(query);
    },
    context: (id) => log.context(id),
  };
  const app = await renderApp(counting);
  try {
    await act(async () => app.mockInput.pressKey("f", { ctrl: true }));
    await act(async () => app.mockInput.typeText("lol"));
    await app.screen();
    const before = searches;
    await act(async () => app.manager.addAppNotice("something happened"));
    await app.screen();
    expect(searches).toBe(before);
  } finally {
    app.destroy();
  }
});

test("scrolling to the top of a Buffer loads older Lines from the Log, and the view stays put", async () => {
  const T = Date.now() - 3_600_000;
  for (let i = 1; i <= 300; i++) {
    log.add("net", { name: "alice", kind: "dm" }, {
      kind: "message",
      nick: "alice",
      text: `line ${i}`,
      time: T + i * 1000,
      timeFromServer: true,
    });
  }
  log.flush();
  const manager = new IrcManager({ log });
  manager.addServer({ id: "net", host: "127.0.0.1", nick: "goose", autoConnect: false });
  manager.openDm("net", "alice");

  const app = await renderApp(log, manager);
  // The test keys have no name for Page Up, so this is its escape sequence.
  const pageUp = () => app.mockInput.pressKey("\x1b[5~");
  const lines = (screen: string) => [...screen.matchAll(/line (\d+)/g)].map((m) => Number(m[1]));
  try {
    expect(lines(await app.screen())).toContain(300);
    // Up to the top of the 200 Lines loaded when the Buffer opened. Reaching it loads
    // the 100 older Lines above, and the Lines on screen stay where they were.
    const held = () => manager.getSnapshot().servers[0]!.buffers.alice!.messages.length;
    let screen = await app.screen();
    for (let i = 0; i < 40 && held() === 200; i++) {
      await act(pageUp);
      screen = await app.screen();
    }
    expect(held()).toBe(300);
    expect(lines(screen)).toContain(101);
    expect(lines(screen)).not.toContain(100);
    await act(pageUp);
    screen = await app.screen();
    expect(lines(screen)).toContain(100);
    for (let i = 0; i < 40 && !lines(screen).includes(1); i++) {
      await act(pageUp);
      screen = await app.screen();
    }
    expect(lines(screen)).toContain(1);
  } finally {
    await app.destroy();
    manager.disconnectAll();
  }
});

test.each(["page up", "wheel"])("%s in a Buffer that fits on the screen loads older Lines from the Log", async (how) => {
  const T = Date.now() - 3_600_000;
  for (let i = 1; i <= 3; i++) {
    log.add("net", { name: "alice", kind: "dm" }, {
      kind: "message",
      nick: "alice",
      text: `line ${i}`,
      time: T + i * 1000,
      timeFromServer: true,
    });
  }
  log.flush();
  const manager = new IrcManager({ log });
  manager.addServer({ id: "net", host: "127.0.0.1", nick: "goose", autoConnect: false });
  manager.openDm("net", "alice");
  const app = await renderApp(log, manager);
  try {
    expect(await app.screen()).toContain("line 3");
    await act(async () => manager.handleInput("/clear"));
    // Not connected: honk answers with one line, and the Buffer fits on the screen.
    await act(async () => manager.handleInput("hello?"));
    expect(await app.screen()).not.toContain("line 3");
    // Over the chat pane: the sidebar is 44 columns wide.
    if (how === "wheel") await act(() => app.mockMouse.scroll(70, 10, "up"));
    else await act(() => app.mockInput.pressKey("\x1b[5~"));
    expect(await app.screen()).toContain("line 3");
  } finally {
    await app.destroy();
    manager.disconnectAll();
  }
});
