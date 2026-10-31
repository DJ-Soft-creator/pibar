/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import indexHtml from "../../index.html?raw";
import quickHtml from "../../quick.html?raw";
import { _dicts, resolveLang, setLang, t } from "./i18n";

describe("i18n", () => {
  it("every German text keeps the placeholders of its English key", () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [en, de] of Object.entries(_dicts.de)) expect(names(de), en).toEqual(names(en));
  });
  it("translates and fills placeholders", () => {
    setLang("de");
    expect(t("New session on {host}", { host: "agent" })).toBe("Neue Session auf agent");
    setLang("en");
    expect(t("New session on {host}", { host: "agent" })).toBe("New session on agent");
  });
  it("explicit language wins over the system language", () => {
    expect(resolveLang("de")).toBe("de");
    expect(resolveLang("en")).toBe("en");
  });
});

describe("static HTML", () => {
  it.each([
    ["index.html", indexHtml],
    ["quick.html", quickHtml],
  ])("%s only uses known keys", (_file, html) => {
    const keys = [...html.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]*)"/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(5);
    for (const k of keys) expect(Object.keys(_dicts.de), k).toContain(k);
  });
});
