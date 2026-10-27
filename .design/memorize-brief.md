# Memorize: the build brief

Ji (2026-10-26): "a net new feature that allows you to bookmark text and select them to memorize under your profile
library … a small selection that says memorize that allows it to be front and center until it's fully written on the
heart." Ji approved the mock-ups (`app/mock/memorize-*.html`, brief `.design/memorize-mock-brief.md`; they are the
look to match, screen by screen) with two answers:

1. **"1 verse at a time with others teed up up to three."** One *current* verse, front and centre, and up to three
   more waiting in line (*Up next*). Nothing else is scheduled: a teed-up verse waits until it is current.
2. **"I like the typing option as that will help."** Typing is offered everywhere (phones too), and the app checks
   what was typed word by word against the verse, so the reader sees which words were missed.

Simple, as Ji always asks: one idea per screen, nothing that nags. Copy: sentence case, curly quotes, British spelling
(the feature's name stays "Memorize", as Ji wrote it; the verb is "Practise", the noun "practice"), no exclamation
marks. Reverence: never present God as a person among people (the feature shows only Scripture and the reader's own
progress). Hero rule: nothing in the chapter hero changes. Hosted guests can't save (the existing `guestBlocked()`
sign-in prompt), as for highlights.

## 1. The model (pure: `app/js/memsched.js`, no imports, so `jsc` can test it)

A **memory verse** is one verse or a short passage in one chapter, in one translation:

| field | meaning |
|---|---|
| `id` | `mv_` + 12 lowercase hex (made in the browser, like `mk_` ids) |
| `ref` | `"b.c.v"` or `"b.c.v-w"` (w > v, same chapter, at most 12 verses) |
| `tr` | one of `kjv bsb esv nlt niv nkjv nasb` (the text it was chosen in) |
| `pos` | a number: the place in line (lower = sooner). Add: max(pos of learning verses, 0) + 1. Make current: min(pos of learning verses) − 1 |
| `step` | 0–6: due reviews recalled so far. 6 = written on the heart |
| `due` | `''` (not started) or a local day `YYYY-MM-DD` |
| `heart` | `''` or the local day it was written on the heart |
| `last` | ms of the last judged review, or 0 |
| `created`, `updated` | ms (`updated` drives the compare-and-set sync, exactly as marks) |

Derived (never stored):
- **Learning** = verses with `heart === ''`, sorted by `pos`, then `created`, then `id`. **Current** = the first;
  **Up next** = the rest (normally ≤ 3). **Written on the heart** = `heart !== ''`, newest `heart` first.
- **Capacity**: adding is refused when learning already has 4 (current + 3 teed up). Written-on-the-heart verses
  never count. (Two devices adding at once may make 5: show them all; never lose one.)
- **Due**: the current verse is due when `due === ''` or `due <= today`. A heart verse is due when `due === ''` or
  `due <= today` (a heart verse whose day was lost in a load-time repair is reviewed at once, never dropped).
  Teed-up verses are never due.
- **Review number**: "review {step + 1} of 6" while learning.

The schedule (`GAP = [1, 2, 4, 7, 14]` days; then about three months):
- **Got it** on a due review of the current verse: `step += 1`; if `step === 6` → `heart = today`, `due = today + 90`;
  else `due = today + GAP[step − 1]` (review 1 → 1 day, review 2 → 2, review 3 → 4, review 4 → 7, review 5 → 14,
  review 6 → written on the heart: about four weeks from the first practice). `last = now`.
- **Got it** on a due heart verse: `due = today + 90` (step stays 6). `last = now`.
- **Not yet** on a due review (current or heart): `due = tomorrow`, step unchanged ("Again tomorrow"). `last = now`.
- **Not today** (Home): `due = tomorrow` (an Undo puts back the old `due`).
- **Any other practice** (a teed-up verse, or one not due yet) is a free practice run: nothing changes.
- When the current verse is written on the heart, the next in line simply becomes current (derived; no write) and is
  due at once (`due === ''`).

Exports (names are a suggestion; keep them small and pure): `GAP`, `HEART_GAP = 90`, `addDays(day, n)`,
`dayDiff(a, b)`, `organize(list, today)` → `{ current, upnext, heart, dueHeart, full }`, `isDue(v, today)`,
`judge(v, result, today, now)` → the updated fields or `null` (free practice), `reviewLabel(v)`,
`whenLabel(v, today)` ("Due today", "Tomorrow", a weekday within 6 days ("Thursday"), else "Thursday 12 November";
for a heart verse "Next review in January" style is fine), `tokenize(text)` → words with their trailing punctuation
(keep ’ and ' inside words; LORD and GOD stay words), `fadeMask(n, level)` (level 1: every third word from the second
hidden; level 2: two of every three; never the first word), `firstLetters(words)`, `compareTyped(verseWords, typed)`
→ `{ right, total, missed: [indexes of verse words not matched], extra: [typed words not matched] }`: an LCS alignment on
normalised words (lower case, curly → straight apostrophes, punctuation and verse numbers dropped), where a word of 5+
letters one edit away still counts as right (a typo is not a lapse of memory).

## 2. The server (accounts.py, serve.py): a third per-key collection, exactly as marks

Mirror the marks collection; serve.py's `KEYED` handler pair already serves links and marks generically.
- accounts.py: `MEMORY_VERSE_ID_RE = re.compile(r"mv_[0-9a-f]{12}", re.ASCII)`, `MAX_MEMORY = 1_000`,
  `memory_path(scope)` (`DATA/guest-memory.json`, `profiles/<uid>/memory.json`; `GUEST_MEMORY` in `configure`),
  `clean_memory_verse(raw, now=None, check_size=True)` (the table above: ref valid in this Bible and ≤ 12 verses in one
  chapter, tr in `MARK_TRS`, pos a finite number with |pos| ≤ 1e12, step int 0–6, due/heart `''` or a valid day,
  heart set ⇒ step 6, last/created/updated whole ms ≥ 0 with the usual clock guard, unknown fields dropped, ≤ 2 KiB),
  `_salvage_memory_verse`, `empty_memory`, `load_memory`, `save_memory`, `apply_memory_verse_changes`,
  `memory_verse_versions`, `merge_memory` (guest → profile and profile-file import; new ids stop at `MAX_MEMORY`),
  `add_memory_verse_activity` → `False` (no activity rows: nothing new in the Library's activity feed). Lock order and
  its docstrings: notes → links → marks → memory → library.
- serve.py: `KEYED["memory"] = ("memory_verse", "memory verse", MEMORY_WINDOW)` (a rate window like marks'), routes
  `GET /api/memory` and `POST /api/memory/changes`, and memory everywhere marks are carried: sign-up with guest data,
  `POST /api/import/guest`, the profile-file import, `GET /api/export/profile` (`"memory": {"memory": {...}}`),
  `guest_summary` (`memory` count and `hasData`), the revs a response returns, and the module's docstring lists.
  Profile deletion removes the profile directory already (check). Error codes `invalid_memory_verse`,
  `memory_verse_limit` (message: "You’ve reached the limit of 1,000 memory verses.").
- tests/test_server.py: a new class covering GET/POST, validation (bad id, ref, range > 12, cross-chapter, tr, step,
  heart without step 6, sizes), compare-and-set conflicts and versions, the limit, guest import, profile export and
  import, a hosted guest refused, and that the earlier 207 tests still pass.

## 3. The browser data layer (`app/js/memory.js`)

The marks.js data layer, adapted (read marks.js lines 90–492 and copy its rules, not its anchoring): a dirty map per
scope, a debounced and keepalive flush with compare-and-set bases, conflicts (toast "Your memory verse … changed in
another window. Showing the newer version." with Keep mine), cross-tab `broadcast({t: 'memory'})`, the browser mirror
(`bs-memory-v1`, `bs-memory-dirty-v1`; never kept for a hosted guest), the 404 / offline fallbacks, `?dry` (nothing
saved; toasts say "Dry run: nothing is saved."), `registerSaver('memory', …)`, and the save status shared with the
notes. main.js loads it with the others at boot and on every sign-in change (where `mrkCall('loadMarks')` is), and
account.js's broadcast list after an import gains `'memory'`. Events: `bs:memory-changed {reason, ids}`.

Actions (each refuses with the `guestBlocked()` prompt for a hosted guest):
- `memorize({ b, c, v, ve, tr })`: one entry per passage; the same `ref` already there (any translation) → toast
  "John 3:16 is already one of your memory verses." with **Practise**. Learning full → toast "Three verses are already
  teed up. Remove one to add John 3:16." with **Open Memory**. Otherwise add it; it becomes current when there was none →
  "John 3:16 is your memory verse now." with **Practise now**; else "Added John 3:16 to your memory verses, next in
  line." (second / third in line) with **Show** (Library › Memory).
- `makeCurrent(id)` → "John 3:16 is your memory verse now." The verse it displaced keeps its progress and is first in
  line.
- `removeVerse(id)` → "Removed John 3:16 from your memory verses." with **Undo** (same id and fields).
- `notToday(id)`, `undoNotToday(id, oldDue)`, `recordPractice(id, result)` (through `memsched.judge`).
- Place in line: `memoryIsUpnext(x)`, `memoryDue(x)`, `memoryWhen(x)` and `memoryGotIt(x)` work out whether a verse
  is teed up themselves. practice.js, home.js and library.js call these (and `recordPractice`), never memsched's
  `isDue`, `whenLabel`, `gotItLabel` or `judge` with a guessed `upnext` flag (left out, it treats a teed-up verse as
  current: "Due today", and a schedule moved on).
- Queries: `memoryList()`, `organizedMemory()` (memsched.organize for today), `memoryFor(b, c, v)` (the entry whose
  first verse is v, for the gutter), `findByRef(ref)`.
- Text: `memoryText(entry)` → `{ tr, text, verses: [{v, t}], credit, fallback }`: bundled KJV/BSB from
  `data.bible`, passage texts (ESV, NLT, NIV, NKJV, NASB) through `data.passage` (their copyright line comes with it:
  `data.passageCredit` for NIV/NKJV/NASB, store.js `COPYRIGHT` for ESV/NLT; NIV/NKJV/NASB also need one FUMS
  `trackView` per practice opened: practice.js calls reader.js's exported `fumsView(credit.fumsToken)` once per opening). When the text can't be had (a translation not available here, a network
  failure), `fallback` is the KJV and the practice says so. Home and the Library show first words only for KJV/BSB
  verses (no API calls for a list); passage-translation rows show the reference and translation only.

## 4. Choosing a verse (marks.js, library.js's bookmark menu, reader.js's gutter)

- The selection bar (`bubbleHtml` in marks.js): after Copy, a separator and **Memorize** (the glyph, label "Memorize";
  on a phone the bar shows icons only, as it does now). It saves the verse(s) the selection touches, in the
  selection's translation (a draft's `tr`), then closes the bar. Already memorized: the button reads "Practise" and
  opens that verse's practice.
- The bookmark menu (`openBookmarkMenu` in library.js), for a verse bookmark: **Memorize this verse** (or **Practise
  this verse** when it is one), above the separator before Remove bookmark; translation = the reader's current one.
- The gutter: a memory verse's first verse gets a small `.b-mz` badge (the glyph, 14 px, lamp ink), right after the
  bookmark ribbon (before My links' badge). A button: aria-label "Memory verse: John 3:16. Practise", title "Memory
  verse"; it opens the practice. Added and removed in place on `bs:memory-changed` (like `refreshAnnBadges`), never
  by re-rendering the chapter. The icon: icons.js gains `memorize` (the mock's path: three lines of writing ending in a
  small heart, after Proverbs 3:3; never the Support heart).

## 5. The practice (`app/js/practice.js`, styles in `app/css/memory.css`)

A `<dialog class="modal practice" id="practice">` made once by practice.js, opened with ui.js `showDialog` and closed
with `closeDialog` (Escape, the close button, the backdrop as other modals); focus returns to what opened it; it can
open over the Library dialog. Desktop: a centred dialog 600 px wide, a fixed height (it doesn't jump between steps);
phone: a full sheet. Exactly the mock's look (`memorize-practise.html`): the reference as the title, the sub line
"KJV · review 3 of 6 · about a minute" (heart verse: "KJV · written on the heart"; free practice: "KJV · practice
run"), a four-step segmented control (radiogroup) **Read · Fade · First letters · Recall**, the verse in the reading
serif (26 px desktop, 22 px phone; verse numbers as small superscripts when a passage has more than one verse; LORD
and GOD in small capitals), the footer with the step's buttons.

- **Read**: the verse; hint "Read it through slowly, aloud if you can." → **Next**.
- **Fade**: a third of the words hidden as soft blanks (tap or Enter to peek for 1.6 s), **Hide more** (two thirds),
  **Next**. Hint "A third of the words are hidden. Tap a gap to peek."
- **First letters**: each word's first letter (punctuation kept), tap to peek. Hint "The first letter of each word.
  Say the verse as you go; tap a letter to peek."
- **Recall**: an empty space with a text box on every screen ("Type it here, if you like"; spellcheck and autocorrect
  off); hint "Say it aloud, or type it. Then show the verse to check." → **Show the verse**.
- **Check**: the verse. If something was typed: "You had 23 of 25 words." and the verse's missed words marked (a lamp
  underline, and named for a screen reader), with the typed text below ("You typed") and its extra words struck
  lightly. Then **Not yet** ("Again tomorrow") and **Got it** (its next gap: "Next review in 4 days", or "Written on
  the heart" for review 6, or "Next review in about three months" for a heart verse). Focus goes to Got it, or to Not
  yet when the typed score is under 80 %. A free practice run shows **Done** only, with "A practice run: your next
  review is still Thursday." (or, for a teed-up verse, "A practice run: it starts when it’s your memory verse.").
- **End**: Got it → "Well done." + "Next review Thursday 29 October." + the six dots; Not yet → "No hurry." + "Again
  tomorrow, Tuesday 27 October."; **Done** closes.
- **Written on the heart** (review 6 recalled): the quiet moment of the mock: the verse, a short lamp rule, "Written on
  the heart" (italic serif, lamp ink), the date, "Next up: Psalm 119:11" when there is one, and Proverbs 3:3 small:
  “write them upon the table of thine heart” (KJV, cited "Proverbs 3:3"). Footer "From now on, a review about every
  three months" and **Done**. No confetti, no sound.
- Where it starts: Read for reviews 1–3 and a first practice; **Recall** for reviews 4–6 and heart reviews (a test
  should come before the reveal; the other steps stay one tap away).
- Licensed texts: the publisher's copyright line under the verse (`.copyright` look) and one FUMS view per opening.
  The KJV fallback says "Shown in the KJV: the NIV isn’t available right now."
- Live region announcements: the step ("Step 2 of 4: Fade"), a peeked word, the result. Reduced motion respected; 44 px
  touch targets on a phone; forced colours legible (blanks stay visible as outlines).
- Exported: `openPractice(id, { returnFocus })`.

## 6. Front and centre (home.js, library.js)

- **Home › Today** (not the hosted Welcome): straight after the cover, before Continue reading, a `section.cont.dk`
  band "Your memory verse" exactly as the mock's (`memorize-home.html`: kicker, reference, the six dots with
  "KJV · Learning · review 3 of 6", "Due today · about a minute", the faded first words on wide screens, **Practise**
  and a quiet **Not today**; after Not today "Moved to tomorrow." with **Undo**). Not due: "Next review Thursday" with
  a quiet **Practise** (a free run). A heart verse due and a current verse too: one small line under the band's
  buttons, "Also due for review: Proverbs 3:5–6" (a button that opens its practice). No current verse but a heart
  verse due: the band shows that verse ("A verse on your heart", "Written on the heart · review due", Practise / Not
  today). Nothing to show: no band at all (never an empty prompt on Home). The phone layout of the mock (compact,
  Practise beside the reference). Redraws on `bs:memory-changed`.
- **Library home**: a small **Memory** card after the Study card: "Memory" with a count ("1 learning, 2 up next, 3 on
  the heart"), the current verse's reference and when ("John 3:16 · Due today"), and **Open Memory** (the glyph). An
  empty profile: "Verses you’re learning by heart. Select a verse and choose Memorize." with no button.
- **Library › Memory** (`openLibrary({ view: 'memory' })`, a navbar Back to Library as the other views): the title
  "Memory", the sub "Verses you’re learning by heart", the current verse pinned (the mock's `.lib-continue` card with
  **Practise**), then **Up next** ("2 of 3" in the group header's count while there are 3 or fewer; just the number,
  "4", when two devices or an import left more: Home and the Library list every teed-up verse and never assume three)
  and **Written on the heart**, each row: the
  reference · translation, the first words (KJV/BSB), the dots and when (heart rows: "Since 12 October · next review in
  January"). A row opens its practice; its ⋯ menu (ui.js `openMenu`, as the bookmark rows): **Practise**, **Make
  current** (Up next rows), **Remove** (danger). The empty state of the mock. Focus kept across re-renders (focusSel /
  focusAlt as the bookmark rows).
- The iOS app needs nothing native: it shows the page. `BL.open('memory')` is a one-line addition to shell.js
  (`openLib({ view: 'memory' })`) so a future native shortcut can reach it.

## 7. Done means

Every server test passes (207 + the new ones); `jsc` clean on every touched module and the memsched tests pass
(`tests/memsched_test.js`, run with `jsc -m`); the hero check unchanged; the whole flow works on a local server with an
@example.test account, at 1440×900 and 390×844, light and dark: select → Memorize → toast → gutter badge → Home band →
Practise through all steps with typing → Got it → Library › Memory (Make current, Remove + Undo, the cap of three teed
up, written on the heart via a test profile whose verse is at review 6) → sign out and in (it syncs) → a second tab
(it follows). No console errors.
