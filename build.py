#!/usr/bin/env python3
"""
Build the static data bundle for the Bible study app.

Sources (all free licences, see README):
  KJV            thiagobodruk/bible (public domain text)
  BSB            bereanbible.com/bsb.txt (public domain)
  Cross-refs     OpenBible.info cross_references.txt (CC BY)
  Topics         OpenBible.info topical index, via the Obsidian vault export (CC BY)
  Hebrew/Greek   STEPBible TAHOT + TAGNT (CC BY 4.0)
  Strong's       openscriptures/strongs (CC BY-SA)
  Context        Theographic Bible Metadata: people/places/events/Easton (CC BY-SA 4.0)

Usage:
  python3 build.py --raw raw/ --xref src/cross_references.txt --topics src/topics/
Missing raw files are downloaded automatically.
"""
import argparse, json, os, re, sys, urllib.request, collections, shutil, math, unicodedata, difflib

HERE = os.path.dirname(os.path.abspath(__file__))

# name, osis (OpenBible), step (STEPBible), short, testament, division, aliases
BOOKS = [
 ("Genesis","Gen","Gen","Ge","OT","Pentateuch"), ("Exodus","Exod","Exo","Ex","OT","Pentateuch"),
 ("Leviticus","Lev","Lev","Le","OT","Pentateuch"), ("Numbers","Num","Num","Nu","OT","Pentateuch"),
 ("Deuteronomy","Deut","Deu","De","OT","Pentateuch"), ("Joshua","Josh","Jos","Jos","OT","History"),
 ("Judges","Judg","Jdg","Jdg","OT","History"), ("Ruth","Ruth","Rut","Ru","OT","History"),
 ("1 Samuel","1Sam","1Sa","1Sa","OT","History"), ("2 Samuel","2Sam","2Sa","2Sa","OT","History"),
 ("1 Kings","1Kgs","1Ki","1Ki","OT","History"), ("2 Kings","2Kgs","2Ki","2Ki","OT","History"),
 ("1 Chronicles","1Chr","1Ch","1Ch","OT","History"), ("2 Chronicles","2Chr","2Ch","2Ch","OT","History"),
 ("Ezra","Ezra","Ezr","Ezr","OT","History"), ("Nehemiah","Neh","Neh","Ne","OT","History"),
 ("Esther","Esth","Est","Es","OT","History"), ("Job","Job","Job","Job","OT","Wisdom"),
 ("Psalms","Ps","Psa","Ps","OT","Wisdom"), ("Proverbs","Prov","Pro","Pr","OT","Wisdom"),
 ("Ecclesiastes","Eccl","Ecc","Ec","OT","Wisdom"), ("Song of Songs","Song","Sng","So","OT","Wisdom"),
 ("Isaiah","Isa","Isa","Isa","OT","Major Prophets"), ("Jeremiah","Jer","Jer","Je","OT","Major Prophets"),
 ("Lamentations","Lam","Lam","La","OT","Major Prophets"), ("Ezekiel","Ezek","Ezk","Eze","OT","Major Prophets"),
 ("Daniel","Dan","Dan","Da","OT","Major Prophets"), ("Hosea","Hos","Hos","Ho","OT","Minor Prophets"),
 ("Joel","Joel","Jol","Joe","OT","Minor Prophets"), ("Amos","Amos","Amo","Am","OT","Minor Prophets"),
 ("Obadiah","Obad","Oba","Ob","OT","Minor Prophets"), ("Jonah","Jonah","Jon","Jon","OT","Minor Prophets"),
 ("Micah","Mic","Mic","Mic","OT","Minor Prophets"), ("Nahum","Nah","Nam","Na","OT","Minor Prophets"),
 ("Habakkuk","Hab","Hab","Hab","OT","Minor Prophets"), ("Zephaniah","Zeph","Zep","Zep","OT","Minor Prophets"),
 ("Haggai","Hag","Hag","Hag","OT","Minor Prophets"), ("Zechariah","Zech","Zec","Zec","OT","Minor Prophets"),
 ("Malachi","Mal","Mal","Mal","OT","Minor Prophets"),
 ("Matthew","Matt","Mat","Mt","NT","Gospels"), ("Mark","Mark","Mrk","Mk","NT","Gospels"),
 ("Luke","Luke","Luk","Lk","NT","Gospels"), ("John","John","Jhn","Jn","NT","Gospels"),
 ("Acts","Acts","Act","Ac","NT","History"), ("Romans","Rom","Rom","Ro","NT","Pauline Epistles"),
 ("1 Corinthians","1Cor","1Co","1Co","NT","Pauline Epistles"), ("2 Corinthians","2Cor","2Co","2Co","NT","Pauline Epistles"),
 ("Galatians","Gal","Gal","Ga","NT","Pauline Epistles"), ("Ephesians","Eph","Eph","Eph","NT","Pauline Epistles"),
 ("Philippians","Phil","Php","Php","NT","Pauline Epistles"), ("Colossians","Col","Col","Col","NT","Pauline Epistles"),
 ("1 Thessalonians","1Thess","1Th","1Th","NT","Pauline Epistles"), ("2 Thessalonians","2Thess","2Th","2Th","NT","Pauline Epistles"),
 ("1 Timothy","1Tim","1Ti","1Ti","NT","Pauline Epistles"), ("2 Timothy","2Tim","2Ti","2Ti","NT","Pauline Epistles"),
 ("Titus","Titus","Tit","Tit","NT","Pauline Epistles"), ("Philemon","Phlm","Phm","Phm","NT","Pauline Epistles"),
 ("Hebrews","Heb","Heb","Heb","NT","General Epistles"), ("James","Jas","Jas","Jas","NT","General Epistles"),
 ("1 Peter","1Pet","1Pe","1Pe","NT","General Epistles"), ("2 Peter","2Pet","2Pe","2Pe","NT","General Epistles"),
 ("1 John","1John","1Jn","1Jn","NT","General Epistles"), ("2 John","2John","2Jn","2Jn","NT","General Epistles"),
 ("3 John","3John","3Jn","3Jn","NT","General Epistles"), ("Jude","Jude","Jud","Jud","NT","General Epistles"),
 ("Revelation","Rev","Rev","Re","NT","Apocalyptic"),
]
NAME2IDX = {}
for i, b in enumerate(BOOKS):
    for key in (b[0], b[1], b[2], b[3]):
        NAME2IDX[key.lower()] = i
for alias, name in {
    "psalm":"Psalms","song of solomon":"Song of Songs","canticles":"Song of Songs","songs":"Song of Songs",
    "revelation of john":"Revelation","philemon":"Philemon","phlm":"Philemon","phm":"Philemon",
    "1kgs":"1 Kings","2kgs":"2 Kings","1chr":"1 Chronicles","2chr":"2 Chronicles","sos":"Song of Songs",
}.items():
    NAME2IDX[alias] = NAME2IDX[name.lower()]

def book_idx(name):
    return NAME2IDX.get(name.strip().lower())

RAW_URLS = {
 "kjv.json": "https://raw.githubusercontent.com/thiagobodruk/bible/master/json/en_kjv.json",
 "bsb.txt": "https://bereanbible.com/bsb.txt",
 "strongs-hebrew.js": "https://raw.githubusercontent.com/openscriptures/strongs/master/hebrew/strongs-hebrew-dictionary.js",
 "strongs-greek.js": "https://raw.githubusercontent.com/openscriptures/strongs/master/greek/strongs-greek-dictionary.js",
}
STEP = "https://raw.githubusercontent.com/STEPBible/STEPBible-Data/master/Translators%20Amalgamated%20OT%2BNT/"
for k, f in {"tahot1.txt":"TAHOT%20Gen-Deu%20-%20Translators%20Amalgamated%20Hebrew%20OT%20-%20STEPBible.org%20CC%20BY.txt",
             "tahot2.txt":"TAHOT%20Jos-Est%20-%20Translators%20Amalgamated%20Hebrew%20OT%20-%20STEPBible.org%20CC%20BY.txt",
             "tahot3.txt":"TAHOT%20Job-Sng%20-%20Translators%20Amalgamated%20Hebrew%20OT%20-%20STEPBible.org%20CC%20BY.txt",
             "tahot4.txt":"TAHOT%20Isa-Mal%20-%20Translators%20Amalgamated%20Hebrew%20OT%20-%20STEPBible.org%20CC%20BY.txt",
             "tagnt1.txt":"TAGNT%20Mat-Jhn%20-%20Translators%20Amalgamated%20Greek%20NT%20-%20STEPBible.org%20CC-BY.txt",
             "tagnt2.txt":"TAGNT%20Act-Rev%20-%20Translators%20Amalgamated%20Greek%20NT%20-%20STEPBible.org%20CC-BY.txt"}.items():
    RAW_URLS[k] = STEP + f
TH = "https://raw.githubusercontent.com/robertrouse/theographic-bible-metadata/master/"
for f in ("books","chapters","events","people","places","verses","easton","peopleGroups"):
    RAW_URLS[f"th_{f}.json"] = TH + f"json/{f}.json"
RAW_URLS["pauls_journeys.geojson"] = TH + "geo/pauls_journeys_all.geojson"

def ensure_raw(raw):
    os.makedirs(raw, exist_ok=True)
    for fn, url in RAW_URLS.items():
        p = os.path.join(raw, fn)
        if not os.path.exists(p) or os.path.getsize(p) == 0:
            print(f"  downloading {fn} ...", flush=True)
            urllib.request.urlretrieve(url, p)

def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))

# ---------------------------------------------------------------- translations
# The KJV comes from eBible.org's red-letter USFM edition (1769 text, public domain), which
# marks the words of Jesus with \wj … \wj*. It replaces the older kjv.json, whose text had
# translators' margin notes spliced into 90 verses and stray spaces before punctuation.
KJV_USFM_DIR = os.path.join("usfm", "eng-kjv2006")
KJV_USFM_URL = "https://ebible.org/Scriptures/eng-kjv2006_usfm.zip"
USFM_SKIP_LINE = re.compile(r"^\\(?:s\d?|ms\d?|mr|r|d|sp|cl|h|toc\d|mt\d?|id|ide|rem|sts|usfm)\b.*$", re.M)
USFM_TOKEN = re.compile(
    r"\\f .*?\\f\*|\\x .*?\\x\*"                               # footnotes, cross references
    r"|\\\+?w ([^|\\]*)(?:\|[^\\]*)?\\\+?w\*"                  # \w word|strong="…"\w*
    r"|\\\+?wj\*|\\\+?wj ?"                                    # words of Jesus
    r"|\\\+?[a-z]+\d?\*|\\\+?[a-z]+\d? ?"                      # other character / paragraph markers
    r"|[^\\]+", re.S)
USFM_PARA = {"p", "m", "b", "nb", "pc", "pi", "pi1", "pi2", "q", "q1", "q2", "q3", "q4", "qc", "qr", "li", "li1", "li2", "mi"}

def ensure_kjv_usfm(raw):
    d = os.path.join(raw, KJV_USFM_DIR)
    if os.path.isdir(d) and any(f.endswith(".usfm") for f in os.listdir(d)): return d
    import io, zipfile
    print("  downloading red-letter KJV (eBible.org) ...", flush=True)
    req = urllib.request.Request(KJV_USFM_URL, headers={"User-Agent": "BibleStudyLocal/1.0 (personal study app)"})
    zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(req, timeout=120).read())).extractall(d)
    return d

def usfm_verse(s):
    """One verse of USFM → [(char, is_words_of_jesus)], markup removed, whitespace normalised."""
    chars, wj = [], False
    for m in USFM_TOKEN.finditer(s):
        t = m.group(0)
        if t.startswith(("\\f ", "\\x ")): continue
        if m.group(1) is not None: chars += [(ch, wj) for ch in m.group(1)]; continue
        if re.match(r"\\\+?wj\*", t): wj = False; continue
        if re.match(r"\\\+?wj\b", t): wj = True; continue
        if t.startswith("\\"):
            name = re.match(r"\\\+?([a-z]+\d?)", t).group(1)
            if not t.endswith("*") and name in USFM_PARA: chars.append((" ", wj))
            continue
        chars += [(" " if ch in "¶\n\r\t" else ch, wj) for ch in t]
    out = []
    for i, (ch, f) in enumerate(chars):
        if ch == " ":
            if not out or out[-1][0] == " ": continue
            nxt = next((c for c, _ in chars[i + 1:] if c != " "), "")
            if nxt in ",.;:?!)]": continue            # no space before punctuation
        out.append((ch, f))
    while out and out[-1][0] == " ": out.pop()
    return out

def join_split_words(chars, old):
    """The USFM splits some compounds for Strong's tagging ('can not', 'what soever'); rejoin them where the reference text has one word."""
    if not old: return chars
    words = set(re.findall(r"[\w’']+", old))
    text = "".join(c for c, _ in chars)
    drop = set()
    for m in re.finditer(r"(?<![\w’'])(?=([\w’']+) ([\w’']+)(?![\w’']))", text):   # lookahead: overlapping word pairs
        a, b = m.group(1), m.group(2)
        if a + b in words and f"{a} {b}" not in old: drop.add(m.start() + len(a))
    return [x for i, x in enumerate(chars) if i not in drop]

def runs(chars):
    """Contiguous words-of-Jesus ranges [start, end) over the verse text, trimmed of spaces."""
    rs, s = [], None
    for i, (ch, f) in enumerate(chars + [(" ", False)]):
        if f and s is None: s = i
        elif not f and s is not None: rs.append([s, i]); s = None
    out = []
    for a, b in rs:
        while a < b and chars[a][0] == " ": a += 1
        while b > a and chars[b - 1][0] == " ": b -= 1
        if b > a: out.append([a, b])
    return out

def build_psalm_titles(source, out):
    """The KJV's psalm superscriptions (\\d) and Psalm 119's letter headings (\\s1), kept out of the verse
    text as in a printed KJV. → bibles/kjv/19-titles.json {"sup": {c: text}, "head": {c: {v: text}}}"""
    plain = lambda s: "".join(ch for ch, _ in usfm_verse(s)).strip()
    sup, head = {}, {}
    for cm in re.finditer(r"\\c (\d+)\s(.*?)(?=\\c \d+\s|\Z)", source, re.S):
        c, body = cm.group(1), cm.group(2)
        dm = re.search(r"^\\d (.*)$", body, re.M)
        if dm: sup[c] = plain(dm.group(1))
        for sm in re.finditer(r"^\\s\d? (.*)$\s*(?:\\[a-z]+\d?\s*)*\\v (\d+)", body, re.M):
            head.setdefault(c, {})[sm.group(2)] = plain(sm.group(1)).rstrip(".")
    dump(os.path.join(out, "bibles", "kjv", "19-titles.json"), {"sup": sup, "head": head})
    print(f"  KJV psalm titles: {len(sup)} superscriptions, {sum(map(len, head.values()))} section headings")

def build_kjv(raw, out):
    d = ensure_kjv_usfm(raw)
    old_path = os.path.join(raw, "kjv.json")
    old = json.load(open(old_path, encoding="utf-8-sig")) if os.path.exists(old_path) else None
    files = {}
    for f in os.listdir(d):
        if f.endswith(".usfm"):
            m = re.search(r"\\id (\w+)", open(os.path.join(d, f), encoding="utf-8-sig").read(200))
            if m: files[m.group(1)] = os.path.join(d, f)
    counts, redletter, total_wj = [], [], 0
    for i, b in enumerate(BOOKS):
        code = USFM_CODES[i]
        source = open(files[code], encoding="utf-8-sig").read()
        if code == "PSA": build_psalm_titles(source, out)
        text = USFM_SKIP_LINE.sub("", source)
        chapters, wjmap, n = {}, {}, []
        parts = re.split(r"\\c (\d+)\s", text)
        for k in range(1, len(parts), 2):
            c = int(parts[k]); vs = re.split(r"\\v (\d+)\s", parts[k + 1]); verses = {}
            for j in range(1, len(vs), 2):
                v = int(vs[j]); ref = old[i]["chapters"][c - 1][v - 1] if old else ""
                chars = join_split_words(usfm_verse(vs[j + 1]), ref)
                verses[v] = "".join(ch for ch, _ in chars)
                r = runs(chars)
                if r: wjmap[f"{c}:{v}"] = r; total_wj += 1
            chapters[str(c)] = [verses.get(v, "") for v in range(1, max(verses) + 1)]
            n.append(len(chapters[str(c)]))
        dump(os.path.join(out, "bibles", "kjv", f"{i+1:02d}.json"), chapters)
        if wjmap or i >= 39: dump(os.path.join(out, "redletter", "kjv", f"{i+1:02d}.json"), wjmap)   # every NT book has a file ({} = none), so the reader never 404s
        counts.append(n); redletter.append(wjmap)
    print(f"  KJV: {sum(map(sum, counts))} verses, words of Jesus in {total_wj}")
    return counts, redletter

USFM_CODES = ["GEN","EXO","LEV","NUM","DEU","JOS","JDG","RUT","1SA","2SA","1KI","2KI","1CH","2CH","EZR","NEH","EST","JOB","PSA","PRO",
              "ECC","SNG","ISA","JER","LAM","EZK","DAN","HOS","JOL","AMO","OBA","JON","MIC","NAM","HAB","ZEP","HAG","ZEC","MAL",
              "MAT","MRK","LUK","JHN","ACT","ROM","1CO","2CO","GAL","EPH","PHP","COL","1TH","2TH","1TI","2TI","TIT","PHM","HEB",
              "JAS","1PE","2PE","1JN","2JN","3JN","JUD","REV"]

def quote_segments(text, inside):
    """Top-level “double-quoted” spans in a BSB verse. `inside` = the verse starts within an open quotation.
    A “ met while already inside is a paragraph continuation, not nesting (nested quotes use ‘single’ marks)."""
    segs, start = [], (0 if inside else None)
    for i, ch in enumerate(text):
        if ch == "“" and start is None: start = i
        elif ch == "”" and start is not None: segs.append([start, i + 1]); start = None
    if start is not None: segs.append([start, len(text)])
    return segs, start is not None

def nested_quotes(text, seg):
    """The ‘single-quoted’ spans inside a quoted span (a ’ followed by a letter is an apostrophe: God’s)."""
    out, start = [], None
    for i in range(seg[0], seg[1]):
        ch = text[i]
        if ch == "‘" and start is None: start = i
        elif ch == "’" and start is not None and not text[i + 1:i + 2].isalpha(): out.append([start, i + 1]); start = None
    return out

RL_STOP = set("a an and are art as at be but by did do doth for from had hast hath have he her him his i in is it me my not o of on or our said saith say says shall she so that the thee their them then there they thou thy to unto upon us was we were what when which who whom will with ye you your".split())
def rl_words(s):
    out = set()
    for w in re.findall(r"[a-z]+", s.lower()):
        if w in RL_STOP or len(w) < 3: continue
        for suf in ("eth", "est", "ing", "ed", "es", "s"):
            if w.endswith(suf) and len(w) - len(suf) >= 3: w = w[: -len(suf)]; break
        out.add(w)
    return out

RL_SAY = r"(?:said|says|asked|asks|answered|answers|replied|replies|cried|called|told|shouted|exclaimed|declared|responded|commanded|began|continued|added|insisted|urged|begged|pleaded)"
RL_OTHER = re.compile(r"\b(?:he|she|they|someone|one|man|woman|crowd|people|disciples|Peter|Simon|Judas|Pilate|Thomas|Philip|Martha|Mary|Nicodemus|Nathanael|Andrew|James|John|Satan|devil|demons?|spirit|centurion|soldiers|officials|priests|scribes|Pharisees|Sadducees|Jews|servant|ruler|lawyer|expert|Herod|Caiaphas|Saul|Ananias|master|owner)\b")
def rl_speaker(t, segs, k):
    """Who speaks the k-th quoted span? The BSB capitalises pronouns for Jesus ('He replied') but not for others."""
    a, b = segs[k]
    before = t[(segs[k - 1][1] if k else 0):a]
    after = t[b:(segs[k + 1][0] if k + 1 < len(segs) else len(t))]
    m = re.search(RL_SAY + r"[^.“”?!]*[,:]\s*$", before)
    clause = before[max(0, before.rfind(".", 0, m.start()) + 1):] if m else re.split(r"[.;“]", after, 1)[0]
    if re.search(r"\bJesus\b|\bHe\b|\bthe Lord\b", clause): return "jesus"
    if RL_OTHER.search(clause): return "other"
    return "unknown"

def build_bsb_redletter(out, kjv_redletter):
    """The BSB download has no red-letter markup. Carry the KJV's verse-level marking across,
    choosing the BSB's own quoted speech inside partly-marked verses: every quoted span counts as
    Jesus' words unless it matches the KJV's unmarked (other speakers') words better than the marked ones."""
    stats, over = collections.Counter(), []
    for i in range(39, 66):
        kmap = kjv_redletter[i]
        if not kmap: dump(os.path.join(out, "redletter", "bsb", f"{i+1:02d}.json"), {}); continue
        bsb = json.load(open(os.path.join(out, "bibles", "bsb", f"{i+1:02d}.json"), encoding="utf-8"))
        kjv = json.load(open(os.path.join(out, "bibles", "kjv", f"{i+1:02d}.json"), encoding="utf-8"))
        res, inside = {}, False
        for c in sorted(bsb, key=int):
            for v, t in enumerate(bsb[c], 1):
                was_inside = inside
                segs, inside = quote_segments(t, inside)
                kr = kmap.get(f"{c}:{v}")
                if not kr or not t: continue
                kt = kjv[c][v - 1]
                cover = sum(b - a for a, b in kr) / max(1, len(kt.replace(" ", "")) + kt.count(" "))
                outside = t
                for a, b in reversed(segs): outside = outside[:a] + outside[b:]
                attributed = bool(re.search(r"[A-Za-z]{2,}", outside))    # e.g. “…,” Jesus said, “…”
                if cover > 0.95 and (not segs or not attributed):
                    res[f"{c}:{v}"] = [[0, len(t)]]; stats["whole"] += 1; continue
                if not segs: stats["unresolved"] += 1; continue
                wj_w = rl_words(" ".join(kt[a:b] for a, b in kr))
                rest = kt
                for a, b in reversed(kr): rest = rest[:a] + " " + rest[b:]
                other_w = rl_words(rest)
                keep = []
                for k, s in enumerate(segs):
                    w = rl_words(t[s[0]:s[1]]); d = len(w & wj_w) - len(w & other_w)
                    if d > 0 or (d == 0 and rl_speaker(t, segs, k) != "other"): keep.append(s)
                if not keep:   # fall back to the quoted span nearest the KJV's marked span
                    rel = kr[0][0] / max(1, len(kt))
                    keep = [min(segs, key=lambda s: abs(s[0] / max(1, len(t)) - rel))]; stats["nearest"] += 1
                # a verse inside another speaker's open “…” speech (Paul retelling his conversion in Acts 22 and 26):
                # the Lord's words are the nested ‘…’ spans, not the speech with its 'I asked' and 'He replied'
                if was_inside and keep[0][0] == 0 and sum(b - a for a, b in keep) / len(t) - cover > 0.15:
                    inner = [s for s in nested_quotes(t, keep[0])
                             if len(rl_words(t[s[0]:s[1]]) & wj_w) > len(rl_words(t[s[0]:s[1]]) & other_w)]
                    if inner: keep = inner + keep[1:]; stats["nested"] += 1
                if sum(b - a for a, b in keep) / len(t) - cover > 0.15: over.append(f"{BOOKS[i][1]} {c}:{v}")
                res[f"{c}:{v}"] = keep; stats["quotes"] += 1
        dump(os.path.join(out, "redletter", "bsb", f"{i+1:02d}.json"), res)
    print(f"  BSB words of Jesus: {dict(stats)}")
    if over: print(f"  check: {len(over)} BSB verses mark >15% more of the verse red than the KJV: {', '.join(over[:12])}")

def build_bsb_psalm_titles(raw, out, psalms):
    """The BSB download glues each psalm's superscription onto the front of verse 1; its USFM keeps them apart (\\d).
    Strip them from verse 1 (the text as shown) → bibles/bsb/19-titles.json, the KJV's shape {"sup": {c: text}, "head": {}}."""
    src = open(os.path.join(raw, "usfm", "engbsb", "20-PSAengbsb.usfm"), encoding="utf-8-sig").read()
    sup, missed = {}, []
    for cm in re.finditer(r"\\c (\d+)\s(.*?)(?=\\c \d+\s|\Z)", src, re.S):
        dm = re.search(r"^\\d (.*)$", cm.group(2), re.M)
        if not dm: continue
        c = int(cm.group(1))
        title = re.sub(r"\\f .*?\\f\*", "", dm.group(1))                       # footnotes
        title = re.sub(r"\s+", " ", re.sub(r"\\\+?\w+\*?", "", title)).strip()   # any other markers
        v1 = psalms[c].get(1, "")
        cut = len(title) if v1.startswith(title) else None
        if cut is None:   # Ps 3: the USFM reads 'A Psalms of David', the text 'A Psalm of David'
            tail = title[-15:]; j = v1.find(tail, max(0, len(title) - 20), len(title) + 20)
            if j >= 0 and difflib.SequenceMatcher(None, title, v1[:j + len(tail)]).ratio() > 0.9: cut = j + len(tail)
        if cut is None or not v1[cut:].strip(): missed.append(c); continue
        sup[str(c)] = v1[:cut].strip(); psalms[c][1] = v1[cut:].strip()
    dump(os.path.join(out, "bibles", "bsb", "19-titles.json"), {"sup": sup, "head": {}})
    print(f"  BSB psalm titles: {len(sup)} superscriptions moved out of verse 1")
    if missed: print(f"  WARNING: BSB psalm titles not found in verse 1: {missed}")

def build_bsb(raw, out, counts):
    books = [collections.defaultdict(dict) for _ in BOOKS]
    unmatched = collections.Counter()
    for line in open(os.path.join(raw, "bsb.txt"), encoding="utf-8-sig"):
        line = line.rstrip("\n")
        if "\t" not in line: continue
        ref, text = line.split("\t", 1)
        m = re.match(r"^(.*?)\s+(\d+):(\d+)$", ref.strip())
        if not m: continue
        bi = book_idx(m.group(1))
        if bi is None:
            unmatched[m.group(1)] += 1; continue
        books[bi][int(m.group(2))][int(m.group(3))] = text.strip()
    if unmatched: print("  BSB unmatched book names:", dict(unmatched))
    build_bsb_psalm_titles(raw, out, books[18])
    for i, bk in enumerate(books):
        chapters = {}
        for c in range(1, len(counts[i]) + 1):
            n = max(list(bk.get(c, {}).keys()) + [counts[i][c-1]])
            chapters[str(c)] = [bk.get(c, {}).get(v, "") for v in range(1, n + 1)]
        dump(os.path.join(out, "bibles", "bsb", f"{i+1:02d}.json"), chapters)

# ---------------------------------------------------------------- cross refs
REF_RE = re.compile(r"^([1-3]?[A-Za-z]+)\.(\d+)\.(\d+)$")
def parse_osis(s):
    m = REF_RE.match(s.strip())
    if not m: return None
    bi = book_idx(m.group(1))
    if bi is None: return None
    return (bi, int(m.group(2)), int(m.group(3)))

def build_xrefs(path, out, counts):
    per_book = [collections.defaultdict(list) for _ in BOOKS]
    inbound = [collections.Counter() for _ in BOOKS]  # chapter -> count referenced
    bad, dropped = collections.Counter(), collections.Counter(); n = 0
    with open(path, encoding="utf-8") as f:
        next(f)
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 3: continue
            frm, to, votes = parts[0], parts[1], parts[2]
            try: votes = int(votes)
            except ValueError: continue
            fstart = frm.split("-")[0]
            a = parse_osis(fstart)
            tparts = to.split("-")
            t1 = parse_osis(tparts[0]); t2 = parse_osis(tparts[1]) if len(tparts) > 1 else None
            if a is None or t1 is None:
                bad[fstart.split(".")[0] + "|" + tparts[0].split(".")[0]] += 1; continue
            if votes < 0: dropped["negative votes"] += 1; continue   # readers judged these links unhelpful
            # OpenBible numbers verses as the ESV does: a verse past the KJV's last one (3 John 1:15) is part of it
            if a[1] > len(counts[a[0]]): dropped["source chapter beyond the KJV's"] += 1; continue
            if a[2] > counts[a[0]][a[1] - 1]: a = (a[0], a[1], counts[a[0]][a[1] - 1])
            # end of a range: a verse in the same chapter, or chapter*1000 + verse when it runs into a later
            # chapter of the same book (Heb 6:20–7:3). A range that runs into the next book (2 Chr 36:22–Ezra 1:3)
            # ends at the last verse of its first book.
            end = 0
            if t2 and t2[0] > t1[0]:
                t2 = (t1[0], len(counts[t1[0]]), counts[t1[0]][-1])
            if t2 and t2[0] == t1[0]:
                if t2[1] == t1[1]: end = t2[2] if t2[2] > t1[2] else 0
                elif t2[1] > t1[1]: end = t2[1] * 1000 + t2[2]
            ec, ev = divmod(end, 1000) if end >= 1000 else (t1[1], max(end, t1[2]))
            if t1[0] == a[0] and (t1[1], t1[2]) <= (a[1], a[2]) <= (ec, ev):
                dropped["points back to its own verse"] += 1; continue
            per_book[a[0]][f"{a[1]}:{a[2]}"].append([t1[0]+1, t1[1], t1[2], end, votes])
            inbound[t1[0]][t1[1]] += 1
            n += 1
    if bad: print("  xref unparsed:", bad.most_common(10))
    if dropped: print("  xref dropped:", dict(dropped))
    stats = []
    for i, bk in enumerate(per_book):
        for k in bk: bk[k].sort(key=lambda r: -r[4])
        dump(os.path.join(out, "xref", f"{i+1:02d}.json"), bk)
        outc = collections.Counter()
        for k, v in bk.items(): outc[int(k.split(":")[0])] += len(v)
        stats.append({"out": dict(outc), "in": dict(inbound[i])})
    print(f"  {n} cross-reference links")
    return stats

# ---------------------------------------------------------------- topics
# The vault's topic names are file-safe, so apostrophes were dropped ('Gods Love' reads as plural gods).
# Malformed cross-chapter ranges in the topic vault: each is a garbled copy of a verse the same topic already cites
# (Fasting cites Matt 6:16, Rest Jer 6:16, Fellowship 1 Cor 1:9). None = drop; a tuple = the intended [b, c, v, vend].
TOPIC_RANGE_FIX = {("Fasting", "Matthew 6:1-16:28"): None, ("Rest", "Jeremiah 6:1-16:21"): None,
                   ("Fellowship", "1 Corinthians 1:1-9:27"): None, ("Disabled People", "Mark 7:32-16:20"): (41, 7, 32, 37)}
TOPIC_LABELS = {"Gods Love": "God’s Love", "Gods Love for Us": "God’s Love for Us", "Gods Timing": "God’s Timing",
                "Reading Gods Word": "Reading God’s Word", "Husbands Role": "Husband’s Role", "Refiners Fire": "Refiner’s Fire"}

def build_topics(topics_dir, out):
    topics = []
    if not topics_dir or not os.path.isdir(topics_dir):
        print("  (no topics dir)"); dump(os.path.join(out, "topics.json"), topics); return
    for fn in sorted(os.listdir(topics_dir)):
        if not fn.endswith(".md"): continue
        txt = open(os.path.join(topics_dir, fn), encoding="utf-8").read()
        name = re.search(r'^topic:\s*"(.*?)"', txt, re.M)
        votes = re.search(r"^votes:\s*(\d+)", txt, re.M)
        verses = []
        for m in re.finditer(r"\[\[(.+?)\|(.+?)\]\]\s+—\s+\*([\d,]+) votes\*", txt):
            target, label, v = m.group(1), m.group(2), int(m.group(3).replace(",", ""))
            mm = re.match(r"^(.*)\s(\d+)\.(\d+)$", target)
            if not mm: continue
            bi = book_idx(mm.group(1))
            if bi is None: continue
            vend, c0 = 0, int(mm.group(2))
            key = (name.group(1) if name else fn[:-3], label)
            if key in TOPIC_RANGE_FIX:
                if TOPIC_RANGE_FIX[key]: verses.append([*TOPIC_RANGE_FIX[key], v])
                continue
            me = re.search(r":(\d+)[-–](\d+)(?::(\d+))?$", label)   # '17:1-5' or cross-chapter '17:1-18:24'
            if me and me.group(3):
                if int(me.group(2)) > c0: vend = int(me.group(2)) * 1000 + int(me.group(3))
                if int(me.group(2)) - c0 > 3: print(f"  NOTE: long topic range {key[0]}: {label}")
            elif me: vend = int(me.group(2))
            verses.append([bi+1, c0, int(mm.group(3)), vend, v])
        key = name.group(1) if name else fn[:-3]
        t = {"name": key, "votes": int(votes.group(1)) if votes else 0, "verses": verses}
        if key in TOPIC_LABELS: t["label"] = TOPIC_LABELS[key]   # `name` stays the vault's file-safe key
        topics.append(t)
    topics.sort(key=lambda t: t["name"].lower())
    dump(os.path.join(out, "topics.json"), topics)
    print(f"  {len(topics)} topics")

# ---------------------------------------------------------------- Strong's
def parse_strongs_js(path):
    txt = open(path, encoding="utf-8").read()
    txt = txt[txt.index("{"): txt.rindex("}") + 1]
    return json.loads(txt)

def unbrace(s):
    """The openscriptures text wraps ~250 Hebrew definitions in editorial braces ('{YHWH}'): drop an enclosing pair,
    turn balanced inner ones into parentheses and delete a stray one."""
    s = (s or "").strip()
    if "{" not in s and "}" not in s: return s
    s = re.sub(r"^\{(.*)\}\s*;?$", r"\1", s, flags=re.S).strip()
    if s.count("{") == s.count("}"): s = s.replace("{", "(").replace("}", ")")
    else: s = s.replace("{", "").replace("}", "")
    return s.rstrip(";").strip()

def build_strongs(raw, out):
    res = {}
    for lang, fn in (("H", "strongs-hebrew.js"), ("G", "strongs-greek.js")):
        d = parse_strongs_js(os.path.join(raw, fn))
        compact = {}
        for k, v in d.items():
            der, sdef = v.get("derivation", ""), unbrace(v.get("strongs_def", ""))
            if not sdef and der:   # 20 Greek entries keep their meaning in the derivation: 'of uncertain affinity; beautiful…'
                p = re.split(r"(?:;|:|(?<!\bi\.e)(?<!\be\.g)\.)\s+", der.strip(), 1)
                der, sdef = (p[0].strip(), p[1].strip()) if len(p) == 2 and p[1].strip() else ("", der.strip())
            compact[k] = {"l": v.get("lemma", ""), "x": v.get("xlit") or v.get("translit", ""), "p": v.get("pron", ""),
                          "d": der, "s": sdef, "k": unbrace(v.get("kjv_def", ""))}
        dump(os.path.join(out, "strongs", f"{lang}.json"), compact)
        res[lang] = len(compact)
    print(f"  Strong's entries: {res}")

# ---------------------------------------------------------------- interlinear
# STEP references use NRSV versification with an optional alternate: (..) NA/Hebrew, [..] KJV, {..} other.
# Groups: 1 book, 2 chapter, 3 verse, 4 (..), 5 [..], 6 {..}, 7 word number, 8 word type (full, e.g. 'N(k)O').
STEP_REF = re.compile(r"^([1-3]?[A-Za-z]+)\.(\d+)\.(\d+)(?:\(([^)]*)\)|\[([^\]]*)\]|\{([^}]*)\})?#(\d+)=([^\t ]+)")
def norm_strong(s):
    m = re.match(r"^([HG])0*(\d+)", s or "")
    return f"{m.group(1)}{m.group(2)}" if m else ""

# STEP's extended Greek numbers (G6000+ etc.) are not in Strong's dictionary. Map the ones that are
# just another spelling of a classic entry; the rest get a minimal dictionary entry from TAGNT.
GREEK_STRONG_MAP = {"G6063": "G1492",    # οἶδα 'know' = εἴδω
                    "G20447": "G1999"}   # ἐπίστασις: a typo in the source; its Alt Strongs column gives G1999
HEB_GRAMMAR = re.compile(r"^H90\d\d$")   # STEP morpheme ids (prefixes, suffixes, punctuation), not lexicon words
HEB_MARKS = ("פ", "ס", "׆")   # petuchah/setumah paragraph marks and the inverted nun: STEP files them as extra word segments
HEB_BAD_STEP_LEMMA = {"H1419", "H5145", "H8042"}   # STEP tags גָּדוֹל 'great' as גַּל, נֶזֶר as נָסָה, 'left' as יְמָנִי
# TR-order verses the BSB, ESV and NLT divide as the NRSV does: their Greek also goes under orig 'nrsv' by NRSV place
NRSV_ORDER = {("Php", 1, 16), ("Php", 1, 17), ("Rev", 12, 18)}
def greek_base(w):
    return "".join(ch for ch in unicodedata.normalize("NFD", w) if ch.isalpha()).lower()

def build_interlinear(raw, out, counts):
    conc = collections.defaultdict(list)
    books = [collections.defaultdict(lambda: collections.defaultdict(list)) for _ in BOOKS]
    hdict = json.load(open(os.path.join(out, "strongs", "H.json"), encoding="utf-8"))
    gpath = os.path.join(out, "strongs", "G.json")
    gdict = json.load(open(gpath, encoding="utf-8"))
    skipped, unmatched = collections.Counter(), collections.Counter()
    word_line = re.compile(r"^[1-3]?[A-Za-z]+\.\d+\.\d+\S*#\d+=")
    # Hebrew
    for fn in ("tahot1.txt", "tahot2.txt", "tahot3.txt", "tahot4.txt"):
        for line in open(os.path.join(raw, fn), encoding="utf-8"):
            m = STEP_REF.match(line)
            if not m:
                if word_line.match(line): unmatched[fn] += 1
                continue
            typ = re.match(r"\w+", m.group(8)).group(0)   # Hebrew: the edition letters only ('Q(K)' → 'Q')
            if typ[0] not in "LQRX": skipped[typ] += 1; continue
            cols = line.rstrip("\n").split("\t")
            if len(cols) < 6: continue
            bi = book_idx(m.group(1))
            if bi is None: skipped["book:" + m.group(1)] += 1; continue
            # a Qere of two words ('בָּא//גָד') keeps its space; paragraph marks ('אֶחָֽד\׃\ \פ') are not part of the word
            segs = [g for g in cols[1].replace("//", " ").split("\\") if g.strip() not in HEB_MARKS]
            heb = re.sub(r"[/\\]", "", "\\".join(segs)).strip()
            if not heb: skipped["ketiv-only"] += 1; continue   # written but not read: no word to show
            translit = re.sub(r"\.?//", " ", cols[2]).replace("/", "").strip()
            gloss = re.sub(r"\s+", " ", cols[3].replace("/ ", " ").replace("/", " ")).strip()
            dstrong = cols[4]
            # every lexical root: a compound or two-word Qere has more than one ('{H0001}/{H5703}' 'Everlasting Father')
            roots = list(dict.fromkeys(k for k in (norm_strong(r) for r in re.findall(r"\{([^}]+)\}", dstrong)) if k and not HEB_GRAMMAR.match(k)))
            strong = roots[0] if roots else norm_strong(dstrong.split("/")[0])
            prefixes = [norm_strong(p) for p in re.findall(r"(H\d{4}\w?)", re.sub(r"\{[^}]*\}", "", dstrong))] if "{" in dstrong else []
            morph = cols[5].strip()
            lemma = ""
            if len(cols) > 11:
                lm = re.search(r"\{(H\d+)\w*=([^=}]+)=", cols[11])
                if lm and not HEB_GRAMMAR.match(norm_strong(lm.group(1))): lemma = lm.group(2)
            if HEB_GRAMMAR.match(strong): strong = ""   # preposition + pronoun suffix (לוֹ 'to him'): grammar, no lexicon entry
            if strong in HEB_BAD_STEP_LEMMA and strong in hdict: lemma = hdict[strong]["l"]
            ch, vs = int(m.group(2)), int(m.group(3))
            # verse 0 = a psalm's title: kept apart as 'c:0' (its own row under the title, not verse 1's words)
            # word[7]: the prefix morphemes (H90xx), then any further lexical roots (as a Greek compound's parts)
            books[bi][ch][vs].append([heb, translit, gloss, strong, morph, lemma, typ,
                                      [p for p in prefixes if p and p not in ("H9014", "H9015", "H9016", "H9017", "H9018", "H9019")] + roots[1:]])
            for s in ([strong] if strong else []) + roots[1:]: conc[s].append((bi+1) * 1000000 + ch * 1000 + vs)
    # Greek
    extra_greek = {}
    gkeys = {}   # (book, c, v, word index) → the Strong's numbers that word put in conc
    nrsv_moves = collections.defaultdict(list)   # book → [('c:v' by NRSV order, word)]
    for fn in ("tagnt1.txt", "tagnt2.txt"):
        for line in open(os.path.join(raw, fn), encoding="utf-8"):
            m = STEP_REF.match(line)
            if not m:
                if word_line.match(line): unmatched[fn] += 1
                continue
            cols = line.rstrip("\n").split("\t")
            if len(cols) < 6: continue
            bi = book_idx(m.group(1))
            if bi is None: skipped["book:" + m.group(1)] += 1; continue
            typ = m.group(8)   # full code, e.g. 'N(k)O': letters outside () = editions with this word
            gw = re.match(r"^(.*?)\s*\(([^)]*)\)\s*$", cols[1].strip())
            greek, translit = (gw.group(1), gw.group(2)) if gw else (cols[1].strip(), "")
            greek = re.sub(r"[¶¬\[\]]", "", greek).strip()   # STEP paragraph marks, NA's [[double brackets]] and '¬' are editorial, not Greek text
            if "ēa" in translit and any("\u0342" in g and "\u0345" in g for g in re.findall(r"[ηΗ][\u0300-\u036f]+", unicodedata.normalize("NFD", greek))):
                translit = translit.replace("ēa", "ē")   # STEP writes ῇ as 'ēa' (τῇ 'tēa'), ῃ as 'ē'
            gloss = re.sub(r"^[\[{(][\d.]+[a-z]?[\]})]\s*", "", cols[2].strip())   # '[15] Lord,' → 'Lord,'
            # a compound (crasis) word carries one Strong's=grammar pair per component: 'G2532=CONJ + G1565=D-NSM'
            parts = [(GREEK_STRONG_MAP.get(norm_strong(s), norm_strong(s)), g) for s, g in re.findall(r"(G\d+\w?)=([^\s+]+)", cols[3])]
            strong, morph = parts[0] if parts else ("", "")
            if len(parts) > 1: morph = " + ".join(g for _, g in parts)
            # the traditional Strong's numbers (column 12) that STEP folds into its own: ἡμῶν G2257, ἐστί G2076, ὑμῖν G5213
            alts = list(dict.fromkeys(x for x in (norm_strong(y.strip()) for y in (cols[12] if len(cols) > 12 else "").split(",")) if x.startswith("G")))
            # STEP files ἡμῶν/ὑμῖν/μου under G3165 'me' and G4771 'thou': the traditional number is the word's own entry
            # (the one spelled like the word when the editions differ: 'G2248, , G2257' for ἡμῶν)
            if len(parts) == 1 and strong in ("G3165", "G4771"):
                own = [x for x in alts if x in gdict and greek_base(gdict[x]["l"]) == greek_base(greek)]
                if not own and len(alts) == 1 and alts[0] in gdict: own = alts
                if own: strong = own[0]; parts = [(strong, morph)]
            lemma = cols[4].split("=")[0] if cols[4] else ""
            for s, _ in parts:
                if s and s not in extra_greek:
                    extra_greek[s] = cols[4].split("=", 1) if s == strong else ["", ""]
            ch, vs = int(m.group(2)), int(m.group(3))
            if m.group(5):   # [..] = the KJV's chapter.verse, which is what the app shows
                kc, _, kv = m.group(5).partition(".")
                if kc.isdigit() and kv.isdigit(): ch, vs = int(kc), int(kv)
            rec, words = [greek, translit, gloss, strong, morph, lemma, typ, [s for s, _ in parts[1:] if s]], books[bi][ch][vs]
            # every displayed word, so a word's own verse is always in its concordance, and its traditional numbers
            keys = [s for s, _ in parts if s] + alts
            gkeys[(bi, ch, vs, len(words))] = keys
            words.append(rec)
            for s in keys: conc[s].append((bi+1) * 1000000 + ch * 1000 + vs)
            if (m.group(1), int(m.group(2)), int(m.group(3))) in NRSV_ORDER:
                nc, nv = int(m.group(2)), int(m.group(3))
                nrsv_moves[bi].append((f"{nc}:{min(nv, counts[bi][nc - 1])}", rec))   # Rev 12:18 is part of 12:17
    # TR subscriptions ('Πρὸς Τιμόθεον δευτέρα … ἐγράφη ἀπὸ Ῥώμης … Νέρωνι'): K-only words after the closing ἀμήν of an
    # epistle's last verse. A colophon, not verse text in any edition: left out of the verse and the concordance.
    nsub = 0
    for bi in range(39, 66):
        ch, vs = len(counts[bi]), counts[bi][-1]
        words = books[bi].get(ch, {}).get(vs) or []
        am = max((k for k, w in enumerate(words) if greek_base(w[0]) == "αμην"), default=-1)
        tail = words[am + 1:]
        if am < 0 or not any(greek_base(w[0]).startswith("εγραφ") for w in tail): continue
        if not all(set(re.sub(r"\([^)]*\)", "", w[6])) <= set("Kk") for w in tail): continue
        for k in range(am + 1, len(words)):
            for s in gkeys[(bi, ch, vs, k)]: conc[s].remove((bi+1) * 1000000 + ch * 1000 + vs)
        del words[am + 1:]; nsub += 1
    print(f"  {nsub} Textus Receptus subscriptions left out of their epistle's last verse")
    # the BSB/ESV/NLT verse division of NRSV_ORDER verses: orig 'nrsv' = {'c:v': words} for the verses it changes
    nrsv = {}
    for bi, moves in nrsv_moves.items():
        moved = {id(w) for _, w in moves}
        keys = {k for k, _ in moves} | {f"{c}:{v}" for c, vv in books[bi].items() for v, ws in vv.items() if any(id(w) in moved for w in ws)}
        nrsv[bi] = {k: [w for w in books[bi][int(k.split(":")[0])][int(k.split(":")[1])] if id(w) not in moved] + [w for nk, w in moves if nk == k]
                    for k in sorted(keys)}
    if skipped: print("  interlinear skipped:", dict(skipped.most_common(8)))
    if unmatched: print("  interlinear WARNING — unparsed word lines:", dict(unmatched))
    # minimal dictionary entries for STEP-only Greek numbers, so the lexicon view is never empty
    added = 0
    for s, (lem, gl) in sorted(extra_greek.items()):
        if s not in gdict and s.startswith("G"):
            gdict[s] = {"l": lem.strip(), "x": "", "p": "", "d": "Extended Strong’s number (STEPBible)", "s": gl.strip().replace("_", " "), "k": ""}
            added += 1
    if added: dump(gpath, gdict); print(f"  {added} STEP-only Greek numbers given dictionary entries")
    nwords = 0
    for i, bk in enumerate(books):
        if not bk: continue
        outbk = {}
        for ch, verses in bk.items():
            for vs, words in verses.items():
                outbk[f"{ch}:{vs}"] = words; nwords += len(words)
        if i in nrsv: outbk["nrsv"] = nrsv[i]
        dump(os.path.join(out, "orig", f"{i+1:02d}.json"), outbk)
    # concordance: one file per Strong's number, de-duplicated & ordered
    cdir = os.path.join(out, "conc")
    if os.path.isdir(cdir): shutil.rmtree(cdir)
    os.makedirs(cdir)
    for s, refs in conc.items():
        refs = sorted(set(refs))
        if not refs: continue
        with open(os.path.join(cdir, s + ".json"), "w") as f: json.dump(refs, f, separators=(",", ":"))
    print(f"  {nwords} tagged words, {len(conc)} concordance entries")
    bare = [f"{BOOKS[i][0]} {c}:{v}" for i in range(39, 66) for c, n in enumerate(counts[i], 1)
            for v in range(1, n + 1) if not books[i].get(c, {}).get(v)]
    if bare: print(f"  NOTE: {len(bare)} KJV New Testament verses have no Greek words: {', '.join(bare[:12])}")
    # Aramaic passages (Dan 2:4–7:28, Ezra 4:8–6:18 and 7:12–26, Jer 10:11): the verses most of whose words have an
    # Aramaic morph code ('A…'), per book index {chapter: [verses]}, for meta.json's books (their 'aram')
    aram = {}
    for i, bk in enumerate(books[:39]):
        for ch, verses in sorted(bk.items()):
            vs = [v for v, ws in sorted(verses.items()) if v and sum(w[4][:1] == "A" for w in ws) * 2 > len(ws)]
            if vs: aram.setdefault(i, {})[str(ch)] = vs
    print(f"  {sum(len(v) for x in aram.values() for v in x.values())} Aramaic verses in {', '.join(BOOKS[i][0] for i in aram)}")
    return aram

# ---------------------------------------------------------------- Theographic context
# The Lystra crowd's names for Barnabas and Paul (Acts 14:12) are false gods'; not also-called names
PAGAN_AKA = {"Jupiter", "Mercurius", "Zeus", "Hermes"}
DIVINE = {
    "god_1324": {"title": "God", "role": "The LORD God Almighty, Creator of heaven and earth",
                 "aka": "LORD (YHWH), Lord, Father, Almighty, Most High, Holy One of Israel"},
    # No dates: a 'born …; crucified …' pair reads as a lifespan. The Events list dates the birth and the cross.
    "jesus_905": {"title": "Jesus Christ", "role": "The Son of God, the Word made flesh; crucified, risen and ascended",
                  "aka": "Christ, Messiah, Son of God, Son of Man, Lord, Lamb of God, the Word, Emmanuel"},
    "holy_spirit_7400": {"title": "The Holy Spirit", "role": "The Spirit of God",
                         "aka": "Holy Ghost, Spirit of God, Comforter"},
}

HUMAN_TITLES = {"jesus_904": "Jesus called Justus"}  # Col 4:11 — a companion of Paul, not Christ
# Names Theographic misspells (KJV Acts 24:27 'Porcius Festus', Matt 20:20 'Zebedee’s', 1 Chr 2:47, 2:49, 'Phillip').
# n is the name Find searches for: Festus, as 12 of his 13 verses call him.
PERSON_NAME_FIX = {
    "portius_2367": {"n": "Festus", "t": "Porcius Festus"},
    "mother_of_zebedees_children_2112": {"n": "Mother of Zebedee’s children", "t": "Mother of Zebedee’s children"},
    "gesham_1306": {"n": "Geshan", "t": "Geshan"},
    "achsa_67": {"n": "Achsah", "t": "Achsah"},
    "philip_2344": {"t": "Philip the Apostle"}, "philip_2347": {"t": "Philip the Evangelist"},
}

# Theographic also files Satan, angels and the gods of the nations as persons. Ji: they are not people and
# must not appear in People or anywhere in the Context panel — removed from every generated file.
# Real men who share a name stay: Adrammelech son of Sennacherib (104), the human Michaels (2058–2067),
# Baal of Reuben and of Benjamin (574, 575), Malcham the Benjamite (1900, below).
NON_HUMAN = {
    "satan_2476": "Satan, the adversary",
    "apollyon_2": "Abaddon/Apollyon, the angel of the bottomless pit (Rev 9:11)",
    "lucifer_1832": "Lucifer (Isa 14:12), traditionally read as Satan",
    "gabriel_1261": "the angel Gabriel",
    "michael_2068": "Michael the archangel",
    "adrammelech_103": "Adrammelech, the Sepharvite god (2 Ki 17:31)",
    "anammelech_254": "Anammelech, the Sepharvite god",
    "ashtoreth_341": "Ashtoreth, goddess of the Sidonians",
    "baal_573": "Baal, the Canaanite god",
    "baal-zebub_579": "Baal-zebub, god of Ekron",
    "chemosh_931": "Chemosh, god of Moab",
    "dagon_969": "Dagon, god of the Philistines",
    "diana_1008": "Diana (Artemis) of the Ephesians",
    "milcom_2084": "Milcom, god of the Ammonites",
    "molech_2104": "Molech, god of the Ammonites",
}
# Theographic merges Malcham the Benjamite (1 Chr 8:9) with the Ammonite god (Zeph 1:5): keep the man only.
PERSON_VERSE_DROP = {"malcham_1900": {"Zeph.1.5", "Jer.49.1", "Jer.49.3", "2Sam.12.30"},
                     "gog_1326": {"Rev.20.8"}, "magog_1882": {"Rev.20.8"},   # there 'Gog and Magog' are the nations
                     # 'Hen' son of Zephaniah (Zech 6:14) merged with the hen of Christ's lament
                     "josiah_1731": {"Matt.23.37", "Luke.13.34"}}
# Verse tags Theographic gets wrong, most of them the Godhead's. Its possessives are swapped ('Christ’s' tagged God,
# 'God’s' tagged Christ); 'Jesus' in Heb 4:8 is Joshua (the BSB's word, and Acts 7:45's tag); the 'Fathers' of
# Col 3:21 and 'whose God is their belly' (Phil 3:19) are not God, and 1 Cor 15:23 and Phil 2:21 name Christ alone;
# five verses naming him lack his tag. osisRef: {tagged slug: the right slug, or None to drop it; "+": slug to add}
VERSE_PEOPLE_FIX = {
    "Heb.4.8": {"jesus_905": "joshua_1727"}, "1Pet.5.3": {"jesus_905": "god_1324"},
    **{r: {"god_1324": "jesus_905"} for r in ("2Cor.10.7", "2Cor.12.10", "Gal.3.29", "Gal.5.24", "1Pet.4.13")},
    **{r: {"god_1324": None} for r in ("Col.3.21", "Phil.3.19", "1Cor.15.23", "Phil.2.21")},
    **{r: {"+": "jesus_905"} for r in ("Eph.4.32", "Mark.16.9", "Luke.7.37", "Luke.19.1", "John.9.1")},
}
# Easton articles Theographic attaches to the wrong person or place (a namesake's, or another sense of the word).
# slug: the Easton entry (termLabel, itemNum) that describes it, or None: no article rather than another's.
DICT_FIX = {
    "malcham_1900": None,                  # Easton's 'Malcam' is the Ammonite idol; it has none on the Benjamite
    "josiah_1731": None,                   # 'Hen' (Zech 6:14) given Easton's article on the bird
    "nathan_2155": None,                   # Nathan of 1 Chr 2:36, a Jerahmeelite, given the prophet's life
    "abel_4": ("Abel-beth-maachah", 0),    # the town of 2 Sam 20, given Abel son of Adam
    "bilhah_249": ("Balah", 0),            # the Simeonite town (1 Chr 4:29), given Rachel's handmaid
    "ham_514": None,                       # the Zuzim's town (Gen 14:5), given Noah's son
    "nebo_883": ("Nebo", 3),               # the town of Reuben and Moab, given the Babylonian god
    "baal-peor_145": None,                 # Peor (Hos 9:10), given Easton's article on its god
    "gaius_1269": ("Gaius", 1),            # Acts 19:29, seized with Aristarchus at Ephesus (Easton matched only 1271)
    "igeal_595": ("Igal", 3),              # 1 Chr 3:22 (Easton spells him Igal)
    "malchijah_1912": ("Malchiah", 5),     # Neh 3:11 (Easton spells him Malchiah)
}

# Source errors in Theographic lifespans (Seth's death year transposed; a born-after-death pair; Miriam dated
# centuries after Moses; Rachel born two years before Jacob met her; Ruth born two centuries after her book).
# Applied last, after the lifespans are put on the events' chronology (below).
PERSON_FIX = {
    "seth_2504": {"d": -2962},        # Gen 5:8: 912 years
    "samson_2468": {"b": None, "d": None, "y0": None, "y1": None},
    "miriam_2087": {"b": None, "d": None},
    "rachel_2386": {"b": None},
    "ruth_2450": {"b": None},
    "abijah_38": {"d": -955},         # 'Death of Abijam' (1 Ki 15:8); the source has 907 BC, after Asa's reign began
    "athaliah_359": {"d": -878},      # slain at the end of her six years (2 Ki 11:3, 16)
    "zedekiah_1950": {"b": -618},     # 21 at his accession in 597 BC (2 Ki 24:18); he died later in Babylon
}
# Theographic's kings of Judah live on a Thiele-like chronology (born after their reign began, dying decades from
# their 'Death of' event) while its events and verses follow Ussher. Put them on the events' chronology:
# born = the 'Reign of' event − age at accession (from the text); died = the 'Death of' event, else the reign's end.
KING_ACCESSION = {   # slug: ('Reign of' event id, age at accession)
    "rehoboam_2412": (165, 41), "jehoshaphat_808": (181, 35), "jehoram_803": (188, 32), "ahaziah_121": (189, 22),
    "joash_1632": (193, 7), "amaziah_214": (198, 25), "uzziah_375": (204, 16), "jotham_1735": (219, 25),
    "ahaz_118": (221, 20), "hezekiah_1512": (226, 25), "manasseh_1930": (228, 12), "amon_236": (231, 22),
    "josiah_1730": (233, 8),
}
# Genealogies that list people long before (1 Chr 1–9, dated to the patriarchs) or long after (Matt 1, Luke 3,
# dated to Christ) their own lives: they do not date when a person first appears. (0-based book, from, to)
GENEALOGY_RANGES = [(12, (1, 1), (9, 999)), (39, (1, 1), (1, 17)), (41, (3, 23), (3, 38))]

# Verse years (Theographic yearNum, Ussher's chronology) that contradict the events of their own passage.
# (0-based book, from (ch, v), to (ch, v), year); None = no year of its own (the chapter's applies).
VERSE_YEAR_FIX = [
    (39, (1, 1), (1, 17), None),      # Matthew 1:1–17, the genealogy (AD 26 in the source)
    (39, (1, 18), (1, 25), -5),       # Matthew 1:18–25, before the birth (AD 26)
    # The source dates Matthew 3–4, Mark 1 and Luke 3–4 on Theographic's event chronology (ministry from AD 26)
    # and garbles John 1–2 (AD 5, 4 BC). Every other Gospel chapter, like the events below, is on Ussher's:
    # baptism AD 29, first Passover AD 30 (John 2–3), Galilee AD 31–32, the cross AD 33.
    (39, (3, 1), (4, 11), 29), (39, (4, 12), (4, 999), 30),
    (40, (1, 1), (1, 13), 29), (40, (1, 14), (1, 999), 30),
    (40, (6, 1), (6, 999), 32),       # Mark 6 (AD 28): Matthew 14, Luke 9 and John 6 are AD 32
    (40, (10, 1), (10, 999), 33),     # Mark 10 (AD 29): Matthew 19–20 and Luke 18 are AD 33
    (41, (2, 1), (2, 40), -4),        # Luke 2:1–40, the birth and the presentation (AD 4)
    (41, (3, 1), (3, 23), 29), (41, (3, 24), (3, 38), None), (41, (4, 1), (4, 13), 29), (41, (4, 14), (4, 999), 30),
    (42, (1, 1), (1, 5), None),       # John 1:1–5, the Word in the beginning (4004 BC and AD 5)
    (42, (1, 6), (2, 999), 30),
    (17, (1, 1), (42, 15), -1650),    # Job: 'Job's Trial' (1520 BC, after his own death)
    (17, (42, 16), (42, 17), -1580),  # Job 42:16–17: 'Death of Job'
    (31, (1, 1), (4, 999), -825),     # Jonah: 'Prophecies of Jonah', under Jeroboam II (2 Ki 14:25) (862 BC)
    (33, (1, 1), (3, 999), -663),     # Nahum: after the fall of Thebes (Nah 3:8–10), 'Prophecies of Nahum' (713 BC)
    (34, (1, 1), (3, 999), -607),     # Habakkuk: 'Prophecies of Habakkuk' (626 BC)
    (38, (1, 1), (4, 999), -430),     # Malachi, with event 247 below (397 BC)
    (36, (1, 1), (2, 999), -520),     # Haggai: 'the second year of Darius' (Hag 1:1), 'Prophecies of Haggai' (no year)
    # Chapters the source leaves undated, on the chronology of the chapters and events beside them:
    (3, (33, 1), (33, 999), -1452),   # Numbers 33, in the plains of Moab (33:50), as Numbers 32 and 34
    (6, (5, 1), (5, 999), -1285),     # Judges 5, Deborah's song: as Judges 4:4–24, with it event 139
    (10, (7, 1), (7, 999), -1005),    # 1 Kings 7, the temple's work ended (7:51; 6:38): after ch. 6 (1011 BC), before ch. 8 (1004 BC)
    (10, (12, 1), (12, 999), -975),   # 1 Kings 12, the kingdom divided: events 165–167, as 1 Kings 11:43
    (12, (13, 1), (13, 999), -1042),  # 1 Chronicles 13, the ark from Kiriath-jearim: as its parallel 2 Samuel 6 and as 1 Chr 15
    (14, (1, 1), (3, 7), -536),       # Ezra 1–3:7, 'the first year of Cyrus' (1:1), as 2 Chr 36:22 and Ezra 5:13
    (14, (3, 8), (3, 999), -535),     # Ezra 3:8–13, 'in the second year of their coming', the temple's foundation laid
]

def in_ranges(p, ranges):
    """The first (book, from, to, …) range holding verse p = (book, ch, v), or None."""
    return next((r for r in ranges if r[0] == p[0] and r[1] <= (p[1], p[2]) <= r[2]), None)

# Event errata: mis-parsed verses and dates in Theographic (0-based book index).
EVENT_VERSE_DROP = {129: {(0, 34, 1)},     # 'Death of Moses' tagged on Gen 34:1 (a mis-parse of Deut 34:1)
                    107: {(0, 46, 13)},    # 'Birth of Job' / 'Lifetime of Job' on Gen 46:13, where 'Job' is
                    108: {(0, 46, 13)}}    #   Issachar's son Jashub, not the man of Uz
EVENT_FIX = {67: {"y": -1209, "sk": -1209},   # Judgeship of Jair (Judg 10:3–5), dated -1991 in the source
             183: {"y": -889},   # Death of Jehoshaphat: after his 25 years from 914 BC (1 Ki 22:42, 50), not 909
             133: {"y": -1427},  # Death of Joshua: Josh 24:29 is 1427 BC (1424 in the source)
             124: {"y": -1537},  # Lifetime of Joshua: 110 years (Josh 24:29) to his death (1521 BC: 97 years)
             247: {"y": -430},   # Prophecies of Malachi: c. 430 BC, with the verses above
             202: {"y": -800}, 235: {"y": -630},   # Prophecies of Joel and of Zephaniah: their verses' years
             264: {"y": 8}, 265: {"y": 8}}   # Jesus at twelve in the Temple (Luke 2:41–52 is AD 8)
# Theographic gives '1D' to 300 of 449 events as a default (Job's Trial, the Tabernacle built), so '1D' is read as
# unknown; these are the lengths the text states.
EVENT_DUR_FIX = {268: "40D",   # Temptations of Jesus (Matt 4:2)
                 460: "40D"}   # Resurrection and Ascension (Acts 1:3)
EVENT_TITLE_FIX = {
    # Context names no angel, demon or false god (Ji): these say what happens to the people instead
    253: "Joseph Takes Mary as His Wife", 283: "Jesus Heals a Man in the Capernaum Synagogue",
    303: "Jesus Heals a Blind and Mute Man; the Discourse that Follows", 335: "Peter Is Freed from Prison",
    353: "Paul Frees a Slave Girl at Philippi", 387: "Jesus Heals the Men of the Gadarenes", 407: "Jesus Heals a Boy",
    250: "The Annunciation", 406: "The Transfiguration", 433: "Lazarus Raised from the Dead",
    259: "Jesus Circumcised", 154: "Samson Pulls Down the House at Gaza", 290: "Parable of the Wineskins",
    402: "Discourse with Pharisees and Sadducees", 237: "Reign of Jehoahaz (Shallum)",
    201: "Death of Jehoash (Joash)",   # Israel's king, as 'Reign of Jehoash' (197); 'Joash' dates him (below)
    30: "Death of Mahalaleel", 440: "Zacchaeus Converted and Parable of the Pounds",
    318: "Gamaliel Advises the Council; Apostles Freed", 100: "Birth of Zebulun", 139: "Deliverance by Barak and Deborah",
    13: "Birth of Mahalaleel", 14: "Lifetime of Mahalaleel",
    # editors' shorthand, shown as it stands in the chapter hero
    360: "Mission to Corinth; 1 and 2 Thessalonians Written", 364: "Mission to Ephesus; 1 Corinthians Written",
    410: "Teachings on Humility, Temptation and Reconciliation", 420: "Light of the World and I Am Discourse",
}

# Places whose Theographic coordinates came from a wrong gazetteer match (reviewed against OpenBible and
# the biblical text). link=False drops the gazetteer link, which pointed at the wrong place; n, ft, prec
# and dict replace those fields. UNLOCATED: no credible site (the source's own value for such places).
UNLOCATED = {"lat": None, "lon": None, "prec": "Unlocated", "link": False}
PLACE_FIX = {
    # Towns of Simeon in the Negev, all pinned in Gilead (32.05, 35.73): Baal, Baalath-beer, Bethel (of
    # Judah), Bethuel, Bethul, Chesil, Eltolad, Ezem, Iim, Ramoth (of the Negev), Tolad
    **{i: UNLOCATED for i in (133, 138, 203, 240, 241, 289, 380, 422, 593, 982, 1174)},
    # Unidentified places pinned on a namesake: Kiriathaim (Kartan) and Zer of Naphtali (at Hammon in Asher),
    # Aphekah of Judah (at Antipatris), Lud (a people, at Lod), the wilderness stations Rimmon-perez, Libnah,
    # Rithmah and Laban (Num 33:19-21, Deut 1:1, at a point in the Shephelah)
    **{i: UNLOCATED for i in (696, 672, 1252, 74, 735, 1007, 729, 1009, 710)},
    1004: {"lat": 31.370, "lon": 34.870, "prec": "Rough", "link": False},   # Rimmon of the Negev (not Syria)
    568: {"lat": 30.660, "lon": 34.370, "prec": "Rough"},   # Hezron, west of Kadesh-barnea (not Hazor)
    583: {"lat": 33.240, "lon": 35.220, "prec": "Rough"},   # Hosah, by Tyre (Josh 19:29; not by Shechem)
    905: {"lat": 31.700, "lon": 35.800, "prec": "Rough"},   # Nophah of Moab, by Medeba (not the Hauran)
    621: {"lat": 32.156, "lon": 35.362},   # Janoah of Ephraim (Josh 16:6-7) ...
    622: {"lat": 33.260, "lon": 35.303},   # ... and of Naphtali (2 Ki 15:29): the source swaps them
    1245: {"lat": 31.950, "lon": 34.950, "prec": "Rough"},  # Zeboim of Benjamin, by Lod (Neh 11:34)
    # Source-editor notes in the alias and comment fields, and a wrong alias (Josh 15:8 names the valley of
    # Hinnom and the valley of Rephaim apart)
    828: {"aka": ""},    # Mount of Olives: '4b is just "mount" or "mountain"'
    1214: {"aka": ""},   # Valley of Rephaim: 'valley of Hinnom'
    1022: {"c": ""},     # Samaria: 'Acts 8:5 "city" of Samaria'
    518: {"lat": 32.770, "lon": 35.550},   # Hammath of Naphtali, by Tiberias (not Hammon in Asher)
    520: {"lat": 32.770, "lon": 35.550, "prec": "Rough"},   # Hammoth-dor, probably the same
    667: {"lat": 33.210, "lon": 35.300, "prec": "Rough"},   # Kanah of Asher, south-east of Tyre (not Cana)
    125: {"lat": 31.917, "lon": 35.261, "prec": "Rough", "link": False},   # Ayyah by Bethel (KJV 'Gaza')
    655: {"lat": 32.838, "lon": 35.276, "prec": "Rough"},   # Jotbah = Yodfat in Galilee (not Jotbathah)
    87: {"lat": 37.972, "lon": 23.723, "link": False},      # Areopagus (the link and pin were Kollytos)
    111: {"link": False}, 108: {"link": False},   # Assyria → Dur-Sharrukin; Asia (the province) → 'Asia Minor'
    # Names Theographic cut to the last tagged word ('Place', 'Tower') are taken from esvName; these fix the rest
    287: {"dict": ""},   # Tel-cherub (Ezra 2:59): Easton's article there is on the cherubim
    585: {"ft": "Landmark", "dict": ""},   # House of the Forest of Lebanon, Solomon's hall (not the Lebanon range)
    244: {"lat": None, "lon": None},       # Beyond the River, the province west of the Euphrates (not Jerusalem)
    958: {"n": "Potsherd Gate"},           # Jer 19:2 (KJV 'east gate'), not the East Gate of Neh 3:29
    687: {"lat": 31.772, "lon": 35.237, "link": False},    # Kidron valley, Jerusalem (not the coastal plain)
    476: {"lat": 31.864, "lon": 35.519, "link": False},    # Gilgal by Jericho (not Jaljulia)
    643: {"lat": 32.556, "lon": 35.331, "link": False},    # Jezreel in the valley (Ahab's city)
    642: {"lat": 31.536, "lon": 35.094, "link": False},    # Jezreel in the hill country of Judah (Josh 15:56)
    1020: {"lat": 35.212, "lon": 26.274, "link": False},   # Salmone, the cape of Crete (not Elis)
    590: {"lat": 37.871, "lon": 32.485},                   # Iconium = Konya
    919: {"lat": 34.754, "lon": 32.400},                   # (New) Paphos, where Paul met Sergius Paulus
    929: {"lat": 31.040, "lon": 32.540, "link": False},    # Pelusium (Sin), on the Nile delta
    357: {"lat": 30.735, "lon": 35.606},                   # Edom, south-east of the Dead Sea
    693: {"link": False}, 785: {"link": False}, 277: {"link": False}, 972: {"link": False},
}
# Places a verse rightly names far from the towns listed with it (the far end of a border, a voyage)
PLACE_FAR_OK = {654, 839, 151, 296}   # Plain of Jordan (Gen 13:10), Halak (Josh 11:17), Babylon, Chios
# Records of one place under another of its names: {id: the place's own record}
PLACE_SAME = {954: 487, 1153: 487}   # 'the place of a skull' is Golgotha's gloss (Matt 27:33, John 19:17)
# Verses tagged with a namesake of the place they name: {(book, chapter, verse): {tagged id: right id or None}}
_MOUNT_CARMEL = {278: 831}   # Carmel of Judah → Mount Carmel ('Carmel by the sea', 'the top of Carmel')
VERSE_PLACE_FIX = {
    **{v: _MOUNT_CARMEL for v in [(5, 12, 22), (5, 19, 26), (21, 7, 5), (22, 33, 9), (22, 35, 2), (23, 46, 18),
                                  (23, 50, 19), (29, 1, 2), (29, 9, 3), (33, 1, 4)]},
    (5, 15, 60): {966: None},   # Rabbah of Judah, not Rabbah of the Ammonites (Amman)
    (5, 19, 37): {358: None},   # Edrei of Naphtali, not Edrei of Bashan
    (5, 19, 30): {71: None},    # Aphek of Asher, not Aphek (Afqa) in Lebanon
    # 'followed Baal-peor' (Deut 4:3), 'joined themselves unto Baal-peor' (Ps 106:28): the god, not a place (NON_HUMAN)
    (4, 4, 3): {145: None}, (18, 106, 28): {145: None},
}
# Paul's journeys (Theographic's GeoJSON): stop references that do not name the stop, and stray values
PAUL_FIX = {
    "Seleucia": {"first": "Acts.13.4"},
    "Perga": {"first": "Acts.13.13,Acts.14.25"},
    "Three Taverns": {"rome": "Acts.28.15"},
    "Iconium": {"Notes": "Not mentioned by name in the third journey; mapped as a likely stop within the region."},
    "Antipatris": {"Notes": ""},
}

def year_of(s):
    """Theographic years: an int, a string, or an ISO date ('0030-04-04', '-0586-…'); 0 means unknown."""
    m = re.match(r"^\s*(-?)0*(\d+)", str(s if s is not None else ""))
    y = int(m.group(1) + m.group(2)) if m else None
    return y or None

# Gazetteer links from Theographic's Recogito match (recogitoUri). Always https.
#   pleiades.stoa.org/places/N -> Pleiades (CC BY)
#   dare.ht.lu.se/places/N     -> DARE; that host is dead. dh.gu.se/dare/... is a single-page portal with
#                                 no DARE route (soft 404 for every id), so link the author's live
#                                 gazetteer, which serves the same ids and 404s unknown ones.
#   sws.geonames.org/N         -> GeoNames (modern place)
# Other hosts (maps.cga.harvard.edu = China Historical GIS: false matches) are skipped.
PLACE_LINK_RULES = [
    ("pleiades", re.compile(r"^https?://(?:www\.)?pleiades\.stoa\.org/places/(\d+)/?$"), "https://pleiades.stoa.org/places/{}"),
    ("dare",     re.compile(r"^https?://dare\.ht\.lu\.se/places/(\d+)/?$"),                 "https://imperium.ahlfeldt.se/places/{}.html"),
    ("geonames", re.compile(r"^https?://(?:sws|www)\.geonames\.org/(\d+)/?$"),              "https://www.geonames.org/{}"),
]
# Only 181 of the 432 matches are VERIFIED; UNVERIFIED ones are often homonyms elsewhere in the world
# (Acco -> Acopampa, Peru). Keep an UNVERIFIED match only when its coordinates agree with the place's,
# or, for areas (regions, waters) whose centroids legitimately differ, when the matched name agrees too.
LINK_NEAR_KM, LINK_AREA_KM = 10, 300

def _km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))

def _nm(s):
    s = unicodedata.normalize("NFKD", s)
    return re.sub(r"[^a-z]", "", "".join(c for c in s if not unicodedata.combining(c)).lower())

def place_links(f, lat, lon):
    uri = (f.get("recogitoUri") or "").strip()
    for key, rx, tpl in PLACE_LINK_RULES:
        m = rx.match(uri)
        if m: break
    else:
        return {}
    if f.get("recogitoStatus") != "VERIFIED":
        try: rlat, rlon = float(f.get("recogitoLat")), float(f.get("recogitoLon"))
        except (TypeError, ValueError): return {}
        if lat is None or lon is None: return {}
        d = _km(lat, lon, rlat, rlon)
        if d > LINK_NEAR_KM:
            area = f.get("featureType") in ("Region", "Water") or f.get("precision") == "Related-Surrounding"
            if not area or d > LINK_AREA_KM: return {}
            names = {_nm(x) for x in [f.get("kjvName"), f.get("esvName"), f.get("displayTitle"), *(f.get("aliases") or "").split(",")] if x}
            alts = set()
            for part in (f.get("recogitoLabel") or "").split("|"):
                for seg in part.split(","):
                    for a in seg.split("/"):
                        alts.update({_nm(re.sub(r"\([^)]*\)", "", a)), _nm(a)})
            if not (names - {""}) & alts: return {}
    return {key: tpl.format(m.group(1))}

def build_context(raw, out, intros):
    L = lambda n: json.load(open(os.path.join(raw, f"th_{n}.json"), encoding="utf-8"))
    tb, tc, te, tp, tpl, tv, tg = L("books"), L("chapters"), L("events"), L("people"), L("places"), L("verses"), L("peopleGroups")
    rec2person = {r["id"]: r["fields"]["personID"] for r in tp}
    rec2place = {r["id"]: r["fields"]["placeID"] for r in tpl}
    rec2event = {r["id"]: r["fields"]["eventID"] for r in te}
    rec2verse = {}
    for r in tv:
        f = r["fields"]; p = parse_osis(f.get("osisRef", ""))
        if p: rec2verse[r["id"]] = p
    def clip(t, n=1400):
        if not t: return ""
        t = t if isinstance(t, str) else " ".join(t)
        t = re.sub(r"\]\([^)]*\)", "]", t).replace("[", "").replace("]", "")   # Markdown links → their text
        t = re.sub(r"(?<=\w)_|_(?=[\w’'])", "", t).strip()                        # Easton's stray italic underscores
        t = t.replace("eternity (Heb. 9:4)", "eternity (Heb. 9:14)")               # Easton, 'Holy Ghost': Heb 9:14
        return t if len(t) <= n else t[:n].rsplit(" ", 1)[0] + " …"
    yr = year_of

    slug2id = {r["fields"].get("personLookup"): r["fields"]["personID"] for r in tp}
    non_human = {slug2id[s] for s in NON_HUMAN if s in slug2id}
    missing = [s for s in NON_HUMAN if s not in slug2id]
    if missing: print("  WARNING: NON_HUMAN entries not found:", missing)
    rec2person = {k: v for k, v in rec2person.items() if v not in non_human}   # gone from every list built below
    person_drop = {slug2id[s]: {parse_osis(r) for r in refs} for s, refs in PERSON_VERSE_DROP.items() if s in slug2id}
    bad = [s for fx in VERSE_PEOPLE_FIX.values() for kv in fx.items() for s in kv if s not in ("+", None, *slug2id)]
    assert not bad, f"VERSE_PEOPLE_FIX names unknown people: {bad}"
    verse_fix = {parse_osis(r): {slug2id.get(k, k): slug2id.get(v) for k, v in fx.items()} for r, fx in VERSE_PEOPLE_FIX.items()}
    def verse_people(p, recs):
        """The people verse p names (Theographic person record ids recs), with the verse errata above applied."""
        fx = verse_fix.get(p, {})
        ids = [fx.get(i, i) for i in (rec2person[x] for x in recs if x in rec2person) if p not in person_drop.get(i, ())]
        return list(dict.fromkeys(i for i in ids + [fx.get("+")] if i is not None))

    # Easton's articles as Theographic links them ('eastons'), to check that each one describes its person or place
    eas = {r["id"]: r["fields"] for r in L("easton")}
    eas_item = {(f["termLabel"], f.get("itemNum", 0)): f.get("dictText", "") for f in eas.values()}
    eas_slugs = lambda e: set(re.findall(r"[\w-]+_\d+", e.get("matchSlugs") or ""))   # whom Easton matched it to
    cites = lambda t: {parse_osis(x) for x in re.findall(r"#(\w+\.\d+\.\d+)", t or "")} - {None}
    vset = lambda f: {rec2verse[x] for x in f.get("verses", []) if x in rec2verse}
    def own_sense(f, text):
        """Easton puts several senses of a word in one article, each later one opening '<Word>, …' (the lot cast,
        then 'Lot, … the son of Haran'; the patriarch, then 'Noah, … one of the five daughters of Zelophehad').
        Keep the senses that cite a verse naming this person or place; the whole text when none or all do."""
        if not text: return ""
        text = text if isinstance(text, str) else " ".join(text)
        for head in {eas[x]["termLabel"] for x in f.get("eastons", []) if x in eas}:
            senses = []
            for para in text.split("\n\n"):
                if not senses or re.match(rf"\s*{re.escape(head)},", para): senses.append(para)
                else: senses[-1] += "\n\n" + para
            hit = [s for s in senses if cites(s) & vset(f)]
            if hit and len(hit) < len(senses): return "\n\n".join(hit).strip()
        return text
    def fixed_dict(f, text):
        slug = f.get("personLookup") or f.get("placeLookup")
        return (eas_item[DICT_FIX[slug]] if DICT_FIX[slug] else "") if slug in DICT_FIX else own_sense(f, text)

    people, raw_dict = {}, {}
    for r in tp:
        f = r["fields"]
        if f["personID"] in non_human: continue
        dict_text = f.get("dictText") or f.get("dictionaryText")
        if f.get("personLookup") in HUMAN_TITLES and dict_text:
            # Justus: Theographic appends Easton's whole article on the Lord Jesus after his one-line entry
            dict_text = (dict_text if isinstance(dict_text, str) else " ".join(dict_text)).split("\n\n")[0]
        dict_text = raw_dict[f["personID"]] = fixed_dict(f, dict_text)
        people[f["personID"]] = {
            "n": f.get("name", ""), "t": f.get("displayTitle", ""), "g": f.get("gender", ""),
            "b": yr(f.get("birthYear")), "d": yr(f.get("deathYear")), "y0": yr(f.get("minYear")), "y1": yr(f.get("maxYear")),
            "aka": ",".join(a for a in f.get("alsoCalled", "").split(",") if a.strip() not in PAGAN_AKA), "vc": f.get("verseCount", 0),
            "fa": [rec2person.get(x) for x in f.get("father", []) if x in rec2person],
            "mo": [rec2person.get(x) for x in f.get("mother", []) if x in rec2person],
            "ch": [rec2person.get(x) for x in f.get("children", []) if x in rec2person],
            "pt": [rec2person.get(x) for x in f.get("partners", []) if x in rec2person],
            "bp": [rec2place.get(x) for x in f.get("birthPlace", []) if x in rec2place],
            "dp": [rec2place.get(x) for x in f.get("deathPlace", []) if x in rec2place],
            "dict": clip(dict_text),
            "amb": bool(f.get("ambiguous")), "proper": bool(f.get("isProperName", True)),
        }
    # One Easton article given to several people (King Manasseh given Joseph's son, Medan given Dedan, Asahiah given
    # Isaiah) stays with those Easton matched it to, else those it is named for, and with a namesake whose verse its
    # first sentence cites (Heman of 1 Ki 4:31 and 1 Chr 2:6). The rest take an Easton article matched to them, or
    # none: no article is better than another person's life.
    shared = collections.defaultdict(list)
    for r in tp:
        f = r["fields"]
        if people.get(f["personID"], {}).get("dict") and f.get("personLookup") not in DIVINE:
            shared[people[f["personID"]]["dict"]].append(f)
    for fs in (fs for fs in shared.values() if len(fs) > 1):
        e = next((eas[x] for f in fs for x in f.get("eastons", []) if x in eas), None)
        if not e:
            print(f"  WARNING: an article shared by {[f['personLookup'] for f in fs]} has no Easton entry to check"); continue
        titled = lambda f: e["termLabel"] in (f.get("name"), *(f.get("alsoCalled") or "").split(","))
        own = [f for f in fs if f["personLookup"] in eas_slugs(e)] or [f for f in fs if titled(f)]
        for f in fs:
            first = re.split(r"\.\s+(?=[A-Z])", raw_dict[f["personID"]], maxsplit=1)[0]
            if f in own or f["personLookup"] in DICT_FIX or (titled(f) and cites(first) & vset(f)): continue
            alt = sorted((x for x in eas.values() if f["personLookup"] in eas_slugs(x) and x is not e and x.get("dictText")),
                         key=lambda x: x.get("itemNum", 0))
            people[f["personID"]]["dict"] = clip(own_sense(f, alt[0]["dictText"])) if alt else ""
    # verse counts with the verse errata (dropped, moved and added tags)
    touched = set(person_drop) | {i for fx in verse_fix.values() for kv in fx.items() for i in kv if isinstance(i, int)}
    vcount = collections.Counter(i for r in tv if r["id"] in rec2verse
                                 for i in verse_people(rec2verse[r["id"]], r["fields"].get("people", [])) if i in touched)
    for pid in touched & set(people): people[pid]["vc"] = vcount[pid]
    for slug, fix in PERSON_NAME_FIX.items():
        if slug in slug2id: people[slug2id[slug]].update(fix)
    # Theographic files God, Christ and the Holy Spirit as "people" with lifespans and genealogy.
    # Mark them divine instead: no dates, no parents/children, never counted among people.
    divine_ids = set()
    for slug, d in DIVINE.items():
        pid = slug2id.get(slug)
        if pid is None:
            print(f"  WARNING: divine entry {slug} not found in Theographic people"); continue
        divine_ids.add(pid)
        p = people[pid]
        p.update({"dv": 1, "t": d["title"], "role": d["role"], "aka": d["aka"],
                  "b": None, "d": None, "y0": None, "y1": None, "fa": [], "mo": [], "ch": [], "pt": [], "bp": [], "dp": []})
    for slug, title in HUMAN_TITLES.items():
        if slug in slug2id: people[slug2id[slug]]["t"] = title
    if "jesus_904" in slug2id: people[slug2id["jesus_904"]]["n"] = "Justus"   # the name to search for
    for p in people.values():
        for k in ("fa", "mo", "ch", "pt"):
            p[k] = [x for x in p[k] if x not in divine_ids]
    places = {}
    for r in tpl:
        f = r["fields"]
        fix = PLACE_FIX.get(f["placeID"], {})
        lat = f.get("latitude") or f.get("openBibleLat"); lon = f.get("longitude") or f.get("openBibleLong")
        try: lat, lon = float(lat), float(lon)
        except (TypeError, ValueError): lat = lon = None
        if "lat" in fix: lat, lon = fix["lat"], fix["lon"]
        # For some multi-word names displayTitle/kjvName hold only the last tagged word ('Place' for 'Place of
        # a Skull', 'There' for 'The Lord Is There'); esvName has the whole name. kjv stays the KJV's word.
        n, esv = f.get("displayTitle") or f.get("kjvName", ""), (f.get("esvName") or "").strip()
        if esv and len(esv.split()) > len(n.split()) and re.search(rf"\b{re.escape(n)}\b", esv, re.I): n = esv
        places[f["placeID"]] = {
            "n": n, "kjv": f.get("kjvName", ""), "esv": f.get("esvName", ""),
            "lat": lat, "lon": lon, "ft": f.get("featureType", ""), "aka": f.get("aliases", ""), "c": f.get("comment", ""),
            "vc": f.get("verseCount", 0), "prec": f.get("precision", ""), "dict": clip(fixed_dict(f, f.get("dictText") or f.get("dictionaryText"))),
        }
        places[f["placeID"]].update({k: fix[k] for k in ("n", "ft", "prec", "dict", "aka", "c") if k in fix})
        links = place_links(f, lat, lon) if fix.get("link", True) else {}
        if links: places[f["placeID"]]["links"] = links
    # Theographic has duplicate records of one place (same name and point; 'Judea' and 'Judea', the Mount of
    # Olives twice), which a chapter would list and count twice. Keep the most-cited record of each, with the
    # feature type when one has it, and point every verse and event at it. Records of different kinds (the
    # city of Cabul and the land of Cabul) stay apart.
    place_alias, dup = {}, collections.defaultdict(list)
    def merge(i, into):
        keep = places[into]; place_alias[i] = into; keep["vc"] = (keep["vc"] or 0) + (places[i]["vc"] or 0)
        for k in ("dict", "links"):
            if not keep.get(k) and places[i].get(k): keep[k] = places[i][k]
        del places[i]
    for i, into in PLACE_SAME.items(): merge(i, into)
    for pid, pl in places.items():
        if pl["lat"] is not None: dup[(pl["n"].lower(), round(pl["lat"], 4), round(pl["lon"], 4))].append(pid)
    for ids in dup.values():
        ids.sort(key=lambda i: (not places[i]["ft"], -(places[i]["vc"] or 0), i))
        for i in ids[1:]:
            if places[i]["ft"] in ("", places[ids[0]]["ft"]): merge(i, ids[0])
    for k, pid in rec2place.items(): rec2place[k] = place_alias.get(pid, pid)
    for (b, c, v), fx in VERSE_PLACE_FIX.items():
        assert all(i in places and (j is None or j in places) for i, j in fx.items()), f"VERSE_PLACE_FIX {b+1}:{c}:{v}"
    # verse years (Theographic yearNum, Ussher's chronology), with the passages that contradict their own events fixed
    verse_year = {}
    for r in tv:
        p = parse_osis(r["fields"].get("osisRef", ""))
        if not p: continue
        fix = in_ranges(p, VERSE_YEAR_FIX)
        y = fix[3] if fix else r["fields"].get("yearNum")
        if y is not None: verse_year[p] = y
    chapter_year = {}   # the chapter's most common verse year, as the hero chip and the 'When' fallback show it
    for (b, c, y), _ in sorted(collections.Counter((b, c, y) for (b, c, _), y in sorted(verse_year.items())).items(),
                               key=lambda kv: -kv[1]):
        chapter_year.setdefault((b, c), y)
    events, raw_year = {}, {}
    for r in te:
        f = r["fields"]; eid = f["eventID"]
        vrefs = sorted({rec2verse[x] for x in f.get("verses", []) if x in rec2verse} - EVENT_VERSE_DROP.get(eid, set()))
        if eid in EVENT_VERSE_DROP and not vrefs: continue
        y, sk = year_of(f.get("startDate")), f.get("sortKey", 0)
        raw_year[eid] = y
        vy = collections.Counter(verse_year[x] for x in vrefs if x in verse_year)
        nt = bool(vrefs) and all(x[0] >= 39 for x in vrefs)
        dur = "" if f.get("duration") == "1D" else f.get("duration", "")   # the source's default, not a length
        if y is not None and y < 0 and (not vy or not 0 <= min(vy) - y <= 2 or f.get("title", "").startswith("Lifetime of")):
            # startDate is ISO (astronomical: -4003 = 4004 BC); verse and people years count BC (-4004).
            # Some events are already in BC numbering: their first verse falls in that year or just after
            # (a lifetime's verses come later in life, so it always converts).
            y -= 1
        elif nt and y is not None and 26 <= y <= 30:
            # Christ's ministry: Theographic's events run AD 26–30 (cross AD 30), its verses, with Ussher,
            # AD 29–33. One shift for all of them keeps their order and agrees with the chapters.
            y += 3
        elif nt and y is not None and y > 30 and vrefs[0] in verse_year:
            # Acts and the letters (Paul in Rome AD 57 vs 62): date each event by its first verse; the verse
            # chronology runs in order through Acts, so the events keep theirs.
            y = verse_year[vrefs[0]]
            m = re.match(r"(\d+(?:\.\d+)?)Y$", dur)   # a journey lasts until its last verse
            if m and max(vy) - y > float(m.group(1)): dur = f"{max(vy) - y}Y"
        fix = EVENT_FIX.get(eid, {})
        if isinstance(sk, (int, float)) and raw_year[eid] is not None and fix.get("y", y) is not None:
            sk += fix.get("y", y) - raw_year[eid]   # moves with the year; keeps the source's order within it
        events[eid] = {
            "t": EVENT_TITLE_FIX.get(eid, f.get("title", "")), "y": y if y is not None else "", "dur": EVENT_DUR_FIX.get(eid, dur),
            "p": [rec2person.get(x) for x in f.get("participants", []) if x in rec2person],
            "pl": list(dict.fromkeys(rec2place[x] for x in f.get("locations", []) if x in rec2place)),
            "v": [[b+1, c, v] for (b, c, v) in vrefs][:12], "vn": len(vrefs),
            "pre": [rec2event.get(x) for x in f.get("predecessor", []) if x in rec2event],
            "part": [rec2event.get(x) for x in f.get("partOf", []) if x in rec2event],
            "sk": sk,
        }
        events[eid].update(fix)
    for e in events.values():   # links to events removed above
        e["pre"] = [x for x in e["pre"] if x in events]; e["part"] = [x for x in e["part"] if x in events]
    # Events must not run backwards against the source's own order, within a chapter or along 'pre' links
    # (EVENT_FIX corrects the source's year, and so its order, on purpose).
    ev_ch = collections.defaultdict(set)
    for r in tv:
        p = parse_osis(r["fields"].get("osisRef", ""))
        for x in r["fields"].get("event", []):
            if p and rec2event.get(x) in events: ev_ch[p[:2]].add(rec2event[x])
    pairs = {(a, z) for es in ev_ch.values() for a in es for z in es} | {(a, k) for k, e in events.items() for a in e["pre"]}
    back = [(events[a]["t"], events[z]["t"]) for a, z in pairs
            if all(isinstance(events[x]["y"], int) and raw_year[x] is not None and x not in EVENT_FIX for x in (a, z))
            and raw_year[a] < raw_year[z] and events[a]["y"] > events[z]["y"]]
    assert not back, f"events out of the source's order: {back[:6]}"

    # People's years on the same chronology as the verses and events beside them.
    # y0/y1: the first and last dated verse naming them (the chapter's year where the verse has none),
    # leaving out genealogies that list them centuries away from their own lives.
    named = collections.defaultdict(list)
    for r in tv:
        p = parse_osis(r["fields"].get("osisRef", ""))
        if not p or in_ranges(p, GENEALOGY_RANGES): continue
        y = verse_year.get(p, chapter_year.get(p[:2]))
        if y is None: continue
        for i in verse_people(p, r["fields"].get("people", [])): named[i].append(y)
    for pid, p in people.items():
        if pid not in divine_ids:
            p["y0"], p["y1"] = (min(named[pid]), max(named[pid])) if named.get(pid) else (None, None)
    # Birth, Lifetime and Death events set the lifespan they name (Birth over Lifetime), never for the Godhead.
    died = {}
    for e in sorted(events.values(), key=lambda e: e["t"].startswith("Birth")):
        m = re.match(r"(Birth|Lifetime|Death) of (.+)", e["t"])
        if not m or not isinstance(e["y"], int): continue
        for pid in e["p"]:
            p = people.get(pid)
            if not p or pid in divine_ids or not p["n"] or not re.search(rf"\b{re.escape(p['n'].split()[0])}\b", m.group(2)):
                continue
            if m.group(1) == "Death": p["d"] = died[pid] = e["y"]
            else: p["b"] = e["y"]
    for slug, (eid, age) in KING_ACCESSION.items():
        pid, e = slug2id.get(slug), events.get(eid)
        if pid not in people or not e or not isinstance(e["y"], int): continue
        people[pid]["b"] = e["y"] - age
        if pid not in died: people[pid]["d"] = e["y"] + int(re.match(r"\d+", e["dur"]).group())
    for slug, fix in PERSON_FIX.items():
        if slug in slug2id and slug2id[slug] in people: people[slug2id[slug]].update(fix)
    for p in people.values():   # a birth after the death, or a span no one lived: the dates are not usable
        if p["b"] is not None and p["d"] is not None and (p["b"] > p["d"] or p["d"] - p["b"] > 1000):
            p.update({"b": None, "d": None, "y0": None, "y1": None})
    bad = []
    for e in events.values():   # every king is born before his reign and dies at his 'Death of' event
        m = re.match(r"(Reign|Death) of (\w+)", e["t"])
        for pid in (e["p"] if m and isinstance(e["y"], int) else []):
            p = people.get(pid)
            if not p or pid in divine_ids: continue
            names = {*p["n"].split()[:1], *(a.strip() for a in (p["aka"] or "").split(","))}   # 'Death of Abijam': Abijah
            if m.group(2) not in names: continue
            if m.group(1) == "Reign" and p["b"] is not None and p["b"] >= e["y"]: bad.append(f"{p['n']} born {p['b']}, {e['t']} {e['y']}")
            if m.group(1) == "Death" and p["d"] is not None and abs(p["d"] - e["y"]) > 2: bad.append(f"{p['n']} died {p['d']}, {e['t']} {e['y']}")
    assert not bad, f"lifespans contradict their events: {bad[:6]}"
    groups =[{"n": r["fields"].get("groupName", ""), "m": [rec2person[x] for x in r["fields"].get("members", []) if x in rec2person and rec2person[x] not in divine_ids]} for r in tg]
    dump(os.path.join(out, "people.json"), people)
    dump(os.path.join(out, "events.json"), events)
    dump(os.path.join(out, "groups.json"), groups)

    # per-book context: chapter writer, per-verse people/places/events/year
    rec2chapter = {r["id"]: r["fields"] for r in tc}
    book_meta = {}
    slug2person = {r["fields"]["slug"]: r["fields"]["personID"] for r in tp}
    for r in tb:
        f = r["fields"]; bi = book_idx(f["osisName"])
        if bi is None: continue
        book_meta[bi] = {"div": f.get("bookDiv", ""), "writers": [slug2person.get(w) for w in f.get("writers", []) if w in slug2person],
                         "yearWritten": f.get("yearWritten", ""),
                         "placeWritten": ", ".join(places[rec2place[x]]["n"] for x in f.get("placeWritten", []) or []
                                                   if x in rec2place and rec2place[x] in places),   # linked record ids → names
                         "peopleCount": f.get("peopleCount", 0), "placeCount": f.get("placeCount", 0)}
    per_book = [collections.defaultdict(lambda: {"v": {}}) for _ in BOOKS]
    for r in tc:
        f = r["fields"]; p = f.get("osisRef", "").split(".")
        if len(p) != 2: continue
        bi = book_idx(p[0])
        if bi is None: continue
        per_book[bi][int(p[1])]["w"] = [rec2person.get(x) for x in f.get("writer", []) if x in rec2person]
    for r in tv:
        f = r["fields"]; p = parse_osis(f.get("osisRef", ""))
        if not p: continue
        bi, ch, vs = p
        ent = {}
        pp = verse_people(p, f.get("people", []))
        fx = VERSE_PLACE_FIX.get(p, {})
        pl = list(dict.fromkeys(fx.get(i, i) for i in (rec2place[x] for x in f.get("places", []) if x in rec2place)))
        pl = [i for i in pl if i is not None]
        ev = [rec2event[x] for x in f.get("event", []) if x in rec2event and rec2event[x] in events
              and p not in EVENT_VERSE_DROP.get(rec2event[x], ())]
        if pp: ent["p"] = pp
        if pl: ent["pl"] = pl
        if ev: ent["e"] = ev
        if p in verse_year: ent["y"] = verse_year[p]
        if ent: per_book[bi][ch]["v"][str(vs)] = ent
    for i, bk in enumerate(per_book):
        dump(os.path.join(out, "context", f"{i+1:02d}.json"), {str(k): v for k, v in bk.items()})
    # place verse counts from the final verse tags (the source's go stale with VERSE_PLACE_FIX and the merges)
    place_vc = collections.Counter(j for bk in per_book for ch in bk.values() for e in ch["v"].values() for j in e.get("pl", []))
    for pid, pl in places.items(): pl["vc"] = place_vc[pid]
    dump(os.path.join(out, "places.json"), places)
    # A chapter lists each place once (the merge above), and a town listed with 3+ others that lie within
    # 40 km of their middle is not 80 km from them: that is a namesake's point (Rimmon of the Negev in Syria).
    twice = [f"{BOOKS[i][0]} {c}: {k[0]}" for i, bk in enumerate(per_book) for c, ch in bk.items()
             for k, n in collections.Counter((places[j]["n"], places[j]["lat"], places[j]["lon"])
                                             for j in {j for e in ch["v"].values() for j in e.get("pl", [])}).items() if n > 1]
    assert not twice, f"places listed twice in a chapter: {twice[:8]}"
    med = lambda xs: (sorted(xs)[(len(xs) - 1) // 2] + sorted(xs)[len(xs) // 2]) / 2
    far = []
    for i, bk in enumerate(per_book):
        for c, ch in bk.items():
            for v, ent in ch["v"].items():
                pts = [(j, places[j]) for j in ent.get("pl", []) if places[j]["lat"] is not None and places[j]["ft"] not in ("Region", "Water")]
                for j, q in pts:
                    o = [z for k, z in pts if k != j]
                    if len(o) < 3 or j in PLACE_FAR_OK: continue
                    mid = (med([z["lat"] for z in o]), med([z["lon"] for z in o]))
                    if max(_km(z["lat"], z["lon"], *mid) for z in o) <= 40 and _km(q["lat"], q["lon"], *mid) > 80:
                        far.append(f"{q['n']} ({j}) in {BOOKS[i][0]} {c}:{v}")
    if far: print(f"  WARNING: {len(far)} places far from the towns listed with them (see PLACE_FIX): {', '.join(far[:10])}")
    # books.json = theographic meta + authored intros
    books_out = []
    for i, b in enumerate(BOOKS):
        m = dict(book_meta.get(i, {}))
        m.update(intros.get(b[0], {}))
        books_out.append(m)
    dump(os.path.join(out, "context", "books.json"), books_out)
    dump(os.path.join(out, "context", "divine.json"), sorted(divine_ids))
    # Satan, angels and false gods must be gone from everything the Context panel reads
    leaks = [pid for pid in non_human if pid in people]
    leaks += [f"event {k}" for k, e in events.items() if non_human & set(e["p"])]
    leaks += [f"group {g['n']}" for g in groups if non_human & set(g["m"])]
    leaks += [f"{BOOKS[i][0]} {c}:{v}" for i, bk in enumerate(per_book) for c, ch in bk.items()
              for v, ent in ch["v"].items() if non_human & set(ent.get("p", []))]
    leaks += [f"relation of {k}" for k, p in people.items() if non_human & set(p["fa"] + p["mo"] + p["ch"] + p["pt"])]
    # … and no person or place may carry Easton's article on a god (Malcham the Benjamite given 'Malcam', the idol)
    # (its opening defines it: '…, the national idol of the Ammonites', 'A Chaldean god whose worship …')
    godlike = re.compile(r"(?:^|,\s*)(?:[Tt]he|[Aa]n?)\s+(?:\w+\s+)?(?:idol|god|goddess|deity|divinity)\b")
    head = lambda t: re.sub(r"^\s*\([^)]*\)", "", re.split(r"\.\s+(?=[A-Z])", t or "", maxsplit=1)[0]).split("(")[0]
    leaks += [f"article of person {k}" for k, p in people.items() if k not in divine_ids and godlike.search(head(p["dict"]))]
    leaks += [f"article of place {k}" for k, p in places.items() if godlike.search(head(p["dict"]))]
    angelic = re.compile(r"\b(?:satan|devil|demon|demoniac|angel|archangel|cherub|cherubim|seraph|seraphim|dagon|baal|molech|chemosh|ashtoreth|idol)s?\b", re.I)
    leaks += [f"event title {k}: {e['t']}" for k, e in events.items() if angelic.search(e["t"])]
    # … nor any book intro (hero tagline, intro line, About card): every string of every book in books.json
    unholy = re.compile(r"\b(?:satan|devil|demon|demoniac|angel|archangel|cherub|cherubim|seraph|seraphim|angelic|dagon|baal|molech|moloch"
                        r"|chemosh|ashtoreth|ashtaroth|asherah|milcom|artemis|diana|zeus|jupiter|hermes|mercurius|lucifer"
                        r"|beelzebub|beelzebul|tammuz|marduk)s?\b", re.I)
    def strings(x):   # every string inside a JSON value
        if isinstance(x, str): return [x]
        return [s for y in (x.values() if isinstance(x, dict) else x if isinstance(x, list) else ()) for s in strings(y)]
    leaks += [f"intro of {BOOKS[i][0]}: {t}" for i, m in enumerate(books_out) for t in strings(m) if unholy.search(t)]
    leaks += [f"group with the Godhead: {g['n']}" for g in groups if divine_ids & set(g["m"])]
    leaks += [f"aka of person {k}" for k, p in people.items() if k not in divine_ids and PAGAN_AKA & {a.strip() for a in (p["aka"] or "").split(",")}]
    leaks += [f"article of place {k}" for k, p in places.items() if re.match(r"\s*(?:Plural\s+)?cherub|\s*(?:An?\s+)?angel", p["dict"] or "", re.I)]
    assert not leaks, f"NON_HUMAN beings still listed: {leaks[:10]}"
    print(f"  removed {len(non_human)} non-human beings (Satan, angels, false gods) from people and context")
    # Tags of the Godhead and names that the KJV and BSB text contradict, for VERSE_PEOPLE_FIX and PERSON_NAME_FIX
    bible = {t: [json.load(open(os.path.join(out, "bibles", t, f"{i+1:02d}.json"), encoding="utf-8")) for i in range(len(BOOKS))]
             for t in ("kjv", "bsb")}
    god, christ, odd = slug2id["god_1324"], slug2id["jesus_905"], []
    for i, bk in enumerate(bible["kjv"]):
        for c, vs in bk.items():
            for v, k in enumerate(map(str, vs), 1):
                b = bible["bsb"][i].get(c, [])
                b = str(b[v - 1]) if v <= len(b) else ""
                ps = set(per_book[i][int(c)]["v"].get(str(v), {}).get("p", [])) if int(c) in per_book[i] else set()
                if ((re.search(r"Christ[’']s", k) and god in ps and christ not in ps)
                        or (re.search(r"God[’']s", k) and christ in ps and god not in ps)
                        or (i >= 39 and re.search(r"(?<![-\w])Jesus\b", k) and "Justus" not in k and "Joshua" not in b and christ not in ps)
                        or (christ in ps and "Joshua" in b and "Jesus" not in b)):
                    odd.append(f"{BOOKS[i][0]} {c}:{v}")
    if odd: print(f"  WARNING: {len(odd)} verses whose God/Christ tags the text contradicts (see VERSE_PEOPLE_FIX): {', '.join(odd[:10])}")
    vocab = {w.lower() for t in bible.values() for bk in t for vs in bk.values() for s in vs
             for w in re.findall(r"[A-Za-z]+", str(s).replace("-", ""))}
    unknown = sorted({w for k, p in people.items() if k not in divine_ids for w in re.findall(r"[A-Za-z]+", p["n"].replace("-", "")) if w.lower() not in vocab})
    if unknown: print(f"  WARNING: people's names found in no KJV or BSB verse (see PERSON_NAME_FIX): {unknown[:12]}")
    gj = json.load(open(os.path.join(raw, "pauls_journeys.geojson"), encoding="utf-8"))
    for ft in gj["features"]:
        pr = ft["properties"]; pr.update(PAUL_FIX.get(pr.get("Place Name"), {}))
        bad = [r for k in ("first", "second", "third", "rome") if pr.get(k)
               for r in str(pr[k]).split(",") if not re.fullmatch(r"\s*Acts\.\d+\.\d+(-\d+)?\s*", r)]
        assert ft["geometry"]["type"] != "Point" or not bad, f"Paul's journeys: {pr.get('Place Name')} cites {bad}"
    dump(os.path.join(out, "pauls_journeys.geojson"), gj)
    # Easton's dictionary (general terms) for word lookup
    easton = {}
    for r in L("easton"):
        f = r["fields"]
        if f.get("dictText"):
            easton.setdefault(f["termLabel"], []).append(clip(f["dictText"], 3000))
    dump(os.path.join(out, "easton.json"), easton)
    print(f"  {len(people)} people, {len(places)} places, {len(events)} events, {len(easton)} Easton terms")
    lc = collections.Counter(k for p in places.values() for k in p.get("links", {}))
    print(f"  place links: " + ", ".join(f"{k} {lc[k]}" for k, _, _ in PLACE_LINK_RULES))

# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=os.path.join(HERE, "raw"))
    ap.add_argument("--xref", default=os.path.join(HERE, "src", "cross_references.txt"))
    ap.add_argument("--topics", default=os.path.join(HERE, "src", "topics"))
    ap.add_argument("--intros", default=os.path.join(HERE, "src", "book_intros.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "app", "data"))
    a = ap.parse_args()
    print("Ensuring raw sources ..."); ensure_raw(a.raw)
    print("KJV ..."); counts, kjv_redletter = build_kjv(a.raw, a.out)
    print("BSB ..."); build_bsb(a.raw, a.out, counts); build_bsb_redletter(a.out, kjv_redletter)
    print("Cross references ..."); xstats = build_xrefs(a.xref, a.out, counts)
    print("Topics ..."); build_topics(a.topics, a.out)
    print("Strong's ..."); build_strongs(a.raw, a.out)
    print("Interlinear ..."); aram = build_interlinear(a.raw, a.out, counts)
    intros = json.load(open(a.intros, encoding="utf-8")) if os.path.exists(a.intros) else {}
    print("Context ..."); build_context(a.raw, a.out, intros)
    meta = {"books": [{"n": i+1, "name": b[0], "osis": b[1], "short": b[3], "test": b[4], "div": b[5],
                       "chapters": counts[i], "xo": xstats[i]["out"], "xi": xstats[i]["in"], **({"aram": aram[i]} if i in aram else {})}
                      for i, b in enumerate(BOOKS)],
            "translations": [
                {"id": "kjv", "name": "King James Version", "abbr": "KJV", "kind": "bundled", "licence": "Public domain"},
                {"id": "bsb", "name": "Berean Standard Bible", "abbr": "BSB", "kind": "bundled", "licence": "Public domain (CC0)"},
                {"id": "esv", "name": "English Standard Version", "abbr": "ESV", "kind": "api", "licence": "© Crossway — fetched live via the ESV API with your key"},
                {"id": "nlt", "name": "New Living Translation", "abbr": "NLT", "kind": "api", "licence": "© Tyndale House — fetched live via the NLT API with your key"},
                {"id": "niv", "name": "New International Version", "abbr": "NIV", "kind": "external", "licence": "© Biblica — opens on BibleGateway"},
                {"id": "nkjv", "name": "New King James Version", "abbr": "NKJV", "kind": "external", "licence": "© Thomas Nelson — opens on BibleGateway"},
                {"id": "lsb", "name": "Legacy Standard Bible", "abbr": "LSB", "kind": "external", "licence": "© Three Sixteen Publishing — opens on read.lsbible.org"},
            ]}
    meta["divine"] = json.load(open(os.path.join(a.out, "context", "divine.json")))  # person ids that are God, not people
    dump(os.path.join(a.out, "meta.json"), meta)
    print("Done ->", a.out)

if __name__ == "__main__":
    main()
