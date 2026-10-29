#!/usr/bin/env python3
"""Scripture lock: the Bible text the site serves must stay exactly as it was built from its published sources.

The words of the KJV and BSB (app/data/bibles), the Hebrew and Greek (app/data/orig) and the words-of-Jesus ranges
(app/data/redletter) are checked against tests/scripture.sha256, one SHA-256 per file. Nobody edits these files by
hand, and no AI tool may change them (Ji, 2026-10-28): they change only when build.py rebuilds them from the
sources, and then the owner updates the lock on purpose.

  python3 tools/scripture_lock.py            check (exit 1 and the files that differ; --quiet: say nothing when intact)
  python3 tools/scripture_lock.py --update   rewrite the lock after a deliberate rebuild (owner only)
"""
import hashlib
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCKED = ("app/data/bibles", "app/data/orig", "app/data/redletter")
LOCK = os.path.join(ROOT, "tests", "scripture.sha256")


def current():
    """{repo path: sha256} for every file under the locked folders (dotfiles such as .DS_Store aside)."""
    out = {}
    for top in LOCKED:
        for d, dirs, files in os.walk(os.path.join(ROOT, top)):
            dirs[:] = sorted(x for x in dirs if not x.startswith("."))
            for f in sorted(files):
                if f.startswith("."):
                    continue
                p = os.path.join(d, f)
                with open(p, "rb") as fh:
                    out[os.path.relpath(p, ROOT).replace(os.sep, "/")] = hashlib.sha256(fh.read()).hexdigest()
    return out


def locked():
    """The lock file as {repo path: sha256}."""
    out = {}
    with open(LOCK, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#"):
                digest, path = line.split(None, 1)
                out[path] = digest
    return out


def differences():
    """What differs from the lock: [(path, 'changed' | 'added' | 'missing')], empty when the text is intact."""
    have, want = current(), locked()
    diff = [(p, "changed") for p in sorted(have.keys() & want.keys()) if have[p] != want[p]]
    diff += [(p, "added") for p in sorted(have.keys() - want.keys())]
    diff += [(p, "missing") for p in sorted(want.keys() - have.keys())]
    return diff


def update():
    have = current()
    with open(LOCK, "w", encoding="utf-8") as fh:
        fh.write("# Scripture lock (tools/scripture_lock.py): the SHA-256 of every Bible text file the site serves.\n")
        fh.write("# Change it only after a deliberate rebuild from the published sources, with the owner's approval.\n")
        for p in sorted(have):
            fh.write(f"{have[p]}  {p}\n")
    return len(have)


MIN_FILES = 250  # 66 books in each of the KJV, BSB and the Hebrew/Greek, and the words-of-Jesus ranges: an emptied lock fails


def main(argv):
    if "--update" in argv:
        print(f"scripture lock: wrote {update()} files to tests/scripture.sha256")
        return 0
    n = len(locked())
    if n < MIN_FILES:
        print(f"scripture lock: tests/scripture.sha256 lists {n} files, fewer than {MIN_FILES}: the lock itself was cut")
        return 1
    diff = differences()
    if not diff:
        if "--quiet" not in argv:
            print(f"scripture lock: {n} files intact")
        return 0
    print("scripture lock: the Bible text differs from tests/scripture.sha256:")
    for p, why in diff:
        print(f"  {why}: {p}")
    print("The text may change only by rebuilding it from its sources (build.py), with the owner's approval.")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
