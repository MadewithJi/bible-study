// Cross-translation highlights: the pure matcher. Run: jsc -m tests/xmatch_test.js (prints 'ok N' or throws).
// The sample sentences are made up on purpose: never Scripture written from memory (AGENTS.md).
import { matchQuote } from '../app/js/xmatch.js';

let n = 0;
const show = x => JSON.stringify(x);
function eq(a, b, what) { n++; if (show(a) !== show(b)) throw new Error(`${what}: got ${show(a)}, want ${show(b)}`); }
const hit = (text, quote) => { const r = matchQuote(text, quote); return r && text.slice(r.i, r.i + r.len); };

const A = 'And the lamp was lit, so that the room was warm and bright.';
eq(matchQuote(A, 'the room was warm'), { i: A.indexOf("the room"), len: 17 }, 'exact');
eq(hit(A, 'the room was warm'), 'the room was warm', 'exact words');
eq(hit('And the lamp was lit so that The Room, was warm.', 'the room was warm'), 'The Room, was warm', 'case and punctuation');
eq(hit('They said, “Don’t be afraid.”', "don't be afraid"), 'Don’t be afraid', 'curly apostrophe');
eq(hit('a lamp lit', 'lamp, lit.'), 'lamp lit', 'quote punctuation');
eq(matchQuote(A, 'the room is warm'), null, 'different words');
eq(matchQuote('the warmth', 'warm'), null, 'whole words only');
eq(matchQuote(A, ''), null, 'empty quote');
eq(matchQuote('', 'lamp'), null, 'empty text');
eq(matchQuote(A, '…'), null, 'no words');
eq(hit('first verse text. second verse text', 'text second'), 'text. second', 'across the verse separator');
const R = 'one cup, and one bowl, and one cup again';
eq(matchQuote(R, 'one cup').i, 0, 'first by default');
eq(matchQuote(R, 'one cup', 30).i, R.lastIndexOf('one cup'), 'nearest the hint');
eq(matchQuote(R, 'One cup', 30).i, R.lastIndexOf('one cup'), 'nearest the hint, word match');
print('ok ' + n);
