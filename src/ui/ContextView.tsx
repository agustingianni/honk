import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useMemo, useRef } from "react";
import { storedMessages } from "../log/scrollback.ts";
import type { LogContext } from "../log/search.ts";
import { theme } from "../theme.ts";
import { Divider, MessageRow, useNickColumn } from "./ChatPane.tsx";
import { dayLabelBefore } from "./dayDivider.ts";
import { HEADER_HEIGHT, scrollboxStyle } from "./display.ts";

interface ContextViewProps {
  context: LogContext;
  paneWidth: number;
  /** False while the omnibox is open over it: then it takes no keys. */
  focused: boolean;
  /** Esc: back to the search results. */
  onBack: () => void;
  /** The most cells the nick column takes, from the "nickColumnMax" config key. */
  nickColumnMax: number;
}


/**
 * A Context view: the Lines around a search hit, read from the Log, with the hit
 * highlighted. It is read-only, so it has no input. It takes the chat pane's place.
 */
export function ContextView({
  context,
  paneWidth,
  focused,
  onBack,
  nickColumnMax,
}: ContextViewProps) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const messages = useMemo(() => storedMessages(context.buffer, context.lines), [context]);
  const matchId = messages[context.match]?.id;
  const nickWidth = useNickColumn(`${context.network}:${context.buffer}`, messages, nickColumnMax, paneWidth);

  // The hit starts a third of the way down, with the Lines before it above.
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb || !matchId) return;
    sb.scrollChildIntoView(`ctx-${matchId}`, {
      align: "start",
      inset: Math.floor(sb.viewport.height / 3),
    });
  }, [matchId]);

  useKeyboard((key) => {
    if (!focused) return;
    const sb = scrollRef.current;
    if (key.name === "escape") onBack();
    else if (key.name === "pageup" || key.name === "pagedown") {
      sb?.scrollBy(key.name === "pageup" ? -0.5 : 0.5, "viewport");
    } else if (key.name === "up" || key.name === "down") {
      sb?.scrollBy(key.name === "up" ? -1 : 1);
    }
  });

  const now = new Date();
  return (
    <box flexDirection="column" flexGrow={1} height="100%" backgroundColor={theme.bgBase}>
      <box
        height={HEADER_HEIGHT}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text flexShrink={1} wrapMode="none">
          <span fg={theme.accent}>
            <strong>{context.buffer}</strong>
          </span>
          <span fg={theme.fgMuted}> on {context.network}, from the log</span>
        </text>
        <text fg={theme.fgMuted} flexShrink={0} marginLeft={2}>
          Esc: back to the results
        </text>
      </box>
      <scrollbox ref={scrollRef} flexGrow={1} scrollX={false} style={scrollboxStyle(theme.bgBase)}>
        <box flexDirection="column" paddingBottom={1}>
          {messages.map((msg, idx) => {
            const day = dayLabelBefore(messages[idx - 1]?.timestamp, msg.timestamp, now);
            return (
              <box key={msg.id} id={`ctx-${msg.id}`} flexDirection="column" width="100%">
                {day !== null && (
                  <box marginTop={1} marginBottom={1}>
                    <Divider label={day} color={theme.fgMuted} paneWidth={paneWidth} />
                  </box>
                )}
                <MessageRow
                  msg={msg}
                  grouped={false}
                  highlightMentions={context.bufferKind === "channel"}
                  highlighted={idx === context.match}
                  nickWidth={nickWidth}
                />
              </box>
            );
          })}
        </box>
      </scrollbox>
    </box>
  );
}
