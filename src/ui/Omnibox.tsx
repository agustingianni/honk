import { useKeyboard } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { nickColor, theme, useThemeVersion } from "../theme.ts";
import type { ThemeEntry } from "../themes/index.ts";
import { findSlashCommand, needsArgs, SLASH_COMMANDS, syntax } from "../irc/commands.ts";
import { sameNick } from "../irc/names.ts";
import type { ActiveBuffer, ServerState } from "../types.ts";
import { Clickable } from "./Clickable.tsx";
import { bufferDisplayName, cellWidth, truncate, unreadBadge } from "./display.ts";
import { type FuzzyMatch, fuzzyMatch, matchLabel, rankMatches, shorterFirst } from "./fuzzy.ts";

interface OmniboxItem {
  id: string;
  label: string;
  labelColor?: string;
  detail?: string;
  badge?: string;
  badgeColor?: string;
  hint?: string;
  /** Runs before the omnibox closes. */
  onSelect: () => void;
  /** Keep the omnibox open after selecting (items that change the query, like "?" help). */
  keepOpen?: boolean;
  /** In the theme list: the theme this row previews when selected. */
  themeId?: string;
  /** Indexes of the label's characters that the query matched, shown highlighted. */
  highlights?: readonly number[];
  /**
   * In the actions list: the key that remembers this action was used (see state.ts), so
   * it ranks first among equal matches. Rows for each server share one key, such as
   * "cmd-reconnect", so the active server's row still comes first.
   */
  historyKey?: string;
}

/** When each action was last used: a higher number is more recent. See state.ts. */
export type RecentActions = Readonly<Record<string, number>>;

interface OmniboxProps {
  servers: ServerState[];
  active: ActiveBuffer | null;
  recentKeys: string[];
  width: number;
  onClose: () => void;
  onSelectBuffer: (serverId: string, buffer: string) => void;
  onOpenDm: (serverId: string, nick: string) => void;
  onRunCommand: (command: string) => void;
  /** Runs a slash command on a given server, which may not be the active one. */
  onRunCommandOn: (serverId: string, command: string) => void;
  onToggleSidebar: () => void;
  onToggleNicklist: () => void;
  themes: ThemeEntry[];
  /** The theme in use, which closing the theme list without a choice goes back to. */
  themeId: string;
  /** Shows a theme without saving it. */
  onPreviewTheme: (id: string) => void;
  /** Uses a theme and saves it in the config file. */
  onChooseTheme: (id: string) => void;
  recentActions: RecentActions;
  /** An action was chosen, by its historyKey. */
  onActionUsed: (key: string) => void;
}

/** "main": buffers and the prefix modes. "theme": the color theme list. */
type OmniboxMode = "main" | "theme";

const MAX_RESULTS = 10;
const THEME_ACTION_LABEL = "Preferences: Color Theme...";
/** How far back the active buffer is read to rank recent speakers first in "@" mode. */
const RECENT_SPEAKER_SCAN = 300;

/** The matched positions that fall in the first `length` characters: the label's part. */
function labelHighlights(match: FuzzyMatch, length: number, offset = 0): number[] {
  return match.positions.map((p) => p + offset).filter((p) => p >= 0 && p < length);
}

/**
 * The actions that match `q`, best first, as in VS Code: equal matches go by the one
 * used last, then by list order (which puts the active server's rows first). A match in
 * the label ranks first; the detail can match too ("history" finds "Load Older Messages").
 */
export function rankActions<T extends Pick<OmniboxItem, "id" | "label" | "detail" | "historyKey">>(
  q: string,
  items: readonly T[],
  recent: RecentActions = {},
): (T & { highlights: number[] })[] {
  const usedAt = (item: T) => recent[item.historyKey ?? item.id] ?? 0;
  return rankMatches(
    q,
    items,
    (item) => [item.label, item.detail],
    (a, b) => usedAt(b) - usedAt(a),
  ).map(({ item, match }) => ({ ...item, highlights: labelHighlights(match, item.label.length) }));
}

interface KnownUser {
  serverId: string;
  serverName: string;
  nick: string;
  /** An open DM buffer with this user. */
  hasDm: boolean;
}

/** Every user in a channel or an open DM, once per server, without yourself. */
function collectUsers(servers: ServerState[]): KnownUser[] {
  const users = new Map<string, KnownUser>();
  for (const s of servers) {
    for (const bufName of s.bufferOrder) {
      const buf = s.buffers[bufName];
      if (!buf) continue;
      const nicks = buf.kind === "dm" ? [buf.name] : buf.users.map((u) => u.nick);
      for (const nick of nicks) {
        if (sameNick(nick, s.nick)) continue;
        const key = `${s.id}:${nick.toLowerCase()}`;
        const known = users.get(key);
        if (known) {
          if (buf.kind === "dm") known.hasDm = true;
          continue;
        }
        users.set(key, { serverId: s.id, serverName: s.name, nick, hasDm: buf.kind === "dm" });
      }
    }
  }
  return [...users.values()];
}

const isOnline = (s: ServerState) =>
  s.status === "connected" || s.status === "connecting" || s.status === "reconnecting";

/** The servers with the active one first, the rest in their usual order. */
function activeFirst(servers: ServerState[], active: ServerState | undefined): ServerState[] {
  return active ? [active, ...servers.filter((s) => s !== active)] : servers;
}

/**
 * The servers a "+ Join" or "Message" row can act on: connected ones, the active server
 * first. `nameFilter` (the second word typed, as in "#rust beta") narrows them by name.
 */
function connectedServers(
  servers: ServerState[],
  active: ServerState | undefined,
  nameFilter: string,
): ServerState[] {
  return activeFirst(servers, active).filter(
    (s) => s.status === "connected" && fuzzyMatch(nameFilter, s.name) !== null,
  );
}

interface QuickOpenContext {
  servers: ServerState[];
  active: ActiveBuffer | null;
  /** Buffers visited lately, newest first, as "serverId:buffer". */
  recentKeys: string[];
  onSelectBuffer: (serverId: string, buffer: string) => void;
  onOpenDm: (serverId: string, nick: string) => void;
}

/**
 * The rows for a query with no prefix (or "#"): your buffers, and the people you could
 * open a DM with, in one list. Each ranks by its name (see matchLabel), so "al" puts
 * @alice above #honk on server "alpha", which only matches by its server's name.
 *
 * With nothing typed (or "#" alone) the buffers that need you come first: mentions,
 * unread, then the ones visited lately. The buffer you are in goes last, so Ctrl+K then
 * Enter goes back to the previous one.
 */
export function quickOpenRows(q: string, ctx: QuickOpenContext): OmniboxItem[] {
  const { servers, active, recentKeys } = ctx;
  const channelOnly = q.startsWith("#");
  const browsing = !q || q === "#";
  // `isUser`: a buffer beats a person on an equal match, since you are already in it.
  const rows: { item: OmniboxItem; score: number; isUser: boolean }[] = [];

  for (const s of servers) {
    for (const bufName of s.bufferOrder) {
      const buf = s.buffers[bufName];
      if (!buf) continue;
      if (channelOnly && buf.kind !== "channel") continue;

      const key = `${s.id}:${bufName}`;
      const displayName = bufferDisplayName(buf);
      const match = matchLabel(q, displayName, s.name);
      if (!match) continue;

      let boost = 0;
      if (browsing) {
        if (buf.hasMention) boost += 400;
        else if (buf.unread > 0) boost += 200 + Math.min(buf.unread, 50);
        const recIdx = recentKeys.indexOf(key);
        if (recIdx !== -1) boost += 100 - recIdx;
        if (active?.serverId === s.id && active.buffer === bufName) boost -= 10_000;
      }

      rows.push({
        score: match.score + boost,
        isUser: false,
        item: {
          id: `buf-${key}`,
          label: displayName,
          highlights: labelHighlights(match, displayName.length),
          labelColor:
            buf.kind === "channel"
              ? theme.fgBright
              : buf.kind === "dm"
                ? theme.accentAlt
                : theme.fgMuted,
          detail: s.name,
          badge: buf.unread > 0 ? unreadBadge(buf.unread, buf.hasMention) : undefined,
          badgeColor: buf.hasMention ? theme.red : theme.accent,
          onSelect: () => ctx.onSelectBuffer(s.id, bufName),
        },
      });
    }
  }

  // People you share a channel with but have no DM with yet ("@alice" opens one). Someone
  // with a DM already has a row above, as its buffer. "alice beta" picks the server.
  if (!channelOnly && q) {
    for (const u of collectUsers(servers)) {
      if (u.hasDm) continue;
      // Matched as "@alice", the way their DM will be named, so both score alike.
      const label = `@${u.nick}`;
      const match = matchLabel(q, label, u.serverName);
      if (!match) continue;
      rows.push({
        score: match.score,
        isUser: true,
        item: {
          id: `user-${u.serverId}:${u.nick.toLowerCase()}`,
          label,
          highlights: labelHighlights(match, label.length),
          labelColor: nickColor(u.nick),
          detail: `user, ${u.serverName}`,
          onSelect: () => ctx.onOpenDm(u.serverId, u.nick),
        },
      });
    }
  }

  // Equal matches: a buffer before a person, then the shorter name ("#rust" before
  // "#rust-dev"), then sidebar order (the sort is stable).
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      Number(a.isUser) - Number(b.isUser) ||
      (browsing ? 0 : a.item.label.length - b.item.label.length),
  );
  return rows.map((r) => r.item);
}

/** Fits a row into `width` columns: the label keeps at least half, then the detail is cut. */
function fitRow(item: OmniboxItem, width: number): { label: string; detail?: string } {
  const extras = (item.hint ? cellWidth(item.hint) + 1 : 0) + (item.badge ? cellWidth(item.badge) + 1 : 0);
  const room = Math.max(4, width - extras);
  const detailWanted = item.detail ? cellWidth(item.detail) + 2 : 0;
  const labelMax = Math.max(room - detailWanted, Math.min(cellWidth(item.label), Math.ceil(room / 2)));
  const label = truncate(item.label, labelMax);
  const detailRoom = room - cellWidth(label) - 2;
  const detail = item.detail && detailRoom >= 4 ? truncate(item.detail, detailRoom) : undefined;
  return { label, detail };
}

/**
 * Splits a fitted label into runs of matched and unmatched characters, for the
 * highlight. A label cut short ("Server: Reconn…") drops the matches past the cut.
 */
export function highlightRuns(
  label: string,
  fullLength: number,
  highlights: readonly number[] = [],
): { text: string; hit: boolean }[] {
  const shown = label.length < fullLength ? label.length - 1 : label.length;
  const hits = new Set(highlights.filter((p) => p < shown));
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < label.length; i++) {
    const hit = hits.has(i);
    const last = runs.at(-1);
    if (last && last.hit === hit) last.text += label[i];
    else runs.push({ text: label[i]!, hit });
  }
  return runs;
}

export function Omnibox({
  servers,
  active,
  recentKeys,
  width,
  onClose,
  onSelectBuffer,
  onOpenDm,
  onRunCommand,
  onRunCommandOn,
  onToggleSidebar,
  onToggleNicklist,
  themes,
  themeId,
  onPreviewTheme,
  onChooseTheme,
  recentActions,
  onActionUsed,
}: OmniboxProps) {
  const [mode, setMode] = useState<OmniboxMode>("main");
  const [query, setQuery] = useState("");
  // The selected item's id, not its row: the list is rebuilt when buffers or unread
  // counts change, and a row number would then point at another item or past the end.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const themeVersion = useThemeVersion();
  /** A theme was previewed, so closing must restore the theme in use. */
  const previewedRef = useRef(false);
  /** A theme was chosen with Enter or a click: keep it on close. */
  const chosenRef = useRef(false);
  const openThemeList = () => {
    setMode("theme");
    setQuery("");
  };

  const activeServer = active
    ? servers.find((s) => s.id === active.serverId)
    : servers[0];

  /** `more`: matches left out of the list, so the user knows to type more. */
  const { items, more } = useMemo<{ items: OmniboxItem[]; more: number }>(() => {
    const trimmed = query.trimStart();
    const top = (list: OmniboxItem[]) => ({
      items: list.slice(0, MAX_RESULTS),
      more: Math.max(0, list.length - MAX_RESULTS),
    });
    // The action and slash command lists are short and fixed: show them whole.
    const all = (list: OmniboxItem[]) => ({ items: list, more: 0 });

    // The color theme list. It is long, so the rows scroll (see `visible` below).
    if (mode === "theme") {
      const q = trimmed.trim();
      return all(
        rankMatches(
          q,
          themes,
          (entry) => [entry.name, `${entry.id} ${entry.variant}`],
          shorterFirst((entry) => entry.name),
        ).map(({ item: entry, match }): OmniboxItem => ({
            id: `theme-${entry.id}`,
            themeId: entry.id,
            label: entry.name,
            highlights: labelHighlights(match, entry.name.length),
            detail: [
              entry.variant,
              entry.source === "user" ? "yours" : undefined,
              entry.id === themeId ? "current" : undefined,
            ]
              .filter(Boolean)
              .join(", "),
            onSelect: () => {
              chosenRef.current = true;
              onChooseTheme(entry.id);
            },
          })),
      );
    }
    const themeAction = (id: string): OmniboxItem => ({
      id,
      label: THEME_ACTION_LABEL,
      detail: themes.find((t) => t.id === themeId)?.name,
      onSelect: openThemeList,
      keepOpen: true,
    });

    // ? -- mode help, as in VS Code
    if (trimmed === "?") {
      const mode = (id: string, label: string, color: string, detail: string, next: string) => ({
        id,
        label,
        labelColor: color,
        detail,
        onSelect: () => setQuery(next),
        keepOpen: true,
      });
      return top([
        mode("help-buffers", "(no prefix)", theme.accent, "Jump to a channel, DM or user", ""),
        mode("help-cmd", ">", theme.yellow, "Run an action (part, nick, topic, quit...)", ">"),
        mode("help-slash", "/", theme.cyan, "Run a slash command, with its usage shown", "/"),
        mode("help-users", "@", theme.accentAlt, "Find a user and open a DM", "@"),
        mode("help-channels", "#", theme.cyan, "Filter channels or join a new #channel", "#"),
      ]);
    }

    // / -- slash commands, also reachable as "> /..."
    const slash = trimmed.startsWith("/")
      ? trimmed
      : trimmed.startsWith(">") && trimmed.slice(1).trimStart().startsWith("/")
        ? trimmed.slice(1).trimStart()
        : null;
    if (slash !== null) {
      const [word = "", ...restWords] = slash.slice(1).split(" ");
      const known = findSlashCommand(word);
      // Arguments typed (or started): one item that runs the line as typed.
      if (restWords.length > 0) {
        return top([
          {
            id: "slash-run",
            label: `Run ${slash.trimEnd()}`,
            labelColor: theme.cyan,
            detail: known ? syntax(known) : "unknown command",
            onSelect: () => onRunCommand(slash),
          },
        ]);
      }
      const matches = rankMatches(
        word,
        SLASH_COMMANDS,
        (cmd) => [cmd.name],
        shorterFirst((cmd) => cmd.name),
      ).map(({ item: cmd, match }): OmniboxItem => ({
          id: `slash-${cmd.name}`,
          label: syntax(cmd),
          // The label starts with "/", so the name's positions move by one.
          highlights: labelHighlights(match, cmd.name.length + 1, 1),
          labelColor: theme.cyan,
          detail: cmd.summary,
          // A command that needs arguments fills the query, so the user types them next.
          onSelect: needsArgs(cmd)
            ? () => setQuery(`/${cmd.name} `)
            : () => onRunCommand(`/${cmd.name}`),
          keepOpen: needsArgs(cmd),
        }));
      if (matches.length === 0 && word) {
        matches.push({
          id: "slash-run",
          label: `Run ${slash}`,
          labelColor: theme.cyan,
          detail: "unknown command",
          onSelect: () => onRunCommand(slash),
        });
      }
      return all(matches);
    }

    // > -- command palette: actions that fit the current buffer and server
    if (trimmed.startsWith(">")) {
      const q = trimmed.slice(1).trim();
      const buf = activeServer && active ? activeServer.buffers[active.buffer] : undefined;
      const fill = (next: string) => ({ onSelect: () => setQuery(next), keepOpen: true });
      const online = activeServer ? isOnline(activeServer) : false;
      const commands: OmniboxItem[] = [];
      // Every action is remembered when used (see historyKey), by its id unless it says otherwise.
      const add = (...list: OmniboxItem[]) =>
        commands.push(...list.map((item) => ({ historyKey: item.id, ...item })));

      add(
        { id: "cmd-join", label: "Channel: Join a Channel...", hint: "#", ...fill("#") },
        { id: "cmd-dm", label: "User: Open a DM...", hint: "@", ...fill("@") },
      );
      if (buf?.kind === "channel" && active) {
        add(
          {
            id: "cmd-topic",
            label: "Channel: Set Topic...",
            detail: active.buffer,
            ...fill("/topic "),
          },
          {
            id: "cmd-part",
            label: `Channel: Part ${active.buffer}`,
            detail: activeServer?.name,
            onSelect: () => onRunCommand(`/part ${active.buffer}`),
          },
        );
      }
      if (buf?.kind === "dm" && active) {
        add(
          {
            id: "cmd-whois",
            label: `User: Whois ${active.buffer}`,
            onSelect: () => onRunCommand(`/whois ${active.buffer}`),
          },
          {
            id: "cmd-close-dm",
            label: `User: Close DM with ${active.buffer}`,
            onSelect: () => onRunCommand("/part"),
          },
        );
      }
      if (buf && buf.kind !== "status") {
        add({
          id: "cmd-history",
          label: "Chat: Load Older Messages",
          detail: "/history",
          onSelect: () => onRunCommand("/history"),
        });
      }
      add({
        id: "cmd-clear",
        label: "Chat: Clear Buffer",
        detail: active?.buffer,
        onSelect: () => onRunCommand("/clear"),
      });
      add(
        themeAction("cmd-theme"),
        { id: "cmd-sidebar", label: "View: Toggle Sidebar", hint: "^B", onSelect: onToggleSidebar },
        {
          id: "cmd-nicklist",
          label: "View: Toggle User List",
          hint: "Alt+U",
          onSelect: onToggleNicklist,
        },
      );
      if (activeServer && online) {
        add({
          id: "cmd-nick",
          label: "Server: Change Nick...",
          detail: `${activeServer.nick}, ${activeServer.name}`,
          ...fill("/nick "),
        });
      }
      // Every server you can connect to, the active one first. Demo servers have no host.
      for (const s of activeFirst(servers, activeServer)) {
        if (!s.config.host) continue;
        const up = isOnline(s);
        add({
          id: `cmd-reconnect-${s.id}`,
          label: `Server: ${up ? "Reconnect" : "Connect"} ${s.name}`,
          historyKey: "cmd-reconnect",
          onSelect: () => onRunCommandOn(s.id, "/connect"),
        });
        if (up) {
          add({
            id: `cmd-disconnect-${s.id}`,
            label: `Server: Disconnect ${s.name}`,
            historyKey: "cmd-disconnect",
            onSelect: () => onRunCommandOn(s.id, "/disconnect"),
          });
        }
      }
      add(
        { id: "cmd-connect", label: "Server: Connect to a New Server...", ...fill("/connect ") },
        { id: "cmd-slash", label: "IRC: Slash Commands...", hint: "/", ...fill("/") },
        { id: "cmd-quit", label: "App: Quit", hint: "^C", onSelect: () => onRunCommand("/quit") },
      );

      return all(rankActions(q, commands, recentActions));
    }

    // @ -- find a user and open a DM
    if (trimmed.startsWith("@")) {
      const q = trimmed.slice(1).trim();
      // Recent speakers in the buffer you are in, newest first.
      const recentSpeakers = new Map<string, number>();
      const activeBuf = active ? activeServer?.buffers[active.buffer] : undefined;
      const msgs = activeBuf?.messages ?? [];
      for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - RECENT_SPEAKER_SCAN); i--) {
        const from = msgs[i]!.from?.toLowerCase();
        if (from && !recentSpeakers.has(from)) recentSpeakers.set(from, recentSpeakers.size);
      }

      const here =
        activeBuf?.kind === "channel"
          ? new Set(activeBuf.users.map((u) => u.nick.toLowerCase()))
          : new Set<string>();
      const inThisDm = (u: KnownUser) =>
        activeBuf?.kind === "dm" &&
        u.serverId === active?.serverId &&
        sameNick(u.nick, activeBuf.name);

      const known = collectUsers(servers);
      const users = known
        .flatMap((u) => {
          const match = matchLabel(q, u.nick, u.serverName);
          if (!match) return [];
          let score = match.score;
          if (!q) {
            // People you talk with first: open DMs, then who spoke here lately,
            // then the rest of this channel. The DM you are in goes last.
            const lower = u.nick.toLowerCase();
            const sameServer = u.serverId === active?.serverId;
            if (inThisDm(u)) {
              score -= 10_000;
            } else if (u.hasDm) {
              const dmKey = `${u.serverId}:${lower}`;
              const recIdx = recentKeys.findIndex((k) => k.toLowerCase() === dmKey);
              score += 3000 - (recIdx === -1 ? 50 : recIdx);
            }
            const spoke = sameServer ? recentSpeakers.get(lower) : undefined;
            if (spoke !== undefined) score += 2000 - spoke;
            else if (sameServer && here.has(lower)) score += 1000;
          }
          return [{ u, score, match }];
        })
        .sort(
          (a, b) =>
            b.score - a.score ||
            (q ? a.u.nick.length - b.u.nick.length : 0) ||
            a.u.nick.localeCompare(b.u.nick),
        );

      const list = users.map(
        ({ u, match }): OmniboxItem => ({
          id: `user-${u.serverId}:${u.nick.toLowerCase()}`,
          label: u.nick,
          highlights: labelHighlights(match, u.nick.length),
          labelColor: nickColor(u.nick),
          detail: u.hasDm ? `has a DM, ${u.serverName}` : u.serverName,
          onSelect: () => onOpenDm(u.serverId, u.nick),
        }),
      );

      const result = top(list);
      // A nick nobody shares a channel with: offer a new DM anyway, on each connected
      // server. A nick known somewhere gets these rows only when a server is named, as
      // in "@dave alpha", so "@dave" stays on the dave you know.
      const [nick = "", serverWord = ""] = q.split(/\s+/);
      // One pass over the users: the servers where this nick is known.
      const knownOn = new Set(known.filter((u) => sameNick(u.nick, nick)).map((u) => u.serverId));
      if (nick && (knownOn.size === 0 || serverWord)) {
        for (const s of connectedServers(servers, activeServer, serverWord)) {
          if (sameNick(nick, s.nick) || knownOn.has(s.id)) continue;
          result.items.push({
            id: `dm-new-${s.id}:${nick}`,
            label: `Message ${nick}`,
            labelColor: theme.accentAlt,
            detail: `new DM, ${s.name}`,
            onSelect: () => onOpenDm(s.id, nick),
          });
        }
      }
      return result;
    }

    // Default (or #) -- quick open buffers across all servers
    const channelOnly = trimmed.startsWith("#");
    const q = trimmed;
    const result = top(
      quickOpenRows(q, { servers, active, recentKeys, onSelectBuffer, onOpenDm }),
    );

    // "theme" or "color" typed: offer the theme list, after the buffers.
    if (!channelOnly && q.length >= 3 && "color theme".includes(q.toLowerCase())) {
      result.items.push(themeAction("theme-open"));
    }

    // "#name" not joined yet: offer to join it, on each connected server that is not in
    // it, the active one first. "#rust beta" picks the server.
    const [chan = "", serverWord = ""] = q.split(/\s+/);
    if (channelOnly && chan.length > 1) {
      for (const s of connectedServers(servers, activeServer, serverWord)) {
        if (s.bufferOrder.some((b) => sameNick(b, chan))) continue;
        result.items.push({
          id: `join-${s.id}:${chan}`,
          label: `+ Join ${chan}`,
          labelColor: theme.green,
          detail: s.name,
          onSelect: () => onRunCommandOn(s.id, `/join ${chan}`),
        });
      }
    }

    return result;
  }, [
    mode,
    themes,
    themeId,
    onChooseTheme,
    // Rows carry theme colors, so rebuild them while a theme is previewed.
    themeVersion,
    query,
    servers,
    active,
    activeServer,
    recentKeys,
    recentActions,
    onSelectBuffer,
    onOpenDm,
    onRunCommand,
    onRunCommandOn,
    onToggleSidebar,
    onToggleNicklist,
  ]);

  useEffect(() => {
    setSelectedId(null);
  }, [query]);

  const foundIndex = items.findIndex((item) => item.id === selectedId);
  // The theme list opens on the theme in use.
  const startIndex =
    mode === "theme" && !query ? Math.max(0, items.findIndex((i) => i.themeId === themeId)) : 0;
  const selectedIndex = foundIndex === -1 ? startIndex : foundIndex;

  // Preview the selected theme. When the omnibox closes without a choice
  // (Esc, Ctrl+K, a buffer chosen elsewhere), go back to the theme in use.
  const previewThemeId = mode === "theme" ? items[selectedIndex]?.themeId : undefined;
  useEffect(() => {
    if (previewThemeId) onPreviewTheme(previewThemeId);
  }, [previewThemeId, onPreviewTheme]);
  const restoreRef = useRef(() => onPreviewTheme(themeId));
  restoreRef.current = () => onPreviewTheme(themeId);
  useEffect(
    () => () => {
      if (previewedRef.current && !chosenRef.current) restoreRef.current();
    },
    [],
  );
  if (previewThemeId) previewedRef.current = true;
  // Several keys can arrive before React re-renders, so each move starts from the
  // previous move's result (the updater's `prev`), not from this render's selection.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Where the highlight is when nothing was selected yet (the current theme in the theme list).
  const startIndexRef = useRef(startIndex);
  startIndexRef.current = startIndex;
  const moveSelection = (delta: 1 | -1) => {
    setSelectedId((prev) => {
      const list = itemsRef.current;
      if (list.length === 0) return prev;
      const found = list.findIndex((item) => item.id === prev);
      const at = found === -1 ? startIndexRef.current : found;
      return list[(at + delta + list.length) % list.length]?.id ?? null;
    });
  };

  useKeyboard((key) => {
    if (key.name === "escape") {
      onClose();
      return;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      moveSelection(1);
      return;
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      moveSelection(-1);
      return;
    }
  });

  const modalWidth = Math.min(64, Math.max(36, width - 6));
  const leftOffset = Math.max(0, Math.floor((width - modalWidth) / 2));
  // Border (2), the selection marker and its space (2), right padding (1).
  const rowWidth = modalWidth - 5;

  const select = (item: OmniboxItem | undefined) => {
    if (item?.historyKey) onActionUsed(item.historyKey);
    item?.onSelect();
    if (!item?.keepOpen) onClose();
  };
  const executeSelected = () => select(items[selectedIndex]);

  // The theme list can be long: show a window of rows that keeps the selection
  // in view.
  const windowStart =
    mode === "theme"
      ? Math.min(
          Math.max(0, selectedIndex - Math.floor(MAX_RESULTS / 2)),
          Math.max(0, items.length - MAX_RESULTS),
        )
      : 0;
  const visible = mode === "theme" ? items.slice(windowStart, windowStart + MAX_RESULTS) : items;

  return (
    <box
      position="absolute"
      top={1}
      left={leftOffset}
      width={modalWidth}
      zIndex={100}
      flexDirection="column"
      backgroundColor={theme.bgOverlay}
      border
      borderStyle="rounded"
      borderColor={theme.borderOverlay}
    >
      {/* Input row */}
      <box
        height={1}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.bgInput}
        flexDirection="row"
      >
        <text fg={theme.accent}>
          <strong>❯ </strong>
        </text>
        <input
          flexGrow={1}
          focused
          value={query}
          placeholder={
            mode === "theme"
              ? "Color theme (Up/Down to preview, Enter to keep, Esc to cancel)"
              : "Jump to buffer… (> actions, / commands, @ users, ? help)"
          }
          backgroundColor={theme.bgInput}
          textColor={theme.fgBright}
          // Set these too: the input copies them once, when it is created.
          focusedBackgroundColor={theme.bgInput}
          focusedTextColor={theme.fgBright}
          placeholderColor={theme.fgMuted}
          onInput={setQuery}
          onSubmit={executeSelected}
        />
      </box>

      {/* Results list */}
      <box flexDirection="column" paddingTop={1} paddingBottom={0}>
        {items.length === 0 ? (
          <box height={1} paddingLeft={2}>
            <text fg={theme.fgMuted}>No matching results</text>
          </box>
        ) : (
          visible.map((item, row) => {
            const isSel = windowStart + row === selectedIndex;
            const { label, detail } = fitRow(item, rowWidth);
            return (
              <Clickable
                key={item.id}
                height={1}
                paddingRight={1}
                flexDirection="row"
                justifyContent="space-between"
                backgroundColor={isSel ? theme.bgOverlaySel : theme.bgOverlay}
                hoverColor={isSel ? undefined : theme.bgOverlayHover}
                onMouseDown={() => select(item)}
              >
                <text>
                  <span fg={isSel ? theme.accent : theme.bgOverlay}>
                    {isSel ? "▎" : " "}
                  </span>
                  <span fg={item.labelColor ?? theme.fgPrimary}> </span>
                  {/* The characters the query matched stand out, as in VS Code and fzf. */}
                  {highlightRuns(label, item.label.length, item.highlights).map((run, i) => (
                    <span key={i} fg={run.hit ? theme.orange : (item.labelColor ?? theme.fgPrimary)}>
                      {isSel || run.hit ? <strong>{run.text}</strong> : run.text}
                    </span>
                  ))}
                </text>

                <text>
                  {detail ? <span fg={theme.fgMuted}>{detail}</span> : null}
                  {item.hint ? (
                    <span fg={theme.cyan}> {item.hint}</span>
                  ) : null}
                  {item.badge ? (
                    <span fg={item.badgeColor ?? theme.accent}>
                      {" "}
                      <strong>{item.badge}</strong>
                    </span>
                  ) : null}
                </text>
              </Clickable>
            );
          })
        )}
        {more > 0 ? (
          <box height={1} paddingLeft={2}>
            <text fg={theme.fgMuted}>{`${more} more, type to narrow the list`}</text>
          </box>
        ) : null}
        {mode === "theme" && items.length > MAX_RESULTS ? (
          <box height={1} paddingLeft={2}>
            <text fg={theme.fgMuted}>{`${selectedIndex + 1} of ${items.length}`}</text>
          </box>
        ) : null}
      </box>
    </box>
  );
}
