import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot, type Root } from "@opentui/react";
import { App } from "./App.tsx";
import { cliAction, HELP, unknownCommandText } from "./cli.ts";
import { ConfigError, defaultConfigPath, loadConfig, saveThemeSetting } from "./config.ts";
import { IrcManager } from "./irc/manager.ts";
import { DEFAULT_LOG_SETTINGS, defaultLogPath, openLog } from "./log/log.ts";
import { Notifier } from "./notify.ts";
import { chooseNotificationProtocol, parseNotificationSetting, readTmuxInfo } from "./notifyProtocol.ts";
import { applyTheme } from "./theme.ts";
import { applyGlyphs, wantsAscii } from "./ui/glyphs.ts";
import type { LogSearch } from "./ui/logSearch.ts";
import { allThemes, loadUserThemes, selectTheme, type ThemeEntry } from "./themes/index.ts";
import { defaultStatePath, loadState, saveState } from "./state.ts";
import { startUpdateCheck } from "./updateCheck.ts";
import { runUpgrade } from "./upgrade.ts";
import { versionLine } from "./version.ts";

// Answer before reading the config or taking over the terminal.
const action = cliAction(process.argv.slice(2));
switch (action.kind) {
  case "help":
    console.log(HELP);
    process.exit(0);
  case "version":
    console.log(versionLine());
    process.exit(0);
  case "upgrade":
    process.exit(await runUpgrade());
  case "unknown":
    // A typo such as "honk upgarde" would otherwise start the client.
    console.error(unknownCommandText(action.word));
    process.exit(2);
  case "run":
    break;
}

interface HotState {
  renderer: CliRenderer;
  root: Root;
  manager: IrcManager;
  version: number;
  themes: ThemeEntry[];
  /** The theme in use. Kept here so a hot reload, which resets src/theme.ts, keeps it. */
  themeId: string;
  /** Draw only ASCII. Kept here for the same reason, for src/ui/glyphs.ts. */
  ascii: boolean;
  saveTheme: (id: string) => void;
  /** The omnibox actions used last (see state.ts), kept here across hot reloads too. */
  recentActions: Record<string, number>;
  saveRecentActions: (recent: Record<string, number>) => void;
  /** The Log that search reads, or why there is none. */
  logSearch: LogSearch;
}

const g = globalThis as unknown as { __ircHot?: HotState };

/** The config, or a one-line error and exit 1 for a file honk can't use. */
function loadConfigOrExit(): ReturnType<typeof loadConfig> {
  try {
    return loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`honk: ${err.message}`);
    process.exit(1);
  }
}

if (!g.__ircHot) {
  const config = loadConfigOrExit();
  const demo = process.argv.includes("--demo");
  // The Log of your chats on disk. Not for the demo. See src/log/log.ts.
  const { log, notices: logNotices, off: logOff } = demo
    ? { log: undefined, notices: [], off: "the demo keeps no log" }
    : openLog(defaultLogPath(), config.logs ?? DEFAULT_LOG_SETTINGS, {
        onError: (text) => manager.addAppNotice(text),
      });
  // Writes the Lines still waiting, however honk exits. bun:sqlite is synchronous.
  if (log) process.on("exit", () => log.close());
  const manager = new IrcManager({ log });

  if (demo) {
    manager.startDemo();
  } else if (config.servers.length === 0) {
    manager.initWelcome();
  } else {
    for (const server of config.servers) {
      manager.addServer(server);
    }
  }
  // Before the first render. Problems go to *status, so they need a server.
  const userThemes = loadUserThemes();
  const themes = allThemes(userThemes.entries);
  const selected = selectTheme(config.theme, themes);
  const warnings = [...logNotices, ...userThemes.warnings];
  if (selected.warning) warnings.push(selected.warning);
  // Inside tmux and zellij, OpenTUI can't see the terminal and would send no
  // notifications, so honk picks the sequence. See src/notifyProtocol.ts.
  const notifications = parseNotificationSetting(config.notifications);
  if (notifications.warning) warnings.push(notifications.warning);
  const protocol = notifications.enabled
    ? chooseNotificationProtocol(process.env, notifications.protocol, readTmuxInfo)
    : {};
  if (protocol.warning) warnings.push(protocol.warning);
  for (const warning of warnings) manager.addAppNotice(warning);

  // In the background, at most once a day. See src/updateCheck.ts.
  startUpdateCheck((update, lines) => manager.showUpdate(update, lines));

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    // A left click would otherwise focus the clicked element (the chat scrollbox), and
    // the input would stop getting keys. Focus moves only through `focused` props.
    autoFocus: false,
    // Off with "mouse": false or --no-mouse, so the terminal's own selection works.
    useMouse: config.mouse,
    ...(protocol.protocol && { environment: { OPENTUI_NOTIFICATION_PROTOCOL: protocol.protocol } }),
  });
  const root = createRoot(renderer);

  // The buffer on screen counts as read only while the window has focus, or, in a
  // terminal that never reports focus, shortly after a key press. See readMarker.ts.
  renderer.on("focus", () => manager.setFocused(true));
  renderer.on("blur", () => manager.setFocused(false));
  renderer.keyInput.on("keypress", () => manager.noteKeyPress());

  // Mentions and DMs become desktop notifications, shown by the terminal. See src/notify.ts.
  if (notifications.enabled) {
    const notifier = new Notifier((message, title) =>
      renderer.triggerNotification(message, title),
    );
    renderer.on("focus", () => notifier.setFocused(true));
    renderer.on("blur", () => notifier.setFocused(false));
    manager.onMention((event) => notifier.notify(event));
    manager.onMissedMentions((events) => notifier.notifyMissed(events));
  }

  // On SIGTERM or SIGHUP (kill, a closed terminal, a dropped SSH session),
  // OpenTUI catches the signal and shuts the renderer down. Catching it stops the
  // normal exit, and the IRC sockets and timers would keep honk running unseen.
  // Quit as /quit does, once the terminal is restored.
  renderer.on("destroy", () => {
    manager.disconnectAll();
    void renderer.closed.finally(() => process.exit(0));
  });

  // The theme picker saves to the config file honk read, or creates the
  // default one. With --theme, the flag still wins at the next start.
  const saveTheme = (id: string) => {
    hot.themeId = id;
    const path = config.path ?? defaultConfigPath();
    try {
      saveThemeSetting(path, id);
    } catch (err) {
      manager.addAppNotice(`could not save the theme in ${path}: ${(err as Error).message}`);
    }
  };
  // The actions used last, saved after each use. Writes go one after another, and a
  // failure is said once in *status: honk works the same without the file.
  const statePath = defaultStatePath();
  let stateWrites = Promise.resolve();
  let stateWarned = false;
  const saveRecentActions = (recent: Record<string, number>) => {
    hot.recentActions = recent;
    stateWrites = stateWrites
      .then(() => saveState(statePath, { recentActions: recent }))
      .catch((err: Error) => {
        if (stateWarned) return;
        stateWarned = true;
        manager.addAppNotice(`could not save recent actions in ${statePath}: ${err.message}`);
      });
  };
  const hot: HotState = {
    renderer,
    root,
    manager,
    version: 0,
    themes,
    themeId: selected.entry.id,
    ascii: wantsAscii(config.ascii, process.env),
    saveTheme,
    recentActions: loadState(statePath).recentActions,
    saveRecentActions,
    logSearch: log ?? { off: logOff ?? "honk keeps no log" },
  };
  g.__ircHot = hot;
}

const hot = g.__ircHot;
hot.version += 1;
applyTheme(hot.themes.find((t) => t.id === hot.themeId)!.theme);
applyGlyphs(hot.ascii);
hot.root.render(
  <App
    key={hot.version}
    manager={hot.manager}
    themes={hot.themes}
    initialThemeId={hot.themeId}
    onThemeChosen={hot.saveTheme}
    initialRecentActions={hot.recentActions}
    onRecentActionsChanged={hot.saveRecentActions}
    logSearch={hot.logSearch}
  />,
);
hot.renderer.requestRender();
