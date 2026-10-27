// Memorize (memorize-brief §1): the pure model. One current memory verse, up to three teed up, a spaced schedule of six
// due reviews until a verse is written on the heart, then about one review a quarter; and the words of a verse for the
// practice (fading, first letters, typing checked word by word). No imports and no DOM, so `jsc -m` can test it
// (tests/memsched_test.js). Days are local calendar days 'YYYY-MM-DD', counted in UTC so a clock change never moves one.

/** The days between due reviews 1–5: review 1 → 1 day, … review 5 → 14 (review 6 writes the verse on the heart). */
export const GAP = [1, 2, 4, 7, 14];
/** Days from one review of a verse on the heart to the next (about three months). */
export const HEART_GAP = 90;
/** Due reviews recalled before a verse is written on the heart. */
export const STEPS = 6;
/** Verses being learned at once: the current one and three teed up. */
export const CAP = 4;

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_RX = /^(\d{4})-(\d{2})-(\d{2})$/;

// ------------------------------------------------------------ days
const utc = day => { const m = DAY_RX.exec(String(day || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
const fmt = t => { const d = new Date(t); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; };
/** True for a real calendar day 'YYYY-MM-DD' (not '2026-02-30'). */
export function isDay(s) { const t = utc(s); return Number.isFinite(t) && fmt(t) === s; }
/** The day n days after `day` (n may be negative). */
export function addDays(day, n) { return fmt(utc(day) + Math.round(n) * 86400000); }
/** Whole days from day a to day b (b − a): dayDiff('2026-10-26', '2026-10-29') = 3. */
export function dayDiff(a, b) { return Math.round((utc(b) - utc(a)) / 86400000); }
/** 'Thursday 29 October' (with the year when it differs from today's). */
export function dayLong(day, today = '') {
  const t = utc(day); if (!Number.isFinite(t)) return '';
  const d = new Date(t), y = today && String(today).slice(0, 4) !== String(d.getUTCFullYear()) ? ' ' + d.getUTCFullYear() : '';
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}${y}`;
}

// ------------------------------------------------------------ the line and the schedule
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** The order of the verses being learned: place in line, then the oldest, then the id. */
export const lineCmp = (a, b) => (+a.pos || 0) - (+b.pos || 0) || (+a.created || 0) - (+b.created || 0) || cmp(a.id, b.id);
const heartCmp = (a, b) => cmp(b.heart, a.heart) || (+b.last || 0) - (+a.last || 0) || cmp(a.id, b.id);
/** Due today: the current verse when not started or its day has come; a heart verse when its day has come or it has no
 *  day (a repaired one is reviewed at once, never lost); never one teed up. */
export function isDue(v, today, upnext = false) {
  if (!v) return false;
  if (v.heart) return !v.due || v.due <= today;
  return !upnext && (!v.due || v.due <= today);
}
/** { current, upnext, heart, dueHeart, full }: the verse being learned, those teed up, those on the heart (newest first),
 *  the heart verses due today (most overdue first) and whether adding is refused (CAP verses learning). */
export function organize(list, today) {
  const all = (Array.isArray(list) ? list : []).filter(v => v && typeof v === 'object');
  const learning = all.filter(v => !v.heart).sort(lineCmp);
  const heart = all.filter(v => v.heart).sort(heartCmp);
  const dueHeart = heart.filter(v => isDue(v, today)).sort((a, b) => cmp(a.due, b.due) || heartCmp(a, b));
  return { current: learning[0] || null, upnext: learning.slice(1), heart, dueHeart, full: learning.length >= CAP };
}
const learningPos = list => (Array.isArray(list) ? list : []).filter(v => v && !v.heart).map(v => +v.pos || 0);
/** The place in line for a new verse: after every verse being learned. */
export function addPos(list) { return Math.max(0, ...learningPos(list)) + 1; }
/** The place in line that puts a verse first (the current one); pass the list without that verse. */
export function frontPos(list) { const p = learningPos(list); return p.length ? Math.min(...p) - 1 : 0; }
/**
 * A practice judged: result 'got' (Got it) or 'not' (Not yet). Returns the fields that change ({step?, due, heart?,
 * last}), or null for a free practice run (a verse teed up, or one not due yet), which changes nothing.
 */
export function judge(v, result, today, now, upnext = false) {
  if (!v || !isDue(v, today, upnext) || (result !== 'got' && result !== 'not')) return null;
  if (result === 'not') return { due: addDays(today, 1), last: now }; // again tomorrow; the step stays
  if (v.heart) return { due: addDays(today, HEART_GAP), last: now };
  const step = Math.min(STEPS, Math.max(0, Math.floor(+v.step || 0)) + 1);
  if (step === STEPS) return { step, heart: today, due: addDays(today, HEART_GAP), last: now };
  return { step, due: addDays(today, GAP[step - 1]), last: now };
}
/** 'review 3 of 6' while learning; 'written on the heart' after. */
export function reviewLabel(v) {
  if (v && v.heart) return 'written on the heart';
  return `review ${Math.min(STEPS, Math.max(0, Math.floor(+(v && v.step) || 0)) + 1)} of ${STEPS}`;
}
/** When a verse is next due: 'Due today', 'Tomorrow', 'Thursday' (within 6 days), 'Thursday 12 November'; a heart verse
 *  further off: 'Next review in January'. '' for a verse teed up (it has no day until it is current). */
export function whenLabel(v, today, upnext = false) {
  if (!v || (upnext && !v.heart)) return '';
  if (isDue(v, today, upnext)) return 'Due today';
  if (!v.due) return '';
  const n = dayDiff(today, v.due);
  if (n === 1) return 'Tomorrow';
  const d = new Date(utc(v.due));
  if (n > 1 && n <= 6) return WEEKDAY[d.getUTCDay()];
  if (v.heart) return `Next review in ${MONTH[d.getUTCMonth()]}${n > 300 ? ' ' + d.getUTCFullYear() : ''}`;
  return dayLong(v.due, today);
}
/** What Got it would do, for its button: 'Next review tomorrow', 'Next review in 4 days', 'Written on the heart',
 *  'Next review in about three months'; '' for a free practice run. */
export function gotItLabel(v, today, upnext = false) {
  const ch = judge(v, 'got', today, 0, upnext); if (!ch) return '';
  if (v.heart) return 'Next review in about three months';
  if (ch.heart) return 'Written on the heart';
  const n = dayDiff(today, ch.due);
  return n === 1 ? 'Next review tomorrow' : `Next review in ${n} days`;
}

// ------------------------------------------------------------ words
/** The words of a text, each with its punctuation ('world,'); a dash ends a word ('him—', 'and'); ’ and ' stay inside. */
export function tokenize(text) {
  return String(text ?? '').replace(/([—–])(?=\S)/g, '$1 ').split(/\s+/).filter(Boolean);
}
/** A word as typing is compared: lower case, no accents, curly apostrophes straight, punctuation dropped ('' for none). */
export function normWord(w) {
  return String(w ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[‘’ʼ`]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, '').replace(/^'+|'+$/g, '');
}
/** Which words to hide for Fade: level 1 every third from the second, level 2 two of every three; never the first. */
export function fadeMask(n, level) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(i > 0 && (level >= 2 ? i % 3 !== 0 : level === 1 ? i % 3 === 1 : false));
  return out;
}
/** Each word's first letter with its punctuation kept: 'world,' → 'w,', '‘Abba,' → '‘A,', 'LORD’S' → 'L'. */
export function firstLetters(words) {
  return (Array.isArray(words) ? words : []).map(w => {
    const m = /^([^\p{L}\p{N}]*)([\p{L}\p{N}])[\p{L}\p{N}\p{M}’'\-]*(.*)$/u.exec(String(w ?? ''));
    return m ? m[1] + m[2] + m[3] : String(w ?? '');
  });
}
const letters = s => s.replace(/'/g, '').length;
/** At most one edit apart (a letter added, dropped, changed, or two neighbours swapped). */
function oneEdit(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    const d = [];
    for (let i = 0; i < la && d.length < 3; i++) if (a[i] !== b[i]) d.push(i);
    return d.length === 1 || (d.length === 2 && d[1] === d[0] + 1 && a[d[0]] === b[d[1]] && a[d[1]] === b[d[0]]);
  }
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0; while (i < s.length && s[i] === l[i]) i++;
  return s.slice(i) === l.slice(i + 1);
}
const TYPED_MAX = 3000;
/**
 * What was typed against the verse's words (from tokenize): { right, total, missed, extra, typed }. An LCS alignment on
 * normalised words; a word of 5+ letters one edit away still counts (a typo is not a lapse of memory). missed: indexes
 * of verse words not matched; typed: the typed words (tokenize, with 'LORD--you' parted); extra: indexes of typed words
 * not matched. Words with no letters, and verse numbers typed along (digits the verse doesn't have), are not counted
 * either way.
 */
export function compareTyped(verseWords, typed) {
  const vw = Array.isArray(verseWords) ? verseWords : [];
  const V = [], vi = [];
  vw.forEach((w, i) => { const n = normWord(w); if (n) { V.push(n); vi.push(i); } });
  const have = new Set(V), T = [], ti = [];
  // a dash typed as '--' or '-' ('LORD--you', "land'--He") parts two words when a part is a verse word, unless the
  // joined word is a verse word or a typo of a hyphenated one: 'Beth-el', and 'Beth-al' or 'Jehovah-jirah', stay one
  const dash = /[\p{L}\p{N}][^\s\p{L}\p{N}]*-[^\s\p{L}\p{N}]*[\p{L}\p{N}]/u;
  const H = vw.filter(w => dash.test(w)).map(normWord);
  const whole = w => have.has(w) || H.some(v => letters(v) >= 5 && oneEdit(v, w));
  const tw = tokenize(typed).flatMap(t => {
    if (!dash.test(t) || whole(normWord(t))) return [t];
    const p = t.replace(/-+(?=[^\s\p{L}\p{N}]*[\p{L}\p{N}])/gu, '$& ').split(' '), parts = [];
    for (let i = 0, j; i < p.length; i = j + 1) {   // rejoin the longest run that is whole ('people--God-fearing')
      for (j = Math.min(p.length - 1, i + 5); j > i && !whole(normWord(p.slice(i, j + 1).join(''))); j--);
      parts.push(p.slice(i, j + 1).join(''));
    }
    return parts.some(x => have.has(normWord(x))) ? parts : [t];
  });
  for (let i = 0; i < tw.length && T.length < TYPED_MAX; i++) {
    const n = normWord(tw[i]);
    if (n && !(/^\d+$/.test(n) && !have.has(n))) { T.push(n); ti.push(i); }
  }
  const n = V.length, m = T.length, W = m + 1, EX = 4096; // a match scores EX, an exact one EX + 1: most words first, then exact
  const score = (i, j) => (V[i] === T[j] ? EX + 1 : letters(V[i]) >= 5 && oneEdit(V[i], T[j]) ? EX : 0);
  const dp = new Float64Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      let best = Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
      const s = score(i, j); if (s && dp[(i + 1) * W + j + 1] + s > best) best = dp[(i + 1) * W + j + 1] + s;
      dp[i * W + j] = best;
    }
  }
  const missed = [], extra = [];
  let i = 0, j = 0, right = 0;
  while (i < n && j < m) {
    const s = score(i, j);
    if (s && dp[i * W + j] === dp[(i + 1) * W + j + 1] + s) { right++; i++; j++; }
    else if (dp[i * W + j] === dp[(i + 1) * W + j]) { missed.push(vi[i]); i++; }
    else { extra.push(ti[j]); j++; }
  }
  for (; i < n; i++) missed.push(vi[i]);
  for (; j < m; j++) extra.push(ti[j]);
  return { right, total: n, missed, extra, typed: tw };
}
