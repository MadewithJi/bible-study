#!/usr/bin/env python3
"""Claude Code PreToolUse hook (.claude/settings.json): refuse any AI edit of the Bible text (Ji, 2026-10-28).

Reads the hook's JSON on stdin. A Write, Edit, MultiEdit or NotebookEdit of a file under app/data/bibles, orig or
redletter, or of tests/scripture.sha256, is denied; so is a shell command that writes to one of them (sed -i, a
redirect, tee, mv, cp, rm …). Reading them stays allowed. tools/scripture_lock.py and the CI check catch anything else.
"""
import json
import re
import sys

PROTECTED = re.compile(r"(^|[/\s'\"=])(\./)?(app/data/(bibles|orig|redletter)(?=[/\s'\"]|$)|tests/scripture\.sha256(?![\w.-]))")
UPDATE = re.compile(r"scripture_lock\.py\b.*--update")  # rewriting the lock is the owner's, never an AI tool's
INTO = re.compile(r">>?\s*['\"]?[^\s'\"]*(app/data/(bibles|orig|redletter)/|tests/scripture\.sha256)")  # a redirect into one
WRITES = re.compile(r"(\bsed\b[^|;&]*\s-i|\bperl\b[^|;&]*\s-i|\btee\b|\bmv\b|\bcp\b|\brm\b|\btruncate\b|\bdd\b"
                    r"|\binstall\b|\brsync\b|\bgit\s+(checkout|restore|mv|rm|apply|am)\b|\bpatch\b|\bln\b|\bchmod\b|\btouch\b"
                    r"|\bopen\([^)]*['\"][wa])")
REASON = ("The Bible text (app/data/bibles, orig, redletter and tests/scripture.sha256) may not be changed by an AI "
          "tool. It changes only when the owner rebuilds it from its published sources (see AGENTS.md).")


def denied(event):
    tool, data = event.get("tool_name", ""), event.get("tool_input") or {}
    if tool in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
        path = str(data.get("file_path") or data.get("notebook_path") or "").replace("\\", "/")
        return bool(PROTECTED.search(path))
    if tool == "Bash":
        cmd = str(data.get("command") or "")
        return bool(UPDATE.search(cmd) or INTO.search(cmd)) or (bool(PROTECTED.search(cmd)) and bool(WRITES.search(cmd)))
    return False


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    if denied(event):
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                                 "permissionDecisionReason": REASON}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
