# Rules for AI tools working in this repository

## Never change the Bible text

The words of Scripture this site serves must stay exactly as published. No AI tool (Claude, Codex, Copilot, Cursor or any other) may edit, reformat, regenerate, "fix" or move:

- `app/data/bibles/` (the KJV and BSB text and psalm titles)
- `app/data/orig/` (the Hebrew and Greek)
- `app/data/redletter/` (which words are the words of Jesus)
- `tests/scripture.sha256` (the lock that proves the text is unchanged)

They change only when the owner rebuilds them from their published sources with `build.py` and then updates the lock on purpose (`python3 tools/scripture_lock.py --update`). `python3 tools/scripture_lock.py` and the test suite fail if any byte differs, and so does the "Scripture lock" check on every pull request.

Never write verse text into the site from memory either: quote only from these files or from the licensed API, word for word, and name the translation.
