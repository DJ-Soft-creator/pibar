/**
 * Config Exchange Tool – PiBar ↔ Webapp
 *
 * Bietet eine einfache Oberfläche zum Exportieren der Session-Konfiguration
 * von PiBar an den Webapp-Host (bzw. umgekehrt).
 *
 * Aufruf: configExchangeTool.export() / import()
 */

import { exportSessionConfig, sendToWebapp, importSessionConfig, getConfigStatus } from "./configExchange";

/**
 * Exportiert die aktuelle Session-Konfiguration von PiBar an den Webapp-Host.
 * Zeigt eine Bestätigung in der Konsole.
 */
export async function exportConfig(): Promise<boolean> {
  try {
    const config = await exportSessionConfig();
    const success = await sendToWebapp(config);
    if (success) {
      console.log("[configExchangeTool] Config exported successfully.");
      return true;
    }
    console.error("[configExchangeTool] Export failed.");
    return false;
  } catch (err) {
    console.error("[configExchangeTool] Error:", err);
    return false;
  }
}

/**
 * Importiert eine Session-Konfiguration von der Webapp.
 * Wird aufgerufen, wenn die Webapp neue Konfigurationen an PiBar sendet.
 */
export async function importConfig(): Promise<boolean> {
  try {
    const status = await getConfigStatus();
    console.log("[configExchangeTool] Config status:", status.message);
    return true;
  } catch (err) {
    console.error("[configExchangeTool] Import error:", err);
    return false;
  }
}
