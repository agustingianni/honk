import { memo } from "react";
import { nickColor, prefixColor, theme, useThemeVersion } from "../theme.ts";
import type { BufferState } from "../types.ts";
import { Clickable } from "./Clickable.tsx";
import { HEADER_HEIGHT, scrollboxStyle, truncate } from "./display.ts";

interface NicklistProps {
  users: BufferState["users"];
  myNick: string;
  onSelectUser: (nick: string) => void;
}

/** Memoized: only re-renders when this buffer's user list, the nick, the handler or the theme changes. */
export const Nicklist = memo(function Nicklist({
  users,
  myNick,
  onSelectUser,
}: NicklistProps) {
  const themeVersion = useThemeVersion();
  const myLower = myNick.toLowerCase();

  return (
    <box
      flexDirection="column"
      width={20}
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
          <strong>USERS ({users.length})</strong>
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
                prefix={u.prefix}
                isSelf={u.nick.toLowerCase() === myLower}
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
const NickRow = memo(function NickRow({ nick, prefix, isSelf, onSelectUser }: NickRowProps) {
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
      <text selectable={false}>
        <span fg={prefixColor(prefix)}>{prefix ? prefix : " "}</span>
        <span fg={isSelf ? theme.accent : nickColor(nick)}>
          {isSelf ? <strong>{truncate(nick, 16)}</strong> : truncate(nick, 16)}
        </span>
      </text>
    </Clickable>
  );
});
