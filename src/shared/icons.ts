// Line icons (SVG, currentColor) for both windows – no emoji in the UI.
const svg = (body: string, size = 14) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const PATHS = {
  /** reminder (set) */
  clock: '<circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5v3l2 1.5"/>',
  /** reminder due */
  bell: '<path d="M4 11.5V7.5a4 4 0 0 1 8 0v4l1 1H3z"/><path d="M6.5 14a1.6 1.6 0 0 0 3 0"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/><circle cx="8" cy="8" r="4.6"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  more: '<circle cx="3.5" cy="8" r="0.6"/><circle cx="8" cy="8" r="0.6"/><circle cx="12.5" cy="8" r="0.6"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** SVG markup of an icon */
export function iconSvg(name: IconName, size = 14): string {
  return svg(PATHS[name], size);
}

/** Inline element with an icon, for h(...) children */
export function icon(name: IconName, size = 14, cls = "ic"): HTMLElement {
  const el = document.createElement("span");
  el.className = cls;
  el.innerHTML = iconSvg(name, size);
  return el;
}
