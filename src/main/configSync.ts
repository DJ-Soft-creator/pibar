// Config-save hooks and the pure auto-sync helpers (decision + trailing-edge debounce with injectable timers).
// state.ts calls prepareConfigSave() before and notifyConfigSaved() after every save; configExchange.ts registers
// its updatedAt stamping and the debounced webapp sync here — this module imports nothing, so there is no circular
// import between state.ts and configExchange.ts.

type Listener = () => void;
const listeners = new Set<Listener>();
const preparers = new Set<Listener>();

/** Register a hook that runs right before every config save (the sync stamps changed entries there) */
export function onBeforeConfigSave(cb: Listener): () => void {
  preparers.add(cb);
  return () => preparers.delete(cb);
}

/** Called by saveConfig() in state.ts before the config goes to the Rust core */
export function prepareConfigSave() {
  for (const cb of preparers) cb();
}

/** Register a listener for config saves; returns a function that removes it again */
export function onConfigSaved(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Called by saveConfig() in state.ts after every successful config save */
export function notifyConfigSaved() {
  for (const cb of listeners) cb();
}

/** Whether a silent auto-sync may run at all: toggle on and a webapp URL set */
export function shouldAutoSync(enabled: boolean, url: string): boolean {
  return enabled && url.trim() !== "";
}

/** Timer functions of a debounce; injectable for tests (defaults to the window timers) */
export interface DebounceTimers {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

/**
 * Trailing-edge debounce: every trigger() resets the timer, fn runs once after `ms` without a new trigger.
 * cancel() drops a pending run (e.g. when the toggle goes off or the URL is cleared).
 */
export function trailingDebounce(
  fn: () => void,
  ms: number,
  timers: DebounceTimers = { set: (f, m) => window.setTimeout(f, m), clear: (h) => window.clearTimeout(h) },
) {
  let handle: number | null = null;
  return {
    trigger() {
      if (handle !== null) timers.clear(handle);
      handle = timers.set(() => {
        handle = null;
        fn();
      }, ms);
    },
    cancel() {
      if (handle !== null) timers.clear(handle);
      handle = null;
    },
  };
}
