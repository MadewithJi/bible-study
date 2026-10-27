// Profiles (profiles-spec §5.1, §5.5–5.7, §5.14): who is studying, sign in / create profile, the profile
// dialog, the account button and menu, and keeping every tab of this browser on the same profile.
// Local email + password profiles on this computer; no email is ever sent.
import { state, api, DRY, lsGet, lsSet, lsDel, lsKey, SCOPE_RX, esc, flushNotes, pendingNotes, flushSavers, pendingSavers, setSaveStatus, broadcast, onBroadcast, setAuthRefresher, SIGN_IN_MSG, setSignInPrompt, hostedMsg, likelyHosted, QUOTA_MSG, DONATE_URL, PAUSE_MSG, signupPaused } from './store.js';
import { icon } from './icons.js';
import { openMenu, closeMenu, confirmDialog, closeDialog, showDialog, longDate, setRadio, radioKeys, placeInd, moveInd } from './ui.js';

let A = null;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const toast = (msg, action) => { try { A?.toast?.(msg, action); } catch (e) { console.error(e); } };

// tracker.js (FE-B) is optional here: a missing or broken module must never break signing in
let trackerMod = null, trackerP = null;
const loadTracker = () => (trackerP || (trackerP = import('./tracker.js').then(m => (trackerMod = m)).catch(e => { console.error('tracker.js failed to load', e); return null; })));

// ------------------------------------------------------------ validation (same rules as serve.py, §3.6)
const EMAIL_RX = /^[^@\s"<>]{1,64}@[a-z0-9.-]{1,189}\.[a-z0-9-]{2,63}$/;
const COMMON = new Set(['password', 'password1', 'password123', 'passw0rd', '12345678', '123456789', '1234567890', '11111111', '00000000', 'qwerty123', 'qwertyuiop', 'abcd1234', 'iloveyou', 'letmein1', 'welcome1', 'admin123', 'trustno1', 'baseball', 'football', 'sunshine', 'princess', 'jesus123', 'jesuschrist', 'godislove', 'blessed1', 'bible123', 'faith123', 'amazinggrace', 'john3:16', 'johnthreesixteen']);
const MSG = {
  email: 'Enter an email address like name@example.com.',
  name: 'Enter your name (up to 60 characters).',
  get offline() { return state.auth.hosted ? 'Can’t reach the server. Check your connection and try again.' : 'Can’t reach serve.py. Is it running?'; },
  dry: 'Dry run: sign-in is turned off.',
  get badLogin() { return hostedMsg('That email and password don’t match a profile on this computer.', 'That email and password don’t match a Bible Lantern profile.'); },
  badPassword: 'That password isn’t right.',
  get stillIn() { return hostedMsg('Can’t reach serve.py, so you’re still signed in.', 'Can’t reach the server, so you’re still signed in.'); },
  get tryLater() { return hostedMsg('Can’t reach serve.py. Try again when it’s running.', 'Can’t reach the server. Try again in a moment.'); },
  taken: 'There’s already a profile for that email.',
  generic: 'Something went wrong. Try again.',
};
const normEmail = s => String(s || '').trim().toLowerCase();
const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
const emailProblem = e => (e.length <= 254 && EMAIL_RX.test(e) ? '' : MSG.email);
const nameProblem = n => (n.length >= 1 && n.length <= 60 ? '' : MSG.name);
function passwordProblem(pw, email) {
  const p = String(pw || '').normalize('NFKC');
  const n = [...p].length;
  if (n < 8) return 'Use at least 8 characters.';
  if (n > 256 || new TextEncoder().encode(p).length > 1024) return 'Use at most 256 characters.';
  if (!p.trim()) return 'Your password can’t be only spaces.';
  const low = p.toLowerCase(), e = normEmail(email);
  if (e && (low === e || low === e.split('@')[0])) return 'Your password can’t be your email address.';
  if (COMMON.has(low)) return 'That password is too common. Try a longer phrase.';
  return '';
}
const secs = n => `${n} ${n === 1 ? 'second' : 'seconds'}`;
const rateMsg = d => `Too many attempts. Try again in ${secs(Math.max(1, Math.round(+(d && d.retryAfter) || 1)))}.`;
/** Avatar monogram: letters and digits only (a name like `Alice "Al" <Tester>` gives AT, never A"). */
const ALNUM = /[\p{L}\p{N}]/u;
function initialsOf(u) {
  const srv = String((u && u.initials) || '');
  if (srv && [...srv].length <= 2 && [...srv].every(ch => ALNUM.test(ch))) return srv.toLocaleUpperCase();
  const firsts = String((u && u.name) || '').normalize('NFC').trim().split(/\s+/).map(w => (w.match(ALNUM) || [''])[0]).filter(Boolean);
  if (firsts.length) return (firsts[0] + (firsts.length > 1 ? firsts[firsts.length - 1] : '')).toLocaleUpperCase();
  const e = String((u && u.email) || '').match(ALNUM);
  return e ? e[0].toLocaleUpperCase() : '?';
}
const firstName = u => String((u && u.name) || '').trim().split(/\s+/)[0] || 'friend';
const plural = (n, w, pl) => `${Number(n).toLocaleString()} ${n === 1 ? w : (pl || w + 's')}`;
const listJoin = parts => parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
/** '12 notes · 3 bookmarks · 2 highlights · reading progress for 5 chapters' (zero parts omitted): the words the import's toast
 *  and the Library's 'Brought over' row use. Chapters = every chapter with any progress, as the import counts them. */
function guestMeta(g) {
  if (!g) return '';
  const chs = +(g.chapters ?? g.chaptersRead) || 0;
  const s = [g.notes ? plural(g.notes, 'note') : '', g.bookmarks ? plural(g.bookmarks, 'bookmark') : '', g.links ? plural(g.links, 'link') : '', g.marks ? plural(g.marks, 'highlight') : '', g.memory ? plural(g.memory, 'memory verse') : '', chs ? `reading progress for ${plural(chs, 'chapter')}` : ''].filter(Boolean).join(' · ');
  return s && s[0].toUpperCase() + s.slice(1);
}

// ------------------------------------------------------------ auth state
/** GET /api/auth/me. Fills state.auth; when serve.py cannot answer, the last scope is used (account UI hidden). */
export async function initAuth() {
  setAuthRefresher(opts => refreshAuth(opts));
  loadTracker();
  // the site is known before its server answers (and while it can't): a guest there never saves to this browser
  if (likelyHosted()) state.auth.hosted = true;
  const r = await api('GET', '/api/auth/me?boot=1', null, { scoped: false }); // boot=1: the server counts one app load
  state.auth.known = true;
  if (r.ok && r.data && typeof r.data.scope === 'string' && 'signedIn' in r.data) {
    applyMe(r.data);
    state.auth.server = true;
    lsSet('bs-last-scope', state.auth.scope);
    return state.auth;
  }
  state.auth.server = false;
  state.auth.hosted = likelyHosted(); // a hosted site's guest stays read-only while the server is away
  const last = lsGet('bs-last-scope', 'guest') || 'guest';
  state.auth.scope = SCOPE_RX.test(last) ? last : 'guest';
  state.auth.signedIn = false; state.auth.user = null; state.auth.session = null;
  return state.auth;
}
function applyMe(me) {
  const a = state.auth;
  a.signedIn = !!(me.signedIn && me.user);
  a.scope = SCOPE_RX.test(String(me.scope || '')) ? me.scope : 'guest';
  a.user = a.signedIn ? me.user : null;
  a.session = a.signedIn ? (me.session || null) : null;
  if (me.guest) a.guest = me.guest;
  if (me.limits) a.limits = me.limits;
  if (me.features) a.features = me.features;
  // hosting brief §2: the mode, its sign-up and the owner (absent from a local serve.py's older answers: local)
  if ('hosted' in me) {
    a.hosted = me.hosted === true;
    if (a.hosted) lsSet('bs-hosted', '1'); else if (lsGet('bs-hosted')) lsDel('bs-hosted');
    a.turnstile = turnstileOf(me); // open-signup brief §2: only a server's answer says whether the check is on
  }
  applySignup(me);
  a.owner = !!(a.hosted && a.signedIn && me.owner === true);
  if (document.getElementById('auth')?.open && !authBusy) syncAvailability();
}
/** auth/me's sign-up ('open' | 'closed') and why it is closed (donate brief §2: signupPause). A change tells Home
 *  (bs:signup-changed), which announces the pause or takes the announcement down without a reload. */
const PAUSES = new Set(['paused', 'storage', 'capacity']);
function applySignup(me) {
  if (!me || (me.signup !== 'open' && me.signup !== 'closed')) return;
  setSignup(me.signup, me.signup === 'closed' && PAUSES.has(me.signupPause) ? me.signupPause : null);
}
function setSignup(mode, pause) {
  const a = state.auth, was = `${a.signupMode} ${a.signupPause}`;
  a.signupMode = mode; a.signupPause = pause;
  if (`${mode} ${pause}` !== was) document.dispatchEvent(new CustomEvent('bs:signup-changed', { detail: { signup: mode, pause } }));
}
/** auth/me's turnstile: {siteKey} while Cloudflare Turnstile guards sign-up, else null. */
function turnstileOf(me) {
  const k = me && me.turnstile && typeof me.turnstile.siteKey === 'string' ? me.turnstile.siteKey.trim() : '';
  return k && k.length <= 200 ? { siteKey: k } : null;
}
const guestMe = () => ({ signedIn: false, scope: 'guest', user: null, session: null, guest: state.auth.guest, limits: state.auth.limits, features: state.auth.features });
async function fetchMe() {
  const r = await api('GET', '/api/auth/me', null, { scoped: false });
  return r.ok && r.data && typeof r.data.scope === 'string' ? r.data : null;
}

/** Send everything this tab still holds for the current scope. Resolves the number of items not yet on the server. */
async function flushAll() {
  let pending = 0;
  const t = trackerMod || await loadTracker();
  if (t && typeof t.flush === 'function') {
    try { const r = await t.flush(); pending += (r && r.pending) || 0; } catch (e) { console.error(e); pending += 0; }
  }
  try { const r = await flushNotes(); pending += (r && r.pending) || 0; } catch (e) { console.error(e); }
  // the other savers (links.js): an edit made just before a sign-in, sign-out or import must not wait in the old scope's queue
  try { pending += (await flushSavers()).pending || 0; } catch (e) { console.error(e); }
  return pending;
}

/**
 * Move this tab to another scope. The server side has already changed (sign in, sign out, delete, another
 * tab), so nothing is flushed here: callers flush before their POST. Unsent data of the old scope stays under
 * that scope's storage keys and is sent the next time it signs in.
 */
function switchScope(me, reason) {
  const prevScope = state.auth.scope;
  applyMe(me);
  state.auth.lost = false;
  lsSet('bs-last-scope', state.auth.scope);
  closeMenu(false);
  // the Profile dialog belongs to the profile that was signed in: never leave its name, email and actions up
  const pd = document.getElementById('profile'); if (pd?.open && state.auth.scope !== prevScope) closeDialog(pd);
  // ...nor a destructive confirm (or the profile's password confirm) asked for the old profile; one already waiting on serve.py decides itself
  const cf = document.getElementById('confirm'); if (cf?.open && state.auth.scope !== prevScope && !cf.dataset.busy) { cf._settle?.({ ok: false }); closeDialog(cf); }
  renderAccountButton();
  try { trackerMod?.setScope?.(state.auth.scope); } catch (e) { console.error(e); }
  document.dispatchEvent(new CustomEvent('bs:auth-changed', { detail: { user: state.auth.user, scope: state.auth.scope, prevScope, reason } }));
  broadcast({ t: 'auth', scope: state.auth.scope });
}
/** The same profile signed in again after its session was lost: resume saving. */
function resumeAfterLost(me) {
  applyMe(me);
  state.auth.lost = false;
  renderAccountButton();
  try { trackerMod?.setScope?.(state.auth.scope); } catch (e) { console.error(e); }
  flushAll();
  broadcast({ t: 'auth', scope: state.auth.scope });
}

/**
 * Re-read /api/auth/me. Another scope → switch to it (toast unless quiet). Same scope → refresh the
 * user (a rename) and leave a lost state if that profile is signed in again.
 */
export async function refreshAuth({ reason = 'remote', quiet = false } = {}) {
  const me = await fetchMe();
  if (!me) return { changed: false, me: null };
  if (!state.auth.server) { state.auth.server = true; }
  if (me.scope === state.auth.scope) {
    const before = whoKey(state.auth.user);
    if (state.auth.lost && me.signedIn) resumeAfterLost(me);
    else { applyMe(me); renderAccountButton(); refreshProfileView(); }
    if (whoKey(state.auth.user) !== before) refreshLibraryName(); // renamed in another window
    return { changed: false, me };
  }
  if (reason === 'drift' && state.auth.signedIn && state.auth.user && !state.auth.lost) {
    // this profile's session ended (expired or revoked): hold its data and ask to sign in again
    markLost(me);
    return { changed: false, me };
  }
  switchScope(me, reason);
  if (!quiet) toast(me.signedIn && me.user ? `Signed in as ${me.user.name} in another window.` : 'Signed out in another window.');
  return { changed: true, me };
}
function markLost(me) {
  state.auth.lost = true;
  if (me && me.guest) state.auth.guest = me.guest;
  const pd = document.getElementById('profile'); if (pd?.open) closeDialog(pd);   // its actions would all fail now
  A?.stopVideo?.();   // a private video of this profile stops with its session
  renderAccountButton();
  if (pendingNotes() + pendingSavers() > 0) setSaveStatus('signedout');   // held edits: the sheet says why, not 'Save failed'
  const u = state.auth.user || {};
  toast(`You’ve been signed out. Sign in to keep saving to ${u.name || 'your profile'}.`, { label: 'Sign in', run: () => openAuth('signin', { email: u.email || '', reason: 'lost' }) });
}

let lostCheck = false;
async function onAuthLost(e) {
  const d = (e && e.detail) || {};
  if (d.error === 'scope_mismatch' && d.scope && d.scope === state.auth.scope) return; // a request sent before this tab switched
  if (state.auth.lost || lostCheck || !state.auth.server) return;
  lostCheck = true;
  try {
    const me = await fetchMe();
    if (!me) return; // cannot tell now; the writes retry later
    if (me.scope === state.auth.scope) { applyMe(me); renderAccountButton(); return; }
    if (state.auth.signedIn && state.auth.user) markLost(me);
    else {
      switchScope(me, 'remote');
      toast(me.signedIn && me.user ? `Signed in as ${me.user.name} in another window.` : 'Signed out in another window.');
    }
  } finally { lostCheck = false; }
}
function onSync(m) {
  if (!m || m.t !== 'auth') return;
  refreshAuth({ reason: 'remote', quiet: m.scope === state.auth.scope });
}

/**
 * Remove what this browser keeps for a profile (after sign-out or delete). Unsent queues stay unless empty, and so
 * does the notes mirror while unsent note edits remain (it holds their text). A delete removes everything.
 */
function forgetLocal(uid, { all = false } = {}) {
  if (!uid || uid === 'guest') return;
  const read = k => { try { return JSON.parse(lsGet(k, 'null')); } catch (e) { return null; } };
  const dirtyLeft = !all && Object.keys((read(lsKey('bs-notes-dirty-v1', uid)) || {}).d || {}).length > 0;
  if (!dirtyLeft) { lsDel(lsKey('bs-notes-v1', uid)); lsDel(lsKey('bs-notes-dirty-v1', uid)); }
  // My links likewise: the mirror holds the text of unsent link edits ('bs-links-dirty-v1' holds only their ids)
  const linksLeft = !all && Object.keys((read(lsKey('bs-links-dirty-v1', uid)) || {}).d || {}).length > 0;
  if (!linksLeft) { lsDel(lsKey('bs-links-v1', uid)); lsDel(lsKey('bs-links-dirty-v1', uid)); }
  // highlights and comments (marks.js) likewise
  const marksLeft = !all && Object.keys((read(lsKey('bs-marks-dirty-v1', uid)) || {}).d || {}).length > 0;
  if (!marksLeft) { lsDel(lsKey('bs-marks-v1', uid)); lsDel(lsKey('bs-marks-dirty-v1', uid)); }
  // memory verses (memory.js) likewise
  const memoryLeft = !all && Object.keys((read(lsKey('bs-memory-dirty-v1', uid)) || {}).d || {}).length > 0;
  if (!memoryLeft) { lsDel(lsKey('bs-memory-v1', uid)); lsDel(lsKey('bs-memory-dirty-v1', uid)); }
  lsDel(lsKey('bs-pos-v1', uid));
  // the event outboxes: the shared key of older versions and one per page ('bs-outbox-v1:<uid>#<page>')
  const base = lsKey('bs-outbox-v1', uid), keys = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k === base || (k && k.startsWith(base + '#'))) keys.push(k); } } catch (e) { /* storage unavailable */ }
  for (const k of keys) { const o = read(k); if (all || !o || (!(o.pending || []).length && !(o.queue || []).length)) lsDel(k); }
}

/** Sign out (or everywhere): send what is unsent first; if that fails, stay signed in. */
export async function signOut({ all = false } = {}) {
  if (DRY) { toast(MSG.dry); return false; }
  if (!state.auth.signedIn) { toast('You’re already signed out.'); return false; }
  const uid = state.auth.scope;
  if (!state.auth.lost) {
    const pending = await flushAll();
    // an edit made while the flush ran is unsent too (pendingSavers: links)
    if (pending > 0 || pendingNotes() + pendingSavers() > 0) { toast(MSG.stillIn); return false; }
  }
  const r = await api('POST', '/api/auth/logout', all ? { all: true } : {}, { scoped: false });
  if (!r.ok) { toast(r.offline ? MSG.stillIn : ((r.data && r.data.message) || 'Couldn’t sign out. Try again.')); return false; }
  if (!state.auth.lost) forgetLocal(uid);
  const me = (await fetchMe()) || guestMe();
  switchScope(me.signedIn ? guestMe() : me, 'signout');
  toast(all ? 'Signed out everywhere. You’re studying as a guest.' : 'Signed out. You’re studying as a guest.');
  return true;
}

// ------------------------------------------------------------ account button and menu (§5.5)
export function initAccountUI(actions) {
  A = actions;
  ['btn-account', 'lib-account'].forEach(id => document.getElementById(id)?.addEventListener('click', e => {
    const b = e.currentTarget;
    if (!state.auth.signedIn) { openAuth('signin'); return; }
    openAccountMenu(b);
  }));
  bindAuthDialog();
  bindProfileDialog();
  setSignInPrompt(promptSignIn);
  document.addEventListener('bs:auth-lost', onAuthLost);
  onBroadcast(onSync);
  renderAccountButton();
}

/** Both account buttons (top bar, Library) show the same state: person icon signed out, initials signed in. */
export function renderAccountButton() {
  const a = state.auth;
  ['btn-account', 'lib-account'].forEach(id => {
    const b = document.getElementById(id); if (!b) return;
    const show = !!(a.known && a.server);
    b.hidden = !show;
    if (!show) return;
    b.classList.toggle('lost', !!(a.signedIn && a.lost));
    if (a.signedIn && a.user) {
      const name = a.user.name || a.user.email || 'Profile';
      const html = `<span class="acct-av" aria-hidden="true">${esc(initialsOf(a.user))}</span>`;
      if (b.innerHTML !== html) b.innerHTML = html;
      b.setAttribute('aria-label', a.lost ? `Signed out of ${name}. Sign in again` : `Profile: ${name}`);
      b.title = a.lost ? `Signed out of ${name}` : `${name} (${a.user.email || ''})`;
      b.setAttribute('aria-haspopup', 'menu');
      if (b.getAttribute('aria-expanded') !== 'true') b.setAttribute('aria-expanded', 'false');
    } else {
      const html = icon('person');
      if (b.innerHTML !== html) b.innerHTML = html;
      b.setAttribute('aria-label', 'Sign in');
      b.title = 'Sign in';
      b.setAttribute('aria-haspopup', 'dialog');
      b.removeAttribute('aria-expanded');
    }
  });
}
/**
 * Hosted, a guest's save (a note, link, highlight, bookmark or read mark) shows this one calm prompt rather than a form
 * that would save nothing (hosting brief §2). Several refused actions in a row keep the toast up rather than replay it.
 */
let promptAt = 0;
function promptSignIn() {
  const t = document.getElementById('toast'), now = Date.now();
  if (now - promptAt < 1500 && t && !t.hidden && !t.classList.contains('out')) return;
  promptAt = now;
  toast(SIGN_IN_MSG, { label: 'Sign in', run: () => openAuth('signin', { reason: 'save' }) });
}
function popButton() {
  const b = document.getElementById('btn-account'); if (!b) return;
  b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
  setTimeout(() => b.classList.remove('pop'), 700);
}

export function openAccountMenu(anchor) {
  const a = state.auth, u = a.user;
  if (!u) { openAuth('signin'); return; }
  const head = `<div class="acct-head" role="presentation"><span class="acct-av lg" aria-hidden="true">${esc(initialsOf(u))}</span><span><b>${esc(u.name)}</b><small>${esc(a.lost ? 'Signed out' : u.email)}</small></span></div><hr>`;
  const items = a.lost
    ? `<button type="button" role="menuitem" data-acct="signin">Sign in again${icon('person')}</button><button type="button" role="menuitem" data-acct="guest">Continue as a guest${icon('signout')}</button>`
    : `<button type="button" role="menuitem" data-acct="library">Library${icon('library')}</button><button type="button" role="menuitem" data-acct="profile">Profile and data${icon('person')}</button><hr><button type="button" role="menuitem" data-acct="signout">Sign out${icon('signout')}</button>`;
  openMenu(anchor, head + items, {
    label: 'Profile', className: 'acct-menu',
    onClick: e => {
      const it = e.target.closest('[data-acct]'); if (!it) return;
      const what = it.dataset.acct;
      closeMenu(true); // focus back on the button, so a dialog opened next returns there
      if (what === 'library') { if (!document.getElementById('library')?.open) A?.openLibrary?.(); }
      else if (what === 'profile') openProfile();
      else if (what === 'signout') signOut();
      else if (what === 'signin') openAuth('signin', { email: u.email, reason: 'lost' });
      else if (what === 'guest') continueAsGuest();
    },
  });
}
async function continueAsGuest() {
  const me = await fetchMe();
  switchScope(me && !me.signedIn ? me : guestMe(), 'signout');
  toast('You’re studying as a guest.');
}

// ------------------------------------------------------------ sign in / create profile (§5.6)
let authMode = 'signin', authReason = '', authBusy = false;
let authSeq = 0; // each opening of the dialog: a sign-up still waiting for its Turnstile token belongs to an older one

export function openAuth(mode = 'signin', { email = '', reason = '' } = {}) {
  const d = document.getElementById('auth'); if (!d) return;
  authSeq++;
  closeMenu(false);
  authReason = reason || '';
  const form = document.getElementById('auth-form');
  $$('input', form).forEach(i => { if (i.type === 'checkbox') return; i.value = ''; i.removeAttribute('aria-invalid'); });
  $('#auth-remember').checked = true;
  $('#auth-import').checked = true;
  showPassword(false);
  clearErrors();
  $('#auth-email').value = email || '';
  const u = state.auth.user;
  $('#auth-lede').textContent = reason === 'lost' && u
    ? `You’ve been signed out. Sign in to keep saving to ${u.name}.`
    : reason === 'save' ? SIGN_IN_MSG
    : state.auth.hosted ? 'Your notes, bookmarks, highlights and reading progress, saved to your profile on this site.'
    : 'Your notes, bookmarks, highlights and reading progress, saved to a profile on this computer.';
  syncAuthCopy();
  setMode(mode);
  syncAvailability();
  showDialog(d);
  placeInd($('#auth-mode'));
  tsShow();
  setTimeout(() => focusFirst(), 40);
  // the guest summary (for "Bring over guest data") and what serve.py allows may be older than this visit: refresh
  if (state.auth.server && !state.auth.signedIn) fetchMe().then(me => {
    if (!me || me.signedIn || !d.open) return;
    state.auth.guest = me.guest || state.auth.guest;
    if (me.features) state.auth.features = me.features;
    const was = `${state.auth.signupMode} ${tsKey()}`;
    applySignup(me);
    if ('hosted' in me) state.auth.turnstile = turnstileOf(me);
    syncImportRow();
    if (!authBusy) {
      syncAvailability({ force: true });
      if (authMode === 'signup' && was !== `${state.auth.signupMode} ${tsKey()}`) { setMode('signup'); focusFirst(); } // paused or reopened meanwhile
      moveInd($('#auth-mode'));
    }
  });
}
/** A hosted site words two lines differently: no Terminal to reset a password, and nothing is 'on this computer'. */
let authCopy = null; // the local wording, to put back
function syncAuthCopy() {
  const help = $('#auth-pw-help'), foot = $('#auth .auth-foot'); if (!help || !foot) return;
  if (!authCopy) authCopy = { help: help.innerHTML, foot: foot.innerHTML };
  const h = state.auth.hosted;
  const help2 = h ? 'At least 8 characters. Stored only as a secure hash.' : authCopy.help;
  const foot2 = h ? 'Forgot your password? Ask the owner of this site to reset it.' : authCopy.foot;
  if (help.innerHTML !== help2) help.innerHTML = help2;
  if (foot.innerHTML !== foot2) foot.innerHTML = foot2;
}
/** Sign-up paused (BS_SIGNUP=closed, the free-space guard or the profile cap: donate brief §2): the Create profile tab
 *  says so, with Home's words and Help us expand, instead of showing the form. */
const signupClosed = () => state.auth.signupMode === 'closed';
const closedHtml = () => `${icon('info')}<div class="ac-in"><p class="ac-t">${esc(PAUSE_MSG.title)}</p><p>${esc(PAUSE_MSG.body)}</p>`
  + `<a class="btn btn-tinted sm ac-go" href="${DONATE_URL}" target="_blank" rel="noopener">${esc(PAUSE_MSG.cta)}${icon('external')}</a></div>`;
function syncImportRow() {
  const g = state.auth.guest, row = $('#auth-import-row'); if (!row) return;
  row.hidden = !(authMode === 'signup' && g && g.hasData);
  const meta = $('#auth-import-meta'); if (meta) meta.textContent = guestMeta(g) || 'Your reading history in this browser';
}
function focusFirst() {
  const up = authMode === 'signup';
  const name = $('#auth-name'), email = $('#auth-email'), pw = $('#auth-password');
  // creating a profile starts at Name (what Home's 'Create a profile' is about); paused, the note that says so is read
  const el = up ? (signupClosed() ? $('#auth-closed') : !name.value ? name : !email.value ? email : pw) : (!email.value ? email : pw);
  el?.focus();
}
/** features.signup false (profile limit reached) or features.profiles false (users.json unavailable). On the site a
 *  full house is a pause like the others: the tab stays, and says why (signupClosed). */
const signupOff = () => { const f = state.auth.features || {}; return f.profiles === false || (f.signup === false && !signupPaused()); };
const profilesOff = () => (state.auth.features || {}).profiles === false;
/**
 * Keep #auth in step with what serve.py allows: the Create profile segment is disabled (and #auth-off says why)
 * when signup is off, and the submit button too while profiles are unavailable. `force` moves a dialog that
 * is in signup mode back to sign in (not done right after a refused submit, so its error stays readable).
 */
function syncAvailability({ force = false } = {}) {
  const off = signupOff(), none = profilesOff();
  const seg = $('#auth-mode [data-mode="signup"]');
  if (seg) {
    seg.disabled = off;
    if (off) { seg.setAttribute('aria-disabled', 'true'); seg.title = hostedMsg('New profiles can’t be created on this computer right now', 'New profiles can’t be created on this site right now'); }
    else { seg.removeAttribute('aria-disabled'); seg.removeAttribute('title'); }
  }
  const note = $('#auth-off');
  if (note) {
    const msg = none ? hostedMsg('Profiles are unavailable right now: users.json in the data folder is missing or damaged. Restore it from users.json.bak (see README), then try again.', 'Profiles are unavailable right now. Try again later.')
      : off ? hostedMsg('This computer already has the maximum number of profiles, so a new one can’t be created. You can still sign in.', 'This site has reached its profile limit, so a new one can’t be created. You can still sign in.') : '';
    note.hidden = !msg;
    const html = msg ? `${icon('info')}<span>${esc(msg)}</span>` : '';
    if (note.innerHTML !== html) note.innerHTML = html;
  }
  const btn = $('#auth-submit'); if (btn && !authBusy) btn.disabled = none;
  if (force && off && authMode === 'signup') setMode('signin');
}
function setMode(mode) {
  authMode = mode === 'signup' && !signupOff() ? 'signup' : 'signin';
  const up = authMode === 'signup';
  $$('#auth [data-only]').forEach(el => { el.hidden = el.dataset.only !== authMode; });
  // sign-up paused: the Create profile tab shows why instead of the form, and Sign in works as ever
  const closed = up && signupClosed(), note = $('#auth-closed');
  $('#auth-form').classList.toggle('closed', closed);
  if (note) { note.hidden = !closed; const html = closed ? closedHtml() : ''; if (note.innerHTML !== html) note.innerHTML = html; }
  $('#auth-submit').hidden = closed;
  syncImportRow();
  $('#auth-title').textContent = up ? 'Create profile' : 'Sign in';
  if (!authBusy) $('#auth-submit').textContent = up ? 'Create profile' : 'Sign in';
  $('#auth-password').setAttribute('autocomplete', up ? 'new-password' : 'current-password');
  // the new-password rule describes the field only when making a profile (a hidden node would still be read out)
  if (up) $('#auth-password').setAttribute('aria-describedby', 'auth-pw-help'); else $('#auth-password').removeAttribute('aria-describedby');
  setRadio($('#auth-mode'), b => b.dataset.mode === authMode);
  clearErrors();
  if (document.getElementById('auth')?.open) tsShow(); // on opening, openAuth shows it once the dialog is up
}
function showPassword(on) {
  const pw = $('#auth-password'), eye = $('#auth-pw-eye'); if (!pw || !eye) return;
  pw.type = on ? 'text' : 'password';
  // one name, 'Show password'; aria-pressed says whether it is shown (a name that flips to 'Hide password' while
  // pressed reads as 'Hide password, pressed'). Only the icon changes.
  eye.setAttribute('aria-pressed', String(on));
  eye.setAttribute('aria-label', 'Show password');
  eye.title = 'Show password';
  eye.querySelector('use')?.setAttribute('href', on ? '#i-eye-slash' : '#i-eye');
}
function clearErrors(root = document.getElementById('auth'), errId = 'auth-err') {
  const err = document.getElementById(errId); if (err) { err.hidden = true; err.textContent = ''; }
  if (errId === 'auth-err') { const te = $('#auth-ts-err'); if (te) { te.hidden = true; te.textContent = ''; } } // the line above the button
  if (root) $$('.frow.bad', root).forEach(r => r.classList.remove('bad'));
  if (root) $$('[aria-invalid]', root).forEach(i => i.removeAttribute('aria-invalid'));
}
function showErr(errId, msg, extraHtml = '') {
  const el = document.getElementById(errId); if (!el) return;
  el.innerHTML = `${icon('info')}<span>${esc(msg)}${extraHtml ? ' ' + extraHtml : ''}</span>`;
  el.hidden = false;
}
function fieldErr(errId, inputId, msg, extraHtml = '') {
  showErr(errId, msg, extraHtml);
  const input = document.getElementById(inputId), row = input && input.closest('.frow');
  if (row) { row.classList.remove('bad'); void row.offsetWidth; row.classList.add('bad'); }
  if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); if (input.select && input.type !== 'checkbox') input.select(); }
}

function bindAuthDialog() {
  const d = document.getElementById('auth'), form = document.getElementById('auth-form'), seg = $('#auth-mode');
  if (!d || !form) return;
  seg?.addEventListener('click', e => {
    const b = e.target.closest('[data-mode]');
    if (b && b.dataset.mode !== authMode) { setMode(b.dataset.mode); focusFirst(); }
  });
  seg?.addEventListener('keydown', e => radioKeys(e, seg, b => setMode(b.dataset.mode)));
  if (seg && 'ResizeObserver' in window) new ResizeObserver(() => moveInd(seg)).observe(seg);
  $('#auth-pw-eye')?.addEventListener('click', () => { showPassword($('#auth-password').type === 'password'); $('#auth-password').focus(); });
  form.addEventListener('input', e => {
    const row = e.target.closest && e.target.closest('.frow');
    if (row && row.classList.contains('bad')) row.classList.remove('bad');
    e.target.removeAttribute?.('aria-invalid');
    const err = $('#auth-err'); if (err && !err.hidden) err.hidden = true;
    const te = $('#auth-ts-err'); if (te && !te.hidden && !te.classList.contains('calm')) te.hidden = true; // a pending check's prompt stays
  });
  $('#auth-err')?.addEventListener('click', e => {
    const sw = e.target.closest('[data-auth-switch]'); if (!sw) return;
    setMode(sw.dataset.authSwitch);
    $('#auth-password').focus();
  });
  form.addEventListener('submit', onAuthSubmit);
}

async function onAuthSubmit(e) {
  e.preventDefault();
  if (authBusy) return;
  clearErrors();
  const up = authMode === 'signup';
  if (up && signupClosed()) return; // the form isn't shown
  const name = cleanName($('#auth-name').value), email = normEmail($('#auth-email').value), pw = $('#auth-password').value;
  if (up && nameProblem(name)) return fieldErr('auth-err', 'auth-name', nameProblem(name));
  if (emailProblem(email)) return fieldErr('auth-err', 'auth-email', emailProblem(email));
  if (up) { const p = passwordProblem(pw, email); if (p) return fieldErr('auth-err', 'auth-password', p); }
  else if (!pw) return fieldErr('auth-err', 'auth-password', 'Enter your password.');
  if (DRY) return showErr('auth-err', MSG.dry);
  if (!state.auth.server) return showErr('auth-err', MSG.offline);

  const remember = !!$('#auth-remember').checked;
  const importGuest = up && !$('#auth-import-row').hidden && !!$('#auth-import').checked;
  const btn = $('#auth-submit'), dlg = document.getElementById('auth');
  authBusy = true; btn.disabled = true;
  try {
    // Turnstile (open-signup brief §2): its token first, usually ready long before; Esc still closes while it comes
    let turnstileToken = '';
    if (up && tsOn()) {
      btn.textContent = 'Checking…';
      const seq = authSeq;
      turnstileToken = await tsToken();
      if (!dlg.open || authMode !== 'signup' || seq !== authSeq) return; // closed (or reopened), or Sign in chosen, meanwhile
      if (!turnstileToken) { tsMissing(); return; }
    }
    // data-busy: Esc and the backdrop leave the dialog open until serve.py answers (main.js bindDialogs)
    btn.textContent = up ? 'Creating…' : 'Signing in…'; dlg.dataset.busy = '1';
    if (!state.auth.lost) await flushAll(); // guest data is current before an import
    const r = up
      ? await api('POST', '/api/auth/signup', { email, name, password: pw, remember, importGuest, ...(turnstileToken ? { turnstileToken } : {}) }, { scoped: false })
      : await api('POST', '/api/auth/login', { email, password: pw, remember }, { scoped: false });
    if (turnstileToken) tsReset(); // a token is good for one sign-up, whatever the answer
    if (!r.ok) { delete dlg.dataset.busy; authError(r); return; }
    $('#auth-password').value = '';
    const user = (r.data && r.data.user) || {};
    const me = (await fetchMe()) || { signedIn: true, scope: user.uid, user, session: r.data.session, guest: state.auth.guest, limits: state.auth.limits, features: state.auth.features };
    delete dlg.dataset.busy;
    closeDialog(dlg);
    const who = me.user || user;
    if (state.auth.lost && me.scope === state.auth.scope) {
      resumeAfterLost(me);
      toast(`Signed in as ${who.name}. Your changes are being saved.`);
    } else {
      switchScope(me, up ? 'signup' : 'signin');
      if (up) {
        const im = r.data && r.data.imported;
        const parts = im ? [im.notes ? plural(im.notes, 'note') : '', im.bookmarks ? plural(im.bookmarks, 'bookmark') : '', im.links ? plural(im.links, 'link') : '', im.marks ? plural(im.marks, 'highlight') : '', im.memory ? plural(im.memory, 'memory verse') : '', im.chapters ? `reading progress for ${plural(im.chapters, 'chapter')}` : ''].filter(Boolean) : [];
        toast(`Welcome, ${firstName(who)}. Your profile is ready.${parts.length ? ` Brought over ${listJoin(parts)}.` : ''}`);
      } else toast(`Signed in as ${who.name}.`);
    }
    popButton();
  } finally {
    authBusy = false; btn.disabled = false; delete dlg.dataset.busy;
    btn.textContent = authMode === 'signup' ? 'Create profile' : 'Sign in';
    syncAvailability();
  }
}
const PAUSED_BY = { signup_closed: 'paused', storage_full: 'storage', user_limit: 'capacity' };
/** After a refused sign-up: auth/me says whether (and why) sign-up is closed now; an open dialog follows it. */
function recheckSignup() {
  if (!state.auth.server) return;
  fetchMe().then(me => {
    if (!me || me.signedIn || state.auth.signedIn) return;
    const was = state.auth.signupMode;
    if (me.features) state.auth.features = me.features;
    applySignup(me);
    const d = document.getElementById('auth');
    if (d?.open && !authBusy && authMode === 'signup' && state.auth.signupMode !== was) { setMode('signup'); focusFirst(); }
    if (d?.open && !authBusy) syncAvailability();
  });
}
function authError(r) {
  const d = r.data || {};
  if (r.offline || !r.status) return showErr('auth-err', MSG.offline);
  // the server's answer is newer than the features from /api/auth/me: the dialog shows it from now on
  if (d.error === 'user_limit') state.auth.features = { ...(state.auth.features || {}), signup: false };
  else if (d.error === 'registry_unavailable' && !d.field) state.auth.features = { ...(state.auth.features || {}), signup: false, profiles: false };
  const field = { email: 'auth-email', name: 'auth-name', password: 'auth-password' }[d.field];
  // donate brief §2: paused since the dialog opened (the switch, the free-space guard or, on the site, the profile cap):
  // the tab says so instead of the form, and auth/me is read again so Home announces it too
  const pause = PAUSED_BY[d.error];
  if (pause && (d.error !== 'user_limit' || state.auth.hosted)) {
    setSignup('closed', pause); setMode('signup'); $('#auth-closed')?.focus();
    recheckSignup();
    return undefined;
  }
  switch (d.error) {
    // open-signup brief §2: the check, on the line just above Create profile
    case 'bot_check_failed': return tsNote(d.message || TS_MSG.failed);
    case 'bot_check_unavailable': return tsNote(d.message || TS_MSG.unavailable);
    case 'quota_exceeded': return tsNote(d.message || QUOTA_MSG);
    case 'bad_credentials': return fieldErr('auth-err', 'auth-password', MSG.badLogin);
    case 'email_taken': return fieldErr('auth-err', 'auth-email', MSG.taken, '<button class="link" type="button" data-auth-switch="signin">Sign in instead</button>');
    case 'rate_limited': return showErr('auth-err', rateMsg(d));
    case 'invalid_email': case 'invalid_name': case 'weak_password':
      return field ? fieldErr('auth-err', field, d.message || MSG.generic) : showErr('auth-err', d.message || MSG.generic);
    default:
      if (field && d.message) return fieldErr('auth-err', field, d.message);
      return showErr('auth-err', d.message || MSG.generic);
  }
}

// ------------------------------------------------------------ Cloudflare Turnstile on sign-up (open-signup brief §2)
// On while serve.py has its keys (auth/me turnstile.siteKey). Cloudflare's script loads the first time the sign-up form
// is shown; the widget asks for interaction only when it needs it, so most people never see it.
const TS_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TS_WAIT = 10000; // how long Create profile waits for a token before it asks for the check
const TS_MSG = {
  load: 'The sign-up check couldn’t load. Check your connection and try again.',
  failed: 'We couldn’t confirm you’re not a bot. Try the check again.',
  unavailable: 'The sign-up check is unavailable right now. Try again in a minute.',
  solve: 'Complete the check above to create your profile.',
};
const ts = { p: null, id: null, key: '', theme: '', token: '', err: '', interactive: false, after: false, waiters: [] };
const tsKey = () => (state.auth.turnstile && state.auth.turnstile.siteKey) || '';
const tsOn = () => !!tsKey() && !DRY;
/** Cloudflare's api.js, once (a failed load is tried again the next time the form is shown). */
function tsLoad() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!ts.p) {
    ts.p = new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = TS_SRC; sc.async = true; sc.defer = true;
      sc.onload = () => (window.turnstile ? res(window.turnstile) : rej(new Error('Turnstile did not start')));
      sc.onerror = () => { sc.remove(); rej(new Error('Turnstile failed to load')); };
      document.head.appendChild(sc);
    }).catch(e => { ts.p = null; throw e; });
  }
  return ts.p;
}
/** The sign-up form is showing: the check's box follows it, and the widget is rendered there (again for a new theme). */
function tsShow() {
  const box = $('#auth-turnstile'); if (!box) return;
  const on = tsOn() && authMode === 'signup' && !signupClosed();
  box.hidden = !on;
  if (!on) return;
  tsLoad().then(t => { if (!box.hidden) tsRender(t, box); }).catch(e => {
    console.error(e);
    ts.err = 'load'; tsWake();
    if (!box.hidden && !authBusy) tsNote(TS_MSG.load);
  });
}
function tsRender(t, box) {
  const theme = ['light', 'dark'].includes(state.theme) ? state.theme : 'auto';
  if (ts.id !== null && ts.theme === theme && ts.key === tsKey() && box.childElementCount) return;
  if (ts.id !== null) { try { t.remove(ts.id); } catch (e) { console.error(e); } }
  Object.assign(ts, { id: null, key: tsKey(), theme, token: '', err: '', interactive: false });
  box.classList.remove('shown');
  try {
    ts.id = t.render(box, {
      sitekey: ts.key, action: 'signup', theme, appearance: 'interaction-only', size: 'flexible',
      callback: tok => {
        ts.token = String(tok || ''); ts.err = ''; tsWake();
        const te = $('#auth-ts-err'); if (te && te.classList.contains('calm')) te.hidden = true;
        // Create profile was waiting on this challenge: carry on with it
        const d = document.getElementById('auth'), f = document.getElementById('auth-form');
        if (ts.after && ts.token && d?.open && authMode === 'signup' && !authBusy) { ts.after = false; f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event('submit', { cancelable: true })); }
      },
      'expired-callback': () => { ts.token = ''; },
      'timeout-callback': () => { ts.token = ''; },
      'error-callback': code => { ts.token = ''; ts.err = String(code || 'error'); tsWake(); return true; },
      'before-interactive-callback': () => { ts.interactive = true; box.classList.add('shown'); tsWake(); },
    });
  } catch (e) { console.error(e); ts.id = null; ts.err = 'load'; tsWake(); }
}
/** Wake whoever waits for a token (it came, the check failed, or it needs the person). */
function tsWake() { ts.waiters.slice().forEach(f => f()); }
/** The token for this sign-up: at once when the widget has one, else when it comes, up to 10 s ('' when none did). */
function tsToken() {
  if (ts.err) tsReset(); // a failed check tries again
  tsShow();
  if (ts.token) return Promise.resolve(ts.token);
  return new Promise(res => {
    const done = () => { clearTimeout(timer); ts.waiters = ts.waiters.filter(f => f !== done); res(ts.token); };
    const timer = setTimeout(done, TS_WAIT);
    ts.waiters.push(done);
    if (ts.interactive) done(); // a challenge is up already: no point in waiting
  });
}
/** No token came: say what the person can do. A challenge on show finishes the sign-up when it is solved. */
function tsMissing() {
  if (ts.err === 'load') return tsNote(TS_MSG.load);
  if (ts.interactive && !ts.err) { ts.after = true; return tsNote(TS_MSG.solve, true); }
  tsReset();
  return tsNote(TS_MSG.failed);
}
/** Tokens are single-use: after each sign-up attempt (and a failed check) the widget starts over. */
function tsReset() {
  Object.assign(ts, { token: '', err: '', interactive: false, after: false });
  $('#auth-turnstile')?.classList.remove('shown');
  if (ts.id !== null && window.turnstile) { try { window.turnstile.reset(ts.id); } catch (e) { console.error(e); } }
}
/** The line just above Create profile; `calm` for a prompt rather than an error. */
function tsNote(msg, calm = false) {
  const el = $('#auth-ts-err'); if (!el) return;
  showErr('auth-ts-err', msg);
  el.classList.toggle('calm', calm);
  el.scrollIntoView?.({ block: 'nearest' });
}

// ------------------------------------------------------------ profile dialog (§5.7)
// donate brief §1: the permanent donation link, one quiet row (Settings has the same one, in index.html)
const GIVE_ROW = `<a class="cell give" href="${DONATE_URL}" target="_blank" rel="noopener"><span class="tile-i red">${icon('heart')}</span><span class="cell-body"><span class="cell-title">Support Bible Lantern</span><span class="cell-sub">Free to read and study. Gifts keep it running and help it reach more people.</span></span><span class="cell-trail">${icon('external')}</span></a>`;
export function openProfile() {
  const d = document.getElementById('profile'); if (!d) return;
  if (!state.auth.signedIn || !state.auth.user) { openAuth('signin'); return; }
  closeMenu(false);
  renderProfile();
  showDialog(d);
}
function renderProfile() {
  const body = document.getElementById('profile-body'); if (!body) return;
  const a = state.auth, u = a.user; if (!u) return;
  const g = a.guest || {};
  const gm = guestMeta(g);
  const importRow = g.hasData ? `<li id="prof-import-row"><button class="cell" type="button" data-prof="import-guest"><span class="tile-i gold">${icon('import')}</span><span class="cell-body"><span class="cell-title">Bring over guest data</span><span class="cell-sub" id="prof-import-meta">${esc(gm || 'Reading progress')} from the guest space</span></span></button></li>` : '';
  const since = longDate(u.created);
  // hosting brief §2: a profile file from 'Export profile' (another computer, or before the site) merges into this one
  const fileRow = `<li><button class="cell" type="button" data-prof="import-file"><span class="tile-i green">${icon('import')}</span><span class="cell-body"><span class="cell-title">Import profile file</span><span class="cell-sub">Merge a file saved with Export profile into this profile</span></span></button><input type="file" id="prof-import-file" accept="application/json,.json" hidden tabindex="-1"></li>`;
  body.innerHTML = `<div class="prof-hero"><span class="acct-av xl" aria-hidden="true">${esc(initialsOf(u))}</span><div><b id="prof-name">${esc(u.name)}</b><small id="prof-email">${esc(u.email)}</small>${since ? `<small>Profile since ${esc(since)}</small>` : ''}</div></div>
<p class="form-err" id="prof-err" role="alert" hidden></p>
<h3 class="group-h">Profile</h3>
<ul class="group frows prof-fields">
  <li class="frow"><label for="prof-name-in">Name</label><input id="prof-name-in" autocomplete="name" maxlength="60" spellcheck="false"></li>
  <li class="frow"><label for="prof-email-in">Email</label><input id="prof-email-in" type="email" autocomplete="username" inputmode="email" autocapitalize="off" spellcheck="false" maxlength="254"></li>
  <li class="frow" id="prof-email-pw-row" hidden><label for="prof-email-pw">Password</label><input id="prof-email-pw" type="password" autocomplete="current-password" maxlength="256"></li>
</ul>
<p class="group-foot" id="prof-email-help" hidden>Enter your password to change your email.</p>
<div class="actions"><button type="button" class="btn btn-tinted sm" data-prof="save">Save changes</button></div>
<h3 class="group-h">Password</h3>
<ul class="group frows prof-fields">
  <li class="frow"><label for="prof-pw-cur">Current</label><input id="prof-pw-cur" type="password" autocomplete="current-password" maxlength="256"></li>
  <li class="frow"><label for="prof-pw-new">New</label><input id="prof-pw-new" type="password" autocomplete="new-password" maxlength="256" aria-describedby="prof-pw-help"></li>
</ul>
<p class="group-foot" id="prof-pw-help">At least 8 characters. Other browsers and devices will be signed out.</p>
<div class="actions"><button type="button" class="btn btn-tinted sm" data-prof="password">Change password</button></div>
<h3 class="group-h">Your data</h3>
<ul class="group av">
  <li><button class="cell" type="button" data-prof="export"><span class="tile-i blue">${icon('export')}</span><span class="cell-body"><span class="cell-title">Export profile</span><span class="cell-sub">Notes, bookmarks, links, highlights and progress as JSON</span></span></button></li>
  <li><button class="cell" type="button" data-prof="obsidian"><span class="tile-i indigo">${icon('export')}</span><span class="cell-body"><span class="cell-title">Export notes for Obsidian</span><span class="cell-sub">Markdown with [[John 3.16|John 3:16]] links</span></span></button></li>
  ${importRow}
  ${fileRow}
</ul>
${a.hosted && a.owner ? trafficHtml() : ''}
<h3 class="group-h">Bible Lantern</h3>
<ul class="group av"><li>${GIVE_ROW}</li></ul>
<h3 class="group-h">Sessions</h3>
<ul class="group"><li><button class="cell" type="button" data-prof="signout-all"><span class="cell-body"><span class="cell-title">Sign out everywhere</span><span class="cell-sub">${a.hosted ? 'Every browser and device signed in to this profile' : 'Every window and browser on this computer'}</span></span></button></li></ul>
<ul class="group prof-danger"><li><button class="cell danger" type="button" data-prof="delete"><span class="cell-body"><span class="cell-title">Delete profile…</span></span></button></li></ul>`;
  $('#prof-name-in').value = u.name || '';
  $('#prof-email-in').value = u.email || '';
  profShown = { name: u.name || '', email: u.email || '' };
  if (a.hosted && a.owner) loadTraffic();
}
/** The name and email the fields were last filled with: a field still holding them has not been edited. */
let profShown = { name: '', email: '' };
/** Keep an open profile dialog in step with a rename in another tab. */
function refreshProfileView() {
  const d = document.getElementById('profile'); const u = state.auth.user;
  if (!d || !d.open || !u) return;
  const n = $('#prof-name'), m = $('#prof-email');
  if (n) n.textContent = u.name; if (m) m.textContent = u.email;
  const av = $('#profile-body .acct-av'); if (av) av.textContent = initialsOf(u);
  // unedited fields follow too: else 'Save changes' would send the old name or email back as a change
  const ni = $('#prof-name-in'), ei = $('#prof-email-in');
  if (ni && ni.value === profShown.name) ni.value = u.name || '';
  if (ei && normEmail(ei.value) === normEmail(profShown.email)) {
    ei.value = u.email || '';
    $('#prof-email-pw-row').hidden = true; $('#prof-email-help').hidden = true; $('#prof-email-pw').value = '';
  }
  profShown = { name: u.name || '', email: u.email || '' };
}
/** An open Library names the profile in its header (#library-sub): redraw it after a rename. */
function refreshLibraryName() {
  if (!document.getElementById('library')?.open) return;
  import('./library.js').then(m => { if (typeof m.renderLibrary === 'function') m.renderLibrary({ keepScroll: true, still: true }); }).catch(e => console.error(e));
}
const whoKey = u => (u ? `${u.name || ''}\u0000${u.email || ''}` : '');
const profErr = (msg, inputId) => (inputId ? fieldErr('prof-err', inputId, msg) : showErr('prof-err', msg));
function profileApiError(r, fields) {
  const d = r.data || {};
  if (r.offline || !r.status) return profErr(MSG.offline);
  if (d.error === 'rate_limited') return profErr(rateMsg(d));
  if (d.error === 'not_signed_in') return profErr('You’ve been signed out. Sign in again to change your profile.');
  const input = fields[d.field];
  if (d.error === 'bad_credentials') return profErr(MSG.badPassword, input || fields.password);
  if (d.error === 'email_taken') return profErr(MSG.taken, fields.email);
  return profErr(d.message || MSG.generic, input);
}

let profBusy = false;
function bindProfileDialog() {
  const body = document.getElementById('profile-body'); if (!body) return;
  body.addEventListener('input', e => {
    const row = e.target.closest && e.target.closest('.frow');
    if (row) row.classList.remove('bad');
    e.target.removeAttribute?.('aria-invalid');
    const err = $('#prof-err'); if (err) err.hidden = true;
    if (e.target.id === 'prof-email-in') {
      const changed = normEmail(e.target.value) !== normEmail(state.auth.user?.email);
      $('#prof-email-pw-row').hidden = !changed;
      $('#prof-email-help').hidden = !changed;
      if (!changed) $('#prof-email-pw').value = '';
    }
  });
  body.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.target.matches || !e.target.matches('input')) return;
    e.preventDefault();
    const id = e.target.id;
    if (id === 'prof-pw-cur' || id === 'prof-pw-new') body.querySelector('[data-prof="password"]')?.click();
    else body.querySelector('[data-prof="save"]')?.click();
  });
  body.addEventListener('change', e => {
    if (e.target.id !== 'prof-import-file') return;
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    const btn = body.querySelector('[data-prof="import-file"]');
    if (f && btn && !profBusy) importProfileFile(btn, f);
  });
  body.addEventListener('click', async e => {
    const it = e.target.closest('[data-prof]'); if (!it || profBusy) return;
    const what = it.dataset.prof;
    if (what === 'save') await saveProfile(it);
    else if (what === 'password') await changePassword(it);
    else if (what === 'export') exportVia('exportProfile');
    else if (what === 'obsidian') exportVia('exportNotes');
    else if (what === 'import-guest') await importGuest(it);
    else if (what === 'import-file') { if (DRY) profErr('Dry run: profile changes are turned off.'); else $('#prof-import-file')?.click(); }
    else if (what === 'signout-all') { closeDialog(document.getElementById('profile')); signOut({ all: true }); }
    else if (what === 'delete') deleteProfile();
  });
}
async function busyWhile(btn, label, fn) {
  const key = btn.dataset.prof, had = document.activeElement === btn;
  // only a text button shows the busy label: a rich cell ('Bring over guest data') keeps its icon and lines
  profBusy = true; const old = label ? btn.textContent : null; btn.disabled = true; if (label) btn.textContent = label;
  try { return await fn(); } finally {
    profBusy = false; btn.disabled = false; if (old !== null) btn.textContent = old;
    // disabling it dropped focus to <body> (and a save redraws the dialog): back on the button, unless an error
    // has put it on a field meanwhile or the dialog is closing
    const d = document.getElementById('profile'), ae = document.activeElement;
    if (had && d?.open && !d.classList.contains('closing') && (!ae || ae === document.body)) {
      (btn.isConnected ? btn : $(`#profile-body [data-prof="${key}"]`))?.focus();
    }
  }
}
async function saveProfile(btn) {
  const u = state.auth.user; if (!u) return;
  clearErrors(document.getElementById('profile'), 'prof-err');
  const name = cleanName($('#prof-name-in').value), email = normEmail($('#prof-email-in').value), pw = $('#prof-email-pw').value;
  const body = {};
  if (name !== u.name) { if (nameProblem(name)) return profErr(nameProblem(name), 'prof-name-in'); body.name = name; }
  if (email !== normEmail(u.email)) {
    if (emailProblem(email)) return profErr(emailProblem(email), 'prof-email-in');
    if (!pw) return profErr('Enter your password to change your email.', 'prof-email-pw');
    body.email = email; body.password = pw;
  }
  if (!Object.keys(body).length) { toast('Nothing has changed.'); return; }
  if (DRY) return profErr('Dry run: profile changes are turned off.');
  await busyWhile(btn, 'Saving…', async () => {
    const r = await api('PATCH', '/api/account', body);
    if (!r.ok) return profileApiError(r, { name: 'prof-name-in', email: 'prof-email-in', password: 'prof-email-pw' });
    if (r.data && r.data.user) state.auth.user = r.data.user;
    renderAccountButton();
    renderProfile();
    refreshLibraryName();
    broadcast({ t: 'auth', scope: state.auth.scope });
    toast(body.email ? 'Profile saved. Sign in with your new email from now on.' : 'Profile saved.');
  });
}
async function changePassword(btn) {
  const u = state.auth.user; if (!u) return;
  clearErrors(document.getElementById('profile'), 'prof-err');
  const cur = $('#prof-pw-cur').value, next = $('#prof-pw-new').value;
  if (!cur) return profErr('Enter your current password.', 'prof-pw-cur');
  const p = passwordProblem(next, u.email); if (p) return profErr(p, 'prof-pw-new');
  if (DRY) return profErr('Dry run: profile changes are turned off.');
  await busyWhile(btn, 'Changing…', async () => {
    const r = await api('POST', '/api/account/password', { current: cur, next });
    if (!r.ok) return profileApiError(r, { current: 'prof-pw-cur', next: 'prof-pw-new', password: 'prof-pw-cur' });
    $('#prof-pw-cur').value = ''; $('#prof-pw-new').value = '';
    // this browser keeps its sign-in (every window shares the new session); only other browsers and devices lose theirs
    const n = +(r.data && r.data.revokedOthers) || 0;
    toast(n ? 'Password changed. Other browsers and devices signed in to this profile were signed out.' : 'Password changed.');
  });
}
/**
 * 'Export profile' / 'Export notes for Obsidian': the Library's exports (library.js), so both places check the same
 * things: unsent note edits go first, and an answer for another scope (this session expired: the guest) is never saved.
 */
function exportVia(fn) {
  import('./library.js').then(m => m[fn]()).catch(e => { console.error(e); toast(MSG.generic); });
}
async function importGuest(btn) {
  if (DRY) return profErr('Dry run: profile changes are turned off.');
  await busyWhile(btn, '', async () => {
    const pending = await flushAll();
    if (pending > 0) return profErr(MSG.tryLater);
    const r = await api('POST', '/api/profile/import-guest', {});
    if (!r.ok) return profileApiError(r, {});
    const parts = importedParts((r.data && r.data.imported) || {});
    // changed with no counts: only guest study days, activity or the last-read place came over
    const changed = parts.length > 0 || !!(r.data && r.data.changed);
    toast(parts.length ? `Brought over ${listJoin(parts)}.` : changed ? 'Brought over your recent guest reading history.' : 'Everything from the guest space is already here.');
    if (changed) await afterImport(r.data.rev);
  });
}
/** The import's counts in the words of 'Bring over guest data': '3 notes, 1 bookmark and reading progress for 2 chapters'. */
const importedParts = im => [im.notes ? plural(im.notes, 'note') : '', im.bookmarks ? plural(im.bookmarks, 'bookmark') : '', im.links ? plural(im.links, 'link') : '', im.marks ? plural(im.marks, 'highlight') : '', im.memory ? plural(im.memory, 'memory verse') : '', im.chapters ? `reading progress for ${plural(im.chapters, 'chapter')}` : ''].filter(Boolean);
/** Every tab of this profile reloads what an import changed (the guest import does the same). */
async function afterImport(rev) {
  rev = rev || {};
  for (const t of ['notes', 'library', 'links', 'marks', 'memory']) broadcast({ t, scope: state.auth.scope, rev: rev[t] || 0 });
  try { await A?.onScopeChange?.({ prevScope: state.auth.scope, reason: 'import' }); } catch (e) { console.error(e); }
}
const IMPORT_MAX = 25 * 1024 * 1024; // serve.py's limit for /api/profile/import
/** 'Import profile file' (hosting brief §1–2): the JSON from 'Export profile', merged into this profile by serve.py. */
async function importProfileFile(btn, file) {
  clearErrors(document.getElementById('profile'), 'prof-err');
  if (DRY) return profErr('Dry run: profile changes are turned off.');
  if (file.size > IMPORT_MAX) return profErr('That file is too large to import. The limit is 25 MB.');
  let json;
  try { json = JSON.parse(await file.text()); } catch (e) { json = null; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return profErr('That file isn’t a Bible study profile export.');
  await busyWhile(btn, '', async () => {
    const pending = await flushAll(); // the profile's own unsent edits first: the merge then sees them
    if (pending > 0) return profErr(state.auth.hosted ? 'Your latest changes aren’t saved yet. Try again in a moment.' : MSG.tryLater);
    const r = await api('POST', '/api/profile/import', json, { timeout: 120000 }); // a large file over a slow uplink
    if (!r.ok) {
      const d = r.data || {};
      if (d.error === 'quota_exceeded') return profErr(d.message || QUOTA_MSG); // hosted: the profile is full, not the file
      if (r.status === 413 || d.error === 'too_large') return profErr('That file is too large to import. The limit is 25 MB.');
      // hosted, a refused body the proxy cut off arrives as its own non-JSON 502 rather than serve.py's answer
      if (r.status === 502 && !r.data) return profErr('The file is too large or the server is busy. Try again.');
      return profileApiError(r, {});
    }
    const parts = importedParts((r.data && r.data.imported) || {}), changed = parts.length > 0 || !!(r.data && r.data.changed);
    const sk = +(r.data && r.data.skipped) || 0;
    const skipped = sk ? ` ${plural(sk, 'entry', 'entries')} couldn’t be read and ${sk === 1 ? 'was' : 'were'} left out.` : '';
    toast((parts.length ? `Brought over ${listJoin(parts)}.` : changed ? 'Brought over your reading history from the file.' : 'Everything in that file is already here.') + skipped);
    if (changed) await afterImport(r.data.rev);
  });
}

// ------------------------------------------------------------ site activity (hosted, owner only: open-signup brief §2)
// GET /api/admin/traffic: the server's own daily counts (UTC days). Anyone but an owner gets 404, and the section goes.
const VERCEL_ANALYTICS = 'https://vercel.com/koum-studio/bible-study/analytics';
const TRF_ROWS = [['loads', 'App loads'], ['visitors', 'Visitors', '(approx.)'], ['signups', 'Sign-ups'], ['signins', 'Sign-ins'],
  ['signin_failed', 'Failed sign-ins'], ['bot_failed', 'Failed bot checks'], ['rate_limited', 'Rate-limited requests'],
  ['csrf_blocked', 'Blocked cross-site requests'], ['errors_5xx', 'Server errors']];
let trf = { at: 0, data: null }, trfSeq = 0;
function trafficHtml() {
  return `<h3 class="group-h" id="prof-trf-h">Site activity</h3>
<div class="trf" id="prof-trf" role="region" aria-labelledby="prof-trf-h" aria-busy="true"><p class="group-foot trf-wait">Loading site activity…</p></div>`;
}
const num = n => (Number.isFinite(+n) ? Math.max(0, Math.round(+n)) : 0);
const fmtN = n => num(n).toLocaleString();
const isoDay = t => new Date(t).toISOString().slice(0, 10);
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = iso => { const [, m, d] = String(iso).split('-').map(Number); return m && d ? `${d} ${MON3[m - 1]}` : String(iso); };
function fmtMB(mb) {
  const n = Math.max(0, +mb || 0);
  return n >= 1024 ? `${(n / 1024).toLocaleString(undefined, { maximumFractionDigits: n >= 10240 ? 0 : 1 })} GB` : `${Math.round(n).toLocaleString()} MB`;
}
/** The last 30 UTC days, oldest first, a day without traffic as zeros (the server lists only days it counted). */
function trafficDays(d) {
  const by = new Map((Array.isArray(d.days) ? d.days : []).filter(x => x && /^\d{4}-\d{2}-\d{2}$/.test(x.date)).map(x => [x.date, x]));
  const last = [...by.keys()].sort().pop() || '', today = isoDay(Date.now());
  const end = Date.parse(`${last > today ? last : today}T00:00:00Z`);
  return Array.from({ length: 30 }, (_, i) => { const date = isoDay(end - (29 - i) * 86400000); return by.get(date) || { date }; });
}
/** A total over the last n days: the server's own when it gives one ({last_7: {loads, …}}), else the days added up. */
function trafficTotal(d, days, n, key) {
  const t = d.totals && d.totals[`last_${n}`];
  if (t && typeof t === 'object' && Number.isFinite(+t[key])) return num(t[key]);
  return days.slice(-n).reduce((s2, x) => s2 + num(x[key]), 0);
}
function trafficBars(days, key, what) {
  const v = days.map(x => num(x[key])), max = Math.max(1, ...v);
  let top = -1; v.forEach((x, i) => { if (x > 0 && (top < 0 || x >= v[top])) top = i; });
  const aria = top < 0 ? `${what[0].toUpperCase() + what.slice(1)} per day for the last 30 days: none yet.`
    : `${what[0].toUpperCase() + what.slice(1)} per day for the last 30 days, most recent on the right. Busiest day: ${dayLabel(days[top].date)}, ${fmtN(v[top])}.`;
  const bars = v.map((x, i) => `<i${x ? '' : ' class="z"'} style="--h:${(x / max).toFixed(3)}" title="${esc(`${dayLabel(days[i].date)} · ${fmtN(x)} ${what}`)}"></i>`).join('');
  return `<div class="trf-bars" role="img" aria-label="${esc(aria)}">${bars}</div>`;
}
function drawTraffic(d) {
  const box = $('#prof-trf'); if (!box) return;
  const days = trafficDays(d), today = days[days.length - 1], T = d.totals || {}, st = d.storage || {};
  const rows = TRF_ROWS.map(([k, label, note]) => `<tr><th scope="row">${esc(label)}${note ? ` <small>${esc(note)}</small>` : ''}</th><td>${fmtN(today[k])}</td><td>${fmtN(trafficTotal(d, days, 7, k))}</td><td>${fmtN(trafficTotal(d, days, 30, k))}</td></tr>`).join('');
  const facts = [
    ['Profiles', fmtN(T.profiles)],
    Number.isFinite(+T.guests_today) ? ['Guests today (approx.)', fmtN(T.guests_today)] : null,
    ['Storage left', Number.isFinite(+st.free_mb) ? `${fmtMB(st.free_mb)}${Number.isFinite(+st.used_mb) ? ` · ${fmtMB(st.used_mb)} used` : ''}` : 'Unknown'],
    ['Cloudflare Turnstile', d.turnstile ? 'On' : 'Off'],
    ['Sign-up', d.signup === 'closed' ? 'Paused' : 'Open'],
  ].filter(Boolean);
  box.innerHTML = `<table class="group trf-tbl">
  <caption class="sr">Site activity: today and the last 7 and 30 days, by UTC day</caption>
  <thead><tr><td></td><th scope="col">Today</th><th scope="col">7 days</th><th scope="col">30 days</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="trf-chart">
  <div class="trf-line"><span class="trf-lab" aria-hidden="true">App loads</span>${trafficBars(days, 'loads', 'app loads')}</div>
  <div class="trf-line su"><span class="trf-lab" aria-hidden="true">Sign-ups</span>${trafficBars(days, 'signups', 'sign-ups')}</div>
  <div class="lib-axis trf-axis" aria-hidden="true"><span>${esc(dayLabel(days[0].date))}</span><span>${esc(dayLabel(days[15].date))}</span><span>Today</span></div>
</div>
<dl class="group trf-facts" aria-label="The site now">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
<p class="group-foot">Counted by the server per UTC day; visitors are estimated without keeping addresses. <a class="link" href="${VERCEL_ANALYTICS}" target="_blank" rel="noopener noreferrer">Open Vercel Analytics</a></p>`;
  box.removeAttribute('aria-busy');
}
/** Loaded each time the Profile dialog opens (a redraw within a minute reuses the last answer). */
async function loadTraffic() {
  const my = ++trfSeq;
  if (trf.data && Date.now() - trf.at < 60000) { drawTraffic(trf.data); return; }
  const r = await api('GET', '/api/admin/traffic', null, { scoped: false });
  const box = $('#prof-trf'); if (my !== trfSeq || !box) return;
  if (r.status === 404) { box.remove(); $('#prof-trf-h')?.remove(); trf = { at: 0, data: null }; return; } // not an owner after all
  if (r.ok && r.data && typeof r.data === 'object') { trf = { at: Date.now(), data: r.data }; drawTraffic(r.data); return; }
  box.removeAttribute('aria-busy');
  box.innerHTML = `<p class="group-foot trf-wait">${esc(r.offline ? MSG.offline : 'Couldn’t load site activity. Close and open Profile to try again.')}</p>`;
}

async function deleteProfile() {
  const u = state.auth.user; if (!u) return;
  const uid = state.auth.scope;
  await confirmDialog({
    title: 'Delete this profile?',
    body: state.auth.hosted ? `This removes ${u.name}’s notes, bookmarks, links, highlights and reading progress from this site. It’s erased straight away and can’t be undone.`
      : `This removes ${u.name}’s notes, bookmarks, links, highlights and reading progress from this computer. Guest notes are not affected.`,
    ok: 'Delete profile', danger: true, password: true,
    onConfirm: async password => {
      if (DRY) return MSG.dry;
      const r = await api('POST', '/api/account/delete', { password });
      if (r.ok) {
        // act on the server's answer here, whatever happens to the dialog meanwhile
        try { await afterDelete(uid); } catch (e) { console.error(e); }
        return true;
      }
      const d = r.data || {};
      if (r.offline || !r.status) return MSG.offline;
      if (d.error === 'bad_credentials') return MSG.badPassword;
      if (d.error === 'rate_limited') return rateMsg(d);
      return d.message || 'Couldn’t delete the profile. Try again.';
    },
  });
}
/** Once every given dialog has closed (each fades out first), focus `el`, unless focus has found a place meanwhile. */
function focusAfterClose(el, ...ds) {
  const open = ds.find(d => d && d.open);
  if (open) { open.addEventListener('close', () => focusAfterClose(el, ...ds), { once: true }); return; }
  setTimeout(() => { const ae = document.activeElement; if (el && el.isConnected && !el.hidden && (!ae || ae === document.body)) el.focus(); }, 0);
}
/** The server deleted the profile: this tab becomes the guest and forgets what this browser kept for it. */
async function afterDelete(uid) {
  closeDialog(document.getElementById('profile'));
  // #confirm hands focus back to 'Delete profile…' in the closed Profile dialog, i.e. to <body>: the account button
  focusAfterClose(document.getElementById('btn-account'), document.getElementById('confirm'), document.getElementById('profile'));
  const me = (await fetchMe()) || guestMe();
  if (state.auth.scope === uid) switchScope(me.signedIn ? guestMe() : me, 'delete');
  // after the switch: the tracker stores what it still held under the old key while switching
  forgetLocal(uid, { all: true });
  toast('Profile deleted.');
}
