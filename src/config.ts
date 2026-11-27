import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AppConfig, AuthMethod, ServerConfig } from "./types.ts";

export function defaultNick(): string {
  return process.env.USER || "guest";
}

/** Id for a server added by host alone (/connect, --server): the full host, so hosts never collide. */
export function serverIdFromHost(host: string): string {
  return host.toLowerCase();
}

export function sameHost(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/**
 * Parses a port argument. "+6697" means TLS (the HexChat style); otherwise only 6697 is TLS.
 * Returns undefined if `arg` isn't a port.
 */
export function parsePortArg(arg: string | undefined): { port: number; tls: boolean } | undefined {
  const m = arg ? /^(\+)?(\d+)$/.exec(arg) : null;
  if (!m) return undefined;
  const port = Number(m[2]);
  return { port, tls: Boolean(m[1]) || port === 6697 };
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key.startsWith("no-")) {
      flags[key.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      i++;
      if (key === "channel") {
        const list = (flags[key] as string[] | undefined) ?? [];
        list.push(next);
        flags[key] = list;
      } else {
        flags[key] = next;
      }
    }
  }
  return flags;
}

/** A config file honk can't use. The message names the file and says what is wrong. */
export class ConfigError extends Error {}

function readConfigFile(path: string): AppConfig | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  let parsed: Partial<AppConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<AppConfig>;
  } catch (err) {
    const reason = (err as Error).message.replace(/^JSON Parse error: /, "");
    throw new ConfigError(`${path} is not valid JSON: ${reason}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${path} must hold a JSON object, such as {"servers": [...]}`);
  }
  const notifications = parsed.notifications ?? true;
  const theme = typeof parsed.theme === "string" ? parsed.theme : undefined;
  // JSON null counts as missing. loadConfig turns missing into true.
  const mouse = parsed.mouse ?? undefined;
  if (mouse !== undefined && typeof mouse !== "boolean") {
    throw new ConfigError(`${path}: "mouse" must be true or false, not ${JSON.stringify(mouse)}`);
  }
  const servers = Array.isArray(parsed.servers) ? parsed.servers : [];
  return {
    notifications,
    theme,
    mouse,
    servers: servers.map((s, idx) => ({
      id: s.id || s.name || s.host || `server-${idx + 1}`,
      name: s.name || s.id || s.host,
      via: s.via,
      host: s.host,
      port: s.port ?? (s.tls === false ? 6667 : 6697),
      tls: s.tls ?? true,
      nick: s.nick || defaultNick(),
      username: s.username,
      realname: s.realname,
      password: s.password,
      serverPassword: s.serverPassword,
      authMethod: s.authMethod ?? (s.password ? "sasl" : undefined),
      channels: s.channels ?? [],
      autoConnect: s.autoConnect ?? true,
    })),
  };
}

export function loadConfig(argv: string[] = process.argv.slice(2)): AppConfig {
  const flags = parseArgs(argv);

  // 1. Check explicit --config or default file locations
  const candidates: string[] = [];
  if (typeof flags.config === "string") {
    candidates.push(resolve(flags.config));
  } else {
    candidates.push(resolve("honk.json"));
    candidates.push(defaultConfigPath());
  }

  // With --config, that file is the config file even before it exists.
  let config: AppConfig = {
    servers: [],
    path: typeof flags.config === "string" ? candidates[0] : undefined,
  };

  for (const candidate of candidates) {
    const loaded = readConfigFile(candidate);
    if (loaded) {
      config = { ...loaded, path: candidate };
      break;
    }
  }

  if (typeof flags.theme === "string") config = { ...config, theme: flags.theme };
  const mouse = typeof flags.mouse === "boolean" ? flags.mouse : (config.mouse ?? true);
  config = { ...config, mouse };

  // 2. Allow quick CLI --server override/addition
  if (typeof flags.server === "string") {
    const [hostPart, portPart] = flags.server.split(":");
    const host = hostPart!;
    const tls = flags.tls === undefined ? true : Boolean(flags.tls);
    const port = portPart
      ? Number(portPart)
      : typeof flags.port === "string"
        ? Number(flags.port)
        : tls
          ? 6697
          : 6667;
    const nick = typeof flags.nick === "string" ? flags.nick : defaultNick();
    const password =
      typeof flags.password === "string" ? flags.password : undefined;
    const channels = Array.isArray(flags.channel)
      ? flags.channel
      : typeof flags.channel === "string"
        ? [flags.channel]
        : [];
    const authMethod: AuthMethod | undefined =
      flags.sasl === true || password ? "sasl" : undefined;

    const cliServer: ServerConfig = {
      id: serverIdFromHost(host),
      name: host,
      host,
      port,
      tls,
      nick,
      password,
      authMethod,
      channels,
      autoConnect: true,
    };

    // A configured server with the same host keeps its id and settings (SASL, channels,
    // username...); the CLI flags only override what they set.
    const portGiven = Boolean(portPart) || typeof flags.port === "string";
    const existing = config.servers.find(
      (s) => sameHost(s.host, host) && (!portGiven || s.port === port),
    );
    const merged: ServerConfig = existing
      ? {
          ...existing,
          ...(portGiven ? { port } : {}),
          ...(flags.tls !== undefined ? { tls } : {}),
          ...(typeof flags.nick === "string" ? { nick } : {}),
          ...(password ? { password, authMethod } : {}),
          channels: [...new Set([...(existing.channels ?? []), ...channels])],
          autoConnect: true,
        }
      : cliServer;

    config = {
      ...config,
      servers: [merged, ...config.servers.filter((s) => s !== existing)],
    };
  }

  return config;
}

export function defaultConfigPath(): string {
  return join(homedir(), ".config", "honk", "config.json");
}

/**
 * Returns the config file text with "theme" set to `id`. It edits the text
 * instead of writing the parsed object back, so the user's spacing and key
 * order stay as they were. Throws if the text is not a JSON object, so a
 * broken file is never overwritten.
 */
export function setThemeInConfigText(text: string, id: string): string {
  const value = JSON.stringify(id);
  const withTheme = (next: string | undefined) => {
    if (next === undefined) return undefined;
    try {
      return (JSON.parse(next) as { theme?: unknown }).theme === id ? next : undefined;
    } catch {
      return undefined;
    }
  };

  // Replace the value of an existing "theme" key. If that key was a nested
  // one, the result has no top-level theme and the next step adds one.
  const existing = /("theme"\s*:\s*)"(?:[^"\\]|\\.)*"/;
  const replaced = existing.test(text)
    ? text.replace(existing, (_, key: string) => `${key}${value}`)
    : undefined;

  // Add "theme" as the first key, indented like the line after "{".
  const open = text.indexOf("{");
  let added: string | undefined;
  if (open !== -1) {
    const rest = text.slice(open + 1);
    const indent = /^[^\S\n]*\n([^\S\n]*)\S/.exec(rest)?.[1] ?? "  ";
    added = rest.trimStart().startsWith("}")
      ? `${text.slice(0, open)}{ "theme": ${value} }${rest.replace(/^\s*\}/, "")}`
      : `${text.slice(0, open + 1)}\n${indent}"theme": ${value},${rest}`;
  }

  const result = withTheme(replaced) ?? withTheme(added);
  if (result === undefined) throw new Error("the config file is not a JSON object");
  return result;
}

/**
 * Saves the theme in the config file at `path`, or creates the file with only
 * the theme. Writes a temporary file first, so a crash never leaves half a file.
 */
export function saveThemeSetting(configPath: string, id: string): void {
  // Write through a symlink (a config kept in a dotfiles repo) instead of
  // replacing the link with a plain file.
  const path = existsSync(configPath) ? realpathSync(configPath) : configPath;
  const text = existsSync(path)
    ? setThemeInConfigText(readFileSync(path, "utf-8"), id)
    : `${JSON.stringify({ theme: id }, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
