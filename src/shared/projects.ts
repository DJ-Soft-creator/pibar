// Which project a session belongs to: pure logic over the project list (AppConfig.projects). The cards are drawn in
// src/main/projects.ts, the chat view of a session follows its project (SessionTab.viewMode).

import type { Project } from "./api";
import { inFolder } from "./format";

/**
 * Project a session belongs to: same host and the working folder lies in the project's folder. With overlapping
 * projects the innermost (longest) folder wins.
 */
export function projectAt(list: Project[], hostId: string, cwd: string): Project | undefined {
  let best: Project | undefined;
  for (const p of list) {
    if (p.hostId !== hostId || !inFolder(cwd, p.dir)) continue;
    if (!best || p.dir.length > best.dir.length) best = p;
  }
  return best;
}
