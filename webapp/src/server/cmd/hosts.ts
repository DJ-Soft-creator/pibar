// Host commands: test_host (lib.rs: `<pi> --version` on the host).
import type { CommandRegistry } from "../commands.js";
import { piProgram } from "../host/hostexec.js";

export function registerHostCommands(registry: CommandRegistry) {
  registry.register("test_host", {
    host: true,
    run: async (ctx) => (await ctx.exec.runShell(ctx.host, `${piProgram(ctx.host)} --version`)).trim(),
  });
}
