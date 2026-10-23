// Library → Study, the data layer (study-build-brief §1): note references ([[John 1:4]] and, for a highlight or
// comment, [[John 1:4 · “the light of men”]]), backlinks (Mentioned in), the [[ picker, automatic themes, threads
// and connections. The algorithms are ported from the round-2 mock (app/mock/study-sample.js) and run on the app's
// real state: state.notes.refs, marks.js, app/data/topics.json and app/data/xref/NN.json (loaded lazily through
// store.js). Pure functions throughout, plus two small DOM helpers (attachPicker, mentionsHtml) for the editors;
// the Study views (stage 2) build on these.
import { state, data, bookOf, refKey, refLabel, parseRefKey, parseReference, rangeEnd, esc, previewText, previewTr, trInfo } from './store.js';
import { icon } from './icons.js';

// marks.js is optional (drawer.js loads it guarded the same way): references to a highlight or comment resolve
// once it has loaded; until then every reference is a verse reference.
let mrk = null;
import('./marks.js').then(m => { if (m && typeof m.marksFor === 'function') mrk = m; }, e => console.error('marks.js failed to load', e));

const flat = s => String(s || '').replace(/\s+/g, ' ').trim();
const vOf = ref => +String(ref).split('.')[2] || 0;
const bookName = b => (bookOf(+b) || {}).name || `Book ${b}`;
export const KIND = { note: 'Note', highlight: 'Highlight', comment: 'Comment' };

// ------------------------------------------------------------ references (§1.1)
const REF_RX = /\[\[([^[\]\n]+)\]\]/g;
const QUOTE_RX = /[“"]([^”"]+)[”"]/;
const PHRASE_WORDS = 5, PHRASE_MAX = 48;
/** The first words of a mark's quote, as a reference names it: 'the life was the light' (a prefix of the quote). */
export function phraseOf(quote) {
  let s = flat(quote).split(' ').slice(0, PHRASE_WORDS).join(' ');
  if (s.length > PHRASE_MAX) s = s.slice(0, PHRASE_MAX).replace(/\s+\S*$/, '') || s.slice(0, PHRASE_MAX);
  return s;
}
/** The text inside one [[…]] → {raw, b, c, v, ve, quote?} or null. Accepts the Obsidian form [[John 1.4|John 1:4 · “words”]]. */
export function parseRefText(raw) {
  raw = String(raw || '').trim();
  const bar = raw.indexOf('|'), target = bar >= 0 ? raw.slice(0, bar) : raw, label = bar >= 0 ? raw.slice(bar + 1) : '';
  const dot = target.indexOf(' · '), r = parseReference(dot >= 0 ? target.slice(0, dot) : target);
  if (!r) return null;
  const q = QUOTE_RX.exec(dot >= 0 ? target.slice(dot + 3) : label), ref = { raw, b: r.b, c: r.c, v: r.v, ve: r.vend || 0 };
  if (q && flat(q[1])) ref.quote = flat(q[1]).replace(/…$/, '');
  return ref;
}
/** Every reference in a note's markdown: [{raw, b, c, v, ve, quote?}], in order, unparseable ones left out. */
export function parseRefs(text) {
  const out = [];
  for (const m of String(text || '').matchAll(REF_RX)) { const r = parseRefText(m[1]); if (r) out.push(r); }
  return out;
}
/**
 * What a reference points at: {kind: 'verse' | 'mark', b, c, v, ve, mark?}. With quoted words, the highlight or
 * comment at that verse whose quote starts with them (case-insensitively; one starting at the verse first); no match
 * falls back to the verse.
 */
export function resolveRef(ref) {
  const out = { kind: 'verse', b: ref.b, c: ref.c, v: ref.v, ve: ref.ve || 0 };
  if (!ref.quote || !ref.v || !mrk) return out;
  const q = ref.quote.toLowerCase();
  const list = mrk.marksFor(ref.b, ref.c, ref.v).filter(m => flat(m.quote).toLowerCase().startsWith(q));
  const m = list.find(x => vOf(x.start) === ref.v) || list[0];
  if (m) { out.kind = 'mark'; out.mark = m; }
  return out;
}
/** The entry id a resolved reference names: the mark's id, or the note key of the verse. */
export const refId = res => (res.kind === 'mark' ? res.mark.id : refKey(res.b, res.c, res.v));
/** The reference text for an entry: 'John 1:4' for a note, 'John 1:4 · “the light of men”' for a highlight or comment. */
export const chipLabel = e => (e.kind === 'note' ? e.label : `${e.label} · “${e.phrase}”`);

// ------------------------------------------------------------ entries: notes, highlights and comments as one list
/**
 * Every note, highlight and comment, oldest first, in the shape the mock's helpers work on (study-sample.js `notes`):
 * {id, key, ref: 'b.c.v', b, c, v, label, kind: 'note' | 'highlight' | 'comment', color, quote, phrase, text, tags,
 *  created, updated, refs: [ids this one mentions], note? | mark?}.
 * A note's id is its key ('43.1.4', or '43.1' for a chapter note); a mark's is its id ('mk_…'). A mark with a colour
 * is a highlight, one without (a dotted underline) a comment; a note's legacy highlight is its colour. `refs` holds
 * only ids that are in the list (a verse reference counts when a note sits on that verse).
 */
export function entries() {
  const list = [];
  for (const [k, n] of Object.entries(state.notes.refs || {})) {
    if (!n || typeof n !== 'object') continue;
    const { b, c, v } = parseRefKey(k); if (!bookOf(b)) continue;
    list.push({ id: k, key: k, ref: k, b, c, v, label: refLabel(b, c, v), kind: 'note', color: n.highlight || '', quote: '', phrase: '', text: n.text || '',
      tags: Array.isArray(n.tags) ? n.tags : [], created: +n.created || +n.updated || 0, updated: +n.updated || 0, refs: [], note: n });
  }
  if (mrk) for (const m of mrk.marks.byId.values()) {
    const p = m.start.split('.').map(Number); if (!bookOf(p[0])) continue;
    list.push({ id: m.id, key: m.id, ref: m.start, b: p[0], c: p[1], v: p[2], label: mrk.markLabel(m), kind: m.color ? 'highlight' : 'comment', color: m.color, quote: m.quote,
      phrase: phraseOf(m.quote), text: m.note || '', tags: [], created: +m.created || 0, updated: +m.updated || 0, refs: [], mark: m });
  }
  list.sort((a, z) => a.created - z.created);
  const ids = new Set(list.map(e => e.id));
  for (const e of list) if (e.text) for (const r of parseRefs(e.text)) {
    const id = refId(resolveRef(r));
    if (id !== e.id && ids.has(id) && !e.refs.includes(id)) e.refs.push(id);
  }
  return list;
}
/** Entries created inside [from, to) (ms). */
export const inRange = (from, to, list = entries()) => list.filter(e => e.created >= from && e.created < to);

/** A target to find backlinks of: a mark id, a note key, a mark, an entry or {b, c, v}. */
function targetOf(target) {
  if (!target) return null;
  if (typeof target === 'string') return /^mk_/.test(target) ? { id: target, mark: target } : { id: target, ...parseRefKey(target) };
  if (typeof target.id === 'string' && /^mk_/.test(target.id)) return { id: target.id, mark: target.id };
  if (target.start && typeof target.start === 'string') return null;
  const { b, c, v = 0 } = target; return b && c ? { id: refKey(b, c, v), b, c, v } : null;
}
function hits(res, t) {
  if (t.mark) return res.kind === 'mark' && res.mark.id === t.mark;
  if (res.kind !== 'verse' || res.b !== t.b || res.c !== t.c) return false;
  if (!t.v) return !res.v;
  if (!res.v) return false;
  const { ec, ev } = rangeEnd(res.c, res.v, res.ve);
  return t.v >= res.v && (ec > res.c || t.v <= ev);
}
/**
 * The notes, highlights and comments whose text references a verse or a mark (“Mentioned in”): [{entry, ref, res}],
 * oldest first, one row per source. A note on the verse itself (or the mark's own comment) is not its own backlink.
 */
export function backlinks(target, list = entries()) {
  const t = targetOf(target); if (!t) return [];
  const out = [];
  for (const e of list) {
    if (!e.text || e.id === t.id) continue;
    for (const r of parseRefs(e.text)) { const res = resolveRef(r); if (hits(res, t)) { out.push({ entry: e, ref: r, res }); break; } }
  }
  return out;
}

// ------------------------------------------------------------ verses in your notes, ready to link (note-links brief §1)
// links.js is optional here too (it imports drawer.js, which loads this module): until it has loaded nothing counts
// as linked yet. links.js and drawer.js pass its test themselves.
let lk = null;
import('./links.js').then(m => { if (m && typeof m.linkedBetween === 'function') lk = m; }, e => console.error('links.js failed to load', e));

const SNIP_MAX = 160;
const ABBR_RX = /(^|[^A-Za-z\d])(?:cf|cp|vv?|vs|chs?|ff|viz|etc|st|mt|dr|mrs?|ms|jr|sr|rev|fr|vol|nb|e\.g|i\.e|[ap]\.m)\./gi; // their full stop ends no sentence
const endKey = o => `${o.b}.${o.c}.${o.v}${o.ve > o.v ? '-' + o.ve : ''}`;
const coversV = (o, b, c, v) => o.b === b && o.c === c && v >= o.v && v <= o.ve;
/** The verse a reference names as a link end {b, c, v, ve} (ve = v for one verse): a range that leaves its chapter gives its first verse, a chapter reference null. */
export function refVerse(r) {
  if (!r || !r.v || !bookOf(r.b)) return null;
  return { b: r.b, c: r.c, v: r.v, ve: r.ve > r.v && r.ve < 1000 ? r.ve : r.v };
}
/** A reference as the note names it: 'Isaiah 53:4–6', 'John 1:4 · “the light of men”'. */
const refText = r => `${refLabel(r.b, r.c, r.v, r.ve)}${r.quote ? ` · “${r.quote}”` : ''}`;
/**
 * The verses a note's text names, once each in the order written, as link ends from the verse b.c.v (drawer.js's
 * "Verses in this note"): [{b, c, v, ve, ref}]. Chapter references and the verse itself are left out.
 */
export function noteVerses(text, b, c, v) {
  const out = [], seen = new Set();
  for (const r of parseRefs(text)) {
    const o = refVerse(r); if (!o || coversV(o, +b, +c, +v)) continue;
    const k = endKey(o); if (seen.has(k)) continue;
    seen.add(k); out.push({ ...o, ref: r });
  }
  return out;
}
/**
 * The sentence of an entry's text that holds the reference `raw`, as plain text with each reference shown as its label,
 * at most `max` characters cut at word boundaries around the reference; a highlight or comment leads with its words.
 * → {text, hit: [start, end] of the reference's label in text, or null}.
 */
function snippetOf(e, raw, max = SNIP_MAX) {
  const labels = []; let mine = -1;
  // references become placeholders first, so that a full stop inside one never ends a sentence
  const src = String(e.text || '').replace(REF_RX, (m, inner) => {
    const r = parseRefText(inner), i = labels.length;
    labels.push(r ? refText(r) : flat(inner.split('|').pop()));
    if (mine < 0 && inner.trim() === raw) mine = i;
    return `${i}`;
  });
  // a full stop that ends no sentence is set aside (\uE002) until the sentence is found: after an abbreviation notes use
  // ('cf. [[Romans 5:8]]', 'e.g. in'), inside a word or a number ('p.m', 'John 3.16') and before a number ('Gen. 1:3')
  const kept = src.replace(ABBR_RX, (m, a) => a + m.slice(a.length).replace(/\./g, '\uE002')).replace(/\.(?=[a-z\d]|\s+\d)/g, '\uE002');
  const parts = kept.match(/[^\n.!?]+[.!?]*/g) || [kept];
  const part = parts.find(p => p.includes(`${mine}`)) || parts[0] || '';
  const s = flat(part.replace(/[*_>#`]/g, '').replace(/^\s*[-+]\s+/, '')).replace(/^[\s”’)\]]+/, '').replace(/\uE002/g, '.');
  let text = '', hit = null, last = 0;
  for (const m of s.matchAll(/(\d+)/g)) {
    text += s.slice(last, m.index);
    const lab = labels[+m[1]] || '';
    if (+m[1] === mine && !hit) hit = [text.length, text.length + lab.length];
    text += lab; last = m.index + m[0].length;
  }
  text += s.slice(last);
  const lead = e.kind !== 'note' && e.phrase ? `“${e.phrase}${flat(e.quote).length > e.phrase.length ? '…' : ''}” · ` : '';
  const room = Math.max(80, max - lead.length);
  if (text.length > room) {
    const [i, j] = hit || [0, 0];
    // about a third of the room before the reference, the rest after it
    let a = Math.max(0, Math.min(i - Math.floor((room - (j - i)) / 3), text.length - room)), z = Math.min(text.length, a + room);
    if (a > 0) { const sp = text.indexOf(' ', a); if (sp >= 0 && sp < i) a = sp + 1; }
    if (z < text.length) { const sp = text.lastIndexOf(' ', z); if (sp > Math.max(j, a)) z = sp; }
    const pre = a > 0 ? '…' : '';
    text = pre + text.slice(a, z).replace(/[\s,;:–—-]+$/, '') + (z < text.length ? '…' : '');
    if (hit) hit = [i - a + pre.length, j - a + pre.length];
  }
  if (hit) hit = [hit[0] + lead.length, hit[1] + lead.length];
  return { text: lead + text, hit };
}
const newest = e => e.updated || e.created || 0;
/**
 * The verses your notes and comments name, as links still to make, for the verse b.c.v or (v = 0) every verse of the
 * chapter: [{here: {b, c, v}, other: {b, c, v, ve}, dir: 'out' | 'in', sources: [{entry, ref, snippet, hit}]}].
 * out: a reference in the note on `here`, or in the comment of a highlight or comment starting there; in: a note or
 * comment on another verse whose text references `here` (as Mentioned in counts it; a reference to a highlight or
 * comment counts as its verse). Chapter references, references to the verse itself and pairs already linked (any link,
 * either way: opts.linked(here, other)) are left out. One suggestion per pair, its sources those on `here` first, then
 * newest; out before in, then by the newest source. In a chapter, an `in` reference to a range sits under the first of
 * its verses there.
 * `hit` is where the reference's label sits in `snippet` (the Mine tab shows it bold).
 */
export function noteLinkSuggestions(b, c, v = 0, { linked = lk ? lk.linkedBetween : null, list = entries() } = {}) {
  b = +b; c = +c; v = +v || 0;
  const by = new Map();
  const isLinked = (h, o) => { try { return typeof linked === 'function' && !!linked(h, o); } catch (e) { console.error(e); return false; } };
  const add = (here, other, dir, e, r) => {
    const hk = endKey({ ...here, ve: here.v }), ok = endKey(other), k = hk < ok ? `${hk}|${ok}` : `${ok}|${hk}`;
    let s = by.get(k);
    if (!s) { if (isLinked(here, other)) return; by.set(k, s = { here, other, dir, sources: [] }); }
    else if (dir === 'out' && s.dir === 'in') Object.assign(s, { here, other, dir }); // the same two verses both ways: from the note on here
    if (s.sources.some(x => x.entry.id === e.id)) return;
    const sn = snippetOf(e, r.raw);
    s.sources.push({ entry: e, ref: r, snippet: sn.text, hit: sn.hit });
  };
  for (const e of list) {
    if (!e.text || !e.v || !bookOf(e.b)) continue; // a chapter note is on no verse: there is nothing to link it from
    const onHere = e.b === b && e.c === c && (!v || e.v === v);
    for (const r of parseRefs(e.text)) {
      const o = refVerse(r); if (!o || coversV(o, e.b, e.c, e.v)) continue;
      if (onHere) add({ b, c, v: e.v }, o, 'out', e, r);
      // in a chapter, a note here that names a verse here is already its pair's 'out' (a range would not merge)
      if (!(onHere && !v) && o.b === b && o.c === c && (v ? coversV(o, b, c, v) : true)) add({ b, c, v: v || o.v }, { b: e.b, c: e.c, v: e.v, ve: e.v }, 'in', e, r);
    }
  }
  const out = [...by.values()];
  // a pair named both ways: the entries on `here` lead (the card names its first source and shows that one's sentence)
  const atHere = (s, e) => e.b === s.here.b && e.c === s.here.c && e.v === s.here.v;
  for (const s of out) s.sources.sort((x, y) => atHere(s, y.entry) - atHere(s, x.entry) || newest(y.entry) - newest(x.entry));
  const t = s => Math.max(...s.sources.map(x => newest(x.entry)));
  return out.sort((x, y) => x.here.v - y.here.v || (x.dir === y.dir ? 0 : x.dir === 'out' ? -1 : 1) || t(y) - t(x));
}

// ------------------------------------------------------------ verse helpers (ported)
/** Does a data row [b, c, v, ve, …] (a topic verse or a cross-reference) include the verse b.c.v? */
export function covers(row, b, c, v) {
  if (row[0] !== b) return false;
  const { ec, ev } = rangeEnd(row[1], row[2], row[3]);
  const at = c * 1e3 + v;
  return at >= row[1] * 1e3 + row[2] && at <= ec * 1e3 + ev;
}
/** How many verses a row spans (multi-chapter ranges use the real chapter lengths). */
function rowSize(row) {
  const [b, c, v, ve] = row, { ec, ev } = rangeEnd(c, v, ve);
  if (ec === c) return ev - v + 1;
  const ch = (bookOf(b) || {}).chapters || [];
  let n = (ch[c - 1] || v) - v + 1;
  for (let k = c + 1; k < ec; k++) n += ch[k - 1] || 25;
  return n + ev;
}
const xrefRows = (xrefs, b, c, v) => { const f = xrefs instanceof Map ? xrefs.get(b) : xrefs && xrefs[b]; return (f && f[`${c}:${v}`]) || []; };
/** An entry's strongest cross-references: [{b, c, v, ve, votes, ref, label}], highest votes first. */
export function topXrefs(e, xrefs, n = 2) {
  return xrefRows(xrefs, e.b, e.c, e.v).slice(0, n).map(([b, c, v, ve, votes]) => ({ b, c, v, ve, votes, ref: `${b}.${c}.${v}`, label: refLabel(b, c, v, ve) }));
}
/** The cross-reference files for every book the entries are in: {b: xrefJson} (a missing file is {}). */
export async function loadXrefsFor(list = entries()) {
  const books = [...new Set(list.map(e => e.b))];
  const files = await Promise.all(books.map(b => data.xref(b).catch(() => ({}))));
  return Object.fromEntries(books.map((b, i) => [b, files[i]]));
}
export const loadTopics = () => data.topics();

// ------------------------------------------------------------ totals and books (ported; stage 2's This month)
/** Totals for a list: {notes, highlights, comments, links, chapters, minutes, days}. read: [{day, b, c, minutes}], lk: links. */
export function totals(list = entries(), read = [], lk = []) {
  return {
    notes: list.filter(e => e.kind === 'note').length, highlights: list.filter(e => e.kind === 'highlight').length, comments: list.filter(e => e.kind === 'comment').length,
    links: lk.length, chapters: new Set(read.map(r => `${r.b}.${r.c}`)).size, minutes: read.reduce((s, r) => s + (+r.minutes || 0), 0), days: new Set(read.map(r => r.day)).size,
  };
}
/** The books studied, most entries first: [{b, name, count, chapters: [c…]}]. */
export function booksFor(list = entries()) {
  const m = new Map();
  for (const e of list) { const x = m.get(e.b) || { b: e.b, name: bookName(e.b), count: 0, chapters: new Set() }; x.count++; x.chapters.add(e.c); m.set(e.b, x); }
  return [...m.values()].map(x => ({ ...x, chapters: [...x.chapters].sort((a, z) => a - z) })).sort((a, z) => z.count - a.count || a.b - z.b);
}

// ------------------------------------------------------------ automatic themes (§1.2, ported from the mock)
// Each entry's verse is matched against topics.json (OpenBible topics, ranked verses). A topic scores when it lists
// the verse itself (strongest), when it lists the verse's own cross-references (weighted by their votes), and, more
// lightly, when it is already strong on an entry this one is linked to by the reader. Broad rows (a whole chapter)
// count for less than single verses. No AI service: it runs offline, in the page.
//
// Topics that name a contested question or a curiosity are never suggested automatically (a reader can still
// choose them by hand): an automatic label must not put words in someone's mouth about their own study.
export const NOT_SUGGESTED = new Set(['Abomination', 'Adultery', 'Babylon', 'Being Taken Advantage of', 'Business', 'Communicating with the Dead',
  'Dating', 'Disabled People', 'Eating Pork', 'Employees', 'End-time People', 'Fighting Back', 'Finances', 'Gold', 'Homelessness', 'Homosexuality',
  'Human Rights', 'Husbands Role', 'Immigration', 'Killing', 'Leviathan', 'Lions', 'Lust', 'Man as Head of Household', 'Mark of the Beast',
  'Marrying a Divorced Woman', 'Medium', 'Money', 'Racism', 'Signs of the End Times', 'Slavery', 'Sodomy', 'Speaking Things Into Existence',
  'Spending Money', 'The Moon', 'The Ocean', 'The Red Moon', 'Trespassing', 'Wife']);

const KEEP_CAPS = new Set(['God', 'God’s', 'Christ', 'Jesus', 'Holy', 'Spirit', 'Word', 'Scripture', 'Babylon', 'Leviathan']);
const RESPELL = { Memorizing: 'Memorising', Honoring: 'Honouring' }; // British spelling for display (the data's names stay)
/** A topic's display label in sentence case: 'Being Born Again' → 'Being born again', 'Gods Love' → 'God’s love'. */
export function themeLabel(topic) {
  const raw = typeof topic === 'string' ? topic : (topic.label || topic.name);
  return String(raw || '').replace(/'/g, '’').replace(/\bGods\b/g, 'God’s').split(' ')
    .map((w, i) => { w = RESPELL[w] || w; return i === 0 || KEEP_CAPS.has(w) ? w : w.toLowerCase(); }).join(' ');
}
/** 'New birth' for the tag 'new-birth'. */
export const tagLabel = tag => { const s = String(tag).replace(/[-_]+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
/** The empty choices object: {accepted: [name], renamed: {name: label}, merged: {name: into}, removed: [name]}. */
export const emptyChoices = () => ({ accepted: [], renamed: {}, merged: {}, removed: [] });

const W = { verse: 3, xref: 1.2, xrefCap: 2, linked: .35, linkedCap: 1, strongVerse: .6, minNote: 1, xrefOnly: 2, xrefLinked: 1.5, candidates: 5, perNote: 3, month: .15, xrefRows: 25, merge: .6, suggest: 60 };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const andList = xs => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
const byCreated = (a, z) => a.created - z.created;
/** 'John 1, 3 and 8; Genesis 1; Psalm 119 and 2 other books': the books with the most entries first, three named at most. */
function chaptersPhrase(list) {
  const books = new Map();
  for (const n of list) { const e = books.get(n.b) || { b: n.b, n: 0, cs: new Set() }; e.n++; e.cs.add(n.c); books.set(n.b, e); }
  const parts = [...books.values()].sort((a, z) => z.n - a.n || a.b - z.b)
    .map(e => `${e.b === 19 ? (e.cs.size > 1 ? 'Psalms' : 'Psalm') : bookName(e.b)} ${andList([...e.cs].sort((x, y) => x - y).map(String))}`);
  return parts.slice(0, 3).join('; ') + (parts.length > 3 ? ` and ${plural(parts.length - 3, 'other book')}` : '');
}
/** '4 notes, 3 highlights and 1 comment' */
function kindsPhrase(list) {
  const k = { note: 0, highlight: 0, comment: 0 }; for (const n of list) k[n.kind]++;
  return andList([k.note && plural(k.note, 'note'), k.highlight && plural(k.highlight, 'highlight'), k.comment && plural(k.comment, 'comment')].filter(Boolean));
}
const jaccard = (a, b) => { const s = new Set(a); const both = b.filter(x => s.has(x)).length; return both / (a.length + b.length - both); };

/**
 * Suggested themes. Returns
 *   {byNote: {id: [{name, label, score, verse: bool, xrefs: ['1 Peter 1:23', …], linked: [ids], why, weak: bool}]},
 *    overall: [{name, label, count, score, noteIds, books: [b], also: [folded topic names], suggested, why, detail, tag?}],
 *    yours: [{name: '#light', tag, label: 'Light', count, noteIds, books, suggest: [ids], source: 'tag', why, topic?}],
 *    topics: Map(name → topic)}
 * byNote: each entry's top themes (3 at most). A theme counts for an entry when its score is at least W.minNote and
 * it is corroborated: the verse is listed strongly, or listed and reached another way, or reached through two
 * cross-references (score W.xrefOnly or more), or through a cross-reference and an entry the reader linked it to
 * (W.xrefLinked or more). Each entry's five best candidates are then re-ranked by how often they recur in the list.
 * An entry with no corroborated theme keeps its one best lead, marked weak: true.
 * overall: themes ranked by how many entries carry them (two or more); a theme that shares most of its entries with
 * a stronger one is folded into it ('The meaning of life' into 'Life'). why: '6 notes on John 1, 3 and 8'.
 * yours: the reader's own tags as themes, with `suggest`: untagged entries strongly cross-referenced with a tagged one.
 * A suggested theme and a tag that share half their entries or more name each other (overall.tag, yours.topic).
 * opts: {choices} applies the reader's accept / rename / merge / remove (state.notes.themes); {limit} caps overall (default 8).
 */
export function themesFor(list, topics, xrefs, opts = {}) {
  const choices = opts.choices || {}, removed = new Set(choices.removed || []), merged = choices.merged || {}, renamed = choices.renamed || {};
  const accepted = new Set(choices.accepted || []), byName = new Map(topics.map(t => [t.name, t]));
  const usable = topics.filter(t => !NOT_SUGGESTED.has(t.name) && !removed.has(t.name));
  const top = new Map(usable.map(t => [t.name, Math.max(1, ...t.verses.map(r => r[4] || 0))]));
  const label = name => renamed[name] || themeLabel(byName.get(name) || name);
  // how strongly each topic lists a verse: its best row, single verses above broad ranges, well-voted above few votes
  const memo = new Map();
  const hitsAt = (b, c, v) => {
    const k = `${b}.${c}.${v}`; if (memo.has(k)) return memo.get(k);
    const out = new Map();
    for (const t of usable) {
      let best = 0;
      for (const r of t.verses) if (covers(r, b, c, v)) best = Math.max(best, (.4 + .6 * Math.sqrt((r[4] || 0) / top.get(t.name))) / Math.sqrt(rowSize(r)));
      if (best) out.set(t.name, best);
    }
    memo.set(k, out); return out;
  };
  // 1. each entry on its own: the verse, then its cross-references (capped, so a topic that lists the verse leads)
  const own = new Map();
  for (const n of list) {
    const s = new Map(), entry = name => { if (!s.has(name)) s.set(name, { verse: 0, xref: 0, xrefs: [] }); return s.get(name); };
    for (const [name, w] of hitsAt(n.b, n.c, n.v)) entry(name).verse = w;
    const rows = xrefRows(xrefs, n.b, n.c, n.v).slice(0, W.xrefRows), max = Math.max(1, ...rows.map(r => r[4] || 0));
    for (const r of rows) for (const [name, w] of hitsAt(r[0], r[1], r[2])) {
      const e = entry(name); e.xref += W.xref * Math.sqrt((r[4] || 0) / max) * w; e.xrefs.push(refLabel(r[0], r[1], r[2], r[3]));
    }
    for (const e of s.values()) e.base = W.verse * e.verse + Math.min(W.xrefCap, e.xref);
    own.set(n.id, s);
  }
  // 2. the reader's own references lend a little weight, both ways: the topics the linked entry's own verse is listed under
  const ids = new Set(list.map(n => n.id)), lent = new Map(list.map(n => [n.id, new Map()]));
  for (const n of list) for (const to of n.refs) {
    if (!ids.has(to)) continue;
    for (const [a, b] of [[n.id, to], [to, n.id]]) for (const [name, e] of own.get(b)) {
      if (!e.verse) continue;
      const m = lent.get(a), cur = m.get(name) || { score: 0, from: [] };
      cur.score += W.linked * W.verse * e.verse; cur.from.push(b); m.set(name, cur);
    }
  }
  const labelOf = id => (list.find(x => x.id === id) || {}).label;
  const byNote = {};
  for (const n of list) {
    const mine = own.get(n.id), lend = lent.get(n.id), rows = [], weak = [];
    for (const name of new Set([...mine.keys(), ...lend.keys()])) {
      const e = mine.get(name) || { verse: 0, xrefs: [], base: 0 }, l = lend.get(name) || { score: 0, from: [] };
      const xs = [...new Set(e.xrefs)], ln = [...new Set(l.from)], score = e.base + Math.min(W.linkedCap, l.score);
      const ok = e.verse ? e.verse >= W.strongVerse || xs.length > 0 || ln.length > 0 : (xs.length >= 2 && score >= W.xrefOnly) || (xs.length > 0 && ln.length > 0 && score >= W.xrefLinked);
      if (score < W.minNote) continue;
      const why = e.verse ? `OpenBible lists ${n.label} under this topic`
        : `Through ${[xs.length && `${xs.length > 1 ? 'its cross-references' : 'its cross-reference'} ${andList(xs.slice(0, 2))}`,
          ln.length && `your ${ln.length > 1 ? 'notes' : 'note'} on ${andList(ln.slice(0, 2).map(labelOf))}`].filter(Boolean).join(', and ')}`;
      (ok ? rows : weak).push({ name, label: label(name), score: +score.toFixed(2), verse: !!e.verse, xrefs: xs, linked: ln, why, weak: !ok });
    }
    // an entry with nothing corroborated keeps its single best lead, marked weak (shown more quietly, or as a question)
    byNote[n.id] = rows.length ? rows.sort((a, z) => z.score - a.score).slice(0, W.candidates) : weak.sort((a, z) => z.score - a.score).slice(0, 1);
  }
  // the list re-ranks each entry's candidates: a theme that recurs across the entries is preferred to a one-off
  const recur = new Map();
  for (const id in byNote) for (const t of byNote[id]) if (!t.weak) recur.set(t.name, (recur.get(t.name) || 0) + 1);
  const adj = t => t.score * (1 + W.month * Math.min(4, (recur.get(t.name) || 1) - 1));
  for (const id in byNote) byNote[id] = byNote[id].sort((a, z) => adj(z) - adj(a)).slice(0, W.perNote);
  // 3. overall: entries per theme; a theme that mostly shares its entries with a stronger one folds into it
  const agg = new Map();
  for (const n of list) for (const t of byNote[n.id]) {
    if (t.weak) continue;
    const name = merged[t.name] || t.name, e = agg.get(name) || { name, score: 0, weight: 0, noteIds: [] };
    if (!e.noteIds.includes(n.id)) { e.noteIds.push(n.id); e.score += t.score; e.weight += t.verse ? 1 : .5; } agg.set(name, e);
  }
  // ranked by entries, one whose own verse is listed counting double one reached only through cross-references
  const kept = [];
  for (const t of [...agg.values()].sort((a, z) => z.weight - a.weight || z.score - a.score)) {
    const into = kept.find(k => jaccard(k.noteIds, t.noteIds) >= W.merge);
    if (into) {
      // the plainer name leads when the two are nearly the same set ('Life' over 'The meaning of life')
      if (label(t.name).length < label(into.name).length && t.noteIds.length >= .8 * into.noteIds.length) { into.also.push(into.name); into.name = t.name; }
      else into.also.push(t.name);
      for (const id of t.noteIds) if (!into.noteIds.includes(id)) into.noteIds.push(id);
      into.weight = Math.max(into.weight, t.weight);
    }
    else kept.push({ ...t, also: Object.keys(merged).filter(k => merged[k] === t.name) });
  }
  const overall = kept.filter(t => t.noteIds.length >= 2).slice(0, opts.limit || 8).map(t => {
    const ns = t.noteIds.map(id => list.find(n => n.id === id)).sort(byCreated);
    return {
      name: t.name, label: label(t.name), count: ns.length, score: +t.score.toFixed(2), noteIds: ns.map(n => n.id),
      books: [...new Set(ns.map(n => n.b))], also: t.also, suggested: !accepted.has(t.name),
      why: `${plural(ns.length, 'note')} on ${chaptersPhrase(ns)}`, detail: kindsPhrase(ns),
    };
  });
  // a folded theme shows on its entries under the theme it went into
  const fold = new Map(overall.flatMap(t => t.also.map(a => [a, t])));
  for (const id in byNote) {
    const seen = new Set();
    byNote[id] = byNote[id].map(t => fold.has(t.name) ? { ...t, name: fold.get(t.name).name, label: fold.get(t.name).label } : t)
      .filter(t => !seen.has(t.name) && seen.add(t.name));
  }
  // 4. the reader's own tags
  const tagged = new Map();
  for (const n of list) for (const tag of n.tags || []) { if (!tagged.has(tag)) tagged.set(tag, []); tagged.get(tag).push(n); }
  const yours = [...tagged].sort((a, z) => z[1].length - a[1].length || a[0].localeCompare(z[0])).map(([tag, ns]) => {
    ns = [...ns].sort(byCreated);
    const suggest = xrefs ? list.filter(n => !ns.includes(n) && ns.some(o => xrefLink(xrefs, n, o) >= W.suggest)).map(n => n.id) : [];
    return { name: '#' + tag, tag, label: renamed['#' + tag] || tagLabel(tag), count: ns.length, noteIds: ns.map(n => n.id), books: [...new Set(ns.map(n => n.b))], suggest, source: 'tag', why: `${plural(ns.length, 'note')} on ${chaptersPhrase(ns)}` };
  });
  // a suggested theme and one of the reader's tags that share most of their entries point at each other
  for (const y of yours) {
    const t = overall.find(o => !o.tag && jaccard(o.noteIds, y.noteIds) >= .5);
    if (t) { t.tag = y.name; y.topic = t.name; }
  }
  return { byNote, overall, yours, topics: byName };
}

// ------------------------------------------------------------ threads and connections (§1.3, ported)
/** Direct cross-reference strength between two verses (votes either way, 0 when none). */
function xrefLink(xrefs, a, b) {
  const ab = xrefRows(xrefs, a.b, a.c, a.v).find(r => covers(r, b.b, b.c, b.v));
  const ba = xrefRows(xrefs, b.b, b.c, b.v).find(r => covers(r, a.b, a.c, a.v));
  return Math.max(ab ? ab[4] : 0, ba ? ba[4] : 0);
}
/** The strongest cross-reference both verses point to: {votes (the weaker side), ref, label} or null. */
function sharedXref(xrefs, a, b) {
  const ra = new Map(xrefRows(xrefs, a.b, a.c, a.v).map(r => [`${r[0]}.${r[1]}.${r[2]}`, r]));
  let best = null;
  for (const r of xrefRows(xrefs, b.b, b.c, b.v)) {
    const k = `${r[0]}.${r[1]}.${r[2]}`, o = ra.get(k); if (!o || k === a.ref || k === b.ref) continue;
    const votes = Math.min(o[4], r[4]); if (!best || votes > best.votes) best = { votes, ref: k, label: refLabel(r[0], r[1], r[2], r[3]) };
  }
  return best;
}
const ATTACH_MIN = 60; // votes: how strong a cross-reference must be to draw a loose entry into a thread

/**
 * Connected chains of entries. A thread is built from the reader's own references (three entries or more); an entry
 * in no thread joins the one it is most strongly cross-referenced with (a direct cross-reference, or a
 * cross-reference both verses share, of ATTACH_MIN votes or more). Threads never merge through cross-references.
 * Returns, longest first:
 *   [{id, noteIds (in the order studied), chain: [ids joined by your references, in the order studied],
 *     edges: [{from, to, kind: 'ref' | 'xref' | 'shared', votes?, via?, viaLabel?}], start, end (ms), days, books: [b],
 *     label: 'John 1:4 → Genesis 1:3 → …'}]
 * Without xrefs, threads come from your references only.
 */
export function threads(list = entries(), xrefs = null) {
  const ids = new Set(list.map(n => n.id)), get = id => list.find(n => n.id === id);
  const parent = new Map(list.map(n => [n.id, n.id]));
  const find = x => parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x));
  const edges = [];
  for (const n of list) for (const to of n.refs) if (ids.has(to)) { parent.set(find(n.id), find(to)); edges.push({ from: n.id, to, kind: 'ref' }); }
  const groups = new Map();
  for (const n of list) { const r = find(n.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n.id); }
  const out = [...groups.values()].filter(g => g.length >= 3).map(g => ({ noteIds: g, chain: [...g], edges: edges.filter(e => g.includes(e.from)) }));
  if (xrefs) {
    const inThread = new Set(out.flatMap(t => t.noteIds));
    for (const n of list) {
      if (inThread.has(n.id)) continue;
      let best = null;
      for (const t of out) for (const id of t.chain) {
        const o = get(id), d = xrefLink(xrefs, n, o), s = d >= ATTACH_MIN ? null : sharedXref(xrefs, n, o);
        const e = d >= ATTACH_MIN ? { from: n.id, to: id, kind: 'xref', votes: d } : s && s.votes >= ATTACH_MIN ? { from: n.id, to: id, kind: 'shared', votes: s.votes, via: s.ref, viaLabel: s.label } : null;
        if (e && (!best || e.votes > best.e.votes)) best = { t, e };
      }
      if (best) { best.t.noteIds.push(n.id); best.t.edges.push(best.e); }
    }
  }
  return out.map((t, i) => {
    const ns = t.noteIds.map(get).sort(byCreated), chain = t.chain.map(get).sort(byCreated);
    const start = ns[0].created, end = ns[ns.length - 1].created;
    return {
      id: `th${i + 1}`, noteIds: ns.map(n => n.id), chain: chain.map(n => n.id), edges: t.edges, start, end,
      days: Math.round((end - start) / 864e5), books: [...new Set(ns.map(n => n.b))], label: chain.map(n => n.label).join(' → '),
    };
  }).sort((a, z) => z.chain.length - a.chain.length || z.noteIds.length - a.noteIds.length || z.end - a.end)
    .map((t, i) => ({ ...t, id: `th${i + 1}` }));
}

/**
 * Every edge between entries: your references, cross-references between the two verses (votes ≥ minVotes) and
 * shared themes (from themesFor's byNote). [{a, b, kind: 'ref' | 'xref' | 'theme', votes?, theme?, label?}]
 * A pair can have one edge of each kind; ref edges run a → b as written (a mentions b).
 */
export function connections(list = entries(), xrefs = null, themes = null, { minVotes = 10 } = {}) {
  const out = [];
  for (const n of list) for (const to of n.refs) if (list.some(x => x.id === to)) out.push({ a: n.id, b: to, kind: 'ref' });
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (xrefs) { const votes = xrefLink(xrefs, a, b); if (votes >= minVotes) out.push({ a: a.id, b: b.id, kind: 'xref', votes }); }
    if (themes) {
      const ta = (themes.byNote[a.id] || []).map(t => t.name), shared = (themes.byNote[b.id] || []).find(t => ta.includes(t.name));
      if (shared) out.push({ a: a.id, b: b.id, kind: 'theme', theme: shared.name, label: shared.label });
    }
  }
  return out;
}

/**
 * Everything at once, for a view's boot: {entries, topics, xrefs: {b: json}, themes (themesFor with the reader's
 * choices), threads, connections}. list: the entries to study (default: all); choices: default state.notes.themes.
 */
export async function loadStudy({ list = entries(), choices = state.notes.themes } = {}) {
  const [topics, xrefs] = await Promise.all([loadTopics(), loadXrefsFor(list)]);
  const themes = themesFor(list, topics, xrefs, { choices });
  return { entries: list, topics, xrefs, themes, threads: threads(list, xrefs), connections: connections(list, xrefs, themes) };
}

// ------------------------------------------------------------ text helpers (ported)
/** Plain text of a note (markdown and link brackets removed), clipped: for previews and aria labels. */
export const plainText = (text, max = 140) => {
  const s = String(text || '').replace(/\[\[([^[\]]+)\]\]/g, '$1').replace(/[*_>#`]/g, '').replace(/^- /gm, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : s;
};
/** Verse text with the marked words wrapped: <mark class="hl" data-color="yellow">…</mark> (a comment: data-color=""). */
export function verseHtml(text, quote, color = '') {
  const i = quote ? text.indexOf(quote) : -1;
  if (i < 0) return esc(text);
  return `${esc(text.slice(0, i))}<mark class="hl" data-color="${esc(color)}">${esc(quote)}</mark>${esc(text.slice(i + quote.length))}`;
}
/** An entry's verse with its words marked as every page shows them: a plain note leaves the text unmarked. */
export const markHtml = (e, text, words = e.quote) => (e.kind !== 'note' ? verseHtml(text, words, e.color) : esc(text));
/** The sentence of a note that holds a reference, as plain text. */
function sentenceAround(text, raw) {
  const t = String(text || ''), parts = t.match(/[^\n.!?]+[.!?]*/g) || [t];
  return plainText((parts.find(p => p.includes(`[[${raw}]]`)) || t).replace(/^[\s”’)\]]+/, ''), 160);
}

// ------------------------------------------------------------ rendering: the chip, Mentioned in
const dotHtml = e => (e.kind === 'note' ? `<i class="hdot${e.color ? ' ' + esc(e.color) : ''}" aria-hidden="true"></i>`
  : `<i class="hdot mkdot${e.color ? '' : ' none'}" data-mk-color="${esc(e.color)}" aria-hidden="true"></i>`);
/**
 * A reference to a highlight or comment as a chip (drawer.js renderMd): the colour dot, the reference and the quoted
 * words; '' when the text names no quoted words (a plain verse link). data-ref opens the verse, data-mark the mark.
 */
export function refChipHtml(raw) {
  const r = parseRefText(raw); if (!r || !r.quote) return '';
  const res = resolveRef(r), m = res.mark, target = String(raw).split('|')[0].split(' · ')[0].trim();
  const dot = m ? `<i class="hdot mkdot${m.color ? '' : ' none'}" data-mk-color="${esc(m.color)}" aria-hidden="true"></i>` : '';
  return `<a class="vlink ref-chip" data-ref="${esc(target)}"${m ? ` data-mark="${esc(m.id)}"` : ''} role="link" tabindex="0">${dot}${esc(refLabel(r.b, r.c, r.v, r.ve))}<q>${esc(r.quote)}</q></a>`;
}
function mentionRow({ entry: e, ref }) {
  const go = e.kind === 'note' ? `data-go="${esc(e.key)}"` : `data-mk-go="${esc(e.id)}"`;
  return `<li><button class="cell" type="button" ${go}>${dotHtml(e)}<span class="cell-body"><span class="cell-title">${esc(e.label)}${e.phrase ? ` · “${esc(e.phrase)}”` : ''}</span><span class="cell-sub"><span class="sr">${KIND[e.kind]}: </span>${esc(sentenceAround(e.text, ref.raw))}</span></span>${icon('chev-right', 'chev')}</button></li>`;
}
/**
 * “Mentioned in” under the note editor: the backlinks of the verse (or chapter, v = 0) and of each mark starting on it,
 * the sentence that holds the reference and a link to its note (data-go) or its words (data-mk-go). '' when none.
 */
export function mentionsHtml(b, c, v) {
  const list = entries(), groups = [];
  const vb = backlinks({ b, c, v }, list); if (vb.length) groups.push({ label: refLabel(b, c, v), rows: vb });
  if (v && mrk) for (const m of mrk.marksFor(b, c, v)) {
    if (vOf(m.start) !== v) continue;
    const mb = backlinks(m.id, list); if (mb.length) groups.push({ label: `“${phraseOf(m.quote)}”`, rows: mb });
  }
  if (!groups.length) return '';
  const n = groups.reduce((s, g) => s + g.rows.length, 0);
  return `<section class="mentions" id="mentions" aria-labelledby="mentions-h"><div class="lh"><h3 id="mentions-h">Mentioned in</h3><span>${n}</span></div>`
    + groups.map(g => `${groups.length > 1 ? `<p class="mention-of">${esc(g.label)}</p>` : ''}<ul class="group">${g.rows.map(mentionRow).join('')}</ul>`).join('') + '</section>';
}

// ------------------------------------------------------------ the [[ picker (§1.1)
const QUERY_MAX = 40, PICK_N = 6, VERSES_N = 3;
let pickSeq = 0;
function snippet(text, q) {
  const t = String(text), i = q ? t.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return esc(t.length > 120 ? t.slice(0, 118) + '…' : t);
  const a = Math.max(0, i - 40), b = Math.min(t.length, i + q.length + 70);
  return `${a ? '…' : ''}${esc(t.slice(a, i))}<mark>${esc(t.slice(i, i + q.length))}</mark>${esc(t.slice(i + q.length, b))}${b < t.length ? '…' : ''}`;
}
/** Where the caret's line ends inside a textarea: {y (px from its top, scrolled), lineH}, measured on a mirror. */
function caretLine(ta) {
  const cs = getComputedStyle(ta), d = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'borderTopWidth', 'borderBottomWidth', 'boxSizing', 'wordBreak']) d.style[p] = cs[p];
  Object.assign(d.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '0', width: ta.clientWidth + 'px', height: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', pointerEvents: 'none' });
  d.textContent = ta.value.slice(0, ta.selectionEnd);
  const s = document.createElement('span'); s.textContent = '​'; d.appendChild(s);
  ta.parentNode.appendChild(d);
  const r = { y: s.offsetTop + s.offsetHeight - ta.scrollTop, lineH: s.offsetHeight || parseFloat(cs.lineHeight) || 20 };
  d.remove();
  return r;
}
/** Entries that match the query, best first: by reference, by the words marked, by the note, by #tag (no query: this chapter, then recent). */
function pickEntries(q, { self, b, c }) {
  const ql = q.trim().toLowerCase(), r = ql && /\d/.test(ql) ? parseReference(ql) : null, scored = [];
  for (const e of entries()) {
    if (e.id === self) continue;
    const here = e.b === b && e.c === c;
    let s = 0;
    if (!ql) s = (here ? 1e13 : 0) + e.updated;
    else {
      const lab = e.label.toLowerCase();
      if (lab.startsWith(ql) || (r && e.b === r.b && e.c === r.c && (!r.v || e.v === r.v))) s = 10;
      else if (chipLabel(e).toLowerCase().includes(ql)) s = 7;
      else if (e.quote.toLowerCase().includes(ql)) s = 5;
      else if (e.tags.some(t => t.toLowerCase().startsWith(ql.replace(/^#/, '')))) s = 4;
      else if (plainText(e.text, 2000).toLowerCase().includes(ql)) s = 3;
      if (s && here) s += .5;
    }
    if (s) scored.push({ e, s });
  }
  return scored.sort((a, z) => z.s - a.s || (ql ? a.e.b * 1e6 + a.e.c * 1e3 + a.e.v - (z.e.b * 1e6 + z.e.c * 1e3 + z.e.v) : z.e.updated - a.e.updated)).slice(0, PICK_N)
    .map(x => ({ kind: 'entry', e: x.e, label: chipLabel(x.e) }));
}
/**
 * The [[ picker on a textarea (the Notes tab editor and the mark comment card). Typing [[ opens a list of your
 * notes, highlights and comments (this chapter's first, then recent ones; filtered as you type by reference, words,
 * note or #tag) and the verse a typed reference names; ↑ ↓ choose, Return (or Tab) inserts the reference, Esc
 * closes (typing on keeps it closed until the next [[). A row can be tapped. Inserting fires 'input' on the textarea,
 * so the editor's own save runs. opts: {self: the entry being edited (its key or mark id), b, c: the chapter}.
 * Returns {close(), open: () => bool}.
 */
export function attachPicker(ta, { self = null, b = state.book, c = state.chapter } = {}) {
  if (!ta || ta.dataset.refPick) return null;
  const host = ta.parentElement, id = `ref-pick-${++pickSeq}`;
  host.classList.add('ref-host');
  const pk = document.createElement('div');
  pk.className = 'ref-pick'; pk.id = id; pk.hidden = true; pk.setAttribute('role', 'listbox'); pk.setAttribute('aria-label', 'Link a note or a verse');
  host.appendChild(pk);
  ta.dataset.refPick = id; ta.setAttribute('aria-autocomplete', 'list'); ta.setAttribute('aria-controls', id); ta.setAttribute('aria-haspopup', 'listbox');
  let pick = null, closedAt = -1, seq = 0;

  const close = () => {
    pick = null; pk.hidden = true; pk.innerHTML = ''; pk.style.top = pk.style.bottom = pk.style.maxHeight = '';
    ta.removeAttribute('aria-activedescendant');
  };
  const paint = () => {
    const p = pick; if (!p) return;
    const q = p.q.trim(), items = p.items;
    if (p.active >= items.length) p.active = Math.max(0, items.length - 1);
    const opt = (x, i) => {
      const on = i === p.active, head = `<div class="ref-opt" role="option" id="${id}-${i}" data-i="${i}" aria-selected="${on}">`;
      if (x.kind === 'entry') return `${head}${dotHtml(x.e)}<span class="ref-opt-main"><b>${esc(x.e.label)}</b>${x.e.phrase ? ` · <q>${esc(x.e.phrase)}</q>` : ''}<small>${snippet(x.e.text ? plainText(x.e.text, 400) : x.e.quote, q)}</small></span><span class="k">${KIND[x.e.kind]}</span></div>`;
      return `${head}${icon('book')}<span class="ref-opt-main"><b>${esc(x.label)}</b>${x.text ? `<small>${esc(x.text)}</small>` : ''}</span><span class="k">${esc(trInfo(previewTr()).abbr)}</span></div>`;
    };
    const verses = items.filter(x => x.kind === 'verse'), notes = items.filter(x => x.kind === 'entry');
    let k = 0;
    const group = (label, xs) => `<div role="group" aria-label="${esc(label)}"><div class="ref-pick-h" aria-hidden="true">${esc(label)}</div>${xs.map(x => opt(x, k++)).join('')}</div>`;
    pk.innerHTML = (verses.length ? group('Verse', verses) : '')
      + (notes.length ? group(q ? 'Your notes' : 'Your notes, this chapter first', notes) : (!verses.length ? `<div class="ref-pick-none">${q ? 'No notes match. Type a reference like John 3:16 to link a verse.' : 'No notes yet. Type a reference like John 3:16 to link a verse.'}</div>` : ''))
      + '<div class="ref-pick-foot" aria-hidden="true">↑ ↓ to choose · Return to link · Esc to close</div>';
    // just under the line being typed; above it when there is no room below in what scrolls the editor (the study
    // panel's body, else the viewport), and only when the whole list then fits above; else shortened to the room
    // there is and scrolled into view
    const { y, lineH } = caretLine(ta), top = ta.offsetTop + y + 6;
    pk.style.bottom = pk.style.maxHeight = ''; pk.style.top = top + 'px'; pk.hidden = false;
    const sc = ta.closest('#drawer-body'), sb = sc ? sc.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    const r = pk.getBoundingClientRect();
    if (r.bottom > sb.bottom - 8) {
      if (r.top - (pk.offsetHeight + lineH + 12) > sb.top + 8) { pk.style.top = ''; pk.style.bottom = (host.offsetHeight - (ta.offsetTop + y - lineH) + 6) + 'px'; }
      else { pk.style.maxHeight = Math.max(120, sb.bottom - r.top - 8) + 'px'; pk.scrollIntoView({ block: 'nearest' }); }
    }
    if (items.length) ta.setAttribute('aria-activedescendant', `${id}-${p.active}`); else ta.removeAttribute('aria-activedescendant');
    const a = pk.querySelector(`#${id}-${p.active}`);
    if (a) { const at = a.offsetTop, ab = at + a.offsetHeight; if (at < pk.scrollTop) pk.scrollTop = at - 6; else if (ab > pk.scrollTop + pk.clientHeight) pk.scrollTop = ab - pk.clientHeight + 6; }
  };
  const fill = async q => {
    const my = ++seq, ql = q.trim(), r = ql && /\d/.test(ql) ? parseReference(ql) : null;
    const notes = pickEntries(q, { self, b, c });
    let verses = r ? (r.v ? [{ kind: 'verse', b: r.b, c: r.c, v: r.v, ve: r.vend, label: refLabel(r.b, r.c, r.v, r.vend), text: '' }]
      : [1, 2, 3].slice(0, VERSES_N).filter(v => v <= (bookOf(r.b).chapters[r.c - 1] || 0)).map(v => ({ kind: 'verse', b: r.b, c: r.c, v, ve: 0, label: refLabel(r.b, r.c, v), text: '' }))) : [];
    pick.items = [...verses, ...notes]; paint();
    if (!verses.length) return;
    const texts = await Promise.all(verses.map(x => previewText(x.b, x.c, x.v, x.ve).then(t => (t && t.text) || '', () => '')));
    if (my !== seq || !pick) return;
    verses = verses.map((x, i) => ({ ...x, text: plainText(texts[i], 160) }));
    pick.items = [...verses, ...notes]; paint();
  };
  /** Is the caret just after an open [[ ? Then the list shows what matches the words typed since. */
  const sense = () => {
    const caret = ta.selectionEnd, before = ta.value.slice(0, caret), i = before.lastIndexOf('[[');
    let q = null;
    if (i >= 0 && ta.selectionStart === caret) { const s = before.slice(i + 2); if (!/[[\]\n]/.test(s) && s.length <= QUERY_MAX) q = s; }
    if (q === null || i === closedAt) { if (pick) close(); return; }
    pick = { start: i, q, items: pick && pick.start === i ? pick.items : [], active: pick && pick.start === i ? pick.active : 0 };
    fill(q);
  };
  const insert = i => {
    const p = pick, x = p && p.items[i]; if (!x) return;
    const text = ta.value, end = ta.selectionEnd;
    let after = text.slice(end); if (after.startsWith(']]')) after = after.slice(2);
    const ins = `[[${x.label}]]`, sp = after && /^[\s.,;:)!?]/.test(after) ? '' : ' ';
    ta.value = text.slice(0, p.start) + ins + sp + after;
    const pos = p.start + ins.length + sp.length;
    ta.setSelectionRange(pos, pos);
    closedAt = -1; close();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus({ preventScroll: true });
  };
  ta.addEventListener('input', sense);
  ta.addEventListener('keyup', e => { if (/^(Arrow(Left|Right)|Home|End)$/.test(e.key)) sense(); });
  ta.addEventListener('click', sense);
  ta.addEventListener('keydown', e => {
    if (!pick || pk.hidden || e.isComposing || e.keyCode === 229) return;
    const n = pick.items.length;
    if (e.key === 'ArrowDown' && n) { pick.active = (pick.active + 1) % n; paint(); }
    else if (e.key === 'ArrowUp' && n) { pick.active = (pick.active - 1 + n) % n; paint(); }
    else if ((e.key === 'Enter' || e.key === 'Tab') && n && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) insert(pick.active);
    else if (e.key === 'Escape') { closedAt = pick.start; close(); }
    else return;
    e.preventDefault(); e.stopPropagation();
  });
  // a press keeps the editor's focus; the row is taken on click, which a scroll gesture over the list never fires
  pk.addEventListener('pointerdown', e => { if (e.target.closest('.ref-opt')) e.preventDefault(); });
  pk.addEventListener('click', e => { const o = e.target.closest('.ref-opt'); if (o) insert(+o.dataset.i); });
  ta.addEventListener('focusout', e => { if (!(e.relatedTarget && pk.contains(e.relatedTarget))) setTimeout(() => { if (document.activeElement !== ta) close(); }, 120); });
  return { close, open: () => !!pick && !pk.hidden };
}
