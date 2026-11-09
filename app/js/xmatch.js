// Finding a highlight's words again in another translation's text (marks.js, study.js): pure, no DOM.
//
// matchQuote(text, quote, around) -> { i, len } (UTF-16 offsets in `text`, the match nearest offset `around`) or null:
//   1. the quote exactly as written ("God so loved the world" is the same in the KJV and the BSB);
//   2. the same words, whole words only, ignoring case, punctuation and apostrophes ("he gave" / "He gave,").
// Anything looser would guess at a translation's wording, so the caller falls back to the whole verse instead.

/** `s` as lowercase words joined by single spaces, with each character's offset in `s`: { t, at }. */
function norm(s) {
  let t = ' '; const at = [-1];
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "'" || ch === '’' || ch === '‘' || ch === 'ʼ') continue; // don't = dont, Jesus' = Jesus
    if (/[\p{L}\p{N}]/u.test(ch)) { t += ch.toLowerCase(); at.push(k); }
    else if (t[t.length - 1] !== ' ') { t += ' '; at.push(k); }
  }
  if (t[t.length - 1] !== ' ') { t += ' '; at.push(s.length); }
  return { t, at };
}

export function matchQuote(text, quote, around = 0) {
  text = String(text || ''); quote = String(quote || '').trim();
  if (!quote || !text) return null;
  // of several places with the words, the one nearest `around` (where they are in the mark's own translation)
  const near = (best, i) => (best < 0 || Math.abs(i - around) < Math.abs(best - around) ? i : best);
  const word = ch => !!ch && /[\p{L}\p{N}]/u.test(ch);
  let best = -1;
  for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) // never the inside of a longer word
    if (!(word(quote[0]) && word(text[i - 1])) && !(word(quote[quote.length - 1]) && word(text[i + quote.length]))) best = near(best, i);
  if (best >= 0) return { i: best, len: quote.length };
  const q = norm(quote).t; if (q.length < 3) return null; // ' x ' at least: one real word
  const T = norm(text);
  let bj = -1;
  for (let j = T.t.indexOf(q); j >= 0; j = T.t.indexOf(q, j + 1)) bj = bj < 0 || Math.abs(T.at[j + 1] - around) < Math.abs(T.at[bj + 1] - around) ? j : bj;
  if (bj < 0) return null;
  const start = T.at[bj + 1], end = T.at[bj + q.length - 2] + 1; // first and last letters of the match
  return end > start ? { i: start, len: end - start } : null;
}
