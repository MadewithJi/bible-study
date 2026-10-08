#!/usr/bin/env python3
"""
Integration tests for serve.py + accounts.py (profiles, per-scope notes, library, export).

  python3 tests/test_server.py          # about a minute (password hashing is deliberately slow)
  python3 tests/test_server.py -v       # list every test
  BS_TEST_KEEP=1 python3 tests/test_server.py   # keep the temp data dir and server log afterwards

Starts its own serve.py on a free port with a temporary --data-dir (never port 8765, never notes/),
restarting it between groups so in-memory rate limits start fresh. Accounts use @example.test
addresses; generated passwords are written only to .design/servertest/test-accounts.json (0600)
and are never printed. Standard library only (urllib + http.cookiejar + socket + subprocess).
"""
import datetime, hashlib, http.cookiejar, io, json, os, re, secrets, shutil, socket, stat, subprocess, sys
import tempfile, threading, time, unittest, urllib.error, urllib.request, uuid, zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
import accounts  # noqa: E402

SERVE = os.path.join(REPO, "serve.py")
PY = sys.executable or "/usr/bin/python3"
ACCOUNTS_FILE = os.path.join(REPO, ".design", "servertest", "test-accounts.json")
RUN = secrets.token_hex(3)
REAL_PORT = 8765
SEED_NOTES = {"refs": {
    "43.3.16": {"text": "Seed note", "highlight": "yellow", "tags": ["seed"], "videos": [], "created": 1, "updated": 1},
    "1.1": {"text": "Chapter seed", "highlight": "", "tags": [], "videos": [], "created": 1, "updated": 1}},
    "studies": []}
H = None      # the Harness
S = {}        # state shared between test classes (clients, uids)


def now_ms():
    return int(time.time() * 1000)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def record_accounts(path, entries, renamed=None):
    """Merge `entries` into the shared accounts file (a JSON list) without losing anyone else's entries.

    Other agents append to the same file, so this is read-merge-write under an exclusive lock: flock on the
    file itself and on the `.lock-ap` sidecar that other test helpers use. An entry replaces the one with the
    same email (or with its previous email, `renamed[new] = old`); everything else is kept in order."""
    import fcntl
    renamed = renamed or {}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    side = os.open(path + ".lock-ap", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(side, fcntl.LOCK_EX)
        while True:
            fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                if os.fstat(fd).st_ino == os.stat(path).st_ino:
                    break  # still the live file (not replaced while we waited for the lock)
            except FileNotFoundError:
                pass
            os.close(fd)
        try:
            raw = b""
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                raw += chunk
            try:
                current = json.loads(raw.decode("utf-8") or "[]")
            except ValueError:
                current = None
            if not isinstance(current, list):
                if raw.strip():  # never discard a file we cannot read: keep it next to the new one
                    with open(f"{path}.unreadable-{int(time.time())}", "wb") as f:
                        f.write(raw)
                current = []
            out, placed = [], set()
            for old in current:
                email = old.get("email") if isinstance(old, dict) else None
                match = [e for e in entries if email in (e["email"], renamed.get(e["email"]))] if email else []
                if match:
                    if match[0]["email"] not in placed:
                        out.append(dict(match[0]))
                        placed.add(match[0]["email"])
                    continue
                out.append(old)
            out += [dict(e) for e in entries if e["email"] not in placed]
            data = json.dumps(out, indent=1).encode("utf-8")
            os.lseek(fd, 0, os.SEEK_SET)
            os.ftruncate(fd, 0)
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fchmod(fd, 0o600)
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        os.close(side)


# The hosting variables (hosting brief §1). The test server never inherits them: each test sets the ones it is about.
HOSTING_ENV = ("PORT", "HOST", "BS_DATA_DIR", "BS_HOSTED", "BS_ALLOWED_HOSTS", "BS_ALLOWED_ORIGINS", "BS_TRUST_PROXY",
               "BS_OWNER_EMAILS", "BS_PROXY_SECRET", "BS_OWNER_SETUP_TOKEN", "RAILWAY_VOLUME_MOUNT_PATH")


def server_env(extra=None):
    env = {k: v for k, v in os.environ.items() if k not in HOSTING_ENV}
    env.update(extra or {})
    return env


def port_answers(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return True
    except OSError:
        return False


class Harness:
    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="bs-servertest-")
        self.data = os.path.join(self.tmp, "data")
        os.makedirs(self.data)
        open(os.path.join(self.data, ".servertest"), "w").close()
        with open(os.path.join(self.data, "notes.json"), "w", encoding="utf-8") as f:
            json.dump(SEED_NOTES, f)
        self.log_path = os.path.join(self.tmp, "server.log")
        self.port = free_port()
        assert self.port != REAL_PORT
        self.proc, self.logf = None, None
        self.accounts, self.passwords, self.tokens = [], set(), set()

    @property
    def cookie(self):
        return f"bs_sid_{self.port}"

    def start(self, *extra, env=None):
        if port_answers(self.port):
            raise RuntimeError(f"something already answers on port {self.port}")
        self.logf = open(self.log_path, "ab")
        self.proc = subprocess.Popen([PY, SERVE, "--port", str(self.port), "--data-dir", self.data, *extra],
                                     stdout=self.logf, stderr=self.logf, stdin=subprocess.DEVNULL, env=server_env(env))
        deadline = time.time() + 15
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("test server exited during startup; see " + self.log_path)
            try:
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
                        f"http://127.0.0.1:{self.port}/api/auth/me", timeout=1):
                    return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("test server did not start")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(5)
        self.proc = None
        if self.logf:
            self.logf.close()
            self.logf = None

    def restart(self, *extra, env=None):
        self.stop()
        self.start(*extra, env=env)

    def account(self, name, purpose):
        email = f"{name}-{RUN}@example.test"
        pw = secrets.token_urlsafe(18)
        entry = {"email": email, "password": pw, "purpose": purpose}
        self.accounts.append(entry)
        self.passwords.add(pw)
        record_accounts(ACCOUNTS_FILE, [entry])
        return email, pw

    def update_account(self, old_email, email=None, password=None):
        for a in self.accounts:
            if a["email"] == old_email:
                if email:
                    a["email"] = email
                if password:
                    a["password"] = password
                    self.passwords.add(password)
                record_accounts(ACCOUNTS_FILE, [a], renamed={a["email"]: old_email})

    def cleanup(self):
        self.stop()
        if os.environ.get("BS_TEST_KEEP"):
            print(f"\nkept test data in {self.tmp}", file=sys.stderr)
        else:
            shutil.rmtree(self.tmp, ignore_errors=True)

    def read(self, *parts):
        with open(os.path.join(self.data, *parts), encoding="utf-8") as f:
            return json.load(f)


class Resp:
    def __init__(self, status, headers, raw):
        self.status, self.headers, self.raw = status, headers, raw or b""
        self.json = None
        if headers is not None and "application/json" in (headers.get("Content-Type") or ""):
            try:
                self.json = json.loads(self.raw.decode("utf-8"))
            except ValueError:
                pass

    def set_cookies(self):
        return (self.headers.get_all("Set-Cookie") if self.headers is not None else None) or []

    def __repr__(self):
        return f"<Resp {self.status} {self.raw[:400]!r}>"


class Client:
    """One browser tab. Two Clients sharing a jar are two tabs of one browser."""

    def __init__(self, jar=None, scope="guest"):
        self.jar = jar if jar is not None else http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.jar))
        self.scope = scope

    def tab(self):
        return Client(self.jar, self.scope)

    def req(self, method, path, body=None, headers=None, raw=None, scoped=False, timeout=60):
        hdrs = {}
        data = None
        if method not in ("GET", "HEAD"):
            data = raw if raw is not None else json.dumps({} if body is None else body).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
        if scoped:
            hdrs["X-BS-Scope"] = self.scope
        for k, v in (headers or {}).items():
            if v is None:
                hdrs.pop(k, None)
            else:
                hdrs[k] = v
        r = urllib.request.Request(f"http://127.0.0.1:{H.port}{path}", data=data, method=method, headers=hdrs)
        try:
            with self.opener.open(r, timeout=timeout) as resp:
                out = Resp(resp.status, resp.headers, resp.read())
        except urllib.error.HTTPError as e:
            out = Resp(e.code, e.headers, e.read())
        for c in out.set_cookies():
            m = re.match(rf"{H.cookie}=([^;]*)", c)
            if m and m.group(1):
                H.tokens.add(m.group(1))
        return out

    def token(self):
        for c in self.jar:
            if c.name == H.cookie:
                return c.value
        return None

    def me(self):
        r = self.req("GET", "/api/auth/me")
        self.scope = r.json["scope"]
        return r

    def signup(self, email, pw, name="Test User", remember=True, import_guest=False):
        r = self.req("POST", "/api/auth/signup", {"email": email, "name": name, "password": pw, "remember": remember,
                                                   "importGuest": import_guest})
        if r.status == 201:
            self.scope = r.json["user"]["uid"]
        return r

    def login(self, email, pw, remember=True):
        r = self.req("POST", "/api/auth/login", {"email": email, "password": pw, "remember": remember})
        if r.status == 200:
            self.scope = r.json["user"]["uid"]
        return r

    def events(self, events, batch_id=None):
        return self.req("POST", "/api/library/events", {"batchId": batch_id or uuid.uuid4().hex, "events": events}, scoped=True)

    def library(self, **params):
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        return self.req("GET", "/api/library" + ("?" + qs if qs else ""))


def with_cookie(token):
    """A fresh client that sends exactly this session cookie."""
    c = Client()
    c.opener.addheaders = [("Cookie", f"{H.cookie}={token}")]
    return c


def raw_http(data, timeout=10):
    s = socket.create_connection(("127.0.0.1", H.port), timeout=timeout)
    try:
        s.sendall(data)
        chunks = []
        while True:
            c = s.recv(65536)
            if not c:
                break
            chunks.append(c)
    finally:
        s.close()
    raw = b"".join(chunks)
    head, _, body = raw.partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    status = int(lines[0].split()[1]) if lines and len(lines[0].split()) > 1 else 0
    headers = {}
    for ln in lines[1:]:
        k, _, v = ln.partition(":")
        headers[k.strip().lower()] = v.strip()
    return status, headers, body


def raw_req(method, path, body=b"", headers=None, content_length=True):
    hdrs = {"Host": f"127.0.0.1:{H.port}"}
    hdrs.update(headers or {})
    if content_length and "Content-Length" not in hdrs:
        hdrs["Content-Length"] = str(len(body))
    head = f"{method} {path} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in hdrs.items() if v is not None) + "Connection: close\r\n\r\n"
    return raw_http(head.encode("latin-1") + body)


def json_post_bytes(path, body):
    data = json.dumps(body).encode("utf-8")
    head = (f"POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{H.port}\r\nContent-Type: application/json\r\n"
            f"Content-Length: {len(data)}\r\nConnection: close\r\n\r\n")
    return head.encode("latin-1") + data


def burst(payloads, timeout=120):
    """Open one connection per request first, then release every request at the same instant (a threading.Event
    gate), like a scripted attacker would. -> list of HTTP status codes (0 = no response)."""
    socks = []
    try:
        for _ in payloads:
            socks.append(socket.create_connection(("127.0.0.1", H.port), timeout=timeout))
        gate, out = threading.Event(), [0] * len(payloads)

        def run(i):
            try:
                gate.wait()
                socks[i].sendall(payloads[i])
                buf = b""
                while b"\r\n" not in buf:
                    chunk = socks[i].recv(4096)
                    if not chunk:
                        break
                    buf += chunk
                parts = buf.split(b" ", 2)
                out[i] = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
            except OSError:
                out[i] = 0
        threads = [threading.Thread(target=run, args=(i,)) for i in range(len(payloads))]
        [t.start() for t in threads]
        time.sleep(0.3)
        gate.set()
        [t.join() for t in threads]
        return out
    finally:
        for s in socks:
            s.close()


def read_json_file(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def put_raw(path, data):
    """Replace a data file the way the server does (write a sibling, then rename), outside the server."""
    tmp = path + ".testwrite"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def local_noon_ms(day):
    return int(datetime.datetime.combine(day, datetime.time(12, 0)).timestamp() * 1000)


def shared_account_emails():
    try:
        with open(ACCOUNTS_FILE, encoding="utf-8") as f:
            lst = json.load(f)
    except (OSError, ValueError):
        return set()
    return {a.get("email") for a in lst if isinstance(a, dict)} if isinstance(lst, list) else set()


PRE_EXISTING_ACCOUNTS = set()


def setUpModule():
    global H
    PRE_EXISTING_ACCOUNTS.update(shared_account_emails())
    H = Harness()
    H.start()


def tearDownModule():
    if H:
        H.cleanup()


class Base(unittest.TestCase):
    restart = True

    @classmethod
    def setUpClass(cls):
        if cls.restart:
            H.restart()

    def assertErr(self, r, status, code, field=None):
        self.assertEqual(r.status, status, r)
        self.assertIsNotNone(r.json, r)
        self.assertEqual(r.json.get("error"), code, r)
        self.assertIn("message", r.json)
        if field is not None:
            self.assertEqual(r.json.get("field"), field, r)


# ======================================================================= A. startup and CLI
class T01_Startup(Base):
    restart = False

    def test_a1_data_dir_inside_app_refused(self):
        bad = os.path.join(REPO, "app", f"tmpx-{RUN}")
        p = subprocess.run([PY, SERVE, "--port", str(free_port()), "--data-dir", bad], capture_output=True, text=True, timeout=30)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("inside app/", p.stderr)
        self.assertFalse(os.path.exists(bad), "the refused data dir must not be created")

    def test_a2_second_server_on_same_data_refused(self):
        p = subprocess.run([PY, SERVE, "--port", str(free_port()), "--data-dir", H.data], capture_output=True, text=True, timeout=30)
        self.assertEqual(p.returncode, 1)
        self.assertIn("already using", p.stderr)

    def test_a3_list_users_empty(self):
        d = tempfile.mkdtemp(prefix="bs-servertest-empty-")
        try:
            p = subprocess.run([PY, SERVE, "--list-users", "--data-dir", d], capture_output=True, text=True, timeout=30)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(p.stdout.strip(), "No profiles.")
        finally:
            shutil.rmtree(d, ignore_errors=True)


# ======================================================================= B/C. guest compatibility, host, CSRF, bodies
class T02_GuestCompat(Base):
    restart = False

    def test_b1_guest_notes_get(self):
        r = Client().req("GET", "/api/notes")
        self.assertEqual(r.status, 200)
        self.assertEqual(set(r.json["refs"]), {"43.3.16", "1.1"})
        self.assertIsInstance(r.json["rev"], int)
        self.assertEqual(r.json["scope"], "guest")
        self.assertEqual(r.headers["ETag"], f'"{r.json["rev"]}"')
        self.assertEqual(r.headers["X-BS-Scope"], "guest")
        self.assertEqual(r.headers["Cache-Control"], "no-store")
        self.assertNotIn("deleted", r.json)

    def test_b2_legacy_client_put_roundtrip(self):
        """Exactly what the pre-profiles store.js does: GET, then PUT the whole {refs, studies} object."""
        c = Client()
        cur = c.req("GET", "/api/notes").json
        refs = dict(cur["refs"])
        refs["19.23"] = {"text": "Psalm 23", "highlight": "green", "tags": [], "videos": [], "created": 2, "updated": 2, "preview": True}
        r = c.req("PUT", "/api/notes", {"refs": refs, "studies": []},
                  headers={"Origin": f"http://127.0.0.1:{H.port}", "Sec-Fetch-Site": "same-origin"})
        self.assertEqual(r.status, 200, r)
        self.assertTrue(r.json["ok"])
        self.assertEqual(r.json["rev"], cur["rev"] + 1)
        on_disk = H.read("notes.json")
        self.assertEqual(set(on_disk["refs"]), {"43.3.16", "1.1", "19.23"})
        self.assertTrue(on_disk["refs"]["19.23"]["preview"], "unknown note fields are preserved")
        self.assertEqual(on_disk["rev"], cur["rev"] + 1)
        self.assertEqual(c.req("GET", "/api/notes").json["refs"], refs)

    def test_b3_config_roundtrip(self):
        c = Client()
        r = c.req("PUT", "/api/config", {"esvKey": "test-not-a-key"})
        self.assertEqual(r.status, 200, r)
        self.assertEqual(r.json, {"esv": True, "nlt": False})
        self.assertEqual(c.req("GET", "/api/config").json, {"esv": True, "nlt": False})
        self.assertEqual(c.req("PUT", "/api/config", {"esvKey": ""}).json["esv"], False)
        self.assertEqual(c.req("GET", "/api/config").json, {"esv": False, "nlt": False}, "an emptied key reads back as off")

    def test_b4_unknown_path_and_wrong_method(self):
        c = Client()
        self.assertErr(c.req("GET", "/api/nope"), 404, "not_found")
        r = c.req("POST", "/api/notes", {})
        self.assertErr(r, 405, "method_not_allowed")
        self.assertIn("GET", r.headers["Allow"])
        self.assertIn("PUT", r.headers["Allow"])

    def test_b5_static_headers(self):
        r = Client().req("GET", "/")
        self.assertEqual(r.status, 200)
        self.assertIn(b"<html", r.raw.lower())
        self.assertEqual(r.headers["X-Frame-Options"], "DENY")
        self.assertEqual(r.headers["X-Content-Type-Options"], "nosniff")
        self.assertIn("frame-ancestors 'none'", r.headers["Content-Security-Policy"])
        self.assertIsNone(r.headers.get("Referrer-Policy"))

    def test_b6_static_404_gets_a_response(self):
        self.assertEqual(Client().req("GET", "/definitely-missing.txt").status, 404)

    def test_c1_bad_host(self):
        c = Client()
        for path in ("/api/notes", "/"):
            r = c.req("GET", path, headers={"Host": f"evil.example:{H.port}"})
            self.assertEqual(r.status, 403, path)
        self.assertErr(c.req("GET", "/api/notes", headers={"Host": f"evil.example:{H.port}"}), 403, "bad_host")
        self.assertEqual(c.req("GET", "/api/notes", headers={"Host": f"localhost:{H.port}"}).status, 200)
        self.assertEqual(c.req("GET", "/api/notes", headers={"Host": "127.0.0.1:1"}).status, 403)
        st, _, _ = raw_http(b"GET /api/notes HTTP/1.0\r\n\r\n")
        self.assertEqual(st, 403, "a request without Host is refused")

    def test_c2_wrong_content_type(self):
        c = Client()
        self.assertErr(c.req("POST", "/api/auth/login", {"email": "x@example.test", "password": "y"},
                             headers={"Content-Type": "text/plain"}), 415, "unsupported_media_type")
        self.assertErr(c.req("PUT", "/api/notes", raw=b"refs=1", headers={"Content-Type": None}), 415, "unsupported_media_type")
        st, _, body = raw_req("POST", "/api/auth/logout", b"{}")  # no Content-Type at all
        self.assertEqual(st, 415)
        self.assertEqual(json.loads(body)["error"], "unsupported_media_type")
        self.assertEqual(c.req("PUT", "/api/config", {}, headers={"Content-Type": "application/json; charset=utf-8"}).status, 200)

    def test_c3_origin(self):
        c = Client()
        self.assertErr(c.req("PUT", "/api/config", {}, headers={"Origin": "http://evil.example"}), 403, "csrf")
        self.assertErr(c.req("PUT", "/api/config", {}, headers={"Origin": "null"}), 403, "csrf")
        self.assertErr(c.req("PUT", "/api/config", {}, headers={"Origin": f"http://localhost:{H.port}"}), 403, "csrf")
        self.assertErr(c.req("PUT", "/api/notes", {"refs": {}}, headers={"Origin": "http://evil.example"}), 403, "csrf")
        self.assertEqual(c.req("PUT", "/api/config", {}, headers={"Origin": f"http://127.0.0.1:{H.port}"}).status, 200)
        self.assertEqual(set(H.read("notes.json")["refs"]), {"43.3.16", "1.1", "19.23"}, "blocked PUT wrote nothing")

    def test_c4_fetch_metadata(self):
        c = Client()
        self.assertErr(c.req("PUT", "/api/config", {}, headers={"Sec-Fetch-Site": "cross-site"}), 403, "csrf")
        self.assertErr(c.req("PUT", "/api/config", {}, headers={"Sec-Fetch-Site": "same-site"}), 403, "csrf")
        self.assertEqual(c.req("PUT", "/api/config", {}, headers={"Sec-Fetch-Site": "same-origin"}).status, 200)
        self.assertEqual(c.req("PUT", "/api/config", {}, headers={"Sec-Fetch-Site": "none"}).status, 200)

    def test_c5_options_and_head(self):
        c = Client()
        r = c.req("OPTIONS", "/api/notes", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "PUT"})
        self.assertEqual(r.status, 405)
        self.assertFalse([k for k in r.headers.keys() if k.lower().startswith("access-control-")])
        self.assertEqual(c.req("HEAD", "/api/notes").status, 405)

    def test_c6_body_limits_and_malformed_json(self):
        c = Client()
        big = json.dumps({"batchId": "b" * 16, "events": [{"type": "chapter.open", "pad": "x" * (129 * 1024)}]}).encode()
        self.assertErr(c.req("POST", "/api/library/events", raw=big, scoped=True), 413, "too_large")
        self.assertErr(c.req("POST", "/api/auth/signup", raw=b'{"pad": "' + b"x" * (17 * 1024) + b'"}'), 413, "too_large")
        # declared 9 MiB on the legacy PUT: refused before the body is read
        t0 = time.time()
        st, _, body = raw_req("PUT", "/api/notes", b"", {"Content-Type": "application/json", "Content-Length": str(9 * 1024 * 1024)})
        self.assertEqual(st, 413)
        self.assertLess(time.time() - t0, 5)
        st, _, body = raw_req("POST", "/api/auth/logout", b"{}", {"Content-Type": "application/json"}, content_length=False)
        self.assertEqual(st, 411)
        self.assertEqual(json.loads(body)["error"], "length_required")
        st, _, _ = raw_req("POST", "/api/auth/logout", b"2\r\n{}\r\n0\r\n\r\n",
                           {"Content-Type": "application/json", "Transfer-Encoding": "chunked"}, content_length=False)
        self.assertEqual(st, 411)
        for raw in (b"{", b"[]", b'"x"', b"", b'{"a": NaN}', b"\xff\xfe{}", b'{"a":' + b"[" * 4000 + b"]" * 4000 + b"}", b'{"a": 1} x'):
            self.assertErr(c.req("PUT", "/api/config", raw=raw), 400, "bad_json")
        self.assertErr(c.req("POST", "/api/library/events", raw=b"{", scoped=True), 400, "bad_json")

    def test_c7_path_traversal(self):
        for path in ("/../notes/notes.json", "/../serve.py", "/%2e%2e/notes/notes.json", "/..%2fnotes%2fusers.json",
                     "/api/../../notes/notes.json", "/data/../../notes/notes.json", "/%2e%2e/%2e%2e/etc/passwd"):
            st, _, body = raw_req("GET", path)
            self.assertIn(st, (403, 404), path)
            self.assertNotIn(b"Seed note", body, path)
            self.assertNotIn(b"import argparse", body, path)
        for method, path in (("DELETE", "/api/library/bookmarks/../../x"), ("PATCH", "/api/library/bookmarks/..%2f..%2fusers.json"),
                             ("DELETE", "/api/library/bookmarks/bm_000000000000/../../../users.json"),
                             ("PATCH", "/api/library/bookmarks/bm_zz")):
            st, _, body = raw_req(method, path, b"{}", {"Content-Type": "application/json", "X-BS-Scope": "guest"})
            self.assertEqual(st, 404, f"{method} {path}")
        c = Client()
        r = c.req("POST", "/api/library/events", {"batchId": "trav-" + RUN, "events": [{"type": "chapter.open", "t": now_ms(), "b": 1, "c": 1}]},
                  headers={"X-BS-Scope": "../../users"})
        self.assertErr(r, 409, "scope_mismatch")
        r = c.req("GET", "/api/notes?scope=u0000000000000000&uid=../users")
        self.assertEqual(r.json["scope"], "guest", "the scope comes only from the session, never from the query")


# ======================================================================= D. signup and sessions
class T03_Signup(Base):
    def test_d1_signup_validation(self):
        c = Client()
        email, _ = H.account("val", "validation only (never created)")
        cases = [({"email": "not-an-email", "name": "V", "password": secrets.token_urlsafe(12)}, "invalid_email", "email"),
                 ({"email": email, "name": "   ", "password": secrets.token_urlsafe(12)}, "invalid_name", "name"),
                 ({"email": email, "name": "x" * 61, "password": secrets.token_urlsafe(12)}, "invalid_name", "name"),
                 ({"email": email, "name": "V", "password": "abc1234"}, "weak_password", "password"),
                 ({"email": email, "name": "V", "password": "password123"}, "weak_password", "password"),
                 ({"email": email, "name": "V", "password": email.upper()}, "weak_password", "password"),
                 ({"email": email, "name": "V", "password": email.split("@")[0]}, "weak_password", "password"),
                 ({"email": email, "name": "V", "password": " " * 12}, "weak_password", "password"),
                 ({"email": email, "name": "V", "password": "x" * 257}, "weak_password", "password"),
                 ({"email": email, "name": "V"}, "weak_password", "password")]
        for body, code, field in cases:
            self.assertErr(c.req("POST", "/api/auth/signup", body), 400, code, field)
        users = H.read("users.json")["users"] if os.path.exists(os.path.join(H.data, "users.json")) else {}
        self.assertFalse([u for u in users.values() if u["email"] == email])

    def test_d2_signup_remember_with_guest_import(self):
        email, pw = H.account("alice", "main profile (remember, imported guest data)")
        guest_before = H.read("notes.json")
        c = Client()
        r = c.signup(email, pw, name="Alice  Test", remember=True, import_guest=True)
        self.assertEqual(r.status, 201, r)
        self.assertEqual(r.json["user"]["email"], email)
        self.assertEqual(r.json["user"]["name"], "Alice Test", "whitespace is collapsed")
        self.assertEqual(r.json["user"]["initials"], "AT")
        self.assertEqual(r.json["imported"], {"notes": 3, "bookmarks": 0, "chapters": 0, "links": 0, "marks": 0})
        cookies = r.set_cookies()
        self.assertEqual(len(cookies), 1)
        ck = cookies[0]
        self.assertTrue(ck.startswith(H.cookie + "="), ck[:20])
        attrs = [a.strip() for a in ck.split(";")[1:]]
        self.assertIn("HttpOnly", attrs)
        self.assertIn("SameSite=Strict", attrs)
        self.assertIn("Path=/", attrs)
        self.assertIn("Max-Age=2592000", attrs)
        self.assertFalse([a for a in attrs if a.lower().startswith(("secure", "domain", "expires"))])
        self.assertEqual(r.headers["X-BS-Scope"], r.json["user"]["uid"])
        me = c.me().json
        self.assertTrue(me["signedIn"])
        self.assertEqual(me["scope"], r.json["user"]["uid"])
        self.assertEqual(me["user"]["initials"], "AT")
        self.assertTrue(me["session"]["remember"])
        self.assertGreater(me["session"]["expires"], now_ms() + 29 * 86400 * 1000)
        self.assertEqual(me["guest"]["notes"], 3)
        # E1: profile notes = the guest notes; the guest file is unchanged (copy, not move)
        n = c.req("GET", "/api/notes").json
        self.assertEqual(n["scope"], me["scope"])
        self.assertEqual(n["refs"], guest_before["refs"])
        self.assertEqual(H.read("notes.json"), guest_before)
        lib = c.library().json
        self.assertEqual([a["type"] for a in lib["activity"]][:2], ["profile.import", "profile.create"])
        S.update(alice=c, alice_email=email, alice_uid=me["scope"])

    def test_d3_signup_session_cookie_no_import(self):
        email, pw = H.account("bob", "second profile (session cookie, no import)")
        c = Client()
        r = c.signup(email, pw, name="Bob", remember=False, import_guest=False)
        self.assertEqual(r.status, 201, r)
        self.assertIsNone(r.json["imported"])
        attrs = [a.strip().lower() for a in r.set_cookies()[0].split(";")[1:]]
        self.assertFalse([a for a in attrs if a.startswith(("max-age", "expires"))], attrs)
        self.assertIn("httponly", attrs)
        self.assertIn("samesite=strict", attrs)
        me = c.me().json
        self.assertTrue(me["signedIn"])
        self.assertFalse(me["session"]["remember"])
        self.assertLess(me["session"]["expires"], now_ms() + 13 * 3600 * 1000)
        self.assertEqual(me["user"]["initials"], "B")
        n = c.req("GET", "/api/notes").json  # E2
        self.assertEqual(n["refs"], {})
        self.assertEqual(n["scope"], me["scope"])
        S.update(bob=c, bob_email=email, bob_uid=me["scope"])

    def test_d4_duplicate_email(self):
        email = S["alice_email"]
        r = Client().req("POST", "/api/auth/signup", {"email": "  " + email.upper() + " ", "name": "Dup", "password": secrets.token_urlsafe(12)})
        self.assertErr(r, 409, "email_taken", "email")
        users = H.read("users.json")["users"]
        self.assertEqual(sum(1 for u in users.values() if u["email"] == email), 1)

    def test_d5_token_and_hash_hygiene(self):
        tok = S["alice"].token()
        self.assertTrue(tok and re.fullmatch(r"[A-Za-z0-9_-]{43}", tok))
        sessions = H.read("sessions.json")["sessions"]
        self.assertIn(hashlib.sha256(tok.encode()).hexdigest(), sessions)
        for root, _, files in os.walk(H.data):
            for fn in files:
                with open(os.path.join(root, fn), "rb") as f:
                    self.assertFalse(tok.encode() in f.read(), f"raw token found in {fn}")
        users = H.read("users.json")["users"]
        for u in users.values():
            self.assertTrue(u["pw"].startswith("scrypt$" if hasattr(hashlib, "scrypt") else "pbkdf2_sha256$600000$"))
        for r in (S["alice"].me(), S["alice"].req("GET", "/api/library")):
            self.assertNotIn(b'"pw"', r.raw)
            self.assertNotIn(tok.encode(), r.raw)
        # A4: file modes
        uid = S["alice_uid"]
        for rel in ("users.json", "sessions.json", f"profiles/{uid}/notes.json", f"profiles/{uid}/library.json"):
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(H.data, rel)).st_mode), 0o600, rel)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(H.data, "profiles", uid)).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(H.data, "profiles")).st_mode), 0o700)


class T04_Login(Base):
    def test_d6_wrong_password_and_unknown_email_identical(self):
        c = Client()
        a = c.req("POST", "/api/auth/login", {"email": S["alice_email"], "password": "wrong-" + secrets.token_urlsafe(8)})
        b = c.req("POST", "/api/auth/login", {"email": f"nobody-{RUN}@example.test", "password": "wrong-" + secrets.token_urlsafe(8)})
        self.assertErr(a, 401, "bad_credentials", "password")
        self.assertEqual(a.raw, b.raw)
        self.assertEqual(a.status, b.status)
        self.assertFalse(a.set_cookies() or b.set_cookies())

    def test_d7_lockout_and_backoff(self):
        email, pw = H.account("carol", "lockout, CLI reset")
        self.assertEqual(Client().signup(email, pw, name="Carol").status, 201)
        c = Client()
        for _ in range(5):
            self.assertErr(c.req("POST", "/api/auth/login", {"email": email, "password": "nope-" + secrets.token_urlsafe(6)}), 401, "bad_credentials")
        r = c.login(email, pw)
        self.assertErr(r, 429, "rate_limited")
        self.assertGreaterEqual(int(r.headers["Retry-After"]), 1)
        self.assertEqual(r.json["retryAfter"], int(r.headers["Retry-After"]))
        u = [u for u in H.read("users.json")["users"].values() if u["email"] == email][0]
        self.assertEqual(u["failedLogins"], 5)
        time.sleep(r.json["retryAfter"] + 0.2)
        self.assertEqual(c.login(email, pw).status, 200)
        u = [u for u in H.read("users.json")["users"].values() if u["email"] == email][0]
        self.assertEqual((u["failedLogins"], u["lockUntil"]), (0, 0))
        S.update(carol_email=email)

    def test_d8_logout(self):
        email = S["alice_email"]
        pw = [a["password"] for a in H.accounts if a["email"] == email][0]
        c = Client()
        self.assertEqual(c.login(email, pw).status, 200)
        tok = c.token()
        r = c.req("POST", "/api/auth/logout", {})
        self.assertEqual(r.status, 200)
        self.assertEqual(r.json, {"ok": True, "revoked": 1})
        self.assertIn("Max-Age=0", r.set_cookies()[0])
        self.assertIsNone(c.token(), "the browser drops the cookie")
        self.assertEqual(c.me().json["scope"], "guest")
        self.assertFalse(with_cookie(tok).me().json["signedIn"], "the old token no longer works")
        self.assertEqual(c.req("POST", "/api/auth/logout", {}).json, {"ok": True, "revoked": 0})
        self.assertTrue(S["alice"].me().json["signedIn"], "other sessions are untouched")

    def test_d9_logout_everywhere(self):
        email = S["bob_email"]
        pw = [a["password"] for a in H.accounts if a["email"] == email][0]
        c1, c2 = Client(), Client()
        self.assertEqual(c1.login(email, pw, remember=False).status, 200)
        self.assertEqual(c2.login(email, pw).status, 200)
        r = c1.req("POST", "/api/auth/logout", {"all": True})
        self.assertGreaterEqual(r.json["revoked"], 3)  # c1, c2 and the signup session
        self.assertFalse(c2.me().json["signedIn"])
        self.assertFalse(S["bob"].me().json["signedIn"])
        self.assertEqual(S["bob"].login(email, pw, remember=False).status, 200)


class T05_Sessions(Base):
    def _edit_session(self, token, **fields):
        accounts.configure(H.data, H.port)
        with accounts.auth_lock():
            s = accounts.load_sessions()
            s["sessions"][hashlib.sha256(token.encode()).hexdigest()].update(fields)
            accounts.save_sessions(s)

    def _fresh_login(self, remember=True):
        email = S["carol_email"]
        pw = [a["password"] for a in H.accounts if a["email"] == email][0]
        c = Client()
        self.assertEqual(c.login(email, pw, remember=remember).status, 200)
        return c

    def test_d10_expiry_tamper_and_sliding(self):
        c = self._fresh_login()
        self._edit_session(c.token(), expires=now_ms() - 1000)
        self.assertFalse(c.me().json["signedIn"], "idle-expired session")
        c = self._fresh_login(remember=False)
        tok = c.token()
        self._edit_session(tok, hardExpires=now_ms() - 1000)
        self.assertFalse(c.me().json["signedIn"], "absolute expiry")
        for bad in ("short", "x" * 43 + "!", "../../users.json", tok[:-1] + ("A" if tok[-1] != "A" else "B")):
            r = with_cookie(bad).me()
            self.assertFalse(r.json["signedIn"])
            self.assertTrue(any("Max-Age=0" in x for x in r.set_cookies()), "/me clears an invalid cookie")
        c = self._fresh_login()
        self._edit_session(c.token(), lastSeen=now_ms() - 11 * 60 * 1000, expires=now_ms() + 60 * 1000)
        r = c.me()
        self.assertTrue(r.json["signedIn"])
        slid = [x for x in r.set_cookies() if x.startswith(H.cookie + "=")]
        self.assertEqual(len(slid), 1, "a remembered session re-sends its cookie when it slides")
        max_age = int(re.search(r"Max-Age=(\d+)", slid[0]).group(1))
        self.assertGreater(max_age, 29 * 86400)
        rec = H.read("sessions.json")["sessions"][hashlib.sha256(c.token().encode()).hexdigest()]
        self.assertGreater(rec["lastSeen"], now_ms() - 60 * 1000)
        self.assertGreater(rec["expires"], now_ms() + 29 * 86400 * 1000)
        self.assertEqual(c.me().set_cookies(), [], "no re-send within 10 minutes")

    def test_d11_password_change(self):
        email = S["carol_email"]
        old_pw = [a["password"] for a in H.accounts if a["email"] == email][0]
        c, other = self._fresh_login(), self._fresh_login()
        old_token = c.token()
        self.assertErr(c.req("POST", "/api/account/password", {"current": "wrong-" + secrets.token_urlsafe(6), "next": secrets.token_urlsafe(12)}),
                       401, "bad_credentials", "current")
        self.assertErr(c.req("POST", "/api/account/password", {"current": old_pw, "next": "short"}), 400, "weak_password", "next")
        new_pw = secrets.token_urlsafe(18)
        H.update_account(email, password=new_pw)
        r = c.req("POST", "/api/account/password", {"current": old_pw, "next": new_pw})
        self.assertEqual(r.status, 200, r)
        self.assertGreaterEqual(r.json["revokedOthers"], 1)
        self.assertNotEqual(c.token(), old_token)
        self.assertTrue(c.me().json["signedIn"], "this client's new cookie works")
        self.assertFalse(with_cookie(old_token).me().json["signedIn"], "its previous token does not")
        self.assertFalse(other.me().json["signedIn"], "other sessions are signed out")
        self.assertErr(Client().login(email, old_pw), 401, "bad_credentials")
        self.assertEqual(Client().login(email, new_pw).status, 200)

    def test_d12_account_patch(self):
        email = S["carol_email"]
        pw = [a["password"] for a in H.accounts if a["email"] == email][0]
        c = self._fresh_login()
        r = c.req("PATCH", "/api/account", {"name": "Carol  Q Public"})
        self.assertEqual(r.status, 200, r)
        self.assertEqual((r.json["user"]["name"], r.json["user"]["initials"]), ("Carol Q Public", "CP"))
        self.assertErr(c.req("PATCH", "/api/account", {"name": ""}), 400, "invalid_name", "name")
        self.assertErr(c.req("PATCH", "/api/account", {}), 400, "bad_request")
        new_email = f"carol2-{RUN}@example.test"
        self.assertErr(c.req("PATCH", "/api/account", {"email": new_email}), 400, "bad_request", "password")
        self.assertErr(c.req("PATCH", "/api/account", {"email": new_email, "password": "nope-" + secrets.token_urlsafe(6)}), 401, "bad_credentials")
        self.assertErr(c.req("PATCH", "/api/account", {"email": "bad", "password": pw}), 400, "invalid_email", "email")
        self.assertErr(c.req("PATCH", "/api/account", {"email": S["alice_email"], "password": pw}), 409, "email_taken", "email")
        H.update_account(email, email=new_email)
        r = c.req("PATCH", "/api/account", {"email": new_email.upper(), "password": pw})
        self.assertEqual(r.status, 200, r)
        self.assertEqual(r.json["user"]["email"], new_email)
        self.assertErr(Client().login(email, pw), 401, "bad_credentials")
        self.assertEqual(Client().login(new_email, pw).status, 200)
        S["carol_email"] = new_email
        self.assertErr(Client().req("PATCH", "/api/account", {"name": "Guest"}), 401, "not_signed_in")


# ======================================================================= D13 + signup/user limits
class T06_RateLimits(Base):
    def test_d13_global_auth_window(self):
        c = Client()
        statuses = [c.req("POST", "/api/auth/login", {"email": f"ghost{i}-{RUN}@example.test", "password": "x" * 12}).status for i in range(31)]
        self.assertIn(429, statuses)
        self.assertEqual(statuses[:30], [401] * 30)
        r = c.req("POST", "/api/auth/login", {"email": S["alice_email"], "password": "x" * 12})
        self.assertErr(r, 429, "rate_limited")
        self.assertIn("Retry-After", r.headers)

    def test_d14_signup_window(self):
        H.restart()
        c = Client()
        codes = []
        for i in range(11):
            email, pw = H.account(f"sg{i}", "signup rate-limit filler")
            codes.append(c.req("POST", "/api/auth/signup", {"email": email, "name": f"Filler {i}", "password": pw}).status)
        self.assertEqual(codes[:10], [201] * 10)
        self.assertEqual(codes[10], 429)

    def test_d15_user_cap(self):
        n = len(H.read("users.json")["users"])
        H.restart("--max-users", str(n + 1))
        try:
            email, pw = H.account("cap", "user-cap filler")
            self.assertEqual(Client().signup(email, pw, name="Cap").status, 201)
            email2, pw2 = H.account("cap2", "user-cap (refused)")
            self.assertErr(Client().req("POST", "/api/auth/signup", {"email": email2, "name": "Cap", "password": pw2}), 403, "user_limit")
            self.assertFalse(Client().me().json["features"]["signup"])
        finally:
            H.restart()


# ======================================================================= E. notes
class T07_Notes(Base):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        for who in ("alice", "bob"):
            email = S[f"{who}_email"]
            pw = [a["password"] for a in H.accounts if a["email"] == email][0]
            c = Client()
            assert c.login(email, pw).status == 200
            S[who] = c

    def note(self, text, updated, **kw):
        return dict({"text": text, "highlight": "", "tags": [], "videos": [], "created": updated, "updated": updated}, **kw)

    def changes(self, c, set_=None, del_=None, base=None):
        body = {"set": set_ or {}, "del": del_ or {}}
        if base is not None:
            body["baseRev"] = base
        return c.req("POST", "/api/notes/changes", body, scoped=True)

    def test_e3_set_and_delete(self):
        c = S["alice"]
        before = c.req("GET", "/api/notes").json
        t = now_ms()
        vid = {"url": "https://youtu.be/G-2e9mMf7E8", "id": "G-2e9mMf7E8", "start": 12.7, "title": "Talk", "added": t}
        r = self.changes(c, {"45.5.8": self.note("Romans", t, highlight="blue", tags=["grace"], videos=[vid])}, {"1.1": t}, base=before["rev"])
        self.assertEqual(r.status, 200, r)
        self.assertEqual((r.json["rev"], r.json["changed"], r.json["stale"], r.json["conflicts"]), (before["rev"] + 1, True, False, {}))
        disk = H.read("profiles", S["alice_uid"], "notes.json")
        self.assertEqual(disk["refs"]["45.5.8"]["text"], "Romans")
        self.assertEqual(disk["refs"]["45.5.8"]["videos"][0]["start"], 12)
        self.assertNotIn("1.1", disk["refs"])
        self.assertEqual(disk["deleted"]["1.1"], t)
        self.assertEqual(disk["rev"], before["rev"] + 1)
        self.assertIn("1.1", H.read("notes.json")["refs"], "guest notes are separate")

    def test_e4_older_set_conflicts(self):
        c = S["alice"]
        stored = c.req("GET", "/api/notes").json["refs"]["45.5.8"]
        r = self.changes(c, {"45.5.8": self.note("stale edit", stored["updated"] - 5000)})
        self.assertEqual(r.json["conflicts"], {"45.5.8": stored})
        self.assertFalse(r.json["changed"])
        self.assertEqual(c.req("GET", "/api/notes").json["refs"]["45.5.8"], stored)

    def test_e5_older_delete_conflicts(self):
        c = S["alice"]
        stored = c.req("GET", "/api/notes").json["refs"]["45.5.8"]
        r = self.changes(c, del_={"45.5.8": stored["updated"] - 1})
        self.assertEqual(r.json["conflicts"], {"45.5.8": stored})
        self.assertIn("45.5.8", c.req("GET", "/api/notes").json["refs"])

    def test_e6_stale_base_rev(self):
        c = S["alice"]
        rev = c.req("GET", "/api/notes").json["rev"]
        r = self.changes(c, {"45.5.9": self.note("x", now_ms())}, base=rev - 1)
        self.assertTrue(r.json["stale"])
        self.assertFalse(self.changes(c, {"45.5.10": self.note("y", now_ms())}, base=r.json["rev"]).json["stale"])

    def test_e7_scope_header_rules(self):
        a, g = S["alice"], Client()
        r = a.req("POST", "/api/notes/changes", {"set": {}}, headers={"X-BS-Scope": "guest"})
        self.assertErr(r, 409, "scope_mismatch")
        self.assertEqual(r.json["scope"], S["alice_uid"])
        r = g.req("POST", "/api/notes/changes", {"set": {}}, headers={"X-BS-Scope": S["alice_uid"]})
        self.assertErr(r, 409, "scope_mismatch")
        self.assertEqual(r.json["scope"], "guest")
        self.assertErr(a.req("POST", "/api/notes/changes", {"set": {}}), 400, "scope_required")
        # Bob cannot write into Alice's profile by naming her uid
        r = S["bob"].req("POST", "/api/notes/changes", {"set": {"43.1.1": self.note("bob was here", now_ms())}}, headers={"X-BS-Scope": S["alice_uid"]})
        self.assertErr(r, 409, "scope_mismatch")
        self.assertNotIn("43.1.1", a.req("GET", "/api/notes").json["refs"])

    def test_e8_legacy_put_while_signed_in(self):
        a = S["alice"]
        prof = H.read("profiles", S["alice_uid"], "notes.json")
        guest = H.read("notes.json")
        self.assertErr(a.req("PUT", "/api/notes", {"refs": {}, "studies": []}), 409, "scope_required")
        self.assertEqual(H.read("profiles", S["alice_uid"], "notes.json"), prof)
        self.assertEqual(H.read("notes.json"), guest)
        self.assertErr(a.req("PUT", "/api/notes", {"refs": {}}, headers={"X-BS-Scope": "guest"}), 409, "scope_mismatch")
        refs = dict(prof["refs"])
        refs["62.4.8"] = self.note("God is love", now_ms())
        r = a.req("PUT", "/api/notes", {"refs": refs, "studies": []}, scoped=True)
        self.assertEqual(r.status, 200, r)
        self.assertIn("62.4.8", H.read("profiles", S["alice_uid"], "notes.json")["refs"])
        self.assertEqual(H.read("notes.json"), guest)

    def test_e9_put_if_match(self):
        a = S["alice"]
        cur = a.req("GET", "/api/notes").json
        r = a.req("PUT", "/api/notes", {"refs": cur["refs"]}, headers={"If-Match": f'"{cur["rev"] - 1}"'}, scoped=True)
        self.assertErr(r, 409, "rev_conflict")
        self.assertEqual(r.json["rev"], cur["rev"])
        self.assertEqual(a.req("PUT", "/api/notes", {"refs": cur["refs"]}, headers={"If-Match": f'"{cur["rev"]}"'}, scoped=True).status, 200)
        self.assertErr(Client().req("PUT", "/api/notes", {"refs": []}), 400, "bad_request")

    def test_e10_invalid_notes(self):
        a = S["alice"]
        before = H.read("profiles", S["alice_uid"], "notes.json")
        ok = self.note("fine", now_ms())
        for key in ("67.1.1", "43.22.1", "43.3.37", "0.1", "43", "43.3.16.1", "../../x", "43.3.16\n"):
            self.assertErr(self.changes(a, {"40.1.1": ok, key: ok}), 400, "invalid_note", key)
        bad_notes = [self.note("x" * 100001, 1), self.note("x", 1, highlight="purple"), self.note("x", 1, tags=["t" * 65]),
                     self.note("x", 1, tags=["t"] * 51), self.note("x", 1, videos=[{"url": 5}]), self.note("x", True),
                     "not an object", self.note("x", 1, videos=[{"url": "u", "start": -1}])]
        for n in bad_notes:
            self.assertErr(self.changes(a, {"40.1.1": ok, "40.1.2": n}), 400, "invalid_note", "40.1.2")
        self.assertErr(self.changes(a, del_={"40.1.1": "yesterday"}), 400, "invalid_note", "40.1.1")
        self.assertErr(self.changes(a, {"40.1.1": ok}, {"40.1.1": now_ms()}), 400, "invalid_note")
        self.assertErr(a.req("POST", "/api/notes/changes", {"set": []}, scoped=True), 400, "bad_request")
        self.assertEqual(H.read("profiles", S["alice_uid"], "notes.json"), before, "nothing applied")

    def test_e11_two_tabs_no_lost_updates(self):
        a = S["alice"]
        start = a.req("GET", "/api/notes").json["rev"]
        errors = []

        def tab(verses):
            t = a.tab()
            for v in verses:
                r = self.changes(t, {f"19.119.{v}": self.note(f"verse {v}", now_ms())})
                if r.status != 200 or not r.json["changed"]:
                    errors.append(r)
        th = [threading.Thread(target=tab, args=(range(1, 51),)), threading.Thread(target=tab, args=(range(51, 101),))]
        [t.start() for t in th]
        [t.join() for t in th]
        self.assertEqual(errors, [])
        n = a.req("GET", "/api/notes").json
        self.assertEqual({f"19.119.{v}" for v in range(1, 101)} - set(n["refs"]), set())
        self.assertEqual(n["rev"], start + 100)

    def test_e12_delete_then_stale_set_is_a_conflict(self):
        a = S["alice"]
        t = now_ms()
        self.changes(a, {"20.3.5": self.note("Trust", t)})
        self.changes(a.tab(), del_={"20.3.5": t + 1000})
        r = self.changes(a, {"20.3.5": self.note("Trust (edited in an old tab)", t + 500)})
        self.assertEqual(r.json["conflicts"], {"20.3.5": None})
        self.assertNotIn("20.3.5", a.req("GET", "/api/notes").json["refs"])
        r = self.changes(a, {"20.3.5": self.note("Trust again", t + 2000)})
        self.assertTrue(r.json["changed"])

    def test_e13_isolation(self):
        a, b, g = S["alice"], S["bob"], Client()
        self.changes(b, {"50.4.13": self.note("Bob's note", now_ms())})
        an, bn, gn = (x.req("GET", "/api/notes").json for x in (a, b, g))
        self.assertIn("50.4.13", bn["refs"])
        self.assertNotIn("50.4.13", an["refs"])
        self.assertNotIn("50.4.13", gn["refs"])
        self.assertNotIn("45.5.8", bn["refs"])
        self.assertNotIn("45.5.8", gn["refs"])
        self.assertEqual((an["scope"], bn["scope"], gn["scope"]), (S["alice_uid"], S["bob_uid"], "guest"))
        r = g.req("POST", "/api/notes/changes", {"set": {"50.4.13": self.note("guest", now_ms())}}, scoped=True)
        self.assertEqual(r.status, 200)
        self.assertEqual(b.req("GET", "/api/notes").json["refs"]["50.4.13"]["text"], "Bob's note")
        self.changes(g, del_={"50.4.13": now_ms()})


# ======================================================================= F. library
class T08_Library(Base):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        email, pw = H.account("dave", "library aggregation")
        c = Client()
        assert c.signup(email, pw, name="Dave").status == 201
        S.update(dave=c, dave_uid=c.scope)

    def test_f01_fresh_library(self):
        r = S["dave"].library(today=datetime.date.today().isoformat())
        self.assertEqual(r.status, 200)
        j = r.json
        self.assertEqual(j["scope"], S["dave_uid"])
        self.assertEqual(r.headers["ETag"], f'"{j["rev"]}"')
        self.assertEqual((j["bookmarks"], j["lastPosition"], j["chapters"]), ([], None, {}))
        self.assertEqual(len(j["stats"]["minutes90"]), 90)
        self.assertEqual(j["stats"]["totals"]["chaptersTotal"], 1189)
        self.assertEqual(j["stats"]["streak"], {"current": 0, "longest": 0, "studiedToday": False})
        self.assertEqual([a["type"] for a in j["activity"]], ["profile.create"])
        self.assertIn("now", j["server"])

    def test_f02_one_batch_aggregates(self):
        c, t0 = S["dave"], now_ms() - 60000
        day = datetime.date.today().isoformat()
        evs = [{"type": "chapter.open", "b": 43, "c": 3}, {"type": "chapter.time", "b": 43, "c": 3, "sec": 120},
               {"type": "verse.study", "b": 43, "c": 3, "v": 16}, {"type": "xref.open", "b": 43, "c": 3, "v": 16, "to": "45.5.8"},
               {"type": "word.study", "b": 43, "c": 3, "v": 16, "strong": "G26", "word": "ἀγάπη"},
               {"type": "note.save", "b": 43, "c": 3, "v": 16}, {"type": "video.add", "b": 43, "c": 3, "v": 17, "title": "A talk"},
               {"type": "chapter.read", "b": 43, "c": 3}, {"type": "position", "b": 43, "c": 3, "v": 16, "scrollFrac": 0.42345, "tr": "kjv"}]
        for i, e in enumerate(evs):
            e.update(t=t0 + i * 1000, day=day)
        r = c.events(evs, batch_id="f2-" + RUN)
        self.assertEqual(r.status, 200, r)
        self.assertEqual((r.json["applied"], r.json["rejected"], r.json["duplicate"]), (9, 0, False))
        j = c.library(today=day).json
        ch = j["chapters"]["43.3"]
        self.assertEqual((ch["visits"], ch["seconds"], ch["read"], ch["manual"]), (1, 120, True, False))
        self.assertTrue({16, 17} <= set(ch["studied"]))
        self.assertEqual(ch["firstRead"], t0)
        self.assertEqual(j["lastPosition"], {"b": 43, "c": 3, "v": 16, "scrollFrac": 0.423, "t": t0 + 8000, "tr": "kjv"})
        types = [a["type"] for a in reversed(j["activity"]) if a["type"] != "profile.create"]
        self.assertEqual(types, ["chapter.open", "verse.study", "xref.open", "word.study", "note.save", "video.add", "chapter.read"])
        xref = [a for a in j["activity"] if a["type"] == "xref.open"][0]
        self.assertEqual((xref["ref"], xref["x"]), ("43.3.16", {"to": "45.5.8"}))
        word = [a for a in j["activity"] if a["type"] == "word.study"][0]
        self.assertEqual(word["x"], {"strong": "G26", "word": "ἀγάπη"})
        self.assertEqual(j["stats"]["totals"]["chaptersRead"], 1)
        self.assertEqual(j["stats"]["books"]["43"]["read"], 1)
        self.assertTrue(j["stats"]["streak"]["studiedToday"])
        days = c.req("GET", "/api/export/profile").json["library"]["days"][day]
        self.assertEqual(days, {"s": 120, "v": 2, "r": 1, "n": 1, "o": 1})
        S["f2_rev"] = r.json["rev"]

    def test_f03_duplicate_batch(self):
        c = S["dave"]
        r = c.events([{"type": "chapter.time", "b": 43, "c": 3, "sec": 120, "t": now_ms()}], batch_id="f2-" + RUN)
        self.assertEqual((r.json["duplicate"], r.json["applied"], r.json["rev"]), (True, 0, S["f2_rev"]))
        self.assertEqual(c.library().json["chapters"]["43.3"]["seconds"], 120)

    def test_f04_bad_events_rejected_individually(self):
        c, t = S["dave"], now_ms()
        evs = [{"type": "chapter.open", "b": 67, "c": 1, "t": t}, {"type": "verse.study", "b": 43, "c": 3, "v": 37, "t": t},
               {"type": "chapter.explode", "b": 43, "c": 3, "t": t}, {"type": "chapter.open", "b": 43, "c": 4, "t": t - 40 * 86400 * 1000},
               {"type": "chapter.time", "b": 43, "c": 4, "sec": 5000, "t": t}, {"type": "verse.study", "b": 43, "c": 4, "v": 0, "t": t},
               {"type": "chapter.open", "b": True, "c": 4, "t": t}, {"type": "xref.open", "b": 43, "c": 4, "v": 1, "to": "99.1.1", "t": t},
               {"type": "word.study", "b": 43, "c": 4, "v": 1, "strong": "X1", "t": t}, "not an event",
               {"type": "chapter.open", "b": 43, "c": 4, "t": t}]
        r = c.events(evs)
        self.assertEqual((r.json["applied"], r.json["rejected"]), (1, 10))
        self.assertEqual(c.library().json["chapters"]["43.4"]["visits"], 1)
        for bad in ({"batchId": "short", "events": [evs[-1]]}, {"batchId": "x" * 16, "events": []},
                    {"batchId": "x" * 16, "events": [evs[-1]] * 201}, {"batchId": "x" * 16, "events": "nope"}):
            self.assertErr(c.req("POST", "/api/library/events", bad, scoped=True), 400, "invalid_batch")

    def test_f05_activity_cap_and_coalescing(self):
        c = S["dave"]
        meta = accounts.meta()["verses"][0]  # Genesis
        refs = [(ch + 1, v) for ch, n in enumerate(meta) for v in range(1, n + 1)][:1100]
        base = now_ms() - 3 * 3600 * 1000  # older than every entry written so far in this run
        before_total = c.library().json["activityTotal"]
        evs = [{"type": "verse.study", "b": 1, "c": ch, "v": v, "t": base + i * 1000} for i, (ch, v) in enumerate(refs)]
        for i in range(0, 1100, 200):
            r = c.events(evs[i:i + 200])
            self.assertEqual(r.json["applied"], len(evs[i:i + 200]), r)
        j = c.library(activity=1000).json
        self.assertEqual(j["activityTotal"], 1000)
        self.assertEqual(len(j["activity"]), 1000)
        dropped = before_total + 1100 - 1000
        self.assertEqual(j["activity"][-1]["t"], evs[dropped]["t"], "exactly the oldest entries were dropped")
        self.assertEqual(j["activity"][0]["type"], "chapter.open", "newest first (the 43.4 open from f04)")
        last = refs[-1]
        self.assertIn(f"1.{last[0]}.{last[1]}", [a["ref"] for a in j["activity"][:before_total + 1]])
        # paging
        page = c.library(activity=10, before=j["activity"][9]["t"]).json["activity"]
        self.assertEqual(page[0]["t"], j["activity"][10]["t"])
        # two opens 5 minutes apart -> one activity entry, two visits
        t = now_ms() - 10 * 60 * 1000
        c.events([{"type": "chapter.open", "b": 43, "c": 1, "t": t}])
        c.events([{"type": "chapter.open", "b": 43, "c": 1, "t": t + 5 * 60 * 1000}])
        j = c.library(activity=20).json
        self.assertEqual(j["chapters"]["43.1"]["visits"], 2)
        self.assertEqual(sum(1 for a in j["activity"] if a["type"] == "chapter.open" and a["ref"] == "43.1"), 1)

    def test_f06_bookmarks_crud(self):
        c = S["dave"]
        r = c.req("POST", "/api/library/bookmarks", {"ref": "43.3.16", "label": "", "color": "red"}, scoped=True)
        self.assertEqual(r.status, 201, r)
        bm = r.json["bookmark"]
        self.assertRegex(bm["id"], r"^bm_[0-9a-f]{12}$")
        self.assertEqual((bm["b"], bm["c"], bm["v"], bm["color"]), (43, 3, 16, "red"))
        r2 = c.req("POST", "/api/library/bookmarks", {"ref": "43.3.16", "color": "blue"}, scoped=True)
        self.assertEqual((r2.status, r2.json["existed"], r2.json["bookmark"]), (200, True, bm))
        self.assertErr(c.req("POST", "/api/library/bookmarks", {"ref": "43.3.17", "label": "x" * 81}, scoped=True), 400, "invalid_label")
        self.assertErr(c.req("POST", "/api/library/bookmarks", {"ref": "43.3.17", "color": "pink"}, scoped=True), 400, "invalid_color")
        self.assertErr(c.req("POST", "/api/library/bookmarks", {"ref": "43.3.99"}, scoped=True), 400, "invalid_ref")
        self.assertErr(c.req("POST", "/api/library/bookmarks", {"ref": "19.23"}), 400, "scope_required")
        chap = c.req("POST", "/api/library/bookmarks", {"ref": "19.23", "label": " Shepherd\n psalm ", "color": "green",
                                                         "created": now_ms() - 5000}, scoped=True).json["bookmark"]
        self.assertEqual((chap["v"], chap["label"]), (0, "Shepherd psalm"))
        future = c.req("POST", "/api/library/bookmarks", {"ref": "19.1", "created": now_ms() + 10 ** 9}, scoped=True).json["bookmark"]
        self.assertLessEqual(future["created"], now_ms())
        lst = c.library().json["bookmarks"]
        self.assertEqual([b["ref"] for b in lst], ["19.1", "43.3.16", "19.23"], "newest created first")
        path = f"/api/library/bookmarks/{bm['id']}"
        self.assertErr(c.req("PATCH", path, {"label": "x" * 81}, scoped=True), 400, "invalid_label")
        self.assertErr(c.req("PATCH", path, {"color": "pink"}, scoped=True), 400, "invalid_color")
        r = c.req("PATCH", path, {"label": "Gospel in a verse", "color": "blue"}, scoped=True)
        self.assertEqual((r.status, r.json["bookmark"]["label"], r.json["bookmark"]["color"]), (200, "Gospel in a verse", "blue"))
        self.assertErr(c.req("PATCH", "/api/library/bookmarks/bm_000000000000", {"label": "x"}, scoped=True), 404, "not_found")
        r = c.req("DELETE", path, {}, scoped=True)
        self.assertEqual((r.status, r.json["removed"]["id"]), (200, bm["id"]))
        self.assertErr(c.req("DELETE", path, {}, scoped=True), 404, "not_found")
        self.assertErr(c.req("DELETE", "/api/library/bookmarks/../../x", {}, scoped=True), 404, "not_found")
        acts = [a["type"] for a in c.library(activity=10).json["activity"]]
        self.assertIn("bookmark.remove", acts)
        self.assertIn("bookmark.add", acts)
        self.assertEqual(Client().library().json["bookmarks"], [], "guest bookmarks are separate")

    def test_f07_manual_mark_wins_over_auto_read(self):
        c = S["dave"]
        r = c.req("POST", "/api/library/chapters", {"b": 19, "c": 23, "read": False}, scoped=True)
        self.assertEqual(r.status, 200, r)
        ch = r.json["chapters"]["19.23"]
        self.assertEqual((ch["read"], ch["manual"]), (False, True))
        c.events([{"type": "chapter.read", "b": 19, "c": 23, "t": now_ms()}])
        self.assertFalse(c.library().json["chapters"]["19.23"]["read"])
        c.events([{"type": "chapter.read", "b": 19, "c": 23, "t": now_ms() + 65 * 1000}])
        ch = c.library().json["chapters"]["19.23"]
        self.assertEqual((ch["read"], ch["manual"]), (True, False))
        r = c.req("POST", "/api/library/chapters", {"b": 56, "cs": [1, 2, 3, 3], "read": True}, scoped=True)
        self.assertEqual(sorted(r.json["chapters"]), ["56.1", "56.2", "56.3"])
        j = c.library().json
        self.assertEqual(j["stats"]["books"]["56"], {"read": 3, "total": 3, "started": 0, "seconds": 0, "studied": 0})
        self.assertEqual(j["stats"]["totals"]["booksCompleted"], 1)
        mark = [a for a in j["activity"] if a["type"] == "chapter.mark"][0]
        self.assertEqual((mark["ref"], mark["x"]), ("56", {"read": True, "count": 3}))
        for bad in ({"b": 56, "c": 4, "read": True}, {"b": 67, "c": 1, "read": True}, {"b": 56, "cs": [], "read": True},
                    {"b": 56, "cs": [1, "2"], "read": True}):
            self.assertErr(c.req("POST", "/api/library/chapters", bad, scoped=True), 400, "invalid_ref")
        self.assertErr(c.req("POST", "/api/library/chapters", {"b": 56, "c": 1, "read": "yes"}, scoped=True), 400, "bad_request")

    def test_f08_streaks_and_minutes(self):
        email, pw = H.account("frank", "streak statistics")
        c = Client()
        self.assertEqual(c.signup(email, pw, name="Frank").status, 201)
        D = datetime.date.today()
        ev = lambda d, sec, ch=1: {"type": "chapter.time", "b": 43, "c": ch, "sec": sec, "t": local_noon_ms(d), "day": d.isoformat()}  # noqa
        c.events([ev(D - datetime.timedelta(days=k), 60) for k in (6, 5, 3, 2, 1)] + [ev(D - datetime.timedelta(days=4), 30)])
        s = c.library(today=D.isoformat()).json["stats"]
        self.assertEqual(s["streak"], {"current": 3, "longest": 3, "studiedToday": False})
        self.assertEqual(s["minutes90"][-2:], [1, 0])
        self.assertEqual(s["minutes90"][-5], 1, "30 seconds rounds to 1 minute (half up)")
        self.assertEqual(s["days90"], 5)
        self.assertEqual(s["totals"]["daysStudied"], 5)
        c.events([{"type": "chapter.time", "b": 43, "c": 2, "sec": 150, "t": now_ms(), "day": D.isoformat()}])
        s = c.library(today=D.isoformat()).json["stats"]
        self.assertEqual(s["streak"], {"current": 4, "longest": 4, "studiedToday": True})
        self.assertEqual(s["minutes90"][-1], 3)
        self.assertEqual(s["week"]["seconds"], 60 * 5 + 30 + 150)
        self.assertEqual(s["totals"]["seconds"], 60 * 5 + 30 + 150)
        s = c.library(today=(D + datetime.timedelta(days=2)).isoformat()).json["stats"]
        self.assertEqual(s["streak"]["current"], 0, "a missed day breaks the streak")
        self.assertEqual(c.library(today="not-a-day").status, 200)
        S["frank"] = c

    def test_f09_reset(self):
        c = S["dave"]
        self.assertErr(c.req("POST", "/api/library/reset", {"what": []}, scoped=True), 400, "invalid_reset")
        self.assertErr(c.req("POST", "/api/library/reset", {"what": ["everything"]}, scoped=True), 400, "invalid_reset")
        c.req("POST", "/api/library/bookmarks", {"ref": "1.1.1"}, scoped=True)
        self.assertEqual(c.req("POST", "/api/library/reset", {"what": ["activity"]}, scoped=True).status, 200)
        j = c.library().json
        self.assertEqual((j["activity"], j["activityTotal"]), ([], 0))
        self.assertTrue(j["chapters"] and j["bookmarks"] and j["lastPosition"])
        c.req("POST", "/api/library/reset", {"what": ["progress"]}, scoped=True)
        j = c.library().json
        self.assertEqual((j["chapters"], j["lastPosition"], j["stats"]["days90"]), ({}, None, 0))
        self.assertTrue(j["bookmarks"])
        c.req("POST", "/api/library/reset", {"what": ["bookmarks"]}, scoped=True)
        self.assertEqual(c.library().json["bookmarks"], [])

    def test_f10_two_tabs_concurrent_events_and_bookmarks(self):
        c = S["dave"]
        rev0 = c.library().json["rev"]
        errs = []

        def tab(k):
            t = c.tab()
            for i in range(30):
                r = t.events([{"type": "chapter.time", "b": 19, "c": 117, "sec": 10, "t": now_ms()}])
                if r.status != 200:
                    errs.append(r)
            for v in range(1, 11):
                r = t.req("POST", "/api/library/bookmarks", {"ref": f"19.119.{k * 10 + v}"}, scoped=True)
                if r.status != 201:
                    errs.append(r)
        th = [threading.Thread(target=tab, args=(k,)) for k in (0, 1)]
        [t.start() for t in th]
        [t.join() for t in th]
        self.assertEqual(errs, [])
        j = c.library().json
        self.assertEqual(j["chapters"]["19.117"]["seconds"], 600)
        self.assertEqual(len(j["bookmarks"]), 20)
        self.assertEqual(j["rev"], rev0 + 80)

    def test_f11_last_position_and_scope_independence(self):
        c, g = S["dave"], Client()
        t = now_ms()
        c.events([{"type": "position", "b": 45, "c": 8, "v": 28, "scrollFrac": 2, "t": t}])
        c.events([{"type": "position", "b": 1, "c": 1, "v": 1, "t": t - 5000}])
        self.assertEqual(c.library().json["lastPosition"], {"b": 45, "c": 8, "v": 28, "scrollFrac": 1.0, "t": t})
        g.events([{"type": "chapter.open", "b": 66, "c": 22, "t": t}, {"type": "position", "b": 66, "c": 22, "v": 21, "t": t}])
        gj, dj = g.library().json, c.library().json
        self.assertIn("66.22", gj["chapters"])
        self.assertNotIn("66.22", dj["chapters"])
        self.assertNotIn("19.117", gj["chapters"])
        self.assertEqual(gj["lastPosition"]["b"], 66)
        self.assertEqual(dj["lastPosition"]["b"], 45)
        self.assertEqual(g.me().json["guest"]["hasData"], True)
        r = g.events([{"type": "chapter.open", "b": 1, "c": 1, "t": t}], batch_id=None)
        self.assertEqual(r.headers["X-BS-Scope"], "guest")
        self.assertErr(c.req("POST", "/api/library/events", {"batchId": "x" * 16, "events": [{"type": "chapter.open", "b": 1, "c": 1, "t": t}]},
                             headers={"X-BS-Scope": "guest"}), 409, "scope_mismatch")


# ======================================================================= G. export, import, delete
class T09_ExportImportDelete(Base):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        for who in ("alice", "bob"):
            email = S[f"{who}_email"]
            pw = [a["password"] for a in H.accounts if a["email"] == email][0]
            c = Client()
            assert c.login(email, pw).status == 200
            S[who] = c

    def test_g1_export_profile(self):
        a = S["alice"]
        r = a.req("GET", "/api/export/profile")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.headers["Content-Disposition"], f'attachment; filename="bible-study-alice-test-{time.strftime("%Y-%m-%d")}.json"')
        j = r.json
        self.assertEqual((j["format"], j["version"], j["scope"]), ("bible-study-profile", 1, "profile"))
        self.assertEqual(j["profile"]["email"], S["alice_email"])
        self.assertIn("45.5.8", j["notes"]["refs"])
        for secret in (b'"pw"', b"appliedBatches", b'"deleted"', b"lockUntil", b"pbkdf2", b"sessions"):
            self.assertNotIn(secret, r.raw)
        g = Client().req("GET", "/api/export/profile")
        self.assertEqual((g.json["scope"], g.json["profile"]), ("guest", None))
        self.assertIn(f'bible-study-guest-{time.strftime("%Y-%m-%d")}.json', g.headers["Content-Disposition"])

    def test_g2_export_obsidian(self):
        a = S["alice"]
        a.req("POST", "/api/library/bookmarks", {"ref": "43.3.16", "label": "Gospel"}, scoped=True)
        a.req("POST", "/api/library/bookmarks", {"ref": "43.3"}, scoped=True)
        a.req("POST", "/api/library/chapters", {"b": 43, "c": 3, "read": True}, scoped=True)
        r = a.req("GET", "/api/export/obsidian")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.headers["Content-Type"], "application/zip")
        self.assertIn('filename="bible-study-notes.zip"', r.headers["Content-Disposition"])
        z = zipfile.ZipFile(io.BytesIO(r.raw))
        names = set(z.namelist())
        self.assertIn("study-notes/Bookmarks.md", names)
        self.assertIn("study-notes/Reading Progress.md", names)
        self.assertIn("study-notes/Romans 5.8.md", names)
        bm = z.read("study-notes/Bookmarks.md").decode()
        self.assertIn("- [[John 3.16|John 3:16]] · Gospel", bm)
        self.assertIn("- [[John 3]]", bm)
        rp = z.read("study-notes/Reading Progress.md").decode()
        self.assertIn("# Reading progress", rp)
        self.assertIn("of 1,189 chapters read", rp)
        self.assertIn("## John (1/21)", rp)
        self.assertIn("[[John 3]]", rp)
        g = zipfile.ZipFile(io.BytesIO(Client().req("GET", "/api/export/obsidian").raw))
        self.assertNotIn("study-notes/Romans 5.8.md", g.namelist(), "guest export only has guest notes")
        self.assertIn("study-notes/John 3.16.md", g.namelist())

    def test_g3_import_guest_is_idempotent(self):
        b, g = S["bob"], Client()
        t = now_ms()
        g.events([{"type": "chapter.open", "b": 66, "c": 21, "t": t}, {"type": "chapter.time", "b": 66, "c": 21, "sec": 90, "t": t},
                  {"type": "verse.study", "b": 66, "c": 21, "v": 4, "t": t}])
        g.req("POST", "/api/library/bookmarks", {"ref": "66.21.4", "label": "No more tears"}, scoped=True)
        self.assertErr(g.req("POST", "/api/profile/import-guest", {}, scoped=True), 401, "not_signed_in")
        self.assertErr(b.req("POST", "/api/profile/import-guest", {}), 400, "scope_required")
        r = b.req("POST", "/api/profile/import-guest", {}, scoped=True)
        self.assertEqual(r.status, 200, r)
        imp = r.json["imported"]
        self.assertEqual(imp["notes"], 3)
        self.assertGreaterEqual(imp["bookmarks"], 1)
        self.assertGreaterEqual(imp["chapters"], 1)
        lib1 = b.library().json
        ch1 = lib1["chapters"]["66.21"]
        self.assertEqual((ch1["seconds"], ch1["visits"], ch1["studied"]), (90, 1, [4]))
        self.assertIn("66.21.4", [x["ref"] for x in lib1["bookmarks"]])
        self.assertIn("43.3.16", b.req("GET", "/api/notes").json["refs"])
        self.assertIn("50.4.13", b.req("GET", "/api/notes").json["refs"], "the profile's own notes are kept")
        r2 = b.req("POST", "/api/profile/import-guest", {}, scoped=True)
        self.assertEqual(r2.json["imported"], {"notes": 0, "bookmarks": 0, "chapters": 0, "links": 0, "marks": 0})
        self.assertEqual(r2.json["rev"], r.json["rev"], "nothing changed the second time")
        ch2 = b.library().json["chapters"]["66.21"]
        self.assertEqual(ch1, ch2)
        self.assertIn("66.21", g.library().json["chapters"], "guest data is left in place")

    def test_g4_delete_account(self):
        email, pw = H.account("erin", "account deletion")
        c = Client()
        self.assertEqual(c.signup(email, pw, name="Erin").status, 201)
        uid = c.scope
        other_tab = Client()
        self.assertEqual(other_tab.login(email, pw).status, 200)
        c.req("POST", "/api/notes/changes", {"set": {"43.11.35": {"text": "Jesus wept", "updated": now_ms()}}}, scoped=True)
        c.req("POST", "/api/library/bookmarks", {"ref": "43.11.35"}, scoped=True)
        self.assertErr(c.req("POST", "/api/account/delete", {}), 401, "bad_credentials")
        self.assertErr(c.req("POST", "/api/account/delete", {"password": "wrong-" + secrets.token_urlsafe(6)}), 401, "bad_credentials")
        self.assertErr(Client().req("POST", "/api/account/delete", {"password": pw}), 401, "not_signed_in")
        self.assertTrue(os.path.isdir(os.path.join(H.data, "profiles", uid)))
        r = c.req("POST", "/api/account/delete", {"password": pw})
        self.assertEqual(r.status, 200, r)
        self.assertIn("Max-Age=0", r.set_cookies()[0])
        self.assertEqual(r.headers["X-BS-Scope"], "guest")
        self.assertNotIn(uid, H.read("users.json")["users"])
        self.assertFalse(os.path.exists(os.path.join(H.data, "profiles", uid)))
        moved = [d for d in os.listdir(os.path.join(H.data, "deleted")) if d.startswith(uid + "-")]
        self.assertEqual(len(moved), 1)
        u = H.read("deleted", moved[0], "user.json")
        self.assertNotIn("pw", u)
        self.assertEqual(u["email"], email)
        self.assertFalse([k for k, s in H.read("sessions.json")["sessions"].items() if s["uid"] == uid])
        self.assertEqual(c.me().json["scope"], "guest")
        self.assertFalse(other_tab.me().json["signedIn"], "every session of the profile is gone")
        r = other_tab.req("POST", "/api/notes/changes", {"set": {"43.11.35": {"text": "x"}}}, headers={"X-BS-Scope": uid})
        self.assertErr(r, 409, "scope_mismatch")
        self.assertNotIn("43.11.35", Client().req("GET", "/api/notes").json["refs"], "nothing leaked into guest")
        self.assertFalse(os.path.exists(os.path.join(H.data, "profiles", uid)), "not recreated")
        self.assertErr(Client().login(email, pw), 401, "bad_credentials")


# ======================================================================= H. CLI while the server runs
class T10_CLI(Base):
    def cli(self, *args, stdin=None):
        return subprocess.run([PY, SERVE, "--data-dir", H.data, *args], input=stdin, capture_output=True, text=True, timeout=60)

    def test_h1_list_users(self):
        p = self.cli("--list-users")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn(S["alice_email"], p.stdout)
        self.assertIn(S["bob_email"], p.stdout)
        self.assertNotIn("pbkdf2", p.stdout)
        self.assertNotIn("scrypt", p.stdout)
        line = [ln for ln in p.stdout.splitlines() if S["alice_email"] in ln][0]
        self.assertRegex(line, r"^u[0-9a-f]{16}  \S+  Alice Test  created \d{4}-\d\d-\d\d  last sign-in \d{4}-\d\d-\d\d  notes \d+  bookmarks \d+$")

    def test_h2_reset_password(self):
        email = S["carol_email"]
        old_pw = [a["password"] for a in H.accounts if a["email"] == email][0]
        c = Client()
        self.assertEqual(c.login(email, old_pw).status, 200)
        for _ in range(2):
            Client().req("POST", "/api/auth/login", {"email": email, "password": "nope-" + secrets.token_urlsafe(6)})
        u = [u for u in H.read("users.json")["users"].values() if u["email"] == email][0]
        self.assertEqual(u["failedLogins"], 2)
        new_pw = secrets.token_urlsafe(18)
        H.update_account(email, password=new_pw)
        p = self.cli("--reset-password", email.upper(), "--password-stdin", stdin=new_pw + "\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("All sessions were signed out.", p.stdout)
        self.assertFalse(new_pw in p.stdout or new_pw in p.stderr)
        self.assertFalse(c.me().json["signedIn"])
        u = [u for u in H.read("users.json")["users"].values() if u["email"] == email][0]
        self.assertEqual((u["failedLogins"], u["lockUntil"]), (0, 0))
        self.assertErr(Client().login(email, old_pw), 401, "bad_credentials")
        self.assertEqual(Client().login(email, new_pw).status, 200)

    def test_h3_reset_password_errors(self):
        p = self.cli("--reset-password", f"nobody-{RUN}@example.test", "--password-stdin", stdin=secrets.token_urlsafe(12) + "\n")
        self.assertEqual(p.returncode, 1)
        self.assertIn("No profile for that email.", p.stderr)
        p = self.cli("--reset-password", S["carol_email"], "--password-stdin", stdin="short\n")
        self.assertEqual(p.returncode, 2)
        p = self.cli("--reset-password", S["carol_email"], "--password-stdin", stdin="password123\n")
        self.assertEqual(p.returncode, 2)
        self.assertIn("too common", p.stderr)

    def _tty_cli(self, args, answers, timeout=30):
        """Run serve.py on a pseudo-terminal (getpass reads /dev/tty), answering each prompt in turn."""
        import pty, select
        pid, fd = pty.fork()
        if pid == 0:  # child
            try:
                os.execv(PY, [PY, SERVE, "--data-dir", H.data, *args])
            finally:
                os._exit(127)
        out, pending, deadline, status = b"", list(answers), time.time() + timeout, None
        try:
            while time.time() < deadline:
                r, _, _ = select.select([fd], [], [], 0.2)
                if r:
                    try:
                        chunk = os.read(fd, 4096)
                    except OSError:
                        break
                    if not chunk:
                        break
                    out += chunk
                    if pending and out.rstrip().endswith((b"password:", b"Repeat:")):
                        time.sleep(0.4)  # let getpass finish switching echo off before the answer arrives
                        os.write(fd, pending.pop(0).encode() + b"\n")
                        out += b"\n"
            for _ in range(50):
                done, status = os.waitpid(pid, os.WNOHANG)
                if done:
                    break
                time.sleep(0.1)
            else:
                os.kill(pid, 9)
                os.waitpid(pid, 0)
                status = None
        finally:
            os.close(fd)
        return (os.WEXITSTATUS(status) if status is not None else -1), out.decode("utf-8", "replace")

    def test_h4_reset_password_interactive(self):
        email = S["carol_email"]
        code, out = self._tty_cli(["--reset-password", email], [secrets.token_urlsafe(12), secrets.token_urlsafe(12)])
        self.assertEqual(code, 2, out)
        self.assertIn("don’t match", out)
        new_pw = secrets.token_urlsafe(18)
        H.update_account(email, password=new_pw)
        code, out = self._tty_cli(["--reset-password", email], [new_pw, new_pw])
        self.assertEqual(code, 0, "interactive reset failed")
        self.assertIn("All sessions were signed out.", out)
        self.assertFalse(new_pw in out, "getpass must not echo the password")
        self.assertEqual(Client().login(email, new_pw).status, 200)


# ======================================================================= I. unit tests of accounts.py
class T11_Unit(Base):
    restart = False

    @classmethod
    def setUpClass(cls):
        cls._log = accounts.log
        accounts.log = lambda *a, **k: None  # keep expected "[auth] hash-unsupported" lines out of the test output

    @classmethod
    def tearDownClass(cls):
        accounts.log = cls._log

    def test_i1_hashing(self):
        h = accounts.hash_password("correct horse battery")
        self.assertTrue(accounts.verify_password("correct horse battery", h))
        self.assertFalse(accounts.verify_password("correct horse batterY", h))
        self.assertFalse(accounts.needs_rehash(h))
        self.assertNotEqual(h, accounts.hash_password("correct horse battery"), "per-hash random salt")
        self.assertTrue(accounts.verify_password("ｃｏｒｒｅｃｔ horse battery", h), "NFKC normalisation")
        self.assertTrue(accounts.needs_rehash("pbkdf2_sha256$1000$AAAA$AAAA") or accounts.PREFERRED == "scrypt")
        for bad in ("", "md5$abc", "pbkdf2_sha256$x$y$z", "pbkdf2_sha256$600000$!!!$@@@", "pbkdf2_sha256$99999999999$AAAA$AAAAAAAAAAAAAAAAAAAAAA==", None):
            self.assertFalse(accounts.verify_password("whatever1", bad))
        scrypt_hash = "scrypt$32768$8$1$" + "A" * 24 + "$" + "A" * 44
        if not hasattr(hashlib, "scrypt"):
            self.assertFalse(accounts.verify_password("whatever1", scrypt_hash))

    def test_i2_validation(self):
        V = accounts
        self.assertEqual(V.validate_email("  Ji@Example.TEST "), (True, "ji@example.test", None))
        for bad in ("", "ji", "ji@", "@example.test", "ji@example", 'j"i@example.test', "ji @example.test", "a" * 65 + "@example.test",
                    "ji\n@example.test", "ji@exa_mple.test", "<ji>@example.test", None, 5):
            self.assertFalse(V.validate_email(bad)[0], bad)
        self.assertEqual(V.validate_name("  Ji \t Kim\x07 "), (True, "Ji Kim", None))
        for bad in ("", "   ", "\x00\x01", "x" * 61, None):
            self.assertFalse(V.validate_name(bad)[0], repr(bad))
        good = secrets.token_urlsafe(12)
        self.assertTrue(V.validate_password(good, "ji@example.test")[0])
        for bad, frag in (("short", "at least 8"), ("x" * 257, "at most"), (" " * 9, "spaces"), ("JI@example.test", "email"),
                          ("ji-local", None), ("Password123", "too common"), ("john3:16", "too common")):
            ok, code, msg = V.validate_password(bad, "ji-local@example.test" if bad == "ji-local" else "ji@example.test")
            self.assertFalse(ok, bad)
            self.assertEqual(code, "weak_password")
            if frag:
                self.assertIn(frag, msg)
        self.assertEqual([V.initials(n) for n in ("Ji Kim", "ji", "Mary Anne van Dyke", "")], ["JK", "J", "MD", ""])
        self.assertEqual([V.parse_ref(r) for r in ("43.3.16", "19.119", "43.3.37", "67.1", "43.22", "0.1.1", "43.3.16\n")],
                         [(43, 3, 16), (19, 119, 0), None, None, None, None, None])
        self.assertEqual([V.lock_seconds(f) for f in (0, 4, 5, 6, 10, 30)], [0, 0, 1, 2, 32, 900])

    def test_i3_apply_events(self):
        now = now_ms()
        lib = accounts.new_library(now)
        evs = [{"type": "chapter.open", "b": 1, "c": 1, "t": now - 1000}, {"type": "chapter.open", "b": 1, "c": 1, "t": now - 20 * 60 * 1000},
               {"type": "chapter.open", "b": 1, "c": 1, "t": now - 40 * 60 * 1000 - 1000},
               {"type": "verse.study", "b": 1, "c": 1, "v": 3, "t": now - 5000}, {"type": "verse.study", "b": 1, "c": 1, "v": 3, "t": now - 4000},
               {"type": "verse.study", "b": 1, "c": 1, "v": 1, "t": now - 3000}, {"type": "chapter.time", "b": 1, "c": 1, "sec": 900, "t": now}]
        self.assertEqual(accounts.apply_events(lib, evs, now), (7, 0))
        act = lib["activity"]
        self.assertEqual([a["t"] for a in act], sorted(a["t"] for a in act), "kept sorted by t")
        self.assertEqual(sum(1 for a in act if a["type"] == "chapter.open"), 2, "opens within 30 min coalesce")
        self.assertEqual(sum(1 for a in act if a["type"] == "verse.study" and a["ref"] == "1.1.3"), 1, "studies within 10 min coalesce")
        ch = lib["chapters"]["1.1"]
        self.assertEqual((ch["visits"], ch["seconds"], ch["studied"]), (3, 900, [1, 3]))
        self.assertEqual(ch["firstRead"], now - 40 * 60 * 1000 - 1000)
        # days are trimmed to the newest 400
        lib2 = accounts.new_library(now)
        base = datetime.date(2020, 1, 1)
        lib2["days"] = {(base + datetime.timedelta(days=i)).isoformat(): accounts.new_day() for i in range(400)}
        accounts.apply_events(lib2, [{"type": "chapter.time", "b": 1, "c": 1, "sec": 5, "t": now}], now)
        self.assertEqual(len(lib2["days"]), 400)
        self.assertNotIn("2020-01-01", lib2["days"])
        # clean_event normalisation
        ce = accounts.clean_event
        self.assertEqual(ce({"type": "chapter.open", "b": 1, "c": 1, "t": now + 10 ** 7}, now)["t"], now, "future t clamps to now")
        self.assertIsNone(ce({"type": "chapter.open", "b": 1, "c": 1, "t": now - 31 * 86400 * 1000}, now))
        self.assertIsNone(ce({"type": "chapter.open", "b": 1, "c": 1}, now))
        self.assertEqual(ce({"type": "chapter.open", "b": 1, "c": 1, "t": now, "day": "1999-01-01"}, now)["day"],
                         datetime.datetime.fromtimestamp(now / 1000).date().isoformat())
        self.assertEqual(ce({"type": "position", "b": 1, "c": 1, "t": now, "scrollFrac": -3}, now)["scrollFrac"], 0.0)
        self.assertIsNone(ce({"type": "position", "b": 1, "c": 1, "t": now, "tr": "../x"}, now))
        self.assertEqual(ce({"type": "video.add", "b": 1, "c": 1, "t": now, "title": "t" * 500}, now)["title"], "t" * 120)

    def test_i4_compute_stats(self):
        lib = accounts.new_library()
        for d, s in (("2026-02-20", 600), ("2026-02-21", 600), ("2026-02-27", 60), ("2026-02-28", 30), ("2026-03-01", 3600)):
            lib["days"][d] = dict(accounts.new_day(), s=s)
        lib["days"]["2026-02-28"]["n"] = 1
        lib["chapters"] = {"43.3": dict(accounts.new_chapter(), read=True, seconds=100, studied=[1, 2], visits=1),
                           "56.1": dict(accounts.new_chapter(), read=True), "56.2": dict(accounts.new_chapter(), read=True),
                           "56.3": dict(accounts.new_chapter(), read=True, studied=[4])}
        s = accounts.compute_stats(lib, 7, "2026-03-02")
        self.assertEqual(s["streak"], {"current": 3, "longest": 3, "studiedToday": False})
        s = accounts.compute_stats(lib, 7, "2026-03-01")
        self.assertEqual(s["streak"], {"current": 3, "longest": 3, "studiedToday": True})
        self.assertEqual(s["minutes90"][-1], 60)
        self.assertEqual(s["minutes90"][-2], 1)
        self.assertEqual(s["week"]["seconds"], 60 + 30 + 3600)
        self.assertEqual(s["days90"], 5)
        t = s["totals"]
        self.assertEqual((t["chaptersRead"], t["versesStudied"], t["chaptersStudied"], t["booksCompleted"], t["notes"], t["seconds"]),
                         (4, 3, 2, 1, 7, 100))
        self.assertEqual(s["books"]["56"], {"read": 3, "total": 3, "started": 1, "seconds": 0, "studied": 1})

    def test_i5_merges(self):
        now = now_ms()
        guest = accounts.new_library(now)
        accounts.apply_events(guest, [{"type": "chapter.open", "b": 43, "c": 3, "t": now - 5000},
                                      {"type": "chapter.time", "b": 43, "c": 3, "sec": 50, "t": now - 4000},
                                      {"type": "position", "b": 43, "c": 3, "v": 2, "t": now - 3000}], now)
        guest["bookmarks"] = [{"id": "bm_aaaaaaaaaaaa", "ref": "43.3.16", "b": 43, "c": 3, "v": 16, "label": "", "color": "red", "created": 1, "updated": 1}]
        copy_lib = {"junk": True}
        counts = accounts.merge_library(copy_lib, guest, "copy", now)
        self.assertNotIn("junk", copy_lib)
        self.assertEqual((counts["bookmarks"], counts["chapters"], copy_lib["rev"], copy_lib["appliedBatches"]), (1, 1, 1, []))
        self.assertEqual(copy_lib["imports"][0]["mode"], "copy")
        prof = accounts.new_library(now)
        accounts.apply_events(prof, [{"type": "chapter.time", "b": 43, "c": 3, "sec": 20, "t": now - 1000},
                                     {"type": "verse.study", "b": 43, "c": 3, "v": 5, "t": now - 900}], now)
        m1 = accounts.merge_library(prof, guest, "merge", now)
        self.assertEqual((m1["bookmarks"], m1["chapters"], m1["changed"]), (1, 1, True))
        ch = prof["chapters"]["43.3"]
        self.assertEqual((ch["seconds"], ch["visits"], ch["studied"]), (50, 1, [5]))
        self.assertEqual(prof["lastPosition"]["v"], 2)
        snapshot = json.dumps(prof, sort_keys=True)
        m2 = accounts.merge_library(prof, guest, "merge", now)
        self.assertEqual((m2["bookmarks"], m2["chapters"], m2["changed"]), (0, 0, False))
        self.assertEqual(json.dumps(prof, sort_keys=True), snapshot, "merge is idempotent")
        # notes: last writer wins, tombstones respected
        dst = {"refs": {"1.1": {"text": "new", "updated": 50}, "1.2": {"text": "old", "updated": 5}}, "deleted": {"1.3": 100}}
        src = {"refs": {"1.1": {"text": "older", "updated": 10}, "1.2": {"text": "newer", "updated": 20},
                        "1.3": {"text": "deleted later", "updated": 90}, "1.4": {"text": "fresh", "updated": 1}}}
        self.assertEqual(accounts.merge_notes(dst, src), 2)
        self.assertEqual({k: v["text"] for k, v in dst["refs"].items()}, {"1.1": "new", "1.2": "newer", "1.4": "fresh"})
        self.assertEqual(accounts.merge_notes(dst, src), 0)
        notes = {"refs": {"1.1": {"text": "a", "updated": 10}}, "deleted": {}}
        changed, conflicts = accounts.apply_note_changes(notes, {"1.1": {"text": "b", "updated": 9}}, {})
        self.assertEqual((changed, conflicts), (False, {"1.1": {"text": "a", "updated": 10}}))
        changed, conflicts = accounts.apply_note_changes(notes, {}, {"1.1": 10})
        self.assertEqual((changed, conflicts, notes["refs"], notes["deleted"]), (True, {}, {}, {"1.1": 10}))

    def test_i6_storage(self):
        d = tempfile.mkdtemp(prefix="bs-servertest-unit-")
        try:
            p = os.path.join(d, "x.json")
            accounts.write_json_atomic(p, {"a": 1})
            self.assertEqual(os.listdir(d), ["x.json"], "no .tmp-* left behind")
            self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600)
            with open(p, "w") as f:
                f.write("{not json")
            self.assertEqual(accounts.read_json_strict(p, {"d": 1}), {"d": 1})
            names = os.listdir(d)
            self.assertFalse(os.path.exists(p), "the corrupt file is never overwritten in place")
            self.assertTrue(any(n.startswith("x.json.corrupt-") for n in names), names)
            self.assertEqual(accounts.read_json_strict(os.path.join(d, "missing.json"), []), [])
            with open(p, "w") as f:
                f.write("[1, 2]")
            self.assertEqual(accounts.read_json_strict(p, {}), {}, "wrong top-level type counts as corrupt")
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_i7_path_safety(self):
        accounts.configure(H.data, H.port)
        for bad in ("../u0000000000000000", "u000000000000000g", "U0000000000000000", "u0000000000000000/..", "u0000000000000000\n", "", None, "guest"):
            with self.assertRaises(ValueError):
                accounts.profile_dir(bad)
        self.assertTrue(accounts.profile_dir("u0123456789abcdef").endswith(os.path.join("profiles", "u0123456789abcdef")))
        self.assertIsNone(accounts.resolve_session("../../etc/passwd"))
        self.assertIsNone(accounts.resolve_session("A" * 43))

    def test_i8_canonical_refs_and_clamped_timestamps(self):
        """Findings 5 and 8 at the unit level."""
        P = accounts.parse_ref
        self.assertEqual([P(r) for r in ("43.3.16", "43.03.16", "43.3.016", "043.3.16", "43.003.16", "01.1", "1.1.0")],
                         [(43, 3, 16), None, None, None, None, None, None])
        self.assertEqual([accounts.canonical_ref(r) for r in ("43.03.16", "043.3.016", "19.023", "43.3.99", "x")],
                         ["43.3.16", "43.3.16", "19.23", None, None])
        now, year = now_ms(), 365 * 86400 * 1000
        self.assertEqual([accounts.clamp_ts(x, now) for x in (now - 5, now + 60_000, now + year, 1e300, -1, True, "1")],
                         [now - 5, now + 60_000, now, now, None, None, None])
        n = accounts.clean_note({"text": "x", "updated": now + year, "created": 1e300, "videos": [{"url": "u", "added": now + year}]}, now)
        self.assertEqual((n["updated"], n["created"], n["videos"][0]["added"]), (now, now, now))
        self.assertIsNone(accounts.clean_note({"text": "x", "videos": [{"url": "u", "start": 1e300}]}, now))

    def test_i9_merge_is_idempotent_at_the_caps(self):
        """Finding 6: guest entries older than everything a full profile keeps are no change."""
        now = now_ms()
        prof = accounts.new_library(now)
        prof["activity"] = [{"t": now - 1000 * (1000 - i), "type": "xref.open", "ref": "19.119.1"} for i in range(1000)]
        base = datetime.date(2025, 1, 1)
        prof["days"] = {(base + datetime.timedelta(days=i)).isoformat(): dict(accounts.new_day(), s=60) for i in range(400)}
        guest = accounts.new_library(now)
        guest["activity"] = [{"t": 1000 + i, "type": "verse.study", "ref": "1.1.1"} for i in range(5)]
        guest["days"] = {"2020-01-01": dict(accounts.new_day(), s=600)}
        snap = json.dumps(prof, sort_keys=True)
        for _ in range(2):
            m = accounts.merge_library(prof, guest, "merge", now)
            self.assertEqual((m["bookmarks"], m["chapters"], m["changed"]), (0, 0, False))
            self.assertEqual(json.dumps(prof, sort_keys=True), snap)
        guest["activity"].append({"t": now, "type": "verse.study", "ref": "1.1.2"})  # a genuinely new entry still counts
        self.assertTrue(accounts.merge_library(prof, guest, "merge", now)["changed"])

    def test_i10_accounts_file_is_merged_not_truncated(self):
        """Finding 11: the harness keeps entries other agents wrote to the shared accounts file."""
        d = tempfile.mkdtemp(prefix="bs-servertest-acc-")
        try:
            p = os.path.join(d, "accounts.json")
            other = {"email": "other-agent@example.test", "password": "kept-" + secrets.token_hex(4), "purpose": "someone else"}
            with open(p, "w", encoding="utf-8") as f:
                json.dump([other], f)
            mine = {"email": f"me-{RUN}@example.test", "password": secrets.token_urlsafe(8), "purpose": "unit"}
            record_accounts(p, [mine])
            self.assertEqual(read_json_file(p), [other, mine])
            renamed = dict(mine, email=f"me2-{RUN}@example.test", password=secrets.token_urlsafe(8))
            record_accounts(p, [renamed], renamed={renamed["email"]: mine["email"]})
            self.assertEqual(read_json_file(p), [other, renamed], "replaced in place, the other entry kept")
            self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600)
            with open(p, "w") as f:
                f.write("{not a list")
            record_accounts(p, [mine])
            self.assertEqual(read_json_file(p), [mine])
            self.assertTrue([n for n in os.listdir(d) if n.startswith("accounts.json.unreadable-")], "unreadable file kept aside")
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_i11_ascii_digits_display_text_and_json_hygiene(self):
        """Second pass over findings 3, 7 and 8: other scripts' digits, invisible characters, values JSON cannot carry."""
        V, arabic3 = accounts, "\u0663"
        self.assertIsNone(V.parse_ref(f"4{arabic3}.3.16"), "int() reads '4\u0663' as 43: it must not be a second key")
        self.assertEqual(V.canonical_ref(f"4{arabic3}.3.16"), "43.3.16", "but such a stored key is folded on load")
        self.assertEqual(V._canon_key(f"4{arabic3}.3.16"), "43.3.16")
        self.assertIsNone(V.parse_day("\u0662\u0660\u0662\u0666-09-28"))
        self.assertIsNone(V.STRONG_RE.fullmatch(f"H{arabic3}"))
        self.assertEqual(V.clean_text("Ji \u202eKim\u2066\u2069 \ud800!"), "Ji Kim !")
        self.assertEqual(V.clean_text("In the\r\nbeginning\twas\x00 the Word"), "In the beginning was the Word",
                         "line breaks and tabs keep the word break")
        self.assertEqual(V.validate_name("\u202e\u2067")[0], False, "only invisible controls: no name left")
        family = "\U0001F468\u200d\U0001F469\u200d\U0001F467 Kim \u05d9\u200f"
        self.assertEqual(V.validate_name(family), (True, family, None), "joiners and RTL marks are kept")
        for bad in ("ji\u200b@example.test", "ji\u202e@example.test", "ji\ufeff@example.test", "ji\ud800@example.test"):
            self.assertFalse(V.validate_email(bad)[0], repr(bad))
        self.assertTrue(V.validate_email("j\u00ed@example.test")[0], "non-ASCII letters are still fine")
        d = tempfile.mkdtemp(prefix="bs-servertest-json-")
        try:
            p = os.path.join(d, "x.json")
            with open(p, "wb") as f:
                f.write(b'{"a": NaN, "b": [Infinity, -Infinity, 1e999, 1.5], "c": "ok \\ud800 \\ud83d\\ude00", "\\udfff": 1}')
            self.assertEqual(accounts.read_json_strict(p, {}),
                             {"a": None, "b": [None, None, None, 1.5], "c": "ok \ufffd \U0001F600", "\ufffd": 1})
            self.assertEqual(os.listdir(d), ["x.json"], "repaired on read, not moved aside")
            with self.assertRaises(ValueError):
                accounts.write_json_atomic(p, {"x": float("nan")})
            self.assertEqual(os.listdir(d), ["x.json"], "no temp file left, the old file not replaced")
        finally:
            shutil.rmtree(d, ignore_errors=True)
        # a retry of a compare-and-set write whose version the server moved forward is not a conflict
        notes = {"refs": {"1.1": {"text": "a", "updated": 100}}, "deleted": {}}
        inc = {"text": "b", "updated": 40}
        self.assertEqual(accounts.apply_note_changes(notes, {"1.1": dict(inc)}, {}, {"1.1": 100}), (True, {}))
        self.assertEqual(notes["refs"]["1.1"], {"text": "b", "updated": 101})
        self.assertEqual(accounts.apply_note_changes(notes, {"1.1": dict(inc)}, {}, {"1.1": 100}), (False, {}), "the retry")
        changed, conflicts = accounts.apply_note_changes(notes, {"1.1": {"text": "c", "updated": 40}}, {}, {"1.1": 100})
        self.assertEqual((changed, conflicts), (False, {"1.1": {"text": "b", "updated": 101}}), "other content still conflicts")

    def test_i12_vault_links_resolve_like_the_app(self):
        """C1-3: 'Add to note' writes refLabel() ('Psalm 23:1', 'Hebrews 6:20–7:3') and the app opens abbreviations,
        lowercase and aliased links too; the export left all of these as links the vault cannot resolve."""
        vl = accounts._vault_links
        for src, want in (("[[Psalm 23:1]]", "[[Psalms 23.1|Psalm 23:1]]"), ("[[Psalms 23:1]]", "[[Psalms 23.1|Psalms 23:1]]"),
                          ("[[Hebrews 6:20–7:3]]", "[[Hebrews 6.20|Hebrews 6:20–7:3]]"), ("[[John 3:16-4:2]]", "[[John 3.16|John 3:16-4:2]]"),
                          ("[[John 3:16–18]]", "[[John 3.16|John 3:16–18]]"), ("[[Rom 8:28]]", "[[Romans 8.28|Rom 8:28]]"),
                          ("[[john 3:16]]", "[[John 3.16|john 3:16]]"), ("[[John 3:16|this verse]]", "[[John 3.16|this verse]]"),
                          ("[[Psalm 23]]", "[[Psalms 23|Psalm 23]]"), ("[[Jude 3]]", "[[Jude 1.3|Jude 3]]"),
                          ("[[1 cor 13]]", "[[1 Corinthians 13|1 cor 13]]"), ("[[II Kings 2:11]]", "[[2 Kings 2.11|II Kings 2:11]]"),
                          ("[[Song of Solomon 2:1]]", "[[Song of Songs 2.1|Song of Solomon 2:1]]"),
                          # already vault-style, not a verse, or a verse that does not exist: unchanged
                          ("[[John 3.16|John 3:16]]", "[[John 3.16|John 3:16]]"), ("[[John 3]]", "[[John 3]]"), ("[[Job]]", "[[Job]]"),
                          ("[[Grace]]", "[[Grace]]"), ("[[verses/John 3.16|x]]", "[[verses/John 3.16|x]]"), ("[[John 3:99]]", "[[John 3:99]]")):
            self.assertEqual(vl(src), want, src)
        z = zipfile.ZipFile(io.BytesIO(accounts.obsidian_zip({"refs": {"43.10.11": {"text": "See [[Psalm 23:1]] and [[Heb 6:20-7:3]].",
                                                                                     "updated": 1}}})))
        self.assertIn("See [[Psalms 23.1|Psalm 23:1]] and [[Hebrews 6.20|Heb 6:20-7:3]].", z.read("study-notes/John 10.11.md").decode())

    def test_i13_repeat_link_and_word_rows_coalesce(self):
        """R2-94: reopening the same cross-reference (or clicking the same word) added a 'Followed…' row every time."""
        now = now_ms()
        lib = accounts.new_library(now)
        x = lambda to, dt: {"type": "xref.open", "b": 43, "c": 3, "v": 16, "to": to, "t": now - dt}  # noqa: E731
        w = lambda word, dt: {"type": "word.study", "b": 43, "c": 3, "v": 16, "strong": "G26", "word": word, "t": now - dt}  # noqa: E731
        accounts.apply_events(lib, [x("45.5.8", 3000), x("45.5.8", 2000), x("45.5.8", 1000), x("45.8.32", 900),
                                    w("ἀγάπη", 800), w("ἀγάπη", 700), w("ἠγάπησεν", 600)], now)
        rows = [(a["type"], a["x"].get("to") or a["x"].get("word")) for a in lib["activity"] if a["type"] in ("xref.open", "word.study")]
        self.assertEqual(rows, [("xref.open", "45.5.8"), ("xref.open", "45.8.32"), ("word.study", "ἀγάπη"), ("word.study", "ἠγάπησεν")],
                         "one row per link / word; a different link or word from the same verse is still its own row")
        accounts.apply_events(lib, [x("45.5.8", -11 * 60 * 1000)], now + 11 * 60 * 1000)
        self.assertEqual(sum(1 for a in lib["activity"] if a["type"] == "xref.open" and a["x"]["to"] == "45.5.8"), 2, "after 10 min it is new")

    def test_i14_stats_for_an_early_today(self):
        """C1-33: the 90-day window and the streak walk ran past 0001-01-01 (OverflowError → 500)."""
        lib = accounts.new_library()
        server_day = datetime.date.today().isoformat()
        for today in ("0001-01-01", "0001-03-30", "0001-12-31"):
            self.assertEqual(accounts.compute_stats(lib, 0, today)["today"], server_day, today)
        self.assertEqual(accounts.compute_stats(lib, 0, "0002-01-01")["today"], "0002-01-01", "a computable date is kept")
        d0 = datetime.date.min  # an imported streak that reaches back to day one ends there
        lib["days"] = {(d0 + datetime.timedelta(days=i)).isoformat(): dict(accounts.new_day(), s=600) for i in range(366)}
        self.assertEqual(accounts.compute_stats(lib, 0, "0002-01-01")["streak"]["current"], 366)

    def test_i15_window_table_stays_bounded(self):
        """QC 2: hosted, AUTH_WINDOW counts per visitor address and email (Handler._client_key), keys a client makes up
        freely; 5,000 sign-in attempts with distinct emails from one address must not grow the server by 5,000 keys."""
        import serve
        w = serve.Window(30, 60, cap=serve.AUTH_WINDOW.cap)
        t = [1000.0]; w.clock = lambda: t[0]
        key = lambda email: f"203.0.113.9|{hashlib.sha256(email.encode('utf-8')).hexdigest()[:16]}"
        for i in range(5000):
            self.assertEqual(w.check(key(f"ghost{i}-{RUN}@example.test")), 0); t[0] += 0.001
        self.assertEqual(serve.AUTH_WINDOW.cap, 4096)
        self.assertLessEqual(len(w.hits), w.cap, "past the cap the least recently hit keys go")
        self.assertIn(key(f"ghost4999-{RUN}@example.test"), w.hits)
        self.assertNotIn(key(f"ghost0-{RUN}@example.test"), w.hits)
        self.assertEqual(len(w.hits[key(f"ghost4999-{RUN}@example.test")]), 1, "a kept key still counts its hits")
        t[0] += 61  # every hit has aged out: the next hit past the cap sweeps them all
        self.assertEqual(w.check(key("fresh@example.test")), 0)
        self.assertEqual(list(w.hits), [key("fresh@example.test")])
        w.unrecord(key("fresh@example.test"))  # given back (the backstop refused): nothing is kept for it
        self.assertEqual(w.hits, {})
        self.assertEqual(w.check(key("look@example.test"), record=False), 0)
        self.assertEqual(w.hits, {}, "a look without a hit leaves nothing behind")
        for _ in range(30): w.check("*")
        self.assertEqual(w.check("*"), 60, "the limit itself is unchanged")


# ======================================================================= K-O. regression tests for the security/integrity review
class T12_AuthBursts(Base):
    """Finding 1: the lockout and the rate-limit windows were check-then-act, so simultaneous requests all passed."""

    def test_k1_account_lockout_holds_under_a_burst(self):
        email, pw = H.account("burst", "lockout under a simultaneous burst")
        self.assertEqual(Client().signup(email, pw, name="Burst").status, 201)
        statuses = burst([json_post_bytes("/api/auth/login", {"email": email, "password": "wrong-" + secrets.token_urlsafe(8)})
                          for _ in range(20)])
        self.assertEqual(sorted(statuses), [401] * 5 + [429] * 15, statuses)
        u = [u for u in H.read("users.json")["users"].values() if u["email"] == email][0]
        self.assertEqual(u["failedLogins"], 5, "the 5th failure locks the account, however the guesses are timed")
        self.assertGreater(u["lockUntil"], 0)

    def test_k2_global_auth_window_holds_under_a_burst(self):
        H.restart()
        statuses = burst([json_post_bytes("/api/auth/login", {"email": f"ghost-burst{i}-{RUN}@example.test", "password": "x" * 12})
                          for i in range(45)])
        self.assertEqual((statuses.count(401), statuses.count(429)), (30, 15), statuses)

    def test_k3_signup_window_holds_under_a_burst(self):
        H.restart()
        accts = [H.account(f"sgb{i}", "signup window under a simultaneous burst (some refused)") for i in range(13)]
        statuses = burst([json_post_bytes("/api/auth/signup", {"email": e, "name": f"Burst {i}", "password": p})
                          for i, (e, p) in enumerate(accts)])
        self.assertEqual((statuses.count(201), statuses.count(429)), (10, 3), statuses)


class T13_StaticAndDisplayStrings(Base):
    def test_l1_no_directory_listings(self):
        """Finding 2: app/ subdirectories were listed (autoindex)."""
        c = Client()
        for path in ("/js/", "/data/", "/css/"):
            r = c.req("GET", path)
            self.assertEqual(r.status, 404, path)
            self.assertNotIn(b"Directory listing", r.raw, path)
            self.assertEqual(r.headers["X-Content-Type-Options"], "nosniff")
        for method in ("GET", "HEAD"):
            for path in ("/js", "/data", "/css", "/data/art"):  # no 301 to '/js/' either: folder names are not disclosed
                st, hdrs, _ = raw_req(method, path)
                self.assertEqual((st, hdrs.get("location")), (404, None), f"{method} {path}")
        self.assertEqual(c.req("GET", "/").status, 200, "the app itself still loads")
        self.assertEqual(raw_req("HEAD", "/")[0], 200)
        self.assertEqual(c.req("GET", "/js/store.js").status, 200)

    def test_l1c_mock_harnesses_are_not_served(self):
        """R2-3: app/mock/_harness-appjs.html ('dry run only') ran the whole app shell outside dry mode when opened
        without ?dry and moved the real 'Continue reading' position. app/mock/ is served only with --dev, and the
        harness itself adds ?dry before main.js loads."""
        for method in ("GET", "HEAD"):
            for path in ("/mock/_harness-appjs.html", "/mock/pro.html", "/MOCK/_harness-appjs.html", "//mock/books.html", "/mock/", "/mock"):
                self.assertEqual(raw_req(method, path)[0], 404, f"{method} {path}")
        self.assertEqual(raw_req("GET", "/js/main.js")[0], 200)
        with open(os.path.join(REPO, "app", "mock", "_harness-appjs.html"), encoding="utf-8") as f:
            page = f.read()
        self.assertNotIn('src="js/main.js"', page, "main.js must not load before the ?dry redirect")
        self.assertIn("has('dry')) import('./js/main.js')", page)
        H.restart("--dev")
        try:
            self.assertEqual(raw_req("GET", "/mock/_harness-appjs.html")[0], 200, "--dev still serves them")
        finally:
            H.restart()

    def test_l1d_library_with_an_early_today(self):
        """C1-33: GET /api/library?today=0001-01-01 answered 500 (OverflowError); a bad 'today' falls back to the server date."""
        c = Client()
        for today in ("0001-01-01", "0001-03-30", "0001-03-31", "9999-12-31", "2026-02-30"):
            r = c.library(today=today, activity=0)
            self.assertEqual(r.status, 200, today)
        self.assertEqual(c.library(today="0001-01-01").json["stats"]["today"], datetime.date.today().isoformat())

    def test_l1e_reopened_link_is_one_activity_row(self):
        """R2-94: three identical xref.open events (open, close, reopen…) are one 'Followed…' row."""
        email, pw = H.account("xrefdup", "repeat xref.open coalesces")
        c = Client()
        self.assertEqual(c.signup(email, pw, name="Xref").status, 201)
        t = now_ms()
        r = c.events([{"type": "xref.open", "b": 43, "c": 3, "v": 16, "to": "45.5.8", "t": t + i} for i in range(3)])
        self.assertEqual(r.status, 200, r)
        rows = [a for a in c.library(activity=50).json["activity"] if a["type"] == "xref.open"]
        self.assertEqual([(a["ref"], a["x"]) for a in rows], [("43.3.16", {"to": "45.5.8"})])

    def test_l1b_undecodable_static_paths_are_404(self):
        """C1-32: '%ff', an overlong '%C0%AF' or a cut-off '%E2%82' is not UTF-8. unquote() raised outside the try, so
        the request died with no response (and a traceback in the log), GET and HEAD alike."""
        for method in ("GET", "HEAD"):
            for path in ("/%ff", "/%C0%AF", "/%E2%82", "/js/%ff.js", "/%00", "/%ED%A0%80", "/.DS_Store", "/js/.x.js"):
                self.assertEqual(raw_req(method, path)[0], 404, f"{method} {path}")
        self.assertEqual(raw_req("GET", "/js/store.js")[0], 200, "real files are still served")

    def test_l2_display_strings_are_stored_raw_and_served_as_json(self):
        """Finding 3 (no server change): pins the contract the front end relies on. Names, labels and activity words
        are stored and returned verbatim (the client must esc() them), only ever as application/json + nosniff,
        and control characters are stripped so nothing can reach a header."""
        email, pw = H.account("raw", "display strings contract")
        c = Client()
        self.assertEqual(c.signup(email, pw, name="Raw").status, 201)
        name = '<script>alert(1)</script> & "Co"'
        self.assertEqual(c.req("PATCH", "/api/account", {"name": name}).json["user"]["name"], name)
        me = c.me()
        self.assertEqual(me.json["user"]["name"], name)
        self.assertTrue(me.headers["Content-Type"].startswith("application/json"))
        self.assertEqual(me.headers["X-Content-Type-Options"], "nosniff")
        label = "<img src=x onerror=alert(1)>"
        r = c.req("POST", "/api/library/bookmarks", {"ref": "43.3.16", "label": label}, scoped=True)
        self.assertEqual(r.json["bookmark"]["label"], label)
        c.events([{"type": "word.study", "b": 43, "c": 3, "v": 16, "t": now_ms(), "word": "<svg onload=alert(1)>"}])
        words = [a["x"].get("word") for a in c.library().json["activity"] if a["type"] == "word.study"]
        self.assertEqual(words, ["<svg onload=alert(1)>"])
        r = c.req("PATCH", "/api/account", {"name": "A\r\nSet-Cookie: injected=1"})
        self.assertFalse("\r" in r.json["user"]["name"] or "\n" in r.json["user"]["name"])
        self.assertFalse([x for x in r.set_cookies() if "injected" in x])

    def test_l3_listen_backlog_absorbs_a_page_load_burst(self):
        """Finding: the default listen backlog (5) reset connections while index.html pulled in its modules,
        stylesheets and data files all at once, which left the app blank. With the server's accept loop frozen
        (SIGSTOP), the kernel alone must complete 64 simultaneous connections; once it resumes, every one of them
        gets its file."""
        import signal
        paths = ["/", "/js/store.js", "/js/reader.js", "/js/art.js", "/css/styles.css", "/css/art.css",
                 "/data/meta.json", "/data/art.json"]
        paths = [p for p in paths if os.path.exists(os.path.join(REPO, "app", p.lstrip("/") or "index.html"))]
        n = 64
        socks, errors = [None] * n, []

        def connect(i):
            try:
                socks[i] = socket.create_connection(("127.0.0.1", H.port), timeout=3)
            except OSError as e:
                errors.append(f"{i}: {e!r}")

        os.kill(H.proc.pid, signal.SIGSTOP)
        try:
            threads = [threading.Thread(target=connect, args=(i,)) for i in range(n)]
            [t.start() for t in threads]
            [t.join() for t in threads]
        finally:
            os.kill(H.proc.pid, signal.SIGCONT)
        try:
            self.assertEqual(errors, [], "every connection of the burst was queued by the kernel")
            statuses = [0] * n

            def fetch(i):
                path = paths[i % len(paths)]
                try:
                    socks[i].settimeout(20)
                    socks[i].sendall(f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{H.port}\r\nConnection: close\r\n\r\n"
                                     .encode("latin-1"))
                    buf = b""
                    while True:
                        chunk = socks[i].recv(65536)
                        if not chunk:
                            break
                        buf += chunk
                    parts = buf.split(b" ", 2)
                    statuses[i] = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
                except OSError:
                    statuses[i] = 0
            threads = [threading.Thread(target=fetch, args=(i,)) for i in range(n)]
            [t.start() for t in threads]
            [t.join() for t in threads]
            self.assertEqual(statuses, [200] * n)
        finally:
            for s in socks:
                if s:
                    s.close()
        self.assertEqual(Client().req("GET", "/js/store.js").status, 200, "the server is healthy afterwards")


class T14_NoteIntegrity(Base):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        email, pw = H.account("cas", "note compare-and-set and clock checks")
        c = Client()
        assert c.signup(email, pw, name="Cas").status == 201
        cls.c, cls.uid = c, c.scope

    def note(self, text, updated, **kw):
        return dict({"text": text, "highlight": "", "tags": [], "videos": [], "created": updated, "updated": updated}, **kw)

    def changes(self, c, set_=None, del_=None, base=None):
        body = {"set": set_ or {}, "del": del_ or {}}
        if base is not None:
            body["base"] = base
        return c.req("POST", "/api/notes/changes", body, scoped=True)

    def test_m1_a_stale_tab_cannot_overwrite_a_newer_edit(self):
        """Finding 4: an out-of-date tab with a newer clock silently replaced another tab's edit."""
        a, k = self.c, "19.23.1"
        b = a.tab()
        r = self.changes(a, {k: self.note("The LORD is my shepherd", now_ms())}, base={k: None})
        self.assertEqual((r.status, r.json["changed"], r.json["conflicts"]), (200, True, {}))
        stale = a.req("GET", "/api/notes").json["refs"][k]  # tab A keeps this copy
        self.assertEqual(r.json["versions"], {k: stale["updated"]})
        time.sleep(0.01)
        newer = dict(stale, text="The LORD is my shepherd. A long reflection written in tab B.", updated=now_ms())
        r = self.changes(b, {k: newer}, base={k: stale["updated"]})
        self.assertEqual((r.json["changed"], r.json["conflicts"]), (True, {}))
        time.sleep(0.01)
        r = self.changes(a, {k: dict(stale, highlight="yellow", updated=now_ms())}, base={k: stale["updated"]})
        self.assertFalse(r.json["changed"])
        self.assertEqual(r.json["conflicts"], {k: newer}, "tab A is told, and gets the newer note")
        self.assertNotIn(k, r.json["versions"])
        self.assertEqual(a.req("GET", "/api/notes").json["refs"][k]["text"], newer["text"], "tab B's text survives")
        r = self.changes(a, {k: dict(newer, highlight="yellow", updated=now_ms())}, base={k: newer["updated"]})
        self.assertEqual((r.json["changed"], r.json["conflicts"]), (True, {}), "rebased on the server copy, it applies")
        got = a.req("GET", "/api/notes").json["refs"][k]
        self.assertEqual((got["text"], got["highlight"]), (newer["text"], "yellow"))

    def test_m2_compare_and_set_rules(self):
        a, t = self.c, now_ms()
        self.assertTrue(self.changes(a, {"20.1.1": self.note("first", t)}, base={"20.1.1": None}).json["changed"])
        r = self.changes(a.tab(), {"20.1.1": self.note("second", t + 5)}, base={"20.1.1": None})
        self.assertEqual(r.json["conflicts"]["20.1.1"]["text"], "first", "two tabs creating the same note")
        n = self.note("retry me", t + 10)
        r1, r2 = (self.changes(a, {"20.1.2": n}, base={"20.1.2": None}) for _ in range(2))
        self.assertEqual((r1.json["changed"], r2.json["changed"], r2.json["conflicts"]), (True, False, {}), "a retry is no conflict")
        cur = a.req("GET", "/api/notes").json["refs"]["20.1.1"]
        r = self.changes(a, del_={"20.1.1": now_ms()}, base={"20.1.1": cur["updated"] - 1})
        self.assertEqual((r.json["changed"], r.json["conflicts"]), (False, {"20.1.1": cur}))
        r = self.changes(a, del_={"20.1.1": now_ms()}, base={"20.1.1": cur["updated"]})
        self.assertEqual((r.json["changed"], r.json["conflicts"], r.json["versions"]), (True, {}, {"20.1.1": None}))
        self.assertEqual(self.changes(a, del_={"20.1.1": now_ms()}, base={"20.1.1": cur["updated"]}).json["conflicts"], {},
                         "deleting what another tab already deleted is fine")
        r = self.changes(a, {"20.1.1": self.note("edit of a deleted note", now_ms())}, base={"20.1.1": cur["updated"]})
        self.assertEqual(r.json["conflicts"], {"20.1.1": None})
        self.assertTrue(self.changes(a, {"20.1.1": self.note("new again", 1)}, base={"20.1.1": None}).json["changed"],
                        "a client that saw no note may create it, whatever the tombstone time")
        cur = a.req("GET", "/api/notes").json["refs"]["20.1.2"]
        r = self.changes(a, {"20.1.2": self.note("clock behind", cur["updated"] - 60000)}, base={"20.1.2": cur["updated"]})
        self.assertEqual((r.json["changed"], r.json["versions"]), (True, {"20.1.2": cur["updated"] + 1}), "the version moves forward")
        self.assertEqual(a.req("GET", "/api/notes").json["refs"]["20.1.2"]["updated"], cur["updated"] + 1)
        ok = self.note("x", now_ms())
        self.assertErr(self.changes(a, {"20.1.3": ok}, base={"20.1.3": "x"}), 400, "bad_request", "20.1.3")
        self.assertErr(self.changes(a, {"20.1.3": ok}, base={"20.1.3": -1}), 400, "bad_request", "20.1.3")
        self.assertErr(self.changes(a, {"20.1.3": ok}, base=[]), 400, "bad_request")
        self.assertNotIn("20.1.3", a.req("GET", "/api/notes").json["refs"])

    def test_m3_future_timestamps_are_clamped(self):
        """Finding 5: a note or tombstone from the future froze a note / blocked a ref for good."""
        a, year = self.c, 365 * 86400 * 1000
        self.assertTrue(self.changes(a, {"43.3.16": self.note("saved with a wrong clock", now_ms() + 10 * year)}).json["changed"])
        stored = a.req("GET", "/api/notes").json["refs"]["43.3.16"]
        self.assertLessEqual(max(stored["updated"], stored["created"]), now_ms())
        time.sleep(0.005)
        r = self.changes(a, {"43.3.16": self.note("a normal edit", now_ms())})
        self.assertEqual((r.json["changed"], r.json["conflicts"]), (True, {}), "the note is not frozen")
        time.sleep(0.005)
        self.assertEqual(self.changes(a, del_={"43.3.16": now_ms()}).json["conflicts"], {})
        self.assertTrue(self.changes(a, del_={"1.1.1": now_ms() + 10 * year}).json["changed"])
        self.assertLessEqual(H.read("profiles", self.uid, "notes.json")["deleted"]["1.1.1"], now_ms())
        time.sleep(0.005)
        r = self.changes(a, {"1.1.1": self.note("a new note", now_ms())})
        self.assertEqual((r.json["changed"], r.json["conflicts"]), (True, {}), "a future tombstone does not block the ref")
        self.assertEqual(self.changes(a, {"1.1.2": self.note("x", 1e300, created=1e300)}).status, 200)
        n = a.req("GET", "/api/notes").json["refs"]["1.1.2"]
        self.assertLessEqual(max(n["updated"], n["created"]), now_ms())
        self.assertErr(self.changes(a, {"1.1.3": self.note("x", now_ms(), videos=[{"url": "u", "start": 1e300}])}), 400, "invalid_note", "1.1.3")
        self.changes(a, {"1.1.4": self.note("x", now_ms(), videos=[{"url": "u", "added": now_ms() + year}])})
        self.assertLessEqual(a.req("GET", "/api/notes").json["refs"]["1.1.4"]["videos"][0]["added"], now_ms())

    def test_m4_future_values_already_on_disk_are_repaired(self):
        a, year = self.c, 365 * 86400 * 1000
        path = os.path.join(H.data, "profiles", self.uid, "notes.json")
        cur = H.read("profiles", self.uid, "notes.json")
        cur["refs"]["40.1.1"] = self.note("frozen by an old client", now_ms() + 10 * year)
        cur["deleted"]["40.1.2"] = now_ms() + 10 * year
        put_raw(path, json.dumps(cur).encode("utf-8"))
        got = a.req("GET", "/api/notes").json["refs"]["40.1.1"]
        self.assertLessEqual(got["updated"], now_ms())
        self.assertEqual(a.req("GET", "/api/notes").json["refs"]["40.1.1"]["updated"], got["updated"], "stable across reads")
        time.sleep(0.005)
        r = self.changes(a, {"40.1.1": self.note("edited", now_ms())}, base={"40.1.1": got["updated"]})
        self.assertEqual((r.json["changed"], r.json["conflicts"]), (True, {}))
        r = self.changes(a, {"40.1.2": self.note("created", now_ms())})
        self.assertEqual((r.json["changed"], r.json["conflicts"]), (True, {}))
        disk = H.read("profiles", self.uid, "notes.json")
        self.assertTrue(all(v <= now_ms() for v in disk["deleted"].values()), "the repaired values were saved")

    def test_m5_retry_after_the_version_moved_forward(self):
        """A lost response retried by a tab whose clock is behind: the server bumped `updated`, the retry still
        matches that write, so it is no conflict (no misleading 'changed in another window')."""
        a, k = self.c, "21.3.1"
        r = self.changes(a, {k: self.note("To every thing there is a season", now_ms())}, base={k: None})
        stored = r.json["versions"][k]
        body = {k: self.note("To every thing there is a season, and a time", stored - 60000)}
        r1 = self.changes(a, body, base={k: stored})
        self.assertEqual((r1.json["changed"], r1.json["conflicts"], r1.json["versions"]), (True, {}, {k: stored + 1}))
        r2 = self.changes(a, body, base={k: stored})
        self.assertEqual((r2.json["changed"], r2.json["conflicts"], r2.json["versions"]), (False, {}, {k: stored + 1}))
        r3 = self.changes(a.tab(), {k: self.note("a different edit from an old copy", stored - 60000)}, base={k: stored})
        self.assertEqual(list(r3.json["conflicts"]), [k], "different content from the same old base still conflicts")
        self.assertEqual(a.req("GET", "/api/notes").json["refs"][k]["text"], body[k]["text"])


class T15_LibraryIntegrity(Base):
    def test_n1_reimport_with_a_full_activity_log_changes_nothing(self):
        """Finding 6: every re-import pushed one real history entry out and grew imports[]."""
        g, day = Client(), 86400 * 1000
        t_old = now_ms() - 20 * day
        r = g.events([{"type": "verse.study", "t": t_old + i * 1000, "b": 40, "c": 5, "v": i + 1} for i in range(10)]
                     + [{"type": "chapter.read", "t": t_old, "b": 40, "c": 5}])
        self.assertEqual(r.json["applied"], 11)
        g.req("POST", "/api/library/bookmarks", {"ref": "40.5.3", "label": "guest"}, scoped=True)
        email, pw = H.account("reimp", "guest re-import with a full activity log")
        p = Client()
        self.assertEqual(p.signup(email, pw, name="Reimp", import_guest=True).status, 201)
        base = now_ms() - day
        for bi in range(6):
            r = p.events([{"type": "xref.open", "t": base + (bi * 200 + i) * 1000, "b": 19, "c": 119,
                           "v": (bi * 200 + i) % 176 + 1, "to": "43.1.1"} for i in range(200)])
            self.assertEqual(r.json["applied"], 200)
        before = p.library(activity=1000).json
        self.assertEqual(before["activityTotal"], 1000)
        self.assertLess(t_old, before["activity"][-1]["t"], "precondition: the guest's entries are older than all the profile keeps")
        for _ in range(3):
            r = p.req("POST", "/api/profile/import-guest", {}, scoped=True)
            self.assertEqual(r.json["imported"], {"notes": 0, "bookmarks": 0, "chapters": 0, "links": 0, "marks": 0})
            self.assertEqual(r.json["rev"]["library"], before["rev"], "nothing changed")
        self.assertEqual(p.library(activity=1000).json["activity"], before["activity"], "no real history was pushed out")
        self.assertEqual([i["mode"] for i in H.read("profiles", p.scope, "library.json")["imports"]], ["copy"])

    def test_n2_wrongly_shaped_files_do_not_break_the_endpoints(self):
        """Finding 7: a readable but wrongly shaped library.json / users.json record gave permanent 500s."""
        email, pw = H.account("shape", "wrongly shaped library.json")
        c = Client()
        self.assertEqual(c.signup(email, pw, name="Shape").status, 201)
        uid = c.scope
        c.events([{"type": "verse.study", "b": 1, "c": 1, "v": 1, "t": now_ms()}])
        c.req("POST", "/api/library/bookmarks", {"ref": "43.3.16"}, scoped=True)
        path = os.path.join(H.data, "profiles", uid, "library.json")
        lib = H.read("profiles", uid, "library.json")
        lib["chapters"]["1.1"]["studied"] = 5
        lib["chapters"]["1.2"] = {"studied": ["a", 3], "visits": "x", "readAt": "soon"}
        lib["appliedBatches"] = 5
        lib["imports"] = 5
        lib["bookmarks"].append({"id": "bm_aaaaaaaaaaaa", "ref": "43.3.17", "created": "yesterday", "label": 7, "color": "pink"})
        lib["lastPosition"] = {"b": 43, "c": 3, "t": "x", "scrollFrac": "far"}
        lib["activity"].append({"t": 5, "type": "chapter.open", "ref": ["not", "a", "ref"]})
        put_raw(path, json.dumps(lib).encode("utf-8"))
        r = c.library()
        self.assertEqual(r.status, 200, r)
        self.assertEqual((r.json["chapters"]["1.1"]["studied"], r.json["chapters"]["1.2"]["studied"]), ([], [3]))
        self.assertEqual({b["ref"]: b["color"] for b in r.json["bookmarks"]}, {"43.3.16": "red", "43.3.17": "red"})
        self.assertEqual(c.events([{"type": "chapter.open", "b": 1, "c": 3, "t": now_ms()}]).status, 200)
        self.assertEqual(c.req("POST", "/api/library/bookmarks", {"ref": "43.3.18"}, scoped=True).status, 201)
        self.assertEqual(c.req("GET", "/api/export/profile").status, 200)
        self.assertEqual(c.req("GET", "/api/export/obsidian").status, 200)
        self.assertEqual(c.req("POST", "/api/profile/import-guest", {}, scoped=True).status, 200)
        r = c.req("PUT", "/api/notes", {"refs": {"43.3.16": {"text": "x", "tags": 5, "videos": "nope"}}, "studies": []}, scoped=True)
        self.assertEqual(r.status, 200, "the legacy PUT stores notes unvalidated")
        self.assertEqual(c.req("GET", "/api/export/obsidian").status, 200)
        self.assertFalse([f for f in os.listdir(os.path.dirname(path)) if ".corrupt-" in f], "repaired, not moved aside")
        # users.json and sessions.json records
        email2, pw2 = H.account("shape2", "wrongly shaped users.json record")
        c2 = Client()
        self.assertEqual(c2.signup(email2, pw2, name="Shape Two").status, 201)
        uid2 = c2.scope
        accounts.configure(H.data, H.port)
        with accounts.auth_lock():
            users = H.read("users.json")
            rec = users["users"][uid2]
            del rec["uid"]
            rec.update(lockUntil="soon", failedLogins="x", name=5, email=email2.upper())
            put_raw(os.path.join(H.data, "users.json"), json.dumps(users).encode("utf-8"))
            sessions = H.read("sessions.json")
            sessions["sessions"][hashlib.sha256(c2.token().encode()).hexdigest()]["lastSeen"] = "x"
            put_raw(os.path.join(H.data, "sessions.json"), json.dumps(sessions).encode("utf-8"))
        me = c2.me()
        self.assertEqual((me.status, me.json["signedIn"], me.json["user"]["uid"]), (200, True, uid2))
        self.assertErr(Client().login(email2, "wrong-" + secrets.token_urlsafe(6)), 401, "bad_credentials")
        self.assertEqual(Client().login(email2, pw2).status, 200)

    def test_n3_refs_with_leading_zeros(self):
        """Finding 8: '43.03.16' and '43.3.16' were separate bookmarks and separate notes."""
        email, pw = H.account("canon", "canonical refs")
        c = Client()
        self.assertEqual(c.signup(email, pw, name="Canon").status, 201)
        uid = c.scope
        self.assertEqual(c.req("POST", "/api/library/bookmarks", {"ref": "43.3.16"}, scoped=True).status, 201)
        for ref in ("43.03.16", "43.3.016", "43.003.16", "043.3.16", "01.1"):
            self.assertErr(c.req("POST", "/api/library/bookmarks", {"ref": ref}, scoped=True), 400, "invalid_ref", "ref")
        self.assertEqual(len(c.library().json["bookmarks"]), 1)
        self.assertErr(c.req("POST", "/api/notes/changes", {"set": {"43.03.16": {"text": "x"}}}, scoped=True), 400, "invalid_note", "43.03.16")
        r = c.events([{"type": "xref.open", "b": 43, "c": 3, "v": 16, "to": "45.05.8", "t": now_ms()}])
        self.assertEqual((r.json["applied"], r.json["rejected"]), (0, 1))
        # files written before this rule (old or buggy clients) are folded into the canonical key when read
        lp = os.path.join(H.data, "profiles", uid, "library.json")
        lib = H.read("profiles", uid, "library.json")
        lib["bookmarks"].append({"id": "bm_bbbbbbbbbbbb", "ref": "43.03.16", "b": 43, "c": 3, "v": 16, "label": "", "color": "red",
                                 "created": 1, "updated": 1})
        lib["chapters"]["43.03"] = {"visits": 2, "seconds": 30, "studied": [5], "read": True, "readAt": 100}
        lib["chapters"]["43.3"] = {"visits": 1, "seconds": 10, "studied": [16]}
        put_raw(lp, json.dumps(lib).encode("utf-8"))
        np_ = os.path.join(H.data, "profiles", uid, "notes.json")
        notes = H.read("profiles", uid, "notes.json")
        notes["refs"]["43.3.16"] = {"text": "older", "updated": 1000, "created": 1000}
        notes["refs"]["43.03.16"] = {"text": "newer", "updated": 2000, "created": 2000}
        tomb = now_ms() - 1000
        notes["deleted"]["43.03.17"] = tomb
        put_raw(np_, json.dumps(notes).encode("utf-8"))
        j = c.library().json
        self.assertEqual([b["ref"] for b in j["bookmarks"]], ["43.3.16"])
        self.assertNotIn("43.03", j["chapters"])
        ch = j["chapters"]["43.3"]
        self.assertEqual((ch["visits"], ch["seconds"], ch["studied"], ch["read"]), (2, 30, [5, 16], True))
        refs = c.req("GET", "/api/notes").json["refs"]
        self.assertEqual((refs["43.3.16"]["text"], "43.03.16" in refs), ("newer", False))
        z = zipfile.ZipFile(io.BytesIO(c.req("GET", "/api/export/obsidian").raw))
        self.assertFalse([n for n in z.namelist() if " 0" in n or ".0" in n], z.namelist())
        self.assertEqual(z.read("study-notes/Bookmarks.md").decode().count("John 3:16"), 1)
        self.assertEqual(c.req("POST", "/api/notes/changes", {"set": {"43.3.16": {"text": "saved", "updated": now_ms()}}},
                               scoped=True).json["changed"], True)
        disk = H.read("profiles", uid, "notes.json")
        self.assertEqual((sorted(disk["refs"]), disk["deleted"]), (["43.3.16"], {"43.3.17": tomb}), "saved canonical")


class T16_Storage(Base):
    def test_o1_a_damaged_users_json_does_not_orphan_profiles(self):
        """Finding 9: after users.json was damaged, the same email signed up into an empty profile, every other
        session was purged, and there was no users.json backup."""
        email, pw = H.account("reg", "damaged users.json")
        c = Client()
        self.assertEqual(c.signup(email, pw, name="Reg").status, 201)
        uid, tok = c.scope, c.token()
        owner = H.read("profiles", uid, "user.json")
        self.assertEqual((owner["uid"], owner["email"], "pw" in owner), (uid, email, False))
        users_path = os.path.join(H.data, "users.json")
        self.assertEqual(stat.S_IMODE(os.stat(users_path + ".bak").st_mode), 0o600)
        self.assertIn("users", H.read("users.json.bak"))
        # a live session of a uid that users.json does not list survives other sign-ins; expired ones go
        accounts.configure(H.data, H.port)
        live, dead = "f" * 64, "e" * 64
        with accounts.auth_lock():
            s = accounts.load_sessions()
            t = now_ms()
            s["sessions"][live] = {"uid": "u" + "0" * 16, "created": t, "lastSeen": t, "expires": t + 3600000, "hardExpires": t + 3600000,
                                   "remember": False, "ua": ""}
            s["sessions"][dead] = dict(s["sessions"][live], expires=t - 1000)
            accounts.save_sessions(s)
        self.assertEqual(Client().login(email, pw).status, 200)
        sess = H.read("sessions.json")["sessions"]
        self.assertEqual((live in sess, dead in sess), (True, False))
        # damage users.json (a truncated write)
        with open(users_path, "rb") as f:
            good = f.read()
        n_sessions = len(sess)
        with accounts.auth_lock():
            put_raw(users_path, b'{"version": 1, "users": {')
        r = c.me()
        me = r.json
        self.assertFalse(me["signedIn"])
        self.assertEqual(me["features"], {"signup": False, "profiles": False})
        self.assertFalse([x for x in r.set_cookies() if "Max-Age=0" in x], "the browser keeps its cookie for after the restore")
        corrupt = [f for f in os.listdir(H.data) if f.startswith("users.json.corrupt-")]
        self.assertEqual(len(corrupt), 1)
        r = Client().req("POST", "/api/auth/signup", {"email": email, "name": "Reg again", "password": pw})
        self.assertErr(r, 503, "registry_unavailable")
        self.assertIn("users.json.bak", r.json["message"])
        email2, pw2 = H.account("reg2", "signup refused while users.json is damaged (never created)")
        self.assertErr(Client().req("POST", "/api/auth/signup", {"email": email2, "name": "Other", "password": pw2}), 503, "registry_unavailable")
        self.assertErr(Client().login(email, pw), 503, "registry_unavailable")
        self.assertEqual(len(H.read("sessions.json")["sessions"]), n_sessions, "nobody's sessions were purged")
        self.assertFalse(os.path.exists(users_path), "nothing wrote an empty registry over the damage")
        self.assertTrue(Client().me().json["features"]["signup"] is False)
        # restore users.json: everyone is back, still signed in
        with accounts.auth_lock():
            put_raw(users_path, good)
            for f in corrupt:
                os.unlink(os.path.join(H.data, f))
        self.assertTrue(with_cookie(tok).me().json["signedIn"], "the session survived the outage")
        self.assertEqual(c.me().json["scope"], uid, "and the same browser is signed in again")
        self.assertTrue(Client().me().json["features"]["signup"])
        # users.json restored from an older copy that lacks this profile: that email cannot sign up into a new one
        with accounts.auth_lock():
            older = json.loads(good)
            del older["users"][uid]
            put_raw(users_path, json.dumps(older).encode("utf-8"))
        self.assertErr(Client().req("POST", "/api/auth/signup", {"email": email, "name": "Reg", "password": pw}), 503,
                       "registry_unavailable", "email")
        with accounts.auth_lock():
            put_raw(users_path, good)
        self.assertEqual(Client().login(email, pw).status, 200)
        self.assertEqual([u["uid"] for u in H.read("users.json")["users"].values() if u["email"] == email], [uid])

    def test_o2_startup_removes_temp_files_left_by_a_crash(self):
        """Finding 10: '<file>.tmp-<pid>-<tid>' files from a killed server were never removed."""
        uid = sorted(d for d in os.listdir(os.path.join(H.data, "profiles")) if re.fullmatch(r"u[0-9a-f]{16}", d))[0]
        made = [os.path.join(H.data, "notes.json.tmp-123-456"), os.path.join(H.data, "users.json.tmp-1-2"),
                os.path.join(H.data, "notes.json.bak.tmp-7-7"), os.path.join(H.data, "profiles", uid, "library.json.tmp-9-9"),
                os.path.join(H.data, "cache", "esv", "43-3.json.tmp-5-5")]
        keep = os.path.join(H.data, "profiles", uid, "draft.txt")
        for p in made + [keep]:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(b'{"partial": ')
        H.restart()
        self.assertEqual([os.path.relpath(p, H.data) for p in made if os.path.exists(p)], [])
        self.assertTrue(os.path.exists(keep), "only the server's own temp files are removed")
        os.unlink(keep)
        self.assertEqual(Client().req("GET", "/api/notes").status, 200)


def strict_json(raw):
    """Parse like a browser's JSON.parse: NaN / Infinity are not JSON."""
    def refuse(name):
        raise ValueError(f"{name} is not JSON")
    return json.loads(raw.decode("utf-8"), parse_constant=refuse)


def json_with_constants(obj):
    """json.dumps, then turn the string placeholders "@NaN@" / "@Infinity@" / "@1e999@" into those raw tokens."""
    s = json.dumps(obj)
    for tok in ("NaN", "Infinity", "-Infinity", "1e999"):
        s = s.replace(f'"@{tok}@"', tok)
    return s.encode("utf-8")


class T17_Hardening(Base):
    """Second pass over findings 3, 7 and 8 (re-verified after the first round of fixes)."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        email, pw = H.account("hard", "input and storage hardening")
        c = Client()
        assert c.signup(email, pw, name="Hard").status == 201
        cls.c, cls.uid, cls.email, cls.pw = c, c.scope, email, pw

    def test_p1_values_json_cannot_carry_are_refused(self):
        """Finding 7 variant: 1e999 parses as Infinity, was stored in a note's extra field, and from then on every
        GET /api/notes answered 'Infinity', which JSON.parse rejects (the notes view broken for good)."""
        c = self.c
        for path, method, raw in (("/api/notes/changes", "POST", b'{"set": {"1.1.1": {"text": "x", "extra": 1e999}}}'),
                                  ("/api/notes/changes", "POST", b'{"set": {"1.1.1": {"text": "x", "updated": -1e400}}}'),
                                  ("/api/notes", "PUT", b'{"refs": {"1.1.1": {"text": "x", "n": 1E+999}}}'),
                                  ("/api/config", "PUT", b'{"x": Infinity}'),
                                  ("/api/library/events", "POST", b'{"batchId": "nan-batch-1", "events": [{"t": NaN}]}')):
            self.assertErr(c.req(method, path, raw=raw, scoped=True), 400, "bad_json")
        r = c.events([{"type": "position", "b": 43, "c": 3, "v": 16, "scrollFrac": 0.25, "t": now_ms()}])
        self.assertEqual(r.json["applied"], 1, "ordinary fractions still work")
        self.assertNotIn("1.1.1", c.req("GET", "/api/notes").json["refs"])
        # a lone surrogate would make the save fail (it was a 500); a proper pair is an ordinary character
        self.assertErr(c.req("POST", "/api/notes/changes", raw=b'{"set": {"1.1.2": {"text": "\\ud800"}}}', scoped=True),
                       400, "bad_json")
        self.assertErr(c.req("PATCH", "/api/account", raw=b'{"name": "Ji \\udc00"}'), 400, "bad_json")
        r = c.req("POST", "/api/notes/changes", raw=b'{"set": {"1.1.2": {"text": "joy \\ud83d\\ude00"}}}', scoped=True)
        self.assertEqual(r.status, 200, r)
        self.assertEqual(c.req("GET", "/api/notes").json["refs"]["1.1.2"]["text"], "joy \U0001F600")

    def test_p2_damaged_values_on_disk_never_break_responses(self):
        """Finding 7 variant: NaN / Infinity / 1e999 / lone surrogates already in a file (a hand edit, an old server)."""
        c, uid = self.c, self.uid
        c.req("POST", "/api/library/bookmarks", {"ref": "19.23.1"}, scoped=True)
        pdir = os.path.join(H.data, "profiles", uid)
        notes = H.read("profiles", uid, "notes.json")
        notes["refs"]["19.23.2"] = {"text": "bad \ud800 text", "updated": "@NaN@", "created": "@Infinity@", "extra": "@1e999@",
                                    "tags": ["\udfff"], "videos": []}
        notes["deleted"]["19.23.3"] = "@-Infinity@"
        notes["studies"] = {"not": "a list"}
        put_raw(os.path.join(pdir, "notes.json"), json_with_constants(notes))
        lib = H.read("profiles", uid, "library.json")
        lib["bookmarks"][0].update(label="x \udc00", extra="@NaN@", created="@1e999@")
        lib["chapters"]["19.23"] = {"seconds": "@Infinity@", "visits": "@NaN@", "note": "@NaN@"}
        lib["activity"].append({"t": now_ms(), "type": "word.study", "ref": "19.23.1", "x": {"word": "\ud800", "n": "@NaN@"}})
        lib["lastPosition"] = {"b": 19, "c": 23, "v": 1, "t": "@NaN@", "scrollFrac": "@Infinity@", "extra": "@NaN@"}
        put_raw(os.path.join(pdir, "library.json"), json_with_constants(lib))
        accounts.configure(H.data, H.port)
        with accounts.auth_lock():
            users = H.read("users.json")
            users["users"][uid].update(name="Hard \ud800", lockUntil="@NaN@", created="@1e999@", extra="@Infinity@")
            put_raw(os.path.join(H.data, "users.json"), json_with_constants(users))
        for path in ("/api/auth/me", "/api/notes", "/api/library?activity=1000", "/api/export/profile"):
            r = c.req("GET", path)
            self.assertEqual(r.status, 200, f"{path} {r}")
            strict_json(r.raw)
        self.assertEqual(c.req("GET", "/api/export/obsidian").status, 200)
        refs = c.req("GET", "/api/notes").json["refs"]
        self.assertEqual((refs["19.23.2"]["text"], refs["19.23.2"]["tags"]), ("bad \ufffd text", ["\ufffd"]))
        self.assertEqual(c.req("GET", "/api/notes").json["studies"], [], "a wrongly typed studies no longer hides the notes")
        self.assertEqual(c.me().json["user"]["name"], "Hard \ufffd")
        # every write path still works (nothing non-finite is left to refuse at save time)
        self.assertEqual(c.req("POST", "/api/notes/changes", {"set": {"19.23.4": {"text": "ok"}}}, scoped=True).json["changed"], True)
        self.assertEqual(c.events([{"type": "chapter.open", "b": 19, "c": 23, "t": now_ms()}]).json["applied"], 1)
        self.assertEqual(c.req("POST", "/api/library/bookmarks", {"ref": "19.23.5"}, scoped=True).status, 201)
        self.assertEqual(Client().login(self.email, self.pw).status, 200)
        for name in ("notes.json", "library.json"):
            with open(os.path.join(pdir, name), "rb") as f:
                strict_json(f.read())
        with open(os.path.join(H.data, "users.json"), "rb") as f:
            strict_json(f.read())
        self.assertFalse([f for f in os.listdir(pdir) if ".corrupt-" in f], "repaired in place, nothing moved aside")

    def test_p3_other_scripts_digits_are_not_a_second_ref(self):
        """Finding 8 variant: '4\u0663.3.16' passed the ref check (\\d matches Arabic-Indic digits and int() reads it as 43),
        so it was a second bookmark and a second note for John 3:16."""
        c, uid, a3 = self.c, self.uid, "\u0663"
        self.assertEqual(c.req("POST", "/api/library/bookmarks", {"ref": "43.3.16"}, scoped=True).status, 201)
        for ref in (f"4{a3}.3.16", f"43.{a3}.16", f"43.3.1\u0666", "43.3.1\uff16", "4\u00b3.3.16"):
            self.assertErr(c.req("POST", "/api/library/bookmarks", {"ref": ref}, scoped=True), 400, "invalid_ref", "ref")
            self.assertErr(c.req("POST", "/api/notes/changes", {"set": {ref: {"text": "x"}}}, scoped=True), 400, "invalid_note", ref)
        t = now_ms()
        r = c.events([{"type": "xref.open", "b": 43, "c": 3, "v": 16, "to": f"4{a3}.3.16", "t": t},
                      {"type": "word.study", "b": 43, "c": 3, "v": 16, "strong": f"G2{a3}", "t": t},
                      {"type": "chapter.open", "b": 43, "c": 3, "t": t, "day": "\u0662\u0660\u0662\u0666-09-28"}])
        self.assertEqual((r.json["applied"], r.json["rejected"]), (1, 2))
        days = H.read("profiles", uid, "library.json")["days"]
        self.assertTrue(days and all(d.isascii() for d in days), days)
        self.assertEqual([b["ref"] for b in c.library().json["bookmarks"] if b["v"] == 16 and b["c"] == 3 and b["b"] == 43],
                         ["43.3.16"])
        # keys like that written by the old server are folded into the canonical one when read
        pdir = os.path.join(H.data, "profiles", uid)
        notes = H.read("profiles", uid, "notes.json")
        notes["refs"]["43.3.16"] = {"text": "older", "updated": 1000, "created": 1000}
        notes["refs"][f"4{a3}.3.16"] = {"text": "newer", "updated": 2000, "created": 2000}
        put_raw(os.path.join(pdir, "notes.json"), json.dumps(notes).encode("utf-8"))
        lib = H.read("profiles", uid, "library.json")
        lib["bookmarks"].append({"id": "bm_cccccccccccc", "ref": f"4{a3}.3.16", "label": "", "color": "blue", "created": 1, "updated": 1})
        lib["chapters"][f"4{a3}.3"] = {"visits": 7}
        put_raw(os.path.join(pdir, "library.json"), json.dumps(lib).encode("utf-8"))
        refs = c.req("GET", "/api/notes").json["refs"]
        self.assertEqual(([k for k in refs if k.endswith(".3.16")], refs["43.3.16"]["text"]), (["43.3.16"], "newer"))
        j = c.library().json
        self.assertEqual([b["ref"] for b in j["bookmarks"] if b["ref"].endswith(".3.16")], ["43.3.16"])
        self.assertEqual((j["chapters"]["43.3"]["visits"], [k for k in j["chapters"] if not k.isascii()]), (7, []))

    def test_p4_display_strings_lose_invisible_controls(self):
        """Finding 3, second pass: names and labels keep < > & and quotes (the front end escapes them) but lose the
        characters that can disguise them: controls, bidi overrides/isolates, lone surrogates; emails may not contain
        invisible characters at all."""
        c = self.c
        r = c.req("PATCH", "/api/account", {"name": "Ji \u202eKim\u2069 <b>&amp;</b>"})
        self.assertEqual(r.json["user"]["name"], "Ji Kim <b>&amp;</b>")
        self.assertErr(c.req("PATCH", "/api/account", {"name": "\u202e\u2066 \u2069"}), 400, "invalid_name", "name")
        r = c.req("POST", "/api/library/bookmarks", {"ref": "1.1.1", "label": "In the\n\u202ebeginning\u202c"}, scoped=True)
        self.assertEqual(r.json["bookmark"]["label"], "In the beginning")
        r = c.req("PATCH", f"/api/library/bookmarks/{r.json['bookmark']['id']}", {"label": "x" * 80 + "\u2066"}, scoped=True)
        self.assertEqual(r.json["bookmark"]["label"], "x" * 80, "the limit counts what is kept")
        e2, p2 = H.account("zw", "signup refused: zero-width character in the email (never created)")
        self.assertErr(Client().req("POST", "/api/auth/signup", {"email": e2.replace("@", "\u200b@"), "name": "Zw", "password": p2}),
                       400, "invalid_email", "email")
        self.assertErr(c.req("PATCH", "/api/account", {"email": "hard\u202e@example.test", "password": self.pw}), 400, "invalid_email", "email")

    def test_p5_odd_content_length_is_411_not_a_dropped_connection(self):
        """'\u00b2' passes str.isdigit() but not int(): the request died with a traceback and no response."""
        for cl in ("\u00b2", "\u00b9\u00b2", "3\u00b2"):
            st, _, body = raw_req("POST", "/api/auth/logout", b"{}", {"Content-Type": "application/json", "Content-Length": cl})
            self.assertEqual(st, 411, repr(cl))
            self.assertEqual(json.loads(body)["error"], "length_required")
        st, _, _ = raw_req("GET", "/index.html", b"", {"Content-Length": "\u00b2"})
        self.assertEqual(st, 200)


# ======================================================================= I. licensed translations (ESV, NLT)
def nlt_page(ch, containers, bk="ezra"):
    """An api.nlt.to answer: one <verse_export> per (vn, inner HTML), as the real pages are built."""
    body = "".join(f'<verse_export orig="{bk}_{ch}_{vn}" bk="{bk}" ch="{ch}" vn="{vn}">{inner}</verse_export>' for vn, inner in containers)
    return ('<!DOCTYPE html><html lang="en-US"><head><title>NLT API</title></head><body><div id="bibletext" class=" NLT '
            f'BibleText section"><section><h2 class="bk_ch_vs_header">Chapter {ch}, NLT</h2>{body}</section></div></body></html>')


class T18_LicensedText(Base):
    """R2-1: NLT verses start at their span.vn, not at their <verse_export> (a table sits in its last row's container).
    R2-2: a psalm's title is its own "title", never the start of verse 1 (NLT) or dropped (ESV). Offline: urlopen is
    stubbed with pages shaped like the real ones."""
    restart = False

    @classmethod
    def setUpClass(cls):
        import warnings
        with warnings.catch_warnings():  # serve.py's one-shot read of meta.json at import is not this test's subject
            warnings.simplefilter("ignore", ResourceWarning)
            import serve  # noqa: E402 (starts nothing)
        cls.serve = serve

    def fetch(self, fn, book, ch, page):
        from unittest import mock
        with mock.patch("urllib.request.urlopen", lambda *a, **k: io.BytesIO(page.encode("utf-8"))):
            return fn("test-key", book, ch)

    def test_r1_table_rows_are_their_own_verses(self):
        row = lambda v, name, n: f'<tr><td class="table-col"><span class="vn">{v}</span>{name}</td><td class="table-col">{n}</td></tr>'
        verses, title = self.fetch(self.serve.fetch_nlt, "Ezra", 2, nlt_page(2, [
            (1, '<p class="body-ch-hd"><span class="vn">1</span>Here is the list.</p>'),
            (2, '<span class="vn">2</span>This is the number of the men of Israel who returned from exile:<p>'),
            (3, ""), (4, ""), (5, ""),
            (6, '<table class="col2a">' + row(3, "The family of Parosh", "2,172") + row(4, "The family of Shephatiah", "372")
                + row(5, "The family of Arah", "775") + row(6, "The family of Elam", "1,254") + "</table>"),
            (7, '<p class="body-fl-sp"><span class="vn">7</span>These are the priests who returned from exile:</p>'),
            (8, '<table class="col2a"><tr><td class="table-col">The family of Jedaiah</td><td class="table-col">973</td></tr>'
                + row(8, "The family of Immer", "1,052") + "</table>"),
        ]))
        self.assertEqual(title, "")
        self.assertEqual(verses[3], "The family of Parosh 2,172")
        self.assertEqual(verses[5], "The family of Arah 775")
        self.assertEqual(verses[6], "The family of Elam 1,254", "the last row only, not the whole table")
        self.assertEqual(verses[7], "These are the priests who returned from exile: The family of Jedaiah 973", "an unnumbered row continues its verse")
        self.assertEqual(verses[8], "The family of Immer 1,052")
        self.assertEqual(sorted(verses), list(range(1, 9)))
        self.assertTrue(all(verses.values()), verses)

    def test_r2_combined_verses_and_table_heads(self):
        head = '<tr><td class="table-head">Tribe</td><td class="table-head">Leader</td><td class="table-head">Number</td></tr>'
        verses, _ = self.fetch(self.serve.fetch_nlt, "Numbers", 2, nlt_page(2, [
            (2, '<span class="vn">2</span>“Each tribe will be assigned its own area.<p>'),
            (3, '<p class="body"><span class="vn">3-4</span> “The divisions of Judah and Issachar camp on the east side. These are the names:</p>'),
            (4, ""), (5, ""),
            (6, '<table class="col3-sp">' + head
                + '<tr><td class="table-col">Judah</td><td class="table-col">Nahshon son of Amminadab</td><td class="table-col">74,600</td></tr>'
                + '<tr><td class="table-col"><span class="vn">5-6</span> Issachar</td><td class="table-col">Nethanel son of Zuar</td><td class="table-col">54,400</td></tr>'
                + "</table>"),
            (7, '<p class="body-fl-sp"><span class="vn">7</span>So the total is 131,000.</p>'),
        ], bk="numb"))
        self.assertEqual(verses[3], "“The divisions of Judah and Issachar camp on the east side. These are the names: Judah Nahshon son of Amminadab 74,600")
        self.assertEqual((verses[4], verses[6]), ("", ""), "combined with 3 and 5: no text of their own")
        self.assertEqual(verses[5], "Issachar Nethanel son of Zuar 54,400")
        self.assertEqual(verses[7], "So the total is 131,000.")
        self.assertFalse(any(re.search(r"\bTribe\b|\b\d+-\d+\b", t) for t in verses.values()), verses)

    def test_r3_container_order_still_holds(self):
        """A heading before a verse's own number is that verse's; a container no span.vn places opens its verse; other
        chapters are ignored."""
        verses, _ = self.fetch(self.serve.fetch_nlt, "Mark", 16, nlt_page(16, [
            (8, '<p><span class="vn">8</span>The women fled.</p><h3 class="text-critical">[Shorter Ending of Mark]</h3><p>Then they reported all this.</p>'),
            (9, '<h3 class="text-critical">[Longer Ending of Mark]</h3><p><span class="vn">9</span>After Jesus rose from the dead.</p>'),
            (10, "<p>She went and found the disciples.</p>"),
        ], bk="mark") + nlt_page(17, [(1, '<span class="vn">1</span>Not this chapter.')], bk="mark"))
        self.assertEqual(verses, {8: "The women fled. [Shorter Ending of Mark] Then they reported all this.",
                                  9: "[Longer Ending of Mark] After Jesus rose from the dead.", 10: "She went and found the disciples."})

    def test_r4_psalm_title_apart_from_verse_1(self):
        verses, title = self.fetch(self.serve.fetch_nlt, "Psalms", 110, nlt_page(110, [
            (1, '<h3 class="chapter-number"><span class="cw">Psalm</span> <span class="cw_ch">110</span></h3>'
                '<h4 class="subhead">Seated at the Right Hand of the <span class="subhead-sc">Lord</span></h4>'
                '<p class="psa-title">A psalm of <span class="sc">David</span>.</p>'
                '<p class="poet1-vn-sp"><span class="vn">1</span>The <span class="sc">Lord</span> said to my Lord,<a class="a-tn">*</a>'
                '<span class="tn"><span class="tn-ref">110:1</span> Or <em>my lord.</em></span></p><p class="poet2">“Sit at my right hand.”</p>'),
            (2, '<p class="poet1-vn"><span class="vn">2</span>The <span class="sc">Lord</span> will extend your royal power.</p>'),
        ], bk="psal"))
        self.assertEqual(title, "A psalm of DAVID.")
        self.assertEqual(verses, {1: "The LORD said to my Lord, “Sit at my right hand.”", 2: "The LORD will extend your royal power."})
        page = json.dumps({"passages": ["A Psalm of David.\n\n  [1] The LORD says to my Lord:\n  “Sit at my right hand.”\n\n  [2] The LORD sends forth. "]})
        verses, title = self.fetch(self.serve.fetch_esv, "Psalms", 110, page)
        self.assertEqual((title, verses[1]), ("A Psalm of David.", "The LORD says to my Lord: “Sit at my right hand.”"))
        self.assertEqual(self.fetch(self.serve.fetch_esv, "John", 3, json.dumps({"passages": ["\n[1] Now there was a man."]})),
                         ({1: "Now there was a man."}, ""), "only a psalm has a title")

    def test_r5_title_served_and_old_cache_refetched(self):
        serve, d = self.serve, tempfile.mkdtemp(prefix="bs-licensed-")
        calls = []
        def fake(key, book, ch):
            calls.append((book, ch))
            return {1: "Have mercy on me, O God.", 2: "Wash me clean."}, ("For the choir director." if book == "Psalms" else "")
        saved = serve.FETCHERS
        try:
            accounts.configure(d, H.port)
            with open(accounts.CONFIG, "w") as f: json.dump({"nltKey": "test-key"}, f)
            os.makedirs(os.path.join(accounts.CACHE, "nlt"))
            old = os.path.join(accounts.CACHE, "nlt", "19-51.json")
            with open(old, "w") as f: json.dump({"verses": ["For the choir director. Have mercy on me, O God.", "Wash me clean."], "v": 3}, f)
            serve.FETCHERS = {"esv": saved["esv"], "nlt": ("nltKey", fake)}
            out, st = serve.get_passage("nlt", 19, 51)
            self.assertEqual((st, calls), (200, [("Psalms", 51)]), "a chapter cached by the old parser is fetched again")
            self.assertEqual((out["title"], out["verses"][0], out["v"]), ("For the choir director.", "Have mercy on me, O God.", serve.CACHE_V["nlt"]))
            self.assertEqual(serve.get_passage("nlt", 19, 51)[0]["title"], "For the choir director.")
            self.assertEqual(len(calls), 1, "then served from the cache, title included")
            out, _ = serve.get_passage("nlt", 15, 2)
            self.assertNotIn("title", out)
            self.assertGreaterEqual(serve.CACHE_V["nlt"], 4)
            self.assertGreaterEqual(serve.CACHE_V["esv"], 2)
        finally:
            serve.FETCHERS = saved
            accounts.configure(H.data, H.port)
            shutil.rmtree(d, ignore_errors=True)

    def test_r6_saved_real_pages(self):
        """The api.nlt.to pages the audit saved (skipped when .design/ is not there)."""
        base = os.path.join(REPO, ".design", "audit")
        cases = [("server-r6/nlt/Ezra.2.html", "Ezra", 2), ("server/nlt/Num2.html", "Numbers", 2), ("server-r6/nlt/Ps.51.html", "Psalms", 51)]
        if not all(os.path.exists(os.path.join(base, f)) for f, _, _ in cases): self.skipTest("no saved NLT pages")
        got = {}
        for f, book, ch in cases:
            with open(os.path.join(base, f), encoding="utf-8") as fh: got[f] = self.fetch(self.serve.fetch_nlt, book, ch, fh.read())
        ezra, _ = got["server-r6/nlt/Ezra.2.html"]
        self.assertEqual((ezra[3], ezra[35], len(ezra)), ("The family of Parosh 2,172", "The citizens of Senaah 3,630", 70))
        self.assertTrue(all(ezra.values()), [v for v, t in ezra.items() if not t])
        num, _ = got["server/nlt/Num2.html"]
        self.assertTrue(num[3].endswith("troops: Judah Nahshon son of Amminadab 74,600"), num[3])
        self.assertEqual(num[5], "Issachar Nethanel son of Zuar 54,400")
        ps, title = got["server-r6/nlt/Ps.51.html"]
        self.assertTrue(title.startswith("For the choir director: A psalm of David, regarding the time Nathan"), title)
        self.assertTrue(ps[1].startswith("Have mercy on me, O God,"), ps[1])


# ======================================================================= Q. My links (links-spec §1, §2)
def new_link_id():
    return "ln_" + secrets.token_hex(6)


class T19_Links(Base):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        for who in ("lina", "lewis"):
            email, pw = H.account(who, "My links")
            c = Client()
            assert c.signup(email, pw, name=who.title()).status == 201
            S[who] = c

    def link(self, lid, frm="43.1.29", to="23.53.7", **kw):
        return dict({"id": lid, "from": frm, "to": to, "type": "fulfils", "updated": now_ms()}, **kw)

    def changes(self, c, set_=None, del_=None, base=None, rev=None, **extra):
        body = dict({"set": set_ or {}, "del": del_ or {}}, **extra)
        if base is not None:
            body["base"] = base
        if rev is not None:
            body["baseRev"] = rev
        return c.req("POST", "/api/links/changes", body, scoped=True)

    def links(self, c):
        return c.req("GET", "/api/links").json

    def test_q01_get_and_first_write(self):
        g = Client()
        r = g.req("GET", "/api/links")
        self.assertEqual(r.status, 200, r)
        self.assertEqual(r.json, {"links": {}, "rev": 0, "scope": "guest"})
        self.assertEqual((r.headers["ETag"], r.headers["Cache-Control"]), ('"0"', "no-store"))
        a = S["lina"]
        rev = self.links(a)["rev"]
        lid = new_link_id()
        w = self.changes(a, {lid: self.link(lid, note="The *Lamb*", tags=["lamb"])}, base={lid: None}, rev=rev)
        self.assertEqual(w.status, 200, w)
        self.assertEqual((w.json["ok"], w.json["rev"], w.json["changed"], w.json["stale"], w.json["conflicts"]), (True, rev + 1, True, False, {}))
        self.assertRegex(w.json["saved"], r"^\d\d:\d\d:\d\d$")
        r = a.req("GET", "/api/links")
        self.assertEqual((r.json["rev"], r.json["scope"], r.headers["ETag"]), (rev + 1, a.scope, f'"{rev + 1}"'))
        self.assertEqual(w.json["versions"], {lid: r.json["links"][lid]["updated"]})
        self.assertNotIn("deleted", r.json)
        self.assertEqual(H.read("profiles", a.scope, "links.json")["links"][lid]["note"], "The *Lamb*")
        self.assertEqual(g.req("GET", "/api/links").json["links"], {}, "the guest space is separate")

    def test_q02_validation_is_atomic(self):
        a, k = S["lina"], "ln_0123456789ab"
        L = lambda **kw: self.link(k, **kw)  # noqa: E731
        bad = [L(frm="43.1.52"), L(frm="43.22.1"), L(frm="67.1.1"), L(frm="0.1.1"), L(frm="43.1.0"), L(frm="43.1"),
               L(frm="43.1.29-28"), L(frm="43.1.29-52"), L(frm="43.1.29-30-31"), L(frm="43.1.٢٩"), L(frm="43.1.29 "),
               L(frm="43:1:29"), L(frm=43129), L(to=None), L(to="43.1.29"), L(frm="43.1.29-31", to="43.01.29-31"),
               L(to="43.1.29-29"), L(type="nope"), L(type=5), L(type="custom"), L(type="custom", label=" \u0007 "),
               L(label="x" * 41), L(label=5), L(note="x" * 20_001), L(note=5), L(color="pink"), L(tags="lamb"),
               L(tags=[f"t{i}" for i in range(21)]), L(tags=["x" * 41]), L(tags=[""]), L(tags=["a/b"]), L(tags=[5]),
               L(dir="from"), L(updated="x"), L(updated=-1), L(created="soon"), L(note="é" * 17_000), "not an object",
               dict(L(), id="ln_ba9876543210"), dict(L(), id=None)]
        rev = self.links(a)["rev"]
        for case in bad:
            with self.subTest(case=str(case)[:120]):
                self.assertErr(self.changes(a, {k: case}), 400, "invalid_link", field=k)
        self.assertEqual(self.changes(a, {k: L(to="43.1.29")}).json["message"], "A verse can’t link to itself.")
        self.assertIn("20,000", self.changes(a, {k: L(note="x" * 20_001)}).json["message"])
        self.assertIn("40", self.changes(a, {k: L(type="custom")}).json["message"])
        self.assertErr(self.changes(a, {"ln_XYZ": L()}), 400, "invalid_link", field="ln_XYZ")
        self.assertErr(self.changes(a, {k: L()}, {k: now_ms()}), 400, "invalid_link", field=k)
        self.assertErr(self.changes(a, del_={k: "x"}), 400, "invalid_link", field=k)
        self.assertErr(self.changes(a, del_={"nope": now_ms()}), 400, "invalid_link", field="nope")
        good = new_link_id()
        self.assertErr(self.changes(a, {good: self.link(good), k: L(type="nope")}), 400, "invalid_link", field=k)
        self.assertNotIn(good, self.links(a)["links"], "one bad link: nothing is applied")
        self.assertErr(a.req("POST", "/api/links/changes", {"set": []}, scoped=True), 400, "bad_request")
        self.assertErr(self.changes(a, {good: self.link(good)}, base={good: "x"}), 400, "bad_request", field=good)
        self.assertErr(self.changes(a, rev=-1), 400, "bad_request", field="baseRev")
        for day in ("2026-02-30", "28/09/2026", 5):
            self.assertErr(self.changes(a, {good: self.link(good)}, day=day), 400, "bad_request", field="day")
        self.assertEqual(self.links(a)["rev"], rev, "nothing was written")
        self.assertErr(self.changes(a, del_={f"ln_{i:012x}": now_ms() for i in range(1001)}), 400, "bad_request")
        self.assertEqual(self.changes(a, del_={f"ln_{i:012x}": now_ms() for i in range(1000)}).status, 200, "1,000 keys is allowed")

    def test_q03_defaults_and_canonical_form(self):
        a, lid = S["lina"], new_link_id()
        r = self.changes(a, {lid: {"id": lid, "from": "43.01.029", "to": "23.53.7-7", "evil": "<script>", "updated": now_ms() + 3_600_000,
                                   "tags": ["  Lamb ", "lamb", "Pass_over-1", "Ναός", "two  words"], "label": "  Behold\u202e the Lamb  "}})
        self.assertEqual(r.status, 200, r)
        ln = self.links(a)["links"][lid]
        self.assertEqual(sorted(ln), sorted(["id", "from", "to", "type", "label", "note", "color", "tags", "dir", "created", "updated"]))
        self.assertEqual({f: ln[f] for f in ("from", "to", "type", "dir", "color", "label", "note")},
                         {"from": "43.1.29", "to": "23.53.7", "type": "related", "dir": "both", "color": "blue", "label": "Behold the Lamb", "note": ""})
        self.assertEqual(ln["tags"], ["lamb", "pass_over-1", "ναός", "two words"])
        self.assertLessEqual(ln["updated"], now_ms(), "a time from the future is clamped")
        self.assertEqual(ln["created"], ln["updated"])
        l2, l3 = new_link_id(), new_link_id()
        self.assertEqual(self.changes(a, {l2: self.link(l2, frm="43.1.29-31", type="quotes"),
                                          l3: self.link(l3, to="43.1.29-31", type="custom", label="Same moment")}).status, 200)
        got = self.links(a)["links"]
        self.assertEqual((got[l2]["from"], got[l2]["dir"], got[l3]["to"], got[l3]["dir"]), ("43.1.29-31", "to", "43.1.29-31", "to"))

    def test_q04_compare_and_set(self):
        a = S["lina"]
        t1, t2 = a.tab(), a.tab()
        lid, v0 = new_link_id(), now_ms() - 10_000
        added = lambda: [e for e in a.library(activity=1000).json["activity"] if e["type"] == "link.add" and e["x"]["id"] == lid]  # noqa: E731
        r = self.changes(t1, {lid: self.link(lid, updated=v0)}, base={lid: None})
        self.assertEqual((r.json["changed"], r.json["versions"]), (True, {lid: v0}))
        rev = r.json["rev"]
        r = self.changes(t1, {lid: self.link(lid, updated=v0)}, base={lid: None})
        self.assertEqual((r.json["changed"], r.json["conflicts"], r.json["versions"], r.json["rev"]), (False, {}, {lid: v0}, rev), "a retried create")
        self.assertEqual(len(added()), 1, "a retried create adds no second activity entry")
        r = self.changes(t1, {lid: self.link(lid, updated=v0 - 5, label="edited")}, base={lid: v0})
        v1 = r.json["versions"][lid]
        self.assertEqual(v1, v0 + 1, "the version moves forward even from a clock that is behind")
        r = self.changes(t1, {lid: self.link(lid, updated=v0 - 5, label="edited")}, base={lid: v0})
        self.assertEqual((r.json["changed"], r.json["conflicts"], r.json["versions"]), (False, {}, {lid: v1}), "a retried edit")
        stored = self.links(a)["links"][lid]
        r = self.changes(t2, {lid: self.link(lid, label="stale tab")}, base={lid: v0})
        self.assertEqual((r.json["changed"], r.json["conflicts"], r.json["versions"]), (False, {lid: stored}, {}))
        r = self.changes(t2, del_={lid: now_ms()}, base={lid: v0})
        self.assertEqual(r.json["conflicts"], {lid: stored}, "deleting a link changed elsewhere is a conflict")
        self.assertEqual(self.links(a)["links"][lid], stored)
        td = now_ms()
        r = self.changes(t1, del_={lid: td}, base={lid: v1})
        self.assertEqual((r.json["changed"], r.json["conflicts"], r.json["versions"]), (True, {}, {lid: None}))
        self.assertNotIn(lid, self.links(a)["links"])
        self.assertGreaterEqual(H.read("profiles", a.scope, "links.json")["deleted"][lid], td, "tombstone")
        r = self.changes(t2, {lid: self.link(lid, updated=td - 1000)})
        self.assertEqual(r.json["conflicts"], {lid: None}, "an edit older than the delete does not bring it back")
        r = self.changes(t2, del_={lid: td + 5}, base={lid: v1})
        self.assertEqual((r.json["conflicts"], r.json["versions"]), ({}, {lid: None}), "deleting a deleted link is no conflict")
        rev = self.links(a)["rev"]
        self.assertTrue(self.changes(t1, rev=rev - 1).json["stale"])
        self.assertFalse(self.changes(t1, rev=rev).json["stale"])
        self.assertEqual(len(added()), 1, "edits and deletes write no activity")

    def test_q05_scope_csrf_and_limits(self):
        a, g = S["lina"], Client()
        lid = new_link_id()
        body = {"set": {lid: self.link(lid)}}
        r = a.req("POST", "/api/links/changes", body, headers={"X-BS-Scope": "guest"})
        self.assertErr(r, 409, "scope_mismatch")
        self.assertEqual(r.json["scope"], a.scope)
        r = g.req("POST", "/api/links/changes", body, headers={"X-BS-Scope": a.scope})
        self.assertErr(r, 409, "scope_mismatch")
        self.assertEqual(r.json["scope"], "guest")
        self.assertErr(a.req("POST", "/api/links/changes", body), 400, "scope_required")
        self.assertErr(S["lewis"].req("POST", "/api/links/changes", body, headers={"X-BS-Scope": a.scope}), 409, "scope_mismatch")
        for h in ({"Origin": "http://evil.example"}, {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertErr(a.req("POST", "/api/links/changes", body, headers=h, scoped=True), 403, "csrf")
        self.assertNotIn(lid, self.links(a)["links"])
        self.assertNotIn(lid, self.links(g)["links"])
        self.assertErr(a.req("GET", "/api/links/changes"), 405, "method_not_allowed")
        r = a.req("POST", "/api/links", {}, scoped=True)
        self.assertErr(r, 405, "method_not_allowed")
        self.assertEqual(r.headers["Allow"], "GET")
        big = json.dumps({"set": {}, "pad": "x" * (1024 * 1024)}).encode()
        self.assertErr(a.req("POST", "/api/links/changes", raw=big, scoped=True), 413, "too_large")

    def test_q06_new_links_add_activity_and_studied_verses(self):
        c = S["lewis"]
        lib0 = c.library().json
        today = time.strftime("%Y-%m-%d")
        lid, lid2, lid3 = new_link_id(), new_link_id(), new_link_id()
        self.assertEqual(self.changes(c, {lid: self.link(lid, to="23.53.7-9")}, base={lid: None}, day=today).status, 200)
        lib = c.library(today=today).json
        self.assertEqual(lib["rev"], lib0["rev"] + 1)
        e = lib["activity"][0]
        self.assertEqual({f: e[f] for f in ("type", "ref", "x")}, {"type": "link.add", "ref": "43.1.29", "x": {"id": lid, "to": "23.53.7-9", "kind": "fulfils"}})
        self.assertEqual((lib["chapters"]["43.1"]["studied"], lib["chapters"]["23.53"]["studied"]), ([29], [7]), "the first verse of each end")
        self.assertEqual(H.read("profiles", c.scope, "library.json")["days"][today]["v"], 2)
        self.assertEqual(lib["stats"]["totals"]["links"], 1)
        self.assertTrue(lib["stats"]["streak"]["studiedToday"])
        self.changes(c, {lid2: self.link(lid2, to="1.22.8", type="echoes")}, day=today)
        self.changes(c, {lid3: self.link(lid3, to="19.22.1", type="quotes")}, day="2001-01-01")
        days = H.read("profiles", c.scope, "library.json")["days"]
        self.assertEqual(days[today]["v"], 4, "43.1.29 was studied already: one new verse each")
        self.assertNotIn("2001-01-01", days, "a day far from the server's date is not trusted")
        lib = c.library().json
        self.assertEqual([x["x"]["id"] for x in lib["activity"][:3]], [lid3, lid2, lid])
        n, rev = lib["activityTotal"], lib["rev"]
        self.changes(c, {lid: self.link(lid, to="23.53.7-9", label="edited")})
        self.changes(c, del_={lid2: now_ms()})
        lib = c.library().json
        self.assertEqual((lib["activityTotal"], lib["rev"], lib["stats"]["totals"]["links"]), (n, rev, 2), "edits and deletes write no activity")
        g, gid = Client(), new_link_id()
        self.assertEqual(self.changes(g, {gid: self.link(gid, frm="40.6.33", to="23.61.1")}).status, 200)
        glib = g.library().json
        self.assertEqual((glib["activity"][0]["type"], glib["activity"][0]["ref"]), ("link.add", "40.6.33"))
        self.assertIn(33, glib["chapters"]["40.6"]["studied"])

    def test_q07_lock_order(self):
        """Links file -> library file, under the one scope lock (the order documented at accounts.lock_for)."""
        import serve  # noqa: E402 (starts nothing)
        d = tempfile.mkdtemp(prefix="bs-servertest-unit-")
        real = {n: getattr(accounts, n) for n in ("save_links", "save_library", "save_notes", "load_library")}
        order = []

        def spy(name):
            def f(scope, *a):
                order.append((name, accounts.lock_for(scope).locked()))
                return real[name](scope, *a)
            return f
        try:
            accounts.configure(d, H.port)
            for n in real:
                setattr(accounts, n, spy(n))
            h = serve.Handler.__new__(serve.Handler)
            sent = []
            h.send_json = lambda obj, status=200, headers=(): sent.append((status, obj))
            h._scope, h._uid = "guest", None
            lid = new_link_id()
            h.h_links_changes({"set": {lid: self.link(lid)}}, {}, None)
            self.assertEqual(sent[-1][0], 200, sent)
            self.assertEqual(order, [("save_links", True), ("load_library", True), ("save_library", True)])
            order.clear()
            h._scope = h._uid = "u0123456789abcdef"
            h.h_import_guest({}, {}, None)
            self.assertEqual(sent[-1][1]["imported"]["links"], 1)
            self.assertEqual([o for o in order if o[0] != "load_library"], [("save_links", True), ("save_library", True)])
        finally:
            for n, fn in real.items():
                setattr(accounts, n, fn)
            accounts.configure(H.data, H.port)
            shutil.rmtree(d, ignore_errors=True)
        # and over HTTP: link writes and tracker batches from several tabs at once neither deadlock nor lose anything
        c = S["lewis"]
        lib0, errs, ids = c.library().json, [], []

        def links_tab(k):
            t = c.tab()
            for i in range(15):
                lid = new_link_id()
                ids.append(lid)
                r = self.changes(t, {lid: self.link(lid, frm=f"19.{k + 1}.1", to=f"20.{i + 1}.1")}, base={lid: None})
                if r.status != 200 or r.json["conflicts"]:
                    errs.append(r)

        def events_tab():
            t = c.tab()
            for _ in range(15):
                r = t.events([{"type": "chapter.time", "b": 19, "c": 117, "sec": 10, "t": now_ms()}])
                if r.status != 200:
                    errs.append(r)
        th = [threading.Thread(target=links_tab, args=(k,)) for k in (0, 1)] + [threading.Thread(target=events_tab) for _ in (0, 1)]
        [t.start() for t in th]
        [t.join(120) for t in th]
        self.assertFalse([t for t in th if t.is_alive()], "no deadlock")
        self.assertEqual(errs, [])
        lib = c.library(activity=1000).json
        self.assertEqual(lib["rev"], lib0["rev"] + 60)
        self.assertLessEqual(set(ids), {e["x"]["id"] for e in lib["activity"] if e["type"] == "link.add"})
        self.assertLessEqual(set(ids), set(self.links(c)["links"]))

    def test_q08_guest_import_copy_and_merge(self):
        g, t0 = Client(), now_ms() - 60_000
        ids = {k: new_link_id() for k in ("kept", "taken", "tomb", "newer")}
        sets = {ids[k]: self.link(ids[k], frm="45.5.8", to=f"43.3.{16 + i}", updated=t0, note="Guest note" if k == "taken" else "")
                for i, k in enumerate(ids)}
        self.assertEqual(self.changes(g, sets).status, 200)
        guest = H.read("guest-links.json")
        me = g.me().json["guest"]
        self.assertEqual((me["links"], me["hasData"]), (len(guest["links"]), True))
        # sign-up with import: a copy (rev 1, no tombstones); the guest file is left as it is
        email, pw = H.account("linkimp", "My links: sign-up import")
        c = Client()
        r = c.signup(email, pw, name="Link Import", import_guest=True)
        self.assertEqual(r.status, 201, r)
        self.assertEqual(r.json["imported"]["links"], len(guest["links"]))
        disk = H.read("profiles", c.scope, "links.json")
        self.assertEqual((disk["rev"], disk["deleted"], disk["links"]), (1, {}, guest["links"]))
        self.assertEqual(H.read("guest-links.json"), guest)
        # a profile with links of its own imports later: merge
        b = S["lewis"]
        own = {ids["kept"]: self.link(ids["kept"], frm="45.5.8", to="43.3.16", updated=t0 + 5000, label="mine"),
               ids["tomb"]: self.link(ids["tomb"], frm="45.5.8", to="43.3.18", updated=t0 - 5000),
               ids["newer"]: self.link(ids["newer"], frm="45.5.8", to="43.3.19", updated=t0 - 5000, label="older")}
        self.assertEqual(self.changes(b, own).status, 200)
        self.assertTrue(self.changes(b, del_={ids["tomb"]: t0 + 1}).json["changed"])
        r = b.req("POST", "/api/profile/import-guest", {}, scoped=True)
        self.assertEqual(r.status, 200, r)
        want = len(set(guest["links"]) - set(own)) + 1
        mine = self.links(b)["links"]
        self.assertEqual(r.json["imported"]["links"], want)
        self.assertEqual(mine[ids["kept"]]["label"], "mine", "the profile's newer edit is kept")
        self.assertEqual(mine[ids["newer"]], guest["links"][ids["newer"]], "the guest's newer edit is taken")
        self.assertEqual(mine[ids["taken"]]["note"], "Guest note")
        self.assertNotIn(ids["tomb"], mine, "deleted in the profile after the guest's edit: stays deleted")
        self.assertEqual(r.json["rev"]["links"], self.links(b)["rev"])
        imp = [e for e in b.library().json["activity"] if e["type"] == "profile.import"][0]
        self.assertEqual(imp["x"]["links"], want)
        r2 = b.req("POST", "/api/profile/import-guest", {}, scoped=True)
        self.assertEqual((r2.json["imported"]["links"], r2.json["changed"], r2.json["rev"]), (0, False, r.json["rev"]), "idempotent")
        self.assertEqual(self.links(b)["links"], mine)

    def test_q09_exports(self):
        a = S["lina"]
        r = a.req("GET", "/api/export/profile")
        self.assertEqual(r.json["links"], {"links": self.links(a)["links"]})
        self.assertNotIn(b'"deleted"', r.raw, "tombstones are not exported")
        self.assertEqual(Client().req("GET", "/api/export/profile").json["links"]["links"], self.links(Client())["links"])
        lid = new_link_id()
        self.changes(a, {lid: self.link(lid, frm="43.1.36", to="2.12.3-5", label="Passover", tags=["lamb", "pass over"],
                                        note="Behold\nthe *Lamb* of God, see [[Psalm 23:1]].", created=now_ms() + 1000)})
        a.req("POST", "/api/notes/changes", {"set": {"43.1.36": {"text": "Note on John 1:36", "updated": now_ms()}}}, scoped=True)
        z = zipfile.ZipFile(io.BytesIO(a.req("GET", "/api/export/obsidian").raw))
        conn = z.read("study-notes/Connections.md").decode().splitlines()
        self.assertEqual(conn[:4], ["# Connections", "", "- [[John 1.36|John 1:36]] — fulfils → [[Exodus 12.3|Exodus 12:3–5]] · Passover #lamb #pass-over",
                                    "  > Behold the *Lamb* of God, see [[Psalms 23.1|Psalm 23:1]]."], "newest first")
        self.assertIn("- [[John 1.29|John 1:29]] — is linked to ↔ [[Isaiah 53.7|Isaiah 53:7]] · Behold the Lamb #lamb #pass_over-1 #ναός #two-words", conn)
        self.assertIn("- [[John 1.29|John 1:29]] — Same moment → [[John 1.29|John 1:29–31]]", conn, "custom: the label is the phrase")
        jn = z.read("study-notes/John 1.36.md").decode()
        self.assertIn("Note on John 1:36\n\n## Connections\n- fulfils → [[Exodus 12.3|Exodus 12:3–5]] · Passover\n\nVerse: [[verses/John 1.36|", jn)
        ex = z.read("study-notes/Exodus 12.3.md").decode()
        self.assertTrue(ex.startswith('---\nreference: "Exodus 12:3"\n'), ex)
        self.assertIn("## Connections\n- is fulfilled in → [[John 1.36|John 1:36]] · Passover\n", ex)
        self.assertNotIn("study-notes/Exodus 12.4.md", z.namelist(), "a range uses its first verse's file")
        self.assertIn("- [[study-notes/Connections|Connections]]", z.read("study-notes/Study Notes Index.md").decode())

    def test_q10_pure_functions(self):
        A, t = accounts, 1759071600000
        mk = lambda lid, frm, to, **kw: A.clean_link(dict({"id": lid, "from": frm, "to": to, "updated": t, "created": t}, **kw), t)  # noqa: E731
        self.assertEqual((mk("ln_000000000001", "43.01.029-031", "23.53.7-7")["from"], mk("ln_000000000001", "43.1.29", "23.53.7-7")["to"]), ("43.1.29-31", "23.53.7"))
        with self.assertRaises(ValueError):
            mk("ln_000000000001", "43.1.29-29", "43.1.29")
        f = mk("ln_000000000001", "43.1.29", "23.53.7", type="fulfils")
        self.assertEqual([A.link_phrase(f, s) for s in ("from", "to")], ["fulfils", "is fulfilled in"])
        self.assertEqual(A.link_phrase(dict(f, dir="both"), "to"), "fulfils / is fulfilled in")
        self.assertEqual(A.link_phrase(mk("ln_000000000002", "1.1.1", "43.1.1", type="custom", label="God’s word"), "to"), "God’s word")
        doc = A.empty_links()
        self.assertEqual(A.apply_link_changes(doc, {f["id"]: f}, {}, {f["id"]: None}), (True, {}, [f["id"]]))
        self.assertEqual(A.apply_link_changes(doc, {f["id"]: f}, {}, {f["id"]: None}), (False, {}, []))
        self.assertEqual(A.link_versions(doc, [f["id"], "ln_00000000000f"], {}), {f["id"]: t, "ln_00000000000f": None})
        dst = {"links": {f"ln_{i:012x}": {"updated": 1} for i in range(A.MAX_LINKS - 1)}, "deleted": {}}
        src = {"links": {f"ln_aaaaaaaaaaa{i}": mk(f"ln_aaaaaaaaaaa{i}", "1.1.1", "1.1.2") for i in range(3)}}
        self.assertEqual((A.merge_links(dst, src), len(dst["links"])), (1, A.MAX_LINKS), "an import stops at the limit")
        self.assertFalse(A.guest_summary({"refs": {}}, A.new_library(), {"links": {}})["hasData"])
        s = A.guest_summary({"refs": {}}, A.new_library(), {"links": {f["id"]: f}})
        self.assertEqual((s["links"], s["hasData"]), (1, True), "links alone are guest data")
        self.assertEqual(A.compute_stats(A.new_library(), 0, "2026-09-28", 7)["totals"]["links"], 7)
        links = {"links": {
            "ln_000000000003": mk("ln_000000000003", "45.5.8", "43.3.16", type="custom", label="God’s love", tags=["love"], dir="both"),
            "ln_000000000004": mk("ln_000000000004", "43.1.29-31", "23.53.7", type="fulfils", note="a" * 190 + " [[John 3:16]] tail", created=t + 1000)}}
        z = zipfile.ZipFile(io.BytesIO(A.obsidian_zip({"refs": {}}, None, links)))
        self.assertEqual(z.read("study-notes/Connections.md").decode().splitlines(), [
            "# Connections", "", "- [[John 1.29|John 1:29–31]] — fulfils → [[Isaiah 53.7|Isaiah 53:7]]", "  > " + "a" * 190 + "…",
            "- [[Romans 5.8|Romans 5:8]] — God’s love ↔ [[John 3.16|John 3:16]] #love"])
        for name, line in (("John 1.29", "- fulfils → [[Isaiah 53.7|Isaiah 53:7]]"), ("Isaiah 53.7", "- is fulfilled in → [[John 1.29|John 1:29–31]]"),
                           ("Romans 5.8", "- God’s love → [[John 3.16|John 3:16]]"), ("John 3.16", "- God’s love → [[Romans 5.8|Romans 5:8]]")):
            self.assertIn(f"## Connections\n{line}\n", z.read(f"study-notes/{name}.md").decode())
        self.assertNotIn("study-notes/John 1.30.md", z.namelist())
        self.assertEqual(z.read("study-notes/Study Notes Index.md").decode().splitlines(), [
            "# Study notes", "", "- [[study-notes/Isaiah 53.7|Isaiah 53:7]]", "- [[study-notes/John 1.29|John 1:29]]",
            "- [[study-notes/John 3.16|John 3:16]]", "- [[study-notes/Romans 5.8|Romans 5:8]]", "", "- [[study-notes/Connections|Connections]]"],
            "every linked verse's file is listed, one blank line before Connections")
        z = zipfile.ZipFile(io.BytesIO(A.obsidian_zip({"refs": {"45.5.8": {"text": "n"}, "43.3": {"text": "c"}, "1.1.1": {"text": "g"}}}, None, links)))
        self.assertEqual(z.read("study-notes/Study Notes Index.md").decode().splitlines()[2:8], [
            "- [[study-notes/Genesis 1.1|Genesis 1:1]]", "- [[study-notes/Isaiah 53.7|Isaiah 53:7]]", "- [[study-notes/John 1.29|John 1:29]]",
            "- [[study-notes/John 3|John 3]]", "- [[study-notes/John 3.16|John 3:16]]", "- [[study-notes/Romans 5.8|Romans 5:8]]"], "notes and linked verses in Bible order")
        z = zipfile.ZipFile(io.BytesIO(A.obsidian_zip({"refs": {}}, None, {"links": {}})))
        self.assertNotIn("study-notes/Connections.md", z.namelist())
        self.assertNotIn("Connections", z.read("study-notes/Study Notes Index.md").decode())

    def test_q11_limit_and_damaged_files(self):
        email, pw = H.account("linkcap", "My links: limit and repair")
        c = Client()
        self.assertEqual(c.signup(email, pw, name="Link Cap").status, 201)
        pdir = os.path.join(H.data, "profiles", c.scope)
        path, t = os.path.join(pdir, "links.json"), now_ms()
        full = {f"ln_{i:012x}": {"id": f"ln_{i:012x}", "from": f"19.119.{i % 176 + 1}", "to": "43.1.1", "type": "related", "label": "",
                                 "note": "", "color": "blue", "tags": [], "dir": "both", "created": t, "updated": t} for i in range(accounts.MAX_LINKS - 1)}
        put_raw(path, json.dumps({"version": 1, "rev": 5, "links": full, "deleted": {}}).encode("utf-8"))
        n1, n2 = new_link_id(), new_link_id()
        r = self.changes(c, {n1: self.link(n1), n2: self.link(n2)})
        self.assertErr(r, 409, "link_limit")
        self.assertEqual(r.json["message"], "You’ve reached the limit of 10,000 links.")
        self.assertEqual(self.changes(c, {n1: self.link(n1)}).status, 200)
        self.assertErr(self.changes(c, {n2: self.link(n2)}), 409, "link_limit")
        first = "ln_000000000000"
        self.assertEqual(self.changes(c, {first: dict(full[first], label="edit", updated=now_ms())}).status, 200, "edits still work at the limit")
        r = self.changes(c, {n2: self.link(n2)}, del_={first: now_ms()})
        self.assertEqual(r.status, 200, "at the limit, a delete makes room for a create in the same batch")
        self.assertEqual((first in self.links(c)["links"], n2 in self.links(c)["links"]), (False, True))
        self.assertEqual(c.library().json["stats"]["totals"]["links"], accounts.MAX_LINKS)
        # a readable but wrongly shaped file is repaired entry by entry, never moved aside or a 500
        good = new_link_id()
        put_raw(path, json.dumps({"rev": "x", "links": {good: self.link(good, updated=now_ms() + 86_400_000), "ln_aaaaaaaaaaaa": {"id": "ln_aaaaaaaaaaaa", "from": "x"},
                                                        "ln_bbbbbbbbbbbb": 5, "ln_cccccccccccc": self.link("ln_dddddddddddd")},
                                  "deleted": {"ln_eeeeeeeeeeee": "soon", "nonsense": 5, "ln_ffffffffffff": now_ms() + 10 ** 9}}).encode("utf-8"))
        mtime = int(os.stat(path).st_mtime * 1000)
        r = c.req("GET", "/api/links")
        self.assertEqual((r.status, r.json["rev"], list(r.json["links"])), (200, 0, [good]))
        self.assertEqual(r.json["links"][good]["updated"], mtime, "a time from the future reads as the file's mtime")
        r = self.changes(c, del_={good: now_ms()}, base={good: mtime})
        self.assertEqual((r.status, r.json["conflicts"]), (200, {}), "a base taken from the repaired GET still matches")
        disk = H.read("profiles", c.scope, "links.json")
        self.assertEqual(set(disk["deleted"]), {good, "ln_ffffffffffff"})
        self.assertLessEqual(disk["deleted"]["ln_ffffffffffff"], now_ms())
        self.assertFalse([f for f in os.listdir(pdir) if ".corrupt-" in f])
        self.assertTrue(os.path.exists(path + ".bak"), "the daily backup")
        # an unparseable file is moved aside, never overwritten in place
        put_raw(path, b"{not json")
        r = c.req("GET", "/api/links")
        self.assertEqual((r.status, r.json["links"], r.json["rev"]), (200, {}, 0))
        self.assertTrue([f for f in os.listdir(pdir) if f.startswith("links.json.corrupt-")])
        # a bad optional field is repaired field by field: only a bad id or bad ends lose a link (and its note)
        la, lb, lc, ld = (new_link_id() for _ in range(4))
        put_raw(path, json.dumps({"version": 1, "rev": 2, "links": {
            la: self.link(la, tags=["A#b", "Ok", 5, "ok"], note="precious note", color="teal", dir="up", created="x"),
            lb: self.link(lb, type="custom", label=7, note=["not text"]),
            lc: self.link(lc, type="psalm", label="  " + "x" * 50, note="n" * 20_001),
            ld: self.link(ld, to="43.1.29", note="lost")}}).encode("utf-8"))
        got = self.links(c)["links"]
        self.assertEqual(sorted(got), sorted([la, lb, lc]))
        self.assertEqual({k: got[la][k] for k in ("type", "note", "tags", "color", "dir")},
                         {"type": "fulfils", "note": "precious note", "tags": ["ok"], "color": "blue", "dir": "to"})
        self.assertEqual(got[la]["created"], got[la]["updated"], "a bad created time becomes the updated time")
        self.assertEqual({k: got[lb][k] for k in ("type", "label", "note", "dir")}, {"type": "related", "label": "", "note": "", "dir": "both"})
        self.assertEqual((got[lc]["type"], got[lc]["label"], len(got[lc]["note"])), ("related", "x" * 40, 20_001), "a long note is kept")
        self.assertEqual(self.changes(c, del_={lb: now_ms()}).status, 200)
        disk = H.read("profiles", c.scope, "links.json")["links"]
        self.assertEqual((sorted(disk), disk[la]["note"], disk[la]["tags"]), (sorted([la, lc]), "precious note", ["ok"]), "the next save keeps the repairs")
        with open(H.log_path, "rb") as f:
            self.assertIn(f"links-repaired scope={c.scope} dropped=1 repaired=3", f.read().decode("utf-8", "replace"))
        self.assertEqual(self.changes(c, {n2: self.link(n2)}).status, 200)
        self.assertEqual(c.req("GET", "/api/export/obsidian").status, 200)


def new_mark_id():
    return "mk_" + secrets.token_hex(6)


class T20_Marks(Base):
    """Highlights and comments (annotations brief §1, §2): the My links machinery, for marks."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        for who in ("mara", "mason"):
            email, pw = H.account(who, "Annotations")
            c = Client()
            assert c.signup(email, pw, name=who.title()).status == 201
            S[who] = c

    def mark(self, mid, start="43.3.16", so=4, eo=27, **kw):
        return dict({"id": mid, "tr": "kjv", "start": start, "so": so, "end": start, "eo": eo, "quote": "God so loved the world",
                     "pre": "For ", "suf": ", that he gave", "color": "yellow", "note": "", "updated": now_ms()}, **kw)

    def changes(self, c, set_=None, del_=None, base=None, rev=None, **extra):
        body = dict({"set": set_ or {}, "del": del_ or {}}, **extra)
        if base is not None:
            body["base"] = base
        if rev is not None:
            body["baseRev"] = rev
        return c.req("POST", "/api/marks/changes", body, scoped=True)

    def marks(self, c):
        return c.req("GET", "/api/marks").json

    def test_r01_get_and_first_write(self):
        g = Client()
        r = g.req("GET", "/api/marks")
        self.assertEqual(r.status, 200, r)
        self.assertEqual(r.json, {"marks": {}, "rev": 0, "scope": "guest"})
        self.assertEqual((r.headers["ETag"], r.headers["Cache-Control"]), ('"0"', "no-store"))
        a = S["mara"]
        self.assertEqual(self.marks(a), {"marks": {}, "rev": 1, "scope": a.scope}, "a new profile starts at rev 1")
        mid = new_mark_id()
        w = self.changes(a, {mid: self.mark(mid, note="So *loved*")}, base={mid: None}, rev=1)
        self.assertEqual(w.status, 200, w)
        self.assertEqual((w.json["ok"], w.json["rev"], w.json["changed"], w.json["stale"], w.json["conflicts"]), (True, 2, True, False, {}))
        self.assertRegex(w.json["saved"], r"^\d\d:\d\d:\d\d$")
        r = a.req("GET", "/api/marks")
        self.assertEqual((r.json["rev"], r.json["scope"], r.headers["ETag"]), (2, a.scope, '"2"'))
        self.assertEqual(w.json["versions"], {mid: r.json["marks"][mid]["updated"]})
        self.assertNotIn("deleted", r.json)
        self.assertEqual(H.read("profiles", a.scope, "marks.json")["marks"][mid]["note"], "So *loved*")
        self.assertEqual(g.req("GET", "/api/marks").json["marks"], {}, "the guest space is separate")

    def test_r02_validation_is_atomic(self):
        a, k = S["mara"], "mk_0123456789ab"
        M = lambda **kw: self.mark(k, **kw)  # noqa: E731
        no_end = {f: v for f, v in M().items() if f != "end"}
        bad = [M(tr=None), M(tr="KJV"), M(tr="niv"), M(tr=5), M(start="43.3.37", end="43.3.37"), M(start="43.22.1", end="43.22.1"),
               M(start="67.1.1"), M(start="43.3"), M(start="43.3.16-17", end="43.3.17"), M(start="43.3.١٦"), M(start="43:3:16"),
               M(start=43316), no_end, M(end="43.4.1"), M(end="45.5.8"), M(start="43.3.17", end="43.3.16"), M(so=-1), M(eo="27"),
               M(so=1.5), M(eo=10_001), M(so=True), M(so=5, eo=5), M(so=9, eo=4), M(quote=None), M(quote=""), M(quote=" \n "),
               M(quote="x" * 2001), M(quote=5), M(pre="x" * 33), M(pre=5), M(suf="y" * 33), M(color="red"), M(color="Yellow"),
               M(color=5), M(note="x" * 20_001), M(note=5), M(note="é" * 17_000), M(updated="x"), M(updated=-1), M(created="soon"),
               "not an object", dict(M(), id="mk_ba9876543210"), dict(M(), id=None)]
        rev = self.marks(a)["rev"]
        for case in bad:
            with self.subTest(case=str(case)[:120]):
                self.assertErr(self.changes(a, {k: case}), 400, "invalid_mark", field=k)
        self.assertEqual(self.changes(a, {k: M(so=9, eo=4)}).json["message"], "A highlight must end after it starts.")
        self.assertEqual(self.changes(a, {k: M(end="43.4.1")}).json["message"], "A highlight must start and end in the same chapter.")
        self.assertIn("20,000", self.changes(a, {k: M(note="x" * 20_001)}).json["message"])
        self.assertIn("32 KB", self.changes(a, {k: M(note="é" * 17_000)}).json["message"])
        self.assertErr(self.changes(a, {"mk_XYZ": M()}), 400, "invalid_mark", field="mk_XYZ")
        self.assertErr(self.changes(a, {"ln_0123456789ab": M()}), 400, "invalid_mark", field="ln_0123456789ab")
        self.assertErr(self.changes(a, {k: M()}, {k: now_ms()}), 400, "invalid_mark", field=k)
        self.assertErr(self.changes(a, del_={k: "x"}), 400, "invalid_mark", field=k)
        self.assertErr(self.changes(a, del_={"nope": now_ms()}), 400, "invalid_mark", field="nope")
        good = new_mark_id()
        self.assertErr(self.changes(a, {good: self.mark(good), k: M(color="red")}), 400, "invalid_mark", field=k)
        self.assertNotIn(good, self.marks(a)["marks"], "one bad mark: nothing is applied")
        self.assertErr(a.req("POST", "/api/marks/changes", {"set": []}, scoped=True), 400, "bad_request")
        self.assertErr(self.changes(a, {good: self.mark(good)}, base={good: "x"}), 400, "bad_request", field=good)
        self.assertErr(self.changes(a, rev=-1), 400, "bad_request", field="baseRev")
        for day in ("2026-02-30", 5):
            self.assertErr(self.changes(a, {good: self.mark(good)}, day=day), 400, "bad_request", field="day")
        self.assertEqual(self.marks(a)["rev"], rev, "nothing was written")
        self.assertErr(self.changes(a, del_={f"mk_{i:012x}": now_ms() for i in range(1001)}), 400, "bad_request")
        self.assertEqual(self.changes(a, del_={f"mk_{i:012x}": now_ms() for i in range(1000)}).status, 200, "1,000 keys is allowed")

    def test_r03_defaults_and_canonical_form(self):
        a, mid = S["mara"], new_mark_id()
        r = self.changes(a, {mid: {"id": mid, "tr": "esv", "start": "43.03.016", "so": 0, "end": "43.3.16", "eo": 3, "evil": "<script>",
                                   "quote": "For\u202e\u0007 God\n so", "updated": now_ms() + 3_600_000}})
        self.assertEqual(r.status, 200, r)
        mk = self.marks(a)["marks"][mid]
        self.assertEqual(list(mk), ["id", "tr", "start", "so", "end", "eo", "quote", "pre", "suf", "color", "note", "created", "updated"])
        self.assertEqual({f: mk[f] for f in ("tr", "start", "end", "quote", "pre", "suf", "color", "note")},
                         {"tr": "esv", "start": "43.3.16", "end": "43.3.16", "quote": "For God\n so", "pre": "", "suf": "", "color": "yellow", "note": ""},
                         "whitespace is kept; controls and bidi controls are removed")
        self.assertLessEqual(mk["updated"], now_ms(), "a time from the future is clamped")
        self.assertEqual(mk["created"], mk["updated"])
        m2, m3 = new_mark_id(), new_mark_id()
        self.assertEqual(self.changes(a, {m2: self.mark(m2, start="43.3.16", so=30, end="43.3.18", eo=0, quote="that he gave", color=""),
                                          m3: self.mark(m3, color="pink", note="Same words")}).status, 200, "a span across verses; two marks on one verse")
        got = self.marks(a)["marks"]
        self.assertEqual((got[m2]["end"], got[m2]["color"], got[m3]["color"]), ("43.3.18", "", "pink"))

    def test_r04_compare_and_set(self):
        a = S["mara"]
        t1, t2 = a.tab(), a.tab()
        mid, v0 = new_mark_id(), now_ms() - 10_000
        added = lambda: [e for e in a.library(activity=1000).json["activity"] if e["type"] == "mark.add" and e["x"]["id"] == mid]  # noqa: E731
        r = self.changes(t1, {mid: self.mark(mid, updated=v0)}, base={mid: None})
        self.assertEqual((r.json["changed"], r.json["versions"]), (True, {mid: v0}))
        rev = r.json["rev"]
        r = self.changes(t1, {mid: self.mark(mid, updated=v0)}, base={mid: None})
        self.assertEqual((r.json["changed"], r.json["conflicts"], r.json["versions"], r.json["rev"]), (False, {}, {mid: v0}, rev), "a retried create")
        self.assertEqual(len(added()), 1, "a retried create adds no second activity entry")
        r = self.changes(t1, {mid: self.mark(mid, updated=v0 - 5, note="edited")}, base={mid: v0})
        v1 = r.json["versions"][mid]
        self.assertEqual(v1, v0 + 1, "the version moves forward even from a clock that is behind")
        r = self.changes(t1, {mid: self.mark(mid, updated=v0 - 5, note="edited")}, base={mid: v0})
        self.assertEqual((r.json["changed"], r.json["conflicts"], r.json["versions"]), (False, {}, {mid: v1}), "a retried edit")
        stored = self.marks(a)["marks"][mid]
        r = self.changes(t2, {mid: self.mark(mid, color="green")}, base={mid: v0})
        self.assertEqual((r.json["changed"], r.json["conflicts"], r.json["versions"]), (False, {mid: stored}, {}))
        r = self.changes(t2, del_={mid: now_ms()}, base={mid: v0})
        self.assertEqual(r.json["conflicts"], {mid: stored}, "deleting a mark changed elsewhere is a conflict")
        self.assertEqual(self.marks(a)["marks"][mid], stored)
        td = now_ms()
        r = self.changes(t1, del_={mid: td}, base={mid: v1})
        self.assertEqual((r.json["changed"], r.json["conflicts"], r.json["versions"]), (True, {}, {mid: None}))
        self.assertNotIn(mid, self.marks(a)["marks"])
        self.assertGreaterEqual(H.read("profiles", a.scope, "marks.json")["deleted"][mid], td, "tombstone")
        r = self.changes(t2, {mid: self.mark(mid, updated=td - 1000)})
        self.assertEqual(r.json["conflicts"], {mid: None}, "an edit older than the delete does not bring it back")
        r = self.changes(t2, del_={mid: td + 5}, base={mid: v1})
        self.assertEqual((r.json["conflicts"], r.json["versions"]), ({}, {mid: None}), "deleting a deleted mark is no conflict")
        r = self.changes(t1, {mid: self.mark(mid, updated=now_ms())}, base={mid: None})
        self.assertEqual((r.json["changed"], r.json["conflicts"]), (True, {}), "Undo: the same id comes back with base null")
        rev = self.marks(a)["rev"]
        self.assertTrue(self.changes(t1, rev=rev - 1).json["stale"])
        self.assertFalse(self.changes(t1, rev=rev).json["stale"])
        self.assertEqual(len(added()), 2, "edits and deletes write no activity; the restored mark is new again")
        # two tabs, each adding its own mark to one verse: per-id compare-and-set, so neither conflicts
        x, y = new_mark_id(), new_mark_id()
        rx = self.changes(t1, {x: self.mark(x, so=0, eo=3, quote="For")}, base={x: None}, rev=rev)
        ry = self.changes(t2, {y: self.mark(y, so=8, eo=10, quote="so")}, base={y: None}, rev=rev)
        self.assertEqual((rx.json["conflicts"], ry.json["conflicts"], ry.json["stale"]), ({}, {}, True))
        self.assertLessEqual({x, y}, set(self.marks(a)["marks"]))

    def test_r05_scope_csrf_and_limits(self):
        a, g = S["mara"], Client()
        mid = new_mark_id()
        body = {"set": {mid: self.mark(mid)}}
        r = a.req("POST", "/api/marks/changes", body, headers={"X-BS-Scope": "guest"})
        self.assertErr(r, 409, "scope_mismatch")
        self.assertEqual(r.json["scope"], a.scope)
        r = g.req("POST", "/api/marks/changes", body, headers={"X-BS-Scope": a.scope})
        self.assertErr(r, 409, "scope_mismatch")
        self.assertEqual(r.json["scope"], "guest")
        self.assertErr(a.req("POST", "/api/marks/changes", body), 400, "scope_required")
        self.assertErr(S["mason"].req("POST", "/api/marks/changes", body, headers={"X-BS-Scope": a.scope}), 409, "scope_mismatch")
        for h in ({"Origin": "http://evil.example"}, {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertErr(a.req("POST", "/api/marks/changes", body, headers=h, scoped=True), 403, "csrf")
        self.assertNotIn(mid, self.marks(a)["marks"])
        self.assertNotIn(mid, self.marks(g)["marks"])
        self.assertErr(a.req("GET", "/api/marks/changes"), 405, "method_not_allowed")
        r = a.req("POST", "/api/marks", {}, scoped=True)
        self.assertErr(r, 405, "method_not_allowed")
        self.assertEqual(r.headers["Allow"], "GET")
        big = json.dumps({"set": {}, "pad": "x" * (1024 * 1024)}).encode()
        self.assertErr(a.req("POST", "/api/marks/changes", raw=big, scoped=True), 413, "too_large")

    def test_r06_new_marks_add_activity_and_studied_verses(self):
        c = S["mason"]
        lib0 = c.library().json
        today = time.strftime("%Y-%m-%d")
        m1, m2, m3 = new_mark_id(), new_mark_id(), new_mark_id()
        self.assertEqual(self.changes(c, {m1: self.mark(m1)}, base={m1: None}, day=today).status, 200)
        lib = c.library(today=today).json
        self.assertEqual(lib["rev"], lib0["rev"] + 1)
        e = lib["activity"][0]
        self.assertEqual({f: e[f] for f in ("type", "ref", "x")}, {"type": "mark.add", "ref": "43.3.16", "x": {"id": m1, "color": "yellow", "note": False}})
        self.assertEqual(lib["chapters"]["43.3"]["studied"], [16])
        self.assertEqual(H.read("profiles", c.scope, "library.json")["days"][today]["v"], 1)
        self.assertEqual((lib["stats"]["totals"]["marks"], lib["stats"]["totals"]["links"]), (1, 0))
        self.assertTrue(lib["stats"]["streak"]["studiedToday"])
        self.changes(c, {m2: self.mark(m2, start="43.3.17", end="43.3.18", so=2, eo=5, color="", note="Sent, not condemned")}, day=today)
        self.changes(c, {m3: self.mark(m3, start="19.23.1", end="19.23.1", so=0, eo=3, quote="The")}, day="2001-01-01")
        lib = c.library(today=today).json
        self.assertEqual(lib["chapters"]["43.3"]["studied"], [16, 17], "only the start verse of a span")
        days = H.read("profiles", c.scope, "library.json")["days"]
        self.assertEqual(days[today]["v"], 3)
        self.assertNotIn("2001-01-01", days, "a day far from the server's date is not trusted")
        self.assertEqual([(x["x"]["id"], x["x"]["color"], x["x"]["note"], x["ref"]) for x in lib["activity"][:3]],
                         [(m3, "yellow", False, "19.23.1"), (m2, "", True, "43.3.17"), (m1, "yellow", False, "43.3.16")])
        n, rev = lib["activityTotal"], lib["rev"]
        self.changes(c, {m1: self.mark(m1, note="edited")})
        self.changes(c, del_={m2: now_ms()})
        lib = c.library().json
        self.assertEqual((lib["activityTotal"], lib["rev"], lib["stats"]["totals"]["marks"]), (n, rev, 2), "edits and deletes write no activity")
        g, gid = Client(), new_mark_id()
        self.assertEqual(self.changes(g, {gid: self.mark(gid, start="40.6.33", end="40.6.33", so=0, eo=3, quote="But")}).status, 200)
        glib = g.library().json
        self.assertEqual((glib["activity"][0]["type"], glib["activity"][0]["ref"]), ("mark.add", "40.6.33"))
        self.assertIn(33, glib["chapters"]["40.6"]["studied"])
        self.assertEqual(glib["stats"]["totals"]["marks"], len(self.marks(g)["marks"]))

    def test_r07_lock_order(self):
        """Links file -> marks file -> library file, under the one scope lock (the order documented at accounts.lock_for)."""
        import serve  # noqa: E402 (starts nothing)
        d = tempfile.mkdtemp(prefix="bs-servertest-unit-")
        real = {n: getattr(accounts, n) for n in ("save_links", "save_marks", "save_library", "save_notes", "load_library")}
        order = []

        def spy(name):
            def f(scope, *a):
                order.append((name, accounts.lock_for(scope).locked()))
                return real[name](scope, *a)
            return f
        try:
            accounts.configure(d, H.port)
            for n in real:
                setattr(accounts, n, spy(n))
            h = serve.Handler.__new__(serve.Handler)
            sent = []
            h.send_json = lambda obj, status=200, headers=(): sent.append((status, obj))
            h._scope, h._uid = "guest", None
            mid, lid = new_mark_id(), "ln_" + secrets.token_hex(6)
            h.h_marks_changes({"set": {mid: self.mark(mid)}}, {}, None)
            self.assertEqual(sent[-1][0], 200, sent)
            self.assertEqual(order, [("save_marks", True), ("load_library", True), ("save_library", True)])
            h.h_links_changes({"set": {lid: {"id": lid, "from": "43.3.16", "to": "45.5.8"}}}, {}, None)
            order.clear()
            h._scope = h._uid = "u0123456789abcdef"
            h.h_import_guest({}, {}, None)
            self.assertEqual((sent[-1][1]["imported"]["marks"], sent[-1][1]["imported"]["links"]), (1, 1))
            self.assertEqual([o for o in order if o[0] != "load_library"], [("save_links", True), ("save_marks", True), ("save_library", True)])
        finally:
            for n, fn in real.items():
                setattr(accounts, n, fn)
            accounts.configure(H.data, H.port)
            shutil.rmtree(d, ignore_errors=True)
        # and over HTTP: mark and link writes and tracker batches from several tabs at once neither deadlock nor lose anything
        c = S["mason"]
        lib0, errs, ids = c.library().json, [], []

        def marks_tab(k):
            t = c.tab()
            for i in range(15):
                mid = new_mark_id()
                ids.append(mid)
                r = self.changes(t, {mid: self.mark(mid, start=f"20.{k + 1}.{i + 1}", so=0, eo=3, quote="The")}, base={mid: None})
                if r.status != 200 or r.json["conflicts"]:
                    errs.append(r)

        def links_tab():
            t = c.tab()
            for i in range(10):
                lid = "ln_" + secrets.token_hex(6)
                r = t.req("POST", "/api/links/changes", {"set": {lid: {"id": lid, "from": f"21.{i % 12 + 1}.1", "to": "43.1.1"}}}, scoped=True)
                if r.status != 200:
                    errs.append(r)

        def events_tab():
            t = c.tab()
            for _ in range(15):
                r = t.events([{"type": "chapter.time", "b": 19, "c": 117, "sec": 10, "t": now_ms()}])
                if r.status != 200:
                    errs.append(r)
        th = [threading.Thread(target=marks_tab, args=(k,)) for k in (0, 1)] + [threading.Thread(target=links_tab), threading.Thread(target=events_tab)]
        [t.start() for t in th]
        [t.join(120) for t in th]
        self.assertFalse([t for t in th if t.is_alive()], "no deadlock")
        self.assertEqual(errs, [])
        lib = c.library(activity=1000).json
        self.assertEqual(lib["rev"], lib0["rev"] + 55)
        self.assertLessEqual(set(ids), {e["x"]["id"] for e in lib["activity"] if e["type"] == "mark.add"})
        self.assertLessEqual(set(ids), set(self.marks(c)["marks"]))

    def test_r08_guest_import_copy_and_merge(self):
        g, t0 = Client(), now_ms() - 60_000
        ids = {k: new_mark_id() for k in ("kept", "taken", "tomb", "newer")}
        sets = {ids[k]: self.mark(ids[k], start=f"45.5.{i + 1}", end=f"45.5.{i + 1}", so=0, eo=4, quote="Word", updated=t0,
                                  note="Guest comment" if k == "taken" else "") for i, k in enumerate(ids)}
        self.assertEqual(self.changes(g, sets).status, 200)
        guest = H.read("guest-marks.json")
        me = g.me().json["guest"]
        self.assertEqual((me["marks"], me["hasData"]), (len(guest["marks"]), True))
        # sign-up with import: a copy (rev 1, no tombstones); the guest file is left as it is
        email, pw = H.account("markimp", "Annotations: sign-up import")
        c = Client()
        r = c.signup(email, pw, name="Mark Import", import_guest=True)
        self.assertEqual(r.status, 201, r)
        self.assertEqual(r.json["imported"]["marks"], len(guest["marks"]))
        disk = H.read("profiles", c.scope, "marks.json")
        self.assertEqual((disk["rev"], disk["deleted"], disk["marks"]), (1, {}, guest["marks"]))
        self.assertEqual(H.read("guest-marks.json"), guest)
        imp = [e for e in c.library().json["activity"] if e["type"] == "profile.import"][0]
        self.assertEqual(imp["x"]["marks"], len(guest["marks"]))
        # a profile with marks of its own imports later: merge
        b = S["mason"]
        own = {ids["kept"]: dict(sets[ids["kept"]], updated=t0 + 5000, color="green"),
               ids["tomb"]: dict(sets[ids["tomb"]], updated=t0 - 5000),
               ids["newer"]: dict(sets[ids["newer"]], updated=t0 - 5000, color="blue")}
        self.assertEqual(self.changes(b, own).status, 200)
        self.assertTrue(self.changes(b, del_={ids["tomb"]: t0 + 1}).json["changed"])
        r = b.req("POST", "/api/profile/import-guest", {}, scoped=True)
        self.assertEqual(r.status, 200, r)
        want = len(set(guest["marks"]) - set(own)) + 1
        mine = self.marks(b)["marks"]
        self.assertEqual(r.json["imported"]["marks"], want)
        self.assertEqual(mine[ids["kept"]]["color"], "green", "the profile's newer edit is kept")
        self.assertEqual(mine[ids["newer"]], guest["marks"][ids["newer"]], "the guest's newer edit is taken")
        self.assertEqual(mine[ids["taken"]]["note"], "Guest comment")
        self.assertNotIn(ids["tomb"], mine, "deleted in the profile after the guest's edit: stays deleted")
        self.assertEqual(r.json["rev"]["marks"], self.marks(b)["rev"])
        imp = [e for e in b.library().json["activity"] if e["type"] == "profile.import"][0]
        self.assertEqual(imp["x"]["marks"], want)
        r2 = b.req("POST", "/api/profile/import-guest", {}, scoped=True)
        self.assertEqual((r2.json["imported"]["marks"], r2.json["changed"], r2.json["rev"]), (0, False, r.json["rev"]), "idempotent")
        self.assertEqual(self.marks(b)["marks"], mine)

    def test_r09_exports(self):
        a = S["mara"]
        r = a.req("GET", "/api/export/profile")
        self.assertEqual(r.json["marks"], {"marks": self.marks(a)["marks"]})
        self.assertNotIn(b'"deleted"', r.raw, "tombstones are not exported")
        self.assertEqual(Client().req("GET", "/api/export/profile").json["marks"]["marks"], self.marks(Client())["marks"])
        m1, m2, m3 = new_mark_id(), new_mark_id(), new_mark_id()
        self.changes(a, {m1: self.mark(m1, start="1.1.1", end="1.1.1", so=17, eo=33, quote="God created the\nheaven", color="green",
                                       note="Not *made*: created.\n\nSee [[John 1:3]]."),
                         m2: self.mark(m2, start="1.1.1", end="1.1.2", so=0, eo=9, quote="In the beginning … earth was", color="", tr="esv",
                                       note="A comment only"),
                         m3: self.mark(m3, start="43.1.36", end="43.1.36", so=0, eo=3, quote="And")})
        a.req("POST", "/api/notes/changes", {"set": {"43.1.36": {"text": "Note on John 1:36", "updated": now_ms()}}}, scoped=True)
        z = zipfile.ZipFile(io.BytesIO(a.req("GET", "/api/export/obsidian").raw))
        gen = z.read("study-notes/Genesis 1.1.md").decode()
        self.assertIn('# Genesis 1:1\n\n## Highlights\n- “In the beginning … earth was” (ESV)\n  > A comment only\n'
                      '- “God created the heaven” (KJV, green)\n  > Not *made*: created.\n  >\n  > See [[John 1.3|John 1:3]].\n\nVerse: [[verses/Genesis 1.1|', gen)
        self.assertNotIn("study-notes/Genesis 1.2.md", z.namelist(), "a span is listed in its start verse's file")
        jn = z.read("study-notes/John 1.36.md").decode()
        self.assertIn("Note on John 1:36\n\n## Highlights\n- “And” (KJV, yellow)\n\nVerse: [[verses/John 1.36|", jn)
        self.assertIn("- [[study-notes/Genesis 1.1|Genesis 1:1]]", z.read("study-notes/Study Notes Index.md").decode())

    def test_r10_pure_functions(self):
        A, t = accounts, 1759071600000
        mk = lambda mid, start, so, end, eo, **kw: A.clean_mark(dict({"id": mid, "tr": "kjv", "start": start, "so": so, "end": end, "eo": eo,  # noqa: E731
                                                                     "quote": "word", "updated": t, "created": t}, **kw), t)
        self.assertEqual(A.parse_mark_end("43.03.016"), (43, 3, 16))
        self.assertEqual([A.parse_mark_end(s) for s in ("43.3.16-17", "43.3.37", "43.3", None)], [None] * 4)
        self.assertEqual(mk("mk_000000000001", "43.03.16", 0, "43.3.017", 0)["end"], "43.3.17", "a span may end at the start of a verse")
        for args in (("43.3.16", 4, "43.3.16", 4), ("43.3.17", 0, "43.3.16", 9), ("43.3.16", 0, "43.4.1", 1)):
            with self.assertRaises(ValueError):
                mk("mk_000000000001", *args)
        f = mk("mk_000000000001", "43.3.16", 4, "43.3.16", 27, color="", note="n")
        doc = A.empty_marks()
        self.assertEqual(A.apply_mark_changes(doc, {f["id"]: f}, {}, {f["id"]: None}), (True, {}, [f["id"]]))
        self.assertEqual(A.apply_mark_changes(doc, {f["id"]: f}, {}, {f["id"]: None}), (False, {}, []))
        self.assertEqual(A.mark_versions(doc, [f["id"], "mk_00000000000f"], {}), {f["id"]: t, "mk_00000000000f": None})
        lib = A.new_library(t)
        self.assertTrue(A.add_mark_activity(lib, [f], "2026-09-28", t))
        self.assertEqual((lib["activity"][-1], lib["chapters"]["43.3"]["studied"], lib["days"]["2026-09-28"]["v"]),
                         ({"t": t, "type": "mark.add", "ref": "43.3.16", "x": {"id": f["id"], "color": "", "note": True}}, [16], 1))
        self.assertFalse(A.add_mark_activity(lib, [], "2026-09-28", t))
        dst = {"marks": {f"mk_{i:012x}": {"updated": 1} for i in range(A.MAX_MARKS - 1)}, "deleted": {}}
        src = {"marks": {f"mk_aaaaaaaaaaa{i}": mk(f"mk_aaaaaaaaaaa{i}", "1.1.1", 0, "1.1.1", 2) for i in range(3)}}
        self.assertEqual((A.merge_marks(dst, src), len(dst["marks"])), (1, A.MAX_MARKS), "an import stops at the limit")
        self.assertFalse(A.guest_summary({"refs": {}}, A.new_library(), {"links": {}}, {"marks": {}})["hasData"])
        s = A.guest_summary({"refs": {}}, A.new_library(), None, {"marks": {f["id"]: f}})
        self.assertEqual((s["marks"], s["links"], s["hasData"]), (1, 0, True), "marks alone are guest data")
        self.assertEqual(A.compute_stats(A.new_library(), 0, "2026-09-28", 7, 9)["totals"]["marks"], 9)
        marks = {"marks": {
            "mk_000000000002": mk("mk_000000000002", "45.5.8", 30, "45.5.8", 40, quote="Christ died", color="purple"),
            "mk_000000000003": mk("mk_000000000003", "45.5.8", 0, "45.5.8", 3, quote="But", tr="nlt", note="  [[Rom 5:6]]  "),
            "mk_000000000004": mk("mk_000000000004", "43.1.29", 0, "43.1.29", 3, quote="The", color="")}}
        links = {"links": {"ln_000000000005": A.clean_link({"id": "ln_000000000005", "from": "43.1.29", "to": "23.53.7", "type": "fulfils",
                                                            "updated": t, "created": t}, t)}}
        z = zipfile.ZipFile(io.BytesIO(A.obsidian_zip({"refs": {}}, None, links, marks)))
        self.assertEqual(z.read("study-notes/Romans 5.8.md").decode().splitlines(), [
            "---", 'reference: "Romans 5:8"', "tags: [bible, study-note]", "---", "# Romans 5:8", "", "## Highlights",
            "- “But” (NLT, yellow)", "  > [[Romans 5.6|Rom 5:6]]", "- “Christ died” (KJV, purple)", "",
            "Verse: [[verses/Romans 5.8|Romans 5:8]] · Chapter: [[chapters/Romans 5|Romans 5]] · Book: [[books/Romans|Romans]]"])
        self.assertIn("# John 1:29\n\n## Highlights\n- “The” (KJV)\n\n## Connections\n- fulfils → [[Isaiah 53.7|Isaiah 53:7]]\n\nVerse:",
                      z.read("study-notes/John 1.29.md").decode(), "highlights, then connections")
        self.assertEqual(z.read("study-notes/Study Notes Index.md").decode().splitlines(), [
            "# Study notes", "", "- [[study-notes/Isaiah 53.7|Isaiah 53:7]]", "- [[study-notes/John 1.29|John 1:29]]",
            "- [[study-notes/Romans 5.8|Romans 5:8]]", "", "- [[study-notes/Connections|Connections]]"], "every marked verse's file is listed")
        z = zipfile.ZipFile(io.BytesIO(A.obsidian_zip({"refs": {}}, None, None, {"marks": {}})))
        self.assertEqual(z.namelist(), ["study-notes/Study Notes Index.md"])

    def test_r11_limit_and_damaged_files(self):
        email, pw = H.account("markcap", "Annotations: limit and repair")
        c = Client()
        self.assertEqual(c.signup(email, pw, name="Mark Cap").status, 201)
        pdir = os.path.join(H.data, "profiles", c.scope)
        path, t = os.path.join(pdir, "marks.json"), now_ms()
        full = {f"mk_{i:012x}": {"id": f"mk_{i:012x}", "tr": "kjv", "start": f"19.119.{i % 176 + 1}", "so": 0, "end": f"19.119.{i % 176 + 1}", "eo": 5,
                                 "quote": "Blessed", "pre": "", "suf": " are", "color": "yellow", "note": "", "created": t, "updated": t}
                for i in range(accounts.MAX_MARKS - 1)}
        put_raw(path, json.dumps({"version": 1, "rev": 5, "marks": full, "deleted": {}}).encode("utf-8"))
        n1, n2 = new_mark_id(), new_mark_id()
        r = self.changes(c, {n1: self.mark(n1), n2: self.mark(n2)})
        self.assertErr(r, 409, "mark_limit")
        self.assertEqual(r.json["message"], "You’ve reached the limit of 20,000 highlights and comments.")
        self.assertEqual(self.changes(c, {n1: self.mark(n1)}).status, 200)
        self.assertErr(self.changes(c, {n2: self.mark(n2)}), 409, "mark_limit")
        first = "mk_000000000000"
        self.assertEqual(self.changes(c, {first: dict(full[first], note="edit", updated=now_ms())}).status, 200, "edits still work at the limit")
        r = self.changes(c, {n2: self.mark(n2)}, del_={first: now_ms()})
        self.assertEqual(r.status, 200, "at the limit, a delete makes room for a create in the same batch")
        self.assertEqual((first in self.marks(c)["marks"], n2 in self.marks(c)["marks"]), (False, True))
        self.assertEqual(c.library().json["stats"]["totals"]["marks"], accounts.MAX_MARKS)
        # a readable but wrongly shaped file is repaired entry by entry, never moved aside or a 500
        good = new_mark_id()
        put_raw(path, json.dumps({"rev": "x", "marks": {good: self.mark(good, updated=now_ms() + 86_400_000), "mk_aaaaaaaaaaaa": {"id": "mk_aaaaaaaaaaaa", "start": "x"},
                                                        "mk_bbbbbbbbbbbb": 5, "mk_cccccccccccc": self.mark("mk_dddddddddddd")},
                                  "deleted": {"mk_eeeeeeeeeeee": "soon", "nonsense": 5, "mk_ffffffffffff": now_ms() + 10 ** 9}}).encode("utf-8"))
        mtime = int(os.stat(path).st_mtime * 1000)
        r = c.req("GET", "/api/marks")
        self.assertEqual((r.status, r.json["rev"], list(r.json["marks"])), (200, 0, [good]))
        self.assertEqual(r.json["marks"][good]["updated"], mtime, "a time from the future reads as the file's mtime")
        r = self.changes(c, del_={good: now_ms()}, base={good: mtime})
        self.assertEqual((r.status, r.json["conflicts"]), (200, {}), "a base taken from the repaired GET still matches")
        disk = H.read("profiles", c.scope, "marks.json")
        self.assertEqual(set(disk["deleted"]), {good, "mk_ffffffffffff"})
        self.assertLessEqual(disk["deleted"]["mk_ffffffffffff"], now_ms())
        self.assertFalse([f for f in os.listdir(pdir) if ".corrupt-" in f])
        self.assertTrue(os.path.exists(path + ".bak"), "the daily backup")
        # an unparseable file is moved aside, never overwritten in place
        put_raw(path, b"{not json")
        r = c.req("GET", "/api/marks")
        self.assertEqual((r.status, r.json["marks"], r.json["rev"]), (200, {}, 0))
        self.assertTrue([f for f in os.listdir(pdir) if f.startswith("marks.json.corrupt-")])
        # a bad optional field is repaired field by field: only a bad id, ends, offsets or quote lose a mark (and its comment)
        ma, mb, mc, md = (new_mark_id() for _ in range(4))
        put_raw(path, json.dumps({"version": 1, "rev": 2, "marks": {
            ma: self.mark(ma, tr="niv", color="teal", note="precious comment", pre="p" * 40, suf=["x"], created="x"),
            mb: self.mark(mb, note=["not text"], quote="q" * 2100),
            mc: self.mark(mc, note="n" * 20_001),
            md: self.mark(md, so=30, eo=4, note="lost")}}).encode("utf-8"))
        got = self.marks(c)["marks"]
        self.assertEqual(sorted(got), sorted([ma, mb, mc]))
        self.assertEqual({k: got[ma][k] for k in ("tr", "color", "note", "pre", "suf")},
                         {"tr": "kjv", "color": "yellow", "note": "precious comment", "pre": "p" * 32, "suf": ""})
        self.assertEqual(got[ma]["created"], got[ma]["updated"], "a bad created time becomes the updated time")
        self.assertEqual((got[mb]["note"], len(got[mb]["quote"]), len(got[mc]["note"])), ("", 2000, 20_001), "a long comment is kept")
        self.assertEqual(self.changes(c, del_={mb: now_ms()}).status, 200)
        disk = H.read("profiles", c.scope, "marks.json")["marks"]
        self.assertEqual((sorted(disk), disk[ma]["note"], disk[ma]["tr"]), (sorted([ma, mc]), "precious comment", "kjv"), "the next save keeps the repairs")
        with open(H.log_path, "rb") as f:
            self.assertIn(f"marks-repaired scope={c.scope} dropped=1 repaired=2", f.read().decode("utf-8", "replace"))
        self.assertEqual(self.changes(c, {n2: self.mark(n2)}).status, 200)
        self.assertEqual(c.req("GET", "/api/export/obsidian").status, 200)


# ======================================================================= J. hygiene (last)
# ======================================================================= hosting (.design/hosting-brief.md §1)
class HostedClient(Client):
    """Hosted mode marks the session cookie Secure, which a CookieJar keeps off plain http, so this tab sends it by
    hand. `ip` goes out as X-Forwarded-For (only a server with BS_TRUST_PROXY believes it)."""

    def __init__(self, ip=None):
        super().__init__()
        self.tok, self.ip = None, ip

    def req(self, method, path, body=None, headers=None, **kw):
        h = dict(headers or {})
        if self.tok:
            h.setdefault("Cookie", f"{H.cookie}={self.tok}")
        if self.ip:
            h.setdefault("X-Forwarded-For", self.ip)
        r = super().req(method, path, body, h, **kw)
        for c in r.set_cookies():
            m = re.match(rf"{H.cookie}=([^;]*)", c)
            if m:
                self.tok = m.group(1) or None
        return r

    def signup(self, email, pw, name="Test User", remember=True, import_guest=False, invite=None):
        body = {"email": email, "name": name, "password": pw, "remember": remember, "importGuest": import_guest}
        if invite is not None:
            body["invite"] = invite
        r = self.req("POST", "/api/auth/signup", body)
        if r.status == 201:
            self.scope = r.json["user"]["uid"]
        return r


def spawn_server(env, *args):
    """A serve.py of its own (not H), started with exactly `env` for the hosting variables. -> (proc, stdout path)."""
    out = os.path.join(H.tmp, f"spawn-{secrets.token_hex(3)}.log")
    with open(out, "wb") as f:
        proc = subprocess.Popen([PY, SERVE, *args], stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                env=server_env(env))
    return proc, out


def wait_health(port, proc, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            return None
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
                    f"http://127.0.0.1:{port}/api/health", timeout=1) as r:
                return json.loads(r.read().decode("utf-8"))
        except OSError:
            time.sleep(0.1)
    return None


def stop_proc(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(5)


class T21_HostingEnv(Base):
    """Each environment variable, and local mode with none set (hosting brief §1)."""
    restart = False

    def test_v01_port_host_and_data_dir_from_env(self):
        port, d = free_port(), os.path.join(H.tmp, f"envdata-{RUN}")
        proc, out = spawn_server({"PORT": str(port), "HOST": "localhost", "BS_DATA_DIR": d})
        try:
            self.assertEqual(wait_health(port, proc), {"ok": True}, "answers on $PORT")
            self.assertTrue(os.path.isdir(os.path.join(d, "profiles")), "data in $BS_DATA_DIR")
            self.assertTrue(os.path.exists(os.path.join(d, ".server.lock")))
        finally:
            stop_proc(proc)
        with open(out, encoding="utf-8") as f:
            self.assertIn(f"http://localhost:{port}", f.read(), "binds $HOST")

    def test_v02_flags_win_over_env(self):
        p_env, p_flag = free_port(), free_port()
        d1, d2 = os.path.join(H.tmp, f"envdata1-{RUN}"), os.path.join(H.tmp, f"envdata2-{RUN}")
        proc, _ = spawn_server({"PORT": str(p_env), "BS_DATA_DIR": d1}, "--port", str(p_flag), "--data-dir", d2)
        try:
            self.assertEqual(wait_health(p_flag, proc), {"ok": True})
            self.assertFalse(port_answers(p_env))
            self.assertTrue(os.path.isdir(os.path.join(d2, "profiles")))
            self.assertFalse(os.path.exists(d1))
        finally:
            stop_proc(proc)

    def test_v03_bad_port_refused(self):
        p = subprocess.run([PY, SERVE, "--list-users"], capture_output=True, text=True, timeout=30,
                           env=server_env({"PORT": "80a", "BS_DATA_DIR": os.path.join(H.tmp, "never")}))
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("PORT must be a whole number.", p.stderr)

    def test_v04_configure_hosting_parses_and_resets(self):
        import contextlib, warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", ResourceWarning)
            import serve  # noqa: E402 (starts nothing)
        err = io.StringIO()
        try:
            with contextlib.redirect_stderr(err):
                serve.configure_hosting({
                    "BS_HOSTED": "1", "BS_TRUST_PROXY": "true",
                    "BS_ALLOWED_HOSTS": " App.Example.test:8443, *.up.railway.app,bad host!, ",
                    "BS_ALLOWED_ORIGINS": "https://Site.example.test/, ftp://files.example.test",
                    "BS_OWNER_EMAILS": " Ji@Example.test ,secret-not-an-email"})
            self.assertTrue(serve.HOSTED and serve.TRUST_PROXY)
            self.assertEqual(serve.ENV_HOSTS, ("app.example.test", "*.up.railway.app"))
            self.assertEqual(serve.ALLOWED_ORIGINS, {"https://site.example.test"})
            self.assertEqual(serve.OWNER_EMAILS, {"ji@example.test"})
            for host, ok in [("app.example.test", True), ("app.example.test:443", True), ("x.up.railway.app", True),
                             ("a.b.up.railway.app:8080", True), ("up.railway.app", False), (".up.railway.app", False),
                             ("*.up.railway.app", False), ("evil.example.test", False), ("app.example.test.evil.test", False),
                             ("xup.railway.app", False)]:
                self.assertEqual(serve.env_host_ok(host), ok, host)
            warned = err.getvalue()
            self.assertIn("BS_ALLOWED_HOSTS: ignored bad host!", warned)
            self.assertIn("BS_ALLOWED_ORIGINS: ignored ftp://files.example.test", warned)
            self.assertNotIn("secret-not-an-email", warned, "an owner entry is never printed")
            for off in ("", "0", "no", "false"):
                serve.configure_hosting({"BS_HOSTED": off, "BS_TRUST_PROXY": off})
                self.assertFalse(serve.HOSTED or serve.TRUST_PROXY, off)
        finally:
            serve.configure_hosting({})
        self.assertEqual((serve.HOSTED, serve.TRUST_PROXY, serve.ENV_HOSTS, serve.ALLOWED_ORIGINS, serve.OWNER_EMAILS),
                         (False, False, (), frozenset(), frozenset()))
        self.assertFalse(serve.env_host_ok("app.example.test"))

    def test_v05_invite_codes(self):
        codes = {accounts.new_invite_code() for _ in range(200)}
        self.assertEqual(len(codes), 200)
        for c in codes:
            self.assertEqual(len(c), 10)
            self.assertFalse(set(c) - set("ABCDEFGHJKMNPQRSTUVWXYZ23456789"), c)
        self.assertFalse(set("01OIL") & set(accounts.INVITE_ALPHABET), "no characters to misread")
        self.assertEqual(accounts.normalize_invite(" abcde-fghjk "), "ABCDEFGHJK")
        self.assertEqual(accounts.normalize_invite("ABCDE FGHJK"), "ABCDEFGHJK")
        for bad in (None, 7, "", "ABCDEFGHJ", "ABCDEFGHJKM", "ABCDEFGHJ0", "ABCDEFGHJI", "x" * 50):
            self.assertIsNone(accounts.normalize_invite(bad), bad)
        self.assertEqual(accounts.invite_key("ABCDEFGHJK"), hashlib.sha256(b"ABCDEFGHJK").hexdigest())

    def test_v06_local_mode_unchanged(self):
        """No variables: open sign-up, no owners, no invites endpoints, guests write, a cookie without Secure."""
        H.restart()
        me = Client().me().json
        self.assertEqual((me["hosted"], me["signup"], me["owner"]), (False, "open", False))
        self.assertEqual(Client().req("GET", "/api/health").json, {"ok": True})
        self.assertErr(Client().req("GET", "/api/invites"), 404, "not_found")
        self.assertErr(Client().req("POST", "/api/invites", {"note": "x"}), 404, "not_found")
        self.assertErr(Client().req("POST", "/api/invites/revoke", {"id": "iv_000000000000"}), 404, "not_found")
        status, _, _ = raw_req("GET", "/api/health", headers={"Host": "healthcheck.railway.app"})
        self.assertEqual(status, 403, "locally the Host check covers health too")
        r = Client().req("POST", "/api/notes/changes", {"set": {"40.1.1": {"text": "guest", "updated": now_ms()}}}, scoped=True)
        self.assertEqual(r.status, 200, r)
        email, pw = H.account("local", "Hosting: local mode")
        c = Client()
        r = c.signup(email, pw)
        self.assertEqual(r.status, 201, r)
        self.assertNotIn("secure", r.set_cookies()[0].lower())
        me = c.me().json
        self.assertEqual((me["hosted"], me["signup"], me["owner"]), (False, "open", False))
        self.assertEqual(c.req("GET", "/api/config").json, {"esv": False, "nlt": False})
        self.assertEqual(c.req("PUT", "/api/config", {}).status, 200, "anyone may set keys locally")


class T22_Hosted(Base):
    """BS_HOSTED=1: read-only guests, invites, owner-only ESV/NLT and keys, a Secure cookie, the Host and Origin lists."""
    restart = False
    msg_sign_in = "Sign in to save your notes, links and highlights."

    @classmethod
    def setUpClass(cls):
        cls.data = os.path.join(H.tmp, "hosted-data")  # its own folder (T99 reads H.data)
        cls.owner_email, cls.owner_pw = H.account("owner", "Hosting: owner")
        cls.owner2 = f"owner2-{RUN}@example.test"  # an owner address nobody has signed up with
        H.restart("--data-dir", cls.data, env={
            "BS_HOSTED": "1", "BS_OWNER_EMAILS": f" {cls.owner_email.upper()} , {cls.owner2}",
            "BS_ALLOWED_HOSTS": "app.example.test, *.up.railway.app:443", "BS_ALLOWED_ORIGINS": "https://site.example.test/"})
        cls.owner, cls.member = HostedClient(), HostedClient()

    @classmethod
    def tearDownClass(cls):
        H.restart()

    def test_w01_me_reports_hosted(self):
        me = HostedClient().me().json
        self.assertEqual((me["hosted"], me["signup"], me["owner"], me["signedIn"]), (True, "invite", False, False))
        self.assertFalse(me["guest"]["hasData"])

    def test_w02_health_and_hosts(self):
        r = HostedClient().req("GET", "/api/health", headers={"Origin": "https://evil.example.test", "Sec-Fetch-Site": "cross-site"})
        self.assertEqual((r.status, r.json), (200, {"ok": True}), "no auth, scope or CSRF")
        for host, path, want in [("healthcheck.railway.app", "/api/health", 200), ("healthcheck.railway.app", "/api/notes", 403),
                                 ("healthcheck.railway.app", "/index.html", 403), ("app.example.test", "/api/auth/me", 200),
                                 ("app.example.test:443", "/api/auth/me", 200), ("bs-api.up.railway.app", "/api/auth/me", 200),
                                 ("up.railway.app", "/api/auth/me", 403), ("evil.example.test", "/api/auth/me", 403)]:
            status, _, body = raw_req("GET", path, headers={"Host": host})
            self.assertEqual(status, want, (host, path, body[:200]))
        st, hdrs, body = raw_req("HEAD", "/api/health", headers={"Host": "healthcheck.railway.app"})
        self.assertEqual((st, body, hdrs.get("content-length")), (200, b"", str(len(b'{"ok": true}'))), "HEAD: uptime monitors")
        self.assertEqual(raw_req("HEAD", "/api/notes", headers={"Host": "healthcheck.railway.app"})[0], 403)

    def test_w03_guests_read_but_never_write(self):
        g = HostedClient()
        for path in ("/api/notes", "/api/library", "/api/links", "/api/marks", "/api/config", "/api/export/profile",
                     "/index.html", "/data/meta.json"):
            self.assertEqual(g.req("GET", path).status, 200, path)
        writes = [("PUT", "/api/notes", {"refs": {}}), ("POST", "/api/notes/changes", {"set": {"43.3.16": {"text": "x"}}}),
                  ("POST", "/api/links/changes", {"set": {}}), ("POST", "/api/marks/changes", {"set": {}}),
                  ("POST", "/api/library/events", {"batchId": uuid.uuid4().hex, "events": [{"type": "chapter.open"}]}),
                  ("POST", "/api/library/bookmarks", {"ref": "43.3.16"}), ("PATCH", "/api/library/bookmarks/bm_000000000000", {"label": "x"}),
                  ("DELETE", "/api/library/bookmarks/bm_000000000000", {}), ("POST", "/api/library/chapters", {"b": 43, "c": 3, "read": True}),
                  ("POST", "/api/library/reset", {"what": ["activity"]}), ("POST", "/api/profile/import-guest", {})]
        for method, path, body in writes:
            r = g.req(method, path, body, scoped=True)
            self.assertErr(r, 401, "sign_in_required")
            self.assertEqual(r.json["message"], self.msg_sign_in, path)
        for name in ("notes.json", "guest-library.json", "guest-links.json", "guest-marks.json"):
            self.assertFalse(os.path.exists(os.path.join(self.data, name)), name)
        self.assertErr(g.req("POST", "/api/profile/import", {"format": "bible-study-profile", "version": 1}, scoped=True), 401, "not_signed_in")

    def test_w04_owner_signs_up_without_invite(self):
        r = self.owner.signup(self.owner_email, self.owner_pw, name="Owner")
        self.assertEqual(r.status, 201, r)
        attrs = [a.strip() for a in r.set_cookies()[0].split(";")[1:]]
        for a in ("Secure", "HttpOnly", "SameSite=Strict", "Path=/"):
            self.assertIn(a, attrs)
        me = self.owner.me().json
        self.assertEqual((me["signedIn"], me["owner"], me["hosted"]), (True, True, True))
        self.assertEqual(self.owner.req("GET", "/api/invites").json, {"invites": []})

    def test_w05_sign_up_needs_an_invite(self):
        for invite in (None, "", "ABCDEFGHJK", "not a code", 12345):
            email, pw = f"noinvite-{RUN}@example.test", secrets.token_urlsafe(18)
            r = HostedClient().signup(email, pw, invite=invite)
            self.assertErr(r, 403, "invite_required", "invite")
            self.assertEqual(r.json["message"], "Sign-up needs an invite code.")
        # A claimed owner email is an ordinary sign-up (QC 0): the invite comes first, so nothing says a profile exists.
        self.assertErr(HostedClient().signup(self.owner_email, secrets.token_urlsafe(18)), 403, "invite_required", "invite")

    def test_w06_owner_makes_invites_hashed_at_rest(self):
        r = self.owner.req("POST", "/api/invites", {"note": "  For  Sam ", "maxUses": 2})
        self.assertEqual(r.status, 201, r)
        code, inv = r.json["code"], r.json["invite"]
        self.assertRegex(code, r"^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$")
        self.assertEqual(inv, {"id": inv["id"], "last4": code[-4:], "created": inv["created"], "uses": 0, "maxUses": 2,
                               "note": "For Sam", "revoked": False})
        self.assertRegex(inv["id"], r"^iv_[0-9a-f]{12}$")
        listed = self.owner.req("GET", "/api/invites")
        self.assertEqual(listed.json["invites"], [inv])
        self.assertNotIn(code.encode(), listed.raw, "the code is shown once, when it is made")
        with open(os.path.join(self.data, "invites.json"), "rb") as f:
            raw = f.read()
        self.assertNotIn(code.encode(), raw)
        self.assertNotIn(code.lower().encode(), raw)
        self.assertEqual(list(json.loads(raw)), [hashlib.sha256(code.encode()).hexdigest()])
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.data, "invites.json")).st_mode), 0o600)
        default = self.owner.req("POST", "/api/invites", {})
        self.assertEqual((default.status, default.json["invite"]["maxUses"], default.json["invite"]["note"]), (201, 1, ""))
        self.assertEqual(self.owner.req("POST", "/api/invites/revoke", {"id": default.json["invite"]["id"]}).status, 200)
        for body, field in [({"maxUses": 0}, "maxUses"), ({"maxUses": 101}, "maxUses"), ({"maxUses": "2"}, "maxUses"),
                            ({"maxUses": True}, "maxUses"), ({"note": "x" * 81}, "note"), ({"note": 5}, "note")]:
            self.assertErr(self.owner.req("POST", "/api/invites", body), 400, "bad_request", field)
        T22_Hosted.code, T22_Hosted.invite_id = code, inv["id"]

    def test_w07_invites_are_used_up_and_revoked(self):
        code = self.code
        typed = code[:5].lower() + "-" + code[5:].lower()
        email, pw = H.account("member", "Hosting: invited member")
        r = self.member.signup(email, pw, name="Member", invite=typed)
        self.assertEqual(r.status, 201, r)
        T22_Hosted.member_pw = pw
        self.assertFalse(self.member.me().json["owner"])
        email2, pw2 = H.account("member2", "Hosting: second use of an invite")
        self.assertEqual(HostedClient().signup(email2, pw2, invite=code).status, 201)
        self.assertErr(HostedClient().signup(f"third-{RUN}@example.test", secrets.token_urlsafe(18), invite=code),
                       403, "invite_required", "invite")
        rows = {i["id"]: i for i in self.owner.req("GET", "/api/invites").json["invites"]}
        self.assertEqual(rows[self.invite_id]["uses"], 2)
        r = self.owner.req("POST", "/api/invites", {"note": "Revoke me"})
        code2, iid2 = r.json["code"], r.json["invite"]["id"]
        r = self.owner.req("POST", "/api/invites/revoke", {"id": iid2})
        self.assertEqual((r.status, r.json["invite"]["revoked"], r.json["invite"]["uses"]), (200, True, 0))
        self.assertEqual(self.owner.req("POST", "/api/invites/revoke", {"id": iid2}).status, 200, "again: no change")
        self.assertErr(HostedClient().signup(f"revoked-{RUN}@example.test", secrets.token_urlsafe(18), invite=code2),
                       403, "invite_required")
        self.assertErr(self.owner.req("POST", "/api/invites/revoke", {"id": "iv_000000000000"}), 404, "not_found")
        self.assertErr(self.owner.req("POST", "/api/invites/revoke", {"id": "../x"}), 404, "not_found")
        for method, path, body in [("GET", "/api/invites", None), ("POST", "/api/invites", {}),
                                   ("POST", "/api/invites/revoke", {"id": iid2})]:
            self.assertErr(self.member.req(method, path, body), 403, "owner_only")
            self.assertErr(HostedClient().req(method, path, body), 401, "not_signed_in")

    def test_w08_signed_in_profiles_write_as_before(self):
        m = self.member
        r = m.req("POST", "/api/notes/changes", {"set": {"43.3.16": {"text": "Member note", "updated": now_ms()}}}, scoped=True)
        self.assertEqual((r.status, r.json["changed"]), (200, 1), r)
        r = m.events([{"type": "chapter.open", "b": 43, "c": 3, "t": now_ms()}])
        self.assertEqual(r.status, 200, r)
        self.assertEqual(m.req("POST", "/api/library/bookmarks", {"ref": "43.3.16"}, scoped=True).status, 201)
        r = m.req("POST", "/api/profile/import-guest", {}, scoped=True)
        self.assertEqual((r.status, r.json["changed"], set(r.json["imported"].values())), (200, False, {0}),
                         "the shared guest store is never imported")

    def test_w09_esv_nlt_and_keys_are_the_owners(self):
        accounts.write_json_atomic(os.path.join(self.data, "config.json"), {"nltKey": "test-key"})
        accounts.write_json_atomic(os.path.join(self.data, "cache", "nlt", "43-3.json"),
                                   {"verses": ["v1", "v2"], "fetched": "2026-10-07", "v": 4})
        r = self.owner.req("GET", "/api/passage?tr=nlt&book=43&chapter=3")
        self.assertEqual((r.status, r.json["verses"]), (200, ["v1", "v2"]))
        self.assertEqual(self.owner.req("GET", "/api/config").json, {"esv": False, "nlt": True})
        for c in (self.member, HostedClient()):
            for tr in ("nlt", "esv"):
                r = c.req("GET", f"/api/passage?tr={tr}&book=43&chapter=3")
                self.assertErr(r, 403, "owner_only")
                self.assertEqual(r.json["message"], "ESV and NLT are available only to the owner of this site.")
            self.assertEqual(c.req("GET", "/api/config").json, {"esv": False, "nlt": False})
            self.assertErr(c.req("PUT", "/api/config", {"esvKey": "theirs"}), 403, "owner_only")
        self.assertEqual(read_json_file(os.path.join(self.data, "config.json")), {"nltKey": "test-key"})
        r = self.owner.req("PUT", "/api/config", {"esvKey": " owner-key "})
        self.assertEqual((r.status, r.json), (200, {"esv": True, "nlt": True}))
        self.assertEqual(read_json_file(os.path.join(self.data, "config.json"))["esvKey"], "owner-key")

    def test_w10_owner_emails_are_reserved(self):
        r = self.member.req("PATCH", "/api/account", {"email": self.owner2.upper(), "password": self.member_pw})
        self.assertErr(r, 409, "email_taken", "email")
        self.assertFalse(self.member.me().json["owner"])

    def test_w11_allowed_origins(self):
        body = {"set": {"1.1.1": {"text": "Origin test", "updated": now_ms()}}}
        ok = self.member.req("POST", "/api/notes/changes", body, scoped=True, headers={"Origin": "https://site.example.test"})
        self.assertEqual(ok.status, 200, ok)
        for origin, xfp in [("https://other.example.test", None), (f"https://127.0.0.1:{H.port}", "https")]:
            r = self.member.req("POST", "/api/notes/changes", body, scoped=True, headers={"Origin": origin, "X-Forwarded-Proto": xfp})
            self.assertErr(r, 403, "csrf")

    def test_w12_profile_import_when_hosted(self):
        t = now_ms() - 60000
        r = self.member.req("POST", "/api/profile/import", {"format": "bible-study-profile", "version": 1,
                            "notes": {"refs": {"19.23.1": {"text": "Imported", "created": t, "updated": t}}}}, scoped=True)
        self.assertEqual((r.status, r.json["imported"]["notes"], r.json["changed"]), (200, 1, True), r)

    def test_w13_sign_out_clears_a_secure_cookie(self):
        r = self.member.req("POST", "/api/auth/logout", {})
        self.assertEqual(r.status, 200)
        ck = r.set_cookies()[0]
        self.assertIn("Max-Age=0", ck)
        self.assertIn("Secure", ck)

    def test_w99_without_trust_proxy_forwarded_for_is_ignored(self):
        """One sign-up window for every client behind the proxy: a made-up X-Forwarded-For does not get a fresh one."""
        statuses = []
        for i in range(12):
            r = HostedClient(ip=f"203.0.113.{i + 1}").signup(f"xff-{RUN}@example.test", secrets.token_urlsafe(18), invite="ABCDEFGHJK")
            statuses.append(r.status)
            if r.status == 429:
                break
        self.assertEqual(statuses[-1], 429, statuses)


class T23_TrustProxy(Base):
    """BS_HOSTED=1 BS_TRUST_PROXY=1: the client address is the first X-Forwarded-For hop, the scheme X-Forwarded-Proto."""
    restart = False

    @classmethod
    def setUpClass(cls):
        H.restart("--data-dir", os.path.join(H.tmp, "proxy-data"), env={"BS_HOSTED": "1", "BS_TRUST_PROXY": "1"})

    @classmethod
    def tearDownClass(cls):
        H.restart()

    def attempt(self, ip, i, email=None):
        email = email or f"proxy{i}-{RUN}@example.test"
        return HostedClient(ip=ip).signup(email, secrets.token_urlsafe(18), invite="ABCDEFGHJK")

    def test_x01_sign_up_window_per_client(self):
        """The window is per (address, email) on the site (QC 2): visitors behind one proxy address get their own."""
        one = f"proxy-one-{RUN}@example.test"
        for i in range(10):
            self.assertErr(self.attempt("203.0.113.5", i, one), 403, "invite_required")
        r = self.attempt("203.0.113.5", 10, one)
        self.assertErr(r, 429, "rate_limited")
        self.assertEqual(r.json["message"], "Too many attempts. Try again in about an hour.")
        self.assertErr(self.attempt("203.0.113.5", 11), 403, "invite_required")  # same address, another email: its own
        self.assertErr(self.attempt("203.0.113.6", 12, one), 403, "invite_required")  # another client: its own window
        self.assertErr(self.attempt("198.51.100.7, 203.0.113.5", 13, one), 403, "invite_required")  # the first hop counts
        self.assertErr(self.attempt("203.0.113.5, 198.51.100.7", 14, one), 429, "rate_limited")
        self.assertErr(self.attempt("not-an-ip", 15, one), 403, "invite_required")  # no usable hop: the socket's peer
        with open(H.log_path, encoding="utf-8", errors="replace") as f:
            log = f.read()
        self.assertRegex(log, r"invite-refused ip=203\.0\.113\.5")
        self.assertRegex(log, r"rate-limit uid=unknown ip=203\.0\.113\.5")

    def test_x02_forwarded_proto_is_the_pages_scheme(self):
        own = f"127.0.0.1:{H.port}"
        r = HostedClient().req("POST", "/api/auth/logout", {}, headers={"Origin": f"https://{own}", "X-Forwarded-Proto": "https"})
        self.assertEqual(r.status, 200, r)
        r = HostedClient().req("POST", "/api/auth/logout", {}, headers={"Origin": f"http://{own}", "X-Forwarded-Proto": "https"})
        self.assertErr(r, 403, "csrf")
        r = HostedClient().req("POST", "/api/auth/logout", {}, headers={"Origin": f"https://{own}"})
        self.assertErr(r, 403, "csrf")


class T24_ProfileImport(Base):
    """POST /api/profile/import (every mode): an export merged into the signed-in profile, idempotently."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        for who in ("ida", "ivan"):
            email, pw = H.account(who, "Profile import")
            c = Client()
            assert c.signup(email, pw, name=who.title()).status == 201
            S[who] = c

    def files(self, uid):
        out = {}
        for name in ("notes.json", "links.json", "marks.json", "library.json"):
            with open(os.path.join(H.data, "profiles", uid, name), "rb") as f:
                out[name] = f.read()
        return out

    def test_y01_import_merges_newer_wins_tombstones_hold(self):
        src, dst = S["ida"], S["ivan"]
        old, now = now_ms() - 100000, now_ms()
        note = lambda text, t: {"text": text, "highlight": "", "tags": [], "videos": [], "created": t, "updated": t}  # noqa: E731
        r = src.req("POST", "/api/notes/changes", {"set": {"43.3.16": note("Ida's", old), "1.1.1": note("Ida deleted here", old),
                                                           "19.23.1": note("Ida's psalm", old)}}, scoped=True)
        self.assertEqual(r.status, 200, r)
        lid, mid = "ln_" + secrets.token_hex(6), "mk_" + secrets.token_hex(6)
        self.assertEqual(src.req("POST", "/api/links/changes", {"set": {lid: {"id": lid, "from": "43.1.29", "to": "23.53.7",
                                                                              "type": "fulfils", "updated": old}}}, scoped=True).status, 200)
        self.assertEqual(src.req("POST", "/api/marks/changes", {"set": {mid: {
            "id": mid, "tr": "kjv", "start": "43.3.16", "so": 4, "end": "43.3.16", "eo": 27, "quote": "God so loved the world",
            "pre": "For ", "suf": ", that he gave", "color": "yellow", "note": "", "updated": old}}}, scoped=True).status, 200)
        self.assertEqual(src.req("POST", "/api/library/bookmarks", {"ref": "43.3.16", "label": "Ida"}, scoped=True).status, 201)
        self.assertEqual(src.req("POST", "/api/library/chapters", {"b": 43, "c": 3, "read": True}, scoped=True).status, 200)
        export = src.req("GET", "/api/export/profile").json
        r = dst.req("POST", "/api/notes/changes", {"set": {"43.3.16": note("Ivan's, newer", now), "1.1.1": note("Gone", old)}}, scoped=True)
        self.assertEqual(r.status, 200, r)
        self.assertEqual(dst.req("POST", "/api/notes/changes", {"del": {"1.1.1": now}}, scoped=True).status, 200)
        acts_before = dst.library().json["activityTotal"]
        r = dst.req("POST", "/api/profile/import", export, scoped=True)
        self.assertEqual(r.status, 200, r)
        self.assertEqual((r.json["changed"], r.json["skipped"]), (True, 0))
        imp = r.json["imported"]
        self.assertEqual((imp["notes"], imp["links"], imp["marks"], imp["bookmarks"]), (1, 1, 1, 1))
        self.assertGreaterEqual(imp["chapters"], 1)
        refs = dst.req("GET", "/api/notes").json["refs"]
        self.assertEqual(refs["43.3.16"]["text"], "Ivan's, newer", "the newer note wins")
        self.assertNotIn("1.1.1", refs, "a later tombstone keeps it deleted")
        self.assertEqual(refs["19.23.1"]["text"], "Ida's psalm")
        self.assertIn(lid, dst.req("GET", "/api/links").json["links"])
        self.assertIn(mid, dst.req("GET", "/api/marks").json["marks"])
        lib = dst.library().json
        self.assertEqual([b["ref"] for b in lib["bookmarks"]], ["43.3.16"])
        self.assertTrue(lib["chapters"]["43.3"]["read"])
        rows = [a for a in lib["activity"] if a["type"] == "profile.import"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["x"], imp)
        self.assertGreater(lib["activityTotal"], acts_before)
        T24_ProfileImport.export = export

    def test_y02_second_import_changes_nothing(self):
        dst = S["ivan"]
        before, lib_before = self.files(dst.scope), dst.library().json
        r = dst.req("POST", "/api/profile/import", self.export, scoped=True)
        self.assertEqual(r.status, 200, r)
        self.assertEqual(r.json["changed"], False)
        self.assertEqual(set(r.json["imported"].values()), {0})
        self.assertEqual(r.json["rev"]["library"], lib_before["rev"])
        self.assertEqual(self.files(dst.scope), before, "not one byte changed")
        self.assertEqual(dst.library().json["activityTotal"], lib_before["activityTotal"], "no second profile.import row")

    def test_y03_validation(self):
        dst, ok = S["ivan"], {"format": "bible-study-profile", "version": 1}
        self.assertErr(Client().req("POST", "/api/profile/import", ok, scoped=True), 401, "not_signed_in")
        self.assertErr(dst.req("POST", "/api/profile/import", ok), 400, "scope_required")
        self.assertErr(dst.req("POST", "/api/profile/import", ok, headers={"X-BS-Scope": "guest"}), 409, "scope_mismatch")
        self.assertErr(dst.req("POST", "/api/profile/import", ok, scoped=True, headers={"Origin": "https://evil.example.test"}), 403, "csrf")
        for bad in ({}, {"format": "other", "version": 1}, {"format": "bible-study-profile", "version": 2},
                    {"format": "bible-study-profile", "version": True}, dict(ok, notes=[]), dict(ok, notes={"refs": []}),
                    dict(ok, links={"links": "x"}), dict(ok, marks=7), dict(ok, library=[])):
            r = dst.req("POST", "/api/profile/import", bad, scoped=True)
            self.assertErr(r, 400, "invalid_import")
            self.assertEqual(r.json["message"], "That file isn’t a Bible study profile export.")
        r = dst.req("POST", "/api/profile/import", dict(ok, notes={"refs": {"99.1.1": {"text": "x", "updated": 1},
                                                                           "43.3.17": {"text": 5, "updated": 1}}},
                                                       links={"links": {"ln_bad": {"id": "ln_bad"}}}), scoped=True)
        self.assertEqual((r.status, r.json["skipped"], r.json["changed"]), (200, 3, False), r)
        self.assertNotIn("99.1.1", dst.req("GET", "/api/notes").json["refs"])
        status, _, body = raw_req("POST", "/api/profile/import", headers={"Content-Type": "application/json",
                                                                           "Cookie": f"{H.cookie}={dst.token()}",
                                                                           "Content-Length": str(25 * 1024 * 1024 + 1)})
        self.assertEqual(status, 413, body[:200])
        status, _, body = raw_req("POST", "/api/profile/import", headers={"Content-Type": "application/json",
                                                                           "Content-Length": str(25 * 1024 * 1024 + 1)})
        self.assertEqual((status, json.loads(body)["error"]), (401, "not_signed_in"), "no profile: refused before the size")
        r = dst.req("POST", "/api/profile/import", dict(ok, notes={"refs": {"20.1.1": {"text": "No time"}}}), scoped=True)
        self.assertEqual((r.status, r.json["imported"]["notes"]), (200, 1), "a record without times still imports")
        r = dst.req("POST", "/api/profile/import", dict(ok, notes={"refs": {"20.1.1": {"text": "No time"}}}), scoped=True)
        self.assertEqual(r.json["changed"], False, "and only once")


class T25_Release1Fixes(Base):
    """Release 1 QC fixes (.design/release1-fixes-brief.md, Server group): owner claims, bodies read only after the auth
    check, the visitor's address behind two proxies, per-visitor windows, per-client lockouts, a real health probe, the
    purge on delete, readable waits, site wording, log severity and the refused Origin."""
    restart = False
    secret, setup_token = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    vercel_headers = {"X-Vercel-Forwarded-For": "203.0.113.77", "X-Real-IP": "203.0.113.77", "X-Forwarded-For": "13.57.253.50"}

    @classmethod
    def setUpClass(cls):
        cls.data = os.path.join(H.tmp, "r1-data")
        cls.owner_email, cls.owner_pw = H.account("owner-r1", "Release 1: owner")
        cls.owner2_email = f"owner-r1b-{RUN}@example.test"  # a second owner address, claimed by an email change
        cls.hosted_env = {"BS_HOSTED": "1", "BS_TRUST_PROXY": "1", "BS_PROXY_SECRET": cls.secret,
                          "BS_OWNER_SETUP_TOKEN": cls.setup_token, "BS_OWNER_EMAILS": f"{cls.owner_email}, {cls.owner2_email}",
                          "BS_ALLOWED_ORIGINS": "https://site.example.test"}
        H.restart("--data-dir", cls.data, env=cls.hosted_env)
        cls.owner = HostedClient(ip="203.0.113.1")

    @classmethod
    def tearDownClass(cls):
        H.restart()

    def log(self):
        with open(H.log_path, encoding="utf-8", errors="replace") as f:
            return f.read()

    def users(self):
        return read_json_file(os.path.join(self.data, "users.json"))["users"]

    def claims(self):
        return read_json_file(os.path.join(self.data, "owner-claims.json"))

    @staticmethod
    def keep(email, pw, purpose):
        entry = {"email": email, "password": pw, "purpose": purpose}
        H.accounts.append(entry)
        H.passwords.add(pw)
        record_accounts(ACCOUNTS_FILE, [entry])

    def test_r01_an_owner_email_is_claimed_once(self):
        r = self.owner.signup(self.owner_email, self.owner_pw, name="Owner")
        self.assertEqual(r.status, 201, r)
        T25_Release1Fixes.owner_uid = uid = r.json["user"]["uid"]
        claims = self.claims()
        self.assertEqual(list(claims), [accounts.claim_key(self.owner_email)])
        self.assertEqual(claims[accounts.claim_key(self.owner_email)]["uid"], uid)
        with open(os.path.join(self.data, "owner-claims.json"), "rb") as f:
            self.assertNotIn(b"@example.test", f.read(), "no plain email at rest")
        # The profile cannot drop its owner rights by moving to an address that is not an owner's.
        r = self.owner.req("PATCH", "/api/account", {"email": f"owner-moved-{RUN}@example.test", "password": self.owner_pw})
        self.assertErr(r, 409, "owner_email", "email")
        self.assertIn("BS_OWNER_EMAILS", r.json["message"])
        self.assertTrue(self.owner.me().json["owner"])
        # Another owner address is fine, and is claimed too.
        r = self.owner.req("PATCH", "/api/account", {"email": self.owner2_email.upper(), "password": self.owner_pw})
        self.assertEqual(r.status, 200, r)
        H.update_account(self.owner_email, email=self.owner2_email)
        self.assertTrue(self.owner.me().json["owner"])
        self.assertEqual(set(self.claims()), {accounts.claim_key(self.owner_email), accounts.claim_key(self.owner2_email)})
        # The first address is free in users.json but claimed: a stranger needs an invite like anyone else...
        stranger = HostedClient(ip="198.51.100.9")
        self.assertErr(stranger.signup(self.owner_email, secrets.token_urlsafe(18)), 403, "invite_required", "invite")
        self.assertErr(stranger.signup(self.owner_email, secrets.token_urlsafe(18), invite="ABCDEFGHJK"), 403, "invite_required", "invite")
        # ...while the owner comes back with the setup token.
        back, pw = HostedClient(ip="203.0.113.2"), secrets.token_urlsafe(18)
        body = {"email": self.owner_email, "name": "Owner again", "password": pw, "setupToken": "wrong-" + self.setup_token}
        self.assertErr(back.req("POST", "/api/auth/signup", body), 403, "invite_required", "invite")
        body["setupToken"] = self.setup_token
        r = back.req("POST", "/api/auth/signup", body)
        self.assertEqual(r.status, 201, r)
        back.scope = r.json["user"]["uid"]
        self.keep(self.owner_email, pw, "Release 1: owner re-claimed with the setup token")
        self.assertTrue(back.me().json["owner"])
        self.assertEqual(self.claims()[accounts.claim_key(self.owner_email)]["uid"], back.scope, "the claim follows the profile")
        T25_Release1Fixes.back, T25_Release1Fixes.back_pw = back, pw

    def test_r02_delete_erases_on_the_site_and_keeps_one_owner(self):
        back, uid = self.back, self.back.scope
        r = back.req("POST", "/api/invites", {"note": "Made by a profile that is then deleted"})
        self.assertEqual(r.status, 201, r)
        iid = r.json["invite"]["id"]
        r = back.req("POST", "/api/notes/changes", {"set": {"43.3.16": {"text": "Soon gone", "updated": now_ms()}}}, scoped=True)
        self.assertEqual(r.status, 200, r)
        self.assertTrue(os.path.isdir(os.path.join(self.data, "profiles", uid)))
        r = back.req("POST", "/api/account/delete", {"password": self.back_pw})
        self.assertEqual((r.status, r.json), (200, {"ok": True}), r)
        self.assertFalse(os.path.exists(os.path.join(self.data, "profiles", uid)), "erased, not moved aside")
        deleted = os.path.join(self.data, "deleted")
        self.assertFalse(os.path.isdir(deleted) and any(d.startswith(uid) for d in os.listdir(deleted)), "nothing kept")
        self.assertNotIn(uid, self.users())
        with open(os.path.join(self.data, "sessions.json"), "rb") as f:
            self.assertNotIn(uid.encode(), f.read(), "no session left")
        invites = read_json_file(os.path.join(self.data, "invites.json"))
        self.assertEqual([i["by"] for i in invites.values() if i["id"] == iid], [None], "the invite no longer names who made it")
        self.assertFalse(back.me().json["signedIn"])
        self.assertIn(f"account-delete uid={uid}", self.log())
        # The claim stays, so the address still needs an invite or the setup token.
        self.assertErr(HostedClient(ip="198.51.100.10").signup(self.owner_email, secrets.token_urlsafe(18)), 403, "invite_required")
        # The remaining owner is the last one: that profile cannot be deleted.
        r = self.owner.req("POST", "/api/account/delete", {"password": self.owner_pw})
        self.assertErr(r, 409, "last_owner")
        self.assertEqual(r.json["message"], "This is the site owner’s profile. Add another owner email first.")
        self.assertTrue(self.owner.me().json["signedIn"])
        self.assertTrue(os.path.isdir(os.path.join(self.data, "profiles", self.owner_uid)))

    def test_r03_guest_bodies_are_refused_before_they_are_read(self):
        g = HostedClient(ip="198.51.100.20")
        bad = b"{" + b"x" * 1024  # not JSON: a server that parsed it would say 400
        self.assertErr(g.req("POST", "/api/profile/import", raw=bad, scoped=True), 401, "not_signed_in")
        self.assertErr(g.req("POST", "/api/profile/import", raw=b"{" + b"x" * (2 * 1024 * 1024), scoped=True), 401, "not_signed_in")
        self.assertErr(g.req("POST", "/api/notes/changes", raw=bad, scoped=True), 401, "sign_in_required")
        self.assertErr(g.req("POST", "/api/notes/changes", raw=bad, scoped=True, headers={"Content-Type": "text/plain"}),
                       401, "sign_in_required")
        self.assertErr(g.req("PATCH", "/api/account", raw=bad), 401, "not_signed_in")
        self.assertErr(g.req("POST", "/api/notes/changes", raw=bad, scoped=True, headers={"Origin": "https://evil.example.test"}),
                       403, "csrf")  # the Origin check still comes first
        self.assertRegex(self.log(), r"csrf-block path=/api/notes/changes reason=origin origin=https://evil\.example\.test")

    def test_r04_the_visitor_address_behind_vercel_needs_the_secret(self):
        def refused(i, headers):
            body = {"email": f"viaproxy{i}-{RUN}@example.test", "name": "Via", "password": secrets.token_urlsafe(18), "invite": "ABCDEFGHJK"}
            self.assertErr(HostedClient().req("POST", "/api/auth/signup", body, headers=headers), 403, "invite_required")
        # Straight to the API host (no secret): X-Forwarded-For, which the host's own proxy wrote, is the client.
        refused(1, self.vercel_headers)
        self.assertRegex(self.log(), r"invite-refused ip=13\.57\.253\.50")
        self.assertNotRegex(self.log(), r"ip=203\.0\.113\.77")
        # Through Vercel, proved by the secret: Vercel's own header names the visitor.
        refused(2, dict(self.vercel_headers, **{"X-BS-Proxy-Secret": self.secret}))
        self.assertRegex(self.log(), r"invite-refused ip=203\.0\.113\.77")
        # A wrong secret is no proof.
        refused(3, {"X-Vercel-Forwarded-For": "203.0.113.78", "X-Forwarded-For": "13.57.253.51", "X-BS-Proxy-Secret": self.secret[:-1] + "x"})
        self.assertRegex(self.log(), r"invite-refused ip=13\.57\.253\.51")
        self.assertNotRegex(self.log(), r"ip=203\.0\.113\.78")
        # Without X-Vercel-Forwarded-For, X-Real-IP; without either, X-Forwarded-For.
        refused(4, {"X-Real-IP": "203.0.113.79", "X-Forwarded-For": "13.57.253.52", "X-BS-Proxy-Secret": self.secret})
        self.assertRegex(self.log(), r"invite-refused ip=203\.0\.113\.79")
        refused(5, {"X-Forwarded-For": "13.57.253.53", "X-BS-Proxy-Secret": self.secret})
        self.assertRegex(self.log(), r"invite-refused ip=13\.57\.253\.53")

    def test_r05_windows_are_per_visitor_and_waits_are_readable(self):
        one = f"window-one-{RUN}@example.test"
        a, b = HostedClient(ip="203.0.113.40"), HostedClient(ip="203.0.113.41")
        for _ in range(10):
            self.assertErr(a.signup(one, secrets.token_urlsafe(18), invite="ABCDEFGHJK"), 403, "invite_required")
        r = a.signup(one, secrets.token_urlsafe(18), invite="ABCDEFGHJK")
        self.assertErr(r, 429, "rate_limited")
        self.assertEqual(r.json["message"], "Too many attempts. Try again in about an hour.")
        self.assertEqual(r.json["retryAfter"], int(r.headers["Retry-After"]))
        self.assertGreater(r.json["retryAfter"], 3500)
        self.assertErr(a.signup(f"window-two-{RUN}@example.test", secrets.token_urlsafe(18), invite="ABCDEFGHJK"), 403, "invite_required")
        self.assertErr(b.signup(one, secrets.token_urlsafe(18), invite="ABCDEFGHJK"), 403, "invite_required")
        self.assertRegex(self.log(), r"rate-limit uid=unknown ip=203\.0\.113\.40")
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", ResourceWarning)
            import serve  # noqa: E402
        self.assertEqual([serve.wait_text(s) for s in (0, 1, 2, 59, 60, 61, 120, 900, 3594, 3600, 3601, 7200)],
                         ["1 second", "1 second", "2 seconds", "59 seconds", "about 1 minute", "about 2 minutes",
                          "about 2 minutes", "about 15 minutes", "about an hour", "about an hour", "about 2 hours", "about 2 hours"])

    def test_r06_a_lockout_is_per_client_and_forgets_after_a_day(self):
        code = self.owner.req("POST", "/api/invites", {"note": "Lockout test"}).json["code"]
        email, pw = H.account("member-r1", "Release 1: member locked by a stranger")
        member = HostedClient(ip="203.0.113.50")
        self.assertEqual(member.signup(email, pw, name="Member", invite=code).status, 201)
        uid = member.scope
        stranger = HostedClient(ip="198.51.100.60")
        for _ in range(5):
            self.assertErr(stranger.login(email, "nope-" + secrets.token_urlsafe(6)), 401, "bad_credentials")
        r = stranger.login(email, pw)
        self.assertErr(r, 429, "rate_limited")
        self.assertEqual((r.json["message"], r.json["retryAfter"]), ("Too many attempts. Try again in 1 second.", 1))
        u = self.users()[uid]
        self.assertEqual((u["failedLogins"], u["lockUntil"]), (5, 0), "counted, but the account itself is never locked")
        self.assertGreater(u["lastFail"], 0)
        self.assertRegex(self.log(), rf"lockout uid={uid} seconds=1 ip=198\.51\.100\.60")
        # The member signs in from another address at once.
        other = HostedClient(ip="203.0.113.51")
        self.assertEqual(other.login(email, pw).status, 200)
        u = self.users()[uid]
        self.assertEqual((u["failedLogins"], u["lockUntil"]), (0, 0))
        # A quiet day forgets old failures: 10 failures 25 hours ago, then one more, count as 1.
        path = os.path.join(self.data, "users.json")
        users = read_json_file(path)
        users["users"][uid].update(failedLogins=10, lastFail=now_ms() - 25 * 3600 * 1000)
        put_raw(path, json.dumps(users).encode("utf-8"))
        self.assertErr(HostedClient(ip="198.51.100.61").login(email, "nope-" + secrets.token_urlsafe(6)), 401, "bad_credentials")
        self.assertEqual(self.users()[uid]["failedLogins"], 1)
        # On the site a lock is at most a minute (configure_hosting lowers accounts.LOCK_MAX).
        old = accounts.LOCK_MAX
        try:
            accounts.LOCK_MAX = 60
            self.assertEqual([accounts.lock_seconds(f) for f in (4, 5, 10, 11, 12, 30)], [0, 1, 32, 60, 60, 60])
        finally:
            accounts.LOCK_MAX = old
        T25_Release1Fixes.member, T25_Release1Fixes.member_email, T25_Release1Fixes.member_pw = other, email, pw

    def test_r07_health_probes_the_data_directory(self):
        st, hdrs, body = raw_req("HEAD", "/api/health")
        self.assertEqual((st, body, hdrs.get("content-length")), (200, b"", "12"))
        self.assertEqual(HostedClient().req("GET", "/api/health").json, {"ok": True})
        self.assertEqual([n for n in os.listdir(self.data) if n.startswith(".health-")], [], "the probe file is removed")
        os.chmod(self.data, 0o500)
        try:
            for _ in range(70):  # a healthy verdict is reused for HEALTH_TTL (5 s): a burst of probes costs one fsync
                r = HostedClient().req("GET", "/api/health")
                if r.status != 200: break
                time.sleep(0.1)
            self.assertEqual((r.status, r.json), (503, {"ok": False}))
            self.assertEqual(raw_req("HEAD", "/api/health")[0], 503)
        finally:
            os.chmod(self.data, 0o700)
        self.assertRegex(self.log(), r"\[error\] \S+ health: cannot write to ")
        self.assertEqual(HostedClient().req("GET", "/api/health").json, {"ok": True}, "a problem is probed again at once")

    def test_r08_a_hosted_start_needs_the_volume(self):
        def run(args, env):
            return subprocess.run([PY, SERVE, "--port", str(free_port()), *args], capture_output=True, text=True, timeout=30,
                                  env=server_env(env))
        p = run([], {"BS_HOSTED": "1"})
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("BS_DATA_DIR", p.stderr)
        fake = os.path.join(H.tmp, "fake-volume")
        os.makedirs(fake, exist_ok=True)
        p = run(["--data-dir", os.path.join(H.tmp, "elsewhere")], {"BS_HOSTED": "1", "RAILWAY_VOLUME_MOUNT_PATH": fake})
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("not on the volume", p.stderr)
        self.assertFalse(os.path.exists(os.path.join(H.tmp, "elsewhere")), "nothing is created before the check")
        # under the mount path but not a mount point (a bind mount looks like that): starts, with a warning in the log
        port, d = free_port(), os.path.join(fake, "data")
        proc, _ = spawn_server({"BS_HOSTED": "1", "BS_DATA_DIR": d, "RAILWAY_VOLUME_MOUNT_PATH": fake,
                                "BS_OWNER_EMAILS": self.owner_email, "BS_ALLOWED_ORIGINS": "https://site.example.test"}, "--port", str(port))
        try:
            self.assertEqual(wait_health(port, proc), {"ok": True}, "a data dir under the mount path starts")
        finally:
            stop_proc(proc)
        port, d = free_port(), os.path.join(H.tmp, "on-a-real-mount")
        proc, _ = spawn_server({"BS_HOSTED": "1", "BS_DATA_DIR": d, "RAILWAY_VOLUME_MOUNT_PATH": "/",
                                "BS_OWNER_EMAILS": self.owner_email, "BS_ALLOWED_ORIGINS": "https://site.example.test"}, "--port", str(port))
        try:
            self.assertEqual(wait_health(port, proc), {"ok": True}, "a data dir on a real mount point starts")
        finally:
            stop_proc(proc)

    def test_r09_a_refused_large_body_still_gets_its_json_error(self):
        big = b'{"set": {"pad": "' + b"x" * (6 * 1024 * 1024) + b'"}}'
        # A wrong Origin: 403 csrf, the body read in full and the socket closed cleanly (a reset would become a proxy's 502).
        st, _, body = raw_req("POST", "/api/links/changes", big, {"Content-Type": "application/json", "X-BS-Scope": "guest",
                                                                 "Origin": "https://evil.example.test"})
        self.assertEqual((st, json.loads(body)["error"]), (403, "csrf"))
        # Too large for the route (1 MiB), from a signed-in member: 413 too_large.
        st, _, body = raw_req("POST", "/api/links/changes", big, {"Content-Type": "application/json", "X-BS-Scope": self.member.scope,
                                                                 "Cookie": f"{H.cookie}={self.member.tok}"})
        self.assertEqual((st, json.loads(body)["error"]), (413, "too_large"))

    def test_r10_site_wording(self):
        r = HostedClient(ip="198.51.100.70").login(f"nobody-{RUN}@example.test", "x" * 12)
        self.assertErr(r, 401, "bad_credentials")
        self.assertEqual(r.json["message"], "That email and password don’t match a profile on this site.")
        st, _, body = raw_req("GET", "/api/auth/me", headers={"Host": "evil.example.test"})
        self.assertEqual((st, json.loads(body)["message"]), (403, "This server doesn’t answer for that host name."))
        path = os.path.join(self.data, "users.json")
        with open(path, "rb") as f:
            good = f.read()
        put_raw(path, b"{not json")  # damaged: moved aside at the next read, and profiles are unavailable
        try:
            r = HostedClient(ip="198.51.100.71").login(self.member_email, self.member_pw)
            self.assertErr(r, 503, "registry_unavailable")
            self.assertEqual(r.json["message"], "Profiles are unavailable right now. Try again later.")
        finally:
            put_raw(path, good)
            for n in os.listdir(self.data):
                if n.startswith("users.json.corrupt-"):
                    os.unlink(os.path.join(self.data, n))
        self.assertEqual(HostedClient(ip="198.51.100.72").login(self.member_email, self.member_pw).status, 200)

    def test_r11_routine_lines_go_to_stdout(self):
        port, d = free_port(), os.path.join(H.tmp, f"severity-data-{RUN}")
        out, err = os.path.join(H.tmp, "severity-out.log"), os.path.join(H.tmp, "severity-err.log")
        with open(out, "wb") as fo, open(err, "wb") as fe:
            proc = subprocess.Popen([PY, SERVE, "--port", str(port), "--data-dir", d], stdout=fo, stderr=fe, stdin=subprocess.DEVNULL,
                                    env=server_env({"BS_HOSTED": "1", "BS_OWNER_EMAILS": self.owner_email,
                                                    "BS_ALLOWED_ORIGINS": "https://site.example.test"}))
        try:
            self.assertEqual(wait_health(port, proc), {"ok": True})
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            for path, body, origin, want in [("/api/auth/login", {"email": f"ghost-{RUN}@example.test", "password": "x" * 12}, None, 401),
                                             ("/api/auth/logout", {}, "https://evil.example.test", 403)]:
                hdrs = {"Content-Type": "application/json"}
                if origin:
                    hdrs["Origin"] = origin
                req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode("utf-8"), method="POST", headers=hdrs)
                try:
                    opener.open(req, timeout=10)
                    self.fail("expected an error")
                except urllib.error.HTTPError as e:
                    self.assertEqual(e.code, want)
        finally:
            stop_proc(proc)
        with open(out, encoding="utf-8", errors="replace") as f:
            so = f.read()
        with open(err, encoding="utf-8", errors="replace") as f:
            se = f.read()
        self.assertRegex(so, r"\[auth\] \S+ login-fail uid=unknown ip=127\.0\.0\.1")
        self.assertRegex(so, r"csrf-block path=/api/auth/logout reason=origin origin=https://evil\.example\.test")
        self.assertIn("POST /api/auth/login", so, "the access log")
        self.assertEqual(se.strip(), "", "nothing routine on stderr")

    def test_r12_vercel_alias_redirect_and_noindex(self):
        with open(os.path.join(REPO, "vercel.json"), encoding="utf-8") as f:
            v = json.load(f)
        alias = "bible-study-seven-blond.vercel.app"
        red = [r for r in v["redirects"] if any(h.get("type") == "host" and h.get("value") == alias for h in r.get("has", []))]
        self.assertEqual(len(red), 1)
        self.assertEqual((red[0]["source"], red[0]["destination"], red[0]["permanent"]),
                         ("/:path*", "https://www.biblelantern.com/:path*", True))
        noindex = [h for h in v["headers"] if any(c.get("type") == "host" for c in h.get("has", []))]
        self.assertEqual(len(noindex), 1)
        self.assertEqual(noindex[0]["headers"], [{"key": "X-Robots-Tag", "value": "noindex, nofollow"}])
        host_re = noindex[0]["has"][0]["value"]
        self.assertTrue(re.fullmatch(host_re, "bible-study-git-feature-x.vercel.app"), "previews too")
        self.assertTrue(re.fullmatch(host_re, alias))
        self.assertIsNone(re.fullmatch(host_re, "www.biblelantern.com"))
        with open(os.path.join(REPO, "railway.json"), encoding="utf-8") as f:
            rw = json.load(f)
        self.assertEqual((rw["deploy"]["healthcheckPath"], rw["deploy"]["restartPolicyType"]), ("/api/health", "ALWAYS"))

    def test_r13_export_file_name_takes_the_clients_day(self):
        def name(query):
            r = self.member.req("GET", "/api/export/profile" + query)
            self.assertEqual(r.status, 200, r)
            return re.search(r'filename="([^"]+)"', r.headers["Content-Disposition"]).group(1)
        self.assertEqual(name("?day=2026-01-02"), "bible-study-member-2026-01-02.json")
        today = time.strftime("%Y-%m-%d")
        for bad in ("?day=junk", "?day=2026-1-2", "?day=2026-01-02T00", "?day=", ""):
            self.assertEqual(name(bad), f"bible-study-member-{today}.json", bad)


class T99_Hygiene(Base):
    restart = False

    @classmethod
    def setUpClass(cls):
        H.stop()  # flush and close the log

    def test_j1_no_password_or_token_at_rest(self):
        self.assertGreater(len(H.passwords), 10)
        self.assertGreater(len(H.tokens), 10)
        with open(H.log_path, "rb") as f:
            blobs = {"server.log": f.read()}
        for root, _, files in os.walk(H.data):
            for fn in files:
                with open(os.path.join(root, fn), "rb") as f:
                    blobs[os.path.relpath(os.path.join(root, fn), H.data)] = f.read()
        for name, blob in blobs.items():
            leaked_pw = sum(1 for pw in H.passwords if pw.encode() in blob)
            leaked_tok = sum(1 for t in H.tokens if t.encode() in blob)
            self.assertEqual((leaked_pw, leaked_tok), (0, 0), f"secret found in {name}")
            self.assertFalse(".tmp-" in name, f"leftover temp file {name}")

    def test_j3_shared_accounts_file_kept(self):
        """Finding 11: this run's accounts were merged into the shared file; nobody else's entries were lost."""
        now = shared_account_emails()
        self.assertEqual(PRE_EXISTING_ACCOUNTS - now, set(), "entries other agents recorded are still there")
        self.assertEqual({a["email"] for a in H.accounts} - now, set())

    def test_j2_auth_log(self):
        with open(H.log_path, "rb") as f:
            log = f.read().decode("utf-8", "replace")
        self.assertRegex(log, r"\[auth\] \S+ login-fail uid=unknown")
        self.assertRegex(log, r"\[auth\] \S+ login-fail uid=u[0-9a-f]{16}")
        self.assertRegex(log, r"\[auth\] \S+ lockout uid=u[0-9a-f]{16}")
        self.assertRegex(log, r"\[auth\] \S+ csrf-block path=/api/config reason=origin")
        self.assertIn("account-delete uid=", log)
        self.assertNotIn("@example.test", log, "no email address is ever logged")
        self.assertNotIn("Traceback", log, "no unhandled server errors")


if __name__ == "__main__":
    unittest.main(verbosity=int(os.environ.get("BS_TEST_VERBOSITY", "1")) if "-v" not in sys.argv else 2)
