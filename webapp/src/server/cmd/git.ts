// Git commands with the Tauri names and arguments (src-tauri/src/lib.rs: git_log, git_commit = details of a commit,
// git_diff; task B7) and the webapp's own git_create_commit (commit selected changes with a message, task G6).
// Folders go through the host-side path guard like the file commands.
import {
  argOptNumber,
  argOptString,
  argString,
  argStringArray,
  CommandError,
  type CommandRegistry,
} from "../commands.js";
import { createCommit, gitCommit, gitDiff, gitLog } from "../host/git.js";
import { guarded } from "./files.js";

/** Longest commit message accepted */
const MAX_MESSAGE = 20_000;

export function registerGitCommands(registry: CommandRegistry) {
  registry.register("git_log", {
    host: true,
    run: (ctx, args) => {
      const dir = argString(args, "dir");
      const file = argOptString(args, "file", "") || null;
      const limit = argOptNumber(args, "limit", 200);
      return guarded(ctx, (roots) => gitLog(ctx.exec, ctx.host, dir, file, limit, roots));
    },
  });
  registry.register("git_commit", {
    host: true,
    run: (ctx, args) => {
      const dir = argString(args, "dir");
      const hash = argString(args, "hash");
      return guarded(ctx, (roots) => gitCommit(ctx.exec, ctx.host, dir, hash, roots));
    },
  });
  registry.register("git_diff", {
    host: true,
    run: (ctx, args) => {
      const dir = argString(args, "dir");
      const hash = argString(args, "hash");
      const path = argString(args, "path");
      const top = args.top === true;
      return guarded(ctx, (roots) => gitDiff(ctx.exec, ctx.host, dir, hash, path, top, roots));
    },
  });
  registry.register("git_create_commit", {
    host: true,
    run: (ctx, args) => {
      const dir = argString(args, "dir");
      const paths = argStringArray(args, "paths");
      const message = argString(args, "message");
      if (message.length > MAX_MESSAGE) throw new CommandError(400, "Commit message too long");
      if (paths.length > 2000) throw new CommandError(400, "Too many files");
      return guarded(ctx, (roots) => createCommit(ctx.exec, ctx.host, dir, paths, message, roots));
    },
  });
}
