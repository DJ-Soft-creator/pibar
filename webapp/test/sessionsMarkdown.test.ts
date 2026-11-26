// Markdown export of a session (client/src/views/sessionsMarkdown.ts, task H5): header facts, own messages, answers
// with thinking and tool calls, shortened tool results, fences that survive backticks in the text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fence, RESULT_CHARS, sessionMarkdown, type MarkdownLabels } from "../client/src/views/sessionsMarkdown.js";

const labels: MarkdownLabels = {
  you: "You",
  pi: "Pi",
  tool: "Tool",
  thinking: "Thinking",
  session: "Session",
  folder: "Folder",
  created: "Created",
  exported: "Exported",
  compaction: "Summary",
  shortened: "(shortened)",
};

test("sessionMarkdown: header, messages, thinking, tool calls and results", () => {
  const entries = [
    { type: "session", id: "s1", cwd: "/home/user/work", timestamp: "2026-11-01T10:00:00Z" },
    { type: "message", id: "u1", timestamp: "2026-11-01T10:01:00Z", message: { role: "user", content: [{ type: "text", text: "Fix the bug" }] } },
    {
      type: "message",
      id: "a1",
      message: {
        role: "assistant",
        model: "model-x",
        content: [
          { type: "thinking", thinking: "Look at a.ts\nthen b.ts" },
          { type: "text", text: "Done." },
          { type: "toolCall", id: "c1", name: "edit", arguments: { path: "a.ts" } },
        ],
      },
    },
    { type: "message", id: "t1", message: { role: "toolResult", toolName: "edit", content: [{ type: "text", text: "x".repeat(RESULT_CHARS + 5) }] } },
    { type: "compaction", summary: "Earlier we talked." },
    { type: "session_info", name: "ignored" },
  ];
  const md = sessionMarkdown(entries, "  Bug   fix ", labels, new Date("2026-11-02T00:00:00Z"));
  assert.ok(md.startsWith("# Bug fix\n"));
  assert.match(md, /- \*\*Session:\*\* s1/);
  assert.match(md, /- \*\*Folder:\*\* \/home\/user\/work/);
  assert.match(md, /- \*\*Created:\*\* 2026-11-01 10:00/);
  assert.match(md, /- \*\*Exported:\*\* 2026-11-02 00:00/);
  assert.match(md, /## You · 2026-11-01 10:01\n\nFix the bug/);
  assert.match(md, /## Pi · model-x/);
  assert.match(md, /> Look at a\.ts\n> then b\.ts/);
  assert.match(md, /\*\*Tool: `edit`\*\*\n\n```json\n\{\n {2}"path": "a\.ts"\n\}\n```/);
  assert.match(md, /### Tool · edit/);
  assert.match(md, /_\(shortened\)_/);
  assert.ok(!md.includes("x".repeat(RESULT_CHARS + 1)));
  assert.match(md, /## Summary\n\nEarlier we talked\./);
  assert.ok(!md.includes("ignored"));
  assert.ok(md.endsWith("\n") && !md.endsWith("\n\n"));
});

test("fence: longer than any backtick run inside", () => {
  assert.equal(fence("a"), "```\na\n```");
  assert.equal(fence("use ```js``` here", "md"), "````md\nuse ```js``` here\n````");
});

test("sessionMarkdown: without a header the title falls back", () => {
  const md = sessionMarkdown([], "", labels);
  assert.ok(md.startsWith("# Session\n"));
  assert.match(md, /Exported/);
});
