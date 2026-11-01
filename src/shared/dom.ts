// DOM helpers for both windows: element builder (h), Markdown rendering, toasts, modals
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

marked.setOptions({ gfm: true, breaks: false });

export function $(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e;
}

type Attrs = Record<string, string | boolean | number | ((ev: any) => void) | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "class") {
      el.className = String(v);
    } else if (v === true) {
      el.setAttribute(k, "");
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

export function renderMarkdown(target: HTMLElement, text: string) {
  const html = marked.parse(text, { async: false }) as string;
  target.innerHTML = DOMPurify.sanitize(html);
  target.querySelectorAll("pre code").forEach((code) => {
    try {
      hljs.highlightElement(code as HTMLElement);
    } catch {
      /* highlighting is optional */
    }
  });
  target.querySelectorAll("a").forEach((a) => a.setAttribute("target", "_blank"));
}

export function toast(msg: string, kind: "info" | "err" = "info", ms = 5000) {
  const t = h("div", { class: `toast ${kind === "err" ? "err" : ""}` }, msg);
  $("toasts").append(t);
  setTimeout(() => t.remove(), ms);
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Simple modal dialog. Returns a function that closes it. */
export function openModal(title: string, body: HTMLElement, actions: HTMLElement[]): () => void {
  const root = $("modal-root");
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const backdrop = h(
    "div",
    { class: "modal-backdrop", onmousedown: (e: MouseEvent) => e.target === backdrop && close() },
    h("div", { class: "modal" }, h("h3", {}, title), body, h("div", { class: "actions" }, ...actions)),
  );
  root.append(backdrop);
  document.addEventListener("keydown", onKey);
  const first = backdrop.querySelector("input, select, textarea") as HTMLElement | null;
  first?.focus();
  return close;
}

/** Copy text to the clipboard; falls back to a hidden textarea where the Clipboard API is not allowed */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* WebKit may refuse without permission: classic way below */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("Clipboard not available");
}
