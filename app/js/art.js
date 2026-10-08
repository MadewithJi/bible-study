// Doré engravings (Gustave Doré, 1866 · public domain via Wikimedia Commons): plates in the reading
// flow (a figure right before the verse where the depicted scene begins, like an illustrated Bible),
// verse badges with a hover/focus preview, a floating card while the depicted verses are on screen
// but their plate has scrolled away, the drawer's “In art” section, a full-screen viewer and the
// gallery stage panel ('art'). The chapter hero carries no art: it looks the same on every chapter.
// Data: data/art.json + data/art/<id>-s.jpg (small, shown first) and <id>.jpg (large: the viewer,
// and inline plates on wide or high-density screens once the small one is in).
import { state, esc, bookOf, refLabel, smart, lsGet, lsSet, DRY, RM, hostedMsg } from './store.js';
import { icon } from './icons.js';

const DATA_URL = new URL('../data/art.json', import.meta.url).href;
const IMG_DIR = new URL('../data/art/', import.meta.url).href;
const SHORT_CREDIT = 'Gustave Doré, 1866';
const LS_PLATES = 'bs-art-inline';              // “Show Doré engravings in the text” (plates + floating card)
const SS_DISMISS = 'bs-art-float-dismissed';

let A = null;                                   // store actions (navigate, select, flash, toast, showPanel, …)
let loadP = null, loaded = false;
let PLATES = [];                                // canonical order
let BY_ID = new Map();
let CH = new Map();                             // "b.c" -> [{ p, b, c, primary, ranges:[[v1,v2]…], first, badgeV }]
let BADGES = new Map();                         // "b.c" -> Map(v -> entries)
let SLOTS = new Map();                          // "b.c" -> [{ v, full, items: [entries] }] (inline plates, by verse)
let CREDIT = 'Gustave Doré (1832–1883), engravings for La Grande Bible de Tours, 1866 · Public domain · via Wikimedia Commons';

// Private glyphs in the icon set's style (24 grid, 1.5 strokes); everything else comes from icons.js.
const PATHS = {
  minus: '<path d="M5 12h14"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.8"/><rect x="13" y="4" width="7" height="7" rx="1.8"/><rect x="4" y="13" width="7" height="7" rx="1.8"/><rect x="13" y="13" width="7" height="7" rx="1.8"/>',
  expand: '<path d="M14.5 4.5h5v5M9.5 19.5h-5v-5M19.5 4.5l-5.5 5.5M4.5 19.5l5.5-5.5"/>',
};
const svg = (n, cls = '') => `<svg class="i${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[n]}</svg>`;

// ------------------------------------------------------------ small helpers
const T = s => smart(String(s ?? '').trim());                // curly quotes for data strings (before esc)
const imgUrl = (p, large = false) => `${IMG_DIR}${p.id}${large ? '' : '-s'}.jpg`;
const arOf = p => (p.w / p.h).toFixed(4);
const isWide = p => p.w / p.h > 1.05;
// title + scene, ending in one full stop (a scene may already end in one, or in “…It is I.”)
const altOf = p => { const s = T(p.scene); return T(p.title) + (s ? `. ${s}${/[.!?…]["'”’]?$/.test(s) ? '' : '.'}` : ''); };
const bookName = b => bookOf(b)?.name || `Book ${b}`;
const testament = b => (b <= 39 ? 'ot' : 'nt');
const keyOf = (b, c) => `${b}.${c}`;
const inRanges = (rs, v) => rs.some(([a, z]) => v >= a && v <= z);
const later = fn => (window.requestIdleCallback || (f => setTimeout(f, 200)))(fn);

function mergeRanges(rs) {
  const s = rs.map(r => [r[0], Math.max(r[0], r[1])]).sort((a, z) => a[0] - z[0]);
  const out = [];
  for (const r of s) { const l = out[out.length - 1]; if (l && r[0] <= l[1] + 1) l[1] = Math.max(l[1], r[1]); else out.push([r[0], r[1]]); }
  return out;
}
const spanText = rs => mergeRanges(rs).map(([a, z]) => (z > a ? `${a}–${z}` : `${a}`)).join(', ');
const passageLabel = (b, c, rs) => `${bookName(b)} ${c}:${spanText(rs)}`;
function versesOf(rs) { const out = []; mergeRanges(rs).forEach(([a, z]) => { for (let v = a; v <= z; v++) out.push(v); }); return out; }
const encRanges = rs => mergeRanges(rs).map(([a, z]) => `${a}-${z}`).join(',');
const decRanges = s => String(s || '').split(',').map(x => x.split('-').map(Number)).filter(r => r[0] > 0).map(r => [r[0], Math.max(r[0], r[1] || r[0])]);

// ------------------------------------------------------------ data
const okRef = r => Array.isArray(r) && r.length >= 4 && r.slice(0, 4).every(n => Number.isInteger(n) && n > 0) && r[0] <= 66;
const okPlate = p => p && typeof p.id === 'string' && /^[A-Za-z0-9_-]+$/.test(p.id) && okRef(p.ref) && +p.w > 0 && +p.h > 0;

function build(j) {
  const list = (j && Array.isArray(j.plates) ? j.plates : []).filter(okPlate);
  if (j && typeof j.credit === 'string' && j.credit.trim()) CREDIT = j.credit.trim();
  PLATES = list; BY_ID = new Map(); CH = new Map(); BADGES = new Map(); SLOTS = new Map();
  list.forEach((p, i) => {
    p._i = i;
    if (!(+p.sw > 0 && +p.sh > 0)) { const k = 560 / Math.max(p.w, p.h); p.sw = Math.round(p.w * k); p.sh = Math.round(p.h * k); }
    p.also = Array.isArray(p.also) ? p.also.filter(okRef) : [];
    BY_ID.set(p.id, p);
    const per = new Map();
    [p.ref, ...p.also].forEach((r, k) => {
      const key = keyOf(r[0], r[1]);
      let e = per.get(key);
      if (!e) per.set(key, (e = { p, b: r[0], c: r[1], primary: false, ranges: [] }));
      if (k === 0) e.primary = true;
      e.ranges.push([r[2], Math.max(r[2], r[3])]);
    });
    per.forEach((e, key) => {
      e.first = Math.min(...e.ranges.map(x => x[0]));
      e.badgeV = e.first;   // the earliest verse it depicts in this chapter (primary ref or an “also” range here)
      if (!CH.has(key)) CH.set(key, []);
      CH.get(key).push(e);
    });
  });
  CH.forEach(l => l.sort((a, z) => (z.primary - a.primary) || (a.first - z.first) || (a.p._i - z.p._i)));
  loaded = true;
}

/** Fetch data/art.json once and index it. Never throws; a failed fetch can be retried by the next call. */
export function load() {
  if (loaded) return Promise.resolve();
  if (!loadP) {
    loadP = fetch(DATA_URL)
      .then(r => { if (!r.ok) throw new Error(`${r.status} art.json`); return r.json(); })
      .then(build)
      .catch(e => { console.warn('art: could not load engravings', e); loadP = null; });
  }
  return loadP;
}
export const isLoaded = () => loaded;
export const plates = () => PLATES;
export const plate = id => BY_ID.get(id) || null;

const entriesFor = (b, c) => CH.get(keyOf(b, c)) || [];
/** The chapter's plates in narrative order (by first verse), for the sheet list. */
const byVerse = list => [...list].sort((a, z) => (a.first - z.first) || (a.p._i - z.p._i));
/** Plates whose primary ref or any “also” range lies in this chapter (primary first, then by verse). */
export function forChapter(b, c) { return entriesFor(+b, +c).map(e => e.p); }
export function forVerse(b, c, v) { v = +v; return v ? entriesFor(+b, +c).filter(e => inRanges(e.ranges, v)).map(e => e.p) : []; }
function badgeMap(b, c) {
  const key = keyOf(b, c);
  if (!BADGES.has(key)) {
    const m = new Map();
    entriesFor(b, c).forEach(e => { if (!m.has(e.badgeV)) m.set(e.badgeV, []); m.get(e.badgeV).push(e); });
    BADGES.set(key, m);
  }
  return BADGES.get(key);
}
/**
 * Where the chapter's plates sit in the text. A plate made for this passage (its primary ref) gets a
 * full figure right before the verse where its scene begins, one figure per verse (several plates
 * starting at the same verse share it, with a switcher). A plate made for a parallel passage elsewhere
 * (an “also” range here) gets a compact figure, unless another figure starts at most 3 verses before it:
 * it then joins that figure's switcher (no clutter of figures a verse apart). A compact figure with a
 * full one at most 2 verses after it becomes that full figure, moved up to the compact one's verse, so
 * every plate in it still comes before the text it depicts. Likewise a full figure whose scene begins
 * on the very next verse after another figure's joins that one (never two screen-tall plates around a
 * single verse). A plate whose primary ref and “also” ranges both fall in this chapter appears once.
 */
function slotsFor(b, c) {
  const key = keyOf(b, c);
  if (SLOTS.has(key)) return SLOTS.get(key);
  const at = new Map();
  entriesFor(b, c).forEach(e => {
    const v = e.first;   // before the verse where its scene begins here, even when an “also” range here starts earlier
    if (!at.has(v)) at.set(v, []);
    at.get(v).push(e);
  });
  const out = [];
  [...at.keys()].sort((x, z) => x - z).forEach(v => {
    const items = at.get(v).sort((x, z) => (z.primary - x.primary) || (x.p._i - z.p._i));
    const full = items.some(e => e.primary), prev = out[out.length - 1];
    if (prev && v - prev.v <= (full ? (prev.full ? 1 : 0) : 3)) prev.items.push(...items);
    else out.push({ v, full, items });
  });
  for (let i = out.length - 2; i >= 0; i--) {
    const s = out[i], n = out[i + 1];
    // the pair sits at the earlier verse (never after a scene): the full plates lead, then the compact ones
    if (!s.full && n.full && n.v - s.v <= 2) { out.splice(i, 2, { v: s.v, full: true, items: [...n.items, ...s.items] }); }
  }
  SLOTS.set(key, out);
  return out;
}
const slotAt = (b, c, v) => slotsFor(b, c).find(s => s.v === v) || null;

// ------------------------------------------------------------ init + global listeners
let globalsBound = false;
export function init(actions) { A = actions || A; bindGlobals(); load(); }

function bindGlobals() {
  if (globalsBound || typeof document === 'undefined') return;
  globalsBound = true;
  let sizeT = 0;
  addEventListener('resize', () => {
    hidePop(); scheduleFloat();
    clearTimeout(sizeT); sizeT = setTimeout(() => document.querySelectorAll('#reader .art-plate-img').forEach(sharpen), 250);
  }, { passive: true });
  addEventListener('scroll', () => {
    if (!pop || pop.hidden) return;
    if (popFocus && popFor && popFor.isConnected) placePop(pop, popFor); else hidePop();
  }, { passive: true });
  // Esc closes an open preview and nothing else (main.js skips handled keys); it also cancels one about to appear
  document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (popFor) { hidePop(); e.preventDefault(); } else clearTimeout(popT); }, true);
  // the sheet opening/closing changes body classes; side mode then slides the page (padding-right)
  // for ~560 ms: re-check when that slide ends (the timer is only a fallback, e.g. a hidden tab)
  let settleT = 0;
  try { new MutationObserver(() => { scheduleFloat(); clearTimeout(settleT); settleT = setTimeout(scheduleFloat, 620); }).observe(document.body, { attributes: true, attributeFilter: ['class'] }); } catch (e) { /* ignore */ }
  const slid = e => { if (e.propertyName === 'padding-right' && e.target instanceof Element && e.target.id === 'page') scheduleFloat(); };
  document.addEventListener('transitionend', slid, true);
  document.addEventListener('transitioncancel', slid, true);
  try { RM.addEventListener?.('change', scheduleFloat); } catch (e) { /* old Safari */ }
}

// ------------------------------------------------------------ plates in the reading flow
const slotPick = new Map();   // "b.c.v" -> index the reader chose in a figure's switcher (this session)
const revealed = new Set();   // "b.c.v" figures that have already made their entrance
let platesOn = lsGet(LS_PLATES, '1') !== '0';

/** The chapter hero carries no art (it looks the same on every chapter). Kept for older callers: always ''. */
export function heroHtml() { return ''; }

/** “Show Doré engravings in the text”: the inline plates and the floating card (badges and the drawer stay). */
export function platesEnabled() { return platesOn; }
export function setPlates(on) {
  platesOn = !!on; lsSet(LS_PLATES, platesOn ? '1' : '0');
  if (rd && loaded && rd.root.isConnected) { syncPlates(rd); observePlates(rd); }
  scheduleFloat();
}
/** The same switch under its former names (“Show engravings while reading”). */
export const floatingEnabled = platesEnabled;
export const setFloating = setPlates;

const slotKey = (b, c, v) => `${b}.${c}.${v}`;

/** A plate's home passage: its primary ref, with any “also” range in that same chapter. */
function homeOf(p) {
  const [b, c] = p.ref;
  const rs = [[p.ref[2], Math.max(p.ref[2], p.ref[3])], ...p.also.filter(r => r[0] === b && r[1] === c).map(r => [r[2], Math.max(r[2], r[3])])];
  return { b, c, rs };
}

/** The engraving on its paper mat. The box has the plate's proportions before the file arrives (no shift). */
function matHtml(p) {
  return `<div class="art-plate-mat" data-art-open="${p.id}" title="View full screen"><span class="art-plate-imgbox"><img class="art-plate-img" src="${imgUrl(p)}" width="${p.sw}" height="${p.sh}" alt="${esc(altOf(p))}" loading="lazy" decoding="async"></span><span class="art-plate-zoom" aria-hidden="true">${svg('expand')}</span></div>`;
}
/** The caption under the title row: the scene (full figures), the plate's home passage (plates made for a parallel passage), the meta row. */
function capBodyHtml(e, full) {
  const p = e.p, pass = passageLabel(e.b, e.c, e.ranges), h = homeOf(p);
  const also = e.primary ? '' : `<p class="art-plate-also">Also depicted in <button class="art-plate-go" type="button" data-art-go="${h.b}.${h.c}.${encRanges(h.rs)}" title="Go to that passage">${esc(passageLabel(h.b, h.c, h.rs))}</button></p>`;
  return `${full ? `<p class="art-plate-s">${esc(T(p.scene))}</p>` : ''}${also}`
    + `<p class="art-plate-meta"><button class="art-plate-ref" type="button" data-art-range="${e.b}.${e.c}.${encRanges(e.ranges)}" aria-label="${esc(`${pass}: select these verses`)}" title="Select these verses">${esc(pass)}</button>`
    + `<span class="art-plate-dot" aria-hidden="true">·</span><span class="art-plate-credit">${SHORT_CREDIT}</span>`
    + `<button class="art-plate-view" type="button" data-art-open="${p.id}" aria-label="${esc(`View “${T(p.title)}” full screen`)}">${svg('expand')}<span>View</span></button></p>`;
}

/**
 * '' or the figure that goes right before verse v: reader.js calls this for every verse of the chapter.
 * The figure sits in the verses list (role=list), so it is wrapped in a listitem; j/k and the arrow keys
 * move between .verse elements only, and tracker.js only measures .verse elements.
 */
/** A low-resolution scan (dore-227) is never shown larger than its pixels, as the viewer already caps it. */
const capMh = p => (p.lowres ? `;--mh:min(72vh, ${p.h}px)` : '');
export function plateHtml(b, c, v) {
  if (!loaded || !platesOn) return '';
  b = +b; c = +c; v = +v;
  const s = slotAt(b, c, v); if (!s) return '';
  const key = slotKey(b, c, v), n = s.items.length;
  const i = Math.min(n - 1, slotPick.get(key) || 0), e = s.items[i], p = e.p;
  // the entrance needs IntersectionObserver callbacks, which a hidden tab never gets: no entrance there
  const pre = !revealed.has(key) && !RM.matches && typeof IntersectionObserver !== 'undefined' && !document.hidden;
  const tid = `art-t-${b}-${c}-${v}`;
  const sw = n > 1 ? `<div class="art-plate-sw" role="group" aria-label="${esc(`${n} engravings`)}"><button class="art-sw-b" type="button" data-art-step="-1" aria-label="Previous engraving" title="Previous engraving">${icon('chev-left')}</button><span class="art-sw-n" aria-hidden="true">${i + 1} of ${n}</span><button class="art-sw-b" type="button" data-art-step="1" aria-label="Next engraving" title="Next engraving">${icon('chev-right')}</button></div>` : '';
  return `<div class="art-slot${s.full ? '' : ' compact'}${pre ? ' art-pre' : ''}" role="listitem" data-art-slot="${v}" style="--ar:${arOf(p)}${capMh(p)}">`
    + `<figure class="art-plate" aria-labelledby="${tid}">${matHtml(p)}`
    + `<figcaption class="art-plate-cap"><div class="art-plate-head"><p class="art-plate-t" id="${tid}">${esc(T(p.title))}</p>${sw}</div><div class="art-plate-body">${capBodyHtml(e, s.full)}</div></figcaption>`
    + `${n > 1 ? '<span class="sr" aria-live="polite" data-art-live></span>' : ''}</figure></div>`;
}

/** The figure's switcher: show the next or previous of the plates that share it. */
function stepSlot(slot, dir) {
  if (!rd || !slot.isConnected) return;
  const { b, c } = rd, v = +slot.dataset.artSlot, s = slotAt(b, c, v);
  if (!s || s.items.length < 2) return;
  const key = slotKey(b, c, v), n = s.items.length;
  const i = ((((slotPick.get(key) || 0) + dir) % n) + n) % n;
  slotPick.set(key, i);
  const e = s.items[i], p = e.p, fig = slot.querySelector('.art-plate');
  const cnt = fig.querySelector('.art-sw-n'); if (cnt) cnt.textContent = `${i + 1} of ${n}`;
  const apply = () => {
    if (!slot.isConnected || slotPick.get(key) !== i) return;
    slot.style.setProperty('--ar', arOf(p));
    if (p.lowres) slot.style.setProperty('--mh', `min(72vh, ${p.h}px)`); else slot.style.removeProperty('--mh');
    const tmp = document.createElement('div'); tmp.innerHTML = matHtml(p);
    const mat = tmp.firstElementChild;
    fig.querySelector('.art-plate-mat')?.replaceWith(mat);
    watchImg(mat.querySelector('img'));
    fig.querySelector('.art-plate-t').textContent = T(p.title);
    fig.querySelector('.art-plate-body').innerHTML = capBodyHtml(e, s.full);
    const live = fig.querySelector('[data-art-live]'); if (live) live.textContent = `${T(p.title)}. Engraving ${i + 1} of ${n}.`;
    slot.classList.remove('swapping');
    if (!RM.matches) { mat.classList.add('art-swapin'); setTimeout(() => mat.classList.remove('art-swapin'), 600); }
  };
  if (RM.matches) apply();
  else { slot.classList.add('swapping'); setTimeout(apply, 160); }
}

/** Fade an engraving in once it has arrived (the paper-toned box holds its size), then sharpen it if needed. */
function watchImg(img) {
  if (!img || img.dataset.watched) return;
  img.dataset.watched = '1';
  const box = img.closest('.art-plate-imgbox');
  const done = () => { box?.classList.add('ld'); box?.classList.remove('err'); sharpen(img); };
  img.addEventListener('load', done);                  // again when the large file replaces the small one
  img.addEventListener('error', () => {
    if (img.srcset) { img.dataset.small = '1'; img.removeAttribute('srcset'); img.removeAttribute('sizes'); return; }   // the large one failed: keep the small one
    box?.classList.add('ld', 'err');
  });
  if (img.complete && img.naturalWidth) done();
}
/**
 * The small file comes first; where the plate is drawn wider than it (high-density or wide screens)
 * the large one is offered through srcset. The browser keeps showing the small one until the large
 * one has arrived, so the swap never flashes. On resize only `sizes` follows the new width.
 */
function sharpen(img) {
  if (!img || !img.isConnected || img.dataset.small || !(img.complete && img.naturalWidth)) return;
  const p = BY_ID.get(img.closest('[data-art-open]')?.dataset.artOpen || ''); if (!p) return;
  const w = Math.ceil(img.getBoundingClientRect().width); if (w < 2) return;
  if (img.getAttribute('srcset')) { if (img.sizes !== `${w}px`) img.sizes = `${w}px`; return; }
  if (w * (window.devicePixelRatio || 1) <= p.sw * 1.15 || p.w <= p.sw) return;
  img.sizes = `${w}px`;
  img.srcset = `${imgUrl(p)} ${p.sw}w, ${imgUrl(p, true)} ${p.w}w`;
}

/**
 * Keep the verse at the top of the window where it is while figures are added or removed above it.
 * A verse mostly tucked under the top bar has already been read: the next one is held still instead
 * (when it starts in the upper half of the window; otherwise the first is a long verse filling the
 * screen), so a figure that arrives right after it never pushes the text on screen down.
 * The browser's own scroll anchoring is paused meanwhile (it would correct a second time, a frame later).
 */
let anchorT = 0;
function keepReadingPlace(root, fn) {
  let a = null;
  if (window.scrollY > 4) {
    const top = barBottom(), mid = top + (innerHeight - top) / 2;
    // the selected verse (a deep link, a search result) while it is on screen, else the verse at the top
    const sel = state.selected ? root.querySelector(`#v${state.selected}`) : null, sr = sel?.getBoundingClientRect();
    const vs = sr && sr.bottom > top && sr.top < innerHeight ? [] : [...root.querySelectorAll('.verse')];
    if (!vs.length && sr) a = { el: sel, top: sr.top };
    const i = vs.findIndex(el => el.getBoundingClientRect().bottom > top);
    if (i >= 0) {
      let el = vs[i], r = el.getBoundingClientRect();
      const n = vs[i + 1], nr = n?.getBoundingClientRect();
      if (nr && r.top < top && r.bottom - top < 0.6 * r.height && nr.top < mid) { el = n; r = nr; }
      a = { el, top: r.top };
    }
  }
  const html = document.documentElement;
  html.style.overflowAnchor = 'none';
  fn();
  if (a && a.el.isConnected) { const dy = a.el.getBoundingClientRect().top - a.top; if (Math.abs(dy) >= 1) window.scrollBy({ top: dy, behavior: 'auto' }); }
  const t = ++anchorT;
  requestAnimationFrame(() => requestAnimationFrame(() => { if (t === anchorT) html.style.removeProperty('overflow-anchor'); }));
}
/** Add the figures that are missing (art.json arrived after the render, or the switch was turned on), or remove them all (off). */
function syncPlates({ root, b, c }) {
  const vs = root.querySelector('.verses'); if (!vs) return;
  const have = [...vs.querySelectorAll(':scope > .art-slot')];
  const extra = platesOn ? [] : have;
  const missing = platesOn ? slotsFor(b, c).filter(s => !have.some(el => +el.dataset.artSlot === s.v) && vs.querySelector(`:scope > #v${s.v}`)) : [];
  if (!extra.length && !missing.length) return;
  keepReadingPlace(root, () => {
    extra.forEach(el => { if (el.contains(document.activeElement)) el.nextElementSibling?.focus?.({ preventScroll: true }); el.remove(); });
    missing.forEach(s => vs.querySelector(`:scope > #v${s.v}`)?.insertAdjacentHTML('beforebegin', plateHtml(b, c, s.v)));
  });
}

/**
 * Watch the figures: their entrance, and a fresh look at the floating card whenever one comes into
 * view or leaves it (where the figures are is measured when the card decides: see figuresNow).
 */
function observePlates(cur) {
  fl.slotIO?.disconnect(); fl.slotIO = null;
  const slots = [...cur.root.querySelectorAll('.verses > .art-slot')];
  slots.forEach(el => watchImg(el.querySelector('.art-plate-img')));
  if (!slots.length) return;
  if (typeof IntersectionObserver === 'undefined') { slots.forEach(el => el.classList.remove('art-pre')); return; }
  fl.slotIO = new IntersectionObserver(ents => {
    ents.forEach(en => { if (en.isIntersecting && en.intersectionRatio >= 0.05 && en.target.classList.contains('art-pre')) reveal(en.target, cur); });
    scheduleFloat();
  }, { rootMargin: `-${Math.round(barBottom())}px 0px 0px 0px`, threshold: [0, 0.05, 0.25, 0.5, 1] });
  slots.forEach(el => fl.slotIO.observe(el));
}
const barBottom = () => { const bar = document.getElementById('topbar'); return Math.max(0, bar ? bar.getBoundingClientRect().bottom : 0); };
/**
 * The figures as they are on screen now: whether one is in view (a quarter of it or more) and the
 * verses of those scrolled up past the top bar. Measured, not remembered from the observer: it only
 * reports crossings, and a jump (search, Home, a link in the sheet) can carry a figure from below the
 * window to above it without one.
 */
function figuresNow() {
  const out = { inView: false, above: new Set() };
  if (!rd || !rd.root.isConnected) return out;
  const top = barBottom(), H = innerHeight;
  rd.root.querySelectorAll('.verses > .art-slot').forEach(el => {
    const r = el.getBoundingClientRect(); if (!(r.height > 0)) return;
    if (r.bottom <= top + 1) out.above.add(+el.dataset.artSlot);
    else if ((Math.min(r.bottom, H) - Math.max(r.top, top)) / r.height >= 0.25) out.inView = true;
  });
  return out;
}
function reveal(el, cur) {
  if (!el.classList.contains('art-pre') || el.classList.contains('art-in')) return;
  revealed.add(slotKey(cur.b, cur.c, +el.dataset.artSlot));
  el.classList.add('art-in');
  setTimeout(() => el.classList.remove('art-pre', 'art-in'), 1300);
}

// ------------------------------------------------------------ verse badge
/** '' or a thumbnail button for the first verse of each plate's range in this chapter (primary ref first). */
export function verseBadgeHtml(b, c, v) {
  const list = badgeMap(+b, +c).get(+v); if (!list || !list.length) return '';
  const p = list[0].p, more = list.length - 1;
  const label = `Engraving: ${T(p.title)}${more ? ` (and ${more} more)` : ''}`;
  return `<button class="art-badge" type="button" data-art="${p.id}" aria-label="${esc(label)}"><img src="${imgUrl(p)}" width="${p.sw}" height="${p.sh}" alt="" loading="lazy" decoding="async">${more ? `<span class="art-badge-n" aria-hidden="true">${more + 1}</span>` : ''}</button>`;
}

// ------------------------------------------------------------ preview popover (verse badges)
let pop = null, popFor = null, popT = 0, popHideT = 0, popFocus = false;
function ensurePop() {
  if (pop) return pop;
  pop = document.createElement('div');
  pop.className = 'art-pop'; pop.id = 'art-pop'; pop.setAttribute('role', 'tooltip'); pop.hidden = true;
  document.body.appendChild(pop);
  return pop;
}
function showPop(anchor, p, more = 0) {
  if (!anchor || !anchor.isConnected || !p) return;
  const el = ensurePop();
  clearTimeout(popHideT);
  const wide = isWide(p);
  el.innerHTML = `<span class="art-pop-img${wide ? ' wide' : ''}" style="--ar:${arOf(p)}"><img src="${imgUrl(p)}" width="${p.sw}" height="${p.sh}" alt="" decoding="async"></span><span class="art-pop-body"><span class="art-pop-t">${esc(T(p.title))}</span><span class="art-pop-s">${esc(T(p.scene))}</span><span class="art-pop-c">${SHORT_CREDIT}${more ? ` · ${more} more here` : ''}</span></span>`;
  el.hidden = false; el.classList.remove('on');
  placePop(el, anchor);
  if (popFor && popFor !== anchor) popFor.removeAttribute('aria-describedby');
  popFor = anchor; anchor.setAttribute('aria-describedby', 'art-pop');
  requestAnimationFrame(() => { if (popFor === anchor) el.classList.add('on'); });
}
function placePop(el, anchor) {
  el.style.left = '0px'; el.style.top = '0px';
  const r = anchor.getBoundingClientRect(), m = el.getBoundingClientRect();
  const W = innerWidth, H = innerHeight, gap = 10, pad = 8;
  // the badge sits in the verse's right gutter: prefer the margin to its right (left of it is the verse's own text),
  // but not over an open side sheet
  const dr = document.getElementById('drawer')?.getBoundingClientRect();
  const R = dr && dr.width && dr.left > r.right && dr.top < r.bottom && dr.bottom > r.top ? Math.min(W, dr.left) : W;
  const fitsL = r.left - gap - m.width >= pad, fitsR = r.right + gap + m.width <= R - pad;
  const fitsT = r.top - gap - m.height >= pad + 52, fitsB = r.bottom + gap + m.height <= H - pad;
  let x, y, side;
  if (fitsL || fitsR) { side = fitsR ? 'r' : 'l'; x = fitsR ? r.right + gap : r.left - gap - m.width; y = r.top + r.height / 2 - m.height / 2; }
  else { side = fitsT || !fitsB ? 't' : 'b'; y = side === 't' ? r.top - gap - m.height : r.bottom + gap; x = r.left + r.width / 2 - m.width / 2; }
  x = Math.max(pad, Math.min(W - pad - m.width, x)); y = Math.max(pad, Math.min(H - pad - m.height, y));
  el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(y) + 'px'; el.dataset.side = side;
}
function hidePop() {
  clearTimeout(popT);
  if (!pop || pop.hidden) return;
  pop.classList.remove('on');
  if (popFor) popFor.removeAttribute('aria-describedby');
  popFor = null; popFocus = false;
  clearTimeout(popHideT);
  popHideT = setTimeout(() => { if (pop && !pop.classList.contains('on')) pop.hidden = true; }, RM.matches ? 0 : 180);
}
function popTarget(t) { return t instanceof Element ? t.closest('.art-badge[data-art]') : null; }
function popPlate(el) {
  const v = +el.closest('.verse')?.dataset.v; const list = rd && v ? badgeMap(rd.b, rd.c).get(v) : null;
  return { p: BY_ID.get(el.dataset.art), more: list ? list.length - 1 : 0 };
}

// ------------------------------------------------------------ reader wiring
let rd = null;                    // { root, b, c, key, slotV: Map(entry -> verse of its figure) }
const boundRoots = new WeakSet();

/** Called by reader.js after every chapter render: idempotent; replaces the previous observers. */
export function attachReader(root, b, c) {
  root = root || document.getElementById('reader'); if (!root) return;
  bindGlobals();
  b = +b; c = +c;
  teardownReader(!!rd && rd.key === keyOf(b, c));    // same chapter re-rendered: keep the card steady
  const cur = (rd = { root, b, c, key: keyOf(b, c), slotV: new Map() });
  if (!boundRoots.has(root)) {
    boundRoots.add(root);
    root.addEventListener('click', onReaderClick, true);       // capture: before reader.js selects the verse
    root.addEventListener('pointerover', onReaderOver);
    root.addEventListener('pointerout', onReaderOut);
    root.addEventListener('focusin', onReaderFocus);
    root.addEventListener('focusout', onReaderBlur);
    root.addEventListener('keydown', onReaderKey);
    root.addEventListener('error', onImgError, true);
  }
  if (loaded) setupReader(cur);
  else load().then(() => { if (rd === cur && root.isConnected) setupReader(cur); });
}

function setupReader(cur) {
  if (!loaded) return;
  slotsFor(cur.b, cur.c).forEach(s => s.items.forEach(e => cur.slotV.set(e, s.v)));
  patchReader(cur);
  observePlates(cur);
  setupFloat(cur);
}

/** Safety net: if the chapter was rendered before art.json arrived, add the plates and badges in place. */
function patchReader(cur) {
  const { root, b, c } = cur;
  syncPlates(cur);
  badgeMap(b, c).forEach((list, v) => {
    const ve = root.querySelector(`#v${v}`);
    if (!ve || ve.querySelector('.art-badge')) return;
    let meta = ve.querySelector(':scope > .vmeta');
    if (!meta) { ve.querySelector(':scope > .vtext, :scope > .vcols')?.insertAdjacentHTML('afterend', '<span class="vmeta"></span>'); meta = ve.querySelector(':scope > .vmeta'); }
    meta?.insertAdjacentHTML('beforeend', verseBadgeHtml(b, c, v));
  });
}

function teardownReader(keep = false) {
  clearTimeout(popT); hidePop();
  fl.io?.disconnect(); fl.slotIO?.disconnect();
  fl.io = fl.slotIO = null;
  rd = null;
  if (keep) return;                  // the new observers report the same verses and figures on their first callback
  fl.vis = new Set(); fl.cur = null;
  scheduleFloat();
}

function onReaderClick(e) {
  const t = e.target instanceof Element ? e.target : null; if (!t) return;
  const badge = t.closest('.art-badge[data-art]');
  const slot = t.closest('.art-slot');
  const open = slot && t.closest('[data-art-open]');
  const step = slot && t.closest('[data-art-step]');
  const rng = slot && t.closest('[data-art-range]');
  const go = slot && t.closest('[data-art-go]');
  if (!(badge || open || step || rng || go)) return;
  e.stopPropagation(); e.preventDefault();
  hidePop();
  if (badge) {
    const vv = +badge.closest('.verse')?.dataset.v, list = rd && vv ? badgeMap(rd.b, rd.c).get(vv) : null;
    openViewer(badge.dataset.art, { returnFocus: badge, group: list && list.length > 1 ? list.map(e => e.p.id) : null });
  }
  else if (open) {
    // the image itself is not focusable (its caption's View button is): hand the focus back to that button
    const back = open.matches('button') ? open : slot.querySelector('.art-plate-view');
    openViewer(open.dataset.artOpen, { returnFocus: back });
  } else if (step) stepSlot(slot, +step.dataset.artStep || 1);
  else if (rng) showVerses(rng.dataset.artRange, rng);
  else if (go) showVerses(go.dataset.artGo, go);
}
function onReaderOver(e) {
  if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
  const t = popTarget(e.target); if (!t || t === popFor) return;
  clearTimeout(popT);
  popT = setTimeout(() => { const { p, more } = popPlate(t); popFocus = false; showPop(t, p, more); }, 140);
}
function onReaderOut(e) {
  const t = popTarget(e.target); if (!t) return;
  if (e.relatedTarget instanceof Node && t.contains(e.relatedTarget)) return;
  clearTimeout(popT);
  if (popFor === t && !popFocus) hidePop();
}
function onReaderFocus(e) {
  const slot = e.target instanceof Element ? e.target.closest('.art-slot.art-pre') : null;
  if (slot && rd) reveal(slot, rd);                    // tabbed into a figure before it scrolled into view
  const t = popTarget(e.target); if (!t) return;
  let kb = true; try { kb = t.matches(':focus-visible'); } catch (err) { /* old browsers */ }
  if (!kb) return;
  const { p, more } = popPlate(t); popFocus = true; showPop(t, p, more);
}
function onReaderBlur(e) { if (popTarget(e.target) && popFor === e.target) hidePop(); }
/** ←/→ on a figure's switcher step through its plates (instead of turning the chapter). */
function onReaderKey(e) {
  const t = e.target instanceof Element ? e.target.closest('.art-plate-sw') : null;
  if (!t || e.metaKey || e.ctrlKey || e.altKey || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault(); e.stopPropagation();
  const slot = t.closest('.art-slot');
  if (slot) stepSlot(slot, e.key === 'ArrowRight' ? 1 : -1);
}
function onImgError(e) {
  const img = e.target; if (!(img instanceof HTMLImageElement)) return;
  if (img.classList.contains('art-plate-img')) return;             // watchImg handles these (small-file fallback)
  const box = img.closest('.art-badge, .art-thumb, .art-g-img, .af-img'); if (box) box.classList.add('err');
}

/** A figure's passage button: select the first verse (without opening the sheet) and flash the range. */
function showVerses(spec, from) {
  const m = String(spec || '').match(/^(\d+)\.(\d+)\.(.+)$/); if (!m) return;
  const b = +m[1], c = +m[2], rs = decRanges(m[3]); if (!rs.length) return;
  goToPassage(b, c, rs, { focus: from && from.matches?.(':focus-visible') });
}

/** Navigate (if needed), select the first verse without opening the sheet, and flash the whole range. */
function goToPassage(b, c, rs, { focus = false } = {}) {
  const list = versesOf(rs), v1 = list[0];
  const here = state.book === b && state.chapter === c;
  const after = () => {
    A?.flash?.(list, { scroll: false });
    if (focus) document.getElementById('v' + v1)?.focus({ preventScroll: true });
  };
  if (here) { A?.select?.(v1, { open: false }); after(); return; }
  A?.navigate?.(b, c, v1);
  whenRendered(b, c, v1).then(ok => { if (ok) after(); });
}
function whenRendered(b, c, v) {
  const t0 = performance.now();
  return new Promise(res => {
    const tick = () => {
      const r = document.getElementById('reader');
      if (r && r.dataset.ch === `${b}.${c}` && document.getElementById('v' + v)) return res(true);
      if (performance.now() - t0 > 5000) return res(false);
      setTimeout(tick, 40);
    };
    setTimeout(tick, 16);
  });
}

// ------------------------------------------------------------ floating card while reading
// vis: depicted verses on screen (the figures themselves are measured when the card decides: figuresNow)
const fl = { io: null, slotIO: null, vis: new Set(), cur: null, raf: 0 };
let card = null, cardHideT = 0;
const dismissed = new Set((() => { try { return JSON.parse(sessionStorage.getItem(SS_DISMISS) || '[]'); } catch (e) { return []; } })());
function saveDismissed() { if (DRY) return; try { sessionStorage.setItem(SS_DISMISS, JSON.stringify([...dismissed])); } catch (e) { /* private mode */ } }

function setupFloat(cur) {
  const list = entriesFor(cur.b, cur.c);
  if (!list.length || typeof IntersectionObserver === 'undefined') { scheduleFloat(); return; }
  const need = new Set(); list.forEach(e => versesOf(e.ranges).forEach(v => need.add(v)));
  const bar = document.getElementById('topbar');
  const top = Math.round(Math.max(0, bar ? bar.getBoundingClientRect().bottom : 0) + 16);
  fl.io = new IntersectionObserver(ents => {
    ents.forEach(en => { const v = +en.target.dataset.v; if (en.isIntersecting) fl.vis.add(v); else fl.vis.delete(v); });
    scheduleFloat();
  }, { rootMargin: `-${top}px 0px -30% 0px` });
  cur.root.querySelectorAll('.verse[data-v]').forEach(el => { if (need.has(+el.dataset.v)) fl.io.observe(el); });
}

function scheduleFloat() {
  if (fl.raf || typeof requestAnimationFrame === 'undefined') return;
  const run = () => { fl.raf = 0; updateFloat(); };
  fl.raf = document.hidden ? setTimeout(run, 40) : requestAnimationFrame(run);   // rAF pauses in hidden tabs
}
// the card in the page margin: 16 px from the window edge and at least 16 px clear of the verse
// capsules; full card 270–340 px wide, else the thumbnail alone (44–64 px tall, 6 px padding)
const AF_INSET = 16, AF_GAP = 16, AF_FULL_MIN = 270, AF_FULL_MAX = 340, AF_MINI_MIN = 44, AF_MINI_MAX = 64, AF_MINI_PAD = 12;
/** The side sheet's page slide (a padding-right transition on #page) while it runs, else null. */
function pageSlide() {
  try { return document.getElementById('page')?.getAnimations?.().find(a => a.transitionProperty === 'padding-right' && a.playState !== 'finished') || null; } catch (e) { return null; }
}
/**
 * Left edge of the reading column (where the verse capsules start). While the page is sliding it
 * is the nearer of now and where the slide will end, so the card never sits under text that is on
 * its way in (sheet opening), nor grows before the text has moved away (sheet closing).
 */
function columnLeft() {
  const vs = rd?.root?.querySelector('.verses'); if (!vs) return 0;
  const r = vs.getBoundingClientRect(), first = vs.querySelector('.verse');
  const left = r.left + (first ? Math.min(0, first.getBoundingClientRect().left - r.left) : 0);
  const tr = pageSlide(); if (!tr) return left;
  try {
    const kf = tr.effect.getKeyframes(), page = document.getElementById('page');
    const to = parseFloat(kf[kf.length - 1].paddingRight), now = parseFloat(getComputedStyle(page).paddingRight);
    const box = vs.parentElement, br = box.getBoundingClientRect(), bs = getComputedStyle(box);
    const inL = br.left + parseFloat(bs.paddingLeft);
    const inW = br.width - parseFloat(bs.paddingLeft) - parseFloat(bs.paddingRight) - (to - now);   // the column's box once settled
    const w = Math.min(parseFloat(getComputedStyle(vs).maxWidth) || Infinity, inW);                 // centred, up to its max-width
    const end = inL + Math.max(0, (inW - w) / 2) + (left - r.left);
    return Number.isFinite(end) ? Math.min(left, end) : left;
  } catch (e) { return left; }
}
/** Free page margin left of the reading column, minus the card's inset and its breathing space. */
function marginRoom() { return columnLeft() - AF_INSET - AF_GAP; }
/**
 * The plate for the card: only for long passages, i.e. while its depicted verses are on screen but its
 * figure in the text has scrolled away above them. Never while a figure is on screen (no plate twice,
 * no two engravings competing), nor over an open sheet or drawer.
 */
function pickFloat() {
  if (!rd || !loaded || !platesOn || viewerIsOpen() || dismissed.has(rd.key) || !fl.vis.size) return null;
  const bc = document.body.classList;
  if (bc.contains('sheet-modal')) return null;                                    // overlay sheet or phone full detent
  if (bc.contains('drawer-open') && bc.contains('mode-overlay')) return null;
  // phone sheet (medium detent): the strip of text above it is all the reader has left, and the verse
  // just tapped sits in it; the sheet's Context tab (“In art”) and the verse badge lead to the plate
  if (bc.contains('drawer-open') && bc.contains('mode-sheet')) return null;
  // the side sheet squeezes the page: with no margin left of the text, stay out of the way (the
  // sheet's Context tab and the verse badges still lead to the engraving); likewise while the page
  // slides back, rather than flashing the bottom-edge card over the text
  if (bc.contains('mode-side') && (bc.contains('drawer-open') || pageSlide()) && marginRoom() < AF_MINI_MIN + AF_MINI_PAD) return null;
  const figs = figuresNow();
  if (figs.inView || !figs.above.size) return null;
  const list = entriesFor(rd.b, rd.c).filter(e => figs.above.has(rd.slotV.get(e)));
  const count = e => { let n = 0; fl.vis.forEach(v => { if (inRanges(e.ranges, v)) n++; }); return n; };
  if (fl.cur && list.includes(fl.cur) && count(fl.cur)) return fl.cur;             // sticky: no flicker between plates
  let best = null, bn = 0;
  list.forEach(e => { const n = count(e); if (n > bn) { best = e; bn = n; } });
  return best;
}
function ensureCard() {
  if (card) return card;
  card = document.createElement('aside');
  card.className = 'art-float'; card.setAttribute('aria-label', 'Engraving for the passage on screen');
  card.innerHTML = `<button class="af-open" type="button"><span class="af-img"><img alt="" decoding="async"></span><span class="af-body"><span class="af-k"></span><span class="af-t"></span><span class="af-c">${SHORT_CREDIT}</span></span></button><button class="af-x" type="button" aria-label="Hide this card while reading this chapter" title="Hide this card for this chapter">${icon('xmark')}</button>`;
  card.addEventListener('click', e => {
    const t = e.target instanceof Element ? e.target : null; if (!t) return;
    if (t.closest('.af-x')) {
      const key = card.dataset.key; if (!key) return;
      const kb = t.closest('.af-x').matches(':focus-visible');
      dismissed.add(key); saveDismissed(); fl.cur = null;
      if (card.contains(document.activeElement)) {          // the card stays up while it holds focus
        const back = kb && document.querySelector('#reader .verse[tabindex="0"]');
        if (back) back.focus({ preventScroll: true }); else document.activeElement.blur();
      }
      updateFloat();
      const [b, c] = key.split('.').map(Number);
      A?.toast?.(`The engraving card is hidden for ${refLabel(b, c)}.`, { label: 'Undo', run: () => { dismissed.delete(key); saveDismissed(); scheduleFloat(); } });
      return;
    }
    const open = t.closest('.af-open'); if (open && card.dataset.id) openViewer(card.dataset.id, { returnFocus: open });
  });
  card.addEventListener('error', onImgError, true);
  card.addEventListener('focusout', () => setTimeout(scheduleFloat, 0));   // it stayed up while focused
  document.body.appendChild(card);
  return card;
}
function fillCard(e) {
  const p = e.p, el = ensureCard();
  el.dataset.id = p.id; el.dataset.key = keyOf(e.b, e.c);
  const img = el.querySelector('.af-img img');
  el.querySelector('.af-img').classList.remove('err');
  img.src = imgUrl(p); img.width = p.sw; img.height = p.sh;
  el.querySelector('.af-img').style.setProperty('--ar', arOf(p));
  el.querySelector('.af-k').textContent = `In art · ${passageLabel(e.b, e.c, e.ranges)}`;
  el.querySelector('.af-t').textContent = T(p.title);
  el.querySelector('.af-open').setAttribute('aria-label', `View engraving: ${T(p.title)}, ${passageLabel(e.b, e.c, e.ranges)}`);
}
/**
 * Where the card sits: in the page margin left of the text when there is room (full card, or just
 * the thumbnail, sized to the margin, when it is narrow, e.g. with the side sheet open); on phones
 * and narrow windows along the bottom edge. (Hidden while the phone sheet is open: see pickFloat.)
 */
function positionCard(el) {
  let width = 0, mini = 0;
  if (innerWidth >= 700) {
    const room = marginRoom();
    if (room >= AF_FULL_MIN) width = Math.min(AF_FULL_MAX, Math.floor(room));
    else if (room >= AF_MINI_MIN + AF_MINI_PAD) mini = Math.min(AF_MINI_MAX, Math.floor(room - AF_MINI_PAD));
  }
  el.classList.toggle('mini', !!mini);
  if (mini) el.style.setProperty('--af-mini', mini + 'px'); else el.style.removeProperty('--af-mini');
  if (width) el.style.setProperty('--af-w', width + 'px'); else el.style.removeProperty('--af-w');
}
function updateFloat() {
  const e = pickFloat();
  if (!e) {
    if (card && card.classList.contains('on')) {
      if (card.contains(document.activeElement)) return;                            // never yank a focused control
      card.classList.remove('on'); clearTimeout(cardHideT);
      cardHideT = setTimeout(() => { if (card && !card.classList.contains('on')) card.hidden = true; }, RM.matches ? 0 : 420);
    }
    fl.cur = null;
    return;
  }
  const el = ensureCard();
  positionCard(el);
  clearTimeout(cardHideT);
  if (fl.cur === e && el.classList.contains('on')) return;
  const wasOn = el.classList.contains('on') && !el.hidden;
  fl.cur = e;
  if (wasOn && !RM.matches) {
    el.classList.add('swap');
    setTimeout(() => { if (fl.cur === e) fillCard(e); el.classList.remove('swap'); }, 160);
  } else {
    fillCard(e);
    el.hidden = false;
    void el.offsetWidth;          // start the slide-up from the hidden pose
    el.classList.add('on');
  }
}

// ------------------------------------------------------------ drawer section (“In art”, first in Context)
/** '' or the “In art” section for the selected verse (or the chapter when v is 0/null). */
export function drawerHtml(b, c, v) {
  b = +b; c = +c; v = +v || 0;
  const list = byVerse(entriesFor(b, c)); if (!list.length) return '';
  const inV = e => !!v && inRanges(e.ranges, v);
  const rows = v ? [...list.filter(inV), ...list.filter(e => !inV(e))] : list.slice();
  const nIn = v ? rows.filter(inV).length : 0;
  const show = v ? (nIn || Math.min(2, rows.length)) : Math.min(4, rows.length);
  const hiddenN = rows.length - show;
  const row = (e, i) => {
    const p = e.p;
    return `<li${i >= show ? ' hidden' : ''}><button class="cell art-cell" type="button" data-art-open="${p.id}" aria-label="${esc(`${T(p.title)}, ${passageLabel(b, c, e.ranges)}. View full screen`)}"><span class="art-thumb${isWide(p) ? ' wide' : ''}" style="--ar:${arOf(p)}"><img src="${imgUrl(p)}" width="${p.sw}" height="${p.sh}" alt="${esc(altOf(p))}" loading="lazy" decoding="async"></span><span class="cell-body"><span class="cell-title">${esc(T(p.title))}</span><span class="cell-sub art-cell-scene">${esc(T(p.scene))}</span><span class="art-cell-ref">${esc(passageLabel(b, c, e.ranges))}${inV(e) ? '<span class="in-verse">This verse</span>' : ''}</span></span>${icon('chev-right', 'chev')}</button></li>`;
  };
  return `<section class="art-sec" data-art-sec aria-labelledby="art-sec-h">
    <div class="lh"><h3 id="art-sec-h">In art</h3><span>${rows.length}</span></div>
    <ul class="group art-list">${rows.map(row).join('')}</ul>
    ${hiddenN > 0 ? `<button class="link art-sec-more" type="button" data-art-more>${v && nIn ? `${hiddenN} more in ${esc(refLabel(b, c))}` : `Show all ${rows.length}`}${icon('chev-down')}</button>` : ''}
    <p class="foot-note">Engravings by Gustave Doré for La Grande Bible de Tours (1866). Public domain, via Wikimedia Commons.</p>
  </section>`;
}

/** Bind the “In art” section inside the drawer body (call after every drawer render). */
export function attachDrawer(root) {
  const sec = (root || document).querySelector?.('[data-art-sec]');
  if (!sec || sec.dataset.bound) return;
  sec.dataset.bound = '1';
  sec.addEventListener('error', onImgError, true);
  sec.addEventListener('click', e => {
    const t = e.target instanceof Element ? e.target : null; if (!t) return;
    const open = t.closest('[data-art-open]');
    if (open) { e.stopPropagation(); openViewer(open.dataset.artOpen, { returnFocus: open }); return; }
    const more = t.closest('[data-art-more]');
    if (more) {
      e.stopPropagation();
      const hid = [...sec.querySelectorAll('.art-list > li[hidden]')];
      hid.forEach(li => { li.hidden = false; li.classList.add('art-rowin'); });
      more.remove();
      hid[0]?.querySelector('button')?.focus({ preventScroll: true });
    }
  });
}

// ------------------------------------------------------------ viewer (full-screen lightbox)
let V = null;
const viewerIsOpen = () => !!(V && V.d.open && !V.closing);

function ensureViewer() {
  if (V) return V;
  const d = document.createElement('dialog');
  d.className = 'art-viewer';
  d.setAttribute('aria-labelledby', 'av-title');
  d.setAttribute('aria-describedby', 'av-scene');
  d.innerHTML = `<div class="av-shell">
    <div class="av-stage">
      <div class="av-canvas" role="img"><img class="av-low" alt="" decoding="async" draggable="false"><img class="av-hi" alt="" decoding="async" draggable="false"><canvas class="av-hq" aria-hidden="true"></canvas></div>
      <span class="av-spin" aria-hidden="true"></span>
      <button class="av-nav av-prev" type="button" data-av="prev" aria-label="Previous engraving" title="Previous (←; Shift+← when zoomed)">${icon('chev-left')}</button>
      <button class="av-nav av-next" type="button" data-av="next" aria-label="Next engraving" title="Next (→; Shift+→ when zoomed)">${icon('chev-right')}</button>
    </div>
    <section class="av-cap" aria-label="About this engraving">
      <p class="av-kicker"><span class="t-dot" aria-hidden="true"></span><span class="av-book"></span></p>
      <h2 class="av-title" id="av-title"></h2>
      <p class="av-scene" id="av-scene"></p>
      <div class="av-refs"></div>
      <p class="av-credit"></p>
    </section>
    <div class="av-top">
      <p class="av-count" aria-hidden="true"></p>
      <div class="av-tools" role="group" aria-label="Viewer">
        <button class="av-btn" type="button" data-av="out" aria-label="Zoom out" title="Zoom out (−)">${svg('minus')}</button>
        <button class="av-btn" type="button" data-av="in" aria-label="Zoom in" title="Zoom in (+); arrow keys pan">${icon('plus')}</button>
        <button class="av-btn" type="button" data-av="info" aria-pressed="true" aria-label="Caption" title="Caption (i)">${icon('info')}</button>
        <button class="av-btn" type="button" data-av="all" aria-label="All engravings" title="All engravings">${svg('grid')}</button>
        <button class="av-btn av-x" type="button" data-av="close" aria-label="Close" title="Close (Esc)">${icon('xmark')}</button>
      </div>
    </div>
    <p class="sr" aria-live="polite" data-av-live></p>
  </div>`;
  document.body.appendChild(d);
  const q = s => d.querySelector(s);
  V = { d, shell: q('.av-shell'), stage: q('.av-stage'), canvas: q('.av-canvas'), low: q('.av-low'), hi: q('.av-hi'), hq: q('.av-hq'), hqKey: '', hqT: 0, cap: q('.av-cap'),
    count: q('.av-count'), live: q('[data-av-live]'), prev: q('.av-prev'), next: q('.av-next'), zin: q('[data-av="in"]'), zout: q('[data-av="out"]'),
    info: q('[data-av="info"]'), close: q('[data-av="close"]'),
    p: null, group: null, s: 1, x: 0, y: 0, fw: 0, fh: 0, W: 0, H: 0, cx: 0, cy: 0, k: 1, smax: 3, token: 0, opener: null, closing: false, capOn: true, spinT: 0 };
  bindViewer(V);
  return V;
}

/** Open the full-screen viewer on a plate. opts.returnFocus: element to focus after closing. */
export async function openViewer(id, opts = {}) {
  await load();
  const p = BY_ID.get(id); if (!p) return;
  bindGlobals();
  const v = ensureViewer();
  if (v.closing) await v.closingP;        // reopened during the closing fade: let it finish first
  hidePop();
  // a verse badge shared by several plates steps through those plates only (opts.group: their ids, in badge order)
  const grp = Array.isArray(opts.group) && opts.group.length > 1 ? opts.group.map(x => BY_ID.get(x)).filter(Boolean) : null;
  v.group = grp && grp.length > 1 && grp.includes(p) ? grp : null;
  if (!v.d.open) {
    v.opener = opts.returnFocus || (document.activeElement !== document.body ? document.activeElement : null);
    v.closing = false; v.d.classList.remove('closing', 'on');
    v.capOn = true; v.info.setAttribute('aria-pressed', 'true'); v.shell.classList.remove('chrome-off');
    try { v.d.showModal(); } catch (e) { v.d.setAttribute('open', ''); }
    document.documentElement.classList.add('art-viewing');
    requestAnimationFrame(() => v.d.classList.add('on'));
    scheduleFloat();
  }
  show(p, 0);
  v.close.focus({ preventScroll: true });
}

/** Close the viewer (animated); resolves once the dialog is closed and the page is interactive again. */
export function closeViewer({ restore = true } = {}) {
  const v = V; if (!v || !v.d.open) return Promise.resolve();
  if (v.closing) return v.closingP;
  v.closing = true; v.d.classList.remove('on'); v.d.classList.add('closing');
  clearTimeout(v.spinT);
  v.closingP = new Promise(res => {
    const done = () => {
      v.closing = false; v.d.classList.remove('closing');
      try { v.d.close(); } catch (e) { v.d.removeAttribute('open'); }
      document.documentElement.classList.remove('art-viewing');
      v.shell.classList.remove('chrome-off', 'zoomed', 'loading');
      updateFloat();                   // bring the card back first so it can take focus again
      if (restore) {
        let o = v.opener;
        if (!o || !o.isConnected) o = document.querySelector(`[data-art-g="${v.p?.id}"], #reader [data-art="${v.p?.id}"], #reader button[data-art-open="${v.p?.id}"]`);
        o?.focus?.({ preventScroll: true });
      }
      v.opener = null;
      res();
    };
    if (RM.matches) done(); else setTimeout(done, 200);
  });
  return v.closingP;
}

/** The plate one step from p: within the viewer's badge group when it has one, else in canonical order. */
const neighbour = (p, dir) => (V && V.group ? V.group[V.group.indexOf(p) + dir] : PLATES[p._i + dir]) || null;

function stepViewer(dir) {
  const v = V; if (!v || !v.p) return;
  const q = neighbour(v.p, dir); if (!q) return;
  show(q, dir);
}

function show(p, dir) {
  const v = V; v.p = p; const token = ++v.token;
  v.s = 1; v.x = 0; v.y = 0;
  v.shell.classList.toggle('no-cap', !v.capOn);
  fit(); apply(false);
  // images: the small one (usually cached) at once, the large one fades in when decoded
  v.low.src = imgUrl(p);
  v.hi.classList.remove('ready'); v.hi.removeAttribute('src');
  v.canvas.setAttribute('aria-label', altOf(p));
  clearTimeout(v.spinT); v.shell.classList.remove('loading');
  v.spinT = setTimeout(() => { if (v.token === token && !v.hi.classList.contains('ready')) v.shell.classList.add('loading'); }, 320);
  v.shell.classList.remove('hq'); v.hqKey = '';
  const done = () => {
    if (v.token !== token) return;
    v.hi.classList.add('ready'); v.shell.classList.remove('loading'); clearTimeout(v.spinT);
    renderHQ();
    later(() => { if (v.token === token) preload(p); });
  };
  v.hi.onload = () => { const dp = v.hi.decode ? v.hi.decode().catch(() => {}) : Promise.resolve(); dp.then(done); };
  v.hi.onerror = () => { if (v.token === token) { v.shell.classList.remove('loading'); clearTimeout(v.spinT); } };
  v.hi.src = imgUrl(p, true);
  // caption
  const b = p.ref[0], bk = bookOf(b);
  const dot = v.d.querySelector('.av-kicker .t-dot'); dot.className = `t-dot ${testament(b)}`;
  v.d.querySelector('.av-book').textContent = bk ? `${bk.name} · ${b <= 39 ? 'Old Testament' : 'New Testament'}` : '';
  v.d.querySelector('.av-title').textContent = T(p.title);
  v.d.querySelector('.av-scene').textContent = T(p.scene);
  const prim = [p.ref[2], p.ref[3]];
  const also = p.also.filter(r => !(r[0] === p.ref[0] && r[1] === p.ref[1]));
  const sameCh = p.also.filter(r => r[0] === p.ref[0] && r[1] === p.ref[1]).map(r => [r[2], r[3]]);
  const primRs = [prim, ...sameCh];
  const goSpec = (bb, cc, rs) => `${bb}.${cc}.${encRanges(rs)}`;
  v.d.querySelector('.av-refs').innerHTML = `<button class="av-go" type="button" data-av-go="${goSpec(p.ref[0], p.ref[1], primRs)}">${icon('book')}<span>Read ${esc(passageLabel(p.ref[0], p.ref[1], primRs))}</span>${icon('arrow-right')}</button>`
    + (also.length ? `<p class="av-also"><span>Also</span>${also.map(r => `<button class="av-also-ref" type="button" data-av-go="${goSpec(r[0], r[1], [[r[2], r[3]]])}">${esc(passageLabel(r[0], r[1], [[r[2], r[3]]]))}</button>`).join('')}</p>` : '');
  const page = /^https:\/\/commons\.wikimedia\.org\//.test(String(p.page || '')) ? p.page : '';
  v.d.querySelector('.av-credit').innerHTML = `<span>${esc(CREDIT)}</span>${page ? `<a href="${esc(page)}" target="_blank" rel="noopener">Source file on Wikimedia Commons${icon('external')}</a>` : ''}`;
  const seq = v.group || PLATES, i = v.group ? seq.indexOf(p) : p._i;
  const nth = `${i + 1} of ${seq.length}${v.group ? ' at this verse' : ''}`;
  v.count.textContent = nth;
  v.live.textContent = `${T(p.title)}. Engraving ${nth}.`;
  v.prev.disabled = i === 0; v.next.disabled = i === seq.length - 1;
  if (v.prev.disabled && document.activeElement === v.prev) v.next.focus({ preventScroll: true });
  if (v.next.disabled && document.activeElement === v.next) v.prev.focus({ preventScroll: true });
  v.cap.scrollTop = 0;
  // entrance
  v.canvas.classList.remove('in-l', 'in-r', 'in-0');
  void v.canvas.offsetWidth;
  if (!RM.matches) v.canvas.classList.add(dir > 0 ? 'in-r' : dir < 0 ? 'in-l' : 'in-0');
}

/**
 * Engravings are dense parallel hatching: a browser's quick downscale of the large file to the
 * fit size moirés badly on 1× screens. There, draw a high-quality resample into a canvas that
 * covers the image while it is at fit scale (zooming in reveals the <img>, which is sharp).
 */
function renderHQ() {
  const v = V; if (!v || !v.p || !v.hi.classList.contains('ready')) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(v.fw * dpr), h = Math.round(v.fh * dpr);
  const key = `${v.p.id}@${w}x${h}`;
  if (key === v.hqKey) { v.shell.classList.add('hq'); return; }
  v.shell.classList.remove('hq'); v.hqKey = '';
  if (typeof createImageBitmap !== 'function' || w / v.p.w > 0.8 || w < 2 || h < 2) return;
  const token = v.token;
  createImageBitmap(v.hi, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }).then(bmp => {
    if (v.token !== token || Math.round(v.fw * dpr) !== w) { bmp.close?.(); return; }
    v.hq.width = w; v.hq.height = h;
    v.hq.getContext('2d').drawImage(bmp, 0, 0); bmp.close?.();
    v.hqKey = key; v.shell.classList.add('hq');
  }).catch(() => {});
}

function preload(p) {
  const n = neighbour(p, 1), pr = neighbour(p, -1);
  if (n) { new Image().src = imgUrl(n); new Image().src = imgUrl(n, true); }
  if (pr) new Image().src = imgUrl(pr);
}

function pads() {
  const narrow = innerWidth < 700, short = innerHeight < 520;   // short: a phone held sideways
  return { t: short ? 52 : narrow ? 58 : 68, b: short ? 8 : narrow ? 12 : 28, l: narrow ? 10 : 76, r: narrow ? 10 : 76 };
}
function fit() {
  const v = V, p = v.p; if (!p) return;
  const r = v.stage.getBoundingClientRect(), pad = pads();
  const aw = Math.max(60, r.width - pad.l - pad.r), ah = Math.max(60, r.height - pad.t - pad.b);
  // never blow a plate up more than 2× to fit, and a low-resolution scan (lowres) not past 1:1
  const k = Math.min(aw / p.w, ah / p.h, p.lowres ? 1 : 2);
  v.k = k; v.fw = p.w * k; v.fh = p.h * k; v.W = r.width; v.H = r.height;
  v.cx = pad.l + aw / 2; v.cy = pad.t + ah / 2;
  // zoom up to 1.5 × the file's own pixels (at least 2.5 × the fitted size, unless the scan is small)
  v.smax = p.lowres ? Math.max(1, Math.min(6, 1.5 / k)) : Math.max(2.5, Math.min(6, 1.5 / k));
  const c = v.canvas.style;
  c.width = v.fw + 'px'; c.height = v.fh + 'px'; c.left = (v.cx - v.fw / 2) + 'px'; c.top = (v.cy - v.fh / 2) + 'px';
  if (v.hqKey && !v.hqKey.endsWith(`@${Math.round(v.fw * (window.devicePixelRatio || 1))}x${Math.round(v.fh * (window.devicePixelRatio || 1))}`)) {
    v.shell.classList.remove('hq'); v.hqKey = '';
  }
  clearTimeout(v.hqT); v.hqT = setTimeout(renderHQ, 160);
}
function clampXY() {
  const v = V, hw = v.fw * v.s / 2, hh = v.fh * v.s / 2;
  v.x = hw * 2 <= v.W ? 0 : Math.min(hw - v.cx, Math.max(v.W - v.cx - hw, v.x));
  v.y = hh * 2 <= v.H ? 0 : Math.min(hh - v.cy, Math.max(v.H - v.cy - hh, v.y));
}
function apply(anim) {
  const v = V;
  v.canvas.classList.toggle('live', !anim);
  v.canvas.style.transform = `translate3d(${v.x.toFixed(1)}px, ${v.y.toFixed(1)}px, 0) scale(${v.s.toFixed(4)})`;
  const z = v.s > 1.01;
  v.shell.classList.toggle('zoomed', z);
  v.zout.disabled = !z; v.zin.disabled = v.s >= v.smax - 0.01;
  if (v.zout.disabled && document.activeElement === v.zout) v.zin.focus({ preventScroll: true });
  if (v.zin.disabled && document.activeElement === v.zin) v.zout.focus({ preventScroll: true });
}
/** Zoom to scale s keeping the point under (clientX, clientY) still; defaults to the image centre. */
function zoomTo(s, cx, cy, anim = true) {
  const v = V; if (!v.p) return;
  s = Math.min(v.smax, Math.max(1, s));
  const r = v.stage.getBoundingClientRect();
  const px = (cx ?? r.left + v.cx) - r.left - v.cx, py = (cy ?? r.top + v.cy) - r.top - v.cy;
  v.x = px - (px - v.x) * (s / v.s); v.y = py - (py - v.y) * (s / v.s); v.s = s;
  if (s <= 1.001) { v.s = 1; v.x = 0; v.y = 0; }
  clampXY(); apply(anim && !RM.matches);
}
function toggleZoom(cx, cy) { const v = V; if (v.s > 1.01) zoomTo(1, cx, cy); else zoomTo(Math.min(v.smax, Math.max(2, 1 / v.k)), cx, cy); }
function setCaption(on) {
  const v = V; v.capOn = on;
  if (!on && v.cap.contains(document.activeElement)) v.info.focus({ preventScroll: true });   // it is about to be hidden
  v.shell.classList.toggle('no-cap', !on);
  v.info.setAttribute('aria-pressed', String(on));
  requestAnimationFrame(() => { const s = v.s; fit(); v.s = s; clampXY(); apply(false); });
}

function bindViewer(v) {
  const { d, stage } = v;
  d.addEventListener('cancel', e => { e.preventDefault(); closeViewer(); });
  d.addEventListener('close', () => { document.documentElement.classList.remove('art-viewing'); v.closing = false; });
  d.addEventListener('click', e => {
    const t = e.target instanceof Element ? e.target : null; if (!t) return;
    const b = t.closest('[data-av]');
    if (b) {
      const a = b.dataset.av;
      if (a === 'close') closeViewer();
      else if (a === 'prev') stepViewer(-1);
      else if (a === 'next') stepViewer(1);
      else if (a === 'in') zoomTo(v.s * 1.6);
      else if (a === 'out') zoomTo(v.s / 1.6);
      else if (a === 'info') setCaption(!v.capOn);
      else if (a === 'all') {
        closeViewer({ restore: false }).then(() => {
          A?.showPanel?.('art', true);
          setTimeout(() => document.querySelector('.art-g-body .art-g-item[tabindex="0"]')?.focus({ preventScroll: true }), 600);
        });
      }
      return;
    }
    const go = t.closest('[data-av-go]');
    if (go) {
      const m = go.dataset.avGo.match(/^(\d+)\.(\d+)\.(.+)$/); if (!m) return;
      const kb = go.matches(':focus-visible');
      closeViewer({ restore: false }).then(() => goToPassage(+m[1], +m[2], decRanges(m[3]), { focus: kb }));
    }
  });
  const onKey = e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === 'Tab') { trapTab(e); return; }
    const pan = Math.max(80, Math.round(Math.min(v.W, v.H) * 0.12));
    // ←/→ change the plate at fit scale; zoomed in they pan, when the plate is wider than the stage (Shift+←/→ still change it)
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && v.s > 1.01 && v.fw * v.s > v.W + 1 && !e.shiftKey) { e.preventDefault(); v.x += k === 'ArrowLeft' ? pan : -pan; clampXY(); apply(!RM.matches); }
    else if (k === 'ArrowLeft') { e.preventDefault(); stepViewer(-1); }
    else if (k === 'ArrowRight') { e.preventDefault(); stepViewer(1); }
    else if (k === '+' || k === '=') { e.preventDefault(); zoomTo(v.s * 1.6); }
    else if (k === '-' || k === '_') { e.preventDefault(); zoomTo(v.s / 1.6); }
    else if (k === '0') { e.preventDefault(); zoomTo(1); }
    else if (k === 'i' || k === 'I') { e.preventDefault(); setCaption(!v.capOn); }
    else if (k === 'Home') { e.preventDefault(); const seq = v.group || PLATES; if (seq[0] && v.p !== seq[0]) show(seq[0], -1); }
    else if (k === 'End') { e.preventDefault(); const seq = v.group || PLATES, l = seq[seq.length - 1]; if (l && v.p !== l) show(l, 1); }
    else if (v.s > 1.01 && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); v.y += k === 'ArrowUp' ? pan : -pan; clampXY(); apply(!RM.matches); }
  };
  d.addEventListener('keydown', onKey);
  // focus can fall to <body> (a focused caption control was replaced or hidden): keep the shortcuts working
  document.addEventListener('keydown', e => { if (viewerIsOpen() && !e.defaultPrevented && !d.contains(e.target)) onKey(e); });
  if ('ResizeObserver' in window) new ResizeObserver(() => { if (!d.open || !v.p) return; const s = v.s; fit(); v.s = s; clampXY(); apply(false); }).observe(stage);

  // gestures: tap/click zoom, double-tap, drag to pan, pinch, swipe to step, swipe down to close
  const pts = new Map();
  let g = null, lastTap = { t: 0, x: 0, y: 0 }, tapT = 0, lastToggle = 0;
  const rel = () => stage.getBoundingClientRect();
  stage.addEventListener('pointerdown', e => {
    if (e.button > 0 || (e.target instanceof Element && e.target.closest('button, a'))) return;
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) g = { mode: 'pending', x0: e.clientX, y0: e.clientY, t0: performance.now(), sx: v.x, sy: v.y, type: e.pointerType, lx: e.clientX, lt: performance.now(), vx: 0, vy: 0, ly: e.clientY };
    else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      g = { mode: 'pinch', d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, s0: v.s, x0: v.x, y0: v.y, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, type: e.pointerType };
    }
  });
  stage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.mode === 'pinch' && pts.size >= 2) {
      const [a, b] = [...pts.values()], r = rel();
      const s = Math.min(v.smax * 1.15, Math.max(0.85, g.s0 * Math.hypot(b.x - a.x, b.y - a.y) / g.d0));
      const mx = (a.x + b.x) / 2 - r.left - v.cx, my = (a.y + b.y) / 2 - r.top - v.cy;
      const m0x = g.m0.x - r.left - v.cx, m0y = g.m0.y - r.top - v.cy;
      v.x = mx - (m0x - g.x0) * (s / g.s0); v.y = my - (m0y - g.y0) * (s / g.s0); v.s = s;
      apply(false); return;
    }
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0, now = performance.now();
    if (now - g.lt > 12) { g.vx = (e.clientX - g.lx) / (now - g.lt); g.vy = (e.clientY - g.ly) / (now - g.lt); g.lx = e.clientX; g.ly = e.clientY; g.lt = now; }
    if (g.mode === 'pending') {
      if (Math.hypot(dx, dy) < 6) return;
      g.mode = v.s > 1.01 ? 'pan' : Math.abs(dx) > Math.abs(dy) ? 'swipe' : dy > 0 && g.type !== 'mouse' ? 'down' : 'none';
      if (g.mode === 'pan') stage.classList.add('grabbing');
    }
    if (g.mode === 'pan') { v.x = g.sx + dx; v.y = g.sy + dy; clampXY(); apply(false); }
    else if (g.mode === 'swipe') { v.canvas.classList.add('live'); v.canvas.style.transform = `translate3d(${dx * 0.9}px, 0, 0)`; v.canvas.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / 700)); }
    else if (g.mode === 'down') { v.canvas.classList.add('live'); v.canvas.style.transform = `translate3d(0, ${Math.max(0, dy)}px, 0) scale(${Math.max(0.86, 1 - dy / 1600)})`; d.style.setProperty('--av-dim', String(Math.max(0.35, 1 - dy / 500))); }
  });
  // after a pinch the scale may overshoot [1, smax]: settle back with a spring-like ease
  const settle = () => { if (v.s < 1 || v.s > v.smax) { const r = rel(); zoomTo(Math.min(v.smax, Math.max(1, v.s)), r.left + v.cx, r.top + v.cy, true); } else { clampXY(); apply(true); } };
  const end = e => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    try { stage.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (!g) return;
    if (g.mode === 'pinch') {
      if (pts.size === 0) { g = null; settle(); }
      else { const [a] = [...pts.values()]; g = { mode: 'pan', pinched: true, x0: a.x, y0: a.y, sx: v.x, sy: v.y, type: g.type, lx: a.x, ly: a.y, lt: performance.now(), vx: 0, vy: 0 }; }
      return;
    }
    const cur = g; g = null; stage.classList.remove('grabbing');
    if (cur.pinched) { settle(); return; }
    const dx = e.clientX - cur.x0, dy = e.clientY - cur.y0;
    if (e.type === 'pointercancel' && cur.mode === 'pending') return;
    if (cur.mode === 'swipe') {
      v.canvas.style.opacity = '';
      const dir = dx < 0 ? 1 : -1, far = Math.abs(dx) > 70 || Math.abs(cur.vx) > 0.5;
      if (far && neighbour(v.p, dir)) stepViewer(dir); else apply(true);
      return;
    }
    if (cur.mode === 'down') {
      d.style.removeProperty('--av-dim');
      if (dy > 110 || cur.vy > 0.6) { v.canvas.style.transform = ''; closeViewer(); } else apply(true);
      return;
    }
    if (cur.mode !== 'pending') return;
    // a tap or click
    const now = performance.now();
    if (cur.type === 'mouse' || cur.type === 'pen') {
      if (now - lastToggle < 320) return;               // the second click of a double-click
      lastToggle = now; toggleZoom(e.clientX, e.clientY); return;
    }
    if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      clearTimeout(tapT); lastTap.t = 0; toggleZoom(e.clientX, e.clientY); return;
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
    clearTimeout(tapT);
    tapT = setTimeout(() => { v.shell.classList.toggle('chrome-off'); const off = v.shell.classList.contains('chrome-off'); setCaption(!off); }, 300);
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', e => {
    if (!v.p) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomTo(v.s * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0025)), e.clientX, e.clientY, false);
  }, { passive: false });
  stage.addEventListener('dblclick', e => e.preventDefault());
}

function trapTab(e) {
  const v = V;
  const els = [...v.d.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.disabled && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden');
  if (!els.length) return;
  const first = els[0], last = els[els.length - 1], a = document.activeElement;
  if (e.shiftKey && (a === first || !v.d.contains(a))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (a === last || !v.d.contains(a))) { e.preventDefault(); first.focus(); }
}

// ------------------------------------------------------------ gallery (stage panel 'art')
const G = { filter: 'all', stage: null, book: 0, active: false, went: null };   // went: the passage of the plate last chosen here

/** Render the gallery into #stage (main.js calls this for panel 'art'); in place if it is already there. */
export function renderGallery(stage) {
  if (!stage) return;
  bindGlobals();
  G.stage = stage; G.active = true;
  if (!loaded) {
    stage.innerHTML = `${galleryHead(0)}<div class="stage-body art-g-body"><div class="stage-empty">Loading engravings…</div></div>`;
    load().then(() => {
      if (G.stage !== stage || !G.active || !stage.querySelector(':scope > .art-g-body')) return;
      if (loaded) renderGallery(stage);
      else { const em = stage.querySelector('.stage-empty'); if (em) em.textContent = hostedMsg('The engravings couldn’t be loaded. Is serve.py running?', 'The engravings couldn’t be loaded. Check your connection and try again.'); }
    });
    return;
  }
  const body = stage.querySelector(':scope > .art-g-body[data-ready]');
  if (body) { updateGallery(stage, body); return; }
  if (G.filter === 'book' && !bookCount(state.book)) G.filter = 'all';
  stage.innerHTML = `${galleryHead(PLATES.length)}<div class="stage-body art-g-body" data-ready="1"></div>`;
  const nb = stage.querySelector('.art-g-body');
  fillGallery(nb);
  bindGallery(stage, nb);
  requestAnimationFrame(() => scrollToBook(nb, false));
}

/** Teardown for panel switches (the DOM is left to main.js). */
export function stop() {
  G.active = false;
  hidePop();
  // the gallery closed after a plate was chosen: once the panel has folded away, bring its passage into view
  const w = G.went; G.went = null;
  if (!w) return;
  const go = () => { if (!state.panel && state.book === w.b && state.chapter === w.c && (state.selected || null) === w.sel) A?.ensureVisible?.(w.v); };   // only if the selection hasn't moved since
  let fold = null;
  try { fold = document.getElementById('panel')?.getAnimations?.().find(a => a.transitionProperty === 'grid-template-rows') || null; } catch (e) { /* old browser */ }
  if (fold) fold.finished.then(go, () => {});      // cancelled: the panel opened again
  else setTimeout(go, RM.matches ? 0 : 600);
}

const nPlates = n => `${n} ${n === 1 ? 'engraving' : 'engravings'}`;
/** A filter count: “·” before it on screen (“Daniel · 5”), “Daniel, 5 engravings” for screen readers. */
const cntHtml = n => `<span class="sr">, </span>${n}<span class="sr"> ${n === 1 ? 'engraving' : 'engravings'}</span>`;
const bookCount = b => PLATES.reduce((n, p) => n + ((p.ref[0] === b || p.also.some(r => r[0] === b)) ? 1 : 0), 0);
function counts() {
  const ot = PLATES.filter(p => p.ref[0] <= 39).length;
  return { all: PLATES.length, ot, nt: PLATES.length - ot, book: bookCount(state.book) };
}
function galleryHead(n) {
  const c = n ? counts() : { all: 0, ot: 0, nt: 0, book: 0 };
  const bn = bookOf(state.book)?.name || 'This book';
  const f = G.filter;
  const r = (val, label, cnt, title = '') => `<button type="button" role="radio" data-art-f="${val}" aria-checked="${f === val}" tabindex="${f === val ? 0 : -1}"${title ? ` title="${esc(title)}"` : ''}${cnt ? '' : ' aria-disabled="true"'}>${label}<span class="art-g-c">${cntHtml(cnt)}</span></button>`;
  return `<div class="stage-head art-g-head">
    <div class="stage-titles"><h2 class="stage-title" id="stage-title">Engravings</h2><p class="stage-sub art-g-sub">${subText(c)}</p></div>
    <span class="spacer"></span>
    <div class="stage-tools"><div class="pill-seg art-g-filter" role="radiogroup" aria-label="Show engravings from">${r('all', 'All', c.all)}${r('book', `<span class="art-g-bn">${esc(bn)}</span>`, c.book, 'This book')}${r('ot', 'Old', c.ot, 'Old Testament')}${r('nt', 'New', c.nt, 'New Testament')}</div></div>
    <button class="close-btn" type="button" data-close-panel aria-label="Close engravings">${icon('xmark')}</button>
  </div>`;
}
function subText(c) {
  const f = G.filter, bn = bookOf(state.book)?.name || '';
  const n = f === 'book' ? c.book : f === 'ot' ? c.ot : f === 'nt' ? c.nt : c.all;
  const scope = f === 'book' ? ` in ${bn}` : f === 'ot' ? ' in the Old Testament' : f === 'nt' ? ' in the New Testament' : '';
  return `${n} ${n === 1 ? 'engraving' : 'engravings'}${esc(scope)} · ${SHORT_CREDIT} · Select one to open its passage`;
}
function galleryGroups() {
  const f = G.filter;
  if (f === 'book') {
    const b = state.book, items = [];
    PLATES.forEach(p => {
      const rs = [p.ref, ...p.also].filter(r => r[0] === b).sort((x, z) => (x[1] - z[1]) || (x[2] - z[2]));
      if (rs.length) items.push({ p, r: rs[0] });
    });
    items.sort((a, z) => (a.r[1] - z.r[1]) || (a.r[2] - z.r[2]) || (a.p._i - z.p._i));
    return items.length ? [{ b, items }] : [];
  }
  const out = []; let cur = null;
  for (const p of PLATES) {
    const b = p.ref[0];
    if ((f === 'ot' && b > 39) || (f === 'nt' && b <= 39)) continue;
    if (!cur || cur.b !== b) out.push((cur = { b, items: [] }));
    cur.items.push({ p, r: p.ref });
  }
  return out;
}
function fillGallery(body) {
  G.book = state.book;
  const here = new Set(forChapter(state.book, state.chapter).map(p => p.id));
  const groups = galleryGroups();
  if (!groups.length) {
    body.innerHTML = `<div class="stage-empty art-g-empty"><p>No engravings for ${esc(bookOf(state.book)?.name || 'this book')}.<br><button class="link" type="button" data-art-f="all">Show all ${PLATES.length}</button></p></div>`;
    return;
  }
  let first = true;
  const item = ({ p, r }) => {
    const on = here.has(p.id);
    const ref = refLabel(r[0], r[1], r[2], r[3]);
    const tab = on && first ? 0 : -1; if (tab === 0) first = false;
    return `<div class="art-g-cell" role="listitem" style="--ar:${arOf(p)}"><button class="art-g-item${on ? ' here' : ''}" type="button" data-art-g="${p.id}" data-go="${r[0]}.${r[1]}.${r[2]}" tabindex="${tab}" aria-label="${esc(`${T(p.title)}, ${ref}${on ? ' (this chapter)' : ''}`)}"><span class="art-g-img"><img src="${imgUrl(p)}" width="${p.sw}" height="${p.sh}" alt="${esc(altOf(p))}" loading="lazy" decoding="async"></span><span class="art-g-cap"><span class="art-g-t">${esc(T(p.title))}</span><span class="art-g-r">${esc(ref)}</span></span></button></div>`;
  };
  body.innerHTML = `<div class="art-g-scroll">${groups.map(g => `<section class="art-g-sec" data-b="${g.b}" aria-labelledby="art-g-h${g.b}"><h3 class="art-g-h" id="art-g-h${g.b}"><span class="t-dot ${testament(g.b)}" aria-hidden="true"></span>${esc(bookName(g.b))}<span class="art-g-n"><span class="sr">, </span>${nPlates(g.items.length)}</span></h3><div class="art-g-grid" role="list">${g.items.map(item).join('')}</div></section>`).join('')}</div>`;
  if (first) body.querySelector('.art-g-item')?.setAttribute('tabindex', '0');
}
function scrollToBook(body, smooth) {
  if (!body || !body.isConnected) return;
  // the chapter's plate (one filed under this book first: John 19 opens on John, not on Matthew 27), just below its sticky book heading
  const it = body.querySelector(`.art-g-sec[data-b="${state.book}"] .art-g-item.here`) || body.querySelector('.art-g-item.here');
  const sec = it ? null : G.filter === 'book' ? null : body.querySelector(`.art-g-sec[data-b="${state.book}"]`);
  let top = sec ? sec.offsetTop - 2 : 0;
  if (it) {
    const h = it.closest('.art-g-sec')?.querySelector('.art-g-h')?.offsetHeight || 0;
    top = body.scrollTop + it.getBoundingClientRect().top - body.getBoundingClientRect().top - h - 12;
    body.querySelectorAll('.art-g-item[tabindex="0"]').forEach(x => { if (x !== it) x.tabIndex = -1; });
    it.tabIndex = 0;                                    // Tab lands on the plate in view
  }
  body.scrollTo({ top: Math.max(0, top), behavior: smooth && !RM.matches ? 'smooth' : 'auto' });
}
function updateGallery(stage, body) {
  const c = counts();
  const bn = bookOf(state.book)?.name || 'This book';
  const bb = stage.querySelector('[data-art-f="book"]');
  if (bb) {
    bb.querySelector('.art-g-bn').textContent = bn;
    bb.querySelector('.art-g-c').innerHTML = cntHtml(c.book);
    if (c.book) bb.removeAttribute('aria-disabled'); else bb.setAttribute('aria-disabled', 'true');
  }
  if (G.filter === 'book' && G.book !== state.book) { fillGallery(body); body.scrollTop = 0; }
  else {
    const here = new Set(forChapter(state.book, state.chapter).map(p => p.id));
    body.querySelectorAll('.art-g-item').forEach(b => {
      const on = here.has(b.dataset.artG);
      if (b.classList.contains('here') !== on) {
        b.classList.toggle('here', on);
        const lbl = (b.getAttribute('aria-label') || '').replace(/ \(this chapter\)$/, '');
        b.setAttribute('aria-label', lbl + (on ? ' (this chapter)' : ''));
      }
    });
  }
  const sub = stage.querySelector('.art-g-sub'); if (sub) sub.innerHTML = subText(c);
}
function setFilter(stage, body, f) {
  if (!['all', 'book', 'ot', 'nt'].includes(f)) return;
  const btn = stage.querySelector(`[data-art-f="${f}"][role=radio]`);
  if (btn && btn.getAttribute('aria-disabled') === 'true') return;
  G.filter = f;
  stage.querySelectorAll('.art-g-filter [role=radio]').forEach(b => { const on = b.dataset.artF === f; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
  const row = stage.querySelector('.art-g-filter');   // a 320px phone: the row scrolls; keep the chosen pill in view (only the row moves)
  if (row && btn && row.scrollWidth > row.clientWidth) {
    const a = row.getBoundingClientRect(), b = btn.getBoundingClientRect();
    if (b.left < a.left) row.scrollLeft -= a.left - b.left + 2; else if (b.right > a.right) row.scrollLeft += b.right - a.right + 2;
  }
  fillGallery(body);
  const sub = stage.querySelector('.art-g-sub'); if (sub) sub.innerHTML = subText(counts());
  body.scrollTop = 0;
}
function bindGallery(stage, body) {
  const head = stage.querySelector('.art-g-head');
  body.addEventListener('error', onImgError, true);
  const onClick = e => {
    const t = e.target instanceof Element ? e.target : null; if (!t) return;
    const f = t.closest('[data-art-f]');
    if (f) { setFilter(stage, body, f.dataset.artF); if (f.getAttribute('role') !== 'radio') stage.querySelector('.art-g-filter [aria-checked="true"]')?.focus({ preventScroll: true }); return; }
    const it = t.closest('.art-g-item');
    if (it) {
      const [b, c, v] = it.dataset.go.split('.').map(Number);
      const away = !(state.book === b && state.chapter === c);
      // sel: the selection this click leaves behind (A.navigate selects v in another chapter; here it stays as it was)
      G.went = state.panel === 'art' ? { b, c, v, sel: away ? (v || null) : (state.selected || null) } : null;
      if (away) A?.navigate?.(b, c, v, state.panel === 'art' ? { panel: 'art' } : {});
      openViewer(it.dataset.artG, { returnFocus: it });
    }
  };
  head.addEventListener('click', onClick);
  body.addEventListener('click', onClick);
  head.addEventListener('keydown', e => {
    const r = e.target instanceof Element ? e.target.closest('.art-g-filter [role=radio]') : null; if (!r) return;
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(e.key)) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); r.click(); } return; }
    e.preventDefault(); e.stopPropagation();
    const list = [...stage.querySelectorAll('.art-g-filter [role=radio]')].filter(b => b.getAttribute('aria-disabled') !== 'true');
    let i = list.indexOf(r); if (i < 0) i = 0;
    i = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
    list[i].focus(); setFilter(stage, body, list[i].dataset.artF);
  });
  body.addEventListener('focusin', e => {
    const it = e.target instanceof Element ? e.target.closest('.art-g-item') : null; if (!it) return;
    body.querySelectorAll('.art-g-item[tabindex="0"]').forEach(x => { if (x !== it) x.tabIndex = -1; });
    it.tabIndex = 0;
  });
  body.addEventListener('keydown', e => {
    const it = e.target instanceof Element ? e.target.closest('.art-g-item') : null; if (!it) return;
    const k = e.key; if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(k) || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault(); e.stopPropagation();             // keep ←/→ from turning the chapter behind the panel
    const items = [...body.querySelectorAll('.art-g-item')];
    const i = items.indexOf(it); let n = null;
    if (k === 'ArrowLeft') n = items[i - 1];
    else if (k === 'ArrowRight') n = items[i + 1];
    else if (k === 'Home') n = items[0];
    else if (k === 'End') n = items[items.length - 1];
    else {
      const r = it.getBoundingClientRect(), mid = r.left + r.width / 2, down = k === 'ArrowDown';
      const rows = items.map(x => ({ x, r: x.getBoundingClientRect() })).filter(o => down ? o.r.top >= r.bottom - 2 : o.r.bottom <= r.top + 2);
      if (rows.length) {
        const edge = down ? Math.min(...rows.map(o => o.r.top)) : Math.max(...rows.map(o => o.r.bottom));
        const row = rows.filter(o => Math.abs((down ? o.r.top : o.r.bottom) - edge) < 4);
        n = row.reduce((best, o) => (!best || Math.abs(o.r.left + o.r.width / 2 - mid) < Math.abs(best.r.left + best.r.width / 2 - mid) ? o : best), null)?.x;
      }
    }
    if (n) { n.focus({ preventScroll: true }); n.scrollIntoView({ block: 'nearest', behavior: RM.matches ? 'auto' : 'smooth' }); }
  });
}
