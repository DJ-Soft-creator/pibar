// Start a new session (task E5): pick host folder (list_dirs) or take a project's folder, then open the chat.
// Used by the session list ("+", projects) and the chat. Placeholder of the rebuild: opens the chat in the given
// folder right away; the folder picker comes with E5.
import { openChat } from "../state";

export interface NewSessionOptions {
  hostId: string;
  hostName: string;
  /** Folder to start in; without it the user picks one (default: the host's default folder) */
  cwd?: string;
  /** Project the session belongs to (its folder is used) */
  projectId?: string;
}

export function startNewSession(o: NewSessionOptions) {
  openChat({ hostId: o.hostId, hostName: o.hostName, path: null, cwd: o.cwd || "~", title: "" });
}
