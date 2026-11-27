import { useEffect, useState } from "react";
import { theme } from "../theme.ts";
import type { ServerState, UpdateNotice } from "../types.ts";
import { cellWidth, statusIndicator } from "./display.ts";
import { statusHints } from "./statusHints.ts";

interface StatusBarProps {
  server: ServerState | undefined;
  width: number;
  /** False when the terminal is too narrow for the panel, so its key does nothing. */
  sidebarFits: boolean;
  nicklistFits: boolean;
  /** A newer honk release, or null. */
  update: UpdateNotice | null;
}

export function StatusBar({ server, width, sidebarFits, nicklistFits, update }: StatusBarProps) {
  const [now, setNow] = useState(() => Date.now());
  const isReconnecting =
    server?.status === "reconnecting" && Boolean(server.reconnectInfo);

  useEffect(() => {
    if (!isReconnecting) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [isReconnecting, server?.reconnectInfo?.nextRetryAt]);

  const status = server?.status ?? "disconnected";
  const dot = statusIndicator(status);

  const retrySeconds =
    isReconnecting && server?.reconnectInfo
      ? Math.max(0, Math.ceil((server.reconnectInfo.nextRetryAt - now) / 1000))
      : 0;

  const name = server?.name ?? "disconnected";
  const viaText = server?.via ? ` via ${server.via}` : "";
  const tlsText = server?.tls ? " TLS" : "";
  const stateText =
    isReconnecting && server?.reconnectInfo
      ? `  reconnecting in ${retrySeconds}s (attempt ${server.reconnectInfo.attempt})`
      : status === "connecting"
        ? "  connecting…"
        : server?.nick
          ? `  nick: ${server.nick}`
          : "";
  // 2 + 2 columns of padding, the dot and its space, and a gap of 2 before the hints.
  const leftWidth = 2 + cellWidth(name + viaText + tlsText + stateText);
  const room = width - 4 - leftWidth - 2;
  const hints = statusHints({ sidebarFits, nicklistFits, update }, room);

  return (
    <box
      height={3}
      width="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={theme.bgFooter}
      flexDirection="row"
      justifyContent="space-between"
    >
      <text flexShrink={1} wrapMode="none" truncate>
        <span fg={dot.color}>{dot.glyph} </span>
        <span fg={theme.fgPrimary}>
          <strong>{server?.name ?? "disconnected"}</strong>
        </span>
        {server?.via && (
          <span fg={theme.fgMuted}>
            {" "}via <span fg={theme.accentAlt}>{server.via}</span>
          </span>
        )}
        {server?.tls && <span fg={theme.cyan}> TLS</span>}
        {isReconnecting && server?.reconnectInfo ? (
          <span fg={theme.yellow}>
            {"  "}reconnecting in {retrySeconds}s (attempt{" "}
            {server.reconnectInfo.attempt})
          </span>
        ) : status === "connecting" ? (
          <span fg={theme.yellow}>{"  "}connecting…</span>
        ) : (
          server?.nick && (
            <span fg={theme.fgMuted}>
              {"  "}nick: <span fg={theme.fgSecondary}>{server.nick}</span>
            </span>
          )
        )}
      </text>

      <text fg={theme.fgMuted} flexShrink={0} wrapMode="none">
        {hints.map((h, i) => (
          <span key={h.key}>
            {i > 0 ? "  " : ""}
            <span fg={theme.accent}>{h.key}</span> {h.label}
          </span>
        ))}
      </text>
    </box>
  );
}
