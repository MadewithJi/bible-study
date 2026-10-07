// Study videos in the margin (.design/videos-brief.md): a play icon in the verse gutter of chosen verses
// (data/media.json) opens the video in a modal player. The dialog is #video in index.html: main.js bindDialogs
// binds it like every other dialog (Esc, [data-close], a backdrop click that also began on the backdrop).
import { esc, smart, refLabel, bookOf, RM } from './store.js';
import { icon } from './icons.js';
import { showDialog, closeDialog } from './ui.js';
import { stopPlayer } from './drawer.js';

const DATA_URL = new URL('../data/media.json', import.meta.url).href;
const T = s => smart(String(s ?? '').trim());                 // curly quotes for data strings (before esc)
const keyOf = (b, c, v) => `${b}.${c}.${v}`;
const embedUrl = (yt, autoplay) => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}?autoplay=${autoplay ? 1 : 0}&rel=0`;
const watchUrl = yt => `https://www.youtube.com/watch?v=${encodeURIComponent(yt)}`;
const PROBE_URL = 'https://www.youtube-nocookie.com/favicon.ico';

let VIDEOS = [];              // in media.json order
const BY_ID = new Map();      // id -> video
const AT = new Map();         // 'b.c.v' -> [video] (several videos may share a verse)
let loaded = false, loadP = null;

function build(json) {
  const list = json && Array.isArray(json.videos) ? json.videos : [];
  for (const m of list) {
    if (!m || typeof m.id !== 'string' || !m.id || BY_ID.has(m.id) || !/^[\w-]{11}$/.test(String(m.yt || '')) || !T(m.title)) continue;
    // [book, chapter, verse] with a real book and chapter (a typo in media.json is skipped, never shown on another verse)
    const at = (Array.isArray(m.at) ? m.at : []).filter(r => Array.isArray(r) && r.length === 3 && r.every(n => Number.isInteger(n) && n > 0)
      && r[0] <= 66 && r[1] <= (bookOf(r[0])?.chapters?.length || 0) && r[2] <= bookOf(r[0]).chapters[r[1] - 1]);
    if (!at.length) continue;
    const vid = { id: m.id, yt: m.yt, title: T(m.title), by: T(m.by), note: T(m.note), at };
    VIDEOS.push(vid); BY_ID.set(vid.id, vid);
    at.forEach(([b, c, v]) => { const k = keyOf(b, c, v); if (!AT.has(k)) AT.set(k, []); if (!AT.get(k).includes(vid)) AT.get(k).push(vid); });
  }
  loaded = true;
}

/** Fetch data/media.json once and index it. Never throws; a failed fetch can be retried by the next call. */
export function load() {
  if (loaded) return Promise.resolve();
  if (!loadP) {
    loadP = fetch(DATA_URL)
      .then(r => { if (!r.ok) throw new Error(`${r.status} media.json`); return r.json(); })
      .then(build)
      .catch(e => { console.warn('media: could not load the study videos', e); loadP = null; });
  }
  return loadP;
}
export const isLoaded = () => loaded;
export const videos = () => VIDEOS;
export const video = id => BY_ID.get(id) || null;
/** The videos shown beside one verse ([] before media.json has loaded). */
export function forVerse(b, c, v) { return AT.get(keyOf(+b, +c, +v)) || []; }

/** '' or the verse's play icons for the gutter (.badges), one per video. */
export function badgeHtml(b, c, v) {
  return forVerse(b, c, v).map(m => `<button class="b-media" type="button" data-media="${esc(m.id)}" data-media-ref="${keyOf(+b, +c, +v)}" aria-haspopup="dialog" aria-label="${esc(`Watch video: ${m.title}`)}" title="${esc(m.title)}">${icon('play-rect')}</button>`).join('');
}

// ------------------------------------------------------------ the modal player (#video)
let D = null;                 // { d, title, sub, frame, note, yt }
let cur = null;               // { m, ref: {b, c, v} } while open
let opener = null, token = 0, probeT = 0, onlineFn = null;

function dlg() {
  if (D) return D;
  const d = document.getElementById('video'); if (!d) return null;
  const q = s => d.querySelector(s);
  D = { d, title: q('#video-title'), sub: q('#video-sub'), frame: q('#video-frame'), note: q('#video-note'), yt: q('#video-yt') };
  // every way out (Esc, Close, the backdrop, another script's closeDialog) ends in 'close'. Chrome fires it at the
  // next frame (later still in a hidden tab), and closeDialog fades the card out first (.closing): stop the video
  // as soon as the fade starts
  d.addEventListener('close', onClose);
  if (typeof MutationObserver === 'function') new MutationObserver(() => { if (d.classList.contains('closing')) stop(); }).observe(d, { attributes: true, attributeFilter: ['class'] });
  return D;
}

export const isOpen = () => !!(D && D.d.open && !D.d.classList.contains('closing'));

/** Open from a gutter icon: the passage is the icon's verse, and the focus returns to the icon. */
export function openFromBadge(btn) {
  if (!btn || !btn.dataset) return false;
  const [b, c, v] = String(btn.dataset.mediaRef || '').split('.').map(Number);
  return openVideo(btn.dataset.media, { ref: b && c && v ? { b, c, v } : null, returnFocus: btn });
}

/**
 * Show one video in the modal. opts.ref: the verse it was opened from (else its primary verse);
 * opts.returnFocus: the element to focus after closing.
 */
export function openVideo(id, opts = {}) {
  const m = BY_ID.get(id), x = dlg(); if (!m || !x) return false;
  try { if (document.querySelector('#player iframe')) stopPlayer(); } catch (e) { console.error(e); } // one video at a time: the study panel's player closes
  const [pb, pc, pv] = m.at[0];
  const ref = opts.ref && m.at.some(r => r[0] === opts.ref.b && r[1] === opts.ref.c && r[2] === opts.ref.v) ? opts.ref : { b: pb, c: pc, v: pv };
  if (!x.d.open || x.d.classList.contains('closing')) opener = opts.returnFocus || (document.activeElement !== document.body ? document.activeElement : null);
  cur = { m, ref };
  x.title.textContent = m.title;
  x.sub.textContent = [refLabel(ref.b, ref.c, ref.v), m.by].filter(Boolean).join(' · ');
  x.note.textContent = m.note; x.note.hidden = !m.note;
  x.yt.href = watchUrl(m.yt);
  showDialog(x.d);
  play();
  x.d.querySelector('.modal-head [data-close]')?.focus({ preventScroll: true });
  return true;
}

export function closeVideo() { if (D && D.d.open) closeDialog(D.d); }

/** Load the player, or the offline note when the device is offline. Autoplay unless the reader prefers reduced motion. */
function play() {
  const x = D, m = cur && cur.m; if (!x || !m) return;
  const my = ++token;
  clearProbe();
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { showOff(); return; }
  x.frame.classList.remove('off'); x.yt.hidden = false;
  x.frame.innerHTML = `<iframe src="${esc(embedUrl(m.yt, !RM.matches))}" title="${esc(m.title)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  // the iframe's load event fires for an error page too, so ask YouTube's host directly: an offline device or a
  // blocked host fails this request (its answer is opaque and never read)
  if (typeof fetch !== 'function') return;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  probeT = setTimeout(() => ctl && ctl.abort(), 12000);
  fetch(PROBE_URL, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctl ? ctl.signal : undefined })
    .then(() => {}, () => { if (my === token && isOpen()) showOff(); })
    .finally(() => { if (my === token) clearTimeout(probeT); });
}

/** Offline or blocked: a short note and a link that opens the video on YouTube in a new tab. */
function showOff() {
  const x = D, m = cur && cur.m; if (!x || !m) return;
  token++; clearProbe();
  x.frame.classList.add('off'); x.yt.hidden = true;
  x.frame.innerHTML = `<div class="vm-off" role="status"><p>The video can’t load here<small>You may be offline, or YouTube may be blocked on this network.</small></p><a class="btn btn-tinted sm" href="${esc(watchUrl(m.yt))}" target="_blank" rel="noopener">Watch on YouTube${icon('external')}</a></div>`;
  // back online while the note shows: try the player again
  onlineFn = () => { if (isOpen() && x.frame.classList.contains('off')) play(); };
  addEventListener('online', onlineFn, { once: true });
}

function clearProbe() {
  clearTimeout(probeT); probeT = 0;
  if (onlineFn) { removeEventListener('online', onlineFn); onlineFn = null; }
}

/** Removing the iframe stops the video. */
function stop() {
  const x = D; if (!x) return;
  token++; clearProbe();
  x.frame.querySelector('iframe')?.remove();                // play() and showOff() reset the frame on the next open
}

function onClose() {
  const x = D; if (!x || x.d.open) return;                   // reopened before the event came
  stop();
  const was = cur; cur = null;
  let o = opener; opener = null;
  // the chapter was redrawn meanwhile (a translation change): the same icon in the new render
  if ((!o || !o.isConnected) && was) {
    const { b, c, v } = was.ref;
    o = document.querySelector(`#reader .b-media[data-media="${CSS.escape(was.m.id)}"][data-media-ref="${keyOf(b, c, v)}"]`);
  }
  if (o && o.isConnected && typeof o.focus === 'function') o.focus({ preventScroll: true });
}
