// memorize-brief §1: the pure model. Run: jsc -m tests/memsched_test.js (prints 'ok N' or throws).
import { GAP, HEART_GAP, STEPS, CAP, isDay, addDays, dayDiff, dayLong, organize, isDue, addPos, frontPos, judge, reviewLabel, whenLabel, gotItLabel, tokenize, normWord, fadeMask, firstLetters, compareTyped } from '../app/js/memsched.js';

let n = 0;
const show = x => JSON.stringify(x);
function eq(a, b, what) {
  n++;
  if (show(a) !== show(b)) throw new Error(`${what}: got ${show(a)}, want ${show(b)}`);
}
const ok = (x, what) => eq(!!x, true, what);

// ------------------------------------------------------------ days
const T = '2026-10-26'; // a Monday
eq([GAP, HEART_GAP, STEPS, CAP], [[1, 2, 4, 7, 14], 90, 6, 4], 'constants');
eq([isDay('2026-10-26'), isDay('2026-02-30'), isDay('2026-1-2'), isDay(''), isDay(null)], [true, false, false, false, false], 'isDay');
eq([addDays(T, 1), addDays(T, 6), addDays('2026-12-31', 1), addDays('2028-02-28', 1), addDays(T, -26)], ['2026-10-27', '2026-11-01', '2027-01-01', '2028-02-29', '2026-09-30'], 'addDays');
eq([dayDiff(T, '2026-10-29'), dayDiff('2026-10-29', T), dayDiff('2026-03-28', '2026-03-30')], [3, -3, 2], 'dayDiff (across a clock change)');
eq([dayLong('2026-10-29'), dayLong('2027-01-24', T), dayLong('2026-11-12', T)], ['Thursday 29 October', 'Sunday 24 January 2027', 'Thursday 12 November'], 'dayLong');

// ------------------------------------------------------------ organize
const mv = (id, o = {}) => ({ id, ref: '43.3.16', tr: 'kjv', pos: 1, step: 0, due: '', heart: '', last: 0, created: 1, updated: 1, ...o });
const a = mv('mv_a', { pos: 3 }), b = mv('mv_b', { pos: 1, created: 5 }), c = mv('mv_c', { pos: 1, created: 2 }), d = mv('mv_d', { pos: -2 });
const h1 = mv('mv_h1', { step: 6, heart: '2026-09-01', due: '2026-10-20' }), h2 = mv('mv_h2', { step: 6, heart: '2026-10-12', due: '2027-01-10' });
const h3 = mv('mv_h3', { step: 6, heart: '2026-08-01', due: '2026-10-26' });
let o = organize([a, h1, b, c, h2, h3], T);
eq([o.current.id, o.upnext.map(v => v.id), o.heart.map(v => v.id), o.dueHeart.map(v => v.id), o.full], ['mv_c', ['mv_b', 'mv_a'], ['mv_h2', 'mv_h1', 'mv_h3'], ['mv_h1', 'mv_h3'], false], 'organize: line by pos then created; heart newest first; due heart most overdue first');
o = organize([a, b, c, d, h1], T);
eq([o.current.id, o.upnext.length, o.full], ['mv_d', 3, true], 'organize: four learning is full (heart verses never count)');
eq(organize([a, b, c, h1, h2, h3], T).full, false, 'organize: three learning and three on the heart is not full');
o = organize([], T);
eq([o.current, o.upnext, o.heart, o.dueHeart, o.full], [null, [], [], [], false], 'organize: empty');
eq(organize([a, b, c, d, mv('mv_e', { pos: 9 })], T).upnext.length, 4, 'organize: five (two devices adding at once) are all shown');
eq([addPos([]), addPos([a, b, h1]), addPos([mv('x', { pos: -4 })]), frontPos([a, b]), frontPos([]), frontPos([h1])], [1, 4, 1, 0, 0, 0], 'addPos and frontPos');

// ------------------------------------------------------------ isDue and judge
eq([isDue(mv('x'), T), isDue(mv('x', { due: '2026-10-26' }), T), isDue(mv('x', { due: '2026-10-20' }), T), isDue(mv('x', { due: '2026-10-27' }), T)], [true, true, true, false], 'isDue: current');
eq([isDue(mv('x'), T, true), isDue(mv('x', { due: '2026-10-20' }), T, true)], [false, false], 'isDue: teed up never');
eq([isDue(h1, T), isDue(h2, T), isDue(h3, T)], [true, false, true], 'isDue: heart');
const h0 = mv('mv_h0', { step: 6, heart: '2026-10-01', due: '' }); // a heart verse whose day was lost (load-time repair)
eq([isDue(h0, T), isDue(h0, T, true), organize([h0], T).dueHeart.map(v => v.id)], [true, true, ['mv_h0']], 'isDue: a heart verse with no day is due now');
const NOW = 1790000000000;
let v = mv('x');
const days = [];
for (let r = 1; r <= 6; r++) {
  const ch = judge(v, 'got', T, NOW, false);
  ok(ch && ch.last === NOW && ch.step === r, `judge: review ${r} recalled`);
  days.push(dayDiff(T, ch.due));
  v = { ...v, ...ch, due: T }; // as if the next review had come round today
  if (r < 6) eq(v.heart, '', `judge: not on the heart after review ${r}`);
}
eq(days, [1, 2, 4, 7, 14, 90], 'judge: gaps 1, 2, 4, 7, 14 days, then about three months');
eq([v.step, v.heart], [6, T], 'judge: review 6 writes it on the heart today');
eq(judge(mv('x', { step: 5, due: '2026-10-20' }), 'got', T, NOW), { step: 6, heart: T, due: addDays(T, 90), last: NOW }, 'judge: review 6 → heart (overdue)');
eq(judge(mv('x', { step: 2, due: T }), 'got', T, NOW), { step: 3, due: addDays(T, 4), last: NOW }, 'judge: review 3 → 4 days');
eq(judge(mv('x', { step: 2, due: T }), 'not', T, NOW), { due: '2026-10-27', last: NOW }, 'judge: Not yet → again tomorrow, step kept');
eq(judge(mv('x'), 'not', T, NOW), { due: '2026-10-27', last: NOW }, 'judge: Not yet on a first practice');
eq(judge(h1, 'got', T, NOW), { due: addDays(T, 90), last: NOW }, 'judge: a due heart verse recalled → about three months');
eq(judge(h1, 'not', T, NOW), { due: '2026-10-27', last: NOW }, 'judge: a due heart verse not yet → tomorrow');
eq([judge(h0, 'got', T, NOW), whenLabel(h0, T), gotItLabel(h0, T)], [{ due: addDays(T, 90), last: NOW }, 'Due today', 'Next review in about three months'], 'judge: a heart verse with no day recalled → about three months');
eq([judge(h2, 'got', T, NOW), judge(mv('x', { step: 2, due: '2026-10-28' }), 'got', T, NOW), judge(mv('x'), 'got', T, NOW, true), judge(mv('x', { due: T }), 'not', T, NOW, true)], [null, null, null, null], 'judge: free practice (heart not due, not due yet, teed up) → null');
eq(judge(mv('x'), 'maybe', T, NOW), null, 'judge: an unknown result changes nothing');

// ------------------------------------------------------------ labels
eq([reviewLabel(mv('x')), reviewLabel(mv('x', { step: 2 })), reviewLabel(mv('x', { step: 5 })), reviewLabel(h1)], ['review 1 of 6', 'review 3 of 6', 'review 6 of 6', 'written on the heart'], 'reviewLabel');
const W = due => whenLabel(mv('x', { step: 1, due }), T);
eq([W(''), W('2026-10-20'), W(T), W('2026-10-27'), W('2026-10-29'), W('2026-11-01'), W('2026-11-02'), W('2026-11-12')], ['Due today', 'Due today', 'Due today', 'Tomorrow', 'Thursday', 'Sunday', 'Monday 2 November', 'Thursday 12 November'], 'whenLabel: learning');
eq([whenLabel(h1, T), whenLabel(h2, T), whenLabel(mv('h', { step: 6, heart: T, due: '2026-10-27' }), T), whenLabel(mv('h', { step: 6, heart: T, due: '2027-11-01' }), T)], ['Due today', 'Next review in January', 'Tomorrow', 'Next review in November 2027'], 'whenLabel: heart');
eq([whenLabel(mv('x'), T, true), whenLabel(mv('x', { due: '2026-10-29' }), T, true), whenLabel(null, T)], ['', '', ''], 'whenLabel: teed up has no day');
eq([gotItLabel(mv('x'), T), gotItLabel(mv('x', { step: 2, due: T }), T), gotItLabel(mv('x', { step: 5, due: T }), T), gotItLabel(h1, T), gotItLabel(h2, T), gotItLabel(mv('x'), T, true)],
  ['Next review tomorrow', 'Next review in 4 days', 'Written on the heart', 'Next review in about three months', '', ''], 'gotItLabel');

// ------------------------------------------------------------ words
const J316 = 'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.';
const jw = tokenize(J316);
eq([jw.length, jw[0], jw[5], jw[24]], [25, 'For', 'world,', 'life.'], 'tokenize: words with their trailing punctuation');
eq(tokenize('Trust in the LORD with all thine heart; the LORD’S day, God’s word, it\'s so.'), ['Trust', 'in', 'the', 'LORD', 'with', 'all', 'thine', 'heart;', 'the', 'LORD’S', 'day,', 'God’s', 'word,', "it's", 'so.'], 'tokenize: apostrophes inside, LORD stays a word');
eq(tokenize('  the Lord GOD—and  he said ‘Abba,’ '), ['the', 'Lord', 'GOD—', 'and', 'he', 'said', '‘Abba,’'], 'tokenize: a dash ends a word, spaces trimmed');
eq([normWord('World,'), normWord('LORD’S'), normWord('‘Abba,’'), normWord('—'), normWord('naïve'), normWord('16')], ['world', "lord's", 'abba', '', 'naive', '16'], 'normWord');
const F = (n, l) => fadeMask(n, l).map(x => (x ? 1 : 0)).join('');
eq([F(10, 0), F(10, 1), F(10, 2), F(1, 2), F(0, 1)], ['0000000000', '0100100100', '0110110110', '0', ''], 'fadeMask: a third, two thirds, never the first word');
eq(firstLetters(['For', 'God', 'so', 'world,', '‘Abba,’', 'LORD’S', 'him—', '—', 'life.']), ['F', 'G', 's', 'w,', '‘A,’', 'L', 'h—', '—', 'l.'], 'firstLetters: punctuation kept');

// ------------------------------------------------------------ compareTyped
let r = compareTyped(jw, J316);
eq([r.right, r.total, r.missed, r.extra], [25, 25, [], []], 'compareTyped: exact');
r = compareTyped(jw, 'for god so loved the world that he gave his only begotten son that whosoever believeth in him should not perish but have everlasting life');
eq([r.right, r.missed, r.extra], [25, [], []], 'compareTyped: punctuation and case ignored');
r = compareTyped(jw, 'For God so loved the world, that he gave his begotten Son, that whosoever believeth in him should not perish, but have everlasting life.');
eq([r.right, r.total, r.missed, r.extra], [24, 25, [10], []], 'compareTyped: a missed word');
r = compareTyped(jw, 'For God so loved the whole world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.');
eq([r.right, r.missed, r.extra, r.typed[5]], [25, [], [5], 'whole'], 'compareTyped: an extra word');
r = compareTyped(jw, 'For God so lovd the wrold, that he gave his only begoten Son, that whosoever beleiveth in him shuold not perish, but have everlasting life.');
eq([r.right, r.missed, r.extra], [25, [], []], 'compareTyped: a typo in a word of 5+ letters still counts');
r = compareTyped(jw, 'For Gd so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting lfe.');
eq([r.right, r.missed, r.extra], [23, [1, 24], [1, 24]], 'compareTyped: a typo in a short word does not');
r = compareTyped(jw, '16 For God so loved the world that he gave his only begotten Son, that whosoever believeth in him should not perish but have everlasting life');
eq([r.right, r.extra], [25, []], 'compareTyped: a verse number typed along is ignored');
r = compareTyped(tokenize('the LORD’S is the earth, and the fulness thereof'), "the Lord's is the earth and the fullness thereof");
eq([r.right, r.total, r.missed], [9, 9, []], 'compareTyped: curly and straight apostrophes, LORD');
r = compareTyped(jw, '');
eq([r.right, r.total, r.missed.length, r.extra, r.typed], [0, 25, 25, [], []], 'compareTyped: nothing typed');
r = compareTyped(tokenize('he said — come'), 'he said come');
eq([r.right, r.total], [3, 3], 'compareTyped: a lone dash is not a word');

print(`ok ${n}`);
