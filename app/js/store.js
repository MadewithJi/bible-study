// Central state, data loading (lazy + cached), note persistence, dry-run guard and shared helpers.
import { icon } from './icons.js';

// ------------------------------------------------------------ dry run (?dry): never write anything
export const DRY = typeof location !== 'undefined' && new URLSearchParams(location.search).has('dry');
if (typeof window !== 'undefined') window.__DRY__ = DRY;

/** localStorage helpers: reads never throw; writes are skipped in dry-run and never throw. */
export function lsGet(key, fallback = null) { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; } }
export function lsSet(key, value) { if (DRY) return; try { localStorage.setItem(key, value); } catch (e) { /* private mode / quota */ } }
export function lsDel(key) { if (DRY) return; try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }
/** Per-profile storage key: `base` for the guest, `base:<uid>` for a profile (bs-notes-v1, bs-notes-dirty-v1, bs-outbox-v1, bs-pos-v1). */
export function lsKey(base, scope) {
  const s = scope === undefined ? state.auth.scope : scope;
  return s && s !== 'guest' ? `${base}:${s}` : base;
}
export const SCOPE_RX = /^(guest|u[0-9a-f]{16})$/;

export const state = {
  meta: null, books: [], translations: [],
  tr: 'kjv', tr2: '',           // primary and parallel translation ids
  book: 43, chapter: 3,         // 1-based book number
  selected: null,               // selected verse number
  showOrig: false,
  drawerOpen: false,            // the study sheet is closed until the user asks for it
  sheetFull: false,             // phone only: full (94dvh) vs medium (64dvh) detent
  drawerTab: 'xref',
  panel: null,                  // 'arcs' | 'graph' | 'map' | null
  minVotes: 0,                  // stage arcs: minimum-votes slider
  notice: null,                 // {title, body, tr} key card shown above the verses
  xfilter: 'all',               // Links tab testament filter: 'all' | 'ot' | 'nt'
  history: [], future: [],
  notes: { refs: {}, studies: [] },
  apiKeys: { esv: false, nlt: false },
  serverOk: false,
  theme: lsGet('bs-theme', 'auto'),
  // profiles (profiles-spec §5.2). server: /api/auth/me answered; legacy: a pre-profiles serve.py (whole-object notes PUT)
  auth: { known: false, server: false, legacy: false, signedIn: false, scope: 'guest', user: null, session: null, lost: false, guest: null, limits: null, features: null,
    // hosting brief §2 (from /api/auth/me): a hosted site, its sign-up ('open' | 'invite') and whether this is its owner
    hosted: false, signupMode: 'open', owner: false },
  notesRev: 0,
  noteBase: new Map(),          // key -> the note's `updated` as last received from the server (null = the server had none)
};

const cache = new Map();
const titles = new Map(); // `${tr}:${b}:${c}` -> psalm title from /api/passage (ESV/NLT), kept apart from the per-book chapter objects
async function getJSON(url) {
  if (cache.has(url)) return cache.get(url);
  const p = fetch(url).then(r => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); })
    .catch(e => { cache.delete(url); throw e; });
  cache.set(url, p);
  return p;
}
const pad = n => String(n).padStart(2, '0');

export const data = {
  meta: () => getJSON('data/meta.json'),
  bible: async (tr, b) => {
    if (tr === 'esv' || tr === 'nlt') {
      const key = `passage:${tr}:${b}`;
      if (!cache.has(key)) cache.set(key, {});
      return cache.get(key); // chapters filled by passage()
    }
    return getJSON(`data/bibles/${tr}/${pad(b)}.json`);
  },
  passage: async (tr, b, c) => {
    const bk = await data.bible(tr, b);
    if (bk[c]) return bk[c];
    const r = await fetch(`/api/passage?tr=${tr}&book=${b}&chapter=${c}`);
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || 'passage error');
    bk[c] = j.verses; titles.set(`${tr}:${b}:${c}`, typeof j.title === 'string' ? j.title : ''); return j.verses;
  },
  /** The psalm title /api/passage returned with that chapter ('' when none, or before passage() has loaded it). */
  passageTitle: (tr, b, c) => titles.get(`${tr}:${b}:${c}`) || '',
  /** Psalm superscriptions (KJV, BSB) and Psalm 119's letter headings (KJV): {sup: {c: text}, head: {c: {v: text}}}. */
  titles: (tr, b) => (tr === 'kjv' || tr === 'bsb') && b === 19 ? getJSON(`data/bibles/${tr}/19-titles.json`).catch(() => ({})) : Promise.resolve({}),
  xref: b => getJSON(`data/xref/${pad(b)}.json`),
  /** Words of Jesus as [start, end) character ranges per 'c:v' (red-letter KJV; BSB derived). {} when none. */
  redletter: (tr, b) => (tr === 'kjv' || tr === 'bsb') && b >= 40 ? getJSON(`data/redletter/${tr}/${pad(b)}.json`).catch(() => ({})) : Promise.resolve({}),
  /** STEP's words per KJV 'c:v'. While the BSB, ESV or NLT leads, the few verses they divide as the NRSV does
   *  (Phil 1:16–17, Rev 12:17/13:1) come from the file's 'nrsv' table, so reader, drawer and tracker agree. */
  orig: b => getJSON(`data/orig/${pad(b)}.json`).then(o => (o.nrsv && ['bsb', 'esv', 'nlt'].includes(state.tr) ? { ...o, ...o.nrsv } : o)).catch(() => ({})),
  context: b => getJSON(`data/context/${pad(b)}.json`).catch(() => ({})),
  bookIntros: () => getJSON('data/context/books.json'),
  strongs: lang => getJSON(`data/strongs/${lang}.json`),
  conc: s => getJSON(`data/conc/${s}.json`).catch(() => []),
  people: () => getJSON('data/people.json'),
  places: () => getJSON('data/places.json'),
  events: () => getJSON('data/events.json'),
  topics: () => getJSON('data/topics.json'),
  easton: () => getJSON('data/easton.json'),
  paul: () => getJSON('data/pauls_journeys.geojson'),
};

// ------------------------------------------------------------ reference helpers
export const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
export const bookOf = n => state.books[n - 1];
export const isHebrewBook = b => b <= 39;
/**
 * Aramaic in the Old Testament (Dan 2:4–7:28, Ezra 4:8–6:18 and 7:12–26, Jer 10:11). A word is Aramaic when its
 * TAHOT morph code starts with 'A' (Hebrew-book words only: a Greek 'A…' code is an adjective); a verse is when most
 * of its words are, which build.py lists per chapter as meta.json's book 'aram'.
 */
export const isAramaicWord = w => String(w?.[4] || '')[0] === 'A';
export const aramaicVerses = (b, c) => (isHebrewBook(b) && bookOf(b)?.aram?.[c]) || [];
/** decodeMorph's text without its trailing '(Aramaic)': the language is shown on its own, never on one word's chip. */
export const morphNoLang = s => String(s || '').replace(/\s*\(Aramaic\)\s*$/, '');
/** God, Christ and the Holy Spirit are marked divine in the data and are never listed or counted as people. */
export const isDivine = id => (state.meta?.divine || []).includes(+id);

/** Bundled translation used for previews: the primary one if bundled, otherwise BSB. */
export const previewTr = () => (state.tr === 'kjv' || state.tr === 'bsb') ? state.tr : 'bsb';

/**
 * End of a verse range. `vend` is a verse in the same chapter, or chapter*1000 + verse when the range runs
 * into a later chapter (cross-references and topics: Hebrews 6:20–7:3 is c 6, v 20, vend 7003). 0 = no range.
 */
export const rangeEnd = (c, v, vend) => vend >= 1000 ? { ec: Math.floor(vend / 1000), ev: vend % 1000 } : { ec: c, ev: vend > v ? vend : v };

/** Verse text for previews: primary translation if bundled, otherwise BSB. Returns {text, tr}. */
export async function previewText(b, c, v, vend) {
  const tr = previewTr();
  const bk = await data.bible(tr, b);
  const { ec, ev } = rangeEnd(c, v, vend);
  const parts = [];
  for (let cc = c; cc <= ec; cc++) {
    const ch = bk[cc] || [];
    const last = cc === ec ? Math.min(ev, ch.length) : ch.length;
    for (let i = cc === c ? v : 1; i <= last; i++) parts.push(ch[i - 1] || '');
  }
  return { text: parts.filter(Boolean).join(' '), tr };
}
export const refKey = (b, c, v) => v ? `${b}.${c}.${v}` : `${b}.${c}`;
/** 'John 3:16', 'Hebrews 6:20–7:3'; a chapter of Psalms is one psalm: 'Psalm 23:1' (as the chapter hero says). */
export function refLabel(b, c, v, vend) {
  const base = `${b === 19 ? 'Psalm' : bookOf(b).name} ${c}${v ? ':' + v : ''}`;
  if (!v || !vend) return base;
  const { ec, ev } = rangeEnd(c, v, vend);
  return ec !== c ? `${base}–${ec}:${ev}` : ev > v ? `${base}–${ev}` : base;
}
export function parseRefKey(k) { const p = k.split('.').map(Number); return { b: p[0], c: p[1], v: p[2] || 0 }; }

const flat = s => String(s || '').toLowerCase().replace(/[\s.]/g, '');
const REF_ALIAS = { psalm: 'Psalms', pss: 'Psalms', ps: 'Psalms', songofsolomon: 'Song of Songs', sos: 'Song of Songs', canticles: 'Song of Songs',
  qoh: 'Ecclesiastes', eccl: 'Ecclesiastes', rev: 'Revelation', rv: 'Revelation', revelations: 'Revelation', jn: 'John', jhn: 'John',
  mt: 'Matthew', mk: 'Mark', mrk: 'Mark', lk: 'Luke', gn: 'Genesis', ex: 'Exodus', lv: 'Leviticus', nm: 'Numbers', dt: 'Deuteronomy',
  jg: 'Judges', jdg: 'Judges', jb: 'Job', rm: 'Romans', dn: 'Daniel', hg: 'Haggai', ml: 'Malachi', tt: 'Titus', jm: 'James', jas: 'James',
  phil: 'Philippians', php: 'Philippians', phlp: 'Philippians', phm: 'Philemon', phlm: 'Philemon', ezk: 'Ezekiel', jl: 'Joel', na: 'Nahum',
  jgs: 'Judges', sg: 'Song of Songs', songofsol: 'Song of Songs', '1tm': '1 Timothy', '2tm': '2 Timothy', '1pt': '1 Peter', '2pt': '2 Peter' };
const NUMBERED = { i: '1', ii: '2', iii: '3', first: '1', second: '2', third: '3', '1st': '1', '2nd': '2', '3rd': '3' };

/**
 * Parse free text like "jn 3:16", "1 cor 13", "II Kings 2", "John 3:16–18", "Heb 6:20-7:3", "Jude 3" into
 * {b, c, v, vend} (vend per rangeEnd; 0 = none). Returns null when the book is unknown or the chapter or
 * verse does not exist — never a silently clamped reference. With { explain: true } a known book with a chapter
 * or verse past its end ('Rev 23', 'John 3:37') gives { error: 'range', b, c, v } instead, so search can say so.
 */
export function parseReference(text, { explain = false } = {}) {
  const t = String(text || '').trim().replace(/^[(\[]+/, '').replace(/[.,;:!?)\]]+$/, '');   // '(John 3:16).', 'John 3:16!'
  const m = t.match(/^((?:(?:[1-3]|i{1,3}|first|second|third|1st|2nd|3rd)\s*)?[a-z]+(?:\s+(?:of\s+)?[a-z]+)*)\.?\s*(\d+)?(?:[:.\s]+(\d+))?(?:\s*[-–—]\s*(\d+)(?:[:.](\d+))?)?$/i);
  if (!m) return null;
  let name = m[1].toLowerCase().replace(/\s+/g, ' ').trim();
  const num = name.match(/^(i{1,3}|first|second|third|1st|2nd|3rd)\s+(.*)$/);
  if (num) name = `${NUMBERED[num[1]]} ${num[2]}`;
  const key = flat(name);
  let found = state.books.find(b => flat(b.name) === key || flat(b.osis) === key || flat(b.short) === key);
  if (!found && REF_ALIAS[key]) found = state.books.find(b => b.name === REF_ALIAS[key]);
  if (!found) {   // a prefix of the name: 'gen', 'deut', '1 cor', '1cor', '1 thess'
    const lead = key.match(/^([1-3]?)(.*)$/);
    const cands = state.books.filter(b => { const bn = flat(b.name); return bn.startsWith(key) || (lead[1] && bn[0] === lead[1] && bn.slice(1).startsWith(lead[2])); });
    found = cands[0];
  }
  if (!found) return null;
  const nch = found.chapters.length;
  let c = m[2] ? +m[2] : 1, v = m[3] ? +m[3] : 0, vend = 0;
  if (nch === 1 && m[2] && !m[3] && (+m[2] > 1 || (m[4] && !m[5]))) { v = +m[2]; c = 1; }   // 'Jude 3', 'Jude 3-5': one-chapter books cite verses
  if (c < 1 || c > nch || v < 0 || v > found.chapters[c - 1]) return explain ? { error: 'range', b: found.n, c, v } : null;
  if (m[4]) {
    if (m[5]) {   // 'Heb 6:20-7:3'
      const ec = +m[4], ev = +m[5];
      if (ec > c && ec <= nch && ev >= 1 && ev <= found.chapters[ec - 1]) vend = ec * 1000 + ev;
      else if (ec === c && ev > v && ev <= found.chapters[c - 1]) vend = ev;
    } else if (v && +m[4] > v) vend = Math.min(+m[4], found.chapters[c - 1]);   // 'John 3:16-18'
  }
  return { b: found.n, c, v, vend };
}

export const packedRef = n => ({ b: Math.floor(n / 1e6), c: Math.floor(n / 1000) % 1000, v: n % 1000 });

export function yearLabel(y) {
  if (y === null || y === undefined || y === '' || isNaN(+y)) return '';
  y = +y; return y < 0 ? `${-y} BC` : `AD ${y}`;
}

// ------------------------------------------------------------ shared presentation helpers
/** Typographic quotes. Apply before esc(). */
export const smart = s => String(s || '').replace(/(^|[\s(\[{—–-])'/g, '$1‘').replace(/'/g, '’').replace(/(^|[\s(\[{—–-])"/g, '$1“').replace(/"/g, '”');
export const plural = (n, w, pl) => `${Number(n).toLocaleString()} ${n === 1 ? w : (pl || w + 's')}`;
/** Clip on a word boundary (never between the halves of an emoji). */
export const clip = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n).replace(/[\uD800-\uDBFF]$/, '').replace(/\s\S*$/, '') + '…' : t; };
/** Text serve.py can decode: a lone surrogate (half an emoji) becomes U+FFFD instead of failing the whole request. */
export const wellFormed = s => typeof s.toWellFormed === 'function' ? s.toWellFormed()
  : s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, m => m.length > 1 ? m : '\uFFFD');
/** At most n characters, counted as serve.py counts them (code points, so an emoji is never cut in half). */
export function cut(s, n) {
  s = wellFormed(String(s ?? ''));
  if (s.length <= n) return s;
  let i = 0;
  for (let cp = 0; i < s.length && cp < n; cp++) { const c = s.charCodeAt(i); i += c >= 0xD800 && c <= 0xDBFF ? 2 : 1; }
  return s.slice(0, i);
}
/** Two-letter monogram: first letters of the first two capitalised words, else the first two letters. A disambiguator
 *  in brackets is not part of the name ('Mary (Mother of Jesus)' is MA, not MJ). */
export function initials(name) {
  const n = String(name || '').replace(/\s*\([^)]*\)/g, ' ').trim() || String(name || '').trim(); if (!n) return '?';
  const caps = n.split(/\s+/).filter(w => /^[A-Z]/.test(w));
  if (caps.length >= 2) return (caps[0][0] + caps[1][0]).toUpperCase();
  const w = (caps[0] || n).replace(/[^A-Za-z]/g, '');
  return (w.slice(0, 2) || n[0]).toUpperCase();
}
export const testamentName = bk => bk.test === 'OT' ? 'Old Testament' : 'New Testament';
/** Division slug for .hero[data-div]. */
export const divSlug = bk => bk.div === 'History' ? (bk.test === 'OT' ? 'ot-history' : 'nt-history') : String(bk.div).toLowerCase().replace(/\s+/g, '-');
export const trInfo = id => state.translations.find(t => t.id === id) || { id, abbr: String(id || '').toUpperCase(), name: String(id || '').toUpperCase(), licence: '', kind: 'bundled' };
/** "1D" -> "1 day", "3M10D" -> "3 months 10 days", "2.5Y" -> "2.5 years". */
export function fmtDur(d) {
  const s = String(d || '');
  const parts = [...s.matchAll(/(\d+(?:\.\d+)?)([DWMY])/g)];
  if (!parts.length || parts.map(p => p[0]).join('') !== s) return s;
  return parts.map(p => plural(+p[1], { D: 'day', W: 'week', M: 'month', Y: 'year' }[p[2]])).join(' ');
}
/** Parse "c. AD 85–95" or "c. 1440–1400 BC" into [from, to] years (BC negative). */
export function parseSpan(s) {
  if (!s) return null; const bc = /BC/i.test(s); const n = (String(s).match(/\d{2,4}/g) || []).map(Number);
  if (!n.length) return null; let a = n[0], z = n[1] ?? n[0]; if (bc) { a = -a; z = -z; }
  return [Math.min(a, z), Math.max(a, z)];
}
/** Keep date ranges and 'c. AD 50' together when a line wraps ('c. AD 50–' / '51'). Apply before esc(). */
export const nobreak = s => String(s || '').replace(/(\d)\s?–\s?(\d)/g, '$1⁠–⁠$2').replace(/\b(c\.|AD|BC)\s(?=\d|AD|BC)/g, '$1 ').replace(/(\d)\s(BC|AD)\b/g, '$1 $2');

// ------------------------------------------------------------ layout mode (CSS and JS agree: spec §3.2)
const MQ_SIDE = typeof matchMedia !== 'undefined' ? matchMedia('(min-width: 1100px)') : null;
const MQ_SHEET = typeof matchMedia !== 'undefined' ? matchMedia('(max-width: 699px)') : null;
export const RM = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
export const scrollBehavior = () => (RM.matches ? 'auto' : 'smooth');
/** 'side' (≥1100px, sheet pushes the page) · 'overlay' (700–1099px, modal) · 'sheet' (<700px, bottom sheet). */
export function layoutMode() { if (MQ_SIDE && MQ_SIDE.matches) return 'side'; if (MQ_SHEET && MQ_SHEET.matches) return 'sheet'; return 'overlay'; }
export function onLayoutChange(fn) { [MQ_SIDE, MQ_SHEET].forEach(q => q && q.addEventListener('change', fn)); }

// ------------------------------------------------------------ API (profiles-spec §5.2)
/**
 * JSON request to serve.py. Never throws. Resolves { ok, status, data } (+ offline: true on a network error,
 * dry: true when ?dry refused a write). Mutations carry Content-Type JSON and a JSON body ({} when empty);
 * scoped calls carry X-BS-Scope, and a 409 scope_mismatch or 401 not_signed_in on them fires 'bs:auth-lost' (as does a
 * hosted site's 401 sign_in_required for a profile's write).
 */
export async function api(method, url, body, { keepalive = false, scoped = true } = {}) {
  if (DRY && method !== 'GET') return { ok: false, status: 0, dry: true, data: null };
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') headers['Content-Type'] = 'application/json';
  if (scoped) headers['X-BS-Scope'] = state.auth.scope;
  let r;
  // a serve.py that never answers must not leave a dialog waiting forever
  const ctl = !keepalive && typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 30000) : 0;
  try {
    r = await fetch(url, { method, headers, credentials: 'same-origin', cache: 'no-store', keepalive: !!keepalive, signal: ctl ? ctl.signal : undefined, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  } catch (e) { clearTimeout(timer); return { ok: false, status: 0, offline: true, data: null }; }
  clearTimeout(timer);
  let data = null;
  try { const t = await r.text(); data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
  // hosted, a profile whose session ended is a guest to serve.py, so its writes get sign_in_required: the same loss
  if (scoped && data && ((r.status === 409 && data.error === 'scope_mismatch') || (r.status === 401 && (data.error === 'not_signed_in' || (data.error === 'sign_in_required' && headers['X-BS-Scope'] !== 'guest'))))) {
    document.dispatchEvent(new CustomEvent('bs:auth-lost', { detail: data }));
  }
  return { ok: r.ok, status: r.status, data };
}

// ------------------------------------------------------------ cross-tab sync (BroadcastChannel 'bs-sync')
let chan = null;
try { if (typeof BroadcastChannel !== 'undefined') chan = new BroadcastChannel('bs-sync'); } catch (e) { chan = null; }
/** Tell the other tabs of this browser (never this one). Messages: {t:'notes'|'library'|'auth'|'links'|'marks', scope, rev?}. */
export function broadcast(msg) { if (DRY || !chan) return; try { chan.postMessage(msg); } catch (e) { /* closed */ } }
export function onBroadcast(fn) { if (chan) chan.addEventListener('message', e => { try { fn(e.data || {}); } catch (err) { console.error(err); } }); }

// ------------------------------------------------------------ hosted mode (hosting brief §2)
/** A hosted site's guest reads everything and saves nothing (serve.py answers its writes with 401 sign_in_required).
 *  Locally never: there the guest saves as always. */
export const readOnlyGuest = () => !!(state.auth.hosted && !state.auth.signedIn);
export const SIGN_IN_MSG = 'Sign in to save your notes, links and highlights.';
/** A write refused because this tab is a hosted site's guest. */
export const signInRequired = r => !!(r && r.status === 401 && r.data && r.data.error === 'sign_in_required');
let signInPrompt = null;
/** account.js registers its calm prompt here (a toast with Sign in; no import cycle). */
export function setSignInPrompt(fn) { signInPrompt = typeof fn === 'function' ? fn : null; }
/** Every save checks this first: a hosted guest gets the prompt and nothing is changed or queued. True = stop. */
export function guestBlocked() {
  if (!readOnlyGuest()) return false;
  try { signInPrompt?.(); } catch (e) { console.error(e); }
  return true;
}

/** account.js registers refreshAuth() here (no import cycle): used when /api/notes answers for another scope. */
let authRefresher = null;
export function setAuthRefresher(fn) { authRefresher = typeof fn === 'function' ? fn : null; }

// ------------------------------------------------------------ notes persistence: per-key changes (profiles-spec §2.4, §5.2)
const NOTES_KEY = 'bs-notes-v1', DIRTY_KEY = 'bs-notes-dirty-v1';
const HIGHLIGHTS = new Set(['', 'yellow', 'green', 'blue', 'pink', 'orange']);
const REF_RX = /^[1-9]\d?\.[1-9]\d{0,2}(\.[1-9]\d{0,2})?$/;
const MAX_KEYS_PER_REQUEST = 2000, MAX_BODY = 1800000, KEEPALIVE_MAX = 32000;
let saveTimer = 0, retryTimer = 0, retryDelay = 0;
let dirty = new Map();   // key -> { op: 'set' | 'del', ts, seq, b? }  b = the server version this edit started from (absent: unknown)
let seq = 0;
let notesScope = 'guest'; // whose notes state.notes, dirty and noteBase hold
let baseKnown = false;    // a GET /api/notes succeeded for notesScope, so a key missing from noteBase means "the server has none"
let flushP = null, followP = null, notesStale = false, lifecycleBound = false;

const readJSON = (key, fb) => { try { const v = lsGet(key); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };
const noteUpdated = n => (n && Number.isFinite(+n.updated) ? Math.round(+n.updated) : 0);
function normalizeNotes(n) { return { refs: (n && n.refs && typeof n.refs === 'object' && !Array.isArray(n.refs)) ? n.refs : {}, studies: (n && Array.isArray(n.studies)) ? n.studies : [] }; }
const isEmptyNote = n => !n || (!n.text && !n.highlight && !(n.tags || []).length && !(n.videos || []).length);

/** Canonical note key ("43.03.16" -> "43.3.16"), range-checked against meta when it is loaded; null when invalid. */
export function canonicalKey(k) {
  const p = String(k || '').split('.');
  if (p.length < 2 || p.length > 3 || p.some(x => !/^\d{1,3}$/.test(x))) return null;
  const [b, c, v] = p.map(Number);
  if (p.length === 3 && !v) return null;
  const key = v ? `${b}.${c}.${v}` : `${b}.${c}`;
  if (!REF_RX.test(key)) return null;
  const bk = state.books[b - 1];
  if (state.books.length && (!bk || c > bk.chapters.length || (v && v > bk.chapters[c - 1]))) return null;
  return key;
}

// Several tabs of one scope share these keys. Each dirty entry records the tab that owns it, and every write merges:
// a tab replaces only its own entries, so another tab's unsent edit (and its text in the mirror) is never dropped.
const TAB = Math.random().toString(36).slice(2, 12);
// Stored entries this page has already taken into its own queue (readDirty). They are this page's now: once sent they
// must not be copied back from storage, or a closed page's edit would be re-sent (and, with no note left, deleted).
const adopted = new Set();
const entrySig = (k, e) => `${k}|${e && e.ts}|${(e && e.tab) || ''}`;
function mirror() {
  if (DRY) return;
  const key = lsKey(NOTES_KEY, notesScope);
  if (state.auth.hosted && notesScope === 'guest') { lsDel(key); return; } // a hosted guest's notes never stay in this browser
  let out = state.notes;
  const stored = readJSON(key, null), dk = readJSON(lsKey(DIRTY_KEY, notesScope), null);
  if (stored && stored.refs && typeof stored.refs === 'object' && dk && dk.d && typeof dk.d === 'object') {
    const keep = {};
    for (const [k, e] of Object.entries(dk.d)) {
      const theirs = stored.refs[k], mine = state.notes.refs[k];
      if (e && e.tab && e.tab !== TAB && e.op === 'set' && theirs && !(mine && (+mine.updated || 0) >= (+theirs.updated || 0))) keep[k] = theirs;
    }
    if (Object.keys(keep).length) out = { ...state.notes, refs: { ...state.notes.refs, ...keep } };
  }
  lsSet(key, JSON.stringify(out));
}
function persistDirty(scope = notesScope, map = dirty) {
  if (DRY) return;
  const key = lsKey(DIRTY_KEY, scope), stored = readJSON(key, null), d = {};
  if (state.auth.hosted && scope === 'guest') { lsDel(key); return; }
  if (stored && stored.d && typeof stored.d === 'object') {
    for (const [k, e] of Object.entries(stored.d)) {
      if (!e || !e.tab || e.tab === TAB || adopted.has(entrySig(k, e))) continue;   // mine (written or adopted): the map below has them
      if (map.has(k) && (+map.get(k).ts || 0) >= (+e.ts || 0)) continue;  // superseded by my newer edit
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
      if (!REF_RX.test(k) || !e || (e.op !== 'set' && e.op !== 'del')) continue;
      adopted.add(entrySig(k, e));
      const x = { op: e.op, ts: Number.isFinite(+e.ts) ? Math.round(+e.ts) : Date.now(), seq: Number.isFinite(+e.seq) ? +e.seq : 0 };
      if (e.b === null || Number.isFinite(e.b)) x.b = e.b;
      m.set(k, x);
    }
    if (Number.isFinite(+p.seq)) seq = Math.max(seq, +p.seq);
  }
  return m;
}
function markDirty(key, op, ts) {
  const prev = dirty.get(key);
  const b = prev ? prev.b : (state.noteBase.has(key) ? state.noteBase.get(key) : (baseKnown ? null : undefined));
  const e = { op, ts, seq: ++seq };
  if (b !== undefined) e.b = b;
  dirty.set(key, e);
}
/** True when a string anywhere in x (keys included) holds a lone surrogate, which serve.py refuses as bad_json. */
const illFormed = x => typeof x === 'string' ? wellFormed(x) !== x
  : !!x && typeof x === 'object' && Object.entries(x).some(([k, v]) => illFormed(k) || illFormed(v));
/** A copy that passes the server's note validation (unknown fields are kept). */
function wireNote(n) {
  const o = { ...n };
  o.text = typeof n.text === 'string' ? cut(n.text, 100000) : '';
  o.highlight = HIGHLIGHTS.has(n.highlight) ? n.highlight : '';
  o.tags = (Array.isArray(n.tags) ? n.tags : []).filter(t => typeof t === 'string' && t).map(t => cut(t, 64)).slice(0, 50);
  o.videos = (Array.isArray(n.videos) ? n.videos : []).filter(v => v && typeof v === 'object' && typeof v.url === 'string').slice(0, 100).map(v => {
    const w = { ...v, url: cut(v.url, 2048) };
    if (w.id != null && typeof w.id !== 'string') w.id = String(w.id);
    if (typeof w.id === 'string') w.id = cut(w.id, 64);
    if (w.start != null) w.start = Math.max(0, Math.floor(+w.start || 0));
    if (w.title != null) w.title = cut(w.title, 300);
    if (w.added != null && !Number.isFinite(+w.added)) delete w.added;
    for (const k in w) if (typeof w[k] === 'string') w[k] = wellFormed(w[k]);
    return w;
  });
  for (const k in o) if (typeof o[k] === 'string') o[k] = wellFormed(o[k]);   // e.g. an imported note's own fields
  o.updated = noteUpdated(n) || Date.now();
  o.created = Number.isFinite(+n.created) && +n.created > 0 ? Math.round(+n.created) : o.updated;
  return o;
}
/** bs:notes-replaced {keys, reason: 'refresh' | 'conflict' | 'restore', mine?, scope?}. For a conflict, `mine` holds
 *  this window's losing version of each key (null = it deleted the note), so the UI can offer to keep it. */
const notifyReplaced = (keys, reason, extra) => {
  if (!keys.length) return;
  document.dispatchEvent(new CustomEvent('notes-changed'));
  document.dispatchEvent(new CustomEvent('bs:notes-replaced', { detail: { keys, reason, ...(extra || {}) } }));
};
const noteContent = n => (isEmptyNote(n) ? '' : JSON.stringify([n.text || '', n.highlight || '', n.tags || [], n.videos || []]));
/** True when two notes differ in what the user sees (text, highlight, tags, videos). */
export const notesDiffer = (a, b) => noteContent(a) !== noteContent(b);

/** Switch the in-memory notes to a scope: its browser mirror, its unsent changes and no server knowledge yet. */
function switchNotesScope(scope) {
  clearTimeout(saveTimer); saveTimer = 0; clearTimeout(retryTimer); retryTimer = 0; retryDelay = 0;
  notesScope = scope;
  baseKnown = false;
  state.noteBase = new Map();
  state.notesRev = 0;
  dirty = readDirty(scope);
  state.notes = normalizeNotes(readJSON(lsKey(NOTES_KEY, scope), null));
  // unsent edits carry their own base; nothing else is known until GET /api/notes answers
  for (const [k, e] of dirty) if (e.b !== undefined) state.noteBase.set(k, e.b);
}

/**
 * Load the current scope's notes. Unsent changes from an earlier visit are sent first; then the server copy
 * replaces the browser mirror (unsent edits stay on top). Without a server the mirror is used, as before.
 */
export async function loadNotes() {
  const scope = state.auth.scope;
  switchNotesScope(scope);
  if (readOnlyGuest() && dirty.size) { dirty.clear(); persistDirty(); } // nothing a hosted guest typed is ever sent
  if (dirty.size && !DRY && !state.auth.lost) { try { await flushNotes(); } catch (e) { console.error(e); } }
  if (scope !== state.auth.scope || scope !== notesScope) return;
  const r = await api('GET', '/api/notes', null, { scoped: false });
  if (scope !== state.auth.scope || scope !== notesScope) return;
  if (!(r.ok && r.data && r.data.refs && typeof r.data.refs === 'object')) { state.serverOk = false; return; }
  state.serverOk = true;
  const legacy = !('rev' in r.data);
  if (legacy) {
    // a serve.py from before profiles: guest notes only, whole-object PUT
    state.auth.legacy = true;
    if (scope !== 'guest') { state.auth.scope = 'guest'; switchNotesScope('guest'); }
  } else if (r.data.scope && r.data.scope !== scope) {
    // the server answered for someone else (signed out or in elsewhere): keep the mirror, let account.js switch
    if (authRefresher) Promise.resolve().then(() => authRefresher({ reason: 'drift' })).catch(e => console.error(e));
    return;
  }
  const srv = normalizeNotes(r.data);
  for (const [k, e] of dirty) {
    if (e.op === 'set' && state.notes.refs[k]) srv.refs[k] = state.notes.refs[k];
    else if (e.op === 'del') delete srv.refs[k];
  }
  state.notes = srv;
  state.notesRev = Number.isFinite(+r.data.rev) ? +r.data.rev : 0;
  for (const [k, n] of Object.entries(r.data.refs)) if (!dirty.has(k)) state.noteBase.set(k, noteUpdated(n));
  baseKnown = true;
  mirror();
}

/** Take the server's version of every note without unsent local changes (another tab saved). */
export async function refreshNotes() {
  const scope = notesScope;
  if (scope !== state.auth.scope) return false;
  const r = await api('GET', '/api/notes', null, { scoped: false });
  if (scope !== notesScope || scope !== state.auth.scope) return false;
  if (!(r.ok && r.data && r.data.refs && typeof r.data.refs === 'object')) return false;
  if ('rev' in r.data && r.data.scope && r.data.scope !== scope) { if (authRefresher) authRefresher({ reason: 'drift' }); return false; }
  const srv = r.data.refs, changed = [];
  for (const [k, n] of Object.entries(srv)) {
    if (dirty.has(k)) continue;
    const cur = state.notes.refs[k];
    if (!cur || JSON.stringify(cur) !== JSON.stringify(n)) { state.notes.refs[k] = n; changed.push(k); }
    state.noteBase.set(k, noteUpdated(n));
  }
  for (const k of Object.keys(state.notes.refs)) {
    if (k in srv || dirty.has(k)) continue;
    const had = !isEmptyNote(state.notes.refs[k]);
    delete state.notes.refs[k]; state.noteBase.set(k, null);
    if (had) changed.push(k);
  }
  if (Array.isArray(r.data.studies)) state.notes.studies = r.data.studies;
  if (Number.isFinite(+r.data.rev)) state.notesRev = +r.data.rev;
  baseKnown = true;
  mirror();
  notifyReplaced(changed, 'refresh');
  return true;
}

/**
 * Send every unsent change: POST /api/notes/changes with compare-and-set bases. Resolves { pending }
 * (0 = everything is on the server). A second call while one is in flight runs once more afterwards.
 */
export function flushNotes(opts = {}) {
  if (!flushP) { flushP = doFlush(opts).catch(e => { console.error(e); return { pending: dirty.size }; }).finally(() => { flushP = null; }); return flushP; }
  if (!followP) followP = flushP.then(() => { followP = null; return dirty.size ? flushNotes(opts) : { pending: 0 }; });
  return followP;
}

async function doFlush({ keepalive = false } = {}) {
  clearTimeout(saveTimer); saveTimer = 0;
  clearTimeout(retryTimer); retryTimer = 0;
  const scope = notesScope;
  if (DRY) { setSaveStatus('dry'); return { pending: dirty.size }; }
  if (scope !== state.auth.scope) return { pending: dirty.size };
  if (!dirty.size) { if (isSaving()) setSaveStatus('saved'); return { pending: 0 }; }
  if (state.auth.lost) { setSaveStatus('signedout'); return { pending: dirty.size }; } // paused until the profile signs in again
  if (readOnlyGuest()) { dropGuestEdits(); return { pending: 0 }; }
  if (state.auth.legacy) return legacyFlush(keepalive);

  // a 'set' whose note is no longer here (its text was lost with a mirror) is never sent as a delete: drop it
  for (const [k, e] of [...dirty]) if (e.op === 'set' && !state.notes.refs[k]) dirty.delete(k);
  const snap = new Map([...dirty].map(([k, e]) => [k, { ...e }]));
  const keys = [...snap.keys()];
  let lost = [], changed = false, stale = false, retried = false;
  const mine = {}; // this window's version of each conflicted key, before the server's replaces it
  for (let i = 0; i < keys.length;) {
    // chunk by key count and body size
    const set = {}, del = {}, base = {};
    let size = 60, n = 0;
    for (; i < keys.length && n < MAX_KEYS_PER_REQUEST; i++, n++) {
      const k = keys[i], e = snap.get(k), note = state.notes.refs[k];
      let part;
      if (e.op === 'set' && note) { set[k] = wireNote(note); part = JSON.stringify(set[k]).length; }
      else { del[k] = e.ts; part = 24; }
      if (e.b !== undefined) base[k] = e.b;
      size += part + k.length + 24;
      if (size > MAX_BODY && n > 0) { delete set[k]; delete del[k]; delete base[k]; break; }
    }
    const body = { baseRev: state.notesRev, set, del, base };
    const ka = !!keepalive && JSON.stringify(body).length <= KEEPALIVE_MAX;
    const r = await api('POST', '/api/notes/changes', body, { keepalive: ka });
    if (scope !== notesScope) { if (r.ok) settleOtherScope(scope, snap, r.data); return { pending: 0 }; }
    if (!r.ok) {
      persistDirty(); mirror(); // earlier chunks may have landed
      if (r.dry) { setSaveStatus('dry'); return { pending: dirty.size }; }
      const err = r.data && r.data.error;
      if (r.status === 400 && err === 'invalid_note' && r.data.field && dirty.has(r.data.field) && !retried) {
        // one note the server refuses must not block every other save: keep it in this browser only
        console.error('serve.py refused the note', r.data.field, r.data.message || '');
        dirty.delete(r.data.field); persistDirty(); retried = true;
        return doFlush({ keepalive });
      }
      if (r.status === 400 && err === 'bad_json' && !retried) {
        // serve.py could not decode the body (text that is not valid Unicode, e.g. half an emoji in a field
        // wireNote does not know): keep those notes in this browser only rather than resending them forever
        const bad = [...Object.keys(set), ...Object.keys(del)].filter(k => illFormed(k) || illFormed(set[k]));
        if (bad.length) {
          console.error('serve.py could not read the notes', bad, r.data.message || '');
          for (const k of bad) dirty.delete(k);
          persistDirty(); retried = true;
          return doFlush({ keepalive });
        }
      }
      if (signInRequired(r) && scope === 'guest') { state.auth.hosted = true; guestBlocked(); dropGuestEdits(); return { pending: 0 }; } // never retried
      const signedOut = r.status === 401 || (r.status === 409 && err === 'scope_mismatch');
      setSaveStatus(signedOut ? 'signedout' : r.offline && !state.serverOk ? 'local' : 'failed');
      if (!(r.status === 409 || r.status === 401)) scheduleRetry(); // auth problems wait for account.js
      return { pending: dirty.size };
    }
    const d = r.data || {};
    if (Number.isFinite(+d.rev)) state.notesRev = +d.rev;
    changed = changed || !!d.changed;
    stale = stale || !!d.stale;
    for (const [k, v] of Object.entries(d.versions || {})) {
      const ver = v === null ? null : noteUpdated({ updated: v });
      state.noteBase.set(k, ver);
      const cur = dirty.get(k);
      if (cur && cur.seq === snap.get(k)?.seq) dirty.delete(k);
      else if (cur) cur.b = ver;
    }
    for (const [k, c] of Object.entries(d.conflicts || {})) {
      const theirs = c && typeof c === 'object' ? c : null;
      const ver = theirs ? noteUpdated(theirs) : null;
      state.noteBase.set(k, ver);
      const cur = dirty.get(k);
      if (cur && cur.seq === snap.get(k)?.seq) {
        dirty.delete(k);
        const own = state.notes.refs[k];
        try { mine[k] = own && !isEmptyNote(own) ? JSON.parse(JSON.stringify(own)) : null; } catch (e) { mine[k] = null; }
        if (theirs) state.notes.refs[k] = theirs; else delete state.notes.refs[k];
        lost.push(k);
      } else if (cur) cur.b = ver; // edited again meanwhile: the newest local edit is sent over the newer version
    }
  }
  retryDelay = 0;
  persistDirty(); mirror();
  if (lost.length) notifyReplaced(lost, 'conflict', { mine, scope });
  if (changed) broadcast({ t: 'notes', scope, rev: state.notesRev });
  if (stale && baseKnown) refreshNotes();
  // entries left over were edited while the request was in flight: their own save timer (or the queued
  // follow-up flush) sends them; one the server did not answer for is retried later
  const unanswered = [...dirty].some(([k, e]) => snap.get(k)?.seq === e.seq);
  if (unanswered) scheduleRetry();
  setSaveStatus(dirty.size ? (unanswered ? 'failed' : 'saving') : 'saved');
  if (dirty.size && !unanswered && !saveTimer && !followP) saveTimer = setTimeout(() => { saveTimer = 0; flushNotes(); }, 700);
  return { pending: dirty.size };
}

/** A pre-profiles serve.py: replace the whole notes object (today's behaviour). */
async function legacyFlush(keepalive) {
  const snap = new Map([...dirty].map(([k, e]) => [k, e.seq]));
  const body = { refs: state.notes.refs, studies: state.notes.studies };
  const ka = !!keepalive && JSON.stringify(body).length <= KEEPALIVE_MAX;
  const r = await api('PUT', '/api/notes', body, { scoped: false, keepalive: ka });
  if (!r.ok) { if (r.dry) { setSaveStatus('dry'); return { pending: dirty.size }; } setSaveStatus(r.offline && !state.serverOk ? 'local' : 'failed'); scheduleRetry(); return { pending: dirty.size }; }
  for (const [k, s] of snap) if (dirty.get(k)?.seq === s) dirty.delete(k);
  persistDirty();
  setSaveStatus('saved');
  return { pending: dirty.size };
}

/** A hosted guest's edits (only if one got past guestBlocked): dropped, and the server's notes shown again. */
function dropGuestEdits() {
  dirty.clear(); persistDirty(); mirror();
  setSaveStatus('');
  refreshNotes();
}

/** A flush that finished after this tab switched profiles: clear the sent keys from that profile's stored queue. */
function settleOtherScope(scope, snap, d) {
  const m = readDirty(scope);
  const done = new Set([...Object.keys((d && d.versions) || {}), ...Object.keys((d && d.conflicts) || {})]);
  for (const k of done) if (m.get(k)?.seq === snap.get(k)?.seq) m.delete(k);
  persistDirty(scope, m);
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryDelay = Math.min(300000, retryDelay ? retryDelay * 2 : 30000);
  retryTimer = setTimeout(() => { retryTimer = 0; if (dirty.size) flushNotes(); }, retryDelay);
}
const isSaving = () => /Saving/.test(document.getElementById('save-status')?.textContent || '');

export function noteFor(key, create = false) {
  let n = state.notes.refs[key];
  if (!n && create) { n = state.notes.refs[key] = { text: '', highlight: '', tags: [], videos: [], created: Date.now(), updated: Date.now() }; }
  if (n && create) { if (!Array.isArray(n.tags)) n.tags = []; if (!Array.isArray(n.videos)) n.videos = []; }
  return n;
}
/** Record an edit: bump `updated`, drop the note when empty, queue it for the server, tell listeners. */
export function touchNote(key) {
  if (guestBlocked()) { refreshNotes(); return; } // the callers ask first; this puts back an edit that slipped through
  const n = state.notes.refs[key]; if (!n) return;
  n.updated = Date.now();
  if (isEmptyNote(n)) delete state.notes.refs[key];
  const note = state.notes.refs[key];
  markDirty(key, note ? 'set' : 'del', note ? note.updated : Date.now());
  document.dispatchEvent(new CustomEvent('bs:note-saved', { detail: { key, deleted: !note } }));
  scheduleSave();
}
/** Mirror to this browser now; send the queued changes 700 ms after the last edit. */
export function scheduleSave() {
  mirror();
  persistDirty();
  document.dispatchEvent(new CustomEvent('notes-changed'));
  clearTimeout(saveTimer);
  setSaveStatus('saving');
  if (DRY) { saveTimer = setTimeout(() => setSaveStatus('dry'), 500); return; }
  saveTimer = setTimeout(() => { saveTimer = 0; flushNotes(); }, 700);
}
/** Import notes (drawer "Import JSON"): each becomes a fresh edit, queued like any other. Returns how many. */
export function importNotes(refs) {
  if (!refs || typeof refs !== 'object') return 0;
  const now = Date.now(); let n = 0;
  for (const [k0, v] of Object.entries(refs)) {
    const k = canonicalKey(k0);
    if (!k || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    // within the server's limits here already, so what is shown is what is saved (wireNote would cut it silently)
    const note = { ...wireNote(v), updated: now };
    if (isEmptyNote(note)) continue;
    if (!(note.created > 0)) note.created = now;
    state.notes.refs[k] = note;
    markDirty(k, 'set', now);
    n++;
  }
  if (n) scheduleSave();
  return n;
}
/**
 * "Keep mine" after a conflict: put this window's versions back (from bs:notes-replaced detail.mine) as fresh
 * edits over the server's newer ones (their version is the new base, so the save goes through). Returns how many.
 */
export function restoreNotes(mine, scope = notesScope) {
  if (!mine || typeof mine !== 'object' || scope !== notesScope || scope !== state.auth.scope) return 0;
  const keys = [], now = Date.now();
  for (const [k, n] of Object.entries(mine)) {
    if (!REF_RX.test(k) || !notesDiffer(n, state.notes.refs[k])) continue;
    if (n && typeof n === 'object' && !isEmptyNote(n)) {
      state.notes.refs[k] = { ...n, tags: Array.isArray(n.tags) ? [...n.tags] : [], videos: Array.isArray(n.videos) ? n.videos.map(v => ({ ...v })) : [], updated: now };
      markDirty(k, 'set', now);
    } else {
      delete state.notes.refs[k];
      markDirty(k, 'del', now);
    }
    keys.push(k);
    document.dispatchEvent(new CustomEvent('bs:note-saved', { detail: { key: k, deleted: !state.notes.refs[k] } }));
  }
  if (!keys.length) return 0;
  scheduleSave();
  notifyReplaced(keys, 'restore');
  return keys.length;
}
/** Save on hide/close (keepalive), refresh when another tab saved notes for this profile. Idempotent. */
export function bindNotesLifecycle() {
  if (lifecycleBound || typeof document === 'undefined') return;
  lifecycleBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (dirty.size && !DRY) flushNotes({ keepalive: true }); }
    else if (notesStale) { notesStale = false; refreshNotes(); }
  });
  window.addEventListener('pagehide', () => { if (dirty.size && !DRY) flushNotes({ keepalive: true }); });
  window.addEventListener('online', () => { if (dirty.size && !DRY) flushNotes(); });
  onBroadcast(m => {
    if (m.t !== 'notes' || m.scope !== state.auth.scope || state.auth.legacy) return;
    if (Number.isFinite(m.rev) && m.rev <= state.notesRev) return;
    if (document.visibilityState === 'visible') refreshNotes(); else notesStale = true;
  });
}
/** Unsent note changes for the current scope (0 = all saved). */
export const pendingNotes = () => dirty.size;

/** Other per-scope stores with their own queue (links.js, marks.js): sent with the notes before an export or a sign-out. */
const savers = new Map(); // name -> { flush: () => Promise<{pending}>, pending: () => number }
export function registerSaver(name, s) { if (s && typeof s.flush === 'function') savers.set(name, s); }
/** Send every registered store's unsent changes. Resolves { pending } (0 = all on the server). */
export async function flushSavers() {
  let pending = 0;
  for (const s of savers.values()) { try { const r = await s.flush(); pending += (r && r.pending) || 0; } catch (e) { console.error(e); } }
  return { pending };
}
export const pendingSavers = () => [...savers.values()].reduce((n, s) => n + ((typeof s.pending === 'function' && +s.pending()) || 0), 0);

/**
 * Download the Obsidian zip. serve.py builds it from what it has saved, so unsent note edits go first. Never
 * navigates away (an error answer must not replace the app). Resolves { ok, pending } or { ok: false, dry | lost |
 * mismatch | offline | status, data }: the caller says why (account.js already does for a mismatch).
 */
export async function exportObsidian() {
  if (DRY) return { ok: false, dry: true };
  // the route answers for whoever is signed in now (the guest, after a lost sign-in)
  if (state.auth.signedIn && state.auth.lost) return { ok: false, lost: true };
  let { pending = dirty.size } = await flushNotes();
  pending += (await flushSavers()).pending; // the zip's Connections.md comes from the saved links
  if (state.auth.signedIn && state.auth.lost) return { ok: false, lost: true };
  let r;
  try { r = await fetch('/api/export/obsidian', { credentials: 'same-origin', cache: 'no-store' }); } catch (e) { return { ok: false, offline: true }; }
  if (!r.ok) { let data = null; try { data = await r.json(); } catch (e) { /* not JSON */ } return { ok: false, status: r.status, data }; }
  const sc = r.headers.get('X-BS-Scope');
  if (sc && sc !== state.auth.scope) { // another window signed in or out: that profile's notes, not this one's
    document.dispatchEvent(new CustomEvent('bs:auth-lost', { detail: { error: 'scope_mismatch', scope: sc } })); // account.js tells the user
    return { ok: false, mismatch: true };
  }
  const m = /filename="?([^";]+)"?/i.exec(r.headers.get('Content-Disposition') || '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await r.blob()); a.download = m ? m[1] : 'bible-study-notes.zip';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  return { ok: true, pending };
}

/** Save status in the sheet header: 'saving' | 'saved' | 'local' | 'dry' | 'failed' | 'signedout' (legacy strings accepted). */
let idleTimer = null;
export function setSaveStatus(kind) {
  const el = document.getElementById('save-status'); if (!el) return;
  const k = String(kind || '');
  const norm = /signed\s*out/i.test(k) ? 'signedout' : /fail/i.test(k) ? 'failed' : /saving/i.test(k) ? 'saving' : /dry/i.test(k) ? 'dry' : /local/i.test(k) ? 'local' : k ? 'saved' : '';
  clearTimeout(idleTimer);
  el.classList.remove('idle', 'warn');
  el.removeAttribute('title');
  if (!norm) { el.textContent = ''; return; }
  if (norm === 'saving') { el.textContent = 'Saving…'; return; }
  if (norm === 'failed') { el.innerHTML = `${icon('info')}Save failed`; el.classList.add('warn'); el.title = 'Could not reach serve.py. Your notes are kept in this browser until it is running again.'; return; }
  if (norm === 'signedout') {   // serve.py answered: the session expired or was revoked, so signing in again is the fix
    const who = state.auth.user && state.auth.user.name;
    el.innerHTML = `${icon('info')}Not saved`; el.classList.add('warn');
    el.title = `You’ve been signed out${who ? ` of ${who}` : ''}. Sign in again to save. Your notes are kept in this browser until then.`;
    return;
  }
  const label = norm === 'dry' ? 'Saved (dry run)' : norm === 'local' ? 'Saved in this browser' : 'Saved';
  el.innerHTML = `${icon('check')}${label}`;
  if (norm === 'dry') el.title = 'Dry run: nothing is written to disk or to this browser.';
  idleTimer = setTimeout(() => el.classList.add('idle'), 2600);
}

export async function loadConfig() {
  try { const r = await fetch('/api/config'); if (r.ok) state.apiKeys = await r.json(); } catch (e) { /* offline */ }
}

/** PUT /api/config. Refuses in dry-run (returns null without any request). */
export async function saveConfig(body) {
  if (DRY) return null;
  const r = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status}`);
  state.apiKeys = await r.json();
  return state.apiKeys;
}
