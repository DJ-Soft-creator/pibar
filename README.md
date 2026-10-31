# PiBar

Desktop GUI for the [Pi coding agent](https://pi.dev): sessions on the left, chat in the middle, Markdown files on the
right, plus a quick bar you open from anywhere with a double tap.
Built with Tauri 2 (Rust core + web UI); runs on macOS, Linux and Windows.

[Deutsch](README.de.md) · [Contributing](CONTRIBUTING.md) · [Codemap](docs/CODEMAP.md) · MIT License

> Status: prototype. macOS is the main target; Linux and Windows build, but double tap, area screenshots and OCR are
> macOS only so far.

## Features

- Chat with Pi, streamed live, Markdown and code highlighting
- Choose model and thinking level (Pi stores both per session)
- Tool calls and thinking as collapsible cards, can be hidden in the toolbar
- Stop and steer while Pi is working
- Sessions on the left, grouped by host: start, open, load history, several in parallel
- **Close sessions** (× on hover or ⌘W); the Pi process ends, the session file stays
- **Reminders**: ⏰ on a session → in 1 h, 3 h, this evening, tomorrow, next week or a custom time, with a note.
  Due reminders show at the top left and as a system notification; a click reopens the session
- Hosts: local and over SSH (uses `~/.ssh/config` and the ssh-agent)
- Right: folders of the session; create, read, edit, preview and save `.md` files (⌘S)
- Tokens and cost per session in the header
- Collapsible side panels: header buttons, ⌘B (left), ⌥⌘B (right)
- Host switcher at the top left: "All / Local / other hosts"; hosts collapsible in "All"
- **Quick bar**: double tap ⌥⌥ (macOS, key selectable) or shortcut ⌥⇧Space (changeable in ⚙), floating bar
  - Target: current session, new session on a host or one of the recent sessions
  - Model and thinking level, minimal
  - Screenshot: camera icon or ⌘⇧2 = drag an area, ⇧-click = whole screen
  - Send the screenshot as **image**, **text (OCR)** or **both**
  - Movable; the position is remembered
- Menu bar icon: open PiBar, quick bar, quit. Closing the window hides it; the hotkey stays active
- **Languages**: English and German, automatic from the system language or set in ⚙

Not yet: short answers directly in the bar, J-Tracker, herdr.

### macOS permissions for the quick bar

- **Screen Recording**: macOS asks on the first screenshot. In development mode the permission belongs to the terminal
  you start `npm run dev:app` from. System Settings → Privacy & Security → Screen Recording.
- **Input Monitoring** (for the double tap): macOS asks on first start. In development mode it belongs to the terminal.
  System Settings → Privacy & Security → Input Monitoring. Restart PiBar afterwards.
- **OCR** uses Apple's text recognition (Vision). The first time, PiBar builds a small helper with the Xcode tools; this
  takes 20–40 seconds once.

## One-time setup (macOS)

```bash
# 1. Xcode Command Line Tools (full Xcode is not needed)
xcode-select --install

# 2. Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 3. Node.js 20+ (e.g. from nodejs.org or: brew install node)

# 4. Pi
npm install -g @earendil-works/pi-coding-agent
pi            # start once and set up a provider / API key
```

For a server over SSH (example alias `my-server` in `~/.ssh/config`): install and set up Pi there the same way. Then
check that SSH works without a password prompt:

```bash
ssh my-server pi --version
```

## Run

```bash
git clone https://github.com/DJ-Soft-creator/pibar.git
cd pibar
npm install
npm run dev:app
```

The first start compiles the Rust part and takes a few minutes; after that it is quick.

Build the app (`.app` and `.dmg` in `src-tauri/target/release/bundle/`):

```bash
npm run tauri build
```

## Hosts

Gear icon at the top right. "Local" is preset; add more with "+ Add host" (type SSH, alias from `~/.ssh/config`).

| Field | Meaning |
| --- | --- |
| SSH host / alias | Entry from `~/.ssh/config` or a host name |
| Pi command | Default `pi`. If Pi is not found: enter the full path, e.g. `/opt/homebrew/bin/pi` |
| Default folder | Preselected folder for new sessions |

"Test connection" shows the host's Pi version.

## Testing without an API key

`dev/fake-pi.mjs` simulates Pi (streaming, thinking, tool call, model list). Enter it as the Pi command of a host:

```
node /full/path/to/pibar/dev/fake-pi.mjs
```

## Architecture and contributing

- [Codemap](docs/CODEMAP.md): structure, flows, "where do I change what?", with checked code references
- [Architecture decisions](docs/adr/README.md)
- [Contributing](CONTRIBUTING.md): setup, `npm run check`, workflow, rules

In short: for each open session the app starts `pi --mode rpc` in the working folder, locally or via `ssh <host>`.
Commands and events flow as JSON lines over stdin/stdout. Nothing but Pi needs to be installed on the server.

## License

[MIT](https://github.com/DJ-Soft-creator/pibar/blob/main/LICENSE)
