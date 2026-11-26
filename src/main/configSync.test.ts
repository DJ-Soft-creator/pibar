// Tests for the auto-sync helpers (decision, listener registry, trailing-edge debounce with injected timers)
// and for the HostInfo address building of the webapp sync request.
import { describe, expect, it } from "vitest";
import {
  onBeforeConfigSave,
  onConfigSaved,
  notifyConfigSaved,
  prepareConfigSave,
  shouldAutoSync,
  trailingDebounce,
} from "./configSync";
import { hostInfo } from "../shared/metaSync";

/** Manual clock: set/clear collect jobs, advance(ms) runs the due ones */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set(fn: () => void, ms: number) {
        const id = next++;
        jobs.set(id, { at: now + ms, fn });
        return id;
      },
      clear(id: number) {
        jobs.delete(id);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const [id, job] of [...jobs]) {
        if (job.at <= now) {
          jobs.delete(id);
          job.fn();
        }
      }
    },
    pending: () => jobs.size,
  };
}

describe("shouldAutoSync", () => {
  it("needs the toggle on and a non-empty URL", () => {
    expect(shouldAutoSync(true, "http://host:8787")).toBe(true);
    expect(shouldAutoSync(false, "http://host:8787")).toBe(false);
    expect(shouldAutoSync(true, "")).toBe(false);
    expect(shouldAutoSync(true, "   ")).toBe(false);
    expect(shouldAutoSync(false, "")).toBe(false);
  });
});

describe("config-save listeners", () => {
  it("notifies every listener until it unsubscribes", () => {
    let a = 0;
    let b = 0;
    const offA = onConfigSaved(() => a++);
    const offB = onConfigSaved(() => b++);
    notifyConfigSaved();
    expect([a, b]).toEqual([1, 1]);
    offA();
    notifyConfigSaved();
    expect([a, b]).toEqual([1, 2]);
    offB();
  });
});

describe("before-save hooks", () => {
  it("run on prepareConfigSave until they unsubscribe", () => {
    let n = 0;
    const off = onBeforeConfigSave(() => n++);
    prepareConfigSave();
    off();
    prepareConfigSave();
    expect(n).toBe(1);
  });
});

describe("trailingDebounce", () => {
  it("fires once after the quiet period, not before", () => {
    const clock = fakeTimers();
    let runs = 0;
    const d = trailingDebounce(() => runs++, 2000, clock.timers);
    d.trigger();
    clock.advance(1999);
    expect(runs).toBe(0);
    clock.advance(1);
    expect(runs).toBe(1);
    expect(clock.pending()).toBe(0);
  });
  it("resets the timer on every trigger (trailing edge)", () => {
    const clock = fakeTimers();
    let runs = 0;
    const d = trailingDebounce(() => runs++, 2000, clock.timers);
    d.trigger();
    clock.advance(1500);
    d.trigger();
    clock.advance(1500);
    expect(runs).toBe(0); // 3000 ms since the first trigger, but only 1500 since the last
    clock.advance(500);
    expect(runs).toBe(1);
    clock.advance(5000);
    expect(runs).toBe(1); // no repeat
  });
  it("cancel drops a pending run; a later trigger works again", () => {
    const clock = fakeTimers();
    let runs = 0;
    const d = trailingDebounce(() => runs++, 2000, clock.timers);
    d.trigger();
    d.cancel();
    clock.advance(5000);
    expect(runs).toBe(0);
    expect(clock.pending()).toBe(0);
    d.trigger();
    clock.advance(2000);
    expect(runs).toBe(1);
  });
});

describe("hostInfo address", () => {
  const base = {
    id: "h1",
    name: "Server",
    kind: "ssh" as const,
    sshTarget: "host.example",
    sshUser: "",
    sshPort: null,
  };
  it("ssh with user and port", () => {
    expect(hostInfo({ ...base, sshUser: "user", sshPort: 2222 })).toEqual({
      id: "h1",
      name: "Server",
      kind: "ssh",
      address: "user@host.example:2222",
    });
  });
  it("ssh without user", () => {
    expect(hostInfo({ ...base, sshPort: 22 }).address).toBe("host.example:22");
  });
  it("ssh without port", () => {
    expect(hostInfo({ ...base, sshUser: "user" }).address).toBe("user@host.example");
  });
  it("ssh with neither user nor port", () => {
    expect(hostInfo(base).address).toBe("host.example");
  });
  it("local has an empty address even with ssh fields set", () => {
    expect(hostInfo({ ...base, kind: "local", sshUser: "user", sshPort: 22 })).toEqual({
      id: "h1",
      name: "Server",
      kind: "local",
      address: "",
    });
  });
});
