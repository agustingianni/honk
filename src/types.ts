import type { Casemapping } from "./irc/names.ts";
import type { LogSettings } from "./log/messageLog.ts";

export type AuthMethod = "sasl" | "saslExternal" | "NickServ";

export interface ServerConfig {
  id: string;
  name?: string;
  via?: string;
  host: string;
  port?: number;
  tls?: boolean;
  nick: string;
  username?: string;
  realname?: string;
  password?: string;
  serverPassword?: string;
  authMethod?: AuthMethod;
  channels?: string[];
  autoConnect?: boolean;
  /** Buffer names this Server never writes to the Log, such as "#secret". */
  logExclude?: string[];
}

export interface AppConfig {
  servers: ServerConfig[];
  /**
   * Desktop notifications for mentions and DMs. On unless set to false. A protocol name
   * ("osc9", "osc777" or "osc99") forces that escape sequence, for terminals honk can't
   * detect. Any other value is kept so startup can warn about it. See src/notifyProtocol.ts.
   */
  notifications?: boolean | string;
  /** Color theme id, such as "nord". See src/themes/index.ts. */
  theme?: string;
  /**
   * Mouse capture: clicks, the hand pointer and wheel scrolling. On unless set
   * to false, in the config file or with --no-mouse. With it off, a plain drag
   * selects text in the terminal, and tmux copy mode works on honk's pane.
   */
  mouse?: boolean;
  /**
   * Draw only ASCII symbols, in the config file or with --ascii. When unset,
   * honk decides from TERM. See src/ui/glyphs.ts.
   */
  ascii?: boolean;
  /** The Log of your chats on disk. See src/log/messageLog.ts. */
  logs?: LogSettings;
  /**
   * The config file: the one honk read, or the --config path even if that file
   * does not exist yet. Settings saved from the UI go there. Set by loadConfig,
   * never read from the file.
   */
  path?: string;
}

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error";

export type MessageKind =
  | "message"
  | "action"
  | "notice"
  | "system"
  | "join"
  | "part"
  | "error";

export interface ChatMessage {
  id: string;
  msgid?: string;
  timestamp: Date;
  /** True if `timestamp` is the server's (a time tag), not honk's clock. See src/irc/replay.ts. */
  timeFromServer?: boolean;
  kind: MessageKind;
  from?: string;
  text: string;
  isMention?: boolean;
  isSelf?: boolean;
  isHistory?: boolean;
  /**
   * For a line you sent: "pending" until the server confirms it, "failed" if the
   * connection died first. Unset once confirmed. See src/irc/delivery.ts.
   */
  delivery?: "pending" | "failed";
}

export interface NickEntry {
  prefix: string;
  nick: string;
}

export type BufferKind = "status" | "channel" | "dm";

export interface BufferState {
  name: string;
  kind: BufferKind;
  topic: string;
  messages: ChatMessage[];
  users: NickEntry[];
  unread: number;
  hasMention: boolean;
  firstUnreadId?: string;
  /** Max messages kept. Grows past the default when history is loaded, so it isn't trimmed away. */
  messageLimit?: number;
}

export interface ReconnectInfo {
  attempt: number;
  nextRetryAt: number;
}

export interface ServerState {
  id: string;
  name: string;
  networkName?: string;
  via?: string;
  config: ServerConfig;
  status: ConnectionStatus;
  reconnectInfo?: ReconnectInfo;
  nick: string;
  /**
   * Which names the server sees as the same, from CASEMAPPING. Each connection starts
   * at the default and takes the server's 005 value. Compare names with it (see nameKey).
   */
  casemapping: Casemapping;
  tls: boolean;
  buffers: Record<string, BufferState>;
  bufferOrder: string[];
}

export interface ActiveBuffer {
  serverId: string;
  buffer: string;
}

/** A newer honk release, found by the update check (src/updateCheck.ts). */
export interface UpdateNotice {
  /** The latest release tag, such as "v0.3.0". */
  latest: string;
  /** True when `honk upgrade` can replace this copy. */
  upgradeable: boolean;
}

export interface StoreSnapshot {
  servers: ServerState[];
  active: ActiveBuffer | null;
  /** Shown in the status bar. Null when honk is up to date, or before the check answers. */
  update: UpdateNotice | null;
}
