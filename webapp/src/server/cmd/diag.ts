// Diagnosis and the temperature extension (diag.rs, temp.rs): diagnose (report of the host, secrets hidden by the
// script) and temp_install (writes pibar-temperature.ts into Pi's extensions folder) – tasks B12, B13.
import { argOptString, type CommandRegistry } from "../commands.js";
import { diagnose } from "../host/diag.js";
import { tempInstall } from "../host/temp.js";

export function registerDiagCommands(registry: CommandRegistry) {
  registry.register("diagnose", {
    host: true,
    run: (ctx, args) => diagnose(ctx.exec, ctx.host, argOptString(args, "provider"), argOptString(args, "model")),
  });
  registry.register("temp_install", {
    host: true,
    run: async (ctx) => {
      await tempInstall(ctx.exec, ctx.host);
      return null;
    },
  });
}
