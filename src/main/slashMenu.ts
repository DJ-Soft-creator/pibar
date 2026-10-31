// "/" menu in the chat input: skills, prompt templates and extension commands of the active session
// (Pi RPC get_commands, loaded in SessionTab.refreshModels). Picking one inserts "/name " into the input.
import type { PiCommand } from "../shared/api";
import { h } from "../shared/dom";
import { t } from "../shared/i18n";
import { state } from "./state";

let input: HTMLTextAreaElement;
let menu: HTMLElement;
let items: PiCommand[] = [];
let sel = 0;

/** Text to type for a command; Pi calls skills as /skill:name */
export function commandText(c: PiCommand): string {
  return c.source === "skill" && !c.name.startsWith("skill:") ? `skill:${c.name}` : c.name;
}

const ORDER = ["skill", "prompt", "extension"];

function groupLabel(source?: string): string {
  if (source === "skill") return t("Skills");
  if (source === "prompt") return t("Prompt templates");
  return t("Commands");
}

function isOpen(): boolean {
  return !menu.hidden;
}

function close() {
  menu.hidden = true;
}

function render() {
  const query = input.value.slice(1).toLowerCase();
  const all = state.active?.commands ?? [];
  items = all
    .filter(
      (c) => !query || commandText(c).toLowerCase().includes(query) || c.description?.toLowerCase().includes(query),
    )
    .sort((a, b) => {
      const sa = ORDER.indexOf(a.source ?? "") - ORDER.indexOf(b.source ?? "");
      if (sa) return sa;
      const pa = commandText(a).toLowerCase().startsWith(query) ? 0 : 1;
      const pb = commandText(b).toLowerCase().startsWith(query) ? 0 : 1;
      return pa - pb || commandText(a).localeCompare(commandText(b));
    });
  sel = Math.min(sel, Math.max(0, items.length - 1));
  const rows: HTMLElement[] = [];
  let group = "";
  items.forEach((c, i) => {
    const g = groupLabel(c.source);
    if (g !== group) {
      group = g;
      rows.push(h("div", { class: "slash-group" }, g));
    }
    rows.push(
      h(
        "button",
        {
          type: "button",
          class: `slash-item ${i === sel ? "active" : ""}`,
          title: c.path ?? "",
          onmousedown: (e: MouseEvent) => {
            e.preventDefault(); // keep the focus in the input
            pick(c);
          },
          onmouseenter: () => {
            sel = i;
            markActive();
          },
        },
        h("span", { class: "slash-name" }, `/${commandText(c)}`),
        c.description ? h("span", { class: "slash-desc" }, c.description) : null,
        c.location ? h("span", { class: "slash-loc" }, c.location) : null,
      ),
    );
  });
  if (!items.length)
    rows.push(
      h("div", { class: "slash-empty" }, all.length ? t("No match") : t("This session has no skills or commands.")),
    );
  menu.replaceChildren(...rows);
  menu.hidden = false;
  markActive();
}

function markActive() {
  menu.querySelectorAll(".slash-item").forEach((b, i) => {
    b.classList.toggle("active", i === sel);
    if (i === sel) (b as HTMLElement).scrollIntoView({ block: "nearest" });
  });
}

function pick(c: PiCommand) {
  input.value = `/${commandText(c)} `;
  close();
  input.focus();
  input.dispatchEvent(new Event("input"));
}

/** Keys while the menu is open; true = handled (do not send) */
export function slashKey(e: KeyboardEvent): boolean {
  if (!isOpen()) return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (items.length) sel = (sel + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
    markActive();
    return true;
  }
  if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
    if (!items[sel]) return (close(), false);
    e.preventDefault();
    pick(items[sel]);
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    close();
    return true;
  }
  return false;
}

export function wireSlashMenu(inputEl: HTMLTextAreaElement, menuEl: HTMLElement, button: HTMLButtonElement) {
  input = inputEl;
  menu = menuEl;
  input.addEventListener("input", () => {
    if (/^\/\S*$/.test(input.value)) {
      sel = 0;
      render();
    } else close();
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
  button.addEventListener("click", () => {
    if (isOpen()) return close();
    if (!input.value.startsWith("/")) input.value = "/";
    input.focus();
    sel = 0;
    render();
  });
}
