# Verses in your notes, ready to link (build brief, stage NL1)

Ji (2026-10-20): "I want to make improvements to the webapp feature for links: as I do my Bible study and add verses to my notes, those Bible verses should be readily available for ‘Mine’ link connection. That way I can see what I am connecting, allowing me to stitch connections with context."

Today a note (or a highlight's comment) can reference verses as `[[John 1:4]]` or `[[John 1:4 · “the light of men”]]` (study.js `parseRefs` / `resolveRef`, the `[[` picker, Mentioned in), and My links (links.js, the study panel's Mine tab, `.design/links-spec.md`) connects verses. The two never meet: a verse named in a note is not offered as a link. This stage joins them, front end only, in three places. Keep it simple and quiet: Ji asked for simple designs; nothing here may nag.

## 0. Hard rules

- The chapter hero (`header.hero`) is unchanged; nothing in the reader changes. Hero check against `.design/linkstest/hero-baseline.json` (fresh, taken on main 2026-10-19).
- No server or data-model change: links are made with the existing `saveLink` through the existing composer. No new storage (no dismiss list).
- Reverence rules; copy in sentence case, curly quotes and apostrophes, British spelling, no exclamation marks.
- Dry mode, hosted guests (`guestBlocked`, read-only), offline: behave as the Mine tab does today.
- The iOS app runs this page in app-shell mode (`html.app-shell`, `app/js/shell.js`): nothing here may break it; phone widths matter (the study sheet at 390 px).

## 1. Suggestions: what counts (study.js)

Export `noteLinkSuggestions(b, c, v)` (v = 0: the whole chapter) → a list of suggestions, each

`{ here: {b, c, v}, other: {b, c, v, ve}, dir: 'out' | 'in', sources: [{entry, ref, snippet}] }`

- **out**: a reference in the text of an entry *on* `here`: the verse note `b.c.v`, or the comment of a highlight/comment whose start verse is `here`. `other` is the referenced verse.
- **in**: an entry elsewhere (a note or a mark's comment, on another verse) whose text references `here` (use `backlinks`). `other` is that entry's verse.
- A mark reference (`[[John 1:4 · “words”]]`) counts as its verse. A range `[[Isaiah 53:4-6]]` gives `other` that range when it stays in one chapter, else its first verse. A chapter reference (`[[Psalm 23]]`, no verse) and a reference to `here` itself are left out.
- **Already linked** is left out: any link (any type, either direction) whose two ends cover `here` and `other`'s first verse (links.js `linksFor` / `otherEnd`; study.js may import from links.js lazily or links.js passes a predicate, whichever keeps the modules' optional-import pattern).
- The same `other` from several sources is one suggestion with several `sources`, newest source first. Order: out before in, then by the newest source.
- `snippet`: the sentence of the source text around the reference (plain text, about 160 characters at most, cut at word boundaries with an ellipsis), with the reference itself shown as its label; for a comment, the highlighted words come first as `“words” · …`. This is the "context" Ji asked for: why the two verses belong together.
- Chapter view: every suggestion whose `here` is in the chapter.

## 2. The Mine tab: "From your notes" (links.js + styles.css)

In `renderMine`, between the composer slot and the list, a section when there are suggestions (none: nothing at all, no empty state):

```
h3.lh  "From your notes" · N
ul.group.av.mine-sugg
  li.mine-card.sugg
    row 1: other's reference as a .link button (navigates and selects it, as data-link-go does) · a small source line:
           out: "In your note" / "In your comment on “words”"   in: "Your note on John 3:3 mentions this verse"
    row 2: the other verse's text (the same preview mechanism as the cards: data-link-prev, current translation) and
           the "Read in context" expander, as the link cards have
    row 3: the snippet (serif, muted), the reference in it bold
    trailing: [Link] button (btn-tinted sm), aria-label "Link John 3:16 to Isaiah 53:5"
```

- **Link** opens the composer prefilled exactly as pick mode does (`finishPick` → `newDraft({ at, fixed, other, focus: 'type' })`): `out` = From here To other; `in` = From other To here (`swapped`). Focus goes to the type chips. Saving makes the link; the suggestion then disappears on its own (it is linked).
- At most 5 cards, then `Show all N` (a .link button) for the rest.
- With a verse selected: that verse's suggestions. No verse selected (chapter view): grouped by verse with the same `h4.act-day` subheads the chapter list uses.
- Re-render on `bs:links-changed`, `notes-changed`, `bs:notes-replaced`, `bs:note-saved` and the marks' change event (the Mine tab already re-renders on some; add what is missing).
- Export from links.js `connectFromNote(here, other, dir)` (or similar) so drawer.js can open the same prefilled composer: it selects `here` when it is in the reader's chapter (as finishPick does) and opens the Mine tab.

## 3. The Notes tab: "Verses in this note" (drawer.js + styles.css)

Under the verse note's editor card (verse notes only; not the chapter note; not for a read-only guest), when the note's text has at least one verse reference:

```
div.note-verses  "Link the verses in this note"   [John 1:4 · Link] [Isaiah 53:5 · Linked ✓] …
```

- Each chip names the verse. Not linked yet: the chip is a button "Link" that calls the export from §2 (`dir: 'out'`), which switches to the Mine tab with the composer open. Already linked: the chip says "Linked" with a check and opens the Mine tab for this verse.
- It follows the text as Ji types (debounced, about 300 ms; parse the textarea's value, not only the saved note) and after a save or a link change.
- Compact: one wrapping row of `.chip.sm`, no more than the space the tags row takes; at 390 px it wraps.

## 4. The composer's To field: your verses first (links.js)

When the To field (`#mc-to`) is focused and empty, its listbox (`#mc-books`, the book completion) shows "From your notes": up to 6 suggestions for the composer's verse (§1, both directions), each `Isaiah 53:5 — the first words of the verse…`. Choosing one fills To with that reference (and, for an `in` suggestion, sets From/To the right way round: `swapped`). Typing goes back to book completion. Same keyboard and screen-reader behaviour as the book list (arrows, Enter, Esc, `aria-activedescendant`).

## 5. Checks

- jsc on every JS file touched; `python3 -m unittest tests.test_server` still passes (no server change expected).
- Hero check: identical to the baseline at 1440×900 and 414×900.
- Own `serve.py` on a free 88xx port with a temp `--data-dir` and an `@example.test` profile (never 8765, never `notes/`): write a note on John 3:16 with `[[Isaiah 53:5]]`, `[[Romans 5:8]]`, a range `[[Isaiah 53:4-6]]`, a mark reference, a chapter reference and a self-reference; a comment on a highlight elsewhere that references John 3:16. Check: the Mine tab for John 3:16 lists the right suggestions (both directions, the range, not the chapter or self ones), each with the verse text and the snippet; Link opens the composer the right way round with focus on the type chips; Save makes the link and the suggestion goes; the Notes tab chips show Link/Linked and update while typing; the composer's empty To field offers the verses; the chapter view groups them by verse; removing a reference from the note removes its suggestion; `?dry` makes no POST; a hosted guest sees no suggestions to act on; light and dark; 1440, 820, 390; no console errors.
