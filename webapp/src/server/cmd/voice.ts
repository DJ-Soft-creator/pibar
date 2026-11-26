// Voice commands with the Tauri names (lib.rs: transcribe_audio, improve_text, speak_text) – tasks J1, J2. They use
// the voice services of the shared settings (AppConfigStore, API keys stay on the server; ../voice.ts does the
// calls). Also registers the web push commands (task J3, ./push.ts): both are the extras area, and index.ts has one
// registration line for it.
import type { AppConfigStore } from "../appConfig.js";
import { argString, CommandError, type CommandRegistry } from "../commands.js";
import { improve, speak, transcribe, voiceSettings } from "../voice.js";
import { registerPushCommands } from "./push.js";

/** Longest text sent to the improvement LLM (a prompt, not a document) */
const IMPROVE_MAX = 20_000;
/** OpenAI's speech endpoint takes up to 4096 characters */
const SPEAK_MAX = 4096;
/** Base64 of a recording: ~7 MB of audio, minutes of speech */
const AUDIO_MAX = 10 * 1024 * 1024;

export function registerVoiceCommands(registry: CommandRegistry, deps: { appConfig?: AppConfigStore } = {}) {
  registerPushCommands(registry);
  const { appConfig } = deps;
  if (!appConfig) return;
  const cfg = () => voiceSettings(appConfig.settings.voice);

  /** Recording (base64) → text with the dictation settings */
  registry.register("transcribe_audio", {
    run: (_ctx, args) => {
      const data = argString(args, "data");
      const mime = argString(args, "mime");
      if (data.length > AUDIO_MAX) throw new CommandError(413, "Recording too long");
      if (!/^[A-Za-z0-9+/=\s]*$/.test(data)) throw new CommandError(400, "data must be base64");
      const stt = cfg().stt;
      if (stt.provider !== "api" && stt.provider !== "command") throw new CommandError(409, "Dictation is off (More → Voice)");
      return transcribe(stt, data, mime);
    },
  });

  /** Text → improved text by the second LLM; the admin's prompt wins over the one the client sends */
  registry.register("improve_text", {
    run: (_ctx, args) => {
      const text = argString(args, "text");
      const prompt = argString(args, "prompt");
      if (text.length > IMPROVE_MAX) throw new CommandError(413, "Text too long");
      const im = cfg().improve;
      if (!im.enabled) throw new CommandError(409, "Text improvement is off (More → Voice)");
      return improve(im, im.prompt.trim() || prompt.trim(), text);
    },
  });

  /** Text → speech (mp3, base64) through the API */
  registry.register("speak_text", {
    run: (_ctx, args) => {
      const text = argString(args, "text").slice(0, SPEAK_MAX);
      const tts = cfg().tts;
      if (tts.provider !== "api") throw new CommandError(409, "Reading aloud through an API is off (More → Voice)");
      if (!text.trim()) throw new CommandError(400, "text is empty");
      return speak(tts, text);
    },
  });
}
