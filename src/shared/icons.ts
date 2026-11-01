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
  edit: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/><path d="M9 4l3 3"/>',
  undo: '<path d="M3 3v3.5h3.5"/><path d="M3 6.5A5.5 5.5 0 1 1 2.5 9"/>',
  redo: '<path d="M13 3v3.5H9.5"/><path d="M13 6.5A5.5 5.5 0 1 0 13.5 9"/>',
  insert: '<path d="M13 3v5a2 2 0 0 1-2 2H4"/><path d="M6.5 7.5L4 10l2.5 2.5"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  folder: '<path d="M1.75 4.25a1 1 0 0 1 1-1h3.4l1.5 1.5h5.6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z"/>',
  file: '<path d="M4 1.75h5l3 3v9.5H4z"/><path d="M9 1.75v3h3"/>',
  up: '<path d="M8 13V3.5M4 7.5l4-4 4 4"/>',
  down: '<path d="M8 3v9.5M4 8.5l4 4 4-4"/>',
  home: '<path d="M2.5 7.5 8 2.5l5.5 5"/><path d="M4 6.5v7h8v-7"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  star: '<path d="M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z"/>',
  branch:
    '<circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="6" r="1.5"/><path d="M5 5v6M11 7.5c0 2.5-3 2.5-5.6 3.6"/>',
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
