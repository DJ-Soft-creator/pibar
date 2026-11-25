/* ------------------------------------------------------------------ */
/*  PiBar Webapp – kleine Helfer (kein Framework, kein Build)          */
/* ------------------------------------------------------------------ */

/** Farbnamen laut API-Contract -> deutsche Beschriftung. Hex liegt in style.css (--c-*). */
export const COLORS = [
  { name: "red", label: "Rot" },
  { name: "orange", label: "Orange" },
  { name: "yellow", label: "Gelb" },
  { name: "green", label: "Grün" },
  { name: "teal", label: "Türkis" },
  { name: "blue", label: "Blau" },
  { name: "purple", label: "Lila" },
  { name: "pink", label: "Pink" },
];

export const COLOR_NAMES = new Set(COLORS.map((c) => c.name));

export function colorLabel(name) {
  const c = COLORS.find((c) => c.name === name);
  return c ? c.label : "Keine Farbe";
}

/**
 * DOM-Bauer: alle Texte gehen über textContent / Textknoten –
 * niemals wird Nutzer- oder Config-Text als HTML interpretiert.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** "vor 5 Min." – deutsche Relativzeit für den Sync-Status. */
export function relativeTime(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60000) return "gerade eben";
  const min = Math.floor(diff / 60000);
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.floor(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.floor(h / 24);
  if (d < 7) return d === 1 ? "vor 1 Tag" : `vor ${d} Tagen`;
  return new Date(t).toLocaleDateString("de-DE");
}

export function fullTime(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleString("de-DE");
}

/** Session-ID "hostId|/path/to/session.jsonl" in ihre Teile zerlegen. */
export function sessionParts(id) {
  const raw = String(id ?? "");
  const sep = raw.indexOf("|");
  const hostId = sep >= 0 ? raw.slice(0, sep) : "";
  const path = sep >= 0 ? raw.slice(sep + 1) : raw;
  const slash = path.lastIndexOf("/");
  return {
    hostId,
    path,
    dir: slash >= 0 ? path.slice(0, slash) : "",
    file: slash >= 0 ? path.slice(slash + 1) : path,
  };
}

/** localStorage, das auch im Private-Mode nicht wirft. Werte als JSON. */
export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* Speicher nicht verfügbar – dann eben nicht persistieren. */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignorieren */
    }
  },
};