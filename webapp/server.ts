// PiBar webapp backend entry point. Express + ws on a real http.Server, JSON-file persistence under DATA_DIR,
// commands over SSH (SSH_DIR: key, known_hosts), static client from dist/client (Vite build).
import { createServer } from "node:http";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { createApp } from "./src/server/app.js";
import { bootstrapAdmin } from "./src/server/auth.js";
import { createRegistry } from "./src/server/cmd/index.js";
import { canUseHost } from "./src/server/helpers.js";
import { HostExec, LocalRunner, SshRunner } from "./src/server/host/hostexec.js";
import { toTarget } from "./src/server/hosts.js";
import { Store } from "./src/server/store.js";
import { createSocketHub, type SocketHub } from "./src/server/ws.js";

dotenv.config();

const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const clientDir = resolve(process.env.CLIENT_DIR ?? "./dist/client");
const sshDir = process.env.SSH_DIR?.trim() ? resolve(process.env.SSH_DIR.trim()) : null;
// Development only: run host commands with bash on this machine against this $HOME instead of SSH (with
// dev/fake-pi.mjs as the host's Pi command there is no need for a real Pi host). Never set it in production.
const devLocalHome = process.env.DEV_LOCAL_HOME?.trim() ? resolve(process.env.DEV_LOCAL_HOME.trim()) : null;
const rawSecure = process.env.COOKIE_SECURE ?? "auto";
const cookieSecure = rawSecure === "always" || rawSecure === "never" ? rawSecure : "auto";

// Validate PORT: integer 1-65535, otherwise fall back to 8787 with a warning.
const rawPort = process.env.PORT ?? "8787";
const parsedPort = Number(rawPort);
const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : 8787;
if (port !== parsedPort) {
  console.warn(`[pibar-webapp] Invalid PORT "${rawPort}" (expected integer 1-65535), falling back to 8787.`);
}

const store = new Store(dataDir);
await bootstrapAdmin(
  store,
  { ADMIN_USERNAME: process.env.ADMIN_USERNAME, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD },
  (msg) => console.log(msg),
);

let hub: SocketHub | null = null;

const app = createApp(store, {
  clientDir,
  cookieSecure,
  commands: {
    registry: createRegistry(),
    exec: new HostExec(devLocalHome ? new LocalRunner(devLocalHome) : new SshRunner({ dir: sshDir })),
    resolveHost: (id) => {
      const h = store.hosts.get(id);
      return h ? toTarget(h) : null;
    },
    canUseHost,
  },
  onConfigUpdated: (receivedAt) => hub?.broadcast({ type: "config/updated", receivedAt }),
});

const server = createServer(app);
hub = createSocketHub(server, store);

if (devLocalHome) console.warn(`[pibar-webapp] DEV_LOCAL_HOME set: host commands run locally in ${devLocalHome} (no SSH)`);

server.listen(port, () => {
  console.log(`[pibar-webapp] Listening on http://localhost:${port} (data: ${dataDir})`);
});
