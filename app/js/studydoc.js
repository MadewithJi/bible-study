// Library → Study → Studies (study-build-brief §2.3): the Studies home (your studies, the ways to start one), the
// builder (title, introduction, passages in order, what each passage shows) and the reading view (a printed study
// guide: Print, Export as Markdown). Ported from app/mock/library-study-doc.html with real data: the entries come
// from study.js entries(), the verses from the bundled translations, the cross-references from app/data/xref, and a
// study is saved through store.js saveStudy / removeStudy (Undo puts it back). Nothing here touches the chapter hero.
//
// Contract (the Library's Study view calls this):
//   renderStudies(host, {ctx, start, onNavigate, toast, navigate}) – draw into host (the Library body, or a box in it).
//     ctx: {range: {from, to, label}, theme, thread, note} shared by This month and Connected: offered on the home
//     screen as a way to start. start: {kind: 'month' | 'theme' | 'thread' | 'picks', theme?, thread?, keys?, title?}
//     is a hand-off: it opens the builder at once (acted on once per start; add at: Date.now() to hand the same one
//     over again). onNavigate(view) asks the
//     Library to switch tab. toast(msg, action) and navigate(b, c, v) are the app's (main.js A); init(actions) sets
//     them for good, and without either a small fallback is used.
//   openStudy(id, {mode}) – show a study (the reading view by default), asking the Library for the Studies tab first.
// A study (store.js): {id, title, intro, order: 'studied' | 'bible' | 'custom', entries: [{key}], created, updated};
// a key is an entry id (a note key 'b.c.v' / 'b.c' or a mark id). The "In each passage" switches and where a study was
// started from are not part of the saved document: they are kept for the session (the switches also in localStorage).
import { state, data, esc, refLabel, bookOf, previewText, plural, DRY, RM, lsGet, lsSet, readOnlyGuest, trInfo } from './store.js';
import * as S from './store.js';
import * as ST from './study.js';
import * as ui from './ui.js';
import { icon } from './icons.js';

let drawer = null;   // renderMd (the notes' markdown), loaded beside the rest
import('./drawer.js').then(m => { drawer = m; }, e => { console.error('drawer.js failed to load', e); });
let mrk = null;      // goMarkRef: a chip to a highlight opens its popover
import('./marks.js').then(m => { mrk = m; }, e => { console.error('marks.js failed to load', e); });

const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const DRY_MSG = 'Dry run: nothing is saved.';
const KIND = ST.KIND;
const GRIP = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h14"/></svg>';
const PRINTER = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8.5V4h10v4.5"/><path d="M7 17H5.5A2.5 2.5 0 013 14.5v-3A2.5 2.5 0 015.5 9h13a2.5 2.5 0 012.5 2.5v3a2.5 2.5 0 01-2.5 2.5H17"/><path d="M7 14h10v6H7z"/></svg>';

// ------------------------------------------------------------ words and dates
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const andList = xs => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
const dayOf = t => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const addDays = (t, n) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };
const thisYear = () => new Date().getFullYear();
const dayMonth = t => { const d = new Date(t); return `${d.getDate()} ${MON[d.getMonth()]}`; };
const longDay = t => { const y = new Date(t).getFullYear(); return `${dayMonth(t)}${y !== thisYear() ? ` ${y}` : ''}`; };
const isoDay = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const parseDay = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null; };
/** {from, to}: the first and the last day (inclusive, at midnight) of the month t is in. */
const monthRange = t => { const d = new Date(t); return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime() }; };
const isMonth = (from, to) => { const a = new Date(from), b = new Date(to); return a.getDate() === 1 && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear() && addDays(to, 1) === new Date(b.getFullYear(), b.getMonth() + 1, 1).getTime(); };
const monthName = t => { const d = new Date(t); return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
/** '2–22 Oct', '25 Sep – 9 Oct', '22 Oct', '3 Nov 2025 – 31 Jan 2026' (b is a day, inclusive). */
function spanLabel(a, b) {
  const A = new Date(a), B = new Date(b);
  if (dayOf(a) === dayOf(b)) return longDay(a);
  if (A.getFullYear() !== B.getFullYear()) return `${dayMonth(a)} ${A.getFullYear()} – ${longDay(b)}`;
  if (A.getMonth() !== B.getMonth()) return `${dayMonth(a)} – ${longDay(b)}`;
  return `${A.getDate()}–${B.getDate()} ${MON[A.getMonth()]}${A.getFullYear() !== thisYear() ? ` ${A.getFullYear()}` : ''}`;
}
const monthSpan = (a, b) => monthName(a) === monthName(b) ? monthName(a) : new Date(a).getFullYear() === new Date(b).getFullYear() ? `${MONTHS[new Date(a).getMonth()]} – ${monthName(b)}` : `${monthName(a)} – ${monthName(b)}`;
/** 'today', 'yesterday', '3 days ago', '2 weeks ago', else '28 Sep' (+ the year when it is another). */
function relDay(t) {
  const n = Math.round((dayOf(Date.now()) - dayOf(t)) / 864e5);
  return n <= 0 ? 'today' : n === 1 ? 'yesterday' : n < 7 ? `${n} days ago` : n < 21 ? plural(Math.round(n / 7), 'week') + ' ago' : longDay(t);
}
/** '12 notes, 18 highlights and 4 comments' */
function kindsPhrase(list) {
  const k = { note: 0, highlight: 0, comment: 0 }; for (const n of list) k[n.kind]++;
  return andList([k.note && plural(k.note, 'note'), k.highlight && plural(k.highlight, 'highlight'), k.comment && plural(k.comment, 'comment')].filter(Boolean)) || 'Nothing';
}
const bookNames = list => andList(ST.booksFor(list).map(b => b.name));
const clip = (s, max = 240) => s.length > max ? s.slice(0, max).replace(/[\s,;:]+\S*$/, '') + ' …' : s;

// ------------------------------------------------------------ module state
let A = null;                                       // the app's actions (init): toast, navigate, yieldToPage
const cur = { host: null, ctx: {}, onNavigate: null, toast: null, navigate: null, start: null, startKey: '' };
let doc = null, mode = 'home', pending = null;      // the study in hand (a working copy), the view, an openStudy() waiting for the tab
const INC = { verse: true, note: true, refs: true, xrefs: true };
const incOf = new Map(), srcOf = new Map(), fresh = new Set();   // per study id: the switches, where it started, made this session
const INC_KEY = 'bs-study-inc';
let byId = new Map();                               // entry id -> entry (study.js entries()), rebuilt on each draw
let st = null, stSig = '', stP = null;              // study.js loadStudy() for the theme flows and the paper's themes
let xrefs = {};                                     // {b: xref json} for the books in hand
let readSeq = 0, redrawT = 0, drag = null;

// ------------------------------------------------------------ entries, verses, cross-references, references
function refreshEntries() { byId = new Map(ST.entries().map(e => [e.id, e])); }
const all = () => [...byId.values()];
const ents = d => d.entries.map(id => byId.get(id)).filter(Boolean);
const canon = e => e.b * 1e6 + e.c * 1e3 + e.v;
/** ids in the given order ('custom' as they are); ids no entry answers to stay, last. */
function sorted(ids, order) {
  ids = [...new Set(ids)];
  const ns = ids.map(id => byId.get(id)).filter(Boolean), lost = ids.filter(id => !byId.has(id));
  if (order === 'studied') ns.sort((a, z) => a.created - z.created);
  else if (order === 'bible') ns.sort((a, z) => canon(a) - canon(z) || a.created - z.created);
  return [...ns.map(n => n.id), ...lost];
}
const setEntries = (d, ids) => { d.entries = d.order === 'custom' ? [...new Set(ids)] : sorted(ids, d.order); };

const BUNDLED = ['kjv', 'bsb'];
const verseText = new Map();   // 'tr:b.c.v-ve' -> text (or its promise while loading)
/** The translation an entry's verse is shown in: a mark's own when bundled, else the reader's preview translation. */
const trOf = e => (e.mark && BUNDLED.includes(e.mark.tr) ? e.mark.tr : S.previewTr());
/** The last verse a mark covers in its chapter (its words may run over a verse break). */
function spanOf(e) {
  if (e.mark && typeof e.mark.end === 'string') { const p = e.mark.end.split('.').map(Number); if (p[0] === e.b && p[1] === e.c && p[2] > e.v) return Math.min(p[2], e.v + 5); }
  return e.v;
}
const vKey = e => `${trOf(e)}:${e.b}.${e.c}.${e.v}-${spanOf(e)}`;
async function loadVerse(e) {
  if (!e.v) return '';
  const k = vKey(e), had = verseText.get(k);
  if (typeof had === 'string') return had;
  if (had) return had;
  const p = (async () => {
    try { const ch = await data.passage(trOf(e), e.b, e.c), out = []; for (let v = e.v; v <= spanOf(e); v++) out.push(ch[v - 1] || ''); return out.filter(Boolean).join(' '); }
    catch (err) { return ''; }
  })();
  verseText.set(k, p);
  const t = await p; verseText.set(k, t); return t;
}
const verseOf = e => { const t = verseText.get(vKey(e)); return typeof t === 'string' ? t : ''; };
const verseHtml = e => ST.markHtml(e, verseOf(e));
const marked = e => e.kind !== 'note';

async function loadXrefs(list) {
  const need = list.filter(e => !(e.b in xrefs));
  if (need.length) Object.assign(xrefs, await ST.loadXrefsFor(need));
}
const xrefsOf = e => ST.topXrefs(e, xrefs, 2);
const xKey = x => `${x.b}.${x.c}.${x.v}.${x.ve || 0}`;
const xText = new Map(), xDone = new Map();   // cross-reference and verse-link text, loaded on demand
function loadX(x) {
  const k = xKey(x);
  if (!xText.has(k)) xText.set(k, previewText(x.b, x.c, x.v, x.ve || 0).then(r => { xDone.set(k, clip(r.text)); return xDone.get(k); }, () => ''));
  return xText.get(k);
}
/** The references a note makes, in the order written: [{kind: 'note', note} | {kind: 'verse', b, c, v, ve, label}]. */
function linksIn(text) {
  const out = [], seen = new Set();
  for (const r of ST.parseRefs(text)) {
    const res = ST.resolveRef(r), id = ST.refId(res); if (seen.has(id)) continue; seen.add(id);
    const n = byId.get(id);
    if (n) out.push({ kind: 'note', note: n });
    else out.push({ kind: 'verse', b: res.b, c: res.c, v: res.v, ve: res.ve || 0, label: refLabel(res.b, res.c, res.v, res.ve || 0) });
  }
  return out;
}
/** The entry id a rendered verse link (a.vlink, with or without data-mark) points at, and the verse itself. */
function linkTarget(a) {
  if (a.dataset.mark) { const m = byId.get(a.dataset.mark); return { id: a.dataset.mark, b: m && m.b, c: m && m.c, v: m && m.v }; }
  const r = ST.parseRefText(a.dataset.ref || ''); if (!r) return null;
  const res = ST.resolveRef(r); return { id: ST.refId(res), b: res.b, c: res.c, v: res.v };
}
/** Everything a study's passages show, loaded: verses, cross-references and their text. */
async function prepare(d) {
  const list = ents(d);
  await Promise.all([Promise.all(list.map(loadVerse)), loadXrefs(list)]);
  await Promise.all(list.flatMap(n => [...xrefsOf(n), ...linksIn(n.text).filter(l => l.kind === 'verse')].map(loadX)));
}
/** study.js loadStudy() over every entry (themes, threads), cached until the notes or the theme choices change. */
function loadSt() {
  const list = all(), sig = `${list.length}:${Math.max(0, ...list.map(e => e.updated))}:${JSON.stringify(S.themeChoices())}`;
  if (st && stSig === sig) return Promise.resolve(st);
  if (stP && stSig === sig) return stP;
  stSig = sig;
  stP = ST.loadStudy({ list }).then(r => { st = r; Object.assign(xrefs, r.xrefs); return r; }, e => { console.error(e); st = { themes: { overall: [], yours: [], byNote: {} }, threads: [] }; return st; });
  return stP;
}
const T = () => (st ? st.themes : { overall: [], yours: [], byNote: {} });

// markdown: the drawer's renderer (verse links as a.vlink, mark chips as .ref-chip); plain paragraphs until it loads
function md(text) {
  if (drawer && typeof drawer.renderMd === 'function') { try { return drawer.renderMd(text); } catch (e) { /* fall through */ } }
  return String(text || '').split(/\n{2,}/).filter(s => s.trim()).map(s => `<p>${esc(s).replace(/\n/g, '<br>')}</p>`).join('');
}

// ------------------------------------------------------------ studies: working copies, saving
/** A working copy of a saved study: entries as ids. */
const docOf = s => ({ id: s.id, title: s.title || '', intro: s.intro || '', order: s.order || 'studied', entries: (s.entries || []).map(e => (typeof e === 'string' ? e : e.key)).filter(Boolean), created: +s.created || 0, updated: +s.updated || 0 });
const wire = d => ({ id: d.id, title: d.title, intro: d.intro, order: d.order, entries: d.entries.map(key => ({ key })), created: d.created, updated: d.updated });
const sameDoc = (a, b) => a.title === b.title && a.intro === b.intro && a.order === b.order && a.entries.join('\n') === b.entries.join('\n');
const savedStudies = () => (Array.isArray(S.studies()) ? S.studies() : []);
const incFor = id => incOf.get(id) || INC;
function setInc(id, k, on) {
  const inc = { ...incFor(id), [k]: on }; incOf.set(id, inc);
  try { const m = JSON.parse(lsGet(INC_KEY, '{}')) || {}; m[id] = inc; lsSet(INC_KEY, JSON.stringify(m)); } catch (e) { /* unreadable: this session only */ }
}
try { const m = JSON.parse(lsGet(INC_KEY, '{}')) || {}; for (const [id, inc] of Object.entries(m)) if (inc && typeof inc === 'object') incOf.set(id, { ...INC, ...inc }); } catch (e) { /* ignore */ }

let saveT = 0, saveD = null;
/** Queue the working copy for store.js (which debounces the flush itself); a hosted guest gets the sign-in prompt. */
function persist(d, now = false) {
  saveD = d; clearTimeout(saveT);
  const run = () => {
    saveT = 0; const w = saveD; saveD = null; if (!w) return;
    const s = S.saveStudy(wire(w));
    if (s) { w.id = s.id; w.updated = s.updated; }
    else if (!readOnlyGuest() && !savedStudies().some(x => x.id === w.id)) toast(`You already have ${S.MAX_STUDIES} studies. Delete one to make another.`);
  };
  if (now) run(); else saveT = setTimeout(run, 300);
}
const flushSave = () => { if (saveT) { clearTimeout(saveT); saveT = 0; const w = saveD; saveD = null; if (w) persist(w, true); } };
function touch(d, now = false) { d.updated = Date.now(); persist(d, now); }
function docMeta(d) {
  const list = ents(d); if (!list.length) return 'No passages yet';
  const t = list.map(n => n.created);
  return `${plural(list.length, 'passage')} · ${plural(ST.booksFor(list).length, 'book')} · ${spanLabel(Math.min(...t), Math.max(...t))}`;
}
function makeDoc({ title, entries, source }) {
  const now = Date.now();
  const d = { id: S.newStudyId(), title: title || '', intro: '', order: 'studied', entries: sorted(entries, 'studied'), created: now, updated: now };
  srcOf.set(d.id, source || null); fresh.add(d.id);
  persist(d, true);
  return d;
}
function replaceFrom(d, { title, entries, source }) {
  srcOf.set(d.id, source || null); setEntries(d, entries);
  if (!d.title.trim()) d.title = title || '';
  touch(d, true);
}

// ways to start: each returns {title, entries, source}
function rangeStart(from, to, via = '') {
  const list = ST.inRange(from, addDays(to, 1), all()), month = isMonth(from, to), label = month ? monthName(from) : spanLabel(from, to);
  return { title: label, entries: list.map(n => n.id), source: { kind: 'range', from, to, month, label, via, kinds: kindsPhrase(list) } };
}
function themeStart(k, id) {
  const th = T();
  if (k === 'tag') {
    const y = th.yours.find(x => x.tag === id || x.name === id || x.name === '#' + id); if (!y) return null;
    return { title: y.label, entries: y.noteIds, source: { kind: 'tag', tag: y.name, label: y.label, why: y.why } };
  }
  if (k === 'theme') {
    const o = th.overall.find(x => x.name === id || x.label === id); if (!o) return null;
    return { title: o.label, entries: o.noteIds, source: { kind: 'theme', name: o.name, label: o.label, why: o.why, suggested: o.suggested } };
  }
  const t = (st ? st.threads : []).find(x => x.id === id); if (!t) return null;
  const ch = (t.chain.length ? t.chain : t.noteIds).map(x => byId.get(x)).filter(Boolean);
  return { title: ch.length ? `From ${ch[0].label} to ${ch[ch.length - 1].label}` : 'A thread', entries: t.noteIds, source: { kind: 'thread', id: t.id, label: t.label, count: t.noteIds.length } };
}
const themeStartFor = name => (String(name).startsWith('#') ? themeStart('tag', String(name).slice(1)) : themeStart('theme', name));
function picksStart(ids, via = '') {
  const list = ids.map(id => byId.get(id)).filter(Boolean), books = ST.booksFor(list).slice(0, 3).map(b => b.name);
  return { title: list.length ? `Notes on ${andList(books)}` : '', entries: list.map(n => n.id), source: { kind: 'picks', count: list.length, via } };
}
function sourceInfo(s) {
  if (!s) return null;
  if (s.kind === 'range') return { ic: 'calendar', tile: 'gold', t: s.via === 'recap' ? `Started from your recap of ${s.label}` : `Started from ${s.label}`, s: s.kinds };
  if (s.kind === 'tag') return { ic: 'tag', tile: 'indigo', t: `Started from your tag ${s.tag}`, s: s.why };
  if (s.kind === 'theme') return { ic: 'sparkle', tile: 'indigo', t: `Started from a theme found in your notes: ${s.label}`, s: s.why, badge: s.suggested };
  if (s.kind === 'thread') return { ic: 'route', tile: 'indigo', t: 'Started from a thread you followed', s: s.label };
  if (s.via === 'recap') return { ic: 'calendar', tile: 'gold', t: 'Started from your recap', s: `${plural(s.count, 'note')} from This month` };
  return { ic: 'check', tile: 'green', t: s.via === 'connect' ? 'Started from the notes you ticked in Connected' : 'Started from notes you picked', s: `${plural(s.count, 'note')} chosen` };
}

// ------------------------------------------------------------ the context the Study views share (ctx)
/** ctx.range as {from, to (the last day, inclusive)}: `to` at a midnight is that day, anything else an end. */
function ctxRange() {
  const r = cur.ctx && cur.ctx.range; if (!r || !(+r.from > 0) || !(+r.to > 0)) return null;
  const from = dayOf(+r.from), to = +r.to === dayOf(+r.to) ? +r.to : dayOf(+r.to - 1);
  return from <= to ? { from, to, label: typeof r.label === 'string' ? r.label : '' } : null;
}
/** The context as a start for the home screen: {start, ic, tile, t, s}, or null when it is only the month. */
function ctxInfo() {
  const c = cur.ctx || {}, loading = !st;
  if (c.theme) {
    const tag = String(c.theme).startsWith('#'), start = st ? themeStartFor(c.theme) : null;
    const label = start ? start.title : tag ? ST.tagLabel(String(c.theme).slice(1)) : ST.themeLabel(c.theme);
    if (start || loading) return { start, ic: tag ? 'tag' : 'sparkle', tile: 'indigo', t: `${label} is in view in This month and Connected`, s: start ? plural(start.entries.length, 'note') : 'Gathering your notes…' };
  }
  if (c.thread) {
    const start = st ? themeStart('thread', c.thread) : null;
    if (start || loading) return { start, ic: 'route', tile: 'indigo', t: 'A thread is in view in This month and Connected', s: start ? `${start.source.label} · ${plural(start.entries.length, 'note')}` : 'Gathering your notes…' };
  }
  const r = ctxRange(), m = monthRange(Date.now());
  if (r && !(r.from === m.from && r.to === m.to)) {
    const start = rangeStart(r.from, r.to, 'context');
    if (start.entries.length) { const t = r.label || start.title; return { start, ic: 'calendar', tile: 'gold', t: `${t.charAt(0).toUpperCase()}${t.slice(1)} is in view in This month and Connected`, s: start.source.kinds }; }
  }
  return null;
}

// ------------------------------------------------------------ toast, live region, going to a verse
let fbT = 0;
/** The app's toast when it was given (init or renderStudies); else a plain one in #toast. */
function toast(msg, action) {
  const f = cur.toast || (A && A.toast);
  if (typeof f === 'function') { f(msg, action); return; }
  const t = $('#toast'); if (!t) return;
  clearTimeout(fbT); t.hidden = false; t.classList.remove('out');
  t.innerHTML = `<span class="toast-msg">${esc(msg)}</span>${action ? `<button type="button" class="dc-toast-act">${esc(action.label || 'Undo')}</button>` : ''}`;
  const b = t.querySelector('.dc-toast-act'); if (b) b.addEventListener('click', () => { clearTimeout(fbT); t.hidden = true; try { action.run(); } catch (e) { console.error(e); } });
  fbT = setTimeout(() => { t.hidden = true; }, action ? 10000 : 4200);
}
const say = m => { const l = cur.host && $('#dc-live', cur.host); if (!l) return; l.textContent = ''; requestAnimationFrame(() => { l.textContent = m; }); };
function closeLib() { const d = $('#library'); if (d && d.open) ui.closeDialog(d); }
/** Leave the Library for a verse (the reader), the app's way when it was given. */
function goVerse(b, c, v = 0) {
  if (!bookOf(+b)) return;
  closeLib();
  const f = cur.navigate || (A && A.navigate);
  if (typeof f === 'function') f(+b, +c, +v || 0); else location.hash = `#${b}/${c}${v ? '/' + v : ''}`;
  if (A && typeof A.yieldToPage === 'function') A.yieldToPage();
}
function goMark(id, refText) {
  closeLib();
  if (mrk && typeof mrk.goMarkRef === 'function') { try { if (mrk.goMarkRef(id, refText)) { if (A && typeof A.yieldToPage === 'function') A.yieldToPage(); return; } } catch (e) { console.error(e); } }
  const m = byId.get(id); if (m) goVerse(m.b, m.c, m.v);
}

// ------------------------------------------------------------ views
const root = () => (cur.host ? $('.dc-root', cur.host) : null);
const scroller = () => (cur.host && cur.host.closest('.lib-body')) || cur.host;
function go(m, { d = doc, focus = false } = {}) {
  if (mode === 'edit' && (m !== 'edit' || d !== doc)) flushSave();
  mode = m; doc = m === 'home' ? null : d;
  draw({ focus });
}
function draw({ focus = false, keepScroll = false } = {}) {
  const host = cur.host; if (!host || !host.isConnected) return;
  refreshEntries();
  const sc = scroller(), top = sc ? sc.scrollTop : 0;
  if (readOnlyGuest()) { host.innerHTML = `<div class="dc-root">${guestHtml()}</div>`; return; }
  if (mode !== 'home' && doc) {
    const s = savedStudies().find(x => x.id === doc.id);
    if (!s && !fresh.has(doc.id)) { mode = 'home'; doc = null; }
  }
  host.innerHTML = '<div class="dc-root"><div class="sr" id="dc-live" aria-live="polite"></div><div id="dc-view"></div></div>';
  if (mode === 'home') renderHome(); else if (mode === 'edit') renderEdit(); else renderRead();
  if (sc) sc.scrollTop = keepScroll ? top : 0;
  onScroll();
  if (focus) requestAnimationFrame(() => { const f = $('#dc-view [data-autofocus]', host); if (f) f.focus({ preventScroll: true }); });
}
const view = () => (cur.host ? $('#dc-view', cur.host) : null);

function guestHtml() {
  const au = state.auth || {}, signup = !(au.features && au.features.signup === false);
  return `<div class="notice lib-guest" role="note">${icon('person')}<p>Sign in to make studies<small>Sign in to save your notes, links and highlights. A study gathers them into a document of your own.</small></p>${signup ? '<button class="btn btn-tinted sm" type="button" data-lib-auth="signup">Create profile</button>' : ''}<button class="btn btn-plain sm" type="button" data-lib-auth="signin">Sign in</button></div>`;
}

function barHtml() {
  const r = (k, t) => `<button type="button" role="radio" data-mode="${k}" aria-checked="${mode === k}" tabindex="${mode === k ? 0 : -1}">${t}</button>`;
  return `<div class="dc-bar" id="dc-bar">
    <button class="back" type="button" data-act="home">${icon('chev-left')}Studies</button>
    <div class="segmented sm dc-seg dc-mode" role="radiogroup" aria-label="Show the study">
      <span class="seg-ind" aria-hidden="true"></span>${r('edit', 'Edit')}${r('read', 'Read')}
    </div>
    <div class="dc-acts">
      <button class="btn btn-gray sm" type="button" data-act="print">${PRINTER}Print</button>
      <button class="btn btn-gray sm" type="button" data-act="export" aria-haspopup="dialog">${icon('export')}Export</button>
      <button class="btn sm dc-later" type="button" data-act="link" aria-disabled="true" title="Sharing a study by link is a later feature">${icon('link')}Copy link<span class="ls-badge">Coming later</span></button>
    </div>
  </div>`;
}

// ---------- home: your studies and the ways to start
function thumb(s, list) {
  const w = [92, 80, 88, 66, 90, 74, 84, 60];
  let h = '', k = 0;
  for (const n of list.slice(0, 3)) h += `<i class="h"></i><i class="dc-c${marked(n) && n.color ? ' m' : ''}" data-color="${esc(n.color)}" style="width:${w[k++ % 8]}%"></i><i style="width:${w[k++ % 8]}%"></i>`;
  return `<b>${esc(s.title.trim() || 'Untitled study')}</b>${h}`;
}
function studyCard(s) {
  const list = ents(s), title = s.title.trim() || 'Untitled study';
  return `<li class="ls-card dc-study" data-study="${esc(s.id)}">
    <button class="dc-thumb" type="button" data-open="${esc(s.id)}" data-to="read" tabindex="-1" aria-hidden="true">${thumb(s, list)}</button>
    <div class="dc-study-body">
      <h4 class="dc-study-title"><a href="#" data-open="${esc(s.id)}" data-to="read">${esc(title)}</a>${fresh.has(s.id) ? '<span class="ls-badge lamp">New</span>' : ''}</h4>
      ${s.intro.trim() ? `<div class="dc-study-intro">${md(s.intro)}</div>` : ''}
      <p class="dc-study-meta">${list.length ? `${plural(list.length, 'passage')} from ${esc(bookNames(list))}` : 'No passages yet'} · Updated ${esc(relDay(s.updated))}</p>
      <div class="ls-row"><button class="btn btn-tinted sm" type="button" data-open="${esc(s.id)}" data-to="read">Read</button><button class="btn btn-gray sm" type="button" data-open="${esc(s.id)}" data-to="edit">Edit</button><button class="btn btn-plain sm dc-del" type="button" data-del="${esc(s.id)}" aria-label="Delete ${esc(title)}">Delete</button></div>
    </div>
  </li>`;
}
function renderHome() {
  const v = view(); if (!v) return;
  const list = savedStudies().map(docOf).sort((a, z) => z.updated - a.updated);
  const m = monthRange(Date.now()), month = ST.inRange(m.from, addDays(m.to, 1), all());
  const tile = (k, ic, c, t, s) => `<button class="dc-start" type="button" data-start="${k}"${k === 'month' ? '' : ' aria-haspopup="dialog"'}><span class="tile-i ${c}">${icon(ic)}</span><span class="dc-start-t">${t}</span><span class="dc-start-s">${s}</span></button>`;
  // what This month and Connected have in view (the shared context) is offered first, never opened unasked
  const cx = ctxInfo();
  if (cx && !st) loadSt().then(() => { if (mode === 'home' && view()) { const row = $('#dc-ctx', view()); if (row) row.outerHTML = ctxRow(); } });
  v.innerHTML = `<div class="dc-home dc-view">
    <section aria-labelledby="dc-home-h">
      <div class="lh"><h3 id="dc-home-h" tabindex="-1" data-autofocus>Your studies</h3><span>${list.length}</span></div>
      ${list.length ? `<ul class="dc-studies">${list.map(studyCard).join('')}</ul>` : `<div class="empty ls-card"><span class="tile-i gold">${icon('book')}</span><h4>No studies yet</h4><p>Gather your notes into a document of your own.</p></div>`}
    </section>
    <section aria-labelledby="dc-new-h">
      <div class="lh"><h3 id="dc-new-h">Start a new study</h3></div>
      ${ctxRow()}
      <div class="dc-starts">
        ${tile('month', 'calendar', 'gold', 'This month', `Everything from ${monthName(m.from)}: ${kindsPhrase(month)}`)}
        ${tile('theme', 'tag', 'indigo', 'From a theme', 'Your tags, the themes found in your notes, or a thread you followed')}
        ${tile('range', 'clock', 'blue', 'From dates', 'Any days you choose, such as the last 7 or 30')}
        ${tile('picks', 'check', 'green', 'Pick notes', `Choose from all ${byId.size} of your notes, highlights and comments`)}
      </div>
    </section>
  </div>`;
}
function ctxRow() {
  const cx = ctxInfo(); if (!cx) return '';
  return `<div class="dc-source dc-ctx" id="dc-ctx"><span class="tile-i ${cx.tile}">${icon(cx.ic)}</span><p>${esc(cx.t)}<small>${esc(cx.s)}</small></p><button class="btn btn-tinted sm" type="button" data-ctx-start${cx.start ? '' : ' disabled'}>Make a study from it</button></div>`;
}

// ---------- edit: the builder
const ORDERS = [['studied', 'As studied'], ['bible', 'Bible order'], ['custom', 'Your order']];
const INC_ROWS = [['verse', 'Verse text', 'With your words marked'], ['note', 'Your note', 'As you wrote it'], ['refs', 'References', 'The notes and verses it mentions'], ['xrefs', 'Cross-references', 'The top two, from OpenBible']];
function editHtml(d) {
  const si = sourceInfo(srcOf.get(d.id)), inc = incFor(d.id);
  return `${barHtml()}
  <div class="dc-edit dc-view">
    <div class="dc-head">
      ${si ? `<div class="dc-source"><span class="tile-i ${si.tile}">${icon(si.ic)}</span><p>${esc(si.t)}${si.badge ? '<span class="ls-badge lamp">Suggested</span>' : ''}<small>${esc(si.s || '')}</small></p><button class="btn btn-plain sm" type="button" data-act="change" aria-haspopup="dialog">Change</button></div>` : ''}
      <label class="sr" for="dc-title">Title</label>
      <input id="dc-title" class="dc-title-in" type="text" value="${esc(d.title)}" placeholder="Untitled study" maxlength="${S.STUDY_TITLE_MAX}" autocomplete="off" data-autofocus>
      <p class="dc-meta" id="dc-meta"></p>
      <div class="dc-intro">
        <label class="dc-lbl" for="dc-intro">Introduction <span>(optional)</span></label>
        <textarea id="dc-intro" class="dc-intro-in" rows="2" maxlength="${S.STUDY_INTRO_MAX}" placeholder="Why you studied this, and what you found" aria-describedby="dc-intro-hint">${esc(d.intro)}</textarea>
        <p class="dc-hint" id="dc-intro-hint">Markdown works here: <code>*italic*</code>, <code>**bold**</code> and verse links such as <code>[[John 1:4]]</code>.</p>
      </div>
    </div>
    <aside class="dc-side" aria-label="Study settings">
      <section class="ls-card dc-inc" aria-labelledby="dc-inc-h"><h3 class="dc-side-h" id="dc-inc-h">In each passage</h3>
        ${INC_ROWS.map(([k, t, s]) => `<label class="dc-sw"><span><b>${t}</b><small>${s}</small></span><input type="checkbox" class="switch" data-inc="${k}"${inc[k] ? ' checked' : ''}></label>`).join('')}
      </section>
      <nav class="ls-card dc-outline" aria-labelledby="dc-ol-h"><h3 class="dc-side-h" id="dc-ol-h">Outline</h3><ol class="dc-ol" id="dc-ol"></ol></nav>
      <p class="dc-side-note">A study keeps links to your notes, so a later edit to a note shows here too.</p>
      <button class="btn btn-plain sm dc-del dc-del-doc" type="button" data-del="${esc(d.id)}">Delete this study</button>
    </aside>
    <section class="dc-list" aria-labelledby="dc-list-h">
      <div class="dc-list-head">
        <h3 id="dc-list-h">Passages<span class="ls-count" id="dc-count"></span></h3>
        <div class="segmented sm dc-seg dc-order" role="radiogroup" aria-label="Order of the passages">
          <span class="seg-ind" aria-hidden="true"></span>
          ${ORDERS.map(([k, t]) => `<button type="button" role="radio" data-order="${k}" aria-checked="${d.order === k}" tabindex="${d.order === k ? 0 : -1}">${t}</button>`).join('')}
        </div>
        <button class="btn btn-tinted sm dc-add" type="button" data-act="add" aria-haspopup="dialog">${icon('plus')}Add notes</button>
      </div>
      <p class="sr" id="dc-drag-hint">To move a passage, drag its handle, or focus the handle and press the up or down arrow key.</p>
      <ol class="dc-entries" id="dc-entries" aria-labelledby="dc-list-h"></ol>
    </section>
  </div>`;
}
const dotHtml = e => (e.kind === 'note' ? `<i class="hdot${e.color ? ' ' + esc(e.color) : ''}" aria-hidden="true"></i>`
  : `<i class="hdot mkdot${e.color ? '' : ' none'}" data-mk-color="${esc(e.color)}" aria-hidden="true"></i>`);
function entryHtml(n, i, total, d, pos) {
  const inc = incFor(d.id), links = linksIn(n.text), xs = xrefsOf(n), byRef = new Map(ents(d).map(e => [e.ref, e]));
  const refChip = l => {
    if (l.kind === 'verse') return `<button class="ls-chip" type="button" data-verse="${l.b}.${l.c}.${l.v}" title="Open in the reader">${esc(l.label)}</button>`;
    const p = pos.get(l.note.id), lab = esc(ST.chipLabel(l.note));
    return p ? `<a class="ls-chip dc-ref" href="#b-${esc(l.note.id)}" data-jump="${esc(l.note.id)}" aria-label="${lab}, passage ${p}">${lab}<span class="dc-see" aria-hidden="true">${p}</span></a>`
      : `<button class="ls-chip dc-ref out" type="button" data-add="${esc(l.note.id)}" aria-label="Add ${esc(l.note.label)} to this study" title="Not in this study yet: add it">${lab}<span class="dc-plus" aria-hidden="true">${icon('plus')}</span></button>`;
  };
  const xrChip = x => {
    const other = byRef.get(x.ref), p = other && pos.get(other.id), t = xDone.get(xKey(x));
    return p ? `<a class="ls-chip dc-xr" href="#b-${esc(other.id)}" data-jump="${esc(other.id)}" aria-label="${esc(x.label)}, passage ${p}" title="${x.votes} OpenBible votes · also in this study">${esc(x.label)}<span class="dc-see" aria-hidden="true">${p}</span></a>`
      : `<button class="ls-chip dc-xr" type="button" data-verse="${x.b}.${x.c}.${x.v}" title="${esc(t ? `${t} (${x.votes} OpenBible votes)` : `${x.votes} OpenBible votes`)}">${esc(x.label)}</button>`;
  };
  const rows = [];
  if (inc.refs && links.length) rows.push(`<div class="dc-lk"><span class="dc-lk-h">References</span><span class="ls-chips">${links.map(refChip).join('')}</span></div>`);
  if (inc.xrefs && xs.length) rows.push(`<div class="dc-lk"><span class="dc-lk-h">Cross-references</span><span class="ls-chips">${xs.map(xrChip).join('')}</span></div>`);
  const vt = verseOf(n);
  return `<li class="dc-entry ls-note" id="b-${esc(n.id)}" data-id="${esc(n.id)}" data-color="${esc(n.color)}" data-kind="${n.kind}">
    <div class="dc-entry-head">
      <span class="dc-n" aria-hidden="true">${i + 1}</span>
      <h4 class="ls-note-ref">${esc(n.label)}</h4>
      <span class="dc-kind">${KIND[n.kind]} · ${esc(longDay(n.created))}</span>
      <span class="dc-tools">
        <button class="dc-tool" type="button" data-rm="${esc(n.id)}" aria-label="Remove ${esc(n.label)} from this study" title="Remove">${icon('xmark')}</button>
        <button class="dc-tool dc-grip" type="button" data-grip="${esc(n.id)}" aria-label="Move ${esc(n.label)}, passage ${i + 1} of ${total}" aria-describedby="dc-drag-hint" title="Drag to reorder">${GRIP}</button>
      </span>
    </div>
    ${inc.verse ? (vt ? `<p class="ls-verse">${verseHtml(n)}</p>` : n.v ? '' : '<p class="dc-none">A note on the whole chapter</p>') : ''}
    ${inc.note ? (n.text ? `<div class="ls-md">${md(n.text)}</div>` : `<p class="dc-none">${n.kind === 'highlight' ? 'Highlighted, with no note' : 'No note'}</p>`) : ''}
    ${rows.length ? `<div class="dc-links">${rows.join('')}</div>` : ''}
  </li>`;
}
function fillEntries(animate = false) {
  const ol = $('#dc-entries', view()); if (!ol || !doc) return;
  const before = animate && !RM.matches ? new Map($$('.dc-entry', ol).map(el => [el.dataset.id, el.getBoundingClientRect().top])) : null;
  const list = ents(doc), pos = new Map(list.map((n, i) => [n.id, i + 1]));
  ol.innerHTML = list.length ? list.map((n, i) => entryHtml(n, i, list.length, doc, pos)).join('')
    : `<li><div class="empty"><span class="tile-i blue">${icon('note')}</span><h4>No passages yet</h4><p>Add notes, highlights or comments to begin your study.</p><button class="btn btn-tinted sm" type="button" data-act="add" aria-haspopup="dialog">${icon('plus')}Add notes</button></div></li>`;
  $('#dc-count', view()).textContent = list.length ? ` ${list.length}` : '';
  $('#dc-meta', view()).textContent = docMeta(doc);
  $('#dc-ol', view()).innerHTML = list.map((n, i) => `<li><a href="#b-${esc(n.id)}" data-jump="${esc(n.id)}"><span class="dc-ol-n">${i + 1}</span>${dotHtml(n)}<span class="dc-ol-t">${esc(n.label)}</span></a></li>`).join('');
  const og = $('.dc-order', view()); if (og) ui.setRadio(og, b => b.dataset.order === doc.order);
  if (before) for (const el of $$('.dc-entry', ol)) {
    const t0 = before.get(el.dataset.id);
    if (t0 === undefined) { el.animate([{ opacity: 0, transform: 'scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.22,1,.36,1)' }); continue; }
    const dy = t0 - el.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 400, easing: 'cubic-bezier(.32,.72,0,1)' });
  }
}
function grow(ta) { if (!ta) return; ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; }
function renderEdit() {
  const v = view(), d = doc; if (!v || !d) return;
  v.innerHTML = editHtml(d);
  fillEntries(false); for (const s of $$('.dc-seg', v)) ui.placeInd(s); grow($('#dc-intro', v));
  // verses and cross-references that were not in hand yet: draw the passages again once they are
  const missing = ents(d).some(n => (n.v && !verseOf(n)) || xrefsOf(n).some(x => !xDone.has(xKey(x))));
  if (missing || ents(d).some(n => !(n.b in xrefs))) prepare(d).then(() => { if (mode === 'edit' && doc === d && !drag && view()) fillEntries(false); });
}

// ---------- read: the finished document
/** The intro or a note as the paper shows it: links to passages in the study, plain words for the rest. */
function paperMd(text, pos) {
  const t = document.createElement('template'); t.innerHTML = md(text);
  for (const a of t.content.querySelectorAll('a.vlink')) {
    const q = a.querySelector('q'), tg = linkTarget(a), p = tg && pos.get(tg.id);
    const label = [...a.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('') + (q ? ` · “${q.textContent}”` : '');
    const s = document.createElement(p ? 'a' : 'span');
    s.className = tg && byId.has(tg.id) ? 'note-ref' : 'verse-ref'; s.textContent = label;
    if (p) { s.setAttribute('href', `#r-${tg.id}`); s.dataset.rjump = tg.id; s.setAttribute('aria-label', `${label}, passage ${p}`); s.insertAdjacentHTML('beforeend', `<span class="dc-see" aria-hidden="true">${p}</span>`); }
    a.replaceWith(s);
  }
  return t.innerHTML;
}
/** The themes in a study: the reader's own tags and the themes found in the notes, two notes or more each. */
function docThemes(list) {
  const th = T(), m = new Map(), sug = new Map(th.overall.map(t => [t.name, t.suggested]));
  const rank = new Map(th.overall.map((t, i) => [t.name, i]));
  const twin = new Map([...th.overall.filter(t => t.tag).map(t => [t.tag, t.name]), ...th.yours.filter(y => y.topic).map(y => [y.name, y.topic])]);
  for (const n of list) {
    for (const tag of n.tags) { const k = '#' + tag, e = m.get(k) || { key: k, label: ST.tagLabel(tag), n: 0, suggested: false }; e.n++; m.set(k, e); }
    for (const t of th.byNote[n.id] || []) { if (t.weak) continue; const e = m.get(t.name) || { key: t.name, label: t.label, n: 0, suggested: sug.has(t.name) ? sug.get(t.name) : true }; e.n++; m.set(t.name, e); }
  }
  const shown = e => e.n >= 2, seen = new Set();
  return [...m.values()].filter(e => shown(e) && !(twin.has(e.key) && m.has(twin.get(e.key)) && shown(m.get(twin.get(e.key)))))
    .sort((a, z) => z.n - a.n || (rank.get(a.key) ?? 99) - (rank.get(z.key) ?? 99))
    .filter(e => { const k = e.label.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);
}
const trsOf = list => [...new Set(list.filter(n => n.v).map(trOf))].map(tr => trInfo(tr).name);
function paperHtml(d) {
  const list = ents(d), pos = new Map(list.map((n, i) => [n.id, i + 1])), title = d.title.trim() || 'Untitled study', inc = incFor(d.id);
  if (!list.length) return `<article class="dc-paper" aria-labelledby="dc-doc-title"><header class="dc-doc-head"><p class="dc-doc-kicker">A study</p><h2 class="dc-doc-title" id="dc-doc-title" tabindex="-1" data-autofocus>${esc(title)}</h2></header>
    <div class="empty"><span class="tile-i blue">${icon('note')}</span><h4>Nothing to read yet</h4><p>Add a few notes to this study, and it reads here as a finished document.</p><button class="btn btn-tinted sm" type="button" data-mode="edit">Edit the study</button></div></article>`;
  const t = list.map(n => n.created), a = Math.min(...t), b = Math.max(...t), themes = docThemes(list);
  const head = `<header class="dc-doc-head">
      <p class="dc-doc-kicker">A study · ${esc(monthSpan(a, b))}</p>
      <h2 class="dc-doc-title" id="dc-doc-title" tabindex="-1" data-autofocus>${esc(title)}</h2>
      <p class="dc-doc-by">${plural(list.length, 'passage')} from ${esc(bookNames(list))} · ${esc(spanLabel(a, b))}</p>
      ${themes.length ? `<div class="ls-chips dc-doc-themes" role="list" aria-label="Themes">${themes.map(e => `<span role="listitem" class="ls-chip theme${e.suggested ? ' suggested' : ''}"${e.suggested ? ' title="Suggested from OpenBible topics"' : ''}>${esc(e.label)}<span class="ls-count">${e.n}</span></span>`).join('')}</div>` : ''}
      ${d.intro.trim() ? `<div class="dc-doc-intro">${paperMd(d.intro, pos)}</div>` : ''}
    </header>`;
  const toc = list.length > 2 ? `<nav class="dc-toc" aria-labelledby="dc-toc-h"><h3 id="dc-toc-h">In this study</h3><ol>${list.map((n, i) => `<li><a href="#r-${esc(n.id)}" data-rjump="${esc(n.id)}"><span class="n">${i + 1}</span><span class="r">${esc(n.label)}</span>${n.phrase ? `<span class="p">“${esc(n.phrase)}”</span>` : ''}</a></li>`).join('')}</ol></nav>` : '';
  const byRef = new Map(list.map(n => [n.ref, n]));
  const sec = (n, i) => {
    const links = inc.refs ? linksIn(n.text) : [], xs = inc.xrefs ? xrefsOf(n) : [];
    const see = id => pos.has(id) ? `<span class="dc-see" aria-hidden="true">${pos.get(id)}</span>` : '';
    const refLi = l => l.kind === 'note'
      ? `<li>${pos.has(l.note.id) ? `<a class="r" href="#r-${esc(l.note.id)}" data-rjump="${esc(l.note.id)}" aria-label="${esc(l.note.label)}, passage ${pos.get(l.note.id)}">${esc(l.note.label)}</a>` : `<span class="r">${esc(l.note.label)}</span>`}${l.note.phrase ? ` <span class="q">“${esc(l.note.phrase)}”</span>` : ''} ${see(l.note.id)}</li>`
      : `<li><span class="r">${esc(l.label)}</span><span class="xt">${esc(xDone.get(xKey(l)) || '')}</span></li>`;
    const xrLi = x => { const o = byRef.get(x.ref); return `<li>${o ? `<a class="r" href="#r-${esc(o.id)}" data-rjump="${esc(o.id)}">${esc(x.label)}</a> ${see(o.id)}` : `<b>${esc(x.label)}</b>`}<span class="xt">${esc(xDone.get(xKey(x)) || '')}</span></li>`; };
    const also = [links.length ? `<div><h4>References</h4><ul>${links.map(refLi).join('')}</ul></div>` : '', xs.length ? `<div><h4>Cross-references</h4><ul>${xs.map(xrLi).join('')}</ul></div>` : ''].join('');
    const vt = verseOf(n);
    return `<section class="dc-sec" id="r-${esc(n.id)}" aria-labelledby="r-${esc(n.id)}-h">
      <header class="dc-sec-head"><span class="dc-sec-n" aria-hidden="true">${i + 1}</span><h3 id="r-${esc(n.id)}-h"><span class="sr">${i + 1}. </span>${esc(n.label)}</h3><span class="dc-sec-meta">${KIND[n.kind]} · ${esc(dayMonth(n.created))}</span></header>
      ${inc.verse && vt ? `<blockquote class="dc-verse dc-c" data-color="${esc(marked(n) ? n.color : 'plain')}"><p>${verseHtml(n)}</p><cite>${esc(trInfo(trOf(n)).abbr)}</cite></blockquote>` : ''}
      ${inc.note && n.text ? `<div class="dc-body">${paperMd(n.text, pos)}</div>` : ''}
      ${also ? `<div class="dc-also">${also}</div>` : ''}
    </section>`;
  };
  const trs = trsOf(list);
  return `<article class="dc-paper" aria-labelledby="dc-doc-title">${head}<hr class="dc-rule">${toc}${list.map(sec).join('')}
    <footer class="dc-doc-foot"><p>${trs.length ? `Scripture quotations are from the ${esc(andList(trs))}. ` : ''}Cross-references from OpenBible.info (CC BY). Made with Bible Lantern, ${esc(longDay(d.updated))}.</p></footer></article>`;
}
async function renderRead() {
  const v = view(), d = doc; if (!v || !d) return;
  const my = ++readSeq;
  v.innerHTML = `${barHtml()}<div class="dc-view" id="dc-read"><article class="dc-paper" aria-busy="true"></article></div>`;
  for (const s of $$('.dc-seg', v)) ui.placeInd(s);
  await Promise.all([prepare(d), loadSt()]);
  if (my !== readSeq || mode !== 'read' || doc !== d || !view()) return;
  const r = $('#dc-read', view()); if (r) r.innerHTML = paperHtml(d);
  const f = $('#dc-read [data-autofocus]', view()); if (f && !view().contains(document.activeElement)) f.focus({ preventScroll: true });
}

// ------------------------------------------------------------ the builder's actions
function remove(id) {
  const d = doc, i = d.entries.indexOf(id), n = byId.get(id); if (i < 0) return;
  const next = d.entries[i + 1] || d.entries[i - 1], label = n ? n.label : 'the passage';
  d.entries.splice(i, 1); touch(d); fillEntries(true);
  const f = next ? $(`#b-${cssId(next)} [data-rm]`, view()) : $('#dc-entries [data-act="add"]', view()) || $('.dc-add', view());
  if (f) f.focus({ preventScroll: true });
  say(`Removed ${label}`);
  toast(`Removed ${label} from the study.${DRY ? ' ' + DRY_MSG : ''}`, { label: 'Undo', run: () => {
    const ids = [...d.entries]; ids.splice(Math.min(i, ids.length), 0, id); setEntries(d, ids); touch(d);
    if (mode === 'edit' && doc === d) { fillEntries(true); const g = $(`#b-${cssId(id)} .dc-grip`, view()); if (g) g.focus(); }
    say(`${label} is back in the study`);
  } });
}
function addNote(id, from) {
  const n = byId.get(id); if (!n || !doc || doc.entries.includes(id)) return;
  setEntries(doc, [...doc.entries, id]); touch(doc); fillEntries(true);
  const p = doc.entries.indexOf(id) + 1;
  const f = from && $(`#b-${cssId(from)} [data-jump="${cssId(id)}"]`, view()); if (f) f.focus({ preventScroll: true });
  say(`Added ${n.label} as passage ${p}`); toast(`Added ${n.label} as passage ${p}.`);
}
function move(id, delta) {
  const ids = [...doc.entries], i = ids.indexOf(id), j = i + delta; if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]]; doc.entries = ids; doc.order = 'custom'; touch(doc);
  fillEntries(true);
  const g = $(`#b-${cssId(id)} .dc-grip`, view()); if (g) g.focus();
  const n = byId.get(id); say(`${n ? n.label : 'The passage'} moved to passage ${j + 1} of ${ids.length}`);
}
const cssId = s => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));
function jumpTo(elId) {
  const el = view() && view().querySelector(`#${cssId(elId)}`); if (!el) return;
  el.scrollIntoView({ block: el.classList.contains('dc-entry') ? 'center' : 'start', behavior: RM.matches ? 'auto' : 'smooth' });
  if (el.classList.contains('dc-entry')) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  const f = el.querySelector('.dc-grip, h3'); if (f) { if (f.tagName === 'H3') f.tabIndex = -1; f.focus({ preventScroll: true }); }
}
function deleteStudy(id, opener) {
  const was = savedStudies().find(x => x.id === id); if (!was) return;
  const gone = S.removeStudy(id); if (!gone) return;
  const title = (gone.title || '').trim() || 'Untitled study';
  if (doc && doc.id === id) { flushSave(); saveD = null; mode = 'home'; doc = null; }
  draw({ keepScroll: mode === 'home' });
  requestAnimationFrame(() => { const h = $('#dc-home-h', cur.host || document); if (h) h.focus({ preventScroll: true }); });
  say(`Deleted ${title}`);
  toast(`Deleted “${title}”.${DRY ? ' ' + DRY_MSG : ''}`, { label: 'Undo', run: () => {
    const back = S.saveStudy(gone); if (!back) return;
    if (mode === 'home') draw({ keepScroll: true });
    say(`${title} is back`);
  } });
}

// drag to reorder: the handle follows the pointer, the others make room; the list scrolls near its edges
function dragStart(e) {
  const g = e.target.closest('.dc-grip'); if (!g || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const li = g.closest('.dc-entry'), ol = li.parentElement, items = $$('.dc-entry', ol);
  if (items.length < 2) return;
  e.preventDefault();
  const sc = scroller(), rects = items.map(el => el.getBoundingClientRect()), from = items.indexOf(li);
  const gap = rects[1].top - rects[0].bottom;
  drag = { li, ol, items, rects, from, to: from, y0: e.clientY, y: e.clientY, s0: sc.scrollTop, sc, step: rects[from].height + gap, id: li.dataset.id, raf: 0 };
  try { g.setPointerCapture(e.pointerId); } catch (err) { /* the pointer is already gone */ }
  li.classList.add('dragging'); ol.classList.add('sorting'); document.body.classList.add('dc-grabbing');
  dragLayout(); drag.raf = requestAnimationFrame(dragTick);
}
function dragLayout() {
  const d = drag, dy = d.y - d.y0 + (d.sc.scrollTop - d.s0);
  d.li.style.transform = `translateY(${dy}px) scale(1.012)`;
  const mid = d.rects[d.from].top + d.rects[d.from].height / 2 + dy;
  let to = 0;
  d.items.forEach((el, i) => { if (i !== d.from && mid > d.rects[i].top + d.rects[i].height / 2) to++; });
  d.to = to;
  d.items.forEach((el, i) => {
    if (i === d.from) return;
    const s = d.from < to && i > d.from && i <= to ? -d.step : to < d.from && i >= to && i < d.from ? d.step : 0;
    el.style.transform = s ? `translateY(${s}px)` : '';
  });
}
function dragTick() {
  if (!drag) return;
  const d = drag, box = d.sc.getBoundingClientRect();
  const bar = $('#dc-bar', cur.host), top = box.top + (bar ? bar.offsetHeight : 0) + 36, bottom = box.bottom - 48;
  const v = d.y < top ? -Math.ceil((top - d.y) / 5) : d.y > bottom ? Math.ceil((d.y - bottom) / 5) : 0;
  if (v) { const s = d.sc.scrollTop; d.sc.scrollTop = s + Math.max(-18, Math.min(18, v)); if (d.sc.scrollTop !== s) dragLayout(); }
  d.raf = requestAnimationFrame(dragTick);
}
function endDrag() {
  if (!drag) return;
  const d = drag; drag = null; cancelAnimationFrame(d.raf);
  const visTop = d.li.getBoundingClientRect().top;
  document.body.classList.remove('dc-grabbing'); d.ol.classList.remove('sorting'); d.li.classList.remove('dragging');
  for (const el of d.items) el.style.transform = '';
  if (d.to !== d.from && doc) {
    const ids = [...doc.entries], i = ids.indexOf(d.id);
    if (i >= 0) { const [x] = ids.splice(i, 1); ids.splice(Math.min(d.to, ids.length), 0, x); }
    doc.entries = ids; doc.order = 'custom'; touch(doc); fillEntries(false);
    const n = byId.get(d.id); say(`${n ? n.label : 'The passage'} moved to passage ${d.to + 1} of ${ids.length}`);
  }
  const nli = view() && view().querySelector(`#b-${cssId(d.id)}`); if (!nli) return;
  const dy = visTop - nli.getBoundingClientRect().top;
  if (!RM.matches && Math.abs(dy) > 1) nli.animate([{ transform: `translateY(${dy}px) scale(1.012)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.32,.72,0,1)' });
  const g = nli.querySelector('.dc-grip'); if (g) g.focus({ preventScroll: true });
}

// ------------------------------------------------------------ starts
function startFlow(k, opener) {
  if (k === 'month') { const r = ctxRange() || monthRange(Date.now()), m = monthRange(Date.now()), own = r.from === m.from && r.to === m.to ? m : r; go('edit', { d: makeDoc(rangeStart(own.from, own.to)), focus: true }); }
  else if (k === 'theme') openTheme('new', opener);
  else if (k === 'range') openRange('new', opener);
  else if (k === 'picks') openPick('new', opener);
}
function changeSource(opener) {
  const s = srcOf.get(doc.id) || { kind: 'picks' };
  if (s.kind === 'range') openRange('replace', opener, s); else if (s.kind === 'picks') openPick('replace', opener); else openTheme('replace', opener);
}
/** Apply a start: a new study, or (replace) the current one's passages from a new source. */
function applyStart(how, start) {
  if (!start) return;
  if (how === 'new') { go('edit', { d: makeDoc(start), focus: true }); return; }
  replaceFrom(doc, start); renderEdit(); say(`The study now has ${plural(doc.entries.length, 'passage')}`);
}
/** A hand-off from This month or Connected (renderStudies' start): opens the builder. */
async function doStart(s) {
  const hint = typeof s.title === 'string' ? s.title.trim().slice(0, S.STUDY_TITLE_MAX) : '';
  let start = null;
  if (s.kind === 'month') { const r = ctxRange() || monthRange(Date.now()); start = rangeStart(r.from, r.to, 'recap'); }
  else if (s.kind === 'picks') start = picksStart(Array.isArray(s.keys) ? s.keys.filter(k => byId.has(k)) : [], 'connect');
  else {
    draw(); await loadSt(); refreshEntries();
    start = s.kind === 'thread' ? themeStart('thread', s.thread) : themeStartFor(s.theme || '');
    if (!start) { toast('That theme has no notes to study yet.'); draw(); return; }
  }
  if (hint) start.title = hint;
  go('edit', { d: makeDoc(start), focus: true });
}

// ------------------------------------------------------------ dialogs: theme, dates, notes, export
let dlg = null;
function dialog() {
  if (dlg) return dlg;
  dlg = document.createElement('dialog'); dlg.className = 'modal dc-dlg'; dlg.id = 'dc-dlg'; dlg.setAttribute('aria-labelledby', 'dc-dlg-h');
  document.body.append(dlg);
  dlg.addEventListener('pointerdown', e => { dlg._down = e.target === dlg; });
  dlg.addEventListener('click', e => {
    const close = e.target.closest('[data-close]') || (e.target === dlg && dlg._down); dlg._down = false;
    if (close) { closeDlg(); return; }
    if (dlg._on && dlg._on.click) dlg._on.click(e);
  });
  dlg.addEventListener('input', e => { if (dlg._on && dlg._on.input) dlg._on.input(e); });
  dlg.addEventListener('change', e => { if (dlg._on && dlg._on.change) dlg._on.change(e); });
  dlg.addEventListener('keydown', e => {
    const g = e.target.closest && e.target.closest('[role=radiogroup]');
    if (g && e.target.matches('[role=radio]')) ui.radioKeys(e, g, btn => btn.click());
  });
  dlg.addEventListener('cancel', e => { e.preventDefault(); closeDlg(); });
  dlg.addEventListener('close', () => { const o = dlg._opener; dlg._opener = null; dlg._on = null; if (o && o.isConnected) o.focus({ preventScroll: true }); });
  return dlg;
}
function openDlg({ title, body, foot = '', tools = '', tall = false, on = null }, opener) {
  const d = dialog();
  d.classList.toggle('tall', tall);
  d.innerHTML = `<div class="modal-head"><h2 class="modal-title" id="dc-dlg-h">${esc(title)}</h2><button type="button" class="close-btn" data-close aria-label="Close">${icon('xmark')}</button></div>${tools}<div class="modal-body" id="dc-dlg-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}`;
  d._on = on; d._opener = opener || document.activeElement;
  ui.showDialog(d);
  for (const s of $$('.dc-seg', d)) ui.placeInd(s);
  return d;
}
function closeDlg({ focus = true } = {}) { if (!dlg) return; if (!focus) dlg._opener = null; ui.closeDialog(dlg); }
const dlgOpen = () => !!(dlg && dlg.open && !dlg.classList.contains('closing'));

// theme: your tags, the themes found in your notes, the threads you followed
let themeHow = 'new';
async function openTheme(how, opener) {
  themeHow = how;
  const title = how === 'new' ? 'Start from a theme' : 'Change the theme';
  const d = openDlg({ title, tall: true, body: '<p class="dc-loading" role="status">Gathering your notes…</p>', on: { click: e => {
    const b = e.target.closest('[data-tk]'); if (!b) return;
    const start = themeStart(b.dataset.tk, b.dataset.tid);
    closeDlg({ focus: false }); applyStart(themeHow, start);
  } } }, opener);
  await loadSt(); refreshEntries();
  if (!d.open || $('#dc-dlg-h', d).textContent !== title) return;
  const th = T(), threads = st ? st.threads : [];
  const cell = (k, id, t, small, sub, count, badge) => `<li><button class="cell" type="button" data-tk="${k}" data-tid="${esc(id)}"><span class="cell-body"><span class="cell-title">${esc(t)}${small ? `<small>${esc(small)}</small>` : ''}${badge ? '<span class="ls-badge lamp">Suggested</span>' : ''}</span><span class="cell-sub">${esc(sub)}</span></span><span class="cell-trail"><span class="ls-count">${count}</span>${icon('chev-right')}</span></button></li>`;
  const none = t => `<p class="dc-dlg-note">${t}</p>`;
  $('#dc-dlg-body', d).innerHTML = `
    <section aria-labelledby="th-tags"><div class="lh"><h3 id="th-tags">Your tags</h3><span>${th.yours.length}</span></div>
      ${th.yours.length ? `<ul class="group">${th.yours.map(y => cell('tag', y.tag, y.label, y.name, y.why, y.count)).join('')}</ul>` : none('Add a #tag to a note and it appears here.')}</section>
    <section aria-labelledby="th-found"><div class="lh"><h3 id="th-found">Found in your notes</h3><span>${th.overall.length}</span></div>
      <p class="dc-dlg-note">Matched in the page against OpenBible’s topics and cross-references, with no AI service. A suggestion stays yours to accept, rename or remove.</p>
      ${th.overall.length ? `<ul class="group">${th.overall.map(o => cell('theme', o.name, o.label, '', o.why, o.count, o.suggested)).join('')}</ul>` : none('No theme yet: themes appear once a few notes share a subject.')}</section>
    <section aria-labelledby="th-threads"><div class="lh"><h3 id="th-threads">Threads you followed</h3><span>${threads.length}</span></div>
      ${threads.length ? `<ul class="group">${threads.map(t => cell('thread', t.id, t.label, '', `${plural(t.noteIds.length, 'note')}, ${spanLabel(dayOf(t.start), dayOf(t.end))}`, t.noteIds.length)).join('')}</ul>` : none('A thread forms when your notes reference one another.')}</section>`;
  $('#dc-dlg-body', d).scrollTop = 0;
}

// dates
const rng = { how: 'new', preset: 'month', from: 0, to: 0 };
function presetRange(p) {
  if (p === 'month') return monthRange(Date.now());
  const end = dayOf(Date.now()); return { from: addDays(end, -(+p - 1)), to: end };
}
function openRange(how, opener, src) {
  rng.how = how;
  const m = monthRange(Date.now());
  if (src && src.kind === 'range') { rng.from = src.from; rng.to = src.to; rng.preset = src.from === m.from && src.to === m.to ? 'month' : 'custom'; }
  else { rng.preset = 'month'; Object.assign(rng, m); }
  openDlg({
    title: how === 'new' ? 'Start from dates' : 'Change the dates',
    body: `<div class="ls-chips dc-presets" id="rng-presets" role="group" aria-label="Days"></div>
      <div class="dc-dates" id="rng-custom">
        <label class="dc-date"><span>From</span><span class="field"><input type="date" id="rng-from"></span></label>
        <label class="dc-date"><span>To</span><span class="field"><input type="date" id="rng-to"></span></label>
      </div>
      <div class="dc-sum" id="rng-sum" aria-live="polite"></div>`,
    foot: `<button type="button" class="btn btn-gray" data-close>Cancel</button><button type="button" class="btn btn-primary" id="rng-go">${how === 'new' ? 'Start study' : 'Update study'}</button>`,
    on: {
      click: e => {
        const b = e.target.closest('[data-preset]');
        if (b) { rng.preset = b.dataset.preset; if (rng.preset !== 'custom') Object.assign(rng, presetRange(rng.preset)); fillRange(); $(`#rng-presets [data-preset="${rng.preset}"]`, dlg).focus(); if (rng.preset === 'custom') say('Choose the first and last day'); return; }
        if (e.target.closest('#rng-go')) { const start = rangeStart(rng.from, rng.to); closeDlg({ focus: false }); applyStart(rng.how, start); }
      },
      change: e => { if (e.target.id !== 'rng-from' && e.target.id !== 'rng-to') return; const t = parseDay(e.target.value); if (t === null) return; rng[e.target.id === 'rng-from' ? 'from' : 'to'] = t; fillRange(); },
    },
  }, opener);
  fillRange();
}
function fillRange() {
  const d = dlg, m = monthRange(Date.now());
  const PRESETS = [['month', monthName(m.from)], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['custom', 'Choose dates']];
  $('#rng-presets', d).innerHTML = PRESETS.map(([k, t]) => `<button type="button" class="ls-chip" data-preset="${k}" aria-pressed="${rng.preset === k}">${t}</button>`).join('');
  $('#rng-custom', d).hidden = rng.preset !== 'custom';
  $('#rng-from', d).value = isoDay(rng.from); $('#rng-to', d).value = isoDay(rng.to);
  const sum = $('#rng-sum', d), go = $('#rng-go', d);
  if (rng.from > rng.to) { sum.innerHTML = '<p class="dc-err">The first day is after the last. Choose the days again.</p>'; go.disabled = true; return; }
  const list = ST.inRange(rng.from, addDays(rng.to, 1), all()); go.disabled = !list.length;
  sum.innerHTML = list.length
    ? `<p><b>${esc(kindsPhrase(list))}</b><br><span class="ls-muted">${esc(spanLabel(rng.from, rng.to))}, from ${esc(bookNames(list))}</span></p>
       <div class="ls-chips">${list.slice(0, 6).map(n => `<span class="ls-chip">${esc(n.label)}</span>`).join('')}${list.length > 6 ? `<span class="ls-chip ls-muted">and ${list.length - 6} more</span>` : ''}</div>`
    : `<p><b>Nothing from these days</b><br><span class="ls-muted">Highlight a verse or write a note, and it can be studied here.</span></p>`;
}

// notes, picked by hand (new study, add to a study, or change a picked study)
const pick = { how: 'new', chosen: new Set(), kind: 'all', q: '' };
const PICK_KINDS = [['all', 'All'], ['note', 'Notes'], ['highlight', 'Highlights'], ['comment', 'Comments']];
function pickRows() {
  const q = pick.q.trim().toLowerCase();
  return all().sort((a, z) => z.created - a.created)
    .filter(n => pick.kind === 'all' || n.kind === pick.kind)
    .filter(n => !q || `${n.label} ${n.quote} ${ST.plainText(n.text, 9999)} ${n.tags.map(t => '#' + t).join(' ')}`.toLowerCase().includes(q));
}
function openPick(how, opener) {
  pick.how = how; pick.kind = 'all'; pick.q = '';
  pick.chosen = new Set(how === 'new' ? [] : doc.entries);
  openDlg({
    title: how === 'add' ? 'Add notes' : how === 'replace' ? 'Change the notes' : 'Pick notes', tall: true,
    tools: `<div class="dc-pick-tools">
      <label class="field">${icon('search')}<input type="search" id="pick-q" placeholder="Search by reference or words" aria-label="Search your notes" autocomplete="off"></label>
      <div class="ls-row"><div class="ls-chips" id="pick-kinds" role="group" aria-label="Show"></div><button type="button" class="btn btn-plain sm" id="pick-all">Select all</button></div>
    </div>`,
    body: '<ul class="dc-picks" id="pick-list" aria-label="Your notes, highlights and comments"></ul>',
    foot: `<span class="dc-foot-note" id="pick-count" aria-live="polite">None chosen</span><button type="button" class="btn btn-gray" data-close>Cancel</button><button type="button" class="btn btn-primary" id="pick-go">${how === 'new' ? 'Start study' : 'Update study'}</button>`,
    on: {
      click: e => {
        const k = e.target.closest('[data-kind]'); if (k) { pick.kind = k.dataset.kind; fillPicks(); $(`#pick-kinds [data-kind="${pick.kind}"]`, dlg).focus(); return; }
        if (e.target.closest('#pick-all')) { const shown = pickRows(), on = shown.every(x => pick.chosen.has(x.id)); for (const n of shown) if (on) pick.chosen.delete(n.id); else pick.chosen.add(n.id); fillPicks(); return; }
        if (e.target.closest('#pick-go')) pickGo();
      },
      input: e => { if (e.target.id === 'pick-q') { pick.q = e.target.value; fillPicks(); } },
      change: e => { const c = e.target.closest('.dc-check'); if (!c) return; if (c.checked) pick.chosen.add(c.value); else pick.chosen.delete(c.value); pickCount(); },
    },
  }, opener);
  fillPicks();
  if (matchMedia('(pointer: fine)').matches) $('#pick-q', dlg).focus();
}
function fillPicks() {
  const d = dlg, list = all();
  $('#pick-kinds', d).innerHTML = PICK_KINDS.map(([k, t]) => `<button type="button" class="ls-chip" data-kind="${k}" aria-pressed="${pick.kind === k}">${t}<span class="ls-count">${k === 'all' ? list.length : list.filter(n => n.kind === k).length}</span></button>`).join('');
  const rows = pickRows();
  $('#pick-list', d).innerHTML = rows.length ? rows.map(n => `<li><label class="dc-pick"><input type="checkbox" class="dc-check" value="${esc(n.id)}"${pick.chosen.has(n.id) ? ' checked' : ''}>
      ${dotHtml(n)}
      <span class="dc-pick-b"><span class="dc-pick-t">${esc(n.label)}<span class="dc-pick-k">${KIND[n.kind]} · ${esc(longDay(n.created))}</span></span>${n.phrase ? `<span class="dc-pick-q">“${esc(n.phrase)}”</span>` : ''}${n.text ? `<span class="dc-pick-s">${esc(ST.plainText(n.text, 120))}</span>` : ''}</span></label></li>`).join('')
    : `<li class="dc-pick-none">${list.length ? `Nothing matches “${esc(pick.q)}”.` : 'Nothing yet. Highlight a verse or write a note, and it can be picked here.'}</li>`;
  pickCount();
}
function pickCount() {
  const d = dlg, n = pick.chosen.size, shown = pickRows(), on = shown.length && shown.every(x => pick.chosen.has(x.id));
  $('#pick-count', d).textContent = n ? `${n} chosen` : 'None chosen';
  $('#pick-go', d).disabled = !n && pick.how === 'new';
  const b = $('#pick-all', d); b.textContent = on ? 'Clear these' : 'Select all'; b.disabled = !shown.length;
}
function pickGo() {
  const ids = all().filter(n => pick.chosen.has(n.id)).map(n => n.id);
  closeDlg({ focus: pick.how === 'add' });
  if (pick.how === 'new') { applyStart('new', picksStart(ids)); return; }
  const had = new Set(doc.entries), keep = doc.entries.filter(id => pick.chosen.has(id) || !byId.has(id)), added = ids.filter(id => !had.has(id));
  const removed = doc.entries.length - keep.length;
  setEntries(doc, [...keep, ...added]);
  if (pick.how === 'replace') srcOf.set(doc.id, { kind: 'picks', count: doc.entries.length, via: (srcOf.get(doc.id) || {}).via || '' });
  touch(doc); if (pick.how === 'replace') renderEdit(); else fillEntries(true);
  const what = added.length && removed ? `Added ${added.length} and removed ${removed}` : added.length ? `Added ${plural(added.length, 'passage')}` : removed ? `Removed ${plural(removed, 'passage')}` : '';
  if (what) { const m = `${what}: the study now has ${doc.entries.length}.`; say(m); toast(m); }
}

// export: one Markdown file, made in the page
function mdText(text, pos) {
  return String(text || '').replace(/\[\[([^[\]]+)\]\]/g, (m0, s) => {
    const r = ST.parseRefText(s); if (!r) return s.split('|').pop().trim();
    const res = ST.resolveRef(r), id = ST.refId(res), n = byId.get(id);
    const label = s.includes('|') ? s.split('|').pop().trim() : n ? ST.chipLabel(n) : refLabel(res.b, res.c, res.v, res.ve || 0);
    return label + (n && pos.has(n.id) ? ` (see ${pos.get(n.id)})` : '');
  });
}
function verseMd(n) {
  const text = verseOf(n), i = marked(n) && n.quote ? text.indexOf(n.quote) : -1;
  if (i < 0) return text;
  const w = n.color ? '**' : '*';
  return text.slice(0, i) + w + n.quote + w + text.slice(i + n.quote.length);
}
function exportText(d) {
  const list = ents(d), pos = new Map(list.map((n, i) => [n.id, i + 1])), title = d.title.trim() || 'Untitled study', inc = incFor(d.id), L = [];
  L.push(`# ${title}`, '');
  if (d.intro.trim()) L.push(mdText(d.intro.trim(), pos), '');
  if (list.length) { const t = list.map(n => n.created), trs = trsOf(list); L.push(`*${plural(list.length, 'passage')} from ${bookNames(list)} · ${spanLabel(Math.min(...t), Math.max(...t))}${trs.length ? ` · ${andList(trs)}` : ''}*`, ''); }
  list.forEach((n, i) => {
    L.push(`## ${i + 1}. ${n.label}`, '');
    const vt = verseOf(n);
    if (inc.verse && vt) L.push(`> ${verseMd(n)}`, `> — ${n.label} (${trInfo(trOf(n)).abbr})`, '');
    if (inc.note && n.text) L.push(mdText(n.text.trim(), pos), '');
    const links = inc.refs ? linksIn(n.text) : [];
    if (links.length) L.push(`References: ${links.map(l => l.kind === 'note' ? ST.chipLabel(l.note) + (pos.has(l.note.id) ? ` (see ${pos.get(l.note.id)})` : '') : l.label).join(' · ')}`, '');
    const xs = inc.xrefs ? xrefsOf(n) : [];
    if (xs.length) L.push(`Cross-references: ${xs.map(x => x.label).join(' · ')}`, '');
  });
  const trs = trsOf(list);
  L.push('---', '', `${trs.length ? `Scripture quotations are from the ${andList(trs)}. ` : ''}Cross-references from OpenBible.info (CC BY). Exported from Bible Lantern on ${longDay(Date.now())}.`, '');
  return L.join('\n');
}
const fileName = d => `${(d.title.trim() || 'Untitled study').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim()}.md`;
let exp = { text: '', name: '' };
async function openExport(opener) {
  const d = doc;
  openDlg({
    title: 'Export study',
    body: `<p class="dc-fmt-desc">One Markdown file for any notes app: each passage’s verse with your highlighted words in bold, your note, its references and cross-references.</p>
      <div class="dc-file"><span class="tile-i blue">${icon('note')}</span><b id="exp-name"></b><span id="exp-size"></span></div>
      <pre class="dc-pre" id="exp-pre" tabindex="0" aria-label="Preview of the file">Gathering the passages…</pre>`,
    foot: `<span class="dc-foot-note">Made in your browser; nothing is sent</span><button type="button" class="btn btn-gray" data-close>Cancel</button><button type="button" class="btn btn-primary" id="exp-go" disabled>Download</button>`,
    on: { click: e => {
      if (!e.target.closest('#exp-go')) return;
      const url = URL.createObjectURL(new Blob([exp.text], { type: 'text/markdown;charset=utf-8' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: exp.name }); document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      closeDlg(); toast(`${exp.name} is in your downloads.`);
    } },
  }, opener);
  await prepare(d);
  if (!dlgOpen() || !$('#exp-pre', dlg)) return;
  exp = { text: exportText(d), name: fileName(d) };
  $('#exp-name', dlg).textContent = exp.name;
  const kb = new Blob([exp.text]).size / 1024; $('#exp-size', dlg).textContent = `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  $('#exp-pre', dlg).textContent = exp.text; $('#exp-pre', dlg).scrollTop = 0;
  $('#exp-go', dlg).disabled = false;
}

// ------------------------------------------------------------ print: only the document, as a printed study guide
function printRoot() {
  let r = $('#dc-print'); if (r) return r;
  r = document.createElement('div'); r.id = 'dc-print'; r.className = 'dc-print-root'; r.hidden = true; document.body.append(r);
  return r;
}
function beforePrint() {
  if (!doc || mode === 'home') return;
  const r = printRoot(); r.innerHTML = `<div class="dc-root">${paperHtml(doc)}</div>`; r.hidden = false;
  document.documentElement.classList.add('dc-printing');
}
function afterPrint() { document.documentElement.classList.remove('dc-printing'); const r = $('#dc-print'); if (r) { r.innerHTML = ''; r.hidden = true; } }
async function print() {
  if (!doc) return;
  await Promise.all([prepare(doc), loadSt()]);
  window.print();
}
if (typeof window !== 'undefined') { addEventListener('beforeprint', beforePrint); addEventListener('afterprint', afterPrint); }

// ------------------------------------------------------------ the sticky bar, events
function onScroll() {
  const bar = cur.host && $('#dc-bar', cur.host), sc = scroller(); if (!bar || !sc) return;
  bar.classList.toggle('stuck', sc.scrollTop > 0 && bar.getBoundingClientRect().top <= sc.getBoundingClientRect().top + .5);
}
function onClick(e) {
  const t = e.target; if (!(t instanceof Element)) return;
  if (dlgOpen() && dlg.contains(t)) return;
  const open = t.closest('[data-open]');
  if (open) { e.preventDefault(); const s = savedStudies().find(x => x.id === open.dataset.open); if (s) go(open.dataset.to === 'edit' ? 'edit' : 'read', { d: docOf(s), focus: true }); return; }
  const del = t.closest('[data-del]'); if (del) { deleteStudy(del.dataset.del, del); return; }
  const start = t.closest('[data-start]'); if (start) { startFlow(start.dataset.start, start); return; }
  if (t.closest('[data-ctx-start]')) { const cx = ctxInfo(); if (cx && cx.start) applyStart('new', cx.start); return; }
  const m = t.closest('[data-mode]');
  if (m) {
    if (m.dataset.mode !== mode && doc) { go(m.dataset.mode); const r = $(`.dc-mode [data-mode="${mode}"]`, cur.host); if (r && m.getAttribute('role') === 'radio') r.focus(); else requestAnimationFrame(() => { const f = $('#dc-view [data-autofocus]', cur.host); if (f) f.focus(); }); }
    return;
  }
  const o = t.closest('[data-order]');
  if (o && doc) { const k = o.dataset.order; if (k !== doc.order) { doc.order = k; if (k !== 'custom') doc.entries = sorted(doc.entries, k); touch(doc); fillEntries(true); say(k === 'bible' ? 'Passages in Bible order' : k === 'studied' ? 'Passages in the order you studied them' : 'Passages in your own order: drag a handle to move one'); } return; }
  const rm = t.closest('[data-rm]'); if (rm) { remove(rm.dataset.rm); return; }
  const add = t.closest('[data-add]'); if (add) { addNote(add.dataset.add, (add.closest('.dc-entry') || { dataset: {} }).dataset.id); return; }
  const j = t.closest('[data-jump]'); if (j) { e.preventDefault(); jumpTo(`b-${j.dataset.jump}`); return; }
  const rj = t.closest('[data-rjump]'); if (rj) { e.preventDefault(); jumpTo(`r-${rj.dataset.rjump}`); return; }
  const vs = t.closest('[data-verse]'); if (vs) { const p = vs.dataset.verse.split('.').map(Number); goVerse(p[0], p[1], p[2] || 0); return; }
  const vl = t.closest('a.vlink');   // a verse link or a chip in a note's text
  if (vl) {
    e.preventDefault();
    const tg = linkTarget(vl); if (!tg) return;
    if (doc && mode === 'edit' && doc.entries.includes(tg.id)) { jumpTo(`b-${tg.id}`); return; }
    const n = byId.get(tg.id);
    if (n && mode === 'edit') { toast(`${n.label} is not in this study.`, { label: 'Add it', run: () => addNote(tg.id) }); return; }
    if (vl.dataset.mark) goMark(vl.dataset.mark, vl.dataset.ref); else goVerse(tg.b, tg.c, tg.v);
    return;
  }
  const a = t.closest('[data-act]'); if (!a) return;
  const act = a.dataset.act;
  if (act === 'home') { const was = doc; go('home'); requestAnimationFrame(() => { const c = was && $(`.dc-study-title [data-open="${cssId(was.id)}"]`, cur.host); (c || $('#dc-home-h', cur.host) || {}).focus?.(); }); }
  else if (act === 'add') openPick('add', a);
  else if (act === 'change') changeSource(a);
  else if (act === 'print') print();
  else if (act === 'export') openExport(a);
  else if (act === 'link') toast('Sharing a study by link is coming later.');
}
function onKeydown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target; if (!(t instanceof Element)) return;
  const vl = t.closest('a.vlink'); if (vl && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); vl.click(); return; }
  const g = t.closest('.dc-grip');
  if (g) { const k = { ArrowUp: -1, ArrowDown: 1 }[e.key]; if (k) { e.preventDefault(); move(g.dataset.grip, k); } return; }
  const rg = t.closest('.dc-seg[role=radiogroup]');
  if (rg && t.matches('[role=radio]')) ui.radioKeys(e, rg, btn => btn.click());
}
function onInput(e) {
  if (!doc || mode !== 'edit') return;
  if (e.target.id === 'dc-title') { doc.title = e.target.value; touch(doc); }
  else if (e.target.id === 'dc-intro') { doc.intro = e.target.value; touch(doc); grow(e.target); }
}
function onChange(e) {
  const k = e.target.dataset && e.target.dataset.inc; if (!k || !doc) return;
  setInc(doc.id, k, e.target.checked); fillEntries(false);
  say(`${INC_ROWS.find(r => r[0] === k)[1]} ${e.target.checked ? 'shown' : 'left out'} in each passage`);
}
function bindHost(host) {
  if (host.dataset.dcBound) return;
  host.dataset.dcBound = '1';
  host.addEventListener('click', onClick);
  host.addEventListener('keydown', onKeydown);
  host.addEventListener('input', onInput);
  host.addEventListener('change', onChange);
  host.addEventListener('pointerdown', dragStart);
  host.addEventListener('pointermove', e => { if (!drag) return; drag.y = e.clientY; dragLayout(); });
  host.addEventListener('pointerup', endDrag); host.addEventListener('pointercancel', endDrag); host.addEventListener('lostpointercapture', endDrag);
  const sc = host.closest('.lib-body');
  if (sc && !sc.dataset.dcScroll) { sc.dataset.dcScroll = '1'; sc.addEventListener('scroll', onScroll, { passive: true }); }
}

// the data changed elsewhere (another window, the server, a note or highlight edited): draw again, keeping the place
function redrawSoon() {
  clearTimeout(redrawT);
  redrawT = setTimeout(() => {
    redrawT = 0;
    if (!cur.host || !cur.host.isConnected || !root() || drag) return;
    if (doc && mode !== 'home') {
      const s = savedStudies().find(x => x.id === doc.id);
      if (!s) { if (!fresh.has(doc.id) || !saveT) { toast('This study was removed in another window.'); mode = 'home'; doc = null; } }
      else if (!saveT && !sameDoc(doc, docOf(s))) doc = docOf(s);
      else if (mode === 'edit') { refreshEntries(); fillEntries(false); return; }   // the notes changed: the passages follow, the inputs stay
    }
    draw({ keepScroll: true });
  }, 60);
}
if (typeof document !== 'undefined') {
  document.addEventListener('bs:studies-changed', e => { if (e.detail && e.detail.reason !== 'local') redrawSoon(); });
  document.addEventListener('bs:notes-replaced', redrawSoon);
  document.addEventListener('bs:marks-changed', redrawSoon);
}

// ------------------------------------------------------------ exports
/** main.js-style wiring: {toast, navigate, yieldToPage}. */
export function init(actions) { A = actions || A; }
/** Draw the Studies view into host (see the top). Idempotent: a repeat call for the same host keeps what is shown. */
export function renderStudies(host, { ctx = null, start = null, onNavigate = null, toast: tf = null, navigate = null } = {}) {
  if (!host) return;
  bindHost(host);
  const ctxKey = JSON.stringify(ctx || {}), ctxWas = JSON.stringify(cur.ctx || {});
  const same = cur.host === host && !!root();
  Object.assign(cur, { host, ctx: ctx || {}, onNavigate: typeof onNavigate === 'function' ? onNavigate : null, toast: typeof tf === 'function' ? tf : null, navigate: typeof navigate === 'function' ? navigate : null });
  // a hand-off is acted on once: the same object, or the same start again (give `at: Date.now()` to repeat one)
  const startKey = start ? JSON.stringify(start) : '';
  if (start && start !== cur.start && startKey !== cur.startKey) { cur.start = start; cur.startKey = startKey; doStart(start); return; }
  if (pending) { const p = pending; pending = null; const s = savedStudies().find(x => x.id === p.id); if (s) { go(p.mode, { d: docOf(s), focus: true }); return; } }
  if (same && (ctxKey === ctxWas || mode !== 'home')) return;
  draw();
}
/** Show a study: the reading view (mode 'read') or the builder ('edit'). Asks the Library for the Studies tab when it is not shown. */
export function openStudy(id, { mode: m = 'read' } = {}) {
  const s = savedStudies().find(x => x.id === id); if (!s) return false;
  if (cur.host && cur.host.isConnected && root()) { go(m === 'edit' ? 'edit' : 'read', { d: docOf(s), focus: true }); return true; }
  pending = { id, mode: m === 'edit' ? 'edit' : 'read' };
  if (cur.onNavigate) cur.onNavigate('studies');
  return true;
}
/** What is shown: {mode, id} (for the Library's view state). */
export const studiesState = () => ({ mode, id: doc ? doc.id : null });
