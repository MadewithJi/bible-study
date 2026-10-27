// Memorize mock-ups: the shared behaviour (mock only; nothing is saved and no app code is touched).
// - initShell({ states, onState }): the Memorize glyph, [data-icon] placeholders, the theme, and, on a page shown on its
//   own, the mock strip at the top (the page's states, a link to all screens, the theme). Embedded in the gallery
//   (?embed) the strip goes and every link is held inside the frame: a [data-go] link asks the gallery to change screen.
// - segmented(seg, onPick): the app's segmented control as a radiogroup (thumb, arrows, Home/End).
// - toast(msg, action, onAction) and hideToast(): the app's toast, timed as main.js times it; go(screen), scripture(text), esc(text).
// The theme is a per-viewer convenience in localStorage (wrapped: storage can be blocked); ?theme=light|dark wins.
import { icon } from '../js/icons.js';
export { icon };

export const params = new URLSearchParams(location.search);
export const embedded = params.has('embed');
export const SCREENS = { select: 'memorize-select.html', home: 'memorize-home.html', practise: 'memorize-practise.html', library: 'memorize-library.html' };
const KEY = 'mz-mock-theme', NAME = { auto: 'Auto', light: 'Light', dark: 'Dark' }, NEXT = { auto: 'light', light: 'dark', dark: 'auto' };

// The Memorize glyph: lines of writing that end in a small heart ("write them upon the table of thine heart",
// Proverbs 3:3). Not the Support heart (i-heart), which is a heart alone. Pause: two bars.
const EXTRA = {
  mz: '<path d="M3.5 5h17M3.5 9.5h17M3.5 14h7"/><path d="M16.6 21s-4.3-2.6-4.3-5.7a2.15 2.15 0 014.3-1.15 2.15 2.15 0 014.3 1.15c0 3.1-4.3 5.7-4.3 5.7z"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
};
function mountExtra() {
  if (document.getElementById('mz-sprite')) return;
  const sym = Object.entries(EXTRA).map(([n, p]) => `<symbol id="i-${n}" viewBox="0 0 24 24">${p}</symbol>`).join('');
  document.body.insertAdjacentHTML('beforeend', `<svg id="mz-sprite" width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${sym}</defs></svg>`);
}

export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Scripture as the app sets it: the divine name in small capitals (LORD → Lord in small caps). */
export const scripture = s => esc(s).replace(/\bLORD\b/g, '<span class="sc">Lord</span>');

// ------------------------------------------------------------ theme
export function savedTheme() {
  const q = params.get('theme'); if (q === 'light' || q === 'dark') return q;
  if (embedded) return 'auto';
  try { const t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'auto'; } catch { return 'auto'; }
}
export function applyTheme(t, doc = document) {
  const r = doc && doc.documentElement; if (!r) return;
  if (t === 'light' || t === 'dark') r.dataset.theme = t; else delete r.dataset.theme;
}

// ------------------------------------------------------------ navigation between the screens
/** Show another screen: the gallery switches its frame; on its own the page goes there. */
export function go(screen) {
  if (!SCREENS[screen]) return;
  if (embedded && parent !== window) parent.postMessage({ type: 'mz-go', screen }, location.origin);
  else location.href = SCREENS[screen];
}

// ------------------------------------------------------------ segmented control (radiogroup)
export function moveInd(seg) {
  const act = seg && seg.querySelector('[aria-checked="true"]'), ind = seg && seg.querySelector('.seg-ind');
  if (!act || !ind || !act.offsetWidth) return;
  ind.style.width = act.offsetWidth + 'px';
  ind.style.transform = `translateX(${act.offsetLeft}px)`;
}
/** Wire a .segmented[role=radiogroup] of button[role=radio][data-v]; returns { set(v) } (set does not call onPick). */
export function segmented(seg, onPick) {
  if (!seg.querySelector('.seg-ind')) seg.insertAdjacentHTML('afterbegin', '<span class="seg-ind" aria-hidden="true"></span>');
  const items = () => [...seg.querySelectorAll('[role="radio"]')].filter(b => !b.hidden && !b.disabled);
  const mark = b => { for (const x of seg.querySelectorAll('[role="radio"]')) { const on = x === b; x.setAttribute('aria-checked', String(on)); x.tabIndex = on ? 0 : -1; } moveInd(seg); };
  const pick = (b, focus = false) => { if (!b) return; const was = b.getAttribute('aria-checked') === 'true'; mark(b); if (focus) b.focus(); if (!was && onPick) onPick(b.dataset.v, b); };
  seg.addEventListener('click', e => { const b = e.target.closest('[role="radio"]'); if (b && seg.contains(b) && !b.disabled) pick(b); });
  seg.addEventListener('keydown', e => {
    const list = items(), i = list.findIndex(b => b.getAttribute('aria-checked') === 'true');
    const j = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : null;
    if (j === null) return;
    e.preventDefault(); pick(list[(j + list.length) % list.length], true);
  });
  seg.classList.add('no-anim');
  requestAnimationFrame(() => { moveInd(seg); requestAnimationFrame(() => seg.classList.remove('no-anim')); });
  if ('ResizeObserver' in window) new ResizeObserver(() => moveInd(seg)).observe(seg);
  return { set(v) { const b = seg.querySelector(`[role="radio"][data-v="${CSS.escape(v)}"]`); if (b) mark(b); } };
}

// ------------------------------------------------------------ toast (the app's one #toast, as main.js runs it)
// One persistent role=status element, filled and shown; it goes after 10 s with an action (4.2 s without), and waits
// while the pointer or focus is on it (then 2.5 s more).
let toastEl = null, toastT = 0, toastOutT = 0;
const RM = matchMedia('(prefers-reduced-motion: reduce)');
function toastHost() {
  if (toastEl && toastEl.isConnected) return toastEl;
  toastEl = document.createElement('div');
  toastEl.className = 'toast'; toastEl.setAttribute('role', 'status'); toastEl.hidden = true;
  document.body.append(toastEl);
  const pause = () => clearTimeout(toastT);
  const resume = () => { if (!toastEl.hidden && !toastEl.classList.contains('out')) { clearTimeout(toastT); toastT = setTimeout(hideToast, 2500); } };
  toastEl.addEventListener('pointerenter', pause); toastEl.addEventListener('pointerleave', resume);
  toastEl.addEventListener('focusin', pause); toastEl.addEventListener('focusout', resume);
  return toastEl;
}
export function toast(msg, action = '', onAction = null) {
  const el = toastHost();
  clearTimeout(toastT); clearTimeout(toastOutT);
  el.classList.remove('out'); el.hidden = false;
  el.innerHTML = `<span class="toast-msg">${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  if (action) el.querySelector('button').addEventListener('click', () => { hideToast(); if (onAction) onAction(); });
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  toastT = setTimeout(hideToast, action ? 10000 : 4200);
  return el;
}
export function hideToast() {
  const el = toastEl; if (!el || el.hidden) return;
  clearTimeout(toastT); el.classList.add('out');
  clearTimeout(toastOutT); toastOutT = setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, RM.matches ? 0 : 300);
}

// ------------------------------------------------------------ the shell
export function initShell({ states = [], state = '', onState = null } = {}) {
  mountExtra(); toastHost();
  for (const el of document.querySelectorAll('[data-icon]')) { el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)); el.removeAttribute('data-icon'); }
  applyTheme(savedTheme());
  addEventListener('keydown', e => { if (e.key === 'Escape' && toastEl && !toastEl.hidden && !document.querySelector('.mz-menu')) hideToast(); });
  if (embedded) {
    document.documentElement.classList.add('mz-embed');
    // the gallery's frame is sandboxed too; here every link stays put, and a [data-go] link asks for its screen
    document.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('a[href]'); if (!a) return;
      e.preventDefault();
      if (a.dataset.go) go(a.dataset.go);
    }, true);
    return;
  }
  for (const a of document.querySelectorAll('a[data-go]')) a.href = SCREENS[a.dataset.go] || a.href;
  document.documentElement.classList.add('mz-has-strip');
  const t = savedTheme();
  const seg = states.length > 1 ? `<div class="segmented" role="radiogroup" aria-label="Mock-up state">${states.map(([label, v]) => `<button type="button" role="radio" data-v="${esc(v)}" aria-checked="${v === state}" tabindex="${v === state ? 0 : -1}">${esc(label)}</button>`).join('')}</div>` : '';
  document.body.insertAdjacentHTML('afterbegin', `<div class="mz-strip" role="region" aria-label="Mock-up controls"><b>Mock-up</b><span class="mz-say">Sample data · nothing is saved</span>${seg}<span class="mz-sp"></span><a href="memorize-all.html">All screens</a><button type="button" class="mz-th">${icon('sun')}<span>${NAME[t]}</span></button></div>`);
  const strip = document.querySelector('.mz-strip');
  if (seg) segmented(strip.querySelector('.segmented'), v => {
    const u = new URL(location.href); if (v) u.searchParams.set('state', v); else u.searchParams.delete('state');
    history.replaceState(null, '', u);
    if (onState) onState(v);
  });
  const th = strip.querySelector('.mz-th'), label = x => th.setAttribute('aria-label', `Theme: ${NAME[x]}. Change theme`);
  label(t);
  th.addEventListener('click', () => {
    const n = NEXT[savedTheme()] || 'auto';
    try { localStorage.setItem(KEY, n); } catch { /* blocked storage: this page only */ }
    params.delete('theme'); applyTheme(n); th.querySelector('span').textContent = NAME[n]; label(n);
  });
}
