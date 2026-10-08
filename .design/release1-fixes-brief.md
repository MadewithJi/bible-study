# Release 1 fixes: backend/live QC findings + queued items

Source of truth for the QC findings: `.design/linkstest/live-qc-1.json` → `confirmed[]`. Each entry has title, where, repro, actual, expected, severity, kind, files and a precise fix. Read your items there **in full** before changing anything. Apply the verifier's fix unless you find a better root fix, and say so if you do.

Context:
- The home page (`app/js/home.js`, `app/css/home.css`, from `.design/home-build-brief.md`) and the warm off-white light theme (`app/css/styles.css`, `art.css`) were just built and reviewed. Keep their work.
- Hosted mode is specified in `.design/hosting-brief.md`.
- Production is www.biblelantern.com: Vercel serves the static files and rewrites `/api` to Railway. Never touch production.
- Test on your own `serve.py` (88xx, temp data dir, `BS_HOSTED=1 BS_TRUST_PROXY=1 BS_OWNER_EMAILS=owner-r1@example.test BS_ALLOWED_ORIGINS=https://www.biblelantern.com`), sending proxy-like headers. Use @example.test accounts only.

## Server group (serve.py, accounts.py, tests/test_server.py, vercel.json)

QC items:
- **0** (high): owner email change and claim.
- **1:** read the body only after the auth check for anonymous writes.
- **2:** the real client IP behind Vercel, e.g. Vercel's `x-vercel-forwarded-for` or `x-real-ip` when the request came through Vercel. Make sure it can't be spoofed on the direct Railway domain. Note anything that needs `vercel.json`.
- **3:** in hosted mode, refuse to start, or report unhealthy in `/api/health`, when `BS_DATA_DIR` isn't writable or isn't the volume.
- **4:** the server half of Delete profile. In hosted mode, purge or anonymise the profile's data instead of keeping it indefinitely, and update the README.
- **8:** the lockout-DoS: don't lock a known account for one wrong guess every 15 minutes. Use per-IP and per-account progressive limits that an attacker can't use to keep the owner out.
- **10:** HEAD on `/api/health`.
- **12:** log severity: stdout for info, stderr only for real errors.
- **13:** log the refused Origin.
- **14** (server half): JSON 413 handling within Vercel's proxy behaviour.
- **15** (server half): human wait-time wording, rounded to minutes.
- **9** (server half): hosted wording in serve.py messages. Say "this site" instead of "this computer", and no Terminal or serve.py hints when hosted.

Rules: add tests for each item, and all existing tests must pass.

## Front-end group (app/js/*.js except home.js internals, app/index.html, app/css/styles.css, app/robots.txt (new), README.md)

QC items:
- **4** (UI half);
- **6:** don't block the Bible text on a slow API, so the reader renders from static data first;
- **7:** an honest offline message, with no false "kept";
- **9** (JS half): hosted wording in account.js, library.js, drawer.js, art.js, store.js and main.js;
- **14** (client half);
- **15** (client half): local-date file names;
- **16:** meta description, Open Graph and Twitter cards with a Bible Lantern image (use The Creation of Light from `app/data/art`), canonical `https://www.biblelantern.com/`, PNG icons/apple-touch-icon generated from the lantern mark if feasible without new dependencies (otherwise SVG plus a note), `robots.txt`, and a `noindex` for the vercel.app alias via a `vercel.json` header keyed on host. Hand that header to the server group if `vercel.json` is theirs, through cross_file.
- **17:** README deploy section;
- **18:** the Sign in button on a 390px phone;
- **19:** hosted guests get the sign-in card in the Video tab;
- **20:** the sign-up password hint position.

Queued items from Ji:

**(a) Invite code at the top.** When sign-up needs an invite, the **Invite code** field is first and prominent, in its own box above Name, Email and Password:
- larger, letter-spaced, accepts `ABCDE-FGHJK`;
- hint "From the person who invited you";
- focused when the dialog opens from Home's "I have an invite" or in invite mode;
- errors shown right under it.

**(b) Home footer credits.** Append, after the KJV and Doré credit line: "Visualization inspired by Chris Harrison & Christoph Römhild (2007)." linking to https://www.chrisharrison.net/index.php/Visualizations/BibleViz, and "Cross-reference data: OpenBible.info." linking to https://www.openbible.info/labs/cross-references/.
- Keep Ji's exact wording, including "Visualization".
- The credit line lives in `app/js/home.js` (the footer). Edit only that line there.

**(c) Theme colour.** `index.html` light `theme-color` meta = the new light page colour from `styles.css` `--bg`.

**(d) Hosted wording.** The `bad_credentials` message and the sign-in footer use site wording when hosted.

Checks for both groups:
- `jsc` on all JS, and the server tests.
- The hero check against `.design/linkstest/hero-baseline.json`. The background colour changed in the off-white stage, so compare rects; a hash difference is expected only from colour values.
- A local hosted run-through:
  - Home Welcome → "I have an invite" (the field is first and focused) → sign up with a fresh invite made by the owner → Today appears;
  - a bad code shows its error under the field;
  - sign-in and sign-out;
  - no console errors.

## From the off-white stage (T1), for the front-end group
- `index.html` light theme-color meta and `main.js` (the forced light theme, about line 647, `'#fbfbfd'`) become `#f5f3ee`.
- Optional: sync the JS colour fallbacks to the new light tokens: `maps.js` TOKEN_FALLBACK.light, and `library.js` NET.col (about line 1441).
- Light token rules: never hard-code `#fff` or `#fbfbfd` for a light surface. For accent-coloured text use `--link` (or `--accent-on-tint` on a tint), not `--accent`. Secondary text is `--label-2` `#646469`.
- Exact values from the T1 repair:
  - `index.html` line 7: content="#f5f3ee".
  - `main.js` (forced theme): `m.content = t === 'dark' ? '#000000' : '#f5f3ee';`.
  - `maps.js` TOKEN_FALLBACK.light: land '#f1eee8', sea '#dae4ed', label2 '#646469', label3 '#808085', nt '#0f9489', surface '#f5f3ee'. The light fallback '#f7f7f9' at about line 669 becomes '#f1eee8'.
  - `library.js` NET.col: ot '#e4570c', nt '#0f9489', label2 '#646469', surface '#fbfaf7'.
- QC item 5 (volume backups): Ji turned on Railway volume backups on 2026-10-08. In the README's deploy section, document that backups are on and the restore steps (Railway: volume → Backups → Restore stages a new volume at /data; deploy applies it). Also note an occasional off-Railway copy via Export profile.
