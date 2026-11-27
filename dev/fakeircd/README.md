# fakeircd

A fake IRC server for testing honk. It keeps real state for clients, channels, fake users
and history, and you can make things happen on demand: someone talks, a join fails, the
link drops. It is only for development. The release build never includes it.

## Run it

```sh
bun run fakeircd --port 16667 --network alpha          # control port 16668
bun run fakeircd --port 16677 --network beta --tls     # control port 16678
```

Then point honk at it. Try `/connect 127.0.0.1 16667` in a running honk, or use a config
such as `dev/fakeircd/servers.json`:

```sh
bun run start --config dev/fakeircd/servers.json
```

With `--tls`, the server makes a self-signed cert at startup and prints its path.
honk checks certs, so it must trust that one:

```sh
NODE_EXTRA_CA_CERTS=/path/it/printed/cert.pem bun run start --config dev/fakeircd/servers.json
```

Flags: `--port N`, `--network NAME`, `--tls`, `--control N` (default: the port + 1),
`--log FILE`, `--quiet`.

## What it does

- Registration, CAP (`batch`, `draft/chathistory`, `draft/event-playback`,
  `draft/message-redaction`, `draft/read-marker`, `echo-message`, `labeled-response`,
  `message-tags`, `sasl`, `server-time`), and SASL PLAIN. Any account and password works.
  With `labeled-response`, a CHATHISTORY reply (the FAIL or the opening BATCH line) carries
  the label of the request. Set `irc.labeledResponse = false` before connecting to test a
  server without labels, or add a cap to `irc.withheldCaps` to leave it out of CAP LS.
  REDACT is offered but not handled; send one with `sendRaw`.
- Channels with real members. Messages, JOIN, PART, NICK, QUIT, KICK and TOPIC go to the
  other members, and DMs between two clients work.
- Each new channel starts with the fake users `@alice +bob carol`.
- CHATHISTORY LATEST, BEFORE, AFTER and TARGETS, served from the messages it really saw,
  plus made-up older lines that you add with `/history`.
- WHOIS, NAMES, TOPIC, MOTD, PING. Nick in use gets 433.

## Control

Send a POST with a JSON body to the control port. The answer is `{"ok":true}`, or an error
message with status 400.

```sh
C=localhost:16668
curl -d '{"from":"alice","target":"#honk","text":"hi goose"}' $C/say
curl -d '{"from":"alice","target":"goose","text":"psst"}' $C/say        # a DM
curl -d '{"from":"alice","target":"goose","ctcp":"VERSION"}' $C/say    # a CTCP request
curl -d '{"channel":"#honk","count":100}' $C/history                   # older lines
curl -d '{"channel":"#secret"}' $C/ban                                 # JOIN gets 474
curl -d '{}' $C/drop                                                   # cut every link
curl $C/clients
```

| Route | Body | Effect |
|---|---|---|
| `say` | `from`, `target`, `text`, `notice?`, `ctcp?` | A message from anyone, to a channel or a nick |
| `join` / `part` | `nick`, `channel`, `prefix?` / `reason?` | A fake user joins or leaves |
| `quit` | `nick`, `reason?` | A fake user quits, or a client's link is closed |
| `nick` | `from`, `to` | A fake user changes nick |
| `kick` | `channel`, `nick`, `by?`, `reason?` | Kicks anyone, you too |
| `topic` | `channel`, `text`, `by?` | Sets the topic |
| `users` | `channel`, `users` (a list like `["@alice","dave"]`) | Replaces the fake users |
| `history` | `channel`, `count?` | Adds older lines for CHATHISTORY |
| `ban` / `unban` | `channel` | JOIN gets 474 (banned) |
| `silence` / `unsilence` | `channel` | JOIN gets no reply at all |
| `forward` | `from`, `to` | JOIN `from` gets 470 and lands in `to` |
| `key` | `channel`, `key` | JOIN needs this key, or gets 475 |
| `raw` | `line`, `client?` | Sends a raw line; `$NICK` becomes the client's nick |
| `drop` | `client?` | Closes links without a QUIT, like a network failure |
| `away` | `nick`, `text` (leave it out to come back) | Messages to `nick` get 301, and WHOIS shows it |
| `sasl` | `reject` | `{"reject":true}` makes SASL logins fail with 904 |
| `failhistory` | `fail` | `{"fail":true}` makes CHATHISTORY answer with FAIL and no batch |
| `failmarkread` | `fail` | `{"fail":true}` makes MARKREAD answer with `FAIL MARKREAD INTERNAL_ERROR` |
| `rejectcap` | `reject` | `{"reject":true}` makes CAP answer with 421, like a server from before IRCv3 |
| `delay` | `ms` | New connections wait this long before any answer |

GET routes: `clients`, `channels`, and `received` (the last 200 lines clients sent).

## In tests

`server.ts` is a library. Start it on a free port inside a test:

```ts
import { FakeIrcd } from "../../dev/fakeircd/server.ts";

const irc = await FakeIrcd.start({ network: "alpha" }); // port 0: any free port
irc.fillHistory("#honk", 5);
// ... connect an IrcManager to 127.0.0.1:irc.port ...
irc.say("bob", "#honk", "welcome back");
await irc.waitFor((line) => line.command === "PRIVMSG");
await irc.stop();
```

`fakeircd.test.ts` has examples, including one that connects honk's real `IrcManager`.
