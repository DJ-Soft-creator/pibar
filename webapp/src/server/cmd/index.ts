// All commands of the webapp, registered on one CommandRegistry (see ../commands.ts). Each area of the Rust core
// gets its own module here (sessions, files, git, pi, …) with a register function; this file only collects them.
import { CommandRegistry } from "../commands.js";
import type { AppConfigStore } from "../appConfig.js";
import type { PiManager } from "../host/pi.js";
import type { MetaStore } from "../meta.js";
import { registerBgCommands } from "./bg.js";
import { registerDiagCommands } from "./diag.js";
import { registerFileCommands } from "./files.js";
import { registerGitCommands } from "./git.js";
import { registerHostCommands } from "./hosts.js";
import { registerMetaCommands } from "./meta.js";
import { registerModelCommands } from "./models.js";
import { registerPiCommands } from "./pi.js";
import { registerSearchCommands } from "./search.js";
import { registerSessionCommands } from "./sessions.js";
import { registerSnapshotCommands } from "./snapshot.js";
import { registerVoiceCommands } from "./voice.js";

/** Commands every build has: `ping` (login and router check of the client) */
function registerCore(registry: CommandRegistry) {
  registry.register("ping", {
    run: (ctx) => ({ pong: true, username: ctx.user.username, role: ctx.user.role }),
  });
}

export interface RegistryDeps {
  /** Running Pi processes; without it the pi_* commands are missing (tests of other areas) */
  pi?: PiManager;
  /** Organisation of the session list and shared settings; without them meta_* / app_config_get are missing */
  meta?: MetaStore;
  appConfig?: AppConfigStore;
}

export function createRegistry(deps: RegistryDeps = {}): CommandRegistry {
  const registry = new CommandRegistry();
  registerCore(registry);
  registerHostCommands(registry);
  registerSessionCommands(registry);
  registerSearchCommands(registry);
  registerFileCommands(registry);
  registerGitCommands(registry);
  registerModelCommands(registry);
  registerSnapshotCommands(registry);
  registerDiagCommands(registry);
  registerVoiceCommands(registry, deps);
  if (deps.pi) {
    registerPiCommands(registry, deps.pi);
    registerBgCommands(registry, deps.pi);
  }
  if (deps.meta && deps.appConfig) registerMetaCommands(registry, deps.meta, deps.appConfig);
  return registry;
}
