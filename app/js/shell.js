// App shell (ios-brief §2). Inside the iOS app (user agent "BibleLantern/iOS", or ?app=ios for a desktop check)
// index.html sets html.app-shell, the native tab bar and Read toolbar replace the top bar, and this module is the
// bridge between them and the page: window.BL takes the shell's requests, and the page reports its state through
// window.webkit.messageHandlers.bl. main.js loads it at the end of boot, only in the shell; on the open web it never
// runs. Every method answers with plain values (the shell reads them with evaluateJavaScript), never a promise.
import { state, bookOf, refLabel, parseReference } from './store.js';

let A = null, H = {}; // the action object and main.js helpers (openPicker, applyTheme, setFont, setTr, openProfile, signOut)
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

/** An open dialog, unless it is animating out (ui.js closeDialog: .closing, then close() 180 ms later): it has left. */
const OPEN = 'dialog[open]:not(.closing)';
/** The open dialogs by id; the Doré viewer (art.js) has none and is named by its class. */
const overlays = () => [...document.querySelectorAll(OPEN)].map(d => d.id || (d.classList.contains('art-viewer') ? 'art-viewer' : '')).filter(Boolean);
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
    url: location.href, canBack: state.history.length > 0,
  };
}
let reportT = 0;
/** One state message per task, however many things changed (a timer, not a frame: a hidden page still reports). */
function report() { clearTimeout(reportT); reportT = setTimeout(() => post('state', snapshot()), 0); }

/** Close the page's dialogs for a shell request. One waiting on serve.py (data-busy: a sign-in, a delete confirm) stays,
 *  as it does for Esc and the backdrop; the page closes it when the answer comes. The Doré viewer closes itself (its
 *  fade, its clean-up and focus). */
const closeOverlays = () => {
  [...document.querySelectorAll(OPEN)].reverse().forEach(d => {
    if (d.dataset.busy) return;
    const x = d.classList.contains('art-viewer') && d.querySelector('[data-av="close"]');
    if (x) x.click(); else A.closeDialog(d);
  });
};
/** The Library (study-build-brief §2): the Study views, Memory or the Library home, through the page's own action (its guards). */
function openLib(opts) { closeOverlays(); A.openLibrary(opts); return true; }
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
  /** The translations for the native menu. kind: 'bundled', 'licensed' (NIV, NKJV and NASB through API.Bible, for every
   *  reader), 'api' (ESV and NLT: disabled for everyone but the hosted site's owner, hosting brief §2) or 'external' (a
   *  website, as the NIV, NKJV and NASB are when serve.py cannot serve them). */
  translations: () => state.translations.map(t => ({ id: t.id, abbr: t.abbr, name: t.name || t.abbr, kind: t.kind, disabled: !!$(`#tr option[value="${CSS.escape(t.id)}"]`)?.disabled })),
  /** 'home' | 'read' | 'study' | 'memory' | 'library' | 'profile' | 'settings' | 'picker', a hash '43/3/16' or a reference 'John 3:16'. */
  open(where) {
    const w = String(where || '').trim();
    switch (w) {
      case 'home': closeOverlays(); A.goHome(); return done(true);
      case 'read': closeOverlays(); if (state.home) A.navigate(state.book, state.chapter, state.selected || 0); return done(true);
      case 'study': return done(openLib({ view: 'study' }));
      case 'memory': return done(openLib({ view: 'memory' }));
      case 'library': return done(openLib({}));
      case 'profile': closeOverlays(); if (state.auth.signedIn) H.openProfile(); else A.openAuth('signin'); return done(true);
      case 'settings': closeOverlays(); A.openSettings(); return done(true);
      case 'picker': closeOverlays(); H.openPicker(); return done(true);
      default: closeOverlays(); return done(openRef(w));
    }
  },
  /** A visualisation: 'arcs' | 'graph' | 'map' | 'art', or '' to close the open one (on Home it is dropped, so the reader
   *  comes back without it). From Home the reader comes back with the one asked for. */
  panel(name) {
    const p = String(name || '');
    if (!p) { if (state.panel) { if (state.home) state.panel = null; else A.showPanel(state.panel); } return done(true); }
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
  /** The chapter read before this one, as the top bar's Back does (its handler runs); false when there is none. */
  back() { const b = $('#btn-back'); if (!b || !state.history.length) return false; b.click(); return done(true); },
  stepVerse(dir) { A.stepVerse(dir < 0 ? -1 : 1, { keepFocus: true }); return done(true); },
  setTranslation(id, which) { return done(!!H.setTr(which === 'tr2' ? 'tr2' : 'tr', String(id || ''))); },
  setFontSize(px) { H.setFont(px); return done(fontPx()); },
  setTheme(t) { H.applyTheme(String(t || 'auto'), true); return done(state.theme); },
  setOrig(on) { A.setOrig(!!on); return done(!!state.showOrig); },
  closeOverlays() { closeOverlays(); return done(true); },
  /** The sign-out runs in the page (its flush, the logout, its toast). When it ends a 'signout' message says how, with
   *  the state as every message has: ok, or the page's own words for a refusal (unsent notes, no connection), which the
   *  shell shows where the reader is looking (the toast sits under the native Profile tab). */
  signOut() {
    const end = (ok, note = '') => { post('signout', { ...snapshot(), ok, note: ok ? '' : note || 'Couldn’t sign out. Try again.' }); report(); };
    const fail = e => { console.error(e); end(false); };
    // signed out already (another window did it, and the shell's last report is stale): the shell asked for this state
    if (!state.auth.signedIn) { end(true); return true; }
    try { Promise.resolve(H.signOut()).then(ok => end(!!ok, ok ? '' : $('#toast:not([hidden]) .toast-msg')?.textContent || ''), fail); } catch (e) { fail(e); }
    return true;
  },
  /** What the share sheet gets: the selected verse (or the chapter) and its link. */
  share() {
    const b = state.book, c = state.chapter, v = state.selected || 0;
    const url = `https://www.biblelantern.com/#${b}/${c}${v ? '/' + v : ''}`;
    let text = '';
    const t = v && !state.home && document.querySelector(`#v${v} .vtext`); // parallel columns: the primary's comes first
    if (t) {
      // as the reader's copy handler (reader.js): the omitted-verse note is editorial (its KJV reading stays), and a
      // verse folded in from the next number keeps that number ('…the sea. 18 And he stood')
      const f = t.cloneNode(true);
      f.querySelectorAll('.sr, .om-why').forEach(x => x.remove());
      f.querySelectorAll('.vx').forEach(x => x.append(' '));
      text = f.textContent.replace(/\s+/g, ' ').trim();
    }
    return { title: refLabel(b, c, v), text, url };
  },
};

/** Wire the bridge. main.js calls this once, after boot, with its action object and the helpers the shell needs. */
export function initShell(actions, helpers = {}) {
  A = actions; H = helpers;
  window.BL = BL;
  // the page's words for the app: its sign-in lasts on this device (the app keeps its own cookies, not the browser's)
  const sub = $('label[for="auth-remember"] .frow-sub'); if (sub) sub.textContent = 'For 30 days on this device';
  // the Settings slider takes the shell's whole range (12–32 px, which the page accepts: index.html, boot) so it shows
  // the size the native stepper or Dynamic Type set; the open web keeps 15–26. openSettings redraws its fill.
  const fs = $('#fontsize'); if (fs) { fs.min = '12'; fs.max = '32'; }
  // the page's own changes reach the shell as they happen: a hash, a verse, a dialog, Home, the theme, a sign-in
  window.addEventListener('hashchange', report);
  ['bs:verse-selected', 'bs:auth-changed', 'bs:auth-lost', 'notes-changed'].forEach(ev => document.addEventListener(ev, report));
  document.addEventListener('change', e => { if (e.target && (e.target.id === 'tr' || e.target.id === 'tr2')) report(); });
  document.addEventListener('input', e => { if (e.target && e.target.id === 'fontsize') report(); });
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', report); } catch (e) { /* old engine */ }
  const mo = new MutationObserver(report);
  mo.observe(html, { attributes: true, attributeFilter: ['data-theme'] });
  mo.observe(document.body, { attributes: true, attributeFilter: ['class'] }); // sheet-modal, home transitions
  // a dialog opening or closing anywhere, those made later too (the Doré viewer, the study document dialog), and its
  // .closing as it starts to leave (or showDialog takes it back)
  const watch = d => dmo.observe(d, { attributes: true, attributeFilter: ['open', 'class'] });
  const dmo = new MutationObserver(recs => {
    const ds = recs.filter(r => r.target.tagName === 'DIALOG'); // not a <details> opening
    ds.forEach(r => { if (r.attributeName === 'open' && r.target.open) watch(r.target); });
    if (ds.length) report();
  });
  dmo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  document.querySelectorAll('dialog').forEach(watch);
  ['home', 'panel', 'drawer'].forEach(id => { const el = document.getElementById(id); if (el) mo.observe(el, { attributes: true, attributeFilter: ['hidden', 'aria-hidden'] }); });
  // the page's own navigation (a verse, a cross-reference, the footer's next chapter) updates the title and the reader
  const title = document.querySelector('title'); if (title) mo.observe(title, { childList: true, characterData: true, subtree: true });
  const reader = document.getElementById('reader'); if (reader) mo.observe(reader, { attributes: true, attributeFilter: ['data-ch'] });
  post('ready', snapshot());
}
