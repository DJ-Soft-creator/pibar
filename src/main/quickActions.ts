// Quick action buttons at the bottom right of the chat (status line): a command/message goes to the active session,
// a shell script runs in a new terminal tab in the session's folder. Managed in the settings (quickActionsEditor).
import type { QuickAction } from "../shared/api";
import { $, h, errMsg, toast } from "../shared/dom";
import { t } from "../shared/i18n";
import { cleanQuickActions } from "../shared/quickActions";
import { state } from "./state";
import { openTab } from "./terminal";

/** Host and folder for a shell action: the active session, otherwise the selected or first host */
function target(): { hostId: string; cwd: string } {
  const tab = state.active;
  if (tab) return { hostId: tab.hostId, cwd: tab.cwd };
  const host = state.config.hosts.find((x) => x.id === state.config.ui.selectedHost) ?? state.config.hosts[0];
  return { hostId: host?.id ?? "local", cwd: host?.defaultDir ?? "~" };
}

/** Run one quick action: send its text to Pi, or run the script in a new terminal tab */
export async function runQuickAction(a: QuickAction): Promise<void> {
  if (a.kind === "shell") {
    const { hostId, cwd } = target();
    await openTab(hostId, cwd, { name: a.name, run: a.text });
    return;
  }
  const tab = state.active;
  if (!tab?.alive) {
    toast(t("Open a session first."), "err");
    return;
  }
  try {
    await tab.send(a.text);
  } catch (e) {
    toast(errMsg(e), "err");
  }
}

/** The buttons of the status line, from the settings; called at start and after the settings were saved */
export function renderQuickActions() {
  const el = $("quick-actions");
  const actions = cleanQuickActions(state.config.quickActions);
  el.hidden = !actions.length;
  el.replaceChildren(
    ...actions.map((a) =>
      h(
        "button",
        {
          type: "button",
          class: "qa-btn",
          title: `${a.kind === "shell" ? t("Run in the terminal") : t("Send to Pi")}:\n${a.text}`,
          onclick: () => void runQuickAction(a),
        },
        h("span", { class: "qa-kind" }, a.kind === "shell" ? "$" : "/"),
        a.name,
      ),
    ),
  );
}

/** Settings editor: one row per button (name, kind, text), add, remove, move; get() returns the cleaned list */
export function quickActionsEditor(): { el: HTMLElement; get: () => QuickAction[] } {
  const draft: QuickAction[] = cleanQuickActions(state.config.quickActions);
  const list = h("div", { class: "qa-list" });

  const render = () => {
    list.replaceChildren(
      ...draft.map((a, idx) => {
        const name = h("input", { type: "text", value: a.name, placeholder: t("Name") }) as HTMLInputElement;
        name.addEventListener("input", () => (a.name = name.value));
        const kind = h(
          "select",
          {},
          h("option", { value: "command", selected: a.kind === "command" }, t("Command or message")),
          h("option", { value: "shell", selected: a.kind === "shell" }, t("Shell script")),
        ) as HTMLSelectElement;
        kind.addEventListener("change", () => {
          a.kind = kind.value === "shell" ? "shell" : "command";
          text.placeholder = a.kind === "shell" ? t("Script, e.g. npm run check") : t("/compact or a message to Pi");
        });
        const text = h("textarea", {
          rows: 2,
          placeholder: a.kind === "shell" ? t("Script, e.g. npm run check") : t("/compact or a message to Pi"),
        }) as HTMLTextAreaElement;
        text.value = a.text;
        text.addEventListener("input", () => (a.text = text.value));
        const move = (delta: number) => {
          const j = idx + delta;
          if (j < 0 || j >= draft.length) return;
          [draft[idx], draft[j]] = [draft[j], draft[idx]];
          render();
        };
        return h(
          "div",
          { class: "qa-row" },
          h(
            "div",
            { class: "qa-row-top" },
            name,
            kind,
            h("button", { class: "ghost", title: t("Move up"), onclick: () => move(-1) }, "↑"),
            h("button", { class: "ghost", title: t("Move down"), onclick: () => move(1) }, "↓"),
            h("button", { class: "ghost", title: t("Remove"), onclick: () => (draft.splice(idx, 1), render()) }, "×"),
          ),
          text,
        );
      }),
    );
  };
  render();

  const add = () => {
    draft.push({ id: `qa${Date.now()}`, name: "", kind: "command", text: "" });
    render();
    list.querySelector<HTMLInputElement>(".qa-row:last-child input")?.focus();
  };

  const el = h(
    "div",
    {},
    list,
    h("button", { class: "ghost", onclick: add }, t("+ Add button")),
    h(
      "p",
      { class: "hint" },
      t(
        "Small buttons at the bottom right of the chat. A command or message goes to the active session (slash commands work too); a shell script runs in a new terminal tab in the session's folder. Rows without a name or text are hidden.",
      ),
    ),
  );
  return { el, get: () => cleanQuickActions(draft) };
}
