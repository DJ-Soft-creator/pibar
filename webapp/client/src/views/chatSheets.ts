// Bottom sheets of the chat: model and presets (presets as big buttons first, then the host's models by provider
// with a filter, then the thinking level), the session options behind "⋯" (plan/build, view, answer style, context
// mode, temperature, background, name, subagent, diagnosis), and the details of the status line (usageStats.ts).
import type { ChatMode } from "@shared/api";
import { VIEWS } from "@shared/chatViews";
import { CONTEXT_SECTIONS } from "@shared/contextMode";
import { copyText, errMsg, h, openModal, toast } from "@shared/dom";
import { footerParts, shortModel, thinkingLabel, type FooterStats } from "@shared/format";
import { t, type Msg } from "@shared/i18n";
import { matchPreset } from "@shared/presets";
import { formatTemp, TEMP_MAX, TEMP_MIN, TEMP_NEUTRAL, TEMP_STEP, tempHint } from "@shared/temperature";
import { button } from "../ui";
import type { ChatSession } from "./chatSession";
import { chatSettings, saveChatSettings, type AnswerMode } from "./chatStore";

/** Label of the model chip in the header: preset name, else the short model id (and the thinking level) */
export function modelLabel(s: ChatSession): string {
  const preset = s.presetId ? s.shared.presets.find((p) => p.id === s.presetId) : undefined;
  if (preset) return preset.name;
  if (!s.model) return t("Model");
  const lvl = s.thinkingLevel && s.thinkingLevel !== "off" && s.model.reasoning ? ` · ${thinkingLabel(s.thinkingLevel)}` : "";
  return `${shortModel(s.model.id)}${lvl}`;
}

/** The preset that describes what runs now (the chosen one, else the first that fits model and level) */
function activePreset(s: ChatSession): string {
  if (s.presetId) return s.presetId;
  const m = s.model ? `${s.model.provider}/${s.model.id}` : "";
  return matchPreset(s.shared.presets, m, s.thinkingLevel)?.id ?? "";
}

/** Model, presets and thinking level of the session */
export function modelSheet(s: ChatSession) {
  const body = h("div", { class: "model-sheet" });
  const render = () => {
    const current = s.model ? `${s.model.provider}/${s.model.id}` : "";
    const preset = activePreset(s);
    const parts: (HTMLElement | null)[] = [];
    if (s.streaming) parts.push(h("p", { class: "muted small" }, t("The new model applies from the next message; the running answer keeps the old one.")));
    // presets first: one tap sets model and thinking level together
    if (s.shared.presets.length) {
      parts.push(
        h("h4", {}, t("Presets")),
        h(
          "div",
          { class: "preset-grid" },
          ...s.shared.presets.map((p) =>
            h(
              "button",
              {
                type: "button",
                class: `preset-btn ${p.id === preset ? "on" : ""}`,
                "aria-pressed": p.id === preset ? "true" : "false",
                onclick: () => void s.setPreset(p.id).then(render),
              },
              h("span", { class: "preset-name" }, p.name),
              h("span", { class: "preset-sub" }, [p.model ? shortModel(p.model.split("/").slice(1).join("/")) : "", p.thinking ? thinkingLabel(p.thinking) : ""].filter(Boolean).join(" · ")),
            ),
          ),
        ),
      );
    }
    // thinking level of the current model
    if (s.levels.length > 1) {
      parts.push(
        h("h4", {}, t("Thinking")),
        h(
          "div",
          { class: "seg" },
          ...s.levels.map((l) =>
            h(
              "button",
              { type: "button", class: l === s.thinkingLevel ? "on" : "", onclick: () => void s.setThinking(l).then(render).catch((e: unknown) => toast(errMsg(e), "err")) },
              thinkingLabel(l),
            ),
          ),
        ),
      );
    }
    // the models of the running Pi (by provider), else those of `pi --list-models`
    const list = s.models.length
      ? s.models.map((m) => ({ provider: m.provider, id: m.id, name: m.name || m.id, reasoning: !!m.reasoning }))
      : s.hostModels.map((m) => ({ provider: m.provider, id: m.id, name: m.id, reasoning: m.thinking }));
    const filter = h("input", { type: "search", placeholder: t("Filter models …"), class: "model-filter" });
    const rows = h("div", { class: "model-list" });
    const fill = () => {
      const q = filter.value.trim().toLowerCase();
      const groups = new Map<string, HTMLElement[]>();
      for (const m of list) {
        if (q && !`${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q)) continue;
        const key = `${m.provider}/${m.id}`;
        const row = h(
          "button",
          {
            type: "button",
            class: `model-row ${key === current ? "on" : ""}`,
            onclick: () =>
              void s
                .setModel(m.provider, m.id)
                .then(render)
                .catch((e: unknown) => toast(`${t("Model")}: ${errMsg(e)}`, "err")),
          },
          h("span", { class: "model-name" }, m.name),
          h("span", { class: "model-id" }, m.id !== m.name ? m.id : ""),
          m.reasoning ? h("span", { class: "model-tag", title: t("Thinking") }, "🧠") : null,
          key === current ? h("span", { class: "model-check" }, "✓") : null,
        );
        groups.set(m.provider, [...(groups.get(m.provider) ?? []), row]);
      }
      rows.replaceChildren(
        ...[...groups].flatMap(([prov, r]) => [h("div", { class: "model-prov" }, prov), ...r]),
        ...(groups.size ? [] : [h("p", { class: "muted" }, list.length ? t("No match") : t("Loading …"))]),
      );
    };
    filter.addEventListener("input", fill);
    fill();
    parts.push(h("h4", {}, t("Models")), list.length > 8 ? filter : null, rows);
    parts.push(h("p", { class: "muted small" }, t("The choice is kept for this session and applied again when it is opened.")));
    body.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
  };
  render();
  const close = openModal(t("Model"), body, [button(t("Close"), () => close(), "primary")], undefined, "sheet-tall");
}

// ------------------------------------------------------------------ the "⋯" sheet

export interface OptionActions {
  rename(): void;
  newSubagent(): void;
  diagnose(): void;
  details(): void;
  stats(): void;
  newSession(): void;
  stopBackground(): void;
}

const ANSWERS: [AnswerMode, Msg][] = [
  ["short", "Short"],
  ["normal", "Normal"],
  ["technical", "Technical"],
];

function seg<T extends string>(items: [T, string][], cur: T, pick: (v: T) => void): HTMLElement {
  return h(
    "div",
    { class: "seg" },
    ...items.map(([v, label]) => h("button", { type: "button", class: v === cur ? "on" : "", "aria-pressed": v === cur ? "true" : "false", onclick: () => pick(v) }, label)),
  );
}

export function optionsSheet(s: ChatSession, act: OptionActions) {
  const body = h("div", { class: "opt-sheet" });
  let close = () => {};
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  const render = () => {
    const view: ChatMode = s.viewMode();
    const parts: (HTMLElement | null)[] = [
      h("h4", {}, t("Mode")),
      seg<"plan" | "build">(
        [
          ["plan", t("Plan")],
          ["build", t("Build")],
        ],
        s.planMode ? "plan" : "build",
        (v) => void s.setPlanMode(v === "plan").then(render),
      ),
      h("p", { class: "muted small" }, s.planMode ? t("Plan mode: Pi only reads and writes a plan.") : t("Build mode: Pi may change files again.")),
      h("h4", {}, t("View")),
      seg<ChatMode>(
        VIEWS.map(([v, label]) => [v, t(label)]),
        view,
        (v) => void s.setViewMode(v).then(render),
      ),
      h("p", { class: "muted small" }, t((VIEWS.find((x) => x[0] === view) ?? VIEWS[1])[2])),
      view !== (chatSettings().chatMode ?? "technical")
        ? h("button", { type: "button", class: "link-btn", onclick: () => void saveChatSettings({ chatMode: view }).then(render) }, t("Use this view for all chats"))
        : null,
      h("h4", {}, t("Answer style (all chats)")),
      seg<AnswerMode>(
        ANSWERS.map(([v, l]) => [v, t(l)]),
        chatSettings().answerMode ?? "normal",
        (v) => void saveChatSettings({ answerMode: v }).then(render),
      ),
    ];
    // context mode: only when the host runs Pi's mode-guard extension
    if (s.contextAvailable()) {
      parts.push(
        h("h4", {}, t("Context mode")),
        seg<"private" | "public">(
          [
            ["private", t("Private")],
            ["public", t("Public")],
          ],
          s.contextMode === "public" ? "public" : "private",
          (v) => void s.setContextMode(v).then(render),
        ),
      );
      if (s.contextMode === "public") {
        parts.push(
          h(
            "div",
            { class: "ctx-sections" },
            ...CONTEXT_SECTIONS.map((name) => {
              const box = h("input", { type: "checkbox" });
              box.checked = !s.contextStripped.includes(name);
              box.addEventListener("change", () => void s.setContextSection(name, box.checked).then(render));
              return h("label", { class: "q-check" }, box, h("span", {}, name));
            }),
          ),
        );
      }
    }
    // temperature: needs the pibar-temperature extension on the host
    parts.push(h("h4", {}, t("Temperature")));
    if (s.tempAvailable()) {
      const v = s.temperature ?? TEMP_NEUTRAL;
      const label = h("span", { class: "temp-val" }, s.temperature === null ? t("Model default") : formatTemp(v));
      const hint = h("p", { class: "muted small" }, s.temperature === null ? "" : t(tempHint(v)));
      const range = h("input", { type: "range", min: TEMP_MIN, max: TEMP_MAX, step: TEMP_STEP, class: "temp-range", "aria-label": t("Temperature") });
      range.value = String(v);
      range.addEventListener("input", () => {
        label.textContent = formatTemp(Number(range.value));
        hint.textContent = t(tempHint(Number(range.value)));
      });
      range.addEventListener("change", () => void s.setTemperature(Number(range.value)).then(render));
      parts.push(
        h("div", { class: "temp-row" }, range, label),
        hint,
        s.temperature !== null ? h("button", { type: "button", class: "link-btn", onclick: () => void s.setTemperature(null).then(render) }, t("Back to the model's default")) : null,
      );
    } else {
      parts.push(
        h("p", { class: "muted small" }, t("Needs PiBar's temperature extension on this host.")),
        h("button", {
          type: "button",
          class: "btn",
          onclick: () =>
            void s.installTemperature().then(
              () => toast(t("Temperature extension installed – Pi was restarted.")),
              (e: unknown) => toast(errMsg(e), "err"),
            ),
        }, t("Install extension")),
      );
    }
    parts.push(
      h("h4", {}, t("In the background")),
      h(
        "label",
        { class: "q-check" },
        (() => {
          const b = h("input", { type: "checkbox" });
          b.checked = s.background;
          b.addEventListener("change", () => void s.setBackground(b.checked));
          return b;
        })(),
        h("span", {}, t("Send messages of this session as runs in the background (they keep going when the phone is off).")),
      ),
      s.detached ? button(t("Stop the run in the background"), run(act.stopBackground), "danger") : null,
      h("h4", {}, t("Session")),
      h(
        "div",
        { class: "opt-list" },
        button(t("Rename …"), run(act.rename)),
        button(t("New subagent …"), run(act.newSubagent)),
        button(t("New session in this folder"), run(act.newSession)),
        button(t("Session statistics"), run(act.stats)),
        button(t("Diagnose"), run(act.diagnose)),
        button(t("Details"), run(act.details)),
      ),
    );
    body.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
  };
  render();
  close = openModal(t("Session options"), body, [button(t("Close"), () => close(), "primary")], undefined, "sheet-tall");
}

// ------------------------------------------------------------------ status line (usageStats.ts)

const HINTS: Record<string, Msg> = {
  input: "Input tokens",
  output: "Output tokens",
  cacheRead: "Read from the cache (share of the input in %)",
  cacheWrite: "Written to the cache",
  cost: "Cost of the session",
  context: "Context used / context window",
};

function footerStats(s: ChatSession): FooterStats {
  const pi = s.piStats;
  const l = s.live;
  const tok = pi?.tokens ?? {};
  const win = pi?.contextUsage?.contextWindow ?? s.model?.contextWindow ?? 0;
  const live = win && l.lastContext ? (l.lastContext / win) * 100 : null;
  return {
    input: tok.input ?? l.input,
    output: tok.output ?? l.output,
    cacheRead: tok.cacheRead ?? l.cacheRead,
    cacheWrite: tok.cacheWrite ?? l.cacheWrite,
    cost: typeof pi?.cost === "number" ? pi.cost : l.cost,
    contextPercent: pi?.contextUsage ? (pi.contextUsage.percent ?? null) : live,
    contextWindow: win,
  };
}

/** Status line under the input: Pi's footer numbers */
export function renderStatusLine(el: HTMLElement, s: ChatSession) {
  if (!s.alive || s.detached) {
    el.replaceChildren(s.detached ? h("span", { class: "us-part" }, t("In the background")) : "");
    return;
  }
  el.replaceChildren(...footerParts(footerStats(s)).map((p) => h("span", { class: `us-part ${p.level ?? ""}`, title: t(HINTS[p.hint] ?? "Tokens") }, p.text)));
}

/** Details sheet of the status line (tap): counters, cost, context use, session id */
export async function statsSheet(s: ChatSession) {
  await s.refreshStats();
  const pi = s.piStats;
  const l = s.live;
  const tok = pi?.tokens ?? {};
  const num = (n: number) => n.toLocaleString();
  const row = (label: string, value: string) => h("div", { class: "us-row" }, h("span", {}, label), h("span", { class: "us-val" }, value));
  const win = pi?.contextUsage?.contextWindow ?? s.model?.contextWindow ?? 0;
  const used = pi?.contextUsage?.tokens ?? l.lastContext;
  const pct = win && used ? Math.min(100, Math.round((used / win) * 100)) : null;
  const body = h(
    "div",
    { class: "us-sheet" },
    s.sessionId
      ? h(
          "button",
          { type: "button", class: "us-row us-id", onclick: () => void copyText(s.sessionId).then(() => toast(t("Copied"))) },
          h("span", {}, t("Session ID")),
          h("span", { class: "us-val" }, s.sessionId),
        )
      : null,
    s.model ? row(t("Model"), `${s.model.provider}/${s.model.id}${s.thinkingLevel ? ` · ${thinkingLabel(s.thinkingLevel)}` : ""}`) : null,
    h("h4", {}, t("Tokens")),
    row(t("Input"), num(tok.input ?? l.input)),
    row(t("Output"), num(tok.output ?? l.output)),
    row(t("Cache read"), num(tok.cacheRead ?? l.cacheRead)),
    row(t("Cache write"), num(tok.cacheWrite ?? l.cacheWrite)),
    row(t("Total"), num(tok.total ?? l.input + l.output + l.cacheRead + l.cacheWrite)),
    row(t("Cost"), `$${(typeof pi?.cost === "number" ? pi.cost : l.cost).toFixed(4)}`),
    h("h4", {}, t("Context")),
    row(t("Used"), used ? (win ? `${num(used)} / ${num(win)}` : num(used)) : "–"),
    pct !== null ? h("div", { class: "us-bar" }, h("div", { class: `us-fill ${pct > 80 ? "hot" : ""}`, style: `width:${pct}%` })) : null,
    h("h4", {}, t("Messages")),
    row(t("Answers"), num(pi?.assistantMessages ?? l.responses)),
    pi ? row(t("Your messages"), num(pi.userMessages ?? 0)) : null,
    pi ? row(t("Tool calls"), num(pi.toolCalls ?? 0)) : null,
  );
  const close = openModal(t("Session statistics"), body, [button(t("Close"), () => close(), "primary")]);
}
