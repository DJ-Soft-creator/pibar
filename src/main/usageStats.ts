// Token info in the header: short summary plus a hover panel with counters, speed and context use.
// Counters come from SessionTab.stats (measured live) and Pi's get_session_stats (whole session).
import { h } from "../shared/dom";
import { fmtTokens, tokensPerSecond } from "../shared/format";
import { t } from "../shared/i18n";
import type { SessionTab } from "./sessionTab";
import { state } from "./state";

const num = (n: number) => n.toLocaleString();
const tps = (v: number | null) => (v === null ? "–" : t("{n} tok/s", { n: v }));

/** One line in the header, e.g. "12.3k tok. · $0.04 · 48 tok/s" */
export function usageSummary(tab: SessionTab | null): string {
  if (!tab || !tab.stats.total) return "";
  const parts = [fmtTokens(tab.stats.total), `$${tab.stats.cost.toFixed(2)}`];
  if (tab.stats.lastTps !== null) parts.push(tps(tab.stats.lastTps));
  return parts.join(" · ");
}

function row(label: string, value: string, cls = "") {
  return h("div", { class: `us-row ${cls}` }, h("span", {}, label), h("span", { class: "us-val" }, value));
}

/** Fill the hover panel; `pi` = answer of get_session_stats (if already loaded) */
function render(pop: HTMLElement, tab: SessionTab, pi: any) {
  const s = tab.stats;
  const tok = pi?.tokens ?? {};
  const input = tok.input ?? s.input;
  const output = tok.output ?? s.output;
  const cacheRead = tok.cacheRead ?? s.cacheRead;
  const cacheWrite = tok.cacheWrite ?? s.cacheWrite;
  const total = tok.total ?? s.total;
  const cost = typeof pi?.cost === "number" ? pi.cost : s.cost;
  const avg = tokensPerSecond(s.genTokens, s.genMs);
  const win = tab.model?.contextWindow ?? 0;
  const pct = win && s.lastContext ? Math.min(100, Math.round((s.lastContext / win) * 100)) : null;

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
    row(t("Used"), s.lastContext ? (win ? `${num(s.lastContext)} / ${num(win)}` : num(s.lastContext)) : "–"),
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
    render(pop, tab, null);
    if (!tab.alive) return;
    try {
      const pi = await tab.sessionStats();
      if (tab === state.active) render(pop, tab, pi);
    } catch {
      /* the live counters are enough */
    }
  });
}
