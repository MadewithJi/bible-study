#!/usr/bin/env python3
"""
Local server for the Bible study app (profiles: python3 serve.py --list-users | --reset-password EMAIL).

  python3 serve.py                              # http://localhost:8765, data in notes/
  python3 serve.py --port 9000 --data-dir DIR   # another port / data directory
  python3 serve.py --list-users                 # profiles on this computer (never prints hashes)
  python3 serve.py --reset-password EMAIL       # prompts twice; signs that profile out everywhere
                   [--password-stdin]           #   or read the new password from one stdin line
  Other flags: --host 127.0.0.1, --allow-host NAME (extra Host names), --max-users 50

Serves app/ statically and a JSON API. Signed out ("guest"), everything behaves as before:
  GET  /api/notes, PUT /api/notes     guest notes (DATA/notes.json)
  GET  /api/config, PUT /api/config   which ESV/NLT keys are configured / set them; licensed: what API.Bible serves
  GET  /api/passage?tr=esv&book=43&chapter=3   licensed text via ESV / NLT API (cached in DATA/cache/, ESV at most
                                               500 verses and half of any book, per its terms); same-origin only
       /api/passage?tr=niv|nkjv|nasb           NIV, NKJV and NASB via API.Bible (.design/translations-brief.md §1):
                                               BS_APIBIBLE_KEY, open to every reader, 14-day cache, monthly budget
  GET  /api/export/obsidian           zip of notes (plus bookmarks, reading progress, links, highlights) as Obsidian markdown
Profiles (local email + password, no email is ever sent), per-scope library and export:
  GET  /api/auth/me   POST /api/auth/signup | login | logout
  PATCH /api/account  POST /api/account/password | /api/account/delete
  POST /api/notes/changes (per-key merge)   GET /api/library   POST /api/library/events
  GET  /api/links   POST /api/links/changes (My links: user-made verse connections, per-key merge)
  GET  /api/marks   POST /api/marks/changes (highlights and comments on words of the text, per-key merge)
  GET  /api/memory  POST /api/memory/changes (Memorize: memory verses and their practice schedule, per-key merge)
  POST /api/library/bookmarks   PATCH|DELETE /api/library/bookmarks/{id}
  POST /api/library/chapters | /api/library/reset   POST /api/profile/import-guest
  GET  /api/export/profile   POST /api/profile/import (that file, merged into the signed-in profile)
  GET  /api/health    {"ok": true}: no auth, scope or CSRF (for a host's health checks)
Hosted mode (all off unless set, .design/hosting-brief.md §1): PORT, HOST and BS_DATA_DIR are the defaults for --port,
--host and --data-dir; BS_HOSTED=1 makes guests read-only, ESV/NLT and their keys owner-only and the session cookie
Secure; BS_ALLOWED_HOSTS and BS_ALLOWED_ORIGINS widen the Host and Origin checks; BS_TRUST_PROXY=1 reads the client
address from X-Forwarded-For and the scheme from X-Forwarded-Proto; BS_OWNER_EMAILS names the owners.
Open sign-up on the site (.design/open-signup-brief.md §1): anyone may sign up, behind a Cloudflare Turnstile check when
BS_TURNSTILE_SITEKEY and BS_TURNSTILE_SECRET are set; BS_SIGNUP=closed pauses it; BS_MAX_USERS (default 5000),
BS_PROFILE_QUOTA_MB (default 25) and a free-space guard bound what strangers can store; daily counts in metrics.json
feed GET /api/admin/traffic (owners only, 404 for anyone else) and '[alert]' lines on stderr.
The donation link (.design/donate-brief.md): GET or HEAD /donate and /support answer 302 to BS_DONATE_URL (default
https://buymeacoffee.com/biblelantern), never a permanent redirect, so it can be re-pointed without changing a link.
Data layout (DATA = --data-dir, default notes/): notes.json, guest-library.json, guest-links.json, guest-marks.json
and guest-memory.json (guest), config.json, cache/ (cache/apibible/: bibles.json, usage.json), users.json,
sessions.json (hashed tokens only), profiles/<uid>/{notes,library,links,marks,memory}.json, deleted/, owner-claims.json
and metrics.json (hosted). Full contract: .design/profiles-spec.md, .design/links-spec.md, .design/annotations-brief.md
and .design/memorize-brief.md
"""
import argparse, contextlib, datetime, getpass, hashlib, hmac, http.client, ipaddress, json, math, os, re, secrets, shutil
import signal, socket, sys, threading, time, traceback, urllib.parse, urllib.request
from collections import OrderedDict, deque
from html.parser import HTMLParser
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

import accounts as A

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "app")
DEFAULT_DATA = os.path.join(HERE, "notes")

BOOKS = [b["name"] for b in json.load(open(os.path.join(APP, "data", "meta.json"), encoding="utf-8"))["books"]]
ESV_NAMES = dict(zip(BOOKS, BOOKS)); ESV_NAMES["Song of Songs"] = "Song of Solomon"
# NLT's reference parser needs the space: '1 Samuel.3' reads, '1Samuel.3' comes back empty (17 books never loaded).
NLT_NAMES = dict(zip(BOOKS, BOOKS)); NLT_NAMES.update({"Song of Songs": "Song", "Psalms": "Ps"})

KIB, MIB = 1024, 1024 * 1024
MAX_BODY = 25 * MIB  # the largest body any route accepts (a profile import); a refused body is drained up to this


def read_json(path, default):
    """Lenient read, only for the ESV/NLT cache and config (unchanged behaviour)."""
    try:
        with open(path, encoding="utf-8") as f: return json.load(f)
    except (OSError, ValueError): return default


# ----------------------------------------------------------------- licensed translations
def fetch_esv(key, book, chapter):
    q = urllib.parse.quote(f"{ESV_NAMES[book]} {chapter}")
    url = ("https://api.esv.org/v3/passage/text/?q=" + q +
           "&include-passage-references=false&include-verse-numbers=true&include-first-verse-numbers=true"
           "&include-footnotes=false&include-footnote-body=false&include-headings=false&include-short-copyright=false"
           "&include-selahs=true&indent-poetry=false&indent-paragraphs=0&indent-declares=0&indent-psalm-doxology=0&line-length=0")
    req = urllib.request.Request(url, headers={"Authorization": "Token " + key, "User-Agent": "bible-study-local"})
    with urllib.request.urlopen(req, timeout=30) as r: data = json.load(r)
    text = " ".join(data.get("passages", []))
    parts = re.split(r"\[(\d+)\]", text)
    verses = {}
    for i in range(1, len(parts) - 1, 2):
        verses[int(parts[i])] = re.sub(r"\s+", " ", parts[i + 1]).strip()
    # A psalm's title (superscription) is the text before [1]; it is not part of verse 1 (nothing else comes before it
    # without passage references and headings).
    return verses, (re.sub(r"\s+", " ", parts[0]).strip() if book == "Psalms" else "")

HEADING = re.compile(r"h[1-6]")
# NLT sets a fraction as <sup class="fract-num">1</sup><span class="fract-slash">/</span><span class="fract-den">4</span>
FRACTION = {"fract-num": 0, "fract-den": 1, "fract-slash": 2}
VULGAR = {"1/2": "½", "1/3": "⅓", "2/3": "⅔", "1/4": "¼", "3/4": "¾", "1/5": "⅕", "2/5": "⅖", "3/5": "⅗", "4/5": "⅘",
          "1/6": "⅙", "5/6": "⅚", "1/7": "⅐", "1/8": "⅛", "3/8": "⅜", "5/8": "⅝", "7/8": "⅞", "1/9": "⅑", "1/10": "⅒"}


class NltText(HTMLParser):
    """Verse text out of api.nlt.to HTML for the requested chapter (its <verse_export ch> containers), and the psalm title.

    A verse starts at its number, span.vn, not at its <verse_export vn> container: NLT sets a list or table (Ezra 2,
    Nehemiah 7, Numbers 1-2) as one block inside the last row's container, each row behind its own span.vn, and leaves
    the earlier containers empty. A range ('20-21', '3-4') gives its text to the first verse and leaves the rest empty,
    as NLT combines them; a row without a number of its own (Numbers 2's Judah row) continues the open verse. So a
    <verse_export vn=K> opens verse K only when it starts, headings aside, with K's own number (a heading before it,
    such as Mark 16:9's '[Longer Ending of Mark]', is K's), or when no span.vn in the chapter places K. A first pass
    (`scan`) finds both.
    A table's header cells (td.table-head 'Tribe Leader Number') are not text; cells are spaced like blocks.
    The psalm title (p.psa-title, before verse 1) goes to `title`, not into verse 1.

    Footnotes (span.tn, whose '3:16' label is a nested span.tn-ref), their markers (a.a-tn), verse numbers (span.vn)
    and headings are dropped as whole elements, tracked on a stack, so a nested </span> cannot end the skip early (a
    non-greedy regex left 'Or For God loved the world so much that he gave.' inside John 3:16). Text-critical notes
    (h3.text-critical) are kept, in their brackets, as NLT prints them in the text: without '[Shorter Ending of Mark]'
    that ending read as part of Mark 16:8. Small caps (span.sc: LORD for the divine name, as against Lord for Adonai)
    are upper-cased as printed. Only block tags separate words, so an inline tag adds no space before punctuation
    ('O LORD, I', not 'O Lord , I'); a fraction becomes one character ('3¼ pounds', not '31/4 pounds'). The stack
    starts empty at every container: NLT leaves paragraphs open across verses, and an unclosed element can at worst
    affect its own container."""
    SKIP = {"tn", "a-tn", "vn", "table-head"}
    BLOCK = {"p", "br", "hr", "div", "section", "blockquote", "li", "ul", "ol", "table", "thead", "tbody", "tr", "td", "th",
             "h1", "h2", "h3", "h4", "h5", "h6"}
    VOID = {"br", "hr", "img", "wbr"}
    LABEL = re.compile(r"([0-9]{1,3})(?:\s*[-–]\s*([0-9]{1,3}))?")

    def __init__(self, chapter, scan=None):
        super().__init__(convert_charrefs=True)
        self.chapter, self.on, self.k, self.vn, self.stack, self.out, self.frac = chapter, False, None, None, [], {}, None
        # an open span.vn; every verse a span.vn places; container vn -> the verse its first span.vn starts; containers
        # with text (not a heading) before their first span.vn; the psalm title's parts
        self.label, self.labels, self.first, self.lead, self.title = None, set(), {}, set(), []
        self.scan = scan or self

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "").strip() for k, v in attrs}
        if tag == "verse_export":
            self._flush()
            vn, ch = a.get("vn", ""), a.get("ch", "")
            self.on = bool(DIGITS.fullmatch(vn) and 1 <= int(vn) <= 200 and (not ch or (DIGITS.fullmatch(ch) and int(ch) == self.chapter)))
            self.stack, self.label = [], None
            self.k = int(vn) if self.on else None
            if self.on:
                self.out.setdefault(self.k, [])
                sc = self.scan
                if self.vn is None or self.k not in sc.labels or (sc.first.get(self.k) == self.k and self.k not in sc.lead): self.vn = self.k
            return
        if not self.on: return
        if tag in self.BLOCK: self._flush(); self._buf().append(" ")
        if tag in self.VOID: return
        cls = set(a.get("class", "").split())
        skip = bool(cls & self.SKIP) or tag == "th" or (HEADING.fullmatch(tag) is not None and "text-critical" not in cls)
        if "vn" in cls and not any(s[1] for s in self.stack): self.label = (len(self.stack), [])
        # (tag, skip its text, small caps, part of a fraction: 0 numerator, 1 denominator, 2 slash, psalm title)
        self.stack.append((tag, skip, "sc" in cls, next((FRACTION[c] for c in cls if c in FRACTION), None), "psa-title" in cls))

    def handle_endtag(self, tag):
        if tag == "verse_export": self._flush(); self.on, self.stack, self.label = False, [], None; return
        if not self.on: return
        for i in range(len(self.stack) - 1, -1, -1):  # the nearest open one, and anything left open inside it
            if self.stack[i][0] == tag: del self.stack[i:]; break
        if self.label is not None and len(self.stack) <= self.label[0]:  # a verse number ends: its verse starts
            m = self.LABEL.fullmatch("".join(self.label[1]).strip())
            self.label = None
            if m and 1 <= int(m[1]) <= 200:
                self._flush()
                self.vn = int(m[1]); self.out.setdefault(self.vn, [])
                self.labels.update(range(self.vn, min(int(m[2] or m[1]), 200) + 1)); self.first.setdefault(self.k, self.vn)
        if tag in self.BLOCK: self._flush(); self._buf().append(" ")

    def handle_data(self, data):
        if not self.on: return
        if self.label is not None: self.label[1].append(data); return
        if any(s[1] for s in self.stack): return
        part = next((s[3] for s in reversed(self.stack) if s[3] is not None), None)
        if part is not None:  # held until the fraction ends; the slash itself is implied
            if part == 0 and self.frac and self.frac[1]: self._flush()  # a second fraction right after the first
            if part < 2:
                self.frac = self.frac or ["", ""]
                self.frac[part] += data.strip()
            return
        self._flush()
        if self.k not in self.first and data.strip() and not any(HEADING.fullmatch(s[0]) or s[4] for s in self.stack): self.lead.add(self.k)
        self._buf().append(data.upper() if any(s[2] for s in self.stack) else data)

    def _buf(self):
        return self.title if any(s[4] for s in self.stack) else self.out[self.vn]

    def _flush(self):
        """Emit a pending fraction: '¼', or '5/16' where Unicode has no single character (spaced from a whole number)."""
        if self.frac is None or self.vn is None: self.frac = None; return
        f, self.frac, parts = "/".join(self.frac), None, self._buf()
        prev = next((s for s in reversed(parts) if s), "")
        parts.append(VULGAR.get(f) or ((" " if prev[-1:].isdigit() else "") + f))


def fetch_nlt(key, book, chapter):
    ref = urllib.parse.quote(f"{NLT_NAMES[book]}.{chapter}")
    url = f"https://api.nlt.to/api/passages?ref={ref}&version=NLT&key={urllib.parse.quote(key)}"
    req = urllib.request.Request(url, headers={"User-Agent": "bible-study-local"})
    with urllib.request.urlopen(req, timeout=30) as r: body = r.read().decode("utf-8", "replace")
    # Only <verse_export> elements are verses. No plain-text fallback: it turned the numbers in any other page (an
    # error or notice) into 'verses', which were then cached for good. The first pass finds the verses a span.vn places.
    scan = NltText(chapter); scan.feed(body); scan.close()
    p = NltText(chapter, scan); p.feed(body); p.close()
    text = lambda parts: re.sub(r"\s+", " ", "".join(parts)).strip()
    return {vn: text(parts) for vn, parts in p.out.items()}, text(p.title)

FETCHERS = {"esv": ("esvKey", fetch_esv), "nlt": ("nltKey", fetch_nlt)}
# Cache format per translation: a cached chapter with another "v" (none = 1) is fetched again. nlt 3: text from
# NltText (v1 files hold footnote text, 'Lord' for LORD and spaces before punctuation; v2 '31/4' for '3¼' and no
# text-critical notes). nlt 4: verses split at span.vn (v3 put a whole table under its last verse, Ezra 2:3-34 empty)
# and, as in esv 2, a psalm's title in "title" rather than in verse 1 (NLT) or dropped (ESV).
CACHE_V = {"esv": 2, "nlt": 4, "niv": 1, "nkjv": 1, "nasb": 1}

# ESV API terms (api.esv.org): "You may not locally store more than 500 verses or one-half of any book of the Bible
# (whichever is less)". The NLT terms limit requests, not storage.
ESV_CACHE_MAX = 500
ESV_CACHE_LOCK = threading.RLock()
CACHE_FILE = re.compile(r"(\d{2})-(\d{1,3})\.json")

def esv_cap(book_n):
    """Verses of this book the ESV cache may hold: min(500, half the book). A one-chapter book is never kept."""
    return min(ESV_CACHE_MAX, sum(A.meta()["verses"][book_n - 1]) // 2)

def prune_esv_cache(keep=None):
    """Delete ESV chapters, least recently used first (a cache hit touches its file), until the cache holds at most
    500 verses in all and esv_cap() of any one book. Never deletes `keep` (the chapter just stored). -> count."""
    d = os.path.join(A.CACHE, "esv")
    with ESV_CACHE_LOCK:
        try: names = os.listdir(d)
        except OSError: return 0
        files = []
        for name in names:
            m = CACHE_FILE.fullmatch(name)
            if not m: continue
            p = os.path.join(d, name)
            try: mtime = os.stat(p).st_mtime_ns
            except OSError: continue
            obj = read_json(p, None)
            n = len(obj["verses"]) if isinstance(obj, dict) and isinstance(obj.get("verses"), list) else 0
            files.append((p == keep, mtime, name, p, int(m.group(1)), n))
        files.sort()  # oldest first, the chapter just stored last
        total, per_book = sum(f[5] for f in files), {}
        for f in files: per_book[f[4]] = per_book.get(f[4], 0) + f[5]
        removed = 0
        for is_keep, _, _, p, b, n in files:
            if is_keep: continue
            # unreadable or empty files and unknown books are dead entries: get_passage never serves them
            if n and 1 <= b <= 66 and total <= ESV_CACHE_MAX and per_book[b] <= esv_cap(b): continue
            try: os.unlink(p)
            except OSError: continue
            total, per_book[b], removed = total - n, per_book[b] - n, removed + 1
        return removed

def cache_passage(tr, book_n, cpath, out):
    if tr != "esv":
        A.write_json_atomic(cpath, out)
        return
    with ESV_CACHE_LOCK:
        stored = len(out["verses"]) <= esv_cap(book_n)
        if stored: A.write_json_atomic(cpath, out)
        prune_esv_cache(keep=cpath if stored else None)

def get_passage(tr, book_n, chapter):
    keyname, fn = FETCHERS[tr]
    cfg = read_json(A.CONFIG, {})
    key = cfg.get(keyname) if isinstance(cfg, dict) else None
    key = key.strip() if isinstance(key, str) else ""  # a hand-edited non-string key is "not configured", never a 500
    if not key: return {"error": f"No API key configured for {tr.upper()}. Open Settings to add one."}, 400
    cpath = os.path.join(A.CACHE, tr, f"{book_n:02d}-{chapter}.json")
    cached = read_json(cpath, None)
    if isinstance(cached, dict) and cached.get("v", 1) == CACHE_V[tr] and isinstance(cached.get("verses"), list) and cached["verses"]:
        if tr == "esv":
            with ESV_CACHE_LOCK:  # most recently used: the last to be pruned
                try: os.utime(cpath)
                except OSError: pass
        return cached, 200
    wait = UPSTREAM_WINDOW.check(tr)
    if wait: return {"error": f"Too many {tr.upper()} requests at once. Try again in {wait} seconds."}, 429
    try:
        verses, title = fn(key, BOOKS[book_n - 1], chapter)
    except Exception as e:  # noqa
        return {"error": f"{tr.upper()} API request failed: {e}"}, 502
    verses = {i: t for i, t in verses.items() if 1 <= i <= 200}
    if not any(verses.values()): return {"error": f"{tr.upper()} API returned no verses."}, 502
    n = max(verses)
    out = {"verses": [verses.get(i, "") for i in range(1, n + 1)], "fetched": time.strftime("%Y-%m-%d"), "v": CACHE_V[tr]}
    if title: out["title"] = title  # a psalm's title, shown above verse 1
    cache_passage(tr, book_n, cpath, out)
    return out, 200


# ----------------------------------------------------------------- NIV, NKJV and NASB through API.Bible
# (.design/translations-brief.md §1). One key (BS_APIBIBLE_KEY) on the Starter plan: three licensed Bibles, open to
# every reader of the site, 5,000 calls a month. The key goes out only in the api-key header, never in a URL, a
# response or a log line. Chapters are cached for 14 days (the terms say refresh within 30) with the publisher's
# copyright and the FUMS token the app reports each view with.
APIBIBLE_TRS = ("niv", "nkjv", "nasb")
APIBIBLE_ABBRS = {"niv": ("NIV",), "nkjv": ("NKJV",), "nasb": ("NASB", "NASB2020", "NASB1995", "NASB95")}  # in order of preference
APIBIBLE_DEFAULT_URL = "https://rest.api.bible/v1"
APIBIBLE_KEY = ""                     # BS_APIBIBLE_KEY
APIBIBLE_URL = APIBIBLE_DEFAULT_URL   # BS_APIBIBLE_URL (the tests' fake API.Bible)
APIBIBLE_PINS = {}                    # BS_APIBIBLE_BIBLES 'niv=<id>,nkjv=<id>,nasb=<id>': never discovered
APIBIBLE_MONTHLY = 4800               # BS_APIBIBLE_MONTHLY: upstream calls a calendar month (UTC), discovery included
APIBIBLE_TIMEOUT = 20
APIBIBLE_MAX = 8 * MIB                # the most of one answer read (Psalm 119 is well under 1 MB)
APIBIBLE_FRESH_DAYS, APIBIBLE_KEEP_DAYS = 14, 30  # refetched after 14 days; a copy under 30 days old covers a failed refresh
APIBIBLE_QUERY = {"content-type": "json", "include-notes": "false", "include-titles": "false",
                  "include-chapter-numbers": "false", "include-verse-numbers": "true", "include-verse-spans": "false",
                  "fums-version": "3"}
APIBIBLE_KEY_RE = re.compile(r"[!-~]{1,256}", re.ASCII)   # it goes out in a header
APIBIBLE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", re.ASCII)
FUMS_TOKEN_RE = re.compile(r"[!-~]{1,4096}", re.ASCII)
USFM = ["GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT", "1SA", "2SA", "1KI", "2KI", "1CH", "2CH", "EZR", "NEH",
        "EST", "JOB", "PSA", "PRO", "ECC", "SNG", "ISA", "JER", "LAM", "EZK", "DAN", "HOS", "JOL", "AMO", "OBA", "JON",
        "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL", "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL",
        "EPH", "PHP", "COL", "1TH", "2TH", "1TI", "2TI", "TIT", "PHM", "HEB", "JAS", "1PE", "2PE", "1JN", "2JN", "3JN",
        "JUD", "REV"]
MSG_APIBIBLE_BUDGET = ("This site has used its NIV, NKJV and NASB allowance for the month. Chapters read recently still "
                       "open; the rest return next month.")


class ApiBibleError(Exception):
    """An API.Bible call that gave no usable answer. `why` is short and safe to log: never the key or the URL. `down`:
    no answer came back (a timeout, a failed connection); `unreached`: the call never left this server (a refused
    connection, a name that did not resolve), so it does not count against the month."""
    def __init__(self, why, status=None, down=False, unreached=False):
        super().__init__(why)
        self.why, self.status, self.down, self.unreached = why, status, down, unreached


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw): return None  # a redirect is an error: the api-key header never goes elsewhere


APIBIBLE_OPENER = urllib.request.build_opener(_NoRedirect)


def apibible_get(path, query=None):
    """GET APIBIBLE_URL + path with the key in the api-key header -> the parsed JSON. Raises ApiBibleError."""
    url = APIBIBLE_URL + path + ("?" + urllib.parse.urlencode(query) if query else "")
    req = urllib.request.Request(url, headers={"api-key": APIBIBLE_KEY, "Accept": "application/json", "User-Agent": "bible-lantern"})
    try:
        with APIBIBLE_OPENER.open(req, timeout=APIBIBLE_TIMEOUT) as r: raw = r.read(APIBIBLE_MAX + 1)
    except urllib.error.HTTPError as e:
        e.close()
        raise ApiBibleError(f"HTTP {e.code}", e.code)
    except (OSError, http.client.HTTPException) as e:  # URLError, a refused connection and timeouts are OSErrors
        reason = getattr(e, "reason", None)
        e = reason if isinstance(reason, Exception) else e
        raise ApiBibleError("timeout" if isinstance(e, socket.timeout) else e.__class__.__name__, down=True,
                            unreached=isinstance(e, (ConnectionRefusedError, socket.gaierror)))
    if len(raw) > APIBIBLE_MAX: raise ApiBibleError("answer too large")
    try: return json.loads(raw.decode("utf-8"))
    except ValueError: raise ApiBibleError("not JSON")


def apibible_pick(bibles):
    """{tr: bibleId} out of /bibles' data[], by abbreviation (then abbreviationLocal), the first in APIBIBLE_ABBRS order."""
    norm = lambda s: re.sub(r"[^0-9A-Z]", "", s.upper()) if isinstance(s, str) else ""  # noqa: E731 ('NASB 1995')
    found = {}
    for tr, names in APIBIBLE_ABBRS.items():
        for name in names:
            for field in ("abbreviation", "abbreviationLocal"):
                hit = next((b["id"] for b in bibles if isinstance(b, dict) and norm(b.get(field)) == name
                            and isinstance(b.get("id"), str) and APIBIBLE_ID_RE.fullmatch(b["id"])), None)
                if hit: break
            if hit: found[tr] = hit; break
    return found


class ApiBible:
    """Which Bible ids the key serves: the pins, plus the rest discovered from /bibles in a background thread, kept in
    memory and in DATA/cache/apibible/bibles.json (with a hash of the URL and key, so another key discovers again).
    Discovered again after 14 days (a day when it found none), or when a chapter call says an id is unknown; at most
    one attempt every 10 minutes, and a failed one keeps the map it had. A translation API.Bible refused (401, 403)
    or throttled (429) makes no more calls for a while, and for a minute when it gave no answer or a 5xx (each
    reader's call would wait up to 20 seconds): an error is never cached, so each reader would spend one."""
    FRESH, FRESH_EMPTY, RETRY = APIBIBLE_FRESH_DAYS * 86400, 86400, 600
    PAUSE, PAUSE_DOWN = {401: 600, 403: 600, 429: 60}, 60

    def __init__(self, clock=time.time):
        self.clock, self.lock = clock, threading.Lock()
        self.where, self.ids, self.at, self.stale, self.next_try, self.running = None, None, 0, False, 0, None
        self.paused = {}  # tr -> clock time its calls resume

    @staticmethod
    def _fingerprint():
        return hashlib.sha256(f"{APIBIBLE_URL}\n{APIBIBLE_KEY}".encode("utf-8")).hexdigest()[:16]

    def _load(self):
        path, fp = os.path.join(A.CACHE, "apibible", "bibles.json"), self._fingerprint()
        if self.where == (path, fp): return path
        self.where, self.ids, self.at, self.stale, self.next_try, self.paused = (path, fp), None, 0, False, 0, {}
        d = read_json(path, None)
        if isinstance(d, dict) and d.get("keyHash") == fp and isinstance(d.get("ids"), dict) and A._is_int(d.get("at")):
            self.ids = {t: i for t, i in d["ids"].items() if t in APIBIBLE_TRS and isinstance(i, str) and APIBIBLE_ID_RE.fullmatch(i)}
            self.at = d["at"]
        return path

    def _due(self):
        now = self.clock()
        if now < self.next_try: return False
        age = now - self.at
        return self.ids is None or self.stale or not 0 <= age < (self.FRESH if self.ids else self.FRESH_EMPTY)

    def ids_now(self, wait):
        """-> {tr: bibleId} the key can serve now. Starts a discovery when one is due and waits up to `wait` seconds
        for it (a running one too); past that, what is known so far."""
        if not APIBIBLE_KEY: return {}
        pins = dict(APIBIBLE_PINS)
        if all(t in pins for t in APIBIBLE_TRS): return pins
        with self.lock:
            path = self._load()
            ev = self.running
            if ev is None and self._due():
                ev = self.running = threading.Event()
                self.next_try = self.clock() + self.RETRY
                threading.Thread(target=self._discover, args=(ev, path, self.where), daemon=True).start()
        if ev is not None and wait: ev.wait(wait)
        with self.lock: found = dict(self.ids or {}) if self.where[0] == path else {}
        return {t: pins.get(t) or found[t] for t in APIBIBLE_TRS if t in pins or t in found}

    def _discover(self, ev, path, where):
        try:
            if not USAGE.take(): return  # the month's budget is spent: the map from last time stands
            try:
                d = apibible_get("/bibles", {"language": "eng"})
                if not isinstance(d, dict) or not isinstance(d.get("data"), list): raise ApiBibleError("no list of Bibles")
            except ApiBibleError as e:
                A.log_error(f"apibible: cannot list the key's Bibles ({e.why})")
                if e.unreached: USAGE.refund()
                return
            ids, now = apibible_pick(d["data"]), self.clock()
            with self.lock:
                if self.where != where: return  # the data directory or key changed meanwhile
                self.ids, self.at, self.stale = ids, int(now), False
            try: A.write_json_atomic(path, {"v": 1, "at": int(now), "keyHash": where[1], "ids": ids})
            except (OSError, ValueError) as e: A.log_error(f"apibible: cannot write bibles.json: {e.__class__.__name__}")
            names = [t.upper() for t in APIBIBLE_TRS if t in ids]
            try: print(f"API.Bible: {', '.join(names) if names else 'none of NIV, NKJV or NASB'} for this key", flush=True)
            except Exception: pass  # noqa
        finally:
            with self.lock: self.running = None
            ev.set()

    def forget(self, tr):
        """A chapter call said this Bible id is unknown: discover again (a pinned id stays as it is)."""
        if tr in APIBIBLE_PINS: return
        with self.lock: self.stale = True

    def pause(self, tr, e):
        """After a failed chapter call (ApiBibleError e): how long `tr` makes no more calls, if at all."""
        secs = self.PAUSE.get(e.status) or (self.PAUSE_DOWN if e.down or (e.status or 0) >= 500 else 0)
        if secs:
            with self.lock: self.paused[tr] = self.clock() + secs

    def is_paused(self, tr):
        with self.lock: return self.clock() < self.paused.get(tr, 0)

    def licensed(self, wait=3):
        """config.licensed: the translations the key serves, in menu order. Waits briefly for a first discovery (the
        app gives /api/config 6 seconds)."""
        ids = self.ids_now(wait)
        return [t for t in APIBIBLE_TRS if t in ids]


class ApiBibleUsage:
    """Upstream calls this calendar month (UTC), in DATA/cache/apibible/usage.json as {"v": 1, "month": "YYYY-MM",
    "calls": n, "alerted": bool}, written at each call so a restart keeps the count. Past APIBIBLE_MONTHLY nothing
    more goes upstream; one '[alert]' line the month it reaches 80%."""
    def __init__(self, clock=time.time):
        self.clock, self.lock = clock, threading.Lock()
        self.path, self.month, self.calls, self.alerted = None, "", 0, False

    def _sync(self):
        path = os.path.join(A.CACHE, "apibible", "usage.json")
        if path != self.path:
            d = read_json(path, None)
            ok = isinstance(d, dict) and isinstance(d.get("month"), str) and A._is_int(d.get("calls")) and d["calls"] >= 0
            self.path, self.month = path, d["month"] if ok else ""
            self.calls, self.alerted = (d["calls"], d.get("alerted") is True) if ok else (0, False)
        month = time.strftime("%Y-%m", time.gmtime(self.clock()))
        if month != self.month: self.month, self.calls, self.alerted = month, 0, False

    def _save(self):
        snap = {"v": 1, "month": self.month, "calls": self.calls, "alerted": self.alerted}
        try: A.write_json_atomic(self.path, snap, indent=None)
        except (OSError, ValueError) as e: A.log_error(f"apibible: cannot write usage.json: {e.__class__.__name__}")

    def take(self):
        """Count one upstream call. -> False (and nothing counted) when the month's budget is spent."""
        with self.lock:
            self._sync()
            if self.calls >= APIBIBLE_MONTHLY: return False
            self.calls += 1
            alert = not self.alerted and self.calls * 5 >= APIBIBLE_MONTHLY * 4
            if alert: self.alerted = True
            calls = self.calls
            self._save()
        if alert:
            ALERTS.fire("apibible_budget", f"{calls} of {APIBIBLE_MONTHLY} API.Bible calls used this month (80%)")
        return True

    def refund(self):
        """Give back one counted call that never reached API.Bible (ApiBibleError.unreached)."""
        with self.lock:
            self._sync()
            if self.calls <= 0: return
            self.calls -= 1
            self._save()

    def report(self):
        """The owners' Site activity: {calls: this month's, limit}."""
        with self.lock:
            self._sync()
            return {"calls": self.calls, "limit": APIBIBLE_MONTHLY}


APIBIBLE = ApiBible()
USAGE = ApiBibleUsage()

# API.Bible's JSON content: verse text is in text nodes carrying attrs.verseId ('JHN.3.16'); a verse marker's own
# items are its number. Headings (include-titles=false should leave none), notes and chapter numbers never reach a
# verse; a psalm's title is the style-d paragraph before the first verse marker.
APIBIBLE_HEADING = re.compile(r"(?:s|ms|mr|r|sr|sp|sd|cl|cd|mt|mte|qa|imt|is|ip|ipr|iq|im|ili|iot|io|ie|rem|restore|h|toc|toca|th|thr)\d*")
APIBIBLE_SKIP = re.compile(r"(?:f|fe|ef|x|ex|fr|fq|fqa|fk|fl|fw|fp|fv|ft|fdc|fm|xo|xk|xq|xt|xta|xop|xot|xnt|xdc|ca|va|vp|fig|c)\d*")
APIBIBLE_BLOCKS = ("para", "table", "row", "cell", "list", "item")  # one space between them; char spans join as they are
VERSE_ID = re.compile(r"([0-9A-Z]{3})\.(\d+)\.(\d+)")
VERSE_NUMBERS = re.compile(r"(\d+)(?:\D+(\d+))?")


def apibible_verses(content, usfm, chapter):
    """-> ({verse: text}, title) from a chapter's JSON content. A verse marked but given no text is ''; a combined
    verse ('17-18') is its first number's, the rest ''. Text across paragraphs and spans (wj) joins with the spacing
    the text nodes carry, and one space between paragraphs."""
    parts, title, last, seen = {}, [], [None], [False]

    def text_of(node, para, marker, upper):
        attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
        text = node.get("text")
        if not isinstance(text, str): return
        if upper: text = text.upper()  # the divine name (nd), set in small capitals: LORD
        if usfm == "PSA" and para == "d" and not seen[0] and marker is None:
            title.append(text); return  # before verse 1, whatever verseId it was given
        m = VERSE_ID.match(attrs["verseId"]) if isinstance(attrs.get("verseId"), str) else None
        v = int(m.group(3)) if m and m.group(1) == usfm and int(m.group(2)) == chapter else 0
        if not v or (marker is not None and text.strip() == marker): return  # a marker's own number
        parts.setdefault(v, []).append(text); last[0] = v

    def walk(items, para, marker, upper):
        for node in items if isinstance(items, list) else ():
            if not isinstance(node, dict): continue
            if node.get("type") == "text":
                text_of(node, para, marker, upper); continue
            attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
            style, name = attrs.get("style") if isinstance(attrs.get("style"), str) else "", node.get("name")
            if name in ("note", "chapter") or APIBIBLE_SKIP.fullmatch(style): continue
            if name == "verse" or style == "v":
                num = str(attrs.get("number", "")).strip()
                m = VERSE_NUMBERS.match(num)
                if m:
                    a = int(m.group(1)); b = int(m.group(2)) if m.group(2) and 0 <= int(m.group(2)) - a < 10 else a
                    for n in range(a, b + 1): parts.setdefault(n, [])
                    seen[0] = True
                walk(node.get("items"), para, num, upper)  # its number drops; text with a verseId is kept
                continue
            if name in APIBIBLE_BLOCKS:
                if APIBIBLE_HEADING.fullmatch(style): continue
                if last[0]: parts[last[0]].append(" ")
                if title: title.append(" ")
                walk(node.get("items"), style if name == "para" else para, marker, upper)
                continue
            walk(node.get("items"), para, marker, upper or style == "nd")

    walk(content, "", None, False)
    clean = lambda p: re.sub(r"\s+", " ", "".join(p)).strip()  # noqa: E731
    return {v: clean(p) for v, p in parts.items() if v >= 1}, clean(title)


def fetch_apibible(bible_id, book_n, chapter):
    """One chapter from API.Bible -> (verses, title, copyright, fumsToken). Raises ApiBibleError."""
    usfm = USFM[book_n - 1]
    d = apibible_get(f"/bibles/{urllib.parse.quote(bible_id, safe='')}/chapters/{usfm}.{chapter}", APIBIBLE_QUERY)
    data = d.get("data") if isinstance(d, dict) else None
    if not isinstance(data, dict) or not isinstance(data.get("content"), list): raise ApiBibleError("no JSON content")
    try: verses, title = apibible_verses(data["content"], usfm, chapter)
    except RecursionError: raise ApiBibleError("content nested too deep")
    cr = re.sub(r"\s+", " ", data["copyright"]).strip() if isinstance(data.get("copyright"), str) else ""
    if not cr: raise ApiBibleError("no copyright")  # it is shown with every display: no text without it
    meta = d.get("meta") if isinstance(d.get("meta"), dict) else {}
    token = meta.get("fumsToken")
    return verses, title, cr, token if isinstance(token, str) and FUMS_TOKEN_RE.fullmatch(token) else ""


class KeyedLocks:
    """One lock per key while anyone holds or waits for it: two readers of one uncached chapter make one call."""
    def __init__(self): self.lock, self.locks = threading.Lock(), {}

    @contextlib.contextmanager
    def hold(self, key):
        with self.lock:
            ent = self.locks.setdefault(key, [threading.Lock(), 0])
            ent[1] += 1
        try:
            with ent[0]: yield
        finally:
            with self.lock:
                ent[1] -= 1
                if not ent[1]: del self.locks[key]


APIBIBLE_CHAPTERS = KeyedLocks()


def _days_old(fetched):
    try: return (datetime.datetime.now(datetime.timezone.utc).date() - datetime.date.fromisoformat(fetched)).days
    except (TypeError, ValueError): return None


def _apibible_gate(client):
    """Room for one upstream call: the client's own allowance (hosted or behind a proxy; locally every reader is '*'
    and has none), then 50 a minute for every client. -> (seconds to wait (0 = counted in both), whether it was the
    client's own allowance that refused)."""
    wait = APIBIBLE_CLIENT_WINDOW.check(client) if client != "*" else 0
    if wait: return wait, True
    wait = UPSTREAM_WINDOW.check("apibible")
    if wait and client != "*": APIBIBLE_CLIENT_WINDOW.unrecord(client)
    return wait, False


def apibible_passage(tr, book_n, chapter, client="*"):
    """/api/passage for niv, nkjv and nasb -> (body, status): {verses, title?, copyright, fumsToken, fetched, v}, the
    shape ESV and NLT answer in, from DATA/cache/<tr>/BB-C.json while under 14 days old. A failed refresh (the budget,
    the rate limits, API.Bible down) serves the cached copy while it is under 30 days old. Errors are {error: message}.
    `client` is Handler._client_key(): only a cache miss counts against its allowance."""
    name = tr.upper()
    bid = APIBIBLE.ids_now(wait=APIBIBLE_TIMEOUT + 5).get(tr)
    if not bid: return {"error": f"{name} is not available here."}, 400
    cpath = os.path.join(A.CACHE, tr, f"{book_n:02d}-{chapter}.json")
    with APIBIBLE_CHAPTERS.hold((tr, book_n, chapter)):
        c = read_json(cpath, None)
        ok = (isinstance(c, dict) and c.get("v") == CACHE_V[tr] and c.get("id") == bid and isinstance(c.get("verses"), list)
              and c["verses"] and all(isinstance(t, str) for t in c["verses"]) and isinstance(c.get("copyright"), str)
              and c["copyright"] and isinstance(c.get("fumsToken"), str))
        age = _days_old(c.get("fetched")) if ok else None
        public = {k: c[k] for k in ("verses", "title", "copyright", "fumsToken", "fetched", "v") if k in c} if ok else None
        if age is not None and 0 <= age < APIBIBLE_FRESH_DAYS: return public, 200
        keep = public if age is not None and 0 <= age < APIBIBLE_KEEP_DAYS else None
        if APIBIBLE.is_paused(tr):
            return keep or {"error": f"{name} could not be loaded just now. Try again in a few minutes."}, 200 if keep else 502
        wait, own = _apibible_gate(client)
        if wait:
            # the client's own allowance runs over 10 minutes and is shared by the three texts: nothing was "at once"
            msg = (f"You’ve opened a lot of new NIV, NKJV and NASB chapters in the last few minutes. Try again in {wait_text(wait)}."
                   if own else f"Too many {name} requests at once. Try again in {wait_text(wait)}.")
            return keep or {"error": msg}, 200 if keep else 429
        if not USAGE.take():
            UPSTREAM_WINDOW.unrecord("apibible")
            if client != "*": APIBIBLE_CLIENT_WINDOW.unrecord(client)
            return (keep, 200) if keep else ({"error": MSG_APIBIBLE_BUDGET}, 429)
        try:
            verses, title, cr, token = fetch_apibible(bid, book_n, chapter)
            verses = {i: t for i, t in verses.items() if 1 <= i <= 200}
            if not any(verses.values()): raise ApiBibleError("no verses")
        except ApiBibleError as e:
            A.log_error(f"apibible: {name} {USFM[book_n - 1]}.{chapter}: {e.why}")
            if e.unreached: USAGE.refund()
            if e.status == 404: APIBIBLE.forget(tr)
            APIBIBLE.pause(tr, e)
            if keep: return keep, 200
            if e.status == 429: return {"error": f"Too many {name} requests at once. Try again in about a minute."}, 429
            return {"error": f"{name} could not be loaded just now. Try again in a few minutes."}, 502
        n = max(verses)
        out = {"verses": [verses.get(i, "") for i in range(1, n + 1)], "copyright": cr, "fumsToken": token,
               "fetched": time.strftime("%Y-%m-%d", time.gmtime()), "v": CACHE_V[tr]}
        if title: out["title"] = title
        try: A.write_json_atomic(cpath, dict(out, id=bid))
        except (OSError, ValueError) as e: A.log_error(f"apibible: cannot cache {name} {book_n}-{chapter}: {e.__class__.__name__}")
        return out, 200


# ----------------------------------------------------------------- rate limiting (in memory, §3.5)
class Window:
    """Sliding window: at most `limit` hits per `seconds` for each key. Hosted, a key names a visitor address and the
    email it tried (Handler._client_key), which a client makes up freely, so the table never outgrows `cap` keys: a key
    whose hits have all aged out is dropped, and past the cap the least recently hit key goes (that visitor starts a
    fresh window, still under the backstop)."""
    def __init__(self, limit, seconds, cap=4096):
        self.limit, self.seconds, self.cap = limit, seconds, cap
        self.hits, self.lock, self.clock = OrderedDict(), threading.Lock(), time.monotonic

    def check(self, key="*", record=True):
        """-> seconds to wait (0 = allowed). With record=True the check and the hit are ONE locked step, so a burst
        of simultaneous requests cannot all see room in the window before any of them is counted."""
        with self.lock:
            now = self.clock()
            dq = self.hits.get(key)
            if dq is None: dq = self.hits[key] = deque()
            while dq and dq[0] <= now - self.seconds: dq.popleft()
            if len(dq) >= self.limit:
                return max(1, math.ceil(dq[0] + self.seconds - now))
            if not record:
                if not dq: del self.hits[key]  # a look leaves nothing behind
                return 0
            dq.append(now)
            self.hits.move_to_end(key)
            if len(self.hits) > self.cap:
                for k in [k for k, d in self.hits.items() if not d or d[-1] <= now - self.seconds]: del self.hits[k]
                while len(self.hits) > self.cap: self.hits.popitem(last=False)
            return 0

    def unrecord(self, key="*"):
        """Give back the newest hit (an attempt that turned out not to count, e.g. a signup for a taken email)."""
        with self.lock:
            dq = self.hits.get(key)
            if dq: dq.pop()
            if dq is not None and not dq: del self.hits[key]


class AttemptFailures:
    """In-memory lockout counters (LRU): for emails with no profile, so known and unknown emails behave the same, and
    on the hosted site for every (account or email, client address) pair, so a lock is only ever the guesser's own.
    Same two-step protocol as a profile's counters: begin() gates and counts before hashing, failed() after."""
    def __init__(self, cap=1000): self.cap, self.d, self.lock = cap, OrderedDict(), threading.Lock()

    @staticmethod
    def _key(email): return hashlib.sha256(email.encode("utf-8")).hexdigest()  # no plain emails kept in memory

    def forget(self, email):
        """The password verified: that client starts from zero."""
        with self.lock: self.d.pop(self._key(email), None)

    def begin(self, email):
        """-> seconds to wait while locked; else counts this attempt as a failure in advance and returns 0."""
        with self.lock:
            k, now = self._key(email), A.now_ms()
            f, until = self.d.pop(k, (0, 0))
            wait = max(0, math.ceil((until - now) / 1000))
            if not wait:
                f += 1
                until = now + A.lock_seconds(f) * 1000
            self.d[k] = (f, until)
            while len(self.d) > self.cap: self.d.popitem(last=False)
            return wait

    def failed(self, email):
        """The attempt did fail: the lockout runs from now. -> lock seconds."""
        with self.lock:
            k = self._key(email)
            f, until = self.d.pop(k, (1, 0))
            secs = A.lock_seconds(f)
            self.d[k] = (f, max(until, A.now_ms() + secs * 1000))
            while len(self.d) > self.cap: self.d.popitem(last=False)
            return secs

    def undo(self, email):
        """The attempt never reached the hash (server busy): do not count it."""
        with self.lock:
            k = self._key(email)
            if k in self.d:
                f, until = self.d[k]
                self.d[k] = (max(0, f - 1), until)


AUTH_WINDOW = Window(30, 60)        # signup + login + password + delete + email change, all clients
SIGNUP_WINDOW = Window(10, 3600)
EVENTS_WINDOW = Window(120, 60)     # per scope
NOTES_WINDOW = Window(300, 60)      # per scope
LINKS_WINDOW = Window(300, 60)      # per scope
MARKS_WINDOW = Window(300, 60)      # per scope
MEMORY_WINDOW = Window(300, 60)     # per scope
UPSTREAM_WINDOW = Window(50, 60)    # ESV/NLT API calls, per translation (ESV throttles a key past 60 a minute)
APIBIBLE_CLIENT_WINDOW = Window(30, 600)  # API.Bible calls (cache misses) per client, hosted: no one spends the month
IMPORT_WINDOW = Window(30, 60)      # profile imports, per scope
# Hosted or behind a proxy, AUTH_WINDOW and SIGNUP_WINDOW count per client (Handler._client_key: the address, and on
# the site also who the attempt is about), so one client cannot lock everyone else out of signing in; these count
# every client together, as a backstop (an X-Forwarded-For address can be made up).
AUTH_BACKSTOP = Window(300, 60)
SIGNUP_BACKSTOP = Window(100, 3600)
FAILURES = AttemptFailures(cap=5000)


# ----------------------------------------------------------------- hosted mode (.design/hosting-brief.md §1)
# Set once by configure_hosting() from the environment. All off by default: local use is exactly as before.
HOSTED = TRUST_PROXY = False
ENV_HOSTS = ()                 # BS_ALLOWED_HOSTS: 'name' or '*.domain' (any subdomain), with or without a port
ALLOWED_ORIGINS = frozenset()  # BS_ALLOWED_ORIGINS: 'https://name[:port]', accepted by the CSRF Origin check
OWNER_EMAILS = frozenset()     # BS_OWNER_EMAILS: owner rights (ESV/NLT, Site activity) for the profile holding the claim
PROXY_SECRET = ""              # BS_PROXY_SECRET: a request carrying it in X-BS-Proxy-Secret came through the site's proxy
OWNER_SETUP_TOKEN = ""         # BS_OWNER_SETUP_TOKEN: lets an owner email take its claim again (after a delete, say)
SIGNUP_CLOSED = False          # BS_SIGNUP=closed: new sign-ups paused, except an owner email by the claim rules
DONATE_DEFAULT = "https://buymeacoffee.com/biblelantern"
DONATE_URL = DONATE_DEFAULT    # BS_DONATE_URL: where /donate and /support send people (locally too)
DONATE_PATHS = frozenset(("/donate", "/support"))
DONATE_URL_RE = re.compile(r"https?://[!-~]+", re.ASCII)  # printable ASCII only: it goes out in a Location header
TURNSTILE = False              # hosted with both keys below: sign-up needs a Cloudflare Turnstile token
TURNSTILE_SITEKEY = ""         # BS_TURNSTILE_SITEKEY: public, sent to the app in auth/me
TURNSTILE_SECRET = ""          # BS_TURNSTILE_SECRET: sent only to the verify URL, never logged
TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
TURNSTILE_VERIFY_URL = TURNSTILE_URL  # BS_TURNSTILE_VERIFY_URL (the tests' fake Cloudflare)
ORIGIN_HOSTS = frozenset()     # the host names in BS_ALLOWED_ORIGINS: where a Turnstile token may have been made
HOSTED_MAX_USERS = 5000        # BS_MAX_USERS: the profile cap on the site (locally --max-users, default 50)
MIN_FREE_BYTES = 200 * MIB     # BS_MIN_FREE_MB: with less free on the volume (or under 5%), new sign-ups get 507
PROXY_HEADER = "X-BS-Proxy-Secret"
HOST_NAME_RE = re.compile(r"(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*", re.ASCII)
ORIGIN_RE = re.compile(r"https?://[a-z0-9.-]+(:[0-9]{1,5})?", re.ASCII)
PORT_SUFFIX = re.compile(r":[0-9]{1,5}\Z")
HEALTH = "/api/health"


def _env_flag(v): return (v or "").strip().lower() in ("1", "true", "yes", "on")


def _env_list(v): return [x.strip().lower() for x in (v or "").split(",") if x.strip()]


def _env_count(env, name, default, bad, low=1):
    """A whole-number variable (>= low), else `default`; a value that is not one is reported as ignored."""
    v = (env.get(name) or "").strip()
    if v and DIGITS.fullmatch(v) and int(v) >= low: return int(v)
    if v: bad.append((name, v))
    return default


def configure_hosting(env):
    """Read the hosting variables from `env` (os.environ). Entries that cannot be used are ignored with a warning."""
    global HOSTED, TRUST_PROXY, ENV_HOSTS, ALLOWED_ORIGINS, OWNER_EMAILS, PROXY_SECRET, OWNER_SETUP_TOKEN
    global SIGNUP_CLOSED, TURNSTILE, TURNSTILE_SITEKEY, TURNSTILE_SECRET, TURNSTILE_VERIFY_URL, ORIGIN_HOSTS
    global HOSTED_MAX_USERS, MIN_FREE_BYTES, DONATE_URL, APIBIBLE_KEY, APIBIBLE_URL, APIBIBLE_PINS, APIBIBLE_MONTHLY
    HOSTED, TRUST_PROXY = _env_flag(env.get("BS_HOSTED")), _env_flag(env.get("BS_TRUST_PROXY"))
    PROXY_SECRET = (env.get("BS_PROXY_SECRET") or "").strip()
    OWNER_SETUP_TOKEN = (env.get("BS_OWNER_SETUP_TOKEN") or "").strip()
    A.LOCK_MAX = 60 if HOSTED else 900  # on the site a lockout is per client, so it only needs to slow guessing (QC 8)
    hosts, origins, owners, bad = [], set(), set(), []
    signup = (env.get("BS_SIGNUP") or "").strip().lower()
    if signup not in ("", "open", "closed"): bad.append(("BS_SIGNUP", signup))
    SIGNUP_CLOSED = HOSTED and signup == "closed"
    TURNSTILE_SITEKEY = (env.get("BS_TURNSTILE_SITEKEY") or "").strip()
    TURNSTILE_SECRET = (env.get("BS_TURNSTILE_SECRET") or "").strip()
    TURNSTILE = HOSTED and bool(TURNSTILE_SITEKEY and TURNSTILE_SECRET)
    url = (env.get("BS_TURNSTILE_VERIFY_URL") or "").strip()
    if url and not re.fullmatch(r"https?://[^\s]+", url): bad.append(("BS_TURNSTILE_VERIFY_URL", url[:100])); url = ""
    TURNSTILE_VERIFY_URL = url or TURNSTILE_URL
    HOSTED_MAX_USERS = _env_count(env, "BS_MAX_USERS", 5000, bad)
    quota_mb = _env_count(env, "BS_PROFILE_QUOTA_MB", 25, bad, low=0)  # 0 turns the quota off
    A.PROFILE_QUOTA = quota_mb * MIB if HOSTED else 0  # locally there is no quota (open sign-up brief §1.3)
    MIN_FREE_BYTES = _env_count(env, "BS_MIN_FREE_MB", 200, bad, low=0) * MIB
    url = (env.get("BS_DONATE_URL") or "").strip()
    if url and not DONATE_URL_RE.fullmatch(url): bad.append(("BS_DONATE_URL", url[:100])); url = ""
    DONATE_URL = url or DONATE_DEFAULT
    key = (env.get("BS_APIBIBLE_KEY") or "").strip()  # API.Bible (translations brief §1), locally too
    if key and not APIBIBLE_KEY_RE.fullmatch(key): bad.append(("BS_APIBIBLE_KEY", "a value that is not valid")); key = ""
    APIBIBLE_KEY = key
    url = (env.get("BS_APIBIBLE_URL") or "").strip().rstrip("/")
    if url and not re.fullmatch(r"https?://[!-~]+", url): bad.append(("BS_APIBIBLE_URL", url[:100])); url = ""
    APIBIBLE_URL = url or APIBIBLE_DEFAULT_URL
    pins = {}
    for item in (env.get("BS_APIBIBLE_BIBLES") or "").split(","):
        tr, _, bid = item.strip().partition("=")
        tr, bid = tr.strip().lower(), bid.strip()  # ids keep their case
        if not item.strip(): continue
        if tr in APIBIBLE_TRS and APIBIBLE_ID_RE.fullmatch(bid): pins[tr] = bid
        else: bad.append(("BS_APIBIBLE_BIBLES", item.strip()[:100]))
    APIBIBLE_PINS = pins
    APIBIBLE_MONTHLY = _env_count(env, "BS_APIBIBLE_MONTHLY", 4800, bad, low=0)
    for h in _env_list(env.get("BS_ALLOWED_HOSTS")):
        name = PORT_SUFFIX.sub("", h)
        if HOST_NAME_RE.fullmatch(name): hosts.append(name)
        else: bad.append(("BS_ALLOWED_HOSTS", h))
    for o in _env_list(env.get("BS_ALLOWED_ORIGINS")):
        o = o.rstrip("/")
        if ORIGIN_RE.fullmatch(o): origins.add(o)
        else: bad.append(("BS_ALLOWED_ORIGINS", o))
    for e in _env_list(env.get("BS_OWNER_EMAILS")):
        ok, email, _ = A.validate_email(e)
        if ok: owners.add(email)
        else: bad.append(("BS_OWNER_EMAILS", "an address that is not valid"))  # never print an email
    ENV_HOSTS, ALLOWED_ORIGINS, OWNER_EMAILS = tuple(hosts), frozenset(origins), frozenset(owners)
    ORIGIN_HOSTS = frozenset(urllib.parse.urlsplit(o).hostname for o in origins)
    for var, v in bad: print(f"Warning: {var}: ignored {v}", file=sys.stderr)


def env_host_ok(h):
    """A Host header (lowercased) named by BS_ALLOWED_HOSTS. A proxy may or may not keep the port, so any is fine."""
    name = PORT_SUFFIX.sub("", h)
    if not ENV_HOSTS or not HOST_NAME_RE.fullmatch(name) or name.startswith("*"): return False
    return any(name == p or (p.startswith("*.") and name.endswith(p[1:]) and len(name) > len(p) - 1) for p in ENV_HOSTS)


# ----------------------------------------------------------------- open sign-up (.design/open-signup-brief.md §1)
TURNSTILE_TIMEOUT = 6
TURNSTILE_TOKEN_MAX = 2048
TURNSTILE_TEST_SECRET = re.compile(r"[123]x0{31}AA", re.ASCII)  # Cloudflare's published test secrets (always pass/fail)


class TurnstileUnavailable(Exception):
    pass


def holds_owner_claim(user, claims):
    """A users.json record with owner rights: hosted, its email in BS_OWNER_EMAILS and that email's claim its own."""
    if not HOSTED or not user or user.get("email") not in OWNER_EMAILS: return False
    rec = claims.get(A.claim_key(user["email"]))
    return isinstance(rec, dict) and rec.get("uid") == user.get("uid")


def turnstile_check(token, remoteip, hosts):
    """Ask Cloudflare whether a sign-up's Turnstile token is good: made for action 'signup' on one of `hosts`. -> None
    when it passed, else why not (a short word for the log; never the token or the secret). Raises TurnstileUnavailable
    when Cloudflare cannot be reached in time or answers something that is not a verdict: sign-up then fails closed."""
    form = {"secret": TURNSTILE_SECRET, "response": token}
    if remoteip: form["remoteip"] = remoteip
    req = urllib.request.Request(TURNSTILE_VERIFY_URL, data=urllib.parse.urlencode(form).encode("utf-8"),
                                 headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "bible-lantern"})
    try:
        with urllib.request.urlopen(req, timeout=TURNSTILE_TIMEOUT) as r: out = json.loads(r.read(64 * KIB).decode("utf-8"))
    except (OSError, ValueError, http.client.HTTPException) as e:  # URLError, HTTPError and timeouts are OSErrors
        raise TurnstileUnavailable(e.__class__.__name__)
    if not isinstance(out, dict) or not isinstance(out.get("success"), bool): raise TurnstileUnavailable("no verdict")
    if not out["success"]:
        codes = out.get("error-codes")
        codes = [c for c in codes if isinstance(c, str)] if isinstance(codes, list) else []
        return "failed" + (":" + ",".join(codes)[:80] if codes else "")
    # Cloudflare's test secrets answer for "example.com" with no action, whatever the page: nothing more to check
    if TURNSTILE_TEST_SECRET.fullmatch(TURNSTILE_SECRET): return None
    if out.get("action") != "signup": return "action"
    if not isinstance(out.get("hostname"), str) or out["hostname"].lower() not in hosts: return "hostname"
    return None


def disk_state():
    """-> shutil.disk_usage of the data volume (total, used, free), or None when it cannot be read."""
    try: return shutil.disk_usage(A.DATA)
    except OSError: return None


LOW_TTL = 15                   # seconds auth/me reuses the last free-space check (every page load asks)
_low_seen = (None, False)      # (time.monotonic(), low) of that check


def volume_low(du): return du is not None and (du.free < MIN_FREE_BYTES or du.free * 20 < du.total)


def storage_low(du=None):
    """The volume is nearly full: under 5% or under BS_MIN_FREE_MB free. Logs an [alert] (once an hour) while it is."""
    global _low_seen
    du = du or disk_state()
    low = volume_low(du)
    _low_seen = (time.monotonic(), low)
    if low: ALERTS.fire("storage_low", f"the data volume has {du.free // MIB} MB free of {du.total // MIB} MB")
    return low


def storage_low_seen():
    """storage_low() for auth/me: the last answer while it is under LOW_TTL seconds old, and no [alert] line of its own
    (a sign-up, the health check and Site activity raise that)."""
    global _low_seen
    t, low = _low_seen
    if t is None or time.monotonic() - t >= LOW_TTL:
        low = volume_low(disk_state())
        _low_seen = (time.monotonic(), low)
    return low


def signup_pause(n_users):
    """Why new sign-ups are paused on the site (donate brief §2): 'paused' (BS_SIGNUP=closed), 'storage' (the free-space
    guard) or 'capacity' (BS_MAX_USERS profiles), else None. Owners still get in by the claim rules while 'paused'.
    Locally always None: the profile cap there is features.signup, as before."""
    if not HOSTED: return None
    if SIGNUP_CLOSED: return "paused"
    if storage_low_seen(): return "storage"
    if n_users >= A.MAX_USERS: return "capacity"
    return None


class Alerts:
    """'[alert]' lines on stderr, at most one an hour for each kind, for a Railway log alert to watch: more than
    LIMITS[kind] of those events within the last hour, or the volume running low (storage_low)."""
    WINDOW = 3600
    LIMITS = {"signups": 30, "signin_failed": 100, "bot_failed": 50, "errors_5xx": 20}
    TEXT = {"signups": "sign-ups", "signin_failed": "failed sign-ins", "bot_failed": "failed bot checks",
            "errors_5xx": "server errors (5xx)"}

    def __init__(self, clock=time.monotonic):
        self.clock, self.lock, self.last = clock, threading.Lock(), {}
        # the newest LIMIT + 1 times of each kind: more than LIMIT in the hour when the oldest of them is in it
        self.recent = {k: deque(maxlen=n + 1) for k, n in self.LIMITS.items()}

    def note(self, kind):
        with self.lock:
            now, dq = self.clock(), self.recent[kind]
            dq.append(now)
            if len(dq) < dq.maxlen or dq[0] <= now - self.WINDOW: return False
        return self.fire(kind, f"more than {self.LIMITS[kind]} {self.TEXT[kind]} in the last hour")

    def fire(self, kind, text):
        with self.lock:
            now, last = self.clock(), self.last.get(kind)
            if last is not None and now - last < self.WINDOW: return False
            self.last[kind] = now
        try: print(f"[alert] {time.strftime('%Y-%m-%dT%H:%M:%S')} {kind}: {text}", file=sys.stderr, flush=True)
        except Exception: pass  # noqa: logging must never break a request
        return True


ALERTS = Alerts()

METRIC_KEYS = ("loads", "visitors", "guests", "active_profiles", "signups", "signins", "signin_failed", "bot_failed",
               "rate_limited", "csrf_blocked", "errors_5xx", "api_requests")


class Metrics:
    """The API's own daily counts (UTC days) for the owners' Site activity panel, in DATA/metrics.json as
    {"v": 1, "days": {"YYYY-MM-DD": {counter: n}}}: 90 days kept, written atomically at most once a minute (flush_loop)
    and at shutdown; a missing or damaged file starts fresh (a damaged one is moved aside). `visitors`, `guests` (signed
    out) and `active_profiles` are approximately unique: a per-day set of SHA-256 digests of a random per-day salt and
    the address and User-Agent (or the uid), held in memory only and dropped at midnight UTC. Only the counts are ever
    written: no address, user agent or uid. After a restart the day's sets start empty, so a returning visitor may
    count twice."""
    KEEP_DAYS, FLUSH_EVERY, SET_CAP = 90, 60, 100_000
    UNIQUE = ("visitors", "guests", "active_profiles")

    def __init__(self, path, clock=time.time):
        self.path, self.clock, self.lock, self.write_lock = path, clock, threading.Lock(), threading.Lock()
        self.days, self.dirty, self.day, self.salt, self.seen = {}, False, None, b"", {}

    def load(self):
        d = A.read_json_strict(self.path, {})
        days = d.get("days") if isinstance(d.get("days"), dict) else {}
        out = {}
        for k, row in days.items():
            if isinstance(k, str) and A.DAY_RE.fullmatch(k) and isinstance(row, dict):
                out[k] = {c: row[c] for c in METRIC_KEYS if A._is_int(row.get(c)) and 0 <= row[c] < 2 ** 53}
        with self.lock: self.days = out
        return self

    def _today(self):
        """Today's row (UTC). A new day gets a new salt and empty sets."""
        day = time.strftime("%Y-%m-%d", time.gmtime(self.clock()))
        if day != self.day:
            self.day, self.salt, self.seen = day, secrets.token_bytes(16), {k: set() for k in self.UNIQUE}
        return self.days.setdefault(day, {})

    def add(self, counter, n=1):
        with self.lock:
            row = self._today()
            row[counter] = row.get(counter, 0) + n
            self.dirty = True

    def unique(self, counter, *parts):
        """Count `parts` (an address and a User-Agent, or a uid) once a day for `counter`."""
        with self.lock:
            row = self._today()
            h = hashlib.sha256(self.salt + "\n".join(parts).encode("utf-8", "replace")).digest()[:16]
            seen = self.seen[counter]
            if h in seen: return
            if len(seen) < self.SET_CAP: seen.add(h)  # past the cap each one counts: still a bounded set
            row[counter] = row.get(counter, 0) + 1
            self.dirty = True

    def flush(self):
        """Write the counts if they changed (pruned to KEEP_DAYS). A failed write is logged and retried next time."""
        with self.write_lock:
            with self.lock:
                if not self.dirty: return False
                for k in sorted(self.days)[:-self.KEEP_DAYS]: del self.days[k]
                snap, self.dirty = {"v": 1, "days": {k: dict(v) for k, v in self.days.items()}}, False
            try:
                A.write_json_atomic(self.path, snap, indent=None)
                return True
            except (OSError, ValueError) as e:
                with self.lock: self.dirty = True
                A.log_error(f"metrics: cannot write {os.path.basename(self.path)}: {e.__class__.__name__}")
                return False

    def flush_loop(self, stop):
        while not stop.wait(self.FLUSH_EVERY): self.flush()

    def report(self, n=30):
        """-> {days: the last `n` UTC days, oldest first, every counter present; last_7 and last_30: their sums}."""
        with self.lock:
            self._today()
            now = self.clock()
            dates = [time.strftime("%Y-%m-%d", time.gmtime(now - 86400 * i)) for i in range(n - 1, -1, -1)]
            days = [dict({c: self.days.get(d, {}).get(c, 0) for c in METRIC_KEYS}, date=d) for d in dates]
        total = lambda rows: {c: sum(r[c] for r in rows) for c in METRIC_KEYS}  # noqa: E731
        return {"days": days, "last_7": total(days[-7:]), "last_30": total(days[-30:])}


METRICS = None  # a Metrics when hosted (main); locally nothing is counted or written


# ----------------------------------------------------------------- HTTP
MSG_SIGNUP_PAUSED = "New sign-ups are paused for now while we expand. Reading stays open to everyone."
MESSAGES = {
    "bad_json": "The request body must be a JSON object.",
    "invalid_email": A.MSG_EMAIL,
    "invalid_name": A.MSG_NAME,
    "invalid_note": "That note could not be saved.",
    "invalid_study": "That study could not be saved.",
    "invalid_themes": "Those theme choices could not be saved.",
    "invalid_link": "That link could not be saved.",
    "invalid_mark": "That highlight could not be saved.",
    "invalid_memory_verse": "That memory verse could not be saved.",
    "invalid_ref": "That is not a valid Bible reference.",
    "invalid_label": "Labels can be up to 80 characters.",
    "invalid_color": "Choose red, orange, yellow, green, blue or purple.",
    "invalid_batch": "That batch of events is not valid.",
    "invalid_reset": "Choose what to reset: activity, progress or bookmarks.",
    "scope_required": "This request must say whose data it is for (X-BS-Scope).",
    "bad_request": "That request is not valid.",
    "not_signed_in": "Sign in to continue.",
    "bad_credentials": "That email and password don’t match a profile on this computer.",
    "bad_host": "This server only answers on localhost.",
    "csrf": "Cross-site request blocked.",
    "user_limit": "This computer already has the maximum number of profiles.",
    "not_found": "Not found.",
    "method_not_allowed": "Method not allowed.",
    "email_taken": "There’s already a profile for that email.",
    "scope_mismatch": "You signed in or out in another window. Reload to continue.",
    "rev_conflict": "Your notes changed in another window. Reload to continue.",
    "bookmark_limit": "You’ve reached the limit of 2,000 bookmarks.",
    "link_limit": "You’ve reached the limit of 10,000 links.",
    "mark_limit": "You’ve reached the limit of 20,000 highlights and comments.",
    "memory_verse_limit": "You’ve reached the limit of 1,000 memory verses.",
    "length_required": "Content-Length is required.",
    "too_large": "The request is too large.",
    "unsupported_media_type": "Send JSON with Content-Type: application/json.",
    "rate_limited": "Too many attempts. Try again in a moment.",
    "server_error": "Something went wrong on the server.",
    "busy": "The server is busy. Try again in a moment.",
    "sign_in_required": "Sign in to save your notes, links and highlights.",
    "owner_only": "Only the owner of this site can do that.",
    "signup_closed": MSG_SIGNUP_PAUSED,  # signup_closed and storage_full only ever happen on the site
    "bot_check_failed": "We couldn’t confirm you’re not a bot. Try the check again.",
    "bot_check_unavailable": "The sign-up check is unavailable right now. Try again in a minute.",
    "quota_exceeded": "Your profile has reached its storage limit. Delete some notes or highlights to make room.",
    "storage_full": MSG_SIGNUP_PAUSED,
    "invalid_import": "That file isn’t a Bible study profile export.",
    "registry_unavailable": "Profiles are unavailable: users.json in the data folder is missing or damaged. "
                            "Restore it from users.json.bak (see README), then try again.",
}
HOSTED_MESSAGES = {  # the same errors on the site, where a visitor has no computer, Terminal or users.json to look at
    "bad_credentials": "That email and password don’t match a profile on this site.",
    "bad_host": "This server doesn’t answer for that host name.",
    "user_limit": MSG_SIGNUP_PAUSED,  # the site's three sign-up pauses share one message (donate brief §2)
    "registry_unavailable": "Profiles are unavailable right now. Try again later.",
}
MSG_OWNER_TEXT = "ESV and NLT are available only to the owner of this site."
MSG_ORPHANED = ("A profile for that email is on this computer but missing from users.json. "
                "Restore users.json from users.json.bak (see README), then sign in.")
MSG_OWNER_EMAIL = "Add the new address to BS_OWNER_EMAILS first, or this profile will lose its owner rights."
MSG_LAST_OWNER = "This is the site owner’s profile. Add another owner email first."


class ApiError(Exception):
    def __init__(self, status, code, message=None, field=None, retry_after=None, extra=None, headers=None):
        super().__init__(code)
        self.status, self.code, self.field, self.retry_after = status, code, field, retry_after
        self.message = message or (HOSTED_MESSAGES.get(code) if HOSTED else None) or MESSAGES.get(code, code)
        self.extra, self.headers = extra or {}, headers or []

    def body(self):
        b = {"error": self.code, "message": self.message}
        if self.field: b["field"] = self.field
        if self.retry_after is not None: b["retryAfter"] = int(self.retry_after)
        b.update(self.extra)
        return b


def wait_text(secs):
    """'1 second', '45 seconds', 'about 2 minutes', 'about an hour': a wait a person can read (QC 15)."""
    secs = max(1, math.ceil(secs))
    if secs < 60: return f"{secs} second{'s' if secs != 1 else ''}"
    m = math.ceil(secs / 60)
    if m < 60: return f"about {m} minute{'s' if m != 1 else ''}"
    h = math.ceil(secs / 3600)
    return "about an hour" if h == 1 else f"about {h} hours"


def rate_limited(wait, uid=None, **log):
    A.log("rate-limit", uid if uid is not None else "unknown", **log)
    return ApiError(429, "rate_limited", f"Too many attempts. Try again in {wait_text(wait)}.", retry_after=int(wait))


class Route:
    """write=True: it writes the request's scope, so in hosted mode a guest gets 401 sign_in_required."""
    def __init__(self, fn, limit=0, auth=False, scope=False, write=False):
        self.fn, self.limit, self.auth, self.scope, self.write = fn, limit, auth, scope, write


BOOKMARK_PATH = re.compile(r"/api/library/bookmarks/([^/]+)")


class Handler(SimpleHTTPRequestHandler):
    timeout = 30  # per socket operation; stops idle connections from pinning a thread
    serve_mocks = False  # --dev: also serve app/mock/

    def __init__(self, *a, **kw): super().__init__(*a, directory=APP, **kw)

    def log_message(self, fmt, *args):
        """The access log for API requests, on stdout: it is information, and a host reads stderr as errors (QC 12)."""
        if args and "/api/" in str(args[0]):
            try: print(f"{self.address_string()} - - [{self.log_date_time_string()}] {fmt % args}", flush=True)
            except Exception: pass  # noqa

    # ------------------------------------------------------------ request state and host allowlist (§3.3)
    def _reset_state(self):
        self._scope, self._uid, self._sess = "guest", None, None
        self._cookies, self._bad_cookie, self._unread = [], False, 0
        self._status, self._err = 0, None  # what was answered, for the daily counts (Metrics)
        cl = self.headers.get("Content-Length")
        if cl is not None and DIGITS.fullmatch(cl.strip()): self._unread = int(cl.strip())

    def _raw_path(self): return self.path.split("?", 1)[0].split("#", 1)[0]

    def _query(self): return urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")

    def _is_api(self): return getattr(self, "path", "").startswith("/api/")

    def _host_ok(self):
        hosts = self.headers.get_all("Host") or []
        if len(hosts) != 1: return False
        h, p = hosts[0].strip().lower(), A.PORT
        return (h in {f"127.0.0.1:{p}", f"localhost:{p}", f"[::1]:{p}"} or h in {f"{n}:{p}" for n in A.ALLOWED_HOSTS}
                or env_host_ok(h))

    def parse_request(self):
        if not super().parse_request(): return False
        self._reset_state()
        if self._host_ok(): return True
        # A host's health checker uses its own name (Railway: healthcheck.railway.app), and uptime monitors often ask
        # with HEAD; the answer is only {"ok": true|false}.
        if HOSTED and self.command in ("GET", "HEAD") and self._raw_path() == HEALTH: return True
        A.log("bad-host")
        self.close_connection = True
        if self._raw_path().startswith("/api/"):
            self.send_json(ApiError(403, "bad_host").body(), 403)
        else:
            body = b"403 Forbidden: this server only answers on localhost.\n"
            self.send_response(403); self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body))); self.end_headers()
            if self.command != "HEAD": self.wfile.write(body)
        self._drain()
        return False

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        # --dev lets the app's own origin frame it (the mock harnesses and the social-card renders); live it is never framed
        self.send_header("X-Frame-Options", "SAMEORIGIN" if self.serve_mocks else "DENY")
        self.send_header("Content-Security-Policy", "frame-ancestors 'self'" if self.serve_mocks else "frame-ancestors 'none'")
        # Static files: always revalidate (cheap 304s), so a rebuild or an app update shows up on the next load.
        if not self._is_api(): self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def list_directory(self, path):
        """No autoindex: a directory without index.html is a 404, never an inventory of app/."""
        self.send_error(404, "File not found")
        return None

    def send_head(self):
        # Dotfiles are never served: app/.DS_Store names what is in app/ (an .env or .git would be worse). A NUL
        # ('%00') or a lone surrogate ('%ED%A0%80') makes open() raise ValueError, which the stdlib does not catch:
        # the request died with a traceback and no response. So did a byte that is not UTF-8 ('%ff', '%C0%AF', a cut-off
        # '%E2%82'): 'surrogatepass' lets only encoded surrogates through. All of these are a plain 404.
        try: rel = urllib.parse.unquote(self._raw_path(), errors="surrogatepass")
        except UnicodeDecodeError: rel = None
        if rel is None or "\x00" in rel or any(seg.startswith(".") for seg in rel.split("/")):
            self.send_error(404, "File not found")
            return None
        # app/mock/ holds design mocks and builder harnesses, not the app: one runs the whole app shell outside dry
        # mode, so a stray visit wrote real reading data. Only --dev serves them ('/MOCK/', '//mock/' alike).
        if not self.serve_mocks and [seg.lower() for seg in os.path.normpath(rel).split("/") if seg][:1] == ["mock"]:
            self.send_error(404, "File not found")
            return None
        # '/js' would otherwise answer 301 -> '/js/' (then 404): not even which folders exist is disclosed.
        path = self.translate_path(self.path)
        if os.path.isdir(path) and not os.path.isfile(os.path.join(path, "index.html")):
            self.send_error(404, "File not found")
            return None
        try:
            return super().send_head()
        except ValueError:  # open() refused the path before anything was sent
            self.send_error(404, "File not found")
            return None

    # ------------------------------------------------------------ responses
    def send_json(self, obj, status=200, headers=()):
        body = json.dumps(obj, ensure_ascii=False, allow_nan=False).encode("utf-8")  # never answer invalid JSON
        self._status = status
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-BS-Scope", getattr(self, "_scope", "guest"))
        for k, v in headers: self.send_header(k, v)
        for c in getattr(self, "_cookies", []): self.send_header("Set-Cookie", c)
        self.end_headers()
        if self.command != "HEAD": self.wfile.write(body)

    def send_redirect(self, url):
        """302 to `url` (the donation link). Never a permanent redirect and never cached, so it can be re-pointed."""
        body = f"Found: {url}\n".encode("utf-8")
        self._status = 302
        self.send_response(302)
        self.send_header("Location", url)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()  # adds Cache-Control: no-cache
        if self.command != "HEAD": self.wfile.write(body)

    def send_download(self, data, ctype, filename):
        self._status = 200
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-BS-Scope", self._scope)
        for c in self._cookies: self.send_header("Set-Cookie", c)
        self.end_headers()
        self.wfile.write(data)

    def _drain(self):
        """Read and discard an unread request body, so the answer already sent reaches the client before the socket
        closes: closing with bytes still unread resets the connection, and a proxy in between (Vercel) then shows its
        own 502 instead of the JSON error (QC 14). Bounded: a little more than the largest body any route accepts,
        within 10 s; past that the connection is simply closed."""
        n, self._unread = min(getattr(self, "_unread", 0), MAX_BODY + MIB), 0
        if n <= 0: return
        self.close_connection = True
        deadline = time.monotonic() + 10.0
        try:
            self.connection.settimeout(1.0)
            while n > 0 and time.monotonic() < deadline:
                chunk = self.rfile.read1(min(65536, n))
                if not chunk: break
                n -= len(chunk)
        except (OSError, ValueError):
            pass

    # ------------------------------------------------------------ cookies and sessions (§3.2)
    def _cookie_tokens(self):
        out = []
        for header in self.headers.get_all("Cookie") or []:
            for part in header.split(";"):
                name, sep, value = part.strip().partition("=")
                if sep and name.strip() == A.COOKIE: out.append(value.strip().strip('"'))
        return out

    def set_session_cookie(self, token, remember, max_age=None):
        c = f"{A.COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict" + ("; Secure" if HOSTED else "")
        if remember: c += f"; Max-Age={int(max_age if max_age is not None else A.REMEMBER_MAX_AGE)}"
        self._cookies = [c]

    def clear_session_cookie(self):
        self._cookies = [f"{A.COOKIE}=; Path=/; HttpOnly; SameSite=Strict{'; Secure' if HOSTED else ''}; Max-Age=0"]

    def resolve_auth(self):
        tokens = self._cookie_tokens()
        for t in tokens:
            r = A.resolve_session(t)
            if r:
                self._uid, self._sess = r
                self._scope = self._uid
                if self._sess.get("slid") and self._sess.get("remember"):
                    self.set_session_cookie(t, True, max(1, (self._sess["expires"] - A.now_ms()) // 1000))
                return
        self._bad_cookie = bool(tokens)

    def ua(self): return self.headers.get("User-Agent", "")

    # ------------------------------------------------------------ client address and owners (hosting brief §1)
    def via_proxy(self):
        """True when BS_PROXY_SECRET is set and the request carries it: it came through the site's proxy (Vercel), whose
        own headers then name the visitor. A request straight to the API host cannot forge that (QC 2)."""
        if not PROXY_SECRET: return False
        given = (self.headers.get(PROXY_HEADER) or "").strip()
        return hmac.compare_digest(given.encode("utf-8"), PROXY_SECRET.encode("utf-8"))

    def client_ip(self):
        """With BS_TRUST_PROXY, the first X-Forwarded-For hop (the client the proxy saw); otherwise the socket's peer.
        Behind two proxies (Vercel, then the host's) the last one rewrites X-Forwarded-For to the first one's address,
        so a request proved to come through Vercel (via_proxy) is read from Vercel's own visitor headers first."""
        if TRUST_PROXY:
            names = ("X-Vercel-Forwarded-For", "X-Real-IP", "X-Forwarded-For") if self.via_proxy() else ("X-Forwarded-For",)
            for name in names:
                first = ",".join(self.headers.get_all(name) or []).split(",")[0].strip()
                try: return str(ipaddress.ip_address(first))
                except ValueError: pass
        return str(self.client_address[0]) if self.client_address else "?"

    def stats_ip(self):
        """The visitor's address for the daily visitor count only, never for security: Vercel's own visitor headers even
        without the proxy secret, else the address the rate limits use (open sign-up brief §1.4)."""
        for name in ("X-Vercel-Forwarded-For", "X-Real-IP"):
            first = ",".join(self.headers.get_all(name) or []).split(",")[0].strip()
            try: return str(ipaddress.ip_address(first))
            except ValueError: pass
        return self.client_ip()

    def _per_client(self): return HOSTED or TRUST_PROXY

    def _ip_log(self): return {"ip": self.client_ip()} if self._per_client() else {}

    def _client_key(self, who=None):
        """What a per-client window counts: '*' locally (everyone is one client), else the client address, and on the
        site also who the attempt is about (QC 2): visitors who share a proxy address then do not share an allowance."""
        key = self.client_ip() if self._per_client() else "*"
        if HOSTED and who: key = f"{key}|{hashlib.sha256(who.encode('utf-8')).hexdigest()[:16]}"
        return key

    def _hit(self, window, backstop, who=None):
        """Check and count one hit. Locally one window for every client ("*", as always); hosted or behind a proxy, one
        per client (_client_key) plus the backstop for all of them. -> (seconds to wait, the key counted)."""
        key = self._client_key(who)
        wait = window.check(key)
        if not wait and key != "*":
            wait = backstop.check()
            if wait: window.unrecord(key)
        return wait, key

    def _unhit(self, window, backstop, key):
        window.unrecord(key)
        if key != "*": backstop.unrecord()

    def is_owner(self, user=None):
        """Hosted mode only: the signed-in profile's email is in BS_OWNER_EMAILS and the profile holds that email's
        claim (owner-claims.json), so a stranger who signs up with a freed owner address is an ordinary profile.
        Locally nobody is an owner."""
        if not HOSTED or not self._uid: return False
        with A.auth_lock():
            user = user if user is not None else A.load_users()["users"].get(self._uid)
            return holds_owner_claim(user, A.load_owner_claims())

    def owner_or_403(self):
        if not self.is_owner(): raise ApiError(403, "owner_only")

    def _owner_claim_ok(self, email, body, claims=None):
        """Hosted: may this sign-up take the owner rights that come with `email`? An owner email no profile has claimed
        yet, or any owner email with the setup token (the owner coming back after a delete or an email change, QC 0).
        Anyone else signing up with an owner email gets an ordinary profile: never refused, so the address cannot be
        squatted or probed, and never an owner."""
        if not HOSTED or email not in OWNER_EMAILS: return False
        token = body.get("setupToken")
        if OWNER_SETUP_TOKEN and isinstance(token, str) and hmac.compare_digest(token.encode("utf-8"), OWNER_SETUP_TOKEN.encode("utf-8")):
            return True
        if claims is None:
            with A.auth_lock(): claims = A.load_owner_claims()
        return A.claim_key(email) not in claims

    # ------------------------------------------------------------ CSRF pipeline and body (§3.4)
    def check_same_origin(self):
        """403 csrf for a request another site made: an Origin must be this server; without one, Sec-Fetch-Site
        must be same-origin or none (typed in the address bar)."""
        path = self._raw_path()
        origin = self.headers.get("Origin")
        host = (self.headers.get("Host") or "").strip().lower()
        if origin is not None:
            scheme = "http"
            if TRUST_PROXY:  # TLS ends at the proxy: the page's own origin is https://
                xfp = (self.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
                if xfp in ("http", "https"): scheme = xfp
            o = origin.strip().lower()
            if o != f"{scheme}://{host}" and o not in ALLOWED_ORIGINS:  # the origin is logged: it is what to allow (QC 13)
                A.log("csrf-block", path=path, reason="origin", origin=o[:100]); raise ApiError(403, "csrf")
        else:
            sfs = self.headers.get("Sec-Fetch-Site")
            if sfs is not None and sfs.strip().lower() not in ("same-origin", "none"):
                A.log("csrf-block", path=path, reason="fetch-site"); raise ApiError(403, "csrf")

    def read_json_body(self, limit):
        """The body as a JSON object. api() has already run check_same_origin() and refused a guest who may not write."""
        path = self._raw_path()
        ctype = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if ctype != "application/json":
            A.log("csrf-block", path=path, reason="content-type"); raise ApiError(415, "unsupported_media_type")
        cls = self.headers.get_all("Content-Length") or []
        if self.headers.get("Transfer-Encoding") or len(cls) != 1 or not DIGITS.fullmatch(cls[0].strip()):
            self.close_connection = True
            raise ApiError(411, "length_required")
        n = int(cls[0].strip())
        if n > limit: raise ApiError(413, "too_large", f"The request is too large (limit {limit // KIB} KiB).")
        raw = self.rfile.read(n) if n else b""
        self._unread = 0
        if len(raw) != n: self.close_connection = True; raise ApiError(400, "bad_json")
        try:
            # NaN/Infinity and numbers too large for a double (1e999) are refused: stored, they would make every
            # later response for that file invalid JSON in the browser.
            obj = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant, parse_float=_finite_float)
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise ApiError(400, "bad_json")
        if not isinstance(obj, dict): raise ApiError(400, "bad_json")
        if A.SURROGATE_ESC_RE.search(raw):  # '\ud800' without its pair decodes to a string that cannot be saved
            try: json.dumps(obj, ensure_ascii=False).encode("utf-8")
            except UnicodeEncodeError: raise ApiError(400, "bad_json", "The request contains text that is not valid Unicode.")
        return obj

    def check_scope(self, required=True):
        h = self.headers.get("X-BS-Scope")
        if h is None:
            if required: raise ApiError(400, "scope_required")
            return
        if h.strip() != self._scope:
            raise ApiError(409, "scope_mismatch", extra={"scope": self._scope})

    # ------------------------------------------------------------ dispatch
    def do_GET(self):
        if self._is_api(): return self.api("GET")
        if self._raw_path() in DONATE_PATHS: return self.send_redirect(DONATE_URL)
        if self._raw_path() == "/": self.path = "/index.html" + self.path[1:]
        elif self._raw_path() == "/privacy": self.path = "/privacy.html" + self.path[len("/privacy"):]  # as vercel.json rewrites it
        return super().do_GET()

    def do_HEAD(self):
        if self._is_api(): return self.api("HEAD")
        if self._raw_path() in DONATE_PATHS: return self.send_redirect(DONATE_URL)
        return super().do_HEAD()

    def _other(self, method):
        if self._is_api(): return self.api(method)
        self.send_error(501, f"Unsupported method ({method!r})")

    def do_POST(self): self._other("POST")
    def do_PUT(self): self._other("PUT")
    def do_PATCH(self): self._other("PATCH")
    def do_DELETE(self): self._other("DELETE")
    def do_OPTIONS(self): self._other("OPTIONS")

    def api(self, method):
        path = self._raw_path()
        q = self._query()
        try:
            self.resolve_auth()
            methods, arg = ROUTES.get(path), None
            if methods is None:
                m = BOOKMARK_PATH.fullmatch(path)
                if m: methods, arg = BOOKMARK_ROUTES, m.group(1)
            if methods is None or (path in HOSTED_ONLY and not HOSTED): raise ApiError(404, "not_found")
            if path in OWNERS_ONLY and not self.is_owner(): raise ApiError(404, "not_found")  # as if it did not exist
            # HEAD is only for the health check (uptime monitors ask that way, QC 10): answered like GET, with no body.
            route = methods.get("GET" if method == "HEAD" and path == HEALTH else method)
            if route is None or method == "OPTIONS":
                raise ApiError(405, "method_not_allowed", headers=[("Allow", ", ".join(sorted(methods)))])
            body = None
            if method not in ("GET", "HEAD"):
                self.check_same_origin()
                if not self._uid and (route.auth or (route.write and HOSTED)):  # before a byte of the body is read (QC 1)
                    raise ApiError(401, "sign_in_required" if route.write and HOSTED else "not_signed_in")
                body = self.read_json_body(route.limit)
            if route.write and HOSTED and not self._uid: raise ApiError(401, "sign_in_required")  # guests read only
            if route.auth and not self._uid: raise ApiError(401, "not_signed_in")
            if route.scope: self.check_scope(required=True)
            route.fn(self, body, q, arg)
        except ApiError as e:
            self._err = e.code
            if e.retry_after is not None: e.headers = list(e.headers) + [("Retry-After", str(int(e.retry_after)))]
            self.send_json(e.body(), e.status, e.headers)
        except A.QuotaExceeded:  # nothing was written (accounts.py: per-profile storage quota)
            A.log("quota", self._uid)
            self.send_json(ApiError(413, "quota_exceeded").body(), 413)
        except A.Busy:
            self.send_json(ApiError(503, "busy", retry_after=2).body(), 503, [("Retry-After", "2")])
        except A.ProfileGone:
            self._scope = "guest"; self.clear_session_cookie()
            self.send_json(ApiError(401, "not_signed_in").body(), 401)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:  # noqa: details go to the log, never to the client
            A.log_error(f"{method} {A._safe_log_text(path)}\n{traceback.format_exc()}")
            try: self.send_json(ApiError(500, "server_error").body(), 500)
            except OSError: pass
        finally:
            self._drain()
            if METRICS is not None and path != HEALTH:  # the host's health probes are not traffic
                try: self._count(method, path)
                except Exception: A.log_error(f"metrics: {traceback.format_exc()}")  # noqa: never breaks a request

    def _count(self, method, path):
        """One API request in today's counts (open sign-up brief §1.4), and the counts the [alert] lines watch."""
        m, st, err = METRICS, self._status, self._err
        m.add("api_requests")
        if self._uid: m.unique("active_profiles", self._uid)
        if st == 429: m.add("rate_limited")
        if st >= 500 and err != "storage_full": m.add("errors_5xx"); ALERTS.note("errors_5xx")  # 507 has its own alert
        if err == "csrf": m.add("csrf_blocked")
        if err == "bot_check_failed": m.add("bot_failed"); ALERTS.note("bot_failed")
        if path == "/api/auth/me" and method == "GET" and st == 200:
            if "boot" in self._query(): m.add("loads")  # ?boot=1 is the app's one call per page load
            m.unique("visitors", self.stats_ip(), self.ua())
            if not self._uid: m.unique("guests", self.stats_ip(), self.ua())
        elif path == "/api/auth/signup" and st == 201:
            m.add("signups"); ALERTS.note("signups")
        elif path == "/api/auth/login" and st == 200:
            m.add("signins")
        elif path == "/api/auth/login" and err == "bad_credentials":
            m.add("signin_failed"); ALERTS.note("signin_failed")

    # ------------------------------------------------------------ auth helpers
    def load_user(self, uid):
        with A.auth_lock(): return A.load_users()["users"].get(uid)

    def check_credentials(self, user, email, password, field="password"):
        """-> True, or 401 bad_credentials (identical for unknown emails) / 429 while locked out.

        The lockout gate and the failure count are ONE atomic step taken before hashing (§3.5): the attempt is
        counted as a failure up front, under the auth lock (or the unknown-email lock), and reset only once the
        password verifies. Simultaneous guesses therefore cannot all pass the gate: at most 5 get hashed before
        the account locks, however they are timed."""
        uid, stored, wait = self._begin_attempt(user["uid"] if user else None, email)
        if wait > 0: raise rate_limited(wait, uid or "unknown")
        pw = password if isinstance(password, str) else ""
        try:
            with A.hash_slot():
                ok = A.verify_password(pw, stored if uid else A.init_dummy_hash(), uid)
        except A.Busy:
            self._end_attempt(uid, email, "undo")
            raise
        if uid and ok:
            self._end_attempt(uid, email, "ok")
            return True
        A.log("login-fail", uid or "unknown", **self._ip_log())
        locked = self._end_attempt(uid, email, "fail")
        if locked: A.log("lockout", uid or "unknown", seconds=locked, **self._ip_log())
        raise ApiError(401, "bad_credentials", field=field)

    def _attempt_key(self, who):
        """What a lockout counts. Locally the account (or the unknown email), as always. On the site the account AND
        the client address (QC 8): a stranger guessing from elsewhere locks only their own attempts, never the owner's.
        What still makes guessing hopeless there: the per-client windows, the backstops and the hash itself."""
        return f"{who}|{self.client_ip()}" if HOSTED else who

    def _begin_attempt(self, uid, email):
        """-> (uid or None, stored hash, seconds to wait). Not locked: the attempt is counted before hashing."""
        if uid:
            with A.auth_lock():
                users = A.load_users(); u = users["users"].get(uid)
                if u is not None:
                    now = A.now_ms()
                    if u["failedLogins"] and now - u["lastFail"] > A.DAY_MS: u["failedLogins"] = 0  # a quiet day forgets them
                    if HOSTED: wait = FAILURES.begin(self._attempt_key(uid))  # the lock lives per client, in memory
                    else: wait = max(0, math.ceil((u["lockUntil"] - now) / 1000))
                    if not wait:
                        f = u["failedLogins"] + 1
                        u["failedLogins"], u["lastFail"] = f, now
                        if not HOSTED: u["lockUntil"] = now + A.lock_seconds(f) * 1000
                        A.save_users(users)
                    return uid, u.get("pw"), wait
        return None, None, FAILURES.begin(self._attempt_key(email))  # no such profile (or deleted meanwhile): same policy

    def _end_attempt(self, uid, email, outcome):
        """outcome 'ok' resets the counters, 'fail' restarts the lockout from now, 'undo' takes the count back
        (the hash never ran). -> lock seconds after a failure."""
        secs = 0
        if not uid or HOSTED:
            key = self._attempt_key(uid or email)
            if outcome == "fail": secs = FAILURES.failed(key)
            elif outcome == "undo": FAILURES.undo(key)
            else: FAILURES.forget(key)
            if not uid: return secs
        with A.auth_lock():
            users = A.load_users(); u = users["users"].get(uid)
            if u is None: return 0
            if outcome == "ok":
                u["failedLogins"], u["lockUntil"] = 0, 0
            elif outcome == "undo":
                u["failedLogins"] = max(0, u["failedLogins"] - 1)
            elif not HOSTED:
                secs = A.lock_seconds(u["failedLogins"])
                if secs: u["lockUntil"] = max(u["lockUntil"], A.now_ms() + secs * 1000)
            A.save_users(users)
            return secs

    def auth_window_or_429(self, who=None):
        """The auth window (per client when hosted, see _hit; `who` is the email or uid the attempt is about): check and
        count in one locked step (see Window.check)."""
        wait, _ = self._hit(AUTH_WINDOW, AUTH_BACKSTOP, who)
        if wait: raise rate_limited(wait, self._uid or "unknown", **self._ip_log())

    def registry_or_503(self, users=None, email=None):
        """Refuse profile creation / sign-in while users.json is missing or damaged, or when the email belongs to a
        profile folder that users.json no longer lists: signing up again would orphan that person's data."""
        if A.registry_problem():
            A.log("registry-unavailable")
            raise ApiError(503, "registry_unavailable")
        orphan = A.orphaned_profile(users, email) if users is not None and email else None
        if orphan:  # on the site the restore details go to the log only (QC 9)
            A.log("registry-orphan", orphan, hint="restore users.json from users.json.bak")
            raise ApiError(503, "registry_unavailable", None if HOSTED else MSG_ORPHANED, field="email")

    def me_body(self):
        if HOSTED:  # the hosted guest store is shared by every visitor and never imported (h_import_guest)
            g = A.guest_summary(A.empty_notes(), A.new_library(), A.empty_links(), A.empty_marks(), A.empty_memory())
        else:
            with A.lock_for("guest"):
                g = A.guest_summary(A.load_notes("guest"), A.load_library("guest"), A.load_links("guest"), A.load_marks("guest"),
                                    A.load_memory("guest"))
        with A.auth_lock():
            users = A.load_users()
            user = users["users"].get(self._uid) if self._uid else None
            n_users = len(users["users"])
            registry_ok = A.registry_problem() is None
        pause = signup_pause(n_users)
        out = {
            "signedIn": bool(user), "scope": self._scope,
            "user": A.public_user(user) if user else None,
            "session": {"remember": bool(self._sess.get("remember")), "expires": self._sess.get("expires")} if user else None,
            "guest": g,
            "limits": {"passwordMin": A.PASSWORD_MIN, "passwordMax": A.PASSWORD_MAX, "nameMax": A.NAME_MAX, "labelMax": A.LABEL_MAX},
            "features": {"signup": n_users < A.MAX_USERS and registry_ok, "profiles": registry_ok},
            "hosted": HOSTED, "signup": "closed" if pause else "open", "signupPause": pause,
            "owner": self.is_owner(user) if user else False,
        }
        if TURNSTILE: out["turnstile"] = {"siteKey": TURNSTILE_SITEKEY}  # only when sign-up needs the check
        return out

    # ------------------------------------------------------------ 1-7 auth and account
    def h_me(self, body, q, arg):
        # An unknown cookie is cleared, except while users.json is unavailable: that session comes back on restore.
        if self._bad_cookie and not self._uid and A.registry_problem() is None: self.clear_session_cookie()
        self.send_json(self.me_body())

    def h_signup(self, body, q, arg):
        ok, email, code = A.validate_email(body.get("email"))
        if not ok: raise ApiError(400, code, field="email")
        ok, name, code = A.validate_name(body.get("name"))
        if not ok: raise ApiError(400, code, field="name")
        pw = body.get("password")
        ok, code, msg = A.validate_password(pw, email)
        if not ok: raise ApiError(400, code, msg, field="password")
        remember = body.get("remember") is True
        import_guest = body.get("importGuest") is True and not HOSTED  # hosted guests save nothing to import
        # Sign-up is open to anyone (an `invite` field is ignored). Paused with BS_SIGNUP=closed, it still lets an owner
        # email in by the claim rules, so the owner can always get back in. A body with a setup token is refused only
        # under the auth lock below, after the rate limits, so the token cannot be guessed at full speed.
        if SIGNUP_CLOSED and "setupToken" not in body and not self._owner_claim_ok(email, body):
            raise ApiError(403, "signup_closed")
        self.auth_window_or_429(email)
        wait, rkey = self._hit(SIGNUP_WINDOW, SIGNUP_BACKSTOP, email)  # checked and counted atomically (no burst overshoots)
        if wait: raise rate_limited(wait, **self._ip_log())
        try:
            if HOSTED and storage_low():  # the volume is nearly full: existing profiles keep writing, new ones wait
                A.log("signup-storage-full", **self._ip_log())
                raise ApiError(507, "storage_full")
            # The bot check comes before anything says whether the email has a profile, and before the hash. A failed
            # check counts against the window like any failed attempt; Cloudflare being unreachable does not.
            if TURNSTILE: self._turnstile_or_403(body.get("turnstileToken"))
        except TurnstileUnavailable as e:
            self._unhit(SIGNUP_WINDOW, SIGNUP_BACKSTOP, rkey)
            A.log_error(f"turnstile: siteverify unavailable ({e}); sign-up refused (503)")
            raise ApiError(503, "bot_check_unavailable")
        except ApiError as e:
            if e.code != "bot_check_failed": self._unhit(SIGNUP_WINDOW, SIGNUP_BACKSTOP, rkey)
            raise
        try:
            with A.auth_lock():
                users = A.load_users()
                self.registry_or_503(users, email)
                if len(users["users"]) >= A.MAX_USERS: raise ApiError(403, "user_limit")
                if A.find_user_by_email(users, email): raise ApiError(409, "email_taken", field="email")
        except ApiError:
            self._unhit(SIGNUP_WINDOW, SIGNUP_BACKSTOP, rkey)  # not a new profile: does not use up the hourly allowance
            raise
        with A.hash_slot(): pw_hash = A.hash_password(pw)
        now = A.now_ms()
        uid = A.new_uid()
        pdir = A.profile_dir(uid)
        imported, created_dir = None, False
        try:
            os.makedirs(A.PROFILES, mode=0o700, exist_ok=True)
            os.mkdir(pdir, 0o700)
            created_dir = True
            notes, lib, links, marks = A.empty_notes(), A.new_library(now), A.empty_links(), A.empty_marks()
            memory = A.empty_memory()
            notes["rev"], lib["rev"], links["rev"], marks["rev"], memory["rev"] = 1, 1, 1, 1, 1
            if import_guest:
                with A.lock_for("guest"):
                    g_notes, g_lib, g_links = A.load_notes("guest"), A.load_library("guest"), A.load_links("guest")
                    g_marks, g_memory = A.load_marks("guest"), A.load_memory("guest")
                if A.guest_summary(g_notes, g_lib, g_links, g_marks, g_memory)["hasData"]:
                    notes = {"refs": g_notes["refs"], "studies": g_notes["studies"], "themes": g_notes["themes"],
                             "rev": 1, "deleted": {}}
                    links["links"] = g_links["links"]  # copied (rev 1, no tombstones); the guest file is left as it is
                    marks["marks"] = g_marks["marks"]  # likewise
                    memory["memory"] = g_memory["memory"]  # likewise
                    counts = A.merge_library(lib, g_lib, "copy", now)
                    imported = {"notes": len(notes["refs"]), "bookmarks": counts["bookmarks"], "chapters": counts["chapters"],
                                "links": len(links["links"]), "marks": len(marks["marks"]), "memory": len(memory["memory"]),
                                "studies": len(notes["studies"]),
                                "themes": len(set(notes["themes"]["accepted"]) | set(notes["themes"]["removed"])  # names, as merge_themes counts them
                                              | set(notes["themes"]["renamed"]) | set(notes["themes"]["merged"]))}
            A.add_activity(lib, {"t": now, "type": "profile.create", "ref": None})
            if imported: A.add_activity(lib, {"t": now, "type": "profile.import", "ref": None, "x": dict(imported)})
            with A.lock_for(uid):  # links, then marks, then memory, then library (the lock order at A.lock_for)
                A.save_notes(uid, notes); A.save_links(uid, links); A.save_marks(uid, marks); A.save_memory(uid, memory)
                A.save_library(uid, lib)
            with A.auth_lock():
                users = A.load_users()
                self.registry_or_503(users, email)
                if len(users["users"]) >= A.MAX_USERS: raise ApiError(403, "user_limit")
                if A.find_user_by_email(users, email): raise ApiError(409, "email_taken", field="email")
                owner = self._owner_claim_ok(email, body, A.load_owner_claims())  # again, under the lock
                if SIGNUP_CLOSED and not owner: raise ApiError(403, "signup_closed")
                user = {"uid": uid, "email": email, "name": name, "pw": pw_hash, "created": now, "updated": now,
                        "lastLogin": now, "pwChanged": now, "failedLogins": 0, "lockUntil": 0, "lastFail": 0}
                users["users"][uid] = user
                A.save_users(users)
                if owner: self._record_owner_claim(email, uid, now)
                if self._sess: A.revoke_session(self._sess["key"])
                token, sess = A.create_session(uid, remember, self.ua())
        except BaseException:
            if created_dir: shutil.rmtree(pdir, ignore_errors=True)
            raise
        self._write_owner(user)  # after users.json, so an owner file always means "users.json knew this profile"
        A.log("signup", uid)
        if HOSTED and email in OWNER_EMAILS and not owner: A.log("owner-email-unclaimed", uid)  # an ordinary profile
        self._uid, self._sess, self._scope = uid, sess, uid
        self.set_session_cookie(token, remember)
        self.send_json({"ok": True, "user": A.public_user(user), "session": {"remember": remember, "expires": sess["expires"]},
                        "imported": imported}, 201)

    def _site_hosts(self):
        """Where this site's pages live: the request's own host and the BS_ALLOWED_ORIGINS hosts (behind the Vercel
        rewrite the request's host is Railway's, the page's www.biblelantern.com)."""
        return ORIGIN_HOSTS | {PORT_SUFFIX.sub("", (self.headers.get("Host") or "").strip().lower())}

    def _turnstile_or_403(self, token):
        """403 bot_check_failed unless Cloudflare passes the sign-up's Turnstile token (TurnstileUnavailable when it
        cannot say). The token and the secret never reach the log."""
        why = "missing"
        if isinstance(token, str) and 0 < len(token) <= TURNSTILE_TOKEN_MAX:
            # remoteip is optional: it is sent only when Vercel's headers name the visitor (via_proxy), since without
            # them client_ip() is a proxy's address, which tells Cloudflare nothing and could fail a real sign-up
            remoteip = self.client_ip() if TRUST_PROXY and self.via_proxy() else ""
            why = turnstile_check(token, remoteip, self._site_hosts())
        if why:
            A.log("bot-check-fail", reason=why, **self._ip_log())
            raise ApiError(403, "bot_check_failed")

    @staticmethod
    def _record_owner_claim(email, uid, now):
        """Call under auth_lock(), after users.json: this profile now holds the owner rights of `email`, and anyone else
        who signs up with that email later gets an ordinary profile unless they have the setup token."""
        claims = A.load_owner_claims()
        claims[A.claim_key(email)] = {"uid": uid, "claimed": now}
        A.save_owner_claims(claims)

    def _write_owner(self, user, only_if_missing=False):
        try:
            A.write_profile_owner(user, only_if_missing)
        except (OSError, ValueError, A.ProfileGone):
            pass  # best effort: a missing owner file is written again at the next sign-in

    def h_login(self, body, q, arg):
        email = A.normalize_email(body.get("email"))
        pw, remember = body.get("password"), body.get("remember") is True
        self.auth_window_or_429(email)
        with A.auth_lock():
            users = A.load_users()  # first: a corrupt file is moved aside here
            self.registry_or_503()
            user = A.find_user_by_email(users, email)
        self.check_credentials(user, email, pw)
        uid = user["uid"]
        new_hash = None
        if A.needs_rehash(user.get("pw")):
            with A.hash_slot(): new_hash = A.hash_password(pw)
        with A.auth_lock():
            users = A.load_users(); u = users["users"].get(uid)
            if not u: raise ApiError(401, "bad_credentials", field="password")
            u.update(failedLogins=0, lockUntil=0, lastLogin=A.now_ms())
            if new_hash: u["pw"] = new_hash
            A.save_users(users)
            if self._sess: A.revoke_session(self._sess["key"])
            token, sess = A.create_session(uid, remember, self.ua())
        self._write_owner(u, only_if_missing=True)  # profiles created before owner files existed
        A.log("login-ok", uid)
        self._uid, self._sess, self._scope = uid, sess, uid
        self.set_session_cookie(token, remember)
        self.send_json({"ok": True, "user": A.public_user(u), "session": {"remember": remember, "expires": sess["expires"]}})

    def h_logout(self, body, q, arg):
        revoked = 0
        if self._sess:
            if body.get("all") is True:
                revoked = A.revoke_sessions(self._uid); A.log("logout-all", self._uid)
            else:
                revoked = A.revoke_session(self._sess["key"]); A.log("logout", self._uid)
        self._uid, self._sess, self._scope = None, None, "guest"
        self.clear_session_cookie()
        self.send_json({"ok": True, "revoked": revoked})

    def h_account_patch(self, body, q, arg):
        has_name, has_email = "name" in body, "email" in body
        if not has_name and not has_email: raise ApiError(400, "bad_request", "Send a name or an email to change.")
        name = email = None
        if has_name:
            ok, name, code = A.validate_name(body.get("name"))
            if not ok: raise ApiError(400, code, field="name")
        if has_email:
            ok, email, code = A.validate_email(body.get("email"))
            if not ok: raise ApiError(400, code, field="email")
            pw = body.get("password")
            if not isinstance(pw, str) or not pw:
                raise ApiError(400, "bad_request", "Enter your password to change your email.", field="password")
            self.auth_window_or_429(self._uid)
            user = self.load_user(self._uid)
            if not user: raise ApiError(401, "not_signed_in")
            self.check_credentials(user, user.get("email", ""), pw)
        with A.auth_lock():
            users = A.load_users(); u = users["users"].get(self._uid)
            if not u: raise ApiError(401, "not_signed_in")
            if has_email and email != u.get("email"):
                other = A.find_user_by_email(users, email)
                if other and other["uid"] != self._uid: raise ApiError(409, "email_taken", field="email")
                owner = holds_owner_claim(u, A.load_owner_claims())  # an owner email alone is not enough (open sign-up)
                if HOSTED and email in OWNER_EMAILS and not owner:  # owner rights come with it
                    raise ApiError(409, "email_taken", field="email")
                if owner and email not in OWNER_EMAILS:  # and would go with it (QC 0)
                    raise ApiError(409, "owner_email", MSG_OWNER_EMAIL, field="email")
                u["email"] = email
                if HOSTED and email in OWNER_EMAILS: self._record_owner_claim(email, self._uid, A.now_ms())
                A.log("email-change", self._uid)
            if has_email: u.update(failedLogins=0, lockUntil=0)
            if has_name: u["name"] = name
            u["updated"] = A.now_ms()
            A.save_users(users)
        self._write_owner(u)
        self.send_json({"ok": True, "user": A.public_user(u)})

    def h_password(self, body, q, arg):
        self.auth_window_or_429(self._uid)
        user = self.load_user(self._uid)
        if not user: raise ApiError(401, "not_signed_in")
        self.check_credentials(user, user.get("email", ""), body.get("current"), field="current")
        nxt = body.get("next")
        ok, code, msg = A.validate_password(nxt, user.get("email", ""))
        if not ok: raise ApiError(400, code, msg, field="next")
        with A.hash_slot(): h = A.hash_password(nxt)
        remember = bool(self._sess.get("remember"))
        with A.auth_lock():
            users = A.load_users(); u = users["users"].get(self._uid)
            if not u: raise ApiError(401, "not_signed_in")
            now = A.now_ms()
            u.update(pw=h, pwChanged=now, updated=now, failedLogins=0, lockUntil=0)
            A.save_users(users)
            revoked = A.revoke_sessions(self._uid)
            token, sess = A.create_session(self._uid, remember, self.ua())
        A.log("password-change", self._uid)
        self._sess = sess
        self.set_session_cookie(token, remember)
        self.send_json({"ok": True, "revokedOthers": max(0, revoked - 1)})

    def h_delete(self, body, q, arg):
        """Locally the profile folder moves to deleted/<uid>-<stamp> (the README says how to erase it). On the site it
        is erased at once, with the users.json entry and the sessions (QC 4); the owner claim stays, so a stranger who
        signs up with the address gets an ordinary profile. The last owner cannot be deleted (QC 0)."""
        self.auth_window_or_429(self._uid)
        user = self.load_user(self._uid)
        if not user: raise ApiError(401, "not_signed_in")
        self.check_credentials(user, user.get("email", ""), body.get("password"))
        uid = self._uid
        with A.auth_lock():
            users = A.load_users(); u = users["users"].get(uid)
            if not u: raise ApiError(401, "not_signed_in")
            claims = A.load_owner_claims() if HOSTED else {}
            if holds_owner_claim(u, claims) and not any(
                    holds_owner_claim(v, claims) for k, v in users["users"].items() if k != uid):
                raise ApiError(409, "last_owner", MSG_LAST_OWNER)
            with A.lock_for(uid):
                src = A.profile_dir(uid)
                if HOSTED:
                    if os.path.isdir(src): shutil.rmtree(src)
                else:
                    os.makedirs(A.DELETED, mode=0o700, exist_ok=True)
                    dst = os.path.join(A.DELETED, f"{uid}-{A.stamp()}")
                    if os.path.isdir(src): os.replace(src, dst)
                    else: os.makedirs(dst, mode=0o700, exist_ok=True)
                    A.write_json_atomic(os.path.join(dst, "user.json"), {k: v for k, v in u.items() if k != "pw"})
                A.DELETED_UIDS.add(uid)
            del users["users"][uid]
            A.save_users(users)
            A.revoke_sessions(uid)
        A.log("account-delete", uid)
        self._uid, self._sess, self._scope = None, None, "guest"
        self.clear_session_cookie()
        self.send_json({"ok": True})

    # ------------------------------------------------------------ 8-10 notes
    def h_notes_get(self, body, q, arg):
        n = A.load_notes(self._scope)
        self.send_json({"refs": n["refs"], "studies": n["studies"], "themes": n["themes"], "rev": n["rev"], "scope": self._scope},
                       headers=[("ETag", f'"{n["rev"]}"')])

    def h_notes_put(self, body, q, arg):
        """Legacy whole-object replace (the pre-profiles client)."""
        if self._uid and self.headers.get("X-BS-Scope") is None:
            raise ApiError(409, "scope_required", "Reload this window: it was opened before you signed in.")
        self.check_scope(required=False)
        if not isinstance(body.get("refs"), dict) or ("studies" in body and not isinstance(body["studies"], list)):
            raise ApiError(400, "bad_request", "Notes must look like {\"refs\": {...}, \"studies\": [...]}.")
        studies, themes = self._studies_and_themes(body)
        with A.lock_for(self._scope):
            cur = A.load_notes(self._scope)
            im = self.headers.get("If-Match")
            if im is not None and im.strip().lstrip("W/").strip('"') != str(cur["rev"]):
                raise ApiError(409, "rev_conflict", extra={"rev": cur["rev"]})
            new = {k: v for k, v in body.items() if k not in ("rev", "deleted", "scope")}
            new["studies"] = cur["studies"] if studies is None else studies  # the pre-studies client never sends them
            new["themes"] = cur["themes"] if themes is None else themes
            new["rev"], new["deleted"] = cur["rev"] + 1, {}
            A.save_notes(self._scope, new, quota=True)
        self.send_json({"ok": True, "saved": time.strftime("%H:%M:%S"), "rev": new["rev"]})

    def _studies_and_themes(self, body):
        """The optional `studies` and `themes` of a notes write, validated (400 invalid_study / invalid_themes with
        the field). -> (studies | None, themes | None); None when the request leaves that part alone."""
        studies, themes = body.get("studies"), body.get("themes")
        try:
            studies = None if studies is None else A.clean_studies(studies, A.now_ms())
        except A.InvalidDoc as e: raise ApiError(400, "invalid_study", str(e), field=e.field)
        try:
            themes = None if themes is None else A.clean_themes(themes)
        except A.InvalidDoc as e: raise ApiError(400, "invalid_themes", str(e), field=e.field)
        return studies, themes

    def h_notes_changes(self, body, q, arg):
        """Per-key notes changes (set / del / base, PS §2.4) and, beside them, the whole-replace of `studies` and
        `themes` (study brief §1.4): each replaces the stored one under the request's baseRev, which must then be the
        document's current rev; a stale one is 409 rev_conflict carrying the current rev, studies and themes, and
        nothing of the request is applied. Studies made or changed add `study.save` activity."""
        wait = NOTES_WINDOW.check(self._scope)
        if wait: raise rate_limited(wait, self._uid or "guest")
        base = body.get("baseRev")
        if base is not None and not (A._is_int(base) and base >= 0):
            raise ApiError(400, "bad_request", "baseRev must be a whole number.", field="baseRev")
        studies, themes = self._studies_and_themes(body)
        whole = studies is not None or themes is not None
        if whole and base is None:
            raise ApiError(400, "bad_request", "Saving studies or theme choices needs baseRev.", field="baseRev")
        sets = {} if body.get("set") is None else body["set"]
        dels = {} if body.get("del") is None else body["del"]
        cas = {} if body.get("base") is None else body["base"]
        if not isinstance(sets, dict) or not isinstance(dels, dict) or not isinstance(cas, dict):
            raise ApiError(400, "bad_request", "set, del and base must be objects keyed by reference.")
        if len(sets) + len(dels) > 5000: raise ApiError(400, "bad_request", "At most 5,000 changes per request.")
        now = A.now_ms()
        clean_set, clean_del, clean_base = {}, {}, {}
        for k, note in sets.items():
            c = A.clean_note(note, now) if A.valid_ref(k) and k not in dels else None
            if c is None: raise ApiError(400, "invalid_note", field=k)
            clean_set[k] = c
        for k, ts in dels.items():
            ts = A.clamp_ts(ts, now) if A.valid_ref(k) else None  # a tombstone from the future is clamped to now
            if ts is None: raise ApiError(400, "invalid_note", field=k)
            clean_del[k] = ts
        for k, b in cas.items():  # compare-and-set bases (§2.4); keys not in set/del are ignored
            if k not in clean_set and k not in clean_del: continue
            if b is not None and not (A._is_num(b) and b >= 0):
                raise ApiError(400, "bad_request", "base values must be a note's updated time or null.", field=k)
            clean_base[k] = None if b is None else int(b)
        with A.lock_for(self._scope):
            notes = A.load_notes(self._scope)
            before = notes["rev"]
            if whole and base != before:
                raise ApiError(409, "rev_conflict", extra={"rev": before, "studies": notes["studies"], "themes": notes["themes"]})
            if len(notes["refs"]) + sum(1 for k in clean_set if k not in notes["refs"]) > A.MAX_REFS:
                raise ApiError(400, "invalid_note", "You’ve reached the limit of 50,000 notes.")
            changed, conflicts = A.apply_note_changes(notes, clean_set, clean_del, clean_base)
            rows = []
            if studies is not None and studies != notes["studies"]:
                had = {st["id"]: st for st in notes["studies"]}
                rows = [(st, st["id"] not in had) for st in studies if had.get(st["id"]) != st]
                notes["studies"], changed = studies, True
            if themes is not None and themes != notes["themes"]:
                notes["themes"], changed = themes, True
            if changed:
                notes["rev"] = before + 1
                A.save_notes(self._scope, notes, quota=True)
            if rows:  # the notes file, then the library file (the lock order at A.lock_for)
                lib = A.load_library(self._scope)
                if A.add_study_activity(lib, rows, now):
                    lib["rev"] += 1; lib["updated"] = now
                    A.save_library(self._scope, lib)
            versions = A.note_versions(notes, list(clean_set) + list(clean_del), conflicts)
        self.send_json({"ok": True, "rev": notes["rev"], "changed": changed, "stale": base is not None and base < before,
                        "conflicts": conflicts, "versions": versions, "saved": time.strftime("%H:%M:%S")})

    # ------------------------------------------------------------ 24-27 links and marks (links-spec §2, annotations §2)
    # and memory verses (Memorize brief §2). One handler pair serves the three per-key collections. The accounts helpers are
    # looked up by name on every call (A.load_<many>, A.save_<many>, A.clean_<one>, A.apply_<one>_changes,
    # A.<one>_versions, A.add_<one>_activity, A.<ONE>_ID_RE, A.MAX_<MANY>), so they can never drift apart, and the
    # error codes are invalid_<one> and <one>_limit. `noun` is the word the messages use.
    KEYED = {"links": ("link", "link", LINKS_WINDOW), "marks": ("mark", "highlight", MARKS_WINDOW),
             "memory": ("memory_verse", "memory verse", MEMORY_WINDOW)}

    def _keyed_get(self, many):
        d = getattr(A, f"load_{many}")(self._scope)
        self.send_json({many: d[many], "rev": d["rev"], "scope": self._scope}, headers=[("ETag", f'"{d["rev"]}"')])

    def _keyed_changes(self, body, many):
        """The notes rules (PS §2.4 #10) for links, marks and memory verses: compare-and-set on `base`, stale,
        versions, conflicts. Validation is atomic; new links and marks add `<one>.add` activity and studied verses to
        the library (the collection's file, then the library file: the lock order at A.lock_for); memory verses add
        none."""
        one, noun, window = self.KEYED[many]
        wait = window.check(self._scope)
        if wait: raise rate_limited(wait, self._uid or "guest")
        id_re, invalid, clean = getattr(A, f"{one.upper()}_ID_RE"), f"invalid_{one}", getattr(A, f"clean_{one}")
        base = body.get("baseRev")
        if base is not None and not (A._is_int(base) and base >= 0):
            raise ApiError(400, "bad_request", "baseRev must be a whole number.", field="baseRev")
        sets = {} if body.get("set") is None else body["set"]
        dels = {} if body.get("del") is None else body["del"]
        cas = {} if body.get("base") is None else body["base"]
        if not isinstance(sets, dict) or not isinstance(dels, dict) or not isinstance(cas, dict):
            raise ApiError(400, "bad_request", f"set, del and base must be objects keyed by {noun} id.")
        if len(sets) + len(dels) > 1000: raise ApiError(400, "bad_request", "At most 1,000 changes per request.")
        today = time.strftime("%Y-%m-%d")
        day = body.get("day")
        if day is not None and not A.parse_day(day):
            raise ApiError(400, "bad_request", "day must be a date like 2026-09-28.", field="day")
        if day is None or abs((A.parse_day(day) - A.parse_day(today)).days) > 1:
            day = today  # the client's local date, unless it is more than a day from the server's
        now = A.now_ms()
        clean_set, clean_del, clean_base = {}, {}, {}
        for k, raw in sets.items():
            if not id_re.fullmatch(k): raise ApiError(400, invalid, f"That is not a {noun} id.", field=k)
            if k in dels: raise ApiError(400, invalid, f"A {noun} can’t be saved and deleted at once.", field=k)
            try: c = clean(raw, now)
            except ValueError as e: raise ApiError(400, invalid, str(e), field=k)
            if c["id"] != k: raise ApiError(400, invalid, f"The {noun}’s id must match its key.", field=k)
            clean_set[k] = c
        for k, ts in dels.items():
            if not id_re.fullmatch(k): raise ApiError(400, invalid, f"That is not a {noun} id.", field=k)
            ts = A.clamp_ts(ts, now)  # a tombstone from the future is clamped to now
            if ts is None: raise ApiError(400, invalid, "A delete needs the time it was made (ms).", field=k)
            clean_del[k] = ts
        for k, b in cas.items():  # compare-and-set bases; keys not in set/del are ignored
            if k not in clean_set and k not in clean_del: continue
            if b is not None and not (A._is_num(b) and b >= 0):
                raise ApiError(400, "bad_request", f"base values must be a {noun}’s updated time or null.", field=k)
            clean_base[k] = None if b is None else int(b)
        with A.lock_for(self._scope):  # one lock for the scope's files; the collection is written before the library
            doc = getattr(A, f"load_{many}")(self._scope)
            before, n0 = doc["rev"], len(doc[many])
            changed, conflicts, created = getattr(A, f"apply_{one}_changes")(doc, clean_set, clean_del, clean_base)
            if len(doc[many]) > getattr(A, f"MAX_{many.upper()}") and len(doc[many]) > n0:  # after deletes; not saved
                raise ApiError(409, f"{one}_limit")
            if changed:
                doc["rev"] = before + 1
                getattr(A, f"save_{many}")(self._scope, doc, quota=True)  # its activity below is small and capped
            versions = getattr(A, f"{one}_versions")(doc, list(clean_set) + list(clean_del), conflicts)
            if created and many != "memory":  # memory verses add no activity: no read of the library
                lib = A.load_library(self._scope)
                if getattr(A, f"add_{one}_activity")(lib, [doc[many][k] for k in created], day, now):
                    lib["rev"] += 1
                    if lib.get("created") is None: lib["created"] = now
                    A.save_library(self._scope, lib)
        self.send_json({"ok": True, "rev": doc["rev"], "changed": changed, "stale": base is not None and base < before,
                        "conflicts": conflicts, "versions": versions, "saved": time.strftime("%H:%M:%S")})

    def h_links_get(self, body, q, arg): self._keyed_get("links")
    def h_links_changes(self, body, q, arg): self._keyed_changes(body, "links")
    def h_marks_get(self, body, q, arg): self._keyed_get("marks")
    def h_marks_changes(self, body, q, arg): self._keyed_changes(body, "marks")
    def h_memory_get(self, body, q, arg): self._keyed_get("memory")
    def h_memory_changes(self, body, q, arg): self._keyed_changes(body, "memory")

    # ------------------------------------------------------------ 11-17 library
    def h_library_get(self, body, q, arg):
        today = q.get("today", [""])[0]
        if not A.parse_day(today): today = time.strftime("%Y-%m-%d")
        try: n_act = max(0, min(1000, int(q.get("activity", ["50"])[0])))
        except ValueError: n_act = 50
        try: before = int(q.get("before", [""])[0])
        except ValueError: before = None
        lib = A.load_library(self._scope)
        notes = A.load_notes(self._scope)
        n_notes, n_studies = len(notes["refs"]), len(notes["studies"])
        n_links = len(A.load_links(self._scope)["links"])
        n_marks = len(A.load_marks(self._scope)["marks"])
        acts = lib["activity"]
        if before is not None: acts = [a for a in acts if a.get("t", 0) < before]
        page = list(reversed(acts[-n_act:])) if n_act else []
        self.send_json({"scope": self._scope, "rev": lib["rev"], "bookmarks": lib["bookmarks"], "lastPosition": lib["lastPosition"],
                        "chapters": lib["chapters"], "stats": A.compute_stats(lib, n_notes, today, n_links, n_marks, n_studies), "activity": page,
                        "activityTotal": len(lib["activity"]), "server": {"now": A.now_ms()}},
                       headers=[("ETag", f'"{lib["rev"]}"')])

    def h_events(self, body, q, arg):
        wait = EVENTS_WINDOW.check(self._scope)
        if wait: raise rate_limited(wait, self._uid or "guest")
        bid, events = body.get("batchId"), body.get("events")
        if not isinstance(bid, str) or not A.BATCH_RE.fullmatch(bid) or not isinstance(events, list) or not 1 <= len(events) <= 200:
            raise ApiError(400, "invalid_batch")
        with A.lock_for(self._scope):
            lib = A.load_library(self._scope)
            if bid in lib["appliedBatches"]:
                return self.send_json({"ok": True, "rev": lib["rev"], "applied": 0, "rejected": 0, "duplicate": True})
            applied, rejected = A.apply_events(lib, events, A.now_ms())
            lib["appliedBatches"] = (lib["appliedBatches"] + [bid])[-A.MAX_BATCH_IDS:]
            if applied: lib["rev"] += 1
            if lib.get("created") is None: lib["created"] = A.now_ms()
            A.save_library(self._scope, lib, quota=True)
        self.send_json({"ok": True, "rev": lib["rev"], "applied": applied, "rejected": rejected, "duplicate": False})

    @staticmethod
    def _bookmark_fields(body):
        out = {}
        if "label" in body:
            ok, label, code = A.validate_label(body.get("label"))
            if not ok: raise ApiError(400, code, field="label")
            out["label"] = label
        if "color" in body:
            color = body.get("color")
            if color not in A.BOOKMARK_COLORS: raise ApiError(400, "invalid_color", field="color")
            out["color"] = color
        return out

    def h_bookmark_add(self, body, q, arg):
        p = A.parse_ref(body.get("ref"))
        if not p: raise ApiError(400, "invalid_ref", field="ref")
        fields = self._bookmark_fields(body)
        now = A.now_ms()
        created = body.get("created")
        created = int(created) if A._is_num(created) and 0 <= created <= now else now
        with A.lock_for(self._scope):
            lib = A.load_library(self._scope)
            for bm in lib["bookmarks"]:
                if bm.get("ref") == body["ref"]:
                    return self.send_json({"ok": True, "rev": lib["rev"], "bookmark": bm, "existed": True})
            if len(lib["bookmarks"]) >= A.MAX_BOOKMARKS: raise ApiError(409, "bookmark_limit")
            ids = {b.get("id") for b in lib["bookmarks"]}
            bid = "bm_" + secrets.token_hex(6)
            while bid in ids: bid = "bm_" + secrets.token_hex(6)
            b, c, v = p
            bm = {"id": bid, "ref": body["ref"], "b": b, "c": c, "v": v, "label": fields.get("label", ""),
                  "color": fields.get("color", "red"), "created": created, "updated": now}
            lib["bookmarks"].append(bm)
            lib["bookmarks"].sort(key=lambda x: A._nonneg_int(x.get("created")), reverse=True)
            x = {"id": bid}
            if bm["label"]: x["label"] = bm["label"]
            A.add_activity(lib, {"t": now, "type": "bookmark.add", "ref": bm["ref"], "x": x})
            lib["rev"] += 1; lib["updated"] = now
            if lib.get("created") is None: lib["created"] = now
            A.save_library(self._scope, lib)
        self.send_json({"ok": True, "rev": lib["rev"], "bookmark": bm}, 201)

    def _find_bookmark(self, lib, bid):
        if not isinstance(bid, str) or not A.BOOKMARK_ID_RE.fullmatch(bid): raise ApiError(404, "not_found")
        for i, bm in enumerate(lib["bookmarks"]):
            if bm.get("id") == bid: return i, bm
        raise ApiError(404, "not_found")

    def h_bookmark_patch(self, body, q, bid):
        if not isinstance(bid, str) or not A.BOOKMARK_ID_RE.fullmatch(bid): raise ApiError(404, "not_found")
        fields = self._bookmark_fields(body)
        with A.lock_for(self._scope):
            lib = A.load_library(self._scope)
            i, bm = self._find_bookmark(lib, bid)
            bm.update(fields); bm["updated"] = A.now_ms()
            lib["rev"] += 1; lib["updated"] = bm["updated"]
            A.save_library(self._scope, lib)
        self.send_json({"ok": True, "rev": lib["rev"], "bookmark": bm})

    def h_bookmark_delete(self, body, q, bid):
        with A.lock_for(self._scope):
            lib = A.load_library(self._scope)
            i, bm = self._find_bookmark(lib, bid)
            del lib["bookmarks"][i]
            now = A.now_ms()
            A.add_activity(lib, {"t": now, "type": "bookmark.remove", "ref": bm.get("ref"), "x": {"id": bid}})
            lib["rev"] += 1; lib["updated"] = now
            A.save_library(self._scope, lib)
        self.send_json({"ok": True, "rev": lib["rev"], "removed": bm})

    def h_chapters(self, body, q, arg):
        b, read = body.get("b"), body.get("read")
        if not isinstance(read, bool): raise ApiError(400, "bad_request", "Say read: true or read: false.", field="read")
        if not (A._is_int(b) and 1 <= b <= 66): raise ApiError(400, "invalid_ref", field="b")
        if "cs" in body:
            cs = body.get("cs")
            if not isinstance(cs, list) or not 1 <= len(cs) <= 150 or not all(A.valid_bc(b, c) for c in cs):
                raise ApiError(400, "invalid_ref", field="cs")
            cs, ref = sorted(set(cs)), str(b)
        else:
            c = body.get("c")
            if not A.valid_bc(b, c): raise ApiError(400, "invalid_ref", field="c")
            cs, ref = [c], f"{b}.{c}"
        now = A.now_ms()
        with A.lock_for(self._scope):
            lib = A.load_library(self._scope)
            out = {}
            for c in cs:
                k = f"{b}.{c}"
                ch = lib["chapters"].setdefault(k, A.new_chapter())
                if read:
                    ch["read"] = True
                    if not A._is_int(ch.get("readAt")): ch["readAt"] = now
                else:
                    ch["read"], ch["readAt"] = False, None
                ch["manual"], ch["manualAt"] = True, now
                out[k] = ch
            A.add_activity(lib, {"t": now, "type": "chapter.mark", "ref": ref, "x": {"read": read, "count": len(cs)}})
            lib["rev"] += 1; lib["updated"] = now
            if lib.get("created") is None: lib["created"] = now
            A.save_library(self._scope, lib)
        self.send_json({"ok": True, "rev": lib["rev"], "chapters": out})

    def h_reset(self, body, q, arg):
        what = body.get("what")
        if not isinstance(what, list) or not what or not all(w in ("activity", "progress", "bookmarks") for w in what):
            raise ApiError(400, "invalid_reset", field="what")
        with A.lock_for(self._scope):
            lib = A.load_library(self._scope)
            if "activity" in what: lib["activity"] = []
            if "progress" in what: lib.update(chapters={}, days={}, lastPosition=None)
            if "bookmarks" in what: lib["bookmarks"] = []
            lib["rev"] += 1; lib["updated"] = A.now_ms()
            A.save_library(self._scope, lib)
        self.send_json({"ok": True, "rev": lib["rev"]})

    # ------------------------------------------------------------ 18-20 profile data
    def h_import_guest(self, body, q, arg):
        uid, now = self._uid, A.now_ms()
        if HOSTED:  # the guest store is every visitor's and guests are read-only: there is never anything to import
            with A.lock_for(uid):
                rev = {"notes": A.load_notes(uid)["rev"], "library": A.load_library(uid)["rev"],
                       "links": A.load_links(uid)["rev"], "marks": A.load_marks(uid)["rev"], "memory": A.load_memory(uid)["rev"]}
            return self.send_json({"ok": True, "imported": {"notes": 0, "bookmarks": 0, "chapters": 0, "links": 0, "marks": 0,
                                                            "memory": 0, "studies": 0, "themes": 0}, "changed": False, "rev": rev})
        with A.lock_for("guest"):
            g_notes, g_lib, g_links = A.load_notes("guest"), A.load_library("guest"), A.load_links("guest")
            g_marks, g_memory = A.load_marks("guest"), A.load_memory("guest")
            with A.lock_for(uid):
                notes, lib, links, marks = A.load_notes(uid), A.load_library(uid), A.load_links(uid), A.load_marks(uid)
                memory = A.load_memory(uid)
                n_notes = A.merge_notes(notes, g_notes)
                n_studies, n_themes = A.merge_studies(notes, g_notes, room=A.MAX_STUDIES - len(notes["studies"])), A.merge_themes(notes, g_notes)
                if n_notes or n_studies or n_themes:  # notes, links, marks, memory, then library (the lock order at A.lock_for)
                    notes["rev"] += 1
                    A.save_notes(uid, notes)
                n_links = A.merge_links(links, g_links)
                if n_links:
                    links["rev"] += 1
                    A.save_links(uid, links)
                n_marks = A.merge_marks(marks, g_marks)
                if n_marks:
                    marks["rev"] += 1
                    A.save_marks(uid, marks)
                n_memory = A.merge_memory(memory, g_memory)
                if n_memory:
                    memory["rev"] += 1
                    A.save_memory(uid, memory)
                counts = A.merge_library(lib, g_lib, "merge", now)
                imported = {"notes": n_notes, "bookmarks": counts["bookmarks"], "chapters": counts["chapters"], "links": n_links,
                            "marks": n_marks, "memory": n_memory, "studies": n_studies, "themes": n_themes}
                # also guest study days, activity or last position alone
                changed = bool(counts["changed"] or n_notes or n_links or n_marks or n_memory or n_studies or n_themes)
                if changed:  # only when something was imported: a repeat changes nothing (§1.8)
                    lib["imports"] = (lib["imports"] + [{"source": "guest", "t": now, "mode": "merge"}])[-A.MAX_IMPORTS:]
                    A.add_activity(lib, {"t": now, "type": "profile.import", "ref": None, "x": dict(imported)})
                    lib["rev"] += 1; lib["updated"] = now
                    A.save_library(uid, lib)
        self.send_json({"ok": True, "imported": imported, "changed": changed,
                        "rev": {"notes": notes["rev"], "library": lib["rev"], "links": links["rev"], "marks": marks["rev"],
                                "memory": memory["rev"]}})

    def h_profile_import(self, body, q, arg):
        """A GET /api/export/profile file merged into the signed-in profile (hosting brief §1): notes, links, marks and
        memory verses by the per-key rule (the newer record wins, a tombstone at or after it keeps it deleted), studies
        by id (the newer wins), theme choices by name (the profile's own kept, A.merge_themes), the library as the guest
        import merges it. Idempotent: a second import of the same file changes nothing."""
        wait = IMPORT_WINDOW.check(self._scope)
        if wait: raise rate_limited(wait, self._uid)
        uid, now = self._uid, A.now_ms()
        try: src, skipped = A.clean_import(body, now)
        except ValueError: raise ApiError(400, "invalid_import")
        with A.lock_for(uid):
            notes, lib, links, marks = A.load_notes(uid), A.load_library(uid), A.load_links(uid), A.load_marks(uid)
            memory = A.load_memory(uid)
            n_notes = A.merge_notes(notes, {"refs": src["notes"]}, room=A.MAX_REFS - len(notes["refs"]))
            n_studies = A.merge_studies(notes, {"studies": src["studies"]}, room=A.MAX_STUDIES - len(notes["studies"]))
            n_themes = A.merge_themes(notes, {"themes": src["themes"]})
            n_links = A.merge_links(links, {"links": src["links"]})
            n_marks = A.merge_marks(marks, {"marks": src["marks"]})
            n_memory = A.merge_memory(memory, {"memory": src["memory"]})
            counts = A.merge_library(lib, src["library"], "merge", now)
            imported = {"notes": n_notes, "bookmarks": counts["bookmarks"], "chapters": counts["chapters"], "links": n_links,
                        "marks": n_marks, "memory": n_memory, "studies": n_studies, "themes": n_themes}
            changed = bool(counts["changed"] or n_notes or n_links or n_marks or n_memory or n_studies or n_themes)
            if changed:
                lib["imports"] = (lib["imports"] + [{"source": "file", "t": now, "mode": "merge"}])[-A.MAX_IMPORTS:]
                A.add_activity(lib, {"t": now, "type": "profile.import", "ref": None, "x": dict(imported)})
                lib["rev"] += 1; lib["updated"] = now
                if lib.get("created") is None: lib["created"] = now
            n_notes_doc = n_notes or n_studies or n_themes  # the notes file holds all three
            for n, doc in ((n_notes_doc, notes), (n_links, links), (n_marks, marks), (n_memory, memory)):
                if n: doc["rev"] += 1
            # the whole import against the quota first: all of it is written, or none
            A.check_quota(uid, [(path(uid), doc) for n, path, doc in ((n_notes_doc, A.notes_path, notes), (n_links, A.links_path, links),
                                                                       (n_marks, A.marks_path, marks), (n_memory, A.memory_path, memory),
                                                                       (changed, A.library_path, lib)) if n])
            if n_notes_doc: A.save_notes(uid, notes)
            if n_links: A.save_links(uid, links)  # links, marks, memory, then library (the lock order at A.lock_for)
            if n_marks: A.save_marks(uid, marks)
            if n_memory: A.save_memory(uid, memory)
            if changed: A.save_library(uid, lib)
        A.log("profile-import", uid, changed=int(changed))
        self.send_json({"ok": True, "imported": imported, "changed": changed, "skipped": skipped,
                        "rev": {"notes": notes["rev"], "library": lib["rev"], "links": links["rev"], "marks": marks["rev"],
                                "memory": memory["rev"]}})

    def h_export_profile(self, body, q, arg):
        user = self.load_user(self._uid) if self._uid else None
        with A.lock_for(self._scope):
            data = A.export_profile(self._scope, user)
        slug = (A.slugify(user.get("name", "")) or "profile") if user else "guest"
        body = json.dumps(data, ensure_ascii=False, indent=1, allow_nan=False).encode("utf-8")
        # ?day=YYYY-MM-DD is the client's local date (the server's clock may be in another time zone, QC 15).
        day = (q.get("day") or [""])[0]
        if not A.DAY_RE.fullmatch(day): day = time.strftime("%Y-%m-%d")
        self.send_download(body, "application/json; charset=utf-8", f"bible-study-{slug}-{day}.json")

    def h_export_obsidian(self, body, q, arg):
        with A.lock_for(self._scope):
            data = A.obsidian_zip(A.load_notes(self._scope), A.load_library(self._scope), A.load_links(self._scope),
                                  A.load_marks(self._scope))
        self.send_download(data, "application/zip", "bible-study-notes.zip")

    # ------------------------------------------------------------ 21-23 config and passages
    # Hosted, the ESV and NLT keys are the owner's personal-use licences: only an owner's session is told they are
    # there, can use them or can change them (hosting brief §1). Locally, as always, everyone.
    def h_config_get(self, body, q, arg):
        cfg = read_json(A.CONFIG, {})
        cfg = cfg if isinstance(cfg, dict) else {}
        mine = not HOSTED or self.is_owner()
        self.send_json({"esv": mine and bool(cfg.get("esvKey")), "nlt": mine and bool(cfg.get("nltKey")),
                        "licensed": APIBIBLE.licensed()})  # NIV, NKJV and NASB: for every session

    def h_config_put(self, body, q, arg):
        if HOSTED: self.owner_or_403()
        cfg = read_json(A.CONFIG, {})
        cfg = cfg if isinstance(cfg, dict) else {}
        for k in ("esvKey", "nltKey"):
            if k in body:
                if body[k] is not None and not isinstance(body[k], str): raise ApiError(400, "bad_request", field=k)
                cfg[k] = (body[k] or "").strip()
        A.write_json_atomic(A.CONFIG, cfg)
        self.send_json({"esv": bool(cfg.get("esvKey")), "nlt": bool(cfg.get("nltKey")), "licensed": APIBIBLE.licensed()})

    def h_passage(self, body, q, arg):
        # The one GET that reaches past this computer (it spends the user's ESV/NLT quota), so it is same-origin
        # only, like every write: another site's <img src="…/api/passage?…"> must not call the API with the key.
        self.check_same_origin()
        tr = q.get("tr", [""])[0].lower()
        # NIV, NKJV and NASB (API.Bible) are licensed for the public site: every reader, guests included
        if tr not in APIBIBLE_TRS and HOSTED and not self.is_owner(): raise ApiError(403, "owner_only", MSG_OWNER_TEXT)
        try: book_n, ch = int(q.get("book", ["0"])[0]), int(q.get("chapter", ["0"])[0])
        except ValueError: return self.send_json({"error": "bad ref"}, 400)
        if tr not in FETCHERS and tr not in APIBIBLE_TRS: return self.send_json({"error": "unknown translation"}, 400)
        # a chapter that does not exist is refused here: a failed fetch is not cached, so each one was an API call
        if not (1 <= book_n <= 66 and 1 <= ch <= A.chapters_in(book_n)): return self.send_json({"error": "bad ref"}, 400)
        if tr in APIBIBLE_TRS: obj, status = apibible_passage(tr, book_n, ch, self._client_key())
        else: obj, status = get_passage(tr, book_n, ch)
        self.send_json(obj, status)

    # ------------------------------------------------------------ hosted: site activity and health
    def h_admin_traffic(self, body, q, arg):
        """The owners' Site activity panel (open sign-up brief §1.4). api() answers 404 to everyone else."""
        if METRICS is None: raise ApiError(404, "not_found")
        with A.auth_lock(): n_users = len(A.load_users()["users"])
        rep, du = METRICS.report(30), disk_state()
        storage = {"free_mb": du.free // MIB, "used_mb": du.used // MIB, "total_mb": du.total // MIB,
                   "low": storage_low(du)} if du else {"free_mb": None, "used_mb": None, "total_mb": None, "low": False}
        pause = signup_pause(n_users)  # as auth/me says it, with the free-space check just made
        self.send_json({"days": rep["days"],
                        "totals": {"profiles": n_users, "guests_today": rep["days"][-1]["guests"], "last_7": rep["last_7"],
                                   "last_30": rep["last_30"]},
                        "turnstile": TURNSTILE, "signup": "closed" if pause else "open", "signupPause": pause,
                        "storage": storage, "apibible": USAGE.report()})

    def h_health(self, body, q, arg):
        problem = health_problem()
        if problem:
            A.log_error(f"health: {problem}")
            self.send_json({"ok": False}, 503)
        else:
            if HOSTED: storage_low()  # still 200 while the volume runs low, with an [alert] line once an hour
            self.send_json({"ok": True})


HEALTH_TTL = 5         # seconds a healthy probe is reused for: a burst of probes costs the volume one fsync, not one each
_HEALTH = [None, None]  # [when (monotonic), problem] of the last probe


def health_problem():
    """data_problem() for /api/health, which anyone may call as often as they like. Hosted, a healthy verdict is reused
    for HEALTH_TTL seconds (still fresh for the host's deploy check and a minute-cadence monitor) and a problem is
    probed again every time: its open or write fails before any fsync, and recovery shows at once. Locally there is no
    volume to doubt, and nothing is written into the notes folder."""
    if not HOSTED: return None
    now = time.monotonic()
    if _HEALTH[0] is not None and _HEALTH[1] is None and now - _HEALTH[0] <= HEALTH_TTL: return None
    _HEALTH[:] = [now, data_problem()]
    return _HEALTH[1]


def data_problem():
    """None when the data directory takes a write (written, synced and removed again) and users.json can be trusted;
    else what is wrong, for the log. The host's deploy check and any uptime monitor then see 503 {"ok": false}
    instead of a green light over a read-only, full or detached volume (QC 3)."""
    path = os.path.join(A.DATA, f".health-{os.getpid()}-{secrets.token_hex(4)}.tmp")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, b"ok\n"); os.fsync(fd)
        finally:
            os.close(fd)
        os.unlink(path)
    except OSError as e:
        return f"cannot write to {A.DATA}: {e.__class__.__name__}: {e.strerror or e}"
    problem = A.registry_problem()
    return f"users.json {problem}" if problem else None


def _reject_constant(name):
    raise ValueError(f"{name} is not valid JSON")


def _finite_float(s):
    x = float(s)
    if not math.isfinite(x): raise ValueError("number out of range")
    return x


DIGITS = re.compile(r"[0-9]+")  # str.isdigit() also accepts '²' and other scripts' digits, which int() then rejects


H = Handler
ROUTES = {
    "/api/auth/me": {"GET": Route(H.h_me)},
    "/api/auth/signup": {"POST": Route(H.h_signup, 16 * KIB)},
    "/api/auth/login": {"POST": Route(H.h_login, 16 * KIB)},
    "/api/auth/logout": {"POST": Route(H.h_logout, 1 * KIB)},
    "/api/account": {"PATCH": Route(H.h_account_patch, 16 * KIB, auth=True)},
    "/api/account/password": {"POST": Route(H.h_password, 16 * KIB, auth=True)},
    "/api/account/delete": {"POST": Route(H.h_delete, 16 * KIB, auth=True)},
    "/api/notes": {"GET": Route(H.h_notes_get), "PUT": Route(H.h_notes_put, 8 * MIB, write=True)},
    "/api/notes/changes": {"POST": Route(H.h_notes_changes, 2 * MIB, scope=True, write=True)},
    "/api/links": {"GET": Route(H.h_links_get)},
    "/api/links/changes": {"POST": Route(H.h_links_changes, 1 * MIB, scope=True, write=True)},
    "/api/marks": {"GET": Route(H.h_marks_get)},
    "/api/marks/changes": {"POST": Route(H.h_marks_changes, 1 * MIB, scope=True, write=True)},
    "/api/memory": {"GET": Route(H.h_memory_get)},
    "/api/memory/changes": {"POST": Route(H.h_memory_changes, 1 * MIB, scope=True, write=True)},
    "/api/library": {"GET": Route(H.h_library_get)},
    "/api/library/events": {"POST": Route(H.h_events, 128 * KIB, scope=True, write=True)},
    "/api/library/bookmarks": {"POST": Route(H.h_bookmark_add, 8 * KIB, scope=True, write=True)},
    "/api/library/chapters": {"POST": Route(H.h_chapters, 16 * KIB, scope=True, write=True)},
    "/api/library/reset": {"POST": Route(H.h_reset, 1 * KIB, scope=True, write=True)},
    "/api/profile/import-guest": {"POST": Route(H.h_import_guest, 1 * KIB, auth=True, scope=True, write=True)},
    "/api/profile/import": {"POST": Route(H.h_profile_import, MAX_BODY, auth=True, scope=True)},
    "/api/export/profile": {"GET": Route(H.h_export_profile)},
    "/api/export/obsidian": {"GET": Route(H.h_export_obsidian)},
    "/api/config": {"GET": Route(H.h_config_get), "PUT": Route(H.h_config_put, 8 * KIB)},
    "/api/passage": {"GET": Route(H.h_passage)},
    "/api/admin/traffic": {"GET": Route(H.h_admin_traffic)},
    HEALTH: {"GET": Route(H.h_health)},
}
HOSTED_ONLY = {"/api/admin/traffic"}  # 404 locally, where there are no owners
OWNERS_ONLY = {"/api/admin/traffic"}  # 404 for anyone but an owner, whatever the method
BOOKMARK_ROUTES = {"PATCH": Route(H.h_bookmark_patch, 8 * KIB, scope=True, write=True),
                   "DELETE": Route(H.h_bookmark_delete, 1 * KIB, scope=True, write=True)}


# ----------------------------------------------------------------- CLI (§3.9)
def _day(ms): return time.strftime("%Y-%m-%d", time.localtime(ms / 1000)) if isinstance(ms, (int, float)) and ms else "never"


def cli_list_users():
    users = sorted(A.load_users()["users"].values(), key=lambda u: u.get("created") or 0)
    if not users:
        print("No profiles."); return 0
    for u in users:
        try:
            n_notes = len(A.load_notes(u["uid"])["refs"]); n_bm = len(A.load_library(u["uid"])["bookmarks"])
        except ValueError:
            n_notes = n_bm = 0
        print(f"{u['uid']}  {u.get('email', '')}  {u.get('name', '')}  created {_day(u.get('created'))}  "
              f"last sign-in {_day(u.get('lastLogin'))}  notes {n_notes}  bookmarks {n_bm}")
    return 0


def cli_reset_password(email_arg, from_stdin):
    email = A.normalize_email(email_arg)
    with A.auth_lock(): user = A.find_user_by_email(A.load_users(), email)
    if not user:
        print("No profile for that email.", file=sys.stderr); return 1
    if from_stdin:
        line = sys.stdin.readline()
        pw = line[:-1] if line.endswith("\n") else line
        if pw.endswith("\r"): pw = pw[:-1]
    else:
        pw = getpass.getpass("New password: ")
        if getpass.getpass("Repeat: ") != pw:
            print("The passwords don’t match.", file=sys.stderr); return 2
    ok, code, msg = A.validate_password(pw, user.get("email", ""))
    if not ok:
        print(msg, file=sys.stderr); return 2
    h = A.hash_password(pw)
    with A.auth_lock():
        users = A.load_users(); u = users["users"].get(user["uid"])
        if not u:
            print("No profile for that email.", file=sys.stderr); return 1
        now = A.now_ms()
        u.update(pw=h, pwChanged=now, updated=now, failedLogins=0, lockUntil=0)
        A.save_users(users)
        A.revoke_sessions(u["uid"])
    A.log("cli-reset-password", u["uid"])
    print(f"Password reset for {u['email']}. All sessions were signed out.")
    return 0


def backfill_owner_claims():
    """Hosted start-up: every profile with an owner email counts as that email's claim (QC 0). -> claims added."""
    with A.auth_lock():
        users, claims, added = A.load_users(), A.load_owner_claims(), 0
        for u in users["users"].values():
            if u.get("email") in OWNER_EMAILS and A.claim_key(u["email"]) not in claims:
                claims[A.claim_key(u["email"])] = {"uid": u["uid"], "claimed": u.get("created") or A.now_ms()}
                added += 1
        if added: A.save_owner_claims(claims)
    return added


def start_metrics(path):
    """Hosted: load the daily counts, flush them once a minute, and on SIGTERM (a deploy or restart) stop serving so
    main() writes them a last time."""
    global METRICS
    METRICS = Metrics(path).load()
    threading.Thread(target=METRICS.flush_loop, args=(threading.Event(),), name="metrics", daemon=True).start()

    def on_term(signum, frame): raise SystemExit(0)
    signal.signal(signal.SIGTERM, on_term)


_SERVER_LOCK_FD = None


def take_server_lock():
    import fcntl
    global _SERVER_LOCK_FD
    fd = os.open(A.SERVER_LOCKFILE, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd); return False
    _SERVER_LOCK_FD = fd
    return True


def _is_loopback(host):
    if host in ("localhost",): return True
    try: return ipaddress.ip_address(host).is_loopback
    except ValueError: return False


class Server(ThreadingHTTPServer):
    # index.html pulls in its modules, stylesheets and data files all at once. The default listen backlog (5) made
    # the kernel reset the overflow (ERR_CONNECTION_RESET), leaving the app blank. This must be a class attribute:
    # listen() runs inside the constructor. The OS may cap it (macOS kern.ipc.somaxconn is 128).
    request_queue_size = 128
    daemon_threads = True


def main():
    env = os.environ  # PORT, HOST and BS_DATA_DIR are only defaults: a flag always wins (hosting brief §1)
    port = env.get("PORT", "").strip()
    if port and not DIGITS.fullmatch(port): sys.exit("PORT must be a whole number.")
    ap = argparse.ArgumentParser(description="Bible study app server")
    ap.add_argument("--port", type=int, default=int(port) if port else 8765)
    ap.add_argument("--host", default=env.get("HOST", "").strip() or "127.0.0.1")
    ap.add_argument("--data-dir", default=None, help="where notes, profiles and settings live (default: $BS_DATA_DIR, else notes/)")
    ap.add_argument("--allow-host", action="append", default=[], metavar="NAME", help="also accept this Host name")
    ap.add_argument("--max-users", type=int, default=None, help="the profile cap (default 50; hosted $BS_MAX_USERS, else 5000)")
    ap.add_argument("--dev", action="store_true", help="also serve app/mock/ (design mocks and builder harnesses)")
    ap.add_argument("--list-users", action="store_true", help="list profiles and exit")
    ap.add_argument("--reset-password", metavar="EMAIL", help="set a new password for a profile and exit")
    ap.add_argument("--password-stdin", action="store_true", help="with --reset-password: read the password from stdin")
    a = ap.parse_args()
    configure_hosting(env)

    # Hosted, the data directory must be named, and be on the host's volume when it says where that is: otherwise
    # every profile would silently live on the container disk and vanish at the next deploy (QC 3).
    data_arg = (a.data_dir or env.get("BS_DATA_DIR", "")).strip()
    if HOSTED and not data_arg:
        sys.exit("BS_HOSTED needs --data-dir or BS_DATA_DIR naming the volume where profiles live. Refusing to start on the container disk.")
    data = os.path.realpath(os.path.expanduser(data_arg or DEFAULT_DATA))
    mount = env.get("RAILWAY_VOLUME_MOUNT_PATH", "").strip()
    if HOSTED and mount:
        mount = os.path.realpath(mount)
        if os.path.commonpath([data, mount]) != mount:
            sys.exit(f"The data directory {data} is not on the volume mounted at {mount}. Refusing to start.")
        if not os.path.ismount(mount):
            # a bind mount on the same device fools ismount(), so this is a warning, not a refusal; the write
            # probe below and /api/health still have to succeed on that directory
            print(f"[warn] {mount} does not look like a mount point; the data directory {data} may be on the container disk", file=sys.stderr)
    app_real = os.path.realpath(APP)
    if data == app_real or data.startswith(app_real + os.sep):
        print("--data-dir must not be inside app/", file=sys.stderr); sys.exit(1)
    os.umask(0o077)
    max_users = a.max_users if a.max_users is not None else HOSTED_MAX_USERS if HOSTED else 50
    A.configure(data, a.port, a.allow_host, max_users)

    if a.list_users: sys.exit(cli_list_users())
    if a.reset_password is not None:
        if not os.path.isdir(data):
            print("No profile for that email.", file=sys.stderr); sys.exit(1)
        sys.exit(cli_reset_password(a.reset_password, a.password_stdin))

    os.makedirs(data, mode=0o700, exist_ok=True)
    os.makedirs(A.PROFILES, mode=0o700, exist_ok=True)
    if not take_server_lock():
        print(f"Another serve.py is already using {data}.", file=sys.stderr); sys.exit(1)
    with A.auth_lock():  # with .server.lock and the auth lock held, no other writer (server or CLI) is mid-write
        n_tmp = A.remove_stale_tmp_files()
    if n_tmp: print(f"Removed {n_tmp} temporary file(s) left by an interrupted write.", flush=True)
    n_esv = prune_esv_cache()  # a cache an older serve.py filled past the ESV terms
    if n_esv: print(f"Removed {n_esv} ESV chapter(s) from the cache (the ESV terms allow 500 verses).", flush=True)
    A.purge_expired_sessions()
    A.init_dummy_hash()
    if not _is_loopback(a.host) and not HOSTED:  # hosted, TLS ends at the host's proxy
        print("Warning: Profiles over plain HTTP on a network are visible to that network.", file=sys.stderr)
    if HOSTED and not OWNER_EMAILS:
        print("Warning: BS_HOSTED is on but BS_OWNER_EMAILS is empty: nobody can use ESV/NLT or see Site activity.", file=sys.stderr)
    if HOSTED and not TURNSTILE:
        missing = " and ".join(n for n, v in (("BS_TURNSTILE_SITEKEY", TURNSTILE_SITEKEY), ("BS_TURNSTILE_SECRET", TURNSTILE_SECRET)) if not v)
        print(f"Turnstile is off ({missing} not set): sign-up is open behind the rate limits only.", flush=True)
    if TURNSTILE and TURNSTILE_TEST_SECRET.fullmatch(TURNSTILE_SECRET):
        print("Warning: BS_TURNSTILE_SECRET is one of Cloudflare's test secrets: the bot check proves nothing.", file=sys.stderr)
    if HOSTED and not ALLOWED_ORIGINS:
        print("Warning: BS_ALLOWED_ORIGINS is empty: a browser on the site's own domain is refused (csrf) when the API "
              "answers under another host name.", file=sys.stderr)
    if HOSTED:
        problem = data_problem()  # before anything is written there: a full or read-only volume exits cleanly
        if problem: sys.exit(f"The data directory cannot be used: {problem}")
        n_claims = backfill_owner_claims()
        if n_claims: print(f"Recorded {n_claims} owner claim(s) for profiles made before owner-claims.json existed.", flush=True)
        start_metrics(os.path.join(data, "metrics.json"))
    if APIBIBLE_KEY:  # which Bibles the key serves, found in the background (from bibles.json while it is recent)
        pinned = [t.upper() for t in APIBIBLE_TRS if t in APIBIBLE_PINS]
        print(f"API.Bible: key set, {APIBIBLE_MONTHLY} calls a month" + (f", pinned {', '.join(pinned)}" if pinned else ""), flush=True)
        APIBIBLE.ids_now(wait=0)
    Handler.serve_mocks = a.dev
    srv = Server((a.host, a.port), Handler)
    n_users = len(A.load_users()["users"])
    mode = (f"   hosted: owners {len(OWNER_EMAILS)}, sign-up {'closed' if SIGNUP_CLOSED else 'open'}, "
            f"Turnstile {'on' if TURNSTILE else 'off'}{', trusting the proxy' if TRUST_PROXY else ''}") if HOSTED else ""
    print(f"Bible study app: http://{a.host}:{a.port}   data: {data}   profiles: {n_users}/{A.MAX_USERS}   "
          f"hashing: {A.PREFERRED}{mode}", flush=True)
    try: srv.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        if METRICS is not None: METRICS.flush()  # a deploy stops the old server with SIGTERM: today's counts are kept


if __name__ == "__main__":
    main()
