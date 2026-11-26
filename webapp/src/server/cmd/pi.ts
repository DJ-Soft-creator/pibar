// Pi process commands with the Tauri names (lib.rs: pi_open, pi_send, pi_reply, pi_stderr, pi_close). Commands with a
// handle check that the user may use the host the process runs on. pi_open joins a session that already runs in the
// webapp instead of starting it twice (see host/pi.ts).
import { argOptString, argOptStringArray, CommandError, type CommandContext, type CommandRegistry } from "../commands.js";
import { canUseHost } from "../helpers.js";
import type { PiManager } from "../host/pi.js";
import { isSessionFile } from "../host/sessions.js";
import { isRecord } from "../validation.js";

function handleOf(ctx: CommandContext, pi: PiManager, args: Record<string, unknown>): number {
  const handle = args.handle;
  if (typeof handle !== "number" || !Number.isInteger(handle)) throw new CommandError(400, "handle must be a number");
  const info = pi.info(handle);
  // an unknown handle and one of a foreign host look the same
  if (!info || !canUseHost(ctx.user, info.hostId)) throw new CommandError(404, "Pi process not found");
  return handle;
}

export function registerPiCommands(registry: CommandRegistry, pi: PiManager) {
  registry.register("pi_open", {
    host: true,
    run: (ctx, args) => {
      const cwd = argOptString(args, "cwd", "~") || "~";
      const sessionPath = argOptString(args, "sessionPath") || null;
      if (sessionPath && !isSessionFile(sessionPath)) throw new CommandError(400, `Not a Pi session file: ${sessionPath}`);
      return pi.open(ctx.host, cwd, {
        sessionPath,
        tools: argOptStringArray(args, "tools"),
        appendPrompt: argOptString(args, "appendPrompt") || null,
      }).handle;
    },
  });
  /** Webapp only: like pi_open, but also says whether a running process was joined and how far its events are */
  registry.register("pi_attach", {
    host: true,
    run: (ctx, args) => {
      const cwd = argOptString(args, "cwd", "~") || "~";
      const sessionPath = argOptString(args, "sessionPath") || null;
      if (sessionPath && !isSessionFile(sessionPath)) throw new CommandError(400, `Not a Pi session file: ${sessionPath}`);
      // tools (plan mode, a subagent's allowlist) and an agent's system prompt only count when Pi starts
      const { handle, joined } = pi.open(ctx.host, cwd, {
        sessionPath,
        tools: argOptStringArray(args, "tools"),
        appendPrompt: argOptString(args, "appendPrompt") || null,
      });
      const info = pi.info(handle);
      return { handle, joined, streaming: info?.streaming ?? false, seq: pi.replay(handle, Number.MAX_SAFE_INTEGER).seq };
    },
  });
  /** Webapp only: the Pi processes running on the user's hosts (session list marks, "working" badges) */
  registry.register("pi_list", {
    run: (ctx) => pi.list().filter((p) => canUseHost(ctx.user, p.hostId)),
  });
  registry.register("pi_send", {
    run: async (ctx, args) => {
      const handle = handleOf(ctx, pi, args);
      if (!isRecord(args.cmd) || typeof args.cmd.type !== "string") throw new CommandError(400, "cmd must be a Pi command");
      return pi.send(handle, args.cmd);
    },
  });
  registry.register("pi_reply", {
    run: (ctx, args) => {
      const handle = handleOf(ctx, pi, args);
      if (!isRecord(args.msg)) throw new CommandError(400, "msg must be an object");
      pi.reply(handle, args.msg);
      return null;
    },
  });
  registry.register("pi_stderr", {
    run: (ctx, args) => pi.stderr(handleOf(ctx, pi, args)),
  });
  registry.register("pi_close", {
    run: (ctx, args) => {
      pi.close(handleOf(ctx, pi, args));
      return null;
    },
  });
}
