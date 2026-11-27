/**
 * Runs a FakeIrcd from the command line, with an HTTP control port on the next port up.
 *
 *   bun run fakeircd --port 16667 --network alpha
 *   curl -d '{"from":"alice","target":"#honk","text":"hi"}' localhost:16668/say
 *
 * See dev/fakeircd/README.md for every control route.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { FakeIrcd } from "./server.ts";

const USAGE = `usage: bun run fakeircd [--port N] [--network NAME] [--tls] [--control N] [--log FILE] [--quiet]

  --port N        IRC port (default 16667)
  --network NAME  the network name honk shows (default FakeNet)
  --tls           speak TLS with a self-signed cert; it prints how to trust it
  --control N     HTTP control port (default: the IRC port + 1)
  --log FILE      also append every line to FILE
  --quiet         don't print every line`;

const KNOWN = new Set(["port", "network", "tls", "control", "log", "quiet", "help"]);

function parseFlags(argv: string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    if (!KNOWN.has(arg.slice(2))) throw new Error(`unknown flag: ${arg}`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[arg.slice(2)] = next;
      i++;
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return flags;
}

let flags: Record<string, string | true>;
try {
  flags = parseFlags(process.argv.slice(2));
} catch (err) {
  console.error(`${(err as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}

const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
const port = Number(str("port") ?? 16667);
const logFile = str("log");
if (logFile) writeFileSync(logFile, "");

/** Exits with a short message when a port is taken, instead of a stack trace. */
function failOnPort(err: unknown, port: number): never {
  const code = (err as NodeJS.ErrnoException).code;
  console.error(
    code === "EADDRINUSE"
      ? `fakeircd: port ${port} is in use (another fakeircd?)`
      : `fakeircd: ${String(err)}`,
  );
  process.exit(1);
}

const irc = await FakeIrcd.start({
  port,
  network: str("network"),
  tls: Boolean(flags.tls),
  log: (line) => {
    if (!flags.quiet) console.log(line);
    if (logFile) appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  },
}).catch((err) => failOnPort(err, port));

type Body = Record<string, unknown>;
const s = (b: Body, k: string): string => {
  const v = b[k];
  if (typeof v !== "string" || !v) throw new Error(`missing "${k}"`);
  return v;
};
const opt = (b: Body, k: string): string | undefined =>
  typeof b[k] === "string" ? (b[k] as string) : undefined;
const num = (b: Body, k: string): number | undefined =>
  b[k] === undefined ? undefined : Number(b[k]);

/** POST routes: the JSON body names the arguments. */
const routes: Record<string, (b: Body) => unknown> = {
  say: (b) =>
    irc.say(s(b, "from"), s(b, "target"), opt(b, "text") ?? "", {
      notice: Boolean(b.notice),
      ctcp: opt(b, "ctcp"),
    }),
  join: (b) => irc.join(s(b, "nick"), s(b, "channel"), opt(b, "prefix")),
  part: (b) => irc.part(s(b, "nick"), s(b, "channel"), opt(b, "reason")),
  quit: (b) => irc.quit(s(b, "nick"), opt(b, "reason")),
  nick: (b) => irc.renick(s(b, "from"), s(b, "to")),
  kick: (b) => irc.kick(opt(b, "by") ?? "alice", s(b, "channel"), s(b, "nick"), opt(b, "reason")),
  topic: (b) => irc.setTopic(s(b, "channel"), opt(b, "text") ?? "", opt(b, "by")),
  users: (b) => irc.setUsers(s(b, "channel"), Array.isArray(b.users) ? (b.users as string[]) : []),
  key: (b) => irc.setKey(s(b, "channel"), opt(b, "key") ?? null),
  ban: (b) => irc.ban(s(b, "channel")),
  unban: (b) => irc.unban(s(b, "channel")),
  silence: (b) => irc.silence(s(b, "channel")),
  unsilence: (b) => irc.unsilence(s(b, "channel")),
  forward: (b) => irc.forward(s(b, "from"), opt(b, "to") ?? null),
  history: (b) => irc.fillHistory(s(b, "channel"), num(b, "count") ?? 50),
  raw: (b) => ({ sent: irc.sendRaw(s(b, "line"), num(b, "client")) }),
  drop: (b) => ({ dropped: irc.drop(num(b, "client")) }),
  away: (b) => irc.setAway(s(b, "nick"), opt(b, "text") ?? null),
  failhistory: (b) => {
    irc.failHistory = b.fail === true;
  },
  failmarkread: (b) => {
    irc.failMarkRead = b.fail === true;
  },
  sasl: (b) => {
    irc.rejectSasl = b.reject === true;
  },
  delay: (b) => {
    irc.acceptDelayMs = num(b, "ms") ?? 0;
  },
};

const controlPort = Number(str("control") ?? port + 1);
try {
  Bun.serve({
    port: controlPort,
    hostname: "127.0.0.1",
    async fetch(req) {
      const name = new URL(req.url).pathname.slice(1);
      if (req.method === "GET" && name === "clients") return Response.json(irc.clientList());
      if (req.method === "GET" && name === "channels") return Response.json(irc.channelList());
      if (req.method === "GET" && name === "received")
        return Response.json(irc.received.slice(-200));
      const route = routes[name];
      if (req.method !== "POST" || !route) {
        return new Response(`unknown route: ${req.method} /${name}\n`, { status: 404 });
      }
      try {
        const text = await req.text();
        const body = (text ? JSON.parse(text) : {}) as Body;
        return Response.json(route(body) ?? { ok: true });
      } catch (err) {
        return new Response(`${(err as Error).message}\n`, { status: 400 });
      }
    },
  });
} catch (err) {
  await irc.stop();
  failOnPort(err, controlPort);
}

console.log(
  `fakeircd: ${irc.network} on ${irc.host}:${irc.port}${irc.certPath ? " (TLS)" : ""}, control on 127.0.0.1:${controlPort}`,
);
if (irc.certPath)
  console.log(`fakeircd: trust the cert with NODE_EXTRA_CA_CERTS=${irc.certPath} bun run start`);

const shutdown = () => void irc.stop().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
