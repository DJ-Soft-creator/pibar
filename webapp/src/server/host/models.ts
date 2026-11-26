// A host's model list without a running session (port of src-tauri/src/models.rs): run `pi --list-models` on the
// host and parse its table. Same command and parsing as the desktop; answer type ModelInfo of src/shared/api.ts.
import { piProgram, type HostExec, type HostTarget } from "./hostexec.js";

export interface ModelInfo {
  provider: string;
  id: string;
  thinking: boolean;
  images: boolean;
}

/** Table printed by `pi --list-models`: provider, model, context, max-out, thinking, images (models.rs: parse) */
export function parseModels(out: string): ModelInfo[] {
  const list: ModelInfo[] = [];
  for (const line of out.split("\n")) {
    const c = line.split(/\s+/).filter(Boolean);
    if (c.length < 6 || c[0] === "provider") continue;
    list.push({ provider: c[0] as string, id: c[1] as string, thinking: c[4] === "yes", images: c[5] === "yes" });
  }
  return list;
}

export async function listModels(exec: HostExec, host: HostTarget): Promise<ModelInfo[]> {
  return parseModels(await exec.runShell(host, `${piProgram(host)} --list-models`));
}
