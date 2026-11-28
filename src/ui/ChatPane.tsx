import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer } from "@opentui/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  type Casemapping,
  casemappingOf,
  isUserSender,
  nameKey,
  sameNick,
  STATUS_BUFFER,
} from "../irc/names.ts";
import { nickColor, theme, useThemeVersion } from "../theme.ts";
import type { BufferState, ChatMessage, NickEntry, ServerState } from "../types.ts";
import { linkOpener } from "../openUrl.ts";
import { Clickable, isPlainClick, LinkArea, NameText, type NameActions } from "./Clickable.tsx";
import { getCompletions } from "./completion.ts";
import { cellWidth, HEADER_HEIGHT, scrollboxStyle, truncate } from "./display.ts";
import { clockTime, dayLabelBefore } from "./dayDivider.ts";
import { FormattedText, LinkedText, parseIrcText, Segments, underlineRange } from "./format.tsx";
import { glyphs } from "./glyphs.ts";

interface ChatPaneProps {
  server: ServerState | undefined;
  buffer: BufferState | undefined;
  inputFocused: boolean;
  paneWidth: number;
  onSubmit: (value: string) => void;
  /** A paste of several lines: each line is sent as its own message. */
  onPasteLines: (lines: string[]) => void;
  /** A click on a nick: open a DM with them, as in the nick list. */
  onSelectUser: (nick: string) => void;
  /** A click on a channel name in a message: join it, or switch to it. */
  onJoinChannel: (channel: string) => void;
  /** A plain click on a link in a message or the topic. Opens it in the browser by default. */
  onOpenLink?: (href: string) => void;
  /**
   * The view reached the top of the Buffer: load older Lines from the Log. Returns how
   * many came.
   */
  onLoadOlder?: () => number;
}

/** Undefined over SSH and on platforms honk cannot open a browser on. */
const openLink = linkOpener();

const NO_USERS: NickEntry[] = [];
/** The renderable id of the box that shows a Line, to scroll to it. */
const rowId = (messageId: string) => `row-${messageId}`;
const NICK_COL_WIDTH = 12;
/** Time (5), a space, then the nick column. The message body starts after this. */
const LABEL_COL_WIDTH = 5 + 1 + NICK_COL_WIDTH;
const BLANK_TIME = "     ";
const BLANK_NICK = " ".repeat(NICK_COL_WIDTH);
const GROUP_WINDOW_MS = 5 * 60_000;
/** Lines per mouse wheel notch. */
const WHEEL_LINES = 3;
const WHEEL_ACCEL = { tick: () => WHEEL_LINES, reset: () => {} };
/** Lines per Shift+Up / Shift+Down. */
const SHIFT_SCROLL_LINES = 3;

/** Lines that the "new messages below" bar counts. */
function isChatLine(m: ChatMessage): boolean {
  return (m.kind === "message" || m.kind === "action" || m.kind === "notice") && !m.isSelf;
}


/** Cuts a label to the nick column. The layout right-aligns it in the column. */
function shortNick(nick: string): string {
  return truncate(nick, NICK_COL_WIDTH);
}

/**
 * A rule with a label in the middle, such as " new ". Each half holds a full
 * pane width of dashes, and flex layout clips them, so the rule fits whatever
 * width the feed has, with or without its scrollbar. Each half keeps at least
 * one dash.
 */
export function Divider({ label, color, paneWidth }: { label: string; color: string; paneWidth: number }) {
  const half = (
    <text flexGrow={1} flexShrink={1} flexBasis={0} minWidth={1} wrapMode="none" fg={color}>
      {glyphs.rule.repeat(Math.max(1, paneWidth))}
    </text>
  );
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1}>
      {half}
      <text flexShrink={0} fg={color}>
        <strong>{` ${label} `}</strong>
      </text>
      {half}
    </box>
  );
}

/**
 * One chat line: time, a 12-column label, the gutter, then the body.
 * Memoized because message objects keep their identity across store updates,
 * so typing or a new line only renders the rows that changed.
 */
export const MessageRow = memo(function MessageRow({
  msg,
  grouped,
  highlightMentions,
  names,
  highlighted = false,
}: {
  msg: ChatMessage;
  grouped: boolean;
  /** False in a DM: every line there is to you, so painting each one adds nothing. */
  highlightMentions: boolean;
  /** What a click on a name does. None in a Context view: there no name opens anything. */
  names?: NameActions;
  /** The search hit in a Context view. */
  highlighted?: boolean;
}) {
  const themeVersion = useThemeVersion(); // re-render when the theme changes
  const mention = highlightMentions && Boolean(msg.isMention);
  const sender = msg.from ?? "";
  const senderColor = msg.isSelf ? theme.accent : nickColor(sender);
  // A line you sent that the server hasn't confirmed yet (or never will) is dimmed.
  const unconfirmed = msg.delivery !== undefined;
  let label: ReactNode;
  let labelFg: string;
  // What people write (messages, actions, notices) is parsed into segments, so
  // the names in it can be found and underlined. Other lines are a plain body.
  const segments = useMemo(() => {
    if (msg.kind !== "message" && msg.kind !== "action" && msg.kind !== "notice") return undefined;
    const parsed = parseIrcText(msg.text);
    // The sender is a name in the text too: "* alice waves" opens a DM with alice.
    return msg.kind === "action" ? [{ text: `${sender} `, fg: senderColor }, ...parsed] : parsed;
  }, [msg.kind, msg.text, sender, senderColor, themeVersion]);
  let textFg = theme.fgPrimary;
  let body: ReactNode = null;
  let bg: string | undefined;
  // The sender of a message, when a click on the nick opens a DM with them.
  let clickableNick: string | undefined;

  switch (msg.kind) {
    case "message":
      label = <strong>{shortNick(sender)}</strong>;
      labelFg = senderColor;
      if (!msg.isSelf && isUserSender(sender)) clickableNick = sender;
      bg = mention ? theme.bgMention : theme.bgBase;
      textFg = unconfirmed ? theme.fgMuted : mention ? theme.fgBright : theme.fgPrimary;
      break;
    case "action":
      label = "*";
      labelFg = theme.accentAlt;
      bg = mention ? theme.bgMention : theme.bgBase;
      textFg = unconfirmed ? theme.fgMuted : theme.accentAlt;
      break;
    case "notice":
      label = shortNick(`-${msg.from ?? "notice"}-`);
      labelFg = theme.yellow;
      textFg = theme.yellow;
      break;
    case "error":
      label = "!";
      labelFg = theme.red;
      body = <span fg={theme.red}>{msg.text}</span>;
      break;
    default: {
      // join, part, system
      label = msg.kind === "join" ? glyphs.join : msg.kind === "part" ? glyphs.part : glyphs.system;
      labelFg = theme.fgDim;
      body =
        msg.kind === "system" ? (
          // honk's own lines (the update notice) and the MOTD can hold links.
          <LinkedText text={msg.text} fg={theme.fgSecondary} />
        ) : (
          <span fg={theme.fgMuted}>{msg.text}</span>
        );
    }
  }

  if (highlighted) bg = theme.bgOverlaySel;

  // After the message, so its words are not names.
  const notSent = msg.delivery === "failed" && <span fg={theme.red}> (not sent)</span>;

  // Two columns, so a long body wraps inside its own column and the gutter line
  // continues down beside it.
  return (
    <box
      width="100%"
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={bg}
    >
      <box width={LABEL_COL_WIDTH} flexShrink={0} flexDirection="row">
        {grouped ? (
          <text>
            <span fg={theme.fgDim}>
              {BLANK_TIME} {BLANK_NICK}
            </span>
          </text>
        ) : (
          <>
            <text fg={theme.fgMuted}>{clockTime(msg.timestamp)} </text>
            {/* Yoga right-aligns the nick, measuring cells as the terminal does. */}
            <box width={NICK_COL_WIDTH} flexDirection="row" justifyContent="flex-end">
              {clickableNick && names ? (
                <NickLabel nick={clickableNick} color={labelFg} onSelect={names.openNick} />
              ) : (
                <text fg={labelFg}>{label}</text>
              )}
            </box>
          </>
        )}
      </box>
      <box
        flexGrow={1}
        flexShrink={1}
        marginLeft={1}
        paddingLeft={1}
        border={["left"]}
        customBorderChars={glyphs.border}
        borderColor={theme.gutter}
      >
        {segments && names ? (
          <NameText names={names} namesEnd={segments.reduce((n, seg) => n + seg.text.length, 0)}>
            {(hovered) => (
              <>
                <Segments
                  segments={hovered ? underlineRange(segments, hovered) : segments}
                  defaultFg={textFg}
                  forceItalic={msg.kind === "action"}
                />
                {notSent}
              </>
            )}
          </NameText>
        ) : segments ? (
          <text>
            <Segments segments={segments} defaultFg={textFg} forceItalic={msg.kind === "action"} />
          </text>
        ) : (
          <text>
            {body}
            {notSent}
          </text>
        )}
      </box>
    </box>
  );
});

/**
 * A sender's nick in the chat log. It is underlined under the mouse, and a
 * click opens a DM with them. It opens on mouse up, and only for a plain
 * click, so a drag that starts on the nick still selects text to copy.
 */
function NickLabel({
  nick,
  color,
  onSelect,
}: {
  nick: string;
  color: string;
  onSelect: (nick: string) => void;
}) {
  const renderer = useRenderer();
  const shown = shortNick(nick);
  return (
    <Clickable
      onMouseUp={(event) => {
        if (isPlainClick(renderer, event)) onSelect(nick);
      }}
    >
      {(hovered) => (
        <text>
          <span fg={color}>
            <strong>{hovered ? <u>{shown}</u> : shown}</strong>
          </span>
        </text>
      )}
    </Clickable>
  );
}

export function ChatPane({
  server,
  buffer,
  inputFocused,
  paneWidth,
  onSubmit,
  onPasteLines,
  onSelectUser,
  onJoinChannel,
  onOpenLink = openLink,
  onLoadOlder,
}: ChatPaneProps) {
  const inputRef = useRef<InputRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const [inputValue, setInputValue] = useState("");
  // Off with "mouse": false or --no-mouse. Then a click never reaches honk.
  const mouse = useRenderer().useMouse;
  const casemapping = casemappingOf(server);

  // Tab completion state
  const completionRef = useRef<{ matches: string[]; index: number } | null>(null);
  // Up/Down sent-message history
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number>(-1);
  const draftRef = useRef<string>("");
  // Guard so programmatic inputRef.current.value updates don't reset completion/history
  const programmaticRef = useRef(false);

  const setInputText = (next: string) => {
    programmaticRef.current = true;
    setInputValue(next);
    if (inputRef.current) {
      inputRef.current.value = next;
    }
    programmaticRef.current = false;
  };

  useKeyboard((key) => {
    if (!inputFocused) return;

    if (key.name === "tab") {
      const current = inputRef.current?.value ?? inputValue;
      const active = completionRef.current;

      if (active && active.matches[active.index] === current) {
        const delta = key.shift ? -1 : 1;
        const nextIdx =
          (active.index + delta + active.matches.length) % active.matches.length;
        active.index = nextIdx;
        setInputText(active.matches[nextIdx]!);
        return;
      }

      const channels = (server?.bufferOrder ?? []).filter(
        (b) => server?.buffers[b]?.kind === "channel",
      );
      const matches = getCompletions(current, {
        users: buffer?.users ?? [],
        messages: buffer?.messages ?? [],
        channels,
        myNick: server?.nick ?? "",
        casemapping,
      });

      if (matches.length > 0) {
        completionRef.current = { matches, index: 0 };
        setInputText(matches[0]!);
      }
      return;
    }

    const sb = scrollRef.current;
    // Scrolling up at the top loads older Lines, also in a Buffer that fits on the
    // screen, whose scroll position never moves.
    if (key.name === "pageup" || key.name === "pagedown") {
      sb?.scrollBy(key.name === "pageup" ? -0.5 : 0.5, "viewport");
      if (key.name === "pageup") loadOlderAtTop();
      return;
    }
    if (key.shift && (key.name === "up" || key.name === "down")) {
      sb?.scrollBy(key.name === "up" ? -SHIFT_SCROLL_LINES : SHIFT_SCROLL_LINES);
      if (key.name === "up") loadOlderAtTop();
      return;
    }

    // Up/Down and Ctrl+P/Ctrl+N (as in readline) walk the sent-line history.
    const plain = !key.meta && !key.option && !key.ctrl && !key.shift;
    const historyUp = (key.name === "up" && plain) || (key.ctrl && key.name === "p");
    const historyDown = (key.name === "down" && plain) || (key.ctrl && key.name === "n");

    if (historyUp) {
      const hist = historyRef.current;
      if (hist.length === 0) return;
      completionRef.current = null;
      if (historyIdxRef.current === -1) {
        draftRef.current = inputRef.current?.value ?? inputValue;
        historyIdxRef.current = hist.length - 1;
      } else if (historyIdxRef.current > 0) {
        historyIdxRef.current -= 1;
      }
      setInputText(hist[historyIdxRef.current]!);
      return;
    }

    if (historyDown) {
      const hist = historyRef.current;
      if (historyIdxRef.current === -1) return;
      completionRef.current = null;
      if (historyIdxRef.current < hist.length - 1) {
        historyIdxRef.current += 1;
        setInputText(hist[historyIdxRef.current]!);
      } else {
        historyIdxRef.current = -1;
        setInputText(draftRef.current);
      }
    }
  });

  // A paste with line breaks: the input is one line and would glue the lines together,
  // so each line is sent as its own message. Text already typed starts the first line.
  usePaste((event) => {
    if (!inputFocused) return;
    const text = new TextDecoder().decode(event.bytes).replace(/\r\n?/g, "\n");
    if (!text.includes("\n")) return;
    event.preventDefault();
    const typed = inputRef.current?.value ?? inputValue;
    const lines = (typed + text).split("\n").filter((l) => l.trim() !== "");
    setInputText("");
    if (lines.length > 0) onPasteLines(lines);
    scrollRef.current?.scrollTo(scrollRef.current.scrollHeight);
  });

  // "New messages below": the id of the last line on screen when the view left the
  // bottom, or null while the view is at the bottom.
  const bufferKey = `${server?.id ?? ""}:${buffer?.name ?? ""}`;
  const [lastSeenId, setLastSeenId] = useState<string | null>(null);
  const messagesRef = useRef(buffer?.messages ?? []);
  messagesRef.current = buffer?.messages ?? [];
  // Reaching the top loads older Lines above. The Line that was at the top stays there,
  // so the view does not jump: this holds its id until the next render scrolls to it.
  const keepAtTopRef = useRef<string | null>(null);
  const loadOlderRef = useRef(onLoadOlder);
  loadOlderRef.current = onLoadOlder;
  /** Loads older Lines if the view is at the top and no load waits for its render. */
  const loadOlderAtTop = () => {
    const sb = scrollRef.current;
    if (!sb || sb.scrollTop > 0 || keepAtTopRef.current !== null) return;
    const first = messagesRef.current[0]?.id;
    if (first && (loadOlderRef.current?.() ?? 0) > 0) keepAtTopRef.current = first;
  };
  useEffect(() => {
    setLastSeenId(null);
    const sb = scrollRef.current;
    if (!sb) return;
    let atTop = false;
    const onChange = () => {
      const top = sb.scrollTop <= 0;
      if (top && !atTop) loadOlderAtTop();
      atTop = top;
      const atBottom = sb.scrollTop + sb.viewport.height >= sb.scrollHeight - 1;
      setLastSeenId((prev) => {
        if (atBottom) return null;
        if (prev !== null) return prev;
        const msgs = messagesRef.current;
        return msgs[msgs.length - 1]?.id ?? "";
      });
    };
    sb.verticalScrollBar.on("change", onChange);
    return () => {
      sb.verticalScrollBar.off("change", onChange);
    };
  }, [bufferKey]);
  useEffect(() => {
    const id = keepAtTopRef.current;
    if (id === null) return;
    keepAtTopRef.current = null;
    scrollRef.current?.scrollChildIntoView(rowId(id), { align: "start" });
  }, [buffer?.messages]);
  let newBelow = 0;
  if (lastSeenId !== null && buffer) {
    const at = buffer.messages.findIndex((m) => m.id === lastSeenId);
    newBelow = buffer.messages.slice(at + 1).filter(isChatLine).length;
  }
  // The nicks a click in a message can open. Rows read them through a ref, so a
  // join or a part does not render every row again. The lookup map is built on
  // the first hover after the user list changes, not on every join and part.
  const users = buffer?.users ?? NO_USERS;
  const myNick = server?.nick ?? "";
  const nicksRef = useRef<{
    users: NickEntry[];
    myNick: string;
    casemapping: Casemapping;
    byKey?: Map<string, string>;
  }>({ users, myNick, casemapping });
  if (
    nicksRef.current.users !== users ||
    nicksRef.current.myNick !== myNick ||
    nicksRef.current.casemapping !== casemapping
  ) {
    nicksRef.current = { users, myNick, casemapping };
  }
  const findNick = useCallback((word: string) => {
    const nicks = nicksRef.current;
    const key = (nick: string) => nameKey(nick, nicks.casemapping);
    if (!nicks.byKey) {
      nicks.byKey = new Map(nicks.users.map((u) => [key(u.nick), u.nick]));
      nicks.byKey.delete(key(nicks.myNick));
    }
    return nicks.byKey.get(key(word));
  }, []);
  const names = useMemo(
    (): NameActions => ({ findNick, openNick: onSelectUser, openChannel: onJoinChannel }),
    [findNick, onSelectUser, onJoinChannel],
  );

  const jumpToBottom = () => scrollRef.current?.scrollTo(scrollRef.current.scrollHeight);

  const title = buffer ? buffer.name : STATUS_BUFFER;
  // Cut at the end to fit beside the title and the user count (2 + 2 padding,
  // the separator with a space on each side, and the count with its margin).
  // FormattedText cuts it after it parses it, so a cut link still opens the
  // whole URL.
  const usersText = buffer?.kind === "channel" ? `${buffer.users.length} users` : "";
  const separator = ` ${glyphs.topicSeparator} `;
  const topicRoom =
    paneWidth - 4 - cellWidth(title) - cellWidth(separator) - (usersText ? cellWidth(usersText) + 2 : 0);
  // At least 3 cells of the topic, plus the ellipsis.
  const topic = topicRoom >= 3 + cellWidth(glyphs.ellipsis) ? (buffer?.topic ?? "") : "";
  const promptLabel = server
    ? `${server.name}/${title}`
    : title;

  const handleInput = (val: string) => {
    setInputValue(val);
    if (!programmaticRef.current) {
      completionRef.current = null;
      historyIdxRef.current = -1;
    }
  };

  const handleSubmit = (val: string) => {
    const text = val || inputValue;
    if (!text.trim()) return;
    const hist = historyRef.current;
    if (hist[hist.length - 1] !== text) {
      hist.push(text);
      if (hist.length > 100) hist.shift();
    }
    historyIdxRef.current = -1;
    draftRef.current = "";
    completionRef.current = null;
    onSubmit(text);
    setInputText("");
    // Sending a line means you want to see it, even if you had scrolled up.
    scrollRef.current?.scrollTo(scrollRef.current.scrollHeight);
  };

  const now = new Date();

  return (
    // Links anywhere in the pane open with a click: the topic and the messages.
    <LinkArea
      onOpenLink={onOpenLink}
      flexDirection="column"
      flexGrow={1}
      height="100%"
      backgroundColor={theme.bgBase}
    >
      {/* Top topic header */}
      <box
        height={HEADER_HEIGHT}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={theme.bgBase}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text flexShrink={1} wrapMode="none">
          <span fg={theme.accent}>
            <strong>{title}</strong>
          </span>
          {topic ? (
            <>
              <span fg={theme.fgMuted}>{separator}</span>
              <FormattedText text={topic} defaultFg={theme.fgMuted} maxWidth={topicRoom} />
            </>
          ) : null}
        </text>
        {buffer?.kind === "channel" && (
          <text fg={theme.fgMuted} flexShrink={0} marginLeft={2}>
            {usersText}
          </text>
        )}
      </box>

      {/* Scrollable message feed */}
      {/* Keyed by buffer: each buffer gets its own scroll position and starts at the
          bottom, so scrolling one buffer never leaves another one scrolled up. */}
      <scrollbox
        key={bufferKey}
        ref={scrollRef}
        flexGrow={1}
        scrollAcceleration={WHEEL_ACCEL}
        stickyScroll
        stickyStart="bottom"
        scrollX={false}
        onMouseScroll={(event: { scroll?: { direction?: string } }) => {
          if (event.scroll?.direction === "up") loadOlderAtTop();
        }}
        style={scrollboxStyle(theme.bgBase)}
      >
        {/* No top padding: the header's own bottom padding is the gap. */}
        <box flexDirection="column" paddingBottom={1}>
          {buffer?.scrollbackFull && (
            <text fg={theme.fgMuted} paddingLeft={2}>
              {`honk holds ${buffer.messages.length} lines of ${buffer.name}. Search the log (Ctrl+F) for older ones.`}
            </text>
          )}
          {buffer?.messages.map((msg, idx) => {
            const isFirstUnread = msg.id === buffer.firstUnreadId;
            const prev = idx > 0 ? buffer.messages[idx - 1] : undefined;
            const day = dayLabelBefore(prev?.timestamp, msg.timestamp, now);
            const grouped =
              !isFirstUnread &&
              day === null &&
              msg.kind === "message" &&
              prev?.kind === "message" &&
              sameNick(prev.from, msg.from, casemapping) &&
              msg.timestamp.getTime() - prev.timestamp.getTime() < GROUP_WINDOW_MS;

            return (
              <box key={msg.id} id={rowId(msg.id)} flexDirection="column" width="100%">
                {(day !== null || isFirstUnread) && (
                  /* The day goes first, then "new". A blank line above and below the pair. */
                  <box flexDirection="column" marginTop={1} marginBottom={1}>
                    {day !== null && <Divider label={day} color={theme.fgMuted} paneWidth={paneWidth} />}
                    {isFirstUnread && <Divider label="new" color={theme.red} paneWidth={paneWidth} />}
                  </box>
                )}
                <MessageRow
                  msg={msg}
                  grouped={grouped}
                  highlightMentions={buffer.kind === "channel"}
                  names={names}
                />
              </box>
            );
          })}
        </box>
      </scrollbox>

      {newBelow > 0 && (
        <Clickable
          height={1}
          paddingLeft={2}
          backgroundColor={theme.bgActiveRow}
          hoverColor={theme.bgActiveRowHover}
          onMouseDown={jumpToBottom}
        >
          <text fg={theme.accent}>
            {newBelow} new {newBelow === 1 ? "message" : "messages"} below{" "}
            <span fg={theme.fgMuted}>{mouse ? "(PgDn or click to read)" : "(PgDn to read)"}</span>
          </text>
        </Clickable>
      )}

      {/* Shaded prompt input bar */}
      <box
        height={3}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        backgroundColor={theme.bgInput}
        flexDirection="row"
        alignItems="flex-start"
      >
        <text>
          <span fg={theme.accent}>
            <strong>{promptLabel}</strong>
          </span>
          <span fg={theme.cyan}> {glyphs.prompt} </span>
        </text>
        <input
          ref={inputRef}
          flexGrow={1}
          focused={inputFocused}
          value={inputValue}
          placeholder="Message or /help..."
          backgroundColor={theme.bgInput}
          textColor={theme.fgBright}
          // Set these too: the input copies them once, when it is created.
          focusedBackgroundColor={theme.bgInput}
          focusedTextColor={theme.fgBright}
          placeholderColor={theme.fgMuted}
          onInput={handleInput}
          onSubmit={handleSubmit}
        />
      </box>
    </LinkArea>
  );
}
