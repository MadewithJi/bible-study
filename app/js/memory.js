// Memorize (memorize-brief §3): the reader's memory verses, saved per profile. One current verse, up to three teed up,
// and those written on the heart; the schedule is memsched.js's. The data layer follows marks.js (a dirty map per scope,
// a debounced and keepalive flush with compare-and-set bases, conflicts, cross-tab sync, the browser mirror); the
// practice (practice.js) and the Library's Memory view are loaded when a toast's button first needs them.
import { state, bookOf, refLabel, api, lsGet, lsSet, lsKey, lsDel, DRY, broadcast, onBroadcast, setSaveStatus, pendingNotes, registerSaver, readOnlyGuest, guestBlocked, signInRequired, data, isPassageTr, LICENSED_IDS, COPYRIGHT } from './store.js';
import { localDay } from './ui.js';
import * as S from './memsched.js';

const safe = (fn, ...a) => { try { return typeof fn === 'function' ? fn(...a) : undefined; } catch (e) { console.error(e); return undefined; } };

export const memory = { loaded: false, scope: null, rev: 0, byId: new Map(), offline: false };

const TRS = ['kjv', 'bsb', 'esv', 'nlt', 'niv', 'nkjv', 'nasb'];
const MEM_KEY = 'bs-memory-v1', DIRTY_KEY = 'bs-memory-dirty-v1';
const ID_RX = /^mv_[0-9a-f]{12}$/;
const REF_RX = /^(\d{1,2})\.(\d{1,3})\.(\d{1,3})(?:-(\d{1,3}))?$/;
const MAX_VERSES = 12, POS_MAX = 1e12;
const MAX_KEYS = 1000, MAX_BODY = 900000, KEEPALIVE_MAX = 32000;
const DRY_MSG = 'Dry run: nothing is saved.';
const PLACE = ['next in line', 'second in line', 'third in line'];

let A = null, inited = false, early = null;
// a toast made before initMemory (a boot flush that meets a conflict) waits for it, so its Keep mine is not lost
const toast = (msg, action) => { if (A && typeof A.toast === 'function') A.toast(msg, action); else early = [msg, action]; };
const dry = msg => (DRY ? `${msg} ${DRY_MSG}` : msg);
const today = () => localDay();

// ------------------------------------------------------------ the practice and the Library (later modules, loaded on use)
let practiceP = null;
/** Open a memory verse's practice (practice.js openPractice), loading it the first time. */
export function practise(id, opts = {}) {
  if (!practiceP) practiceP = import('./practice.js').catch(e => { practiceP = null; console.error('practice.js failed to load', e); return null; });
  return practiceP.then(m => {
    if (m && typeof m.openPractice === 'function') {
      const ok = safe(m.openPractice, id, opts);
      if (ok === false) toast('This verse is no longer one of your memory verses.');   // removed in another window meanwhile
      return ok;
    }
    toast('The practice is unavailable right now. Reload to try again.');
    return undefined;
  });
}
/** Library › Memory: through main.js's openLibrary (it closes what covers the Library), else library.js itself. */
export function showMemory() {
  if (A && typeof A.openLibrary === 'function') { safe(A.openLibrary, { view: 'memory' }); return; }
  import('./library.js').then(m => safe(m && m.openLibrary, { view: 'memory' }), e => console.error('library.js failed to load', e));
}

// ------------------------------------------------------------ refs
/** 'b.c.v' or 'b.c.v-w' -> {b, c, v, w} (w = v for one verse); null unless one chapter of this Bible, at most 12 verses. */
function parseRef(s) {
  const m = REF_RX.exec(String(s || '')); if (!m) return null;
  const b = +m[1], c = +m[2], v = +m[3], w = m[4] ? +m[4] : v;
  const bk = b >= 1 ? bookOf(b) : null;
  if (!bk || !(c >= 1 && c <= bk.chapters.length) || !(v >= 1 && w <= bk.chapters[c - 1])) return null;
  if (m[4] && !(w > v)) return null;
  return w - v + 1 <= MAX_VERSES ? { b, c, v, w } : null;
}
const refOf = (b, c, v, w) => (w > v ? `${b}.${c}.${v}-${w}` : `${b}.${c}.${v}`);
/** 'John 3:16', 'Proverbs 3:5–6' for a memory verse. */
export function memoryLabel(x) {
  const p = parseRef(x && x.ref);
  return p ? refLabel(p.b, p.c, p.v, p.w > p.v ? p.w : 0) : '';
}
/** {b, c, v, w} of a memory verse (w = v for one verse), or null. */
export const memoryRef = x => parseRef(x && x.ref);

// ------------------------------------------------------------ the memory verse (§1)
const num = x => (Number.isFinite(+x) && +x > 0 ? Math.round(+x) : 0);
/** A memory verse as this module keeps it (from the server, the browser mirror or an edit); null when it cannot be one. */
function normVerse(raw) {
  if (!raw || typeof raw !== 'object' || !ID_RX.test(raw.id)) return null;
  const p = parseRef(raw.ref); if (!p) return null;
  const updated = num(raw.updated) || Date.now();
  const heart = S.isDay(raw.heart) ? raw.heart : '';
  const step = Number.isInteger(raw.step) && raw.step >= 0 && raw.step <= S.STEPS ? raw.step : 0;
  const pos = typeof raw.pos === 'number' && Number.isFinite(raw.pos) && Math.abs(raw.pos) <= POS_MAX ? raw.pos : 0;
  return {
    id: raw.id, ref: refOf(p.b, p.c, p.v, p.w), tr: TRS.includes(raw.tr) ? raw.tr : 'kjv', pos,
    step: heart ? S.STEPS : step, due: S.isDay(raw.due) ? raw.due : '', heart, last: num(raw.last),
    created: num(raw.created) || updated, updated,
  };
}
/** The request copy (§1): every field the server keeps. */
const wire = x => ({ id: x.id, ref: x.ref, tr: x.tr, pos: x.pos, step: x.step, due: x.due, heart: x.heart, last: x.last, created: x.created, updated: x.updated });
/** "mv_" + 12 hex from crypto (an offline create can be retried as the same verse). */
function newId() {
  const a = new Uint8Array(6);
  try { crypto.getRandomValues(a); } catch (e) { for (let i = 0; i < 6; i++) a[i] = Math.floor(Math.random() * 256); }
  const id = 'mv_' + [...a].map(x => x.toString(16).padStart(2, '0')).join('');
  return memory.byId.has(id) ? newId() : id;
}

let byStart = new Map(); // 'b.c.v' (the first verse) -> [ids]
function indexAll() {
  const m = new Map();
  for (const x of memory.byId.values()) {
    const p = parseRef(x.ref); if (!p) continue;
    const k = `${p.b}.${p.c}.${p.v}`;
    let ids = m.get(k); if (!ids) m.set(k, ids = []); ids.push(x.id);
  }
  byStart = m;
}

// ------------------------------------------------------------ queries
/** Every memory verse of this profile (the stored objects: read, never change them). */
export const memoryList = () => [...memory.byId.values()];
/** memsched.organize for today: { current, upnext, heart, dueHeart, full }. */
export const organizedMemory = (day = today()) => S.organize(memoryList(), day);
export const getMemory = id => memory.byId.get(id) || null;
export const memoryCount = () => memory.byId.size;
/** The verse with this ref ('43.3.16', '20.3.5-6'), in any translation, or null. */
export function findByRef(ref) {
  for (const x of memory.byId.values()) if (x.ref === ref) return x;
  return null;
}
/** The memory verse whose first verse is b.c.v (the gutter's badge): the one being learned first, else the newest heart. */
export function memoryFor(b, c, v) {
  const ids = byStart.get(`${b}.${c}.${v}`); if (!ids) return null;
  if (ids.length === 1) return memory.byId.get(ids[0]) || null;
  const o = organizedMemory(), order = [o.current, ...o.upnext, ...o.heart].filter(Boolean).map(x => x.id);
  return ids.map(id => memory.byId.get(id)).filter(Boolean).sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id))[0] || null;
}
/** The memory verses that start in a chapter: [{v, entry}] in verse order (for drawing the gutter's badges). */
export function memoryInChapter(b, c) {
  const out = [], pre = `${b}.${c}.`;
  for (const k of byStart.keys()) if (k.startsWith(pre)) { const v = +k.slice(pre.length), x = memoryFor(b, c, v); if (x) out.push({ v, entry: x }); }
  return out.sort((x, y) => x.v - y.v);
}
/** Whether a learning verse waits in line (not the current one): its practice is a free run. */
const isUpnext = (x, o) => !x.heart && !(o.current && o.current.id === x.id);
/**
 * A memory verse's flag and labels with its place in line worked out here: practice.js, home.js and library.js call
 * these (and recordPractice), never memsched's isDue, whenLabel or gotItLabel with a guessed upnext flag.
 */
export const memoryIsUpnext = x => !!x && isUpnext(x, organizedMemory());
export const memoryDue = x => S.isDue(x, today(), memoryIsUpnext(x));
export const memoryWhen = x => S.whenLabel(x, today(), memoryIsUpnext(x));
export const memoryGotIt = x => S.gotItLabel(x, today(), memoryIsUpnext(x));

// ------------------------------------------------------------ text (§3)
/** A translation this browser can read now: bundled, or served by serve.py (a key, or API.Bible's licence). */
function trUsable(tr) {
  const t = (state.translations || []).find(x => x.id === tr);
  return !!t && t.kind !== 'external' && (t.kind !== 'api' || !!(state.apiKeys && state.apiKeys[tr]));
}
async function chapterVerses(tr, b, c) {
  if (isPassageTr(tr)) return data.passage(tr, b, c);
  const bk = await data.bible(tr, b);
  return bk[c] || [];
}
/**
 * The words of a memory verse: { tr, text, verses: [{v, t}], credit: {copyright, fumsToken}, fallback, omitted }. tr is
 * the text's translation; fallback is 'kjv' when the verse's own (entry.tr) can't be had here (not available, offline,
 * or a verse it leaves out) and the KJV is shown instead, else ''; omitted is true when its chapter loaded but has no
 * text for the verse (the BSB's 16 textual variants, ESV/NLT gaps), so the practice doesn't call the translation
 * unavailable. credit is the text's copyright line (an NIV, NKJV or NASB chapter's, or the ESV's or NLT's from store.js
 * COPYRIGHT; '' for the KJV and BSB) and an NIV, NKJV or NASB chapter's FUMS token (practice.js calls reader.js
 * fumsView with it once per practice opened).
 * Null when not even the KJV loads.
 */
export async function memoryText(entry) {
  const p = parseRef(entry && entry.ref); if (!p) return null;
  const pick = vs => { const out = []; for (let v = p.v; v <= p.w; v++) { const t = String((vs && vs[v - 1]) ?? '').trim(); if (t) out.push({ v, t }); } return out; };
  const want = TRS.includes(entry.tr) ? entry.tr : 'kjv';
  let tr = want, verses = [], omitted = false;
  if (trUsable(want) || want === 'kjv') {
    try { const vs = await chapterVerses(want, p.b, p.c); verses = pick(vs); omitted = !verses.length && Array.isArray(vs) && vs.length > 0; } catch (e) { verses = []; }
  }
  if (!verses.length && want !== 'kjv') {
    tr = 'kjv';
    try { verses = pick(await chapterVerses('kjv', p.b, p.c)); } catch (e) { verses = []; }
  }
  if (!verses.length) return null;
  const cr = LICENSED_IDS.includes(tr) ? data.passageCredit(tr, p.b, p.c) : null;
  return { tr, text: verses.map(x => x.t).join(' '), verses, credit: { copyright: (cr && cr.copyright) || COPYRIGHT[tr] || '', fumsToken: (cr && cr.fumsToken) || '' }, fallback: tr !== want ? 'kjv' : '', omitted: tr !== want && omitted };
}
/** A KJV or BSB memory verse's text for a list (Home, the Library); '' for the others (no API calls for a list). */
export async function memoryPreview(entry) {
  const p = parseRef(entry && entry.ref);
  if (!p || (entry.tr !== 'kjv' && entry.tr !== 'bsb')) return '';
  try { const vs = await chapterVerses(entry.tr, p.b, p.c); return vs.slice(p.v - 1, p.w).map(t => String(t || '').trim()).filter(Boolean).join(' '); } catch (e) { return ''; }
}

// ------------------------------------------------------------ persistence: per-verse changes (as marks.js)
let dirty = new Map();    // id -> { op: 'set' | 'del', ts, seq, b? }  b = the server version this edit started from (absent: unknown)
let seq = 0;
let base = new Map();     // id -> the verse's `updated` as last received from the server (null = the server had none)
let memScope = 'guest';   // whose verses byId, dirty and base hold
let baseKnown = false;    // a GET /api/memory succeeded for memScope: an id missing from base means "the server has none"
let noServer = '';        // '' | '404' (a serve.py from before Memorize) | 'offline': the verses of this browser only
let flushP = null, followP = null, saveTimer = 0, retryTimer = 0, retryDelay = 0, stale = false, loadSeq = 0;

const readJSON = (key, fb) => { try { const v = lsGet(key); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };
// Several tabs of one scope share the stored queue: each entry records its tab, and a tab replaces only its own entries
const TAB = Math.random().toString(36).slice(2, 12);
const adopted = new Set();
const entrySig = (k, e) => `${k}|${e && e.ts}|${(e && e.tab) || ''}`;
function mirror() {
  if (DRY) return;
  if (state.auth.hosted && memScope === 'guest') { lsDel(lsKey(MEM_KEY, 'guest')); return; } // never kept for a hosted guest
  const key = lsKey(MEM_KEY, memScope), out = Object.fromEntries(memory.byId);
  const stored = readJSON(key, null), dk = readJSON(lsKey(DIRTY_KEY, memScope), null);
  if (stored && stored.memory && typeof stored.memory === 'object' && dk && dk.d && typeof dk.d === 'object') {
    for (const [id, e] of Object.entries(dk.d)) {
      const theirs = stored.memory[id], mine = out[id];
      if (e && e.tab && e.tab !== TAB && e.op === 'set' && theirs && !(mine && mine.updated >= (+theirs.updated || 0))) out[id] = theirs;
    }
  }
  lsSet(key, JSON.stringify({ v: 1, memory: out }));
}
function persistDirty(scope = memScope, map = dirty) {
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
  if (!Object.keys(d).length) { lsDel(key); return; }
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
/** bs:memory-changed {reason, ids}: reasons load, refresh, add, edit, delete, conflict, restore. */
function emit(reason, ids = []) {
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('bs:memory-changed', { detail: { reason, ids } }));
}
/** The sheet's save status, shared with the notes: a memory verse never hides a note that is still saving or failed. */
function status(kind) {
  if (kind !== 'failed' && kind !== 'signedout' && pendingNotes()) return;
  setSaveStatus(kind);
}

/** Switch the in-memory verses to a scope: its browser mirror and its unsent changes; nothing known from the server yet. */
function switchScope(scope) {
  clearTimeout(saveTimer); saveTimer = 0; clearTimeout(retryTimer); retryTimer = 0; retryDelay = 0;
  memScope = memory.scope = scope;
  baseKnown = false; base = new Map(); memory.rev = 0;
  dirty = readDirty(scope);
  const m = readJSON(lsKey(MEM_KEY, scope), null), by = new Map();
  if (m && m.memory && typeof m.memory === 'object') for (const [id, raw] of Object.entries(m.memory)) { const x = normVerse(raw); if (x && x.id === id) by.set(id, x); }
  for (const [id, e] of dirty) { if (e.b !== undefined) base.set(id, e.b); if (e.op === 'del') by.delete(id); }
  memory.byId = by;
  indexAll();
}

/**
 * Load the current scope's memory verses: GET /api/memory, with this browser's unsent changes on top (then sent).
 * Without a server, or with one from before Memorize (404), the browser's copy is used and kept: nothing is lost.
 */
export async function loadMemory() {
  const my = ++loadSeq, scope = state.auth.scope;
  // the same scope again (a reload of what is shown) keeps memory: in a dry run it is the only copy
  if (scope !== memScope || !memory.loaded) switchScope(scope);
  if (readOnlyGuest() && dirty.size) { dirty.clear(); persistDirty(); } // nothing a hosted guest made is ever sent
  const r = await api('GET', '/api/memory', null, { scoped: false });
  if (my !== loadSeq || scope !== state.auth.scope || scope !== memScope) return;
  memory.loaded = true;
  const ok = r.ok && r.data && r.data.memory && typeof r.data.memory === 'object' && !Array.isArray(r.data.memory);
  if (!ok || (r.data.scope && r.data.scope !== scope)) {
    // no server verses (or an answer for another profile: account.js switches): keep what this browser has
    if (!ok) { noServer = r.status === 404 ? '404' : 'offline'; memory.offline = true; }
    indexAll(); emit('load');
    return;
  }
  noServer = ''; memory.offline = false;
  const srv = new Map(), nb = new Map();
  for (const [id, raw] of Object.entries(r.data.memory)) { const x = normVerse(raw); if (x && x.id === id) srv.set(id, x); }
  for (const [id, e] of dirty) if (e.b !== undefined) nb.set(id, e.b);
  for (const [id, x] of srv) if (!dirty.has(id)) nb.set(id, x.updated);
  for (const [id, e] of dirty) {
    const mine = memory.byId.get(id);
    if (e.op === 'set' && mine) srv.set(id, mine); else if (e.op === 'del') srv.delete(id);
  }
  memory.byId = srv; base = nb; baseKnown = true;
  memory.rev = Number.isFinite(+r.data.rev) ? +r.data.rev : 0;
  indexAll(); mirror(); emit('load');
  if (dirty.size && !DRY && !state.auth.lost) flushMemory();
}

/** Take the server's version of every verse without unsent local changes (another tab saved). */
export async function refreshMemory() {
  const scope = memScope;
  if (scope !== state.auth.scope || noServer) return false;
  const r = await api('GET', '/api/memory', null, { scoped: false });
  if (scope !== memScope || scope !== state.auth.scope) return false;
  if (!(r.ok && r.data && r.data.memory && typeof r.data.memory === 'object')) return false;
  if (r.data.scope && r.data.scope !== scope) return false;
  if (Number.isFinite(+r.data.rev) && +r.data.rev < memory.rev) return false; // older than this tab's own last save
  const changed = [], seen = new Set();
  for (const [id, raw] of Object.entries(r.data.memory)) {
    const x = normVerse(raw); if (!x || x.id !== id) continue;
    seen.add(id);
    if (dirty.has(id)) continue;
    const cur = memory.byId.get(id);
    if (!cur || JSON.stringify(cur) !== JSON.stringify(x)) { memory.byId.set(id, x); changed.push(id); }
    base.set(id, x.updated);
  }
  for (const id of [...memory.byId.keys()]) {
    if (seen.has(id) || dirty.has(id)) continue;
    memory.byId.delete(id); base.set(id, null); changed.push(id);
  }
  if (Number.isFinite(+r.data.rev)) memory.rev = +r.data.rev;
  baseKnown = true;
  mirror();
  if (changed.length) { indexAll(); emit('refresh', changed); }
  return true;
}

/**
 * Send every unsent change: POST /api/memory/changes with compare-and-set bases. Resolves { pending } (0 = all on
 * the server). A call while one is in flight runs once more afterwards.
 */
export function flushMemory(opts = {}) {
  if (!flushP) { flushP = doFlush(opts).catch(e => { console.error(e); return { pending: dirty.size }; }).finally(() => { flushP = null; }); return flushP; }
  if (!followP) followP = flushP.then(() => { followP = null; return dirty.size ? flushMemory(opts) : { pending: 0 }; });
  return followP;
}
async function doFlush({ keepalive = false } = {}) {
  clearTimeout(saveTimer); saveTimer = 0; clearTimeout(retryTimer); retryTimer = 0;
  const scope = memScope;
  if (DRY || scope !== state.auth.scope || !dirty.size || noServer || state.auth.legacy) return { pending: dirty.size };
  if (state.auth.lost) { status('signedout'); return { pending: dirty.size }; } // paused until the profile signs in again
  // a 'set' whose verse is gone from memory is never sent as a delete
  for (const [id, e] of [...dirty]) if (e.op === 'set' && !memory.byId.has(id)) dirty.delete(id);
  const snap = new Map([...dirty].map(([k, e]) => [k, { ...e }]));
  const keys = [...snap.keys()], lost = [], mine = {};
  let changed = false, wasStale = false;
  for (let i = 0; i < keys.length;) {
    // chunk by key count and body size (the route takes 1 MiB)
    const set = {}, del = {}, cas = {};
    let size = 120, n = 0;
    for (; i < keys.length && n < MAX_KEYS; i++, n++) {
      const id = keys[i], e = snap.get(id), x = memory.byId.get(id);
      let part;
      if (e.op === 'set' && x) { set[id] = wire(x); part = JSON.stringify(set[id]).length; } else { del[id] = e.ts; part = 24; }
      if (e.b !== undefined) cas[id] = e.b;
      size += part + 60;
      if (size > MAX_BODY && n > 0) { delete set[id]; delete del[id]; delete cas[id]; break; }
    }
    const body = { baseRev: memory.rev, set, del, base: cas, day: today() };
    const ka = !!keepalive && JSON.stringify(body).length <= KEEPALIVE_MAX;
    const r = await api('POST', '/api/memory/changes', body, { keepalive: ka });
    if (scope !== memScope) { if (r.ok) settleOtherScope(scope, snap, r.data); return { pending: 0 }; }
    if (!r.ok) {
      persistDirty(); mirror(); // earlier chunks may have landed
      if (r.dry) return { pending: dirty.size };
      const err = r.data && r.data.error;
      if (r.status === 404) { noServer = '404'; memory.offline = true; status('local'); return { pending: dirty.size }; }
      if (r.status === 400 && err === 'invalid_memory_verse' && r.data.field && dirty.has(r.data.field)) {
        // one verse the server refuses must not block every other save: it stays in this browser only
        console.error('serve.py refused the memory verse', r.data.field, r.data.message || '');
        dirty.delete(r.data.field); persistDirty();
        toast(r.data.message ? `${r.data.message} That memory verse is kept in this browser only.` : 'One memory verse couldn’t be saved. It’s kept in this browser only.');
        return doFlush({ keepalive });
      }
      if (r.status === 409 && err === 'memory_verse_limit') {
        toast('You’ve reached the limit of 1,000 memory verses. Remove some to save new ones.');
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
    if (Number.isFinite(+d.rev)) memory.rev = +d.rev;
    changed = changed || !!d.changed;
    wasStale = wasStale || !!d.stale;
    for (const [id, v] of Object.entries(d.versions || {})) {
      const ver = v === null ? null : num(v);
      const cur = dirty.get(id), s = snap.get(id);
      base.set(id, ver);
      if (cur && s && cur.seq === s.seq) {
        dirty.delete(id);
        const x = memory.byId.get(id); if (x && ver) x.updated = ver; // the server may move `updated` on (stored + 1)
      } else if (cur) cur.b = ver;
    }
    for (const [id, c] of Object.entries(d.conflicts || {})) {
      const theirs = c && typeof c === 'object' ? normVerse(c) : null;
      const ver = theirs ? theirs.updated : null;
      base.set(id, ver);
      const cur = dirty.get(id), s = snap.get(id);
      if (cur && s && cur.seq === s.seq) {
        dirty.delete(id);
        const own = memory.byId.get(id);
        mine[id] = own ? { ...own } : null;
        if (theirs) memory.byId.set(id, theirs); else memory.byId.delete(id);
        lost.push(id);
      } else if (cur) cur.b = ver; // edited again meanwhile: the newest local edit goes over the newer version
    }
  }
  retryDelay = 0;
  persistDirty(); mirror();
  if (lost.length) { indexAll(); emit('conflict', lost); conflictToast(lost, mine, scope); }
  if (changed) broadcast({ t: 'memory', scope, rev: memory.rev });
  if (wasStale && baseKnown) refreshMemory();
  const unanswered = [...dirty].some(([k, e]) => snap.get(k)?.seq === e.seq);
  if (unanswered) scheduleRetry();
  status(dirty.size ? (unanswered ? 'failed' : 'saving') : 'saved');
  if (dirty.size && !unanswered && !saveTimer && !followP) saveTimer = setTimeout(() => { saveTimer = 0; flushMemory(); }, 700);
  return { pending: dirty.size };
}
/** A flush that finished after this tab switched profiles: clear the sent ids from that profile's stored queue. */
function settleOtherScope(scope, snap, d) {
  const m = readDirty(scope);
  const done = new Set([...Object.keys((d && d.versions) || {}), ...Object.keys((d && d.conflicts) || {})]);
  for (const k of done) if (m.get(k)?.seq === snap.get(k)?.seq) m.delete(k);
  persistDirty(scope, m);
}
/** A hosted guest's verses (only if one got past guestBlocked): the prompt, the queue dropped, the server's shown again. */
function dropGuestEdits() {
  state.auth.hosted = true; guestBlocked();
  dirty.clear(); persistDirty(); mirror();
  status('');
  loadMemory();
}
function scheduleRetry() {
  clearTimeout(retryTimer);
  retryDelay = Math.min(300000, retryDelay ? retryDelay * 2 : 30000);
  retryTimer = setTimeout(() => { retryTimer = 0; if (dirty.size) flushMemory(); }, retryDelay);
}
/** Mirror now; send 700 ms after the last change. */
function scheduleSave() {
  persistDirty(); mirror();
  clearTimeout(saveTimer); saveTimer = 0;
  if (DRY) { status('dry'); return; }
  if (noServer || state.auth.legacy) {
    status('local');
    // serve.py was unreachable at load: look again later, and send what waits once it answers
    if (noServer === 'offline' && !retryTimer) retryTimer = setTimeout(() => { retryTimer = 0; if (noServer === 'offline') loadMemory(); }, 30000);
    return;
  }
  status('saving');
  saveTimer = setTimeout(() => { saveTimer = 0; flushMemory(); }, 700);
}
/** Unsent memory changes for the current scope (0 = all saved). */
export const pendingMemory = () => dirty.size;

function conflictToast(ids, mine, scope) {
  const one = ids.length === 1 ? (memory.byId.get(ids[0]) || mine[ids[0]]) : null;
  const offer = ids.some(id => mine[id] !== undefined);
  const action = offer ? { label: 'Keep mine', run: () => { if (!restoreMemory(mine, scope)) toast('Your version couldn’t be put back.'); } } : undefined;
  toast(one ? `Your memory verse ${memoryLabel(one)} changed in another window. Showing the newer version.` : `${ids.length} of your memory verses changed in another window. Showing the newer versions.`, action);
}
/** "Keep mine" after a conflict: this window's versions go back as fresh edits over the newer ones. Returns how many. */
export function restoreMemory(mine, scope = memScope) {
  if (!mine || typeof mine !== 'object' || scope !== memScope || scope !== state.auth.scope || guestBlocked()) return 0;
  const ids = [], now = Date.now();
  for (const [id, m] of Object.entries(mine)) {
    if (!ID_RX.test(id)) continue;
    const x = m ? normVerse({ ...m, updated: Math.max(now, (memory.byId.get(id)?.updated || 0) + 1) }) : null;
    if (x) { memory.byId.set(id, x); markDirty(id, 'set', x.updated); } else if (memory.byId.has(id)) { memory.byId.delete(id); markDirty(id, 'del', now); } else continue;
    ids.push(id);
  }
  if (!ids.length) return 0;
  indexAll(); scheduleSave(); emit('restore', ids);
  return ids.length;
}

// ------------------------------------------------------------ actions (each refuses a hosted guest with the sign-in prompt)
/** Store a verse (shown at once, sent 700 ms later) and say so. */
function put(x, reason) {
  memory.byId.set(x.id, x);
  markDirty(x.id, 'set', x.updated);
  indexAll(); scheduleSave(); emit(reason, [x.id]);
  return x;
}
/** Change some fields of a stored verse (its id and `created` kept, `updated` moved on). Returns it, or null. */
function change(id, fields, reason = 'edit') {
  const prev = memory.byId.get(id); if (!prev) return null;
  const x = normVerse({ ...prev, ...fields, id, created: prev.created, updated: Math.max(Date.now(), prev.updated + 1) });
  return x ? put(x, reason) : null;
}

/**
 * Memorize a verse or a short passage {b, c, v, ve?, tr} (one chapter, at most 12 verses) in the translation it was
 * chosen in. Says what happened in a toast: already there (Practise), the line full (Open Memory), the memory verse
 * now (Practise now) or next in line (Show). Resolves the new verse, or null when nothing was added.
 */
export function memorize({ b, c, v, ve = 0, tr = 'kjv' } = {}) {
  if (guestBlocked()) return null;
  b = +b; c = +c; v = +v;
  const w = +ve > v ? +ve : v;
  if (w - v + 1 > MAX_VERSES) { toast(`A memory verse can be up to ${MAX_VERSES} verses long. Select fewer verses.`); return null; }
  const p = parseRef(refOf(b, c, v, w)); if (!p) return null;
  const ref = refOf(p.b, p.c, p.v, p.w), label = refLabel(p.b, p.c, p.v, p.w > p.v ? p.w : 0);
  const have = findByRef(ref);
  if (have) { toast(`${label} is already one of your memory verses.`, { label: 'Practise', run: () => { practise(have.id); } }); return null; }
  const list = memoryList(), day = today();
  if (S.organize(list, day).full) { toast(`Three verses are already teed up. Remove one to add ${label}.`, { label: 'Open Memory', run: showMemory }); return null; }
  const now = Date.now();
  const x = normVerse({ id: newId(), ref, tr: TRS.includes(tr) ? tr : 'kjv', pos: S.addPos(list), step: 0, due: '', heart: '', last: 0, created: now, updated: now });
  if (!x) return null;
  put(x, 'add');
  const o = S.organize(memoryList(), day);
  if (o.current && o.current.id === x.id) toast(dry(`${label} is your memory verse now.`), { label: 'Practise now', run: () => { practise(x.id); } });
  else toast(dry(`Added ${label} to your memory verses, ${PLACE[o.upnext.findIndex(e => e.id === x.id)] || 'next in line'}.`), { label: 'Show', run: showMemory });
  return x;
}
/** Make a teed-up verse the current one; the verse it displaces keeps its progress and is first in line. */
export function makeCurrent(id) {
  if (guestBlocked()) return false;
  const x = memory.byId.get(id); if (!x || x.heart) return false;
  const list = memoryList(), o = S.organize(list, today());
  if (!(o.current && o.current.id === id)) change(id, { pos: S.frontPos(list.filter(e => e.id !== id)) });
  toast(dry(`${memoryLabel(x)} is your memory verse now.`));
  return true;
}
/** Remove a memory verse (an Undo toast puts it back with the same id and fields). */
export function removeVerse(id, { undo = true } = {}) {
  if (guestBlocked()) return false;
  const x = memory.byId.get(id); if (!x) return false;
  const was = { ...x };
  memory.byId.delete(id);
  markDirty(id, 'del', Date.now());
  indexAll(); scheduleSave(); emit('delete', [id]);
  if (undo) toast(dry(`Removed ${memoryLabel(was)} from your memory verses.`), { label: 'Undo', run: () => { restoreVerse(was); } });
  return true;
}
function restoreVerse(was) {
  if (guestBlocked()) return null;
  const cur = memory.byId.get(was.id);
  const x = normVerse({ ...was, updated: Math.max(Date.now(), (cur ? cur.updated : was.updated) + 1) });
  return x ? put(x, 'add') : null;
}
/** Home's Not today: a due verse waits until tomorrow ('Moved to tomorrow.' with Undo unless {toast: false}).
 *  Returns { oldDue } for undoNotToday, or null when nothing was due. */
export function notToday(id, { toast: say = true } = {}) {
  if (guestBlocked()) return null;
  const x = memory.byId.get(id); if (!x) return null;
  const day = today();
  if (!S.isDue(x, day, isUpnext(x, S.organize(memoryList(), day)))) return null;
  const oldDue = x.due;
  if (!change(id, { due: S.addDays(day, 1) })) return null;
  if (say) toast(dry('Moved to tomorrow.'), { label: 'Undo', run: () => { undoNotToday(id, oldDue); } });
  return { oldDue };
}
/** Undo Not today: the verse's due day as it was ('' = not started). */
export function undoNotToday(id, oldDue) {
  if (guestBlocked()) return false;
  if (!memory.byId.has(id) || !(oldDue === '' || S.isDay(oldDue))) return false;
  return !!change(id, { due: oldDue });
}
/**
 * A practice judged: result 'got' (Got it) or 'not' (Not yet), through memsched.judge. Resolves { free, before, entry,
 * heart, next }: free = a practice run that changed nothing (teed up, or not due); heart = written on the heart just
 * now; next = the verse that is current after it (when heart). Null when there is no such verse.
 */
export function recordPractice(id, result) {
  if (guestBlocked()) return null;
  const x = memory.byId.get(id); if (!x) return null;
  const day = today(), before = { ...x };
  const ch = S.judge(x, result, day, Date.now(), isUpnext(x, S.organize(memoryList(), day)));
  if (!ch) return { free: true, before, entry: x, heart: false, next: null };
  const after = change(id, ch); if (!after) return null;
  const heart = !before.heart && !!after.heart;
  return { free: false, before, entry: after, heart, next: heart ? S.organize(memoryList(), day).current : null };
}

// ------------------------------------------------------------ init
/** Cross-tab sync, page lifecycle and the saver registry; `actions` is main.js's A (its toast and openLibrary). Idempotent. */
export function initMemory(actions) {
  A = actions || A;
  if (early && A && typeof A.toast === 'function') { const [m, a] = early; early = null; A.toast(m, a); }
  if (inited || typeof document === 'undefined') return;
  inited = true;
  registerSaver('memory', { flush: () => flushMemory(), pending: pendingMemory }); // store.exportObsidian, account.js flushAll
  // lifecycle: send on hide or close; pick up another tab's save when shown
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (dirty.size && !DRY) flushMemory({ keepalive: true }); }
    else if (stale) { stale = false; refreshMemory(); }
  });
  window.addEventListener('pagehide', () => { if (dirty.size && !DRY) flushMemory({ keepalive: true }); });
  window.addEventListener('online', () => {
    if (DRY) return;
    if (noServer === 'offline') loadMemory(); else if (dirty.size) flushMemory();
  });
  onBroadcast(m => {
    if (m.t !== 'memory' || m.scope !== state.auth.scope || m.scope !== memScope) return;
    if (Number.isFinite(m.rev) && m.rev <= memory.rev) return;
    if (document.visibilityState === 'visible') refreshMemory(); else stale = true;
  });
}
