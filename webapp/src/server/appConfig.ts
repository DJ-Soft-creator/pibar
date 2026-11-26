// Settings of the webapp that all users share, managed by the admin (app-config.json): model presets, quick action
// buttons, chat colour profiles, the descriptions of the session colours, and the voice services. Field shapes as in
// AppConfig of src/shared/api.ts. API keys of the voice services stay on the server: publicConfig() leaves them out.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isRecord } from "./validation.js";

export interface AppSettings {
  /** ModelPreset[]: { id, name, model "<provider>/<id>", thinking } */
  presets: Record<string, unknown>[];
  /** QuickAction[]: { id, name, kind "command" | "shell", text } – the webapp only runs "command" */
  quickActions: Record<string, unknown>[];
  /** ColorProfile[]: { id, name, dark?, light? } */
  colorProfiles: Record<string, unknown>[];
  /** Colour name → own description (shared/sessionColors.ts) */
  sessionColorLabels: Record<string, string>;
  /** Voice services (VoiceCfg-like); apiKey fields are secret */
  voice: Record<string, unknown>;
}

export const defaultSettings = (): AppSettings => ({
  presets: [],
  quickActions: [],
  colorProfiles: [],
  sessionColorLabels: {},
  voice: {},
});

const isList = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.every(isRecord);

/** Check an admin's PUT body; returns the settings or an error text */
export function validateSettings(body: unknown): AppSettings | string {
  if (!isRecord(body)) return "Expected a JSON object";
  const out = defaultSettings();
  for (const key of ["presets", "quickActions", "colorProfiles"] as const) {
    if (body[key] === undefined) continue;
    if (!isList(body[key])) return `${key} must be a list of objects`;
    out[key] = body[key] as Record<string, unknown>[];
  }
  if (body.sessionColorLabels !== undefined) {
    const l = body.sessionColorLabels;
    if (!isRecord(l) || !Object.values(l).every((v) => typeof v === "string")) return "sessionColorLabels must map names to texts";
    out.sessionColorLabels = l as Record<string, string>;
  }
  if (body.voice !== undefined) {
    if (!isRecord(body.voice)) return "voice must be an object";
    out.voice = body.voice;
  }
  return out;
}

/** Copy without secrets: every field named apiKey (at any depth) becomes "" plus a flag that one is set */
export function withoutSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutSecrets);
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "apiKey") {
      out.apiKey = "";
      out.apiKeySet = typeof x === "string" && x !== "";
    } else out[k] = withoutSecrets(x);
  }
  return out;
}

/**
 * An admin saves the settings he got without secrets: an empty apiKey next to apiKeySet=true keeps the stored key.
 * Returns `next` with the kept keys filled in.
 */
export function keepSecrets(next: unknown, prev: unknown): unknown {
  if (Array.isArray(next)) return next.map((x, i) => keepSecrets(x, Array.isArray(prev) ? prev[i] : undefined));
  if (!isRecord(next)) return next;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(next)) {
    if (k === "apiKeySet") continue;
    if (k === "apiKey" && x === "" && next.apiKeySet === true && isRecord(prev) && typeof prev.apiKey === "string") {
      out.apiKey = prev.apiKey;
    } else out[k] = keepSecrets(x, isRecord(prev) ? prev[k] : undefined);
  }
  return out;
}

export class AppConfigStore {
  settings: AppSettings = defaultSettings();
  private readonly file: string;
  private listeners = new Set<() => void>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "app-config.json");
    if (existsSync(this.file)) {
      const parsed = validateSettings(JSON.parse(readFileSync(this.file, "utf8")) as unknown);
      if (typeof parsed === "string") throw new Error(`Corrupt app config: ${this.file}: ${parsed}`);
      this.settings = parsed;
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** What every logged-in user may read */
  publicConfig(): AppSettings {
    return withoutSecrets(this.settings) as AppSettings;
  }

  save(next: AppSettings) {
    this.settings = keepSecrets(next, this.settings) as AppSettings;
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    // may contain API keys: owner only
    writeFileSync(tmp, JSON.stringify(this.settings, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.file);
    for (const fn of this.listeners) fn();
  }
}
