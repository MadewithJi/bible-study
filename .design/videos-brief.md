# Study videos in the margin: brief

Requested by Ji on 2026-10-05:

> For the building of the temple, add a link off to the side of the text: an icon people can click to expand into view as a modal that shows the video in the app. Put it in the right location in the Bible.

## Videos and where they go

| id | YouTube id | Label (shown in the modal and on the icon's name) | Primary verse | Also at |
|---|---|---|---|---|
| tabernacle | `MMEQ-WlsWsc` | The Tabernacle Built in the Time of Moses | Exodus 25:8 ("let them make me a sanctuary"; the tabernacle instructions begin) | Exodus 40:17 (the tabernacle is reared up) |
| solomon | `Xt6lQAe8ues` | Solomon’s Temple Explained | 1 Kings 6:1 (Solomon begins to build the house of the LORD) | 2 Chronicles 3:1 (the parallel account) |
| herod | `QQQyNVw8Pf4` | Jerusalem Temple at the Time of Jesus | Mark 13:1 ("see what manner of stones and what buildings are here") | Matthew 24:1, Luke 21:5, John 2:20 ("forty and six years was this temple in building") |

- Ji's share link for the first video carried a `?si=…` tracking parameter. Drop it.
- Fetch each video's real title once, from `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=<id>&format=json`, to confirm the id plays and the label fits. Keep Ji's labels above unless the real title is clearly better.
- Keep the list as data, not code, so more videos can be added later by editing one file: `app/data/media.json`, e.g. `{"videos":[{"id","yt","title","at":[[b,c,v],…],"note"?}]}` with the primary verse first.

## Margin icon

- **Where:** off to the side of the verse text, in the same margin column as the Doré verse badges and bookmark badges (`.badges`). It must sit cleanly next to them. Leave room for the coming My links badge (the "My links" stages, see `.design/linkstest/PROGRESS.md`).
- **What:** a small play icon (`icons.js` `play-rect`), tinted like the other badges, with:
  - an accessible name: "Watch video: <label>";
  - a tooltip with the label.
  - Hover or focus may show the label, as the Doré badge preview does.
- **When:** on every translation and layout (single and parallel columns, phone), and only on the verses listed in `media.json`.
- **Never in the chapter hero.** The hero must not change.

## Modal player

- **Container:** a `<dialog>`, opened with `ui.js` `showDialog` and closed with `closeDialog`, so batch 3's toast/resume hosting (`main.js` placeFloats) keeps working.
- **Contents:**
  - the label as its title;
  - the passage it belongs to (e.g. "Exodus 25:8");
  - a 16:9 responsive player;
  - a Close button.
- **Player:**
  - Use `https://www.youtube-nocookie.com/embed/<id>?autoplay=1&rel=0`, as the drawer's Video tab does.
  - Don't autoplay under reduced motion.
  - Set the iframe's `title`.
- **Closing:**
  - Esc, the Close button and a click on the backdrop close it. Batch 3's backdrop rule applies: a drag that starts inside doesn't close it.
  - Closing stops playback (remove the iframe or its `src`).
  - Focus returns to the icon that opened it.
- **Sizing:**
  - Desktop: a centred card up to about 960px wide.
  - Phone portrait: full width.
  - Landscape phone: the video as large as fits.
- **Appearance:**
  - Light and dark.
  - Forced colours get an edge.
  - Same look as the app's other dialogs (glass, radius, the Apple style).
- **One video at a time.** If the drawer's own video player (the Now-playing bar) is playing, pause or close it when the modal opens, and the modal's player stops on close.
- **Offline or blocked:** if the iframe can't load, show a short message with a link that opens the video on YouTube in a new tab.

## Checks

- jsc on touched JS.
- On 8765 `?dry`:
  - Each of the 9 verses shows the icon, in KJV and BSB.
  - No other verse shows one.
  - The modal opens and closes by mouse and keyboard, and focus returns to the icon.
  - It works at 1440, 820 and 390, in light and dark.
  - Doré badges and bookmark badges on the same verses still line up.
  - No console errors.
- Hero check: hashes and rectangles match `.design/linkstest/hero-baseline.json` (see the HERO_SNAP function in `.design/workflows/feature-stage.js`).
