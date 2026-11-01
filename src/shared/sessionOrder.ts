// Order and sections of the session list: sort by last activity, creation, name or folder; sections by date
// ("Today", "Yesterday", "This week", …, then months) or by folder. Pure logic, tested in sessionOrder.test.ts.

export type SessionSort = "activity" | "created" | "name" | "folder";
export type SessionGroupBy = "none" | "date" | "folder";

export interface OrderRow {
  /** Display name */
  title: string;
  cwd: string;
  /** Creation (session header), ms; 0 = unknown */
  created: number;
  /** Last change of the file, ms; 0 = unknown */
  modified: number;
  /** Not saved yet (new session): always first */
  fresh?: boolean;
}

/** The time a row is shown and grouped by: last activity, or creation when sorted by it */
export function rowTime(r: OrderRow, sort: SessionSort): number {
  return sort === "created" ? r.created : r.modified || r.created;
}

export function sortRows<T extends OrderRow>(rows: T[], sort: SessionSort): T[] {
  const byTime = (a: T, b: T) => rowTime(b, sort) - rowTime(a, sort);
  const cmp: Record<SessionSort, (a: T, b: T) => number> = {
    activity: byTime,
    created: byTime,
    name: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }) || byTime(a, b),
    folder: (a, b) => a.cwd.localeCompare(b.cwd) || byTime(a, b),
  };
  return [...rows].sort((a, b) => Number(!!b.fresh) - Number(!!a.fresh) || cmp[sort](a, b));
}

/** Section key of a time: "today", "yesterday", "week", "month" or "YYYY-MM" for older ones */
export function dateBucket(ms: number, now: Date): string {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86_400_000;
  if (!ms || ms >= day) return "today";
  if (ms >= day - DAY) return "yesterday";
  if (ms >= day - 6 * DAY) return "week";
  if (ms >= day - 29 * DAY) return "month";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Rows in sections, in display order; key "" = no sections */
export function sectionRows<T extends OrderRow>(
  rows: T[],
  sort: SessionSort,
  by: SessionGroupBy,
  now = new Date(),
): { key: string; rows: T[] }[] {
  const sorted = sortRows(rows, sort);
  if (by === "none" || !sorted.length) return [{ key: "", rows: sorted }];
  const sections = new Map<string, T[]>();
  for (const r of sorted) {
    const key = by === "folder" ? r.cwd : dateBucket(rowTime(r, sort), now);
    sections.set(key, [...(sections.get(key) ?? []), r]);
  }
  const list = [...sections].map(([key, rows]) => ({ key, rows }));
  if (by === "folder") return list.sort((a, b) => a.key.localeCompare(b.key));
  // date sections newest first, even when sorted by name
  const rank = (k: string) => ({ today: 4, yesterday: 3, week: 2, month: 1 })[k] ?? 0;
  return list.sort((a, b) => rank(b.key) - rank(a.key) || b.key.localeCompare(a.key));
}
