import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer } from "@opentui/react";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { isUserSender, sameNick, STATUS_BUFFER } from "../irc/names.ts";
import { nickColor, theme, useThemeVersion } from "../theme.ts";
import type { BufferState, ChatMessage, ServerState } from "../types.ts";
import { Clickable, isPlainClick } from "./Clickable.tsx";
import { getCompletions } from "./completion.ts";
import { HEADER_HEIGHT, scrollboxStyle, truncate } from "./display.ts";
import { FormattedText, LinkedText } from "./format.tsx";

interface ChatPaneProps {
  server: ServerState | undefined;
  buffer: BufferState | undefined;
  inputFocused: boolean;
  paneWidth: number;
  onSubmit: (value: string) => void;
  /** A paste of several lines: each line is sent as its own message. */
  onPasteLines: (lines: string[]) => void;
  /** A click on a sender's nick: open a DM with them, as in the nick list. */
  onSelectUser: (nick: string) => void;
}

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

function formatTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function padNick(nick: string): string {
  return truncate(nick, NICK_COL_WIDTH).padStart(NICK_COL_WIDTH, " ");
}

function UnreadDivider({ paneWidth }: { paneWidth: number }) {
  const label = " new ";
  const innerWidth = Math.max(label.length + 4, paneWidth - 2);
  const sideTotal = Math.max(4, innerWidth - label.length);
  const left = Math.floor(sideTotal / 2);
  const right = sideTotal - left;
  return (
    <box width="100%" paddingLeft={1} paddingRight={1} marginTop={1} marginBottom={1}>
      <text>
        <span fg={theme.red}>{"─".repeat(left)}</span>
        <span fg={theme.red}>
          <strong>{label}</strong>
        </span>
        <span fg={theme.red}>{"─".repeat(right)}</span>
      </text>
    </box>
  );
}

/**
 * One chat line: time, a 12-column label, the gutter, then the body.
 * Memoized because message objects keep their identity across store updates,
 * so typing or a new line only renders the rows that changed.
 */
const MessageRow = memo(function MessageRow({
  msg,
  grouped,
  highlightMentions,
  onSelectUser,
}: {
  msg: ChatMessage;
  grouped: boolean;
  /** False in a DM: every line there is to you, so painting each one adds nothing. */
  highlightMentions: boolean;
  onSelectUser: (nick: string) => void;
}) {
  useThemeVersion(); // re-render when the theme changes
  const mention = highlightMentions && Boolean(msg.isMention);
  const sender = msg.from ?? "";
  const senderColor = msg.isSelf ? theme.accent : nickColor(sender);
  // A line you sent that the server hasn't confirmed yet (or never will) is dimmed.
  const unconfirmed = msg.delivery !== undefined;
  let label: ReactNode;
  let labelFg: string;
  let body: ReactNode;
  let bg: string | undefined;
  // The sender of a message, when a click on the nick opens a DM with them.
  let clickableNick: string | undefined;

  switch (msg.kind) {
    case "message":
      label = <strong>{padNick(sender)}</strong>;
      labelFg = senderColor;
      if (!msg.isSelf && isUserSender(sender)) clickableNick = sender;
      bg = mention ? theme.bgMention : theme.bgBase;
      body = (
        <FormattedText
          text={msg.text}
          defaultFg={unconfirmed ? theme.fgMuted : mention ? theme.fgBright : theme.fgPrimary}
        />
      );
      break;
    case "action":
      label = padNick("*");
      labelFg = theme.accentAlt;
      bg = mention ? theme.bgMention : theme.bgBase;
      body = (
        <>
          <span fg={senderColor}>
            <em>{sender} </em>
          </span>
          <FormattedText
            text={msg.text}
            defaultFg={unconfirmed ? theme.fgMuted : theme.accentAlt}
            forceItalic
          />
        </>
      );
      break;
    case "notice":
      label = padNick(`-${msg.from ?? "notice"}-`);
      labelFg = theme.yellow;
      body = <FormattedText text={msg.text} defaultFg={theme.yellow} />;
      break;
    case "error":
      label = padNick("!");
      labelFg = theme.red;
      body = <span fg={theme.red}>{msg.text}</span>;
      break;
    default: {
      // join, part, system
      label = padNick(msg.kind === "join" ? "→" : msg.kind === "part" ? "←" : "·");
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

  if (msg.delivery === "failed") {
    body = (
      <>
        {body}
        <span fg={theme.red}> (not sent)</span>
      </>
    );
  }

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
        ) : clickableNick ? (
          <>
            <text>
              <span fg={theme.fgMuted}>{formatTime(msg.timestamp)} </span>
              {padNick(clickableNick).slice(0, -truncate(clickableNick, NICK_COL_WIDTH).length)}
            </text>
            <NickLabel nick={clickableNick} color={labelFg} onSelect={onSelectUser} />
          </>
        ) : (
          <text>
            <span fg={theme.fgMuted}>{formatTime(msg.timestamp)} </span>
            <span fg={labelFg}>{label}</span>
          </text>
        )}
      </box>
      <box
        flexGrow={1}
        flexShrink={1}
        marginLeft={1}
        paddingLeft={1}
        border={["left"]}
        borderColor={theme.gutter}
      >
        <text>{body}</text>
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
  const shown = truncate(nick, NICK_COL_WIDTH);
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
}: ChatPaneProps) {
  const inputRef = useRef<InputRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const [inputValue, setInputValue] = useState("");

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
      });

      if (matches.length > 0) {
        completionRef.current = { matches, index: 0 };
        setInputText(matches[0]!);
      }
      return;
    }

    const sb = scrollRef.current;
    if (key.name === "pageup" || key.name === "pagedown") {
      sb?.scrollBy(key.name === "pageup" ? -0.5 : 0.5, "viewport");
      return;
    }
    if (key.shift && (key.name === "up" || key.name === "down")) {
      sb?.scrollBy(key.name === "up" ? -SHIFT_SCROLL_LINES : SHIFT_SCROLL_LINES);
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
  useEffect(() => {
    setLastSeenId(null);
    const sb = scrollRef.current;
    if (!sb) return;
    const onChange = () => {
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
  let newBelow = 0;
  if (lastSeenId !== null && buffer) {
    const at = buffer.messages.findIndex((m) => m.id === lastSeenId);
    newBelow = buffer.messages.slice(at + 1).filter(isChatLine).length;
  }
  const jumpToBottom = () => scrollRef.current?.scrollTo(scrollRef.current.scrollHeight);

  const title = buffer ? buffer.name : STATUS_BUFFER;
  // Cut at the end to fit beside the title and the user count (2 + 2 padding,
  // " — ", and the count with its margin). Formatting codes count as characters,
  // so a coloured topic may be cut a little early.
  const usersText = buffer?.kind === "channel" ? `${buffer.users.length} users` : "";
  const topicRoom =
    paneWidth - 4 - (buffer?.name ?? STATUS_BUFFER).length - 3 - (usersText ? usersText.length + 2 : 0);
  const topic = topicRoom >= 4 ? truncate(buffer?.topic ?? "", topicRoom) : "";
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

  return (
    <box
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
              <span fg={theme.fgMuted}> — </span>
              <FormattedText text={topic} defaultFg={theme.fgMuted} />
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
        style={scrollboxStyle(theme.bgBase)}
      >
        {/* No top padding: the header's own bottom padding is the gap. */}
        <box flexDirection="column" paddingBottom={1}>
          {buffer?.messages.map((msg, idx) => {
            const showDivider = msg.id === buffer.firstUnreadId;
            const prev = idx > 0 ? buffer.messages[idx - 1] : undefined;
            const grouped =
              !showDivider &&
              msg.kind === "message" &&
              prev?.kind === "message" &&
              sameNick(prev.from, msg.from) &&
              msg.timestamp.getTime() - prev.timestamp.getTime() < GROUP_WINDOW_MS;

            return (
              <box key={msg.id} flexDirection="column" width="100%">
                {showDivider && <UnreadDivider paneWidth={paneWidth} />}
                <MessageRow
                  msg={msg}
                  grouped={grouped}
                  highlightMentions={buffer.kind === "channel"}
                  onSelectUser={onSelectUser}
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
            <span fg={theme.fgMuted}>(PgDn or click to read)</span>
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
          <span fg={theme.cyan}> ❯ </span>
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
    </box>
  );
}
