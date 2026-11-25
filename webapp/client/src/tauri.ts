// What shared code imports from "@tauri-apps/api/*" (vite.config.ts and client/tsconfig.json point every such
// import here): invoke/listen/emit from the webapp bridge, window functions that do nothing in a browser.
export { emit, invoke, listen } from "./bridge";

export function getCurrentWindow() {
  return {
    setTheme: (_theme: string | null) => Promise.resolve(),
  };
}
