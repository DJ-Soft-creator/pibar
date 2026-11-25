// Fake host for tests: a temporary $HOME with Pi's folders, reached through LocalRunner (bash on this machine)
// instead of SSH, and dev/fake-pi.mjs as Pi. Every server module that talks to a host is tested against it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { HostExec, LocalRunner, type HostTarget } from "../src/server/host/hostexec.js";

const here = dirname(fileURLToPath(import.meta.url));
/** dev/fake-pi.mjs of the repository (speaks Pi's RPC protocol without an API key) */
export const FAKE_PI = resolve(here, "../../dev/fake-pi.mjs");

export interface FakeHost {
  /** The fake $HOME */
  home: string;
  host: HostTarget;
  exec: HostExec;
  /** ~/.pi/agent/sessions of the fake home */
  sessionsDir: string;
  /** Write a session file below sessions/<folder>/<name> (lines are JSON-encoded); returns its path */
  writeSession(folder: string, name: string, entries: unknown[]): string;
}

export function fakeHost(t: TestContext, overrides: Partial<HostTarget> = {}): FakeHost {
  const home = mkdtempSync(join(tmpdir(), "pibar-fakehost-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sessionsDir = join(home, ".pi", "agent", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const host: HostTarget = {
    id: "fake",
    name: "Fake",
    sshTarget: "fake.invalid",
    sshUser: "",
    sshPort: null,
    piCommand: `node ${FAKE_PI}`,
    ...overrides,
  };
  return {
    home,
    host,
    exec: new HostExec(new LocalRunner(home)),
    sessionsDir,
    writeSession(folder, name, entries) {
      const dir = join(sessionsDir, folder);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, name);
      writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
      return file;
    },
  };
}
