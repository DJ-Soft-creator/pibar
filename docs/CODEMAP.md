# Codemap

Map of the code: where things live, how the parts work together and where to start for a change.
Written for humans and AI assistants alike.

All code references have the form `` [`Symbol`](path/file) ``, e.g. [`PiManager::open`](../src-tauri/src/pi.rs), and are
checked in CI by [`check-codemap.mjs`](../scripts/check-codemap.mjs) (file exists, symbol is defined, every source file
is mentioned). `npm run check:codemap -- --print` lists all references with line numbers.

## Overview

PiBar is a [Tauri 2](https://v2.tauri.app) app: a **Rust core** (processes, SSH, files, hotkeys, screenshots) and a
**web UI** in TypeScript without a framework. Pi itself runs unchanged in RPC mode (`pi --mode rpc`, JSON lines over
stdin/stdout), locally or over SSH on a server.

```mermaid
flowchart LR
  subgraph UI["UI (TypeScript)"]
    Main["Main window<br/>src/main/"]
    Quick["Quick bar<br/>src/quick/"]
  end
  subgraph Core["Rust core (src-tauri/src/)"]
    Cmds["Tauri commands<br/>lib.rs"]
    Pi["Pi processes<br/>pi.rs"]
    Exec["local / SSH<br/>hostexec.rs"]
    QK["Hotkey, window,<br/>screenshot, OCR<br/>quick.rs, doubletap.rs"]
  end
  Host["Host: pi --mode rpc<br/>+ session files<br/>+ Markdown folders"]

  Main -- "invoke()" --> Cmds
  Quick -- "invoke()" --> Cmds
  Quick -- "event quick-submit" --> Main
  Cmds --> Pi --> Exec --> Host
  Cmds --> QK
  Pi -- "event pi-event / pi-exit" --> Main
```

## Directories

| Path | Contents |
| --- | --- |
| `index.html`, `quick.html` | The two windows: main window and quick bar |
| `src/main/` | Main window: sessions left, chat middle, files right, settings, reminders |
| `src/quick/` | Quick bar (hotkey window) |
| `src/shared/` | Shared: Rust interface, DOM helpers, translations, pure formatters (with tests) |
| `src-tauri/src/` | Rust core, one module per responsibility |
| `src-tauri/capabilities/` | Tauri permissions of the windows |
| `dev/` | Development helpers, e.g. a fake Pi without an API key |
| `scripts/` | Check scripts for CI |
| `docs/` | This codemap and architecture decisions ([`adr/`](adr/)) |

## Modules

### Rust core (`src-tauri/src/`)

| File | Responsibility | Key symbols |
| --- | --- | --- |
| [`main.rs`](../src-tauri/src/main.rs) | Program start | [`main`](../src-tauri/src/main.rs) |
| [`gitlog.rs`](../src-tauri/src/gitlog.rs) | Git history, read only: commits of a repository or a file, files of a commit, diff of a file | [`gitlog::log`](../src-tauri/src/gitlog.rs), [`gitlog::commit`](../src-tauri/src/gitlog.rs), [`gitlog::diff`](../src-tauri/src/gitlog.rs), [`parse_log`](../src-tauri/src/gitlog.rs) |
| [`lib.rs`](../src-tauri/src/lib.rs) | All Tauri commands, tray, window events, startup | [`run`](../src-tauri/src/lib.rs), [`setup_tray`](../src-tauri/src/lib.rs), [`tray_menu`](../src-tauri/src/lib.rs), [`set_language`](../src-tauri/src/lib.rs), [`pi_close_all`](../src-tauri/src/lib.rs) |
| [`i18n.rs`](../src-tauri/src/i18n.rs) | Language of messages from Rust (errors, tray menu) | [`tr`](../src-tauri/src/i18n.rs), [`i18n::set`](../src-tauri/src/i18n.rs) |
| [`config.rs`](../src-tauri/src/config.rs) | Settings as JSON in the app config folder; kept in memory, saved atomically, a damaged file is backed up ([`read_from`](../src-tauri/src/config.rs), [`write_atomic`](../src-tauri/src/config.rs), [`take_load_error`](../src-tauri/src/config.rs)) | [`AppConfig`](../src-tauri/src/config.rs), [`HostCfg`](../src-tauri/src/config.rs), [`UiPrefs`](../src-tauri/src/config.rs), [`VoiceCfg`](../src-tauri/src/config.rs), [`SessionMeta`](../src-tauri/src/config.rs), [`SessionGroup`](../src-tauri/src/config.rs), [`Reminder`](../src-tauri/src/config.rs), [`ModelPreset`](../src-tauri/src/config.rs), [`load`](../src-tauri/src/config.rs), [`find_host`](../src-tauri/src/config.rs) |
| [`hostexec.rs`](../src-tauri/src/hostexec.rs) | Shell commands locally or over SSH; quoting | [`run_shell`](../src-tauri/src/hostexec.rs), [`spawn_pi`](../src-tauri/src/hostexec.rs), [`user_env`](../src-tauri/src/hostexec.rs), [`shell_command`](../src-tauri/src/hostexec.rs), [`ssh_args`](../src-tauri/src/hostexec.rs), [`sq`](../src-tauri/src/hostexec.rs), [`shell_path`](../src-tauri/src/hostexec.rs) |
| [`pi.rs`](../src-tauri/src/pi.rs) | One Pi process per open session, match RPC responses, forward events; also follows the log of a run in the background (same events); waiting calls fail at once when Pi ends, ended processes are reaped | [`PiManager`](../src-tauri/src/pi.rs), [`pump`](../src-tauri/src/pi.rs), [`PiManager::open`](../src-tauri/src/pi.rs), [`PiManager::open_follow`](../src-tauri/src/pi.rs), [`PiManager::send`](../src-tauri/src/pi.rs), [`PiManager::close`](../src-tauri/src/pi.rs) |
| [`terminal.rs`](../src-tauri/src/terminal.rs) | Interactive terminal: one shell per tab in a pty (local login shell or `ssh -tt`), output as base64 `term-output` events, keys and size from the UI | [`TermManager`](../src-tauri/src/terminal.rs), [`TermManager::open`](../src-tauri/src/terminal.rs), [`TermManager::write`](../src-tauri/src/terminal.rs), [`TermManager::resize`](../src-tauri/src/terminal.rs), [`shell_command`](../src-tauri/src/terminal.rs), [`expand`](../src-tauri/src/terminal.rs) |
| [`bg.rs`](../src-tauri/src/bg.rs) | Runs in the background: Pi started detached (`setsid`/`nohup`) on the host with `pi --mode json`, its log and pid file below `~/.pibar`; ask whether it still runs and stop it | [`bg::start`](../src-tauri/src/bg.rs), [`bg::running`](../src-tauri/src/bg.rs), [`bg::stop`](../src-tauri/src/bg.rs), [`follow_script`](../src-tauri/src/bg.rs), [`paths`](../src-tauri/src/bg.rs), [`hash`](../src-tauri/src/bg.rs) |
| [`sessions.rs`](../src-tauri/src/sessions.rs) | Read the session list from `~/.pi/agent/sessions` (incl. `parent` of a branch); user messages per file for the versions of a message; delete session files (only there) | [`list`](../src-tauri/src/sessions.rs), [`SessionInfo`](../src-tauri/src/sessions.rs), [`outlines`](../src-tauri/src/sessions.rs), [`parse_outlines`](../src-tauri/src/sessions.rs), [`SessionOutline`](../src-tauri/src/sessions.rs), [`first_text`](../src-tauri/src/sessions.rs), [`sessions::delete`](../src-tauri/src/sessions.rs), [`is_session_file`](../src-tauri/src/sessions.rs) |
| [`models.rs`](../src-tauri/src/models.rs) | Model list via `pi --list-models` (no session needed) | [`models::list`](../src-tauri/src/models.rs), [`models::parse`](../src-tauri/src/models.rs) |
| [`files.rs`](../src-tauri/src/files.rs) | List all files of the session folders (or only documents and images, `DOCS_FILTER`); read and write text files (binary and >2 MB refused, paths checked by [`check_path_shape`](../src-tauri/src/files.rs)); images read only ([`read_image`](../src-tauri/src/files.rs)); flag and create missing folders; optional Git status | [`files::list`](../src-tauri/src/files.rs), [`parse_listing`](../src-tauri/src/files.rs), [`parse_git`](../src-tauri/src/files.rs), [`GitInfo`](../src-tauri/src/files.rs), [`files::write`](../src-tauri/src/files.rs), [`create_dir`](../src-tauri/src/files.rs), [`FolderListing`](../src-tauri/src/files.rs), [`list_dirs`](../src-tauri/src/files.rs), [`read_head`](../src-tauri/src/files.rs) |
| [`quick.rs`](../src-tauri/src/quick.rs) | Quick bar: show/hide window, size, position, hotkey, screenshot, OCR | [`toggle_quick`](../src-tauri/src/quick.rs), [`hide_quick`](../src-tauri/src/quick.rs), [`resize_quick`](../src-tauri/src/quick.rs), [`register_hotkey`](../src-tauri/src/quick.rs), [`hotkey_status`](../src-tauri/src/quick.rs), [`capture`](../src-tauri/src/quick.rs), [`ocr`](../src-tauri/src/quick.rs), [`mac_ocr_helper`](../src-tauri/src/quick.rs) |
| [`disclaim.rs`](../src-tauri/src/disclaim.rs) | macOS: child processes (shell, SSH, curl) run as their own responsible process, so the "Local Network" block of the self-built app does not hit Pi | [`disclaim::command`](../src-tauri/src/disclaim.rs), [`run_if_requested`](../src-tauri/src/disclaim.rs) |
| [`diag.rs`](../src-tauri/src/diag.rs) | Diagnosis report for chat errors: Pi/Node, environment (secrets hidden), Pi's model config, reachability of model servers | [`diag::run`](../src-tauri/src/diag.rs) |
| [`voice.rs`](../src-tauri/src/voice.rs) | Speech to text, text to speech, text improvement via OpenAI-compatible APIs (`curl`) or a local command | [`transcribe`](../src-tauri/src/voice.rs), [`speak`](../src-tauri/src/voice.rs), [`improve`](../src-tauri/src/voice.rs), [`api_url`](../src-tauri/src/voice.rs), [`strip_think`](../src-tauri/src/voice.rs) |
| [`doubletap.rs`](../src-tauri/src/doubletap.rs) | Double tap on a modifier key (macOS, CGEventTap) | [`Detector`](../src-tauri/src/doubletap.rs), [`Detector::on_flags`](../src-tauri/src/doubletap.rs), [`TapKey`](../src-tauri/src/doubletap.rs), [`start`](../src-tauri/src/doubletap.rs) |

### Main window (`src/main/`)

| File | Responsibility | Key symbols |
| --- | --- | --- |
| [`index.ts`](../src/main/index.ts) | Entry: load settings and language, wire modules, dispatch Rust events | [`init`](../src/main/index.ts) |
| [`state.ts`](../src/main/state.ts) | Shared state (settings, sessions, active session) | [`state`](../src/main/state.ts), [`saveConfig`](../src/main/state.ts) |
| [`sessions.ts`](../src/main/sessions.ts) | Left column; open, activate and close sessions; "New session"; remembers the session per host | [`renderHosts`](../src/main/sessions.ts), [`openSession`](../src/main/sessions.ts), [`activate`](../src/main/sessions.ts), [`closeSession`](../src/main/sessions.ts), [`loadSessions`](../src/main/sessions.ts), [`newSessionDialog`](../src/main/sessions.ts) |
| [`reminders.ts`](../src/main/reminders.ts) | Reminders on sessions: dialog, list at the top left, notifications | [`reminderDialog`](../src/main/reminders.ts), [`presetTimes`](../src/main/reminders.ts), [`renderReminders`](../src/main/reminders.ts), [`openReminder`](../src/main/reminders.ts), [`startReminderClock`](../src/main/reminders.ts) |
| [`sessionTab.ts`](../src/main/sessionTab.ts) | One session: send Pi commands, render Pi events as chat, count tokens and speed, load skills/commands, send a message as a detached run and follow it | [`SessionTab`](../src/main/sessionTab.ts), [`SessionTab.start`](../src/main/sessionTab.ts), [`SessionTab.send`](../src/main/sessionTab.ts), [`SessionTab.onEvent`](../src/main/sessionTab.ts), [`SessionTab.loadHistory`](../src/main/sessionTab.ts), [`SessionTab.refreshModels`](../src/main/sessionTab.ts), [`SessionTab.measure`](../src/main/sessionTab.ts), [`TabStats`](../src/main/sessionTab.ts), [`SessionTab.close`](../src/main/sessionTab.ts) |
| [`branchNav.ts`](../src/main/branchNav.ts) | Versions of a message: "‹ 2/3 ›" under own messages that exist in other branches | [`refreshBranches`](../src/main/branchNav.ts), [`SessionTab.showBranches`](../src/main/sessionTab.ts), [`SessionTab.scrollToUser`](../src/main/sessionTab.ts), [`switchBranch`](../src/main/sessions.ts) |
| [`answerDialog.ts`](../src/main/answerDialog.ts) | Questions to the user: choice questions at the end of an answer (tick options, own answer) and Pi's own dialogs (extension UI) | [`questionDialog`](../src/main/answerDialog.ts), [`uiRequest`](../src/main/answerDialog.ts), [`openQuestions`](../src/main/sessions.ts) |
| [`gitHistory.ts`](../src/main/gitHistory.ts) | Git history dialog: commits of a repository (Git line in the tree) or of a file (right click), changed files, diff | [`repoHistory`](../src/main/gitHistory.ts), [`fileHistory`](../src/main/gitHistory.ts) |
| [`autoScroll.ts`](../src/main/autoScroll.ts) | Auto scroll of the chat, modes automatic (pauses on scrolling up), always (forced) and off; entries for the view menu and the setting; keeps the chat still while the input changes height | [`wireAutoScroll`](../src/main/autoScroll.ts), [`answerStarted`](../src/main/autoScroll.ts), [`setScrollMode`](../src/main/autoScroll.ts), [`jumpToEnd`](../src/main/autoScroll.ts), [`keepScroll`](../src/main/autoScroll.ts) |
| [`shortcuts.ts`](../src/main/shortcuts.ts) | Keyboard shortcuts of the main window and their overview (⌘/) | [`wireShortcuts`](../src/main/shortcuts.ts), [`shortcutsDialog`](../src/main/shortcuts.ts) |
| [`chatView.ts`](../src/main/chatView.ts) | Header (preset, model, thinking, chat view, answer style, theme), chat area, input, send menu (also runs in the background), shortcuts | [`renderToolbar`](../src/main/chatView.ts), [`wireChatView`](../src/main/chatView.ts), [`applyUiPrefs`](../src/main/chatView.ts), [`setTheme`](../src/main/chatView.ts), [`showEmpty`](../src/main/chatView.ts) |
| [`layout.ts`](../src/main/layout.ts) | Side panels: show/hide, drag width, divider between file tree and editor, float over the chat in narrow windows | [`applyLayout`](../src/main/layout.ts), [`togglePanel`](../src/main/layout.ts), [`applySplit`](../src/main/layout.ts), [`wireLayout`](../src/main/layout.ts) |
| [`menu.ts`](../src/main/menu.ts) | Popup menus: header dropdowns with descriptions, "+" menus, context menus (headings, colour swatches) | [`openMenu`](../src/main/menu.ts), [`closeMenu`](../src/main/menu.ts), [`MenuEntry`](../src/main/menu.ts), [`COLORS`](../src/main/menu.ts) |
| [`sessionGroups.ts`](../src/main/sessionGroups.ts) | Own session names, pins, colours, coloured groups; context menus of sessions and groups | [`sessionMenu`](../src/main/sessionGroups.ts), [`groupMenu`](../src/main/sessionGroups.ts), [`renameDialog`](../src/main/sessionGroups.ts), [`setMeta`](../src/main/sessionGroups.ts), [`displayTitle`](../src/main/sessionGroups.ts) |
| [`sessionSelect.ts`](../src/main/sessionSelect.ts) | Multi-selection (⌘/⇧-click), drag & drop onto groups and drop zones, selection bar | [`selectClick`](../src/main/sessionSelect.ts), [`dragStart`](../src/main/sessionSelect.ts), [`dropTarget`](../src/main/sessionSelect.ts), [`renderSelectionBar`](../src/main/sessionSelect.ts), [`wireSessionSelect`](../src/main/sessionSelect.ts) |
| [`diagnose.ts`](../src/main/diagnose.ts) | Diagnosis dialog: error, Pi's stderr, hints for typical causes, report; tested in `diagnose.test.ts` | [`diagnoseDialog`](../src/main/diagnose.ts), [`diagnoseHints`](../src/main/diagnose.ts) |
| [`voiceSettings.ts`](../src/main/voiceSettings.ts) | Settings section "Voice": dictation, read aloud, text improvement | [`voiceEditor`](../src/main/voiceSettings.ts) |
| [`composerTools.ts`](../src/main/composerTools.ts) | Tool dock at the input (fades in near the mouse): attach files, screenshot, skills, tools of a session; attachment chips | [`wireComposerTools`](../src/main/composerTools.ts), [`addFiles`](../src/main/composerTools.ts), [`takeAttachments`](../src/main/composerTools.ts), [`swapAttachments`](../src/main/composerTools.ts), [`renderDock`](../src/main/composerTools.ts) |
| [`slashMenu.ts`](../src/main/slashMenu.ts) | "/" menu in the input: skills, prompt templates, extension commands | [`wireSlashMenu`](../src/main/slashMenu.ts), [`slashKey`](../src/main/slashMenu.ts), [`commandText`](../src/main/slashMenu.ts) |
| [`usageStats.ts`](../src/main/usageStats.ts) | Status line under the input like Pi's footer, and its hover panel (counters, speed, context) | [`renderUsage`](../src/main/usageStats.ts), [`wireUsage`](../src/main/usageStats.ts) |
| [`activity.ts`](../src/main/activity.ts) | Working / finished sessions: marks in the list, counters at hosts, Dock badge, notification | [`markSettled`](../src/main/activity.ts), [`markSeen`](../src/main/activity.ts), [`sessionMark`](../src/main/activity.ts), [`hostMarks`](../src/main/activity.ts), [`updateBadge`](../src/main/activity.ts) |
| [`cleanup.ts`](../src/main/cleanup.ts) | "Tidy up": move many sessions into the collapsed "Archive" group, with undo | [`cleanupDialog`](../src/main/cleanup.ts), [`cleanupCandidates`](../src/main/cleanup.ts), [`archive`](../src/main/cleanup.ts) |
| [`folderPicker.ts`](../src/main/folderPicker.ts) | Folder picker for local and SSH hosts (new session, add folder) | [`pickFolder`](../src/main/folderPicker.ts), [`folderField`](../src/main/folderPicker.ts), [`tildePath`](../src/main/folderPicker.ts) |
| [`files.ts`](../src/main/files.ts) | Right column: session folders as a tree, missing folders, Markdown editor | [`renderFiles`](../src/main/files.ts), [`renderTree`](../src/main/files.ts), [`treeRows`](../src/main/files.ts), [`saveEditor`](../src/main/files.ts), [`renderDiff`](../src/main/files.ts), [`folderMenu`](../src/main/files.ts), [`wireFiles`](../src/main/files.ts) |
| [`terminal.ts`](../src/main/terminal.ts) | Terminal at the bottom of the chat column (xterm.js): tabs, open/close/hide, drag height, keys and size to the Rust pty | [`wireTerminal`](../src/main/terminal.ts), [`toggleTerminal`](../src/main/terminal.ts), [`openTab`](../src/main/terminal.ts), [`closeTab`](../src/main/terminal.ts) |
| [`settings.ts`](../src/main/settings.ts) | Settings dialog: language, hotkeys, bar position, chat colours, model presets, hosts | [`settingsDialog`](../src/main/settings.ts), [`presetEditor`](../src/main/settings.ts) |
| [`colorSettings.ts`](../src/main/colorSettings.ts) | Settings section "Chat colours": profiles with hex values for thinking, tool calls, answers and own messages, one set per theme | [`colorEditor`](../src/main/colorSettings.ts) |
| [`colors.ts`](../src/main/colors.ts) | Applies the chat colours of the active session's host to `<html>` as CSS variables; follows the system theme | [`applyChatColors`](../src/main/colors.ts), [`isDark`](../src/main/colors.ts), [`wireChatColors`](../src/main/colors.ts) |
| [`quickBridge.ts`](../src/main/quickBridge.ts) | Accept messages from the quick bar | [`handleQuick`](../src/main/quickBridge.ts), [`broadcastActive`](../src/main/quickBridge.ts) |
| [`styles.css`](../src/main/styles.css) | Main window look; light/dark via CSS variables and `data-theme` on `<html>` | – |

### Quick bar (`src/quick/`) and shared code (`src/shared/`)

| File | Responsibility | Key symbols |
| --- | --- | --- |
| [`quick/index.ts`](../src/quick/index.ts) | Input, target, preset or model/thinking, attached files, screenshot/OCR, send | [`submit`](../src/quick/index.ts), [`addFiles`](../src/quick/index.ts), [`keepSession`](../src/quick/index.ts), [`takeShot`](../src/quick/index.ts), [`runOcr`](../src/quick/index.ts), [`renderTargets`](../src/quick/index.ts), [`renderPresets`](../src/quick/index.ts), [`renderModels`](../src/quick/index.ts), [`fit`](../src/quick/index.ts) |
| [`shared/api.ts`](../src/shared/api.ts) | Types and `invoke` calls into the Rust core | [`api`](../src/shared/api.ts), [`QuickSubmit`](../src/shared/api.ts), [`AppConfig`](../src/shared/api.ts), [`Reminder`](../src/shared/api.ts) |
| [`shared/piProtocol.ts`](../src/shared/piProtocol.ts) | Types of Pi's RPC protocol: events, messages, content parts, answers per command (`api.pi` returns the matching type) | [`PiEvent`](../src/shared/piProtocol.ts), [`PiMessage`](../src/shared/piProtocol.ts), [`ContentPart`](../src/shared/piProtocol.ts), [`PiRpcResults`](../src/shared/piProtocol.ts), [`PiSessionStats`](../src/shared/piProtocol.ts) |
| [`shared/branches.ts`](../src/shared/branches.ts) | Where branches part: related sessions via `parent`, versions per message by comparing entry ids (tested) | [`branchFamily`](../src/shared/branches.ts), [`branchesAt`](../src/shared/branches.ts) |
| [`shared/questions.ts`](../src/shared/questions.ts) | Find choice questions with options at the end of an answer, compose the answer message (tested) | [`findQuestions`](../src/shared/questions.ts), [`composeAnswer`](../src/shared/questions.ts) |
| [`shared/sessionOrder.ts`](../src/shared/sessionOrder.ts) | Order and sections of the session list: by last activity, creation, name or folder; sections by date or folder (tested) | [`sortRows`](../src/shared/sessionOrder.ts), [`sectionRows`](../src/shared/sessionOrder.ts), [`dateBucket`](../src/shared/sessionOrder.ts) |
| [`shared/attach.ts`](../src/shared/attach.ts) | Read attached files (main window and quick bar): images as images, text files as text | [`readAttachment`](../src/shared/attach.ts) |
| [`shared/i18n.ts`](../src/shared/i18n.ts) | Translations: English text is the key, German dictionary; tested in `i18n.test.ts` | [`t`](../src/shared/i18n.ts), [`setLang`](../src/shared/i18n.ts), [`resolveLang`](../src/shared/i18n.ts), [`translateDom`](../src/shared/i18n.ts), [`LANGUAGES`](../src/shared/i18n.ts) |
| [`shared/dom.ts`](../src/shared/dom.ts) | Element builder, Markdown (marked + DOMPurify), toasts, modals | [`h`](../src/shared/dom.ts), [`renderMarkdown`](../src/shared/dom.ts), [`openModal`](../src/shared/dom.ts) |
| [`shared/colors.ts`](../src/shared/colors.ts) | Pure chat colour logic: hex values, roles, CSS variables per theme, profile per host; tested in `colors.test.ts` | [`cleanColor`](../src/shared/colors.ts), [`colorVars`](../src/shared/colors.ts), [`profileFor`](../src/shared/colors.ts), [`cleanProfiles`](../src/shared/colors.ts), [`RoleColor`](../src/shared/colors.ts) |
| [`shared/presets.ts`](../src/shared/presets.ts) | Pure preset logic, tested in `presets.test.ts` | [`matchPreset`](../src/shared/presets.ts), [`cleanPresets`](../src/shared/presets.ts), [`splitModelKey`](../src/shared/presets.ts) |
| [`shared/diff.ts`](../src/shared/diff.ts) | Line diff for the editor's diff view, tested in `diff.test.ts` | [`diffLines`](../src/shared/diff.ts), [`hunks`](../src/shared/diff.ts), [`diffStats`](../src/shared/diff.ts) |
| [`shared/format.ts`](../src/shared/format.ts) | Pure formatters, tested in `format.test.ts` | [`shortModel`](../src/shared/format.ts), [`cleanTitle`](../src/shared/format.ts), [`withScreenText`](../src/shared/format.ts), [`withAnswerStyle`](../src/shared/format.ts), [`stripAnswerStyle`](../src/shared/format.ts), [`tokensPerSecond`](../src/shared/format.ts), [`relTime`](../src/shared/format.ts) |
| [`shared/tree.ts`](../src/shared/tree.ts) | Relative paths → folder tree, tested in `tree.test.ts` | [`buildTree`](../src/shared/tree.ts), [`countFiles`](../src/shared/tree.ts) |
| [`shared/voice.ts`](../src/shared/voice.ts) | Microphone recording, mic and improve buttons for both windows, read aloud; tested in `voice.test.ts` | [`wireVoice`](../src/shared/voice.ts), [`startRecording`](../src/shared/voice.ts), [`stopRecording`](../src/shared/voice.ts), [`speak`](../src/shared/voice.ts), [`improve`](../src/shared/voice.ts), [`DEFAULT_IMPROVE_PROMPT`](../src/shared/voice.ts) |
| [`shared/git.ts`](../src/shared/git.ts) | Git status line and file letters in the tree; tested in `git.test.ts` | [`gitLine`](../src/shared/git.ts), [`gitInline`](../src/shared/git.ts), [`gitMark`](../src/shared/git.ts), [`gitStatusFor`](../src/shared/git.ts) |
| [`shared/icons.ts`](../src/shared/icons.ts) | Line icons (SVG) instead of emoji: reminder, gear, check, more, close | [`icon`](../src/shared/icons.ts), [`iconSvg`](../src/shared/icons.ts) |
| [`shared/theme.ts`](../src/shared/theme.ts) | Colour scheme for both windows (auto / light / dark) | [`applyTheme`](../src/shared/theme.ts), [`nextTheme`](../src/shared/theme.ts) |

### Tools

| File | Purpose |
| --- | --- |
| [`dev/fake-pi.mjs`](../dev/fake-pi.mjs) | Fake Pi: simulates streaming, thinking, a tool call, `--list-models` |
| [`scripts/check-codemap.mjs`](../scripts/check-codemap.mjs) | Checks all code references in the docs |
| [`scripts/check-version.mjs`](../scripts/check-version.mjs) | Same version in package files, Tauri, Cargo and both READMEs |
| [`scripts/install-mac.sh`](../scripts/install-mac.sh) | `npm run app:install`: build the release app and install it to `/Applications` |

## Flows

### Switch the host

The host tabs at the top left filter the list ([`renderHostTabs`](../src/main/sessions.ts)). Every activation stores
the session in `ui.sessionByHost` (`rememberSession` in [`activate`](../src/main/sessions.ts), also after a session
got its file). Picking another host brings that session back ([`restoreHostSession`](../src/main/sessions.ts)): an
open tab is shown again, otherwise the file is opened with [`openSession`](../src/main/sessions.ts). "All" changes
nothing, and a session of the chosen host that is already on screen stays as it is.

### Open a session and send a message

1. Click in the left column → [`openSession`](../src/main/sessions.ts) creates a [`SessionTab`](../src/main/sessionTab.ts).
2. [`SessionTab.start`](../src/main/sessionTab.ts) calls `pi_open` → [`PiManager::open`](../src-tauri/src/pi.rs) →
   [`spawn_pi`](../src-tauri/src/hostexec.rs) starts `pi --mode rpc [--session <file>]` locally or over `ssh`.
3. A reader thread in [`PiManager::open`](../src-tauri/src/pi.rs) matches `response` lines to the waiting call
   ([`PiManager::send`](../src-tauri/src/pi.rs)) and sends everything else as event `pi-event` to the main window.
4. [`init`](../src/main/index.ts) routes `pi-event` by process handle to [`SessionTab.onEvent`](../src/main/sessionTab.ts),
   which renders text, thinking and tool calls live.
5. On `agent_settled`, [`loadSessions`](../src/main/sessions.ts) reloads the list; new sessions get their file path as
   key.

Text and attachments in the input belong to the session ([`SessionTab.draft`](../src/main/sessionTab.ts)): switching
keeps the half-typed message with its session ([`showTab`](../src/main/chatView.ts) exchanges both,
[`swapAttachments`](../src/main/composerTools.ts)), and same for the height of the input, whose measuring does not
move the chat ([`keepScroll`](../src/main/autoScroll.ts)).

### Close a session

× on a running session or ⌘W → [`closeSession`](../src/main/sessions.ts) → [`SessionTab.close`](../src/main/sessionTab.ts)
→ `pi_close` → [`PiManager::close`](../src-tauri/src/pi.rs). The session file stays and can be reopened. On reload the
main window calls [`pi_close_all`](../src-tauri/src/lib.rs) so no orphaned processes remain.

### Runs in the background

A message can be sent as a detached run on the host, so it keeps going when PiBar quits or the connection drops:
[`SessionTab.sendToBackground`](../src/main/sessionTab.ts) closes the tab's Pi process and calls `bg_start`
([`bg::start`](../src-tauri/src/bg.rs)) → `pi --session <file> --mode json --provider … --model … --thinking … "<prompt>"`
under `setsid`/`nohup`. The tab then follows the run's log ([`PiManager::open_follow`](../src-tauri/src/pi.rs)); the
events are the same as in RPC mode, so the chat renders the answer as usual. At `agent_settled` the tab closes the
follower, starts Pi again ([`SessionTab.attach`](../src/main/sessionTab.ts)) and shows the session from its file — Pi
writes the answer there anyway ([`bg::follow_script`](../src-tauri/src/bg.rs) ends with the process).

Ways to start it: one message with the send button menu (right click) or ⇧⌘↩; every message of a session with the
toggle in that menu (stored as `sessionMeta.background`, "on"/"off", [`setBackground`](../src/main/chatView.ts)); or
every session with the setting "Start sessions in the background by default" (`ui.background`). While a run goes on,
the send button stops it ([`SessionTab.stopBackground`](../src/main/sessionTab.ts) → `bg_stop` → SIGTERM).

The first message of a new session has no session file yet and goes the normal way. `sessionMeta.backgroundAt` marks
a run that is still going: opening that session checks `bg_running` and follows the run instead of starting a second
Pi process on the same file ([`openSession`](../src/main/sessions.ts)). Images, extension dialogs and steering are
foreground only.

### Reminders

[`reminderDialog`](../src/main/reminders.ts) stores a [`Reminder`](../src/shared/api.ts) in `AppConfig.reminders`
(Rust side: [`Reminder`](../src-tauri/src/config.rs)). [`startReminderClock`](../src/main/reminders.ts) checks every
30 seconds, marks due ones, shows a system notification and re-renders the list
([`renderReminders`](../src/main/reminders.ts)). A click runs [`openReminder`](../src/main/reminders.ts): remove and
open the session.

### Quick bar

1. Hotkey: [`register_hotkey`](../src-tauri/src/quick.rs) (key combination) or [`Detector::on_flags`](../src-tauri/src/doubletap.rs)
   (double tap) → [`toggle_quick`](../src-tauri/src/quick.rs) positions and shows the window.
2. The bar loads targets ([`renderTargets`](../src/quick/index.ts)) and the target host's models
   ([`models::list`](../src-tauri/src/models.rs)).
3. While typing, [`fit`](../src/quick/index.ts) grows the text field and asks [`resize_quick`](../src-tauri/src/quick.rs)
   for a new window height only when it really changes (resizing on every keystroke made typing stutter on macOS).
4. Screenshot: [`takeShot`](../src/quick/index.ts) → [`capture`](../src-tauri/src/quick.rs) (`screencapture` on macOS);
   OCR: [`runOcr`](../src/quick/index.ts) → [`ocr`](../src-tauri/src/quick.rs) (Apple Vision via
   [`mac_ocr_helper`](../src-tauri/src/quick.rs), otherwise `tesseract`).
5. [`submit`](../src/quick/index.ts) emits `quick-submit`; [`handleQuick`](../src/main/quickBridge.ts) opens the target
   session, sets model/thinking and sends the message with image and OCR text ([`withScreenText`](../src/shared/format.ts)).

### Model presets

Presets ([`ModelPreset`](../src/shared/api.ts), Rust: [`ModelPreset`](../src-tauri/src/config.rs)) live in
`AppConfig.presets` and are edited in [`presetEditor`](../src/main/settings.ts). In the header,
[`renderToolbar`](../src/main/chatView.ts) shows the preset dropdown and hides model and thinking while a preset is
chosen; "Custom" shows them again. Which preset a session shows: `SessionTab.presetId` if set, otherwise
[`matchPreset`](../src/shared/presets.ts) against the session's model and thinking level. In the quick bar,
[`renderPresets`](../src/quick/index.ts) does the same; [`submit`](../src/quick/index.ts) sends the preset's model and
thinking level plus its id, and [`handleQuick`](../src/main/quickBridge.ts) applies them.

### Files on the right

[`renderFiles`](../src/main/files.ts) asks [`files::list`](../src-tauri/src/files.rs) for the working folder and the
session's extra folders (stored in `AppConfig.sessionFolders`). [`buildTree`](../src/shared/tree.ts) turns each listing
into folders; [`renderTree`](../src/main/files.ts) draws them (open folders live in memory, so toggling does not reload).
A folder that does not exist on the host comes back with `missing: true` ([`parse_listing`](../src-tauri/src/files.rs))
and can be created ([`create_dir`](../src-tauri/src/files.rs)) or removed from the session.
The working folder of a new session and extra folders can be picked with [`pickFolder`](../src/main/folderPicker.ts),
which browses the host through [`list_dirs`](../src-tauri/src/files.rs) (same shell as Pi, so it works over SSH too).
With `ui.showTimes` each message shows its time ([`msgTime`](../src/shared/format.ts), from the `timestamp` Pi stores
with every message); the quick bar keeps its buttons on the first line and [`fit_y`](../src-tauri/src/quick.rs) moves
it up when it grows past the bottom of the screen.

Model and thinking changes go through `SessionTab.settle`: Pi handles RPC commands concurrently, so
[`send`](../src/main/sessionTab.ts) waits until a pending `set_model` is done before it sends the prompt. Each answer shows
the model that actually produced it (from the assistant message).

The header and the status line both name `tab.model`, which comes from Pi's `get_state` — never from the choice in the
dropdown. [`renderToolbar`](../src/main/chatView.ts) therefore adds the current model as an extra option when the host's
model list does not contain it (e.g. a model taken from the session file): otherwise the dropdown would fall back to its
first entry, show a model Pi does not use, and picking that entry again would not even send a `set_model`.

The editor has three modes: edit, preview and diff. [`renderDiff`](../src/main/files.ts) compares the editor text
(including unsaved changes) with the file in Git HEAD ([`read_head`](../src-tauri/src/files.rs)) or with the saved file,
using the line diff in [`diffLines`](../src/shared/diff.ts) and [`hunks`](../src/shared/diff.ts) (3 lines of context).
Folders and files of the tree can be dragged into the input or added by right click ([`folderMenu`](../src/main/files.ts),
[`addContextPath`](../src/main/composerTools.ts)). Only their paths go with the message, as a `<context>` block
([`withContext`](../src/shared/format.ts)); Pi reads them with its tools. [`splitContext`](../src/shared/format.ts) turns
the block back into chips in the chat.
With `ui.showGit` the same script also runs `git status --porcelain --branch` ([`parse_git`](../src-tauri/src/files.rs));
for the session folder's own repository and for repositories in subfolders (up to 30, depth 5). The tree shows a quiet
line under a session folder that is a repository ([`gitLine`](../src/shared/git.ts): branch, ↑ not pushed, ↓ to pull,
changes), branch and ↑/↓ next to repository folders inside the tree ([`gitInline`](../src/shared/git.ts)) and a letter
per changed file ([`gitMark`](../src/shared/git.ts)). Ahead/behind are as of the last fetch. Reading and writing use `cat` through
[`run_shell`](../src-tauri/src/hostexec.rs), locally and over SSH; [`files::write`](../src-tauri/src/files.rs) writes to a
temp file first and then renames.

### Terminal at the bottom

The button in the file panel's header or ⌘⌥J calls [`toggleTerminal`](../src/main/terminal.ts), which shows the dock at
the very bottom of the chat column (under the input and the status line) and starts a shell for the active session (host and working folder; otherwise the selected or first host
and its home folder). [`openTab`](../src/main/terminal.ts) creates an xterm.js terminal and calls `term_open` →
[`TermManager::open`](../src-tauri/src/terminal.rs): [`shell_command`](../src-tauri/src/terminal.rs) starts the login shell
locally or `ssh -tt` with a login shell in the session's folder ([`ssh_args`](../src-tauri/src/hostexec.rs)); on macOS through
[`wrap`](../src-tauri/src/disclaim.rs), so the terminal does not count as PiBar's network access. A reader thread sends the
bytes base64 encoded as `term-output` (a terminal stream is not always valid UTF-8); keys go back with `term_write`, the
window size with `term_resize`, and the end of the stream arrives as `term-exit` (the tab stays with its content until it
is closed). Dragging the handle above the dock stores its height in `ui.termHeight`; a reload closes all terminals
([`term_close_all`](../src-tauri/src/lib.rs)). The terminal shares the settings' theme colours, and the main window's
shortcuts step aside while it has the focus (only ⌘⌥J still works).

### Chat view and answer style

The header dropdowns set `ui.chatMode` and `ui.answerMode` ([`applyUiPrefs`](../src/main/chatView.ts)).
`natural` hides thinking and tool cards via CSS (`.mode-natural`) and shows an activity line while Pi works;
`technical` shows them collapsed; `debug` opens them as they appear and streams tool output (`tool_execution_update`)
into the card. The answer style is a short hint that [`SessionTab.send`](../src/main/sessionTab.ts) appends with
[`withAnswerStyle`](../src/shared/format.ts) (not for `/` commands); [`stripAnswerStyle`](../src/shared/format.ts) and
[`cleanTitle`](../src/shared/format.ts) remove it again for display.

### Chat colours

A colour profile (`AppConfig.colorProfiles`, [`ColorProfile`](../src/shared/colors.ts)) has a set of colours for the
dark and the light theme, each with background and text colour for thinking, tool calls, answers and own messages
([`RoleColor`](../src/shared/colors.ts)). Empty fields keep the theme's colour; values are hex colours, checked and
normalised by [`cleanColor`](../src/shared/colors.ts) (a typo drops that field instead of breaking the styling).

[`colorVars`](../src/shared/colors.ts) turns the set into CSS variables (`--thinking-bg`, `--tool-fg`, `--answer-bg`
with its padding, `--user-bg`, …); [`applyChatColors`](../src/main/colors.ts) puts them on `<html>` — the active
session's host profile first, otherwise `ui.colorProfile`. It runs when a session is shown
([`activate`](../src/main/sessions.ts)), after a theme change ([`setTheme`](../src/main/chatView.ts)) and when the
system switches between dark and light ([`wireChatColors`](../src/main/index.ts)). `styles.css` uses the variables
with the theme's own colours as fallback. Profiles are edited in [`colorEditor`](../src/main/colorSettings.ts) and
picked per host in the host list.

### Earlier messages: edit, run again, reuse

Each user bubble ([`SessionTab`](../src/main/sessionTab.ts)) gets buttons. "Edit" and "run again" first open an inline
panel under the message (`branchPanel` in [`SessionTab`](../src/main/sessionTab.ts)): an editor or a short question, with
"Cancel" (and Esc) – nothing changes until the user confirms. Then [`onUserAction`](../src/main/sessions.ts) asks Pi for
the fork points ([`SessionTab.forkPoints`](../src/main/sessionTab.ts), RPC `get_fork_messages`), matches the original
message by position or text and forks there ([`SessionTab.forkAt`](../src/main/sessionTab.ts), RPC `fork`): Pi writes a
new session file with the history up to that message; the original file stays. [`rekey`](../src/main/sessions.ts) moves
the tab to the new key and keeps group and colour, then the edited (or original) text is sent. "Go back to here" forks
before the *next* message (this message and its answer stay) and sends nothing. Each branch sets `SessionTab.undo`;
the bar above the input calls [`undoBranch`](../src/main/sessions.ts): [`SessionTab.switchTo`](../src/main/sessionTab.ts)
(RPC `switch_session`) returns to the previous file and the branch file is deleted. Sending a new message in the
branch ends the undo. "Use as new message"
puts the text into the input ([`fillInput`](../src/main/chatView.ts)).

When Pi loads a session file (fork, switch) it takes model and thinking level from that point of the history, i.e. the
model used back then. `SessionTab.keepModel` sets the model chosen before again — also around
[`SessionTab.restart`](../src/main/sessionTab.ts), so a reconnect or a tool change does not silently fall back to it.

Versions of a message: Pi's fork keeps the entry ids of the shared history and writes `parentSession` into the
header. [`refreshBranches`](../src/main/branchNav.ts) takes the related sessions ([`branchFamily`](../src/shared/branches.ts)),
reads their user messages (`session_outlines`) and compares them with the fork points of the open session
([`branchesAt`](../src/shared/branches.ts)). Where they part, [`SessionTab.showBranches`](../src/main/sessionTab.ts) shows
"‹ 2/3 ›" under the message; a click calls [`switchBranch`](../src/main/sessions.ts), which switches the tab to that file
and scrolls to the same message.

### Messages while Pi works

While Pi is busy, [`SessionTab.send`](../src/main/sessionTab.ts) queues a message: Enter as `followUp` (Pi gets it when
done), ⌥Enter as `steer` (in between, before Pi's next step). Pi reports its queue with `queue_update`;
`renderQueue` in [`chatView.ts`](../src/main/chatView.ts) lists it above the input. Pi can only clear the queue as a
whole (`clear_queue`), so switching, removing or taking a message back into the input goes through
[`SessionTab.editQueue`](../src/main/sessionTab.ts): clear, change, queue the rest again.

### Questions to the user

At `agent_settled` [`SessionTab`](../src/main/sessionTab.ts) looks for choice questions at the end of the last answer
([`findQuestions`](../src/shared/questions.ts)): a question followed by a list, or a list followed by "which of these…?".
If there are some, [`openQuestions`](../src/main/sessions.ts) opens [`questionDialog`](../src/main/answerDialog.ts):
options to tick and always a field for an own answer; the bar above the input reopens it. The answer goes out as the
next message ([`composeAnswer`](../src/shared/questions.ts)). Dialogs of Pi extensions (`extension_ui_request`:
select, confirm, input, editor) open [`uiRequest`](../src/main/answerDialog.ts) and are answered with `pi_reply`;
`notify` becomes a toast, `set_editor_text` fills the input.

### Default model for new sessions

`ui.defaultPreset` or `ui.defaultModel` + `ui.defaultThinking`, set with the star in the header
([`renderToolbar`](../src/main/chatView.ts)) or in the settings. [`openSession`](../src/main/sessions.ts) applies it to
new sessions ([`applyDefaults`](../src/main/sessions.ts)); the quick bar shows it as "Model: default (…)". For an
existing session the quick bar keeps the session's model ("Model: as in the session") unless something is picked in
the bar right then ([`keepSession`](../src/quick/index.ts)).

### Tool dock, attachments and tools

[`wireComposerTools`](../src/main/composerTools.ts) opens the dock when the mouse is within ~70 px (class `near`) and
fades it out with a short delay. Files come from the file picker, drag & drop or paste ([`addFiles`](../src/main/composerTools.ts)):
images are sent as Pi images, text files are appended as `<file name="…">` blocks ([`withFiles`](../src/shared/format.ts));
the chat shows them as cards again ([`splitFiles`](../src/shared/format.ts)). Tools: `SessionTab.toolset` (null = Pi's
default) is passed to `pi_open` and turned into `--tools` / `--no-tools` ([`tool_args`](../src-tauri/src/pi.rs));
changing it restarts Pi in the same session and stores it in `sessionMeta.tools`.

### Skills ("/" menu)

[`SessionTab.refreshModels`](../src/main/sessionTab.ts) also loads Pi's `get_commands`. Typing `/` in the input opens
[`wireSlashMenu`](../src/main/slashMenu.ts); picking an entry inserts `/skill:name ` (skills) or `/name `, which Pi
expands itself when the prompt is sent.

### Token statistics

[`SessionTab.measure`](../src/main/sessionTab.ts) times each live answer (first token → `message_end`) and adds usage to
[`TabStats`](../src/main/sessionTab.ts). [`SessionTab.refreshStats`](../src/main/sessionTab.ts) loads Pi's
`get_session_stats` (at start, after each answer, after a model change). [`renderUsage`](../src/main/usageStats.ts) draws
the status line under the input in the format of Pi's footer ([`footerParts`](../src/shared/format.ts): ↑ input,
↓ output, R cache read with its share of the input in %, W cache write, cost, context %/window), with model and thinking
level on the right; on hover [`wireUsage`](../src/main/usageStats.ts) shows the panel. The panel starts with Pi's session
id (`get_state` → `sessionId`, copied on click; `SessionTab.sessionId`), the same id the session menu copies
([`sessionMenu`](../src/main/sessionGroups.ts)).

### Layout and colour scheme

[`wireLayout`](../src/main/layout.ts) wires the panel buttons and the drag handles (widths in `ui.leftWidth` /
`ui.rightWidth`). Below 1120 px (right) or 820 px (left) window width, [`togglePanel`](../src/main/layout.ts) opens the
panel floating over the chat instead of as a column. [`applyTheme`](../src/shared/theme.ts) sets `data-theme` and the
native window theme; [`setTheme`](../src/main/chatView.ts) saves it and emits `theme-changed` for the quick bar.

### Sessions: names, pins, colours, groups

[`sessionItem`](../src/main/sessions.ts) rows open [`sessionMenu`](../src/main/sessionGroups.ts) on right click or "⋯":
rename ([`renameDialog`](../src/main/sessionGroups.ts): own name in `AppConfig.sessionMeta`, plus `set_session_name`
for an open session), pin, colour, move to group, reminder, close. [`sessionSections`](../src/main/sessions.ts) renders
pinned sessions first, then each group of `AppConfig.groups` (coloured, collapsible, [`groupMenu`](../src/main/sessionGroups.ts)),
then the rest. The quick bar uses the same names and lists pinned sessions first.

⌘-click and ⇧-click select several sessions ([`selectClick`](../src/main/sessionSelect.ts)); the bar at the bottom
([`renderSelectionBar`](../src/main/sessionSelect.ts)) and the context menu ([`bulkMenu`](../src/main/sessionGroups.ts))
act on all of them via [`setMetaMany`](../src/main/sessionGroups.ts). Rows are draggable
([`dragStart`](../src/main/sessionSelect.ts), the whole selection if the row is selected); groups, the "Pinned" heading
and the drop zones under the list (pin, no group, new group) are [`dropTarget`](../src/main/sessionSelect.ts)s. Empty
groups only show while dragging. [`deleteSessionsDialog`](../src/main/sessionGroups.ts) asks with a list of the
sessions, closes open ones, calls [`sessions::delete`](../src-tauri/src/sessions.rs) and removes names, reminders and
folders of the deleted sessions; closing several open sessions asks first too
([`closeSessionsDialog`](../src/main/sessionGroups.ts)). HTML drag & drop needs `dragDropEnabled: false` on the main window
(`tauri.conf.json`).

### Voice: dictation, read aloud, text improvement

Settings in `AppConfig.voice` ([`VoiceCfg`](../src-tauri/src/config.rs), edited in [`voiceEditor`](../src/main/voiceSettings.ts)).
[`wireVoice`](../src/shared/voice.ts) wires the mic and improve buttons in both windows: the recording
([`startRecording`](../src/shared/voice.ts), MediaRecorder; macOS asks for the microphone, see `src-tauri/Info.plist`) goes
as base64 to `transcribe_audio` → [`transcribe`](../src-tauri/src/voice.rs) (OpenAI-compatible `/audio/transcriptions`
or a local command with `{file}`); optionally [`improve`](../src/shared/voice.ts) → `improve_text` →
[`improve`](../src-tauri/src/voice.rs) (`/chat/completions` with the prompt). Answers get a speaker button
(`readAloud` in [`sessionTab.ts`](../src/main/sessionTab.ts)); [`speak`](../src/shared/voice.ts) uses the system voice or
`speak_text` → [`speak`](../src-tauri/src/voice.rs). Auto read: `agent_settled` in [`SessionTab.onEvent`](../src/main/sessionTab.ts).
HTTP goes through `curl`; the API key is passed on stdin.

### Language

[`init`](../src/main/index.ts) calls [`setLang`](../src/shared/i18n.ts) with `ui.language` ("auto", "en", "de"),
[`translateDom`](../src/shared/i18n.ts) fills static HTML via `data-i18n*` attributes, and
[`set_language`](../src-tauri/src/lib.rs) tells Rust so errors and the tray menu ([`tray_menu`](../src-tauri/src/lib.rs))
match. Changing the language in the settings reloads both windows (event `language-changed`).

## UI ↔ Rust interface

Tauri commands are registered in [`run`](../src-tauri/src/lib.rs) and typed in [`api`](../src/shared/api.ts).
A new command needs both.

| Command | Purpose |
| --- | --- |
| `get_config`, `save_config` | Settings (the quick bar position is managed by Rust only) |
| `config_load_error` | Settings file was damaged at start (reset, backup path); the main window shows it once |
| `set_language` | Language for messages from Rust and the tray menu |
| `test_host`, `list_sessions`, `list_models` | Check a host, list sessions and models |
| `delete_sessions` | Delete session files (paths must lie in Pi's `sessions` folder) |
| `session_outlines` | User messages (entry ids) of session files, for the versions of a message |
| `pi_open`, `pi_send`, `pi_close`, `pi_close_all` | Pi process per session |
| `bg_start`, `bg_follow`, `bg_running`, `bg_stop` | Run a message in the background: start detached, follow the log, ask whether it still runs, stop it |
| `pi_reply` | Answer to a dialog of a Pi extension (`extension_ui_response`, Pi sends no response) |
| `list_files`, `read_file`, `write_file`, `create_file`, `create_dir` | Files and folders of the tree (all files, or only Markdown/HTML/images) |
| `read_image` | An image of the file panel as base64 (read only) |
| `git_log`, `git_commit`, `git_diff` | Git history (read only): commits, files of a commit, diff of a file |
| `list_dirs` | Subfolders of a folder on the host, for the folder picker |
| `read_file_head` | Content of a file in Git HEAD, for the diff view |
| `term_open`, `term_write`, `term_resize`, `term_close`, `term_close_all` | Terminal: start a shell in a pty, send keys, resize, close one or all |
| `quick_hide`, `quick_resize`, `quick_reset_pos`, `show_main` | Windows |
| `set_hotkey`, `hotkey_status`, `set_double_tap`, `double_tap_status` | Hotkeys; the main window warns at start if the quick bar cannot open ([`warnQuickBar`](../src/main/index.ts)) |
| `capture_screen`, `ocr_image` | Screenshot and text recognition |
| `transcribe_audio`, `improve_text`, `speak_text` | Dictation, text improvement, read aloud |
| `diagnose`, `pi_stderr` | Diagnosis report of a host, stderr tail of a Pi process |

| Event | From → to | Contents |
| --- | --- | --- |
| `pi-event` | Rust → main window | `{ handle, event }`, one Pi event (see [Pi docs](https://pi.dev/docs/latest/json)) |
| `pi-exit` | Rust → main window | `{ handle, stderr }` when a Pi process ends |
| `term-output`, `term-exit` | Rust → main window | `{ id, data }` (base64 bytes of a terminal) and `{ id }` when its shell ends |
| `quick-show` | Rust → quick bar | The bar was opened |
| `quick-submit` | quick bar → main window | [`QuickSubmit`](../src/shared/api.ts) |
| `main-active`, `quick-request-active` | both directions | current session for the "Current" target |
| `language-changed` | main window → both | reload with the new language |
| `theme-changed` | main window → quick bar | new colour scheme (`auto`, `light`, `dark`) |

## Where do I change what?

| Goal | Starting point |
| --- | --- |
| Explain a chat error / add a diagnosis check | [`diag::run`](../src-tauri/src/diag.rs), [`diagnoseHints`](../src/main/diagnose.ts) |
| Render a new Pi event | [`SessionTab.onEvent`](../src/main/sessionTab.ts) |
| Runs in the background (detached Pi, log, pid) | [`bg.rs`](../src-tauri/src/bg.rs), [`SessionTab.sendToBackground`](../src/main/sessionTab.ts) |
| Chat views, answer style hints | [`applyUiPrefs`](../src/main/chatView.ts), [`withAnswerStyle`](../src/shared/format.ts) |
| Token statistics panel | [`wireUsage`](../src/main/usageStats.ts), [`SessionTab.measure`](../src/main/sessionTab.ts) |
| Panel widths, narrow windows | [`applyLayout`](../src/main/layout.ts) |
| Terminal at the bottom: shell, pty, keys, colours | [`shell_command`](../src-tauri/src/terminal.rs), [`wireTerminal`](../src/main/terminal.ts) |
| Session context menu, groups, colours | [`sessionMenu`](../src/main/sessionGroups.ts), [`COLORS`](../src/main/menu.ts) |
| Another speech or LLM provider | [`voice.rs`](../src-tauri/src/voice.rs), [`voiceEditor`](../src/main/voiceSettings.ts) |
| New Pi RPC command in the UI | method in [`SessionTab`](../src/main/sessionTab.ts) via [`api`](../src/shared/api.ts) (`api.pi`) |
| New Rust command | function in [`lib.rs`](../src-tauri/src/lib.rs) + register in [`run`](../src-tauri/src/lib.rs) + [`api`](../src/shared/api.ts) |
| Chat colours (profile editor, roles) | [`colorSettings.ts`](../src/main/colorSettings.ts), [`shared/colors.ts`](../src/shared/colors.ts), [`styles.css`](../src/main/styles.css) |
| New setting | [`UiPrefs`](../src-tauri/src/config.rs) (with `serde(default)`) + [`AppConfig`](../src/shared/api.ts) + [`settingsDialog`](../src/main/settings.ts) |
| New or changed UI text | [`t`](../src/shared/i18n.ts) + German entry in the dictionary in the same file; Rust: [`tr`](../src-tauri/src/i18n.rs) |
| Another language | add a dictionary and an entry in [`LANGUAGES`](../src/shared/i18n.ts); Rust: [`i18n::set`](../src-tauri/src/i18n.rs) |
| Reminder presets | [`presetTimes`](../src/main/reminders.ts) |
| Model presets (editor, matching) | [`presetEditor`](../src/main/settings.ts), [`matchPreset`](../src/shared/presets.ts) |
| Another way to reach a host | [`shell_command`](../src-tauri/src/hostexec.rs) |
| Quick bar look | [`quick.html`](../quick.html), [`quick.css`](../src/quick/quick.css) |
| Main window look | [`index.html`](../index.html), [`styles.css`](../src/main/styles.css) |
| Linux/Windows support for screenshot/OCR/double tap | [`capture`](../src-tauri/src/quick.rs), [`ocr`](../src-tauri/src/quick.rs), [`start`](../src-tauri/src/doubletap.rs) |

## Known gaps

- Remote images in chat Markdown are blocked by the Content Security Policy (`security.csp` in `tauri.conf.json`), on
  purpose: an image URL from model output could leak data.
- Double tap, area screenshot and OCR with Apple Vision are macOS only.
- The terminal needs a pty: it is built for macOS and Linux (`portable-pty`); Windows is untested.
- Reminders are only checked while PiBar is running (missed ones show as due on the next start).
- Runs in the background take one message at a time: no images, no steering, no dialogs of Pi extensions, and the
  model is fixed at the start. Their pid file (below `~/.pibar` on the host) removes the follower when the run ends;
  the log stays there as the place to look when a run ends without an answer.
