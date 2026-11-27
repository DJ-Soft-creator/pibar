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
| `DATA_DIR`       | `./data`     | users/tokens/hosts/api-tokens JSON files, `meta/<user id>.json` (atomic writes) |
| `ADMIN_USERNAME` | `admin`      | bootstrap admin name (first start only)        |
| `ADMIN_PASSWORD` | *(random)*   | bootstrap admin password (first start only)    |
| `SSH_DIR`        | *(own ~/.ssh)* | folder with the SSH key, `known_hosts`, optional `config` |
| `DEV_LOCAL_HOME` | *(unset)*    | **development only**: host commands run with bash on this machine against this `$HOME` instead of SSH (e.g. with `node ../dev/fake-pi.mjs` as the host's Pi command) |
| `MAX_UPLOAD_MB`  | `25`         | largest file `upload_file` accepts (it travels base64-encoded; only that command gets the bigger body limit) |
| `COOKIE_SECURE`  | `auto`       | `Secure` on the session cookie: `auto` (HTTPS, also via the proxy), `always`, `never` |
| `CLIENT_DIR`     | `./dist/client` | static client directory (Vite build)        |
| `VAPID_SUBJECT`  | `mailto:admin@example.com` | contact of the operator sent to the push services (`mailto:` or `https:` URL); set your own |

## API overview

- `GET /api/health` — no auth, for the Docker healthcheck.
- `POST /api/cmd/<name>` — the commands of the desktop's Rust core (`src-tauri/src/lib.rs`) with the same
  names and arguments; body = arguments as a JSON object, answer `{ "result": … }` or `{ "error": "…" }`.
  Login required; commands that work on a host take `hostId`, the server checks the user may use it.
- `GET /api/files/download?hostId=…&path=…[&inline=1]` — streams a file of a host to the browser (login, host
  rights and the same path guard as the file commands; `inline` only for PDFs and pictures). File and Git commands
  only reach the host user's home folder and the folders of the host's sessions, resolved on the host (symlinks
  followed); credential folders such as `~/.ssh` stay closed.

- `POST /api/login` — sets the HttpOnly session cookie (`SameSite=Strict`) for the browser and returns the token
  for other clients (Bearer). Foreign origins are refused. `POST /api/logout`, `POST /api/logout-all`.
- Cookie requests that change something must come from our own origin (Origin / Sec-Fetch-Site), so no foreign
  page can act with the cookie. CSP without inline scripts.
- `GET /api/me`, `PUT /api/me/settings` (own UI settings, ≤ 64 KB), `POST /api/me/password`
  (needs the current password, ends all other sessions).
- `/api/users*` — admin only (list/create/patch/delete); `hostIds` = hosts the user may work on (admins: all).
- `GET /api/hosts` — any authenticated user; hosts sorted by name. `POST/PATCH/DELETE
  /api/hosts*` — admin only, manual hosts. Hosts synced from PiBar (`source: "pibar"`)
  are read-only here (409); they are managed in the desktop app. `user.host` is a plain
  string (normally a host id); unknown/legacy values keep working.
- `POST /api/desktop/login {username, password, device?}` — sign-in of a PiBar desktop app as a webapp user
  (10 attempts per minute per client). Answers 201 `{token, tokenId, username, role}`: an API token (`pbt_…`) of
  that user, returned **once**; only its SHA-256 hash is stored (`api-tokens.json`, mode 0600). An API token is no
  login: it only works for the desktop routes. `POST /api/desktop/logout` (Bearer API token) revokes it.
- `GET /api/me/tokens`, `PATCH /api/me/tokens/:id {name}`, `DELETE /api/me/tokens/:id` — the own desktop sign-ins
  (More → Account → Desktop apps). `GET /api/tokens` (with `username`) and `DELETE /api/tokens/:id` — admin only,
  every token. A user's desktop tokens end with a password change or reset and with the user.
- `POST /api/sync/meta` — two-way sync of the user's session organisation with a desktop
  (`src/main/configExchange.ts`). **Only** `Authorization: Bearer <API token>` (no cookie, no login token); 60
  requests per minute per client. See "Desktop sync" below.
- `GET /ws` — WebSocket, login required (cookie only from our own origin); sends `{"type":"meta/updated"}` to a
  user after changes of their organisation (also from a desktop sync); Pi events follow as
  `{"type":"event","event":"pi-event","payload":…}`.

## Desktop sync

Every user has an own organisation of the session list (names, colours, pins, groups, projects …) in
`DATA_DIR/meta/<user id>.json`. A user without that file starts with a copy of the older shared `DATA_DIR/meta.json`
(if there is one), so nothing is lost when updating. The desktop signs in under Settings → Webapp (address, user
name, password; the password is not kept) and then sends its state at start, debounced after every change, every
60 s and on "Sync now". The requests come from the desktop's Rust core (`src-tauri/src/webapp.rs`, curl), not from
its WebView. Body of `POST /api/sync/meta` (ids are the desktop's):

```json
{
  "hosts": [{ "id": "vm", "name": "Server", "kind": "ssh", "address": "user@host.example:22" }],
  "sessionMeta": { "vm|/home/user/.pi/agent/sessions/x.jsonl": { "name": "…", "color": "blue", "updatedAt": 1700000000000 } },
  "groups": [{ "id": "g1", "name": "Work", "color": "teal", "collapsed": false, "updatedAt": 1700000000000 }],
  "projects": [{ "id": "p1", "name": "PiBar", "hostId": "vm", "dir": "~/pibar", "collapsed": false, "updatedAt": 1700000000000 }],
  "deleted": { "sessions": [{ "key": "vm|/…/old.jsonl", "updatedAt": 1700000000000 }], "groups": [{ "id": "g0", "updatedAt": 1 }], "projects": [] }
}
```

- Desktop hosts are matched to the webapp hosts **the user may use** by name (case-insensitive) or SSH address
  (`mapDesktopHost`); entries of unmatched hosts are neither stored nor answered. Groups belong to no host.
- Merge per entry: the newer `updatedAt` wins (ties keep the webapp's), a deletion (tombstone) competes with its
  time. Timestamps more than 5 minutes in the future count as "now". Empty defaults of the desktop ("", false, 0,
  []) are not stored (`tools: []` and `temperature` are kept); unknown fields travel unchanged in both directions.
- Answer: the merged state in the desktop's ids with the same keys, plus `hosts: [{id, webappHost}]` (matched
  webapp host name or null), `serverTime` and `user` (the signed-in user name).

## Session lock (desktop ↔ webapp)

A session must never run in two Pi processes. The script that starts Pi (webapp and desktop alike) writes
`~/.pibar/<FNV-1a of the session path>.lock` on the host (`<owner> <pid> <unix seconds>`) and then `exec`s Pi.
`pi_open` / `pi_attach` check it first: a live pid whose command line names the session file holds the session
(stale locks are ignored, the server's own locks are free) and the command fails with 409
`session-locked:<desktop|webapp>:<since> …` (recognise it with `parseSessionLock` from `src/shared/sessionLock.ts`).
`force: true` takes the session over: the other Pi process is stopped.

## Shared settings (admin → More)

Model presets, quick actions, chat colours (profiles per host, light and dark) and the voice services are shared by
all users and stored in `DATA_DIR/app-config.json` (mode 0600). API keys of the voice services stay on the server:
the admin pages only show whether a key is stored, an empty key field keeps it.

## Voice

Dictation, text improvement and reading aloud call OpenAI-compatible APIs (OpenAI, Groq, speaches, Ollama,
LM Studio …) **from the server** with the keys of the shared settings; the browser only records (MediaRecorder; iOS
Safari records `audio/mp4`) and plays the audio. The microphone needs HTTPS (or `localhost`). The dictation provider
"Command" runs the given program inside the webapp's container (`{file}` = the recording) – the standard image has
no speech recogniser, so this only helps with an own image. Reading aloud can also use the browser's own voice.

## Web push

The webapp can notify a phone when Pi has finished an answer in a session the user had open (not while that chat is
on the screen) and when a reminder of the session list is due. Each user switches it on per device in
**More → Notifications**.

- The VAPID keys are generated on the first start and kept in `DATA_DIR/vapid.json` (mode 0600). Deleting the file
  invalidates every subscription (devices have to switch notifications on again). Set `VAPID_SUBJECT`.
- Subscriptions live in `DATA_DIR/push.json`; only endpoints of the known push services (Apple, Google, Mozilla,
  Microsoft) are accepted. The container must reach them over HTTPS.
- **iPhone/iPad: only in the app on the home screen, iOS/iPadOS 16.4 or newer.** Open the webapp in Safari →
  Share → *Add to Home Screen*, start PiBar from the home screen, then More → Notifications → *Turn on*. A Safari
  tab has no web push. HTTPS is required (Nginx Proxy Manager).
- The service worker (`/sw.js`) only handles push – it caches nothing, the app always loads from the server.

## Docker

```sh
docker compose up -d --build   # .env is optional (Compose >= 2.24)
```

Port on the Docker host: `HOST_PORT` in `.env` (default 8787).

The build context is the repository root (the client bundles `src/shared/`); only `webapp/` and
`src/shared/` get into the image (`Dockerfile.dockerignore`).

Multi-stage `node:20-alpine` image with `openssh-client`, server runs as non-root, persists to the `/data` volume.
Compose forces `DATA_DIR=/data` via `environment:` (overrides any `.env` value), so
the named volume is always used. The bootstrap admin gets a random password that is
printed once to `docker compose logs webapp` unless `ADMIN_PASSWORD` is set in `.env`.

## SSH access to the Pi hosts

The container connects to every host with its own key. Prepare a folder on the Docker host (default
`webapp/ssh/`, ignored by Git; other place: `SSH_KEY_DIR` in `.env`) **before the first `docker compose up`** —
otherwise Docker creates it owned by root (fix: `sudo chown -R "$USER" ssh`). Run the commands as your normal
user, not with sudo (`sudo cmd >> file` still writes the file as you):

```sh
mkdir -p ssh && chmod 700 ssh
ssh-keygen -t ed25519 -N "" -C pibar-webapp -f ssh/id_ed25519
# on every Pi host: append ssh/id_ed25519.pub to ~/.ssh/authorized_keys
ssh-copy-id -i ssh/id_ed25519.pub <user>@<pi-host> # or append the .pub line to ~/.ssh/authorized_keys there
ssh-keyscan -H <pi-host> >> ssh/known_hosts      # host only, no user@; once per host; check the fingerprint
# test with the container's settings:
ssh -i ssh/id_ed25519 -o IdentitiesOnly=yes -o UserKnownHostsFile=ssh/known_hosts \
    -o StrictHostKeyChecking=yes <user>@<pi-host> 'bash -lc "pi --version"'
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
- Keep the service LAN/internal-only. No hostnames, IPs or secrets live in this repository.
