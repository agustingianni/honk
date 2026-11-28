import { memo } from "react";
import { type Casemapping, nameKey } from "../irc/names.ts";
import { nickColor, prefixColor, theme, useThemeVersion } from "../theme.ts";
import type { BufferState } from "../types.ts";
import { Clickable } from "./Clickable.tsx";
import { HEADER_HEIGHT, scrollboxStyle, truncate } from "./display.ts";
import { nicklistHeader, nicklistNickRoom } from "./panelWidths.ts";

interface NicklistProps {
  /** Cells, from nicklistWidth and panelLayout. */
  width: number;
  users: BufferState["users"];
  myNick: string;
  /** The server's casemapping, to find your own nick in the list. */
  casemapping: Casemapping;
  onSelectUser: (nick: string) => void;
}

/** Memoized: only re-renders when this buffer's user list, the nick, the handler or the theme changes. */
export const Nicklist = memo(function Nicklist({
  width,
  users,
  myNick,
  casemapping,
  onSelectUser,
}: NicklistProps) {
  const themeVersion = useThemeVersion();
  const myKey = nameKey(myNick, casemapping);

  return (
    <box
      flexDirection="column"
      width={width}
      height="100%"
      backgroundColor={theme.bgNicklist}
    >
      <box
        height={HEADER_HEIGHT}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        backgroundColor={theme.bgNicklist}
      >
        <text fg={theme.fgMuted}>
          <strong>{nicklistHeader(users.length)}</strong>
        </text>
      </box>

      <scrollbox
        flexGrow={1}
        scrollX={false}
        style={scrollboxStyle(theme.bgNicklist)}
      >
        <box flexDirection="column" paddingBottom={1}>
          {users.length === 0 ? (
            <box paddingLeft={2}>
              <text fg={theme.fgDim}>No users</text>
            </box>
          ) : (
            users.map((u) => (
              <NickRow
                key={u.nick}
                nick={u.nick}
                room={nicklistNickRoom(width)}
                prefix={u.prefix}
                isSelf={nameKey(u.nick, casemapping) === myKey}
                onSelectUser={onSelectUser}
                themeVersion={themeVersion}
              />
            ))
          )}
        </box>
      </scrollbox>
    </box>
  );
});

interface NickRowProps {
  nick: string;
  /** The cells the nick gets: a longer nick is cut. */
  room: number;
  prefix: string;
  isSelf: boolean;
  onSelectUser: (nick: string) => void;
  /** Only here so that a new theme renders the row again. */
  themeVersion: number;
}

/**
 * Memoized: a join or quit in a channel with thousands of users renders only
 * the rows that changed, not every row.
 */
const NickRow = memo(function NickRow({ nick, room, prefix, isSelf, onSelectUser }: NickRowProps) {
  return (
    <Clickable
      height={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.bgNicklist}
      hoverColor={theme.bgRowHover}
      // Your own nick does nothing on a click, so it gets no hover look.
      onMouseDown={isSelf ? undefined : () => onSelectUser(nick)}
    >
      <text>
        <span fg={prefixColor(prefix)}>{prefix ? prefix : " "}</span>
        <span fg={isSelf ? theme.accent : nickColor(nick)}>
          {isSelf ? <strong>{truncate(nick, room)}</strong> : truncate(nick, room)}
        </span>
      </text>
    </Clickable>
  );
});
