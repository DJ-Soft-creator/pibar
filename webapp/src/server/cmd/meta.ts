// Organisation of the session list (meta.ts): read it, change session metadata, groups and projects. Webapp
// commands without a Tauri twin (on the desktop this lives in AppConfig and is saved with save_config).
// Session keys and projects are checked against the user's hosts; groups are shared by everybody.
import type { AppConfigStore } from "../appConfig.js";
import { argString, CommandError, type CommandContext, type CommandRegistry } from "../commands.js";
import { canUseHost } from "../helpers.js";
import { keyHost, type GroupValue, type MetaStore, type ProjectValue } from "../meta.js";
import { isRecord } from "../validation.js";

function ownHost(ctx: CommandContext, hostId: string) {
  if (!hostId || !canUseHost(ctx.user, hostId)) throw new CommandError(403, "No access to this host");
}

export function registerMetaCommands(registry: CommandRegistry, meta: MetaStore, appConfig: AppConfigStore) {
  registry.register("meta_get", {
    run: (ctx) => meta.view((hostId) => canUseHost(ctx.user, hostId)),
  });
  /** { key: "<hostId>|<path>", meta: SessionMeta | null } – replaces the whole entry */
  registry.register("meta_set_session", {
    run: (ctx, args) => {
      const key = argString(args, "key");
      ownHost(ctx, keyHost(key));
      if (args.meta !== null && !isRecord(args.meta)) throw new CommandError(400, "meta must be an object or null");
      meta.setSession(key, (args.meta as Record<string, unknown> | null) ?? null);
      return null;
    },
  });
  registry.register("meta_save_group", {
    run: (_ctx, args) => {
      const g = args.group;
      if (!isRecord(g) || typeof g.id !== "string" || !g.id || typeof g.name !== "string") {
        throw new CommandError(400, "group needs id and name");
      }
      meta.setGroup(g.id, { color: "", collapsed: false, ...g } as GroupValue);
      return null;
    },
  });
  registry.register("meta_delete_group", {
    run: (_ctx, args) => {
      meta.setGroup(argString(args, "id"), null);
      return null;
    },
  });
  registry.register("meta_save_project", {
    run: (ctx, args) => {
      const p = args.project;
      if (!isRecord(p) || typeof p.id !== "string" || !p.id || typeof p.name !== "string" || typeof p.dir !== "string") {
        throw new CommandError(400, "project needs id, name, hostId and dir");
      }
      ownHost(ctx, typeof p.hostId === "string" ? p.hostId : "");
      meta.setProject(p.id, { collapsed: false, ...p } as ProjectValue);
      return null;
    },
  });
  registry.register("meta_delete_project", {
    run: (ctx, args) => {
      const id = argString(args, "id");
      const cur = meta.state.projects[id]?.value;
      if (cur) ownHost(ctx, cur.hostId);
      meta.setProject(id, null);
      return null;
    },
  });
  /** Shared settings without secrets (presets, quick actions, colour profiles, colour labels, voice) */
  registry.register("app_config_get", {
    run: () => appConfig.publicConfig(),
  });
}
