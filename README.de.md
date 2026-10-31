# PiBar

Desktop-Oberfläche für den [Pi Coding Agent](https://pi.dev): Sessions links, Chat in der Mitte, Markdown-Dateien
rechts, dazu eine Quick-Leiste, die man von überall per Doppeltipp öffnet.
Gebaut mit Tauri 2 (Rust-Kern + Web-Oberfläche), läuft auf macOS, Linux und Windows.

[English](README.md) · [Mitarbeiten (englisch)](CONTRIBUTING.md) · [Codemap](docs/CODEMAP.md) · MIT-Lizenz

> Stand: Prototyp. Hauptziel ist macOS; Linux und Windows bauen, Doppeltipp, Bereichs-Screenshot und OCR gibt es bisher
> nur auf macOS.

## Funktionen

- Chat mit Pi, live gestreamt, Markdown und Code-Hervorhebung
- Modell und Denkaufwand wählen (Pi speichert beides pro Session)
- Toolaufrufe und Denken als einklappbare Karten, oben ausblendbar
- Stoppen und Nachsteuern, während Pi arbeitet
- Sessions links, nach Host gruppiert: starten, öffnen, Verlauf laden, mehrere parallel
- **Sessions schließen** (× beim Überfahren oder ⌘W); der Pi-Prozess endet, die Session-Datei bleibt
- **Erinnerungen**: ⏰ an einer Session → in 1 Std., 3 Std., heute Abend, morgen, nächste Woche oder eigene Zeit, mit
  Notiz. Fällige Erinnerungen stehen oben links und kommen als Systemmitteilung; ein Klick öffnet die Session wieder
- Hosts: lokal und per SSH (nutzt `~/.ssh/config` und den ssh-agent)
- Rechts: Ordner der Session; `.md`-Dateien anlegen, lesen, bearbeiten, Vorschau, speichern (⌘S)
- Tokens und Kosten je Session in der Kopfzeile
- Seitenleisten einklappbar: Buttons in der Kopfzeile, ⌘B (links), ⌥⌘B (rechts)
- Host-Umschalter oben links: „Alle / Lokal / weitere Hosts“; Hosts in „Alle“ zuklappbar
- **Quick-Leiste**: Doppeltipp ⌥⌥ (macOS, Taste wählbar) oder ⌥⇧Leertaste (änderbar unter ⚙), schwebende Leiste
  - Ziel: aktuelle Session, neue Session auf einem Host oder eine der letzten Sessions
  - Modell und Denkaufwand, minimalistisch
  - Screenshot: Kamera-Symbol oder ⌘⇧2 = Bereich ziehen, ⇧-Klick = ganzer Bildschirm
  - Screenshot als **Bild**, als **Text (OCR)** oder **beides** senden
  - Verschiebbar; die Position wird gemerkt
- Menüleisten-Symbol: PiBar öffnen, Quick-Leiste, Beenden. Fenster schließen = ausblenden, der Hotkey bleibt aktiv
- **Sprachen**: Englisch und Deutsch, automatisch nach Systemsprache oder fest unter ⚙

Noch nicht drin: Kurzantwort direkt in der Leiste, J-Tracker, herdr.

### macOS-Rechte für die Quick-Leiste

- **Bildschirmaufnahme**: macOS fragt beim ersten Screenshot. Im Entwicklungsmodus gilt die Freigabe für das Terminal,
  aus dem du `npm run dev:app` startest. Systemeinstellungen → Datenschutz & Sicherheit → Bildschirmaufnahme.
- **Eingabeüberwachung** (für den Doppeltipp): macOS fragt beim ersten Start. Im Entwicklungsmodus gilt sie für das
  Terminal. Systemeinstellungen → Datenschutz & Sicherheit → Eingabeüberwachung. Danach PiBar neu starten.
- **OCR** nutzt Apples Texterkennung (Vision). Beim ersten Mal baut PiBar dafür ein kleines Hilfsprogramm mit den
  Xcode-Werkzeugen, einmalig 20–40 Sekunden.

## Einmalig einrichten (macOS)

```bash
# 1. Xcode Command Line Tools (vollständiges Xcode ist nicht nötig)
xcode-select --install

# 2. Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 3. Node.js 20+ (z.B. von nodejs.org oder: brew install node)

# 4. Pi
npm install -g @earendil-works/pi-coding-agent
pi            # einmal starten und Anbieter/API-Key einrichten
```

Für einen Server per SSH (Beispiel-Alias `mein-server` in `~/.ssh/config`): Pi dort genauso installieren und
einrichten. Dann prüfen, dass SSH ohne Passwortabfrage klappt:

```bash
ssh mein-server pi --version
```

## Starten

```bash
git clone https://github.com/DJ-Soft-creator/pibar.git
cd pibar
npm install
npm run dev:app
```

Der erste Start kompiliert den Rust-Teil und dauert ein paar Minuten, danach geht es schnell.

Fertige App bauen (`.app` und `.dmg` unter `src-tauri/target/release/bundle/`):

```bash
npm run tauri build
```

## Hosts einstellen

Zahnrad oben rechts. Vorbelegt ist „Lokal“; weitere mit „+ Host hinzufügen“ (Typ SSH, Alias aus `~/.ssh/config`).

| Feld | Bedeutung |
| --- | --- |
| SSH-Host / Alias | Eintrag aus `~/.ssh/config` oder Hostname |
| Pi-Befehl | Standard `pi`. Falls Pi nicht gefunden wird: vollen Pfad eintragen, z.B. `/opt/homebrew/bin/pi` |
| Standard-Ordner | Vorauswahl für neue Sessions |

„Verbindung testen“ zeigt die Pi-Version des Hosts.

## Ohne API-Key testen

`dev/fake-pi.mjs` simuliert Pi (Streaming, Denken, Toolaufruf, Modellliste). Als Pi-Befehl eines Hosts eintragen:

```
node /voller/pfad/zu/pibar/dev/fake-pi.mjs
```

## Lizenz

[MIT](https://github.com/DJ-Soft-creator/pibar/blob/main/LICENSE)
