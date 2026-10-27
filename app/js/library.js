// The Library (.design/profiles-spec.md §5.10) and the client model of the reader's library: bookmarks,
// read marks, time and verses studied, the last position and the activity log. The reader, the study
// sheet and the picker read it through bookmarkFor / chapterState / bookProgress; tracker.js feeds it
// through applyLocal so every signal shows at once, before the server has seen it.
import { state, bookOf, esc, previewText, clip, plural, divSlug, DRY, lsGet, lsSet, RM, cut } from './store.js';
import * as S from './store.js';
import * as ui from './ui.js';
import { icon } from './icons.js';
import { radioKeys, setRadio, placeInd, renderMd } from './drawer.js';
import * as S2 from './study.js';

// tracker.js is optional (main.js and account.js load it guarded): a broken one must not break the Library.
let tracker = null;
import('./tracker.js').then(m => { tracker = m; }, e => { console.error('tracker.js failed to load', e); });
// My links (links-spec §3.7): the home section, the stats tile and My map. Optional, like tracker.js (links.js loads library.js the same way).
let lnk = null;
import('./links.js').then(m => { lnk = m; linksVer++; if (libOpen()) scheduleRender(); }, e => { console.error('links.js failed to load', e); });
// Highlights and comments (annotations-brief §3.4): the activity rows' words and the stats tile. Optional likewise.
let mrk = null;
import('./marks.js').then(m => { mrk = m; if (libOpen()) scheduleRender(); }, e => { console.error('marks.js failed to load', e); });
// Memorize (memorize-brief §4, §6): the bookmark menu's item, the home's Memory card and Library › Memory. Optional likewise.
let mem = null, memFailed = false;
import('./memory.js').then(m => { mem = m; if (libOpen()) scheduleRender(); }, e => { memFailed = true; console.error('memory.js failed to load', e); if (libOpen()) scheduleRender(); });
const LOCAL_TAB = Math.random().toString(16).slice(2, 18);
/** This tab's id on 'bs-sync' (tracker.js's when it is loaded, so both modules tag messages alike). */
const tabId = () => (tracker && typeof tracker.TAB_ID === 'string' ? tracker.TAB_ID : LOCAL_TAB);

export const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
const TOTAL = 1189;
const offlineMsg = () => S.offlineMsg(); // website wording when hosted (store.js)
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
    import('./account.js').then(m => { if (typeof m.openAuth === 'function') m.openAuth('signin', { email: u.email || '', reason: 'lost' }); }).catch(() => toast(offlineMsg()));
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
  if (!r.status || r.status >= 500 || !code) { toast(offlineMsg()); return; }
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
    totals: { seconds: 0, chaptersRead: 0, chaptersTotal: TOTAL, versesStudied: 0, chaptersStudied: 0, booksCompleted: 0, bookmarks: 0, notes: 0, studies: 0, daysStudied: 0 }, books: {} };
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
/** Home's book map (home-build brief §2): the chapters read, as Map<book, Set<chapter>>. */
export function chaptersRead() {
  const out = new Map();
  for (const [k, ch] of Object.entries(lib.chapters)) {
    if (!ch || !ch.read) continue;
    const [b, c] = k.split('.').map(Number), bk = bookOf(b);
    if (!bk || !(c >= 1 && c <= bk.chapters.length)) continue;
    let s = out.get(b); if (!s) out.set(b, s = new Set()); s.add(c);
  }
  return out;
}
/**
 * Home's tally: the streak as the Library's Streak card shows it (stats.streak, with this window's local days),
 * and the chapters read on each of the last `n` local days (each chapter's readAt), oldest first.
 */
export function readingWeek(n = 7) {
  const st = lib.stats || emptyStats(), k = st.streak || {}, now = new Date(), days = [];
  for (let i = n - 1; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i); days.push({ day: localDay(+d), ago: i, n: 0 }); }
  const at = new Map(days.map(x => [x.day, x]));
  for (const ch of Object.values(lib.chapters)) { if (ch && ch.read && +ch.readAt) { const x = at.get(localDay(+ch.readAt)); if (x) x.n++; } }
  return { current: +k.current || 0, longest: +k.longest || 0, studiedToday: !!k.studiedToday, days, total: days.reduce((s, x) => s + x.n, 0) };
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
    ${bm.v && mem ? `<button type="button" role="menuitem" data-bmi="memorize">${memOfBm(bm) ? 'Practise this verse' : 'Memorize this verse'}${icon('memorize')}</button>` : ''}
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
      closeMenuSafe(act === 'remove' || act === 'memorize');   // focus back on the opener; the Library then moves it to the next row
      const x = cur() || bm;
      if (act === 'go') { if (libOpen()) closeLib(); A?.navigate?.(x.b, x.c, x.v || 0); A?.yieldToPage?.(); }
      else if (act === 'library') openLibrary({ bookmark: x.id });
      else if (act === 'remove' && cur()) removeBookmark(x.id);
      else if (act === 'memorize') memorizeBm(x, anchor);
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
/** The memory verse a verse bookmark is (that verse, or a passage starting there, as the gutter's badge), or null. */
const memOfBm = bm => (mem && bm && bm.v ? mem.findByRef(`${bm.b}.${bm.c}.${bm.v}`) || mem.memoryFor(bm.b, bm.c, bm.v) : null);
/** The bookmark menu's Memorize this verse (memorize-brief §4), in the reader's translation; Practise when it is one. */
function memorizeBm(bm, anchor) {
  if (!mem) return;
  const have = memOfBm(bm);
  // the Library may redraw the row under the practice: its ⋯ again, by the bookmark's id
  if (have) mem.practise(have.id, { returnFocus: () => (anchor.isConnected ? anchor : $(`#library-body li[data-bm="${cssEsc(bm.id)}"] [data-bm-menu]`)) });
  else mem.memorize({ b: bm.b, c: bm.c, v: bm.v, tr: state.tr });
}

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

export function openLibrary({ book = null, bookmark = null, view: name = null, tag = null, study = null } = {}) {
  const d = libDialog(); if (!d) return;
  fn('closeMenu') && ui.closeMenu(false);
  closeCard({ restore: false });
  view = book && bookOf(+book) ? { name: 'book', b: +book } : name === 'map' ? { name: 'map' } : name === 'study' ? { ...stDefaults(), ...(study || {}) } : name === 'memory' ? { name: 'memory' } : { name: 'home' };
  if (view.name === 'memory') homeScroll = 0;
  if (view.name === 'map') { // a tag chip on a link card: My map showing that tag only
    Object.assign(mapF, { type: '', tag: typeof tag === 'string' ? tag : '', q: '' });
    mapAllRows = false; NET.auto = true; homeScroll = 0;
  }
  marking = false; focusBm = bookmark || null;
  if (focusBm && lib.bookmarks.findIndex(x => x.id === focusBm) >= 50) showAllBms = true;
  const wasOpen = libOpen();
  renderLibrary({ keepScroll: false, still: wasOpen, tab: true });
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
    sub.textContent = lib.offline && !lib.loaded ? `${who} · not connected` : S.hostedMsg(`${who} · saved on this computer`, au.signedIn ? `${who} · saved to your profile` : `${who} · not saved`);
  }
  // My map redraws in place (its search field, canvas and layout stay); a push, pop or another view rebuilds the body
  if (view.name === 'map' && !opts.push && !opts.pop && $('#lib-map', body)) { if (opts.keepScroll === false) body.scrollTop = 0; paintMap(); return; }
  // Study too: a reload or a change elsewhere repaints the open tab in place (focus kept through data-key); only a tab
  // switch or a fresh open (opts.tab) redraws the shell. The Studies tab belongs to studydoc.js while it is shown.
  if (view.name === 'study' && !opts.push && !opts.pop && !opts.tab) { if (view.tab === 'studies' && SV.docOwned) return; if ($('#lib-study', body)) { paintStudy(); return; } }
  stopNet();
  // keep focus on the same control across a re-render
  const ae = document.activeElement;
  const fsel = body.contains(ae) ? focusSel(ae) : null;
  const alt = body.contains(ae) ? focusAlt(ae) : null;
  const prevScroll = body.scrollTop;
  let html = '';
  try { html = view.name === 'book' ? bookView(view.b) : view.name === 'map' && lkOk() ? mapView() : view.name === 'study' ? studyView() : view.name === 'memory' ? memoryView() : homeView(); }
  catch (e) { console.error(e); html = empty('info', 'Something went wrong', esc(e.message)); }
  const cls = opts.push ? 'view push' : opts.pop ? 'view pop' : 'view';
  body.innerHTML = `<div class="${cls}"${opts.still ? ' style="animation:none"' : ''}>${html}</div>`;
  body.scrollTop = opts.keepScroll ? prevScroll : 0;
  if (view.name === 'map') { mapSig = ''; paintMap(); }
  if (view.name === 'study') paintStudy(); else { closeCard({ restore: false }); SV.docOwned = false; }
  afterRender(body, fsel, alt);
}

function focusSel(el) {
  if (!el || !el.closest) return null;
  const li = el.closest('li[data-bm]');
  if (li && el.matches('[data-bm-menu]')) return `li[data-bm="${cssEsc(li.dataset.bm)}"] [data-bm-menu]`;
  if (li && el.matches('[data-lib-go]')) return `li[data-bm="${cssEsc(li.dataset.bm)}"] [data-lib-go]`;
  // Library › Memory: a row's cell or ⋯ (by the verse's id), the pinned card's Practise or ⋯ (whichever verse is current)
  const mz = el.closest('li[data-mz]'), mzSub = el.matches('[data-mz-menu]') ? '[data-mz-menu]' : '[data-practise]';
  if (mz && el.matches('[data-mz-menu], [data-practise]')) return `li[data-mz="${cssEsc(mz.dataset.mz)}"] ${mzSub}`;
  if (el.closest('.mz-cur') && el.matches('[data-mz-menu], [data-practise]')) return `.mz-cur ${mzSub}`;
  const lk = el.closest('li[data-lk]');
  if (lk && el.matches('[data-lk-menu], [data-lib-link]')) return `li[data-lk="${cssEsc(lk.dataset.lk)}"] ${el.matches('[data-lk-menu]') ? '[data-lk-menu]' : '[data-lib-link]'}`;
  for (const a of ['data-lib-go', 'data-lib-book', 'data-lib-markbook', 'data-lib-mode', 'data-lib-auth', 'data-lm-type', 'data-lm-tag', 'data-lm-mode', 'data-lm-zoom', 'data-st-tab', 'data-key', 'data-st-f']) if (el.hasAttribute(a)) return `[${a}="${cssEsc(el.getAttribute(a))}"]`;
  if (el.matches('.pch[data-c]')) return `.pch[data-c="${cssEsc(el.dataset.c)}"]`;
  for (const a of ['data-lib-resume', 'data-lib-back', 'data-more-activity', 'data-more-bms', 'data-lib-links', 'data-lib-study', 'data-lib-memory', 'data-lm-moretags', 'data-lm-allrows', 'data-lm-clear']) if (el.hasAttribute(a)) return `[${a}]`;
  // a heading that focusAlt or refocusAfterConfirm moved focus to (a bookmark removed, then Undo): the same heading
  for (const s of ['#lib-bookmarks h3', '#lib-activity h3', '#lib-mem-h', '.pc-title']) if (el.matches(s)) return s;
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
  const mz = el.closest('li[data-mz]');
  if (mz) { // a memory verse made current (the pinned card now), or removed: the row after it, else before it (the mock's order)
    const sub = el.matches('[data-mz-menu]') ? '[data-mz-menu]' : '[data-practise]';
    const near = [mz.nextElementSibling, mz.previousElementSibling].filter(x => x && x.dataset && x.dataset.mz).map(x => `li[data-mz="${cssEsc(x.dataset.mz)}"] ${sub}`);
    return pick(`.mz-cur [data-practise="${cssEsc(mz.dataset.mz)}"]`, ...near, '.mz-cur [data-practise]', `li[data-mz] ${sub}`, '[data-lib-back]');
  }
  if (el.closest('.mz-cur')) return pick('.mz-cur [data-practise]', 'li[data-mz] [data-mz-menu]', '[data-lib-back]');
  if (el.matches('[data-lib-book], [data-lib-links], [data-lib-study], [data-lib-memory]')) return pick('[data-lib-back]', '#lib-mem-h');
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
  h += studyCard();
  h += memoryCard();
  if (!lib.loaded) {
    h += !lib.offline ? SKELETON
      : state.auth.hosted ? empty('info', 'Library is unavailable right now', esc(S.offlineMsg()))
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
  'link.add': ['link-node', 'indigo'], 'study.save': ['note', 'indigo'],
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
    case 'study.save': return [x.new ? `Made a study: ${esc(x.title || 'Untitled study')}` : 'Updated a study', x.new ? '' : x.title];
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
  if (mzRefocus) { const el = $(`li[data-mz="${cssEsc(mzRefocus)}"] [data-mz-menu]`, body); mzRefocus = null; if (el) focusIn(el); }
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
  // Library › Memory: the first words of KJV and BSB memory verses, once each (kept for later redraws)
  const mz = mem ? $$('[data-mz-first]:empty', body) : [];
  if (mz.length) (async () => {
    for (const el of mz) {
      if (seq !== previewSeq) return;
      const x = mem.getMemory(el.dataset.mzFirst); if (!x || !el.isConnected) continue;
      const k = mzKey(x);
      if (!mzWords.has(k)) { let t = ''; try { t = firstWords(await mem.memoryPreview(x)); } catch (e) { t = ''; } mzWords.set(k, t); }
      if (!el.isConnected) continue;
      const t = mzWords.get(k);
      if (t) el.innerHTML = scripture(t); else el.remove();
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
  NET.col = { ot: g('--ot') || '#e4570c', nt: g('--nt') || '#0f9489', label: g('--label') || '#1d1d1f', label2: g('--label-2') || '#646469', surface: g('--bg-elev') || '#fbfaf7', focus: g('--focus') || g('--accent') || '#0071e3', link: Object.fromEntries(COLORS.map(c => [c, g('--bm-' + c) || '#007aff'])) };
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
  try { r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' }); } catch (e) { toast(offlineMsg()); return false; }
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
  return downloadExport(`/api/export/profile?day=${localDay()}`, 'bible-study-profile.json'); // the file is named with the visitor's date, not the server's
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
    else if (r.offline) toast(offlineMsg());
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

// ============================================================ Study (study-build-brief §2): This month · Connected · Studies
// One shared context lives in the dialog's view state: {name: 'study', tab: 'month' | 'connected' | 'studies', mode:
// 'month' | '7' | '30' | '90', y, m (the month shown), end (the last day of a 7/30/90-day period, ms), theme (a topic
// name or '#tag'), book, kind, thread (a thread id), note (the open entry), viz: 'threads' | 'board'}. Switching tabs
// never loses it. study.js gives the entries (notes, highlights and comments as one list), the themes, threads and
// connections; reading comes from lib.chapters and lib.stats, links from links.js. The third tab, Studies, is
// studydoc.js, called by contract from paintStudies(). The views are drawn in place (paintStudy), as My map is.
const SV = {
  topics: null, xrefs: {}, texts: new Map(), memo: null, allMemo: null, seq: 0, lastRange: '', focusReq: false, docOwned: false, start: null,
  openTheme: null, renaming: null, openTag: null, featured: null, allThemes: false, allLife: false,   // This month
  boardCol: '', moved: new Map(), border: new Map(), ths: null, ro: null,                             // Connected
  card: null, hist: [], returnTo: null, drag: null,                                                   // the note card, a drag
};
const ST_TABS = [['month', 'This month'], ['connected', 'Connected'], ['studies', 'Studies']];
const KINDS = ['note', 'highlight', 'comment'], KINDP = { note: 'notes', highlight: 'highlights', comment: 'comments' };
const TC = { yellow: 'var(--t-yellow)', pink: 'var(--t-pink)', green: 'var(--t-green)', blue: 'var(--t-blue)', purple: 'var(--t-purple)', orange: 'var(--t-orange)' };
const DAY = 864e5, WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const num = n => (n < 10 ? WORDS[n] : n.toLocaleString());                 // prose: one to nine in words
const say = (n, one, many = one + 's') => `${num(n)} ${n === 1 ? one : many}`;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const andList = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const clone = x => JSON.parse(JSON.stringify(x));
const dayOf = t => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const addDays = (d, k) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + k);
const fmtMin = m => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
const fmtDay = t => dm(new Date(t));
const bookName = b => (bookOf(+b) || {}).name || '';
const proseBook = b => (+b === 19 ? 'the Psalms' : bookName(b));
const testament = b => ((bookOf(+b) || {}).test === 'OT' ? 'OT' : 'NT');
const isPhone = () => matchMedia('(max-width: 699px)').matches;
const live = msg => { const el = document.getElementById('st-live'); if (!el) return; el.textContent = ''; setTimeout(() => { el.textContent = msg; }, 30); };
/** '2 Oct', '2–22 Oct', or '28 Sep – 3 Oct' across months. */
function fmtSpan(a, z) {
  const A = new Date(a), Z = new Date(z);
  if (localDay(a) === localDay(z)) return fmtDay(a);
  return A.getMonth() === Z.getMonth() && A.getFullYear() === Z.getFullYear() ? `${A.getDate()}–${fmtDay(z)}` : `${fmtDay(a)} – ${fmtDay(z)}`;
}
/** '25–31 Oct', '3 Aug – 31 Oct', '3 Nov 2025 – 31 Jan 2026'; to: ' to ' for prose. */
function spanLabel(a, b, { to = false, year = false } = {}) {
  const YEAR = new Date().getFullYear(), yr = d => (year || d.getFullYear() !== YEAR ? ` ${d.getFullYear()}` : '');
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return `${a.getDate()}${to ? ' to ' : '–'}${b.getDate()} ${MON[b.getMonth()]}${yr(b)}`;
  const ya = a.getFullYear() !== b.getFullYear() ? ` ${a.getFullYear()}` : '';
  return `${a.getDate()} ${MON[a.getMonth()]}${ya}${to ? ' to ' : ' – '}${b.getDate()} ${MON[b.getMonth()]}${yr(b)}`;
}
/** The Study view's starting state: this month, every theme, book and kind. */
function stDefaults() {
  const t = dayOf(Date.now());
  return { name: 'study', tab: 'month', mode: 'month', y: t.getFullYear(), m: t.getMonth(), end: +t, theme: '', book: '', kind: '', thread: '', note: '', viz: lsGet('bs-study-viz') === 'board' ? 'board' : 'threads' };
}
/** The period on screen: its bounds and the words used for it. */
function stRange() {
  const TODAY = dayOf(Date.now()), YEAR = TODAY.getFullYear(), first = S2.entries()[0];
  const EARLIEST = first ? new Date(new Date(first.created).getFullYear(), new Date(first.created).getMonth(), 1) : new Date(YEAR - 1, TODAY.getMonth(), 1);
  if (view.mode === 'month') {
    const { y, m } = view, from = new Date(y, m, 1), toEx = new Date(y, m + 1, 1), yr = y !== YEAR ? ` ${y}` : '', isNow = TODAY >= from && TODAY < toEx;
    return { kind: 'month', id: 'month', from, toEx, last: addDays(toEx, -1), label: `${MONTH[m]} ${y}`, lead: `In ${MONTH[m]}${yr}`, look: isNow ? 'this month' : `${MONTH[m]}${yr}`, name: `${MONTH[m]}${yr}`, these: 'this month', title: `${MONTH[m]} ${y}`,
      now: isNow, canPrev: new Date(y, m - 1, 1) >= EARLIEST, canNext: toEx <= TODAY, prev: 'Previous month', next: 'Next month' };
  }
  const n = +view.mode, last = dayOf(view.end), from = addDays(last, -(n - 1)), toEx = addDays(last, 1), isNow = +last === +TODAY;
  return { kind: 'days', id: 'd' + n, n, from, toEx, last, label: spanLabel(from, last), lead: isNow ? `In the last ${n} days` : `From ${spanLabel(from, last, { to: true })}`, look: isNow ? `the last ${n} days` : spanLabel(from, last), name: `these ${n} days`, these: `these ${n} days`, title: spanLabel(from, last, { year: true }),
    now: isNow, canPrev: addDays(from, -1) >= EARLIEST, canNext: last < TODAY, prev: `Previous ${n} days`, next: `Next ${n} days` };
}

// ------------------------------------------------------------ the period's data
const inR = (t, r) => t >= +r.from && t < +r.toEx;
const stSig = all => all.map(e => `${e.id}:${e.updated}`).join(',');
/** Chapters read inside the period as reading rows {day, b, c, minutes} (study.js totals). */
function readRows(r) {
  const rows = [];
  for (const [k, ch] of Object.entries(lib.chapters)) {
    if (!ch || !ch.read || !inR(+ch.readAt || 0, r)) continue;
    const [b, c] = k.split('.').map(Number); if (bookOf(b)) rows.push({ day: localDay(+ch.readAt), b, c, minutes: roundMin(ch.seconds) });
  }
  return rows;
}
/** Minutes and days studied in the period: the per-day figures of the last 90 days where they cover it, else the chapters' own time. */
function minutesIn(r, rows) {
  const st = lib.stats || emptyStats(), today = parseDay(st.today || localDay()), first = addDays(today, -89);
  if (+r.from < +first) return { minutes: rows.reduce((s, x) => s + x.minutes, 0), days: new Set(rows.map(x => x.day)).size };
  let minutes = 0, days = 0;
  (st.minutes90 || []).forEach((x, i) => { const d = addDays(first, i); if (d >= r.from && d < r.toEx) { const m = Math.round(Math.max(0, +x || 0)); minutes += m; if (m > 0) days++; } });
  return { minutes, days };
}
/** Books by time read in the period, then by verses marked: [{b, name, minutes, read: Set(c), marked: Set(ref)}]. */
function booksIn(list, r) {
  const m = new Map(), get = b => { if (!m.has(b)) m.set(b, { b, name: bookName(b), minutes: 0, read: new Set(), marked: new Set() }); return m.get(b); };
  for (const [k, ch] of Object.entries(lib.chapters)) {
    if (!ch) continue;
    const [b, c] = k.split('.').map(Number), readIn = !!ch.read && inR(+ch.readAt || 0, r);
    if (!bookOf(b) || !(readIn || inR(+ch.lastRead || 0, r))) continue;
    const x = get(b); x.minutes += roundMin(ch.seconds); if (readIn) x.read.add(c);
  }
  for (const e of list) get(e.b).marked.add(e.ref);
  return [...m.values()].sort((a, z) => z.minutes - a.minutes || z.marked.size - a.marked.size || a.b - z.b);
}
const linksIn = r => myLinks().filter(l => inR(+l.created || 0, r));
/** Everything the period shows, worked out once per period, data version and set of choices (themesFor is the costly part). */
function stData() {
  const r = stRange(), all = S2.entries(), choices = S.normThemes(state.notes.themes);
  const key = [+r.from, +r.toEx, stSig(all), JSON.stringify(choices), lib.rev, linksVer, curScope(), !!SV.topics, Object.keys(SV.xrefs).join()].join('|');
  if (!SV.memo || SV.memo.key !== key) {
    const list = S2.inRange(+r.from, +r.toEx, all), read = readRows(r), lk = linksIn(r);
    const themes = list.length && SV.topics ? S2.themesFor(list, SV.topics, SV.xrefs, { choices }) : null;
    SV.memo = { key, d: { all, byId: new Map(all.map(e => [e.id, e])), list, read, lk, tot: { ...S2.totals(list, read, lk), ...minutesIn(r, read) }, themes, threads: list.length ? S2.threads(list, SV.xrefs) : [], books: booksIn(list, r), choices } };
  }
  return { ...SV.memo.d, r };
}
/** Themes over every entry (the note card opens entries outside the period too). */
function themesAll(all) {
  const choices = S.normThemes(state.notes.themes), key = `${stSig(all)}|${JSON.stringify(choices)}|${!!SV.topics}`;
  if (!SV.allMemo || SV.allMemo.key !== key) SV.allMemo = { key, t: SV.topics && all.length ? S2.themesFor(all, SV.topics, SV.xrefs, { choices }) : null };
  return SV.allMemo.t;
}
const trOf = e => (e.mark && (e.mark.tr === 'kjv' || e.mark.tr === 'bsb') ? e.mark.tr : S.previewTr());
const textKey = e => `${trOf(e)}:${e.ref}${e.mark && e.mark.end ? '-' + e.mark.end : ''}`;
/** The verse text of each entry (a mark's own translation when bundled, else the reader's preview translation), cached. */
async function stTexts(list) {
  await Promise.all(list.filter(e => e.v && !SV.texts.has(textKey(e))).map(async e => {
    let t = '';
    try {
      const bk = await S.data.bible(trOf(e), e.b), ch = bk[e.c] || [], ve = e.mark && e.mark.end ? +String(e.mark.end).split('.')[2] || e.v : e.v;
      t = ch.slice(e.v - 1, Math.max(e.v, ve)).filter(Boolean).join(' ');
    } catch (err) { t = ''; }
    SV.texts.set(textKey(e), t);
  }));
}
const verseOf = e => SV.texts.get(textKey(e)) || e.quote || '';
/** Topics, the cross-reference files of the books in the list and the verse texts, each loaded once. */
async function stLoad(list) {
  const jobs = [stTexts(list)];
  if (!SV.topics) jobs.push(S2.loadTopics().then(t => { SV.topics = t; }, e => console.error('topics failed to load', e)));
  const missing = list.filter(e => !SV.xrefs[e.b]);
  if (missing.length) jobs.push(S2.loadXrefsFor(missing).then(x => Object.assign(SV.xrefs, x)));
  await Promise.all(jobs);
}

// ------------------------------------------------------------ shared pieces
const dotOf = e => `<i class="hdot rc-d" data-color="${esc(e.color)}" aria-hidden="true"></i>`;
const noteChip = (e, key) => `<button type="button" class="ls-chip rc-nchip" data-st-note="${esc(e.id)}" data-key="${esc(key)}"${e.phrase ? ` title="“${esc(e.phrase)}”"` : ''} aria-label="${esc(e.phrase ? `${e.label}, “${e.phrase}”` : e.label)}">${dotOf(e)}${esc(e.label)}</button>`;
const noteLink = e => `<button type="button" class="rc-inline" data-st-note="${esc(e.id)}" data-key="nl-${esc(e.id)}">${esc(e.label)}</button>`;
const goAttr = (extra, key) => `data-st-go="${esc(new URLSearchParams(extra).toString())}" data-key="${esc(key)}"`;
const chipsFor = (d, ids) => ids.map(id => d.byId.get(id)).filter(Boolean).map(e => `<button type="button" class="note-ref" data-st-note="${esc(e.id)}">${esc(S2.chipLabel(e))}</button>`).join('');
function infoHtml() {
  return `<details class="ls-info"><summary aria-label="How themes are found" title="How themes are found">${icon('info')}</summary><div class="ls-info-pop">
    <p><b>How themes are found.</b> Each verse is matched against the 150 topics in OpenBible’s data, with weight from its cross-references and from the notes you joined it to. It runs offline and privately, in this page.</p>
    <p>Keep, rename, merge or remove a theme and the choice is saved with your notes.</p></div></details>`;
}
/** A hosted site's guest: Study shows the sign-in card where it would show personal data (as the Library home does). */
function guestCard() {
  const au = state.auth || {};
  return `<div class="notice lib-guest" role="note">${icon('person')}<p>Sign in to see your study<small>Your notes, highlights and comments gather here by month, with the themes and threads that run through them.</small></p>${au.features && au.features.signup === false ? '' : '<button class="btn btn-tinted sm" type="button" data-lib-auth="signup">Create profile</button>'}<button class="btn btn-plain sm" type="button" data-lib-auth="signin">Sign in</button></div>`;
}
/** The Study view's shell: the navbar, the title and the three tabs; #lib-study is painted in place. */
function studyView() {
  const seg = ST_TABS.map(([id, label]) => `<button type="button" role="tab" data-st-tab="${id}" aria-selected="${view.tab === id}" tabindex="${view.tab === id ? 0 : -1}">${label}</button>`).join('');
  return `<div class="navbar"><button class="back" type="button" data-lib-back>${icon('chev-left')}Library</button></div>
    <div class="lib-book-head st-head"><div><h3 class="pc-title">Study</h3><p class="pc-sub">What you’ve been diving into</p></div>
      <div class="segmented ls-seg st-tabs" id="st-tabs" role="tablist" aria-label="Study views">${seg}</div></div>
    <p class="sr" id="st-live" aria-live="polite"></p>
    <div id="lib-study" class="lib-study" data-tab="${view.tab}">${view.tab === 'studies' ? '' : SKELETON}</div>`;
}
/** The Study entry on the Library home. */
function studyCard() {
  const n = S2.entries().length;
  return `<section class="lib-card lib-study-card" aria-labelledby="lib-study-h"><div class="lh"><h3 id="lib-study-h">Study</h3><span>${n ? esc(plural(n, 'note, highlight or comment', 'notes, highlights and comments')) : ''}</span></div>
    <div class="lib-study-row"><p>What you’ve been diving into: a look back on the month, your notes connected by theme and thread, and your own studies.</p><button class="btn btn-tinted sm" type="button" data-lib-study>${icon('sparkle')}Open Study</button></div></section>`;
}

// ------------------------------------------------------------ Memorize (memorize-brief §6): the home's card and Library › Memory
// Ported from app/mock/memorize-library.html. memory.js works out each verse's place in line (memoryWhen, memoryDue,
// memoryIsUpnext); a row or the pinned card's Practise opens the practice through memory.js practise (practice.js).
/** This profile's memory verses have loaded (memory.js keeps them per scope). */
const memOk = () => !!(mem && mem.memory && mem.memory.loaded && mem.memory.scope === curScope());
const trAbbr = tr => S.trInfo(tr).abbr;
/** KJV small capitals for the divine name (LORD, GOD, LORD’S), as practice.js and home.js show it. */
const scripture = s => esc(S.smart(s)).replace(/\b(?:LORD|GOD)(?:[’']S)?(?!\p{L})/gu, m => `<span class="sc">${m[0]}${m.slice(1).toLowerCase()}</span>`);
let mzRemoved = null, mzRefocus = null;   // the verse last removed here; after its Undo, its row's ⋯ takes the focus (the mock's)
const mzWords = new Map();   // 'id|ref|tr' -> the first words of a KJV or BSB memory verse ('' when its text can't be had)
const mzKey = x => `${x.id}|${x.ref}|${x.tr}`;
const firstWords = t => { const w = String(t || '').trim().split(/\s+/).filter(Boolean); return w.length > 7 ? w.slice(0, 7).join(' ').replace(/[,;:.]$/, '') + '…' : w.join(' '); };
const MZ_PLACE = ['Next in line', 'Second in line', 'Third in line', 'Fourth in line', 'Fifth in line'];
const mzStep = x => (x.heart ? 6 : Math.max(0, Math.min(5, Math.floor(+x.step || 0))));
/** '12 October' (with the year when it isn't this one). */
const mzDay = day => { const d = parseDay(day); return `${d.getDate()} ${MONTH[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ''}`; };
/** When a verse is next practised: 'Due today', 'Next review tomorrow', 'Next review Thursday', 'Next review in January';
 *  '' for a verse teed up (it has no day until it is current). */
function mzWhen(x) {
  const w = mem.memoryWhen(x);
  return !w || w === 'Due today' || w.startsWith('Next review') ? w : `Next review ${w === 'Tomorrow' ? 'tomorrow' : w}`;
}
/** The six review dots (memory.css .mz-steps), named for a screen reader only where no words beside them say the stage. */
const mzDots = (x, label = true) => {
  const n = mzStep(x);
  return `<span class="mz-steps" ${label ? `role="img" aria-label="Review ${Math.min(6, n + 1)} of 6"` : 'aria-hidden="true"'}>${[0, 1, 2, 3, 4, 5].map(i => `<i class="${i < n ? 'd' : i === n ? 'n' : ''}"></i>`).join('')}</span>`;
};
/** The first words of a KJV or BSB verse, faded (filled in afterRender the first time); '' for the other translations. */
function mzFirstHtml(x, tag, cls) {
  if (x.tr !== 'kjv' && x.tr !== 'bsb') return '';
  const t = mzWords.get(mzKey(x));
  return t === '' ? '' : `<${tag} class="${cls} mz-first" data-mz-first="${esc(x.id)}">${t ? scripture(t) : ''}</${tag}>`;
}

/** The Memory entry on the Library home: the counts, the memory verse and when, and Open Memory. */
function memoryCard() {
  if (!mem) return '';
  const o = memOk() ? mem.organizedMemory() : null, any = !!o && !!(o.current || o.heart.length);
  const count = o ? [[o.current ? 1 : 0, 'learning'], [o.upnext.length, 'up next'], [o.heart.length, 'on the heart']].filter(([n]) => n).map(([n, w]) => `${n.toLocaleString()} ${w}`).join(', ') : '';
  const due = x => `<span class="mz-when${mem.memoryDue(x) ? '' : ' calm'}">`;
  const line = o && o.current ? `<b>${esc(mem.memoryLabel(o.current))}</b> · ${due(o.current)}${esc(mzWhen(o.current))}</span>`
    : o && o.dueHeart.length ? `<b>${esc(mem.memoryLabel(o.dueHeart[0]))}</b> · ${due(o.dueHeart[0])}Review due</span>`
    : any ? 'No verse being learned just now. Select a verse and choose Memorize.'
    : 'Verses you’re learning by heart. Select a verse and choose Memorize.';
  return `<section class="lib-card lib-mem-card" aria-labelledby="lib-mem-h"><div class="lh"><h3 id="lib-mem-h">Memory</h3><span>${esc(count)}</span></div>
    <div class="lib-mem-row"><p>${line}</p>${any ? `<button class="btn btn-tinted sm" type="button" data-lib-memory>${icon('memorize')}Open Memory</button>` : ''}</div></section>`;
}

/** Library › Memory: the memory verse pinned, then Up next and Written on the heart (each row opens its practice). */
function memoryView() {
  const head = `<div class="navbar"><button class="back" type="button" data-lib-back>${icon('chev-left')}Library</button></div>
    <div class="mz-vh"><h3 class="pc-title">Memory</h3><p class="pc-sub">Verses you’re learning by heart</p></div>`;
  if (!memOk()) return head + (memFailed ? empty('info', 'Memory is unavailable right now', 'Reload the page to try again.') : SKELETON);
  const au = state.auth || {};
  const guest = S.readOnlyGuest() ? `<div class="notice lib-guest" role="note">${icon('person')}<p>Sign in to memorize verses<small>The verses you’re learning by heart, and when each is next due, are kept with your profile.</small></p>${au.features && au.features.signup === false ? '' : '<button class="btn btn-tinted sm" type="button" data-lib-auth="signup">Create profile</button>'}<button class="btn btn-plain sm" type="button" data-lib-auth="signin">Sign in</button></div>` : '';
  const o = mem.organizedMemory();
  if (!o.current && !o.heart.length) return head + guest + `<div class="mz-none"><span class="tile-i">${icon('memorize')}</span><h3>Nothing to memorize yet</h3><p>Select a verse and choose Memorize.</p></div>`;
  // Up next counts against the three teed up; two devices or an import may leave more, and every one is listed
  const n = o.upnext.length;
  const groups = [mzGroup('up', 'Up next', n <= 3 ? `${n} of 3` : n.toLocaleString(), o.upnext), mzGroup('heart', 'Written on the heart', o.heart.length.toLocaleString(), o.heart)].filter(Boolean);
  return head + guest + (o.current ? mzCurHtml(o.current) : '') + (groups.length ? `<div class="lib-cols mz-cols">${groups.map(g => `<div class="lib-col">${g}</div>`).join('')}</div>` : '');
}
/** The memory verse, pinned (the Library's Continue card): Practise, and a ⋯ with Practise and Remove. */
function mzCurHtml(x) {
  const label = mem.memoryLabel(x);
  return `<section class="lib-continue mz-cur" aria-labelledby="mz-cur-k">
    <div><p class="lc-k" id="mz-cur-k">Your memory verse</p><p><span class="lc-t">${esc(label)}</span></p>
      ${mzFirstHtml(x, 'p', 'lc-q')}
      <p class="lc-s">${mzDots(x, false)}<span>${esc(trAbbr(x.tr))} · Learning · review ${mzStep(x) + 1} of 6</span></p>
      <p class="lc-s mz-when-l"><span class="mz-when${mem.memoryDue(x) ? '' : ' calm'}">${esc(mzWhen(x))}</span></p></div>
    <button class="btn btn-primary" type="button" data-practise="${esc(x.id)}" aria-label="Practise ${esc(label)}">Practise${icon('arrow-right')}</button>
    <button class="mz-more" type="button" data-mz-menu aria-haspopup="menu" aria-expanded="false" aria-label="More for ${esc(label)}" title="More">${icon('ellipsis')}</button>
  </section>`;
}
function mzGroup(key, title, count, list) {
  if (!list.length) return '';
  return `<section class="lib-sec" aria-labelledby="mz-h-${key}"><div class="lh"><h3 id="mz-h-${key}">${title}</h3><span>${esc(count)}</span></div><ul class="group">${list.map(mzRowHtml).join('')}</ul></section>`;
}
/** A row: the reference · translation, the first words, then the dots and its place in line, or since when it is on the heart. */
function mzRowHtml(x, i) {
  const label = mem.memoryLabel(x), id = esc(x.id);
  let meta;
  if (x.heart) {
    const due = mem.memoryDue(x), w = mzWhen(x);
    const when = due ? '<span class="mz-when">review due</span>' : w ? `<span class="mz-when calm">${esc(w[0].toLowerCase() + w.slice(1))}</span>` : '';
    meta = `<span>Since ${esc(mzDay(x.heart))}</span>${when ? `<span><span class="mz-dot" aria-hidden="true">·</span>${when}</span>` : ''}`;
  } else meta = `${mzDots(x)}<span class="mz-when calm">${MZ_PLACE[i] || 'In line'}</span>`;
  return `<li class="mz-row${x.heart ? ' written' : ''}" data-mz="${id}"><button type="button" class="cell" data-practise="${id}" aria-label="Practise ${esc(label)}" aria-describedby="mz-m-${id}"><span class="cell-body">
    <span class="cell-title">${esc(label)}<span class="mz-tr"> · ${esc(trAbbr(x.tr))}</span></span>
    ${mzFirstHtml(x, 'span', 'cell-sub serif')}
    <span class="mz-meta" id="mz-m-${id}">${meta}</span></span></button>
    <button type="button" class="mz-more" data-mz-menu aria-haspopup="menu" aria-expanded="false" aria-label="More for ${esc(label)}">${icon('ellipsis')}</button></li>`;
}
/** What a practice opened here gives focus back to after the list redraws: that verse's Practise (or its ⋯). */
const mzFocusBack = (id, menu) => () => {
  const el = $(`#library-body [data-practise="${cssEsc(id)}"]`);
  return el && menu ? el.closest('li[data-mz], .mz-cur')?.querySelector('[data-mz-menu]') || el : el;
};
/** A memory verse's ⋯ (ui.js openMenu, as the bookmark rows): Practise, Make current (a verse teed up), Remove. */
function openMzMenu(btn) {
  const own = btn.closest('li[data-mz], .mz-cur'), id = own && (own.dataset.mz || $('[data-practise]', own)?.dataset.practise);
  const x = id && mem && mem.getMemory(id); if (!x || !fn('openMenu')) return;
  const html = `<button type="button" role="menuitem" data-mzi="practise">Practise${icon('arrow-right')}</button>`
    + (mem.memoryIsUpnext(x) ? `<button type="button" role="menuitem" data-mzi="current">Make current${icon('memorize')}</button>` : '')
    + `<hr><button type="button" role="menuitem" class="danger" data-mzi="remove">Remove${icon('trash')}</button>`;
  ui.openMenu(btn, html, {
    label: mem.memoryLabel(x), className: 'mz-menu',
    onClick: e => {
      const it = e.target.closest('[data-mzi]'); if (!it) return;
      const act = it.dataset.mzi;
      closeMenuSafe(true);   // focus back on ⋯; after the redraw focusAlt passes it on (the pinned card, the next row)
      if (!mem.getMemory(id)) return;
      if (act === 'practise') mem.practise(id, { returnFocus: mzFocusBack(id, true) });
      else if (act === 'current') mem.makeCurrent(id);
      else if (act === 'remove' && mem.removeVerse(id)) mzRemoved = id;
    },
  });
}

// ------------------------------------------------------------ This month (§2.1)
function heroHtml(d) {
  const { r, list, read, tot, themes, threads, books } = d;
  let head;
  if (list.length) {
    // the period's arc in the reader's own highlighted words: the ends of its longest thread when they are marks, else
    // the first and last highlights or comments of the period (a plain note lends its verse's first words)
    const t = threads[0], ends = t ? [d.byId.get(t.chain[0]), d.byId.get(t.chain[t.chain.length - 1])] : [], marks = list.filter(e => e.phrase);
    const a = ends[0] && ends[0].phrase ? ends[0] : marks[0] || list[0], b = ends[1] && ends[1].phrase ? ends[1] : marks[marks.length - 1] || list[list.length - 1];
    const words = e => e.phrase || S2.phraseOf(verseOf(e)) || e.label;
    head = a === b ? `“${esc(cap(words(a)))}”` : `<span class="w">From</span> “${esc(words(a))}” <span class="w">to</span> “${esc(words(b))}”`;
  } else head = `${esc(cap(say(tot.chapters, 'chapter')))}, read quietly`;
  const parts = [];
  if (read.length) {
    const bk = books.filter(b => b.minutes), top = bk[0], others = bk.slice(1, 4).map(b => proseBook(b.b));
    const len = Math.round((r.toEx - r.from) / DAY), when = tot.days >= len ? 'every day' : tot.days ? `on ${say(tot.days, 'day')}` : '';
    let s = `${r.lead} you ${when ? `spent time in Scripture ${when} and ` : ''}read ${say(tot.chapters, 'chapter')}`;
    if (top) s += bk.length === 1 ? `, all in ${proseBook(top.b)}` : `, ${top.minutes / Math.max(1, tot.minutes) >= .5 ? 'most of that time' : 'the most time'} in ${proseBook(top.b)}${others.length ? `, with ${andList(others)} alongside` : ''}`;
    parts.push(esc(s) + '.');
  } else parts.push(esc(`${r.lead} you wrote ${say(list.length, 'note, highlight or comment', 'notes, highlights and comments')}.`));
  const top = themes ? themes.overall.slice(0, 3) : [];
  if (top.length === 1) parts.push(`One theme ran through your notes: <b>${esc(top[0].label)}</b>.`);
  else if (top.length) parts.push(`Your notes kept returning to ${andList(top.map(t => `<b>${esc(t.label)}</b>`))}.`);
  else if (!list.length) parts.push('Nothing was written down this time.');
  return `<section class="rc-hero" aria-label="A look back">
    <div class="rc-kick">Looking back on ${esc(r.look)}${infoHtml()}</div>
    <p class="rc-headline">${head}</p>
    <p class="rc-lede">${parts.join(' ')}</p>
    ${list.length ? `<button type="button" class="btn btn-tinted sm" data-st-act="study" data-key="study-hero">${icon('note')}Make a study from ${esc(r.these)}</button>` : ''}
  </section>`;
}
function emptyHtml(d) {
  const { r } = d;
  return `<section class="rc-hero" aria-label="A look back">
    <div class="rc-kick">Looking back on ${esc(r.look)}${infoHtml()}</div>
    <p class="rc-headline">Nothing ${r.now ? 'yet' : 'here'}</p>
    <p class="rc-lede">${r.now ? `Nothing yet ${esc(r.these)}. Highlight a verse or write a note and it appears here, with the themes and threads that run through your notes.`
      : `Nothing was read or written in ${esc(r.kind === 'month' ? r.name : r.look)}. The notes, highlights and comments you make gather here, with the themes and threads that run through them.`}</p>
    ${r.now ? '' : `<button type="button" class="btn btn-tinted sm" data-st-act="latest" data-key="latest">${esc(r.kind === 'month' ? 'Go to this month' : `Go to the last ${r.n} days`)}</button>`}
  </section>`;
}
function totalsHtml(d) {
  const { tot, list, lk } = d;
  const words = list.filter(n => n.kind === 'highlight' && n.text.trim()).length;
  const noteBooks = new Set(list.filter(n => n.kind === 'note').map(n => n.b)).size;
  const comCh = new Set(list.filter(n => n.kind === 'comment').map(n => `${n.b}.${n.c}`)).size;
  const lkBooks = new Set(lk.flatMap(l => [l.from, l.to].map(x => +String(x).split('.')[0]))).size;
  // Notes, Highlights and Comments open Connected filtered to that kind; the other two are the period's own sums
  const cells = [
    ['Notes written', tot.notes, tot.notes ? `in ${plural(noteBooks, 'book')}` : '', 'note'],
    ['Highlights', tot.highlights, tot.highlights ? `${words.toLocaleString()} with your words` : '', 'highlight'],
    ['Comments', tot.comments, comCh ? `in ${plural(comCh, 'chapter')}` : '', 'comment'],
    ['Your links', tot.links, lkBooks ? `across ${plural(lkBooks, 'book')}` : ''],
    ['Chapters read', tot.chapters, tot.minutes ? `${fmtMin(tot.minutes)} · ${plural(tot.days, 'day')}` : ''],
  ];
  const inner = (k, v, s) => `<span class="rc-tot-k">${k}</span><b>${v.toLocaleString()}</b><span class="rc-tot-s">${s ? esc(s) : '&nbsp;'}</span>`;
  return `<div class="rc-totals" role="group" aria-label="Totals for ${esc(d.r.look)}">${cells.map(([k, v, s, kind]) => kind && v
    ? `<button type="button" class="rc-tot" ${goAttr({ kind }, `tot-${kind}`)} aria-label="${esc(`${k}: ${v.toLocaleString()}${s ? `, ${s}` : ''}. See them in Connected`)}">${inner(k, v, s)}<span class="rc-go" aria-hidden="true">${icon('chev-right')}</span></button>`
    : `<div class="rc-tot">${inner(k, v, s)}</div>`).join('')}</div>`;
}
function threadHtml(d) {
  const { r, threads } = d;
  if (!threads.length) return `<section class="ls-card rc-thread" aria-labelledby="rc-thread-h">
    <div class="lh"><h3 id="rc-thread-h">Threads</h3></div>
    <p class="rc-empty-line">No thread in ${esc(r.kind === 'month' ? r.name : r.look)} yet. A thread forms when three of your notes point to one another; type <b>[[</b> in a note to reference another.</p></section>`;
  const fi = Math.max(0, threads.findIndex(t => t.id === SV.featured)), t = threads[fi], chain = t.chain.map(id => d.byId.get(id));
  const title = fi === 0 ? (r.kind === 'month' ? 'The thread of the month' : 'The longest thread') : 'Another thread';
  const stops = chain.map((n, i) => `<li>${i ? `<span class="rc-to" aria-hidden="true">${icon('arrow-right')}</span>` : ''}<button type="button" class="rc-stop" data-st-note="${esc(n.id)}" data-key="stop-${esc(n.id)}" aria-label="${esc(n.phrase ? `${n.label}, “${n.phrase}”` : n.label)}"><span class="rc-stop-ref">${dotOf(n)}${esc(n.label)}</span><span class="rc-stop-q">${n.phrase ? `“${esc(n.phrase)}”` : esc(S2.plainText(n.text, 60))}</span></button></li>`).join('');
  // notes drawn in by a cross-reference rather than by one of your references
  const extra = t.noteIds.filter(id => !t.chain.includes(id)).map(id => {
    const e = t.edges.find(x => x.from === id && x.kind !== 'ref'), to = e && d.byId.get(e.to);
    return { n: d.byId.get(id), how: !e ? '' : e.kind === 'shared' ? `through ${e.viaLabel}` : to ? `with ${to.label}` : '' };
  });
  const joined = extra.length ? `<p class="rc-joined">Cross-references bring in ${extra.length === 1 ? 'one more' : say(extra.length, 'more', 'more')}: ${andList(extra.map(x => `${noteLink(x.n)}${x.how ? ` (${esc(x.how)})` : ''}`))}.</p>` : '';
  const others = threads.filter((_, i) => i !== fi);
  return `<section class="ls-card rc-thread" aria-labelledby="rc-thread-h">
    <div class="lh"><h3 id="rc-thread-h" tabindex="-1" data-key="thread-h">${title}</h3><span>${esc(fmtSpan(t.start, t.end))} · ${t.days ? esc(plural(t.days, 'day')) : 'one day'}</span></div>
    <p class="rc-intro">${esc(cap(say(chain.length, 'note')))} joined by your own references, in the order you wrote them.</p>
    <ol class="rc-chain" aria-label="${esc(t.label)}">${stops}</ol>
    ${joined}
    ${others.length ? `<h4 class="rc-sub-h">${others.length === 1 ? 'Another thread' : 'Other threads'}</h4><ul class="rc-others">${others.map(o => `<li><button type="button" class="rc-other" data-st-act="feature" data-thread="${o.id}" data-key="th-${o.id}" aria-label="Show the thread ${esc(o.label)}"><span class="rc-other-l">${o.chain.map(id => esc(d.byId.get(id).label)).join(' <span class="a">→</span> ')}</span><span class="rc-other-s">${esc(plural(o.noteIds.length, 'note'))} · ${o.days ? esc(plural(o.days, 'day')) : 'one day'}</span></button><button type="button" class="ls-hand" ${goAttr({ viz: 'threads', thread: o.id, focus: 1 }, `see-th-${o.id}`)} aria-label="See the thread ${esc(o.label)} in Connected">See this thread${icon('chev-right')}</button></li>`).join('')}</ul>` : ''}
    <div class="rc-foot"><button type="button" class="btn btn-plain sm rc-see" ${goAttr({ viz: 'threads', thread: t.id, focus: 1 }, 'see-thread')} aria-label="See this thread in Connected">${icon('chev-right')}See this thread</button><button type="button" class="btn btn-plain sm" data-st-act="study-thread" data-thread="${t.id}" data-key="study-thread">${icon('arrow-right')}Make a study from this thread</button></div>
  </section>`;
}
function themeRow(t, i, d) {
  const open = SV.openTheme === t.name, id = `rc-th-${i}`, ns = t.noteIds.map(x => d.byId.get(x)).filter(Boolean);
  const marks = `<span class="rc-marks" aria-hidden="true">${ns.map(n => `<i class="hdot" data-color="${esc(n.color)}"></i>`).join('')}</span>`;
  const head = SV.renaming === t.name
    ? `<form class="rc-rename" data-theme="${esc(t.name)}"><label class="field sm"><input type="text" value="${esc(t.label)}" aria-label="New name for ${esc(t.label)}" data-key="rename" autocomplete="off" spellcheck="true" maxlength="100"></label><button type="submit" class="btn btn-primary sm">Save</button><button type="button" class="btn btn-plain sm" data-st-act="cancel-rename" data-theme="${esc(t.name)}">Cancel</button></form>`
    : `<button type="button" class="rc-theme-btn" data-st-act="theme" data-theme="${esc(t.name)}" data-key="theme-${esc(t.name)}" aria-expanded="${open}" aria-controls="${id}">
        <span><span class="rc-theme-name">${esc(t.label)}${t.suggested ? '<span class="ls-badge lamp">Suggested</span>' : ''}</span><span class="rc-theme-why">${esc(t.why)}</span></span>
        ${marks}${icon('chev-down')}</button>`;
  const others = d.themes.overall.filter(o => o.name !== t.name);
  const detail = [t.detail, t.tag && `matches your tag ${t.tag}`, t.also.length && `includes ${andList(t.also.map(a => `“${S2.themeLabel(a)}”`))}`].filter(Boolean).join(' · ');
  return `<li class="rc-theme">${head}
    <div class="rc-theme-more" id="${id}"${open ? '' : ' hidden'}>
      <p class="rc-detail">${esc(cap(detail))}.</p>
      <div class="ls-chips">${ns.map(n => noteChip(n, `tn-${t.name}-${n.id}`)).join('')}</div>
      <div class="rc-acts">
        ${t.suggested ? `<button type="button" class="btn btn-tinted sm" data-st-act="keep" data-theme="${esc(t.name)}" data-key="keep-${esc(t.name)}">${icon('check')}Keep theme</button>` : `<span class="rc-kept">${icon('check')}Kept</span>`}
        <button type="button" class="btn btn-plain sm" data-st-act="rename" data-theme="${esc(t.name)}" data-key="rename-${esc(t.name)}">Rename</button>
        ${others.length ? `<span class="rc-sel"><span aria-hidden="true">Merge into…</span>${icon('chev-down')}<select data-st-merge="${esc(t.name)}" data-key="merge-${esc(t.name)}" aria-label="Merge ${esc(t.label)} into another theme"><option value="" selected disabled>Merge into…</option>${others.map(o => `<option value="${esc(o.name)}">${esc(o.label)}</option>`).join('')}</select></span>` : ''}
        <button type="button" class="btn btn-plain sm rc-quiet" data-st-act="remove" data-theme="${esc(t.name)}" data-key="remove-${esc(t.name)}">Remove</button>
        <span class="rc-acts-go"><button type="button" class="btn btn-plain sm rc-see" ${goAttr({ theme: t.name, focus: 1 }, `see-${t.name}`)} aria-label="See the connections of ${esc(t.label)} in Connected">${icon('chev-right')}See connections</button>
        <button type="button" class="btn btn-plain sm rc-study" data-st-act="study-theme" data-theme="${esc(t.name)}" data-key="study-${esc(t.name)}" aria-label="Make a study from ${esc(t.label)}">${icon('arrow-right')}Make a study</button></span>
      </div>
    </div></li>`;
}
function themesHtml(d) {
  const T = d.themes, head = `<div class="lh"><h3 id="rc-themes-h" tabindex="-1" data-key="themes-h">Themes</h3><span>Found in your notes</span></div>`;
  if (!T || !T.overall.length) return `<section class="ls-card rc-themes-card" aria-labelledby="rc-themes-h">${head}<p class="rc-empty-line">${SV.topics ? 'Themes appear once two or more notes share a subject.' : 'The topics could not be loaded, so no themes are suggested.'}</p>${T ? tagsHtml(d) + noneHtml(d) : ''}</section>`;
  const shown = SV.allThemes ? T.overall : T.overall.slice(0, 6), rest = T.overall.length - 6;
  return `<section class="ls-card rc-themes-card" aria-labelledby="rc-themes-h">${head}
    <ul class="rc-themes">${shown.map((t, i) => themeRow(t, i, d)).join('')}</ul>
    ${rest > 0 ? `<button type="button" class="chip more rc-more" data-st-act="all-themes" data-key="all-themes" aria-expanded="${SV.allThemes}">${SV.allThemes ? 'Show fewer' : `Show ${num(rest)} more`}${icon('chev-down')}</button>` : ''}
    ${tagsHtml(d)}${noneHtml(d)}</section>`;
}
function tagsHtml(d) {
  const ys = d.themes.yours; if (!ys.length) return '';
  const y = ys.find(x => x.tag === SV.openTag);
  let panel = '';
  if (y) {
    const found = y.topic && d.themes.overall.find(o => o.name === y.topic);
    const might = y.suggest.map(id => d.byId.get(id)).filter(n => n && n.kind === 'note' && !n.tags.includes(y.tag));
    panel = `<div class="rc-panel" id="rc-tag-panel">
      <p class="rc-detail">${esc(y.why)}${found ? ` · also found as “${esc(found.label)}”` : ''}.</p>
      <div class="ls-chips">${y.noteIds.map(id => d.byId.get(id)).filter(Boolean).map(n => noteChip(n, `tg-${y.tag}-${n.id}`)).join('')}</div>
      ${might.map(n => `<p class="rc-might">Might belong here too: ${noteChip(n, `mt-${n.id}`)}<button type="button" class="btn btn-plain sm" data-st-act="add-tag" data-tag="${esc(y.tag)}" data-id="${esc(n.id)}" data-key="add-${esc(n.id)}">Add #${esc(y.tag)}</button></p>`).join('')}
    </div>`;
  }
  return `<div class="rc-sec"><h4>Your tags</h4><div class="ls-chips">${ys.map(x => `<button type="button" class="ls-chip" data-st-act="tag" data-tag="${esc(x.tag)}" data-key="tag-${esc(x.tag)}" aria-expanded="${x.tag === SV.openTag}"${x.tag === SV.openTag ? ' aria-controls="rc-tag-panel"' : ''}>#${esc(x.tag)} <span class="ls-count">${x.count}</span></button>`).join('')}</div>${panel}</div>`;
}
function noneHtml(d) {
  const T = d.themes, none = d.list.filter(n => !(T.byNote[n.id] || []).some(t => !t.weak) && !(n.tags || []).length);
  if (!none.length) return '';
  return `<div class="rc-sec"><h4>No suggestion yet</h4><div class="rc-none">${none.map(n => {
    const weak = (T.byNote[n.id] || []).find(t => t.weak);
    return `<span class="rc-none-i">${noteChip(n, `none-${n.id}`)}${weak ? `<small>perhaps “${esc(weak.label)}”</small>` : ''}</span>`;
  }).join('')}</div></div>`;
}
function booksHtml(d) {
  const { books, tot } = d, shown = books.slice(0, 6), max = Math.max(1, ...books.map(b => b.minutes)), rest = books.length - shown.length;
  const tests = new Set(shown.map(b => testament(b.b)));
  return `<section class="ls-card rc-books-card" aria-labelledby="rc-books-h">
    <div class="lh"><h3 id="rc-books-h">Books</h3><span>${tot.minutes ? esc(fmtMin(tot.minutes)) : ''}</span></div>
    ${shown.length ? `<ul class="rc-books">${shown.map(b => {
      const sub = [b.marked.size && plural(b.marked.size, 'verse') + ' marked', b.read.size && plural(b.read.size, 'chapter') + ' read'].filter(Boolean).join(' · ');
      const time = b.minutes ? fmtMin(b.minutes) : 'No time logged';
      // a row opens Connected filtered to the book; a book only read, with nothing marked, has nothing to show there
      const body = `<span class="rc-book-top"><span class="rc-book-name">${esc(b.name)}</span><span class="rc-book-t">${esc(time)}${b.marked.size ? `<span class="rc-go" aria-hidden="true">${icon('chev-right')}</span>` : ''}</span></span>
        <span class="rc-bar" aria-hidden="true"><i class="${testament(b.b) === 'OT' ? 'ot' : 'nt'}" style="--p:${(b.minutes / max).toFixed(3)}"></i></span>
        <span class="rc-book-s">${esc(sub || 'Read, nothing marked')}</span>`;
      return `<li>${b.marked.size ? `<button type="button" class="rc-book" ${goAttr({ book: b.b }, `book-${b.b}`)} aria-label="${esc(`${b.name}: ${time}, ${sub}. See its notes in Connected`)}">${body}</button>` : `<div class="rc-book rc-book-still">${body}</div>`}</li>`;
    }).join('')}</ul>` : '<p class="rc-empty-line">No chapter was read in this period.</p>'}
    ${rest > 0 ? `<p class="rc-book-s rc-book-rest">and ${esc(plural(rest, 'other book'))}</p>` : ''}
    ${shown.length ? `<p class="rc-legend" aria-hidden="true">${tests.has('OT') ? '<span><i class="ot"></i>Old Testament</span>' : ''}${tests.has('NT') ? '<span><i></i>New Testament</span>' : ''}</p>` : ''}
  </section>`;
}
function lifeHtml(d) {
  const items = d.list.filter(n => n.kind === 'highlight' && n.text.trim()).sort((a, z) => z.created - a.created);
  if (!items.length) return '';
  const shown = SV.allLife ? items : items.slice(0, 4), rest = items.length - 4;
  return `<section class="rc-life" aria-labelledby="rc-life-h">
    <div class="lh"><h3 id="rc-life-h">Your highlights</h3><span>${esc(plural(items.length, 'with your words', 'with your words'))}</span></div>
    <p class="rc-intro">The words you marked, with what you wrote beside them. Newest first.</p>
    <div class="rc-cols">${shown.map(n => {
      const back = S2.backlinks(n, d.all).map(x => x.entry);
      return `<article class="ls-note rc-hl" data-color="${esc(n.color)}" data-kind="${n.kind}" aria-labelledby="rc-hl-${esc(n.id)}">
        <div class="ls-note-head"><h4 class="ls-note-ref" id="rc-hl-${esc(n.id)}"><button type="button" data-st-note="${esc(n.id)}" data-key="hl-${esc(n.id)}">${esc(n.label)}</button></h4><span class="ls-note-meta">${esc(fmtDay(n.created))}</span></div>
        <p class="ls-verse">${S2.markHtml(n, verseOf(n))}</p>
        <div class="rc-anno ls-md md">${renderMd(n.text)}</div>
        <div class="rc-hl-foot">${back.length ? `<p class="rc-back">Mentioned in ${back.map(b => `<button type="button" class="note-ref" data-st-note="${esc(b.id)}" data-key="bk-${esc(n.id)}-${esc(b.id)}">${esc(b.label)}</button>`).join('')}</p>` : ''}<button type="button" class="ls-hand" ${goAttr({ note: n.id }, `see-${n.id}`)} aria-label="See ${esc(n.label)} in Connected">See connections${icon('chev-right')}</button></div>
      </article>`;
    }).join('')}</div>
    ${rest > 0 ? `<button type="button" class="chip more rc-showall" data-st-act="all-life" data-key="all-life" aria-expanded="${SV.allLife}">${SV.allLife ? 'Show fewer' : `Show all ${items.length}`}${icon('chev-down')}</button>` : ''}
  </section>`;
}
function closeHtml(d) {
  const { r, list } = d;
  if (!list.length) return '';
  return `<section class="rc-close" aria-labelledby="rc-close-h">
    <div><p class="ls-kicker">Your own document of study</p><h3 id="rc-close-h">Gather ${esc(r.name)} into a study</h3>
      <p>Your ${list.length === 1 ? 'note' : plural(list.length, 'note') + ', highlights and comments'} from ${esc(r.kind === 'month' ? r.name : r.look)}, in the order you studied them, ready to choose, reorder and read again as one document.</p></div>
    <div class="rc-close-act"><button type="button" class="btn btn-primary" data-st-act="study" data-key="study-close">${icon('note')}Make a study from ${esc(r.these)}</button><small>Opens Studies with ${esc(r.title)} filled in</small></div>
  </section>`;
}
function rangeBar(r) {
  const modes = [['month', 'Month'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']];
  const arrow = (dir, ok, label) => `<button type="button" class="rc-arrow" data-st-step="${dir}" data-key="${dir < 0 ? 'prev' : 'next'}" aria-label="${esc(label)}" aria-disabled="${!ok}"${ok ? ` title="${esc(label)}"` : ''}>${icon(dir < 0 ? 'chev-left' : 'chev-right')}</button>`;
  return `<div class="rc-range" role="group" aria-label="Period">
    <div class="rc-step">${arrow(-1, r.canPrev, r.prev)}<h2 class="rc-period">${esc(r.label)}</h2>${arrow(1, r.canNext, r.next)}</div>
    <div class="segmented sm rc-span" id="st-span" role="radiogroup" aria-label="Length of the period"><span class="seg-ind" aria-hidden="true"></span>${modes.map(([m, l]) => `<button type="button" role="radio" data-st-mode="${m}" data-key="mode-${m}" aria-checked="${view.mode === m}" tabindex="${view.mode === m ? 0 : -1}">${l}</button>`).join('')}</div></div>`;
}
function monthHtml(d) {
  const bare = !d.list.length && !d.read.length;
  return rangeBar(d.r) + `<div class="rc-view">${bare ? emptyHtml(d) : [heroHtml(d), totalsHtml(d), threadHtml(d), `<div class="ls-grid wide-left rc-pair">${themesHtml(d)}${booksHtml(d)}</div>`, lifeHtml(d), closeHtml(d)].join('')}</div>`;
}

// ------------------------------------------------------------ Connected (§2.2): the context bar, Threads and the Theme board
/** A note's themes, strongest first, with the reader's merges, renames and removals applied and any re-theming by drag. */
function noteThemes(d, id) {
  const T = d.themes; if (!T) return [];
  const ch = d.choices, merged = ch.merged || {}, removed = new Set(ch.removed || []), accepted = new Set(ch.accepted || []), live = new Map(T.overall.map(t => [t.name, t]));
  const resolve = name => { let n = name; for (let i = 0; i < 9 && merged[n]; i++) n = merged[n]; return n; };
  const labelOf = name => (live.get(name) || {}).label || (ch.renamed || {})[name] || S2.themeLabel(name);
  const out = [], seen = new Set(), mv = SV.moved.get(id);
  for (const t of T.byNote[id] || []) {
    if (t.weak) continue;
    const name = resolve(t.name);
    if (removed.has(name) || seen.has(name) || (mv && mv.drop.has(name))) continue;
    seen.add(name); out.push({ ...t, name, label: labelOf(name), suggested: !accepted.has(name) });
  }
  if (mv && mv.to) {
    const to = resolve(mv.to), i = out.findIndex(t => t.name === to);
    const row = i >= 0 ? out.splice(i, 1)[0] : { name: to, verse: false, xrefs: [], linked: [] };
    if (!removed.has(to)) out.unshift({ ...row, label: labelOf(to), suggested: !accepted.has(to), why: 'You placed this note here', mine: true });
  }
  return out;
}
const weakLead = (d, id) => (d.themes && (d.themes.byNote[id] || []).find(t => t.weak)) || null;
const themeHas = (d, n, v) => (v.startsWith('#') ? n.tags.includes(v.slice(1)) : noteThemes(d, n.id).some(t => t.name === v));
const filtered = () => view.mode !== 'month' || !!view.theme || !!view.book || !!view.kind;
const themeName = d => (!view.theme ? '' : view.theme.startsWith('#') ? view.theme : ((d.themes && d.themes.overall.find(t => t.name === view.theme)) || {}).label || S2.themeLabel(view.theme));
/** The context as it arrived or changed, made valid: a theme by its name, its shown name or a #tag; a book among those with notes. */
function normaliseFilters(d) {
  const T = d.themes, th = T ? T.overall : [];
  if (view.theme && !view.theme.startsWith('#') && !th.some(t => t.name === view.theme)) { const byLabel = th.find(t => t.label.toLowerCase() === view.theme.toLowerCase()); view.theme = byLabel ? byLabel.name : ''; }
  if (view.theme.startsWith('#') && !(T && T.yours.some(y => y.name === view.theme))) view.theme = '';
  if (view.book && !d.list.some(n => String(n.b) === String(view.book))) view.book = '';
  if (view.kind && !KINDS.includes(view.kind)) view.kind = '';
}
const shownList = d => d.list.filter(n => (!view.book || n.b === +view.book) && (!view.theme || themeHas(d, n, view.theme)) && (!view.kind || n.kind === view.kind));
function ctxBar(d, list) {
  const T = d.themes, sel = (v, cur) => (String(v) === String(cur) ? ' selected' : '');
  const themeOpts = T ? T.overall.map(t => `<option value="${esc(t.name)}"${sel(t.name, view.theme)}>${esc(t.label)} (${t.count})</option>`).join('') : '';
  const tagOpts = T ? T.yours.map(y => `<option value="${esc(y.name)}"${sel(y.name, view.theme)}>#${esc(y.tag)} (${y.count})</option>`).join('') : '';
  const books = S2.booksFor(d.list).sort((a, z) => a.b - z.b);
  const pill = (k, ic, label, opts, on, xLabel) => `<span class="nc-part"><label class="pill-select lead${on ? ' on' : ''}">${icon(ic, 'lead-i')}<select data-st-f="${k}" data-key="f-${k}" aria-label="${label}">${opts}</select>${icon('chev-down', 'chev')}</label><button type="button" class="nc-x" data-st-x="${k}"${on ? '' : ' hidden'} aria-label="${esc(xLabel)}">${icon('xmark')}</button></span>`;
  const rangeOpts = [['month', `${MONTH[view.m]} ${view.y}`], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']].map(([v, l]) => `<option value="${v}"${sel(v, view.mode)}>${esc(l)}</option>`).join('');
  const th = view.thread && SV.ths ? SV.ths.find(t => t.id === view.thread) : null;
  return `<div class="nc-ctx" id="nc-ctx" role="group" aria-label="What is shown">
    <button type="button" class="nc-ctx-back" data-st-tab="month" data-key="ctx-back">${icon('chev-left')}This month</button><span class="nc-ctx-sep" aria-hidden="true"></span>
    ${pill('range', 'calendar', 'Range', rangeOpts, view.mode !== 'month', 'Back to the whole month')}
    ${pill('theme', 'tag', 'Theme', `<option value=""${sel('', view.theme)}>All themes</option>${themeOpts ? `<optgroup label="Found in your notes">${themeOpts}</optgroup>` : ''}${tagOpts ? `<optgroup label="Your tags">${tagOpts}</optgroup>` : ''}`, !!view.theme, 'Show every theme')}
    ${pill('book', 'book', 'Book', `<option value="">All books</option>${books.map(b => `<option value="${b.b}"${sel(b.b, view.book)}>${esc(b.name)} (${b.count})</option>`).join('')}`, !!view.book, 'Show every book')}
    ${pill('kind', 'note', 'Kind', `<option value="">All kinds</option>${KINDS.map(k => `<option value="${k}"${sel(k, view.kind)}>${cap(KINDP[k])}</option>`).join('')}`, !!view.kind, 'Show every kind')}
    ${th ? `<span class="nc-chip">${icon('route')}<span>${esc(th.name)} thread</span><button type="button" class="nc-x" data-st-x="thread" aria-label="Stop highlighting the thread">${icon('xmark')}</button></span>` : ''}
    <span class="nc-count">${list.length === d.list.length ? esc(plural(d.list.length, 'note')) : `${list.length.toLocaleString()} of ${esc(plural(d.list.length, 'note'))}`}</span></div>`;
}
function emptyConnect(d) {
  const what = view.kind ? KINDP[view.kind] : 'notes', r = d.r;
  const bits = [view.theme && `in ${themeName(d)}`, view.book && `in ${bookName(view.book)}`, view.mode !== 'month' ? `in the ${r.look}` : `in ${r.name}`].filter(Boolean);
  const undo = [view.theme && ['theme', 'Every theme'], view.book && ['book', 'Every book'], view.kind && ['kind', 'Every kind'], view.mode !== 'month' && ['range', 'The whole month']].filter(Boolean);
  return `<div class="nc-stage"><div class="empty nc-empty"><span class="tile-i">${icon('search')}</span><h4>No ${esc(what)} ${esc(bits.join(' '))}</h4><p>${d.list.length ? 'Widen the context to see connections.' : 'Highlight a verse or write a note and it appears here.'}</p>
    ${undo.length ? `<div class="ls-row">${undo.map(([k, l]) => `<button class="btn btn-tinted sm" type="button" data-st-unset="${k}" data-key="unset-${k}">${l}</button>`).join('')}${undo.length > 1 ? '<button class="btn btn-plain sm" type="button" data-st-clear data-key="clear">Clear all</button>' : ''}</div>` : ''}</div></div>`;
}
function connectHtml(d) {
  normaliseFilters(d);
  const list = shownList(d);
  SV.ths = S2.threads(list, SV.xrefs); nameThreads(SV.ths, d);
  if (view.thread && !SV.ths.some(t => t.id === view.thread)) view.thread = '';
  const conns = S2.connections(list, SV.xrefs, null), refs = conns.filter(e => e.kind === 'ref').length, xr = conns.filter(e => e.kind === 'xref').length;
  const shared = d.themes ? d.themes.overall.filter(t => list.filter(n => noteThemes(d, n.id).some(x => x.name === t.name)).length >= 2).length : 0;
  const seg = [['threads', 'Threads'], ['board', 'Theme board']].map(([v, l]) => `<button type="button" role="radio" data-st-viz="${v}" data-key="viz-${v}" aria-checked="${view.viz === v}" tabindex="${view.viz === v ? 0 : -1}">${l}</button>`).join('');
  const panel = !list.length ? emptyConnect(d) : view.viz === 'threads' ? threadsHtml(d, list) : boardHtml(d, list);
  return `<div class="nc-head"><div><h3 class="nc-title" id="nc-title">Your notes, connected</h3><p class="nc-sub">${esc(`${plural(refs, 'reference')} of your own · ${plural(xr, 'cross-reference')} · ${plural(shared, 'shared theme')}`)}</p></div>
    <div class="segmented sm ls-seg nc-seg" id="st-viz" role="radiogroup" aria-label="Show your notes as"><span class="seg-ind" aria-hidden="true"></span>${seg}</div></div>
    ${ctxBar(d, list)}<div id="nc-panel">${panel}</div>`;
}
/** Each thread takes a name (its commonest tag, else its first note) and a line colour (its commonest highlight, unused by another thread). */
function nameThreads(ths, d) {
  const used = new Set();
  for (const t of ths) {
    const tags = new Map(), cols = new Map();
    for (const id of t.chain) for (const g of (d.byId.get(id) || {}).tags || []) tags.set(g, (tags.get(g) || 0) + 1);
    for (const id of t.noteIds) { const c = (d.byId.get(id) || {}).color; if (c) cols.set(c, (cols.get(c) || 0) + 1); }
    const top = [...tags].sort((a, z) => z[1] - a[1])[0], colours = [...cols].sort((a, z) => z[1] - a[1]).map(x => x[0]);
    t.name = top ? S2.tagLabel(top[0]) : (d.byId.get(t.chain[0]) || {}).label || 'A';
    const c = colours.find(x => TC[x] && !used.has(x)) || Object.keys(TC).find(x => !used.has(x)) || 'blue'; used.add(c); t.tc = TC[c];
  }
}
function threadsHtml(d, list) {
  const ths = SV.ths, r = d.r, tOf = new Map(); for (const t of ths) for (const id of t.noteIds) tOf.set(id, t);
  const rows = [...list].sort((a, z) => a.created - z.created);
  const dayN = t => Math.floor((t - +r.from) / DAY);
  const weekOf = t => { const x = new Date(t), dow = (x.getDay() + 6) % 7; return +new Date(x.getFullYear(), x.getMonth(), x.getDate() - dow); };
  const weekLabel = w => fmtSpan(Math.max(w, +r.from), Math.min(w + 6 * DAY, +r.last));
  let html = '', prev = null, prevWeek = null;
  for (const n of rows) {
    const wk = weekOf(n.created);
    if (wk !== prevWeek) { html += `<li class="tr-week" aria-hidden="true">${esc(weekLabel(wk))}</li>`; prevWeek = wk; prev = null; }
    const gapDays = prev ? dayN(n.created) - dayN(prev.created) : 0;
    const newDay = !prev || gapDays > 0, gap = !prev ? 6 : gapDays === 0 ? 6 : 10 + Math.min(4, gapDays) * 5;
    const t = tOf.get(n.id), dt = new Date(n.created);
    // a reference back to a note from a week or more before: the thread returns
    let ret = '';
    if (t) {
      const back = t.edges.filter(e => e.from === n.id).map(e => ({ e, o: d.byId.get(e.to) })).filter(x => x.o && n.created - x.o.created >= 7 * DAY).sort((a, z) => a.o.created - z.o.created)[0];
      if (back) ret = `<span class="tr-ret${back.e.kind === 'ref' ? '' : ' x'}">${icon('route')}${back.e.kind === 'ref' ? 'Back to' : 'By cross-reference to'} ${esc(back.o.label)}, ${esc(plural(Math.round((n.created - back.o.created) / DAY), 'day'))} later</span>`;
    }
    html += `<li class="tr-row" data-id="${esc(n.id)}"${t ? ` data-th="${t.id}"` : ''} style="--gap:${gap}px${t ? `;--tc:${t.tc}` : ''}">
      <div class="tr-date" aria-hidden="true">${newDay ? `<b>${dt.getDate()}</b>${WD[dt.getDay()]}` : ''}</div>
      <span class="tr-dot${t ? ' in' : ''}" data-kind="${n.kind}" data-color="${esc(n.color)}" aria-hidden="true"></span>
      <button type="button" class="tr-card ls-note${SV.card === n.id ? ' is-open' : ''}" data-color="${esc(n.color)}" data-kind="${n.kind}" data-st-note="${esc(n.id)}" data-key="tr-${esc(n.id)}">
        <span class="tr-top"><b>${esc(n.label)}</b><span>${esc(`${S2.KIND[n.kind]} · ${fmtDay(n.created)}${t ? ` · ${t.name} thread` : ''}`)}</span></span>
        <span class="tr-q">${n.kind === 'note' ? esc(S2.plainText(verseOf(n), 220)) : S2.markHtml(n, n.quote)}</span>
        ${n.text ? `<span class="tr-t">${esc(S2.plainText(n.text, 220))}</span>` : ''}${ret}
      </button></li>`;
    prev = n;
  }
  const legend = ths.length ? ths.map(t => `<button type="button" class="tr-th" data-st-thread="${t.id}" data-key="th-${t.id}" aria-pressed="${view.thread === t.id}" style="--tc:${t.tc}" title="${esc(fmtSpan(t.start, t.end))}"><b>${esc(t.name)}</b><span>${esc(plural(t.noteIds.length, 'note'))} · ${t.days ? esc(plural(t.days, 'day')) : 'one day'}</span></button>`).join('')
    : '<p class="nc-note">No threads in these notes: a thread needs three notes joined by your own references.</p>';
  const sel = ths.find(t => t.id === view.thread);
  const chain = sel ? `<div class="tr-chain" aria-label="The ${esc(sel.name)} thread, in the order studied">${sel.chain.map((id, i) => `${i ? icon('arrow-right') : ''}<button type="button" class="note-ref" data-st-note="${esc(id)}">${esc((d.byId.get(id) || {}).label || '')}</button>`).join('')}</div>` : '';
  return `<div class="nc-stage">
      <div class="nc-tools"><div class="tr-legend" role="group" aria-label="Threads">${legend}</div><p class="nc-note">Solid lines are your own references; a dashed line joins a note by cross-reference.</p></div>${chain}
      <div class="tr-wrap${sel ? ' has-hot' : ''}" id="tr-wrap"><svg class="tr-arcs" id="tr-arcs" aria-hidden="true"></svg><ol class="tr-list" aria-label="Your notes in the order studied">${html}</ol></div>
    </div>${trAltHtml(d, ths, rows)}`;
}
function drawArcs() {
  const wrap = document.getElementById('tr-wrap'), svg = document.getElementById('tr-arcs'); if (!wrap || !svg || !SV.ths) return;
  const wr = wrap.getBoundingClientRect(), at = new Map();
  for (const row of $$('.tr-row', wrap)) { const dot = $('.tr-dot', row).getBoundingClientRect(); at.set(row.dataset.id, { x: dot.left + dot.width / 2 - wr.left, y: dot.top + dot.height / 2 - wr.top }); }
  if (!at.size) { svg.innerHTML = ''; return; }
  const ys = [...at.values()].map(p => p.y), ax = [...at.values()][0].x;
  const gut = parseFloat(getComputedStyle(wrap).getPropertyValue('--gut')) || 100;
  let out = `<line x1="${ax}" y1="${Math.min(...ys)}" x2="${ax}" y2="${Math.max(...ys)}"/>`;
  // every arc has its own lane, nested: the longer the span of time, the further out it bows
  const arcs = [];
  for (const t of SV.ths) for (const e of t.edges) { const p = at.get(e.from), q = at.get(e.to); if (p && q) arcs.push({ t, e, p, q, span: Math.abs(q.y - p.y) }); }
  arcs.sort((a, z) => a.span - z.span);
  const inner = 12, outer = Math.max(inner + 10, gut - 6);
  arcs.forEach((a, i) => {
    const bow = Math.min(inner + a.span * .5, inner + (outer - inner) * (arcs.length > 1 ? i / (arcs.length - 1) : 0) + 2), x = (ax - bow).toFixed(1);
    out += `<path class="${a.e.kind === 'ref' ? '' : 'x'}" data-th="${a.t.id}" style="--tc:${a.t.tc}" d="M${ax} ${a.p.y.toFixed(1)}C${x} ${a.p.y.toFixed(1)} ${x} ${a.q.y.toFixed(1)} ${ax} ${a.q.y.toFixed(1)}"/>`;
  });
  svg.innerHTML = out;
  if (view.thread) trHot(view.thread, true);
}
function trHot(thId, sticky = false) {
  const wrap = document.getElementById('tr-wrap'); if (!wrap) return;
  if (!thId && !sticky && view.thread) thId = view.thread;
  wrap.classList.toggle('has-hot', !!thId);
  for (const p of $$('.tr-arcs path', wrap)) p.classList.toggle('on', p.dataset.th === thId);
  for (const row of $$('.tr-row', wrap)) row.classList.toggle('on', row.dataset.th === thId);
}
function trAltHtml(d, ths, rows) {
  const inT = new Set(ths.flatMap(t => t.noteIds)), lab = id => (d.byId.get(id) || {}).label || '';
  const how = (t, id) => [...t.edges.filter(e => e.from === id).map(e => `${e.kind === 'ref' ? 'mentions' : 'cross-reference to'} ${lab(e.to)}`), ...t.edges.filter(e => e.to === id && e.kind === 'ref').map(e => `mentioned in ${lab(e.from)}`)];
  const row = (n, h) => `<li><button type="button" class="cell" data-st-note="${esc(n.id)}"><span class="hdot" data-color="${esc(n.color)}"></span><span class="cell-body"><span class="cell-title">${esc(n.label)} <span>· ${esc(fmtDay(n.created))}${n.phrase ? `, “${esc(n.phrase)}”` : ''}</span></span>${h && h.length ? `<span class="cell-sub">${esc(h.join('; '))}</span>` : ''}</span></button></li>`;
  const body = ths.map(t => `<h4>${esc(t.name)} thread · ${esc(plural(t.noteIds.length, 'note'))}, ${esc(fmtSpan(t.start, t.end))}</h4><ul class="group">${t.noteIds.map(id => { const n = d.byId.get(id); return n ? row(n, how(t, id)) : ''; }).join('')}</ul>`).join('');
  const rest = rows.filter(n => !inT.has(n.id));
  return `<details class="nc-alt"><summary>${icon('chev-right')}The same, as a list (${esc(plural(ths.length, 'thread'))})</summary>${body}
    ${rest.length ? `<h4>Not in a thread · ${esc(plural(rest.length, 'note'))}</h4><ul class="group">${rest.map(n => row(n)).join('')}</ul>` : ''}</details>`;
}
/** The board's columns: every theme the period found (merged, renamed, removed as chosen), then “Not grouped yet”. Each card sits in one column. */
function boardColumns(d, list) {
  const T = d.themes, accepted = new Set((d.choices.accepted || []));
  const cols = (T ? T.overall : []).map(t => ({ key: t.name, label: t.label, suggested: !accepted.has(t.name), also: t.also, cards: [] }));
  const byKey = new Map(cols.map(c => [c.key, c])), none = { key: '_none', label: 'Not grouped yet', none: true, cards: [] };
  const solo = view.theme && !view.theme.startsWith('#') ? view.theme : '';
  for (const n of list) {
    const ths = noteThemes(d, n.id), mv = SV.moved.get(n.id);
    if (solo) { const t = ths.find(x => x.name === solo); if (t && byKey.has(solo)) byKey.get(solo).cards.push({ n, auto: !t.mine && t.suggested, why: t.why }); continue; }
    if (mv && mv.none) { none.cards.push({ n, auto: false, hint: 'Taken out of its themes' }); continue; }
    const prim = ths.find(t => byKey.has(t.name));
    if (prim) { byKey.get(prim.name).cards.push({ n, auto: !prim.mine && prim.suggested, why: prim.why }); continue; }
    const one = ths[0], weak = weakLead(d, n.id);
    none.cards.push({ n, auto: false, hint: one ? `Suggested here only: ${one.label}` : weak && !(mv && mv.drop.has(weak.name)) ? `Perhaps “${weak.label}”?` : 'No suggestion yet' });
  }
  // a fixed order (the most notes first, as first shown), so columns don't jump about as cards move
  for (const c of cols) if (!SV.border.has(c.key)) SV.border.set(c.key, (c.cards.length ? 100 - c.cards.length : 200) + SV.border.size / 1000);
  // every theme the period lists has a column, even one whose notes all sit under stronger themes (“0 of 2”)
  let out = [...cols.filter(c => c.cards.length || (!filtered() && colTotal(d, c, list))).sort((a, z) => SV.border.get(a.key) - SV.border.get(z.key)), none];
  if (solo) out = out.filter(c => c.key === solo);
  return filtered() ? out.filter(c => c.cards.length) : out;
}
/** How many of the shown notes carry a column's theme (a card sits in one column only, so a column can hold fewer). */
function colTotal(d, c, list) {
  if (c.none) return c.cards.length;
  return new Set([...c.cards.map(x => x.n.id), ...list.filter(n => noteThemes(d, n.id).some(t => t.name === c.key)).map(n => n.id)]).size;
}
const colLabel = (d, key) => (key === '_none' ? 'Not grouped yet' : ((d.themes && d.themes.overall.find(t => t.name === key)) || {}).label || (d.choices.renamed || {})[key] || S2.themeLabel(key));
const cssId = s => String(s).replace(/[^a-z0-9_-]+/gi, '-');
function cardHtml(x, c) {
  const n = x.n;
  return `<li><div class="tb-card ls-note${SV.card === n.id ? ' is-open' : ''}" data-color="${esc(n.color)}" data-kind="${n.kind}" data-id="${esc(n.id)}" data-col="${esc(c.key)}">
    <button type="button" class="tb-open" data-st-note="${esc(n.id)}" data-key="tb-${esc(n.id)}" aria-label="${esc(`${n.label}, ${S2.KIND[n.kind].toLowerCase()}${n.phrase ? `: “${n.phrase}”` : ''}${x.auto ? '. Suggested for this theme' : ''}`)}">
      <span class="tb-ref">${esc(n.label)}</span><span class="tb-q">${n.kind === 'note' ? esc(S2.plainText(verseOf(n), 120)) : S2.markHtml(n, n.phrase, n.phrase)}</span>${n.text ? `<span class="tb-t">${esc(S2.plainText(n.text, 150))}</span>` : ''}</button>
    <div class="tb-foot">${x.auto ? `<span class="ls-badge lamp" title="${esc(x.why || '')}">Suggested</span>` : x.hint ? `<span class="tb-hint">${esc(x.hint)}</span>` : `<span class="tb-meta">${esc(`${S2.KIND[n.kind]} · ${fmtDay(n.created)}`)}</span>`}<span class="nc-grow"></span>
      <button type="button" class="tb-move" data-st-move="${esc(n.id)}" data-key="mv-${esc(n.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="Move ${esc(n.label)} to another theme">${icon('ellipsis')}</button><span class="tb-grip" aria-hidden="true" title="Drag to move"></span></div></div></li>`;
}
function boardHtml(d, list) {
  const cols = boardColumns(d, list);
  const colHtml = c => {
    const ns = c.cards.map(x => x.n), total = colTotal(d, c, list), more = total - ns.length, sits = more === 1 ? 'sits' : 'sit';
    const why = ns.length ? `${plural(ns.length, 'note')} on ${chaptersOf(ns)}${more > 0 ? ` · ${more} more ${sits} under a stronger theme` : ''}`
      : more > 0 ? `${more === 1 ? 'Its one note sits' : more === 2 ? 'Both its notes sit' : `All ${more} of its notes sit`} under ${more === 1 ? 'a stronger theme' : 'stronger themes'}. Drag one here to lead with this theme` : 'Drop a note here to give it this theme';
    const badge = c.suggested ? '<span class="ls-badge lamp">Suggested</span>' : '';
    const also = c.also && c.also.length ? `<br><i>Includes ${esc(andList(c.also.map(a => `“${colLabel(d, a)}”`)))}</i>` : '';
    const menu = c.none ? '' : `<button type="button" class="tb-menu" data-st-colmenu="${esc(c.key)}" data-key="col-${esc(c.key)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(c.label)}: theme options">${icon('ellipsis')}</button>`;
    return `<section class="tb-col${c.none ? ' none' : ''}" data-key="${esc(c.key)}" tabindex="-1" aria-labelledby="tbh-${cssId(c.key)}">
      <div class="tb-col-head"><div><h4 class="tb-col-title" id="tbh-${cssId(c.key)}"><span class="tb-name">${esc(c.label)}</span><span class="ls-count"${more > 0 ? ` title="${ns.length} here, ${total} in all"` : ''}>${more > 0 ? `${ns.length} of ${total}` : ns.length}</span>${badge}</h4>
        <p class="tb-why">${c.none ? 'Notes whose themes are still unclear, or found only once' : esc(why)}${also}</p></div>${menu}</div>
      <ul class="tb-cards">${c.cards.length ? c.cards.map(x => cardHtml(x, c)).join('') : `<li class="tb-empty">${c.none ? 'Nothing here' : 'Drag a note here'}</li>`}</ul></section>`;
  };
  const phone = isPhone(), many = cols.length > 1;
  const thread = view.thread ? SV.ths.find(t => t.id === view.thread) : null, lit = thread ? new Set(thread.noteIds) : null;
  if (phone && many && !cols.some(c => c.key === SV.boardCol)) SV.boardCol = view.theme && cols.some(c => c.key === view.theme) ? view.theme : cols[0].key;
  const picker = phone && many ? `<label class="pill-select lead tb-pick">${icon('tag', 'lead-i')}<select id="tb-pick" data-key="tb-pick" aria-label="Theme shown">${cols.map(c => `<option value="${esc(c.key)}"${c.key === SV.boardCol ? ' selected' : ''}>${esc(c.label)} (${c.cards.length})</option>`).join('')}</select>${icon('chev-down', 'chev')}</label>` : '';
  return `<div class="nc-tools tb-tools"><p class="nc-note">${SV.topics ? 'Themes found in your notes. Drag a card to re-theme it, or use its ⋯ button; the theme it goes to is kept.' : 'The topics could not be loaded, so no themes are suggested.'}</p></div>
    ${many && !phone ? `<div class="tb-index" role="group" aria-label="Go to a theme">${cols.map(c => `<button type="button" class="ls-chip${c.suggested ? ' sg' : ''}" data-st-jump="${esc(c.key)}" data-key="jump-${esc(c.key)}"${c.suggested ? ' title="Suggested"' : ''}>${esc(c.label)}<span class="ls-count">${c.cards.length}</span></button>`).join('')}</div>` : ''}${picker}
    <div class="tb-scroller" id="tb-scroller" data-at="all">
      <button type="button" class="tb-arrow prev" data-st-scroll="-1" aria-label="Earlier columns">${icon('chev-left')}</button>
      <div class="tb-board${cols.length === 1 ? ' solo' : ''}${phone && many ? ' one' : ''}${lit ? ' has-thread' : ''}" id="tb-board">${cols.map(colHtml).join('')}</div>
      <button type="button" class="tb-arrow next" data-st-scroll="1" aria-label="More columns">${icon('chev-right')}</button></div>
    <template id="tb-lit">${lit ? [...lit].map(esc).join(',') : ''}</template>`;
}
/** 'John 1, 3 and 8; Genesis 1' (the books with the most notes first). */
function chaptersOf(list) {
  const books = new Map();
  for (const n of list) { const e = books.get(n.b) || { b: n.b, n: 0, cs: new Set() }; e.n++; e.cs.add(n.c); books.set(n.b, e); }
  const parts = [...books.values()].sort((a, z) => z.n - a.n || a.b - z.b).map(e => `${e.b === 19 ? (e.cs.size > 1 ? 'Psalms' : 'Psalm') : bookName(e.b)} ${andList([...e.cs].sort((x, y) => x - y).map(String))}`);
  return parts.slice(0, 3).join('; ') + (parts.length > 3 ? ` and ${plural(parts.length - 3, 'other book')}` : '');
}
/** Which way the board can still scroll: the edge fades and arrows follow. */
function tbEdges() {
  const sc = document.getElementById('tb-scroller'), b = document.getElementById('tb-board'); if (!sc || !b) return;
  const max = b.scrollWidth - b.clientWidth;
  sc.dataset.at = max <= 2 ? 'all' : b.scrollLeft <= 2 ? 'start' : b.scrollLeft >= max - 2 ? 'end' : 'mid';
}
function afterBoard(host) {
  const phone = isPhone();
  if (phone) for (const c of $$('.tb-col', host)) c.hidden = $$('.tb-col', host).length > 1 && c.dataset.key !== SV.boardCol;
  const lit = $('#tb-lit', host); if (lit && lit.innerHTML) { const ids = new Set(lit.innerHTML.split(',')); for (const c of $$('.tb-card', host)) c.classList.toggle('lit', ids.has(c.dataset.id)); }
  tbEdges(); requestAnimationFrame(tbEdges);
}

// ------------------------------------------------------------ the note card (a side panel in the dialog; a sheet on phones)
function cardEl() {
  let el = document.getElementById('lib-ncard');
  if (!el) { const d = libDialog(); if (!d) return null; d.insertAdjacentHTML('beforeend', '<div class="lib-ncard-scrim" id="lib-ncard-scrim" aria-hidden="true"></div><aside class="lib-ncard" id="lib-ncard" aria-labelledby="lib-ncard-title" aria-hidden="true" inert></aside>'); el = document.getElementById('lib-ncard'); }
  return el;
}
function openCard(id, { from = null, push = false } = {}) {
  const d = stData(), n = d.byId.get(id), el = n && cardEl(); if (!el) return;
  if (push && SV.card && SV.card !== id) SV.hist.push(SV.card); else if (!push) SV.hist = [];
  if (!el.classList.contains('open')) SV.returnTo = from || document.activeElement;
  SV.card = id; view.note = id;
  el.classList.add('open'); el.setAttribute('aria-hidden', 'false'); el.inert = false;   // visible first, so focus can move in
  document.getElementById('lib-ncard-scrim')?.classList.add('on');
  renderCard(d);
  paintOpen();
  requestAnimationFrame(() => document.getElementById('lib-ncard-title')?.focus({ preventScroll: true }));
}
function closeCard({ restore = true } = {}) {
  const el = document.getElementById('lib-ncard'); if (!el || !el.classList.contains('open')) return;
  el.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); el.inert = true;
  document.getElementById('lib-ncard-scrim')?.classList.remove('on');
  SV.card = null; SV.hist = []; view.note = '';
  paintOpen();
  const back = SV.returnTo; SV.returnTo = null;
  if (restore && back && back.isConnected) back.focus({ preventScroll: true });
}
function paintOpen() { for (const el of $$('#lib-study .tr-card, #lib-study .tb-card')) el.classList.toggle('is-open', (el.dataset.stNote || el.dataset.id) === SV.card); }
const metaLine = n => `${S2.KIND[n.kind]} · ${fmtDay(n.created)}${n.updated && localDay(n.updated) !== localDay(n.created) ? ` · added to ${fmtDay(n.updated)}` : ''}`;
/** Where the note sits in This month: in the thread of the period, else among its theme's notes, else its book's. */
function whereInMonth(d, n) {
  const span = view.mode === 'month' ? 'the month' : `these ${view.mode} days`, top = d.threads[0];
  if (top && top.noteIds.includes(n.id)) return { text: `Part of the thread of ${span}`, go: { thread: top.id, focus: 1 } };
  const t = noteThemes(d, n.id)[0];
  if (t) { const k = d.list.filter(x => noteThemes(d, x.id).some(y => y.name === t.name)).length; if (k > 1) return { text: `One of ${k} notes in ${t.label}`, go: { theme: t.name, focus: 1 } }; }
  const k = d.list.filter(x => x.b === n.b).length;
  return k > 1 ? { text: `One of ${k} notes in ${bookName(n.b)}`, go: { book: String(n.b), focus: 1 } } : null;
}
function renderCard(d = stData()) {
  const el = document.getElementById('lib-ncard'), n = SV.card && d.byId.get(SV.card); if (!el || !n) return;
  if (n.v && !SV.texts.has(textKey(n))) stTexts([n]).then(() => { if (SV.card === n.id) renderCard(); });
  const T = d.list.includes(n) ? d.themes : themesAll(d.all), dd = { ...d, themes: T };
  const ths = noteThemes(dd, n.id), weak = weakLead(dd, n.id), mi = S2.backlinks(n, d.all).map(x => x.entry);
  const ids = new Set(d.all.map(e => e.id));
  const verseRefs = [...new Set(S2.parseRefs(n.text).map(r => S2.resolveRef(r)).filter(res => !ids.has(S2.refId(res))).map(res => `${res.b}.${res.c}.${res.v}`))];
  const xr = S2.topXrefs(n, SV.xrefs, 3), noteVerse = new Map(d.all.map(x => [x.ref, x]));
  const themeChips = ths.map(t => `<span class="ls-chip theme${t.suggested ? ' suggested' : ''}" title="${esc(t.why)}">${esc(t.label)}${t.suggested ? '<span class="ls-badge lamp">Suggested</span>' : ''}</span>`).join('') + n.tags.map(t => `<span class="ls-chip">#${esc(t)}</span>`).join('');
  const whys = ths.map(t => `<li><b>${esc(t.label)}</b>: ${esc(t.why)}${t.xrefs && t.xrefs.length && !t.mine ? ` (${esc(andList(t.xrefs.slice(0, 2)))})` : ''}</li>`).join('');
  const where = whereInMonth(d, n), vchip = ref => { const p = parseRef(ref); return `<button type="button" class="ls-chip verse-ref" data-st-verse="${esc(ref)}">${icon('book')}${esc(p ? refName(p.b, p.c, p.v) : ref)}</button>`; };
  el.innerHTML = `<div class="nc-card-top"><div>
      ${SV.hist.length ? `<button type="button" class="nc-back" data-st-card-back>${icon('chev-left')}${esc((d.byId.get(SV.hist[SV.hist.length - 1]) || {}).label || 'Back')}</button>` : ''}
      <p class="ls-kicker">${esc(metaLine(n))}</p><h3 class="nc-card-title" id="lib-ncard-title" tabindex="-1">${esc(n.label)}</h3></div>
      <button type="button" class="close-btn" data-st-card-close aria-label="Close note">${icon('xmark')}</button></div>
    <div class="nc-card-body">
      ${where ? `<button type="button" class="nc-where" data-st-month="${esc(new URLSearchParams(where.go).toString())}">${icon('calendar')}<span>${esc(where.text)}</span><span class="go">This month${icon('chev-right')}</span></button>` : ''}
      <article class="ls-note" data-color="${esc(n.color)}" data-kind="${n.kind}" aria-label="${esc(n.label)}">
        ${n.v ? `<p class="ls-verse">${S2.markHtml(n, verseOf(n))}</p>` : ''}
        ${n.text ? `<div class="ls-md md">${renderMd(n.text)}</div>` : `<p class="ls-md nc-none">${n.kind === 'highlight' ? 'No words added to this highlight yet.' : 'Nothing written yet.'}</p>`}
        <div class="nc-themes" aria-label="Themes">${themeChips || (weak ? `<span class="ls-chip suggested">Perhaps “${esc(weak.label)}”?</span>` : '<span class="nc-none">No suggestion yet</span>')}</div>
        ${whys ? `<details class="nc-why"><summary>${icon('chev-right')}Why these themes</summary><ul>${whys}</ul></details>` : ''}
        <div class="ls-links">
          <h4>References <span class="ls-count">${n.refs.length + verseRefs.length}</span></h4>
          <div class="ls-chips">${chipsFor(d, n.refs)}${verseRefs.map(vchip).join('') || (n.refs.length ? '' : '<span class="nc-none">This note doesn’t mention another yet. Type [[ in a note to reference one.</span>')}</div>
          <h4>Mentioned in <span class="ls-count">${mi.length}</span></h4>
          <div class="ls-chips">${chipsFor(d, mi.map(x => x.id)) || '<span class="nc-none">No other note mentions this one yet.</span>'}</div>
        </div>
      </article>
      ${xr.length ? `<section class="nc-xr" aria-labelledby="nc-xr-h"><h4 id="nc-xr-h">Cross-references (OpenBible)</h4><ul>${xr.map(x => { const mine = noteVerse.get(x.ref); return `<li>${mine ? `<button type="button" class="note-ref" data-st-note="${esc(mine.id)}">${esc(x.label)}</button>` : `<button type="button" class="verse-ref" data-st-verse="${esc(x.ref)}">${esc(x.label)}</button>`}<span>${mine ? 'Your note · ' : ''}${x.votes} votes</span></li>`; }).join('')}</ul></section>` : ''}
      <div class="nc-actions"><button type="button" class="btn btn-tinted sm" data-st-edit="${esc(n.id)}">${icon('note')}Edit note</button><button type="button" class="btn btn-plain sm" data-st-verse="${esc(n.v ? n.ref : `${n.b}.${n.c}.1`)}">${icon('book')}Open in the reader</button></div>
    </div>`;
}
/** Edit note: the Notes tab for that verse in the study sheet (a highlight's or comment's words are shown there too). */
function editNote(e) {
  closeCard({ restore: false }); closeLib();
  A?.navigate?.(e.b, e.c, e.v || 0);
  if (e.v) A?.select?.(e.v, { tab: 'notes', focus: true }); else A?.openTab?.('notes', { focus: true });
  if (e.mark && mrk && typeof mrk.flashMark === 'function') setTimeout(() => { try { mrk.flashMark(e.id); } catch (err) { /* not drawn yet */ } }, 500);
}
/** Go to a verse in the reader ('b.c.v'), closing the Library. */
function goVerse(ref) { const p = parseRef(String(ref).replace(/\.0$/, '')); if (!p) return; closeCard({ restore: false }); closeLib(); A?.navigate?.(p.b, p.c, p.v || 0); A?.yieldToPage?.(); }
/** A verse link in a note's markdown (drawer.js renderMd) inside Study: a chip to a highlight or a verse with a note opens its card, another verse the reader. */
function goMdLink(vl) {
  const d = stData(), m = vl.dataset.mark && d.byId.get(vl.dataset.mark);
  if (m) { openCard(m.id, { from: vl, push: !!vl.closest('#lib-ncard') }); return; }
  const r = S.parseReference(String(vl.dataset.ref || vl.textContent || ''));
  const mine = r && d.all.find(x => x.kind === 'note' && x.b === r.b && x.c === r.c && x.v === (r.v || 0));
  if (mine) openCard(mine.id, { from: vl, push: !!vl.closest('#lib-ncard') }); else if (r) goVerse(`${r.b}.${r.c}.${r.v || 0}`);
}

// ------------------------------------------------------------ choices, moves and the hand-offs
/** Keep, rename, merge or remove a theme: the choice is saved with the notes (store.saveThemes), with Undo. */
function choose(d, kind, name, extra) {
  const before = clone(d.choices), c = clone(d.choices), t = d.themes && d.themes.overall.find(x => x.name === name), lbl = t ? t.label : S2.themeLabel(name);
  const accept = x => { if (!c.accepted.includes(x)) c.accepted.push(x); };
  let msg = '', focus = `theme-${name}`;
  if (kind === 'keep') { accept(name); msg = `Kept “${lbl}” as a theme`; focus = `rename-${name}`; }
  else if (kind === 'rename') { if (!extra || extra === lbl) { SV.renaming = null; paintStudy({ focus: `theme-${name}` }); return; } c.renamed[name] = extra; accept(name); msg = `Renamed “${lbl}” to “${extra}”`; }
  else if (kind === 'merge') { if (!extra || extra === name) return; const into = d.themes && d.themes.overall.find(x => x.name === extra); c.merged[name] = extra; for (const x of (t ? t.also : [])) c.merged[x] = extra; accept(extra); msg = `Merged “${lbl}” into “${into ? into.label : S2.themeLabel(extra)}”`; SV.openTheme = extra; focus = `theme-${extra}`; if (view.theme === name) view.theme = extra; }
  else if (kind === 'remove') { c.removed.push(name, ...(t ? t.also : [])); c.accepted = c.accepted.filter(x => x !== name); msg = `Removed “${lbl}”. Its notes keep their other themes`; SV.openTheme = null; focus = 'themes-h'; if (view.theme === name) view.theme = ''; }
  else return;
  SV.renaming = null;
  if (!S.saveThemes(c)) return;   // a hosted guest: the sign-in prompt was shown
  const colKey = kind === 'merge' ? extra : kind === 'remove' ? null : name;
  paintStudy({ focus: view.tab === 'connected' ? (colKey ? `col-${colKey}` : 'f-theme') : focus });
  toast(DRY ? `${msg}. ${DRY_MSG}` : msg, { label: 'Undo', run: () => { S.saveThemes(before); paintStudy({ focus: view.tab === 'connected' ? `col-${name}` : `theme-${name}` }); } });
  live(msg);
}
/** Move a note to another column: it leads with that theme here, and the theme is kept (the choice that is saved). */
function moveNote(d, id, from, to) {
  if (from === to) return;
  const n = d.byId.get(id); if (!n) return;
  const snap = { moved: new Map([...SV.moved].map(([k, v]) => [k, { to: v.to, drop: new Set(v.drop), none: v.none }])), choices: clone(d.choices) };
  const mv = SV.moved.get(id) || { to: null, drop: new Set(), none: false };
  if (from !== '_none') mv.drop.add(from);
  if (to === '_none') { mv.to = null; mv.none = true; } else { mv.to = to; mv.none = false; mv.drop.delete(to); }
  SV.moved.set(id, mv);
  let kept = false;
  if (to !== '_none' && !(d.choices.accepted || []).includes(to)) { const c = clone(d.choices); c.accepted.push(to); kept = !!S.saveThemes(c); }
  const where = colLabel(d, to), msg = `Moved ${n.label} to ${where}${kept ? ` and kept “${where}”` : ''}`;
  paintStudy({ focus: `tb-${id}` });
  toast(DRY && kept ? `${msg}. ${DRY_MSG}` : msg, { label: 'Undo', run: () => { SV.moved = snap.moved; if (kept) S.saveThemes(snap.choices); paintStudy({ focus: `tb-${id}` }); } });
  live(msg);
}
/** A suggested placement accepted as it is: the note stays, the theme is kept. */
function keepHere(d, id, col) {
  const n = d.byId.get(id); if (!n) return;
  const mv = SV.moved.get(id) || { to: null, drop: new Set(), none: false }; mv.to = col; mv.none = false; SV.moved.set(id, mv);
  if (!(d.choices.accepted || []).includes(col)) { const c = clone(d.choices); c.accepted.push(col); if (!S.saveThemes(c)) return; }
  paintStudy({ focus: `tb-${id}` }); live(`Kept ${n.label} under ${colLabel(d, col)}`);
}
const menuItems = items => items.map(it => (it === '-' ? '<hr>' : it.head ? `<div class="group-h" role="presentation">${esc(it.head)}</div>` : `<button type="button" role="menuitem" data-mi="${esc(it.id)}"${it.danger ? ' class="danger"' : ''}>${esc(it.label)}${it.icon ? icon(it.icon) : ''}</button>`)).join('');
function stMenu(anchor, items, label) {
  if (!fn('openMenu')) return;
  ui.openMenu(anchor, `<div role="menu" aria-label="${esc(label)}">${menuItems(items)}</div>`, { label, className: 'st-menu', onClick: e => {
    const b = e.target.closest('[data-mi]'); if (!b) return;
    const it = items.find(x => x && x.id === b.dataset.mi); closeMenuSafe(!(it && it.keep)); if (it) it.run();
  } });
}
/** ⋯ on a card: keep a suggested placement, move the note to another theme, open it. */
function moveMenu(d, btn) {
  const cardEl = btn.closest('.tb-card'), id = cardEl.dataset.id, from = cardEl.dataset.col, n = d.byId.get(id); if (!n) return;
  const keys = $$('#lib-study .tb-col').map(c => c.dataset.key), all = [...(d.themes ? d.themes.overall.map(t => t.name) : []), '_none'];
  const items = [];
  if (cardEl.querySelector('.ls-badge.lamp')) items.push({ id: 'keep', label: `Keep under ${colLabel(d, from)}`, icon: 'check', run: () => keepHere(d, id, from) }, '-');
  items.push({ head: 'Move to theme' });
  for (const k of new Set([...keys, ...all])) if (k !== from) items.push({ id: `to:${k}`, label: colLabel(d, k), run: () => moveNote(d, id, from, k) });
  items.push('-', { id: 'open', label: 'Open note', icon: 'note', run: () => openCard(id, { from: btn }) });
  stMenu(btn, items, `Move ${n.label}`);
}
/** ⋯ on a column: accept, rename, merge into another or remove the theme. */
function colMenu(d, btn) {
  const key = btn.dataset.stColmenu, label = colLabel(d, key), others = (d.themes ? d.themes.overall.map(t => t.name) : []).filter(k => k !== key);
  const items = [];
  if (!(d.choices.accepted || []).includes(key)) items.push({ id: 'accept', label: 'Accept theme', icon: 'check', run: () => choose(d, 'keep', key) });
  items.push({ id: 'rename', label: 'Rename…', icon: 'note', run: () => renameCol(d, key) });
  if (others.length) items.push({ id: 'merge', label: 'Merge into…', icon: 'arrow-right', run: () => setTimeout(() => stMenu(btn, [{ head: `Merge “${label}” into` }, ...others.map(k => ({ id: `into:${k}`, label: colLabel(d, k), run: () => choose(d, 'merge', key, k) }))], `Merge ${label}`), 0) });
  items.push('-', { id: 'remove', label: 'Remove theme', icon: 'xmark', danger: true, run: () => choose(d, 'remove', key) });
  stMenu(btn, items, `${label}: options`);
}
function renameCol(d, key) {
  const col = $(`#lib-study .tb-col[data-key="${cssEsc(key)}"]`); if (!col) return;
  const cur = colLabel(d, key), head = $('.tb-col-head', col);
  head.insertAdjacentHTML('afterend', `<form class="tb-rename"><label class="field sm"><input value="${esc(cur)}" aria-label="New name for ${esc(cur)}" maxlength="100" autocomplete="off"></label></form>`);
  head.hidden = true;
  const form = $('.tb-rename', col), input = $('input', form);
  input.focus(); input.select();
  let finished = false;
  const done = save => {
    if (finished) return; finished = true;
    const v = input.value.replace(/\s+/g, ' ').trim();
    if (save && v && v !== cur) choose(d, 'rename', key, v);
    else { form.remove(); head.hidden = false; $(`[data-st-colmenu="${cssEsc(key)}"]`, col)?.focus(); }
  };
  form.addEventListener('submit', e => { e.preventDefault(); done(true); });
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } });
  input.addEventListener('blur', () => setTimeout(() => { if (form.isConnected) done(true); }, 0));
}
/** Add one of your tags to a note (the “Might belong here too” row), with Undo. */
function addTag(d, id, tag) {
  const e = d.byId.get(id); if (!e || e.kind !== 'note' || e.tags.includes(tag)) return;
  if (S.guestBlocked()) return;
  const n = S.noteFor(id, true); if (!n) return;
  if (!n.tags.includes(tag)) n.tags.push(tag); S.touchNote(id);
  paintStudy({ focus: `tag-${tag}` });
  toast(DRY ? `Tagged ${e.label} #${tag}. ${DRY_MSG}` : `Tagged ${e.label} #${tag}`, { label: 'Undo', run: () => { const x = S.noteFor(id); if (x) { x.tags = (x.tags || []).filter(t => t !== tag); S.touchNote(id); } paintStudy({ focus: `tag-${tag}` }); } });
}
/** The hand-off into Studies: `start` says what to gather (studydoc.js reads it once). */
function makeStudy(d, { ids, title, theme, thread }) {
  const r = d.r, base = { keys: ids, title, from: +r.from, to: +r.last, at: Date.now() };
  SV.start = theme ? { kind: 'theme', theme, ...base } : thread ? { kind: 'thread', thread, ...base } : { kind: 'month', ...base };
  setStTab('studies');
}
/** Hand over to Connected with the period and the given context (theme, thread, book, note or kind). */
function goConnect(extra) {
  Object.assign(view, { theme: '', book: '', kind: '', thread: '', note: '' });
  for (const k of ['theme', 'book', 'kind', 'thread', 'note']) if (extra[k]) view[k] = String(extra[k]);
  if (extra.viz === 'threads' || extra.viz === 'board') setViz(extra.viz, { paint: false });
  SV.focusReq = extra.focus === '1' || extra.focus === 1;
  setStTab('connected');
}
/** Back to This month with something to show: a thread featured, a theme or tag row open, a book row or tile focused. */
function goMonth(extra) {
  SV.openTheme = SV.openTag = SV.featured = null; SV.renaming = null;
  let key = null;
  const d = stData();
  if (extra.theme && d.themes) {
    const want = String(extra.theme).replace(/^#/, ''), low = want.toLowerCase(), i = d.themes.overall.findIndex(x => x.name === want || x.label.toLowerCase() === low);
    if (i >= 0) { SV.openTheme = d.themes.overall[i].name; if (i >= 6) SV.allThemes = true; key = `theme-${SV.openTheme}`; }
    else if (d.themes.yours.some(y => y.tag === want)) { SV.openTag = want; key = `tag-${want}`; }
  }
  if (extra.thread && d.threads.some(t => t.id === extra.thread)) { SV.featured = extra.thread; key = `stop-${(d.threads.find(t => t.id === extra.thread) || {}).chain?.[0]}`; }
  if (!key && extra.kind && KINDS.includes(extra.kind)) key = `tot-${extra.kind}`;
  if (!key && extra.book) key = `book-${extra.book}`;
  closeCard({ restore: false });
  view.tab = 'month'; SV.docOwned = false;
  renderLibrary({ still: true, tab: true });
  if (key) paintStudy({ focus: key, scroll: true });
}
function setStTab(tab, { focus = false } = {}) {
  if (!ST_TABS.some(t => t[0] === tab)) return;
  closeCard({ restore: false }); closeMenuSafe(false);
  view.tab = tab; SV.docOwned = false; SV.renaming = null;
  renderLibrary({ still: true, tab: true });
  if (focus) $(`#library-body [data-st-tab="${cssEsc(tab)}"]`)?.focus({ preventScroll: true });
}
function setViz(v, { paint = true } = {}) {
  if (v !== 'threads' && v !== 'board') return;
  view.viz = v; lsSet('bs-study-viz', v);
  if (paint) { const seg = document.getElementById('st-viz'); if (seg) setRadio(seg, b => b.dataset.stViz === v); paintStudy({ focus: `viz-${v}` }); }
}
function resetOpen() { SV.openTheme = SV.renaming = SV.openTag = SV.featured = null; SV.allThemes = SV.allLife = false; }
function stStep(dir) {
  const r = stRange(); if (dir < 0 ? !r.canPrev : !r.canNext) return;
  if (view.mode === 'month') { const d = new Date(view.y, view.m + dir, 1); view.y = d.getFullYear(); view.m = d.getMonth(); }
  else { const e = addDays(dayOf(view.end), dir * +view.mode), t = dayOf(Date.now()); view.end = +(e > t ? t : e); }
  resetOpen(); view.thread = ''; paintStudy({ focus: dir < 0 ? 'prev' : 'next' });
}
function setStMode(mode, focusKey = null) {
  if (!['month', '7', '30', '90'].includes(mode) || mode === view.mode) return;
  const t = dayOf(Date.now());
  if (mode === 'month') { const e = dayOf(view.end); view.y = e.getFullYear(); view.m = e.getMonth(); }
  else if (view.mode === 'month') { const last = new Date(view.y, view.m + 1, 0); view.end = +(last > t ? t : last); }
  view.mode = mode; resetOpen(); view.thread = '';
  const seg = document.getElementById('st-span'); if (seg) setRadio(seg, b => b.dataset.stMode === mode);
  paintStudy({ focus: focusKey || `mode-${mode}` });
}
function setFilter(k, v) {
  if (k === 'range') { if (v === 'month') setStMode('month', 'f-range'); else if (['7', '30', '90'].includes(v)) { view.end = +dayOf(Date.now()); setStMode(v, 'f-range'); } return; }
  view[k] = v; view.thread = ''; paintStudy({ focus: `f-${k}` });
}

// ------------------------------------------------------------ painting
/** Draw the open tab into #lib-study (This month and Connected), loading topics, cross-references and verse texts first. */
async function paintStudy(opts = {}) {
  const body = document.getElementById('library-body'); if (!body || view.name !== 'study') return;
  if (view.tab === 'studies') { await paintStudies(body); return; }
  const host = $('#lib-study', body); if (!host) return;
  const seq = ++SV.seq;
  if (S.readOnlyGuest()) { host.innerHTML = guestCard(); return; }
  const r = stRange(), all = S2.entries(), list = S2.inRange(+r.from, +r.toEx, all);
  if (!SV.topics || list.some(e => !SV.xrefs[e.b] || (e.v && !SV.texts.has(textKey(e))))) {
    try { await stLoad(list); } catch (e) { console.error(e); }
    if (seq !== SV.seq || !host.isConnected) return;
  }
  const ae = document.activeElement, key = opts.focus || (host.contains(ae) && ae.dataset.key) || null;
  const d = stData(), rk = `${view.tab}|${+r.from}|${+r.toEx}`, changed = rk !== SV.lastRange; SV.lastRange = rk;
  host.innerHTML = view.tab === 'month' ? monthHtml(d) : connectHtml(d);
  host.dataset.tab = view.tab;
  if (view.tab === 'month' && changed && !RM.matches) { const v = $('.rc-view', host); if (v) { v.classList.add('rc-anim'); const done = () => v.classList.remove('rc-anim'); v.addEventListener('animationend', done, { once: true }); setTimeout(done, 700); } }
  for (const seg of $$('#st-span, #st-viz', host)) placeInd(seg);
  if (view.tab === 'connected') {
    if (SV.ro) { SV.ro.disconnect(); SV.ro = null; }
    if (view.viz === 'threads') {
      const w = $('#tr-wrap', host);
      if (w) { drawArcs(); if ('ResizeObserver' in window) { SV.ro = new ResizeObserver(() => requestAnimationFrame(drawArcs)); SV.ro.observe(w); } }
    } else afterBoard(host);
    if (changed) live(`${d.r.label}: ${shownList(d).length ? plural(shownList(d).length, 'note') : 'nothing written'}.`);
  } else if (changed) live(`${d.r.label}: ${d.list.length ? plural(d.list.length, 'note, highlight or comment', 'notes, highlights and comments') : 'nothing written'}.`);
  if (SV.card) { if (d.byId.has(SV.card)) renderCard(d); else closeCard({ restore: false }); }
  else if (view.note && d.byId.has(view.note)) openCard(view.note);
  paintOpen();
  if (SV.focusReq) {   // arrived from This month with something to show: say what is lit and focus the filter handed over
    SV.focusReq = false;
    const t = view.thread && SV.ths && SV.ths.find(x => x.id === view.thread);
    if (t) live(`Highlighting the ${t.name} thread`); else if (view.theme) live(`Showing ${themeName(d)}`); else if (view.book) live(`Showing ${bookName(view.book)}`); else if (view.kind) live(`Showing ${KINDP[view.kind]}`);
    const pill = t ? '[data-st-x="thread"]' : view.theme ? '[data-st-f="theme"]' : view.book ? '[data-st-f="book"]' : view.kind ? '[data-st-f="kind"]' : '';
    if (pill && !SV.card) { $(pill, host)?.focus({ preventScroll: true }); return; }
  }
  if (key) {
    const el = $(`[data-key="${cssEsc(key)}"]`, host);
    if (el) { el.focus({ preventScroll: !opts.focus }); if (opts.focus === 'rename' && el.select) el.select(); if (opts.scroll) el.scrollIntoView({ block: 'center', behavior: RM.matches ? 'auto' : 'smooth' }); }
  }
}
/** The shared context as the Studies module receives it: range {from, to (the last day), label}, theme, thread, note, and the rest. */
function stCtx() {
  const r = stRange();
  return { range: { from: +r.from, to: +r.last, label: r.label, id: r.id, title: r.title }, mode: view.mode, theme: view.theme, book: view.book, kind: view.kind, thread: view.thread, note: view.note, viz: view.viz };
}
/**
 * The Studies tab is studydoc.js's: it draws the Studies home, builder and reading view into #lib-study, under the
 * Study chrome, by its contract renderStudies(host, {ctx, start, onNavigate, toast, navigate}). A library reload
 * while it is shown leaves it alone (SV.docOwned); a tab switch draws it afresh.
 */
async function paintStudies(body) {
  const ctx = stCtx(), start = SV.start; SV.start = null;
  const host = $('#lib-study', body); if (!host) return;
  try {
    const m = await import('./studydoc.js');
    if (!libOpen() || view.name !== 'study' || view.tab !== 'studies' || !host.isConnected) return;
    if (typeof m.renderStudies !== 'function') throw new Error('studydoc.js has no renderStudies');
    SV.docOwned = true;
    await m.renderStudies(host, { ctx, start, onNavigate: stNavigate, toast: (msg, action) => toast(msg, action), navigate: (b, c, v) => goVerse(`${b}.${c}.${v || 0}`) });
  } catch (e) {
    console.error('studydoc.js failed to load', e);
    if (host.isConnected) host.innerHTML = empty('note', 'Studies are on their way', 'Gather this month, a theme or a thread into a study document here soon.');
  }
}
/** studydoc.js changes tabs through this: a tab name, or {tab, …context} for another Study tab, {name: 'home'} for the Library home. */
function stNavigate(v = {}) {
  if (!libOpen()) return;
  if (typeof v === 'string') v = { tab: v };
  if (!v || typeof v !== 'object') return;
  SV.docOwned = false;
  if (v.name && v.name !== 'study') { view = v.name === 'book' && bookOf(+v.b) ? { name: 'book', b: +v.b } : { name: 'home' }; renderLibrary({ pop: true }); return; }
  const { name, ...rest } = v; Object.assign(view, rest);
  if (!ST_TABS.some(t => t[0] === view.tab)) view.tab = 'month';
  closeCard({ restore: false });
  renderLibrary({ still: true, tab: true });
  const tab = $(`#library-body [data-st-tab="${cssEsc(view.tab)}"]`); if (tab) focusIn(tab);
}

// ------------------------------------------------------------ events
/** Clicks inside #lib-study and the note card. Returns true when handled. */
function onStudyClick(e, t) {
  if (t.closest('#lib-ncard-scrim')) { closeCard(); return true; }
  if (t.closest('[data-st-card-close]')) { closeCard(); return true; }
  if (t.closest('[data-st-card-back]')) { const prev = SV.hist.pop(); if (prev) { SV.card = prev; view.note = prev; renderCard(); paintOpen(); document.getElementById('lib-ncard-title')?.focus(); } return true; }
  const tab = t.closest('[data-st-tab]'); if (tab) { setStTab(tab.dataset.stTab, { focus: tab.closest('#st-tabs') !== null }); return true; }
  const step = t.closest('[data-st-step]'); if (step) { stStep(+step.dataset.stStep); return true; }
  const mode = t.closest('[data-st-mode]'); if (mode) { setStMode(mode.dataset.stMode); return true; }
  const viz = t.closest('[data-st-viz]'); if (viz) { setViz(viz.dataset.stViz); return true; }
  const go = t.closest('[data-st-go]'); if (go) { goConnect(Object.fromEntries(new URLSearchParams(go.dataset.stGo))); return true; }
  const mo = t.closest('[data-st-month]'); if (mo) { goMonth(Object.fromEntries(new URLSearchParams(mo.dataset.stMonth))); return true; }
  const note = t.closest('[data-st-note]'); if (note) { if (SV.drag && SV.drag.swallow) return true; openCard(note.dataset.stNote, { from: note, push: !!note.closest('#lib-ncard') }); return true; }
  const vs = t.closest('[data-st-verse]'); if (vs) { goVerse(vs.dataset.stVerse); return true; }
  const vl = t.closest('.vlink'); if (vl) { e.preventDefault(); e.stopPropagation(); goMdLink(vl); return true; }
  const ed = t.closest('[data-st-edit]'); if (ed) { const n = stData().byId.get(ed.dataset.stEdit); if (n) editNote(n); return true; }
  const x = t.closest('[data-st-x]');
  if (x) { const k = x.dataset.stX; if (k === 'thread') { view.thread = ''; paintStudy({ focus: 'f-range' }); live('The thread is no longer highlighted'); } else setFilter(k, k === 'range' ? 'month' : ''); return true; }
  const un = t.closest('[data-st-unset]'); if (un) { const k = un.dataset.stUnset; setFilter(k, k === 'range' ? 'month' : ''); return true; }
  if (t.closest('[data-st-clear]')) { view.theme = view.book = view.kind = view.thread = ''; if (view.mode !== 'month') setStMode('month', 'f-range'); else paintStudy({ focus: 'f-range' }); return true; }
  const th = t.closest('[data-st-thread]');
  if (th) { view.thread = view.thread === th.dataset.stThread ? '' : th.dataset.stThread; paintStudy({ focus: `th-${th.dataset.stThread}` }); const tt = SV.ths.find(z => z.id === view.thread); live(tt ? `Highlighting the ${tt.name} thread` : 'Showing every thread'); return true; }
  const jump = t.closest('[data-st-jump]');
  if (jump) {
    const board = document.getElementById('tb-board'), col = $(`#lib-study .tb-col[data-key="${cssEsc(jump.dataset.stJump)}"]`); if (!board || !col) return true;
    board.scrollTo({ left: col.offsetLeft - (parseFloat(getComputedStyle(board).paddingLeft) || 0), behavior: RM.matches ? 'auto' : 'smooth' }); col.focus({ preventScroll: true });
    return true;
  }
  const sc = t.closest('[data-st-scroll]');
  if (sc) { const b = document.getElementById('tb-board'), col = b && $('.tb-col:not([hidden])', b); if (b) b.scrollBy({ left: +sc.dataset.stScroll * ((col ? col.offsetWidth : 238) + 12), behavior: RM.matches ? 'auto' : 'smooth' }); return true; }
  const mv = t.closest('[data-st-move]'); if (mv) { moveMenu(stData(), mv); return true; }
  const cm = t.closest('[data-st-colmenu]'); if (cm) { colMenu(stData(), cm); return true; }
  const a = t.closest('[data-st-act]'); if (!a) return false;
  const act = a.dataset.stAct, name = a.dataset.theme, d = stData();
  if (act === 'theme') {
    const open = SV.openTheme !== name; SV.openTheme = open ? name : null;
    for (const b of $$('#lib-study .rc-theme-btn')) { const on = b === a && open; b.setAttribute('aria-expanded', String(on)); const more = document.getElementById(b.getAttribute('aria-controls')); if (more) more.hidden = !on; }
  }
  else if (act === 'keep' || act === 'remove') choose(d, act, name);
  else if (act === 'rename') { SV.renaming = name; paintStudy({ focus: 'rename' }); }
  else if (act === 'cancel-rename') { SV.renaming = null; paintStudy({ focus: `theme-${name}` }); }
  else if (act === 'all-themes') { SV.allThemes = !SV.allThemes; paintStudy({ focus: 'all-themes' }); }
  else if (act === 'all-life') { SV.allLife = !SV.allLife; paintStudy({ focus: 'all-life' }); }
  else if (act === 'tag') { SV.openTag = SV.openTag === a.dataset.tag ? null : a.dataset.tag; paintStudy({ focus: `tag-${a.dataset.tag}` }); }
  else if (act === 'add-tag') addTag(d, a.dataset.id, a.dataset.tag);
  else if (act === 'feature') { SV.featured = a.dataset.thread; paintStudy({ focus: 'thread-h', scroll: true }); }
  else if (act === 'latest') { const t0 = dayOf(Date.now()); if (view.mode === 'month') { view.y = t0.getFullYear(); view.m = t0.getMonth(); } else view.end = +t0; resetOpen(); paintStudy({ focus: 'prev' }); }
  else if (act === 'study') makeStudy(d, { ids: d.list.map(x => x.id), title: d.r.title });
  else if (act === 'study-theme') { const th2 = d.themes && d.themes.overall.find(x => x.name === name); if (th2) makeStudy(d, { ids: th2.noteIds, title: th2.label, theme: th2.name }); }
  else if (act === 'study-thread') {
    const th2 = d.threads.find(x => x.id === a.dataset.thread); if (!th2) return true;
    const f = d.byId.get(th2.chain[0]), l = d.byId.get(th2.chain[th2.chain.length - 1]);
    makeStudy(d, { ids: th2.noteIds, title: f && l && f !== l && f.phrase && l.phrase ? `From “${f.phrase}” to “${l.phrase}”` : th2.label, thread: th2.id });
  }
  return true;
}
function onStudyChange(e) {
  const t = e.target; if (!(t instanceof HTMLSelectElement)) return;
  const f = t.dataset.stF; if (f) { setFilter(f, t.value); return; }
  const mg = t.dataset.stMerge; if (mg && t.value) { choose(stData(), 'merge', mg, t.value); return; }
  if (t.id === 'tb-pick') { SV.boardCol = t.value; for (const c of $$('#lib-study .tb-col')) c.hidden = c.dataset.key !== SV.boardCol; live(`Showing ${colLabel(stData(), SV.boardCol)}`); }
}
function onStudySubmit(e) {
  const f = e.target.closest('.rc-rename'); if (!f) return;
  e.preventDefault(); choose(stData(), 'rename', f.dataset.theme, f.querySelector('input').value.replace(/\s+/g, ' ').trim());
}
/** Esc closes the innermost thing: a rename, the note card; arrows move along the tabs and the segmented controls. */
function onStudyKeydown(e) {
  if (view.name !== 'study') return;
  const t = e.target;
  if (e.key === 'Escape') {
    if (SV.drag) { e.preventDefault(); e.stopImmediatePropagation(); stDragEnd(null); return; }
    if (t.closest && t.closest('.rc-rename')) { e.preventDefault(); e.stopImmediatePropagation(); const was = SV.renaming; SV.renaming = null; paintStudy({ focus: `theme-${was}` }); return; }
    const info = t.closest && t.closest('details.ls-info[open]'); if (info) { e.preventDefault(); e.stopImmediatePropagation(); info.open = false; info.querySelector('summary')?.focus(); return; }
    if (SV.card && !(fn('menuOpen') && ui.menuOpen())) { e.preventDefault(); e.stopImmediatePropagation(); closeCard(); }
    return;
  }
  const tabs = t.closest && t.closest('#st-tabs');
  if (tabs && t.matches('[role=tab]')) {
    const bs = $$('[role=tab]', tabs), i = bs.indexOf(t), j = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: bs.length - 1 }[e.key];
    if (j === undefined) return;
    e.preventDefault(); setStTab(bs[(j + bs.length) % bs.length].dataset.stTab, { focus: true });
    return;
  }
  const g = t.closest && t.closest('#st-span, #st-viz');
  if (g && t.matches('[role=radio]')) radioKeys(e, g, btn => (btn.dataset.stMode ? setStMode(btn.dataset.stMode) : setViz(btn.dataset.stViz)));
}
// drag a card to another column (pointer events: a mouse anywhere on the card, touch on its grip)
function stDragStart(e) {
  const cardEl = e.target.closest('#lib-study .tb-card'); if (!cardEl || e.button !== 0 || SV.drag) return;
  if (e.target.closest('[data-st-move]')) return;
  if (e.pointerType !== 'mouse' && !e.target.closest('.tb-grip')) return;
  SV.drag = { x: e.clientX, y: e.clientY, id: cardEl.dataset.id, from: cardEl.dataset.col, el: cardEl, pid: e.pointerId, on: false, over: null, ghost: null, swallow: false };
  if (e.pointerType !== 'mouse') e.preventDefault();
  addEventListener('pointermove', stDragMove, { passive: false }); addEventListener('pointerup', stDragEnd); addEventListener('pointercancel', stDragEnd);
}
function stDragMove(e) {
  const s = SV.drag; if (!s || e.pointerId !== s.pid) return;
  if (!s.on) {
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < 6) return;
    s.on = true;
    const r = s.el.getBoundingClientRect();
    s.dx = s.x - r.left; s.dy = s.y - r.top;
    s.ghost = s.el.cloneNode(true); s.ghost.classList.add('tb-ghost'); s.ghost.style.width = r.width + 'px'; s.ghost.removeAttribute('data-id');
    (libDialog() || document.body).append(s.ghost); s.el.classList.add('lifted'); document.body.classList.add('tb-dragging');
  }
  e.preventDefault();
  s.ghost.style.transform = `translate(${e.clientX - s.dx}px, ${e.clientY - s.dy}px) rotate(-1.5deg)`;
  const under = document.elementFromPoint(e.clientX, e.clientY), col = under && under.closest('#lib-study .tb-col');
  for (const c of $$('#lib-study .tb-col')) c.classList.toggle('drop', c === col && c.dataset.key !== s.from);
  s.over = col ? col.dataset.key : null;
  const board = document.getElementById('tb-board'); if (board) { const br = board.getBoundingClientRect(); if (e.clientX > br.right - 40) board.scrollLeft += 12; else if (e.clientX < br.left + 40) board.scrollLeft -= 12; }
}
function stDragEnd(e) {
  const s = SV.drag; if (!s || (e && e.pointerId !== s.pid)) return;
  removeEventListener('pointermove', stDragMove); removeEventListener('pointerup', stDragEnd); removeEventListener('pointercancel', stDragEnd);
  if (!s.on) { SV.drag = null; return; }
  s.ghost?.remove(); document.body.classList.remove('tb-dragging'); s.el.classList.remove('lifted');
  for (const c of $$('#lib-study .tb-col')) c.classList.remove('drop');
  s.swallow = true; setTimeout(() => { if (SV.drag === s) SV.drag = null; }, 0);   // the click that ends the drag opens nothing
  if (e && e.type === 'pointerup' && s.over && s.over !== s.from) moveNote(stData(), s.id, s.from, s.over);
}

function onLibClick(e) {
  const t = e.target; if (!(t instanceof Element)) return;
  if (t.closest('#lib-more')) { moreMenu(t.closest('#lib-more')); return; }
  const bmMenu = t.closest('[data-bm-menu]');
  if (bmMenu) { const li = bmMenu.closest('li[data-bm]'); const bm = li && lib.bookmarks.find(x => x.id === li.dataset.bm); if (bm) openBookmarkMenu(bmMenu, bm); return; }
  // Memorize: a memory verse's ⋯ and Practise (Library › Memory), Open Memory (the home's card)
  const mzMenu = t.closest('[data-mz-menu]'); if (mzMenu) { openMzMenu(mzMenu); return; }
  const pr = t.closest('#library-body [data-practise]');
  if (pr) { if (mem) mem.practise(pr.dataset.practise, { returnFocus: mzFocusBack(pr.dataset.practise, false) }); return; }
  if (t.closest('[data-lib-memory]')) {
    homeScroll = document.getElementById('library-body')?.scrollTop || 0;
    view = { name: 'memory' }; renderLibrary({ push: true });
    return;
  }
  const go = t.closest('[data-lib-go]'); if (go) { goRef(go.dataset.libGo); return; }
  // Study (This month, Connected and the note card)
  if (t.closest('#lib-study, #lib-ncard, #lib-ncard-scrim, #st-tabs') && onStudyClick(e, t)) return;
  if (t.closest('[data-lib-study]')) {
    homeScroll = document.getElementById('library-body')?.scrollTop || 0;
    view = stDefaults(); renderLibrary({ push: true });
    return;
  }
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
    const el = from.name === 'map' ? ($('#library-body [data-lib-links]') || $('#library-body #lib-links h3')) : from.name === 'study' ? $('#library-body [data-lib-study]')
      : from.name === 'memory' ? ($('#library-body [data-lib-memory]') || $('#library-body #lib-mem-h')) : $(`#library-body [data-lib-book="${from.b}"]`);
    focusIn(el);
    // My map opened from a link's tag chip: the home was never scrolled to its button
    if (el && body && (from.name === 'map' || from.name === 'study' || from.name === 'memory')) { const r = el.getBoundingClientRect(), br = body.getBoundingClientRect(); if (r.top < br.top || r.bottom > br.bottom) el.scrollIntoView({ block: 'center' }); }
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
  if (au) { const mode2 = au.dataset.libAuth; import('./account.js').then(m => { if (typeof m.openAuth === 'function') m.openAuth(mode2); }).catch(() => toast(offlineMsg())); }
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
    // Study: Esc closes the note card before the dialog (capture, so the dialog's own cancel never sees it), arrows move along its controls
    d.addEventListener('keydown', onStudyKeydown, true);
    d.addEventListener('change', e => { if (e.target.closest && e.target.closest('#lib-study')) onStudyChange(e); });
    d.addEventListener('submit', e => { if (e.target.closest && e.target.closest('#lib-study')) onStudySubmit(e); });
    d.addEventListener('pointerdown', stDragStart);
    d.addEventListener('scroll', e => { if (e.target && e.target.id === 'tb-board') tbEdges(); }, true);
    d.addEventListener('click', e => { for (const x of $$('#lib-study details.ls-info[open]')) if (!x.contains(e.target)) x.open = false; });
    d.addEventListener('input', e => {
      if (e.target.id !== 'lm-q') return;
      clearTimeout(mapQT);
      mapQT = setTimeout(() => { mapF.q = e.target.value; mapAllRows = false; NET.auto = true; paintMap(); }, 150);
    });
    d.addEventListener('close', () => { previewSeq++; stopNet(); netHover(null); closeCard({ restore: false }); stDragEnd(null); if (SV.ro) { SV.ro.disconnect(); SV.ro = null; } SV.docOwned = false; });
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
  // Memorize: the home's Memory card and Library › Memory follow memory.js (a practice judged, another window's change)
  document.addEventListener('bs:memory-changed', e => {
    if (!libOpen() || (view.name !== 'home' && view.name !== 'memory')) return;
    const d = e.detail || {};
    if (view.name === 'memory' && mzRemoved && d.reason === 'add' && (d.ids || []).includes(mzRemoved)) { mzRefocus = mzRemoved; mzRemoved = null; } // its Undo
    scheduleRender();
  });
  // Study follows the notes document: theme choices and studies (store.js), note text, and marks above. A local choice
  // has already painted (choose, moveNote); the builder's own saves are studydoc.js's while the Studies tab is shown.
  for (const ev of ['bs:studies-changed', 'bs:notes-replaced', 'bs:note-saved']) document.addEventListener(ev, e => { if (ev === 'bs:studies-changed' && e.detail && e.detail.reason === 'local') return; if (libOpen() && view.name === 'study') scheduleRender(); });
  try { matchMedia('(max-width: 699px)').addEventListener('change', () => { if (libOpen() && view.name === 'study' && view.tab === 'connected') paintStudy(); }); } catch (e) { /* old Safari */ }
  addEventListener('resize', () => { if (libOpen() && view.name === 'study') tbEdges(); });
  // the map's canvas reads colour tokens: a theme switch repaints it
  const repaint = () => { NET.col = null; if (NET.cv) netFrameSoon(); };
  try { new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); } catch (e) { /* no observer */ }
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaint); } catch (e) { /* old Safari */ }
  // the day rolled over while the page was open: the day-based figures need the server's view
  setInterval(() => { if (lib.loaded && base && base.today !== localDay()) refreshSoon(); }, 60000);
}
