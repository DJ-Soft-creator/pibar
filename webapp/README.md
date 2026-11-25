# PiBar Webapp

Mobile/web version of the PiBar desktop app: the same Pi sessions, everything except the terminal.
The server reaches the Pi hosts itself over SSH (like the desktop's Rust core), the client is a
mobile-first TypeScript app (Vite) that reuses the desktop's logic from `src/shared/`.
JSON-file persistence (no database). **Rebuild in progress** — see `../WEBAPP_TASKS.md`.

## Setup (local)

```sh
cd webapp
npm install
cp .env.example .env   # adjust values
npm run dev            # backend: tsx watch server.ts (port 8787)
npm run dev:client     # client: Vite dev server on :5173, proxies /api and /ws to :8787
```

Production build:

```sh
npm run build          # server: tsc -> dist/, client: vite -> dist/client
npm start              # node dist/server.js
npm test               # node:test via tsx (hosts are faked, see test/fakeHost.ts)
npm run check          # typecheck (server + client), tests, build — must be green
```

On first start (empty `DATA_DIR`) an admin is bootstrapped from `ADMIN_USERNAME` /
`ADMIN_PASSWORD`. If `ADMIN_PASSWORD` is unset, a random password is generated and
printed **once** to the server log — copy it from there.

## Environment variables

| Variable         | Default      | Meaning                                        |
| ---------------- | ------------ | ---------------------------------------------- |
| `PORT`           | `8787`       | HTTP + WebSocket port                          |
| `DATA_DIR`       | `./data`     | users/tokens/config/hosts JSON files (atomic writes) |
| `ADMIN_USERNAME` | `admin`      | bootstrap admin name (first start only)        |
| `ADMIN_PASSWORD` | *(random)*   | bootstrap admin password (first start only)    |
| `SSH_DIR`        | *(own ~/.ssh)* | folder with the SSH key, `known_hosts`, optional `config` |
| `CLIENT_DIR`     | `./dist/client` | static client directory (Vite build)        |

## API overview

- `GET /api/health` — no auth, for the Docker healthcheck.
- `POST /api/cmd/<name>` — the commands of the desktop's Rust core (`src-tauri/src/lib.rs`) with the same
  names and arguments; body = arguments as a JSON object, answer `{ "result": … }` or `{ "error": "…" }`.
  Login required; commands that work on a host take `hostId`, the server checks the user may use it.

- `POST /api/login`, `POST /api/logout` — Bearer tokens (scrypt password hashes).
- `/api/users*` — admin only (list/create/patch/delete).
- `GET /api/hosts` — any authenticated user; hosts sorted by name. `POST/PATCH/DELETE
  /api/hosts*` — admin only, manual hosts. Hosts synced from PiBar (`source: "pibar"`)
  are read-only here (409); they are managed in the desktop app. `user.host` is a plain
  string (normally a host id); unknown/legacy values keep working.
- `POST/GET /api/config`, `GET /api/config/status` — **no auth**: the PiBar desktop
  (`src/main/configExchange.ts`) sends no token. The payload may include an optional
  `hosts` array (`{id, name, kind: "local"|"ssh", address}`); entries are upserted into
  `hosts.json` with `source: "pibar"` (manual hosts untouched, nothing deleted).
  Run this only on the LAN or behind
  a reverse proxy that restricts access; do not expose `/api/config` publicly.
- `GET /api/sessions` — auth required, returns the stored config's sessions.
- `GET /ws` — WebSocket; broadcasts `{"type":"config/updated","receivedAt":…}` on
  every config POST.

## Docker

```sh
docker compose up -d --build   # .env is optional (Compose >= 2.24)
```

The build context is the repository root (the client bundles `src/shared/`); only `webapp/` and
`src/shared/` get into the image (`Dockerfile.dockerignore`).

Multi-stage `node:20-alpine` image with `openssh-client`, server runs as non-root, persists to the `/data` volume.
Compose forces `DATA_DIR=/data` via `environment:` (overrides any `.env` value), so
the named volume is always used. The bootstrap admin gets a random password that is
printed once to `docker compose logs webapp` unless `ADMIN_PASSWORD` is set in `.env`.

## SSH access to the Pi hosts

The container connects to every host with its own key. Prepare a folder on the Docker host (default
`webapp/ssh/`, ignored by Git; other place: `SSH_KEY_DIR` in `.env`):

```sh
mkdir -p ssh && chmod 700 ssh
ssh-keygen -t ed25519 -N "" -C pibar-webapp -f ssh/id_ed25519
# on every Pi host: append ssh/id_ed25519.pub to ~/.ssh/authorized_keys
ssh-keyscan -H <pi-host> >> ssh/known_hosts      # once per host; check the fingerprint
```

Optional `ssh/config` (aliases, jump hosts); without it the container ignores any ssh config.
Unknown host keys are refused (`StrictHostKeyChecking=yes`) — add new hosts to `known_hosts` first.
At start the entrypoint copies the read-only mount to a folder of the `node` user with the
permissions ssh expects, then drops root.

On the hosts Pi must be installed as for the desktop app (`pi` on the PATH of a login shell, or the
host's Pi command), and `bash` must exist.

## Reverse proxy (Nginx Proxy Manager)

HTTPS terminates at Nginx Proxy Manager (external to this repo):

- Proxy host → forward to `http://<docker-host>:8787`, scheme `http`.
- Enable **Websockets Support** so `/ws` upgrades pass through.
- Enable "Block Common Exploits"; force SSL as desired.
- Keep the service LAN/internal-only (the config-sync endpoints are unauthenticated
  by design). No hostnames, IPs or secrets live in this repository.
