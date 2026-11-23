/**
 * Config Exchange API – PiBar ↔ Webapp
 *
 * Ermöglicht bidirektionale Konfigurations-Synchronisation:
 *   - PiBar exportiert seine Session-Konfig (Sessions, Projekte, Farben, Gruppen)
 *   - Webapp empfängt und speichert; PiBar kann Konfigurationen importieren
 *
 * Aufruf: configExchange.export() / configExchange.import(config)
 */

import { readDirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export interface SessionConfig {
  id: string;
  name: string;
  color: string;
  group?: string;
  pinned: boolean;
  status: "active" | "archived";
  createdAt: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  isFolder: boolean;
}

export interface ConfigPayload {
  sessions: SessionConfig[];
  projects: ProjectConfig[];
  colors: Record<string, string>;
  groups: Record<string, { name: string; color: string }>;
  meta?: {
    version: string;
    generatedAt: string;
    host: string;
  };
}

export interface ConfigStatus {
  ok: boolean;
  message: string;
  exportedSessions: number;
  exportedProjects: number;
}

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

/** Pfad zum PiBar-Session-Store (JSONL) */
const SESSION_STORE_DIR = join(
  process.env.HOME ?? "/root",
  ".pi",
  "agent",
  "sessions"
);

/** Webhook-URL, an den PiBar die Config sendet (via WebSocket / HTTP) */
const WEBHOOK_URL = process.env.CONFIG_EXCHANGE_WEBHOOK_URL ?? "";

// ---------------------------------------------------------------------------
// Export: SessionConfig auslesen und an Webapp senden
// ---------------------------------------------------------------------------

/**
 * Liest alle Sessions aus dem JSONL-Store und gibt eine SessionConfig zurück.
 */
export function exportSessionConfig(): Promise<SessionConfig[]> {
  return new Promise((resolve, reject) => {
    if (!existsSync(SESSION_STORE_DIR)) {
      return resolve([]);
    }

    const files = readDirSync(SESSION_STORE_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();

    const sessions: SessionConfig[] = [];
    for (const file of files) {
      try {
        const content = readFileSync(join(SESSION_STORE_DIR, file), "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          const entry = JSON.parse(line);
          if (
            typeof entry === "object" &&
            "id" in entry &&
            "name" in entry &&
            "color" in entry
          ) {
            sessions.push({
              id: String(entry.id),
              name: String(entry.name),
              color: String(entry.color),
              group: entry.group,
              pinned: Boolean(entry.pinned ?? false),
              status: (entry.status as SessionConfig["status"]) ?? "active",
              createdAt: entry.createdAt ?? new Date().toISOString(),
            });
          }
        }
      } catch {
        // Ignoriere fehlerhafte Einträge
      }
    }
    resolve(sessions);
  });
}

/**
 * Sendet die Session-Konfig an den Webapp-Host (Webhook).
 * Wird aufgerufen, wenn der User "Config Exchange" im PiBar-Menü wählt.
 */
export async function sendToWebapp(config: ConfigPayload): Promise<boolean> {
  if (!WEBHOOK_URL) {
    console.warn("[configExchange] No webhook URL configured (CONFIG_EXCHANGE_WEBHOOK_URL).");
    return false;
  }

  try {
    // Versuche HTTP POST (für WebSocket-basierte RPC nutzen wir einen anderen Mechanismus)
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      console.error("[configExchange] Webhook-Fehler:", response.status);
      return false;
    }

    const text = await response.text();
    console.log("[configExchange] Sent to webapp:", text);
    return true;
  } catch (err) {
    console.error("[configExchange] Send error:", err);
    return false;
  }
}

/**
 * Importiert eine Session-Konfig von außen (z. B. von der Webapp).
 * Schreibt die Konfig in den JSONL-Store.
 */
export async function importSessionConfig(config: ConfigPayload): Promise<boolean> {
  if (!existsSync(SESSION_STORE_DIR)) {
    return false;
  }

  // Prüfe auf bestehende Sessions mit gleichem ID (Überschreiben vermeiden)
  const existing = readDirSync(SESSION_STORE_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => JSON.parse(readFileSync(join(SESSION_STORE_DIR, f), "utf-8")));

  const toWrite: string[] = [];
  for (const s of config.sessions) {
    // Überschreibe nur, wenn ID noch nicht existiert
    if (!existing.some((e) => String(e.id) === s.id)) {
      toWrite.push(JSON.stringify(s) + "\n");
    }
  }

  if (toWrite.length === 0) {
    console.log("[configExchange] No new sessions to import.");
    return true;
  }

  const dirContent = existing.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(join(SESSION_STORE_DIR, "sessions.jsonl"), dirContent + toWrite.join("\n"));
  console.log("[configExchange] Imported", toWrite.length, "sessions.");
  return true;
}

/**
 * Gibt den aktuellen Config-Status zurück.
 */
export async function getConfigStatus(): Promise<ConfigStatus> {
  const sessions = await exportSessionConfig();
  return {
    ok: true,
    message: `Exported ${sessions.length} session(s).`,
    exportedSessions: sessions.length,
    exportedProjects: 0,
  };
}

/**
 * Lädt die komplette Config (Sessions + Projekte) aus dem Store.
 */
export async function loadConfig(): Promise<ConfigPayload> {
  const sessions = await exportSessionConfig();
  return {
    sessions,
    projects: [],
    colors: {},
    groups: {},
    meta: {
      version: "1.0.0",
      generatedAt: new Date().toISOString(),
      host: process.env.HOST ?? "unknown",
    },
  };
}
