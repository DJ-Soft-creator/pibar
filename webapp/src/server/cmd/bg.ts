// Runs in the background (bg.rs, lib.rs: bg_start, bg_follow, bg_running, bg_stop) – task B11. A followed run streams
// its log like a live Pi (PiManager.openFollow), so the chat renders it with the same events. The files on the host
// (~/.pibar/<hash>.log/.pid) are the desktop's, so runs started on either side can be followed and stopped on both.
import {
  argOptBool,
  argOptString,
  argOptStringArray,
  argString,
  CommandError,
  type CommandRegistry,
} from "../commands.js";
import { bgArgs, bgRunning, bgStart, bgStop } from "../host/bg.js";
import { toolArgs, type PiManager } from "../host/pi.js";
import { isSessionFile } from "../host/sessions.js";

function sessionArg(args: Record<string, unknown>): string {
  const session = argString(args, "session");
  if (!isSessionFile(session)) throw new CommandError(400, `Not a Pi session file: ${session}`);
  return session;
}

export function registerBgCommands(registry: CommandRegistry, pi: PiManager) {
  /** Send one message as a detached run; returns the handle of the follower (the stream the chat shows) */
  registry.register("bg_start", {
    host: true,
    run: async (ctx, args) => {
      const session = sessionArg(args);
      const cwd = argOptString(args, "cwd", "~") || "~";
      const prompt = argString(args, "prompt");
      const temperature = args.temperature;
      // two Pi processes must never write the same session file: an idle live process of the webapp goes first
      const live = pi.findSession(ctx.host.id, session);
      if (live !== null) {
        if (pi.info(live)?.streaming) throw new CommandError(409, "Pi is still working in this session");
        pi.close(live);
      }
      const list = bgArgs(
        {
          session,
          prompt,
          provider: argOptString(args, "provider") || null,
          modelId: argOptString(args, "modelId") || null,
          thinking: argOptString(args, "thinking") || null,
          tools: argOptStringArray(args, "tools"),
          publicMode: argOptBool(args, "publicMode", false),
          temperature: typeof temperature === "number" ? temperature : null,
        },
        toolArgs,
      );
      await bgStart(ctx.exec, ctx.host, cwd, session, list);
      return pi.openFollow(ctx.host, session).handle;
    },
  });
  registry.register("bg_follow", {
    host: true,
    run: (ctx, args) => pi.openFollow(ctx.host, sessionArg(args)).handle,
  });
  registry.register("bg_running", {
    host: true,
    run: (ctx, args) => bgRunning(ctx.exec, ctx.host, sessionArg(args)),
  });
  registry.register("bg_stop", {
    host: true,
    run: async (ctx, args) => {
      await bgStop(ctx.exec, ctx.host, sessionArg(args));
      return null;
    },
  });
}
