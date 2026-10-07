// The Library (.design/profiles-spec.md §5.10) and the client model of the reader's library: bookmarks,
// read marks, time and verses studied, the last position and the activity log. The reader, the study
// sheet and the picker read it through bookmarkFor / chapterState / bookProgress; tracker.js feeds it
// through applyLocal so every signal shows at once, before the server has seen it.
import { state, bookOf, esc, previewText, clip, plural, divSlug, DRY, lsGet, lsSet, RM, cut } from './store.js';
import * as S from './store.js';
import * as ui from './ui.js';
import { icon } from './icons.js';
import { radioKeys, setRadio, placeInd } from './drawer.js';

// tracker.js is optional (main.js and account.js load it guarded): a broken one must not break the Library.
let tracker = null;
import('./tracker.js').then(m => { tracker = m; }, e => { console.error('tracker.js failed to load', e); });
// My links (links-spec §3.7): the home section, the stats tile and My map. Optional, like tracker.js (links.js loads library.js the same way).
let lnk = null;
import('./links.js').then(m => { lnk = m; linksVer++; if (libOpen()) scheduleRender(); }, e => { console.error('links.js failed to load', e); });
// Highlights and comments (annotations-brief §3.4): the activity rows' words and the stats tile. Optional likewise.
let mrk = null;
import('./marks.js').then(m => { mrk = m; if (libOpen()) scheduleRender(); }, e => { console.error('marks.js failed to load', e); });
const LOCAL_TAB = Math.random().toString(16).slice(2, 18);
/** This tab's id on 'bs-sync' (tracker.js's when it is loaded, so both modules tag messages alike). */
const tabId = () => (tracker && typeof tracker.TAB_ID === 'string' ? tracker.TAB_ID : LOCAL_TAB);

export const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
const TOTAL = 1189;
const OFFLINE_MSG = 'Can’t reach serve.py. Try again when it’s running.';
const DRY_MSG = 'Dry run: nothing is saved.';
const SWITCHED_MSG = 'The profile changed in another window, so nothing was changed.';
const LEGACY_MSG = 'Restart serve.py to turn on bookmarks and reading progress.';
/** A pre-profiles serve.py is running: it has no library to write to. */
const legacy = () => !!(state.auth && state.auth.legacy);
const SKELETON = '<div class="skeleton" aria-busy="true"><i style="width:62%"></i><i style="width:88%"></i><i style="width:74%"></i><i style="width:80%"></i><i style="width:46%"></i></div>';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const lib = { loaded: false, scope: null, rev: 0, bookmarks: [], lastPosition: null, chapters: {}, stats: null, activity: [], activityTotal: 0, offline: false, fetchedAt: 0 };

let A = null, inited = false;
let base = null;                 // day-based stats as the server computed them at the last load
let dayAdd = {};                 // what happened here since then, per local day: {s, v, r, n, o}
let bmIndex = new Map();         // ref -> bookmark
const inflight = new Map();      // ref -> {op:'add', bm} | {op:'del'}: writes a reload must not undo on screen
const marksInflight = new Map(); // 'b.c' -> {read, readAt, manualAt} (manual read marks being saved)
let loadSeq = 0, refreshT = 0, stale = false, activityWanted = 50;
let held = false;                // the last load was answered for another scope and refused: what is shown is kept
let view = { name: 'home' }, marking = false, showAllBms = false, focusBm = null, homeScroll = 0;
let studiedAll = 0;              // the book whose studied verses are all shown (the first STUDIED_MAX otherwise)
const STUDIED_MAX = 60;
let chan = null;
let linksVer = 0;                // bumped on bs:links-changed: My map rebuilds its graph when it differs
const linkAdds = [];             // optimistic link.add and mark.add entries (links.js saveLink, marks.js saveMark) the server's activity has not shown yet

// ------------------------------------------------------------ small helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const curScope = () => (state.auth && state.auth.scope) || 'guest';
const toast = (msg, action) => { if (A && typeof A.toast === 'function') A.toast(msg, action); };
const pad = n => String(n).padStart(2, '0');
const fn = name => (typeof ui[name] === 'function' ? ui[name] : null);
export const localDay = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const parseDay = s => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(); };
const dayDiff = (a, b) => Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()) - new Date(b.getFullYear(), b.getMonth(), b.getDate())) / 86400000);
const cssEsc = s => (window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'));
const libDialog = () => document.getElementById('library');
const libOpen = () => { const d = libDialog(); return !!(d && d.open && !d.classList.contains('closing')); };

/**
 * Whole minutes, rounded to the nearest one: the server rounds each day of minutes90 the same way, so the
 * time cards and the 90-day chart agree. Every duration in the Library goes through this.
 */
const roundMin = sec => Math.round(Math.max(0, +sec || 0) / 60);
function fmtDuration(sec) {
  sec = Math.max(0, +sec || 0);
  if (!sec) return '0 min';
  const M = roundMin(sec);
  if (!M) return 'under 1 min';
  if (M < 60) return `${M} min`;
  const h = Math.floor(M / 60), m = M % 60; return `${h.toLocaleString()} h${m ? ` ${m} min` : ''}`;
}
function relTime(t) {
  const f = fn('relTime'); if (f) return f(t);
  const d = new Date(+t), diff = Date.now() - d; if (!+t) return '';
  if (diff < 60000) return 'Just now'; if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  const days = dayDiff(new Date(), d);
  if (days <= 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); if (days === 1) return 'Yesterday';
  return `${d.getDate()} ${MON[d.getMonth()]}`;
}
function dayLabel(day) {
  const f = fn('dayLabel'); if (f) return f(day);
  const d = parseDay(day), n = dayDiff(new Date(), d);
  return n === 0 ? 'Today' : n === 1 ? 'Yesterday' : `${d.getDate()} ${MONTH[d.getMonth()]}`;
}
/** Short age for list trails: now · 5 min · 3 h · 2 d · 6 w · 2 y. */
function shortAge(t) {
  const s = Math.max(0, (Date.now() - (+t || 0)) / 1000);
  if (s < 60) return 'now'; if (s < 3600) return `${Math.floor(s / 60)} min`; if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d`; if (s < 86400 * 365) return `${Math.floor(s / 604800)} w`; return `${Math.floor(s / 31536000)} y`;
}
const dm = d => `${d.getDate()} ${MON[d.getMonth()]}`;
/** "John 3:16", "Psalm 23", "John". */
export function refName(b, c = 0, v = 0) {
  const bk = bookOf(b); if (!bk) return '';
  if (!c) return bk.name;
  return `${bk.name === 'Psalms' ? 'Psalm' : bk.name} ${c}${v ? ':' + v : ''}`;
}
function parseRef(ref) {
  if (typeof ref !== 'string' || !/^[1-9]\d?(\.[1-9]\d{0,2}){0,2}$/.test(ref)) return null;
  const [b, c = 0, v = 0] = ref.split('.').map(Number), bk = bookOf(b);
  if (!bk || c > bk.chapters.length || (c && v > bk.chapters[c - 1])) return null;
  return { b, c, v };
}
const refOf = (b, c, v) => (v ? `${b}.${c}.${v}` : `${b}.${c}`);
const newChapter = () => ({ firstRead: null, lastRead: null, visits: 0, seconds: 0, studied: [], read: false, readAt: null, manual: false, manualAt: null });
const bmRef = bm => refName(bm.b, bm.c, bm.v);
const sortBookmarks = () => lib.bookmarks.sort((a, z) => (z.created || 0) - (a.created || 0));
function reindex() { bmIndex = new Map(lib.bookmarks.map(x => [x.ref, x])); }

// ------------------------------------------------------------ server calls
async function call(method, url, body, opts = {}) {
  if (typeof S.api === 'function') {
    try { return await S.api(method, url, body, opts); } catch (e) { console.error(e); return { ok: false, status: 0, offline: true, data: null }; }
  }
  if (DRY && method !== 'GET') return { ok: false, status: 0, dry: true, data: null };
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') headers['Content-Type'] = 'application/json';
  if (opts.scoped !== false) headers['X-BS-Scope'] = curScope();
  try {
    const r = await fetch(url, { method, headers, credentials: 'same-origin', keepalive: !!opts.keepalive, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    let data = null; try { data = await r.json(); } catch (e) { /* no JSON */ }
    if (!r.ok && ((r.status === 409 && data?.error === 'scope_mismatch') || (r.status === 401 && data?.error === 'not_signed_in'))) document.dispatchEvent(new CustomEvent('bs:auth-lost', { detail: data }));
    return { ok: r.ok, status: r.status, data };
  } catch (e) { return { ok: false, status: 0, offline: true, data: null }; }
}
/** This profile's session ended elsewhere (account.js markLost): writes would only be refused. */
const lostNow = () => !DRY && !!(state.auth && state.auth.signedIn && state.auth.lost);
/** The same message and 'Sign in' action account.js shows when it first notices a lost sign-in. */
function lostToast(why) {
  const u = (state.auth && state.auth.user) || {};
  toast(`You’ve been signed out. Sign in ${why ? why(u) : `to keep saving to ${u.name || 'your profile'}`}.`, { label: 'Sign in', run: () => {
    import('./account.js').then(m => { if (typeof m.openAuth === 'function') m.openAuth('signin', { email: u.email || '', reason: 'lost' }); }).catch(() => toast(OFFLINE_MSG));
  } });
}
/** Writes check this first: while the sign-in is lost nothing is changed on screen and the reason is shown. A hosted
 *  site's guest gets the sign-in prompt instead (hosting brief §2: guests read, and save nothing). */
function refuseWhileLost() { if (S.guestBlocked()) return true; if (!lostNow()) return false; lostToast(); return true; }
/**
 * GET /api/library answered for `other`, not this tab's scope: this profile's session ended (idle expiry,
 * 'Sign out everywhere', a password change elsewhere) or another window signed in or out. Ask account.js,
 * which then marks the tab lost (its data held) or switches scope (onScopeChange reloads the library).
 */
let scopeCheck = false;
function checkScope(other) {
  if (lostNow() || scopeCheck) return; // already known: hold what is on screen
  if (document.getElementById('auth')?.dataset.busy) return; // a sign-in in progress settles the scope itself
  if (state.auth && state.auth.server) {
    // the check a refused write starts (account.js onAuthLost, which runs one at a time)
    document.dispatchEvent(new CustomEvent('bs:auth-lost', { detail: { error: 'scope_mismatch', scope: other } }));
    return;
  }
  // /api/auth/me failed when the page loaded, so onAuthLost stays out of it: re-read the sign-in instead
  scopeCheck = true;
  import('./account.js').then(m => (typeof m.refreshAuth === 'function' ? m.refreshAuth({ reason: 'drift' }) : null))
    .catch(e => console.error(e)).finally(() => { scopeCheck = false; });
}
function failToast(r) {
  if (!r) return;
  if (r.dry) { toast(DRY_MSG); return; }
  if (legacy()) { toast(LEGACY_MSG); return; }
  const code = r.data && r.data.error;
  if (S.signInRequired(r) && !(state.auth && state.auth.signedIn)) { state.auth.hosted = true; S.guestBlocked(); return; }
  if (r.status === 401 || (r.status === 409 && code === 'scope_mismatch')) {
    // the first refusal: account.js checks the session and explains it (markLost); once it is known to be
    // lost, account.js stays quiet, so say it here instead of leaving a success toast over a rollback
    if (lostNow()) lostToast();
    return;
  }
  if (!r.status || r.status >= 500 || !code) { toast(OFFLINE_MSG); return; }
  toast(r.data.message || 'That didn’t work. Try again.');
}
function noteRev(rev, wrote = true) {
  if (!Number.isInteger(rev)) return;
  if (lib.loaded && rev > lib.rev + (wrote ? 1 : 0)) refreshSoon(); // another window wrote in between
  if (rev > lib.rev) lib.rev = rev;
  if (wrote) announce(rev);
}
/** Tell other windows of this scope that the library changed (tracker.js calls it after a batch lands). */
export function announce(rev = lib.rev) {
  if (DRY) return;
  try { chan && chan.postMessage({ t: 'library', scope: curScope(), rev, id: tabId() }); } catch (e) { /* closed */ }
}

// ------------------------------------------------------------ change notification
let changeQueued = false, changeReason = '';
function changed(reason) {
  changeReason = reason;
  if (changeQueued) return;
  changeQueued = true;
  Promise.resolve().then(() => {
    changeQueued = false;
    document.dispatchEvent(new CustomEvent('bs:library-changed', { detail: { reason: changeReason } }));
    if (libOpen()) scheduleRender();
  });
}
let renderT = 0;
function scheduleRender() {
  if (renderT) return;
  renderT = setTimeout(() => {
    renderT = 0;
    if (!libOpen()) return;
    if (fn('menuOpen') && ui.menuOpen()) { scheduleRender(); return; } // don't pull the rug from under a menu
    renderLibrary({ keepScroll: true, still: true });
  }, 80);
}

// ------------------------------------------------------------ load
export async function loadLibrary({ activity = 50 } = {}) {
  if (DRY && lib.loaded) { changed('load'); return lib; } // nothing is written in a dry run: keep the in-memory state
  const seq = ++loadSeq;
  const n = Math.max(0, Math.min(1000, Math.round(+activity) || 0));
  const asked = curScope();
  const r = await call('GET', `/api/library?today=${localDay()}&activity=${n}`, null, { scoped: false });
  if (seq !== loadSeq) return lib;
  const d = r && r.ok ? r.data : null;
  if (!d || typeof d !== 'object' || !d.stats) {
    if (!lib.loaded) lib.offline = true;
    changed('load');
    return lib;
  }
  // The route is not scope-checked: a session that ended gets the guest's library, a guest tab gets the
  // profile another window signed in. Never show that under this tab's name: keep what is on screen (a lost
  // sign-in holds its data) until account.js has sorted the scope out. A switch reloads through onScopeChange;
  // a sign-in again of the same profile reloads through its 'auth' broadcast (the channel handler below).
  if (typeof d.scope === 'string' && d.scope !== curScope()) {
    held = true;
    if (asked === curScope()) checkScope(d.scope); // else this tab switched meanwhile and a new load follows
    changed('load');
    return lib;
  }
  held = false;
  const scope = typeof d.scope === 'string' ? d.scope : curScope();
  if (lib.scope && scope !== lib.scope) { inflight.clear(); marksInflight.clear(); showAllBms = false; studiedAll = 0; } // another profile's space
  lib.scope = scope;
  lib.rev = Number.isInteger(d.rev) ? d.rev : 0;
  lib.bookmarks = Array.isArray(d.bookmarks) ? d.bookmarks.filter(x => x && typeof x.ref === 'string' && parseRef(x.ref)) : [];
  lib.bookmarks.forEach(x => { const p = parseRef(x.ref); x.b = p.b; x.c = p.c; x.v = p.v; if (!COLORS.includes(x.color)) x.color = 'red'; });
  for (const [ref, f] of inflight) {
    const i = lib.bookmarks.findIndex(x => x.ref === ref);
    const gone = f.op === 'del' || f.bm._removed;
    if (gone && i >= 0) lib.bookmarks.splice(i, 1);
    else if (!gone && i < 0) lib.bookmarks.push(f.bm);
  }
  sortBookmarks(); reindex();
  lib.lastPosition = validPos(d.lastPosition);
  lib.chapters = d.chapters && typeof d.chapters === 'object' ? d.chapters : {};
  Object.values(lib.chapters).forEach(ch => { if (!Array.isArray(ch.studied)) ch.studied = []; });
  for (const [k, m] of marksInflight) { const ch = lib.chapters[k] || (lib.chapters[k] = newChapter()); Object.assign(ch, { read: m.read, readAt: m.readAt, manual: true, manualAt: m.manualAt }); }
  lib.activity = Array.isArray(d.activity) ? d.activity.filter(a => a && typeof a.type === 'string') : [];
  lib.activityTotal = Number.isInteger(d.activityTotal) ? d.activityTotal : lib.activity.length;
  lib.stats = d.stats;
  lib.loaded = true; lib.offline = false; lib.fetchedAt = Date.now();
  activityWanted = Math.max(50, n);
  const st = d.stats || {};
  base = { today: st.today || localDay(), m90: Array.isArray(st.minutes90) && st.minutes90.length === 90 ? st.minutes90.map(Number) : new Array(90).fill(0),
    week: +(st.week && st.week.seconds) || 0, studiedToday: !!(st.streak && st.streak.studiedToday), current: +(st.streak && st.streak.current) || 0,
    longest: +(st.streak && st.streak.longest) || 0, days90: +st.days90 || 0, daysStudied: +(st.totals && st.totals.daysStudied) || 0 };
  dayAdd = {};
  // events this window has not delivered yet (or is delivering right now) must not flicker back
  let evs = [];
  try { evs = (tracker && typeof tracker.pendingEvents === 'function' && tracker.pendingEvents()) || []; } catch (e) { evs = []; }
  evs.forEach(ev => applyOne(ev));
  // a link or mark made here whose save has not reached the server yet (700 ms later): its row stays until the server's arrives
  for (let i = linkAdds.length - 1; i >= 0; i--) {
    const e = linkAdds[i], id = e.x && e.x.id, own = e.type === 'mark.add' ? mrk && mrk.marks : lnk && lnk.links;
    const gone = e.scope !== scope || Date.now() - e.t > 120000 || (own && own.scope === scope && !own.byId.has(id));
    if (gone || lib.activity.some(a => a.type === e.type && a.x && a.x.id === id)) linkAdds.splice(i, 1); else applyOne(e);
  }
  recompute();
  changed('load');
  return lib;
}
/** Debounced reload (2 s) that keeps as much activity as is on screen. */
export function refreshSoon() {
  clearTimeout(refreshT);
  refreshT = setTimeout(() => { refreshT = 0; loadLibrary({ activity: activityWanted }); }, 2000);
}
function refreshIfStale(ms) {
  if (!lib.loaded && !lib.offline) return;
  if (stale || held || Date.now() - lib.fetchedAt > ms) { stale = false; refreshSoon(); }
}

// ------------------------------------------------------------ local mirror of the server aggregation (§4.6)
function recentAct(type, ref, t, win, x) {
  // with `x`, also the same detail (x.to of a followed link, x.strong/x.word of a word study), as the server's _recent
  for (const a of lib.activity.slice(0, 20)) if (a.type === type && a.ref === ref && Math.abs((a.t || 0) - t) <= win && (!x || ((a.x || {}).to === x.to && (a.x || {}).strong === x.strong && (a.x || {}).word === x.word))) return true;
  return false;
}
function addAct(e) {
  e._local = true;
  let i = 0; while (i < lib.activity.length && (lib.activity[i].t || 0) > e.t) i++;
  lib.activity.splice(i, 0, e);
  lib.activityTotal = (lib.activityTotal || 0) + 1;
  if (lib.activity.length > 1000) lib.activity.length = 1000;
  return e;
}
function dropAct(e) {
  const i = lib.activity.indexOf(e);
  if (i >= 0) { lib.activity.splice(i, 1); lib.activityTotal = Math.max(0, (lib.activityTotal || 1) - 1); }
}
const minNN = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
const maxNN = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));

function applyOne(ev) {
  if (!ev || typeof ev !== 'object') return false;
  const type = ev.type, t = +ev.t || Date.now();
  const b = +ev.b, c = +ev.c, v = +ev.v || 0, bk = bookOf(b);
  if (!bk || !(c >= 1 && c <= bk.chapters.length)) return false;
  if (type === 'position') {
    const p = validPos({ b, c, v, scrollFrac: ev.scrollFrac, t, tr: ev.tr });
    if (p && (!lib.lastPosition || !(t < lib.lastPosition.t))) lib.lastPosition = p;
    return true;
  }
  const k = `${b}.${c}`;
  const ch = lib.chapters[k] || (lib.chapters[k] = newChapter());
  if (!Array.isArray(ch.studied)) ch.studied = [];
  const day = typeof ev.day === 'string' ? ev.day : localDay(t);
  const da = () => dayAdd[day] || (dayAdd[day] = { s: 0, v: 0, r: 0, n: 0, o: 0 });
  if (type === 'chapter.open') {
    ch.visits = (+ch.visits || 0) + 1; ch.firstRead = minNN(ch.firstRead, t); ch.lastRead = maxNN(ch.lastRead, t); da().o++;
    if (!recentAct('chapter.open', k, t, 1800000)) addAct({ t, type, ref: k });
  } else if (type === 'chapter.time') {
    const sec = Math.floor(+ev.sec || 0); if (sec < 1) return false;
    ch.seconds = (+ch.seconds || 0) + sec; ch.firstRead = minNN(ch.firstRead, t); ch.lastRead = maxNN(ch.lastRead, t); da().s += sec;
  } else if (type === 'chapter.read') {
    if (ch.manualAt && t < ch.manualAt + 60000) return false; // a manual mark wins for a minute
    if (!ch.read) { ch.read = true; ch.readAt = t; ch.manual = false; da().r++; addAct({ t, type, ref: k }); }
  } else if (['verse.study', 'xref.open', 'word.study', 'note.save', 'video.add'].includes(type)) {
    if (v >= 1 && !ch.studied.includes(v)) { ch.studied.push(v); ch.studied.sort((x, z) => x - z); da().v++; }
    if (type === 'note.save') da().n++;
    const ref = v >= 1 ? `${k}.${v}` : k;
    if ((type === 'verse.study' || type === 'note.save') && recentAct(type, ref, t, 600000)) return true;
    const x = type === 'xref.open' ? { to: ev.to } : type === 'word.study' ? { ...(ev.strong ? { strong: ev.strong } : {}), ...(ev.word ? { word: ev.word } : {}) } : type === 'video.add' && ev.title ? { title: ev.title } : null;
    if ((type === 'xref.open' || type === 'word.study') && recentAct(type, ref, t, 600000, x || {})) return true; // same link / word again: one row
    addAct(x && Object.keys(x).length ? { t, type, ref, x } : { t, type, ref });
  } else if (type === 'link.add') {
    // links-spec §2: the server's add_link_activity marks the first verse of both ends studied and adds one row
    const x = ev.x && typeof ev.x === 'object' ? ev.x : {}, to = lkRef(x.to);
    if (!(v >= 1) || !to || typeof x.id !== 'string') return false;
    if (lib.activity.some(a => a.type === 'link.add' && a.x && a.x.id === x.id)) return true; // the server's row is here
    for (const [kk, vv] of [[k, v], [`${to.b}.${to.c}`, to.v]]) {
      const cx = lib.chapters[kk] || (lib.chapters[kk] = newChapter());
      if (!Array.isArray(cx.studied)) cx.studied = [];
      if (!cx.studied.includes(vv)) { cx.studied.push(vv); cx.studied.sort((p, q) => p - q); da().v++; }
    }
    addAct({ t, type, ref: lkRef(ev.ref) ? ev.ref : `${k}.${v}`, x: { id: x.id, to: x.to, kind: typeof x.kind === 'string' ? x.kind : 'related' } });
  } else if (type === 'mark.add') {
    // annotations-brief §2: the server's mark.add marks the start verse studied and adds one row
    const x = ev.x && typeof ev.x === 'object' ? ev.x : {};
    if (!(v >= 1) || typeof x.id !== 'string') return false;
    if (lib.activity.some(a => a.type === 'mark.add' && a.x && a.x.id === x.id)) return true; // the server's row is here
    if (!ch.studied.includes(v)) { ch.studied.push(v); ch.studied.sort((p, q) => p - q); da().v++; }
    addAct({ t, type, ref: `${k}.${v}`, x: { id: x.id, color: typeof x.color === 'string' ? x.color : '', note: !!x.note } });
  } else return false;
  return true;
}
/** Client mirror of the server's apply_events for one event (§4.4 optimistic UI). */
export function applyLocal(ev) {
  if (!applyOne(ev)) return;
  if (ev.type === 'link.add' || ev.type === 'mark.add') { linkAdds.push({ ...ev, scope: curScope() }); if (linkAdds.length > 50) linkAdds.shift(); }
  recompute();
  // time and position change no mark in the reader, the sheet or the picker: only the Library shows them
  if (ev.type === 'position' || ev.type === 'chapter.time') { if (libOpen()) scheduleRender(); return; }
  changed('local');
}

function emptyStats() {
  return { today: localDay(), streak: { current: 0, longest: 0, studiedToday: false }, minutes90: new Array(90).fill(0), days90: 0, week: { seconds: 0 },
    totals: { seconds: 0, chaptersRead: 0, chaptersTotal: TOTAL, versesStudied: 0, chaptersStudied: 0, booksCompleted: 0, bookmarks: 0, notes: 0, daysStudied: 0 }, books: {} };
}
/** Totals and per-book figures from the chapters; day-based figures from the server's baseline plus local days. */
function recompute() {
  const st = lib.stats || (lib.stats = emptyStats());
  const books = {};
  let seconds = 0, read = 0, verses = 0, chSt = 0;
  for (const [k, ch] of Object.entries(lib.chapters)) {
    const [b, c] = k.split('.').map(Number), bk = bookOf(b);
    if (!bk || !(c >= 1 && c <= bk.chapters.length) || !ch) continue;
    const x = books[b] || (books[b] = { read: 0, total: bk.chapters.length, started: 0, seconds: 0, studied: 0 });
    const s = +ch.seconds || 0, n = (ch.studied || []).length;
    seconds += s; verses += n; x.seconds += s; x.studied += n; if (n) chSt++;
    if (ch.read) { read++; x.read++; }
    if ((+ch.visits || 0) > 0 || n) x.started++;
  }
  st.books = books;
  st.totals = { ...(st.totals || {}), seconds, chaptersRead: read, chaptersTotal: TOTAL, versesStudied: verses, chaptersStudied: chSt,
    booksCompleted: Object.values(books).filter(x => x.read >= x.total).length, bookmarks: lib.bookmarks.length };
  const B = base || { today: localDay(), m90: new Array(90).fill(0), week: 0, studiedToday: false, current: 0, longest: 0, days90: 0, daysStudied: 0 };
  const T = parseDay(B.today), m90 = B.m90.slice();
  let week = B.week;
  for (const [d, a] of Object.entries(dayAdd)) {
    const off = dayDiff(T, parseDay(d));
    if (off < 0 || off > 89) continue;
    m90[89 - off] += a.s / 60;
    if (off < 7) week += a.s;
  }
  const a = dayAdd[B.today];
  const studied = B.studiedToday || !!(a && (B.m90[89] * 60 + a.s >= 60 || a.v >= 1 || a.r >= 1 || a.n >= 1));
  const extra = studied && !B.studiedToday ? 1 : 0;
  st.today = B.today; st.minutes90 = m90; st.week = { seconds: week };
  st.streak = { current: B.current + extra, longest: Math.max(B.longest, B.current + extra), studiedToday: studied };
  st.days90 = B.days90 + extra;
  st.totals.daysStudied = B.daysStudied + extra;
}

// ------------------------------------------------------------ queries
export function bookmarkFor(b, c, v = 0) { return bmIndex.get(refOf(b, c, v)) || null; }
export function bookmarksInChapter(b, c) {
  const m = new Map(), pre = `${b}.${c}`;
  for (const x of lib.bookmarks) { if (x.ref === pre) m.set(0, x); else if (x.ref.startsWith(pre + '.')) m.set(+x.ref.split('.')[2], x); }
  return m;
}
export function chapterState(b, c) {
  const ch = lib.chapters[`${b}.${c}`];
  if (!ch) return null;
  const studied = Array.isArray(ch.studied) ? ch.studied : [];
  const read = !!ch.read;
  return { read, readAt: ch.readAt || null, part: !read && ((+ch.visits || 0) > 0 || studied.length > 0), visits: +ch.visits || 0, seconds: +ch.seconds || 0, studied };
}
export function bookProgress(b) {
  const bk = bookOf(b); if (!bk) return { read: 0, total: 0, started: 0, frac: 0 };
  let read = 0, started = 0;
  for (let c = 1; c <= bk.chapters.length; c++) { const s = chapterState(b, c); if (!s) continue; if (s.read) read++; if (s.visits > 0 || s.studied.length) started++; }
  const total = bk.chapters.length;
  return { read, total, started, frac: total ? read / total : 0 };
}
function validPos(p) {
  if (!p || typeof p !== 'object') return null;
  const b = +p.b, c = +p.c, bk = bookOf(b);
  if (!bk || !Number.isInteger(c) || c < 1 || c > bk.chapters.length) return null;
  let v = Number.isInteger(+p.v) ? +p.v : 0; if (v < 0 || v > bk.chapters[c - 1]) v = 0;
  const sf = Number.isFinite(+p.scrollFrac) ? Math.min(1, Math.max(0, +p.scrollFrac)) : 0;
  const out = { b, c, v, scrollFrac: sf, t: +p.t || 0 };
  if (typeof p.tr === 'string' && /^[a-z0-9]{2,8}$/.test(p.tr)) out.tr = p.tr;
  return out;
}
const posKey = () => (typeof S.lsKey === 'function' ? S.lsKey('bs-pos-v1') : (curScope() === 'guest' ? 'bs-pos-v1' : `bs-pos-v1:${curScope()}`));
/** The newer of the server's last position and this browser's copy. */
export function currentPosition() {
  const a = validPos(lib.lastPosition);
  let loc = null;
  try { loc = validPos(JSON.parse(lsGet(posKey(), 'null'))); } catch (e) { loc = null; }
  if (!a) return loc;
  if (!loc) return a;
  return loc.t > a.t ? loc : a;
}

// ------------------------------------------------------------ bookmarks
/** Where a bookmark menu can open for this target: the sheet's ribbon, the verse gutter or the chapter footer. */
function anchorFor(b, c, v) {
  const onScreen = el => { if (!el || !el.isConnected || !el.getClientRects().length) return false; const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
  const hb = document.getElementById('btn-bookmark');
  if (state.drawerOpen && state.book === b && state.chapter === c && (state.drawerTab === 'search' ? 0 : state.selected || 0) === v && onScreen(hb)) return hb;
  if (state.book === b && state.chapter === c) {
    const el = v ? document.querySelector(`#v${v} .b-bm`) : document.querySelector('#reader [data-bm-chapter]');
    if (onScreen(el)) return el;
  }
  return null;
}
function labelAction(b, c, v) {
  return { label: 'Add label', run: () => {
    const bm = bookmarkFor(b, c, v); if (!bm) return;
    const a = anchorFor(b, c, v);
    if (a) openBookmarkMenu(a, bm); else openLibrary({ bookmark: bm.id });
  } };
}
export async function toggleBookmark(b = state.book, c = state.chapter, v = 0) {
  const bm = bookmarkFor(b, c, v);
  if (bm) { await removeBookmark(bm.id); return null; }
  return addBookmark({ b, c, v });
}
export async function addBookmark({ b, c, v = 0, label = '', color = 'red', created } = {}, opts = {}) {
  b = +b; c = +c; v = +v || 0;
  const bk = bookOf(b);
  if (!bk || !(c >= 1 && c <= bk.chapters.length) || v < 0 || v > bk.chapters[c - 1]) return null;
  const ref = refOf(b, c, v);
  const had = bmIndex.get(ref); if (had) return had;
  if (legacy() && !DRY) { toast(LEGACY_MSG); return null; }
  if (refuseWhileLost()) return null;
  label = cleanLabel(label); if (!COLORS.includes(color)) color = 'red';
  const now = Date.now();
  const bm = { id: `tmp_${Math.random().toString(16).slice(2, 14)}`, ref, b, c, v, label, color, created: +created && +created <= now ? +created : now, updated: now, _pending: true };
  lib.bookmarks.push(bm); sortBookmarks(); reindex();
  const act = addAct({ t: now, type: 'bookmark.add', ref, x: label ? { id: bm.id, label } : { id: bm.id } });
  recompute(); changed('bookmark');
  const name = refName(b, c, v);
  if (DRY) { bm.id = `bm_dry${Math.random().toString(16).slice(2, 9)}`; delete bm._pending; if (!opts.quiet) toast(`Bookmarked ${name}. ${DRY_MSG}`); return bm; }
  if (!opts.quiet) toast(`Bookmarked ${name}.`, labelAction(b, c, v));
  const body = { ref, label, color }; if (created) body.created = bm.created;
  inflight.set(ref, { op: 'add', bm });
  const r = await call('POST', '/api/library/bookmarks', body);
  if (inflight.get(ref)?.bm === bm) inflight.delete(ref);
  if (r.ok && r.data && r.data.bookmark && r.data.bookmark.id) {
    const sb = r.data.bookmark; const p = parseRef(sb.ref) || { b, c, v };
    // keep the object: a menu opened meanwhile holds it (the label/colour it set wins, patched below). Only such an
    // edit is sent: a bookmark that already existed (made in another window or browser) keeps its label and colour
    const local = {}; if (bm.label !== label) local.label = bm.label; if (bm.color !== color) local.color = bm.color;
    Object.assign(bm, sb, { b: p.b, c: p.c, v: p.v }); delete bm._pending;
    act.x = { ...(act.x || {}), id: bm.id };
    // a reload may have brought the server's copy meanwhile: keep a single object per ref (this one)
    if (!bm._removed) lib.bookmarks = lib.bookmarks.filter(x => x === bm || x.ref !== bm.ref).concat(lib.bookmarks.includes(bm) ? [] : [bm]);
    sortBookmarks(); reindex(); noteRev(r.data.rev, !r.data.existed); changed('bookmark');
    if (bm._removed) { bm._removed = false; deleteOnServer(bm); }
    else if (Object.keys(local).length) updateBookmark(bm.id, local); // only the edited field(s); it skips any the server already has
    return bm;
  }
  // failed: take it back
  lib.bookmarks = lib.bookmarks.filter(x => x !== bm); reindex(); dropAct(act); recompute(); changed('bookmark');
  bm._failed = true;
  failToast(r);
  return null;
}
function cleanLabel(s) { return cut(String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim(), 80); }
export async function updateBookmark(id, { label, color } = {}) {
  const bm = lib.bookmarks.find(x => x.id === id); if (!bm) return null;
  const patch = {};
  if (label !== undefined && cleanLabel(label) !== (bm.label || '')) patch.label = cleanLabel(label);
  if (color !== undefined && COLORS.includes(color) && color !== bm.color) patch.color = color;
  if (!Object.keys(patch).length) return bm;
  if (refuseWhileLost()) return null;
  const prev = { label: bm.label, color: bm.color };
  Object.assign(bm, patch, { updated: Date.now() }); changed('bookmark');
  if (DRY) { toast(DRY_MSG); return bm; }
  if (bm._pending) return bm; // the add in flight sends it once it lands (addBookmark compares)
  const r = await call('PATCH', `/api/library/bookmarks/${encodeURIComponent(bm.id)}`, patch);
  if (r.ok && r.data && r.data.bookmark) {
    // a newer local edit may have happened while this one was in flight: keep it
    const sb = r.data.bookmark;
    if ('label' in patch && bm.label === patch.label && typeof sb.label === 'string') bm.label = sb.label;
    if ('color' in patch && bm.color === patch.color && COLORS.includes(sb.color)) bm.color = sb.color;
    bm.updated = sb.updated || bm.updated;
    noteRev(r.data.rev); changed('bookmark');
    return bm;
  }
  if (r.status === 404) { lib.bookmarks = lib.bookmarks.filter(x => x !== bm); reindex(); recompute(); changed('bookmark'); refreshSoon(); toast('That bookmark was removed in another window.'); return null; }
  Object.assign(bm, prev); changed('bookmark');
  failToast(r);
  return null;
}
async function deleteOnServer(bm) {
  const r = await call('DELETE', `/api/library/bookmarks/${encodeURIComponent(bm.id)}`, {});
  if (r.ok) noteRev(r.data && r.data.rev);
  return r;
}
export async function removeBookmark(id, { undo = true, quiet = false } = {}) {
  const i = lib.bookmarks.findIndex(x => x.id === id); if (i < 0) return false;
  if (refuseWhileLost()) return false;
  const bm = lib.bookmarks[i];
  lib.bookmarks.splice(i, 1); reindex();
  const act = addAct({ t: Date.now(), type: 'bookmark.remove', ref: bm.ref, x: { id: bm.id } });
  recompute(); changed('bookmark');
  const name = bmRef(bm);
  const again = { label: 'Undo', run: () => addBookmark({ b: bm.b, c: bm.c, v: bm.v, label: bm.label, color: bm.color, created: bm.created }, { quiet: true }) };
  if (DRY) { if (!quiet) toast(`Removed bookmark from ${name}. ${DRY_MSG}`, undo ? again : undefined); return true; }
  if (!quiet) toast(`Removed bookmark from ${name}.`, undo ? again : undefined);
  if (bm._pending) { bm._removed = true; return true; } // the add is still in flight: delete once it lands
  inflight.set(bm.ref, { op: 'del' });
  const r = await deleteOnServer(bm);
  if (inflight.get(bm.ref)?.op === 'del') inflight.delete(bm.ref);
  if (r.ok || r.status === 404) return true;
  // failed: put it back
  if (!bmIndex.has(bm.ref)) { lib.bookmarks.push(bm); sortBookmarks(); reindex(); }
  dropAct(act); recompute(); changed('bookmark');
  failToast(r);
  return false;
}

/** The bookmark editor: label, colour, go, show in Library, remove (§5.8). */
export function openBookmarkMenu(anchor, bookmark) {
  if (!anchor || !bookmark) return null;
  const bm = lib.bookmarks.includes(bookmark) ? bookmark : (bmIndex.get(bookmark.ref) || lib.bookmarks.find(x => x.id === bookmark.id));
  if (!bm) return null;
  const name = bmRef(bm);
  const inLib = !!(anchor.closest && anchor.closest('#library'));
  const here = bm.b === state.book && bm.c === state.chapter;
  const cap = s => s[0].toUpperCase() + s.slice(1);
  const html = `<div class="bm-menu-head" role="presentation">
      <label class="field sm"><input id="bm-label" placeholder="Add a label" maxlength="80" aria-label="Bookmark label" autocomplete="off" spellcheck="false" value="${esc(bm.label || '')}"></label>
      <div class="bm-colors" role="radiogroup" aria-label="Colour">${COLORS.map(c => `<button type="button" role="radio" class="bm-sw" data-bm-color="${c}" aria-checked="${c === bm.color}" tabindex="${c === bm.color ? 0 : -1}" aria-label="${cap(c)}" title="${cap(c)}">${icon('check')}</button>`).join('')}</div>
    </div>
    <hr>
    <div role="menu" aria-label="Bookmark actions">
    ${here && !inLib ? '' : `<button type="button" role="menuitem" data-bmi="go">Go to passage${icon('arrow-right')}</button>`}
    ${inLib ? '' : `<button type="button" role="menuitem" data-bmi="library">Show in Library${icon('library')}</button>`}
    <hr>
    <button type="button" role="menuitem" class="danger" data-bmi="remove">Remove bookmark${icon('trash')}</button>
    </div>`;
  let input = null;
  // the Library may reload while the menu is open (new objects): always act on the current bookmark for this ref
  const ref = bm.ref, cur = () => bmIndex.get(ref) || null;
  const saveLabel = () => { const x = cur(); if (input && x && cleanLabel(input.value) !== (x.label || '')) updateBookmark(x.id, { label: input.value }); };
  const pick = sw => {
    if (sw.getAttribute('aria-checked') !== 'true' && refuseWhileLost()) return; // the swatch stays on the saved colour
    const g = sw.closest('.bm-colors');
    $$('.bm-sw', g).forEach(x => { const on = x === sw; x.setAttribute('aria-checked', String(on)); x.tabIndex = on ? 0 : -1; });
    const x = cur(); if (x) updateBookmark(x.id, { color: sw.dataset.bmColor });
  };
  const opts = {
    label: `Edit bookmark: ${name}`, className: 'bm-menu', focus: '#bm-label', dialog: true,   // an editor with fields, not a menu
    onClick: e => {
      const sw = e.target.closest('.bm-sw'); if (sw) { pick(sw); return; }
      const it = e.target.closest('[data-bmi]'); if (!it) return;
      const act = it.dataset.bmi;
      closeMenuSafe(act === 'remove');   // focus back on the opener; the Library then moves it to the next row
      const x = cur() || bm;
      if (act === 'go') { if (libOpen()) closeLib(); A?.navigate?.(x.b, x.c, x.v || 0); A?.yieldToPage?.(); }
      else if (act === 'library') openLibrary({ bookmark: x.id });
      else if (act === 'remove' && cur()) removeBookmark(x.id);
    },
    onKeydown: (e, m) => {
      const t = e.target;
      if (t === input) {
        if (e.key === 'Enter') { e.preventDefault(); saveLabel(); closeMenuSafe(true); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); ($('.bm-sw[aria-checked="true"]', m) || $('.bm-sw', m))?.focus(); }
        else if (e.key === 'ArrowUp') e.preventDefault(); // stay in the field
        return;
      }
      if (t.classList && t.classList.contains('bm-sw')) {
        const sws = $$('.bm-sw', m), i = sws.indexOf(t);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const n = sws[(i + (e.key === 'ArrowRight' ? 1 : -1) + sws.length) % sws.length]; n.focus(); pick(n); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); input?.focus(); }
        else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); const n = sws[e.key === 'Home' ? 0 : sws.length - 1]; n.focus(); pick(n); }
      }
    },
    onClose: () => saveLabel(),
  };
  const m = fn('openMenu') ? ui.openMenu(anchor, html, opts) : null;
  if (!m) return null;
  input = $('#bm-label', m);
  input?.addEventListener('change', saveLabel);
  if (input) { const L = input.value.length; try { input.setSelectionRange(L, L); } catch (e) { /* ignore */ } }
  return m;
}
function closeMenuSafe(restore) { if (fn('closeMenu')) ui.closeMenu(restore); }

// ------------------------------------------------------------ read marks
/** Mark chapters read or unread by hand (optimistic). Toasts with Undo unless opts.quiet. */
export async function markChapters(b, cs, read, opts = {}) {
  b = +b; const bk = bookOf(b); if (!bk) return false;
  const list = [...new Set([].concat(cs).map(Number).filter(c => Number.isInteger(c) && c >= 1 && c <= bk.chapters.length))].sort((x, z) => x - z);
  if (!list.length) return false;
  if (legacy() && !DRY) { toast(LEGACY_MSG); return false; }
  if (refuseWhileLost()) return false;
  read = !!read;
  const now = Date.now(), prev = new Map(), flipped = [];
  for (const c of list) {
    const k = `${b}.${c}`, had = lib.chapters[k];
    prev.set(k, had ? { ...had } : null);
    const ch = had || (lib.chapters[k] = newChapter());
    if (!!ch.read !== read) flipped.push(c);
    ch.read = read; ch.readAt = read ? (ch.readAt || now) : null; ch.manual = true; ch.manualAt = now;
  }
  const single = list.length === 1;
  const act = addAct({ t: now, type: 'chapter.mark', ref: single ? `${b}.${list[0]}` : `${b}`, x: { read, count: list.length } });
  recompute(); changed('mark');
  if (!opts.quiet) {
    const msg = single ? `Marked ${refName(b, list[0])} as ${read ? 'read' : 'unread'}.` : `Marked ${plural(flipped.length || list.length, 'chapter')} of ${bk.name} as ${read ? 'read' : 'unread'}.`;
    const undo = flipped.length ? { label: 'Undo', run: () => markChapters(b, flipped, !read, { quiet: true }) } : undefined;
    toast(DRY ? `${msg} ${DRY_MSG}` : msg, undo);
  }
  if (DRY) return true;
  const mine = list.map(c => { const k = `${b}.${c}`, ch = lib.chapters[k], m = { read, readAt: ch.readAt, manualAt: now }; marksInflight.set(k, m); return [k, m]; });
  const r = await call('POST', '/api/library/chapters', single ? { b, c: list[0], read } : { b, cs: list, read });
  mine.forEach(([k, m]) => { if (marksInflight.get(k) === m) marksInflight.delete(k); });
  if (r.ok) {
    const got = r.data && r.data.chapters;
    if (got && typeof got === 'object') for (const [k, ch] of Object.entries(got)) { if (ch && typeof ch === 'object') lib.chapters[k] = { ...newChapter(), ...ch, studied: Array.isArray(ch.studied) ? ch.studied : [] }; }
    noteRev(r.data && r.data.rev); recompute(); changed('mark');
    return true;
  }
  for (const [k, was] of prev) { if (was) lib.chapters[k] = was; else delete lib.chapters[k]; }
  dropAct(act); recompute(); changed('mark');
  failToast(r);
  return false;
}

// ------------------------------------------------------------ Library dialog
function closeLib() { const d = libDialog(); if (!d) return; if (A && typeof A.closeDialog === 'function') A.closeDialog(d); else if (fn('closeDialog')) ui.closeDialog(d); else d.close(); }
function showLib() { const d = libDialog(); if (!d) return; if (A && typeof A.showDialog === 'function') A.showDialog(d); else if (fn('showDialog')) ui.showDialog(d); else if (!d.open) d.showModal(); }

export function openLibrary({ book = null, bookmark = null, view: name = null, tag = null } = {}) {
  const d = libDialog(); if (!d) return;
  fn('closeMenu') && ui.closeMenu(false);
  view = book && bookOf(+book) ? { name: 'book', b: +book } : name === 'map' ? { name: 'map' } : { name: 'home' };
  if (view.name === 'map') { // a tag chip on a link card: My map showing that tag only
    Object.assign(mapF, { type: '', tag: typeof tag === 'string' ? tag : '', q: '' });
    mapAllRows = false; NET.auto = true; homeScroll = 0;
  }
  marking = false; focusBm = bookmark || null;
  if (focusBm && lib.bookmarks.findIndex(x => x.id === focusBm) >= 50) showAllBms = true;
  const wasOpen = libOpen();
  renderLibrary({ keepScroll: false, still: wasOpen });
  showLib();
  // deliver what this window has tracked so far, then reload (re-rendered through bs:library-changed)
  Promise.resolve().then(() => (tracker && typeof tracker.flush === 'function' ? tracker.flush() : null)).catch(() => null).finally(() => loadLibrary({ activity: Math.max(50, activityWanted) }));
}

export function renderLibrary(opts = {}) {
  const body = document.getElementById('library-body'); if (!body) return;
  if (opts.book && bookOf(+opts.book)) view = { name: 'book', b: +opts.book };
  else if (opts.home) view = { name: 'home' };
  const sub = document.getElementById('library-sub');
  if (sub) {
    const au = state.auth || {};
    const who = au.signedIn && au.user ? au.user.name || au.user.email || 'Your profile' : 'Guest';
    sub.textContent = lib.offline && !lib.loaded ? `${who} · not connected` : `${who} · saved on this computer`;
  }
  // My map redraws in place (its search field, canvas and layout stay); a push, pop or another view rebuilds the body
  if (view.name === 'map' && !opts.push && !opts.pop && $('#lib-map', body)) { if (opts.keepScroll === false) body.scrollTop = 0; paintMap(); return; }
  stopNet();
  // keep focus on the same control across a re-render
  const ae = document.activeElement;
  const fsel = body.contains(ae) ? focusSel(ae) : null;
  const alt = body.contains(ae) ? focusAlt(ae) : null;
  const prevScroll = body.scrollTop;
  let html = '';
  try { html = view.name === 'book' ? bookView(view.b) : view.name === 'map' && lkOk() ? mapView() : homeView(); }
  catch (e) { console.error(e); html = empty('info', 'Something went wrong', esc(e.message)); }
  const cls = opts.push ? 'view push' : opts.pop ? 'view pop' : 'view';
  body.innerHTML = `<div class="${cls}"${opts.still ? ' style="animation:none"' : ''}>${html}</div>`;
  body.scrollTop = opts.keepScroll ? prevScroll : 0;
  if (view.name === 'map') { mapSig = ''; paintMap(); }
  afterRender(body, fsel, alt);
}

function focusSel(el) {
  if (!el || !el.closest) return null;
  const li = el.closest('li[data-bm]');
  if (li && el.matches('[data-bm-menu]')) return `li[data-bm="${cssEsc(li.dataset.bm)}"] [data-bm-menu]`;
  if (li && el.matches('[data-lib-go]')) return `li[data-bm="${cssEsc(li.dataset.bm)}"] [data-lib-go]`;
  const lk = el.closest('li[data-lk]');
  if (lk && el.matches('[data-lk-menu], [data-lib-link]')) return `li[data-lk="${cssEsc(lk.dataset.lk)}"] ${el.matches('[data-lk-menu]') ? '[data-lk-menu]' : '[data-lib-link]'}`;
  for (const a of ['data-lib-go', 'data-lib-book', 'data-lib-markbook', 'data-lib-mode', 'data-lib-auth', 'data-lm-type', 'data-lm-tag', 'data-lm-mode', 'data-lm-zoom']) if (el.hasAttribute(a)) return `[${a}="${cssEsc(el.getAttribute(a))}"]`;
  if (el.matches('.pch[data-c]')) return `.pch[data-c="${cssEsc(el.dataset.c)}"]`;
  for (const a of ['data-lib-resume', 'data-lib-back', 'data-more-activity', 'data-more-bms', 'data-lib-links', 'data-lm-moretags', 'data-lm-allrows', 'data-lm-clear']) if (el.hasAttribute(a)) return `[${a}]`;
  // a heading that focusAlt or refocusAfterConfirm moved focus to (a bookmark removed, then Undo): the same heading
  for (const s of ['#lib-bookmarks h3', '#lib-activity h3', '.pc-title']) if (el.matches(s)) return s;
  return null;
}
/**
 * Where focus goes when the focused control is gone or disabled after the re-render (a book opened, the last page
 * of activity loaded, all chapters marked, a bookmark removed): its nearest sensible neighbour, never <body>.
 * Read from the DOM before the re-render; returns body => element | null.
 */
function focusAlt(el) {
  if (!el || !el.closest) return null;
  const pick = (...ts) => b => { for (const t of ts) { const x = typeof t === 'function' ? t(b) : (t && $(t, b)); if (x && !x.disabled) return x; } return null; };
  const li = el.closest('li[data-bm]');
  if (li) {
    const near = [li.nextElementSibling, li.previousElementSibling].filter(x => x && x.dataset && x.dataset.bm).map(x => `li[data-bm="${cssEsc(x.dataset.bm)}"] .cell`);
    return pick(...near, '#lib-bookmarks li[data-bm] .cell', '#lib-bookmarks h3');
  }
  const lk = el.closest('li[data-lk]');
  if (lk) { // a link removed (⋯ › Delete): the row after it, else before it, else the section's heading
    const near = [lk.nextElementSibling, lk.previousElementSibling].filter(x => x && x.dataset && x.dataset.lk).map(x => `li[data-lk="${cssEsc(x.dataset.lk)}"] .cell`);
    return pick(...near, '#lib-links li[data-lk] .cell', '#lm-main li[data-lk] .cell', '#lib-links h3', '[data-lm-type=""]', '[data-lib-back]');
  }
  if (el.matches('[data-lib-book], [data-lib-links]')) return pick('[data-lib-back]');
  if (el.matches('[data-lm-tag], [data-lm-type], [data-lm-moretags], [data-lm-allrows], [data-lm-clear]')) return pick('[data-lm-tag=""]', '[data-lm-type=""]', '#lm-q');
  if (el.matches('[data-lib-markbook]')) return pick('[data-lib-markbook]:not([disabled])', '.lib-chgrid .pch', '.pc-title');
  // 'Show all' / 'Show more' are gone once everything is shown: the first row that was hidden
  if (el.matches('[data-more-bms]')) { const n = $$('#library-body #lib-bookmarks li[data-bm]').length; return pick(b => $$('#lib-bookmarks li[data-bm] .cell', b)[n], '#lib-bookmarks h3'); }
  if (el.matches('[data-more-activity]')) { const n = $$('#library-body #lib-activity li.act').length; return pick(b => $$('#lib-activity li.act', b)[n], '#lib-activity h3'); }
  return null;
}
function focusIn(el) {
  if (!el) return;
  if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.tabIndex = -1; // a row or heading: focusable from script only
  el.focus({ preventScroll: true });
}
/** After #confirm has closed: its return-focus target may have been re-rendered away, so focus `pick` in the Library. */
function refocusAfterConfirm(pick) {
  const run = () => {
    const d = libDialog(), body = document.getElementById('library-body');
    if (!libOpen() || !body) return;
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae.isConnected && d.contains(ae)) return;
    focusIn(pick(body));
  };
  const cf = document.getElementById('confirm');
  if (cf && cf.open) cf.addEventListener('close', () => setTimeout(run, 0), { once: true }); else run();
}

const empty = (ic, title, body, tile = 'blue') => `<div class="empty"><span class="tile-i ${tile}">${icon(ic)}</span><h4>${title}</h4><p>${body}</p></div>`;
const goBtn = (ref, text) => `<button class="link" type="button" data-lib-go="${esc(ref)}">${esc(text)}</button>`;

function homeView() {
  const au = state.auth || {};
  let h = '';
  if (au.known && au.server && !au.signedIn && !lib.offline && !au.legacy) {
    h += `<div class="notice lib-guest" role="note">${icon('person')}<p>Studying as a guest<small>Create a profile to keep notes, bookmarks and progress under your name.</small></p>${au.features && au.features.signup === false ? '' : '<button class="btn btn-tinted sm" type="button" data-lib-auth="signup">Create profile</button>'}<button class="btn btn-plain sm" type="button" data-lib-auth="signin">Sign in</button></div>`;
  }
  h += continueCard();
  if (!lib.loaded) {
    h += !lib.offline ? SKELETON
      : legacy() ? empty('info', 'Library needs the new serve.py', 'The serve.py that is running predates profiles. Restart it with <code>python3 ~/bible-study/serve.py</code>, then reload.')
      : empty('info', 'Library needs serve.py', 'Start it with <code>python3 ~/bible-study/serve.py</code>, then reload.');
    return h;
  }
  h += statsCards() + chartCard();
  h += `<div class="lib-cols"><div class="lib-col">${bookmarksSection()}${linksSection()}</div>${activitySection()}</div>`;
  h += progressSection();
  return h;
}

function continueCard() {
  const pos = currentPosition();
  if (!pos) return '';
  const bk = bookOf(pos.b);
  const pct = Math.round(pos.scrollFrac * 100);
  const others = Object.entries(lib.chapters).filter(([k, ch]) => ch && ch.lastRead && k !== `${pos.b}.${pos.c}`)
    .sort((a, z) => z[1].lastRead - a[1].lastRead).slice(0, 5)
    .map(([k]) => k.split('.').map(Number)).filter(([b, c]) => bookOf(b) && c >= 1 && c <= bookOf(b).chapters.length);
  const when = relTime(pos.t);
  return `<section class="lib-continue" data-div="${esc(divSlug(bk))}">
      <div class="lc-body"><p class="lc-k">Continue reading</p><h3 class="lc-t">${esc(refName(pos.b, pos.c, pos.v))}</h3><p class="lc-q" data-lc-q="${pos.b}.${pos.c}.${pos.v || 1}"></p><p class="lc-s">${when ? esc(when) + ' · ' : ''}${pct}% through ${esc(refName(pos.b, pos.c))}</p><div class="lc-prog" style="--p:${pos.scrollFrac.toFixed(3)}"><i></i></div></div>
      <button class="btn btn-primary" type="button" data-lib-resume>Continue${icon('arrow-right')}</button>
      ${others.length ? `<div class="lib-recent" role="group" aria-label="Recently opened">${others.map(([b, c]) => `<button class="chip" type="button" data-lib-go="${b}.${c}">${esc(refName(b, c))}</button>`).join('')}</div>` : ''}
    </section>`;
}

function durBig(sec) {
  sec = Math.max(0, +sec || 0);
  const M = roundMin(sec);
  if (sec > 0 && !M) return '&lt;1<small> min</small>';
  const h = Math.floor(M / 60), m = M % 60;
  return h ? `${h.toLocaleString()}<small> h</small>${m ? ` ${m}<small> min</small>` : ''}` : `${m}<small> min</small>`;
}
function statsCards() {
  const st = lib.stats || emptyStats(), T = st.totals || {}, k = st.streak || {};
  const cur = +k.current || 0, longest = +k.longest || 0;
  const readN = +T.chaptersRead || 0, pct = readN / TOTAL * 100;
  const pctTxt = !readN ? `of ${TOTAL.toLocaleString()} chapters` : pct < 1 ? 'under 1% of the Bible' : `${Math.round(pct)}% of the Bible`;
  const streakSub = longest ? `Longest ${plural(longest, 'day')}` : 'Read today to start one';
  const card = (tile, ic, label, big, sub) => `<div class="lib-stat"><span class="tile-i ${tile}">${ic[0] === '<' ? ic : icon(ic)}</span><small>${label}</small><b>${big}</b><span class="lib-stat-s">${sub}</span></div>`;
  const made = linksMade(), books = new Set();
  for (const l of myLinks()) for (const r of [lkRef(l.from), lkRef(l.to)]) if (r) books.add(r.b);
  const hl = marksMade(), mine = myMarks(), said = mine.filter(m => m.note).length;
  const hlSub = !mine.length ? '' : said ? `${plural(said, 'with a comment', 'with comments')}` : `in ${plural(new Set(mine.map(m => m.start.split('.').slice(0, 2).join('.'))).size, 'chapter')}`;
  const tiles = 4 + (made > 0) + (hl > 0);
  return `<section class="lib-stats${tiles === 5 ? ' five' : tiles === 6 ? ' six' : ''}" aria-label="Your study">
    ${card('orange', 'flame', 'Streak', `${cur.toLocaleString()}<small> ${cur === 1 ? 'day' : 'days'}</small>`, esc(streakSub))}
    ${card('blue', 'clock', 'Time studied', durBig(T.seconds), `${esc(fmtDuration((st.week && st.week.seconds) || 0))} this week`)}
    ${card('indigo', 'book', 'Chapters read', readN.toLocaleString(), esc(pctTxt))}
    ${card('green', 'check', 'Verses studied', (+T.versesStudied || 0).toLocaleString(), `in ${esc(plural(+T.chaptersStudied || 0, 'chapter'))}`)}
    ${made > 0 ? card('indigo', 'link-node', 'Links made', made.toLocaleString(), books.size ? `across ${esc(plural(books.size, 'book'))}` : '') : ''}
    ${hl > 0 ? card('gold', HL_ICON, 'Highlights', hl.toLocaleString(), esc(hlSub)) : ''}
  </section>`;
}

function chartCard() {
  const st = lib.stats || emptyStats();
  const m = (st.minutes90 || []).length === 90 ? st.minutes90.map(x => Math.max(0, +x || 0)) : new Array(90).fill(0);
  const today = parseDay(st.today || localDay());
  const dayAt = i => new Date(today.getFullYear(), today.getMonth(), today.getDate() - (89 - i));
  const max = Math.max(1, ...m);
  let busiest = -1; m.forEach((x, i) => { if (x > 0 && (busiest < 0 || x >= m[busiest])) busiest = i; });
  const total = m.reduce((s, x) => s + x, 0);
  // The bars are per-day minutes (each rounded by the server). When every second ever counted falls inside
  // this window (no chapter was first read before it), the exact total is the one the Time card shows:
  // use it, so both read the same figure.
  const from = dayAt(0).getTime(), T = st.totals || {};
  const allInWindow = Object.values(lib.chapters).every(ch => !ch || !(+ch.seconds > 0) || +ch.firstRead >= from);
  const secs90 = allInWindow && +T.seconds > 0 ? +T.seconds : Math.round(total * 60);
  const days = +st.days90 || 0;
  const aria = busiest < 0 ? 'Minutes studied per day for the last 90 days. No study time recorded yet.'
    : `Minutes studied per day for the last 90 days, most recent on the right. Busiest day: ${dayAt(busiest).getDate()} ${MONTH[dayAt(busiest).getMonth()]}, ${plural(Math.round(m[busiest]), 'minute')}.`;
  const bars = m.map((x, i) => {
    const d = dayAt(i), mins = Math.round(x);
    const cls = [mins <= 0 ? 'z' : '', i === 89 ? 'today' : ''].filter(Boolean).join(' ');
    return `<i${cls ? ` class="${cls}"` : ''} style="--h:${(x / max).toFixed(3)};--i:${i}" title="${WD[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} · ${mins} min"></i>`;
  }).join('');
  return `<section class="lib-card lib-chart">
    <div class="lh"><h3>Last 90 days</h3><span>${esc(fmtDuration(secs90))} · ${esc(plural(days, 'day'))}</span></div>
    <div class="lib-bars" role="img" aria-label="${esc(aria)}">${bars}</div>
    <div class="lib-axis" aria-hidden="true"><span>${dm(dayAt(0))}</span><span>${dm(dayAt(45))}</span><span>Today</span></div>
  </section>`;
}

function bookmarksSection() {
  const all = lib.bookmarks, n = all.length;
  const list = showAllBms ? all : all.slice(0, 50);
  const rows = list.map(bm => {
    const name = bmRef(bm);
    return `<li class="bm" data-bm="${esc(bm.id)}"><button class="cell" type="button" data-lib-go="${esc(bm.ref)}"><span class="bm-rib" data-bm-color="${esc(bm.color)}" aria-hidden="true">${icon('bookmark', 'f')}</span><span class="cell-body"><span class="cell-title">${esc(name)}</span><span class="cell-sub">${bm.label ? `<b class="bm-label">${esc(bm.label)}</b> · ` : ''}<span data-preview="${esc(bm.v ? bm.ref : bm.ref + '.1')}"></span></span></span><span class="cell-trail"><span class="vn" title="Bookmarked ${esc(relTime(bm.created))}">${esc(shortAge(bm.created))}</span></span></button><button class="more-btn" type="button" data-bm-menu aria-haspopup="dialog" aria-expanded="false" aria-label="Edit bookmark: ${esc(name)}" title="Edit bookmark">${icon('ellipsis')}</button></li>`;
  }).join('');
  return `<section class="lib-sec" id="lib-bookmarks"><div class="lh"><h3>Bookmarks</h3><span>${n.toLocaleString()}</span></div>
    ${n ? `<ul class="group av lib-bms">${rows}</ul>${n > list.length ? `<button class="btn btn-gray btn-wide" type="button" data-more-bms>Show all ${n.toLocaleString()} bookmarks</button>` : ''}`
      : empty('bookmark', 'No bookmarks yet', 'Press b, or tap the ribbon in the study panel, to bookmark a verse or a chapter.', 'orange')}
  </section>`;
}

const ACT = {
  'chapter.open': ['book', 'blue'], 'chapter.read': ['check', 'green'], 'chapter.mark': ['check', 'green'], 'verse.study': ['sparkle', 'indigo'],
  'xref.open': ['link', 'blue'], 'word.study': ['alpha', 'indigo'], 'note.save': ['note', 'blue'], 'video.add': ['play-rect', 'red'],
  'bookmark.add': ['bookmark', 'orange'], 'bookmark.remove': ['bookmark', ''], 'profile.create': ['person', 'blue'], 'profile.import': ['import', 'gold'],
  'link.add': ['link-node', 'indigo'],
};
// highlights and comments (marks.js): a highlighter and marks.js's speech bubble, drawn here (icons.js has neither)
const HL_ICON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.6 4.6l4.8 4.8-8.2 8.2H6.4v-4.8z"/><path d="M12.2 7l4.8 4.8"/><path d="M4 20.5h16"/></svg>';
const COMMENT_ICON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5h10A2.5 2.5 0 0119.5 7v6.5A2.5 2.5 0 0117 16h-5.5L7.5 19.5V16H7a2.5 2.5 0 01-2.5-2.5V7A2.5 2.5 0 017 4.5z"/></svg>';
function refLink(ref) { const p = parseRef(ref); return p ? goBtn(ref, refName(p.b, p.c, p.v)) : ''; }
function actText(a) {
  const x = a.x && typeof a.x === 'object' ? a.x : {};
  const r = refLink(a.ref);
  switch (a.type) {
    case 'chapter.open': return r && [`Opened ${r}`];
    case 'chapter.read': return r && [`Read ${r}`];
    case 'chapter.mark': {
      const how = x.read === false ? 'unread' : 'read';
      const p = parseRef(a.ref); if (!p) return null;
      if (!p.c) return [`Marked ${esc(plural(+x.count || 0, 'chapter'))} of <button class="link" type="button" data-lib-book="${p.b}">${esc(bookOf(p.b).name)}</button> as ${how}`];
      return [`Marked ${r} as ${how}`];
    }
    case 'verse.study': return r && [`Studied ${r}`];
    case 'xref.open': { const to = refLink(x.to); return r && [to ? `Followed ${r} to ${to}` : `Followed a link from ${r}`]; }
    case 'word.study': return r && [`Looked up ${x.strong ? esc(x.strong) : 'a word'} in ${r}`];
    case 'note.save': return r && [`Wrote a note on ${r}`];
    case 'video.add': return r && [`Added a video to ${r}`, x.title];
    case 'bookmark.add': return r && [`Bookmarked ${r}`, x.label];
    case 'bookmark.remove': return r && [`Removed the bookmark on ${r}`];
    case 'link.add': {
      // 'Linked {John 1:29} to {Isaiah 53:7}'; sub: the type's phrase (a two-way or custom link's own, while it is unchanged)
      const f = lkRef(a.ref), t = lkRef(x.to); if (!f) return null;
      const go = q => goBtn(`${q.b}.${q.c}.${q.v}`, lkName(q));
      const l = lkOk() && typeof x.id === 'string' ? lnk.links.byId.get(x.id) : null;
      const T = lkOk() ? lnk.TYPES.find(y => y.id === x.kind) : null;
      const ph = l && l.type === x.kind ? lnk.phrase(l, 'from') : T && x.kind !== 'custom' ? T.fwd : '';
      return [t ? `Linked ${go(f)} to ${go(t)}` : `Linked ${go(f)}`, ph && ph[0].toUpperCase() + ph.slice(1)];
    }
    case 'mark.add': {
      // 'Highlighted {John 3:16}' / 'Commented on {John 3:16}'; sub: the words, while the mark is here
      const m = mrk && mrk.marks && mrk.marks.scope === curScope() && typeof x.id === 'string' ? mrk.marks.byId.get(x.id) : null;
      const p = parseRef(a.ref); if (!p || !p.v) return null;
      const r2 = m && typeof mrk.markLabel === 'function' ? goBtn(a.ref, mrk.markLabel(m)) : r;
      const q = m ? m.quote.replace(/\s+/g, ' ').trim() : '';
      return [x.note ? `Commented on ${r2}` : `Highlighted ${r2}`, q ? `“${q.length > 90 ? q.slice(0, 90).replace(/\s\S*$/, '') + '…' : q}”` : ''];
    }
    case 'profile.create': return ['Created this profile'];
    case 'profile.import': {
      // the words of the import's toast and the sign-up preview (account.js): chapters = reading progress, not 'read'
      const parts = [+x.notes > 0 ? plural(+x.notes, 'note') : '', +x.bookmarks > 0 ? plural(+x.bookmarks, 'bookmark') : '', +x.links > 0 ? plural(+x.links, 'link') : '', +x.marks > 0 ? plural(+x.marks, 'highlight') : '',
        +x.chapters > 0 ? `reading progress for ${plural(+x.chapters, 'chapter')}` : ''].filter(Boolean);
      // no counts: only guest study days, activity or the last-read place came over
      const sub = parts.join(' · ');
      return sub ? ['Brought over guest notes and progress', sub[0].toUpperCase() + sub.slice(1)] : ['Brought over guest reading history'];
    }
    default: return null;
  }
}
function activitySection() {
  const groups = [];
  let cur = null;
  for (const a of lib.activity) {
    const t = actText(a); if (!t) continue;
    const day = localDay(a.t);
    if (!cur || cur.day !== day) { cur = { day, items: [] }; groups.push(cur); }
    const [ic, tile] = a.type === 'mark.add' ? [a.x && a.x.note ? COMMENT_ICON : HL_ICON, a.x && a.x.note ? 'blue' : 'gold'] : ACT[a.type] || ['info', 'blue'];
    const d = new Date(a.t);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    cur.items.push(`<li class="act"><span class="tile-i${tile ? ' ' + tile : ''}" aria-hidden="true">${ic[0] === '<' ? ic : icon(ic)}</span><span class="act-body"><span class="act-t">${t[0]}</span>${t[1] ? `<span class="act-s">${esc(t[1])}</span>` : ''}</span><time datetime="${day}T${pad(d.getHours())}:${pad(d.getMinutes())}">${esc(time)}</time></li>`);
  }
  const more = lib.activity.filter(a => !a._local).length < (lib.activityTotal || 0) - lib.activity.filter(a => a._local).length && lib.activity.length < 1000;
  return `<section class="lib-sec" id="lib-activity"><div class="lh"><h3>Recent activity</h3><span>${(lib.activityTotal || 0).toLocaleString()}</span></div>
    ${groups.length ? groups.map(g => `<h4 class="act-day">${esc(dayLabel(g.day))}</h4><ul class="group lib-acts">${g.items.join('')}</ul>`).join('')
      : empty('clock', 'Your study history appears here', 'Open a chapter and start reading. Progress is saved automatically.')}
    ${groups.length && more ? '<button class="btn btn-gray btn-wide" type="button" data-more-activity>Show more</button>' : ''}
  </section>`;
}

function progressSection() {
  const st = lib.stats || emptyStats();
  const read = (st.totals && +st.totals.chaptersRead) || 0;
  const test = (t, label) => {
    const books = state.books.filter(b => b.test === t);
    const total = books.reduce((s, b) => s + b.chapters.length, 0);
    let got = 0;
    const tiles = books.map(bk => {
      const p = bookProgress(bk.n); got += p.read;
      const hot = p.frac > .55, done = p.total && p.read >= p.total;
      return `<button class="lib-book${hot ? ' hot' : ''}${done ? ' done' : ''}" type="button" data-lib-book="${bk.n}" style="--p:${p.frac.toFixed(3)}" title="${esc(bk.name)}" aria-label="${esc(bk.name)}, ${p.read} of ${esc(plural(p.total, 'chapter'))} read"><span class="lb-name">${esc(bk.name)}</span><span class="lb-frac">${p.read}/${p.total}</span>${done ? icon('check') : ''}</button>`;
    }).join('');
    return `<div class="lib-testament"><h4><i class="${t.toLowerCase()}"></i>${label}<span>${got.toLocaleString()} of ${total.toLocaleString()}</span></h4><div class="lib-books">${tiles}</div></div>`;
  };
  return `<section class="lib-sec" id="lib-progress"><div class="lh"><h3>Bible progress</h3><span>${read.toLocaleString()} of ${TOTAL.toLocaleString()} chapters</span></div>
    ${test('OT', 'Old Testament')}${test('NT', 'New Testament')}</section>`;
}

function bookView(b) {
  const bk = bookOf(b); if (!bk) return homeView();
  const p = bookProgress(b);
  let secs = 0; const studied = [];
  for (let c = 1; c <= bk.chapters.length; c++) { const s = chapterState(b, c); if (!s) continue; secs += s.seconds; s.studied.forEach(v => studied.push([c, v])); }
  const subBits = [`${p.read} of ${plural(p.total, 'chapter')} read`];
  if (secs >= 60) subBits.push(fmtDuration(secs));
  if (studied.length) subBits.push(`${plural(studied.length, 'verse')} studied`);
  const cells = bk.chapters.map((n, i) => {
    const c = i + 1, s = chapterState(b, c), read = !!(s && s.read), part = !!(s && s.part), cur = b === state.book && c === state.chapter;
    const bits = [`Chapter ${c}`];
    if (read) bits.push(s.readAt ? `read ${dm(new Date(s.readAt))}` : 'read'); else bits.push(part ? 'started' : 'not started');
    if (s && s.studied.length) bits.push(`${plural(s.studied.length, 'verse')} studied`);
    if (cur) bits.push('open in the reader');
    return `<button class="pch${read ? ' read' : ''}${part ? ' part' : ''}${cur ? ' cur' : ''}" type="button" data-b="${b}" data-c="${c}" title="${plural(n, 'verse')}" aria-label="${esc(bits.join(', '))}"${marking ? ` aria-pressed="${read}"` : ''}${cur ? ' aria-current="true"' : ''}>${c}${read ? '<svg class="i pch-chk" aria-hidden="true" style="color:inherit"><use href="#i-check"/></svg>' : ''}</button>`;
  }).join('');
  const shown = studiedAll === b ? studied : studied.slice(0, STUDIED_MAX);
  const rest = studied.length - shown.length;
  return `<div class="navbar"><button class="back" type="button" data-lib-back>${icon('chev-left')}Library</button></div>
    <div class="lib-book-head"><div><h3 class="pc-title">${esc(bk.name)}</h3><p class="pc-sub">${esc(subBits.join(' · '))}</p></div>
      <div class="segmented sm" id="lib-mode" role="radiogroup" aria-label="When you tap a chapter"><span class="seg-ind" aria-hidden="true"></span><button type="button" role="radio" data-lib-mode="open" aria-checked="${!marking}" tabindex="${marking ? -1 : 0}">Open</button><button type="button" role="radio" data-lib-mode="mark" aria-checked="${marking}" tabindex="${marking ? 0 : -1}">Mark read</button></div></div>
    <div class="chgrid lib-chgrid${marking ? ' marking' : ''}">${cells}</div>
    <div class="lib-legend" aria-hidden="true"><span><i class="read"></i>Read</span><span><i class="part"></i>Started</span><span><i></i>Not started</span></div>
    <div class="actions"><button class="btn btn-tinted sm" type="button" data-lib-markbook="read"${p.read >= p.total ? ' disabled' : ''}>Mark all as read</button><button class="btn btn-plain sm" type="button" data-lib-markbook="unread"${p.read ? '' : ' disabled'}>Clear marks</button></div>
    ${studied.length ? `<div class="lh"><h3>Studied in ${esc(bk.name)}</h3><span>${esc(plural(studied.length, 'verse'))}</span></div><div class="topic-chips" id="lib-studied">${shown.map(([c, v]) => `<button class="chip" type="button" data-lib-go="${b}.${c}.${v}">${esc(refName(b, c, v))}</button>`).join('')}${rest > 0 ? `<button class="chip more" type="button" data-more-studied aria-label="Show all ${studied.length.toLocaleString()} studied verses">${rest.toLocaleString()} more${icon('chev-down')}</button>` : ''}</div>` : ''}`;
}

let previewSeq = 0;
function afterRender(body, fsel, alt) {
  const seg = $('#lib-mode', body) || $('#lm-mode', body); if (seg) placeInd(seg);
  if (fsel) { let el = $(fsel, body); if ((!el || el.disabled) && alt) el = alt(body); focusIn(el); }
  if (focusBm) {
    const li = $(`li[data-bm="${cssEsc(focusBm)}"]`, body);
    if (li) {
      focusBm = null;
      const cell = $('.cell', li);
      setTimeout(() => {
        if (!cell.isConnected) return;
        li.scrollIntoView({ block: 'center', behavior: 'auto' });
        cell.focus({ preventScroll: true });
        // a soft glow so the row is found even when the focus ring stays hidden (pointer users)
        const tint = getComputedStyle(document.documentElement).getPropertyValue('--accent-tint-2').trim();
        if (tint && !RM.matches && li.animate) li.animate([{ backgroundColor: tint }, { backgroundColor: tint, offset: .4 }, { backgroundColor: 'transparent' }], { duration: 1800, easing: 'ease-out' });
      }, 60);
    }
  }
  // verse previews, filled one by one (bundled text is cached per book)
  const seq = ++previewSeq;
  const q = $('[data-lc-q]', body);
  const jobs = [];
  if (q) jobs.push([q, q.dataset.lcQ, 160]);
  $$('[data-preview]', body).forEach(el => jobs.push([el, el.dataset.preview, 110]));
  (async () => {
    for (const [el, ref, n] of jobs) {
      if (seq !== previewSeq || !el.isConnected) return;
      if (el.textContent) continue;
      const p = parseRef(ref); if (!p) continue;
      try { const r = await previewText(p.b, p.c, p.v || 1); if (el.isConnected) el.textContent = clip(r.text, n) || ' '; } catch (e) { if (el.isConnected) el.textContent = ' '; }
    }
  })();
}

// ------------------------------------------------------------ My links: the home section and My map (links-spec §3.7)
const LREF_RX = /^(\d{1,2})\.(\d{1,3})\.(\d{1,3})(?:-(\d{1,3}))?$/;
/** A link end ('43.1.29' or the range '43.1.29-31') as {b, c, v, ve}, or null. Local, so activity rows need no links.js. */
function lkRef(s) {
  const m = LREF_RX.exec(String(s || '')); if (!m) return null;
  const b = +m[1], c = +m[2], v = +m[3], ve = m[4] ? +m[4] : v, bk = bookOf(b);
  return bk && c >= 1 && c <= bk.chapters.length && v >= 1 && ve >= v && ve <= bk.chapters[c - 1] ? { b, c, v, ve } : null;
}
const lkName = r => (r ? S.refLabel(r.b, r.c, r.v, r.ve > r.v ? r.ve : 0) : '');
const lkOk = () => !!(lnk && lnk.links && lnk.links.byId && typeof lnk.phrase === 'function');
/** This scope's links ([] until links.js holds them for it). */
const myLinks = () => (lkOk() && lnk.links.scope === curScope() ? [...lnk.links.byId.values()] : []);
/** This scope's highlights and comments ([] until marks.js holds them for it). */
const myMarks = () => (mrk && mrk.marks && mrk.marks.loaded && mrk.marks.scope === curScope() ? [...mrk.marks.byId.values()] : []);
/** The 'Highlights' figure: marks.js's own count once loaded (it has unsent marks), else the server's stats.totals.marks. */
function marksMade() {
  if (mrk && mrk.marks && mrk.marks.loaded && mrk.marks.scope === curScope()) return mrk.marks.byId.size;
  return Math.max(0, +(lib.stats && lib.stats.totals && lib.stats.totals.marks) || 0);
}
/** The 'Links made' figure: links.js's own count once loaded (it has unsent links), else the server's stats.totals.links. */
function linksMade() {
  if (lkOk() && lnk.links.loaded && lnk.links.scope === curScope()) return lnk.links.byId.size;
  return Math.max(0, +(lib.stats && lib.stats.totals && lib.stats.totals.links) || 0);
}
const typeLabel = id => { const t = lkOk() && lnk.TYPES.find(x => x.id === id); return id === 'custom' ? 'Custom' : t ? t.label : 'Related'; };
const byNewest = (a, z) => (z.created || 0) - (a.created || 0) || (z.updated || 0) - (a.updated || 0);

/** One link as a cell (home, My map's List): 'John 1:29 → Isaiah 53:7', sub = phrase · caption · tags, and a ⋯ button. */
function linkCell(l) {
  const f = lkRef(l.from), t = lkRef(l.to); if (!f || !t) return '';
  const fn = lkName(f), tn = lkName(t), both = l.dir === 'both';
  const sub = [esc(lnk.phrase(l, 'from')), l.label && l.type !== 'custom' ? `<b class="bm-label">${esc(l.label)}</b>` : '', l.tags.length ? esc(l.tags.map(x => '#' + x).join(' ')) : ''].filter(Boolean).join(' · ');
  return `<li class="lk-row" data-lk="${esc(l.id)}" data-bm-color="${esc(l.color)}"><button class="cell" type="button" data-lib-link="${esc(l.id)}"><span class="bm-rib" aria-hidden="true">${icon('link-node')}</span><span class="cell-body"><span class="cell-title">${esc(fn)} <span aria-hidden="true">${both ? '↔' : '→'}</span><span class="sr">${both ? ' and ' : ' to '}</span> ${esc(tn)}</span><span class="cell-sub">${sub}</span></span><span class="cell-trail"><span class="vn" title="Linked ${esc(relTime(l.created))}">${esc(shortAge(l.created))}</span></span></button><button class="more-btn" type="button" data-lk-menu aria-haspopup="dialog" aria-expanded="false" aria-label="Edit link: ${esc(fn)} to ${esc(tn)}" title="Edit link">${icon('ellipsis')}</button></li>`;
}
function linksSection() {
  if (!lkOk()) return '';
  const all = myLinks(), n = all.length;
  return `<section class="lib-sec" id="lib-links"><div class="lh"><h3>My links</h3><span>${n.toLocaleString()}</span></div>
    ${n ? `<ul class="group av lib-lks">${all.sort(byNewest).slice(0, 5).map(linkCell).join('')}</ul><div class="lib-lk-open"><button class="btn btn-tinted sm" type="button" data-lib-links>${icon('link-node')}Open my map</button></div>`
      : empty('link-node', 'No links yet', 'Select a verse and press c to connect it to another.', 'indigo')}
  </section>`;
}
/** Close the Library and show a verse's links: navigate, select it, open the study panel's Mine tab. */
function openInMine(b, c, v) {
  closeLib();
  A?.navigate?.(b, c, v);
  A?.select?.(v, { tab: 'mine' });
}
/**
 * Edit from the Library's ⋯ menu: the composer lives in the study panel's Mine tab, behind this dialog. Show the link's
 * first verse there, then open the editor from its card once drawn (links.js's own ⋯ menu, Edit).
 */
function editInMine(l) {
  const f = lkRef(l.from); if (!f) return;
  openInMine(f.b, f.c, f.v);
  const until = Date.now() + 3000;
  const step = () => {
    // after the Library has closed: closing hands focus back to what opened it, which would take it from the composer
    const more = !libDialog()?.open && document.querySelector(`#drawer .mine-card[data-link="${cssEsc(l.id)}"] [data-link-menu]`);
    if (!more) { if (Date.now() < until) setTimeout(step, 60); return; }
    more.click();
    document.querySelector('.link-menu [data-lmi="edit"]')?.click();
  };
  setTimeout(step, 60);
}

// My map: filters, the List view and the Network canvas
const mapF = { mode: lsGet('bs-map-mode') === 'list' ? 'list' : 'network', type: '', tag: '', q: '' };
let mapAllTags = false, mapAllRows = false, mapQT = 0;
const TAGS_MAX = 12, ROWS_MAX = 300;
const hayCache = new Map(); // id -> [updated, text]: what the search field matches
function mapMatches(l) {
  if (mapF.type && l.type !== mapF.type) return false;
  if (mapF.tag && !l.tags.includes(mapF.tag)) return false;
  const q = mapF.q.trim().replace(/^#/, '').toLowerCase(); if (!q) return true;
  let h = hayCache.get(l.id);
  if (!h || h[0] !== l.updated) hayCache.set(l.id, h = [l.updated, [lkName(lkRef(l.from)), lkName(lkRef(l.to)), l.label, l.note, ...l.tags].join('\n').toLowerCase()]);
  return h[1].includes(q);
}
function mapView() {
  const seg = ['network', 'list'].map(m => `<button type="button" role="radio" data-lm-mode="${m}" aria-checked="${mapF.mode === m}" tabindex="${mapF.mode === m ? 0 : -1}">${m === 'network' ? 'Network' : 'List'}</button>`).join('');
  return `<div class="navbar"><button class="back" type="button" data-lib-back>${icon('chev-left')}Library</button></div>
    <div id="lib-map">
      <div class="lib-book-head lm-head"><div><h3 class="pc-title">My map</h3><p class="pc-sub" id="lm-sub"></p></div>
        <div class="lm-tools"><label class="field sm lm-q">${icon('search')}<input type="search" id="lm-q" placeholder="Search my links" aria-label="Search my links" autocomplete="off" spellcheck="false" value="${esc(mapF.q)}"></label>
        <div class="segmented sm" id="lm-mode" role="radiogroup" aria-label="Show my links as"><span class="seg-ind" aria-hidden="true"></span>${seg}</div></div></div>
      <div class="lm-filters" id="lm-filters"></div>
      <div id="lm-main"></div>
    </div>`;
}
function mapFilters(all) {
  const types = new Map(), tags = new Map();
  for (const l of all) { types.set(l.type, (types.get(l.type) || 0) + 1); for (const t of l.tags) tags.set(t, (tags.get(t) || 0) + 1); }
  if (mapF.type && !types.has(mapF.type)) mapF.type = ''; // its last link is gone
  if (mapF.tag && !tags.has(mapF.tag)) mapF.tag = '';
  const chip = (attr, val, label, n, on) => `<button class="chip" type="button" ${attr}="${esc(val)}" aria-pressed="${on}">${esc(label)}${n ? `<span class="lm-n">${n.toLocaleString()}</span>` : ''}</button>`;
  const tagList = [...tags].sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
  let shown = mapAllTags ? tagList : tagList.slice(0, TAGS_MAX);
  if (mapF.tag && !shown.some(x => x[0] === mapF.tag)) shown = [...shown, tagList.find(x => x[0] === mapF.tag)];
  const rest = tagList.length - shown.length;
  return `<div class="lm-chips" role="group" aria-label="Type">${chip('data-lm-type', '', 'All types', 0, !mapF.type)}${lnk.TYPES.filter(t => types.has(t.id)).map(t => chip('data-lm-type', t.id, typeLabel(t.id), types.get(t.id), mapF.type === t.id)).join('')}</div>
    ${tagList.length ? `<div class="lm-chips" role="group" aria-label="Tag">${chip('data-lm-tag', '', 'All tags', 0, !mapF.tag)}${shown.map(([t, n]) => chip('data-lm-tag', t, '#' + t, n, mapF.tag === t)).join('')}${rest > 0 ? `<button class="chip more" type="button" data-lm-moretags aria-label="Show all ${tagList.length.toLocaleString()} tags">${rest.toLocaleString()} more${icon('chev-down')}</button>` : ''}</div>` : ''}`;
}
/** The List view: grouped by tag, most used first, untagged last (a link with two tags is under both). */
function mapList(shown) {
  const groups = new Map(), none = [];
  for (const l of shown.sort(byNewest)) {
    if (!l.tags.length) { none.push(l); continue; }
    for (const t of l.tags) if (!mapF.tag || t === mapF.tag) { if (!groups.has(t)) groups.set(t, []); groups.get(t).push(l); }
  }
  const order = [...groups].sort((a, z) => z[1].length - a[1].length || a[0].localeCompare(z[0]));
  if (none.length) order.push(['', none]);
  let left = mapAllRows ? Infinity : ROWS_MAX, html = '';
  order.forEach(([t, ls], i) => {
    const take = ls.slice(0, Math.max(0, left)); left -= take.length;
    if (take.length) html += `<h4 class="act-day lm-gh" id="lm-g${i}">${t ? '#' + esc(t) : 'Untagged'}<span>${ls.length.toLocaleString()}</span></h4><ul class="group av lib-lks" aria-labelledby="lm-g${i}">${take.map(linkCell).join('')}</ul>`;
  });
  const rows = order.reduce((n, g) => n + g[1].length, 0);
  return html + (!mapAllRows && rows > ROWS_MAX ? `<button class="btn btn-gray btn-wide" type="button" data-lm-allrows>Show ${(rows - ROWS_MAX).toLocaleString()} more</button>` : '');
}
/**
 * Fill My map's subtitle, filters and main area in place: the search field, the canvas and its layout stay. Called after
 * the view is rendered, on filter changes and on bs:links-changed (through renderLibrary).
 */
let mapSig = '';
function paintMap() {
  const body = document.getElementById('library-body'), root = body && $('#lib-map', body); if (!root || !lkOk()) return;
  // a library reload (tracker events, another window) changes nothing here: keep the list and the canvas as they are
  const sig = [linksVer, curScope(), mapF.mode, mapF.type, mapF.tag, mapF.q, mapAllTags, mapAllRows].join('|');
  if (sig === mapSig && (mapF.mode === 'list' || NET.cv)) return;
  mapSig = sig;
  const qf = $('#lm-q', root); if (qf && qf.value !== mapF.q && document.activeElement !== qf) qf.value = mapF.q; // openLibrary cleared it
  const ae = document.activeElement, mine = root.contains(ae) && ae.id !== 'lm-q' && ae.id !== 'lm-canvas';
  const fsel = mine ? focusSel(ae) : null, alt = mine ? focusAlt(ae) : null;
  const all = myLinks(), shown = all.filter(mapMatches), main = $('#lm-main', root);
  const verses = new Set(); for (const l of shown) for (const r of [lkRef(l.from), lkRef(l.to)]) if (r) verses.add(`${r.b}.${r.c}.${r.v}`);
  $('#lm-sub', root).textContent = !all.length ? 'Your connections between verses' : `${shown.length === all.length ? plural(all.length, 'link') : `${shown.length.toLocaleString()} of ${plural(all.length, 'link')}`} · ${plural(verses.size, 'verse')}`;
  $('#lm-filters', root).innerHTML = all.length ? mapFilters(all) : '';
  if (!all.length) { stopNet(); main.innerHTML = empty('link-node', 'No links yet', 'Select a verse and press c to connect it to another.', 'indigo'); }
  else if (!shown.length) { stopNet(); main.innerHTML = empty('search', 'No links match', 'Try another type or tag, or clear the search.') + '<div class="actions lm-clear"><button class="btn btn-tinted sm" type="button" data-lm-clear>Clear filters</button></div>'; }
  else if (mapF.mode === 'list') { stopNet(); main.innerHTML = mapList(shown); }
  else { if (!NET.cv || !main.contains(NET.cv)) netMount(main); netData(all, shown); }
  if (fsel && !root.contains(document.activeElement)) { let el = $(fsel, body); if ((!el || el.disabled) && alt) el = alt(body); focusIn(el); }
}
function setMapMode(mode) {
  if (mode !== 'network' && mode !== 'list') return;
  mapF.mode = mode; lsSet('bs-map-mode', mode);
  setRadio($('#lm-mode'), b => b.dataset.lmMode === mode);
  paintMap();
}
function setMapFilter(k, val) {
  mapF[k] = mapF[k] === val ? '' : val; // the pressed chip again: All
  mapAllRows = false; NET.auto = true;
  paintMap();
}

// Network: canvas force layout (velocity Verlet, capped), seeded by canon position: Old Testament left, New Testament right
const TAU = Math.PI * 2;
const NET = {
  el: null, cv: null, ctx: null, ro: null, raf: 0, timer: 0, w: 0, h: 0, dpr: 1, col: null, font: '',
  nodes: [], byKey: new Map(), edges: [], sig: '', ver: -1, scope: '', s: 26, alpha: 0, ticks: 0,
  vis: [], visE: [], byCol: new Map(), labels: [], k: 1, tx: 0, ty: 0, fitK: 1, auto: true,
  hover: null, focus: null, kbd: false, pts: new Map(), drag: null, pinch: null,
  frames: 0, frameMs: 0, maxFrameMs: 0, // for QA: the cost of the last and the slowest frame (links-spec: ≤ 16 ms at 2,000 edges)
};
const posCache = new Map(); // node key -> [x, y]: a settled layout opens the same way again in this session
let canonOff = null;
function canonIdx(b, c, v) {
  if (!canonOff) { canonOff = new Map(); let n = 0; for (const bk of state.books) { const cs = []; for (const k of bk.chapters) { cs.push(n); n += k; } canonOff.set(bk.n, cs); } canonOff.total = n; }
  const cs = canonOff.get(b); return cs ? cs[c - 1] + v - 1 : 0;
}
const hash01 = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

function netMount(main) {
  stopNet();
  main.innerHTML = `<div class="lm-net" id="lm-net"><canvas id="lm-canvas" tabindex="0" role="img"></canvas>
      <div class="lm-zoom" role="group" aria-label="Zoom"><button type="button" data-lm-zoom="in" aria-label="Zoom in" title="Zoom in">${icon('zoom-in')}</button><button type="button" data-lm-zoom="out" aria-label="Zoom out" title="Zoom out">${icon('zoom-out')}</button><button type="button" data-lm-zoom="fit" title="Fit the map to the window">Fit</button></div>
      <div class="lm-tip" hidden></div><p class="sr" id="lm-live" aria-live="polite"></p></div>
    <p class="lm-legend" aria-hidden="true"><span><i class="ot"></i>Old Testament</span><span><i class="nt"></i>New Testament</span><span>Lines in each link’s colour · arrows for one-way links</span></p>`;
  NET.el = $('#lm-net', main); NET.cv = $('#lm-canvas', main); NET.ctx = NET.cv.getContext('2d'); NET.col = null; NET.auto = true;
  NET.w = NET.h = 0; // a new canvas: size its backing store even when the last one had the same size
  NET.hover = null; NET.kbd = false; NET.pts.clear(); NET.drag = NET.pinch = null;
  const cv = NET.cv;
  cv.addEventListener('pointerdown', netDown);
  cv.addEventListener('pointermove', netMove);
  cv.addEventListener('pointerup', netUp);
  cv.addEventListener('pointercancel', netCancel);
  cv.addEventListener('pointerleave', () => { if (!NET.drag) netHover(null); });
  cv.addEventListener('wheel', e => { e.preventDefault(); netZoom(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.offsetX, e.offsetY); }, { passive: false });
  cv.addEventListener('keydown', netKey);
  cv.addEventListener('focus', () => { NET.kbd = true; netDraw(); });
  cv.addEventListener('blur', () => { NET.kbd = false; netDraw(); });
  NET.ro = new ResizeObserver(() => netSize());
  NET.ro.observe(NET.el);
  netSize();
}
/** Stop drawing and simulating (the view changed or the Library closed). The graph and its positions are kept. */
function stopNet() {
  if (NET.raf) cancelAnimationFrame(NET.raf);
  clearTimeout(NET.timer);
  NET.raf = NET.timer = 0;
  if (NET.ro) NET.ro.disconnect();
  NET.ro = NET.el = NET.cv = NET.ctx = null;
}
function netSize() {
  const el = NET.el, cv = NET.cv; if (!el || !cv) return;
  const w = el.clientWidth, h = el.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
  if (!w || !h) return;
  if (w !== NET.w || h !== NET.h || dpr !== NET.dpr) { NET.w = w; NET.h = h; NET.dpr = dpr; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  if (NET.auto) netFit();
  netDraw();
}
/** The graph of every link (filters only hide parts of it, so the layout never moves when they change). */
function netBuild(all) {
  if (NET.scope !== curScope()) { posCache.clear(); NET.byKey = new Map(); NET.sig = ''; }
  const old = NET.byKey, byKey = new Map(), nodes = [], edges = [];
  const node = r => {
    const key = `${r.b}.${r.c}.${r.v}`;
    let n = byKey.get(key);
    if (!n) { // every field up front (and none deleted): the layout loop stays on V8's fast path
      n = { key, b: r.b, c: r.c, v: r.v, ord: canonIdx(r.b, r.c, r.v), range: null, plain: false, i: 0, label: '', tw: 0, x: 0, y: 0, vx: 0, vy: 0, x0: 0, y0: 0, sx: 0, sy: 0, r: 0, ls: [], vls: [], prev: old.get(key) || null };
      byKey.set(key, n); nodes.push(n);
    }
    if (r.ve > r.v) { if (!n.range) n.range = r; } else n.plain = true;
    return n;
  };
  // a range link's node is its first verse, labelled with the range (unless a link uses that verse on its own)
  for (const l of all) { const f = lkRef(l.from), t = lkRef(l.to); if (!f || !t) continue; const a = node(f), z = node(t); edges.push({ a, z, l, w: 1 }); }
  nodes.sort((p, q) => p.ord - q.ord); // canon order: the keyboard's order, and a simulation that runs the same way each time
  canonIdx(1, 1, 1);
  const N = nodes.length, s = NET.s, W = Math.max(520, s * Math.sqrt(N * 2)), H = W / 2, total = canonOff.total || 31102; // as wide as the canvas
  let fresh = 0;
  nodes.forEach((n, i) => {
    n.i = i; n.label = lkName(n.plain || !n.range ? { b: n.b, c: n.c, v: n.v, ve: n.v } : n.range); n.tw = 0;
    n.x0 = n.ord / total * W; n.y0 = (0.12 + 0.76 * hash01(n.key)) * H;
    const p = n.prev ? [n.prev.x, n.prev.y] : posCache.get(n.key);
    if (p) { n.x = p[0]; n.y = p[1]; } else { n.x = n.x0; n.y = n.y0; fresh++; }
    n.prev = null;
  });
  for (const e of edges) { e.a.ls.push(e.l); if (e.z !== e.a) e.z.ls.push(e.l); }
  for (const e of edges) e.w = Math.max(1, Math.min(e.a.ls.length, e.z.ls.length)); // a hub's springs are weaker
  const sig = edges.map(e => `${e.a.key}>${e.z.key}`).sort().join('|');
  const left = NET.ver >= 0 && NET.scope === curScope() ? NET.alpha : 0; // a layout the Library closed on before it settled
  // a new layout settles from the canon seed; new verses settle in among the placed ones; a recolour moves nothing
  NET.alpha = Math.max(left, fresh === N ? 1 : fresh ? 0.3 : sig !== NET.sig ? 0.12 : 0);
  if (NET.alpha >= 1) NET.ticks = 0;
  Object.assign(NET, { nodes, byKey, edges, sig, ver: linksVer, scope: curScope(), H, W });
}
/** Show the links that pass the filters (all: every link; shown: the filtered ones) and start or resume the layout. */
function netData(all, shown) {
  if (NET.ver !== linksVer || NET.scope !== curScope()) netBuild(all);
  const ids = new Set(shown.map(l => l.id)), on = new Set();
  NET.visE = NET.edges.filter(e => ids.has(e.l.id));
  for (const n of NET.nodes) n.vls = [];
  NET.byCol = new Map(COLORS.map(c => [c, []]));
  for (const e of NET.visE) { on.add(e.a); on.add(e.z); e.a.vls.push(e.l); if (e.z !== e.a) e.z.vls.push(e.l); (NET.byCol.get(e.l.color) || NET.byCol.get('blue')).push(e); }
  NET.vis = NET.nodes.filter(n => on.has(n));
  NET.labels = NET.vis.slice().sort((a, z) => z.vls.length - a.vls.length || a.ord - z.ord);
  if (NET.focus && !on.has(NET.focus)) NET.focus = null;
  if (NET.hover && !on.has(NET.hover)) netHover(null);
  const ot = NET.vis.filter(n => n.b <= 39).length;
  NET.cv?.setAttribute('aria-label', `Network of ${plural(NET.visE.length, 'link')} between ${plural(NET.vis.length, 'verse')}: ${ot.toLocaleString()} in the Old Testament on the left, ${(NET.vis.length - ot).toLocaleString()} in the New Testament on the right. Arrow keys move between the verses in canon order and Enter opens one. The List view has the same links as text.`);
  if (NET.auto) netFit();
  netRun();
}
function netRun() {
  if (!NET.cv) return;
  if (NET.alpha > 0 && RM.matches) { netSettle(); return; } // reduced motion: compute, then draw once
  netFrameSoon();
}
const netFrameSoon = () => { if (!NET.raf && NET.cv) NET.raf = requestAnimationFrame(netFrame); };
function netFrame() {
  NET.raf = 0;
  if (!NET.cv || !NET.cv.isConnected) { stopNet(); return; }
  const t0 = performance.now();
  if (NET.alpha > 0 && !RM.matches) { let nt = 0; do { netTick(); nt++; } while (NET.alpha > 0 && performance.now() - t0 < 6); NET.tickMs = (performance.now() - t0) / nt; }
  if (NET.auto) netFit();
  const t1 = performance.now();
  netDraw();
  const ms = performance.now() - t0; NET.drawMs = performance.now() - t1;
  NET.frames++; NET.frameMs = ms; NET.maxFrameMs = Math.max(NET.maxFrameMs, ms);
  if (NET.alpha > 0) netFrameSoon(); else netKeep();
}
/** Reduced motion: run the layout to rest in slices (no frames drawn), then draw it once. */
function netSettle() {
  clearTimeout(NET.timer);
  const t0 = performance.now();
  while (NET.alpha > 0 && performance.now() - t0 < 12) netTick();
  if (NET.alpha > 0) { NET.timer = setTimeout(netSettle, 0); return; }
  NET.timer = 0; netKeep();
  if (NET.auto) netFit();
  netFrameSoon();
}
function netKeep() { for (const n of NET.nodes) posCache.set(n.key, [n.x, n.y]); }
/**
 * One step: repulsion between near nodes (a grid of cells as wide as the cut-off), springs along links and a pull back
 * to the canon seed. The springs act mostly up and down, so a link from Isaiah to John draws the two verses level without
 * pulling them out of canon order. Typed arrays and a counting sort keep a step near a millisecond at 2,000 links.
 */
function netTick() {
  const N = NET.nodes, n = N.length, s = NET.s, cut = s * 3, cut2 = cut * cut, L = s * 1.3, a = NET.alpha, kr = s * 1.2 * a;
  if (!NET.X || NET.X.length !== n) { NET.X = new Float64Array(n); NET.Y = new Float64Array(n); NET.VX = new Float64Array(n); NET.VY = new Float64Array(n); NET.cell = new Int32Array(n); NET.order = new Int32Array(n); }
  const { X, Y, VX, VY, cell, order } = NET;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { const p = N[i]; X[i] = p.x; Y[i] = p.y; VX[i] = p.vx; VY[i] = p.vy; if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  const gw = Math.min(512, Math.floor((x1 - x0) / cut) + 1), gh = Math.min(512, Math.floor((y1 - y0) / cut) + 1), cells = gw * gh;
  const start = new Int32Array(cells + 1);
  for (let i = 0; i < n; i++) { const c = Math.min(gw - 1, Math.floor((X[i] - x0) / cut)) + Math.min(gh - 1, Math.floor((Y[i] - y0) / cut)) * gw; cell[i] = c; start[c + 1]++; }
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  const fill = start.slice(0, cells);
  for (let i = 0; i < n; i++) order[fill[cell[i]]++] = i;
  for (let i = 0; i < n; i++) {
    const c = cell[i], cx = c % gw, cy = (c - cx) / gw, xi = X[i], yi = Y[i];
    for (let gy = Math.max(0, cy - 1), gy1 = Math.min(gh - 1, cy + 1); gy <= gy1; gy++) {
      for (let gx = Math.max(0, cx - 1), gx1 = Math.min(gw - 1, cx + 1); gx <= gx1; gx++) {
        const cc = gx + gy * gw;
        for (let k = start[cc], e = start[cc + 1]; k < e; k++) {
          const j = order[k]; if (j <= i) continue;
          let dx = X[j] - xi, dy = Y[j] - yi, d2 = dx * dx + dy * dy;
          if (d2 >= cut2) continue;
          if (d2 < 0.01) { dx = ((i * 7 + j) % 13 - 6) * 0.05 + 0.01; dy = ((i * 3 + j) % 11 - 5) * 0.05; d2 = dx * dx + dy * dy; } // one spot: a fixed nudge
          const f = kr / d2;
          VX[i] -= dx * f; VY[i] -= dy * f; VX[j] += dx * f; VY[j] += dy * f;
        }
      }
    }
  }
  for (const e of NET.edges) {
    const p = e.a.i, q = e.z.i; if (p === q) continue;
    const dx = X[q] + VX[q] - X[p] - VX[p], dy = Y[q] + VY[q] - Y[p] - VY[p], d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - L) / d * a / e.w * 0.5;
    VX[q] -= dx * f * 0.1; VY[q] -= dy * f; VX[p] += dx * f * 0.1; VY[p] += dy * f;
  }
  let vmax = 0;
  for (let i = 0; i < n; i++) {
    const p = N[i];
    let vx = (VX[i] + (p.x0 - X[i]) * 0.05 * a) * 0.6, vy = (VY[i] + (p.y0 - Y[i]) * 0.004 * a) * 0.6;
    p.vx = vx; p.vy = vy; p.x = X[i] + vx; p.y = Y[i] + vy;
    const v2 = vx * vx + vy * vy; if (v2 > vmax) vmax = v2;
  }
  NET.ticks++;
  NET.alpha += -NET.alpha * 0.0228; // 1 → 0.001 in 300 steps
  if (NET.alpha < 0.001 || NET.ticks > 400 || (NET.ticks > 40 && vmax < s * s * 1e-4)) { NET.alpha = 0; NET.ticks = 0; for (const p of N) p.vx = p.vy = 0; }
}
function netFit() {
  const V = NET.vis; if (!V.length || !NET.w) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of V) { if (n.x < x0) x0 = n.x; if (n.x > x1) x1 = n.x; if (n.y < y0) y0 = n.y; if (n.y > y1) y1 = n.y; }
  const P = 40, k = Math.min((NET.w - 2 * P) / Math.max(1, x1 - x0), (NET.h - 2 * P) / Math.max(1, y1 - y0), 2.4);
  NET.k = NET.fitK = Math.max(0.02, k);
  NET.tx = NET.w / 2 - (x0 + x1) / 2 * NET.k; NET.ty = NET.h / 2 - (y0 + y1) / 2 * NET.k;
}
function netZoom(f, sx = NET.w / 2, sy = NET.h / 2) {
  const k = Math.max(NET.fitK * 0.5, Math.min(Math.max(NET.fitK * 16, 6), NET.k * f));
  NET.tx = sx - (sx - NET.tx) * k / NET.k; NET.ty = sy - (sy - NET.ty) * k / NET.k; NET.k = k;
  NET.auto = false; netHover(null); netFrameSoon();
}
function netColors() {
  const st = getComputedStyle(NET.el), g = n => st.getPropertyValue(n).trim();
  NET.col = { ot: g('--ot') || '#e8590c', nt: g('--nt') || '#11998e', label: g('--label') || '#1d1d1f', label2: g('--label-2') || '#6e6e73', surface: g('--bg-elev') || '#fff', focus: g('--focus') || g('--accent') || '#0071e3', link: Object.fromEntries(COLORS.map(c => [c, g('--bm-' + c) || '#007aff'])) };
  NET.font = g('--sans') || 'system-ui, sans-serif';
}
function netDraw() {
  const ctx = NET.ctx; if (!ctx || !NET.w) return;
  if (!NET.col) netColors();
  const C = NET.col, { w, h, k, tx, ty, dpr } = NET, V = NET.vis, E = NET.visE, many = E.length > 600, mid = E.length > 120;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  // dots grow with a verse's links and a little with the zoom; a small map gets larger ones
  const r0 = V.length < 60 ? 3.5 : 2.2, rk = Math.max(0.55, Math.min(1.25, Math.sqrt(k)));
  for (const n of V) { n.sx = n.x * k + tx; n.sy = n.y * k + ty; n.r = Math.min(12, (r0 + 1.3 * Math.sqrt(n.vls.length)) * rk); }
  const hot = (NET.kbd && NET.focus) || NET.hover;
  const edges = (list, arrow) => {
    ctx.beginPath();
    for (const e of list) { if (e.a !== e.z) { ctx.moveTo(e.a.sx, e.a.sy); ctx.lineTo(e.z.sx, e.z.sy); } }
    ctx.stroke();
    ctx.beginPath();
    for (const e of list) {
      if (e.l.dir !== 'to' || e.a === e.z) continue;
      const dx = e.z.sx - e.a.sx, dy = e.z.sy - e.a.sy, d = Math.sqrt(dx * dx + dy * dy); if (d < e.z.r + arrow * 2) continue;
      const ux = dx / d, uy = dy / d, px = e.z.sx - ux * (e.z.r + 1.5), py = e.z.sy - uy * (e.z.r + 1.5);
      ctx.moveTo(px, py); ctx.lineTo(px - ux * arrow * 1.6 - uy * arrow, py - uy * arrow * 1.6 + ux * arrow); ctx.lineTo(px - ux * arrow * 1.6 + uy * arrow, py - uy * arrow * 1.6 - ux * arrow); ctx.closePath();
    }
    ctx.fill();
  };
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.globalAlpha = hot ? (many ? 0.16 : 0.28) : many ? 0.42 : mid ? 0.62 : 0.85;
  ctx.lineWidth = many ? 1 : 1.5;
  for (const [c, list] of NET.byCol) if (list.length) { ctx.strokeStyle = ctx.fillStyle = C.link[c]; edges(list, many ? 3 : 4); }
  if (hot) { // the hovered or focused verse's links on top
    ctx.globalAlpha = 1; ctx.lineWidth = 2.25;
    for (const c of COLORS) { const list = NET.visE.filter(e => (e.a === hot || e.z === hot) && e.l.color === c); if (list.length) { ctx.strokeStyle = ctx.fillStyle = C.link[c]; edges(list, 4.5); } }
  }
  ctx.globalAlpha = 1; ctx.lineWidth = 1.5; ctx.strokeStyle = C.surface;
  for (const t of ['ot', 'nt']) {
    ctx.beginPath();
    for (const n of V) { if ((n.b <= 39) !== (t === 'ot') || n.sx < -20 || n.sy < -20 || n.sx > w + 20 || n.sy > h + 20) continue; ctx.moveTo(n.sx + n.r, n.sy); ctx.arc(n.sx, n.sy, n.r, 0, TAU); }
    ctx.fillStyle = C[t]; ctx.fill(); ctx.stroke();
  }
  // labels: the hot verse and its neighbours first, then the most linked verses while they do not overlap
  ctx.font = `600 11px ${NET.font}`; ctx.textBaseline = 'middle';
  const placed = [];
  const put = (n, strong) => {
    if (!n.tw) n.tw = ctx.measureText(n.label).width;
    const x = n.sx + n.r + 4, y = n.sy, box = [x - 2, y - 8, x + n.tw + 2, y + 8];
    if (box[2] < 0 || box[0] > w || box[3] < 0 || box[1] > h) return;
    if (!strong && placed.some(b => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3])) return;
    placed.push(box);
    ctx.lineWidth = 3; ctx.strokeStyle = C.surface; ctx.strokeText(n.label, x, y);
    ctx.fillStyle = strong ? C.label : C.label2; ctx.fillText(n.label, x, y);
  };
  if (hot) {
    put(hot, true);
    for (const e of NET.visE) if (e.a === hot || e.z === hot) put(e.a === hot ? e.z : e.a, false);
    ctx.beginPath(); ctx.arc(hot.sx, hot.sy, hot.r + 3.5, 0, TAU);
    ctx.lineWidth = 2; ctx.strokeStyle = NET.kbd && NET.focus === hot ? C.focus : C.label; ctx.stroke();
  }
  const max = V.length <= 40 ? 40 : Math.round(Math.min(80, 14 * Math.max(1, NET.k / NET.fitK)));
  for (let i = 0, n = 0; i < NET.labels.length && n < max; i++) { const before = placed.length; put(NET.labels[i], false); if (placed.length > before) n++; }
}
/** The verse under a point (screen px), or null. */
function netHit(x, y) {
  let best = null, bd = Infinity;
  for (const n of NET.vis) { const dx = n.sx - x, dy = n.sy - y, d = dx * dx + dy * dy, r = (n.r || 4) + 6; if (d < r * r && d < bd) { bd = d; best = n; } }
  return best;
}
const netPos = e => { const r = NET.cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
function netDown(e) {
  if (e.button > 0) return;
  NET.cv.setPointerCapture?.(e.pointerId);
  const [x, y] = netPos(e);
  NET.pts.set(e.pointerId, [x, y]);
  if (NET.pts.size === 2) {
    const [[ax, ay], [bx, by]] = [...NET.pts.values()];
    NET.pinch = { d: Math.hypot(bx - ax, by - ay) || 1, k: NET.k }; NET.drag = null;
  } else if (NET.pts.size === 1) NET.drag = { x, y, tx: NET.tx, ty: NET.ty, moved: false };
}
function netMove(e) {
  const [x, y] = netPos(e);
  if (NET.pts.has(e.pointerId)) NET.pts.set(e.pointerId, [x, y]);
  if (NET.pinch && NET.pts.size === 2) {
    const [[ax, ay], [bx, by]] = [...NET.pts.values()];
    netZoom(NET.pinch.k * (Math.hypot(bx - ax, by - ay) || 1) / NET.pinch.d / NET.k, (ax + bx) / 2, (ay + by) / 2);
    return;
  }
  const d = NET.drag;
  if (d) {
    if (!d.moved && Math.abs(x - d.x) + Math.abs(y - d.y) > 4) { d.moved = true; NET.cv.classList.add('drag'); netHover(null); }
    if (d.moved) { NET.tx = d.tx + x - d.x; NET.ty = d.ty + y - d.y; NET.auto = false; netFrameSoon(); }
    return;
  }
  if (e.pointerType !== 'touch') netHover(netHit(x, y), x, y);
}
function netUp(e) {
  const d = NET.drag, [x, y] = netPos(e);
  NET.pts.delete(e.pointerId);
  if (NET.pts.size < 2) NET.pinch = null;
  NET.cv.classList.remove('drag');
  if (d && !d.moved && !NET.pts.size) { const n = netHit(x, y); if (n) { NET.drag = null; openInMine(n.b, n.c, n.v); return; } }
  if (!NET.pts.size) NET.drag = null;
}
function netCancel(e) { NET.pts.delete(e.pointerId); NET.drag = NET.pinch = null; NET.cv?.classList.remove('drag'); }
/** What a verse's links say, for the tooltip and the live region: 'fulfils Isaiah 53:7'. */
function netSays(n, max) {
  return n.vls.slice(0, max).map(l => {
    const f = lkRef(l.from), onFrom = !!f && f.b === n.b && f.c === n.c && f.v === n.v;
    return [l, `${lnk.phrase(l, onFrom ? 'from' : 'to')} ${lkName(lkRef(onFrom ? l.to : l.from))}`];
  });
}
function netHover(n, x, y) {
  const tip = NET.el && $('.lm-tip', NET.el);
  const same = n === NET.hover;
  if (!same) { NET.hover = n; NET.cv?.classList.toggle('hot', !!n); netFrameSoon(); }
  if (!tip) return;
  if (!n) { tip.hidden = true; return; }
  if (!same || tip.hidden) {
    const more = n.vls.length - 4;
    tip.innerHTML = `<b>${esc(n.label)}</b>${netSays(n, 4).map(([l, t]) => `<span data-bm-color="${esc(l.color)}"><i></i>${esc(t)}</span>`).join('')}${more > 0 ? `<span>and ${more.toLocaleString()} more</span>` : ''}`;
    tip.hidden = false;
  }
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = `${Math.max(6, Math.min(NET.w - tw - 6, x + 14))}px`;
  tip.style.top = `${y + 16 + th > NET.h - 6 ? Math.max(6, y - th - 12) : y + 16}px`;
}
function netKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const V = NET.vis, i = NET.focus ? V.indexOf(NET.focus) : -1;
  let n = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = V[i < 0 ? 0 : Math.min(V.length - 1, i + 1)];
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = V[i < 0 ? 0 : Math.max(0, i - 1)];
  else if (e.key === 'Home' || e.key === 'End') n = V[e.key === 'Home' ? 0 : V.length - 1];
  else if ((e.key === 'Enter' || e.key === ' ') && NET.focus) { e.preventDefault(); openInMine(NET.focus.b, NET.focus.c, NET.focus.v); return; }
  else if (e.key === '+' || e.key === '=' || e.key === '-') { e.preventDefault(); netZoom(e.key === '-' ? 1 / 1.4 : 1.4); return; }
  else if (e.key === '0') { e.preventDefault(); NET.auto = true; netFit(); netFrameSoon(); return; }
  else return;
  e.preventDefault(); e.stopPropagation();
  if (!n) return;
  NET.focus = n; NET.kbd = true; netHover(null);
  const sx = n.x * NET.k + NET.tx, sy = n.y * NET.k + NET.ty;
  if (sx < 30 || sy < 30 || sx > NET.w - 30 || sy > NET.h - 30) { NET.tx = NET.w / 2 - n.x * NET.k; NET.ty = NET.h / 2 - n.y * NET.k; NET.auto = false; }
  const says = netSays(n, 3).map(x => x[1]), more = n.vls.length - says.length;
  const live = $('#lm-live'); if (live) live.textContent = `${n.label}, ${plural(n.vls.length, 'link')}: ${says.join('; ')}${more > 0 ? `; and ${more.toLocaleString()} more` : ''}.`;
  netFrameSoon();
}
/** For QA (links-spec §3.7 performance): the layout's state and frame costs. */
export function mapInfo() {
  return { nodes: NET.nodes.length, edges: NET.edges.length, shown: NET.visE.length, settled: NET.alpha === 0, frames: NET.frames, frameMs: +NET.frameMs.toFixed(2), drawMs: +(NET.drawMs || 0).toFixed(2), tickMs: +(NET.tickMs || 0).toFixed(2), maxFrameMs: +NET.maxFrameMs.toFixed(2), k: NET.k, auto: NET.auto };
}

// ------------------------------------------------------------ Library interactions
function goRef(ref) {
  const p = parseRef(ref); if (!p) return;
  closeLib();
  A?.navigate?.(p.b, p.c || 1, p.v || 0);
  A?.yieldToPage?.();
}
function resume() {
  const pos = currentPosition(); if (!pos) return;
  closeLib();
  if (A && typeof A.resume === 'function') { A.resume(pos); return; }
  A?.navigate?.(pos.b, pos.c, 0);
  setTimeout(() => { const el = pos.v ? document.getElementById('v' + pos.v) : null; if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' }); else window.scrollTo({ top: 0 }); }, 350);
}
function setMode(mode) {
  marking = mode === 'mark';
  const body = document.getElementById('library-body'); if (!body) return;
  const seg = $('#lib-mode', body);
  if (seg) setRadio(seg, b => b.dataset.libMode === mode);
  const grid = $('.lib-chgrid', body);
  if (grid) {
    grid.classList.toggle('marking', marking);
    $$('.pch', grid).forEach(p => { if (marking) p.setAttribute('aria-pressed', String(p.classList.contains('read'))); else p.removeAttribute('aria-pressed'); });
  }
}
async function markBook(how) {
  const b = view.b, bk = bookOf(b); if (!bk) return;
  const all = bk.chapters.map((_, i) => i + 1);
  if (how === 'read') { markChapters(b, all.filter(c => !chapterState(b, c)?.read), true); return; }
  const readCs = all.filter(c => chapterState(b, c)?.read);
  if (!readCs.length) return;
  const sc = curScope(); // what the dialog describes: never apply it to a profile switched to meanwhile (another window)
  const ok = fn('confirmDialog') ? (await ui.confirmDialog({ title: `Clear the read marks in ${bk.name}?`, body: `${plural(readCs.length, 'chapter')} will show as not read. Time studied, notes and bookmarks stay.`, ok: 'Clear marks', danger: true })).ok
    : window.confirm(`Clear the read marks in ${bk.name}?`);
  if (!ok) return;
  if (curScope() !== sc) { toast(SWITCHED_MSG); return; }
  markChapters(b, readCs, false);
  // 'Clear marks' is disabled now: #confirm can't hand focus back to it
  refocusAfterConfirm(body => $('[data-lib-markbook]:not([disabled])', body) || $('.lib-chgrid .pch', body) || $('.pc-title', body));
}
async function moreActivity(btn) {
  const server = lib.activity.filter(a => !a._local);
  const oldest = server.length ? server[server.length - 1].t : Date.now();
  if (btn.getAttribute('aria-disabled') === 'true') return;
  btn.setAttribute('aria-disabled', 'true'); btn.textContent = 'Loading…'; // not .disabled: that would drop focus to <body>
  const r = await call('GET', `/api/library?today=${localDay()}&activity=100&before=${oldest}`, null, { scoped: false });
  if (r.ok && r.data && typeof r.data.scope === 'string' && r.data.scope !== curScope()) {
    // another scope's history (the sign-in was lost meanwhile): never mix it into this list (see loadLibrary)
    btn.removeAttribute('aria-disabled'); btn.textContent = 'Show more';
    if (lostNow()) lostToast(); else checkScope(r.data.scope);
    return;
  }
  if (r.ok && r.data && Array.isArray(r.data.activity)) {
    const key = a => `${a.t}|${a.type}|${a.ref}`;
    const seen = new Set(lib.activity.map(key));
    r.data.activity.forEach(a => { if (a && typeof a.type === 'string' && !seen.has(key(a))) lib.activity.push(a); });
    if (Number.isInteger(r.data.activityTotal)) lib.activityTotal = r.data.activityTotal + lib.activity.filter(a => a._local).length;
    activityWanted = Math.min(1000, Math.max(activityWanted, lib.activity.length));
    renderLibrary({ keepScroll: true, still: true });
    return;
  }
  btn.removeAttribute('aria-disabled'); btn.textContent = 'Show more';
  failToast(r);
}

const RESET = {
  activity: { title: 'Clear activity history?', body: 'Your list of recent activity is removed. Reading progress, bookmarks and notes stay.', ok: 'Clear history', done: 'Activity history cleared.' },
  progress: { title: 'Reset reading progress?', body: 'This clears read marks, time studied, streaks and where you left off. Bookmarks and notes stay.', ok: 'Reset progress', done: 'Reading progress reset.' },
  bookmarks: { title: 'Remove all bookmarks?', body: 'Every bookmark is removed. Notes and reading progress stay.', ok: 'Remove bookmarks', done: 'All bookmarks removed.' },
};
async function reset(what) {
  const R = RESET[what]; if (!R) return;
  if (refuseWhileLost()) return;
  if (what === 'bookmarks' && lib.bookmarks.length) R.body = `${plural(lib.bookmarks.length, 'bookmark')} will be removed. Notes and reading progress stay.`;
  const sc = curScope(); // the dialog describes this profile: never wipe one switched to meanwhile (another window)
  const ok = fn('confirmDialog') ? (await ui.confirmDialog({ title: R.title, body: R.body, ok: R.ok, danger: true })).ok : window.confirm(R.title);
  if (!ok) return;
  if (curScope() !== sc) { toast(SWITCHED_MSG); return; }
  if (DRY) { toast(DRY_MSG); return; }
  if (refuseWhileLost()) return;
  const r = await call('POST', '/api/library/reset', { what: [what] });
  if (!r.ok) { failToast(r); return; }
  if (what === 'progress') { try { S.lsDel ? S.lsDel(posKey()) : localStorage.removeItem(posKey()); } catch (e) { /* ignore */ } }
  noteRev(r.data && r.data.rev, false); announce(r.data && r.data.rev);
  await loadLibrary({ activity: activityWanted });
  toast(R.done);
}
/** Download an export only when the server produced one (an error must not replace the app with a JSON page). */
async function downloadExport(url, fallback) {
  let r;
  try { r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' }); } catch (e) { toast(OFFLINE_MSG); return false; }
  if (!r.ok) { let data = null; try { data = await r.json(); } catch (e) { /* not JSON */ } failToast({ ok: false, status: r.status, data }); return false; }
  // the export routes answer for whoever is signed in now: after an expired session, the guest's data
  const sc = r.headers.get('X-BS-Scope');
  if (sc && sc !== curScope()) { if (lostNow()) lostToast(whose('profile')); else checkScope(sc); return false; } // account.js explains
  const m = /filename="?([^";]+)"?/i.exec(r.headers.get('Content-Disposition') || '');
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = m ? m[1] : fallback;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  return true;
}
const whose = what => u => `to export ${u.name ? u.name + '’s' : 'your'} ${what}`;
/** 'Export profile (JSON)': the Library menu and the Profile dialog (account.js) both download through this. */
export async function exportProfile() {
  if (DRY) { toast('Dry run: exports are turned off.'); return false; }
  if (lostNow()) { lostToast(whose('profile')); return false; }
  return downloadExport('/api/export/profile', 'bible-study-profile.json');
}
/** 'Export notes for Obsidian': unsent note edits go first (store.js); the same messages as the Notes tab's export. */
let exporting = false;
export async function exportNotes() {
  if (exporting) return false;
  exporting = true;
  try {
    const r = await S.exportObsidian();
    if (r.dry) toast('Dry run: exports are turned off.');
    else if (r.lost) lostToast(whose('notes'));
    else if (r.offline) toast(OFFLINE_MSG);
    else if (!r.ok && !r.mismatch) toast(`Export failed${r.data?.message ? ': ' + r.data.message : '.'}`);
    else if (r.pending) toast(`This export is missing ${plural(r.pending, 'unsaved change')}. Try again once your notes are saved.`);
    return !!r.ok;
  } finally { exporting = false; }
}
function moreMenu(btn) {
  if (!fn('openMenu')) return;
  const html = `<button type="button" role="menuitem" data-lm="export">Export profile (JSON)${icon('export')}</button>
    <button type="button" role="menuitem" data-lm="obsidian">Export notes for Obsidian${icon('export')}</button>
    <hr>
    <button type="button" role="menuitem" data-lm="activity">Clear activity history…</button>
    <button type="button" role="menuitem" class="danger" data-lm="progress">Reset reading progress…</button>
    <button type="button" role="menuitem" class="danger" data-lm="bookmarks">Remove all bookmarks…</button>`;
  ui.openMenu(btn, html, {
    label: 'Library options',
    onClick: e => {
      const it = e.target.closest('[data-lm]'); if (!it) return;
      const k = it.dataset.lm;
      if (k === 'export' || k === 'obsidian') {
        e.preventDefault(); closeMenuSafe(true);
        if (k === 'export') exportProfile(); else exportNotes();
        return;
      }
      closeMenuSafe(true); // focus on ⋯ first: #confirm hands it back there when it closes
      reset(k);
    },
  });
}

function onLibClick(e) {
  const t = e.target; if (!(t instanceof Element)) return;
  if (t.closest('#lib-more')) { moreMenu(t.closest('#lib-more')); return; }
  const bmMenu = t.closest('[data-bm-menu]');
  if (bmMenu) { const li = bmMenu.closest('li[data-bm]'); const bm = li && lib.bookmarks.find(x => x.id === li.dataset.bm); if (bm) openBookmarkMenu(bmMenu, bm); return; }
  const go = t.closest('[data-lib-go]'); if (go) { goRef(go.dataset.libGo); return; }
  // My links (home and My map)
  const lkMenu = t.closest('[data-lk-menu]');
  if (lkMenu) { const li = lkMenu.closest('li[data-lk]'), l = li && lkOk() && lnk.links.byId.get(li.dataset.lk); if (l && typeof lnk.openLinkMenu === 'function') lnk.openLinkMenu(lkMenu, l); return; }
  const lkGo = t.closest('[data-lib-link]');
  if (lkGo) { const l = lkOk() && lnk.links.byId.get(lkGo.dataset.libLink), f = l && lkRef(l.from); if (f) openInMine(f.b, f.c, f.v); return; }
  if (t.closest('[data-lib-links]')) {
    homeScroll = document.getElementById('library-body')?.scrollTop || 0;
    Object.assign(mapF, { type: '', tag: '', q: '' }); mapAllRows = false; NET.auto = true;
    view = { name: 'map' }; renderLibrary({ push: true });
    return;
  }
  const lm = t.closest('[data-lm-mode]'); if (lm) { setMapMode(lm.dataset.lmMode); return; }
  const lt = t.closest('[data-lm-type]'); if (lt) { setMapFilter('type', lt.dataset.lmType); return; }
  const lg = t.closest('[data-lm-tag]'); if (lg) { setMapFilter('tag', lg.dataset.lmTag); return; }
  if (t.closest('[data-lm-moretags]')) { mapAllTags = true; paintMap(); $$('#library-body [data-lm-tag]')[TAGS_MAX + 1]?.focus({ preventScroll: true }); return; }
  if (t.closest('[data-lm-allrows]')) { const n = $$('#library-body #lm-main li[data-lk]').length; mapAllRows = true; paintMap(); $$('#library-body #lm-main li[data-lk] .cell')[n]?.focus({ preventScroll: true }); return; }
  if (t.closest('[data-lm-clear]')) {
    Object.assign(mapF, { type: '', tag: '', q: '' }); const q = $('#lm-q'); if (q) q.value = '';
    NET.auto = true; paintMap(); q?.focus({ preventScroll: true });
    return;
  }
  const lz = t.closest('[data-lm-zoom]');
  if (lz) { const z = lz.dataset.lmZoom; if (z === 'fit') { NET.auto = true; netFit(); netFrameSoon(); } else netZoom(z === 'in' ? 1.4 : 1 / 1.4); return; }
  const bb = t.closest('[data-lib-book]');
  if (bb) {
    if (view.name === 'home') homeScroll = document.getElementById('library-body')?.scrollTop || 0;
    view = { name: 'book', b: +bb.dataset.libBook }; marking = false; renderLibrary({ push: true });
    return;
  }
  if (t.closest('[data-lib-back]')) {
    const from = view; view = { name: 'home' }; renderLibrary({ pop: true });
    const body = document.getElementById('library-body'); if (body) body.scrollTop = homeScroll;
    // with the last link deleted inside My map the home has no ‘Open my map’ button: its My links heading instead
    const el = from.name === 'map' ? ($('#library-body [data-lib-links]') || $('#library-body #lib-links h3')) : $(`#library-body [data-lib-book="${from.b}"]`);
    focusIn(el);
    // My map opened from a link's tag chip: the home was never scrolled to its button
    if (el && body && from.name === 'map') { const r = el.getBoundingClientRect(), br = body.getBoundingClientRect(); if (r.top < br.top || r.bottom > br.bottom) el.scrollIntoView({ block: 'center' }); }
    return;
  }
  if (t.closest('[data-lib-resume]')) { resume(); return; }
  const mode = t.closest('[data-lib-mode]'); if (mode) { setMode(mode.dataset.libMode); return; }
  const pch = t.closest('.lib-chgrid .pch');
  if (pch) {
    const b = +pch.dataset.b, c = +pch.dataset.c;
    if (marking) markChapters(b, c, !chapterState(b, c)?.read, { quiet: true });
    else { closeLib(); A?.navigate?.(b, c, 0); A?.yieldToPage?.(); }
    return;
  }
  const mb = t.closest('[data-lib-markbook]'); if (mb) { markBook(mb.dataset.libMarkbook); return; }
  if (t.closest('[data-more-activity]')) { moreActivity(t.closest('[data-more-activity]')); return; }
  if (t.closest('[data-more-bms]')) { showAllBms = true; renderLibrary({ keepScroll: true, still: true }); return; }
  if (t.closest('[data-more-studied]')) {
    studiedAll = view.b; renderLibrary({ keepScroll: true, still: true });
    // focus the first verse that was hidden (the button is gone)
    $$('#library-body #lib-studied .chip')[STUDIED_MAX]?.focus({ preventScroll: true });
    return;
  }
  const au = t.closest('[data-lib-auth]');
  if (au) { const mode2 = au.dataset.libAuth; import('./account.js').then(m => { if (typeof m.openAuth === 'function') m.openAuth(mode2); }).catch(() => toast(OFFLINE_MSG)); }
}

export function initLibrary(actions) {
  A = actions || A;
  if (inited) return;
  inited = true;
  const d = libDialog();
  if (d) {
    d.addEventListener('click', onLibClick);
    // ⋯ › Edit on a link in the Library: its composer is in the study panel, so go there first (links.js would open it unseen)
    d.addEventListener('click', e => {
      const it = e.target instanceof Element && e.target.closest('.link-menu [data-lmi="edit"]'); if (!it) return;
      const li = it.closest('.menu')?._opener?.closest?.('#library-body li[data-lk]'); if (!li) return;
      e.preventDefault(); e.stopPropagation();
      const l = lkOk() && lnk.links.byId.get(li.dataset.lk);
      closeMenuSafe(false);
      if (l) editInMine(l);
    }, true);
    d.addEventListener('keydown', e => {
      const g = e.target.closest && e.target.closest('#lib-mode, #lm-mode');
      if (g && e.target.matches('[role=radio]')) radioKeys(e, g, btn => (btn.dataset.lmMode ? setMapMode(btn.dataset.lmMode) : setMode(btn.dataset.libMode)));
    });
    d.addEventListener('input', e => {
      if (e.target.id !== 'lm-q') return;
      clearTimeout(mapQT);
      mapQT = setTimeout(() => { mapF.q = e.target.value; mapAllRows = false; NET.auto = true; paintMap(); }, 150);
    });
    d.addEventListener('close', () => { previewSeq++; stopNet(); netHover(null); });
  }
  try {
    chan = new BroadcastChannel('bs-sync');
    chan.addEventListener('message', e => {
      const m = e.data;
      if (!m || m.id === tabId() || m.scope !== curScope()) return;
      // {t:'auth'} for this scope (also this tab's own, store.broadcast posts on another channel object):
      // it is signed in again, so a library refused while the sign-in was lost can load now
      if (m.t === 'auth') { if (held) refreshSoon(); return; }
      if (m.t !== 'library') return;
      if (document.visibilityState === 'visible') refreshSoon(); else stale = true;
    });
  } catch (e) { chan = null; }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshIfStale(60000); });
  // My links: the home section, the stats tile and My map follow links.js (My map rebuilds its graph only while shown)
  document.addEventListener('bs:links-changed', () => { linksVer++; if (libOpen()) scheduleRender(); });
  document.addEventListener('bs:marks-changed', () => { if (libOpen()) scheduleRender(); }); // the Highlights tile, the rows' words
  // the map's canvas reads colour tokens: a theme switch repaints it
  const repaint = () => { NET.col = null; if (NET.cv) netFrameSoon(); };
  try { new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); } catch (e) { /* no observer */ }
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaint); } catch (e) { /* old Safari */ }
  // the day rolled over while the page was open: the day-based figures need the server's view
  setInterval(() => { if (lib.loaded && base && base.today !== localDay()) refreshSoon(); }, 60000);
}
