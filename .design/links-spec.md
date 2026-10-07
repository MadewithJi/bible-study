# My links: user-made verse connections. Build specification

Status: agreed with Ji on 2026-09-29 ("please build this after verification and fix of the 101 issues"). Threads (ordered chains) are **out of scope** for v1. Offer them afterwards.

This extends the profiles system (`.design/profiles-spec.md`, "PS" below) and the design system (`.design/spec.md`). Follow PS conventions exactly unless this document says otherwise:
- error shape, CSRF, X-BS-Scope, strict JSON
- locks, daily `.bak`, corrupt-file handling
- clock guard, text cleaning, `esc()` everywhere, dry mode
- copy style: sentence case, curly quotes, British "colour", no exclamation marks

## 0. Hard rules

- **Do not change the chapter hero** (eyebrow, title, tagline, intro line, chips, `figure.sig` arcs strip). User links are never drawn in the hero. They appear in the verse gutter, the study panel, the Arcs/Graph stage panels and the Library. See memory "Preserve the chapter hero".
- **Reverence.** Nothing in this feature lists God, Christ or the Holy Spirit as people.
- **Nothing is lost.**
  - Every write is compare-and-set, like notes (PS §2.4 #10).
  - Deletes show an Undo toast.
  - Dry mode (`?dry`) blocks every write. The UI still works in memory and says "Dry run" in the toast.
- **Testing.**
  - Browser: use `?dry` against the real server on 8765, in your own tab.
  - Writes: use your own `serve.py --port 88xx --data-dir .design/linkstest/<label>` with @example.test accounts.
  - Never touch `notes/`.

## 1. Data model

### 1.1 Files

| Scope | File |
|---|---|
| guest | `DATA/guest-links.json` |
| profile | `DATA/profiles/<uid>/links.json` |

- Covered by the same scope lock as the notes file, and the same daily `.bak` and corrupt-file rules (PS §1.7).
- Profile delete moves the whole folder, so links go with it.

### 1.2 Document

```json
{
  "version": 1,
  "rev": 7,
  "links": {
    "ln_3f9a0c1d2e4b": {
      "id": "ln_3f9a0c1d2e4b",
      "from": "43.1.29",
      "to": "23.53.7",
      "type": "fulfils",
      "label": "",
      "note": "The Lamb *led to the slaughter*…",
      "color": "blue",
      "tags": ["lamb", "passover"],
      "dir": "to",
      "created": 1759071600000,
      "updated": 1759071700000
    }
  },
  "deleted": { "ln_91aa03e2c4f0": 1759071800000 }
}
```

**Refs.** `from` and `to` use `"b.c.v"` or a same-chapter range `"b.c.v-ve"`.
- Pattern: regex `^(\d{1,2})\.(\d{1,3})\.(\d{1,3})(?:-(\d{1,3}))?$`, ASCII digits only.
- Validated against `meta.json`: book 1–66, chapter exists, `1 ≤ v ≤ verses`, and `v < ve ≤ verses` when a range is given.
- Canonical form: no leading zeros, and `ve` omitted when it equals `v`.
- `from` ≠ `to` (the same verse or the same range is rejected).
- Whole-chapter links are not supported in v1.

**`id`.** `"ln_" + 12 hex`, regex `^ln_[0-9a-f]{12}$`.
- The **client** generates it with `crypto.getRandomValues`, so an offline create can be retried idempotently.
- The server accepts any well-formed unused id. A reused id is just an edit under compare-and-set.

**`type`.** Each type has a direction-aware phrase: the forward phrase is shown on the `from` side, the reverse on the `to` side. A `dir: "both"` link uses the symmetric phrase on both sides.

| Type | Forward | Reverse | Symmetric |
|---|---|---|---|
| `related` (default) | is linked to | is linked to | is linked to |
| `fulfils` | fulfils | is fulfilled in | fulfils / is fulfilled in |
| `echoes` | echoes | is echoed in | echoes |
| `parallels` | parallels | parallels | parallels |
| `contrasts` | contrasts with | contrasts with | contrasts with |
| `explains` | explains | is explained by | explains |
| `quotes` | quotes | is quoted in | quotes |
| `same-word` | shares a word with | shares a word with | shares a word with |
| `theme` | shares a theme with | shares a theme with | shares a theme with |
| `custom` | the label | the label | the label |

For `custom`, `label` is required (1–40 characters). For every other type, `label` is an optional short caption (≤ 40).

**Other fields.**

| Field | Rules |
|---|---|
| `note` | Markdown string, ≤ 20,000 characters. Rendered with drawer.js `renderMd` (which is safe) and never with raw innerHTML. |
| `color` | One of `red orange yellow green blue purple`. Default `blue`. The same palette and swatches as bookmarks. |
| `tags` | ≤ 20 tags, each 1–40 characters. Trimmed, lowercased, deduplicated. Allowed characters: letters, digits, space, `-`, `_`. |
| `dir` | `"to"` (one-way, from → to) or `"both"`. Default: `"both"` for parallels / contrasts / same-word / theme / related, `"to"` for the others. |
| `created`, `updated` | Integer ms. Same clock guard as notes (PS §1.4). |
| Unknown fields | Dropped. Links have no legacy shape. |

**Limits.**
- 10,000 links per scope.
- Serialized link ≤ 32 KiB.
- Tombstones: at most 2,000, none older than 180 days (as for notes).

### 1.3 Derived (client-side only)

`byVerse: Map<"b.c.v", Set<id>>`. A range link indexes **every** verse in its range, on both ends.

## 2. HTTP API

Add these to the endpoint index (PS §2.2) and to the `Route` table in serve.py:

| # | Method | Path | Auth | X-BS-Scope | Body limit |
|---|---|---|---|---|---|
| 24 | GET | `/api/links` | optional | – | – |
| 25 | POST | `/api/links/changes` | optional | required | 1 MiB |

**24. `GET /api/links`** → 200 `{ "links": { … }, "rev": 7, "scope": "guest" }`, with `ETag: "7"`. `deleted` is not returned.

**25. `POST /api/links/changes`.** Same semantics as `/api/notes/changes` (PS §2.4 #10), including `base` compare-and-set, `stale`, `versions` and `conflicts`.

Request:
```json
{ "baseRev": 7, "set": { "ln_…": { …link without server fields… } }, "del": { "ln_…": 1759071800000 }, "base": { "ln_…": 1759071700000 } }
```

- **Key cap.** At most 1,000 keys across `set` + `del`.
- **Validation is atomic.** Any invalid link → 400 `invalid_link` with `field` = the id and a message naming the problem (bad ref, bad type, note too long, …), and nothing is applied.
- **`id` agreement.** The `id` inside a set value must equal its key.
- **Limit.** 10,000 reached → 409 `link_limit`, with the message "You’ve reached the limit of 10,000 links."
- **Pure functions** in accounts.py:
  - `clean_link(raw, now)` returns `link | raises ValueError(msg)`.
  - `apply_link_changes(doc, set_map, del_map, base=None)` returns `(changed, conflicts, created_ids)`. `created_ids` = ids that did not exist before this request.
  - `link_versions(doc, keys, conflicts)`.
  - Reuse the notes helpers where their logic is identical; don't copy-paste divergent logic.
- **Activity.** For each id in `created_ids`, append a library activity entry `{t, type: "link.add", ref: from, x: {id, to, kind: type}}`.
  - Lock order is links file → library file. No other code path takes them in the reverse order. Document this at the lock helper.
  - `rev` of the library += 1 when entries were appended.
- **Studied verses.** Newly created links also mark both ends as studied in the library `chapters[…].studied`, for the first verse of each end. `days[today].v` increments for newly studied verses, as `verse.study` does in PS §4.6. The day comes from the request's optional `day` field (validated `YYYY-MM-DD`), else the server local date.
- **Deletes** write no activity.
- **Response.** 200 `{ "ok": true, "rev": 8, "changed": true, "stale": false, "conflicts": {}, "versions": {}, "saved": "15:04:05" }`.

**Changes to existing endpoints:**
- **`GET /api/library`:**
  - `stats.totals.links` = the scope's link count.
  - Activity type `link.add` passes through.
  - library.js renders it as "Linked {John 1:29} to {Isaiah 53:7}", sub = the type phrase, tile = `link` in indigo.
- **`GET /api/auth/me`:**
  - `guest.links` = the count.
  - `hasData` also counts links.
  - The import meta line gains "· N links".
- **Signup `importGuest`:** copy the guest links (`rev` 1, no tombstones).
- **`POST /api/profile/import-guest`:**
  - Merge rule: take the guest link if the profile has no such id **and** no tombstone ≥ `guest.updated`, or if `guest.updated > profile.updated`.
  - Idempotent.
  - Counts gain `links`.
- **`GET /api/export/profile`:** adds `"links": { "links": { … } }`.
- **`GET /api/export/obsidian`** gains links, in Ji's vault naming (PS §1.9):
  - `study-notes/Connections.md`: `# Connections`, then one line per link, newest first: `- [[John 1.29|John 1:29]] — fulfils → [[Isaiah 53.7|Isaiah 53:7]]` + (` · label`) + (` #tag` per tag). If there is a note, add an indented `  > first 200 characters of the note, one line`.
  - Every verse at either end of a link gets a `## Connections` section in **its** verse file, using the direction-aware phrase from that verse's side: `- fulfils → [[Isaiah 53.7|Isaiah 53:7]] · label`. The file is created when there is no note for that verse. Ranges use the first verse's file and show the range in the alias.
  - `Study Notes Index.md` links `[[study-notes/Connections|Connections]]` when non-empty.
- **Account delete:** nothing extra; the folder move covers it.
- **Tests (`tests/test_server.py`):**
  - validation (every field and limit, ranges, same-verse rejection)
  - compare-and-set (conflict, retry idempotency, delete of a changed link, tombstone)
  - scope header rules and CSRF
  - `link.add` activity and studied verses; the lock-order code path
  - guest import copy and merge (idempotent)
  - both exports
  - `hasData`
  - The existing 96 tests keep passing.

## 3. Front end

### 3.1 `app/js/links.js` (new module)

```js
export const links = { loaded: false, scope: null, rev: 0, byId: new Map(), byVerse: new Map(), offline: false }
export const TYPES = [/* {id, label, fwd, rev, sym, dirDefault} per §1.2 */]
export function initLinks(A)
export async function loadLinks()                      // GET /api/links; merge un-flushed dirty entries from lsKey('bs-links-dirty-v1'); mirror to lsKey('bs-links-v1')
export async function flushLinks({ keepalive = false } = {})   // POST /api/links/changes with base; same success/conflict/stale handling as store.flushNotes
export function linksFor(b, c, v)                     // → link[] touching that verse (either end), sorted by the other end's canon order
export function linksInChapter(b, c)                  // → Map<v, count>
export function linkCount()
export function phrase(link, fromSideRef)             // direction-aware phrase per §1.2
export function otherEnd(link, b, c, v)               // → { ref, b, c, v, ve, side: 'from'|'to' }
export async function saveLink(draft)                 // create or update; optimistic; returns link
export async function deleteLink(id, { undo = true } = {})
export function startPick(fromRef)                    // enter pick mode (§3.4)
export function cancelPick()
export const picking = () => boolean
export function renderMine(host, { b, c, v })         // drawer tab body (§3.3)
export function openLinkMenu(anchor, link)
```

- **Dirty map and flush.** Same pattern as notes (PS §5.2):
  - `dirty: Map<id, {op, ts, seq}>` persisted per scope.
  - A 700 ms debounced flush, plus a keepalive flush on `pagehide` and `visibilitychange` hidden.
  - BroadcastChannel `bs-sync` messages `{t: 'links', scope, rev}` → `loadLinks()` when visible.
- **Conflicts.**
  - The server version replaces the local one (`null` deletes it).
  - Toast: "Your link from John 1:29 changed in another window. Showing the newer version."
- **Scope changes.** Listen to `bs:auth-changed` → flush the old scope first, then reload.
- **Events.** Dispatch `bs:links-changed` `{reason, ids}` after any local change or load. reader, drawer, viz and library listen for it.
- **No server.** Guest links live only in localStorage (`lsKey('bs-links-v1')`), mirroring how notes fall back.

### 3.2 Verse gutter badge (reader.js)

- **Placement.** In `.badges`, after the bookmark button and before note/video badges, emit:
  `<button class="b-link" type="button" data-link-v="29" tabindex="-1" aria-label="2 of your links. Show them" title="2 links">ICON(link-node)<span>2</span></button>`
  when `linksInChapter(b,c).get(v) > 0`.
- **Colour.** Tinted by the most recent link's colour (`data-link-color`).
- **Click** (checked in the reader click handler before `.verse`) → `A.select(v, { tab: 'mine' })`.
- **`refreshVerseMarker(v)`** includes it. On `bs:links-changed`, re-render the badges of the affected verses in the current chapter only; no full re-render.
- **Hero.** The badge lives in the verse gutter only. Verify the hero is identical with and without links.

### 3.3 Study panel tab "Mine" (drawer.js + links.js)

**Tab.** After Video, before the hidden Search tab:

`<button role="tab" type="button" id="tab-mine" data-tab="mine" aria-selected="false" aria-controls="drawer-body" tabindex="-1" title="My links (c to link from here)">Mine<span class="count" id="cnt-mine"></span></button>`

- Its accessible name is "My links" (`aria-label`).
- **Phone width:** check the tab row at 390 px. The segmented control must fit or scroll horizontally without clipping; no layout change on desktop.

**Body when a verse is selected** (`renderMine`):

```
.lh  "My links" · N                         [Link from here] (btn-tinted sm)  [+ Connect] (btn-plain sm)
(composer, when open — §3.5)
ul.group.av.mine-list
  li.mine-card[data-link=id] (style: left rule in the link colour)
    row 1: type chip ("fulfils →" / "← is fulfilled in") · other-end ref as .link button (navigates, selects that verse, keeps the Mine tab)
    row 2: preview text of the other end (previewText, clip 160) with "Read in context" expander exactly like the Links tab's xref rows (reuse expandXref markup/CSS where possible)
    row 3: note rendered with renderMd (collapsed to 4 lines with "More")
    row 4: tag chips (.chip.sm) — clicking a tag opens Library › My map filtered to it
    trailing: more-btn (… menu: Edit, Reverse direction (only dir 'to'), Change colour (swatches), Copy as text, Delete)
.empty (no links): ICON(link-node) "No links from John 1:29 yet" / "Connect this verse to another with + Connect, or press c and choose a verse anywhere in the Bible."
```

- **No verse selected** (chapter context): list every link touching this chapter, grouped by verse (`h4.act-day`-style subheads "Verse 29"), with the same cards. The empty state names the chapter.
- **Counts.**
  - `#cnt-mine` = links for the selected verse, or the chapter total when no verse is selected. Hidden when 0.
  - Update on `bs:links-changed`, on select and on navigate.

### 3.4 Pick mode ("Link from here")

- **Entry points:** the Mine tab button, key `c` (selected verse required; otherwise toast "Select a verse first, then press c."), and the verse context-menu or long-press if one exists.
- **The pill.** Show `#link-pick`, a fixed floating pill (bottom centre, above the phone sheet, safe-area aware, `role="status"` region + buttons):
  `ICON(link-node) Linking from **John 1:29** — choose a verse   [Cancel]`
  It carries `body.link-picking`.
- **While picking:**
  - Verses show a crosshair cursor and a hover/focus ring in the accent colour.
  - Navigation (picker, search, arrows, hash, cross-reference clicks, Library) keeps pick mode alive. The pill stays.
  - Clicking a verse, or pressing Enter on a focused verse, selects the **target** instead of the normal selection. Clicking the source verse itself → shake the pill + toast "Choose a different verse.".
  - Clicking a verse's range: shift-click a second verse **in the same chapter** to make a range target.
- **On target:**
  - Exit pick mode.
  - Open the study panel on the **source** verse's Mine tab with the composer prefilled `from = source`, `to = target`. Focus the type chips.
  - Don't navigate back: the user stays where they are, and the drawer shows the source.
- **Cancel:** Esc (first in the Esc chain), the Cancel button, or starting pick mode again. Toast: none.
- **Dry mode:** allowed (in-memory).

### 3.5 Composer (create and edit)

Inline `form.mine-composer` at the top of the Mine body:

- **From / To row:**
  - From: fixed text, e.g. "John 1:29".
  - To: `input.field` with placeholder "Verse, e.g. isa 53:7", parsed by `parseReference`. It accepts ranges `isa 53:5-7` (same chapter). Live-validate and show the parsed label or "Not a verse".
  - A swap button (⇄) exchanges from and to.
- **Autocomplete:** book-name completion using meta `books[].name/short`. A small listbox, arrow keys, Enter.
- **Type:** `div.chips[role=radiogroup]` of TYPES labels (Related, Fulfils, Echoes, Parallels, Contrasts, Explains, Quotes, Same word, Theme, Custom…). Custom reveals a label input. Arrow keys follow the `radioKeys` pattern.
- **Direction:** a switch "Two-way". Its default comes from the type (§1.2), and the user can override it.
- **Colour:** the six swatches (reuse `.bm-sw`).
- **Tags:** a text input; comma or Enter makes a chip; Backspace removes the last. Suggest existing tags.
- **Note:** a textarea with the same look as the Notes tab, and the same markdown hint.
- **Footer:** Cancel · Save (`btn-primary sm`). Cmd/Ctrl+Enter saves.
- **Validation:**
  - Missing or invalid To → inline error.
  - Same as From → "A verse can’t link to itself."
  - A duplicate (same from/to/type) → inline warning with "Edit the existing link" instead.
- **Save:**
  - Optimistic insert, then collapse the composer.
  - Toast "Linked John 1:29 to Isaiah 53:7." with action "Undo" (deletes it).
  - `tracker.track('link.add', {b,c,v, to})` is **not** needed; the server writes the activity (§2). The client mirror (`library.applyLocal`) shows the activity entry optimistically.
- **Edit:** the same form, prefilled. Save keeps the `id` and `created`.
- **Delete:** confirm via Undo toast only, no dialog: "Deleted the link to Isaiah 53:7." with Undo.

### 3.6 Stage panels (viz.js)

Both panels gain a segmented control in the stage tools: `OpenBible · Mine · Both`.
- Default `Both` when the chapter has user links; otherwise the control is disabled with the title "You have no links here yet".
- Stored in `lsGet/lsSet('bs-links-view')`.

**Arcs** (`renderArcs`):
- User links from **or to** this chapter are drawn as arcs in the link's colour, 2.5 px, above the OpenBible arcs. Incoming links are drawn from the other end to this chapter's position.
- In `Mine` only the user arcs are drawn. In `OpenBible` the view is exactly today's.
- Hover tooltip: "John 1:29 fulfils Isaiah 53:7 · label". Click navigates as today.
- The `arcsSub` text gains " · N of your links".

**Graph** (`renderGraph`):
- The user's links of the centre verse become nodes (if not already present), with edges in the link colour (dashed for `dir: 'both'`, arrowed for `'to'`). The edge label is the short phrase on hover.
- In `Mine`, only the user's links are shown. When the centre verse has none, the empty state is "No links from John 1:29 yet. Press c to make one."
- **Auto-centre:** when no verse is selected, prefer the verse with the most user links in `Mine` mode.
- The canvas must not re-layout on `bs:links-changed` unless the panel is open.
- **Hero `figure.sig`: unchanged.** It stays OpenBible-only.

### 3.7 Library › My map (library.js)

**Home.** Add a `.lib-sec#lib-links` after Bookmarks:
- `.lh` "My links" · N.
- Up to 5 most recent links as cells: "John 1:29 → Isaiah 53:7", sub = phrase + label + tags.
- A button "Open my map" (`btn-tinted sm`, `data-lib-links`).
- Empty state: "No links yet" / "Select a verse and press c to connect it to another."

**Push view "My map"** (the same push/pop animation as the per-book view):
- **navbar:** back to "Library".
- **Filters row:**
  - A `segmented` "Network · List".
  - Type chips (All + types present).
  - Tag chips (All + tags, by count).
  - A search field (matches ref labels, labels, notes and tags, case-insensitive).
- **Network:**
  - Canvas.
    - Nodes = verses (range links use the first verse, labelled with the range).
    - Node colour = the book division colour already used by viz (reuse its palette helper).
    - Radius grows with degree.
    - Edges are in the link colour, with arrows for one-way links.
  - Force layout (a simple velocity-Verlet with a cap on iterations, no library), seeded by canon position (OT left, NT right) so the layout is stable between opens.
  - Pan (drag), zoom (wheel/pinch, buttons + / − / Fit), hover tooltip.
  - Click a node → close the Library, navigate, select the verse, open the Mine tab.
  - Keyboard: Tab to the canvas, arrows move between nodes in canon order, Enter opens.
  - Reduced motion: no animated settling (compute, then draw once).
  - `role="img"` with an aria-label summary, plus the List view as the accessible alternative.
  - Handles 0, 1, 2 and 2,000 links (performance: ≤ 16 ms per frame at 2,000 edges on a laptop; stop the simulation when settled).
- **List:** grouped by tag (untagged last), each link a cell as on the home. The trailing more-btn opens `openLinkMenu`.
- **Stats:** `stats.totals.links` shows as a fifth `.lib-stat` tile only when > 0 ("Links made", ICON link-node, indigo). Keep the 4-tile layout otherwise; check that 5 tiles wrap nicely at all widths.

### 3.8 Other wiring

- **`icons.js`:** add `link-node` (two small circles joined by a curve, 24×24, 1.5 px stroke, matching the set). Reuse the existing `link` icon where a plain link is meant.
- **main.js:**
  - Boot: `loadLinks()` joins the `Promise.all` with `loadNotes/loadLibrary`, then `initLinks(A)`.
  - Key `c` → `A.startLinkPick()`.
  - Esc chain: pick mode first.
  - `A.onScopeChange` reloads links.
  - The `A.select(v, { tab: 'mine' })` path.
- **Help:** add `<dt><kbd class="k">c</kbd></dt><dd>Link the selected verse to another verse</dd>` after `b`.
- **Profile dialog:**
  - The export cell sub becomes "Notes, bookmarks, links and progress as JSON".
  - The guest import meta includes links.
- **Tracker:** no new client events. The server derives `link.add`. `library.applyLocal` handles `link.add` for the optimistic activity entry.
- **CSS:**
  - New rules go in `app/css/styles.css` in a `/* My links */` block, using tokens only (no raw colours except via the existing `--bm-*` colour tokens).
  - Light and dark both; `forced-colors` fallbacks for the badge, pill and edges.
  - Print hides the pill.

## 4. Acceptance checks (the QA agents run all of them)

1. **Server tests.** `python3 -m unittest tests.test_server` passes, with new tests for §2.
2. **JS syntax.** Every JS file passes the jsc syntax check.
3. **Hero unchanged.** On a chapter with links (John 1) and one without, `header.hero` geometry and DOM are identical to the pre-feature baseline (take the baseline **before** building).
4. **End to end, own server, profile A:**
   - Create a link from John 1:29 to Isaiah 53:7 via the composer, and one via pick mode across books.
   - Edit, reverse, recolour, tag.
   - Delete + Undo.
   - Reload → persisted.
   - Two tabs: a conflict produces the newer version + toast, and no data loss.
   - Sign out → the guest space doesn't show profile A's links.
   - Guest link + sign up with import → copied. Import again → no duplicates.
5. **Badges.** Badges appear on both ends, including every verse of a range, with correct counts. The Mine tab lists links from both ends with the correct phrases (fulfils / is fulfilled in).
6. **Stage panels.**
   - The Arcs `Both`/`Mine`/`OpenBible` switch works.
   - The Graph shows user nodes and edges.
   - The hero `figure.sig` is unchanged.
7. **My map.**
   - Network renders with 0, 1 and many links (seed 300 links via the API on the test server); filters work; clicking a node navigates.
   - The List view matches.
   - No horizontal overflow at 390 px.
8. **Exports.**
   - The Obsidian zip contains `Connections.md` and per-verse `## Connections` sections with the vault naming.
   - The profile JSON export contains the links.
9. **Dry mode.** `?dry` makes no POST requests.
10. **General.**
    - Zero console errors.
    - Light and dark.
    - 1440 / 820 / 390 widths.
    - Keyboard-only flow (c → navigate → Enter → type → Cmd+Enter) works.
    - Screen-reader names are sensible.
