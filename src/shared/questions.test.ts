import { describe, expect, it } from "vitest";
import { cleanOption, composeAnswer, findQuestions } from "./questions";

describe("findQuestions", () => {
  it("finds a question followed by options", () => {
    const text =
      "Ich sehe zwei Wege.\n\nWelche Variante möchtest du?\n\n1. **Variante A** – schnell\n2. Variante B – sauber\n";
    expect(findQuestions(text)).toEqual([
      { question: "Welche Variante möchtest du?", options: ["Variante A – schnell", "Variante B – sauber"] },
    ]);
  });

  it("finds several questions with indented options", () => {
    const text = [
      "Bevor ich loslege:",
      "",
      "1. **Welche Datenbank?**",
      "   - Postgres",
      "   - SQLite",
      "2. Wo soll es laufen?",
      "   - Docker",
      "   - direkt auf dem Host",
      "",
      "Sag Bescheid.",
    ].join("\n");
    expect(findQuestions(text)).toEqual([
      { question: "Welche Datenbank?", options: ["Postgres", "SQLite"] },
      { question: "Wo soll es laufen?", options: ["Docker", "direkt auf dem Host"] },
    ]);
  });

  it("finds a list followed by a choice question", () => {
    const text = "Mögliche Schritte:\n\n- Tests ergänzen\n- Refactoring\n- Doku\n\nWelche davon soll ich umsetzen?";
    expect(findQuestions(text)).toEqual([
      { question: "Welche davon soll ich umsetzen?", options: ["Tests ergänzen", "Refactoring", "Doku"] },
    ]);
  });

  it("ignores a summary list followed by a yes/no question", () => {
    expect(findQuestions("Geändert:\n\n- a.ts\n- b.ts\n\nSoll ich committen?")).toEqual([]);
  });

  it("ignores lists in the middle of an explanation", () => {
    const text =
      "Was macht das Skript?\n- liest X\n- schreibt Y\n\nDann folgt ein langer Teil.\n\n- noch\n- eine Liste\n\nEnde.";
    expect(findQuestions(text)).toEqual([]);
  });

  it("ignores code blocks and answers without question", () => {
    expect(findQuestions("```\n- a?\n- b\n- c\n```")).toEqual([]);
    expect(findQuestions("Fertig:\n- a\n- b")).toEqual([]);
  });
});

describe("composeAnswer", () => {
  const groups = [
    { question: "Welche Datenbank?", options: ["Postgres", "SQLite"] },
    { question: "Wo?", options: ["Docker", "Host"] },
  ];
  it("lists checked options and own text per question", () => {
    expect(
      composeAnswer(
        groups,
        [
          { checked: ["Postgres", "SQLite"], own: "" },
          { checked: [], own: "auf dem Mac mini" },
        ],
        "Danke!",
      ),
    ).toBe("> Welche Datenbank?\n- Postgres\n- SQLite\n\n> Wo?\nauf dem Mac mini\n\nDanke!");
  });
  it("is empty without a choice", () => {
    expect(
      composeAnswer(groups, [
        { checked: [], own: " " },
        { checked: [], own: "" },
      ]),
    ).toBe("");
  });
});

it("cleans markdown from options", () => {
  expect(cleanOption("**A** – `x` und [Link](http://a)")).toBe("A – x und Link");
});
