# Webapp Taskliste – PiBar Config Exchange API

> **Ziel:** Mobile-optimierte Webapp (iPhone), die PiBar-Sessions, Farben, Gruppen und Projekte synchronisiert. Docker-Container auf eigenem Host, Admin/User-System, HTTPS via Nginx Proxy Manager.

---

## 1. PiBar Config Exchange API (Hauptfeature)

### 1.1 PiBar → Webapp: SessionConfig exportieren
- **Funktion:** `configExchange.export()` – liest alle Sessions, Projekte, Farben, Gruppen, Pins aus dem lokalen JSONL-Session-Store und sendet sie an den Webapp-Host.
- **Payload (JSON):**
  ```json
  {
    "sessions": [
      {"id": "...", "name": "...", "color": "#FF5733", "group": "Work", "pinned": true, "status": "active"}
    ],
    "projects": [...],
    "colors": {...},
    "groups": [...]
  }
  ```
- **Bidirektional:** Webapp kann Konfigurationen (neue Sessions, Farbwechsel, Gruppen) an PiBar zurücksenden → `configExchange.import(config)`.
- **Trigger:** Manuell (Button im Menü) oder automatisch bei Session-Erstellung/Änderung.

### 1.2 Webapp → PiBar: Konfiguration empfangen
- **API-Endpunkt:** `POST /api/config/sync` (Webapp → PiBar) und `GET /api/config/status` (PiBar → Webapp).
- **Admin-Funktionen (nur Admin):** User-Management, Host-Zuweisung pro User.

### 1.3 Implementierung in PiBar
- Neue Datei: `src/main/configExchange.ts`
  - `exportSessionConfig(): Promise<SessionConfig>` – liest `~/.pi/agent/sessions/*.jsonl`, parst Sessions mit Farben/Gruppen/Pins.
  - `importSessionConfig(config: SessionConfig): Promise<void>` – schreibt in JSONL (oder speichert intern).
  - `getStatus(): Promise<ConfigStatus>` – gibt aktuelle Config zurück.
- Integration in PiBar-Toolbar: neues Tool "Config Exchange" mit Aktionen: Export, Import, Status.

---

## 2. Docker-Container für die Webapp

### 2.1 Dockerfile
- Node.js 20 (LTS), Express + WebSocket-Server (ws), TypeScript-Build im Container.
- Volumes: `~/.pi/agent` (Sessions, Config), `<PiBar-Quellcode-Ordner>` (Quellcode).

### 2.2 docker-compose.yml
- Service `webapp` mit Port 8787 (HTTPS pro Nginx Proxy Manager).
- Service `pi` (PiBar) als Sidecar oder separater Container, damit PiBar die Config von Webapp empfangen kann.

### 2.3 SSH/RPC-Verbindungen zu PiBar
- PiBar startet `pi --mode rpc` mit `--host <webapp-host>:<port>` (RPC-Port 8787).
- Webapp verbindet sich via WebSocket zu `ws://<pi-host>:8787/chat`.
- SSH-Verbindung: PiBar auf dem Mac (SSH) ruft `pi --mode rpc` auf, Webapp auf dem Server ruft über WebSocket zu.

---

## 3. Admin & User-System

### 3.1 Users
- **Admin:** kann alle User verwalten, Hosts zuweisen, Configs exportieren.
- **Normaler User:** hat einen festgelegten Host, kann keine Einstellungen ändern (z. B. keine neuen Sessions, keine Admin-Funktionen).

### 3.2 Implementierung
- Datei `src/main/admin.ts`:
  - `users: { id, username, passwordHash, host, role: "admin" | "user" }`
  - `register(username, password)` – erstellt User.
  - `login(username, password)` – gibt Session-Cookie zurück.
  - `getUsers()`, `getUser(id)`, `updateHost(id, host)`, `deleteUser(id)`.
- Auth: HTTP-Basic oder Token-basiert (JWT). Token in Cookie.

### 3.3 Host-Zuweisung
- Jeder User bekommt einen Host (z. B. "webapp-host"). PiBar verbindet sich mit diesem Host.
- Admin kann Hosts vergeben/entziehen.

---

## 4. HTTPS via Nginx Proxy Manager

- Nginx Proxy Manager als Reverse Proxy vor dem Docker-Container.
- Webapp wird auf Port 8787 gehostet, Nginx leitet zu `https://<host>:8787` weiter.
- SSL-Zertifikat (Let's Encrypt oder selbstsigniert).
- PiBar-RPC auf internem Port (z. B. 8788) – nur intern.

---

## 5. Chat-Funktionen (v1)

- Streaming-Chat mit Tool-Aufrufen (pi tool calls).
- Modellwahl: Standard / qwen4-max-preview (benutzerdefiniertes Modell).
- View-Modus: natural, technical, only-what-I'm-working-on.
- Abbrechen (Abort), neue Session, Resume alter Session.
- Slash-Befehle: `/session`, `/project`, `/color`, `/group`.

---

## 6. Mobile-optimierte Webapp

### 6.1 Design
- Touch-freundlich (große Buttons, Swipe-Navigation).
- Safe Area für Notch/Home-Bar (iPhone notch).
- Dark/Light Mode.
- Responsive Layout: Sidebar (Projekte + Sessions) links, Content rechts.

### 6.2 Features
- Projekt- und Session-Liste mit Farbmarkierungen (Farb-Chips).
- Filter: nach Farbe, Gruppe, Pin, Status filtern.
- MD-Editor für Markdown-Inhalte (Preview).
- Upload/Download von Dateien.
- View-Menü: "Natural", "Technical", "Only what I'm working on".

---

## 7. Session-Verwaltung

- Sessions aus JSONL laden/speichern.
- Versioning (Session-Versionen wie in PiBar: `a2a4642 feat(sessions): ...`).
- Pins, Gruppen, Farb-Codes beibehalten.

---

## 8. Subagents

- Subagents mit dem Modell `wen-token-plan/qwen4-max-preview` starten (Token-Plan: "wen-token-plan/qwen4-max-preview").
- Jedes Subagent bekommt eine Teilaufgabe aus dieser Liste.
- Ergebnisse zusammenführen.

---

## Prioritäten

| Priorität | Aufgabe |
|----------|---------|
| P0 | PiBar Config Exchange API (Export/Import) |
| P0 | Docker-Container + docker-compose |
| P1 | Admin/User-System mit Host-Zuweisung |
| P1 | HTTPS via Nginx Proxy Manager |
| P2 | Chat-Features (Streaming, View, Abort) |
| P2 | Mobile-optimierte Webapp UI |
| P3 | MD-Editor + Upload/Download |
