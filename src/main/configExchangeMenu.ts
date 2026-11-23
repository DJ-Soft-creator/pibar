/**
 * Config Exchange Menu – PiBar sidebar entry
 *
 * Öffnet ein Menü mit der Option "Config Exchange", um die Session-Konfiguration
 * an den Webapp-Host zu exportieren (bzw. importieren).
 */

import { openMenu } from "./menu";
import { configExchangeTool } from "./configExchangeTool";

export function openConfigExchangeMenu(anchor: HTMLElement) {
  const items = [
    {
      label: "Config Exchange",
      desc: "Exportiere Session-Konfig nach Webapp (oder importiere Konfiguration von Webapp)",
      onSelect: () => {
        configExchangeTool.exportConfig();
      },
    },
  ];
  openMenu(anchor, items);
}
