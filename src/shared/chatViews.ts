// The three chat views (natural, technical, debug) with their labels and descriptions: the header dropdown and the
// settings offer them, and a project can fix one as the default view of its sessions (Project.view). Pure data.

import type { ChatMode } from "./api";
import type { Msg } from "./i18n";

/** The views in menu order: value, label, description */
export const VIEWS: [ChatMode, Msg, Msg][] = [
  ["natural", "Natural", "Only Pi's answers, no thinking or tool blocks"],
  ["technical", "Technical", "Thinking and tool calls as small collapsed blocks"],
  ["debug", "Debug", "Thinking and tool calls open and live"],
];

/** Is this one of the three views? A saved value may be empty or from an older version */
export function isChatMode(v: unknown): v is ChatMode {
  return v === "natural" || v === "technical" || v === "debug";
}
