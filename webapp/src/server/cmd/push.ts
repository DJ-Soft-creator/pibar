// Web push commands (task J3, webapp only, no Tauri twin): the VAPID key for the browser, subscribing and
// unsubscribing a device, telling which chat a device has open (push_watch), and a test message. The service itself
// (../push.ts) is started by server.ts; without it (tests of other areas) the commands answer 404.
import { argOptBool, argOptString, argString, CommandError, type CommandContext, type CommandRegistry } from "../commands.js";
import { canUseHost } from "../helpers.js";
import { parseSubscription, pushService, type PushService } from "../push.js";

function service(): PushService {
  const s = pushService();
  if (!s) throw new CommandError(404, "Web push is not available on this server");
  return s;
}

/** Device id from the client (random, kept in its localStorage): tells devices of one user apart */
function device(args: Record<string, unknown>): string {
  const d = argString(args, "device");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(d)) throw new CommandError(400, "device is invalid");
  return d;
}

export function registerPushCommands(registry: CommandRegistry) {
  /** { publicKey, subscribed } – subscribed: whether `endpoint` (if given) belongs to this user */
  registry.register("push_info", {
    run: (ctx, args) => {
      const s = service();
      const endpoint = argOptString(args, "endpoint");
      return {
        publicKey: s.vapid.publicKey,
        subscribed: !!endpoint && s.subscriptionsOf(ctx.user.id).some((x) => x.endpoint === endpoint),
      };
    },
  });
  /** { subscription: PushSubscription.toJSON(), lang } */
  registry.register("push_subscribe", {
    run: (ctx, args) => {
      const sub = parseSubscription(args.subscription);
      if (typeof sub === "string") throw new CommandError(400, sub);
      service().subscribe(ctx.user, sub, argOptString(args, "lang", "en"));
      return null;
    },
  });
  registry.register("push_unsubscribe", {
    run: (ctx, args) => service().unsubscribe(ctx.user, argString(args, "endpoint")),
  });
  /** { device, hostId, sessionPath | null, cwd, visible } – the chat open on a device; hostId "" = no chat on screen */
  registry.register("push_watch", {
    run: (ctx: CommandContext, args) => {
      const s = service();
      const dev = device(args);
      const hostId = argOptString(args, "hostId");
      if (!hostId) {
        s.hide(ctx.user, dev);
        return null;
      }
      if (!canUseHost(ctx.user, hostId)) throw new CommandError(403, "No access to this host");
      const path = argOptString(args, "sessionPath") || null;
      const cwd = argOptString(args, "cwd").slice(0, 4096);
      s.watch(ctx.user, dev, hostId, path ? path.slice(0, 4096) : null, cwd, argOptBool(args, "visible", false));
      return null;
    },
  });
  /** Send a test message to the user's devices; returns how many got it */
  registry.register("push_test", {
    run: (ctx) => service().test(ctx.user),
  });
}
