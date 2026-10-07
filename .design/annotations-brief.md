# Annotations: select words, highlight, comment in the margin. Build brief

Requested by Ji on 2026-10-06:

> "I want the ability to select a text and have a bubble for comments and notes / annotate within the margins of the text so that when saved it can show up in two ways: one on the side drawer, or within an expandable icon on the margins of the text. In addition I want to make the selected text more prominent so it's more visually obvious that the text is selected."

I asked Ji three design questions, but the app quit before Ji answered. These are the defaults I chose; each is one switch if Ji wants otherwise:
- **Bubble:** highlight colours plus Comment, in the Apple Books style.
- **Span:** a selection may cross verses within one chapter.
- **Prominence:** applies both to the words you drag-select and to the verse you click.

## 0. Hard rules

These are the same as the other features:
- **Chapter hero:** do not change it. Annotations never appear in it.
- **Reverence rules apply.**
- **Nothing is lost:**
  - Every write is compare-and-set.
  - Deletes offer Undo.
  - `?dry` blocks every write but keeps the UI working in memory.
- **Copy style:** sentence case, curly quotes, British "colour", no exclamation marks.
- **Testing:** test only on your own `serve.py --port 88xx --data-dir .design/linkstest/<label>`, with `?dry` for read-only checks. **Port 8765 is currently used by another of Ji's projects. Never touch or stop whatever runs there.**

## 1. Data model: a "marks" collection

Marks get their own collection, built exactly like My links (`accounts.py`'s shared `_apply_changes` / `_versions` / `_merge_keyed` helpers). Per-id compare-and-set means two marks on one verse never conflict.

**Files:**
- guest: `DATA/guest-marks.json`
- profile: `DATA/profiles/<uid>/marks.json`

They share the scope lock, `.bak` and corrupt-file rules with links. Lock order: links → marks → library, documented at the lock helper.

**Document:** `{version:1, rev, marks:{id:mark}, deleted:{id:ms}}`. A mark looks like this:

```json
{ "id": "mk_3f9a0c1d2e4b", "tr": "kjv",
  "start": "43.3.16", "so": 4, "end": "43.3.16", "eo": 27,
  "quote": "God so loved the world", "pre": "For ", "suf": ", that he gave",
  "color": "yellow", "note": "", "created": 0, "updated": 0 }
```

- **Ends.** `start`/`end` are `b.c.v` in the same book and chapter, with `start <= end`. `so`/`eo` are offsets in UTF-16 code units into that verse's plain text (§2.1), with `eo` exclusive.
- **Anchor text.**
  - `quote`: the selected text, 1–2,000 chars.
  - `pre`/`suf`: up to 32 chars of context. They are used to re-anchor if the offsets no longer fit.
- **`tr`.** The translation the mark was made in: kjv, bsb, esv or nlt. Word highlighting draws only in that translation. Every other view shows the mark at verse level (§3.4).
- **`color`.** One of yellow, green, blue, pink, purple or orange (reuse the `--bm-*` and highlight tokens), or `""` for a comment-only underline.
- **`note`.** Up to 20,000 chars, markdown like the Notes tab. A mark with an empty note is a plain highlight.
- **Limits:**
  - 20,000 marks per scope;
  - 32 KiB per mark;
  - 1,000 keys per request;
  - clock guard and text cleaning as for links.

## 2. Server (accounts.py, serve.py, tests)

- **Routes:** `GET /api/marks` → `{marks, rev, scope}` with an `ETag`, and `POST /api/marks/changes`. Both have the same semantics, errors and CSRF/X-BS-Scope rules as `/api/links`:
  - 400 `invalid_mark` with `field`;
  - 409 `mark_limit`: "You’ve reached the limit of 20,000 highlights and comments."
- **Activity.** Each new mark appends `{t, type: 'mark.add', ref: start, x: {id, color, note: bool}}` and marks its start verse as studied, as `link.add` does.
- **Existing endpoints:**
  - `stats.totals.marks`;
  - `auth/me` `guest.marks`, with `hasData` counting marks;
  - signup `importGuest` copies marks;
  - `profile/import-guest` merges them idempotently;
  - `export/profile` adds `marks`.
- **`export/obsidian`.** Each annotated verse's file gets a `## Highlights` section. Each line reads `- “quoted words” (KJV, yellow)`, followed by the comment as an indented quote. Missing verse files are created and listed in the index.
- **Tests:** validation, compare-and-set, guest import, exports, hasData, lock order. All existing tests must keep passing (120 now).

### 2.1 Verse plain text

Offsets count characters of the verse's visible reading text only:
- the `.vtext` text content with whitespace kept;
- **excluding** the verse number, badges, footnote/xref markers, the omitted-verse note, Doré slots and any interlinear rows.

Put one shared helper, `verseText(el)`, in `marks.js`. It must not be thrown off by the words-of-Jesus spans or other inline markup.

## 3. Front end

### 3.1 `app/js/marks.js` (new)

Model it on `links.js`:
- per-scope dirty map;
- debounced and keepalive flush with `base`;
- conflict → the newer version, plus a toast with "Keep mine";
- BroadcastChannel `bs-sync` `{t:'marks'}`;
- `bs:auth-changed`;
- `bs:marks-changed` `{reason, ids}`;
- a localStorage mirror;
- dry mode in memory;
- tolerating a 404 or offline server;
- `registerSaver`, so `account.js` `flushAll` and sign-out include marks. Use the same hooks links uses.

Exports (at least):

```
marks, loadMarks, flushMarks, marksInChapter(b, c), marksFor(b, c, v),
saveMark(draft), deleteMark(id, {undo}), anchor(mark, chapterEl) → Range | null,
selectionToDraft(sel) → draft | null, renderVerseMarks(chapterEl), initMarks(A)
```

### 3.2 Selecting text and the bubble

- **When it shows.** A non-collapsed selection inside the reader's verse text, ending on `mouseup`/`keyup` or a touch selection change, shows `#mark-bubble`: a small floating glass toolbar, `role="toolbar"`, with arrow-key navigation. The selection may span several verses of the chapter shown.
- **Contents:**
  - six colour dots ("Highlight yellow", …);
  - Comment;
  - Copy;
  - on an existing mark: Remove highlight.
- **Placement:**
  - Above the selection, flipping below near the top. On touch, always below, so it doesn't fight the iOS/Android selection menu.
  - It never covers the selected words.
  - It stays inside the viewport and clear of the side sheet.
- **Colour dot:** saves a highlight straight away, with toast "Highlighted John 3:16." and Undo.
- **Comment:** turns the bubble into a small comment card next to the selection, styled like the Notes editor:
  - the quote at the top (clipped);
  - a textarea;
  - colour dots;
  - Cancel and Save, with Cmd/Ctrl+Enter to save.
  - Save → the mark is saved with its note, and the margin icon (§3.3) appears.
- **Hidden on:** Esc, scrolling away, a click elsewhere, a chapter change.
- **Never shows:**
  - in pick mode (My links);
  - for selections in the hero, the side panel or form fields;
  - with Original (interlinear) on;
  - on omitted verses.

**More prominent selected text** (Ji's second request):
- **Selection colour.** A strong, clearly visible `::selection` in the reader (`.vtext`): about 35–40% accent tint, with text staying fully readable in light and dark and on words-of-Jesus text. Keep the existing `.woc::selection` fix.
- **Keep the selection visible.** While the bubble or comment card is open, draw the pending range with the CSS Custom Highlight API (`CSS.highlights`, a `::highlight(mark-pending)` rule), because the native selection disappears when focus moves into the textarea. Where the API is missing, fall back to wrapping spans.
- **Clicked verse.** Give the clicked verse (`.verse[aria-current="true"]`) a bolder look:
  - a stronger tint;
  - a 3px accent bar at the left edge, inside the padding so the layout doesn't shift;
  - a subtle shadow in dark mode.
  - Check light, dark, forced colours (keep its outline) and print (none).

### 3.3 Showing marks in the text and the margin

- **In the text.** Draw saved highlights with the Custom Highlight API, one highlight per colour (`::highlight(mark-yellow)` …, using translucent `--bm-*` tokens). Comment-only marks get a dotted underline. Re-anchor after every chapter render, translation change and `bs:marks-changed`:
  1. Try the offsets.
  2. If `quote` doesn't match there, search for `pre + quote + suf`, then `quote` near the old place.
  3. If none fits, treat it as unanchored: show it only in the margin and the drawer, marked "text moved".
- **Clicking highlighted words** (hit-test with `caretPositionFromPoint` against the ranges) opens the mark's margin popover rather than selecting the verse.
- **Margin icon.** A `.b-ann` badge in the verse gutter (`.badges`) of the mark's **start** verse:
  - a speech-bubble icon with a count of commented marks;
  - highlights without a note don't add a badge;
  - order: after `.b-link`, before the note, video and `.b-media` badges;
  - name: "2 comments. Show them".
  - It has to fit the 50px desktop gutter like the others did (L3 measured this).
- **Expandable popover.** Clicking the icon opens it in the margin, beside the verse (not a modal). On phones it's a bottom card.
  - **Contents:** a card for each comment on that verse, with:
    - the colour bar;
    - the quoted words (click → flash them in the text);
    - the comment rendered as markdown, folded after 6 lines;
    - the date;
    - a ⋯ menu: Edit, Change colour, Copy, Delete with Undo.
  - **Closing:** Esc closes it, and focus returns to the icon.

### 3.4 In the side drawer (Notes tab)

- **Notes tab, verse view.** Add a "Highlights and comments" group under the note editor for the selected verse, listing every mark touching it, in any translation:
  - the quote;
  - "KJV" when it differs from the reader's translation;
  - the colour;
  - the comment;
  - Edit and Delete.
  - "Show in text" scrolls to the words and flashes them.
  - The `#cnt-notes` count includes them.
- **Notes tab, chapter and All notes views.** Marks are listed with notes, filterable by the same search box: quote, comment and colour name.
- **Library.** Activity rows "Highlighted {John 3:16}" / "Commented on {John 3:16}", and a "Highlights" stats tile when there are any.

### 3.5 Other wiring

- **main.js:** `loadMarks()` joins boot `Promise.all` and `onScopeChange`; `initMarks(A)`; the Esc chain closes the bubble or popover first.
- **Help:** "Select words to highlight or comment".
- **Settings:** none in v1.
- **Print:** highlights print as a light tint; icons and bubbles are hidden.

## 4. Acceptance checks

1. Server tests pass, with new ones. Every JS file passes jsc.
2. The hero is identical to `.design/linkstest/hero-baseline.json`, with and without marks on John 1.
3. On your own server, a new @example.test profile:
   - highlight within a verse and across 3 verses;
   - comment, edit, recolour, delete + Undo;
   - reload → persisted;
   - two tabs → a conflict toast and no loss;
   - sign out → hidden;
   - guest mark + sign-up import → copied;
   - import again → no duplicates.
4. Words-of-Jesus verses (John 3:16, Mark 13:1) highlight correctly. Switching KJV ↔ BSB:
   - the KJV mark draws its words in KJV only;
   - in BSB the margin and drawer still show it, labelled KJV.
5. The bubble works with mouse, keyboard (Shift+arrows to select, then Tab into the bubble) and touch emulation, at 1440, 820 and 390. It never covers the selection. Esc works.
6. The selected-text and clicked-verse prominence are visible in light and dark, and contrast is ≥ 4.5:1 for the text over the tint.
7. Exports contain the Highlights sections and `marks`.
8. `?dry` makes no POST.
9. No console errors.
10. My links, study videos, Doré badges and bookmarks still work alongside marks in the gutter.
