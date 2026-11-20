// Subagents in the left column, indented under their session (collapsible): runs of Pi's subagent extension
// (tool events, shared/subagents.ts) and child sessions PiBar starts itself with an agent definition
// ("New subagent …" in the session menu, agents read by src-tauri/src/agents.rs).
import { api, type AgentInfo } from "../shared/api";
import { h, errMsg, openModal, toast } from "../shared/dom";
import { t } from "../shared/i18n";
import { subagentWorking, type SubagentRun } from "../shared/subagents";
import { isWorking } from "./activity";
import { metaOf, refKey, setMeta } from "./sessionGroups";
import { activate, tabCallbacks, type ListRow } from "./sessions";
import { SessionTab } from "./sessionTab";

/** Status glyph of one run: spinner while it goes, ✓ done, ✗ failed or aborted */
function statusMark(r: SubagentRun): HTMLElement {
  const ok = r.status === "completed";
  const bad = r.status === "failed" || r.status === "aborted";
  return h("span", { class: `sa-status ${ok ? "ok" : bad ? "err" : "run"}` }, ok ? "✓" : bad ? "✗" : "⏳");
}

/** One run of the subagent extension as a small row; a click shows its tool card in the chat */
function runRow(tab: SessionTab, toolCallId: string, r: SubagentRun): HTMLElement {
  const task = r.task.replace(/\s+/g, " ").trim();
  return h(
    "div",
    {
      class: "subagent-row",
      role: "button",
      tabindex: 0,
      title: `${r.agent}${r.step ? ` · ${t("step")} ${r.step}` : ""}\n${task}`,
      onclick: () => {
        activate(tab);
        tab.scrollToTool(toolCallId);
      },
    },
    statusMark(r),
    h("span", { class: "sa-agent" }, r.agent),
    r.step ? h("span", { class: "sa-step" }, `#${r.step}`) : null,
    h("span", { class: "sa-task" }, task),
  );
}

/**
 * The children of a session row: its subagent sessions (meta.parentKey) and the runs of the subagent extension,
 * under a small heading that folds them away (saved in the session meta). null when there is nothing to show.
 * `renderItem` renders a child session row (sessionItem in sessions.ts, passed in to keep the modules apart).
 */
export function sessionKids(
  row: ListRow,
  rows: ListRow[],
  renderItem: (r: ListRow) => HTMLElement,
): HTMLElement | null {
  const key = refKey(row.ref);
  const kids = rows.filter((r) => metaOf(refKey(r.ref)).parentKey === key);
  const calls = [...(row.ref.tab?.subagentCalls ?? [])].filter(([, c]) => c.runs.length > 0);
  if (!kids.length && !calls.length) return null;
  const closed = !!metaOf(key).kidsCollapsed;
  const working =
    calls.some(([, c]) => subagentWorking(c)) || kids.some((k) => k.running || isWorking(k.ref.tab ?? undefined));
  const count = kids.length + calls.reduce((n, [, c]) => n + c.runs.length, 0);
  const head = h(
    "button",
    {
      type: "button",
      class: "sess-kids-head",
      title: closed ? t("Expand") : t("Collapse"),
      "aria-expanded": closed ? "false" : "true",
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        setMeta(key, { kidsCollapsed: !closed });
      },
    },
    h("span", { class: "chev" }, closed ? "▸" : "▾"),
    t("Subagents"),
    working ? h("span", { class: "sess-state busy sa-spin", title: t("Pi is working …") }) : null,
    h("span", { class: "count" }, String(count)),
  );
  return h(
    "div",
    { class: "sess-kids" },
    head,
    ...(closed
      ? []
      : [
          ...kids.map((k) => h("div", { class: "sess-kid" }, renderItem(k))),
          ...calls.flatMap(([id, c]) => c.runs.map((r) => runRow(row.ref.tab!, id, r))),
        ]),
  );
}

/** Start a subagent as a session of its own: the agent's tools, model and system prompt, indented under its parent */
export async function openAgentSession(parent: SessionTab, agent: AgentInfo, task: string): Promise<void> {
  const prompt = await api.agentPromptFile(parent.hostId, agent.path);
  const tab = new SessionTab(parent.hostId, parent.cwd, null, agent.name, tabCallbacks);
  tab.toolset = agent.tools ?? null;
  tab.agentPromptFile = prompt;
  // the link to the parent and the agent belong to the session from the start; rekey carries them to its file key
  setMeta(tab.key, {
    name: agent.name,
    parentKey: parent.key,
    agentName: agent.name,
    agentPrompt: prompt,
    tools: agent.tools ?? undefined,
  });
  activate(tab);
  await tab.start();
  if (agent.model) {
    const i = agent.model.indexOf("/");
    const m =
      i > 0
        ? { provider: agent.model.slice(0, i), id: agent.model.slice(i + 1) }
        : tab.models.find((x) => x.id === agent.model);
    if (m) await tab.setModel(m.provider, m.id).catch((e) => toast(`${t("Model")}: ${errMsg(e)}`, "err"));
  }
  await tab.send(task);
}

/** "New subagent …" of the session menu: pick an agent of the host and give it a task */
export function subagentDialog(parent: SessionTab): void {
  api
    .listAgents(parent.hostId, parent.cwd)
    .then((agents) => {
      if (!agents.length) {
        toast(t("No agents found. Put Markdown definitions in ~/.pi/agent/agents on the host."), "err");
        return;
      }
      const sel = h(
        "select",
        {},
        ...agents.map((a) => h("option", { value: a.name }, `${a.name} (${a.source}) – ${a.description}`)),
      ) as HTMLSelectElement;
      const task = h("textarea", { rows: 4, placeholder: t("Task for the agent …") }) as HTMLTextAreaElement;
      const start = () => {
        const a = agents.find((x) => x.name === sel.value);
        const text = task.value.trim();
        if (!a || !text) return;
        close();
        openAgentSession(parent, a, text).catch((e) => toast(errMsg(e), "err"));
      };
      const close = openModal(
        t("New subagent"),
        h(
          "div",
          {},
          h("div", { class: "row" }, h("label", {}, t("Agent")), sel),
          task,
          h(
            "p",
            { class: "hint" },
            t(
              "Starts a session of its own in the folder of this session, with the agent's tools, model and system prompt. It appears indented under this session.",
            ),
          ),
        ),
        [
          h("button", { class: "ghost", onclick: () => close() }, t("Cancel")),
          h("button", { class: "primary", onclick: start }, t("Start")),
        ],
      );
      task.focus();
    })
    .catch((e) => toast(errMsg(e), "err"));
}
