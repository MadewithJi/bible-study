// Annotations (annotations-brief §3): words the reader highlights or comments on, saved per profile. The data layer
// follows links.js (a dirty map per scope, a debounced and keepalive flush with compare-and-set bases, conflicts,
// cross-tab sync). This module also anchors marks in the text (§2.1), draws them with the CSS Custom Highlight API
// (spans where it is missing), and owns the selection bubble and the comment card (§3.2) and the margin popover (§3.3).
import { state, bookOf, refLabel, esc, api, lsGet, lsSet, lsKey, DRY, broadcast, onBroadcast, cut, wellFormed, scrollBehavior, setSaveStatus, pendingNotes, registerSaver, trInfo, readOnlyGuest, guestBlocked, signInRequired, lsDel } from './store.js';
import { icon } from './icons.js';
import * as ui from './ui.js';

// library.js is optional (main.js loads it guarded): the optimistic activity entry and a refresh after new marks
let library = null;
import('./library.js').then(m => { library = m; }, e => { console.error('library.js failed to load', e); });
const libFn = name => (library && typeof library[name] === 'function' ? library[name] : null);
const safe = (fn, ...a) => { try { return typeof fn === 'function' ? fn(...a) : undefined; } catch (e) { console.error(e); return undefined; } };

export const marks = { loaded: false, scope: null, rev: 0, byId: new Map(), byVerse: new Map(), offline: false };

/** Highlight colours (§1): the bookmark palette, with pink from the swatches. '' is a comment shown as a dotted underline. */
export const COLORS = ['yellow', 'green', 'blue', 'pink', 'purple', 'orange'];
const TRS = ['kjv', 'bsb', 'esv', 'nlt'];
const MARKS_KEY = 'bs-marks-v1', DIRTY_KEY = 'bs-marks-dirty-v1';
const ID_RX = /^mk_[0-9a-f]{12}$/;
const REF_RX = /^(\d{1,2})\.(\d{1,3})\.(\d{1,3})$/;
const MAX_KEYS = 1000, MAX_BODY = 900000, KEEPALIVE_MAX = 32000;
const QUOTE_MAX = 2000, CTX_MAX = 32, NOTE_MAX = 20000, OFF_MAX = 100000;
const SEP = ' ';        // between verses: in a quote, and in the chapter text marks are re-anchored in
const NEAR_VERSES = 3;  // a quote found again on its own must start this close to where it was
const DRY_MSG = 'Dry run: nothing is saved.';
// ?nohl draws with spans, as in a browser without the Custom Highlight API (to test the fallback)
const HL = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function'
  && !(typeof location !== 'undefined' && new URLSearchParams(location.search).has('nohl'));
const HL_NAMES = [...COLORS.map(c => 'mark-' + c), 'mark-note'];

let A = null, inited = false, early = null;
// a toast made before initMarks (a boot flush that meets a conflict) waits for it, so its Keep mine is not lost
const toast = (msg, action) => { if (A && typeof A.toast === 'function') A.toast(msg, action); else early = [msg, action]; };
const cap = s => s[0].toUpperCase() + s.slice(1);
const readerEl = () => document.getElementById('reader');
const bubbleEl = () => document.getElementById('mark-bubble');
const cardEl = () => document.getElementById('mark-card');

// inline icons (icons.js has none for these): a speech bubble and two sheets; the margin badge can reuse commentIcon()
const svg = (inner, cls = '') => `<svg class="i${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
const COMMENT_PATH = '<path d="M7 4.5h10A2.5 2.5 0 0119.5 7v6.5A2.5 2.5 0 0117 16h-5.5L7.5 19.5V16H7a2.5 2.5 0 01-2.5-2.5V7A2.5 2.5 0 017 4.5z"/>';
export const commentIcon = (cls = '') => svg(COMMENT_PATH, cls);
const COPY_SVG = svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.7a2.2 2.2 0 00-2.2-2.2H6.7a2.2 2.2 0 00-2.2 2.2v6.6a2.2 2.2 0 002.2 2.2h1.8"/>');

// ------------------------------------------------------------ refs and queries
/** 'b.c.v' -> {b, c, v}; null when it is not a verse of this Bible. */
function parseRef(s) {
  const m = REF_RX.exec(String(s || '')); if (!m) return null;
  const b = +m[1], c = +m[2], v = +m[3];
  const bk = b >= 1 ? bookOf(b) : null;
  if (!bk || !(c >= 1 && c <= bk.chapters.length) || !(v >= 1 && v <= bk.chapters[c - 1])) return null;
  return { b, c, v };
}
/** 'John 3:16', 'John 3:16–18' for a mark or a draft. */
export function markLabel(m) {
  const s = parseRef(m && m.start), e = parseRef(m && m.end);
  return s ? refLabel(s.b, s.c, s.v, e && e.v > s.v ? e.v : 0) : '';
}
const vOf = ref => +String(ref).split('.')[2] || 0;
const posCmp = (x, y) => vOf(x.start) - vOf(y.start) || x.so - y.so || vOf(x.end) - vOf(y.end) || x.eo - y.eo || x.created - y.created;

let byChapter = new Map(); // 'b.c' -> Set<id>
function indexAll() {
  const bv = new Map(), bc = new Map();
  for (const m of marks.byId.values()) {
    const s = parseRef(m.start), e = parseRef(m.end); if (!s || !e) continue;
    const ck = `${s.b}.${s.c}`;
    let ch = bc.get(ck); if (!ch) bc.set(ck, ch = new Set()); ch.add(m.id);
    for (let v = s.v; v <= e.v; v++) { const k = `${ck}.${v}`; let x = bv.get(k); if (!x) bv.set(k, x = new Set()); x.add(m.id); }
  }
  marks.byVerse = bv; byChapter = bc;
}
/** Marks touching a verse (any verse of a span), in text order, in any translation. */
export function marksFor(b, c, v) {
  const ids = marks.byVerse.get(`${b}.${c}.${v}`); if (!ids) return [];
  return [...ids].map(id => marks.byId.get(id)).filter(Boolean).sort(posCmp);
}
/** Every mark of a chapter, in text order (any translation). */
export function marksInChapter(b, c) {
  const ids = byChapter.get(`${b}.${c}`); if (!ids) return [];
  return [...ids].map(id => marks.byId.get(id)).filter(Boolean).sort(posCmp);
}
export const getMark = id => marks.byId.get(id) || null;
export const markCount = () => marks.byId.size;

// ------------------------------------------------------------ the mark object
const num = x => (Number.isFinite(+x) && +x > 0 ? Math.round(+x) : 0);
const offset = x => (Number.isInteger(x) && x >= 0 && x <= OFF_MAX ? x : -1);
/** A mark as this module keeps it (from the server, the browser mirror or a draft); null when it cannot be one. */
function normMark(raw) {
  if (!raw || typeof raw !== 'object' || !ID_RX.test(raw.id)) return null;
  const s = parseRef(raw.start), e = parseRef(raw.end);
  if (!s || !e || s.b !== e.b || s.c !== e.c || e.v < s.v) return null;
  const so = offset(raw.so), eo = offset(raw.eo);
  if (so < 0 || eo < 0 || (s.v === e.v && eo <= so)) return null;
  const quote = cut(raw.quote, QUOTE_MAX);
  if (!quote.trim()) return null;
  const updated = num(raw.updated) || Date.now();
  return {
    id: raw.id, tr: TRS.includes(raw.tr) ? raw.tr : 'kjv',
    start: `${s.b}.${s.c}.${s.v}`, so, end: `${e.b}.${e.c}.${e.v}`, eo,
    quote, pre: wellFormed(String(raw.pre ?? '').slice(-CTX_MAX)), suf: cut(raw.suf, CTX_MAX),
    color: COLORS.includes(raw.color) ? raw.color : '', note: typeof raw.note === 'string' ? raw.note : '',
    created: num(raw.created) || updated, updated,
  };
}
/** The request copy (§1): every field, text the server can decode, within its limits. */
function wire(m) {
  return { id: m.id, tr: m.tr, start: m.start, so: m.so, end: m.end, eo: m.eo, quote: cut(m.quote, QUOTE_MAX), pre: wellFormed(m.pre),
    suf: wellFormed(m.suf), color: m.color, note: cut(m.note, NOTE_MAX), created: m.created, updated: m.updated };
}
const copyMark = m => ({ ...m });
const MARK_MAX_BYTES = 32 * 1024; // one mark as UTF-8 JSON (§1)
let enc = null;
const utf8Len = s => (enc || (enc = new TextEncoder())).encode(s).length;
/** The size the server measures: Python's json.dumps adds a space after each ':' and ',' (under 30 here; 64 to spare). */
const markBytes = m => utf8Len(JSON.stringify(wire(m))) + 64;
/** "mk_" + 12 hex from crypto (an offline create can be retried as the same mark). */
function newId() {
  const a = new Uint8Array(6);
  try { crypto.getRandomValues(a); } catch (e) { for (let i = 0; i < 6; i++) a[i] = Math.floor(Math.random() * 256); }
  const id = 'mk_' + [...a].map(x => x.toString(16).padStart(2, '0')).join('');
  return marks.byId.has(id) ? newId() : id;
}

// ------------------------------------------------------------ persistence: per-mark changes (as links.js)
let dirty = new Map();    // id -> { op: 'set' | 'del', ts, seq, b? }  b = the server version this edit started from (absent: unknown)
let seq = 0;
let base = new Map();     // id -> the mark's `updated` as last received from the server (null = the server had none)
let marksScope = 'guest'; // whose marks byId, dirty and base hold
let baseKnown = false;    // a GET /api/marks succeeded for marksScope: an id missing from base means "the server has none"
let noServer = '';        // '' | '404' (a serve.py from before annotations) | 'offline': the marks of this browser only
let flushP = null, followP = null, saveTimer = 0, retryTimer = 0, retryDelay = 0, stale = false, loadSeq = 0;

const readJSON = (key, fb) => { try { const v = lsGet(key); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };
// Several tabs of one scope share the stored queue: each entry records its tab, and a tab replaces only its own entries
const TAB = Math.random().toString(36).slice(2, 12);
const adopted = new Set();
const entrySig = (k, e) => `${k}|${e && e.ts}|${(e && e.tab) || ''}`;
function mirror() {
  if (DRY) return;
  if (state.auth.hosted && marksScope === 'guest') { lsDel(lsKey(MARKS_KEY, 'guest')); return; } // never kept for a hosted guest
  const key = lsKey(MARKS_KEY, marksScope), out = Object.fromEntries(marks.byId);
  const stored = readJSON(key, null), dk = readJSON(lsKey(DIRTY_KEY, marksScope), null);
  if (stored && stored.marks && typeof stored.marks === 'object' && dk && dk.d && typeof dk.d === 'object') {
    for (const [id, e] of Object.entries(dk.d)) {
      const theirs = stored.marks[id], mine = out[id];
      if (e && e.tab && e.tab !== TAB && e.op === 'set' && theirs && !(mine && mine.updated >= (+theirs.updated || 0))) out[id] = theirs;
    }
  }
  lsSet(key, JSON.stringify({ v: 1, marks: out }));
}
function persistDirty(scope = marksScope, map = dirty) {
  if (DRY) return;
  const key = lsKey(DIRTY_KEY, scope), stored = readJSON(key, null), d = {};
  if (state.auth.hosted && scope === 'guest') { lsDel(key); return; }
  if (stored && stored.d && typeof stored.d === 'object') {
    for (const [k, e] of Object.entries(stored.d)) {
      if (!e || !e.tab || e.tab === TAB || adopted.has(entrySig(k, e))) continue;
      if (map.has(k) && (+map.get(k).ts || 0) >= (+e.ts || 0)) continue;
      d[k] = e;
    }
  }
  for (const [k, e] of map) d[k] = { ...e, tab: TAB };
  if (!Object.keys(d).length) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } return; }
  lsSet(key, JSON.stringify({ v: 1, seq, d }));
}
function readDirty(scope) {
  const m = new Map(), p = readJSON(lsKey(DIRTY_KEY, scope), null);
  if (p && p.d && typeof p.d === 'object') {
    for (const [k, e] of Object.entries(p.d)) {
      if (!ID_RX.test(k) || !e || (e.op !== 'set' && e.op !== 'del')) continue;
      adopted.add(entrySig(k, e));
      const x = { op: e.op, ts: num(e.ts) || Date.now(), seq: Number.isFinite(+e.seq) ? +e.seq : 0 };
      if (e.b === null || Number.isFinite(e.b)) x.b = e.b;
      m.set(k, x);
    }
    if (Number.isFinite(+p.seq)) seq = Math.max(seq, +p.seq);
  }
  return m;
}
function markDirty(id, op, ts) {
  const prev = dirty.get(id);
  const b = prev ? prev.b : (base.has(id) ? base.get(id) : (baseKnown ? null : undefined));
  const e = { op, ts, seq: ++seq };
  if (b !== undefined) e.b = b;
  dirty.set(id, e);
}
/** bs:marks-changed {reason, ids}: reasons load, refresh, add, edit, delete, conflict, restore. */
function emit(reason, ids = []) {
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('bs:marks-changed', { detail: { reason, ids } }));
}
/** The sheet's save status, shared with the notes: a mark never hides a note that is still saving or failed. */
function status(kind) {
  if (kind !== 'failed' && kind !== 'signedout' && pendingNotes()) return;
  setSaveStatus(kind);
}

/** Switch the in-memory marks to a scope: its browser mirror and its unsent changes; nothing known from the server yet. */
function switchScope(scope) {
  clearTimeout(saveTimer); saveTimer = 0; clearTimeout(retryTimer); retryTimer = 0; retryDelay = 0;
  marksScope = marks.scope = scope;
  baseKnown = false; base = new Map(); marks.rev = 0;
  dirty = readDirty(scope);
  const m = readJSON(lsKey(MARKS_KEY, scope), null), by = new Map();
  if (m && m.marks && typeof m.marks === 'object') for (const [id, raw] of Object.entries(m.marks)) { const x = normMark(raw); if (x && x.id === id) by.set(id, x); }
  for (const [id, e] of dirty) { if (e.b !== undefined) base.set(id, e.b); if (e.op === 'del') by.delete(id); }
  marks.byId = by;
  indexAll();
}

/**
 * Load the current scope's marks: GET /api/marks, with this browser's unsent changes on top (then sent). Without a
 * server, or with one from before annotations (404), the browser's copy is used and kept: nothing is lost or reported.
 */
export async function loadMarks() {
  const my = ++loadSeq, scope = state.auth.scope;
  // the same scope again (a reload of what is shown) keeps memory: in a dry run it is the only copy
  if (scope !== marksScope || !marks.loaded) switchScope(scope);
  if (readOnlyGuest() && dirty.size) { dirty.clear(); persistDirty(); } // nothing a hosted guest made is ever sent
  const r = await api('GET', '/api/marks', null, { scoped: false });
  if (my !== loadSeq || scope !== state.auth.scope || scope !== marksScope) return;
  marks.loaded = true;
  const ok = r.ok && r.data && r.data.marks && typeof r.data.marks === 'object' && !Array.isArray(r.data.marks);
  if (!ok || (r.data.scope && r.data.scope !== scope)) {
    // no server marks (or an answer for another profile: account.js switches): keep what this browser has
    if (!ok) { noServer = r.status === 404 ? '404' : 'offline'; marks.offline = true; }
    indexAll(); emit('load');
    return;
  }
  noServer = ''; marks.offline = false;
  const srv = new Map(), nb = new Map();
  for (const [id, raw] of Object.entries(r.data.marks)) { const x = normMark(raw); if (x && x.id === id) srv.set(id, x); }
  for (const [id, e] of dirty) if (e.b !== undefined) nb.set(id, e.b);
  for (const [id, x] of srv) if (!dirty.has(id)) nb.set(id, x.updated);
  for (const [id, e] of dirty) {
    const mine = marks.byId.get(id);
    if (e.op === 'set' && mine) srv.set(id, mine); else if (e.op === 'del') srv.delete(id);
  }
  marks.byId = srv; base = nb; baseKnown = true;
  marks.rev = Number.isFinite(+r.data.rev) ? +r.data.rev : 0;
  indexAll(); mirror(); emit('load');
  if (dirty.size && !DRY && !state.auth.lost) flushMarks();
}

/** Take the server's version of every mark without unsent local changes (another tab saved). */
export async function refreshMarks() {
  const scope = marksScope;
  if (scope !== state.auth.scope || noServer) return false;
  const r = await api('GET', '/api/marks', null, { scoped: false });
  if (scope !== marksScope || scope !== state.auth.scope) return false;
  if (!(r.ok && r.data && r.data.marks && typeof r.data.marks === 'object')) return false;
  if (r.data.scope && r.data.scope !== scope) return false;
  if (Number.isFinite(+r.data.rev) && +r.data.rev < marks.rev) return false; // older than this tab's own last save
  const changed = [], seen = new Set();
  for (const [id, raw] of Object.entries(r.data.marks)) {
    const x = normMark(raw); if (!x || x.id !== id) continue;
    seen.add(id);
    if (dirty.has(id)) continue;
    const cur = marks.byId.get(id);
    if (!cur || JSON.stringify(cur) !== JSON.stringify(x)) { marks.byId.set(id, x); changed.push(id); }
    base.set(id, x.updated);
  }
  for (const id of [...marks.byId.keys()]) {
    if (seen.has(id) || dirty.has(id)) continue;
    marks.byId.delete(id); base.set(id, null); changed.push(id);
  }
  if (Number.isFinite(+r.data.rev)) marks.rev = +r.data.rev;
  baseKnown = true;
  mirror();
  if (changed.length) { indexAll(); emit('refresh', changed); }
  return true;
}

/**
 * Send every unsent change: POST /api/marks/changes with compare-and-set bases. Resolves { pending } (0 = all on
 * the server). A call while one is in flight runs once more afterwards.
 */
export function flushMarks(opts = {}) {
  if (!flushP) { flushP = doFlush(opts).catch(e => { console.error(e); return { pending: dirty.size }; }).finally(() => { flushP = null; }); return flushP; }
  if (!followP) followP = flushP.then(() => { followP = null; return dirty.size ? flushMarks(opts) : { pending: 0 }; });
  return followP;
}
async function doFlush({ keepalive = false } = {}) {
  clearTimeout(saveTimer); saveTimer = 0; clearTimeout(retryTimer); retryTimer = 0;
  const scope = marksScope;
  if (DRY || scope !== state.auth.scope || !dirty.size || noServer || state.auth.legacy) return { pending: dirty.size };
  if (state.auth.lost) { status('signedout'); return { pending: dirty.size }; } // paused until the profile signs in again
  // a 'set' whose mark is gone from memory is never sent as a delete
  for (const [id, e] of [...dirty]) if (e.op === 'set' && !marks.byId.has(id)) dirty.delete(id);
  const snap = new Map([...dirty].map(([k, e]) => [k, { ...e }]));
  const keys = [...snap.keys()], lost = [], mine = {};
  let changed = false, wasStale = false, created = false;
  for (let i = 0; i < keys.length;) {
    // chunk by key count and body size (the route takes 1 MiB)
    const set = {}, del = {}, cas = {};
    let size = 120, n = 0;
    for (; i < keys.length && n < MAX_KEYS; i++, n++) {
      const id = keys[i], e = snap.get(id), m = marks.byId.get(id);
      let part;
      if (e.op === 'set' && m) { set[id] = wire(m); part = JSON.stringify(set[id]).length; } else { del[id] = e.ts; part = 24; }
      if (e.b !== undefined) cas[id] = e.b;
      size += part + 60;
      if (size > MAX_BODY && n > 0) { delete set[id]; delete del[id]; delete cas[id]; break; }
    }
    const body = { baseRev: marks.rev, set, del, base: cas, day: ui.localDay() };
    const ka = !!keepalive && JSON.stringify(body).length <= KEEPALIVE_MAX;
    const r = await api('POST', '/api/marks/changes', body, { keepalive: ka });
    if (scope !== marksScope) { if (r.ok) settleOtherScope(scope, snap, r.data); return { pending: 0 }; }
    if (!r.ok) {
      persistDirty(); mirror(); // earlier chunks may have landed
      if (r.dry) return { pending: dirty.size };
      const err = r.data && r.data.error;
      if (r.status === 404) { noServer = '404'; marks.offline = true; status('local'); return { pending: dirty.size }; }
      if (r.status === 400 && err === 'invalid_mark' && r.data.field && dirty.has(r.data.field)) {
        // one mark the server refuses must not block every other save: it stays in this browser only
        console.error('serve.py refused the mark', r.data.field, r.data.message || '');
        dirty.delete(r.data.field); persistDirty();
        toast(r.data.message ? `${r.data.message} That highlight is kept in this browser only.` : 'One highlight couldn’t be saved. It’s kept in this browser only.');
        return doFlush({ keepalive });
      }
      if (r.status === 409 && err === 'mark_limit') {
        toast('You’ve reached the limit of 20,000 highlights and comments. Delete some to save new ones.');
        status('failed');
        return { pending: dirty.size };
      }
      if (signInRequired(r) && scope === 'guest') { dropGuestEdits(); return { pending: 0 }; } // hosted: never retried
      const signedOut = r.status === 401 || (r.status === 409 && err === 'scope_mismatch');
      status(signedOut ? 'signedout' : r.offline && !state.serverOk ? 'local' : 'failed');
      if (!(r.status === 409 || r.status === 401 || r.status === 403)) scheduleRetry(); // auth problems wait for account.js
      return { pending: dirty.size };
    }
    const d = r.data || {};
    if (Number.isFinite(+d.rev)) marks.rev = +d.rev;
    changed = changed || !!d.changed;
    wasStale = wasStale || !!d.stale;
    for (const [id, v] of Object.entries(d.versions || {})) {
      const ver = v === null ? null : num(v);
      const cur = dirty.get(id), s = snap.get(id);
      if (s && s.op === 'set' && (s.b === null || s.b === undefined) && !base.get(id) && ver) created = true;
      base.set(id, ver);
      if (cur && s && cur.seq === s.seq) {
        dirty.delete(id);
        const m = marks.byId.get(id); if (m && ver) m.updated = ver; // the server may move `updated` on (stored + 1)
      } else if (cur) cur.b = ver;
    }
    for (const [id, c] of Object.entries(d.conflicts || {})) {
      const theirs = c && typeof c === 'object' ? normMark(c) : null;
      const ver = theirs ? theirs.updated : null;
      base.set(id, ver);
      const cur = dirty.get(id), s = snap.get(id);
      if (cur && s && cur.seq === s.seq) {
        dirty.delete(id);
        const own = marks.byId.get(id);
        mine[id] = own ? copyMark(own) : null;
        if (theirs) marks.byId.set(id, theirs); else marks.byId.delete(id);
        lost.push(id);
      } else if (cur) cur.b = ver; // edited again meanwhile: the newest local edit goes over the newer version
    }
  }
  retryDelay = 0;
  persistDirty(); mirror();
  if (lost.length) { indexAll(); emit('conflict', lost); conflictToast(lost, mine, scope); }
  if (changed) broadcast({ t: 'marks', scope, rev: marks.rev });
  if (created) safe(libFn('refreshSoon')); // the server wrote mark.add activity
  if (wasStale && baseKnown) refreshMarks();
  const unanswered = [...dirty].some(([k, e]) => snap.get(k)?.seq === e.seq);
  if (unanswered) scheduleRetry();
  status(dirty.size ? (unanswered ? 'failed' : 'saving') : 'saved');
  if (dirty.size && !unanswered && !saveTimer && !followP) saveTimer = setTimeout(() => { saveTimer = 0; flushMarks(); }, 700);
  return { pending: dirty.size };
}
/** A flush that finished after this tab switched profiles: clear the sent ids from that profile's stored queue. */
function settleOtherScope(scope, snap, d) {
  const m = readDirty(scope);
  const done = new Set([...Object.keys((d && d.versions) || {}), ...Object.keys((d && d.conflicts) || {})]);
  for (const k of done) if (m.get(k)?.seq === snap.get(k)?.seq) m.delete(k);
  persistDirty(scope, m);
}
/** A hosted guest's marks (only if one got past guestBlocked): the prompt, the queue dropped, the server's shown again. */
function dropGuestEdits() {
  state.auth.hosted = true; guestBlocked();
  dirty.clear(); persistDirty(); mirror();
  status('');
  loadMarks();
}
function scheduleRetry() {
  clearTimeout(retryTimer);
  retryDelay = Math.min(300000, retryDelay ? retryDelay * 2 : 30000);
  retryTimer = setTimeout(() => { retryTimer = 0; if (dirty.size) flushMarks(); }, retryDelay);
}
/** Mirror now; send 700 ms after the last change. */
function scheduleSave() {
  persistDirty(); mirror();
  clearTimeout(saveTimer); saveTimer = 0;
  if (DRY) { status('dry'); return; }
  if (noServer || state.auth.legacy) {
    status('local');
    // serve.py was unreachable at load: look again later, and send what waits once it answers
    if (noServer === 'offline' && !retryTimer) retryTimer = setTimeout(() => { retryTimer = 0; if (noServer === 'offline') loadMarks(); }, 30000);
    return;
  }
  status('saving');
  saveTimer = setTimeout(() => { saveTimer = 0; flushMarks(); }, 700);
}
/** Unsent mark changes for the current scope (0 = all saved). */
export const pendingMarks = () => dirty.size;

function conflictToast(ids, mine, scope) {
  const one = ids.length === 1 ? (marks.byId.get(ids[0]) || mine[ids[0]]) : null;
  const offer = ids.some(id => mine[id] !== undefined);
  const action = offer ? { label: 'Keep mine', run: () => { if (!restoreMarks(mine, scope)) toast('Your version couldn’t be put back.'); } } : undefined;
  toast(one ? `Your highlight in ${markLabel(one)} changed in another window. Showing the newer version.` : `${ids.length} of your highlights changed in another window. Showing the newer versions.`, action);
}
/** "Keep mine" after a conflict: this window's versions go back as fresh edits over the newer ones. Returns how many. */
export function restoreMarks(mine, scope = marksScope) {
  if (!mine || typeof mine !== 'object' || scope !== marksScope || scope !== state.auth.scope || guestBlocked()) return 0;
  const ids = [], now = Date.now();
  for (const [id, m] of Object.entries(mine)) {
    if (!ID_RX.test(id)) continue;
    const x = m ? normMark({ ...m, updated: Math.max(now, (marks.byId.get(id)?.updated || 0) + 1) }) : null;
    if (x) { marks.byId.set(id, x); markDirty(id, 'set', x.updated); } else if (marks.byId.has(id)) { marks.byId.delete(id); markDirty(id, 'del', now); } else continue;
    ids.push(id);
  }
  if (!ids.length) return 0;
  indexAll(); scheduleSave(); emit('restore', ids);
  return ids.length;
}

// ------------------------------------------------------------ edits
/**
 * Create or update a mark from a draft {id?, tr, start, so, end, eo, quote, pre, suf, color, note, created?}.
 * Optimistic: shown at once, sent 700 ms later. An edit keeps the id and `created`. Resolves the stored mark, or null.
 */
export async function saveMark(draft) {
  if (!draft || typeof draft !== 'object' || guestBlocked()) return null; // a hosted site's guest saves nothing
  const prev = draft.id ? marks.byId.get(draft.id) : null;
  const now = Date.now();
  const updated = Math.max(now, prev ? prev.updated + 1 : 0);
  const created = prev ? prev.created : (num(draft.created) && num(draft.created) <= now ? num(draft.created) : updated);
  const m = normMark({ ...(prev || {}), ...draft, id: draft.id && ID_RX.test(draft.id) ? draft.id : newId(), created, updated });
  if (!m) return null;
  marks.byId.set(m.id, m);
  markDirty(m.id, 'set', m.updated);
  indexAll();
  if (!prev && !draft.created) {
    // the server writes mark.add (annotations-brief §2); the Library shows it at once
    const s = parseRef(m.start);
    safe(libFn('applyLocal'), { t: now, type: 'mark.add', b: s.b, c: s.c, v: s.v, ref: m.start, x: { id: m.id, color: m.color, note: !!m.note } });
  }
  scheduleSave();
  emit(prev ? 'edit' : 'add', [m.id]);
  return m;
}
/** Delete a mark (an Undo toast puts it back with the same id and `created`). */
export async function deleteMark(id, { undo = true } = {}) {
  const m = marks.byId.get(id); if (!m || guestBlocked()) return false;
  const was = copyMark(m);
  marks.byId.delete(id);
  markDirty(id, 'del', Date.now());
  indexAll(); scheduleSave(); emit('delete', [id]);
  if (undo) toast(`${was.note ? 'Deleted the comment on' : 'Removed the highlight in'} ${markLabel(was)}.${DRY ? ' ' + DRY_MSG : ''}`, { label: 'Undo', run: () => { saveMark(was); } });
  return true;
}

// ------------------------------------------------------------ verse text and anchors (§2.1, §3.3)
// Never counted: the verse number, the gutter, a folded-in verse's number, the omitted-verse note, screen-reader
// labels, Doré slots and badges, interlinear rows (the words-of-Jesus spans are counted like any text)
const SKIP = '.vx, .om-why, .sr, sup, .vnum, .vmeta, .inter, .art-slot, .art-badge, button, [data-mk-skip]';

/** The counted text nodes of one .vtext with their offsets: { nodes: [{n, at}], len, text }. */
function textInfo(vt) {
  const nodes = []; let text = '';
  const w = document.createTreeWalker(vt, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.nodeType === 1 ? (n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push({ n, at: text.length }); text += n.data; }
  return { nodes, len: text.length, text };
}
/** A verse's reading text: its own .vtext, or in parallel columns that of column `col` (0 primary, 1 parallel). */
function vtextOf(verse, col = 0) {
  if (!verse || !verse.querySelector) return null;
  const cols = verse.querySelector(':scope > .vcols');
  if (cols) return cols.children[col]?.querySelector('.vtext') || null;
  return col ? null : verse.querySelector(':scope > .vtext');
}
/** §2.1: a verse's plain reading text, which mark offsets count in (UTF-16 units). `el`: a .verse or a .vtext. */
export function verseText(el, col = 0) {
  const vt = el && el.classList && el.classList.contains('vtext') ? el : vtextOf(el, col);
  return vt ? textInfo(vt).text : '';
}
/** The reader column showing a translation: 0, 1 (the parallel one) or -1 (not on screen). */
function colFor(root, tr) {
  if (!root || !tr) return -1;
  if (root.dataset.tr === tr) return 0;
  return root.dataset.tr2 && root.dataset.tr2 === tr ? 1 : -1;
}
/** One column's chapter text: verse texts joined by SEP (omitted verses left out), with each verse's start in it. */
function chapterModel(root, col) {
  const verses = new Map(), order = []; let text = '';
  for (const ve of root.querySelectorAll('.verses > .verse')) {
    const vt = vtextOf(ve, col); if (!vt || vt.classList.contains('omitted')) continue;
    const info = textInfo(vt);
    if (order.length) text += SEP;
    info.v = +ve.dataset.v; info.start = text.length;
    verses.set(info.v, info); order.push(info);
    text += info.text;
  }
  return { verses, order, text };
}
/** A chapter-text offset as a verse offset: a start on a separator moves on to the next verse; an end never starts one. */
function vpos(M, g, end) {
  let prev = null;
  for (const i of M.order) {
    if (end ? g <= i.start + i.len : g < i.start + i.len) {
      if (end && g <= i.start && prev) return { v: prev.v, off: prev.len };
      return { v: i.v, off: Math.max(0, g - i.start) };
    }
    prev = i;
  }
  return prev ? { v: prev.v, off: prev.len } : null;
}
function nearest(text, needle, around) {
  if (!needle) return -1;
  let best = -1;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) if (best < 0 || Math.abs(i - around) < Math.abs(best - around)) best = i;
  return best;
}
/** Where a mark's words are in a column (§3.3): the offsets, else pre + quote + suf, else the quote near the old place. */
function locate(m, M) {
  const s = parseRef(m.start), e = parseRef(m.end); if (!s || !e) return null;
  const a = M.verses.get(s.v), z = M.verses.get(e.v);
  if (a && z && m.so <= a.len && m.eo <= z.len && z.start + m.eo > a.start + m.so
    && cut(M.text.slice(a.start + m.so, z.start + m.eo), QUOTE_MAX) === m.quote) return { sv: s.v, so: m.so, ev: e.v, eo: m.eo, moved: false };
  const at = a ? a.start + Math.min(m.so, a.len) : 0;
  let g = -1;
  if (m.pre || m.suf) { g = nearest(M.text, m.pre + m.quote + m.suf, at - m.pre.length); if (g >= 0) g += m.pre.length; }
  if (g < 0) { const q = nearest(M.text, m.quote, at), p = q >= 0 ? vpos(M, q, false) : null; if (p && Math.abs(p.v - s.v) <= NEAR_VERSES) g = q; }
  if (g < 0) return null;
  const p = vpos(M, g, false), q = vpos(M, g + m.quote.length, true);
  return p && q ? { sv: p.v, so: p.off, ev: q.v, eo: q.off, moved: true } : null;
}
function domPoint(info, off, end) {
  const ns = info.nodes; if (!ns.length) return null;
  for (const { n, at } of ns) if (end ? off <= at + n.data.length : off < at + n.data.length) return [n, Math.max(0, off - at)];
  const last = ns[ns.length - 1]; return [last.n, last.n.data.length];
}
function toRange(M, loc) {
  const a = M.verses.get(loc.sv), z = M.verses.get(loc.ev); if (!a || !z) return null;
  const p = domPoint(a, loc.so, false), q = domPoint(z, loc.eo, true); if (!p || !q) return null;
  const r = document.createRange();
  try { r.setStart(p[0], p[1]); r.setEnd(q[0], q[1]); } catch (e) { return null; }
  return r.collapsed ? null : r;
}
/** A located mark as one Range per counted text node: never the verse numbers, gutters, markers or interlinear between. */
function toRanges(M, loc) {
  const out = [];
  for (let v = loc.sv; v <= loc.ev; v++) {
    const info = M.verses.get(v); if (!info) continue;
    const a = v === loc.sv ? loc.so : 0, z = v === loc.ev ? loc.eo : info.len;
    for (const { n, at } of info.nodes) {
      const s = Math.max(a, at), e = Math.min(z, at + n.data.length);
      if (e > s) { const r = document.createRange(); r.setStart(n, s - at); r.setEnd(n, e - at); out.push(r); }
    }
  }
  return out;
}
/** A mark's (or a draft's) column model and place in the chapter shown, or null. */
function located(mark, chapterEl) {
  const root = chapterEl && chapterEl.id !== 'reader' && chapterEl.closest ? chapterEl.closest('#reader') || chapterEl : chapterEl;
  const s = parseRef(mark && mark.start);
  if (!root || !s || root.dataset.ch !== `${s.b}.${s.c}`) return null;
  const col = colFor(root, mark.tr); if (col < 0) return null;
  const M = chapterModel(root, col), loc = locate(mark, M);
  return loc ? { M, loc } : null;
}
/**
 * A mark's (or a draft's) words in the chapter shown, as a live Range; null when that chapter or translation is not
 * on screen or the words cannot be found any more ("text moved").
 */
export function anchor(mark, chapterEl = readerEl()) {
  const L = located(mark, chapterEl);
  return L ? toRange(L.M, L.loc) : null;
}
/** The same words as the pieces that are painted (toRanges); [] when they are not on screen. */
function anchorRanges(mark, chapterEl = readerEl()) {
  const L = located(mark, chapterEl);
  return L ? toRanges(L.M, L.loc) : [];
}

/** The text offset of a boundary point inside one verse's .vtext (points in skipped markup count what lies before). */
function offsetIn(info, node, off) {
  if (node.nodeType === 3) { const hit = info.nodes.find(x => x.n === node); if (hit) return hit.at + Math.min(off, node.data.length); }
  const p = document.createRange();
  try { p.setStart(node, off); } catch (e) { return 0; }
  let n = 0;
  for (const { n: t, at } of info.nodes) { if (p.comparePoint(t, t.data.length) <= 0) n = at + t.data.length; else break; }
  return n;
}
/** Why words may not be annotated now: pick mode (My links), Original on, a dialog or the art viewer. */
function blocked() {
  return document.body.classList.contains('link-picking') || !!state.showOrig || !!document.querySelector('dialog[open]')
    || document.documentElement.classList.contains('art-viewing');
}
/**
 * The selection as a draft mark {tr, start, so, end, eo, quote, pre, suf}, or null: only words of the reader's verses
 * (never the hero, the panel or a field), in one column, across verses of the chapter shown, never an omitted verse.
 */
export function selectionToDraft(sel = window.getSelection?.()) {
  if (!sel || !sel.rangeCount || sel.isCollapsed || blocked()) return null;
  return rangeToDraft(sel.getRangeAt(0));
}
function rangeToDraft(r) {
  const root = readerEl(), box = root && root.querySelector('.verses');
  if (!box || !box.contains(r.startContainer) || !box.contains(r.endContainer)) return null;
  const [b, c] = String(root.dataset.ch || '').split('.').map(Number); if (!b || !c) return null;
  // parallel columns: the one the selection starts in (else ends in), as the reader's copy handler
  const colOf = n => { const d = (n.nodeType === 1 ? n : n.parentElement)?.closest('.vcols > div'); return d ? (d.classList.contains('alt') ? 1 : 0) : -1; };
  let col = colOf(r.startContainer); if (col < 0) col = colOf(r.endContainer); if (col < 0) col = 0;
  const tr = col ? root.dataset.tr2 : root.dataset.tr; if (!TRS.includes(tr)) return null;
  const M = chapterModel(root, col), parts = [];
  for (const ve of box.querySelectorAll(':scope > .verse')) {
    if (!r.intersectsNode(ve)) continue;
    const vt = vtextOf(ve, col); if (!vt || !r.intersectsNode(vt)) continue;
    if (vt.classList.contains('omitted')) return null;
    const info = M.verses.get(+ve.dataset.v); if (!info) continue;
    const a = vt.contains(r.startContainer) ? offsetIn(info, r.startContainer, r.startOffset) : 0;
    const z = vt.contains(r.endContainer) ? offsetIn(info, r.endContainer, r.endOffset) : info.len;
    if (z > a) parts.push({ info, a, z });
  }
  // whitespace at either end is not part of the words
  const blank = p => !p.info.text.slice(p.a, p.z).trim();
  while (parts.length && blank(parts[0])) parts.shift();
  while (parts.length && blank(parts[parts.length - 1])) parts.pop();
  if (!parts.length) return null;
  const f = parts[0], l = parts[parts.length - 1];
  while (f.a < f.z && /\s/.test(f.info.text[f.a])) f.a++;
  while (l.z > l.a && /\s/.test(l.info.text[l.z - 1])) l.z--;
  const g0 = f.info.start + f.a, g1 = l.info.start + l.z;
  return { tr, start: `${b}.${c}.${f.info.v}`, so: f.a, end: `${b}.${c}.${l.info.v}`, eo: l.z, quote: cut(M.text.slice(g0, g1), QUOTE_MAX),
    pre: M.text.slice(Math.max(0, g0 - CTX_MAX), g0), suf: M.text.slice(g1, g1 + CTX_MAX) };
}

// ------------------------------------------------------------ drawing marks (§3.3)
let drawn = new Map(); // id -> { sv, so, ev, eo, moved, range, ranges } for the marks drawn in the chapter shown (range: to place by; ranges: what is painted)
let shown = new Map(); // id -> 'words' | 'moved' | 'other' (another translation) for every mark of the chapter shown

/** Fallback paint: each item's ranges (else its range) in spans (one per piece of a text node; a later item wins an overlap). */
function wrap(items) {
  const per = new Map(); // Text -> [[start, end, item]]
  for (const it of items) for (const r of it.ranges || [it.range]) {
    const host = r.commonAncestorContainer.nodeType === 3 ? r.commonAncestorContainer.parentNode : r.commonAncestorContainer;
    const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!r.intersectsNode(n) || n.parentElement.closest(SKIP)) continue;
      const s = n === r.startContainer ? r.startOffset : 0, e = n === r.endContainer ? r.endOffset : n.data.length;
      if (e > s) { let a = per.get(n); if (!a) per.set(n, a = []); a.push([s, e, it]); }
    }
  }
  for (const [n, segs] of per) {
    const cuts = [...new Set([0, n.data.length, ...segs.flatMap(x => [x[0], x[1]])])].sort((x, y) => x - y);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i], z = cuts[i + 1], t = n.data.slice(a, z); if (!t) continue;
      let top = null; for (const sg of segs) if (sg[0] <= a && sg[1] >= z) top = sg[2];
      if (!top) { frag.append(t); continue; }
      const sp = document.createElement('span'); sp.className = top.cls; if (top.id) sp.dataset.mk = top.id; sp.textContent = t;
      frag.append(sp);
    }
    n.replaceWith(frag);
  }
}
function unwrap(root, sel) {
  const hosts = new Set();
  root.querySelectorAll(sel).forEach(sp => { hosts.add(sp.parentNode); sp.replaceWith(...sp.childNodes); });
  hosts.forEach(h => h && h.normalize());
}
/**
 * Draw the saved marks of the chapter shown: word highlights for marks made in a translation on screen (one
 * highlight per colour; comments without a colour as a dotted underline). Runs after each chapter render and on
 * bs:marks-changed; fires bs:marks-drawn {b, c} after.
 */
export function renderVerseMarks(chapterEl = readerEl()) {
  const root = chapterEl; if (!root) return;
  if (HL) HL_NAMES.forEach(n => CSS.highlights.delete(n)); else unwrap(root, 'span.mk');
  drawn = new Map(); shown = new Map();
  const [b, c] = String(root.dataset.ch || '').split('.').map(Number);
  const models = [], items = [];
  for (const m of b && c ? marksInChapter(b, c) : []) {
    const col = colFor(root, m.tr);
    if (col < 0) { shown.set(m.id, 'other'); continue; }
    const M = models[col] || (models[col] = chapterModel(root, col));
    const loc = locate(m, M), r = loc && toRange(M, loc), ranges = r ? toRanges(M, loc) : [];
    if (!r || !ranges.length) { shown.set(m.id, 'moved'); continue; }
    shown.set(m.id, 'words'); drawn.set(m.id, { ...loc, range: r, ranges });
    items.push({ id: m.id, range: r, ranges, cls: m.color ? 'mark-' + m.color : 'mark-note' });
  }
  if (HL) {
    const g = new Map();
    for (const it of items) { let a = g.get(it.cls); if (!a) g.set(it.cls, a = []); a.push(...it.ranges); }
    for (const [name, rs] of g) CSS.highlights.set(name, new Highlight(...rs));
  } else wrap(items.map(it => ({ ...it, cls: 'mk ' + it.cls })));
  if (pending) repaintPending();
  if (b && c) document.dispatchEvent(new CustomEvent('bs:marks-drawn', { detail: { b, c } }));
}
/** How a mark of the chapter shown is drawn: 'words', 'moved' (its words are not found: margin and drawer only), 'other' (made in a translation not on screen), or null. */
export const markState = id => shown.get(id) || null;
/** A drawn mark's words as a Range (computed afresh with the span fallback), or null. */
export function markRange(id) {
  const d = drawn.get(id); if (!d) return null;
  if (HL && d.range && !d.range.collapsed) return d.range;
  const m = marks.byId.get(id); return m ? anchor(m) : null;
}
/** The drawn marks under a viewport point (§3.3: a click on highlighted words opens the mark rather than the verse). */
export function marksAtPoint(x, y) {
  let node = null, off = 0;
  if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; off = p.offset; } }
  else if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; off = r.startOffset; } }
  if (!node) return [];
  if (!HL) { const sp = (node.nodeType === 1 ? node : node.parentElement)?.closest('span.mk[data-mk]'); return sp ? [sp.dataset.mk] : []; }
  const out = [];
  // the caret snaps to the nearest boundary, so the point must also be on one of the range's line boxes (not the comma after it)
  const onLine = r => [...r.getClientRects()].some(c => x >= c.left && x <= c.right && y >= c.top && y <= c.bottom);
  for (const [id, d] of drawn) { try { if (d.ranges.some(r => r.isPointInRange(node, off) && onLine(r))) out.push(id); } catch (e) { /* another document */ } }
  return out;
}
/** Bring a mark's words into view and flash them (the margin card's quote, the drawer's Show in text). */
let flashT = 0;
export function flashMark(id, { scroll = true } = {}) {
  const r = markRange(id); if (!r) return false;
  if (scroll) {
    const rc = r.getBoundingClientRect(), top = barBottom();
    if (rc.top < top + 12 || rc.bottom > innerHeight - 12) window.scrollBy({ top: rc.top - top - Math.max(48, (innerHeight - top) / 3), behavior: scrollBehavior() });
  }
  clearTimeout(flashT);
  if (HL) {
    const rs = drawn.get(id).ranges.filter(x => !x.collapsed); // the painted pieces, never the verse numbers between
    const h = new Highlight(...(rs.length ? rs : anchorRanges(marks.byId.get(id)))); h.priority = 3; CSS.highlights.set('mark-flash', h);
    flashT = setTimeout(() => CSS.highlights.delete('mark-flash'), 1600);
  } else {
    const sps = [...document.querySelectorAll(`#reader span.mk[data-mk="${id}"]`)];
    sps.forEach(s => s.classList.add('mk-flash'));
    flashT = setTimeout(() => sps.forEach(s => s.classList.remove('mk-flash')), 1600);
  }
  return true;
}

// ------------------------------------------------------------ the selection bubble and the comment card (§3.2)
let pending = null;   // { draft, range, ranges, mark, origin, touch, b, c, at? } while the bubble or the card is open (range: to place by; ranges: what is painted)
let bubbleShown = false, cardShown = false;
let card = null;      // { text0, color }
let lastPointer = 'mouse', selT = 0, keyT = 0, moveRaf = 0;
/** The bubble or the comment card is open. */
export const bubbleOpen = () => bubbleShown || cardShown;

const barBottom = () => { const b = document.getElementById('topbar'); return b ? Math.max(0, b.getBoundingClientRect().bottom) : 0; };
/** Where a float may go: under the top bar, inside the viewport, clear of the side sheet (or above the phone sheet). */
function bounds() {
  const vv = window.visualViewport;
  const B = { left: 8, top: barBottom() + 8, right: (vv ? vv.width : innerWidth) - 8, bottom: (vv ? vv.height : innerHeight) - 8 };
  const dr = document.getElementById('drawer');
  if (state.drawerOpen && dr) {
    const r = dr.getBoundingClientRect();
    if (r.width && r.left > innerWidth / 2) B.right = Math.min(B.right, r.left - 8);
    else if (r.height && r.top > innerHeight / 3) B.bottom = Math.min(B.bottom, r.top - 8);
  }
  return B;
}
/** The pending words' line boxes (the spans' with the fallback). */
function pendingRects() {
  if (!pending) return [];
  let rs = [];
  if (HL && pending.range) rs = [...pending.range.getClientRects()];
  else if (!HL) rs = [...document.querySelectorAll('#reader span.mk-pend')].flatMap(s => [...s.getClientRects()]);
  if (!rs.length && pending.at && pending.at.isConnected) rs = [pending.at.getBoundingClientRect()];
  return rs.filter(r => r.width > 0.5 && r.height > 0.5);
}
/**
 * Put a float above the words (below on touch, so it never meets the system selection menu, or when there is no room
 * above), centred on the nearest line and kept in bounds. false: the words are off screen (or not drawn).
 */
function place(el, { keep = false, gap = 10 } = {}) {
  const rects = pendingRects(), B = bounds(), w = el.offsetWidth, h = el.offsetHeight;
  if (!rects.length) { // a card for words not on screen: the middle of the free area
    if (!keep) return false;
    el.style.left = Math.round(Math.max(B.left, (B.left + B.right - w) / 2)) + 'px'; el.style.top = Math.round(Math.max(B.top, (B.top + B.bottom - h) / 2)) + 'px';
    return true;
  }
  const top = Math.min(...rects.map(r => r.top)), bot = Math.max(...rects.map(r => r.bottom));
  if (!keep && (bot < B.top || top > B.bottom)) return false;
  const gb = pending.touch ? gap + 16 : gap; // below on touch: past the selection handles
  const roomAbove = top - B.top, roomBelow = B.bottom - bot;
  let below = pending.touch || roomAbove < h + gap;
  if (below && roomBelow < h + gb && roomAbove >= h + gap) below = false;
  const y = Math.max(B.top, Math.min(below ? bot + gb : top - gap - h, B.bottom - h));
  const line = below ? rects[rects.length - 1] : rects[0];
  const x = Math.max(B.left, Math.min((line.left + line.right) / 2 - w / 2, B.right - w));
  el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(y) + 'px';
  el.dataset.side = below ? 'below' : 'above';
  return true;
}
/** The native selection is exactly the pending words (it then goes clear, styles.css html.mk-pend-on, so one tint stands for them). */
function samePending() {
  try {
    const s = window.getSelection?.(), r = s && s.rangeCount ? s.getRangeAt(0) : null, p = pending && pending.range;
    return !!(r && p && r.compareBoundaryPoints(Range.START_TO_START, p) === 0 && r.compareBoundaryPoints(Range.END_TO_END, p) === 0);
  } catch (e) { return false; }
}
const syncPendOn = (same = samePending()) => document.documentElement.classList.toggle('mk-pend-on', !!(HL && pending && pending.ranges && pending.ranges.length) && same);
/**
 * A selection change while the bubble or the card is open: the pending tint gives way to a live selection of other
 * words (a handle drag, Shift+arrows) until the keyup or touch re-check shows the bubble for them, so one layer is
 * painted. The card keeps its tint; words selected past it (to copy them) show as selected.
 */
function syncPending() {
  if (!HL || !pending) return;
  const same = samePending(); syncPendOn(same);
  if (!bubbleShown || cardShown) return;
  if (!same && window.getSelection?.()?.isCollapsed === false) CSS.highlights.delete('mark-pending');
  else if (!CSS.highlights.has('mark-pending')) repaintPending();
}
/** The pending words as a highlight (the native selection goes when the focus moves into the comment card). */
function repaintPending() {
  syncPendOn();
  if (HL) {
    if (pending && pending.ranges && pending.ranges.length) { const h = new Highlight(...pending.ranges); h.priority = 2; CSS.highlights.set('mark-pending', h); }
    else CSS.highlights.delete('mark-pending');
    return;
  }
  const root = readerEl(); if (!root) return;
  unwrap(root, 'span.mk-pend');
  const rs = pending ? anchorRanges(pending.draft, root) : [];
  if (rs.length) wrap([{ ranges: rs, cls: 'mk-pend' }]);
}
const sameDraft = (x, y) => !!x && !!y && x.tr === y.tr && x.start === y.start && x.so === y.so && x.end === y.end && x.eo === y.eo;
/** The saved mark whose words hold all of a draft's (the smallest), if any: the bubble then edits it. */
function containing(d) {
  const s = parseRef(d.start), e = parseRef(d.end); if (!s || !e) return null;
  let best = null, size = Infinity;
  for (const [id, x] of drawn) {
    const m = marks.byId.get(id); if (!m || m.tr !== d.tr) continue;
    if ((x.sv - s.v || x.so - d.so) > 0 || (e.v - x.ev || d.eo - x.eo) > 0) continue;
    const n = (x.ev - x.sv) * OFF_MAX + x.eo - x.so;
    if (n < size) { best = m; size = n; }
  }
  return best;
}
/**
 * Where the focus goes back to: the element itself, or (drawn again meanwhile, as a Notes tab button or a gutter badge
 * is when a save redraws them) the element now carrying its id or the same data attributes; null when there is none.
 */
function live(el) {
  if (!el || el === document.body || el.nodeType !== 1) return null;
  if (el.isConnected) return el;
  const sel = el.id ? '#' + CSS.escape(el.id) : [...el.attributes].filter(a => a.name.startsWith('data-')).map(a => `[${a.name}="${CSS.escape(a.value)}"]`).join('');
  return sel ? document.querySelector(el.localName + sel) : null;
}
const say = msg => { const el = document.getElementById('mark-say'); if (el) { el.textContent = ''; setTimeout(() => { el.textContent = msg; }, 60); } };

function bubbleHtml(m) {
  const dots = COLORS.map(c => `<button type="button" class="mb-dot" data-mk-color="${c}" tabindex="-1" aria-label="Highlight ${c}" title="Highlight ${c}"${m ? ` aria-pressed="${m.color === c}"` : ''}><i></i></button>`).join('');
  const com = m && m.note ? 'Edit comment' : 'Comment';
  return `${dots}<span class="mb-sep" aria-hidden="true"></span>`
    + `<button type="button" class="mb-btn" data-mk-act="comment" tabindex="-1">${commentIcon()}<span class="mb-l">${com}</span></button>`
    + `<button type="button" class="mb-btn" data-mk-act="copy" tabindex="-1">${COPY_SVG}<span class="mb-l">Copy</span></button>`
    + (m && m.color ? `<span class="mb-sep" aria-hidden="true"></span><button type="button" class="mb-btn mb-danger" data-mk-act="remove" tabindex="-1">${icon('trash')}<span class="mb-l">Remove highlight</span></button>` : '');
}
/** The roving tab stop of the toolbar: the pressed colour, else the first. */
function rove(el, i) {
  const items = [...el.querySelectorAll('button')]; if (!items.length) return null;
  if (i === undefined) { i = items.findIndex(b => b.getAttribute('aria-pressed') === 'true'); if (i < 0) i = 0; }
  items.forEach((b, k) => { b.tabIndex = k === i ? 0 : -1; });
  return items[i];
}
function showBubble(draft, range, how) {
  const el = bubbleEl(), root = readerEl(); if (!el || !root) return;
  const [b, c] = root.dataset.ch.split('.').map(Number);
  const a = document.activeElement;
  const origin = a && a !== root && root.contains(a) ? a : (pending && pending.origin) || document.getElementById('v' + vOf(draft.start));
  pending = { draft, range: range.cloneRange(), ranges: anchorRanges(draft, root), mark: containing(draft), origin, touch: how === 'touch', b, c };
  el.innerHTML = bubbleHtml(pending.mark);
  rove(el);
  el.classList.toggle('touch', pending.touch);
  el.hidden = false; bubbleShown = true;
  repaintPending();
  if (!place(el)) { closeBubble(); return; }
  if (how === 'key') say('Press Tab to highlight or comment on the selected words.');
}
function closeFloat(el) { if (el) { el.hidden = true; el.innerHTML = ''; el.removeAttribute('style'); } }
/**
 * Close the bubble, or the comment card (as Cancel: typed words come back with Undo). restore: the focus goes back to
 * the text it came from. Returns true when something was open (main.js's Esc chain).
 */
export function closeBubble({ restore = false } = {}) {
  if (cardShown) return closeCard({ restore });
  if (!bubbleShown) return false;
  const el = bubbleEl(), hadFocus = !!el && el.contains(document.activeElement);
  closeFloat(el); bubbleShown = false;
  const p = pending; pending = null; repaintPending();
  const o = (restore || hadFocus) && p ? live(p.origin) : null; if (o) o.focus({ preventScroll: true });
  return true;
}
function considerSelection(how) {
  if (cardShown) return;
  const sel = window.getSelection?.();
  const d = selectionToDraft(sel);
  if (!d) { if (bubbleShown && !bubbleEl()?.contains(document.activeElement)) closeBubble(); return; }
  if (bubbleShown && pending && sameDraft(pending.draft, d)) { place(bubbleEl()); return; }
  showBubble(d, sel.getRangeAt(0), how === 'touch' || lastPointer === 'touch' ? 'touch' : how);
}

async function applyColor(color) {
  const p = pending; if (!p) return;
  // a hosted site's guest: the sign-in prompt (hosting brief §2); Copy in the bubble still works
  if (readOnlyGuest()) { window.getSelection?.()?.removeAllRanges(); closeBubble({ restore: true }); guestBlocked(); return; }
  const dry = DRY ? ' ' + DRY_MSG : '';
  const cur = p.mark ? marks.byId.get(p.mark.id) : null;
  if (cur) {
    if (cur.color !== color) {
      const before = copyMark(cur);
      await saveMark({ ...cur, color });
      toast(`${before.color ? 'Changed the highlight to' : 'Highlighted the words in'} ${color}.${dry}`, { label: 'Undo', run: () => { saveMark(before); } });
    }
  } else {
    const m = await saveMark({ ...p.draft, color, note: '' });
    if (!m) { toast('That highlight couldn’t be saved. Select the words again.'); return; }
    toast(`Highlighted ${markLabel(m)}.${dry}`, { label: 'Undo', run: () => { deleteMark(m.id, { undo: false }); } });
  }
  window.getSelection?.()?.removeAllRanges();
  closeBubble({ restore: true });
}
async function removePending() {
  const p = pending, cur = p && p.mark ? marks.byId.get(p.mark.id) : null; if (!cur) return;
  window.getSelection?.()?.removeAllRanges();
  closeBubble({ restore: true });
  if (!cur.note) { deleteMark(cur.id); return; }
  // a highlight with a comment keeps the comment (as an underline)
  const before = copyMark(cur);
  await saveMark({ ...cur, color: '' });
  toast(`Removed the highlight. The comment on ${markLabel(cur)} stays.${DRY ? ' ' + DRY_MSG : ''}`, { label: 'Undo', run: () => { saveMark(before); } });
}
/** The words as the reader's copy handler gives them: a phrase as it is, several verses numbered with the reference. */
function copyText(d) {
  const s = parseRef(d.start), e = parseRef(d.end), root = readerEl(), col = colFor(root, d.tr);
  const flat = t => t.replace(/\s+/g, ' ').trim();
  if (!s || !e || s.v === e.v || col < 0) return flat(d.quote);
  const M = chapterModel(root, col), lines = [];
  for (let v = s.v; v <= e.v; v++) {
    const i = M.verses.get(v); if (!i) continue;
    const t = flat(i.text.slice(v === s.v ? d.so : 0, v === e.v ? d.eo : i.len));
    if (t) lines.push(`${v} ${t}`);
  }
  return `${lines.join('\n')}\n${markLabel(d)} (${trInfo(d.tr).abbr})`;
}
/** Put text on the clipboard (a hidden field and execCommand when the Clipboard API is refused); true when it worked. */
async function clip(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {
    const a = document.activeElement, ta = document.createElement('textarea'); let ok = false;
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    ta.remove(); if (a && a !== document.body && a.isConnected) a.focus({ preventScroll: true });
    return ok;
  }
}
async function copyPending() {
  const p = pending; if (!p) return;
  const ok = await clip(copyText(p.draft));
  closeBubble({ restore: true });
  toast(ok ? 'Copied the words.' : 'Couldn’t copy. The browser blocked the clipboard.');
}

function cardHtml(p, m) {
  const color = card.color, d = p.draft;
  const tr = d.tr !== state.tr ? ` · ${esc(trInfo(d.tr).abbr)}` : '';
  const quote = d.quote.replace(/\s+/g, ' ').trim();
  const sw = ['', ...COLORS].map(c => `<button type="button" role="radio" class="mc-sw${c ? '' : ' none'}" data-mc-color="${c}" aria-checked="${c === color}" tabindex="${c === color ? 0 : -1}" aria-label="${c ? cap(c) : 'No colour'}" title="${c ? cap(c) : 'No colour: a dotted underline'}"><i>${c ? '' : icon('slash')}</i></button>`).join('');
  return `<p class="mc-ref" id="mc-ref">${m && m.note ? 'Edit comment' : 'Comment'} · ${esc(markLabel(d))}${tr}</p>`
    + `<blockquote class="mc-quote"${color ? ` data-mk-color="${color}"` : ''}>“${esc(quote.length > 400 ? quote.slice(0, 400) : quote)}”</blockquote>`
    + `<div class="editor"><textarea class="note-text mc-text" aria-labelledby="mc-ref" maxlength="${NOTE_MAX}" placeholder="Write a comment…">${esc(card.text0)}</textarea></div>`
    + '<p class="mc-err" role="alert" hidden></p>'
    + `<div class="mc-foot"><div class="mc-colors" role="radiogroup" aria-label="Highlight colour">${sw}</div>`
    + '<div class="mc-btns"><button type="button" class="btn btn-plain sm" data-mc="cancel">Cancel</button>'
    + '<button type="button" class="btn btn-primary sm" data-mc="save" aria-keyshortcuts="Meta+Enter Control+Enter" title="Save (⌘↩ or Ctrl+Enter)">Save</button></div></div>';
}
/** Save is there once the card would store something: words, or a colour. */
function syncCard() {
  const el = cardEl(); if (!el || !card) return;
  const ta = el.querySelector('textarea'), save = el.querySelector('[data-mc="save"]');
  if (save) save.disabled = !(ta && ta.value.trim()) && !card.color;
  el.querySelector('.mc-quote')?.setAttribute('data-mk-color', card.color || '');
  ui.setRadio(el.querySelector('.mc-colors'), b => b.dataset.mcColor === card.color);
}
const cardDirty = () => { const ta = cardShown ? cardEl()?.querySelector('textarea') : null; return !!ta && !!card && ta.value !== card.text0 && !!ta.value.trim(); };
/** Bubble → card: the quote, a textarea, the colours, Cancel and Save, next to the words. */
function openCard({ text, color } = {}) {
  const p = pending, el = cardEl(); if (!p || !el) return;
  if (readOnlyGuest()) { window.getSelection?.()?.removeAllRanges(); closeBubble({ restore: true }); guestBlocked(); return; }
  const b = bubbleEl(); if (bubbleShown) { closeFloat(b); bubbleShown = false; }
  const m = p.mark ? marks.byId.get(p.mark.id) : null;
  card = { text0: m ? m.note : '', color: color !== undefined ? color : (m ? m.color : '') };
  el.innerHTML = cardHtml(p, m);
  el.hidden = false; cardShown = true;
  const ta = el.querySelector('textarea');
  if (text !== undefined) ta.value = text;
  syncCard(); repaintPending();
  // no room either side of the words: bring them up under the bar first
  const rects = pendingRects(), B = bounds(), h = el.offsetHeight;
  if (rects.length) {
    const top = Math.min(...rects.map(r => r.top)), bot = Math.max(...rects.map(r => r.bottom));
    if (top - B.top < h + 10 && B.bottom - bot < h + 26) window.scrollBy(0, top - B.top - 12);
  }
  place(el, { keep: true });
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(ta.value.length, ta.value.length);
}
/** Close the card. Typed words never vanish: a toast offers them back (Undo), or to save them when the passage is gone. */
function closeCard({ restore = true, why = 'cancel' } = {}) {
  if (!cardShown) return false;
  const el = cardEl(), ta = el && el.querySelector('textarea');
  const keep = cardDirty() && pending ? { draft: pending.draft, id: pending.mark && pending.mark.id, text: ta.value, color: card.color } : null;
  const hadFocus = !!el && el.contains(document.activeElement), p = pending;
  closeFloat(el); cardShown = false; card = null; pending = null; repaintPending();
  const o = (restore || hadFocus) && p ? live(p.origin) : null; if (o) o.focus({ preventScroll: true });
  if (keep && why === 'scope') { // nothing to save it to now: the words can still be copied
    toast('Your comment wasn’t saved: the profile changed.', { label: 'Copy it', run: async () => toast(await clip(keep.text) ? 'Copied your comment.' : 'Couldn’t copy. The browser blocked the clipboard.') });
  }
  else if (keep) {
    const label = markLabel(keep.draft);
    toast(why === 'gone' ? `Your comment on ${label} wasn’t saved.` : `Discarded your comment on ${label}.`, { label: why === 'gone' ? 'Save it' : 'Undo', run: () => reopenCard(keep) });
  }
  return true;
}
/** Undo a discarded comment: the card again over its words, or straight to a save when they are not on screen. */
async function reopenCard(keep) {
  const root = readerEl(), r = !blocked() && anchor(keep.draft, root);
  const cur = keep.id ? marks.byId.get(keep.id) : null;
  if (r && !bubbleOpen()) {
    const [b, c] = root.dataset.ch.split('.').map(Number);
    pending = { draft: keep.draft, range: r, ranges: anchorRanges(keep.draft, root), mark: cur, origin: document.getElementById('v' + parseRef(keep.draft.start).v), touch: lastPointer === 'touch', b, c };
    openCard({ text: keep.text, color: keep.color });
    return;
  }
  const before = cur ? copyMark(cur) : null;
  const m = await saveMark(cur ? { ...cur, note: keep.text, color: keep.color } : { ...keep.draft, note: keep.text, color: keep.color });
  if (!m) { toast('That comment couldn’t be saved.'); return; }
  toast(`Saved your comment on ${markLabel(m)}.${DRY ? ' ' + DRY_MSG : ''}`, { label: 'Undo', run: () => { if (before) saveMark(before); else deleteMark(m.id, { undo: false }); } });
}
async function saveCard() {
  const el = cardEl(), p = pending; if (!cardShown || !p || !el) return;
  const ta = el.querySelector('textarea'), err = el.querySelector('.mc-err');
  const note = ta.value.trim() ? ta.value.replace(/\s+$/, '') : '', color = card.color;
  if (!note && !color) return;
  const cur = p.mark ? marks.byId.get(p.mark.id) : null;
  const draft = cur ? { ...cur, note, color } : { ...p.draft, note, color };
  if (markBytes({ ...draft, id: 'mk_000000000000', created: 1, updated: 1 }) > MARK_MAX_BYTES) {
    err.textContent = 'This comment is too long to save. Shorten it and try again.'; err.hidden = false; ta.focus();
    return;
  }
  const before = cur ? copyMark(cur) : null;
  const m = await saveMark(draft);
  if (!m) { err.textContent = 'This comment couldn’t be saved. Select the words again.'; err.hidden = false; return; }
  card.text0 = ta.value; // saved: closing offers no Undo of a discard
  window.getSelection?.()?.removeAllRanges();
  closeCard({ restore: true });
  const dry = DRY ? ' ' + DRY_MSG : '', label = markLabel(m);
  if (before) toast(`${before.note && !note ? 'Removed the comment on' : 'Saved the comment on'} ${label}.${dry}`, { label: 'Undo', run: () => { saveMark(before); } });
  else toast(`${note ? 'Added a comment on' : 'Highlighted'} ${label}.${dry}`, { label: 'Undo', run: () => { deleteMark(m.id, { undo: false }); } });
}
/**
 * Open the comment card for a saved mark (the margin card's and the drawer's Edit). Over its words when they are
 * drawn, else beside `at` (an element, such as the start verse). returnFocus: where the focus goes after.
 */
export function openCommentCard(id, { at = null, returnFocus = null } = {}) {
  const m = marks.byId.get(id), root = readerEl(); if (!m || !root) return false;
  if (cardShown && cardDirty()) { cardEl()?.querySelector('textarea')?.focus(); return false; } // never over typed words
  closeBubble();
  const s = parseRef(m.start), r = anchor(m, root), here = root.dataset.ch === `${s.b}.${s.c}`;
  pending = { draft: copyMark(m), range: r, ranges: r ? anchorRanges(m, root) : [], mark: m, origin: returnFocus || document.activeElement, touch: lastPointer === 'touch', b: s.b, c: s.c,
    at: r ? null : at || (here ? document.getElementById('v' + s.v) : null) };
  openCard();
  return true;
}

function bindFloats() {
  const bub = bubbleEl(), crd = cardEl();
  if (bub) {
    bub.addEventListener('mousedown', e => e.preventDefault()); // the selection and the focus stay in the text
    bub.addEventListener('click', e => {
      const dot = e.target.closest('[data-mk-color]'); if (dot) { applyColor(dot.dataset.mkColor); return; }
      const act = e.target.closest('[data-mk-act]')?.dataset.mkAct;
      if (act === 'comment') openCard(); else if (act === 'copy') copyPending(); else if (act === 'remove') removePending();
    });
    bub.addEventListener('keydown', e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') { e.preventDefault(); closeBubble({ restore: true }); return; }
      if (e.key === 'Tab') { e.preventDefault(); if (pending && pending.origin && pending.origin.isConnected) pending.origin.focus({ preventScroll: true }); return; }
      const items = [...bub.querySelectorAll('button')], i = items.indexOf(document.activeElement);
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (Math.max(0, i) + step + items.length) % items.length;
      rove(bub, n)?.focus();
    });
  }
  if (crd) {
    crd.addEventListener('click', e => {
      const sw = e.target.closest('[data-mc-color]'); if (sw && card) { card.color = sw.dataset.mcColor; syncCard(); return; }
      const act = e.target.closest('[data-mc]')?.dataset.mc;
      if (act === 'cancel') closeCard({ restore: true }); else if (act === 'save') saveCard();
    });
    crd.addEventListener('input', () => { syncCard(); const er = crd.querySelector('.mc-err'); if (er) er.hidden = true; });
    crd.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); closeCard({ restore: true }); return; }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveCard(); return; }
      const group = e.target.closest?.('.mc-colors');
      if (group && ui.radioKeys(e, group, b => { if (card) { card.color = b.dataset.mcColor; syncCard(); } })) return;
      if (e.key === 'Tab') { // a small non-modal card: Tab goes round its own controls
        const f = [...crd.querySelectorAll('textarea, button:not([disabled])')].filter(x => x.tabIndex >= 0);
        const i = f.indexOf(document.activeElement);
        if (f.length && (e.shiftKey ? i <= 0 : i === f.length - 1)) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
      }
    });
  }
}

// ------------------------------------------------------------ the margin: comments at a verse and the popover (§3.3)
/** The commented marks that start at a verse (any translation), in text order: what the gutter's .b-ann counts. */
export function commentsAt(b, c, v) { return marksFor(b, c, v).filter(m => m.note && vOf(m.start) === v); }
/** The .b-ann badge's name. */
export const annLabel = n => (n === 1 ? '1 comment. Show it' : `${n.toLocaleString()} comments. Show them`);
/** A comment as HTML: the Notes tab's Markdown (main.js passes drawer.renderMd as A.renderMd), else plain lines. */
const mdHtml = t => {
  const f = A && typeof A.renderMd === 'function' ? A.renderMd : null;
  return f ? f(t) : `<p>${esc(t).replace(/\n/g, '<br>')}</p>`;
};
const shorten = (t, n) => (t.length > n ? t.slice(0, n).replace(/[\uD800-\uDBFF]$/, '').replace(/\s\S*$/, '') + '…' : t);
const verseList = m => { const s = parseRef(m.start), e = parseRef(m.end); return s && e ? Array.from({ length: e.v - s.v + 1 }, (_, i) => s.v + i) : []; };

/**
 * One mark as a card: the colour bar, the quoted words, the comment (Markdown, folded after six lines), the date, the
 * translation when it is not the reader's and 'Text moved' when its words are not found. menu: the popover's card
 * (the quote flashes the words; a ⋯ menu), else the Notes tab's (Show in text, Edit, Delete).
 */
export function markCardHtml(m, { menu = false } = {}) {
  const s = parseRef(m.start), e = parseRef(m.end); if (!s || !e) return '';
  const label = markLabel(m), st = markState(m.id), what = m.note ? 'comment' : 'highlight';
  const flat = m.quote.replace(/\s+/g, ' ').trim(), quote = esc(shorten(flat, 320));
  const name = `${what} ${m.note ? 'on' : 'in'} ${esc(label)}: “${esc(shorten(flat, 40))}”`; // with the words, so two cards on one verse are told apart
  const when = m.updated - m.created > 60000 ? 'Edited' : 'Added';
  const meta = [m.color ? cap(m.color) : 'Underlined',
    `<time datetime="${new Date(m.updated).toISOString()}" title="${when} ${esc(ui.longDate(m.updated))}">${esc(ui.relTime(m.updated))}</time>`,
    e.v > s.v ? esc(label) : '',
    m.tr !== state.tr ? `<abbr title="Made in the ${esc(trInfo(m.tr).name)}">${esc(trInfo(m.tr).abbr)}</abbr>` : '',
    st === 'moved' ? '<span class="mk-moved" title="These words aren’t in the verse as it reads now, so they aren’t highlighted.">Text moved</span>' : '',
  ].filter(Boolean).join('<span aria-hidden="true"> · </span>');
  const note = m.note ? `<div class="md mk-note" data-mk-note>${mdHtml(m.note)}</div><button class="link mk-more" type="button" data-mk-more aria-expanded="false" hidden>More</button>` : '';
  if (menu) {
    return `<li class="mk-item" data-mk="${m.id}" data-mk-color="${m.color}"><div class="mk-main">`
      + `<button class="mk-quote" type="button" data-mk-show="${m.id}" title="Show the words in the text">“${quote}”</button>${note}<p class="mk-meta">${meta}</p></div>`
      + `<button class="more-btn" type="button" data-mk-menu="${m.id}" aria-haspopup="dialog" aria-expanded="false" aria-label="More actions for the ${name}" title="More">${icon('ellipsis')}</button></li>`;
  }
  return `<li class="mk-item" data-mk="${m.id}" data-mk-color="${m.color}"><div class="mk-main">`
    + `<p class="mk-quote" id="mkq-${m.id}">“${quote}”</p>${note}<p class="mk-meta">${meta}</p>`
    + `<div class="mk-acts"><button class="link" type="button" data-mk-show="${m.id}" aria-describedby="mkq-${m.id}">Show in text</button>`
    + `<button class="link" type="button" data-mk-edit="${m.id}" aria-describedby="mkq-${m.id}">${m.note ? 'Edit' : 'Add a comment'}</button>`
    + `<button class="link danger" type="button" data-mk-del="${m.id}" aria-label="Delete the ${name}">Delete</button></div></div></li>`;
}
/** Comments longer than six lines fold, with More (after the cards are in the page). */
export function foldNotes(root) {
  root.querySelectorAll('[data-mk-note]').forEach(n => {
    const more = n.nextElementSibling;
    if (!more || !more.matches('[data-mk-more]')) return;
    more.hidden = !n.classList.contains('full') && n.scrollHeight <= n.clientHeight + 2;
    n.classList.toggle('folded', !more.hidden);
  });
}
export function toggleFold(btn) {
  const n = btn && btn.previousElementSibling; if (!n || !n.matches('[data-mk-note]')) return;
  const full = n.classList.toggle('full');
  btn.textContent = full ? 'Less' : 'More'; btn.setAttribute('aria-expanded', String(full));
}

/**
 * Bring a mark's words into view and flash them; marks not drawn here (another translation, text moved) flash their
 * verses. select: the start verse becomes the selected verse. In another chapter: go there, then flash.
 */
let revealNext = null; // { id, b, c } until that chapter is drawn
export function revealMark(id, { select = false } = {}) {
  const m = marks.byId.get(id), s = m && parseRef(m.start); if (!s) return false;
  const root = readerEl(), flashVerses = () => { if (A && typeof A.flash === 'function') A.flash(verseList(m), { scroll: false }); };
  if (root && root.dataset.ch === `${s.b}.${s.c}`) {
    const sel = select && state.selected !== s.v && A && typeof A.select === 'function';
    if (sel) A.select(s.v, { open: false }); // ensureVisible scrolls to it
    if (!flashMark(id, { scroll: !sel })) { flashVerses(); if (!sel && A && typeof A.ensureVisible === 'function') A.ensureVisible(s.v); }
    return true;
  }
  if (!A || typeof A.navigate !== 'function') return false;
  revealNext = { id, b: s.b, c: s.c };
  A.navigate(s.b, s.c, s.v);
  return true;
}

let pop = null;      // { b, c, v, ids, from: 'badge' | 'words', origin } while the margin popover is open (ids null: the verse's comments)
let popMenu = null;  // the id whose ⋯ menu is open; popStale: marks changed meanwhile (redrawn when it closes)
let popStale = false;
const popEl = () => document.getElementById('mark-pop');
const PHONE = typeof matchMedia === 'function' ? matchMedia('(max-width: 699px)') : { matches: false };
/** The margin popover is open. */
export const markPopOpen = () => !!pop;
const popMarks = () => (!pop ? [] : pop.ids ? pop.ids.map(id => marks.byId.get(id)).filter(Boolean).sort(posCmp) : commentsAt(pop.b, pop.c, pop.v));
function popTitle(list) {
  const n = list.length, notes = list.filter(m => m.note).length, where = n === 1 ? markLabel(list[0]) : refLabel(pop.b, pop.c, pop.v);
  if (notes === n) return `${n === 1 ? 'Comment' : `${n.toLocaleString()} comments`} on ${where}`;
  if (!notes) return `${n === 1 ? 'Highlight' : `${n.toLocaleString()} highlights`} in ${where}`;
  return `Highlights and comments in ${where}`;
}
/** Draw the popover's cards (again), keeping the focus on the same control of the same card, else of the card now in its place. */
function renderPop() {
  const el = popEl(); if (!pop || !el) return;
  const list = popMarks();
  if (!list.length) { closeMarkPop({ restore: el.contains(document.activeElement) }); return; }
  const ae = document.activeElement, inPop = el.contains(ae), li = inPop ? ae.closest('[data-mk]') : null;
  const was = li ? { id: li.dataset.mk, at: ['data-mk-show', 'data-mk-menu', 'data-mk-more'].find(a => ae.hasAttribute(a)), i: [...el.querySelectorAll('[data-mk]')].indexOf(li) } : null;
  el.innerHTML = `<div class="mp-head"><h2 class="mp-title" id="mp-title">${esc(popTitle(list))}</h2><button type="button" class="close-btn plain" data-mp-close aria-label="Close" title="Close (esc)">${icon('xmark')}</button></div>`
    + `<ul class="mk-list">${list.map(m => markCardHtml(m, { menu: true })).join('')}</ul>`;
  el.hidden = false;
  foldNotes(el);
  if (!placePop()) { closeMarkPop({ restore: inPop }); return; }
  if (was) {
    const cards = [...el.querySelectorAll('[data-mk]')], card = cards.find(x => x.dataset.mk === was.id) || cards[Math.min(was.i, cards.length - 1)];
    const t = card && ((was.at && card.querySelector(`[${was.at}]:not([hidden])`)) || card.querySelector('[data-mk-menu]'));
    (t || el).focus({ preventScroll: true });
  } else if (inPop) el.focus({ preventScroll: true });
}
/**
 * Beside the verse in the page margin (the side with room); else, from the badge, past the verse's bottom (or top) edge,
 * else past the commented words, else under the badge; from the words, under them (over them when there is no room
 * below); a bottom card on a phone. false: the verse is off screen.
 */
function placePop() {
  const el = popEl(); if (!pop || !el || el.hidden) return false;
  const B = bounds(), phone = PHONE.matches;
  el.classList.toggle('sheet', phone);
  el.style.maxHeight = Math.round(Math.max(120, phone ? Math.min(B.bottom - B.top, innerHeight * 0.62) : B.bottom - B.top)) + 'px';
  if (phone) {
    el.style.left = ''; el.style.top = ''; el.style.width = ''; el.style.bottom = Math.round(Math.max(8, innerHeight - B.bottom)) + 'px'; delete el.dataset.side;
    return true;
  }
  el.style.bottom = '';
  const verse = document.getElementById('v' + pop.v); if (!verse) return false;
  const vr = verse.getBoundingClientRect();
  if (vr.bottom < B.top || vr.top > B.bottom) return false;
  // the box round some marks' words on screen, or null
  const box = ids => {
    const rs = ids.flatMap(id => [...(markRange(id)?.getClientRects() || [])]).filter(r => r.width > 0.5 && r.bottom > B.top && r.top < B.bottom);
    return rs.length ? { left: Math.min(...rs.map(r => r.left)), right: Math.max(...rs.map(r => r.right)), top: Math.min(...rs.map(r => r.top)), bottom: Math.max(...rs.map(r => r.bottom)) } : null;
  };
  const badge = pop.from === 'badge' ? verse.querySelector('.vmeta .b-ann') : null;
  let ar = badge && badge.getBoundingClientRect();
  if (!ar || !ar.width) ar = (pop.ids && box(pop.ids.slice(0, 1))) || vr;
  // a margin of 284px or more takes it (narrowed to fit, 260px at least), the right one first
  const room = Math.max(B.right - vr.right, vr.left - B.left) - 24, right = B.right - vr.right - 24 >= Math.min(340, room);
  el.style.width = room >= 260 ? Math.round(Math.min(340, room)) + 'px' : '';
  const w = el.offsetWidth, h = Math.min(el.offsetHeight, B.bottom - B.top);
  let x, y, side = '';
  if (room >= 260) { side = right ? 'right' : 'left'; x = right ? vr.right + 16 : vr.left - 16 - w; y = ar.top - 12; }
  else {
    x = badge ? ar.right - w + 8 : (ar.left + ar.right) / 2 - w / 2;
    // under the badge it would lie over the verse's later lines, the commented words among them
    const fits = r => B.bottom - r.bottom >= h + 8 || r.top - B.top >= h + 8;
    const t = badge ? [vr, box(popMarks().map(m => m.id))].find(r => r && fits(r)) || ar : ar;
    const below = B.bottom - t.bottom >= h + 8 || t.top - B.top < h + 8;
    y = below ? t.bottom + 8 : t.top - 8 - h; side = below ? 'below' : 'above';
  }
  el.style.left = Math.round(Math.max(B.left, Math.min(x, B.right - w))) + 'px';
  el.style.top = Math.round(Math.max(B.top, Math.min(y, B.bottom - h))) + 'px';
  el.dataset.side = side;
  return true;
}
/**
 * Open the margin popover for a verse's comments (from: 'badge') or for the marks under a click (ids, from: 'words').
 * The badge again closes it. Returns true when the click was taken.
 */
export function openMarkPop({ v, ids = null, from = ids ? 'words' : 'badge', origin = null } = {}) {
  const root = readerEl(), el = popEl(); v = +v; if (!root || !el || !v) return false;
  const [b, c] = String(root.dataset.ch || '').split('.').map(Number); if (!b || !c) return false;
  if (cardShown && cardDirty()) { cardEl()?.querySelector('textarea')?.focus(); return true; } // never over typed words
  closeBubble();
  if (pop && pop.from === from && pop.b === b && pop.c === c && pop.v === v && String(pop.ids) === String(ids)) {
    if (from === 'badge') closeMarkPop({ restore: true });
    return true;
  }
  if (popMenu) ui.closeMenu(false);
  pop = { b, c, v, ids: ids ? [...ids] : null, from, origin: origin || document.activeElement };
  renderPop();
  if (!pop) return false;
  if (PHONE.matches) { // the bottom card: the badge or the words stay in sight above it
    const r = ((from === 'badge' && root.querySelector(`#v${v} .vmeta .b-ann`)) || (ids && markRange(ids[0])) || document.getElementById('v' + v))?.getBoundingClientRect();
    const top = innerHeight - (parseFloat(el.style.bottom) || 8) - el.offsetHeight - 16; // layout, not the entrance transform
    if (r && r.bottom > top) window.scrollBy({ top: Math.min(r.bottom - top, r.top - barBottom() - 16), behavior: scrollBehavior() });
  }
  el.focus({ preventScroll: true });
  return true;
}
/** Close the popover. restore: the focus goes back to the badge (or the words' verse). Returns true when it was open. */
export function closeMarkPop({ restore = false, back = true } = {}) {
  if (!pop) return false;
  const el = popEl(), had = !!el && el.contains(document.activeElement), p = pop;
  pop = null; popStale = false;
  if (popMenu) { popMenu = null; ui.closeMenu(false); }
  closeFloat(el); if (el) el.removeAttribute('data-side');
  if (back && (restore || had)) {
    const root = readerEl(), here = root && root.dataset.ch === `${p.b}.${p.c}`;
    const t = here ? (p.from === 'badge' && root.querySelector(`#v${p.v} .vmeta .b-ann`)) || live(p.origin) || document.getElementById('v' + p.v) : null;
    t?.focus({ preventScroll: true });
  }
  return true;
}
function copyMarkText(m) {
  return `“${m.quote.replace(/\s+/g, ' ').trim()}”\n${markLabel(m)} (${trInfo(m.tr).abbr})${m.note ? `\n\n${m.note}` : ''}`;
}
/** The card's ⋯: its colour (No colour too for a comment), Edit (the comment card), Copy and Delete with Undo. */
function openMarkMenu(anchor, id) {
  const m = marks.byId.get(id); if (!anchor || !m) return;
  const sw = c => `<button type="button" role="radio" class="bm-sw${c ? '' : ' none'}" data-mk-color="${c}" data-mm-color="${c}" aria-checked="${c === m.color}" tabindex="${c === m.color ? 0 : -1}" aria-label="${c ? cap(c) : 'No colour'}" title="${c ? cap(c) : 'No colour: a dotted underline'}">${icon(c ? 'check' : 'slash')}</button>`;
  const html = `<div class="bm-menu-head" role="presentation"><div class="bm-colors" role="radiogroup" aria-label="Colour">${(m.note ? [...COLORS, ''] : COLORS).map(sw).join('')}</div></div>
    <hr>
    <div role="menu" aria-label="Actions">
    <button type="button" role="menuitem" data-mmi="edit">${m.note ? 'Edit comment' : 'Add a comment'}${icon('note')}</button>
    <button type="button" role="menuitem" data-mmi="copy">Copy${icon('export')}</button>
    <hr>
    <button type="button" role="menuitem" class="danger" data-mmi="delete">Delete${icon('trash')}</button>
    </div>`;
  const recolour = b => {
    $$q('.bm-sw', b.closest('.bm-colors')).forEach(x => { const on = x === b; x.setAttribute('aria-checked', String(on)); x.tabIndex = on ? 0 : -1; });
    const cur = marks.byId.get(id); if (cur && cur.color !== b.dataset.mmColor) saveMark({ ...cur, color: b.dataset.mmColor });
  };
  popMenu = id;
  const menuEl = ui.openMenu(anchor, html, {
    label: m.note ? `Comment on ${markLabel(m)}` : `Highlight in ${markLabel(m)}`, className: 'bm-menu mk-menu', dialog: true, focus: '[data-mmi="edit"]',
    onClose: () => { popMenu = null; if (popStale) { popStale = false; setTimeout(renderPop, 0); } },
    onClick: async e => {
      const s = e.target.closest('[data-mm-color]'); if (s) { recolour(s); return; }
      const it = e.target.closest('[data-mmi]'); if (!it) return;
      const act = it.dataset.mmi, cur = marks.byId.get(id);
      ui.closeMenu(true);
      if (!cur) return;
      if (act === 'edit') {
        const p = pop; closeMarkPop({ back: false });
        const root = readerEl(), ret = p && ((p.from === 'badge' && root?.querySelector(`#v${p.v} .vmeta .b-ann`)) || document.getElementById('v' + p.v));
        openCommentCard(id, { returnFocus: ret || null });
      } else if (act === 'copy') toast(await clip(copyMarkText(cur)) ? `Copied the ${cur.note ? 'comment' : 'highlight'}.` : 'Couldn’t copy. The browser blocked the clipboard.');
      else if (act === 'delete') deleteMark(cur.id);
    },
    onKeydown: (e, mm) => {
      const t = e.target; if (!t.classList || !t.classList.contains('bm-sw')) return;
      const sws = $$q('.bm-sw', mm), i = sws.indexOf(t);
      let n = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') n = sws[(i + (e.key === 'ArrowRight' ? 1 : -1) + sws.length) % sws.length];
      else if (e.key === 'Home' || e.key === 'End') n = sws[e.key === 'Home' ? 0 : sws.length - 1];
      else if (e.key === 'ArrowDown') { e.preventDefault(); mm.querySelector('[data-mmi]')?.focus(); return; }
      if (n) { e.preventDefault(); n.focus(); recolour(n); }
    },
  });
  if (!menuEl) popMenu = null; // the same ⋯ again: closed
}
const $$q = (sel, root) => [...root.querySelectorAll(sel)];
/** Marks changed while the popover is open: redraw it, or (with its ⋯ menu open) recolour its cards and redraw after. */
function syncPop() {
  if (!pop) return;
  if (!popMenu) { renderPop(); return; }
  popStale = true;
  popEl()?.querySelectorAll('[data-mk]').forEach(li => { const m = marks.byId.get(li.dataset.mk); if (m && li.dataset.mkColor !== m.color) li.dataset.mkColor = m.color; });
}
function bindPop() {
  const el = popEl(); if (!el) return;
  el.addEventListener('click', e => {
    const t = e.target;
    if (t.closest('[data-mp-close]')) { closeMarkPop({ restore: true }); return; }
    const show = t.closest('[data-mk-show]'); if (show) { revealMark(show.dataset.mkShow); return; }
    const more = t.closest('[data-mk-more]'); if (more) { toggleFold(more); return; }
    const mb = t.closest('[data-mk-menu]'); if (mb) { openMarkMenu(mb, mb.dataset.mkMenu); return; }
    const vl = t.closest('.vlink'); if (vl && A && typeof A.goReference === 'function') { e.preventDefault(); closeMarkPop({ back: false }); A.goReference(vl.dataset.ref); }
  });
  el.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); closeMarkPop({ restore: true }); return; }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.vlink')) { e.preventDefault(); e.target.click(); return; }
    if (e.key === 'Tab') { // a non-modal card: Tab goes round its own controls
      const f = [...el.querySelectorAll('button:not([hidden]), a[href], .vlink')].filter(x => x.offsetParent !== null);
      const i = f.indexOf(document.activeElement);
      if (f.length && (i < 0 || (e.shiftKey ? i === 0 : i === f.length - 1))) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
    }
  });
  // a press elsewhere closes it (not on its own ⋯ menu, a gutter badge, the comment card, a toast, or the same words again)
  document.addEventListener('pointerdown', e => {
    if (!pop) return;
    const t = e.target;
    if (!(t instanceof Element) || el.contains(t) || t.closest('.menu, .b-ann, #mark-card, .toast')) return;
    if (pop.ids && t.closest('#reader .vtext') && marksAtPoint(e.clientX, e.clientY).some(id => pop.ids.includes(id))) return;
    closeMarkPop();
  }, true);
}

// ------------------------------------------------------------ init
/** Wire the selection bubble, the comment card, drawing after each render, cross-tab sync and page lifecycle. Idempotent. */
export function initMarks(actions) {
  A = actions || A;
  if (early && A && typeof A.toast === 'function') { const [m, a] = early; early = null; A.toast(m, a); }
  if (inited || typeof document === 'undefined') return;
  inited = true;
  registerSaver('marks', { flush: () => flushMarks(), pending: pendingMarks }); // store.exportObsidian, account.js flushAll
  bindFloats();
  bindPop();
  // a selection ends: the mouse goes up (not the end of a double click, which opens the note), a Shift key goes up,
  // or a touch selection stops changing
  document.addEventListener('pointerdown', e => {
    lastPointer = e.pointerType || 'mouse';
    const t = e.target;
    if (bubbleShown && !bubbleEl()?.contains(t)) closeBubble();
    if (cardShown && !cardEl()?.contains(t) && !cardDirty()) closeCard({ restore: false }); // typed words wait for Cancel or Save
  }, true);
  document.addEventListener('mouseup', e => {
    if (e.button !== 0 || e.detail >= 2 || e.target.closest?.('#mark-bubble, #mark-card')) return;
    if (blocked()) return; // now, not after the click: pick mode (My links) ends on that click
    setTimeout(() => considerSelection('mouse'), 0);
  });
  document.addEventListener('keyup', e => {
    if (!(e.key === 'Shift' || (e.shiftKey && /^(Arrow|Home$|End$|Page)/.test(e.key)))) return;
    if (e.target.closest?.('#mark-bubble, #mark-card, input, textarea, select, [contenteditable="true"]') || blocked()) return;
    clearTimeout(keyT); keyT = setTimeout(() => considerSelection('key'), 120);
  });
  document.addEventListener('selectionchange', () => {
    syncPending();
    if (lastPointer !== 'touch' || cardShown) return;
    clearTimeout(selT); if (blocked()) return; selT = setTimeout(() => considerSelection('touch'), 450);
  });
  // Tab from the selected text goes into the bubble
  document.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || e.shiftKey || e.defaultPrevented || !bubbleShown) return;
    const el = bubbleEl(), a = document.activeElement, root = readerEl();
    if (!el || el.contains(a) || (a && a !== document.body && !(root && root.contains(a)))) return;
    e.preventDefault(); rove(el)?.focus();
  }, true);
  // Shift+arrows on a focused verse start a selection there (no caret in the text, so the browser would not); once
  // there is one, the browser extends it and the keyup above shows the bubble
  document.addEventListener('keydown', e => {
    if (!e.shiftKey || e.metaKey || e.ctrlKey || e.defaultPrevented || !/^(Arrow(Left|Right|Up|Down)|Home|End)$/.test(e.key)) return;
    const v = e.target.closest?.('#reader .verses > .verse'); if (!v || e.target !== v || blocked()) return;
    const sel = window.getSelection(); if (!sel || (!sel.isCollapsed && sel.rangeCount && sel.getRangeAt(0).intersectsNode(v))) return;
    const vt = vtextOf(v, 0); if (!vt || vt.classList.contains('omitted')) return;
    const info = textInfo(vt); if (!info.nodes.length) return;
    e.preventDefault();
    const back = /Left|Up|Home/.test(e.key), p = back ? domPoint(info, info.len, true) : domPoint(info, 0, false);
    sel.setBaseAndExtent(p[0], p[1], p[0], p[1]);
    const unit = /Home|End/.test(e.key) ? 'lineboundary' : /Up|Down/.test(e.key) ? 'line' : 'word';
    for (let i = 0; i < 3; i++) { // a word, not a lone full stop or quote mark
      sel.modify('extend', back ? 'backward' : 'forward', unit);
      if (unit !== 'word' || /[\p{L}\p{N}]/u.test(sel.toString())) break;
    }
  });
  const onMove = () => {
    if (moveRaf || !(bubbleOpen() || pop)) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      if (bubbleShown && !place(bubbleEl())) closeBubble(); else if (cardShown) place(cardEl(), { keep: true });
      if (pop && !placePop()) closeMarkPop(); // its verse scrolled away (a phone's bottom card stays)
    });
  };
  window.addEventListener('scroll', onMove, { passive: true });
  window.addEventListener('resize', onMove);
  window.visualViewport?.addEventListener('resize', onMove);
  document.addEventListener('bs:chapter-rendered', () => {
    renderVerseMarks();
    if (pop) { const root = readerEl(); if (!root || root.dataset.ch !== `${pop.b}.${pop.c}`) closeMarkPop({ back: false }); else syncPop(); }
    if (!pending) return;
    if (cardShown && !pending.range) { place(cardEl(), { keep: true }); return; } // a card for words that were not drawn stays
    const root = readerEl(), gone = () => (cardShown ? closeCard({ restore: false, why: 'gone' }) : closeBubble());
    if (!root || root.dataset.ch !== `${pending.b}.${pending.c}` || blocked() || colFor(root, pending.draft.tr) < 0) { gone(); return; }
    const r = anchor(pending.draft, root);
    if (!r) { gone(); return; }
    pending.range = r; pending.ranges = anchorRanges(pending.draft, root); repaintPending();
    if (pending.origin && !pending.origin.isConnected) pending.origin = document.getElementById('v' + parseRef(pending.draft.start).v);
    if (bubbleShown) { if (!place(bubbleEl())) closeBubble(); } else place(cardEl(), { keep: true });
  });
  document.addEventListener('bs:marks-changed', () => {
    renderVerseMarks();
    syncPop();
    if (bubbleShown && pending) { // the words' mark changed (another tab, an Undo): the bubble follows it
      const m = containing(pending.draft);
      if ((m && m.id) !== (pending.mark && pending.mark.id) || (m && m.color !== pending.mark.color)) {
        const el = bubbleEl(), i = [...el.querySelectorAll('button')].indexOf(document.activeElement);
        pending.mark = m; el.innerHTML = bubbleHtml(m);
        const f = rove(el, i >= 0 ? Math.min(i, el.querySelectorAll('button').length - 1) : undefined);
        if (i >= 0 && f) f.focus();
      }
    }
  });
  document.addEventListener('bs:auth-changed', () => { if (cardShown) closeCard({ restore: false, why: 'scope' }); else closeBubble(); closeMarkPop({ back: false }); });
  // revealMark in another chapter: flash once it is drawn
  document.addEventListener('bs:marks-drawn', e => {
    const r = revealNext, d = e.detail || {}; if (!r || d.b !== r.b || d.c !== r.c) return;
    revealNext = null;
    setTimeout(() => { const m = marks.byId.get(r.id); if (m && !flashMark(r.id, { scroll: false }) && A && typeof A.flash === 'function') A.flash(verseList(m), { scroll: false }); }, 60);
  });
  // lifecycle: send on hide or close; pick up another tab's save when shown
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (dirty.size && !DRY) flushMarks({ keepalive: true }); }
    else if (stale) { stale = false; refreshMarks(); }
  });
  window.addEventListener('pagehide', () => { if (dirty.size && !DRY) flushMarks({ keepalive: true }); });
  window.addEventListener('online', () => {
    if (DRY) return;
    if (noServer === 'offline') loadMarks(); else if (dirty.size) flushMarks();
  });
  onBroadcast(m => {
    if (m.t !== 'marks' || m.scope !== state.auth.scope || m.scope !== marksScope) return;
    if (Number.isFinite(m.rev) && m.rev <= marks.rev) return;
    if (document.visibilityState === 'visible') refreshMarks(); else stale = true;
  });
  renderVerseMarks(); // a chapter rendered before this module was ready
}
