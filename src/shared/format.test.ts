import { afterEach, describe, expect, it } from "vitest";
import {
  baseName,
  cleanTitle,
  fmtTokens,
  relTime,
  shortModel,
  shortPath,
  splitScreenText,
  stripAnswerStyle,
  thinkingLabel,
  tokensPerSecond,
  withAnswerStyle,
  withScreenText,
} from "./format";
import { setLang } from "./i18n";

afterEach(() => setLang("en"));

describe("shortModel", () => {
  it.each([
    ["anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5"],
    ["us.anthropic.claude-opus-4-6-v1", "claude-opus-4-6"],
    ["amazon.nova-pro-v1:0", "nova-pro"],
    ["claude-sonnet-4-5", "claude-sonnet-4-5"],
    ["gpt-4.1", "gpt-4.1"],
    ["gemini-2.5-pro", "gemini-2.5-pro"],
  ])("%s → %s", (id: string, short: string) => expect(shortModel(id)).toBe(short));
});

describe("screen text (OCR)", () => {
  it("removes the OCR block from titles", () => {
    expect(cleanTitle('Summarise <screen-text source="x">lots of text')).toBe("Summarise");
  });
  it("still understands the older German tag", () => {
    expect(cleanTitle("Frage <bildschirmtext quelle='x'>…")).toBe("Frage");
    expect(splitScreenText("Q\n<bildschirmtext>abc</bildschirmtext>")).toEqual({ text: "Q", ocr: "abc" });
  });
  it("leaves normal titles alone", () => expect(cleanTitle("Hello")).toBe("Hello"));
  it("withScreenText and splitScreenText are inverse", () => {
    const msg = withScreenText("Question", "line 1\nline 2");
    expect(splitScreenText(msg)).toEqual({ text: "Question", ocr: "line 1\nline 2" });
  });
  it("without OCR the message stays the same", () => {
    expect(withScreenText("Question", null)).toBe("Question");
    expect(splitScreenText("Question")).toEqual({ text: "Question", ocr: null });
  });
});

describe("paths and numbers", () => {
  it("shortPath", () => {
    expect(shortPath("/Users/anna/project")).toBe("~/project");
    expect(shortPath("/home/bob")).toBe("~");
    expect(shortPath("/root/x")).toBe("~/x");
    expect(shortPath("/opt/x")).toBe("/opt/x");
  });
  it("baseName", () => {
    expect(baseName("/a/b/c.md")).toBe("c.md");
    expect(baseName("/a/b/")).toBe("b");
  });
  it("fmtTokens in English and German", () => {
    expect(fmtTokens(812)).toBe("812 tok.");
    expect(fmtTokens(2300)).toBe("2.3k tok.");
    setLang("de");
    expect(fmtTokens(812)).toBe("812 Tok.");
  });
  it("thinkingLabel", () => {
    expect(thinkingLabel("xhigh")).toBe("very high");
    setLang("de");
    expect(thinkingLabel("medium")).toBe("mittel");
    expect(thinkingLabel("unknown")).toBe("unknown");
  });
  it("relTime", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    expect(relTime("2026-10-31T11:59:30Z", now)).toBe("just now");
    expect(relTime("2026-10-31T11:50:00Z", now)).toBe("10 min ago");
    setLang("de");
    expect(relTime("2026-10-31T09:00:00Z", now)).toBe("vor 3 Std.");
    expect(relTime("broken", now)).toBe("");
  });
});

describe("answer style", () => {
  it("adds a hint for short answers and strips it again", () => {
    const msg = withAnswerStyle("Why?", "short");
    expect(msg).toContain("<response-style>");
    expect(stripAnswerStyle(msg)).toBe("Why?");
  });
  it("leaves normal mode and slash commands alone", () => {
    expect(withAnswerStyle("Why?", "normal")).toBe("Why?");
    expect(withAnswerStyle("/skill:deploy now", "short")).toBe("/skill:deploy now");
  });
  it("removes the hint from titles, also when cut off", () => {
    expect(cleanTitle(withAnswerStyle("Fix the bug", "technical"))).toBe("Fix the bug");
    expect(cleanTitle("Fix the bug <respon")).toBe("Fix the bug");
  });
  it("computes tokens per second", () => {
    expect(tokensPerSecond(100, 2000)).toBe(50);
    expect(tokensPerSecond(0, 2000)).toBeNull();
  });
});
