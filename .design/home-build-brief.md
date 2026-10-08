# Build the Bible Lantern home page (direction C) into the app

Ji chose mock **C, editorial with Doré**, in `app/mock/home-c.html`, with The Creation of Light as the guest cover too. Ji asked (2026-10-08) to "update and add this latest home page to the production website and merge".

Build it into the real app, faithfully to the mock's design: same layout, type, motion, Doré hero with the light falling across it, and lantern mark. Use real data.

## 1. Routing and chrome (main.js, index.html)

- **When Home shows.**
  - `#home`, or a bare URL with no chapter in the hash, shows the Home view instead of the reader.
  - A bare URL **no longer auto-resumes** the last position. Home's "Continue reading" card offers it instead. Update the §5.9 resume-on-boot logic accordingly. A chapter hash still opens the chapter exactly as today, and the "Continue reading" resume prompt keeps its current behaviour inside the reader.
- **Leaving and returning.**
  - Navigating to a chapter (search, a book map tap, Continue, Start reading, back/forward) leaves Home. Browser Back returns to it.
  - The Home view replaces `#page` content visually. Use a sibling `<main id="home">` and hide the reader and stage while it's shown.
  - The study sheet stays closed on Home.
- **Top bar.**
  - Add a compact **Bible Lantern** wordmark with the lantern mark at the left of `#topbar`. It's a link to `#home` with aria-label "Bible Lantern home".
  - Keep every existing top-bar control, and check that the top bar still fits at 390, 820 and 1440 (on phones the wordmark may collapse to the mark only).
  - Keyboard: a shortcut `h` goes Home. Add it to Help.
- **Name.**
  - The document title becomes "Bible Lantern" on Home and "John 3 · Bible Lantern" in the reader; it was "Bible Study".
  - Update `<title>`, the `apple-mobile-web-app-title` / manifest name if present, and the README's first line.
- **Chapter hero.** It stays exactly as it is. Run the hero check against `.design/linkstest/hero-baseline.json`; only the topbar wordmark is new, outside `header.hero`.

## 2. The Home view (new `app/js/home.js` + `app/css/home.css`, linked from index.html)

Port the mock's markup and CSS into the module. Use the app's tokens, not page-local copies where tokens exist, and drop the mock-only state switch and theme toggle. The app's own theme applies.

**Which state shows:**
- **Today** when signed in, or in local mode (not hosted) even as guest, since local guests can save.
- **Welcome** for a hosted guest (`auth/me` `hosted && !signedIn`).

**Today, with real data:**
- **Greeting and date.** Use the profile name if any, otherwise no name.
- **Search.** Uses the app's search (`main.js` goReference / runSearch): a reference opens the chapter, a word or Strong's number opens the Search tab in the sheet.
- **Verse of the day.**
  - The mock's curated list with plates, chosen by day of year, with the plate from `art.json`.
  - The text comes in the reader's current translation where available (KJV/BSB bundled), falling back to KJV.
  - "Open the verse" goes to the verse.
- **Continue reading.**
  - From library.js `currentPosition()` / the tracker position.
  - Shows the chapter's progress (verses seen or the read state from the library chapter record) and a snippet of the verse.
  - Resume goes there.
  - Hidden when there is no position. Then show "Start reading" (John 1) and "Genesis 1".
- **Your study, recently.**
  - The latest notes (store notes, by `updated`), highlights and comments (marks.js), and links (links.js), up to 6 merged by time, each opening its verse.
  - Streak and chapters this week come from library stats (`days`), as the Library dialog computes them. Reuse its helpers rather than duplicating them.
  - An empty state when there's nothing yet.
- **The whole Bible.**
  - The 66 books by division, shaded by chapters read (library chapters).
  - Tapping a book shows its chapters inline, as in the mock, with read chapters shaded; a chapter opens it.
- **Live updates.** Update on `bs:auth-changed`, `bs:notes-*` / `bs:links-changed` / `bs:marks-changed` and library refresh, without a full reload.

**Welcome (hosted guest):**
- **Hero.** The mock's cover, using The Creation of Light, the Bible Lantern wordmark and the Psalm 119:105 KJV line.
- **Buttons.**
  - **Start reading** (John 1).
  - **Sign in** opens the app's sign-in dialog.
  - **I have an invite** opens the sign-up dialog, showing the invite field.
- **The four previews,** with real data as in the mock (arcs, map + timeline, Hebrew/Greek, engravings), loaded lazily, plus the book map.

**General:**
- **Performance.** Home must not slow the reader. Import home.js dynamically when Home is first shown. Previews and plates load lazily. Don't block boot on art.json for the reader.
- **Accessibility.** Landmarks, one h1, headings, focus management when entering and leaving Home (focus the h1 on entering by keyboard), alt text, contrast ≥ 4.5:1, reduced motion, forced colours, print (Home prints the verse of the day only, or nothing heavy).
- **Copy.** Sentence case, curly quotes, British spelling, no exclamation marks, reverent. No sample/mock content may remain in the real Home.

## 3. Checks

- jsc on all JS; server tests (156) pass.
- Hero check: the chapter hero is unchanged.
- **Your own `serve.py`, local mode:**
  - a bare URL shows Today with guest data;
  - `#43/3` opens John 3;
  - Back returns to Home;
  - `h` and the wordmark go Home;
  - search works;
  - Continue reading resumes;
  - the book map opens chapters;
  - recent study lists real notes, highlights and links you create (@example.test profile);
  - light and dark;
  - 1440, 820 and 390;
  - no console errors.
- **Your own `serve.py` with `BS_HOSTED=1 BS_OWNER_EMAILS=owner@example.test`:**
  - a guest sees Welcome with previews;
  - Sign in and "I have an invite" open the right dialogs;
  - after sign-in, Today appears.
- **Port 8765** (Ji's local app, possibly not running): never touch it. Use your own 88xx servers only.
