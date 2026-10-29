# Rules for AI tools working in this repository

## Never change the Bible text

The words of Scripture this site serves must stay exactly as published. No AI tool (Claude, Codex, Copilot, Cursor or any other) may edit, reformat, regenerate, "fix" or move:

- `app/data/bibles/` (the KJV and BSB text and psalm titles)
- `app/data/orig/` (the Hebrew and Greek)
- `app/data/redletter/` (which words are the words of Jesus)
- `tests/scripture.sha256` (the lock that proves the text is unchanged)

They change only when the owner rebuilds them from their published sources with `build.py` and then updates the lock on purpose (`python3 tools/scripture_lock.py --update`). What holds this:

- `python3 tools/scripture_lock.py` and the test suite fail if any byte differs from the lock.
- On GitHub, the "Scripture lock" check runs that on every pull request, and the "Scripture untouched" check fails any pull request that changes these files, the lock or its guards (unless the owner labels it `scripture-rebuild`).
- In Claude Code, `.claude/settings.json` refuses edits of these files before they happen (`tools/scripture_guard.py`) and checks the lock after every command, saying at once if anything changed.

Never write verse text into the site from memory either: quote only from these files or from the licensed API, word for word, and name the translation.
