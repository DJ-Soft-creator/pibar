// UI translations. English is the source language: t("New session") returns the text in the active
// language. Every key must exist in the German dictionary (TypeScript enforces it via `Msg`).
// Add a language: create a dictionary of type `Record<Msg, string>`, add it to DICTS and LANGUAGES.
// Static HTML is translated with data-i18n / data-i18n-title / data-i18n-placeholder (see translateDom).

const de = {
  // general
  Cancel: "Abbrechen",
  Save: "Speichern",
  Add: "Hinzufügen",
  Create: "Anlegen",
  Remove: "Entfernen",
  Reset: "Zurücksetzen",
  Reload: "Neu laden",
  "Reload all": "Alle neu laden",
  Close: "Schließen",
  Start: "Starten",
  Set: "Setzen",
  Name: "Name",
  Type: "Typ",
  Host: "Host",
  Hosts: "Hosts",
  Local: "Lokal",
  Session: "Session",
  Sessions: "Sessions",
  All: "Alle",
  New: "Neu",
  Current: "Aktuelle",
  Recent: "Zuletzt",
  Settings: "Einstellungen",
  "Settings not saved": "Einstellungen nicht gespeichert",
  General: "Allgemein",
  Language: "Sprache",
  Automatic: "Automatisch",
  "Start failed": "Start fehlgeschlagen",
  optional: "optional",
  Off: "Aus",
  "just now": "gerade eben",
  "{n} min ago": "vor {n} Min.",
  "{n} h ago": "vor {n} Std.",
  "{n} d ago": "vor {n} T.",
  "{n} tok.": "{n} Tok.",
  "{n}k tok.": "{n}k Tok.",

  // header and chat
  "No session": "Keine Session",
  "New session": "Neue Session",
  "New session (⌘N)": "Neue Session (⌘N)",
  "New session on {host}": "Neue Session auf {host}",
  Model: "Modell",
  Models: "Modelle",
  Thinking: "Denken",
  Thoughts: "Gedanken",
  Tools: "Tools",
  "Model of this session": "Modell dieser Session",
  "Thinking level of this session": "Denkaufwand dieser Session",
  "Show/hide tool calls": "Toolaufrufe ein-/ausblenden",
  "Show/hide thinking": "Denken ein-/ausblenden",
  "Tokens / cost of this session": "Tokens / Kosten dieser Session",
  "Show/hide sessions (⌘B)": "Sessions ein-/ausblenden (⌘B)",
  "Show/hide folders and files (⌥⌘B)": "Ordner/Dateien ein-/ausblenden (⌥⌘B)",
  "no model configured": "kein Modell eingerichtet",
  "Welcome to PiBar": "Willkommen bei PiBar",
  "Open a session on the left or start a new one.": "Links eine Session öffnen oder eine neue starten.",
  "Message to Pi …  (Enter to send, Shift+Enter for a new line)":
    "Nachricht an Pi …  (Enter senden, Shift+Enter neue Zeile)",
  Send: "Senden",
  Steer: "Nachsteuern",
  Stop: "Stopp",
  "Loading session …": "Session wird geladen …",
  "Starting new session …": "Neue Session wird gestartet …",
  "Message queued – Pi will see it after the current step.":
    "Nachricht eingereiht – Pi sieht sie nach dem aktuellen Schritt.",
  "Pi has stopped.": "Pi wurde beendet.",
  "Pi could not be started:": "Pi konnte nicht gestartet werden:",
  Reconnect: "Neu verbinden",
  "Screen text": "Bildschirmtext",
  "{n} characters via OCR": "{n} Zeichen per OCR",
  "Error in the response": "Fehler bei der Antwort",
  "Aborted.": "Abgebrochen.",
  Input: "Eingabe",
  Result: "Ergebnis",
  Error: "Fehler",
  done: "fertig",
  "running …": "läuft …",
  "(empty)": "(leer)",
  "({n} characters truncated)": "({n} Zeichen gekürzt)",
  off: "aus",
  minimal: "minimal",
  low: "niedrig",
  medium: "mittel",
  high: "hoch",
  "very high": "sehr hoch",
  max: "max",

  // sessions and reminders
  "This computer": "Dieser Rechner",
  Expand: "Aufklappen",
  Collapse: "Zuklappen",
  "No sessions yet": "Noch keine Sessions",
  "Close session (⌘W)": "Session schließen (⌘W)",
  "Remind me later": "Später erinnern",
  "Change reminder": "Erinnerung ändern",
  Reminders: "Erinnerungen",
  "Remove reminder": "Erinnerung entfernen",
  "Reminder set: {when}": "Erinnerung gesetzt: {when}",
  "Reminder for this session is due.": "Die Erinnerung für diese Session ist fällig.",
  due: "fällig",
  "In 1 hour": "In 1 Stunde",
  "In 3 hours": "In 3 Stunden",
  "This evening (18:00)": "Heute Abend (18:00)",
  "Tomorrow 9:00": "Morgen 9:00",
  "Next Monday 9:00": "Nächsten Montag 9:00",
  "Custom time": "Eigene Zeit",
  Note: "Notiz",
  "Note (optional)": "Notiz (optional)",
  "Working folder": "Arbeitsordner",
  "~/project": "~/projekt",
  "Pi starts in this folder. You can add more folders on the right afterwards.":
    "Pi startet in diesem Ordner. Weitere Ordner kannst du danach rechts hinzufügen.",
  "No host configured": "Kein Host eingerichtet",

  // files
  "Session folders": "Ordner der Session",
  "Add folder": "Ordner hinzufügen",
  "No session open.": "Keine Session geöffnet.",
  "Loading files …": "Lade Dateien …",
  "working folder": "Arbeitsordner",
  "New Markdown file": "Neue Markdown-Datei",
  "Remove folder from session": "Ordner aus Session entfernen",
  "No .md files": "Keine .md-Dateien",
  "~/notes": "~/notizen",
  "Add folder to session": "Ordner zur Session hinzufügen",
  "Folder on the host": "Ordner auf dem Host",
  "Its Markdown files appear on the right and can be edited.":
    "Seine Markdown-Dateien erscheinen rechts und lassen sich bearbeiten.",
  "note.md": "notiz.md",
  "Could not create file (does it exist already?)": "Anlegen fehlgeschlagen (existiert sie schon?)",
  "Read file": "Datei lesen",
  "Discard unsaved changes?": "Ungespeicherte Änderungen verwerfen?",
  "Saved: {file}": "Gespeichert: {file}",
  "Saving failed": "Speichern fehlgeschlagen",
  Edit: "Bearbeiten",
  Preview: "Vorschau",

  // settings
  "Quick launcher": "Quick-Launcher",
  "Double tap": "Doppeltipp",
  "⌥ Option (left or right)": "⌥ Option (links oder rechts)",
  "right ⌥ Option": "rechte ⌥ Option",
  "right ⌘ Command": "rechte ⌘ Command",
  "Double tap is off.": "Doppeltipp ist aus.",
  "Active. Tap the key twice quickly.": "Aktiv. Tipp zweimal schnell auf die Taste.",
  "macOS permission missing: System Settings → Privacy & Security → Input Monitoring → enable Terminal (or PiBar), then restart PiBar.":
    "macOS-Recht fehlt: Systemeinstellungen → Datenschutz & Sicherheit → Eingabeüberwachung → Terminal (bzw. PiBar) einschalten, dann PiBar neu starten.",
  "Double tap is only available on macOS.": "Doppeltipp gibt es nur auf macOS.",
  "Double tap could not be started.": "Doppeltipp ließ sich nicht starten.",
  "Keyboard shortcut": "Tastenkürzel",
  "Examples: Alt+Shift+Space, CommandOrControl+Shift+K, Control+Alt+P. Alt = ⌥ Option.":
    "Beispiele: Alt+Shift+Space, CommandOrControl+Shift+K, Control+Alt+P. Alt = ⌥ Option.",
  "Bar position": "Position der Leiste",
  "Position reset": "Position zurückgesetzt",
  "The bar remembers where you drag it.": "Die Leiste merkt sich, wohin du sie ziehst.",
  "SSH uses your ~/.ssh/config and ssh-agent. Login must work without a password prompt (key).":
    "SSH nutzt deine ~/.ssh/config und den ssh-agent. Die Anmeldung muss ohne Passwortabfrage klappen (Schlüssel).",
  "+ Add host": "+ Host hinzufügen",
  "Testing … (saves first)": "Teste … (speichert vorher)",
  "Connected. Pi version: {v}": "Verbunden. Pi-Version: {v}",
  "(unnamed)": "(ohne Namen)",
  "Test connection": "Verbindung testen",
  "SSH host / alias": "SSH-Host / Alias",
  "my-server (from ~/.ssh/config)": "mein-server (aus ~/.ssh/config)",
  User: "Benutzer",
  Port: "Port",
  "Pi command": "Pi-Befehl",
  "Default folder": "Standard-Ordner",
  "Use herdr": "herdr nutzen",
  "(prepared, no function yet)": "(vorbereitet, noch ohne Funktion)",

  // quick bar
  "What should Pi do?": "Was soll Pi tun?",
  "Screenshot: drag an area (⌘⇧2) · ⇧-click: whole screen":
    "Screenshot: Bereich ziehen (⌘⇧2) · ⇧-Klick: ganzer Bildschirm",
  "Where does the message go?": "Wohin geht die Nachricht?",
  "Send (Enter)": "Senden (Enter)",
  Image: "Bild",
  "Text (OCR)": "Text (OCR)",
  Both: "Beides",
  "Send the screenshot as an image": "Screenshot als Bild an Pi",
  "Send only the recognised text": "Nur den erkannten Text an Pi",
  "Image and recognised text": "Bild und erkannten Text",
  "Remove screenshot": "Screenshot entfernen",
  "Drag at π or the edge to move": "Am π oder am Rand ziehen zum Verschieben",
  "Enter send · ⇧Enter new line · Esc close · ⌘⇧2 screenshot":
    "Enter senden · ⇧Enter Zeile · Esc schließen · ⌘⇧2 Screenshot",
  "Thinking level": "Denkaufwand",
  "Model: default": "Modell: Standard",
  "Thinking: default": "Denken: Standard",
  "Loading models …": "Modelle laden …",
  "Recent sessions": "Letzte Sessions",
  "Recognising text … (takes longer the first time)": "Text wird erkannt … (beim ersten Mal etwas länger)",
  "{n} characters recognised": "{n} Zeichen erkannt",
  "No text recognised": "Kein Text erkannt",
  "OCR failed": "OCR fehlgeschlagen",
  "The image goes to Pi (the model must support images).": "Das Bild geht an Pi (Modell muss Bilder können).",
  "Have a look at the screenshot.": "Schau dir den Screenshot an.",
} as const;

export type Msg = keyof typeof de;
export type Lang = "en" | "de";

const DICTS: Record<Lang, Partial<Record<Msg, string>>> = { en: {}, de };

/** Choices for the language setting: value and label (labels are shown in their own language) */
export const LANGUAGES: [string, string][] = [
  ["auto", "Automatic"],
  ["en", "English"],
  ["de", "Deutsch"],
];

let lang: Lang = "en";

/** "auto" follows the system language; unknown languages fall back to English */
export function resolveLang(pref?: string): Lang {
  if (pref === "de" || pref === "en") return pref;
  const sys = typeof navigator !== "undefined" ? navigator.language : "en";
  return sys.toLowerCase().startsWith("de") ? "de" : "en";
}

export function setLang(pref?: string) {
  lang = resolveLang(pref);
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

export function getLang(): Lang {
  return lang;
}

/** Translate a message; {name} placeholders are replaced from `vars` */
export function t(msg: Msg, vars?: Record<string, string | number>): string {
  let s: string = DICTS[lang][msg] ?? msg;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Translate static HTML: data-i18n (text), data-i18n-title, data-i18n-placeholder */
export function translateDom(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n as Msg)));
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle as Msg)));
  root
    .querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")
    .forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder as Msg)));
}

/** For tests: all keys and the German dictionary */
export const _dicts = { de };
