# Bible Study — Redesign Build Specification ("Product page")

Single source of truth for three parallel builders. Follow it literally. When this spec and a mockup disagree, **this spec wins**. When this spec is silent, copy the winning mockup `app/mock/pro.html` (its CSS and JS are the reference implementation), not `books.html` or `vision.html`, except where this spec names one of them.

User brief: *"It needs to look more beautiful, like an Apple website, with a side drawer when you click, and look at the interactive design." "It needs to look like modern graphic design language."*

---

## 0. Ground rules

### 0.1 File ownership (disjoint; never edit another builder's file)

| Builder | Owns | Notes |
|---|---|---|
| **A: SHELL** | `app/index.html`, `app/css/styles.css` | Full rewrite of both. All CSS for every class in this spec lives in `styles.css`, **including viz classes**. |
| **B: APP-JS** | `app/js/main.js`, `app/js/reader.js`, `app/js/drawer.js`, `app/js/store.js`, **new** `app/js/icons.js` | `morph.js` is read-only for everyone (import it, do not edit it). |
| **C: VIZ** | `app/js/viz.js` | Imports from `store.js` and `icons.js` only through the APIs in §9.1. |

Scratch or test files are allowed only as `app/mock/_harness-<builder>.html` (for example `_harness-viz.html`). Never ship-link them. Do not touch `.backup/`, `serve.py`, `build.py`, `app/data/`, `notes/`.

### 0.2 Safety (every builder, every test)

- Never send PUT or POST to `/api/notes` or `/api/config`. Never save notes, highlights, tags, videos, settings, theme or font size through the UI of the user's real app.
- **Dry-run mode (B implements, everyone uses for testing):** load the app as `http://localhost:8765/?dry#43/3/16`. When `?dry` is in `location.search`, the app must: never call `fetch` with a method other than GET; never write notes, theme or font size to `localStorage`; show "Saved (dry run)" in the save status; show a toast "Dry run: nothing will be saved." on boot; and set `window.__DRY__ = true`. **Before touching any control that mutates data (typing in the note, swatches, tags, video add/remove, import, settings Save, theme, font slider), check `window.__DRY__ === true` in the tab. If it is not true, do not touch those controls.**
- In-app Browser tools: create your own tab with `tabs_create`, pass its `tabId` on every call, close it when done, and never call `tabs_select`. If you call `resize_window`, reset it with preset `desktop` before closing the tab. Prefer `javascript_tool`, `read_page` and `getBoundingClientRect`/`getComputedStyle` checks over screenshots.
- No emoji anywhere. No Unicode glyphs used as icons (for example ✎ ▶ ⌕ ☰ ↶ ⚙ × ✓ ↗ ＋ 📚). Keycap text inside `kbd` elements is fine. Remove every glyph icon in the current code.
- Fonts: system only (`-apple-system`, `ui-serif`/New York and so on). No web-font downloads.
- External scripts: only Leaflet 1.9.4 from cdnjs (loaded lazily by viz.js, as today). Map tile images come from CARTO basemaps (§9.7).

### 0.3 Reference line ranges in the mockups

| What | Where |
|---|---|
| Pro CSS (base for `styles.css`) | `app/mock/pro.html` lines 101–745 |
| Pro token block (replaced by §1 of this spec) | `app/mock/pro.html` lines 13–99 |
| Pro markup (base for `index.html`) | `app/mock/pro.html` lines 748–910 (the sprite at 752–792 is **not** copied; see §4) |
| Pro JS (reference behaviour) | `app/mock/pro.html` lines 912–1790 |
| Focus+context timeline | `app/mock/books.html` `timelineSVG` lines 1498–1524 |
| Stylised Levant map | `app/mock/books.html` `LEVANT`, `smoothPath`, `mapSVG` lines 1526–1581 |
| Sheet focus, detents, ensureVisible | `app/mock/books.html` lines 1213–1229, 1296–1341, 1914–1931 |
| Night-glass arcs and canonical graph | `app/mock/vision.html` lines 1263–1300 and 1694–1743 |

---

## 1. Design tokens (literal; builder A pastes these verbatim at the top of `styles.css`)

Colour rule: **OT and NT are the only categorical data hues.** The accent (blue) means *interactive / selected / you are here* and is **never** used as a data category. Marks carry colour; text always uses label tokens. Sequential magnitude (picker heat, Strong's distribution, most-linked bars) uses the accent only. An OT/NT legend is always shown next to OT/NT marks.

Validated with the dataviz skill's `validate_palette.py` (Machado CVD, OKLab ΔE×100):
- Light OT `#e8590c` / NT `#11998e` on `#fbfbfd`, `#ffffff` and `#f2f2f6`: all checks PASS; worst CVD ΔE 14.9 (protan), normal-vision 28.5, contrast ≥ 3:1.
- Dark OT `#e36a10` / NT `#1fa99b` on `#000`, `#1c1c1e` and `#0c0c10`: all PASS; worst CVD ΔE 15.6, normal-vision 26.5.
- Trio {OT, NT, accent} all-pairs: PASS in both modes (NT↔accent normal-vision ΔE ≥ 17). The previous NT `#0071e3` equalled the accent, and every indigo/violet candidate FAILED against the blue accent (deutan ΔE < 5). That is why NT is teal.

```css
:root {
  /* surfaces & labels */
  --bg: #fbfbfd; --bg-elev: #ffffff; --bg-2: #f5f5f7; --bg-3: #ebebf0;
  --label: #1d1d1f; --label-2: #6e6e73; --label-3: #86868b; --label-4: #aeaeb2;
  --read: #1d1d1f;
  --sep: rgba(0,0,0,.08); --sep-2: rgba(0,0,0,.14); --sep-strong: #d2d2d7;
  --fill: rgba(118,118,128,.12); --fill-2: rgba(118,118,128,.08); --fill-3: rgba(118,118,128,.05);
  /* accent (UI only: interactive, selected, you-are-here) */
  --accent: #0071e3; --accent-hover: #0077ed; --accent-press: #006edb; --link: #0066cc;
  --accent-tint: rgba(0,113,227,.07); --accent-tint-2: rgba(0,113,227,.13);
  --focus: #0071e3;                      /* solid: meets 3:1 non-text contrast */
  --danger: #e30000; --warn: #b64400;    /* warn = Greek textual variants */
  /* data (categorical) */
  --ot: #e8590c; --nt: #11998e; --viz-ink: #1d1d1f;
  --grad-num: linear-gradient(120deg, #0a84ff 0%, #5e5ce6 52%, #bf5af2 100%);
  /* highlights (verse text background) and swatches */
  --hl-yellow: rgba(255,204,0,.34); --hl-green: rgba(52,199,89,.24); --hl-blue: rgba(0,122,255,.16); --hl-pink: rgba(255,45,85,.16); --hl-orange: rgba(255,149,0,.26);
  --sw-yellow: #ffcc00; --sw-green: #34c759; --sw-blue: #007aff; --sw-pink: #ff2d55; --sw-orange: #ff9500;
  --tile-indigo: #5e5ce6; --tile-red: #ff3b30;
  /* maps */
  --map-land: #f7f7f9; --map-sea: #e3ecf4; --map-water: #8fb1d1;
  /* materials */
  --glass: rgba(251,251,253,.76); --glass-2: rgba(255,255,255,.8); --glass-edge: rgba(255,255,255,.8);
  --sheet: rgba(242,242,246,.8); --sheet-solid: #f2f2f6; --cell: rgba(255,255,255,.88); --seg-thumb: #ffffff;
  --scrim: rgba(0,0,0,.22); --toast: rgba(29,29,31,.92); --toast-fg: #f5f5f7;
  /* shadows */
  --sh-1: 0 0 0 .5px rgba(0,0,0,.05), 0 1px 2px rgba(0,0,0,.04);
  --sh-2: 0 0 0 .5px rgba(0,0,0,.04), 0 2px 8px rgba(0,0,0,.04), 0 12px 32px rgba(0,0,0,.07);
  --sh-sheet: 0 0 0 .5px rgba(0,0,0,.07), 0 2px 6px rgba(0,0,0,.04), 0 16px 40px rgba(0,0,0,.09), 0 44px 110px rgba(0,0,0,.14);
  --sh-pop: 0 0 0 .5px rgba(0,0,0,.08), 0 8px 24px rgba(0,0,0,.12), 0 28px 64px rgba(0,0,0,.14);
  --sh-thumb: 0 3px 8px rgba(0,0,0,.12), 0 3px 1px rgba(0,0,0,.04), 0 0 0 .5px rgba(0,0,0,.04);
  /* blur */
  --blur: saturate(180%) blur(20px); --blur-sheet: saturate(180%) blur(40px);
  /* radius */
  --r-xs: 6px; --r-sm: 8px; --r-md: 12px; --r-lg: 18px; --r-xl: 22px; --r-2xl: 28px; --r-pill: 980px;
  /* motion */
  --ease: cubic-bezier(.32,.72,0,1);
  --ease-out: cubic-bezier(.22,1,.36,1);
  --ease-io: cubic-bezier(.4,0,.2,1);
  --spring: linear(0, .076, .241, .428, .6, .742, .849, .924, .972, 1, 1.014, 1.019, 1.02, 1.017, 1.013, 1.009, 1.006, 1.004, 1.002, 1.001, 1);
  --d-1: 150ms; --d-2: 250ms; --d-3: 350ms; --d-4: 500ms;
  /* type */
  --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Helvetica, "Segoe UI", Roboto, Arial, sans-serif;
  --display: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Helvetica, "Segoe UI", Roboto, Arial, sans-serif;
  --serif: ui-serif, "New York", "Iowan Old Style", Charter, Palatino, Georgia, serif;
  --grk: "SBL Greek", "Gentium Plus", ui-serif, "New York", "Times New Roman", serif;
  --heb: "SBL Hebrew", "Ezra SIL", "Taamey Frank CLM", "Times New Roman", "Arial Hebrew", serif;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
  /* layout */
  --read-size: 20px; --measure: 680px; --sheet-w: 420px; --bar-h: 52px;
  color-scheme: light;
}
```

Dark set. Paste it **twice**: once inside `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` and once as `:root[data-theme="dark"] { … }`.

```css
  --bg: #000; --bg-elev: #1c1c1e; --bg-2: #1d1d1f; --bg-3: #2c2c2e;
  --label: #f5f5f7; --label-2: #a1a1a6; --label-3: #86868b; --label-4: #636366;
  --read: #e6e6eb;
  --sep: rgba(255,255,255,.1); --sep-2: rgba(255,255,255,.16); --sep-strong: #424245;
  --fill: rgba(118,118,128,.3); --fill-2: rgba(118,118,128,.2); --fill-3: rgba(118,118,128,.12);
  --accent: #2997ff; --accent-hover: #47a6ff; --accent-press: #1a8cff; --link: #2997ff;
  --accent-tint: rgba(41,151,255,.13); --accent-tint-2: rgba(41,151,255,.24);
  --focus: #2997ff;
  --danger: #ff453a; --warn: #ff9f0a;
  --ot: #e36a10; --nt: #1fa99b; --viz-ink: #f5f5f7;
  --grad-num: linear-gradient(120deg, #409cff 0%, #7d7aff 52%, #da8fff 100%);
  --hl-yellow: rgba(255,214,10,.24); --hl-green: rgba(48,209,88,.22); --hl-blue: rgba(10,132,255,.3); --hl-pink: rgba(255,55,95,.27); --hl-orange: rgba(255,159,10,.27);
  --sw-yellow: #ffd60a; --sw-green: #30d158; --sw-blue: #0a84ff; --sw-pink: #ff375f; --sw-orange: #ff9f0a;
  --tile-indigo: #7d7aff; --tile-red: #ff453a;
  --map-land: #1c1c1e; --map-sea: #0f1822; --map-water: #3c5f82;
  --glass: rgba(22,22,23,.74); --glass-2: rgba(44,44,46,.78); --glass-edge: rgba(255,255,255,.08);
  --sheet: rgba(28,28,30,.78); --sheet-solid: #1c1c1e; --cell: rgba(58,58,60,.52); --seg-thumb: #636366;
  --scrim: rgba(0,0,0,.5); --toast: rgba(58,58,60,.94); --toast-fg: #f5f5f7;
  --sh-1: 0 0 0 .5px rgba(255,255,255,.06);
  --sh-2: 0 0 0 .5px rgba(255,255,255,.07), 0 12px 32px rgba(0,0,0,.4);
  --sh-sheet: 0 0 0 .5px rgba(255,255,255,.12), 0 24px 70px rgba(0,0,0,.6);
  --sh-pop: 0 0 0 .5px rgba(255,255,255,.12), 0 24px 60px rgba(0,0,0,.6);
  --sh-thumb: 0 3px 8px rgba(0,0,0,.3), 0 0 0 .5px rgba(255,255,255,.06);
  color-scheme: dark;
```

Then add: `:root[data-theme="light"] { color-scheme: light; }`.

**Night stage tokens.** The Arcs/Graph/Map stage is a dark "night glass" tile in **both** themes (the apple.com dark product tile). It re-scopes the tokens locally, so everything inside `.stage` (including canvas colours that viz reads from the stage element) uses these values:

```css
.stage {
  --label: #f5f5f7; --label-2: #a1a1a6; --label-3: #86868b; --label-4: #636366; --read: #e6e6eb;
  --sep: rgba(255,255,255,.1); --sep-2: rgba(255,255,255,.16);
  --fill: rgba(118,118,128,.3); --fill-2: rgba(118,118,128,.2); --fill-3: rgba(118,118,128,.12);
  --accent: #2997ff; --accent-hover: #47a6ff; --link: #2997ff;
  --accent-tint: rgba(41,151,255,.13); --accent-tint-2: rgba(41,151,255,.24); --focus: #2997ff;
  --ot: #e36a10; --nt: #1fa99b; --viz-ink: #f5f5f7;
  --bg-elev: #1c1c1e; --bg-2: #1d1d1f; --glass-2: rgba(44,44,46,.78); --seg-thumb: #636366;
  --stage-surface: #0c0c10; --arc-surface: #0c0c10;
  --map-land: #141418; --map-sea: #0b1017; --map-water: #35526e;
  color-scheme: dark; color: var(--label);
  background: radial-gradient(120% 90% at 50% 0%, #1b1b22 0%, #0c0c10 62%), #0c0c10;
  box-shadow: 0 0 0 .5px rgba(255,255,255,.08), inset 0 1px 0 rgba(255,255,255,.08), 0 2px 8px rgba(0,0,0,.06), 0 18px 48px rgba(0,0,0,.16);
}
```

**Division numeral gradients** (graft 9: only the chapter numeral shifts per division; the rest of the UI stays neutral). `reader.js` sets `data-div` on `.hero` (slugs in §5.3). A writes:

```css
.hero[data-div="pentateuch"]       { --grad-num: linear-gradient(120deg, #ff9f0a 0%, #ff375f 50%, #bf5af2 100%); }
.hero[data-div="ot-history"]       { --grad-num: linear-gradient(120deg, #0a84ff 0%, #5e5ce6 55%, #bf5af2 100%); }
.hero[data-div="wisdom"]           { --grad-num: linear-gradient(120deg, #30b0c7 0%, #0a84ff 50%, #5e5ce6 100%); }
.hero[data-div="major-prophets"]   { --grad-num: linear-gradient(120deg, #5e5ce6 0%, #bf5af2 50%, #ff375f 100%); }
.hero[data-div="minor-prophets"]   { --grad-num: linear-gradient(120deg, #0a84ff 0%, #bf5af2 60%, #ff375f 100%); }
.hero[data-div="gospels"]          { --grad-num: linear-gradient(120deg, #0a84ff 0%, #5e5ce6 52%, #bf5af2 100%); }
.hero[data-div="nt-history"]       { --grad-num: linear-gradient(120deg, #ff375f 0%, #ff6a3d 55%, #ff9f0a 100%); }
.hero[data-div="pauline-epistles"] { --grad-num: linear-gradient(120deg, #5e5ce6 0%, #0a84ff 55%, #30b0c7 100%); }
.hero[data-div="general-epistles"] { --grad-num: linear-gradient(120deg, #bf5af2 0%, #5e5ce6 50%, #0a84ff 100%); }
.hero[data-div="apocalyptic"]      { --grad-num: linear-gradient(120deg, #ff375f 0%, #bf5af2 50%, #5e5ce6 100%); }
/* dark: brighten the numeral instead of a second table */
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .hero-title .chnum { filter: brightness(1.2) saturate(1.05); } }
:root[data-theme="dark"] .hero-title .chnum { filter: brightness(1.2) saturate(1.05); }
```

---

## 2. Typography scale

Body: `400 15px/1.47 var(--sans)`, `letter-spacing: -.01em`, `-webkit-font-smoothing: antialiased`, `text-rendering: optimizeLegibility`.

| Role | Spec |
|---|---|
| Hero title `.hero-title` | `600 clamp(60px, 9.5vw, 104px)/1.02 var(--display)`, `-.028em`, `text-wrap: balance` |
| Chapter numeral `.chnum` | background `var(--grad-num)`, `background-clip: text`, `color: transparent`, `padding-right: .04em` |
| Hero tagline `.hero-tag` | `600 clamp(22px, 2.7vw, 28px)/1.16 var(--display)`, `-.012em`, max-width 24em, balance; second clause `.soft` in `--label-3` |
| Eyebrow `.eyebrow` | `600 15px/1.2 var(--sans)`, `--label-2`, 8px testament dot, gap 8px |
| Intro line `.intro-line` | `17px/1.47`, `--label-2`, `-.02em`, max-width 34em |
| Sheet kicker `#drawer-kicker` | `600 12px/1.2 var(--sans)`, `--label-2`, tabular-nums |
| Sheet title `#drawer-title` | `700 22px/1.18 var(--display)`, `-.022em`, single line with ellipsis |
| Modal title `.modal-title` | `700 22px/1.2 var(--display)`, `-.022em` |
| Stage title `.stage-title` | `600 19px/1.2 var(--display)`, `-.022em` |
| List header `.lh h3` | `600 17px/1.25 var(--display)`, `-.02em` |
| Footer tile title | `600 21px/1.2 var(--display)`, `-.02em` |
| Cell title `.cell-title` | `600 15px/1.3 var(--sans)`, `-.015em` |
| Cell subtitle `.cell-sub` | `13px/1.4`, `--label-2`; serif previews `.cell-sub.serif` = `400 15px/1.45 var(--serif)`, 2-line clamp (raised from pro's 14px per the reading lens) |
| Chips `.chip` | `500 14px/1 var(--sans)`, `-.012em`; numbers `<b>` 600 tabular |
| Pills, segmented | `500 13px/1` (`600` when selected) |
| Small labels | 12px |
| Verse number `.vnum span` | `600 12px/1 var(--sans)`, tabular-nums, `--label-3` |
| Cross-ref count `.xc` | `500 12px/1 var(--sans)`, tabular-nums, `--label-3` at rest |
| Reading text `.verses` | `var(--read-size)` (20px desktop, 19px under 700px) `/1.72 var(--serif)`, `letter-spacing: 0`, `font-kerning: normal`, `font-variant-ligatures: common-ligatures`, colour `--read` |
| Sheet pull quote `.vq` | `400 17px/1.55 var(--serif)`; `.vq.sm` 15px `--label-2` |
| Greek line `.orig-line` | 25px/1.75 `--grk`; Hebrew 28px `--heb`, RTL |
| Word table original `.w-o` | 21px (Hebrew 23px); transliteration `.w-tl` `italic 13px/1.3 var(--sans)` |
| Lexicon lemma `.lex-lemma` | 46px/1.2 |
| Canvas text (viz) | `600 10px` / `500 11px` / `600 12px` in the `--sans` family string (§9.2) |

---

## 3. Layout, spacing and breakpoints

### 3.1 Page frame (window scrolling)

The document scrolls on the **window**, not on `#reader` (this is a change from the current app). `html { background: var(--bg); scroll-padding-top: calc(var(--bar-h) + 28px); scrollbar-gutter: stable; }`. `body` has normal flow (no `overflow: hidden`, no flex column).

```
<header#topbar.gnav>  fixed, 52px (96px under 700px)
<div#page.page>       padding-top: var(--bar-h)
   <section#panel>    stage wrapper (animated grid rows)
   <main#layout><section#reader.reader>   hero + verses + footer
<div#scrim.scrim>     fixed overlay (overlay mode / phone full detent)
<aside#drawer.drawer> fixed sheet
```

- Reading measure `--measure: 680px`. The verse block is `max-width: calc(var(--measure) + 110px)` (50px left gutter + 60px right gutter), centred. In parallel mode `.verses.parallel { --measure: 1000px }`.
- `.reader { padding: 0 16px 120px }`.
- Hero: `max-width: 1000px`, `padding: clamp(40px, 6.5vw, 80px) 24px 8px` (trimmed from pro's 44–96px so the text starts higher). Signature arcs figure `.sig { margin: 40px auto 0 }`, height 140px desktop / 104px under 700px (trimmed from 164/120).
- Verses start `48px` under the hero (`.verses { margin-top: 48px }`; 32px under 700px).
- Footer tiles `72px` above; copyright `36px` below the tiles above a hairline.
- Sheet: `--sheet-w: 420px` (440px at ≥1400px), inset 12px, `top: calc(var(--bar-h) + 12px)`, `bottom: 12px`, radius 22.
- Sheet body padding `6px 16px 40px`; list headers `.lh` margin `26px 4px 8px` (first child 8px); grouped cells `11px 14px 11px 16px`, min-height 44px; hairline separators inset 16px (46px in `.xrefs` with index numerals, 60px in `.group.av` with avatars or tiles).
- Phone side gutter 16px for chrome; reading gutters are tighter (§5.3).

### 3.2 Breakpoints (CSS and JS must agree)

| Width | Behaviour |
|---|---|
| ≥ 1400px | `--sheet-w: 440px` |
| ≥ 1100px | **side** mode: the open sheet pushes the page (`body.mode-side.drawer-open .page { padding-right: calc(var(--sheet-w) + 24px) }`); no scrim |
| < 1180px | Parallel select and Original toggle become icon-only (pro lines 682–687) |
| < 900px | Search collapses to an icon button `.search-open`; tapping it adds `#topbar.searching`, which shows the field as an overlay over row 1 with a Cancel link (pro lines 688–696) |
| 700–1099px | **overlay** mode: the sheet floats over the page with a scrim; modal |
| < 700px | **sheet** mode: bottom sheet with detents; two-row top bar (52 + 44 = 96px) whose second row is a horizontally scrolling tool strip with a right-edge fade mask; the bar hides on scroll-down; `--read-size: 19px`; `--bar-h: 96px` |

JS computes mode with `matchMedia('(min-width: 1100px)')` and `matchMedia('(max-width: 699px)')`: `side`, `overlay` or `sheet`.

### 3.3 z-index scale

`#topbar` 40 · `.scrim` 44 · `#drawer` 50 · `.menu` 70 · `#tip` 80 · `#toast` 90 · `.skip` 100. Dialogs use the top layer.

---

## 4. Icons

### 4.1 Mechanism

- **Single source of truth: `app/js/icons.js` (builder B).** It exports `ICONS` (name → inner SVG markup), `icon(name, cls = '')`, and `mountIconSprite()`.
- `mountIconSprite()` runs **at module evaluation** (side effect of importing icons.js). If `#icon-sprite` does not exist, it appends to `document.body` `<svg id="icon-sprite" width="0" height="0" style="position:absolute" aria-hidden="true"><defs>…<symbol id="i-NAME" viewBox="0 0 24 24">INNER</symbol>…</defs></svg>`. `main.js` imports icons.js first.
- `icon(name, cls)` returns exactly `<svg class="i${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`. Filled variant: `icon('play', 'f')`.
- **index.html (builder A) references icons directly**, with no placeholders and no sprite of its own: `<svg class="i" aria-hidden="true"><use href="#i-books"/></svg>`. The `<use>` resolves as soon as icons.js injects the sprite.
- CSS (A): `.i { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }` and `.i.f { fill: currentColor; stroke: none; }`. Sizes: toolbar `.ib .i` 19px · chips 16px · badges 14px · cell chevrons 13px (stroke 2) · close-button xmark 12px (stroke 2.6) · `.refbtn` chevron 11px (stroke 2.2).

### 4.2 Icon set (24×24, 1.5px strokes, round caps and joins)

`INNER` markup for each `<symbol id="i-NAME">`:

| name | inner SVG |
|---|---|
| books | `<rect x="3.5" y="4" width="4" height="16" rx="1"/><rect x="9.5" y="6.5" width="4" height="13.5" rx="1"/><path d="M15.4 7.9l3.2-.86 3.35 12.5-3.2.86z"/><path d="M3.5 8h4M9.5 10h4"/>` |
| chev-down | `<path d="M5 9l7 7 7-7"/>` |
| chev-left | `<path d="M15 5l-7 7 7 7"/>` |
| chev-right | `<path d="M9 5l7 7-7 7"/>` |
| back | `<path d="M8.5 13.5L4 9l4.5-4.5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H10"/>` |
| fwd | `<path d="M15.5 13.5L20 9l-4.5-4.5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H14"/>` |
| search | `<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.4 15.4L20 20"/>` |
| alpha | `<path d="M2.5 18.5L7 5.5l4.5 13M4.1 14h5.8"/><path d="M20.8 10.2c-.5 4-1.9 8.3-4.3 8.3-1.7 0-2.7-1.4-2.7-3.3 0-2.3 1.4-4.2 3.2-4.2 2.4 0 2.9 3.3 3.9 5.9.3.9.8 1.5 1.5 1.5"/>` |
| arcs | `<path d="M3 18.5h18"/><path d="M4.5 18.5a7.5 7.5 0 0115 0"/><path d="M9 18.5a3 3 0 016 0"/>` |
| graph | `<circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="6.5" r="2.5"/><circle cx="12.5" cy="18" r="2.5"/><path d="M8.5 7l7-.4M7.1 9.3l4.3 6.4M17 8.9l-3.5 6.9"/>` |
| map | `<path d="M9 4.5L3.5 6.5v13l5.5-2 6 2 5.5-2v-13l-5.5 2z"/><path d="M9 4.5v13M15 6.5v13"/>` |
| sidebar | `<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><path d="M14.5 4.5v15M17 8.5h1.5M17 11.5h1.5"/>` |
| gear | `<path d="M18.88 9.87L21.02 10.17 21.02 13.83 18.88 14.13 18.37 15.36 19.67 17.08 17.08 19.67 15.36 18.37 14.13 18.88 13.83 21.02 10.17 21.02 9.87 18.88 8.64 18.37 6.92 19.67 4.33 17.08 5.63 15.36 5.12 14.13 2.98 13.83 2.98 10.17 5.12 9.87 5.63 8.64 4.33 6.92 6.92 4.33 8.64 5.63 9.87 5.12 10.17 2.98 13.83 2.98 14.13 5.12 15.36 5.63 17.08 4.33 19.67 6.92 18.37 8.64Z"/><circle cx="12" cy="12" r="3"/>` |
| help | `<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 014.9.6c0 1.7-2.5 2.1-2.5 3.8"/><path d="M12 17.1v.01" stroke-width="2.2"/>` |
| xmark | `<path d="M6 6l12 12M18 6L6 18"/>` |
| link | `<path d="M10 14a4.5 4.5 0 006.4 0l3-3a4.5 4.5 0 00-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 00-6.4 0l-3 3a4.5 4.5 0 006.4 6.4l1-1"/>` |
| clock | `<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>` |
| calendar | `<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>` |
| people | `<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="16.6" cy="9" r="2.6"/><path d="M16.2 14.1c2.3.2 3.9 1.8 4.4 4.4"/>` |
| pin | `<path d="M12 21s-6.5-5.6-6.5-11.2a6.5 6.5 0 0113 0C18.5 15.4 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.3"/>` |
| book | `<path d="M12 6.8C10.4 5.4 8 4.8 4 4.8v13.4c4 0 6.4.6 8 2 1.6-1.4 4-2 8-2V4.8c-4 0-6.4.6-8 2z"/><path d="M12 6.8v13.4"/>` |
| note | `<path d="M11 4.5H7a3 3 0 00-3 3v9.5a3 3 0 003 3h9.5a3 3 0 003-3V13"/><path d="M17.8 3.9a1.9 1.9 0 012.7 2.7l-8 8-3.5.9.9-3.5z"/>` |
| play-rect | `<rect x="3" y="5" width="18" height="14" rx="3.5"/><path d="M10.3 9.4v5.2l4.4-2.6z"/>` |
| play | `<path d="M7 4.8v14.4a1 1 0 001.5.86l12-7.2a1 1 0 000-1.72l-12-7.2A1 1 0 007 4.8z"/>` (use with class `f`) |
| tag | `<path d="M3.8 12.6V4.8a1 1 0 011-1h7.8l7.6 7.6a1.4 1.4 0 010 2l-6.2 6.2a1.4 1.4 0 01-2 0z"/><path d="M8.3 8.3v.01" stroke-width="2.6"/>` |
| plus | `<path d="M12 5v14M5 12h14"/>` |
| check | `<path d="M5 12.5l4.5 4.5L19 7.5"/>` |
| ellipsis | `<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="2.4"/>` |
| trash | `<path d="M4.5 6.5h15M9.5 6.5V4.8a1 1 0 011-1h3a1 1 0 011 1v1.7M6.5 6.5l.8 12.2a1.5 1.5 0 001.5 1.3h6.4a1.5 1.5 0 001.5-1.3l.8-12.2"/>` |
| external | `<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v3.5a2.5 2.5 0 01-2.5 2.5h-9A2.5 2.5 0 014 17.5v-9A2.5 2.5 0 016.5 6H10"/>` |
| export | `<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M8.5 10.5H7a2.5 2.5 0 00-2.5 2.5v5A2.5 2.5 0 007 20.5h10a2.5 2.5 0 002.5-2.5v-5a2.5 2.5 0 00-2.5-2.5h-1.5"/>` |
| import | `<path d="M12 3.5v11M8 10.5l4 4 4-4"/><path d="M8.5 7.5H7A2.5 2.5 0 004.5 10v8A2.5 2.5 0 007 20.5h10a2.5 2.5 0 002.5-2.5v-8A2.5 2.5 0 0017 7.5h-1.5"/>` |
| arrow-right | `<path d="M5 12h14M13 6l6 6-6 6"/>` |
| arrow-left | `<path d="M19 12H5M11 6l-6 6 6 6"/>` |
| columns | `<rect x="3.5" y="4.5" width="17" height="15" rx="3.5"/><path d="M12 4.5v15"/>` |
| slash | `<circle cx="12" cy="12" r="7"/><path d="M7 17L17 7"/>` |
| sparkle | `<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 16v4M16.5 18h4"/>` |
| info | `<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.6v.01" stroke-width="2.2"/>` |
| route | `<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18H15a3 3 0 000-6H9a3 3 0 010-6h6.8"/>` |

Favicon (index.html `<link rel="icon">`): the `book` path as a data URI, stroke `#0071e3`, stroke-width 1.8 (copy pro.html line 8 exactly).

---

## 5. DOM and class contract

Class names follow `pro.html` unless listed as **NEW** or **CHANGED**. Builder A must style every class listed here. Builders B and C must emit exactly these structures. `[x]` means optional or conditional.

### 5.1 `index.html` (builder A writes this literally; B binds to it)

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#fbfbfd" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<title>Bible Study</title>
<link rel="icon" href="(pro.html line 8 data URI)">
<link rel="stylesheet" href="css/styles.css">
</head>
<body>
<a class="skip" href="#reader">Skip to the text</a>

<header id="topbar" class="gnav flat">
  <div class="gnav-left">
    <button id="btn-pick" class="ib" type="button" aria-label="Browse books" title="Browse books"><svg class="i" aria-hidden="true"><use href="#i-books"/></svg></button>
    <button id="cur-ref" class="refbtn" type="button" aria-haspopup="dialog" aria-controls="picker" title="Choose book and chapter"><span id="cur-ref-text">John 3</span><svg class="i" aria-hidden="true"><use href="#i-chev-down"/></svg></button>
    <span class="pair">
      <button id="btn-prev" class="ib" type="button" aria-label="Previous chapter" title="Previous chapter (←)"><svg class="i" aria-hidden="true"><use href="#i-chev-left"/></svg></button>
      <button id="btn-next" class="ib" type="button" aria-label="Next chapter" title="Next chapter (→)"><svg class="i" aria-hidden="true"><use href="#i-chev-right"/></svg></button>
    </span>
    <span class="vsep hide-m" aria-hidden="true"></span>
    <span class="pair">
      <button id="btn-back" class="ib" type="button" aria-label="Back" title="Back to where you came from" disabled><svg class="i" aria-hidden="true"><use href="#i-back"/></svg></button>
      <button id="btn-fwd" class="ib" type="button" aria-label="Forward" title="Forward" disabled><svg class="i" aria-hidden="true"><use href="#i-fwd"/></svg></button>
    </span>
  </div>
  <form id="search-form" class="search" role="search">
    <svg class="i" aria-hidden="true"><use href="#i-search"/></svg>
    <input id="search" type="search" placeholder="Search verses, words, G26, topics" autocomplete="off" spellcheck="false" aria-label="Search: a reference, words, a Strong's number or a topic">
    <kbd aria-hidden="true">/</kbd>
    <button type="button" class="cancel">Cancel</button>
  </form>
  <button class="ib search-open" type="button" aria-label="Search" title="Search (/)"><svg class="i" aria-hidden="true"><use href="#i-search"/></svg></button>
  <div class="gnav-right">
    <label class="pill-select" title="Primary translation"><span class="sr">Primary translation</span><select id="tr"></select><svg class="i chev" aria-hidden="true"><use href="#i-chev-down"/></svg></label>
    <label class="pill-select lead par" title="Parallel translation"><span class="sr">Parallel translation</span><svg class="i lead-i" aria-hidden="true"><use href="#i-columns"/></svg><select id="tr2"></select><svg class="i chev" aria-hidden="true"><use href="#i-chev-down"/></svg></label>
    <button id="btn-orig" class="toggle" type="button" aria-pressed="false" title="Show Hebrew / Greek under each verse (o)"><svg class="i" aria-hidden="true"><use href="#i-alpha"/></svg><span class="lbl">Original</span><span class="sr"> language interlinear</span></button>
    <div class="tools" role="group" aria-label="Visualisations">
      <button type="button" data-panel-btn="arcs" aria-pressed="false" aria-label="Cross-reference arcs" title="Arcs (a)"><svg class="i" aria-hidden="true"><use href="#i-arcs"/></svg></button>
      <button type="button" data-panel-btn="graph" aria-pressed="false" aria-label="Link graph" title="Graph (g)"><svg class="i" aria-hidden="true"><use href="#i-graph"/></svg></button>
      <button type="button" data-panel-btn="map" aria-pressed="false" aria-label="Map of places" title="Map (m)"><svg class="i" aria-hidden="true"><use href="#i-map"/></svg></button>
    </div>
    <span class="vsep hide-m" aria-hidden="true"></span>
    <button id="btn-drawer" class="ib" type="button" aria-label="Study panel" aria-controls="drawer" aria-expanded="false" title="Study panel"><svg class="i" aria-hidden="true"><use href="#i-sidebar"/></svg></button>
    <button id="btn-settings" class="ib" type="button" aria-label="Settings" aria-haspopup="dialog" title="Settings and API keys"><svg class="i" aria-hidden="true"><use href="#i-gear"/></svg></button>
    <button id="btn-help" class="ib" type="button" aria-label="Keyboard shortcuts" aria-haspopup="dialog" title="Keyboard shortcuts (?)"><svg class="i" aria-hidden="true"><use href="#i-help"/></svg></button>
  </div>
  <div id="progress" aria-hidden="true"></div>
</header>

<div class="page" id="page">
  <section id="panel" aria-labelledby="stage-title" aria-hidden="true" inert><div class="stage-clip"><div class="stage" id="stage"></div></div></section>
  <main id="layout"><section id="reader" class="reader" tabindex="-1" aria-label="Chapter text"></section></main>
</div>

<div class="scrim" id="scrim" aria-hidden="true"></div>
<aside id="drawer" class="drawer" role="dialog" aria-labelledby="drawer-title" aria-modal="false" aria-hidden="true" inert>
  <button class="grabber" id="grabber" type="button" aria-label="Expand study sheet"></button>
  <header class="sheet-top" id="sheet-top">
    <div class="sheet-head">
      <div class="sheet-title">
        <p class="sheet-kicker" id="drawer-kicker"></p>
        <h2 id="drawer-title" tabindex="-1">John 3</h2>
        <p id="drawer-sub"></p>
      </div>
      <span id="save-status" class="save" role="status" aria-live="polite"></span>
      <button id="verse-prev" class="close-btn plain" type="button" aria-label="Previous verse" title="Previous verse (k)" hidden><svg class="i" aria-hidden="true"><use href="#i-chev-left"/></svg></button>
      <button id="verse-next" class="close-btn plain" type="button" aria-label="Next verse" title="Next verse (j)" hidden><svg class="i" aria-hidden="true"><use href="#i-chev-right"/></svg></button>
      <button id="drawer-close" class="close-btn" type="button" aria-label="Close study panel" title="Close (Esc)"><svg class="i" aria-hidden="true"><use href="#i-xmark"/></svg></button>
    </div>
    <nav id="drawer-tabs" class="segmented" role="tablist" aria-label="Study panel sections">
      <span class="seg-ind" aria-hidden="true"></span>
      <button role="tab" type="button" id="tab-xref" data-tab="xref" aria-selected="true" aria-controls="drawer-body">Links<span class="count" id="cnt-xref"></span></button>
      <button role="tab" type="button" id="tab-context" data-tab="context" aria-selected="false" aria-controls="drawer-body" tabindex="-1">Context</button>
      <button role="tab" type="button" id="tab-orig" data-tab="orig" aria-selected="false" aria-controls="drawer-body" tabindex="-1">Original</button>
      <button role="tab" type="button" id="tab-notes" data-tab="notes" aria-selected="false" aria-controls="drawer-body" tabindex="-1">Notes<span class="pip" id="pip-notes" hidden></span></button>
      <button role="tab" type="button" id="tab-media" data-tab="media" aria-selected="false" aria-controls="drawer-body" tabindex="-1">Video<span class="count" id="cnt-media"></span></button>
      <button role="tab" type="button" id="tab-search" data-tab="search" aria-selected="false" aria-controls="drawer-body" tabindex="-1" hidden>Search</button>
    </nav>
  </header>
  <div id="drawer-body" class="sheet-body" role="tabpanel" aria-labelledby="tab-xref" tabindex="-1"></div>
</aside>

<dialog id="picker" class="modal picker" aria-labelledby="picker-title">
  <div class="modal-head">
    <h2 id="picker-title" class="modal-title">Books</h2>
    <label class="mini-search"><svg class="i" aria-hidden="true"><use href="#i-search"/></svg><input id="picker-filter" placeholder="Filter" autocomplete="off" spellcheck="false" aria-label="Filter books"></label>
    <button class="close-btn" type="button" data-close aria-label="Close"><svg class="i" aria-hidden="true"><use href="#i-xmark"/></svg></button>
  </div>
  <div class="picker-body">
    <div id="picker-books" class="picker-books"></div>
    <div id="picker-chapters" class="picker-chapters"></div>
  </div>
</dialog>

<dialog id="settings" class="modal" aria-labelledby="settings-title">
  <form id="settings-form" class="modal-form" method="dialog">
    <div class="modal-head"><h2 id="settings-title" class="modal-title">Settings</h2><button type="button" class="close-btn" data-close aria-label="Close"><svg class="i" aria-hidden="true"><use href="#i-xmark"/></svg></button></div>
    <div class="modal-body">
      <h3 class="group-h">Appearance</h3>
      <ul class="group frows">
        <li class="frow"><span id="theme-l">Theme</span><div id="theme" class="segmented sm" role="radiogroup" aria-labelledby="theme-l"><span class="seg-ind" aria-hidden="true"></span><button type="button" role="radio" data-theme-opt="auto" aria-checked="true">Auto</button><button type="button" role="radio" data-theme-opt="light" aria-checked="false" tabindex="-1">Light</button><button type="button" role="radio" data-theme-opt="dark" aria-checked="false" tabindex="-1">Dark</button></div></li>
        <li class="frow"><label for="fontsize">Reading size</label><div class="size-ctl"><span class="a1" aria-hidden="true">A</span><input id="fontsize" type="range" min="15" max="26" step="1" value="20"><span class="a2" aria-hidden="true">A</span></div></li>
      </ul>
      <h3 class="group-h">Licensed translations</h3>
      <ul class="group frows">
        <li class="frow"><label for="esv-key">ESV API key</label><input id="esv-key" autocomplete="off" spellcheck="false" placeholder="Paste key"></li>
        <li class="frow"><label for="nlt-key">NLT API key</label><input id="nlt-key" autocomplete="off" spellcheck="false" placeholder="Paste key"></li>
      </ul>
      <p class="group-foot">Free for personal use at <a href="https://api.esv.org/" target="_blank" rel="noopener">api.esv.org</a> and <a href="https://api.nlt.to/" target="_blank" rel="noopener">api.nlt.to</a>. Text is fetched a chapter at a time and cached on this computer. NIV, NKJV and LSB have no free API, so choosing them opens the chapter on BibleGateway or read.lsbible.org.</p>
    </div>
    <div class="modal-foot"><button type="button" class="btn btn-plain" data-close>Cancel</button><button type="submit" class="btn btn-primary">Save</button></div>
  </form>
</dialog>

<dialog id="help" class="modal" aria-labelledby="help-title">
  <div class="modal-head"><h2 id="help-title" class="modal-title">Keyboard shortcuts</h2><button type="button" class="close-btn" data-close aria-label="Close"><svg class="i" aria-hidden="true"><use href="#i-xmark"/></svg></button></div>
  <div class="modal-body">
    <dl class="keys">
      <dt><kbd class="k">←</kbd><kbd class="k">→</kbd></dt><dd>Previous / next chapter (also <kbd class="k">[</kbd> <kbd class="k">]</kbd>)</dd>
      <dt><kbd class="k">j</kbd><kbd class="k">k</kbd></dt><dd>Next / previous verse</dd>
      <dt><kbd class="k">↑</kbd><kbd class="k">↓</kbd></dt><dd>Move between verses when a verse has focus</dd>
      <dt><kbd class="k">return</kbd></dt><dd>Open the focused verse in the study panel</dd>
      <dt><kbd class="k">/</kbd></dt><dd>Search: a reference (<i>rom 8:28</i>), words, a Strong's number (<i>G26</i>) or a topic</dd>
      <dt><kbd class="k">o</kbd></dt><dd>Hebrew / Greek interlinear</dd>
      <dt><kbd class="k">a</kbd><kbd class="k">g</kbd><kbd class="k">m</kbd></dt><dd>Arcs · Graph · Map</dd>
      <dt><kbd class="k">n</kbd></dt><dd>Note for the selected verse (or double-click a verse)</dd>
      <dt><kbd class="k">?</kbd></dt><dd>This list</dd>
      <dt><kbd class="k">esc</kbd></dt><dd>Close the study panel or the visual panel</dd>
    </dl>
    <p class="credits">KJV &amp; BSB (public domain) · OpenBible.info cross-references &amp; topics (CC BY) · STEPBible TAHOT/TAGNT (CC BY 4.0) · Strong's via OpenScriptures (CC BY-SA) · Theographic Bible Metadata (CC BY-SA 4.0) · Easton's Bible Dictionary (1897) · Map tiles © OpenStreetMap contributors © CARTO.</p>
  </div>
  <div class="modal-foot"><button type="button" class="btn btn-primary" data-close>Done</button></div>
</dialog>

<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
<div id="tip" class="tip" role="tooltip" aria-hidden="true"></div>
<script type="module" src="js/main.js"></script>
</body>
</html>
```

**Stable ids kept:** `#topbar #btn-pick #cur-ref #btn-prev #btn-next #btn-back #btn-fwd #search-form #search #tr #tr2 #btn-orig [data-panel-btn] #btn-drawer #btn-settings #btn-help #panel #layout #reader #drawer #drawer-tabs #save-status #drawer-close #drawer-body #picker #picker-books #picker-chapters #settings #settings-form #esv-key #nlt-key #theme #fontsize #help #toast #note-text #note-tags #notes-filter #all-notes #video-form #player #mini-map #timeline #bigmap #arcs #graph #import-json`.

**NEW ids:** `#cur-ref-text #progress #page #stage #scrim #grabber #sheet-top #drawer-kicker #drawer-title #drawer-sub #verse-prev #verse-next #tab-xref #tab-context #tab-orig #tab-notes #tab-media #tab-search #cnt-xref #pip-notes #cnt-media #picker-title #picker-filter #settings-title #help-title #tip #sig-arcs #sig-cap #canon-mini #xfilter #md-mode #tokens #url-field #url-msg #intro-card #arc-min #arc-min-v #stage-title`.

**ID and behaviour changes vs the current app:**
- `#panel`: the `hidden` attribute is replaced by `.open` plus `inert` and `aria-hidden`. Viz content goes into `#stage`, not `#panel`.
- `#theme`: `<select>` becomes a button radiogroup `[data-theme-opt]`.
- `#note-tags`: now a token-field input. Tags come from chips, not a comma string.
- Notes Write/Preview toggle is the segmented `#md-mode`; the mode is UI state and is **no longer written into the note** (the old `n.preview` flag is ignored and never written).
- `#cur-ref` text moves into `#cur-ref-text`.
- Drawer tab buttons have `role=tab` and `aria-selected`; the active class `.active` is gone.
- Swatches use `role=radio` and `aria-checked` (the `.on` class is gone).
- `#timeline` is now a `<div class="timeline-host">` filled with SVG by viz (was a canvas). `#arcs` and `#graph` remain canvases (now inside `#stage`). `#bigmap` is the Leaflet container inside `#stage`.
- The import control is a real `<button data-import-json>` that clicks a hidden `#import-json` file input (the old `<label>` was not keyboard reachable).

### 5.2 Top bar (A styles, B binds)

- `#topbar.gnav`: fixed, 52px, `--glass` + `--blur`, 1px `--sep` bottom border. Three-column grid `minmax(max-content,1fr) minmax(180px,400px) minmax(max-content,1fr)` (pro line 123).
- **NEW** `.gnav.flat` (scrollY ≤ 8): `border-bottom-color: transparent`; `#progress` opacity 0. B toggles it on scroll.
- **NEW** `#progress`: `position:absolute; left:0; right:0; bottom:-1px; height:2px; background:var(--accent); opacity:.85; transform-origin:0 50%; transform:scaleX(0); pointer-events:none; transition: opacity .3s`. B sets `style.transform = 'scaleX(' + p + ')'` where `p = scrollY / (document.documentElement.scrollHeight - innerHeight)` (0 to 1), throttled with rAF.
- `.gnav.hide` (under 700px only): `transform: translateY(-100%)`, transition 450ms `--ease`. B adds it on scroll-down past 160px and removes it on scroll-up, and never while `.searching` is set.
- `.gnav.searching` (under 900px): the search overlay. `/` removes `.hide` and adds `.searching`.
- `#search-form.has-value` hides the `/` keycap (B toggles on input).
- `.pill-select.on` = parallel active (B toggles on the `#tr2` label).
- `#btn-orig[aria-pressed]`, `[data-panel-btn][aria-pressed]`, `#btn-drawer[aria-expanded]` (accent icon when true), and `.ib:disabled` at 28% opacity.
- `#tr` options (B): `<optgroup label="Bundled">KJV, BSB</optgroup><optgroup label="With API key">ESV, NLT</optgroup><optgroup label="Opens a website">NIV, NKJV, LSB</optgroup>`; option text is the abbreviation only. `#tr2`: `<option value="">Parallel</option>` plus the Bundled and With API key groups.

### 5.3 Reader (reader.js emits; A styles)

Container `#reader.reader`. B adds `.busy` only if loading takes more than 120ms (opacity .5). `#reader` carries `data-ch="b.c"`, used to detect a fresh chapter.

**Hero** (NEW attributes marked):
```html
<header class="hero[ enter]" data-div="gospels">
  <p class="eyebrow"><span class="t-dot nt" aria-hidden="true"></span>New Testament · Gospels</p>
  <h1 class="hero-title">John <span class="chnum">3</span></h1>
  [<p class="hero-tag">Jesus teaches Nicodemus. <span class="soft">John the Baptist exalts Christ.</span></p>]
  <p class="intro-line">Traditionally John the apostle, ‘the disciple whom Jesus loved’ · c. AD 85–95</p>
  <div class="chips" role="group" aria-label="This chapter at a glance">
    [<button class="chip" type="button" data-tab="context" title="Approximate year of the events in this chapter">ICON(clock)<span>c. AD 30</span><span class="era-track" aria-hidden="true"><i style="left:97.3%"></i></span></button>]
    [<button class="chip" type="button" data-tab="context">ICON(calendar)<span><b>2</b> events</span></button>]
    [<button class="chip" type="button" data-tab="context"><span class="monos" aria-hidden="true"><span class="mono">JE</span><span class="mono">NI</span><span class="mono">JB</span></span><span><b>6</b> people</span></button>]
    [<button class="chip" type="button" data-tab="context">ICON(pin)<span><b>5</b> places</span></button>]
    <button class="chip" type="button" data-tab="xref" title="Cross-reference links leaving this chapter">ICON(link)<span><b>658</b> links</span></button>
    <button class="chip more" type="button" data-tab="context" data-intro="1">About John ICON(chev-right)</button>
  </div>
  <figure class="sig">
    <div class="arc-host" id="sig-arcs"></div>
    <figcaption class="legend"><span class="key ot"><i></i>Old Testament · <b>130</b></span><span class="key nt"><i></i>New Testament · <b>528</b></span><span class="cap" id="sig-cap">Every link leaving John 3. Select an arc to study it.</span></figcaption>
  </figure>
</header>
```
- `data-div` slugs: `pentateuch`, `ot-history`, `wisdom`, `major-prophets`, `minor-prophets`, `gospels`, `nt-history`, `pauline-epistles`, `general-epistles`, `apocalyptic`. Rule: `History` → `ot-history` or `nt-history` by testament; otherwise `div.toLowerCase().replace(/\s+/g,'-')`.
- `.t-dot` and `.key` **always** carry an explicit `.ot` or `.nt` class (CHANGED: pro defaulted to NT).
- Tagline: port pro lines 1098–1102 (first event title in label colour; the next one or two event titles, or the outline section, in `.soft`). Omit the element if empty.
- Intro line: `smart(intro.author)` · `smart(intro.date)`. **Typographic quotes** helper, applied **before** `esc()`: `smart = s => String(s||'').replace(/(^|[\s(\[{—–-])'/g,'$1‘').replace(/'/g,'’').replace(/(^|[\s(\[{—–-])"/g,'$1“').replace(/"/g,'”')`. Use it for every book-intro string (author, date, audience, setting, purpose) wherever it is shown.
- Chips order: era, events, people, places, links, About. Show a chip only when its data exists (the links chip and About are always shown).
  - **Era chip** (NEW `.era-track`): a 28×4 track; the dot's `left` is the percentage position of the era year on the linear scale −2100…100 (clamped 0–100%).
  - **People chip** (NEW `.monos`): up to 3 `.mono` circles with initials of the 3 people with the most verses in the chapter (initials rule: pro line 980 `initials()`). If people.json fails to load, fall back to ICON(people).
- Hero entrance: add `.enter` only when the chapter changed since the last render (`#reader[data-ch]` differs).
- After setting innerHTML, B calls `viz.renderSignature(document.getElementById('sig-arcs'), { animate: fresh })`.
- Legend counts: `nOT` = links whose target book ≤ 39, `nNT` = the rest (from xref data).

**Notice card** (API translation without a key, or an API error):
```html
<div class="notice[ error]" role="note">ICON(sparkle | info)<p>ESV needs an API key<small>Add a free ESV key in Settings and the text is fetched a chapter at a time, then cached.</small></p><button class="btn btn-tinted sm" type="button" data-open-settings>Open Settings</button><button class="close-btn" type="button" data-dismiss-notice aria-label="Dismiss">ICON(xmark)</button></div>
```

**Verses** (CHANGED: roving tabindex, list roles, badges in the right gutter):
```html
<div class="verses[ parallel]" role="list" lang="en">
  [<div class="col-heads" aria-hidden="true"><span>King James Version</span><span>Berean Standard Bible</span></div>]
  <div class="verse[ hl-yellow]" id="v16" data-v="16" role="listitem" tabindex="0|-1"[ aria-current="true"]>
    <span class="vnum"><span>16</span></span>
    <span class="vtext">For God so loved the world…</span>
      — or in parallel mode —
    <div class="vcols"><div><span class="vtext">…</span></div><div class="alt"><span class="vtext">…</span></div></div>
    <span class="vmeta">[<button class="xc" type="button" data-v="16" tabindex="-1" aria-label="23 cross-references" title="23 cross-references">ICON(link)23</button>]<span class="badges">…</span></span>
    [<div class="inter[ rtl]" lang="grc|he" dir="ltr|rtl"><button class="iw[ variant]" type="button" data-v="16" data-i="0" tabindex="-1" title="G3779 · adverb"><span class="o grk|heb">οὕτως</span><span class="tl">houtōs</span><span class="gl">Thus</span></button>…</div>]
  </div>
</div>
```
- **Roving tabindex:** exactly one `.verse` has `tabindex="0"`: the selected verse, else the last focused verse, else `#v1`. All others have `-1`. On `focusin` of a verse, it becomes the roving one.
- **Badges** (in `.vmeta`, CHANGED from inline-after-text so they never wrap under long verses): `<span class="badges">[<span class="b-note" title="Has a note">ICON(note)<span class="sr">Has a note</span></span>][<span class="b-video" title="2 videos">ICON(play-rect)<span class="sr">2 videos</span></span>][<span class="b-tag" title="#gospel #love">ICON(tag)<span class="sr">Tags: gospel, love</span></span>]</span>`. Always emit `.badges`, even when empty.
- Highlight: class `hl-{yellow|green|blue|pink|orange}` on `.verse`; CSS paints `.vtext` (line-by-line marker with `box-decoration-break: clone`; pro line 271–273).
- Event flash: B adds `.flash` (remove, force reflow, re-add) to each verse; CSS animates `--accent-tint-2` to transparent over 2.2s.

**Footer and copyright** (pro lines 1137–1141):
```html
<nav class="foot-nav" aria-label="Chapters">
  <button class="foot-tile prev" type="button" data-nav="-1"[ disabled]><small>Previous</small><span>ICON(arrow-left)John 2</span></button>
  <button class="foot-tile next" type="button" data-nav="1"[ disabled]><small>Next</small><span>John 4ICON(arrow-right)</span></button>
</nav>
<p class="copyright">King James Version · Public domain[<br>Berean Standard Bible · Public domain (CC0)][<br>FULL ESV/NLT COPYRIGHT NOTICE (reader.js COPYRIGHT const)]<br>Cross-references: OpenBible.info (CC BY)</p>
```

**Reader CSS deltas vs pro (builder A):**
```css
.verse { position: relative; padding: 5px 60px 5px 50px; border-radius: 14px; cursor: pointer; outline: none; transition: background-color .3s var(--ease-out), box-shadow .2s; }
.verse:focus-visible { box-shadow: 0 0 0 2px var(--focus); }
.vmeta { position: absolute; right: 8px; top: 5px; width: 50px; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-family: var(--sans); }
.vmeta .xc { margin-top: calc((var(--read-size) * 1.72 - 22px) / 2); }
.vmeta > .badges:first-child { margin-top: calc((var(--read-size) * 1.72 - 14px) / 2); }
.badges { display: inline-flex; gap: 3px; padding-right: 6px; color: var(--label-3); line-height: 0; }
.badges:empty { display: none; }
.badges .i { width: 14px; height: 14px; }
.badges .b-note { color: var(--accent); }
.xc { color: var(--label-3); }            /* was --label-4 (2.1:1) */
.iw { font: inherit; color: inherit; }    /* .iw is now a <button> */
@media (max-width: 699px) {
  .reader { padding: 0 10px 100px; }
  .verse { padding: 4px 8px 4px 30px; border-radius: 12px; }
  .vnum { left: 0; width: 26px; top: 4px; }
  .vmeta { position: static; display: inline-flex; flex-direction: row; align-items: center; width: auto; gap: 4px; margin-left: 6px; vertical-align: 1px; }
  .vmeta .xc, .vmeta > .badges:first-child { margin-top: 0; height: 20px; }
}
@media (hover: none) { .xc { color: var(--label-2); } }
```
Everything else in the reader is pro lines 199–304 unchanged (hero, chips, `.sig`, `.arc*`, legend, `.verses`, `.col-heads` sticky at `top: var(--bar-h)`, `.vnum` capsule pop on `[aria-current="true"]`, `.vcols`, `.inter`, `.iw`, `.foot-*`, `.copyright`, `.notice`), except these hero additions:
```css
.hero { padding: clamp(40px, 6.5vw, 80px) 24px 8px; }
.sig { margin: 40px auto 0; max-width: 1000px; }
.verses { margin-top: 48px; }
.t-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--label-3); }
.t-dot.ot, .key.ot i, .tip .tm i.ot, .pgroup h4 i.ot { background: var(--ot); }
.t-dot.nt, .key.nt i, .tip .tm i.nt, .pgroup h4 i.nt { background: var(--nt); }
.chip .era-track { position: relative; width: 28px; height: 4px; border-radius: 2px; background: var(--fill); margin-left: 1px; }
.chip .era-track i { position: absolute; top: 50%; width: 7px; height: 7px; margin: -3.5px 0 0 -3.5px; border-radius: 50%; background: var(--label); box-shadow: 0 0 0 1.5px var(--bg); }
.monos { display: inline-flex; }
.mono { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: linear-gradient(180deg, #a5abb8, #858994); color: #fff; font: 600 9px/1 var(--sans); letter-spacing: 0; box-shadow: 0 0 0 1.5px var(--bg); }
.mono + .mono { margin-left: -6px; }
.legend b, #sig-cap b { font-weight: 600; color: var(--label); }
@media (max-width: 699px) { .verses { margin-top: 32px; } .sig { margin-top: 28px; } }
```

### 5.4 Signature arcs (viz emits inside `#sig-arcs`; A styles)

```html
<svg viewBox="0 0 W H" preserveAspectRatio="none" style="height:Hpx" role="img" aria-label="658 cross-reference arcs from John 3 across the 66 books">
  <g class="arcs[ anim]"><path class="arc ot|nt[ on]" data-v="16" d="M.. Q.. .." pathLength="1" style="--o:.43;--w:1.6px[;animation-delay:340ms]"/>…</g>
  <g class="arcs-sel"></g>          <!-- NEW: selected-verse arcs are MOVED here so they draw on top -->
  <path class="hv-halo" d=""/><path class="hv[ ot|nt]" d=""/>
  <g class="canon"><rect class="seg-b ot|nt[ cur]" …/>…</g>
</svg>
<div class="arc-labels"><span[ class="cur"] style="left:..%">John</span>…</div>
```
Host classes: `.arc-host.has-sel` (a verse with links is selected), `.arc-host.hovering`. CSS from pro lines 225–246, plus `.arc-host .arcs-sel .arc { opacity: 1; }`. `.arc-host.has-sel .arcs .arc { opacity: calc(var(--o) * .22); }`.

### 5.5 Sheet (static shell in 5.1; drawer.js emits the body)

**Sheet CSS deltas vs pro lines 306–347 (builder A):**
```css
.drawer { /* pro line 311 unchanged */ }
.sheet-kicker { margin: 0 0 3px; font: 600 12px/1.2 var(--sans); color: var(--label-2); letter-spacing: 0; font-variant-numeric: tabular-nums; }
.sheet-kicker:empty { display: none; }
#drawer-title { margin: 0; font: 700 22px/1.18 var(--display); letter-spacing: -.022em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; outline: none; }
#drawer-sub { margin: 2px 0 0; font-size: 13px; color: var(--label-2); }
#drawer-sub:empty { display: none; }
.sheet-head { align-items: flex-start; gap: 6px; }
.sheet-head > .close-btn, .sheet-head > .save { margin-top: 2px; }
.close-btn:disabled { opacity: .3; pointer-events: none; }
.close-btn.plain { background: none; }
.close-btn.plain:hover { background: var(--fill-2); }
.close-btn.plain .i { width: 16px; height: 16px; stroke-width: 2.2; }
.save { transition: opacity .4s var(--ease-out); }
.save.idle { opacity: 0; }
.segmented > button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
.segmented .count { font: 500 11px/1 var(--sans); font-variant-numeric: tabular-nums; color: var(--label-3); }
.segmented .count:empty { display: none; }
.segmented .pip { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }
.segmented > button[hidden] { display: none; }
.scrim { /* pro line 309 */ }
body.sheet-modal .scrim { opacity: 1; pointer-events: auto; }      /* CHANGED from body.drawer-open.overlay */
body.sheet-modal { overflow: hidden; }
.page { padding-top: var(--bar-h); transition: padding-right .56s var(--ease); }
body:not(.drawer-open) .page { transition-duration: .42s; }
body.mode-side.drawer-open .page { padding-right: calc(var(--sheet-w) + 24px); }   /* CHANGED: class, not media query */
.grabber { display: none; width: 100%; height: 20px; flex: none; cursor: grab; touch-action: none; }
.grabber::before { content: ""; display: block; width: 36px; height: 5px; margin: 7px auto 0; border-radius: 3px; background: var(--label-4); opacity: .7; }
.grabber:focus-visible { outline-offset: -4px; }
.skeleton { display: grid; gap: 12px; padding: 18px 4px; }
.skeleton i { display: block; height: 12px; border-radius: 6px; background: linear-gradient(90deg, var(--fill-2), var(--fill), var(--fill-2)); background-size: 200% 100%; animation: shimmer 1.3s linear infinite; }
@media (max-width: 699px) {
  .drawer { top: auto; left: 8px; right: 8px; bottom: max(8px, env(safe-area-inset-bottom)); width: auto; height: 64vh; height: var(--sheet-h, 64dvh); border-radius: var(--r-2xl);
    transform: translate3d(0, calc(100% + 24px), 0); transition: transform .42s var(--ease), height .5s var(--ease), visibility 0s linear .42s; }
  .drawer.open { transform: translate3d(0, var(--drag, 0px), 0); transition: transform .56s var(--ease), height .5s var(--ease), visibility 0s; }
  .drawer.full { --sheet-h: 94dvh; }
  .drawer.dragging { transition: none; }
  .grabber { display: block; }
  .sheet-top { padding-top: 0; touch-action: none; }
  #drawer-sub { display: none; }
  .segmented > button { font-size: 12.5px; padding: 0 2px; }
}
```

**Body shell** rendered by drawer.js: `#drawer-body` innerHTML = `<div class="view[ push| pop]" style="--dx:18px">…tab html…</div>`.

**Skeleton** (only if the tab's data has not arrived within 90ms): `<div class="skeleton" aria-busy="true"><i style="width:92%"></i><i style="width:70%"></i><i style="width:84%"></i><i style="width:56%"></i></div>`.

**Empty state:** `<div class="empty"><span class="tile-i blue">ICON</span><h4>Title</h4><p>Body</p></div>`.

**Grouped list primitives** (pro lines 349–459): `.lh` (list header: `<div class="lh"><h3>…</h3><span>…</span></div>`), `.group[ .av][ .xrefs]` (ul/ol), `.cell`, `.cell-body`, `.cell-title`, `.cell-sub[ .serif]`, `.cell-trail`, `.chev`, `.votes`, `.vbar.ot|.nt|.seq > i`, `.vn`, `.expand > div > .expand-in`, `li.open`, `.actions`, `.btn .btn-primary .btn-tinted .btn-plain .btn-gray .btn-wide .sm`, `.tile-i.indigo|.red|.blue`, `.avatar`, `.foot-note`, `.credit`, `.link`.

NEW or CHANGED CSS (builder A):
```css
.vbar.nt i { background: var(--nt); } .vbar.ot i { background: var(--ot); } .vbar.seq i { background: var(--accent); }
.xi { flex: none; width: 18px; align-self: flex-start; padding-top: 1px; margin-right: -2px; font: italic 400 15px/1.3 var(--serif); color: var(--label-3); text-align: right; font-variant-numeric: oldstyle-nums; }
.group.xrefs > li + li::before { left: 46px; }
.xref.open .cell-sub { display: none; }            /* the preview hides when the passage is expanded */
.in-verse { flex: none; padding: 4px 7px; border-radius: var(--r-pill); font: 600 11px/1 var(--sans); color: var(--accent); background: var(--accent-tint-2); white-space: nowrap; }
.stat[hidden] { display: none; }
.w-s { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.w-code { align-self: flex-start; margin-top: 3px; padding: 3px 6px; border-radius: 5px; background: var(--fill-2); font: 500 11px/1 var(--mono); color: var(--label-2); letter-spacing: 0; }
.w-lemma { font-size: 14px; line-height: 1.2; color: var(--label-3); }
.w-lemma.grk { font-family: var(--grk); } .w-lemma.heb { font-family: var(--heb); }
.thumb.art { background: radial-gradient(120% 90% at 85% 10%, #e7b96a 0%, rgba(231,185,106,0) 55%), radial-gradient(90% 80% at 10% 100%, #7a1628 0%, rgba(122,22,40,0) 60%), linear-gradient(135deg, #2b2230 0%, #4a2331 45%, #8c3a2c 100%); }
.thumb-t { position: absolute; left: 8px; right: 30px; bottom: 6px; font: 400 11px/1.15 var(--serif); letter-spacing: 0; color: rgba(255,255,255,.94); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.thumb.art .play { inset: 6px 6px auto auto; margin: 0; width: 22px; height: 22px; }
.thumb.art .play .i { width: 9px; height: 9px; }
.timeline-host { margin-top: 2px; }
.timeline-host svg { display: block; width: 100%; height: auto; overflow: visible; }
.mini-map { position: relative; height: 180px; border-radius: var(--r-md); overflow: hidden; background: var(--map-land); box-shadow: var(--sh-1); margin-bottom: 8px; }
```

#### Sheet header content (drawer.js `renderHead()`)

| Field | Value |
|---|---|
| `#drawer-kicker` | Verse selected: `Verse 16 of 36`. No verse: `New Testament · Gospels`. Search tab: `Search results`. |
| `#drawer-title` | `refLabel(b,c,v)`, for example `John 3:16` / `John 3`. Search tab: the query in curly quotes, or the topic name. |
| `#drawer-sub` | Original tab: `Greek · STEPBible TAGNT` or `Hebrew · STEPBible TAHOT`. All others: full name of the preview translation (`King James Version` or `Berean Standard Bible`, whichever `previewText` uses). |
| `#verse-prev` / `#verse-next` | `hidden` when no verse is selected or on the Search tab; `disabled` at verse 1 / the last verse. Click → `A.stepVerse(-1/+1)`; focus stays on the button. |
| `#cnt-xref` | Number of links for the selected verse (empty string when none). |
| `#pip-notes` | Shown when the selected verse (or chapter, if none) has a note with text, highlight or tags. |
| `#cnt-media` | Number of videos on the selected verse or chapter (empty when 0). |
| `#drawer-body[aria-labelledby]` | `tab-<activeTab>` |
| Tabs | `aria-selected` and roving `tabindex` (0 on active, −1 on others); `#tab-search` hidden until results exist; then call `moveInd(#drawer-tabs)`. |

#### Links tab (`state.drawerTab === 'xref'`)

With a verse selected:
```html
<blockquote class="vq">For God so loved the world…</blockquote>
<div class="canon-mini" id="canon-mini"></div>                          <!-- viz.renderCanonStrip -->
<div class="lh"><h3>Cross-references</h3><span>23 · ranked by votes</span></div>
<div class="filter-row"><div class="segmented sm" id="xfilter" role="radiogroup" aria-label="Filter by testament"><span class="seg-ind" aria-hidden="true"></span>
  <button type="button" role="radio" data-f="all" aria-checked="true">All 23</button><button type="button" role="radio" data-f="ot" aria-checked="false"[ disabled]>Old 1</button><button type="button" role="radio" data-f="nt" aria-checked="false"[ disabled]>New 22</button></div></div>
<ol class="group xrefs">
  <li class="xref" data-i="0" data-b="45" data-c="5" data-v="8" data-e="0" data-t="nt"[ hidden]>
    <button class="cell" type="button" aria-expanded="false" aria-controls="xe0">
      <span class="xi" aria-hidden="true">1</span>
      <span class="cell-body"><span class="cell-title">Romans 5:8</span><span class="cell-sub serif" data-preview></span></span>
      <span class="cell-trail"><span class="votes" title="984 votes"><span class="vbar nt"><i style="width:100%;animation-delay:0ms"></i></span><span class="vn">984</span></span>ICON(chev-right, 'chev')</span>
    </button>
    <div class="expand" id="xe0" role="region" aria-label="Romans 5 in context"><div><div class="expand-in"></div></div></div>
  </li>
</ol>
[<div class="lh"><h3>Topics citing this verse</h3><span>4</span></div><div class="topic-chips"><button class="chip" type="button" data-topic="Love">ICON(sparkle)Love</button>…</div>]
<div class="mini-legend"><span class="key ot"><i></i>Old Testament</span><span class="key nt"><i></i>New Testament</span></div>
<p class="foot-note">Cross-references: OpenBible.info (CC BY). Votes reflect how many readers found a link helpful. Tap a row to read it in context.</p>
```
- Vote bar width `max(5, round(100·votes/max))%`; `animation-delay: min(i,12)·30ms`.
- Previews: fill `[data-preview]` sequentially after pre-loading each unique target book in parallel (pro line 1274–1278); clip at 170 chars on a word boundary. The empty `.cell-sub` shows the shimmer (pro line 370).
- Expanded content (`.expand-in`), loaded once:
```html
<div class="ctx-read"><p><span class="n">6</span>…</p><p class="t"><span class="n">8</span><span class="tx">But God commendeth…</span></p>…</div>
<div class="actions"><button class="btn btn-primary sm" type="button" data-go="45.5.8">Open Romans 5ICON(arrow-right)</button><button class="btn btn-tinted sm" type="button" data-graph="45.5.8">ICON(graph)Graph</button><button class="btn btn-tinted sm" type="button" data-addnote="Romans 5:8">ICON(plus)Add to note</button></div>
```
  The context window is 2 verses either side of the target range. Toggling adds or removes `li.open` and sets `aria-expanded`.
- No links: `vq` + empty state (ICON link, "No cross-references", "OpenBible.info has no links recorded for this verse.").

With no verse selected:
```html
<div class="lh"><h3>Most-linked verses</h3><span>John 3</span></div>
<ul class="group"><li><button class="cell" type="button" data-select="16"><span class="cell-body"><span class="cell-title">Verse 16</span><span class="cell-sub">Top link: Romans 5:8</span></span><span class="cell-trail"><span class="votes"><span class="vbar seq"><i style="width:100%"></i></span><span class="vn">23</span></span>ICON(chev-right,'chev')</span></button></li>…(top 12)</ul>
<p class="foot-note">Select a verse to see its cross-references. Data: OpenBible.info (CC BY).</p>
```

#### Context tab

Scope rule (CHANGED from pro, per the reading lens): **always list everything in the chapter**; when a verse is selected, items present in that verse are sorted first and get `<span class="in-verse">This verse</span>` in `.cell-trail` before the chevron. "When" uses the selected verse's year when it has one, else the chapter median.
```html
[<div class="stats"><div class="stat"[ hidden]><small>When</small><b>c. AD 30</b></div><div class="stat"[ hidden]><small>Writer</small><b>John</b></div><div class="stat"[ hidden]><small>Written</small><b>c. AD 85–95</b></div></div>]
[<div class="lh"><h3>Timeline</h3><span>John 3 in Bible history</span></div><div id="timeline" class="timeline-host"></div>]   <!-- viz.renderTimeline -->
[<div class="lh"><h3>Events</h3><span>2</span></div><ul class="group av">
  <li><button class="cell" type="button" data-event="274"><span class="tile-i indigo">ICON(calendar)</span><span class="cell-body"><span class="cell-title">Jesus teaches Nicodemus</span><span class="cell-sub">AD 27 · 1 day · Jerusalem</span></span><span class="cell-trail"><span class="vn">v1–21</span>[<span class="in-verse">This verse</span>]ICON(chev-right,'chev')</span></button></li></ul>]
[<div class="lh"><h3>People</h3><span>6</span></div><ul class="group av">
  <li class="person"><button class="cell" type="button" data-person="1324" aria-expanded="false"><span class="avatar" aria-hidden="true">JE</span><span class="cell-body"><span class="cell-title">Jesus</span><span class="cell-sub">4 BC – AD 30 · 1,281 verses</span></span><span class="cell-trail">[in-verse]ICON(chev-right,'chev')</span></button><div class="expand"><div><div class="expand-in"></div></div></div></li></ul>]
[<div class="lh"><h3>Places</h3><button class="link" type="button" data-panel="map">Open full map</button></div><div class="mini-map" id="mini-map"></div><ul class="group av">
  <li class="place"><button class="cell" type="button" data-place="600" aria-expanded="false"><span class="tile-i red">ICON(pin)</span><span class="cell-body"><span class="cell-title">Jerusalem</span><span class="cell-sub">City · Israel</span></span><span class="cell-trail">[in-verse]ICON(chev-right,'chev')</span></button><div class="expand"><div><div class="expand-in"></div></div></div></li></ul>]
<details class="intro-card" id="intro-card"[ open]><summary><span class="tile-i blue">ICON(book)</span><span class="cell-body"><span class="cell-title">About John</span><span class="cell-sub">Author, audience, purpose, themes and outline</span></span>ICON(chev-right,'chev')</summary>
  <div class="intro-body"><dl class="kv"><div><dt>Author</dt><dd>…</dd></div>…Date, Audience, Setting, Purpose…</dl>
  [<div class="tags-static"><span class="tag-s">I AM sayings</span>…</div>]
  [<ol class="outline"><li[ class="cur"]><button type="button" data-goch="2"><span class="rng">2–12</span><span>Book of Signs</span>[<span class="here">You are here</span>]</button></li>…</ol>]
  <p class="credit">Introductions summarise mainstream scholarship; dates are approximate. People, places, events: Theographic Bible Metadata (CC BY-SA 4.0). Dictionary: Easton's (1897).</p></div></details>
```
- Stats: hide a tile with no value; omit the whole `.stats` if all three are empty (no "—" tiles). Writer = names of `ch.w` people, else the first clause of `intro.author` without a leading "Traditionally ".
- Timeline: render only if `era !== null || written !== null`. `written = parseSpan(intro.date)`:
  `function parseSpan(s){ if(!s) return null; const bc=/BC/i.test(s); const n=(String(s).match(/\d{2,4}/g)||[]).map(Number); if(!n.length) return null; let a=n[0], z=n[1]??n[0]; if(bc){a=-a; z=-z;} return [Math.min(a,z), Math.max(a,z)]; }`
- Expand person (pro line 1351–1361): `<p class="rel">Father X · Mother Y · …</p><p class="dict">…</p>[<button class="link" type="button" data-more-dict>More</button>]<div class="actions"><button class="btn btn-tinted sm" type="button" data-search="Nicodemus">ICON(search)Find “Nicodemus”</button></div>`. `.dict` clamps to 6 lines; More/Less toggles `.dict.full`.
- Expand place: coordinates line `31.778°, 35.235° · Exact` in `.rel` (label-2), `.dict`, Find button; then `viz.miniMap.focus(id)`.
- Event click: flash its verses in this chapter (`A.flash`), else navigate to the event's first verse. In overlay mode also close the sheet; in phone mode collapse to the medium detent.
- `intro-card` is open when `opts.intro` is set or when there are no events and no people; when `opts.intro` is set, scroll it into view (block start) after 120ms.

#### Original tab
```html
<blockquote class="vq sm">…English…</blockquote>
<p class="lang-eyebrow">Greek · all major editions | Hebrew · Leningrad Codex</p>
<p class="orig-line grk|heb" lang="grc|he" dir="ltr|rtl"><button class="ow[ variant][ on]" type="button" data-i="0" aria-label="houtōs: Thus">οὕτως</button> …</p>
<div class="lh"><h3>Word by word</h3><span>25 words</span></div>
<ul class="group words">
  <li class="[variant][ focus]" id="w0" data-i="0">
    <div class="w-o grk|heb" lang="grc|he">οὕτως<span class="w-tl" lang="en">houtōs</span></div>
    <div class="w-g"><span class="w-gl">Thus</span><span class="w-m">Adverb</span><span class="w-code">ADV</span>[<span class="w-var">Textus Receptus only</span>]</div>
    <div class="w-s">[<button class="strong" type="button" data-strong="G3779" aria-label="Strong's G3779, οὕτω">G3779</button>][<span class="w-lemma grk|heb" lang="grc|he">οὕτω</span>]</div>
  </li>
</ul>
<p class="foot-note">STEPBible TAGNT (CC BY 4.0). Amber words are textual variants between the Textus Receptus (KJV) and modern critical editions.</p>
```
- `.w-m` text = `decodeMorph(morph, heb)` split on spaces into parts joined with ` · ` (keep `+` segments for Hebrew prefixes); CSS capitalises the first letter. `.w-code` shows the raw morph code (graft: mono chip). `.w-var` text: `Textus Receptus only` / `Critical text only` / `Variant reading` (pro's short `wordTypeLabel` variants, pro line 990; compute from `isVariantWord` and `wordTypeLabel` in morph.js).
- Clicking `.ow` highlights the word (`.on`), sets `li.focus` on its row and scrolls it to centre.
- No verse selected: empty state (ICON alpha, "Read it in Greek|Hebrew", "Select a verse to see it word by word. Turn on Original in the toolbar to show the interlinear under every verse.").
- **Strong's view** (pushed screen; render with `{push:true}`, back with `{pop:true}`):
```html
<div class="navbar"><button class="back" type="button" data-back-orig>ICON(chev-left)John 3:16</button></div>
<div class="lex"><div class="lex-lemma grk|heb" lang="grc|he">ἀγαπάω</div><div class="lex-meta"><i>agapáō</i>[<span>ag-ap-ah'-o</span>]<span class="strong static">G25</span></div></div>
<ul class="group kvg">[<li><dl><dt>Definition</dt><dd>…</dd></dl></li>][<li><dl><dt>KJV renders as</dt><dd>…</dd></dl></li>][<li><dl><dt>Derivation</dt><dd>…</dd></dl></li>]</ul>
<div class="lh"><h3>143 occurrences</h3><span>Greek NT</span></div>
<div class="dist" role="img" aria-label="Occurrences by book"><div class="dist-row"><span>John</span><span class="dist-t"><i style="width:100%"></i></span><span class="dist-v">37</span></div>…(top 10)</div>
<ul class="group occ" data-strong="G25" data-shown="0"></ul><button class="btn btn-gray btn-wide" type="button" data-more-occ>Show more</button>
```
  Occurrences are 20 per page (rows: cell-title ref + `.cell-sub.serif` preview clipped at 150 chars + chevron, `data-go`). `Show more` is hidden when everything is shown.

#### Notes tab (pro lines 1408–1431 and 1490–1501, with changes)
```html
<div class="scope"><span>Verse note | Chapter note</span><button class="link" type="button" data-scope>Switch to chapter note | Select a verse for a verse note</button></div>
<section class="card note-card">
  [<div class="hl-row"><span id="hl-l">Highlight</span><div class="swatches" role="radiogroup" aria-labelledby="hl-l">
     <button class="sw sw-yellow" type="button" role="radio" data-hl="yellow" aria-checked="false" aria-label="Yellow" title="Yellow">ICON(check)</button>…green, blue, pink, orange…
     <button class="sw sw-none" type="button" role="radio" data-hl="" aria-checked="true" aria-label="No highlight" title="No highlight">ICON(slash)</button></div></div>]   (verse notes only)
  <div class="editor"><div class="editor-top"><span>Markdown</span><div class="segmented sm" id="md-mode" role="radiogroup" aria-label="Editor mode"><span class="seg-ind" aria-hidden="true"></span><button type="button" role="radio" data-mode="write" aria-checked="true">Write</button><button type="button" role="radio" data-mode="preview" aria-checked="false"[ disabled]>Preview</button></div></div>
    <textarea id="note-text" class="note-text" aria-label="Note" placeholder="Write your note… Link verses like [[Romans 5:8]].">…</textarea>
      — or in preview mode —
    <div class="md" data-md>…rendered markdown…</div></div>
  <div class="tokens" id="tokens">ICON(tag)<span class="token">#gospel<button type="button" data-untag="gospel" aria-label="Remove tag gospel">ICON(xmark)</button></span>…<input id="note-tags" placeholder="Add tags" aria-label="Add a tag, then press Return" autocomplete="off"></div>
</section>
<div class="lh"><h3>Notes in John 3</h3><span>4</span></div>
<ul class="group">…noteRow…</ul>     (empty: <li class="cell"><span class="cell-sub">None yet.</span></li>)
<details class="disclosure"><summary>All notes <span class="disc-meta">37ICON(chev-right,'chev')</span></summary>
  <label class="field">ICON(search)<input id="notes-filter" placeholder="Filter by text or #tag" aria-label="Filter notes"></label>
  <ul class="group" id="all-notes">…noteRow… (max 200)</ul></details>
<div class="export-row"><a class="btn btn-tinted sm" href="/api/export/obsidian" download>ICON(export)Export for Obsidian</a><button class="btn btn-tinted sm" type="button" data-export-json>ICON(export)Export JSON</button><button class="btn btn-tinted sm" type="button" data-import-json>ICON(import)Import JSON</button><input type="file" id="import-json" accept="application/json" hidden></div>
```
- `noteRow`: `<li><button class="cell" type="button" data-go="43.3.16"><span class="hdot yellow" aria-hidden="true"></span><span class="cell-body"><span class="cell-title">John 3:16</span><span class="cell-sub">snippet · #gospel #love · 1 video</span></span>ICON(chev-right,'chev')</button></li>`.
- CSS for `.disc-meta`: `display:flex; align-items:center; gap:8px; font:400 13px var(--sans); color:var(--label-2)` (replaces pro's inline style).
- Editor mode is the module variable `mdMode` in drawer.js. It defaults to `'preview'` when the note has text, and to `'write'` when opened with `{focus:true}` (n key, double-click, Add to note) or when the note is empty. Clicking the preview returns to Write and focuses the textarea (links inside it still navigate). **Never store the mode on the note.**
- Textarea autosizes (min 140px). Every input updates the note, `touchNote`, `A.refreshMarker`, and enables or disables Preview.
- Tags: Enter or comma adds (strip a leading `#` and commas; no duplicates); Backspace on an empty input removes the last tag; `[data-untag]` removes one. After changing, re-render with `{keepScroll:true}` and re-focus `#note-tags`. Clicking empty space in `#tokens` focuses the input.
- Swatches: set `aria-checked` in place (no full re-render) and call `A.refreshMarker`.
- Import: `data-import-json` → `#import-json.click()`; on change, merge `j.refs` into `state.notes.refs`, `scheduleSave`, re-render the reader and drawer; on error, toast "Import failed: …" (no `alert()`).

#### Video tab (pro lines 1454–1471, with changes)
```html
<div id="player" class="player" hidden></div>
<form id="video-form" class="card form-card" novalidate>
  <label class="field" id="url-field">ICON(link)<input name="url" placeholder="YouTube link: watch, youtu.be, shorts" aria-label="YouTube link" aria-describedby="url-msg" autocomplete="off"></label>
  <p class="field-msg" id="url-msg" hidden>That doesn’t look like a YouTube link.</p>
  <div class="field-row"><label class="field"><input name="title" placeholder="Title (optional)" aria-label="Title"></label><label class="field"><input name="ts" placeholder="0:00" aria-label="Start time, minutes and seconds" inputmode="numeric"></label></div>
  <button class="btn btn-primary btn-wide" type="submit">ICON(plus)Add to John 3:16</button>
</form>
<div class="lh"><h3>This verse | This chapter | Rest of John | Everything else</h3><span>2</span></div>
<ul class="group">
  <li class="video" data-k="43.3.16" data-i="0">
    <button class="cell" type="button" data-play="G-2e9mMf7E8" data-start="192"><span class="thumb"><img src="https://i.ytimg.com/vi/ID/mqdefault.jpg" alt="" loading="lazy"><span class="play">ICON(play,'f')</span></span><span class="cell-body"><span class="cell-title">Overview: John 1–12</span><span class="cell-sub">John 3:16 · from 3:12</span></span></button>
    <button class="more-btn" type="button" data-menu aria-haspopup="menu" aria-label="More actions for Overview: John 1–12">ICON(ellipsis)</button>
  </li>
</ul>
```
- **Thumbnail fallback art** (graft 13): drawer.js adds capture-phase `error` and `load` listeners on `#drawer-body`. If a `.thumb img` errors, or loads with `naturalWidth === 120` (YouTube's grey placeholder), remove the img, add `.art` to `.thumb`, and append `<span class="thumb-t">{title}</span>`.
- Invalid URL: `#url-field.bad` (remove, force reflow, re-add to re-shake), show `#url-msg`, focus the input; any input in the field clears both.
- Play: fill `#player` with `<iframe src="https://www.youtube-nocookie.com/embed/ID?start=S&autoplay=1&rel=0" title="Video player" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`, unhide it, and scroll the sheet body to the top.
- `⋯` menu (§5.8): "Go to passage" (ICON arrow-right), "Open on YouTube" (`<a>` with ICON external), `<hr>`, "Remove" (`.danger`, ICON trash). Remove splices the video, saves, re-renders and shows `A.toast('Video removed.', {label:'Undo', run})`. No `confirm()`.
- Empty state: ICON play-rect, "No videos yet", "Paste a YouTube link above. It plays right here, next to the text."

#### Search tab (built by main.js; stored with `drawer.setSearchResults(title, html)`)
```html
[<div class="lh"><h3>Topics</h3><span>3</span></div><div class="topic-chips"><button class="chip" type="button" data-topic="New Birth">ICON(sparkle)New Birth</button>…</div>]
<div class="lh"><h3>“born again”</h3><span>11 verses · KJV</span></div>
[<p class="foot-note">Or open <button class="link" type="button" data-go="45.8.28">Romans 8:28</button></p>]
<ul class="group"><li><button class="cell" type="button" data-go="43.3.3"><span class="cell-body"><span class="cell-title">John 3:3</span><span class="cell-sub serif clamp3">…<mark>born again</mark>…</span></span>ICON(chev-right,'chev')</button></li>…(max 200)</ul>
  — or — <div class="empty"><span class="tile-i blue">ICON(search)</span><h4>No verses found</h4><p>Try fewer words, a reference like <i>rom 8:28</i>, or a Strong's number like <i>G26</i>.</p></div>
```
CSS: `.cell-sub.clamp3 { -webkit-line-clamp: 3; }`. While searching: `<div class="skeleton" aria-busy="true">…</div>`. Topic view: `lh` (topic name, "N votes · OpenBible.info") + rows with previews and trailing `.vn` vote counts (pro line 1549–1553).

### 5.6 Stage (#panel / #stage; viz.js emits all content of `#stage`)

A styles the wrapper from pro lines 173–197 with the night tokens (§1) and these deltas:
```css
#panel { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows .55s var(--ease), opacity .35s var(--ease-out); }
#panel.open { grid-template-rows: 1fr; opacity: 1; }
#panel > .stage-clip { min-height: 0; overflow: hidden; }
.stage { position: relative; margin: 18px auto 6px; width: min(1200px, calc(100% - 32px)); height: min(50vh, 460px); border-radius: var(--r-2xl); overflow: hidden; display: flex; flex-direction: column; }
.stage-head { display: flex; align-items: flex-start; gap: 14px; padding: 16px 14px 6px 24px; flex-wrap: wrap; }
.stage-titles { min-width: 0; }
.stage-head .legend { justify-content: flex-start; margin: 8px 0 0; }
.stage-tools { display: flex; align-items: center; gap: 10px; align-self: center; }
.pill-tog { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px 0 10px; border-radius: var(--r-pill); background: var(--fill-2); font: 600 13px/1 var(--sans); color: var(--label); transition: background-color var(--d-2), color var(--d-2), transform var(--d-1); }
.pill-tog .i { width: 16px; height: 16px; color: var(--label-2); }
.pill-tog:active { transform: scale(.96); }
.pill-tog[aria-pressed="true"] { background: var(--accent-tint-2); color: var(--accent); }
.pill-tog[aria-pressed="true"] .i { color: var(--accent); }
.stage-body { position: relative; flex: 1; min-height: 0; }
.stage-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: crosshair; }
.leaf { position: absolute; inset: 4px 12px 12px; border-radius: 18px; overflow: hidden; background: var(--map-land); }
.stage-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--label-2); font-size: 14px; text-align: center; padding: 20px; }
@media (max-width: 699px) { .stage { height: 56vh; width: calc(100% - 16px); border-radius: 22px; } .stage-head { padding: 14px 12px 4px 18px; } .stage-sub { display: none; } }
```
Contents (viz):
```html
<div class="stage-head">
  <div class="stage-titles"><h2 class="stage-title" id="stage-title">Cross-reference arcs</h2><p class="stage-sub">658 links leaving John 3 · verse 16 highlighted. Click an arc to go there.</p>
    <div class="legend"><span class="key ot"><i></i>Old Testament</span><span class="key nt"><i></i>New Testament</span></div></div>
  <span class="spacer"></span>
  <div class="stage-tools">
    (arcs)  <label class="range-ctl">Minimum votes <input type="range" id="arc-min" min="0" max="…" value="0"><output id="arc-min-v">0</output></label>
    (graph) <button class="pill-tog" type="button" data-hop aria-pressed="false">ICON(graph)Second hop</button>
    (map)   <button class="pill-tog" type="button" data-paul aria-pressed="false">ICON(route)Paul’s journeys</button>
  </div>
  <button class="close-btn" type="button" data-close-panel aria-label="Close arcs|graph|map">ICON(xmark)</button>
</div>
<div class="stage-body">
  (arcs)  <canvas id="arcs" class="stage-canvas" role="img" aria-label="…"></canvas>
  (graph) <canvas id="graph" class="stage-canvas" role="img" aria-label="…"></canvas>
  (map)   <div class="leaf" id="bigmap"></div>
  (empty) <div class="stage-empty">…</div>
</div>
```
B binds a delegated click on `#stage` for `[data-close-panel]` → `A.showPanel(state.panel)` (toggle off). Viz binds everything else inside the stage.

### 5.7 Viz SVG classes styled by A

**Canon strip (Links tab, `#canon-mini`)** — pro lines 408–414, with `.canon-mini .seg-b.ot/.nt/.cur` and `.canon-mini .dot.ot/.nt`, dot ring `stroke: var(--sheet-solid); stroke-width: 2`, `text` 500 10.5px label-3.

**Timeline (`#timeline`, focus+context)** — NEW:
```css
.tl-e0 { fill: var(--fill); } .tl-e1 { fill: var(--fill-2); }
.tl-win { fill: none; stroke: var(--label-2); stroke-width: 1; }
.tl-conn { fill: none; stroke: var(--sep-2); stroke-width: 1; }
.tl-band0 { fill: var(--fill-2); } .tl-band1 { fill: var(--fill-3); }
.tl-axis { stroke: var(--sep-2); stroke-width: 1; }
.tl-t { font: 500 9.5px var(--sans); fill: var(--label-3); letter-spacing: 0; }
.tl-band-l { font: 500 10px var(--sans); fill: var(--label-2); letter-spacing: 0; }
.tl-ev { stroke: var(--label-4); stroke-width: 1; }
.tl-ev.here { stroke: var(--accent); stroke-width: 2; }
.tl-mk-line { stroke: var(--accent); stroke-width: 1.5; }
.tl-mk { fill: var(--accent); stroke: var(--sheet-solid); stroke-width: 2; }
.tl-wr { fill: none; stroke: var(--label); stroke-width: 1.5; stroke-linecap: round; }
.tl-mk-l { font: 600 11px var(--sans); fill: var(--label); letter-spacing: 0; }
.tl-mk-s { font: 400 10.5px var(--sans); fill: var(--label-3); letter-spacing: 0; }
.tl-hit { fill: transparent; cursor: default; }
```

**Stylised map (`.lev`, mini-map and stage fallback)** — NEW:
```css
.lev { display: block; width: 100%; height: 100%; }
.lev .sea, .lev .lake { fill: var(--map-sea); }
.lev .lake { stroke: var(--map-water); stroke-width: .75; }
.lev .coast { fill: none; stroke: var(--map-water); stroke-opacity: .6; stroke-width: 1; }
.lev .river { fill: none; stroke: var(--map-water); stroke-width: 1.4; stroke-linecap: round; }
.lev .grat { fill: none; stroke: var(--sep); stroke-width: .75; }
.lev .region { font: 600 9px var(--sans); letter-spacing: .24em; fill: var(--label-3); opacity: .8; }
.lev .water-l { font: italic 400 11px var(--serif); fill: var(--label-3); letter-spacing: 0; }
.lev .pt { fill: var(--viz-ink); stroke: var(--map-land); stroke-width: 2.5; cursor: pointer; }
.lev .pt.hi { fill: var(--accent); }
.lev .pt-l { font: 600 11px var(--sans); fill: var(--label); paint-order: stroke; stroke: var(--map-land); stroke-width: 3.5px; stroke-linejoin: round; letter-spacing: 0; }
.lev .pt-l.hi { font-weight: 700; }
.lev .ctx-pt { fill: var(--label-3); }
.lev .ctx-l { font: 500 10px var(--sans); fill: var(--label-3); paint-order: stroke; stroke: var(--map-land); stroke-width: 3px; letter-spacing: 0; }
```

**Leaflet skin** — pro lines 656–669, except: drop the `.leaflet-tile-pane` filters (the CARTO tiles are already dark); `.leaflet-container { background: var(--map-land) !important }`; the pin is NEW-sized for the night stage:
```css
.pin { width: 18px; height: 18px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px #fff, 0 4px 12px rgba(0,0,0,.45); display: grid; place-items: center; }
.pin::after { content: ""; width: 5px; height: 5px; border-radius: 50%; background: #fff; }
.leaflet-tooltip.pin-label { background: none; border: 0; box-shadow: none; padding: 0 0 0 6px; font: 600 12px var(--sans); color: #f5f5f7; text-shadow: 0 0 3px #0c0c10, 0 0 8px #0c0c10; }
.leaflet-tooltip.pin-label::before { display: none; }
.leaflet-interactive.paul { stroke: var(--nt); }
```

**Tooltip `#tip.tip`** — pro lines 587–593 (`.tip.on`, `.tt`, `.tm` with an `i.ot|nt` dot, `.tx` serif preview).

### 5.8 Menu, toast, dialogs

- **Menu** (pro lines 580–586 and 1513–1529): `<div class="menu" role="menu">` appended to `<body>`, positioned under the opener (flipped above if it would overflow), first item focused. ArrowUp/Down cycle; Esc or Tab closes and returns focus to the opener; outside pointerdown closes.
- **Toast** `#toast`: `<span class="toast-msg">…</span>[<button type="button" class="toast-act">Undo</button>]`. Restart the spring animation on each show; auto-hide after 4.2s (6s with an action) by adding `.out` and then `hidden` after 300ms.
- **Dialogs** (`dialog.modal`, pro lines 602–654): open with `showModal()`; close via `closeDialog(d)` which adds `.closing`, then `d.close()` after 180ms (0 under reduced motion). Intercept the `cancel` event (Esc) to animate. Close on backdrop click (`e.target === d`) and on `[data-close]`. CSS `.modal-form { display: contents; }`.
- **Picker content** (main.js):
```html
<!-- #picker-books -->
<section class="pcol"><h3>Old Testament</h3>
  <div class="pgroup"><h4><i class="ot"></i>Pentateuch</h4><div class="pbooks"><button class="pbook[ on]" type="button" data-b="1" data-name="genesis">Genesis</button>…</div></div>…</section>
<section class="pcol"><h3>New Testament</h3> … <i class="nt"></i> …</section>
<!-- #picker-chapters -->
<h3 class="pc-title">John</h3><p class="pc-sub">21 chapters · Gospels</p>
<div class="chgrid"><button class="pch[ hot][ cur][ noted]" type="button" data-b="43" data-c="3" style="--h:.87" title="36 verses · 658 links" aria-label="Chapter 3, 36 verses, 658 links[, has notes]">3</button>…</div>
<div class="heat-legend" aria-hidden="true"><span>Fewer links</span><i></i><span>More</span></div>
```
  `--h = sqrt(links / maxLinksInBook)`, `.hot` when `--h > .55`. The filter hides non-matching books and empty groups and shows the first match's chapters; Enter focuses the first `.pch`. On open, focus the current book button.
- **Settings**: theme radios set `html[data-theme]` immediately (remove the attribute for `auto`) and move the thumb; `#fontsize` sets inline `--read-size` and the range fill `--p`. Save: if a key was entered, `PUT /api/config` (**skipped in dry-run**), then clear the fields and close. Placeholders: `Saved. Paste a new key to replace.` when configured, else `Paste key`.

---

## 6. Drawer (sheet) state machine

### 6.1 State

`state.drawerOpen` (default **false**), `state.sheetFull` (phone only, default false), derived `mode ∈ {side, overlay, sheet}` (§3.2).

**On load:** the sheet is **closed**. If the URL hash contains a verse, that verse is selected (aria-current, capsule, scrolled to centre instantly) and the sheet **opens automatically only in side mode (≥1100px)**, on the Links tab. In overlay and phone modes it stays closed until the user clicks, so the text is never covered or dimmed on arrival.

### 6.2 DOM reflection: `syncDrawer()` (main.js, called on every change and on resize)

| Condition | DOM |
|---|---|
| open | `#drawer.open`; `#drawer.inert = false`; `aria-hidden="false"`; `body.drawer-open`; `#btn-drawer[aria-expanded="true"]` |
| closed | `.open` removed; `inert = true`; `aria-hidden="true"`; `--drag` removed; `.full` removed; `state.sheetFull = false` |
| mode | `body.mode-side` / `body.mode-overlay` / `body.mode-sheet` (exactly one) |
| phone full | `#drawer.full` ⇔ open && mode=sheet && sheetFull; `#grabber[aria-label]` = "Collapse study sheet" when full, else "Expand study sheet" |
| **modal** ⇔ open && (mode=overlay \|\| (mode=sheet && sheetFull)) | `body.sheet-modal` (scrim visible, body overflow hidden); `#drawer[aria-modal="true"]`; `#page.inert = true`; `#topbar.inert = true` |
| not modal | `aria-modal="false"`; `#page.inert = false`; `#topbar.inert = false` |

In side mode the page is pushed (CSS: padding-right animates 560ms). At the phone medium detent (64dvh) the page above the sheet stays **interactive and un-dimmed**: you can tap another verse and the sheet follows.

### 6.3 Transitions

| Trigger | Effect |
|---|---|
| Click or tap a verse (not on `.xc`/`.iw`; ignore when the user has selected more than 2 characters of text) | `A.select(v, {open:false})`: selects only; a closed sheet stays closed (Ji, 2026-10-07), an open one follows (tab unchanged unless it was Search → Links) |
| Enter / Space on a focused `.verse` | `A.select(v)` → opens the study panel (Help: “Open the focused verse in the study panel”) |
| `.xc` click | `A.select(v, {tab:'xref'})` |
| `.iw` click | `A.select(v, {tab:'orig', word:i})` |
| Hero chip | `A.openTab(tab, {intro})`; the links chip with no verse → Links (most-linked) |
| Double-click a verse, or `n` | `A.select(v, {tab:'notes', focus:true})` (write mode, textarea focused). `n` with no verse → Notes for the chapter note in write mode |
| `j` / `k`, `#verse-next` / `#verse-prev` | `A.stepVerse(±1)`: selects the neighbour and moves keyboard focus to it (the header buttons keep focus). **Does not open a closed sheet**; if open, content follows |
| `#btn-drawer` | toggle; opening with no verse shows the chapter overview of the current tab |
| `#drawer-close`, Esc (see §7.3), scrim click | close |
| Phone drag on `#grabber` or `#sheet-top` (not starting on a button, tab, input or link) | follow the finger: `--drag = max(-40, dy)px`, `.dragging`. On release, with `v = dy/dt` (px/ms): if `dy > 120 \|\| v > 0.7` → full ? collapse to medium (`sheetFull=false`) : close; else if `dy < -40 \|\| v < -0.7` → `sheetFull = true`; else spring back (remove `--drag`) |
| `#grabber` click / Enter | toggle `sheetFull` |
| `[data-go]` / `.vlink` / outline row inside the sheet | navigate; overlay mode → close the sheet; phone → `sheetFull=false` (stay open); side → stay |
| Search submit | open the Search tab; phone → `sheetFull = true` |
| Resize across breakpoints | recompute mode; entering sheet mode sets `sheetFull=false`; re-sync |
| Chapter navigation | sheet keeps its state; content re-renders |

### 6.4 Focus management

- Opening in **side** mode: focus stays where it was (the verse). The sheet follows the page in DOM order, so it is reachable by Tab.
- Opening in **overlay** or **sheet** mode: remember `lastFocus = document.activeElement`, then after 60ms focus `#drawer-title` (tabindex −1), unless `opts.focus` asks for the note textarea (focus that instead).
- Closing: if focus is inside `#drawer` or on `<body>`, focus `#v{selected}` (preventScroll) if it exists, else `lastFocus`.
- Tablist: roving tabindex; ArrowLeft/Right/Home/End move and activate (`openTab`) and call `e.stopPropagation()`. The global handler also ignores ←/→ whenever `e.target.closest('#drawer')`.
- Segmented radiogroups (`#xfilter`, `#md-mode`, `#theme`): arrow keys move the checked item (roving tabindex).

### 6.5 ensureVisible(verseEl) (reader.js export, used by select, j/k, flash)

```
topLimit    = max(0, #topbar.getBoundingClientRect().bottom) + 12
bottomLimit = (mode==='sheet' && drawerOpen) ? #drawer.getBoundingClientRect().top - 12 : innerHeight - 16
if rect.top < topLimit || rect.bottom > bottomLimit:
   target = (mode==='sheet' && drawerOpen) ? rect.top - topLimit - 8         // park just under the bar, above the sheet
                                           : rect.top - (topLimit + bottomLimit)/2 + min(rect.height, bottomLimit-topLimit)/2
   window.scrollBy({ top: target, behavior: reducedMotion ? 'auto' : 'smooth' })
```
Call it after selection and again 580ms after the sheet opens or closes in side mode (the reflow moves text), and after the phone sheet changes detent.

---

## 7. Other behaviour (builder B)

### 7.1 The action object `A` (main.js; passed to reader, drawer and viz via `init(A)`)

Keep every current member and add the new ones. Signatures:
`navigate(b,c,v=0,{noHistory,panel})`, `step(dir)`, `select(v,{tab,word,expand,focus,open=true})`, `stepVerse(dir)`, `refreshSelection()`, `openTab(tab,{intro,strong,focus,dx})`, `openDrawer(opts)`, `closeDrawer()`, `toggleDrawer(on?)`, `showPanel(p, force=false)`, `refreshMarker(v)`, `flash(list)`, `rerender()`, `goReference(text)`, `openSettings()`, `search(q)`, `showTopic(name)`, `toast(msg, action?)`, `ensureVisible(v)`.

- `select()` updates the selection (reader.updateSelection: `aria-current`, roving tabindex, capsule), calls `viz.markSelection()`, updates `#cur-ref-text` ("John 3:16"), the title and the hash; opens the sheet unless `open:false`; re-renders the drawer; re-renders the stage when the panel is `graph`; and calls `ensureVisible`. `expand:"b.c.v"` makes the Links tab expand and scroll to that row after render (pro line 1480).
- `navigate()` pushes history (max 200), clears `origFocus`/expand, renders the reader (window.scrollTo top if no verse, else centre the verse instantly), drawer, stage, bar and hash. A `panel` option opens that panel and scrolls to the top.
- `showPanel(p, force)`: toggles (or forces) `state.panel`; `renderPanel()`: toggle `#panel.open`, `inert`, `aria-hidden`, `body.panel-open`, and `[data-panel-btn][aria-pressed]`; call `viz.stopPanel()` then `viz.renderArcs|renderGraph|renderMap(#stage)`. On close, clear `#stage` 560ms later if still closed. When opening a panel and the stage is above the viewport, `window.scrollTo({top:0})` (smooth unless reduced motion).
- `openTab`: `dx = ±18` in the direction of travel through `['xref','context','orig','notes','media','search']`.

### 7.2 Rendering rules

- `renderDrawer(opts)` shows the skeleton only after 90ms; ignores superseded renders via a token; wraps output in `.view` (`push`/`pop` classes for Strong's); keeps scroll if `keepScroll`; toggles `#drawer.scrolled` on body scroll > 2px; after render, places segmented thumbs with `.no-anim` for one frame (§8).
- `moveInd(seg)`: thumb `width = active.offsetWidth`, `transform = translateX(active.offsetLeft)`. Call it on tab change and via a `ResizeObserver` on each segmented control. When the sheet opens, add `.no-anim` to `#drawer-tabs`, place the thumb, and remove the class after 50ms.
- Search (main.js): Strong's pattern `^[HG]\s?0*\d{1,4}$` → Original tab Strong's view; a reference containing a digit → navigate (and select the verse); otherwise topics and full text over the bundled translation (KJV or BSB) as today (max 400 hits, show 200, exact phrase first).
- Translations: `external` → open the chapter (EXTERNAL map, current code) in a new tab, revert the select, toast "`NIV` has no free API, so this chapter opened on BibleGateway in a new tab."; `api` without a configured key (`state.apiKeys[id]` false) → revert the select and set `state.notice` (key card); `api` with a key → switch, and show any fetch error as `.notice.error`. Persist `bs-tr`/`bs-tr2` in localStorage (not in dry-run).
- Reading size: CSS defaults (20px, or 19px under 700px) apply unless the user has set a size. At boot, set inline `--read-size` **only if** `localStorage['bs-font']` exists (fixes pro's bug where the phone size never applied). The settings slider shows the current computed size.
- Theme: `applyTheme('auto')` removes `data-theme`; light and dark set it. Persist `bs-theme` (not in dry-run).
- Save status (store.js `setSaveStatus`): `Saving…`; then `ICON(check)Saved` and add `.idle` after 2.6s; `ICON(info)Save failed` with `.warn`, which stays; dry-run: `ICON(check)Saved (dry run)`.
- Hash: `#b/c[/v]` via `history.replaceState`; the `hashchange` listener re-renders on external change.
- Top bar on scroll (rAF-throttled): `.flat` when `scrollY ≤ 8`; `#progress` scale; phone hide/show (pro line 1768).

### 7.3 Keyboard (document keydown)

Ignore when: target is `input`, `textarea` or `select` (except Esc, which blurs and removes `.searching`); any modifier (meta/ctrl/alt); a `dialog[open]` exists; a menu is open.

| Key | Action |
|---|---|
| `←` / `[` , `→` / `]` | `A.step(∓1)`; **ignored if `e.target.closest('#drawer')`** |
| `j` / `k` | `A.stepVerse(+1 / −1)` and focus the verse |
| `↓` / `↑` **on a focused `.verse`** | move focus to the next or previous verse (roving; `ensureVisible`, nearest); `preventDefault`. **Not handled when focus is elsewhere** (normal page scrolling is kept) |
| Enter / Space on a focused `.verse` | `A.select(v)` |
| `/` | remove `.hide`; phone/tablet: add `.searching`; focus `#search` |
| `o` | toggle the interlinear |
| `a` / `g` / `m` | toggle a panel |
| `n` | notes in write mode |
| `?` | help dialog |
| Esc | if the sheet is open and (focus is inside `#drawer` or the mode is not side) → close the sheet; else if a panel is open → close the panel; else if the sheet is open → close the sheet |

### 7.4 A11y checklist (B emits; A styles focus)

Skip link to `#reader`; every icon-only button has `aria-label` and `title`; the sheet is `role=dialog` with `aria-labelledby`, `inert` when closed and `aria-modal` per §6.2; tablist/tab/tabpanel; radiogroups for filter, theme, mode and swatches; dialogs are `aria-labelledby`; the toast is `role=status aria-live=polite`; SVGs and canvases carry `role=img` and an `aria-label` (the Links list is their table view); original-language text carries `lang="grc"|"he"` and `dir`; visible focus is `:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px }` (verses use a 2px box-shadow ring).

---

## 8. Motion

| What | Spec |
|---|---|
| Sheet open (side/overlay) | `transform: translate3d(calc(100% + 28px),0,0)` → `0` over **560ms `--ease`**; close 420ms, `visibility` switched at the end |
| Page push (side mode) | `padding-right` 0 → `calc(var(--sheet-w) + 24px)` over 560ms `--ease` (close 420ms). The hero arcs stretch with non-scaling strokes and viz redraws them crisply 200ms after the last resize |
| Phone sheet | rises from `translate3d(0, calc(100% + 24px), 0)`; detent height change 500ms `--ease`; drag follows the finger (`transition: none`) |
| Scrim | opacity 0 → 1 over 450ms `--ease` |
| Stage | `grid-template-rows 0fr↔1fr` 550ms `--ease` + opacity 350ms `--ease-out` |
| Segmented thumb | `transform` and `width` 500ms `--spring`; `.no-anim` for first placement; separators beside the selection fade over 250ms |
| Tab content | `.view` `viewIn` 380ms `--ease-out` from `translate3d(var(--dx),6px,0)` and opacity 0 |
| Strong's push/pop | `pushIn` from 60% right / `popIn` from −30%, 500ms `--ease` |
| Row expand | `grid-template-rows 0fr→1fr` 500ms `--ease`; `.expand-in` opacity + translateY(−4px) over 350/450ms; chevron rotates 90° in 450ms `--ease` |
| Vote bars | `scaleX(0)→1` 800ms `--ease-out`, 30ms stagger per row (up to 12) |
| Hero entrance | children `rise` 14px + fade, 900ms `--ease-out`, delays 0/60/120/170/220/280ms; only on chapter change |
| Hero arcs | `stroke-dashoffset 1→0` over 1.3s `--ease-out`, delay `60 + 900·dx/W` ms (short arcs first); only on chapter change |
| Selection | verse background 300ms; `.vnum span` capsule `pop` 500ms `--spring`; arcs dim or raise 350ms |
| Flash | `.flash` accent-tint-2 → transparent over 2.2s `--ease-io` |
| Buttons | `.ib:active scale(.92)`; `.chip`, `.btn`, `.toggle`, `.pill-tog :active scale(.96)`; swatches hover 1.08 / active .92 on `--spring`; `.strong:active scale(.94)`; footer arrows nudge 3px; video play button scales 1.12 on hover |
| Fields | focus: fill → `--bg-elev` + inset accent hairline + 3–4px accent-tint ring (250ms); invalid: red ring + `shake` 400ms |
| Menu | `menuIn` scale .9→1, 320ms `--spring`, origin top right |
| Dialog | `dlgIn` scale .94 + 8px → 1, 500ms `--spring`; out 180ms (`.closing`); backdrop fade 300ms |
| Toast | `toastIn` 24px up + scale .96, 500ms `--spring`; `.out` fades 12px down over 300ms |
| Top bar (phone) | hide/show `translateY(-100%)` 450ms `--ease` |
| Stage canvas | arcs draw-in 1.3s (JS, same delay rule); graph edges draw in and nodes pop with a 35ms stagger (JS); min-votes slider redraws live without animation |

**Reduced motion** (`@media (prefers-reduced-motion: reduce)` in CSS, `matchMedia` in JS): every animation and transition drops to 0.01ms (pro lines 737–741), plus `.drawer, .drawer.open { transition: opacity .2s linear, visibility 0s !important } .drawer:not(.open) { opacity: 0 }`; `.page { transition: none }`; viz draws arcs, graph and timeline without animation; every `scrollIntoView`/`scrollBy` uses `behavior:'auto'`; segmented thumbs jump.

**Forced colors:** `.verse[aria-current="true"] { outline: 2px solid Highlight }`, `.seg-ind { border: 2px solid Highlight }`, `.sw[aria-checked="true"] { outline: 2px solid Highlight }`, `.chip, .btn, .pill-select, .toggle, .pill-tog { border: 1px solid ButtonText }`.

---

## 9. Visualisation (builder C, `viz.js`)

### 9.1 Imports and exports (exact)

```js
import { state, data, bookOf, refLabel, esc, previewText, yearLabel } from './store.js';
import { icon } from './icons.js';

export function init(actions)                                   // store A
export function renderSignature(host, { animate = false } = {}) // host = #sig-arcs; uses state.book/chapter/selected
export function redrawSignature()                               // redraw the current host without animation
export function markSelection()                                 // selection changed: hero strip + stage arcs + #sig-cap
export async function renderArcs(stage)                         // stage = #stage
export async function renderGraph(stage)
export async function renderMap(stage)
export function stopPanel()                                     // cancel rAF, observers, Leaflet instance, hide tip
export const stopGraph = stopPanel;                             // back-compat alias
export async function renderTimeline(host, { era, written, eventIds, markLabel })  // host = #timeline
export function renderCanonStrip(host, list, { onPick })        // host = #canon-mini; list = xref rows [[b,c,v,vend,votes],…] in Links order
export const miniMap = { async mount(el), focus(placeId) }      // el = #mini-map
export function refreshTheme()                                  // redraw anything theme-dependent (safe no-op if nothing open)
export const tip = { show(x, y, html), hide() }                 // wraps #tip; B may use it
```
Store exports used by viz must keep their current signatures (B must not rename them). A (the actions object) members viz may call: `A.select`, `A.navigate`, `A.flash`.

### 9.2 Reading tokens and fonts

- `const tok = (el, name) => getComputedStyle(el).getPropertyValue(name).trim();`
- **Stage canvases read tokens from the `#stage` element** (night scope), never from `documentElement`: `--ot --nt --viz-ink --label --label-2 --label-3 --label-4 --sep --accent --stage-surface`.
- The hero, canon strip, timeline and mini-map are SVG styled by CSS classes (§5.4, §5.7), so no token reads are needed.
- Fonts: `const SANS = tok(document.documentElement, '--sans')`. Canvas fonts: `600 10px ${SANS}` (division labels, uppercase, +0.06em manual spacing optional), `700 11px ${SANS}` (current book), `500 11px ${SANS}` / `600 11px ${SANS}` (graph labels), `600 13px ${SANS}` (graph centre).
- DPR: `Math.min(2, devicePixelRatio || 1)`; size canvases from `clientWidth/clientHeight`.
- Reduced motion: `const RM = matchMedia('(prefers-reduced-motion: reduce)')`.
- Tooltip markup (#tip): `<div class="tt">John 3:16ICON(arrow-right)Romans 5:8</div><div class="tm"><i class="ot|nt"></i>New Testament · 984 votes</div>` shown immediately, then `<div class="tx">…preview (200 chars)…</div>` appended when `previewText` resolves (guard with a token). Position: 14px right, 16px below the pointer, clamped 8px inside the viewport; `.on` toggles visibility; set `aria-hidden` accordingly.

### 9.3 Shared canon geometry (port pro lines 1022–1035)

`canon(W, x0)` = 66 chapter-weighted segments (min 2px each); `xAt(segs,b,c,v)` = `((c−1) + (v ? (v−.5)/verses : .5)) / chapters` within the book segment; `chapterLinks(xr,c)` → `{v,b,c,tv,e,votes}`.

### 9.4 Hero signature strip (SVG, `#sig-arcs`) — port pro `drawArcs`/`bindArcs`/`markArcSel`/`pickLabels` (lines 1038–1086), with these changes

- Height: 140px (104px when `innerWidth < 700`); `base = H − 24`; arc height `ah = max(4, (base−8)·(dx/W)^0.62)`; quadratic control at `base − 2·ah`; t = √(votes/max); `--o = .12 + .74t`, `--w = .6 + 1.9t px`; sorted by votes ascending; class `ot` if the target book ≤ 39, else `nt`; path direction is source → target (so the draw-in grows out of the verse).
- `animate` → `.arcs.anim` with per-path `animation-delay` (only when not reduced motion).
- **Selection (graft 1):** `markSelection()` moves every `.arc[data-v="sel"]` into `<g class="arcs-sel">` (raised on top) with class `on`, and sets `.has-sel` on the host when the selected verse has links. Selected arcs keep their **OT/NT colour**; the accent is never used for arcs. When the selection clears, move them back and sort by votes. Caption `#sig-cap`: none → `Every link leaving John 3. Select an arc to study it.`; selected → `<b>23 links</b> from John 3:16 · 658 in the chapter` (0 links → `No links from John 3:16 · 658 in the chapter`).
- Hover: nearest arc within 9 units using 17 samples per arc → `.hovering`, `.hv-halo` (7px, `--arc-surface`) + `.hv` (2.5px, testament class); tooltip as §9.2. Over the canon bar: book tooltip (`name` / `N chapters · Division`).
- Click on an arc → `A.select(l.v, { tab: 'xref', expand: \`${l.b}.${l.c}.${l.tv}\` })`.
- Labels `.arc-labels`: `[current book, 1, 19, 23, 40, 66, 45, 44]` with collision skipping (pro `pickLabels`).
- A `ResizeObserver` on the host redraws without animation, **debounced 200ms trailing** (it stretches in between).

### 9.5 Stage: Arcs (canvas `#arcs`, night glass) — grafts 7 and 1

- Layout: `pad = 22` left/right, `top = 26`, `bottom = 44` (bar + labels); `base = h − 44`.
- **Canon bar:** one rounded rect per book at `y = base + 3`, height 6, radius 2, gap 1px. Fill = OT/NT colour. Opacity: current book 1; others alternate by division group (even groups .55, odd .38), so divisions read as bands. **Division labels:** group consecutive books by `test+div`; if the group width > 54px draw the uppercase division name (`Epistles` dropped, `Prophets` → `Proph.`) centred at `base + 22` in `600 10px`, `--label-3`. Current book name in `700 11px` `--label` at `base + 36`, centred under its segment and clamped inside the canvas.
- **Arcs:** semi-ellipses `ctx.ellipse(cx, base, rx, ry, 0, π, 2π)` with `cx=(xa+xb)/2`, `rx=max(.8,|xb−xa|/2)`, `ry = max(3, maxH·min(1, 2rx/maxSpan)^0.62)`, `maxH = base − top`. Stroke = `createLinearGradient` from the **source** testament colour (at xa) to the **target** testament colour (at xb). `globalCompositeOperation = 'lighter'` (additive glow; the stage is always dark). Width `.6 + 1.3t`, alpha `.10 + .5t`, t = √(votes/max). Draw sorted by votes ascending.
- **Selection:** arcs from the selected verse are drawn **last** (raised), alpha .95, width `1.4 + 1.6t`; every other arc alpha × .22. No accent colour.
- **Draw-in (not under reduced motion, only on first render for a chapter):** rAF over ~1.4s; per-arc progress `p = easeOutCubic(clamp((t − delay)/900ms))`, `delay = 60 + 900·(2rx/W)`. Sweep from the **source end**: if `xb ≥ xa` draw angles `π → π + π·p`; else `2π − π·p → 2π`.
- After the final frame, store a **snapshot** (offscreen canvas copy). Hover: `drawImage(snapshot)`, then the hovered arc with `source-over`: a 7px `--stage-surface` halo, then 2.5px in the target testament colour at alpha 1. Hit-test: 17 samples on the upper half-ellipse, within 9px.
- Click an arc → `A.navigate(l.b, l.c, l.tv)`. Hover or click on the canon bar → book tooltip / `A.navigate(b, 1, 0)`.
- `#arc-min`: `max = min(300, maxVotes)`; `input` → set `state.minVotes`, update `#arc-min-v` and the range fill `--p` (%), redraw without animation, re-snapshot.
- Header sub: `658 links leaving John 3` + ` · verse 16 highlighted` when selected + `. Click an arc to go there.`
- Canvas `aria-label`: `Arc diagram: 658 cross-references from John 3 to the rest of the Bible; 130 to the Old Testament and 528 to the New Testament.`
- `ResizeObserver` on `.stage-body` → redraw (no animation), rAF-coalesced.

### 9.6 Stage: Graph (canvas `#graph`) — graft 8 plus pro's label logic

- Centre verse = selected, else the most-linked verse in the chapter (the sub says so). First hop = top 18 links.
- Geometry: `cx = w/2`, `cy = h/2 + 4`, `RY = h·.40`, `RX = min(w/2 − 120, RY·2.2)` (never below 90).
- **Canonical angles:** OT on the **left** hemisphere, NT on the **right**, canonical order top → bottom. `before[b]` = chapters of the same testament before book b, `tot[test]` = total chapters. `f = (before[b] + c − .5)/tot[test]`; OT: `a = −π/2 − π(.04 + .92f)`; NT: `a = −π/2 + π(.04 + .92f)`.
- Radius factor by strength: `k = 1 − .52·t^0.7`, `t = votes/max`; position `(cx + cos(a)·RX·k, cy + sin(a)·RY·k)`.
- **Canon ring:** for each book, an ellipse arc at `RX+18, RY+18` from its first to last chapter angle (1px gap between books), stroke = OT/NT colour, lineCap round, width 4.5 and alpha 1 for the current book, else width 3 and alpha .42. Vote rings at k = .45/.72/1: dashed `[2,5]`, `rgba(255,255,255,.07)`, 1px. Side labels `OLD TESTAMENT` (right-aligned at `cx−RX−32`) and `NEW TESTAMENT` (left-aligned at `cx+RX+32`), `600 10px`, `--label-3`.
- **Edges** (`lighter`): quadratic from centre to node with a perpendicular offset of 0.18× the vector; gradient from the centre's testament colour to the node's; alpha `.2 + .6t`; width `.8 + 2t`.
- **Nodes:** `r = 4 + 10·√t`; a soft halo (radial gradient to transparent, radius 2.6r, alpha .35, `lighter`); a solid fill in the testament colour; a 2px `--stage-surface` ring (`source-over`).
- **Centre:** a 30px-radius circle filled `--viz-ink` (neutral ink, **not accent**) with a 3px `--stage-surface` ring; label `Jn 3:16` (`book.short c:v`) in `600 13px` `--stage-surface` colour, centred.
- **Labels** (top 16 by votes, plus the hovered node): `500 11px`, `--label-2`, `Rom 5:8` (`short c:v[–vend]`). Nodes with `|cos a| < .3` get labels centred above (top half) or below (bottom half); others are left or right of the node (`r + 7px`). Skip a label if a placed label is within 12px vertically and 60px horizontally.
- **Second hop** (`[data-hop]` toggle, `aria-pressed`; state kept in viz): for the top 8 first-hop nodes load `data.xref(book)` and take each one's top 4 links, excluding the centre and existing nodes. Place them at their canonical angle with `k = .92 + .08·rand(seeded by ref)`, `r = 2.5 + 2√t`, alpha .6, edges from the parent at .5px, alpha .25. Label on hover only. Click → `A.navigate(b,c,v)`.
- Animation (not under reduced motion): edges draw in (split the quadratic at progress p) and nodes pop with an overshoot (`easeOutBack` with s = .6) over 700ms each, staggered `120 + 35i` ms. Then snapshot for hover.
- Hover: tooltip (`tt` = ref, `tm` = testament dot + votes, then the preview). Click a first-hop node → `A.select(centreV, { tab: 'xref', expand: 'b.c.v' })` (opens that link's row). Click the centre → `A.select(centreV)`.
- No links → `.stage-empty` "No cross-references for this verse."
- Canvas `aria-label`: `Link graph for John 3:16: 18 strongest links, Old Testament on the left and New Testament on the right.`

### 9.7 Stage: Map (Leaflet in `#bigmap`) — graft 12

- `ensureLeaflet()` as today (cdnjs 1.9.4, CSS + JS, 6s timeout → false).
- Tiles: `L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 12, attribution: '© OpenStreetMap contributors © CARTO' })` (no modern labels; dark for the night stage). If 4 or more `tileerror` events happen before the first `load`, remove the map and render the SVG fallback.
- Points = chapter places with coordinates (`chapterPlaces()` as today, with `verses`). Markers: `L.divIcon({ className: '', html: '<span class="pin"></span>', iconSize: [18,18], iconAnchor: [9,9] })`, `keyboard: true`, `title: name`. **Every pin has a permanent label:** `marker.bindTooltip(name, { permanent: true, direction: 'right', offset: [8,0], className: 'pin-label' })`. Click a pin → `A.flash(p.verses)` and open a popup (`<b>Jerusalem</b> · City<br><span>Verses 1, 5</span>`).
- Bounds: one point → `setView([lat,lon], 8)`; otherwise `fitBounds(bounds.pad(.25), { maxZoom: 10, padding: [24,24] })`; `invalidateSize()` after 400ms (the stage is animating open).
- **Paul's journeys** (`[data-paul]` toggle, `aria-pressed`): `data.paul()` GeoJSON, lines `{ color: tok(stage,'--nt'), weight: 2, opacity: .85, className: 'paul' }`, points as `circleMarker` radius 4; popups with the place name and notes (as today); fit to the layer bounds.
- Fallback (Leaflet or tiles fail, or no internet): `mapSVG(points, W, H)` from §9.9 inside `#bigmap` (the stage's night tokens style it). No places → `.stage-empty` "No mapped places in this chapter." (still show the Paul toggle).
- `stopPanel()` must call `map.remove()`.

### 9.8 Timeline (SVG in `#timeline`) — port books `timelineSVG` (lines 1498–1524) with these changes

- `W = 388`, `H = 124` viewBox; responsive width, `height: auto`.
- ERAS = books line 1498. Top context bar (y 6, height 6): era rects alternating `.tl-e0/.tl-e1` over −2100…100; axis labels (`.tl-t`, y 26) `2000 BC, 1500 BC, 1000 BC, 500 BC, AD 1` except where they would collide with the window bracket.
- Window: anchor = era ?? written[0] ?? 0; if anchor > −200 the window is −40…110, else anchor ± 280; widen to include `written` if it adds less than 900 years. Bracket `.tl-win` (rounded rect on the top bar) and connectors `.tl-conn` down to the zoom band.
- Zoom band (y 40, height 26): era bands `.tl-band0/.tl-band1` with `.tl-band-l` labels where they fit; axis line `.tl-axis` at y 66.5 with ticks every 25/100/250 years (by span) and `.tl-t` labels at y 81.
- **Event ticks (NEW vs books):** every event whose year falls in the window is a `.tl-ev` line from y 60 to 66; events in `eventIds` are `.tl-ev.here` (y 56–66). Each tick carries `data-t` (title) and `data-y`; a transparent `.tl-hit` rect (6px wide) per tick shows the tooltip `<div class="tt">Title</div><div class="tm">AD 27</div>` on hover.
- Written bracket `.tl-wr` at y 60–66.5; chapter marker `.tl-mk-line` (y 40–66) + `.tl-mk` dot (r 4.5 at y 66.5).
- Labels (y 102 title, y 116 sub): `markLabel` (`This chapter` or `This verse`) + `c. AD 30`; `Written` + `c. AD 85–95`. **De-collide:** if both exist and are closer than 96px, push them apart symmetrically to 96px; clamp x to 40…W−40. All label text uses label tokens (`.tl-mk-l`, `.tl-mk-s`), never accent.
- `role="img"` with an `aria-label` such as `Timeline: this chapter c. AD 30; written c. AD 85–95`.

### 9.9 Mini-map (SVG, `#mini-map`) and SVG fallback — port books `LEVANT`, `smoothPath`, `mapSVG` (lines 1526–1581)

- `miniMap.mount(el)`: points = chapter places with coordinates; `W = el.clientWidth`, `H = 180`; `el.innerHTML = mapSVG(points, W, H)` with root `<svg class="lev" viewBox="0 0 W H" role="img" aria-label="Map of Jerusalem, Bethlehem…">`. Class names: `.sea .lake .coast .river .grat .region .water-l .pt .pt-l .ctx-pt .ctx-l` (styled in §5.7). Each `.pt` and `.pt-l` gets `data-id`. Water labels use `.water-l` text in label colour (not a data hue).
- No points → `el.innerHTML = '<div class="stage-empty">No mapped places in this passage.</div>'`.
- Click a `.pt` → `A.flash(verses)` for that place.
- `miniMap.focus(id)`: add `.hi` to that point and label (remove from others); animate the SVG `viewBox` over 500ms (easeOutCubic; instant under reduced motion) to a 2.2× zoom centred on the point, clamped to the original box. `focus(null)` animates back to the full box.
- The same `mapSVG` is the stage fallback (§9.7) at stage size.

### 9.10 Canon strip (Links tab) — port pro `drawCanonMini` (lines 1279–1286)

- `W = max(260, host.clientWidth)`, `H = 46`, `base = 30`; segments `.seg-b.ot|.nt[.cur]` (height 4); dots `.dot.ot|.nt` with `r = 2.5 + 3.5·√(votes/max)` at `cy = base − 4 − r`, drawn by votes ascending, each with `<title>Romans 5:8 · 984 votes</title>` and `data-i`; labels `Old Testament` (left) and `New Testament` (right) plus a tick at the NT boundary. SVG `role="img"` `aria-label="Where 23 links go: 1 in the Old Testament, 22 in the New Testament"`.
- Click a dot → `onPick(i)`. drawer.js: reset the filter to All if the row is hidden, expand the row if closed, and scroll it to centre.
- Redraw on host resize (ResizeObserver, rAF).

---

## 10. Builder task lists and acceptance criteria

### 10.A SHELL (index.html, styles.css)

Tasks
1. Write `index.html` exactly as §5.1 (no sprite; icons via `<use href="#i-…">`).
2. Rewrite `styles.css`: §1 tokens verbatim → pro CSS lines 101–745 as the base → apply every NEW/CHANGED block in §5.2–§5.8 and §8. Remove pro's selectors that are superseded (`body.drawer-open.overlay .scrim`, the `@media (min-width:1100px)` page padding, the `.leaflet-tile-pane` filters, `.sheet-title h2/p` → `#drawer-title/#drawer-sub`).
3. Order: tokens → base → top bar → stage → hero → reader → sheet → sheet content → viz SVG classes → menu/tip/toast → dialogs → Leaflet → responsive (1400, 1179, 899, 699) → hover:none → reduced motion → forced colors.
4. `[hidden] { display: none !important; }` stays.

Acceptance
- Both themes: every token in §1 resolves in `:root` (auto dark, `data-theme="dark"`, `data-theme="light"`); `.stage` shows night tokens in light mode.
- No horizontal scroll at 375px and 390px (`document.documentElement.scrollWidth === innerWidth`) with the sheet closed and open.
- Top bar: search is centred (±2px) at 1440px and 1280px; icon-only parallel/Original below 1180px; search icon below 900px; two rows below 700px.
- Every class and id in §5 has a rule where the spec gives one; no rule relies on the old class names (`.active` on tabs, `.on` on swatches, `.tog`, `.navgroup`, `.pbook.ot`).
- `:focus-visible` is a solid 2px accent ring; `.xc` at rest ≥ 3:1 against `--bg`.
- Reduced-motion and forced-colors blocks present as §8.
- No `@import`, no web fonts, no emoji or glyph icons in `content:` strings.

### 10.B APP-JS (main.js, reader.js, drawer.js, store.js, icons.js)

Tasks
1. `icons.js` (§4): `ICONS`, `icon()`, `mountIconSprite()` executed on import.
2. `store.js`: `drawerOpen: false`; add `sheetFull:false, minVotes:0, notice:null, xfilter:'all'`; dry-run (`DRY` export, `window.__DRY__`, no non-GET fetch, no localStorage writes for notes/theme/font/translations); `setSaveStatus` with icons and `.idle`/`.warn`. Keep every existing export and signature.
3. `reader.js`: hero (§5.3) incl. `data-div`, smart quotes, era track, monograms, caption; verses with roving tabindex, `role=list/listitem`, badges in `.vmeta`; interlinear buttons; footer; notice; exports `renderReader`, `updateSelection`, `refreshVerseMarker`, `flashVerses`, `ensureVisible`, `bindReader`, `init`. Window scrolling (no `#reader.scrollTop`).
4. `drawer.js`: `renderHead`, all tab templates (§5.5), skeleton after 90ms, `.view` transitions, Strong's push/pop, expand rows, canon strip call, timeline and mini-map calls, notes (md mode as UI state, token field, swatches radiogroup, import button), video (fallback art, inline validation, ⋯ menu with Undo), tab badges, segmented thumbs. Exports `init`, `renderDrawer`, `renderTabs`/`renderHead`, `setOrigFocus`, `setSearchResults`, `bindDrawer`, `renderMd`, `parseYouTube`.
5. `main.js`: boot order (icons → meta → notes+config → theme → hash → init modules → bind → render → auto-open rule §6.1 → idle warm caches); `A` (§7.1); drawer state machine (§6); panels; picker; search; settings dialog (radiogroup theme, font, keys); dialogs with animated close; keyboard (§7.3); top bar scroll (flat, progress, phone hide); search overlay; toast with action; resize → mode sync.

Acceptance (test at `/?dry#43/3/16` unless stated)
- Load `/#43/3` (no dry needed, read-only): the sheet is closed (`#drawer.inert === true`, `aria-hidden="true"`), no `body.drawer-open`.
- Load `/?dry#43/3/16` at 1440px: v16 selected, the sheet open on Links, `.page` padding-right = sheet-w + 24px, v16 not overlapped by the sheet. At 1024px: the sheet is closed on load; clicking v5 opens it with a scrim, `aria-modal="true"`, `#page.inert`, and focus on `#drawer-title`; scrim click closes it and focus returns to `#v5`. At 390px: the bottom sheet is 64dvh with no scrim, the tapped verse is parked above the sheet; grabber toggles 94dvh (scrim shown, modal); dragging down 150px from full → medium, again → closed.
- Esc and × close and return focus to the selected verse. ←/→ with focus on any element inside the sheet does not change chapter. ArrowDown on `<body>` scrolls the page (does not select). Exactly one verse has `tabindex="0"`.
- Tabs: arrows/Home/End move; the thumb matches the active tab's `offsetLeft/offsetWidth` on all tabs; `#cnt-xref` shows 23 for John 3:16; `#pip-notes` visible when the verse has a note.
- Every feature in the original checklist works (§11 of the brief is §12 here). No `alert()`/`confirm()`. No console errors. **Zero** non-GET requests in dry-run (check with `read_network_requests`).
- `python3 -c "import re,sys;[print(f,i+1,l.strip()[:80]) for f in sys.argv[1:] for i,l in enumerate(open(f)) if re.search('[←-⇿☀-➿\U0001f300-\U0001faff＋]',l)]" app/js/*.js` finds only kbd/help text, never an icon glyph (arrows inside `title="… (←)"` strings are fine).

### 10.C VIZ (viz.js)

Tasks
1. Exports exactly §9.1. Keep `ensureLeaflet` and `chapterPlaces` internal.
2. Hero signature (§9.4), stage arcs canvas (§9.5), graph canvas (§9.6), map (§9.7), timeline SVG (§9.8), mini-map SVG + fallback (§9.9), canon strip (§9.10), tooltip.
3. All stage colours read from `#stage`; no hard-coded OT/NT/accent hex values in viz.js (fallback constants allowed only if the token read returns an empty string).
4. Optional harness `app/mock/_harness-viz.html` that loads `../css/styles.css` and calls the exports with fake `A` actions (never mutating notes).

Acceptance
- John 3: the hero strip draws 658 arcs (or whatever `xo[3]` reports ± links without targets), animates only on chapter change, redraws crisply after the sheet opens; selecting v16 raises its arcs (in `.arcs-sel`) and the caption reads `<b>23 links</b> from John 3:16 · 658 in the chapter`.
- Stage arcs: gradient arcs with additive blending, division-banded canon bar with labels, draw-in ≤ 1.5s, hover highlight via snapshot (no full redraw per pointermove), the min-votes slider live.
- Graph: OT nodes left of centre and NT right (check `x < cx` for every OT node), no two labels overlapping (bounding boxes), centre node is ink not accent.
- Map: no modern-language labels visible (CARTO nolabels), every pin labelled, one-place chapters don't zoom past 8; Paul's journeys toggle works; offline → SVG fallback.
- Timeline: in John 3, markers "This chapter · c. AD 30" and "Written · c. AD 85–95" do not overlap and neither is jammed against the edge.
- Reduced motion: no draw-in, no pops, instant viewBox focus.
- No console errors; `stopPanel()` leaves no running rAF (check with a counter).

---

## 11. Grafts from the runner-up mockups

| # | Graft | Decision |
|---|---|---|
| 1 | Separate selection from category colour | **Adopted.** NT moved to validated teal (`#11998e` / `#1fa99b`); the accent is never a data hue; the selected verse's arcs keep their testament colour and are raised on top; the graph centre is ink; the caption updates (books). |
| 2 | Books' focus+context timeline | **Adopted** (§9.8), plus event ticks and de-collided labels. |
| 3 | Books' reading surface (old-style margin numbers, gutter rule, smart quotes, drop cap) | **Partly.** Smart quotes adopted. Old-style numbers, the gutter rule and the drop cap were rejected: the brief now asks for modern graphic design, the sans capsule scans better during j/k (reading lens), and the drop cap hides verse 1's number and misaligns with fallback serifs. |
| 4 | Progress line, material-on-scroll bar, compact mode | **Adopted** the 2px progress line and the flat-at-top bar; **rejected** the compact mode that hides controls (interaction lens: it hides focused controls). |
| 5 | Phone detents 64dvh / 94dvh + ensureVisible | **Adopted** (§6), with pro's velocity flick; no scrim at the medium detent (reading lens graft 9). |
| 6 | Sheet header kicker, prev/next verse, tab badges, index numerals, mono morph chips, skeleton after 90ms | **All adopted.** |
| 7 | Night-glass stage: gradient arcs, additive glow, division canon bar | **Adopted** as a dark stage tile in both themes; the canon bar uses OT/NT hues banded by division (the palette rule keeps OT/NT as the only categorical hues). |
| 8 | Canonical graph (OT left, NT right, canon ring) | **Adopted** with pro's label rules; the current app's "second hop" option is preserved inside it. |
| 9 | Per-division numeral gradient | **Adopted** for the numeral only; the eyebrow dot stays a testament mark. |
| 10 | Era-track dot and monograms in chips | **Adopted**, shown only when data exists. |
| 11 | Floating bottom dock on phones | **Rejected.** `.gnav-right` would have to escape the frosted header (backdrop-filter creates a containing block for fixed children) or be duplicated, which breaks DOM order and ids; the two-row bar already hides on scroll. |
| 12 | Map: keep Leaflet, label pins, tighter bounds, mute modern labels; stylised Levant SVG as the mini-map and fallback | **Adopted** (CARTO `dark_nolabels`, permanent pin labels, maxZoom 10). |
| 13 | Warm gradient art when there is no YouTube thumbnail | **Adopted.** |
| a | Sheet focus management (role=dialog, aria-modal by mode, focus title, restore) | **Adopted**, plus `inert` page and top bar while modal. |
| b | Roving tabindex, no ArrowUp/Down hijack | **Adopted.** |
| d | Page shift with a transform instead of padding-right | **Rejected.** A transform cannot shrink the measure between 1100 and ~1266px, where the reading lens wants the text pushed rather than overlaid; padding-right is kept, and viz debounces its redraw. |
| e/f/g | Tab badges; solid focus ring; `.xc` at label-3; skeleton after 90ms | **Adopted.** |
| i | Phone "reader recedes" scale effect | **Rejected.** With window scrolling the transform origin would need per-scroll maths, and it shrinks the text band the user is studying. |
| j | DOM order = visual order | **Adopted** (no CSS `order`, no `display: contents` in the toolbar). |
| — | Pro's phone reading-size bug, 34/40px phone gutters, badges wrapping under long verses, straight quotes | **Fixed** (§5.3, §7.2). |

---

## 12. Integration checklist (after all three builders finish)

Top bar: picker (division groups, heat-shaded chapters, notes dots, filter) · prev/next · back/forward · search (`rom 8:28`, `love`, `G26`, a topic name) · primary and parallel selects (KJV, BSB; ESV/NLT key flow; NIV/NKJV/LSB open a site) · Original toggle · Arcs/Graph/Map · drawer toggle · settings (keys, theme, reading size) · help · toast · save status.
Reader: hero (eyebrow, numeral gradient, tagline, author line with curly quotes, chips incl. era track and monograms, signature arcs with legend and live caption) · verses (numbers, highlights, badges, `.xc`, parallel with sticky heads, interlinear) · footer tiles · copyright lines · notice card.
Sheet: Links (quote, canon strip, filter, ranked rows with index numerals and vote bars, previews, expand with Open/Graph/Add to note, topics citing, legend) · Context (stats, timeline, events flash, people with dictionary More/Less and Find, places with mini-map focus, About card with outline "You are here") · Original (word buttons, word table with grammar, code chip, variant pill, Strong's → definition, distribution, occurrences, Show more) · Notes (swatches, Write/Preview, tags, chapter list, all-notes filter, export Obsidian/JSON, import) · Video (add with validation, groups, thumbnails or art, inline player, ⋯ menu, Undo) · Search results.
Keyboard: ←/→ [ ] · j/k · ↑/↓ on a focused verse · Enter · / · o · a/g/m · n · ? · Esc. Hash routing `#book/chapter/verse`.
Modes: 1440 side push · 1024 overlay with scrim and focus · 390 bottom sheet with detents. Light and dark. Reduced motion. No console errors. No non-GET requests in dry-run.
