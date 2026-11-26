// State of the open chat's session and everything that talks to Pi about it (no DOM): the Pi process (pi_attach,
// live or a followed run in the background), model, thinking level and preset per session (saved in the session
// metadata and applied again when the session opens), plan mode, context mode, temperature, chat view, queue,
// statistics, branches and sending (answer style, plan hint, file states before a message).
// Behaviour follows SessionTab in src/main/sessionTab.ts (applyChoice, adoptChoice, sendToBackground …).
import { api, type ChatMode, type ModelInfo, type PiCommand, type PiModel, type Project, type SessionMeta } from "@shared/api";
import { isChatMode } from "@shared/chatViews";
import {
  CONTEXT_SECTIONS,
  contextModeCommand,
  contextSectionCommand,
  isContextMode,
  parseContextStatus,
  startContextMode,
  type ContextMode,
} from "@shared/contextMode";
import { errMsg, toast } from "@shared/dom";
import { withAnswerStyle } from "@shared/format";
import { t } from "@shared/i18n";
import type { PiEvent, PiSessionStats, Usage } from "@shared/piProtocol";
import { PLAN_TOOLS, withPlanMode } from "@shared/planMode";
import { resolveChoice, splitModelKey } from "@shared/presets";
import { projectAt } from "@shared/projects";
import { clampTemp, isTemp, parseTemperatureStatus, temperatureCommand } from "@shared/temperature";
import { invoke } from "../bridge";
import type { ChatTarget } from "../state";
import { chatSettings, loadMeta, patchSessionMeta, sharedConfig, type MetaView, type SharedConfig } from "./chatStore";

export type Image = { data: string; mimeType: string };
export type QueueWhen = "steer" | "followUp";

/** What a new session starts with (set by newSession.ts / the subagent dialog before the chat opens) */
export interface StartOptions {
  preset?: string;
  model?: string;
  thinking?: string;
  tools?: string[] | null;
  appendPrompt?: string | null;
  /** Metadata the session gets once it has a file (subagent link, name …) */
  meta?: SessionMeta;
  /** First message, sent as soon as Pi is ready */
  task?: string;
}

const starts = new WeakMap<ChatTarget, StartOptions>();

export function setStartOptions(target: ChatTarget, o: StartOptions) {
  starts.set(target, o);
}

interface Attached {
  handle: number;
  joined: boolean;
  streaming: boolean;
  seq: number;
}

/** Live counters of this chat (fallback for the status line when Pi has no get_session_stats) */
export interface LiveStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  lastContext: number;
  responses: number;
}

export interface SessionCallbacks {
  /** Something of the session state changed (header, status line, buttons) */
  changed(): void;
  /** Same process, other history (fork, other branch): clear the view and load the history again */
  reload(): Promise<void>;
  /** The process was closed (tools changed): start Pi again, then show the history and apply the choices */
  reattach(): Promise<void>;
  /** A followed run in the background ended: the chat starts Pi again on the session file */
  backgroundDone(ok: boolean, stderr: string): void;
}

export class ChatSession {
  handle = 0;
  seq = 0;
  alive = false;
  streaming = false;
  /** The handle is a follower of a run in the background (no commands, only events) */
  detached = false;
  model: PiModel | null = null;
  thinkingLevel = "";
  sessionId = "";
  /** Models of the running Pi (get_available_models) */
  models: PiModel[] = [];
  /** Models of the host without a session (`pi --list-models`), for capabilities (images) and as a fallback */
  hostModels: ModelInfo[] = [];
  levels: string[] = [];
  commands: PiCommand[] = [];
  /** Preset of this session: id, "" = own model and thinking level */
  presetId = "";
  piStats: PiSessionStats | null = null;
  live: LiveStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, lastContext: 0, responses: 0 };
  queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
  contextMode: ContextMode = "";
  contextStripped: string[] = [];
  temperature: number | null = null;
  planMode = false;
  /** Every message goes to the background (session meta "background", else the user's setting) */
  background = false;
  /** Saved metadata of this session (local copy; written through patchSessionMeta) */
  meta: SessionMeta = {};
  project: Project | undefined;
  shared: SharedConfig = { presets: [], quickActions: [] };
  /** Pi's name of the session (get_state sessionName) */
  name = "";
  private contextStatusSeen = false;
  private tempStatusSeen = false;
  private contextApplied = false;
  private tempApplied = false;
  private settling: Promise<unknown> = Promise.resolve();
  private snapshotOff = false;
  private bgSettled = false;
  private bgStopWanted = false;
  /** Fields chosen before the session had a file; written once Pi saved it */
  private pendingMeta: Partial<Record<keyof SessionMeta, unknown>> = {};
  private readonly start: StartOptions;

  constructor(
    readonly target: ChatTarget,
    private readonly cb: SessionCallbacks,
  ) {
    this.start = starts.get(target) ?? {};
  }

  get key(): string | null {
    return this.target.path ? `${this.target.hostId}|${this.target.path}` : null;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Read metadata and shared settings, then start or join Pi (or follow a run in the background) */
  async open(): Promise<Attached> {
    const [view, shared] = await Promise.all([loadMeta().catch((): MetaView => ({ sessionMeta: {}, projects: [] })), sharedConfig()]);
    this.shared = shared;
    this.project = projectAt(view.projects, this.target.hostId, this.target.cwd || "~");
    this.meta = (this.key ? view.sessionMeta[this.key] : undefined) ?? { ...(this.start.meta ?? {}) };
    if (!this.key && this.start.meta) this.pendingMeta = { ...this.start.meta };
    this.planMode = !!this.meta.planMode;
    this.background = this.meta.background === "on" ? true : this.meta.background === "off" ? false : !!chatSettings().background;
    // a run in the background of this session (started here, on the desktop or on another device): follow it
    if (this.target.path) {
      const running = await api.bgRunning(this.target.hostId, this.target.path).catch(() => false);
      if (running) return this.follow();
    }
    return this.attach();
  }

  private toolset(): string[] | null {
    if (this.planMode) return [...PLAN_TOOLS];
    if (this.start.tools !== undefined) return this.start.tools;
    return this.meta.tools ?? null;
  }

  async attach(): Promise<Attached> {
    const a = await invoke<Attached>("pi_attach", {
      hostId: this.target.hostId,
      cwd: this.target.cwd || "~",
      sessionPath: this.target.path,
      tools: this.toolset(),
      appendPrompt: this.start.appendPrompt ?? this.meta.agentPrompt ?? null,
    });
    this.handle = a.handle;
    this.seq = a.seq;
    this.alive = true;
    this.detached = false;
    this.streaming = a.streaming;
    this.contextStatusSeen = false;
    this.tempStatusSeen = false;
    return a;
  }

  /** After the history is shown: Pi's state, models, commands, and the saved choices of the session */
  async ready(joined: boolean) {
    if (this.detached) return;
    await this.refreshState().catch(() => {});
    await this.refreshModels();
    void this.refreshStats();
    void api
      .listModels(this.target.hostId)
      .then((m) => {
        this.hostModels = m;
        this.cb.changed();
      })
      .catch(() => {});
    await this.applyChoice();
    // a joined process has the mode and temperature already (pushed by whoever started it)
    if (!joined && !this.streaming) {
      await this.applyContext();
      await this.applyTemperature();
    }
    this.cb.changed();
    const task = this.start.task;
    if (task && !joined) {
      this.start.task = undefined;
      await this.send(task);
    }
  }

  /** Close this process and start it again (tools changed, Pi crashed); the model chosen here stays */
  async restart() {
    const model = this.model;
    const thinking = this.thinkingLevel;
    if (this.handle) await api.piClose(this.handle).catch(() => {});
    this.handle = 0;
    await this.cb.reattach();
    if (model && !this.meta.model && !this.meta.preset) {
      try {
        await this.pi({ type: "set_model", provider: model.provider, modelId: model.id });
        if (thinking) await this.pi({ type: "set_thinking_level", level: thinking });
        await this.refreshState();
      } catch {
        /* the next message uses Pi's model */
      }
    }
  }

  close() {
    // the process stays on the server (other devices, idle sweep); only the view goes
  }

  private pi<K extends string>(cmd: { type: K; [k: string]: unknown }) {
    return api.pi(this.handle, cmd);
  }

  async refreshState() {
    if (this.detached || !this.handle) return;
    const st = await this.pi({ type: "get_state" });
    this.model = st.model ?? null;
    this.thinkingLevel = st.thinkingLevel ?? "";
    this.sessionId = st.sessionId ?? "";
    this.streaming = !!st.isStreaming;
    this.name = st.sessionName ?? this.name;
    if (st.sessionFile && (st.messageCount ?? 0) > 0 && st.sessionFile !== this.target.path) {
      const first = !this.target.path;
      this.target.path = st.sessionFile;
      if (first) await this.flushPendingMeta();
    }
  }

  async refreshModels() {
    if (this.detached || !this.handle) return;
    try {
      this.models = (await this.pi({ type: "get_available_models" })).models ?? [];
    } catch (e) {
      this.models = [];
      toast(`${t("Models")}: ${errMsg(e)}`, "err");
    }
    try {
      this.levels = (await this.pi({ type: "get_available_thinking_levels" })).levels ?? [];
    } catch {
      this.levels = [];
    }
    try {
      this.commands = (await this.pi({ type: "get_commands" })).commands ?? [];
    } catch {
      this.commands = [];
    }
  }

  async refreshStats() {
    if (!this.alive || this.detached || !this.handle) return;
    try {
      this.piStats = await this.pi({ type: "get_session_stats" });
      this.cb.changed();
    } catch {
      /* older Pi: the live counters stay */
    }
  }

  // ------------------------------------------------------------------ metadata

  /** Save fields of this session's metadata (kept for later while the session has no file yet) */
  async saveMeta(patch: Partial<Record<keyof SessionMeta, unknown>>) {
    const m = this.meta as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === "") delete m[k];
      else m[k] = v;
    }
    const key = this.key;
    if (!key) {
      Object.assign(this.pendingMeta, patch);
      return;
    }
    try {
      this.meta = await patchSessionMeta(key, patch);
    } catch (e) {
      toast(errMsg(e), "err");
    }
  }

  private async flushPendingMeta() {
    const pending = this.pendingMeta;
    this.pendingMeta = {};
    // the choice made before the first message belongs to the session file from now on
    const choice = { model: this.meta.model, thinking: this.meta.thinking, preset: this.meta.preset };
    await this.saveMeta({ ...pending, ...choice });
  }

  // ------------------------------------------------------------------ model, thinking level, preset

  private settle<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.settling.catch(() => {}).then(fn);
    this.settling = run;
    return run;
  }

  /** Pick a model for this session (an individual model is no preset) */
  setModel(provider: string, modelId: string, keepPreset = false) {
    if (!keepPreset) this.presetId = "";
    return this.settle(async () => {
      if (this.detached || !this.handle) {
        this.model = { provider, id: modelId, name: modelId };
      } else {
        const m = await this.pi({ type: "set_model", provider, modelId });
        this.model = m ?? this.model;
        await this.refreshModels();
        await this.refreshState();
      }
      await this.saveChoice();
      this.cb.changed();
    });
  }

  setThinking(level: string) {
    return this.settle(async () => {
      if (!this.detached && this.handle) await this.pi({ type: "set_thinking_level", level });
      this.thinkingLevel = level;
      await this.saveChoice();
      this.cb.changed();
    });
  }

  /** Choose a preset (id, "" = individual choice): its model and thinking level go to Pi and are kept for the session */
  async setPreset(id: string) {
    const { preset, model, thinking } = resolveChoice(this.shared.presets, { preset: id });
    try {
      if (model) await this.setModel(model.provider, model.id, true);
      if (thinking) await this.setThinking(thinking);
    } catch (e) {
      toast(`${t("Model")}: ${errMsg(e)}`, "err");
    }
    this.presetId = preset?.id ?? "";
    await this.saveChoice();
    this.cb.changed();
  }

  /** Keep model, thinking level and preset in the session metadata (SessionTab.saveChoice) */
  async saveChoice() {
    await this.saveMeta({
      model: this.model ? `${this.model.provider}/${this.model.id}` : undefined,
      thinking: this.thinkingLevel || undefined,
      preset: this.presetId || undefined,
    });
  }

  /** The choice saved for this session (or given for a new one), applied unless Pi already has it */
  async applyChoice() {
    const saved: SessionMeta = this.key
      ? this.meta
      : {
          preset: this.start.preset ?? this.meta.preset,
          model: this.start.model ?? this.meta.model,
          thinking: this.start.thinking ?? this.meta.thinking,
        };
    if (!saved.model && !saved.thinking && !saved.preset) return;
    const { preset, model, thinking } = resolveChoice(this.shared.presets, saved);
    try {
      if (model && (this.model?.provider !== model.provider || this.model?.id !== model.id)) {
        await this.setModel(model.provider, model.id, true);
      }
      if (thinking && this.thinkingLevel !== thinking) await this.setThinking(thinking);
      this.presetId = preset?.id ?? "";
      await this.saveChoice();
    } catch (e) {
      toast(`${t("Model")}: ${errMsg(e)}`, "err");
    }
  }

  /** A model changed inside Pi itself (its /model command): keep it as the session's choice (SessionTab.adoptChoice) */
  async adoptChoice() {
    const saved = this.meta;
    if (!saved.model && !saved.thinking) return;
    const model = this.model ? `${this.model.provider}/${this.model.id}` : "";
    const changed = (!!model && model !== saved.model) || (!!this.thinkingLevel && this.thinkingLevel !== saved.thinking);
    if (!changed) return;
    this.presetId = "";
    await this.saveChoice();
  }

  /** Does the current model take images? Unknown = yes (Pi refuses itself) */
  modelTakesImages(): boolean {
    const m = this.model;
    if (!m) return true;
    const info = this.hostModels.find((x) => x.provider === m.provider && x.id === m.id);
    return info ? info.images : true;
  }

  // ------------------------------------------------------------------ chat view

  startView(): ChatMode {
    const own = this.project?.view;
    if (isChatMode(own)) return own;
    const s = chatSettings().chatMode;
    return isChatMode(s) ? s : "technical";
  }

  viewMode(): ChatMode {
    const own = this.meta.chatMode;
    return isChatMode(own) ? own : this.startView();
  }

  async setViewMode(mode: ChatMode) {
    await this.saveMeta({ chatMode: mode === this.startView() ? undefined : mode });
    this.cb.changed();
  }

  // ------------------------------------------------------------------ plan mode, context mode, temperature

  async setPlanMode(on: boolean) {
    if (on === this.planMode) return;
    if (this.streaming || this.detached) {
      toast(t("Pi is still working – stop it first or wait."), "err");
      return;
    }
    this.planMode = on;
    await this.saveMeta({ planMode: on || undefined });
    try {
      await this.restart();
      toast(on ? t("Plan mode: Pi only reads and writes a plan.") : t("Build mode: Pi may change files again."));
    } catch (e) {
      toast(errMsg(e), "err");
    }
  }

  contextAvailable(): boolean {
    return this.commands.some((c) => c.name === "mode");
  }

  tempAvailable(): boolean {
    return this.commands.some((c) => c.name === "temperature");
  }

  private async extensionCommand(text: string): Promise<boolean> {
    const r = await this.pi({ type: "prompt", message: text });
    return r?.disposition === "handled";
  }

  startContextMode(): ContextMode {
    return startContextMode(this.project?.contextMode, undefined);
  }

  private async saveContext() {
    await this.saveMeta({
      contextMode: isContextMode(this.contextMode) && this.contextMode !== this.startContextMode() ? this.contextMode : undefined,
      contextStripped: this.contextStripped.length ? [...this.contextStripped] : undefined,
    });
  }

  async applyContext() {
    const mode: ContextMode = this.meta.contextMode || this.startContextMode();
    const stripped = this.meta.contextStripped ?? [];
    if ((!mode && !stripped.length) || !this.contextAvailable()) return;
    try {
      if (mode && (await this.extensionCommand(contextModeCommand(mode)))) this.contextMode = mode;
      this.contextApplied = true;
      if (stripped.length) {
        const set = new Set(stripped);
        for (const name of CONTEXT_SECTIONS) await this.extensionCommand(contextSectionCommand(name, !set.has(name)));
        this.contextStripped = [...set];
      }
    } catch {
      /* the next status of the extension tells the truth */
    }
  }

  async setContextMode(mode: "private" | "public") {
    if (!this.alive || this.detached) return toast(t("The context mode needs a live session."), "err");
    try {
      if (!(await this.extensionCommand(contextModeCommand(mode)))) throw new Error(t("Pi did not handle it as a command."));
      this.contextMode = mode;
      this.contextApplied = true;
      await this.saveContext();
      this.cb.changed();
    } catch (e) {
      toast(`${t("Context mode")}: ${errMsg(e)}`, "err");
    }
  }

  async setContextSection(name: string, keep: boolean) {
    if (!this.alive || this.detached) return toast(t("The context mode needs a live session."), "err");
    try {
      if (!(await this.extensionCommand(contextSectionCommand(name, keep)))) throw new Error(t("Pi did not handle it as a command."));
      const set = new Set(this.contextStripped);
      if (keep) set.delete(name);
      else set.add(name);
      this.contextStripped = [...set];
      await this.saveContext();
      this.cb.changed();
    } catch (e) {
      toast(`${t("Context mode")}: ${errMsg(e)}`, "err");
    }
  }

  async applyTemperature() {
    const saved = this.meta.temperature;
    this.temperature = isTemp(saved) ? saved : null;
    if (this.temperature === null || !this.tempAvailable()) return;
    try {
      if (await this.extensionCommand(temperatureCommand(this.temperature))) this.tempApplied = true;
    } catch {
      /* the next status tells the truth */
    }
  }

  async setTemperature(v: number | null) {
    const value = v === null ? null : clampTemp(v);
    try {
      if (!this.detached && this.handle) {
        if (!(await this.extensionCommand(temperatureCommand(value)))) throw new Error(t("Pi did not handle it as a command."));
        this.tempApplied = true;
      }
      this.temperature = value;
      await this.saveMeta({ temperature: value ?? undefined });
      this.cb.changed();
    } catch (e) {
      toast(`${t("Temperature")}: ${errMsg(e)}`, "err");
    }
  }

  /** Install the temperature extension on the host and start Pi again so it loads it */
  async installTemperature() {
    if (this.streaming) return toast(t("Pi is still working – stop it first or wait."), "err");
    await api.tempInstall(this.target.hostId);
    await this.restart();
  }

  // ------------------------------------------------------------------ events (state only; the view renders)

  /** Update the state from an event; true = a status event that is not shown in the chat */
  onEvent(ev: PiEvent): boolean {
    switch (ev.type) {
      case "agent_start":
        this.streaming = true;
        return false;
      case "agent_settled":
        this.streaming = false;
        if (this.detached) {
          this.bgSettled = true;
          return false;
        }
        void this.refreshState()
          .then(() => this.adoptChoice())
          .then(() => this.cb.changed())
          .catch(() => {});
        void this.refreshStats();
        return false;
      case "message_end":
        if (ev.message?.role === "assistant" && ev.message.usage) this.addUsage(ev.message.usage);
        if (ev.message?.role === "assistant") void this.refreshStats();
        return false;
      case "queue_update":
        this.queue = { steering: ev.steering ?? [], followUp: ev.followUp ?? [] };
        return true;
      case "extension_ui_request":
        if (ev.method === "setStatus" && ev.statusKey === "pibar-temperature") {
          const v = parseTemperatureStatus(ev.statusText);
          if (v === undefined) return true;
          const first = !this.tempStatusSeen;
          this.tempStatusSeen = true;
          const changed = v !== this.temperature;
          this.temperature = v;
          if (!first && this.tempApplied && changed) void this.saveMeta({ temperature: v ?? undefined });
          return true;
        }
        if (ev.method === "setStatus" && ev.statusKey === "mode-guard") {
          const st = parseContextStatus(ev.statusText);
          const first = !this.contextStatusSeen;
          this.contextStatusSeen = true;
          const changed = st.mode !== this.contextMode;
          this.contextMode = st.mode;
          if (st.mode === "public") this.contextStripped = st.stripped;
          if (!first && this.contextApplied && changed) void this.saveContext();
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  private addUsage(u: Usage) {
    const s = this.live;
    s.responses++;
    s.input += u.input ?? 0;
    s.output += u.output ?? 0;
    s.cacheRead += u.cacheRead ?? 0;
    s.cacheWrite += u.cacheWrite ?? 0;
    s.cost += typeof u.cost === "number" ? u.cost : (u.cost?.total ?? 0);
    s.lastContext = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
  }

  // ------------------------------------------------------------------ sending

  private message(text: string): string {
    return withPlanMode(withAnswerStyle(text, chatSettings().answerMode), this.planMode);
  }

  /** Send a message; while Pi works it waits in Pi's queue: "followUp" after the answer, "steer" in between */
  async send(text: string, images: Image[] = [], when: QueueWhen = "followUp") {
    if (this.detached) {
      toast(t("Pi is still working – wait for the answer."));
      return;
    }
    if (!this.streaming) await this.rememberFiles();
    await this.settling.catch(() => {});
    const cmd: { type: "prompt"; [k: string]: unknown } = { type: "prompt", message: this.message(text) };
    if (images.length) cmd.images = images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
    if (this.streaming) cmd.streamingBehavior = when;
    await this.pi(cmd);
    // a new session gets its file with the first message
    if (!this.target.path) setTimeout(() => void this.refreshState().then(() => this.cb.changed()), 800);
  }

  /** State of the files before this message, so going back can restore them (snapshot.rs) */
  private async rememberFiles() {
    if (this.snapshotOff || !this.sessionId) return;
    try {
      const points = (await this.pi({ type: "get_fork_messages" })).messages ?? [];
      const tag = points[points.length - 1]?.entryId;
      if (!tag) return;
      if (!(await api.snapshotTake(this.target.hostId, this.target.cwd, this.sessionId, tag))) this.snapshotOff = true;
    } catch {
      this.snapshotOff = true;
    }
  }

  /** Send as a detached run on the host; false = nothing sent (the text stays in the input) */
  async sendToBackground(text: string): Promise<boolean> {
    if (this.detached) {
      toast(t("This session is still running in the background – wait or stop it."));
      return false;
    }
    if (this.streaming) {
      await this.send(text);
      return true;
    }
    const path = this.target.path;
    // the first message of a new session has no session file yet: it goes the normal way
    if (!path) {
      await this.send(text);
      return true;
    }
    await this.rememberFiles();
    const saved = resolveChoice(this.shared.presets, this.meta);
    const provider = saved.model?.provider || this.model?.provider;
    const modelId = saved.model?.id || this.model?.id;
    const thinking = saved.thinking || this.thinkingLevel;
    try {
      const handle = await api.bgStart(
        this.target.hostId,
        this.target.cwd || "~",
        path,
        this.message(text),
        provider,
        modelId,
        thinking,
        this.toolset(),
        this.contextMode === "public" && this.contextAvailable(),
        this.tempAvailable() ? this.temperature : null,
      );
      this.startRun(handle);
      await this.saveMeta({ backgroundAt: Date.now() });
      return true;
    } catch (e) {
      toast(`${t("In the background")}: ${errMsg(e)}`, "err");
      return false;
    }
  }

  /** Follow the run in the background of this session */
  async follow(): Promise<Attached> {
    const handle = await api.bgFollow(this.target.hostId, this.target.path ?? "");
    this.startRun(handle);
    return { handle, joined: true, streaming: true, seq: 0 };
  }

  private startRun(handle: number) {
    this.handle = handle;
    this.seq = 0;
    this.alive = true;
    this.detached = true;
    this.streaming = true;
    this.bgSettled = false;
    this.bgStopWanted = false;
    this.queue = { steering: [], followUp: [] };
  }

  /** The follower ended: the run is done (or stopped / failed) */
  bgEnded(stderr: string) {
    const ok = this.bgSettled || this.bgStopWanted;
    this.detached = false;
    this.streaming = false;
    this.cb.backgroundDone(ok, stderr);
  }

  async stopBackground() {
    if (!this.target.path) return;
    this.bgStopWanted = true;
    await api.bgStop(this.target.hostId, this.target.path).catch((e: unknown) => toast(errMsg(e), "err"));
  }

  async setBackground(on: boolean) {
    this.background = on;
    const def = !!chatSettings().background;
    await this.saveMeta({ background: on === def ? undefined : on ? "on" : "off" });
    this.cb.changed();
  }

  async abort() {
    if (this.detached) return this.stopBackground();
    await this.pi({ type: "abort" });
  }

  /** Take the waiting messages out of Pi's queue (they come back into the input) */
  async clearQueue(): Promise<string[]> {
    const r = await this.pi({ type: "clear_queue" });
    return [...(r.steering ?? []), ...(r.followUp ?? [])];
  }

  // ------------------------------------------------------------------ name, branches

  async rename(name: string) {
    this.name = name;
    if (!this.detached && this.handle) {
      try {
        await this.pi({ type: "set_session_name", name });
      } catch {
        /* the own name in the metadata still applies */
      }
    }
    await this.saveMeta({ name: name || undefined });
    this.cb.changed();
  }

  async forkPoints(): Promise<{ entryId: string; text: string }[]> {
    if (this.detached || !this.handle) return [];
    return (await this.pi({ type: "get_fork_messages" })).messages ?? [];
  }

  /** Pi loads model and thinking level from the history on fork/switch: keep the current choice */
  private async keepModel<T>(fn: () => Promise<T>): Promise<T> {
    const model = this.model;
    const thinking = this.thinkingLevel;
    const result = await fn();
    if (model && (this.model?.provider !== model.provider || this.model?.id !== model.id)) {
      try {
        this.model = (await this.pi({ type: "set_model", provider: model.provider, modelId: model.id })) ?? model;
      } catch (e) {
        toast(`${t("Model")}: ${errMsg(e)}`, "err");
      }
    }
    if (thinking && this.thinkingLevel !== thinking) {
      await this.pi({ type: "set_thinking_level", level: thinking }).catch(() => {});
      this.thinkingLevel = thinking;
    }
    return result;
  }

  /** Fork before a user message: Pi continues in a new session file; returns the message text (null = cancelled) */
  async forkAt(entryId: string): Promise<string | null> {
    const before = this.meta;
    const r = await this.keepModel(async () => {
      const res = await this.pi({ type: "fork", entryId });
      if (res?.cancelled) return null;
      const st = await this.pi({ type: "get_state" });
      this.target.path = (st.messageCount ?? 0) > 0 ? (st.sessionFile ?? null) : null;
      this.model = st.model ?? this.model;
      this.thinkingLevel = st.thinkingLevel ?? this.thinkingLevel;
      this.sessionId = st.sessionId ?? "";
      return res?.text ?? "";
    });
    if (r === null) return null;
    // a branch keeps group, colour and the model choice of the session it came from
    this.meta = {};
    await this.saveMeta({ group: before.group, color: before.color, model: before.model, thinking: before.thinking, preset: before.preset, planMode: before.planMode });
    await this.cb.reload();
    return r;
  }

  /** Switch this process to another session file (another version of a message) */
  async switchTo(path: string): Promise<boolean> {
    const ok = await this.keepModel(async () => {
      const r = await this.pi({ type: "switch_session", sessionPath: path });
      if (r?.cancelled) return false;
      this.target.path = path;
      await this.refreshState();
      return true;
    });
    if (ok) {
      this.meta = (await loadMeta().catch(() => null))?.sessionMeta[this.key ?? ""] ?? {};
      await this.cb.reload();
    }
    return ok;
  }

  /** Model "provider/id" saved with this session, as parts */
  savedModel(): { provider: string; id: string } | null {
    return splitModelKey(this.meta.model ?? "");
  }
}
