// All commands of the webapp, registered on one CommandRegistry (see ../commands.ts). Each area of the Rust core
// gets its own module here (sessions, files, git, pi, …) with a register function; this file only collects them.
import { CommandRegistry } from "../commands.js";
import { registerHostCommands } from "./hosts.js";
import { registerSessionCommands } from "./sessions.js";

/** Commands every build has: `ping` (login and router check of the client) */
function registerCore(registry: CommandRegistry) {
  registry.register("ping", {
    run: (ctx) => ({ pong: true, username: ctx.user.username, role: ctx.user.role }),
  });
}

export function createRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registerCore(registry);
  registerHostCommands(registry);
  registerSessionCommands(registry);
  return registry;
}
