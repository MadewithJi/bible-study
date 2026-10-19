// App shell (ios-brief §2). Inside the iOS app (user agent "BibleLantern/iOS", or ?app=ios for a desktop check)
// index.html sets html.app-shell, the native tab bar and Read toolbar replace the top bar, and this module is the
// bridge between them and the page: window.BL takes the shell's requests, and the page reports its state through
// window.webkit.messageHandlers.bl. main.js loads it at the end of boot, only in the shell; on the open web it never
// runs. Every method answers with plain values (the shell reads them with evaluateJavaScript), never a promise.
import { state, bookOf, refLabel, parseReference } from './store.js';

let A = null, H = {}, library = null; // the action object, main.js helpers (openPicker, applyTheme, setFont, setTr, openProfile, signOut), library.js
const $ = (s, r = document) => r.querySelector(s);
const html = document.documentElement;

/** Send a message to the shell. In a plain browser (?app=ios) it waits in BL.outbox instead, for a check to read. */
export function post(type, payload = {}) {
  const msg = { type, ...payload };
  try {
    const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bl;
    if (h) { h.postMessage(msg); return; }
  } catch (e) { /* no handler: a browser */ }
  BL.outbox.push(msg); if (BL.outbox.length > 50) BL.outbox.shift();
}

const overlays = () => [...document.querySelectorAll('dialog[open]')].map(d => d.id).filter(Boolean);
const isDark = () => state.theme === 'dark' || (state.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
const fontPx = () => Math.round(parseFloat(getComputedStyle(html).getPropertyValue('--read-size')) || 20);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Everything the shell shows natively: where the page is, what it reads, who is signed in, how it looks. */
function snapshot() {
  const a = state.auth, u = a.user || {};
  return {
    home: !!state.home, b: state.book, c: state.chapter, v: state.selected || 0,
    label: refLabel(state.book, state.chapter, state.selected || 0), chapterLabel: refLabel(state.book, state.chapter, 0),
    panel: state.panel || '', overlays: overlays(), drawer: !!state.drawerOpen,
    tr: state.tr, tr2: state.tr2 || '', orig: !!state.showOrig, theme: state.theme, dark: isDark(), font: fontPx(),
    signedIn: !!a.signedIn, name: String(u.name || ''), email: String(u.email || ''), hosted: !!a.hosted, lost: !!a.lost,
    url: location.href,
  };
}
let reportT = 0;
/** One state message per task, however many things changed (a timer, not a frame: a hidden page still reports). */
function report() { clearTimeout(reportT); reportT = setTimeout(() => post('state', snapshot()), 0); }

const closeOverlays = () => { [...document.querySelectorAll('dialog[open]')].reverse().forEach(d => A.closeDialog(d)); };
/** The Library (study-build-brief §2): the Study views or the Library home. */
function openLib(opts) {
  closeOverlays();
  if (library && typeof library.openLibrary === 'function') { library.openLibrary(opts); return true; }
  A.openLibrary({}); return true; // library.js is still loading: the Library home for now
}
/** '43/3/16', '#43/3' or a typed reference ('John 3:16') → the chapter, clamped to the Bible like a hash. */
function openRef(text) {
  const m = String(text).match(/^#?(\d+)\/(\d+)(?:\/(\d+))?$/);
  if (!m) return A.goReference(text);
  const b = clamp(+m[1], 1, 66), bk = bookOf(b), c = clamp(+m[2], 1, bk.chapters.length), v = clamp(+m[3] || 0, 0, bk.chapters[c - 1]);
  A.navigate(b, c, v); return true;
}

/** A method's result, after it reports the state it left. */
const done = v => { report(); return v; };
export const BL = {
  version: 1,
  outbox: [],
  state: snapshot,
  /** The books for the native picker. */
  books: () => state.books.map(b => ({ n: b.n, name: b.name, short: b.short || b.name, test: b.test, chapters: b.chapters.length })),
  /** The translations for the native menu; disabled ones are the owner's licensed texts (hosting brief §2) or an external site. */
  translations: () => state.translations.map(t => ({ id: t.id, abbr: t.abbr, name: t.name || t.abbr, kind: t.kind, disabled: !!$(`#tr option[value="${CSS.escape(t.id)}"]`)?.disabled })),
  /** 'home' | 'read' | 'study' | 'library' | 'profile' | 'settings' | 'picker', a hash '43/3/16' or a reference 'John 3:16'. */
  open(where) {
    const w = String(where || '').trim();
    switch (w) {
      case 'home': closeOverlays(); A.goHome(); return done(true);
      case 'read': closeOverlays(); if (state.home) A.navigate(state.book, state.chapter, state.selected || 0); return done(true);
      case 'study': return done(openLib({ view: 'study' }));
      case 'library': return done(openLib({}));
      case 'profile': closeOverlays(); if (state.auth.signedIn) H.openProfile(); else A.openAuth('signin'); return done(true);
      case 'settings': closeOverlays(); A.openSettings(); return done(true);
      case 'picker': closeOverlays(); H.openPicker(); return done(true);
      default: closeOverlays(); return done(openRef(w));
    }
  },
  /** A visualisation: 'arcs' | 'graph' | 'map' | 'art', or '' to close the open one. From Home the reader comes back with it. */
  panel(name) {
    const p = String(name || '');
    if (!p) { if (state.panel) A.showPanel(state.panel); return done(true); }
    if (!['arcs', 'graph', 'map', 'art'].includes(p)) return false;
    closeOverlays(); A.showPanel(p, true); return done(true);
  },
  /** Search as the top bar's field does: results in the study sheet's Search tab (Home gives way to the chapter first). */
  search(q) {
    const s = String(q || '').trim(); if (!s) return false;
    closeOverlays();
    if (state.home) A.navigate(state.book, state.chapter, state.selected || 0);
    A.search(s); return done(true);
  },
  step(dir) { A.step(dir < 0 ? -1 : 1); return done(true); },
  stepVerse(dir) { A.stepVerse(dir < 0 ? -1 : 1, { keepFocus: true }); return done(true); },
  setTranslation(id, which) { return done(!!H.setTr(which === 'tr2' ? 'tr2' : 'tr', String(id || ''))); },
  setFontSize(px) { H.setFont(px); return done(fontPx()); },
  setTheme(t) { H.applyTheme(String(t || 'auto'), true); return done(state.theme); },
  setOrig(on) { A.setOrig(!!on); return done(!!state.showOrig); },
  closeOverlays() { closeOverlays(); return done(true); },
  /** The sign-out runs in the page (its flush and toast); the state message that follows tells the shell. */
  signOut() { Promise.resolve(H.signOut()).then(report, e => console.error(e)); return true; },
  /** What the share sheet gets: the selected verse (or the chapter) and its link. */
  share() {
    const b = state.book, c = state.chapter, v = state.selected || 0;
    const url = `https://www.biblelantern.com/#${b}/${c}${v ? '/' + v : ''}`;
    let text = '';
    if (v && !state.home) { const el = document.getElementById('v' + v); const t = el && (el.querySelector('.vtext') || el); if (t) text = t.textContent.replace(/\s+/g, ' ').trim(); }
    return { title: refLabel(b, c, v), text, url };
  },
};

/** Wire the bridge. main.js calls this once, after boot, with its action object and the helpers the shell needs. */
export function initShell(actions, helpers = {}) {
  A = actions; H = helpers;
  window.BL = BL;
  import('./library.js').then(m => { library = m; }, e => console.error('shell: library.js', e));
  // the page's own changes reach the shell as they happen: a hash, a verse, a dialog, Home, the theme, a sign-in
  window.addEventListener('hashchange', report);
  ['bs:verse-selected', 'bs:auth-changed', 'bs:auth-lost', 'notes-changed'].forEach(ev => document.addEventListener(ev, report));
  document.addEventListener('change', e => { if (e.target && (e.target.id === 'tr' || e.target.id === 'tr2')) report(); });
  document.addEventListener('input', e => { if (e.target && e.target.id === 'fontsize') report(); });
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', report); } catch (e) { /* old engine */ }
  const mo = new MutationObserver(report);
  mo.observe(html, { attributes: true, attributeFilter: ['data-theme'] });
  mo.observe(document.body, { attributes: true, attributeFilter: ['class'] }); // sheet-modal, home transitions
  document.querySelectorAll('dialog').forEach(d => mo.observe(d, { attributes: true, attributeFilter: ['open'] }));
  ['home', 'panel', 'drawer'].forEach(id => { const el = document.getElementById(id); if (el) mo.observe(el, { attributes: true, attributeFilter: ['hidden', 'aria-hidden'] }); });
  // the page's own navigation (a verse, a cross-reference, the footer's next chapter) updates the title and the reader
  const title = document.querySelector('title'); if (title) mo.observe(title, { childList: true, characterData: true, subtree: true });
  const reader = document.getElementById('reader'); if (reader) mo.observe(reader, { attributes: true, attributeFilter: ['data-ch'] });
  post('ready', snapshot());
}
