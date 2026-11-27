# honk

honk is a terminal IRC client. These are the words its code, issues, and docs
use for the things a user sees and the things honk keeps.

## Where lines come from

**Server**:
One entry in the config that honk connects to, named by its `id`.
_Avoid_: connection, account

**Network**:
An IRC network, such as Libera.Chat, reached through a **Server**. Behind a
**Bouncer**, each **Server** entry reaches one **Network**.
_Avoid_: server (when you mean the network)

**Bouncer**:
A program, such as soju or ZNC, that stays connected to a **Network** for you
and keeps the **Lines** you missed.
_Avoid_: proxy, BNC

## What the user sees

**Buffer**:
One conversation in honk: a channel, a **DM**, or the status buffer of a
**Server**.
_Avoid_: window, tab, pane, room

**DM**:
A **Buffer** for private messages with one nick. A new nick means a new **DM**.
_Avoid_: query, PM, private chat

**Line**:
One entry in a **Buffer**: a **Chat line** or an **Event**.
_Avoid_: message (except for the "message" kind of Chat line), entry, row

**Chat line**:
A **Line** someone wrote: a message, an action (/me), a notice, or a topic.
_Avoid_: text, post

**Event**:
A **Line** that records something happening, not something said: a join, part,
quit, nick change, or kick.
_Avoid_: status line, system message

**Echo**:
The **Network**'s copy of a **Line** you sent, which confirms that it arrived.
_Avoid_: ack, receipt

**Mention**:
A **Chat line** that names your nick, or any **Chat line** in a **DM**.
_Avoid_: highlight, ping

**Redacted line**:
A **Chat line** that its author or an operator deleted after it was sent.
_Avoid_: deleted message, removed line

## What honk keeps

**Log**:
honk's own record on disk of the **Lines** from every **Network**, kept
across restarts and searchable.
_Avoid_: history, archive, backlog, database

**History**:
**Lines** that a **Network** or **Bouncer** sends again when honk asks, to
fill a gap.
_Avoid_: backlog, playback, log

**Replay**:
A **Line** that arrives again, through **History** or a **Bouncer**, after
honk may already have it.
_Avoid_: duplicate (a duplicate is a Replay that was wrongly kept)

**Sync marker**:
For each **Network**, the time up to which its **History** is already in the
**Log**.
_Avoid_: last seen, checkpoint

**Retention**:
How long the **Log** keeps **Chat lines** and **Events** before removing them.
_Avoid_: expiry, cleanup

**Context view**:
A read-only view of the **Log** around one search result, apart from the live
**Buffer**.
_Avoid_: preview, jump view
