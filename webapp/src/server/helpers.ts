// Auth middleware: Bearer token -> user; admin gate; host access rule of the command router.
import type { NextFunction, Request, Response } from "express";
import type { Store, UserRecord } from "./store.js";

export function createStoreUserHelpers(store: Store) {
  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers.authorization;
    const match = /^Bearer (.+)$/.exec(header ?? "");
    const token = match?.[1];
    const user = token === undefined ? undefined : store.userForToken(token);
    if (!user || token === undefined) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.authUser = user;
    req.authToken = token;
    next();
  }

  function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    if (req.authUser?.role !== "admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  }

  return { requireAuth, requireAdmin };
}

/** Whether a user may work on a host: admins on every host, users on their assigned one (task A5: a list) */
export function canUseHost(user: UserRecord, hostId: string): boolean {
  return user.role === "admin" || user.host === hostId;
}
