// Organisation of the session list (meta.ts): read it, change session metadata, groups and projects. Webapp
// commands without a Tauri twin (on the desktop this lives in AppConfig and is saved with save_config).
// Every user has an own organisation (UserMetaStores); session keys and projects are checked against the user's hosts.
import type { AppConfigStore } from "../appConfig.js";
import { argString, CommandError, type CommandContext, type CommandRegistry } from "../commands.js";
import { canUseHost } from "../helpers.js";
import { keyHost, type GroupValue, type ProjectValue, type UserMetaStores } from "../meta.js";
import { isRecord } from "../validation.js";

function ownHost(ctx: CommandContext, hostId: string) {
  if (!hostId || !canUseHost(ctx.user, hostId)) throw new CommandError(403, "No access to this host");
}

export function registerMetaCommands(registry: CommandRegistry, metas: UserMetaStores, appConfig: AppConfigStore) {
  registry.register("meta_get", {
    run: (ctx) => metas.of(ctx.user.id).view((hostId) => canUseHost(ctx.user, hostId)),
  });
  /** { key: "<hostId>|<path>", meta: SessionMeta | null } – replaces the whole entry */
  registry.register("meta_set_session", {
    run: (ctx, args) => {
      const key = argString(args, "key");
      ownHost(ctx, keyHost(key));
      if (args.meta !== null && !isRecord(args.meta)) throw new CommandError(400, "meta must be an object or null");
      metas.of(ctx.user.id).setSession(key, (args.meta as Record<string, unknown> | null) ?? null);
      return null;
    },
  });
  registry.register("meta_save_group", {
    run: (ctx, args) => {
      const g = args.group;
      if (!isRecord(g) || typeof g.id !== "string" || !g.id || typeof g.name !== "string") {
        throw new CommandError(400, "group needs id and name");
      }
      metas.of(ctx.user.id).setGroup(g.id, { color: "", collapsed: false, ...g } as GroupValue);
      return null;
    },
  });
  registry.register("meta_delete_group", {
    run: (ctx, args) => {
      metas.of(ctx.user.id).setGroup(argString(args, "id"), null);
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
      metas.of(ctx.user.id).setProject(p.id, { collapsed: false, ...p } as ProjectValue);
      return null;
    },
  });
  registry.register("meta_delete_project", {
    run: (ctx, args) => {
      const id = argString(args, "id");
      const meta = metas.of(ctx.user.id);
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
