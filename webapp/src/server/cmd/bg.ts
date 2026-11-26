// Runs in the background (bg.rs): bg_start, bg_follow, bg_running, bg_stop – task B11. A followed run streams its
// log like a live Pi (PiManager), so the chat renders it with the same events.
// Placeholder of the rebuild: the commands are registered here.
import type { CommandRegistry } from "../commands.js";
import type { PiManager } from "../host/pi.js";

export function registerBgCommands(_registry: CommandRegistry, _pi: PiManager) {
  // filled by task B11
}
