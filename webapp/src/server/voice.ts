// Voice and text helpers of the webapp – port of src-tauri/src/voice.rs: speech to text (dictation), text to speech
// and improving a text with a second LLM, against OpenAI-compatible APIs (OpenAI, Groq, speaches, Ollama, LM Studio …).
// The desktop calls curl; the server uses Node's fetch, so the API key only ever travels in the Authorization header.
// Dictation with a "command" runs that program inside the webapp container (not on a Pi host).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sq } from "./host/hostexec.js";
import { isRecord } from "./validation.js";

const OPENAI = "https://api.openai.com/v1";
/** voice.rs gives curl --max-time 180 */
const TIMEOUT_MS = 180_000;
/** Error texts of the APIs are cut like in voice.rs */
const ERROR_MAX = 600;

export interface SttCfg {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  language: string;
  command: string;
}

export interface TtsCfg {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
}

export interface ImproveCfg {
  enabled: boolean;
  afterDictation: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
}

export interface VoiceSettings {
  stt: SttCfg;
  tts: TtsCfg;
  improve: ImproveCfg;
}

const str = (o: Record<string, unknown>, k: string, fallback = "") => (typeof o[k] === "string" ? (o[k] as string) : fallback);

/** The voice part of the shared settings (free-form JSON) as typed values; missing fields get the desktop defaults */
export function voiceSettings(raw: unknown): VoiceSettings {
  const v = isRecord(raw) ? raw : {};
  const s = isRecord(v.stt) ? v.stt : {};
  const t = isRecord(v.tts) ? v.tts : {};
  const i = isRecord(v.improve) ? v.improve : {};
  return {
    stt: {
      provider: str(s, "provider", "off"),
      baseUrl: str(s, "baseUrl"),
      apiKey: str(s, "apiKey"),
      model: str(s, "model"),
      language: str(s, "language"),
      command: str(s, "command"),
    },
    tts: {
      // the webapp's default is "off": nothing is read aloud until an admin sets it up
      provider: str(t, "provider", "off"),
      baseUrl: str(t, "baseUrl"),
      apiKey: str(t, "apiKey"),
      model: str(t, "model"),
      voice: str(t, "voice"),
    },
    improve: {
      enabled: i.enabled === true,
      afterDictation: i.afterDictation === true,
      baseUrl: str(i, "baseUrl"),
      apiKey: str(i, "apiKey"),
      model: str(i, "model"),
      prompt: str(i, "prompt"),
    },
  };
}

/** "<base>/<path>", default base OpenAI */
export function apiUrl(base: string, path: string): string {
  const b = base.trim().replace(/\/+$/, "");
  return `${b || OPENAI}/${path}`;
}

/** File extension the APIs recognise for a recording's MIME type */
export function extForMime(mime: string): string {
  const m = (mime.split(";")[0] ?? "").trim();
  switch (m) {
    case "audio/webm":
    case "video/webm":
      return "webm";
    case "audio/ogg":
      return "ogg";
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "wav";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    default:
      return "m4a"; // audio/mp4 (WebKit, iOS Safari) and unknown
  }
}

/** Remove <think>…</think> blocks that local reasoning models put in front of the answer */
export function stripThink(s: string): string {
  let out = s;
  for (;;) {
    const a = out.indexOf("<think>");
    const b = out.indexOf("</think>");
    if (a < 0 || b < 0 || b < a) break;
    out = out.slice(0, a) + out.slice(b + "</think>".length);
  }
  return out.trim();
}

/** Text of a transcription answer ({"text": …}) or plain text */
export function parseTranscript(body: string): string {
  try {
    const v: unknown = JSON.parse(body);
    if (isRecord(v)) return typeof v.text === "string" ? v.text.trim() : "";
  } catch {
    /* plain text */
  }
  return body.trim();
}

/** Answer text of a chat completion */
export function parseChat(v: unknown): string | null {
  if (!isRecord(v) || !Array.isArray(v.choices)) return null;
  const first: unknown = v.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== "string") return null;
  return stripThink(first.message.content);
}

/** Error text of an API answer: its error.message, otherwise status and body (cut) */
export function errorText(status: number, body: string): string {
  let msg = "";
  try {
    const v: unknown = JSON.parse(body);
    if (isRecord(v) && isRecord(v.error) && typeof v.error.message === "string") msg = v.error.message;
  } catch {
    /* not JSON */
  }
  if (!msg) msg = `HTTP ${status} ${body.trim()}`;
  return msg.trim().slice(0, ERROR_MAX);
}

/** POST to an API; returns the response body. HTTP errors throw the API's error text. */
async function post(url: string, key: string, body: string | FormData, headers: Record<string, string> = {}): Promise<Response> {
  const h: Record<string, string> = { ...headers };
  if (key.trim()) h.Authorization = `Bearer ${key.trim()}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: h, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : e instanceof Error ? e.message : String(e);
    throw new Error(`Voice service not reachable (${new URL(url).host}): ${cause}`);
  }
  if (!res.ok) throw new Error(errorText(res.status, await res.text()));
  return res;
}

const postJson = (url: string, key: string, body: unknown) =>
  post(url, key, JSON.stringify(body), { "Content-Type": "application/json" });

/** Run the dictation command in the container with sh (the alpine image has no bash) */
export function runCommand(script: string, timeoutMs = TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("sh", ["-c", script], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((String(stderr).trim() || err.message).slice(0, ERROR_MAX)));
      else resolve(String(stdout).trim());
    });
  });
}

/** Recording (base64) → text */
export async function transcribe(cfg: SttCfg, dataB64: string, mime: string): Promise<string> {
  const bytes = Buffer.from(dataB64, "base64");
  const type = (mime.split(";")[0] ?? "").trim() || "audio/mp4";
  if (cfg.provider === "api") {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type }), `recording.${extForMime(mime)}`);
    form.append("model", cfg.model.trim() || "whisper-1");
    form.append("response_format", "json");
    if (cfg.language.trim()) form.append("language", cfg.language.trim());
    const res = await post(apiUrl(cfg.baseUrl, "audio/transcriptions"), cfg.apiKey, form);
    return parseTranscript(await res.text());
  }
  if (cfg.provider === "command") {
    if (!cfg.command.trim()) throw new Error("No dictation command set");
    const dir = join(tmpdir(), "pibar-voice");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${randomUUID()}.${extForMime(mime)}`);
    writeFileSync(file, bytes, { mode: 0o600 });
    try {
      return await runCommand(cfg.command.replaceAll("{file}", sq(file)));
    } finally {
      rmSync(file, { force: true });
    }
  }
  throw new Error("Dictation is off (More → Voice)");
}

/** Improve a text with the second LLM and its prompt */
export async function improve(cfg: ImproveCfg, prompt: string, text: string): Promise<string> {
  const body = {
    model: cfg.model.trim(),
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: text },
    ],
  };
  const res = await postJson(apiUrl(cfg.baseUrl, "chat/completions"), cfg.apiKey, body);
  let v: unknown;
  try {
    v = await res.json();
  } catch (e) {
    throw new Error(`Unexpected answer: ${e instanceof Error ? e.message : String(e)}`);
  }
  const out = parseChat(v);
  if (!out) throw new Error("Empty answer");
  return out;
}

/** Text → speech (mp3, base64) */
export async function speak(cfg: TtsCfg, text: string): Promise<{ data: string; mimeType: string }> {
  const body = {
    model: cfg.model.trim() || "gpt-4o-mini-tts",
    voice: cfg.voice.trim() || "alloy",
    input: text,
    response_format: "mp3",
  };
  const res = await postJson(apiUrl(cfg.baseUrl, "audio/speech"), cfg.apiKey, body);
  return { data: Buffer.from(await res.arrayBuffer()).toString("base64"), mimeType: "audio/mpeg" };
}
