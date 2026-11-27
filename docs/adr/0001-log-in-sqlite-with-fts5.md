# Keep the Log in one SQLite file with an FTS5 index

honk keeps its **Log** in one SQLite file, `$XDG_DATA_HOME/honk/logs.db`
(default `~/.local/share/honk/logs.db`), opened with `bun:sqlite`, with an
FTS5 full-text index over **Chat lines**. Bun ships SQLite, so there is no new
dependency, and FTS5 answers a search over 1,000,000 lines in about 30 ms
(measured in `docs/research/message-log.md`). Text log files can't be searched
without reading them all, and a server such as Postgres is too much for a
terminal client.

## Considered options

- **Plain text files per Buffer**, as weechat and irssi do: easy to read with
  other tools, but slow to search, and they can't keep msgids, so Replays
  can't be told apart. The Halloy client moved off its own files to SQLite
  in 2026.
- **Bundle our own SQLite build** instead of Apple's: a known version on every
  Mac, but a native library to build and ship for each target. Not needed
  while the design fits SQLite 3.39.
- **Encrypt the Log**: in repartee and kokoIRC encryption turns search off.
  Disk encryption (FileVault, LUKS) and file mode 0600 protect the file
  instead.

## Consequences

- On macOS, Bun loads Apple's system SQLite, so the version depends on the
  user's macOS. Bun needs macOS 13, which ships about SQLite 3.39. The SQL
  must use nothing newer than 3.39: no FTS5 `contentless_delete` (3.43).
  At startup honk checks `sqlite_version()` and FTS5. If either check fails,
  logging turns off with one message in *status, and the rest of honk keeps
  working.
- Linux and Windows builds use Bun's own SQLite, so CI on Linux does not test
  Apple's build. Run the Log tests on a Mac as well.
- Only one honk process writes the Log. A second process reads it for search
  and says so in *status, because two writers would store each Line without a
  msgid twice.
- The schema has a version in `PRAGMA user_version`. honk migrates older
  files and refuses to open a file from a newer honk.
