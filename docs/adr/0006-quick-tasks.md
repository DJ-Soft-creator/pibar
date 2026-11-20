# 0006 – Quick tasks bar in the right pane

Status: proposed (concept, not decided)
Date: 2026-02-14

## Context

The right pane (`aside.files`: folder tree + inline editor) has no way to fire a recurring prompt
(“Summarise this file”, “Write tests”, “Explain the diff”, …) without going through the composer or the
slash menu. A persistent, one-click row at the bottom of that pane is the smallest useful surface: it is
visible while browsing files and the editor is open or closed.

Constraints found in the code:

- `aside.files` is a flex column (`pane-head`, `#file-tree`, `.hsplit`, `#editor`); a fixed-height footer
  is the natural last child and must survive `#editor[hidden]`.
- Pane visibility is handled purely by `.no-right` / `.ov-right` on `#app` (`src/main/layout.ts`), so the
  footer needs no own collapse logic.
- `UiPrefs` (`src-tauri/src/config.rs`) is deserialised with `#[serde(default)]` per field, so a new field
  must have a default — existing `config.json` files keep working.
- ⌘1…⌘9 already switches session tabs (`src/main/shortcuts.ts:120`); ⌥Digit is free. That is the only
  sane accelerator.
- i18n rule (ADR 0005): English text is the key; user-editable labels are data, not translations.

## Decision (draft)

**Placement** — `<div id="quick-tasks" class="quick-tasks">` as last child of `aside.files`, height
`28 * var(--fs)`, `border-top: 1px solid var(--border)`, `flex: 0 0 auto`. Five slots, `flex: 1 1 0`,
label only, `text-overflow: ellipsis`, `title` = full prompt. Empty slot = dashed `+` that opens the
settings tab.

**Data model** — `UiPrefs.quick_tasks: Vec<QuickTask>` (Rust) / `state.config.ui.quickTasks` (TS):

```json
{ "label": "Tests", "text": "Write tests for the open file", "run": false }
```

`run: false` → insert into the composer (user can still edit, Enter sends); `run: true` → send
immediately. Exactly five entries, empty ones allowed (rendered as `+`).

**Default seeds** (translated once at first start, then plain data): Summarise · Tests · Review diff ·
Explain error · Commit message.

**Disabled state** — no active session → buttons dimmed, click is a no-op with a toast (same as the
composer today).

**Editing** — new “Quick tasks” tab in the settings dialog (`src/main/settings.ts`): five rows with
label, text (textarea), mode toggle (insert / send), reset to default.

**Shortcuts** — ⌥1…⌥5 fires slot n while the main window has focus.

**Persistence** — same `saveConfig()` debounce as the other UI prefs; nothing in the session file.

## Open questions (to be grilled)

1. Insert or send as the default? (A “run” flag per slot or one global behaviour?)
2. Global five slots — or per project (like `projectPreset`)? Per project needs a new
   `Project.quickTasks` field and an inheritance rule (project overrides global, falling back per slot).
3. Hard-coded config vs. a Markdown file (`.pibar/quick-tasks.md`) that the inline editor can open and
   the file watcher can reload? The file version costs a parser and a merge with the config defaults.
4. Placeholders: `{file}` (open editor file), `{selection}`, `{folder}`? Anything unresolved = insert
   literal text or refuse?
5. Where does a task run: current session (append to composer) or new session in the active project?
6. Do the shortcuts conflict with the quick launcher's global hotkey or with the terminal focus guard
   (`shortcuts.ts:89`)?
7. Overflow: exactly five, or N slots with the last one being “more…”?

## Consequences (if accepted)

- Small, isolated UI change (`index.html`, `styles.css`, new `src/main/quickTasks.ts`), one new config
  field + TS type, one settings tab, one shortcut branch, one i18n-free data path.
- Every further “task” feature (placeholders, per-project lists, ordering) becomes a config migration,
  so the open questions above should be answered before the first commit.
