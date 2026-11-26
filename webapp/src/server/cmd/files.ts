// File commands with the Tauri names and arguments (src-tauri/src/lib.rs, src/shared/api.ts): list_files, read_file,
// read_image, read_file_head, write_file, create_file, upload_file, download_file, list_dirs, create_dir,
// delete_path (task B6). Every path goes through the host-side guard (host/pathGuard.ts). download_file cannot open
// a save dialog in the browser: it checks the file and answers the URL of the streaming route (routes/files.ts).
import {
  argOptBool,
  argOptStringArray,
  argString,
  argStringArray,
  type CommandContext,
  type CommandRegistry,
} from "../commands.js";
import {
  checkDownload,
  createDir,
  createFile,
  deletePath,
  listDirs,
  listFiles,
  maxUploadBytes,
  readFile,
  readHead,
  readImage,
  uploadFile,
  writeFile,
  type FolderListing,
} from "../host/files.js";
import { OUTSIDE, sessionRoots } from "../host/pathGuard.js";

/** Extra allowed folder of a host besides the home and its session folders: the default folder of new sessions */
export function hostExtraRoots(ctx: CommandContext): string[] {
  const d = ctx.store.hosts.get(ctx.host.id)?.defaultDir.trim() ?? "";
  return d ? [d] : [];
}

/** Run a guarded file operation with the host's allowed folders */
export function guarded<T>(ctx: CommandContext, op: (roots: string[]) => Promise<T>): Promise<T> {
  return sessionRoots(ctx.exec).run(ctx.host, hostExtraRoots(ctx), op);
}

/** URL of the streaming download route for a file */
export function downloadUrl(hostId: string, path: string, inline = false): string {
  const q = new URLSearchParams({ hostId, path });
  if (inline) q.set("inline", "1");
  return `/api/files/download?${q.toString()}`;
}

export function registerFileCommands(registry: CommandRegistry, maxUpload = maxUploadBytes()) {
  registry.register("list_files", {
    host: true,
    run: async (ctx, args) => {
      const folders = argStringArray(args, "folders").slice(0, 20);
      const git = argOptBool(args, "git", false);
      const docsOnly = argOptBool(args, "docsOnly", false);
      // listFiles reports a refused folder in its listing (the others still show); to get the retry with a fresh
      // session list it is turned into an error once, and the first answer kept for when no retry happens
      let firstTry: FolderListing[] | null = null;
      try {
        return await guarded(ctx, async (roots) => {
          const l = await listFiles(ctx.exec, ctx.host, folders, git, docsOnly, roots);
          if (firstTry === null && l.some((x) => x.error?.includes(OUTSIDE))) {
            firstTry = l;
            throw new Error(OUTSIDE);
          }
          return l;
        });
      } catch (e) {
        if (firstTry) return firstTry;
        throw e;
      }
    },
  });
  registry.register("read_file", {
    host: true,
    run: (ctx, args) => guarded(ctx, (roots) => readFile(ctx.exec, ctx.host, argString(args, "path"), roots)),
  });
  registry.register("read_image", {
    host: true,
    run: (ctx, args) => guarded(ctx, (roots) => readImage(ctx.exec, ctx.host, argString(args, "path"), roots)),
  });
  registry.register("read_file_head", {
    host: true,
    run: (ctx, args) => guarded(ctx, (roots) => readHead(ctx.exec, ctx.host, argString(args, "path"), roots)),
  });
  registry.register("write_file", {
    host: true,
    run: (ctx, args) => {
      const path = argString(args, "path");
      const content = argString(args, "content");
      return guarded(ctx, (roots) => writeFile(ctx.exec, ctx.host, path, content, roots)).then(() => null);
    },
  });
  registry.register("create_file", {
    host: true,
    run: (ctx, args) =>
      guarded(ctx, (roots) => createFile(ctx.exec, ctx.host, argString(args, "path"), roots)).then(() => null),
  });
  registry.register("upload_file", {
    host: true,
    run: (ctx, args) => {
      const path = argString(args, "path");
      const data = argString(args, "data");
      const overwrite = argOptBool(args, "overwrite", false);
      return guarded(ctx, (roots) => uploadFile(ctx.exec, ctx.host, path, data, overwrite, maxUpload, roots));
    },
  });
  registry.register("download_file", {
    host: true,
    run: async (ctx, args) => {
      const path = argString(args, "path");
      await guarded(ctx, (roots) => checkDownload(ctx.exec, ctx.host, path, roots));
      return downloadUrl(ctx.host.id, path, argOptBool(args, "inline", false));
    },
  });
  registry.register("list_dirs", {
    host: true,
    run: (ctx, args) => listDirs(ctx.exec, ctx.host, argString(args, "path"), argOptBool(args, "hidden", false)),
  });
  registry.register("create_dir", {
    host: true,
    run: (ctx, args) =>
      guarded(ctx, (roots) => createDir(ctx.exec, ctx.host, argString(args, "path"), roots)).then(() => null),
  });
  registry.register("delete_path", {
    host: true,
    run: (ctx, args) => {
      const path = argString(args, "path");
      const treeRoots = argOptStringArray(args, "roots") ?? [];
      return guarded(ctx, (roots) => deletePath(ctx.exec, ctx.host, path, treeRoots, roots)).then(() => null);
    },
  });
}
