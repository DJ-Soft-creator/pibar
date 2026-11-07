// Views of the session list (wired in src/main/sessions.ts): only the sessions you are working on, and/or only
// sessions of certain colours. Tested in listFilter.test.ts.

/** "all" = everything, "active" = what you are working on (Pi is running, an answer is unread, or the tab is open) */
export type SessionFilterMode = "all" | "active";

/** What a filter needs to know about a session row (see ListRow in src/main/sessions.ts) */
export interface FilterableRow {
  /** Pi works there – in the foreground or as a run in the background */
  running?: boolean;
  /** An answer nobody looked at yet */
  unread?: boolean;
  /** Open in a tab */
  open?: boolean;
  /** Colour chosen in the session menu (session meta); empty = none */
  color?: string;
}

/** Is a filter set (so the list shows less than everything)? */
export function filterSet(mode: SessionFilterMode, colors: string[]): boolean {
  return mode === "active" || colors.length > 0;
}

/**
 * Does a row belong to the view? "active" keeps what you are working on. The colours are ORed ("none" is a session
 * without a colour); a chosen colour and the mode both have to hold.
 */
export function passesFilter(row: FilterableRow, mode: SessionFilterMode, colors: string[]): boolean {
  if (mode === "active" && !row.running && !row.unread && !row.open) return false;
  if (!colors.length) return true;
  return colors.includes(row.color || "none");
}
