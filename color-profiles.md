# Farbprofile für PiBar

Zwei coole Vorschläge für ein durchdachtes Farbschema – jeweils mit Fokus auf **Dunkel**, **Hell**, **Hintergrund** und **Text**.

---

## 🌙 Vorschlag 1: „Midnight & Ember"

Ein dunkles Theme mit warmen, fast organischen Akzenten – wie ein sternenklares Nacht-Himmel-Terminal.

| Rolle | Farbe | Hex | Beschreibung |
|-------|-------|-----|--------------|
| **Hintergrund** | Tiefes Mitternachtsblau | `#0D1117` | Fast schwarz, aber mit blauem Schimmer – verhindert reines Schwarz, wirkt tiefer |
| **Text** | Hellgrau | `#E6EDF3` | Sanft auf dem Hintergrund lesbar, keine harte Weißkante |
| **Dunkel** (Akzent) | Smaragd-Amber | `#58A6FF` | Kühler Blau-Ton für Links/Rechtsmarkierungen, Icons |
| **Hell** (Akzent) | Warmes Ember | `#F0883E` | Warmorange für Hervorhebungen, Buttons, Feedback |

### Nutzung

```css
:root {
  /* Dunkles Profil */
  --color-bg: #0D1117;
  --color-text: #E6EDF3;
  --color-dark: #58A6FF;
  --color-light: #F0883E;
}
```

- **Hintergrund** wird für die gesamte Sidebar, den Chat-Bereich und das Modal verwendet.
- **Text** für alle Text-Elemente (Header, Buttons, Inputs).
- **Dunkel-Akzent** für Links, Icons, Tab-Indikatoren.
- **Hell-Akzent** für aktive Buttons, Hover-Zustände, Warnungen.

### Warum das funktioniert

- Der Kontrast zwischen `#0D1117` und `#E6EDF3` ist hoch genug (~15:1), aber angenehm.
- Das warme Ember (`#F0883E`) bricht die Kälte des Dunkels auf – sieht aus wie flackerndes Licht.
- Der Blau-Ton (`#58A6FF`) wirkt professionell und modern.

---

## ☀️ Vorschlag 2: „Warm Stone"

Ein helles, einladendes Theme mit erdigen Tönen – wie Stein in der Morgensonne.

| Rolle | Farbe | Hex | Beschreibung |
|-------|-------|-----|--------------|
| **Hintergrund** | Warmes Steinbeige | `#F5F0EB` | Sanftes, fast cremefarbenes Weiß – weniger grell als reines Weiß |
| **Text** | Warmes Dunkelbraun | `#3D3226` | Lesbar, warm, nicht wie kaltes Grau |
| **Dunkel** (Akzent) | Terrakotta | `#8B7355` | Erdig, beruhigend – für Icons und Markierungen |
| **Hell** (Akzent) | Honig-Ton | `#D4A574` | Warmes Gold für Hervorhebungen, Links |

### Nutzung

```css
:root {
  /* Helles Profil */
  --color-bg: #F5F0EB;
  --color-text: #3D3226;
  --color-dark: #8B7355;
  --color-light: #D4A574;
}
```

- **Hintergrund** für den gesamten UI-Rahmen (Sidebar, Editor, Modal).
- **Text** für alle Beschriftungen und Inhalte.
- **Dunkel-Akzent** für Icons, Toggle-Buttons, Lade-Indikatoren.
- **Hell-Akzent** für aktive Elemente, Links, Call-to-Action.

### Warum das funktioniert

- Der warme Stein-Ton (`#F5F0EB`) fühlt sich natürlich und beruhigend an – perfekt für langes Lesen.
- Das Dunkelbraun (`#3D3226`) ist ein Text-Farbtupel, das nicht wie „Grau“ wirkt.
- Terrakotta und Honig-Ton erzeugen eine harmonische, erdige Palette ohne Kälte.

---

## Vergleich auf einen Blick

| | **Midnight & Ember** | **Warm Stone** |
|---|---------------------|----------------|
| Stimmung | Modern, kühl-warm | Warm, einladend |
| Ideal für | Terminal-ähnliche UIs, Entwickler-Tools | Text-basierte Apps, Lese-UI |
| Kontrast (Text/Bg) | ~15:1 | ~12:1 |
| Akzent-Farbe | Blau + Orange | Terrakotta + Honig |
| Back-to-back | Dunkel → Hell | Hell → Dunkel |

---

## Empfehlung

- Wähle **Midnight & Ember**, wenn PiBar als „Terminal-Erlebnis" wahrgenommen werden soll – kühl, präzise, modern.
- Wähle **Warm Stone**, wenn der Fokus auf Lesbarkeit und Wohlbefinden liegt – warm, einladend, entspannt.

Beide Profile sind vollständig unabhängig voneinander nutzbar: Du kannst das eine für den Chat-Modus und das andere für den Einstellungs-Modus verwenden.
