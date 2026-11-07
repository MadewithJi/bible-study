# Weekly devotional: sign-up page, list, weekly compile, review and send. Build brief

Ji (2026-11-06): "Create a weekly devotional page where it takes weekly all my studies and notes and makes it a weekly
devotional that is sent out via email. People can sign up on that page and that will be a list that allows me to send
out emails to them weekly, where the cron job will analyse my weekly studies tied to the master admin account, compile
them and send them." Ji's choices: **everything from the week** goes in; **a draft comes to Ji first and nothing goes
out until he approves**; the text stays **as close to Ji's own words as possible, with AI allowed to format, consolidate
and stitch**; verses are quoted from the **BSB** (public domain).

## 0. Hard rules

- `AGENTS.md`: never touch `app/data/bibles/`, `app/data/orig/`, `app/data/redletter/`, `tests/scripture.sha256`. Verse
  text comes only from `app/data/bibles/bsb/NN.json` (`{"<chapter>": ["verse 1", …]}`), word for word, labelled BSB.
  The model never writes, "fixes" or paraphrases a verse: it outputs references, the server inserts the words.
- Reverence: God, Jesus, the Holy Spirit are never listed among "people"; prompts and templates say "the Lord", "God".
- No new Python packages (`requirements.txt` stays empty: Railway builds with no pip step). HTTP goes through `urllib`,
  as Turnstile, ESV and API.Bible do. No new front-end libraries.
- Keys never appear in logs, in the repo, in tests or in a reply: tests use fake servers (`BS_RESEND_URL`,
  `BS_ANTHROPIC_URL`) and made-up keys like `re_test_…`; T99 asserts no key string lands on disk or in the log.
- Email addresses are never logged (T99 `test_j2_auth_log` already asserts none appears): log a subscriber id.
- Nothing is sent to anyone unless an issue is `approved` by the owner (or the owner sends a test to an owner address).
- Never run or touch the real server on 8765 or `notes/`; tests start their own serve.py (tests/test_server.py Harness).
- Keep the chapter hero and every existing view untouched (Ji's standing rule). New UI goes on the new page and inside
  the Profile dialog's owner section only.
- British spelling in copy. No exclamation marks. Plain words.

## 1. Settings (serve.py `configure_hosting`, README table, tests `HOSTING_ENV`)

| Variable | Default | What |
|---|---|---|
| `BS_RESEND_KEY` | unset | Resend API key. Unset: the list is **not open**: the page says "Sign-ups open soon", subscribe answers 503 `not_open`, nothing is ever sent. Validated like `BS_APIBIBLE_KEY` (no whitespace/control chars) |
| `BS_RESEND_URL` | `https://api.resend.com` | the tests' fake Resend |
| `BS_DEVOTIONAL_FROM` | `Bible Lantern <devotional@biblelantern.com>` | the From header. Must parse as `Name <local@domain>` or `local@domain` |
| `BS_DEVOTIONAL_REPLY_TO` | `hello@biblelantern.com` | Reply-To |
| `BS_DEVOTIONAL_SITE` | `https://www.biblelantern.com` | the public origin used in links inside emails (confirm, unsubscribe, verse links `#b/c/v`, the review page) |
| `BS_DEVOTIONAL_AUTHOR` | first address of `BS_OWNER_EMAILS` | the profile whose week is compiled: the profile that **holds the owner claim** for that address (`holds_owner_claim`). No such profile: compile fails with `no_author`, logged `[devotional] no author profile` |
| `BS_DEVOTIONAL_TZ` | `America/Los_Angeles` | the local calendar for weeks and the schedule (`zoneinfo`; an unknown name is ignored with a warning, like other bad values) |
| `BS_DEVOTIONAL_COMPILE` | `sat 06:00` | when the week is compiled and the preview mailed to the author: `<mon…sun> HH:MM` local. `off` disables the scheduler (the owner's Compile now still works) |
| `BS_DEVOTIONAL_SEND` | `sun 07:00` | when an **approved** issue goes out. `now` sends on approval |
| `BS_DEVOTIONAL_MAX` | 20000 | most confirmed subscribers; past it, subscribe answers 503 `list_full` |
| `BS_ANTHROPIC_KEY` | unset | with it, the Claude API stitches the draft (§4.3). Unset: the deterministic layout (§4.2) |
| `BS_ANTHROPIC_URL` | `https://api.anthropic.com` | the tests' fake Claude |
| `BS_ANTHROPIC_MODEL` | `claude-opus-5-5` | the model id (no date suffix) |
| `BS_DEVOTIONAL_ADDRESS` | unset | an optional postal line for the email footer (US CAN-SPAM asks a sender for one; tell Ji in the README that he should set it) |

Locally with none set the server behaves as today, except that `/weeklydevotional` is served and the owner tools work
without email (no `BS_RESEND_KEY`: the preview is not mailed; the owner opens it in the app).

## 2. Data (`DATA/devotional/`, 0700; files written with `A.write_json_atomic`, 0600; under one new lock
`A.lock_for("devotional")` style, a `threading.Lock` plus `fcntl` file lock like the others)

### 2.1 `subscribers.json`

```json
{"v": 1, "subs": {
  "sb_4f1c2a9e0b7d": {"email": "a@example.test", "status": "pending", "created": 1762400000000, "confirmed": null,
                      "unsubscribed": null, "token": "<32 hex>", "source": "page", "issuesSent": 0}
}}
```

- `id` = `"sb_" + token_hex(6)`; `token` = `secrets.token_hex(16)`: the capability in confirm and unsubscribe links,
  stored **hashed** (`sha256`) like session tokens; the raw token exists only inside the email. Rotated on confirm.
- One record per normalised email (`A.normalize_email`, `A.validate_email`). Subscribing an address that is `pending`
  resends the confirmation (at most once an hour per address); `confirmed` → the same 202 and no mail (no enumeration:
  the subscribe response is identical whatever the state); `unsubscribed` → back to `pending` with a new token and a
  confirmation mail.
- `pending` for more than 7 days is dropped by the scheduler tick.
- An owner may export the confirmed list as CSV (`GET /api/devotional/subscribers.csv`, owner only).

### 2.2 `issues/<YYYY-MM-DD>.json` (the week's **end** day, local, Saturday by default)

```json
{"v": 1, "id": "2026-11-14", "week": {"from": "2026-11-08", "to": "2026-11-14"},
 "status": "draft", "created": 0, "updated": 0, "compiledBy": "schedule|owner",
 "source": {"notes": ["43.3.16", …], "marks": ["mk_…"], "links": ["ln_…"], "studies": ["st_…"],
            "chapters": ["43.3", …], "counts": {"notes": 4, "marks": 2, "links": 3, "studies": 1, "chapters": 6, "minutes": 212}},
 "draft": { "subject": "…", "title": "…", "opening": "…",
            "sections": [{"heading": "…", "refs": ["43.3.16", "45.5.8"], "body": "…", "quotes": ["…"]}],
            "closing": "…", "question": "…", "stitched": true, "model": "claude-opus-5-5", "warnings": [] },
 "html": "<!doctype html>…", "text": "…",
 "review": {"tokenHash": "<sha256>", "mailedAt": 0},
 "approved": null, "skipped": null,
 "send": {"due": 0, "startedAt": null, "finishedAt": null, "sent": 0, "failed": 0, "done": {"sb_…": 1762500000000}, "errors": []}}
```

`status` ∈ `draft | approved | sending | sent | skipped | empty` (`empty`: the week had nothing; no mail is sent, the
author is told in the preview mail). `send.done` is per subscriber, so a restart mid-send never sends twice.
`draft.body`/`opening`/`closing`/`question` are markdown-light text (paragraphs, `**bold**`, `*em*`); `refs` are
canonical `b.c.v` or `b.c.v-v2` ranges, validated with `A.parse_ref`/`A.canonical_ref`.

## 3. HTTP API (serve.py `ROUTES`; CSRF rules as every `/api/` write; `X-BS-Scope` **not** required on the public
devotional routes: they are called from a plain page, pass `scope=False` or whatever the Route table supports, check how
`/api/health` and `/api/passage` skip it)

Public (no sign-in):

| Route | What |
|---|---|
| `GET /api/devotional/config` | `{open: bool, turnstile: {siteKey} \| null, from: "<day name>", sample: {title, subject}}`; `open` = key set and list not full |
| `POST /api/devotional/subscribe` `{email, turnstileToken?}` | Turnstile checked when configured (same `_turnstile_or_403`); rate limits: `DEVO_WINDOW = Window(10, 3600)` per visitor+email key and `DEVO_SITE_WINDOW = Window(100, 3600)` site-wide, 429 with `wait` like signup. Sends the confirmation mail. Always 202 `{ok: true}` on a well-formed email, whatever the state. 400 `bad_email`, 503 `not_open` / `list_full`, 503 `mail_unavailable` when Resend cannot be reached (logged `[error]`) |
| `GET /api/devotional/confirm?t=` | confirms (sets `confirmed`, status, rotates token) and answers a small HTML page ("You're on the list", a link to the site), 200; a bad or used token answers the same page with "This link has expired. Sign up again." 404. Also accepts `POST` |
| `GET\|POST /api/devotional/unsubscribe?t=` | sets `unsubscribed`; HTML "You've been unsubscribed", 200 (a bad token: 404 with the same shape). POST with body `List-Unsubscribe=One-Click` is accepted (RFC 8058) |

Owner only (`OWNERS_ONLY`, 404 to everyone else, like `/api/admin/traffic`; scoped like other profile writes):

| Route | What |
|---|---|
| `GET /api/devotional/admin` | `{open, subscribers: {confirmed, pending}, author: {uid, email: masked like "j…@gmail.com" or just present: bool}, schedule: {tz, compile, send, nextCompile, nextSend}, ai: bool, issues: [{id, week, status, counts, created, approved, send: {due, sent, failed}}] newest first (≤ 26)}` |
| `POST /api/devotional/compile` `{week?: "YYYY-MM-DD" (end day)}` | compiles the current week (ending today, local) or the named one; replaces an existing `draft`/`empty` issue for that week, refuses (409 `issue_locked`) one that is approved/sending/sent. Mails the preview to the author when Resend is set. 200 `{issue}` |
| `GET /api/devotional/issues/{id}` | the issue JSON (without tokens) |
| `GET /api/devotional/issues/{id}/html` | the email HTML as `text/html` (the preview the owner opens in a tab) |
| `PATCH /api/devotional/issues/{id}` `{subject?, title?, opening?, sections?, closing?, question?}` | the owner's edits to the draft; re-renders html/text; only while `draft` (409 otherwise) |
| `POST /api/devotional/issues/{id}/approve` | `draft → approved`, `send.due` = next `BS_DEVOTIONAL_SEND` moment (or now); 200 `{issue}` |
| `POST /api/devotional/issues/{id}/send-now` | approved → due now |
| `POST /api/devotional/issues/{id}/skip` | `draft\|approved → skipped` (not once sending) |
| `POST /api/devotional/issues/{id}/test` | mails the issue to the signed-in owner's own address only (`[test]` in the subject) |
| `GET /api/devotional/subscribers.csv` | `email,status,created,confirmed` for confirmed subscribers |

The review page the preview email links to: `GET /api/devotional/review?t=<raw review token>` answers an HTML page
(same look as the confirm page) showing the issue HTML inline (an `<iframe srcdoc>` or inline) with three forms:
**Approve** (POST `/api/devotional/review` `{t, action: "approve"|"skip"|"test"}`), **Skip**, **Send me a test**. The
token is the issue's `review.tokenHash` preimage; valid until the issue leaves `draft`. This works from the phone
without signing in; the same actions are also in the Profile dialog.

## 4. Compile (`devotional.py`, a new module next to `accounts.py`, standard library only)

### 4.1 Gathering the week (`gather(uid, week) -> source`)

The local week is `[from 00:00, to 24:00)` in `BS_DEVOTIONAL_TZ`, `to` = the compile day (Saturday) by default,
`from` = six days earlier. From the author's profile files (under the scope lock, read-only):

- `notes.json` refs with non-empty `text` and `updated` in the window (chapter notes `b.c` and verse notes `b.c.v`),
  plus their `tags`; ordered by Bible order then `updated`.
- `marks.json` marks with `updated` in the window: the quoted words (the BSB text between `so`/`eo` of `start`/`end`,
  see annotations brief §2.1 `_verse_plain_text` in accounts.py, reuse it) and any `note` comment.
- `links.json` links `created` in the window: from, to, type, note.
- `studies` (inside `notes.json` `"studies"`) with `updated` in the window: title, intro, entries' keys.
- `library.json`: `chapters` with `lastRead` in the window (ordered by `lastRead`), `days` minutes summed over the
  window, `activity` of the window (chapter.open, xref.open) for "what you followed".
- `memory.json`: verses added in the window (optional, one line).

Everything the author wrote (note text, mark comments, link notes, study intros) is **Ji's text**: it is never altered
except by the stitching rules below; the deterministic layout quotes it as is (rendered as the app's markdown subset,
`[[ref]]` links resolved to verse links).

### 4.2 Deterministic draft (always available; the fallback and the test path)

- `subject`: `Weekly devotional · <Day Month>` (the week's end day, e.g. `14 November`).
- `title`: the first study's title of the week, else the book and chapter most read (`John 3`), else `This week`.
- `opening`: one plain sentence from the counts: "This week: 6 chapters, 4 notes, 3 connections." (numbers from `counts`).
- `sections`: one per chapter studied (Bible order): heading = chapter label (`John 3`), `refs` = the verses noted,
  highlighted or linked in it (each verse quoted in BSB in the email), `body` = the notes' text in order, then the
  highlights ("“quoted words” · comment"), then the links as lines "→ Romans 5:8 · fulfils · note".
- `closing`: a study's intro if there was one, else empty. `question`: empty.
- `stitched: false`.

### 4.3 Stitched draft (when `BS_ANTHROPIC_KEY` is set)

One `POST {BS_ANTHROPIC_URL}/v1/messages` via `urllib.request` (timeout 120 s, no retries beyond the SDK-equivalent
one retry on 429/5xx with a 2 s pause), headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type`. Body:

```json
{"model": "<BS_ANTHROPIC_MODEL>", "max_tokens": 8000,
 "system": "<frozen house prompt, below>",
 "messages": [{"role": "user", "content": "<the week's material as JSON: notes, marks, links, studies, chapters, each item with its ref label and the BSB verse text so the model can see what Ji was reading>"}],
 "output_config": {"effort": "high", "format": {"type": "json_schema", "schema": {…the draft schema: subject, title, opening, sections[{heading, refs[], body, quotes[]}], closing, question…}}}}
```

Omit `thinking` (adaptive by default on this model). Read `content[0].text` (the first `text` block), `json.loads` it,
validate every field (lengths: subject ≤ 120, title ≤ 120, opening/closing ≤ 1,500, body ≤ 4,000 each, ≤ 8 sections,
question ≤ 300), validate `refs` with `A.parse_ref` and drop any ref that was not in the source material or is not a
real verse. On any failure (network, non-200, bad JSON, schema miss) fall back to §4.2 and record a warning in
`draft.warnings` and the log (`[devotional] stitch failed: <reason, no key>`); the owner sees "Laid out without AI" in
the admin card. Check `stop_reason == "end_turn"`; `refusal` or `max_tokens` → fallback.

The house prompt (write it in full in `devotional.py` as `STITCH_SYSTEM`; keep it stable so caching works; add
`"cache_control": {"type": "ephemeral"}` as a system block):

- You are arranging one reader's week of Bible study notes into a short weekly devotional email from Bible Lantern.
- Use the reader's own words. Keep their sentences; you may fix spelling and punctuation, join fragments, remove
  duplication, and add short connective sentences so it reads as one piece. Do not add claims, facts, interpretations
  or applications the reader did not write. Do not add dates, authorship or history.
- Never quote or paraphrase Scripture yourself: put a verse in `refs` and the server inserts its published text.
  `quotes` holds only the reader's own highlighted phrases, exactly as given.
- Order: a one-paragraph opening in the reader's voice; 2–5 sections, each around one passage or one thread of
  connections; a closing paragraph; one question for the reader's notes.
- Speak of God, the Lord, Jesus and the Holy Spirit with reverence; never list them among people.
- British spelling, plain words, no exclamation marks, no emoji, no headings in all caps, no marketing language.
- If the material is thin, keep the email short rather than padding it.

### 4.4 Rendering (`render(issue) -> (html, text)`)

**The approved design is `.design/devotional-mock/issue-v3.html`** (Ji, 2026-11-06: consistent with the Instagram
carousel). Reproduce it as an email: a single column of max width 600, **table-based layout with inline styles**
(email clients drop `<style>` blocks, flex, grid, `position`, `filter`, `::first-letter`, `text-wrap`), background
`#050505`, ink `#f5f3ee`, dim `rgba(245,243,238,.6)` (use `#9f9d99` in email), gold `#ffb35c`; serif stack
`"New York", "Iowan Old Style", Charter, Palatino, Georgia, serif` for Scripture, titles, the big quote and "Amen.";
system sans for notes, labels and the footer; labels uppercase, letter-spaced, gold. The bands in order: hero plate
(the Doré image as a 600-wide `<img>` from `{SITE}/data/art/<id>.jpg`, with a dark gradient faded into it by using
the plate inside a dark cell and overlaying nothing: email clients cannot overlay, so put the title **below** the
plate on black, and choose the plate `position`-free; a warm glow is not possible in email, skip it), kicker + title
with one gold italic word (the model marks it with `<em>`; the deterministic draft takes none), the opening paragraph
in serif, the **verse at full volume** block (gold open-quote glyph, the verse's first clause large, its continuation
in gold italic, a short gold rule, `REFERENCE · BSB`), the numbered sections, the connections band (§4.4a), a second
plate with a verse caption when a second plate matches, the "For today" response with a companion verse, **Amen.**
(gold full stop) with "If you believe it, **reply “Amen”** and share this with someone who needs it.", a gold pill
button "Open <chapter> in Bible Lantern", and the footer with the mark (`{SITE}/icons/apple-touch-icon.png` at 22px,
or a dedicated `app/icons/mark-email.png` the builder adds, 88px, from `.design/logo/out/`), biblelantern.com,
Unsubscribe · Privacy · Read on the web, the BSB and Doré credits, and the postal line when set.

Plates: pick by the issue's chapters from `app/data/art.json` (`ref` = [book, chapter, v1, v2]): the first section's
chapter plate for the hero, else that book's plate, else `dore-001`; a second plate only when a different chapter in
the issue has one. The credit line "Gustave Doré, <title> (1866)" sits under the plate in small italic serif.

#### 4.4a The connections band

As in the app's chapter chart: a baseline of the 66 books (two thin bars, OT and NT), the books touched this week as
gold ticks, and an arc between the two ends of every link made this week, drawn as **inline SVG** (Apple Mail, iOS
Mail, Outlook for Mac render it). Directly after the SVG, the same information as a table that every client shows:
a gold-dot thread list "John 3:16 → Romans 5:8 · SAME THOUGHT · the link's note". Gmail strips the SVG and shows
only the list, which is acceptable. Arc x-positions: book `b` at `x = 520 * (cumulative chapters before b + c) /
1189` over a 520-wide viewBox, OT bar 0–305, NT bar 311–520 (compute from `app/data/meta.json` chapter counts).

The plain-text twin: the same order, verses as `> words` with `— Reference · BSB` lines, links as `Reference -> Reference (type): note`.

The rest of this section applies unchanged where it does not conflict with the design above:

1. Preheader = the opening's first sentence.
2. Title, the week ("8–14 November 2026").
3. Opening.
4. Each section: heading; each ref as a verse block: the BSB words, then "Reference · BSB" linked to
   `{SITE}/#b/c/v`; then the body (Ji's words); then quotes as a short list.
5. Closing; "For your notes" with the question (when present) and a link to the site.
6. Footer: "You asked for this on biblelantern.com." · Unsubscribe (per-recipient link) · the postal line when set ·
   "Scripture quotations are from the Berean Standard Bible, public domain." (BSB's own statement: check
   app/data/meta.json or the app's About text for the exact credit line the site already uses, and reuse it).

Every `{SITE}` link carries `?utm_source=devotional&utm_medium=email` in the query **before** the hash.
`esc()` everything; the owner's markdown subset is rendered to HTML by a tiny renderer (paragraphs, bold, italics,
`[[b.c.v]]`/`[[John 3:16]]` → links), never `innerHTML` of raw text.

### 4.5 Sending (`send_issue(issue)`)

- Recipients: `confirmed` subscribers not in `send.done`. Build one Resend batch per 100 (`POST {RESEND}/emails/batch`,
  `Authorization: Bearer <key>`, an array of `{from, to: [email], reply_to, subject, html, text, headers:
  {"List-Unsubscribe": "<{SITE}/api/devotional/unsubscribe?t=…>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"}}`);
  a 2xx marks every address of the batch done; a 4xx on the batch → record the error, do not retry that batch's
  addresses this run; 429/5xx → wait `retry-after` or 5 s and retry the batch up to 3 times. `Idempotency-Key` header
  = `issue.id + ":" + batch index + ":" + sha256 of the address list` (Resend supports it) so a resend after a crash
  is harmless.
- Progress is written to the issue file after every batch; `status` `sending` → `sent` (or stays `sending` with
  errors; the next tick resumes). The author gets a short "Sent to N readers" mail at the end (and the admin card shows it).
- The single-message endpoint `POST /emails` is used for confirmation, preview, test and "sent" mails.

### 4.6 Scheduler (`DevotionalScheduler`, a daemon thread started from `main()` like `start_metrics`)

Ticks every 30 s. Each tick, under the devotional lock:
1. If `BS_DEVOTIONAL_COMPILE` is a day/time and the local now has passed this week's compile moment and no issue
   exists for this week's end day → compile (§4), mail the preview (§4.7) when Resend is set.
2. Any `approved` issue with `send.due ≤ now` → `sending` → `send_issue`.
3. Any `sending` issue whose `startedAt` is older than 10 minutes and not finished → resume.
4. Drop `pending` subscribers older than 7 days.
Every step is wrapped so one failure is logged (`[devotional] …`) and the thread keeps running. Tests drive the same
functions directly through a `BS_DEVOTIONAL_TICK` environment? No: give the scheduler a `tick(now)` method and let
tests set `BS_DEVOTIONAL_COMPILE`/`SEND` to `off` and call the owner routes; one test calls `tick()` through a hidden
owner-only route `POST /api/devotional/tick` that exists only when `BS_DEVOTIONAL_TEST=1` (the harness sets it).

### 4.7 Mails to the author

- Preview: subject `Review: <subject>`; a short note ("Your week is ready. Approve, skip or send yourself a test.")
  with the review link (`{SITE}/api/devotional/review?t=…`), then the issue HTML below a rule. `empty` weeks: "Nothing
  to send this week" with no links.
- Test: the issue to the owner's address with `[test]` in the subject.

## 5. The page `/weeklydevotional` (`app/weeklydevotional.html`)

- `vercel.json`: `{ "source": "/weeklydevotional", "destination": "/weeklydevotional.html" }` beside `/privacy`;
  serve.py `do_GET` maps `/weeklydevotional` the same way `/privacy` is mapped. Add to `app/sitemap.xml`
  (`lastmod` today) and a line to `app/llms.txt` ("Weekly devotional: a free weekly email …, sign up at
  https://www.biblelantern.com/weeklydevotional").
- Built like `privacy.html` (same `<head>` pattern: title "Weekly devotional · Bible Lantern", description, canonical,
  OG tags with the existing og-image, JSON-LD WebPage, the same CSS tokens and wordmark header; light and dark).
- Content, in order:
  1. Wordmark header (link to `/`).
  2. `h1` "Weekly devotional"; lede: one week of close reading, in Ji's own notes: the passages, the connections he
     followed, and a question for your own notes. Free. Every Sunday. (Keep it short; British spelling.)
  3. The form: one email field + button "Sign up" + the Turnstile box (`div#devo-turnstile`, rendered with the key
     from `/api/devotional/config` exactly as account.js does: same script URL, explicit render, reset after each
     attempt), a line under it "One email a week. Unsubscribe with one click. No tracking." After submit, the form is
     replaced by "Check your inbox: we sent a link to confirm." Errors inline (bad email, 429 with the wait, 503
     "Sign-ups open soon" when `open` is false, in which case the form is shown disabled with that text from the start).
  4. "What an issue looks like": a static sample laid out in the email's style, using **only** verse text read from the
     app's BSB files at build time? No build step exists: write the sample's verse words by copying them **from
     `app/data/bibles/bsb/43.json` chapter 3 verse 16 and `app/data/bibles/bsb/62.json` chapter 4 verse 19** (open the
     files and paste the exact strings; label "John 3:16 · BSB", "1 John 4:19 · BSB"). The sample's note text is
     plainly marked as an example.
  5. "How it is made": three short lines: compiled from Ji's week of study on Bible Lantern; the verses quoted from
     the BSB, word for word; read and approved by Ji before it is sent; your address is used for nothing else, link to
     `/privacy`.
  6. Footer: © line like the privacy page, links Privacy · Home.
- The page's script is inline, small, no modules, `fetch` with `credentials: 'omit'`; it must work with the `/api`
  rewrite on Vercel (same origin) and locally.
- Also link the page from Home's colophon (`home.js` `coloHtml`): one more `<p class="colo-g">` line
  "Weekly devotional" → `/weeklydevotional` with `icon('mail')` if an envelope icon exists in icons.js, else no icon.
  Nothing else on Home changes.

## 6. Owner UI (account.js, the Profile dialog's owner section, under Site activity)

A card "Weekly devotional" shown only when `a.hosted && a.owner` (and locally for any signed-in profile when the server
answers `/api/devotional/admin` 200: the server answers it locally for any signed-in profile, since there are no owners
locally; hosted it is owners-only):

- First line: subscribers (confirmed · pending), schedule ("Compiled Saturdays 06:00, sent Sundays 07:00, Los Angeles"),
  "Stitched with AI" or "Laid out without AI", "List not open (no mail key)" when `open` is false.
- Buttons: **Compile this week** (POST compile; a toast with the result), then the issues list (newest first, 6 rows):
  week, status chip, counts; per row: **Preview** (opens `/api/devotional/issues/{id}/html` in a new tab),
  **Approve**, **Skip**, **Send me a test**, **Send now** (approved only); confirms before Approve ("Send this week's
  devotional to N readers on Sunday?") with `ui.confirm` or whatever the dialog helper is.
- Errors as toasts; the card re-fetches after each action.

## 7. Docs

- `README.md`: a "Weekly devotional" section: what it does, the variables (table rows), the Resend setup steps (add the
  domain, DNS records, the key), the postal-address note, how to compile and approve, local behaviour.
- `app/privacy.html`: a "Weekly devotional email" section: what is kept (the address, when you confirmed, which issues
  were sent to you), Resend as the sending service, one-click unsubscribe, double opt-in; update the "Last updated"
  date, `dateModified` and the sitemap `lastmod` to today (2026-11-06).
- `serve.py` docstring: the new routes and variables, two or three lines.

## 8. Tests (`tests/test_server.py`, new `class T33_Devotional(Base)`; FakeResend and FakeClaude like FakeTurnstile and
FakeApiBible; add the new variables to `HOSTING_ENV`)

1. Config and page: `/weeklydevotional` serves the page (200, `text/html`); `/api/devotional/config` `open:false`
   without a key, `open:true` with the fake.
2. Subscribe: 202 for a new address (FakeResend got one `/emails` with a confirm link to `BS_DEVOTIONAL_SITE`);
   confirm with the token from the fake's captured body → confirmed, the page says so, and the token no longer works;
   subscribing again → 202 and **no** new mail within the hour; unsubscribe link (GET and the one-click POST) → status
   unsubscribed; subscribe again → pending with a new confirmation mail; bad email 400; 11th attempt in an hour 429;
   Turnstile required when configured (403 without a token, like signup); 503 `not_open` without the key.
3. Hosted owner-only: `/api/devotional/admin` 404 to a non-owner, 200 to the owner; the author profile resolves to
   the owner claim.
4. Compile deterministic (no Claude key): seed the owner profile with notes, a highlight, a link and a study across two
   chapters with `updated` inside the week and one note outside it → `source` lists exactly the in-window items; the
   html contains the BSB words of John 3:16 **read from `app/data/bibles/bsb/43.json` inside the test** (never typed
   into the test), the label "BSB", Ji's note text escaped, the unsubscribe placeholder, no email address, no token.
5. Compile stitched: FakeClaude returns a draft JSON that includes a ref outside the source and a verse-looking
   sentence in `body` → the stray ref is dropped, the body is kept as text (it is the model's wording, allowed), html
   has the BSB words only from the server; FakeClaude returning garbage → fallback, `stitched:false`, a warning; the
   request to FakeClaude carried the key header, the model, `output_config.format`, and no `thinking`.
6. Approve and send: two confirmed subscribers + one pending + one unsubscribed; approve with `BS_DEVOTIONAL_SEND=now`
   → `tick` → FakeResend got one `/emails/batch` with exactly the two confirmed addresses, each with its own
   unsubscribe token and `List-Unsubscribe` headers, `Idempotency-Key` present; status `sent`, `send.sent == 2`; a
   second tick sends nothing more; FakeResend answering 500 once → retried; `skip` on a sent issue → 409.
7. Schedule: with `BS_DEVOTIONAL_COMPILE=sat 06:00`, `tick(now)` with a Saturday 06:01 local `now` creates the week's
   issue once and mails the author a preview whose review link works (GET → 200 HTML with the issue; POST approve →
   approved); a second tick does not compile again.
8. Hygiene: T99 unchanged plus the fake keys (`re_test_…`, `sk-ant-test-…`) added to `H.tokens` so the leak scan covers
   them; no `@example.test` in the log remains true.

Run `python3 -m pyflakes`-free code (no unused names), `python3 tests/test_server.py T33_Devotional` while building and
the whole suite before handing over; `python3 tools/scripture_lock.py` passes.

## 9. Out of scope

Resend Audiences/Broadcasts (we keep the list), an archive page of past issues, images in the email, the iOS app.
