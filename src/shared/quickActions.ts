// Quick action buttons under the input (src/main/quickActions.ts): pure cleaning of the saved list –
// trimmed names and texts, empty rows dropped, a valid kind and an id for every button.
import type { QuickAction } from "./api";

/** Clean the list from the settings: keep only rows with a name and a text, normalise kind and id */
export function cleanQuickActions(list: QuickAction[] | null | undefined): QuickAction[] {
  const out: QuickAction[] = [];
  for (const a of Array.isArray(list) ? list : []) {
    const name = (a?.name ?? "").trim();
    const text = (a?.text ?? "").trim();
    if (!name || !text) continue;
    out.push({
      id: (a.id ?? "").trim() || `qa${out.length + 1}`,
      name,
      kind: a.kind === "shell" ? "shell" : "command",
      text,
    });
  }
  return out;
}
