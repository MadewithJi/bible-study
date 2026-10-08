"""
accounts.py: profiles, sessions and per-scope storage for serve.py (standard library only).

Importing this module has no side effects. Call configure(data_dir, port, ...) first.

A "scope" is whose data a request acts on: "guest" (DATA/notes.json, DATA/guest-library.json, DATA/guest-links.json,
DATA/guest-marks.json) or a uid like "u3f9a0c1d2e4b5a69" (DATA/profiles/<uid>/notes.json, library.json, links.json,
marks.json). See .design/profiles-spec.md for the full contract, .design/links-spec.md for My links and
.design/annotations-brief.md for marks (highlights and comments). Hosted mode adds DATA/invites.json (sign-up invite
codes, stored hashed) and profile import from an export file: .design/hosting-brief.md §1.
"""
import base64, binascii, bisect, collections, copy, datetime, fcntl, hashlib, hmac, io, json, math, os, re
import secrets, shutil, sys, threading, time, unicodedata, zipfile
from contextlib import contextmanager

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "app")
META_PATH = os.path.join(APP, "data", "meta.json")

# ------------------------------------------------------------------ configuration (set by configure())
DATA = PROFILES = DELETED = USERS = SESSIONS = None
AUTH_LOCKFILE = SERVER_LOCKFILE = GUEST_NOTES = GUEST_LIBRARY = GUEST_LINKS = GUEST_MARKS = CONFIG = CACHE = None
INVITES = OWNER_CLAIMS = None
PORT = 8765
ALLOWED_HOSTS = ()
MAX_USERS = 50
COOKIE = "bs_sid_8765"


def configure(data_dir, port=8765, allowed_hosts=(), max_users=50):
    """Point the module at a data directory. Does not create anything on disk."""
    global DATA, PROFILES, DELETED, USERS, SESSIONS, AUTH_LOCKFILE, SERVER_LOCKFILE
    global GUEST_NOTES, GUEST_LIBRARY, GUEST_LINKS, GUEST_MARKS, CONFIG, CACHE, PORT, ALLOWED_HOSTS, MAX_USERS, COOKIE
    global INVITES, OWNER_CLAIMS
    DATA = os.path.realpath(os.path.expanduser(data_dir))
    PROFILES = os.path.join(DATA, "profiles")
    DELETED = os.path.join(DATA, "deleted")
    USERS = os.path.join(DATA, "users.json")
    SESSIONS = os.path.join(DATA, "sessions.json")
    AUTH_LOCKFILE = os.path.join(DATA, ".auth.lock")
    SERVER_LOCKFILE = os.path.join(DATA, ".server.lock")
    GUEST_NOTES = os.path.join(DATA, "notes.json")
    GUEST_LIBRARY = os.path.join(DATA, "guest-library.json")
    GUEST_LINKS = os.path.join(DATA, "guest-links.json")
    GUEST_MARKS = os.path.join(DATA, "guest-marks.json")
    CONFIG = os.path.join(DATA, "config.json")
    CACHE = os.path.join(DATA, "cache")
    INVITES = os.path.join(DATA, "invites.json")
    OWNER_CLAIMS = os.path.join(DATA, "owner-claims.json")
    PORT = int(port)
    ALLOWED_HOSTS = tuple(h.strip().lower() for h in (allowed_hosts or ()) if h and h.strip())
    MAX_USERS = int(max_users)
    COOKIE = f"bs_sid_{PORT}"


# ------------------------------------------------------------------ small helpers
def now_ms():
    return int(time.time() * 1000)


def stamp():
    return time.strftime("%Y%m%d-%H%M%S")


def _is_int(x):
    return isinstance(x, int) and not isinstance(x, bool)


def _is_num(x):
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return False
    return not isinstance(x, float) or math.isfinite(x)


def _as_int(x):
    """JSON number (not bool) -> int, else None."""
    return int(x) if _is_num(x) else None


def _safe_log_text(s, n=200):
    return re.sub(r"[^\x21-\x7e]", "?", str(s))[:n]


def log(event, uid=None, **kw):
    """One line per security event on stdout (routine information: a host reads stderr as errors). Never pass
    secrets, emails or bodies here."""
    parts = ["[auth]", time.strftime("%Y-%m-%dT%H:%M:%S"), event]
    if uid is not None:
        parts.append(f"uid={uid or 'unknown'}")
    for k, v in kw.items():
        parts.append(f"{k}={_safe_log_text(v)}")
    try:
        print(" ".join(parts), flush=True)
    except Exception:  # noqa: logging must never break a request
        pass


def log_error(text):
    """One '[error]' line on stderr: the only lines a host should treat as errors (a failed write, a traceback)."""
    try:
        print(f"[error] {time.strftime('%Y-%m-%dT%H:%M:%S')} {text}", file=sys.stderr, flush=True)
    except Exception:  # noqa
        pass


class ProfileGone(Exception):
    """The profile was deleted while a request for it was in flight."""


class Busy(Exception):
    """No password-hashing slot became free in time."""


# ------------------------------------------------------------------ Bible metadata (verse counts)
_META = None
_META_LOCK = threading.Lock()


def meta():
    global _META
    with _META_LOCK:
        if _META is None:
            with open(META_PATH, encoding="utf-8") as f:
                m = json.load(f)
            books = [b["name"] for b in m["books"]]
            verses = [[int(n) for n in b["chapters"]] for b in m["books"]]
            _META = {"books": books, "verses": verses, "total": sum(len(v) for v in verses),
                     "abbr": [(b.get("osis") or "", b.get("short") or "") for b in m["books"]]}
        return _META


def chapters_in(b):
    return len(meta()["verses"][b - 1])


def verses_in(b, c):
    return meta()["verses"][b - 1][c - 1]


# Canonical only: ASCII digits, no leading zeros. re.ASCII matters: without it \d also matches other scripts'
# digits ('4٣.3.16'), which int() reads as 43, so one verse could be stored under a second key.
REF_RE = re.compile(r"([1-9]\d?)\.([1-9]\d{0,2})(?:\.([1-9]\d{0,2}))?", re.ASCII)
_LOOSE_REF_RE = re.compile(r"(\d{1,3})\.(\d{1,3})(?:\.(\d{1,3}))?")  # repair only: any digits, leading zeros


def parse_ref(ref):
    """Canonical 'b.c' or 'b.c.v' -> (b, c, v) with v = 0 for a chapter; None when invalid, out of range or
    not canonical ('43.03.16' and '4٣.3.16' are refused, so one verse can never be stored under two keys)."""
    if not isinstance(ref, str):
        return None
    m = REF_RE.fullmatch(ref)
    if not m:
        return None
    b, c = int(m.group(1)), int(m.group(2))
    v = int(m.group(3)) if m.group(3) is not None else 0
    if not 1 <= b <= 66 or not 1 <= c <= chapters_in(b):
        return None
    if m.group(3) is not None and not 1 <= v <= verses_in(b, c):
        return None
    return b, c, v


def valid_ref(ref):
    return parse_ref(ref) is not None


def canonical_ref(ref):
    """Any spelling of a valid ref, leading zeros or non-ASCII digits allowed ('43.03.16', '4٣.3.16') -> its
    canonical key ('43.3.16'), else None. Only for repairing stored data; request input must already be canonical."""
    if not isinstance(ref, str):
        return None
    m = _LOOSE_REF_RE.fullmatch(ref)
    if not m:
        return None
    s = ".".join(str(int(g)) for g in m.groups() if g is not None)
    return s if parse_ref(s) else None


def _canon_key(k):
    """Stored key -> canonical key (fast path for keys that already are); unknown keys are kept as they are."""
    if not isinstance(k, str) or REF_RE.fullmatch(k):
        return k
    return canonical_ref(k) or k


MAX_FUTURE_MS = 5 * 60 * 1000  # a client clock may run a little ahead; later timestamps are clamped to now
MAX_SAFE_INT = 2 ** 53


def clamp_ts(x, now):
    """JSON timestamp -> int ms (a value more than 5 minutes in the future becomes `now`); None unless a number >= 0."""
    if not _is_num(x) or x < 0:
        return None
    return now if x > now + MAX_FUTURE_MS else int(x)


def valid_bc(b, c):
    return _is_int(b) and _is_int(c) and 1 <= b <= 66 and 1 <= c <= chapters_in(b)


DAY_RE = re.compile(r"\d{4}-\d{2}-\d{2}", re.ASCII)


def parse_day(s):
    if not isinstance(s, str) or not DAY_RE.fullmatch(s):
        return None
    try:
        return datetime.date.fromisoformat(s)
    except ValueError:
        return None


# ------------------------------------------------------------------ validation (§3.6)
EMAIL_RE = re.compile(r'[^@\s"<>\x00-\x1f\x7f]{1,64}@[a-z0-9.-]{1,189}\.[a-z0-9-]{2,63}')
COMMON_PASSWORDS = {
    "password", "password1", "password123", "passw0rd", "12345678", "123456789", "1234567890", "11111111",
    "00000000", "qwerty123", "qwertyuiop", "abcd1234", "iloveyou", "letmein1", "welcome1", "admin123",
    "trustno1", "baseball", "football", "sunshine", "princess", "jesus123", "jesuschrist", "godislove",
    "blessed1", "bible123", "faith123", "amazinggrace", "john3:16", "johnthreesixteen",
}
PASSWORD_MIN, PASSWORD_MAX, PASSWORD_MAX_BYTES = 8, 256, 1024
NAME_MAX, LABEL_MAX = 60, 80
MSG_EMAIL = "Enter an email address like name@example.com."
MSG_NAME = "Enter your name (up to 60 characters)."


def normalize_email(s):
    return s.strip().lower() if isinstance(s, str) else ""


def validate_email(s):
    e = normalize_email(s)
    if not e or len(e) > 254 or not EMAIL_RE.fullmatch(e):
        return False, None, "invalid_email"
    # No invisible characters (controls, zero-width and bidi format characters, surrogates, private-use or
    # unassigned code points): an address must look exactly like what was typed.
    if any(unicodedata.category(ch)[0] == "C" for ch in e):
        return False, None, "invalid_email"
    return True, e, None


# Bidi embedding, override and isolate controls: they can reorder how a name or label (and the text after it) is
# displayed. The marks U+200E/U+200F/U+061C and the joiners U+200C/U+200D are kept (needed by some scripts and emoji).
BIDI_CONTROLS = frozenset(chr(c) for c in list(range(0x202A, 0x202F)) + list(range(0x2066, 0x206A)))


def clean_text(s):
    """Display text (names, labels, activity words): whitespace of any kind (tab, newline) becomes one space; then
    remove C0/C1 control characters, lone surrogates and bidi embedding/override/isolate controls; collapse, strip.
    Everything else is kept verbatim, including < > & and quotes: the front end escapes every such string when it
    renders it (spec §5.16)."""
    s = re.sub(r"\s+", " ", s)  # first, so a pasted 'In the\nbeginning' keeps its word break
    s = "".join(ch for ch in s if not (ord(ch) < 32 or 127 <= ord(ch) <= 159 or 0xD800 <= ord(ch) <= 0xDFFF
                                          or ch in BIDI_CONTROLS))
    return re.sub(r"\s+", " ", s).strip()


def validate_name(s):
    if not isinstance(s, str):
        return False, None, "invalid_name"
    n = clean_text(s)
    if not 1 <= len(n) <= NAME_MAX:
        return False, None, "invalid_name"
    return True, n, None


def validate_label(s):
    if s is None:
        return True, "", None
    if not isinstance(s, str):
        return False, None, "invalid_label"
    n = clean_text(s)
    if len(n) > LABEL_MAX:
        return False, None, "invalid_label"
    return True, n, None


def validate_password(pw, email):
    if not isinstance(pw, str):
        return False, "weak_password", "Use at least 8 characters."
    p = unicodedata.normalize("NFKC", pw)
    if len(p) < PASSWORD_MIN:
        return False, "weak_password", "Use at least 8 characters."
    if len(p) > PASSWORD_MAX or len(p.encode("utf-8")) > PASSWORD_MAX_BYTES:
        return False, "weak_password", "Use at most 256 characters."
    if not p.strip():
        return False, "weak_password", "Your password can’t be only spaces."
    e = normalize_email(email)
    low = p.lower()
    if e and (low == e or low == e.split("@")[0]):
        return False, "weak_password", "Your password can’t be your email address."
    if low in COMMON_PASSWORDS:
        return False, "weak_password", "That password is too common. Try a longer phrase."
    return True, None, None


def initials(name):
    words = (name or "").split()
    if not words:
        return ""
    s = words[0][0] + (words[-1][0] if len(words) > 1 else "")
    return s.upper()


# ------------------------------------------------------------------ password hashing (§3.1)
PREFERRED = "scrypt" if hasattr(hashlib, "scrypt") else "pbkdf2_sha256"
PBKDF2_ITERS = 600_000
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 15, 8, 1
SCRYPT_MAXMEM = 64 * 1024 * 1024
HASH_SEM = threading.BoundedSemaphore(2)
DUMMY_HASH = None


def _pw_bytes(pw):
    return unicodedata.normalize("NFKC", pw).encode("utf-8")


def _b64(b):
    return base64.b64encode(b).decode("ascii")


def hash_password(pw, algo=None):
    algo = algo or PREFERRED
    salt = secrets.token_bytes(16)
    if algo == "scrypt":
        dk = hashlib.scrypt(_pw_bytes(pw), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32, maxmem=SCRYPT_MAXMEM)
        return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64(salt)}${_b64(dk)}"
    dk = hashlib.pbkdf2_hmac("sha256", _pw_bytes(pw), salt, PBKDF2_ITERS, dklen=32)
    return f"pbkdf2_sha256${PBKDF2_ITERS}${_b64(salt)}${_b64(dk)}"


def verify_password(pw, stored, uid=None):
    """Constant-time check. Unknown or malformed hashes (or scrypt without hashlib.scrypt) return False."""
    if not isinstance(pw, str) or not isinstance(stored, str):
        return False
    parts = stored.split("$")
    try:
        if parts[0] == "pbkdf2_sha256" and len(parts) == 4:
            iters = int(parts[1])
            salt = base64.b64decode(parts[2], validate=True)
            want = base64.b64decode(parts[3], validate=True)
            if not 1000 <= iters <= 10_000_000 or not 16 <= len(want) <= 64:
                raise ValueError("pbkdf2 params")
            got = hashlib.pbkdf2_hmac("sha256", _pw_bytes(pw), salt, iters, dklen=len(want))
            return hmac.compare_digest(got, want)
        if parts[0] == "scrypt" and len(parts) == 6:
            if not hasattr(hashlib, "scrypt"):
                raise ValueError("scrypt unavailable")
            n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
            salt = base64.b64decode(parts[4], validate=True)
            want = base64.b64decode(parts[5], validate=True)
            if n > 2 ** 20 or r > 32 or p > 16 or not 16 <= len(want) <= 64:
                raise ValueError("scrypt params")
            got = hashlib.scrypt(_pw_bytes(pw), salt=salt, n=n, r=r, p=p, dklen=len(want), maxmem=SCRYPT_MAXMEM * 4)
            return hmac.compare_digest(got, want)
    except (ValueError, TypeError, binascii.Error, OverflowError, MemoryError):
        pass
    log("hash-unsupported", uid or "unknown")
    return False


def needs_rehash(stored):
    if not isinstance(stored, str):
        return True
    if PREFERRED == "scrypt":
        return not stored.startswith(f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}$")
    return not stored.startswith(f"pbkdf2_sha256${PBKDF2_ITERS}$")


def init_dummy_hash():
    global DUMMY_HASH
    if DUMMY_HASH is None:
        DUMMY_HASH = hash_password(secrets.token_urlsafe(16))
    return DUMMY_HASH


@contextmanager
def hash_slot(timeout=10):
    """At most two concurrent hashes; raises Busy after `timeout` seconds."""
    if not HASH_SEM.acquire(timeout=timeout):
        raise Busy()
    try:
        yield
    finally:
        HASH_SEM.release()


# ------------------------------------------------------------------ files (§3.7)
def _tmp_path(path):
    return f"{path}.tmp-{os.getpid()}-{threading.get_ident()}"


def write_json_atomic(path, obj, indent=1):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    # allow_nan=False: NaN/Infinity are not JSON; written once, every later response for that file would be
    # unparseable in the browser. Raising here (a 500 for this one write) is better than storing it.
    data = json.dumps(obj, ensure_ascii=False, indent=indent, allow_nan=False).encode("utf-8")
    tmp = _tmp_path(path)
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _move_aside(path):
    dst = f"{path}.corrupt-{stamp()}"
    i = 1
    while os.path.exists(dst):
        i += 1
        dst = f"{path}.corrupt-{stamp()}-{i}"
    try:
        os.replace(path, dst)
    except OSError:
        pass
    log("corrupt-file", path=os.path.relpath(path, DATA) if DATA else os.path.basename(path))


SURROGATE_ESC_RE = re.compile(rb"\\u[dD][89a-fA-F]")


def _finite_or_none(s):
    x = float(s)
    return x if math.isfinite(x) else None


def _scrub_surrogates(x):
    """Lone surrogates (only a '\\ud800'-style escape can produce them) -> U+FFFD, in keys and values. Left in, they
    make every later encode of that document fail (a 500 on every read and write)."""
    if isinstance(x, str):
        return "".join("\ufffd" if 0xD800 <= ord(ch) <= 0xDFFF else ch for ch in x) if not x.isascii() else x
    if isinstance(x, list):
        return [_scrub_surrogates(v) for v in x]
    if isinstance(x, dict):
        return {_scrub_surrogates(k): _scrub_surrogates(v) for k, v in x.items()}
    return x


def read_json_strict(path, default, expect=dict):
    """Missing -> a copy of default. Unparseable (or not `expect`) -> moved to <file>.corrupt-<ts>, default returned.
    Values JSON cannot carry are repaired, not fatal: NaN/Infinity (and 1e999) read as null, lone surrogates as U+FFFD,
    so a hand-edited or damaged file can never make its endpoints answer invalid JSON or fail with 500s."""
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except FileNotFoundError:
        return copy.deepcopy(default)
    try:
        obj = json.loads(raw.decode("utf-8"), parse_constant=lambda _name: None, parse_float=_finite_or_none)
        if expect is not None and not isinstance(obj, expect):
            raise ValueError("unexpected top-level type")
        return _scrub_surrogates(obj) if SURROGATE_ESC_RE.search(raw) else obj
    except (ValueError, UnicodeDecodeError, RecursionError):
        _move_aside(path)
        return copy.deepcopy(default)


def _daily_backup(path):
    """Before overwriting notes.json / links.json / marks.json / library.json / users.json: copy it to <file>.bak (0600)
    once a day."""
    if not os.path.exists(path):
        return
    bak = path + ".bak"
    try:
        if os.path.exists(bak) and time.time() - os.path.getmtime(bak) < 86400:
            return
        tmp = _tmp_path(bak)
        try:
            shutil.copyfile(path, tmp)
            os.chmod(tmp, 0o600)
            os.replace(tmp, bak)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except OSError:
        pass


TMP_RE = re.compile(r".+\.tmp-\d+-\d+", re.ASCII)


def remove_stale_tmp_files():
    """Delete '<file>.tmp-<pid>-<tid>' files that a crash (SIGKILL, power loss) left behind mid-write.
    Only call at startup while holding .server.lock and the auth lock, so no writer can be active. -> count."""
    n = 0
    for root, dirs, files in os.walk(DATA):
        for fn in files:
            if TMP_RE.fullmatch(fn):
                try:
                    os.unlink(os.path.join(root, fn))
                    n += 1
                except OSError:
                    pass
    return n


# ------------------------------------------------------------------ locks (§3.7)
_AUTH_RLOCK = threading.RLock()
_auth_state = {"depth": 0, "fd": None}
_SCOPE_LOCKS = {}
_SCOPE_GUARD = threading.Lock()
DELETED_UIDS = set()


@contextmanager
def auth_lock():
    """Process RLock plus fcntl.flock on DATA/.auth.lock (so the CLI and the server serialise)."""
    with _AUTH_RLOCK:
        if _auth_state["depth"] == 0:
            os.makedirs(DATA, exist_ok=True)
            fd = os.open(AUTH_LOCKFILE, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
            except BaseException:
                os.close(fd)
                raise
            _auth_state["fd"] = fd
        _auth_state["depth"] += 1
        try:
            yield
        finally:
            _auth_state["depth"] -= 1
            if _auth_state["depth"] == 0:
                fd = _auth_state["fd"]
                _auth_state["fd"] = None
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                finally:
                    os.close(fd)


def lock_for(scope):
    """The scope lock. One lock covers all of a scope's files: notes.json, links.json, marks.json and library.json.

    Lock order (links-spec §2, annotations brief §1): links file -> marks file -> library file. POST
    /api/links/changes and POST /api/marks/changes each write their own file and then library.json (a new link or
    mark adds `link.add` / `mark.add` activity and studied verses), under this one lock; sign-up with import and
    guest import save links.json, then marks.json, then library.json. No code path takes them in another order, so
    if these files ever get locks of their own, take the links lock, then the marks lock, then the library lock.
    (Guest -> profile import takes the guest scope lock before the profile's, §2.6.)"""
    with _SCOPE_GUARD:
        lk = _SCOPE_LOCKS.get(scope)
        if lk is None:
            lk = _SCOPE_LOCKS[scope] = threading.Lock()
        return lk


# ------------------------------------------------------------------ users and sessions
UID_RE = re.compile(r"u[0-9a-f]{16}")
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{43}")
BOOKMARK_ID_RE = re.compile(r"bm_[0-9a-f]{12}")
BATCH_RE = re.compile(r"[A-Za-z0-9_-]{8,64}")
STRONG_RE = re.compile(r"[HG]\d{1,4}[a-z]?", re.ASCII)
TR_RE = re.compile(r"[a-z0-9]{2,8}")

DAY_MS = 86400 * 1000
IDLE_MS = {True: 30 * DAY_MS, False: 12 * 3600 * 1000}
HARD_MS = {True: 180 * DAY_MS, False: 7 * DAY_MS}
SLIDE_AFTER_MS = 10 * 60 * 1000
MAX_SESSIONS_PER_USER = 20
REMEMBER_MAX_AGE = 30 * 86400


def valid_uid(uid):
    return isinstance(uid, str) and bool(UID_RE.fullmatch(uid))


def new_uid():
    return "u" + secrets.token_hex(8)


def new_token():
    return secrets.token_urlsafe(32)


def token_key(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def _normalize_user(uid, rec):
    """Repair one users.json record so a hand edit or a bad write cannot turn every auth request into a 500:
    the uid is the key, email/name are strings, counters and timestamps are ints."""
    u = dict(rec)
    u["uid"] = uid
    u["email"] = normalize_email(u.get("email"))
    if not isinstance(u.get("name"), str):
        u["name"] = ""
    f = _as_int(u.get("failedLogins"))
    u["failedLogins"] = f if f is not None and f >= 0 else 0
    lk = _as_int(u.get("lockUntil"))
    u["lockUntil"] = min(lk, now_ms() + 900 * 1000) if lk is not None and lk > 0 else 0  # never longer than the policy cap
    lf = _as_int(u.get("lastFail"))
    u["lastFail"] = lf if lf is not None and lf > 0 else 0
    for k in ("created", "updated", "lastLogin", "pwChanged"):
        if k in u:
            u[k] = _as_int(u[k])
    return u


def load_users():
    u = read_json_strict(USERS, {"version": 1, "users": {}})
    if not isinstance(u.get("users"), dict):
        _move_aside(USERS)
        u = {"version": 1, "users": {}}
    u.setdefault("version", 1)
    # Only well-formed uids are ever used as profile names.
    u["users"] = {k: _normalize_user(k, v) for k, v in u["users"].items() if valid_uid(k) and isinstance(v, dict)}
    return u


def save_users(obj):
    _daily_backup(USERS)
    write_json_atomic(USERS, obj)


def registry_problem():
    """None when users.json can be trusted. 'damaged' when it was moved aside as corrupt (users.json.corrupt-*) and
    nothing has replaced it; 'missing' when it is gone while a profile folder still names its owner
    (profiles/<uid>/user.json). Signing up again in either state would split a person from their data (§1.7)."""
    if os.path.exists(USERS):
        return None
    try:
        if any(n.startswith("users.json.corrupt-") for n in os.listdir(DATA)):
            return "damaged"
        for d in os.listdir(PROFILES):
            if valid_uid(d) and os.path.isfile(os.path.join(PROFILES, d, "user.json")):
                return "missing"
    except OSError:
        pass
    return None


def _read_quiet(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError, RecursionError):
        return None


def orphaned_profile(users, email):
    """uid of a profile folder whose owner file names `email` but that users.json does not list (for example after
    users.json was restored from an older .bak), else None."""
    try:
        names = os.listdir(PROFILES)
    except OSError:
        return None
    for d in names:
        if valid_uid(d) and d not in users["users"]:
            rec = _read_quiet(os.path.join(PROFILES, d, "user.json"))
            if isinstance(rec, dict) and normalize_email(rec.get("email")) == email:
                return d
    return None


def owner_path(uid):
    return os.path.join(profile_dir(uid), "user.json")


def write_profile_owner(user, only_if_missing=False):
    """profiles/<uid>/user.json = who owns this folder (uid, email, name, created; never the password hash), so a
    profile can be matched to its owner even if users.json is lost. Takes lock_for(uid)."""
    uid = user["uid"]
    with lock_for(uid):
        path = owner_path(uid)
        if only_if_missing and os.path.exists(path):
            return
        _prepare_write(uid)
        write_json_atomic(path, {k: user.get(k) for k in ("uid", "email", "name", "created")})


def load_sessions():
    s = read_json_strict(SESSIONS, {"version": 1, "sessions": {}})
    if not isinstance(s.get("sessions"), dict):
        _move_aside(SESSIONS)
        s = {"version": 1, "sessions": {}}
    s.setdefault("version", 1)
    # A malformed record is dropped (that browser is signed out); a malformed lastSeen is repaired.
    s["sessions"] = {k: r for k, r in s["sessions"].items() if isinstance(r, dict)}
    for r in s["sessions"].values():
        if not _is_int(r.get("lastSeen")):
            r["lastSeen"] = _as_int(r.get("lastSeen")) or 0
    return s


def save_sessions(obj):
    write_json_atomic(SESSIONS, obj)


def find_user_by_email(users, email):
    email = normalize_email(email)
    if not email:
        return None
    for u in users["users"].values():
        if u.get("email") == email:
            return u
    return None


def public_user(u):
    return {"uid": u["uid"], "email": u.get("email", ""), "name": u.get("name", ""), "initials": initials(u.get("name", "")),
            "created": u.get("created"), "lastLogin": u.get("lastLogin")}


def _session_live(rec, now):
    return (isinstance(rec, dict) and _is_int(rec.get("expires")) and _is_int(rec.get("hardExpires"))
            and now <= rec["expires"] and now <= rec["hardExpires"])


def purge_sessions(sess, now=None, users=None):
    now = now or now_ms()
    dead = [k for k, r in sess["sessions"].items()
            if not _session_live(r, now) or (users is not None and r.get("uid") not in users["users"])]
    for k in dead:
        del sess["sessions"][k]
    return len(dead)


def purge_expired_sessions():
    """Startup purge. Only expired records go: a session whose uid is missing from users.json stays (it is inert,
    resolve_session refuses it) so a damaged users.json cannot also sign everyone out for good."""
    with auth_lock():
        s = load_sessions()
        if purge_sessions(s):
            save_sessions(s)


def create_session(uid, remember, ua="", now=None):
    """-> (raw token, session record + 'key'). Only the sha256 of the token is stored."""
    now = now or now_ms()
    remember = bool(remember)
    with auth_lock():
        s = load_sessions()
        purge_sessions(s, now)  # expired only (see purge_expired_sessions)
        mine = sorted(((r.get("lastSeen", 0), k) for k, r in s["sessions"].items() if r.get("uid") == uid))
        while len(mine) >= MAX_SESSIONS_PER_USER:
            del s["sessions"][mine.pop(0)[1]]
        token = new_token()
        key = token_key(token)
        hard = now + HARD_MS[remember]
        rec = {"uid": uid, "created": now, "lastSeen": now, "expires": min(now + IDLE_MS[remember], hard),
               "hardExpires": hard, "remember": remember, "ua": clean_text(str(ua or ""))[:120]}
        s["sessions"][key] = rec
        save_sessions(s)
    return token, dict(rec, key=key, slid=False)


def resolve_session(token, now=None):
    """-> (uid, session record + 'key' + 'slid') or None. Slides the idle expiry every 10 minutes."""
    if not isinstance(token, str) or not TOKEN_RE.fullmatch(token):
        return None
    now = now or now_ms()
    key = token_key(token)
    with auth_lock():
        s = load_sessions()
        rec = s["sessions"].get(key)
        if not isinstance(rec, dict):
            return None
        if not _session_live(rec, now):
            del s["sessions"][key]
            save_sessions(s)
            return None
        uid = rec.get("uid")
        if not valid_uid(uid) or uid not in load_users()["users"]:
            return None
        slid = False
        if now - int(rec.get("lastSeen", 0)) > SLIDE_AFTER_MS:
            rec["lastSeen"] = now
            rec["expires"] = min(now + IDLE_MS[bool(rec.get("remember"))], rec["hardExpires"])
            save_sessions(s)
            slid = True
        return uid, dict(rec, key=key, slid=slid)


def revoke_session(key):
    with auth_lock():
        s = load_sessions()
        if key in s["sessions"]:
            del s["sessions"][key]
            save_sessions(s)
            return 1
    return 0


def revoke_sessions(uid, keep_key=None):
    with auth_lock():
        s = load_sessions()
        dead = [k for k, r in s["sessions"].items() if isinstance(r, dict) and r.get("uid") == uid and k != keep_key]
        for k in dead:
            del s["sessions"][k]
        if dead:
            save_sessions(s)
        return len(dead)


LOCK_MAX = 900  # the longest lockout; the hosted server lowers it (serve.configure_hosting), where a lock is per client


def lock_seconds(f):
    return 0 if f < 5 else min(LOCK_MAX, 2 ** (f - 5))


# ------------------------------------------------------------------ invites (hosting brief §1)
# Hosted sign-up is by invite. DATA/invites.json is {SHA-256 of the code: {id, last4, created, by, uses, maxUses, note,
# revoked}}: the plain code is shown once, when it is made, and never stored. The users.json rules apply: read and
# written under auth_lock(), a daily invites.json.bak, and an unreadable file is moved aside (invites.json.corrupt-<ts>).
INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O or 1/I/L to misread
INVITE_LEN = 10
INVITE_ID_RE = re.compile(r"iv_[0-9a-f]{12}", re.ASCII)
INVITE_KEY_RE = re.compile(r"[0-9a-f]{64}", re.ASCII)
INVITE_MAX_USES = 100
MAX_INVITES = 500


def new_invite_code():
    return "".join(secrets.choice(INVITE_ALPHABET) for _ in range(INVITE_LEN))


def normalize_invite(s):
    """What someone typed -> the code ('abcde-fghjk ' -> 'ABCDEFGHJK'), or None when it cannot be one."""
    if not isinstance(s, str) or len(s) > 40:
        return None
    code = re.sub(r"[\s-]+", "", s).upper()
    return code if len(code) == INVITE_LEN and all(ch in INVITE_ALPHABET for ch in code) else None


def invite_key(code):
    return hashlib.sha256(code.encode("ascii")).hexdigest()


def _norm_invite(rec):
    if not isinstance(rec, dict) or not isinstance(rec.get("id"), str) or not INVITE_ID_RE.fullmatch(rec["id"]):
        return None
    mu = _as_int(rec.get("maxUses"))
    return dict(rec, last4=rec["last4"] if isinstance(rec.get("last4"), str) and len(rec["last4"]) == 4 else "????",
                created=_nonneg_int(rec.get("created")), uses=_nonneg_int(rec.get("uses")),
                maxUses=mu if mu is not None and 1 <= mu <= INVITE_MAX_USES else 1,
                note=rec["note"] if isinstance(rec.get("note"), str) else "", revoked=rec.get("revoked") is True)


def load_invites():
    """-> {key: record}. Call under auth_lock(). A malformed entry is dropped (that code stops working)."""
    d = read_json_strict(INVITES, {})
    out = {}
    for k, v in d.items():
        rec = _norm_invite(v) if isinstance(k, str) and INVITE_KEY_RE.fullmatch(k) else None
        if rec is not None:
            out[k] = rec
    return out


def save_invites(invites):
    _daily_backup(INVITES)
    write_json_atomic(INVITES, invites)


def invite_usable(rec):
    return bool(rec) and not rec["revoked"] and rec["uses"] < rec["maxUses"]


def public_invite(rec):
    """What an owner sees of an invite: never the code (it is not kept) or its hash."""
    return {k: rec[k] for k in ("id", "last4", "created", "uses", "maxUses", "note", "revoked")}


# ------------------------------------------------------------------ owner claims (hosting; QC 0)
# An address in BS_OWNER_EMAILS may sign up without an invite only until a profile has claimed it: DATA/owner-claims.json
# is {SHA-256 of the email: {uid, claimed}}, kept for good (a delete or an email change must not reopen the address to a
# stranger). The users.json rules apply: read and written under auth_lock(), a daily .bak, an unreadable file moved aside.
def claim_key(email):
    return hashlib.sha256(email.encode("utf-8")).hexdigest()


def load_owner_claims():
    d = read_json_strict(OWNER_CLAIMS, {})
    return {k: v for k, v in d.items() if isinstance(k, str) and INVITE_KEY_RE.fullmatch(k) and isinstance(v, dict)}


def save_owner_claims(claims):
    _daily_backup(OWNER_CLAIMS)
    write_json_atomic(OWNER_CLAIMS, claims)


# ------------------------------------------------------------------ scope paths
def profile_dir(uid):
    if not valid_uid(uid):
        raise ValueError("invalid uid")
    p = os.path.join(PROFILES, uid)
    base = os.path.realpath(PROFILES) + os.sep
    if not os.path.realpath(p).startswith(base):
        raise ValueError("profile path escapes DATA/profiles")
    return p


def notes_path(scope):
    return GUEST_NOTES if scope == "guest" else os.path.join(profile_dir(scope), "notes.json")


def library_path(scope):
    return GUEST_LIBRARY if scope == "guest" else os.path.join(profile_dir(scope), "library.json")


def links_path(scope):
    return GUEST_LINKS if scope == "guest" else os.path.join(profile_dir(scope), "links.json")


def marks_path(scope):
    return GUEST_MARKS if scope == "guest" else os.path.join(profile_dir(scope), "marks.json")


def _prepare_write(scope):
    if scope == "guest":
        os.makedirs(DATA, exist_ok=True)
        return
    if scope in DELETED_UIDS:
        raise ProfileGone(scope)
    os.makedirs(profile_dir(scope), mode=0o700, exist_ok=True)


# ------------------------------------------------------------------ notes (§1.4, §2.4)
HIGHLIGHTS = {"", "yellow", "green", "blue", "pink", "orange"}
TOMBSTONE_MAX, TOMBSTONE_DAYS = 2000, 180
MAX_REFS = 50_000
NOTE_MAX_BYTES = 256 * 1024


def empty_notes():
    return {"refs": {}, "studies": [], "rev": 0, "deleted": {}}


def load_notes(scope):
    path = notes_path(scope)
    n = read_json_strict(path, empty_notes())
    if "refs" in n and not isinstance(n["refs"], dict):
        _move_aside(path)  # nothing to salvage in place; the file is kept as <file>.corrupt-<ts>
        n = empty_notes()
    n.setdefault("refs", {})
    if not isinstance(n.get("studies"), list):
        n["studies"] = []  # a wrongly typed `studies` must not hide every note (the client never fills it)
    if not (_is_int(n.get("rev")) and n["rev"] >= 0):
        n["rev"] = 0
    if not isinstance(n.get("deleted"), dict):
        n["deleted"] = {}
    try:
        cap = min(now_ms(), int(os.stat(path).st_mtime * 1000))
    except OSError:
        cap = now_ms()
    _repair_notes(n, cap)
    return n


def _repair_notes(n, cap):
    """Load-time repairs, persisted by the next save.

    - Keys spelled with leading zeros ('43.03.16', only ever written by old or buggy clients) fold into the
      canonical key; when both exist the newer note wins.
    - A note `updated`/`created` or a tombstone more than 5 minutes after `cap` (the time the file was written,
      never later than now) is impossible, so it becomes `cap`: one bad clock can no longer freeze a note or
      block a ref forever. `cap` is stable until the next write, so a client's compare-and-set base still matches."""
    limit = cap + MAX_FUTURE_MS
    refs = {}
    for k, note in n["refs"].items():
        ck = _canon_key(k)
        if isinstance(note, dict):
            fix = {f: cap for f in ("updated", "created") if _is_num(note.get(f)) and note[f] > limit}
            if fix:
                note = dict(note, **fix)
        if ck in refs:
            a, b = _note_updated(note), _note_updated(refs[ck])
            if a > b or (a == b and k == ck):
                refs[ck] = note
        else:
            refs[ck] = note
    n["refs"] = refs
    deleted = {}
    for k, ts in n["deleted"].items():
        ck = _canon_key(k)
        if _is_num(ts):
            ts = cap if ts > limit else int(ts)
            prev = deleted.get(ck)
            deleted[ck] = max(ts, prev) if _is_int(prev) else ts
        elif ck not in deleted:
            deleted[ck] = ts  # not a number: prune_tombstones drops it on the next save
    n["deleted"] = deleted


def prune_tombstones(deleted, now=None):
    now = now or now_ms()
    cutoff = now - TOMBSTONE_DAYS * DAY_MS
    items = [(k, v) for k, v in deleted.items() if _is_int(v) and v >= cutoff]
    items.sort(key=lambda kv: kv[1], reverse=True)
    return dict(items[:TOMBSTONE_MAX])


def save_notes(scope, obj):
    _prepare_write(scope)
    obj["deleted"] = prune_tombstones(obj.get("deleted") or {})
    path = notes_path(scope)
    _daily_backup(path)
    write_json_atomic(path, obj)


def _note_updated(n):
    u = n.get("updated") if isinstance(n, dict) else None
    return int(u) if _is_num(u) else 0


def clean_note(note, now=None):
    """Validate one incoming note (§1.4). Unknown fields are preserved. -> dict or None."""
    now = now or now_ms()
    if not isinstance(note, dict):
        return None
    out = dict(note)
    text = note.get("text")
    if text is None:
        text = ""
    if not isinstance(text, str) or len(text) > 100_000:
        return None
    hl = note.get("highlight")
    if hl is None:
        hl = ""
    if hl not in HIGHLIGHTS:
        return None
    tags = note.get("tags")
    if tags is None:
        tags = []
    if not isinstance(tags, list) or len(tags) > 50 or any(not isinstance(t, str) or len(t) > 64 for t in tags):
        return None
    vids = note.get("videos")
    if vids is None:
        vids = []
    if not isinstance(vids, list) or len(vids) > 100:
        return None
    clean_vids = []
    for v in vids:
        if not isinstance(v, dict):
            return None
        cv = dict(v)
        if not isinstance(v.get("url"), str) or len(v["url"]) > 2048:
            return None
        if "id" in v and v["id"] is not None and (not isinstance(v["id"], str) or len(v["id"]) > 64):
            return None
        if "start" in v and v["start"] is not None:
            if not _is_num(v["start"]) or not 0 <= v["start"] <= MAX_SAFE_INT:
                return None
            cv["start"] = int(v["start"])
        if "title" in v and v["title"] is not None and (not isinstance(v["title"], str) or len(v["title"]) > 300):
            return None
        if "added" in v and v["added"] is not None:
            if not _is_num(v["added"]):
                return None
            cv["added"] = clamp_ts(v["added"], now) or 0
        clean_vids.append(cv)
    # Timestamps more than 5 minutes ahead of the server clock are clamped to now (as tracker events are): a note
    # saved once with a wrong clock would otherwise win every later comparison and could never be edited again.
    upd = now if note.get("updated") is None else clamp_ts(note.get("updated"), now)
    if upd is None:
        return None
    created = upd if note.get("created") is None else clamp_ts(note.get("created"), now)
    if created is None:
        return None
    out.update(text=text, highlight=hl, tags=list(tags), videos=clean_vids, created=created, updated=upd)
    if len(json.dumps(out, ensure_ascii=False).encode("utf-8")) > NOTE_MAX_BYTES:
        return None
    return out


def _base_mismatch(cur, b):
    """Compare-and-set check: b is the `updated` the client last saw for this key, or None for 'no note'."""
    return (cur is None) != (b is None) or (cur is not None and _note_updated(cur) != b)


def _is_retry(cur, inc, b):
    """True when `inc` (sent with base b) is a repeat of the write that produced the stored note `cur`: identical, or
    identical except for the `updated` the server moved forward to b + 1 (a client whose clock was behind)."""
    if cur is None or not isinstance(cur, dict):
        return False
    if cur == inc:
        return True
    return (b is not None and _note_updated(cur) == b + 1 and _note_updated(inc) <= b
            and dict(inc, updated=cur.get("updated")) == cur)


def _apply_changes(refs, deleted, set_map, del_map, base=None):
    """The per-key merge shared by notes, links and marks (§2.4). Mutates `refs` (key -> record with `updated`) and
    `deleted` (key -> tombstone ms). -> (changed, conflicts).

    conflicts[key] is the stored record (or None when the stored state is 'deleted').

    With `base` ({key: updated-the-client-last-saw | None}) a key is compare-and-set: the write applies only when
    the stored record is still the version the client started from, so a tab holding an old copy can never silently
    replace a newer edit, whatever its clock says. A repeat of a write that already landed is not a conflict.
    Keys without a base keep plain last-writer-wins on `updated` (older clients)."""
    base = base or {}
    changed, conflicts = False, {}
    for k, inc in set_map.items():
        cur = refs.get(k)
        if k in base:
            if _is_retry(cur, inc, base[k]):
                continue  # a retry of a write that already landed
            if _base_mismatch(cur, base[k]):
                conflicts[k] = cur
                continue
            if cur is not None and _note_updated(inc) <= _note_updated(cur):
                inc = dict(inc, updated=_note_updated(cur) + 1)  # the version must move forward (see `versions`)
        else:
            iu = _note_updated(inc)
            if cur is not None:
                if _note_updated(cur) > iu:
                    conflicts[k] = cur
                    continue
            elif _is_int(deleted.get(k)) and deleted[k] > iu:
                conflicts[k] = None  # deleted in another window after this edit
                continue
        if cur != inc:
            refs[k] = inc
            changed = True
        if k in deleted:
            del deleted[k]
            changed = True
    for k, ts in del_map.items():
        cur = refs.get(k)
        prev = deleted.get(k) if _is_int(deleted.get(k)) else 0
        if cur is None:
            if ts > prev:
                deleted[k] = ts
                changed = True
        elif k in base:
            if _base_mismatch(cur, base[k]):
                conflicts[k] = cur  # edited (or re-created) in another window since this client loaded it
                continue
            del refs[k]
            deleted[k] = max(prev, ts, _note_updated(cur))
            changed = True
        elif _note_updated(cur) <= ts:
            del refs[k]
            deleted[k] = max(prev, ts)
            changed = True
        else:
            conflicts[k] = cur
    return changed, conflicts


def apply_note_changes(notes, set_map, del_map, base=None):
    """Per-key merge of notes (§2.4; see _apply_changes). Mutates `notes`. -> (changed, conflicts)."""
    return _apply_changes(notes.setdefault("refs", {}), notes.setdefault("deleted", {}), set_map, del_map, base)


def _versions(refs, keys, conflicts):
    return {k: (_note_updated(refs[k]) if k in refs else None) for k in keys if k not in conflicts}


def note_versions(notes, keys, conflicts):
    """{key: stored updated | None when deleted} for the keys of a request that did not conflict: the base the
    client should send next time for each key."""
    return _versions(notes.get("refs") or {}, keys, conflicts)


def _merge_keyed(drefs, dtomb, srefs, room=None):
    """Guest -> profile merge of keyed records (§1.8), shared by notes, links and marks: take the guest record when
    the profile has none and no tombstone at or after it, or when the guest's is newer. Mutates drefs/dtomb.
    `room` caps how many new keys may be added. -> the keys taken."""
    taken = []
    for k, sn in (srefs or {}).items():
        if not isinstance(sn, dict):
            continue
        su = _note_updated(sn)
        dn = drefs.get(k)
        if dn is None:
            if _is_int(dtomb.get(k)) and dtomb[k] >= su:
                continue
            if room is not None:
                if room <= 0:
                    continue
                room -= 1
        elif not su > _note_updated(dn):
            continue
        drefs[k] = copy.deepcopy(sn)
        dtomb.pop(k, None)
        taken.append(k)
    return taken


def merge_notes(dst, src, room=None):
    """Guest -> profile merge (§1.8). Mutates dst. `room` caps the new refs (a profile import stops at MAX_REFS).
    -> number of refs taken from src."""
    return len(_merge_keyed(dst.setdefault("refs", {}), dst.setdefault("deleted", {}), src.get("refs") or {}, room))


# ------------------------------------------------------------------ links (links-spec §1, §2)
LINK_ID_RE = re.compile(r"ln_[0-9a-f]{12}", re.ASCII)
LINK_REF_RE = re.compile(r"(\d{1,2})\.(\d{1,3})\.(\d{1,3})(?:-(\d{1,3}))?", re.ASCII)
# type -> (forward phrase: the `from` side, reverse: the `to` side, symmetric: both sides of a dir "both" link).
# `custom` uses its label on every side.
LINK_TYPES = {
    "related": ("is linked to", "is linked to", "is linked to"),
    "fulfils": ("fulfils", "is fulfilled in", "fulfils / is fulfilled in"),
    "echoes": ("echoes", "is echoed in", "echoes"),
    "parallels": ("parallels", "parallels", "parallels"),
    "contrasts": ("contrasts with", "contrasts with", "contrasts with"),
    "explains": ("explains", "is explained by", "explains"),
    "quotes": ("quotes", "is quoted in", "quotes"),
    "same-word": ("shares a word with", "shares a word with", "shares a word with"),
    "theme": ("shares a theme with", "shares a theme with", "shares a theme with"),
    "custom": None,
}
LINK_BOTH_BY_DEFAULT = {"related", "parallels", "contrasts", "same-word", "theme"}
MAX_LINKS = 10_000
LINK_MAX_BYTES = 32 * 1024
LINK_LABEL_MAX, LINK_NOTE_MAX, LINK_TAGS_MAX, LINK_TAG_MAX = 40, 20_000, 20, 40


def parse_link_ref(s):
    """'b.c.v' or a same-chapter range 'b.c.v-ve' (ASCII digits) -> (b, c, v, ve), ve = v for one verse; None when
    it is not that shape, not in this Bible (meta.json) or ve < v. Leading zeros are read, never stored."""
    if not isinstance(s, str):
        return None
    m = LINK_REF_RE.fullmatch(s)
    if not m:
        return None
    b, c, v = int(m.group(1)), int(m.group(2)), int(m.group(3))
    ve = v if m.group(4) is None else int(m.group(4))
    if not 1 <= b <= 66 or not 1 <= c <= chapters_in(b):
        return None
    n = verses_in(b, c)
    if not 1 <= v <= n or not v <= ve <= n:
        return None
    return b, c, v, ve


def link_ref_str(b, c, v, ve=None):
    """Canonical form: no leading zeros, and '-ve' only for a real range."""
    return f"{b}.{c}.{v}" + (f"-{ve}" if ve and ve != v else "")


def _clean_short(s):
    """clean_text, with a fast path for text it would return unchanged (printable: no controls, bidi controls,
    surrogates or odd whitespace; no runs of spaces): loading 10,000 links cleans every label and tag again."""
    return s if s.isprintable() and "  " not in s and s == s.strip() else clean_text(s)


def _tag_char_ok(ch):
    return ch in " -_" or unicodedata.category(ch)[0] in "LM" or unicodedata.category(ch) == "Nd"


def _clean_tag(t):
    """One link tag -> its stored form (cleaned, NFC, lower case); raises ValueError naming the problem."""
    if not isinstance(t, str):
        raise ValueError("Each tag must be text.")
    t = unicodedata.normalize("NFC", _clean_short(t)).lower()
    if not 1 <= len(t) <= LINK_TAG_MAX:
        raise ValueError(f"Tags can be 1–{LINK_TAG_MAX} characters.")
    if not all(map(_tag_char_ok, t)):
        raise ValueError("Tags can use letters, digits, spaces, “-” and “_”.")
    return t


def clean_link(raw, now=None, check_size=True):
    """Validate one incoming link (links-spec §1.2). -> a new dict with exactly the link fields, canonical refs and
    defaults filled in; raises ValueError(message naming the problem). Unknown fields are dropped (links have no
    legacy shape). Timestamps more than 5 minutes ahead of `now` become `now` (the notes clock guard, PS §1.4).
    check_size=False skips the 32 KiB and note-length checks (load-time repair: never lose a stored note)."""
    now = now or now_ms()
    if not isinstance(raw, dict):
        raise ValueError("A link must be an object.")
    lid = raw.get("id")
    if not isinstance(lid, str) or not LINK_ID_RE.fullmatch(lid):
        raise ValueError("A link id is “ln_” followed by 12 hex digits.")
    ends = {}
    for f in ("from", "to"):
        p = parse_link_ref(raw.get(f))
        if p is None:
            raise ValueError(f"“{f}” must be a verse in this Bible, like 43.1.29, or a range in one chapter, like 43.1.29-31.")
        ends[f] = link_ref_str(*p)
    if ends["from"] == ends["to"]:
        raise ValueError("A verse can’t link to itself.")
    typ = "related" if raw.get("type") is None else raw["type"]
    if not isinstance(typ, str) or typ not in LINK_TYPES:
        raise ValueError("The link type must be one of " + ", ".join(LINK_TYPES) + ".")
    label = "" if raw.get("label") is None else raw["label"]
    if not isinstance(label, str):
        raise ValueError("The label must be text.")
    label = _clean_short(label)
    if len(label) > LINK_LABEL_MAX:
        raise ValueError(f"Labels can be up to {LINK_LABEL_MAX} characters.")
    if typ == "custom" and not label:
        raise ValueError(f"A custom link needs a label (up to {LINK_LABEL_MAX} characters).")
    note = "" if raw.get("note") is None else raw["note"]
    if not isinstance(note, str):
        raise ValueError("The note must be text.")
    if check_size and len(note) > LINK_NOTE_MAX:
        raise ValueError(f"A link’s note can be up to {LINK_NOTE_MAX:,} characters.")
    color = "blue" if raw.get("color") is None else raw["color"]
    if color not in BOOKMARK_COLORS:  # the bookmark palette
        raise ValueError("Choose red, orange, yellow, green, blue or purple.")
    tags_in = [] if raw.get("tags") is None else raw["tags"]
    if not isinstance(tags_in, list):
        raise ValueError("Tags must be a list.")
    tags = []
    for t in tags_in:
        t = _clean_tag(t)
        if t not in tags:
            tags.append(t)
    if len(tags) > LINK_TAGS_MAX:
        raise ValueError(f"A link can have up to {LINK_TAGS_MAX} tags.")
    d = ("both" if typ in LINK_BOTH_BY_DEFAULT else "to") if raw.get("dir") is None else raw["dir"]
    if d not in ("to", "both"):
        raise ValueError("The direction must be “to” or “both”.")
    upd = now if raw.get("updated") is None else clamp_ts(raw["updated"], now)
    if upd is None:
        raise ValueError("“updated” must be a time in milliseconds.")
    created = upd if raw.get("created") is None else clamp_ts(raw["created"], now)
    if created is None:
        raise ValueError("“created” must be a time in milliseconds.")
    out = {"id": lid, "from": ends["from"], "to": ends["to"], "type": typ, "label": label, "note": note, "color": color,
           "tags": tags, "dir": d, "created": created, "updated": upd}
    if check_size and len(json.dumps(out, ensure_ascii=False).encode("utf-8")) > LINK_MAX_BYTES:
        raise ValueError("That link is too large to save (32 KB at most).")
    return out


def _salvage_link(raw, cap):
    """Load-time repair of a stored link that failed clean_link, field by field (PS §1.7), so its note is never lost:
    -> a copy of raw with each bad optional field reset (an unknown type, or `custom` with no label -> `related`; a
    label cut to 40 characters; colour -> blue; direction -> the type's default; only the valid tags; a bad time ->
    the load time; a note that is not text -> ''). A bad id or bad ends are left as they are: clean_link still
    rejects them, and only then is the link dropped."""
    if not isinstance(raw, dict):
        return raw
    out = dict(raw)
    label = raw.get("label")
    out["label"] = _clean_short(label)[:LINK_LABEL_MAX] if isinstance(label, str) else ""
    typ = raw.get("type")
    if (typ is not None and not (isinstance(typ, str) and typ in LINK_TYPES)) or (typ == "custom" and not out["label"]):
        out["type"] = "related"
    if raw.get("color") not in BOOKMARK_COLORS:
        out["color"] = "blue"
    if raw.get("dir") not in ("to", "both"):
        out["dir"] = None
    tags = []
    for t in raw.get("tags") if isinstance(raw.get("tags"), list) else []:
        try:
            t = _clean_tag(t)
        except ValueError:
            continue
        if t not in tags:
            tags.append(t)
    out["tags"] = tags[:LINK_TAGS_MAX]
    for f in ("created", "updated"):
        if clamp_ts(raw.get(f), cap) is None:
            out[f] = None
    if not isinstance(raw.get("note"), str):
        out["note"] = ""
    return out


def _empty_keyed(field):
    return {"version": 1, "rev": 0, field: {}, "deleted": {}}


def _load_keyed(scope, path, field, id_re, clean, salvage):
    """The loader shared by links and marks: {version, rev, <field>: {id: record}, deleted: {id: ms}}. Missing -> empty
    (rev 0). Unparseable, or <field> not an object -> moved aside (PS §1.7). Otherwise repaired entry by entry and
    persisted by the next save: a stored record that no longer validates is repaired field by field (`salvage`) and
    dropped only when `clean` still rejects it (both logged as '<field>-repaired'), and a timestamp more than 5
    minutes after the file's mtime becomes that mtime (as for notes: stable until the next write, so a
    compare-and-set base taken from the GET still matches)."""
    d = read_json_strict(path, _empty_keyed(field))
    if field in d and not isinstance(d[field], dict):
        _move_aside(path)
        d = _empty_keyed(field)
    try:
        cap = min(now_ms(), int(os.stat(path).st_mtime * 1000))
    except OSError:
        cap = now_ms()
    recs, dropped, repaired = {}, 0, 0
    for k, raw in (d.get(field) or {}).items():
        fixed = False
        try:
            rec = clean(raw, cap, check_size=False)
        except ValueError:
            try:
                rec, fixed = clean(salvage(raw, cap), cap, check_size=False), True
            except ValueError:
                rec = None
        if rec is None or rec["id"] != k:
            dropped += 1
            continue
        recs[k] = rec
        repaired += fixed
    if dropped or repaired:
        log(f"{field}-repaired", scope=scope, dropped=dropped, repaired=repaired)
    deleted = {}
    for k, ts in (d.get("deleted") if isinstance(d.get("deleted"), dict) else {}).items():
        if id_re.fullmatch(k) and _is_num(ts) and ts >= 0:
            deleted[k] = cap if ts > cap + MAX_FUTURE_MS else int(ts)
    rev = d.get("rev") if _is_int(d.get("rev")) and d["rev"] >= 0 else 0
    return {"version": 1, "rev": rev, field: recs, "deleted": deleted}


def _save_keyed(scope, path, doc):
    _prepare_write(scope)
    doc["deleted"] = prune_tombstones(doc.get("deleted") or {})
    _daily_backup(path)
    write_json_atomic(path, doc)


def _apply_keyed(doc, field, set_map, del_map, base):
    """Per-key merge of a links or marks document: exactly the notes rules (PS §2.4 #10, _apply_changes), on cleaned
    records. Mutates `doc`. -> (changed, conflicts, created_ids): created_ids are the ids that did not exist before
    this request, in request order (a retried create is not new, so it never adds a second activity entry)."""
    recs = doc.setdefault(field, {})
    before = set(recs)
    changed, conflicts = _apply_changes(recs, doc.setdefault("deleted", {}), set_map, del_map, base)
    return changed, conflicts, [k for k in set_map if k in recs and k not in before]


def empty_links():
    return _empty_keyed("links")


def load_links(scope):
    """links.json through _load_keyed: a link is dropped only when its id or ends are bad (_salvage_link)."""
    return _load_keyed(scope, links_path(scope), "links", LINK_ID_RE, clean_link, _salvage_link)


def save_links(scope, doc):
    _save_keyed(scope, links_path(scope), doc)


def apply_link_changes(doc, set_map, del_map, base=None):
    """Per-key merge of links (_apply_keyed). -> (changed, conflicts, created_ids)."""
    return _apply_keyed(doc, "links", set_map, del_map, base)


def link_versions(doc, keys, conflicts):
    """{id: stored updated | None when deleted} for the ids of a request that did not conflict (as note_versions)."""
    return _versions(doc.get("links") or {}, keys, conflicts)


def merge_links(dst, src):
    """Guest -> profile merge (links-spec §2, the notes rule of PS §1.8; idempotent). Mutates dst. New ids stop at
    the 10,000-link limit. -> number of links taken from src."""
    links = dst.setdefault("links", {})
    return len(_merge_keyed(links, dst.setdefault("deleted", {}), src.get("links") or {}, room=MAX_LINKS - len(links)))


def link_phrase(link, side):
    """The direction-aware phrase from one side ('from' or 'to') of a link (§1.2)."""
    ph = LINK_TYPES.get(link.get("type"))
    if ph is None:
        return link.get("label") or "is linked to"
    if link.get("dir") == "both":
        return ph[2]
    return ph[0] if side == "from" else ph[1]


# ------------------------------------------------------------------ marks (annotations brief §1, §2)
MARK_ID_RE = re.compile(r"mk_[0-9a-f]{12}", re.ASCII)
MARK_TRS = ("kjv", "bsb", "esv", "nlt")
MARK_COLORS = ("yellow", "green", "blue", "pink", "purple", "orange")  # or "" for a comment-only underline
MAX_MARKS = 20_000
MARK_MAX_BYTES = 32 * 1024
MARK_QUOTE_MAX, MARK_CONTEXT_MAX, MARK_NOTE_MAX, MARK_OFFSET_MAX = 2_000, 32, 20_000, 10_000


def parse_mark_end(s):
    """One end of a mark: 'b.c.v' in this Bible (ASCII digits; leading zeros are read, never stored) -> (b, c, v),
    or None. A range is not an end."""
    p = parse_link_ref(s)
    return p[:3] if p and "-" not in s else None


def _clean_anchor(s):
    """Anchor text (quote, pre, suf) as the verse shows it: whitespace is kept, because the offsets and re-anchoring
    count it; only C0/C1 control characters other than tab and newline, and bidi controls, are removed."""
    if s.isprintable():
        return s
    return "".join(ch for ch in s if ch in "\t\n" or not (ord(ch) < 32 or 127 <= ord(ch) <= 159 or ch in BIDI_CONTROLS))


def clean_mark(raw, now=None, check_size=True):
    """Validate one incoming mark (brief §1). -> a new dict with exactly the mark fields, canonical ends and defaults
    filled in; raises ValueError(message naming the problem). Unknown fields are dropped. Timestamps more than 5
    minutes ahead of `now` become `now` (the clock guard of links and notes). The server has no verse text (ESV and
    NLT are fetched by the browser), so offsets are checked for shape only: whole numbers, inside one chapter, the
    end after the start. check_size=False skips the 32 KiB and comment-length checks (load-time repair)."""
    now = now or now_ms()
    if not isinstance(raw, dict):
        raise ValueError("A highlight must be an object.")
    mid = raw.get("id")
    if not isinstance(mid, str) or not MARK_ID_RE.fullmatch(mid):
        raise ValueError("A highlight id is “mk_” followed by 12 hex digits.")
    tr = raw.get("tr")
    if tr not in MARK_TRS:
        raise ValueError("The translation must be kjv, bsb, esv or nlt.")
    ends = {}
    for f in ("start", "end"):
        p = parse_mark_end(raw.get(f))
        if p is None:
            raise ValueError(f"“{f}” must be a verse in this Bible, like 43.3.16.")
        ends[f] = p
    if ends["start"][:2] != ends["end"][:2]:
        raise ValueError("A highlight must start and end in the same chapter.")
    so, eo = raw.get("so"), raw.get("eo")
    if not all(_is_int(x) and 0 <= x <= MARK_OFFSET_MAX for x in (so, eo)):
        raise ValueError(f"“so” and “eo” must be whole numbers from 0 to {MARK_OFFSET_MAX:,}.")
    if (ends["start"][2], so) >= (ends["end"][2], eo):
        raise ValueError("A highlight must end after it starts.")
    quote = raw.get("quote")
    if not isinstance(quote, str):
        raise ValueError("The quote must be text.")
    quote = _clean_anchor(quote)
    if not quote.strip() or len(quote) > MARK_QUOTE_MAX:
        raise ValueError(f"The quote must be 1–{MARK_QUOTE_MAX:,} characters.")
    ctx = {}
    for f in ("pre", "suf"):
        t = "" if raw.get(f) is None else raw[f]
        if not isinstance(t, str):
            raise ValueError(f"“{f}” must be text.")
        ctx[f] = _clean_anchor(t)
        if len(ctx[f]) > MARK_CONTEXT_MAX:
            raise ValueError(f"“{f}” can be up to {MARK_CONTEXT_MAX} characters.")
    color = "yellow" if raw.get("color") is None else raw["color"]
    if color != "" and color not in MARK_COLORS:
        raise ValueError("Choose yellow, green, blue, pink, purple or orange, or no colour for a comment.")
    note = "" if raw.get("note") is None else raw["note"]
    if not isinstance(note, str):
        raise ValueError("The comment must be text.")
    if check_size and len(note) > MARK_NOTE_MAX:
        raise ValueError(f"A comment can be up to {MARK_NOTE_MAX:,} characters.")
    upd = now if raw.get("updated") is None else clamp_ts(raw["updated"], now)
    if upd is None:
        raise ValueError("“updated” must be a time in milliseconds.")
    created = upd if raw.get("created") is None else clamp_ts(raw["created"], now)
    if created is None:
        raise ValueError("“created” must be a time in milliseconds.")
    out = {"id": mid, "tr": tr, "start": link_ref_str(*ends["start"]), "so": so, "end": link_ref_str(*ends["end"]),
           "eo": eo, "quote": quote, "pre": ctx["pre"], "suf": ctx["suf"], "color": color, "note": note,
           "created": created, "updated": upd}
    if check_size and len(json.dumps(out, ensure_ascii=False).encode("utf-8")) > MARK_MAX_BYTES:
        raise ValueError("That highlight is too large to save (32 KB at most).")
    return out


def _salvage_mark(raw, cap):
    """Load-time repair of a stored mark that failed clean_mark, field by field (PS §1.7), so its comment is never
    lost: -> a copy of raw with each bad optional field reset (translation -> kjv; colour -> yellow; a quote cut to
    2,000 characters; context that is not text -> '', else cut to its 32 characters next to the quote; a bad time ->
    the load time; a comment that is not text -> ''). A bad id, ends or offsets, or a quote that is blank or not
    text, are left as they are: clean_mark still rejects them, and only then is the mark dropped."""
    if not isinstance(raw, dict):
        return raw
    out = dict(raw)
    if raw.get("tr") not in MARK_TRS:
        out["tr"] = "kjv"
    if raw.get("color") != "" and raw.get("color") not in MARK_COLORS:
        out["color"] = "yellow"
    if isinstance(raw.get("quote"), str):
        out["quote"] = _clean_anchor(raw["quote"])[:MARK_QUOTE_MAX]
    pre, suf = raw.get("pre"), raw.get("suf")
    out["pre"] = _clean_anchor(pre)[-MARK_CONTEXT_MAX:] if isinstance(pre, str) else ""
    out["suf"] = _clean_anchor(suf)[:MARK_CONTEXT_MAX] if isinstance(suf, str) else ""
    for f in ("created", "updated"):
        if clamp_ts(raw.get(f), cap) is None:
            out[f] = None
    if not isinstance(raw.get("note"), str):
        out["note"] = ""
    return out


def empty_marks():
    return _empty_keyed("marks")


def load_marks(scope):
    """marks.json through _load_keyed (the links rules): a mark is dropped only when its id, ends, offsets or quote are
    bad (_salvage_mark)."""
    return _load_keyed(scope, marks_path(scope), "marks", MARK_ID_RE, clean_mark, _salvage_mark)


def save_marks(scope, doc):
    _save_keyed(scope, marks_path(scope), doc)


def apply_mark_changes(doc, set_map, del_map, base=None):
    """Per-key merge of marks (_apply_keyed): two marks on one verse are two ids, so they never conflict.
    -> (changed, conflicts, created_ids)."""
    return _apply_keyed(doc, "marks", set_map, del_map, base)


def mark_versions(doc, keys, conflicts):
    """{id: stored updated | None when deleted} for the ids of a request that did not conflict (as note_versions)."""
    return _versions(doc.get("marks") or {}, keys, conflicts)


def merge_marks(dst, src):
    """Guest -> profile merge (the notes rule of PS §1.8, as merge_links; idempotent). Mutates dst. New ids stop at
    the 20,000-mark limit. -> number of marks taken from src."""
    marks = dst.setdefault("marks", {})
    return len(_merge_keyed(marks, dst.setdefault("deleted", {}), src.get("marks") or {}, room=MAX_MARKS - len(marks)))


# ------------------------------------------------------------------ library (§1.5, §4.6)
BOOKMARK_COLORS = ("red", "orange", "yellow", "green", "blue", "purple")
MAX_BOOKMARKS = 2000
MAX_ACTIVITY = 1000
MAX_DAYS = 400
MAX_BATCH_IDS = 200
MAX_IMPORTS = 50
EVENT_TYPES = {"chapter.open", "chapter.time", "chapter.read", "verse.study", "xref.open", "word.study",
               "note.save", "video.add", "position"}
STUDY_TYPES = ("verse.study", "xref.open", "word.study", "note.save", "video.add")
ACTIVITY_TYPES = {"chapter.open", "chapter.read", "chapter.mark", "verse.study", "xref.open", "word.study",
                  "note.save", "video.add", "bookmark.add", "bookmark.remove", "profile.create", "profile.import",
                  "link.add", "mark.add"}


def new_chapter():
    return {"firstRead": None, "lastRead": None, "visits": 0, "seconds": 0, "studied": [], "read": False,
            "readAt": None, "manual": False, "manualAt": None}


DAY_KEYS = ("s", "v", "r", "n", "o")


def new_day():
    return {"s": 0, "v": 0, "r": 0, "n": 0, "o": 0}


def new_library(now=None):
    return {"version": 1, "rev": 0, "created": now, "updated": now, "bookmarks": [], "lastPosition": None,
            "chapters": {}, "days": {}, "activity": [], "appliedBatches": [], "imports": []}


def _list(x):
    return x if isinstance(x, list) else []


def _nonneg_int(x):
    x = _as_int(x)
    return x if x is not None and x >= 0 else 0


def _norm_bookmark(bm):
    if not isinstance(bm, dict) or not isinstance(bm.get("id"), str):
        return None
    ref = canonical_ref(bm.get("ref"))
    if ref is None:
        return None
    out = dict(bm)
    out["ref"] = ref
    out["b"], out["c"], out["v"] = parse_ref(ref)
    if not isinstance(out.get("label"), str):
        out["label"] = ""
    if out.get("color") not in BOOKMARK_COLORS:
        out["color"] = "red"
    out["created"], out["updated"] = _nonneg_int(bm.get("created")), _nonneg_int(bm.get("updated"))
    return out


def _norm_position(lp):
    if not isinstance(lp, dict):
        return None
    b, c = _as_int(lp.get("b")), _as_int(lp.get("c"))
    if b is None or c is None or not valid_bc(b, c):
        return None
    out = dict(lp, b=b, c=c)
    v = _as_int(lp.get("v"))
    out["v"] = v if v is not None and 0 <= v <= verses_in(b, c) else 0
    sf = lp.get("scrollFrac")
    out["scrollFrac"] = round(float(min(1, max(0, sf))), 3) if _is_num(sf) else 0
    out["t"] = _nonneg_int(lp.get("t"))
    if "tr" in out and not (isinstance(out["tr"], str) and TR_RE.fullmatch(out["tr"])):
        del out["tr"]
    return out


def _norm_chapter(ch):
    c = new_chapter()
    c.update(ch)
    c["studied"] = sorted({int(v) for v in _list(c.get("studied")) if _is_int(v) and v >= 1})
    for f in ("visits", "seconds"):
        c[f] = _nonneg_int(c.get(f))
    for f in ("firstRead", "lastRead", "readAt", "manualAt"):
        c[f] = _as_int(c.get(f))
    c["read"], c["manual"] = bool(c.get("read")), bool(c.get("manual"))
    return c


def _norm_activity(a):
    if not isinstance(a, dict) or not _is_int(a.get("t")) or not isinstance(a.get("type"), str):
        return None
    if a.get("ref") is not None and not isinstance(a.get("ref"), str):
        a = dict(a, ref=None)
    if "x" in a and not isinstance(a["x"], dict):
        a = {k: v for k, v in a.items() if k != "x"}
    return a


def normalize_library(lib):
    """Fill missing fields, repair or drop malformed entries, and fold refs spelled with leading zeros into their
    canonical key, so a readable but wrongly shaped library.json can never make the library endpoints fail."""
    out = new_library()
    if not isinstance(lib, dict):
        return out
    out.update({k: v for k, v in lib.items()})
    if not (_is_int(out.get("rev")) and out["rev"] >= 0):
        out["rev"] = 0
    for f in ("created", "updated"):
        out[f] = _as_int(out.get(f))
    by_ref = {}
    for bm in _list(out.get("bookmarks")):
        nb = _norm_bookmark(bm)
        if nb is not None and (nb["ref"] not in by_ref or nb["updated"] > by_ref[nb["ref"]]["updated"]):
            by_ref[nb["ref"]] = nb  # one bookmark per ref: the most recently edited one
    out["bookmarks"] = sorted(by_ref.values(), key=lambda x: x["created"], reverse=True)
    out["lastPosition"] = _norm_position(out.get("lastPosition"))
    chs = out.get("chapters") if isinstance(out.get("chapters"), dict) else {}
    clean = {}
    for k, ch in chs.items():
        ck = canonical_ref(k)
        p = parse_ref(ck) if ck else None
        if not p or p[2] or not isinstance(ch, dict):
            continue
        c = _norm_chapter(ch)
        clean[ck] = _merge_chapter(clean[ck], c) if ck in clean else c
    out["chapters"] = clean
    days = out.get("days") if isinstance(out.get("days"), dict) else {}
    out["days"] = {d: dict(new_day(), **{kk: vv for kk, vv in x.items() if kk in DAY_KEYS and _is_int(vv)})
                   for d, x in days.items() if parse_day(d) and isinstance(x, dict)}
    out["activity"] = [a for a in map(_norm_activity, _list(out.get("activity"))) if a is not None]
    out["appliedBatches"] = [b for b in _list(out.get("appliedBatches")) if isinstance(b, str)][-MAX_BATCH_IDS:]
    out["imports"] = [i for i in _list(out.get("imports")) if isinstance(i, dict)][-MAX_IMPORTS:]
    return out


def load_library(scope):
    path = library_path(scope)
    raw = read_json_strict(path, new_library())
    try:
        return normalize_library(raw)
    except Exception:  # noqa: backstop; normalize_library checks every type, but never fail every request on one file
        _move_aside(path)
        return new_library()


def save_library(scope, lib):
    _prepare_write(scope)
    path = library_path(scope)
    _daily_backup(path)
    write_json_atomic(path, lib)


def _min_nn(a, b):
    vals = [x for x in (a, b) if _is_int(x)]
    return min(vals) if vals else None


def _max_nn(a, b):
    vals = [x for x in (a, b) if _is_int(x)]
    return max(vals) if vals else None


def _trim_activity(lib):
    act = lib.setdefault("activity", [])
    act.sort(key=lambda a: a.get("t", 0))
    if len(act) > MAX_ACTIVITY:
        del act[:len(act) - MAX_ACTIVITY]


def add_activity(lib, entry):
    lib.setdefault("activity", []).append(entry)
    _trim_activity(lib)


def _recent(act, typ, ref, t, window_ms, x=None):
    """Same type and ref within the window (and, when `x` is given, the same detail: x.to of a followed link,
    x.strong/x.word of a word study — two different links from one verse are two rows)."""
    for e in act[-20:]:
        if e.get("type") == typ and e.get("ref") == ref and abs(int(e.get("t", 0)) - t) <= window_ms:
            if x is None or (e.get("x") if isinstance(e.get("x"), dict) else {}) == x:
                return True
    return False


def clean_event(ev, now_ms_):
    """Normalise one tracker event (§4.6) or return None."""
    if not isinstance(ev, dict):
        return None
    typ = ev.get("type")
    if typ not in EVENT_TYPES:
        return None
    t = _as_int(ev.get("t"))
    if t is None:
        return None
    if t > now_ms_ + 5 * 60 * 1000:
        t = now_ms_
    if t < now_ms_ - 30 * DAY_MS:
        return None
    b, c = _as_int(ev.get("b")), _as_int(ev.get("c"))
    if b is None or c is None or not valid_bc(b, c):
        return None
    v = ev.get("v", 0)
    v = 0 if v is None else _as_int(v)
    if v is None or not 0 <= v <= verses_in(b, c):
        return None
    if typ in ("verse.study", "xref.open", "word.study") and v < 1:
        return None
    try:
        utc_day = datetime.datetime.utcfromtimestamp(t / 1000).date()
        local_day = datetime.datetime.fromtimestamp(t / 1000).date()
    except (OverflowError, OSError, ValueError):
        return None
    d = parse_day(ev.get("day"))
    day = ev["day"] if d is not None and abs((d - utc_day).days) <= 1 else local_day.isoformat()
    out = {"type": typ, "t": t, "day": day, "b": b, "c": c, "v": v}
    if typ == "chapter.time":
        sec = ev.get("sec")
        if not _is_num(sec) or not 1 <= int(sec) <= 900:
            return None
        out["sec"] = int(sec)
    elif typ == "xref.open":
        if not valid_ref(ev.get("to")):
            return None
        out["to"] = ev["to"]
    elif typ == "word.study":
        s = ev.get("strong")
        if s is not None:
            if not isinstance(s, str) or not STRONG_RE.fullmatch(s):
                return None
            out["strong"] = s
        w = ev.get("word")
        if w is not None:
            if not isinstance(w, str) or len(w) > 500:
                return None
            w = clean_text(w)
            if w:
                out["word"] = w
    elif typ == "video.add":
        title = ev.get("title")
        if title is not None:
            if not isinstance(title, str):
                return None
            title = clean_text(title)[:120]
            if title:
                out["title"] = title
    elif typ == "position":
        sf = ev.get("scrollFrac", 0)
        if sf is None:
            sf = 0
        if not _is_num(sf):
            return None
        out["scrollFrac"] = round(float(min(1, max(0, sf))), 3)  # clamp first: float() of a huge int overflows
        tr = ev.get("tr")
        if tr is not None:
            if not isinstance(tr, str) or not TR_RE.fullmatch(tr):
                return None
            out["tr"] = tr
    return out


def _apply_one(lib, ev):
    typ, t, b, c, v = ev["type"], ev["t"], ev["b"], ev["c"], ev["v"]
    k = f"{b}.{c}"
    act = lib["activity"]
    if typ == "position":
        lp = lib.get("lastPosition")
        if not isinstance(lp, dict) or not _is_int(lp.get("t")) or t >= lp["t"]:
            pos = {"b": b, "c": c, "v": v, "scrollFrac": ev["scrollFrac"], "t": t}
            if "tr" in ev:
                pos["tr"] = ev["tr"]
            lib["lastPosition"] = pos
        return
    chs = lib["chapters"]
    ch = chs.get(k)
    if ch is None:
        ch = chs[k] = new_chapter()
    day = lambda: lib["days"].setdefault(ev["day"], new_day())  # noqa: E731 (created only when a counter moves)
    if typ == "chapter.open":
        ch["visits"] = int(ch.get("visits") or 0) + 1
        ch["firstRead"] = _min_nn(ch.get("firstRead"), t)
        ch["lastRead"] = _max_nn(ch.get("lastRead"), t)
        day()["o"] += 1
        if not _recent(act, "chapter.open", k, t, 30 * 60 * 1000):
            act.append({"t": t, "type": "chapter.open", "ref": k})
    elif typ == "chapter.time":
        ch["seconds"] = int(ch.get("seconds") or 0) + ev["sec"]
        ch["firstRead"] = _min_nn(ch.get("firstRead"), t)
        ch["lastRead"] = _max_nn(ch.get("lastRead"), t)
        d = day()
        d["s"] = min(86400, d["s"] + ev["sec"])
    elif typ == "chapter.read":
        ma = ch.get("manualAt")
        if _is_int(ma) and t < ma + 60000:
            return
        if not ch.get("read"):
            ch["read"] = True
            ch["readAt"] = t
            ch["manual"] = False
            day()["r"] += 1
            act.append({"t": t, "type": "chapter.read", "ref": k})
    else:  # study types
        studied = ch.setdefault("studied", [])
        if v >= 1 and v not in studied:
            bisect.insort(studied, v)
            day()["v"] += 1
        if typ == "note.save":
            day()["n"] += 1
        ref = f"{k}.{v}" if v >= 1 else k
        x = {}
        if typ == "xref.open":
            x = {"to": ev["to"]}
        elif typ == "word.study":
            x = {kk: ev[kk] for kk in ("strong", "word") if kk in ev}
        elif typ == "video.add" and "title" in ev:
            x = {"title": ev["title"]}
        if typ in ("verse.study", "note.save") and _recent(act, typ, ref, t, 10 * 60 * 1000):
            return
        if typ in ("xref.open", "word.study") and _recent(act, typ, ref, t, 10 * 60 * 1000, x):
            return  # reopening the same link / clicking the same word again is one row, not one per click
        entry = {"t": t, "type": typ, "ref": ref}
        if x:
            entry["x"] = x
        act.append(entry)


def _trim_days(lib):
    days = lib.get("days", {})
    if len(days) > MAX_DAYS:
        for d in sorted(days)[:len(days) - MAX_DAYS]:
            del days[d]


def apply_events(lib, events, now_ms_):
    """Aggregate a batch of tracker events into the library (§4.6). -> (applied, rejected)."""
    for f, dflt in (("chapters", {}), ("days", {}), ("activity", [])):
        if not isinstance(lib.get(f), type(dflt)):
            lib[f] = dflt
    applied = rejected = 0
    for raw in events:
        ev = clean_event(raw, now_ms_)
        if ev is None:
            rejected += 1
            continue
        _apply_one(lib, ev)
        applied += 1
    _trim_activity(lib)
    _trim_days(lib)
    lib["updated"] = now_ms_
    return applied, rejected


def _add_studied_activity(lib, rows, day, now):
    """Server-made activity for new links and marks: rows are (refs, entry); each ref's first verse is marked as
    studied, days[day].v counting the newly studied verses as verse.study does (§4.6), and each entry is appended.
    Mutates lib (the caller bumps `rev`). -> True when anything was added."""
    for f, dflt in (("chapters", {}), ("days", {}), ("activity", [])):
        if not isinstance(lib.get(f), type(dflt)):
            lib[f] = dflt
    for refs, entry in rows:
        for end in refs:
            p = parse_link_ref(end)
            if not p:
                continue
            ch = lib["chapters"].setdefault(f"{p[0]}.{p[1]}", new_chapter())
            studied = ch.setdefault("studied", [])
            if p[2] not in studied:
                bisect.insort(studied, p[2])
                lib["days"].setdefault(day, new_day())["v"] += 1
        lib["activity"].append(entry)
    if not rows:
        return False
    _trim_activity(lib)
    _trim_days(lib)
    lib["updated"] = now
    return True


def add_link_activity(lib, new_links, day, now):
    """New links (links-spec §2): one `link.add` entry each ({t, type, ref: from, x: {id, to, kind}}), and the first
    verse of both ends marked as studied. Deletes write nothing. -> True when anything was added."""
    rows = [((ln["from"], ln["to"]), {"t": now, "type": "link.add", "ref": ln["from"],
                                      "x": {"id": ln["id"], "to": ln["to"], "kind": ln["type"]}}) for ln in new_links]
    return _add_studied_activity(lib, rows, day, now)


def add_mark_activity(lib, new_marks, day, now):
    """New marks (brief §2): one `mark.add` entry each ({t, type, ref: start, x: {id, color, note: bool}}), and the
    start verse marked as studied. Edits and deletes write nothing. -> True when anything was added."""
    rows = [((mk["start"],), {"t": now, "type": "mark.add", "ref": mk["start"],
                              "x": {"id": mk["id"], "color": mk["color"], "note": bool(mk["note"])}}) for mk in new_marks]
    return _add_studied_activity(lib, rows, day, now)


def is_study_day(x):
    return isinstance(x, dict) and (x.get("s", 0) >= 60 or x.get("v", 0) >= 1 or x.get("r", 0) >= 1 or x.get("n", 0) >= 1)


def compute_stats(lib, notes_count, today, links_count=0, marks_count=0):
    """Derived stats for GET /api/library (§1.6). `today` is 'YYYY-MM-DD' (client local) or a date."""
    M = meta()
    td = today if isinstance(today, datetime.date) else parse_day(today)
    if td is None or td.year < 2:  # the 90-day window would run past 0001-01-01 (OverflowError): use the server date
        td = datetime.date.today()
    one = datetime.timedelta(days=1)
    days = lib.get("days") or {}
    study = {d for d, x in days.items() if is_study_day(x)}
    cur = 0
    d = td if td.isoformat() in study else td - one
    while d.isoformat() in study:
        cur += 1
        if d == datetime.date.min:  # an imported 0001-01-01 study day ends the walk
            break
        d -= one
    longest = run = 0
    prev = None
    for ds in sorted(study):
        dd = parse_day(ds)
        if dd is None:
            continue
        run = run + 1 if prev is not None and dd - prev == one else 1
        longest = max(longest, run)
        prev = dd
    window = [(td - datetime.timedelta(days=i)).isoformat() for i in range(89, -1, -1)]
    minutes90 = [(int((days.get(w) or {}).get("s", 0)) + 30) // 60 for w in window]
    days90 = sum(1 for w in window if w in study)
    week = sum(int((days.get(w) or {}).get("s", 0)) for w in window[-7:])
    chs = lib.get("chapters") or {}
    books = {}
    tot_seconds = read = verses = studied_ch = 0
    for k, ch in chs.items():
        p = parse_ref(k)
        if not p or p[2]:
            continue
        b = p[0]
        bk = books.setdefault(str(b), {"read": 0, "total": chapters_in(b), "started": 0, "seconds": 0, "studied": 0})
        s = int(ch.get("seconds") or 0)
        n_st = len(ch.get("studied") or [])
        tot_seconds += s
        verses += n_st
        bk["seconds"] += s
        bk["studied"] += n_st
        if n_st:
            studied_ch += 1
        if ch.get("read"):
            read += 1
            bk["read"] += 1
        if int(ch.get("visits") or 0) > 0 or n_st:
            bk["started"] += 1
    completed = sum(1 for bk in books.values() if bk["read"] >= bk["total"])
    return {
        "today": td.isoformat(),
        "streak": {"current": cur, "longest": longest, "studiedToday": td.isoformat() in study},
        "minutes90": minutes90,
        "days90": days90,
        "week": {"seconds": week},
        "totals": {"seconds": tot_seconds, "chaptersRead": read, "chaptersTotal": M["total"], "versesStudied": verses,
                   "chaptersStudied": studied_ch, "booksCompleted": completed, "bookmarks": len(lib.get("bookmarks") or []),
                   "notes": notes_count, "links": links_count, "marks": marks_count, "daysStudied": len(study)},
        "books": books,
    }


def _merge_chapter(p, g):
    out = dict(p)
    out["firstRead"] = _min_nn(p.get("firstRead"), g.get("firstRead"))
    out["lastRead"] = _max_nn(p.get("lastRead"), g.get("lastRead"))
    out["visits"] = max(int(p.get("visits") or 0), int(g.get("visits") or 0))
    out["seconds"] = max(int(p.get("seconds") or 0), int(g.get("seconds") or 0))
    out["studied"] = sorted(set(p.get("studied") or []) | set(g.get("studied") or []))
    out["read"] = bool(p.get("read") or g.get("read"))
    ras = [x.get("readAt") for x in (p, g) if x.get("read") and _is_int(x.get("readAt"))]
    out["readAt"] = min(ras) if ras else None
    return out


def merge_library(dst, src, mode, now=None):
    """Guest -> profile library import (§1.8). Mutates dst.

    mode "copy": dst becomes a deep copy of src (used at sign-up). mode "merge": idempotent union.
    -> {"bookmarks": n, "chapters": n, "changed": bool} (counts = items that changed the profile)."""
    now = now or now_ms()
    src = normalize_library(copy.deepcopy(src))
    if mode == "copy":
        counts = {"bookmarks": len(src["bookmarks"]), "chapters": len(src["chapters"]), "changed": True}
        dst.clear()
        dst.update(src)
        dst.update(rev=1, created=now, updated=now, appliedBatches=[], imports=[{"source": "guest", "t": now, "mode": "copy"}])
        return counts
    if mode != "merge":
        raise ValueError("mode must be 'copy' or 'merge'")
    changed = False
    nb = nc = 0
    have_refs = {b.get("ref") for b in dst["bookmarks"]}
    have_ids = {b.get("id") for b in dst["bookmarks"]}
    for bm in src["bookmarks"]:
        if bm["ref"] in have_refs or len(dst["bookmarks"]) >= MAX_BOOKMARKS:
            continue
        bm = dict(bm)
        while bm.get("id") in have_ids or not BOOKMARK_ID_RE.fullmatch(str(bm.get("id"))):
            bm["id"] = "bm_" + secrets.token_hex(6)
        dst["bookmarks"].append(bm)
        have_refs.add(bm["ref"])
        have_ids.add(bm["id"])
        nb += 1
    if nb:
        dst["bookmarks"].sort(key=lambda x: _nonneg_int(x.get("created")), reverse=True)
    for k, g in src["chapters"].items():
        p = dst["chapters"].get(k)
        merged = copy.deepcopy(g) if p is None else _merge_chapter(p, g)
        if merged != p:
            dst["chapters"][k] = merged
            nc += 1
    # Days and activity are capped, so whether they changed is decided AFTER trimming: guest entries older than
    # everything the profile keeps are added and immediately dropped again, which is no change (idempotent, §1.8).
    days_before = copy.deepcopy(dst["days"])
    for d, g in src["days"].items():
        p = dst["days"].get(d)
        merged = dict(g) if p is None else {kk: max(int(p.get(kk, 0)), int(g.get(kk, 0))) for kk in DAY_KEYS}
        if merged != p:
            dst["days"][d] = merged
    _trim_days(dst)
    if dst["days"] != days_before:
        changed = True
    act_key = lambda a: (a.get("t"), a.get("type"), a.get("ref"))  # noqa: E731
    act_before = collections.Counter(map(act_key, dst["activity"]))
    seen = set(act_before)
    for a in src["activity"]:
        key = act_key(a)
        if key not in seen:
            dst["activity"].append(a)
            seen.add(key)
    _trim_activity(dst)
    if collections.Counter(map(act_key, dst["activity"])) != act_before:
        changed = True
    glp, plp = src.get("lastPosition"), dst.get("lastPosition")
    if isinstance(glp, dict) and _is_int(glp.get("t")) and (not isinstance(plp, dict) or glp["t"] > int(plp.get("t") or 0)):
        dst["lastPosition"] = dict(glp)
        changed = True
    return {"bookmarks": nb, "chapters": nc, "changed": bool(changed or nb or nc)}


def guest_summary(notes, lib, links=None, marks=None):
    refs = notes.get("refs") or {}
    bms = lib.get("bookmarks") or []
    chs = lib.get("chapters") or {}
    lns = (links or {}).get("links") or {}
    mks = (marks or {}).get("marks") or {}
    # chapters: every chapter with any progress, as the import counts them ("reading progress for N chapters")
    return {"notes": len(refs), "bookmarks": len(bms), "chapters": len(chs),
            "chaptersRead": sum(1 for c in chs.values() if c.get("read")), "links": len(lns), "marks": len(mks),
            "hasData": bool(refs or bms or chs or lns or mks)}


# ------------------------------------------------------------------ export (§1.9)
def slugify(name):
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:40].strip("-")
    return s


def export_profile(scope, user=None):
    notes = load_notes(scope)
    lib = load_library(scope)
    links = load_links(scope)
    marks = load_marks(scope)
    return {
        "format": "bible-study-profile",
        "version": 1,
        "exported": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "scope": "guest" if scope == "guest" else "profile",
        "profile": None if user is None else {"name": user.get("name", ""), "email": user.get("email", ""), "created": user.get("created")},
        "notes": {"refs": notes["refs"], "studies": notes["studies"]},
        "library": {k: lib.get(k) for k in ("version", "rev", "bookmarks", "lastPosition", "chapters", "days", "activity", "imports")},
        "links": {"links": links["links"]},
        "marks": {"marks": marks["marks"]},
    }


def clean_import(data, now=None):
    """A GET /api/export/profile file (a profile's or a guest's) -> ({"notes", "links", "marks": {key: record},
    "library": dict}, skipped). Each record is checked as if it were saved one by one (clean_note / clean_link /
    clean_mark); one that fails is skipped and counted, never stored. The library is normalised by merge_library.
    Raises ValueError when the file is not an export at all (hosting brief §1)."""
    now = now or now_ms()
    if not isinstance(data, dict) or data.get("format") != "bible-study-profile" or not (_is_int(data.get("version")) and data["version"] == 1):
        raise ValueError("not a profile export")

    def section(name, field):
        sec = data.get(name)
        recs = sec.get(field) if isinstance(sec, dict) else None
        if (sec is not None and not isinstance(sec, dict)) or (recs is not None and not isinstance(recs, dict)):
            raise ValueError(f"{name} is not an object")
        return recs or {}

    notes, links, marks = section("notes", "refs"), section("links", "links"), section("marks", "marks")
    lib = data.get("library")
    if lib is not None and not isinstance(lib, dict):
        raise ValueError("library is not an object")
    out, skipped = {"notes": {}, "links": {}, "marks": {}, "library": lib or {}}, 0

    def stable(raw):  # never stamp a record with `now`: a second import would see it as newer and take it again
        if isinstance(raw, dict) and raw.get("updated") is None:
            c = raw.get("created")
            return dict(raw, updated=c if _is_num(c) and c >= 0 else 0)
        return raw

    for k, n in notes.items():
        c = clean_note(stable(n), now) if valid_ref(k) else None
        if c is None:
            skipped += 1
        else:
            out["notes"][k] = c
    for field, recs, id_re, clean in (("links", links, LINK_ID_RE, clean_link), ("marks", marks, MARK_ID_RE, clean_mark)):
        for k, raw in recs.items():
            try:
                c = clean(stable(raw), now) if id_re.fullmatch(k) else None
            except ValueError:
                c = None
            if c is None or c["id"] != k:
                skipped += 1
            else:
                out[field][k] = c
    return out, skipped


def _vault_link(b, c, v=0):
    book = meta()["books"][b - 1]
    return f"[[{book} {c}.{v}|{book} {c}:{v}]]" if v else f"[[{book} {c}]]"


def _clock(s):
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


# store.js parseReference, server side (the book and verse part; a range only needs its first verse here)
_REF_ALIAS = {"psalm": "Psalms", "pss": "Psalms", "ps": "Psalms", "songofsolomon": "Song of Songs", "sos": "Song of Songs",
              "canticles": "Song of Songs", "qoh": "Ecclesiastes", "eccl": "Ecclesiastes", "rev": "Revelation", "rv": "Revelation",
              "revelations": "Revelation", "jn": "John", "jhn": "John", "mt": "Matthew", "mk": "Mark", "mrk": "Mark", "lk": "Luke",
              "gn": "Genesis", "ex": "Exodus", "lv": "Leviticus", "nm": "Numbers", "dt": "Deuteronomy", "jg": "Judges", "jdg": "Judges",
              "jb": "Job", "rm": "Romans", "dn": "Daniel", "hg": "Haggai", "ml": "Malachi", "tt": "Titus", "jm": "James", "jas": "James",
              "phil": "Philippians", "php": "Philippians", "phlp": "Philippians", "phm": "Philemon", "phlm": "Philemon", "ezk": "Ezekiel",
              "jl": "Joel", "na": "Nahum", "jgs": "Judges", "sg": "Song of Songs", "songofsol": "Song of Songs", "1tm": "1 Timothy",
              "2tm": "2 Timothy", "1pt": "1 Peter", "2pt": "2 Peter"}
_NUMBERED = {"i": "1", "ii": "2", "iii": "3", "first": "1", "second": "2", "third": "3", "1st": "1", "2nd": "2", "3rd": "3"}
_REF_TEXT_RE = re.compile(r"((?:(?:[1-3]|i{1,3}|first|second|third|1st|2nd|3rd)\s*)?[a-z]+(?:\s+(?:of\s+)?[a-z]+)*)\.?\s*(\d+)?"
                          r"(?:[:.\s]+(\d+))?(?:\s*[-–—]\s*(\d+)(?:[:.](\d+))?)?", re.I | re.ASCII)


def parse_reference(text):
    """'Psalm 23:1', 'rom 8:28', 'Heb 6:20–7:3', 'Jude 3', 'John 3.16' → (b, c, v) as the app's parseReference reads
    them (v 0 = a chapter; a range gives its first verse). None when the app would not resolve it, or when no chapter
    is given (a bare '[[Job]]' is the vault's book note, not Job 1)."""
    t = re.sub(r"[.,;:!?)\]]+$", "", re.sub(r"^[(\[]+", "", str(text or "").strip()))
    m = _REF_TEXT_RE.fullmatch(t)
    if not m or not m.group(2):
        return None
    flat = lambda x: re.sub(r"[\s.]", "", x.lower())  # noqa: E731
    name = re.sub(r"\s+", " ", m.group(1).lower()).strip()
    num = re.match(r"(i{1,3}|first|second|third|1st|2nd|3rd)\s+(.*)$", name)
    if num:
        name = f"{_NUMBERED[num.group(1)]} {num.group(2)}"
    key, M = flat(name), meta()
    found = next((i for i, (bn, (osis, short)) in enumerate(zip(M["books"], M["abbr"])) if key in (flat(bn), flat(osis), flat(short))), None)
    if found is None and key in _REF_ALIAS:
        found = M["books"].index(_REF_ALIAS[key])
    if found is None:  # a prefix of the name: 'gen', 'deut', '1 cor', '1cor'
        lead = re.match(r"([1-3]?)(.*)$", key, re.S)
        found = next((i for i, bn in enumerate(map(flat, M["books"])) if bn.startswith(key)
                      or (lead.group(1) and bn[0] == lead.group(1) and bn[1:].startswith(lead.group(2)))), None)
    if found is None:
        return None
    chs = M["verses"][found]
    c, v = int(m.group(2)), int(m.group(3) or 0)
    if len(chs) == 1 and not m.group(3) and (c > 1 or (m.group(4) and not m.group(5))):  # 'Jude 3': one-chapter books cite verses
        c, v = 1, c
    if c < 1 or c > len(chs) or v < 0 or v > chs[c - 1]:
        return None
    return found + 1, c, v


def _vault_links(text):
    """Verse links as the app writes and resolves them — '[[John 3:16]]', '[[Psalm 23:1]]', '[[Rom 8:28]]',
    '[[Hebrews 6:20–7:3]]', '[[John 3:16|this verse]]', '[[Psalm 23]]' — → the vault's '[[John 3.16|John 3:16]]' /
    '[[Psalms 23|Psalm 23]]' form (the label stays as written). Links the app would not open as a verse or chapter
    (topics, books, vault paths, anything else) are left alone."""
    books = meta()["books"]
    def one(m):
        target, alias = m.group(1).strip(), m.group(2)
        p = parse_reference(target)
        if not p:
            return m.group(0)
        b, c, v = p
        vault = f"{books[b - 1]} {c}.{v}" if v else f"{books[b - 1]} {c}"
        label = alias.strip() if alias else target
        return f"[[{vault}]]" if label == vault else f"[[{vault}|{label}]]"
    return re.sub(r"\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]", one, text)


def _vault_end(ref):
    """A link end -> '[[John 1.29|John 1:29]]'; a range links the first verse's note and shows the range in the
    alias: '[[John 1.29|John 1:29–31]]'."""
    b, c, v, ve = parse_link_ref(ref)
    book = meta()["books"][b - 1]
    return f"[[{book} {c}.{v}|{book} {c}:{v}" + (f"–{ve}" if ve != v else "") + "]]"


def _vault_footer(book, ch, vs):
    # vault paths, so the links reach the vault's own verse/chapter/book notes and never this study note
    return ((f"Verse: [[verses/{book} {ch}.{vs}|{book} {ch}:{vs}]] · " if vs else "")
            + f"Chapter: [[chapters/{book} {ch}|{book} {ch}]] · Book: [[books/{book}|{book}]]")


def _one_line(text, n=200):
    """The first n characters of a note on one line, with vault links (a link the cut would split is left out)."""
    s = re.sub(r"\s+", " ", text).strip()
    if len(s) > n:
        s = s[:n]
        i = s.rfind("[[")
        if i > s.rfind("]]"):
            s = s[:i]
        s = s.rstrip() + "…"
    return _vault_links(s)


def _connections(links):
    """Links -> (Connections.md lines or None, {'b.c.v': ['## Connections' lines for that verse's file]}).

    Connections.md lists every link newest first: '- [[John 1.29|John 1:29]] — fulfils → [[Isaiah 53.7|Isaiah 53:7]]'
    (↔ and the symmetric phrase for a two-way link) + ' · label' + ' #tag' per tag, and the note's first 200
    characters as an indented quote. Each end's first verse gets the phrase from its own side:
    '- is fulfilled in → [[John 1.29|John 1:29]] · label', sorted by the other end."""
    lns = [ln for ln in ((links or {}).get("links") or {}).values()
           if isinstance(ln, dict) and parse_link_ref(ln.get("from")) and parse_link_ref(ln.get("to"))]
    if not lns:
        return None, {}
    out, per_verse = ["# Connections", ""], {}
    newest = lambda ln: (_nonneg_int(ln.get("created")), _nonneg_int(ln.get("updated")), str(ln.get("id")))  # noqa: E731
    for ln in sorted(lns, key=newest, reverse=True):
        label = f" · {ln['label']}" if ln.get("label") and ln.get("type") != "custom" else ""  # custom: the label is the phrase
        tags = "".join(" #" + re.sub(r"\s+", "-", str(t).strip()) for t in _list(ln.get("tags")) if str(t).strip())
        arrow = "↔" if ln.get("dir") == "both" else "→"
        out.append(f"- {_vault_end(ln['from'])} — {link_phrase(ln, 'from')} {arrow} {_vault_end(ln['to'])}{label}{tags}")
        if isinstance(ln.get("note"), str) and ln["note"].strip():
            out.append("  > " + _one_line(ln["note"]))
        for side, other in (("from", "to"), ("to", "from")):
            b, c, v, _ve = parse_link_ref(ln[side])
            row = (parse_link_ref(ln[other]), _nonneg_int(ln.get("created")),
                   f"- {link_phrase(ln, side)} → {_vault_end(ln[other])}{label}")
            per_verse.setdefault(f"{b}.{c}.{v}", []).append(row)
    return out, {k: [r[2] for r in sorted(rows)] for k, rows in per_verse.items()}


def _highlights(marks):
    """Marks -> {'b.c.v': ['## Highlights' lines for that verse's file]}. A mark is listed in its start verse's file
    (a mark across verses too, as a link range uses its first verse), in reading order: '- “quoted words” (KJV,
    yellow)' (no colour for a comment-only mark), then the comment, if any, as an indented quote with vault links."""
    per_verse = {}
    for mk in ((marks or {}).get("marks") or {}).values():
        p = parse_mark_end(mk.get("start")) if isinstance(mk, dict) else None
        if not p or not isinstance(mk.get("quote"), str):
            continue
        tag = ", ".join(x for x in (str(mk.get("tr") or "").upper(), str(mk.get("color") or "")) if x)
        quote = re.sub(r"\s+", " ", mk["quote"]).strip()
        rows = [f"- “{quote}”" + (f" ({tag})" if tag else "")]
        if isinstance(mk.get("note"), str) and mk["note"].strip():
            rows += [("  > " + line).rstrip() for line in _vault_links(mk["note"].strip()).splitlines()]
        order = (_nonneg_int(mk.get("so")), _nonneg_int(mk.get("created")), str(mk.get("id")))
        per_verse.setdefault("{}.{}.{}".format(*p), []).append((order, rows))
    return {k: [line for _, rows in sorted(v) for line in rows] for k, v in per_verse.items()}


def obsidian_zip(notes, library=None, links=None, marks=None):
    """Obsidian-style markdown zip: one file per note, plus Bookmarks.md, Reading Progress.md and Connections.md
    when non-empty. A verse with marks gets a '## Highlights' section in its file, and a verse at either end of a
    link a '## Connections' section (the file is created, and listed in the index, when the verse has no note)."""
    books = meta()["books"]
    conn_md, conn = _connections(links)
    hl = _highlights(marks)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        index, entries = ["# Study notes", ""], []  # entries: (Bible order, line) for notes, linked and marked verses
        bible_order = lambda kv: tuple(int(x) for x in kv[0].split(".")) if isinstance(kv[0], str) and re.fullmatch(r"\d+\.\d+(?:\.\d+)?", kv[0], re.ASCII) else (999,)
        for ref, n in sorted((notes.get("refs") or {}).items(), key=bible_order):
            m = re.fullmatch(r"(\d+)\.(\d+)(?:\.(\d+))?", ref, re.ASCII) if isinstance(ref, str) else None
            if not m or not isinstance(n, dict) or not 1 <= int(m.group(1)) <= 66:
                continue
            book = books[int(m.group(1)) - 1]
            ch, vs = str(int(m.group(2))), (str(int(m.group(3))) if m.group(3) else None)  # never "John 03.16.md"
            title = f"{book} {ch}.{vs}" if vs else f"{book} {ch}"
            human = f"{book} {ch}:{vs}" if vs else f"{book} {ch}"
            # each tag a quoted YAML scalar; Obsidian tags cannot hold spaces (legacy PUT stores notes unvalidated)
            tags = "".join(", " + json.dumps(re.sub(r"\s+", "-", str(t).strip()), ensure_ascii=False) for t in _list(n.get("tags")) if str(t).strip())
            lines = ["---", f'reference: "{human}"', f"tags: [bible, study-note{tags}]", "---", f"# {human}", ""]
            if n.get("highlight"):
                lines.append(f"Highlight: {n['highlight']}\n")
            if n.get("text"):
                lines += [_vault_links(str(n["text"]).rstrip()), ""]
            if _list(n.get("videos")):
                lines.append("## Videos")
                for v in n["videos"]:
                    if not isinstance(v, dict) or not v.get("url"):
                        continue
                    start = _nonneg_int(v.get("start"))
                    url = (f"https://www.youtube.com/watch?v={v['id']}" if isinstance(v.get("id"), str) and re.fullmatch(r"[\w-]{6,64}", v["id"]) else str(v["url"]))
                    if start: url += ("&" if "?" in url else "?") + f"t={start}s"
                    vtitle = re.sub(r"([\[\]\\])", r"\\\1", str(v.get("title") or v["url"]))
                    lines.append(f"- [{vtitle}]({url})" + (f" @ {_clock(start)}" if start else ""))
                lines.append("")
            marked = hl.pop(f"{int(m.group(1))}.{ch}.{vs}", None) if vs else None
            if marked:
                lines += ["## Highlights", *marked, ""]
            here = conn.pop(f"{int(m.group(1))}.{ch}.{vs}", None) if vs else None
            if here:
                lines += ["## Connections", *here, ""]
            lines.append(_vault_footer(book, ch, vs))
            z.writestr(f"study-notes/{title}.md", "\n".join(lines))
            entries.append(((int(m.group(1)), int(ch)) + ((int(vs),) if vs else ()), f"- [[study-notes/{title}|{human}]]"))
        for key in sorted(set(conn) | set(hl), key=lambda k: tuple(int(x) for x in k.split("."))):  # no note
            b, ch, vs = (int(x) for x in key.split("."))
            book, human = books[b - 1], f"{books[b - 1]} {ch}:{vs}"
            entries.append(((b, ch, vs), f"- [[study-notes/{book} {ch}.{vs}|{human}]]"))
            lines = ["---", f'reference: "{human}"', "tags: [bible, study-note]", "---", f"# {human}", ""]
            for head, part in (("## Highlights", hl.get(key)), ("## Connections", conn.get(key))):
                if part:
                    lines += [head, *part, ""]
            lines.append(_vault_footer(book, ch, vs))
            z.writestr(f"study-notes/{book} {ch}.{vs}.md", "\n".join(lines))
        index += [line for _, line in sorted(entries, key=lambda e: e[0])]
        if conn_md:
            z.writestr("study-notes/Connections.md", "\n".join(conn_md) + "\n")
            index += ([""] if index[-1] != "" else []) + ["- [[study-notes/Connections|Connections]]"]
        z.writestr("study-notes/Study Notes Index.md", "\n".join(index))
        lib = library or {}
        bms = lib.get("bookmarks") or []
        if bms:
            out = ["# Bookmarks", ""]
            for bm in sorted(bms, key=lambda x: _nonneg_int(x.get("created")), reverse=True):
                p = parse_ref(bm.get("ref"))
                if not p:
                    continue
                out.append("- " + _vault_link(*p) + (f" · {bm['label']}" if bm.get("label") else ""))
            z.writestr("study-notes/Bookmarks.md", "\n".join(out) + "\n")
        chs = lib.get("chapters") or {}
        read = {}
        for k, ch in chs.items():
            p = parse_ref(k)
            if p and not p[2] and ch.get("read"):
                read.setdefault(p[0], []).append(p[1])
        if read:
            n = sum(len(v) for v in read.values())
            out = ["# Reading progress", "", f"{n:,} of {meta()['total']:,} chapters read", ""]
            for b in sorted(read):
                cs = sorted(read[b])
                out += [f"## {books[b - 1]} ({len(cs)}/{chapters_in(b)})", " · ".join(_vault_link(b, c) for c in cs), ""]
            z.writestr("study-notes/Reading Progress.md", "\n".join(out))
    return buf.getvalue()
