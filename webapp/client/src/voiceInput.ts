// Voice in the chat (tasks J1/J2): a dictation button for the input, an "improve text" button, and reading an answer
// aloud. They use the voice services of the shared settings on the server (transcribe_audio, improve_text,
// speak_text – keys stay there); app_config_get tells which parts are set up (provider, apiKeySet). Not set up →
// createDictationButton/createImproveButton return null and canSpeak false, so the chat hides its buttons.
//
// Dictation: hold the button to talk (release stops), or tap to start and tap again to stop; Esc cancels. The
// browser picks the format (iOS Safari records audio/mp4), which the server gets as the recording's MIME type.
import "./voiceInput.css";
import { api } from "@shared/api";
import { errMsg, h, toast } from "@shared/dom";
import { getLang, t } from "@shared/i18n";
import { cancelRecording, DEFAULT_IMPROVE_PROMPT, isRecording, speakableText, startRecording, stopRecording } from "@shared/voice";
import { loadSharedConfig, onSharedConfig, sharedConfig, type WebVoiceCfg } from "./sharedConfig";

/** Pressed longer than this = hold to talk (release stops); shorter = tap to toggle */
const HOLD_MS = 450;

// ---------------------------------------------------------------- what is set up

const apiReady = (o: { baseUrl?: string; apiKeySet?: boolean } | undefined) => !!o && (!!o.apiKeySet || !!o.baseUrl?.trim());

export function dictationReady(v: WebVoiceCfg | undefined): boolean {
  const p = v?.stt?.provider;
  if (p === "api") return apiReady(v?.stt);
  return p === "command" && !!v?.stt?.command?.trim();
}

export function improveReady(v: WebVoiceCfg | undefined): boolean {
  return !!v?.improve?.enabled && apiReady(v.improve);
}

export function speakReady(v: WebVoiceCfg | undefined): boolean {
  const p = v?.tts?.provider;
  if (p === "api") return apiReady(v?.tts);
  return p === "system" && typeof speechSynthesis !== "undefined";
}

/**
 * Buttons that depend on the settings. Before the settings are loaded a button is created hidden and shown once they
 * say it is set up; after an admin changes them, buttons still on the page follow.
 */
const tracked = new Set<{ el: HTMLElement; ready: (v: WebVoiceCfg | undefined) => boolean; born: number }>();
let tracking = false;

function track(el: HTMLElement, ready: (v: WebVoiceCfg | undefined) => boolean) {
  tracked.add({ el, ready, born: Date.now() });
  if (tracking) return;
  tracking = true;
  onSharedConfig((c) => {
    for (const x of tracked) {
      // buttons of a chat that was closed: forget them (a fresh one may not be in the page yet)
      if (!x.el.isConnected && Date.now() - x.born > 10_000) tracked.delete(x);
      else x.el.hidden = !x.ready(c.voice);
    }
  });
}

/** null = settings loaded and the part is not set up; otherwise a button (hidden until it is known) */
function gate(ready: (v: WebVoiceCfg | undefined) => boolean, el: HTMLElement): HTMLElement | null {
  const cfg = sharedConfig();
  if (cfg && !ready(cfg.voice)) return null;
  el.hidden = !cfg;
  if (!cfg) void loadSharedConfig();
  track(el, ready);
  return el;
}

// ---------------------------------------------------------------- dictation

function improvePrompt(v: WebVoiceCfg | undefined): string {
  return v?.improve?.prompt?.trim() || DEFAULT_IMPROVE_PROMPT;
}

/** A microphone button that records, transcribes and hands the text over; null = dictation not configured */
export function createDictationButton(onText: (text: string) => void): HTMLElement | null {
  const label = h("span", { class: "vi-time" });
  const btn = h(
    "button",
    {
      type: "button",
      class: "icon-btn vi-mic",
      title: t("Dictate: hold to talk, or tap to start and stop"),
      "aria-label": t("Dictation"),
    },
    h("span", { class: "vi-icon", "aria-hidden": "true" }, "🎙"),
    label,
  );
  let pressAt = 0;
  let startedByPress = false;
  let starting: Promise<boolean> | null = null;
  let timer = 0;
  let busy = false;

  const showTime = (from: number) => {
    const s = Math.floor((Date.now() - from) / 1000);
    label.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const stopUi = () => {
    clearInterval(timer);
    btn.classList.remove("rec");
    btn.setAttribute("aria-pressed", "false");
    label.textContent = "";
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !isRecording()) return;
    e.preventDefault();
    e.stopPropagation();
    cancelRecording();
    stopUi();
  };

  const begin = (): Promise<boolean> =>
    startRecording()
      .then(() => {
        const from = Date.now();
        btn.classList.add("rec");
        btn.setAttribute("aria-pressed", "true");
        showTime(from);
        timer = window.setInterval(() => showTime(from), 500);
        document.addEventListener("keydown", onKey, true);
        return true;
      })
      .catch((e: unknown) => {
        const name = (e as { cause?: { name?: string } }).cause?.name;
        toast(
          name === "NotAllowedError" || name === "SecurityError"
            ? t("No access to the microphone – allow it for this page in the browser settings.")
            : errMsg(e),
          "err",
        );
        return false;
      });

  const finish = async () => {
    if (starting && !(await starting)) return;
    if (!isRecording()) return;
    stopUi();
    busy = true;
    btn.classList.add("busy");
    try {
      const rec = await stopRecording();
      if (!rec) {
        toast(t("Recording too short."));
        return;
      }
      let text = await api.transcribe(rec.data, rec.mime);
      const v = sharedConfig()?.voice;
      if (text && improveReady(v) && v?.improve?.afterDictation) {
        try {
          text = await api.improveText(text, improvePrompt(v));
        } catch (e) {
          toast(`${t("Text improvement")}: ${errMsg(e)}`, "err");
        }
      }
      if (text.trim()) onText(text.trim());
      else toast(t("Nothing recognised."));
    } catch (e) {
      toast(`${t("Dictation")}: ${errMsg(e)}`, "err");
    } finally {
      busy = false;
      btn.classList.remove("busy");
    }
  };

  btn.addEventListener("pointerdown", (e) => {
    if (busy || e.button > 0) return;
    // keep the focus (and the iPhone keyboard) in the input
    e.preventDefault();
    pressAt = Date.now();
    startedByPress = !isRecording() && !starting;
    if (startedByPress) {
      starting = begin().finally(() => (starting = null));
    }
  });
  btn.addEventListener("pointerup", () => {
    if (busy || (!isRecording() && !starting)) return;
    // a short tap that started the recording keeps it running until the next tap
    if (startedByPress && Date.now() - pressAt < HOLD_MS) return;
    void finish();
  });
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  // keyboard (Enter/Space) has no pointer events: toggle
  btn.addEventListener("click", (e) => {
    if (e.detail !== 0 || busy) return;
    if (isRecording()) void finish();
    else starting ??= begin().finally(() => (starting = null));
  });
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  return gate(dictationReady, btn);
}

// ---------------------------------------------------------------- improve

/** Button that rewrites the input's text with the second LLM; null = text improvement not configured */
export function createImproveButton(input: HTMLTextAreaElement | HTMLInputElement): HTMLElement | null {
  const btn = h(
    "button",
    { type: "button", class: "icon-btn vi-improve", title: t("Improve the text with the second LLM"), "aria-label": t("Text improvement") },
    "✨",
  );
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    const text = input.value.trim();
    if (!text || btn.classList.contains("busy")) return;
    btn.classList.add("busy");
    api
      .improveText(text, improvePrompt(sharedConfig()?.voice))
      .then((better) => {
        input.value = better;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })
      .catch((e: unknown) => toast(`${t("Text improvement")}: ${errMsg(e)}`, "err"))
      .finally(() => btn.classList.remove("busy"));
  });
  return gate(improveReady, btn);
}

// ---------------------------------------------------------------- read aloud

/** Whether reading aloud is available (a TTS service is configured) */
export function canSpeak(): boolean {
  return speakReady(sharedConfig()?.voice);
}

let audio: HTMLAudioElement | null = null;
let audioUrl = "";
let speakId = 0;

/** A few milliseconds of silence: played inside the tap, so iOS lets the same element play the real audio later */
const SILENCE = (() => {
  const n = 160;
  const b = new Uint8Array(44 + n);
  const v = new DataView(b.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  str(36, "data");
  v.setUint32(40, n, true);
  b.fill(128, 44);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...b))}`;
})();

export function isSpeaking(): boolean {
  return !!audio || (typeof speechSynthesis !== "undefined" && speechSynthesis.speaking);
}

export function stopSpeaking() {
  speakId++;
  if (audio) {
    audio.onended = audio.onerror = audio.onpause = null;
    audio.pause();
  }
  audio = null;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = "";
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}

function base64Blob(data: string, type: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/**
 * Read a text aloud (Markdown and code left out); resolves when it has finished or was stopped. Calling it while
 * something is read stops that first. Errors are shown as a toast.
 */
export async function speakText(text: string): Promise<void> {
  stopSpeaking();
  const id = speakId;
  const v = sharedConfig()?.voice;
  const say = speakableText(text).slice(0, 4000);
  if (!say || !speakReady(v)) return;
  try {
    if (v?.tts?.provider === "api") {
      // created and started synchronously in the tap: iOS only allows playback that a user gesture began
      const el = new Audio(SILENCE);
      audio = el;
      el.play().catch(() => {});
      const a = await api.speakText(say);
      if (id !== speakId) return;
      audioUrl = URL.createObjectURL(base64Blob(a.data, a.mimeType));
      el.src = audioUrl;
      await new Promise<void>((resolve) => {
        el.onended = el.onerror = () => resolve();
        el.play().catch(() => resolve());
      });
      if (id === speakId) stopSpeaking();
      return;
    }
    const u = new SpeechSynthesisUtterance(say);
    u.lang = getLang();
    const name = v?.tts?.voice?.trim().toLowerCase();
    if (name) {
      const match = speechSynthesis.getVoices().find((x) => x.name.toLowerCase().includes(name));
      if (match) u.voice = match;
    }
    await new Promise<void>((resolve) => {
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  } catch (e) {
    if (id === speakId) toast(`${t("Read aloud")}: ${errMsg(e)}`, "err");
  }
}
