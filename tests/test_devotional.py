#!/usr/bin/env python3
"""
Unit tests for devotional.py: pure functions, no serve.py. Verse words are never typed here: the tests read them from
app/data/bibles/bsb/NN.json at run time and compare. The Claude and Resend calls go to a fake HTTP server on a free
port in 8870–8899 or to a fake urllib opener; the keys are made up.

  python3 tests/test_devotional.py
"""
import datetime, hashlib, http.server, json, os, re, shutil, socket, stat, sys, tempfile, threading, unittest, urllib.error
from zoneinfo import ZoneInfo

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
import devotional as D  # noqa: E402

LA = ZoneInfo("America/Los_Angeles")
WEEK = {"from": "2026-11-08", "to": "2026-11-14"}
SITE = "https://www.example.test"
FAKE_KEY = "sk-ant-test-0123456789abcdef"
FAKE_RESEND_KEY = "re_test_0123456789abcdef"
HEX32 = re.compile(r"\b[0-9a-f]{32}\b")


def ms(y, m, d, h=12, mi=0, tz=LA):
    return int(datetime.datetime(y, m, d, h, mi, tzinfo=tz).timestamp() * 1000)


def bsb(book):
    with open(os.path.join(REPO, "app", "data", "bibles", "bsb", f"{book:02d}.json"), encoding="utf-8") as f:
        return json.load(f)


def free_port():
    for port in range(8870, 8900):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("no free port in 8870–8899")


class FakeApi(http.server.BaseHTTPRequestHandler):
    """Answers whatever its `script` says, oldest first, and keeps every request (method, path, headers, body)."""
    script = []
    seen = []
    lock = threading.Lock()

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        with FakeApi.lock:
            FakeApi.seen.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
            status, payload, headers = FakeApi.script.pop(0) if FakeApi.script else (200, {}, {})
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


def fake_claude_reply(draft_obj, stop="end_turn"):
    return {"id": "msg_test", "type": "message", "role": "assistant", "stop_reason": stop,
            "content": [{"type": "text", "text": json.dumps(draft_obj)}]}


class FakeOpener:
    """A urllib opener stand-in: `script` is a list of (status, body_bytes, headers); status 0 means a network
    error; the calls are kept."""

    def __init__(self, script):
        self.script, self.calls = list(script), []

    def open(self, req, timeout=None):
        self.calls.append({"url": req.full_url, "headers": {k.lower(): v for k, v in req.header_items()},
                           "body": req.data})
        status, body, headers = self.script.pop(0) if self.script else (200, b"{}", {})
        if status == 0:
            raise urllib.error.URLError("down")
        if status >= 400:
            import email.message, io
            h = email.message.Message()
            for k, v in headers.items():
                h[k] = v
            raise urllib.error.HTTPError(req.full_url, status, "err", h, io.BytesIO(body))

        class R:
            def __init__(s):
                s.status = status

            def read(s, n=-1):
                return body

            def __enter__(s):
                return s

            def __exit__(s, *a):
                return False
        return R()


def write_fixture(d, now_in, now_out):
    """A profile with items inside and outside the week: notes.json, marks.json, links.json, library.json,
    memory.json. Offsets of the BSB mark are numbers only; the words are read back from the file."""
    j62 = bsb(62)
    text_1jn4_10 = j62["4"][9]
    notes = {"refs": {
        "43.3.16": {"text": "Loved <b>first</b> & then given. See [[Romans 5:8]].", "highlight": "", "tags": ["love"],
                    "videos": [], "created": now_in, "updated": now_in},
        "45.5.8": {"text": "While we were *still* sinners.", "highlight": "", "tags": [], "videos": [],
                   "created": now_in, "updated": now_in + 1000},
        "43.3": {"text": "A chapter note on John 3.", "highlight": "", "tags": [], "videos": [],
                 "created": now_in, "updated": now_in + 2000},
        "62.4.19": {"text": "Out of the window.", "highlight": "", "tags": [], "videos": [],
                    "created": now_out, "updated": now_out},
        "1.1.1": {"text": "", "highlight": "yellow", "tags": [], "videos": [], "created": now_in, "updated": now_in}},
        "studies": [{"id": "st_0123456789ab", "title": "Loved first", "intro": "The giving comes first.", "order": "studied",
                     "entries": [{"key": "43.3.16"}, {"key": "45.5.8"}], "created": now_in, "updated": now_in},
                    {"id": "st_0123456789ac", "title": "Old study", "intro": "", "order": "studied", "entries": [],
                     "created": now_out, "updated": now_out}],
        "themes": {"accepted": [], "renamed": {}, "merged": {}, "removed": []}, "rev": 3, "deleted": {}}
    marks = {"version": 1, "rev": 1, "marks": {
        "mk_0123456789ab": {"id": "mk_0123456789ab", "tr": "bsb", "start": "62.4.10", "so": 0, "end": "62.4.10",
                            "eo": min(40, len(text_1jn4_10)), "quote": text_1jn4_10[:min(40, len(text_1jn4_10))],
                            "pre": "", "suf": "", "color": "yellow", "note": "the direction matters",
                            "created": now_in, "updated": now_in},
        "mk_0123456789ac": {"id": "mk_0123456789ac", "tr": "esv", "start": "45.5.8", "so": 0, "end": "45.5.8", "eo": 5,
                            "quote": "x", "pre": "", "suf": "", "color": "yellow", "note": "",
                            "created": now_out, "updated": now_out}}, "deleted": {}}
    links = {"version": 1, "rev": 1, "links": {
        "ln_0123456789ab": {"id": "ln_0123456789ab", "from": "43.3.16", "to": "45.5.8", "type": "fulfils", "label": "",
                            "note": "the gift precedes the response", "color": "blue", "tags": [], "dir": "to",
                            "created": now_in, "updated": now_in},
        "ln_0123456789ac": {"id": "ln_0123456789ac", "from": "45.5.8", "to": "23.53.5", "type": "echoes", "label": "",
                            "note": "", "color": "blue", "tags": [], "dir": "to", "created": now_in + 5, "updated": now_in + 5},
        "ln_0123456789ad": {"id": "ln_0123456789ad", "from": "1.1.1", "to": "43.1.1", "type": "related", "label": "",
                            "note": "old", "color": "blue", "tags": [], "dir": "both", "created": now_out, "updated": now_in}},
        "deleted": {}}
    library = {"version": 1, "rev": 2, "created": now_out, "updated": now_in, "bookmarks": [], "lastPosition": None,
               "chapters": {"43.3": {"firstRead": now_out, "lastRead": now_in + 10, "visits": 4, "seconds": 900, "studied": [16],
                                     "read": True, "readAt": now_in, "manual": False, "manualAt": None},
                            "45.5": {"firstRead": now_in, "lastRead": now_in, "visits": 1, "seconds": 300, "studied": [],
                                     "read": False, "readAt": None, "manual": False, "manualAt": None},
                            "1.1": {"firstRead": now_out, "lastRead": now_out, "visits": 9, "seconds": 10, "studied": [],
                                    "read": True, "readAt": now_out, "manual": False, "manualAt": None}},
               "days": {"2026-11-10": {"s": 3600, "v": 2, "r": 1, "n": 2, "o": 3}, "2026-11-12": {"s": 1800, "v": 0, "r": 0, "n": 0, "o": 1},
                        "2026-11-07": {"s": 7200, "v": 0, "r": 0, "n": 0, "o": 0}},
               "activity": [{"t": now_in, "type": "chapter.open", "ref": "43.3"}, {"t": now_in + 1, "type": "xref.open", "ref": "45.5.8"},
                            {"t": now_out, "type": "chapter.open", "ref": "1.1"}],
               "appliedBatches": [], "imports": []}
    memory = {"version": 1, "rev": 1, "memory": {
        "mv_0123456789ab": {"id": "mv_0123456789ab", "ref": "62.4.19", "tr": "bsb", "pos": 0, "step": 0, "due": "", "heart": "",
                            "last": 0, "created": now_in, "updated": now_in}}, "deleted": {}}
    paths = {}
    for name, doc in (("notes", notes), ("marks", marks), ("links", links), ("library", library), ("memory", memory)):
        paths[name] = os.path.join(d, name + ".json")
        with open(paths[name], "w", encoding="utf-8") as f:
            json.dump(doc, f)
    return paths


def material_fixture(tmp):
    paths = write_fixture(tmp, ms(2026, 11, 10), ms(2026, 11, 7))
    return D.gather(paths, WEEK, "America/Los_Angeles")


def html_text(h):
    """The words of an email, tags gone and whitespace folded, so a verse split over two elements reads as one."""
    import html as _html
    return re.sub(r"\s+", " ", _html.unescape(re.sub(r"<[^>]+>", " ", h))).strip()


def issue_from(material, draft):
    issue = D.new_issue(WEEK, ms(2026, 11, 14, 6), "owner")
    issue["source"] = D.source_of(material)
    issue["draft"] = draft
    issue["material"] = D.keep_material(material)
    return issue


class T1_Weeks(unittest.TestCase):
    def test_week_for(self):
        self.assertEqual(D.week_for("2026-11-14"), WEEK)
        self.assertEqual(D.week_for(datetime.date(2026, 1, 3)), {"from": "2025-12-28", "to": "2026-01-03"})
        with self.assertRaises(ValueError):
            D.week_for("2026-13-01")

    def test_week_bounds_across_dst(self):
        hour = 3600 * 1000
        a, b = D.week_bounds_ms(WEEK, "America/Los_Angeles")
        self.assertEqual(b - a, 168 * hour)
        self.assertEqual(a, ms(2026, 11, 8, 0))
        a, b = D.week_bounds_ms({"from": "2026-10-26", "to": "2026-11-01"}, LA)  # DST ends 1 November 2026
        self.assertEqual(b - a, 169 * hour)
        a, b = D.week_bounds_ms({"from": "2026-03-02", "to": "2026-03-08"}, LA)  # DST starts 8 March 2026
        self.assertEqual(b - a, 167 * hour)
        self.assertEqual(datetime.datetime.fromtimestamp(b / 1000, LA).strftime("%Y-%m-%d %H:%M"), "2026-03-09 00:00")

    def test_week_label(self):
        self.assertEqual(D.week_label(WEEK), "8–14 November 2026")
        self.assertEqual(D.week_label({"from": "2026-10-26", "to": "2026-11-01"}), "26 October–1 November 2026")
        self.assertEqual(D.week_label({"from": "2025-12-28", "to": "2026-01-03"}), "28 December 2025–3 January 2026")

    def test_get_tz(self):
        self.assertIsNotNone(D.get_tz("Europe/London"))
        self.assertIsNone(D.get_tz("Mars/Olympus"))
        self.assertIsNone(D.get_tz(""))


class T2_Schedule(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(D.parse_schedule("sat 06:00"), ("at", 5, 6, 0))
        self.assertEqual(D.parse_schedule(" SUN 7:30 "), ("at", 6, 7, 30))
        self.assertEqual(D.parse_schedule("off"), ("off",))
        self.assertEqual(D.parse_schedule("Now"), ("now",))
        for bad in ("sat 25:00", "saturday 06:00", "sat", "", None, "sat 06:60", 7):
            self.assertIsNone(D.parse_schedule(bad), bad)

    def test_next_and_last_across_dst(self):
        now = ms(2026, 10, 31, 12)  # Saturday noon PDT; clocks go back at 02:00 on Sunday 1 November
        nxt = D.next_moment(D.parse_schedule("sun 07:00"), now, LA)
        self.assertEqual(nxt - now, 20 * 3600 * 1000)  # 19 hours on the wall clock plus the repeated hour
        self.assertEqual(datetime.datetime.fromtimestamp(nxt / 1000, LA).strftime("%a %H:%M %Z"), "Sun 07:00 PST")
        last = D.last_moment(D.parse_schedule("sat 06:00"), now, LA)
        self.assertEqual(datetime.datetime.fromtimestamp(last / 1000, LA).strftime("%Y-%m-%d %H:%M %Z"), "2026-10-31 06:00 PDT")
        nxt_sat = D.next_moment(D.parse_schedule("sat 06:00"), now, LA)
        self.assertEqual(datetime.datetime.fromtimestamp(nxt_sat / 1000, LA).strftime("%Y-%m-%d %H:%M %Z"), "2026-11-07 06:00 PST")
        self.assertEqual(nxt_sat - last, (7 * 24 + 1) * 3600 * 1000)
        at = ms(2026, 10, 31, 6)  # exactly at the moment: it is the last one and not the next one
        self.assertEqual(D.last_moment(("at", 5, 6, 0), at, LA), at)
        self.assertGreater(D.next_moment(("at", 5, 6, 0), at, LA), at)
        self.assertEqual(D.next_moment(("now",), now, LA), now)
        self.assertIsNone(D.next_moment(("off",), now, LA))
        self.assertIsNone(D.last_moment(("now",), now, LA))
        self.assertIsNone(D.next_moment(None, now, LA))

    def test_text(self):
        self.assertEqual(D.schedule_text(("at", 5, 6, 0)), "Saturdays 06:00")
        self.assertEqual(D.schedule_text(("off",)), "off")
        self.assertEqual(D.schedule_text(("now",)), "on approval")


class T3_Subscribers(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="devo-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_tokens_hashed_and_rotated(self):
        rec, raw = D.new_subscriber("A@Example.test", 1000, "page")
        self.assertEqual(rec["email"], "a@example.test")
        self.assertEqual(rec["status"], "pending")
        self.assertNotEqual(rec["token"], raw)
        self.assertEqual(rec["token"], hashlib.sha256(raw.encode()).hexdigest())
        self.assertNotIn(raw, json.dumps(rec))
        doc = D.empty_subscribers()
        doc["subs"]["sb_000000000001"] = rec
        self.assertEqual(D.find_by_token(doc, raw)[0], "sb_000000000001")
        self.assertEqual(D.find_subscriber(doc, "a@example.test")[0], "sb_000000000001")
        self.assertIsNone(D.find_by_token(doc, "nope"))
        self.assertIsNone(D.find_by_token(doc, raw.upper()))
        new_raw = D.confirm(rec, 2000)
        self.assertEqual(rec["status"], "confirmed")
        self.assertEqual(rec["confirmed"], 2000)
        self.assertIsNone(D.find_by_token(doc, raw))
        self.assertIsNotNone(D.find_by_token(doc, new_raw))
        D.unsubscribe(rec, 3000)
        self.assertEqual(rec["status"], "unsubscribed")
        self.assertIsNone(D.find_by_token(doc, new_raw))
        again = D.resubscribe(rec, 4000)
        self.assertEqual(rec["status"], "pending")
        self.assertIsNone(rec["confirmed"])
        self.assertEqual(D.find_by_token(doc, again)[1], rec)

    def test_unsubscribe_token_is_stable_and_never_stored(self):
        """The unsubscribe capability in an issue is derived from the install secret and the subscriber id, so the
        link in every issue ever sent keeps working while the address is on the list, and nothing new is stored."""
        secret = D.unsub_secret(self.tmp)
        self.assertGreaterEqual(len(secret), 32)
        self.assertEqual(stat.S_IMODE(os.stat(D.secret_path(self.tmp)).st_mode), 0o600)
        self.assertEqual(D.unsub_secret(self.tmp), secret, "made once, read back after")
        other = D.unsub_secret(os.path.join(self.tmp, "other"))
        self.assertNotEqual(other, secret)
        doc = D.empty_subscribers()
        for i in range(3):
            rec, _raw = D.new_subscriber(f"s{i}@example.test", 1000, "page")
            doc["subs"][f"sb_00000000000{i}"] = rec
        tok = D.unsub_token(secret, "sb_000000000001")
        self.assertTrue(re.fullmatch(r"[0-9a-f]{32}", tok))
        self.assertEqual(tok, D.unsub_token(secret, "sb_000000000001"), "the same every time")
        self.assertNotEqual(tok, D.unsub_token(secret, "sb_000000000002"))
        self.assertNotEqual(tok, D.unsub_token(other, "sb_000000000001"), "another install, another token")
        self.assertEqual(D.find_by_unsub_token(doc, secret, tok)[0], "sb_000000000001")
        self.assertIsNone(D.find_by_unsub_token(doc, other, tok))
        self.assertIsNone(D.find_by_unsub_token(doc, secret, tok.upper()))
        self.assertIsNone(D.find_by_unsub_token(doc, secret, "nope"))
        self.assertIsNone(D.find_by_token(doc, tok), "it is not a confirmation token")
        rec = doc["subs"]["sb_000000000001"]
        D.confirm(rec, 2000)
        D.rotate_token(rec)
        self.assertEqual(D.find_by_unsub_token(doc, secret, tok)[0], "sb_000000000001", "rotation does not touch it")
        self.assertNotIn(tok, json.dumps(doc))
        D.unsubscribe(rec, 3000)
        self.assertEqual(D.find_by_unsub_token(doc, secret, tok)[1]["status"], "unsubscribed", "a second click finds the same reader")

    def test_prune_counts_csv_files(self):
        doc = D.empty_subscribers()
        now = 100 * D.DAY_MS
        for i, (status, age) in enumerate((("pending", 8 * D.DAY_MS), ("pending", 2 * D.DAY_MS), ("confirmed", 30 * D.DAY_MS),
                                           ("unsubscribed", 30 * D.DAY_MS))):
            rec, _raw = D.new_subscriber(f"s{i}@example.test", now - age, "page")
            rec["status"] = status
            if status == "confirmed":
                rec["confirmed"] = now - age + 5
            doc["subs"][f"sb_00000000000{i}"] = rec
        self.assertEqual(D.prune_pending(doc, now), 1)
        self.assertNotIn("sb_000000000000", doc["subs"])
        self.assertEqual(D.count_by_status(doc), {"confirmed": 1, "pending": 1, "unsubscribed": 1})
        self.assertEqual([s for s, _r in D.confirmed(doc)], ["sb_000000000002"])
        csv = D.subscribers_csv(doc)
        self.assertEqual(csv.splitlines()[0], "email,status,created,confirmed")
        self.assertIn("s2@example.test", csv)
        self.assertNotIn("s1@example.test", csv)
        D.save_subscribers(self.tmp, doc)
        self.assertEqual(stat.S_IMODE(os.stat(D.devo_dir(self.tmp)).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(D.subscribers_path(self.tmp)).st_mode), 0o600)
        self.assertEqual(D.load_subscribers(self.tmp), doc)
        self.assertEqual(D.load_subscribers(os.path.join(self.tmp, "none")), D.empty_subscribers())

    def test_issue_files(self):
        issue = D.new_issue(WEEK, 5, "schedule")
        self.assertEqual(issue["id"], "2026-11-14")
        self.assertEqual(issue["status"], "draft")
        issue["review"]["tokenHash"] = "h" * 64
        D.save_issue(self.tmp, issue)
        older = D.new_issue(D.week_for("2026-11-07"), 4, "schedule")
        D.save_issue(self.tmp, older)
        self.assertEqual([i["id"] for i in D.list_issues(self.tmp)], ["2026-11-14", "2026-11-07"])
        self.assertEqual([i["id"] for i in D.list_issues(self.tmp, limit=1)], ["2026-11-14"])
        self.assertEqual(D.load_issue(self.tmp, "2026-11-14"), issue)
        self.assertIsNone(D.load_issue(self.tmp, "2026-11-21"))
        with self.assertRaises(ValueError):
            D.issue_path(self.tmp, "../x")
        pub = D.public_issue(issue)
        self.assertNotIn("tokenHash", json.dumps(pub))
        self.assertEqual(D.issue_row(issue)["status"], "draft")
        self.assertEqual(D.list_issues(os.path.join(self.tmp, "none")), [])


class T4_Gather(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="devo-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_in_window_items_only(self):
        paths = write_fixture(self.tmp, ms(2026, 11, 10), ms(2026, 11, 7))
        before = {k: os.stat(p).st_mtime_ns for k, p in paths.items()}
        m = D.gather(paths, WEEK, "America/Los_Angeles")
        self.assertEqual({k: os.stat(p).st_mtime_ns for k, p in paths.items()}, before)  # read-only
        src = D.source_of(m)
        self.assertEqual(src["notes"], ["43.3", "43.3.16", "45.5.8"])  # Bible order; the empty and the old one left out
        self.assertEqual(src["marks"], ["mk_0123456789ab"])
        self.assertEqual(src["links"], ["ln_0123456789ab", "ln_0123456789ac"])
        self.assertEqual(src["studies"], ["st_0123456789ab"])
        self.assertEqual(src["chapters"], ["45.5", "43.3"])  # by lastRead
        self.assertEqual(src["counts"], {"notes": 3, "marks": 1, "links": 2, "studies": 1, "chapters": 2, "minutes": 90})
        self.assertEqual(m["activity"], {"chapter.open": 1, "xref.open": 1})
        self.assertEqual([v["ref"] for v in m["memory"]], ["62.4.19"])
        mark = m["marks"][0]
        text = bsb(62)["4"][9]
        self.assertEqual(mark["words"], re.sub(r"\s+", " ", text[:min(40, len(text))]).strip())
        self.assertEqual(mark["label"], "1 John 4:10")
        self.assertEqual(mark["note"], "the direction matters")
        ln = m["links"][0]
        self.assertEqual((ln["fromLabel"], ln["toLabel"], ln["phrase"]), ("John 3:16", "Romans 5:8", "fulfils"))
        self.assertEqual(m["notes"][1]["label"], "John 3:16")
        self.assertEqual(m["notes"][0]["label"], "John 3")
        self.assertEqual(D.material_chapters(m), [(43, 3), (45, 5), (62, 4)])
        self.assertFalse(D.is_empty(m))
        verses, _strings = D.allowed_refs(m)
        self.assertEqual(verses, {"43.3.16", "45.5.8", "23.53.5", "62.4.10", "62.4.19"})

    def test_missing_files_and_boundaries(self):
        empty = D.gather({k: os.path.join(self.tmp, k + ".json") for k in ("notes", "marks", "links", "library", "memory")},
                         WEEK, "America/Los_Angeles")
        self.assertTrue(D.is_empty(empty))
        self.assertEqual(empty["counts"]["minutes"], 0)
        start, end = D.week_bounds_ms(WEEK, LA)
        paths = write_fixture(self.tmp, start, end)  # at the first instant: in; at the end instant: out
        m = D.gather(paths, WEEK, LA)
        self.assertIn("43.3.16", D.source_of(m)["notes"])
        self.assertNotIn("62.4.19", D.source_of(m)["notes"])
        paths = write_fixture(self.tmp, end - 1, start - 1)
        m = D.gather(paths, WEEK, LA)
        self.assertIn("43.3.16", D.source_of(m)["notes"])
        self.assertNotIn("62.4.19", D.source_of(m)["notes"])


class T5_Draft(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="devo-")
        self.m = material_fixture(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_deterministic(self):
        d = D.deterministic_draft(self.m)
        self.assertEqual(d["subject"], "Weekly devotional · 14 November")
        self.assertEqual(d["title"], "Loved first")
        self.assertEqual(d["opening"], "A chapter note on John 3.")  # the chapter note is the overview, lifted out
        self.assertEqual([s["heading"] for s in d["sections"]], ["John 3", "Romans 5", "1 John 4"])
        s0, s1, s2 = d["sections"]
        self.assertEqual(s0["refs"], ["43.3.16"])
        self.assertNotIn("A chapter note on John 3.", s0["body"])
        self.assertIn("Loved <b>first</b> & then given.", s0["body"])
        self.assertIn("→ Romans 5:8 · fulfils · the gift precedes the response", s0["body"])
        self.assertEqual(s1["refs"], ["45.5.8"])
        self.assertIn("→ Isaiah 53:5 · echoes", s1["body"])
        self.assertEqual(s2["refs"], ["62.4.10"])
        self.assertEqual(len(s2["quotes"]), 1)
        self.assertTrue(s2["quotes"][0].startswith("1 John 4:10 · “") and s2["quotes"][0].endswith("” · the direction matters"))
        self.assertEqual(d["closing"], "The giving comes first.")
        self.assertEqual(d["question"], "")
        self.assertFalse(d["stitched"])
        self.assertEqual(d["warnings"], [])

    def test_deterministic_titles(self):
        m = dict(self.m, studies=[])
        self.assertEqual(D.deterministic_draft(m)["title"], "John 3")  # the most visited chapter
        m = dict(m, chapters=[])
        self.assertEqual(D.deterministic_draft(m)["title"], "John 3")  # the first chapter written in
        m = dict(m, notes=[], marks=[], links=[])
        d = D.deterministic_draft(m)
        self.assertEqual(d["title"], "This week")
        self.assertEqual(d["sections"], [])
        self.assertEqual(d["opening"], "")  # no chapter note: the counts under the title say what the week held

    def test_validate_draft(self):
        words = self.m["marks"][0]["words"]  # the week's one highlight: BSB words of 1 John 4:10, read from the file
        good = {"subject": "S", "title": "Loved <em>first</em> <b>x</b>", "opening": "O", "closing": "C", "question": "Q?",
                "sections": [{"heading": "H", "refs": ["43.3.16", "1.1.1", "45.5.8-9", "45.5.8", "43.3.16", "bad"],
                              "body": "B", "quotes": [words[:15], f"John 3:16 · “{words[5:25].upper()}” · the model's comment",
                                                      "q", "John 3:16 · “words the model made up about the world”", 3, ""]}]}
        d = D.validate_draft(good, self.m)
        self.assertEqual(d["title"], "Loved <em>first</em> x")
        self.assertEqual(d["sections"][0]["refs"], ["43.3.16", "45.5.8"])  # a range past the material is dropped
        # a quote is kept only when its words are the reader's highlighted words, and it carries the highlight's own
        # reference, never one the model attached; made-up words under a reference are dropped
        self.assertEqual(d["sections"][0]["quotes"], [f"1 John 4:10 · “{words[:15]}”",
                                                      f"1 John 4:10 · “{words[5:25].upper()}” · the model's comment"])
        self.assertEqual(len(d["warnings"]), 2)
        self.assertIn("3 reference", d["warnings"][0])
        self.assertIn("2 quote", d["warnings"][1])
        issue = issue_from(self.m, dict(d, stitched=True, model="x"))
        h, _t = D.render(issue, SITE)
        self.assertNotIn("made up about the world", h)
        self.assertNotIn("My highlight · John 3:16", h, "no reference over words the model wrote")
        self.assertIn("My highlight · 1 John 4:10", h)
        self.assertEqual(D.validate_draft(dict(good, sections=[dict(good["sections"][0], quotes=["q"])]), self.m)["warnings"],
                         ["3 reference(s) not in the week's material were dropped", "1 quote(s) not among the week's highlights were dropped"])
        self.assertIsNone(D.highlight_quote("“x”", {"marks": []}))
        self.assertIsNone(D.highlight_quote("", self.m))
        for bad in ({}, [], {"subject": "S"}, dict(good, sections=[]), dict(good, sections=[{"heading": "H"}]),
                    dict(good, subject="x" * 121), dict(good, sections=[dict(good["sections"][0], body="x" * 4001)]),
                    dict(good, sections=[good["sections"][0]] * 9)):
            with self.assertRaises(ValueError):
                D.validate_draft(bad, self.m)


class T6_Render(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="devo-")
        self.m = material_fixture(self.tmp)
        self.issue = issue_from(self.m, D.deterministic_draft(self.m))
        self.html, self.text = D.render(self.issue, SITE + "/", postal="PO Box 1, Nowhere")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_verse_words_from_the_file(self):
        words = bsb(43)["3"][15]
        big, tail = D.split_verse(words.strip())
        self.assertIn(D.esc(big), self.html)  # the key verse at full volume: its first clause large, the rest in gold
        self.assertIn(D.esc(tail), self.html)
        self.assertIn(words.strip(), html_text(self.html), "every word of the key verse, from the file")
        self.assertIn(f"> {words}", self.text)
        self.assertIn("— John 3:16 · BSB", self.text)
        self.assertIn("John 3:16 · BSB", self.html)
        self.assertEqual(D.verse_words(43, 3, 16), words.strip())
        self.assertEqual(D.verse_words(45, 5, 8, 9), (bsb(45)["5"][7] + " " + bsb(45)["5"][8]).strip())
        self.assertEqual(D.verse_words(43, 3, 999), "")
        self.assertIn(D.esc(bsb(45)["5"][7]), self.html, "a section's verse block, the verse whole")

    def test_key_verse_once_and_section_kickers(self):
        """The key verse is set apart at full volume and not quoted again as section I's verse block (the mock puts
        a different verse there); the text twin quotes it once too. A section whose heading is the chapter itself
        (the deterministic draft) gets the numeral alone as its kicker, not the chapter twice one line apart."""
        words = bsb(43)["3"][15].strip()
        self.assertEqual(html_text(self.html).count(words), 1, "the key verse once in the html")
        self.assertEqual(self.html.count("John 3:16 · BSB"), 1)
        self.assertEqual(self.text.count(f"> {words}"), 1, "and once in the text twin")
        self.assertEqual(self.text.count(bsb(45)["5"][7].strip()), 1)
        kickers = re.findall(r'text-transform:uppercase;color:#ffb35c;">([^<]*)</p>\s*<h2[^>]*>([^<]*)</h2>', self.html)
        self.assertEqual(kickers[:2], [("I", "John 3"), ("II", "Romans 5")], kickers)
        stitched = D.deterministic_draft(self.m)
        stitched["sections"][0]["heading"] = "The giving comes first"
        h, t = D.render(issue_from(self.m, stitched), SITE)
        kickers = re.findall(r'text-transform:uppercase;color:#ffb35c;">([^<]*)</p>\s*<h2[^>]*>([^<]*)</h2>', h)
        self.assertEqual(kickers[0], ("I · John 3", "The giving comes first"), "a title of its own: the kicker names the chapter")
        self.assertEqual(html_text(h).count(words), 1)
        # the key verse is quoted once even when it is the only ref of section I, and section II's verse stays
        only = D.deterministic_draft(self.m)
        only["sections"][0]["refs"] = ["43.3.16"]
        h, t = D.render(issue_from(self.m, only), SITE)
        self.assertEqual(html_text(h).count(words), 1)
        self.assertIn(D.esc(bsb(45)["5"][7]), h)

    def test_note_text_escaped_and_links(self):
        self.assertIn("Loved &lt;b&gt;first&lt;/b&gt; &amp; then given.", self.html)
        self.assertNotIn("<b>first</b>", self.html)
        self.assertIn("While we were <i>still</i> sinners.", self.html)
        self.assertIn(f'href="{SITE}/?utm_source=devotional&amp;utm_medium=email#45/5/8"', self.html)  # [[Romans 5:8]]
        self.assertIn("Loved <b>first</b> & then given. See Romans 5:8.", self.text)  # Ji's characters, untouched
        self.assertIn("While we were still sinners.", self.text)

    def test_placeholder_and_no_secrets(self):
        for body in (self.html, self.text):
            self.assertIn(D.UNSUB_PLACEHOLDER, body)
            self.assertNotIn("@", body.replace("@example.test", "@"))  # no address at all
            self.assertIsNone(HEX32.search(body))
        self.assertIn(f"{SITE}/api/devotional/unsubscribe?t={D.UNSUB_PLACEHOLDER}", self.text)
        out = D.personalise(self.html, "a" * 32)
        self.assertNotIn(D.UNSUB_PLACEHOLDER, out)
        self.assertIn(f"unsubscribe?t={'a' * 32}", out)

    def test_every_site_link_carries_utm_before_the_hash(self):
        hrefs = re.findall(r'href="([^"]+)"', self.html)
        site_links = [h for h in hrefs if h.startswith(SITE)]
        self.assertGreater(len(site_links), 6)
        for h in site_links:
            self.assertIn("utm_source=devotional&amp;utm_medium=email", h, h)
            if "#" in h:
                self.assertLess(h.index("utm_source"), h.index("#"), h)
        self.assertIn(f'href="{SITE}/privacy?utm_source=devotional&amp;utm_medium=email"', self.html)
        self.assertIn(f'href="{SITE}/weeklydevotional?utm_source=devotional&amp;utm_medium=email"', self.html)

    def test_design_bands(self):
        h = self.html
        self.assertTrue(h.startswith("<!doctype html>"))
        self.assertNotIn("<style", h)
        self.assertIn('<table role="presentation" width="600"', h)
        self.assertIn(f'<img src="{SITE}/icons/icon-192.png" width="22" height="22"', h)
        self.assertIn(f'src="{SITE}/data/art/dore-170.jpg" width="600"', h)  # John 3 has no plate: the book's first
        self.assertIn("Gustave Doré, The Marriage in Cana (1866)", h)
        self.assertLess(h.index("<h1"), h.index("Gustave Doré, The Marriage in Cana (1866)"))  # the credit sits under the title block
        self.assertIn(">8–14 November 2026</p>", h)  # the kicker is the week alone
        self.assertIn("John 3 · Romans 5 · 1 John 4 &nbsp;·&nbsp; 2 chapters, 3 notes, 2 connections", h)  # section chapters only
        self.assertIn("My highlight · 1 John 4:10", h)
        self.assertIn(f'<span style="background:#2a2114;border-bottom:2px solid #ffb35c;padding:1px 2px;border-radius:2px;">{D.esc(bsb(62)["4"][9][:40].strip())}</span> — the direction matters', h)
        for kick, head in (("I", "John 3"), ("II", "Romans 5"), ("III", "1 John 4")):  # the chapter once: numeral, then the heading
            self.assertRegex(h, rf'color:#ffb35c;">{kick}</p><h2[^>]*>{re.escape(head)}</h2>')
        self.assertNotIn("I · John 3", h)
        self.assertIn("This week’s connections", h)
        self.assertIn("2 connections, 3 books", h)
        self.assertIn("<svg viewBox=\"0 0 520 170\"", h)
        self.assertIn("Isaiah 53:5", h)
        self.assertIn("the gift precedes the response", h)
        self.assertIn("My highlight", h)
        self.assertIn("the direction matters", h)
        self.assertIn("For today", h)
        self.assertIn("The giving comes first.", h)
        self.assertIn("Amen<span style=\"color:#ffb35c;\">.</span>", h)
        self.assertIn("reply “Amen”", h)
        self.assertIn("Open 1 John 4 in Bible Lantern", h)
        self.assertEqual(h.count("1 John 4:19 · BSB"), 1)  # the companion: the memory verse, not a repeat of a section verse
        self.assertLess(h.index("For today"), h.index("1 John 4:19 · BSB"))
        self.assertIn(D.BSB_CREDIT, h)
        self.assertIn("PO Box 1, Nowhere", h)
        self.assertIn("#050505", h)
        self.assertIn("#ffb35c", h)
        self.assertIn("Unsubscribe</a> · ", h)
        self.assertIn("Read on the web", h)
        self.assertLess(h.index("<svg"), h.index("Isaiah 53:5</a>"), "the thread table follows the SVG")
        t = self.text
        self.assertIn("John 3:16 -> Romans 5:8 (fulfils): the gift precedes the response", t)
        self.assertIn("I. John 3", t)
        self.assertIn("Amen.", t)
        self.assertIn("2 chapters, 3 notes, 2 connections", t)
        self.assertIn("My highlight: 1 John 4:10 · “", t)
        self.assertIn("PO Box 1, Nowhere", t)
        self.assertIn(f"Open 1 John 4 in Bible Lantern: {SITE}/?utm_source=devotional&utm_medium=email#62/4", t)

    def test_title_em_and_preheader(self):
        d = dict(self.issue["draft"], title="Loved <em>first</em>", opening="One sentence. Two sentences.")
        h, t = D.render(dict(self.issue, draft=d), SITE)
        self.assertIn('<em style="font-style:italic;color:#ffb35c;">first</em>', h)
        self.assertIn("<title>Loved first · 8–14 November 2026 · Bible Lantern</title>", h)
        self.assertIn(">One sentence.</div>", h)
        self.assertIn("LOVED FIRST", t)
        d = dict(self.issue["draft"], title="<script>x</script>Plain")
        h, _t = D.render(dict(self.issue, draft=d), SITE)
        self.assertNotIn("<script>", h)
        self.assertIn("xPlain", h)

    def test_split_verse(self):
        words = bsb(43)["3"][15]
        big, tail = D.split_verse(words)
        self.assertEqual((big + " " + tail).strip(), words.strip())
        self.assertTrue(tail)
        self.assertEqual(D.split_verse("Short."), ("Short.", ""))
        self.assertIn(D.esc(big), self.html)

    def test_empty_draft_renders(self):
        issue = D.new_issue(WEEK, 1, "owner")
        h, t = D.render(issue, SITE)
        self.assertIn("This week", h)
        self.assertIn("dore-001.jpg", h)
        self.assertIn("Amen.", t)
        issue["draft"] = {"subject": "S", "title": "T", "opening": "", "sections": [], "closing": "", "question": "Why?"}
        h, t = D.render(issue, SITE)
        self.assertIn("For your notes:</b> Why?", h)
        self.assertIn("For your notes: Why?", t)


class T7_Plates(unittest.TestCase):
    def test_choice(self):
        hero, second = D.choose_plates([(43, 2)])
        self.assertEqual((hero["id"], second), ("dore-170", None))
        hero, second = D.choose_plates([(43, 3)])
        self.assertEqual(hero["ref"][0], 43)
        self.assertIsNone(second)
        hero, second = D.choose_plates([(1, 1), (43, 2)])
        self.assertEqual((hero["id"], second["id"]), ("dore-001", "dore-170"))
        hero, second = D.choose_plates([(43, 2), (43, 2), (43, 3)])
        self.assertEqual((hero["id"], second), ("dore-170", None))  # the same chapter again is not a second plate
        hero, second = D.choose_plates([])
        self.assertEqual((hero["id"], second), ("dore-001", None))
        hero, second = D.choose_plates([(40, 21)])  # a plate set in Matthew 21 beats the Temple plate's `also` range
        self.assertEqual(hero["ref"][:2], [40, 21])
        primaries = {(p["ref"][0], p["ref"][1]) for p in D.plates()}
        only_also = next((p, r) for p in D.plates() for r in p.get("also", []) if (r[0], r[1]) not in primaries)
        self.assertEqual(D._plate_for_chapter(only_also[1][0], only_also[1][1])["id"], only_also[0]["id"])
        hero, second = D.choose_plates([(57, 1)])  # Philemon: no plate, no book plate
        self.assertEqual(hero["id"], "dore-001")

    def test_arcs(self):
        links = [{"from": "43.3.16", "to": "45.5.8"}, {"from": "45.5.8", "to": "23.53.5"}, {"from": "1.1.1", "to": "1.1.2"}]
        svg = D.arcs_svg([(43, 3)], links)
        self.assertEqual(svg.count("<path"), 2)  # a link inside one chapter draws no arc
        self.assertEqual(svg.count("<rect") - 2, 4)  # two bars, then a tick per chapter: John 3, Romans 5, Isaiah 53, Genesis 1
        with open(os.path.join(REPO, "app", "data", "meta.json"), encoding="utf-8") as f:
            books = json.load(f)["books"]
        x_john3 = 520 * (sum(len(b["chapters"]) for b in books[:42]) + 3) / 1189
        self.assertIn(f'x="{x_john3 - 4:.1f}" y="112"', svg)
        self.assertIn(">Isaiah 53<", svg)
        self.assertIn("Old Testament", svg)
        self.assertEqual(svg.count('y="144"'), 1)  # Romans 5 sits close to John 3, so it drops to the second row
        self.assertNotIn("<script", svg)


class T8_Stitch(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", cls.port), FakeApi)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="devo-")
        self.m = material_fixture(self.tmp)
        FakeApi.script, FakeApi.seen = [], []
        self.naps = []

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def good(self):
        # the body is a verse-looking sentence of the model's own (brief §8.5), never Scripture typed here; the quote
        # is a slice of the week's one highlight, read from the BSB file by the fixture
        return {"subject": "Loved first", "title": "Loved <em>first</em>", "opening": "I kept coming back to one word.",
                "sections": [{"heading": "The giving comes first", "refs": ["43.3.16", "1.1.1"],
                              "body": "And the reader said unto himself, the giving came first. That order matters. See [[Romans 5:8]].",
                              "quotes": [self.m["marks"][0]["words"][:20]]},
                             {"heading": "While we were still", "refs": ["45.5.8"], "body": "Not after we cleaned up.", "quotes": []}],
                "closing": "Take the order with you.", "question": "Where did the giving come first for you this week?"}

    def test_good_json_with_a_stray_ref(self):
        FakeApi.script = [(200, fake_claude_reply(self.good()), {})]
        d = D.stitch(self.m, FAKE_KEY, self.url, "claude-test-1", sleep=self.naps.append)
        self.assertTrue(d["stitched"])
        self.assertEqual(d["model"], "claude-test-1")
        self.assertEqual(d["sections"][0]["refs"], ["43.3.16"])
        self.assertEqual(d["sections"][0]["body"], self.good()["sections"][0]["body"])  # the model's wording stays
        self.assertEqual(d["sections"][0]["quotes"], [f"1 John 4:10 · “{self.m['marks'][0]['words'][:20]}”"], "the highlight, with its own reference")
        self.assertEqual(d["title"], "Loved <em>first</em>")
        self.assertEqual(len(d["warnings"]), 1)
        req = FakeApi.seen[0]
        self.assertEqual(req["path"], "/v1/messages")
        self.assertEqual(req["headers"]["x-api-key"], FAKE_KEY)
        self.assertEqual(req["headers"]["anthropic-version"], "2023-06-01")
        body = json.loads(req["body"])
        self.assertEqual(body["model"], "claude-test-1")
        self.assertEqual(body["output_config"]["format"]["type"], "json_schema")
        self.assertEqual(body["output_config"]["format"]["schema"], D.DRAFT_SCHEMA)
        self.assertEqual(body["output_config"]["effort"], "high")
        self.assertNotIn("thinking", body)
        self.assertEqual(body["max_tokens"], 8000)
        self.assertEqual(body["system"][0]["text"], D.STITCH_SYSTEM)
        self.assertEqual(body["system"][0]["cache_control"], {"type": "ephemeral"})
        user = json.loads(body["messages"][0]["content"])
        self.assertEqual(user["notes"][1]["verse"], bsb(43)["3"][15].strip())
        self.assertEqual(user["links"][0]["to"]["label"], "Romans 5:8")
        self.assertNotIn(FAKE_KEY, json.dumps(d))
        issue = issue_from(self.m, d)
        h, t = D.render(issue, SITE)
        self.assertIn(bsb(43)["3"][15].strip(), html_text(h))
        self.assertNotIn(bsb(1)["1"][0].strip(), html_text(h))  # the stray Genesis 1:1 never reaches the email
        self.assertIn("And the reader said unto himself, the giving came first. That order matters.", h)  # model text, as text
        self.assertIn("Where did the giving come first for you this week?", t)
        self.assertNotIn("Genesis 1:1", t)

    def test_garbage_falls_back(self):
        for script in ([(200, b"not json at all", {})], [(200, fake_claude_reply({"subject": "only"}), {})],
                       [(200, fake_claude_reply(self.good(), stop="max_tokens"), {})],
                       [(200, {"stop_reason": "end_turn", "content": []}, {})], [(400, {"error": "bad"}, {})]):
            FakeApi.script, FakeApi.seen = list(script), []
            d = D.stitch(self.m, FAKE_KEY, self.url, "claude-test-1", sleep=self.naps.append)
            self.assertFalse(d["stitched"], script)
            self.assertEqual(len(d["warnings"]), 1)
            self.assertIn("stitch failed", d["warnings"][0])
            self.assertNotIn(FAKE_KEY, d["warnings"][0])
            base = D.deterministic_draft(self.m)
            self.assertEqual(dict(d, warnings=[]), base)
            self.assertEqual(len(FakeApi.seen), 1, script)  # a 400 is not retried

    def test_retry_once_then_success(self):
        FakeApi.script = [(500, {"error": "boom"}, {}), (200, fake_claude_reply(self.good()), {})]
        d = D.stitch(self.m, FAKE_KEY, self.url, "claude-test-1", sleep=self.naps.append)
        self.assertTrue(d["stitched"])
        self.assertEqual(len(FakeApi.seen), 2)
        self.assertEqual(self.naps, [D.STITCH_PAUSE])
        FakeApi.script, FakeApi.seen, self.naps[:] = [(429, {}, {}), (503, {}, {})], [], []
        d = D.stitch(self.m, FAKE_KEY, self.url, "claude-test-1", sleep=self.naps.append)
        self.assertFalse(d["stitched"])
        self.assertEqual(len(FakeApi.seen), 2)  # one retry only

    def test_network_down_falls_back(self):
        d = D.stitch(self.m, FAKE_KEY, "http://127.0.0.1:1", "claude-test-1", sleep=self.naps.append, timeout=2)
        self.assertFalse(d["stitched"])
        self.assertIn("network", d["warnings"][0])


class T9_Resend(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="devo-")
        self.m = material_fixture(self.tmp)
        self.issue = issue_from(self.m, D.deterministic_draft(self.m))
        self.issue["html"], self.issue["text"] = D.render(self.issue, SITE)
        self.cfg = {"from": "Bible Lantern <devotional@example.test>", "reply_to": "hello@example.test", "site": SITE,
                    "html": self.issue["html"], "text": self.issue["text"]}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_batches_of_100(self):
        recipients = [(f"sb_{i:012x}", f"r{i}@example.test", hashlib.sha256(str(i).encode()).hexdigest()[:32]) for i in range(250)]
        batches = D.batch_messages(self.issue, recipients, self.cfg)
        self.assertEqual([len(b["messages"]) for b in batches], [100, 100, 50])
        self.assertEqual(len({b["key"] for b in batches}), 3)
        for i, b in enumerate(batches):
            self.assertTrue(re.fullmatch(r"2026-11-14:[0-9a-f]{64}", b["key"]), b["key"])
            self.assertEqual(b["key"], D.batch_key("2026-11-14", [m["to"][0] for m in b["messages"]]))
            self.assertEqual(b["sids"], [r[0] for r in recipients[i * 100:(i + 1) * 100]])
            for (_sid, email, tok), msg in zip(recipients[i * 100:(i + 1) * 100], b["messages"]):
                self.assertEqual(msg["to"], [email])
                self.assertEqual(msg["from"], self.cfg["from"])
                self.assertEqual(msg["reply_to"], "hello@example.test")
                self.assertEqual(msg["subject"], "Weekly devotional · 14 November")
                self.assertEqual(msg["headers"]["List-Unsubscribe"], f"<{SITE}/api/devotional/unsubscribe?t={tok}>")
                self.assertEqual(msg["headers"]["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click")
                self.assertNotIn(D.UNSUB_PLACEHOLDER, msg["html"])
                self.assertNotIn(D.UNSUB_PLACEHOLDER, msg["text"])
                self.assertIn(f"unsubscribe?t={tok}", msg["html"])
                self.assertIn(f"unsubscribe?t={tok}", msg["text"])
        self.assertEqual(D.batch_messages(self.issue, [], self.cfg), [])
        same = D.batch_key("2026-11-14", ["b@example.test", "a@example.test"])
        self.assertEqual(same, D.batch_key("2026-11-14", ["a@example.test", "b@example.test"]))
        # the key names the issue and the addresses only: the same readers batched again by a later run (after a
        # crash between Resend's 2xx and the `done` write) carry the same key, whatever position they are in
        later = D.batch_messages(self.issue, recipients[100:], self.cfg)
        self.assertEqual([b["key"] for b in later], [b["key"] for b in batches[1:]])
        self.assertNotEqual(D.batch_key("2026-11-21", ["a@example.test"]), D.batch_key("2026-11-14", ["a@example.test"]))

    def test_client_headers_and_retries(self):
        op = FakeOpener([(200, b'{"id": "em_1"}', {})])
        rs = D.Resend("https://resend.example.test/", FAKE_RESEND_KEY, opener=op, sleep=lambda s: None)
        out = rs.send_batch([{"to": ["a@example.test"]}], "2026-11-14:abc")
        self.assertEqual(out, {"id": "em_1"})
        call = op.calls[0]
        self.assertEqual(call["url"], "https://resend.example.test/emails/batch")
        self.assertEqual(call["headers"]["authorization"], "Bearer " + FAKE_RESEND_KEY)
        self.assertEqual(call["headers"]["idempotency-key"], "2026-11-14:abc")
        self.assertEqual(call["headers"]["content-type"], "application/json")
        self.assertEqual(json.loads(call["body"]), [{"to": ["a@example.test"]}])
        naps = []
        op = FakeOpener([(500, b"{}", {}), (429, b"{}", {"retry-after": "1"}), (200, b"", {})])
        rs = D.Resend("https://resend.example.test", FAKE_RESEND_KEY, opener=op, sleep=naps.append)
        self.assertEqual(rs.send({"to": ["a@example.test"]}), {})
        self.assertEqual(len(op.calls), 3)
        self.assertEqual(naps, [D.RESEND_PAUSE, 1.0])
        self.assertEqual(op.calls[0]["url"], "https://resend.example.test/emails")
        self.assertNotIn("idempotency-key", op.calls[0]["headers"])
        op = FakeOpener([(422, b'{"message": "bad"}', {})])
        rs = D.Resend("https://resend.example.test", FAKE_RESEND_KEY, opener=op, sleep=naps.append)
        with self.assertRaises(D.ResendError) as cm:
            rs.send({})
        self.assertEqual((cm.exception.status, len(op.calls)), (422, 1))
        op = FakeOpener([(500, b"", {}), (0, b"", {}), (502, b"", {})])
        rs = D.Resend("https://resend.example.test", FAKE_RESEND_KEY, opener=op, sleep=lambda s: None)
        with self.assertRaises(D.ResendError) as cm:
            rs.send({})
        self.assertEqual((cm.exception.status, len(op.calls)), (502, 3))

    def test_author_mails(self):
        raw = "f" * 32
        m = D.confirmation_mail("new@example.test", raw, self.cfg)
        self.assertEqual(m["to"], ["new@example.test"])
        self.assertIn(f"{SITE}/api/devotional/confirm?t={raw}", m["html"])
        self.assertIn(f"{SITE}/api/devotional/confirm?t={raw}", m["text"])
        self.assertEqual(m["reply_to"], "hello@example.test")
        p = D.preview_mail(self.issue, "e" * 32, self.cfg, "owner@example.test")
        self.assertEqual(p["subject"], "Review: Weekly devotional · 14 November")
        self.assertIn(f"{SITE}/api/devotional/review?t={'e' * 32}", p["html"])
        self.assertIn(f"{SITE}/api/devotional/review?t={'e' * 32}", p["text"])
        self.assertIn("Your week is ready. Approve, skip or send yourself a test", p["text"])
        self.assertLess(p["html"].index("<body"), p["html"].index("Review this issue"))
        self.assertLess(p["html"].index("Review this issue"), p["html"].index("John 3:16 · BSB"))
        self.assertNotIn(D.UNSUB_PLACEHOLDER, p["html"])
        empty = dict(self.issue, status="empty")
        p = D.preview_mail(empty, "e" * 32, self.cfg, "owner@example.test")
        self.assertNotIn("review?t=", p["html"] + p["text"])
        self.assertIn("Nothing to send this week", p["html"])
        t = D.test_mail(self.issue, self.cfg, "owner@example.test")
        self.assertEqual(t["subject"], "[test] Weekly devotional · 14 November")
        self.assertIn("John 3:16 · BSB", t["html"])
        s = D.sent_mail(self.issue, 2, self.cfg, "owner@example.test")
        self.assertEqual(s["subject"], "Sent to 2 readers · 8–14 November 2026")


class T10_Text(unittest.TestCase):
    def test_md(self):
        h = D.md_html("**Bold** and *em* with [[John 3:16]] and [[43.3.16|the verse]] and [[Nowhere 9]] <x>\n\n- one\n- two\n> quoted", SITE)
        self.assertIn("<b>Bold</b> and <i>em</i>", h)
        self.assertIn(f'<a href="{SITE}/?utm_source=devotional&amp;utm_medium=email#43/3/16" style="color:#ffb35c;text-decoration:none;">John 3:16</a>', h)
        self.assertIn(">the verse</a>", h)
        self.assertIn("Nowhere 9 &lt;x&gt;", h)
        self.assertIn("<ul", h)
        self.assertIn("<li>one</li><li>two</li>", h)
        self.assertIn("<blockquote", h)
        self.assertNotIn("<x>", h)
        self.assertEqual(D.md_text("**Bold** and *em* with [[John 3:16]] and [[43.3.16|the verse]]\n- one"),
                         "Bold and em with John 3:16 and the verse\n• one")
        self.assertEqual(D.md_html("", SITE), "")

    def test_parse_human_ref(self):
        self.assertEqual(D.parse_human_ref("John 3:16"), (43, 3, 16, 16))
        self.assertEqual(D.parse_human_ref("Jn 3.16"), (43, 3, 16, 16))
        self.assertEqual(D.parse_human_ref("1 John 4:19"), (62, 4, 19, 19))
        self.assertEqual(D.parse_human_ref("I John 4:19"), (62, 4, 19, 19))
        self.assertEqual(D.parse_human_ref("Rom 5:8-9"), (45, 5, 8, 9))
        self.assertEqual(D.parse_human_ref("Psalm 23"), (19, 23, 0, 0))
        self.assertEqual(D.parse_human_ref("Jude 3"), (65, 1, 3, 3))
        self.assertEqual(D.parse_human_ref("43.3.16"), (43, 3, 16, 16))
        self.assertEqual(D.parse_human_ref("45.5.8-9"), (45, 5, 8, 9))
        for bad in ("John 99:1", "Nowhere 1:1", "", "3:16", None):
            self.assertIsNone(D.parse_human_ref(bad), bad)

    def test_quote_parts(self):
        self.assertEqual(D._quote_parts("John 3:17 · “but to save” · the sending was for rescue"), ("John 3:17", "but to save", "the sending was for rescue"))
        self.assertEqual(D._quote_parts("“but to save”"), (None, "but to save", ""))
        self.assertEqual(D._quote_parts("Nowhere 9 · “x” · y"), (None, "x", "y"))
        self.assertEqual(D._quote_parts("plain words"), (None, None, "plain words"))

    def test_labels(self):
        self.assertEqual(D.label_of("19.23.1"), "Psalm 23:1")
        self.assertEqual(D.label_of("45.5.8-9"), "Romans 5:8–9")
        self.assertEqual(D.label_of("43.3"), "John 3")
        self.assertEqual(D.label_of("nonsense"), "nonsense")
        self.assertEqual(D.clean_title("<em>a</em> and <em>b</em> <i>c</i>"), "<em>a</em> and b c")


if __name__ == "__main__":
    unittest.main(verbosity=1)
