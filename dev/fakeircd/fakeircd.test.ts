import { afterEach, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { IrcManager } from "../../src/irc/manager.ts";
import { LineSplitter } from "../../src/irc/ircLine.ts";
import { FakeIrcd } from "./server.ts";
import { until } from "./testing.ts";

/** A bare IRC connection that collects the lines it receives. */
class LineClient {
  lines: string[] = [];
  private sock: Socket;
  private waiters: { re: RegExp; resolve: (l: string) => void }[] = [];

  constructor(port: number) {
    this.sock = connect(port, "127.0.0.1");
    const split = new LineSplitter((line) => {
      this.lines.push(line);
      for (const w of [...this.waiters]) {
        if (w.re.test(line)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(line);
        }
      }
    });
    this.sock.on("data", (d: Buffer) => split.push(d));
  }

  send(line: string): void {
    this.sock.write(line + "\r\n");
  }

  /** The first line, already received or still to come, that matches. */
  wait(re: RegExp, timeoutMs = 1000): Promise<string> {
    const seen = this.lines.find((l) => re.test(l));
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      this.waiters.push({ re, resolve });
      setTimeout(
        () => reject(new Error(`no line matching ${re}; got:\n${this.lines.join("\n")}`)),
        timeoutMs,
      );
    });
  }

  /** Lines that arrive within `ms`, for checking that something did not come. */
  async quiet(ms = 100): Promise<string[]> {
    const from = this.lines.length;
    await Bun.sleep(ms);
    return this.lines.slice(from);
  }

  async register(nick: string, caps: string[] = []): Promise<void> {
    if (caps.length) {
      this.send("CAP LS 302");
      this.send(`CAP REQ :${caps.join(" ")}`);
      this.send("CAP END");
    }
    this.send(`NICK ${nick}`);
    this.send(`USER ${nick} 0 * :${nick}`);
    await this.wait(/ 376 /);
  }

  close(): void {
    this.sock.destroy();
  }
}

let irc: FakeIrcd;
const open: LineClient[] = [];
const client = (): LineClient => {
  const c = new LineClient(irc.port);
  open.push(c);
  return c;
};

afterEach(async () => {
  for (const c of open.splice(0)) c.close();
  await irc?.stop();
});

describe("FakeIrcd", () => {
  test("registers a client and names the network in 005", async () => {
    irc = await FakeIrcd.start({ network: "alpha" });
    const c = client();
    await c.register("goose");
    expect(await c.wait(/ 005 /)).toContain("NETWORK=alpha");
    expect(irc.clientList()).toMatchObject([{ nick: "goose", registered: true }]);
  });

  test("relays channel messages between clients, and echoes with echo-message", async () => {
    irc = await FakeIrcd.start();
    const a = client();
    const b = client();
    await a.register("goose", ["echo-message"]);
    await b.register("duck");
    a.send("JOIN #honk");
    b.send("JOIN #honk");
    await a.wait(/:duck!\S+ JOIN #honk/);
    expect(await b.wait(/ 353 /)).toContain(":@alice +bob carol duck goose");
    a.send("PRIVMSG #honk :quack?");
    expect(await b.wait(/PRIVMSG #honk/)).toMatch(/^:goose!\S+ PRIVMSG #honk :quack\?$/);
    expect(await a.wait(/PRIVMSG #honk/)).toContain(":quack?");
  });

  test("fake users talk, join, rename and kick", async () => {
    irc = await FakeIrcd.start();
    const c = client();
    await c.register("goose");
    c.send("JOIN #honk");
    await c.wait(/ 366 /);
    irc.say("alice", "#honk", "hello goose");
    irc.join("dave", "#honk");
    irc.renick("bob", "robert");
    irc.kick("alice", "#honk", "goose", "out");
    await c.wait(/KICK #honk goose :out/);
    const got = c.lines.join("\n");
    expect(got).toContain(":alice!alice@fake.host PRIVMSG #honk :hello goose");
    expect(got).toContain(":dave!dave@fake.host JOIN #honk");
    expect(got).toContain(":bob!bob@fake.host NICK :robert");
    expect(irc.channelList()["#honk"]).toEqual(["@alice", "+robert", "carol", "dave"]);
  });

  test("join failures: banned, silent, forwarded and keyed channels", async () => {
    irc = await FakeIrcd.start();
    irc.ban("#banned");
    irc.silence("#void");
    irc.forward("#old", "#new");
    irc.setKey("#locked", "sesame");
    const c = client();
    await c.register("goose");
    c.send("JOIN #banned,#void,#old,#locked");
    expect(await c.wait(/ 474 /)).toContain("#banned");
    expect(await c.wait(/ 470 /)).toContain("#old #new");
    expect(await c.wait(/JOIN #new/)).toBeTruthy();
    expect(await c.wait(/ 475 /)).toContain("#locked");
    expect(c.lines.some((l) => l.includes("#void"))).toBe(false);
    c.send("JOIN #locked sesame");
    expect(await c.wait(/JOIN #locked/)).toBeTruthy();
  });

  test("nick in use gets 433, also for a fake user's nick", async () => {
    irc = await FakeIrcd.start();
    const c = client();
    c.send("NICK alice");
    c.send("JOIN #x"); // channels get their fake users on first use, so alice exists after this
    irc.join("alice", "#x");
    c.send("NICK alice");
    c.send("USER a 0 * :a");
    expect(await c.wait(/ 433 /)).toContain("alice :Nickname is already in use");
  });

  test("CHATHISTORY serves stored and filled lines in a batch", async () => {
    irc = await FakeIrcd.start();
    irc.fillHistory("#honk", 3);
    irc.say("alice", "#honk", "live line");
    const c = client();
    await c.register("goose", ["batch", "server-time", "message-tags", "draft/chathistory"]);
    c.send("CHATHISTORY LATEST #honk * 2");
    await c.wait(/BATCH -/);
    const body = c.lines.filter((l) => l.includes("PRIVMSG #honk"));
    expect(body.map((l) => l.slice(l.lastIndexOf(":") + 1))).toEqual([
      "older line 3 of 3",
      "live line",
    ]);
    expect(body[0]).toMatch(/^@batch=h\d+;time=\S+;msgid=\S+ /);

    const anchor = /time=([^;]+)/.exec(body[0]!)![1];
    c.send(`CHATHISTORY BEFORE #honk timestamp=${anchor} 10`);
    await c.wait(/older line 2 of 3/);
    expect(c.lines.filter((l) => l.includes("older line 1 of 3"))).toHaveLength(1);
  });

  test("CHATHISTORY TARGETS names the nicks that sent you DMs", async () => {
    irc = await FakeIrcd.start();
    irc.join("dave", "#x");
    const c = client();
    await c.register("goose", ["batch", "draft/chathistory"]);
    irc.say("dave", "goose", "psst");
    c.send(
      `CHATHISTORY TARGETS timestamp=${new Date(Date.now() - 60_000).toISOString()} timestamp=${new Date(Date.now() + 1000).toISOString()} 50`,
    );
    expect(await c.wait(/CHATHISTORY TARGETS/)).toMatch(/CHATHISTORY TARGETS dave timestamp=/);
  });

  test("sendRaw passes only the tags the client asked for", async () => {
    irc = await FakeIrcd.start();
    const plain = client();
    const tagged = client();
    await plain.register("goose");
    await tagged.register("gander", ["server-time", "message-tags"]);
    irc.sendRaw("@msgid=AB12;time=2026-11-27T21:35:07.000Z;other=x :alice!a@h PRIVMSG #honk :lol");
    expect(await plain.wait(/PRIVMSG #honk :lol/)).toBe(":alice!a@h PRIVMSG #honk :lol");
    expect(await tagged.wait(/PRIVMSG #honk :lol/)).toBe(
      "@time=2026-11-27T21:35:07.000Z;msgid=AB12 :alice!a@h PRIVMSG #honk :lol",
    );
  });

  test("SASL PLAIN logs in", async () => {
    irc = await FakeIrcd.start();
    const c = client();
    c.send("CAP LS 302");
    c.send("CAP REQ :sasl");
    c.send("NICK goose");
    c.send("USER goose 0 * :goose");
    c.send("AUTHENTICATE PLAIN");
    await c.wait(/^AUTHENTICATE \+$/);
    c.send(`AUTHENTICATE ${Buffer.from("goose\0goose\0secret").toString("base64")}`);
    expect(await c.wait(/ 903 /)).toBeTruthy();
    c.send("CAP END");
    await c.wait(/ 001 /);
    expect(irc.clientList()[0]?.account).toBe("goose");
  });

  test("drop closes the link without a QUIT, and other clients see the QUIT", async () => {
    irc = await FakeIrcd.start();
    const a = client();
    const b = client();
    await a.register("goose");
    await b.register("duck");
    a.send("JOIN #honk");
    b.send("JOIN #honk");
    await a.wait(/duck!\S+ JOIN/);
    irc.drop(irc.clientList().find((c) => c.nick === "duck")!.id);
    expect(await a.wait(/QUIT/)).toMatch(/^:duck!\S+ QUIT :Connection closed$/);
  });

  test("TLS works with the cert it made", async () => {
    irc = await FakeIrcd.start({ tls: true });
    const { connect: tlsConnect } = await import("node:tls");
    const { readFileSync } = await import("node:fs");
    const sock = tlsConnect({
      host: "127.0.0.1",
      port: irc.port,
      servername: "localhost",
      ca: readFileSync(irc.certPath!),
    });
    await new Promise((resolve, reject) => {
      sock.once("secureConnect", resolve);
      sock.once("error", reject);
    });
    sock.write("NICK goose\r\nUSER goose 0 * :goose\r\n");
    const got = await new Promise<string>((resolve) =>
      sock.once("data", (d) => resolve(String(d))),
    );
    expect(got).toContain(" 001 goose ");
    sock.destroy();
  });
});

describe("honk against FakeIrcd", () => {
  test("connects, joins, gets history, and sees live messages", async () => {
    irc = await FakeIrcd.start({ network: "alpha" });
    irc.fillHistory("#honk", 5);
    const m = new IrcManager();
    m.addServer({
      id: "alpha",
      name: "alpha",
      host: "127.0.0.1",
      port: irc.port,
      tls: false,
      nick: "goose",
      channels: ["#honk"],
      autoConnect: false,
    });
    try {
      await m.connectServer("alpha");
      const server = () => m.getSnapshot().servers.find((s) => s.id === "alpha")!;
      const honk = () => server().buffers["#honk"];
      await until(() => (honk()?.messages.filter((x) => x.isHistory).length ?? 0) === 5);
      irc.say("bob", "#honk", "welcome back");
      await until(() => honk()!.messages.some((x) => x.text === "welcome back"));
      expect(server().status).toBe("connected");
      expect(honk()!.users.map((u) => u.prefix + u.nick)).toContain("@alice");
    } finally {
      m.disconnectAll();
    }
  });
});
