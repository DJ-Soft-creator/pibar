// Tests for recognising the session-lock error and for the read-only history of a session file.
import { describe, expect, it } from "vitest";
import { branchMessages, parseSessionLock, sessionLockText } from "./sessionLock";
import { setLang } from "./i18n";

describe("parseSessionLock", () => {
  it("reads holder and time from the error of either app", () => {
    expect(parseSessionLock("session-locked:webapp:1700000000 This session is open in another PiBar webapp")).toEqual({
      holder: "webapp",
      since: 1700000000000,
    });
    expect(parseSessionLock(new Error("session-locked:desktop:0 x"))).toEqual({ holder: "desktop", since: 0 });
    expect(parseSessionLock("Pi process has ended")).toBeNull();
  });
  it("has a readable text", () => {
    setLang("de");
    expect(sessionLockText({ holder: "desktop", since: 0 })).toBe("Diese Session ist gerade in der Desktop-App offen.");
    setLang("en");
    expect(sessionLockText({ holder: "webapp", since: 0 })).toBe("This session is open in the webapp right now.");
  });
});

describe("branchMessages", () => {
  const line = (o: unknown) => JSON.stringify(o);
  it("follows the current branch back to the root and skips damaged lines", () => {
    const text = [
      line({ type: "session", id: "s" }),
      line({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "one" } }),
      line({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [] } }),
      line({ type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "old branch" } }),
      "{broken",
      line({ type: "model_change", id: "m", parentId: "a1" }),
      line({ type: "message", id: "u3", parentId: "m", message: { role: "user", content: "new branch" } }),
    ].join("\n");
    const msgs = branchMessages(text);
    expect(msgs.map((m) => (m.role === "user" ? m.content : m.role))).toEqual(["one", "assistant", "new branch"]);
  });
  it("empty file → no messages, a parent loop does not hang", () => {
    expect(branchMessages("")).toEqual([]);
    const loop = [
      line({ type: "message", id: "a", parentId: "b", message: { role: "user", content: "a" } }),
      line({ type: "message", id: "b", parentId: "a", message: { role: "user", content: "b" } }),
    ].join("\n");
    expect(branchMessages(loop)).toHaveLength(2);
  });
});
