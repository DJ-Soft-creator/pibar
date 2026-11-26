// Markdown export of a session (task H5) for reading and sharing: header with id, folder and times, then every
// message – own messages, Pi's answers (thinking as a quote, tool calls as code), tool results shortened.
// Pure logic without imports (the entries come from parseSessionJsonl of src/shared/sessionExport.ts), tested in
// webapp/test/sessionsMarkdown.test.ts.

export interface MarkdownLabels {
  you: string;
  pi: string;
  tool: string;
  thinking: string;
  session: string;
  folder: string;
  created: string;
  exported: string;
  compaction: string;
  /** "… (shortened)" after a cut tool result */
  shortened: string;
}

/** Characters of a tool result kept in the export (a result can be megabytes) */
export const RESULT_CHARS = 2000;

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A code fence longer than any run of backticks inside the text */
export function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${text.replace(/\n+$/, "")}\n${f}`;
}

function textParts(content: unknown, type: "text" | "thinking"): string {
  if (typeof content === "string") return type === "text" ? content : "";
  if (!Array.isArray(content)) return "";
  return content
    .map(rec)
    .filter((p) => p.type === type)
    .map((p) => str(type === "text" ? p.text : p.thinking))
    .filter(Boolean)
    .join("\n\n");
}

function when(ts: unknown): string {
  const ms = typeof ts === "number" ? ts : Date.parse(str(ts));
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "";
}

const quote = (text: string) =>
  text
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");

/** The whole session as Markdown */
export function sessionMarkdown(entries: Rec[], title: string, labels: MarkdownLabels, now = new Date()): string {
  const header = entries.find((e) => e.type === "session") ?? {};
  const out: string[] = [`# ${title.replace(/\s+/g, " ").trim() || labels.session}`, ""];
  const facts: [string, string][] = [
    [labels.session, str(header.id)],
    [labels.folder, str(header.cwd)],
    [labels.created, when(header.timestamp)],
    [labels.exported, when(now.getTime())],
  ];
  for (const [k, v] of facts) if (v) out.push(`- **${k}:** ${v}`);
  for (const e of entries) {
    if (e.type === "compaction") {
      out.push("", `## ${labels.compaction}`, "", str(e.summary));
      continue;
    }
    if (e.type !== "message") continue;
    const m = rec(e.message);
    const role = str(m.role);
    const time = when(e.timestamp ?? m.timestamp);
    if (role === "user") {
      out.push("", `## ${labels.you}${time ? ` · ${time}` : ""}`, "", textParts(m.content, "text"));
    } else if (role === "assistant") {
      const model = str(m.model);
      out.push("", `## ${labels.pi}${time ? ` · ${time}` : ""}${model ? ` · ${model}` : ""}`);
      const thinking = textParts(m.content, "thinking");
      if (thinking) out.push("", `**${labels.thinking}**`, "", quote(thinking));
      const text = textParts(m.content, "text");
      if (text) out.push("", text);
      for (const p of Array.isArray(m.content) ? m.content.map(rec) : []) {
        if (p.type !== "toolCall") continue;
        out.push("", `**${labels.tool}: \`${str(p.name) || "?"}\`**`, "", fence(JSON.stringify(p.arguments ?? {}, null, 2), "json"));
      }
    } else {
      // tool results and other roles: shortened, as code
      let text = textParts(m.content, "text");
      const cut = text.length > RESULT_CHARS;
      if (cut) text = text.slice(0, RESULT_CHARS);
      const name = str(m.toolName);
      out.push("", `### ${labels.tool}${name ? ` · ${name}` : ""}${m.isError === true ? " ⚠" : ""}`, "", fence(text));
      if (cut) out.push("", `_${labels.shortened}_`);
    }
  }
  return out.join("\n").trimEnd() + "\n";
}
