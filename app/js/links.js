// My links (links-spec §3): the reader's own verse-to-verse connections. The data layer follows the notes one in
// store.js (a dirty map per scope, a debounced and keepalive flush with compare-and-set bases, conflicts, cross-tab
// sync); pick mode (§3.4), the composer (§3.5) and the Mine tab body (§3.3) live here as well.
import { state, data, bookOf, refLabel, parseReference, esc, api, lsGet, lsSet, lsKey, DRY, broadcast, onBroadcast, previewText, previewTr, clip, cut, wellFormed, layoutMode, scrollBehavior, setSaveStatus, pendingNotes, registerSaver, readOnlyGuest, guestBlocked, signInRequired, lsDel } from './store.js';
import { icon } from './icons.js';
import * as ui from './ui.js';
import { renderMd } from './drawer.js';

// library.js is optional (main.js loads it guarded): the optimistic activity entry and a refresh after new links
let library = null;
import('./library.js').then(m => { library = m; }, e => { console.error('library.js failed to load', e); });
const libFn = name => (library && typeof library[name] === 'function' ? library[name] : null);
const safe = (fn, ...a) => { try { return typeof fn === 'function' ? fn(...a) : undefined; } catch (e) { console.error(e); return undefined; } };

export const links = { loaded: false, scope: null, rev: 0, byId: new Map(), byVerse: new Map(), offline: false };

/** Link types (§1.2): the phrase on the `from` side (fwd), the `to` side (rev), both sides of a two-way link (sym). */
export const TYPES = [
  { id: 'related', label: 'Related', fwd: 'is linked to', rev: 'is linked to', sym: 'is linked to', dirDefault: 'both' },
  { id: 'fulfils', label: 'Fulfils', fwd: 'fulfils', rev: 'is fulfilled in', sym: 'fulfils / is fulfilled in', dirDefault: 'to' },
  { id: 'echoes', label: 'Echoes', fwd: 'echoes', rev: 'is echoed in', sym: 'echoes', dirDefault: 'to' },
  { id: 'parallels', label: 'Parallels', fwd: 'parallels', rev: 'parallels', sym: 'parallels', dirDefault: 'both' },
  { id: 'contrasts', label: 'Contrasts', fwd: 'contrasts with', rev: 'contrasts with', sym: 'contrasts with', dirDefault: 'both' },
  { id: 'explains', label: 'Explains', fwd: 'explains', rev: 'is explained by', sym: 'explains', dirDefault: 'to' },
  { id: 'quotes', label: 'Quotes', fwd: 'quotes', rev: 'is quoted in', sym: 'quotes', dirDefault: 'to' },
  { id: 'same-word', label: 'Same word', fwd: 'shares a word with', rev: 'shares a word with', sym: 'shares a word with', dirDefault: 'both' },
  { id: 'theme', label: 'Theme', fwd: 'shares a theme with', rev: 'shares a theme with', sym: 'shares a theme with', dirDefault: 'both' },
  { id: 'custom', label: 'Custom…', fwd: '', rev: '', sym: '', dirDefault: 'to' },
];
const TYPE = new Map(TYPES.map(t => [t.id, t]));
export const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
const typeName = id => (id === 'custom' ? 'Custom' : (TYPE.get(id) || TYPE.get('related')).label);

const LINKS_KEY = 'bs-links-v1', DIRTY_KEY = 'bs-links-dirty-v1';
const ID_RX = /^ln_[0-9a-f]{12}$/;
const REF_RX = /^(\d{1,2})\.(\d{1,3})\.(\d{1,3})(?:-(\d{1,3}))?$/;
const TAG_RX = /^[\p{L}\p{M}\p{Nd} _-]+$/u;
const MAX_KEYS = 1000, MAX_BODY = 900000, KEEPALIVE_MAX = 32000;
const DRY_MSG = 'Dry run: nothing is saved.';

let A = null, inited = false, early = null;
// a toast made before initLinks (a boot flush that meets a conflict) waits for it, so its Keep mine is not lost
const toast = (msg, action) => { if (A && typeof A.toast === 'function') A.toast(msg, action); else early = [msg, action]; };
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const cap = s => s[0].toUpperCase() + s.slice(1);

// ------------------------------------------------------------ refs
/** 'b.c.v' or a same-chapter range 'b.c.v-ve' -> {b, c, v, ve} (ve = v for one verse); null when not a verse here. */
export function parseLinkRef(s) {
  const m = REF_RX.exec(String(s || '')); if (!m) return null;
  const b = +m[1], c = +m[2], v = +m[3], ve = m[4] ? +m[4] : v;
  const bk = b >= 1 ? bookOf(b) : null;
  if (!bk || !(c >= 1 && c <= bk.chapters.length)) return null;
  const n = bk.chapters[c - 1];
  return v >= 1 && v <= n && ve >= v && ve <= n ? { b, c, v, ve } : null;
}
/** Canonical form: no leading zeros, '-ve' only for a real range. */
export const linkRefStr = r => `${r.b}.${r.c}.${r.v}${r.ve > r.v ? '-' + r.ve : ''}`;
/** 'John 1:29', 'Isaiah 53:5–7'. */
export const linkRefLabel = r => refLabel(r.b, r.c, r.v, r.ve > r.v ? r.ve : 0);
const refCmp = (x, y) => x.b - y.b || x.c - y.c || x.v - y.v || x.ve - y.ve;
const covers = (r, b, c, v) => !!r && r.b === b && r.c === c && v >= r.v && v <= r.ve;
const verseKey = (b, c, v) => (v ? `${b}.${c}.${v}` : `${b}.${c}`);

// ------------------------------------------------------------ queries
let byChapter = new Map(); // 'b.c' -> Map<v, Set<id>>
function indexAll() {
  const bv = new Map(), bc = new Map();
  for (const l of links.byId.values()) {
    for (const end of [l.from, l.to]) {
      const r = parseLinkRef(end); if (!r) continue;
      const ck = `${r.b}.${r.c}`;
      let ch = bc.get(ck); if (!ch) bc.set(ck, ch = new Map());
      for (let v = r.v; v <= r.ve; v++) {
        const k = `${ck}.${v}`;
        let s = bv.get(k); if (!s) bv.set(k, s = new Set()); s.add(l.id);
        let t = ch.get(v); if (!t) ch.set(v, t = new Set()); t.add(l.id);
      }
    }
  }
  links.byVerse = bv; byChapter = bc;
}
/** The other end of a link as seen from a verse: { ref, b, c, v, ve, side } (side: the other end's side). */
export function otherEnd(link, b, c, v) {
  const f = parseLinkRef(link.from), t = parseLinkRef(link.to);
  const onFrom = covers(f, +b, +c, +v) || (!covers(t, +b, +c, +v) && !!f && f.b === +b && f.c === +c);
  const o = onFrom ? t : f;
  return o ? { ref: onFrom ? link.to : link.from, b: o.b, c: o.c, v: o.v, ve: o.ve, side: onFrom ? 'to' : 'from' } : null;
}
/** Links touching a verse (either end, any verse of a range), by the other end's canon order. */
export function linksFor(b, c, v) {
  const ids = links.byVerse.get(`${b}.${c}.${v}`); if (!ids) return [];
  const rows = [];
  for (const id of ids) { const l = links.byId.get(id), o = l && otherEnd(l, b, c, v); if (o) rows.push([l, o]); }
  return rows.sort((x, y) => refCmp(x[1], y[1]) || x[0].created - y[0].created).map(x => x[0]);
}
/** Map<v, number of links touching that verse> for one chapter. */
export function linksInChapter(b, c) {
  const ch = byChapter.get(`${b}.${c}`), out = new Map();
  if (ch) for (const [v, s] of ch) out.set(v, s.size);
  return out;
}
export const linkCount = () => links.byId.size;
/** Every tag in use, most used first (composer suggestions; Library filters). */
export function allTags() {
  const n = new Map();
  for (const l of links.byId.values()) for (const t of l.tags) n.set(t, (n.get(t) || 0) + 1);
  return [...n].sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0])).map(x => x[0]);
}
/** Which side of a link a ref is on: 'from' | 'to' ('from'/'to' pass through; a ref string or {b,c,v} is matched). */
function sideOf(link, s) {
  if (s === 'from' || s === 'to') return s;
  if (typeof s === 'string') { if (s === link.to) return 'to'; if (s === link.from) return 'from'; s = parseLinkRef(s); }
  if (s && typeof s === 'object' && !covers(parseLinkRef(link.from), +s.b, +s.c, +s.v) && covers(parseLinkRef(link.to), +s.b, +s.c, +s.v)) return 'to';
  return 'from';
}
/** The direction-aware phrase (§1.2) as read from one side ('from' | 'to', or a ref on that side). */
export function phrase(link, fromSideRef) {
  if (!link) return '';
  const T = TYPE.get(link.type) || TYPE.get('related');
  if (link.type === 'custom') return link.label || TYPE.get('related').fwd;
  if (link.dir === 'both') return T.sym;
  return sideOf(link, fromSideRef) === 'to' ? T.rev : T.fwd;
}

// ------------------------------------------------------------ the link object
const num = x => (Number.isFinite(+x) && +x > 0 ? Math.round(+x) : 0);
/** A clean tag ('' when it cannot be one): trimmed, single spaces, lower case, NFC, at most 40 characters. */
function cleanTag(t) {
  t = String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  try { t = t.normalize('NFC'); } catch (e) { /* old engines */ }
  return t && TAG_RX.test(t) ? cut(t, 40) : '';
}
/** A link as this module keeps it (from the server, the browser mirror or a draft); null when it cannot be one. */
function normLink(raw) {
  if (!raw || typeof raw !== 'object' || !ID_RX.test(raw.id)) return null;
  const f = parseLinkRef(raw.from), t = parseLinkRef(raw.to);
  if (!f || !t) return null;
  const from = linkRefStr(f), to = linkRefStr(t);
  if (from === to) return null;
  const type = TYPE.has(raw.type) ? raw.type : 'related';
  const label = cut(String(raw.label ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim(), 40);
  if (type === 'custom' && !label) return null;
  const tags = [];
  for (const x of Array.isArray(raw.tags) ? raw.tags : []) { const c = cleanTag(x); if (c && !tags.includes(c)) tags.push(c); }
  const updated = num(raw.updated) || Date.now();
  return {
    id: raw.id, from, to, type, label, note: typeof raw.note === 'string' ? raw.note : '',
    color: COLORS.includes(raw.color) ? raw.color : 'blue', tags: tags.slice(0, 20),
    dir: raw.dir === 'to' || raw.dir === 'both' ? raw.dir : TYPE.get(type).dirDefault,
    created: num(raw.created) || updated, updated,
  };
}
/** The request copy (§2): every field, text the server can decode, within its limits. */
function wire(l) {
  return { id: l.id, from: l.from, to: l.to, type: l.type, label: cut(l.label, 40), note: cut(l.note, 20000), color: l.color,
    tags: l.tags.map(t => wellFormed(cut(t, 40))), dir: l.dir, created: l.created, updated: l.updated };
}
const copyLink = l => ({ ...l, tags: [...l.tags] });
const LINK_MAX_BYTES = 32 * 1024; // accounts.LINK_MAX_BYTES: one link as UTF-8 JSON
let enc = null;
const utf8Len = s => (enc || (enc = new TextEncoder())).encode(s).length;
/** The size the server measures: Python's json.dumps adds a space after each ':' and ',' (at most 41 here; 64 to spare). */
const linkBytes = l => utf8Len(JSON.stringify(wire(l))) + 64;
/** "ln_" + 12 hex from crypto (an offline create can be retried as the same link). */
function newId() {
  const a = new Uint8Array(6);
  try { crypto.getRandomValues(a); } catch (e) { for (let i = 0; i < 6; i++) a[i] = Math.floor(Math.random() * 256); }
  const id = 'ln_' + [...a].map(x => x.toString(16).padStart(2, '0')).join('');
  return links.byId.has(id) ? newId() : id;
}

// ------------------------------------------------------------ persistence: per-link changes (profiles-spec §5.2 for notes)
let dirty = new Map();    // id -> { op: 'set' | 'del', ts, seq, b? }  b = the server version this edit started from (absent: unknown)
let seq = 0;
let base = new Map();     // id -> the link's `updated` as last received from the server (null = the server had none)
let linksScope = 'guest'; // whose links byId, dirty and base hold
let baseKnown = false;    // a GET /api/links succeeded for linksScope: an id missing from base means "the server has none"
let noServer = '';        // '' | '404' (a serve.py from before My links) | 'offline': the links of this browser only
let flushP = null, followP = null, saveTimer = 0, retryTimer = 0, retryDelay = 0, stale = false, loadSeq = 0;

const readJSON = (key, fb) => { try { const v = lsGet(key); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };
// Several tabs of one scope share the stored queue: each entry records its tab, and a tab replaces only its own entries
// (the notes rules: another tab's unsent edit, and its copy in the mirror, is never dropped).
const TAB = Math.random().toString(36).slice(2, 12);
const adopted = new Set();
const entrySig = (k, e) => `${k}|${e && e.ts}|${(e && e.tab) || ''}`;
function mirror() {
  if (DRY) return;
  if (state.auth.hosted && linksScope === 'guest') { lsDel(lsKey(LINKS_KEY, 'guest')); return; } // never kept for a hosted guest
  const key = lsKey(LINKS_KEY, linksScope), out = Object.fromEntries(links.byId);
  const stored = readJSON(key, null), dk = readJSON(lsKey(DIRTY_KEY, linksScope), null);
  if (stored && stored.links && typeof stored.links === 'object' && dk && dk.d && typeof dk.d === 'object') {
    for (const [id, e] of Object.entries(dk.d)) {
      const theirs = stored.links[id], mine = out[id];
      if (e && e.tab && e.tab !== TAB && e.op === 'set' && theirs && !(mine && mine.updated >= (+theirs.updated || 0))) out[id] = theirs;
    }
  }
  lsSet(key, JSON.stringify({ v: 1, links: out }));
}
function persistDirty(scope = linksScope, map = dirty) {
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
/** bs:links-changed {reason, ids}: reader, drawer, viz and library listen. */
function emit(reason, ids = []) {
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('bs:links-changed', { detail: { reason, ids } }));
}
/** The sheet's save status, shared with the notes: a link never hides a note that is still saving or failed. */
function status(kind) {
  if (kind !== 'failed' && kind !== 'signedout' && pendingNotes()) return;
  setSaveStatus(kind);
}

/** Switch the in-memory links to a scope: its browser mirror and its unsent changes; nothing known from the server yet. */
function switchScope(scope) {
  clearTimeout(saveTimer); saveTimer = 0; clearTimeout(retryTimer); retryTimer = 0; retryDelay = 0;
  linksScope = links.scope = scope;
  baseKnown = false; base = new Map(); links.rev = 0;
  dirty = readDirty(scope);
  const m = readJSON(lsKey(LINKS_KEY, scope), null), by = new Map();
  if (m && m.links && typeof m.links === 'object') for (const [id, raw] of Object.entries(m.links)) { const l = normLink(raw); if (l && l.id === id) by.set(id, l); }
  for (const [id, e] of dirty) { if (e.b !== undefined) base.set(id, e.b); if (e.op === 'del') by.delete(id); }
  links.byId = by;
  indexAll();
}

/**
 * Load the current scope's links: GET /api/links, with this browser's unsent changes on top (then sent). Without a
 * server, or with one from before My links (404), the browser's copy is used and kept: nothing is lost or reported.
 */
export async function loadLinks() {
  const my = ++loadSeq, scope = state.auth.scope;
  // the same scope again (a reload of what is shown) keeps memory: in a dry run it is the only copy
  if (scope !== linksScope || !links.loaded) switchScope(scope);
  if (readOnlyGuest() && dirty.size) { dirty.clear(); persistDirty(); } // nothing a hosted guest made is ever sent
  const r = await api('GET', '/api/links', null, { scoped: false });
  if (my !== loadSeq || scope !== state.auth.scope || scope !== linksScope) return;
  links.loaded = true;
  const ok = r.ok && r.data && r.data.links && typeof r.data.links === 'object' && !Array.isArray(r.data.links);
  if (!ok || (r.data.scope && r.data.scope !== scope)) {
    // no server links (or an answer for another profile: account.js switches): keep what this browser has
    if (!ok) { noServer = r.status === 404 ? '404' : 'offline'; links.offline = true; }
    indexAll(); emit('load');
    return;
  }
  noServer = ''; links.offline = false;
  const srv = new Map(), nb = new Map();
  for (const [id, raw] of Object.entries(r.data.links)) { const l = normLink(raw); if (l && l.id === id) srv.set(id, l); }
  for (const [id, e] of dirty) if (e.b !== undefined) nb.set(id, e.b);
  for (const [id, l] of srv) if (!dirty.has(id)) nb.set(id, l.updated);
  for (const [id, e] of dirty) {
    const mine = links.byId.get(id);
    if (e.op === 'set' && mine) srv.set(id, mine); else if (e.op === 'del') srv.delete(id);
  }
  links.byId = srv; base = nb; baseKnown = true;
  links.rev = Number.isFinite(+r.data.rev) ? +r.data.rev : 0;
  indexAll(); mirror(); emit('load');
  if (dirty.size && !DRY && !state.auth.lost) flushLinks();
}

/** Take the server's version of every link without unsent local changes (another tab saved). */
export async function refreshLinks() {
  const scope = linksScope;
  if (scope !== state.auth.scope || noServer) return false;
  const r = await api('GET', '/api/links', null, { scoped: false });
  if (scope !== linksScope || scope !== state.auth.scope) return false;
  if (!(r.ok && r.data && r.data.links && typeof r.data.links === 'object')) return false;
  if (r.data.scope && r.data.scope !== scope) return false;
  if (Number.isFinite(+r.data.rev) && +r.data.rev < links.rev) return false; // older than this tab's own last save
  const changed = [], seen = new Set();
  for (const [id, raw] of Object.entries(r.data.links)) {
    const l = normLink(raw); if (!l || l.id !== id) continue;
    seen.add(id);
    if (dirty.has(id)) continue;
    const cur = links.byId.get(id);
    if (!cur || JSON.stringify(cur) !== JSON.stringify(l)) { links.byId.set(id, l); changed.push(id); }
    base.set(id, l.updated);
  }
  for (const id of [...links.byId.keys()]) {
    if (seen.has(id) || dirty.has(id)) continue;
    links.byId.delete(id); base.set(id, null); changed.push(id);
  }
  if (Number.isFinite(+r.data.rev)) links.rev = +r.data.rev;
  baseKnown = true;
  mirror();
  if (changed.length) { indexAll(); emit('refresh', changed); }
  return true;
}

/**
 * Send every unsent change: POST /api/links/changes with compare-and-set bases. Resolves { pending } (0 = all on
 * the server). A call while one is in flight runs once more afterwards.
 */
export function flushLinks(opts = {}) {
  if (!flushP) { flushP = doFlush(opts).catch(e => { console.error(e); return { pending: dirty.size }; }).finally(() => { flushP = null; }); return flushP; }
  if (!followP) followP = flushP.then(() => { followP = null; return dirty.size ? flushLinks(opts) : { pending: 0 }; });
  return followP;
}

async function doFlush({ keepalive = false } = {}) {
  clearTimeout(saveTimer); saveTimer = 0; clearTimeout(retryTimer); retryTimer = 0;
  const scope = linksScope;
  if (DRY || scope !== state.auth.scope || !dirty.size || noServer || state.auth.legacy) return { pending: dirty.size };
  if (state.auth.lost) { status('signedout'); return { pending: dirty.size }; } // paused until the profile signs in again
  // a 'set' whose link is gone from memory is never sent as a delete
  for (const [id, e] of [...dirty]) if (e.op === 'set' && !links.byId.has(id)) dirty.delete(id);
  const snap = new Map([...dirty].map(([k, e]) => [k, { ...e }]));
  const keys = [...snap.keys()], lost = [], mine = {};
  let changed = false, wasStale = false, created = false;
  for (let i = 0; i < keys.length;) {
    // chunk by key count and body size (the route takes 1 MiB)
    const set = {}, del = {}, cas = {};
    let size = 120, n = 0;
    for (; i < keys.length && n < MAX_KEYS; i++, n++) {
      const id = keys[i], e = snap.get(id), l = links.byId.get(id);
      let part;
      if (e.op === 'set' && l) { set[id] = wire(l); part = JSON.stringify(set[id]).length; } else { del[id] = e.ts; part = 24; }
      if (e.b !== undefined) cas[id] = e.b;
      size += part + 60;
      if (size > MAX_BODY && n > 0) { delete set[id]; delete del[id]; delete cas[id]; break; }
    }
    const body = { baseRev: links.rev, set, del, base: cas, day: ui.localDay() };
    const ka = !!keepalive && JSON.stringify(body).length <= KEEPALIVE_MAX;
    const r = await api('POST', '/api/links/changes', body, { keepalive: ka });
    if (scope !== linksScope) { if (r.ok) settleOtherScope(scope, snap, r.data); return { pending: 0 }; }
    if (!r.ok) {
      persistDirty(); mirror(); // earlier chunks may have landed
      if (r.dry) return { pending: dirty.size };
      const err = r.data && r.data.error;
      if (r.status === 404) { noServer = '404'; links.offline = true; status('local'); return { pending: dirty.size }; }
      if (r.status === 400 && err === 'invalid_link' && r.data.field && dirty.has(r.data.field)) {
        // one link the server refuses must not block every other save: it stays in this browser only
        console.error('serve.py refused the link', r.data.field, r.data.message || '');
        dirty.delete(r.data.field); persistDirty();
        toast(r.data.message ? `${r.data.message} That link is kept in this browser only.` : 'One link couldn’t be saved. It’s kept in this browser only.');
        return doFlush({ keepalive });
      }
      if (r.status === 409 && err === 'link_limit') {
        toast('You’ve reached 10,000 links, the most one profile can keep. Delete some to save new ones.');
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
    if (Number.isFinite(+d.rev)) links.rev = +d.rev;
    changed = changed || !!d.changed;
    wasStale = wasStale || !!d.stale;
    for (const [id, v] of Object.entries(d.versions || {})) {
      const ver = v === null ? null : num(v);
      const cur = dirty.get(id), s = snap.get(id);
      if (s && s.op === 'set' && (s.b === null || s.b === undefined) && !base.get(id) && ver) created = true;
      base.set(id, ver);
      if (cur && s && cur.seq === s.seq) {
        dirty.delete(id);
        const l = links.byId.get(id); if (l && ver) l.updated = ver; // the server may move `updated` on (stored + 1)
      } else if (cur) cur.b = ver;
    }
    for (const [id, c] of Object.entries(d.conflicts || {})) {
      const theirs = c && typeof c === 'object' ? normLink(c) : null;
      const ver = theirs ? theirs.updated : null;
      base.set(id, ver);
      const cur = dirty.get(id), s = snap.get(id);
      if (cur && s && cur.seq === s.seq) {
        dirty.delete(id);
        const own = links.byId.get(id);
        mine[id] = own ? copyLink(own) : null;
        if (theirs) links.byId.set(id, theirs); else links.byId.delete(id);
        lost.push(id);
      } else if (cur) cur.b = ver; // edited again meanwhile: the newest local edit goes over the newer version
    }
  }
  retryDelay = 0;
  persistDirty(); mirror();
  if (lost.length) { indexAll(); emit('conflict', lost); conflictToast(lost, mine, scope); }
  if (changed) broadcast({ t: 'links', scope, rev: links.rev });
  if (created) safe(libFn('refreshSoon')); // the server wrote link.add activity
  if (wasStale && baseKnown) refreshLinks();
  const unanswered = [...dirty].some(([k, e]) => snap.get(k)?.seq === e.seq);
  if (unanswered) scheduleRetry();
  status(dirty.size ? (unanswered ? 'failed' : 'saving') : 'saved');
  if (dirty.size && !unanswered && !saveTimer && !followP) saveTimer = setTimeout(() => { saveTimer = 0; flushLinks(); }, 700);
  return { pending: dirty.size };
}
/** A flush that finished after this tab switched profiles: clear the sent ids from that profile's stored queue. */
function settleOtherScope(scope, snap, d) {
  const m = readDirty(scope);
  const done = new Set([...Object.keys((d && d.versions) || {}), ...Object.keys((d && d.conflicts) || {})]);
  for (const k of done) if (m.get(k)?.seq === snap.get(k)?.seq) m.delete(k);
  persistDirty(scope, m);
}
/** A hosted guest's links (only if one got past guestBlocked): the prompt, the queue dropped, the server's shown again. */
function dropGuestEdits() {
  state.auth.hosted = true; guestBlocked();
  dirty.clear(); persistDirty(); mirror();
  status('');
  loadLinks();
}
function scheduleRetry() {
  clearTimeout(retryTimer);
  retryDelay = Math.min(300000, retryDelay ? retryDelay * 2 : 30000);
  retryTimer = setTimeout(() => { retryTimer = 0; if (dirty.size) flushLinks(); }, retryDelay);
}
/** Mirror now; send 700 ms after the last change. */
function scheduleSave() {
  persistDirty(); mirror();
  clearTimeout(saveTimer); saveTimer = 0;
  if (DRY) { status('dry'); return; }
  if (noServer || state.auth.legacy) {
    status('local');
    // serve.py was unreachable at load: look again later, and send what waits once it answers
    if (noServer === 'offline' && !retryTimer) retryTimer = setTimeout(() => { retryTimer = 0; if (noServer === 'offline') loadLinks(); }, 30000);
    return;
  }
  status('saving');
  saveTimer = setTimeout(() => { saveTimer = 0; flushLinks(); }, 700);
}
/** Unsent link changes for the current scope (0 = all saved). account.js's sign-out should wait for flushLinks(). */
export const pendingLinks = () => dirty.size;

function conflictToast(ids, mine, scope) {
  const one = ids.length === 1 ? (links.byId.get(ids[0]) || mine[ids[0]]) : null;
  const f = one && parseLinkRef(one.from);
  const offer = ids.some(id => mine[id] !== undefined);
  const action = offer ? { label: 'Keep mine', run: () => { if (!restoreLinks(mine, scope)) toast('Your version couldn’t be put back.'); } } : undefined;
  toast(f ? `Your link from ${linkRefLabel(f)} changed in another window. Showing the newer version.` : `${ids.length} of your links changed in another window. Showing the newer versions.`, action);
}
/** "Keep mine" after a conflict: this window's versions go back as fresh edits over the newer ones. Returns how many. */
export function restoreLinks(mine, scope = linksScope) {
  if (!mine || typeof mine !== 'object' || scope !== linksScope || scope !== state.auth.scope || guestBlocked()) return 0;
  const ids = [], now = Date.now();
  for (const [id, l] of Object.entries(mine)) {
    if (!ID_RX.test(id)) continue;
    const x = l ? normLink({ ...l, updated: Math.max(now, (links.byId.get(id)?.updated || 0) + 1) }) : null;
    if (x) { links.byId.set(id, x); markDirty(id, 'set', x.updated); } else if (links.byId.has(id)) { links.byId.delete(id); markDirty(id, 'del', now); } else continue;
    ids.push(id);
  }
  if (!ids.length) return 0;
  indexAll(); scheduleSave(); emit('restore', ids);
  return ids.length;
}

// ------------------------------------------------------------ edits
/**
 * Create or update a link from a draft {id?, from, to, type, label, note, color, tags, dir, created?}. Optimistic:
 * shown at once, sent 700 ms later. An edit keeps the id and `created`. Resolves the stored link, or null if invalid.
 */
export async function saveLink(draft) {
  if (!draft || typeof draft !== 'object' || guestBlocked()) return null; // a hosted site's guest saves nothing
  const prev = draft.id ? links.byId.get(draft.id) : null;
  const now = Date.now();
  const updated = Math.max(now, prev ? prev.updated + 1 : 0);
  const created = prev ? prev.created : (num(draft.created) && num(draft.created) <= now ? num(draft.created) : updated);
  const l = normLink({ ...(prev || {}), ...draft, id: draft.id && ID_RX.test(draft.id) ? draft.id : newId(), created, updated });
  if (!l) return null;
  links.byId.set(l.id, l);
  markDirty(l.id, 'set', l.updated);
  indexAll();
  if (!prev && !draft.created) {
    // the server writes link.add (§2); the Library shows it at once
    const f = parseLinkRef(l.from);
    safe(libFn('applyLocal'), { t: now, type: 'link.add', b: f.b, c: f.c, v: f.v, ref: l.from, x: { id: l.id, to: l.to, kind: l.type } });
  }
  scheduleSave();
  emit(prev ? 'edit' : 'add', [l.id]);
  return l;
}
/** Delete a link (an Undo toast puts it back with the same id and `created`). */
export async function deleteLink(id, { undo = true } = {}) {
  const l = links.byId.get(id); if (!l || guestBlocked()) return false;
  const was = copyLink(l), name = otherLabel(l);
  links.byId.delete(id);
  markDirty(id, 'del', Date.now());
  indexAll(); scheduleSave(); emit('delete', [id]);
  if (undo) toast(`Deleted the link to ${name}.${DRY ? ' ' + DRY_MSG : ''}`, { label: 'Undo', run: () => { saveLink(was); } });
  return true;
}
/** The end of a link to name in a message: the one away from the verse the Mine tab shows (else `to`). */
function otherLabel(l) {
  const o = mineView && mineView.v ? otherEnd(l, mineView.b, mineView.c, mineView.v) : null;
  const r = o && (covers(parseLinkRef(l.from), mineView.b, mineView.c, mineView.v) || covers(parseLinkRef(l.to), mineView.b, mineView.c, mineView.v)) ? o : parseLinkRef(l.to);
  return r ? linkRefLabel(r) : 'that verse';
}

// ------------------------------------------------------------ pick mode (§3.4)
let pick = null;          // { from: {b,c,v,ve}, anchor: {b,c,v} | null }
let quietUntil = 0;       // the rest of a double click on the chosen verse must not select it or open its note
export const picking = () => !!pick;
const pillEl = () => document.getElementById('link-pick');
const readerCh = () => { const p = String(document.getElementById('reader')?.dataset.ch || '').split('.').map(Number); return p[0] && p[1] ? { b: p[0], c: p[1] } : { b: state.book, c: state.chapter }; };

function toRef(x) {
  if (!x) return null;
  if (typeof x === 'string') return parseLinkRef(x);
  const b = +x.b, c = +x.c, v = +x.v, ve = +x.ve > v ? +x.ve : v;
  return v ? parseLinkRef(linkRefStr({ b, c, v, ve })) : null;
}
/** Enter pick mode from a verse (default: the selected one). Starting it again cancels. */
export function startPick(fromRef) {
  if (pick) { cancelPick(); return false; }
  if (guestBlocked()) return false; // a hosted site's guest: the sign-in prompt, never a link that can't be kept
  const from = toRef(fromRef || (state.selected ? { b: state.book, c: state.chapter, v: state.selected } : null));
  if (!from) { toast('Select a verse first, then press c.'); return false; }
  const ae = document.activeElement, fromSheet = !!(ae && ae.closest && ae.closest('#drawer'));
  ui.closeMenu(false);
  pick = { from, anchor: null };
  // the phone sheet and the overlay sheet cover the verses: they step aside; beside the reader it stays
  if (state.drawerOpen && layoutMode() !== 'side' && A && typeof A.closeDrawer === 'function') A.closeDrawer();
  document.body.classList.add('link-picking');
  const el = pillEl();
  if (el) { el.hidden = false; el.classList.remove('shake'); }
  sayPick();
  markPick();
  if (fromSheet || !ae || ae === document.body) {
    const { b, c } = readerCh();
    const v = b === from.b && c === from.c ? document.getElementById('v' + from.v) : null;
    (v || $('#reader .verse[tabindex="0"]'))?.focus({ preventScroll: true });
  }
  return true;
}
/** Leave pick mode (Esc, Cancel, or c again). No toast. */
export function cancelPick() {
  if (!pick) return;
  pick = null;
  const el = pillEl();
  if (el) { if (el.contains(document.activeElement)) $('#reader .verse[tabindex="0"]')?.focus({ preventScroll: true }); el.hidden = true; }
  document.body.classList.remove('link-picking');
  markPick();
}
function sayPick() {
  const m = document.getElementById('link-pick-msg'); if (!m || !pick) return;
  const a = pick.anchor;
  m.innerHTML = a
    ? `Linking from <b>${esc(linkRefLabel(pick.from))}</b> to <b>${esc(refLabel(a.b, a.c, a.v))}</b> — choose where the range ends`
    : `Linking from <b>${esc(linkRefLabel(pick.from))}</b> — choose a verse<span class="sr">. Click it, or press Return on it. Shift-click two verses for a range. Escape cancels.</span>`;
  sizePill();
}
/** Toasts sit above the pill, whose height grows when its message wraps (styles.css --lp-h). */
function sizePill() {
  const el = pillEl(); if (el && el.offsetHeight) document.body.style.setProperty('--lp-h', el.offsetHeight + 'px');
}
/** The source (and a range's first verse) marked in the reader while picking. */
function markPick() {
  $$('#reader .verse.link-src, #reader .verse.link-anchor').forEach(e => e.classList.remove('link-src', 'link-anchor'));
  if (!pick) return;
  const { b, c } = readerCh();
  if (pick.from.b === b && pick.from.c === c) for (let v = pick.from.v; v <= pick.from.ve; v++) document.getElementById('v' + v)?.classList.add('link-src');
  const a = pick.anchor;
  if (a && a.b === b && a.c === c) document.getElementById('v' + a.v)?.classList.add('link-anchor');
}
function shakePill() {
  const el = pillEl(); if (!el) return;
  el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
}
/** A verse was clicked (or Return pressed on it) while picking. */
function choose(v, shift) {
  const { b, c } = readerCh(), f = pick.from;
  if (covers(f, b, c, v) && !(pick.anchor && pick.anchor.b === b && pick.anchor.c === c)) { shakePill(); toast('Choose a different verse.'); return; }
  const a = pick.anchor && pick.anchor.b === b && pick.anchor.c === c ? pick.anchor : null;
  if (shift && !a) { pick.anchor = { b, c, v }; markPick(); sayPick(); return; }
  const to = a ? { b, c, v: Math.min(a.v, v), ve: Math.max(a.v, v) } : { b, c, v, ve: v };
  if (linkRefStr(to) === linkRefStr(f)) { shakePill(); toast('Choose a different verse.'); return; }
  finishPick(to);
}
function finishPick(to) {
  const from = pick.from;
  cancelPick();
  quietUntil = performance.now() + 600;
  draft = newDraft({ at: verseKey(from.b, from.c, from.v), fixed: from, other: to, focus: 'type' });
  // the reader stays where it is; the study panel shows the source verse's Mine tab
  // focus: true keeps the phone sheet from moving focus to its title; afterRender puts it on the type chips
  if (from.b === state.book && from.c === state.chapter) { focusRef = null; A?.select?.(from.v, { tab: 'mine', focus: true }); }
  else { focusRef = { b: from.b, c: from.c, v: from.v }; A?.openTab?.('mine', { focus: true }); }
}

// ------------------------------------------------------------ the Mine tab body (§3.3) and the composer (§3.5)
let draft = null;      // the open composer, for the verse whose Mine body shows it (draft.at)
let mineHost = null, mineView = null;
let focusRef = null;   // a source verse outside the reader's chapter: the Mine tab shows it while its composer is open
let afterFocus = null; // a selector (or a list, first found wins) to focus after the next render of the host
/** The verse the Mine tab should show instead of the selection (a link picked from another chapter), or null. */
export const mineFocus = () => (focusRef && draft && draft.at === verseKey(focusRef.b, focusRef.c, focusRef.v) ? focusRef : null);
/** Navigation and a new selection end it (main.js); the composer's Cancel and Save end it here (leaveFocus). */
export function clearMineFocus() { focusRef = null; }
/** The first control `afterFocus` names in `root`; it is used up either way. */
function takeAfter(root) {
  const sels = [].concat(afterFocus || []); afterFocus = null;
  for (const s of sels) { const t = $(s, root); if (t) return t; }
  return null;
}
/**
 * The composer a cross-chapter pick opened has closed: the Mine tab goes back to the verse (or chapter) the reader and
 * the panel's title show, with focus on the first of `sels` found there. False when there was no such composer.
 */
function leaveFocus(sels) {
  if (!focusRef) return false;
  focusRef = null;
  if (!A || typeof A.openTab !== 'function') return false;
  afterFocus = sels; A.openTab('mine'); afterFocus = null;
  return true;
}

function newDraft({ at, fixed, other = null, link = null, focus = 'to' }) {
  const t = link ? link.type : 'related';
  return {
    at, id: link ? link.id : null, fixed, toText: other ? linkRefLabel(other) : '', swapped: !!link && linkRefStr(fixed) === link.to && link.to !== link.from,
    // a custom link's label is its phrase (edited here); another type's optional caption is kept as it was
    type: t, label: link && t === 'custom' ? link.label : '', caption: link && t !== 'custom' ? link.label : '',
    dir: link ? link.dir : TYPE.get(t).dirDefault, dirTouched: !!link,
    color: link ? link.color : 'blue', tags: link ? [...link.tags] : [], tagText: '', note: link ? link.note : '',
    focus, tried: false, tagErr: '',
  };
}
/** What the draft says now: the other end, the message under it, the first error and a duplicate link. */
function evalDraft(d) {
  const out = { other: null, from: null, to: null, msg: '', bad: false, err: '', field: '', dup: null };
  const t = d.toText.trim();
  if (!t) { out.err = `Choose a verse to link ${d.swapped ? 'from' : 'to'}.`; out.field = 'to'; }
  else {
    const p = parseReference(t);
    if (!p || !p.v) { out.msg = 'Not a verse'; out.bad = true; out.err = p ? 'Choose a verse, not a whole chapter.' : 'Not a verse. Try a reference like isa 53:7.'; out.field = 'to'; }
    else if (p.vend >= 1000) { out.msg = out.err = 'A range must stay in one chapter.'; out.bad = true; out.field = 'to'; }
    else out.other = { b: p.b, c: p.c, v: p.v, ve: p.vend > p.v ? p.vend : p.v };
  }
  if (out.other) {
    out.from = d.swapped ? out.other : d.fixed; out.to = d.swapped ? d.fixed : out.other;
    const fs = linkRefStr(out.from), ts = linkRefStr(out.to);
    if (fs === ts) { out.msg = out.err = 'A verse can’t link to itself.'; out.bad = true; out.field = 'to'; }
    else {
      out.msg = linkRefLabel(out.other);
      for (const l of links.byId.values()) if (l.id !== d.id && l.from === fs && l.to === ts && l.type === d.type) { out.dup = l; break; }
    }
  }
  if (!out.err && d.type === 'custom' && !d.label.trim()) { out.err = 'A custom link needs a label.'; out.field = 'label'; }
  if (!out.err && d.tagErr) { out.err = d.tagErr; out.field = 'tags'; }
  if (!out.err && d.note.length > 4000) {
    // the server refuses a link over 32 KiB (§1.2): a long note in Korean or Greek reaches it before 20,000 characters
    const over = linkBytes({ id: d.id || 'ln_000000000000', from: linkRefStr(out.from), to: linkRefStr(out.to), type: d.type, label: d.type === 'custom' ? d.label.trim() : d.caption,
      note: d.note, color: d.color, tags: d.tags, dir: d.dir, created: Date.now(), updated: Date.now() }) - LINK_MAX_BYTES;
    if (over > 0) {
      const n = Math.max(1, Math.ceil(over / (utf8Len(d.note) / d.note.length)));
      out.err = `That note is too long to save. Shorten it by about ${n.toLocaleString()} character${n === 1 ? '' : 's'}.`; out.field = 'note';
    }
  }
  return out;
}

const viewKey = () => (mineView ? verseKey(mineView.b, mineView.c, mineView.v) : '');
/**
 * Render the Mine tab body for a verse (or, with v = 0, the chapter) into `host`: the header, the composer when it is
 * open for this verse, and the links. It keeps itself current on bs:links-changed while the host is in the page.
 */
export function renderMine(host, { b, c, v } = {}) {
  if (!host) return null;
  b = +b || state.book; c = +c || state.chapter; v = +v || 0;
  if (!bookOf(b)) return host;
  const ae = document.activeElement;
  const keep = ae && ae.id && host.contains(ae) ? { id: ae.id, s: ae.selectionStart, e: ae.selectionEnd } : null;
  mineHost = host; mineView = { b, c, v };
  host.innerHTML = `<div class="mine" data-mine="${verseKey(b, c, v)}">${headHtml()}<div class="mc-slot">${draft && draft.at === viewKey() ? composerHtml(draft) : ''}</div><div class="mine-body">${listHtml()}</div></div>`;
  bindHost(host);
  afterRender(host, keep);
  return host;
}
/** The number the Mine tab shows for a verse, or with v = 0 its chapter (each link once): its header and drawer.js's #cnt-mine. */
export const mineCount = (b, c, v) => (v ? linksFor(b, c, v).length : chapterRows(b, c).length);
function headHtml() {
  const { b, c, v } = mineView;
  const n = mineCount(b, c, v);
  const open = !!(draft && draft.at === viewKey());
  const away = !!v && (b !== state.book || c !== state.chapter); // the panel's title names the reader's chapter, not this verse
  return `<div class="lh mine-lh"><h3 id="mine-h">My links${away ? `<span class="mine-of"> for ${esc(refLabel(b, c, v))}</span>` : ''}<span class="mine-n">${n ? ` · ${n}` : ''}</span></h3>${v ? `<span class="mine-acts"><button class="btn btn-tinted sm" type="button" data-link-pick title="Link from here (c)">${icon('link-node')}Link from here</button><button class="btn btn-plain sm" type="button" data-link-new aria-expanded="${open}" aria-controls="mine-composer">${icon('plus')}Connect</button></span>` : ''}</div>`;
}
/** A chapter's links, each once, under the first verse of this chapter it touches: [[v, link]]. */
function chapterRows(b, c) {
  const ch = byChapter.get(`${b}.${c}`); if (!ch) return [];
  const first = new Map();
  for (const v of [...ch.keys()].sort((x, y) => x - y)) for (const id of ch.get(v)) if (!first.has(id)) first.set(id, v);
  return [...first].map(([id, v]) => [v, links.byId.get(id)]).filter(x => x[1]);
}
function listHtml() {
  const { b, c, v } = mineView;
  if (v) {
    const list = linksFor(b, c, v);
    if (!list.length) return emptyHtml(`No links from ${esc(refLabel(b, c, v))} yet`, 'Connect this verse to another with + Connect, or press c and choose a verse anywhere in the Bible.');
    return `<ul class="group av mine-list" aria-labelledby="mine-h">${list.map(l => cardHtml(l, b, c, v)).join('')}</ul>`;
  }
  const rows = chapterRows(b, c);
  if (!rows.length) return emptyHtml(`No links in ${esc(refLabel(b, c))} yet`, 'Select a verse, then press c and choose a verse anywhere in the Bible, or use + Connect.');
  const by = new Map();
  for (const [vv, l] of rows) { if (!by.has(vv)) by.set(vv, []); by.get(vv).push(l); }
  return [...by].sort((x, y) => x[0] - y[0]).map(([vv, ls]) => `<h4 class="act-day" id="mine-v${vv}">Verse ${vv}</h4><ul class="group av mine-list" aria-labelledby="mine-v${vv}">${ls.map(l => cardHtml(l, b, c, vv)).join('')}</ul>`).join('');
}
const emptyHtml = (title, body) => `<div class="empty mine-empty"><span class="tile-i blue">${icon('link-node')}</span><h4>${title}</h4><p>${body}</p></div>`;
function cardHtml(l, b, c, v) {
  const o = otherEnd(l, b, c, v); if (!o) return '';
  const here = o.side === 'to' ? 'from' : 'to', ph = phrase(l, here), lab = linkRefLabel(o);
  const pre = l.dir === 'both' ? '↔' : here === 'to' ? '←' : '', post = l.dir !== 'both' && here === 'from' ? '→' : '';
  const arrow = a => (a ? `<span aria-hidden="true">${a}</span>` : '');
  return `<li class="mine-card" data-link="${l.id}" data-bm-color="${l.color}" data-v="${v}">
    <div class="mine-main">
      <div class="mine-r1"><span class="mine-type">${arrow(pre)}<span>${esc(ph)}</span>${arrow(post)}</span><button class="link mine-go" type="button" data-link-go="${o.ref}">${esc(lab)}</button>${l.label && l.type !== 'custom' ? `<span class="mine-cap">${esc(l.label)}</span>` : ''}</div>
      <p class="cell-sub serif mine-prev" data-link-prev="${o.b}.${o.c}.${o.v}.${o.ve}"></p>
      <button class="link mine-ctx" type="button" data-link-ctx aria-expanded="false" aria-controls="mx-${l.id}-${v}">Read in context</button>
      <div class="expand" id="mx-${l.id}-${v}" role="region" aria-label="${esc(linkRefLabel(o))} in context" inert><div><div class="expand-in"></div></div></div>
      ${l.note ? `<div class="md mine-note" data-link-note>${renderMd(l.note)}</div><button class="link mine-more" type="button" data-link-more aria-expanded="false" hidden>More</button>` : ''}
      ${l.tags.length ? `<div class="mine-tags">${l.tags.map(t => `<button class="chip sm" type="button" data-link-tag="${esc(t)}" title="Show #${esc(t)} in My map">#${esc(t)}</button>`).join('')}</div>` : ''}
    </div>
    <button class="more-btn" type="button" data-link-menu aria-haspopup="dialog" aria-expanded="false" aria-label="More actions for the link to ${esc(lab)}">${icon('ellipsis')}</button>
  </li>`;
}
function composerHtml(d) {
  const ev = evalDraft(d);
  const bad = f => (d.tried && ev.field === f ? ' bad' : '');
  const fixed = `<span class="mc-fixed">${esc(linkRefLabel(d.fixed))}</span>`;
  const input = `<div class="mc-to-wrap"><div class="field sm${bad('to')}"><input id="mc-to" value="${esc(d.toText)}" placeholder="Verse, e.g. isa 53:7" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="mc-books" aria-describedby="mc-to-msg"></div><ul id="mc-books" class="mc-books" role="listbox" aria-label="Books" hidden></ul><p class="mc-msg${toBad(ev, d) ? ' bad' : ''}" id="mc-to-msg">${msgHtml(ev, d)}</p></div>`;
  const row = (k, h, inp) => `<div class="mc-end">${inp ? `<label class="mc-k" for="mc-to">${k}</label>` : `<span class="mc-k">${k}</span>`}${h}</div>`;
  const ends = d.swapped ? row('From', input, true) + row('To', fixed) : row('From', fixed) + row('To', input, true);
  const type = t => { const on = d.type === t.id; return `<button class="chip sm" type="button" role="radio" data-mc-type="${t.id}" aria-checked="${on}" tabindex="${on ? 0 : -1}">${t.label}</button>`; };
  const sw = c => { const on = d.color === c; return `<button type="button" role="radio" class="bm-sw" data-bm-color="${c}" data-mc-color="${c}" aria-checked="${on}" tabindex="${on ? 0 : -1}" aria-label="${cap(c)}" title="${cap(c)}">${icon('check')}</button>`; };
  const tags = allTags().filter(t => !d.tags.includes(t)).slice(0, 200);
  return `<form class="card mine-composer" id="mine-composer" novalidate aria-label="${d.id ? 'Edit link' : 'New link'}">
    <div class="mc-ends">${ends}<button class="close-btn plain mc-swap" type="button" data-mc-swap aria-label="Swap From and To" title="Swap From and To">${icon('swap')}</button></div>
    <div class="mc-sec"><span class="mc-k" id="mc-type-l">Type</span><div class="chips mc-types" role="radiogroup" aria-labelledby="mc-type-l">${TYPES.map(type).join('')}</div></div>
    <div class="mc-sec mc-label"${d.type === 'custom' ? '' : ' hidden'}><div class="field sm${bad('label')}"><input id="mc-label" value="${esc(d.label)}" maxlength="40" placeholder="Label, e.g. foreshadows" aria-label="Custom label" autocomplete="off"></div></div>
    <div class="mc-row"><label for="mc-dir">Two-way<small class="mc-sub">The same words on both verses. Off: it reads from the From verse.</small></label><input id="mc-dir" type="checkbox" class="switch" role="switch"${d.dir === 'both' ? ' checked' : ''}></div>
    <div class="mc-row"><span class="mc-k" id="mc-col-l">Colour</span><div class="bm-colors mc-colors" role="radiogroup" aria-labelledby="mc-col-l">${COLORS.map(sw).join('')}</div></div>
    <div class="tokens mc-tags${bad('tags')}">${icon('tag')}${d.tags.map(t => `<span class="token">#${esc(t)}<button type="button" data-mc-untag="${esc(t)}" aria-label="Remove tag ${esc(t)}">${icon('xmark')}</button></span>`).join('')}<input id="mc-tags" value="${esc(d.tagText)}" list="mc-taglist" placeholder="${d.tags.length ? 'Add tag' : 'Add tags'}" aria-label="Add a tag, then press Return" autocomplete="off" spellcheck="false"><datalist id="mc-taglist">${tags.map(t => `<option value="${esc(t)}"></option>`).join('')}</datalist></div>
    <div class="editor${bad('note')}"><div class="editor-top"><span>Markdown</span></div><textarea id="mc-note" class="note-text" aria-label="Note"${d.tried && ev.field === 'note' ? ' aria-invalid="true" aria-describedby="mc-err"' : ''} maxlength="20000" placeholder="Why do these verses belong together? Link verses like [[Romans 5:8]].">${esc(d.note)}</textarea></div>
    <div class="mc-dup" role="status"${ev.dup ? '' : ' hidden'}>${dupHtml(ev)}</div>
    <p class="field-msg mc-err" id="mc-err" role="alert"${footErr(ev, d) ? '' : ' hidden'}>${footErr(ev, d) ? esc(ev.err) : ''}</p>
    <div class="mc-foot"><button class="btn btn-plain sm" type="button" data-mc-cancel>Cancel</button><button class="btn btn-primary sm" type="submit">Save</button></div>
  </form>`;
}
// after a failed Save the To error shows under the field only; the foot line is for the label and tags
const toErr = (ev, d) => !!(d && d.tried && ev.field === 'to' && ev.err);
const toBad = (ev, d) => ev.bad || toErr(ev, d);
const footErr = (ev, d) => !!(d && d.tried && ev.err && ev.field !== 'to');
const msgHtml = (ev, d) => (toErr(ev, d) ? esc(ev.err) : ev.bad ? esc(ev.msg) : ev.msg ? `${icon('check')}${esc(ev.msg)}` : '');
function dupHtml(ev) {
  if (!ev.dup) return '';
  return `<p>${icon('info')}You already linked ${esc(linkRefLabel(ev.from))} to ${esc(linkRefLabel(ev.to))} as “${esc(typeName(ev.dup.type).toLowerCase())}”.</p><button class="btn btn-tinted sm" type="button" data-mc-existing="${ev.dup.id}">Edit the existing link</button>`;
}
/** Update what depends on the draft without redrawing the form (the caret stays where it is). */
function syncComposer(form) {
  const d = draft; if (!form || !d) return;
  const ev = evalDraft(d);
  const msg = $('#mc-to-msg', form); if (msg) { msg.innerHTML = msgHtml(ev, d); msg.classList.toggle('bad', toBad(ev, d)); }
  const dup = $('.mc-dup', form); if (dup) { const h = dupHtml(ev); if (dup.innerHTML !== h) dup.innerHTML = h; dup.hidden = !ev.dup; }
  const err = $('#mc-err', form);
  if (err) { const show = footErr(ev, d), text = show ? ev.err : ''; err.hidden = !show; if (err.textContent !== text) err.textContent = text; err.classList.remove('sr'); }
  $('#mc-to', form)?.closest('.field')?.classList.toggle('bad', d.tried && ev.field === 'to');
  $('#mc-label', form)?.closest('.field')?.classList.toggle('bad', d.tried && ev.field === 'label');
  $('.mc-tags', form)?.classList.toggle('bad', d.tried && ev.field === 'tags');
  const note = $('#mc-note', form);
  if (note) {
    const on = d.tried && ev.field === 'note';
    note.closest('.editor')?.classList.toggle('bad', on);
    if (on) { note.setAttribute('aria-invalid', 'true'); note.setAttribute('aria-describedby', 'mc-err'); }
    else { note.removeAttribute('aria-invalid'); note.removeAttribute('aria-describedby'); }
  }
  const lab = $('.mc-label', form); if (lab) lab.hidden = d.type !== 'custom';
  const sw = $('#mc-dir', form); if (sw) sw.checked = d.dir === 'both';
  return ev;
}
let noteT = 0;
/** Typing in a note that is too long: the error clears at once, but its count (a role=alert) is redrawn, and read, only once typing pauses. */
function noteSync(form) {
  clearTimeout(noteT);
  if (evalDraft(draft).field !== 'note') { syncComposer(form); return; }
  noteT = setTimeout(() => { if (draft && form.isConnected) syncComposer(form); }, 800);
}
function renderComposer(focusSel) {
  if (!mineHost || !mineHost.isConnected) return;
  const slot = $('.mc-slot', mineHost); if (!slot) return;
  slot.innerHTML = draft && draft.at === viewKey() ? composerHtml(draft) : '';
  const nb = $('[data-link-new]', mineHost); if (nb) nb.setAttribute('aria-expanded', String(!!slot.firstElementChild));
  if (focusSel) $(focusSel, mineHost)?.focus({ preventScroll: true });
  const f = $('#mine-composer', mineHost);
  if (f && focusSel) f.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
}
/** Re-render the header count and the list (the composer and its caret are left alone). */
function refreshMine() {
  if (!mineHost || !mineHost.isConnected || !mineView) return;
  const ae = document.activeElement, inList = ae && $('.mine-body', mineHost)?.contains(ae);
  const lh = $('.mine-lh', mineHost);
  if (lh) {
    const n = mineCount(mineView.b, mineView.c, mineView.v);
    const s = $('.mine-n', lh); if (s) s.textContent = n ? ` · ${n}` : '';
  }
  const body = $('.mine-body', mineHost); if (!body) return;
  const card = inList && ae.closest('[data-link]');
  const at = card ? { id: card.dataset.link, v: card.dataset.v, sel: ae.matches('[data-link-menu]') ? '[data-link-menu]' : ae.matches('[data-link-go]') ? '[data-link-go]' : '' } : null;
  const order = card ? $$('[data-link]', body).map(x => x.dataset.link) : [];
  // a ⋯ menu open on a card (a colour was just picked) moves to the redrawn card's button, so Esc returns there
  const menu = $('.menu.link-menu'), mc = menu && menu._opener && body.contains(menu._opener) ? menu._opener.closest('[data-link]') : null;
  const mat = mc ? `[data-link="${mc.dataset.link}"][data-v="${mc.dataset.v}"] [data-link-menu]` : '';
  body.innerHTML = listHtml();
  fillPreviews(body); clampNotes(body);
  if (mat) { const nb = $(mat, body); if (nb) { menu._opener = nb; nb.setAttribute('aria-expanded', 'true'); } else ui.closeMenu(false); }
  if (afterFocus) { const t = takeAfter(mineHost); if (t) { t.focus({ preventScroll: true }); t.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() }); return; } }
  if (at) {
    // the same control on the same card, else the next card (the deleted one's place), else the header
    let t = $(`[data-link="${at.id}"][data-v="${at.v}"] ${at.sel || '[data-link-go]'}`, body);
    if (!t) for (const id of order.slice(order.indexOf(at.id) + 1)) { t = $(`[data-link="${id}"] [data-link-menu]`, body); if (t) break; }
    (t || $('[data-link-new]', mineHost) || $('[data-link-menu]', body))?.focus({ preventScroll: true });
  }
}
function afterRender(host, keep) {
  const body = $('.mine-body', host);
  if (body) { fillPreviews(body); clampNotes(body); }
  const d = draft && draft.at === viewKey() ? draft : null;
  if (d && d.focus) {
    const sel = d.focus === 'type' ? '.mc-types [aria-checked="true"]' : '#mc-to';
    d.focus = null;
    const t = $(sel, host);
    if (t) { t.focus({ preventScroll: true }); $('#mine-composer', host)?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() }); return; }
  }
  if (afterFocus) { const t = takeAfter(host); if (t) { t.focus({ preventScroll: true }); t.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() }); return; } }
  if (keep) {
    const t = document.getElementById(keep.id);
    if (t && host.contains(t)) { t.focus({ preventScroll: true }); try { if (keep.s != null) t.setSelectionRange(keep.s, keep.e); } catch (e) { /* not a text field */ } }
  }
}
async function fillPreviews(root) {
  const items = $$('[data-link-prev]', root); if (!items.length) return;
  const tr = previewTr();
  await Promise.all([...new Set(items.map(p => +p.dataset.linkPrev.split('.')[0]))].map(b => data.bible(tr, b).catch(() => null)));
  for (const p of items) {
    if (!p.isConnected || p.textContent) continue;
    const [b, c, v, ve] = p.dataset.linkPrev.split('.').map(Number);
    try { const r = await previewText(b, c, v, ve > v ? ve : 0); p.textContent = clip(r.text, 160) || ' '; } catch (e) { p.textContent = ' '; }
  }
}
/** Notes longer than four lines fold, with More. */
function clampNotes(root) {
  for (const n of $$('[data-link-note]', root)) {
    const more = n.nextElementSibling;
    if (more && more.matches('[data-link-more]')) more.hidden = n.scrollHeight <= n.clientHeight + 2;
  }
}
/** Read in context (the Links tab's expander): two verses either side, the linked ones marked. */
async function expandCtx(li, btn) {
  const ex = $('.expand', li); if (!ex) return;
  const open = !li.classList.contains('open');
  if (open) {
    const box = $('.expand-in', li);
    if (box && !box.dataset.loaded) {
      const p = $('[data-link-prev]', li).dataset.linkPrev.split('.').map(Number), [b, c, v, ve] = p;
      const tr = previewTr(), bk = await data.bible(tr, b).catch(() => ({}));
      const ch = bk[c] || [];
      let h = '<div class="ctx-read">';
      for (let i = Math.max(1, v - 2); i <= Math.min(ch.length, ve + 2); i++) {
        const t = i >= v && i <= ve, x = String(ch[i - 1] || '');
        h += `<p${t ? ' class="t"' : ''}><span class="n">${i}</span>${t ? `<span class="tx">${esc(x)}</span>` : esc(x)}</p>`;
      }
      h += `</div><div class="actions"><button class="btn btn-primary sm" type="button" data-link-go="${linkRefStr({ b, c, v, ve })}">Open ${esc(refLabel(b, c))}${icon('arrow-right')}</button></div>`;
      box.innerHTML = h; box.dataset.loaded = '1';
    }
    void li.offsetWidth;
  }
  li.classList.toggle('open', open);
  ex.inert = !open;
  btn.setAttribute('aria-expanded', String(open));
}

// ------------------------------------------------------------ composer actions
function openComposer(opts) {
  if (guestBlocked()) return; // the prompt rather than a composer whose link would be refused
  draft = newDraft({ at: viewKey(), ...opts });
  renderComposer(draft.focus === 'type' ? '.mc-types [aria-checked="true"]' : '#mc-to');
  if (draft) draft.focus = null;
}
function closeComposer(focusSel = '[data-link-new]') {
  draft = null; hideBooks();
  if (leaveFocus(focusSel)) return;
  renderComposer(null);
  if (focusSel) $(focusSel, mineHost)?.focus({ preventScroll: true });
}
function pickType(t, form) {
  if (!draft || !TYPE.has(t)) return;
  draft.type = t;
  if (!draft.dirTouched) draft.dir = TYPE.get(t).dirDefault;
  ui.setRadio($('.mc-types', form), b => b.dataset.mcType === t);
  syncComposer(form);
}
function pickColour(c, form) {
  if (!draft || !COLORS.includes(c)) return;
  draft.color = c;
  ui.setRadio($('.mc-colors', form), b => b.dataset.mcColor === c);
}
/** Tags input -> chips: trimmed, lower case; letters, digits, spaces, '-' and '_'; at most 20. */
function addTag(form, text) {
  const d = draft; if (!d) return false;
  const raw = String(text ?? '').replace(/^#+/, '').trim();
  if (!raw) return false;
  const t = cleanTag(raw);
  d.tagErr = '';
  if (!t) d.tagErr = 'Tags can use letters, digits, spaces, “-” and “_”.';
  else if (!d.tags.includes(t) && d.tags.length >= 20) d.tagErr = 'A link can have up to 20 tags.';
  if (d.tagErr) { d.tried = true; syncComposer(form); return false; }
  if (!d.tags.includes(t)) d.tags.push(t);
  d.tagText = '';
  redrawTags(form);
  return true;
}
function redrawTags(form) {
  const box = $('.mc-tags', form), inp = $('#mc-tags', form); if (!box || !inp) return;
  $$('.token', box).forEach(x => x.remove());
  inp.insertAdjacentHTML('beforebegin', draft.tags.map(t => `<span class="token">#${esc(t)}<button type="button" data-mc-untag="${esc(t)}" aria-label="Remove tag ${esc(t)}">${icon('xmark')}</button></span>`).join(''));
  inp.value = draft.tagText; inp.placeholder = draft.tags.length ? 'Add tag' : 'Add tags';
  const dl = $('#mc-taglist', form); if (dl) dl.innerHTML = allTags().filter(t => !draft.tags.includes(t)).slice(0, 200).map(t => `<option value="${esc(t)}"></option>`).join('');
  syncComposer(form);
}
async function submitDraft(form) {
  const d = draft; if (!d) return;
  if (d.tagText.trim() && !addTag(form, d.tagText)) { $('#mc-tags', form)?.focus(); return; }
  d.tried = true;
  clearTimeout(noteT);
  const said = $('#mc-err', form), was = said && !said.hidden ? said.textContent : '';
  const ev = syncComposer(form);
  if (ev.err) {
    const f = ev.field === 'label' ? '#mc-label' : ev.field === 'tags' ? '#mc-tags' : ev.field === 'note' ? '#mc-note' : '#mc-to';
    const inp = $(f, form);
    // focus moving to the To field reads its error (aria-describedby); already there (Cmd-Return), say it once
    if (f === '#mc-to' && inp && inp === document.activeElement) { const err = $('#mc-err', form); if (err) { err.classList.add('sr'); err.hidden = false; err.textContent = ev.err; } }
    // the same error as before this Save: syncComposer left the alert as it was, so clear it and say it again
    else if (said && !said.hidden && was === ev.err) { said.textContent = ''; setTimeout(() => { if (said.isConnected && !said.hidden && !said.textContent) said.textContent = ev.err; }, 60); }
    inp?.focus();
    return;
  }
  if (ev.dup) { const b = $('[data-mc-existing]', form); b?.focus(); $('.mc-dup', form)?.classList.remove('shake'); void form.offsetWidth; $('.mc-dup', form)?.classList.add('shake'); return; }
  const prev = d.id ? links.byId.get(d.id) : null, before = prev ? copyLink(prev) : null;
  const l = await saveLink({ id: d.id || undefined, from: linkRefStr(ev.from), to: linkRefStr(ev.to), type: d.type, label: d.type === 'custom' ? d.label.trim() : d.caption, note: d.note, color: d.color, tags: d.tags, dir: d.dir });
  if (!l) { toast('That link couldn’t be saved. Check the verses and try again.'); return; }
  draft = null; hideBooks();
  const at = `[data-link="${l.id}"] [data-link-go]`;
  // from another chapter's verse: the list for the selection, with focus on the new link when it is there
  if (!leaveFocus([at, '[data-link-new]'])) { afterFocus = at; renderComposer(null); refreshMine(); }
  const dry = DRY ? ' ' + DRY_MSG : '';
  if (before) toast(`Saved your link to ${otherLabel(l)}.${dry}`, { label: 'Undo', run: () => { saveLink(before); } });
  else toast(`Linked ${linkRefLabel(ev.from)} to ${linkRefLabel(ev.to)}.${dry}`, { label: 'Undo', run: () => { deleteLink(l.id, { undo: false }); } });
}

// book-name completion for the other end (meta books[].name/short)
const flat = s => String(s || '').toLowerCase().replace(/[\s.]/g, '');
function bookMatches(text) {
  const m = String(text || '').match(/^\s*((?:[1-3]\s*)?[a-z][a-z ]*)$/i);
  if (!m) return [];
  const q = flat(m[1]);
  return state.books.filter(bk => [bk.name, bk.short, bk.osis].some(x => x && flat(x).startsWith(q))).slice(0, 8);
}
function showBooks(form) {
  const inp = $('#mc-to', form), lb = $('#mc-books', form); if (!inp || !lb) return;
  const hits = bookMatches(inp.value);
  if (!hits.length || (hits.length === 1 && flat(hits[0].name) === flat(inp.value))) { hideBooks(form); return; }
  lb.innerHTML = hits.map((bk, i) => `<li role="option" id="mc-bk${i}" data-mc-book="${esc(bk.name)}" aria-selected="false">${esc(bk.name)}</li>`).join('');
  lb.hidden = false; inp.setAttribute('aria-expanded', 'true'); inp.removeAttribute('aria-activedescendant');
}
function hideBooks(form) {
  const root = form || mineHost; if (!root) return;
  const lb = $('#mc-books', root), inp = $('#mc-to', root);
  if (lb) { lb.hidden = true; lb.innerHTML = ''; }
  if (inp) { inp.setAttribute('aria-expanded', 'false'); inp.removeAttribute('aria-activedescendant'); }
}
function chooseBook(form, name) {
  const inp = $('#mc-to', form); if (!inp || !draft) return;
  inp.value = draft.toText = name + ' ';
  hideBooks(form); inp.focus();
  try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) { /* ignore */ }
  syncComposer(form);
}
function bookKeys(e, form) {
  const lb = $('#mc-books', form), inp = e.target;
  if (!lb || lb.hidden) return false;
  const opts = $$('[role=option]', lb); if (!opts.length) return false;
  let i = opts.findIndex(o => o.getAttribute('aria-selected') === 'true');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    i = e.key === 'ArrowDown' ? (i + 1) % opts.length : (i <= 0 ? opts.length - 1 : i - 1);
    opts.forEach((o, k) => o.setAttribute('aria-selected', String(k === i)));
    inp.setAttribute('aria-activedescendant', opts[i].id);
    opts[i].scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (e.key === 'Enter' && (i >= 0 || opts.length === 1)) { e.preventDefault(); chooseBook(form, opts[Math.max(0, i)].dataset.mcBook); return true; }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideBooks(form); return true; }
  return false;
}

// ------------------------------------------------------------ the host's events (delegated, bound once per host)
const boundHosts = new WeakSet();
function bindHost(host) {
  if (boundHosts.has(host)) return;
  boundHosts.add(host);
  host.addEventListener('click', e => onHostClick(e, host));
  host.addEventListener('mousedown', e => { if (e.target.closest('[data-mc-book]')) e.preventDefault(); }); // keep the caret in the field
  host.addEventListener('input', e => {
    const t = e.target, form = t.closest('#mine-composer'); if (!form || !draft) return;
    if (t.id === 'mc-to') { draft.toText = t.value; showBooks(form); syncComposer(form); }
    else if (t.id === 'mc-label') { draft.label = t.value; syncComposer(form); }
    else if (t.id === 'mc-note') { draft.note = t.value; if (draft.tried) noteSync(form); }
    else if (t.id === 'mc-tags') {
      draft.tagText = t.value; if (draft.tagErr) { draft.tagErr = ''; syncComposer(form); }
      if (/,/.test(t.value)) {
        const parts = t.value.split(','), rest = parts.pop();
        for (const p of parts) addTag(form, p);
        draft.tagText = rest; const inp = $('#mc-tags', form); if (inp) inp.value = rest;
      }
      else if (e.inputType === 'insertReplacementText' || !e.inputType) addTag(form, t.value); // a datalist suggestion was chosen
    }
  });
  host.addEventListener('change', e => {
    const t = e.target; if (t.id !== 'mc-dir' || !draft) return;
    draft.dir = t.checked ? 'both' : 'to'; draft.dirTouched = true;
  });
  host.addEventListener('focusout', e => { const form = e.target.closest?.('#mine-composer'); if (form && e.target.id === 'mc-to' && !form.contains(e.relatedTarget)) hideBooks(form); });
  host.addEventListener('submit', e => { const form = e.target.closest('#mine-composer'); if (!form) return; e.preventDefault(); submitDraft(form); });
  host.addEventListener('keydown', e => {
    const t = e.target, form = t.closest?.('#mine-composer');
    if (!form || !draft || e.defaultPrevented) return; // drawer.js's body handler may have moved a radiogroup already
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); submitDraft(form); return; }
    if (t.id === 'mc-to') {
      if (bookKeys(e, form)) return;
      if (e.key === 'Enter') { e.preventDefault(); hideBooks(form); if (evalDraft(draft).other) $('.mc-types [aria-checked="true"]', form)?.focus(); }
      return;
    }
    if (t.id === 'mc-label' && e.key === 'Enter') { e.preventDefault(); $('#mc-dir', form)?.focus(); return; }
    if (t.id === 'mc-tags') {
      if (e.key === 'Enter') { e.preventDefault(); addTag(form, t.value); return; }
      if (e.key === 'Backspace' && !t.value && draft.tags.length) { e.preventDefault(); draft.tags.pop(); redrawTags(form); return; }
      return;
    }
    const grp = t.closest('[role=radiogroup]');
    if (grp && grp.classList.contains('mc-types')) ui.radioKeys(e, grp, b => pickType(b.dataset.mcType, form));
    else if (grp && grp.classList.contains('mc-colors')) ui.radioKeys(e, grp, b => pickColour(b.dataset.mcColor, form));
  });
}
function onHostClick(e, host) {
  const t = e.target;
  const form = t.closest('#mine-composer');
  if (form) {
    if (t.closest('[data-mc-cancel]')) { closeComposer(); return; }
    const ty = t.closest('[data-mc-type]'); if (ty) { pickType(ty.dataset.mcType, form); return; }
    const co = t.closest('[data-mc-color]'); if (co) { pickColour(co.dataset.mcColor, form); return; }
    const bk = t.closest('[data-mc-book]'); if (bk) { chooseBook(form, bk.dataset.mcBook); return; }
    const un = t.closest('[data-mc-untag]');
    if (un) { draft.tags = draft.tags.filter(x => x !== un.dataset.mcUntag); redrawTags(form); $('#mc-tags', form)?.focus(); return; }
    if (t.closest('[data-mc-swap]')) {
      draft.toText = $('#mc-to', form)?.value ?? draft.toText;
      draft.swapped = !draft.swapped; renderComposer('[data-mc-swap]'); return;
    }
    const ex = t.closest('[data-mc-existing]');
    if (ex) { const l = links.byId.get(ex.dataset.mcExisting); if (l) editLink(l); return; }
    if (t.closest('.mc-tags') && !t.closest('button, input')) $('#mc-tags', form)?.focus();
    return;
  }
  if (t.closest('[data-link-pick]')) { if (A && typeof A.startLinkPick === 'function') A.startLinkPick(mineView); else startPick(mineView); return; }
  if (t.closest('[data-link-new]')) {
    if (draft && draft.at === viewKey()) closeComposer();
    else openComposer({ fixed: { ...mineView, ve: mineView.v }, focus: 'to' });
    return;
  }
  const card = t.closest('[data-link]');
  const l = card && links.byId.get(card.dataset.link);
  if (!l) {
    // [[John 3:16]] in a note, outside the study panel (there drawer.js follows it)
    const vl = t.closest('.vlink');
    if (vl && !host.closest('#drawer-body') && A) { e.preventDefault(); A.goReference(vl.dataset.ref); }
    return;
  }
  const go = t.closest('[data-link-go]');
  if (go) { goTo(go.dataset.linkGo); return; }
  if (t.closest('[data-link-ctx]')) { expandCtx(card, t.closest('[data-link-ctx]')); return; }
  const mb = t.closest('[data-link-menu]'); if (mb) { openLinkMenu(mb, l); return; }
  const more = t.closest('[data-link-more]');
  if (more) { const n = $('[data-link-note]', card); const full = n.classList.toggle('full'); more.textContent = full ? 'Less' : 'More'; more.setAttribute('aria-expanded', String(full)); return; }
  const tag = t.closest('[data-link-tag]');
  if (tag) { if (A && typeof A.openLibrary === 'function') A.openLibrary({ view: 'map', tag: tag.dataset.linkTag }); return; }
  const vl = t.closest('.vlink');
  if (vl && !host.closest('#drawer-body') && A) { e.preventDefault(); A.goReference(vl.dataset.ref); }
}
/** Go to the other end of a link: that verse is selected and the Mine tab stays. */
function goTo(ref) {
  const r = parseLinkRef(ref); if (!r || !A) return;
  focusRef = null;
  A.navigate(r.b, r.c, r.v);
  if (state.drawerOpen && state.drawerTab !== 'mine') A.select(r.v, { tab: 'mine' });
  if (r.ve > r.v && typeof A.flash === 'function') A.flash(Array.from({ length: r.ve - r.v + 1 }, (_, i) => r.v + i), { scroll: false });
}
function editLink(l) {
  const v = mineView;
  const end = v && v.v ? (covers(parseLinkRef(l.from), v.b, v.c, v.v) ? parseLinkRef(l.from) : covers(parseLinkRef(l.to), v.b, v.c, v.v) ? parseLinkRef(l.to) : null) : null;
  // in the chapter list (or for a link elsewhere) the fixed end is the one in this chapter
  const fixed = end || [parseLinkRef(l.from), parseLinkRef(l.to)].find(r => r && v && r.b === v.b && r.c === v.c) || parseLinkRef(l.from);
  const other = linkRefStr(fixed) === l.to ? parseLinkRef(l.from) : parseLinkRef(l.to);
  openComposer({ fixed, other, link: l, focus: 'type' });
}

// ------------------------------------------------------------ the ⋯ menu on a link
/** Edit, Reverse direction (one-way links), colour, Copy as text, Delete. */
export function openLinkMenu(anchor, link) {
  const l = link && links.byId.get(link.id); if (!anchor || !l) return null;
  const card = anchor.closest('[data-link]');
  const v = card ? +card.dataset.v : (mineView && mineView.v) || 0;
  const o = card && mineView ? otherEnd(l, mineView.b, mineView.c, v) : null; // the Library's ⋯ names the `to` end
  const name = o ? linkRefLabel(o) : linkRefLabel(parseLinkRef(l.to));
  const sw = c => `<button type="button" role="radio" class="bm-sw" data-bm-color="${c}" data-lm-color="${c}" aria-checked="${c === l.color}" tabindex="${c === l.color ? 0 : -1}" aria-label="${cap(c)}" title="${cap(c)}">${icon('check')}</button>`;
  const html = `<div class="bm-menu-head" role="presentation"><div class="bm-colors" role="radiogroup" aria-label="Colour">${COLORS.map(sw).join('')}</div></div>
    <hr>
    <div role="menu" aria-label="Link actions">
    <button type="button" role="menuitem" data-lmi="edit">Edit${icon('note')}</button>
    ${l.dir === 'to' ? `<button type="button" role="menuitem" data-lmi="reverse">Reverse direction${icon('swap')}</button>` : ''}
    <button type="button" role="menuitem" data-lmi="copy">Copy as text${icon('export')}</button>
    <hr>
    <button type="button" role="menuitem" class="danger" data-lmi="delete">Delete${icon('trash')}</button>
    </div>`;
  const recolour = sw => {
    const g = sw.closest('.bm-colors');
    $$('.bm-sw', g).forEach(x => { const on = x === sw; x.setAttribute('aria-checked', String(on)); x.tabIndex = on ? 0 : -1; });
    const cur = links.byId.get(l.id); if (cur && cur.color !== sw.dataset.lmColor) saveLink({ ...copyLink(cur), color: sw.dataset.lmColor });
  };
  return ui.openMenu(anchor, html, {
    label: `Link to ${name}`, className: 'bm-menu link-menu', dialog: true, focus: '[data-lmi="edit"]',
    onClick: e => {
      const s = e.target.closest('[data-lm-color]'); if (s) { recolour(s); return; }
      const it = e.target.closest('[data-lmi]'); if (!it) return;
      const act = it.dataset.lmi, cur = links.byId.get(l.id);
      ui.closeMenu(true); // a deleted link's place in the list then passes the focus on (refreshMine)
      if (!cur) return;
      if (act === 'edit') editLink(cur);
      else if (act === 'reverse') reverseLink(cur);
      else if (act === 'copy') copyAsText(cur);
      else if (act === 'delete') deleteLink(cur.id);
    },
    onKeydown: (e, m) => {
      const t = e.target;
      if (!t.classList || !t.classList.contains('bm-sw')) return;
      const sws = $$('.bm-sw', m), i = sws.indexOf(t);
      let n = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') n = sws[(i + (e.key === 'ArrowRight' ? 1 : -1) + sws.length) % sws.length];
      else if (e.key === 'Home' || e.key === 'End') n = sws[e.key === 'Home' ? 0 : sws.length - 1];
      else if (e.key === 'ArrowDown') { e.preventDefault(); $('[data-lmi]', m)?.focus(); return; }
      if (n) { e.preventDefault(); n.focus(); recolour(n); }
    },
  });
}
function reverseLink(l) {
  const dup = [...links.byId.values()].find(x => x.id !== l.id && x.from === l.to && x.to === l.from && x.type === l.type);
  if (dup) { toast('You already have this link the other way round.'); return; }
  const before = copyLink(l);
  saveLink({ ...copyLink(l), from: l.to, to: l.from }).then(n => {
    if (!n) return;
    toast(`Reversed: ${linkRefLabel(parseLinkRef(n.from))} ${phrase(n, 'from')} ${linkRefLabel(parseLinkRef(n.to))}.${DRY ? ' ' + DRY_MSG : ''}`, { label: 'Undo', run: () => { saveLink(before); } });
  });
}
/** "John 1:29 fulfils Isaiah 53:7", then the caption, the note and the tags. */
export function linkAsText(l) {
  const f = parseLinkRef(l.from), t = parseLinkRef(l.to);
  const T = TYPE.get(l.type) || TYPE.get('related');
  const lines = [`${linkRefLabel(f)} ${l.type === 'custom' ? l.label : T.fwd} ${linkRefLabel(t)}${l.label && l.type !== 'custom' ? ` (${l.label})` : ''}`];
  if (l.note.trim()) lines.push('', l.note.trim());
  if (l.tags.length) lines.push('', l.tags.map(x => '#' + x.replace(/\s+/g, '-')).join(' '));
  return lines.join('\n');
}
async function copyAsText(l) {
  const text = linkAsText(l);
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    ta.remove();
  }
  toast(ok ? 'Copied the link as text.' : 'Couldn’t copy. The browser blocked the clipboard.');
}

// ------------------------------------------------------------ init
/** Wire pick mode, the pill, cross-tab sync and page lifecycle. Idempotent. */
export function initLinks(actions) {
  A = actions || A;
  if (early && A && typeof A.toast === 'function') { const [m, a] = early; early = null; A.toast(m, a); }
  if (inited || typeof document === 'undefined') return;
  inited = true;
  registerSaver('links', { flush: () => flushLinks(), pending: pendingLinks }); // store.exportObsidian, account.js flushAll
  // pick mode takes verse clicks and Return before the reader does (capture), and the end of a double click after it
  document.addEventListener('click', e => {
    const v = e.target.closest?.('#reader .verse'); if (!v) return;
    // a drag in pick mode chooses its verse too: drop the words it selected (no highlight bubble for them)
    if (pick) { e.preventDefault(); e.stopPropagation(); window.getSelection?.()?.removeAllRanges(); choose(+v.dataset.v, e.shiftKey); }
    else if (performance.now() < quietUntil) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('dblclick', e => {
    if ((pick || performance.now() < quietUntil) && e.target.closest?.('#reader .verse')) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('keydown', e => {
    if (!pick || (e.key !== 'Enter' && e.key !== ' ') || e.metaKey || e.ctrlKey || e.altKey) return;
    const v = e.target.closest?.('#reader .verse'); if (!v || e.target !== v) return;
    e.preventDefault(); e.stopPropagation(); choose(+v.dataset.v, e.shiftKey);
  }, true);
  document.getElementById('link-pick-cancel')?.addEventListener('click', () => cancelPick());
  pillEl()?.addEventListener('animationend', e => { if (e.animationName === 'shake') pillEl().classList.remove('shake'); });
  window.addEventListener('resize', () => { if (pick) sizePill(); }); // a turned phone rewraps the pill
  document.addEventListener('bs:chapter-rendered', () => { if (pick) markPick(); });
  document.addEventListener('bs:verse-selected', () => { focusRef = null; });
  document.addEventListener('bs:links-changed', () => refreshMine());
  // lifecycle: send on hide or close; pick up another tab's save when shown
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (dirty.size && !DRY) flushLinks({ keepalive: true }); }
    else if (stale) { stale = false; refreshLinks(); }
  });
  window.addEventListener('pagehide', () => { if (dirty.size && !DRY) flushLinks({ keepalive: true }); });
  window.addEventListener('online', () => {
    if (DRY) return;
    if (noServer === 'offline') loadLinks(); else if (dirty.size) flushLinks();
  });
  onBroadcast(m => {
    if (m.t !== 'links' || m.scope !== state.auth.scope || m.scope !== linksScope) return;
    if (Number.isFinite(m.rev) && m.rev <= links.rev) return;
    if (document.visibilityState === 'visible') refreshLinks(); else stale = true;
  });
}
