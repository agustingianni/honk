# honk

A terminal IRC client, built with [Bun](https://bun.sh) and [OpenTUI](https://github.com/anomalyco/opentui).

## Install

On macOS or Linux:

```sh
curl -fsSL https://agustingianni.github.io/honk/install.sh | sh
```

The [script](site/install.sh) picks the binary for your OS and CPU, checks its
SHA-256 checksum, and puts it in `~/.local/bin`. It never uses sudo and never
edits your shell config. It also writes a small file,
`~/.local/state/honk/receipt.json`, that records where it put honk, so that a
later `honk upgrade` only replaces a copy this script installed. Settings:

- `HONK_VERSION=v0.1.0` installs that release instead of the latest one.
- `HONK_INSTALL_DIR=~/bin` installs into another folder.

```sh
curl -fsSL https://agustingianni.github.io/honk/install.sh | HONK_VERSION=v0.1.0 sh
```

On Alpine and other musl-based distros, honk needs the C++ runtime first:

```sh
apk add libstdc++ libgcc
```

### Install by hand

Download `honk-<os>-<cpu>.gz` from the
[latest release](https://github.com/agustingianni/honk/releases/latest) and
unpack it.
Use `curl` rather than a browser: on macOS, a file downloaded in a browser is
quarantined, and Gatekeeper blocks it because the binary is not signed.

```sh
# Pick one: darwin-arm64 (Apple Silicon), darwin-x64, linux-x64, linux-arm64,
# linux-x64-musl or linux-arm64-musl (Alpine and other musl-based distros)
PLATFORM=darwin-arm64

mkdir -p ~/.local/bin
curl -fL -o /tmp/honk.gz \
  "https://github.com/agustingianni/honk/releases/latest/download/honk-$PLATFORM.gz" &&
  gunzip -c /tmp/honk.gz > ~/.local/bin/honk.new &&
  chmod +x ~/.local/bin/honk.new &&
  mv ~/.local/bin/honk.new ~/.local/bin/honk
```

Each step runs only if the one before it worked, so a failed download leaves
an installed honk as it was. `honk upgrade` does not replace a copy installed
by hand, because only the install script records where it put honk. To
upgrade, repeat these steps.

If you downloaded it in a browser anyway, remove the quarantine flag:

```sh
xattr -d com.apple.quarantine ~/.local/bin/honk
```

### Check a download

Each release has a `SHA256SUMS` file with the checksum of each `.gz` file.
Both the `.gz` files and the binaries inside them are signed with a build
provenance attestation. To check that your binary was built by this repo's
release workflow from a tagged commit:

```sh
gh attestation verify ~/.local/bin/honk -R agustingianni/honk
```

### Upgrade

If you installed honk with the install script, upgrade it with:

```sh
honk upgrade
```

It downloads the latest release and checks it the same way the install script
does: the checksum, and the attestation when `gh` is installed and logged in.
Then it replaces the binary. A honk that is already running keeps working.

`honk upgrade` only replaces the copy that the install script recorded in
`~/.local/state/honk/receipt.json`. If you installed honk another way, upgrade
it that way, or run the install script again.

In honk v0.2.0 and older, `honk upgrade` hangs after
`downloading honk-...gz`. Upgrade those once with the install script above,
with the same `HONK_INSTALL_DIR` if you set one. Later versions upgrade
themselves.

Once a day at most, honk asks GitHub in the background for the latest release
tag. When there is a newer one, the status bar at the bottom shows it, such as
`v0.3.0 available: honk upgrade`, and the status buffer explains it. It only
reads the tag: nothing is downloaded until you run `honk upgrade`. To turn the
check off, set `HONK_NO_UPDATE_CHECK=1`. It is also off when `CI` is set and in
`--demo`.

Behind a proxy, `honk upgrade` and the update check use `HTTPS_PROXY` (or
`ALL_PROXY`) and skip the hosts in `NO_PROXY`, like curl does.

### Uninstall

If you installed honk with the install script, delete the binary, the install
receipt and the update check's cache:

```sh
rm ~/.local/bin/honk
rm -rf ~/.local/state/honk ~/.cache/honk
```

If you installed into another folder with `HONK_INSTALL_DIR`, delete `honk`
from there instead. If you set `XDG_STATE_HOME` or `XDG_CACHE_HOME`, the other
two folders are `$XDG_STATE_HOME/honk` and `$XDG_CACHE_HOME/honk`.

Your config is in `~/.config/honk/`. It can hold server passwords, so delete it
too if you don't need it. If you installed honk another way, remove it that way.

## Usage

Connect to one server from the command line:

```sh
honk --server irc.libera.chat --nick goose --channel '#libera'
```

To look around first, without connecting anywhere, run the offline demo. It has
made-up networks, channels and people, and sends nothing over the network:

```sh
honk --demo
```

Flags: `--server host[:port]`, `--port`, `--nick`, `--channel` (can repeat),
`--password` (uses SASL), `--sasl`, `--no-tls`, `--config path`, `--theme`,
`--no-mouse`, `--demo`, `--version` (or `-v`), `--help` (or `-h`).
TLS is on by default. Type `/help` inside the client for the commands.

### Keys

| Key | What it does |
|---|---|
| Ctrl+K | Open or close the omnibox: switch buffers, join channels, run actions |
| Ctrl+B | Show or hide the sidebar |
| Alt+U | Show or hide the user list |
| Alt+Up, Alt+Down | Go to the previous or next buffer |
| Tab, Shift+Tab | Complete a nick or channel name, and cycle through the matches |
| Up, Down, Ctrl+P, Ctrl+N | Walk through the lines you sent |
| PageUp, PageDown | Scroll the chat by half a screen |
| Shift+Up, Shift+Down | Scroll the chat by three lines |
| Ctrl+C | Copy the selected text, or quit when nothing is selected |
| Esc | Clear the selected text |

In the omnibox, Up and Down (or Ctrl+P and Ctrl+N) move the selection, Enter
runs it, and Esc closes the omnibox.

On macOS, the Option key types characters by default instead of acting as Alt,
so Alt+U may not reach honk. Two ways around it:

- Open the omnibox and pick "View: Toggle User List".
- Make Option act as Alt in your terminal: "Use Option as Meta key" in
  Terminal.app (Settings > Profiles > Keyboard), "Esc+" for the Option key in
  iTerm2 (Settings > Profiles > Keys), or `macos-option-as-alt = true` in
  Ghostty.

In Ghostty, Alt+Up and Alt+Down work without this, because Option with an
arrow key types no character.

### Copy text

Drag across the chat to select text, double-click to select a word, or
triple-click to select a whole message. honk copies the selection to the
clipboard when you let go of the mouse button, and the status line says
"Copied". A selection of several messages copies one line per message, like a
log:

```
14:02 <kai> 0.9.8 adds renderer-wide selection colors
14:03 <kai> nice
```

Over SSH, honk sends the text to your terminal (OSC 52), and the status line
says "Sent to the terminal clipboard". Some terminals ignore it: in iTerm2,
turn on "Applications in terminal may access clipboard" (Settings > General >
Selection). Inside tmux, set `allow-passthrough` as for
[notifications](#notifications).

honk uses the mouse, so your terminal does not select text on its own. To use
the terminal's own selection, hold a key while you drag: Shift in most
terminals, Option in iTerm2, Fn in Terminal.app.

### What honk does not do yet

- Run on Windows.
- Save logs. Scrollback is gone when you quit. A bouncer, or a network with
  chat history, keeps it for you.
- Ignore a user.
- Moderation commands such as `/kick`, `/ban` and `/mode`. Send them with
  `/raw` for now, such as `/raw KICK #channel nick`.
- Connect to IRC through a proxy. Only `honk upgrade` and the update check use
  `HTTPS_PROXY`.
- DCC file transfers, scripts and plugins.

honk also does not answer CTCP requests such as VERSION, TIME and PING, and
this is on purpose. Many requests at once would make honk send many replies,
and the server would disconnect it for flooding. TIME would also tell others
your local time. `/me` and the connection keepalive still work.

Missing something you need?
[Open an issue](https://github.com/agustingianni/honk/issues).

## Configuration

To connect to several servers at startup, create a config file. honk reads the
first one it finds:

1. the file given with `--config`
2. `./honk.json`
3. `~/.config/honk/config.json`

Start from [`honk.example.json`](honk.example.json):

```sh
mkdir -p ~/.config/honk
curl -fL -o ~/.config/honk/config.json \
  https://raw.githubusercontent.com/agustingianni/honk/main/honk.example.json
```

Each server takes `host`, `nick`, and optionally `port`, `tls`, `channels`,
`username`, `realname`, `password`, `serverPassword`, `authMethod`
(`sasl`, `saslExternal` or `NickServ`) and `autoConnect`.

### Notifications

When someone mentions your nick or sends you a DM, honk shows a desktop
notification. It does not notify for the buffer on screen while the terminal
window has focus, and it sends at most one notification per buffer every 10
seconds.

honk asks your terminal to show the notification, so it works over SSH too: the
notification appears on the computer you are sitting at. Terminals that support
it include iTerm2, Ghostty, WezTerm, kitty, foot, GNOME Terminal and other VTE
terminals, and Windows Terminal. In other terminals, honk shows no notification.

Inside tmux, let the notification through to the outer terminal:

```sh
# ~/.tmux.conf
set -g allow-passthrough all
```

With `on` instead of `all`, tmux passes notifications only while honk's window
is on screen, so a mention that arrives while you are in another window shows
nothing. Either value lets any program in a pane send escape sequences
straight to your terminal.

honk then asks tmux which terminal it runs in, and sends the notification that
terminal shows. If tmux blocks notifications, or honk does not know the
terminal, honk says so in `*status`.

Inside zellij, notifications work with no setup, also from a hidden tab.

Where honk can't find out the terminal, name the kind of notification in the
config file: `"osc777"` for Ghostty, WezTerm and VTE terminals, `"osc9"` for
iTerm2, or `"osc99"` for kitty and foot. You need this inside GNU screen, and
when you run honk on an SSH host from inside a tmux on your own computer:

```json
{ "notifications": "osc777", "servers": [] }
```

mosh does not pass notifications through, so honk can't show them over mosh.

To turn notifications off, add this to the top level of the config file:

```json
{ "notifications": false, "servers": [] }
```

### Themes

To choose a color theme, press Ctrl+K and type `theme`, or pick
"Preferences: Color Theme..." from the `>` actions. Up and Down show each theme
on the whole screen, Enter keeps it, and Esc goes back to the theme you had.
honk saves the theme in the config file it read, or creates
`~/.config/honk/config.json` if there was none. It changes only the `theme`
line and leaves the rest of the file as it was.

You can also set the theme yourself at the top level of the config file, or for
one run with `--theme`:

```json
{ "theme": "catppuccin-mocha", "servers": [] }
```

The default is `tokyo-night`. honk also has more than 60 built-in themes from
[Tinted Theming](https://github.com/tinted-theming/schemes), such as `nord`,
`dracula` and `gruvbox-dark`.
[src/themes/SOURCE.md](src/themes/SOURCE.md) lists all of them, with their
authors. If you write a name honk does not know, it uses `tokyo-night` and lists
the valid names in `*status`.

To add a theme, put any Base16 or Base24 scheme file from that collection in
`~/.config/honk/themes/`. The file name is the theme's name, so
`~/.config/honk/themes/kanagawa.yaml` is `"theme": "kanagawa"`. honk skips a
file whose text would be hard to read on its background, and says why in
`*status`.

### Mouse

honk uses the mouse: you can click a channel, a nick, a link or an omnibox
row, and scroll the chat with the wheel. While honk has the mouse, a plain drag
does not select text in the terminal. Hold a key while you drag instead: Shift
in most terminals, Option in iTerm2, or Fn in Terminal.app.

To leave the mouse to the terminal, add this to the top level of the config
file, or run `honk --no-mouse` for one run:

```json
{ "mouse": false, "servers": [] }
```

Then a plain drag selects text, the terminal's copy and search work, and tmux
copy mode works on honk's pane. These stop working:

- Clicking a channel in the sidebar, a nick in the user list, a row in the
  omnibox, a nick, channel or link in the chat or the topic, and the "new
  messages below" bar.
- The hand pointer over things you can click.
- Scrolling the chat with the wheel. Use PageUp and PageDown, or Shift+Up and
  Shift+Down. Some terminals turn the wheel into Up and Down keys in
  full-screen programs, so the wheel walks through the lines you sent instead.
  Scroll back down to get your unsent text back.

### Emoji that break the layout

Terminals do not agree on how many columns some emoji take. A family emoji
such as 👨‍👩‍👧‍👦 takes 2 columns in Ghostty and 8 in Terminal.app. honk asks
the terminal at startup and measures text the same way. If emoji still leave
marks on the screen or push text out of line, tell honk to count each code
point on its own:

```sh
OPENTUI_FORCE_WCWIDTH=1 honk
```

`OPENTUI_FORCE_UNICODE=1` does the opposite, for a terminal that keeps an
emoji sequence together but that honk does not recognize.

## Website

The website is the plain HTML in `site/`. A push to `main` that changes
`site/` publishes it to https://agustingianni.github.io/honk/ through the
`pages` workflow. `site/install.sh` is the install script above.

The recording on the website comes from `scripts/demo.tape`. To record it
again after a UI change, install [VHS](https://github.com/charmbracelet/vhs)
and run `bun run record-demo`. It writes `site/demo.mp4`, `site/demo.webm`
and `site/demo.png`.

## Development

```sh
bun install
bun run dev         # run with hot reload
bun run demo        # run the offline demo
bun run typecheck
bun run build       # binary for this machine in dist/honk
bun run release     # binaries for every platform in dist/
```

The built-in themes are listed in `src/themes/catalog.json`. To choose them by
looking at each one in the demo, run `bun run review-themes` (y keeps a theme, n
leaves it out). After you edit `catalog.json` by hand, run
`bun run fetch-themes`. Both commands rewrite `src/themes/schemes/`,
`bundled.ts` and `SOURCE.md`; commit those files.

## Testing on Linux

`scripts/test-linux.sh` runs the Linux binaries and `install.sh` in Docker, on
Alpine, Debian, Ubuntu, Fedora and Arch Linux, for x64 and arm64. In each
container it installs honk with `install.sh` and runs `honk --demo`.

```sh
bun run release
sh scripts/test-linux.sh               # every distro
sh scripts/test-linux.sh alpine:3.20   # one image
```

## Releasing

[release-please](https://github.com/googleapis/release-please) keeps a pull
request open, "chore(main): release 0.2.0", that sets the next version in
`package.json` and adds its section to `CHANGELOG.md`. It writes both from the
commit messages, which follow [Conventional Commits](https://www.conventionalcommits.org):
`feat:` bumps the minor version, `fix:` the patch version. See AGENTS.md.

To release, edit the changelog in that pull request if you like, and merge it.
The release-please workflow then tags the merge commit, builds the binaries,
runs `scripts/test-linux.sh` on an x64 and an arm64 runner, and only if every
distro passes, signs the binaries, attaches them to the GitHub release, and
publishes it. Until then the release is a draft, so `install.sh` and the update
check don't see it.

## License

[MIT](LICENSE)
