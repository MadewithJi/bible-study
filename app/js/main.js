// Wiring: boot, the action object A, the study-sheet state machine, top bar, stage panels, picker,
// search, settings, dialogs, toast, keyboard, profiles (resume prompt, library marks) and the art panel.
import { icon } from './icons.js'; // first import: injects the icon sprite
import { state, data, bookOf, refLabel, refKey, parseReference, loadNotes, loadConfig, bindNotesLifecycle, esc, previewText, previewTr, DRY, lsGet, lsSet, layoutMode, onLayoutChange, RM, scrollBehavior, plural, clip, saveConfig, notesDiffer, restoreNotes, trInfo, guestBlocked } from './store.js';
import * as reader from './reader.js';
import * as drawer from './drawer.js';
import * as viz from './viz.js';
import { initAuth, initAccountUI, openAuth } from './account.js';
import { closeDialog, showDialog, menuOpen as uiMenuOpen, relTime } from './ui.js';

// Optional modules, loaded in parallel with the rest: a missing or broken library.js, tracker.js, art.js, links.js or marks.js
// must never stop the reader (every call goes through modCall).
const optional = (p, name) => p.catch(e => { console.error(`${name} failed to load`, e); return null; });
const modsP = Promise.all([
  optional(import('./library.js'), 'library.js'),
  optional(import('./tracker.js'), 'tracker.js'),
  optional(import('./art.js'), 'art.js'),
  optional(import('./links.js'), 'links.js'),
  optional(import('./marks.js'), 'marks.js'),
]);
let library = null, tracker = null, art = null, lnk = null, mrk = null;
function modCall(mod, name, ...args) {
  const fn = mod && mod[name]; if (typeof fn !== 'function') return undefined;
  try { const r = fn(...args); return r && typeof r.then === 'function' ? r.then(x => x, e => { console.error(e); return undefined; }) : r; }
  catch (e) { console.error(e); return undefined; }
}
const libCall = (name, ...args) => modCall(library, name, ...args);
const trkCall = (name, ...args) => modCall(tracker, name, ...args);
const artCall = (name, ...args) => modCall(art, name, ...args);
const lnkCall = (name, ...args) => modCall(lnk, name, ...args);
const mrkCall = (name, ...args) => modCall(mrk, name, ...args);
const has = (mod, name) => !!mod && typeof mod[name] === 'function';
const DAY = 86400000;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const TABS = ['xref', 'context', 'orig', 'notes', 'media', 'mine', 'search'];
/** The study panel's Mine tab (links-spec §3.3) is shown once drawer.js can draw it; until then it is never opened. */
const mineReady = () => { const t = document.getElementById('tab-mine'); return !!t && !t.hidden; };
const EXTERNAL = {
  niv: (b, c) => `https://www.biblegateway.com/passage/?search=${encodeURIComponent(bookOf(b).name + ' ' + c)}&version=NIV`,
  nkjv: (b, c) => `https://www.biblegateway.com/passage/?search=${encodeURIComponent(bookOf(b).name + ' ' + c)}&version=NKJV`,
  lsb: (b, c) => `https://read.lsbible.org/?q=${encodeURIComponent(bookOf(b).name + ' ' + c)}`,
};
const SKELETON = '<div class="skeleton" aria-busy="true"><i style="width:92%"></i><i style="width:70%"></i><i style="width:84%"></i><i style="width:56%"></i></div>';

/** Call a viz export if it exists; never let a visualisation error break the app. */
function vizCall(name, ...args) {
  const fn = viz[name]; if (typeof fn !== 'function') return undefined;
  try { const r = fn(...args); if (r && typeof r.catch === 'function') r.catch(e => console.error(e)); return r; } catch (e) { console.error(e); return undefined; }
}
const hideTip = () => { try { viz.tip?.hide?.(); } catch (e) { /* ignore */ } };

// ------------------------------------------------------------ actions shared with modules
const A = {
  navigate(b, c, v = 0, opts = {}) {
    hideResume();
    if (!opts.noHistory) { state.history.push({ b: state.book, c: state.chapter, v: state.selected }); state.future = []; if (state.history.length > 200) state.history.shift(); }
    state.book = b; state.chapter = c; state.selected = v || null;
    drawer.setOrigFocus(null);
    lnkCall('clearMineFocus'); // the Mine tab follows the reader again (links-spec §3.3)
    if (state.selected && state.drawerTab === 'search') state.drawerTab = 'xref';
    if (opts.panel) state.panel = opts.panel;
    renderReader({ scroll: opts.panel ? 'top' : true });
    drawer.renderDrawer();
    renderPanel();
    updateBar(); updateHash();
  },
  step(dir) { const t = reader.stepTarget(dir); if (t) A.navigate(t.b, t.c, 0); },
  select(v, o = {}) {
    v = +v; if (!v) return;
    if (o.tab === 'mine' && !mineReady()) { const { tab, ...rest } = o; o = rest; }
    const open = o.open !== false;
    const plain = !o.tab && o.word == null && !o.expand && !o.focus && !o.strong;
    // the same verse again: nothing to redraw, unless the Mine tab still shows a pick's source verse in another chapter
    if (plain && v === state.selected && state.drawerOpen && state.drawerTab !== 'search' && !lnkCall('mineFocus')) { reader.ensureVisible(v); return; }
    state.selected = v;
    document.dispatchEvent(new CustomEvent('bs:verse-selected', { detail: { b: state.book, c: state.chapter, v } }));
    if (o.word != null || o.strong) {
      const detail = { b: state.book, c: state.chapter, v };
      if (o.strong) detail.strong = o.strong;
      if (o.word != null) detail.word = o.word;
      document.dispatchEvent(new CustomEvent('bs:word-studied', { detail }));
    }
    drawer.setOrigFocus(o.strong ? { strong: o.strong, word: o.word } : (o.word != null ? { word: +o.word } : null));
    let dx = 0;
    if (o.tab && o.tab !== state.drawerTab) { dx = TABS.indexOf(o.tab) > TABS.indexOf(state.drawerTab) ? 18 : -18; state.drawerTab = o.tab; }
    else if (!o.tab && state.drawerTab === 'search') state.drawerTab = 'xref';
    reader.updateSelection(); vizCall('markSelection'); updateBar(); updateHash();
    const ro = { focus: !!o.focus, expand: o.expand, dx };
    if (open && !state.drawerOpen) openDrawer(ro); else drawer.renderDrawer(ro);
    if (state.panel === 'graph') renderPanel();
    reader.ensureVisible(v);
  },
  /** j/k and the sheet's verse stepper. Never opens a closed sheet. With nothing selected it starts where the reader is. */
  stepVerse(dir, o = {}) {
    const n = bookOf(state.book).chapters[state.chapter - 1];
    let v;
    if (state.selected) v = Math.min(n, Math.max(1, state.selected + dir));
    else v = Math.min(n, Math.max(1, verseInView()));
    if (v !== state.selected) A.select(v, { open: false });
    // the page is inert while the sheet is modal, so focus stays in the sheet then
    if (!o.keepFocus && !document.body.classList.contains('sheet-modal')) document.getElementById('v' + v)?.focus({ preventScroll: true });
  },
  refreshSelection() { reader.updateSelection(); vizCall('markSelection'); updateBar(); updateHash(); if (state.panel === 'graph') renderPanel(); },
  openTab(tab, o = {}) {
    if (tab === 'mine' && !mineReady()) { openDrawer(o); return; }
    const oi = TABS.indexOf(state.drawerTab), ni = TABS.indexOf(tab);
    state.drawerTab = tab;
    if (o.strong) drawer.setOrigFocus({ strong: o.strong }); else if (tab !== 'orig') drawer.setOrigFocus(null);
    const dx = o.dx ?? (ni === oi ? 0 : ni > oi ? 18 : -18);
    openDrawer({ ...o, dx });
  },
  openDrawer(o = {}) { openDrawer(o); },
  closeDrawer() { closeDrawer(); },
  toggleDrawer(on) { const want = on ?? !state.drawerOpen; if (want) openDrawer(); else closeDrawer(); },
  showPanel(p, force = false) {
    const prev = state.panel;
    state.panel = force ? p : (state.panel === p ? null : p); renderPanel();
    if (state.panel && prev) revealStage(); // switched panels (or 'Open full map'): the stage may sit far above the view
  },
  refreshMarker(v) { if (v) reader.refreshVerseMarker(v); drawer.renderHead(); },
  flash(list, o) { reader.flashVerses(list, o); },
  rerender() { render({ keepScroll: true }); },
  /** Note Markdown as HTML (marks.js's comments; links.js imports it from drawer.js itself). */
  renderMd(text) { return drawer.renderMd(text); },
  /** A typed or linked reference ('John 3:16–18'): true when it resolved and opened. */
  goReference(text) { const r = parseReference(String(text || '')); if (r) { openRef(r); return true; } toast(`Couldn’t find “${text}”.`); return false; },
  openSettings() { openSettings(); },
  search(q) { const s = $('#search'); s.value = q; $('#search-form').classList.toggle('has-value', !!q); runSearch(q); },
  showTopic(name) { return showTopic(name); },
  toast(msg, action) { toast(msg, action); },
  ensureVisible(v) { reader.ensureVisible(v); },
  /** After an in-sheet action moves the page: overlay closes; phone drops to the medium detent (or closes if hard). */
  yieldToPage(hard = false) { yieldToPage(hard); },

  // ---- profiles, bookmarks, library, reading progress (profiles-spec §5.13)
  /** Bookmark the selected verse, else the chapter (the Search tab bookmarks the chapter). */
  toggleBookmark(b = state.book, c = state.chapter, v) {
    if (v === undefined) v = (state.drawerOpen && state.drawerTab === 'search') ? 0 : (state.selected || 0);
    if (guestBlocked()) return undefined; // a hosted site's guest: the sign-in prompt (hosting brief §2)
    if (!has(library, 'toggleBookmark')) { toast('Bookmarks are unavailable right now. Reload to try again.'); return undefined; }
    return libCall('toggleBookmark', b, c, v);
  },
  /** The Library: home, a book ({book}), a bookmark ({bookmark: id}) or My map ({view: 'map', tag}: a link card's tag chip). */
  openLibrary(opts = {}) {
    if (!has(library, 'openLibrary')) { toast('The Library is unavailable right now. Reload to try again.'); return; }
    hideResume();
    const { book = null, bookmark = null, view = null, tag = null } = opts || {};
    libCall('openLibrary', { book, bookmark, view: view === 'map' ? 'map' : null, tag: view === 'map' && typeof tag === 'string' ? tag : null });
  },
  resume(pos, opts = {}) { resumeTo(pos, opts); },
  markRead(b, c, read) { return markRead(b, c, read); },
  onScopeChange(detail = {}) { return onScopeChange(detail); },
  /** Pick mode (links-spec §3.4): link the selected verse (or `ref`) to a verse chosen anywhere. Again: cancel. */
  startLinkPick(ref) {
    if (!has(lnk, 'startPick')) { toast('My links are unavailable right now. Reload to try again.'); return false; }
    if (lnkCall('picking')) { lnkCall('cancelPick'); return false; }
    if (guestBlocked()) return false;
    const from = ref && ref.v ? ref : (state.selected ? { b: state.book, c: state.chapter, v: state.selected } : null);
    if (!from) { toast('Select a verse first, then press c.'); return false; }
    hideResume();
    return !!lnkCall('startPick', from);
  },
  /** The sign-in dialog, saying why (a hosted site's guest tried to save: hosting brief §2). */
  signIn() { openAuth('signin', { reason: 'save' }); },
  stopVideo() { drawer.stopPlayer(); },
  closeDialog(d) { closeDialog(d); },
  showDialog(d) { showDialog(d); },
  refreshLibraryMarks() { refreshLibraryMarks(); },
  /** Doré engravings: the full-screen viewer for one plate. */
  openArt(id, opts) {
    if (!has(art, 'openViewer')) { toast('The engravings are unavailable right now. Reload to try again.'); return; }
    artCall('openViewer', id, opts);
  },
};

/** Every chapter render goes through here so focus restores can wait for the new DOM. */
let readerP = Promise.resolve();
function renderReader(opts = {}) { readerP = reader.renderReader(opts).catch(e => console.error(e)); return readerP; }
/** Open a parsed reference: its chapter with the first verse selected, and the rest of a range briefly emphasised. */
function openRef(r) {
  A.navigate(r.b, r.c, r.v);
  if (!r.v || !r.vend) return;
  const last = r.vend >= 1000 ? bookOf(r.b).chapters[r.c - 1] : r.vend, list = [];
  for (let i = r.v; i <= last; i++) list.push(i);
  readerP.then(() => { if (state.book === r.b && state.chapter === r.c) A.flash(list, { scroll: false }); });
}

function render(opts = {}) {
  renderReader(opts);
  drawer.renderDrawer({ keepScroll: !!opts.keepScroll });
  updateBar(); renderPanel();
}
const NAV_PAIR = { 'btn-prev': 'btn-next', 'btn-next': 'btn-prev', 'btn-back': 'btn-fwd', 'btn-fwd': 'btn-back' };
function updateBar() {
  const label = refLabel(state.book, state.chapter, state.selected);
  const t = $('#cur-ref-text');
  if (t) {   // the book name may shorten on a phone; the chapter and verse always show
    const m = label.match(/^(.*?)( \d[\d:–]*)$/) || [label, label, ''];
    t.innerHTML = `<span class="rb">${esc(m[1])}</span><span class="rc">${esc(m[2])}</span>`;
  } else if ($('#cur-ref')) $('#cur-ref').textContent = label;
  document.title = `${label} · Bible Study`;
  const off = { 'btn-prev': !reader.stepTarget(-1), 'btn-next': !reader.stepTarget(1), 'btn-back': !state.history.length, 'btn-fwd': !state.future.length };
  // a focused button that turns disabled would drop focus to <body>: set the others first (its partner may only now
  // become enabled), hand focus to the partner (or the reference), then disable the one that had it
  const ae = document.activeElement, pair = NAV_PAIR[ae?.id];
  Object.entries(off).forEach(([id, v]) => { if (id !== ae?.id) $('#' + id).disabled = v; });
  if (pair && off[ae.id]) (off[pair] ? $('#cur-ref') : $('#' + pair))?.focus({ preventScroll: true });
  if (pair) ae.disabled = off[ae.id];
  $('#btn-orig').setAttribute('aria-pressed', String(!!state.showOrig));
  $$('[data-panel-btn]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.panelBtn === state.panel)));
  $('#tr').value = state.tr; $('#tr2').value = state.tr2 || '';
  // the parallel is another translation (and, hosted, never the owner's ESV or NLT for anyone else)
  $$('#tr2 option').forEach(o => { o.disabled = !!o.value && (o.value === state.tr || (ownerOnlyKeys() && trInfo(o.value).kind === 'api')); });
  $('#tr2').closest('.pill-select')?.classList.toggle('on', !!state.tr2);
}
function updateHash() { const h = `#${state.book}/${state.chapter}${state.selected ? '/' + state.selected : ''}`; if (location.hash !== h) history.replaceState(null, '', location.pathname + location.search + h); }
/** `#b/c[/v]` → {b, c, v} clamped to the Bible (v 0 = no verse: '#43/3/0' is John 3), or null for any other hash. */
function parseHash() {
  const m = location.hash.match(/^#(\d+)\/(\d+)(?:\/(\d+))?/); if (!m) return null;
  const b = Math.min(66, Math.max(1, +m[1])), bk = bookOf(b);
  const c = Math.min(bk.chapters.length, Math.max(1, +m[2])), v = +m[3] || 0;
  return { b, c, v: v ? Math.min(bk.chapters[c - 1], v) : 0 };
}
function readHash() {
  const p = parseHash(); if (!p) return;
  state.book = p.b; state.chapter = p.c; state.selected = p.v || null;
}
function toggleOrig() { state.showOrig = !state.showOrig; updateBar(); renderReader(); }
/** The reading line, as tracker.js draws it: html's scroll-padding-top (bar + 28px), where a resume parks its verse. */
function readingLine() {
  let pad = NaN;
  try { pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop); } catch (e) { /* no layout */ }
  return (Number.isFinite(pad) && pad > 0 ? pad : Math.max(0, $('#topbar')?.getBoundingClientRect().bottom || 0) + 28) + 2;
}
/**
 * The verse j/k start from when none is selected: the roving (last focused) verse while it is on screen, else the
 * first verse reaching below the reading line (the one a resume parked there, or where the reader scrolled to).
 */
function verseInView() {
  const line = readingLine(), d = $('#drawer');
  const bottom = layoutMode() === 'sheet' && state.drawerOpen && d ? d.offsetTop : innerHeight;
  const rov = $('#reader .verse[tabindex="0"]');
  if (rov) { const r = rov.getBoundingClientRect(); if (r.bottom > line && r.top < bottom) return +rov.dataset.v; }
  const all = $$('#reader .verse');
  for (const el of all) if (el.getBoundingClientRect().bottom > line) return +el.dataset.v;
  // scrolled past the last verse (the chapter footer): start from the last one, not back at the top
  const last = all[all.length - 1];
  return +(last && last.getClientRects().length ? last.dataset.v : rov?.dataset.v || 1);
}

// ------------------------------------------------------------ study sheet state machine (spec §6)
let lastFocus = null, sheetMoveT = 0, curMode = layoutMode();

/** Reflect state.drawerOpen / sheetFull / layout mode into the DOM (§6.2). */
function syncDrawer() {
  const d = $('#drawer'); if (!d) return;
  const m = layoutMode(), open = !!state.drawerOpen, body = document.body;
  ['side', 'overlay', 'sheet'].forEach(x => body.classList.toggle('mode-' + x, x === m));
  if (m !== 'sheet' || !open) state.sheetFull = false;
  d.classList.toggle('open', open);
  d.inert = !open;
  d.setAttribute('aria-hidden', String(!open));
  body.classList.toggle('drawer-open', open);
  $('#btn-drawer')?.setAttribute('aria-expanded', String(open));
  if (!open) d.style.removeProperty('--drag');
  const full = open && m === 'sheet' && state.sheetFull;
  d.classList.toggle('full', full);
  $('#grabber')?.setAttribute('aria-label', full ? 'Collapse study sheet' : 'Expand study sheet');
  const modal = open && (m === 'overlay' || full);
  body.classList.toggle('sheet-modal', modal);
  d.setAttribute('aria-modal', String(modal));
  if (modal) hideResume(); // the prompt sits outside the inert page: it must not float over a modal sheet
  const page = $('#page'), bar = $('#topbar');
  if (page) page.inert = modal;
  if (bar) bar.inert = modal;
}
/** The text reflows (side push) or gets covered (phone detent): keep the selected verse in view. */
function afterSheetMove() {
  clearTimeout(sheetMoveT);
  if (!state.selected) return;
  const m = layoutMode();
  if (m === 'side') sheetMoveT = setTimeout(() => reader.ensureVisible(state.selected), 580);
  else if (m === 'sheet') sheetMoveT = setTimeout(() => reader.ensureVisible(state.selected), 520);
}
function openDrawer(o = {}) {
  if (!state.drawerOpen) {
    if (layoutMode() === 'sheet') hideResume(); // the prompt never sits on top of the phone sheet
    lastFocus = document.activeElement;
    state.drawerOpen = true;
    syncDrawer();
    const tabs = $('#drawer-tabs');
    if (tabs) { tabs.classList.add('no-anim'); drawer.moveInd(tabs); setTimeout(() => tabs.classList.remove('no-anim'), 50); }
    if (layoutMode() !== 'side' && !o.focus) setTimeout(() => { if (state.drawerOpen) $('#drawer-title')?.focus({ preventScroll: true }); }, 60);
    afterSheetMove();
  }
  drawer.renderDrawer(o);
}
function closeDrawer() {
  if (!state.drawerOpen) return;
  const d = $('#drawer'), ae = document.activeElement;
  const restore = !ae || ae === document.body || d.contains(ae);
  state.drawerOpen = false; state.sheetFull = false;
  drawer.closeMenu(false); hideTip();
  const player = $('#player'); if (player && player.innerHTML) { player.innerHTML = ''; player.hidden = true; } // stop a playing video
  syncDrawer();
  if (restore) {
    const prev = lastFocus;
    // wait for a pending chapter render (an in-sheet link may just have navigated) so #vN is the new element
    readerP.then(() => {
      const now = document.activeElement;
      if (now && now !== document.body && !d.contains(now)) return; // focus already moved on
      const v = state.selected && document.getElementById('v' + state.selected);
      const target = v || (prev && prev.isConnected && !d.contains(prev) ? prev : null);
      target?.focus?.({ preventScroll: true });
    });
  }
  lastFocus = null;
  afterSheetMove();
}
function setSheetFull(full) {
  if (layoutMode() !== 'sheet' || !state.drawerOpen || state.sheetFull === full) return;
  state.sheetFull = full; syncDrawer(); afterSheetMove();
}
function yieldToPage(hard = false) {
  if (!state.drawerOpen) return;
  const m = layoutMode();
  if (m === 'overlay') closeDrawer();
  else if (m === 'sheet') { if (hard) closeDrawer(); else setSheetFull(false); }
}
function onLayoutChange2() {
  const m = layoutMode();
  if (m === curMode) return;
  curMode = m;
  if (m === 'sheet') state.sheetFull = false;
  syncDrawer();
  drawer.moveInd($('#drawer-tabs'));
  const bar = $('#topbar'); if (m !== 'sheet') bar.classList.remove('hide');
}

/** Phone: drag the grabber or the sheet header; flick up for the full detent, down to collapse or close. */
function bindSheetDrag() {
  const d = $('#drawer'), grab = $('#grabber'), top = $('#sheet-top') || $('.sheet-top', d);
  let drag = null, suppressUntil = 0;
  const start = e => {
    if (layoutMode() !== 'sheet' || !state.drawerOpen || (e.button !== undefined && e.button > 0)) return;
    if (e.target.closest('button:not(.grabber), input, textarea, select, a, [role=tab]')) return;
    const now = performance.now();
    drag = { id: e.pointerId, el: e.currentTarget, y0: e.clientY, dy: 0, py: e.clientY, pt: now, vy: 0, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  };
  const move = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (!drag.moved && Math.abs(dy) < 4) return;
    if (!drag.moved) { drag.moved = true; d.classList.add('dragging'); }
    const now = performance.now();
    if (now - drag.pt >= 16) { drag.vy = (e.clientY - drag.py) / (now - drag.pt); drag.py = e.clientY; drag.pt = now; }
    drag.dy = dy;
    d.style.setProperty('--drag', Math.max(-40, dy) + 'px');
    if (e.cancelable) e.preventDefault();
  };
  const end = e => {
    if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.id)) return;
    const g = drag; drag = null;
    try { g.el.releasePointerCapture(g.id); } catch (err) { /* ignore */ }
    if (!g.moved) return; // a tap: the grabber's click handles it
    suppressUntil = performance.now() + 350;
    if (performance.now() - g.pt > 90) g.vy = 0; // finger rested before lifting: no flick
    d.classList.remove('dragging'); d.style.removeProperty('--drag');
    if (g.dy > 120 || g.vy > 0.7) { if (state.sheetFull) setSheetFull(false); else closeDrawer(); }
    else if (g.dy < -40 || g.vy < -0.7) setSheetFull(true);
    // otherwise the sheet springs back to its detent (the transition runs once --drag is removed)
  };
  [grab, top].filter(Boolean).forEach(h => {
    h.addEventListener('pointerdown', start);
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  });
  grab?.addEventListener('click', () => { if (performance.now() < suppressUntil || layoutMode() !== 'sheet') return; setSheetFull(!state.sheetFull); });
}

// ------------------------------------------------------------ stage panels (arcs / graph / map / art)
let stageClearT = 0, lastPanel = null, renderedPanel = null;
function renderPanel() {
  const p = $('#panel'), st = $('#stage'); if (!p || !st) return;
  const on = !!state.panel;
  const wasOpen = p.classList.contains('open');
  if (!on && p.contains(document.activeElement)) $(`[data-panel-btn="${lastPanel}"]`)?.focus({ preventScroll: true });
  p.classList.toggle('open', on); p.inert = !on; p.setAttribute('aria-hidden', String(!on));
  document.body.classList.toggle('panel-open', on);
  $$('[data-panel-btn]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.panelBtn === state.panel)));
  if (renderedPanel === 'art' && state.panel !== 'art') artCall('stop'); // leaving the gallery
  vizCall('stopPanel');
  clearTimeout(stageClearT);
  if (!on) { renderedPanel = null; hideTip(); stageClearT = setTimeout(() => { if (!state.panel) st.innerHTML = ''; }, 560); return; }
  lastPanel = state.panel;
  renderedPanel = state.panel;
  if (state.panel === 'art') {
    if (has(art, 'renderGallery')) artCall('renderGallery', st);
    else st.innerHTML = `<div class="stage-head"><div class="stage-titles"><h2 class="stage-title" id="stage-title">Bible art</h2><p class="stage-sub">Gustave Doré, 1866</p></div><span class="spacer"></span><button class="close-btn" type="button" data-close-panel aria-label="Close Bible art" title="Close (Esc)">${icon('xmark')}</button></div><div class="stage-body"><div class="stage-empty">The engravings could not be loaded. Reload the page to try again.</div></div>`;
  } else vizCall({ arcs: 'renderArcs', graph: 'renderGraph', map: 'renderMap' }[state.panel], st);
  if (!wasOpen) revealStage();
}
/** Scroll up to the stage when its top is hidden above the top bar. */
function revealStage() {
  const p = $('#panel'); if (!p) return;
  const barBottom = $('#topbar').getBoundingClientRect().bottom;
  if (p.getBoundingClientRect().top < barBottom) window.scrollTo({ top: 0, behavior: scrollBehavior() });
}

// ------------------------------------------------------------ book picker
function buildPicker() {
  const cols = { OT: new Map(), NT: new Map() };
  state.books.forEach(b => { const m = cols[b.test] || cols.NT; if (!m.has(b.div)) m.set(b.div, []); m.get(b.div).push(b); });
  $('#picker-books').innerHTML = ['OT', 'NT'].map(t => `<section class="pcol"><h3>${t === 'OT' ? 'Old Testament' : 'New Testament'}</h3>${[...cols[t].entries()].map(([d, list]) => `<div class="pgroup"><h4><i class="${t.toLowerCase()}"></i>${esc(d)}</h4><div class="pbooks">${list.map(b => `<button class="pbook" type="button" data-b="${b.n}" data-name="${esc(b.name.toLowerCase())}">${esc(b.name)}</button>`).join('')}</div></div>`).join('')}</section>`).join('')
    + '<div class="empty pempty" role="status" style="grid-column:1/-1" hidden></div>';
}
/** The filter matches nothing: say so, and the chapter grid (of a book no longer listed) stays out of reach. */
function pickerNone(q) {
  const none = !!q, e = $('#picker-books .pempty'), pc = $('#picker-chapters');
  if (e) { e.textContent = none ? `No books match “${q}”.` : ''; e.hidden = !none; }
  if (pc) { pc.inert = none; pc.style.opacity = none ? '.35' : ''; }
}
let pickerBook = null;
const CHK = '<svg class="i pch-chk" aria-hidden="true"><use href="#i-check"/></svg>';
/** Read state of a chapter from library.js (null when the library is unavailable). */
function chapterRead(b, c) { try { return has(library, 'chapterState') ? !!(library.chapterState(b, c) || {}).read : false; } catch (e) { return false; } }
function showChapters(b) {
  const bk = bookOf(b); if (!bk) return;
  pickerBook = b;
  const max = Math.max(1, ...Object.values(bk.xo || {}));
  const noted = new Set(Object.keys(state.notes.refs).filter(k => k.startsWith(b + '.')).map(k => +k.split('.')[1]));
  const focusedC = document.activeElement?.closest?.('#picker-chapters .pch')?.dataset.c;
  $('#picker-chapters').innerHTML = `<h3 class="pc-title">${esc(bk.name)}</h3><p class="pc-sub">${plural(bk.chapters.length, 'chapter')} · ${esc(bk.div)}</p>
    <div class="chgrid">${bk.chapters.map((n, i) => {
      const c = i + 1, links = (bk.xo || {})[c] || 0, h = Math.sqrt(links / max), cur = b === state.book && c === state.chapter, read = chapterRead(b, c);
      return `<button class="pch${h > .55 ? ' hot' : ''}${cur ? ' cur' : ''}${noted.has(c) ? ' noted' : ''}${read ? ' read' : ''}" type="button" data-b="${b}" data-c="${c}" style="--h:${h.toFixed(2)}" title="${n} verses · ${links.toLocaleString()} links${read ? ' · read' : ''}" aria-label="Chapter ${c}, ${n} verses, ${links} links${noted.has(c) ? ', has notes' : ''}${read ? ', read' : ''}"${cur ? ' aria-current="true"' : ''}>${c}${read ? CHK : ''}</button>`;
    }).join('')}</div>
    <div class="heat-legend" aria-hidden="true"><span>Fewer links</span><i></i><span>More</span></div>`;
  $$('#picker-books .pbook').forEach(x => { const on = +x.dataset.b === b; x.classList.toggle('on', on); if (on) x.setAttribute('aria-current', 'true'); else x.removeAttribute('aria-current'); });
  if (focusedC) $(`#picker-chapters .pch[data-c="${focusedC}"]`)?.focus({ preventScroll: true });
}
/** A thin progress rule under each book with read chapters. */
function markPickerBooks() {
  $$('#picker-books .pbook').forEach(x => {
    let p = null;
    try { p = has(library, 'bookProgress') ? library.bookProgress(+x.dataset.b) : null; } catch (e) { p = null; }
    const read = p ? +p.read || 0 : 0;
    x.classList.toggle('prog', read > 0);
    if (read > 0) {
      const frac = Number.isFinite(+p.frac) ? +p.frac : read / Math.max(1, +p.total || bookOf(+x.dataset.b).chapters.length);
      x.style.setProperty('--p', Math.max(0.04, Math.min(1, frac)).toFixed(3));
      x.title = `${read} of ${p.total || bookOf(+x.dataset.b).chapters.length} chapters read`;
    } else { x.style.removeProperty('--p'); x.removeAttribute('title'); }
  });
}
function refreshPicker() { if (!$('#picker')?.open) return; if (pickerBook) showChapters(pickerBook); markPickerBooks(); }
function openPicker() {
  const d = $('#picker'); const f = $('#picker-filter'); if (f) f.value = '';
  $$('#picker-books .pbook, #picker-books .pgroup, #picker-books .pcol').forEach(x => { x.hidden = false; });
  pickerNone('');
  showChapters(state.book);
  markPickerBooks();
  showDialog(d);
  setTimeout(() => $(`#picker-books .pbook[data-b="${state.book}"]`)?.focus(), 30);
}
function bindPicker() {
  $('#picker-books').addEventListener('click', e => {
    const b = e.target.closest('.pbook'); if (!b) return;
    showChapters(+b.dataset.b);
    // chosen with Enter/Space: go on to its chapters, which follow all 66 books in the tab order
    if (e.detail === 0) ($('#picker-chapters .pch.cur') || $('#picker-chapters .pch'))?.focus({ preventScroll: true });
  });
  $('#picker-chapters').addEventListener('click', e => { const c = e.target.closest('.pch'); if (c) { closeDialog($('#picker')); A.navigate(+c.dataset.b, +c.dataset.c, 0); } });
  // and Shift+Tab from the first chapter goes straight back to the chosen book
  $('#picker-chapters').addEventListener('keydown', e => {
    if (e.key !== 'Tab' || !e.shiftKey || e.target !== $('#picker-chapters .pch')) return;
    const on = $('#picker-books .pbook.on'); if (on && on.getClientRects().length) { e.preventDefault(); on.focus(); } // not when filtered out
  });
  const f = $('#picker-filter');
  f?.addEventListener('input', () => {
    const q = f.value.toLowerCase().trim(); let first = null;
    const alias = q ? parseReference(q)?.b : 0; // the search box's names too: 'sos', 'revelations', '1cor', 'john 3'
    $$('#picker-books .pbook').forEach(x => {
      const bk = bookOf(+x.dataset.b);
      const hit = !q || +x.dataset.b === alias || x.dataset.name.includes(q) || String(bk.short || '').toLowerCase().startsWith(q) || String(bk.osis || '').toLowerCase().startsWith(q);
      x.hidden = !hit; if (hit && !first) first = x;
    });
    $$('#picker-books .pgroup, #picker-books .pcol').forEach(g => { g.hidden = !$$('.pbook', g).some(x => !x.hidden); });
    pickerNone(q && !first ? f.value.trim() : '');
    if (q && first) showChapters(+first.dataset.b);
  });
  f?.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // a full reference ('john 3', 'ps 23:4') opens at once; otherwise on to the chapters of the book shown, if it is listed
    const q = f.value.trim(), ref = /[a-z]\.?\s*\d/i.test(q) ? parseReference(q) : null;
    if (ref) { closeDialog($('#picker')); openRef(ref); return; }
    if ($('#picker-books .pbook:not([hidden])')) $('#picker-chapters .pch')?.focus();
  });
}

// ------------------------------------------------------------ dialogs (closeDialog / showDialog live in ui.js)
function bindDialogs() {
  $$('dialog').forEach(d => {
    // a dialog that is waiting on serve.py (data-busy) stays open until the answer arrives
    // a backdrop click closes only when the press began on the backdrop too: a drag-select that ends outside does not
    d.addEventListener('pointerdown', e => { d._downOnBackdrop = e.target === d; });
    d.addEventListener('click', e => {
      const close = e.target.closest('[data-close]') || (e.target === d && d._downOnBackdrop);
      d._downOnBackdrop = false;
      if (close && !d.dataset.busy) closeDialog(d);
    });
    d.addEventListener('cancel', e => { e.preventDefault(); if (!d.dataset.busy) closeDialog(d); });
    // Chrome lets a page prevent `cancel` only once per user activation, so a second Esc closes the dialog anyway:
    // a busy dialog that was closed that way opens again at once
    d.addEventListener('close', () => { if (d.dataset.busy && !d.open) { try { showDialog(d); } catch (err) { console.error(err); } } });
  });
  // Esc while a dialog is busy: cancel the key itself, so no close request reaches the dialog at all
  // (focus may be on <body> after the busy button was disabled, hence a document-level listener)
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.querySelector('dialog[open][data-busy]')) e.preventDefault(); }, true);
}
function openHelp() { showDialog($('#help')); }

// ------------------------------------------------------------ settings
function setRangeFill(r) { const min = +r.min || 0, max = +r.max || 100; r.style.setProperty('--p', (100 * (+r.value - min) / (max - min || 1)) + '%'); }
const DARK_MQ = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : { matches: false };
const resolvedTheme = () => (state.theme === 'light' || state.theme === 'dark') ? state.theme : (DARK_MQ.matches ? 'dark' : 'light');
/** The top-bar button shows where a click takes you: a moon in light mode, a sun in dark mode. */
function syncThemeBtn() {
  const b = $('#btn-theme'); if (!b) return;
  const dark = resolvedTheme() === 'dark';
  b.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  b.title = `${dark ? 'Light' : 'Dark'} mode (t)`;
  b.querySelector('use')?.setAttribute('href', dark ? '#i-sun' : '#i-moon');
}
function toggleTheme() {
  const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
  const go = () => applyTheme(next, true);
  if (!RM.matches && !document.hidden && document.startViewTransition) {
    // A skipped or aborted transition (fast repeated toggles) rejects these; the theme still applies.
    const vt = document.startViewTransition(go);
    [vt.ready, vt.finished, vt.updateCallbackDone].forEach(p => p && p.catch(() => {}));
  } else go();
  const svg = $('#btn-theme svg');
  if (svg && !RM.matches && svg.animate) svg.animate([{ transform: 'rotate(-90deg) scale(.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(.32,.72,0,1)' });
}
function applyTheme(t, persist = false) {
  if (!['auto', 'light', 'dark'].includes(t)) t = 'auto';
  state.theme = t;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  // the browser chrome (Safari's tab bar, a phone's status bar) follows the chosen theme, or the OS for 'auto'
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
    if (m.dataset.color === undefined) { m.dataset.media = m.getAttribute('media') || 'all'; m.dataset.color = m.content; }
    if (t === 'auto') { m.setAttribute('media', m.dataset.media); m.content = m.dataset.color; }
    else { m.setAttribute('media', 'all'); m.content = t === 'dark' ? '#000000' : '#fbfbfd'; }
  });
  if (persist) lsSet('bs-theme', t);
  const th = $('#theme'); if (th) drawer.setRadio(th, b => b.dataset.themeOpt === t);
  vizCall('refreshTheme');
  syncThemeBtn();
}
/** An API key row: the placeholder says whether a key is saved, and Remove shows only then. */
function syncKeyRow(id) {
  const f = $(`#${id}-key`); if (!f) return;
  f.placeholder = state.apiKeys[id] ? 'Saved. Paste a new key to replace.' : 'Paste key';
  const rm = $(`[data-key-remove="${id}"]`); if (rm) rm.hidden = !state.apiKeys[id];
}
/** The footer button saves when a key was typed, and otherwise just closes (the appearance applies as it changes). */
function syncSettingsDone() { const b = $('#settings-done'); if (b) b.textContent = ($('#esv-key').value.trim() || $('#nlt-key').value.trim()) ? 'Save' : 'Done'; }
async function removeKey(id) {
  const t = trInfo(id), f = $(`#${id}-key`);
  if (DRY) { toast(`Dry run: the ${t.abbr} key was not removed.`); return; }
  try { await saveConfig({ [id + 'Key']: '' }); }
  catch (err) { toast(`Could not remove the ${t.abbr} key. Is serve.py running?`); return; }
  // the text that needed this key falls back to the KJV (and a parallel column that would now repeat it closes)
  if (state.tr === id) { state.tr = 'kjv'; lsSet('bs-tr', 'kjv'); }
  if (state.tr2 === id || state.tr2 === state.tr) { state.tr2 = ''; lsSet('bs-tr2', ''); }
  if (state.notice?.tr === id) state.notice = null;
  syncKeyRow(id); f?.focus(); // the Remove button is gone: focus stays in the row
  toast(`${t.abbr} key removed.`);
  render({ keepScroll: true });
}
function openSettings() {
  const d = $('#settings'); if (!d) return;
  // hosted, only the owner sees (and may change) the ESV and NLT keys; serve.py refuses anyone else
  const off = ownerOnlyKeys(), kr = $('#key-rows'), ko = $('#keys-owner'), kf = $('#keys-foot');
  if (kr) kr.hidden = off; if (ko) ko.hidden = !off; if (kf) kf.hidden = off;
  if (kf && state.auth.hosted) kf.innerHTML = kf.innerHTML.replace('cached on this computer', 'cached on the server');
  $('#esv-key').value = ''; $('#nlt-key').value = '';
  syncKeyRow('esv'); syncKeyRow('nlt'); syncSettingsDone();
  const fs = $('#fontsize');
  const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--read-size')) || 20;
  fs.value = String(Math.round(cur)); setRangeFill(fs);
  const af = $('#art-float'), afRow = $('#art-float-row');
  if (af && afRow) { const ok = has(art, 'setPlates') && has(art, 'platesEnabled'); afRow.hidden = !ok; if (ok) af.checked = !!artCall('platesEnabled'); }
  const wo = $('#woc-on'); if (wo) wo.checked = !document.documentElement.classList.contains('woc-off');
  showDialog(d);
  const th = $('#theme');
  if (th) { th.classList.add('no-anim'); drawer.setRadio(th, b => b.dataset.themeOpt === state.theme); setTimeout(() => th.classList.remove('no-anim'), 50); }
}
function bindSettings() {
  const th = $('#theme');
  if (th) {
    th.addEventListener('click', e => { const b = e.target.closest('[data-theme-opt]'); if (b) applyTheme(b.dataset.themeOpt, true); });
    th.addEventListener('keydown', e => drawer.radioKeys(e, th, b => applyTheme(b.dataset.themeOpt, true)));
    if ('ResizeObserver' in window) new ResizeObserver(() => drawer.moveInd(th)).observe(th);
  }
  const fs = $('#fontsize');
  fs.addEventListener('input', () => { document.documentElement.style.setProperty('--read-size', fs.value + 'px'); lsSet('bs-font', fs.value); setRangeFill(fs); });
  // "Show Doré engravings in the text" (inline plates and the floating card) applies at once, like the theme and the reading size
  $('#art-float')?.addEventListener('change', e => { artCall('setPlates', !!e.target.checked); });
  $('#woc-on')?.addEventListener('change', e => { const on = !!e.target.checked; document.documentElement.classList.toggle('woc-off', !on); lsSet('bs-woc', on ? '1' : '0'); });
  ['esv', 'nlt'].forEach(id => {
    $(`#${id}-key`)?.addEventListener('input', syncSettingsDone);
    $(`[data-key-remove="${id}"]`)?.addEventListener('click', () => removeKey(id));
  });
  $('#settings-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = {}; const esv = $('#esv-key').value.trim(), nlt = $('#nlt-key').value.trim();
    if (esv) body.esvKey = esv; if (nlt) body.nltKey = nlt;
    if (Object.keys(body).length) {
      if (DRY) toast('Dry run: API keys were not saved.');
      else {
        try { await saveConfig(body); toast('API keys saved.'); }
        catch (err) { toast('Could not save the keys. Is serve.py running?'); return; }
      }
    }
    // the "ESV needs an API key" card asked for this key: switch to that translation now and drop the card
    const n = state.notice;
    if (n && state.apiKeys[n.tr]) {
      const w = n.which === 'tr2' ? 'tr2' : 'tr';
      if (state[w === 'tr' ? 'tr2' : 'tr'] !== n.tr) { state[w] = n.tr; lsSet('bs-' + w, n.tr); }
      state.notice = null;
    }
    $('#esv-key').value = ''; $('#nlt-key').value = ''; syncSettingsDone();
    closeDialog($('#settings'));
    render({ keepScroll: true });
  });
}

// ------------------------------------------------------------ toast
/* A modal dialog (Library, Profile, Settings, Confirm, the art viewer) paints over the rest of the page and makes it
   inert, so while one is open the toast and the resume prompt live inside the topmost one (as ui.openMenu does for
   menus) and go back to <body> when it closes. */
const openDialogs = []; // in the order they opened: the top layer's order
const isModal = d => { try { return d.matches(':modal'); } catch (e) { return true; } };
function topDialog() {
  for (let i = openDialogs.length - 1; i >= 0; i--) {
    const d = openDialogs[i];
    if (d.open && d.isConnected && !d.classList.contains('closing') && isModal(d)) return d;
  }
  return null;
}
let floatsWait = false;
function placeFloats(now = false) {
  const host = topDialog() || document.body;
  // a dialog's entrance animation (a transform) would make it their containing block: move in once it has ended
  const anims = now || host === document.body ? [] : host.getAnimations().filter(a => a.playState === 'running');
  let wait = false;
  ['toast', 'resume'].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    // never the resume card in the art viewer: its glass would take the viewer's dark tokens (light text on light glass),
    // and its Continue would close the viewer behind art.js's back. It steps aside instead (the toast's colours are its own).
    if (id === 'resume' && !el.hidden && host.classList.contains('art-viewer')) {
      if (!el.classList.contains('out')) hideResume();
      return;
    }
    const want = el.hidden ? document.body : host;
    if (el.parentNode === want) return;
    if (want !== document.body && anims.length) wait = true; else want.appendChild(el);
  });
  if (wait && !floatsWait) {
    floatsWait = true;
    Promise.race([Promise.all(anims.map(a => a.finished)), new Promise(r => setTimeout(r, 600))]).catch(() => {})
      .then(() => { floatsWait = false; placeFloats(true); });
  }
}
function bindFloats() {
  if (typeof MutationObserver === 'undefined') return;
  const mo = new MutationObserver(recs => {
    for (const r of recs) {
      const d = r.target; if (d.tagName !== 'DIALOG' || r.attributeName !== 'open') continue;
      const i = openDialogs.indexOf(d); if (i >= 0) openDialogs.splice(i, 1);
      if (d.open) { openDialogs.push(d); mo.observe(d, { attributes: true, attributeFilter: ['open', 'class'] }); } // .closing: leave before it animates out
    }
    placeFloats();
  });
  mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] }); // the art viewer is added later
}
let toastT = 0, toastOutT = 0, toastAction = null;
function toast(msg, action) {
  const t = $('#toast'); if (!t) return;
  clearTimeout(toastT); clearTimeout(toastOutT);
  toastAction = action || null;
  t.classList.remove('out'); t.hidden = false;
  placeFloats();
  // Z (Alt+Z in a text field) runs the action from the keyboard (bindKeyboard)
  t.innerHTML = `<span class="toast-msg">${esc(msg)}</span>${action ? `<span class="sr"> Press Z for ${esc(action.label || 'Undo')}.</span><button type="button" class="toast-act" aria-keyshortcuts="Z Alt+Z">${esc(action.label || 'Undo')}<kbd class="toast-key" aria-hidden="true">Z</kbd></button>` : ''}`;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  toastT = setTimeout(hideToast, action ? 10000 : 4200);
}
function hideToast() {
  const t = $('#toast'); if (!t || t.hidden) return;
  clearTimeout(toastT); t.classList.add('out');
  clearTimeout(toastOutT); toastOutT = setTimeout(() => { t.hidden = true; t.classList.remove('out'); placeFloats(); }, RM.matches ? 0 : 300);
}
function runToastAction() { const a = toastAction; toastAction = null; hideToast(); try { a?.run?.(); } catch (err) { console.error(err); } }
function bindToast() {
  const t = $('#toast'); if (!t) return;
  bindFloats();
  t.addEventListener('click', e => { if (e.target.closest('.toast-act')) runToastAction(); });
  // pause while the pointer or focus is on it (time to reach Undo)
  const pause = () => clearTimeout(toastT);
  const resume = () => { if (!t.hidden && !t.classList.contains('out')) { clearTimeout(toastT); toastT = setTimeout(hideToast, 2500); } };
  t.addEventListener('pointerenter', pause); t.addEventListener('pointerleave', resume);
  t.addEventListener('focusin', pause); t.addEventListener('focusout', resume);
}

// ------------------------------------------------------------ search
const allTextCache = {}, indexCache = {};
async function loadAllText(tr) {
  if (!allTextCache[tr]) allTextCache[tr] = Promise.all(state.books.map(b => data.bible(tr, b.n))).catch(e => { delete allTextCache[tr]; throw e; });
  return allTextCache[tr];
}
/** Fold text for matching: case, curly apostrophes and quotes (the bundled texts use ’ ‘ “ ”; keyboards type ' "), and the KJV's æ (Cæsar). */
const fold = s => String(s || '').toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/æ/g, 'ae');
/** Every verse of a bundled translation in canonical order, with its folded text for a quick first filter.
 *  The psalm titles and Psalm 119's letter headings (19-titles.json, shown above their verse) come just before it. */
async function loadIndex(tr) {
  if (!indexCache[tr]) {
    indexCache[tr] = Promise.all([loadAllText(tr), data.titles(tr, 19)]).then(([books, ti]) => {
      const out = [], sup = (ti && ti.sup) || {}, head = (ti && ti.head) || {};
      const add = (b, c, v, t, title) => { t = String(t || ''); if (t) out.push({ b, c, v, t, n: fold(t), title }); };
      books.forEach((bk, bi) => Object.entries(bk || {}).forEach(([c, verses]) => (verses || []).forEach((t, i) => {
        if (bi === 18) { if (!i) add(19, +c, 1, sup[c], 'title'); add(19, +c, i + 1, (head[c] || {})[i + 1], 'heading'); }
        t = String(t || ''); out.push({ b: bi + 1, c: +c, v: i + 1, t, n: fold(t) });
      })));
      return out;
    }).catch(e => { delete indexCache[tr]; throw e; });
  }
  return indexCache[tr];
}
// Word matching runs on the original text: a letter or digit may not touch a term's start (so 'one' never matches
// 'gone', 'so' never 'Son'); a whole word may not continue either. ' and " in a term also match the curly forms.
const WB = '(?<![\\p{L}\\p{N}])', WE = '(?![\\p{L}\\p{N}])', WREST = '[\\p{L}\\p{N}]*', WSEP = '[^\\p{L}\\p{N}]+';
const termSrc = w => [...w].map(ch => ch === "'" ? "['‘’ʼ]" : ch === '"' ? '["“”]' : ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('').replace(/ae/g, '(?:ae|æ)');
/**
 * A typed query → its matchers. "Quoted words" must appear together as whole words. Otherwise every word must
 * appear (any order) as a whole word, or as the start of a word when it has 3+ letters (love → loved, loveth).
 * Tiers rank the hits: 0 the words together as typed, 1 every word whole, 2 the rest (word starts).
 */
function searchQuery(q) {
  let s = fold(q).trim();
  const quoted = /^"(.+)"$/.exec(s); if (quoted) s = quoted[1];
  const words = s.split(/\s+/).map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
  const terms = [...new Set(words)];
  if (!terms.length) return null;
  const rx = src => new RegExp(src, 'iu');
  const phraseSrc = WB + words.map(termSrc).join(WSEP) + WE;
  const phrase = words.length > 1 || quoted ? rx(phraseSrc) : null;
  const whole = terms.map(w => rx(WB + termSrc(w) + WE));
  const start = terms.map((w, i) => (quoted || w.length < 3 ? whole[i] : rx(WB + termSrc(w))));
  // highlight: the words together first, then each word (a word start is marked to the end of its word); quoted: the phrase only
  const alts = quoted ? [] : terms.map(w => WB + termSrc(w) + (w.length < 3 ? WE : WREST));
  return {
    terms, words, quoted: !!quoted,
    mark: new RegExp((phrase ? [phraseSrc] : []).concat(alts).join('|'), 'giu'),
    tier(h) {
      if (!terms.every(w => h.n.includes(w))) return -1; // quick filter on the folded text
      if (quoted) return phrase.test(h.t) ? 0 : -1;
      if (!start.every(r => r.test(h.t))) return -1;
      if (phrase && phrase.test(h.t)) return 0;
      return whole.every(r => r.test(h.t)) ? 1 : 2;
    },
  };
}
let searchSeq = 0;
const SEARCH_PAGE = 200;
/** The last word search: {seq, title, q, tr, ref, topics, hits, nOT, filter: 'all'|'ot'|'nt', shown, rx}. */
let found = null;
const noVerses = `<div class="empty"><span class="tile-i blue">${icon('search')}</span><h4>No verses found</h4><p>Try fewer words, a reference like <i>rom 8:28</i>, or a Strong’s number like <i>G26</i>.</p></div>`;
function goFullForSearch() { if (layoutMode() === 'sheet') { state.sheetFull = true; if (state.drawerOpen) syncDrawer(); } }
const hitList = s => (s.filter === 'all' ? s.hits : s.hits.filter(h => (h.b <= 39) === (s.filter === 'ot')));
function markHit(s, text) {
  let out = '', last = 0;
  text.replace(s.rx, (m, ...a) => { const off = a[a.length - 2]; out += esc(text.slice(last, off)) + `<mark>${esc(m)}</mark>`; last = off + m.length; return m; });
  return out + esc(text.slice(last));
}
const hitRows = (s, from, to) => hitList(s).slice(from, to).map(h => `<li><button class="cell" type="button" data-go="${h.b}.${h.c}.${h.v}"><span class="cell-body"><span class="cell-title">${esc(h.title === 'title' ? `${refLabel(h.b, h.c)} · title` : h.title ? `${refLabel(h.b, h.c, h.v)} · heading` : refLabel(h.b, h.c, h.v))}</span><span class="cell-sub serif clamp3">${markHit(s, h.t)}</span></span>${icon('chev-right', 'chev')}</button></li>`).join('');
/** "546 verses · KJV", or "200 of 546 verses · KJV" while more are left to show. */
function hitCount(s) { const n = hitList(s).length; return `${s.shown < n ? `${s.shown.toLocaleString()} of ` : ''}${plural(n, 'verse')} · ${s.tr.toUpperCase()}`; }
function moreLabel(s) { const rest = hitList(s).length - s.shown; return rest > 0 ? `Show ${Math.min(SEARCH_PAGE, rest).toLocaleString()} more` : ''; }
function searchHtml(s) {
  const n = s.hits.length, nNT = n - s.nOT, more = moreLabel(s);
  const radio = (val, label, count) => { const on = s.filter === val; return `<button type="button" role="radio" data-sf="${val}" aria-checked="${on}" tabindex="${on ? 0 : -1}"${count ? '' : ' disabled'}>${label} ${count.toLocaleString()}</button>`; };
  return `${s.topics.length ? `<div class="lh"><h3>Topics</h3><span>${s.topics.length}</span></div><div class="topic-chips">${s.topics.map(t => `<button class="chip" type="button" data-topic="${esc(t.name)}">${icon('sparkle')}${esc(t.label || t.name)}</button>`).join('')}</div>` : ''}
    <div class="lh"><h3>${esc(s.title)}</h3><span id="search-count">${n ? hitCount(s) : `0 verses · ${s.tr.toUpperCase()}`}</span></div>
    ${s.ref ? `<p class="foot-note">Or open <button class="link" type="button" data-go="${s.ref.b}.${s.ref.c}.${s.ref.v}">${esc(refLabel(s.ref.b, s.ref.c, s.ref.v))}</button></p>` : ''}
    ${n ? `<div class="filter-row"><div class="segmented sm" id="sfilter" role="radiogroup" aria-label="Filter by testament"><span class="seg-ind" aria-hidden="true"></span>${radio('all', 'All', n)}${radio('ot', 'Old', s.nOT)}${radio('nt', 'New', nNT)}</div></div>
    <ul class="group" id="search-hits">${hitRows(s, 0, s.shown)}</ul><button class="btn btn-gray btn-wide" type="button" data-more-hits="${s.seq}"${more ? '' : ' hidden'}>${more || 'Show more'}</button>` : noVerses}`;
}
/** Show more / the testament filter: change the list in place (focus and scroll stay), then store the new markup for later redraws. */
function updateHits(s, append) {
  const root = $('#drawer-body'), ul = root && $('#search-hits', root);
  if (ul && state.drawerTab === 'search') {
    const from = append ? ul.children.length : 0, btn = $('[data-more-hits]', root), hadFocus = !!btn && document.activeElement === btn;
    if (append) ul.insertAdjacentHTML('beforeend', hitRows(s, from, s.shown)); else ul.innerHTML = hitRows(s, 0, s.shown);
    const cnt = $('#search-count', root); if (cnt) cnt.textContent = hitCount(s);
    const more = moreLabel(s);
    if (btn) { btn.hidden = !more; if (more) btn.textContent = more; }
    drawer.setRadio($('#sfilter', root), b => b.dataset.sf === s.filter);
    // the button went away under the keyboard: continue on the first row it added
    if (append && hadFocus && !more) ul.children[from]?.querySelector('.cell')?.focus({ preventScroll: true });
  }
  drawer.setSearchResults(s.title, searchHtml(s));
}
function bindSearchResults() {
  $('#drawer-body')?.addEventListener('click', e => {
    // 'Revelation has 22 chapters. Open Revelation 22': that passage, with its own tab instead of this message
    const go = e.target.closest('[data-ref-go]');
    if (go && state.drawerTab === 'search') { const [b, c, v] = go.dataset.refGo.split('.').map(Number); state.drawerTab = v ? 'xref' : 'context'; A.navigate(b, c, v); A.yieldToPage(); return; }
    const s = found; if (!s || state.drawerTab !== 'search') return;
    const more = e.target.closest('[data-more-hits]');
    if (more) { if (+more.dataset.moreHits === s.seq) { s.shown = Math.min(hitList(s).length, s.shown + SEARCH_PAGE); updateHits(s, true); } return; }
    const f = e.target.closest('#sfilter [data-sf]');
    if (f && !f.disabled && f.dataset.sf !== s.filter) { s.filter = f.dataset.sf; s.shown = Math.min(hitList(s).length, SEARCH_PAGE); updateHits(s, false); }
  });
}
/** A Strong's number that has neither a lexicon entry nor any occurrence. */
const noStrong = id => `<div class="empty"><span class="tile-i blue">${icon('search')}</span><h4>No Strong’s entry ${esc(id)}</h4><p>Strong’s numbers run from H1 to H8674 (Hebrew) and from G1 to G5624 (Greek). Try one like <i>H430</i> or <i>G26</i>.</p></div>`;
const SHEET_BODY = el => el; // renderDrawer focusTo: the sheet body itself (tabindex -1)
async function runSearch(qRaw) {
  const q = String(qRaw || '').trim(); if (!q) return;
  const bar = $('#topbar'); bar.classList.remove('searching'); $('#search').blur();
  const title = `“${q}”`;
  // H/G + digits is always a Strong's lookup (never a reference: 'G12345' is not Genesis 50)
  const strong = q.match(/^([HG])\s?0*(\d+)$/i);
  if (strong) {
    const id = strong[1].toUpperCase() + strong[2], seq = ++searchSeq;
    const dict = await data.strongs(id[0]).catch(() => ({}));
    // a few numbers have occurrences but no lexicon entry (G6000+, H9005+): the concordance decides then
    const ok = !!dict[id] || (+strong[2] > 0 && (await data.conc(id)).length > 0);
    if (seq !== searchSeq) return;
    if (ok) { A.openTab('orig', { strong: id, focusTo: SHEET_BODY }); return; }
    goFullForSearch();
    drawer.setSearchResults(title, noStrong(id)); A.openTab('search', { focusTo: SHEET_BODY });
    return;
  }
  const ref = parseReference(q, { explain: true });
  // a known book with a chapter or verse past its end ('Rev 23', 'John 3:37'): say so, with the nearest passage
  if (ref?.error && /\d/.test(q)) {
    ++searchSeq;
    const bk = bookOf(ref.b), nch = bk.chapters.length, c = Math.min(nch, Math.max(1, ref.c));
    const over = ref.c >= 1 && ref.c <= nch, max = over ? bk.chapters[c - 1] : nch, v = over ? Math.min(max, ref.v) : 0;
    const what = over ? `${nch === 1 ? bk.name : refLabel(ref.b, c)} has ${plural(max, 'verse')}` : `${bk.name} has ${plural(nch, 'chapter')}`;
    goFullForSearch();
    drawer.setSearchResults(title, `<div class="empty"><span class="tile-i blue">${icon('search')}</span><h4>${esc(what)}</h4><p>Open <button class="link" type="button" data-ref-go="${ref.b}.${c}.${v}">${esc(refLabel(ref.b, c, v))}</button> instead.</p></div>`);
    A.openTab('search', { focusTo: SHEET_BODY });
    return;
  }
  if (ref && !ref.error && /\d/.test(q)) {
    const seq = ++searchSeq;
    // the Search tab would keep the last query's results beside another chapter: show this passage's own tab
    if (state.drawerTab === 'search') state.drawerTab = ref.v ? 'xref' : 'context';
    openRef(ref); if (ref.v) A.select(ref.v, { open: false });
    // focus the verse (or the chapter) unless the sheet took over or focus has moved on
    readerP.then(() => {
      const a = document.activeElement;
      if (seq !== searchSeq || document.body.classList.contains('sheet-modal') || (a && a !== document.body)) return;
      ((ref.v && document.getElementById('v' + ref.v)) || $('#reader .verse[tabindex="0"]') || $('#reader'))?.focus({ preventScroll: true });
    });
    return;
  }
  const seq = ++searchSeq;
  goFullForSearch();
  drawer.setSearchResults(title, SKELETON); A.openTab('search');
  const tr = previewTr();
  let topics = [], index = [];
  try { [topics, index] = await Promise.all([data.topics().catch(() => []), loadIndex(tr)]); }
  catch (e) { if (seq === searchSeq) { drawer.setSearchResults(title, `<div class="empty"><span class="tile-i blue">${icon('info')}</span><h4>Search is unavailable</h4><p>${esc(e.message)}</p></div>`); if (state.drawerTab === 'search') drawer.renderDrawer({ focusTo: SHEET_BODY }); } return; }
  if (seq !== searchSeq) return;
  const sq = searchQuery(q);
  const plain = sq ? sq.words.join(' ') : '';
  const tHits = plain ? topics.filter(t => [t.name, t.label].some(x => x && (fold(x).includes(plain) || fold(x).replace(/'/g, '').includes(plain)))).slice(0, 8) : [];
  // every hit, ranked by tier (canonical order within a tier); the list shows a page at a time
  const tiers = [[], [], []];
  if (sq) for (const h of index) { const k = sq.tier(h); if (k >= 0) tiers[k].push(h); }
  const hits = tiers[0].concat(tiers[1], tiers[2]);
  found = { seq, title, q, tr, ref, topics: tHits, hits, nOT: hits.filter(h => h.b <= 39).length, filter: 'all', shown: Math.min(hits.length, SEARCH_PAGE), rx: sq ? sq.mark : /$^/gu };
  drawer.setSearchResults(title, searchHtml(found));
  // keyboard users land on the first result (renderDrawer moves focus only when it fell to <body>, so never steals it)
  if (state.drawerTab === 'search') drawer.renderDrawer({ focusTo: el => $('[data-topic], #search-hits .cell', el) || el });
}
async function showTopic(name) {
  const topics = await data.topics().catch(() => []); const t = topics.find(x => x.name === name); if (!t) return;
  const seq = ++searchSeq;
  const label = t.label || t.name;
  drawer.setSearchResults(label, SKELETON); A.openTab('search');
  const rows = await Promise.all((t.verses || []).slice(0, 80).map(async x => {
    const p = await previewText(x[0], x[1], x[2], x[3]).catch(() => ({ text: '' }));
    const txt = clip(p.text, 150);
    return `<li><button class="cell" type="button" data-go="${x[0]}.${x[1]}.${x[2]}"><span class="cell-body"><span class="cell-title">${esc(refLabel(x[0], x[1], x[2], x[3]))}</span>${txt ? `<span class="cell-sub serif">${esc(txt)}</span>` : ''}</span><span class="cell-trail"><span class="vn" title="${(x[4] || 0).toLocaleString()} votes">${(x[4] || 0).toLocaleString()}</span>${icon('chev-right', 'chev')}</span></button></li>`;
  }));
  if (seq !== searchSeq) return;
  drawer.setSearchResults(label, `<div class="lh"><h3>${esc(label)}</h3><span>${(t.votes || 0).toLocaleString()} votes · OpenBible.info</span></div><ul class="group">${rows.join('')}</ul>`);
  if (state.drawerTab === 'search') drawer.renderDrawer();
}

// ------------------------------------------------------------ top bar
/** Below 1180px the search field collapses to .search-open (styles.css sec. 15); .searching shows it as an overlay. */
const SEARCH_ICON = typeof matchMedia !== 'undefined' ? matchMedia('(max-width: 1179px)') : { matches: false, addEventListener() {} };
let lastY = 0, scrollRaf = 0;
/** The tool strip (.gnav-right) scrolls sideways when it does not fit: fade only the edge that hides tools.
 *  Called from its scroll events and a ResizeObserver, where layout is already current. */
function syncBarEdges() {
  const r = document.querySelector('#topbar .gnav-right'); if (!r) return;
  const max = r.scrollWidth - r.clientWidth, x = Math.abs(r.scrollLeft);
  r.classList.toggle('ov-l', max > 1 && x > 1);
  r.classList.toggle('ov-r', max > 1 && x < max - 1);
}
function onScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const y = Math.max(0, window.scrollY), bar = $('#topbar'); if (!bar) return;
    bar.classList.toggle('flat', y <= 8);
    const max = document.documentElement.scrollHeight - innerHeight;
    const pr = $('#progress'); if (pr) pr.style.transform = `scaleX(${max > 0 ? Math.min(1, y / max).toFixed(4) : 0})`;
    if (innerWidth < 700 && !bar.classList.contains('searching') && !document.body.classList.contains('sheet-modal')) {
      if (y > 160 && y > lastY + 2 && !bar.contains(document.activeElement)) bar.classList.add('hide');
      else if (y < lastY - 2 || y <= 8) bar.classList.remove('hide');
    } else bar.classList.remove('hide');
    lastY = y;
  });
}
function openSearchField() {
  const bar = $('#topbar');
  if (document.body.classList.contains('sheet-modal')) closeDrawer();
  bar.classList.remove('hide');
  if (SEARCH_ICON.matches) bar.classList.add('searching');
  // the last query comes up selected (as in Safari's and Spotlight's fields): typing replaces it, an arrow key keeps it
  const s = $('#search'); s.focus();
  if (s.value) { try { s.setSelectionRange(0, s.value.length); } catch (e) { s.select(); } }
}
/** Hosted, the ESV and NLT keys are the owner's personal-use licences: nobody else can choose them (hosting brief §2). */
const ownerOnlyKeys = () => !!(state.auth.hosted && !state.auth.owner);
function fillTranslationSelects() {
  const off = ownerOnlyKeys();
  const opt = t => `<option value="${esc(t.id)}"${off && t.kind === 'api' ? ' disabled' : ''}>${esc(t.abbr)}</option>`;
  const g = kind => state.translations.filter(t => t.kind === kind);
  const group = (label, list) => list.length ? `<optgroup label="${label}">${list.map(opt).join('')}</optgroup>` : '';
  const api = group(off ? 'Available to the site owner' : 'With API key', g('api'));
  $('#tr').innerHTML = group('Bundled', g('bundled')) + api + group('Opens a website', g('external'));
  $('#tr2').innerHTML = '<option value="">Parallel</option>' + group('Bundled', g('bundled')) + api;
}
/** A text the current session can read: bundled, or an API one with a key it may use. */
const usableTr = id => { const t = state.translations.find(x => x.id === id); return !!t && t.kind !== 'external' && (t.kind !== 'api' || !!state.apiKeys[t.id]); };
function bindTranslations() {
  const after = () => { updateBar(); renderReader(); drawer.renderDrawer({ keepScroll: true }); };
  const onTr = (sel, which) => sel.addEventListener('change', () => {
    const val = sel.value;
    if (which === 'tr2' && !val) { state.tr2 = ''; lsSet('bs-tr2', ''); after(); return; }
    const t = state.translations.find(x => x.id === val);
    if (!t) { sel.value = state[which] || ''; return; }
    if (t.kind === 'external') {
      const url = EXTERNAL[t.id] ? EXTERNAL[t.id](state.book, state.chapter) : null;
      if (url) window.open(url, '_blank', 'noopener');
      sel.value = state[which] || '';
      toast(`${t.abbr} has no free API, so this chapter opened on ${t.id === 'lsb' ? 'read.lsbible.org' : 'BibleGateway'} in a new tab.`);
      return;
    }
    // the parallel column never repeats the main text
    if (which === 'tr2' && val === state.tr) { sel.value = state.tr2 || ''; toast(`${t.abbr} is already the main text. Choose another translation for the parallel column.`); return; }
    if (t.kind === 'api' && ownerOnlyKeys()) { sel.value = state[which] || ''; toast(`${t.abbr} is available to the site owner.`); return; }
    if (t.kind === 'api' && !state.apiKeys[t.id]) {
      sel.value = state[which] || '';
      // `which` remembers the select that asked, so saving the key in Settings can apply it (bindSettings)
      state.notice = { tr: t.id, which, title: `${t.abbr} needs an API key`, body: `Add a free ${t.abbr} key in Settings and the text is fetched a chapter at a time, then cached.` };
      renderReader().then(() => {
        const n = $('#reader .notice'); if (!n) return;
        const r = n.getBoundingClientRect(); if (r.top < 70 || r.bottom > innerHeight) n.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
      });
      return;
    }
    // the main text becomes the parallel one: the two columns swap rather than show the same text twice
    if (which === 'tr' && val === state.tr2) { state.tr2 = state.tr; lsSet('bs-tr2', state.tr2); }
    state[which] = val; state.notice = null; lsSet('bs-' + which, val); after();
  });
  onTr($('#tr'), 'tr'); onTr($('#tr2'), 'tr2');
}
function bindChrome() {
  $('#btn-prev').addEventListener('click', () => A.step(-1));
  $('#btn-next').addEventListener('click', () => A.step(1));
  $('#btn-back').addEventListener('click', () => { const h = state.history.pop(); if (!h) return; state.future.push({ b: state.book, c: state.chapter, v: state.selected }); A.navigate(h.b, h.c, h.v, { noHistory: true }); });
  $('#btn-fwd').addEventListener('click', () => { const f = state.future.pop(); if (!f) return; state.history.push({ b: state.book, c: state.chapter, v: state.selected }); A.navigate(f.b, f.c, f.v, { noHistory: true }); });
  $('#cur-ref').addEventListener('click', openPicker); $('#btn-pick').addEventListener('click', openPicker);
  $('#btn-orig').addEventListener('click', toggleOrig);
  $$('[data-panel-btn]').forEach(b => b.addEventListener('click', () => A.showPanel(b.dataset.panelBtn)));
  $('#btn-drawer').addEventListener('click', () => A.toggleDrawer());
  $('#btn-theme')?.addEventListener('click', toggleTheme);
  syncThemeBtn();
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-help').addEventListener('click', openHelp);
  $('#btn-library')?.addEventListener('click', () => A.openLibrary());
  $('#scrim')?.addEventListener('click', () => closeDrawer());
  // 'Skip to the text' moves focus without '#reader' in the address bar (and without a history entry)
  $('.skip')?.addEventListener('click', e => { const r = $('#reader'); if (!r) return; e.preventDefault(); r.focus({ preventScroll: true }); r.scrollIntoView({ block: 'start' }); });
  $('#stage')?.addEventListener('click', e => { if (e.target.closest('[data-close-panel]') && state.panel) { const btn = $(`[data-panel-btn="${state.panel}"]`); A.showPanel(state.panel); btn?.focus({ preventScroll: true }); } });

  const sf = $('#search-form'), si = $('#search'), bar = $('#topbar');
  sf.addEventListener('submit', e => { e.preventDefault(); runSearch(si.value); });
  si.addEventListener('input', () => sf.classList.toggle('has-value', !!si.value));
  $('.search-open')?.addEventListener('click', openSearchField);
  $('#search-form .cancel')?.addEventListener('click', () => { bar.classList.remove('searching'); si.blur(); });
  // focus left the search form (a verse, the page): the overlay gives the bar back; the query stays for next time
  si.addEventListener('blur', () => setTimeout(() => { if (!sf.contains(document.activeElement)) bar.classList.remove('searching'); }, 150));
  bar.addEventListener('focusin', () => bar.classList.remove('hide'));

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  try { SEARCH_ICON.addEventListener('change', () => { if (!SEARCH_ICON.matches) bar.classList.remove('searching'); }); } catch (e) { /* old Safari */ }
  const strip = $('.gnav-right', bar);
  if (strip) {
    strip.addEventListener('scroll', syncBarEdges, { passive: true });
    // a mouse wheel scrolls the strip sideways while it has tools out of view; at either end (or when it all fits)
    // the page scrolls as usual. Sideways swipes, Shift+wheel and pinch zoom (ctrl) keep their own behaviour.
    strip.addEventListener('wheel', e => {
      if (e.ctrlKey || e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      const max = strip.scrollWidth - strip.clientWidth; if (max <= 1) return;
      const d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? strip.clientWidth : 1), x = strip.scrollLeft;
      if ((d > 0 && x >= max - 1) || (d < 0 && x <= 1)) return;
      strip.scrollLeft = Math.max(0, Math.min(max, x + d));
      e.preventDefault();
    }, { passive: false });
    // the strip and each tool in it: a pill that changes width or the account button appearing also counts
    if ('ResizeObserver' in window) { const ro = new ResizeObserver(syncBarEdges); [strip, ...strip.children].forEach(x => ro.observe(x)); }
    else window.addEventListener('resize', syncBarEdges, { passive: true });
    syncBarEdges();
  }
  onLayoutChange(onLayoutChange2);
  window.addEventListener('resize', onLayoutChange2);
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { vizCall('refreshTheme'); syncThemeBtn(); }); } catch (e) { /* old Safari */ }
  // a typed or pasted `#b/c[/v]`: another chapter goes through navigate (in-app Back, hash), another verse redraws in
  // place; either way the address bar then shows the clamped location ('#99/99/99' → '#66/22/21', '#43/3/0' → '#43/3'),
  // and any other hash ('#abc') gives way to the chapter shown, so a copied or reloaded URL opens it
  window.addEventListener('hashchange', () => {
    const p = parseHash(); if (!p) { updateHash(); return; }
    if (p.b !== state.book || p.c !== state.chapter) { A.navigate(p.b, p.c, p.v); return; }
    if ((p.v || null) !== state.selected) { state.selected = p.v || null; drawer.setOrigFocus(null); lnkCall('clearMineFocus'); render({ scroll: true }); }
    updateHash();
  });
}

// ------------------------------------------------------------ keyboard (spec §7.3)
function bindKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented) return; // handled already (a menu, the art viewer, a radiogroup)
    const t = e.target;
    // Z (Alt+Z in a text field) runs the toast's action (Undo, Add label…): it would be gone before Tab reached it
    const menu = drawer.menuOpen() || uiMenuOpen() || !!document.querySelector('.menu');
    if ((e.altKey ? e.code === 'KeyZ' : e.key === 'z' || e.key === 'Z') && !e.metaKey && !e.ctrlKey && !e.shiftKey && !menu && toastAction && !$('#toast')?.hidden) {
      const field = !!(t && t.matches && t.matches('input, textarea, select, [contenteditable="true"]'));
      if (e.altKey || !field) { e.preventDefault(); runToastAction(); return; }
    }
    if (t && t.matches && t.matches('input, textarea, select, [contenteditable="true"]')) {
      if (e.key === 'Escape') { t.blur(); $('#topbar').classList.remove('searching'); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // R takes the resume card, which may sit inside an open dialog (placeFloats): before the dialog check below
    const card = $('#resume');
    if ((e.key === 'r' || e.key === 'R') && !menu && !artViewerOpen() && card && !card.hidden && !card.classList.contains('out')) { e.preventDefault(); continueResume(); return; }
    if (document.querySelector('dialog[open]') || menu) return;
    if (artViewerOpen()) return;
    // the selection bubble, a highlight's popover or the comment card: their keys are their own (each closes on Esc itself)
    if (t && t.closest && t.closest('#mark-bubble, #mark-pop, #mark-card') && e.key !== 'Escape') return;
    const inSheet = !!(t && t.closest && t.closest('#drawer'));
    // the modal sheet covers an inert page: keys that change the page close the sheet so the change is seen (§7.3)
    const modal = document.body.classList.contains('sheet-modal');
    const onPage = fn => { fn(); if (modal) closeDrawer(); };
    const k = e.key;
    if ((k === 'ArrowLeft' && !e.shiftKey) || k === '[') { if (!inSheet && !modal) { e.preventDefault(); A.step(-1); } } // Shift+arrows select words
    else if ((k === 'ArrowRight' && !e.shiftKey) || k === ']') { if (!inSheet && !modal) { e.preventDefault(); A.step(1); } }
    else if (k === 'j' || k === 'k') { e.preventDefault(); A.stepVerse(k === 'j' ? 1 : -1); }
    else if (k === '/') { e.preventDefault(); openSearchField(); }
    else if (k === 'o') onPage(toggleOrig);
    else if (k === 't') toggleTheme();
    else if (k === 'a' || k === 'g' || k === 'm' || k === 'i') onPage(() => A.showPanel({ a: 'arcs', g: 'graph', m: 'map', i: 'art' }[k]));
    else if (k === 'n') { e.preventDefault(); if (state.selected) A.select(state.selected, { tab: 'notes', focus: true }); else A.openTab('notes', { focus: true }); }
    else if (k === 'b') { e.preventDefault(); A.toggleBookmark(); }
    else if (k === 'c') { e.preventDefault(); A.startLinkPick(); }
    else if (k === 'l') { e.preventDefault(); A.openLibrary(); }
    else if (k === '?') { e.preventDefault(); openHelp(); }
    else if (k === 'Escape') {
      if (mrkCall('closeBubble', { restore: true })) return; // the selection bubble or comment card first (annotations-brief §3.5)
      if (mrkCall('closeMarkPop', { restore: true })) return; // then a highlight's margin popover
      if (lnkCall('picking')) { lnkCall('cancelPick'); return; } // then pick mode (links-spec §3.4)
      if ($('#topbar').classList.contains('searching')) { $('#topbar').classList.remove('searching'); return; }
      if (!$('#resume')?.hidden) { hideResume(); return; }
      if (state.drawerOpen && (inSheet || layoutMode() !== 'side')) closeDrawer();
      else if (state.panel) A.showPanel(state.panel);
      else if (state.drawerOpen) closeDrawer();
    }
  });
}

// ------------------------------------------------------------ leave off: resume prompt (profiles-spec §5.9)
let resumeT = 0, resumeOutT = 0, resumeSayT = 0, resumePos = null, resumeBack = null; // resumeBack: focus before the card took it
/** A usable reading position {b, c, v, t} (clamped to the book), or null. */
function validPos(p) {
  if (!p || typeof p !== 'object') return null;
  const b = Math.round(+p.b), c = Math.round(+p.c);
  const bk = b >= 1 && b <= 66 ? bookOf(b) : null;
  if (!bk || !(c >= 1 && c <= bk.chapters.length)) return null;
  const v = Math.max(0, Math.min(bk.chapters[c - 1], Math.round(+p.v || 0)));
  return { b, c, v, t: +p.t || 0, scrollFrac: +p.scrollFrac || 0 };
}
function showResume(pos) {
  const el = $('#resume'); pos = validPos(pos);
  if (!el || !pos) return;
  if (state.drawerOpen && layoutMode() !== 'side') return; // never over the phone sheet or the modal overlay sheet
  if (artViewerOpen()) return; // nor over the art viewer (see placeFloats)
  resumePos = pos;
  $('#resume-t').textContent = refLabel(pos.b, pos.c, pos.v);
  $('#resume-s').textContent = pos.t ? `Where you left off · ${relTime(pos.t)}` : 'Where you left off';
  clearTimeout(resumeT); clearTimeout(resumeOutT); clearTimeout(resumeSayT);
  resumeBack = null;
  el.classList.remove('out'); el.hidden = false;
  // the card sits at the end of the page: say it is there, and how to take it (R) before it fades
  const say = $('#resume-say');
  // (inside an open dialog Escape closes the dialog, not the card: leave it out there)
  if (say) { say.textContent = ''; resumeSayT = setTimeout(() => { say.textContent = `Continue reading ${refLabel(pos.b, pos.c, pos.v)}? Press R to continue${topDialog() ? '' : ', Escape to dismiss'}.`; }, 250); }
  placeFloats(); // inside an open modal dialog, else it is inert under it
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  document.body.classList.add('has-resume');
  resumeT = setTimeout(hideResume, 15000);
}
function hideResume() {
  const el = $('#resume'); if (!el || el.hidden) return;
  clearTimeout(resumeT); clearTimeout(resumeSayT);
  // focus on the card goes back where it came from (else the reader's verse), never to <body>
  if (el.contains(document.activeElement)) {
    const back = resumeBack?.isConnected && !el.contains(resumeBack) && !resumeBack.closest('[inert]') && resumeBack.getClientRects().length ? resumeBack : null;
    const to = back || $('#reader .verse[tabindex="0"]') || $('#reader');
    to?.focus({ preventScroll: true });
    if (el.contains(document.activeElement)) document.activeElement.blur();
  }
  el.classList.add('out');
  document.body.classList.remove('has-resume');
  clearTimeout(resumeOutT);
  resumeOutT = setTimeout(() => { el.hidden = true; el.classList.remove('out'); placeFloats(); }, RM.matches ? 0 : 300);
}
function bindResume() {
  const el = $('#resume'); if (!el) return;
  el.addEventListener('click', e => {
    if (e.target.closest('[data-resume-go]')) continueResume();
    else if (e.target.closest('[data-resume-close]')) hideResume();
  });
  el.addEventListener('focusin', e => { const r = e.relatedTarget; if (r && !el.contains(r) && r !== document.body) resumeBack = r; });
  // pause while the pointer or focus is on it (like the toast)
  const pause = () => clearTimeout(resumeT);
  const later = () => { if (!el.hidden && !el.classList.contains('out')) { clearTimeout(resumeT); resumeT = setTimeout(hideResume, 6000); } };
  el.addEventListener('pointerenter', pause); el.addEventListener('pointerleave', later);
  el.addEventListener('focusin', pause); el.addEventListener('focusout', later);
}
/** The card's Continue (its button, or R): the saved place, with keyboard focus on it. */
function continueResume() {
  const el = $('#resume'); if (!el || el.hidden || el.classList.contains('out')) return;
  const p = resumePos, host = el.closest('dialog'); // shown over the Library (signed in from there): reveal the chapter
  if (host) {
    // the dialog's close hands focus back to its opener: go (and take focus to the verse) once it has closed.
    // Watched on its open attribute (a microtask right after close(), which has restored focus by then) rather than
    // the 'close' event, which Chromium holds until the next frame. A close cancelled by a reopen never comes: give up.
    if (p && typeof MutationObserver !== 'undefined') {
      let gaveUp = 0;
      const mo = new MutationObserver(() => { if (host.open) return; mo.disconnect(); clearTimeout(gaveUp); A.resume(p, { focus: 'force' }); });
      mo.observe(host, { attributes: true, attributeFilter: ['open'] });
      gaveUp = setTimeout(() => mo.disconnect(), 3000);
    } else if (p) A.resume(p, { focus: true });
    hideResume(); closeDialog(host);
    return;
  }
  // hideResume would hand focus on the card back where it came from (the sheet, say): park it on the text instead,
  // so resumeTo moves it on to the verse
  if (el.contains(document.activeElement)) $('#reader')?.focus({ preventScroll: true });
  hideResume(); if (p) A.resume(p, { focus: true });
}
/** Go to a saved position: the chapter (unless already there), then the verse near the top. No verse is selected.
 *  o.focus (Continue on the card): focus that verse (the chapter text without one), so Tab goes on from there,
 *  unless focus is elsewhere on the page; 'force' (after the card's dialog closed back to its opener): regardless. */
function resumeTo(pos, o = {}) {
  pos = validPos(pos); if (!pos) return;
  hideResume();
  if (pos.b !== state.book || pos.c !== state.chapter || (state.selected && !o.silent)) A.navigate(pos.b, pos.c, 0);
  readerP.then(() => {
    if (state.book !== pos.b || state.chapter !== pos.c) return;
    const el = pos.v ? document.getElementById('v' + pos.v) : null;
    if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' });
    else window.scrollTo({ top: 0, behavior: 'auto' });
    const ae = document.activeElement;
    if (o.focus === 'force' || (o.focus && (!ae || ae === document.body || $('#reader')?.contains(ae)))) (el || $('#reader'))?.focus({ preventScroll: true });
  });
}

// ------------------------------------------------------------ profiles: scope changes, read marks, library events
/** Mark a chapter read or unread by hand (reader footer). library.markChapters shows the toast with Undo. */
async function markRead(b, c, read) {
  if (guestBlocked()) return false;
  if (!has(library, 'markChapters')) { toast('Reading progress is unavailable right now. Reload to try again.'); return false; }
  const res = await libCall('markChapters', b, c, !!read);
  return !(res === false || res === undefined || (res && typeof res === 'object' && res.ok === false));
}
/** Another profile (or the guest) is now studying in this tab: reload its notes and library and redraw. */
let scopeSeq = 0;
async function onScopeChange(d = {}) {
  const seq = ++scopeSeq;
  if (d.prevScope !== state.auth.scope) drawer.stopPlayer(); // the previous profile's video never plays on here
  hideResume();
  // hosted, what GET /api/config allows depends on who is signed in (the owner's ESV and NLT): ask again
  const cfg = state.auth.hosted && d.reason !== 'import' ? loadConfig() : null;
  await Promise.all([loadNotes(), libCall('loadLibrary'), lnkCall('loadLinks'), mrkCall('loadMarks'), cfg]);
  if (seq !== scopeSeq) return; // superseded by a newer switch
  if (cfg) syncTranslations();
  render({ keepScroll: true });
  refreshPicker();
  if (d.reason === 'signin' || d.reason === 'signup') {
    const pos = validPos(libCall('currentPosition'));
    if (pos && (pos.b !== state.book || pos.c !== state.chapter)) showResume(pos);
  }
}
/** After the owner signs in or out: the menus offer what this session may read, and a text it may not falls back. */
function syncTranslations() {
  if (!usableTr(state.tr)) state.tr = 'kjv';
  if (state.tr2 && (!usableTr(state.tr2) || state.tr2 === state.tr)) state.tr2 = ''; // a parallel column never repeats the text
  if (state.notice && !usableTr(state.notice.tr) && ownerOnlyKeys()) state.notice = null;
  fillTranslationSelects(); updateBar();
}
function refreshLibraryMarks() {
  if (typeof reader.refreshLibraryMarks === 'function') { try { reader.refreshLibraryMarks(); } catch (e) { console.error(e); } }
  try { drawer.renderHead(); } catch (e) { console.error(e); }
  refreshPicker();
}
/** Where a caret at `pos` in `a` belongs in `b`: kept before the changed part, kept from the end after it. */
function mapCaret(a, b, pos) {
  const max = Math.min(a.length, b.length);
  let p = 0; while (p < max && a[p] === b[p]) p++;
  let s = 0; while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (pos <= p) return pos;
  if (pos >= a.length - s) return b.length - (a.length - pos);
  return b.length - s;
}
/** The note editor (#note-text / #note-tags) has focus: redraw the note card, then put focus and caret back. */
function redrawFocusedEditor(ae) {
  const id = ae.id, old = ae.value, s = ae.selectionStart, en = ae.selectionEnd, dir = ae.selectionDirection || 'none';
  const tagDraft = document.getElementById('note-tags')?.value || '';
  return Promise.resolve(drawer.renderDrawer({ keepScroll: true })).then(() => {
    const el = document.getElementById(id); if (!el || !state.drawerOpen) return;
    const tags = document.getElementById('note-tags'); if (tags && tagDraft && !tags.value) tags.value = tagDraft; // an unsent tag
    el.focus({ preventScroll: true });
    if (typeof s !== 'number') return;
    const v = el.value;
    const a = id === 'note-text' ? mapCaret(old, v, s) : Math.min(s, v.length), z = id === 'note-text' ? mapCaret(old, v, en) : Math.min(en, v.length);
    try { el.setSelectionRange(Math.min(a, z), Math.max(a, z), dir); } catch (err) { /* ignore */ }
  }).catch(err => console.error(err));
}
/** Focus is in another field of the sheet: patch the note editor in place so it never shows stale text. */
function patchEditor(key) {
  const n = state.notes.refs[key], text = (n && n.text) || '';
  const ta = document.getElementById('note-text');
  if (ta && ta.value !== text) { ta.value = text; ta.style.height = 'auto'; ta.style.height = Math.max(140, ta.scrollHeight + 2) + 'px'; }
  const md = document.querySelector('#drawer [data-md]');
  if (md && typeof drawer.renderMd === 'function') md.innerHTML = drawer.renderMd(text);
}
/**
 * Notes replaced by the server (another window saved, a conflict) or put back ("Keep mine"): redraw what shows
 * them. The note open in the editor is always brought up to date, even while it has focus (caret kept), so the
 * editor never shows text that differs from state.notes; the next keystroke then edits the version on screen.
 */
function onNotesReplaced(e) {
  const d = (e && e.detail) || {}, keys = d.keys || [];
  if (!keys.length) return;
  const b = state.book, c = state.chapter;
  keys.forEach(k => { const p = String(k).split('.').map(Number); if (p[0] === b && p[1] === c && p[2]) { try { reader.refreshVerseMarker(p[2]); } catch (err) { console.error(err); } } });
  const cur = refKey(b, c, state.selected), ae = document.activeElement;
  const typing = !!(ae && ae.closest && ae.closest('#drawer') && ae.matches('textarea, input'));
  const editorOpen = state.drawerOpen && state.drawerTab === 'notes' && keys.includes(cur);
  const inEditor = editorOpen && typing && (ae.id === 'note-text' || ae.id === 'note-tags');
  if (inEditor) redrawFocusedEditor(ae);
  // the Video tab lists videos from every note, so it redraws when the list it shows differs from the new data
  else if (state.drawerOpen && !typing && (keys.includes(cur) || keys.includes(`${b}.${c}`) || state.drawerTab === 'notes' || drawer.videosStale(keys))) drawer.renderDrawer({ keepScroll: true });
  else {
    if (editorOpen) patchEditor(cur);
    try { drawer.renderHead(); } catch (err) { console.error(err); }
  }
  const where = k => { const p = String(k).split('.').map(Number); return bookOf(p[0]) ? refLabel(p[0], p[1], p[2] || 0) : 'a verse'; };
  if (d.reason === 'conflict') {
    // offer this window's version back (only where it differs from what is now shown)
    const mine = {}; let offer = 0;
    for (const k of keys) if (d.mine && k in d.mine && notesDiffer(d.mine[k], state.notes.refs[k])) { mine[k] = d.mine[k]; offer++; }
    const action = offer ? { label: 'Keep mine', run: () => { if (!restoreNotes(mine, d.scope)) toast('Your version could not be put back.'); } } : undefined;
    toast(keys.length === 1 ? `Your note on ${where(keys[0])} changed in another window. Showing the newer version.` : `${keys.length} of your notes changed in another window. Showing the newer versions.`, action);
  } else if (d.reason === 'restore') {
    toast(keys.length === 1 ? `Kept your version of the note on ${where(keys[0])}.` : `Kept your versions of ${keys.length} notes.`);
  } else if (inEditor) {
    toast(`Your note on ${where(cur)} was updated in another window.`);
  }
}
/** The art viewer is a full-screen layer with its own keys: the page shortcuts stay quiet under it. */
function artViewerOpen() {
  if (has(art, 'viewerOpen')) { try { return !!art.viewerOpen(); } catch (e) { return false; } }
  return document.documentElement.classList.contains('art-viewing');
}
function bindProfileEvents() {
  document.addEventListener('bs:library-changed', () => A.refreshLibraryMarks());
  document.addEventListener('bs:auth-changed', e => { A.onScopeChange((e && e.detail) || {}); });
  document.addEventListener('bs:notes-replaced', onNotesReplaced);
}

// ------------------------------------------------------------ boot
async function boot() {
  const meta = await data.meta(); state.meta = meta; state.books = meta.books; state.translations = meta.translations || [];
  [library, tracker, art, lnk, mrk] = await modsP;
  artCall('init', A);
  artCall('load'); // art.json in the background; never throws
  await initAuth();
  await Promise.all([loadNotes(), loadConfig(), libCall('loadLibrary'), lnkCall('loadLinks'), mrkCall('loadMarks')]);
  applyTheme(state.theme);
  const fz = lsGet('bs-font'); if (fz && +fz >= 12 && +fz <= 32) document.documentElement.style.setProperty('--read-size', fz + 'px');
  document.documentElement.classList.toggle('woc-off', lsGet('bs-woc') === '0');
  state.tr = lsGet('bs-tr', 'kjv') || 'kjv'; state.tr2 = lsGet('bs-tr2', '') || '';
  if (!usableTr(state.tr)) state.tr = 'kjv';
  if (state.tr2 && (!usableTr(state.tr2) || state.tr2 === state.tr)) state.tr2 = ''; // a parallel column never repeats the text
  fillTranslationSelects();
  // leave off (§5.9): a load without a chapter in the URL opens where this profile stopped reading
  const hadHash = /^#\d+\/\d+/.test(location.hash);
  readHash();
  const pos = validPos(libCall('currentPosition'));
  let resumeOnBoot = null;
  if (!hadHash && pos) { state.book = pos.b; state.chapter = pos.c; state.selected = null; resumeOnBoot = pos; }

  reader.init(A); drawer.init(A); vizCall('init', A);
  reader.bindReader(); drawer.bindDrawer();
  bindChrome(); bindTranslations(); bindPicker(); buildPicker(); bindSettings(); bindDialogs(); bindToast(); bindSheetDrag(); bindKeyboard();
  bindSearchResults(); bindResume(); bindProfileEvents();
  initAccountUI(A); libCall('initLibrary', A); trkCall('initTracker', A); bindNotesLifecycle(); lnkCall('initLinks', A); mrkCall('initMarks', A);
  // the address bar always names the chapter shown: a clamped hash ('#99/99/99'), a resumed position or a bare URL
  syncDrawer(); updateBar(); updateHash(); renderPanel();

  readerP = reader.renderReader({ scroll: true }); // not via the wrapper: a failure here should reach boot().catch
  await readerP;
  drawer.renderDrawer(); // header fields and badges; the sheet stays closed
  // §6.1: a verse in the URL opens the sheet on arrival only where it does not cover the text
  if (state.selected && layoutMode() === 'side') { state.drawerTab = 'xref'; openDrawer({}); }
  onScroll();
  try { sessionStorage.removeItem('bs-boot-retry'); } catch (e) { /* ignore */ } // index.html's load-failure retry
  let toasted = true;
  if (DRY) toast('Dry run: nothing will be saved.');
  else if (!state.serverOk) toast('Running without serve.py, so notes are kept in this browser only.');
  else toasted = false;
  if (resumeOnBoot) {
    A.resume(resumeOnBoot, { silent: true });
    if (!toasted) toast(`Picked up where you left off: ${refLabel(resumeOnBoot.b, resumeOnBoot.c, resumeOnBoot.v)}.`);
  } else if (hadHash && pos && (pos.b !== state.book || pos.c !== state.chapter) && Date.now() - pos.t < 60 * DAY) showResume(pos);
  (window.requestIdleCallback || (f => setTimeout(f, 400)))(() => { [data.people(), data.places(), data.events(), data.orig(state.book), data.topics()].forEach(p => p && p.catch && p.catch(() => {})); });
}
boot().catch(e => {
  console.error(e);
  const el = document.getElementById('reader');
  if (el) el.innerHTML = `<div class="notice error" role="note">${icon('info')}<p>Failed to start: ${esc(e.message)}<small>Run <code>python3 serve.py</code> and open http://localhost:8765.</small></p></div>`;
});
