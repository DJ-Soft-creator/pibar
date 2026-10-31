// Voice in both windows: record (microphone) → text (Rust: voice.rs), optional improvement by a second LLM,
// and reading answers aloud (system voice or API). The settings live in AppConfig.voice.
import { api, VoiceCfg } from "./api";
import { t } from "./i18n";

/** Prompt for the text improvement when none is set */
export const DEFAULT_IMPROVE_PROMPT =
  "You improve texts before they are sent to an AI coding agent. Fix spelling, grammar and punctuation, remove " +
  "filler words and repetitions from dictation, and make the request clear and precise. Keep the language, the " +
  "meaning, all technical terms, names, paths and code exactly. Do not answer the text and do not add anything. " +
  "Return only the improved text.";

// ---------- Recording ----------

let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];

export function isRecording(): boolean {
  return !!recorder && recorder.state === "recording";
}

function pickMime(): string {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"])
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m)) return m;
  return "";
}

export async function startRecording() {
  if (isRecording()) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error(t("Microphone not available in this window."));
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    const err = new Error(
      `${t("No access to the microphone (System Settings → Privacy & Security → Microphone).")} ${String(e)}`,
    );
    (err as Error & { cause?: unknown }).cause = e;
    throw err;
  }
  const mime = pickMime();
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start(250);
}

function release() {
  stream?.getTracks().forEach((tr) => tr.stop());
  stream = null;
  recorder = null;
}

/** Stop and return the recording as base64; null if nothing was recorded */
export function stopRecording(): Promise<{ data: string; mime: string } | null> {
  const rec = recorder;
  if (!rec) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    rec.onstop = async () => {
      const mime = rec.mimeType || "audio/mp4";
      release();
      const blob = new Blob(chunks, { type: mime });
      chunks = [];
      if (blob.size < 800) return resolve(null);
      try {
        resolve({ data: await toBase64(blob), mime });
      } catch (e) {
        reject(e);
      }
    };
    rec.stop();
  });
}

export function cancelRecording() {
  if (!recorder) return;
  recorder.onstop = null;
  try {
    recorder.stop();
  } catch {
    /* already stopped */
  }
  chunks = [];
  release();
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// ---------- Text improvement ----------

export function improve(voice: VoiceCfg | undefined, text: string): Promise<string> {
  return api.improveText(text, voice?.improve.prompt.trim() || DEFAULT_IMPROVE_PROMPT);
}

// ---------- Read aloud ----------

let audio: HTMLAudioElement | null = null;
let speakingId = 0;

export function isSpeaking(): boolean {
  return !!audio || (typeof speechSynthesis !== "undefined" && speechSynthesis.speaking);
}

export function stopSpeaking() {
  speakingId++;
  audio?.pause();
  audio = null;
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}

/** Plain text for speech: no code blocks, no Markdown symbols */
export function speakableText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[#>\-*+\s]+/gm, "")
    .replace(/[*_~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Read a text aloud; resolves when it has finished or was stopped */
export async function speak(voice: VoiceCfg | undefined, text: string, lang = "en"): Promise<void> {
  stopSpeaking();
  const id = speakingId;
  const say = speakableText(text).slice(0, 4000);
  if (!say) return;
  if (voice?.tts.provider === "api") {
    const a = await api.speakText(say);
    if (id !== speakingId) return;
    audio = new Audio(`data:${a.mimeType};base64,${a.data}`);
    const el = audio;
    await new Promise<void>((resolve) => {
      el.onended = el.onerror = el.onpause = () => resolve();
      el.play().catch(() => resolve());
    });
    if (audio === el) audio = null;
    return;
  }
  if (typeof speechSynthesis === "undefined") throw new Error(t("No system voice available."));
  const u = new SpeechSynthesisUtterance(say);
  u.lang = lang;
  const name = voice?.tts.voice.trim();
  if (name) {
    const v = speechSynthesis.getVoices().find((x) => x.name.toLowerCase().includes(name.toLowerCase()));
    if (v) u.voice = v;
  }
  await new Promise<void>((resolve) => {
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

// ---------- Buttons (main window and quick bar) ----------

export interface VoiceUi {
  input: HTMLTextAreaElement;
  mic: HTMLButtonElement;
  improveBtn: HTMLButtonElement;
  /** Current settings (read fresh, the quick bar may be out of date otherwise) */
  config: () => Promise<VoiceCfg | undefined>;
  onError: (msg: string) => void;
  /** Called after the input text changed (resize etc.) */
  onText?: () => void;
}

function setBusy(btn: HTMLButtonElement, busy: boolean) {
  btn.classList.toggle("busy", busy);
  btn.disabled = busy;
}

function insertText(input: HTMLTextAreaElement, text: string) {
  const cur = input.value;
  input.value = cur && !/\s$/.test(cur) ? `${cur} ${text}` : cur + text;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new Event("input"));
}

/** Show the mic (dictation set up) and the improve button (improvement on) */
export function showVoiceButtons(ui: Pick<VoiceUi, "mic" | "improveBtn">, voice: VoiceCfg | undefined) {
  ui.mic.hidden = !voice || voice.stt.provider === "off";
  ui.improveBtn.hidden = !voice?.improve.enabled;
}

/** Mic: click starts, second click stops and transcribes (Escape cancels); the improve button rewrites the input text */
export function wireVoice(ui: VoiceUi) {
  let timer = 0;
  const started = { at: 0 };
  const showTime = () => {
    const s = Math.floor((Date.now() - started.at) / 1000);
    ui.mic.dataset.time = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const stopUi = () => {
    clearInterval(timer);
    ui.mic.classList.remove("rec");
    delete ui.mic.dataset.time;
  };

  ui.mic.addEventListener("click", async () => {
    if (!isRecording()) {
      try {
        await startRecording();
        started.at = Date.now();
        ui.mic.classList.add("rec");
        showTime();
        timer = window.setInterval(showTime, 500);
      } catch (e) {
        ui.onError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    stopUi();
    setBusy(ui.mic, true);
    try {
      const rec = await stopRecording();
      if (!rec) return;
      let text = await api.transcribe(rec.data, rec.mime);
      const voice = await ui.config();
      if (text && voice?.improve.enabled && voice.improve.afterDictation) {
        try {
          text = await improve(voice, text);
        } catch (e) {
          ui.onError(`${t("Text improvement")}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (text) insertText(ui.input, text);
      ui.onText?.();
    } catch (e) {
      ui.onError(`${t("Dictation")}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(ui.mic, false);
    }
  });

  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isRecording()) {
      e.preventDefault();
      e.stopPropagation();
      cancelRecording();
      stopUi();
    }
  });

  ui.improveBtn.addEventListener("click", async () => {
    const text = ui.input.value.trim();
    if (!text) return;
    setBusy(ui.improveBtn, true);
    try {
      const better = await improve(await ui.config(), text);
      ui.input.value = better;
      ui.input.focus();
      ui.input.dispatchEvent(new Event("input"));
      ui.onText?.();
    } catch (e) {
      ui.onError(`${t("Text improvement")}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(ui.improveBtn, false);
    }
  });
}
