// Visualisations (spec §9): hero signature arcs (SVG), the night-glass stage (Arcs and Graph on
// canvas, the MapLibre places map), the focus+context timeline (SVG), the drawer mini map (MapLibre,
// with the stylised Levant SVG as its offline fallback), the canon strip for the Links tab (SVG) and
// the shared tooltip. Colours come from CSS tokens read at draw time, so light and dark both work.
import { state, data, bookOf, refLabel, rangeEnd, esc, previewText, yearLabel, lsGet, lsSet } from './store.js';
import { icon } from './icons.js';
import { loadMapLibre, createMap, placeLinks, webglSupported, PAUL_ROUTES } from './maps.js';

let A = null;
export function init(actions) { A = actions; }

/* =====================================================================
   Shared helpers
   ===================================================================== */
const RM = window.matchMedia('(prefers-reduced-motion: reduce)');
const TAU = Math.PI * 2;
const tok = (el, name) => (el ? getComputedStyle(el).getPropertyValue(name).trim() : '');
const SANS_FALLBACK = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif';
let sansCache = '';
function SANS() {
  if (!sansCache) {
    const v = tok(document.documentElement, '--sans');
    if (!v) return SANS_FALLBACK;
    sansCache = v;
  }
  return sansCache;
}
// Used only when a token read returns an empty string (the stylesheet is not loaded yet).
const FALLBACK = { ot: '#e36a10', nt: '#1fa99b', ink: '#f5f5f7', label: '#f5f5f7', label2: '#a1a1a6', label3: '#86868b', label4: '#636366', sep: 'rgba(255,255,255,.1)', accent: '#2997ff', surface: '#0c0c10' };
function stageColors(stage) {
  const t = n => tok(stage, n);
  return {
    ot: t('--ot') || FALLBACK.ot, nt: t('--nt') || FALLBACK.nt, ink: t('--viz-ink') || FALLBACK.ink,
    label: t('--label') || FALLBACK.label, label2: t('--label-2') || FALLBACK.label2,
    label3: t('--label-3') || FALLBACK.label3, label4: t('--label-4') || FALLBACK.label4,
    sep: t('--sep') || FALLBACK.sep, accent: t('--accent') || FALLBACK.accent,
    surface: t('--stage-surface') || FALLBACK.surface,
  };
}
const DPR = () => Math.min(2, window.devicePixelRatio || 1);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const easeOutCubic = x => 1 - Math.pow(1 - x, 3);
const easeOutBack = (x, s = 0.6) => 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2);
const clip = (t, n) => (t.length > n ? t.slice(0, n).replace(/\s\S*$/, '') + '…' : t);
const testOf = b => (b <= 39 ? 'ot' : 'nt');
const testName = b => (b <= 39 ? 'Old Testament' : 'New Testament');
const fmt = n => Number(n || 0).toLocaleString('en-US');
const plural = (n, w) => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`;
// 'Heb 6:20–7:3': a range end may be in a later chapter (store.rangeEnd)
const shortRef = (b, c, v, e) => { const { ec, ev } = rangeEnd(c, v, e || 0); return `${bookOf(b).short} ${c}:${v}${ec !== c ? `–${ec}:${ev}` : ev > v ? `–${ev}` : ''}`; };
const maxOf = (arr, f) => arr.reduce((m, x) => Math.max(m, f(x)), 0);
// OpenBible votes are net votes and can be negative (readers judged the link unhelpful). Every size,
// alpha and radius goes through these, so a rejected link draws as the faintest mark, never as NaN.
const votesOf = v => Math.max(0, Math.round(+v) || 0);
const ratio = (v, max) => clamp(votesOf(v) / Math.max(1, max), 0, 1);
const strength = (v, max) => Math.sqrt(ratio(v, max));

/** Preview text as a plain string (store.previewText returns {text, tr}). */
async function pv(b, c, v, e) {
  try { const r = await previewText(b, c, v, e); return typeof r === 'string' ? r : (r && r.text) || ''; }
  catch (err) { return ''; }
}
/** '#rrggbb' | '#rgb' | 'rgb(…)' to 'rgba(r,g,b,a)' (for gradients that fade to transparent). */
function withAlpha(col, a) {
  const s = String(col).trim();
  let m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(ch => ch + ch).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) return `rgba(${m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).join(',')},${a})`;
  return a <= 0 ? 'rgba(0,0,0,0)' : s;
}
/** Deterministic 0…1 from a string (FNV-1a). */
function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}
function sizeCanvas(cv) {
  const dpr = DPR(), w = cv.clientWidth, h = cv.clientHeight;
  const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
function resetCtx(ctx) {
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.setLineDash([]); ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
}
function snapshot(cv) {
  const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height;
  c.getContext('2d').drawImage(cv, 0, 0); return c;
}
function restoreSnap(ctx, snap) {
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, snap.width, snap.height); ctx.drawImage(snap, 0, 0); ctx.restore();
}
function rrect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function setSpacing(ctx, v) { if ('letterSpacing' in ctx) ctx.letterSpacing = v; }
/* Arc hit-testing (hero strip and Arcs stage). Each arc keeps a polyline sampled about every 4px along
   the curve plus its bounding box; the pointer is measured against the segments, so the whole stroke
   is hoverable however long the arc is. */
const HIT_R = 9, HIT_TIE = 1.5;
const hitSamples = len => clamp(Math.ceil(len / 4), 8, 400);
/** Upper half-ellipse (angle π…2π) as a flat [x0, y0, x1, y1, …] polyline. */
function ellipsePts(cx, base, rx, ry) {
  const half = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry))) / 2; // Ramanujan
  const n = hitSamples(half), pts = new Float32Array((n + 1) * 2);
  for (let j = 0; j <= n; j++) { const a = Math.PI + Math.PI * j / n; pts[2 * j] = cx + rx * Math.cos(a); pts[2 * j + 1] = base + ry * Math.sin(a); }
  return pts;
}
/** Quadratic Bézier (x0,y0)→(x2,y2) with control (x1,y1) as a flat polyline. */
function quadPts(x0, y0, x1, y1, x2, y2) {
  const len = (2 * Math.hypot(x2 - x0, y2 - y0) + Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1)) / 3;
  const n = hitSamples(len), pts = new Float32Array((n + 1) * 2);
  for (let j = 0; j <= n; j++) {
    const u = j / n, a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;
    pts[2 * j] = a * x0 + b * x1 + c * x2; pts[2 * j + 1] = a * y0 + b * y1 + c * y2;
  }
  return pts;
}
/** Shortest distance from (px, py) to a flat polyline. */
function polyDist(pts, px, py) {
  let best = Infinity;
  for (let j = 2; j + 1 < pts.length; j += 2) {
    const ax = pts[j - 2], ay = pts[j - 1], dx = pts[j] - ax, dy = pts[j + 1] - ay, l2 = dx * dx + dy * dy;
    const u = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
    const d = Math.hypot(px - ax - u * dx, py - ay - u * dy);
    if (d < best) best = d;
  }
  return best;
}
/**
 * Index of the arc whose stroke passes within HIT_R of the pointer, or -1. `items[i]` carries `box`
 * [x0, y0, x1, y1] and `pts`; items are in paint order (votes ascending). Near-ties (within HIT_TIE)
 * go to the arc drawn on top: one of the selected verse (`isSel`), then the later, higher-voted one.
 */
function hitArc(items, mx, my, isSel) {
  const near = [];
  let min = HIT_R;
  items.forEach((it, i) => {
    const b = it.box;
    if (mx < b[0] - HIT_R || mx > b[2] + HIT_R || my < b[1] - HIT_R || my > b[3] + HIT_R) return;
    const d = polyDist(it.pts, mx, my);
    if (d < HIT_R) { near.push([i, d]); if (d < min) min = d; }
  });
  let best = -1, bestSel = false;
  for (const [i, d] of near) {
    if (d > min + HIT_TIE) continue;
    const s = !!isSel(items[i]);
    if (best < 0 || (s && !bestSel) || (s === bestSel && i > best)) { best = i; bestSel = s; }
  }
  return best;
}
/** Draws the first p (0…1) of a quadratic Bézier (de Casteljau split). */
function quadPart(ctx, x0, y0, x1, y1, x2, y2, p) {
  ctx.moveTo(x0, y0);
  if (p >= 1) { ctx.quadraticCurveTo(x1, y1, x2, y2); return; }
  const qx = x0 + (x1 - x0) * p, qy = y0 + (y1 - y0) * p;
  const rx = x1 + (x2 - x1) * p, ry = y1 + (y2 - y1) * p;
  ctx.quadraticCurveTo(qx, qy, qx + (rx - qx) * p, qy + (ry - qy) * p);
}

/* =====================================================================
   Tooltip (#tip.tip) — markup: .tt / .tm (with i.ot|nt dot) / .tx
   ===================================================================== */
export const tip = {
  el: null, tok: 0, key: null, x: 0, y: 0,
  node() {
    let el = tip.el && tip.el.isConnected ? tip.el : document.getElementById('tip');
    if (!el) {
      el = document.createElement('div'); el.id = 'tip'; el.className = 'tip';
      el.setAttribute('role', 'tooltip'); el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(el);
    }
    return (tip.el = el);
  },
  show(x, y, html) {
    const el = tip.node(); tip.key = null;
    if (html !== undefined) el.innerHTML = html;
    el.classList.add('on'); el.setAttribute('aria-hidden', 'false');
    tip.x = x; tip.y = y; tip.place();
  },
  place() {
    const el = tip.el; if (!el) return;
    const r = el.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    let left = tip.x + 14, top = tip.y + 16;
    if (left + r.width > vw - 8) left = tip.x - 14 - r.width;
    if (top + r.height > vh - 8) top = tip.y - 12 - r.height;
    el.style.left = clamp(left, 8, Math.max(8, vw - r.width - 8)) + 'px';
    el.style.top = clamp(top, 8, Math.max(8, vh - r.height - 8)) + 'px';
  },
  hide() {
    tip.tok++; tip.key = null;
    const el = tip.el || document.getElementById('tip');
    if (el) { el.classList.remove('on'); el.setAttribute('aria-hidden', 'true'); }
  },
};
/** Show a tooltip for `key`; while the key is unchanged only follow the pointer. `ref` appends a preview. */
function tipKeyed(e, key, head, ref) {
  if (tip.key === key && tip.el && tip.el.classList.contains('on')) { tip.x = e.clientX; tip.y = e.clientY; tip.place(); return; }
  tip.show(e.clientX, e.clientY, head); tip.key = key;
  const t = ++tip.tok;
  if (ref) pv(ref[0], ref[1], ref[2], ref[3]).then(text => {
    if (t !== tip.tok || !text || !tip.el) return;
    tip.el.insertAdjacentHTML('beforeend', `<div class="tx">${esc(clip(text, 200))}</div>`); tip.place();
  });
}
const arcTip = (b, c, l) => `<div class="tt">${esc(refLabel(b, c, l.v))}${icon('arrow-right')}${esc(refLabel(l.b, l.c, l.tv, l.e))}</div><div class="tm"><i class="${testOf(l.b)}"></i>${testName(l.b)} · ${plural(l.votes, 'vote')}</div>`;
function bookTip(e, b) {
  const B = bookOf(b);
  tipKeyed(e, 'book:' + b, `<div class="tt">${esc(B.name)}</div><div class="tm"><i class="${testOf(b)}"></i>${plural(B.chapters.length, 'chapter')} · ${esc(B.div)}</div>`);
}

/* =====================================================================
   Canon geometry (66 books, chapter-weighted)
   ===================================================================== */
function canon(W, x0 = 0) {
  const books = state.books, total = books.reduce((s, b) => s + b.chapters.length, 0) || 1, usable = W - x0 * 2;
  let ws = books.map(b => Math.max(2, usable * b.chapters.length / total));
  const sum = ws.reduce((a, z) => a + z, 0) || 1;
  ws = ws.map(w => w * usable / sum);
  let x = x0;
  return books.map((b, i) => { const s = { b: b.n, x0: x, x1: x + ws[i] }; x += ws[i]; return s; });
}
function xAt(segs, b, c, v) {
  const s = segs[b - 1], B = bookOf(b); if (!s || !B) return 0;
  const f = ((c - 1) + (v ? (v - 0.5) / Math.max(1, B.chapters[c - 1] || 1) : 0.5)) / B.chapters.length;
  return s.x0 + clamp(f, 0, 1) * (s.x1 - s.x0);
}
function chapterLinks(xr, c) {
  const out = [], pre = c + ':';
  for (const [k, list] of Object.entries(xr || {})) {
    if (!k.startsWith(pre)) continue;
    const v = +k.slice(pre.length);
    for (const x of list) out.push({ v, b: x[0], c: x[1], tv: x[2], e: x[3], votes: votesOf(x[4]) });
  }
  return out;
}
function pickLabels(segs, W, want, cur) {
  const placed = []; let html = '';
  for (const b of [...new Set(want)]) {
    const s = segs[b - 1]; if (!s) continue;
    const name = bookOf(b).name, x = (s.x0 + s.x1) / 2, w = name.length * 6.4 + 10;
    const cx = Math.min(W - w / 2, Math.max(w / 2, x)), box = [cx - w / 2, cx + w / 2];
    if (placed.some(p => !(box[1] < p[0] || box[0] > p[1]))) continue;
    placed.push(box);
    html += `<span${b === cur ? ' class="cur"' : ''} style="left:${(cx / W * 100).toFixed(2)}%">${esc(name)}</span>`;
  }
  return html;
}

/* =====================================================================
   Hero signature strip (SVG in #sig-arcs) — §9.4
   ===================================================================== */
const sig = { host: null, ro: null, timer: 0, tok: 0 };
const sigH = () => (window.innerWidth < 700 ? 104 : 140);
const sigW = host => Math.max(300, Math.round(host.clientWidth || 0));

export function renderSignature(host, { animate = false } = {}) {
  if (!host) return Promise.resolve();
  if (sig.host !== host) {
    if (sig.ro) sig.ro.disconnect();
    clearTimeout(sig.timer);
    sig.ro = null; sig.host = host;
    if ('ResizeObserver' in window) {
      // The strip stretches (non-scaling strokes) while the page reflows; redraw crisply 200ms after the last change.
      const ro = new ResizeObserver(() => {
        clearTimeout(sig.timer);
        sig.timer = setTimeout(() => {
          if (!host.isConnected) { ro.disconnect(); return; }
          if (host._links && (sigW(host) !== host._W || sigH() !== host._H)) drawSig(host, false);
        }, 200);
      });
      ro.observe(host); sig.ro = ro;
    }
  }
  return loadSig(host, animate);
}
async function loadSig(host, animate) {
  const b = state.book, c = state.chapter, t = ++sig.tok;
  let xr = {};
  try { xr = await data.xref(b); } catch (e) { xr = {}; }
  if (t !== sig.tok) return;
  host._links = chapterLinks(xr, c); host._b = b; host._c = c;
  try { drawSig(host, animate); } catch (e) { console.error(e); }
}
function drawSig(host, animate) {
  const links = host._links; if (!links) return;
  const b = host._b, c = host._c, W = sigW(host), H = sigH(), base = H - 24, segs = canon(W, 1);
  const sorted = links.slice().sort((x, z) => x.votes - z.votes);
  const maxV = Math.max(1, maxOf(sorted, l => l.votes));
  // A redraw during the draw-in (e.g. the sheet opening reflows the page) resumes it with negative delays.
  const now = performance.now();
  let anim = animate && !RM.matches, elapsed = 0;
  if (animate) host._animStart = now || 1;
  else if (!RM.matches && host._animStart && now - host._animStart < 2300) { anim = true; elapsed = now - host._animStart; }
  const items = []; let paths = '';
  sorted.forEach((l, i) => {
    const xa = xAt(segs, b, c, l.v), xb = xAt(segs, l.b, l.c, l.tv), dx = Math.abs(xb - xa);
    const ah = Math.max(4, (base - 8) * Math.pow(dx / W, 0.62)), cx = (xa + xb) / 2, cy = base - 2 * ah;
    const t = strength(l.votes, maxV), cls = testOf(l.b);
    const d = `M${xa.toFixed(1)} ${base}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${xb.toFixed(1)} ${base}`; // source to target
    paths += `<path class="arc ${cls}" data-v="${l.v}" data-i="${i}" d="${d}" pathLength="1" style="--o:${(0.12 + 0.74 * t).toFixed(3)};--w:${(0.6 + 1.9 * t).toFixed(2)}px${anim ? `;animation-delay:${Math.round(60 + 900 * dx / W - elapsed)}ms` : ''}"/>`;
    // The curve peaks at base − ah (half the control point's height).
    items.push({ l, pts: quadPts(xa, base, cx, cy, xb, base), box: [Math.min(xa, xb), base - ah, Math.max(xa, xb), base], d, cls });
  });
  let bar = '';
  for (const s of segs) {
    bar += `<rect class="seg-b ${testOf(s.b)}${s.b === b ? ' cur' : ''}" x="${(s.x0 + 0.5).toFixed(1)}" y="${base + 4}" width="${Math.max(0.8, s.x1 - s.x0 - 1).toFixed(1)}" height="5" rx="1.5"/>`;
  }
  const aria = `${plural(links.length, 'cross-reference arc')} from ${refLabel(b, c)} across the 66 books`;
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px" role="img" aria-label="${esc(aria)}">`
    + `<g class="arcs${anim ? ' anim' : ''}">${paths}</g><g class="arcs-sel"></g>`
    + `<path class="hv-halo" d=""/><path class="hv" d=""/><g class="canon">${bar}</g></svg>`
    + `<div class="arc-labels" aria-hidden="true">${pickLabels(segs, W, [b, 1, 19, 23, 40, 66, 45, 44], b)}</div>`;
  Object.assign(host, { _items: items, _segs: segs, _W: W, _H: H, _base: base, _hover: -1 });
  host.classList.remove('hovering');
  clearTimeout(host._animT);
  // Once the draw-in has finished, drop .anim so arcs moved between groups never replay it.
  if (anim) host._animT = setTimeout(() => { const g = host.querySelector('g.arcs'); if (g) g.classList.remove('anim'); }, 2400 - elapsed);
  markSig(host);
  if (!host._bound) { bindSig(host); host._bound = true; }
}
function sigPoint(host, e) {
  const svg = host.querySelector('svg'); if (!svg) return null;
  const r = svg.getBoundingClientRect(); if (!r.width || !r.height) return null;
  return { mx: (e.clientX - r.left) * host._W / r.width, my: (e.clientY - r.top) * host._H / r.height };
}
function sigHit(host, q) {
  const sel = state.book === host._b && state.chapter === host._c && state.selected ? +state.selected : 0;
  return hitArc(host._items, q.mx, q.my, it => sel && it.l.v === sel); // the selected verse's arcs are raised
}
function sigPaint(host, i) {
  const hv = host.querySelector('.hv'), halo = host.querySelector('.hv-halo'); if (!hv || !halo) return;
  host.classList.toggle('hovering', i >= 0);
  if (i < 0) { hv.removeAttribute('d'); halo.removeAttribute('d'); hv.setAttribute('class', 'hv'); return; }
  const it = host._items[i];
  hv.setAttribute('d', it.d); halo.setAttribute('d', it.d); hv.setAttribute('class', 'hv ' + it.cls);
}
function bindSig(host) {
  host.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch' || !host._items) return;
    const q = sigPoint(host, e); if (!q) return;
    const onBar = q.my > host._base + 2; // arcs end on the baseline, so the bar zone wins below it
    const i = onBar ? -1 : sigHit(host, q);
    if (i !== host._hover) { host._hover = i; sigPaint(host, i); }
    if (i >= 0) {
      const l = host._items[i].l;
      tipKeyed(e, `sig:${host._b}.${host._c}.${l.v}>${l.b}.${l.c}.${l.tv}`, arcTip(host._b, host._c, l), [l.b, l.c, l.tv, l.e]);
    } else if (q.my > host._base - 2) {
      const s = host._segs.find(z => q.mx >= z.x0 && q.mx < z.x1);
      if (s) bookTip(e, s.b); else tip.hide();
    } else tip.hide();
  });
  host.addEventListener('pointerleave', () => {
    if (host._hover !== -1) { host._hover = -1; sigPaint(host, -1); }
    tip.hide();
  });
  host.addEventListener('click', e => {
    if (!host._items || !A) return;
    const q = sigPoint(host, e); if (!q || q.my > host._base + 2) return;
    const i = sigHit(host, q); if (i < 0) return;
    const l = host._items[i].l;
    tip.hide(); host._hover = -1; sigPaint(host, -1);
    A.select(l.v, { tab: 'xref', expand: `${l.b}.${l.c}.${l.tv}` });
  });
}
/** Raise the selected verse's arcs into .arcs-sel (keeping OT/NT colour), toggle .has-sel, update #sig-cap. */
function markSig(host) {
  if (!host || !host._items) return;
  const svg = host.querySelector('svg');
  const gA = svg && svg.querySelector('g.arcs'), gS = svg && svg.querySelector('g.arcs-sel');
  if (!gA || !gS) return;
  const b = host._b, c = host._c;
  const sel = state.book === b && state.chapter === c && state.selected ? +state.selected : 0;
  const back = [...gS.children].filter(p => +p.dataset.v !== sel);
  if (back.length) {
    back.sort((x, z) => x.dataset.i - z.dataset.i);
    let node = gA.firstElementChild;
    for (const p of back) {
      const i = +p.dataset.i;
      while (node && +node.dataset.i < i) node = node.nextElementSibling;
      p.classList.remove('on'); gA.insertBefore(p, node);
    }
  }
  if (sel) gA.querySelectorAll(`.arc[data-v="${sel}"]`).forEach(p => { p.classList.add('on'); gS.appendChild(p); });
  const n = sel ? host._items.reduce((k, it) => k + (it.l.v === sel ? 1 : 0), 0) : 0;
  host.classList.toggle('has-sel', n > 0);
  const cap = document.getElementById('sig-cap');
  if (cap) {
    const total = host._items.length, ref = refLabel(b, c);
    cap.innerHTML = !sel
      ? (total ? `Every link leaving ${esc(ref)}. Select an arc to study it.` : `No cross-references leave ${esc(ref)}.`)
      : n ? `<b>${plural(n, 'link')}</b> from ${esc(refLabel(b, c, sel))} · ${fmt(total)} in the chapter`
        : `No links from ${esc(refLabel(b, c, sel))} · ${fmt(total)} in the chapter`;
  }
}
export function redrawSignature() {
  const host = sig.host && sig.host.isConnected ? sig.host : document.getElementById('sig-arcs');
  if (host && host._links) drawSig(host, false);
}
export function markSelection() {
  const host = sig.host && sig.host.isConnected ? sig.host : document.getElementById('sig-arcs');
  if (host && host._items) markSig(host);
  const S = P.arcs;
  if (P.kind === 'arcs' && S) {
    const sub = P.stage && P.stage.querySelector('.stage-sub');
    if (sub) sub.innerHTML = arcsSub(S);
    if (!S.cv) return;
    if (S.animating) S.dirty = true; else arcsStatic();
  }
}

/* =====================================================================
   My links on the stage (links-spec §3.6): the reader's own links on Arcs and Graph, and the
   OpenBible · Mine · Both control. The hero strip above never shows them (it stays OpenBible-only).
   ===================================================================== */
// links.js is optional and imports drawer.js, which imports this module: loaded at run time, never statically.
let lk = null;
import('./links.js').then(m => { if (m && typeof m.linksFor === 'function') { lk = m; lkRedraw(); } }, e => { console.error('links.js failed to load', e); });
const lkSafe = (fn, fb) => { try { return fn(); } catch (e) { console.error(e); return fb; } };
const LK_VIEWS = [['openbible', 'OpenBible'], ['mine', 'Mine'], ['both', 'Both']];
let lkView = (v => (LK_VIEWS.some(x => x[0] === v) ? v : ''))(lsGet('bs-links-view', '')); // kept in memory too (?dry stores nothing)
// the dark bookmark palette: the stage is a night tile in both themes (CSS: the night stage tokens' --bm-*)
const LK_FALLBACK = { red: '#ff453a', orange: '#ff9f0a', yellow: '#ffd60a', green: '#30d158', blue: '#0a84ff', purple: '#bf5af2' };
const lkColour = c => { const k = LK_FALLBACK[c] ? c : 'blue'; return tok(P.stage, '--bm-' + k) || LK_FALLBACK[k]; };
const lkCovers = (r, b, c, v) => !!r && r.b === b && r.c === c && v >= r.v && v <= r.ve;
/** The user's links with an end in chapter b.c: { l, here, there, side } (side: the `here` end's side). */
function lkChapter(b, c) {
  if (!lk || !lk.links) return [];
  return lkSafe(() => {
    const out = [];
    for (const l of lk.links.byId.values()) {
      const f = lk.parseLinkRef(l.from), t = lk.parseLinkRef(l.to); if (!f || !t) continue;
      const inF = f.b === b && f.c === c, inT = t.b === b && t.c === c;
      if (inF) out.push({ l, here: f, there: t, side: 'from' }); // a link inside the chapter is drawn once, from its `from` end
      else if (inT) out.push({ l, here: t, there: f, side: 'to' });
    }
    return out.sort((x, z) => x.here.v - z.here.v || x.l.created - z.l.created);
  }, []);
}
/** The user's links of one verse: { l, o } with o = links.js otherEnd (o.side: the other end's side). */
function lkVerse(b, c, v) {
  if (!lk || !v) return [];
  return lkSafe(() => lk.linksFor(b, c, v).map(l => ({ l, o: lk.otherEnd(l, b, c, v) })).filter(x => x.o && !lkCovers(x.o, b, c, v)), []);
}
/** The verse with the most user links the graph can draw (the lowest on a tie), or 0. linksInChapter also counts
    a link whose other end is a range over the verse itself, which lkVerse leaves out. */
function lkBestVerse(b, c) {
  let v = 0, best = 0;
  if (lk) for (const k of lkSafe(() => [...lk.linksInChapter(b, c).keys()], [])) { const n = lkVerse(b, c, k).length; if (n > best || (n === best && n > 0 && k < v)) { best = n; v = k; } }
  return v;
}
/** The view for a chapter: Both by default; with no links here, OpenBible and the control off. */
function lkMode(b, c) {
  const has = !!lk && lkSafe(() => lk.linksInChapter(b, c).size > 0, false);
  return { has, mode: has ? (lkView || 'both') : 'openbible' };
}
/** What the stage shows of the user's links in b.c: re-layout on bs:links-changed only when it differs. */
const lkSig = (b, c) => { const V = lkMode(b, c); return V.mode + '|' + lkChapter(b, c).map(x => `${x.l.id}:${x.l.updated}`).join(','); };
function lkTools(V) {
  const seg = LK_VIEWS.map(([k, l]) => {
    const on = V.mode === k;
    return `<button type="button" role="radio" data-lkview="${k}" aria-checked="${on}" tabindex="${on ? 0 : -1}"${V.has ? '' : ' disabled'}>${l}</button>`;
  }).join('');
  // the title sits on a wrapper: the disabled pill takes no pointer events, so its own title would never show
  return `<span class="lk-view"${V.has ? '' : ' title="You have no links here yet"'}><span class="pill-seg" role="radiogroup" aria-label="Links to show"${V.has ? '' : ' aria-disabled="true" data-off'}>${seg}</span></span>`;
}
function bindLkView(stage, render) {
  const seg = stage.querySelector('.lk-view .pill-seg'); if (!seg) return;
  const pick = k => { if (k === lkView || !LK_VIEWS.some(x => x[0] === k)) return; lkView = k; lsSet('bs-links-view', k); render(stage); };
  seg.onclick = e => { const b = e.target.closest('[data-lkview]'); if (b && !b.disabled && b.getAttribute('aria-checked') !== 'true') pick(b.dataset.lkview); };
  seg.onkeydown = e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation(); // ← → would otherwise also change the chapter
    const cur = seg.querySelector('[aria-checked="true"]'), n = LK_VIEWS.length;
    const i = Math.max(0, LK_VIEWS.findIndex(x => x[0] === (cur && cur.dataset.lkview)));
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? n - 1 : 1)) % n;
    const b = seg.querySelector(`[data-lkview="${LK_VIEWS[j][0]}"]`);
    if (b) b.focus({ preventScroll: true }); // the re-render refocuses its twin
    pick(LK_VIEWS[j][0]);
  };
}
/** "John 1:29 fulfils Isaiah 53:7 · label", always read from the `from` end. */
function lkSentence(l) {
  const f = lk.parseLinkRef(l.from), t = lk.parseLinkRef(l.to);
  return `${lk.linkRefLabel(f)} ${lk.phrase(l, 'from')} ${lk.linkRefLabel(t)}${l.label && l.type !== 'custom' ? ` · ${l.label}` : ''}`;
}
const lkDot = l => `<i class="lk" data-link-color="${esc(LK_FALLBACK[l.color] ? l.color : 'blue')}"></i>`;
const lkOf = n => (n === 1 ? '1 of your links' : `${fmt(n)} of your links`);
// Redraw an open Arcs or Graph stage after a change to the user's links (coalesced; a closed panel is left alone).
let lkT = 0;
function lkRedraw() {
  clearTimeout(lkT);
  lkT = setTimeout(() => {
    const st = P.stage, S = P.kind === 'arcs' ? P.arcs : P.kind === 'graph' ? P.graph : null;
    if (!S || !st || !st.isConnected || lkSig(S.b, S.c) === S.lsig) return;
    if (P.kind === 'arcs') renderArcs(st); else renderGraph(st);
  }, 40);
}
document.addEventListener('bs:links-changed', lkRedraw);

/* =====================================================================
   Stage (#stage): shared state, head markup, teardown — §5.6
   ===================================================================== */
const P = { kind: null, token: 0, stage: null, raf: 0, rafR: 0, ro: null, arcs: null, graph: null, map: null, pts: null, mapMode: '', mapWhy: '', lastArcs: '', lastGraph: '', refocus: '' };
const LEGEND = '<div class="legend"><span class="key ot"><i></i>Old Testament</span><span class="key nt"><i></i>New Testament</span></div>';
function stageHead({ title, sub, tools = '', legend = LEGEND, close }) {
  return `<div class="stage-head"><div class="stage-titles"><h2 class="stage-title" id="stage-title">${title}</h2><p class="stage-sub">${sub}</p>${legend}</div>`
    + `<span class="spacer"></span>${tools ? `<div class="stage-tools">${tools}</div>` : ''}`
    + `<button class="close-btn" type="button" data-close-panel aria-label="Close ${close}" title="Close (Esc)">${icon('xmark')}</button></div>`;
}
/**
 * A re-render (a new chapter, a new verse for the graph) replaces the stage's markup and with it the focused control,
 * dropping keyboard focus to <body>. stageFocus() names the control before, refocus() finds its twin after; a map
 * tool still disabled while the map loads is refocused by syncMapTools() once it is live.
 */
function stageFocus(stage) {
  const a = document.activeElement;
  if (!a || a === stage || !stage.contains(a)) return '';
  const k = ['data-paul', 'data-3d', 'data-hop', 'data-close-panel'].find(n => a.hasAttribute(n));
  return k ? `[${k}]` : a.dataset.layer ? `[data-layer="${a.dataset.layer}"]` : a.dataset.lkview ? `[data-lkview="${a.dataset.lkview}"]` : a.id === 'arc-min' ? '#arc-min' : '';
}
function refocus(stage, sel) {
  const el = sel && stage.querySelector(sel);
  if (!el || el.disabled) return false;
  const a = document.activeElement;
  if (a && a !== document.body && a !== el) return true; // the reader has moved on meanwhile
  el.focus({ preventScroll: true });
  return true;
}
function teardown() {
  P.token++;
  if (P.raf) cancelAnimationFrame(P.raf);
  if (P.rafR) cancelAnimationFrame(P.rafR);
  P.raf = 0; P.rafR = 0;
  if (P.ro) { P.ro.disconnect(); P.ro = null; }
  if (P.map) { try { P.map.remove(); } catch (e) { /* already removed */ } } // releases its WebGL context
  P.map = null; P.pts = null; P.mapMode = ''; P.mapWhy = ''; P.refocus = '';
  P.arcs = null; P.graph = null; P.kind = null;
  tip.hide();
}
/** Cancel animation frames and observers, remove the stage map instance, hide the tooltip. */
export function stopPanel() { teardown(); }
export const stopGraph = stopPanel; // back-compat alias
/** ResizeObserver on the stage body, coalesced to one call per frame. */
function observe(el, fn) {
  if (!el || !('ResizeObserver' in window)) return;
  P.ro = new ResizeObserver(() => {
    if (P.rafR) return;
    P.rafR = requestAnimationFrame(() => { P.rafR = 0; fn(); });
  });
  P.ro.observe(el);
}
const stageRef = e => { const r = e.currentTarget.getBoundingClientRect(); return { mx: e.clientX - r.left, my: e.clientY - r.top }; };

/* =====================================================================
   Stage: Arcs (canvas #arcs) — §9.5
   ===================================================================== */
function arcsSub(S) {
  const sel = state.book === S.b && state.chapter === S.c ? +state.selected || 0 : 0;
  // the user's links of the selected verse are always drawn (S.mine is empty in the OpenBible view)
  const mineSel = !!sel && S.mine.some(m => lkCovers(m.here, S.b, S.c, sel));
  if (S.mode === 'mine') {
    const n = S.mine.length, vs = !sel ? '' : mineSel ? ` · verse ${sel} highlighted` : ` · none at verse ${sel}`;
    return `${lkOf(n)} ${n === 1 ? 'starts or ends' : 'start or end'} in ${esc(refLabel(S.b, S.c))}${vs}. Click an arc to go there.`;
  }
  // With a minimum-votes filter the count says how many of the chapter's links are drawn.
  const shown = S.min > 0 ? `${fmt(S.links.reduce((k, l) => k + (l.votes >= S.min ? 1 : 0), 0))} of ` : '';
  // The selected verse is highlighted only when some of its links are drawn (arcsLayout marks l.v === sel).
  const own = sel ? S.links.filter(l => l.v === sel) : [];
  const vs = !sel ? '' : own.some(l => l.votes >= S.min) || mineSel ? ` · verse ${sel} highlighted`
    : own.length ? ` · verse ${sel}’s links are below the filter` : ` · no links from verse ${sel}`;
  const yours = S.mine.length ? ` · ${lkOf(S.mine.length)}` : '';
  return `${shown}${plural(S.links.length, 'link')} leaving ${esc(refLabel(S.b, S.c))}${yours}${vs}. Click an arc to go there.`;
}
/** The canvas's name: the links drawn at the current minimum, with their Old/New Testament split. */
function arcsAria(S) {
  if (S.mode === 'mine') return `Arc diagram: ${lkOf(S.mine.length)}, to and from ${refLabel(S.b, S.c)}.`;
  const drawn = S.min > 0 ? S.links.filter(l => l.votes >= S.min) : S.links;
  const nOT = drawn.reduce((k, l) => k + (l.b <= 39 ? 1 : 0), 0), nNT = drawn.length - nOT;
  const n = S.min > 0 ? `${fmt(drawn.length)} of ${plural(S.links.length, 'cross-reference')} (at least ${plural(S.min, 'vote')})` : plural(S.links.length, 'cross-reference');
  return `Arc diagram: ${n} from ${refLabel(S.b, S.c)} to the rest of the Bible; ${fmt(nOT)} to the Old Testament and ${fmt(nNT)} to the New Testament.${S.mine.length ? ` Also ${lkOf(S.mine.length)}.` : ''}`;
}
export async function renderArcs(stage) {
  if (!stage) return;
  const had = !!stage.querySelector('#arcs');
  teardown();
  const t = P.token; P.kind = 'arcs'; P.stage = stage;
  const b = state.book, c = state.chapter;
  let xr = {};
  try { xr = await data.xref(b); } catch (e) { xr = {}; }
  if (t !== P.token) return;
  const links = chapterLinks(xr, c), ref = refLabel(b, c);
  const maxV = Math.max(1, maxOf(links, l => l.votes)), top = Math.max(1, Math.min(300, maxV));
  const min = clamp(Math.round(+state.minVotes || 0), 0, top);
  const V = lkMode(b, c), mine = V.mode === 'openbible' ? [] : lkChapter(b, c);
  const S = { cv: null, b, c, links, maxV, min, L: null, snap: null, hover: -1, animating: false, dirty: false, mode: V.mode, mine, lsig: lkSig(b, c) };
  P.arcs = S;
  const drawn = (V.mode === 'mine' ? 0 : links.length) + mine.length;
  const fk = stageFocus(stage);
  stage.innerHTML = stageHead({
    title: 'Cross-reference arcs', sub: arcsSub(S), close: 'arcs',
    tools: lkTools(V) + `<label class="range-ctl">Minimum votes <input type="range" id="arc-min" min="0" max="${top}" step="1" value="${min}"${V.mode === 'mine' ? ' disabled' : ''}><output id="arc-min-v" for="arc-min">${min}</output></label>`,
  }) + `<div class="stage-body">${drawn
    ? `<canvas id="arcs" class="stage-canvas" role="img" aria-label="${esc(arcsAria(S))}"></canvas>`
    : `<div class="stage-empty">${V.mode === 'mine' ? `None of your links start or end in ${esc(ref)}.` : `No cross-references leave ${esc(ref)}.`}</div>`}</div>`;
  bindLkView(stage, renderArcs);
  refocus(stage, fk);
  const range = stage.querySelector('#arc-min'), out = stage.querySelector('#arc-min-v');
  const setFill = () => range.style.setProperty('--p', (100 * (+range.value) / (+range.max || 1)).toFixed(1) + '%');
  setFill();
  range.oninput = () => {
    state.minVotes = +range.value; out.textContent = range.value; setFill();
    S.min = +range.value;
    const sub = stage.querySelector('.stage-sub'); if (sub && P.arcs === S) sub.innerHTML = arcsSub(S);
    const cv = stage.querySelector('#arcs'); if (cv && P.arcs === S) cv.setAttribute('aria-label', arcsAria(S));
    if (P.arcs === S && S.cv) arcsStatic(); // live, no animation
  };
  if (!drawn) return;
  S.cv = stage.querySelector('#arcs');
  bindArcs(S);
  const key = `${b}.${c}`, anim = !RM.matches && (!had || P.lastArcs !== key);
  P.lastArcs = key;
  observe(stage.querySelector('.stage-body'), () => {
    if (P.arcs !== S) return;
    if (S.animating) { S.dirty = true; return; }
    if (S.L && S.cv.clientWidth === S.L.w && S.cv.clientHeight === S.L.h) return;
    arcsStatic();
  });
  if (anim) arcsAnimate(S); else arcsStatic();
}
function arcsLayout(S) {
  S.L = null;
  const { ctx, w, h } = sizeCanvas(S.cv);
  if (w < 60 || h < 90) return null;
  const col = stageColors(P.stage);
  const pad = 22, top = 26, base = h - 44, segs = canon(w, pad), maxH = base - top, maxSpan = Math.max(1, w - pad * 2);
  const sel = state.book === S.b && state.chapter === S.c ? +state.selected || 0 : 0;
  const src = S.b <= 39 ? col.ot : col.nt;
  const list = S.mode === 'mine' ? [] : S.links.filter(l => l.votes >= S.min).sort((x, z) => x.votes - z.votes);
  const items = list.map(l => {
    const xa = xAt(segs, S.b, S.c, l.v), xb = xAt(segs, l.b, l.c, l.tv);
    const cx = (xa + xb) / 2, rx = Math.max(0.8, Math.abs(xb - xa) / 2);
    const ry = Math.max(3, maxH * Math.pow(Math.min(1, (2 * rx) / maxSpan), 0.62));
    const t = strength(l.votes, S.maxV), tgt = l.b <= 39 ? col.ot : col.nt;
    let stroke = tgt;
    if (Math.abs(xb - xa) >= 1) { const g = ctx.createLinearGradient(xa, 0, xb, 0); g.addColorStop(0, src); g.addColorStop(1, tgt); stroke = g; }
    const pts = ellipsePts(cx, base, rx, ry), box = [cx - rx, base - ry, cx + rx, base];
    const delay = 60 + 900 * (2 * rx) / w;
    // Per-arc sweep is 900ms, shortened for the latest (longest) arcs so the whole draw-in ends by ~1.45s.
    return { l, xa, xb, cx, rx, ry, t, stroke, tgt, pts, box, delay, dur: Math.max(480, Math.min(900, 1440 - delay)), sel: !!sel && l.v === sel };
  });
  // The user's links (none in the OpenBible view): one arc each, from the middle of a range. An incoming one-way link
  // is drawn from its other end into this chapter; the others grow out of this chapter's verse.
  const uitems = S.mine.map(m => {
    const xh = xAt(segs, S.b, S.c, (m.here.v + m.here.ve) / 2), xt = xAt(segs, m.there.b, m.there.c, (m.there.v + m.there.ve) / 2);
    const inc = m.side === 'to' && m.l.dir === 'to', xa = inc ? xt : xh, xb = inc ? xh : xt;
    const cx = (xa + xb) / 2, rx = Math.max(0.8, Math.abs(xb - xa) / 2);
    const ry = Math.max(3, maxH * Math.pow(Math.min(1, (2 * rx) / maxSpan), 0.62));
    const delay = 240 + 700 * (2 * rx) / w;
    return { u: m, xa, xb, cx, rx, ry, col: lkColour(m.l.color), pts: ellipsePts(cx, base, rx, ry), box: [cx - rx, base - ry, cx + rx, base], delay, dur: Math.max(480, Math.min(900, 1560 - delay)), sel: !!sel && lkCovers(m.here, S.b, S.c, sel) };
  });
  const hasSel = items.some(it => it.sel) || uitems.some(it => it.sel);
  const order = hasSel ? items.filter(it => !it.sel).concat(items.filter(it => it.sel)) : items;
  const uorder = uitems.filter(it => !it.sel).concat(uitems.filter(it => it.sel));
  const groups = [];
  segs.forEach(s => {
    const B = bookOf(s.b), k = B.test + '|' + B.div, g = groups[groups.length - 1];
    if (g && g.k === k) { g.x1 = s.x1; g.books.push(s.b); } else groups.push({ k, div: B.div, x0: s.x0, x1: s.x1, books: [s.b] });
  });
  const gi = new Map();
  groups.forEach((g, i) => g.books.forEach(bb => gi.set(bb, i)));
  S.L = { ctx, w, h, base, segs, items, order, uitems, uorder, hit: items.concat(uitems), hasSel, groups, gi, col }; // hit: OpenBible, then the user's (on top)
  return S.L;
}
function arcsCanon(S) {
  const L = S.L, { ctx, segs, base, col, gi, groups, w } = L, F = SANS();
  for (const s of segs) {
    ctx.fillStyle = s.b <= 39 ? col.ot : col.nt;
    ctx.globalAlpha = s.b === S.b ? 1 : (gi.get(s.b) % 2 ? 0.38 : 0.55);
    rrect(ctx, s.x0 + 0.5, base + 3, Math.max(0.8, s.x1 - s.x0 - 1), 6, 2); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = `600 10px ${F}`; ctx.fillStyle = col.label3; setSpacing(ctx, '0.6px');
  let lastRight = -Infinity;
  for (const g of groups) {
    const gw = g.x1 - g.x0; if (gw <= 54) continue;
    const name = g.div.replace(/\s*Epistles$/i, '').replace(/Prophets/i, 'Proph.').toUpperCase();
    const tw = ctx.measureText(name).width, x = (g.x0 + g.x1) / 2;
    if (tw > gw + 12 || x - tw / 2 < lastRight + 8) continue;
    ctx.fillText(name, x, base + 22); lastRight = x + tw / 2;
  }
  setSpacing(ctx, '0px');
  const cs = segs[S.b - 1];
  if (cs) {
    ctx.font = `700 11px ${F}`; ctx.fillStyle = col.label;
    const name = bookOf(S.b).name, tw = ctx.measureText(name).width;
    ctx.fillText(name, clamp((cs.x0 + cs.x1) / 2, tw / 2 + 6, w - tw / 2 - 6), base + 36);
  }
}
/** Paints the arcs at `el` ms into the draw-in (Infinity = final frame). Returns true while arcs are still growing. */
function arcsPaint(S, el = Infinity) {
  const L = S.L, { ctx, w, h, base } = L;
  resetCtx(ctx); ctx.clearRect(0, 0, w, h);
  arcsCanon(S);
  ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
  let pending = false;
  for (const it of L.order) {
    let p = 1;
    if (el !== Infinity) {
      const x = (el - it.delay) / it.dur;
      if (x <= 0) { pending = true; continue; }
      if (x < 1) { p = easeOutCubic(x); pending = true; }
    }
    ctx.strokeStyle = it.stroke;
    ctx.lineWidth = it.sel ? 1.4 + 1.6 * it.t : 0.6 + 1.3 * it.t;
    ctx.globalAlpha = it.sel ? 0.95 : (0.10 + 0.5 * it.t) * (L.hasSel ? 0.22 : 1);
    arcSweep(ctx, it, base, p);
    ctx.stroke();
  }
  // The user's links above them, 2.5px in the link's colour on a thin stage-surface halo.
  ctx.globalCompositeOperation = 'source-over';
  for (const it of L.uorder) {
    let p = 1;
    if (el !== Infinity) {
      const x = (el - it.delay) / it.dur;
      if (x <= 0) { pending = true; continue; }
      if (x < 1) { p = easeOutCubic(x); pending = true; }
    }
    const a = L.hasSel && !it.sel ? 0.4 : 1;
    arcSweep(ctx, it, base, p);
    ctx.globalAlpha = 0.65 * a; ctx.strokeStyle = L.col.surface; ctx.lineWidth = 5.5; ctx.stroke();
    ctx.globalAlpha = a; ctx.strokeStyle = it.col; ctx.lineWidth = 2.5; ctx.stroke();
  }
  resetCtx(ctx);
  return pending;
}
/** The path of the first p (0…1) of an arc, swept from its source end: the arc grows out of the verse. */
function arcSweep(ctx, it, base, p) {
  ctx.beginPath();
  if (it.xb >= it.xa) ctx.ellipse(it.cx, base, it.rx, it.ry, 0, Math.PI, Math.PI + Math.PI * p);
  else ctx.ellipse(it.cx, base, it.rx, it.ry, 0, TAU - Math.PI * p, TAU);
}
function arcsStatic() {
  const S = P.arcs; if (!S || !S.cv) return;
  if (P.raf) { cancelAnimationFrame(P.raf); P.raf = 0; }
  S.animating = false; S.dirty = false; S.hover = -1;
  if (!arcsLayout(S)) { S.snap = null; return; }
  arcsPaint(S); S.snap = snapshot(S.cv);
}
function arcsAnimate(S) {
  if (P.raf) cancelAnimationFrame(P.raf);
  S.animating = true; S.snap = null; S.dirty = true;
  let t0 = 0;
  const frame = now => {
    P.raf = 0;
    if (P.arcs !== S) return;
    if (!t0) t0 = now;
    if (S.dirty) { S.dirty = false; arcsLayout(S); }
    if (!S.L) { S.animating = false; return; }
    const el = now - t0;
    if (arcsPaint(S, el) && el < 1700) { P.raf = requestAnimationFrame(frame); return; }
    S.animating = false; arcsPaint(S); S.snap = snapshot(S.cv);
    if (S.hover >= 0) arcsHover(S);
  };
  P.raf = requestAnimationFrame(frame);
}
/** Hover: restore the snapshot, then the hovered arc on a stage-surface halo (no full redraw). */
function arcsHover(S) {
  const L = S.L; if (!L || !S.snap) return;
  restoreSnap(L.ctx, S.snap);
  const it = S.hover >= 0 ? L.hit[S.hover] : null; if (!it) return;
  const ctx = L.ctx;
  resetCtx(ctx); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.ellipse(it.cx, L.base, it.rx, it.ry, 0, Math.PI, TAU);
  ctx.strokeStyle = L.col.surface; ctx.lineWidth = it.u ? 8 : 7; ctx.stroke();
  ctx.strokeStyle = it.u ? it.col : it.tgt; ctx.lineWidth = it.u ? 3.5 : 2.5; ctx.stroke();
}
function arcsHit(S, mx, my) {
  const L = S.L; if (!L) return -1;
  return hitArc(L.hit, mx, my, it => !!it.u || it.sel); // the user's arcs, then the selected verse's, are painted last
}
function bindArcs(S) {
  const cv = S.cv;
  cv.onpointermove = e => {
    if (P.arcs !== S || !S.L || e.pointerType === 'touch') return;
    const { mx, my } = stageRef(e), L = S.L;
    const i = my >= L.base + 2 ? -1 : arcsHit(S, mx, my); // arcs end on the baseline, so the bar zone wins below it
    if (i !== S.hover) { S.hover = i; if (!S.animating) arcsHover(S); }
    const onBar = i < 0 && my >= L.base - 2 && mx >= L.segs[0].x0 && mx < L.segs[L.segs.length - 1].x1;
    cv.style.cursor = i >= 0 || onBar ? 'pointer' : '';
    if (i >= 0 && L.hit[i].u) { const { l, there: o } = L.hit[i].u; tipKeyed(e, `lk:${l.id}`, lkSafe(() => `<div class="tt">${esc(lkSentence(l))}</div><div class="tm">${lkDot(l)}Your link</div>`, ''), [o.b, o.c, o.v, o.ve > o.v ? o.ve : 0]); }
    else if (i >= 0) { const l = L.hit[i].l; tipKeyed(e, `arc:${S.b}.${S.c}.${l.v}>${l.b}.${l.c}.${l.tv}`, arcTip(S.b, S.c, l), [l.b, l.c, l.tv, l.e]); }
    else if (onBar) { const s = L.segs.find(z => mx >= z.x0 && mx < z.x1); if (s) bookTip(e, s.b); else tip.hide(); }
    else tip.hide();
  };
  cv.onpointerleave = () => {
    if (P.arcs === S && S.hover !== -1) { S.hover = -1; if (!S.animating) arcsHover(S); }
    cv.style.cursor = ''; tip.hide();
  };
  cv.onclick = e => {
    if (P.arcs !== S || !S.L || !A) return;
    const { mx, my } = stageRef(e), L = S.L, i = my >= L.base + 2 ? -1 : arcsHit(S, mx, my);
    if (i >= 0) { const it = L.hit[i], o = it.u ? it.u.there : { b: it.l.b, c: it.l.c, v: it.l.tv }; tip.hide(); A.navigate(o.b, o.c, o.v); A.toggleDrawer?.(true); return; } // a picked link opens the study panel on its verse
    if (my >= L.base - 2) { const s = L.segs.find(z => mx >= z.x0 && mx < z.x1); if (s) { tip.hide(); A.navigate(s.b, 1, 0); } }
  };
}

/* =====================================================================
   Stage: Graph (canvas #graph) — §9.6
   ===================================================================== */
let graphHop = false; // second-hop toggle, kept across renders
export async function renderGraph(stage) {
  if (!stage) return;
  const had = !!stage.querySelector('#graph');
  teardown();
  const t = P.token; P.kind = 'graph'; P.stage = stage;
  const b = state.book, c = state.chapter;
  let xr = {};
  try { xr = await data.xref(b); } catch (e) { xr = {}; }
  if (t !== P.token) return;
  let v = +state.selected || 0;
  const auto = !v, V = lkMode(b, c), isMine = V.mode === 'mine';
  if (!v && isMine) v = lkBestVerse(b, c); // auto-centre: the verse with the most of the user's links
  if (!v && !isMine) {
    let best = 0;
    for (const [k, l] of Object.entries(xr)) if (k.startsWith(c + ':') && l.length > best) { best = l.length; v = +k.split(':')[1]; }
    if (!v && V.mode === 'both') v = lkBestVerse(b, c);
  }
  const list = v && !isMine ? (xr[`${c}:${v}`] || []).slice(0, 18) : [];
  const mine = V.mode === 'openbible' ? [] : lkVerse(b, c, v), nm = mine.length;
  const n = list.length, ref = v ? refLabel(b, c, v) : refLabel(b, c);
  const what = n >= 18 ? '18 strongest links' : plural(n, 'link'), yours = nm ? ` · ${lkOf(nm)}` : '';
  const sub = isMine ? (nm ? `${esc(ref)} and ${lkOf(nm)}${auto ? ' (the verse with the most of your links here)' : ''}. Click a node to study it.` : 'Only your own links are shown.')
    : !v ? `No cross-references leave ${esc(ref)}.`
      : !n ? `${esc(ref)} has no recorded cross-references${yours}.`
        : `${esc(ref)} and its ${what}${auto ? ' (the most-linked verse in this chapter)' : ''}${yours}. Size shows votes; click a node to study it.`;
  const aria = isMine ? `Link graph for ${ref}: ${lkOf(nm)}, Old Testament on the left and New Testament on the right.`
    : `Link graph for ${ref}: ${what}${nm ? ` and ${lkOf(nm)}` : ''}, Old Testament on the left and New Testament on the right.`;
  const empty = isMine ? `No links from ${esc(ref)} yet. Press c to make one.` : v ? 'No cross-references for this verse.' : 'No cross-references in this chapter.';
  const fk = stageFocus(stage);
  stage.innerHTML = stageHead({
    title: 'Link graph', sub, close: 'graph',
    tools: lkTools(V) + `<button class="pill-tog" type="button" data-hop aria-pressed="${graphHop}"${isMine ? ' disabled' : ''}>${icon('graph')}Second hop</button>`,
  }) + `<div class="stage-body">${n + nm
    ? `<canvas id="graph" class="stage-canvas" role="img" aria-label="${esc(aria)}"></canvas>`
    : `<div class="stage-empty">${empty}</div>`}</div>`;
  const G = { cv: null, b, c, v, list, mine, mode: V.mode, lsig: lkSig(b, c), hop2: null, L: null, snap: null, hover: null, animating: false, dirty: false, animFirst: false, anim2: false };
  P.graph = G;
  const btn = stage.querySelector('[data-hop]');
  btn.onclick = () => toggleHop(G, btn);
  bindLkView(stage, renderGraph);
  refocus(stage, fk);
  if (!n && !nm) return;
  G.cv = stage.querySelector('#graph');
  if (graphHop) { await loadHop(G); if (t !== P.token) return; }
  bindGraph(G);
  const key = `${b}.${c}.${v}`, anim = !RM.matches && (!had || P.lastGraph !== key);
  P.lastGraph = key;
  G.animFirst = anim; G.anim2 = anim && graphHop;
  observe(stage.querySelector('.stage-body'), () => {
    if (P.graph !== G) return;
    if (G.animating) { G.dirty = true; return; }
    if (G.L && G.cv.clientWidth === G.L.w && G.cv.clientHeight === G.L.h) return;
    graphStatic(G);
  });
  if (anim) graphAnimate(G); else graphStatic(G);
}
async function loadHop(G) {
  if (G.hop2) return G.hop2;
  const firsts = G.list.slice(0, 8);
  const books = [...new Set(firsts.map(x => x[0]))];
  const maps = new Map(await Promise.all(books.map(async bb => [bb, await data.xref(bb).catch(() => ({}))])));
  const seen = new Set([`${G.b}.${G.c}.${G.v}`, ...G.list.map(x => `${x[0]}.${x[1]}.${x[2]}`)]);
  const out = [];
  firsts.forEach((x, pi) => {
    const l2 = (maps.get(x[0]) || {})[`${x[1]}:${x[2]}`] || [];
    let k = 0;
    for (const y of l2) {
      if (k >= 4) break;
      const id = `${y[0]}.${y[1]}.${y[2]}`;
      if (seen.has(id)) continue;
      seen.add(id); out.push({ ref: y, parent: pi }); k++;
    }
  });
  return (G.hop2 = out);
}
async function toggleHop(G, btn) {
  graphHop = !graphHop;
  btn.setAttribute('aria-pressed', String(graphHop));
  if (P.graph !== G || !G.cv) return;
  const t = P.token;
  if (graphHop) {
    btn.setAttribute('aria-busy', 'true');
    await loadHop(G);
    btn.removeAttribute('aria-busy');
    if (t !== P.token || P.graph !== G) return;
  }
  G.animFirst = false; G.anim2 = graphHop && !RM.matches;
  if (G.anim2) graphAnimate(G); else graphStatic(G);
}
function graphLabel(ctx, n) {
  const text = shortRef(n.ref[0], n.ref[1], n.ref[2], n.ref[3]), tw = ctx.measureText(text).width;
  const ca = Math.cos(n.a), sa = Math.sin(n.a);
  let x, y, align;
  if (Math.abs(ca) < 0.3) { align = 'center'; x = n.x; y = sa < 0 ? n.y - n.r - 7 : n.y + n.r + 14; }
  else if (ca > 0) { align = 'left'; x = n.x + n.r + 7; y = n.y + 4; }
  else { align = 'right'; x = n.x - n.r - 7; y = n.y + 4; }
  const x0 = align === 'center' ? x - tw / 2 : align === 'left' ? x : x - tw;
  return { text, x, y, align, box: [x0 - 2, y - 10, x0 + tw + 2, y + 3] };
}
function graphLayout(G) {
  G.L = null;
  const { ctx, w, h } = sizeCanvas(G.cv);
  // too small to draw: say so rather than leave the stage blank (a very short window)
  const st = G.cv.closest('.stage'), small = w < 80 || h < 80;
  if (st && (small || st.querySelector('.stage-empty'))) mapEmpty(st, small ? 'Make the window larger to see the graph.' : '');
  if (small) return null;
  const col = stageColors(P.stage);
  const cx = w / 2, cy = h / 2 + 4, RY = h * 0.40, RX = Math.max(90, Math.min(w / 2 - 120, RY * 2.2));
  const tot = { OT: 0, NT: 0 }, before = [];
  state.books.forEach(B => { before.push(tot[B.test]); tot[B.test] += B.chapters.length; });
  // Canonical angles: OT down the left hemisphere, NT down the right, canonical order top to bottom.
  const ang = (b, c) => {
    const B = bookOf(b), f = (before[b - 1] + c - 0.5) / (tot[B.test] || 1), a = Math.PI * (0.04 + 0.92 * f);
    return B.test === 'OT' ? -Math.PI / 2 - a : -Math.PI / 2 + a;
  };
  const colOf = b => (b <= 39 ? col.ot : col.nt);
  const max = Math.max(1, maxOf(G.list, x => votesOf(x[4])));
  const centre = { hop: 0, x: cx, y: cy, r: 30, a: -Math.PI / 2, ref: [G.b, G.c, G.v, 0, 0] };
  // A node is placed only when its reference resolves to a finite position, so one bad row cannot
  // make the gradients throw and blank the whole graph. n1All keeps the list's indices for hop 2.
  const placed = n => (Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.r) ? n : null);
  const known = x => Array.isArray(x) && !!bookOf(x[0]) && x[1] >= 1;
  const n1All = G.list.map((x, i) => {
    if (!known(x)) return null;
    const t = ratio(x[4], max), k = 1 - 0.52 * Math.pow(t, 0.7), a = ang(x[0], x[1]);
    return placed({ hop: 1, i, ref: x, t, a, x: cx + Math.cos(a) * RX * k, y: cy + Math.sin(a) * RY * k, r: 4 + 10 * Math.sqrt(t), col: colOf(x[0]) });
  });
  const n1 = n1All.filter(Boolean);
  const n2 = (graphHop && G.hop2 ? G.hop2 : []).map((h2, j) => {
    const x = h2.ref, parent = n1All[h2.parent]; if (!parent || !known(x)) return null;
    const t = ratio(x[4], max), a = ang(x[0], x[1]), k = 0.92 + 0.08 * seeded(`${x[0]}.${x[1]}.${x[2]}`);
    return placed({ hop: 2, i: j, ref: x, t, a, parent, x: cx + Math.cos(a) * RX * k, y: cy + Math.sin(a) * RY * k, r: 2.5 + 2 * Math.sqrt(t), col: colOf(x[0]) });
  }).filter(Boolean);
  const src = colOf(G.b);
  for (const n of n1.concat(n2)) {
    const s = n.hop === 1 ? centre : n.parent;
    n.sx = s.x; n.sy = s.y;
    n.mx = (s.x + n.x) / 2 + (n.y - s.y) * 0.18; n.my = (s.y + n.y) / 2 - (n.x - s.x) * 0.18;
    if (n.hop === 1) { const g = ctx.createLinearGradient(s.x, s.y, n.x, n.y); g.addColorStop(0, src); g.addColorStop(1, n.col); n.grad = g; }
  }
  // The user's links of the centre verse (links-spec §3.6): a node of their own in the link colour, or a ring on the
  // OpenBible node of the same verse; an edge in the link colour curving the other way so it never hides the
  // OpenBible one, dashed for a two-way link and arrowed at its `to` end for a one-way one.
  const at = new Map(n1.map(n => [`${n.ref[0]}.${n.ref[1]}.${n.ref[2]}`, n])), nu = [], ue = [];
  // room around a spot: the gap to the centre's glow and to the nearest node already placed
  const room = (x, y, r) => n1.concat(nu).reduce((m, q) => Math.min(m, Math.hypot(q.x - x, q.y - y) - q.r - r), Math.hypot(x - cx, y - cy) - 40 - r);
  G.mine.forEach((m, j) => {
    const o = m.o, key = `${o.b}.${o.c}.${o.v}`, ecol = lkColour(m.l.color);
    let node = at.get(key);
    if (!node) {
      if (!known([o.b, o.c])) return;
      const a = ang(o.b, o.c), r = 6, k0 = 0.58 + 0.14 * seeded(key);
      let spot = null;
      for (const off of [0, 0.15, -0.15, 0.3, -0.3]) { // step out and in along the ray until it is clear, else the roomiest
        const k = clamp(k0 + off, 0.3, 0.96), x = cx + Math.cos(a) * RX * k, y = cy + Math.sin(a) * RY * k, gap = room(x, y, r);
        if (!spot || gap > spot.gap) spot = { x, y, gap };
        if (gap >= 4) break;
      }
      node = placed({ hop: 1, user: true, i: j, ref: [o.b, o.c, o.v, o.ve > o.v ? o.ve : 0, 0], t: 0.4, a, x: spot.x, y: spot.y, r, col: ecol });
      if (!node) return;
      nu.push(node); at.set(key, node);
    } else if (!node.user && !node.ring) node.ring = ecol;
    const mx = (cx + node.x) / 2 - (node.y - cy) * 0.22, my = (cy + node.y) / 2 + (node.x - cx) * 0.22;
    const arrow = m.l.dir === 'to' ? (o.side === 'to' ? 'node' : 'centre') : '';
    const ph = lkSafe(() => lk.phrase(m.l, o.side === 'to' ? 'from' : 'to'), ''); // as read from the centre verse
    ue.push({ m, node, col: ecol, dash: m.l.dir === 'both', arrow, ph, sx: cx, sy: cy, mx, my, x: node.x, y: node.y, pts: quadPts(cx, cy, mx, my, node.x, node.y) });
  });
  // Draw-in timings (ms): edges start at d, nodes pop 180ms later; 700ms each.
  const OFF = -1e6;
  centre.d = G.animFirst ? 0 : OFF;
  n1.forEach(n => { n.d = G.animFirst ? 120 + 35 * n.i : OFF; });
  const base2 = G.animFirst ? 120 + 35 * n1.length + 160 : 60;
  n2.forEach(n => { n.d = G.anim2 ? base2 + 25 * n.i : OFF; });
  ue.forEach((e, j) => { e.d = G.animFirst ? 200 + 35 * n1.length + 60 * j : OFF; if (e.node.user && e.node.d === undefined) e.node.d = e.d; });
  const dur = Math.max(700, ...n1.concat(n2, nu).map(n => n.d + 880));
  // Labels: top 16 by votes, collision-checked (bounding boxes plus the 12px / 60px rule), kept inside the canvas.
  ctx.font = `500 11px ${SANS()}`;
  const boxes = [[cx - 36, cy - 36, cx + 36, cy + 36], ...nu.map(n => [n.x - n.r - 2, n.y - n.r - 2, n.x + n.r + 2, n.y + n.r + 2])], anchors = []; // never over the user's nodes
  for (const n of nu.concat(n1.slice(0, 16))) { // the user's own nodes are labelled first
    const lb = graphLabel(ctx, n), [x0, y0, x1, y1] = lb.box;
    if (x0 < 4 || x1 > w - 4 || y0 < 4 || y1 > h - 4) continue;
    if (boxes.some(q => x0 < q[2] && x1 > q[0] && y0 < q[3] && y1 > q[1])) continue;
    if (anchors.some(q => Math.abs(q[1] - lb.y) < 12 && Math.abs(q[0] - lb.x) < 60)) continue;
    boxes.push(lb.box); anchors.push([lb.x, lb.y]); n.label = lb;
  }
  G.L = { ctx, w, h, cx, cy, RX, RY, col, ang, centre, n1, n2, nu, ue, all: n2.concat(n1.slice().reverse(), nu), dur, src };
  return G.L;
}
function drawDisc(ctx, n, s, col, alpha) {
  const r = Math.max(0.5, n.r * s);
  ctx.globalAlpha = alpha;
  ctx.beginPath(); ctx.arc(n.x, n.y, r + 1, 0, TAU); ctx.strokeStyle = col.surface; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, TAU); ctx.fillStyle = n.col; ctx.fill();
  ctx.globalAlpha = 1;
}
function drawCentre(G, s, glow = true) {
  const L = G.L, { ctx, cx, cy, col } = L, r = 30 * s, F = SANS();
  if (glow) {
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, r * 2.4);
    g.addColorStop(0, withAlpha(col.ink, 0.14)); g.addColorStop(1, withAlpha(col.ink, 0));
    ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 2.4, 0, TAU); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  ctx.beginPath(); ctx.arc(cx, cy, r + 1.5, 0, TAU); ctx.strokeStyle = col.surface; ctx.lineWidth = 3; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fillStyle = col.ink; ctx.fill(); // neutral ink, never the accent
  const a = clamp((s - 0.6) / 0.4, 0, 1); if (a <= 0) return;
  const text = shortRef(G.b, G.c, G.v);
  ctx.font = `600 13px ${F}`;
  const tw = ctx.measureText(text).width;
  if (tw > 50) ctx.font = `600 ${Math.max(9.5, 13 * 50 / tw).toFixed(1)}px ${F}`;
  ctx.globalAlpha = a; ctx.fillStyle = col.surface; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy + 0.5);
  ctx.globalAlpha = 1; ctx.textBaseline = 'alphabetic';
}
function drawLabel(ctx, lb, col, fill, font, alpha = 1) {
  ctx.font = font; ctx.textAlign = lb.align; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = withAlpha(col.surface, 0.85); ctx.lineWidth = 3; ctx.strokeText(lb.text, lb.x, lb.y);
  ctx.fillStyle = fill; ctx.fillText(lb.text, lb.x, lb.y);
  ctx.globalAlpha = 1;
}
/** Paints the graph at `el` ms into the draw-in (Infinity = final frame). Returns true while anything is still moving. */
function graphPaint(G, el = Infinity) {
  const L = G.L, { ctx, w, h, cx, cy, RX, RY, col } = L, F = SANS();
  resetCtx(ctx); ctx.clearRect(0, 0, w, h);
  let pending = false;
  const prog = (d, len) => {
    if (el === Infinity) return 1;
    const x = (el - d) / len;
    if (x < 1) pending = true;
    return clamp(x, 0, 1);
  };
  // Canon ring: one arc per book, 1px apart (round caps), current book emphasised.
  ctx.lineCap = 'round';
  const rx = RX + 18, ry = RY + 18;
  for (const B of state.books) {
    let a0 = L.ang(B.n, 0.5), a1 = L.ang(B.n, B.chapters.length + 0.5);
    if (a1 < a0) [a0, a1] = [a1, a0];
    const cur = B.n === G.b, lw = cur ? 4.5 : 3, mid = (a0 + a1) / 2;
    const speed = Math.hypot(rx * Math.sin(mid), ry * Math.cos(mid)) || 1, gap = (lw / 2 + 0.5) / speed;
    let s0 = a0 + gap, s1 = a1 - gap;
    if (s1 <= s0) { s0 = mid; s1 = mid; }
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, s0, s1 + 1e-4);
    ctx.strokeStyle = B.test === 'OT' ? col.ot : col.nt; ctx.globalAlpha = cur ? 1 : 0.42; ctx.lineWidth = lw; ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.lineCap = 'butt';
  // Vote rings.
  ctx.setLineDash([2, 5]); ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
  for (const f of [0.45, 0.72, 1]) { ctx.beginPath(); ctx.ellipse(cx, cy, RX * f, RY * f, 0, 0, TAU); ctx.stroke(); }
  ctx.setLineDash([]);
  // Hemisphere labels (skipped when the stage is too narrow for them).
  ctx.font = `600 10px ${F}`; ctx.fillStyle = col.label3; ctx.textBaseline = 'alphabetic'; setSpacing(ctx, '0.6px');
  const lx = cx - RX - 32, rxx = cx + RX + 32;
  ctx.textAlign = 'right'; if (lx - ctx.measureText('OLD TESTAMENT').width >= 8) ctx.fillText('OLD TESTAMENT', lx, cy + 4);
  ctx.textAlign = 'left'; if (rxx + ctx.measureText('NEW TESTAMENT').width <= w - 8) ctx.fillText('NEW TESTAMENT', rxx, cy + 4);
  setSpacing(ctx, '0px');
  // Edges (additive glow).
  ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
  for (const n of L.n2) {
    const p = prog(n.d, 700); if (p <= 0) continue;
    ctx.globalAlpha = 0.25; ctx.strokeStyle = n.col; ctx.lineWidth = 0.5;
    ctx.beginPath(); quadPart(ctx, n.sx, n.sy, n.mx, n.my, n.x, n.y, easeOutCubic(p)); ctx.stroke();
  }
  for (const n of L.n1) {
    const p = prog(n.d, 700); if (p <= 0) continue;
    ctx.globalAlpha = 0.2 + 0.6 * n.t; ctx.strokeStyle = n.grad; ctx.lineWidth = 0.8 + 2 * n.t;
    ctx.beginPath(); quadPart(ctx, n.sx, n.sy, n.mx, n.my, n.x, n.y, easeOutCubic(p)); ctx.stroke();
  }
  // The user's edges, without the additive glow so the link colour stays true.
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  for (const e of L.ue) { e._p = prog(e.d, 700); if (e._p > 0) lkEdge(ctx, e, easeOutCubic(e._p), 2); }
  ctx.globalCompositeOperation = 'lighter';
  // Node halos (additive), then solid nodes with a stage-surface ring.
  for (const n of L.all) {
    n._p = prog(n.d + 180, 700);
    n._s = n._p <= 0 ? 0 : Math.max(0, easeOutBack(n._p));
    if (n._s <= 0) continue;
    const R = 2.6 * n.r * n._s, g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, R);
    g.addColorStop(0, withAlpha(n.col, 1)); g.addColorStop(1, withAlpha(n.col, 0));
    ctx.globalAlpha = n.hop === 2 ? 0.35 * 0.6 : 0.35; ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(n.x, n.y, R, 0, TAU); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  for (const n of L.all) if (n._s > 0) drawDisc(ctx, n, n._s, col, n.hop === 2 ? 0.6 : 1);
  for (const n of L.n1) if (n.ring && n._s > 0) { ctx.beginPath(); ctx.arc(n.x, n.y, n.r * n._s + 3, 0, TAU); ctx.strokeStyle = n.ring; ctx.lineWidth = 1.5; ctx.stroke(); }
  // Centre.
  const pc = prog(L.centre.d, 600);
  if (pc > 0) drawCentre(G, Math.max(0.01, easeOutBack(pc)));
  for (const e of L.ue) if (e.arrow && e._p >= 1) lkArrow(ctx, e);
  // Labels.
  const font = `500 11px ${F}`;
  for (const n of L.n1) if (n.label && n._p > 0) drawLabel(ctx, n.label, col, col.label2, font, clamp(n._p * 1.4, 0, 1));
  for (const n of L.nu) if (n.label && n._p > 0) drawLabel(ctx, n.label, col, col.label, font, clamp(n._p * 1.4, 0, 1));
  resetCtx(ctx);
  return pending;
}
/** The first p (0…1) of a user edge: dashed for a two-way link. */
function lkEdge(ctx, e, p, lw) {
  ctx.setLineDash(e.dash ? [6, 5] : []); ctx.lineCap = 'round';
  ctx.strokeStyle = e.col; ctx.lineWidth = lw;
  ctx.beginPath(); quadPart(ctx, e.sx, e.sy, e.mx, e.my, e.x, e.y, p); ctx.stroke();
  ctx.setLineDash([]);
}
/** The arrowhead of a one-way user edge, at the rim of its `to` end (the node, or the centre for a link into it). */
function lkArrow(ctx, e) {
  const toNode = e.arrow === 'node', tx = toNode ? e.x : e.sx, ty = toNode ? e.y : e.sy;
  let dx = tx - e.mx, dy = ty - e.my; const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len; // the tangent at that end
  const gap = (toNode ? e.node.r : 30) + 3, px = tx - dx * gap, py = ty - dy * gap, s = 8, w = 4.5;
  ctx.beginPath(); ctx.moveTo(px, py);
  ctx.lineTo(px - dx * s - dy * w, py - dy * s + dx * w); ctx.lineTo(px - dx * s + dy * w, py - dy * s - dx * w); ctx.closePath();
  ctx.globalAlpha = 1; ctx.fillStyle = e.col; ctx.fill();
}
function graphStatic(G) {
  if (P.graph !== G || !G.cv) return;
  if (P.raf) { cancelAnimationFrame(P.raf); P.raf = 0; }
  G.animating = false; G.dirty = false; G.hover = null;
  if (!graphLayout(G)) { G.snap = null; return; }
  graphPaint(G); G.snap = snapshot(G.cv);
}
function graphAnimate(G) {
  if (P.raf) cancelAnimationFrame(P.raf);
  G.animating = true; G.snap = null; G.dirty = true; G.hover = null;
  let t0 = 0;
  const frame = now => {
    P.raf = 0;
    if (P.graph !== G) return;
    if (!t0) t0 = now;
    if (G.dirty) { G.dirty = false; graphLayout(G); }
    if (!G.L) { G.animating = false; return; }
    const el = now - t0;
    if (graphPaint(G, el) && el < G.L.dur + 300) { P.raf = requestAnimationFrame(frame); return; }
    G.animating = false; graphPaint(G); G.snap = snapshot(G.cv);
    if (G.hover) graphHover(G);
  };
  P.raf = requestAnimationFrame(frame);
}
function graphHover(G) {
  const L = G.L; if (!L || !G.snap) return;
  restoreSnap(L.ctx, G.snap);
  const n = G.hover; if (!n) return;
  const { ctx, col } = L;
  resetCtx(ctx);
  if (n.hop === 0) {
    ctx.beginPath(); ctx.arc(L.cx, L.cy, 35, 0, TAU);
    ctx.strokeStyle = col.label; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5; ctx.stroke(); ctx.globalAlpha = 1;
    return;
  }
  const ues = L.ue.filter(e => e.node === n);
  ctx.lineCap = 'round';
  if (!n.user) { // a user-only node has no OpenBible edge
    ctx.strokeStyle = n.col; ctx.lineWidth = n.hop === 1 ? 1.5 + 2 * n.t : 1.2;
    ctx.beginPath(); quadPart(ctx, n.sx, n.sy, n.mx, n.my, n.x, n.y, 1); ctx.stroke();
  }
  for (const e of ues) lkEdge(ctx, e, 1, 3);
  if (n.hop === 1) drawCentre(G, 1, false); else if (n.parent) drawDisc(ctx, n.parent, 1, col, 1);
  drawDisc(ctx, n, 1, col, 1);
  for (const e of ues) if (e.arrow) lkArrow(ctx, e);
  ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 4.5, 0, TAU);
  ctx.strokeStyle = col.label; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.9; ctx.stroke(); ctx.globalAlpha = 1;
  const font = `600 11px ${SANS()}`;
  ctx.font = font;
  drawLabel(ctx, n.label || graphLabel(ctx, n), col, col.label, font);
  // the edge label: the short phrase as read from the centre verse, at the middle of the curve
  ues.forEach((e, i) => { if (e.ph) drawLabel(ctx, { text: e.ph, align: 'center', x: 0.25 * e.sx + 0.5 * e.mx + 0.25 * e.x, y: 0.25 * e.sy + 0.5 * e.my + 0.25 * e.y + 4 + 14 * i }, col, col.label, font); });
  resetCtx(ctx);
}
function graphHit(G, mx, my) {
  const L = G.L; if (!L) return null;
  if (Math.hypot(mx - L.cx, my - L.cy) <= 32) return L.centre;
  let best = null, bd = Infinity;
  for (const n of L.all) {
    const d = Math.hypot(n.x - mx, n.y - my);
    if (d <= Math.max(10, n.r + 5) && d < bd) { bd = d; best = n; }
  }
  if (!best) for (const e of L.ue) if (polyDist(e.pts, mx, my) <= 6) return e.node; // a user edge stands for its node
  return best;
}
function graphTip(e, G, n) {
  if (n.hop === 0) {
    const shown = G.mode === 'mine' ? lkOf(G.mine.length) : `${plural(G.list.length, 'link')} shown${G.mine.length ? ` · ${lkOf(G.mine.length)}` : ''}`;
    tipKeyed(e, `g0:${G.b}.${G.c}.${G.v}`, `<div class="tt">${esc(refLabel(G.b, G.c, G.v))}</div><div class="tm"><i class="${testOf(G.b)}"></i>${testName(G.b)} · ${shown}</div>`, [G.b, G.c, G.v, 0]);
    return;
  }
  const x = n.ref, pr = n.parent && n.parent.ref;
  const via = n.hop === 2 && pr ? ` · via ${esc(shortRef(pr[0], pr[1], pr[2], pr[3]))}` : '';
  // the user's links to this verse, one line each: "John 1:29 fulfils Isaiah 53:7 · label"
  const yours = (G.L ? G.L.ue.filter(q => q.node === n) : []).map(q => `<div class="tm">${lkDot(q.m.l)}${esc(lkSafe(() => lkSentence(q.m.l), 'Your link'))}</div>`).join('');
  const ob = n.user ? '' : `<div class="tm"><i class="${testOf(x[0])}"></i>${testName(x[0])} · ${plural(votesOf(x[4]), 'vote')}${via}</div>`;
  tipKeyed(e, `g${n.hop}${n.user ? 'u' : ''}:${x[0]}.${x[1]}.${x[2]}`, `<div class="tt">${esc(refLabel(x[0], x[1], x[2], x[3]))}</div>${ob}${yours}`, [x[0], x[1], x[2], x[3]]);
}
function bindGraph(G) {
  const cv = G.cv;
  cv.onpointermove = e => {
    if (P.graph !== G || !G.L || e.pointerType === 'touch') return;
    const { mx, my } = stageRef(e), n = graphHit(G, mx, my);
    if (n !== G.hover) { G.hover = n; if (!G.animating) graphHover(G); }
    cv.style.cursor = n ? 'pointer' : '';
    if (n) graphTip(e, G, n); else tip.hide();
  };
  cv.onpointerleave = () => {
    if (P.graph === G && G.hover) { G.hover = null; if (!G.animating) graphHover(G); }
    cv.style.cursor = ''; tip.hide();
  };
  cv.onclick = e => {
    if (P.graph !== G || !G.L || !A) return;
    const { mx, my } = stageRef(e), n = graphHit(G, mx, my);
    if (!n) return;
    tip.hide();
    if (n.hop === 0) A.select(G.v);
    else if (n.user) A.select(G.v, { tab: 'mine' }); // the centre verse's links, in the Mine tab
    else if (n.hop === 1) A.select(G.v, { tab: 'xref', expand: `${n.ref[0]}.${n.ref[1]}.${n.ref[2]}` });
    else { A.navigate(n.ref[0], n.ref[1], n.ref[2]); A.toggleDrawer?.(true); } // a picked node opens the study panel on its verse
  };
}

/* =====================================================================
   Places data (internal). The MapLibre loader and map controller live in maps.js.
   ===================================================================== */
/**
 * Places named in the current chapter that have coordinates, with the verses naming them.
 * Entries with the same name at the same spot (the gazetteer has a few, e.g. two "Judea") are
 * merged into one pin; `ids` keeps every original id so miniMap.focus(id) matches either.
 */
async function chapterPlaces() {
  const b = state.book, c = state.chapter;
  const [ctx0, places] = await Promise.all([data.context(b).catch(() => ({})), data.places()]);
  const ch = ctx0[String(c)] || { v: {} }, m = new Map();
  Object.entries(ch.v || {}).forEach(([vv, x]) => (x.pl || []).forEach(i => {
    const pl = places[i];
    if (!pl || pl.lat === null || pl.lat === undefined || pl.lon === null || pl.lon === undefined) return;
    const lat = +pl.lat, lon = +pl.lon;
    if (!isFinite(lat) || !isFinite(lon)) return;
    const key = `${pl.n}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
    let p = m.get(key);
    if (!p) m.set(key, (p = { id: i, ...pl, lat, lon, ids: [], verses: [] }));
    else if ((+pl.vc || 0) > (+p.vc || 0)) Object.assign(p, { ...pl, id: i, lat, lon, ids: p.ids, verses: p.verses });
    if (!p.ids.includes(i)) p.ids.push(i);
    p.verses.push(+vv);
  }));
  return [...m.values()].map(p => ({ ...p, verses: [...new Set(p.verses)].sort((x, z) => x - z) }));
}
/** Flash a place's verses. From the stage map (in the page flow above the chapter) the reader is not
    scrolled, or the map and its new popup would leave the screen; the popup's verse numbers scroll instead. */
const flashPlace = (p, scroll = true) => { if (A && p && p.verses && p.verses.length) A.flash(p.verses, { scroll }); };
const showVerse = v => { if (A && v > 0) A.flash([v]); };

/* =====================================================================
   Stylised Levant map (SVG) — offline / no-WebGL fallback for both maps — §9.9
   ===================================================================== */
const LEVANT = {
  coast: [[34.2, 35.62], [33.9, 35.47], [33.56, 35.37], [33.27, 35.2], [33.09, 35.1], [32.93, 35.07], [32.83, 34.96], [32.61, 34.92], [32.5, 34.89], [32.2, 34.81], [32.05, 34.75], [31.8, 34.63], [31.67, 34.55], [31.52, 34.44], [31.3, 34.24], [31.15, 33.8], [31.08, 33.3], [31.05, 32.6]],
  galilee: [[32.9, 35.6], [32.88, 35.64], [32.82, 35.65], [32.75, 35.64], [32.7, 35.59], [32.72, 35.55], [32.79, 35.52], [32.86, 35.54]],
  dead: [[31.77, 35.52], [31.76, 35.58], [31.66, 35.57], [31.53, 35.51], [31.42, 35.51], [31.3, 35.5], [31.18, 35.47], [31.08, 35.43], [31.05, 35.39], [31.13, 35.38], [31.3, 35.4], [31.45, 35.43], [31.6, 35.46], [31.72, 35.47]],
  jordanN: [[33.26, 35.63], [33.12, 35.61], [33.02, 35.63], [32.91, 35.61]],
  jordanS: [[32.71, 35.57], [32.62, 35.58], [32.52, 35.56], [32.4, 35.555], [32.3, 35.565], [32.18, 35.53], [32.05, 35.525], [31.93, 35.535], [31.84, 35.545], [31.77, 35.55]],
  regions: [['GALILEE', 32.86, 35.3], ['SAMARIA', 32.24, 35.19], ['JUDEA', 31.5, 34.98], ['PEREA', 32.0, 35.78], ['DECAPOLIS', 32.62, 35.9]],
  context: [['Jerusalem', 31.778, 35.235], ['Nazareth', 32.7, 35.3], ['Capernaum', 32.88, 35.575]],
};
const f1 = n => n.toFixed(1);
function smoothPath(pts, closed) {
  if (pts.length < 3) return 'M' + pts.map(p => p.map(f1).join(' ')).join('L');
  const Q = closed ? [pts[pts.length - 1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[pts.length - 1]];
  let d = `M${f1(Q[1][0])} ${f1(Q[1][1])}`;
  for (let i = 1; i < Q.length - 2; i++) {
    const [p0, p1, p2, p3] = [Q[i - 1], Q[i], Q[i + 1], Q[i + 2]];
    d += `C${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  return d + (closed ? 'Z' : '');
}
/**
 * Markers and labels carry data-ax/data-ay (their anchor point), so a viewBox zoom can
 * counter-scale them and keep text and pins at their on-screen size; strokes do not scale.
 * Labels are placed by priority without overlaps: pin labels (right, left, above, below, then
 * diagonals), then context towns, water and region names only where there is room. A pin label that
 * cannot fit is emitted hidden (data-hidden) and shown when miniMap.focus() selects it.
 */
function mapSVG(pts, W, H) {
  if (!pts.length || !(W > 60 && H > 60)) return '';
  const lev = pts.every(p => p.lat > 29.5 && p.lat < 34.6 && p.lon > 33.5 && p.lon < 37);
  let la0 = Math.min(...pts.map(p => p.lat)), la1 = Math.max(...pts.map(p => p.lat));
  let lo0 = Math.min(...pts.map(p => p.lon)), lo1 = Math.max(...pts.map(p => p.lon));
  const padLa = Math.max(0.35, (la1 - la0) * 0.22), padLo = Math.max(0.35, (lo1 - lo0) * 0.22);
  la0 -= padLa; la1 += padLa; lo0 -= padLo; lo1 += padLo;
  const kx = Math.cos(((la0 + la1) / 2) * Math.PI / 180);
  const scale = Math.min(W / ((lo1 - lo0) * kx), H / (la1 - la0));
  if (!(scale > 0 && isFinite(scale))) return '';
  const cLo = (lo0 + lo1) / 2 - (lev ? 0.25 : 0), cLa = (la0 + la1) / 2;
  const PJ = (lat, lon) => [W / 2 + (lon - cLo) * kx * scale, H / 2 - (lat - cLa) * scale];
  const VE = ' vector-effect="non-scaling-stroke"';
  const anchor = (x, y) => ` data-ax="${f1(x)}" data-ay="${f1(y)}"`;
  const boxes = [];
  const free = b => b[0] >= 2 && b[2] <= W - 2 && b[1] >= 2 && b[3] <= H - 2 && !boxes.some(q => b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1]);
  let base = '', labels = '';
  // Graticule: every 0.5° when there is room, coarser for wide views.
  const step = [0.5, 1, 2, 5, 10].find(d => d * scale >= 36) || 10;
  const g0 = Math.floor((cLa - H / 2 / scale) / step) * step, g1 = cLa + H / 2 / scale;
  const h0 = Math.floor((cLo - W / 2 / scale / kx) / step) * step, h1 = cLo + W / 2 / scale / kx;
  for (let la = g0, i = 0; la <= g1 && i < 80; la += step, i++) base += `<path class="grat" d="M0 ${f1(PJ(la, cLo)[1])}H${W}"${VE}/>`;
  for (let lo = h0, i = 0; lo <= h1 && i < 80; lo += step, i++) base += `<path class="grat" d="M${f1(PJ(cLa, lo)[0])} 0V${H}"${VE}/>`;
  // Pins, most-mentioned first, each with the first free label position.
  const proj = pts.map(p => { const [x, y] = PJ(p.lat, p.lon); return { p, x, y }; })
    .sort((a, z) => (z.p.verses || []).length - (a.p.verses || []).length || (+z.p.vc || 0) - (+a.p.vc || 0));
  proj.forEach(q => boxes.push([q.x - 6, q.y - 6, q.x + 6, q.y + 6]));
  proj.forEach(q => {
    const w = String(q.p.n).length * 6.4 + 2, { x, y } = q;
    const cands = [
      { x: x + 9, y: y + 4, a: 'start', b: [x + 8, y - 6, x + 9 + w, y + 6] },
      { x: x - 9, y: y + 4, a: 'end', b: [x - 9 - w, y - 6, x - 8, y + 6] },
      { x, y: y - 10, a: 'middle', b: [x - w / 2, y - 20, x + w / 2, y - 7] },
      { x, y: y + 18, a: 'middle', b: [x - w / 2, y + 7, x + w / 2, y + 20] },
      { x: x + 5, y: y - 9, a: 'start', b: [x + 4, y - 19, x + 5 + w, y - 6] },
      { x: x - 5, y: y - 9, a: 'end', b: [x - 5 - w, y - 19, x - 4, y - 6] },
      { x: x + 5, y: y + 17, a: 'start', b: [x + 4, y + 6, x + 5 + w, y + 19] },
      { x: x - 5, y: y + 17, a: 'end', b: [x - 5 - w, y + 6, x - 4, y + 19] },
    ];
    const c = cands.find(k => free(k.b));
    if (c) { boxes.push(c.b); q.label = c; } else { q.label = cands.find(k => k.b[0] >= 2 && k.b[2] <= W - 2) || cands[0]; q.hidden = true; }
  });
  if (lev) {
    const coast = LEVANT.coast.map(p => PJ(p[0], p[1]));
    const far = [PJ(30, 30), PJ(36, 30), PJ(36, 35.7)];
    base += `<path class="sea" d="${smoothPath(coast, false)}L${far.map(p => p.map(f1).join(' ')).join('L')}Z"/>`;
    base += `<path class="coast" d="${smoothPath(coast, false)}"${VE}/>`;
    base += `<path class="sea lake" d="${smoothPath(LEVANT.galilee.map(p => PJ(p[0], p[1])), true)}"${VE}/>`;
    base += `<path class="sea lake" d="${smoothPath(LEVANT.dead.map(p => PJ(p[0], p[1])), true)}"${VE}/>`;
    base += `<path class="river" d="${smoothPath(LEVANT.jordanN.map(p => PJ(p[0], p[1])), false)}"${VE}/>`;
    base += `<path class="river" d="${smoothPath(LEVANT.jordanS.map(p => PJ(p[0], p[1])), false)}"${VE}/>`;
    const names = new Set(pts.map(p => p.n));
    LEVANT.context.forEach(([n, la, lo]) => {
      if (names.has(n)) return;
      const [x, y] = PJ(la, lo), w = n.length * 5.6;
      const dot = [x - 3, y - 3, x + 3, y + 3], lb = [x - 6 - w, y - 5, x - 4, y + 5];
      if (!free(dot) || !free(lb)) return;
      boxes.push(dot, lb);
      labels += `<circle class="ctx-pt" cx="${f1(x)}" cy="${f1(y)}" r="2"${anchor(x, y)}/><text class="ctx-l" x="${f1(x - 5)}" y="${f1(y + 3.5)}" text-anchor="end"${anchor(x, y)}>${esc(n)}</text>`;
    });
    const water = [['Mediterranean', 32.3, 34.3, 'middle'], ['Dead Sea', 31.45, 35.62, 'start']];
    water.forEach(([n, la, lo, a]) => {
      const [x, y] = PJ(la, lo), w = n.length * 5.9, x0 = a === 'middle' ? x - w / 2 : x, b = [x0, y - 9, x0 + w, y + 3];
      if (!free(b)) return;
      boxes.push(b);
      labels += `<text class="water-l" x="${f1(x)}" y="${f1(y)}"${a === 'middle' ? ' text-anchor="middle"' : ''}${anchor(x, y)}>${n}</text>`;
    });
    const upper = new Set(pts.map(p => String(p.n).toUpperCase()));
    LEVANT.regions.forEach(([n, la, lo]) => {
      if (upper.has(n)) return;
      const [x, y] = PJ(la, lo), w = n.length * 7.9, b = [x - w / 2, y - 8, x + w / 2, y + 2];
      if (!free(b)) return;
      boxes.push(b);
      labels += `<text class="region" x="${f1(x)}" y="${f1(y)}" text-anchor="middle"${anchor(x, y)}>${n}</text>`;
    });
  }
  let pins = '';
  proj.forEach(({ p, x, y, label: l, hidden }) => {
    const id = esc(String(p.id)), vs = p.verses || [];
    // Each pin is a button, as on the live map (maps.js): named with its verses, opened with Enter or Space.
    const name = `${p.n}${vs.length ? `, ${vs.length === 1 ? 'verse' : 'verses'} ${vs.join(', ')}` : ''}`;
    pins += `<circle class="pt" data-id="${id}" cx="${f1(x)}" cy="${f1(y)}" r="4.5" role="button" tabindex="0" aria-label="${esc(name)}"${anchor(x, y)}/>`
      + `<text class="pt-l" data-id="${id}" x="${f1(l.x)}" y="${f1(l.y)}" text-anchor="${l.a}" aria-hidden="true"${hidden ? ' data-hidden="1" visibility="hidden"' : ''}${anchor(x, y)}>${esc(p.n)}</text>`;
  });
  // A group, not an image: an image's children are presentational, which would hide the pin buttons.
  return `<svg class="lev" viewBox="0 0 ${W} ${H}" role="group" aria-label="Map of ${esc(pts.map(p => p.n).join(', '))}"><g aria-hidden="true">${base}${labels}</g>${pins}</svg>`;
}
/** Click a pin: flash its verses. Hover: name, kind and verses (covers labels hidden for lack of room). */
function bindLev(el, pts) {
  const find = d => pts.find(p => String(p.id) === d.dataset.id);
  el.onclick = e => { const d = e.target.closest && e.target.closest('[data-id]'); if (d) flashPlace(find(d)); };
  el.onkeydown = e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const d = e.target.closest && e.target.closest('.pt[data-id]'); if (!d) return;
    e.preventDefault(); // Space would scroll the page
    flashPlace(find(d));
  };
  el.onpointermove = e => {
    const d = e.target.closest && e.target.closest('.pt[data-id]'), p = d && find(d);
    if (!p) { if (tip.key && String(tip.key).startsWith('pl:')) tip.hide(); return; }
    const vs = p.verses || [];
    tipKeyed(e, 'pl:' + p.id, `<div class="tt">${esc(p.n)}</div><div class="tm">${p.ft ? esc(p.ft) + ' · ' : ''}${vs.length === 1 ? 'Verse' : 'Verses'} ${vs.join(', ')}</div>`);
  };
  el.onpointerleave = () => { if (tip.key && String(tip.key).startsWith('pl:')) tip.hide(); };
}
function applyViewBox(svg, vb, W) {
  svg.setAttribute('viewBox', vb.map(n => n.toFixed(2)).join(' '));
  const k = vb[2] / W; // < 1 when zoomed in
  svg.querySelectorAll('[data-ax]').forEach(n => {
    if (k > 0.999) { n.removeAttribute('transform'); return; }
    const ax = +n.dataset.ax, ay = +n.dataset.ay;
    n.setAttribute('transform', `translate(${ax} ${ay}) scale(${k.toFixed(4)}) translate(${-ax} ${-ay})`);
  });
}

/** SVG fallback focus: highlight the point and animate the viewBox to a 2.2x zoom on it (null = whole box). */
function svgFocus(M, placeId) {
  const el = M.el, svg = el && el.querySelector('svg.lev'); if (!svg || !M.vb) return;
  const want = placeId === null || placeId === undefined ? null : String(placeId);
  const place = want === null ? null : M.pts.find(p => String(p.id) === want || (p.ids || []).some(i => String(i) === want));
  const key = place ? String(place.id) : null;
  let hit = null;
  svg.querySelectorAll('.pt, .pt-l').forEach(n => {
    const on = key !== null && n.dataset.id === key;
    n.classList.toggle('hi', on);
    if (n.classList.contains('pt')) { n.setAttribute('r', on ? '5.5' : '4.5'); if (on) hit = n; }
    else if (n.dataset.hidden) { if (on) n.removeAttribute('visibility'); else n.setAttribute('visibility', 'hidden'); }
  });
  let to = [0, 0, M.W, M.H];
  if (hit) {
    svg.querySelectorAll('.pt.hi, .pt-l.hi').forEach(n => svg.appendChild(n)); // raise above neighbours
    const px = +hit.getAttribute('cx'), py = +hit.getAttribute('cy'), vw = M.W / 2.2, vh = M.H / 2.2;
    to = [clamp(px - vw / 2, 0, M.W - vw), clamp(py - vh / 2, 0, M.H - vh), vw, vh];
  }
  if (M.raf) cancelAnimationFrame(M.raf);
  M.raf = 0;
  const from = M.vb.slice();
  if (RM.matches) { M.vb = to; applyViewBox(svg, to, M.W); return; }
  let t0 = 0;
  const step = now => {
    if (!t0) t0 = now;
    const p = easeOutCubic(clamp((now - t0) / 500, 0, 1));
    M.vb = from.map((a, i) => a + (to[i] - a) * p);
    applyViewBox(svg, M.vb, M.W);
    M.raf = p < 1 && svg.isConnected ? requestAnimationFrame(step) : 0;
  };
  M.raf = requestAnimationFrame(step);
}

/* =====================================================================
   Place popups (stage map and mini map): name, kind, verses, then links to the scholarly
   records (Pleiades, the Roman atlas, GeoNames) or a Pleiades search.
   ===================================================================== */
function pinPopup(p) {
  const vs = p.verses || [];
  const links = placeLinks(p).map(([u, t]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}${icon('external')}</a>`).join('');
  const nums = vs.map(v => `<button type="button" class="pop-v" data-v="${+v}" title="Show verse ${+v} in the text">${+v}</button>`).join(', ');
  return `<b>${esc(p.n)}</b>${p.ft ? ' · ' + esc(p.ft) : ''}${vs.length ? `<br><span>${vs.length === 1 ? 'Verse' : 'Verses'} ${nums}</span>` : ''}`
    + (links ? `<div class="pop-links">${links}</div>` : '');
}

/* =====================================================================
   Drawer mini map (#mini-map): a compact MapLibre map, mounted only once visible; the stylised
   Levant SVG is the fallback. One live instance at a time: a re-render of the same chapter moves
   the live map into the new host, anything else removes it before a new one is created.
   ===================================================================== */
export const miniMap = {
  el: null, pts: [], key: '', mode: '', ctrl: null, io: null, tok: 0, pending: undefined, W: 0, H: 0, vb: null, raf: 0,
  async mount(el) {
    const M = miniMap;
    if (!el) return;
    const t = ++M.tok;
    if (M.io) { M.io.disconnect(); M.io = null; }
    if (M.raf) cancelAnimationFrame(M.raf);
    const prevMode = M.mode, prevKey = M.key;
    M.raf = 0; M.el = el; M.vb = null; M.pending = undefined; M.mode = 'loading';
    let pts = [];
    try { pts = await chapterPlaces(); } catch (e) { pts = []; }
    if (t !== M.tok) return;
    const key = `${state.book}.${state.chapter}|${pts.map(p => p.id).join(',')}`;
    if (prevMode === 'gl' && M.ctrl && !M.ctrl.removed && prevKey === key && pts.length) {
      M.pts = pts; M.mode = 'gl';
      M.ctrl.rehost(el);
      const id = M.pending; M.pending = undefined;
      if (id !== undefined) M.ctrl.focus(id);
      else if (M.ctrl.hiKey) M.ctrl.focus(null); // the rows re-rendered collapsed: show every place again
      else M.ctrl.highlight(null);
      return;
    }
    M.unmountMap(); // always release the previous WebGL context before another is created
    M.pts = pts; M.key = key;
    if (!pts.length) { M.mode = 'empty'; el.innerHTML = '<div class="stage-empty">No mapped places in this passage.</div>'; return; }
    const go = () => { if (t === M.tok) M.createGL(el, t); };
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(es => {
        if (!es.some(e => e.isIntersecting)) return;
        io.disconnect(); if (M.io === io) M.io = null;
        go();
      }, { rootMargin: '160px 0px' });
      M.io = io; io.observe(el);
    } else go();
  },
  async createGL(el, t) {
    const M = miniMap;
    const ok = await loadMapLibre();
    if (t !== M.tok || !el.isConnected) return;
    if (!ok) { M.svg(el); return; }
    M.unmountMap();
    const ctrl = createMap(el, { kind: 'mini', pins: M.pts, pinHtml: pinPopup, onPin: flashPlace, onVerse: showVerse, label: `Map of places named in ${refLabel(state.book, state.chapter)}` });
    M.ctrl = ctrl; M.mode = 'gl';
    if (M.pending !== undefined) { const id = M.pending; M.pending = undefined; ctrl.focus(id); }
    const good = await ctrl.ready;
    if (M.ctrl !== ctrl || ctrl.removed) return;
    if (!good) {
      // Draw the fallback into the current host: a same-chapter re-render may have moved this map (rehost).
      // While another mount is on its way (mode 'loading') that mount draws instead.
      const host = M.el, live = M.mode === 'gl';
      M.unmountMap();
      if (live && host && host.isConnected) M.svg(host);
    }
  },
  /** Offline / no-WebGL fallback: the stylised Levant SVG. */
  svg(el) {
    const M = miniMap;
    const W = Math.max(200, Math.round(el.clientWidth || 380)), H = 180;
    el.innerHTML = mapSVG(M.pts, W, H);
    M.W = W; M.H = H; M.vb = [0, 0, W, H]; M.mode = 'svg';
    bindLev(el, M.pts);
    if (M.pending !== undefined) { const id = M.pending; M.pending = undefined; svgFocus(M, id); }
  },
  unmountMap() {
    const M = miniMap;
    if (M.ctrl) { try { M.ctrl.remove(); } catch (e) { /* gone */ } M.ctrl = null; }
    if (M.mode === 'gl') M.mode = '';
  },
  /** Highlight a place and bring it into view; null re-fits every pin. */
  focus(placeId) {
    const M = miniMap;
    if (!M.el || !M.el.isConnected) return;
    if (M.mode === 'gl' && M.ctrl && !M.ctrl.removed) { M.ctrl.focus(placeId); return; }
    if (M.mode === 'svg' && M.vb) { svgFocus(M, placeId); return; }
    M.pending = placeId; // still mounting, or not visible yet
  },
};

/* =====================================================================
   Stage: Map (MapLibre in #bigmap: OpenFreeMap basemap, terrain hillshade, optional 3D,
   Roman world (DARE) layer, Paul's journeys) — §9.7
   ===================================================================== */
let paulOn = false;
const mapPrefs = { layer: 'modern', terrain: false }; // remembered for the session only (not stored)
// The SVG fallback cannot draw the journeys; the toast names the actual cause (P.mapWhy).
const PAUL_MSG = {
  webgl: 'Paul’s journeys need WebGL, which isn’t available in this browser.',
  offline: 'Paul’s journeys need the map tiles, which need an internet connection.',
  load: 'Paul’s journeys need the map tiles, which couldn’t be loaded just now.',
};
/** Why the stage map fell back to the SVG: 'webgl' (none, or it failed to start), 'offline' or 'load'. */
function fallbackWhy(err) {
  if (!webglSupported() || /webgl/i.test(String((err && err.message) || err || ''))) return 'webgl';
  return navigator.onLine === false ? 'offline' : 'load';
}
/** The toast for Paul's journeys on the fallback. Connectivity is re-read, since it may have changed. */
function paulMsg() {
  const why = P.mapWhy === 'webgl' ? 'webgl' : fallbackWhy(null);
  return PAUL_MSG[why] || PAUL_MSG.load;
}
/**
 * A journey field of the GeoJSON ('Acts.13.1,Acts.14.26', 'Acts.17.15-16', 'Acts.13.13, Acts.14.24')
 * as one readable list: 'Acts 13:1; 14:26', 'Acts 15:2, 4; 18:21', 'Acts 17:15–16'. Every reference
 * is kept, with its range end; a part that is not an OSIS reference of a known book (the data has a
 * stray '924') is dropped, and '' means nothing usable.
 */
function osisList(s) {
  let out = '', prev = null;
  for (const part of String(s || '').split(/\s*[,;]\s*/)) {
    const m = part.trim().match(/^([1-3]?[A-Za-z]+)\.(\d+)(?:\.(\d+)(?:-(\d+))?)?$/); if (!m) continue;
    const B = state.books.find(x => x.osis === m[1]); if (!B) continue;
    const c = +m[2], v = m[3] ? +m[3] : 0, e = m[4] && +m[4] > v ? +m[4] : 0, tail = `${v && e ? '–' + e : ''}`;
    if (prev && prev.b === B.n && prev.c === c && v && prev.v) out += `, ${v}${tail}`;
    else if (prev && prev.b === B.n) out += `; ${c}${v ? ':' + v : ''}${tail}`;
    else out += `${out ? '; ' : ''}${refLabel(B.n, c, v, e)}`;
    prev = { b: B.n, c, v };
  }
  return out;
}
let paulPlaces = null; // places.json, read with the journeys (paulName)
/**
 * The stop's name. Two stops are both called 'Antioch'; when the stop's Place ID names a place whose
 * full name extends it ('Antioch (Syria)', 'Antioch (Pisidia)'), that name is used. Some IDs in this
 * data are stray values, which the prefix test leaves alone.
 */
function paulName(p) {
  const name = String(p['Place Name'] || p.name || p.Name || '').trim(), id = String(p['Place ID'] ?? '').trim();
  const full = paulPlaces && /^\d+$/.test(id) && paulPlaces[id] ? String(paulPlaces[id].n || '') : '';
  return name && full.length > name.length && full.toLowerCase().startsWith(name.toLowerCase()) ? full : name;
}
function paulPopup(p = {}) {
  const name = paulName(p); if (!name) return '';
  // A leg whose reference is unusable is still named (Three Taverns is on the voyage to Rome).
  const trips = [['first', 'First journey'], ['second', 'Second journey'], ['third', 'Third journey'], ['rome', 'Voyage to Rome']]
    .filter(([k]) => p[k]).map(([k, l]) => { const refs = osisList(p[k]); return refs ? `${l} · ${esc(refs)}` : l; });
  const note = p.Notes && !/^\d+$/.test(String(p.Notes).trim()) ? `<br>${esc(p.Notes)}` : '';
  return `<b>${esc(name)}</b>${trips.length ? `<br><span>${trips.join('<br>')}</span>` : ''}${note}`;
}
function mapEmpty(stage, msg) {
  const body = stage.querySelector('.stage-body'); if (!body) return;
  let e = body.querySelector('.stage-empty');
  if (!msg) { if (e) e.remove(); return; }
  if (!e) { e = document.createElement('div'); e.className = 'stage-empty'; body.appendChild(e); }
  e.textContent = msg;
}
function freshLeaf(stage) {
  const old = stage.querySelector('#bigmap'); if (!old) return null;
  const el = document.createElement('div'); el.className = 'leaf'; el.id = 'bigmap';
  old.replaceWith(el); return el;
}
function setPaulPressed(stage, on) {
  const btn = stage.querySelector('[data-paul]'); if (btn) btn.setAttribute('aria-pressed', String(on));
  const lg = stage.querySelector('[data-paul-legend]'); if (lg) lg.hidden = !on;
}
function mapSub() {
  const ref = esc(refLabel(state.book, state.chapter));
  return mapPrefs.layer === 'roman'
    ? `Locations named in ${ref}, on the Digital Atlas of the Roman Empire. Select a pin to see which verses name it.`
    : `Locations named in ${ref}. Select a pin to see which verses name it.`;
}
function mapTools() {
  const seg = [['modern', 'Modern'], ['roman', 'Roman world']].map(([k, l]) => {
    const on = mapPrefs.layer === k;
    return `<button type="button" role="radio" data-layer="${k}" aria-checked="${on}" tabindex="${on ? 0 : -1}">${l}</button>`;
  }).join('');
  return `<div class="pill-seg" role="radiogroup" aria-label="Map layer" data-map-tool>${seg}</div>`
    + `<button class="pill-tog txt" type="button" data-3d data-map-tool aria-pressed="${mapPrefs.terrain}" title="Tilt the map and raise the terrain">3D</button>`
    + `<button class="pill-tog" type="button" data-paul aria-pressed="${paulOn}">${icon('route')}Paul’s journeys</button>`;
}
/** Layer and 3D act on a live map only (disabled for the SVG fallback and the empty state). */
function syncMapTools(stage) {
  const live = P.mapMode === 'gl';
  stage.querySelectorAll('[data-map-tool]').forEach(n => {
    const btns = n.matches('button') ? [n] : [...n.querySelectorAll('button')];
    btns.forEach(b => { b.disabled = !live; });
    n.toggleAttribute('data-off', !live);
  });
  if (live && P.refocus) { refocus(stage, P.refocus); P.refocus = ''; }
}
function setMapLayer(stage, kind) {
  mapPrefs.layer = kind === 'roman' ? 'roman' : 'modern';
  stage.querySelectorAll('.pill-seg [data-layer]').forEach(b => {
    const on = b.dataset.layer === mapPrefs.layer;
    b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1;
  });
  const sub = stage.querySelector('.stage-sub'); if (sub) sub.innerHTML = mapSub();
  if (P.map && P.mapMode === 'gl') P.map.setLayer(mapPrefs.layer);
}
function bindMapTools(stage) {
  stage.querySelector('[data-paul]').onclick = () => togglePaul(stage);
  const seg = stage.querySelector('.pill-seg');
  seg.onclick = e => { const b = e.target.closest('[data-layer]'); if (b && !b.disabled) setMapLayer(stage, b.dataset.layer); };
  seg.onkeydown = e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation(); // ← → would otherwise also change the chapter
    const next = e.key === 'Home' ? 'modern' : e.key === 'End' ? 'roman' : (mapPrefs.layer === 'modern' ? 'roman' : 'modern');
    setMapLayer(stage, next);
    const b = seg.querySelector(`[data-layer="${next}"]`); if (b) b.focus();
  };
  const b3 = stage.querySelector('[data-3d]');
  b3.onclick = () => {
    mapPrefs.terrain = !mapPrefs.terrain;
    b3.setAttribute('aria-pressed', String(mapPrefs.terrain));
    if (P.map && P.mapMode === 'gl') P.map.setTerrain(mapPrefs.terrain);
  };
}
export async function renderMap(stage) {
  if (!stage) return;
  teardown();
  const t = P.token; P.kind = 'map'; P.stage = stage;
  const fk = stageFocus(stage);
  stage.innerHTML = stageHead({
    title: 'Places', close: 'map', sub: mapSub(),
    legend: `<div class="legend" data-paul-legend${paulOn ? '' : ' hidden'}>${PAUL_ROUTES.map(r => `<span class="key"><i style="background:${r.color}"></i>${r.name}</span>`).join('')}</div>`,
    tools: mapTools(),
  }) + '<div class="stage-body"><div class="leaf" id="bigmap"></div></div>';
  bindMapTools(stage);
  syncMapTools(stage);
  if (!refocus(stage, fk)) P.refocus = fk; // Layer and 3D wait for the live map
  let pts = [];
  try { pts = await chapterPlaces(); } catch (e) { pts = []; }
  if (t !== P.token) return;
  P.pts = pts;
  if (!pts.length && !paulOn) { P.mapMode = 'empty'; mapEmpty(stage, 'No mapped places in this chapter.'); return; }
  await mountBigMap(stage, t, false);
}
async function mountBigMap(stage, t, fitPaul) {
  P.mapMode = 'mounting'; // togglePaul must not start a second instance meanwhile (it reads paulOn below)
  const ok = await loadMapLibre();
  if (t !== P.token || P.map) return;
  const el = stage.querySelector('#bigmap'); if (!el) return;
  const pts = P.pts || [];
  // Paul's journeys may have been turned off again while the library loaded (a double click).
  if (!pts.length && !paulOn) { P.mapMode = 'empty'; syncMapTools(stage); mapEmpty(stage, 'No mapped places in this chapter.'); return; }
  if (!ok) { P.mapWhy = fallbackWhy(null); mapFallback(stage, el, pts); return; }
  mapEmpty(stage, '');
  const ctrl = createMap(el, { kind: 'stage', pins: pts, layer: mapPrefs.layer, terrain: mapPrefs.terrain, pinHtml: pinPopup, onPin: p => flashPlace(p, false), onVerse: showVerse, paulHtml: paulPopup, label: `Map of places named in ${refLabel(state.book, state.chapter)}` });
  P.map = ctrl; P.mapMode = 'gl';
  syncMapTools(stage);
  if (paulOn) setPaul(stage, true, fitPaul || !pts.length);
  const good = await ctrl.ready;
  if (P.map !== ctrl || ctrl.removed) return;
  if (!good) tilesFailed(stage, ctrl);
}
/** Library, WebGL, style or basemap tiles failed before the first load: SVG fallback. */
function tilesFailed(stage, ctrl) {
  if (P.map !== ctrl) return;
  P.mapWhy = fallbackWhy(ctrl.lastError); // e.g. MapLibre's 'Failed to initialize WebGL'
  try { ctrl.remove(); } catch (e) { /* ignore */ }
  P.map = null;
  const el = freshLeaf(stage); if (!el) return;
  mapFallback(stage, el, P.pts || []);
}
function mapFallback(stage, el, pts) {
  P.mapMode = 'svg';
  syncMapTools(stage);
  if (paulOn) {
    paulOn = false; setPaulPressed(stage, false);
    if (A && A.toast) A.toast(paulMsg());
  }
  if (!pts.length) { mapEmpty(stage, 'No mapped places in this chapter.'); return; }
  el.innerHTML = mapSVG(pts, el.clientWidth || 600, el.clientHeight || 320);
  bindLev(el, pts);
}
/** The journeys an Acts chapter tells (route_ids): the map dims the others. 13–14 first, 15:36–18:22 second,
    18:23–21:16 third, 27–28 the voyage to Rome; other chapters dim none. */
function paulRoutesOf(b, c) {
  if (b !== 44) return null;
  return c === 13 || c === 14 ? [1] : c >= 15 && c <= 17 ? [2] : c === 18 ? [2, 3] : c >= 19 && c <= 21 ? [3] : c >= 27 ? [4] : null;
}
async function setPaul(stage, on, fit) {
  const ctrl = P.map; if (!ctrl) return;
  if (!on) { ctrl.setPaul(null); return; }
  let gj = null;
  try { [gj, paulPlaces] = await Promise.all([data.paul(), paulPlaces || data.places().catch(() => null)]); } catch (e) { gj = null; }
  if (!gj || P.map !== ctrl || !paulOn) return;
  ctrl.setPaul(gj, paulRoutesOf(state.book, state.chapter));
  if (fit) ctrl.fitPaul(true);
}
async function togglePaul(stage) {
  if (P.kind !== 'map' || P.stage !== stage) return;
  paulOn = !paulOn;
  setPaulPressed(stage, paulOn);
  const pts = P.pts || [];
  if (P.map) {
    if (paulOn) { await setPaul(stage, true, true); return; }
    await setPaul(stage, false, false);
    if (pts.length) P.map.fit(true);
    else {
      try { P.map.remove(); } catch (e) { /* ignore */ }
      P.map = null; freshLeaf(stage); P.mapMode = 'empty'; syncMapTools(stage); mapEmpty(stage, 'No mapped places in this chapter.');
    }
    return;
  }
  if (!paulOn || P.mapMode === 'mounting') return; // an instance on its way picks paulOn up itself
  if (P.mapMode === 'svg') { paulOn = false; setPaulPressed(stage, false); if (A && A.toast) A.toast(paulMsg()); return; }
  if (P.pts) await mountBigMap(stage, P.token, true); // P.pts is null while the places are still loading
}

/* =====================================================================
   Timeline (SVG in #timeline, focus + context) — §9.8
   ===================================================================== */
// Bands on the same chronology as the verse and event years (Theographic follows Ussher: Exodus 1491 BC, conquest
// 1451, Saul 1095, the kingdom divided 975, Jerusalem fell 588, the cross AD 33), so a chapter lands in its own era.
// Bands are [start, end). 1451 and AD 33 stay with the era they close: Deuteronomy and Numbers 35–36 (32 chapters)
// against Joshua 1–10, and the Passion and Easter chapters (47) against Acts 1–7.
const ERAS = [[-2100, -1706, 'Patriarchs'], [-1706, -1491, 'Egypt'], [-1491, -1450, 'Exodus'], [-1450, -1095, 'Conquest & Judges'], [-1095, -975, 'Kingdom'], [-975, -588, 'Divided kingdom'], [-588, -536, 'Exile'], [-536, -400, 'Return'], [-400, -5, 'Between the Testaments'], [-5, 34, 'Life of Christ'], [34, 100, 'Early church']];
const PRIMEVAL = [-4300, -2100, 'Primeval history']; // zoom band only (Genesis 1–11 sits before the context bar)
const isYear = y => y !== null && y !== undefined && y !== '' && isFinite(+y);
function spanText(w) {
  const [a, z] = w;
  if (a === z) return 'c. ' + yearLabel(a);
  if (z < 0) return `c. ${-a}–${-z} BC`;
  if (a >= 0) return `c. AD ${a}–${z}`;
  return `c. ${-a} BC – AD ${z}`;
}
function timelineSVG(events, { era = null, written = null, eventIds = [], markLabel = 'This chapter' } = {}) {
  const W = 388, H = 124, X0 = -2100, X1 = 100;
  era = isYear(era) ? +era : null;
  written = Array.isArray(written) && isYear(written[0]) ? [+written[0], isYear(written[1]) ? +written[1] : +written[0]].sort((a, z) => a - z) : null;
  const fx = y => (clamp(y, X0, X1) - X0) / (X1 - X0) * W;
  const anchor = era ?? (written ? written[0] : 0);
  let w0, w1;
  if (anchor > -200) { w0 = -40; w1 = 110; } else { w0 = anchor - 280; w1 = anchor + 280; }
  if (written && written[1] > w1 && written[1] - w0 < 900) w1 = written[1] + 30;
  if (written && written[0] < w0 && w1 - written[0] < 900) w0 = written[0] - 30;
  const zx = y => 6 + (y - w0) / (w1 - w0) * (W - 12);
  const mark = String(markLabel || 'This chapter');
  const ariaParts = [];
  if (era !== null) ariaParts.push(`${mark.toLowerCase()} c. ${yearLabel(era)}`);
  if (written) ariaParts.push(`written ${spanText(written)}`);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc('Timeline' + (ariaParts.length ? ': ' + ariaParts.join('; ') : ''))}">`;
  // Context bar: all of Bible history, with the zoom window bracketed.
  ERAS.forEach((e, i) => { s += `<rect class="tl-e${i % 2}" x="${f1(fx(e[0]))}" y="6" width="${f1(Math.max(0.5, fx(e[1]) - fx(e[0]) - 0.8))}" height="6" rx="1.5"/>`; });
  s += `<rect class="tl-win" x="${f1(fx(w0) - 1)}" y="3" width="${f1(Math.max(4, fx(w1) - fx(w0) + 2))}" height="12" rx="3"/>`;
  s += `<path class="tl-conn" d="M${f1(fx(w0))} 15L6 40M${f1(fx(w1))} 15L${W - 6} 40"/>`;
  // Context-bar years sit on a sheet-coloured halo so the zoom connectors pass behind them.
  const halo = ' style="paint-order:stroke;stroke:var(--sheet-solid);stroke-width:4px;stroke-linejoin:round"';
  // A band too narrow for its name (the 40-year Exodus, the Exile) is named just above it when it is wholly in view, so a
  // chapter inside it never reads as the neighbouring era. Placed first, so the context-bar years can stand aside for it.
  const above = new Map(); // era -> [left, right] of its name above the band (≈6.2 units a letter at 10px)
  {
    let end = -Infinity;
    [PRIMEVAL, ...ERAS].forEach(e => {
      const a = Math.max(e[0], w0), z = Math.min(e[1], w1); if (z <= a) return;
      const x = zx(a), w = zx(z) - x, tw = e[2].length * 4.9;
      if (w > tw + 12 || !(e[0] >= w0 && e[1] <= w1)) return;
      const cx = clamp(x + w / 2, 6 + tw / 2, W - 6 - tw / 2);
      if (cx - tw / 2 > end + 8) { const hw = e[2].length * 3.1; above.set(e, [cx - hw, cx + hw]); end = cx + tw / 2; }
    });
  }
  // A context-bar year that would touch one of those names is left out ('1000 BC' over 'Exodus' read as one caption).
  [[-2000, '2000 BC', 'start'], [-1500, '1500 BC', 'middle'], [-1000, '1000 BC', 'middle'], [-500, '500 BC', 'middle'], [1, 'AD 1', 'end']].forEach(([y, l, a]) => {
    const x = fx(y);
    if (x > fx(w0) - 30 && x < fx(w1) + 30) return;
    const lw = l.length * 6, lx0 = a === 'start' ? x : a === 'end' ? x - lw : x - lw / 2;
    for (const [p, q] of above.values()) if (lx0 < q + 4 && lx0 + lw > p - 4) return;
    s += `<text class="tl-t" x="${f1(x)}" y="26" text-anchor="${a}"${halo}>${l}</text>`;
  });
  // Zoom band.
  let bi = 0;
  [PRIMEVAL, ...ERAS].forEach(e => {
    const a = Math.max(e[0], w0), z = Math.min(e[1], w1); if (z <= a) return;
    const x = zx(a), w = zx(z) - x, tw = e[2].length * 4.9;
    s += `<rect class="tl-band${bi++ % 2}" x="${f1(x)}" y="40" width="${f1(Math.max(0.5, w - 1))}" height="26"/>`;
    if (w > tw + 12) s += `<text class="tl-band-l" x="${f1(x + 7)}" y="57">${esc(e[2])}</text>`;
    else if (above.has(e)) { const [p, q] = above.get(e); s += `<text class="tl-band-l" x="${f1((p + q) / 2)}" y="37" text-anchor="middle">${esc(e[2])}</text>`; }
  });
  s += `<line class="tl-axis" x1="6" y1="66.5" x2="${W - 6}" y2="66.5"/>`;
  const span = w1 - w0, stepY = span <= 200 ? 25 : span <= 600 ? 100 : 250;
  for (let y = Math.ceil(w0 / stepY) * stepY; y <= w1; y += stepY) {
    const x = zx(y === 0 ? 1 : y); if (x < 14 || x > W - 14) continue;
    s += `<line class="tl-axis" x1="${f1(x)}" y1="66" x2="${f1(x)}" y2="70"/><text class="tl-t" x="${f1(x)}" y="81" text-anchor="middle">${y === 0 ? 'AD 1' : yearLabel(y)}</text>`;
  }
  // Event ticks (one per pixel column; events of this chapter/verse are .here and drawn on top).
  const here = new Set((eventIds || []).map(String)), cols = new Map();
  for (const [id, e] of Object.entries(events || {})) {
    const y = parseInt(e && e.y, 10);
    if (!isFinite(y) || y < w0 || y > w1) continue;
    const x = Math.round(zx(y));
    let col = cols.get(x);
    if (!col) cols.set(x, (col = { x, y, list: [], here: false }));
    const h = here.has(String(id));
    col.here = col.here || h;
    col.list.push({ t: e.t || '', h, y, k: isFinite(+e.sk) ? +e.sk : y });
  }
  const buckets = [...cols.values()].sort((a, z) => (a.here - z.here) || (a.x - z.x));
  buckets.forEach(bk => { bk.list.sort((a, z) => (z.h - a.h) || (a.k - z.k)); bk.y = bk.list[0].y; });
  buckets.forEach(bk => { s += `<line class="tl-ev${bk.here ? ' here' : ''}" x1="${bk.x}" y1="${bk.here ? 56 : 60}" x2="${bk.x}" y2="66" data-t="${esc(bk.list[0].t)}" data-y="${bk.y}"/>`; });
  // Written bracket and chapter marker.
  const labels = [];
  if (written) {
    const lo = Math.max(written[0], w0), hi = Math.min(written[1], w1);
    let mid;
    if (hi >= lo) {
      // A one-year span is a 2px bracket centred on its year, so a year on an era boundary stays on it.
      let a = zx(lo), z = zx(hi); mid = (a + z) / 2;
      if (z - a < 2) { a = mid - 1; z = mid + 1; }
      s += `<path class="tl-wr" d="M${f1(a)} 60v6.5M${f1(a)} 63.25H${f1(z)}M${f1(z)} 60v6.5"/>`;
    } else mid = written[0] > w1 ? W : 0; // outside the window: park the label at that edge
    labels.push({ x: mid, t: 'Written', s: spanText(written) });
  }
  if (era !== null) {
    const x = zx(era);
    s += `<line class="tl-mk-line" x1="${f1(x)}" y1="40" x2="${f1(x)}" y2="66"/><circle class="tl-mk" cx="${f1(x)}" cy="66.5" r="4.5"/>`;
    labels.unshift({ x, t: mark, s: 'c. ' + yearLabel(era) });
  }
  // Labels: at least 96px apart, kept off the edges.
  const half = l => Math.max(40, Math.max(l.t.length * 6.3, l.s.length * 5.8) / 2 + 6);
  labels.forEach(l => { l.x = clamp(l.x, half(l), W - half(l)); });
  if (labels.length === 2 && Math.abs(labels[0].x - labels[1].x) < 96) {
    const [lo, hi] = labels[0].x <= labels[1].x ? labels : [labels[1], labels[0]];
    const mid = (lo.x + hi.x) / 2;
    lo.x = mid - 48; hi.x = mid + 48;
    if (lo.x < half(lo)) { hi.x += half(lo) - lo.x; lo.x = half(lo); }
    if (hi.x > W - half(hi)) { lo.x -= hi.x - (W - half(hi)); hi.x = W - half(hi); }
  }
  labels.forEach(l => { s += `<text class="tl-mk-l" x="${f1(l.x)}" y="102" text-anchor="middle">${esc(l.t)}</text><text class="tl-mk-s" x="${f1(l.x)}" y="116" text-anchor="middle">${esc(l.s)}</text>`; });
  buckets.forEach((bk, k) => { s += `<rect class="tl-hit" x="${bk.x - 3}" y="50" width="6" height="20" data-k="${k}"/>`; });
  return { svg: s + '</svg>', buckets };
}
function tlTip(bk) {
  const show = bk.list.slice(0, 3), more = bk.list.length - show.length;
  return show.map(ev => `<div class="tt">${esc(ev.t)}</div>`).join('') + `<div class="tm">${esc(yearLabel(bk.y))}${more > 0 ? ` · ${fmt(more)} more` : ''}</div>`;
}
export async function renderTimeline(host, { era = null, written = null, eventIds = [], markLabel = 'This chapter' } = {}) {
  if (!host) return;
  let events = {};
  try { events = await data.events(); } catch (e) { events = {}; }
  const { svg, buckets } = timelineSVG(events, { era, written, eventIds, markLabel });
  host.innerHTML = svg;
  const stamp = Math.random().toString(36).slice(2, 7);
  host.onpointermove = e => {
    const r = e.target && e.target.closest ? e.target.closest('.tl-hit') : null;
    const bk = r ? buckets[+r.dataset.k] : null;
    if (!bk) { if (tip.key && String(tip.key).startsWith('tl:')) tip.hide(); return; }
    tipKeyed(e, `tl:${stamp}:${r.dataset.k}`, tlTip(bk));
  };
  host.onpointerleave = () => tip.hide();
}

/* =====================================================================
   Canon strip (SVG in #canon-mini, Links tab) — §9.10
   ===================================================================== */
let canonRO = null;
export function renderCanonStrip(host, list, { onPick } = {}) {
  if (!host) return;
  const rows = Array.isArray(list) ? list : [];
  let lastW = -1;
  const draw = () => {
    const W = Math.max(260, Math.round(host.clientWidth || 0)), H = 46, base = 30, segs = canon(W, 1);
    lastW = host.clientWidth;
    const max = Math.max(1, maxOf(rows, x => votesOf(x[4])));
    let bar = '';
    for (const s of segs) bar += `<rect class="seg-b ${testOf(s.b)}${s.b === state.book ? ' cur' : ''}" x="${f1(s.x0 + 0.4)}" y="${base}" width="${f1(Math.max(0.8, s.x1 - s.x0 - 0.8))}" height="4" rx="1"/>`;
    const dots = rows.map((x, i) => ({ x, i })).sort((a, z) => votesOf(a.x[4]) - votesOf(z.x[4])).map(({ x, i }) => {
      const r = 2.5 + 3.5 * strength(x[4], max);
      return `<circle class="dot ${testOf(x[0])}" data-i="${i}" cx="${f1(xAt(segs, x[0], x[1], x[2]))}" cy="${f1(base - 4 - r)}" r="${f1(r)}"><title>${esc(refLabel(x[0], x[1], x[2], x[3]))} · ${plural(votesOf(x[4]), 'vote')}</title></circle>`;
    }).join('');
    const nOT = rows.reduce((k, x) => k + (x[0] <= 39 ? 1 : 0), 0), nNT = rows.length - nOT, ntX = f1(segs[39] ? segs[39].x0 : W / 2);
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Where ${plural(rows.length, 'link')} go: ${fmt(nOT)} in the Old Testament, ${fmt(nNT)} in the New Testament">${bar}${dots}`
      + `<text x="1" y="${H - 1}">Old Testament</text><line x1="${ntX}" x2="${ntX}" y1="${base + 6}" y2="${base + 10}" style="stroke:var(--label-4)"/>`
      + `<text x="${W - 1}" y="${H - 1}" text-anchor="end">New Testament</text></svg>`;
  };
  draw();
  host.onclick = e => {
    const d = e.target.closest && e.target.closest('.dot');
    if (d && typeof onPick === 'function') onPick(+d.dataset.i);
  };
  if (canonRO) canonRO.disconnect();
  canonRO = null;
  if ('ResizeObserver' in window) {
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (!host.isConnected) { ro.disconnect(); return; }
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; if (host.isConnected && host.clientWidth !== lastW) draw(); });
    });
    ro.observe(host); canonRO = ro;
  }
}

/* =====================================================================
   Theme changes
   ===================================================================== */
/** Redraw anything that baked token colours into pixels (safe no-op if nothing is open). */
export function refreshTheme() {
  sansCache = '';
  if (P.kind === 'arcs' && P.arcs && P.arcs.cv) { if (P.arcs.animating) P.arcs.dirty = true; else arcsStatic(); }
  if (P.kind === 'graph' && P.graph && P.graph.cv) { if (P.graph.animating) P.graph.dirty = true; else graphStatic(P.graph); }
  // Maps rebuild their style only when the host's scheme or --map-* tokens changed (the night stage never does).
  if (P.kind === 'map' && P.map && P.mapMode === 'gl') P.map.restyle();
  if (miniMap.ctrl && miniMap.mode === 'gl') miniMap.ctrl.restyle();
}
try {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', refreshTheme); else if (mq.addListener) mq.addListener(refreshTheme);
} catch (e) { /* matchMedia unavailable */ }
