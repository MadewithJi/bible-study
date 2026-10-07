// SF-Symbols-like icon set: 24px grid, 1.5px strokes, round caps and joins.
// Single source of truth for every icon in the app. Importing this module injects the
// <svg id="icon-sprite"> sprite into <body>, so `<use href="#i-NAME">` resolves everywhere
// (index.html references the symbols directly; JS templates use icon()).

export const ICONS = {
  books: '<rect x="3.5" y="4" width="4" height="16" rx="1"/><rect x="9.5" y="6.5" width="4" height="13.5" rx="1"/><path d="M15.4 7.9l3.2-.86 3.35 12.5-3.2.86z"/><path d="M3.5 8h4M9.5 10h4"/>',
  'chev-down': '<path d="M5 9l7 7 7-7"/>',
  'chev-left': '<path d="M15 5l-7 7 7 7"/>',
  'chev-right': '<path d="M9 5l7 7-7 7"/>',
  back: '<path d="M8.5 13.5L4 9l4.5-4.5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H10"/>',
  fwd: '<path d="M15.5 13.5L20 9l-4.5-4.5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.4 15.4L20 20"/>',
  alpha: '<path d="M2.5 18.5L7 5.5l4.5 13M4.1 14h5.8"/><path d="M20.8 10.2c-.5 4-1.9 8.3-4.3 8.3-1.7 0-2.7-1.4-2.7-3.3 0-2.3 1.4-4.2 3.2-4.2 2.4 0 2.9 3.3 3.9 5.9.3.9.8 1.5 1.5 1.5"/>',
  arcs: '<path d="M3 18.5h18"/><path d="M4.5 18.5a7.5 7.5 0 0115 0"/><path d="M9 18.5a3 3 0 016 0"/>',
  graph: '<circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="6.5" r="2.5"/><circle cx="12.5" cy="18" r="2.5"/><path d="M8.5 7l7-.4M7.1 9.3l4.3 6.4M17 8.9l-3.5 6.9"/>',
  map: '<path d="M9 4.5L3.5 6.5v13l5.5-2 6 2 5.5-2v-13l-5.5 2z"/><path d="M9 4.5v13M15 6.5v13"/>',
  sidebar: '<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><path d="M14.5 4.5v15M17 8.5h1.5M17 11.5h1.5"/>',
  gear: '<path d="M18.88 9.87L21.02 10.17 21.02 13.83 18.88 14.13 18.37 15.36 19.67 17.08 17.08 19.67 15.36 18.37 14.13 18.88 13.83 21.02 10.17 21.02 9.87 18.88 8.64 18.37 6.92 19.67 4.33 17.08 5.63 15.36 5.12 14.13 2.98 13.83 2.98 10.17 5.12 9.87 5.63 8.64 4.33 6.92 6.92 4.33 8.64 5.63 9.87 5.12 10.17 2.98 13.83 2.98 14.13 5.12 15.36 5.63 17.08 4.33 19.67 6.92 18.37 8.64Z"/><circle cx="12" cy="12" r="3"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 014.9.6c0 1.7-2.5 2.1-2.5 3.8"/><path d="M12 17.1v.01" stroke-width="2.2"/>',
  xmark: '<path d="M6 6l12 12M18 6L6 18"/>',
  link: '<path d="M10 14a4.5 4.5 0 006.4 0l3-3a4.5 4.5 0 00-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 00-6.4 0l-3 3a4.5 4.5 0 006.4 6.4l1-1"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  people: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="16.6" cy="9" r="2.6"/><path d="M16.2 14.1c2.3.2 3.9 1.8 4.4 4.4"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11.2a6.5 6.5 0 0113 0C18.5 15.4 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.3"/>',
  book: '<path d="M12 6.8C10.4 5.4 8 4.8 4 4.8v13.4c4 0 6.4.6 8 2 1.6-1.4 4-2 8-2V4.8c-4 0-6.4.6-8 2z"/><path d="M12 6.8v13.4"/>',
  note: '<path d="M11 4.5H7a3 3 0 00-3 3v9.5a3 3 0 003 3h9.5a3 3 0 003-3V13"/><path d="M17.8 3.9a1.9 1.9 0 012.7 2.7l-8 8-3.5.9.9-3.5z"/>',
  'play-rect': '<rect x="3" y="5" width="18" height="14" rx="3.5"/><path d="M10.3 9.4v5.2l4.4-2.6z"/>',
  play: '<path d="M7 4.8v14.4a1 1 0 001.5.86l12-7.2a1 1 0 000-1.72l-12-7.2A1 1 0 007 4.8z"/>',
  tag: '<path d="M3.8 12.6V4.8a1 1 0 011-1h7.8l7.6 7.6a1.4 1.4 0 010 2l-6.2 6.2a1.4 1.4 0 01-2 0z"/><path d="M8.3 8.3v.01" stroke-width="2.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  ellipsis: '<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="2.4"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V4.8a1 1 0 011-1h3a1 1 0 011 1v1.7M6.5 6.5l.8 12.2a1.5 1.5 0 001.5 1.3h6.4a1.5 1.5 0 001.5-1.3l.8-12.2"/>',
  external: '<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v3.5a2.5 2.5 0 01-2.5 2.5h-9A2.5 2.5 0 014 17.5v-9A2.5 2.5 0 016.5 6H10"/>',
  export: '<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M8.5 10.5H7a2.5 2.5 0 00-2.5 2.5v5A2.5 2.5 0 007 20.5h10a2.5 2.5 0 002.5-2.5v-5a2.5 2.5 0 00-2.5-2.5h-1.5"/>',
  import: '<path d="M12 3.5v11M8 10.5l4 4 4-4"/><path d="M8.5 7.5H7A2.5 2.5 0 004.5 10v8A2.5 2.5 0 007 20.5h10a2.5 2.5 0 002.5-2.5v-8A2.5 2.5 0 0017 7.5h-1.5"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  'arrow-left': '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  columns: '<rect x="3.5" y="4.5" width="17" height="15" rx="3.5"/><path d="M12 4.5v15"/>',
  slash: '<circle cx="12" cy="12" r="7"/><path d="M7 17L17 7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.5 5.5l1.5 1.5M17 17l1.5 1.5M5.5 18.5L7 17M17 7l1.5-1.5"/>',
  moon: '<path d="M19.6 14.6A7.8 7.8 0 019.4 4.4a7.8 7.8 0 1010.2 10.2z"/>',
  light: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3v2.6M12 18.4V21M3 12h2.6M18.4 12H21M5.6 5.6l1.85 1.85M16.55 16.55l1.85 1.85M5.6 18.4l1.85-1.85M16.55 7.45l1.85-1.85"/>',
  sparkle: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 16v4M16.5 18h4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.6v.01" stroke-width="2.2"/>',
  route: '<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18H15a3 3 0 000-6H9a3 3 0 010-6h6.8"/>',
  // profiles, bookmarks, library (profiles-spec §5.4)
  bookmark: '<path d="M7.5 3.5h9A1.5 1.5 0 0118 5v15.1a.6.6 0 01-.95.49L12 17l-5.05 3.59A.6.6 0 016 20.1V5a1.5 1.5 0 011.5-1.5z"/>',
  library: '<path d="M5.5 6.5a2 2 0 012-2h10v15.5h-10a2 2 0 01-2-2z"/><path d="M5.5 18a2 2 0 012-2h10"/><path d="M10 4.5v6.3l2-1.5 2 1.5V4.5"/>',
  person: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="9.8" r="3.1"/><path d="M6.3 18.2c1.4-2 3.3-3 5.7-3s4.3 1 5.7 3"/>',
  signout: '<path d="M13.5 4.5H7A2.5 2.5 0 004.5 7v10A2.5 2.5 0 007 19.5h6.5"/><path d="M10 12h10M16.5 8.5L20 12l-3.5 3.5"/>',
  flame: '<path d="M12 20.5c-3.6 0-6-2.4-6-5.7 0-2.6 1.5-4.4 2.9-6.1.4 1.3 1.1 2.2 2.1 2.6 0-3 1.3-5.5 3.5-7.3.3 2.8 1.6 4.4 2.7 5.9 1 1.3 1.8 2.8 1.8 4.9 0 3.3-3.1 5.7-7 5.7z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-slash': '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5v-3a3.5 3.5 0 017 0v3"/>',
  // Doré engravings (art panel, viewer)
  photo: '<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><circle cx="8.6" cy="9.4" r="1.7"/><path d="M3.4 17.2l4.9-4.5a1.3 1.3 0 011.75 0l2.45 2.25"/><path d="M10.9 16.6l4-3.9a1.3 1.3 0 011.8 0l3.9 3.75"/>',
  'zoom-in': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.4 15.4L20 20M10.5 7.9v5.2M7.9 10.5h5.2"/>',
  'zoom-out': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.4 15.4L20 20M7.9 10.5h5.2"/>',
  // My links (links-spec §3.8): two verses joined by a curve; swap exchanges a link's ends
  'link-node': '<circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="7" r="2.5"/><path d="M8.2 15.8c3.3-1.3 4.3-6.3 7.6-7.6"/>',
  swap: '<path d="M4.5 8.5h14M15 5l3.5 3.5L15 12"/><path d="M19.5 15.5h-14M9 12l-3.5 3.5L9 19"/>',
};

/** Markup for one icon. Filled variant: icon('play', 'f'). */
export function icon(name, cls = '') {
  return `<svg class="i${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

/** Inject the <symbol> sprite once. Safe to call repeatedly. */
export function mountIconSprite() {
  if (typeof document === 'undefined' || document.getElementById('icon-sprite')) return;
  const host = document.body || document.documentElement;
  const symbols = Object.entries(ICONS).map(([n, inner]) => `<symbol id="i-${n}" viewBox="0 0 24 24">${inner}</symbol>`).join('');
  host.insertAdjacentHTML('beforeend', `<svg id="icon-sprite" width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${symbols}</defs></svg>`);
}

/**
 * Hydrate: make sure the sprite exists, then replace any `<i data-icon="name" data-icon-class="…">`
 * placeholders under `root` with real icons. index.html does not need placeholders (it uses
 * <use href="#i-…"> directly); this is only a convenience for markup built elsewhere.
 */
export function hydrate(root = document) {
  mountIconSprite();
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll('[data-icon]').forEach(el => {
    el.outerHTML = icon(el.dataset.icon, el.dataset.iconClass || '');
  });
}

// Side effect on import: module scripts run after parsing, so <body> exists.
mountIconSprite();
