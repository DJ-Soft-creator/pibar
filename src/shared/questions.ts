// Questions with answer options at the end of an answer ("Which variant? 1. … 2. …"): found here, answered in a
// dialog with check boxes and an own answer (src/main/answerDialog.ts). Pure logic, tested in questions.test.ts.

export interface QuestionGroup {
  question: string;
  options: string[];
}

const ITEM = /^(\s*)(?:[-*•+]|\d{1,2}[.)]|[a-zA-Z][.)]|\([a-zA-Z0-9]{1,2}\))\s+(.+)$/;
/** Words that make a question after a list a choice ("Which of these …?"), not a yes/no question about the list */
const CHOICE =
  /\b(welche[rsnm]?|was davon|wähl|auswahl|option|variante|bevorzug|lieber|oder|which|choose|pick|prefer|option|variant|or)\b/i;
const MAX_OPTIONS = 12;

/** Markdown markers off, whitespace collapsed: "**Variante A** – schnell" → "Variante A – schnell" */
export function cleanOption(s: string): string {
  return s
    .replace(/\*\*|__|`/g, "")
    .replace(/^\*(.+)\*$/, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const isQuestion = (s: string) => /\?\s*[*_:)]*\s*$/.test(s.trim());

/**
 * Question groups at the end of a text: a question followed by at least two list items, or a list followed by a
 * choice question ("Which of these should I do?"). Only near the end: after the last group there may be one short
 * paragraph at most, so lists in the middle of an explanation do not count.
 */
export function findQuestions(text: string): QuestionGroup[] {
  // code blocks never contain the options
  const lines = text.replace(/```[\s\S]*?```/g, "\n").split("\n");
  const groups: { question: string; options: string[]; end: number; indent: number }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let blank = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      blank++;
      continue;
    }
    const item = ITEM.exec(line);
    const body = item ? item[2] : line;
    if (isQuestion(body)) {
      // a question (also as list item: "1. Which database?" with the options indented below) opens a new group
      cur = {
        question: cleanOption(body.replace(/^#+\s*/, "")),
        options: [],
        end: i,
        indent: item ? item[1].length : -1,
      };
      groups.push(cur);
    } else if (item && cur && blank <= 1 && item[1].length > cur.indent) {
      if (cur.options.length < MAX_OPTIONS) cur.options.push(cleanOption(item[2]));
      cur.end = i;
    } else {
      cur = null;
    }
    blank = 0;
  }
  let found = groups.filter((g) => g.options.length >= 2);
  // list first, choice question after it
  if (!found.length) {
    const g = listThenQuestion(lines);
    if (g) return [g];
    return [];
  }
  // only at the end: at most one short paragraph after the last group
  const last = found[found.length - 1];
  const rest = lines.slice(last.end + 1).filter((l) => l.trim());
  if (rest.length > 2 || rest.some((l) => ITEM.test(l))) return [];
  // the groups must follow one another (no long text between them)
  found = found.filter((g, i) => i === found.length - 1 || found[i + 1].end - g.end < 40);
  return found.map(({ question, options }) => ({ question, options }));
}

function listThenQuestion(lines: string[]): QuestionGroup | null {
  const idx = lines.map((l, i) => [l, i] as const).filter(([l]) => l.trim());
  if (idx.length < 3) return null;
  const [qLine] = idx[idx.length - 1];
  if (ITEM.test(qLine) || !isQuestion(qLine) || !CHOICE.test(qLine)) return null;
  const options: string[] = [];
  for (let j = idx.length - 2; j >= 0; j--) {
    const m = ITEM.exec(idx[j][0]);
    if (!m) break;
    options.unshift(cleanOption(m[2]));
  }
  if (options.length < 2 || options.length > MAX_OPTIONS) return null;
  return { question: cleanOption(qLine), options };
}

/** One answer: the checked options and an own text per question, plus a note for all */
export interface QuestionAnswer {
  checked: string[];
  own: string;
}

/** Message to Pi from the dialog; empty when nothing was chosen or written */
export function composeAnswer(groups: QuestionGroup[], answers: QuestionAnswer[], note = ""): string {
  const parts: string[] = [];
  groups.forEach((g, i) => {
    const a = answers[i];
    if (!a || (!a.checked.length && !a.own.trim())) return;
    const lines = [`> ${g.question}`, ...a.checked.map((c) => `- ${c}`)];
    if (a.own.trim()) lines.push(a.own.trim());
    parts.push(lines.join("\n"));
  });
  if (note.trim()) parts.push(note.trim());
  return parts.join("\n\n");
}
