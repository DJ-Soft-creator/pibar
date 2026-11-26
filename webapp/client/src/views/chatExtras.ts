// Actions on earlier own messages and the session family: copy, reuse, edit/run again as a new branch (Pi's fork),
// go back with file restore (snapshot commands, src/main/rewindFiles.ts) and undo, versions "‹ 2/3 ›"
// (src/shared/branches.ts, src/main/branchNav.ts), and "New subagent …" (list_agents, agent_prompt_file, a session of
// its own with the agent's tools and system prompt, src/main/subagents.ts).
import { api, type AgentInfo, type RewindChange, type SessionInfo } from "@shared/api";
import { branchesAt, branchFamily } from "@shared/branches";
import { copyText, errMsg, h, openModal, toast } from "@shared/dom";
import { splitScreenText, stripAnswerStyle } from "@shared/format";
import { t } from "@shared/i18n";
import { stripPlanMode } from "@shared/planMode";
import { resolveAgentModel } from "@shared/subagents";
import { openChat, state, type ChatTarget } from "../state";
import { button } from "../ui";
import type { ChatView } from "./chat";
import type { UserAction } from "./chatRender";
import { setStartOptions } from "./chatSession";

const norm = (s: string) =>
  stripPlanMode(stripAnswerStyle(splitScreenText(s).text))
    .replace(/\s+/g, " ")
    .trim();

/** Session list of the host (for the branch family); loaded when the list view has not done it yet */
async function hostSessions(hostId: string): Promise<SessionInfo[]> {
  const known = state.sessions.get(hostId);
  if (known) return known;
  const list = await api.listSessions(hostId);
  state.sessions.set(hostId, list);
  return list;
}

/** Recompute and show the versions of the own messages (branchNav.ts refreshBranches) */
export async function refreshBranches(v: ChatView) {
  const s = v.session;
  const path = v.target.path;
  if (!path || !s.alive || s.detached) return;
  try {
    const list = await hostSessions(v.target.hostId);
    const family = branchFamily(list, path);
    if (family.length < 2) return v.list.showBranches(new Map(), 0, () => {});
    const [points, outlines] = await Promise.all([s.forkPoints(), api.sessionOutlines(v.target.hostId, family)]);
    if (v.target.path !== path) return;
    const created = new Map(list.map((x) => [x.path, x.timestamp]));
    for (const o of outlines) o.created = created.get(o.path);
    const ids = points.map((p) => ({ id: p.entryId, text: p.text }));
    v.list.showBranches(branchesAt(path, ids, outlines), Math.max(0, ids.length - v.list.userMessages), (choice, index) => {
      if (s.streaming) return toast(t("Pi is still working – switch versions when it is done."), "err");
      void s.switchTo(choice.path).then((ok) => ok && v.list.scrollToUser(index));
    });
  } catch {
    /* without the overview the chat works as before */
  }
}

/** Earlier own message: copy, reuse, edit/run again (new branch) or go back to it */
export async function userAction(v: ChatView, index: number, action: UserAction, shown: string) {
  const s = v.session;
  if (action === "copy") {
    await copyText(shown).then(
      () => toast(t("Copied")),
      (e: unknown) => toast(errMsg(e), "err"),
    );
    return;
  }
  if (action === "reuse") return v.composer.fill(shown);
  if (!s.alive || s.detached) return toast(t("This session is not running."), "err");
  if (s.streaming) return toast(t("Pi is still working – stop it first or wait."), "err");
  let edited = shown;
  if (action === "edit") {
    const text = await editText(shown);
    if (text === null) return;
    edited = text;
  } else if (action === "rerun" && !(await ask(t("Run this message again from here?"), t("Run again")))) return;
  try {
    const points = await s.forkPoints();
    let p = points[index];
    if (!p || norm(p.text) !== norm(shown)) p = points.find((x) => norm(x.text) === norm(shown)) ?? p;
    if (!p) throw new Error(t("This message cannot be branched from."));
    let at = p;
    let files: Plan | null = null;
    if (action === "rewind") {
      const next = points[points.indexOf(p) + 1];
      if (!next) return toast(t("This is already the latest state."));
      at = next;
      files = await planRewind(v, p.entryId, points.slice(points.indexOf(p) + 1).map((x) => x.entryId));
      if (!files) return;
    }
    const fromPath = v.target.path;
    const text = await s.forkAt(at.entryId);
    if (text === null) return;
    state.sessions.delete(v.target.hostId); // the branch is a new file: the family changes
    let restored: { cwd: string; commit: string; paths: string[] } | null = null;
    if (action === "rewind" && files && files.changes.length) restored = await applyRewind(v, files);
    if (fromPath) {
      v.showUndo(action === "rewind" ? t("Went back.") : t("New branch."), async () => {
        if (restored) await api.rewindUndo(v.target.hostId, restored.cwd, restored.commit, restored.paths);
        await s.switchTo(fromPath);
      });
    }
    if (action === "rewind") return;
    await s.send(action === "edit" ? edited : stripPlanMode(stripAnswerStyle(text)) || shown);
  } catch (e) {
    toast(`${t("Branch")}: ${errMsg(e)}`, "err");
  }
}

function editText(text: string): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const area = h("textarea", { rows: Math.min(10, text.split("\n").length + 2), class: "q-own" });
    area.value = text;
    const close = openModal(
      t("Edit and resend (new branch from here)"),
      h("div", { class: "form" }, area, h("p", { class: "muted small" }, t("Creates a new branch; the original session stays unchanged."))),
      [
        button(t("Cancel"), () => close()),
        button(
          t("Send as new branch"),
          () => {
            result = area.value.trim() || null;
            close();
          },
          "primary",
        ),
      ],
      () => resolve(result),
    );
  });
}

function ask(question: string, yes: string): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    const close = openModal(
      question,
      h("p", { class: "muted" }, t("Creates a new branch; the original session stays unchanged.")),
      [
        button(t("Cancel"), () => close()),
        button(
          yes,
          () => {
            ok = true;
            close();
          },
          "primary",
        ),
      ],
      () => resolve(ok),
    );
  });
}

// ------------------------------------------------------------------ going back with files (rewindFiles.ts)

interface Plan {
  sessionIds: string[];
  tag: string;
  paths: string[];
  changes: RewindChange[];
}

/** Ids of the session files that share this history (a Pi fork keeps the states of its original) */
async function familyIds(v: ChatView): Promise<string[]> {
  const list = await hostSessions(v.target.hostId).catch(() => [] as SessionInfo[]);
  const own = v.session.sessionId ? [v.session.sessionId] : [];
  const paths = v.target.path ? branchFamily(list, v.target.path) : [];
  const ids = paths.map((p) => list.find((s) => s.path === p)?.id ?? "").filter(Boolean);
  return [...own, ...ids].filter((id, i, all) => all.indexOf(id) === i);
}

/** Ask whether the files Pi changed since that message may go back as well; null = cancelled */
async function planRewind(v: ChatView, tag: string, after: string[]): Promise<Plan | null> {
  const plan: Plan = { sessionIds: [], tag, paths: [], changes: [] };
  const path = v.target.path;
  if (!path || !tag) return plan;
  let paths: string[];
  try {
    const touched = await api.sessionTouches(v.target.hostId, path);
    const wanted = new Set(after);
    paths = [...new Set(touched.filter((m) => wanted.has(m.id)).flatMap((m) => m.paths))];
  } catch {
    // session_touches is not there (yet) or the file is unreadable: only the conversation goes back
    return (await confirmFiles(null)) ? plan : null;
  }
  if (!paths.length) return (await confirmFiles(null)) ? plan : null;
  const sessionIds = await familyIds(v);
  try {
    const preview = await api.rewindPreview(v.target.hostId, v.target.cwd, sessionIds, tag, paths);
    if (!preview.repo || !preview.commit || !preview.changes.length) return (await confirmFiles(null)) ? plan : null;
    return (await confirmFiles(preview.changes)) ? { sessionIds, tag, paths, changes: preview.changes } : null;
  } catch (e) {
    toast(`${t("Files")}: ${errMsg(e)}`, "err");
    return null;
  }
}

async function applyRewind(v: ChatView, plan: Plan): Promise<{ cwd: string; commit: string; paths: string[] } | null> {
  try {
    const res = await api.rewindRestore(v.target.hostId, v.target.cwd, plan.sessionIds, plan.tag, plan.paths);
    if (!res) {
      toast(t("No file state for this point – only the conversation went back."));
      return null;
    }
    const done = res.restored.length + res.deleted.length;
    if (res.failed.length) toast(t("{n} files restored, {failed} failed.", { n: done, failed: res.failed.length }), "err");
    else if (done) toast(t("{n} files restored.", { n: done }));
    return res.backup ? { cwd: v.target.cwd, commit: res.backup, paths: plan.paths } : null;
  } catch (e) {
    toast(`${t("Files")}: ${errMsg(e)}`, "err");
    return null;
  }
}

/** Confirm going back; with the list of files that go back to the state before (null = only the conversation) */
function confirmFiles(changes: RewindChange[] | null): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    const body = changes
      ? h(
          "div",
          {},
          h("p", {}, t("These files go back to the state before this message:")),
          h(
            "ul",
            { class: "rewind-list" },
            ...changes.map((c) => h("li", {}, h("span", { class: `rewind-status s-${c.status}` }, c.status), h("span", { class: "rewind-path" }, c.path))),
          ),
          h("p", { class: "muted small" }, t("M changed · A created (goes away) · D deleted (comes back)")),
        )
      : h("p", {}, t("Go back to the state after this message and its answer?"));
    const close = openModal(
      changes ? t("Go back and restore files") : t("Go back"),
      body,
      [
        button(t("Cancel"), () => close()),
        button(
          t("Go back"),
          () => {
            ok = true;
            close();
          },
          "primary",
        ),
      ],
      () => resolve(ok),
    );
  });
}

// ------------------------------------------------------------------ subagents (subagents.ts)

/** "New subagent …": pick an agent of the host, a model and a task; it runs as a session of its own */
export function subagentDialog(v: ChatView) {
  const s = v.session;
  api
    .listAgents(v.target.hostId, v.target.cwd || "~")
    .then((agents) => {
      if (!agents.length) {
        toast(t("No agents found. Put Markdown definitions in ~/.pi/agent/agents on the host."), "err");
        return;
      }
      const sel = h("select", {}, ...agents.map((a) => h("option", { value: a.name }, `${a.name} (${a.source})`)));
      const desc = h("p", { class: "muted small" });
      const task = h("textarea", { rows: 4, placeholder: t("Task for the agent …") });
      const modelSel = h("select", {});
      const fill = () => {
        const a = agents.find((x) => x.name === sel.value);
        desc.textContent = a?.description ?? "";
        const opts: HTMLElement[] = [];
        if (a?.model) opts.push(h("option", { value: "agent" }, `${t("Model of the agent")}: ${a.model}`));
        opts.push(h("option", { value: "session" }, t("Same model as this session")));
        const groups = new Map<string, HTMLElement>();
        for (const m of s.models) {
          let g = groups.get(m.provider);
          if (!g) {
            g = h("optgroup", { label: m.provider });
            groups.set(m.provider, g);
            opts.push(g);
          }
          g.append(h("option", { value: `${m.provider}/${m.id}` }, m.name || m.id));
        }
        modelSel.replaceChildren(...opts);
        modelSel.value = a?.model ? "agent" : "session";
      };
      sel.addEventListener("change", fill);
      fill();
      const start = () => {
        const a = agents.find((x) => x.name === sel.value);
        const text = task.value.trim();
        if (!a || !text) return;
        close();
        void openAgentSession(v, a, text, modelSel.value).catch((e: unknown) => toast(errMsg(e), "err"));
      };
      const close = openModal(
        t("New subagent"),
        h(
          "div",
          { class: "form" },
          h("label", { class: "field" }, h("span", { class: "field-label" }, t("Agent")), sel),
          desc,
          h("label", { class: "field" }, h("span", { class: "field-label" }, t("Model")), modelSel),
          task,
          h(
            "p",
            { class: "muted small" },
            t(
              "Starts a session of its own in the folder of this session, with the agent's tools and system prompt and the chosen model (default: the agent's model, otherwise this session's model). It appears indented under this session.",
            ),
          ),
        ),
        [button(t("Cancel"), () => close()), button(t("Start"), start, "primary")],
      );
    })
    .catch((e: unknown) => toast(errMsg(e), "err"));
}

async function openAgentSession(v: ChatView, agent: AgentInfo, task: string, choice: string) {
  const s = v.session;
  const prompt = await api.agentPromptFile(v.target.hostId, agent.path);
  const m = resolveAgentModel(choice, agent.model, s.model ?? s.savedModel(), s.models);
  const target: ChatTarget = { hostId: v.target.hostId, hostName: v.target.hostName, path: null, cwd: v.target.cwd, title: agent.name };
  setStartOptions(target, {
    model: m ? `${m.provider}/${m.id}` : undefined,
    tools: agent.tools ?? null,
    appendPrompt: prompt,
    task,
    // the link to the parent and the agent belong to the session (the session list indents it under its parent)
    meta: {
      name: agent.name,
      parentKey: s.key ?? undefined,
      agentName: agent.name,
      agentPrompt: prompt,
      tools: agent.tools ?? undefined,
    },
  });
  openChat(target);
}
