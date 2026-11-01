// Status line under the input like Pi's footer (↑ input ↓ output R cache read W cache write, cost, context use), plus a
// hover panel with counters, speed and context use. Numbers come from Pi's get_session_stats (whole session);
// SessionTab.stats (measured live) fills in speed and serves as fallback.
import { h } from "../shared/dom";
import { footerParts, tokensPerSecond, type FooterPart, type FooterStats } from "../shared/format";
import { t, type Msg } from "../shared/i18n";
import type { PiSessionStats } from "../shared/piProtocol";
import type { SessionTab } from "./sessionTab";
import { state } from "./state";

const num = (n: number) => n.toLocaleString();
const tps = (v: number | null) => (v === null ? "–" : t("{n} tok/s", { n: v }));

/** Numbers for the status line: Pi's session stats, otherwise the live counters */
function footerStats(tab: SessionTab): FooterStats {
  const pi = tab.piStats;
  const s = tab.stats;
  const tok = pi?.tokens ?? {};
  const win = pi?.contextUsage?.contextWindow ?? tab.model?.contextWindow ?? 0;
  const live = win && s.lastContext ? (s.lastContext / win) * 100 : null;
  const pct = pi?.contextUsage ? (pi.contextUsage.percent ?? null) : live;
  return {
    input: tok.input ?? s.input,
    output: tok.output ?? s.output,
    cacheRead: tok.cacheRead ?? s.cacheRead,
    cacheWrite: tok.cacheWrite ?? s.cacheWrite,
    cost: typeof pi?.cost === "number" ? pi.cost : s.cost,
    contextPercent: pct,
    contextWindow: win,
  };
}

const HINTS: Record<FooterPart["hint"], Msg> = {
  input: "Input tokens",
  output: "Output tokens",
  cacheRead: "Read from the cache (share of the input in %)",
  cacheWrite: "Written to the cache",
  cost: "Cost of the session",
  context: "Context used / context window",
};

/** Status line under the input: Pi's numbers on the left, model and thinking level on the right */
export function renderUsage(left: HTMLElement, right: HTMLElement, tab: SessionTab | null) {
  if (!tab || !tab.alive) {
    left.replaceChildren();
    right.textContent = "";
    return;
  }
  left.replaceChildren(
    ...footerParts(footerStats(tab)).map((p) =>
      h("span", { class: `us-part ${p.level ?? ""}`, title: t(HINTS[p.hint]) }, p.text),
    ),
  );
  const m = tab.model;
  if (!m) {
    right.textContent = "";
    return;
  }
  const level = m.reasoning
    ? ` • ${tab.thinkingLevel && tab.thinkingLevel !== "off" ? tab.thinkingLevel : "thinking off"}`
    : "";
  right.textContent = `(${m.provider}) ${m.id}${level}`;
}

function row(label: string, value: string, cls = "") {
  return h("div", { class: `us-row ${cls}` }, h("span", {}, label), h("span", { class: "us-val" }, value));
}

/** Fill the hover panel; `pi` = answer of get_session_stats (if already loaded) */
function render(pop: HTMLElement, tab: SessionTab, pi: PiSessionStats | null) {
  const s = tab.stats;
  const tok = pi?.tokens ?? {};
  const input = tok.input ?? s.input;
  const output = tok.output ?? s.output;
  const cacheRead = tok.cacheRead ?? s.cacheRead;
  const cacheWrite = tok.cacheWrite ?? s.cacheWrite;
  const total = tok.total ?? s.total;
  const cost = typeof pi?.cost === "number" ? pi.cost : s.cost;
  const avg = tokensPerSecond(s.genTokens, s.genMs);
  // context: Pi's own numbers if it sends them, otherwise the last answer measured here
  const win = pi?.contextUsage?.contextWindow ?? tab.model?.contextWindow ?? 0;
  const used: number = pi?.contextUsage?.tokens ?? s.lastContext;
  const pct = win && used ? Math.min(100, Math.round((used / win) * 100)) : null;

  const rows: (HTMLElement | null)[] = [
    h("div", { class: "us-head" }, t("Session statistics")),
    h("div", { class: "us-sub" }, t("Tokens")),
    row(t("Input"), num(input)),
    row(t("Output"), num(output)),
    row(t("Cache read"), num(cacheRead)),
    row(t("Cache write"), num(cacheWrite)),
    row(t("Total"), num(total), "strong"),
    row(t("Cost"), `$${cost.toFixed(4)}`),
    h("div", { class: "us-sub" }, t("Speed")),
    row(t("Last answer"), tps(s.lastTps)),
    row(t("Average"), tps(avg)),
    row(t("Time to first token"), s.lastTtft === null ? "–" : `${(s.lastTtft / 1000).toFixed(1)} s`),
    row(t("Last answer tokens"), s.lastOutput ? num(s.lastOutput) : "–"),
    h("div", { class: "us-sub" }, t("Context")),
    row(t("Used"), used ? (win ? `${num(used)} / ${num(win)}` : num(used)) : "–"),
    pct !== null
      ? h(
          "div",
          { class: "us-bar", title: `${pct} %` },
          h("div", { class: `us-fill ${pct > 80 ? "hot" : ""}`, style: `width:${pct}%` }),
        )
      : null,
    h("div", { class: "us-sub" }, t("Messages")),
    row(t("Answers"), num(pi?.assistantMessages ?? s.responses)),
    pi ? row(t("Your messages"), num(pi.userMessages ?? 0)) : null,
    pi ? row(t("Tool calls"), num(pi.toolCalls ?? 0)) : null,
    h("div", { class: "us-foot" }, t("Speed is measured live in this window (output tokens per second).")),
  ];
  pop.replaceChildren(...rows.filter((r): r is HTMLElement => r !== null));
}

/** Hover over the token info: show the panel at once and refresh it with Pi's session stats */
export function wireUsage(wrap: HTMLElement, pop: HTMLElement) {
  wrap.addEventListener("mouseenter", async () => {
    const tab = state.active;
    if (!tab) return;
    render(pop, tab, tab.piStats);
    if (!tab.alive) return;
    try {
      const pi = await tab.sessionStats();
      if (tab === state.active) render(pop, tab, pi);
    } catch {
      /* the live counters are enough */
    }
  });
}
