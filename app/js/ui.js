// Shared UI helpers (profiles spec §5.1): menus, the confirm dialog, dialog open/close, and time formatting.
import { RM } from './store.js';
import { icon } from './icons.js';

const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------ dialogs
/** Animated close (spec.md §5.8): .closing, then close() after 180 ms (0 under reduced motion). */
export function closeDialog(d) {
  if (!d || !d.open || d.classList.contains('closing')) return;
  d.classList.add('closing');
  clearTimeout(d._closeT);
  d._closeT = setTimeout(() => {
    d._closeT = 0;
    if (!d.classList.contains('closing')) return;   // reopened meanwhile: showDialog cancelled this close
    d.close(); d.classList.remove('closing');
  }, RM.matches ? 0 : 180);
}
/** showModal() unless already open. A dialog still animating out is kept open: its pending close timer is
 *  cancelled and dropping .closing replays dlgIn (no close() + showModal(), whose queued 'close' event would
 *  cancel a confirm that was just reopened). */
export function showDialog(d) {
  if (!d) return;
  clearTimeout(d._closeT); d._closeT = 0;
  d.classList.remove('closing');   // also when Chrome already closed it natively (a second Esc) mid-fade
  if (!d.open) d.showModal();
}

// ------------------------------------------------------------ segmented radiogroups (same behaviour as drawer.js)
/** Slide a segmented control's thumb under its checked/selected button. */
export function moveInd(seg) {
  if (!seg) return;
  const act = seg.querySelector('[aria-selected="true"],[aria-checked="true"]'), ind = seg.querySelector('.seg-ind');
  if (!act || !ind || !act.offsetWidth) return;
  ind.style.width = act.offsetWidth + 'px';
  ind.style.transform = `translateX(${act.offsetLeft}px)`;
}
/** First placement without animation. */
export function placeInd(seg) {
  if (!seg) return;
  seg.classList.add('no-anim'); moveInd(seg);
  requestAnimationFrame(() => requestAnimationFrame(() => seg.classList.remove('no-anim')));
}
/** aria-checked + roving tabindex in a radiogroup, then move its thumb. */
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

// ------------------------------------------------------------ menus
let menuEl = null;
export const menuOpen = () => !!menuEl;

/**
 * Open a popover menu (role=menu) under `anchor` (flipped above when it would overflow).
 * The first [role=menuitem] (or opts.focus) gets focus; ArrowUp/Down/Home/End cycle the items;
 * Esc and Tab close and return focus to the anchor; a pointerdown outside closes.
 * Opening again on the same anchor toggles the menu closed (returns null).
 * Inside an open modal dialog the menu is placed in that dialog (the rest of the page is inert).
 */
export function openMenu(anchor, html, { label = '', className = '', onClick, onKeydown, onClose, focus, dialog = false } = {}) {
  if (menuEl && menuEl._opener === anchor) { closeMenu(); return null; }
  closeMenu(false);
  const m = document.createElement('div');
  m.className = 'menu' + (className ? ' ' + className : '');
  // dialog: a popover editor (fields and swatches with a small action menu inside), where Tab moves between controls
  m.setAttribute('role', dialog ? 'dialog' : 'menu');
  if (label) m.setAttribute('aria-label', label);
  m.innerHTML = html;
  m._opener = anchor; m._onClose = onClose;
  const host = (anchor && anchor.closest && anchor.closest('dialog[open]')) || document.body;
  host.appendChild(m);
  menuEl = m;
  // a menu inside a dialog must not outlive it (a hidden .menu would keep blocking the keyboard shortcuts)
  if (host !== document.body) host.addEventListener('close', () => { if (menuEl === m) closeMenu(false); }, { once: true });
  if (anchor) anchor.setAttribute('aria-expanded', 'true');
  placeMenu(m, anchor);
  const first = (focus && m.querySelector(focus)) || m.querySelector('[role=menuitem]:not([disabled]), [role=menuitemradio], [role=radio], input, button');
  first?.focus({ preventScroll: true });
  m.addEventListener('click', e => { if (typeof onClick === 'function') onClick(e, m); });
  m.addEventListener('keydown', e => {
    if (typeof onKeydown === 'function') onKeydown(e, m);
    if (e.defaultPrevented) return;
    const items = $$('[role=menuitem]:not([disabled])', m).filter(x => !x.hidden);
    const i = items.indexOf(document.activeElement);
    const inField = e.target.matches && e.target.matches('input, textarea');
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); return; }
    if (e.key === 'Tab') {
      e.preventDefault(); e.stopPropagation();
      if (!dialog) { closeMenu(); return; }
      // Tab cycles through the popover: the field, the checked swatch, then each action
      const stops = $$('input, [role=radio][tabindex="0"], [role=menuitem]:not([disabled]), button:not([role]):not([disabled])', m).filter(x => !x.hidden && x.offsetParent !== null);
      const k = stops.indexOf(document.activeElement);
      stops[(k + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
      return;
    }
    if (!items.length || (inField && (e.key === 'Home' || e.key === 'End'))) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); items[i < 0 ? 0 : (i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  });
  return m;
}

function placeMenu(m, anchor) {
  const vw = document.documentElement.clientWidth || innerWidth, vh = innerHeight;
  const r = anchor ? anchor.getBoundingClientRect() : { left: vw / 2, right: vw / 2, top: vh / 3, bottom: vh / 3, width: 0 };
  // layout size: getBoundingClientRect() would include the menuIn scale(.9) of the first frame
  const mr = { width: m.offsetWidth, height: m.offsetHeight };
  const leftSide = (r.left + r.right) / 2 < vw / 2;
  let x = leftSide ? r.left : r.right - mr.width;
  x = Math.max(8, Math.min(x, vw - mr.width - 8));
  const below = r.bottom + 6, fits = below + mr.height + 8 <= vh;
  // always inside the viewport, even for an anchor scrolled out of view
  const y = Math.max(8, Math.min(fits ? below : r.top - mr.height - 6, vh - mr.height - 8));
  m.style.left = Math.round(x) + 'px';
  m.style.top = Math.round(y) + 'px';
  m.style.transformOrigin = `${fits ? 'top' : 'bottom'} ${leftSide ? 'left' : 'right'}`;
  if (mr.height > vh - 16) { m.style.maxHeight = (vh - 16) + 'px'; m.style.overflowY = 'auto'; m.style.top = '8px'; }
}

export function closeMenu(restoreFocus = true) {
  if (!menuEl) return;
  const m = menuEl, opener = m._opener, onClose = m._onClose;
  menuEl = null;
  // run onClose first: it may read fields inside the menu (a bookmark label saves on close)
  if (typeof onClose === 'function') { try { onClose(m); } catch (e) { console.error(e); } }
  m.remove();
  if (opener) {
    opener.setAttribute('aria-expanded', 'false');
    if (restoreFocus && opener.isConnected) opener.focus({ preventScroll: true });
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', e => {
    if (!menuEl) return;
    const t = e.target;
    if (t instanceof Node && (menuEl.contains(t) || (menuEl._opener && menuEl._opener.contains && menuEl._opener.contains(t)))) return;
    closeMenu(false);
  }, true);
  // keep an open menu under its anchor when the window resizes (a phone keyboard opening for the bookmark label)
  window.addEventListener('resize', () => { if (menuEl && menuEl._opener && menuEl._opener.isConnected) placeMenu(menuEl, menuEl._opener); });
  // its anchor scrolled away (the page, the Library list): close it, as the drawer's menus do. While typing in the
  // menu's field the scroll is a phone keyboard bringing it into view, so keep it under its anchor instead.
  document.addEventListener('scroll', e => {
    const m = menuEl, t = e.target; if (!m) return;
    const box = t === document ? document.documentElement : t;
    if (!(box instanceof Node) || m.contains(box) || !(m._opener && box.contains(m._opener))) return;
    const ae = document.activeElement;
    if (ae && m.contains(ae) && ae.matches('input, textarea')) { if (m._opener.isConnected) placeMenu(m, m._opener); return; }
    closeMenu(!!(ae && m.contains(ae)));
  }, { capture: true, passive: true });
}

// ------------------------------------------------------------ confirm dialog (#confirm)
/**
 * Ask before a destructive action. Resolves { ok, password? }.
 * Extension: `onConfirm(password)` may be async; returning a string keeps the dialog open and shows it in
 * #confirm-err (e.g. a wrong password); returning anything else closes it and resolves { ok: true, … }.
 */
export function confirmDialog({ title, body, ok = 'Delete', danger = true, password = false, onConfirm } = {}) {
  const d = document.getElementById('confirm');
  if (!d) return Promise.resolve({ ok: typeof window !== 'undefined' && window.confirm(`${title}\n\n${body || ''}`) });
  if (d.dataset.busy) return Promise.resolve({ ok: false, busy: true }); // the open one is waiting on serve.py: its answer decides
  if (d._settle) d._settle({ ok: false }); // a previous confirm still open: cancel it
  const form = document.getElementById('confirm-form');
  const btn = document.getElementById('confirm-ok');
  const pwRow = document.getElementById('confirm-pw-row');
  const pw = document.getElementById('confirm-pw');
  const err = document.getElementById('confirm-err');
  document.getElementById('confirm-title').textContent = title || '';
  document.getElementById('confirm-body').textContent = body || '';
  btn.textContent = ok;
  btn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  btn.disabled = false;
  pwRow.hidden = !password;
  pw.value = ''; pw.removeAttribute('aria-invalid');
  pwRow.querySelector('.frow')?.classList.remove('bad');
  err.hidden = true; err.textContent = '';

  return new Promise(resolve => {
    let done = false;
    const settle = res => {
      if (done) return; done = true;
      d._settle = null;
      form.removeEventListener('submit', onSubmit);
      d.removeEventListener('close', onDlgClose);
      pw.removeEventListener('input', onInput);
      pw.value = '';
      resolve(res);
    };
    d._settle = settle;
    const showErr = msg => {
      err.innerHTML = `${icon('info')}<span>${escapeText(msg)}</span>`;
      err.hidden = false;
      if (password) {
        const row = pw.closest('.frow');
        row?.classList.remove('bad'); void row?.offsetWidth; row?.classList.add('bad');
        pw.setAttribute('aria-invalid', 'true');
        pw.focus(); pw.select();
      }
    };
    const onInput = () => { err.hidden = true; pw.removeAttribute('aria-invalid'); pw.closest('.frow')?.classList.remove('bad'); };
    // closed while onConfirm is still waiting (Chrome closes on a second Esc even when cancel is prevented):
    // open it again; the promise settles with onConfirm's real answer, never a guessed { ok: false }
    const onDlgClose = () => {
      if (d.dataset.busy) { if (!d.open) { try { d.showModal(); } catch (x) { console.error(x); } } return; }
      settle({ ok: false });
    };
    const onSubmit = async e => {
      e.preventDefault();
      if (btn.disabled) return;
      const value = password ? pw.value : undefined;
      if (password && !value) { showErr('Enter your password.'); return; }
      if (typeof onConfirm === 'function') {
        const label = btn.textContent;
        btn.disabled = true; d.dataset.busy = '1';
        let r;
        try { r = await onConfirm(value); } catch (x) { console.error(x); r = 'Something went wrong. Try again.'; }
        btn.disabled = false; btn.textContent = label; delete d.dataset.busy;
        if (done) return;
        if (typeof r === 'string') { showErr(r); return; }
        settle({ ok: true, password: value, value: r });
        closeDialog(d);
        return;
      }
      settle({ ok: true, password: value });
      closeDialog(d);
    };
    form.addEventListener('submit', onSubmit);
    d.addEventListener('close', onDlgClose);
    pw.addEventListener('input', onInput);
    showDialog(d);
    setTimeout(() => { if (!done) (password ? pw : d.querySelector('[data-close]'))?.focus(); }, 30);
  });
}
const escapeText = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// ------------------------------------------------------------ time formatting
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86400000;
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Whole calendar days between two dates (local time; DST-safe). */
const dayDiff = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / DAY_MS);

/** 0 → '0 min'; under a minute → 'under 1 min'; under an hour → 'N min'; else 'H h' (+ ' M min'). */
export function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(+sec || 0));
  if (sec === 0) return '0 min';
  if (sec < 60) return 'under 1 min';
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return `${h.toLocaleString()} h${m ? ` ${m} min` : ''}`;
}

/** 'Just now' · 'N min ago' · today '3:04 PM' · 'Yesterday' · weekday within a week · '28 Sep' (+ year). */
export function relTime(t) {
  t = +t; if (!t) return '';
  const now = new Date(), d = new Date(t);
  const diff = now - d;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  const days = dayDiff(now, d);
  if (days <= 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return WEEKDAY[d.getDay()];
  return `${d.getDate()} ${MON[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : ''}`;
}

/** 'YYYY-MM-DD' → 'Today' · 'Yesterday' · weekday within a week · '28 September' (+ year). */
export function dayLabel(dayStr) {
  const m = String(dayStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return String(dayStr || '');
  const d = new Date(+m[1], +m[2] - 1, +m[3]), now = new Date();
  const days = dayDiff(now, d);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return WEEKDAY[d.getDay()];
  return `${d.getDate()} ${MONTH[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : ''}`;
}

/** The client's local calendar day 'YYYY-MM-DD'. */
export function localDay(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** '28 September 2026' (used for "Profile since …"). */
export function longDate(t) {
  const d = new Date(+t); if (!+t || isNaN(d)) return '';
  return `${d.getDate()} ${MONTH[d.getMonth()]} ${d.getFullYear()}`;
}
