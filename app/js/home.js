// Home (home-build brief §1–2): Bible Lantern's front page, ported from app/mock/home-c.html (editorial, with
// Doré's engravings). Today for a profile, and for a guest when the app runs locally (local guests can save);
// Welcome for a hosted site's guest. main.js imports this module the first time Home shows, then calls show(),
// hide() and refresh(). The personal parts come from the app's own modules (getMods), never from sample data.
import { state, data, bookOf, refLabel, esc, smart, clip, trInfo, yearLabel } from './store.js';
import { icon } from './icons.js';
import { relTime, dayLabel, localDay } from './ui.js';

// ---- Brand: the name, the domain and the Psalm 119:105 line (KJV)
const BRAND = { name: 'Bible Lantern', domain: 'biblelantern.com', motto: 'Thy word is a lamp unto my feet, and a light unto my path.', mottoRef: 'Psalm 119:105' };

// ---- Verse of the day: well-known verses that have a Doré plate, picked by day of year.
// pos = the plate's object-position in the hero (narrow = on a tall, narrow screen); light = where the engraving's own light is (% of the image).
const VOD = [
  { r: [1, 1, 3], plate: 'dore-001', pos: '50% 24%', light: [57, 30] },
  { r: [1, 22, 8], plate: 'dore-016', pos: '50% 30%', light: [52, 26] },
  { r: [40, 2, 2], plate: 'dore-163', pos: '50% 40%', narrow: '6% 40%', light: [15, 38] },
  { r: [40, 5, 8], plate: 'dore-176', pos: '50% 34%', light: [50, 34] },
  { r: [40, 17, 2], plate: 'dore-186', pos: '50% 16%', light: [50, 14] },
  { r: [40, 28, 6], plate: 'dore-220', pos: '50% 48%', light: [56, 50] },
  { r: [42, 2, 19], plate: 'dore-162', pos: '50% 44%', light: [42, 46] },
  { r: [42, 5, 5], plate: 'dore-222', pos: '50% 6%', light: [46, 8] },
  { r: [43, 6, 20], plate: 'dore-184', pos: '50% 40%', light: [68, 40] },
  { r: [44, 2, 4], plate: 'dore-224', pos: '50% 4%', light: [50, 6] },
];
// The Welcome cover: The Creation of Light, the engraving of the first verse of the day (Ji, 2026-10-07).
const COVER = { plate: 'dore-001', pos: '50% 24%', light: [57, 30] };
const DIVS = [
  ['Old Testament', [['Law', 1, 5], ['History', 6, 17], ['Wisdom', 18, 22], ['Prophets', 23, 39]]],
  ['New Testament', [['Gospels and Acts', 40, 44], ['Letters', 45, 65], ['Revelation', 66, 66]]],
];
const FEED_MAX = 6;
const ENGRAVINGS = 'Engravings: Gustave Doré (1832–1883), engravings for La Grande Bible de Tours, 1866 · Public domain · via Wikimedia Commons.';

let A = null, getMods = () => ({}), root = null, mode = '', shown = false, seq = 0, refreshT = 0, focusT = 0;
let openB = 0, vodKey = '', previewsTried = false;
const lit = new Map();      // 'vod' | 'cover' -> { fig, spec, p }: the plates whose light follows the hero's size

// ------------------------------------------------------------ small helpers
const $ = s => (root ? root.querySelector(s) : null);
const tidy = s => smart(String(s ?? '').trim());
const range = (a, z) => Array.from({ length: z - a + 1 }, (_, i) => a + i);
const nChap = b => bookOf(b).chapters.length;
const hrefOf = (b, c, v) => `#${b}/${c}${v ? `/${v}` : ''}`;
const plural = (n, w) => `${n.toLocaleString('en-GB')} ${n === 1 ? w : w + 's'}`;
const call = (mod, name, ...args) => { const f = mod && mod[name]; if (typeof f !== 'function') return undefined; try { return f(...args); } catch (e) { console.error(e); return undefined; } };
const IMG_DIR = new URL('../data/art/', import.meta.url).href;
const imgUrl = (p, large = false) => `${IMG_DIR}${p.id}${large ? '' : '-s'}.jpg`;
// title + scene, ending in one full stop (as art.js writes the engravings' alt text)
const altOf = p => { const s = tidy(p.scene); return tidy(p.title) + (s ? `. ${s}${/[.!?…]["'”’]?$/.test(s) ? '' : '.'}` : ''); };
// KJV small capitals for the divine name (LORD, GOD)
const scripture = s => esc(smart(s)).replace(/\b(LORD|GOD)\b/g, m => `<span class="sc">${m[0]}${m.slice(1).toLowerCase()}</span>`);
// a note's Markdown as one plain line (links and wiki links keep their words)
const plain = s => String(s || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => b || a).replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
  .replace(/(\*\*|__|`|~~)/g, '').replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*\S)[*_](?!\w)/g, '$1$2').replace(/\s+/g, ' ').trim();
const when = t => (+t ? dayLabel(localDay(+t)) : '');
// the reader's translation where it is bundled, else the KJV
const textTr = () => (state.tr === 'kjv' || state.tr === 'bsb' ? state.tr : 'kjv');
const dayOfYear = (d = new Date()) => Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 864e5);
const SPRITE = '<svg aria-hidden="true" width="0" height="0" style="position:absolute">'
  // the Bible Lantern mark: a monoline lantern on the app's 24px grid; the flame is the lamp colour
  + '<symbol id="hm-lantern" viewBox="0 0 24 24"><path d="M10.2 4.6a1.8 1.8 0 013.6 0"/><path d="M8.3 7.4l1.2-2.8h5l1.2 2.8"/><rect x="6.9" y="7.4" width="10.2" height="11.1" rx="2.6"/><path d="M8.6 21h6.8"/><path d="M12 18.5V21"/><path style="fill:var(--lamp);stroke:none" d="M12 10.1c1.55 1.7 2.25 2.95 2.25 4.05a2.25 2.25 0 01-4.5 0c0-1.1.7-2.35 2.25-4.05z"/></symbol>'
  + '<symbol id="hm-arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>'
  + '<symbol id="hm-hl" viewBox="0 0 24 24"><path d="M14.6 4.6l4.8 4.8-8.2 8.2H6.4v-4.8z"/><path d="M12 7.2l4.8 4.8"/><path d="M4 20.5h16"/></symbol>'
  + '<symbol id="hm-comment" viewBox="0 0 24 24"><path d="M7 4.5h10A2.5 2.5 0 0119.5 7v6.5A2.5 2.5 0 0117 16h-5.5L7.5 19.5V16H7a2.5 2.5 0 01-2.5-2.5V7A2.5 2.5 0 017 4.5z"/></symbol>'
  + '</svg>';
const hic = (name, cls = 'i') => `<svg class="${cls}" aria-hidden="true"><use href="#hm-${name}"/></svg>`;

/** Verses v..ve of a chapter in a bundled translation ('' when it is not to hand). */
async function verses(tr, b, c, v, ve = 0) {
  if (!v || !bookOf(b)) return '';
  const bk = await data.bible(tr, b).catch(() => null), ch = bk && bk[c];
  if (!Array.isArray(ch)) return '';
  const out = [];
  for (let i = v, last = Math.min(ve > v ? ve : v, ch.length, v + 4); i <= last; i++) if (ch[i - 1]) out.push(ch[i - 1]);
  return out.join(' ');
}

// ------------------------------------------------------------ the shell (built once; data-state picks the half)
function todayHtml() {
  return `<div class="hm-today" data-only="today">
    <section class="cover dk" aria-labelledby="hm-h-today">
      <div class="plate" data-plate="vod"><img alt="" decoding="async" fetchpriority="high"><span class="glow"></span><span class="halo"></span><span class="beam"></span><span class="shade"></span></div>
      <div class="mast"><form class="finder" role="search" id="hm-find">${icon('search')}<label class="sr" for="hm-q">Search the Bible</label><input id="hm-q" name="q" type="search" placeholder="John 3:16, love, G26" autocomplete="off" enterkeyhint="search" spellcheck="false"></form></div>
      <div class="hero-in wrap">
        <h1 id="hm-h-today" class="dateline" tabindex="-1"><span class="dl-k" id="hm-greet">Today</span><span class="sr">, </span> <span class="dl-sep" aria-hidden="true"></span> <span id="hm-date"></span></h1>
        <p class="vod-k">Verse of the day</p>
        <a class="vod" id="hm-vod" href="#"><span class="vod-t" id="hm-vod-t">&nbsp;</span><span class="vod-r"><span class="vod-ref" id="hm-vod-ref"></span> <span class="vod-go">Open the verse${hic('arrow')}</span></span></a>
      </div>
      <button class="plate-cap" type="button" data-cap="vod" hidden>${icon('photo')}<span><b></b><br>Gustave Doré, 1866</span></button>
    </section>
    <section class="cont dk" aria-labelledby="hm-h-cont" id="hm-cont"></section>
  </div>`;
}
function welcomeHtml() {
  const [a, ...z] = BRAND.motto.split(', ');
  return `<div class="hm-welcome" data-only="welcome">
    <section class="cover cover-g dk" aria-labelledby="hm-h-welcome">
      <div class="plate" data-plate="cover"><img alt="" decoding="async" fetchpriority="high"><span class="glow"></span><span class="halo"></span><span class="beam"></span><span class="shade"></span></div>
      <div class="hero-in wrap">
        <h1 id="hm-h-welcome" class="wm" tabindex="-1">${hic('lantern', 'mark')}<span>${esc(BRAND.name)}</span></h1>
        <blockquote class="motto"><p><span class="half">${esc(a)},</span> <span class="half">${esc(z.join(', '))}</span></p><footer><cite>${esc(BRAND.mottoRef)}</cite> <span>· KJV</span></footer></blockquote>
        <p class="g-dek">A quiet place to read the Bible closely, with cross-references, maps, the original languages and Doré’s engravings beside the text.</p>
        <div class="cta">
          <a class="lbtn btn-fill" href="${hrefOf(43, 1)}">Start reading <span class="btn-sub">John 1</span></a>
          <button class="lbtn btn-glass" type="button" data-act="signin" aria-haspopup="dialog">Sign in</button>
          <button class="cta-link" type="button" data-act="invite" aria-haspopup="dialog">I have an invite</button>
        </div>
      </div>
      <button class="plate-cap" type="button" data-cap="cover" hidden>${icon('photo')}<span><b></b><br>Gustave Doré, 1866</span></button>
    </section>
  </div>`;
}
function paperHtml() {
  return `<div class="paper">
    <section class="sec wrap" aria-labelledby="hm-h-study" data-only="today">
      <header class="sec-h"><h2 id="hm-h-study" class="sec-t">Your study, recently</h2><p class="sec-d">Your latest notes, highlights and links, each with its verse.</p></header>
      <div class="study-in">
        <ol class="feed" id="hm-feed"></ol>
        <aside class="tally" aria-labelledby="hm-h-stats">
          <h3 id="hm-h-stats" class="sr">Your reading</h3>
          <div>
            <p class="stat-n"><span id="hm-streak">0</span>${hic('lantern', 'mark')}</p>
            <p class="stat-l">day reading streak</p>
            <p class="stat-s" id="hm-streak-s"></p>
          </div>
          <div>
            <p class="stat-n" id="hm-week-n">0</p>
            <p class="stat-l" id="hm-week-l">chapters this week</p>
            <ol class="week" id="hm-week" aria-label="Chapters read each day"></ol>
          </div>
        </aside>
      </div>
    </section>
    <section class="sec wrap" aria-labelledby="hm-h-feats" data-only="welcome" id="hm-feats">
      <header class="sec-h"><h2 id="hm-h-feats" class="sec-t">What you’ll find beside the text</h2><p class="sec-d">Every chapter opens with these close at hand. A few real examples:</p></header>
      <div class="tiles" id="hm-tiles">${tilesHtml()}</div>
    </section>
    <section class="sec wrap" aria-labelledby="hm-h-atlas">
      <header class="sec-h"><h2 id="hm-h-atlas" class="sec-t">The whole Bible at a glance</h2><p class="sec-d" id="hm-atlas-d"></p></header>
      <div class="atlas-in" id="hm-atlas"></div>
    </section>
  </div>`;
}
function coloHtml() {
  return `<footer class="colo dk">
    <div class="wrap colo-in">
      <p class="colo-b">${hic('lantern', 'mark')}<span>${esc(BRAND.name)}</span></p>
      <blockquote class="colo-m"><p>${esc(BRAND.motto)}</p><footer><cite>${esc(BRAND.mottoRef)}</cite></footer></blockquote>
      <p class="colo-c" id="hm-credit"></p>
      <p class="colo-d">${esc(BRAND.domain)}</p>
    </div>
  </footer>`;
}
function build() {
  if (root) return true;
  const el = document.getElementById('home'); if (!el) return false;
  root = el;
  root.innerHTML = SPRITE + todayHtml() + welcomeHtml() + paperHtml() + coloHtml();
  bind();
  return true;
}

// ------------------------------------------------------------ the lamp: light falling across a plate
async function plateFor(id) {
  const art = getMods().art;
  if (!art || typeof art.load !== 'function') return null;
  try { await art.load(); } catch (e) { return null; }
  return call(art, 'plate', id) || null;
}
/** Show a Doré plate behind a hero (the small file first, then the large one), with its caption button. */
function setPlate(which, spec) {
  const fig = $(`[data-plate="${which}"]`), cap = $(`[data-cap="${which}"]`);
  if (!fig || fig.dataset.id === spec.plate) return;
  fig.dataset.id = spec.plate;
  plateFor(spec.plate).then(p => {
    if (fig.dataset.id !== spec.plate) return;   // another day's plate asked meanwhile
    const img = fig.querySelector('img');
    if (!p) { fig.hidden = true; if (cap) cap.hidden = true; lit.delete(which); return; }
    fig.hidden = false; fig.classList.remove('is-on');
    img.alt = altOf(p); img.width = p.w; img.height = p.h;
    img.addEventListener('load', () => fig.classList.add('is-on'), { once: true });
    img.src = imgUrl(p);
    const big = new Image();
    big.onload = () => { if (fig.dataset.id === p.id) img.src = big.src; }; // a failed large file keeps the small
    big.src = imgUrl(p, true);
    const entry = { fig, spec, p }; lit.set(which, entry); placeLight(entry);
    if (cap) {
      cap.querySelector('b').textContent = tidy(p.title);
      cap.setAttribute('aria-label', `${tidy(p.title)}, by Gustave Doré. View the engraving`);
      cap.dataset.id = p.id; cap.hidden = false;
    }
  });
}
// Map the light's place in the image to the cropped hero, so the glow sits on the engraving's own light,
// and aim the faint shaft at the words (lower left).
function placeLight({ fig, spec, p }) {
  const W = fig.clientWidth, H = fig.clientHeight; if (!W || !H) return;
  const s = Math.max(W / p.w, H / p.h), iw = p.w * s, ih = p.h * s;
  const pos = spec.narrow && W / H < 0.75 ? spec.narrow : spec.pos;
  fig.style.setProperty('--pos', pos);
  const [px, py] = pos.split(' ').map(parseFloat);
  const lx = (W - iw) * px / 100 + iw * spec.light[0] / 100, ly = (H - ih) * py / 100 + ih * spec.light[1] / 100;
  const tx = W * (W < 600 ? 0.45 : 0.28), ty = H * 0.8;
  const a = Math.atan2(tx - lx, -(ty - ly)) * 180 / Math.PI;
  fig.style.setProperty('--lx', `${Math.round(lx)}px`);
  fig.style.setProperty('--ly', `${Math.round(ly)}px`);
  fig.style.setProperty('--ba', `${a.toFixed(1)}deg`);
}
const placeAll = () => lit.forEach(placeLight);

// ------------------------------------------------------------ Today
function firstName() {
  const n = state.auth && state.auth.signedIn && state.auth.user ? String(state.auth.user.name || '').trim() : '';
  return n ? clip(n.split(/\s+/)[0], 30) : '';
}
function renderDate() {
  const now = new Date(), h = now.getHours(), name = firstName();
  $('#hm-greet').textContent = `Good ${h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'}${name ? `, ${name}` : ''}`;
  $('#hm-date').textContent = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}
async function renderVod(my) {
  const d = VOD[dayOfYear() % VOD.length], [b, c, v] = d.r, tr = textTr();
  setPlate('vod', d);
  $('#hm-vod').href = hrefOf(b, c, v);
  $('#hm-vod-ref').textContent = `${refLabel(b, c, v)} · ${trInfo(tr).abbr}`;
  const key = `${b}.${c}.${v}|${tr}`; if (vodKey === key) return;
  const text = await verses(tr, b, c, v);
  if (my !== seq || !text) return;
  vodKey = key;
  const t = $('#hm-vod-t'); t.innerHTML = scripture(text); t.classList.toggle('long', text.length > 110);
}
/** Continue reading: the library's (or this browser's) last position; without one, two places to begin. */
async function renderCont(my) {
  const host = $('#hm-cont'), L = getMods().library, pos = call(L, 'currentPosition');
  if (!pos || !bookOf(pos.b) || !(pos.c >= 1 && pos.c <= nChap(pos.b))) {
    const text = await verses(textTr(), 43, 1, 1);
    if (my !== seq) return;
    host.innerHTML = `<div class="wrap cont-in"><div><h2 id="hm-h-cont" class="kick">Start reading</h2><p class="cont-t">In the beginning</p><p class="cont-at">John 1 or Genesis 1</p></div>`
      + `<blockquote class="cont-q"><span class="vnumb">1</span>${scripture(text)}</blockquote>`
      + `<div class="cont-b two"><a class="lbtn btn-fill" href="${hrefOf(43, 1)}" aria-label="Start reading John 1">Start reading${hic('arrow')}</a><a class="lbtn btn-glass" href="${hrefOf(1, 1)}">Genesis 1</a></div></div>`;
    return;
  }
  const { b, c } = pos, n = bookOf(b).chapters[c - 1], v = Math.min(Math.max(0, +pos.v || 0), n);
  const st = call(L, 'chapterState', b, c), read = !!(st && st.read);
  const pct = read ? 100 : Math.min(100, Math.round(Math.max(v ? v / n : 0, +pos.scrollFrac || 0) * 100));
  const sv = v || 1, text = await verses(textTr(), b, c, sv);
  if (my !== seq) return;
  const at = (v ? `Verse ${v} of ${n}` : 'At the start of the chapter') + (+pos.t ? ` · ${relTime(pos.t)}` : '');
  const lab = refLabel(b, c);
  host.innerHTML = `<div class="wrap cont-in"><div><h2 id="hm-h-cont" class="kick">Continue reading</h2><p class="cont-t"><a href="${hrefOf(b, c)}" data-resume>${esc(lab)}</a></p><p class="cont-at">${esc(at)}</p></div>`
    + `<blockquote class="cont-q"><span class="vnumb">${sv}</span>${scripture(clip(text, 320))}</blockquote>`
    + `<div class="cont-b"><div class="cprog"><span>Chapter progress</span><span class="prog-n">${read ? 'Read' : `${pct}%`}</span>`
    + `<span class="prog-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(`${lab} progress`)}"><span style="width:${pct}%"></span></span></div>`
    + `<a class="lbtn btn-fill" href="${hrefOf(b, c)}" data-resume aria-label="${esc(`Resume ${refLabel(b, c, v)}`)}">Resume${hic('arrow')}</a></div></div>`;
}

/** The latest notes, highlights, comments and links (up to FEED_MAX), newest first. */
function recentItems() {
  const out = [], M = getMods().mrk, L = getMods().lnk;
  for (const [k, n] of Object.entries((state.notes && state.notes.refs) || {})) {
    if (!n) continue;
    const [b, c, v = 0] = k.split('.').map(Number); if (!bookOf(b) || !(c >= 1 && c <= nChap(b))) continue;
    const text = plain(n.text), t = +n.updated || +n.created || 0;
    if (text) out.push({ kind: 'note', t, b, c, v, note: text, hl: v ? n.highlight || '' : '' });
    else if (n.highlight && v) out.push({ kind: 'highlight', t, b, c, v, hl: n.highlight });
  }
  if (M && M.marks && M.marks.byId) for (const m of M.marks.byId.values()) {
    const s = String(m.start || '').split('.').map(Number), e = String(m.end || '').split('.').map(Number);
    if (!bookOf(s[0]) || !s[2]) continue;
    out.push({ kind: m.color ? 'highlight' : 'comment', t: +m.updated || +m.created || 0, b: s[0], c: s[1], v: s[2], ve: e[1] === s[1] && e[2] > s[2] ? e[2] : 0, mark: m });
  }
  if (L && L.links && L.links.byId && typeof L.parseLinkRef === 'function') for (const l of L.links.byId.values()) {
    const f = L.parseLinkRef(l.from), to = L.parseLinkRef(l.to); if (!f || !to) continue;
    out.push({ kind: 'link', t: +l.updated || +l.created || 0, b: f.b, c: f.c, v: f.v, ve: f.ve, to, link: l });
  }
  return out.sort((x, y) => y.t - x.t).slice(0, FEED_MAX);
}
/** A verse with the marked words picked out (the quote found again in the bundled text), or the quote alone. */
function markIn(text, quote, cls) {
  const t = smart(text), q = smart(String(quote || '').trim()), i = q && t ? t.indexOf(q) : -1;
  if (i < 0) return q ? `<mark class="${cls}">${scripture(q)}</mark>` : scripture(clip(t, 360));
  return `${scripture(t.slice(0, i))}<mark class="${cls}">${scripture(q)}</mark>${scripture(t.slice(i + q.length))}`;
}
async function entryHtml(e) {
  const K = { note: [icon('note'), 'Note'], highlight: [hic('hl'), 'Highlight'], comment: [hic('comment'), 'Comment'], link: [icon('link'), 'Link'] }[e.kind];
  let ref = `<a href="${hrefOf(e.b, e.c, e.v)}">${esc(refLabel(e.b, e.c, e.v, e.ve))}</a>`, verse = '', note = '';
  if (e.kind === 'link') {
    const L = getMods().lnk, l = e.link, T = (L.TYPES || []).find(x => x.id === l.type);
    const arrow = l.dir === 'both' ? '↔' : l.dir === 'from' ? '←' : '→', says = call(L, 'phrase', l, l.from) || 'is linked to';
    ref += `<span class="to" aria-hidden="true">${arrow}</span><span class="sr"> ${esc(says)} </span><a href="${hrefOf(e.to.b, e.to.c, e.to.v)}">${esc(refLabel(e.to.b, e.to.c, e.to.v, e.to.ve > e.to.v ? e.to.ve : 0))}</a>`;
    verse = scripture(clip(await verses(textTr(), e.b, e.c, e.v, e.ve), 360));
    const label = l.type === 'custom' ? (l.label || 'Linked') : (l.label || (T && T.label) || 'Related');
    note = `<strong>${esc(tidy(label))}.</strong>${String(l.note || '').trim() ? ` ${esc(tidy(clip(plain(l.note), 280)))}` : ''}`;
  } else if (e.mark) {
    const m = e.mark, tr = m.tr === 'kjv' || m.tr === 'bsb' ? m.tr : '';
    verse = markIn(tr ? await verses(tr, e.b, e.c, e.v, e.ve) : '', m.quote, m.color ? `mk-${m.color}` : 'mk-note');
    if (String(m.note || '').trim()) note = esc(tidy(clip(plain(m.note), 280)));
  } else {
    const text = e.v ? await verses(textTr(), e.b, e.c, e.v) : '';
    verse = text ? (e.hl ? `<mark class="hl-${esc(e.hl)}">${scripture(text)}</mark>` : scripture(text)) : '';
    if (e.note) note = esc(tidy(clip(e.note, 280)));
  }
  const day = when(e.t);
  return `<li class="entry"><p class="e-k">${K[0]}${K[1]}${day ? ` <span aria-hidden="true">·</span> <time datetime="${new Date(e.t).toISOString()}">${esc(day)}</time>` : ''}</p>`
    + `<h3 class="e-ref">${ref}</h3>${verse ? `<blockquote class="e-v">${verse}</blockquote>` : ''}${note ? `<p class="e-n">${note}</p>` : ''}</li>`;
}
async function renderStudy(my) {
  const rows = await Promise.all(recentItems().map(e => entryHtml(e).catch(err => { console.error(err); return ''; })));
  if (my !== seq) return;
  const html = rows.filter(Boolean).join('');
  $('#hm-feed').innerHTML = html || `<li class="entry none"><p class="e-k">${icon('note')}Nothing here yet</p>`
    + '<p class="e-v">As you read, choose a verse to write a note, highlight a few words or link it to another passage. They’ll gather here.</p></li>';
  renderTally();
}
/** Streak and chapters this week, from library.js (readingWeek: the Library's stats plus each chapter's readAt). */
function renderTally() {
  const w = call(getMods().library, 'readingWeek', 7);
  const days = (w && w.days) || range(0, 6).map(i => ({ ago: 6 - i, n: 0 }));
  const cur = (w && w.current) || 0, total = (w && w.total) || 0, max = Math.max(1, ...days.map(x => x.n));
  $('#hm-streak').textContent = cur.toLocaleString('en-GB');
  $('#hm-streak-s').textContent = w && w.studiedToday ? 'You’ve read today' : cur ? 'Read today to keep it going' : 'Read today to start one';
  $('#hm-week-n').textContent = total.toLocaleString('en-GB');
  $('#hm-week-l').textContent = total === 1 ? 'chapter this week' : 'chapters this week';
  const now = new Date();
  $('#hm-week').innerHTML = days.map(x => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - x.ago), name = d.toLocaleDateString('en-GB', { weekday: 'long' });
    return `<li class="${x.ago ? '' : 'now'}" aria-label="${esc(`${x.ago ? name : 'Today'}: ${plural(x.n, 'chapter')}`)}"><span class="bar" style="--h:${Math.round(x.n / max * 100)}%"></span><span aria-hidden="true">${name[0]}</span></li>`;
  }).join('');
}

// ------------------------------------------------------------ the whole Bible at a glance
function atlasData() {
  if (mode !== 'today') return { read: null, here: null };
  const L = getMods().library, pos = call(L, 'currentPosition');
  return { read: call(L, 'chaptersRead') || new Map(), here: pos && bookOf(pos.b) ? pos : null };
}
function renderAtlas() {
  const host = $('#hm-atlas'), { read } = atlasData();
  // a redraw (new data) keeps the open book and the focused book or chapter
  const ae = document.activeElement, inAtlas = host.contains(ae);
  const focusB = inAtlas && ae.matches('.bk') ? ae.dataset.b : null, focusH = inAtlas && ae.matches('a') ? ae.getAttribute('href') : null;
  $('#hm-atlas-d').innerHTML = read
    ? '<span class="keyline"><i aria-hidden="true"></i>Each book is lit by how much of it you’ve read. Choose one for its chapters.</span>'
    : 'Choose a book for its chapters, then start anywhere.';
  host.innerHTML = DIVS.map(([t, divs], ti) => {
    const all = divs.flatMap(([, a, z]) => range(a, z));
    const chs = all.reduce((n, b) => n + nChap(b), 0), done = read ? all.reduce((n, b) => n + (read.get(b)?.size || 0), 0) : 0;
    const sub = read ? `${done.toLocaleString('en-GB')} of ${chs.toLocaleString('en-GB')} chapters read` : `${all.length} books · ${chs.toLocaleString('en-GB')} chapters`;
    return `<div class="tst"><h3 class="tst-t">${t} <span>${sub}</span></h3>` + divs.map(([n, a, z], di) => {
      const id = `hm-chs-${ti}-${di}`;
      return `<div class="dv"><p class="dv-n">${n}</p><ul class="books">${range(a, z).map(b => bookBtn(b, id, read)).join('')}</ul><div class="chs" id="${id}" hidden></div></div>`;
    }).join('') + '</div>';
  }).join('');
  if (openB) openBook(openB, { focus: false });
  if (focusH) (host.querySelector(`a[href="${focusH}"]`) || host.querySelector(`.bk[data-b="${openB}"]`))?.focus({ preventScroll: true });
  else if (focusB) host.querySelector(`.bk[data-b="${focusB}"]`)?.focus({ preventScroll: true });
}
function bookBtn(b, panel, read) {
  const name = bookOf(b).name, n = nChap(b), r = read ? (read.get(b)?.size || 0) : 0;
  const lab = read ? `${name}, ${r === n ? `all ${plural(n, 'chapter')} read` : r ? `${r} of ${n} chapters read` : 'not read yet'}` : `${name}, ${plural(n, 'chapter')}`;
  return `<li><button class="bk${r ? ' has-read' : ''}" type="button" data-b="${b}" aria-expanded="false" aria-controls="${panel}" aria-label="${esc(lab)}" style="--lit:${(r / n).toFixed(3)}">${esc(name)}</button></li>`;
}
function chaptersHtml(b) {
  const { read, here: pos } = atlasData(), name = bookOf(b).name, n = nChap(b), got = (read && read.get(b)) || new Set();
  const here = pos && pos.b === b ? pos.c : 0, next = read ? (here || range(1, n).find(c => !got.has(c)) || 1) : 1;
  const sub = read ? (got.size === n ? `All ${plural(n, 'chapter')} read` : `${got.size} of ${n} chapters read`) : plural(n, 'chapter');
  const go = read && next > 1 ? `Continue at chapter ${next}` : 'Start at chapter 1';
  return `<div class="chs-h"><p class="chs-t">${esc(name)}</p><p class="chs-s">${sub}</p><a class="chs-go" href="${hrefOf(b, next)}">${go}</a>`
    + `<button class="chs-x" type="button" data-close aria-label="Close ${esc(name)}">${icon('xmark')}</button></div>`
    + `<ol class="chs-grid" aria-label="${esc(`${name} chapters`)}">${range(1, n).map(c => {
      const cls = ['ch', got.has(c) ? 'is-read' : '', c === here ? 'is-here' : ''].filter(Boolean).join(' ');
      const st = c === here ? ', reading now' : got.has(c) ? ', read' : '';
      return `<li><a class="${cls}" href="${hrefOf(b, c)}" aria-label="${esc(`${refLabel(b, c)}${st}`)}">${c}</a></li>`;
    }).join('')}</ol>`;
}
function openBook(b, { focus = false } = {}) {
  const btn = $(`#hm-atlas .bk[data-b="${b}"]`); if (!btn) { openB = 0; return; }
  const panel = document.getElementById(btn.getAttribute('aria-controls'));
  btn.setAttribute('aria-expanded', 'true');
  panel.innerHTML = chaptersHtml(b); panel.hidden = false;
  openB = b;
  if (focus) btn.focus({ preventScroll: true });
}
function closeBooks(focusBtn) {
  const open = $('#hm-atlas .bk[aria-expanded="true"]');
  openB = 0;
  if (!open) return;
  open.setAttribute('aria-expanded', 'false');
  const panel = document.getElementById(open.getAttribute('aria-controls'));
  if (panel) { panel.hidden = true; panel.innerHTML = ''; }
  if (focusBtn) open.focus();
}

// ------------------------------------------------------------ Welcome: the four previews
// Real examples of what sits beside the text: John 1's cross-references as arcs, three of Doré's plates, Matthew 2's
// places and events, and Psalm 119:105 word by word. Each tile loads its data as it nears the view; the arcs and the
// map are drawn at the tile's own pixel size, and again when that size changes.
const ARCS = [43, 1];                                           // John 1, where Start reading begins
const SHOWCASE = ['dore-163', 'dore-186', 'dore-184'];          // the engravings tile (not dore-001, the cover)
const CTX = { b: 40, c: 2, route: [636, 218, 362, 878] };      // Matthew 2: Jerusalem, Bethlehem, Egypt, Nazareth
const ORIG = [19, 119, 105], LIT_WORDS = ['H5216', 'H216'];    // lamp, light
// A stylised coastline (approximate, for the preview only); the places and events are real data.
const GEO = { lat0: 25.6, lat1: 33.75, lon0: 29.1, lon1: 36.7, W: 300, H: 372 };
const MED = [[33.75, 35.6], [33.56, 35.37], [33.27, 35.2], [32.92, 35.07], [32.83, 34.96], [32.5, 34.89], [32.08, 34.77], [31.8, 34.64], [31.52, 34.44], [31.32, 34.22], [31.13, 33.8], [31.05, 33.2], [31.2, 32.5], [31.27, 32.3], [31.45, 31.8], [31.5, 31.3], [31.47, 30.8], [31.45, 30.35], [31.2, 29.9], [31.0, 29.1], [33.75, 29.1]];
const RED = [[29.95, 32.55], [29.0, 32.65], [28.0, 33.3], [27.2, 33.85], [26.2, 34.3], [25.6, 34.55], [25.6, 36.7], [26.5, 36.05], [27.3, 35.5], [28.0, 34.82], [28.9, 34.72], [29.52, 34.98], [29.45, 34.88], [28.9, 34.62], [28.0, 34.43], [27.75, 34.25], [28.2, 33.6], [29.0, 33.1], [29.9, 32.62]];
const RIVERS = [[[25.6, 32.6], [26.2, 31.9], [27.2, 31.2], [28.1, 30.75], [29.0, 31.1], [30.1, 31.25], [30.6, 31.0], [31.45, 30.35]], [[30.6, 31.0], [31.45, 31.8]], [[32.7, 35.57], [32.3, 35.55], [31.76, 35.55]]];
const LAKES = [[32.82, 35.59, 2, 3.4], [31.5, 35.5, 2.2, 8]];   // the Sea of Galilee and the Dead Sea: lat, lon, rx, ry
const SEAS = [['Great Sea', 32.75, 29.55], ['Red Sea', 27.4, 34.6]];
const PL_SIDE = { 636: 'l up', 218: 'l dn', 878: 'l' };         // labels left of the dot (Egypt's goes right)

function tilesHtml() {
  const tile = (id, n, kick, h, d, go, fixed = false) => `<article class="tile" aria-labelledby="hm-t-${id}" data-tile="${id}">`
    + `<div class="tile-art${fixed ? ' fixed' : ''} dk" id="hm-${id}-art" data-fill="${id}"></div>`
    + `<p class="tile-k kick"><b aria-hidden="true">${n}</b>${kick}</p><h3 id="hm-t-${id}">${h}</h3><p class="tile-d" id="hm-${id}-d">${d}</p>`
    + (go ? `<a class="tile-a" href="${hrefOf(...go[0])}">${esc(go[1])}${hic('arrow')}</a>` : '') + '</article>';
  return tile('arcs', '01', 'Cross-references', 'See where a chapter echoes through Scripture', 'Every cross-reference is drawn as an arc across the whole Bible, from Genesis to Revelation.', [ARCS, `Read ${refLabel(...ARCS)}`], true)
    + tile('dore', '02', 'Doré’s engravings', 'Engravings beside the verses they show', 'Plates from Gustave Doré’s 1866 Bible, placed next to the passage each one illustrates.')
    + tile('ctx', '03', 'Context', 'The places on a map, the events in order', 'In Matthew 2 the wise men come to Jerusalem, and Joseph takes the young child and his mother into Egypt, then home to Nazareth.', [[CTX.b, CTX.c], `Read ${refLabel(CTX.b, CTX.c)}`])
    + tile('orig', '04', 'Hebrew and Greek', 'The original, word by word', 'Each word with its transliteration, meaning and Strong’s number. Here is Psalm 119:105 in Hebrew.', [ORIG, `Read ${refLabel(...ORIG)}`]);
}

// The tiles drawn to their size: art element -> draw(). A draw does nothing while its size is unchanged (or none).
const sized = new Map();
let sizeRO = null;
function drawToSize(art, draw) {
  sized.set(art, draw); draw();
  if (!('ResizeObserver' in window)) return;
  if (!sizeRO) sizeRO = new ResizeObserver(es => es.forEach(e => { try { sized.get(e.target)?.(); } catch (err) { console.error(err); } }));
  sizeRO.observe(art);
}
const sizeOf = el => [Math.round(el.clientWidth), Math.round(el.clientHeight)];
/** [W, H] when el has a size other than the one it was last drawn at (and records it), else null. */
function newSize(el) {
  const [W, H] = sizeOf(el), key = `${W}x${H}`;
  if (W < 40 || H < 40 || el.dataset.drawn === key) return null;
  el.dataset.drawn = key; return [W, H];
}

/** 01: every cross-reference leaving John 1, as arcs over the Bible's 1,189 chapters (heavier links brighter). */
async function arcsTile(art) {
  const [ab, ac] = ARCS, x = await data.xref(ab), off = []; let total = 0;
  state.books.forEach((bk, i) => { off[i] = total; total += bk.chapters.length; });
  const src = off[ab - 1] + ac - 1, agg = new Map(), books = new Set(); let refs = 0;
  for (const [k, list] of Object.entries(x || {})) {
    if (!k.startsWith(`${ac}:`)) continue;
    for (const [b, c, , , votes] of list) { if (!bookOf(b)) continue; refs++; books.add(b); const t = off[b - 1] + c - 1; agg.set(t, (agg.get(t) || 0) + Math.max(1, +votes || 0)); }
  }
  if (!refs) throw new Error('no cross-references for the arcs preview');
  const lab = refLabel(ab, ac), fx = (src / (total - 1) * 100).toFixed(2);
  art.innerHTML = `<div class="arcfan"></div><div class="arcs-ax" aria-hidden="true"><span style="left:0">Genesis</span><span class="src" style="left:${fx}%">${esc(lab)}</span><span class="end">Revelation</span></div>`;
  art.setAttribute('role', 'img');
  art.setAttribute('aria-label', `Arcs from ${lab} to ${plural(refs, 'cross-reference')} in ${books.size} books, from Genesis to Revelation`);
  $('#hm-arcs-d').textContent = `${lab} alone reaches ${plural(refs, 'passage')} in ${books.size} books. Every cross-reference is drawn as an arc across the whole Bible.`;
  const fan = art.querySelector('.arcfan'), ax = art.querySelector('.arcs-ax');
  drawToSize(art, () => {
    const size = newSize(fan); if (!size) return;
    const [W, H] = size, X = t => t / (total - 1) * W, sx = X(src);
    const arcs = [...agg].filter(([t]) => Math.abs(X(t) - sx) > 1).sort((a, z) => a[1] - z[1]);
    const maxR = Math.max(1, ...arcs.map(([t]) => Math.abs(X(t) - sx) / 2)), maxW = Math.max(1, ...arcs.map(([, w]) => w)), ot = [], nt = [];
    for (const [t, w] of arcs) {
      const x1 = Math.min(X(t), sx), x2 = Math.max(X(t), sx), rx = (x2 - x1) / 2, ry = rx * (H - 8) / maxR;
      (t < off[39] ? ot : nt).push(`<path d="M${x1.toFixed(1)} ${H}A${rx.toFixed(1)} ${ry.toFixed(1)} 0 0 1 ${x2.toFixed(1)} ${H}" stroke-opacity="${(0.14 + 0.62 * Math.sqrt(w / maxW)).toFixed(2)}"/>`);
    }
    const ticks = off.map((o, i) => `<path d="M${Math.round(X(o)) + 0.5} ${H}v${i === 39 ? 10 : 5}"/>`).join('');
    fan.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">`
      + `<g class="a-ot" fill="none" stroke-width="1">${ot.join('')}</g><g class="a-nt" fill="none" stroke-width="1">${nt.join('')}</g>`
      + `<g class="a-ax" fill="none" stroke-width="1">${ticks}<path d="M0 ${H + 0.5}H${W}"/></g></svg><i class="arc-src" style="left:${fx}%"></i>`;
    // a narrow tile: the chapter's name would run into Revelation's, so it sits left of its dot, or Revelation gives way
    ax.classList.remove('tight', 'tighter');
    const gap = () => { const s = ax.querySelector('.src').getBoundingClientRect(), e = ax.querySelector('.end').getBoundingClientRect(); return e.left - s.right; };
    if (gap() < 10) { ax.classList.add('tight'); if (gap() < 10) ax.classList.replace('tight', 'tighter'); }
  });
}

/** 02: three plates as a strip; each opens the app's engraving viewer, which steps through these three. */
async function doreTile(art) {
  const A2 = getMods().art;
  if (!A2 || typeof A2.load !== 'function') throw new Error('art.js is not loaded');
  await A2.load();
  const ps = SHOWCASE.map(id => call(A2, 'plate', id)).filter(Boolean);
  if (!ps.length) throw new Error('no plates for the engravings preview');
  const at = p => { const [b, c, v, ve] = p.ref || []; return bookOf(b) ? refLabel(b, c, v, ve) : ''; };
  art.innerHTML = `<div class="strip">${ps.map(p => `<button class="pl-b" type="button" data-plate="${p.id}" style="flex:${(p.w / p.h).toFixed(3)}" aria-label="${esc(`${tidy(p.title)}${at(p) ? `, ${at(p)}` : ''}. View the engraving`)}">`
    + `<img src="${imgUrl(p)}" width="${p.sw}" height="${p.sh}" alt="" loading="lazy" decoding="async"><span aria-hidden="true">${esc(tidy(p.title))}</span></button>`).join('')}</div>`;
  const n = (call(A2, 'plates') || []).length;
  if (n) $('#hm-dore-d').textContent = `${n.toLocaleString('en-GB')} plates from Gustave Doré’s 1866 Bible, each placed beside the passage it illustrates. Choose one to see it full size.`;
}

/** 03: Matthew 2's places on a small map (the route the chapter travels) and its events in order. */
async function ctxTile(art) {
  const [ctx, places, events] = await Promise.all([data.context(CTX.b), data.places(), data.events()]);
  const ids = new Set(); Object.values((ctx && ctx[CTX.c] && ctx[CTX.c].v) || {}).forEach(d => (d.e || []).forEach(id => ids.add(id)));
  const evs = [...ids].map(id => ({ id, ...events[id] })).filter(e => e.t).sort((a, z) => (a.sk ?? a.y) - (z.sk ?? z.y) || a.id - z.id);
  const route = CTX.route.map(id => ({ id, ...places[id] })).filter(p => p.n && isFinite(p.lat) && isFinite(p.lon));
  if (!route.length || !evs.length) throw new Error('no places or events for the context preview');
  const lab = refLabel(CTX.b, CTX.c), names = route.map(p => p.n), era = yearLabel(evs[0].y);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  art.innerHTML = `<div class="ctx"><div class="map" role="img" aria-label="${esc(`Map of ${list}`)}"></div>`
    + `<div class="tline"><p class="tl-h">${esc(lab)}${era ? `<span>${esc(era.replace(/^(\d)/, 'c. $1'))}</span>` : ''}</p>`
    + `<ol aria-label="${esc(`The events of ${lab} in order`)}">${evs.slice(0, 7).map((e, i) => `<li${i ? '' : ' class="is-on"'}>${esc(tidy(e.t))}</li>`).join('')}</ol></div></div>`;
  const box = art.querySelector('.map');
  drawToSize(art, () => {
    const size = newSize(box); if (!size) return;
    // the coast fills the box as 'slice' would, at the box's own pixels (lines and dots stay their real width)
    const [W, H] = size, k = Math.max(W / GEO.W, H / GEO.H), ox = (W - GEO.W * k) / 2, oy = (H - GEO.H * k) / 2;
    const P = ([lat, lon]) => [ox + (lon - GEO.lon0) / (GEO.lon1 - GEO.lon0) * GEO.W * k, oy + (GEO.lat1 - lat) / (GEO.lat1 - GEO.lat0) * GEO.H * k];
    const pts = a => a.map(p => P(p).map(n => n.toFixed(1)).join(' ')).join(' ');
    const xy = route.map(p => P([p.lat, p.lon]));
    box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">`
      + `<g class="m-sea"><polygon points="${pts(MED)}"/><polygon points="${pts(RED)}"/></g>`
      + `<g class="m-coast" fill="none" stroke-width="1"><polyline points="${pts(MED.slice(0, -2))}"/><polyline points="${pts(RED)}"/></g>`
      + `<g class="m-river" fill="none" stroke-width="1.2" stroke-linecap="round">${RIVERS.map(r => `<polyline points="${pts(r)}"/>`).join('')}</g>`
      + `<g class="m-lake">${LAKES.map(([lat, lon, rx, ry]) => { const [x, y] = P([lat, lon]); return `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${(rx * k).toFixed(1)}" ry="${(ry * k).toFixed(1)}"/>`; }).join('')}</g>`
      + `<polyline class="m-route" points="${xy.map(p => p.map(n => n.toFixed(1)).join(' ')).join(' ')}" fill="none" stroke-width="1.6" stroke-dasharray="1 5" stroke-linecap="round"/>`
      + `<g class="m-pl">${xy.map(([x, y]) => `<circle class="halo" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"/>`).join('')}</g></svg>`
      + route.map((p, i) => `<span class="pl ${PL_SIDE[p.id] || ''}" aria-hidden="true" style="left:${Math.round(xy[i][0])}px;top:${Math.round(xy[i][1])}px">${esc(p.n)}</span>`).join('')
      + SEAS.map(([n, lat, lon]) => { const [x, y] = P([lat, lon]); return `<span class="sea-l" aria-hidden="true" style="left:${Math.round(x)}px;top:${Math.round(y)}px">${n}</span>`; }).join('');
  });
}

/** 04: Psalm 119:105 in Hebrew, word by word (right to left), with the two words of light lit. */
async function origTile(art) {
  const [b, c, v] = ORIG, o = await data.orig(b), words = (o && o[`${c}:${v}`]) || [];
  if (!words.length) throw new Error('no words for the Hebrew preview');
  const motto = esc(BRAND.motto).replace('lamp', '<em>lamp</em>').replace('light', '<em>light</em>');
  art.innerHTML = `<div class="ilin-w"><div class="ilin" dir="rtl" role="list" aria-label="${esc(`${refLabel(b, c, v)} in Hebrew, word by word`)}">${words.map(([w, tl, gl, s]) => `<span class="wd${LIT_WORDS.includes(s) ? ' lit' : ''}" dir="ltr" role="listitem">`
    + `<span class="wo" lang="he" dir="rtl">${esc(w)}</span><span class="wt">${esc(String(tl || '').replace(/-$/, '').replace(/'/g, 'ʼ'))}</span><span class="wg">${esc(gl)}</span><span class="ws">${esc(s)}</span></span>`).join('')}</div>`
    + `<p class="ilin-en">${motto}</p></div>`;
}

const FILLS = { arcs: arcsTile, dore: doreTile, ctx: ctxTile, orig: origTile };
let tileIO = null;
/** A tile whose data could not load leaves the grid (and the section, when none is left). */
function fillTile(art) {
  const id = art.dataset.fill; if (!FILLS[id]) return;
  delete art.dataset.fill;
  FILLS[id](art).then(() => art.classList.add('is-on'), err => {
    console.warn(`Home preview “${id}”:`, err);
    art.closest('.tile')?.remove();
    if (!$('#hm-tiles .tile')) $('#hm-feats').hidden = true;
  });
}
function watchPreviews() {
  if (previewsTried || mode !== 'welcome') return;
  previewsTried = true;
  // after the cover has had its turn (an idle moment), and then only the tiles near the view
  (window.requestIdleCallback || (f => setTimeout(f, 400)))(() => {
    const arts = [...root.querySelectorAll('#hm-tiles [data-fill]')];
    if (!('IntersectionObserver' in window)) { arts.forEach(fillTile); return; }
    tileIO = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { tileIO.unobserve(e.target); fillTile(e.target); } }), { rootMargin: '480px 0px' });
    arts.forEach(a => tileIO.observe(a));
  }, { timeout: 1000 });
}
function renderWelcome() {
  setPlate('cover', COVER);
  watchPreviews();
}

// ------------------------------------------------------------ render, events, API
function renderCredit() {
  const tr = mode === 'today' ? textTr() : 'kjv';
  $('#hm-credit').innerHTML = `${esc(`Scripture from the ${tr === 'kjv' ? 'King James Version' : `${trInfo(tr).name} and the King James Version`}. ${ENGRAVINGS}`)} Visualization inspired by <a href="https://www.chrisharrison.net/index.php/Visualizations/BibleViz" target="_blank" rel="noopener">Chris Harrison &amp; Christoph Römhild (2007)</a>. Cross-reference data: <a href="https://www.openbible.info/labs/cross-references/" target="_blank" rel="noopener">OpenBible.info</a>.`;
}
async function render() {
  if (!root) return;
  const my = ++seq, next = state.auth && state.auth.hosted && !state.auth.signedIn ? 'welcome' : 'today';
  const changed = !!mode && next !== mode;
  mode = next; root.dataset.state = next;
  if (changed) { closeBooks(false); settleFocus(); }
  renderAtlas(); renderCredit();
  if (next === 'welcome') renderWelcome();
  else { renderDate(); await Promise.all([renderVod(my), renderCont(my), renderStudy(my)]); }
  if (my === seq) requestAnimationFrame(placeAll);
}
/** Signed in from Welcome (or out from Today): the button that had focus is gone, so the heading takes it. */
function settleFocus() {
  clearTimeout(focusT);
  focusT = setTimeout(() => {
    const ae = document.activeElement;
    if (shown && (!ae || ae === document.body || (root.contains(ae) && !ae.getClientRects().length))) focusTitle();
  }, 450);
}
function bind() {
  root.addEventListener('click', e => {
    const t = e.target;
    const res = t.closest('[data-resume]');
    if (res) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return; // a new tab keeps the plain link
      const pos = call(getMods().library, 'currentPosition'); if (!pos) return;
      e.preventDefault(); A?.resume?.(pos, { focus: true }); return;
    }
    const act = t.closest('[data-act]');
    if (act) { A?.openAuth?.(act.dataset.act === 'invite' ? 'signup' : 'signin'); return; }
    const pl = t.closest('#hm-tiles .pl-b[data-plate]');
    if (pl) { A?.openArt?.(pl.dataset.plate, { returnFocus: pl, group: SHOWCASE }); return; }
    const cap = t.closest('[data-cap]');
    if (cap && cap.dataset.id) { A?.openArt?.(cap.dataset.id, { returnFocus: cap }); return; }
    if (t.closest('#hm-atlas [data-close]')) { closeBooks(true); return; }
    const bk = t.closest('#hm-atlas .bk');
    if (bk) {
      const b = +bk.dataset.b, was = bk.getAttribute('aria-expanded') === 'true';
      closeBooks(false);
      if (!was) {
        openBook(b);
        // by keyboard, focus goes into the chapters (the panel follows the whole division); Escape brings it back
        if (e.detail === 0) document.getElementById(bk.getAttribute('aria-controls'))?.querySelector('.chs-go')?.focus();
      }
    }
  });
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape' && e.target.closest && e.target.closest('#hm-atlas') && $('#hm-atlas .bk[aria-expanded="true"]')) { e.preventDefault(); closeBooks(true); }
  });
  $('#hm-find').addEventListener('submit', e => {
    e.preventDefault();
    const q = $('#hm-q').value.trim(); if (q) A?.search?.(q);
  });
  const soon = () => refresh();
  ['bs:auth-changed', 'bs:library-changed', 'bs:links-changed', 'bs:marks-changed', 'bs:note-saved', 'bs:notes-replaced'].forEach(n => document.addEventListener(n, soon));
  let rz = 0;
  addEventListener('resize', () => {
    cancelAnimationFrame(rz);
    rz = requestAnimationFrame(() => { if (!shown) return; placeAll(); if (!('ResizeObserver' in window)) sized.forEach(draw => draw()); });
  });
}

/** Wire the actions (main.js A: resume, search, openAuth, openArt) and a getter for the optional modules. */
export function init(actions, mods) { A = actions || A; if (typeof mods === 'function') getMods = mods; }
/** Home is shown: draw it with the current data. focus: the heading takes keyboard focus (entered by keyboard). */
export async function show({ focus = false } = {}) {
  if (!build()) return false;
  shown = true;
  const p = render();
  if (focus) focusTitle();
  await p;
  return true;
}
/** Home is hidden (the reader is back). Its state (an open book) stays for Back. */
export function hide() { shown = false; clearTimeout(refreshT); clearTimeout(focusT); }
/** New data (a note, a mark, a link, the library, a sign-in): redraw shortly, or on the next show. */
export function refresh() {
  clearTimeout(refreshT);
  refreshT = setTimeout(() => { if (shown) render().catch(e => console.error(e)); }, 120);
}
export function focusTitle() { $(mode === 'welcome' ? '#hm-h-welcome' : '#hm-h-today')?.focus({ preventScroll: true }); }
/** The / key on Home: the hero's search field (Today), or false so the top bar's opens. */
export function focusSearch() {
  const q = mode === 'today' ? $('#hm-q') : null; if (!q || !shown) return false;
  q.focus(); if (q.value) q.select();
  return true;
}
export const isShown = () => shown;
