# Library → Study: build brief (the real feature)

Ji approved the round-2 mock-ups (`app/mock/library-study.html`, `-recap.html`, `-connect.html`, `-doc.html`, with `study-sample.js`, `study-shell.css`, `study-shell.js`; design notes in `.design/library-study-brief.md` and `.design/library-study-v2-brief.md`) with two instructions: **"implement this"** and **"remove Constellation on the Connected menu"**. The Obsidian round is not wanted. Ji also asked for it to be simple: build what the mocks show, nothing more.

The mocks are the visual and behavioural spec. Port their logic (`study-sample.js`: `themesFor`, `threads`, `connections`, the `[[` picker, the study builder) into the real app with real data; port their CSS into the app's stylesheet. Where a mock and this brief differ, this brief wins.

## 0. Hard rules

- The chapter hero (`header.hero`) is unchanged: run the hero check against `.design/linkstest/hero-baseline.json`.
- Reverence rules; copy in sentence case, curly quotes, British spelling, no exclamation marks.
- Nothing is lost: every write is compare-and-set or rev-checked; deletes offer Undo; `?dry` blocks writes.
- Hosted guests are read-only: Study shows the sign-in card where the mock shows personal data (as Library does today).
- Work only in the worktree you are given (ROOT). Never touch production, `notes/` or port 8765. Test on your own `serve.py` (88xx, temp data dir, @example.test profiles).

## 1. Data

### 1.1 Note references (front end only)

A note's markdown can reference a verse, `[[John 1:4]]` (already rendered as a verse link by `drawer.js renderMd`), or **a highlight or comment**, written `[[John 1:4 · “the light of men”]]`: the verse plus the first words of the mark's quote in curly quotes. Rules:
- `study.js` exports `parseRefs(text)` → `[{raw, b, c, v, quote?}]`, `resolveRef(ref)` → `{kind:'verse'|'mark', b, c, v, mark?}` (a mark is matched by verse and quote prefix, case-insensitively; no match falls back to the verse), and `backlinks(target)` → the notes and marks whose text references that verse or mark.
- `renderMd` renders a mark reference as a chip: colour dot, reference, quoted words; clicking goes to the verse and opens its margin popover (marks.js) or the Notes tab.
- **The `[[` picker** in the Notes tab editor (`drawer.js notesTab`) and in the mark comment editor (`marks.js`): typing `[[` opens a small list filtered as you type, of verses (parse a typed reference), the chapter's marks and notes, and recent marks and notes; Enter inserts the reference; Esc closes. Keyboard and touch.
- Under the editor, **Mentioned in** lists the backlinks of the current verse and of each mark on it (sentence + a link).
- The Obsidian export (`accounts.py _vault_links`) must turn `[[John 1:4 · “words”]]` into `[[John 1.4|John 1:4 · “words”]]` (verse page link with the label kept).

### 1.2 Themes (front end, with choices stored on the server)

- `study.js themesFor(entries)` ports the mock's algorithm: each entry's verse against `app/data/topics.json` (150 topics with ranked verses `[b,c,v,ve,votes]`), plus weight from its OpenBible cross-references (`app/data/xref/NN.json`), plus the reader's own `#tags`; the strongest topics become suggested themes with a one-line "why". Topic names are rendered in sentence case; the mock's `NOT_SUGGESTED` list of contested names stays.
- **Choices** (accept, rename, merge, remove) are stored in the notes document as `themes: {accepted: [name], renamed: {name: label}, merged: {name: into}, removed: [name]}` (server §1.4).

### 1.3 Threads and connections (front end only)

Port `threads(entries)` (chains joined by the reader's references, extended by shared cross-references) and `connections()` as the mock has them.

### 1.4 Studies and theme choices (server + client)

- The notes document gains two validated fields beside `refs`: `studies` (already present, always `[]` today) and `themes`.
  - A study: `{id: 'st_' + 12 hex, title ≤ 200 chars, intro ≤ 20,000 chars markdown, order: 'studied'|'bible'|'custom', entries: [{key}] ≤ 500 where key is a note key `'b.c.v'` / `'b.c'` or a mark id, created, updated}`. At most 200 studies.
  - `themes`: the choices object above; names ≤ 100 chars, ≤ 500 entries in total.
- **Endpoint.** `POST /api/notes/changes` accepts optional `studies` and `themes` (whole-replace of each, with the request's `baseRev` as the guard: a stale `baseRev` returns `409 rev_conflict` with the current `rev`, `studies` and `themes` so the client can merge and retry). `GET /api/notes` returns both. Validation errors are `400 invalid_study` / `invalid_themes` with `field`.
- **Everywhere notes go:** `export/profile` includes them; `profile/import` and `import-guest` merge them (a study by id, newer `updated` wins; theme choices union, newer wins per key); signup `importGuest` copies them; `stats.totals.studies`.
- **Obsidian export** adds `Studies/<title>.md`: the intro, then each entry as the verse (`[[John 1.4|John 1:4]]`), the verse text, the highlighted words and the note.
- Activity: `study.save` rows ("Made a study: {title}" / "Updated a study") like `note.save`.
- Tests for all of it (184 pass now; they must keep passing).

### 1.5 Client data layer (`store.js`)

`state.notes.studies` and `state.notes.themes` are loaded with notes, saved through the same debounced flush with `baseRev`, broadcast with `bs:notes-replaced`, kept in the localStorage mirror, dry-mode in memory, offline-tolerant, and never queued for a hosted guest.

## 2. The Study views (`library.js` + `styles.css`; new `app/js/study.js` for data and shared pieces)

Library gets a **Study** entry beside **My map** (a tile or link on the Library home, and `openLibrary({view:'study'})`). Study has a segmented control: **This month · Connected · Studies**, and keeps one shared context (range, theme, book, thread) across the three, as the mock does with URL params; in the app it is kept in the dialog's view state, so switching tabs never loses it. Phones: the Library is already a full-screen sheet; Study's layouts stack as in the mock at 390.

### 2.1 This month

The mock's recap with real data: the month stepper and 7/30/90 days; the headline from the reader's own highlighted words (the first and last highlights of the range, as the mock does); the one-paragraph summary; the totals (notes, highlights, comments, your links, chapters read, from `state.notes`, marks.js, links.js and library stats); **the thread of the month** with its chips, "Cross-references bring in…", other threads, and See this thread; **Themes** (with Suggested badges, accept / rename / merge / remove, Show more, Your tags, No suggestion yet); **Books** bars from library per-book seconds and chapters; **Your highlights** feed (highlighted words in the verse, the comment beneath, Mentioned in); and **Make a study from this month**. Empty states for a new profile ("Nothing yet this month. Highlight a verse or write a note and it appears here.").

### 2.2 Connected

**Two views only: Threads and Theme board.** No Constellation (Ji's instruction): remove it from the segmented control and build none of it. The filter row (range, theme, book, kind) and the context bar with "‹ This month" stay. Threads: the timeline with the thread lines, exactly as the mock. Theme board: columns per theme with drag to re-theme (which records a choice) and the ⋯ menu; the horizontal scroller with edge fades at desktop widths and the one-column theme picker on phones. The note card (reference, verse text, highlight, note, themes, References, Mentioned in, "Part of the thread of the month" / "One of N notes in <theme>" linking back to This month) and **Edit note**, which opens the Notes tab for that verse in the study sheet.

### 2.3 Studies

The mock's Studies home (your studies; start from This month / a theme / dates / picked notes), the builder (title, introduction, passages with As studied / Bible order / Your order, drag and keyboard reorder, remove with Undo, Add notes, the "In each passage" switches), and the reading view (the printed-guide look, with Print, Export as Markdown (a client-side download; the Obsidian zip covers the vault form) and Copy link disabled "Coming later"). Studies are saved to the server (§1.4) with Undo on delete.

## 3. Checks

- jsc on all JS; the server tests pass with the new ones.
- Hero check: identical.
- Your own `serve.py` with an @example.test profile: write notes with `[[` references (verse and mark), see chips and Mentioned in; make highlights and comments; check This month's totals, thread and themes match the data; accept/rename/merge a theme and reload (persisted); Connected Threads and Theme board, drag a card; make a study from the month, reorder, read, print preview, export markdown; two tabs: a study saved in one appears in the other; `?dry` makes no POST; hosted guest sees the sign-in card; no console errors; light and dark; 1440, 820, 390.
