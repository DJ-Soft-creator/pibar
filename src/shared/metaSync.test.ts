// Tests for the desktop side of the webapp sync: stamping by snapshot comparison, tombstones, the request, and
// applying the webapp's answer (newer wins, delete vs change).
import { describe, expect, it } from "vitest";
import {
  applyResponse,
  buildRequest,
  isSyncResponse,
  snapshot,
  stampChanges,
  TOMBSTONE_TTL_MS,
  type SyncConfig,
  type SyncResponse,
} from "./metaSync";

const cfg = (): SyncConfig => ({
  sessionMeta: { "h|/a.jsonl": { name: "A", color: "blue" } },
  groups: [{ id: "g1", name: "Work", color: "teal", collapsed: false }],
  projects: [{ id: "p1", name: "P", hostId: "h", dir: "~/p", collapsed: false }],
});

const answer = (over: Partial<SyncResponse> = {}): SyncResponse => ({
  sessionMeta: {},
  groups: [],
  projects: [],
  deleted: { sessions: [], groups: [], projects: [] },
  hosts: [],
  serverTime: 0,
  ...over,
});

describe("stampChanges", () => {
  it("first look: only unstamped entries get a stamp", () => {
    const c = cfg();
    c.groups[0]!.updatedAt = 50;
    const r = stampChanges(c, null, 1000);
    expect(r.changed).toBe(true);
    expect(c.sessionMeta["h|/a.jsonl"]!.updatedAt).toBe(1000);
    expect(c.groups[0]!.updatedAt).toBe(50);
    expect(stampChanges(c, r.snap, 2000).changed).toBe(false);
  });

  it("changed and new entries get now, untouched ones keep their stamp, key order does not count", () => {
    const c = cfg();
    const { snap } = stampChanges(c, null, 1000);
    c.sessionMeta["h|/a.jsonl"] = { color: "blue", name: "A", updatedAt: 1000 };
    expect(stampChanges(c, snap, 2000).changed).toBe(false);
    c.sessionMeta["h|/a.jsonl"]!.color = "red";
    c.sessionMeta["h|/b.jsonl"] = { pinned: true };
    stampChanges(c, snap, 3000);
    expect(c.sessionMeta["h|/a.jsonl"]!.updatedAt).toBe(3000);
    expect(c.sessionMeta["h|/b.jsonl"]!.updatedAt).toBe(3000);
    expect(c.groups[0]!.updatedAt).toBe(1000);
  });

  it("deletions become tombstones; re-creating an entry drops its tombstone; old tombstones expire", () => {
    const c = cfg();
    let { snap } = stampChanges(c, null, 1000);
    c.groups = [];
    delete c.sessionMeta["h|/a.jsonl"];
    ({ snap } = stampChanges(c, snap, 2000));
    expect(c.syncDeleted).toEqual({ sessions: { "h|/a.jsonl": 2000 }, groups: { g1: 2000 }, projects: {} });
    expect(buildRequest(c, []).deleted).toEqual({
      sessions: [{ key: "h|/a.jsonl", updatedAt: 2000 }],
      groups: [{ id: "g1", updatedAt: 2000 }],
      projects: [],
    });
    c.groups.push({ id: "g1", name: "Again", color: "", collapsed: false });
    ({ snap } = stampChanges(c, snap, 3000));
    expect(c.syncDeleted?.groups).toEqual({});
    expect(c.groups[0]!.updatedAt).toBe(3000);
    stampChanges(c, snap, 2000 + TOMBSTONE_TTL_MS + 1);
    expect(c.syncDeleted?.sessions).toEqual({});
  });
});

describe("applyResponse", () => {
  it("takes newer entries, keeps newer local ones, and the result is no local change", () => {
    const c = cfg();
    const { snap: first } = stampChanges(c, null, 1000);
    const r = applyResponse(
      c,
      answer({
        sessionMeta: {
          "h|/a.jsonl": { name: "A", color: "red", updatedAt: 2000 },
          "h|/new.jsonl": { name: "From the phone", updatedAt: 1500 },
        },
        groups: [{ id: "g1", name: "Older", color: "", collapsed: false, updatedAt: 500 }],
        projects: [{ id: "p2", name: "Q", hostId: "h", dir: "~/q", collapsed: false, updatedAt: 1500 }],
      }),
    );
    expect(r.updated).toBe(3);
    expect(c.sessionMeta["h|/a.jsonl"]!.color).toBe("red");
    expect(c.sessionMeta["h|/new.jsonl"]!.name).toBe("From the phone");
    expect(c.groups[0]!.name).toBe("Work");
    expect(c.projects?.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(stampChanges(c, r.snap, 5000).changed).toBe(false);
    expect(snapshot(c)).not.toEqual(first);
  });

  it("delete vs change: the later one wins on both sides", () => {
    const c = cfg();
    stampChanges(c, null, 1000);
    c.groups.push({ id: "g2", name: "Edited here later", color: "", collapsed: false, updatedAt: 3000 });
    const r = applyResponse(
      c,
      answer({
        deleted: {
          sessions: [{ key: "h|/a.jsonl", updatedAt: 2000 }],
          groups: [
            { id: "g1", updatedAt: 2000 },
            { id: "g2", updatedAt: 2000 },
          ],
          projects: [{ id: "p1", updatedAt: 500 }],
        },
      }),
    );
    expect(r.removed).toBe(2);
    expect(c.sessionMeta["h|/a.jsonl"]).toBeUndefined();
    expect(c.groups.map((g) => g.id)).toEqual(["g2"]);
    expect(c.projects?.map((p) => p.id)).toEqual(["p1"]);
    expect(c.syncDeleted?.groups.g1).toBe(2000);
    // an entry deleted here later is not brought back by an older copy from the webapp
    c.syncDeleted!.sessions["h|/gone.jsonl"] = 4000;
    applyResponse(c, answer({ sessionMeta: { "h|/gone.jsonl": { name: "x", updatedAt: 3500 } } }));
    expect(c.sessionMeta["h|/gone.jsonl"]).toBeUndefined();
  });

  it("checks the answer's shape", () => {
    expect(isSyncResponse(answer())).toBe(true);
    expect(isSyncResponse({ sessionMeta: {}, groups: [], projects: [] })).toBe(false);
    expect(isSyncResponse(null)).toBe(false);
  });
});
