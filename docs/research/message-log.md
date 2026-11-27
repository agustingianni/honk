# A local, searchable message log for honk

Research notes, 2026-11-27. Every fact has a link. Text marked
**Recommendation** is advice, not fact.

## Summary

1. bun:sqlite with an FTS5 index is fast enough: on this Mac, 1,000,000 chat
   lines take 160 MB, a search for the newest 50 matches takes about 28 ms, and
   a scrollback page takes under 1 ms.
2. The hard part is not storage. It is telling that two incoming lines are the
   same message. msgid is the best key, but ZNC replay and the soju file store
   drop it, and many networks (OFTC) never send it.
3. Every client we read regrets something in this area: duplicates (The Lounge,
   Goguma, Halloy), a missing index (The Lounge), a time unit change (Quassel),
   or FTS rebuilds (Signal, repartee).
4. **Recommendation:** one SQLite file, a `UNIQUE (buffer_id, msgid)` partial
   index, a counted fallback match for lines without msgid, an external-content
   FTS5 index on text without formatting, and searches that never pass user
   input to `MATCH` without quoting.
5. **Recommendation:** first make `nameKey` follow `CASEMAPPING`, because the
   log will use buffer names as keys that must not change later.

## Contents

- [Measurements](#measurements)
- [IRCv3 and protocol facts](#ircv3-and-protocol-facts)
- [What servers and bouncers actually send](#what-servers-and-bouncers-actually-send)
- [What other clients learned](#what-other-clients-learned)
- [Where honk stands](#where-honk-stands)
- [Recommended design](#recommended-design)
- [Test plan](#test-plan)
- [Open decisions for the user](#open-decisions-for-the-user)
- [Sources](#sources)

## Measurements

All numbers come from this Mac (macOS 27.2.1, arm64) with Bun 1.4.5, measured
on 2026-11-27. The scripts are small Bun files that use only `bun:sqlite`.

### SQLite version and features

```
$ bun -e 'import {Database} from "bun:sqlite"; console.log(new Database(":memory:").query("select sqlite_version() v").get())'
{ v: "3.54.0" }
$ /usr/bin/sqlite3 --version
3.54.0 2026-04-09 12:25:13 8fa8248e...5373aapl (64-bit)
```

`PRAGMA compile_options` lists `ENABLE_FTS5`. The source id ends in `aapl`,
so on macOS Bun uses Apple's SQLite, the same one as `/usr/bin/sqlite3`. The
Bun docs say so too: on macOS "Bun uses the system-provided SQLite, which Apple
builds with persistent WAL enabled", and on Linux and Windows "Bun statically
links its own SQLite build" ([Bun SQLite docs][bun-sqlite]).

Consequence: on macOS, the SQLite version honk gets depends on the user's macOS
version, not on the Bun version honk was built with.

FTS5 behavior checked with one table `m(id, text)` and two FTS5 indexes:

| Test | Query | Result |
|---|---|---|
| Accents | `unicode61 remove_diacritics 2`, `MATCH 'cafe'` | matches "the café is open" |
| Prefix | `MATCH 'crash*'` | matches "honk crashed at startup" |
| Substring | `trigram` tokenizer, `MATCH '"thub.com/fo"'` | matches "see https://github.com/foo/bar" |
| Highlight | `highlight(f, 0, '[', ']')` | "honk crashed at [startup]" |

`RETURNING` (needs SQLite 3.35, [docs][sqlite-returning]) also worked.

### Size and speed

Table `m(id INTEGER PRIMARY KEY, buf, ts, kind, nick, text)`, index on
`(buf, ts)`, external-content FTS5 index on `text`, filled by an AFTER INSERT
trigger. 1,000,000 lines of 4 to 17 words each, 40 buffers, 300 nicks, WAL
mode, `synchronous=NORMAL`.

| What | Result |
|---|---|
| Insert 1,000,000 rows in one transaction | 14.5 s |
| File size after `wal_checkpoint(truncate)` | 160 MB |
| `... WHERE f MATCH 'crash release' ORDER BY m.ts DESC LIMIT 50` (FTS joined to the table) | 28 ms |
| `SELECT * FROM m WHERE buf = 7 AND ts < ? ORDER BY ts DESC LIMIT 200` | 0.44 ms |

After the process ended, `size.db-wal` and `size.db-shm` were still on disk.
This matches Apple's "persistent WAL" ([Bun SQLite docs][bun-sqlite]).

In 2012 a Mozilla developer doubted that SQLite could hold the volume of IRC
logs ("there's an awful lot of information when you sit in a bunch of IRC
channels"), and the bug was closed WONTFIX ([Mozilla bug 954577][moz-954577]).
The numbers above show that this is no longer a concern.

### Custom SQL functions work

```ts
db.function("strip", (s: string) => s.replace(/\x02/g, ""));
db.query("select strip(?) r").get("\x02hi\x02"); // { r: "hi" }
```

This works in Bun 1.4.5, and the Bun docs document `db.function(name, fn)` and
`db.aggregate` ([Bun SQLite docs][bun-sqlite]).

### Deleting the same row twice from an FTS index can fail

An external-content FTS5 table, an AFTER DELETE trigger that sends
`'delete'`, and a manual `'delete'` of the same row before the `DELETE`:

| Rows in the FTS index | Second `'delete'` (from the trigger) | `integrity-check` |
|---|---|---|
| 2 | succeeds | passes |
| 1 (the index becomes empty) | `SQLiteError: database disk image is malformed` | passes |

So a double delete does not always pass quietly. The FTS5 docs say that if the
values in a `'delete'` "are not the same as those currently stored within the
table, the results may be unpredictable" ([FTS5 'delete' command][fts5-delete]).
repartee hit this in practice; see [What other clients learned](#what-other-clients-learned).

## IRCv3 and protocol facts

### message-ids ([spec][msgid])

- "Uniqueness in this context means that any other message transmitted on the
  entire network at any time MUST NOT share the same value."
- "if a message is re-transmitted as-is, for example with the chathistory batch
  type, the ID SHOULD be reused. As a result, clients MUST accept shared IDs."
- "Clients MUST treat the ID as a case sensitive opaque identifier. Clients MUST
  NOT use case folding or normalization when comparing IDs."

So a msgid is unique per network, not across networks. The key must include the
network (or the buffer).

### server-time ([spec][server-time])

The `time` tag is UTC, and "Precision of the time is one millisecond."

```
@time=2011-10-19T16:40:51.620Z :Angel!angel@example.org PRIVMSG Wiz :Hello
```

### chathistory, draft ([spec][chathistory])

- `BEFORE`, `AFTER`, and `LATEST` bounds exclude the reference: "before and
  excluding the given timestamp or msgid".
- "The order of returned messages within the batch is implementation-defined,
  but SHOULD be ascending time order or some approximation thereof".
- "The msgid tag that identifies each individual message in a response MUST be
  the msgid tag as originally sent by the IRC server."
- The ISUPPORT token `MSGREFTYPES` lists which references a server accepts
  (`msgid`, `timestamp`). "If MSGREFTYPES is missing, clients SHOULD assume the
  server supports both".
- The spec's own gap-filling pseudocode subtracts a `FUZZ_INTERVAL` ("perhaps 1
  to 10 seconds") from the lower bound and then calls
  `deduplicate_messages`. So the spec expects clients to receive lines they
  already have.
- A server MAY tag the first `BATCH` line with `draft/chathistory-end` when no
  more messages exist.
- `draft/event-playback`: with it, the server "SHOULD send additional lines
  relevant to the chat history, including but not limited to TAGMSG, JOIN,
  PART, QUIT, MODE, TOPIC, and NICK".
- `CHATHISTORY TARGETS` lists channels and DM partners with history, which
  is how a client finds DMs it missed.

Open problems in the spec:

- [ircv3-specifications#540][ircv3-540]: after a reconnect to another server of
  the same network, `LATEST * msgid=<last seen>` "could produce duplicate
  messages, missing messages, or both".
- [ircv3-specifications#604][ircv3-604]: paging through `TARGETS` can
  duplicate or leave out targets.

### echo-message and labeled-response

- echo-message: matching a sent line to its echo "is not straightforward, as
  the server may modify them before acknowledgment"
  ([echo-message spec][echo]).
- labeled-response: the server copies the client's `label` tag onto the reply,
  and onto the echo of a message the client sent to itself
  ([labeled-response spec][labeled]). That makes matching exact. But honk's own
  notes say "soju doesn't pass them back" ([src/irc/echo.ts:18][honk-echo]).
  (Not checked against soju's source.)

### message-redaction, read-marker, multiline

- Redaction: "Redacted messages MAY be hidden entirely from the primary
  message log, but a deletion log SHOULD be made available."
  ([message-redaction spec][redaction])
- Read marker: `MARKREAD <target> timestamp=YYYY-MM-DDThh:mm:ss.sssZ`. The
  marker is a timestamp, not a msgid ([read-marker spec][read-marker]).
- Multiline: the msgid sits on the `BATCH` line. For clients without the cap,
  "Servers MUST only include a message ID on the first message of a batch when
  sending a fallback" ([multiline spec][multiline]):

```
@msgid=xxx;account=account :n!u@h PRIVMSG #channel hello
@account=account :n!u@h PRIVMSG #channel :how is<SPACE>
@account=account :n!u@h PRIVMSG #channel :everyone?
```

### Network identity and case

- ISUPPORT `NETWORK` "is advertised for INFORMATIONAL PURPOSES ONLY"
  ([Modern IRC, NETWORK][modern-network]). It is a display name, not a key.
- soju's bouncer-networks extension: "Each network has a unique per-user ID
  called "netid". It MUST NOT change during the lifetime of the network."
  ([bouncer-networks spec][soju-bn]). It is sent as ISUPPORT `BOUNCER_NETID`.
- CASEMAPPING: "If the parameter is not published by the server at all, clients
  SHOULD assume CASEMAPPING=rfc1459". The specs word `rfc1459` as `{`, `}`,
  `|`, and `^` being the lowercase forms of `[`, `]`, `\`, and `~`
  ([Modern IRC, CASEMAPPING][modern-casemapping]). Servers instead fold by
  adding 32 to each byte from `A` to `^`, so `[`, `]`, `\`, and `^` become
  `{`, `}`, `|`, and `~`. Both make the same names equal, but the stored key
  differs, and honk folds as the servers do. So `#foo[1]` and `#FOO{1}` are
  the same channel on such a server.

### SQLite facts used below

- "NULLs are still distinct in a UNIQUE column" ([NULL handling][sqlite-nulls]).
  So `UNIQUE (config_id, bouncer_net)` lets two rows `('libera', NULL)` exist.
- "auto-vacuuming must be turned on before any tables are created"
  ([PRAGMA auto_vacuum][sqlite-pragma]).
- "WAL mode is safe from corruption with synchronous=NORMAL", but a commit can
  be lost after a power failure ([PRAGMA synchronous][sqlite-pragma]).
- UPSERT (`ON CONFLICT DO NOTHING`) exists since 3.24.0; several `ON CONFLICT`
  clauses since 3.35.0 ([UPSERT][sqlite-upsert]). Partial indexes exist since
  3.8.0 ([partial indexes][sqlite-partial]).
- FTS5 `contentless_delete=1` exists since 3.43.0 ([FTS5][fts5]).
- External-content FTS5 tables must be kept in sync by the user; if not, "the
  results of queries against the FTS5 table may become unintuitive and appear
  inconsistent" ([FTS5 external content pitfalls][fts5-pitfalls]).
- `remove_diacritics 2` removes diacritics from all Latin characters; `1`
  misses some ([FTS5 unicode61][fts5-unicode61]).
- The trigram tokenizer cannot match substrings shorter than 3 characters
  ([FTS5 trigram][fts5-trigram]).

## What servers and bouncers actually send

| Source | msgid on live lines | msgid on replay | time precision | Notes |
|---|---|---|---|---|
| Ergo | yes, 26 chars base32 ([crypto.go][ergo-token]) | same msgid, stored and sent again | ms ([args.go][ergo-time]) | `MSGREFTYPES=msgid,timestamp` ([config.go][ergo-msgref]). Without event-playback, events come as HistServ PRIVMSGs with msgid `"_" + msgid` ([queries.go][ergo-munge]). Multiline fallback puts the msgid on the first nonblank line ([client.go][ergo-multiline]). |
| soju, `message-store db` | passes the network's msgid; adds none of its own | same, it stores the raw line ([sqlite.go][soju-insert]) | ms | Stamps `time.Now()` if the network sent no time tag ([upstream.go][soju-now]). `MSGREFTYPES=timestamp` ([downstream.go][soju-msgref]); a `msgid=` bound is a TODO ([downstream.go][soju-todo]). |
| soju, `message-store fs` | as above | **none**: the ZNC-style log line keeps no tags | **whole seconds** ([writer.go][soju-znclog-w], [reader.go][soju-znclog-r]) | Same line can come live with msgid and ms, and later on replay with neither. |
| soju, client without `draft/chathistory` | | automatic backlog on join ([downstream.go][soju-backlog]) | | |
| ZNC buffer playback | passes the network's tags | **none**: "Discard all tags (except the time tag, conditionally)" ([Buffer.cpp][znc-buffer]) | the network's time tag string, or ZNC's own time in ms | Adds a time tag if the network sent none ([Client.cpp][znc-client]). znc-playback `PLAY` sends lines with `from < t <= to` ([playback.cpp][znc-playback]). |
| Libera.Chat (Solanum) | yes, since 2026-02-11 ([Libera news][libera-news]) | no CHATHISTORY | ms; now the time the sender's server processed the line | Live `CAP LS` on 2026-11-27: `server-time echo-message labeled-response message-tags batch`, no `chathistory`. |
| OFTC | no | no | no server-time | Live `CAP LS` on 2026-11-27: only `multi-prefix`. |
| InspIRCd / UnrealIRCd with channel mode `+H` | depends on server modules | replay on join | | Halloy saw duplicates until the network enabled InspIRCd's `ircv3_ctctags` module, which adds the tags ([halloy#2267][halloy-2267]). |

Live `CAP LS 302` replies, captured 2026-11-27:

```
:zirconium.libera.chat CAP * LS :account-notify away-notify batch chghost extended-join multi-prefix sasl=ECDSA-NIST256P-CHALLENGE,EXTERNAL,PLAIN,SCRAM-SHA-512 tls account-tag cap-notify echo-message invite-notify labeled-response message-tags no-implicit-names server-time solanum.chat/identify-msg solanum.chat/oper solanum.chat/realhost
:coulomb.oftc.net CAP * LS :multi-prefix
```

Example: one line, seen live through soju, replayed by soju's file store,
and replayed by ZNC.

```
live:    @msgid=AB12;time=2026-11-27T21:35:07.412Z :alice!a@h PRIVMSG #honk :lol
replay:  @time=2026-11-27T21:35:07.000Z :alice!a@h PRIVMSG #honk :lol
ZNC:     @time=2026-11-27T21:35:07.412Z :alice!a@h PRIVMSG #honk :lol
```

The only thing all three share is buffer, nick, text, and the whole second.

### soju's own log store (a design to copy)

- Schema: `Message(id INTEGER PRIMARY KEY, target, raw, time TEXT, sender,
  text)`, `MessageTarget(network, target, UNIQUE(network, target))`, and
  `MessageFTS USING fts5(text, content=Message, content_rowid=id)` kept in sync
  by INSERT, DELETE, and UPDATE triggers ([sqlite_migrations.go][soju-schema]).
- It quotes each word of a search: "we need to quote each token, i.e. `"foo"
  "baz"`" ([sqlite.go][soju-quote]).
- It strips mIRC formatting before indexing ([sqlite.go][soju-strip]). This was
  added in June 2024, 18 months after the store ([commit 2489318][soju-strip-commit]).
- `message-expiry` deletes old messages once per day. The man page warns that
  "SQLite does not automatically reclaim disk space after deletion. Run VACUUM
  manually" ([soju.1.scd][soju-man]).

## What other clients learned

### The Lounge (Node, SQLite)

- No dedupe of chathistory batches: "as many as ten duplicates of a single
  message in my sqlite database (one per reconnection)" ([thelounge#3204][lounge-3204]).
- The first table (2017) had no id column: `messages (network TEXT, channel
  TEXT, time INTEGER, type TEXT, msg TEXT)` ([commit 941849ea][lounge-first]). A
  2022 migration copied every row into a new table with `id INTEGER PRIMARY
  KEY AUTOINCREMENT` ([sqlite.ts][lounge-migration]).
- A missing `(network, channel, time)` index: history load of 5 channels took
  6.9 s on a 15 GB database and blocked the event loop; with the index it took
  80 ms ([thelounge#5103][lounge-5103], [thelounge#5107][lounge-5107]).
- Unbounded growth ([thelounge#2822][lounge-2822]). The fix, in 2023, deletes
  in batches of 200 rows, "so that we don't block all other db writers"
  ([commit 74aff7ee][lounge-cleaner]), and can delete only low-value types
  such as joins and parts.
- Search is `json_extract(msg, '$.text') LIKE ?` over all rows; channel keys use
  `toLowerCase()` ([sqlite.ts][lounge-search]).
- msgid was added as a column only in 2026, with a plain (not UNIQUE) index
  ([PR #5073][lounge-msgid]).

### Goguma (Flutter, SQLite, soju-focused)

- `Message` stores the raw line and `network_msgid`, with a plain index, not
  UNIQUE ([database.dart][goguma-schema]).
- Duplicates 2 to 5 times on Android, still open. The cause seems to be two
  `main()` runs at the same time, not chathistory ([goguma#254][goguma-254]).
  A UNIQUE index on msgid would have stopped those copies at the database.
- It assumed older rows have smaller ids. History inserts break that, so it now
  pages by time ([commit 5027675][goguma-5027675]).
- One `last_delivered_time` per network, so closing a buffer does not make it
  fetch the same lines again ([commit e359df8][goguma-e359df8]).
- Network key: `UNIQUE(server, bouncer_id)`, where `bouncer_id` is nullable
  ([database.dart][goguma-network]). Because NULLs are distinct in UNIQUE, this
  does not stop two rows for the same server without a bouncer id.
- No full-text search.

### Halloy (Rust, SQLite since 2026)

- It moved from per-buffer gzipped JSON files to SQLite ([halloy#1851][halloy-1851],
  [PR #2388][halloy-2388]). The old flushes rewrote whole files: "~5 MB/min of
  disk writes (~7 GB/day)" ([halloy#2344][halloy-2344]).
- Setup: `busy_timeout`, `auto_vacuum = INCREMENTAL`, WAL,
  `synchronous = NORMAL`, `user_version`, and an error for any unknown version
  ([database.rs][halloy-db]). On shutdown it runs `PRAGMA incremental_vacuum(256)`.
- msgid has a plain partial index `ON message(history, msgid) WHERE msgid IS
  NOT NULL` ([database.rs][halloy-db]). `id` uses AUTOINCREMENT because "stale
  references can outlive even the highest row".
- Matching: history lines and lines with a msgid are matched within +-1 s of
  server time; unlabeled echoes within +-300 s "to account for transit time and
  potential clock skew" ([storage.rs][halloy-reconcile]).
- Regrets: clock skew broke echo matching and showed "Message failed to send"
  next to the echo ([halloy#1671][halloy-1671]). A dedupe rule for the user's own
  lines "had some unintended consequences so it has been removed entirely"
  ([halloy#1885][halloy-1885]). `+H` join replay without tags showed every line
  twice ([halloy#2267][halloy-2267]).
- Search: a contentless FTS5 table (`content='', contentless_delete=1`) with
  `unicode61 remove_diacritics 2`. The rowid is `time * 1024 + (id & 1023)`
  because "FTS5 only orders by rowid without sorting every match, so the rowid
  encodes time" ([database.rs][halloy-searchkey]). User words are quoted with
  `"` doubled ([search.rs][halloy-quote]).

### repartee (Rust) and kokoIRC (Bun + TypeScript)

- Both: SQLite in WAL mode, an external-content FTS5 index on `(nick, text)`,
  writes queued and flushed every 1 s or 50 rows, and no FTS index when log
  encryption is on ([repartee writer.rs][repartee-writer], [repartee db.rs][repartee-db],
  [kokoIRC writer.ts][koko-writer], [kokoIRC db.ts][koko-db]).
- repartee deletes join/part/quit/nick/kick/mode rows after 72 hours by default
  (`event_retention_hours: 72`, [config/mod.rs][repartee-config]). kokoIRC has
  `retention_days: 0`, which means keep forever ([defaults.ts][koko-defaults]).
- repartee indexes event rows in FTS too. Its purge code catches a "database
  corrupt" error from a `DELETE`, runs FTS `'rebuild'`, and tries again; a test
  makes the FTS index out of sync on purpose to cover this
  ([db.rs][repartee-purge]).

### Signal Desktop

- It rebuilt its FTS index after tokenizer changes at least three times:
  migration 77 (new tokenizer, table dropped and filled again), 1750 (URL
  tokens), 1780 (token offsets changed) ([migrations][signal-migrations]).
- Search quotes each token and adds `*`: `"tok"*`, with `"` doubled. It returns
  early on an empty query because "FTS5 is not happy about empty MATCH". It
  sorts and limits in a temp table first and calls `snippet()` only on the
  final rows ([Server.node.ts][signal-search]).

### Quassel

- Schema version 31 changed the backlog time unit from seconds to milliseconds
  with `UPDATE backlog SET time = time * 1000`, which rewrites every row
  ([upgrade_000_update_buffer_set_time_extended.sql][quassel-31]).

### matrix-rust-sdk

- New events are deduplicated by event id against memory and the store. If a
  back-pagination page holds only known events (and at least one not sent by
  the user), the gap is treated as closed: "we would repeat back-paginations for
  events that we have already seen" ([deduplicator.rs][matrix-dedup]).

## Where honk stands

- **No log on disk.** honk keeps lines in memory only: 500 per buffer, up to
  5,000 when history is loaded ([manager.ts:73-75][honk-max]).
- **Requests** `draft/chathistory` and `draft/event-playback`
  ([manager.ts:904-913][honk-caps]), and fetches history on join and after a
  reconnect.
- **Dedupe today** ([manager.ts:2064-2075][honk-push]):

  ```ts
  if (message.msgid && buf.messages.some((m) => m.msgid === message.msgid)) return;
  if (message.isHistory) {
    const msgTime = message.timestamp.getTime();
    const isDup = buf.messages.some(
      (m) =>
        m.from === message.from &&
        m.text === message.text &&
        Math.abs(m.timestamp.getTime() - msgTime) < 2000,
    );
    if (isDup) return;
  }
  ```

  It compares only against lines still in memory. The 2 s window drops a real
  repeat: if alice says "lol" twice within 2 s and both come back from history,
  the second one is lost.
- **Case folding**: `nameKey` is `name.toLowerCase()` and ignores
  `CASEMAPPING` ([names.ts:28-34][honk-names]). The comment calls it "The one
  place to add IRC casemapping later."
- **Server id**: `` id: s.id || s.name || s.host || `server-${idx + 1}` ``
  ([config.ts:98][honk-config]). Without an explicit `id`, renaming a server or
  reordering the list changes the id.
- **Message type**: `ChatMessage` has `msgid`, `timestamp: Date`, `kind`,
  `from`, `text`, `isSelf`, `isHistory`, and `delivery`
  ([types.ts:65-80][honk-types]).
- **Echo matching** compares text without formatting and waits up to 5 minutes
  ([echo.ts][honk-echo]). **Missed lines** after a reconnect are found with a
  5 s margin for clock difference ([missed.ts][honk-missed]).
- **Paths**: honk keeps state in `$XDG_STATE_HOME/honk/state.json`
  ([state.ts][honk-state]).
- **CI** runs on `ubuntu-latest` with Bun 1.4.5 ([ci.yml][honk-ci]), so tests
  there use Bun's own SQLite, not Apple's.

## Recommended design

Everything in this section is a **Recommendation**.

### File and connection

- Path: `$XDG_DATA_HOME/honk/logs.db`, default `~/.local/share/honk/logs.db`.
  The XDG spec puts in `XDG_STATE_HOME` data that is "not important or portable
  enough to the user that it should be stored in `$XDG_DATA_HOME`"
  ([XDG base dir spec][xdg]). Chat logs are important to the user, so they go in
  the data directory.
- Directory mode 0700, file mode 0600. Logs hold private messages.
- Open once at startup:

```ts
import { Database } from "bun:sqlite";

const db = new Database(path, { create: true, strict: true });
db.run("PRAGMA busy_timeout = 5000");
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA synchronous = NORMAL");
db.run("PRAGMA foreign_keys = ON");
const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
if (version > SCHEMA_VERSION) throw new Error(`logs.db is from a newer honk (schema ${version})`);
if (version === 0) {
  db.run("PRAGMA auto_vacuum = INCREMENTAL"); // must come before the first table
  db.exec(SCHEMA_V1);
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
```

- Migrations: one function per version, each in a transaction, run in order.
  Refuse to open a newer schema (as Halloy does).

### Schema

```sql
CREATE TABLE network (
  id          INTEGER PRIMARY KEY,
  config_id   TEXT NOT NULL,            -- honk's server id from config
  bouncer_net TEXT NOT NULL DEFAULT '', -- soju BOUNCER_NETID, '' if none
  display     TEXT NOT NULL,            -- NETWORK or config name, display only
  casemapping TEXT NOT NULL DEFAULT 'rfc1459',
  UNIQUE (config_id, bouncer_net)
);

CREATE TABLE buffer (
  id         INTEGER PRIMARY KEY,
  network_id INTEGER NOT NULL REFERENCES network(id),
  name       TEXT NOT NULL,   -- folded with the network's CASEMAPPING
  display    TEXT NOT NULL,   -- as the server last sent it, e.g. #Honk
  kind       TEXT NOT NULL,   -- 'channel', 'dm', 'status'
  UNIQUE (network_id, name)
);

CREATE TABLE message (
  id          INTEGER PRIMARY KEY,
  buffer_id   INTEGER NOT NULL REFERENCES buffer(id),
  ts          INTEGER NOT NULL,         -- Unix time in ms, UTC
  ts_server   INTEGER NOT NULL,         -- 1 if ts came from a time tag
  kind        TEXT NOT NULL,            -- 'message', 'action', 'notice', 'join', ...
  nick        TEXT NOT NULL DEFAULT '',
  text        TEXT NOT NULL,            -- as received, with formatting codes
  plain       TEXT NOT NULL,            -- formatting removed; this is indexed
  msgid       TEXT,                     -- NULL when the server sent none
  self        INTEGER NOT NULL DEFAULT 0,
  redacted_at INTEGER,                  -- ms; the row stays
  raw         TEXT                      -- the IRC line, for later re-parsing
);

CREATE INDEX message_buffer_ts ON message (buffer_id, ts);
CREATE UNIQUE INDEX message_buffer_msgid ON message (buffer_id, msgid)
  WHERE msgid IS NOT NULL;
CREATE INDEX message_no_msgid ON message (buffer_id, nick, ts)
  WHERE msgid IS NULL;

CREATE VIRTUAL TABLE message_fts USING fts5 (
  plain,
  content = 'message', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER message_fts_ai AFTER INSERT ON message
WHEN new.kind IN ('message', 'action', 'notice') BEGIN
  INSERT INTO message_fts (rowid, plain) VALUES (new.id, new.plain);
END;

CREATE TRIGGER message_fts_ad AFTER DELETE ON message
WHEN old.kind IN ('message', 'action', 'notice') BEGIN
  INSERT INTO message_fts (message_fts, rowid, plain)
  VALUES ('delete', old.id, old.plain);
END;
```

Why each choice:

- `bouncer_net NOT NULL DEFAULT ''`, not NULL: NULLs are distinct in a UNIQUE
  constraint, so `('libera', NULL)` could be inserted twice. Goguma's
  `UNIQUE(server, bouncer_id)` has this hole. Tested: with `''`, the second
  insert fails with `UNIQUE constraint failed`.
- `config_id`, not `NETWORK` or the host: `NETWORK` is informational only, and
  the host can change. soju's netid is stable by spec.
- `buffer.name` folded by the network's `CASEMAPPING`: the same channel must not
  get two buffers (`#foo[1]` and `#FOO{1}` under rfc1459). The fold must not
  change later; changing it means rewriting keys.
- `ts` as integer ms from the start: Quassel had to rewrite every row to change
  units.
- `UNIQUE (buffer_id, msgid)`: msgid is unique per network, and a buffer belongs
  to one network. Goguma and The Lounge use a plain index and got duplicates.
- The same `WHEN` on both triggers: the delete trigger must remove exactly the
  rows the insert trigger added. A mismatch is the "unpredictable" case in the
  FTS5 docs, and the double-delete test above shows it can fail.
- No trigger for `UPDATE`: only `redacted_at` and `msgid` change, and neither is
  indexed. A redaction that should hide text from search deletes the FTS entry
  in the same transaction (see Redaction).
- `plain` computed in TypeScript with the same `stripIrcFormatting` that
  `src/notify.ts` exports. Bun can register SQL functions (`db.function`), but
  then any trigger that called one would fail in a plain `sqlite3` shell. Doing
  it in TS keeps the file usable by other tools.

### Same message or not: dedupe rules

Rules, in order:

1. **msgid present** -> `INSERT ... ON CONFLICT DO NOTHING`. The unique index
   decides.
2. **Replay without msgid** (inside a `chathistory` batch, ZNC playback, or soju
   automatic backlog) -> look for stored rows with the same buffer, kind, nick,
   `plain`, and `floor(ts / 1000)`. Count per key: if the batch has the 2nd copy
   of a key and the store has 2, skip it; if the batch has a 3rd, insert it. So
   two real "lol" lines in one second both survive.
3. **Replay with a msgid**, and a stored row matches rule 2 but has no msgid ->
   fill in the msgid on that row instead of inserting.
4. **Live line without msgid** -> always insert. A live line cannot be a copy.
5. **Own lines**: log a line when it is confirmed (the echo, with the server's
   text and msgid; or, without echo-message, when honk sends it). Do not log
   `delivery: "failed"` lines. Use labeled-response when the server returns the
   label.

Why whole seconds: soju's file store keeps only seconds, and ZNC keeps the
original time tag. Both match on `floor(ts / 1000)`. Limit: a live row with
`ts_server = 0` (honk's clock) can sit in another second than the server's
time. That only happens on servers without server-time, which have no
history either.

A small TypeScript sketch. It was run against the schema above, with
`new Database(path, { strict: true })` so that `$` can be left out of
parameter names:

```ts
type Line = {
  bufferId: number; ts: number; kind: string; nick: string;
  text: string; plain: string; msgid?: string; replay: boolean;
};

const insert = db.prepare(`
  INSERT INTO message (buffer_id, ts, ts_server, kind, nick, text, plain, msgid)
  VALUES ($bufferId, $ts, 1, $kind, $nick, $text, $plain, $msgid)
  ON CONFLICT DO NOTHING`);
const countSame = db.prepare(`
  SELECT count(*) AS n FROM message
  WHERE buffer_id = $bufferId AND msgid IS NULL AND kind = $kind
    AND nick = $nick AND plain = $plain AND ts / 1000 = $sec`);
const fillMsgid = db.prepare(`
  UPDATE message SET msgid = $msgid WHERE id = (
    SELECT id FROM message
    WHERE buffer_id = $bufferId AND msgid IS NULL AND kind = $kind
      AND nick = $nick AND plain = $plain AND ts / 1000 = $sec
    ORDER BY id LIMIT 1)
  AND NOT EXISTS (
    SELECT 1 FROM message WHERE buffer_id = $bufferId AND msgid = $msgid)`);

/** Stores one batch of lines in one transaction. Returns how many were new. */
function storeBatch(lines: Line[]): number {
  const seen = new Map<string, number>(); // rule 2: copies of each key in this batch
  let added = 0;
  db.transaction(() => {
    for (const l of lines) {
      const sec = Math.floor(l.ts / 1000);
      const key = { bufferId: l.bufferId, kind: l.kind, nick: l.nick, plain: l.plain, sec };
      const row = { bufferId: l.bufferId, ts: l.ts, kind: l.kind, nick: l.nick,
                    text: l.text, plain: l.plain, msgid: l.msgid ?? null };
      if (l.msgid) {
        // Rule 3: a replay may carry the msgid of a row stored without one.
        if (l.replay && fillMsgid.run({ ...key, msgid: l.msgid }).changes > 0) continue;
        added += insert.run(row).changes;                 // rule 1: 0 if msgid is known
        continue;
      }
      if (l.replay) {
        const k = [l.bufferId, l.kind, l.nick, l.plain, sec].join("\0");
        const nth = (seen.get(k) ?? 0) + 1;
        seen.set(k, nth);
        const { n } = countSame.get(key) as { n: number };
        if (nth <= n) continue;                           // rule 2: already stored
      }
      added += insert.run(row).changes;                   // rule 4
    }
  })();
  return added;
}
```

Results of the run (t = a time in ms, all lines in `#honk`):

```
batch                                               new rows
live: alice "lol" at t and at t+300 ms              2
replay, no msgid: the same two lines                0   (rule 2)
replay, whole seconds: the two lines + bob "hi"     1   (rule 2, then rule 4)
replay: alice "lol" at t, msgid=abc                 0   (rule 3: row 1 gets abc)
replay: the same line with msgid=abc again          0   (rule 1)
replay: "lol" t+300 msgid=def, carol "new" msgid=ghi 1  (rule 3, then rule 1)
FTS integrity-check                                 ok
```

Other rules:

- **Multiline**: one row per multiline batch, text joined as the spec says,
  msgid from the `BATCH` line. Fallback lines: the first carries the msgid;
  the rest are separate rows without msgid.
- **Ergo HistServ lines**: a msgid starting with `_` is a played-back event
  ([queries.go][ergo-munge]). Store it as an event, not as a message. honk
  already requests `draft/event-playback`, so this should be rare.
- **Redaction**: set `redacted_at`; keep the row (the spec wants a deletion log).
  To hide redacted text from search, in the same transaction run the FTS
  `'delete'` with the current `plain`, and change the `WHEN` of the delete
  trigger to `old.redacted_at IS NULL AND old.kind IN (...)`, so it never
  deletes twice.
- **Order**: always `ORDER BY ts, id`. Never assume a larger id is newer
  (Goguma's mistake).

### Sync with the server

- Keep one `synced_until` (ms) per network, as Goguma does. Move it forward only
  after a whole `chathistory` batch is stored and committed. A crash in the
  middle then fetches the batch again, and dedupe makes that safe.
- After a reconnect: `CHATHISTORY AFTER <buffer> timestamp=<synced_until -
  FUZZ>` with FUZZ about 5 s (the spec suggests 1 to 10 s; honk's missed.ts
  already uses 5 s). Use `msgid=` references only when `MSGREFTYPES` lists
  `msgid`. soju lists only `timestamp`.
- When paging back for scrollback: stop **before** asking for the next page
  if the current page added 0 new rows (the matrix-rust-sdk rule). That means
  the log already has this range.
- `CHATHISTORY TARGETS` finds DMs with history. Because of
  [#604][ircv3-604], treat its list as a hint, not as complete.

### Retention

- Chat lines (`message`, `action`, `notice`): keep forever by default.
- Events (`join`, `part`, `quit`, `nick`, `mode`, `topic`): delete after 30 days
  by default. repartee uses 72 hours; The Lounge offers "delete only low-value
  types".
- Both are config settings.
- Delete in batches (for example 500 rows per transaction, with a pause), as The
  Lounge does, so the UI never waits on one long write. Then run
  `PRAGMA incremental_vacuum(N)` at idle or at exit, as Halloy does.

### Search

- Never pass user input straight to `MATCH`. Split it into words, quote each
  word with `"` doubled, and add `*` to the last word for prefix search. Return
  early on an empty query.

```ts
function ftsQuery(input: string): string | undefined {
  const words = input.split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  return words
    .map((w, i) => `"${w.replaceAll('"', '""')}"` + (i === words.length - 1 ? "*" : ""))
    .join(" ");
}
ftsQuery('crash "fix'); // '"crash" """fix"*'
```

- Filters go in SQL, not in the FTS query: `from:alice` -> `m.nick = ?`,
  `in:#honk` -> `m.buffer_id = ?`, `before:2026-11-01` -> `m.ts < ?`.

```sql
SELECT m.id, m.ts, m.nick, b.display,
       highlight(message_fts, 0, char(1), char(2)) AS hl
FROM message_fts
JOIN message m ON m.id = message_fts.rowid
JOIN buffer b  ON b.id = m.buffer_id
WHERE message_fts MATCH $q AND m.nick = $nick
ORDER BY m.ts DESC, m.id DESC
LIMIT 50;
```

- Sort by time, not by `bm25()`: in a chat log, newer is usually what the user
  wants. If this query gets slow on very large logs, two known fixes exist:
  Signal's temp table (sort and limit first, then `highlight()`/`snippet()`),
  or Halloy's rowid that encodes time.
- A trigram index for substrings in URLs and nicks can come later. It costs
  more disk, and queries under 3 characters do not use it.

### Writes and threads

- Queue rows in memory and write one transaction every 1 s or 100 rows,
  whichever comes first. Flush on exit and on `SIGTERM`. A `chathistory` batch
  is written as one transaction.
- bun:sqlite calls block the JavaScript thread. A scrollback page (0.4 ms) is
  fine. A search over a large log (28 ms at 1M rows) is fine now, but it is
  the first thing to move to a Worker with its own read-only connection if the
  UI stutters.

### Platform notes

- macOS: the SQLite version comes from macOS. Check `sqlite_version()` at
  startup and refuse the log (with a clear message, chat still works) if it is
  older than the minimum honk supports. The SQL above needs 3.24 (UPSERT) and
  3.8 (partial indexes), plus FTS5. Avoid `RETURNING` (3.35) and
  `contentless_delete` (3.43) unless the minimum is raised.
- macOS keeps `logs.db-wal` and `logs.db-shm` after close. Backup docs must say
  to copy all three files, or to use `VACUUM INTO`.
- Linux and Windows use Bun's SQLite; CI already runs on Linux, so run the log
  tests there and on a Mac.

## Test plan

Each scenario runs against `fakeircd` and checks the rows in a temp
`logs.db`.

| Scenario | Server behavior | Expect |
|---|---|---|
| Ergo-like | msgid and ms time, live and on `CHATHISTORY` | No duplicates after reconnect and replay. |
| soju-fs-like | msgid live; replay with no msgid and whole-second time | Each live line stored once; new lines added. |
| ZNC-like | live with msgid; playback with only `time` | No duplicates. |
| OFTC-like | no tags at all | Every live line stored; no history requested. |
| Two "lol" in one second | same nick, same text, same second, then replayed | 2 rows, not 1 and not 4. |
| Replay fills msgid | live line without msgid, replay with msgid | 1 row, msgid set. |
| Self echo | echo-message with changed text (`+c` strips colors) | 1 row with the echoed text and msgid. |
| Failed send | connection drops before echo | No row. |
| Redaction | `REDACT` for a stored msgid | Row kept, `redacted_at` set, not found by search. |
| Multiline | `draft/multiline` batch, and the fallback form | 1 row; fallback: first row has the msgid. |
| Casemapping | `CASEMAPPING=rfc1459`, lines to `#a[b]` and `#A{B}` | One buffer. |
| Retention | old events and old chat | Events deleted, chat kept. |
| Crash mid-batch | kill before commit | Next start re-fetches; no duplicates. |
| Newer schema | `user_version` above honk's | Log disabled with a message; chat works. |

After each scenario, run
`INSERT INTO message_fts(message_fts) VALUES ('integrity-check')`.

Suggested work order:

1. Make `nameKey` follow `CASEMAPPING` (it is used as a key everywhere, and
   the log will store it).
2. The log store, write-only, with the dedupe rules and the tests above.
3. Search in the omnibox.
4. Scrollback from the log (load older lines from disk before asking the
   server).

## Open decisions for the user

1. **Log by default?** Logging forever is the common default (kokoIRC, soju).
   Some users will not want a disk log of private messages. Options: on by
   default with a config switch, or off by default.
2. **Log failed lines?** The recommendation above says no. The user's text is
   then only on screen.
3. **Config renames.** The network key uses the server `id` from config, and
   without an explicit `id` it falls back to name, host, or position. If the
   user renames a server, the log sees a new network. Options: tell users to set
   `id`; or add a command such as `honk logs rename <old> <new>` that updates
   `network.config_id`.
4. **Minimum macOS / SQLite version.** Which oldest SQLite should honk
   support? This decides whether `RETURNING` and `contentless_delete` can be
   used. (The SQLite version for each macOS release was not checked here.)
5. **Events retention.** 30 days, 72 hours like repartee, or forever?

## Sources

### Specs

- IRCv3 message-ids: https://ircv3.net/specs/extensions/message-ids
- IRCv3 server-time: https://ircv3.net/specs/extensions/server-time
- IRCv3 chathistory (draft): https://ircv3.net/specs/extensions/chathistory
- IRCv3 echo-message: https://ircv3.net/specs/extensions/echo-message
- IRCv3 labeled-response: https://ircv3.net/specs/extensions/labeled-response
- IRCv3 message-redaction: https://ircv3.net/specs/extensions/message-redaction
- IRCv3 read-marker: https://ircv3.net/specs/extensions/read-marker
- IRCv3 multiline: https://ircv3.net/specs/extensions/multiline
- ircv3-specifications#540: https://github.com/ircv3/ircv3-specifications/issues/540
- ircv3-specifications#604: https://github.com/ircv3/ircv3-specifications/issues/604
- Modern IRC, NETWORK: https://modern.ircdocs.horse/#network-parameter
- Modern IRC, CASEMAPPING: https://modern.ircdocs.horse/#casemapping-parameter
- soju bouncer-networks: https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/doc/ext/bouncer-networks.md
- XDG Base Directory: https://specifications.freedesktop.org/basedir-spec/latest/

### SQLite and Bun

- Bun SQLite docs: https://bun.com/docs/runtime/sqlite
- FTS5: https://sqlite.org/fts5.html (external content pitfalls: section 4.4.4; 'delete' command: section 6.3; unicode61: 4.3.1; trigram: 4.3.4)
- NULL handling: https://sqlite.org/nulls.html
- PRAGMA: https://sqlite.org/pragma.html
- RETURNING: https://sqlite.org/lang_returning.html
- UPSERT: https://sqlite.org/lang_upsert.html
- Partial indexes: https://sqlite.org/partialindex.html

### Servers and bouncers

- Ergo (commit 47b63c9): msgid token https://github.com/ergochat/ergo/blob/47b63c9bb58012311274c26c8b950201ec40364e/irc/utils/crypto.go#L23-L41, time format https://github.com/ergochat/ergo/blob/47b63c9bb58012311274c26c8b950201ec40364e/irc/utils/args.go#L15, MSGREFTYPES https://github.com/ergochat/ergo/blob/47b63c9bb58012311274c26c8b950201ec40364e/irc/config.go#L1942, HistServ msgid https://github.com/ergochat/ergo/blob/47b63c9bb58012311274c26c8b950201ec40364e/irc/history/queries.go#L82-L84, multiline fallback https://github.com/ergochat/ergo/blob/47b63c9bb58012311274c26c8b950201ec40364e/irc/client.go#L1498
- soju (commit de8690c): schema https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/database/sqlite_migrations.go#L151-L184, insert https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/database/sqlite.go#L1123-L1157, quoteFTSQuery https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/database/sqlite.go#L1333-L1340, time.Now stamp https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/upstream.go#L688-L694, fs log writer https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/msgstore/znclog/writer.go#L13-L19, reader https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/msgstore/znclog/reader.go#L150-L158, MSGREFTYPES https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/downstream.go#L1336, msgid TODO https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/downstream.go#L3150, backlog https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/downstream.go#L1841, man page https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/doc/soju.1.scd#L249-L260, strip formatting commit https://github.com/emersion/soju/commit/24893180ec0f61588e4f7283913d8aed6d7548a5
- ZNC (commit 51c9151): Buffer.cpp https://github.com/znc/znc/blob/51c9151e056b772a8d801625673f1736cf2a4fe9/src/Buffer.cpp#L68-L86, Client.cpp https://github.com/znc/znc/blob/51c9151e056b772a8d801625673f1736cf2a4fe9/src/Client.cpp#L689-L690
- znc-playback: https://github.com/jpnurmi/znc-playback/blob/8dd128bfe2b24b2cc6a9ea2e2d28bfaa28d2a833/playback.cpp#L270-L282
- Libera.Chat news, 2026-02-11: https://libera.chat/news/new-and-upcoming-features-3

### Clients

- The Lounge: #3204 https://github.com/thelounge/thelounge/issues/3204, #5103 https://github.com/thelounge/thelounge/issues/5103, #5107 https://github.com/thelounge/thelounge/pull/5107, #2822 https://github.com/thelounge/thelounge/issues/2822, #5073 https://github.com/thelounge/thelounge/pull/5073, sqlite.ts https://github.com/thelounge/thelounge/blob/70db8bcb6faf98e9c2a09018e26c28ae3eaa0b09/server/plugins/messageStorage/sqlite.ts, first schema https://github.com/thelounge/thelounge/commit/941849ea, storage cleaner https://github.com/thelounge/thelounge/commit/74aff7ee
- Goguma (Codeberg, commit 4b5e625): #254 https://codeberg.org/emersion/goguma/issues/254, database.dart https://codeberg.org/emersion/goguma/src/commit/4b5e6257f51a7f1437482b6912709f8a107f6b2d/lib/database.dart, commit 5027675 https://codeberg.org/emersion/goguma/commit/5027675b754dc1a74d2f18a005b8644308af1c5a, commit e359df8 https://codeberg.org/emersion/goguma/commit/e359df8e0bc3463f00edc3c676c887c24d6c5f2c
- Halloy (commit 8e63ff3): #1851 https://github.com/squidowl/halloy/issues/1851, #2388 https://github.com/squidowl/halloy/pull/2388, #2344 https://github.com/squidowl/halloy/issues/2344, #1671 https://github.com/squidowl/halloy/issues/1671, #1885 https://github.com/squidowl/halloy/issues/1885, #2267 https://github.com/squidowl/halloy/issues/2267, database.rs https://github.com/squidowl/halloy/blob/8e63ff3ca607cb4ccc9533c4885ede010bfb8b77/data/src/history/database.rs#L208-L262, search key https://github.com/squidowl/halloy/blob/8e63ff3ca607cb4ccc9533c4885ede010bfb8b77/data/src/history/database.rs#L1681-L1684, reconcile https://github.com/squidowl/halloy/blob/8e63ff3ca607cb4ccc9533c4885ede010bfb8b77/data/src/history/storage.rs#L42-L44, search.rs https://github.com/squidowl/halloy/blob/8e63ff3ca607cb4ccc9533c4885ede010bfb8b77/data/src/history/search.rs#L129-L141
- repartee (commit c082a0d): writer https://github.com/outragedevs/repartee/blob/c082a0dbaf6cd81deed2c346f0007a60f3843162/src/storage/writer.rs#L11-L12, db.rs https://github.com/outragedevs/repartee/blob/c082a0dbaf6cd81deed2c346f0007a60f3843162/src/storage/db.rs#L60-L83, purge https://github.com/outragedevs/repartee/blob/c082a0dbaf6cd81deed2c346f0007a60f3843162/src/storage/db.rs#L429-L470, config https://github.com/outragedevs/repartee/blob/c082a0dbaf6cd81deed2c346f0007a60f3843162/src/config/mod.rs#L450-L460
- kokoIRC (commit 7c3f56d): writer.ts https://github.com/kofany/kokoIRC/blob/7c3f56d2c29417de601b7e04bcae0254075b1c23/src/core/storage/writer.ts, db.ts https://github.com/kofany/kokoIRC/blob/7c3f56d2c29417de601b7e04bcae0254075b1c23/src/core/storage/db.ts, defaults.ts https://github.com/kofany/kokoIRC/blob/7c3f56d2c29417de601b7e04bcae0254075b1c23/src/core/config/defaults.ts#L71-L76
- Signal Desktop (commit 01e5971): search https://github.com/signalapp/Signal-Desktop/blob/01e59719454fec204b3f7902fb663d68419848c9/ts/sql/Server.node.ts#L2258-L2362, migrations https://github.com/signalapp/Signal-Desktop/tree/01e59719454fec204b3f7902fb663d68419848c9/ts/sql/migrations (77-signal-tokenizer, 1750-fts-url, 1780-fts-reindex)
- Quassel v31: https://github.com/quassel/quassel/blob/master/src/core/SQL/SQLite/version/31/upgrade_000_update_buffer_set_time_extended.sql
- matrix-rust-sdk deduplicator: https://github.com/matrix-org/matrix-rust-sdk/blob/main/crates/matrix-sdk/src/event_cache/deduplicator.rs
- Mozilla bug 954577: https://bugzilla.mozilla.org/show_bug.cgi?id=954577

### honk (this repo)

- src/irc/manager.ts:73-75, 904-913, 2053-2075
- src/irc/names.ts:28-34
- src/config.ts:98
- src/types.ts:65-80, 99
- src/irc/echo.ts:1-35
- src/irc/missed.ts:1-33
- src/state.ts:6, 26
- .github/workflows/ci.yml:16, 26

[bun-sqlite]: https://bun.com/docs/runtime/sqlite
[sqlite-returning]: https://sqlite.org/lang_returning.html
[sqlite-nulls]: https://sqlite.org/nulls.html
[sqlite-pragma]: https://sqlite.org/pragma.html
[sqlite-upsert]: https://sqlite.org/lang_upsert.html
[sqlite-partial]: https://sqlite.org/partialindex.html
[fts5]: https://sqlite.org/fts5.html
[fts5-delete]: https://sqlite.org/fts5.html#the_delete_command
[fts5-pitfalls]: https://sqlite.org/fts5.html#external_content_table_pitfalls
[fts5-unicode61]: https://sqlite.org/fts5.html#unicode61_tokenizer
[fts5-trigram]: https://sqlite.org/fts5.html#the_trigram_tokenizer
[moz-954577]: https://bugzilla.mozilla.org/show_bug.cgi?id=954577
[msgid]: https://ircv3.net/specs/extensions/message-ids
[server-time]: https://ircv3.net/specs/extensions/server-time
[chathistory]: https://ircv3.net/specs/extensions/chathistory
[echo]: https://ircv3.net/specs/extensions/echo-message
[labeled]: https://ircv3.net/specs/extensions/labeled-response
[redaction]: https://ircv3.net/specs/extensions/message-redaction
[read-marker]: https://ircv3.net/specs/extensions/read-marker
[multiline]: https://ircv3.net/specs/extensions/multiline
[ircv3-540]: https://github.com/ircv3/ircv3-specifications/issues/540
[ircv3-604]: https://github.com/ircv3/ircv3-specifications/issues/604
[modern-network]: https://modern.ircdocs.horse/#network-parameter
[modern-casemapping]: https://modern.ircdocs.horse/#casemapping-parameter
[soju-bn]: https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/doc/ext/bouncer-networks.md
[xdg]: https://specifications.freedesktop.org/basedir-spec/latest/
[ergo-token]: https://github.com/ergochat/ergo/blob/47b63c9bb58012311274c26c8b950201ec40364e/irc/utils/crypto.go#L23-L41
[ergo-time]: https://github.com/ergochat/ergo/blob/47b63c9bb58012311274c26c8b950201ec40364e/irc/utils/args.go#L15
[ergo-msgref]: https://github.com/ergochat/ergo/blob/47b63c9bb58012311274c26c8b950201ec40364e/irc/config.go#L1942
[ergo-munge]: https://github.com/ergochat/ergo/blob/47b63c9bb58012311274c26c8b950201ec40364e/irc/history/queries.go#L82-L84
[ergo-multiline]: https://github.com/ergochat/ergo/blob/47b63c9bb58012311274c26c8b950201ec40364e/irc/client.go#L1498
[soju-schema]: https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/database/sqlite_migrations.go#L151-L184
[soju-insert]: https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/database/sqlite.go#L1123-L1157
[soju-quote]: https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/database/sqlite.go#L1333-L1340
[soju-strip]: https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/database/sqlite.go#L1145-L1151
[soju-strip-commit]: https://github.com/emersion/soju/commit/24893180ec0f61588e4f7283913d8aed6d7548a5
[soju-now]: https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/upstream.go#L688-L694
[soju-znclog-w]: https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/msgstore/znclog/writer.go#L13-L19
[soju-znclog-r]: https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/msgstore/znclog/reader.go#L150-L158
[soju-msgref]: https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/downstream.go#L1336
[soju-todo]: https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/downstream.go#L3150
[soju-backlog]: https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/downstream.go#L1841
[soju-man]: https://github.com/emersion/soju/blob/de8690c06fd31e2d34bc84926a6620c5ab2796f0/doc/soju.1.scd#L249-L260
[znc-buffer]: https://github.com/znc/znc/blob/51c9151e056b772a8d801625673f1736cf2a4fe9/src/Buffer.cpp#L68-L86
[znc-client]: https://github.com/znc/znc/blob/51c9151e056b772a8d801625673f1736cf2a4fe9/src/Client.cpp#L689-L690
[znc-playback]: https://github.com/jpnurmi/znc-playback/blob/8dd128bfe2b24b2cc6a9ea2e2d28bfaa28d2a833/playback.cpp#L270-L282
[libera-news]: https://libera.chat/news/new-and-upcoming-features-3
[lounge-3204]: https://github.com/thelounge/thelounge/issues/3204
[lounge-5103]: https://github.com/thelounge/thelounge/issues/5103
[lounge-5107]: https://github.com/thelounge/thelounge/pull/5107
[lounge-2822]: https://github.com/thelounge/thelounge/issues/2822
[lounge-msgid]: https://github.com/thelounge/thelounge/pull/5073
[lounge-first]: https://github.com/thelounge/thelounge/commit/941849ea
[lounge-migration]: https://github.com/thelounge/thelounge/blob/70db8bcb6faf98e9c2a09018e26c28ae3eaa0b09/server/plugins/messageStorage/sqlite.ts#L45-L54
[lounge-search]: https://github.com/thelounge/thelounge/blob/70db8bcb6faf98e9c2a09018e26c28ae3eaa0b09/server/plugins/messageStorage/sqlite.ts#L401-L479
[lounge-cleaner]: https://github.com/thelounge/thelounge/commit/74aff7ee
[goguma-254]: https://codeberg.org/emersion/goguma/issues/254
[goguma-schema]: https://codeberg.org/emersion/goguma/src/commit/4b5e6257f51a7f1437482b6912709f8a107f6b2d/lib/database.dart#L460-L474
[goguma-network]: https://codeberg.org/emersion/goguma/src/commit/4b5e6257f51a7f1437482b6912709f8a107f6b2d/lib/database.dart#L427-L437
[goguma-5027675]: https://codeberg.org/emersion/goguma/commit/5027675b754dc1a74d2f18a005b8644308af1c5a
[goguma-e359df8]: https://codeberg.org/emersion/goguma/commit/e359df8e0bc3463f00edc3c676c887c24d6c5f2c
[halloy-1851]: https://github.com/squidowl/halloy/issues/1851
[halloy-2388]: https://github.com/squidowl/halloy/pull/2388
[halloy-2344]: https://github.com/squidowl/halloy/issues/2344
[halloy-1671]: https://github.com/squidowl/halloy/issues/1671
[halloy-1885]: https://github.com/squidowl/halloy/issues/1885
[halloy-2267]: https://github.com/squidowl/halloy/issues/2267
[halloy-db]: https://github.com/squidowl/halloy/blob/8e63ff3ca607cb4ccc9533c4885ede010bfb8b77/data/src/history/database.rs#L208-L262
[halloy-searchkey]: https://github.com/squidowl/halloy/blob/8e63ff3ca607cb4ccc9533c4885ede010bfb8b77/data/src/history/database.rs#L1681-L1684
[halloy-reconcile]: https://github.com/squidowl/halloy/blob/8e63ff3ca607cb4ccc9533c4885ede010bfb8b77/data/src/history/storage.rs#L1755-L1770
[halloy-quote]: https://github.com/squidowl/halloy/blob/8e63ff3ca607cb4ccc9533c4885ede010bfb8b77/data/src/history/search.rs#L129-L141
[repartee-writer]: https://github.com/outragedevs/repartee/blob/c082a0dbaf6cd81deed2c346f0007a60f3843162/src/storage/writer.rs#L11-L12
[repartee-db]: https://github.com/outragedevs/repartee/blob/c082a0dbaf6cd81deed2c346f0007a60f3843162/src/storage/db.rs#L60-L83
[repartee-purge]: https://github.com/outragedevs/repartee/blob/c082a0dbaf6cd81deed2c346f0007a60f3843162/src/storage/db.rs#L429-L470
[repartee-config]: https://github.com/outragedevs/repartee/blob/c082a0dbaf6cd81deed2c346f0007a60f3843162/src/config/mod.rs#L450-L460
[koko-writer]: https://github.com/kofany/kokoIRC/blob/7c3f56d2c29417de601b7e04bcae0254075b1c23/src/core/storage/writer.ts#L1-L30
[koko-db]: https://github.com/kofany/kokoIRC/blob/7c3f56d2c29417de601b7e04bcae0254075b1c23/src/core/storage/db.ts#L48-L80
[koko-defaults]: https://github.com/kofany/kokoIRC/blob/7c3f56d2c29417de601b7e04bcae0254075b1c23/src/core/config/defaults.ts#L71-L76
[signal-search]: https://github.com/signalapp/Signal-Desktop/blob/01e59719454fec204b3f7902fb663d68419848c9/ts/sql/Server.node.ts#L2258-L2362
[signal-migrations]: https://github.com/signalapp/Signal-Desktop/tree/01e59719454fec204b3f7902fb663d68419848c9/ts/sql/migrations
[quassel-31]: https://github.com/quassel/quassel/blob/master/src/core/SQL/SQLite/version/31/upgrade_000_update_buffer_set_time_extended.sql
[matrix-dedup]: https://github.com/matrix-org/matrix-rust-sdk/blob/main/crates/matrix-sdk/src/event_cache/deduplicator.rs
[honk-max]: ../../src/irc/manager.ts#L73-L75
[honk-caps]: ../../src/irc/manager.ts#L904-L913
[honk-push]: ../../src/irc/manager.ts#L2053-L2075
[honk-names]: ../../src/irc/names.ts#L28-L34
[honk-config]: ../../src/config.ts#L98
[honk-types]: ../../src/types.ts#L65-L80
[honk-echo]: ../../src/irc/echo.ts#L1-L35
[honk-missed]: ../../src/irc/missed.ts#L1-L33
[honk-state]: ../../src/state.ts#L1-L30
[honk-ci]: ../../.github/workflows/ci.yml
