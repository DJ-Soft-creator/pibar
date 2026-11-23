// Session export for machine evaluation: parse Pi's session file (JSONL) and build a lossless JSON document
// or a CSV table with one row per message. Pure logic, tested in sessionExport.test.ts.

/** One entry of Pi's session file, kept as it is so the JSON export stays lossless */
export type SessionEntry = Record<string, unknown>;

export type ExportFormat = "json" | "csv";

/** Parse the JSONL text of a session file; empty and damaged lines are skipped */
export function parseSessionJsonl(text: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o: unknown = JSON.parse(s);
      if (o && typeof o === "object" && !Array.isArray(o)) entries.push(o as SessionEntry);
    } catch {
      /* a damaged line does not stop the export */
    }
  }
  return entries;
}

/** The session header (the first line, type "session": id, timestamp, cwd) */
export function sessionHeader(entries: SessionEntry[]): SessionEntry | null {
  return entries.find((e) => e.type === "session") ?? null;
}

/** Lossless JSON: the header separately, then every entry of the file unchanged */
export function sessionExportJson(entries: SessionEntry[], source: string, now = new Date()): string {
  return JSON.stringify(
    {
      format: "pibar-session-export",
      version: 1,
      exportedAt: now.toISOString(),
      source,
      session: sessionHeader(entries),
      entryCount: entries.length,
      entries,
    },
    null,
    2,
  );
}

/** Columns of the CSV export, in order */
export const CSV_COLUMNS = [
  "entryId",
  "parentId",
  "timestamp",
  "role",
  "provider",
  "model",
  "stopReason",
  "text",
  "thinking",
  "toolCalls",
  "toolCallId",
  "toolName",
  "isError",
  "inputTokens",
  "outputTokens",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
  "costTotal",
] as const;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** One CSV cell: strings as they are, numbers and booleans spelled out, objects as JSON; RFC-4180 quoting */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Text of a message content: a plain string or the text parts joined with newlines */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(rec)
    .filter((p) => p.type === "text")
    .map((p) => str(p.text))
    .join("\n");
}

/** Thinking parts of an assistant message, joined with newlines */
function thinkingOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map(rec)
    .filter((p) => p.type === "thinking")
    .map((p) => str(p.thinking))
    .join("\n");
}

/** Tool calls of an assistant message as a JSON array of {id, name, arguments}; "" when there are none */
function toolCallsOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const calls = content
    .map(rec)
    .filter((p) => p.type === "toolCall")
    .map((p) => ({ id: str(p.id), name: str(p.name), arguments: p.arguments ?? null }));
  return calls.length ? JSON.stringify(calls) : "";
}

/** CSV row of one entry: messages of every role plus compactions (their summary as text); null for the rest */
function messageRow(e: SessionEntry): unknown[] | null {
  const base = [str(e.id), str(e.parentId), str(e.timestamp)];
  if (e.type === "compaction")
    return [...base, "compaction", "", "", "", str(e.summary), "", "", "", "", "", "", "", "", "", "", ""];
  if (e.type !== "message") return null;
  const m = rec(e.message);
  const u = rec(m.usage);
  const cost = rec(u.cost);
  return [
    ...base,
    str(m.role),
    str(m.provider),
    str(m.model),
    str(m.stopReason),
    textOf(m.content),
    thinkingOf(m.content),
    toolCallsOf(m.content),
    str(m.toolCallId),
    str(m.toolName),
    typeof m.isError === "boolean" ? m.isError : "",
    u.input ?? "",
    u.output ?? "",
    u.cacheRead ?? "",
    u.cacheWrite ?? "",
    u.totalTokens ?? "",
    cost.total ?? "",
  ];
}

/** CSV table: the column names, then one row per message (and per compaction), UTF-8, LF line ends */
export function sessionExportCsv(entries: SessionEntry[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const e of entries) {
    const row = messageRow(e);
    if (row) lines.push(row.map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
