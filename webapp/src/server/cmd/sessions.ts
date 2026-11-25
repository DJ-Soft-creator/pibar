// Session commands with the Tauri names: list_sessions, delete_sessions, session_outlines (src-tauri/src/sessions.rs).
import { argStringArray, type CommandRegistry } from "../commands.js";
import { deleteSessions, listSessions, sessionOutlines } from "../host/sessions.js";

export function registerSessionCommands(registry: CommandRegistry) {
  registry.register("list_sessions", {
    host: true,
    run: (ctx) => listSessions(ctx.exec, ctx.host),
  });
  registry.register("delete_sessions", {
    host: true,
    run: (ctx, args) => deleteSessions(ctx.exec, ctx.host, argStringArray(args, "paths")),
  });
  registry.register("session_outlines", {
    host: true,
    run: (ctx, args) => sessionOutlines(ctx.exec, ctx.host, argStringArray(args, "paths")),
  });
}
