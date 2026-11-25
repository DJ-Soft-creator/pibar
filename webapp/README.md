# PiBar Webapp

Mobile/web companion for the PiBar desktop app. Express + ws backend with JSON-file
persistence (no database), serving the static client from `src/client`.

## Setup (local)

```sh
cd webapp
npm install
cp .env.example .env   # adjust values
npm run dev            # tsx watch server.ts
```

Production build:

```sh
npm run build          # tsc -> dist/
npm start              # node dist/server.js
npm test               # node:test via tsx
```

On first start (empty `DATA_DIR`) an admin is bootstrapped from `ADMIN_USERNAME` /
`ADMIN_PASSWORD`. If `ADMIN_PASSWORD` is unset, a random password is generated and
printed **once** to the server log — copy it from there.

## Environment variables

| Variable         | Default      | Meaning                                        |
| ---------------- | ------------ | ---------------------------------------------- |
| `PORT`           | `8787`       | HTTP + WebSocket port                          |
| `DATA_DIR`       | `./data`     | users/tokens/config JSON files (atomic writes) |
| `ADMIN_USERNAME` | `admin`      | bootstrap admin name (first start only)        |
| `ADMIN_PASSWORD` | *(random)*   | bootstrap admin password (first start only)    |
| `CLIENT_DIR`     | `./src/client` | static client directory                      |

## API overview

- `POST /api/login`, `POST /api/logout` — Bearer tokens (scrypt password hashes).
- `/api/users*` — admin only (list/create/patch/delete).
- `POST/GET /api/config`, `GET /api/config/status` — **no auth**: the PiBar desktop
  (`src/main/configExchange.ts`) sends no token. Run this only on the LAN or behind
  a reverse proxy that restricts access; do not expose `/api/config` publicly.
- `GET /api/sessions` — auth required, returns the stored config's sessions.
- `GET /ws` — WebSocket; broadcasts `{"type":"config/updated","receivedAt":…}` on
  every config POST.

## Docker

```sh
docker compose up -d --build   # .env is optional (Compose >= 2.24)
```

Multi-stage `node:20-alpine` image, runs as non-root, persists to the `/data` volume.
Compose forces `DATA_DIR=/data` via `environment:` (overrides any `.env` value), so
the named volume is always used. The bootstrap admin gets a random password that is
printed once to `docker compose logs webapp` unless `ADMIN_PASSWORD` is set in `.env`.

## Reverse proxy (Nginx Proxy Manager)

HTTPS terminates at Nginx Proxy Manager (external to this repo):

- Proxy host → forward to `http://<docker-host>:8787`, scheme `http`.
- Enable **Websockets Support** so `/ws` upgrades pass through.
- Enable "Block Common Exploits"; force SSL as desired.
- Keep the service LAN/internal-only (the config-sync endpoints are unauthenticated
  by design). No hostnames, IPs or secrets live in this repository.
