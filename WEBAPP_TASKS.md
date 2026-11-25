# Webapp – Taskliste (Neuaufbau)

> **Ziel:** PiBar im Browser auf dem Handy. Gleiche Pi-Sessions wie die Desktop-App, alles außer dem Terminal.
> Läuft als Docker-Container auf einem internen Docker-Host, verbindet sich **selbst per SSH** mit den Pi-Hosts
> (unabhängig vom Mac). Zugriff von unterwegs über VPN → Nginx Proxy Manager (SSL) → Container. Mehrere Benutzer.
>
> Ersetzt die alte Liste (Config-Exchange-Ansatz). Diese Liste ist für die Umsetzung mit Subagents geschrieben:
> jede Task ist in sich abgeschlossen, nennt Referenzdateien, Abhängigkeiten und ein „Fertig wenn“.

---

## 0. Grundentscheidungen (gelten für alle Tasks)

| Thema | Entscheidung |
|---|---|
| Wo läuft Pi? | Auf den Hosts, wie bisher. Der Container startet `ssh <host> pi --mode rpc` – genau wie `src-tauri/src/pi.rs` + `hostexec.rs`. Lokale Hosts gibt es in der Webapp nicht (nur SSH). |
| Gleiche Sessions | Ergibt sich automatisch: Sessions sind die JSONL-Dateien auf dem Host (`~/.pi/agent/sessions`). Die Webapp liest sie mit **denselben Shell-Skripten** wie `src-tauri/src/sessions.rs`. |
| Rust → Node | Jedes Rust-Modul wird 1:1 nach `webapp/src/server/host/*.ts` portiert. Shell-Skripte (`LIST_SCRIPT` usw.) **wörtlich übernehmen**, nicht neu erfinden. Rust bleibt die Referenz. |
| API-Form | Server-Endpunkte heißen wie die Tauri-Commands (`POST /api/cmd/<command>`, Body = dieselben Argumente). Im Client zeigt jeder Import von `@tauri-apps/api/*` auf `webapp/client/src/bridge.ts`: `invoke()` ruft den Server. Damit läuft `src/shared/api.ts` **unverändert**. Pi-Events kommen per WebSocket (`{"type":"event","event":"pi-event","payload":{handle,event}}`, wie Tauris `pi-event`/`pi-exit`). |
| Client | Neu in TypeScript + Vite (`webapp/client/`), Mobile-first, ohne UI-Framework (ADR 0003). Importiert die Logik aus `src/shared/` (piProtocol, chatViews, diff, tree, branches, questions, planMode, presets, sessionColors, i18n, format, search, …). `src/main/` ist Desktop-Layout und wird **nicht** übernommen, dient aber als Verhaltensreferenz. |
| Pi-Prozesse | Gehören dem **Server**, nicht dem Handy. Handy weg (Sperrbildschirm, Funkloch) → Pi läuft weiter, Client holt beim Wiederverbinden die verpassten Events nach (Event-Puffer pro Session). |
| Parallel Desktop + Webapp | Dieselbe Session darf nicht von zwei Pi-Prozessen gleichzeitig beschrieben werden. Lösung: Lock-Datei auf dem Host (siehe Task B9 + D1). |
| Config | Die Webapp hat ihre eigene Config (Hosts inkl. SSH-Daten, Presets, Quick Actions, Farbprofile). Gemeinsam mit dem Desktop werden nur **Session-Metadaten, Gruppen, Projekte** abgeglichen – in beide Richtungen, mit Token, pro Eintrag `updatedAt`, neuester gewinnt. |
| Sicherheit | Alles hinter Login (auch der Desktop-Sync, per API-Token). SSH-Key read-only gemountet, `known_hosts` fest (kein `StrictHostKeyChecking=no`). Dateizugriffe nur innerhalb der Session-/Projektordner. |
| Weggelassen | Terminal, Quick-Bar, Hotkeys, Doppeltipp, Bildschirmfoto/OCR, App-Badge, native Notifications (ersetzt durch In-App + später Web Push). |

**Bestehenden Code behalten:** `webapp/src/server/auth.ts`, `rateLimit.ts`, `store.ts` (wird erweitert), `validation.ts`, `helpers.ts`, `Dockerfile`, `docker-compose.yml`, Test-Grundgerüst.
**Ersetzen:** `webapp/src/client/*` (nur Config-Anzeige), die Config-Routen in `app.ts` (ohne Auth), WebSocket-Logik in `server.ts`.

**Regeln für jeden Subagent** (aus `AGENTS.md`/`CONTRIBUTING.md`):
- Vorher `docs/CODEMAP.md` und `CONTRIBUTING.md` lesen.
- Nach jeder Task: `cd webapp && npm run check` (Typecheck + Lint + Tests) grün; bei Änderungen außerhalb `webapp/` zusätzlich `npm run check` im Root.
- Neue Datei/neuer Ablauf → `docs/CODEMAP.md` im selben Schritt ergänzen.
- UI-Texte über `t("English")` + deutscher Eintrag in `src/shared/i18n.ts`.
- Keine Serveradressen, Namen, Keys oder Sessions im Repository.
- Jede Server-Task bringt Tests mit (SSH wird in Tests durch einen Fake ersetzt, siehe A4).

---

## Stand

| Task | Status |
|---|---|
| A1–A6, B1–B3, B10, C1–C4, C6, E3, E4 | ✅ erledigt (Branch `webapp-rebuild`) |
| B9 | ◐ Pi-Prozesse laufen; dieselbe Session wird in der Webapp geteilt statt doppelt gestartet. Lock gegenüber der Desktop-App fehlt noch (mit D1) |
| E5, F1 | ◐ neue Session im Standardordner des Hosts (Ordnerauswahl fehlt); Pi-Dialoge confirm/select/input/editor/notify |
| alle anderen | offen |

## Wellen (Reihenfolge für Subagents)

Tasks innerhalb einer Welle sind unabhängig und können **parallel** laufen.

| Welle | Tasks |
|---|---|
| 1 | A1, A2, A3, A4 ✅ |
| 2 | A5, A6, B1, C1 ✅ |
| 3 | B2, B3, B4, B5, B6, B7, B8, C2, C3 |
| 4 | B9, B10, B11, B12, B13, B14, C4, C5, C6 |
| 5 | E1–E8 (Sessions/Chat-UI) |
| 6 | F1–F7 (Chat-Extras), G1–G6 (Dateien & Git) |
| 7 | H1–H6 (Organisation), D1–D3 (Desktop-Abgleich) |
| 8 | I1–I5 (Einstellungen/Admin), J1–J4 (Extras) |
| 9 | K1–K4 (Härtung, Doku, Abnahme) |

---

## A. Fundament

### A1 – Projektstruktur Client (Vite + TS) ✅
- **Was:** `webapp/client/` mit Vite + strict TypeScript anlegen; Build nach `webapp/dist/client`. Alias `@shared` → `../src/shared`. Server liefert `dist/client` statisch aus. Alten `webapp/src/client/` löschen.
- **Achtung:** `src/shared/theme.ts` importiert `@tauri-apps/api/window` → im Client per Vite-Alias auf einen Stub umleiten oder `theme.ts` in Tauri-freien Teil + Adapter aufteilen.
- **Fertig wenn:** `npm run build` erzeugt Server + Client; eine leere Seite lädt im Container; `src/shared/format.ts` lässt sich im Client importieren.

### A2 – Server-Struktur & Command-Router ✅
- **Was:** Ordner `webapp/src/server/host/` (Rust-Ports), `webapp/src/server/routes/`. Generischer Router `POST /api/cmd/:name` → registrierte Handler mit Argument-Validierung, Auth und Host-Berechtigung (A5). Fehler als `{ error }` wie Tauri-Strings.
- **Referenz:** `src-tauri/src/lib.rs` (Liste aller Commands), `src/shared/api.ts`.
- **Fertig wenn:** Ein Dummy-Command ist per Test aufrufbar; unbekannte Commands → 404; ohne Token → 401.

### A3 – Docker: SSH-fähig ✅
- **Was:** Runtime-Image bekommt `openssh-client` + `git`. Volumes: `/data` (wie bisher), `/ssh` read-only (Key + `known_hosts`). SSH-Optionen zentral: `BatchMode=yes`, `UserKnownHostsFile=/ssh/known_hosts`, `ControlMaster=auto`, `ControlPersist=60s`, `ControlPath=/tmp/ssh-%C` (schnelle Folgeaufrufe). Healthcheck `GET /api/health`.
- **Fertig wenn:** `docker compose up` startet; im Container funktioniert `ssh -F /dev/null …` mit gemountetem Key; README beschreibt Key-Erzeugung und `ssh-keyscan` für `known_hosts`.

### A4 – Test-Infrastruktur mit Fake-Host ✅
- **Was:** Austauschbare `HostExec`-Schnittstelle (`runShell`, `spawn`). In Tests ein Fake, der Skripte gegen ein temporäres Verzeichnis lokal per `bash` ausführt (statt SSH) und `dev/fake-pi.mjs` als Pi startet.
- **Referenz:** `dev/fake-pi.mjs`.
- **Fertig wenn:** Ein Test listet Sessions aus einem Temp-Ordner über den Fake; ein Test startet `fake-pi` und bekommt eine RPC-Antwort.

### A5 – Benutzer, Rollen, Host-Rechte ✅
- **Was:** `user.host: string` → `user.hostIds: string[]` (Migration bestehender Daten). Admin sieht alle Hosts. Jeder Command mit `hostId` prüft die Berechtigung zentral im Router (A2). Pro Benutzer eigene UI-Einstellungen (Theme, Sprache, Chat-Modus, Textgröße).
- **Fertig wenn:** Tests: Benutzer ohne Recht auf Host X bekommt 403 bei jedem Command mit `hostId: X`; Migration alter `users.json` funktioniert.

### A6 – Login-Härtung ✅
- **Was:** Token als `HttpOnly; Secure; SameSite=Strict`-Cookie statt `localStorage` (Bearer bleibt für den Desktop-Sync). CSP aktivieren (geht, weil kein Inline-Code mehr). Logout aller Geräte. Passwort ändern für sich selbst.
- **Fertig wenn:** Tests für Cookie-Login, CSP-Header gesetzt, eigenes Passwort änderbar.

---

## B. Server: Portierung der Rust-Kerns (Host-Zugriff)

Alle Tasks: Datei `webapp/src/server/host/<modul>.ts`, Shell-Skripte wörtlich aus Rust übernehmen, Parser mit denselben Testfällen wie die Rust-Tests (`#[cfg(test)]` in der jeweiligen Datei).

### B1 – hostexec ✅
- **Referenz:** `src-tauri/src/hostexec.rs` (`ssh_args`, `shell_command`, `run_shell`, `spawn_pi`, `sq`, `shell_path`).
- **Was:** SSH-Aufruf mit Login-Shell auf dem Host, Quoting, stdin, Timeouts, `piCommand` und `useHerdr` beachten.
- **Fertig wenn:** Quoting-Tests identisch zu Rust; `runShell` und `spawnPi` laufen gegen den Fake (A4).

### B2 – Hosts verwalten + Verbindungstest ✅
- **Referenz:** `config.rs` (`HostCfg`), `lib.rs::test_host`.
- **Was:** Host-CRUD (Admin) mit Feldern aus `HostCfg` (ohne `kind: local`), `test_host`-Command.
- **Fertig wenn:** Admin legt Host an, „Verbindung testen“ liefert Pi-Version oder verständlichen Fehler.

### B3 – Sessions auflisten, löschen, Outlines ✅
- **Referenz:** `sessions.rs` (`list`, `delete`, `outlines`, `parse_outlines`, `is_session_file`).
- **Commands:** `list_sessions`, `delete_sessions`, `session_outlines`.
- **Fertig wenn:** Gleiche Ausgabe wie Desktop für denselben Host (Titel, Name, cwd, parent, modified).

### B4 – Session lesen, Suche, Export, Touches
- **Referenz:** `sessions.rs` (`search`, `parse_hits`, `export`, `touches`, `touched_by_message`), `lib.rs::read_session_file`.
- **Commands:** `read_session_file`, `search_sessions`, `session_touches`.
- **Fertig wenn:** Volltextsuche liefert Treffer; Session-Datei wird komplett geliefert.

### B5 – Modelle & Agents
- **Referenz:** `models.rs`, `agents.rs`.
- **Commands:** `list_models`, `list_agents`, `agent_prompt_file`.
- **Fertig wenn:** Modell-Liste und Agent-Definitionen eines Hosts kommen an.

### B6 – Dateien
- **Referenz:** `files.rs`.
- **Commands:** `list_files`, `read_file`, `read_image`, `read_file_head`, `write_file`, `create_file`, `upload_file`, `download_file`, `list_dirs`, `create_dir`, `delete_path`, `save_text_file`.
- **Wichtig:** Pfadprüfung wie in Rust (nur innerhalb der Session-/Projektordner, Session-Wurzeln nicht löschbar). Upload/Download als Stream statt Base64, Limit konfigurierbar (`MAX_UPLOAD_MB`).
- **Fertig wenn:** Tests für Pfad-Ausbruch (`../`, Symlinks) schlagen fehl wie erwartet; Upload 20 MB klappt.

### B7 – Git
- **Referenz:** `gitlog.rs`, `lib.rs::git_commit`, `git_diff`.
- **Commands:** `git_log`, `git_commit`, `git_diff`.
- **Fertig wenn:** Historie eines Repos und einer Datei, Diff eines Commits abrufbar.

### B8 – Snapshots / Zurückspulen
- **Referenz:** `snapshot.rs`.
- **Commands:** `snapshot_take`, `rewind_preview`, `rewind_restore`, `rewind_undo`.
- **Fertig wenn:** Gleiche Refs (`refs/pibar/<session id>/<n>`) wie der Desktop → Snapshots sind zwischen Desktop und Webapp austauschbar.

### B9 – Pi-Prozesse (RPC) + Session-Lock
- **Referenz:** `pi.rs` (`PiManager`, `pump`, `tool_args`), `lib.rs::pi_open/pi_send/pi_reply/pi_stderr/pi_close`.
- **Was:** `PiManager` in Node: ein Prozess pro offener Session, JSON-Lines über stdin/stdout, Request/Response per `id`, alles andere als Event. Prozess gehört dem Server, nicht der WebSocket-Verbindung. Leerlauf-Timeout (z. B. 30 min ohne Client und ohne laufende Antwort → schließen).
- **Lock:** Vor dem Öffnen `~/.pibar/<hash>.lock` auf dem Host anlegen (Inhalt: `webapp:<user>:<pid>`; `hash` = FNV-1a wie `bg.rs::hash`). Ist die Session schon offen (Lock oder laufender Hintergrund-Run), Client fragt: „Nur lesen“ oder „übernehmen“.
- **Fertig wenn:** Test mit `fake-pi`: Prompt senden, Events kommen an, Abbruch funktioniert; zweites Öffnen derselben Session meldet den Lock.

### B10 – Event-Streaming per WebSocket ✅
- **Was:** `/ws` mit Auth (Cookie). Client abonniert Pi-Handles. Ringpuffer pro Handle (z. B. letzte 2000 Events, fortlaufende `seq`). Beim Wiederverbinden schickt der Client die letzte `seq` und bekommt den Rest. Pi-Dialoge (extension UI: select/confirm/input/editor) gehen an alle Abonnenten, Antwort über `pi_reply`.
- **Fertig wenn:** Test: Verbindung während einer Antwort trennen, neu verbinden → keine Events fehlen, keine doppelt.

### B11 – Hintergrund-Runs
- **Referenz:** `bg.rs`, `lib.rs::bg_follow/bg_running/bg_stop`, `pi.rs::open_follow`.
- **Commands:** `bg_follow`, `bg_running`, `bg_stop` (+ Start im Hintergrund).
- **Fertig wenn:** Ein auf dem Desktop gestarteter Hintergrund-Run ist in der Webapp sichtbar, verfolgbar und stoppbar – und umgekehrt (gleiche `.log`/`.pid`-Dateien).

### B12 – Diagnose
- **Referenz:** `diag.rs`. **Command:** `diagnose`.
- **Fertig wenn:** Diagnosebericht eines Hosts abrufbar, Secrets ausgeblendet.

### B13 – Temperatur-Extension
- **Referenz:** `temp.rs`, `src-tauri/extensions/pibar-temperature.ts`. **Command:** `temp_install`.
- **Fertig wenn:** Extension wird auf dem Host installiert (gleiche Datei wie vom Desktop).

### B14 – Aktivitäts-Status
- **Referenz:** `src/main/activity.ts`.
- **Was:** Server kennt alle laufenden Pi-Prozesse/Runs und broadcastet `session/busy` und `session/finished` an alle berechtigten Clients.
- **Fertig wenn:** Zweites Handy sieht, dass auf dem ersten eine Session arbeitet.

---

## C. Client-Fundament

### C1 – Bridge statt Tauri ✅
- **Umgesetzt:** `client/src/bridge.ts` ersetzt Tauris `invoke`/`listen`/`emit` (Vite-Alias). `invoke(cmd, args)` = `POST /api/cmd/<cmd>`, Fehler kommen wie bei Tauri als String, 401 ruft einen Handler (→ Login-Screen). `client/src/socket.ts` liefert Server-Events an `listen()` und verbindet sich neu (Backoff, beim Entsperren sofort).
- **Folge für alle B-Tasks:** Ein Command ist im Client sofort über `api.<funktion>()` aus `src/shared/api.ts` nutzbar, sobald der Server ihn mit dem Tauri-Namen registriert. Nicht portierte Commands antworten „Unknown command: …“.
- **Achtung bei Downloads/Uploads:** `download_file` öffnet am Desktop einen Speichern-Dialog – im Web liefert der Server die Datei, der Client löst den Browser-Download aus (Task B6/G4).

### C2 – App-Shell mobil ✅
- **Was:** Login-Screen, Navigation (unten: Sessions · Chat · Dateien · Mehr), Safe Areas (Notch/Home-Bar), Dark/Light/System, Textgröße (`src/shared/textScale.ts`), i18n (`src/shared/i18n.ts`), Toasts, Bottom-Sheets, Offline-/Verbindungsbanner, „Zum Home-Bildschirm“ (Manifest + Icons, PWA ohne Offline-Cache).
- **Fertig wenn:** Auf iPhone (Safari) sauber bedienbar, Tasten ≥ 44 px, kein horizontales Scrollen.

### C3 – Client-State & Routing ✅
- **Was:** Zentraler State (Hosts, Sessions, offene Session, Config, Benutzer), Hash-Routing (`#/s/<host>/<session>`), damit Zurück-Taste und Links funktionieren.
- **Fertig wenn:** Reload auf einer Session-URL öffnet dieselbe Session.

### C4 – WebSocket-Client mit Wiederverbinden ✅
- **Was:** Auto-Reconnect mit Backoff, Nachholen per `seq` (B10), Wiederverbinden bei `visibilitychange` (Handy wird entsperrt).
- **Fertig wenn:** Handy 2 min sperren während Pi arbeitet → beim Entsperren ist der Chat vollständig.

### C5 – Fehleranzeige
- **Referenz:** `src/shared/piErrors.ts`, `src/main/diagnose.ts`.
- **Fertig wenn:** Pi-Fehler erscheinen als Box im Chat mit „Diagnose“-Button (B12).

### C6 – Benutzer-Einstellungen synchronisieren ✅
- **Was:** UI-Einstellungen pro Benutzer serverseitig speichern (A5), damit sie auf allen Geräten gleich sind.
- **Fertig wenn:** Theme auf Handy ändern → am Tablet nach Reload gleich.

---

## E. Sessions & Chat (Kern)

### E1 – Session-Liste
- **Referenz:** `src/main/sessions.ts`, `src/shared/sessionOrder.ts`, `listFilter.ts`, `sessionColors.ts`.
- **Was:** Pro Host (nur berechtigte), Sortierung/Gruppierung nach Datum/Ordner wie Desktop, Farben, Pins, Gruppen, Namen, Aktivitäts-Markierung (B14), Pull-to-Refresh.
- **Fertig wenn:** Gleiche Sessions in gleicher Reihenfolge wie im Desktop.

### E2 – Suche
- **Referenz:** `src/main/search.ts`, `src/shared/search.ts`.
- **Fertig wenn:** Sofortfilter der Liste + Volltexttreffer (B4) über der Liste.

### E3 – Chat-Ansicht (lesen) ✅
- **Referenz:** `src/main/chatView.ts`, `src/shared/chatViews.ts`, `piProtocol.ts`, `colors.ts`.
- **Was:** Verlauf rendern (Markdown, Code, Thinking, Tool-Calls einklappbar, Diffs via `src/shared/diff.ts`), Ansichtsmodi (natural/technical/…), Farbprofile des Hosts.
- **Fertig wenn:** Eine lange Session (> 500 Nachrichten) scrollt flüssig auf dem iPhone (virtuell oder stückweise rendern).

### E4 – Chat schreiben & streamen ✅
- **Referenz:** `src/main/sessionTab.ts`.
- **Was:** Eingabe (wächst mit, Senden-Taste), Streaming, Abbrechen, Nachricht während Pi arbeitet (Steer/Follow-up wie Desktop), Auto-Scroll-Modi (`autoScroll.ts`).
- **Fertig wenn:** Prompt senden, Antwort streamt, Abbrechen stoppt Pi.

### E5 – Neue Session / fortsetzen
- **Referenz:** `sessionTab.ts`, `src/main/folderPicker.ts`.
- **Was:** Neue Session auf Host + Ordner (Ordnerauswahl via `list_dirs`), Projekt-Shortcut, alte Session fortsetzen, Lock-Dialog (B9).
- **Fertig wenn:** Neue Session in der Webapp erscheint danach im Desktop – und umgekehrt.

### E6 – Modell & Presets
- **Referenz:** `src/shared/presets.ts`, `sessionTab.ts` (Modellwahl), `lib.rs::list_models`.
- **Fertig wenn:** Modell pro Session wählbar, Presets aus der Config nutzbar, Wahl bleibt in `sessionMeta`.

### E7 – Plan-/Build-Modus, Kontext-Modus, Antwortstil, Temperatur
- **Referenz:** `src/shared/planMode.ts`, `contextMode.ts`, `temperature.ts`, `ui.answerMode`.
- **Fertig wenn:** Alle vier Schalter wirken wie im Desktop.

### E8 – Statuszeile / Verbrauch
- **Referenz:** `src/main/usageStats.ts`.
- **Fertig wenn:** Tokens, Kosten, Kontextnutzung unter der Eingabe (antippen → Details-Sheet).

---

## F. Chat-Extras

### F1 – Fragen & Pi-Dialoge
- **Referenz:** `src/main/answerDialog.ts`, `src/shared/questions.ts`.
- **Fertig wenn:** Auswahlfragen am Ende einer Antwort und Pi-Dialoge (select/confirm/input/editor) als Bottom-Sheet beantwortbar.

### F2 – Slash-Menü
- **Referenz:** `src/main/slashMenu.ts`.
- **Fertig wenn:** `/` in der Eingabe zeigt Befehle/Skills des Hosts.

### F3 – Anhänge
- **Referenz:** `src/main/composerTools.ts`, `fileUpload.ts`, `src/shared/attach.ts`.
- **Was:** Dateien/Fotos vom Handy anhängen (Kamera, Fotos, Dateien-App), Chips über der Eingabe, Upload in den Session-Ordner (B6).
- **Fertig wenn:** Foto vom iPhone anhängen → Pi sieht die Datei.

### F4 – Quick Actions
- **Referenz:** `src/main/quickActions.ts`, `src/shared/quickActions.ts`.
- **Was:** Nur Aktionen vom Typ Befehl/Nachricht. Aktionen vom Typ Shell-Skript (brauchen Terminal) ausblenden.
- **Fertig wenn:** Quick-Action-Leiste über der Eingabe, horizontal scrollbar.

### F5 – Versionen / Branches
- **Referenz:** `src/main/branchNav.ts`, `sessionVersions.ts`, `src/shared/branches.ts`.
- **Fertig wenn:** „‹ 2/3 ›“ unter eigenen Nachrichten, ältere Versionen in der Liste einklappbar.

### F6 – Zurückspulen mit Dateien
- **Referenz:** `src/main/rewindFiles.ts`, B8.
- **Fertig wenn:** Zu einer Nachricht zurück inkl. Vorschau der betroffenen Dateien und Rückgängig.

### F7 – Subagents
- **Referenz:** `src/main/subagents.ts`, `src/shared/subagents.ts`, B5.
- **Fertig wenn:** Subagent-Runs eingerückt unter der Session, „Neuer Subagent…“ mit Agent-Auswahl, Modellwahl, Stop.

---

## G. Dateien & Git

### G1 – Dateibaum
- **Referenz:** `src/main/files.ts`, `src/shared/tree.ts`.
- **Was:** Baum des Session-Ordners als eigene Ansicht, Filter (nur Markdown/HTML/Bilder), von Pi geänderte Dateien markiert (B4 `session_touches`), Git-Status.
- **Fertig wenn:** Baum lädt auch bei großen Ordnern ohne Hänger (lazy).

### G2 – Datei ansehen
- **Was:** Markdown gerendert, HTML in Sandbox-iframe, Bilder, Code mit Syntax-Hervorhebung, PDF per Browser.
- **Fertig wenn:** Alle fünf Typen werden auf dem iPhone sauber angezeigt.

### G3 – Datei bearbeiten
- **Was:** Texteditor für Textdateien, Markdown-Vorschau umschaltbar, Speichern mit Konflikt-Erkennung (Datei geändert seit dem Öffnen → Hinweis).
- **Fertig wenn:** Bearbeiten + Speichern klappt; paralleler Pi-Schreibzugriff wird erkannt.

### G4 – Anlegen, hochladen, herunterladen, löschen
- **Referenz:** `src/main/deleteDialog.ts`, B6.
- **Fertig wenn:** Datei/Ordner anlegen, Upload vom Handy, Download aufs Handy, Löschen mit zwei Bestätigungen.

### G5 – Git-Historie
- **Referenz:** `src/main/gitHistory.ts`, B7.
- **Fertig wenn:** Commits eines Repos und einer Datei, Diff eines Commits.

### G6 – Git-Commit
- **Referenz:** `lib.rs::git_commit`.
- **Fertig wenn:** Geänderte Dateien ansehen und mit Nachricht committen.

---

## H. Organisation

### H1 – Session-Metadaten bearbeiten
- **Referenz:** `src/main/sessionGroups.ts`, `sessionColorSettings.ts`.
- **Was:** Umbenennen, Farbe (mit eigenen Farbbeschreibungen), Pin, Gruppe – per Long-Press/Swipe-Menü.
- **Fertig wenn:** Änderungen landen in der Webapp-Config mit `updatedAt` (Grundlage für D2).

### H2 – Gruppen
- **Fertig wenn:** Gruppen anlegen/umbenennen/färben/löschen, ein-/ausklappen.

### H3 – Projekte
- **Referenz:** `src/main/projects.ts`, `src/shared/projects.ts`.
- **Fertig wenn:** Projekte anlegen (Host + Ordner), Sessions eines Projekts gefiltert, neue Session im Projekt.

### H4 – Mehrfachauswahl & Aufräumen
- **Referenz:** `src/main/sessionSelect.ts`, `cleanup.ts`.
- **Fertig wenn:** Mehrere Sessions wählen → Gruppe/Farbe/Archiv/Löschen, Archiv mit Rückgängig.

### H5 – Session-Export
- **Referenz:** `src/main/sessionExport.ts`, `src/shared/sessionExport.ts`.
- **Fertig wenn:** Export als Markdown/JSON/CSV wird aufs Handy heruntergeladen bzw. über das Teilen-Menü geteilt.

### H6 – Erinnerungen
- **Referenz:** `src/main/reminders.ts`.
- **Was:** Erinnerung setzen/listen; fällige Erinnerungen als In-App-Hinweis. (Push aufs gesperrte Handy → J3.)
- **Fertig wenn:** Fällige Erinnerung erscheint beim Öffnen der App oben.

---

## D. Abgleich mit der Desktop-App

### D1 – Desktop: Session-Lock beachten
- **Wo:** `src-tauri/src/pi.rs` / `lib.rs::pi_open`, `src/main/sessionTab.ts`.
- **Was:** Desktop legt dieselbe Lock-Datei an (B9) und zeigt den Dialog „In der Webapp geöffnet – nur lesen / übernehmen“.
- **Fertig wenn:** Session in der Webapp offen → Desktop warnt, und umgekehrt. Stale Locks (Prozess tot) werden ignoriert.

### D2 – Sync-API (Webapp)
- **Was:** `GET/PUT /api/sync/meta` mit API-Token (Admin legt Token pro Desktop an, `Authorization: Bearer`). Inhalt: `sessionMeta`, `groups`, `projects`, jeder Eintrag mit `updatedAt`; Löschungen als Tombstone. Zusammenführen: neuester Eintrag gewinnt. Alte Routen `/api/config*` entfernen.
- **Fertig wenn:** Tests für Merge (beide Seiten ändern verschiedene Einträge, beide denselben, Löschen vs. Ändern).

### D3 – Sync im Desktop
- **Wo:** `src/main/configExchange.ts`, `configExchangeTool.ts`, `configExchangeMenu.ts`, `settings.ts`.
- **Was:** Statt nur unbekannte IDs zu importieren: echter Zwei-Wege-Sync über D2 (beim Start, nach jedem Speichern debounced, alle 60 s). `updatedAt` pro Eintrag in `sessionMeta`/`groups`/`projects` ergänzen. API-Token in den Einstellungen (nicht im Repo).
- **Fertig wenn:** Farbe am Handy ändern → spätestens nach 60 s im Desktop; Gruppe am Desktop löschen → am Handy weg. `npm run check` im Root grün, CODEMAP angepasst.

---

## I. Einstellungen & Admin

### I1 – Admin: Benutzer
- **Fertig wenn:** Benutzer anlegen, Rolle, Host-Rechte (Mehrfachauswahl), Passwort zurücksetzen, löschen (letzter Admin geschützt).

### I2 – Admin: Hosts
- **Fertig wenn:** Host-Formular wie Desktop-Einstellungen (SSH-Ziel, Benutzer, Port, Pi-Befehl, Standardordner, herdr, Farbprofil) + Verbindungstest + Diagnose.

### I3 – Admin: Desktop-Tokens
- **Fertig wenn:** Token erzeugen (einmal angezeigt), benennen, widerrufen.

### I4 – Modell-Presets & Quick Actions
- **Referenz:** `src/main/settings.ts` (`presetEditor`, `quickActionsEditor`).
- **Fertig wenn:** Presets anlegen/sortieren, Quick Actions anlegen (Admin global).

### I5 – Farbprofile
- **Referenz:** `src/main/colorSettings.ts`, `color-profiles.md`.
- **Fertig wenn:** Profile bearbeiten und Hosts zuweisen.

---

## J. Extras (zuletzt)

### J1 – Diktieren
- **Referenz:** `src-tauri/src/voice.rs`, `src/main/voiceSettings.ts`, `src/shared/voice.ts`.
- **Was:** Mikrofon im Browser (MediaRecorder) → Server → Transkription wie `voice.rs` (OpenAI-kompatible API). API-Key nur auf dem Server.
- **Fertig wenn:** Auf dem iPhone Sprachnachricht diktieren → Text in der Eingabe.

### J2 – Text verbessern & Vorlesen
- **Referenz:** `voice.rs` (`improve_text`, `speak_text`).
- **Fertig wenn:** Eingabe per Knopf verbessern; Antwort vorlesen.

### J3 – Web Push
- **Was:** Benachrichtigung aufs Handy, wenn eine Antwort fertig ist oder eine Erinnerung fällig wird (iOS: nur als Home-Bildschirm-App).
- **Fertig wenn:** Gesperrtes iPhone bekommt „Session X fertig“.

### J4 – Tastenkürzel (Tablet mit Tastatur)
- **Referenz:** `src/main/shortcuts.ts`.
- **Fertig wenn:** Die wichtigsten Kürzel (Senden, Abbrechen, Suche) funktionieren auf dem iPad mit Tastatur.

---

## K. Härtung, Doku, Abnahme

### K1 – Sicherheits-Review
- **Was:** Alle Commands auf Auth + Host-Rechte + Pfadprüfung prüfen, Shell-Quoting aller Benutzereingaben, Rate-Limits, Upload-Limits, keine Secrets in Logs. Eigener Subagent, der den Code vorher nicht gesehen hat.
- **Fertig wenn:** Bericht ohne offene kritische Punkte.

### K2 – Doku
- **Was:** `webapp/README.md` (Setup, SSH-Key, `known_hosts`, NPM inkl. WebSocket-Support, Benutzer, Desktop-Token), `docs/CODEMAP.md` Abschnitt Webapp, neues ADR `0007-webapp.md` (Entscheidungen aus Abschnitt 0).
- **Fertig wenn:** Jemand Fremdes kann die Webapp nur mit dem README aufsetzen.

### K3 – Funktionsvergleich Desktop ↔ Webapp
- **Was:** Checkliste aller Desktop-Funktionen (aus `docs/CODEMAP.md`) mit Status „vorhanden / bewusst weggelassen / fehlt“.
- **Fertig wenn:** Nichts steht auf „fehlt“ außer dem Terminal und den Desktop-Only-Funktionen aus Abschnitt 0.

### K4 – End-to-End-Test auf dem iPhone
- **Was:** Über VPN + NPM: Login, Session fortsetzen, neue Session, Datei hochladen/bearbeiten, Handy sperren während Pi arbeitet, Desktop parallel offen (Lock + Sync).
- **Fertig wenn:** Alle Schritte ohne Fehler; Ergebnisse in `webapp/TESTPROTOKOLL.md`.
