// The reading page: chapter hero, verses (parallel columns, inline interlinear, markers), footer.
// The document scrolls on the window (not on #reader).
import { state, data, bookOf, refKey, noteFor, yearLabel, esc, isHebrewBook, isDivine, smart, nobreak, plural, initials, testamentName, divSlug, trInfo, layoutMode, RM, isAramaicWord, aramaicVerses, morphNoLang } from './store.js';
import { decodeMorph, wordTypeLabel, isVariantWord, variantShort } from './morph.js';
import { icon } from './icons.js';
import * as viz from './viz.js';

let A;                        // actions injected by main.js
export function init(actions) { A = actions; }

// library.js, art.js, media.js, links.js and marks.js are optional (main.js loads all but media.js guarded too): imported at run time
// so that a missing or broken one can never stop this module, and with it the whole app, from loading. Same module instances.
const optional = (p, name) => p.then(m => m, e => { console.error(`${name} failed to load`, e); return null; });
let library = null, art = null, media = null, lnk = null, mrk = null;
const libraryP = optional(import('./library.js'), 'library.js').then(m => (library = m));
const artModP = optional(import('./art.js'), 'art.js').then(m => (art = m));
const mediaModP = optional(import('./media.js'), 'media.js').then(m => (media = m));
optional(import('./links.js'), 'links.js').then(m => (lnk = m)); // loaded before the first render (main.js boot awaits loadLinks)
optional(import('./marks.js'), 'marks.js').then(m => { mrk = m; if (m) refreshAnnBadges(); }); // likewise (loadMarks)

const COPYRIGHT = {
  esv: 'Scripture quotations marked ESV are from the ESV® Bible (The Holy Bible, English Standard Version®), © 2001 by Crossway, a publishing ministry of Good News Publishers. Used by permission. All rights reserved.',
  // Tyndale's required credit line for a project that uses more than one translation (tyndale.com permissions)
  nlt: 'Scripture quotations marked (NLT) are taken from the Holy Bible, New Living Translation, copyright ©1996, 2004, 2015 by Tyndale House Foundation. Used by permission of Tyndale House Publishers, Carol Stream, Illinois 60188. All rights reserved.',
};
const readerEl = () => document.getElementById('reader');
const safeCall = (fn, ...a) => { try { return typeof fn === 'function' ? fn(...a) : undefined; } catch (e) { console.error(e); return undefined; } };
/** library.js / art.js calls: undefined when the module is missing or throws. */
const libCall = (name, ...a) => safeCall(library && library[name], ...a);
const artCall = (name, ...a) => safeCall(art && art[name], ...a);
/** Markup from art.js ('' when it is missing, not loaded yet or throws). */
const artHtml = (name, ...a) => { const h = artCall(name, ...a); return typeof h === 'string' ? h : ''; };
/** A verse's study-video icons from media.js ('' when it is missing, not loaded yet or throws). */
const mediaHtml = (b, c, v) => { const h = safeCall(media && media.badgeHtml, b, c, v); return typeof h === 'string' ? h : ''; };
/**
 * My links on a verse (links-spec §3.2): { n, color } with the colour of the most recently saved link, or null with none
 * (or while links.js is missing). linksFor counts a link once, on either end and on every verse of a range.
 */
function linkMark(b, c, v) {
  const list = safeCall(lnk && lnk.linksFor, b, c, v);
  if (!Array.isArray(list) || !list.length) return null;
  const at = l => l.updated || l.created || 0;
  const top = list.reduce((x, l) => (at(l) >= at(x) ? l : x));
  return { n: list.length, color: /^(red|orange|yellow|green|blue|purple)$/.test(top.color) ? top.color : 'blue' };
}
const linkBadgeLabel = n => (n === 1 ? '1 of your links. Show it' : `${n.toLocaleString()} of your links. Show them`);
/** The gutter badge for a verse's links: '' with none. */
function linkBadgeHtml(b, c, v) {
  const m = linkMark(b, c, v); if (!m) return '';
  return `<button class="b-link" type="button" data-link-v="${v}" data-link-color="${m.color}" tabindex="-1" aria-label="${linkBadgeLabel(m.n)}" title="${plural(m.n, 'link')}">${icon('link-node')}<span>${m.n}</span></button>`;
}
/** Comments on a verse (annotations-brief §3.3): the marks with a comment that start there, in any translation (0 while marks.js is missing). */
function annCount(b, c, v) { const l = safeCall(mrk && mrk.commentsAt, b, c, v); return Array.isArray(l) ? l.length : 0; }
/** The gutter badge for a verse's comments (a speech bubble and a count): '' with none. */
function annBadgeHtml(b, c, v) {
  const n = annCount(b, c, v); if (!n) return '';
  const ic = safeCall(mrk && mrk.commentIcon) || icon('note');
  return `<button class="b-ann" type="button" data-ann-v="${v}" tabindex="-1" aria-label="${mrk.annLabel(n)}" title="${plural(n, 'comment')}">${ic}<span>${n}</span></button>`;
}
let lastFocusedV = null;      // roving tabindex memory within the current chapter
let PEOPLE = null;            // people.json once loaded (hero monograms)

async function getChapter(tr, b, c) {
  try {
    if (tr === 'esv' || tr === 'nlt') {
      const verses = await data.passage(tr, b, c);
      const title = b === 19 ? safeCall(data.passageTitle, tr, b, c) : ''; // a psalm's title ("title" of /api/passage), never part of verse 1
      return { verses, title: typeof title === 'string' ? title : '' };
    }
    const bk = await data.bible(tr, b);
    return { verses: bk[c] || [] };
  } catch (e) { return { verses: [], error: e.message }; }
}
/** Primary text; if a licensed translation fails, fall back to KJV so the page is never empty. */
async function getPrimary(tr, b, c) {
  const r = await getChapter(tr, b, c);
  if (!r.error || tr === 'kjv') return r;
  const k = await getChapter('kjv', b, c);
  return { verses: k.verses, error: r.error, fellBack: k.error ? null : 'kjv' };
}

/** Neighbouring chapter or null at either end of the canon. */
export function stepTarget(dir) {
  let b = state.book, c = state.chapter + dir;
  if (c < 1) { if (b === 1) return null; b -= 1; c = bookOf(b).chapters.length; }
  if (c > bookOf(b).chapters.length) { if (b === 66) return null; b += 1; c = 1; }
  return { b, c };
}

const delay = ms => new Promise(r => setTimeout(r, ms));
// a closing quote ends the sentence only after . ? ! or … (Peter’s Confession “Upon this Rock” still needs its period)
const sentence = t => { t = smart(String(t || '').trim()); return /[.?!…]['"’”]?$/.test(t) ? t : t + '.'; };
/** A title's words for comparing taglines: lower case, without possessives and small words ('Paul's Journey to Rome' → paul journey to rome). */
const TAG_SMALL = new Set(['the', 'of', 'and', 'a', 'an', 'begins']);
const tagWords = t => new Set((String(t).toLowerCase().replace(/['’]s\b/g, '').match(/[a-z]+/g) || []).filter(w => !TAG_SMALL.has(w)));
/** One title says nothing the other does not: its words are all in the other ('Reign of Saul' and 'Saul'). */
const restates = (a, b) => !!a.size && !!b.size && ([...a].every(w => b.has(w)) || [...b].every(w => a.has(w)));
function inRange(rng, c) { const m = String(rng).match(/(\d+)(?:\s*[–-]\s*(\d+))?/); return !!m && c >= +m[1] && c <= +(m[2] || m[1]); }
function modeOf(arr) { const m = new Map(); let best = arr[0], bc = 0; for (const x of arr) { const n = (m.get(x) || 0) + 1; m.set(x, n); if (n > bc) { bc = n; best = x; } } return best; }
const personName = (people, id) => people?.[id]?.t || people?.[id]?.n || '';
/** Escape a verse and wrap the words of Jesus (character ranges from the red-letter data) in span.woc. */
function wordsOfJesus(text, ranges) {
  if (!ranges || !ranges.length) return esc(text);
  let out = '', at = 0;
  for (const [a, b] of ranges) {
    if (a < at || b > text.length || a >= b) continue; // stale ranges (text changed): skip rather than mangle
    out += esc(text.slice(at, a)) + `<span class="woc">${esc(text.slice(a, b))}</span>`; at = b;
  }
  return out + esc(text.slice(at));
}

/**
 * A psalm's title before verse 1 and Psalm 119's letter headings (א ALEPH) before verses 1, 9, 17…, set apart from
 * the verses as in a printed Bible: tL/tR are the left/right column's titles (KJV: titles and headings, BSB: titles,
 * ESV/NLT: the title their API sends apart from verse 1; null for a translation without them). In parallel mode each column shows its own. With the interlinear on, the
 * title's Hebrew (orig 'c:0', never part of verse 1) sits under it, whatever the translation.
 */
function psalmHeadHtml(tL, tR, c, v, { parallel = false, inter = '', abbr = [] } = {}) {
  // in parallel mode each column is named like the verse rows' (abbr: the escaped abbreviations), when it has a title
  const col = (h, ab, cls) => `<div${cls}${h && ab ? ` data-tr="${ab}"` : ''}>${h && ab ? `<span class="sr">${ab}: </span>` : ''}${h}</div>`;
  const wrap = f => (parallel ? `<div class="vcols">${col(f(tL), abbr[0], '')}${col(f(tR), abbr[1], ' class="alt"')}</div>` : f(tL));
  const headOf = t => t?.head?.[c]?.[v] || '', supOf = t => (v === 1 && t?.sup?.[c]) || '';
  const headHtml = t => { const head = headOf(t), m = String(head).match(/^(\S+)\s+(.*)$/); return !head ? '' : m ? `<span class="ps-letter" lang="he">${esc(m[1])}</span> ${esc(m[2])}` : esc(head); };
  let h = '';
  if (headOf(tL) || (parallel && headOf(tR))) h += `<div class="ps-head" role="listitem">${wrap(headHtml)}</div>`;
  const sup = supOf(tL) || (parallel && supOf(tR));
  if (sup || (v === 1 && inter)) h += `<div class="ps-title" role="listitem"${sup ? '' : ' aria-label="Psalm title"'}>${sup ? wrap(t => esc(supOf(t))) : ''}${v === 1 ? inter : ''}</div>`;
  return h;
}
/** A verse a translation has no text for ('' in its data, or past the end of a shorter chapter). */
const isGap = (verses, v) => !!verses && verses.length > 0 && !String(verses[v - 1] ?? '').trim();
const hasGap = (verses, n) => { for (let v = 1; v <= n; v++) if (isGap(verses, v)) return true; return false; };
/**
 * One column's verse. A verse the translation leaves out (the BSB's 16 textual variants, ESV/NLT gaps) gets a muted
 * explanation and the bundled KJV reading instead of an empty row; verses it numbers past the KJV's last one
 * (3 John 1:15 and Revelation 12:18 in the ESV and NLT) are folded into the last verse behind their own number,
 * as the BSB does, so everything keyed to the KJV count (routing, drawer, bookmarks, tracking) keeps working.
 */
function verseTextHtml(verses, v, n, tr, ranges, kjv) {
  const extra = v === n && verses && verses.length > n
    ? verses.slice(n).map((t, i) => (String(t || '').trim() ? ` <sup class="vx" title="${esc(`Verse ${n + i + 1} in the ${trInfo(tr).abbr}`)}">${n + i + 1}</sup>${esc(t)}` : '')).join('')
    : '';
  if (isGap(verses, v) && !extra) return omittedHtml(tr, kjv && kjv[v - 1]);
  return `<span class="vtext">${wordsOfJesus((verses && verses[v - 1]) || '', ranges)}${extra}</span>`;
}
/** The explanation is editorial, never Scripture: set apart (em) from the KJV reading it quotes; no red letters. */
function omittedHtml(tr, kjvText) {
  const abbr = esc(trInfo(tr).abbr);
  const why = tr === 'bsb' ? 'The BSB leaves this verse out of its text (a textual variant it gives in a footnote).'
    : `The ${abbr} has no separate verse here (a textual variant, or combined with an adjacent verse).`;
  return `<span class="vtext omitted"><em class="om-why">${why}</em>${kjvText ? ` <span class="om-kjv">KJV: “${esc(String(kjvText).trim())}”</span>` : ''}</span>`;
}

/** The hero counts only people named in people.json (Satan, angels and pagan gods are not people and are not in it),
 *  never the Godhead; most often mentioned first. Before people.json arrives every non-divine id is counted. */
const isPerson = (people, id) => !isDivine(id) && !people?.[id]?.dv && !!personName(people, id);
function rankPeople(pCount, people) {
  return [...pCount.entries()].filter(([id]) => !people || isPerson(people, id))
    .sort((a, z) => z[1] - a[1] || ((people?.[z[0]]?.vc || 0) - (people?.[a[0]]?.vc || 0))).map(([id]) => id);
}
const peopleCountHtml = k => `<b>${k}</b> ${k === 1 ? 'person' : 'people'}`;

/**
 * The control that has the focus inside the reader, as a selector that finds the same control after a re-render
 * (stable data-* attributes, never positions: the interlinear adds and removes buttons), plus the verse to fall
 * back on (an interlinear word disappears when the interlinear is turned off).
 */
const FOCUS_ATTRS = ['data-v', 'data-i', 'data-bm-v', 'data-bm-chapter', 'data-mark-read', 'data-nav', 'data-art', 'data-art-open', 'data-art-step', 'data-art-range', 'data-art-go', 'data-media', 'data-link-v', 'data-ann-v', 'data-open-settings', 'data-dismiss-notice'];
function captureFocus(el) {
  const ae = document.activeElement;
  if (!ae || ae === el || !el.contains(ae)) return null;
  const verse = ae.closest('.verse'), slot = ae.closest('[data-art-slot]');
  const back = verse ? verse.id : slot ? 'v' + slot.dataset.artSlot : null; // a plate sits right before its verse
  if (ae === verse) return { sel: null, verse: back };
  let sel = null;
  if (ae.parentElement && ae.parentElement.matches('.hero .chips')) {
    sel = `.hero .chips > :nth-child(${[...ae.parentElement.children].indexOf(ae) + 1})`; // a chapter's chips are fixed
  } else {
    const at = FOCUS_ATTRS.filter(a => ae.hasAttribute(a)).map(a => `[${a}="${CSS.escape(ae.getAttribute(a))}"]`).join('');
    const scope = verse ? `#${verse.id} ` : slot ? `[data-art-slot="${CSS.escape(slot.dataset.artSlot)}"] ` : '';
    if (at) sel = `${scope}${ae.localName}${at}`;
  }
  return { sel, verse: back };
}
function restoreFocus(el, f) {
  if (!f) return;
  let t = null;
  try { t = (f.sel && el.querySelector(f.sel)) || (f.verse && document.getElementById(f.verse)); } catch (e) { t = null; }
  if (t && t !== document.activeElement) t.focus({ preventScroll: true }); // keep the restored reading position
}

/**
 * Render the current chapter.
 * opts.scroll: true after a navigation (centre the selected verse instantly, else scroll to top);
 * 'top' always scrolls to the top (a stage panel was opened); otherwise the reading position is
 * kept (anchored on the first visible verse). Adds .hero.enter only when the chapter changed.
 */
export async function renderReader(opts = {}) {
  const el = readerEl();
  const b = state.book, c = state.chapter, bk = bookOf(b);
  const token = (el.dataset.token = String(Math.random()));
  const busyT = setTimeout(() => { if (el.dataset.token === token) el.classList.add('busy'); }, 120);
  const peopleP = data.people().then(p => (PEOPLE = p)).catch(() => null);
  const artP = artModP.then(m => (m && typeof m.load === 'function' ? Promise.resolve().then(() => m.load()).then(() => true) : false)).catch(e => { console.error(e); return false; });
  const mediaP = mediaModP.then(m => (m && typeof m.load === 'function' ? Promise.resolve().then(() => m.load()).then(() => !!m.isLoaded?.()) : false)).catch(e => { console.error(e); return false; });
  const [primary, parallel, xr, ctx, intros, events, orig, , artReady, rl1, rl2, , [psK, psB], mediaReady] = await Promise.all([
    getPrimary(state.tr, b, c),
    state.tr2 ? getChapter(state.tr2, b, c) : null,
    data.xref(b).catch(() => ({})), data.context(b), data.bookIntros().catch(() => []), data.events().catch(() => ({})),
    state.showOrig ? data.orig(b) : null,
    Promise.race([peopleP, delay(350)]),   // monograms if people.json arrives quickly; patched in later otherwise
    Promise.race([artP, delay(600).then(() => false)]), // Doré plates: patched in later if art.json is slow
    data.redletter(state.tr === 'bsb' ? 'bsb' : 'kjv', b).catch(() => ({})), // ESV/NLT fall back to the KJV when unavailable
    state.tr2 ? data.redletter(state.tr2, b).catch(() => ({})) : {},
    libraryP,                                // read marks and bookmarks (settled long before, at boot)
    b === 19 ? Promise.all([data.titles('kjv', 19), data.titles('bsb', 19)]) : [{}, {}],   // psalm titles (KJV, BSB), Psalm 119's letter headings (KJV)
    Promise.race([mediaP, delay(600).then(() => false)]), // study videos: patched in later if media.json is slow
  ]);
  const psalmTitles = (tr, r) => (tr === 'kjv' ? psK : tr === 'bsb' ? psB : r && r.title ? { sup: { [c]: r.title } } : null);
  if (el.dataset.token !== token) { clearTimeout(busyT); return; } // superseded by a newer render
  const n = bk.chapters[c - 1];
  const shownTr = primary.fellBack || state.tr;
  // a parallel translation that failed to load (no key, API error, offline) is left out of the layout, its heading and
  // the copyright lines; its error card stays (noticeCards) and state.tr2 is kept, so the column returns once it loads
  const tr2 = parallel && !parallel.error ? state.tr2 : '';
  // a verse a translation leaves out is quoted from the bundled KJV, unless a KJV column is already on screen
  const kjvGap = shownTr !== 'kjv' && tr2 !== 'kjv' && (hasGap(primary.verses, n) || (!!tr2 && hasGap(parallel.verses, n)));
  const kjv = kjvGap ? (await getChapter('kjv', b, c)).verses : null;
  clearTimeout(busyT);
  if (el.dataset.token !== token) return;
  el.classList.remove('busy');

  const fresh = el.dataset.ch !== `${b}.${c}`;
  if (fresh) lastFocusedV = null;
  const people = PEOPLE;
  const intro = intros[b - 1] || {};
  const vmap = (ctx[String(c)] || {}).v || {};
  const years = Object.values(vmap).map(x => x.y).filter(y => y !== undefined && y !== null && y !== '');
  const era = years.length ? +modeOf(years) : null;
  const pCount = new Map(), places = new Set(), evFirst = new Map(), evN = new Map(); // event id → the first verse of it in this chapter, and how many of its verses
  Object.entries(vmap).forEach(([v, x]) => {
    (x.p || []).forEach(i => { if (!isDivine(i)) pCount.set(i, (pCount.get(i) || 0) + 1); });
    (x.pl || []).forEach(i => places.add(i));
    (x.e || []).forEach(i => { if (!evFirst.has(i) || +v < evFirst.get(i)) evFirst.set(i, +v); evN.set(i, (evN.get(i) || 0) + 1); });
  });

  // tagline: first event in label colour, the next one or two (or the outline section) softened. An umbrella event
  // gives way to its own parts ('Holy Week' to 'Crucifixion and Burial'), and one that only restates another ('Journey
  // to Rome begins' beside 'Paul's Journey to Rome') is left out. The three covering most of the chapter are shown in
  // the order they begin in it; Theographic's sortKey only breaks ties (on its own it puts the Luke 3 genealogy's
  // 'Birth of Seth' ahead of John the Baptist, and Luke 2's return to Nazareth ahead of the Nativity).
  const parents = new Set([...evFirst.keys()].flatMap(i => events[i]?.part || []));
  const byStart = (a, z) => evFirst.get(a) - evFirst.get(z) || (events[a].sk || 0) - (events[z].sk || 0);
  const said = [];
  const evNames = [...evFirst.keys()].filter(i => events[i]?.t && !parents.has(i))
    .sort((a, z) => evN.get(z) - evN.get(a) || byStart(a, z))
    .filter(i => { const w = tagWords(events[i].t); if (said.some(s => restates(s, w))) return false; said.push(w); return true; })
    .slice(0, 3).sort(byStart).map(i => events[i].t);
  // a one-chapter book's outline gives verse ranges (Philemon '1–7', '8–25'): the chapter is all of its sections
  const one = bk.chapters.length === 1, outl = intro.outline || [];
  let section = one ? null : outl.find(o => inRange(o[0], c));
  // the section goes only when it echoes the event: it adds no word of its own ('Sermon on the Mount' twice, 'Reign of
  // Saul. Saul.'), or one word to the event's own ('Resurrection and Ascension. Passion, resurrection, ascension.').
  // Anything more stays: 'The Fall. Primeval history…', 'Tabernacle Built. …golden calf…', 'Reign of Saul. David and Saul.'
  if (section && evNames.length === 1) {
    const ew = tagWords(evNames[0]), sw = tagWords(section[1]), extra = [...sw].filter(w => !ew.has(w));
    if (!extra.length || (extra.length === 1 && [...ew].every(w => sw.has(w)))) section = null;
  }
  let tag = '';
  if (one && outl.length && !evNames.length) tag = `${esc(sentence(outl[0][1]))}${outl.length > 1 ? ` <span class="soft">${outl.slice(1, 3).map(o => esc(sentence(o[1]))).join(' ')}</span>` : ''}`;
  else if (evNames.length) tag = `${esc(sentence(evNames[0]))}${evNames.length > 1 ? ` <span class="soft">${evNames.slice(1, 3).map(t => esc(sentence(t))).join(' ')}</span>` : section ? ` <span class="soft">${esc(sentence(section[1]))}</span>` : ''}`;
  else if (section) tag = esc(sentence(section[1]));

  // cross-reference legend counts
  let nOT = 0, nNT = 0;
  for (const [k, list] of Object.entries(xr)) { if (!k.startsWith(c + ':')) continue; for (const x of list) { if (x[0] <= 39) nOT++; else nNT++; } }

  // hero chips
  const chips = [];
  if (era !== null) {
    const pct = Math.max(0, Math.min(100, (era + 2100) / 2200 * 100));
    chips.push(`<button class="chip" type="button" data-tab="context" title="Approximate year of this chapter, on Ussher’s chronology (via Theographic) as dated throughout the app">${icon('clock')}<span>c. ${esc(yearLabel(era))}</span><span class="era-track" aria-hidden="true"><i style="left:${pct.toFixed(1)}%"></i></span></button>`);
  }
  if (evFirst.size) chips.push(`<button class="chip" type="button" data-tab="context">${icon('calendar')}<span><b>${evFirst.size}</b> ${evFirst.size === 1 ? 'event' : 'events'}</span></button>`);
  const topPeople = rankPeople(pCount, people);
  if (topPeople.length) {
    chips.push(`<button class="chip" type="button" data-tab="context" data-chip="people"${people ? ` title="${esc(peopleTitle(people, topPeople))}"` : ''}>${people ? monos(people, topPeople) : icon('people')}<span>${peopleCountHtml(topPeople.length)}</span></button>`);
  }
  if (places.size) chips.push(`<button class="chip" type="button" data-tab="context">${icon('pin')}<span><b>${places.size}</b> ${places.size === 1 ? 'place' : 'places'}</span></button>`);
  chips.push(`<button class="chip" type="button" data-tab="xref" title="Cross-reference links leaving this chapter">${icon('link')}<span><b>${(bk.xo[c] || 0).toLocaleString()}</b> links</span></button>`);
  chips.push(`<button class="chip more" type="button" data-tab="context" data-intro="1">About ${esc(bk.name)}${icon('chev-right')}</button>`);

  const introLine = [smart(intro.author), nobreak(smart(intro.date))].filter(Boolean).map(esc).join(' · ');
  const isRead = !!libCall('chapterState', b, c)?.read;
  const bms = libCall('bookmarksInChapter', b, c) || new Map();
  const title = bookTitle(bk);
  let html = `<header class="hero${fresh ? ' enter' : ''}" data-div="${esc(divSlug(bk))}">
    <p class="eyebrow"><span class="t-dot ${bk.test === 'OT' ? 'ot' : 'nt'}" aria-hidden="true"></span>${esc(testamentName(bk))} · ${esc(bk.div)}<span class="read-pill"${isRead ? '' : ' hidden'}>${icon('check')}Read</span></p>
    <h1 class="hero-title"${longWord(title) >= 10 ? ` style="--wl:${longWord(title)}"` : ''}>${esc(title).replace(/^(\d) /, '$1&nbsp;')} <span class="chnum">${c}</span></h1>
    ${tag ? `<p class="hero-tag">${tag}</p>` : ''}
    ${introLine ? `<p class="intro-line">${introLine}</p>` : ''}
    <div class="chips" role="group" aria-label="This chapter at a glance">${chips.join('')}</div>
    <figure class="sig">
      <div class="arc-host" id="sig-arcs"></div>
      <figcaption class="legend"><span class="key ot"><i></i>Old Testament · <b>${nOT.toLocaleString()}</b></span><span class="key nt"><i></i>New Testament · <b>${nNT.toLocaleString()}</b></span><span class="cap" id="sig-cap">Every link leaving ${esc(chName(b, c))}. Select an arc to study it.</span></figcaption>
    </figure>
  </header>`;

  html += noticeCards(primary, parallel);

  // verses
  const heb = isHebrewBook(b);
  const rovingV = state.selected && state.selected <= n ? state.selected : (lastFocusedV && lastFocusedV <= n ? lastFocusedV : 1);
  const ab1 = esc(trInfo(shownTr).abbr), ab2 = tr2 ? esc(trInfo(tr2).abbr) : ''; // each parallel column names its translation (the heads hide on phones)
  html += `<div class="verses${tr2 ? ' parallel' : ''}" role="list" lang="en">`;
  if (tr2) html += `<div class="col-heads" aria-hidden="true"><span>${esc(trInfo(shownTr).name)}</span><span>${esc(trInfo(tr2).name)}</span></div>`;
  for (let v = 1; v <= n; v++) {
    const note = noteFor(refKey(b, c, v));
    const xc = (xr[`${c}:${v}`] || []).length, xl = xc ? plural(xc, 'cross-reference') : '';
    const t1 = verseTextHtml(primary.verses, v, n, shownTr, (shownTr === 'kjv' || shownTr === 'bsb') ? rl1[`${c}:${v}`] : null, kjv);
    const text = tr2
      ? `<div class="vcols"><div data-tr="${ab1}"><span class="sr">${ab1}: </span>${t1}</div><div class="alt" data-tr="${ab2}"><span class="sr">${ab2}: </span>${verseTextHtml(parallel.verses, v, n, tr2, rl2[`${c}:${v}`], kjv)}</div></div>`
      : t1;
    const meta = `<span class="vmeta">${xc ? `<button class="xc" type="button" data-v="${v}" tabindex="-1" aria-label="${xl}" title="${xl}">${icon('link')}${xc}</button>` : ''}${badgesHtml(note, bms.get(v), v, artReady ? artHtml('verseBadgeHtml', b, c, v) : '', mediaReady ? mediaHtml(b, c, v) : '', linkBadgeHtml(b, c, v), annBadgeHtml(b, c, v))}</span>`;
    let inter = '';
    if (orig) { const words = orig[`${c}:${v}`]; if (words && words.length) inter = interlinear(words, heb, v); }
    if (b === 19) {
      const tw = v === 1 && orig ? orig[`${c}:0`] : null;
      html += psalmHeadHtml(psalmTitles(shownTr, primary), psalmTitles(tr2, parallel), c, v, { parallel: !!tr2, abbr: [ab1, ab2], inter: tw && tw.length ? interlinear(tw, heb, 1, true) : '' });
    }
    if (artReady) html += artHtml('plateHtml', b, c, v); // a Doré plate right before the verse where its scene begins
    html += `<div class="verse${note?.highlight ? ' hl-' + esc(note.highlight) : ''}" id="v${v}" data-v="${v}" role="listitem" tabindex="${v === rovingV ? 0 : -1}"${state.selected === v ? ' aria-current="true"' : ''}><span class="vnum"><span>${v}</span></span>${text}${meta}${inter}</div>`;
  }
  html += '</div>';

  // footer tiles + copyright
  const prev = stepTarget(-1), next = stepTarget(1);
  html += `<div class="foot-actions" role="group" aria-label="This chapter">${footReadHtml(isRead, b, c)}${footBmHtml(bms.get(0), b, c)}</div>`;
  html += `<nav class="foot-nav" aria-label="Chapters">
    <button class="foot-tile prev" type="button" data-nav="-1"${prev ? '' : ' disabled'}><small>Previous</small><span>${icon('arrow-left')}${prev ? esc(chName(prev.b, prev.c)) : ''}</span></button>
    <button class="foot-tile next" type="button" data-nav="1"${next ? '' : ' disabled'}><small>Next</small><span>${next ? esc(chName(next.b, next.c)) : ''}${icon('arrow-right')}</span></button>
  </nav>`;
  // the ESV API terms: a link to www.esv.org on every page that shows ESV text
  const lines = [...new Set([shownTr, tr2].filter(Boolean))].map(t => COPYRIGHT[t] ? esc(COPYRIGHT[t]) + (t === 'esv' ? ' <a href="https://www.esv.org" target="_blank" rel="noopener">www.esv.org</a>' : '') : `${esc(trInfo(t).name)} · ${esc(trInfo(t).licence || '')}`);
  if (orig) lines.push(heb ? `${aramaicVerses(b, c).length ? 'Hebrew and Aramaic' : 'Hebrew'}: STEPBible TAHOT (CC BY 4.0)` : 'Greek: STEPBible TAGNT (CC BY 4.0)');
  lines.push('Cross-references: OpenBible.info (CC BY)');
  html += `<p class="copyright">${lines.join('<br>')}</p>`;

  const focus = fresh ? null : captureFocus(el); // e.g. 'o' on a focused verse, a translation change
  // a chapter change started from inside the reader (the Next tile, ] or → on a verse): focus the new chapter's verse
  const readerHadFocus = fresh && el.contains(document.activeElement) && document.activeElement !== el;
  const anchor = opts.scroll ? null : (focusAnchor(focus) || captureAnchor());
  el.innerHTML = html;
  el.dataset.ch = `${b}.${c}`;
  el.dataset.abbr = trInfo(shownTr).abbr; // the copied text's reference (bindReader's copy handler)
  el.dataset.tr = shownTr; el.dataset.tr2 = tr2; // the translation of each column: marks.js draws a mark only in its own
  try { if (typeof viz.renderSignature === 'function') { const r = viz.renderSignature(document.getElementById('sig-arcs'), { animate: fresh }); if (r && r.catch) r.catch(e => console.error(e)); } } catch (e) { console.error(e); }
  if (artReady) artCall('attachReader', el, b, c);

  if (opts.scroll === 'top') window.scrollTo({ top: 0, behavior: 'auto' });
  else if (opts.scroll) {
    const sel = state.selected && document.getElementById('v' + state.selected);
    if (sel) ensureVisible(sel, { force: true, instant: true });
    else window.scrollTo({ top: 0, behavior: 'auto' });
  } else if (anchor) restoreAnchor(anchor);
  restoreFocus(el, focus);
  if (readerHadFocus) el.querySelector('.verse[tabindex="0"]')?.focus({ preventScroll: true });
  document.dispatchEvent(new CustomEvent('bs:chapter-rendered', { detail: { b, c, fresh, n } }));

  // art.json was slow: add the plates and badges when it lands (the next render of this chapter includes them directly)
  if (!artReady) artP.then(ok => { if (ok && el.dataset.token === token) patchArt(el, b, c); });
  if (!mediaReady) mediaP.then(ok => { if (ok && el.dataset.token === token) patchMedia(el, b, c); }); // likewise media.json

  // people.json was slow: swap the icon for monograms and recount (only ids named in people.json) when it lands
  if (!people && pCount.size) peopleP.then(p => {
    if (!p || el.dataset.token !== token) return;
    const chip = el.querySelector('[data-chip="people"]'); if (!chip) return;
    const ids = rankPeople(pCount, p);
    if (!ids.length) { if (chip.contains(document.activeElement)) chip.nextElementSibling?.focus({ preventScroll: true }); chip.remove(); return; }
    const ic = chip.querySelector('svg.i'); if (ic) ic.outerHTML = monos(p, ids);
    chip.title = peopleTitle(p, ids);
    const count = chip.lastElementChild; if (count) count.innerHTML = peopleCountHtml(ids.length);
  });
}

function monos(people, ids) {
  const top = ids.filter(id => personName(people, id)).slice(0, 3);
  if (!top.length) return icon('people');
  return `<span class="monos" aria-hidden="true">${top.map(id => `<span class="mono">${esc(initials(personName(people, id)))}</span>`).join('')}</span>`;
}
function peopleTitle(people, ids) {
  const names = ids.map(id => personName(people, id)).filter(Boolean);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${plural(names.length - 3, 'other')}` : names.join(', ');
}

function noticeCards(primary, parallel) {
  let h = '';
  if (state.notice) {
    h += `<div class="notice" role="note">${icon('sparkle')}<p>${esc(state.notice.title)}<small>${esc(state.notice.body)}</small></p><button class="btn btn-tinted sm" type="button" data-open-settings>Open Settings</button><button class="close-btn" type="button" data-dismiss-notice aria-label="Dismiss">${icon('xmark')}</button></div>`;
  }
  const err = (tr, msg, fell) => `<div class="notice error" role="note">${icon('info')}<p>Couldn’t load ${esc(trInfo(tr).abbr)}<small>${esc(msg)}${fell ? ' Showing the King James Version instead.' : ''}</small></p>${/key/i.test(msg) ? '<button class="btn btn-tinted sm" type="button" data-open-settings>Open Settings</button>' : ''}<button class="close-btn" type="button" data-dismiss-notice aria-label="Dismiss">${icon('xmark')}</button></div>`;
  if (primary.error) h += err(state.tr, primary.error, !!primary.fellBack);
  if (parallel && parallel.error) h += err(state.tr2, parallel.error, false);
  return h;
}

/** STEP's gloss conventions (TAHOT/TAGNT headers), named in the word's tip: '<obj.>', '[were] naked', '¿ from'. */
const glossMarks = gl => [/<[^>]*>/.test(gl) && '<…> in the original, best left untranslated', /\[[^\]]*\]/.test(gl) && '[…] not in the original, supplied in English', /¿/.test(gl) && '¿ marks a question'].filter(Boolean);
/** One verse's words under its text. title: the words of a psalm's title (they open verse 1's Original tab, as -1, -2…). */
function interlinear(words, heb, v, title = false) {
  // Aramaic (Dan 2:4–7:28, Ezra 4:8–6:18 and 7:12–26, Jer 10:11): each word's tip names it, apart from the parsing
  const aram = heb && words.filter(isAramaicWord).length * 2 > words.length;
  const cells = words.map((w, i) => {
    const [o, tl, gl, strong, morph, , typ] = w;
    const variant = isVariantWord(typ);
    const tip = [strong, heb && isAramaicWord(w) ? 'Aramaic' : '', morphNoLang(decodeMorph(morph, heb)), variantShort(typ), ...glossMarks(gl)].filter(Boolean).join(' · ');
    return `<button class="iw${variant ? ' variant' : ''}" type="button" data-v="${v}" data-i="${title ? -(i + 1) : i}" tabindex="-1" title="${esc(tip)}"><span class="o ${heb ? 'heb' : 'grk'}">${esc(o)}</span><span class="tl" lang="en">${esc(tl)}</span><span class="gl" lang="en">${esc(gl)}</span></button>`;
  });
  return `<div class="inter${heb ? ' rtl' : ''}" lang="${!heb ? 'grc' : aram ? 'arc' : 'he'}" dir="${heb ? 'rtl' : 'ltr'}">${cells.join('')}</div>`;
}

/**
 * Verse gutter badges: bookmark ribbon first, then note, videos, tags, the study-video icons (media.js) and the Doré
 * plate thumbnail last. My links' badge goes right after the bookmark ribbon, then the comments' (marks.js).
 */
function badgesHtml(note, bm, v, artBadge = '', mediaBadge = '', linkBadge = '', annBadge = '') {
  const bs = [];
  if (bm) bs.push(bmBadgeHtml(bm, v));
  if (linkBadge) bs.push(linkBadge);
  if (annBadge) bs.push(annBadge);
  if (note) noteBadges(note, bs);
  if (mediaBadge) bs.push(mediaBadge);
  if (artBadge) bs.push(artBadge);
  return `<span class="badges">${bs.join('')}</span>`;
}
/** "Psalm 23", "John 3": a chapter of Psalms is a single psalm (library.refName's rule), everywhere in the chapter view. */
/** Letters in the longest word of a title: a phone shrinks 'Thessalonians' to fit rather than overflow (styles.css). */
/**
 * The title's longest run that never breaks (a book's ordinal stays with its name: '1 Thessalonians'), in letters of
 * the phone rule's .49em-per-letter estimate: its letter count, or more for a wide run ('Deuteronomy' is 5.7em).
 */
let fitCtx = null;
function longWord(t) {
  return Math.max(...String(t).replace(/^(\d) /, '$1\u00a0').split(' ').map(w => {
    let n = w.length;
    try {
      fitCtx = fitCtx || document.createElement('canvas').getContext('2d');
      fitCtx.font = `600 100px ${getComputedStyle(document.documentElement).getPropertyValue('--display')}`;
      const em = fitCtx.measureText(w).width / 100 - .028 * w.length; // the title's weight and letter-spacing
      n = Math.max(n, Math.ceil(em * 1.03 / .49 * 10) / 10);           // 3%: the laid-out run is a little wider
    } catch { /* no canvas: the letter count */ }
    return n;
  }));
}
function bookTitle(bk) { return bk.name === 'Psalms' ? 'Psalm' : bk.name; }
function chName(b, c) { return `${bookTitle(bookOf(b))} ${c}`; }
const bmBadgeLabel = bm => (bm.label ? `Bookmarked: ${bm.label}. Edit bookmark` : 'Bookmarked. Edit bookmark');
const readTitle = (read, b, c) => `Mark ${chName(b, c)} as ${read ? 'unread' : 'read'}`;
const bmFootTitle = (bm, b, c) => (bm ? 'Remove the chapter bookmark' : `Bookmark ${chName(b, c)}`);
function bmBadgeHtml(bm, v) {
  return `<button class="b-bm" type="button" aria-haspopup="dialog" data-bm-v="${v}" data-bm-color="${esc(bm.color || 'red')}" tabindex="-1" aria-label="${esc(bmBadgeLabel(bm))}" title="${esc(bm.label || 'Bookmarked')}">${icon('bookmark', 'f')}</button>`;
}
function footReadHtml(read, b, c) {
  return `<button class="pill-tog foot-read" type="button" data-mark-read aria-label="Mark as read" aria-pressed="${read}" title="${esc(readTitle(read, b, c))}">${icon('check')}<span>${read ? 'Read' : 'Mark as read'}</span></button>`;
}
function footBmHtml(bm, b, c) {
  return `<button class="pill-tog foot-bm" type="button" data-bm-chapter aria-label="Bookmark chapter" aria-pressed="${!!bm}" data-bm-color="${esc((bm && bm.color) || 'red')}" title="${esc(bmFootTitle(bm, b, c))}">${icon('bookmark', bm ? 'f' : '')}<span>${bm ? 'Bookmarked' : 'Bookmark chapter'}</span></button>`;
}
// The footer pills keep one accessible name (aria-label) and state the toggle with aria-pressed; only the visible word changes.
// In-place updates of the same controls. The nodes are kept, never re-created: a bookmark menu may be
// anchored on one (its opener gets the focus back and aria-expanded when the menu closes).
function setBmBadge(btn, bm) {
  btn.dataset.bmColor = bm.color || 'red';
  btn.setAttribute('aria-label', bmBadgeLabel(bm));
  btn.title = bm.label || 'Bookmarked';
}
function setFootRead(btn, read, b, c) {
  btn.setAttribute('aria-pressed', String(read));
  btn.title = readTitle(read, b, c);
  const s = btn.querySelector('span'); if (s) s.textContent = read ? 'Read' : 'Mark as read';
}
function setFootBm(btn, bm, b, c) {
  btn.setAttribute('aria-pressed', String(!!bm));
  btn.dataset.bmColor = (bm && bm.color) || 'red';
  btn.title = bmFootTitle(bm, b, c);
  btn.querySelector('svg')?.classList.toggle('f', !!bm);
  const s = btn.querySelector('span'); if (s) s.textContent = bm ? 'Bookmarked' : 'Bookmark chapter';
}
/** Badges for a chapter whose render finished before art.json arrived; art.js adds the plates (keeping the reading place). */
function patchArt(el, b, c) {
  el.querySelectorAll('.verse').forEach(verse => {
    if (verse.querySelector('.art-badge')) return;
    const h = artHtml('verseBadgeHtml', b, c, +verse.dataset.v); if (!h) return;
    const bs = verse.querySelector('.vmeta .badges');
    if (bs) bs.insertAdjacentHTML('beforeend', h); else verse.querySelector('.vmeta')?.insertAdjacentHTML('beforeend', `<span class="badges">${h}</span>`);
  });
  artCall('attachReader', el, b, c);
}
/** Study-video icons for a chapter whose render finished before media.json arrived: before the Doré thumbnail. */
function patchMedia(el, b, c) {
  el.querySelectorAll('.verse').forEach(verse => {
    if (verse.querySelector('.b-media')) return;
    const h = mediaHtml(b, c, +verse.dataset.v); if (!h) return;
    const bs = verse.querySelector('.vmeta .badges'), artB = bs && bs.querySelector(':scope > .art-badge');
    if (artB) artB.insertAdjacentHTML('beforebegin', h);
    else if (bs) bs.insertAdjacentHTML('beforeend', h);
    else verse.querySelector('.vmeta')?.insertAdjacentHTML('beforeend', `<span class="badges">${h}</span>`);
  });
}
function noteBadges(note, bs) {
  if (note.text) bs.push(`<span class="b-note" title="Has a note">${icon('note')}<span class="sr">Has a note</span></span>`);
  const nv = (note.videos || []).length;
  if (nv) { const t = plural(nv, 'video'); bs.push(`<span class="b-video" title="${t}">${icon('play-rect')}<span class="sr">${t}</span></span>`); }
  const tags = note.tags || [];
  if (tags.length) bs.push(`<span class="b-tag" title="${esc(tags.map(t => '#' + t).join(' '))}">${icon('tag')}<span class="sr">Tags: ${esc(tags.join(', '))}</span></span>`);
}

// ------------------------------------------------------------ scroll helpers (window scrolling)
function limits() {
  const bar = document.getElementById('topbar');
  const topLimit = Math.max(0, bar ? bar.getBoundingClientRect().bottom : 0) + 12;
  // a phone hides the bar while scrolling down and brings it back on any upward scroll (main.js onScroll):
  // offsetTop/offsetHeight ignore the hiding transform, so this is the bar's bottom once it is back
  const shownLimit = bar ? Math.max(topLimit, bar.offsetTop + bar.offsetHeight + 12) : topLimit;
  const sheet = layoutMode() === 'sheet' && state.drawerOpen;
  const d = document.getElementById('drawer');
  // offsetTop ignores the slide-in transform, so this is where the sheet will rest
  const bottomLimit = sheet && d ? d.offsetTop - 12 : window.innerHeight - 16;
  return { topLimit, shownLimit, bottomLimit, sheet };
}
/**
 * Bring a verse into view (spec §6.5): centred between the bar and the bottom, or, when the phone
 * sheet is open, parked just under the bar above the sheet. No-op when already visible unless force.
 */
export function ensureVisible(target, { force = false, instant = false } = {}) {
  const el = typeof target === 'number' || typeof target === 'string' ? document.getElementById('v' + target) : target;
  if (!el || !el.isConnected) return;
  const { topLimit, shownLimit, bottomLimit, sheet } = limits();
  if (sheet && state.sheetFull) return; // text is behind the full-height sheet
  const r = el.getBoundingClientRect();
  if (!force && r.top >= topLimit && r.bottom <= bottomLimit) return;
  const park = top => (sheet ? r.top - top - 8 : r.top - (top + bottomLimit) / 2 + Math.min(r.height, bottomLimit - top) / 2);
  let dy = park(topLimit);
  if (dy < 0 && shownLimit > topLimit) dy = park(shownLimit); // scrolling up brings the hidden bar back over the verse
  if (Math.abs(dy) < 1) return;
  window.scrollBy({ top: dy, behavior: instant || RM.matches ? 'auto' : 'smooth' });
}
/**
 * The verse being read, kept in place across a re-render: the first one below the bar, or the next one when that is
 * mostly scrolled past (art.js keepReadingPlace's rule) or only its interlinear words still show (its English is gone).
 */
function captureAnchor() {
  if (window.scrollY < 4) return null;
  const { topLimit, bottomLimit } = limits();
  const vs = [...readerEl().querySelectorAll('.verse')];
  const i = vs.findIndex(v => v.getBoundingClientRect().bottom > topLimit);
  if (i < 0) return null;
  let v = vs[i], r = v.getBoundingClientRect();
  const nx = vs[i + 1], nr = nx && nx.getBoundingClientRect();
  if (nr && r.top < topLimit) {
    const inter = v.querySelector('.inter');
    const past = inter ? inter.getBoundingClientRect().top <= topLimit && nr.top < bottomLimit
      : r.bottom - topLimit < 0.6 * r.height && nr.top < topLimit + (bottomLimit - topLimit) / 2;
    if (past) { v = nx; r = nr; }
  }
  return { id: v.id, top: r.top };
}
/** The focused verse while it is on screen: a keyboard user keeps sight of it when the interlinear opens above it. */
function focusAnchor(f) {
  const v = f && f.verse && document.getElementById(f.verse); if (!v) return null;
  const r = v.getBoundingClientRect(), { topLimit, bottomLimit } = limits();
  return r.bottom > topLimit && r.top < bottomLimit ? { id: v.id, top: r.top } : null;
}
function restoreAnchor(a) {
  const el = document.getElementById(a.id); if (!el) return;
  const dy = el.getBoundingClientRect().top - a.top;
  if (Math.abs(dy) >= 1) window.scrollBy({ top: dy, behavior: 'auto' });
}

// ------------------------------------------------------------ selection, roving tabindex, markers
function setRoving(el) {
  if (!el || el.getAttribute('tabindex') === '0') return;
  readerEl().querySelectorAll('.verse[tabindex="0"]').forEach(x => x.setAttribute('tabindex', '-1'));
  el.setAttribute('tabindex', '0');
}
/** Reflect state.selected: aria-current (capsule), roving tabindex. Scrolling is separate (ensureVisible). */
export function updateSelection() {
  readerEl().querySelectorAll('.verse[aria-current]').forEach(e => e.removeAttribute('aria-current'));
  if (!state.selected) return;
  const el = document.getElementById('v' + state.selected);
  if (el) { el.setAttribute('aria-current', 'true'); setRoving(el); }
}

/** Briefly emphasise a set of verses (e.g. the verses of an event or a map pin); scroll: false leaves the page where it is. */
let flashTimer = 0;
export function flashVerses(list, { scroll = true } = {}) {
  if (!list || !list.length) return;
  clearTimeout(flashTimer);
  readerEl().querySelectorAll('.verse.flash').forEach(e => e.classList.remove('flash'));
  const els = list.map(v => document.getElementById('v' + v)).filter(Boolean);
  if (!els.length) return;
  void els[0].offsetWidth; // restart the animation
  els.forEach(e => e.classList.add('flash'));
  // reduced motion: a static tint (CSS) instead of the fading one, taken off after the same 2.2s
  if (RM.matches) flashTimer = setTimeout(() => els.forEach(e => e.classList.remove('flash')), 2200);
  if (scroll) ensureVisible(els[0]);
}

/** Refresh highlight and badges for one verse without re-rendering the chapter. */
export function refreshVerseMarker(v) {
  const el = document.getElementById('v' + v); if (!el) return;
  const note = noteFor(refKey(state.book, state.chapter, v));
  [...el.classList].filter(x => x.startsWith('hl-')).forEach(x => el.classList.remove(x));
  if (note?.highlight) el.classList.add('hl-' + note.highlight);
  const bm = libCall('bookmarkFor', state.book, state.chapter, v) || null;
  const old = el.querySelector('.badges');
  const artNode = old && old.querySelector('.art-badge');   // keep the node: art.js bound it
  const bmNode = bm && old && old.querySelector('.b-bm');    // keep the node: a bookmark menu may be anchored on it
  const medNodes = old ? [...old.querySelectorAll('.b-media')] : []; // keep the nodes: the video player returns the focus to one
  const hadFocus = old && old.contains(document.activeElement) ? document.activeElement.className : '';
  const mh = medNodes.length ? '' : mediaHtml(state.book, state.chapter, v), lh = linkBadgeHtml(state.book, state.chapter, v), ah = annBadgeHtml(state.book, state.chapter, v);
  if (old) old.outerHTML = badgesHtml(note, bm, v, '', mh, lh, ah);
  else el.querySelector('.vmeta')?.insertAdjacentHTML('beforeend', badgesHtml(note, bm, v, '', mh, lh, ah));
  const nb = el.querySelector('.badges');
  if (medNodes.length && nb) nb.append(...medNodes);
  if (artNode && nb) nb.appendChild(artNode);
  if (bmNode && nb) { const fresh = nb.querySelector('.b-bm'); if (fresh) { setBmBadge(bmNode, bm); fresh.replaceWith(bmNode); } }
  if (hadFocus && nb) nb.querySelector('.' + String(hadFocus).split(' ')[0])?.focus({ preventScroll: true });
}

/**
 * Reflect library changes (read marks, bookmarks) in the rendered chapter without re-rendering it
 * (profiles spec §5.11): the read pill, both footer toggles and the verse ribbons that changed.
 */
export function refreshLibraryMarks() {
  const el = readerEl(); if (!el) return;
  const [b, c] = String(el.dataset.ch || '').split('.').map(Number);
  if (!b || !c || !bookOf(b)) return;
  const read = !!libCall('chapterState', b, c)?.read;
  const pill = el.querySelector('.hero .read-pill');
  if (pill) {
    const was = !pill.hidden;
    pill.hidden = !read;
    if (read && !was) { pill.classList.remove('in'); void pill.offsetWidth; pill.classList.add('in'); }
    else if (!read) pill.classList.remove('in');
  }
  const bms = libCall('bookmarksInChapter', b, c) || new Map();
  const fr = el.querySelector('[data-mark-read]');
  if (fr && (fr.getAttribute('aria-pressed') !== String(read) || fr.title !== readTitle(read, b, c))) setFootRead(fr, read, b, c);
  const fb = el.querySelector('[data-bm-chapter]'), cbm = bms.get(0);
  if (fb && (fb.getAttribute('aria-pressed') !== String(!!cbm) || fb.dataset.bmColor !== ((cbm && cbm.color) || 'red'))) setFootBm(fb, cbm, b, c);
  el.querySelectorAll('.verse').forEach(verse => {
    const v = +verse.dataset.v, bm = bms.get(v), cur = verse.querySelector('.b-bm');
    if (!bm && !cur) return;
    if (cur && bm) {
      if (cur.dataset.bmColor !== (bm.color || 'red') || cur.getAttribute('aria-label') !== bmBadgeLabel(bm)) setBmBadge(cur, bm);
      return;
    }
    if (cur) { // removed: a focused ribbon hands the focus to its verse
      const had = cur.contains(document.activeElement);
      cur.remove();
      if (had) { setRoving(verse); verse.focus({ preventScroll: true }); }
      return;
    }
    const bs = verse.querySelector('.vmeta .badges');
    if (bs) bs.insertAdjacentHTML('afterbegin', bmBadgeHtml(bm, v));
    else verse.querySelector('.vmeta')?.insertAdjacentHTML('beforeend', `<span class="badges">${bmBadgeHtml(bm, v)}</span>`);
  });
}

/**
 * My links changed (bs:links-changed): add, update or remove the gutter badges that differ, in place, in the chapter
 * shown. An edit can move a link's end, so every verse is compared rather than only the ends of the changed ids.
 */
export function refreshLinkBadges() {
  const el = readerEl(); if (!el) return;
  const [b, c] = String(el.dataset.ch || '').split('.').map(Number);
  if (!b || !c || !bookOf(b)) return;
  el.querySelectorAll('.verse').forEach(verse => {
    const v = +verse.dataset.v, m = linkMark(b, c, v), cur = verse.querySelector('.vmeta .b-link');
    if (!m && !cur) return;
    if (cur && m) {
      if (cur.dataset.linkColor !== m.color) cur.dataset.linkColor = m.color;
      const lab = linkBadgeLabel(m.n), s = cur.querySelector('span');
      if (cur.getAttribute('aria-label') !== lab) { cur.setAttribute('aria-label', lab); cur.title = plural(m.n, 'link'); if (s) s.textContent = String(m.n); }
      return;
    }
    if (cur) { // removed: a focused badge hands the focus to its verse
      const had = cur.contains(document.activeElement);
      cur.remove();
      if (had) { setRoving(verse); verse.focus({ preventScroll: true }); }
      return;
    }
    const h = linkBadgeHtml(b, c, v), bs = verse.querySelector('.vmeta .badges'), bm = bs && bs.querySelector(':scope > .b-bm');
    if (bm) bm.insertAdjacentHTML('afterend', h);
    else if (bs) bs.insertAdjacentHTML('afterbegin', h);
    else verse.querySelector('.vmeta')?.insertAdjacentHTML('beforeend', `<span class="badges">${h}</span>`);
  });
}

/**
 * Comments changed (bs:marks-changed): add, update or remove the .b-ann badges that differ, in place, in the chapter
 * shown (after the link badge, else the bookmark ribbon). Every verse is compared: an edit can add or clear a comment.
 */
export function refreshAnnBadges() {
  const el = readerEl(); if (!el) return;
  const [b, c] = String(el.dataset.ch || '').split('.').map(Number);
  if (!b || !c || !bookOf(b)) return;
  el.querySelectorAll('.verse').forEach(verse => {
    const v = +verse.dataset.v, n = annCount(b, c, v), cur = verse.querySelector('.vmeta .b-ann');
    if (!n && !cur) return;
    if (cur && n) {
      const lab = mrk.annLabel(n), s = cur.querySelector('span');
      if (cur.getAttribute('aria-label') !== lab) { cur.setAttribute('aria-label', lab); cur.title = plural(n, 'comment'); if (s) s.textContent = String(n); }
      return;
    }
    if (cur) { // removed: a focused badge hands the focus to its verse
      const had = cur.contains(document.activeElement);
      cur.remove();
      if (had) { setRoving(verse); verse.focus({ preventScroll: true }); }
      return;
    }
    const h = annBadgeHtml(b, c, v), bs = verse.querySelector('.vmeta .badges'), prev = bs && (bs.querySelector(':scope > .b-link') || bs.querySelector(':scope > .b-bm'));
    if (prev) prev.insertAdjacentHTML('afterend', h);
    else if (bs) bs.insertAdjacentHTML('afterbegin', h);
    else verse.querySelector('.vmeta')?.insertAdjacentHTML('beforeend', `<span class="badges">${h}</span>`);
  });
}

function neighbour(el, dir) {
  let x = dir > 0 ? el.nextElementSibling : el.previousElementSibling;
  while (x && !x.classList.contains('verse')) x = dir > 0 ? x.nextElementSibling : x.previousElementSibling;
  return x;
}

// ------------------------------------------------------------ events
export function bindReader() {
  const el = readerEl();
  el.addEventListener('click', e => {
    const t = e.target;
    if (t.closest('.art-slot, .art-badge')) return; // art.js handles its figures and badges
    const medBtn = t.closest('.b-media'); // a study video (media.js): never selects the verse
    if (medBtn) {
      if (!(media && safeCall(media.openFromBadge, medBtn))) A.toast?.('The video player is unavailable right now. Reload to try again.');
      return;
    }
    const bmBtn = t.closest('.b-bm');
    if (bmBtn) {
      const [b, c] = String(el.dataset.ch || '').split('.').map(Number);
      const bm = libCall('bookmarkFor', b, c, +bmBtn.dataset.bmV);
      if (bm) libCall('openBookmarkMenu', bmBtn, bm);
      return;
    }
    if (t.closest('[data-mark-read]')) {
      const [b, c] = String(el.dataset.ch || '').split('.').map(Number);
      const read = !libCall('chapterState', b, c)?.read;
      if (typeof A.markRead === 'function') A.markRead(b, c, read); else libCall('markChapters', b, c, read);
      return;
    }
    if (t.closest('[data-bm-chapter]')) {
      const [b, c] = String(el.dataset.ch || '').split('.').map(Number);
      if (typeof A.toggleBookmark === 'function') A.toggleBookmark(b, c, 0); else libCall('toggleBookmark', b, c, 0);
      return;
    }
    const chip = t.closest('.chip[data-tab]'); if (chip) { A.openTab(chip.dataset.tab, { intro: !!chip.dataset.intro }); return; }
    if (t.closest('[data-open-settings]')) { A.openSettings(); return; }
    if (t.closest('[data-dismiss-notice]')) {
      const card = t.closest('.notice'); if (!card) return;
      if (!card.classList.contains('error')) state.notice = null;
      // the focused Dismiss goes with its card: the focus moves to the next card's Dismiss, else to the reading verse
      if (card.contains(document.activeElement)) {
        let nx = card.nextElementSibling; while (nx && !nx.matches('.notice')) nx = nx.nextElementSibling;
        let pv = card.previousElementSibling; while (pv && !pv.matches('.notice')) pv = pv.previousElementSibling;
        ((nx || pv)?.querySelector('[data-dismiss-notice]') || el.querySelector('.verse[tabindex="0"]'))?.focus({ preventScroll: true });
      }
      card.remove();
      return;
    }
    const nav = t.closest('[data-nav]'); if (nav) { const d = nav.dataset.nav; A.step(d === 'prev' ? -1 : d === 'next' ? 1 : +d || 1); return; }
    const w = t.closest('.iw'); if (w) { A.select(+w.dataset.v, { tab: 'orig', word: +w.dataset.i }); return; }
    const xc = t.closest('.xc'); if (xc) { A.select(+xc.dataset.v, { tab: 'xref' }); return; }
    const lb = t.closest('.b-link'); if (lb) { A.select(+lb.dataset.linkV, { tab: 'mine' }); return; } // My links
    const ab = t.closest('.b-ann'); // comments (marks.js): the margin popover
    if (ab) {
      if (!(mrk && safeCall(mrk.openMarkPop, { v: +ab.dataset.annV, from: 'badge', origin: ab }))) A.toast?.('Comments are unavailable right now. Reload to try again.');
      return;
    }
    const verse = t.closest('.verse');
    if (verse) {
      // the reader is selecting words in this verse, not the verse (marks.js shows the highlight bubble)
      const sel = window.getSelection ? window.getSelection() : null;
      if (sel && !sel.isCollapsed && sel.rangeCount && String(sel).trim() && sel.getRangeAt(0).intersectsNode(verse)) return;
      // highlighted words open their mark (a double click is the note's: the dblclick handler)
      if (mrk && e.detail < 2 && t.closest('.vtext')) {
        const ids = safeCall(mrk.marksAtPoint, e.clientX, e.clientY);
        if (Array.isArray(ids) && ids.length && safeCall(mrk.openMarkPop, { v: +verse.dataset.v, ids, origin: verse })) return;
      }
      A.select(+verse.dataset.v, { open: false }); // a click selects; the study panel opens only when asked (Ji, 2026-10-07)
    }
  });
  el.addEventListener('dblclick', e => {
    const verse = e.target.closest('.verse'); if (!verse || e.target.closest('.xc, .iw, button')) return;
    try { window.getSelection()?.removeAllRanges(); } catch (err) { /* ignore */ }
    safeCall(mrk && mrk.closeMarkPop, { back: false });
    A.select(+verse.dataset.v, { tab: 'notes', focus: true });
  });
  el.addEventListener('keydown', e => {
    const v = e.target.closest?.('.verse');
    if (!v || e.target !== v || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); A.select(+v.dataset.v); return; }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.shiftKey) { // Shift+arrows extend a selection of words
      const next = neighbour(v, e.key === 'ArrowDown' ? 1 : -1);
      if (!next) return; // let the page scroll past the ends
      e.preventDefault();
      setRoving(next); next.focus({ preventScroll: true }); ensureVisible(next);
    }
  });
  // Copying verses gives only their text and reference: never the gutter's counts and badges, a plate's caption, the
  // interlinear words or the psalm titles between them, and as plain text, so a rich paste keeps no words-of-Jesus
  // colouring (its transparent text fill). Several verses are numbered; a phrase inside one verse is copied as it is.
  el.addEventListener('copy', e => {
    const s = window.getSelection ? window.getSelection() : null;
    if (!s || !s.rangeCount || s.isCollapsed || !e.clipboardData) return;
    const range = s.getRangeAt(0);
    const verses = [...el.querySelectorAll('.verse')].filter(v => range.intersectsNode(v));
    if (!verses.length) return;
    // parallel columns: the one the selection starts in (else ends in), the primary column otherwise
    const colOf = n => { const d = (n.nodeType === 1 ? n : n.parentElement)?.closest('.vcols > div'); return d ? (d.classList.contains('alt') ? 1 : 0) : -1; };
    let col = colOf(range.startContainer); if (col < 0) col = Math.max(0, colOf(range.endContainer));
    const textOf = v => v.querySelector(v.querySelector('.vcols') ? `.vcols > div:nth-child(${col + 1}) .vtext` : ':scope > .vtext');
    const got = [];
    for (const v of verses) {
      const t = textOf(v); if (!t || !range.intersectsNode(t)) continue;
      const r = document.createRange(); r.selectNodeContents(t);
      if (t.contains(range.startContainer)) r.setStart(range.startContainer, range.startOffset);
      if (t.contains(range.endContainer)) r.setEnd(range.endContainer, range.endOffset);
      const f = r.cloneContents();
      f.querySelectorAll('.sr, .om-why').forEach(x => x.remove()); // the omitted-verse note is editorial; its KJV reading stays
      f.querySelectorAll('.vx').forEach(x => x.append(' '));     // a folded-in verse's own number ('15 Peace be to thee')
      const text = f.textContent.replace(/\s+/g, ' ').trim();
      if (text) got.push([+v.dataset.v, text]);
    }
    if (!got.length) return;
    const t0 = textOf(verses[0]);
    const phrase = verses.length === 1 && t0 && t0.contains(range.startContainer) && t0.contains(range.endContainer);
    let out = got.length === 1 ? got[0][1] : got.map(([v, t]) => `${v} ${t}`).join('\n');
    if (!phrase) {
      const [b, c] = String(el.dataset.ch || '').split('.').map(Number);
      const first = got[0][0], last = got[got.length - 1][0];
      const ab = (verses[0].querySelector(`.vcols > div:nth-child(${col + 1})`)?.dataset.tr) || el.dataset.abbr || '';
      if (b && c && bookOf(b)) out += `\n${chName(b, c)}:${first}${last > first ? '–' + last : ''}${ab ? ` (${ab})` : ''}`;
    }
    e.clipboardData.setData('text/plain', out);
    e.preventDefault();
  });
  el.addEventListener('focusin', e => {
    const v = e.target.closest?.('.verse'); if (!v) return;
    lastFocusedV = +v.dataset.v; setRoving(v);
  });
  // read marks and bookmarks changed (main.js also calls refreshLibraryMarks; this is cheap and idempotent)
  document.addEventListener('bs:library-changed', () => refreshLibraryMarks());
  document.addEventListener('bs:links-changed', () => refreshLinkBadges());
  document.addEventListener('bs:marks-changed', () => refreshAnnBadges());
}
