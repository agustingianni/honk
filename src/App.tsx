import { CliRenderEvents } from "@opentui/core";
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { IrcManager } from "./irc/manager.ts";
import { DEFAULT_CASEMAPPING, STATUS_BUFFER } from "./irc/names.ts";
import { withActionUsed } from "./state.ts";
import { applyTheme, theme, ThemeVersion } from "./theme.ts";
import type { ThemeEntry } from "./themes/index.ts";
import { ChatPane } from "./ui/ChatPane.tsx";
import { setWidthMethod } from "./ui/display.ts";
import { Nicklist } from "./ui/Nicklist.tsx";
import { Omnibox } from "./ui/Omnibox.tsx";
import { Sidebar } from "./ui/Sidebar.tsx";
import { StatusBar } from "./ui/StatusBar.tsx";

/** Narrower than this, the panel is hidden whatever its toggle says. */
const SIDEBAR_MIN_WIDTH = 65;
const NICKLIST_MIN_WIDTH = 90;

interface AppProps {
  manager: IrcManager;
  /** Every theme the picker offers. */
  themes: ThemeEntry[];
  /** The theme in use when App mounts. index.tsx has applied it already. */
  initialThemeId: string;
  /** Called when the user keeps a theme in the picker, to save it. */
  onThemeChosen: (id: string) => void;
  /** The omnibox actions used last, from state.ts. */
  initialRecentActions: Record<string, number>;
  /** Called after an action is used, to save the new order. */
  onRecentActionsChanged: (recent: Record<string, number>) => void;
}

export function App({
  manager,
  themes,
  initialThemeId,
  onThemeChosen,
  initialRecentActions,
  onRecentActionsChanged,
}: AppProps) {
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [nicklistOpen, setNicklistOpen] = useState(true);
  const [omniboxOpen, setOmniboxOpen] = useState(false);
  const [recentKeys, setRecentKeys] = useState<string[]>([]);
  const [themeId, setThemeId] = useState(initialThemeId);
  const [themeVersion, setThemeVersion] = useState(0);
  const [recentActions, setRecentActions] = useState(initialRecentActions);
  // The latest value, so two actions used before a re-render both count.
  const recentActionsRef = useRef(initialRecentActions);
  const actionUsed = useCallback(
    (key: string) => {
      const next = withActionUsed(recentActionsRef.current, key);
      recentActionsRef.current = next;
      setRecentActions(next);
      onRecentActionsChanged(next);
    },
    [onRecentActionsChanged],
  );

  // Measure text as the renderer does. The width method comes from the terminal's
  // answers, which can arrive after the first frame. When it changes, the theme
  // version makes memoized components cut and pad their text again.
  useEffect(() => {
    const sync = () => {
      if (setWidthMethod(renderer.widthMethod)) setThemeVersion((v) => v + 1);
    };
    sync();
    renderer.on(CliRenderEvents.CAPABILITIES, sync);
    return () => {
      renderer.off(CliRenderEvents.CAPABILITIES, sync);
    };
  }, [renderer]);

  // Copies the colors into the shared `theme` object, then re-renders. The
  // version tells memoized components to render again too.
  const previewTheme = useCallback(
    (id: string) => {
      const entry = themes.find((t) => t.id === id);
      if (!entry) return;
      applyTheme(entry.theme);
      setThemeVersion((v) => v + 1);
    },
    [themes],
  );
  const chooseTheme = useCallback(
    (id: string) => {
      previewTheme(id);
      setThemeId(id);
      onThemeChosen(id);
    },
    [previewTheme, onThemeChosen],
  );

  useEffect(() => {
    if (!snapshot.active) return;
    const key = `${snapshot.active.serverId}:${snapshot.active.buffer}`;
    setRecentKeys((prev) => [key, ...prev.filter((k) => k !== key)].slice(0, 20));
  }, [snapshot.active?.serverId, snapshot.active?.buffer]);

  const quit = useCallback(() => {
    manager.disconnectAll();
    renderer.destroy();
    process.exit(0);
  }, [manager, renderer]);

  // Stable handlers, so memoized children (Nicklist, the Omnibox item list) skip work.
  const submit = useCallback(
    (value: string) => {
      if (manager.handleInput(value) === "quit") quit();
    },
    [manager, quit],
  );
  const runCommandOn = useCallback(
    (serverId: string, command: string) => {
      if (manager.runCommandOn(serverId, command) === "quit") quit();
    },
    [manager, quit],
  );
  const selectBuffer = useCallback(
    (serverId: string, buf: string) => manager.setActive(serverId, buf),
    [manager],
  );
  const openDm = useCallback(
    (serverId: string, nick: string) => manager.openDm(serverId, nick),
    [manager],
  );
  const pasteLines = useCallback(
    (lines: string[]) => manager.sendLines(lines),
    [manager],
  );
  const closeOmnibox = useCallback(() => setOmniboxOpen(false), []);
  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);
  const toggleNicklist = useCallback(() => setNicklistOpen((v) => !v), []);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      quit();
      return;
    }
    if (key.ctrl && key.name === "k") {
      setOmniboxOpen((v) => !v);
      return;
    }
    if (omniboxOpen) return;

    if (key.ctrl && key.name === "b") {
      setSidebarOpen((v) => !v);
      return;
    }
    // Alt+U, not Ctrl+U: Ctrl+U clears the input line, as in a shell.
    if ((key.meta || key.option) && key.name === "u") {
      setNicklistOpen((v) => !v);
      return;
    }
    if ((key.meta || key.option) && key.name === "up") {
      manager.cycleBuffer(-1);
      return;
    }
    if ((key.meta || key.option) && key.name === "down") {
      manager.cycleBuffer(1);
    }
    // Ctrl+P / Ctrl+N belong to the input (sent-line history, as in readline).
  });

  const activeServer = snapshot.active
    ? snapshot.servers.find((s) => s.id === snapshot.active!.serverId)
    : snapshot.servers[0];

  const activeBuffer =
    activeServer?.buffers[snapshot.active?.buffer ?? STATUS_BUFFER];
  const activeServerId = activeServer?.id;
  const selectUser = useCallback(
    (nick: string) => {
      if (activeServerId) manager.openDm(activeServerId, nick);
    },
    [manager, activeServerId],
  );
  const joinChannel = useCallback(
    (channel: string) => {
      if (activeServerId) manager.openChannel(activeServerId, channel);
    },
    [manager, activeServerId],
  );

  const sidebarFits = width >= SIDEBAR_MIN_WIDTH;
  const nicklistFits = width >= NICKLIST_MIN_WIDTH;
  const showSidebar = sidebarOpen && sidebarFits;
  // DMs and *status have no user list, so the panel would only show "No users".
  const showNicklist = nicklistOpen && nicklistFits && activeBuffer?.kind === "channel";
  const chatWidth =
    width - (showSidebar ? 24 : 0) - (showNicklist ? 20 : 0);

  return (
    <ThemeVersion.Provider value={themeVersion}>
      <box
        flexDirection="column"
        width="100%"
        height="100%"
        backgroundColor={theme.bgBase}
      >
        <box flexDirection="row" flexGrow={1} width="100%">
          {showSidebar && (
            <Sidebar
              servers={snapshot.servers}
              active={snapshot.active}
              onSelect={selectBuffer}
              onConnectServer={(serverId) =>
                void manager.connectServer(serverId, { manual: true })
              }
            />
          )}

          <ChatPane
            server={activeServer}
            buffer={activeBuffer}
            inputFocused={!omniboxOpen}
            paneWidth={chatWidth}
            onSubmit={submit}
            onPasteLines={pasteLines}
            onSelectUser={selectUser}
            onJoinChannel={joinChannel}
          />

          {showNicklist && (
            <Nicklist
              users={activeBuffer!.users}
              myNick={activeServer?.nick ?? ""}
              casemapping={activeServer?.casemapping ?? DEFAULT_CASEMAPPING}
              onSelectUser={selectUser}
            />
          )}
        </box>

        <StatusBar
          server={activeServer}
          width={width}
          sidebarFits={sidebarFits}
          nicklistFits={nicklistFits && activeBuffer?.kind === "channel"}
          update={snapshot.update}
        />

        {omniboxOpen && (
          <Omnibox
            servers={snapshot.servers}
            active={snapshot.active}
            recentKeys={recentKeys}
            width={width}
            onClose={closeOmnibox}
            onSelectBuffer={selectBuffer}
            onOpenDm={openDm}
            onRunCommand={submit}
            onRunCommandOn={runCommandOn}
            onToggleSidebar={toggleSidebar}
            onToggleNicklist={toggleNicklist}
            themes={themes}
            themeId={themeId}
            onPreviewTheme={previewTheme}
            onChooseTheme={chooseTheme}
            recentActions={recentActions}
            onActionUsed={actionUsed}
          />
        )}
      </box>
    </ThemeVersion.Provider>
  );
}
