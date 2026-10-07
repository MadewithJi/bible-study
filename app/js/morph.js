// Human-readable morphology for STEPBible / OpenScriptures Hebrew codes and Tauber-style Greek codes.

// Labels are read twice: whole in the interlinear tooltip, and split into chips by drawer.js morphParts(), which keeps a
// "(…)" word on the chip before it — so a qualifier is written "imperfect (conjunctive)", never as a loose second word.
const H = {
  pos: { N: 'noun', V: 'verb', A: 'adjective', P: 'pronoun', R: 'preposition', C: 'conjunction', D: 'adverb', T: 'particle', S: 'suffix' },
  // STEP adds 't' (a title: Pharaoh, Baal, the Red Sea's 'suph').
  nounType: { c: 'common noun', p: 'proper noun', g: 'gentilic noun', t: 'noun (title)' },
  // STEP proper names carry no number or state: Npm/Npf a man or woman, Npl a place, Npt a title (the divine name and
  // Adonai, but equally Dagon or Molech — so it stays the neutral 'title').
  properType: { m: 'masc', f: 'fem', l: '(location)', t: '(title)' },
  adjType: { a: 'adjective', c: 'cardinal', o: 'ordinal', g: 'gentilic' },
  pronType: { d: 'demonstrative', f: 'indefinite', i: 'interrogative', p: 'personal', r: 'relative' },
  // STEP adds 'c' for the conjunctions that are separate words (כִּי 'for', אִם 'if', פֶּן 'lest').
  partType: { a: 'affirmation', c: 'conjunction', d: 'definite article', e: 'exhortation', i: 'interrogative', j: 'interjection', m: 'demonstrative', n: 'negative', o: 'direct object marker', r: 'relative' },
  sufType: { d: 'directional he', h: 'paragogic he', n: 'paragogic nun', p: 'pronominal' },
  stem: { q: 'Qal', N: 'Niphal', p: 'Piel', P: 'Pual', h: 'Hiphil', H: 'Hophal', t: 'Hithpael', o: 'Polel', O: 'Polal', r: 'Hithpolel', m: 'Poel', M: 'Poal', k: 'Palel', K: 'Pulal', Q: 'Qal passive', l: 'Pilpel', L: 'Polpal', f: 'Hithpalpel', D: 'Nithpael', j: 'Pealal', i: 'Pilel', u: 'Hothpaal', c: 'Tiphil', v: 'Hishtaphel', w: 'Nithpalel', y: 'Nithpoel', z: 'Hithpoel' },
  aStem: { q: 'Peal', Q: 'Peil', u: 'Hithpeel', p: 'Pael', P: 'Ithpaal', M: 'Hithpaal', a: 'Aphel', h: 'Haphel', s: 'Saphel', e: 'Shaphel', H: 'Hophal', i: 'Ithpeel', t: 'Hishtaphel', v: 'Ishtaphel', w: 'Hithaphel', o: 'Polel', z: 'Ithpoel', r: 'Hithpolel', f: 'Hithpalpel', b: 'Hephal', c: 'Tiphel', m: 'Poel', l: 'Palpel', L: 'Ithpalpel', O: 'Ithpolel', G: 'Ittaphal' },
  // STEP adds 'u' (weyiqtol: 'so they may serve me'); its cohortative is 'c' + a person, handled in hebrewPart().
  vtype: { p: 'perfect', q: 'sequential perfect', i: 'imperfect', w: 'sequential imperfect', u: 'imperfect (conjunctive)', h: 'cohortative', j: 'jussive', v: 'imperative', r: 'participle active', s: 'participle passive', a: 'infinitive absolute', c: 'infinitive construct' },
  // STEP's 'b' is a word used in both genders: 'masc/fem' on a noun or adjective, but 'common' after a person, as the
  // verbs write it ('I' and 'my' are Pp1bs and Sp1bs, while 'I said' is Vqp1cs).
  person: { 1: '1st', 2: '2nd', 3: '3rd' }, gender: { m: 'masc', f: 'fem', c: 'common', b: 'masc/fem' }, number: { s: 'sing', p: 'plur', d: 'dual' },
  hstate: { a: 'absolute', c: 'construct', d: 'determined' },
};

const pgender = g => (g === 'b' ? 'common' : H.gender[g]); // a gender after a person

function hebrewPart(code, lang) {
  if (!code) return '';
  const p = code[0]; const rest = code.slice(1);
  const out = [];
  switch (p) {
    case 'N': if (rest[0] === 'p') { out.push('proper noun', H.properType[rest[1]]); break; }
      out.push(H.nounType[rest[0]] || 'noun', H.gender[rest[1]], H.number[rest[2]], H.hstate[rest[3]]); break;
    case 'V': {
      // STEP writes the cohortative as 'c' + person ('let us make bricks' = Vqc1cp), and ends each infinitive with a
      // state letter that only repeats its type (Vqcc, Vqaa) — it is never a gender.
      const pgn = /[123]/.test(rest[2] || ''), inf = rest[1] === 'a' || rest[1] === 'c';
      out.push((lang === 'A' ? H.aStem : H.stem)[rest[0]] || '', rest[1] === 'c' && pgn ? 'cohortative' : H.vtype[rest[1]] || 'verb');
      if (pgn) out.push(H.person[rest[2]], pgender(rest[3]), H.number[rest[4]]);
      else if (!inf) out.push(H.gender[rest[2]], H.number[rest[3]], H.hstate[rest[4]]);
      break;
    }
    case 'A': out.push(H.adjType[rest[0]] || 'adjective', H.gender[rest[1]], H.number[rest[2]], H.hstate[rest[3]]); break;
    case 'P': out.push(`${H.pronType[rest[0]] || ''} pronoun`, H.person[rest[1]], H.person[rest[1]] ? pgender(rest[2]) : H.gender[rest[2]], H.number[rest[3]]); break;
    case 'R': out.push(rest[0] === 'd' ? 'preposition + article' : 'preposition'); break;
    case 'C': out.push('conjunction'); break;
    // STEP's lowercase 'c' is the waw of wayyiqtol ('and he said', Hc/Vqw3ms) — H9001, distinct from the plain 'and' (C).
    case 'c': out.push('conjunction (waw-consecutive)'); break;
    case 'D': out.push('adverb'); break;
    // Aramaic 'Ta' is the postpositive article -ā that STEP glosses 'the' (מַלְכָּא 'the king', H9010).
    case 'T': out.push(lang === 'A' && rest[0] === 'a' ? 'definite article' : H.partType[rest[0]] || 'particle'); break;
    case 'S': out.push(`${H.sufType[rest[0]] || ''} suffix`, H.person[rest[1]], H.person[rest[1]] ? pgender(rest[2]) : H.gender[rest[2]], H.number[rest[3]]); break;
    default: return code;
  }
  return out.filter(Boolean).join(' ');
}

const G = {
  tense: { P: 'present', I: 'imperfect', F: 'future', A: 'aorist', R: 'perfect', L: 'pluperfect', X: 'no tense', '2A': '2nd aorist', '2F': '2nd future', '2R': '2nd perfect', '2L': '2nd pluperfect' },
  voice: { A: 'active', M: 'middle', P: 'passive', E: 'middle/passive', D: 'middle deponent', O: 'passive deponent', N: 'middle/passive deponent', Q: 'impersonal active', X: 'no voice' },
  mood: { I: 'indicative', S: 'subjunctive', O: 'optative', M: 'imperative', N: 'infinitive', P: 'participle', R: 'imperative participle' },
  case: { N: 'nominative', G: 'genitive', D: 'dative', A: 'accusative', V: 'vocative' },
  number: { S: 'singular', P: 'plural' }, gender: { M: 'masc', F: 'fem', N: 'neut' },
  pos: { N: 'noun', A: 'adjective', T: 'article', V: 'verb', P: 'personal pronoun', R: 'relative pronoun', C: 'reciprocal pronoun', D: 'demonstrative pronoun', K: 'correlative pronoun', I: 'interrogative pronoun', X: 'indefinite pronoun', Q: 'correlative/interrogative pronoun', F: 'reflexive pronoun', S: 'possessive pronoun', ADV: 'adverb', CONJ: 'conjunction', COND: 'conditional', PRT: 'particle', PREP: 'preposition', INJ: 'interjection', ARAM: 'Aramaic word', HEB: 'Hebrew word', 'N-PRI': 'proper noun (indeclinable)', 'A-NUI': 'numeral (indeclinable)', 'N-LI': 'letter', 'N-OI': 'noun (other indeclinable)',
    // STEP files these under the 'title' name type, but every one is a people's or language's adverb (Ἑβραϊστί 'in
    // Hebrew', Ῥωμαϊστί 'in Latin', Ἰουδαϊκῶς 'like a Jew').
    'ADV-T': 'adverb (gentilic)' },
  // TAGNT's trailing tags: the name type (N-GSM-T θεός, N-NPM-PG Ἰουδαῖοι, N-NSM-LG Ναζωραῖος), extras (A-NSM-C,
  // PRT-N) and transcribed words (N-VSM-ARAM ἠλί, INJ-HEB ἀμήν). One word each, so each makes one morphParts() chip.
  sfx: { T: 'title', P: 'name', L: 'location', G: 'gentilic', PG: 'gentilic (patronymic)', LG: 'gentilic (location)', TG: 'gentilic (title)', LI: 'letter', S: 'superlative', C: 'comparative', I: 'interrogative', N: 'negative', K: 'crasis', ATT: 'Attic form', ABB: 'contracted form', ARAM: 'Aramaic', HEB: 'Hebrew' },
};

const ordinal = d => `${d}${d === '1' ? 'st' : d === '2' ? 'nd' : 'rd'}`;

function greekWord(code) {
  const parts = code.split('-');
  const pos = parts[0];
  if (pos === 'V') {
    const t = parts[1] || ''; const out = ['verb'];
    let i = 0, tense = t[0];
    if (t[0] === '2') { tense = '2' + t[1]; i = 2; } else i = 1;
    // A '2' with no second form of its own (V-2PAN παρεῖναι, V-2PAI-2S ἀφεῖς) keeps its plain tense.
    out.push(G.tense[tense] || G.tense[t[i - 1]], G.voice[t[i]], G.mood[t[i + 1]]);
    const rest = parts[2] || '';
    if (/^[123][SP]$/.test(rest)) out.push(`${ordinal(rest[0])} ${G.number[rest[1]]}`);
    else if (rest.length === 3) out.push(G.case[rest[0]], G.number[rest[1]], G.gender[rest[2]]);
    if (parts[3]) out.push(G.sfx[parts[3]]); // σαβαχθανι V-AAI-2S-ARAM, ἠδυνήθητε V-AOI-2P-ATT
    return out.filter(Boolean).join(' ');
  }
  if (G.pos[code]) return G.pos[code];
  const head = G.pos[pos] || pos;
  const cng = parts[1] || '';
  // An indeclinable word's only tag qualifies it: οὐ PRT-N, πῶς PRT-I, οὐδέ CONJ-N, ποῦ ADV-I, ἀμήν INJ-HEB.
  if (G.sfx[cng]) return `${head} (${G.sfx[cng]})`;
  const tag = parts[2];
  // A person's or place's name (Ἰησοῦς N-NSM-P, Ἱερουσαλήμ N-GSF-L) is a proper noun, as the Hebrew side calls it.
  const proper = pos === 'N' && (tag === 'P' || tag === 'L');
  const out = [proper ? 'proper noun' : head];
  // Possessive S-1SGSN: the possessor's person and number ('my' 1S, 'our' 1P), then the case, number and gender it
  // agrees in. Personal and reflexive pronouns (P-1GS, F-3ASM) carry a person before their own case/number/gender.
  if (pos === 'S' && /^[123][SP]/.test(cng)) out.push(`${ordinal(cng[0])} person`, `${G.number[cng[1]]} (possessor)`, G.case[cng[2]], G.number[cng[3]], G.gender[cng[4]]);
  else if (/^[123]/.test(cng)) out.push(`${ordinal(cng[0])} person`, G.case[cng[1]], G.number[cng[2]], G.gender[cng[3]]);
  else if (cng.length >= 3) out.push(G.case[cng[0]], G.number[cng[1]], G.gender[cng[2]]);
  if (tag && !(proper && tag === 'P')) out.push(G.sfx[tag] || tag);
  return out.filter(Boolean).join(' ');
}

function greek(code) {
  if (!code) return '';
  // A crasis or compound word carries one parsing per part (κἀκεῖνος 'CONJ + D-NSM', οὐκέτι 'PRT-N + ADV'); each part
  // is decoded and joined with '+', as Hebrew prefixes are. (Older data held a Strong's number after the '+'.)
  return code.split(' + ').map(s => /^[GH]\d/.test(s) ? `joined word (${s.replace(/^([GH])0+(?=\d)/, '$1')})` : greekWord(s)).filter(Boolean).join(' + ');
}

export function decodeMorph(code, isHebrew) {
  if (!code) return '';
  if (isHebrew) {
    const lang = code[0]; // H or A
    return code.slice(1).split('/').map(c => hebrewPart(c, lang)).filter(Boolean).join(' + ') + (lang === 'A' ? ' (Aramaic)' : '');
  }
  return greek(code);
}

/**
 * Word type: in TAHOT the word's source (L Leningrad, Q Qere, R restored from a Leningrad parallel, X back-translated
 * from the Septuagint); in TAGNT which Greek editions contain it.
 */
export function wordTypeLabel(t) {
  if (!t) return '';
  if (t[0] === 'X') return 'From the Septuagint (LXX), not in the Hebrew Masoretic text';
  if (/^[LQR]/.test(t)) return { L: 'Leningrad text', Q: 'Qere (scribal correction)', R: 'Restored text' }[t[0]];
  const e = greekEditions(t);
  if (e.N && e.K) return e.major ? 'Variant reading — some editions have a different word here' : t === 'NKO' ? '' : 'Minor difference between editions (same meaning)';
  if (e.K) return 'Only in the Textus Receptus (KJV) — absent from modern critical editions';
  if (e.N) return 'Only in modern critical editions (NA/SBL) — absent from the KJV text';
  return 'Variant reading in other editions';
}
/**
 * TAGNT word type ('NKO', 'N(k)O', 'NK(o)', 'N(K)O', 'ko'…): letters outside brackets are the editions that have this
 * word (N NA/SBL, K Textus Receptus, O others); bracketed letters are editions with a different form — lowercase a
 * minor one that does not change the translation, capital a different word. Either way that edition has the passage.
 */
function greekEditions(t) {
  const out = t.replace(/\([^)]*\)/g, ''), par = (t.match(/\(([^)]*)\)/g) || []).join('');
  return { N: /n/i.test(out + par), K: /k/i.test(out + par), major: /[NK]/.test(par) };
}
/**
 * Words shown amber: Greek words missing from some editions, and the Hebrew words TAHOT adds from the LXX (Gen 4:8
 * 'let us go into the field', 1 Sam 13:1 'thirty'), which are in neither the Leningrad Codex nor the KJV. Q and R
 * words are the Hebrew text translators follow, so they stay plain.
 */
export const isVariantWord = t => { if (!t || /^[LQR]/.test(t)) return false; if (t[0] === 'X') return true; const e = greekEditions(t); return !(e.N && e.K) || e.major; };
/** The short amber-word note for the interlinear tooltip and the drawer's word list ('' for a plain word). */
export function variantShort(t) {
  if (!isVariantWord(t)) return '';
  if (t[0] === 'X') return 'From the LXX — not in the Hebrew text';
  const l = wordTypeLabel(t) || '';
  return /Textus Receptus/i.test(l) ? 'Textus Receptus only' : /critical/i.test(l) ? 'Critical text only' : 'Variant reading';
}
