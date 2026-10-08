// Profiles (profiles-spec §5.1, §5.5–5.7, §5.14): who is studying, sign in / create profile, the profile
// dialog, the account button and menu, and keeping every tab of this browser on the same profile.
// Local email + password profiles on this computer; no email is ever sent.
import { state, api, DRY, lsGet, lsSet, lsDel, lsKey, SCOPE_RX, esc, flushNotes, pendingNotes, flushSavers, pendingSavers, setSaveStatus, broadcast, onBroadcast, setAuthRefresher, SIGN_IN_MSG, setSignInPrompt, hostedMsg, likelyHosted } from './store.js';
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
  const s = [g.notes ? plural(g.notes, 'note') : '', g.bookmarks ? plural(g.bookmarks, 'bookmark') : '', g.links ? plural(g.links, 'link') : '', g.marks ? plural(g.marks, 'highlight') : '', chs ? `reading progress for ${plural(chs, 'chapter')}` : ''].filter(Boolean).join(' · ');
  return s && s[0].toUpperCase() + s.slice(1);
}

// ------------------------------------------------------------ auth state
/** GET /api/auth/me. Fills state.auth; when serve.py cannot answer, the last scope is used (account UI hidden). */
export async function initAuth() {
  setAuthRefresher(opts => refreshAuth(opts));
  loadTracker();
  // the site is known before its server answers (and while it can't): a guest there never saves to this browser
  if (likelyHosted()) state.auth.hosted = true;
  const r = await api('GET', '/api/auth/me', null, { scoped: false });
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
  }
  if (me.signup === 'invite' || me.signup === 'open') a.signupMode = me.signup;
  a.owner = !!(a.hosted && a.signedIn && me.owner === true);
  if (document.getElementById('auth')?.open && !authBusy) syncAvailability();
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

export function openAuth(mode = 'signin', { email = '', reason = '' } = {}) {
  const d = document.getElementById('auth'); if (!d) return;
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
  setTimeout(() => focusFirst(), 40);
  // the guest summary (for "Bring over guest data") and what serve.py allows may be older than this visit: refresh
  if (state.auth.server && !state.auth.signedIn) fetchMe().then(me => {
    if (!me || me.signedIn || !d.open) return;
    state.auth.guest = me.guest || state.auth.guest;
    if (me.features) state.auth.features = me.features;
    syncImportRow();
    if (!authBusy) { syncAvailability({ force: true }); moveInd($('#auth-mode')); }
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
/** Sign-up on a hosted site needs an invite code (except for the owner's email, which serve.py knows). */
const inviteMode = () => state.auth.signupMode === 'invite';
function syncImportRow() {
  const g = state.auth.guest, row = $('#auth-import-row'); if (!row) return;
  row.hidden = !(authMode === 'signup' && g && g.hasData);
  const meta = $('#auth-import-meta'); if (meta) meta.textContent = guestMeta(g) || 'Your reading history in this browser';
}
function focusFirst() {
  const up = authMode === 'signup';
  const name = $('#auth-name'), email = $('#auth-email'), pw = $('#auth-password'), inv = $('#auth-invite');
  // creating a profile with an invite starts at the code (the first field, and what Home's 'I have an invite' is about)
  const el = up ? (inviteMode() && inv && !inv.value ? inv : !name.value ? name : !email.value ? email : pw) : (!email.value ? email : pw);
  el?.focus();
}
/** features.signup false (profile limit reached) or features.profiles false (users.json unavailable). */
const signupOff = () => { const f = state.auth.features || {}; return f.signup === false || f.profiles === false; };
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
  const inv = $('#auth-invite-row'); if (inv) inv.hidden = !(up && inviteMode());
  syncImportRow();
  $('#auth-title').textContent = up ? 'Create profile' : 'Sign in';
  if (!authBusy) $('#auth-submit').textContent = up ? 'Create profile' : 'Sign in';
  $('#auth-password').setAttribute('autocomplete', up ? 'new-password' : 'current-password');
  // the new-password rule describes the field only when making a profile (a hidden node would still be read out)
  if (up) $('#auth-password').setAttribute('aria-describedby', 'auth-pw-help'); else $('#auth-password').removeAttribute('aria-describedby');
  setRadio($('#auth-mode'), b => b.dataset.mode === authMode);
  clearErrors();
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
  if (errId === 'auth-err') { const ie = $('#auth-invite-err'); if (ie) { ie.hidden = true; ie.textContent = ''; } } // the invite's own line
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
    const ie = $('#auth-invite-err'); if (ie && !ie.hidden) ie.hidden = true;
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
  const name = cleanName($('#auth-name').value), email = normEmail($('#auth-email').value), pw = $('#auth-password').value;
  if (up && nameProblem(name)) return fieldErr('auth-err', 'auth-name', nameProblem(name));
  if (emailProblem(email)) return fieldErr('auth-err', 'auth-email', emailProblem(email));
  if (up) { const p = passwordProblem(pw, email); if (p) return fieldErr('auth-err', 'auth-password', p); }
  else if (!pw) return fieldErr('auth-err', 'auth-password', 'Enter your password.');
  // no check here: the owner's email needs no code, and only serve.py knows which that is
  const invite = up && inviteMode() ? String($('#auth-invite')?.value || '').trim() : '';
  if (DRY) return showErr('auth-err', MSG.dry);
  if (!state.auth.server) return showErr('auth-err', MSG.offline);

  const remember = !!$('#auth-remember').checked;
  const importGuest = up && !$('#auth-import-row').hidden && !!$('#auth-import').checked;
  const btn = $('#auth-submit'), dlg = document.getElementById('auth');
  // data-busy: Esc and the backdrop leave the dialog open until serve.py answers (main.js bindDialogs)
  authBusy = true; btn.disabled = true; btn.textContent = up ? 'Creating…' : 'Signing in…'; dlg.dataset.busy = '1';
  try {
    if (!state.auth.lost) await flushAll(); // guest data is current before an import
    const r = up
      ? await api('POST', '/api/auth/signup', { email, name, password: pw, remember, importGuest, ...(invite ? { invite } : {}) }, { scoped: false })
      : await api('POST', '/api/auth/login', { email, password: pw, remember }, { scoped: false });
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
        const parts = im ? [im.notes ? plural(im.notes, 'note') : '', im.bookmarks ? plural(im.bookmarks, 'bookmark') : '', im.links ? plural(im.links, 'link') : '', im.marks ? plural(im.marks, 'highlight') : '', im.chapters ? `reading progress for ${plural(im.chapters, 'chapter')}` : ''].filter(Boolean) : [];
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
function authError(r) {
  const d = r.data || {};
  if (r.offline || !r.status) return showErr('auth-err', MSG.offline);
  // the server's answer is newer than the features from /api/auth/me: the dialog shows it from now on
  if (d.error === 'user_limit') state.auth.features = { ...(state.auth.features || {}), signup: false };
  else if (d.error === 'registry_unavailable' && !d.field) state.auth.features = { ...(state.auth.features || {}), signup: false, profiles: false };
  const field = { email: 'auth-email', name: 'auth-name', password: 'auth-password' }[d.field];
  switch (d.error) {
    case 'invite_required':
      if ($('#auth-invite-row')?.hidden) { state.auth.signupMode = 'invite'; setMode('signup'); } // sign-up closed since the dialog opened
      return fieldErr('auth-invite-err', 'auth-invite', String($('#auth-invite')?.value || '').trim() // right under the code, not above the form
        ? 'That invite code doesn’t work. Check it, or ask for a new one.' : (d.message || 'Sign-up needs an invite code.'));
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

// ------------------------------------------------------------ profile dialog (§5.7)
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
${a.hosted && a.owner ? invitesHtml() : ''}
<h3 class="group-h">Sessions</h3>
<ul class="group"><li><button class="cell" type="button" data-prof="signout-all"><span class="cell-body"><span class="cell-title">Sign out everywhere</span><span class="cell-sub">${a.hosted ? 'Every browser and device signed in to this profile' : 'Every window and browser on this computer'}</span></span></button></li></ul>
<ul class="group prof-danger"><li><button class="cell danger" type="button" data-prof="delete"><span class="cell-body"><span class="cell-title">Delete profile…</span></span></button></li></ul>`;
  $('#prof-name-in').value = u.name || '';
  $('#prof-email-in').value = u.email || '';
  profShown = { name: u.name || '', email: u.email || '' };
  if (a.hosted && a.owner) loadInvites();
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
    else if (id === 'prof-inv-note') body.querySelector('[data-prof="invite"]')?.click();
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
    else if (what === 'invite') await createInvite(it);
    else if (what === 'inv-copy') copyInvite();
    else if (what === 'inv-revoke') await revokeInvite(it);
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
const importedParts = im => [im.notes ? plural(im.notes, 'note') : '', im.bookmarks ? plural(im.bookmarks, 'bookmark') : '', im.links ? plural(im.links, 'link') : '', im.marks ? plural(im.marks, 'highlight') : '', im.chapters ? `reading progress for ${plural(im.chapters, 'chapter')}` : ''].filter(Boolean);
/** Every tab of this profile reloads what an import changed (the guest import does the same). */
async function afterImport(rev) {
  rev = rev || {};
  for (const t of ['notes', 'library', 'links', 'marks']) broadcast({ t, scope: state.auth.scope, rev: rev[t] || 0 });
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

// ------------------------------------------------------------ invites (hosted, owner only: hosting brief §2)
let invites = [], invSeq = 0;
function invitesHtml() {
  return `<h3 class="group-h">Invites</h3>
<ul class="group frows prof-fields">
  <li class="frow"><label for="prof-inv-note">Note</label><input id="prof-inv-note" maxlength="80" autocomplete="off" spellcheck="false" placeholder="Who it’s for (optional)"></li>
</ul>
<div class="actions"><button type="button" class="btn btn-tinted sm" data-prof="invite">Create invite code</button></div>
<div class="inv-new" id="prof-inv-new" role="status" hidden></div>
<ul class="group inv-list" id="prof-invites" tabindex="-1" aria-label="Invite codes"><li class="cell"><span class="cell-sub">Loading invite codes…</span></li></ul>
<p class="group-foot">A code makes one profile. It’s shown in full only when it’s made, so copy it then.</p>`;
}
/** A new code as 'ABCDE-FGHJK', easier to read out (serve.py ignores the dash). Later only its last four are known. */
const groupCode = c => String(c || '').replace(/^(.{5})(.+)$/, '$1-$2');
function invRow(r) {
  const used = `Used ${Number(r.uses || 0).toLocaleString()} of ${Number(r.maxUses || 1).toLocaleString()}`;
  const state2 = r.revoked ? 'Revoked' : r.uses >= r.maxUses ? 'Used up' : '';
  const made = longDate(r.created);
  const sub = [state2 || used, made ? `made ${made}` : ''].filter(Boolean).join(' · ');
  const live = !r.revoked && r.uses < r.maxUses;
  return `<li class="cell inv-row${live ? '' : ' off'}"><span class="cell-body"><span class="cell-title"><span class="inv-last">…${esc(r.last4)}</span>${r.note ? ` · ${esc(r.note)}` : ''}</span><span class="cell-sub">${esc(sub)}</span></span>${live ? `<button type="button" class="btn btn-plain sm" data-prof="inv-revoke" data-inv="${esc(r.id)}" aria-label="Revoke the code ending ${esc(r.last4)}">Revoke</button>` : ''}</li>`;
}
function drawInvites() {
  const ul = $('#prof-invites'); if (!ul) return;
  ul.innerHTML = invites.length ? invites.map(invRow).join('') : '<li class="cell"><span class="cell-sub">No invite codes yet.</span></li>';
}
async function loadInvites() {
  const my = ++invSeq;
  const r = await api('GET', '/api/invites', null, { scoped: false });
  if (my !== invSeq || !$('#prof-invites')) return;
  if (r.ok && r.data && Array.isArray(r.data.invites)) { invites = r.data.invites; drawInvites(); return; }
  $('#prof-invites').innerHTML = `<li class="cell"><span class="cell-sub">${esc(r.offline ? MSG.offline : 'Couldn’t load the invite codes.')}</span></li>`;
}
async function createInvite(btn) {
  clearErrors(document.getElementById('profile'), 'prof-err');
  if (DRY) return profErr('Dry run: profile changes are turned off.');
  const note = cleanName($('#prof-inv-note')?.value);
  if ([...note].length > 80) return profErr('A note can be up to 80 characters.', 'prof-inv-note');
  await busyWhile(btn, 'Creating…', async () => {
    const r = await api('POST', '/api/invites', note ? { note } : {}, { scoped: false });
    if (!r.ok || !r.data || !r.data.code) return profileApiError(r, { note: 'prof-inv-note' });
    invSeq++; // a list still loading is older than this one
    if (r.data.invite) invites = [r.data.invite, ...invites.filter(x => x.id !== r.data.invite.id)];
    drawInvites();
    const box = $('#prof-inv-new'), code = groupCode(r.data.code);
    if (box) {
      box.innerHTML = `<div class="inv-code-row"><code class="inv-code" id="prof-inv-code">${esc(code)}</code><button type="button" class="btn btn-tinted sm" data-prof="inv-copy">Copy</button></div><small>Shown only this once. Copy it now and send it to the person you’re inviting.</small>`;
      box.dataset.code = code; box.hidden = false;
    }
    const ni = $('#prof-inv-note'); if (ni) ni.value = '';
    setTimeout(() => $('#prof-inv-new [data-prof="inv-copy"]')?.focus(), 0); // after busyWhile hands focus back
  });
}
/** Put text on the clipboard (a hidden field and execCommand when the Clipboard API is refused); true when it worked. */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {
    const a = document.activeElement, ta = document.createElement('textarea'); let ok = false;
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    (document.getElementById('profile') || document.body).appendChild(ta); ta.select(); // inside the modal: the page is inert
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    ta.remove(); if (a && a !== document.body && a.isConnected) a.focus({ preventScroll: true });
    return ok;
  }
}
async function copyInvite() {
  const code = $('#prof-inv-new')?.dataset.code; if (!code) return;
  toast(await copyText(code) ? `Copied the invite code ${code}.` : 'Couldn’t copy. Select the code and copy it yourself.');
}
async function revokeInvite(btn) {
  const id = btn.dataset.inv, r0 = invites.find(x => x.id === id); if (!r0) return;
  clearErrors(document.getElementById('profile'), 'prof-err');
  const { ok } = await confirmDialog({ title: 'Revoke this invite code?', body: `The code ending ${r0.last4} won’t make a profile any more. Profiles already made with it stay.`, ok: 'Revoke', danger: true });
  if (!ok || !document.getElementById('profile')?.open) return;
  if (DRY) return profErr('Dry run: profile changes are turned off.');
  const r = await api('POST', '/api/invites/revoke', { id }, { scoped: false });
  if (!r.ok) return profileApiError(r, {});
  if (r.data && r.data.invite) invites = invites.map(x => (x.id === id ? r.data.invite : x));
  drawInvites();
  focusAfterClose($('#prof-invites'), document.getElementById('confirm')); // its Revoke button is gone
  toast(`Revoked the code ending ${r0.last4}.`);
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
