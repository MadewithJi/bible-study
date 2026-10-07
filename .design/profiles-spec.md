# Profiles, bookmarks and reading progress — Build Specification

Single source of truth for (1) the **server builder** and (2) the later **front-end builders**. Follow it literally. Where this spec is silent, follow `.design/spec.md` (the visual design system and DOM contract) and the existing code style (vanilla ES modules, `esc()` for every user string, no emoji, no Unicode glyph icons, system fonts only).

User request (verbatim): *"Add a way to bookmark and leave off and keep tabs of all the things you have studied automatically and allow that progress and notes to be saved against the profile where you create a simple profile login via email and login."*

What ships:
- **Profiles**: local email + password profiles stored on this computer (no email is ever sent). Password reset via CLI.
- **Bookmarks**: verse or chapter, optional label, colour.
- **Leave off**: last reading position per profile, auto-resume on a fresh load plus a "Continue reading" prompt.
- **Automatic tracking**: chapters opened/read, verses studied, time studied, streaks, a capped activity log.
- **Per-profile notes** (the existing notes model) and a per-profile **library**; **guest mode** works exactly as today when nobody is signed in.

---

## 0. Ground rules

### 0.1 Ownership (disjoint files)

| Builder | Owns | Must not touch |
|---|---|---|
| **S: SERVER** | `serve.py`, **new** `accounts.py` (same folder as serve.py), `README.md` (a new "Profiles" section), `.gitignore` (add the new data paths), everything under `.design/servertest/` | anything under `app/`, `build.py`, `notes/notes.json`, `notes/config.json` |
| **FE-A: ACCOUNT + SHELL** (later) | **new** `app/js/account.js`, **new** `app/js/ui.js`, `app/js/store.js`, `app/js/main.js`, `app/js/icons.js`, `app/index.html`, `app/css/styles.css` | `viz.js`, `maps.js`, `morph.js`, `build.py` |
| **FE-B: LIBRARY + TRACKING** (later) | **new** `app/js/library.js`, **new** `app/js/tracker.js`, `app/js/reader.js`, `app/js/drawer.js` | same as FE-A |

FE-A and FE-B code against the exports named in §5 even before the other side lands (guard optional calls with `typeof fn === 'function'`). Other agents are editing `drawer.js`, `styles.css`, `viz.js`, `maps.js` and `build.py` right now: FE builders start only after those edits land and apply **additive** patches (no reformatting of unrelated lines).

### 0.2 Safety (every builder, every test)

- The user's real server runs on **port 8765** with the real data in `notes/`. **Never** restart or kill it, and never write to `notes/notes.json` or `notes/config.json`.
- Server tests run a **separate instance**: `python3 /Users/jkim/bible-study/serve.py --port 8766 --data-dir /Users/jkim/bible-study/.design/servertest/data`, started in the background by the test runner and killed when done.
- Test accounts use addresses under the reserved domain **`example.test`** only. Passwords are generated (`secrets.token_urlsafe(18)`) and written **only** to `/Users/jkim/bible-study/.design/servertest/test-accounts.json` (mode 0600). Never print a password or a session token in test output, logs or a final answer.
- Front-end testing: sign-in/profile flows are tested against the **8766 test instance** (writes allowed there, it is throwaway data). Against 8765, only `?dry` (see `.design/spec.md` §0.2): in dry mode the client performs **no** non-GET request and **no** localStorage write.

### 0.3 Environment facts (verified 2026-09-28)

- `/usr/bin/python3` is **3.9.6 linked against LibreSSL 2.8.3**: `hashlib.scrypt` **does not exist** on this machine. The hashing design (§3.1) therefore prefers scrypt when available and **falls back to PBKDF2-HMAC-SHA256, 600,000 iterations** (measured 177 ms here). The stored hash string names its algorithm, so a future Python with scrypt upgrades hashes on the next successful login.
- `ThreadingHTTPServer` dispatches any method to `do_<METHOD>`; `DELETE`, `PATCH` and `OPTIONS` handlers must be added explicitly.
- YouTube embeds need a Referer: **do not** send a restrictive `Referrer-Policy` (keep the browser default `strict-origin-when-cross-origin`).

### 0.4 Glossary

| Term | Meaning |
|---|---|
| **DATA** | the data directory: `--data-dir`, default `<repo>/notes` |
| **scope** | whose data a request acts on: `"guest"` or a uid like `"u3f9a0c1d2e4b5a69"` |
| **ref** | `"b.c"` (chapter) or `"b.c.v"` (verse), 1-based, same as note keys (`"43.3.16"`) |
| **ms** | integer milliseconds since the Unix epoch (JS `Date.now()`); all stored timestamps use ms |
| **day** | the **client's local** calendar date `YYYY-MM-DD` |
| **active second** | a second in which the reader is actually present (§4.1) |

---

## 1. Data model

### 1.1 Directory layout

```
DATA/                           (default <repo>/notes; created 0700)
  notes.json                    guest notes (unchanged location = backward compatible)
  guest-library.json            guest library (new)
  config.json                   ESV/NLT keys (global, unchanged)
  cache/                        licensed passage cache (global, unchanged)
  users.json                    profile registry (new)
  sessions.json                 hashed session tokens (new)
  .auth.lock                    fcntl lock file for users.json + sessions.json
  .server.lock                  held by the running server (one server per DATA)
  profiles/<uid>/notes.json     per-profile notes
  profiles/<uid>/library.json   per-profile library
  profiles/<uid>/user.json      owner of the folder: uid, email, name, created (never the hash); written after users.json at signup, on email/name change, and at sign-in when missing
  deleted/<uid>-<YYYYmmdd-HHMMSS>/   deleted profiles (moved, recoverable by hand)
  *.bak                         daily backups next to notes.json / library.json / users.json (0600). Not sessions.json: restoring it would revive revoked sessions
```

- At startup the server calls `os.umask(0o077)`, creates `DATA`, `DATA/profiles` with mode 0700. New files are therefore 0600.
- The server **refuses to start** (exit 1, message `--data-dir must not be inside app/`) if `realpath(DATA)` is inside `realpath(<repo>/app)`, so static serving can never expose data.
- `.gitignore` gains: `notes/users.json`, `notes/sessions.json`, `notes/profiles/`, `notes/deleted/`, `notes/guest-library.json`, `notes/*.bak`, `notes/.*.lock`, `.design/servertest/`.

### 1.2 `users.json`

```json
{
  "version": 1,
  "users": {
    "u3f9a0c1d2e4b5a69": {
      "uid": "u3f9a0c1d2e4b5a69",
      "email": "ji@example.test",
      "name": "Ji Kim",
      "pw": "pbkdf2_sha256$600000$<salt b64>$<hash b64>",
      "created": 1759071600000,
      "updated": 1759071600000,
      "lastLogin": 1759071600000,
      "pwChanged": 1759071600000,
      "failedLogins": 0,
      "lockUntil": 0
    }
  }
}
```

- `uid` = `"u" + secrets.token_hex(8)`; regex `^u[0-9a-f]{16}$`. The uid is only ever taken from this file or a server-side session record, **never** from client input.
- `email` is stored **normalised** (§3.6): trimmed, lowercased. Unique across users.
- Cap: **50 profiles** (`--max-users N` overrides). Lookup by email is a linear scan.
- Missing file = no users. `version` missing = 1.

### 1.3 `sessions.json`

```json
{
  "version": 1,
  "sessions": {
    "<sha256 hex of the raw token>": {
      "uid": "u3f9a0c1d2e4b5a69",
      "created": 1759071600000,
      "lastSeen": 1759071600000,
      "expires": 1761663600000,
      "hardExpires": 1774623600000,
      "remember": true,
      "ua": "Mozilla/5.0 (Macintosh; …first 120 chars"
    }
  }
}
```

- The raw token is never stored or logged; only `sha256(token).hexdigest()`.
- Lifetimes in §3.2. Expired entries are purged on every login/signup and at startup. Only expired ones: a record whose uid is missing from `users.json` is left alone (it is inert, §3.2 resolution refuses it), so a damaged `users.json` cannot also sign everyone out for good. Max **20 sessions per user**: on creating the 21st, delete the one with the oldest `lastSeen`.

### 1.4 Notes (`DATA/notes.json` for guest, `profiles/<uid>/notes.json` for a profile)

```json
{
  "refs": {
    "43.3.16": { "text": "…", "highlight": "yellow", "tags": ["gospel"], "videos": [{"url": "…", "id": "G-2e9mMf7E8", "start": 192, "title": "…", "added": 1759071600000}], "created": 1759071600000, "updated": 1759071700000 },
    "43.3":    { "text": "Chapter note", "highlight": "", "tags": [], "videos": [], "created": 1759071600000, "updated": 1759071600000 }
  },
  "studies": [],
  "rev": 12,
  "deleted": { "43.3.17": 1759071800000 }
}
```

- `refs` and `studies` are exactly today's shape (the client model is unchanged). Unknown fields on a note (for example the legacy `preview` flag) are **preserved**.
- **New server-maintained fields**: `rev` (integer, +1 on every successful write) and `deleted` (tombstones `ref → ms`, used by the per-key merge in §2.5). Tombstones: keep at most **2,000** (newest by ts), drop entries older than **180 days**.
- Validation for new endpoints (per note): `text` string ≤ 100,000 chars; `highlight` ∈ `"" | yellow | green | blue | pink | orange`; `tags` ≤ 50 strings each ≤ 64 chars; `videos` ≤ 100 objects (`url` ≤ 2,048, `id` ≤ 64, `start` int ≥ 0, `title` ≤ 300, `added` int); `created`/`updated` ints (missing `updated` → server now); serialized note ≤ 256 KiB. Keys must be valid refs (§3.6). Max 50,000 refs per file.
- **Clock guard**: `created`, `updated`, video `added` and `del` timestamps more than **5 minutes** after the server clock are clamped to the server's now (as tracker events are, §4.6); video `start` must be ≤ 2^53. On load, a stored `updated`/`created`/tombstone more than 5 minutes after the file's mtime is treated as that mtime (repairs files written before the guard; the value is stable until the next write, so a compare-and-set `base` taken from `GET /api/notes` still matches).
- **Canonical keys**: refs never have leading zeros and use ASCII digits only (§3.6). A stored key such as `43.03.16` or `4٣.3.16` (only old or buggy clients wrote them) is folded into `43.3.16` on load (the newer note wins); bookmarks and chapter entries are folded the same way in the library.
- A `studies` value that is not a list reads as `[]` (the notes stay visible); only a `refs` that is not an object moves the whole file aside.

### 1.5 Library (`DATA/guest-library.json` for guest, `profiles/<uid>/library.json` for a profile)

```json
{
  "version": 1,
  "rev": 42,
  "created": 1759071600000,
  "updated": 1759075200000,
  "bookmarks": [
    { "id": "bm_4f1c2a9e0b7d", "ref": "43.3.16", "b": 43, "c": 3, "v": 16, "label": "Gospel in a verse", "color": "red", "created": 1759071600000, "updated": 1759071600000 },
    { "id": "bm_91aa03e2c4f0", "ref": "19.23", "b": 19, "c": 23, "v": 0, "label": "", "color": "blue", "created": 1759071000000, "updated": 1759071000000 }
  ],
  "lastPosition": { "b": 43, "c": 3, "v": 16, "scrollFrac": 0.42, "t": 1759075100000, "tr": "kjv" },
  "chapters": {
    "43.3": { "firstRead": 1759071600000, "lastRead": 1759075100000, "visits": 3, "seconds": 812, "studied": [3, 16, 17], "read": true, "readAt": 1759072400000, "manual": false, "manualAt": null }
  },
  "days": {
    "2026-09-28": { "s": 1320, "v": 7, "r": 2, "n": 1, "o": 4 }
  },
  "activity": [
    { "t": 1759071600000, "type": "chapter.open", "ref": "43.3" },
    { "t": 1759071700000, "type": "xref.open", "ref": "43.3.16", "x": { "to": "45.5.8" } }
  ],
  "appliedBatches": ["5d2c7c1e-3f0e-4c7a-9d51-2c6b3c1f8a10"],
  "imports": [ { "source": "guest", "t": 1759071600000, "mode": "copy" } ]
}
```

| Field | Rules |
|---|---|
| `bookmarks` | At most **2,000**. One bookmark per `ref` (adding an existing ref returns the existing one). `id` = `"bm_" + secrets.token_hex(6)` (regex `^bm_[0-9a-f]{12}$`). `v` = 0 for a chapter bookmark. `label` ≤ 80 chars (§3.6 text cleaning). `color` ∈ `red` (default) `orange yellow green blue purple`. Stored newest `created` first. |
| `lastPosition` | `null` or `{b, c, v, scrollFrac, t, tr}`; `v` = 0..verses (0 = top of chapter), `scrollFrac` 0..1 (3 decimals), `tr` optional `^[a-z0-9]{2,8}$`. Replaced only by a position with `t ≥` the stored `t`. |
| `chapters` | Key `"b.c"`. `firstRead`/`lastRead` = first/last time the chapter was opened or had time recorded (ms or null). `visits` = count of `chapter.open`. `seconds` = active seconds. `studied` = sorted unique verse numbers. `read`/`readAt` = read state. `manual`/`manualAt` = set when the user marks or unmarks by hand (§4.3). |
| `days` | Key = local day. `s` active seconds (capped 86,400), `v` verses newly studied, `r` chapters auto-read, `n` notes saved, `o` chapters opened. Keep the newest **400** days. |
| `activity` | Stored **oldest → newest** (sorted by `t`), capped at **1,000** (drop oldest). Entry `{t, type, ref, x?}`; `ref` is `"b.c.v"`, `"b.c"`, `"b"` (bulk marks) or `null` (profile events). Types in §4.5. |
| `appliedBatches` | Last **200** event-batch ids (idempotent retries, §2.6). |
| `imports` | Log of guest imports. |

`new_chapter()` = `{"firstRead": null, "lastRead": null, "visits": 0, "seconds": 0, "studied": [], "read": false, "readAt": null, "manual": false, "manualAt": null}`.

Worst-case size ≈ 1,189 chapters × ~200 B + 1,000 activity × ~120 B ≈ 400 KB. Fine.

### 1.6 Derived stats (computed on `GET /api/library`, never stored)

Input: the library, the scope's note count, `today` (client local date from the query string, default server local date), and verse counts from `app/data/meta.json`.

- **Study day**: `days[d]` exists and (`s ≥ 60` or `v ≥ 1` or `r ≥ 1` or `n ≥ 1`).
- **streak.current**: if `today` is a study day start at `today`, else start at `today − 1`; count consecutive study days backwards. **streak.longest**: longest run of consecutive study days in `days`. **streak.studiedToday**: bool.
- **minutes90**: 90 integers, oldest first, ending with `today`: `round(days[d].s / 60)` (0 when absent). **days90**: number of study days in that window.
- **week.seconds**: sum of `s` over `today` and the previous 6 days.
- **totals**: `seconds` (sum of `chapters[*].seconds`), `chaptersRead`, `chaptersTotal` (1,189), `versesStudied` (sum of `len(studied)`), `chaptersStudied` (chapters with ≥1 studied verse), `booksCompleted`, `bookmarks`, `notes` (count of refs), `daysStudied` (study days in `days`).
- **books**: object keyed by book number (string) for books with any data: `{read, total, started, seconds, studied}` where `started` = chapters with `visits > 0 or studied` (read or not).

### 1.7 Guest storage and migration

- Existing `notes/notes.json` **is** the guest notes file. No migration needed. The first write by the new server adds `rev` and `deleted`.
- `guest-library.json` is created on the first library write. A missing file reads as an empty library (`rev: 0`).
- The browser's existing `localStorage['bs-notes-v1']` stays the guest mirror. Profile mirrors use suffixed keys (§5.2).
- Corrupt JSON (users, sessions, notes, library): the server **never overwrites it with an empty document**. It renames the file to `<name>.corrupt-<YYYYmmdd-HHMMSS>`, logs one line, and continues from the default. (Today's `read_json` silently returns the default; that behaviour must not be used for these files.) A file that parses but has wrongly typed fields is repaired field by field on load (bad entries dropped or coerced), never a 500.
- **Registry guard**: while `users.json` is missing and either a `users.json.corrupt-*` exists or a `profiles/<uid>/user.json` exists, signup and login answer 503 `registry_unavailable` (restore `users.json` from `users.json.bak` or the `.corrupt` file) and `/api/auth/me` reports `features: {signup: false, profiles: false}`. Signup is also refused (503, `field: "email"`) for an email that a `profiles/<uid>/user.json` names but `users.json` does not list (for example after restoring an older `.bak`). This stops the same person signing up into an empty profile and orphaning their data.
- **Daily backup**: before overwriting any `notes.json`, `library.json` or `users.json`, if `<file>.bak` is missing or older than 24 h, copy the current file to `<file>.bak` (atomic, 0600).
- **Values JSON cannot carry**: a stored `NaN`, `Infinity` or out-of-range number (`1e999`) reads as `null`, and an unpaired surrogate escape (`"\ud800"`) reads as U+FFFD, so a hand-edited file can never make an endpoint answer invalid JSON or fail with 500s. Writes refuse non-finite numbers (`allow_nan=False`).

### 1.8 Import rules (guest → profile)

**At sign-up** (`importGuest: true`, the profile is brand new): **copy** mode.
- Notes: profile `refs` = deep copy of guest `refs`; `studies` copied; `rev` = 1; `deleted` = {}.
- Library: deep copy of the guest library, then `rev` = 1, `appliedBatches` = [], `imports` = `[{source: "guest", t: now, mode: "copy"}]`, and append activity `profile.import` with `x: {notes, bookmarks, chapters}`.
- Guest data is **left unchanged** (copy, not move).

**Later** (`POST /api/profile/import-guest`): **merge** mode (idempotent: running it twice changes nothing the second time).
- Notes: for each guest ref: take the guest note if the profile has no such ref **and** no tombstone with `ts ≥ guest.updated`, or if `guest.updated > profile.updated`.
- Bookmarks: union by `ref`; when both exist keep the profile's.
- Chapters: `firstRead` = min (non-null), `lastRead` = max, `visits` = max, `seconds` = max, `studied` = union, `read` = either, `readAt` = min non-null of the read ones, `manual`/`manualAt` = profile's.
- Days: per day and per counter, max.
- Activity: union, de-duplicated on `(t, type, ref)`, sorted, capped at 1,000.
- `lastPosition`: the newer `t`.
- Append `imports` entry `{source: "guest", t, mode: "merge"}` (the log keeps the last 50) and activity `profile.import`, **only when something changed**. Whether days and activity changed is decided after the 400-day / 1,000-entry caps are applied: guest entries older than everything the profile keeps are no change, so a repeat import never pushes real history out.

### 1.9 Export format

`GET /api/export/profile` returns (as a download) the current scope:

```json
{
  "format": "bible-study-profile",
  "version": 1,
  "exported": "2026-09-28T15:04:05Z",
  "scope": "profile",
  "profile": { "name": "Ji Kim", "email": "ji@example.test", "created": 1759071600000 },
  "notes": { "refs": { }, "studies": [ ] },
  "library": { "version": 1, "rev": 42, "bookmarks": [ ], "lastPosition": null, "chapters": { }, "days": { }, "activity": [ ], "imports": [ ] }
}
```

- Guest scope: `"scope": "guest"`, `"profile": null`.
- Never includes the password hash, sessions, `appliedBatches`, `deleted` or `lockUntil`.
- Filename: `bible-study-<slug>-<YYYY-MM-DD>.json`, slug = name lowercased, runs of non `[a-z0-9]` → `-`, trimmed, max 40 chars, or `guest`.

`GET /api/export/obsidian` (existing) now acts on the current scope and additionally writes, when non-empty (vault naming: verse `[[John 3.16|John 3:16]]`, chapter `[[John 3]]`, book `[[John]]`):
- `study-notes/Bookmarks.md`: `# Bookmarks`, then one line per bookmark newest first: `- [[John 3.16|John 3:16]]` + (` · label` if any).
- `study-notes/Reading Progress.md`: `# Reading progress`, a line `N of 1,189 chapters read`, then per book with any read chapter: `## John (21/21)` and a line of `[[John 1]] · [[John 2]] …` for read chapters.

---

## 2. HTTP API

### 2.1 Conventions

- Base: same origin as the app. All API responses are JSON (`application/json; charset=utf-8`) except the two exports.
- **Every** API response carries `Cache-Control: no-store` and `X-BS-Scope: <guest|uid>` (the scope the server resolved for the request).
- **Every** response (API and static) carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`. No `Referrer-Policy` header (§0.3).
- **Error shape** (every non-2xx API response):
  ```json
  { "error": "bad_credentials", "message": "That email and password don’t match a profile on this computer.", "field": "password", "retryAfter": 12 }
  ```
  `error` and `message` always; `field` when one input is at fault; `retryAfter` (seconds, integer) with 429/503, mirrored in a `Retry-After` header.
- **Auth column**: `none` = ignores the session; `optional` = acts on the profile when signed in, else on guest; `required` = 401 `not_signed_in` without a valid session.
- **Scope header**: `X-BS-Scope: guest` or `X-BS-Scope: <uid>`. **required** = missing → 400 `scope_required`; present but different from the resolved scope → 409 `scope_mismatch` with body `{"error":"scope_mismatch","message":"…","scope":"<actual>"}`. This stops a tab that still believes it is signed in (or signed out) from writing into the wrong space.
- Mutating requests (POST, PUT, PATCH, DELETE) always pass the CSRF pipeline in §3.4 first. Every mutating request **must** have a JSON body (`{}` when there is nothing to send, including DELETE).
- Request bodies must be strict JSON: `NaN`, `Infinity`, a number outside the double range (`1e999`) or an unpaired surrogate escape (`"\ud800"`) anywhere in the body → 400 `bad_json`. Responses are always strict JSON (`JSON.parse` never fails on them).
- **Display strings** (profile `name`, bookmark `label`, activity `x.word` / `x.title`) are returned exactly as stored: the server removes only control characters, unpaired surrogates and bidi embedding/override/isolate controls and enforces the lengths (§3.6). `<`, `>`, `&` and quotes are legitimate and never rejected or pre-escaped, so the front end must `esc()` every one of them (and emails, note text, tags, video titles) before it reaches `innerHTML` (§5.16).
- Any unmatched `/api/...` path → 404 `not_found` (JSON, never the static 404 page). A known path with the wrong method → 405 `method_not_allowed` with an `Allow` header. `OPTIONS` and `HEAD` on `/api/` → 405 with **no** `Access-Control-*` headers.

### 2.2 Endpoint index

| # | Method | Path | Auth | X-BS-Scope | Body limit |
|---|---|---|---|---|---|
| 1 | GET | `/api/auth/me` | optional | – | – |
| 2 | POST | `/api/auth/signup` | none (replaces any current session) | – | 16 KiB |
| 3 | POST | `/api/auth/login` | none (replaces any current session) | – | 16 KiB |
| 4 | POST | `/api/auth/logout` | optional | – | 1 KiB |
| 5 | PATCH | `/api/account` | required | – | 16 KiB |
| 6 | POST | `/api/account/password` | required | – | 16 KiB |
| 7 | POST | `/api/account/delete` | required | – | 16 KiB |
| 8 | GET | `/api/notes` | optional | – | – |
| 9 | PUT | `/api/notes` (legacy whole replace) | optional | optional; **required when signed in** | 8 MiB |
| 10 | POST | `/api/notes/changes` | optional | required | 2 MiB |
| 11 | GET | `/api/library` | optional | – | – |
| 12 | POST | `/api/library/events` | optional | required | 128 KiB |
| 13 | POST | `/api/library/bookmarks` | optional | required | 8 KiB |
| 14 | PATCH | `/api/library/bookmarks/{id}` | optional | required | 8 KiB |
| 15 | DELETE | `/api/library/bookmarks/{id}` | optional | required | 1 KiB |
| 16 | POST | `/api/library/chapters` | optional | required | 16 KiB |
| 17 | POST | `/api/library/reset` | optional | required | 1 KiB |
| 18 | POST | `/api/profile/import-guest` | required | required | 1 KiB |
| 19 | GET | `/api/export/profile` | optional | – | – |
| 20 | GET | `/api/export/obsidian` | optional | – | – |
| 21 | GET | `/api/config` | none | – | unchanged |
| 22 | PUT | `/api/config` | none | – | 8 KiB (CSRF pipeline now applies) |
| 23 | GET | `/api/passage` | none | – | unchanged |
| 24 | GET | `/api/links` | optional | – | – |
| 25 | POST | `/api/links/changes` | optional | required | 1 MiB |

`user` object (public shape, used in several responses):
```json
{ "uid": "u3f9a0c1d2e4b5a69", "email": "ji@example.test", "name": "Ji Kim", "initials": "JK", "created": 1759071600000, "lastLogin": 1759071600000 }
```
`initials`: split the name on whitespace; 2+ words → first char of first word + first char of last word; 1 word → its first char; uppercase.

### 2.3 Auth

**1. `GET /api/auth/me`** → 200 always.
```json
{
  "signedIn": true,
  "scope": "u3f9a0c1d2e4b5a69",
  "user": { "uid": "…", "email": "…", "name": "Ji Kim", "initials": "JK", "created": 0, "lastLogin": 0 },
  "session": { "remember": true, "expires": 1761663600000 },
  "guest": { "notes": 12, "bookmarks": 3, "chaptersRead": 5, "hasData": true },
  "limits": { "passwordMin": 8, "passwordMax": 256, "nameMax": 60, "labelMax": 80 },
  "features": { "signup": true, "profiles": true }
}
```
Signed out: `"signedIn": false, "scope": "guest", "user": null, "session": null` (other fields as above). `guest.hasData` = any guest ref, bookmark or chapter entry. `features.signup` is false when the user cap is reached or the registry is unavailable; `features.profiles` is false while the registry is unavailable (§1.7). If the request carried a session cookie that is not valid, the response also sets a cookie-clearing header (§3.2).

**2. `POST /api/auth/signup`**
Request: `{ "email": "ji@example.test", "name": "Ji Kim", "password": "…", "remember": true, "importGuest": true }`
- Validate (§3.6) → 400 `invalid_email` (field `email`), `invalid_name` (field `name`), `weak_password` (field `password`, message says which rule).
- Rate limits (§3.5) → 429 `rate_limited`. User cap → 403 `user_limit`. Hash semaphore timeout → 503 `busy`. Registry missing or damaged, or the email belongs to an orphaned profile folder (§1.7) → 503 `registry_unavailable` (no `retryAfter`: waiting does not help; show the message).
- Email already registered (after normalisation) → 409 `email_taken` (field `email`).
- If a valid session cookie came with the request, revoke that session first.
- Order: create `profiles/<uid>/` with `notes.json` and `library.json` (import per §1.8 if `importGuest` and guest has data, else empty docs with `rev: 1`); append activity `profile.create` (and `profile.import`); then write `users.json`; then create the session. If a later step fails, remove the new profile directory and return 500.
- 201:
```json
{ "ok": true, "user": { }, "session": { "remember": true, "expires": 0 }, "imported": { "notes": 12, "bookmarks": 3, "chapters": 5 } }
```
`imported` is `null` when nothing was imported. `Set-Cookie` per §3.2.

**3. `POST /api/auth/login`**
Request: `{ "email": "…", "password": "…", "remember": true }`
- Lockout / global rate limit checked **before** hashing → 429 `rate_limited` with `retryAfter`. Registry unavailable → 503 `registry_unavailable`.
- Unknown email: verify against `DUMMY_HASH` (same cost) and return 401 `bad_credentials`. Wrong password: 401 `bad_credentials` (identical body). Update the failure counters (§3.5).
- Success: reset counters, `lastLogin = now`, rehash if `needs_rehash` (§3.1), revoke any session sent with the request, create a new session → 200 `{ "ok": true, "user": {}, "session": {} }` + `Set-Cookie`.

**4. `POST /api/auth/logout`**
Request: `{}` or `{ "all": true }`. Deletes the current session (or every session of that uid when `all`). Idempotent: without a session → 200 too.
→ 200 `{ "ok": true, "revoked": 1 }` + cookie-clearing `Set-Cookie`.

**5. `PATCH /api/account`**
Request: any of `{ "name": "…" }`, `{ "email": "…", "password": "…" }`.
- `name` → validated, saved.
- `email` change requires `password` (verified with the login lockout rules) → 401 `bad_credentials`, 400 `invalid_email`, 409 `email_taken`.
→ 200 `{ "ok": true, "user": {} }`.

**6. `POST /api/account/password`**
Request: `{ "current": "…", "next": "…" }`
- Lockout checks, verify `current` → 401 `bad_credentials` (field `current`); validate `next` → 400 `weak_password` (field `next`).
- Save hash, `pwChanged = now`, revoke **all** sessions of the uid, then create a fresh session for this client with the same `remember` flag.
→ 200 `{ "ok": true, "revokedOthers": 2 }` + `Set-Cookie` (new token).

**7. `POST /api/account/delete`**
Request: `{ "password": "…" }` → verify (lockout rules) → 401 `bad_credentials`.
Then, holding the auth lock and that profile's lock: move `profiles/<uid>` to `deleted/<uid>-<YYYYmmdd-HHMMSS>/`, write `user.json` there (the user record **without** `pw`), remove the user from `users.json`, delete all its sessions.
→ 200 `{ "ok": true }` + cookie-clearing `Set-Cookie`.

### 2.4 Notes (scope-aware, backward compatible)

**8. `GET /api/notes`** → 200 `{ "refs": {}, "studies": [], "rev": 12, "scope": "guest" }` with header `ETag: "12"`. (`deleted` is not returned.) Old clients read `refs`/`studies` as before.

**9. `PUT /api/notes`** (legacy; the old client uses it, the new client does not)
- Signed out and no `X-BS-Scope`: behaves as today — replaces `refs` and `studies` of the guest file. Shallow validation only: body is an object, `refs` an object, `studies` a list if present. `rev` += 1, `deleted` reset to `{}`.
- Signed in and **no** `X-BS-Scope` → 409 `scope_required` (protects a profile from an old tab that still holds guest notes). With a matching header → applies to the profile.
- Optional `If-Match: "<rev>"` → 409 `rev_conflict` `{ "error": "rev_conflict", "message": "…", "rev": 13 }` when it differs.
→ 200 `{ "ok": true, "saved": "15:04:05", "rev": 13 }`.

**10. `POST /api/notes/changes`** (the new client's only notes write)
Request:
```json
{ "baseRev": 12, "set": { "43.3.16": { "text": "…", "highlight": "", "tags": [], "videos": [], "created": 0, "updated": 1759071700000 } }, "del": { "43.3.17": 1759071800000 } }
```
- At most 5,000 keys across `set` + `del`. Invalid key or note → 400 `invalid_note` with `field` = the key; nothing is applied.
- Optional **`base`** (compare-and-set; the new client always sends it): `{ "<key>": <the note's updated as this client last got it from the server> | null }` for every key in `set`/`del` (`null` = the client saw no note). Keys not in `set`/`del` are ignored; a value that is not null or a number ≥ 0 → 400 `bad_request` (`field` = key). For a key with a base:
  - `set`: applies only if the stored note is still that version (`null` ↔ no stored note), whatever the timestamps say; else **conflict** (`conflicts[k]` = stored note, or `null` when it was deleted). If the incoming `updated` is not after the stored one it is stored as `stored.updated + 1` (the version always moves forward). A repeat of the write that produced the stored note (a retry after a lost response: identical, or identical except that the server moved `updated` to `base + 1`) is no change and no conflict; `versions[k]` still gives the stored `updated`.
  - `del`: deletes only if the stored note is still that version, else conflict; if the note is already gone it just records the tombstone (no conflict).
  - Keys **without** a base keep the timestamp rules below (older clients).
- Under the scope lock, for each `set[k]`: if the stored ref exists with `updated > incoming.updated` → **conflict** (keep stored, `conflicts[k] = stored note`); else store it and drop any tombstone for `k`.
- For each `del[k] = ts`: if no stored ref → record tombstone `deleted[k] = max(existing, ts)`; if stored `updated ≤ ts` → delete it and record the tombstone; else → **conflict** (`conflicts[k] = stored note`).
- `changed` = anything stored or deleted; if changed, `rev` += 1 and save.
- `stale` = `baseRev < rev_before_this_request`.
- `versions` = `{key: stored updated | null}` for every key of the request that did **not** conflict: the base to send next time for that key.
→ 200 `{ "ok": true, "rev": 13, "changed": true, "stale": false, "conflicts": { }, "versions": { "43.3.16": 1759071700000, "43.3.17": null }, "saved": "15:04:05" }`.

`apply_note_changes(notes, set_map, del_map, base=None)` is a pure function in `accounts.py` returning `(changed, conflicts)`; `note_versions(notes, keys, conflicts)` builds `versions`.

### 2.5 Library

**11. `GET /api/library?today=YYYY-MM-DD&activity=50&before=<ms>`**
- `today`: client local date (validated; bad → server local date). `activity`: 0..1000 (default 50). `before`: return activity entries with `t < before` (pagination).
→ 200 with `ETag: "<rev>"`:
```json
{
  "scope": "guest",
  "rev": 42,
  "bookmarks": [ ],
  "lastPosition": { "b": 43, "c": 3, "v": 16, "scrollFrac": 0.42, "t": 0, "tr": "kjv" },
  "chapters": { "43.3": { } },
  "stats": {
    "today": "2026-09-28",
    "streak": { "current": 6, "longest": 14, "studiedToday": true },
    "minutes90": [0, 0, 12],
    "days90": 41,
    "week": { "seconds": 2700 },
    "totals": { "seconds": 12000, "chaptersRead": 128, "chaptersTotal": 1189, "versesStudied": 342, "chaptersStudied": 58, "booksCompleted": 3, "bookmarks": 7, "notes": 12, "daysStudied": 60 },
    "books": { "43": { "read": 3, "total": 21, "started": 5, "seconds": 1200, "studied": 7 } }
  },
  "activity": [ ],
  "activityTotal": 812,
  "server": { "now": 1759075200000 }
}
```
`activity` is **newest first**.

**12. `POST /api/library/events`**
Request: `{ "batchId": "5d2c7c1e-3f0e-4c7a-9d51-2c6b3c1f8a10", "events": [ { "type": "chapter.open", "t": 1759071600000, "day": "2026-09-28", "b": 43, "c": 3 } ] }`
- `batchId` regex `^[A-Za-z0-9_-]{8,64}$` (else 400 `invalid_batch`); `events` a list of 1..200 (else 400 `invalid_batch`).
- If `batchId` ∈ `appliedBatches` → 200 `{ "ok": true, "rev": 42, "applied": 0, "rejected": 0, "duplicate": true }`, nothing applied.
- Otherwise `apply_events(lib, events, now)` (§4.6); invalid single events are skipped and counted in `rejected` (never a 400 for one bad event); append `batchId`; `rev` += 1 if `applied > 0`; save.
- Rate limit 120 requests/min per scope → 429.
→ 200 `{ "ok": true, "rev": 43, "applied": 17, "rejected": 0, "duplicate": false }`.

**13. `POST /api/library/bookmarks`**
Request: `{ "ref": "43.3.16", "label": "", "color": "red", "created": 1759071600000 }` (`label`, `color`, `created` optional; `created` is only for Undo restores, must be ≤ now, else ignored).
- Invalid ref → 400 `invalid_ref`; label too long → 400 `invalid_label`; colour not in the set → 400 `invalid_color`; 2,000 reached → 409 `bookmark_limit`.
- Ref already bookmarked → 200 `{ "ok": true, "rev": 42, "bookmark": {}, "existed": true }` (unchanged).
- Else insert, activity `bookmark.add` (`x: {id, label?}`), `rev` += 1 → 201 `{ "ok": true, "rev": 43, "bookmark": {} }`.

**14. `PATCH /api/library/bookmarks/{id}`**
Request: any of `{ "label": "…", "color": "blue" }`. Unknown or malformed id → 404 `not_found`. Validation as 13. Sets `updated = now` → 200 `{ "ok": true, "rev": 44, "bookmark": {} }`. No activity entry.

**15. `DELETE /api/library/bookmarks/{id}`** (body `{}`)
Unknown id → 404. Removes it, activity `bookmark.remove` (`x: {id}`) → 200 `{ "ok": true, "rev": 45, "removed": {} }`.

**16. `POST /api/library/chapters`** (manual read marks)
Request: `{ "b": 43, "c": 3, "read": true }` or `{ "b": 43, "cs": [1, 2, 3], "read": false }` (`cs` 1..150 valid chapters).
- For each chapter: `read` → `read = true`, `readAt = readAt or now`; unread → `read = false`, `readAt = null`; always `manual = true`, `manualAt = now`. Manual marks **do not** touch `days` (they must not create streak days).
- Activity `chapter.mark` with `ref` `"b.c"` (single) or `"b"` (bulk) and `x: {read, count}`.
→ 200 `{ "ok": true, "rev": 46, "chapters": { "43.3": { } } }`.

**17. `POST /api/library/reset`**
Request: `{ "what": ["activity"] }`; `what` ⊆ `{activity, progress, bookmarks}` (non-empty) else 400 `invalid_reset`. `progress` clears `chapters`, `days` and `lastPosition`. → 200 `{ "ok": true, "rev": 47 }`.

### 2.6 Profile data

**18. `POST /api/profile/import-guest`** (body `{}`, signed in, `X-BS-Scope` = uid)
Merge per §1.8, locks acquired in order guest → profile. Guest has no data → 200 with zero counts.
→ 200 `{ "ok": true, "imported": { "notes": 12, "bookmarks": 3, "chapters": 5 }, "rev": { "notes": 14, "library": 48 } }` (counts = items that changed the profile).

**19. `GET /api/export/profile`** → 200 `application/json; charset=utf-8`, `Content-Disposition: attachment; filename="bible-study-ji-kim-2026-09-28.json"`, body §1.9.

**20. `GET /api/export/obsidian`** → 200 `application/zip`, `Content-Disposition: attachment; filename="bible-study-notes.zip"` (unchanged name), content §1.9.

### 2.7 Error code catalogue

| Status | `error` codes |
|---|---|
| 400 | `bad_json`, `invalid_email`, `invalid_name`, `weak_password`, `invalid_note`, `invalid_ref`, `invalid_label`, `invalid_color`, `invalid_batch`, `invalid_reset`, `invalid_link` (`field` = the link id), `scope_required`, `bad_request` |
| 401 | `not_signed_in`, `bad_credentials` |
| 403 | `bad_host`, `csrf`, `user_limit` |
| 404 | `not_found` |
| 405 | `method_not_allowed` |
| 409 | `email_taken`, `scope_mismatch`, `scope_required` (legacy PUT while signed in), `rev_conflict`, `bookmark_limit`, `link_limit` (“You’ve reached the limit of 10,000 links.”) |
| 411 | `length_required` |
| 413 | `too_large` |
| 415 | `unsupported_media_type` |
| 429 | `rate_limited` |
| 500 | `server_error` (message generic; details only in the server log, never the traceback in the body) |
| 503 | `busy`, `registry_unavailable` |

---

## 3. Security design

### 3.1 Password hashing

```python
PREFERRED = "scrypt" if hasattr(hashlib, "scrypt") else "pbkdf2_sha256"
# scrypt:        n=2**15, r=8, p=1, dklen=32, maxmem=64*1024*1024
#                "scrypt$32768$8$1$<salt b64>$<dk b64>"
# pbkdf2_sha256: hashlib.pbkdf2_hmac("sha256", pw, salt, 600_000, dklen=32)
#                "pbkdf2_sha256$600000$<salt b64>$<dk b64>"
```
- Salt: `secrets.token_bytes(16)` per hash. Base64 = `base64.b64encode(...).decode("ascii")` (`$` never occurs in it).
- Password bytes: `unicodedata.normalize("NFKC", pw).encode("utf-8")`. No trimming.
- `verify_password(pw, stored)`: parse the prefix; recompute with the stored parameters; compare with `hmac.compare_digest`. Unknown prefix, malformed string, or `scrypt` on a Python without it → return False and log `hash-unsupported uid=…` (the fix is `--reset-password`).
- `needs_rehash(stored)` → True when the algorithm or parameters differ from `PREFERRED`'s; then rehash after a successful login.
- `DUMMY_HASH` = `hash_password(secrets.token_urlsafe(16))` computed once at startup; used for unknown emails so response time does not reveal whether an email exists.
- Concurrency: `HASH_SEM = threading.BoundedSemaphore(2)`; acquire with a 10 s timeout, else 503 `busy` (`retryAfter: 2`). `pbkdf2_hmac` releases the GIL.

### 3.2 Sessions and cookies

- Token: `secrets.token_urlsafe(32)` (43 chars `[A-Za-z0-9_-]`). Server key: `sha256(token).hexdigest()`.
- **Cookie name**: `bs_sid_<port>` (for example `bs_sid_8765`). Cookies are not port-specific, so the port in the name keeps the 8765 and 8766 instances from clobbering each other. `localhost` and `127.0.0.1` are different cookie hosts; that is expected.
- **Attributes**: `Path=/; HttpOnly; SameSite=Strict`. **No `Secure`** (plain http on loopback). No `Domain`.
  - remember = true: `Max-Age=2592000` (30 days).
  - remember = false: no `Max-Age`/`Expires` (browser-session cookie).
  - Clearing: `bs_sid_<port>=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`.
- **Lifetimes** (server-enforced; the browser cookie alone is never trusted):

| | Idle expiry (sliding) | Absolute expiry (`hardExpires`) |
|---|---|---|
| remember | 30 days | 180 days from `created` |
| not remember | 12 hours | 7 days from `created` |

- **Resolution** (every request): parse `Cookie` with `http.cookies.SimpleCookie` (a `CookieError` = no session); token must match `^[A-Za-z0-9_-]{43}$`; look up its key; reject if `now > expires` or `now > hardExpires` or the uid no longer exists. A rejected token → guest scope for that request.
- **Sliding**: when `now − lastSeen > 10 min`, set `lastSeen = now`, `expires = min(now + idle, hardExpires)`, save, and (remember only) re-send the cookie with `Max-Age = (expires − now) / 1000`.
- **Rotation**: a new token on signup, login and password change. Logout deletes. Password change and `--reset-password` delete every session of the uid. Account deletion deletes all. Tokens are only accepted from the cookie, never from a query string or body (no fixation).
- `users.json` and `sessions.json` are read from disk under the auth lock for each request that needs them (they are tiny) so the CLI can change them while the server runs. Only the `lastSeen` slide writes on a normal request.

### 3.3 Host allowlist (DNS rebinding)

Applied to **every** request (static and API) before anything else. `Host` must be one of `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`, plus `<name>:<port>` for each `--allow-host NAME` flag. Missing or other Host → 403 `bad_host` (JSON for `/api/`, plain text otherwise). If `--host` is not a loopback address, print a warning at startup (`Profiles over plain HTTP on a network are visible to that network.`).

### 3.4 CSRF pipeline (every POST, PUT, PATCH, DELETE under `/api/`)

In order:
1. **Origin**: if an `Origin` header is present it must equal `"http://" + Host` exactly (`null` fails) → else 403 `csrf`.
2. **Fetch metadata**: if `Origin` is absent and `Sec-Fetch-Site` is present, it must be `same-origin` or `none` → else 403 `csrf`. (Non-browser clients such as urllib tests send neither and pass.)
3. **Content-Type**: the media type must be `application/json` (parameters like `charset` allowed) → else 415 `unsupported_media_type`. This also forces a CORS preflight for any cross-site attempt, and the server never answers preflights.
4. **Content-Length**: required, ASCII digits only (`²` is not a length) → 411 `length_required`; over the endpoint limit (§2.2) → 413 `too_large` (checked **before** reading the body). Chunked bodies are not supported.
5. **JSON**: parse UTF-8; failure, a non-object top level, `NaN`/`Infinity`/out-of-range numbers or an unpaired surrogate escape → 400 `bad_json`.
6. **Scope header** where the endpoint requires it (§2.1).

Plus `SameSite=Strict` on the session cookie. No CORS headers are ever sent.

### 3.5 Rate limits and backoff

- **Per account** (login, password change, account delete, email change): failures counted in `users.json` (`failedLogins`, `lockUntil`). **Per unknown email**: same policy in an in-memory dict (max 1,000 entries, LRU) so responses for known and unknown emails are indistinguishable.
  ```
  lock_seconds(f) = 0 if f < 5 else min(900, 2 ** (f - 5))    # 5th failure → 1 s, 6th → 2 s, … capped at 15 min
  ```
  While `now < lockUntil` → 429 `rate_limited` with `retryAfter`, **without** hashing. On failure: `f += 1`, `lockUntil = now + lock_seconds(f)`. On success: reset both.
  **Atomic**: the gate and the count are one step. Under the auth lock (the unknown-email dict's lock for unknown emails) the server re-reads the account, refuses if locked, and otherwise counts the attempt as a failure (`f += 1`, `lockUntil = now + lock_seconds(f)`) **before** hashing; a verified password resets both, a failed one restarts `lockUntil` from the failure time, a 503 `busy` gives the count back. Simultaneous guesses therefore cannot all pass the gate: at most 5 are ever hashed before the lock.
- **Global auth window**: at most 30 attempts per rolling 60 s across signup + login + password + delete + email change → 429. Checked and counted in one locked step (a burst cannot overshoot); an attempt refused by a lockout still counts.
- **Signups**: at most 10 per rolling hour → 429. Also checked and counted atomically; the count is given back when the signup is refused as `email_taken`, `user_limit` or `registry_unavailable`.
- **Events**: 120 requests/min per scope; **notes changes**: 300/min per scope → 429.
- All in-memory limiter state resets on restart (acceptable for a local app). `--reset-password` clears `failedLogins`/`lockUntil` for that account.

### 3.6 Input validation

| Input | Rule |
|---|---|
| email | `strip()`, `lower()`, ≤ 254 chars, regex `^[^@\s"<>]{1,64}@[a-z0-9.-]{1,189}\.[a-z0-9-]{2,63}$`, and no invisible character (Unicode category `C*`: controls, zero-width and bidi format characters, surrogates, private-use, unassigned) → `invalid_email` “Enter an email address like name@example.com.” |
| name | whitespace of any kind (tab, CR, LF) becomes a space; then remove chars with code point < 32 or 127–159, unpaired surrogates and the bidi embedding/override/isolate controls U+202A–U+202E and U+2066–U+2069 (joiners U+200C/U+200D and the marks U+200E/U+200F/U+061C are kept), collapse whitespace runs to one space, `strip()`, then 1..60 chars → `invalid_name` “Enter your name (up to 60 characters).” Everything else, including `< > & " '`, is stored verbatim: the front end escapes it (§2.1, §5.16). |
| password | after NFKC: 8..256 chars and ≤ 1,024 UTF-8 bytes (“Use at least 8 characters.”); not all whitespace; not equal (case-insensitive) to the email or its local part (“Your password can’t be your email address.”); not in `COMMON_PASSWORDS` (“That password is too common. Try a longer phrase.”) |
| `COMMON_PASSWORDS` | `password, password1, password123, passw0rd, 12345678, 123456789, 1234567890, 11111111, 00000000, qwerty123, qwertyuiop, abcd1234, iloveyou, letmein1, welcome1, admin123, trustno1, baseball, football, sunshine, princess, jesus123, jesuschrist, godislove, blessed1, bible123, faith123, amazinggrace, john3:16, johnthreesixteen` (compare lowercased) |
| ref | `^[1-9]\d?\.[1-9]\d{0,2}(\.[1-9]\d{0,2})?$` with ASCII digits only (`re.ASCII`; canonical: no leading zeros, so `43.03.16` and `4٣.3.16` → `invalid_ref`/`invalid_note`), `1 ≤ b ≤ 66`, `1 ≤ c ≤ chapters(b)`, `1 ≤ v ≤ verses(b,c)` when present (counts from `app/data/meta.json`, loaded once) |
| label | same cleaning as name, 0..80 chars (counted after cleaning) |
| strong | `^[HG]\d{1,4}[a-z]?$` (ASCII digits) |
| day | `^\d{4}-\d{2}-\d{2}$` (ASCII digits), a real date |
| ids | bookmark `^bm_[0-9a-f]{12}$`; uid `^u[0-9a-f]{16}$`; batch `^[A-Za-z0-9_-]{8,64}$` |
| numbers | JSON numbers only (bools rejected); coerced with `int()` where ints are required |

### 3.7 Storage safety

- **Atomic writes**: write to `f"{path}.tmp-{os.getpid()}-{threading.get_ident()}"`, `flush()`, `os.fsync()`, `os.replace()`. Never leave tmp files on success; on exception remove the tmp file. At startup, after taking `.server.lock` and while holding the auth lock (so no writer can be active), delete any `*.tmp-<pid>-<tid>` under DATA left by a crash.
- **Locks**: `lock_for(scope)` returns a per-scope `threading.Lock` from a dict guarded by a global lock (`"guest"` or the uid); notes and library of one scope share it. `auth_lock()` = a process `threading.RLock` **plus** `fcntl.flock` on `DATA/.auth.lock` (so the CLI and the server serialise on `users.json`/`sessions.json`). **Lock order**: auth → guest → profile. Never hold a scope lock while acquiring the auth lock.
- **Single server per DATA**: at startup take `fcntl.flock(LOCK_EX | LOCK_NB)` on `DATA/.server.lock` for the process lifetime; failure → exit 1 `Another serve.py is already using <DATA>.` CLI commands do not take this lock.
- **Path safety**: profile paths are built only as `os.path.join(DATA, "profiles", uid)` with a regex-checked uid, then `os.path.realpath(...)` must start with `realpath(DATA/profiles) + os.sep`. Bookmark ids and refs never reach the filesystem. Static files keep using `SimpleHTTPRequestHandler` rooted at `app/`, with directory listings turned off: a directory without `index.html` is a 404, with or without the trailing slash (no 301 to `/js/`, so not even folder names are disclosed).
- **JSON hygiene**: `read_json_strict` maps `NaN`/`Infinity`/`1e999` to `null` and unpaired surrogates to U+FFFD (§1.7); `write_json_atomic` and every response use `allow_nan=False`.

### 3.8 Logging

- To stderr, one line per security event: `[auth] 2026-09-28T15:04:05 <event> uid=<uid|unknown> [reason=…]` for `signup`, `login-ok`, `login-fail`, `lockout`, `logout`, `logout-all`, `password-change`, `email-change`, `account-delete`, `rate-limit`, `csrf-block path=<path> reason=<origin|fetch-site|content-type>`, `bad-host`, `hash-unsupported`, `corrupt-file path=<file>`, `cli-reset-password`.
- Startup line: port, DATA, number of profiles, hash algorithm (`pbkdf2_sha256` here).
- **Never log**: passwords, tokens, cookies, session keys, request bodies, note text, labels, or the email of a failed attempt (log `uid` if the account exists, else `unknown`). The existing request log (request line + status, `/api/` only) stays; no secret ever appears in a URL.

### 3.9 CLI

```
python3 serve.py [--port 8765] [--host 127.0.0.1] [--data-dir DIR] [--allow-host NAME]... [--max-users 50]
python3 serve.py --list-users [--data-dir DIR]
python3 serve.py --reset-password EMAIL [--data-dir DIR] [--password-stdin]
```
- `--list-users`: prints `No profiles.` or one line per user: `uid  email  name  created YYYY-MM-DD  last sign-in YYYY-MM-DD|never  notes N  bookmarks N` (sorted by created). Never prints hashes. Exit 0.
- `--reset-password EMAIL`: prompts twice with `getpass.getpass("New password: ")` / `"Repeat: "` (mismatch → exit 2), or with `--password-stdin` reads one line from stdin (trailing newline stripped). Validates §3.6 (fail → exit 2 with the rule message). Unknown email → exit 1 `No profile for that email.`. On success: new hash, `pwChanged`, clears lockout, deletes every session of the uid, logs `cli-reset-password`, prints `Password reset for <email>. All sessions were signed out.` Exit 0. Works while the server runs (auth lock).
- The first line of `serve.py`'s docstring and `README.md` document these commands and the Profiles data layout.

### 3.10 Server structure

`accounts.py` (importable, **no side effects at import**) exposes at least these names; the tests import them:

```
configure(data_dir, port, allowed_hosts=(), max_users=50)
normalize_email(s) -> str
validate_email(s) -> (ok: bool, email_or_None, code_or_None)
validate_name(s)  -> (ok, name_or_None, code_or_None)
validate_password(pw, email) -> (ok, code_or_None, message_or_None)
hash_password(pw) -> str ; verify_password(pw, stored) -> bool ; needs_rehash(stored) -> bool
new_uid() ; new_token() ; token_key(token)
auth_lock() (context manager) ; lock_for(scope)
load_users() ; save_users(obj) ; load_sessions() ; save_sessions(obj)
create_session(uid, remember, ua) -> (token, session) ; resolve_session(token) -> (uid, session) | None ; revoke_sessions(uid, keep_key=None)
load_notes(scope) ; save_notes(scope, obj) ; load_library(scope) ; save_library(scope, obj)
apply_note_changes(notes, set_map, del_map, base=None) -> (changed, conflicts)
clean_event(ev, now_ms) -> dict | None
apply_events(lib, events, now_ms) -> (applied, rejected)
compute_stats(lib, notes_count, today) -> dict
merge_notes(dst, src) ; merge_library(dst, src, mode)       # mode "copy" | "merge"
export_profile(scope, user_or_None) -> dict ; obsidian_zip(notes, library) -> bytes
write_json_atomic(path, obj) ; read_json_strict(path, default)   # corrupt → move aside
```
`serve.py` keeps the HTTP layer (routing table, CSRF pipeline, cookies, limiters, CLI) and the ESV/NLT code. The module-level `NOTES`, `CONFIG`, `CACHE` constants become derived from `configure()`.

---

## 4. Automatic tracking rules (client, `tracker.js`)

### 4.1 Active time and idle detection

- A 1,000 ms `setInterval` tick. Each tick: `delta = min(performance.now() − lastTick, 2000)`; the delta **counts** only when all hold:
  1. `document.visibilityState === 'visible'`;
  2. not idle: the last input was less than **`IDLE_MS = 120000`** ago. Inputs: `pointerdown`, `pointermove` (throttled to one per 500 ms), `keydown`, `wheel`, `scroll` (window, passive), `touchstart`, `selectionchange`, `focus` (window);
  3. no `dialog[open]` (picker, settings, library, auth…);
  4. a chapter is shown (`bs:chapter-rendered` received);
  5. this tab is the most recently active one: every input posts `{t: 'active', id: TAB_ID, at: Date.now()}` on `BroadcastChannel('bs-sync')` (throttled 2 s); a tab stops counting when another tab's `at` is newer than its own last input.
- Counted time accumulates in `timeAcc[“b.c”]` (fractional seconds) and in `session.active` (the current chapter visit).

### 4.2 Seen verses (scroll coverage)

- After each `bs:chapter-rendered`, (re)observe every `#reader .verse` with an `IntersectionObserver` (`rootMargin: -<topbar bottom>px 0px -16px 0px`, `threshold: [0, 0.6]`). A verse is **visible** when `intersectionRatio ≥ 0.6` or its intersection height ≥ 50% of the viewport (tall verses).
- On each counting tick, and not while `body.sheet-modal` (the text is covered), add `delta` to `dwell[v]` for each visible verse; `dwell[v] ≥ 1500 ms` → `seen.add(v)`.
- `seenFrac = seen.size / n` (n = verse count).

### 4.3 What counts

| Signal | Rule | Event (once per chapter visit unless noted) |
|---|---|---|
| **Opened** | the chapter has ≥ **3** active seconds in this visit | `chapter.open {b,c}` |
| **Read (auto)** | `seenFrac ≥ 0.9` **and** the last verse is in `seen` **and** `session.active ≥ readThreshold(n)` where `readThreshold(n) = clamp(round(n × 2.4), 20, 240)` seconds (≈40% of reading at 250 wpm × 25 words/verse), and the chapter is not already read locally | `chapter.read {b,c}` |
| **Read (manual)** | "Mark as read" / "Mark as unread" in the reader footer, or Mark mode in the Library book view | direct call `POST /api/library/chapters` (not an event) |
| **Studied verse** | the verse is `state.selected`, the study sheet is open (`state.drawerOpen`), and ≥ **8** active seconds accumulate on it | `verse.study {b,c,v}` (once per verse per visit) |
| — also | expanding a cross-reference | `xref.open {b,c,v,to}` (implies studied, server side) |
| — also | opening a Strong's entry, or clicking a word in the Original tab or an interlinear word | `word.study {b,c,v,strong?,word?}` (implies studied) |
| — also | saving a verse note, highlight or tag | `note.save {b,c,v}` (implies studied; chapter note → `v: 0`); at most one per ref per **10 min** |
| — also | adding a video | `video.add {b,c,v,title}` (implies studied when `v > 0`) |
| **Time** | counted seconds per chapter | `chapter.time {b,c,sec}`: built at flush time, one per chapter, integer `sec` (remainder carried), `1 ≤ sec ≤ 900` (split if larger) |
| **Position** | on scroll end (debounced 2 s), on chapter change and on flush: `v` = selected verse, else the first verse whose bottom is below the top bar + 12 px; `scrollFrac = scrollY / (scrollHeight − innerHeight)` | `position {b,c,v,scrollFrac,tr}`; the queue holds at most one (replace) |

- **Manual wins**: the server ignores an auto `chapter.read` whose `t < manualAt + 60000`; a later full read re-marks it (and sets `manual = false`).
- A **visit** starts on `bs:chapter-rendered` with a different `b.c` than the current session and ends on the next such change. Re-renders of the same chapter (translation switch, interlinear toggle) continue the visit.

### 4.4 Event queue, outbox and flush

- Every event is created with `t: Date.now()` and `day: localDay(t)` (`YYYY-MM-DD` from local `getFullYear/getMonth/getDate`).
- **Outbox** (`localStorage`, not in dry mode): key `bs-outbox-v1` (guest) or `bs-outbox-v1:<uid>`, value `{ "pending": [ { "batchId": "…", "events": [ ] } ], "queue": [ ] }`. Written at most once per second while events are queued.
- **Batching**: `flush()` first converts `timeAcc` into `chapter.time` events and appends the current `position`; then it cuts `queue` into batches of ≤ 200 events and ≤ 48,000 serialized bytes, gives each a `batchId = crypto.randomUUID()` and moves it to `pending` (persisted) **before** sending, so a retry reuses the same id (server de-duplicates).
- **When**: every **30 s** while anything is queued; on `visibilitychange` → hidden and on `pagehide` (keepalive, below); on `online`; on boot (pending from a previous session); before any auth change (`account.js` awaits `flush()`).
- **Transport**: `fetch('/api/library/events', { method: 'POST', credentials: 'same-origin', keepalive, headers: { 'Content-Type': 'application/json', 'X-BS-Scope': scope }, body })`.
  - **Do not use `navigator.sendBeacon`**: it cannot set `X-BS-Scope`, and a JSON Blob is not a CORS-safelisted type (Chrome rejects it), while a `text/plain` body fails the server's Content-Type check (§3.4) by design.
  - `keepalive: true` only on hidden/pagehide, and only for batches ≤ **24,000 bytes** (the browser caps all in-flight keepalive bodies at 64 KiB, shared with the notes flush). Larger ones stay in the outbox for the next load.
- **Responses**: 200 → drop the batch from `pending`, remember `rev` (a jump of more than +1 over the known rev → `library.refreshSoon()`). 409 `scope_mismatch`/401 → stop; keep the outbox under its scope key; `document.dispatchEvent(new CustomEvent('bs:auth-lost'))`. Other 4xx → drop that batch (log to console; avoids poison loops). 5xx / network → retry with backoff 30 s, 60 s, 120 s, max 300 s.
- **Optimistic UI**: every event is also passed to `library.applyLocal(ev)` immediately so read marks, studied counts and the activity list update without waiting. After any `GET /api/library`, library.js re-applies `tracker.pendingEvents()` (queue + pending) so nothing flickers back.

### 4.5 Activity types (server-written; text is rendered by library.js, §5.10)

`chapter.open`, `chapter.read`, `chapter.mark`, `verse.study`, `xref.open`, `word.study`, `note.save`, `video.add`, `bookmark.add`, `bookmark.remove`, `profile.create`, `profile.import`. (`chapter.time` and `position` never appear in the log.)

### 4.6 Server aggregation (`apply_events`)

`clean_event(ev, now)` returns a normalised dict or None:
- `type` ∈ `chapter.open chapter.time chapter.read verse.study xref.open word.study note.save video.add position`.
- `t`: number → int; `t > now + 5 min` → `t = now`; `t < now − 30 days` → reject.
- `day`: valid and within ±1 day of the UTC date of `t`, else recomputed from `t` in server local time.
- `b`, `c` valid; `v` int 0..verses (default 0). `verse.study`, `xref.open`, `word.study` require `v ≥ 1`. `xref.open` requires a valid `to` ref. `chapter.time` requires int `sec` 1..900. `word.study`: optional `strong` (regex) and `word` (0..500). `video.add`: optional `title` (cleaned, ≤ 120). `position`: `scrollFrac` clamped 0..1 and rounded to 3 decimals, optional `tr`.

Then per event (`k = "b.c"`, `ch = chapters.setdefault(k, new_chapter())`, `d = days.setdefault(day, {s:0,v:0,r:0,n:0,o:0})`):

| type | effect | activity (append, keep sorted by `t`) |
|---|---|---|
| `position` | replace `lastPosition` if `t ≥` stored `t` | – |
| `chapter.open` | `visits += 1`; `firstRead = min`; `lastRead = max`; `d.o += 1` | `{t, "chapter.open", ref: k}` unless the same type+ref exists within the last 20 entries within **30 min** |
| `chapter.time` | `seconds += sec`; `d.s = min(86400, d.s + sec)`; `lastRead = max` | – |
| `chapter.read` | ignored if `manualAt and t < manualAt + 60000`; else if not read: `read = true`, `readAt = t`, `manual = false`, `d.r += 1` | `{t, "chapter.read", ref: k}` when newly read |
| `verse.study`, `xref.open`, `word.study`, `note.save`, `video.add` | if `v ≥ 1` and `v` not in `studied`: insert (sorted), `d.v += 1`; `note.save` also `d.n += 1` | `{t, type, ref: "b.c.v" or k, x}`: `xref.open` `x={to}`, `word.study` `x={strong?,word?}`, `video.add` `x={title?}`. Skip `verse.study` / `note.save` duplicates of the same ref within **10 min** (last 20 entries) |

After the batch: trim `days` to 400, `activity` to 1,000, `appliedBatches` to 200; set `updated`.

### 4.7 Offline, guest and dry-run behaviour

- **Guest**: identical tracking into the guest library (scope `guest`).
- **Server unreachable** (`/api/auth/me` fails at boot): scope = `localStorage['bs-last-scope']` or `guest`; events go to that scope's outbox; account UI is hidden; Library shows its offline empty state; bookmarks and manual marks show the toast “Can’t reach serve.py. Try again when it’s running.” When a later flush succeeds, the outbox drains. A 409 `scope_mismatch` keeps the outbox for when that scope signs in again.
- **`?dry`** (`window.__DRY__`): the tracker runs and calls `library.applyLocal()` (so read pills and Library can be tested) but never writes `localStorage` and never calls `fetch` with a non-GET method. Bookmark/mark actions update in-memory state only and toast “Dry run: nothing is saved.” Sign in, sign up, sign out and profile actions are disabled with the form error “Dry run: sign-in is turned off.”

---

## 5. Front-end contract and UI plan

Design language: `.design/spec.md` tokens, the grouped-list primitives (`.lh`, `.group`, `.cell`), `.frows` settings rows, `.menu`, `dialog.modal`, `.btn*`, `.segmented`, `.tile-i`, `.chip`, `.notice`, `.empty`, the toast. Copy is sentence case, curly quotes and apostrophes (’ “ ”), British “colour”, no exclamation marks, “profile” (not “account”) in UI text.

### 5.1 New modules and exports

**`app/js/ui.js`** (FE-A) — shared UI helpers:
```js
export function openMenu(anchor, html, { label, className = '', onClick, onKeydown, onClose, focus } = {}) // returns the .menu element; positions under anchor, flips above if needed; first menuitem (or `focus` selector) focused; ArrowUp/Down/Home/End cycle [role=menuitem]; Esc/Tab close and restore focus; outside pointerdown closes
export function closeMenu(restoreFocus = true)
export const menuOpen = () => boolean
export function confirmDialog({ title, body, ok = 'Delete', danger = true, password = false }) // → Promise<{ ok: boolean, password?: string }> using dialog#confirm
export function fmtDuration(sec)   // 0 → '0 min'; <60 → 'under 1 min'; <3600 → 'N min'; else 'H h' + (M ? ' M min' : '')
export function relTime(t)         // <60 s 'Just now'; <60 min 'N min ago'; today 'h:mm a' (toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})); yesterday 'Yesterday'; <7 days weekday ('Monday'); else '28 Sep' (+ ' 2025' if another year)
export function dayLabel(dayStr)   // 'Today' | 'Yesterday' | weekday | '28 September' (+ year)
export function localDay(t = Date.now()) // 'YYYY-MM-DD' local
```

**`app/js/account.js`** (FE-A):
```js
export async function initAuth()                 // GET /api/auth/me; fills state.auth; on failure state.auth.server = false; writes 'bs-last-scope' (not dry)
export function initAccountUI(A)                 // binds #btn-account, dialogs #auth #profile, listens to bs:auth-lost and BroadcastChannel 'bs-sync' {t:'auth'}
export function renderAccountButton()
export function openAuth(mode = 'signin', { email = '', reason = '' } = {})   // mode 'signin' | 'signup'
export function openProfile()
export function openAccountMenu(anchor)
export async function signOut({ all = false } = {})
export async function refreshAuth()               // re-GET me; if the scope changed → switchScope
```
Internal `switchScope(me, reason)`: `await tracker.flush()`, `await flushNotes()`, set `state.auth`, `tracker.setScope(scope)`, dispatch `bs:auth-changed` `{user, scope, prevScope, reason}`, broadcast `{t:'auth', scope}`.

**`app/js/library.js`** (FE-B):
```js
export const lib = { loaded: false, scope: null, rev: 0, bookmarks: [], lastPosition: null, chapters: {}, stats: null, activity: [], activityTotal: 0, offline: false, fetchedAt: 0 }
export function initLibrary(A)
export async function loadLibrary({ activity = 50 } = {})    // GET /api/library?today=localDay(); replace lib; re-apply tracker.pendingEvents(); dispatch bs:library-changed {reason:'load'}
export function refreshSoon()                                // debounced 2 s loadLibrary
export function applyLocal(ev)                               // client mirror of §4.6 for chapters/lastPosition/activity (and the stats it can derive: totals, today’s minutes)
export function bookmarkFor(b, c, v = 0)                     // bookmark | null
export function bookmarksInChapter(b, c)                     // Map<v, bookmark> (v 0 = chapter)
export async function toggleBookmark(b, c, v = 0)
export async function addBookmark({ b, c, v = 0, label = '', color = 'red', created })
export async function updateBookmark(id, { label, color })
export async function removeBookmark(id, { undo = true } = {})
export function openBookmarkMenu(anchor, bookmark)
export function chapterState(b, c)                           // { read, readAt, part, visits, seconds, studied: number[] } | null
export function bookProgress(b)                              // { read, total, started, frac }
export async function markChapters(b, cs, read)              // cs: number | number[]
export function currentPosition()                            // newer of lib.lastPosition and localStorage 'bs-pos-v1[:uid]'
export function openLibrary({ book = null, bookmark = null } = {})
export function renderLibrary(opts = {})
```

**`app/js/tracker.js`** (FE-B):
```js
export const CFG = { IDLE_MS: 120000, TICK_MS: 1000, SEEN_DWELL_MS: 1500, SEEN_RATIO: 0.6, READ_COVERAGE: 0.9, OPEN_MIN_S: 3, STUDY_DWELL_S: 8, FLUSH_MS: 30000, MAX_BATCH: 200, MAX_BATCH_BYTES: 48000, KEEPALIVE_MAX_BYTES: 24000, POS_DEBOUNCE_MS: 2000, NOTE_GAP_MS: 600000, TIME_EVENT_MAX_S: 900 }
export function readThreshold(n)                 // clamp(round(n*2.4), 20, 240)
export function initTracker(A)
export function track(type, fields)              // validate minimally, stamp t/day, enqueue, applyLocal
export async function flush({ keepalive = false } = {})   // resolves { sent, pending } (pending > 0 = something could not be sent)
export function setScope(scope)                  // load that scope's outbox; start a fresh chapter visit
export function pendingEvents()                  // queued + pending events (for re-apply)
export function session()                        // { b, c, n, active, seenFrac, read, threshold }
```

### 5.2 `store.js` changes (FE-A)

- `state` additions: `auth: { known: false, server: false, signedIn: false, scope: 'guest', user: null, lost: false, guest: null, limits: null }`, `notesRev: 0`.
- `export function lsKey(base)` → `base` for guest, `` `${base}:${uid}` `` for a profile. Keys: `bs-notes-v1`, `bs-notes-dirty-v1`, `bs-outbox-v1`, `bs-pos-v1`. Global (not per profile): `bs-theme`, `bs-font`, `bs-tr`, `bs-tr2`, `bs-last-scope`.
- `export async function api(method, url, body, { keepalive = false, scoped = true } = {})`:
  ```js
  if (DRY && method !== 'GET') return { ok: false, status: 0, dry: true, data: null };
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') headers['Content-Type'] = 'application/json';
  if (scoped) headers['X-BS-Scope'] = state.auth.scope;
  // fetch(url, { method, headers, credentials: 'same-origin', keepalive, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) })
  // network error → { ok:false, status:0, offline:true, data:null }; parse JSON (tolerate none)
  // 409 scope_mismatch or 401 not_signed_in on a scoped call → dispatch 'bs:auth-lost' with data
  // → { ok, status, data }
  ```
  Methods are written in capitals (`'PATCH'` is not normalised by fetch).
- **Dirty tracking** replaces the whole-object PUT: `dirty: Map<key, {op: 'set'|'del', ts, seq}>` persisted to `lsKey('bs-notes-dirty-v1')`.
  - `touchNote(key)` (existing signature): after today's logic, record `dirty.set(key, note ? {op:'set', ts: note.updated, seq: ++seq} : {op:'del', ts: Date.now(), seq: ++seq})`, then dispatch `notes-changed` (existing) and `bs:note-saved` `{key, deleted}`, then `scheduleSave()`.
  - `scheduleSave()`: unchanged mirror + status behaviour, but the 700 ms timer calls `flushNotes()`.
  - **Compare-and-set bases**: keep `state.noteBase: Map<key, updated|null>` = each note's `updated` as last received from the server (from `GET /api/notes`, `refreshNotes()`, a `conflicts` entry, or `versions` in a changes response; `null` when the server had no note). Persist it with the dirty map.
  - `export async function flushNotes({ keepalive = false } = {})`: snapshot dirty → body `{ baseRev: state.notesRev, set, del, base }` (`base[k] = state.noteBase.get(k) ?? null` for every key in `set`/`del`) → `api('POST', '/api/notes/changes', body, { keepalive })` (skip keepalive when the body > 32,000 bytes). On 200: remove snapshot entries whose `seq` is unchanged; `state.notesRev = rev`; `state.noteBase.set(k, v)` for each `versions` entry; apply `conflicts` (and set their base to the conflict note's `updated`, or `null`) (server note replaces local, `null` deletes) + `A.refreshMarker`/re-render + toast “Your note on John 3:16 changed in another window. Showing the newer version.”; if `stale` → `refreshNotes()`; broadcast `{t:'notes', scope, rev}`; `setSaveStatus('saved')`. Failures → today's `failed`/`local` statuses; dirty kept. Returns `{ pending: dirty.size }`.
  - `export async function refreshNotes()`: GET `/api/notes`; for every key **not** in `dirty` take the server's version (add, replace or delete locally); keep dirty keys; update `notesRev`; re-render markers.
  - `export async function loadNotes()`: if a persisted dirty map exists for the scope → `flushNotes()` first; then GET `/api/notes`; if the response `scope` differs from `state.auth.scope` → `refreshAuth()`; set `state.notes`, `state.notesRev`, mirror to `lsKey('bs-notes-v1')`; re-apply dirty `set` entries from the previous mirror when the flush failed. Fallback (no server) as today, per scope key.
  - `export function importNotes(refs)`: for each ref set `updated = Date.now()`, assign into `state.notes.refs`, mark dirty, `scheduleSave()`. drawer.js Import JSON uses it.
  - `export function bindNotesLifecycle()`: `visibilitychange` hidden and `pagehide` → `flushNotes({ keepalive: true })`; BroadcastChannel `{t:'notes'}` for this scope → `refreshNotes()` when visible.

### 5.3 `index.html` additions (FE-A)

**Top bar.** In `.gnav-left`, directly after `#btn-pick`:
```html
<button id="btn-library" class="ib" type="button" aria-label="Library" aria-haspopup="dialog" title="Library (l)"><svg class="i" aria-hidden="true"><use href="#i-library"/></svg></button>
```
As the **last** child of `.gnav-right` (after `#btn-help`):
```html
<button id="btn-account" class="acct-btn" type="button" aria-haspopup="dialog" aria-label="Sign in" title="Sign in" hidden><svg class="i" aria-hidden="true"><use href="#i-person"/></svg></button>
```
Re-measure `.gnav` `--gnav-side` (expected +39 px: 524 → 563, fallback 548 → 587, <1180 px 416 → 455).

**Sheet header.** In `.sheet-head`, directly after `#save-status`:
```html
<button id="btn-bookmark" class="close-btn plain bm-btn" type="button" aria-pressed="false" aria-label="Bookmark John 3" title="Bookmark (b)"><svg class="i" aria-hidden="true"><use href="#i-bookmark"/></svg></button>
```

**Dialogs** (after `#help`, so `bindDialogs()` wires backdrop click, `[data-close]` and Esc):

```html
<dialog id="auth" class="modal auth" aria-labelledby="auth-title">
  <form id="auth-form" class="modal-form" novalidate>
    <div class="modal-head"><h2 id="auth-title" class="modal-title">Sign in</h2><button type="button" class="close-btn" data-close aria-label="Close"><svg class="i" aria-hidden="true"><use href="#i-xmark"/></svg></button></div>
    <div class="modal-body">
      <p class="auth-lede"><svg class="i" aria-hidden="true"><use href="#i-lock"/></svg><span id="auth-lede">Your notes, bookmarks and reading progress, saved to a profile on this computer.</span></p>
      <div id="auth-mode" class="segmented" role="radiogroup" aria-label="Sign in or create a profile"><span class="seg-ind" aria-hidden="true"></span><button type="button" role="radio" data-mode="signin" aria-checked="true">Sign in</button><button type="button" role="radio" data-mode="signup" aria-checked="false" tabindex="-1">Create profile</button></div>
      <p id="auth-err" class="form-err" role="alert" hidden></p>
      <ul class="group frows auth-fields">
        <li class="frow" data-only="signup" hidden><label for="auth-name">Name</label><input id="auth-name" name="name" autocomplete="name" maxlength="60" spellcheck="false"></li>
        <li class="frow"><label for="auth-email">Email</label><input id="auth-email" name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="off" spellcheck="false" maxlength="254"></li>
        <li class="frow"><label for="auth-password">Password</label><input id="auth-password" name="password" type="password" autocomplete="current-password" maxlength="256" aria-describedby="auth-pw-help"><button type="button" id="auth-pw-eye" class="pw-eye" aria-label="Show password" aria-pressed="false"><svg class="i" aria-hidden="true"><use href="#i-eye"/></svg></button></li>
      </ul>
      <p class="group-foot" id="auth-pw-help" data-only="signup" hidden>At least 8 characters. Stored only on this computer, and only as a secure hash.</p>
      <ul class="group frows auth-opts">
        <li class="frow"><label for="auth-remember">Keep me signed in<small class="frow-sub">For 30 days on this browser</small></label><input id="auth-remember" name="remember" type="checkbox" class="switch" role="switch" checked></li>
        <li class="frow" id="auth-import-row" data-only="signup" hidden><label for="auth-import">Bring over guest data<small class="frow-sub" id="auth-import-meta">12 notes · 3 bookmarks · 5 chapters read</small></label><input id="auth-import" name="importGuest" type="checkbox" class="switch" role="switch" checked></li>
      </ul>
      <p class="group-foot auth-foot" data-only="signin">Forgot your password? In Terminal run <code>python3 ~/bible-study/serve.py --reset-password you@example.com</code></p>
    </div>
    <div class="modal-foot"><button type="button" class="btn btn-plain" data-close>Cancel</button><button type="submit" class="btn btn-primary" id="auth-submit">Sign in</button></div>
  </form>
</dialog>

<dialog id="profile" class="modal" aria-labelledby="profile-title">
  <div class="modal-head"><h2 id="profile-title" class="modal-title">Profile</h2><button type="button" class="close-btn" data-close aria-label="Close"><svg class="i" aria-hidden="true"><use href="#i-xmark"/></svg></button></div>
  <div class="modal-body" id="profile-body"></div>
  <div class="modal-foot"><button type="button" class="btn btn-primary" data-close>Done</button></div>
</dialog>

<dialog id="library" class="modal library" aria-labelledby="library-title">
  <div class="modal-head">
    <div class="lib-titles"><h2 id="library-title" class="modal-title">Library</h2><p class="lib-sub" id="library-sub"></p></div>
    <button type="button" id="lib-more" class="close-btn plain" aria-haspopup="menu" aria-expanded="false" aria-label="Library options" title="Options"><svg class="i" aria-hidden="true"><use href="#i-ellipsis"/></svg></button>
    <button type="button" id="lib-account" class="acct-btn" aria-haspopup="dialog" aria-label="Sign in" title="Sign in"><svg class="i" aria-hidden="true"><use href="#i-person"/></svg></button>
    <button type="button" class="close-btn" data-close aria-label="Close"><svg class="i" aria-hidden="true"><use href="#i-xmark"/></svg></button>
  </div>
  <div class="modal-body lib-body" id="library-body"></div>
</dialog>

<dialog id="confirm" class="modal confirm" aria-labelledby="confirm-title" aria-describedby="confirm-body">
  <form id="confirm-form" class="modal-form" novalidate>
    <div class="modal-head"><h2 id="confirm-title" class="modal-title"></h2></div>
    <div class="modal-body"><p id="confirm-body"></p><ul class="group frows" id="confirm-pw-row" hidden><li class="frow"><label for="confirm-pw">Password</label><input id="confirm-pw" type="password" autocomplete="current-password"></li></ul><p id="confirm-err" class="form-err" role="alert" hidden></p></div>
    <div class="modal-foot"><button type="button" class="btn btn-plain" data-close>Cancel</button><button type="submit" class="btn btn-danger" id="confirm-ok">Delete</button></div>
  </form>
</dialog>
```

**Resume prompt** (next to `#toast`):
```html
<div id="resume" class="resume" role="region" aria-labelledby="resume-t" hidden>
  <span class="tile-i blue" aria-hidden="true"><svg class="i"><use href="#i-book"/></svg></span>
  <div class="resume-body"><p class="resume-k">Continue reading</p><p class="resume-t" id="resume-t">John 3:16</p><p class="resume-s" id="resume-s">Where you left off · 2 days ago</p></div>
  <button type="button" class="btn btn-primary sm" data-resume-go>Continue</button>
  <button type="button" class="close-btn" data-resume-close aria-label="Dismiss"><svg class="i" aria-hidden="true"><use href="#i-xmark"/></svg></button>
</div>
```

**Help** (`#help dl.keys`, after the `n` row):
```html
<dt><kbd class="k">b</kbd></dt><dd>Bookmark the selected verse (or the chapter)</dd>
<dt><kbd class="k">l</kbd></dt><dd>Library: bookmarks, progress and history</dd>
```

New ids: `#btn-library #btn-account #btn-bookmark #auth #auth-form #auth-title #auth-lede #auth-mode #auth-err #auth-name #auth-email #auth-password #auth-pw-eye #auth-pw-help #auth-remember #auth-import-row #auth-import #auth-import-meta #auth-submit #profile #profile-title #profile-body #library #library-title #library-sub #lib-more #lib-account #library-body #confirm #confirm-form #confirm-title #confirm-body #confirm-pw-row #confirm-pw #confirm-err #confirm-ok #resume #resume-t #resume-s`. Dynamic: `#lib-mode #bm-label #prof-*` (below).

### 5.4 `icons.js` additions (FE-A)

24×24, 1.5 px strokes, as the existing set:

| name | inner SVG |
|---|---|
| bookmark | `<path d="M7.5 3.5h9A1.5 1.5 0 0118 5v15.1a.6.6 0 01-.95.49L12 17l-5.05 3.59A.6.6 0 016 20.1V5a1.5 1.5 0 011.5-1.5z"/>` (filled state: `icon('bookmark', 'f')`) |
| library | `<path d="M5.5 6.5a2 2 0 012-2h10v15.5h-10a2 2 0 01-2-2z"/><path d="M5.5 18a2 2 0 012-2h10"/><path d="M10 4.5v6.3l2-1.5 2 1.5V4.5"/>` |
| person | `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="9.8" r="3.1"/><path d="M6.3 18.2c1.4-2 3.3-3 5.7-3s4.3 1 5.7 3"/>` |
| signout | `<path d="M13.5 4.5H7A2.5 2.5 0 004.5 7v10A2.5 2.5 0 007 19.5h6.5"/><path d="M10 12h10M16.5 8.5L20 12l-3.5 3.5"/>` |
| flame | `<path d="M12 20.5c-3.6 0-6-2.4-6-5.7 0-2.6 1.5-4.4 2.9-6.1.4 1.3 1.1 2.2 2.1 2.6 0-3 1.3-5.5 3.5-7.3.3 2.8 1.6 4.4 2.7 5.9 1 1.3 1.8 2.8 1.8 4.9 0 3.3-3.1 5.7-7 5.7z"/>` |
| eye | `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>` |
| eye-slash | `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/>` |
| lock | `<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5v-3a3.5 3.5 0 017 0v3"/>` |

### 5.5 Account entry point (account.js)

- `#btn-account` stays `hidden` until `initAuth()` resolves; hidden permanently when `state.auth.server === false`.
- **Signed out**: person icon; `aria-label="Sign in"`, `title="Sign in"`, `aria-haspopup="dialog"`; click → `openAuth('signin')`.
- **Signed in**: `innerHTML = <span class="acct-av" aria-hidden="true">JK</span>`; `aria-label="Profile: Ji Kim"`, `title="Ji Kim (ji@example.test)"`, `aria-haspopup="menu"`, `aria-expanded`; click → `openAccountMenu(btn)`. After a sign-in add `.pop` for one animation.
- `#lib-account` mirrors the same state and behaviour (it is the phone-friendly entry, since `.gnav-right` scrolls on phones).
- **Account menu** (`ui.openMenu`, `className: 'acct-menu'`, `label: 'Profile'`):
```html
<div class="acct-head" role="presentation"><span class="acct-av lg" aria-hidden="true">JK</span><span><b>Ji Kim</b><small>ji@example.test</small></span></div>
<hr>
<button type="button" role="menuitem" data-acct="library">Library<svg class="i" aria-hidden="true"><use href="#i-library"/></svg></button>
<button type="button" role="menuitem" data-acct="profile">Profile and data<svg class="i" aria-hidden="true"><use href="#i-person"/></svg></button>
<hr>
<button type="button" role="menuitem" data-acct="signout">Sign out<svg class="i" aria-hidden="true"><use href="#i-signout"/></svg></button>
```

### 5.6 Sign-in / create-profile dialog (`#auth`)

- `openAuth(mode)`: reset fields and errors, apply mode, `showModal()`, focus the first empty field (signup: name; signin: email, or password when email is prefilled).
- **Mode** (`#auth-mode` radiogroup, arrow keys via `drawer.radioKeys` pattern): toggles every `[data-only]` element's `hidden`, sets `#auth-title` / `#auth-submit` text (“Sign in” / “Create profile”), password `autocomplete` (`current-password` / `new-password`). `#auth-import-row` is shown only in signup mode **and** when `state.auth.guest.hasData`; `#auth-import-meta` = `12 notes · 3 bookmarks · 5 chapters read` (omit zero parts). Switching mode keeps the email and password.
- `#auth-pw-eye` toggles `type=password|text`, `aria-pressed`, `aria-label` (“Show password”/“Hide password”) and the icon (`eye`/`eye-slash`).
- **Submit** (Enter or button): client validation first (same rules as §3.6; show the first problem only). Then: dry → error “Dry run: sign-in is turned off.”; else set the submit button `disabled` with label “Signing in…” / “Creating…”, `await tracker.flush()` and `await flushNotes()` (so guest data is current before an import), POST, restore the button.
- **Errors**: `#auth-err` shows `ICON(info)` + message and is unhidden; the field's `.frow` gets `.bad` (remove/reflow/re-add to re-shake) and focus. Messages: the server's `message` for `invalid_*`/`weak_password`/`user_limit`; `bad_credentials` “That email and password don’t match a profile on this computer.”; `email_taken` “There’s already a profile for that email.” + an inline `<button class="link" type="button" data-auth-switch="signin">Sign in instead</button>`; `rate_limited` “Too many attempts. Try again in N seconds.”; network “Can’t reach serve.py. Is it running?”. Typing in a field clears its `.bad` and the error.
- **Success**: `closeDialog`, `switchScope(me, 'signin'|'signup')`, toast: sign in “Signed in as Ji Kim.”; sign up “Welcome, Ji. Your profile is ready.” + (import) “ Brought over 12 notes and 5 chapters.”.

### 5.7 Profile dialog (`#profile`, rendered into `#profile-body` by account.js)

```html
<div class="prof-hero"><span class="acct-av xl" aria-hidden="true">JK</span><div><b id="prof-name">Ji Kim</b><small id="prof-email">ji@example.test</small><small>Profile since 28 September 2026</small></div></div>
<p class="form-err" id="prof-err" role="alert" hidden></p>
<h3 class="group-h">Profile</h3>
<ul class="group frows prof-fields">
  <li class="frow"><label for="prof-name-in">Name</label><input id="prof-name-in" autocomplete="name" maxlength="60"></li>
  <li class="frow"><label for="prof-email-in">Email</label><input id="prof-email-in" type="email" autocomplete="username" maxlength="254"></li>
  <li class="frow" id="prof-email-pw-row" hidden><label for="prof-email-pw">Password</label><input id="prof-email-pw" type="password" autocomplete="current-password"></li>
</ul>
<div class="actions"><button type="button" class="btn btn-tinted sm" data-prof="save">Save changes</button></div>
<h3 class="group-h">Password</h3>
<ul class="group frows prof-fields">
  <li class="frow"><label for="prof-pw-cur">Current</label><input id="prof-pw-cur" type="password" autocomplete="current-password"></li>
  <li class="frow"><label for="prof-pw-new">New</label><input id="prof-pw-new" type="password" autocomplete="new-password" aria-describedby="prof-pw-help"></li>
</ul>
<p class="group-foot" id="prof-pw-help">At least 8 characters. Other windows and browsers will be signed out.</p>
<div class="actions"><button type="button" class="btn btn-tinted sm" data-prof="password">Change password</button></div>
<h3 class="group-h">Your data</h3>
<ul class="group av">
  <li><button class="cell" type="button" data-prof="export"><span class="tile-i blue"><svg class="i"><use href="#i-export"/></svg></span><span class="cell-body"><span class="cell-title">Export profile</span><span class="cell-sub">Notes, bookmarks and progress as JSON</span></span></button></li>
  <li><a class="cell" href="/api/export/obsidian" download><span class="tile-i indigo"><svg class="i"><use href="#i-export"/></svg></span><span class="cell-body"><span class="cell-title">Export notes for Obsidian</span><span class="cell-sub">Markdown with [[John 3.16|John 3:16]] links</span></span></a></li>
  [<li id="prof-import-row"><button class="cell" type="button" data-prof="import-guest"><span class="tile-i gold"><svg class="i"><use href="#i-import"/></svg></span><span class="cell-body"><span class="cell-title">Bring over guest data</span><span class="cell-sub" id="prof-import-meta">12 notes · 3 bookmarks from the guest space</span></span></button></li>]   (only when guest.hasData)
</ul>
<h3 class="group-h">Sessions</h3>
<ul class="group"><li><button class="cell" type="button" data-prof="signout-all"><span class="cell-body"><span class="cell-title">Sign out everywhere</span><span class="cell-sub">Every window and browser on this computer</span></span></button></li></ul>
<ul class="group prof-danger"><li><button class="cell danger" type="button" data-prof="delete"><span class="cell-body"><span class="cell-title">Delete profile…</span></span></button></li></ul>
```
- Email: editing `#prof-email-in` reveals `#prof-email-pw-row` (required for an email change).
- `export` → `location.href = '/api/export/profile'` (a download; no request in dry mode).
- `delete` → `confirmDialog({ title: 'Delete this profile?', body: 'This removes Ji Kim’s notes, bookmarks and reading progress from this computer. Guest notes are not affected.', ok: 'Delete profile', password: true })` → `POST /api/account/delete` → on 401 keep the confirm open with `#confirm-err`; on success `switchScope(guest, 'delete')`, toast “Profile deleted.”
- `password` → success toast “Password changed. Other windows were signed out.”

### 5.8 Bookmark controls

- **Drawer header** `#btn-bookmark` (drawer.js `renderHead()`): target = selected verse, else the chapter (search tab: the chapter). `aria-pressed` = bookmarked; `aria-label` “Bookmark John 3:16” / “Remove bookmark from John 3:16”; `title` “Bookmark (b)” / “Remove bookmark (b)”; icon `use` href stays `#i-bookmark`, the svg gets class `f` when pressed; `data-bm-color` = the bookmark colour. Click → `A.toggleBookmark()`.
- **Key `b`** → `A.toggleBookmark()` (same target rule).
- **Add** → toast “Bookmarked John 3:16.” with action `{ label: 'Add label', run: () => library.openBookmarkMenu(#btn-bookmark or the verse's .b-bm, bm) }`. **Remove** → toast “Removed bookmark from John 3:16.” with `{ label: 'Undo' }` (re-POST with the same `label`, `color`, `created`).
- **Verse gutter** (reader.js `badgesHtml(note, bm)`): when the verse is bookmarked the `.badges` span starts with
  `<button class="b-bm" type="button" data-bm-v="16" data-bm-color="red" tabindex="-1" aria-label="Bookmarked: Gospel in a verse. Edit bookmark" title="Gospel in a verse">ICON(bookmark,'f')</button>` (label omitted from text when empty: “Bookmarked. Edit bookmark”). Click → `library.openBookmarkMenu(btn, bm)` (reader click handler checks `.b-bm` before `.verse`).
- **Chapter**: reader footer `[data-bm-chapter]` (§5.11).
- **Bookmark menu** (`ui.openMenu`, `className: 'bm-menu'`, `label: 'Bookmark John 3:16'`, focus `#bm-label`):
```html
<div class="bm-menu-head" role="presentation">
  <label class="field sm"><input id="bm-label" placeholder="Add a label" maxlength="80" aria-label="Bookmark label" autocomplete="off" value="Gospel in a verse"></label>
  <div class="bm-colors" role="radiogroup" aria-label="Colour">
    <button type="button" role="radio" class="bm-sw" data-bm-color="red" aria-checked="true" aria-label="Red">ICON(check)</button>
    … orange, yellow, green, blue, purple (aria-label capitalised colour name) …
  </div>
</div>
<hr>
[<button type="button" role="menuitem" data-bmi="go">Go to passage ICON(arrow-right)</button>]   (only when not the current chapter)
<button type="button" role="menuitem" data-bmi="library">Show in Library ICON(library)</button>
<hr>
<button type="button" role="menuitem" class="danger" data-bmi="remove">Remove bookmark ICON(trash)</button>
```
  Label saves on Enter and when the menu closes (if changed; `PATCH`). A swatch saves immediately and moves `aria-checked`. ArrowDown from the input moves to the first swatch; Left/Right move between swatches.

### 5.9 Leave off: resume on load and the prompt

- **Fresh load without a hash** and a `currentPosition()` exists: before the first render set `state.book/chapter` from it; after `readerP` resolves call `A.resume(pos, { silent: true })`; toast “Picked up where you left off: John 3:16.” (not when `v` is 0: “…: John 3.”).
- **Load with a hash** whose chapter differs from the position, and `Date.now() − pos.t < 60 days`: show `#resume` (`resume-t` = `refLabel(pos)`, `resume-s` = “Where you left off · ” + `relTime(pos.t)`), add `body.has-resume`. `[data-resume-go]` → `A.resume(pos)`; `[data-resume-close]`, any `A.navigate`, Esc (first in the Esc chain), or 15 s → hide (`.out` then `hidden` after 300 ms, remove `body.has-resume`). Never shown while the phone sheet is open.
- After sign-in/sign-up: if the profile's position is in another chapter → show `#resume`.
- `A.resume(pos, { silent })`: `A.navigate(pos.b, pos.c, 0)`, then after `readerP`: scroll `#v{pos.v}` to the top area (`el.scrollIntoView({ block: 'start', behavior: 'auto' })`, which honours `scroll-padding-top`); `v = 0` → top. No verse is selected.
- The position is also written to `localStorage[lsKey('bs-pos-v1')]` on every position event (not dry) so a resume works even before the server call completes.

### 5.10 Library view (`#library`, library.js)

Open: `#btn-library`, key `l`, account menu “Library”, “Show in Library”, toasts. `openLibrary()` renders from cache (skeleton if never loaded), `showModal()`, then `loadLibrary({activity: 50})` and re-renders with `keepScroll`.

Head: `#library-sub` = “Ji Kim · saved on this computer” / “Guest · saved on this computer”. `#lib-more` menu: “Export profile (JSON)” ICON(export), “Export notes for Obsidian” ICON(export) (`<a download>`), `<hr>`, “Clear activity history…”, “Reset reading progress…” (`.danger`), “Remove all bookmarks…” (`.danger`) — each via `confirmDialog` then `POST /api/library/reset`.

Body (`#library-body` innerHTML = `<div class="view[ push| pop]">…</div>`, same animation classes as the sheet):

```html
[<div class="notice lib-guest" role="note">ICON(person)<p>Studying as a guest<small>Create a profile to keep notes, bookmarks and progress under your name.</small></p><button class="btn btn-tinted sm" type="button" data-lib-auth="signup">Create profile</button><button class="btn btn-plain sm" type="button" data-lib-auth="signin">Sign in</button></div>]   (signed out, server reachable)

[<section class="lib-continue" data-div="gospels">
  <div class="lc-body"><p class="lc-k">Continue reading</p><h3 class="lc-t">John 3:16</h3><p class="lc-q">For God so loved the world…</p><p class="lc-s">2 hours ago · 42% through John 3</p><div class="lc-prog" style="--p:.42"><i></i></div></div>
  <button class="btn btn-primary" type="button" data-lib-resume>Continue ICON(arrow-right)</button>
  [<div class="lib-recent" role="group" aria-label="Recently opened"><button class="chip" type="button" data-lib-go="19.23">Psalm 23</button>… up to 5 other chapters by lastRead</div>]
</section>]   (only when a position exists; data-div = divSlug(book); .lc-q from previewText, clipped 160)

<section class="lib-stats" aria-label="Your study">
  <div class="lib-stat"><span class="tile-i orange">ICON(flame)</span><small>Streak</small><b>6<small> days</small></b><span class="lib-stat-s">Longest 14 days</span></div>
  <div class="lib-stat"><span class="tile-i blue">ICON(clock)</span><small>Time studied</small><b>3<small> h</small> 20<small> min</small></b><span class="lib-stat-s">45 min this week</span></div>
  <div class="lib-stat"><span class="tile-i indigo">ICON(book)</span><small>Chapters read</small><b>128</b><span class="lib-stat-s">11% of the Bible</span></div>
  <div class="lib-stat"><span class="tile-i green">ICON(check)</span><small>Verses studied</small><b>342</b><span class="lib-stat-s">in 58 chapters</span></div>
</section>

<section class="lib-card lib-chart">
  <div class="lh"><h3>Last 90 days</h3><span>12 h 5 min · 41 days</span></div>
  <div class="lib-bars" role="img" aria-label="Minutes studied per day for the last 90 days, most recent on the right. Busiest day: 28 September, 64 minutes."><i style="--h:.42;--i:0" title="Mon 1 Jul · 27 min"></i> … 90 bars; zero days get class "z"; the last bar gets class "today"</div>
  <div class="lib-axis"><span>1 Jul</span><span>15 Aug</span><span>Today</span></div>
</section>

<div class="lib-cols">
  <section class="lib-sec" id="lib-bookmarks">
    <div class="lh"><h3>Bookmarks</h3><span>7</span></div>
    <ul class="group av lib-bms">
      <li class="bm" data-bm="bm_4f1c2a9e0b7d"><button class="cell" type="button" data-lib-go="43.3.16"><span class="bm-rib" data-bm-color="red">ICON(bookmark,'f')</span><span class="cell-body"><span class="cell-title">John 3:16</span><span class="cell-sub">[<b class="bm-label">Gospel in a verse</b> · ]<span data-preview="43.3.16"></span></span></span><span class="cell-trail"><span class="vn">2 d</span></span></button><button class="more-btn" type="button" data-bm-menu aria-haspopup="menu" aria-expanded="false" aria-label="More actions for John 3:16">ICON(ellipsis)</button></li>
    </ul>
  </section>
  <section class="lib-sec" id="lib-activity">
    <div class="lh"><h3>Recent activity</h3><span>812</span></div>
    <h4 class="act-day">Today</h4>
    <ul class="group lib-acts">
      <li class="act"><span class="tile-i blue">ICON(link)</span><span class="act-body"><span class="act-t">Followed <button class="link" type="button" data-lib-go="43.3.16">John 3:16</button> to <button class="link" type="button" data-lib-go="45.5.8">Romans 5:8</button></span></span><time datetime="2026-09-28T15:04">3:04 PM</time></li>
    </ul>
    … further days …
    [<button class="btn btn-gray btn-wide" type="button" data-more-activity>Show more</button>]   (GET with before=<oldest t>, activity=100)
  </section>
</div>

<section class="lib-sec" id="lib-progress">
  <div class="lh"><h3>Bible progress</h3><span>128 of 1,189 chapters</span></div>
  <div class="lib-testament"><h4><i class="ot"></i>Old Testament<span>74 of 929</span></h4>
    <div class="lib-books"><button class="lib-book[ hot][ done]" type="button" data-lib-book="1" style="--p:.24" aria-label="Genesis, 12 of 50 chapters read"><span class="lb-name">Genesis</span><span class="lb-frac">12/50</span>[ICON(check)]</button>…39</div></div>
  <div class="lib-testament"><h4><i class="nt"></i>New Testament<span>54 of 260</span></h4><div class="lib-books">…27</div></div>
</section>
```

- `.lib-bars` heights: `--h = minutes / max(1, max of minutes90)`; bar `title` = `weekday day month · N min`; axis labels: the first day, the middle day and “Today” (`d MMM`).
- `.lib-book`: `--p = read/total`; `.hot` when `--p > .55` (white text, as `.pch.hot`); `.done` when read = total (check icon).
- Activity text templates (refs rendered with `refLabel`, each ref a `.link[data-lib-go]`; icon tile colour in brackets):

| type | text | sub (`.act-s`) | tile |
|---|---|---|---|
| chapter.open | Opened {John 3} | – | book (blue) |
| chapter.read | Read {John 3} | – | check (green) |
| chapter.mark | Marked {John 3} as read / unread; bulk: Marked 21 chapters of {John} as read | – | check (green) |
| verse.study | Studied {John 3:16} | – | sparkle (indigo) |
| xref.open | Followed {John 3:16} to {Romans 5:8} | – | link (blue) |
| word.study | Looked up {G25} in {John 3:16} (strong as plain text; no strong → “a word”) | – | alpha (indigo) |
| note.save | Wrote a note on {John 3:16} | – | note (blue) |
| video.add | Added a video to {John 3:16} | the title | play-rect (red) |
| bookmark.add | Bookmarked {John 3:16} | the label | bookmark (orange) |
| bookmark.remove | Removed the bookmark on {John 3:16} | – | bookmark (gray, plain `.tile-i`) |
| profile.create | Created this profile | – | person (blue) |
| profile.import | Brought over guest notes and progress | “12 notes · 5 chapters” | import (gold) |

- Clicking any `[data-lib-go]` → `closeDialog(#library)`, `A.navigate(b, c, v)`, `A.yieldToPage()`.
- `[data-bm-menu]` → `openBookmarkMenu(btn, bm)`. Previews: fill `[data-preview]` sequentially with `previewText` (clip 110) after render.
- **Per-book view** (`[data-lib-book]` → render with `push`; `[data-lib-back]` → `pop`):
```html
<div class="navbar"><button class="back" type="button" data-lib-back>ICON(chev-left)Library</button></div>
<div class="lib-book-head"><div><h3 class="pc-title">Genesis</h3><p class="pc-sub">12 of 50 chapters read · 2 h 10 min · 34 verses studied</p></div>
  <div class="segmented sm" id="lib-mode" role="radiogroup" aria-label="When you tap a chapter"><span class="seg-ind" aria-hidden="true"></span><button type="button" role="radio" data-lib-mode="open" aria-checked="true">Open</button><button type="button" role="radio" data-lib-mode="mark" aria-checked="false" tabindex="-1">Mark read</button></div></div>
<div class="chgrid lib-chgrid[ marking]"><button class="pch[ read][ part][ cur]" type="button" data-b="1" data-c="1" aria-label="Chapter 1, read 28 Sep, 3 verses studied"[ aria-pressed="true|false" in mark mode]>1</button>…</div>
<div class="lib-legend" aria-hidden="true"><span><i class="read"></i>Read</span><span><i class="part"></i>Started</span><span><i></i>Not started</span></div>
<div class="actions"><button class="btn btn-tinted sm" type="button" data-lib-markbook="read">Mark all as read</button><button class="btn btn-plain sm" type="button" data-lib-markbook="unread">Clear marks</button></div>
[<div class="lh"><h3>Studied in Genesis</h3><span>34 verses</span></div><div class="topic-chips"><button class="chip" type="button" data-lib-go="1.1.1">Genesis 1:1</button>…(max 60, then “and N more”)</div>]
```
  Open mode: tap = navigate (close the Library). Mark mode: tap toggles read via `markChapters(b, c, !read)` (optimistic). `.part` = started or studied but not read; `.cur` = the chapter in the reader. `Clear marks` confirms first (“Clear the read marks in Genesis?”).
- **Empty states**: bookmarks “No bookmarks yet” / “Press b, or tap the ribbon in the study panel, to bookmark a verse or a chapter.” (ICON bookmark); activity “Your study history appears here” / “Open a chapter and start reading. Progress is saved automatically.” (ICON clock); offline “Library needs serve.py” / “Start it with python3 ~/bible-study/serve.py, then reload.” (ICON info).
- **Refresh**: on `visibilitychange` → visible, `refreshIfStale(60000)`; on BroadcastChannel `{t:'library', scope}` → `refreshSoon()`. After every successful write, broadcast `{t:'library', scope, rev}`.

### 5.11 Reader (reader.js, FE-B)

1. `badgesHtml(note, bm)` → bookmark button (§5.8) first inside `.badges`; `refreshVerseMarker(v)` passes `bookmarkFor(b, c, v)`.
2. Hero eyebrow: append `<span class="read-pill"[ hidden]>ICON(check)Read</span>` (visible when `chapterState(b,c)?.read`).
3. Footer: before `.foot-nav` emit
```html
<div class="foot-actions" role="group" aria-label="This chapter">
  <button class="pill-tog foot-read" type="button" data-mark-read aria-pressed="false">ICON(check)<span>Mark as read</span></button>
  <button class="pill-tog foot-bm" type="button" data-bm-chapter aria-pressed="false" data-bm-color="red">ICON(bookmark)<span>Bookmark chapter</span></button>
</div>
```
   Pressed labels: “Read” and “Bookmarked” (bookmark icon gets class `f`). Clicks → `A.markRead(b, c, !read)` (toast “Marked John 3 as read.” with Undo) and `A.toggleBookmark(b, c, 0)`.
4. After `el.innerHTML = html` (and the signature call): `document.dispatchEvent(new CustomEvent('bs:chapter-rendered', { detail: { b, c, fresh, n } }))`.
5. `export function refreshLibraryMarks()`: toggle `.read-pill` (`hidden` / add `.in` for one animation when it just became read), both footer buttons, and re-render the bookmark badges of every verse in the chapter.
6. Click delegation: `.b-bm` (before `.verse`), `[data-mark-read]`, `[data-bm-chapter]`.

### 5.12 Drawer (drawer.js, FE-B)

1. `renderHead()`: `#btn-bookmark` state (§5.8).
2. `bindDrawer()`: `#btn-bookmark` click → `A.toggleBookmark()`.
3. `expandXref(li)` when it **opens** a row: `document.dispatchEvent(new CustomEvent('bs:xref-opened', { detail: { b: state.book, c: state.chapter, v: state.selected, to: `${li.dataset.b}.${li.dataset.c}.${li.dataset.v}` } }))`.
4. Strong's button click (push view) and `.ow` click: dispatch `bs:word-studied` `{ b, c, v, strong, word }` (`v` = `state.selected`; skip when no verse).
5. `bindMedia` submit success: dispatch `bs:video-added` `{ key, title }`.
6. Import JSON: `importNotes(j.refs)` instead of `Object.assign(...)` + `scheduleSave()`.

### 5.13 main.js (FE-A)

- Imports: `account.js`, `library.js`, `tracker.js`, `ui.js`.
- **Boot** (replacing the current `loadNotes/loadConfig` line):
  ```
  meta → await initAuth() → await Promise.all([loadNotes(), loadConfig(), loadLibrary()])
  const hadHash = /^#\d+\/\d+/.test(location.hash); readHash(); const pos = currentPosition();
  if (!hadHash && pos) { state.book = pos.b; state.chapter = pos.c; state.selected = null; resumeOnBoot = pos; }
  … existing init …; initAccountUI(A); initLibrary(A); initTracker(A); bindNotesLifecycle();
  after readerP: if (resumeOnBoot) A.resume(resumeOnBoot, { silent: true }) + toast; else if (hadHash && pos && other chapter && recent) showResume(pos)
  ```
  The existing dry/offline toasts keep priority (show the resume toast only when neither fired).
- **A additions**: `toggleBookmark(b = state.book, c = state.chapter, v = state.selected || 0)`, `openLibrary(opts)`, `resume(pos, opts)`, `markRead(b, c, read)`, `onScopeChange({ prevScope, reason })` (hide resume; `await Promise.all([loadNotes(), loadLibrary()])`; `render({ keepScroll: true })`; refresh the picker if open; maybe show resume), `closeDialog(d)`, `showDialog(d)` (`if (!d.open) d.showModal()`), `refreshLibraryMarks()` (`reader.refreshLibraryMarks()`, `drawer.renderHead()`, picker refresh if open).
- `A.select`: dispatch `bs:verse-selected` `{ b, c, v }`; when `o.word != null || o.strong` also `bs:word-studied`.
- `A.navigate`: hide `#resume`.
- **Listeners**: `bs:library-changed` → `A.refreshLibraryMarks()`; `bs:auth-changed` → `A.onScopeChange(detail)`; `bs:auth-lost` (account.js owns the toast).
- **Keyboard** (§7.3 of spec.md): also ignore keys while `document.querySelector('.menu')`; add `b` → `A.toggleBookmark()` and `l` → `A.openLibrary()`; Esc: hide `#resume` first if visible.
- **Picker**: `showChapters(b)` adds `.read` + `<svg class="i pch-chk" aria-hidden="true"><use href="#i-check"/></svg>` to read chapters and appends “, read” to `aria-label`; `openPicker()` sets `.prog` and `style="--p:<frac>"` on each `.pbook` with any read chapter.
- `#btn-library` click → `A.openLibrary()`.

### 5.14 DOM events (the only coupling between modules besides imports)

| Event (on `document`) | detail | Fired by | Consumed by |
|---|---|---|---|
| `bs:chapter-rendered` | `{b, c, fresh, n}` | reader.js | tracker.js |
| `bs:verse-selected` | `{b, c, v}` | main.js | tracker.js |
| `bs:xref-opened` | `{b, c, v, to}` | drawer.js | tracker.js |
| `bs:word-studied` | `{b, c, v, strong?, word?}` | drawer.js, main.js | tracker.js |
| `bs:note-saved` | `{key, deleted}` | store.js | tracker.js (`note.save`, 10 min gap per key; skipped when `deleted`) |
| `bs:video-added` | `{key, title}` | drawer.js | tracker.js |
| `bs:library-changed` | `{reason}` | library.js | main.js |
| `bs:auth-changed` | `{user, scope, prevScope, reason}` | account.js | main.js |
| `bs:auth-lost` | server error body | store.js `api()`, tracker.js | account.js: `state.auth.lost = true`, pause scoped writes, toast “You’ve been signed out. Sign in to keep saving to Ji Kim.” with action “Sign in” → `openAuth('signin', { email })`. Signing in as the same uid resumes and flushes; any other outcome → `switchScope` (held data stays in that uid's localStorage keys) |
| `notes-changed` | – (existing) | store.js | unchanged |

BroadcastChannel `'bs-sync'` messages: `{t:'active', id, at}`, `{t:'notes', scope, rev}`, `{t:'library', scope, rev}`, `{t:'auth', scope}`. On `auth` with a scope different from this tab's → `refreshAuth()` and toast “Signed in as Ji Kim in another window.” / “Signed out in another window.”

**Sign-out sequence** (account.js): `await tracker.flush()`; `await flushNotes()`; if either reports pending items → toast “Can’t reach serve.py, so you’re still signed in.” and stop; `POST /api/auth/logout {all}`; remove `lsKey` entries for that uid (`bs-notes-v1`, `bs-pos-v1`, and `bs-outbox-v1`/`bs-notes-dirty-v1` only if empty); `switchScope(guest, 'signout')`; toast “Signed out. You’re studying as a guest.”

### 5.15 styles.css additions (FE-A; append as a new section before “Reduced motion”)

Edit the two existing settings-row selectors so switches are not styled as text fields: `.frow input:not([type=range])` → `.frow input:not([type=range]):not([type=checkbox])` (base rule, its `:focus` rule and the <700 px override).

```css
/* =====================================================================
   Profiles, bookmarks, library and reading progress
   ===================================================================== */
:root { --bm-red: #ff3b30; --bm-orange: #ff9500; --bm-yellow: #ffcc00; --bm-green: #34c759; --bm-blue: #007aff; --bm-purple: #af52de;
  --tile-green: #248a3d; --tile-orange: #c93400; --av-grad: linear-gradient(180deg, #a5abb8, #858994); }
/* dark set: paste into both dark blocks of §1 of spec.md */
/*  --bm-red: #ff453a; --bm-orange: #ff9f0a; --bm-yellow: #ffd60a; --bm-green: #30d158; --bm-blue: #0a84ff; --bm-purple: #bf5af2; --tile-green: #30d158; --tile-orange: #ff9f0a; */
[data-bm-color="red"] { --bm: var(--bm-red); } [data-bm-color="orange"] { --bm: var(--bm-orange); } [data-bm-color="yellow"] { --bm: var(--bm-yellow); }
[data-bm-color="green"] { --bm: var(--bm-green); } [data-bm-color="blue"] { --bm: var(--bm-blue); } [data-bm-color="purple"] { --bm: var(--bm-purple); }
.tile-i.green { background: color-mix(in srgb, var(--tile-green) 16%, transparent); color: var(--tile-green); }
.tile-i.orange { background: color-mix(in srgb, var(--tile-orange) 16%, transparent); color: var(--tile-orange); }

/* account */
.acct-btn { position: relative; flex: none; width: 34px; height: 34px; display: inline-grid; place-items: center; border-radius: 50%; color: var(--label-2); transition: background-color var(--d-1), color var(--d-1), transform var(--d-1) var(--ease-out); }
.acct-btn:hover { background: var(--fill-2); color: var(--label); }
.acct-btn:active { transform: scale(.92); }
.acct-btn .i { width: 21px; height: 21px; }
.acct-btn[aria-expanded="true"] .acct-av { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent); }
.acct-btn.pop .acct-av { animation: pop .5s var(--spring); }
.acct-av { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; background: var(--av-grad); color: #fff; font: 600 11.5px/1 var(--sans); letter-spacing: .01em; user-select: none; }
.acct-av.lg { width: 40px; height: 40px; font-size: 15px; }
.acct-av.xl { width: 64px; height: 64px; font: 500 24px/1 var(--display); }
.acct-menu { min-width: 250px; }
.acct-head { display: flex; align-items: center; gap: 10px; padding: 8px 10px 10px; }
.acct-head b { display: block; font: 600 14px/1.25 var(--sans); color: var(--label); }
.acct-head small { display: block; max-width: 180px; font-size: 12px; color: var(--label-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* auth + profile dialogs */
dialog.auth { max-width: 440px; }
.auth-lede { display: flex; gap: 8px; align-items: flex-start; margin: 0 4px 16px; font-size: 14px; line-height: 1.45; color: var(--label-2); }
.auth-lede .i { width: 16px; height: 16px; margin-top: 2px; color: var(--label-3); }
#auth-mode { display: flex; width: 100%; margin: 0 0 14px; }
#auth-mode > button { flex: 1; }
.form-err { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 12px; padding: 10px 12px; border-radius: var(--r-sm); background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--danger); font-size: 13px; line-height: 1.4; }
.form-err[hidden] { display: none; }
.form-err .i { flex: none; width: 16px; height: 16px; margin-top: 1px; }
.auth-fields .frow > label, .prof-fields .frow > label { flex: none; width: 84px; }
.auth-fields .frow input, .prof-fields .frow input { flex: 1; width: auto; text-align: left; }
.auth-opts { margin-top: 14px; }
.frow > label small.frow-sub { display: block; margin-top: 2px; font-size: 12px; color: var(--label-2); }
.frow.bad input { box-shadow: inset 0 0 0 1px var(--danger), 0 0 0 3px color-mix(in srgb, var(--danger) 18%, transparent); animation: shake .4s var(--ease-io); }
.pw-eye { flex: none; width: 30px; height: 30px; margin-left: -8px; display: grid; place-items: center; border-radius: 8px; color: var(--label-3); }
.pw-eye:hover { background: var(--fill-2); color: var(--label); }
.pw-eye .i { width: 17px; height: 17px; }
[data-only][hidden] { display: none !important; }
.switch { appearance: none; -webkit-appearance: none; flex: none; position: relative; width: 51px; height: 31px; margin: 0; border-radius: 16px; background: var(--fill); cursor: pointer; transition: background-color var(--d-3) var(--ease-out); }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 27px; height: 27px; border-radius: 50%; background: #fff; box-shadow: var(--sh-thumb); transition: transform var(--d-3) var(--spring); }
.switch:checked { background: var(--sw-green); }
.switch:checked::after { transform: translateX(20px); }
.switch:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.auth-foot code { padding: 1px 5px; border-radius: 5px; background: var(--fill-2); font: 500 11.5px/1.5 var(--mono); color: var(--label); overflow-wrap: anywhere; }
.prof-hero { display: flex; align-items: center; gap: 16px; margin: 0 4px 10px; }
.prof-hero b { display: block; font: 700 20px/1.2 var(--display); letter-spacing: -.02em; }
.prof-hero small { display: block; margin-top: 2px; font-size: 13px; color: var(--label-2); }
.prof-danger { margin-top: 22px; }
.cell.danger .cell-title { color: var(--danger); }
dialog.confirm { max-width: 400px; }
.confirm .modal-body > p { margin: 0 0 12px; font-size: 14px; line-height: 1.45; color: var(--label-2); }
.btn-danger { background: var(--danger); color: #fff; }
.btn-danger:hover { filter: brightness(1.06); }

/* bookmarks */
.bm-btn[aria-pressed="true"] { color: var(--bm, var(--bm-red)); }
.bm-btn[aria-pressed="true"] .i { animation: bmIn .45s var(--spring); }
@keyframes bmIn { from { transform: translateY(-4px) scale(.7); opacity: .3; } }
.badges .b-bm { display: inline-grid; place-items: center; color: var(--bm, var(--bm-red)); border-radius: 4px; }
.badges .b-bm:focus-visible { outline-offset: 1px; }
.bm { display: flex; align-items: center; }
.bm .cell { flex: 1; min-width: 0; padding-right: 4px; }
.bm-rib { flex: none; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; background: color-mix(in srgb, var(--bm) 16%, transparent); color: var(--bm); }
.bm-rib .i { width: 16px; height: 16px; }
.bm-label { font-weight: 600; color: var(--label); }
.bm-menu { min-width: 260px; }
.bm-menu-head { padding: 6px 6px 4px; }
.field.sm { height: 34px; border-radius: 9px; }
.bm-colors { display: flex; gap: 10px; padding: 10px 4px 4px; }
.menu .bm-colors .bm-sw { width: 24px; height: 24px; padding: 0; justify-content: center; border-radius: 50%; background: var(--bm); color: #fff; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.12); transition: transform var(--d-2) var(--spring); }
.menu .bm-colors .bm-sw:hover, .menu .bm-colors .bm-sw:focus-visible { background: var(--bm); transform: scale(1.08); outline: 2px solid var(--focus); outline-offset: 2px; }
.menu .bm-colors .bm-sw:active { transform: scale(.92); }
.bm-sw .i { width: 12px; height: 12px; stroke-width: 2.6; opacity: 0; }
.bm-sw[aria-checked="true"] .i { opacity: 1; }

/* reader: read state + chapter actions */
.read-pill { display: inline-flex; align-items: center; gap: 3px; margin-left: 10px; padding: 3px 8px 3px 6px; border-radius: var(--r-pill); background: var(--fill-2); font: 600 12px/1 var(--sans); color: var(--label-2); vertical-align: 1px; }
.read-pill[hidden] { display: none; }
.read-pill .i { width: 12px; height: 12px; stroke-width: 2.4; color: var(--accent); }
.read-pill.in { animation: pop .5s var(--spring); }
.foot-actions { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; max-width: calc(var(--measure) + 110px); margin: 64px auto 0; }
.foot-actions + .foot-nav { margin-top: 20px; }
.pill-tog.foot-bm[aria-pressed="true"] { background: color-mix(in srgb, var(--bm) 16%, transparent); color: var(--label); }
.pill-tog.foot-bm[aria-pressed="true"] .i { color: var(--bm); }

/* picker marks */
.pch .pch-chk { position: absolute; right: 4px; bottom: 4px; width: 11px; height: 11px; stroke-width: 2.6; opacity: .85; }
.pch.read:not(.hot) .pch-chk { color: var(--accent); }
.pbook.prog { position: relative; }
.pbook.prog::after { content: ""; position: absolute; left: 8px; right: 8px; bottom: 2px; height: 2px; border-radius: 1px; background: linear-gradient(90deg, var(--accent) calc(var(--p) * 100%), var(--fill) 0); }

/* library */
dialog.library { max-width: 1040px; height: min(860px, calc(100vh - 48px)); height: min(860px, calc(100dvh - 48px)); background: var(--bg); }
.library .modal-head { padding-bottom: 12px; }
.lib-titles { flex: 1; min-width: 0; }
.lib-sub { margin: 2px 0 0; font-size: 13px; color: var(--label-2); }
.lib-body { padding: 4px 28px 32px; }
.lib-body .notice { max-width: none; margin: 0 0 14px; }
.lib-continue { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px 20px; padding: 22px 24px; border-radius: var(--r-xl); background: var(--bg-elev); box-shadow: var(--sh-2); }
.lc-k { margin: 0 0 4px; font: 600 12px/1.2 var(--sans); color: var(--label-2); }
.lc-t { margin: 0; font: 700 34px/1.05 var(--display); letter-spacing: -.028em; background: var(--grad-num); -webkit-background-clip: text; background-clip: text; color: transparent; padding-right: .04em; }
.lc-q { margin: 8px 0 0; max-width: 40em; font: 400 16px/1.5 var(--serif); color: var(--read); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.lc-s { margin: 8px 0 0; font-size: 13px; color: var(--label-2); font-variant-numeric: tabular-nums; }
.lc-prog { max-width: 280px; height: 4px; margin-top: 10px; border-radius: 2px; background: var(--fill); overflow: hidden; }
.lc-prog i { display: block; width: calc(var(--p) * 100%); height: 100%; border-radius: inherit; background: var(--accent); }
.lib-recent { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px; }
.lib-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
.lib-stat { min-width: 0; padding: 14px 14px 13px; border-radius: var(--r-lg); background: var(--bg-elev); box-shadow: var(--sh-1); }
.lib-stat .tile-i { width: 28px; height: 28px; margin-bottom: 10px; }
.lib-stat .tile-i .i { width: 16px; height: 16px; }
.lib-stat > small { display: block; font: 500 12px/1.2 var(--sans); color: var(--label-2); }
.lib-stat b { display: block; margin-top: 4px; font: 700 26px/1.1 var(--display); letter-spacing: -.025em; font-variant-numeric: tabular-nums; color: var(--label); }
.lib-stat b small { font: 600 15px/1 var(--display); letter-spacing: -.01em; color: var(--label-2); }
.lib-stat-s { display: block; margin-top: 4px; font-size: 12px; color: var(--label-3); }
.lib-card { margin-top: 14px; padding: 0 18px 16px; border-radius: var(--r-lg); background: var(--bg-elev); box-shadow: var(--sh-1); }
.lib-card > .lh:first-child { margin-top: 14px; }
.lib-bars { display: grid; grid-template-columns: repeat(90, minmax(0, 1fr)); align-items: end; gap: 2px; height: 72px; }
.lib-bars i { display: block; height: max(2px, calc(var(--h) * 100%)); border-radius: 2px 2px 1px 1px; background: var(--accent); opacity: .88; transform-origin: bottom; animation: barUp .8s var(--ease-out) both; animation-delay: calc(var(--i) * 6ms); }
.lib-bars i.z { height: 2px; background: var(--fill); opacity: 1; animation: none; }
.lib-bars i.today { opacity: 1; }
@keyframes barUp { from { transform: scaleY(0); } }
.lib-axis { display: flex; justify-content: space-between; margin-top: 6px; font-size: 11px; color: var(--label-3); font-variant-numeric: tabular-nums; }
.lib-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0 20px; }
.lib-sec { min-width: 0; }
.act-day { margin: 14px 4px 6px; font: 600 13px/1.2 var(--sans); color: var(--label-2); }
.lib-sec > .lh + .act-day { margin-top: 4px; }
.lib-acts .act { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 9px 14px; }
.lib-acts > li + li::before { left: 54px; }
.act .tile-i { width: 28px; height: 28px; }
.act .tile-i .i { width: 15px; height: 15px; }
.act-body { flex: 1; min-width: 0; }
.act-t { display: block; font-size: 14px; line-height: 1.35; color: var(--label); }
.act-t .link { font: inherit; font-weight: 600; }
.act-s { display: block; margin-top: 1px; font-size: 12px; color: var(--label-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.act time { flex: none; font-size: 12px; color: var(--label-3); font-variant-numeric: tabular-nums; }
.lib-testament h4 { display: flex; align-items: center; gap: 6px; margin: 14px 4px 8px; font: 600 13px/1.2 var(--sans); color: var(--label-2); }
.lib-testament h4 i { width: 7px; height: 7px; border-radius: 50%; }
.lib-testament h4 i.ot { background: var(--ot); } .lib-testament h4 i.nt { background: var(--nt); }
.lib-testament h4 span { margin-left: auto; font-weight: 500; color: var(--label-3); font-variant-numeric: tabular-nums; }
.lib-books { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 6px; }
.lib-book { position: relative; display: flex; flex-direction: column; align-items: flex-start; justify-content: space-between; height: 58px; padding: 8px 10px 9px; border-radius: 10px; text-align: left; color: var(--label); background: var(--bg-elev); background: color-mix(in srgb, var(--accent) calc(var(--p, 0) * 78%), var(--bg-elev)); box-shadow: 0 0 0 .5px var(--sep); transition: transform var(--d-2) var(--spring), box-shadow var(--d-2); }
.lib-book:hover { box-shadow: 0 0 0 .5px var(--sep), 0 6px 14px rgba(0,0,0,.08); }
.lib-book:active { transform: scale(.96); }
.lib-book.hot { color: #fff; }
.lb-name { max-width: calc(100% - 14px); font: 600 13px/1.2 var(--sans); letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lb-frac { font: 500 11px/1 var(--sans); font-variant-numeric: tabular-nums; color: var(--label-2); }
.lib-book.hot .lb-frac { color: rgba(255,255,255,.85); }
.lib-book > .i { position: absolute; top: 8px; right: 8px; width: 13px; height: 13px; stroke-width: 2.6; }
.lib-book-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin: 4px 0 14px; }
.lib-book-head .segmented { width: 200px; }
.lib-chgrid .pch.read { background: var(--accent); color: #fff; }
.lib-chgrid .pch.part { background: var(--accent-tint-2); color: var(--accent); }
.lib-chgrid.marking .pch[aria-pressed="false"]:hover { box-shadow: 0 0 0 .5px var(--sep), 0 0 0 3px var(--accent-tint-2); }
.lib-legend { display: flex; gap: 16px; margin-top: 14px; font-size: 12px; color: var(--label-2); }
.lib-legend i { display: inline-block; width: 10px; height: 10px; margin-right: 6px; border-radius: 3px; vertical-align: -1px; background: var(--bg-elev); box-shadow: 0 0 0 .5px var(--sep-2); }
.lib-legend i.read { background: var(--accent); box-shadow: none; }
.lib-legend i.part { background: var(--accent-tint-2); box-shadow: none; }

/* resume prompt (z-index 85: between #tip 80 and #toast 90) */
.resume { position: fixed; z-index: 85; left: 50%; bottom: max(24px, env(safe-area-inset-bottom)); display: flex; align-items: center; gap: 12px; width: min(520px, calc(100vw - 24px)); padding: 12px 12px 12px 14px; border-radius: var(--r-lg); background: var(--glass-2); -webkit-backdrop-filter: var(--blur-sheet); backdrop-filter: var(--blur-sheet); box-shadow: var(--sh-pop); transform: translate(-50%, 0); animation: toastIn .5s var(--spring); }
.resume[hidden] { display: none; }
.resume.out { opacity: 0; transform: translate(-50%, 12px); transition: opacity .25s, transform .3s var(--ease-out); }
.resume-body { flex: 1; min-width: 0; }
.resume-k { margin: 0; font: 600 12px/1.2 var(--sans); color: var(--label-2); }
.resume-t { margin: 1px 0 0; font: 600 16px/1.25 var(--display); letter-spacing: -.018em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.resume-s { margin: 1px 0 0; font-size: 12px; color: var(--label-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
body.has-resume .toast { bottom: calc(max(24px, env(safe-area-inset-bottom)) + 84px); }
body.mode-side.drawer-open .resume, body.mode-side.drawer-open .toast { left: calc((100% - var(--sheet-w) - 24px) / 2); }

@media (max-width: 899px) {
  .lib-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .lib-cols { grid-template-columns: minmax(0, 1fr); }
  .lib-body { padding: 4px 20px 28px; }
}
@media (max-width: 699px) {
  dialog.library { width: 100%; max-width: none; height: calc(100dvh - 10px); max-height: none; margin: auto 0 0; border-radius: var(--r-2xl) var(--r-2xl) 0 0; }
  .lib-body { padding: 0 16px calc(24px + env(safe-area-inset-bottom)); }
  .lib-continue { grid-template-columns: minmax(0, 1fr); padding: 18px; }
  .lc-t { font-size: 28px; }
  .lib-stat b { font-size: 22px; }
  .lib-bars { height: 56px; gap: 1px; }
  .lib-books { grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); }
  .auth-fields .frow > label, .prof-fields .frow > label { width: 72px; }
  body.has-resume .toast { bottom: calc(max(16px, env(safe-area-inset-bottom)) + 84px); }
}
@media (forced-colors: active) {
  .lib-book, .bm-rib, .bm-sw, .switch, .acct-av { border: 1px solid ButtonText; }
  .lib-chgrid .pch.read, .pch.read { outline: 2px solid Highlight; }
  .switch:checked { background: Highlight; }
  .lc-t { background: none; color: CanvasText; -webkit-text-fill-color: CanvasText; }
}
@media (prefers-reduced-transparency: reduce) { .resume { background: var(--bg-elev); -webkit-backdrop-filter: none; backdrop-filter: none; } }
```
Also extend the ten division gradient selectors of spec.md §1 from `.hero[data-div="x"]` to `:is(.hero, .lib-continue)[data-div="x"]`. Reduced motion is already covered by the global rule. `.resume` is added to the print `display: none` list.

### 5.16 Accessibility

- All new icon-only buttons have `aria-label` and `title`. Menus are `role=menu` with `menuitem`s; swatches and mode switches are radiogroups with roving tabindex; switches are `role=switch` checkboxes with labels.
- `#auth-err`, `#prof-err`, `#confirm-err` are `role=alert`. Invalid inputs get `aria-invalid="true"`.
- `.lib-bars` is `role=img` with a summary label; the numbers are in the stat cards (the text alternative).
- Colour is never the only signal: read chapters have a check icon, bookmarks have the ribbon shape, selected swatches have a check.
- Every user string goes through `esc()` before it reaches `innerHTML`: profile name and initials, email, bookmark label, note text and tags, video title, and every activity-log field (`x.word`, `x.title`, `x.label`, refs). The server stores these **verbatim** (it strips only control characters and enforces lengths) and returns them as JSON; `<`, `>`, `&` and quotes are legitimate input ("Faith > fear") and are never rejected or pre-escaped, so a missing `esc()` is stored XSS in the profile view.

---

## 6. Test plan (server builder)

Runner: `/Users/jkim/bible-study/.design/servertest/run_tests.py` (stdlib `unittest` + `urllib.request` + `subprocess`). Run with `python3 .design/servertest/run_tests.py`. Output lists test ids and pass/fail only.

### 6.1 Harness

- **Data dir**: `.design/servertest/data`. If it exists it is removed **only** when it contains the marker file `.servertest` (else abort with a message); then recreated with the marker. Seed guest data: `notes.json` = `{"refs": {"43.3.16": {"text": "Seed note", "highlight": "yellow", "tags": ["seed"], "videos": [], "created": 1, "updated": 1}, "1.1": {"text": "Chapter seed", "highlight": "", "tags": [], "videos": [], "created": 1, "updated": 1}}, "studies": []}`.
- **Server**: `subprocess.Popen(["/usr/bin/python3", "/Users/jkim/bible-study/serve.py", "--port", "8766", "--data-dir", DATA], stdout=log, stderr=log)` where `log = open(".design/servertest/server.log", "w")`; poll `GET /api/auth/me` every 100 ms for up to 10 s; `tearDownModule` → `terminate()`, `wait(5)`, `kill()` if needed. Refuse to run if something already answers on 8766 before start. **Never** touch port 8765.
- **Accounts**: `alice-<run>@example.test`, `bob-<run>@example.test`, … with `secrets.token_urlsafe(18)` passwords written to `.design/servertest/test-accounts.json` (`os.open(..., 0o600)`), shape `[{"email": "…", "password": "…", "purpose": "…"}]`.
- **Client helper**: `Client(port=8766)` with a manual cookie dict (parse `Set-Cookie` for `bs_sid_8766`; send `Cookie`), `req(method, path, body=None, headers=None, raw=None)` → `(status, headers, json_or_bytes)`; default headers for mutations `Content-Type: application/json`; `scope` helper adds `X-BS-Scope` from the last `/api/auth/me`. Uses `urllib.request.Request(..., method=...)`; HTTP errors are caught and returned, not raised.

### 6.2 Cases

**A. Startup and CLI**
- A1 `--data-dir <repo>/app/tmpx` → non-zero exit, message mentions `inside app/`.
- A2 a second server on the same DATA (port 8767) exits 1 with `already using`.
- A3 `--list-users` on the empty DATA prints `No profiles.`, exit 0.
- A4 after signup: `users.json`, `sessions.json`, `profiles/<uid>/*.json` are mode 0600; `profiles/<uid>` is 0700.

**B. Guest compatibility**
- B1 `GET /api/notes` signed out → the seeded refs, `rev` int, `scope` `guest`, `ETag`.
- B2 legacy `PUT /api/notes` (no scope header) signed out → 200; file has the new refs, `rev` incremented.
- B3 `PUT /api/config {"esvKey": "test-not-a-key"}` → 200 `{esv: true}`; `GET /api/config` agrees.
- B4 `GET /api/nope` → 404 JSON `not_found`; `POST /api/notes` → 405 with `Allow`.
- B5 static `GET /` → 200 HTML with `X-Frame-Options: DENY` and no `Referrer-Policy` header.

**C. Host and CSRF**
- C1 `Host: evil.example:8766` on `GET /api/notes` and `GET /` → 403 `bad_host`.
- C2 login with `Content-Type: text/plain` → 415.
- C3 `Origin: http://evil.example` → 403 `csrf`; `Origin: null` → 403; matching Origin → passes.
- C4 no Origin + `Sec-Fetch-Site: cross-site` → 403; `same-origin` → passes.
- C5 `OPTIONS /api/notes` → 405 and no `Access-Control-Allow-Origin`.
- C6 events body > 128 KiB → 413 (before reading); missing Content-Length → 411; `{` → 400 `bad_json`; `[]` → 400 `bad_json`.

**D. Signup, login, sessions**
- D1 signup validation: bad email, empty name, 7-char password, `password123`, password equal to the email → 400 with the right `error` and `field`; nothing written to `users.json`.
- D2 signup (remember) → 201; cookie `bs_sid_8766`, `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age=2592000`, no `Secure`; `/me` signed in with `initials`.
- D3 signup remember=false → cookie without `Max-Age`/`Expires`.
- D4 same email in different case → 409 `email_taken`.
- D5 no response body and no file under DATA contains the raw token; the `sessions.json` key equals `sha256(token)`; `users.json` `pw` starts with `pbkdf2_sha256$600000$` on this machine (or `scrypt$` where available); no response ever contains `pw`.
- D6 wrong password and unknown email → 401 with byte-identical bodies.
- D7 five failures then a correct password → 429 with `Retry-After`; after waiting `retryAfter` seconds the correct password succeeds and counters reset.
- D8 logout → cookie cleared; the old token now resolves to guest; logout again → 200.
- D9 two clients signed in to one user; `logout {"all": true}` on one → the other is guest.
- D10 edit `sessions.json` in the test DATA so `expires` is in the past → guest; a tampered/short cookie → guest and `/me` clears it.
- D11 password change: wrong current → 401; right → 200, the other client is signed out, this client's new cookie works, its previous token does not.
- D12 `PATCH /api/account {name}` → updated; `{email}` without password → 401/400; with password → changed, login with the new email works.
- D13 31 bad logins across different unknown emails within 60 s → at least one 429 `rate_limited`.

**E. Notes scope and merging**
- E1 signup with `importGuest: true` → profile `GET /api/notes` has the two seed refs, `scope` = uid; guest file unchanged.
- E2 signup with `importGuest: false` → empty profile notes.
- E3 `POST /api/notes/changes` set + del → `rev` +1, file content matches, tombstone recorded.
- E4 set with an older `updated` than stored → `conflicts[key]` = stored note, stored unchanged.
- E5 del with `ts` older than the stored `updated` → conflict, note kept.
- E6 `baseRev` behind → `stale: true`.
- E7 `X-BS-Scope: guest` while signed in → 409 `scope_mismatch` with `scope` = uid; uid header while signed out → 409 `scope`=`guest`; no header on `/changes` → 400 `scope_required`.
- E8 legacy PUT without scope header while signed in → 409 `scope_required`; neither file changed.
- E9 PUT with a stale `If-Match` → 409 `rev_conflict`.
- E10 invalid key `67.1.1` / `43.22.1` / `43.3.37` → 400 `invalid_note`, nothing applied.
- E11 two threads × 50 changes to disjoint keys → all 100 keys present, `rev` = start + 100.

**F. Library**
- F1 fresh `GET /api/library` → empty shape, `stats.minutes90` length 90, `totals.chaptersTotal` 1189.
- F2 one batch with `chapter.open`, `chapter.time sec=120`, `verse.study v=16`, `xref.open`, `word.study`, `note.save`, `video.add`, `chapter.read`, `position` → `chapters["43.3"]` (`visits` 1, `seconds` 120, `studied` ⊇ [16], `read` true), `days[day]`, `lastPosition`, activity types in order.
- F3 same `batchId` again → `duplicate: true`, `seconds` still 120.
- F4 bad events (b 67, v beyond the chapter, unknown type, `t` 40 days old, `sec` 5000) → counted in `rejected`, others applied.
- F5 1,100 distinct `verse.study` events over several batches → activity length 1,000, oldest dropped; two `chapter.open` of the same chapter 5 min apart → one activity entry.
- F6 bookmarks: POST → 201; same ref → 200 `existed`; PATCH label 81 chars → 400 `invalid_label`; colour `pink` → 400 `invalid_color`; PATCH ok; DELETE → 200 `removed`; DELETE again → 404; `/api/library/bookmarks/../../x` → 404.
- F7 manual unmark then an auto `chapter.read` with `t` before `manualAt + 60 s` → stays unread; with a later `t` → read.
- F8 stats with events on days D−3, D−2, D−1 (s ≥ 60 each) and `today=D` → `streak.current` 3, `studiedToday` false; add D → 4; `minutes90[-1]` equals D's minutes; longest correct with a gap.
- F9 `reset {"what": ["activity"]}` empties activity only; `progress` clears chapters/days/lastPosition; `bookmarks` clears bookmarks.
- F10 two threads each posting 30 batches of `chapter.time sec=10` → `seconds` exactly 600.
- F11 guest and profile libraries are independent (events signed out never appear in the profile and vice versa).

**G. Export, import, delete**
- G1 `GET /api/export/profile` → attachment filename `bible-study-<slug>-<date>.json`, `format` `bible-study-profile`, no `pw`, no `appliedBatches`.
- G2 `GET /api/export/obsidian` signed in with a bookmark on 43.3.16 → zip contains `study-notes/Bookmarks.md` with `[[John 3.16|John 3:16]]` and `study-notes/Reading Progress.md`.
- G3 `POST /api/profile/import-guest` twice → the second call reports zero changes and leaves `seconds`/`visits` unchanged.
- G4 delete with a wrong password → 401; right → 200; user gone from `users.json`; `profiles/<uid>` moved under `deleted/` with a `user.json` lacking `pw`; its sessions gone; `/me` guest.

**H. CLI while the server runs**
- H1 `--list-users --data-dir DATA` lists the test emails, and the output contains neither `pbkdf2` nor `scrypt`.
- H2 `--reset-password <email> --password-stdin` (new generated password on stdin) → exit 0; the old session is signed out; login with the new password works; lockout cleared.
- H3 unknown email → exit 1; weak password → exit 2.

**I. Unit (import `accounts`)**
- I1 hash/verify round trip; wrong password False; `needs_rehash` False for fresh hashes; a stored `scrypt$…` string on a Python without scrypt → False, no exception.
- I2 `validate_email/name/password` tables (valid and each failing rule).
- I3 `apply_events` on a dict: coalescing windows, `days` trimming at 400, sorted insertion of out-of-order `t`.
- I4 `compute_stats` fixed fixtures (streaks across a month boundary).
- I5 `merge_library` copy vs merge (idempotent merge); `merge_notes` LWW + tombstones.
- I6 `write_json_atomic` leaves no `.tmp-*` files; `read_json_strict` on a corrupt file renames it to `*.corrupt-*` and returns the default.

- I8–I11 canonical refs (leading zeros, other scripts' digits) and clamped timestamps; merge idempotent at the 400-day / 1,000-entry caps; the shared accounts file is merged, never truncated; display-text cleaning, strict JSON reading/writing, compare-and-set retry after a version bump.

**K–P. Security / integrity review regressions** (each fails on the code before its fix)
- K1 20 simultaneous wrong passwords for one account → exactly 5 × 401 and 15 × 429 (`failedLogins` 5). K2 45 simultaneous logins → exactly 30 × 401, 15 × 429. K3 13 simultaneous signups → exactly 10 × 201, 3 × 429.
- L1 `/js/`, `/data/`, `/css/` and `/js`, `/data`, `/css`, `/data/art` (GET and HEAD) → 404, no listing, no `Location`. L2 names, labels and activity words are stored verbatim and served only as JSON + nosniff; CR/LF never reach a header.
- M1 a stale tab (old `base`) cannot overwrite a newer edit; it gets the newer note in `conflicts`. M2 compare-and-set rules (create race, retry, delete with base, delete of a deleted note, re-create, version bump, bad `base` → 400). M3 future `updated`/`created`/`added`/tombstones are clamped and never freeze a note or block a ref. M4 such values already on disk are repaired on load. M5 a retry after the server bumped the version is no conflict.
- N1 repeated guest import with a full activity log changes nothing. N2 wrongly typed library.json / users.json / sessions.json fields are repaired: every endpoint (including both exports) keeps answering. N3 refs with leading zeros are refused, and folded when already stored.
- O1 damaged or missing `users.json` → signup/login 503 `registry_unavailable`, nobody's sessions purged, the cookie kept; restore brings everyone back; an orphaned email cannot sign up again. O2 startup removes `*.tmp-<pid>-<tid>` left by a crash (and nothing else).
- P1 `1e999`, `NaN`, `Infinity`, unpaired surrogates in a body → 400 `bad_json` (surrogate pairs fine). P2 such values already in notes/library/users files → every GET answers strict JSON, every write still works, nothing moved aside. P3 refs with other scripts' digits (`4٣.3.16`) are refused and folded when stored. P4 names/labels lose bidi controls; emails with invisible characters → `invalid_email`. P5 `Content-Length: ²` → 411 (not a dropped connection).

**J. Hygiene (last)**
- J1 no test password and no issued token appears anywhere in `server.log` or any file under DATA (byte search); no `.tmp-*` file is left.
- J2 `server.log` contains `[auth] … login-fail uid=unknown` lines, no email address from a failed attempt, and no `Traceback`.
- J3 accounts other agents recorded in `.design/servertest/test-accounts.json` are still there after a run (the harness merges under `flock`, it never truncates the file).

### 6.3 Front-end smoke (later FE builders, in-app browser)

On `http://127.0.0.1:8766/` (test instance, writes allowed): create a profile with guest import; bookmark a verse with `b`, label and recolour it from the gutter ribbon; read a short chapter (Psalm 117) past the threshold and see the read pill, picker check and Library tile update; reload without a hash and land on the saved position; sign out and see guest data; sign in and get the resume prompt. On `http://localhost:8765/?dry#43/3/16`: confirm no non-GET request is made (network log) while bookmarking, marking read and scrolling.

---

## 7. Acceptance checklist

- [ ] Signed out, the app behaves exactly as before; the old client keeps working against the new server while signed out.
- [ ] Profiles: sign up, sign in (remember or not), sign out, sign out everywhere, rename, change email, change password, delete with password, export JSON, export Obsidian, import guest data (at sign-up and later).
- [ ] Two tabs never silently overwrite each other: notes use per-key merge with conflicts; library writes are aggregated events or per-item bookmark calls.
- [ ] Bookmarks from the sheet header, the `b` key, the reader footer and the gutter ribbon; labels and colours; Undo on remove.
- [ ] Leave off: hashless load resumes; the resume prompt appears when a link opens elsewhere.
- [ ] Automatic tracking follows §4 exactly (idle, coverage, thresholds, dwell) and survives tab close via the outbox.
- [ ] Library: continue card, four stat cards, 90-day chart, bookmarks, activity timeline with paging, 66-book progress grid and per-book chapter grid with Mark mode.
- [ ] Read marks in the picker, read pill and footer state in the reader.
- [ ] `?dry`: zero non-GET requests, zero localStorage writes.
- [ ] Every test in §6 passes; no password or token in any log or data file.
