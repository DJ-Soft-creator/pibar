// Line diff for the diff view of the editor: longest common subsequence, grouped into hunks with context.

export interface DiffLine {
  op: " " | "+" | "-";
  text: string;
  /** Line number in the old text (0 for added lines) */
  a: number;
  /** Line number in the new text (0 for removed lines) */
  b: number;
}

/** A gap of unchanged lines between two hunks */
export interface DiffGap {
  skipped: number;
}

/** Above this many cells (old × new changed lines) the middle is shown as "removed, then added" */
const MAX_CELLS = 4_000_000;

function lines(s: string): string[] {
  if (s === "") return [];
  const l = s.split("\n");
  if (l[l.length - 1] === "") l.pop();
  return l;
}

/** All lines of old and new, marked as equal, removed or added */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const A = lines(oldText);
  const B = lines(newText);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a = A.slice(pre, A.length - suf);
  const b = B.slice(pre, B.length - suf);
  const out: DiffLine[] = [];
  for (let i = 0; i < pre; i++) out.push({ op: " ", text: A[i], a: i + 1, b: i + 1 });

  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) {
    a.forEach((t, i) => out.push({ op: "-", text: t, a: pre + i + 1, b: 0 }));
    b.forEach((t, j) => out.push({ op: "+", text: t, a: 0, b: pre + j + 1 }));
  } else {
    // lcs[i][j] = length of the common subsequence of a[i..] and b[j..]
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i * w + j] =
          a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        out.push({ op: " ", text: a[i], a: pre + i + 1, b: pre + j + 1 });
        i++;
        j++;
      } else if (i < n && (j >= m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        out.push({ op: "-", text: a[i], a: pre + i + 1, b: 0 });
        i++;
      } else {
        out.push({ op: "+", text: b[j], a: 0, b: pre + j + 1 });
        j++;
      }
    }
    // removed before added inside each changed block reads better
    for (let k = 0; k < out.length; k++) {
      if (out[k].op === " ") continue;
      let e = k;
      while (e < out.length && out[e].op !== " ") e++;
      const block = out.slice(k, e);
      out.splice(k, e - k, ...block.filter((x) => x.op === "-"), ...block.filter((x) => x.op === "+"));
      k = e;
    }
  }
  for (let k = 0; k < suf; k++) {
    const ai = A.length - suf + k;
    const bi = B.length - suf + k;
    out.push({ op: " ", text: A[ai], a: ai + 1, b: bi + 1 });
  }
  return out;
}

/** Only changed lines with `context` lines around them; longer unchanged stretches become a gap */
export function hunks(diff: DiffLine[], context = 3): (DiffLine | DiffGap)[] {
  const keep = new Array<boolean>(diff.length).fill(false);
  diff.forEach((d, i) => {
    if (d.op === " ") return;
    for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++) keep[k] = true;
  });
  // a gap of one or two lines is not worth collapsing
  for (let i = 0; i < keep.length;) {
    if (keep[i]) {
      i++;
      continue;
    }
    let e = i;
    while (e < keep.length && !keep[e]) e++;
    if (e - i < 3 && i > 0 && e < keep.length) keep.fill(true, i, e);
    i = e;
  }
  const out: (DiffLine | DiffGap)[] = [];
  let skipped = 0;
  diff.forEach((d, i) => {
    if (keep[i]) {
      if (skipped) out.push({ skipped });
      skipped = 0;
      out.push(d);
    } else skipped++;
  });
  if (skipped) out.push({ skipped });
  return out;
}

/** Number of added and removed lines */
export function diffStats(diff: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const d of diff) {
    if (d.op === "+") added++;
    else if (d.op === "-") removed++;
  }
  return { added, removed };
}
