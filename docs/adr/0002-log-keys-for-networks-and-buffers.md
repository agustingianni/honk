# Key Networks by Server id and Buffers by their CASEMAPPING-folded name

In the **Log**, a **Network** is keyed by the **Server** `id` from the config
plus the soju network id (`BOUNCER_NETID`, or empty when there is none). A
**Buffer** is keyed by its name folded with the server's `CASEMAPPING`
(`rfc1459` when the server sends none), and a **DM** by the nick. These keys
are stored forever, so changing them later means rewriting every row.

## Considered options

- **The `NETWORK` name the server sends**: the spec calls it "for
  INFORMATIONAL PURPOSES ONLY". It can change, and two Servers can share it.
  honk stores it only for display.
- **A random id per Server**, as The Lounge does: it survives a rename but
  is lost when the Server is removed and added again.
- **Lowercasing names**, as honk's `nameKey` did before this decision: under
  `rfc1459`, `#foo[` and `#foo{` are one channel, so lowercasing alone would
  split one channel's Log into two.
- **Keying DMs by account name** (`account-tag`): survives nick changes, but
  many networks don't send account names. It can come later as a migration.

## Consequences

- Renaming a Server's `id` in the config makes its old Lines belong to a
  Server that no longer exists. The README tells users to set `id`, and a
  later `honk logs rename <old> <new>` command moves the Lines. The Log keeps
  the Lines of a removed Server, and they stay searchable.
- `nameKey` must follow the server's CASEMAPPING before the Log ships, so the
  screen and the Log agree on what one Buffer is.
