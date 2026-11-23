// Tests for the session export: JSONL parsing, the lossless JSON document and the CSV table (src/shared/sessionExport.ts).
import { describe, expect, it } from "vitest";
import {
  CSV_COLUMNS,
  csvCell,
  parseSessionJsonl,
  sessionExportCsv,
  sessionExportJson,
  sessionHeader,
} from "./sessionExport";

const header = { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/w" };
const user = {
  type: "message",
  id: "u1",
  parentId: "h1",
  timestamp: "2026-01-01T00:00:01.000Z",
  message: { role: "user", content: [{ type: "text", text: "Hello, world" }] },
};
const assistant = {
  type: "message",
  id: "a1",
  parentId: "u1",
  timestamp: "2026-01-01T00:00:02.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "think" },
      { type: "text", text: 'say "hi"' },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
    ],
    provider: "p",
    model: "m",
    stopReason: "toolUse",
    usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, totalTokens: 18, cost: { total: 0.001 } },
  },
};
const toolResult = {
  type: "message",
  id: "r1",
  parentId: "a1",
  timestamp: "2026-01-01T00:00:03.000Z",
  message: {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "bash",
    content: [{ type: "text", text: "a\nb" }],
    isError: false,
  },
};
const modelChange = { type: "model_change", id: "m1", parentId: null, provider: "p", modelId: "m" };

describe("parseSessionJsonl", () => {
  it("parses every line and skips empty and damaged ones", () => {
    const text = [JSON.stringify(header), "", "  ", "{broken", "[1,2]", JSON.stringify(user)].join("\n");
    expect(parseSessionJsonl(text)).toEqual([header, user]);
  });
  it("finds the session header", () => {
    expect(sessionHeader([modelChange, header, user])).toEqual(header);
    expect(sessionHeader([user])).toBeNull();
  });
});

describe("sessionExportJson", () => {
  it("keeps every entry unchanged and names the source", () => {
    const entries = [header, modelChange, user, assistant];
    const doc = JSON.parse(sessionExportJson(entries, "/s/x.jsonl", new Date("2026-01-02T00:00:00Z")));
    expect(doc.format).toBe("pibar-session-export");
    expect(doc.source).toBe("/s/x.jsonl");
    expect(doc.exportedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(doc.session).toEqual(header);
    expect(doc.entryCount).toBe(4);
    expect(doc.entries).toEqual(entries);
  });
});

describe("csvCell", () => {
  it("quotes only when needed and doubles quotes", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell(5)).toBe("5");
    expect(csvCell(false)).toBe("false");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe("sessionExportCsv", () => {
  const csv = sessionExportCsv([header, modelChange, user, assistant, toolResult]);
  // parse the table back, RFC 4180: quoted cells may contain commas, quotes and newlines
  const rows: string[][] = [[]];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    const row = rows[rows.length - 1];
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cur);
      cur = "";
    } else if (c === "\n") {
      row.push(cur);
      cur = "";
      rows.push([]);
    } else cur += c;
  }
  rows.pop(); // the trailing newline started an empty row

  it("has the column names and one row per message, not per event", () => {
    expect(rows[0]).toEqual([...CSV_COLUMNS]);
    expect(rows).toHaveLength(4); // header + user + assistant + toolResult
    for (const r of rows) expect(r).toHaveLength(CSV_COLUMNS.length);
  });
  it("fills role, text, thinking, tool calls and usage", () => {
    const col = (r: string[], name: string) => r[CSV_COLUMNS.indexOf(name as (typeof CSV_COLUMNS)[number])];
    const [u, a, r] = rows.slice(1);
    expect(col(u, "role")).toBe("user");
    expect(col(u, "text")).toBe("Hello, world");
    expect(col(u, "entryId")).toBe("u1");
    expect(col(a, "text")).toBe('say "hi"');
    expect(col(a, "thinking")).toBe("think");
    expect(JSON.parse(col(a, "toolCalls"))).toEqual([{ id: "t1", name: "bash", arguments: { command: "ls" } }]);
    expect(col(a, "model")).toBe("m");
    expect(col(a, "inputTokens")).toBe("10");
    expect(col(a, "totalTokens")).toBe("18");
    expect(col(a, "costTotal")).toBe("0.001");
    expect(col(r, "role")).toBe("toolResult");
    expect(col(r, "toolName")).toBe("bash");
    expect(col(r, "isError")).toBe("false");
    expect(col(r, "text")).toBe("a\nb");
    expect(col(r, "inputTokens")).toBe("");
  });
  it("exports a compaction as a row with its summary", () => {
    const compaction = { type: "compaction", id: "c1", parentId: "a1", timestamp: "t", summary: "the story so far" };
    const out = sessionExportCsv([compaction]);
    expect(out).toContain("compaction");
    expect(out).toContain("the story so far");
  });
  it("writes only the column names for a session without messages", () => {
    expect(sessionExportCsv([header, modelChange])).toBe(CSV_COLUMNS.join(",") + "\n");
  });
});
