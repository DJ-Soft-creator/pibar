// Reading and searching sessions with the Tauri names (sessions.rs, lib.rs): search_sessions (one grep over the host's
// session files), read_session_file (whole file for the export), session_touches (files Pi changed per own message).
// Every command works on a host (`host: true`: the router checks the user may use it); paths must be Pi session files.
import { argString, type CommandRegistry } from "../commands.js";
import { readSessionFile, searchSessions, sessionTouches } from "../host/sessions.js";

export function registerSearchCommands(registry: CommandRegistry) {
  registry.register("search_sessions", {
    host: true,
    run: (ctx, args) => searchSessions(ctx.exec, ctx.host, argString(args, "query")),
  });
  registry.register("read_session_file", {
    host: true,
    run: (ctx, args) => readSessionFile(ctx.exec, ctx.host, argString(args, "path")),
  });
  registry.register("session_touches", {
    host: true,
    run: (ctx, args) => sessionTouches(ctx.exec, ctx.host, argString(args, "path")),
  });
}
