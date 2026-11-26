// File states for going back (snapshot.rs): snapshot_take, rewind_preview, rewind_restore, rewind_undo – task B8.
// Same refs as the desktop (refs/pibar/<session id>/<entry id>), so states are shared between both. Folder, ids and
// commits are checked in host/snapshot.ts before anything reaches the shell.
import { argString, argStringArray, CommandError, type CommandRegistry } from "../commands.js";
import { rewindPreview, rewindRestore, rewindUndo, snapshotTake } from "../host/snapshot.js";

/** Errors of the shape checks are the caller's fault (400), the rest comes from the host */
function guard<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((e: unknown) => {
    if (e instanceof Error && /^(Path not allowed|Not an id|Not a commit|No session for this point)/.test(e.message)) {
      throw new CommandError(400, e.message);
    }
    throw e;
  });
}

export function registerSnapshotCommands(registry: CommandRegistry) {
  registry.register("snapshot_take", {
    host: true,
    run: (ctx, args) =>
      guard(() => snapshotTake(ctx.exec, ctx.host, argString(args, "dir"), argString(args, "sessionId"), argString(args, "tag"))),
  });
  registry.register("rewind_preview", {
    host: true,
    run: (ctx, args) =>
      guard(() =>
        rewindPreview(
          ctx.exec,
          ctx.host,
          argString(args, "dir"),
          argStringArray(args, "sessionIds"),
          argString(args, "tag"),
          argStringArray(args, "paths"),
        ),
      ),
  });
  registry.register("rewind_restore", {
    host: true,
    run: (ctx, args) =>
      guard(() =>
        rewindRestore(
          ctx.exec,
          ctx.host,
          argString(args, "dir"),
          argStringArray(args, "sessionIds"),
          argString(args, "tag"),
          argStringArray(args, "paths"),
        ),
      ),
  });
  registry.register("rewind_undo", {
    host: true,
    run: (ctx, args) =>
      guard(() =>
        rewindUndo(ctx.exec, ctx.host, argString(args, "dir"), argString(args, "commit"), argStringArray(args, "paths")),
      ),
  });
}
