# One exact rule decides whether a Line is a Replay

The screen and the **Log** use the same rule to decide whether an incoming
**Line** is a **Replay** of one honk already has:

1. Both have a msgid: same Buffer and same msgid means the same Line. The
   Log enforces this with a unique index.
2. A Line from **History** without a msgid matches a kept Line with the same
   kind, nick, text without formatting, and time in whole seconds. Matches
   are counted: if History holds "lol" twice in one second and honk has it
   once, one more is kept. A kept Line whose time came from honk's clock, not
   from the server, matches when the two times are less than 2 seconds apart,
   because the two clocks can differ.
3. A History Line with a msgid that matches a kept Line without one gives
   that Line its msgid.
4. A live Line without a msgid is always new.
5. Your own Line enters the Log when the server confirms it: its **Echo**,
   or, without echo-message, honk's delivery check. With an Echo it gets the
   server's text and msgid. A Line that never arrived is not logged.

honk asks for History only after each Network's **Sync marker**, so this rule
is a safety net, not the main way to avoid copies.

## Why exact and not a time window

Other clients that matched Lines inside a time window kept running into
trouble. Halloy broke when a clock was 7 minutes off, and removed a rule
because it "had unintended consequences". The rule honk had before this
decision, the same sender and text within 2 seconds, drops a real repeated
"lol". Rule 2 keeps a 2-second window only for times from honk's own
clock, where no server time exists to compare. Clients with no rule at
all, such as The Lounge and Goguma, stored the same Lines 2 to 10 times. Whole seconds in rule 2 are needed because soju's
file store and ZNC cut times to the second and drop msgids. Sources are in
`docs/research/message-log.md`.
