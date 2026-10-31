# PiBar

Desktop GUI for the [Pi coding agent](https://pi.dev): sessions on the left, chat in the middle, Markdown files on the
right, plus a quick bar you open from anywhere with a double tap.
Built with Tauri 2 (Rust core + web UI); runs on macOS, Linux and Windows.

**Version 1.4.0** · [Deutsch](README.de.md) · [Contributing](CONTRIBUTING.md) · [Codemap](docs/CODEMAP.md) · MIT
License

> Status: prototype. macOS is the main target; Linux and Windows build, but double tap, area screenshots and OCR are
> macOS only so far.

## Screenshots

![Main window: sessions in coloured groups, chat, file tree with editor](docs/screenshots/main-window.jpg)

![Quick bar: opens anywhere with a double tap](docs/screenshots/quick-bar.jpg)

## Features

### Chat

- Chat with Pi, streamed live, Markdown and code highlighting; stop and steer while Pi is working
- Model and thinking level per session, or a saved preset for both
- **View** (header): _Natural_ (answers only), _Technical_ (thinking and tool calls as small collapsed cards, default)
  or _Debug_ (cards open, tool output live)
- **Answer style** (header): short, normal, or as short as possible with technical details
- **Skills and commands**: type `/` in the input (or click `/`) for the session's skills, prompt templates and
  extension commands
- **Earlier messages**: under each own message – _edit and resend_ or _run again from here_ (both start a new
  branch from that point; the original session stays as it is), _use as new message_ or _copy_
- **Default model** for new sessions: star in the header (takes the current session's model and thinking level or
  preset) or Settings → General
- **Token statistics**: tokens, cost and speed in the header; hover for input/output/cache tokens, tokens per second,
  time to first token and context use

### Voice

- **Dictate** with the microphone button in the main window and the quick bar: OpenAI-compatible API (OpenAI, Groq,
  local whisper servers) or a local command such as whisper.cpp
- **Improve text** with a second LLM and your own prompt (OpenAI-compatible: OpenAI, Ollama, LM Studio …), by button
  or automatically after dictation
- **Read aloud**: speaker button on every answer, system voice or API; optionally automatic for all answers or only
  for answers to quick bar messages

### Sessions

- Left column grouped by host (local and SSH); start, open, load history, several sessions in parallel
- **Organise** by right click or `⋯`: rename (also F2), pin to the top, colour, move into coloured, collapsible groups
- **Drag & drop** sessions onto a group, or onto the zones under the list (pin, no group, new group)
- **Multi-select** with ⌘-click and ⇧-click: move, colour, pin, close or delete several sessions at once (bar at the
  bottom or right click)
- **Delete** sessions (right click, bar or ⌫) after a confirmation listing them; the session files on the host are
  removed
- **Reminders**: in 1 h, 3 h, this evening, tomorrow, next week or a custom time, with a note; due reminders show at
  the top left and as a system notification
- **Close** (× on hover or ⌘W): the Pi process ends, the session file stays
- Host switcher "All / Local / other hosts"

### Files

- Right column: the session's folders as a tree; create files and folders (`+`), read, edit, preview and save `.md`
  files (⌘S)
- Draggable divider between tree and editor; folders that do not exist on the host can be created with one click
- Optional **Git status** (Settings → General): for the session folder and for repositories in its subfolders the
  branch, commits not pushed (↑) or to pull (↓) and changes; a small letter at changed files (M, A, U, D)

### Layout

- Light, dark or automatic colour scheme
- Side panels: resize by dragging the edge (double click: default width), hide with ⌘B / ⌥⌘B
- Works in half a screen: in narrow windows the side panels float over the chat
- Menu bar icon: open PiBar, quick bar, quit; closing the window hides it, the hotkey stays active
- English and German, automatic from the system language or set in the settings

### Quick bar

- Double tap ⌥⌥ (macOS, key selectable) or shortcut ⌥⇧Space (changeable in the settings)
- Wide input line; target below: current session, new session on a host, pinned or recent sessions
- Preset or model and thinking level, minimal
- Microphone and "improve" buttons (when set up in the settings)
- Screenshot: camera icon or ⌘⇧2 = drag an area, ⇧-click = whole screen; send as **image**, **text (OCR)** or **both**
- Movable; the position is remembered

Not yet: short answers directly in the bar, J-Tracker, herdr.

## Voice settings

Gear icon → **Voice**. Every part is optional.

| Part | Choices |
| --- | --- |
| Dictation | Off · OpenAI-compatible API (base URL, key, model e.g. `whisper-1`, language) · local command with `{file}` |
| Read aloud | System voice (optional voice name) · OpenAI-compatible API (model e.g. `gpt-4o-mini-tts`, voice) |
| Text improvement | Base URL, key, model and prompt (empty = built-in prompt); "improve automatically after dictation" |

API keys are stored only in the local settings file of the app, never in the repository. Requests go through `curl`;
the key is passed on stdin, not on the command line.

## macOS permissions

- **Local Network**: needed when Pi talks to a model server or host in your network. If chats fail with
  "Connection error" after installing the app: System Settings → Privacy & Security → Local Network → enable PiBar,
  then restart PiBar.
- **Microphone** (dictation): macOS asks on the first recording. System Settings → Privacy & Security → Microphone.
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

## Install as an app (macOS)

```bash
git clone https://github.com/DJ-Soft-creator/pibar.git
cd pibar
npm install
npm run app:install
```

`app:install` installs the dependencies, builds the release version, quits a running PiBar, copies `PiBar.app` to `/Applications` and starts it.
Run it again after `git pull` to update. Settings, hosts and groups stay (they live in the app's config folder).
macOS asks once more for microphone, screen recording and input monitoring, now for PiBar itself instead of the
terminal. To start PiBar at login: System Settings → General → Login Items → add PiBar.

Only build without installing: `npm run app:build` (`.app` in `src-tauri/target/release/bundle/macos/`); with a
`.dmg` as well: `npm run tauri build`.

## Development mode

```bash
npm run dev:app
```

Runs from the terminal with live reload of the UI. The first start compiles the Rust part and takes a few minutes.
Quit the installed app first, otherwise both register the same hotkey.

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
