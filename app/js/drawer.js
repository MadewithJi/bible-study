// The study sheet: Links, Context, Original, Notes, Video and Search.
// main.js owns the open/closed state machine (syncDrawer); this module renders the header fields,
// the tab strip and the body, and handles every interaction inside the sheet body.
import { state, data, bookOf, refKey, refLabel, rangeEnd, noteFor, touchNote, scheduleSave, yearLabel, esc, isHebrewBook, isDivine, previewText, previewTr, packedRef, smart, plural, clip, initials, testamentName, trInfo, fmtDur, layoutMode, scrollBehavior, isAramaicWord, aramaicVerses, morphNoLang } from './store.js';
import { decodeMorph, wordTypeLabel, isVariantWord, variantShort } from './morph.js';
import { icon } from './icons.js';
import * as viz from './viz.js';
import { placeLinks } from './maps.js';
import * as S from './store.js';

let A;
export function init(actions) { A = actions; }

// library.js and art.js are optional (main.js loads them guarded too): imported at run time so that a missing
// or broken one can never stop this module, and with it the whole app, from loading. Same module instances.
const optional = (p, name) => p.then(m => m, e => { console.error(`${name} failed to load`, e); return null; });
let library = null, art = null;
optional(import('./library.js'), 'library.js').then(m => { library = m; });
const artModP = optional(import('./art.js'), 'art.js').then(m => (art = m));
const libFn = name => (library && typeof library[name] === 'function' ? library[name] : null);
// links.js (My links) likewise: it imports renderMd from this module, so a static import back would make it required.
// The Mine tab shows once it has loaded (main.js's mineReady() then lets A.select/openTab open it).
let links = null;
optional(import('./links.js'), 'links.js').then(m => {
  if (!m || typeof m.renderMine !== 'function') return;
  links = m;
  const t = document.getElementById('tab-mine'); if (t) t.hidden = false;
});
// marks.js (highlights and comments, annotations-brief §3.4) likewise: the Notes tab lists them once it has loaded
let mrk = null;
optional(import('./marks.js'), 'marks.js').then(m => { if (!m || typeof m.marksFor !== 'function') return; mrk = m; refreshNoteMarks(); });
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const bodyEl = () => document.getElementById('drawer-body');
const HL = ['yellow', 'green', 'blue', 'pink', 'orange'];
const SKELETON = '<div class="skeleton" aria-busy="true"><i style="width:92%"></i><i style="width:70%"></i><i style="width:84%"></i><i style="width:56%"></i></div>';
const IN_VERSE = '<span class="in-verse">This verse</span>';

let searchState = { title: '', html: '', has: false };
let origFocus = null;                 // {word:i} | {strong:'G26', word?:i, aram?:bool}
let mdMode = 'preview', mdKey = null; // notes editor mode: UI state only, never stored on the note
let renderSeq = 0;

export function setOrigFocus(f) { origFocus = f; }
export function setSearchResults(title, html) {
  searchState = { title, html, has: true };
  const t = document.getElementById('tab-search'); if (t) t.hidden = false;
}

const delay = ms => new Promise(r => setTimeout(r, ms));
/** art.js markup ('' when it is missing, not loaded or throws). */
const artHtml = (name, ...a) => { try { const h = art && typeof art[name] === 'function' ? art[name](...a) : ''; return typeof h === 'string' ? h : ''; } catch (e) { console.error(e); return ''; } };
const artLoad = () => Promise.race([artModP.then(m => (m && typeof m.load === 'function' ? m.load() : null)).catch(e => console.error(e)), delay(800)]);
const safe = (fn, ...args) => { try { const r = typeof fn === 'function' ? fn(...args) : null; if (r && r.catch) r.catch(e => console.error(e)); return r; } catch (e) { console.error(e); return null; } };
const emptyState = (ic, title, body) => `<div class="empty"><span class="tile-i blue">${icon(ic)}</span><h4>${title}</h4><p>${body}</p></div>`;
function inRange(rng, c) { const m = String(rng).match(/(\d+)(?:\s*[–-]\s*(\d+))?/); return !!m && c >= +m[1] && c <= +(m[2] || m[1]); }

// ------------------------------------------------------------ segmented controls
/** Slide a segmented control's thumb under its selected/checked button. */
export function moveInd(seg) {
  if (!seg) return;
  const act = seg.querySelector('[aria-selected="true"],[aria-checked="true"]'), ind = seg.querySelector('.seg-ind');
  if (!act || !ind || !act.offsetWidth) return;
  ind.style.width = act.offsetWidth + 'px';
  ind.style.transform = `translateX(${act.offsetLeft}px)`;
}
/**
 * The study panel's tab row on a phone (styles.css): content-wide columns that scroll sideways once seven tabs and long
 * counts no longer fit (.scroll), with the selected tab kept in view. Never clipped.
 */
function fitTabs(tabs) {
  const over = tabs.scrollWidth > tabs.clientWidth + 1;
  tabs.classList.toggle('scroll', over);
  if (!over) { if (tabs.scrollLeft) tabs.scrollLeft = 0; return; }
  const act = tabs.querySelector('[aria-selected="true"]'); if (!act || act.hidden) return;
  const l = act.offsetLeft, r = l + act.offsetWidth;
  if (l < tabs.scrollLeft + 2) tabs.scrollLeft = l - 2;
  else if (r > tabs.scrollLeft + tabs.clientWidth - 2) tabs.scrollLeft = r - tabs.clientWidth + 2;
}
/** First placement without animation (.no-anim for one frame). */
export function placeInd(seg) {
  if (!seg) return;
  seg.classList.add('no-anim'); moveInd(seg);
  requestAnimationFrame(() => requestAnimationFrame(() => seg.classList.remove('no-anim')));
}
/** Set aria-checked + roving tabindex in a radiogroup, then move its thumb. */
export function setRadio(group, isOn) {
  if (!group) return;
  $$('[role=radio]', group).forEach(b => { const on = !!isOn(b); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
  moveInd(group);
}
/** Arrow/Home/End keys inside a radiogroup: move to and activate the neighbour. Returns true if handled. */
export function radioKeys(e, group, onPick) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return false;
  const items = $$('[role=radio]', group).filter(b => !b.disabled && !b.hidden);
  if (!items.length) return false;
  e.preventDefault(); e.stopPropagation();
  let i = items.findIndex(b => b.getAttribute('aria-checked') === 'true');
  if (i < 0) i = Math.max(0, items.indexOf(document.activeElement));
  const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
  i = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (fwd ? 1 : -1) + items.length) % items.length;
  items[i].focus(); onPick(items[i]);
  return true;
}
let segRO = null, segObserved = [];
function observeSegs(root) {
  if (!segRO && 'ResizeObserver' in window) segRO = new ResizeObserver(es => es.forEach(en => moveInd(en.target)));
  segObserved.forEach(s => segRO && segRO.unobserve(s));
  segObserved = $$('.segmented', root);
  segObserved.forEach(s => { placeInd(s); if (segRO) segRO.observe(s); });
}

/** Scroll an element inside the sheet body only (never the window). */
function scrollInSheet(el, block = 'center') {
  const sb = bodyEl(); if (!el || !sb) return;
  const r = el.getBoundingClientRect(), br = sb.getBoundingClientRect();
  let top = sb.scrollTop + (r.top - br.top);
  top -= block === 'center' ? Math.max(0, (br.height - r.height) / 2) : 8;
  sb.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior() });
}

// ------------------------------------------------------------ header, tabs, badges
const setText = (id, t) => { const el = document.getElementById(id); if (el && el.textContent !== t) el.textContent = t; };

/** Kicker, title, subtitle, verse stepper, tab selection + badges (spec §5.5 "Sheet header content"). */
export function renderHead() {
  const b = state.book, c = state.chapter, v = state.selected, tab = state.drawerTab, bk = bookOf(b);
  if (!bk) return;
  const search = tab === 'search';
  // a lexicon entry (a Strong's search can open H430 while reading John) takes its language from the number
  const lex = tab === 'orig' && origFocus?.strong ? String(origFocus.strong) : '';
  const heb = lex ? lex[0] === 'H' : isHebrewBook(b);
  const nVerses = bk.chapters[c - 1];
  // Daniel 2:4–7:28, Ezra 4:8–6:18 and 7:12–26, Jer 10:11: the verse's language, as the Original tab's eyebrow says
  const al = heb && !lex ? aramaicVerses(b, c) : [];
  // a lexicon goes by its entry's language (origFocus.aram: the clicked word's code, then strongView's '(Aramaic)' derivation, as its list header says)
  const lg = !heb ? 'Greek' : lex ? (origFocus.aram ? 'Aramaic' : 'Hebrew') : v ? (al.includes(+v) ? 'Aramaic' : 'Hebrew') : !al.length ? 'Hebrew' : al.length >= nVerses ? 'Aramaic' : 'Hebrew and Aramaic';
  setText('drawer-kicker', search ? 'Search results' : v ? `Verse ${v} of ${nVerses}` : `${testamentName(bk)} · ${bk.div}`);
  setText('drawer-title', search ? (searchState.title || 'Search') : refLabel(b, c, v));
  setText('drawer-sub', tab === 'orig' ? `${lg} · STEPBible ${heb ? 'TAHOT' : 'TAGNT'}` : trInfo(previewTr()).name);

  const vp = document.getElementById('verse-prev'), vn = document.getElementById('verse-next');
  const hideStep = !v || search;
  const set = (btn, dis) => {
    if (!btn) return;
    btn.hidden = hideStep;
    if (dis && document.activeElement === btn) { const other = btn === vp ? vn : vp; if (other && !other.hidden) other.focus({ preventScroll: true }); }
    btn.disabled = dis;
  };
  set(vp, !v || v <= 1); set(vn, !v || v >= nVerses);

  const tabs = document.getElementById('drawer-tabs');
  if (tabs) {
    const st = document.getElementById('tab-search'); if (st) st.hidden = !searchState.has;
    $$('[role=tab]', tabs).forEach(t => { const on = t.dataset.tab === tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
    moveInd(tabs); fitTabs(tabs);
  }
  bodyEl()?.setAttribute('aria-labelledby', 'tab-' + tab);

  renderBookmarkBtn(b, c, search ? 0 : (v || 0));

  // tab badges
  const note = noteFor(refKey(b, c, v));
  renderNotesCount(b, c, v);
  const nv = note ? (note.videos || []).length : 0;
  setText('cnt-media', nv ? String(nv) : '');
  renderMineCount();
  if (!v) setText('cnt-xref', '');
  else data.xref(b).then(xr => {
    if (state.book !== b || state.chapter !== c || state.selected !== v) return;
    const n = (xr[`${c}:${v}`] || []).length; setText('cnt-xref', n ? String(n) : '');
  }).catch(() => {});
}
export const renderTabs = renderHead; // back-compat name

/**
 * The Notes tab's badge: a dot for the verse's (or chapter's) note; with highlights or comments on the verse, a count
 * of them and the note instead (#cnt-notes).
 */
function renderNotesCount(b = state.book, c = state.chapter, v = state.selected) {
  const note = noteFor(refKey(b, c, v)), has = !!(note && (note.text || note.highlight || (note.tags || []).length));
  const n = v && mrk ? (safe(mrk.marksFor, b, c, v) || []).length : 0;
  setText('cnt-notes', n ? String(n + (has ? 1 : 0)) : '');
  const pip = document.getElementById('pip-notes'); if (pip) pip.hidden = !has || n > 0;
}
/** The verse (v 0: the chapter) the Mine tab shows: a link's source verse in another chapter while its composer is open, else the selection. */
const mineAt = () => safe(links && links.mineFocus) || { b: state.book, c: state.chapter, v: state.selected || 0 };
/** #cnt-mine (links-spec §3.3): the links of the verse the Mine tab shows, or the chapter's; hidden when 0. The name carries it too. */
function renderMineCount() {
  const t = document.getElementById('tab-mine'); if (!t || !links) return;
  const at = mineAt(), n = bookOf(at.b) ? +safe(links.mineCount, at.b, at.c, at.v) || 0 : 0;
  setText('cnt-mine', n ? String(n) : '');
  const name = n ? `My links, ${n.toLocaleString()}` : 'My links';
  if (t.getAttribute('aria-label') !== name) t.setAttribute('aria-label', name);
}

/** #btn-bookmark (profiles spec §5.8): the selected verse, else the chapter; pressed when bookmarked. */
function renderBookmarkBtn(b, c, v) {
  const hb = document.getElementById('btn-bookmark'); if (!hb) return;
  // hidden beside a search query, like the verse stepper: there it could only bookmark the chapter behind it
  const hide = state.drawerTab === 'search';
  if (hide && document.activeElement === hb) document.getElementById('drawer-close')?.focus({ preventScroll: true });
  hb.hidden = hide;
  const bm = safe(libFn('bookmarkFor'), b, c, v);
  const name = safe(libFn('refName'), b, c, v) || refLabel(b, c, v);
  const on = !!bm;
  if (hb.getAttribute('aria-pressed') !== String(on)) hb.setAttribute('aria-pressed', String(on));
  // a toggle keeps one name and lets aria-pressed carry the state (a verb label would announce it twice)
  const label = `Bookmark ${name}`;
  if (hb.getAttribute('aria-label') !== label) hb.setAttribute('aria-label', label);
  hb.title = on ? 'Remove bookmark (b)' : 'Bookmark (b)'; // hover hint only (the accessible description)
  if (on) hb.dataset.bmColor = bm.color || 'red'; else delete hb.dataset.bmColor;
  hb.querySelector('svg')?.classList.toggle('f', on);
}
const bookmarkTarget = () => ({ b: state.book, c: state.chapter, v: state.drawerTab === 'search' ? 0 : (state.selected || 0) });

/** Study signals for tracker.js (§5.14). */
function wordStudied(strong, word) {
  const v = state.selected; if (!v) return;
  const detail = { b: state.book, c: state.chapter, v };
  if (strong) detail.strong = strong;
  if (word) detail.word = word;
  document.dispatchEvent(new CustomEvent('bs:word-studied', { detail }));
}

// ------------------------------------------------------------ body rendering
/**
 * The inline video player (#player) and its "Now playing" bar sit above the tab view and are never re-rendered, so a
 * video keeps playing while you step through verses, switch tabs or edit notes. It stops on its Close button, when
 * the sheet closes (main.js closeDrawer empties #player), and when the tab changes profile or loses its session
 * (main.js onScopeChange, account.js markLost), so one profile's video never plays on for the next. Nodes marked
 * data-keep survive every view swap.
 */
function playerHost(el = bodyEl()) {
  let p = document.getElementById('player');
  if (p || !el) return p;
  el.insertAdjacentHTML('afterbegin', `<div class="lh" id="player-bar" data-keep hidden><h3>Now playing</h3><button class="link" type="button" data-stop-video>Close video</button></div><div id="player" class="player" data-keep hidden></div>`);
  p = document.getElementById('player');
  // the bar follows the player, whoever fills or empties it
  if ('MutationObserver' in window) new MutationObserver(syncPlayer).observe(p, { childList: true });
  return p;
}
function syncPlayer() {
  const p = document.getElementById('player'), bar = document.getElementById('player-bar');
  const on = !!(p && p.querySelector('iframe'));
  if (p && !on) { p.hidden = true; delete p.dataset.id; delete p.dataset.start; }
  if (bar) bar.hidden = !on;
}
export function stopPlayer() { const p = document.getElementById('player'); if (p) p.innerHTML = ''; syncPlayer(); }
/** Replace the tab view (everything in the body except the data-keep player nodes). */
function setView(el, html) {
  [...el.children].forEach(ch => { if (!ch.hasAttribute('data-keep')) ch.remove(); });
  el.insertAdjacentHTML('beforeend', html);
}
/**
 * Re-rendering removes the focused control. Put focus on opts.focusTo (a selector or el => element) when one is
 * given, else, when focus was inside the body and fell to <body>, on the body itself (tabindex -1), so keyboard and
 * screen-reader users never drop out of the dialog.
 */
function placeFocus(el, opts, hadFocus) {
  const lost = () => { const a = document.activeElement; return !a || a === document.body || !a.isConnected; };
  const t = opts.focusTo ? (typeof opts.focusTo === 'function' ? opts.focusTo(el) : $(opts.focusTo, el)) : null;
  if (t && (hadFocus || lost())) t.focus({ preventScroll: true });
  else if (hadFocus && lost()) el.focus({ preventScroll: true });
}

export async function renderDrawer(opts = {}) {
  const ae = document.activeElement;
  renderHead();
  const el = bodyEl();
  const hadFocus = !!(el && ae && ae !== document.body && (el.contains(ae) || !!menuEl?.contains(ae)));
  closeMenu(false);
  if (!state.drawerOpen || !el) return;
  playerHost(el); syncPlayer();
  const token = String(++renderSeq); el.dataset.token = token;
  const prevScroll = el.scrollTop;
  const skel = setTimeout(() => { if (el.dataset.token === token) setView(el, SKELETON); }, 90);
  const b = state.book, c = state.chapter, v = state.selected;
  let html = '';
  try {
    switch (state.drawerTab) {
      case 'xref': html = await xrefTab(b, c, v); break;
      case 'context': html = await contextTab(b, c, v, opts); break;
      case 'orig': html = await origTab(b, c, v); break;
      case 'notes': html = notesTab(b, c, v, opts); break;
      case 'media': html = mediaTab(b, c, v); break;
      case 'mine': html = links ? '<div class="mine-host"></div>' : emptyState('link-node', 'My links are unavailable', 'Reload to try again.'); break; // filled by afterRender
      case 'search': html = searchState.html || emptyState('search', 'Search the Bible', 'Type a reference like <i>jn 3:16</i>, words, a Strong’s number like <i>G26</i> or a topic in the search field.'); break;
      default: html = '';
    }
  } catch (e) { console.error(e); html = emptyState('info', 'Something went wrong', esc(e.message)); }
  clearTimeout(skel);
  if (el.dataset.token !== token) return; // superseded
  const cls = opts.push ? 'view push' : opts.pop ? 'view pop' : 'view';
  const still = opts.keepScroll && !opts.push && !opts.pop; // in-place edits: no entrance animation
  setView(el, `<div class="${cls}" style="--dx:${opts.dx || 0}px${still ? ';animation:none' : ''}">${html}</div>`);
  el.scrollTop = opts.keepScroll ? prevScroll : 0;
  document.getElementById('drawer')?.classList.toggle('scrolled', el.scrollTop > 2);
  afterRender(opts);
  placeFocus(el, opts, hadFocus);
}

// ------------------------------------------------------------ Links
async function xrefTab(b, c, v) {
  const xr = await data.xref(b);
  if (!v) {
    const rows = Object.entries(xr).filter(([k]) => k.startsWith(c + ':')).map(([k, list]) => ({ v: +k.split(':')[1], n: list.length, top: list[0] }))
      .filter(r => r.n && r.top).sort((a, z) => z.n - a.n || a.v - z.v).slice(0, 12);
    if (!rows.length) return emptyState('link', 'No cross-references', `OpenBible.info has no links recorded for ${esc(refLabel(b, c))}.`);
    const max = rows[0].n || 1;
    return `<div class="lh"><h3>Most-linked verses</h3><span>${esc(refLabel(b, c))}</span></div>
      <ul class="group">${rows.map((r, i) => `<li><button class="cell" type="button" data-select="${r.v}"><span class="cell-body"><span class="cell-title">Verse ${r.v}</span><span class="cell-sub">Top link: ${esc(refLabel(r.top[0], r.top[1], r.top[2], r.top[3]))}</span></span><span class="cell-trail"><span class="votes" title="${plural(r.n, 'link')}"><span class="vbar seq"><i style="width:${Math.max(5, Math.round(100 * r.n / max))}%;animation-delay:${Math.min(i, 12) * 30}ms"></i></span><span class="vn">${r.n}</span></span>${icon('chev-right', 'chev')}</span></button></li>`).join('')}</ul>
      <p class="foot-note">Select a verse to see its cross-references. Data: OpenBible.info (CC BY).</p>`;
  }
  const list = xr[`${c}:${v}`] || [];
  const [pv, topics] = await Promise.all([previewText(b, c, v), data.topics().catch(() => [])]);
  const quote = await quoteHtml(pv, b, c, v, 'vq');
  const cites = x => { const { ec, ev } = rangeEnd(x[1], x[2], x[3]); return x[0] === b && (c > x[1] || (c === x[1] && v >= x[2])) && (c < ec || (c === ec && v <= ev)); };
  const inTopics = topics.filter(t => (t.verses || []).some(cites)).sort((a, z) => z.votes - a.votes).slice(0, 12);
  const topicChips = inTopics.length ? `<div class="lh"><h3>Topics citing this verse</h3><span>${inTopics.length}</span></div><div class="topic-chips">${inTopics.map(t => `<button class="chip" type="button" data-topic="${esc(t.name)}">${icon('sparkle')}${esc(t.label || t.name)}</button>`).join('')}</div>` : '';
  if (!list.length) return quote + emptyState('link', 'No cross-references', 'OpenBible.info has no links recorded for this verse.') + topicChips;
  const max = Math.max(1, ...list.map(x => x[4]));   // votes are never negative (build.py drops those links)
  const nOT = list.filter(x => x[0] <= 39).length, nNT = list.length - nOT;
  let f = state.xfilter;
  if ((f === 'ot' && !nOT) || (f === 'nt' && !nNT) || !['all', 'ot', 'nt'].includes(f)) f = state.xfilter = 'all';
  const radio = (val, label, count) => { const on = f === val; return `<button type="button" role="radio" data-f="${val}" aria-checked="${on}" tabindex="${on ? 0 : -1}"${count ? '' : ' disabled'}>${label} ${count}</button>`; };
  return `${quote}
    <div class="canon-mini" id="canon-mini"></div>
    <div class="lh"><h3>Cross-references</h3><span>${list.length} · ranked by votes</span></div>
    <div class="filter-row"><div class="segmented sm" id="xfilter" role="radiogroup" aria-label="Filter by testament"><span class="seg-ind" aria-hidden="true"></span>${radio('all', 'All', list.length)}${radio('ot', 'Old', nOT)}${radio('nt', 'New', nNT)}</div></div>
    <ol class="group xrefs">${list.map((x, i) => { const t = x[0] <= 39 ? 'ot' : 'nt'; return `<li class="xref" data-i="${i}" data-b="${x[0]}" data-c="${x[1]}" data-v="${x[2]}" data-e="${x[3] || 0}" data-t="${t}"${f !== 'all' && f !== t ? ' hidden' : ''}>
      <button class="cell" type="button" aria-expanded="false" aria-controls="xe${i}"><span class="xi" aria-hidden="true">${i + 1}</span><span class="cell-body"><span class="cell-title">${esc(refLabel(x[0], x[1], x[2], x[3]))}</span><span class="cell-sub serif" data-preview></span></span><span class="cell-trail"><span class="votes" title="${x[4].toLocaleString()} votes"><span class="vbar ${t}"><i style="width:${Math.max(5, Math.round(100 * Math.max(0, x[4]) / max))}%;animation-delay:${Math.min(i, 12) * 30}ms"></i></span><span class="vn">${x[4].toLocaleString()}</span></span>${icon('chev-right', 'chev')}</span></button>
      <div class="expand" id="xe${i}" role="region" aria-label="${esc(refLabel(x[0], x[1]))} in context" inert><div><div class="expand-in"></div></div></div></li>`; }).join('')}</ol>
    ${topicChips}
    <div class="mini-legend"><span class="key ot"><i></i>Old Testament</span><span class="key nt"><i></i>New Testament</span></div>
    <p class="foot-note">Cross-references: OpenBible.info (CC BY). Votes reflect how many readers found a link helpful. Tap a row to read it in context.</p>`;
}

/** Why a verse has no text in a translation (the BSB's omitted verses, Mt 17:21, Mk 9:44…), as the reader says it. */
const omitWhy = tr => (tr === 'bsb' ? 'The BSB leaves this verse out of its text (a textual variant it gives in a footnote).' : `The ${esc(trInfo(tr).abbr)} has no separate verse here.`);
/**
 * The verse quoted at the top of a tab. A verse the preview translation leaves out (the BSB's 16 textual variants)
 * gets the same muted explanation as the reader, with the KJV reading, never an empty quote.
 */
async function quoteHtml(pv, b, c, v, cls) {
  if (String(pv.text || '').trim()) return `<blockquote class="${cls}">${esc(pv.text)}</blockquote>`;
  let kjv = '';
  try { kjv = String(((await data.bible('kjv', b))[c] || [])[v - 1] || '').trim(); } catch (e) { kjv = ''; }
  return `<blockquote class="${cls} omitted"><span class="om-why">${omitWhy(pv.tr)}</span>${kjv && pv.tr !== 'kjv' ? ` <span class="om-kjv">KJV: “${esc(kjv)}”</span>` : ''}</blockquote>`;
}
async function fillPreviews(root) {
  const items = $$('.xref', root);
  if (!items.length) return;
  const tr = previewTr();
  await Promise.all([...new Set(items.map(li => +li.dataset.b))].map(b => data.bible(tr, b).catch(() => null)));
  for (const li of items) {
    if (!root.isConnected || !li.isConnected) return;
    const p = $('[data-preview]', li); if (!p || p.textContent) continue;
    try { const r = await previewText(+li.dataset.b, +li.dataset.c, +li.dataset.v, +li.dataset.e); p.textContent = clip(r.text, 170) || ' '; } catch (e) { p.textContent = ' '; }
  }
}

function setOpen(li, on) {
  li.classList.toggle('open', on);
  $('.cell', li)?.setAttribute('aria-expanded', String(on));
  const ex = $('.expand', li); if (ex) ex.inert = !on;
}

async function expandXref(li) {
  if (li.classList.contains('open')) { setOpen(li, false); return; }
  const box = $('.expand-in', li);
  if (box && !box.dataset.loaded) {
    const b = +li.dataset.b, c = +li.dataset.c, v = +li.dataset.v, vend = +li.dataset.e || 0;
    const { ec, ev } = rangeEnd(c, v, vend);   // a range may run into the next chapter (Hebrews 6:20–7:3)
    const tr = previewTr(), bk = await data.bible(tr, b);
    let kjv = null;   // loaded for a verse the preview translation leaves out
    let h = '<div class="ctx-read">';
    for (let cc = c; cc <= ec; cc++) {
      const ch = bk[cc] || [];
      const from = cc === c ? Math.max(1, v - 2) : 1, to = cc === ec ? Math.min(ch.length, ev + 2) : ch.length;
      if (cc > c) h += `<p class="ctx-ch">${esc(refLabel(b, cc))}</p>`;
      for (let i = from; i <= to; i++) {
        const t = (cc > c || i >= v) && (cc < ec || i <= ev);
        if (!String(ch[i - 1] || '').trim()) {
          // an omitted verse: the explanation (and the KJV's wording), never an empty highlighted row
          if (tr !== 'kjv' && !kjv) kjv = await data.bible('kjv', b).catch(() => ({}));
          const k = tr !== 'kjv' ? String((kjv[cc] || [])[i - 1] || '').trim() : '';
          h += `<p class="om"><span class="n">${i}</span><span class="om-why">${omitWhy(tr)}</span>${k ? ` <span class="om-kjv">KJV: “${esc(k)}”</span>` : ''}</p>`;
          continue;
        }
        h += `<p${t ? ' class="t"' : ''}><span class="n">${i}</span>${t ? `<span class="tx">${esc(ch[i - 1] || '')}</span>` : esc(ch[i - 1] || '')}</p>`;
      }
    }
    h += `</div><div class="actions"><button class="btn btn-primary sm" type="button" data-go="${b}.${c}.${v}">Open ${esc(refLabel(b, c))}${icon('arrow-right')}</button><button class="btn btn-tinted sm" type="button" data-graph="${b}.${c}.${v}">${icon('graph')}Graph</button><button class="btn btn-tinted sm" type="button" data-addnote="${esc(refLabel(b, c, v, vend))}">${icon('plus')}Add to note</button></div>`;
    box.innerHTML = h; box.dataset.loaded = '1';
  }
  void li.offsetWidth; // let the grid-rows transition start from 0fr
  setOpen(li, true);
  if (state.selected) document.dispatchEvent(new CustomEvent('bs:xref-opened', { detail: { b: state.book, c: state.chapter, v: state.selected, to: `${li.dataset.b}.${li.dataset.c}.${li.dataset.v}` } }));
}

function applyFilter() {
  const root = bodyEl(); const seg = $('#xfilter', root); if (!seg) return;
  setRadio(seg, b => b.dataset.f === state.xfilter);
  $$('.xref', root).forEach(li => { li.hidden = state.xfilter !== 'all' && li.dataset.t !== state.xfilter; });
}

function pickXref(i) {
  const li = $(`.xref[data-i="${i}"]`, bodyEl()); if (!li) return;
  if (li.hidden) { state.xfilter = 'all'; applyFilter(); }
  if (!li.classList.contains('open')) expandXref(li);
  setTimeout(() => scrollInSheet(li, 'center'), 30);
}

// ------------------------------------------------------------ Context
const hasVal = x => x !== null && x !== undefined && x !== '';
/**
 * Birth and death years when both are known. Otherwise only when the person first appears: Theographic's y0/y1 are
 * the years of the first and last verses that mention them, so y1 is often a later look back (John the Baptist's
 * falls in Acts 19, AD 58) and never an end date.
 */
function lifespan(p) {
  if (hasVal(p.b) && hasVal(p.d)) return `${yearLabel(p.b)} – ${yearLabel(p.d)}`;
  if (hasVal(p.b)) return `born c. ${yearLabel(p.b)}`;
  if (hasVal(p.d)) return `died c. ${yearLabel(p.d)}`;
  if (hasVal(p.y0)) return p.y0 === p.y1 || !hasVal(p.y1) ? `mentioned c. ${yearLabel(p.y0)}` : `first appears c. ${yearLabel(p.y0)}`;
  return '';
}
/** Verses of this chapter that belong to an event, in order. */
const eventVerses = (vmap, id) => Object.entries(vmap).filter(([, x]) => (x.e || []).includes(+id)).map(([k]) => +k).sort((a, z) => a - z);
/**
 * [from, to] → 'c. 950–930 BC', 'c. AD 60–85', 'c. AD 57' for the narrow Written tile: a line may break only after
 * 'c.' or the dash ('c. 1446–' / '1406 BC'), never inside a year or between a year and its 'AD' or 'BC'.
 */
function spanLabel([a, z]) {
  const keep = s => s.replace(/ /g, '\u00a0'), dash = '–\u200b';
  if (a === z) return `c. ${keep(yearLabel(a))}`;
  if (a < 0 && z < 0) return `c. ${-a}${dash}${keep(`${-z} BC`)}`;
  if (a > 0 && z > 0) return `c. ${keep(`AD ${a}`)}${dash}${z}`;
  return `c. ${keep(yearLabel(a))} – ${keep(yearLabel(z))}`;
}
/** The chapter's year: the most common verse year, the same rule as the hero's era chip (reader.js modeOf). */
function chapterEra(vmap) {
  const ys = Object.values(vmap).map(x => x.y).filter(hasVal);
  if (!ys.length) return null;
  const m = new Map(); let best = ys[0], bc = 0;
  for (const y of ys) { const n = (m.get(y) || 0) + 1; m.set(y, n); if (n > bc) { bc = n; best = y; } }
  return +best;
}
// Psalms whose heading names the sons of Korah (Theographic lists no writer for them; 88 it gives to Heman)
const KORAH = new Set([42, 44, 45, 46, 47, 48, 49, 84, 85, 87]);
// the intro calls the book anonymous or its author traditional/debated: the chapter writer is tradition, not fact
const TRADITIONAL = /^(anonymous|the chronicler|associated)|tradition|debated/i;
/**
 * Theographic's place comment without the source editors' notes: URLs, provenance ("from tyndale", "esv map",
 * "KMZ:…"), open questions and words that only repeat the feature type ("; now Nehardea; http://…" -> "now Nehardea").
 * A bare "river"/"lake"/"road" becomes the type itself. Returns {type, note}.
 */
function placeNote(c, ft) {
  let type = String(ft || '').trim();
  const segs = String(c || '').split(/;|:\s+/).map(s => s
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/(?:^|\s)(?:[\w-]+\.)+(?:com|net|org|info|edu|gov|mil|gr|uk|dk)(?:\/\S*)?/gi, ' ')
    .replace(/\s+/g, ' ').replace(/^[\s:;,.]+|[\s:;,]+$/g, ''))
    .filter(s => s && !/^(?:from\b|esv map$|guess\b|kmz:|mobile$|figurative$)|\bkml\b|\?$/i.test(s) && s.toLowerCase() !== type.toLowerCase());
  const note = [];
  for (const s of segs) {
    if (/^(?:river|sea|lake|road|mountain range)$/i.test(s)) type = s[0].toUpperCase() + s.slice(1).toLowerCase();
    else note.push(s);
  }
  return { type, note: note.join('; ') };
}

async function contextTab(b, c, v, opts) {
  const [ctx, intros, people, places, events] = await Promise.all([
    data.context(b), data.bookIntros().catch(() => []), data.people().catch(() => ({})), data.places().catch(() => ({})), data.events().catch(() => ({})),
    artLoad(),
  ]);
  const bk = bookOf(b), intro = intros[b - 1] || {};
  const ch = ctx[String(c)] || {}; const vmap = ch.v || {};
  const here = v ? (vmap[String(v)] || {}) : null;
  // ids missing from people.json (spirit beings and pagan gods are not people) are skipped silently everywhere below
  const pCount = new Map(), plCount = new Map(), eIds = new Set();
  Object.values(vmap).forEach(x => {
    (x.p || []).forEach(i => pCount.set(i, (pCount.get(i) || 0) + 1));
    (x.pl || []).forEach(i => plCount.set(i, (plCount.get(i) || 0) + 1));
    (x.e || []).forEach(i => eIds.add(i));
  });
  const inV = { p: new Set(here?.p || []), pl: new Set(here?.pl || []), e: new Set(here?.e || []) };
  const verseYear = here && hasVal(here.y) ? +here.y : null;
  const when = verseYear ?? chapterEra(vmap);

  // stats
  const author = String(intro.author || '');
  let writer = (ch.w || []).map(i => people[i]?.t || people[i]?.n).filter(Boolean).join(', '), writerTip = author;
  if (!writer && Object.values(ctx).some(x => (x?.w || []).length)) {
    // a book with writers per chapter (Psalms) but none here: its heading, never the intro's first name ("David (73)")
    writer = b === 19 && KORAH.has(c) ? 'Sons of Korah' : 'Unattributed';
    writerTip = b === 19 ? (KORAH.has(c) ? 'The heading names the sons of Korah.' : 'No writer is named in this psalm’s heading.') : author;
  } else if (!writer) writer = author.split(/[,;(]/)[0].replace(/^Traditionally\s+/i, '').trim();
  writer = smart(writer);
  const writerLabel = TRADITIONAL.test(author) && !/^(anonymous|unattributed)/i.test(writer) ? 'Traditionally' : 'Writer';
  const written = Array.isArray(intro.written) && intro.written.length === 2 ? intro.written : null;   // [from, to], BC negative
  const writtenTxt = written ? spanLabel(written) : '';
  const stat = (label, val, tip) => `<div class="stat"${val ? '' : ' hidden'}${tip && val ? ` title="${esc(smart(tip))}"` : ''}><small>${label}</small><b>${esc(val || '')}</b></div>`;
  const whenTip = `Approximate year of the events in this ${verseYear !== null ? 'verse' : 'chapter'} (Theographic’s chronology; other chronologies differ)`;
  let h = artHtml('drawerHtml', b, c, v || 0); // Doré's engravings of this verse (or chapter) come first
  if (when !== null || writer || writtenTxt) h += `<div class="stats">${stat('When', when !== null ? 'c. ' + yearLabel(when).replace(/ /g, '\u00a0') : '', whenTip)}${stat(writerLabel, writer, writerTip)}${stat('Written', writtenTxt)}</div>`;

  // timeline (viz fills it after render; its arguments travel on the host so overlapping renders cannot mix them up)
  if (when !== null || written) {
    const args = { era: when, written, eventIds: inV.e.size ? [...inV.e] : [...eIds], markLabel: verseYear !== null ? 'This verse' : 'This chapter' };
    h += `<div class="lh"><h3>Timeline</h3><span>${esc(refLabel(b, c))} in Bible history</span></div><div id="timeline" class="timeline-host" data-args="${esc(JSON.stringify(args))}"></div>`;
  }

  // events
  const evList = [...eIds].map(id => ({ id, e: events[id] })).filter(x => x.e && x.e.t)
    .sort((a, z) => (inV.e.has(z.id) - inV.e.has(a.id)) || ((a.e.sk ?? 0) - (z.e.sk ?? 0)));
  if (evList.length) {
    h += `<div class="lh"><h3>Events</h3><span>${evList.length}</span></div><ul class="group av">${evList.map(({ id, e }) => {
      const vs = eventVerses(vmap, id);
      const rng = vs.length ? `v${vs[0]}${vs.length > 1 ? '–' + vs[vs.length - 1] : ''}` : '';
      const sub = [yearLabel(e.y), fmtDur(e.dur), (e.pl || []).map(i => places[i]?.n).filter(Boolean).join(', ')].filter(Boolean).join(' · ');
      return `<li><button class="cell" type="button" data-event="${esc(id)}"><span class="tile-i indigo">${icon('calendar')}</span><span class="cell-body"><span class="cell-title">${esc(smart(e.t))}</span>${sub ? `<span class="cell-sub">${esc(sub)}</span>` : ''}</span><span class="cell-trail">${rng ? `<span class="vn">${rng}</span>` : ''}${inV.e.has(id) ? IN_VERSE : ''}${icon('chev-right', 'chev')}</span></button></li>`;
    }).join('')}</ul>`;
  }

  // God (Father, Son and Holy Spirit) is shown on its own, never among the people
  const named = [...pCount.entries()].filter(([id]) => people[id] && (people[id].t || people[id].n))
    .map(([id, cnt]) => ({ id, cnt, p: people[id], inv: inV.p.has(id) }));
  const GODHEAD = [1324, 905, 7400];
  const god = named.filter(x => isDivine(x.id) || x.p.dv).sort((a, z) => GODHEAD.indexOf(+a.id) - GODHEAD.indexOf(+z.id));
  if (god.length) {
    h += `<div class="lh"><h3>The Godhead</h3><span>Father, Son and Holy Spirit</span></div><ul class="group av">${god.map(({ id, p, inv }) => {
      const name = p.t || p.n; const sub = [p.role, p.vc ? 'named in ' + plural(p.vc, 'verse') : ''].filter(Boolean).join(' · ');
      return `<li class="person divine"><button class="cell" type="button" data-person="${esc(id)}" aria-expanded="false"><span class="tile-i gold" aria-hidden="true">${icon('light')}</span><span class="cell-body"><span class="cell-title">${esc(name)}</span>${sub ? `<span class="cell-sub">${esc(sub)}</span>` : ''}</span><span class="cell-trail">${inv ? IN_VERSE : ''}${icon('chev-right', 'chev')}</span></button><div class="expand" inert><div><div class="expand-in"></div></div></div></li>`;
    }).join('')}</ul>`;
  }

  // people
  const ppl = named.filter(x => !(isDivine(x.id) || x.p.dv))
    .sort((a, z) => (z.inv - a.inv) || (z.cnt - a.cnt) || ((z.p.vc || 0) - (a.p.vc || 0)));
  if (ppl.length) {
    h += `<div class="lh"><h3>People</h3><span>${ppl.length}</span></div><ul class="group av">${ppl.map(({ id, p, inv }) => {
      const name = p.t || p.n; const sub = [lifespan(p), p.vc ? plural(p.vc, 'verse') : ''].filter(Boolean).join(' · ');
      return `<li class="person"><button class="cell" type="button" data-person="${esc(id)}" aria-expanded="false"><span class="avatar" aria-hidden="true">${esc(initials(name))}</span><span class="cell-body"><span class="cell-title">${esc(name)}</span>${sub ? `<span class="cell-sub">${esc(sub)}</span>` : ''}</span><span class="cell-trail">${inv ? IN_VERSE : ''}${icon('chev-right', 'chev')}</span></button><div class="expand" inert><div><div class="expand-in"></div></div></div></li>`;
    }).join('')}</ul>`;
  }

  // places
  const pls = [...plCount.entries()].filter(([id]) => places[id] && places[id].n)
    .map(([id, cnt]) => ({ id, cnt, p: places[id], inv: inV.pl.has(id) }))
    .sort((a, z) => (z.inv - a.inv) || (z.cnt - a.cnt));
  if (pls.length) {
    h += `<div class="lh"><h3>Places</h3><button class="link" type="button" data-panel="map">Open full map</button></div><div class="mini-map" id="mini-map"></div><ul class="group av">${pls.map(({ id, p, inv }) => {
      const { type, note } = placeNote(p.c, p.ft);   // without the source editors' notes and URLs
      const sub = [type, note, p.aka ? 'also ' + p.aka : ''].filter(Boolean).join(' · ') || 'Place';
      return `<li class="place"><button class="cell" type="button" data-place="${esc(id)}" aria-expanded="false"><span class="tile-i red">${icon('pin')}</span><span class="cell-body"><span class="cell-title">${esc(p.n)}</span><span class="cell-sub">${esc(smart(sub))}</span></span><span class="cell-trail">${inv ? IN_VERSE : ''}${icon('chev-right', 'chev')}</span></button><div class="expand" inert><div><div class="expand-in"></div></div></div></li>`;
    }).join('')}</ul>`;
  }

  // book introduction
  const open = !!opts.intro || (!evList.length && !ppl.length);
  const kv = (k, val) => typeof val === 'string' && val ? `<div><dt>${k}</dt><dd>${esc(smart(val))}</dd></div>` : '';
  const themes = (intro.themes || []).length ? `<div class="tags-static">${intro.themes.map(t => `<span class="tag-s">${esc(smart(t))}</span>`).join('')}</div>` : '';
  // a one-chapter book's outline gives verse ranges: 'You are here' follows the selected verse, a row selects its verse
  const one = bk.chapters.length === 1;
  const outline = (intro.outline || []).length ? `<ol class="outline">${intro.outline.map(r => {
    const cur = one ? !!v && inRange(r[0], v) : inRange(r[0], c), first = esc(String(r[0]).match(/\d+/)?.[0] || 1);
    return `<li${cur ? ' class="cur"' : ''}><button type="button" ${one ? `data-select="${first}"` : `data-goch="${first}"`}${cur ? ' aria-current="location"' : ''}><span class="rng">${esc(r[0])}</span><span>${esc(smart(r[1]))}</span>${cur ? '<span class="here">You are here</span>' : ''}</button></li>`;
  }).join('')}</ol>` : '';
  h += `<details class="intro-card" id="intro-card"${open ? ' open' : ''}><summary><span class="tile-i blue">${icon('book')}</span><span class="cell-body"><span class="cell-title">About ${esc(bk.name)}</span><span class="cell-sub">Author, audience, purpose, themes and outline</span></span>${icon('chev-right', 'chev')}</summary>
    <div class="intro-body"><dl class="kv">${kv('Author', intro.author)}${kv('Date', intro.date)}${kv('Audience', intro.audience)}${kv('Setting', intro.setting)}${kv('Purpose', intro.purpose)}${kv('Place written', intro.placeWritten)}</dl>
    ${themes}${outline}
    <p class="credit">Introductions summarise mainstream scholarship; dates are approximate. People, places, events: Theographic Bible Metadata (CC BY-SA 4.0). Dictionary: Easton’s (1897).</p></div></details>`;
  return h;
}

function dictHtml(d) {
  if (!d) return '<p class="dict">No dictionary entry.</p>';
  // the More button appears only when the text is actually clamped (it depends on the panel's width): fitDict()
  return `<p class="dict">${esc(String(d).replace(/\n\s*/g, '\n'))}</p><button class="link" type="button" data-more-dict hidden>More</button>`;
}
const dictRO = 'ResizeObserver' in window ? new ResizeObserver(es => es.forEach(e => fitDict(e.target))) : null;
/** Show a dictionary entry's More button while its text is clamped. */
function fitDict(d) {
  const btn = d?.nextElementSibling; if (!btn || !btn.matches('[data-more-dict]')) return;
  if (d.classList.contains('full')) { btn.hidden = false; return; }
  btn.hidden = !(d.scrollHeight > d.clientHeight + 1);
}
function watchDict(li) { const d = $('.dict', li); if (!d) return; requestAnimationFrame(() => fitDict(d)); dictRO?.observe(d); }
/**
 * Find for a person or place lists the verses Theographic tags with it (the card's 'named in N verses'), not a word
 * search: a name's spelling differs between translations and from Theographic's own ('Bethel' is 'Beth-el' in the
 * KJV, the Holy Spirit 'the Holy Ghost', 'Antioch (Syria)' and 'Herod Antipas' are editors' labels).
 */
const findBtn = (kind, id, name) => `<button class="btn btn-tinted sm" type="button" data-tagged="${kind}:${esc(id)}" data-name="${esc(name)}">${icon('search')}Find “${esc(name)}”</button>`;
const taggedCache = new Map();
/** 'p:ID' or 'pl:ID' → the packed refs (book*1e6 + chapter*1000 + verse) of the verses tagged with it, in order. */
function taggedVerses(spec) {
  if (!taggedCache.has(spec)) {
    const [k, id] = String(spec).split(':'), want = +id;
    taggedCache.set(spec, Promise.all(state.books.map((_, i) => data.context(i + 1))).then(ctxs => {
      const out = [];
      ctxs.forEach((ctx, i) => Object.entries(ctx || {}).forEach(([c, ch]) => Object.entries(ch?.v || {}).forEach(([v, x]) => {
        if ((x[k] || []).includes(want)) out.push((i + 1) * 1e6 + +c * 1000 + +v);
      })));
      return out.sort((a, z) => a - z);
    }).catch(e => { taggedCache.delete(spec); throw e; }));
  }
  return taggedCache.get(spec);
}
async function showTagged(spec, name) {
  const refs = await taggedVerses(spec).catch(() => []);
  setSearchResults(`“${name}”`, refs.length
    ? `<div class="lh"><h3>${esc(name)}</h3><span>${plural(refs.length, 'verse')} · Theographic</span></div><ul class="group occ" data-tags="${esc(spec)}" data-shown="0"></ul><button class="btn btn-gray btn-wide" type="button" data-more-occ>Show more</button>`
    : emptyState('search', 'No verses found', `No verse is tagged with ${esc(name)}.`));
  A.openTab('search');
}
async function expandPerson(li, id) {
  if (li.classList.contains('open')) { setOpen(li, false); return; }
  const box = $('.expand-in', li);
  if (box && !box.dataset.loaded) {
    const [people, places] = await Promise.all([data.people(), data.places().catch(() => ({}))]);
    const p = people[id] || {}; const nm = i => people[i]?.t || people[i]?.n;
    const names = ids => (ids || []).map(nm).filter(Boolean);
    const rel = [];
    if (p.dv && p.aka) rel.push('Called ' + p.aka);
    if (!p.dv && names(p.fa).length) rel.push('Father ' + names(p.fa).join(', '));
    if (names(p.mo).length) rel.push('Mother ' + names(p.mo).join(', '));
    if (names(p.pt).length) rel.push('Partner ' + names(p.pt).join(', '));
    const kids = names(p.ch); if (kids.length) rel.push('Children ' + kids.slice(0, 12).join(', ') + (kids.length > 12 ? ` +${kids.length - 12}` : ''));
    const bp = (p.bp || []).map(i => places[i]?.n).filter(Boolean); if (bp.length) rel.push('Born ' + bp.join(', '));
    const dp = (p.dp || []).map(i => places[i]?.n).filter(Boolean); if (dp.length) rel.push('Died ' + dp.join(', '));
    const find = p.t || p.n || '';
    box.innerHTML = `${rel.length ? `<p class="rel">${esc(rel.join(' · '))}</p>` : ''}${dictHtml(p.dict)}${find ? `<div class="actions">${findBtn('p', id, find)}</div>` : ''}`;
    box.dataset.loaded = '1';
  }
  void li.offsetWidth; setOpen(li, true); watchDict(li);
}
let placeOrder = []; // place ids in the order their rows were opened (last = the one the mini map shows)
async function expandPlace(li, id) {
  placeOrder = placeOrder.filter(x => x !== id);
  if (li.classList.contains('open')) {
    setOpen(li, false);
    const open = $$('.place.open [data-place]', bodyEl()).map(b => b.dataset.place);
    placeOrder = placeOrder.filter(x => open.includes(x));
    safe(viz.miniMap?.focus?.bind(viz.miniMap), placeOrder[placeOrder.length - 1] || open[0] || null);
    return;
  }
  placeOrder.push(id);
  const box = $('.expand-in', li);
  if (box && !box.dataset.loaded) {
    const places = await data.places(); const p = places[id] || {};
    const has = x => x !== null && x !== undefined && x !== '' && !isNaN(+x);
    const coords = has(p.lat) && has(p.lon) ? `${(+p.lat).toFixed(3)}°, ${(+p.lon).toFixed(3)}°${p.prec ? ' · ' + p.prec : ''}` : '';
    const find = p.n || '';
    // Scholarly records (Pleiades, the Roman atlas, GeoNames) when known, else a Pleiades search.
    const links = placeLinks(p).map(([u, t]) => `<a class="btn btn-plain sm" href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}${icon('external')}</a>`).join('');
    box.innerHTML = `${coords ? `<p class="rel">${esc(coords)}</p>` : ''}${dictHtml(p.dict)}${find || links ? `<div class="actions">${find ? findBtn('pl', id, find) : ''}${links}</div>` : ''}`;
    box.dataset.loaded = '1';
  }
  void li.offsetWidth; setOpen(li, true); watchDict(li);
  safe(viz.miniMap?.focus?.bind(viz.miniMap), id);
}

// ------------------------------------------------------------ Original language
/** "verb aorist active indicative 3rd singular" -> "verb · aorist · active · indicative · 3rd singular"; keeps Hebrew "+" segments. */
function morphParts(s) {
  const TAIL = new Set(['noun', 'pronoun', 'article', 'suffix', 'marker', 'object', 'person', 'deponent', 'word', 'form']);
  const HEAD = new Set(['1st', '2nd', '3rd', 'sequential', 'no', 'directional', 'paragogic']);
  return String(s || '').split(' + ').map(seg => {
    const out = [];
    for (const w of seg.split(/\s+/).filter(Boolean)) {
      const prev = out[out.length - 1]; const last = prev ? prev.split(' ').pop() : '';
      const join = prev && (TAIL.has(w) || w.startsWith('(') || HEAD.has(last)
        || (last === 'participle' && /^(active|passive)$/.test(w)) || (last === 'infinitive' && /^(absolute|construct)$/.test(w)) || (last === 'Qal' && w === 'passive'));
      if (join) out[out.length - 1] = prev + ' ' + w; else out.push(w);
    }
    return out.join(' · ');
  }).join(' + ');
}

/** The Original tab's row id for a word: w0, w1… for the verse, wt0, wt1… for a psalm title's words (index -1, -2…). */
const wordId = i => (i < 0 ? `wt${-i - 1}` : `w${i}`);
async function origTab(b, c, v) {
  const heb = isHebrewBook(b);
  if (origFocus?.strong) return await strongView(origFocus.strong);
  if (!v) {
    const al = aramaicVerses(b, c).length, lg = !heb ? 'Greek' : !al ? 'Hebrew' : al >= (bookOf(b).chapters[c - 1] || 0) ? 'Aramaic' : 'Hebrew and Aramaic';
    return emptyState('alpha', `Read it in ${lg}`, 'Select a verse to see it word by word. Turn on <b>Original</b> in the toolbar to show the interlinear under every verse.');
  }
  const [orig, pv] = await Promise.all([data.orig(b), previewText(b, c, v)]);
  const words = orig[`${c}:${v}`] || [];
  const title = v === 1 ? orig[`${c}:0`] || [] : []; // a psalm's title: its own words, before verse 1's
  const quote = await quoteHtml(pv, b, c, v, 'vq sm');
  if (!words.length && !title.length) return quote + emptyState('alpha', 'No original-language data', 'STEPBible has no word-by-word data for this verse.');
  // Daniel 2:4–7:28, Ezra 4:8–6:18 and 7:12–26, Jer 10:11 are Aramaic: most of the verse's words have an 'A…' code
  const aram = heb && words.filter(isAramaicWord).length * 2 > words.length;
  const lang = !heb ? 'grc' : aram ? 'arc' : 'he', cls = heb ? 'heb' : 'grk';
  const wi = origFocus?.word;
  // title words are numbered -1, -2… (the reader's interlinear opens them that way), verse words 0, 1, 2…
  const row = (w, i) => {
    const [o, tl, gl, s, m, lemma, typ] = w;
    // further lexical roots: a Greek compound (κἀκεῖνος = καί + ἐκεῖνος), a Hebrew name (אֲבִיעַד = H1 + H5703);
    // a Hebrew word's prefix morphemes (H90xx) are grammar, not lexicon entries
    const more = (w[7] || []).filter(x => (heb ? /^H\d/.test(x) && !/^H90\d\d$/.test(x) : /^G\d/.test(x)));
    // the language goes on its own chip, only on a word unlike its verse's (Daniel 2:4 turns from Hebrew to Aramaic)
    const wl = heb && m && isAramaicWord(w) !== aram ? (aram ? 'Hebrew' : 'Aramaic') : '';
    const variant = isVariantWord(typ), vl = variantShort(typ);
    const liCls = [variant ? 'variant' : '', wi === i ? 'focus' : ''].filter(Boolean).join(' ');
    return `<li${liCls ? ` class="${liCls}"` : ''} id="${i < 0 ? `wt${-i - 1}` : `w${i}`}" data-i="${i}">
      <div class="w-o ${cls}" lang="${lang}">${esc(o)}<span class="w-tl" lang="en">${esc(tl)}</span></div>
      <div class="w-g"><span class="w-gl">${esc(gl)}</span>${m ? `<span class="w-m">${esc((wl ? wl + ' · ' : '') + morphParts(morphNoLang(decodeMorph(m, heb))))}</span><span class="w-code">${esc(m)}</span>` : ''}${vl ? `<span class="w-var">${vl}</span>` : ''}</div>
      <div class="w-s">${s ? `<button class="strong" type="button" data-strong="${esc(s)}" aria-label="Strong’s ${esc(s)}${lemma ? ', ' + esc(lemma) : ''}">${esc(s)}</button>` : ''}${more.map(x => `<button class="strong" type="button" data-strong="${esc(x)}" aria-label="Strong’s ${esc(x)}">${esc(x)}</button>`).join('')}${lemma ? `<span class="w-lemma ${cls}" lang="${lang}">${esc(lemma)}</span>` : ''}</div>
    </li>`;
  };
  const rows = words.map((w, i) => row(w, i)).join('');
  const titleRows = title.map((w, i) => row(w, -(i + 1))).join('');
  return `${quote}
    <p class="lang-eyebrow">${aram ? 'Aramaic · Leningrad Codex' : heb ? 'Hebrew · Leningrad Codex' : 'Greek · all major editions'}</p>
    <p class="orig-line ${cls}" lang="${lang}" dir="${heb ? 'rtl' : 'ltr'}">${words.map((w, i) => `<button class="ow${isVariantWord(w[6]) ? ' variant' : ''}${wi === i ? ' on' : ''}" type="button" data-i="${i}" aria-label="${esc(w[1] + ': ' + w[2])}">${esc(w[0])}</button>`).join(' ')}</p>
    ${title.length ? `<div class="lh"><h3>Title</h3><span>the psalm’s heading · ${plural(title.length, 'word')}</span></div><ul class="group words">${titleRows}</ul>` : ''}
    <div class="lh"><h3>Word by word</h3><span>${plural(words.length, 'word')}</span></div>
    <ul class="group words">${rows}</ul>
    <p class="foot-note">${heb ? 'STEPBible TAHOT (CC BY 4.0).' : 'STEPBible TAGNT (CC BY 4.0). Amber words are textual variants between the Textus Receptus (KJV) and modern critical editions.'}<br>
      In the glosses, &lt;word&gt; = in the ${aram ? 'Aramaic' : heb ? 'Hebrew' : 'Greek'} but best left untranslated · [word] = supplied in English${heb ? ' · ¿ = marks a question' : ''}.</p>`;
}

async function strongView(s) {
  const heb = s[0] === 'H', lang = heb ? 'he' : 'grc', cls = heb ? 'heb' : 'grk';
  const [dict, occ] = await Promise.all([data.strongs(s[0]).catch(() => ({})), data.conc(s)]);
  const e = dict[s] || {};
  const counts = new Map(); occ.forEach(n => { const b = Math.floor(n / 1e6); counts.set(b, (counts.get(b) || 0) + 1); });
  const top = [...counts.entries()].filter(([b]) => bookOf(b)).sort((a, z) => z[1] - a[1]).slice(0, 10), mx = top[0]?.[1] || 1;
  const back = state.selected ? refLabel(state.book, state.chapter, state.selected) : 'Original';
  const nTitle = occ.filter(n => n % 1000 === 0).length, nVerse = occ.length - nTitle;   // verse 0: a psalm's title
  const count = [nVerse || !nTitle ? plural(nVerse, 'verse') : '', nTitle ? plural(nTitle, 'psalm title') : ''].filter(Boolean).join(' · ');
  const aram = heb && /^\(Aramaic\)/.test(String(e.d || ''));   // Strong's marks its Aramaic words in the derivation
  if (origFocus?.strong === s && !!origFocus.aram !== aram) { origFocus.aram = aram; renderHead(); }   // #drawer-sub says what the list header says
  const kvg = [];
  if (e.s) kvg.push(`<li><dl><dt>Definition</dt><dd>${esc(String(e.s).trim())}</dd></dl></li>`);
  if (e.k) kvg.push(`<li><dl><dt>KJV renders as</dt><dd>${esc(e.k)}</dd></dl></li>`);
  if (e.d) kvg.push(`<li><dl><dt>Derivation</dt><dd>${esc(e.d)}</dd></dl></li>`);
  return `<div class="navbar"><button class="back" type="button" data-back-orig>${icon('chev-left')}${esc(back)}</button></div>
    <div class="lex"><div class="lex-lemma ${cls}" lang="${lang}">${esc(e.l || s)}</div><div class="lex-meta">${e.x ? `<i>${esc(e.x)}</i>` : ''}${e.p ? `<span>${esc(e.p)}</span>` : ''}<span class="strong static">${esc(s)}</span></div></div>
    ${kvg.length ? `<ul class="group kvg">${kvg.join('')}</ul>` : ''}
    <div class="lh"><h3>${count}</h3><span>${aram ? 'Aramaic OT' : heb ? 'Hebrew OT' : 'Greek NT'}</span></div>
    ${top.length ? `<div class="dist" role="img" aria-label="Verses by book: ${esc(top.map(([b, n]) => `${bookOf(b).name} ${n}`).join(', '))}">${top.map(([b, n]) => `<div class="dist-row"><span>${esc(bookOf(b).name)}</span><span class="dist-t"><i style="width:${Math.max(3, Math.round(100 * n / mx))}%"></i></span><span class="dist-v">${n}</span></div>`).join('')}</div>` : ''}
    ${occ.length ? `<ul class="group occ" data-strong="${esc(s)}" data-shown="0"></ul><button class="btn btn-gray btn-wide" type="button" data-more-occ>Show more</button>` : ''}`;
}
async function renderOcc(ul, page = 20) {
  if (!ul || ul.dataset.loading) return;
  ul.dataset.loading = '1';
  try {
    const occ = ul.dataset.tags ? await taggedVerses(ul.dataset.tags) : await data.conc(ul.dataset.strong);
    const shown = +ul.dataset.shown || 0; const next = occ.slice(shown, shown + page);
    const refs = next.map(packedRef).filter(r => bookOf(r.b));
    // verse 0 is a psalm's title (its words are keyed 'c:0'): shown with the title's text, opening at verse 1
    const sup = refs.some(r => !r.v) ? ((await data.titles(previewTr(), 19).catch(() => ({}))).sup || {}) : {};
    const texts = await Promise.all(refs.map(r => (r.v ? previewText(r.b, r.c, r.v).then(p => p.text).catch(() => '') : sup[r.c] || '')));
    if (!ul.isConnected) return;
    const start = ul.children.length; // rows of unknown books are dropped, so the new rows are counted, not `shown`
    ul.insertAdjacentHTML('beforeend', refs.map((r, i) => { const t = clip(texts[i], 150); return `<li><button class="cell" type="button" data-go="${r.b}.${r.c}.${r.v || 1}"><span class="cell-body"><span class="cell-title">${esc(r.v ? refLabel(r.b, r.c, r.v) : `${refLabel(r.b, r.c)} (title)`)}</span>${t ? `<span class="cell-sub serif">${esc(t)}</span>` : ''}</span>${icon('chev-right', 'chev')}</button></li>`; }).join(''));
    ul.dataset.shown = String(shown + next.length);
    const more = ul.parentElement?.querySelector('[data-more-occ]');
    if (more) {
      const done = shown + next.length >= occ.length;
      // the focused button is about to hide: keep the keyboard in the list, on the first row it added
      if (done && document.activeElement === more) (ul.children[start]?.querySelector('button') || bodyEl())?.focus({ preventScroll: true });
      more.hidden = done;
    }
  } finally { delete ul.dataset.loading; }
}

// ------------------------------------------------------------ Notes
function notesTab(b, c, v, opts) {
  const key = refKey(b, c, v);
  const n = noteFor(key) || { text: '', highlight: '', tags: [], videos: [] };
  const text = n.text || '';
  if (key !== mdKey || opts.focus) { mdMode = (opts.focus || !text) ? 'write' : 'preview'; mdKey = key; }
  if (!text) mdMode = 'write';
  const preview = mdMode === 'preview';
  const tags = n.tags || [];
  const inCh = chapterEntries(b, c), all = allEntries();
  allLimit = ALL_PAGE;
  const sw = h => {
    const on = (n.highlight || '') === h; const label = h ? h[0].toUpperCase() + h.slice(1) : 'No highlight';
    return `<button class="sw sw-${h || 'none'}" type="button" role="radio" data-hl="${h}" aria-checked="${on}" tabindex="${on ? 0 : -1}" aria-label="${label}" title="${label}">${icon(h ? 'check' : 'slash')}</button>`;
  };
  // hosted, a guest's editor would save nothing: the sign-in prompt stands in its place (hosting brief §2)
  const ro = S.readOnlyGuest();
  const editor = ro ? `<section class="card note-card guest-save"><div class="empty"><span class="tile-i blue">${icon('lock')}</span><h4>Your notes</h4><p>${esc(S.SIGN_IN_MSG)}</p><button class="btn btn-primary sm" type="button" data-sign-in>Sign in</button></div></section>`
    : `<div class="scope"><span>${v ? 'Verse note' : 'Chapter note'}</span><button class="link" type="button" data-scope>${v ? 'Switch to chapter note' : 'Select a verse for a verse note'}</button></div>
    <section class="card note-card">
      ${v ? `<div class="hl-row"><span id="hl-l">Highlight</span><div class="swatches" role="radiogroup" aria-labelledby="hl-l">${HL.map(sw).join('')}${sw('')}</div></div>` : ''}
      <div class="editor"><div class="editor-top"><span>Markdown</span><div class="segmented sm" id="md-mode" role="radiogroup" aria-label="Editor mode"><span class="seg-ind" aria-hidden="true"></span><button type="button" role="radio" data-mode="write" aria-checked="${!preview}" tabindex="${preview ? -1 : 0}">Write</button><button type="button" role="radio" data-mode="preview" aria-checked="${preview}" tabindex="${preview ? 0 : -1}"${text ? '' : ' disabled'}>Preview</button></div></div>
        ${preview ? `<div class="md" data-md>${renderMd(text)}</div>` : `<textarea id="note-text" class="note-text" aria-label="Note" maxlength="100000" placeholder="Write your note… Link verses like [[Romans 5:8]].">${esc(text)}</textarea>`}</div>
      <div class="tokens" id="tokens">${icon('tag')}${tags.map(t => `<span class="token">#${esc(t)}<button type="button" data-untag="${esc(t)}" aria-label="Remove tag ${esc(t)}">${icon('xmark')}</button></span>`).join('')}<input id="note-tags" placeholder="${tags.length ? 'Add tag' : 'Add tags'}" aria-label="Add a tag, then press Return" autocomplete="off" spellcheck="false"></div>
    </section>`;
  return `${editor}
    ${v ? markSecHtml(b, c, v) : ''}
    <div class="lh"><h3>Notes in ${esc(refLabel(b, c))}</h3><span id="ch-notes-n">${inCh.length}</span></div>
    <ul class="group" id="ch-notes">${inCh.map(entryRow).join('') || NONE_YET}</ul>
    <details class="disclosure"><summary>All notes <span class="disc-meta"><span id="all-notes-n">${all.length}</span>${icon('chev-right', 'chev')}</span></summary>
      <label class="field">${icon('search')}<input id="notes-filter" placeholder="Filter by text, colour or #tag" aria-label="Filter notes, highlights and comments" autocomplete="off"></label>
      ${allNotesHtml(all, '', ALL_PAGE)}</details>
    ${ro ? '' : `<div class="export-row"><button class="btn btn-tinted sm" type="button" data-export-obsidian>${icon('export')}Export for Obsidian</button><button class="btn btn-tinted sm" type="button" data-export-json>${icon('export')}Export JSON</button><button class="btn btn-tinted sm" type="button" data-import-json>${icon('import')}Import JSON</button><input type="file" id="import-json" accept="application/json" hidden></div>`}`;
}
const ALL_PAGE = 200;
const NONE_YET = '<li class="cell"><span class="cell-sub">None yet.</span></li>';
let allLimit = ALL_PAGE; // the All notes rows shown (Show more adds a page)
// The lists hold notes as [key, note] and highlights and comments (marks.js) as {mk}, side by side
const entryRow = e => (Array.isArray(e) ? noteRow(e) : markRow(e.mk));
const entryT = e => (Array.isArray(e) ? e[1].updated || 0 : e.mk.updated || 0);
/** A chapter's notes and marks by verse (a verse's note first, its marks in text order). */
function chapterEntries(b, c) {
  const vOf = e => (Array.isArray(e) ? +e[0].split('.')[2] || 0 : +e.mk.start.split('.')[2] || 0);
  const notes = Object.entries(state.notes.refs).filter(([k]) => k === `${b}.${c}` || k.startsWith(`${b}.${c}.`));
  const mks = mrk ? (safe(mrk.marksInChapter, b, c) || []).map(mk => ({ mk })) : [];
  return [...notes, ...mks].sort((x, z) => vOf(x) - vOf(z));
}
/** Every note and mark, the most recently changed first. */
function allEntries() {
  const mks = mrk && mrk.marks ? [...mrk.marks.byId.values()].map(mk => ({ mk })) : [];
  return [...Object.entries(state.notes.refs), ...mks].sort((x, z) => entryT(z) - entryT(x));
}
/** What the filter matches: a note's reference, text and #tags; a mark's reference, words, comment, colour and translation. */
function entryText(e) {
  if (!Array.isArray(e)) {
    const m = e.mk, p = m.start.split('.').map(Number); if (!bookOf(p[0])) return '';
    return [safe(mrk && mrk.markLabel, m) || '', `${bookOf(p[0]).name} ${p[1]}:${p[2]}`, m.quote, m.note, m.color, m.color ? 'highlight' : 'underlined', m.note ? 'comment' : '', trInfo(m.tr).abbr].join(' ');
  }
  const [k, x] = e, p = k.split('.').map(Number); if (!bookOf(p[0])) return '';
  return [refLabel(p[0], p[1], p[2]), p[2] ? `${bookOf(p[0]).name} ${p[1]}:${p[2]}` : `${bookOf(p[0]).name} ${p[1]}`, x.text || '', ...(x.tags || []).map(t => '#' + t)].join(' ');
}
/** Notes and marks matching a filter, over all of them, not just the rows on screen. */
function filterNotes(all, q) {
  q = q.toLowerCase().trim(); if (!q) return all;
  return all.filter(e => entryText(e).toLowerCase().includes(q));
}
function allNotesHtml(all, q, limit) {
  const hits = filterNotes(all, q), rest = hits.length - limit;
  return `<ul class="group" id="all-notes">${hits.slice(0, limit).map(entryRow).join('') || '<li class="cell"><span class="cell-sub">No notes match.</span></li>'}</ul>
    <p class="foot-note" id="all-notes-foot"${rest > 0 ? '' : ' hidden'}>Showing ${Math.min(limit, hits.length).toLocaleString()} of ${hits.length.toLocaleString()} <button class="link" type="button" data-more-notes="${limit + ALL_PAGE}">Show more</button></p>`;
}
function redrawAllNotes(root, limit) {
  const ul = $('#all-notes', root); if (!ul) return;
  allLimit = limit;
  const foot = $('#all-notes-foot', root), hadFocus = !!foot?.contains(document.activeElement), start = ul.children.length, row = rowSel(ul);
  foot?.remove();
  const all = allEntries();
  ul.outerHTML = allNotesHtml(all, $('#notes-filter', root)?.value || '', limit);
  setText('all-notes-n', String(all.length));
  // 'Show more' was focused and is replaced: focus the new one, else (all shown) the first row it added
  if (hadFocus) ($('#all-notes-foot:not([hidden]) [data-more-notes]', root) || $('#all-notes', root)?.children[start]?.querySelector('.cell') || bodyEl())?.focus({ preventScroll: true });
  else if (row) $(`#all-notes ${row}`, root)?.focus({ preventScroll: true });
}
/** The focused row of a list (by its data-go or data-mk-go), to focus again once the list is drawn again; null when the focus is elsewhere. */
function rowSel(box) {
  const r = box && box.contains(document.activeElement) ? document.activeElement.closest('[data-go], [data-mk-go]') : null;
  return r ? (r.dataset.mkGo ? `[data-mk-go="${CSS.escape(r.dataset.mkGo)}"]` : `[data-go="${CSS.escape(r.dataset.go)}"]`) : null;
}
/** One highlight or comment in a list: its colour, reference, words and comment; it opens the words in the text. */
function markRow(m) {
  const p = m.start.split('.').map(Number); if (!bookOf(p[0])) return '';
  const q = clip(m.quote.replace(/\s+/g, ' ').trim(), 70);
  const snip = m.note ? clip(String(m.note).replace(/[*_#>`[\]]/g, '').replace(/\s+/g, ' ').trim(), 70) : '';
  const sub = `“${q}”${snip ? ' · ' + snip : ''}${m.tr !== state.tr ? ' · ' + trInfo(m.tr).abbr : ''}`;
  const kind = m.color ? `${m.color[0].toUpperCase() + m.color.slice(1)} highlight` : 'Comment';
  return `<li><button class="cell" type="button" data-mk-go="${esc(m.id)}"><span class="hdot mkdot${m.color ? '' : ' none'}" data-mk-color="${esc(m.color)}" aria-hidden="true"></span><span class="cell-body"><span class="cell-title">${esc(safe(mrk && mrk.markLabel, m) || refLabel(p[0], p[1], p[2]))}</span><span class="cell-sub"><span class="sr">${kind}: </span>${esc(sub)}</span></span>${icon('chev-right', 'chev')}</button></li>`;
}
/** The selected verse's highlights and comments, in any translation (under the note editor). */
function markSecHtml(b, c, v) {
  if (!mrk) return '';
  const list = safe(mrk.marksFor, b, c, v) || [];
  if (S.readOnlyGuest() && !list.length) return ''; // a hosted guest has the sign-in card above instead
  return `<section class="mk-sec" id="mk-sec" aria-labelledby="mk-h" tabindex="-1"><div class="lh"><h3 id="mk-h">Highlights and comments</h3><span>${list.length || ''}</span></div>
    ${list.length ? `<ul class="group mk-list">${list.map(m => safe(mrk.markCardHtml, m) || '').join('')}</ul>` : '<p class="foot-note mk-empty">Select words in the verse to highlight them or add a comment.</p>'}</section>`;
}
/** Marks changed (or were drawn again, or marks.js loaded): the Notes tab's count, its verse group and its lists, in place. */
let nmQueued = false;
function queueNoteMarks() { if (nmQueued) return; nmQueued = true; Promise.resolve().then(() => { nmQueued = false; refreshNoteMarks(); }); }
function refreshNoteMarks() {
  renderNotesCount();
  const root = bodyEl(); if (!root || state.drawerTab !== 'notes' || !$('#ch-notes', root)) return;
  const b = state.book, c = state.chapter, v = state.selected, ae = document.activeElement;
  const sec = $('#mk-sec', root);
  if (v && mrk) {
    const li = sec && sec.contains(ae) ? ae.closest('[data-mk]') : null;
    const was = sec && sec.contains(ae) ? { id: li && li.dataset.mk, at: ['data-mk-show', 'data-mk-edit', 'data-mk-del', 'data-mk-more'].find(a => ae.hasAttribute(a)), i: li ? $$('[data-mk]', sec).indexOf(li) : -1 } : null;
    if (sec) sec.outerHTML = markSecHtml(b, c, v); else $('.note-card', root)?.insertAdjacentHTML('afterend', markSecHtml(b, c, v));
    const ns = $('#mk-sec', root);
    if (ns) {
      safe(mrk.foldNotes, ns);
      if (was) {
        const cards = $$('[data-mk]', ns), card = cards.find(x => x.dataset.mk === was.id) || cards[Math.min(was.i, cards.length - 1)];
        ((card && was.at && card.querySelector(`[${was.at}]:not([hidden])`)) || card?.querySelector('[data-mk-show]') || ns).focus({ preventScroll: true });
      }
    }
  }
  const ul = $('#ch-notes', root), row = rowSel(ul), inCh = chapterEntries(b, c);
  ul.innerHTML = inCh.map(entryRow).join('') || NONE_YET;
  setText('ch-notes-n', String(inCh.length));
  if (row) $(`#ch-notes ${row}`, root)?.focus({ preventScroll: true });
  redrawAllNotes(root, allLimit);
}
/** A highlight or comment's buttons in the Notes tab. */
function onMarkAction(btn) {
  const d = btn.dataset;
  if (d.mkMore !== undefined) { safe(mrk.toggleFold, btn); return; }
  if (d.mkGo) { A.yieldToPage(); safe(mrk.revealMark, d.mkGo, { select: true }); return; }
  if (d.mkShow) { A.yieldToPage(); safe(mrk.revealMark, d.mkShow); return; }
  if (d.mkDel) { safe(mrk.deleteMark, d.mkDel); return; }
  if (d.mkEdit) {
    const m = safe(mrk.getMark, d.mkEdit); if (!m) return;
    A.yieldToPage(); // the comment card goes over the words: a phone's sheet comes down, an overlay closes
    const back = state.drawerOpen && btn.isConnected && !document.body.classList.contains('sheet-modal') ? btn : document.getElementById('v' + (+m.start.split('.')[2] || 0));
    safe(mrk.openCommentCard, m.id, { returnFocus: back });
  }
}
function noteRow([k, x]) {
  const p = k.split('.').map(Number);
  if (!bookOf(p[0])) return '';
  const snip = clip(String(x.text || '').replace(/[*_#>`[\]]/g, '').replace(/\s+/g, ' ').trim(), 90);
  const tags = x.tags || [], vids = x.videos || [];
  const bits = [snip || (x.highlight ? 'Highlighted' : ''), tags.length ? tags.map(t => '#' + t).join(' ') : '', vids.length ? plural(vids.length, 'video') : ''].filter(Boolean);
  return `<li><button class="cell" type="button" data-go="${esc(k)}"><span class="hdot${x.highlight ? ' ' + esc(x.highlight) : ''}" aria-hidden="true"></span><span class="cell-body"><span class="cell-title">${esc(refLabel(p[0], p[1], p[2]))}</span>${bits.length ? `<span class="cell-sub">${esc(bits.join(' · '))}</span>` : ''}</span>${icon('chev-right', 'chev')}</button></li>`;
}
/**
 * Note Markdown → HTML. Tokenised on the raw text: every piece is escaped on its own and output is never
 * re-scanned, so note text cannot inject markup or attributes. Supports # headings, - lists, > quotes,
 * **bold**, *italic*, `code`, [text](https://…) and verse links [[Romans 5:8]] / [[John 3.16|John 3:16]] (Obsidian).
 */
export function renderMd(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = []; let para = [], list = [], quote = [];
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(mdInline).join('<br>')}</p>`); para = []; };
  const flushList = () => { if (list.length) out.push(`<ul>${list.map(x => `<li>${mdInline(x)}</li>`).join('')}</ul>`); list = []; };
  const flushQuote = () => { if (quote.length) out.push(`<blockquote>${quote.map(mdInline).join('<br>')}</blockquote>`); quote = []; };
  const flush = () => { flushPara(); flushList(); flushQuote(); };
  for (const line of lines) {
    let m;
    if (!line.trim()) flush();
    else if ((m = line.match(/^(#{1,3}) (.*)$/))) { flush(); out.push(`<h${m[1].length + 1}>${mdInline(m[2])}</h${m[1].length + 1}>`); }
    else if ((m = line.match(/^[-*] (.*)$/))) { flushPara(); flushQuote(); list.push(m[1]); }
    else if ((m = line.match(/^> ?(.*)$/))) { flushPara(); flushList(); quote.push(m[1]); }
    else { flushList(); flushQuote(); para.push(line); }
  }
  flush();
  return out.join('');
}
const MD_INLINE = [
  { rx: /`([^`]+)`/, html: m => `<code>${esc(m[1])}</code>` },
  { rx: /\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/, html: m => `<a class="vlink" data-ref="${esc(m[1].trim())}" role="link" tabindex="0">${esc((m[2] || m[1]).trim())}</a>` },
  { rx: /\[([^\[\]]+)\]\((https?:\/\/[^\s()<>"'`]+)\)/, html: m => `<a href="${esc(m[2])}" target="_blank" rel="noopener">${esc(m[1])}</a>` },
  { rx: /\*\*(.+?)\*\*/, html: m => `<b>${mdInline(m[1])}</b>` },
  { rx: /(^|[^\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w*])/, lead: 1, html: m => `<i>${mdInline(m[2])}</i>` },
];
/** One line of inline Markdown: the earliest token wins; text between tokens is escaped. */
function mdInline(s) {
  let out = '';
  while (s) {
    let best = null;
    for (const t of MD_INLINE) {
      const m = t.rx.exec(s); if (!m) continue;
      const at = m.index + (t.lead ? m[t.lead].length : 0);
      if (!best || at < best.at) best = { t, m, at };
    }
    if (!best) { out += esc(s); break; }
    out += esc(s.slice(0, best.at)) + best.t.html(best.m);
    s = s.slice(best.m.index + best.m[0].length);
  }
  return out;
}

function currentKey() { return refKey(state.book, state.chapter, state.selected); }
/** Refresh reader markers + tab badges for a note key that may belong to another chapter. */
function refreshMarkerFor(k) {
  const p = k.split('.').map(Number);
  A.refreshMarker(p[0] === state.book && p[1] === state.chapter ? (p[2] || null) : null);
}
const TAG_MAX = 64, TAGS_MAX = 50;
/** "Export for Obsidian": the zip is what serve.py has saved, so unsent edits are sent first (store.js). */
let exporting = false;
async function exportObsidian() {
  if (exporting) return;
  exporting = true;
  try {
    const r = await S.exportObsidian();
    if (r.dry) A.toast('Dry run: exports are turned off.');
    else if (r.lost) {
      const u = state.auth.user || {};
      A.toast(`You’ve been signed out. Sign in to export ${u.name ? u.name + '’s' : 'your'} notes.`, { label: 'Sign in', run: () => import('./account.js').then(m => m.openAuth?.('signin', { email: u.email || '', reason: 'lost' })).catch(() => {}) });
    } else if (r.offline) A.toast(S.offlineMsg());
    else if (!r.ok && !r.mismatch) A.toast(`Export failed${r.data?.message ? ': ' + r.data.message : '.'}`);
    else if (r.pending) A.toast(`This export is missing ${plural(r.pending, 'unsaved change')}. Try again once your notes are saved.`);
  } finally { exporting = false; }
}
function retag() { return renderDrawer({ keepScroll: true }).then(() => document.getElementById('note-tags')?.focus({ preventScroll: true })); }

function bindNotes(root, opts) {
  const key = currentKey();
  if (opts.focus && S.readOnlyGuest()) $('[data-sign-in]', root)?.focus({ preventScroll: true }); // 'n' on a hosted site
  const ta = $('#note-text', root);
  if (ta) {
    const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.max(140, ta.scrollHeight + 2) + 'px'; };
    ta.addEventListener('input', () => {
      const n = noteFor(key, true); n.text = ta.value; touchNote(key); A.refreshMarker(state.selected);
      const p = $('#md-mode [data-mode="preview"]', root); if (p) p.disabled = !ta.value;
      fit();
    });
    fit();
    if (opts.focus) { ta.focus({ preventScroll: true }); const L = ta.value.length; try { ta.setSelectionRange(L, L); } catch (e) { /* ignore */ } }
  }
  const tin = $('#note-tags', root);
  tin?.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const t = tin.value.replace(/,/g, '').trim().replace(/^#+/, '').trim(); if (!t) return;
      // serve.py's limits (64 characters, 50 tags), said here rather than cut silently on save
      if ([...t].length > TAG_MAX) { A.toast(`Tags can be up to ${TAG_MAX} characters.`); return; }
      const cur = noteFor(key);
      if (!(cur?.tags || []).includes(t) && (cur?.tags || []).length >= TAGS_MAX) { A.toast(`Up to ${TAGS_MAX} tags per note.`); return; }
      const n = noteFor(key, true); if (!n.tags.includes(t)) n.tags.push(t);
      touchNote(key); A.refreshMarker(state.selected); retag();
    } else if (e.key === 'Backspace' && !tin.value && !e.repeat) { // held down to clear a draft: never eats the tags too
      const n = noteFor(key); if (!n || !(n.tags || []).length) return;
      e.preventDefault(); const gone = n.tags.pop(); touchNote(key); A.refreshMarker(state.selected); retag();
      A.toast(`Removed #${gone}.`, { label: 'Undo', run: () => {
        const m = noteFor(key, true); if (!m.tags.includes(gone)) m.tags.push(gone);
        touchNote(key); refreshMarkerFor(key); if (currentKey() === key) retag();
      } });
    }
  });
  $('#notes-filter', root)?.addEventListener('input', () => redrawAllNotes(root, ALL_PAGE));
  $('#import-json', root)?.addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!j || typeof j.refs !== 'object' || Array.isArray(j.refs)) throw new Error('not a notes file');
      const { refs, snapshot, merged, same } = mergeImport(j.refs);
      const n = S.importNotes(refs), skipped = Object.keys(j.refs).length - n - same;
      A.rerender();
      const bits = [merged ? `${plural(merged, 'note')} merged with yours` : '', same ? `${plural(same, 'note')} already up to date` : '', skipped ? `${plural(skipped, 'entry', 'entries')} skipped` : ''].filter(Boolean);
      A.toast(`Imported ${plural(n, 'note')}${bits.length ? ` (${bits.join(', ')})` : ''}.`, n ? { label: 'Undo', run: () => { S.restoreNotes(snapshot); A.rerender(); } } : undefined);
    } catch (err) { A.toast('Import failed: ' + err.message); }
    e.target.value = '';
  });
}

/**
 * Imported notes merged with the ones already here: differing text is appended, tags and videos are combined,
 * the existing highlight and creation time stay unless the import adds one. Returns the refs to write, a snapshot
 * of the replaced notes (null = none existed) for Undo, how many were merged and how many were already the same.
 */
function mergeImport(incoming) {
  const refs = {}, snapshot = {}; let merged = 0, same = 0;
  for (const [k0, inc] of Object.entries(incoming || {})) {
    const k = S.canonicalKey(k0); if (!k || !inc || typeof inc !== 'object' || Array.isArray(inc)) continue;
    const cur = state.notes.refs[k];
    // a note already here as it is (re-importing your own export) is left alone: its time stays, nothing is re-sent
    if (cur && !S.notesDiffer(cur, inc)) { same++; continue; }
    snapshot[k] = cur ? JSON.parse(JSON.stringify(cur)) : null;
    if (!cur) { refs[k] = inc; continue; }
    const a = String(cur.text || '').trim(), b = String(inc.text || '').trim();
    const vids = [...(cur.videos || [])];
    for (const x of Array.isArray(inc.videos) ? inc.videos : []) if (!vids.some(y => y.id === x.id && (+y.start || 0) === (+x.start || 0))) vids.push(x);
    refs[k] = { ...inc, text: !b || a.includes(b) ? a : !a || b.includes(a) ? b : `${a}\n\n${b}`,
      tags: [...new Set([...(cur.tags || []), ...(Array.isArray(inc.tags) ? inc.tags : [])])], videos: vids,
      highlight: inc.highlight || cur.highlight || '', created: cur.created || inc.created };
    if (!S.notesDiffer(cur, refs[k])) { delete refs[k]; delete snapshot[k]; same++; continue; } // an older copy: nothing new
    merged++;
  }
  return { refs, snapshot, merged, same };
}

// ------------------------------------------------------------ Video
/** A YouTube link in any common form → {id, start}; null for anything else (including look-alike hosts). */
export function parseYouTube(url) {
  try {
    let raw = String(url || '').trim(); if (!raw) return null;
    if (!/^[a-z][\w+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;   // 'youtu.be/ID', 'www.youtube.com/watch?v=ID'
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.toLowerCase();
    let id = '';
    if (/^(?:www\.)?youtu\.be$/.test(host)) id = u.pathname.slice(1).split('/')[0];
    else if (/^(?:[\w-]+\.)*youtube(?:-nocookie)?\.com$/.test(host)) {
      if (u.searchParams.get('v')) id = u.searchParams.get('v');
      else { const m = u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})(?:\/|$)/); if (m) id = m[1]; }
    }
    // a video id is exactly 11 characters; 'videoseries' (a playlist embed) and 'live_stream' (a channel) are not videos
    if (!/^[\w-]{11}$/.test(id) || /^(?:videoseries|live_stream)$/i.test(id)) return null;
    const hash = new URLSearchParams(u.hash.slice(1));
    const t = u.searchParams.get('t') || u.searchParams.get('start') || u.searchParams.get('time_continue') || hash.get('t') || '';
    return { id, start: parseTime(t) };
  } catch (e) { return null; }
}
/** '90', '90s', '1m30s', '1h2m', '1:30', '1:02:03' → seconds; null for anything else ('1.30', '1:3o', '1:75'). */
function strictTime(t) {
  t = String(t || '').replace(/\s+/g, '').toLowerCase(); if (!t) return null;
  const c = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (c) return +c[3] < 60 && (!c[1] || +c[2] < 60) ? (+c[1] || 0) * 3600 + +c[2] * 60 + +c[3] : null;
  const m = t.match(/^(?=\d)(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : null;
}
/** A link's t= / start= value → seconds (0 when it can't be read). */
function parseTime(t) { const s = strictTime(t); return s !== null ? s : parseInt(String(t || ''), 10) || 0; }
const fmtTs = s => {
  s = Math.floor(+s || 0); if (!s) return '';
  const mm = Math.floor(s % 3600 / 60), ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
};
const watchUrl = vid => `https://www.youtube.com/watch?v=${encodeURIComponent(vid.id || '')}${+vid.start ? `&t=${+vid.start}s` : ''}`;

/** What identifies a saved video in the list (its array index alone shifts when another window edits the list). */
const vidSig = x => [x.id || '', +x.start || 0, +x.added || 0, x.title || ''].join('|');
/** Index of the video a list row shows, in the current data; -1 when it is gone (changed in another window). */
function rowVideo(k, idx, sig) {
  const vs = (noteFor(k) || {}).videos || [];
  return vs[idx] && vidSig(vs[idx]) === sig ? idx : vs.findIndex(x => vidSig(x) === sig);
}
/** True when the Video tab on screen lists other videos for any of these note keys than the data now holds. */
export function videosStale(keys) {
  const el = bodyEl(); if (!el || state.drawerTab !== 'media') return false;
  return (keys || []).some(k => {
    const shown = $$(`.video[data-k="${CSS.escape(k)}"]`, el).map(li => li.dataset.sig);
    const now = ((noteFor(k) || {}).videos || []).map(vidSig);
    return shown.length !== now.length || shown.some((x, i) => x !== now[i]);
  });
}

function mediaTab(b, c, v) {
  const key = refKey(b, c, v);
  // a half-typed link survives a redraw (a video removed here or in another window)
  const old = $('#video-form', bodyEl()), draft = n => old && old.elements[n] ? esc(old.elements[n].value) : '';
  const groups = [];
  const collect = (label, pred) => { const items = []; Object.entries(state.notes.refs).forEach(([k, n]) => { if (pred(k)) (n.videos || []).forEach((vid, i) => items.push({ k, i, ...vid })); }); if (items.length) groups.push({ label, items }); };
  if (v) collect('This verse', k => k === key);
  collect('This chapter', k => (k === `${b}.${c}` || k.startsWith(`${b}.${c}.`)) && (!v || k !== key));
  collect(`Rest of ${bookOf(b).name}`, k => k.startsWith(`${b}.`) && !(k === `${b}.${c}` || k.startsWith(`${b}.${c}.`)));
  collect('Everything else', k => !k.startsWith(`${b}.`));
  const list = groups.map(g => `<div class="lh"><h3>${esc(g.label)}</h3><span>${g.items.length}</span></div><ul class="group">${g.items.map(x => {
    const p = x.k.split('.').map(Number); const title = x.title || x.url || 'Video';
    return `<li class="video" data-k="${esc(x.k)}" data-i="${x.i}" data-sig="${esc(vidSig(x))}">
      <button class="cell" type="button" data-play="${esc(x.id)}" data-start="${+x.start || 0}"><span class="thumb"><img src="https://i.ytimg.com/vi/${encodeURIComponent(x.id || '')}/mqdefault.jpg" alt="" loading="lazy"><span class="play">${icon('play', 'f')}</span></span><span class="cell-body"><span class="cell-title">${esc(title)}</span><span class="cell-sub">${bookOf(p[0]) ? esc(refLabel(p[0], p[1], p[2])) : ''}${x.start ? ' · from ' + fmtTs(+x.start) : ''}</span></span></button>
      <button class="more-btn" type="button" data-menu aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ${esc(title)}">${icon('ellipsis')}</button>
    </li>`; }).join('')}</ul>`).join('');
  // hosted, a guest's form would save nothing: the same sign-in card as the Notes tab stands in its place (hosting brief §2)
  if (S.readOnlyGuest()) {
    return `<section class="card note-card guest-save"><div class="empty"><span class="tile-i blue">${icon('lock')}</span><h4>Your videos</h4><p>${esc(S.SIGN_IN_MSG)}</p><button class="btn btn-primary sm" type="button" data-sign-in>Sign in</button></div></section>${list}`;
  }
  return `<form id="video-form" class="card form-card" novalidate>
      <label class="field" id="url-field">${icon('link')}<input name="url" value="${draft('url')}" placeholder="YouTube link: watch, youtu.be, shorts" aria-label="YouTube link" aria-describedby="url-msg" autocomplete="off" spellcheck="false"></label>
      <p class="field-msg" id="url-msg" hidden>That doesn’t look like a YouTube link.</p>
      <div class="field-row"><label class="field"><input name="title" value="${draft('title')}" placeholder="Title (optional)" aria-label="Title" maxlength="300"></label><label class="field" id="ts-field"><input name="ts" value="${draft('ts')}" placeholder="0:00" aria-label="Start time, like 1:30 or 1m30s" aria-describedby="ts-msg" autocomplete="off" spellcheck="false"></label></div>
      <p class="field-msg" id="ts-msg" hidden>Use a start time like 1:30 or 1m30s.</p>
      <button class="btn btn-primary btn-wide" type="submit">${icon('plus')}Add to ${esc(refLabel(b, c, v))}</button>
    </form>
    ${list || emptyState('play-rect', 'No videos yet', 'Paste a YouTube link above. It plays right here, next to the text.')}`;
}

function bindMedia(root) {
  const form = $('#video-form', root), field = $('#url-field', root), msg = $('#url-msg', root);
  const input = field && $('input', field);
  const tsField = $('#ts-field', root), tsMsg = $('#ts-msg', root), tsInput = tsField && $('input', tsField);
  const flag = (f, m, i) => { f.classList.remove('bad'); void f.offsetWidth; f.classList.add('bad'); m.hidden = false; i.setAttribute('aria-invalid', 'true'); i.focus(); };
  const clear = (f, m, i) => { f.classList.remove('bad'); m.hidden = true; i.removeAttribute('aria-invalid'); };
  form?.addEventListener('submit', e => {
    e.preventDefault();
    if (S.guestBlocked()) return; // a hosted site's guest: the link stays in the field
    const fd = new FormData(form); const url = String(fd.get('url') || '').trim();
    const yt = parseYouTube(url);
    if (!yt) {
      msg.textContent = /[?&]list=|\/videoseries\b/i.test(url) ? 'Playlists aren’t supported. Paste a single video link.' : 'That doesn’t look like a YouTube link.';
      flag(field, msg, input); return;
    }
    // an empty start field keeps the link's own t=; one that can't be read is flagged, never saved as 0
    const ts = String(fd.get('ts') || '').trim(); const start = ts ? strictTime(ts) : yt.start;
    if (start === null) { flag(tsField, tsMsg, tsInput); return; }
    const key = currentKey(); const n = noteFor(key, true);
    const title = String(fd.get('title') || '').trim();
    n.videos.push({ url, id: yt.id, start, title, added: Date.now() });
    $$('input', form).forEach(i => { i.value = ''; }); // the redraw below carries over what the fields hold
    touchNote(key); A.refreshMarker(state.selected); renderDrawer({ keepScroll: true });
    document.dispatchEvent(new CustomEvent('bs:video-added', { detail: { key, title } }));
  });
  input?.addEventListener('input', () => clear(field, msg, input));
  tsInput?.addEventListener('input', () => clear(tsField, tsMsg, tsInput));
}

/** No YouTube thumbnail (error, or the 120px grey placeholder): warm gradient art with the title. */
function thumbFallback(e) {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.closest('.thumb')) return;
  if (e.type === 'load' && img.naturalWidth !== 120) return;
  const thumb = img.closest('.thumb');
  const title = img.closest('.cell')?.querySelector('.cell-title')?.textContent || '';
  img.remove(); thumb.classList.add('art');
  if (!thumb.querySelector('.thumb-t')) thumb.insertAdjacentHTML('beforeend', `<span class="thumb-t">${esc(title)}</span>`);
}

// ------------------------------------------------------------ ⋯ menu (video actions)
let menuEl = null;
export const menuOpen = () => !!menuEl;
export function closeMenu(restoreFocus = true) {
  if (!menuEl) return;
  const opener = menuEl._opener; menuEl.remove(); menuEl = null;
  if (opener) { opener.setAttribute('aria-expanded', 'false'); if (restoreFocus && opener.isConnected) opener.focus({ preventScroll: true }); }
}
/** Put the (fixed) menu under its ⋯ button, or above it when there is no room below. */
function placeMenu(m) {
  const r = m._opener.getBoundingClientRect(), mr = m.getBoundingClientRect(), up = r.bottom + mr.height + 8 > innerHeight;
  m.style.left = Math.max(8, Math.min(r.right - mr.width, innerWidth - mr.width - 8)) + 'px';
  m.style.top = (up ? Math.max(8, r.top - mr.height - 6) : r.bottom + 6) + 'px';
  m.style.transformOrigin = up ? 'bottom right' : '';
}
function openMenu(btn) {
  if (menuEl && menuEl._opener === btn) { closeMenu(); return; }
  closeMenu(false);
  const li = btn.closest('.video'); if (!li) return;
  const k = li.dataset.k, sig = li.dataset.sig;
  // the list may be older than the data (another window changed it): never act on the video now at that index
  const gone = () => { A.toast('That video changed in another window. The list is up to date now.'); renderDrawer({ keepScroll: true }); };
  const idx = rowVideo(k, +li.dataset.i, sig); if (idx < 0) { gone(); return; }
  const vid = noteFor(k).videos[idx];
  const m = document.createElement('div');
  m.className = 'menu'; m.setAttribute('role', 'menu'); m.setAttribute('aria-label', 'Video actions'); m._opener = btn;
  m.innerHTML = `<button type="button" role="menuitem" data-mi="go">Go to passage${icon('arrow-right')}</button><a role="menuitem" href="${esc(watchUrl(vid))}" target="_blank" rel="noopener">Open on YouTube${icon('external')}</a><hr><button type="button" role="menuitem" class="danger" data-mi="del">Remove${icon('trash')}</button>`;
  document.body.appendChild(m); menuEl = m; btn.setAttribute('aria-expanded', 'true');
  placeMenu(m);
  m.querySelector('[role=menuitem]')?.focus();
  m.addEventListener('click', e => {
    const it = e.target.closest('[data-mi]');
    if (!it) { if (e.target.closest('a')) closeMenu(false); return; }
    if (it.dataset.mi === 'go') {
      closeMenu(false); const p = k.split('.').map(Number);
      A.navigate(p[0], p[1], p[2] || 0); A.yieldToPage();
    } else if (it.dataset.mi === 'del') {
      closeMenu(false);
      const nn = noteFor(k), at = rowVideo(k, idx, sig); if (!nn || at < 0) { gone(); return; }
      const removed = nn.videos.splice(at, 1)[0];
      // focus moves to the video now in its place (or the one before), or to the link field when none are left
      const next = el => { const vs = $$(`.video[data-k="${CSS.escape(k)}"] [data-menu]`, el); return vs[Math.min(at, vs.length - 1)] || $$('.video [data-menu]', el)[0] || $('#video-form input', el); };
      touchNote(k); refreshMarkerFor(k); renderDrawer({ keepScroll: true, focusTo: next });
      A.toast('Video removed.', { label: 'Undo', run: () => {
        const back = noteFor(k, true); back.videos.splice(Math.min(at, back.videos.length), 0, removed);
        touchNote(k); refreshMarkerFor(k);
        if (state.drawerTab === 'media') renderDrawer({ keepScroll: true, focusTo: el => $(`.video[data-k="${CSS.escape(k)}"][data-i="${at}"] [data-menu]`, el) });
      } });
    }
  });
  m.addEventListener('keydown', e => {
    const items = $$('[role=menuitem]', m), i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
  });
}

// ------------------------------------------------------------ after-render wiring
function afterRender(opts) {
  const root = bodyEl(); if (!root) return;
  observeSegs(root);
  const tab = state.drawerTab;
  if (tab === 'xref') {
    fillPreviews(root);
    const cm = $('#canon-mini', root);
    if (cm && state.selected) {
      const b = state.book, c = state.chapter, v = state.selected;
      data.xref(b).then(xr => { if (cm.isConnected) safe(viz.renderCanonStrip, cm, xr[`${c}:${v}`] || [], { onPick: pickXref }); }).catch(() => {});
    }
    if (opts.expand) {
      const [b, c, v] = String(opts.expand).split('.').map(Number);
      const li = $$('.xref', root).find(l => +l.dataset.b === b && +l.dataset.c === c && +l.dataset.v === v);
      if (li) {
        if (li.hidden) { state.xfilter = 'all'; applyFilter(); }
        expandXref(li).then(() => setTimeout(() => scrollInSheet(li, 'center'), 80));
      }
    }
  }
  if (tab === 'context') {
    const tl = $('#timeline', root);
    if (tl) { let args = null; try { args = JSON.parse(tl.dataset.args || 'null'); } catch (e) { /* ignore */ } if (args) safe(viz.renderTimeline, tl, args); }
    const mm = $('#mini-map', root); if (mm && viz.miniMap) safe(viz.miniMap.mount?.bind(viz.miniMap), mm);
    if (opts.intro) setTimeout(() => { const ic = $('#intro-card', root); if (ic && ic.isConnected) scrollInSheet(ic, 'start'); }, 120);
    safe(art && art.attachDrawer, root);
  }
  if (tab === 'search') { const occ = $('.occ', root); if (occ) renderOcc(occ); }
  if (tab === 'orig') {
    const occ = $('.occ', root); if (occ) renderOcc(occ);
    if (origFocus && !origFocus.strong && origFocus.word != null) setTimeout(() => { const w = $('#' + wordId(origFocus.word), root); if (w) scrollInSheet(w, 'center'); }, 60);
  }
  if (tab === 'notes') { bindNotes(root, opts); const ms = $('#mk-sec', root); if (ms && mrk) safe(mrk.foldNotes, ms); }
  if (tab === 'media') bindMedia(root);
  if (tab === 'mine') { const host = $('.mine-host', root); if (host && links) safe(links.renderMine, host, mineAt()); }
}

// ------------------------------------------------------------ interactions inside the sheet
function onBodyClick(e) {
  const t = e.target; const root = bodyEl();
  const f = t.closest('#xfilter [data-f]'); if (f) { if (!f.disabled) { state.xfilter = f.dataset.f; applyFilter(); } return; }
  const md = t.closest('#md-mode [data-mode]'); if (md) { if (!md.disabled && md.getAttribute('aria-checked') !== 'true') { mdMode = md.dataset.mode; renderDrawer({ keepScroll: true, focus: mdMode === 'write', focusTo: mdMode === 'preview' ? '#md-mode [aria-checked="true"]' : null }); } return; }
  const vl = t.closest('.vlink'); if (vl) { e.preventDefault(); if (A.goReference(vl.dataset.ref)) A.yieldToPage(); return; }
  if (t.closest('[data-md]') && !t.closest('a')) {
    const sl = window.getSelection?.(); if (sl && !sl.isCollapsed && t.closest('[data-md]').contains(sl.anchorNode)) return; // selecting text to copy
    mdMode = 'write'; renderDrawer({ keepScroll: true, focus: true }); return;
  }
  const go = t.closest('[data-go]'); if (go) { const p = go.dataset.go.split('.').map(Number); A.navigate(p[0], p[1], p[2] || 0); A.yieldToPage(); return; }
  const mk = t.closest('[data-mk-show], [data-mk-edit], [data-mk-del], [data-mk-go], [data-mk-more]'); if (mk) { if (mrk) onMarkAction(mk); return; }
  const sel = t.closest('[data-select]'); if (sel) { A.select(+sel.dataset.select); return; }
  const gr = t.closest('[data-graph]'); if (gr) { const p = gr.dataset.graph.split('.').map(Number); A.navigate(p[0], p[1], p[2] || 0, { panel: 'graph' }); A.yieldToPage(true); return; }
  if (t.closest('[data-sign-in]')) { A.signIn?.(); return; }
  const add = t.closest('[data-addnote]');
  if (add) {
    if (S.guestBlocked()) return;
    const key = currentKey(); const n = noteFor(key, true);
    n.text = (n.text ? n.text.replace(/\s*$/, '\n') : '') + `[[${add.dataset.addnote}]] `;
    touchNote(key); A.refreshMarker(state.selected); mdMode = 'write';
    A.openTab('notes', { focus: true });
    return;
  }
  const cell = t.closest('.cell'); if (cell && cell.parentElement?.classList.contains('xref')) { expandXref(cell.parentElement); return; }
  const topic = t.closest('[data-topic]'); if (topic) { A.showTopic(topic.dataset.topic); return; }
  const ev = t.closest('[data-event]');
  if (ev) {
    // this chapter's verses of the event come from the chapter map; only an event with none here opens elsewhere
    Promise.all([data.events(), data.context(state.book)]).then(([evs, ctx]) => {
      const x = evs[ev.dataset.event]; if (!x) return;
      const here = eventVerses(ctx[String(state.chapter)]?.v || {}, ev.dataset.event);
      if (here.length) { A.yieldToPage(); A.flash(here); }
      else if ((x.v || []).length) { A.navigate(x.v[0][0], x.v[0][1], x.v[0][2]); A.yieldToPage(); }
    }).catch(() => {});
    return;
  }
  const pr = t.closest('[data-person]'); if (pr) { expandPerson(pr.closest('li'), pr.dataset.person); return; }
  const pl = t.closest('[data-place]'); if (pl) { expandPlace(pl.closest('li'), pl.dataset.place); return; }
  const more = t.closest('[data-more-dict]');
  if (more) { const d = more.previousElementSibling; if (d) { d.classList.toggle('full'); more.textContent = d.classList.contains('full') ? 'Less' : 'More'; } return; }
  const pn = t.closest('[data-panel]'); if (pn) { A.showPanel(pn.dataset.panel, true); A.yieldToPage(true); return; }
  const gc = t.closest('[data-goch]'); if (gc) { A.navigate(state.book, Math.min(+gc.dataset.goch || 1, bookOf(state.book).chapters.length), 0); A.yieldToPage(); return; }
  const tg = t.closest('[data-tagged]'); if (tg) { showTagged(tg.dataset.tagged, tg.dataset.name || ''); return; }
  const st = t.closest('button[data-strong]');
  if (st && !st.classList.contains('static')) {
    const row = st.closest('.words > li');
    wordStudied(st.dataset.strong, row ? ($('.w-o', row)?.firstChild?.textContent || '').trim() : '');
    const code = row ? ($('.w-code', row)?.textContent || '') : '';
    origFocus = { strong: st.dataset.strong, word: row ? +row.dataset.i : origFocus?.word, aram: code[0] === 'A' }; renderDrawer({ push: true, focusTo: '[data-back-orig]' }); return;
  }
  if (t.closest('[data-back-orig]')) {
    const w = origFocus?.word, s = String(origFocus?.strong || '');
    origFocus = w != null ? { word: w } : null;
    renderDrawer({ pop: true, focusTo: w != null ? el => $$(`#${wordId(w)} [data-strong]`, el).find(x => x.dataset.strong === s) || $(`#${wordId(w)} [data-strong]`, el) : null });
    return;
  }
  if (t.closest('[data-more-occ]')) { renderOcc($('.occ', root)); return; }
  const ow = t.closest('.ow');
  if (ow) {
    const i = +ow.dataset.i; origFocus = { word: i };
    wordStudied($(`#w${i} [data-strong]`, root)?.dataset.strong || '', ow.textContent.trim());
    $$('.ow', root).forEach(x => x.classList.toggle('on', x === ow));
    $$('.words > li', root).forEach(r => r.classList.toggle('focus', +r.dataset.i === i));
    const row = $('#' + wordId(i), root); if (row) scrollInSheet(row, 'center');
    return;
  }
  if (t.closest('[data-scope]')) {
    if (state.selected) { state.selected = null; safe(links && links.clearMineFocus); A.refreshSelection(); renderDrawer({ focusTo: '[data-scope]' }); }
    else {
      if (layoutMode() !== 'side') A.closeDrawer();
      document.querySelector('#reader .verse[tabindex="0"]')?.focus({ preventScroll: true });
      A.toast('Select a verse, then write its note here.');
    }
    return;
  }
  const hl = t.closest('[data-hl]');
  if (hl) {
    if (!state.selected || S.guestBlocked()) return;
    const key = currentKey(); const val = hl.dataset.hl; const n = noteFor(key, true);
    n.highlight = val; touchNote(key);
    setRadio(hl.closest('[role=radiogroup]'), b => b.dataset.hl === val);
    A.refreshMarker(state.selected);
    return;
  }
  const ut = t.closest('[data-untag]');
  if (ut) { const key = currentKey(); const n = noteFor(key); if (n) { n.tags = (n.tags || []).filter(x => x !== ut.dataset.untag); touchNote(key); A.refreshMarker(state.selected); retag(); } return; }
  if (t.closest('[data-export-json]')) {
    const blob = new Blob([JSON.stringify(state.notes, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'bible-study-notes.json';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return;
  }
  if (t.closest('[data-export-obsidian]')) { exportObsidian(); return; }
  if (t.closest('[data-import-json]')) { $('#import-json', root)?.click(); return; }
  const mn2 = t.closest('[data-more-notes]'); if (mn2) { redrawAllNotes(root, +mn2.dataset.moreNotes); return; }
  if (t.closest('[data-stop-video]')) {
    const id = document.getElementById('player')?.dataset.id;
    stopPlayer();
    const back = (id && $(`[data-play="${CSS.escape(id)}"]`, root)) || root;
    back.focus({ preventScroll: true });
    return;
  }
  const play = t.closest('[data-play]');
  if (play) {
    const p = $('#player', root); if (!p) return;
    p.dataset.id = play.dataset.play;
    p.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(play.dataset.play)}?start=${+play.dataset.start || 0}&autoplay=1&rel=0" title="Video player" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
    p.hidden = false; root.scrollTo({ top: 0, behavior: scrollBehavior() });
    return;
  }
  const mn = t.closest('[data-menu]'); if (mn) { openMenu(mn); return; }
  if (t.id === 'tokens') { $('#note-tags', root)?.focus(); }
}

function onBodyKeydown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const vl = e.target.closest?.('.vlink');
  if (vl && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); vl.click(); return; }
  const g = e.target.closest?.('[role=radiogroup]');
  if (g && e.target.matches('[role=radio]')) {
    const id = g.id;
    radioKeys(e, g, btn => {
      btn.click();
      // groups that re-render (Write/Preview) lose focus: put it back on the checked item
      setTimeout(() => { if (!g.isConnected && id) document.querySelector(`#${id} [aria-checked="true"]`)?.focus({ preventScroll: true }); }, 0);
    });
  }
}

export function bindDrawer() {
  const tabs = document.getElementById('drawer-tabs');
  tabs.addEventListener('click', e => { const b = e.target.closest('[role=tab][data-tab]'); if (b && !b.hidden) A.openTab(b.dataset.tab); });
  tabs.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    const list = $$('[role=tab]', tabs).filter(b => !b.hidden);
    let i = list.findIndex(b => b.dataset.tab === state.drawerTab); if (i < 0) i = 0;
    i = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
    A.openTab(list[i].dataset.tab); list[i].focus();
  });
  // the row, and each tab: a count or the Search tab changes the columns' widths on a phone
  if ('ResizeObserver' in window) { const ro = new ResizeObserver(() => { moveInd(tabs); fitTabs(tabs); }); ro.observe(tabs); $$('[role=tab]', tabs).forEach(t => ro.observe(t)); }
  document.getElementById('drawer-close')?.addEventListener('click', () => A.closeDrawer());
  document.getElementById('btn-bookmark')?.addEventListener('click', () => {
    const { b, c, v } = bookmarkTarget();
    if (typeof A.toggleBookmark === 'function') A.toggleBookmark(b, c, v); else safe(libFn('toggleBookmark'), b, c, v);
  });
  document.addEventListener('bs:library-changed', () => { const { b, c, v } = bookmarkTarget(); if (bookOf(b)) renderBookmarkBtn(b, c, v); });
  document.addEventListener('bs:links-changed', () => renderMineCount()); // links.js redraws an open Mine body itself
  // highlights and comments (marks.js): drawn again after each change and chapter render ('Text moved' is known then)
  document.addEventListener('bs:marks-changed', queueNoteMarks);
  document.addEventListener('bs:marks-drawn', queueNoteMarks);
  document.getElementById('verse-prev')?.addEventListener('click', () => A.stepVerse(-1, { keepFocus: true }));
  document.getElementById('verse-next')?.addEventListener('click', () => A.stepVerse(1, { keepFocus: true }));
  const el = bodyEl();
  el.addEventListener('scroll', () => { document.getElementById('drawer')?.classList.toggle('scrolled', el.scrollTop > 2); if (menuEl) closeMenu(); }, { passive: true });
  window.addEventListener('resize', () => { if (menuEl) { if (menuEl._opener?.isConnected) placeMenu(menuEl); else closeMenu(false); } });
  el.addEventListener('error', thumbFallback, true);
  el.addEventListener('load', thumbFallback, true);
  el.addEventListener('click', onBodyClick);
  el.addEventListener('keydown', onBodyKeydown);
  document.addEventListener('pointerdown', e => {
    if (!menuEl) return; const t = e.target;
    if (t instanceof Element && (menuEl.contains(t) || t.closest('[data-menu]'))) return;
    closeMenu(false);
  });
}
