# Hosting on Vercel + Railway: build brief

Ji asked on 2026-10-07 to put the full application on GitHub (a public repo) and to host it on **Vercel and Railway** with "projects specifically for this, organised so all of it works seamlessly".

Ji's decisions:
- **Access:** "Me + people I invite".
- **Data:** "Yes, copy my existing local data once".

## 0. Architecture

```
browser ──► Vercel (project "bible-study"): static app/ from the GitHub repo, global CDN
              └─ rewrites /api/* ──► Railway (project "bible-study", service "api"): python3 serve.py
                                          └─ volume /data  (users, profiles, notes, links, marks, library, config)
GitHub repo (public) ── push ──► both redeploy automatically
```

- **Same origin.** The browser only ever talks to the Vercel domain. `/api/*` is proxied by a `vercel.json` rewrite, so cookies, CSRF and X-BS-Scope keep working.
- **Both hosts serve the app.** Railway can serve `app/` too, as a fallback and for health checks.
- **Local use doesn't change.** `python3 serve.py` on a Mac keeps exactly today's behaviour. Hosted behaviour switches on only through environment variables.

## 1. Server: hosted mode (serve.py, accounts.py, tests)

Environment variables. All are optional, and with none set the server behaves exactly as today.

| Var | Meaning |
|---|---|
| `PORT`, `HOST` | Defaults for `--port` / `--host` (Railway sets `PORT`; use `HOST=0.0.0.0`). |
| `BS_DATA_DIR` | Default for `--data-dir` (Railway: `/data`, the volume). |
| `BS_HOSTED=1` | Turns on hosted mode (below). |
| `BS_ALLOWED_HOSTS` | Comma list added to the Host allowlist (the Railway and Vercel domains; `*.up.railway.app` patterns are fine). |
| `BS_ALLOWED_ORIGINS` | Comma list of `https://…` origins accepted by the CSRF Origin check, in addition to the request's own host. |
| `BS_TRUST_PROXY=1` | Take the client IP for rate limits and lockouts from the first `X-Forwarded-For` hop, and the scheme from `X-Forwarded-Proto`. Only when set. |
| `BS_OWNER_EMAILS` | Comma list. These emails may sign up without an invite, manage invites and use ESV/NLT. |

**Hosted mode (`BS_HOSTED=1`):**

- **Cookies.** The session cookie gains `Secure`. Keep `HttpOnly`; `SameSite=Lax` is acceptable if `Strict` breaks the proxied flow (it shouldn't, since everything is same-origin).
- **Guests are read-only.** Every write in the guest scope returns `401 sign_in_required` with "Sign in to save your notes, links and highlights.":
  - notes, links, marks;
  - library events, bookmarks and positions;
  - `import-guest`.
  - Reads stay open: the Bible text and all data under `/data` remain public.
  - Writes in a signed-in profile scope behave exactly as today.
- **Invite-only sign-up.**
  - `POST /api/auth/signup` requires `invite` (a code) unless the email is in `BS_OWNER_EMAILS`. A bad or missing code returns `403 invite_required`: "Sign-up needs an invite code."
  - Codes live in `DATA/invites.json`: `{code: {created, by, uses, maxUses, note, revoked}}`. Codes are random, 10 characters from an unambiguous alphabet, and stored hashed (SHA-256).
  - **Owner endpoints:**
    - `GET /api/invites` lists the codes, showing the last 4 characters, use counts and notes only.
    - `POST /api/invites {note, maxUses}` returns the plain code **once**.
    - `POST /api/invites/revoke {id}`.
  - Use the same locks, `.bak` and corrupt-file rules as `users.json`.
  - `auth/me` reports `signup: 'open' | 'invite'` and `owner: bool`. Local mode stays `open` with no owner concept, so behaviour is unchanged.
- **ESV/NLT.** In hosted mode these keys are personal-use licences, so the passage proxy serves ESV/NLT only to owner sessions; others get `403 owner_only`. `PUT /api/config` (keys) is owner-only. `GET /api/config` tells the client what's available to *this* session.
- **Health.** `GET /api/health` returns `200 {"ok":true}`, with no auth, no scope and no CSRF.
- **Profile import (every mode).** `POST /api/profile/import` (signed in, scope header, CSRF, body limit 25 MiB) takes the JSON from `GET /api/export/profile`. It merges into the signed-in profile:
  - notes, links and marks with the existing `_merge_keyed` rules (newer wins, tombstones respected, idempotent);
  - bookmarks and library chapters, studied, days and positions with the same rules `import-guest` uses.
  - It returns counts like import-guest and appends one `profile.import` activity row.
  - A second import of the same file changes nothing.
- **Tests.** Cover each env var, hosted guest read-only, invites (create, use, maxUses, revoke, hashed at rest), owner-only ESV/NLT and config, `Secure` cookie, proxy IP, health, and profile import (merge + idempotent + validation). All 131 existing tests must pass unchanged.

## 2. Front end (account.js, main.js, store.js, links.js, marks.js, library.js, tracker.js, drawer.js, index.html, styles.css)

- **Read the mode.** Get `hosted`, `signup`, `owner` and the ESV/NLT availability from `auth/me` / `config` (no new request if they're already fetched).
- **Hosted guest is read-only, but friendly.**
  - Reading, cross-references, the visual panels, search and videos all work.
  - Any save attempt shows one calm prompt: "Sign in to save your notes, links and highlights." with Sign in.
  - Note editor, link composer, highlight bubble and bookmark: the action opens that prompt rather than a dead form. The bubble may still show Copy.
  - Data layers (notes, links, marks, tracker) don't queue guest writes or retry `sign_in_required` in a loop, and they don't keep guest data in localStorage.
  - **Local mode is unchanged.**
- **Sign-up form.** When `signup === 'invite'`, show an "Invite code" field (with an `autocomplete` value that won't trigger saved-password prompts) and map `invite_required` to an inline error.
- **Profile dialog, owner only.**
  - An "Invites" section: create a code (optional note), show the new code once with a Copy button, list existing codes (last 4, uses, note) and Revoke.
  - Also "Import profile file" (every mode, signed in): pick the JSON exported by "Export profile". It reports what was brought over, using the toast pattern of "Bring over guest data", and broadcasts notes, links, marks and library to other tabs.
- **Settings.** In hosted mode, the ESV/NLT key rows show only for the owner. Others see ESV/NLT disabled in the translation menu, with "Available to the site owner".
- **Copy style:** sentence case, curly quotes, British spelling, no exclamation marks. Keep the chapter hero unchanged and the reverence rules.

## 3. Deploy configuration (new files only, plus README)

- **`vercel.json`.**
  - `"outputDirectory": "app"`, no build command (`"buildCommand": null` or `""`), `framework: null`.
  - `rewrites`: `/api/:path*` → `https://RAILWAY_HOST/api/:path*`. The placeholder `RAILWAY_HOST` is replaced at provisioning.
  - `cleanUrls: false`.
  - Headers:
    - long cache for `/data/art/**` and immutable assets;
    - a short cache plus revalidate for `/data/**` JSON, `/js/**` and `/css/**` (they change with deploys);
    - `no-store` for `/api/**`;
    - security headers (`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`) matching serve.py's.
  - Make sure `app/index.html` is the root.
- **`.vercelignore`.** Only `app/` and `vercel.json` are needed. Ignore everything else (tests, tools, src, `.design`, `build.py`…).
- **Railway.**
  - `railway.json`:
    - builder NIXPACKS (or RAILPACK) with Python 3;
    - `startCommand`: `python3 serve.py` (it reads `PORT`/`HOST`/`BS_DATA_DIR` from the env);
    - healthcheck path `/api/health`;
    - restart policy on failure.
  - `.python-version` or `runtime.txt` pinned to 3.11 or 3.12.
  - No dependencies are needed at runtime. `requirements.txt` is empty or absent; Pillow is only for `tools/`, so don't install it.
  - The data volume mounts at `/data`.
- **README.** A "Deploying" section:
  - the architecture;
  - the env vars table;
  - "push to main → both redeploy";
  - how to create invites;
  - how to import your local data (Export profile locally → sign up on the site with an owner email → Profile → Import profile file);
  - ESV/NLT keys are set by the owner in Settings on the site.

## 4. Checks

- Server tests: all pass. jsc on touched JS.
- **Local mode, no env vars:** the app behaves as today on your own `serve.py --port 88xx`.
- **Hosted mode,** your own `serve.py` with `BS_HOSTED=1 BS_OWNER_EMAILS=owner@example.test` and a temp data dir:
  - a guest can read and is prompted to sign in on save, with no failing request loops;
  - the owner signs up without a code and creates an invite;
  - a second @example.test account signs up with the invite and fails without one;
  - ESV/NLT are owner-only;
  - profile import from a real export of another test profile merges correctly, and a second import is a no-op.
- `vercel.json` and `railway.json` are valid JSON and match the docs (Vercel rewrites/headers schema).
- The hero check against `.design/linkstest/hero-baseline.json`.
- **Port 8765 is Ji's running app.** Never stop or use it for tests that write. Use your own 88xx servers.
