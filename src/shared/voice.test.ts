import { describe, expect, it } from "vitest";
import { speakableText } from "./voice";

describe("speakableText", () => {
  it("drops code blocks and Markdown symbols", () => {
    expect(speakableText("# Title\n\nUse `npm i` and **bold**.\n\n```sh\nrm -rf x\n```\n- item")).toBe(
      "Title Use npm i and bold. item",
    );
  });
  it("keeps link text", () => expect(speakableText("See [docs](https://x.y)")).toBe("See docs"));
});
