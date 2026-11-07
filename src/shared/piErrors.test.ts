import { describe, expect, it } from "vitest";
import { isStaleInstallError } from "./piErrors";

describe("stale Pi install", () => {
  it("recognises a bundle chunk that vanished after an update", () => {
    const e =
      "Cannot find module '/home/user/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/openai-completions-27RKPL37.js' imported from /home/user/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-MM3LKT73.js";
    expect(isStaleInstallError(e)).toBe(true);
  });
  it("recognises a package that was removed on the host", () => {
    expect(
      isStaleInstallError("Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@earendil-works/pi-coding-agent'"),
    ).toBe(true);
    expect(isStaleInstallError("Cannot find module '@earendil-works/pi-ai'")).toBe(true);
  });
  it("leaves other missing modules alone", () => {
    expect(isStaleInstallError("Cannot find module 'left-pad'")).toBe(false);
    expect(isStaleInstallError("MCP server files: Cannot find module '/opt/mcp/server.js'")).toBe(false);
  });
  it("leaves connection errors alone", () => {
    expect(
      isStaleInstallError("TypeError: fetch failed | cause: ECONNREFUSED connect ECONNREFUSED 10.0.0.5:1234"),
    ).toBe(false);
    expect(isStaleInstallError("")).toBe(false);
  });
});
