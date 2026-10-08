# Home page: three design directions to compare (mock-ups)

Ji asked (2026-10-07) for a home page and approved the proposal:
- **One home page that adapts** to who is looking.
- **Mock up 2–3 directions first** so Ji can compare them, then build the chosen one in reviewed stages.

This stage builds **mock-ups only**: three static pages under `app/mock/`. Nothing in the real app changes. serve.py serves `app/mock/` only with `--dev`.

**The name is Bible Lantern.** Ji owns the domain **biblelantern.com**. The motif is Psalm 119:105: "Thy word is a lamp unto my feet, and a light unto my path." Bring in the idea of the Word as light on our path **subtly**, never as a theme-park lantern. Ideas:
- A warm, very soft glow of light behind the verse of the day or the hero, like lamplight on a page.
- A small refined lantern or flame mark next to the wordmark, as a monoline icon matching the app's icon set.
- A faint path or trail that leads the eye down the page.
- Light falling across a Doré engraving (direction C).
- Warmth that the light and dark themes carry. In dark mode, the lamp glowing in the dark should feel natural.

Keep the app's Apple-style restraint and its existing accent colour. The warmth should be an accent, not a new brand palette. Put the wordmark "Bible Lantern" and the Psalm 119:105 line in one easy-to-change place per file. Psalm 119:105 is the guest hero's line, in the KJV. Luke 24:27 is no longer used.

## The two states every mock shows

Each mock has a small state switch fixed at the corner: "Signed in" / "Guest". Use `?state=guest`, and default to signed in. Add a light/dark toggle that also follows the system.

**Signed in: "Today".**
- **Search** field: "John 3:16, love, G26".
- **Continue reading:**
  - the passage, e.g. John 3, verse 16;
  - that chapter's progress;
  - a Resume button.
- **Verse of the day:**
  - large type and the reference;
  - a Doré engraving when the verse has one;
  - tapping it opens the verse.
- **Your study, recently:** the latest notes, highlights and links, each with its verse. Add the reading streak and "N chapters this week".
- **The whole Bible at a glance:**
  - the 66 books in their divisions (Law, History, Wisdom, Prophets, Gospels, Letters, Revelation);
  - each shaded by how much has been read;
  - tapping a book shows its chapters (a simple inline grid is enough in a mock).

**Guest (an invited friend or a visitor to the hosted site).**
- **Hero:** the Bible Lantern wordmark, the Psalm 119:105 line, **Start reading** (John 1) and **Sign in / I have an invite**.
- **Four tiles with real previews** of what's distinctive, not icons:
  - the cross-reference arcs;
  - the context map and timeline;
  - Hebrew and Greek word by word;
  - the Doré engravings.
- **The same book map**, so anyone can start reading.

## The three directions (one designer each, one file each)

| File | Direction |
|---|---|
| `app/mock/home-a.html` | **A. Quiet and devotional.** Generous white space, one centred column, serif-led. The verse of the day is the centrepiece. Calm, almost no chrome, soft motion. |
| `app/mock/home-b.html` | **B. Dashboard.** A responsive card grid (Apple Health or Fitness summary feel), with Continue, Verse, Recent study, Streak/stats and the book map as cards. Dense but tidy, easy to scan. |
| `app/mock/home-c.html` | **C. Editorial with Doré.** A full-bleed engraving hero with the verse set over it. Magazine-like sections and a strong typographic hierarchy. Dark-leaning and dramatic, but readable in light too. |

## Rules for all three

- **Look and feel.** Same design language as the app (`.design/spec.md`):
  - link `../css/styles.css` and use its tokens: `--bg`, `--label`, `--accent`, `--serif`, `--sans`, the radii and shadows;
  - its light and dark themes, Apple-style quality.
  - Page-specific CSS goes inline in the file.
- **Real data where it exists:**
  - book names and chapter counts from `../data/meta.json`;
  - verse text from `../data/bibles/kjv/NN.json`;
  - Doré plates and images from `../data/art.json` and `../data/art/…` (check `app/js/art.js` for the image path pattern);
  - previews can be screenshots-in-code: a small SVG of arcs drawn from `../data/xref/NN.json` counts, a static map tile or SVG, interlinear chips from `../data/orig/NN.json`.
  - Personal parts (Continue reading, recent notes, streak) use clearly plausible **sample** content. Mark them in a comment, not on screen.
- **Verse of the day.** Pick deterministically from a short curated list of well-known verses by day of year. Prefer verses that have a Doré plate for direction C.
- **No new dependencies.** Plain HTML, CSS and JS in one file, apart from the app's CSS and data. No external fonts.
- **Responsive and accessible:**
  - responsive at 1440, 820 and 390, with no horizontal scroll;
  - keyboard focus visible;
  - landmarks and headings;
  - images with alt text (the plate caption);
  - contrast ≥ 4.5:1 for text;
  - honours reduced motion.
- **Reverence.** Describe God, Christ and the Holy Spirit reverently. Copy is sentence case, curly quotes, British spelling, no exclamation marks.
- **Don't touch the real app.** Leave `index.html`, `app/js` and `app/css` alone. These are mocks.
- **Testing:** your own `python3 serve.py --dev --port 88xx --data-dir <tmp under .design/linkstest>`, opened at `/mock/home-x.html`. Never use port 8765, which is Ji's running app.
- **Visual check.** Look at your page in the browser at 1440 and at the mobile preset, in light and dark (screenshots in your own tab), and fix what looks off. The orchestrator takes the final screenshots for Ji.
