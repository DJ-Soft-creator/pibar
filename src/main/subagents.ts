// Subagents in the left column, indented under their session (collapsible): runs of Pi's subagent extension
// (tool events, shared/subagents.ts) and child sessions PiBar starts itself with an agent definition
// ("New subagent …" in the session menu, agents read by src-tauri/src/agents.rs).
import { api, type AgentInfo } from "../shared/api";
import { h, errMsg, openModal, toast } from "../shared/dom";
import { t } from "../shared/i18n";
import { subagentWorking, resolveAgentModel, subagentWaits, type SubagentRun } from "../shared/subagents";
import { isWorking } from "./activity";
import { metaOf, refKey, setMeta } from "./sessionGroups";
import { activate, tabCallbacks, type ListRow } from "./sessions";
import { SessionTab, type TabCallbacks } from "./sessionTab";
import { state } from "./state";

/** Status glyph of one run: spinner while it goes, ✓ done, ✗ failed or aborted */
function statusMark(r: SubagentRun): HTMLElement {
  const ok = r.status === "completed";
  const bad = r.status === "failed" || r.status === "aborted";
  return h("span", { class: `sa-status ${ok ? "ok" : bad ? "err" : "run"}` }, ok ? "✓" : bad ? "✗" : "⏳");
}

/** One run of the subagent extension as a small row; a click shows its tool card in the chat */
function runRow(tab: SessionTab, toolCallId: string, r: SubagentRun): HTMLElement {
  const task = r.task.replace(/\s+/g, " ").trim();
  const going = r.status === "pending" || r.status === "running";
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
    going ? stopButton(tab, t("Stop this run (aborts the session's current turn)")) : null,
  );
}

/** Small ■ that stops a running subagent: a background run is stopped, a live one aborted */
function stopButton(tab: SessionTab, title: string): HTMLElement {
  return h(
    "button",
    {
      class: "icon-btn sa-stop",
      title,
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        if (tab.bg) void tab.stopBackground();
        else tab.abort().catch((err) => toast(errMsg(err), "err"));
      },
    },
    "■",
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
          ...kids.map((k) =>
            h(
              "div",
              { class: "sess-kid" },
              renderItem(k),
              k.ref.tab && isWorking(k.ref.tab) ? stopButton(k.ref.tab, t("Stop this subagent")) : null,
            ),
          ),
          ...calls.flatMap(([id, c]) => c.runs.map((r) => runRow(row.ref.tab!, id, r))),
        ]),
  );
}

// ---------- Concurrency: one after another (default) or at the same time ----------
// Small hardware often cannot run several jobs at once, so by default a new subagent waits until the running one is
// done. The setting "Subagents" (settings.ts, ui.subagentMode) switches to parallel. Only PiBar's own child sessions
// are gated here; the runs of Pi's subagent extension happen inside Pi's process.
const active = new Set<SessionTab>();
const waiting: Array<() => void> = [];

function parallel(): boolean {
  return state.config.ui.subagentMode === "parallel";
}

/** Start queued subagents as slots free up: all of them in parallel mode, one at a time otherwise. */
function pump(): void {
  for (const tab of [...active]) if (!tab.alive) active.delete(tab);
  if (parallel()) {
    while (waiting.length) waiting.shift()!();
  } else if (!active.size && waiting.length) {
    waiting.shift()!();
  }
}

/** A subagent tab was closed (no settle event comes then): free its slot so the queue moves on. */
export function subagentClosed(tab: SessionTab): void {
  if (active.delete(tab)) pump();
}

/** Start a subagent now, or queue it when subagents run one after another and one is already going. */
export function requestSubagent(parent: SessionTab, agent: AgentInfo, task: string, modelChoice = ""): void {
  for (const tab of [...active]) if (!tab.alive) active.delete(tab);
  const run = () => {
    openAgentSession(parent, agent, task, modelChoice).catch((e) => toast(errMsg(e), "err"));
  };
  if (!subagentWaits(state.config.ui.subagentMode, active.size)) {
    run();
  } else {
    waiting.push(run);
    toast(t("Subagent queued – it starts when the running one is done."));
  }
}

/**
 * Start a subagent as a session of its own: the agent's tools and system prompt, indented under its parent.
 * The model is the dialog's choice (`modelChoice`): "session" = the parent's, "agent"/"" = the agent's with the
 * parent's as fallback, otherwise "provider/id" – never Pi's default (resolveAgentModel in shared/subagents.ts).
 * The tab takes a concurrency slot (active) until its first task settles; requestSubagent queues it beforehand.
 */
export async function openAgentSession(
  parent: SessionTab,
  agent: AgentInfo,
  task: string,
  modelChoice = "",
): Promise<void> {
  const cb: TabCallbacks = {
    ...tabCallbacks,
    onSettled: (x) => {
      tabCallbacks.onSettled(x);
      if (active.delete(x)) pump();
    },
  };
  const tab = new SessionTab(parent.hostId, parent.cwd, null, agent.name, cb);
  active.add(tab);
  try {
    const prompt = await api.agentPromptFile(parent.hostId, agent.path);
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
    // the parent's live model, or the one saved with it when its process does not know it yet
    const saved = metaOf(parent.key).model ?? "";
    const si = saved.indexOf("/");
    const parentModel = parent.model ?? (si > 0 ? { provider: saved.slice(0, si), id: saved.slice(si + 1) } : null);
    const m = resolveAgentModel(modelChoice, agent.model, parentModel, tab.models);
    if (m && (tab.model?.provider !== m.provider || tab.model?.id !== m.id))
      await tab.setModel(m.provider, m.id).catch((e) => toast(`${t("Model")}: ${errMsg(e)}`, "err"));
    await tab.send(task);
  } catch (e) {
    if (active.delete(tab)) pump();
    throw e;
  }
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
      // model of the child session: the agent's, the parent's or one of the host's models (never Pi's default)
      const modelSel = h("select", {}) as HTMLSelectElement;
      const fillModels = () => {
        const a = agents.find((x) => x.name === sel.value);
        const prev = modelSel.value;
        const opts: HTMLElement[] = [];
        if (a?.model) opts.push(h("option", { value: "agent" }, `${t("Model of the agent")}: ${a.model}`));
        opts.push(h("option", { value: "session" }, t("Same model as this session")));
        const groups = new Map<string, HTMLElement>();
        for (const m of parent.models) {
          let g = groups.get(m.provider);
          if (!g) {
            g = h("optgroup", { label: m.provider });
            groups.set(m.provider, g);
            opts.push(g);
          }
          g.append(h("option", { value: `${m.provider}/${m.id}` }, m.name || m.id));
        }
        modelSel.replaceChildren(...opts);
        const keep = prev && [...modelSel.options].some((o) => o.value === prev);
        modelSel.value = keep ? prev : a?.model ? "agent" : "session";
      };
      sel.onchange = fillModels;
      fillModels();
      const start = () => {
        const a = agents.find((x) => x.name === sel.value);
        const text = task.value.trim();
        if (!a || !text) return;
        close();
        requestSubagent(parent, a, text, modelSel.value);
      };
      const close = openModal(
        t("New subagent"),
        h(
          "div",
          {},
          h("div", { class: "row" }, h("label", {}, t("Agent")), sel),
          h("div", { class: "row" }, h("label", {}, t("Model")), modelSel),
          task,
          h(
            "p",
            { class: "hint" },
            t(
              "Starts a session of its own in the folder of this session, with the agent's tools and system prompt and the chosen model (default: the agent's model, otherwise this session's model). It appears indented under this session.",
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
