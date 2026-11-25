// Stand-ins for the Tauri APIs that shared code (src/shared/) imports. The webapp has no Tauri: window calls do
// nothing, invoke() fails loudly – the webapp talks to its server through webApi.ts instead (task C1).
export function invoke<T>(cmd: string, _args?: unknown): Promise<T> {
  return Promise.reject(new Error(`Tauri command "${cmd}" is not available in the webapp`));
}

export function getCurrentWindow() {
  return {
    setTheme: (_theme: string | null) => Promise.resolve(),
  };
}

export function listen(_event: string, _handler: unknown): Promise<() => void> {
  return Promise.resolve(() => {});
}
