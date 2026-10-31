// Quick launcher: floating input bar (window "quick", opened by hotkey from src-tauri/src/quick.rs)
import "./quick.css";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, AppConfig, SessionInfo, QuickTarget, QuickSubmit, ModelInfo } from "../shared/api";
import { cleanTitle, shortModel, shortPath, thinkingLabel, THINKING_LEVELS } from "../shared/format";
import { setLang, t, translateDom } from "../shared/i18n";

interface Capture {
  path: string;
  data: string;
  mimeType: string;
}

const $ = (id: string) => document.getElementById(id)!;
const input = $("q-input") as HTMLTextAreaElement;
const target = $("q-target") as HTMLSelectElement;
const sendBtn = $("q-send") as HTMLButtonElement;
const attach = $("q-attach");
const thumb = $("q-thumb") as HTMLImageElement;
const ocrInfo = $("q-ocr");
const modelSel = $("q-model") as HTMLSelectElement;
const effortSel = $("q-effort") as HTMLSelectElement;
const modelsByHost = new Map<string, ModelInfo[] | "loading" | "error">();
const LAST_MODEL = "pibar.quick.model";
const LAST_EFFORT = "pibar.quick.effort";
const RECENT_MODELS = "pibar.quick.recentModels";

let config: AppConfig | null = null;
const sessions = new Map<string, SessionInfo[]>();
let activeSession: { hostId: string; path: string | null; title: string } | null = null;
let capture: Capture | null = null;
let mode: "image" | "ocr" | "both" = "image";
let ocrText: string | null = null;
let ocrRunning: Promise<string | null> | null = null;
let busy = false; // do not close on focus loss while a screenshot is taken

const LAST_TARGET = "pibar.quick.lastTarget";

function lastTarget(): string | null {
  try {
    return localStorage.getItem(LAST_TARGET);
  } catch {
    return null;
  }
}

function store(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ---------- Model & thinking ----------

function targetHostId(): string | undefined {
  const v = target.value;
  if (v === "active") return activeSession?.hostId;
  return v.split("|")[1];
}

function loadModels() {
  const hostId = targetHostId();
  if (!hostId) return renderModels();
  if (!modelsByHost.has(hostId)) {
    modelsByHost.set(hostId, "loading");
    api
      .listModels(hostId)
      .then((list) => modelsByHost.set(hostId, list))
      .catch(() => modelsByHost.set(hostId, "error"))
      .finally(renderModels);
  }
  renderModels();
}

function renderModels() {
  const hostId = targetHostId();
  const entry = hostId ? modelsByHost.get(hostId) : undefined;
  const prev = modelSel.value || store(LAST_MODEL) || "";
  const opt = (value: string, label: string) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  };
  const opts: HTMLElement[] = [opt("", t("Model: default"))];
  if (entry === "loading") opts.push(opt("", t("Loading models …")));
  if (Array.isArray(entry)) {
    const keys = new Set(entry.map((m) => `${m.provider}/${m.id}`));
    const recent = (store(RECENT_MODELS) || "").split("\n").filter((k) => keys.has(k));
    if (recent.length) {
      const g = document.createElement("optgroup");
      g.label = t("Recent");
      recent.forEach((k) => g.append(opt(k, shortModel(k.split("/").slice(1).join("/")))));
      opts.push(g);
    }
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const m of entry) {
      let g = groups.get(m.provider);
      if (!g) {
        g = document.createElement("optgroup");
        g.label = m.provider;
        groups.set(m.provider, g);
        opts.push(g);
      }
      g.append(opt(`${m.provider}/${m.id}`, shortModel(m.id)));
    }
  }
  modelSel.replaceChildren(...opts);
  const values = [...modelSel.options].map((o) => o.value);
  modelSel.value = values.includes(prev) ? prev : "";
  renderEffort();
}

function selectedModel(): ModelInfo | null {
  const v = modelSel.value;
  const entry = modelsByHost.get(targetHostId() ?? "");
  if (!v || !Array.isArray(entry)) return null;
  return entry.find((m) => `${m.provider}/${m.id}` === v) ?? null;
}

function renderEffort() {
  const prev = effortSel.value || store(LAST_EFFORT) || "";
  const m = selectedModel();
  const levels: string[] = m && !m.thinking ? ["off"] : [...THINKING_LEVELS];
  const o0 = document.createElement("option");
  o0.value = "";
  o0.textContent = t("Thinking: default");
  effortSel.replaceChildren(
    o0,
    ...levels.map((l) => {
      const o = document.createElement("option");
      o.value = l;
      o.textContent = `${t("Thinking")}: ${thinkingLabel(l)}`;
      return o;
    }),
  );
  effortSel.value = levels.includes(prev) ? prev : "";
  modelSel.classList.toggle("set", !!modelSel.value);
  effortSel.classList.toggle("set", !!effortSel.value);
}

modelSel.addEventListener("change", () => {
  store(LAST_MODEL, modelSel.value);
  renderEffort();
  input.focus();
});
effortSel.addEventListener("change", () => {
  store(LAST_EFFORT, effortSel.value);
  renderEffort();
  input.focus();
});
target.addEventListener("change", () => {
  loadModels();
  input.focus();
});

// ---------- Size ----------

let lastHeight = 0;
let lastLen = -1;

/** Grow the text field with its content and resize the window only when its height really changes.
 *  (Resizing on every keystroke made typing stutter and could steal focus on macOS.) */
function fit() {
  const len = input.value.length;
  if (len < lastLen || len === 0) {
    // text got shorter: measure from scratch so the field can shrink again
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  } else if (input.scrollHeight > input.clientHeight + 1) {
    // text overflows: grow (no collapse in between, so no jumping)
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }
  lastLen = len;
  requestAnimationFrame(() => {
    const height = Math.ceil($("qbar").getBoundingClientRect().bottom + 18);
    if (Math.abs(height - lastHeight) < 2) return;
    lastHeight = height;
    const hadFocus = document.activeElement === input;
    invoke("quick_resize", { height })
      .then(() => hadFocus && document.activeElement !== input && input.focus())
      .catch(() => {});
  });
}

// ---------- Targets ----------

function renderTargets() {
  const prev = target.value || lastTarget() || "";
  const opts: HTMLElement[] = [];
  if (activeSession) {
    const o = document.createElement("option");
    o.value = "active";
    o.textContent = `${t("Current")}: ${cleanTitle(activeSession.title) || t("Session")}`.slice(0, 48);
    opts.push(o);
  }
  const gNew = document.createElement("optgroup");
  gNew.label = t("New session");
  for (const h of config?.hosts ?? []) {
    const o = document.createElement("option");
    o.value = `new|${h.id}`;
    o.textContent = `${t("New")} · ${h.name}`;
    gNew.append(o);
  }
  opts.push(gNew);

  const recent = [...sessions.entries()]
    .flatMap(([hostId, list]) => list.slice(0, 6).map((s) => ({ hostId, s })))
    .sort((a, b) => (b.s.timestamp > a.s.timestamp ? 1 : -1))
    .slice(0, 10);
  if (recent.length) {
    const g = document.createElement("optgroup");
    g.label = t("Recent sessions");
    for (const { hostId, s } of recent) {
      const host = config?.hosts.find((h) => h.id === hostId);
      const o = document.createElement("option");
      o.value = `sess|${hostId}|${s.path}`;
      o.textContent = `${cleanTitle(s.name || s.title).slice(0, 34)} · ${host?.name ?? hostId}`;
      o.title = `${s.title}\n${shortPath(s.cwd)}`;
      g.append(o);
    }
    opts.push(g);
  }
  target.replaceChildren(...opts);
  const values = [...target.options].map((o) => o.value);
  target.value = values.includes(prev) ? prev : (values.find((v) => v.startsWith("new|")) ?? values[0] ?? "");
  loadModels();
}

function resolveTarget(): QuickTarget {
  const v = target.value;
  if (v === "active") return { kind: "active" };
  const [kind, hostId, ...rest] = v.split("|");
  if (kind === "sess") {
    const path = rest.join("|");
    const s = sessions.get(hostId)?.find((x) => x.path === path);
    return { kind: "session", hostId, path, cwd: s?.cwd ?? "~", title: s?.name || s?.title || "" };
  }
  const host = config?.hosts.find((h) => h.id === hostId);
  return { kind: "new", hostId, cwd: host?.defaultDir || "~" };
}

async function refresh() {
  config = await api.getConfig();
  renderTargets();
  // Load sessions in the background (SSH may take a while)
  for (const h of config.hosts) {
    api
      .listSessions(h.id)
      .then((list) => {
        sessions.set(h.id, list);
        renderTargets();
      })
      .catch(() => {});
  }
  emit("quick-request-active").catch(() => {});
}

// ---------- Screenshot & OCR ----------

async function takeShot(full: boolean) {
  busy = true;
  try {
    const c = await invoke<Capture | null>("capture_screen", { mode: full ? "screen" : "region" });
    if (!c) return; // cancelled
    capture = c;
    ocrText = null;
    ocrRunning = null;
    thumb.src = `data:${c.mimeType};base64,${c.data}`;
    attach.hidden = false;
    setMode(mode);
  } catch (e) {
    ocrInfo.textContent = String(e);
    attach.hidden = false;
  } finally {
    busy = false;
    input.focus();
    fit();
  }
}

function runOcr(): Promise<string | null> {
  if (!capture) return Promise.resolve(null);
  if (ocrText !== null) return Promise.resolve(ocrText);
  if (!ocrRunning) {
    ocrInfo.textContent = t("Recognising text … (takes longer the first time)");
    ocrRunning = invoke<string>("ocr_image", { path: capture.path })
      .then((txt) => {
        ocrText = txt;
        ocrInfo.textContent = txt
          ? `${t("{n} characters recognised", { n: txt.length })}: ${txt.replace(/\s+/g, " ").slice(0, 120)}`
          : t("No text recognised");
        return txt;
      })
      .catch((e) => {
        ocrInfo.textContent = `${t("OCR failed")}: ${e}`;
        return null;
      });
  }
  return ocrRunning;
}

function setMode(m: typeof mode) {
  mode = m;
  document
    .querySelectorAll<HTMLButtonElement>("#q-mode button")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  if (m === "image") ocrInfo.textContent = t("The image goes to Pi (the model must support images).");
  else runOcr();
  input.focus();
  fit();
}

function clearAttachment() {
  capture = null;
  ocrText = null;
  ocrRunning = null;
  attach.hidden = true;
  fit();
}

// ---------- Send ----------

async function submit() {
  const text = input.value.trim();
  if (!text && !capture) return;
  sendBtn.disabled = true;
  try {
    let ocr: string | null = null;
    if (capture && mode !== "image") ocr = await runOcr();
    const images = capture && mode !== "ocr" ? [{ data: capture.data, mimeType: capture.mimeType }] : [];
    const m = selectedModel();
    if (m) {
      const key = `${m.provider}/${m.id}`;
      const recent = [key, ...(store(RECENT_MODELS) || "").split("\n").filter((k) => k && k !== key)].slice(0, 5);
      store(RECENT_MODELS, recent.join("\n"));
    }
    const payload: QuickSubmit = {
      target: resolveTarget(),
      model: m ? { provider: m.provider, id: m.id } : null,
      thinking: effortSel.value || null,
      text: text || t("Have a look at the screenshot."),
      images,
      ocr,
    };
    try {
      localStorage.setItem(LAST_TARGET, target.value);
    } catch {
      /* egal */
    }
    await emit("quick-submit", payload);
    input.value = "";
    clearAttachment();
    await invoke("quick_hide");
  } finally {
    sendBtn.disabled = false;
  }
}

// ---------- Wiring ----------

input.addEventListener("input", fit);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    invoke("quick_hide");
  } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "2" || e.code === "Digit2")) {
    e.preventDefault();
    takeShot(false);
  }
});
sendBtn.addEventListener("click", submit);
$("q-shot").addEventListener("click", (e) => takeShot((e as MouseEvent).shiftKey));
$("q-remove").addEventListener("click", clearAttachment);
document
  .querySelectorAll<HTMLButtonElement>("#q-mode button")
  .forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode as typeof mode)));

listen("quick-show", () => {
  for (const [k, v] of modelsByHost) if (v === "error") modelsByHost.delete(k);
  input.focus();
  input.select();
  refresh().catch(() => {});
  fit();
});
listen<{ hostId: string; path: string | null; title: string } | null>("main-active", (e) => {
  activeSession = e.payload;
  renderTargets();
});

getCurrentWindow()
  .onFocusChanged(({ payload: focused }) => {
    // An open dropdown (target, model, thinking) briefly takes focus from the window: do not close then
    const selectOpen = () => document.activeElement?.tagName === "SELECT";
    if (!focused && !busy && !selectOpen())
      setTimeout(() => !busy && !selectOpen() && !document.hasFocus() && invoke("quick_hide"), 120);
  })
  .catch(() => {});

// Re-render in the new language when it is changed in the main window
listen("language-changed", () => window.location.reload());

api
  .getConfig()
  .then((cfg) => {
    setLang(cfg.ui.language);
    translateDom();
  })
  .finally(() => {
    refresh().catch(() => {});
    fit();
  });
