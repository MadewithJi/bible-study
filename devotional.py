#!/usr/bin/env python3
"""
Weekly devotional: the week's study gathered, drafted, rendered as an email, and sent. Standard library only.

The design is .design/devotional-mock/issue-v3.html (the Instagram carousel's look) reproduced as a table-based,
inline-styled email. Verse words come only from app/data/bibles/bsb/NN.json, word for word, labelled BSB.
Nothing here starts a thread, takes a scope lock or decides who may call it: serve.py wires these pure pieces
under its own locks and owner checks.

API for serve.py
----------------
Files (DATA/devotional/; the caller holds its devotional lock):
  devo_dir(data_dir), subscribers_path(data_dir), issues_dir(data_dir), issue_path(data_dir, issue_id)
  load_subscribers(data_dir) -> doc           save_subscribers(data_dir, doc)
  load_issue(data_dir, issue_id) -> dict|None save_issue(data_dir, issue)      list_issues(data_dir) -> newest first
Subscribers (tokens are stored hashed; the raw token exists only inside an email):
  new_token() -> raw hex          token_hash(raw) -> sha256 hex          new_sub_id()
  new_subscriber(email, now, source) -> (record, raw_token)
  find_subscriber(doc, email) -> (sid, rec)|None     find_by_token(doc, raw) -> (sid, rec)|None
  rotate_token(rec) -> raw        confirm(rec, now) -> raw (rotated)      unsubscribe(rec, now)
  unsub_secret(data_dir) -> bytes (DATA/devotional/.secret, made on first use)
  unsub_token(secret, sid) -> 32 hex: the stable unsubscribe capability of one subscriber (never stored, derived)
  find_by_unsub_token(doc, secret, raw) -> (sid, rec)|None
  resubscribe(rec, now) -> raw    confirmed(doc) -> [(sid, rec)]         prune_pending(doc, now) -> n dropped
  subscribers_csv(doc) -> str     count_by_status(doc) -> {status: n}
Issues (§2.2 shape):
  new_issue(week, now, compiled_by) -> issue   public_issue(issue) -> without hashes   issue_row(issue) -> admin row
Weeks and schedule (tz is a zoneinfo name or ZoneInfo; times are ms):
  get_tz(name) -> ZoneInfo|None               week_for(end_day) -> {"from", "to"}
  week_bounds_ms(week, tz) -> (start, end)    week_label(week) -> "8–14 November 2026"
  parse_schedule("sat 06:00"|"off"|"now") -> ("at", dow, h, m) | ("off",) | ("now",) | None
  next_moment(sched, now, tz) -> ms|None      last_moment(sched, now, tz) -> ms|None   schedule_text(sched, tz)
Compile:
  gather(profile, week, tz) -> material       (profile: a uid, or {"notes": path, "marks": …, "links": …,
                                               "library": …, "memory": …}; files are read, never written)
  source_of(material) -> the issue's `source`  deterministic_draft(material) -> draft
  stitch(material, key, url, model, opener=None) -> draft   (falls back to the deterministic draft, with a warning)
  STITCH_SYSTEM, DRAFT_SCHEMA, stitch_request(material, model), validate_draft(obj, material)
Render and send:
  keep_material(material) -> issue["material"]     (the links and memory verses the renderer uses)
  render(issue, site, postal="") -> (html, text)   UNSUB_PLACEHOLDER   personalise(s, raw_token)
  Resend(base_url, key, opener=None, sleep=time.sleep): .send(message, idempotency_key=None), .send_batch(messages,
     idempotency_key); ResendError(status, body)
  batch_messages(issue, recipients, cfg) -> [{"key", "sids", "messages"}]   (recipients: [(sid, email, unsub_token)];
     cfg: {"from", "reply_to", "site", "html", "text"}); batch_key(issue_id, emails) is the same for the same
     addresses whichever run builds the batch, so a resend after a crash is the same request to Resend
  confirmation_mail(email, raw, cfg), preview_mail(issue, review_raw, cfg, to), test_mail(issue, cfg, to),
  sent_mail(issue, n, cfg, to) -> a Resend message dict
"""
import datetime, hashlib, hmac, html, json, os, re, secrets, threading, time, urllib.error, urllib.parse, urllib.request

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

import accounts as A

HERE = os.path.dirname(os.path.abspath(__file__))
BSB_DIR = os.path.join(HERE, "app", "data", "bibles", "bsb")
ART_PATH = os.path.join(HERE, "app", "data", "art.json")
TRANSLATION = "BSB"
BSB_CREDIT = "Scripture quotations are from the Berean Standard Bible, public domain."
DORE_CREDIT = "Engravings by Gustave Doré (1866), public domain."
UNSUB_PLACEHOLDER = "__BS_UNSUBSCRIBE_TOKEN__"
UTM = "utm_source=devotional&utm_medium=email"
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
DAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
STATUSES = ("draft", "approved", "sending", "sent", "skipped", "empty")
ROMAN = ("I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII")
DAY_MS = 86400 * 1000
PENDING_MAX_MS = 7 * DAY_MS
BATCH_SIZE = 100
RESEND_TRIES = 3
RESEND_PAUSE = 5
STITCH_TIMEOUT = 120
STITCH_PAUSE = 2
SECTIONS_MAX = 8
LIMITS = {"subject": 120, "title": 120, "opening": 1500, "closing": 1500, "body": 4000, "question": 300,
          "heading": 120, "quote": 400}


def log_line(text):
    """One '[devotional] …' line on stdout. Never pass a key, a token, an address or a body."""
    try:
        print(f"[devotional] {time.strftime('%Y-%m-%dT%H:%M:%S')} {text}", flush=True)
    except Exception:  # noqa: logging must never break a request
        pass


def _now_ms():
    return int(time.time() * 1000)


# ------------------------------------------------------------------ files

def devo_dir(data_dir):
    return os.path.join(data_dir, "devotional")


def subscribers_path(data_dir):
    return os.path.join(devo_dir(data_dir), "subscribers.json")


def issues_dir(data_dir):
    return os.path.join(devo_dir(data_dir), "issues")


ISSUE_ID_RE = re.compile(r"\d{4}-\d{2}-\d{2}", re.ASCII)


def issue_path(data_dir, issue_id):
    if not isinstance(issue_id, str) or not ISSUE_ID_RE.fullmatch(issue_id) or A.parse_day(issue_id) is None:
        raise ValueError("invalid issue id")
    return os.path.join(issues_dir(data_dir), issue_id + ".json")


def _ensure_dir(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def empty_subscribers():
    return {"v": 1, "subs": {}}


def load_subscribers(data_dir):
    doc = A.read_json_strict(subscribers_path(data_dir), empty_subscribers())
    if not isinstance(doc.get("subs"), dict):
        doc["subs"] = {}
    doc["v"] = 1
    return doc


def save_subscribers(data_dir, doc):
    _ensure_dir(devo_dir(data_dir))
    A.write_json_atomic(subscribers_path(data_dir), doc)


def load_issue(data_dir, issue_id):
    p = issue_path(data_dir, issue_id)
    if not os.path.exists(p):
        return None
    doc = A.read_json_strict(p, {})
    return doc if doc.get("id") == issue_id else None


def save_issue(data_dir, issue):
    _ensure_dir(devo_dir(data_dir))
    _ensure_dir(issues_dir(data_dir))
    A.write_json_atomic(issue_path(data_dir, issue["id"]), issue)


def list_issues(data_dir, limit=None):
    """Every issue on disk, newest week first."""
    d = issues_dir(data_dir)
    try:
        names = os.listdir(d)
    except FileNotFoundError:
        return []
    ids = sorted((n[:-5] for n in names if n.endswith(".json") and ISSUE_ID_RE.fullmatch(n[:-5])), reverse=True)
    out = []
    for i in ids:
        iss = load_issue(data_dir, i)
        if iss is not None:
            out.append(iss)
        if limit and len(out) >= limit:
            break
    return out


# ------------------------------------------------------------------ subscribers

def new_token():
    return secrets.token_hex(16)


def token_hash(raw):
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def new_sub_id():
    return "sb_" + secrets.token_hex(6)


TOKEN_RE = re.compile(r"[0-9a-f]{32}", re.ASCII)


def new_subscriber(email, now, source="page"):
    """-> (record, raw_token). The record stores only the token's hash."""
    raw = new_token()
    rec = {"email": A.normalize_email(email), "status": "pending", "created": now, "confirmed": None,
           "unsubscribed": None, "token": token_hash(raw), "source": source, "lastMail": now, "issues": []}
    return rec, raw


def find_subscriber(doc, email):
    e = A.normalize_email(email)
    for sid, rec in doc.get("subs", {}).items():
        if isinstance(rec, dict) and rec.get("email") == e:
            return sid, rec
    return None


def find_by_token(doc, raw):
    if not isinstance(raw, str) or not TOKEN_RE.fullmatch(raw):
        return None
    h = token_hash(raw)
    for sid, rec in doc.get("subs", {}).items():
        if isinstance(rec, dict) and rec.get("token") == h:
            return sid, rec
    return None


def rotate_token(rec):
    raw = new_token()
    rec["token"] = token_hash(raw)
    return raw


def confirm(rec, now):
    rec["status"] = "confirmed"
    rec["confirmed"] = now
    rec["unsubscribed"] = None
    return rotate_token(rec)


def unsubscribe(rec, now):
    rec["status"] = "unsubscribed"
    rec["unsubscribed"] = now
    rec["token"] = token_hash(new_token())  # the used link dies; nobody holds the new preimage


def resubscribe(rec, now):
    rec["status"] = "pending"
    rec["created"] = now
    rec["confirmed"] = None
    rec["lastMail"] = now
    return rotate_token(rec)


def secret_path(data_dir):
    return os.path.join(devo_dir(data_dir), ".secret")


def unsub_secret(data_dir):
    """The per-install secret the unsubscribe capabilities are derived from: DATA/devotional/.secret (0600), made
    on first use. The caller holds the devotional lock."""
    path = secret_path(data_dir)
    try:
        with open(path, "rb") as f:
            raw = f.read(256).strip()
        if len(raw) >= 32:
            return raw
    except FileNotFoundError:
        pass
    _ensure_dir(devo_dir(data_dir))
    raw = secrets.token_hex(32).encode("ascii")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, raw + b"\n")
    finally:
        os.close(fd)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return raw


def unsub_token(secret, sid):
    """The unsubscribe capability of one subscriber: stable for as long as the address is on the list, so the link
    and the List-Unsubscribe header of every issue ever sent keep working. Derived, never stored."""
    return hmac.new(secret, sid.encode("utf-8"), hashlib.sha256).hexdigest()[:32]


def find_by_unsub_token(doc, secret, raw):
    if not isinstance(raw, str) or not TOKEN_RE.fullmatch(raw):
        return None
    for sid, rec in doc.get("subs", {}).items():
        if isinstance(rec, dict) and hmac.compare_digest(unsub_token(secret, sid), raw):
            return sid, rec
    return None


def confirmed(doc):
    return [(sid, rec) for sid, rec in doc.get("subs", {}).items()
            if isinstance(rec, dict) and rec.get("status") == "confirmed"]


def count_by_status(doc):
    out = {"confirmed": 0, "pending": 0, "unsubscribed": 0}
    for rec in doc.get("subs", {}).values():
        if isinstance(rec, dict) and rec.get("status") in out:
            out[rec["status"]] += 1
    return out


def prune_pending(doc, now, max_age_ms=PENDING_MAX_MS):
    subs = doc.get("subs", {})
    old = [sid for sid, rec in subs.items()
           if isinstance(rec, dict) and rec.get("status") == "pending"
           and A._is_int(rec.get("created")) and now - rec["created"] > max_age_ms]
    for sid in old:
        del subs[sid]
    return len(old)


def subscribers_csv(doc):
    lines = ["email,status,created,confirmed"]
    for _sid, rec in sorted(confirmed(doc), key=lambda x: x[1].get("confirmed") or 0):
        e = str(rec.get("email", "")).replace('"', '""')
        lines.append(f'"{e}",confirmed,{rec.get("created") or ""},{rec.get("confirmed") or ""}')
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------------ issues

def new_issue(week, now, compiled_by="owner"):
    return {"v": 1, "id": week["to"], "week": dict(week), "status": "draft", "created": now, "updated": now,
            "compiledBy": compiled_by,
            "source": {"notes": [], "marks": [], "links": [], "studies": [], "chapters": [],
                       "counts": {"notes": 0, "marks": 0, "links": 0, "studies": 0, "chapters": 0, "minutes": 0}},
            "draft": None, "html": "", "text": "", "review": {"tokenHash": None, "mailedAt": 0},
            "approved": None, "skipped": None,
            "send": {"due": 0, "startedAt": None, "finishedAt": None, "sent": 0, "failed": 0, "done": {},
                     "errors": []}}


def public_issue(issue):
    out = json.loads(json.dumps(issue))
    out["review"] = {"mailedAt": (issue.get("review") or {}).get("mailedAt", 0)}
    return out


def issue_row(issue):
    s = issue.get("send") or {}
    return {"id": issue.get("id"), "week": issue.get("week"), "status": issue.get("status"),
            "counts": ((issue.get("source") or {}).get("counts")) or {}, "created": issue.get("created"),
            "approved": issue.get("approved"), "stitched": bool((issue.get("draft") or {}).get("stitched")),
            "send": {"due": s.get("due", 0), "sent": s.get("sent", 0), "failed": s.get("failed", 0)}}


# ------------------------------------------------------------------ weeks and schedule

def get_tz(name):
    """A zoneinfo name -> ZoneInfo, or None when unknown (the caller keeps its default and warns)."""
    if ZoneInfo is None or not isinstance(name, str) or not name:
        return None
    try:
        return ZoneInfo(name)
    except Exception:
        return None


def _tz(tz):
    return tz if not isinstance(tz, str) else get_tz(tz)


def week_for(end_day):
    """The week ending on `end_day` (a date or 'YYYY-MM-DD') -> {"from", "to"}."""
    d = end_day if isinstance(end_day, datetime.date) else A.parse_day(end_day)
    if d is None:
        raise ValueError("invalid day")
    return {"from": (d - datetime.timedelta(days=6)).isoformat(), "to": d.isoformat()}


def week_bounds_ms(week, tz):
    """[from 00:00, to 24:00) local -> (start_ms, end_ms). Arithmetic is on the wall clock, so a week that holds a
    DST change is 167 or 169 hours long, as it should be."""
    z = _tz(tz)
    a, b = A.parse_day(week["from"]), A.parse_day(week["to"])
    start = datetime.datetime(a.year, a.month, a.day, tzinfo=z)
    end = datetime.datetime(b.year, b.month, b.day, tzinfo=z) + datetime.timedelta(days=1)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def _day_month(d):
    return f"{d.day} {d.strftime('%B')}"


def week_label(week):
    a, b = A.parse_day(week["from"]), A.parse_day(week["to"])
    if a.year != b.year:
        return f"{_day_month(a)} {a.year}–{_day_month(b)} {b.year}"
    if a.month != b.month:
        return f"{_day_month(a)}–{_day_month(b)} {b.year}"
    return f"{a.day}–{b.day} {b.strftime('%B')} {b.year}"


def local_day(now_ms, tz):
    return datetime.datetime.fromtimestamp(now_ms / 1000, _tz(tz)).date()


SCHEDULE_RE = re.compile(r"(mon|tue|wed|thu|fri|sat|sun)\s+([01]?\d|2[0-3]):([0-5]\d)", re.ASCII)


def parse_schedule(s):
    """'sat 06:00' -> ("at", 5, 6, 0); 'off' -> ("off",); 'now' -> ("now",); anything else -> None."""
    if not isinstance(s, str):
        return None
    t = s.strip().lower()
    if t == "off":
        return ("off",)
    if t == "now":
        return ("now",)
    m = SCHEDULE_RE.fullmatch(t)
    if not m:
        return None
    return ("at", DAYS.index(m.group(1)), int(m.group(2)), int(m.group(3)))


def _moment_on(day, h, mi, z):
    return int(datetime.datetime(day.year, day.month, day.day, h, mi, tzinfo=z).timestamp() * 1000)


def last_moment(sched, now_ms, tz):
    """The latest occurrence of the schedule at or before `now_ms` (ms), or None for off/now/bad."""
    if not sched or sched[0] != "at":
        return None
    z = _tz(tz)
    _, dow, h, mi = sched
    today = datetime.datetime.fromtimestamp(now_ms / 1000, z).date()
    for back in range(0, 8):
        d = today - datetime.timedelta(days=back)
        if d.weekday() == dow:
            t = _moment_on(d, h, mi, z)
            if t <= now_ms:
                return t
    d = today - datetime.timedelta(days=(today.weekday() - dow) % 7 + 7)
    return _moment_on(d, h, mi, z)


def next_moment(sched, now_ms, tz):
    """The first occurrence strictly after `now_ms`; ("now",) -> now_ms; off/bad -> None."""
    if not sched:
        return None
    if sched[0] == "now":
        return now_ms
    if sched[0] != "at":
        return None
    z = _tz(tz)
    _, dow, h, mi = sched
    today = datetime.datetime.fromtimestamp(now_ms / 1000, z).date()
    for ahead in range(0, 8):
        d = today + datetime.timedelta(days=ahead)
        if d.weekday() == dow:
            t = _moment_on(d, h, mi, z)
            if t > now_ms:
                return t
    return None


def schedule_text(sched):
    if not sched or sched[0] == "off":
        return "off"
    if sched[0] == "now":
        return "on approval"
    return f"{DAY_NAMES[sched[1]]}s {sched[2]:02d}:{sched[3]:02d}"


# ------------------------------------------------------------------ Bible text and labels

_BSB = {}
_BSB_LOCK = threading.Lock()


def _bsb_book(b):
    with _BSB_LOCK:
        if b not in _BSB:
            data = None
            for name in (f"{b}.json", f"{b:02d}.json"):
                p = os.path.join(BSB_DIR, name)
                if os.path.exists(p):
                    with open(p, encoding="utf-8") as f:
                        data = json.load(f)
                    break
            _BSB[b] = data or {}
        return _BSB[b]


def verse_words(b, c, v, ve=None):
    """The BSB words of b.c.v (or b.c.v–ve), word for word; '' when the file has no such verse."""
    ch = _bsb_book(b).get(str(c)) or []
    ve = ve or v
    parts = []
    for n in range(v, ve + 1):
        if 1 <= n <= len(ch) and isinstance(ch[n - 1], str):
            parts.append(ch[n - 1].strip())
    return " ".join(p for p in parts if p)


def book_name(b):
    return A.meta()["books"][b - 1]


def chapter_label(b, c):
    return f"{'Psalm' if b == 19 else book_name(b)} {c}"


def ref_label(b, c, v=0, ve=0):
    base = chapter_label(b, c) + (f":{v}" if v else "")
    return f"{base}–{ve}" if v and ve and ve > v else base


def parse_any_ref(s):
    """'b.c', 'b.c.v' or 'b.c.v-ve' -> (b, c, v, ve) with v = ve = 0 for a chapter; None when invalid."""
    p = A.parse_link_ref(s) if isinstance(s, str) and "-" in s else None
    if p:
        return p
    q = A.parse_ref(s)
    if q:
        return q[0], q[1], q[2], q[2]
    return None


def label_of(ref):
    p = parse_any_ref(ref)
    return ref_label(*p) if p else str(ref)


def _flat(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


_NUMBERED = {"i": "1", "ii": "2", "iii": "3", "first": "1", "second": "2", "third": "3", "1st": "1", "2nd": "2",
             "3rd": "3"}
_HUMAN_RE = re.compile(r"^((?:(?:[1-3]|i{1,3}|first|second|third|1st|2nd|3rd)\s*)?[a-z]+(?:\s+(?:of\s+)?[a-z]+)*)"
                       r"\.?\s*(\d+)?(?:[:.\s]+(\d+))?(?:\s*[-–—]\s*(\d+))?$", re.I)


def parse_human_ref(text):
    """'John 3:16', 'Jn 3.16', '1 John 4:19', 'Rom 5:8-9', 'Psalm 23', '43.3.16' -> (b, c, v, ve) or None."""
    t = str(text or "").strip()
    p = parse_any_ref(t)
    if p:
        return p
    m = _HUMAN_RE.match(t)
    if not m:
        return None
    name = re.sub(r"\s+", " ", m.group(1).lower()).strip()
    num = re.match(r"^(i{1,3}|first|second|third|1st|2nd|3rd)\s+(.*)$", name)
    if num:
        name = f"{_NUMBERED[num.group(1)]} {num.group(2)}"
    key = _flat(name)
    meta = A.meta()
    found = None
    for i, bn in enumerate(meta["books"]):
        osis, short = meta["abbr"][i]
        if key in (_flat(bn), _flat(osis), _flat(short)):
            found = i + 1
            break
    if found is None and key == "psalm":
        found = 19
    if found is None:
        for i, bn in enumerate(meta["books"]):
            if _flat(bn).startswith(key) and len(key) >= 3:
                found = i + 1
                break
    if found is None:
        return None
    nch = A.chapters_in(found)
    c = int(m.group(2)) if m.group(2) else 1
    v = int(m.group(3)) if m.group(3) else 0
    if nch == 1 and m.group(2) and not m.group(3) and int(m.group(2)) > 1:
        v, c = int(m.group(2)), 1
    if not 1 <= c <= nch or v < 0 or v > A.verses_in(found, c):
        return None
    ve = v
    if m.group(4) and v:
        ve = min(int(m.group(4)), A.verses_in(found, c))
        ve = ve if ve > v else v
    return found, c, v, ve


# ------------------------------------------------------------------ gathering the week

def _read_quiet(path, default):
    try:
        with open(path, "rb") as f:
            obj = json.loads(f.read().decode("utf-8"))
        return obj if isinstance(obj, dict) else dict(default)
    except (OSError, ValueError, UnicodeDecodeError):
        return dict(default)


def _paths_for(profile):
    if isinstance(profile, dict):
        return profile
    return {"notes": A.notes_path(profile), "marks": A.marks_path(profile), "links": A.links_path(profile),
            "library": A.library_path(profile), "memory": A.memory_path(profile)}


def _in(t, start, end):
    return A._is_int(t) and start <= t < end


def _bible_key(ref):
    p = parse_any_ref(ref)
    return p[:3] if p else (99, 0, 0)


def _mark_words(m):
    """The BSB words a highlight covers: the slice between so/eo when it was made on the BSB, else the whole BSB
    verse range (another translation's words are never reproduced)."""
    s, e = A.parse_mark_end(m.get("start")), A.parse_mark_end(m.get("end"))
    if not s or not e:
        return "", ""
    b, c, v1, v2 = s[0], s[1], s[2], e[2]
    so, eo = m.get("so"), m.get("eo")
    if m.get("tr") == "bsb" and A._is_int(so) and A._is_int(eo):
        ch = _bsb_book(b).get(str(c)) or []
        if 1 <= v1 <= v2 <= len(ch):
            if v1 == v2:
                words = ch[v1 - 1][so:eo]
            else:
                words = " ".join([ch[v1 - 1][so:]] + [ch[n - 1] for n in range(v1 + 1, v2)] + [ch[v2 - 1][:eo]])
            words = re.sub(r"\s+", " ", words).strip()
            if words:
                return words, A.link_ref_str(b, c, v1, v2)
    return verse_words(b, c, v1, v2), A.link_ref_str(b, c, v1, v2)


def gather(profile, week, tz):
    """The author's week, read-only, from the profile files -> material for the draft (see source_of)."""
    paths = _paths_for(profile)
    start, end = week_bounds_ms(week, tz)
    notes_doc = _read_quiet(paths["notes"], {})
    marks_doc = _read_quiet(paths["marks"], {})
    links_doc = _read_quiet(paths["links"], {})
    lib = _read_quiet(paths["library"], {})
    mem_doc = _read_quiet(paths["memory"], {})

    notes = []
    for ref, n in (notes_doc.get("refs") or {}).items():
        if not isinstance(n, dict):
            continue
        ck = A.canonical_ref(ref)
        text = n.get("text")
        if ck and isinstance(text, str) and text.strip() and _in(n.get("updated"), start, end):
            notes.append({"ref": ck, "label": label_of(ck), "text": text.strip(),
                          "tags": [t for t in (n.get("tags") or []) if isinstance(t, str)], "updated": n["updated"]})
    notes.sort(key=lambda x: (_bible_key(x["ref"]), x["updated"]))

    marks = []
    for mid, m in (marks_doc.get("marks") or {}).items():
        if not isinstance(m, dict) or not _in(m.get("updated"), start, end):
            continue
        words, ref = _mark_words(m)
        if not words:
            continue
        marks.append({"id": mid, "ref": ref, "label": label_of(ref), "words": words,
                      "note": (m.get("note") or "").strip() if isinstance(m.get("note"), str) else "",
                      "updated": m["updated"]})
    marks.sort(key=lambda x: (_bible_key(x["ref"]), x["updated"]))

    links = []
    for lid, ln in (links_doc.get("links") or {}).items():
        if not isinstance(ln, dict) or not _in(ln.get("created"), start, end):
            continue
        a, b = A.parse_link_ref(ln.get("from")), A.parse_link_ref(ln.get("to"))
        if not a or not b:
            continue
        typ = ln.get("type") if ln.get("type") in A.LINK_TYPES else "related"
        phrase = (ln.get("label") or "") if typ == "custom" else A.LINK_TYPES[typ][0]
        links.append({"id": lid, "from": A.link_ref_str(*a), "to": A.link_ref_str(*b), "type": typ,
                      "phrase": phrase or "is linked to", "fromLabel": ref_label(*a), "toLabel": ref_label(*b),
                      "note": (ln.get("note") or "").strip() if isinstance(ln.get("note"), str) else "",
                      "created": ln["created"]})
    links.sort(key=lambda x: (_bible_key(x["from"]), x["created"]))

    studies = []
    for s in (notes_doc.get("studies") or []):
        if isinstance(s, dict) and isinstance(s.get("id"), str) and _in(s.get("updated"), start, end):
            keys = [e.get("key") for e in (s.get("entries") or []) if isinstance(e, dict) and isinstance(e.get("key"), str)]
            studies.append({"id": s["id"], "title": (s.get("title") or "").strip() if isinstance(s.get("title"), str) else "",
                            "intro": (s.get("intro") or "").strip() if isinstance(s.get("intro"), str) else "",
                            "keys": keys, "updated": s["updated"]})
    studies.sort(key=lambda x: x["updated"])

    chapters = []
    for ref, ch in (lib.get("chapters") or {}).items():
        ck = A.canonical_ref(ref)
        if ck and isinstance(ch, dict) and _in(ch.get("lastRead"), start, end):
            p = A.parse_ref(ck)
            chapters.append({"ref": ck, "label": chapter_label(p[0], p[1]), "lastRead": ch["lastRead"],
                             "visits": ch.get("visits") if A._is_int(ch.get("visits")) else 0})
    chapters.sort(key=lambda x: x["lastRead"])

    seconds = 0
    for day, d in (lib.get("days") or {}).items():
        if isinstance(d, dict) and week["from"] <= str(day) <= week["to"] and A._is_int(d.get("s")):
            seconds += d["s"]
    activity = {"chapter.open": 0, "xref.open": 0}
    for a in (lib.get("activity") or []):
        if isinstance(a, dict) and a.get("type") in activity and _in(a.get("t"), start, end):
            activity[a["type"]] += 1

    memory = []
    for mid, v in (mem_doc.get("memory") or {}).items():
        if isinstance(v, dict) and _in(v.get("created"), start, end) and A.parse_link_ref(v.get("ref")):
            r = A.link_ref_str(*A.parse_link_ref(v["ref"]))
            memory.append({"id": mid, "ref": r, "label": label_of(r), "created": v["created"]})
    memory.sort(key=lambda x: _bible_key(x["ref"]))

    counts = {"notes": len(notes), "marks": len(marks), "links": len(links), "studies": len(studies),
              "chapters": len(chapters), "minutes": seconds // 60}
    return {"week": dict(week), "notes": notes, "marks": marks, "links": links, "studies": studies,
            "chapters": chapters, "activity": activity, "memory": memory, "counts": counts}


def source_of(material):
    """The issue's `source` block (ids and counts), §2.2."""
    return {"notes": [n["ref"] for n in material["notes"]], "marks": [m["id"] for m in material["marks"]],
            "links": [ln["id"] for ln in material["links"]], "studies": [s["id"] for s in material["studies"]],
            "chapters": [c["ref"] for c in material["chapters"]], "counts": dict(material["counts"])}


def is_empty(material):
    return not (material["notes"] or material["marks"] or material["links"] or material["studies"])


def _chapter_of(ref):
    p = parse_any_ref(ref)
    return (p[0], p[1]) if p else None


def material_chapters(material):
    """Chapters with something written in them this week, in Bible order: [(b, c)]."""
    seen = set()
    for n in material["notes"]:
        seen.add(_chapter_of(n["ref"]))
    for m in material["marks"]:
        seen.add(_chapter_of(m["ref"]))
    for ln in material["links"]:
        seen.add(_chapter_of(ln["from"]))
    return sorted(x for x in seen if x)


def allowed_refs(material):
    """Every verse the week touched (canonical keys) and every stored range string: what a draft may cite."""
    verses, strings = set(), set()
    for ref in [n["ref"] for n in material["notes"]] + [m["ref"] for m in material["marks"]] + \
               [ln["from"] for ln in material["links"]] + [ln["to"] for ln in material["links"]] + \
               [v["ref"] for v in material["memory"]]:
        p = parse_any_ref(ref)
        if p and p[2]:
            strings.add(ref)
            for v in range(p[2], p[3] + 1):
                verses.add(f"{p[0]}.{p[1]}.{v}")
    return verses, strings


# ------------------------------------------------------------------ the deterministic draft

def _plural(n, w):
    return f"{n} {w}" + ("" if n == 1 else "s")


def deterministic_draft(material):
    """§4.2: always available; the fallback and the test path. Ji's words are quoted as they are."""
    week = material["week"]
    end = A.parse_day(week["to"])
    counts = material["counts"]
    chapters = material_chapters(material)
    title = "This week"
    if material["studies"] and material["studies"][0]["title"]:
        title = material["studies"][0]["title"]
    elif material["chapters"]:
        most = max(material["chapters"], key=lambda c: (c["visits"], c["lastRead"]))
        title = most["label"]
    elif chapters:
        title = chapter_label(*chapters[0])
    # The counts already sit in the line under the title, so the opening is Ji's own overview when he wrote one: the
    # first chapter-level note of the week (a note on "John 3" rather than on a verse), lifted out of its section.
    overview = next((n for n in material["notes"] if not parse_any_ref(n["ref"])[2] and n["text"].strip()), None)
    opening = overview["text"] if overview else ""
    sections = []
    for b, c in chapters:
        refs, body, quotes = [], [], []
        for n in material["notes"]:
            if _chapter_of(n["ref"]) == (b, c):
                if parse_any_ref(n["ref"])[2] and n["ref"] not in refs:
                    refs.append(n["ref"])
                if n is not overview:
                    body.append(n["text"])
        for m in material["marks"]:
            if _chapter_of(m["ref"]) == (b, c):
                if m["ref"] not in refs:
                    refs.append(m["ref"])
                quotes.append(f"{m['label']} · “{m['words']}”" + (f" · {m['note']}" if m["note"] else ""))
        for ln in material["links"]:
            if _chapter_of(ln["from"]) == (b, c):
                if ln["from"] not in refs:
                    refs.append(ln["from"])
                body.append(f"→ {ln['toLabel']} · {ln['phrase']}" + (f" · {ln['note']}" if ln["note"] else ""))
        sections.append({"heading": chapter_label(b, c), "refs": refs, "body": "\n\n".join(body), "quotes": quotes})
    closing = next((s["intro"] for s in material["studies"] if s["intro"]), "")
    return {"subject": f"Weekly devotional · {_day_month(end)}", "title": title, "opening": opening,
            "sections": sections, "closing": closing, "question": "", "stitched": False, "model": None,
            "warnings": []}


# ------------------------------------------------------------------ the stitched draft (Claude API)

STITCH_SYSTEM = """You are arranging one reader's week of Bible study notes into a short weekly devotional email from Bible Lantern.

Use the reader's own words. Keep their sentences; you may fix spelling and punctuation, join fragments, remove duplication, and add short connective sentences so it reads as one piece. Do not add claims, facts, interpretations or applications the reader did not write. Do not add dates, authorship or history.

Never quote or paraphrase Scripture yourself: put a verse in `refs` and the server inserts its published text. `quotes` holds only the reader's own highlighted phrases, exactly as given.

Order: a one-paragraph opening in the reader's voice; 2–5 sections, each around one passage or one thread of connections; a closing paragraph; one question for the reader's notes.

Speak of God, the Lord, Jesus and the Holy Spirit with reverence; never list them among people.

British spelling, plain words, no exclamation marks, no emoji, no headings in all caps, no marketing language.

If the material is thin, keep the email short rather than padding it.

Shapes: `refs` are canonical keys like 43.3.16 or 45.5.8-9, taken only from the material given. The `title` is a short phrase of two to five words; you may wrap exactly one word of it in <em></em> and nothing else in any field is HTML. `subject` is a plain line. Paragraphs are separated by a blank line; **bold** and *italics* are allowed; a verse reference inside text is written [[John 3:16]]."""

DRAFT_SCHEMA = {
    "type": "object",
    "properties": {
        "subject": {"type": "string"},
        "title": {"type": "string"},
        "opening": {"type": "string"},
        "sections": {"type": "array", "items": {
            "type": "object",
            "properties": {"heading": {"type": "string"}, "refs": {"type": "array", "items": {"type": "string"}},
                           "body": {"type": "string"}, "quotes": {"type": "array", "items": {"type": "string"}}},
            "required": ["heading", "refs", "body", "quotes"], "additionalProperties": False}},
        "closing": {"type": "string"},
        "question": {"type": "string"},
    },
    "required": ["subject", "title", "opening", "sections", "closing", "question"],
    "additionalProperties": False,
}


def material_for_model(material):
    """The week as the model sees it: each item with its label and the BSB words of the verses Ji was reading."""
    def with_words(ref):
        p = parse_any_ref(ref)
        return {"ref": ref, "label": label_of(ref), "bsb": verse_words(p[0], p[1], p[2], p[3]) if p and p[2] else ""}
    return {
        "week": material["week"], "counts": material["counts"],
        "notes": [{"ref": n["ref"], "label": n["label"], "verse": with_words(n["ref"])["bsb"], "text": n["text"],
                   "tags": n["tags"]} for n in material["notes"]],
        "highlights": [{"id": m["id"], "ref": m["ref"], "label": m["label"], "words": m["words"], "comment": m["note"]}
                       for m in material["marks"]],
        "links": [{"from": with_words(ln["from"]), "to": with_words(ln["to"]), "type": ln["phrase"], "note": ln["note"]}
                  for ln in material["links"]],
        "studies": [{"title": s["title"], "intro": s["intro"], "passages": [label_of(k) if parse_any_ref(k) else k
                                                                            for k in s["keys"]]}
                    for s in material["studies"]],
        "chaptersRead": [c["label"] for c in material["chapters"]],
        "memoryVerses": [with_words(v["ref"]) for v in material["memory"]],
    }


def stitch_request(material, model):
    return {"model": model, "max_tokens": 8000,
            "system": [{"type": "text", "text": STITCH_SYSTEM, "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": json.dumps(material_for_model(material), ensure_ascii=False)}],
            "output_config": {"effort": "high", "format": {"type": "json_schema", "schema": DRAFT_SCHEMA}}}


_EM_RE = re.compile(r"<em>([^<>]{1,60})</em>")
_TAG_RE = re.compile(r"<[^>]*>")


def clean_title(t):
    """At most one <em>word</em> survives; every other tag is removed."""
    m = _EM_RE.search(t)
    plain = _TAG_RE.sub("", t)
    if not m:
        return plain
    before, after = _TAG_RE.sub("", t[:m.start()]), _TAG_RE.sub("", t[m.end():])
    return f"{before}<em>{m.group(1)}</em>{after}"


def _str_field(obj, key, limit):
    v = obj.get(key)
    if not isinstance(v, str):
        raise ValueError(f"{key} missing")
    v = A.clean_text(v) if "\n" not in v else "\n".join(A.clean_text(x) for x in v.split("\n"))
    v = v.strip()
    if len(v) > limit:
        raise ValueError(f"{key} too long")
    return v


def validate_draft(obj, material):
    """The model's JSON -> a draft dict, or ValueError. Refs not in the material are dropped, never guessed."""
    if not isinstance(obj, dict):
        raise ValueError("not an object")
    verses, strings = allowed_refs(material)
    out = {"subject": _str_field(obj, "subject", LIMITS["subject"]),
           "title": clean_title(_str_field(obj, "title", LIMITS["title"] + 9)),
           "opening": _str_field(obj, "opening", LIMITS["opening"]),
           "closing": _str_field(obj, "closing", LIMITS["closing"]),
           "question": _str_field(obj, "question", LIMITS["question"])}
    if not out["subject"] or not out["title"]:
        raise ValueError("empty subject or title")
    secs = obj.get("sections")
    if not isinstance(secs, list) or not secs or len(secs) > SECTIONS_MAX:
        raise ValueError("sections")
    out["sections"] = []
    dropped, dropped_quotes = 0, 0
    for s in secs:
        if not isinstance(s, dict):
            raise ValueError("section")
        refs = []
        for r in (s.get("refs") if isinstance(s.get("refs"), list) else []):
            p = parse_any_ref(r) if isinstance(r, str) else None
            ok = bool(p and p[2] and (r in strings or all(f"{p[0]}.{p[1]}.{v}" in verses for v in range(p[2], p[3] + 1))))
            if ok and r not in refs:
                refs.append(r)
            elif not ok:
                dropped += 1
        quotes = []
        for q in (s.get("quotes") if isinstance(s.get("quotes"), list) else []):
            if isinstance(q, str) and q.strip():
                kept = highlight_quote(A.clean_text(q.strip())[:LIMITS["quote"]], material)
                if kept is None:
                    dropped_quotes += 1
                elif kept not in quotes:
                    quotes.append(kept)
        out["sections"].append({"heading": _str_field(s, "heading", LIMITS["heading"]), "refs": refs,
                                "body": _str_field(s, "body", LIMITS["body"]), "quotes": quotes})
    out["warnings"] = ([f"{dropped} reference(s) not in the week's material were dropped"] if dropped else []) + \
                      ([f"{dropped_quotes} quote(s) not among the week's highlights were dropped"] if dropped_quotes else [])
    return out


def _fold(s):
    return re.sub(r"\s+", " ", s).strip().casefold()


def highlight_quote(q, material):
    """A quote is kept only when its words are the reader's own highlighted words (a case-insensitive substring of
    a mark's BSB words in the material); it comes back as 'Label · “words” · comment' with the mark's own label, so
    a reference never sits over words the model wrote. Anything else -> None."""
    label, words, rest = _quote_parts(q)
    if words is None:
        words, rest = q, ""
    needle = _fold(words)
    if not needle:
        return None
    for m in material.get("marks") or []:
        hay = _fold(m.get("words") or "") if isinstance(m, dict) else ""
        if hay and needle in hay:
            return f"{m.get('label') or label_of(m.get('ref', ''))} · “{words.strip()}”" + (f" · {rest}" if rest else "")
    return None


def stitch(material, key, url, model, opener=None, sleep=time.sleep, timeout=STITCH_TIMEOUT):
    """§4.3: one POST to {url}/v1/messages (one retry on 429/5xx). Any failure -> the deterministic draft with a
    warning; the key never reaches the log."""
    fallback = deterministic_draft(material)
    try:
        body = json.dumps(stitch_request(material, model), ensure_ascii=False).encode("utf-8")
        opener = opener or urllib.request.build_opener()
        status, raw = None, b""
        for attempt in range(2):
            req = urllib.request.Request(url.rstrip("/") + "/v1/messages", data=body, method="POST",
                                         headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                                                  "content-type": "application/json", "User-Agent": "bible-lantern"})
            try:
                with opener.open(req, timeout=timeout) as r:
                    status, raw = r.status, r.read(4 * 1024 * 1024)
            except urllib.error.HTTPError as e:
                status, raw = e.code, b""
            except (urllib.error.URLError, OSError, ValueError) as e:
                status, raw = None, str(type(e).__name__).encode()
            if status == 200:
                break
            if attempt == 0 and (status is None or status == 429 or status >= 500):
                sleep(STITCH_PAUSE)
                continue
            break
        if status != 200:
            raise ValueError(f"http {status}" if status else "network")
        resp = json.loads(raw.decode("utf-8"))
        if resp.get("stop_reason") != "end_turn":
            raise ValueError(f"stop_reason {resp.get('stop_reason')}")
        text = next((c.get("text") for c in resp.get("content") or [] if isinstance(c, dict) and c.get("type") == "text"), None)
        if not isinstance(text, str):
            raise ValueError("no text block")
        draft = validate_draft(json.loads(text), material)
        draft.update(stitched=True, model=model)
        return draft
    except Exception as e:  # noqa: any failure falls back; the reason is logged without the key
        reason = A._safe_log_text(f"{type(e).__name__}: {e}", 160).replace(key or "\0", "[key]")
        log_line(f"stitch failed: {reason}")
        fallback["warnings"] = [f"stitch failed: {reason}"]
        return fallback


# ------------------------------------------------------------------ rendering

SERIF = "'New York', 'Iowan Old Style', Charter, Palatino, Georgia, serif"
SANS = "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif"
BG, INK, DIM, GOLD, BAND, LINE, SOFT = "#050505", "#f5f3ee", "#9f9d99", "#ffb35c", "#0b0b0d", "#1e1d1b", "#dedbd4"
PAD = 40
WIDTH = 600
ARC_W, OT_CHAPTERS = 520, 929


def esc(s):
    return html.escape(str(s if s is not None else ""), quote=True)


def site_link(site, hash_="", path="/"):
    """{SITE}{path}?utm… with the hash after the query."""
    return f"{site.rstrip('/')}{path}?{UTM}" + (f"#{hash_}" if hash_ else "")


def verse_link(site, ref):
    p = parse_any_ref(ref)
    return site_link(site, f"{p[0]}/{p[1]}/{p[2]}" if p[2] else f"{p[0]}/{p[1]}") if p else site_link(site)


def unsubscribe_url(site, token):
    return f"{site.rstrip('/')}/api/devotional/unsubscribe?t={token}"


def personalise(s, raw_token):
    return s.replace(UNSUB_PLACEHOLDER, raw_token)


def _kick(text):
    return (f'<p style="margin:0 0 10px;font:600 12px/1.2 {SANS};letter-spacing:.16em;text-transform:uppercase;'
            f'color:{GOLD};">{text}</p>')


def _cite(site, ref):
    return (f'<p style="margin:0;font:600 13px/1.15 {SANS};letter-spacing:.08em;text-transform:uppercase;'
            f'color:{GOLD};"><a href="{esc(verse_link(site, ref))}" style="color:{GOLD};text-decoration:none;">'
            f'{esc(label_of(ref))} · {TRANSLATION}</a></p>')


def _words_of(ref):
    p = parse_any_ref(ref)
    return verse_words(p[0], p[1], p[2], p[3]) if p and p[2] else ""


_MD_INLINE = [
    (re.compile(r"\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]"), "wiki"),
    (re.compile(r"\*\*(.+?)\*\*"), "b"),
    (re.compile(r"(^|[^\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w*])"), "i"),
]


def _md_inline(s, site, plain=False):
    out = ""
    while s:
        best = None
        for rx, kind in _MD_INLINE:
            m = rx.search(s)
            if m and (best is None or m.start() < best[0].start()):
                best = (m, kind)
        if not best:
            return out + (s if plain else esc(s))
        m, kind = best
        lead = m.group(1) if kind == "i" else ""
        head = s[:m.start()] + lead
        out += head if plain else esc(head)
        if kind == "wiki":
            target, label = m.group(1).strip(), (m.group(2) or m.group(1)).strip()
            label = label.split(" · ")[0] if " · " in label and not m.group(2) else label
            p = parse_human_ref(target.split(" · ")[0])
            if plain:
                out += label
            elif p:
                out += f'<a href="{esc(verse_link(site, A.link_ref_str(*p) if p[2] else f"{p[0]}.{p[1]}"))}" style="color:{GOLD};text-decoration:none;">{esc(label)}</a>'
            else:
                out += esc(label)
        elif kind == "b":
            out += _md_inline(m.group(1), site, plain) if plain else f"<b>{_md_inline(m.group(1), site)}</b>"
        else:
            out += _md_inline(m.group(2), site, plain) if plain else f"<i>{_md_inline(m.group(2), site)}</i>"
        s = s[m.end():]
    return out


def md_html(text, site, style=""):
    """Ji's markdown subset -> paragraphs, lists and quotes with inline styles; everything escaped."""
    p_style = f'margin:0 0 14px;font:400 17px/1.6 {SANS};color:{INK};{style}'
    lines = str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out, para, items, quote = [], [], [], []

    def flush():
        if para:
            out.append(f'<p style="{p_style}">{"<br>".join(_md_inline(x, site) for x in para)}</p>')
        if items:
            out.append(f'<ul style="margin:0 0 14px;padding-left:20px;font:400 17px/1.6 {SANS};color:{INK};">'
                       + "".join(f"<li>{_md_inline(x, site)}</li>" for x in items) + "</ul>")
        if quote:
            out.append(f'<blockquote style="margin:0 0 14px;padding-left:16px;border-left:2px solid {GOLD};'
                       f'font:italic 400 17px/1.6 {SERIF};color:{SOFT};">{"<br>".join(_md_inline(x, site) for x in quote)}</blockquote>')
        para.clear(), items.clear(), quote.clear()

    for line in lines:
        s = line.rstrip()
        m_h = re.match(r"^#{1,3} (.*)$", s)
        m_l = re.match(r"^[-*] (.*)$", s)
        m_q = re.match(r"^> ?(.*)$", s)
        if not s.strip():
            flush()
        elif m_h:
            flush()
            out.append(f'<p style="{p_style}font-weight:600;">{_md_inline(m_h.group(1), site)}</p>')
        elif m_l:
            if para or quote:
                flush()
            items.append(m_l.group(1))
        elif m_q:
            if para or items:
                flush()
            quote.append(m_q.group(1))
        else:
            if items or quote:
                flush()
            para.append(s)
    flush()
    return "".join(out)


def md_text(text):
    """The plain-text twin of md_html."""
    lines = []
    for line in str(text or "").replace("\r\n", "\n").split("\n"):
        s = re.sub(r"^#{1,3} ", "", line.rstrip())
        s = re.sub(r"^[-*] ", "• ", s)
        lines.append(_md_inline(s, "", plain=True))
    return "\n".join(lines).strip()


def title_html(title):
    m = _EM_RE.search(title or "")
    if not m:
        return esc(_TAG_RE.sub("", title or ""))
    return (esc(_TAG_RE.sub("", title[:m.start()])) + f'<em style="font-style:italic;color:{GOLD};">{esc(m.group(1))}</em>'
            + esc(_TAG_RE.sub("", title[m.end():])))


def title_text(title):
    return _TAG_RE.sub("", title or "")


def split_verse(words):
    """The verse's first clause (large) and its continuation (gold italic): split at the first clause break after
    a third of the text, when both halves are worth having."""
    n = len(words)
    if n < 70:
        return words, ""
    best = None
    for m in re.finditer(r"[,;:]\s", words):
        if m.end() >= n * 0.3:
            best = m.end()
            break
    if best is None or n - best < 20:
        return words, ""
    return words[:best].rstrip(), words[best:].strip()


# plates
_ART = None
_ART_LOCK = threading.Lock()


def plates():
    global _ART
    with _ART_LOCK:
        if _ART is None:
            try:
                with open(ART_PATH, encoding="utf-8") as f:
                    j = json.load(f)
                _ART = [p for p in (j.get("plates") or []) if isinstance(p, dict) and isinstance(p.get("id"), str)
                        and re.fullmatch(r"[A-Za-z0-9_-]+", p["id"]) and isinstance(p.get("ref"), list) and len(p["ref"]) >= 4]
            except (OSError, ValueError):
                _ART = []
        return _ART


def _plate_for_chapter(b, c, exclude=()):
    """The plate whose own passage is in this chapter, else one with an `also` range here (as art.js orders them)."""
    also = None
    for p in plates():
        if p["id"] in exclude:
            continue
        if (p["ref"][0], p["ref"][1]) == (b, c):
            return p
        if also is None and any(isinstance(r, list) and len(r) >= 2 and (r[0], r[1]) == (b, c) for r in (p.get("also") or [])):
            also = p
    return also


def choose_plates(chapters):
    """(hero, second) from the issue's chapters [(b, c)] in section order: the first chapter's plate, else that
    book's, else dore-001; a second plate only when another chapter has one of its own."""
    hero = None
    if chapters:
        b, c = chapters[0]
        hero = _plate_for_chapter(b, c) or next((p for p in plates() if p["ref"][0] == b), None)
    if hero is None:
        hero = next((p for p in plates() if p["id"] == "dore-001"), plates()[0] if plates() else None)
    second = None
    for b, c in chapters[1:]:
        if hero and (b, c) == (hero["ref"][0], hero["ref"][1]):
            continue
        p = _plate_for_chapter(b, c, exclude=(hero["id"],) if hero else ())
        if p:
            second = p
            break
    return hero, second


def _plate_img(site, p):
    return (f'<img src="{esc(site.rstrip("/"))}/data/art/{esc(p["id"])}.jpg" width="{WIDTH}" alt="{esc(p.get("title", ""))}" '
            f'style="display:block;width:100%;max-width:{WIDTH}px;height:auto;border:0;filter:grayscale(1);">')


def _credit(p):
    return (f'<p style="margin:6px 0 0;text-align:right;font:italic 11px/1.2 {SERIF};color:{DIM};">'
            f'Gustave Doré, {esc(p.get("title", ""))} (1866)</p>')


# the connections band
def _chapter_x(b, c):
    before = sum(A.chapters_in(i) for i in range(1, b))
    return ARC_W * (before + c) / A.meta()["total"]


def arcs_svg(chapters, links):
    """The 66 books as two bars (OT and NT split by meta.json), the chapters touched as gold ticks and an arc for
    every link, computed from meta.json chapter counts. Inline SVG: Apple Mail and Outlook for Mac draw it, Gmail
    drops it and shows the thread table below."""
    ot_end = ARC_W * OT_CHAPTERS / A.meta()["total"]
    out = [f'<svg viewBox="0 0 {ARC_W} 170" width="{ARC_W}" height="170" xmlns="http://www.w3.org/2000/svg" '
           f'style="display:block;width:100%;height:auto;" aria-label="Arcs between the chapters linked this week">',
           f'<g fill="#2a2927"><rect x="0" y="116" width="{ot_end - 3:.0f}" height="4" rx="2"/>'
           f'<rect x="{ot_end + 3:.0f}" y="116" width="{ARC_W - ot_end - 3:.0f}" height="4" rx="2"/></g>']
    pts = {}
    for b, c in chapters:
        pts[(b, c)] = _chapter_x(b, c)
    for ln in links:
        for ref in (ln["from"], ln["to"]):
            ch = _chapter_of(ref)
            if ch and ch not in pts:
                pts[ch] = _chapter_x(*ch)
    for (b, c), x in sorted(pts.items(), key=lambda kv: kv[1]):
        out.append(f'<rect x="{x - 4:.1f}" y="112" width="8" height="12" rx="2" fill="{GOLD}"/>')
    for ln in links:
        a, z = _chapter_of(ln["from"]), _chapter_of(ln["to"])
        if not a or not z:
            continue
        x1, x2 = pts[a], pts[z]
        if abs(x1 - x2) < 1:
            continue
        cy = max(8.0, 114 - (30 + abs(x2 - x1) * 0.6))
        out.append(f'<path d="M{x1:.1f} 114 C {x1:.1f} {cy:.0f}, {x2:.1f} {cy:.0f}, {x2:.1f} 114" fill="none" '
                   f'stroke="{GOLD}" stroke-width="1.6" opacity=".85"/>')
    out.append(f'<g font-family="Helvetica, Arial, sans-serif" font-size="12" fill="{DIM}">'
               f'<text x="0" y="166">Old Testament</text><text x="{ARC_W}" y="166" text-anchor="end">New Testament</text>')
    last = [-999.0, -999.0]  # the last label's x on each of the two rows
    for (b, c), x in sorted(pts.items(), key=lambda kv: kv[1])[:6]:
        row = next((i for i in (0, 1) if x - last[i] >= 60), None)  # a near neighbour drops to the second row
        if row is None:
            continue  # no room on either row: the thread table below names it anyway
        last[row] = x
        anchor = "start" if x < 50 else "end" if x > ARC_W - 50 else "middle"
        out.append(f'<text x="{x:.0f}" y="{133 if row == 0 else 144}" text-anchor="{anchor}" fill="{GOLD}" font-size="10">'
                   f'{esc(ref_label(b, c))}</text>')
    out.append("</g></svg>")
    return "".join(out)


def _thread_rows(links, site):
    rows = []
    for ln in links:
        rows.append(
            f'<tr><td valign="top" width="18" style="padding:4px 6px 14px 0;"><span style="display:inline-block;width:8px;height:8px;'
            f'border-radius:4px;background:{GOLD};"></span></td>'
            f'<td style="padding:0 0 14px;font:400 15px/1.5 {SANS};color:{INK};">'
            f'<a href="{esc(verse_link(site, ln["from"]))}" style="color:{INK};font-weight:600;text-decoration:none;">{esc(ln["fromLabel"])}</a> → '
            f'<a href="{esc(verse_link(site, ln["to"]))}" style="color:{INK};font-weight:600;text-decoration:none;">{esc(ln["toLabel"])}</a>'
            f'<span style="display:inline-block;white-space:nowrap;margin-left:6px;padding:1px 8px;border-radius:999px;font:600 11px/1.6 {SANS};'
            f'letter-spacing:.06em;text-transform:uppercase;background:#2a2114;color:{GOLD};">{esc(ln["phrase"])}</span>'
            + (f'<br><span style="color:{DIM};font-size:14px;">{_md_inline(ln["note"], site)}</span>' if ln["note"] else "")
            + "</td></tr>")
    return "".join(rows)


_QUOTE_RE = re.compile(r"^(?:(?P<label>[^“”·]{2,40}) · )?“(?P<words>[^“”]+)”(?: · (?P<rest>.+))?$", re.S)


def _quote_parts(q):
    """'John 3:17 · “words” · comment' -> ('John 3:17', 'words', 'comment'); a plain string -> (None, None, q)."""
    m = _QUOTE_RE.match(q.strip())
    if not m:
        return None, None, q
    label = m.group("label")
    return (label.strip() if label and parse_human_ref(label.strip()) else None), m.group("words").strip(), (m.group("rest") or "").strip()


def _verse_block(site, ref, big=False):
    words = _words_of(ref)
    if not words:
        return ""
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 18px;">'
            f'<tr><td style="padding:2px 0 2px 18px;border-left:2px solid {GOLD};">'
            f'<p style="margin:0 0 10px;font:italic 400 19px/1.45 {SERIF};color:{SOFT};">“{esc(words)}”</p>{_cite(site, ref)}'
            f'</td></tr></table>')


def keep_material(material):
    """What the issue keeps of the gathered week for the renderer (issue["material"]): the links, for the
    connections band, the memory verses, for the companion verse, and the highlights' words, so the owner's edits
    can be checked against them. Everything else lives in the draft."""
    return {"links": [dict(ln) for ln in material["links"]], "memory": [dict(v) for v in material["memory"]],
            "marks": [{"id": m["id"], "ref": m["ref"], "label": m["label"], "words": m["words"]} for m in material["marks"]]}


def _links_for_issue(issue):
    mat = issue.get("material") or {}
    return [ln for ln in (mat.get("links") or []) if isinstance(ln, dict) and ln.get("from") and ln.get("to")]


def _companion(issue, all_refs, key_ref):
    """The verse under "For today": a memory verse added this week, else a link's far end, neither of them quoted
    in a section already; else none (a verse is never quoted twice in one issue)."""
    mat = issue.get("material") or {}
    quoted = set(all_refs) | {key_ref}
    for v in mat.get("memory") or []:
        if isinstance(v, dict) and v.get("ref") not in quoted and _words_of(v.get("ref", "")):
            return v["ref"]
    for ln in _links_for_issue(issue):
        for r in (ln["to"], ln["from"]):
            if r not in quoted and _words_of(r):
                return r
    return None  # nothing new to say under "For today": the block is left out rather than repeating a verse


def render(issue, site, postal="", brand="Bible Lantern", number=None):
    """§4.4: the issue's draft -> (html, text), the design of issue-v3.html as a 600-wide table email. Every link
    carries the utm query before its hash; the unsubscribe link holds UNSUB_PLACEHOLDER for the sender to replace.
    `issue["material"]` (the gathered week, when the compiler kept it) supplies the connections band."""
    d = issue.get("draft") or deterministic_draft({"week": issue["week"], "notes": [], "marks": [], "links": [],
                                                   "studies": [], "chapters": [], "activity": {}, "memory": [],
                                                   "counts": {"notes": 0, "marks": 0, "links": 0, "studies": 0,
                                                              "chapters": 0, "minutes": 0}})
    site = site.rstrip("/")
    week = issue["week"]
    counts = ((issue.get("source") or {}).get("counts")) or {}
    sections = d.get("sections") or []
    links = _links_for_issue(issue)
    chapters = []
    for s in sections:
        for r in s.get("refs") or []:
            ch = _chapter_of(r)
            if ch and ch not in chapters:
                chapters.append(ch)
    for ln in links:
        for r in (ln["from"], ln["to"]):
            ch = _chapter_of(r)
            if ch and ch not in chapters:
                chapters.append(ch)
    section_chapters = [ch for ch in chapters if any(_chapter_of(r) == ch for s in sections for r in (s.get("refs") or []))]
    hero, second = choose_plates(chapters)
    all_refs = [r for s in sections for r in (s.get("refs") or [])]
    key_ref = next((r for r in all_refs if _words_of(r)), None)
    companion = _companion(issue, all_refs, key_ref)
    second_ref = None
    if second:
        sb, sc = second["ref"][0], second["ref"][1]
        second_ref = next((r for r in all_refs if _chapter_of(r) == (sb, sc)), None) or \
            A.link_ref_str(sb, sc, second["ref"][2], second["ref"][2])
    chapter_list = " · ".join(chapter_label(b, c) for b, c in section_chapters[:4])
    kicker = esc(week_label(week))
    tally = (f"{_plural(counts.get('chapters', 0), 'chapter')}, {_plural(counts.get('notes', 0), 'note')}, "
             f"{_plural(counts.get('links', 0), 'connection')}")
    meta_line = f"{chapter_list} · {tally}" if chapter_list else tally
    opening = d.get("opening") or ""
    first_sentence = re.split(r"(?<=[.!?])\s", md_text(opening).strip(), 1)[0][:160]
    last_chapter = section_chapters[-1] if section_chapters else None
    open_label = chapter_label(*last_chapter) if last_chapter else brand
    open_link = site_link(site, f"{last_chapter[0]}/{last_chapter[1]}") if last_chapter else site_link(site)
    mark = f'{site}/icons/icon-192.png'
    unsub = unsubscribe_url(site, UNSUB_PLACEHOLDER) + "&" + UTM
    conn_after = min(2, len(sections))  # the connections band sits after the second section, as in the mock

    def brand_bar(right):
        return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
                f'<td style="font:600 13px/1 {SANS};color:{INK};"><img src="{mark}" width="22" height="22" alt="" '
                f'style="vertical-align:middle;border:0;border-radius:5px;margin-right:8px;">{esc(brand)}</td>'
                f'<td align="right" style="font:500 12px/1 {SANS};color:{DIM};letter-spacing:.1em;text-transform:uppercase;">{right}</td>'
                f'</tr></table>')

    h = [f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
         f'<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">'
         f'<title>{esc(title_text(d["title"]))} · {esc(week_label(week))} · {esc(brand)}</title></head>'
         f'<body style="margin:0;padding:0;background:#000000;color:{INK};">'
         f'<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:{BG};">{esc(first_sentence)}</div>'
         f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#000000;"><tr><td align="center">'
         f'<table role="presentation" width="{WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:{WIDTH}px;background:{BG};">']
    pad = f'padding:0 {PAD}px;'
    h.append(f'<tr><td style="padding:22px {PAD}px;">{brand_bar(f"No. {int(number)}" if number else "Weekly devotional")}</td></tr>')
    if hero:
        h.append(f'<tr><td style="padding:0;background:{BG};">{_plate_img(site, hero)}</td></tr>')
    h.append(f'<tr><td style="padding:28px {PAD}px 0;">{_kick(kicker)}'
             f'<h1 style="margin:0 0 16px;font:400 48px/1.05 {SERIF};letter-spacing:-.02em;color:{INK};">{title_html(d["title"])}</h1>'
             f'<p style="margin:0;font:500 13px/1.4 {SANS};color:{DIM};">{esc(meta_line).replace(" · " + esc(tally), " &nbsp;·&nbsp; " + esc(tally))}</p>'
             + (f'<p style="margin:10px 0 0;font:italic 11px/1.2 {SERIF};color:#6f6d69;">Gustave Doré, {esc(hero.get("title", ""))} (1866)</p>' if hero else "")
             + '</td></tr>')
    if opening:
        h.append(f'<tr><td style="padding:36px {PAD}px 0;">{md_html(opening, site, f"font:400 21px/1.5 {SERIF};")}</td></tr>')
    if key_ref:
        big, tail = split_verse(_words_of(key_ref))
        h.append(f'<tr><td style="padding:30px {PAD}px 42px;">'
                 f'<div style="font:400 120px/0.6 {SERIF};color:{GOLD};height:60px;margin:0 0 6px -4px;">“</div>'
                 f'<h2 style="margin:0;font:400 38px/1.08 {SERIF};letter-spacing:-.02em;color:{INK};">{esc(big)}{"" if tail else "”"}</h2>'
                 + (f'<p style="margin:12px 0 0;font:italic 400 26px/1.15 {SERIF};color:{GOLD};">{esc(tail)}”</p>' if tail else "")
                 + f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 16px;"><tr>'
                 f'<td width="72" height="2" style="background:{GOLD};font-size:0;line-height:0;">&nbsp;</td></tr></table>'
                 f'{_cite(site, key_ref)}</td></tr>')

    def section_html(i, s):
        numeral = ROMAN[i] if i < len(ROMAN) else str(i + 1)
        first_ch = _chapter_of(s["refs"][0]) if s.get("refs") else None
        place = chapter_label(*first_ch) if first_ch else s["heading"]
        # the kicker names the chapter and the heading says something else; when the heading is the chapter itself
        # (the deterministic draft), the kicker is the numeral alone rather than the chapter twice, one line apart
        parts = [_kick(esc(numeral) if place == s["heading"] else f"{esc(numeral)} · {esc(place)}"),
                 f'<h2 style="margin:0 0 16px;font:400 30px/1.12 {SERIF};letter-spacing:-.015em;color:{INK};">{esc(s["heading"])}</h2>']
        refs = [r for r in (s.get("refs") or []) if r != key_ref]  # the key verse was quoted at full volume above
        if refs:
            parts.append(_verse_block(site, refs[0]))
        parts.append(md_html(s.get("body") or "", site))
        for r in refs[1:]:
            parts.append(_verse_block(site, r))
        for q in s.get("quotes") or []:
            label, words, rest = _quote_parts(q)
            inner = (f'<span style="background:#2a2114;border-bottom:2px solid {GOLD};padding:1px 2px;border-radius:2px;">{esc(words)}</span>'
                     + (f' — {_md_inline(rest, site)}' if rest else "")) if words else _md_inline(q, site)
            parts.append(f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 0;">'
                         f'<tr><td style="padding:14px 18px;border:1px solid {LINE};border-radius:12px;font:400 16px/1.6 {SANS};color:{INK};">'
                         f'{_kick("My highlight" + (f" · {esc(label)}" if label else ""))}{inner}</td></tr></table>')
        return f'<tr><td style="padding:34px {PAD}px 0;">{"".join(parts)}</td></tr>'

    for i, s in enumerate(sections):
        h.append(section_html(i, s))
        if i + 1 == conn_after:
            if links:
                books = sorted({_chapter_of(r)[0] for ln in links for r in (ln["from"], ln["to"]) if _chapter_of(r)})
                h.append(f'<tr><td style="margin:0;padding:34px {PAD}px 30px;background:{BAND};border-top:1px solid {LINE};border-bottom:1px solid {LINE};">'
                         f'{_kick("This week’s connections")}'
                         f'<h2 style="margin:0 0 4px;font:400 30px/1.12 {SERIF};letter-spacing:-.015em;color:{INK};">'
                         f'{esc(_plural(len(links), "connection"))}, {esc(_plural(len(books), "book"))}</h2>'
                         f'<p style="margin:0 0 12px;font:400 14px/1.5 {SANS};color:{DIM};">The verses this week linked, drawn across the whole Bible, Genesis to Revelation.</p>'
                         f'{arcs_svg(chapters, links)}'
                         f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;">{_thread_rows(links, site)}</table>'
                         f'</td></tr>')
            if second and second_ref:
                h.append(f'<tr><td style="padding:40px 0 0;">{_plate_img(site, second)}</td></tr>'
                         f'<tr><td style="{pad}">{_credit(second)}</td></tr>'
                         f'<tr><td style="padding:10px {PAD}px 0;">'
                         f'<p style="margin:0 0 10px;font:italic 400 20px/1.4 {SERIF};color:{SOFT};">“{esc(_words_of(second_ref))}”</p>'
                         f'{_cite(site, second_ref)}</td></tr>')
    resp = [_kick("For today")]
    if d.get("closing"):
        resp.append(md_html(d["closing"], site, f"font:400 21px/1.45 {SERIF};margin:0 0 24px;"))
    if d.get("question"):
        resp.append(f'<p style="margin:0 0 24px;font:400 17px/1.6 {SANS};color:{INK};"><b>For your notes:</b> {_md_inline(d["question"], site)} '
                    f'<a href="{esc(site_link(site))}" style="color:{GOLD};text-decoration:none;">Open {esc(brand)}</a></p>')
    if companion:
        resp.append(f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 30px;"><tr>'
                    f'<td style="padding:0 0 0 18px;border-left:2px solid {GOLD};">'
                    f'<p style="margin:0 0 10px;font:italic 400 18px/1.4 {SERIF};color:{SOFT};">“{esc(_words_of(companion))}”</p>'
                    f'{_cite(site, companion)}</td></tr></table>')
    resp.append(f'<p style="margin:0 0 10px -3px;font:400 84px/1 {SERIF};letter-spacing:-.03em;color:{INK};">Amen<span style="color:{GOLD};">.</span></p>'
                f'<p style="margin:0 0 18px;font:500 16px/1.4 {SANS};color:{DIM};">If you believe it, <b style="color:{INK};">reply “Amen”</b> and share this with someone who needs it.</p>'
                f'<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:999px;background:{GOLD};">'
                f'<a href="{esc(open_link)}" style="display:inline-block;padding:11px 20px;border-radius:999px;background:{GOLD};color:{BG};text-decoration:none;font:600 15px/1 {SANS};">'
                f'Open {esc(open_label)} in {esc(brand)}</a></td></tr></table>')
    h.append(f'<tr><td style="padding:34px {PAD}px 0;">{"".join(resp)}</td></tr>')
    foot = [brand_bar("Weekly devotional"),
            f'<p style="margin:16px 0 14px;font:400 12px/1.6 {SANS};color:{DIM};">You asked for this at biblelantern.com. One email a week, read and approved by Ji before it is sent. '
            f'<a href="{esc(unsub)}" style="color:{SOFT};">Unsubscribe</a> · <a href="{esc(site_link(site, path="/privacy"))}" style="color:{SOFT};">Privacy</a> · '
            f'<a href="{esc(site_link(site, path="/weeklydevotional"))}" style="color:{SOFT};">Read on the web</a></p>',
            f'<p style="margin:0 0 14px;font:400 12px/1.6 {SANS};color:{DIM};">{esc(BSB_CREDIT)} {esc(DORE_CREDIT)} The notes are the writer’s own and are not part of the text of Scripture.</p>']
    if postal:
        foot.append(f'<p style="margin:0;font:400 12px/1.6 {SANS};color:{DIM};">{esc(postal)}</p>')
    h.append(f'<tr><td style="padding:36px {PAD}px 30px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
             f'<tr><td style="border-top:1px solid {LINE};padding-top:20px;">{"".join(foot)}</td></tr></table></td></tr>')
    h.append("</table></td></tr></table></body></html>")
    return "".join(h), render_text(issue, site, postal, d, links, key_ref, companion, open_label, open_link)


def render_text(issue, site, postal, d, links, key_ref, companion, open_label, open_link):
    """The plain-text twin: the same order, verses as '> words' with '— Reference · BSB' lines."""
    week = issue["week"]
    counts = ((issue.get("source") or {}).get("counts")) or {}
    t = ["BIBLE LANTERN · Weekly devotional", week_label(week), "", title_text(d["title"]).upper(),
         f"{_plural(counts.get('chapters', 0), 'chapter')}, {_plural(counts.get('notes', 0), 'note')}, "
         f"{_plural(counts.get('links', 0), 'connection')}", ""]

    def verse(ref):
        w = _words_of(ref)
        return [f"> {w}", f"— {label_of(ref)} · {TRANSLATION}", f"  {verse_link(site, ref)}", ""] if w else []

    if d.get("opening"):
        t += [md_text(d["opening"]), ""]
    if key_ref:
        t += verse(key_ref)
    for i, s in enumerate(d.get("sections") or []):
        t += [f"{ROMAN[i] if i < len(ROMAN) else i + 1}. {s['heading']}", ""]
        for r in s.get("refs") or []:
            if r != key_ref:  # the key verse is quoted once, up top, as in the html
                t += verse(r)
        if s.get("body"):
            t += [md_text(s["body"]), ""]
        for q in s.get("quotes") or []:
            t += [f"My highlight: {md_text(q)}", ""]
    if links:
        t += ["This week's connections", ""]
        for ln in links:
            t.append(f"{ln['fromLabel']} -> {ln['toLabel']} ({ln['phrase']})" + (f": {md_text(ln['note'])}" if ln["note"] else ""))
        t.append("")
    t += ["For today", ""]
    if d.get("closing"):
        t += [md_text(d["closing"]), ""]
    if d.get("question"):
        t += [f"For your notes: {md_text(d['question'])}", ""]
    if companion:
        t += verse(companion)
    t += ["Amen.", "", "If you believe it, reply “Amen” and share this with someone who needs it.", "",
          f"Open {open_label} in Bible Lantern: {open_link}", "", "—",
          "You asked for this at biblelantern.com. One email a week, read and approved by Ji before it is sent.",
          f"Unsubscribe: {unsubscribe_url(site, UNSUB_PLACEHOLDER)}", f"Privacy: {site_link(site, path='/privacy')}",
          BSB_CREDIT, DORE_CREDIT]
    if postal:
        t.append(postal)
    return "\n".join(t) + "\n"


# ------------------------------------------------------------------ Resend

class ResendError(Exception):
    def __init__(self, status, body=""):
        super().__init__(f"resend {status}")
        self.status, self.body = status, body


class Resend:
    """The two Resend endpoints this module uses, with the base URL and key passed in (tests point it at a fake)."""

    def __init__(self, base_url, key, opener=None, sleep=time.sleep, timeout=30):
        self.base, self.key, self.sleep, self.timeout = base_url.rstrip("/"), key, sleep, timeout
        self.opener = opener or urllib.request.build_opener()

    def _post(self, path, payload, idempotency_key=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Authorization": "Bearer " + self.key, "Content-Type": "application/json", "User-Agent": "bible-lantern"}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        last = None
        for attempt in range(RESEND_TRIES):
            req = urllib.request.Request(self.base + path, data=body, method="POST", headers=headers)
            try:
                with self.opener.open(req, timeout=self.timeout) as r:
                    raw = r.read(1024 * 1024)
                try:
                    return json.loads(raw.decode("utf-8")) if raw.strip() else {}
                except ValueError:
                    return {}
            except urllib.error.HTTPError as e:
                status, wait = e.code, e.headers.get("retry-after") if e.headers else None
                last = ResendError(status, e.read(4096).decode("utf-8", "replace") if hasattr(e, "read") else "")
                if status == 429 or status >= 500:
                    if attempt + 1 < RESEND_TRIES:
                        self.sleep(float(wait) if wait and re.fullmatch(r"\d+(\.\d+)?", wait) else RESEND_PAUSE)
                    continue
                raise last
            except (urllib.error.URLError, OSError, ValueError) as e:
                last = ResendError(0, type(e).__name__)
                if attempt + 1 < RESEND_TRIES:
                    self.sleep(RESEND_PAUSE)
        raise last if last else ResendError(0, "unknown")

    def send(self, message, idempotency_key=None):
        return self._post("/emails", message, idempotency_key)

    def send_batch(self, messages, idempotency_key):
        return self._post("/emails/batch", messages, idempotency_key)


def batch_key(issue_id, emails):
    """The Idempotency-Key of one batch: the issue and the addresses, nothing else, so the same batch built again by
    a later run (after a crash between Resend's 2xx and the `done` write) carries the same key and Resend answers
    with the earlier result instead of sending twice."""
    digest = hashlib.sha256("\n".join(sorted(emails)).encode("utf-8")).hexdigest()
    return f"{issue_id}:{digest}"


def recipient_message(cfg, email, raw_token, subject, html_, text):
    site = cfg["site"].rstrip("/")
    msg = {"from": cfg["from"], "to": [email], "subject": subject, "html": personalise(html_, raw_token),
           "text": personalise(text, raw_token),
           "headers": {"List-Unsubscribe": f"<{unsubscribe_url(site, raw_token)}>",
                       "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"}}
    if cfg.get("reply_to"):
        msg["reply_to"] = cfg["reply_to"]
    return msg


def batch_messages(issue, recipients, cfg, size=BATCH_SIZE):
    """§4.5: recipients [(sid, email, raw_token)] -> [{"key": Idempotency-Key, "sids": [...], "messages": [...]}],
    at most `size` per batch, each message with its own unsubscribe link and List-Unsubscribe headers."""
    subject = (issue.get("draft") or {}).get("subject") or "Weekly devotional"
    html_, text = cfg.get("html", issue.get("html", "")), cfg.get("text", issue.get("text", ""))
    out = []
    for i in range(0, len(recipients), size):
        chunk = recipients[i:i + size]
        out.append({"key": batch_key(issue["id"], [e for _s, e, _t in chunk]), "sids": [s for s, _e, _t in chunk],
                    "messages": [recipient_message(cfg, e, t, subject, html_, text) for _s, e, t in chunk]})
    return out


# ------------------------------------------------------------------ mails to the reader and the author

def _simple_page(title, lines, links=()):
    body = "".join(f'<p style="margin:0 0 14px;font:400 17px/1.6 {SANS};color:{INK};">{x}</p>' for x in lines)
    btns = "".join(f'<p style="margin:0 0 12px;"><a href="{esc(u)}" style="display:inline-block;padding:11px 20px;border-radius:999px;'
                   f'background:{GOLD};color:{BG};text-decoration:none;font:600 15px/1 {SANS};">{esc(t)}</a></p>' for t, u in links)
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{esc(title)}</title></head>'
            f'<body style="margin:0;padding:0;background:#000000;color:{INK};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#000000;">'
            f'<tr><td align="center"><table role="presentation" width="{WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:{WIDTH}px;background:{BG};">'
            f'<tr><td style="padding:40px {PAD}px;"><h1 style="margin:0 0 16px;font:400 34px/1.1 {SERIF};color:{INK};">{esc(title)}</h1>{body}{btns}</td></tr>'
            f'</table></td></tr></table></body></html>')


def _mail(cfg, to, subject, html_, text):
    msg = {"from": cfg["from"], "to": [to], "subject": subject, "html": html_, "text": text}
    if cfg.get("reply_to"):
        msg["reply_to"] = cfg["reply_to"]
    return msg


def confirmation_mail(email, raw_token, cfg):
    site = cfg["site"].rstrip("/")
    url = f"{site}/api/devotional/confirm?t={raw_token}"
    html_ = _simple_page("Confirm your email", ["One week of close reading, every Sunday. Confirm your address and you are on the list.",
                                                "If you did not ask for this, ignore this email and nothing more will come."],
                         [("Confirm", url)])
    text = f"Confirm your email for the Bible Lantern weekly devotional:\n{url}\n\nIf you did not ask for this, ignore this email.\n"
    return _mail(cfg, email, "Confirm your email · Bible Lantern weekly devotional", html_, text)


def preview_mail(issue, review_raw, cfg, to):
    site = cfg["site"].rstrip("/")
    subject = (issue.get("draft") or {}).get("subject") or "Weekly devotional"
    if issue.get("status") == "empty":
        html_ = _simple_page("Nothing to send this week", [f"The week {esc(week_label(issue['week']))} had no notes, highlights, links or studies, so no devotional goes out."])
        return _mail(cfg, to, f"Review: nothing to send · {week_label(issue['week'])}", html_,
                     f"Nothing to send this week ({week_label(issue['week'])}).\n")
    url = f"{site}/api/devotional/review?t={review_raw}"
    top = (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{BAND};"><tr><td align="center">'
           f'<table role="presentation" width="{WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:{WIDTH}px;">'
           f'<tr><td style="padding:28px {PAD}px;font:400 17px/1.6 {SANS};color:{INK};">Your week is ready. Approve, skip or send yourself a test. '
           f'<a href="{esc(url)}" style="color:{GOLD};">Review this issue</a>'
           f'<p style="margin:14px 0 0;border-top:1px solid {LINE};"></p></td></tr></table></td></tr></table>')
    html_ = issue.get("html", "")
    i = html_.find("<body")
    j = html_.find(">", i) + 1 if i >= 0 else -1
    html_ = html_[:j] + top + html_[j:] if j > 0 else top + html_  # the note sits above the issue, inside <body>
    text =f"Your week is ready. Approve, skip or send yourself a test:\n{url}\n\n—\n\n" + issue.get("text", "")
    return _mail(cfg, to, f"Review: {subject}", personalise(html_, "preview"), personalise(text, "preview"))


def test_mail(issue, cfg, to):
    subject = (issue.get("draft") or {}).get("subject") or "Weekly devotional"
    return _mail(cfg, to, f"[test] {subject}", personalise(issue.get("html", ""), "test"), personalise(issue.get("text", ""), "test"))


def sent_mail(issue, n, cfg, to):
    label = week_label(issue["week"])
    html_ = _simple_page(f"Sent to {n} readers", [f"The devotional for {esc(label)} went out to {n} confirmed readers."])
    return _mail(cfg, to, f"Sent to {n} readers · {label}", html_, f"The devotional for {label} went out to {n} confirmed readers.\n")
