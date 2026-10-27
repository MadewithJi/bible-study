// Memorize (memorize-brief §5): the practice. One memory verse at a time in #practice (index.html): Read, Fade, First
// letters and Recall, then the check (what was typed, word by word) and Got it / Not yet through memory.js
// recordPractice, then the end of the practice or the quiet Written on the heart moment. The schedule is memsched.js's;
// the verse's place in line and its labels come from memory.js (memoryDue, memoryWhen, memoryGotIt, memoryIsUpnext),
// never from memsched with a guessed flag. main.js bindDialogs closes it (Esc, Close, Done, the backdrop).
import { esc, smart, trInfo, DRY } from './store.js';
import { showDialog, setRadio, placeInd, moveInd, radioKeys, localDay } from './ui.js';
import { icon } from './icons.js';
import { fumsView } from './reader.js';
import * as S from './memsched.js';
import { getMemory, memoryText, memoryLabel, memoryDue, memoryWhen, memoryGotIt, memoryIsUpnext, recordPractice } from './memory.js';

const STEPS = ['read', 'fade', 'letters', 'recall'];
const NAMES = { read: 'Read', fade: 'Fade', letters: 'First letters', recall: 'Recall' };
const PEEK_MS = 1600, PASS = 0.8;   // a peek lasts 1.6 s; under 80 % of the words typed, focus goes to Not yet
const NUM = ['', 'a', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const WORD_RX = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su;   // a token: its leading punctuation, the word, its trailing
const arrow = icon('arrow-right');

let D = null;   // { d, title, sub, seg, pane, meta, foot, live }
let P = null;   // the practice on screen: { id, entry, opener, phase, step, fade, typed, text, words, cmp, ... }
let token = 0, sayT = 0, loadT = 0;

// ------------------------------------------------------------ words
/** KJV small capitals for the divine name (LORD, GOD, LORD’S), as home.js shows it. */
const sc = s => esc(s).replace(/\b(?:LORD|GOD)(?:[’']S)?(?!\p{L})/gu, m => `<span class="sc">${m[0]}${m.slice(1).toLowerCase()}</span>`);
/** A word as a screen reader should hear it ('Lord', not 'L-O-R-D'). */
const spoken = s => String(s).replace(/\b(?:LORD|GOD)(?:[’']S)?(?!\p{L})/gu, m => m[0] + m.slice(1).toLowerCase());
const firstOf = core => String.fromCodePoint(core.codePointAt(0));
/** The verse's words (memsched.tokenize, verse by verse): {t, lead, core, trail, v, glue}; v = the verse number shown
 *  before a passage verse's first word (0 for one verse); glue = ' ' or '' (a dash joins two words). */
function wordsOf(verses) {
  const out = [], multi = verses.length > 1;
  for (const { v, t } of verses) {
    const s = smart(t), toks = S.tokenize(s);
    let at = 0;
    toks.forEach((tk, k) => {
      const i = s.indexOf(tk, at); at = (i < 0 ? at : i) + tk.length;
      const m = WORD_RX.exec(tk) || ['', '', tk, ''];
      out.push({ t: tk, lead: m[1], core: m[2], trail: m[3], v: multi && k === 0 ? v : 0, glue: k < toks.length - 1 && !/\s/.test(s[at] || ' ') ? '' : ' ' });
    });
  }
  return out;
}
/** The verse as one paragraph: plain (read, check: the missed words marked), faded, or first letters. */
function verseHtml(mode, miss = null) {
  const ws = P.words, mask = mode === 'fade' ? S.fadeMask(ws.length, P.fade) : null;
  let h = '';
  ws.forEach((w, i) => {
    const vn = w.v ? `<sup class="mz-vn">${w.v}</sup>` : '', L = esc(w.lead), T = esc(w.trail);
    // a blank or a letter keeps its verse number and punctuation on its line (a button is a break opportunity of its own)
    const keep = x => (vn || L || T ? `<span class="mz-w">${vn}${L}${x}${T}</span>` : x);
    if (!w.core) h += vn + esc(w.t);
    else if (mask && mask[i]) h += keep(`<button type="button" class="mz-gap" data-i="${i}" aria-label="Hidden word. Peek"><span>${sc(w.core)}</span></button>`);
    else if (mode === 'letters') { const f = esc(firstOf(w.core)); h += keep(`<button type="button" class="mz-l" data-i="${i}" aria-label="${f}. Peek"><span>${f}</span></button>`); }
    else if (miss && miss.has(i)) h += `${vn}${L}<mark class="mz-miss">${sc(w.core)}<span class="sr"> (missed)</span></mark>${T}`;
    else h += vn + L + sc(w.core) + T;
    if (i < ws.length - 1) h += w.glue;
  });
  return `<p class="mz-v${mode === 'letters' ? ' mz-fl' : ''}">${h}</p>`;
}
/** What was typed, with its whitespace kept and the words the verse doesn't have struck lightly (c: compareTyped's). */
function typedHtml(text, c) {
  const ex = new Set(c.extra), toks = c.typed;
  let at = 0, h = '';
  toks.forEach((tk, j) => {
    const i = text.indexOf(tk, at);
    if (i < 0) { h += `${esc(tk)} `; return; }
    h += esc(text.slice(at, i)) + (ex.has(j) ? `<s class="mz-extra">${esc(tk)}<span class="sr"> (extra)</span></s>` : esc(tk));
    at = i + tk.length;
  });
  return h + esc(text.slice(at));
}
const minutes = n => { const m = Math.max(1, Math.round(n / 40)); return m === 1 ? 'about a minute' : `about ${NUM[m] || m} minutes`; };
const dots = (done, ring, label) => `<span class="mz-steps" role="img" aria-label="${esc(label)}">${[0, 1, 2, 3, 4, 5].map(i => `<i${i < done ? ' class="d"' : i === ring ? ' class="n"' : ''}></i>`).join('')}</span>`;
const withYear = day => `${S.dayLong(day)} ${String(day).slice(0, 4)}`;

// ------------------------------------------------------------ the dialog
function dlg() {
  if (D) return D;
  const d = document.getElementById('practice'); if (!d) return null;
  const q = s => d.querySelector(s);
  D = { d, title: q('#practice-title'), sub: q('#practice-sub'), seg: q('#practice-steps'), pane: q('#practice-pane'), meta: q('#practice-meta'), foot: q('#practice-foot'), live: q('#practice-say') };
  // a double or triple click acts once: its later clicks would land on the next screen's button (Show the verse → Got it)
  D.foot.addEventListener('click', e => { if (e.detail > 1) { e.preventDefault(); e.stopPropagation(); } }, true);
  // a held Enter or Space repeats: its repeats would land on the next screen's button too
  D.foot.addEventListener('keydown', e => { if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault(); }, true);
  D.seg.addEventListener('click', e => { const b = e.target.closest('[role=radio]'); if (b) goStep(b.dataset.step, { focus: false }); });
  D.seg.addEventListener('keydown', e => radioKeys(e, D.seg, b => goStep(b.dataset.step, { focus: false })));
  if ('ResizeObserver' in window) new ResizeObserver(() => moveInd(D.seg)).observe(D.seg);
  d.addEventListener('click', onClick);
  d.addEventListener('input', e => { if (P && e.target.id === 'practice-typed') P.typed = e.target.value; });
  d.addEventListener('close', onClose);
  document.addEventListener('bs:memory-changed', onChanged);
  return D;
}
/** Say something in the live region (cleared first, so the same words are said again). */
function say(msg) {
  const el = D && D.live; if (!el) return;
  clearTimeout(sayT); el.textContent = '';
  sayT = setTimeout(() => { el.textContent = msg; }, 40);
}
const focusIn = sel => { const el = sel && D.d.querySelector(sel); if (el) el.focus({ preventScroll: true }); };
/** A new step or screen starts at the top of the body (it scrolls for a long passage). */
const toTop = () => { D.pane.parentElement.scrollTop = 0; };
const checkedRadio = '#practice-steps [aria-checked="true"]';

/**
 * Open a memory verse's practice. opts.returnFocus: the element (or a function returning it) to focus after closing;
 * else what had focus. When that is gone (a list redrawn), the first [data-practise="<id>"] element takes it.
 * It can open over the Library dialog. Returns false when there is no such verse.
 */
export function openPractice(id, { returnFocus = null } = {}) {
  const x = dlg(), entry = getMemory(id);
  if (!x || !entry) return false;
  const showing = x.d.open && !x.d.classList.contains('closing') && P;
  const opener = showing ? P.opener : (returnFocus || (document.activeElement && document.activeElement !== document.body ? document.activeElement : null));
  clearPeeks();
  P = { id, entry, opener, phase: 'load', step: entry.heart || entry.step >= 3 ? 'recall' : 'read', fade: 1, typed: '', text: null, words: [], cmp: null, fums: false, busy: false, token: ++token };
  x.title.textContent = memoryLabel(entry);
  setSub();
  showDialog(x.d);
  load();
  return true;
}
export const isPracticeOpen = () => !!(D && D.d.open && !D.d.classList.contains('closing'));

/** The sub line: 'KJV · review 3 of 6 · about a minute', 'KJV · written on the heart', 'KJV · practice run'. */
function setSub() {
  const p = P, e = p.entry, tr = trInfo(p.text ? p.text.tr : e.tr).abbr;
  D.sub.textContent = !memoryDue(e) ? `${tr} · practice run` : e.heart ? `${tr} · written on the heart`
    : `${tr} · ${S.reviewLabel(e)}${p.words.length ? ` · ${minutes(p.words.length)}` : ''}`;
}

async function load() {
  const p = P, my = p.token;
  p.phase = 'load'; render();
  clearTimeout(loadT);
  loadT = setTimeout(() => { if (P === p && p.phase === 'load') D.pane.innerHTML = '<p class="mz-hint">Loading the verse…</p>'; }, 400);
  let t = null;
  try { t = await memoryText(p.entry); } catch (e) { console.error(e); }
  if (P !== p || p.token !== my || p.phase !== 'load') return;   // another verse opened, or this one was removed, meanwhile
  clearTimeout(loadT);
  if (!t || !t.verses || !t.verses.length) {
    p.phase = 'error'; render(); focusIn('[data-act="retry"]');
    say('The verse couldn’t load.');
    return;
  }
  p.text = t; p.words = wordsOf(t.verses);
  // NIV, NKJV and NASB: one FUMS view per practice opened (reader.js fumsView does nothing on ?dry)
  if (!p.fums && t.credit && t.credit.fumsToken && !DRY) { p.fums = true; fumsView(t.credit.fumsToken); }
  p.phase = 'step';
  setSub(); render(); toTop(); placeInd(D.seg);
  focusIn(checkedRadio);
}

function goStep(step, { focus = true } = {}) {
  const p = P; if (!p || p.phase !== 'step' || !STEPS.includes(step)) return;
  clearPeeks();
  p.step = step; if (step === 'fade') p.fade = 1;
  render(); toTop();
  if (focus) focusIn(checkedRadio);
  say(`Step ${STEPS.indexOf(step) + 1} of 4: ${NAMES[step]}`);
}

// ------------------------------------------------------------ what is on screen
const nextBtn = `<button type="button" class="btn btn-primary" data-act="next">Next${arrow}</button>`;
const doneBtn = '<button type="button" class="btn btn-primary" data-close>Done</button>';
const right = html => `<div class="mz-r">${html}</div>`;
function render() {
  const p = P, x = D; if (!p || !x) return;
  const stepping = p.phase === 'step' || p.phase === 'load';
  x.seg.hidden = !stepping;
  x.pane.removeAttribute('aria-busy');
  if (stepping) setRadio(x.seg, b => b.dataset.step === p.step);
  let pane = '', foot = '';
  if (p.phase === 'load') { x.pane.setAttribute('aria-busy', 'true'); }
  else if (p.phase === 'error') {
    pane = `<div class="mz-end"><span class="tile-i">${icon('info')}</span><p>The verse couldn’t load. Check your connection and try again.</p></div>`;
    foot = right('<button type="button" class="btn btn-primary" data-act="retry">Try again</button>');
  } else if (p.phase === 'gone') {
    pane = '<div class="mz-end"><p>This verse is no longer one of your memory verses.</p></div>';
    foot = right(doneBtn);
  } else if (p.phase === 'step' && p.step === 'read') {
    pane = `${verseHtml('read')}<p class="mz-hint">Read it through slowly, aloud if you can.</p>`;
    foot = right(nextBtn);
  } else if (p.phase === 'step' && p.step === 'fade') {
    pane = `${verseHtml('fade')}<p class="mz-hint">${p.fade === 1 ? 'A third' : 'Two thirds'} of the words are hidden. Tap a gap to peek.</p>`;
    foot = right(`${p.fade === 1 ? '<button type="button" class="btn btn-tinted" data-act="more">Hide more</button>' : ''}${nextBtn}`);
  } else if (p.phase === 'step' && p.step === 'letters') {
    pane = `${verseHtml('letters')}<p class="mz-hint">The first letter of each word. Say the verse as you go; tap a letter to peek.</p>`;
    foot = right(nextBtn);
  } else if (p.phase === 'step' && p.step === 'recall') {
    pane = '<div class="mz-blank"><label class="sr" for="practice-typed">Type the verse (optional)</label>'
      + '<textarea id="practice-typed" rows="4" placeholder="Type it here, if you like" spellcheck="false" autocorrect="off" autocomplete="off" maxlength="8000"></textarea></div>'
      + '<p class="mz-hint">Say it aloud, or type it. Then show the verse to check.</p>';
    foot = right('<button type="button" class="btn btn-primary" data-act="show">Show the verse</button>');
  } else if (p.phase === 'check') ({ pane, foot } = checkHtml());
  else if (p.phase === 'end') ({ pane, foot } = endHtml());
  else if (p.phase === 'heart') ({ pane, foot } = heartHtml());
  x.pane.innerHTML = pane;
  x.foot.innerHTML = foot;
  const ta = x.pane.querySelector('#practice-typed'); if (ta) ta.value = p.typed;
  // the copyright line and the KJV fallback, wherever the verse is shown
  const t = p.text, meta = t && ['step', 'check', 'heart'].includes(p.phase);
  const ab = esc(trInfo(p.entry.tr).abbr), fbMsg = t && t.omitted
    ? (p.entry.tr === 'bsb' ? 'Shown in the KJV: the BSB leaves this verse out of its text.' : `Shown in the KJV: the ${ab} has no separate verse here.`)
    : `Shown in the KJV: the ${ab} isn’t available right now.`;
  const fb = meta && t.fallback ? `<p class="mz-fb">${icon('info')}<span>${fbMsg}</span></p>` : '';
  const cr = meta && t.credit && t.credit.copyright ? `<p class="copyright mz-copy">${esc(t.credit.copyright)}</p>` : '';
  x.meta.innerHTML = fb + cr;
  x.meta.hidden = !(fb || cr);
}
function checkHtml() {
  const p = P, c = p.cmp, typed = p.typed.trim();
  let pane = verseHtml('read', c ? new Set(c.missed) : null);
  if (c) pane += `<p class="mz-score">You had ${c.right} of ${c.total} ${c.total === 1 ? 'word' : 'words'}.</p><div class="mz-typed"><small>You typed</small><p>${typedHtml(typed, c)}</p></div>`;
  if (!p.due) {
    const w = memoryWhen(p.entry), when = w === 'Tomorrow' ? 'tomorrow' : w.replace(/^Next review /, '');
    const line = memoryIsUpnext(p.entry) ? 'A practice run: it starts when it’s your memory verse.' : when ? `A practice run: your next review is still ${when}.` : 'A practice run: nothing changes.';
    return { pane: `${pane}<p class="mz-hint">${esc(line)}</p>`, foot: right(doneBtn) };
  }
  if (!c) pane += '<p class="mz-hint">How did it go?</p>';
  const foot = `<div class="mz-judge"><button type="button" class="btn btn-gray" data-act="not">Not yet<span class="sr">, </span><small>Again tomorrow</small></button>`
    + `<button type="button" class="btn btn-primary" data-act="got">Got it<span class="sr">, </span><small>${esc(p.gotLabel)}</small></button></div>`;
  return { pane, foot };
}
function endHtml() {
  const p = P, { kind, r } = p.result, e = r.entry, b = r.before, day = localDay(), got = kind === 'got';
  const date = S.dayLong(e.due, day), soon = S.dayDiff(day, e.due) === 1;
  const line = !got ? `Again tomorrow, ${date}.` : soon ? `Next review tomorrow, ${date}.` : `Next review ${date}.`;
  const label = e.heart ? 'Written on the heart' : got ? `Review ${b.step + 1} of 6 done` : `Review ${e.step + 1} of 6`;
  const pane = `<div class="mz-end"><span class="tile-i">${icon(got ? 'check' : 'clock')}</span><h3>${got ? 'Well done.' : 'No hurry.'}</h3><p>${esc(line)}</p>`
    + `${e.heart ? dots(6, -1, label) : dots(e.step, e.step, label)}${DRY ? '<p class="mz-dry">Dry run: nothing is saved.</p>' : ''}</div>`;
  return { pane, foot: right(doneBtn) };
}
function heartHtml() {
  const p = P, { r } = p.result, next = r.next ? memoryLabel(r.next) : '';
  const pane = `<div class="mz-heart">${verseHtml('read')}<hr><p class="mz-wh">Written on the heart</p><p class="mz-date">${esc(withYear(r.entry.heart))}</p>`
    + `${next ? `<p class="mz-date">Next up: ${esc(next)}</p>` : ''}`
    + '<blockquote><span>“write them upon the table of thine heart”</span><cite>Proverbs 3:3</cite></blockquote>'
    + `${DRY ? '<p class="mz-dry">Dry run: nothing is saved.</p>' : ''}</div>`;
  return { pane, foot: `<span class="mz-step">From now on, a review about every three months</span>${right(doneBtn)}` };
}

// ------------------------------------------------------------ actions
function onClick(e) {
  const t = e.target instanceof Element ? e.target : null; if (!t || !P) return;
  const g = t.closest('.mz-gap, .mz-l'); if (g) { peek(g); return; }
  const b = t.closest('[data-act]'); if (!b || b.disabled) return;
  const act = b.dataset.act, p = P;
  if (act === 'next') goStep(STEPS[STEPS.indexOf(p.step) + 1]);
  else if (act === 'more' && p.phase === 'step') { p.fade = 2; clearPeeks(); render(); focusIn('[data-act="next"]'); say('Two thirds of the words are hidden.'); }
  else if (act === 'show') showCheck();
  else if (act === 'got' || act === 'not') judge(act);
  else if (act === 'retry') load();
}
/** Got it and Not yet wait this long after the check appears: a second press of the key or click that showed it lands there. */
const CHECK_MS = 500;
function showCheck() {
  const p = P; if (!p || p.phase !== 'step') return;
  clearPeeks();
  const typed = p.typed.trim();
  p.cmp = typed ? S.compareTyped(p.words.map(w => w.t), typed) : null;
  p.due = memoryDue(p.entry); p.gotLabel = p.due ? memoryGotIt(p.entry) : '';
  p.phase = 'check'; p.shownAt = performance.now(); render(); toTop();
  const c = p.cmp, score = c ? ` You had ${c.right} of ${c.total} ${c.total === 1 ? 'word' : 'words'}.` : '';
  if (!p.due) { focusIn('[data-close]:not(.close-btn)'); say(`The verse is shown.${score} A practice run.`); return; }
  focusIn(c && c.total && c.right / c.total < PASS ? '[data-act="not"]' : '[data-act="got"]');
  say(`The verse is shown.${score} Got it, or not yet?`);
}
/** Got it / Not yet: memory.js recordPractice once (a second click while it runs does nothing). */
async function judge(kind) {
  const p = P; if (!p || p.busy || p.phase !== 'check' || performance.now() - (p.shownAt || 0) < CHECK_MS) return;
  p.busy = true;
  D.foot.querySelectorAll('button').forEach(b => { b.disabled = true; });
  let r = null;
  try { r = await recordPractice(p.id, kind === 'got' ? 'got' : 'not'); } catch (e) { console.error(e); }
  if (P !== p) return;
  p.busy = false;
  if (!r) {   // removed meanwhile (it says so), or the sign-in prompt
    if (!getMemory(p.id)) { p.phase = 'gone'; render(); toTop(); focusIn('[data-close]:not(.close-btn)'); say('This verse is no longer one of your memory verses.'); }
    else D.foot.querySelectorAll('button').forEach(b => { b.disabled = false; });
    return;
  }
  if (r.free) { p.entry = r.entry; p.due = false; render(); toTop(); focusIn('[data-close]:not(.close-btn)'); say('A practice run: nothing changes.'); return; } // judged in another window meanwhile
  p.entry = r.entry; p.result = { kind, r };
  p.phase = r.heart ? 'heart' : 'end';
  // the mock's sub line for the moment: the practice is over, so no time estimate
  if (r.heart) D.sub.textContent = `${trInfo(p.text ? p.text.tr : p.entry.tr).abbr} · review 6 of 6`;
  render(); toTop(); focusIn('[data-close]:not(.close-btn)');
  if (r.heart) say(`Written on the heart.${r.next ? ` Next up: ${memoryLabel(r.next)}.` : ''}`);
  else say(kind === 'got' ? `Well done. ${D.pane.querySelector('.mz-end p').textContent}` : `No hurry. ${D.pane.querySelector('.mz-end p').textContent}`);
}
/** Peek at a hidden word or a first letter for 1.6 s. */
function peek(b) {
  const w = P.words[+b.dataset.i]; if (!w || !w.core) return;
  const span = b.firstElementChild, letter = b.classList.contains('mz-l'), word = spoken(w.core);
  clearTimeout(b._t);
  b.classList.add('peek'); b.setAttribute('aria-label', word);
  if (letter) span.innerHTML = sc(w.core);
  say(word);
  b._t = setTimeout(() => unpeek(b), PEEK_MS);
}
function unpeek(b) {
  clearTimeout(b._t); b._t = 0;
  const w = P && P.words[+b.dataset.i]; if (!w || !b.isConnected) return;
  b.classList.remove('peek');
  if (b.classList.contains('mz-l')) { const f = firstOf(w.core); b.firstElementChild.textContent = f; b.setAttribute('aria-label', `${f}. Peek`); }
  else b.setAttribute('aria-label', 'Hidden word. Peek');
}
const clearPeeks = () => { if (D) D.pane.querySelectorAll('.mz-gap, .mz-l').forEach(b => clearTimeout(b._t)); };

/** Another window (or a sign-out) changed the verses: a verse that is gone says so; the sub line follows a change. */
function onChanged() {
  const p = P; if (!p || !isPracticeOpen() || p.busy) return;
  const now = getMemory(p.id);
  if (!now) { if (p.phase !== 'end' && p.phase !== 'heart' && p.phase !== 'gone') { clearPeeks(); p.phase = 'gone'; render(); focusIn('[data-close]:not(.close-btn)'); say('This verse is no longer one of your memory verses.'); } return; }
  if (p.phase === 'load' || p.phase === 'step') { p.entry = now; setSub(); }
}
function onClose() {
  const x = D; if (!x || x.d.open) return;   // reopened before the event came
  clearPeeks(); clearTimeout(loadT); clearTimeout(sayT);
  const p = P; P = null; token++;
  if (!p) return;
  let o = p.opener;
  if (typeof o === 'function') { try { o = o(); } catch (e) { o = null; } }
  if (!o || !o.isConnected || !o.getClientRects().length) o = [...document.querySelectorAll(`[data-practise="${CSS.escape(p.id)}"]`)].find(el => el.getClientRects().length) || o;
  if (o && o.isConnected && typeof o.focus === 'function') o.focus({ preventScroll: true });
}
