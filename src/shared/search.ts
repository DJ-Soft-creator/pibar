// The search in the left column (wired in src/main/search.ts): what the query is, which row matches it and how a
// snippet is split for highlighting. Tested in search.test.ts.

/** Shorter queries do not go to the hosts: one letter matches everything, and every keystroke would cost a round trip */
export const MIN_QUERY = 2;

/** The query as it is used: single spaces, trimmed, at most 100 characters */
export function cleanQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 100);
}

/** Is a query long enough to search (and to filter the list)? */
export function isSearching(raw: string): boolean {
  return cleanQuery(raw).length >= MIN_QUERY;
}

/** Does a session row match the query? `parts` are the texts of the row: name, first message, folder … */
export function matchesQuery(parts: (string | null | undefined)[], query: string): boolean {
  const q = cleanQuery(query).toLowerCase();
  if (!q) return true;
  return parts.some((p) => (p ?? "").toLowerCase().includes(q));
}

/** A snippet split at the first match: [before, match, after]; null if it does not contain the query */
export function highlight(snippet: string, query: string): [string, string, string] | null {
  const q = cleanQuery(query).toLowerCase();
  if (!q) return null;
  const at = snippet.toLowerCase().indexOf(q);
  if (at < 0) return null;
  return [snippet.slice(0, at), snippet.slice(at, at + q.length), snippet.slice(at + q.length)];
}

/** Label of the message a hit comes from: "You", "Pi" or "Tool" */
export function roleLabel(role: string): "You" | "Pi" | "Tool" {
  if (role === "user") return "You";
  if (role === "assistant") return "Pi";
  return "Tool";
}
