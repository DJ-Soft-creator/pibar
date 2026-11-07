// Errors that come from Pi's install changing under a running Pi. PiBar keeps one Pi process per open session, and
// `pi update` (or an npm/pnpm update on the host) replaces the package on disk: the hashed bundle chunks the running
// process still asks for are gone, so the next lazy import fails with "Cannot find module …/dist/bundle/chunks/…".
// The way out is always the same — start Pi again in that session — so the case is named once here and both the chat
// error and the diagnosis dialog can offer it. Tested in `piErrors.test.ts`.

const MISSING_MODULE = /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/i;
const PI_INSTALL = /pi-coding-agent|@earendil-works\/pi-[a-z-]+/i;

/** The error says a module of Pi's own install is missing: Pi was updated or removed while the session was running */
export function isStaleInstallError(error: string): boolean {
  return MISSING_MODULE.test(error) && PI_INSTALL.test(error);
}
