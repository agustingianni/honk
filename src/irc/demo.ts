/**
 * The offline demo: made-up networks, channels and people, used by `honk --demo` and
 * /demo, and by the recording on the website. Nothing here touches the network.
 *
 * This file is only data. IrcManager turns it into buffers and plays the timeline.
 */
import type { MessageKind } from "../types.ts";
import type { WhoisInfo } from "./replies.ts";

export const DEMO_NICK = "goose";

/** One line of scrollback, `mins` minutes before the demo starts. */
export interface DemoLine {
  mins: number;
  kind: MessageKind;
  from?: string;
  /** Who joined or left, on a join or part line. */
  nick?: string;
  text: string;
  /** Not read yet: counts toward the buffer's unread badge, and the first one gets the divider. */
  unread?: boolean;
}

export interface DemoBuffer {
  name: string;
  topic?: string;
  /** Nicks with their mode prefix ("@alice", "+bob"). The demo user is added as a plain member if missing. */
  users?: string[];
  lines: DemoLine[];
}

export interface DemoNetwork {
  id: string;
  name: string;
  via?: string;
  buffers: DemoBuffer[];
}

/** Something that happens while the demo runs. */
export interface DemoEvent {
  serverId: string;
  buffer: string;
  from: string;
  text: string;
  kind?: "message" | "action";
}

const B = "\x02"; // bold
const I = "\x1d"; // italic
const R = "\x0f"; // reset
const c = (color: string, text: string) => `\x03${color}${text}${R}`;

const HONK_USERS = [
  "@alice",
  "@gander",
  "+bob",
  "+mallard",
  "charlie",
  "dave",
  "eve",
  "heron",
  "pip",
  "quill",
  "robin",
  "wren",
];

export const DEMO_NETWORKS: DemoNetwork[] = [
  {
    id: "demo-libera",
    name: "libera.chat",
    buffers: [
      {
        name: "*status",
        lines: [
          { mins: 52, kind: "system", text: "Connecting to irc.libera.chat:6697 (TLS)..." },
          { mins: 52, kind: "system", text: "Logged in with SASL as goose" },
          { mins: 52, kind: "notice", from: "NickServ", text: "You are now identified for goose." },
          { mins: 52, kind: "system", text: "Joined #honk, #bun, #opentui and #birds" },
        ],
      },
      {
        name: "#honk",
        topic: `${B}honk${B}, a terminal IRC client | ${c("11", "https://agustingianni.github.io/honk")} | v0.1.0 is out`,
        users: HONK_USERS,
        lines: [
          { mins: 48, kind: "join", nick: "heron", text: "heron joined #honk" },
          { mins: 47, kind: "message", from: "alice", text: "morning all" },
          { mins: 46, kind: "message", from: "gander", text: "morning! v0.1.0 binaries are up" },
          { mins: 46, kind: "message", from: "gander", text: "curl -fsSL https://agustingianni.github.io/honk/install.sh | sh" },
          { mins: 44, kind: "message", from: "bob", text: "installed on my linux box, one file, nice" },
          { mins: 41, kind: "action", from: "charlie", text: "is trying it over ssh on a raspberry pi" },
          { mins: 40, kind: "message", from: "charlie", text: "works on arm64 too" },
          { mins: 33, kind: "message", from: "eve", text: `colors render fine: ${c("04", "red")} ${c("08", "yellow")} ${c("09", "green")} ${c("12", "blue")} and ${B}bold${B} ${I}italic${I}` },
          { mins: 31, kind: "part", nick: "dave", text: "dave left #honk" },
          { mins: 30, kind: "join", nick: "dave", text: "dave joined #honk" },
          { mins: 26, kind: "join", nick: "robin", text: "robin joined #honk" },
          { mins: 24, kind: "message", from: "robin", text: "is there a way to load older messages?" },
          { mins: 23, kind: "message", from: "alice", text: "/history, if the network supports chathistory. libera does" },
          { mins: 9, kind: "message", from: "mallard", text: "goose: the new omnibox is great, ctrl+k and type", unread: true },
          { mins: 8, kind: "message", from: "mallard", text: "it finds channels, DMs and people", unread: true },
          { mins: 6, kind: "message", from: "pip", text: "and alt+up / alt+down to walk through channels", unread: true },
          { mins: 2, kind: "action", from: "quill", text: "honks approvingly", unread: true },
        ],
      },
      {
        name: "#bun",
        topic: `Bun: a fast JavaScript runtime | ${c("11", "https://bun.sh")}`,
        users: ["@jarred", "+ashley", "dylan", "meg", "pip", "theo"],
        lines: [
          { mins: 50, kind: "message", from: "meg", text: "bun build --compile is so nice for shipping CLIs" },
          { mins: 35, kind: "message", from: "theo", text: "does it cross-compile?" },
          { mins: 34, kind: "message", from: "dylan", text: "yes, --target=bun-linux-arm64 and friends", unread: true },
          { mins: 20, kind: "message", from: "ashley", text: "1.3.10 is out btw", unread: true },
          { mins: 5, kind: "message", from: "meg", text: "the changelog is long this time", unread: true },
        ],
      },
      {
        name: "#opentui",
        topic: `OpenTUI: terminal UIs with a native core | ${c("11", "https://opentui.com")}`,
        users: ["@simon", "+kai", "lena", "pip"],
        lines: [
          { mins: 44, kind: "message", from: "kai", text: "0.9.8 adds renderer-wide selection colors" },
          { mins: 12, kind: "message", from: "lena", text: "goose, does honk use the new boxSizing option?", unread: true },
        ],
      },
      {
        name: "#birds",
        // Wide characters and emoji, so the demo shows how honk cuts and lines them up.
        topic: "🦢🪿 Photos, sightings and bad puns / 野鳥観察の話もどうぞ / pics in the pins 📷",
        users: ["@robin", "heron", "pip", "wren"],
        lines: [
          { mins: 39, kind: "message", from: "wren", text: "saw a heron at the lake this morning" },
          { mins: 38, kind: "message", from: "heron", text: "wasn't me" },
          { mins: 37, kind: "message", from: "robin", text: "カワセミを見ました! a kingfisher at the river in Kyoto 🇯🇵" },
          { mins: 36, kind: "message", from: "pip", text: "took the kids 👨‍👩‍👧‍👦 to feed the geese, they were not impressed 🪿" },
        ],
      },
      {
        name: "alice",
        lines: [
          { mins: 15, kind: "message", from: "alice", text: "hey, are you coming to the meetup on friday?", unread: true },
        ],
      },
    ],
  },
  {
    id: "demo-oftc",
    name: "OFTC",
    buffers: [
      {
        name: "*status",
        lines: [
          { mins: 52, kind: "system", text: "Connecting to irc.oftc.net:6697 (TLS)..." },
          { mins: 52, kind: "system", text: "Joined #tui" },
        ],
      },
      {
        name: "#tui",
        topic: "Terminal user interfaces, all languages welcome",
        users: ["@marco", "+ines", "olaf", "sam"],
        lines: [
          { mins: 30, kind: "message", from: "ines", text: "anyone using kitty graphics in their TUI?" },
          { mins: 29, kind: "message", from: "olaf", text: "only for images, text stays plain cells" },
        ],
      },
    ],
  },
  {
    id: "demo-work",
    name: "work",
    via: "soju",
    buffers: [
      {
        name: "*status",
        lines: [
          { mins: 52, kind: "system", text: "Connected through the soju bouncer" },
          { mins: 52, kind: "system", text: "Played back 3 missed messages" },
        ],
      },
      {
        name: "#deploys",
        topic: "Deploys and incidents",
        users: ["@ci-bot", "nora", "tom"],
        lines: [
          { mins: 180, kind: "message", from: "ci-bot", text: `deploy ${c("09", "succeeded")}: api v2.14.0` },
          { mins: 95, kind: "message", from: "ci-bot", text: `deploy ${c("09", "succeeded")}: web v5.2.1` },
          { mins: 3, kind: "message", from: "ci-bot", text: `deploy ${c("04", "failed")}: worker v1.8.0 (retrying)`, unread: true },
        ],
      },
    ],
  },
];

/** The buffer the demo opens in. */
export const DEMO_START = { serverId: "demo-libera", buffer: "#honk" };

/** Played once, in order. `afterMs` is counted from the start of the demo. */
export const DEMO_TIMELINE: (DemoEvent & { afterMs: number })[] = [
  { afterMs: 3_000, serverId: "demo-libera", buffer: "#honk", from: "bob", text: "tab completes nicks too: type mal<tab>" },
  { afterMs: 8_000, serverId: "demo-libera", buffer: "#bun", from: "theo", text: "nice, trying it now" },
  { afterMs: 13_000, serverId: "demo-libera", buffer: "mallard", from: "mallard", text: "hey goose, got a minute? question about SASL" },
  { afterMs: 19_000, serverId: "demo-oftc", buffer: "#tui", from: "sam", text: "honk looks clean, what is it built with?" },
  { afterMs: 24_000, serverId: "demo-work", buffer: "#deploys", from: "ci-bot", text: `deploy ${c("09", "succeeded")}: worker v1.8.0` },
];

/** After the timeline, one of these arrives every few seconds, in turn, forever. */
export const DEMO_AMBIENT: DemoEvent[] = [
  { serverId: "demo-libera", buffer: "#honk", from: "wren", text: "the nick colors make busy channels easy to follow" },
  { serverId: "demo-libera", buffer: "#birds", from: "robin", text: "geese flying south already" },
  { serverId: "demo-libera", buffer: "#honk", from: "heron", text: "ctrl+b hides the channel list when the terminal is narrow", kind: "message" },
  { serverId: "demo-oftc", buffer: "#tui", from: "ines", text: "bun and OpenTUI, apparently" },
  { serverId: "demo-libera", buffer: "#honk", from: "dave", text: "looks up the config docs", kind: "action" },
  { serverId: "demo-libera", buffer: "#opentui", from: "kai", text: "pip: yes, that was fixed in 0.9.8" },
];

/** Replies to what the demo user says, in turn. */
export const DEMO_REPLIES = [
  "nice!",
  "agreed",
  "haha",
  "good point",
  "honk honk",
  "makes sense to me",
  "+1",
];

/**
 * A made-up WHOIS reply for a demo nick, who is in `channels` (with mode prefixes, such
 * as "@#honk") on `server`. whoisLines words it, as it does a real reply.
 */
export function demoWhois(nick: string, server: string, channels: string[]): WhoisInfo {
  const user = nick.toLowerCase();
  return { nick, username: `~${user}`, host: `user/${user}`, channels, server, idle: 120 };
}

/** Older lines that /history "loads" in the demo. */
export const DEMO_HISTORY: { from: string; text: string }[] = [
  { from: "gander", text: "tagging v0.1.0 tonight" },
  { from: "alice", text: "the release workflow signs the binaries now" },
  { from: "bob", text: "gh attestation verify, nice" },
  { from: "gander", text: "and the install script checks the sha256" },
  { from: "robin", text: "what about windows?" },
  { from: "gander", text: "not yet. macOS and linux for now" },
];
