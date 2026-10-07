# Bible Study

A local, single-user Bible study app: read the whole Bible, click any verse to open a side drawer with ranked cross-references (readable in context), historical context (dated events, people, places on a map, book introductions), the Hebrew/Greek behind every word with Strong's definitions and a full concordance, your own notes/highlights/tags, and YouTube videos saved to verses and played in-app. Visual link views: a whole-Bible cross-reference arc diagram, a force-directed link graph, a timeline and maps.

## Run

```bash
python3 ~/bible-study/serve.py
```

Then open <http://localhost:8765>. (The command works from any folder.) No dependencies beyond Python 3 (the map tiles and YouTube embeds need internet; everything else is local).

Notes are saved to `notes/notes.json` on every change (and mirrored in the browser's localStorage as a backup). `notes/config.json` holds API keys. When you sign in to a profile (below), notes and progress go to that profile instead.

## Profiles

Optional local profiles: sign in with an email and a password to keep your notes, bookmarks, reading position and study history under your name. Everything stays on this computer and no email is ever sent. Signed out, the app works exactly as before ("guest").

```bash
python3 ~/bible-study/serve.py --list-users                    # profiles on this computer
python3 ~/bible-study/serve.py --reset-password you@example.com # forgot your password: set a new one
```

`--reset-password` asks for the new password twice (or reads one line with `--password-stdin`), works while the server is running, and signs that profile out everywhere. Other flags: `--data-dir DIR` (default `notes/`), `--max-users 50`, `--allow-host NAME` (serve a Host name other than localhost).

What is tracked automatically per profile (or for the guest): chapters opened and read, verses studied, time spent reading, your last position, a daily streak and the last 1,000 study events. Bookmarks, read marks and progress resets are explicit. Two open windows never overwrite each other: notes merge per verse, and progress is sent as events that the server adds up.

Data layout (`notes/` unless `--data-dir`):

| Path | What |
|---|---|
| `notes.json`, `guest-library.json` | guest notes and guest bookmarks/progress |
| `users.json` | profiles (email, name, password hash; never the password) |
| `sessions.json` | signed-in browsers (only a SHA-256 of each session token) |
| `profiles/<id>/notes.json`, `library.json` | one profile's notes and bookmarks/progress |
| `deleted/<id>-<date>/` | a deleted profile's files (remove by hand to erase them for good) |
| `profiles/<id>/user.json` | who owns that folder (email and name, never the password hash) |
| `*.bak` | a daily backup taken before a notes, library or `users.json` file is overwritten |

If `users.json` is ever damaged, the server moves it aside as `users.json.corrupt-<date>` and refuses sign-ins and new profiles (so nobody signs up again into an empty profile) until you restore it: copy `users.json.bak` (or a repaired `.corrupt` file) to `users.json`. The running server picks it up at once, and everyone who was signed in still is.

Security: passwords are hashed with PBKDF2-SHA256 (600,000 rounds; scrypt where Python has it), sign-in is rate limited with a growing lockout, the session cookie is `HttpOnly` and `SameSite=Strict`, every write must be same-origin JSON, and the server only answers to `localhost` / `127.0.0.1`. Export a profile as JSON from the Library, or as Obsidian markdown.

Server tests (start their own server on a free port with a temporary data folder): `python3 tests/test_server.py`.

## Translations

| Translation | How | Why |
|---|---|---|
| KJV, BSB | bundled, offline | public domain |
| ESV, NLT | fetched per chapter via the official APIs with **your** free key (Settings ⚙), cached in `notes/cache/` | copyrighted; APIs licensed for personal use |
| NIV, NKJV, LSB | one click opens the chapter on BibleGateway / read.lsbible.org | copyrighted, no free API |

Keys: ESV at <https://api.esv.org/> · NLT at <https://api.nlt.to/>.

## Features & shortcuts

- **Links** tab — OpenBible.info cross-references ranked by community votes; expand any to read it with two verses of context, jump to it (↶ brings you back), or drop a `[[reference]]` into your note. Topics that cite the verse are listed underneath.
- **Context** tab — year of the events, writer, the chapter's events on a whole-Bible timeline, people (lifespans, relations, Easton's dictionary), places (mini map), and an introduction to the book (author, date, audience, setting, purpose, themes, outline).
- **Original** tab / `o` — word-by-word Hebrew (Leningrad codex) or Greek (all major editions; amber = textual variant between the KJV's Greek and modern editions) with transliteration, gloss, parsed morphology, Strong's number → definition and every occurrence.
- **Notes** tab / `n` — markdown note per verse or chapter, five highlight colours, tags, `[[John 3:16]]` links that navigate. Export as an Obsidian-ready zip or JSON.
- **Video** tab — paste any YouTube link (timestamps preserved), attach to the verse or chapter, play inline.
- **Arcs** `a` · **Graph** `g` · **Map** `m` — visual link views. Search `/` takes references (`rom 8:28`), words, Strong's numbers (`G26`) and topic names. `←` `→` chapters, `j` `k` verses, `?` help.

## Deploying

Optional: the same code can also run as a small invite-only website, with the reader on Vercel and the server and your data on Railway. Local use doesn’t change. With none of the variables below set, `python3 serve.py` behaves exactly as described above.

```
browser ──► Vercel (project bible-study): app/ as static files on Vercel’s CDN
              └─ /api/* proxied by vercel.json ──► Railway (project bible-study, service api): python3 serve.py
                                                      └─ volume /data: profiles, notes, links, highlights, library, settings
GitHub (public repo) ── push to main ──► both redeploy
```

- The browser only ever talks to the Vercel domain. `vercel.json` proxies `/api/*` to Railway, so the session cookie, the same-origin checks and the `X-BS-Scope` header work as they do locally.
- Railway serves `app/` as well, so its own domain is a working fallback.
- Push to `main` and both redeploy on their own: Vercel republishes `app/`, and Railway rebuilds and restarts the server (with a short pause, because a service with a volume never runs two copies at once).

| File | What |
|---|---|
| `vercel.json` | serves `app/` with no build step, proxies `/api/*` to `RAILWAY_HOST`, sets cache and security headers |
| `.vercelignore` | sends only `app/` (without `app/mock/` and dotfiles) and `vercel.json` to Vercel |
| `railway.json` | Railpack build, `python3 serve.py`, healthcheck `/api/health`, restart on failure |
| `.python-version` | Python 3.12 on Railway (the code still runs on the Mac’s Python 3.9) |
| `requirements.txt` | only a comment: nothing needs installing, it only tells Railway’s builder that this is a Python app |

Caching: `index.html`, `js/` and `css/` revalidate on every load (cheap 304s, and the modules always come from the same deploy), the JSON under `data/` is cached for 5 minutes, the Doré plates for 30 days, and `/api/*` never.

**Setting it up (once)**

1. **GitHub.** Push this folder to a public repo. `.gitignore` keeps `notes/` (your data and keys) and `raw/` out of it.
2. **Railway.** Create a project named bible-study, deploy the repo’s `main` branch into it and name the service api. On the service:
   - add a volume mounted at `/data`;
   - set the variables below;
   - under Settings → Networking, generate a domain. That domain (for example `bible-study-api.up.railway.app`) is `RAILWAY_HOST`;
   - check that the start command is `python3 serve.py`, the healthcheck path `/api/health` and the restart policy “On failure”. Railway reads `railway.json` only for services that still use config as code, so a new service takes these from its settings. Keep one replica: the data lives in files on one volume.
3. **Vercel.** In `vercel.json`, replace `RAILWAY_HOST` with that domain, then commit and push. Create a project named bible-study from the repo, with the repo root as its root directory. The framework preset (Other), the output directory and the empty build all come from `vercel.json`, and Vercel needs no variables.
4. Add the Vercel domain (and any custom domain) to `BS_ALLOWED_HOSTS` and `BS_ALLOWED_ORIGINS` on Railway.
5. Check both ends: `https://<your-site>/api/health` and `https://<RAILWAY_HOST>/api/health` both answer `{"ok":true}`.
6. Open the site and sign up with an owner email (no invite needed).

**Railway variables.** All are optional: with none set, the server behaves exactly as it does on your Mac.

| Variable | On Railway | What |
|---|---|---|
| `PORT` | set by Railway | the port to listen on (default for `--port`) |
| `HOST` | `0.0.0.0` | listen on every interface (default for `--host`; locally it is `127.0.0.1`) |
| `BS_DATA_DIR` | `/data` | where profiles, notes and settings live (default for `--data-dir`): the volume |
| `BS_HOSTED` | `1` | hosted mode, below |
| `BS_ALLOWED_HOSTS` | `bible-study-api.up.railway.app,bible-study.vercel.app` | Host names answered besides localhost (comma list; `*.up.railway.app` patterns work). Railway’s health check (Host `healthcheck.railway.app`) is answered without being listed. |
| `BS_ALLOWED_ORIGINS` | `https://bible-study.vercel.app` | origins whose writes pass the same-origin check, besides the request’s own host (comma list) |
| `BS_TRUST_PROXY` | `1` | take the visitor’s IP from the first `X-Forwarded-For` hop (for the sign-in and sign-up rate limits and the auth log) and the scheme from `X-Forwarded-Proto`; never set it locally |
| `BS_OWNER_EMAILS` | your email | comma list: these emails sign up without an invite, manage invites and use ESV/NLT |

**Hosted mode** (`BS_HOSTED=1`):

- Anyone can read: the Bible text, cross-references, context, the original languages, maps and videos. Saving notes, links, highlights, bookmarks and reading progress needs an account, so a visitor who isn’t signed in is asked to sign in instead.
- Sign-up needs an invite code, except for the owner emails.
- ESV and NLT are served only to owners, because the keys are personal-use licences. Everyone else reads KJV and BSB, and NIV, NKJV and LSB open on their own sites as usual.
- The session cookie is also `Secure`.

**Invites.** In Profile → Invites (owners only), create a code, with a note to remember who it’s for if you like, and copy it straight away: it is shown once, and only a hash of it is stored. The person enters it as their invite code when they sign up. The list shows each code’s last four characters, how often it has been used and its note, and Revoke stops a code from working.

**Passwords.** To set a new password for someone on the site, open a shell on the api service (`railway ssh`, or the service’s shell in the dashboard) and run `python3 serve.py --reset-password their@email`. `BS_DATA_DIR` points it at the volume, and it works while the server is running.

**Bringing your local data over**

1. On your Mac (`python3 serve.py`), sign in and choose Profile → Export profile. It downloads one JSON file. If your notes were made signed out, use Bring over guest data first, so they are in your profile.
2. On the site, sign up with an owner email.
3. Choose Profile → Import profile file and pick that JSON file. Notes, links, highlights, bookmarks and reading history merge into your profile on the site, and importing the same file again changes nothing.

Don’t copy the `notes/` folder onto the volume: on the site its guest files can be read by every visitor. Bring data over only with Export profile and Import profile file.

**ESV and NLT on the site.** The owner sets the keys in Settings (⚙) on the site, just as locally. They are kept on the Railway volume (`/data/config.json`), never in the repo.

## Rebuilding the data

`app/data/` is generated by `build.py` from the sources below (downloaded into `raw/` on first run):

```bash
python3 build.py
```

Inputs kept in `src/`: `cross_references.txt` (OpenBible.info), `topics/` (OpenBible.info topical index, from the Obsidian vault export), `book_intros.json` (hand-written book introductions — edit freely).

## Data licences

- KJV text — public domain; eBible.org's red-letter USFM edition (eng-kjv2006, 1769 text), which also marks the words of Jesus. The BSB's words of Jesus are carried across from it by build.py (BSB quotation marks + speaker attribution). BSB — public domain (bereanbible.com).
- Cross-references and topical index — [OpenBible.info](https://www.openbible.info/labs/cross-references/), CC BY.
- Hebrew OT (TAHOT) and Greek NT (TAGNT) with glosses and morphology — [STEPBible](https://github.com/STEPBible/STEPBible-Data), CC BY 4.0. Do not redistribute the raw files; point people to the STEPBible repo.
- Strong's dictionaries — [OpenScriptures](https://github.com/openscriptures/strongs), CC BY-SA.
- People, places, events, years, Easton's — [Theographic Bible Metadata](https://github.com/robertrouse/theographic-bible-metadata), CC BY-SA 4.0.
- Maps — [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause); basemap by [OpenFreeMap](https://openfreemap.org/), © [OpenMapTiles](https://www.openmaptiles.org/), © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL); terrain from Mapzen / [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/); [Digital Atlas of the Roman Empire](https://imperium.ahlfeldt.se/) © Johan Åhlfeldt, University of Gothenburg, CC BY 4.0.
- Place records — [Pleiades](https://pleiades.stoa.org/) (CC BY), [GeoNames](https://www.geonames.org/) (CC BY 4.0).

Bible art — Gustave Doré (1832–1883), engravings for *La Grande Bible de Tours* (1866), public domain, via [Wikimedia Commons](https://commons.wikimedia.org/wiki/Dor%C3%A9%27s_Bible_Illustrations). The 222 plates on canonical passages (the Apocrypha plates are left out) come from Commons scans of Doré's English Bible and, where those are poor or missing, of other printings of the same engravings, mostly the 1874 Warsaw Bible scanned by the National Library of Poland. Each plate links to its Commons file page in `app/data/art.json`. `src/art/dore.json` is the curated list: the passage each plate illustrates, a short scene description, the chosen Commons file and any crop. `python3 tools/fetch_art.py` downloads the images into `app/data/art/` (1800px and 560px JPEGs, about 270 MB) and rewrites `art.json`. It only fetches missing images (`--force` or `--only dore-015` to redo some), and it uses Commons' resized thumbnails where they are big enough.
