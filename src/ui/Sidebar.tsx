import { STATUS_BUFFER } from "../irc/names.ts";
import { theme } from "../theme.ts";
import { Clickable } from "./Clickable.tsx";
import type { ActiveBuffer, ServerState } from "../types.ts";
import {
  bufferDisplayName,
  scrollboxStyle,
  statusIndicator,
  truncate,
  unreadBadge,
  HEADER_HEIGHT,
} from "./display.ts";
import { glyphs } from "./glyphs.ts";
import { bufferNameRoom, serverNameRoom } from "./panelWidths.ts";

interface SidebarProps {
  /** Cells, from sidebarWidth and panelLayout. */
  width: number;
  servers: ServerState[];
  active: ActiveBuffer | null;
  onSelect: (serverId: string, buffer: string) => void;
  onConnectServer: (serverId: string) => void;
}

export function Sidebar({
  width,
  servers,
  active,
  onSelect,
  onConnectServer,
}: SidebarProps) {
  return (
    <box
      flexDirection="column"
      width={width}
      height="100%"
      backgroundColor={theme.bgSidebar}
    >
      <box
        height={HEADER_HEIGHT}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        backgroundColor={theme.bgSidebar}
      >
        <text fg={theme.fgMuted}>
          <strong>SERVERS</strong>
        </text>
      </box>

      <scrollbox
        flexGrow={1}
        scrollX={false}
        style={scrollboxStyle(theme.bgSidebar)}
      >
        {servers.map((server, i) => {
          const st = statusIndicator(server.status);
          return (
            // The header's bottom padding already spaces the first server; later ones get a gap.
            <box key={server.id} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
              {/* Server header */}
              <Clickable
                height={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={theme.bgSidebar}
                hoverColor={theme.bgRowHover}
                onMouseDown={() => {
                  onSelect(server.id, STATUS_BUFFER);
                  if (server.status === "disconnected" && server.config.host) {
                    onConnectServer(server.id);
                  }
                }}
              >
                <text>
                  <span fg={st.color}>{st.glyph} </span>
                  <span fg={theme.fgBright}>
                    <strong>{truncate(server.name, serverNameRoom(width))}</strong>
                  </span>
                </text>
              </Clickable>

              {/* Buffers under this server */}
              {server.bufferOrder.map((bufName) => {
                const buf = server.buffers[bufName];
                if (!buf) return null;
                const isActive =
                  active?.serverId === server.id && active?.buffer === bufName;
                const displayName = bufferDisplayName(buf);
                const maxNameLen = bufferNameRoom(width, buf.unread > 0);

                return (
                  <Clickable
                    key={bufName}
                    height={1}
                    flexDirection="row"
                    justifyContent="space-between"
                    paddingRight={1}
                    backgroundColor={
                      isActive ? theme.bgActiveRow : theme.bgSidebar
                    }
                    hoverColor={isActive ? undefined : theme.bgRowHover}
                    onMouseDown={() => onSelect(server.id, bufName)}
                  >
                    <text>
                      <span fg={isActive ? theme.accent : theme.bgSidebar}>
                        {isActive ? glyphs.selectedRow : " "}
                      </span>
                      <span
                        fg={
                          isActive
                            ? theme.fgBright
                            : buf.hasMention
                              ? theme.red
                              : buf.unread > 0
                                ? theme.fgPrimary
                                : buf.kind === "status"
                                  ? theme.fgMuted
                                  : theme.fgSecondary
                        }
                      >
                        {" "}
                        {isActive ? (
                          <strong>{truncate(displayName, maxNameLen)}</strong>
                        ) : (
                          truncate(displayName, maxNameLen)
                        )}
                      </span>
                    </text>

                    {buf.unread > 0 && (
                      <text fg={buf.hasMention ? theme.red : theme.accent}>
                        <strong>{unreadBadge(buf.unread)}</strong>
                      </text>
                    )}
                  </Clickable>
                );
              })}
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}
