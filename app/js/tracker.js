// Automatic study tracking (.design/profiles-spec.md §4): active time with idle detection, seen verses
// (scroll coverage), read thresholds, study events, and a per-scope outbox flushed in batches.
// Every event is mirrored into the Library at once (library.applyLocal) so the UI never waits for the
// server. In ?dry nothing is written: no localStorage and no non-GET request.
import { state, data, bookOf, DRY, layoutMode } from './store.js';
import * as S from './store.js';

// library.js is optional (main.js loads both guarded): a broken one must not take the tracker down with it.
// Every event also stays in the outbox, and loadLibrary re-applies pendingEvents(), so nothing is lost
// while it loads.
let library = null;
import('./library.js').then(m => { library = m; }, e => { console.error('library.js failed to load', e); });
const libFn = name => (library && typeof library[name] === 'function' ? library[name] : null);
const libState = () => (library && library.lib && typeof library.lib === 'object' ? library.lib : null);

export const CFG = {
  IDLE_MS: 120000, TICK_MS: 1000, SEEN_DWELL_MS: 1500, SEEN_RATIO: 0.6, READ_COVERAGE: 0.9, OPEN_MIN_S: 3,
  STUDY_DWELL_S: 8, FLUSH_MS: 30000, MAX_BATCH: 200, MAX_BATCH_BYTES: 48000, KEEPALIVE_MAX_BYTES: 24000,
  POS_DEBOUNCE_MS: 2000, NOTE_GAP_MS: 600000, TIME_EVENT_MAX_S: 900, POS_HOLD_S: 20,
};
/** Seconds of active reading a chapter needs before it can count as read (≈40% of reading time). */
export function readThreshold(n) { return Math.min(240, Math.max(20, Math.round((+n || 0) * 2.4))); }

const TYPES = new Set(['chapter.open', 'chapter.time', 'chapter.read', 'verse.study', 'xref.open', 'word.study', 'note.save', 'video.add', 'position']);
const NEEDS_VERSE = new Set(['verse.study', 'xref.open', 'word.study']);
const REF_RE = /^[1-9]\d?\.[1-9]\d{0,2}(\.[1-9]\d{0,2})?$/;
const STRONG_RE = /^[HG]\d{1,4}[a-z]?$/;
const TR_RE = /^[a-z0-9]{2,8}$/;
const BATCH_RE = /^[A-Za-z0-9_-]{8,64}$/;
const pad = n => String(n).padStart(2, '0');
/** 'YYYY-MM-DD' in the reader's local time zone. */
export function localDay(t = Date.now()) { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function uid() {
  try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* insecure context */ }
  const a = new Uint8Array(16);
  try { crypto.getRandomValues(a); } catch (e) { for (let i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256); }
  return [...a].map(x => x.toString(16).padStart(2, '0')).join('');
}
/** Identifies this tab on the 'bs-sync' channel (library.js tags its messages with it too). */
export const TAB_ID = uid().replace(/-/g, '').slice(0, 16);

// ------------------------------------------------------------ state
let A = null, inited = false;
let scope = 'guest';
let lastInput = Date.now();          // ms of the last user input in this tab (page load counts)
let otherAt = 0;                     // newest input time announced by another tab
let lastAnnounce = 0, lastMove = 0;
let lastTick = 0;
let shown = false;                   // a chapter is on screen (bs:chapter-rendered received)
let sess = null;                     // the current chapter visit
let timeAcc = Object.create(null);   // 'b.c' -> counted seconds not yet turned into chapter.time
let queue = [], pending = [];        // outbox: events not yet batched / batches not yet acknowledged
let dryLog = [];                     // ?dry: everything tracked this session (re-applied after a Library load)
let lastPosSig = '';
// After a scope change (sign-in, sign-out, another tab's switch) the chapter on screen was not chosen by the new
// profile: its saved place (the resume prompt's) stays until real reading here: a chapter change, a verse selected,
// a scroll by hand, or POS_HOLD_S active seconds after some input here once the resume prompt is gone. 0: not holding,
// else when it began.
let posHold = 0;
let handAt = 0;                      // ms of the last pointerdown/keydown/wheel/touchstart (a scroll alone may be programmatic)
let posT = 0, persistT = 0, persistAt = 0;
let flushP = null, backoff = 0, nextTry = 0, paused = false, leftover = false;
let io = null;
const intersecting = new Set();
const noteGap = new Map(), wordGap = new Map();
let chan = null;

const authScope = () => (state.auth && state.auth.scope) || 'guest';
/** A pre-profiles serve.py answers (no /api/library): track for this page only, send and store nothing. */
const serverless = () => !!(state.auth && state.auth.legacy);
/** A hosted site's guest (hosting brief §2): tracked for this page only, like serverless, and nothing is kept either. */
const readOnly = () => scope === 'guest' && !!(state.auth && state.auth.hosted);
// Each tab keeps its own outbox ('bs-outbox-v1[:uid]#<tab>'). A shared one let a new tab send another live tab's
// queued events under a new batch id, so the server counted them twice. A tab adopts only the outboxes of tabs that
// are gone: each tab holds a Web Lock named after it for its lifetime, so a key whose lock is free is an orphan.
const outboxBase = s => (s === 'guest' ? 'bs-outbox-v1' : `bs-outbox-v1:${s}`);
const outboxKey = s => `${outboxBase(s)}#${TAB_ID}`;
const LOCKS = typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function' ? navigator.locks : null;
if (LOCKS && !DRY) { try { LOCKS.request(`bs-tab:${TAB_ID}`, () => new Promise(() => {})).catch(() => {}); } catch (e) { /* unsupported */ } }
const ORPHAN_MS = 24 * 3600 * 1000;   // without Web Locks: an outbox untouched for a day belongs to a closed tab
const posKey = s => (s === 'guest' ? 'bs-pos-v1' : `bs-pos-v1:${s}`);
const safe = (fn, ...a) => { try { return typeof fn === 'function' ? fn(...a) : undefined; } catch (e) { console.error(e); return undefined; } };

function newVisit(b, c, n) {
  return { b, c, n: n || (bookOf(b)?.chapters[c - 1] || 0), key: `${b}.${c}`, active: 0, seen: new Set(), dwell: new Map(),
    opened: false, readDone: false, study: new Map(), studied: new Set() };
}

// ------------------------------------------------------------ outbox persistence (localStorage, never in dry run)
function loadOutbox(s) {
  const out = { pending: [], queue: [] };
  if (DRY) return out;
  try {
    const j = JSON.parse(localStorage.getItem(outboxKey(s)) || 'null');
    if (j && Array.isArray(j.pending)) out.pending = j.pending.filter(p => p && typeof p.batchId === 'string' && BATCH_RE.test(p.batchId) && Array.isArray(p.events) && p.events.length);
    if (j && Array.isArray(j.queue)) out.queue = j.queue.filter(e => e && typeof e === 'object' && TYPES.has(e.type));
  } catch (e) { /* corrupt outbox: start empty */ }
  return out;
}
function persistNow() {
  clearTimeout(persistT); persistT = 0;
  if (DRY) return;
  persistAt = Date.now();
  try {
    if (!queue.length && !pending.length) localStorage.removeItem(outboxKey(scope));
    else localStorage.setItem(outboxKey(scope), JSON.stringify({ pending, queue, at: Date.now() }));
  } catch (e) { /* private mode / quota */ }
}
/**
 * Take over the unsent events of closed tabs in this scope (and the pre-per-tab shared outbox), once, under an
 * exclusive lock so two new tabs never both take the same one. Returns true when something was adopted.
 */
async function adoptOrphans(s) {
  if (DRY || serverless()) return false;
  const base = outboxBase(s), run = async () => {
    let alive = null;
    if (LOCKS && typeof LOCKS.query === 'function') {
      try { const q = await LOCKS.query(); alive = new Set((q.held || []).map(l => l.name)); } catch (e) { alive = null; }
    }
    const keys = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k === base || (k && k.startsWith(base + '#') && k !== outboxKey(s))) keys.push(k); } } catch (e) { return false; }
    let got = false;
    for (const k of keys) {
      const owner = k === base ? null : k.slice(base.length + 1);
      let j = null; try { j = JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { j = null; }
      if (owner && (alive ? alive.has(`bs-tab:${owner}`) : Date.now() - (+(j && j.at) || 0) < ORPHAN_MS)) continue; // its tab is still open
      try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
      if (s !== scope || !j) continue;
      if (Array.isArray(j.pending)) pending.push(...j.pending.filter(p => p && typeof p.batchId === 'string' && BATCH_RE.test(p.batchId) && Array.isArray(p.events) && p.events.length));
      if (Array.isArray(j.queue)) queue.push(...j.queue.filter(e => e && typeof e === 'object' && TYPES.has(e.type)));
      got = true;
    }
    if (got) persistNow();
    return got;
  };
  try { return LOCKS ? await LOCKS.request(`bs-outbox-adopt:${s}`, run) : await run(); } catch (e) { console.error(e); return false; }
}
/** At most one write per second while events are queued. */
function persistSoon() {
  if (DRY || persistT) return;
  persistT = setTimeout(persistNow, Math.max(0, 1000 - (Date.now() - persistAt)));
}

// ------------------------------------------------------------ events
/** Validate minimally, stamp t/day, enqueue and mirror into the Library. Returns the event or null. */
export function track(type, fields = {}) {
  if (!TYPES.has(type)) return null;
  const b = +fields.b, c = +fields.c, bk = bookOf(b);
  if (!bk || !Number.isInteger(c) || c < 1 || c > bk.chapters.length) return null;
  const n = bk.chapters[c - 1];
  const v = fields.v == null ? 0 : +fields.v;
  if (!Number.isInteger(v) || v < 0 || v > n) return null;
  if (NEEDS_VERSE.has(type) && v < 1) return null;
  const t = Date.now();
  const ev = { type, t, day: localDay(t), b, c };
  if (v || type === 'position' || NEEDS_VERSE.has(type) || type === 'note.save' || type === 'video.add') ev.v = v;
  if (type === 'chapter.time') {
    const sec = Math.floor(+fields.sec);
    if (!(sec >= 1 && sec <= CFG.TIME_EVENT_MAX_S)) return null;
    ev.sec = sec;
  } else if (type === 'xref.open') {
    const to = String(fields.to || '');
    if (!validRef(to)) return null;
    ev.to = to;
  } else if (type === 'word.study') {
    if (typeof fields.strong === 'string' && STRONG_RE.test(fields.strong)) ev.strong = fields.strong;
    if (typeof fields.word === 'string' && fields.word.trim()) ev.word = S.cut(fields.word.trim(), 500);   // by code points: never half an emoji
  } else if (type === 'video.add') {
    const raw = typeof fields.title === 'string' ? fields.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim() : '';
    const title = S.cut(raw, 120);
    if (title) ev.title = title;
  } else if (type === 'position') {
    const sf = +fields.scrollFrac;
    ev.scrollFrac = Number.isFinite(sf) ? Math.round(Math.min(1, Math.max(0, sf)) * 1000) / 1000 : 0;
    if (typeof fields.tr === 'string' && TR_RE.test(fields.tr)) ev.tr = fields.tr;
  }
  if (DRY || serverless() || readOnly()) {
    dryLog.push(ev); if (dryLog.length > 5000) dryLog.splice(0, dryLog.length - 5000);
    if (!DRY && type === 'position' && !readOnly()) { try { localStorage.setItem(posKey(scope), JSON.stringify({ b, c, v, scrollFrac: ev.scrollFrac, t, tr: ev.tr })); } catch (e) { /* ignore */ } }
  } else {
    if (type === 'position') {
      queue = queue.filter(e => e.type !== 'position'); // the queue holds at most one position
      try { localStorage.setItem(posKey(scope), JSON.stringify({ b, c, v, scrollFrac: ev.scrollFrac, t, tr: ev.tr })); } catch (e) { /* ignore */ }
    }
    queue.push(ev);
    persistSoon();
  }
  safe(libFn('applyLocal'), ev);
  return ev;
}

function validRef(s) {
  if (!REF_RE.test(s)) return false;
  const [b, c, v] = s.split('.').map(Number), bk = bookOf(b);
  return !!bk && c <= bk.chapters.length && (!v || v <= bk.chapters[c - 1]);
}

/** Queued + unacknowledged events (the Library re-applies them after every load so nothing flickers back). */
export function pendingEvents() {
  const out = [];
  pending.forEach(p => out.push(...p.events));
  out.push(...queue, ...dryLog);
  return out;
}

/** The current chapter visit, for the UI and for testing. */
export function session() {
  if (!sess) return null;
  const n = sess.n || 0;
  return { b: sess.b, c: sess.c, n, active: Math.round(sess.active * 10) / 10, seenFrac: n ? sess.seen.size / n : 0,
    read: !!safe(libFn('chapterState'), sess.b, sess.c)?.read, threshold: readThreshold(n) };
}

// ------------------------------------------------------------ active time, idle detection
function counting() {
  if (!sess || !shown) return false;
  if (document.visibilityState !== 'visible') return false;
  if (Date.now() - lastInput >= CFG.IDLE_MS) return false;
  if (document.querySelector('dialog[open]')) return false;
  if (otherAt > lastInput) return false;        // another tab has been used more recently
  return true;
}
function onInput() {
  const now = Date.now();
  lastInput = now;
  if (chan && now - lastAnnounce >= 2000) { lastAnnounce = now; try { chan.postMessage({ t: 'active', id: TAB_ID, at: now }); } catch (e) { /* closed */ } }
}
function onHand() { handAt = Date.now(); onInput(); }
function onPointerMove() { const now = Date.now(); if (now - lastMove < 500) return; lastMove = now; onInput(); }

function topbarBottom() { const bar = document.getElementById('topbar'); return Math.max(0, bar ? bar.getBoundingClientRect().bottom : 0); }

/** Verses on screen now: ≥ 60% of the verse visible, or it fills ≥ half the visible area (tall verses). */
function visibleVerses() {
  const out = [];
  if (!intersecting.size) return out;
  const top = topbarBottom();
  let bottom = window.innerHeight - 16;
  if (state.drawerOpen && safe(layoutMode) === 'sheet') {   // the phone sheet covers the lower part
    const d = document.getElementById('drawer'); const r = d && d.getBoundingClientRect();
    if (r && r.top > top && r.top < bottom) bottom = r.top;
  }
  const vh = bottom - top;
  if (vh <= 0) return out;
  for (const el of intersecting) {
    if (!el.isConnected) { intersecting.delete(el); continue; }
    const r = el.getBoundingClientRect();
    const h = Math.min(r.bottom, bottom) - Math.max(r.top, top);
    if (h <= 0 || !r.height) continue;
    if (h / r.height >= CFG.SEEN_RATIO || h >= vh * 0.5) out.push(+el.dataset.v);
  }
  return out;
}

function tick() {
  const now = performance.now();
  const delta = Math.min(now - lastTick, 2000);
  lastTick = now;
  if (!counting()) return;
  const sec = delta / 1000;
  timeAcc[sess.key] = (timeAcc[sess.key] || 0) + sec;
  sess.active += sec;
  // (only once the reader has touched this tab since the switch: a tab left alone keeps the profile's place)
  if (posHold && handAt > posHold && sess.active >= CFG.POS_HOLD_S && !document.body.classList.contains('has-resume')) { posHold = 0; schedulePosition(); }
  if (!sess.opened && sess.active >= CFG.OPEN_MIN_S) { sess.opened = true; track('chapter.open', { b: sess.b, c: sess.c }); }
  if (!document.body.classList.contains('sheet-modal')) {
    for (const v of visibleVerses()) {
      if (!v) continue;
      const d = (sess.dwell.get(v) || 0) + delta; sess.dwell.set(v, d);
      if (d >= CFG.SEEN_DWELL_MS) sess.seen.add(v);
    }
  }
  checkRead();
  const v = state.selected;
  if (v && state.drawerOpen && state.drawerTab !== 'search' && state.book === sess.b && state.chapter === sess.c && !sess.studied.has(v)) {
    const s = (sess.study.get(v) || 0) + sec; sess.study.set(v, s);
    if (s >= CFG.STUDY_DWELL_S) { sess.studied.add(v); track('verse.study', { b: sess.b, c: sess.c, v }); }
  }
}
function checkRead() {
  if (sess.readDone || !sess.n) return;
  const n = sess.n;
  if (sess.seen.size / n < CFG.READ_COVERAGE || !sess.seen.has(n) || sess.active < readThreshold(n)) return;
  if (safe(libFn('chapterState'), sess.b, sess.c)?.read) return; // already read: keep watching (a manual unmark may follow)
  sess.readDone = true;
  track('chapter.read', { b: sess.b, c: sess.c });
}

// ------------------------------------------------------------ chapter visits, seen verses, position
function observeVerses() {
  if (io) io.disconnect();
  intersecting.clear();
  const verses = document.querySelectorAll('#reader .verse');
  if (!('IntersectionObserver' in window)) { verses.forEach(v => intersecting.add(v)); return; }
  const top = Math.round(topbarBottom());
  io = new IntersectionObserver(entries => {
    for (const e of entries) { if (e.isIntersecting) intersecting.add(e.target); else intersecting.delete(e.target); }
  }, { rootMargin: `-${top}px 0px -16px 0px`, threshold: [0, CFG.SEEN_RATIO] });
  verses.forEach(v => io.observe(v));
}
function onChapterRendered(e) {
  const d = (e && e.detail) || {};
  const b = +d.b || state.book, c = +d.c || state.chapter;
  if (!bookOf(b)) return;
  shown = true;
  const key = `${b}.${c}`;
  if (!sess || sess.key !== key) { sess = newVisit(b, c, +d.n); posHold = 0; schedulePosition(900); }
  else if (+d.n) sess.n = +d.n;
  observeVerses();
}
function schedulePosition(ms = CFG.POS_DEBOUNCE_MS) { clearTimeout(posT); posT = setTimeout(capturePosition, ms); }
/**
 * The reading line: where a resume parks a verse (main.js resumeTo scrolls it into view with block 'start',
 * which stops at html's scroll-padding-top, spec: bar height + 28px). Capturing against the same line makes
 * resume → capture return the same verse, so a reload never walks the position back.
 */
function readingLine() {
  let pad = NaN;
  try { pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop); } catch (e) { /* no layout */ }
  return (Number.isFinite(pad) && pad > 0 ? pad : topbarBottom() + 28) + 2;
}
/** v = the selected verse, else the first verse whose bottom is below the reading line (0 while the chapter top is in view). */
function capturePosition() {
  clearTimeout(posT);
  if (posHold) return; // a scope change: the profile's saved place stands until real reading (see posHold)
  if (!sess || !shown || state.book !== sess.b || state.chapter !== sess.c) return;
  const reader = document.getElementById('reader');
  if (!reader || reader.dataset.ch !== sess.key) return; // mid navigation
  let v = state.selected && state.selected <= sess.n ? state.selected : 0;
  if (!v) {
    const lim = readingLine();
    const verses = reader.querySelectorAll('.verse');
    if (verses.length && verses[0].getBoundingClientRect().top < lim) {
      for (const el of verses) { if (el.getBoundingClientRect().bottom > lim) { v = +el.dataset.v; break; } }
    }
  }
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const sf = max > 0 ? Math.round(Math.min(1, Math.max(0, window.scrollY / max)) * 1000) / 1000 : 0;
  const tr = TR_RE.test(String(state.tr || '')) ? state.tr : undefined;
  const sig = `${scope}|${sess.key}|${v}|${sf}|${tr || ''}`;
  if (sig === lastPosSig) return;
  lastPosSig = sig;
  track('position', { b: sess.b, c: sess.c, v, scrollFrac: sf, tr });
}

// ------------------------------------------------------------ study signals from other modules (§5.14)
function refParts(key) {
  const p = String(key || '').split('.').map(Number);
  return { b: p[0], c: p[1], v: p[2] || 0 };
}
function onNoteSaved(e) {
  const d = (e && e.detail) || {};
  if (d.deleted || !d.key) return;
  const now = Date.now(), last = noteGap.get(d.key) || 0;
  if (now - last < CFG.NOTE_GAP_MS) return;
  const r = refParts(d.key);
  if (track('note.save', r)) noteGap.set(d.key, now);
}
function onXref(e) {
  const d = (e && e.detail) || {};
  const v = +d.v || 0; if (!v) return;
  track('xref.open', { b: +d.b || state.book, c: +d.c || state.chapter, v, to: d.to });
}
/** A psalm title's word ('c:0' in the original data) that verse 1 does not have: same Strong's (and text, if given). */
function titleWord(orig, c, strong, word) {
  const t = orig && orig[`${c}:0`]; if (!Array.isArray(t) || !t.length) return false;
  // its Strong's, or one of its further roots (the drawer has a button for each)
  const same = w => Array.isArray(w) && (w[3] === strong || (Array.isArray(w[7]) && w[7].includes(strong))) && (!word || String(w[0] || '').trim() === word);
  return t.some(same) && !(orig[`${c}:1`] || []).some(same);
}
async function onWord(e) {
  const d = (e && e.detail) || {};
  const b = +d.b || state.book, c = +d.c || state.chapter, v = +d.v || 0;
  if (!v) return;
  let strong = typeof d.strong === 'string' ? d.strong : '';
  let word = typeof d.word === 'string' ? d.word : '';
  const idx = Number.isInteger(d.word) ? d.word : null;
  if (idx != null && idx < 0) return; // a psalm title's word (reader.js numbers them -1, -2…): not verse 1's text
  if (idx != null && (!strong || !word)) {
    // main.js passes the word's index in the verse: resolve it to the original word and its Strong's number
    try { const w = (await data.orig(b))[`${c}:${v}`]?.[idx]; if (w) { word = word || String(w[0] || ''); strong = strong || String(w[3] || ''); } } catch (err) { /* no data */ }
  }
  if (!STRONG_RE.test(strong)) strong = ''; // many Hebrew preposition+suffix words (לָכֶם 'to you') have none: keep the word itself
  if (!strong && !word) return; // nothing to name: an empty signal
  if (strong && idx == null && v === 1) {
    // the drawer's Original tab lists a psalm's title words under verse 1 (they signal their Strong's and text)
    try { if (titleWord(await data.orig(b), c, strong, word)) return; } catch (err) { /* no data */ }
  }
  const k = `${b}.${c}.${v}|${strong}|${word}`, now = Date.now();
  if (now - (wordGap.get(k) || 0) < 60000) return; // one lookup, several signals (select + tab) → one event
  wordGap.set(k, now);
  if (wordGap.size > 200) wordGap.clear();
  track('word.study', { b, c, v, strong: strong || undefined, word: word || undefined });
}
function onVideo(e) {
  const d = (e && e.detail) || {};
  if (!d.key) return;
  track('video.add', { ...refParts(d.key), title: d.title });
}

// ------------------------------------------------------------ flush
function timeEvents() {
  for (const key of Object.keys(timeAcc)) {
    let s = Math.floor(timeAcc[key]);
    if (s < 1) { if (!sess || key !== sess.key) delete timeAcc[key]; continue; }
    timeAcc[key] -= s; // the remainder carries over
    const [b, c] = key.split('.').map(Number);
    while (s > 0) { const part = Math.min(s, CFG.TIME_EVENT_MAX_S); track('chapter.time', { b, c, sec: part }); s -= part; }
  }
}
function buildBatches() {
  if (!queue.length) return;
  let cur = [], bytes = 0;
  const cut = [];
  for (const ev of queue) {
    const sz = JSON.stringify(ev).length + 1;
    if (cur.length && (cur.length >= CFG.MAX_BATCH || bytes + sz > CFG.MAX_BATCH_BYTES - 120)) { cut.push(cur); cur = []; bytes = 0; }
    cur.push(ev); bytes += sz;
  }
  if (cur.length) cut.push(cur);
  cut.forEach(events => pending.push({ batchId: uid(), events }));
  queue = [];
}
/**
 * POST one batch as `owner` (the scope whose outbox it came from). S.api stamps X-BS-Scope from
 * state.auth.scope while it builds the request (synchronously, before its first await), so it is used only
 * when that equals the owner; otherwise the header is set here. Never sends a batch under another profile.
 */
async function post(body, keepalive, owner) {
  if (typeof S.api === 'function' && authScope() === owner) {
    const r = await S.api('POST', '/api/library/events', body, { keepalive, scope: owner });
    return { ok: !!(r && r.ok), status: r ? r.status : 0, data: r ? r.data : null, viaApi: true };
  }
  try {
    const res = await fetch('/api/library/events', { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-BS-Scope': owner }, body: JSON.stringify(body) });
    let j = null; try { j = await res.json(); } catch (e) { /* no body */ }
    return { ok: res.ok, status: res.status, data: j };
  } catch (e) { return { ok: false, status: 0, data: null }; }
}
const eventCount = () => pending.reduce((n, p) => n + p.events.length, 0) + queue.length;

/**
 * Turn counted time into chapter.time events, append the current position, cut the queue into batches
 * (moved to the persisted outbox before sending, so a retry reuses its batchId) and send them.
 * Resolves { sent, pending } — pending > 0 means something could not be sent.
 */
export function flush({ keepalive = false } = {}) {
  if (!inited) return Promise.resolve({ sent: 0, pending: 0 });
  if (flushP) {
    // the page is going away while a flush is in flight: at least persist what is left
    if (keepalive && !DRY) { safe(capturePosition); timeEvents(); buildBatches(); persistNow(); }
    return flushP;
  }
  flushP = doFlush(keepalive).catch(e => { console.error(e); return { sent: 0, pending: eventCount() }; }).finally(() => { flushP = null; });
  return flushP;
}
const wfEvent = ev => { const o = { ...ev }; for (const k in o) if (typeof o[k] === 'string') o[k] = S.wellFormed(o[k]); return o; };
async function doFlush(keepalive) {
  safe(capturePosition);
  timeEvents();
  if (DRY) { queue = []; return { sent: 0, pending: 0 }; }
  if (serverless()) return { sent: 0, pending: 0 }; // an outbox left by a newer serve.py waits for it
  if (readOnly()) { dropGuest(); return { sent: 0, pending: 0 }; }
  buildBatches();
  persistNow();
  let sent = 0;
  if (!pending.length) return { sent, pending: 0 };
  if (paused && state.auth && state.auth.lost === false && authScope() === scope) paused = false;
  if (paused || authScope() !== scope) return { sent, pending: eventCount() };
  // Every batch belongs to s0. Another window may switch this tab's profile while a batch is in flight
  // (setScope swaps `pending` for the new scope's outbox): stop before the next batch, and settle the
  // answers that were already on their way in s0's stored outbox, never in the new scope's.
  const s0 = scope;
  const drop = batch => {
    if (scope === s0) pending = pending.filter(p => p !== batch && p.batchId !== batch.batchId);
    else dropStored(s0, batch.batchId);
  };
  for (const batch of pending.slice()) {
    if (scope !== s0 || authScope() !== s0) break;
    // a lone surrogate anywhere makes serve.py refuse (400) and drop the whole batch: repair it to U+FFFD
    const body = { batchId: batch.batchId, events: batch.events.map(wfEvent) };
    if (keepalive && JSON.stringify(body).length > CFG.KEEPALIVE_MAX_BYTES) continue; // stays for the next load
    const r = await post(body, keepalive, s0);
    const here = scope === s0;
    if (r.ok) {
      drop(batch);
      if (!here) continue;
      sent += batch.events.length; backoff = 0; nextTry = 0;
      const rev = r.data && Number.isInteger(r.data.rev) ? r.data.rev : null;
      const L = libState();
      if (rev != null && L) {
        if (L.loaded && rev > L.rev + 1) safe(libFn('refreshSoon')); // someone else wrote too
        if (rev > L.rev) L.rev = rev;
      }
      continue;
    }
    const code = r.data && r.data.error;
    if (S.signInRequired(r) && s0 === 'guest') { if (here) { state.auth.hosted = true; dropGuest(); } break; } // hosted: never retried
    if (r.status === 401 || (r.status === 409 && code === 'scope_mismatch')) {
      if (here) paused = true; // keep the outbox under its scope key until that scope is back
      if (!r.viaApi && here) document.dispatchEvent(new CustomEvent('bs:auth-lost', { detail: r.data }));
      break;
    }
    if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
      console.warn(`Library events rejected (${r.status} ${code || ''}); dropping batch ${batch.batchId}.`);
      drop(batch);
      continue;
    }
    // 5xx, 429 or network: retry later, 30 s, 60 s, 120 s … at most 5 min
    if (here) { backoff = backoff ? Math.min(300000, backoff * 2) : 30000; nextTry = Date.now() + backoff; }
    break;
  }
  persistNow();
  if (scope !== s0) {
    // the new scope's outbox waited for this flush to finish (flush() returned the one in flight)
    if (pending.length || queue.length) setTimeout(() => flush(), 1500);
    return { sent: 0, pending: eventCount() };
  }
  if (sent) {
    safe(libFn('announce'), libState() ? libState().rev : undefined);
    // events left from a previous page were not in the Library this page loaded: show them
    if (leftover) { leftover = false; safe(libFn('refreshSoon')); }
  }
  return { sent, pending: eventCount() };
}
/** A hosted guest's outbox (left from before the site was known to be hosted): dropped, never sent or kept. */
function dropGuest() {
  queue = []; pending = [];
  persistNow();
  try { localStorage.removeItem(posKey('guest')); } catch (e) { /* ignore */ }
}
/** Remove an acknowledged (or rejected) batch from a scope's stored outbox that is no longer the live one. */
function dropStored(s, batchId) {
  if (DRY) return;
  try {
    const j = JSON.parse(localStorage.getItem(outboxKey(s)) || 'null');
    if (!j || !Array.isArray(j.pending)) return;
    const left = j.pending.filter(p => !(p && p.batchId === batchId));
    if (left.length === j.pending.length) return;
    const q = Array.isArray(j.queue) ? j.queue : [];
    if (!left.length && !q.length) localStorage.removeItem(outboxKey(s));
    else localStorage.setItem(outboxKey(s), JSON.stringify({ pending: left, queue: q }));
  } catch (e) { /* corrupt or unavailable storage: the server ignores a repeated batchId anyway */ }
}
function autoFlush() {
  if (!inited || flushP || Date.now() < nextTry) return;
  let secs = 0; for (const k in timeAcc) secs += timeAcc[k];
  if (queue.length || pending.length || secs >= 30) flush();
}

// ------------------------------------------------------------ scope
/** Load that scope's outbox and start a fresh chapter visit. Anything unsent stays under the old scope's key. */
export function setScope(next) {
  next = typeof next === 'string' && next ? next : 'guest';
  const changed = next !== scope;   // the same scope again (a sign-in resumed after it was lost) keeps the visit
  if (changed) {
    if (inited && !DRY) { timeEvents(); buildBatches(); persistNow(); }
    scope = next;
    const ob = loadOutbox(scope);
    pending = ob.pending; queue = ob.queue;
    leftover = !!(pending.length || queue.length);
    timeAcc = Object.create(null);
    noteGap.clear(); wordGap.clear();
    lastPosSig = '';
    if (!DRY) dryLog = []; // a hosted guest's page-only reading never shows up in the profile signed in next
  }
  paused = false; backoff = 0; nextTry = 0;
  if (changed) {
    // never write the chapter on screen over the new profile's saved place before the resume prompt had its chance
    if (sess) { sess = newVisit(sess.b, sess.c, sess.n); posHold = Date.now(); clearTimeout(posT); }
    if (inited) adoptOrphans(scope).then(got => { if (got) leftover = true; if (got || pending.length || queue.length) setTimeout(() => flush(), 1500); });
  } else if (inited && (pending.length || queue.length)) setTimeout(() => flush(), 1500);
}

// ------------------------------------------------------------ init
export function initTracker(actions) {
  A = actions || A;
  if (inited) return;
  inited = true;
  scope = authScope();
  const ob = loadOutbox(scope);
  pending = ob.pending; queue = ob.queue;
  lastTick = performance.now();

  const opt = { passive: true, capture: true };
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(t => window.addEventListener(t, onHand, opt));
  window.addEventListener('pointermove', onPointerMove, opt);
  window.addEventListener('scroll', () => {
    onInput();
    if (posHold && handAt > posHold && Date.now() - handAt < 1000) posHold = 0; // scrolled by hand since the scope change
    schedulePosition();
  }, { passive: true });
  window.addEventListener('focus', onInput);
  document.addEventListener('selectionchange', onInput);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush({ keepalive: true });
    else lastTick = performance.now();
  });
  window.addEventListener('pagehide', () => flush({ keepalive: true }));
  window.addEventListener('online', () => { backoff = 0; nextTry = 0; flush(); });

  document.addEventListener('bs:chapter-rendered', onChapterRendered);
  document.addEventListener('bs:verse-selected', () => { posHold = 0; schedulePosition(); });
  document.addEventListener('bs:xref-opened', onXref);
  document.addEventListener('bs:word-studied', e => { onWord(e).catch(err => console.error(err)); });
  document.addEventListener('bs:note-saved', onNoteSaved);
  document.addEventListener('bs:video-added', onVideo);
  document.addEventListener('bs:auth-changed', e => { const s = e.detail && e.detail.scope; if (s && s !== scope) setScope(s); else paused = false; });

  try {
    chan = new BroadcastChannel('bs-sync');
    chan.addEventListener('message', e => {
      const m = e.data;
      if (m && m.t === 'active' && m.id !== TAB_ID && +m.at > otherAt) otherAt = +m.at;
    });
  } catch (e) { chan = null; }

  setInterval(tick, CFG.TICK_MS);
  setInterval(autoFlush, CFG.FLUSH_MS);

  // a chapter may already be on screen (initTracker ran after the first render)
  const r = document.getElementById('reader');
  if (r && r.dataset.ch && r.querySelector('.verse')) {
    const [b, c] = r.dataset.ch.split('.').map(Number);
    onChapterRendered({ detail: { b, c, n: r.querySelectorAll('.verse').length } });
  }
  // closed tabs' unsent events (and a previous session's) are sent by whichever tab opens next
  adoptOrphans(scope).then(got => { if (got || pending.length || queue.length) { leftover = true; setTimeout(() => flush(), 2000); } });
}
