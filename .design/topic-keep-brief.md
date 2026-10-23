# Search results stay put while you read (build brief, stage TK1)

Ji (2026-10-22): "When I search topics and click on the links in the side drawer nav that pertain to that topic, it should keep the list of recommended verses pertaining to that topic while pulling up the verse in the main section, rather than automatically pulling out of that section."

## What happens today (main, ba69f03)

A row in the study panel's **Search** tab (a topic's verses from `showTopic`, a word search's hits from `searchHtml`, the "Or open John 3:16" link) is a `[data-go]` button. drawer.js's click handler calls `A.navigate(b, c, v)` then `A.yieldToPage()`:

- `A.navigate` (main.js, first lines) switches `state.drawerTab` from `'search'` to `'xref'` whenever a verse is selected, and redraws the panel with `drawer.renderDrawer()` (scroll back to the top).
- `yieldToPage()` closes the panel in the overlay layout (tablet, a narrow window, the in-app browser pane) and drops the phone sheet to its medium detent.

So, in every layout, the list goes: wide desktop shows the Links tab, overlay closes the panel, the phone sheet shows Links, and coming back to Search starts at the top.

## What it should do

A click on a result in the Search tab (any of its `[data-go]` rows or links; not `[data-ref-go]`, the "Revelation has 22 chapters" message, which keeps today's behaviour):

1. **The reader goes to the verse and selects it**, as today: the chapter loads if needed, the verse is selected, highlighted and brought into view (`ensureVisible`) where the reader can see it beside or above the panel.
2. **The panel stays on the Search tab with the same list**: no switch to Links, no redraw from the top. The list keeps its scroll position and the clicked row keeps keyboard focus (or gets it back after a redraw), so the next row is one Tab or one tap away.
3. **The current result is marked** in the list: the row whose verse is selected in the reader gets `aria-current="true"` and a quiet highlight (the same look the panel uses for a current row elsewhere, or the verse-selection accent at low strength), and the mark moves as Ji goes down the list. It follows the selection also when the reader's selection changes another way (j/k, a click in the reader) while the Search tab shows.
4. **Per layout:**
   - side (wide desktop): the panel stays open; nothing else changes.
   - overlay: the panel **stays open** (no `closeDrawer`); the verse is scrolled into the part of the reader the panel does not cover. Check what the scrim does to the verse there: if the page behind the overlay panel is dimmed so much that the verse cannot be read, say so in the report with a screenshot rather than changing the overlay's modality.
   - sheet (phone, and the iOS app): the sheet drops to its medium detent (as `setSheetFull(false)` does today) so the verse shows above it, and the sheet keeps the Search tab with the list where it was.
5. **Coming back to Search later** (Ji taps a verse in the reader, which still switches to Links as today; then taps the Search tab): the list comes back at the scroll position he left it, with the current-row mark, until a new search replaces it.
6. Everything else is unchanged: other tabs' `[data-go]` rows (Links, Notes, Context, Mine…) behave exactly as now; a new search, a Strong's lookup and a reference search behave as now; the bookmark button and the verse stepper stay hidden beside a search as now (`renderBookmarkBtn`).

## Hard rules

- The chapter hero is unchanged; hero check against `.design/linkstest/hero-baseline.json` (main, 2026-10-19).
- Small and local: main.js and drawer.js (and styles.css only for the current-row mark). No server change; the 195 server tests still pass.
- The iOS app's bridge (`app/js/shell.js`, `html.app-shell`) keeps working: `BL.search` opens results in the Search tab, and a result click must not confuse the shell's tab following (the page stays on Read).
- Keyboard and screen reader: focus never falls to `<body>`; the current row is announced as current.
- Copy: sentence case, curly quotes, British spelling, no exclamation marks.

## Checks

- jsc on main.js and drawer.js; `python3 -m unittest tests.test_server`; the hero check at 1440×900 and 414×900.
- Your own `serve.py` on a free 88xx port with `?dry` (no writes needed): search `love` and open the topic chip (for example "Love"), and also a word search; click the 1st, then the 5th, then the 20th result at 1440×900 (side), at the in-app pane's default size (overlay, about 1024×768) and at 390×844 (sheet). Each time: the reader shows and selects the verse; the panel is on Search with the same list, at the same scroll position, with the clicked row focused and marked current. Tap a verse in the reader (Links opens), then the Search tab: the list is back where it was. Other tabs' rows still switch as before (a Links tab cross-reference row, a Notes row). Light and dark. No console errors. Screenshots of the list with a current row at each width.
