#!/usr/bin/env python3
"""Claude Code PreToolUse hook (.claude/settings.json): refuse an AI edit of the Bible text (Ji, 2026-10-28).

Reads the hook's JSON on stdin. A Write, Edit, MultiEdit or NotebookEdit of a file under app/data/bibles, orig or
redletter, or of tests/scripture.sha256, is denied whatever the spelling of its path (case, ./, ../, //). A shell
command (any tool with a `command`) is denied when one of its parts plainly writes there: a redirect, an in-place
edit, rm, mv, a copy onto it, an unpack into it, a write call, or rewriting the lock. Reading stays allowed.

Shell is too open to list every way of writing, so this is the first line only: the PostToolUse check runs
tools/scripture_lock.py after every command and says at once when any byte has changed, and the tests and the
"Scripture lock" pull-request checks refuse it after that.
"""
import json
import posixpath
import re
import sys

LOCKED = r"(app/data/(bibles|orig|redletter)(?=[/\s'\"`;&|)]|$)|(tests/)?scripture\.sha256(?![\w.-]))"
PROTECTED = re.compile(r"(^|[/\s'\"=`(])" + LOCKED, re.I)
# a cd into the text's folders (or their parents) makes the relative writes after it count
INSIDE = re.compile(r"(^|[;&|(]\s*)cd\s+['\"]?(\S*/)?(app/data(/(bibles|orig|redletter)(/\S*)?)?|app)/?['\"]?(\s|$)"
                    r"|\bfor\b[^;]*\bin\b[^;]*" + LOCKED, re.I)
INTO = re.compile(r"(>>?|>\||&>)\s*['\"]?[^\s'\"]*" + LOCKED, re.I)
REDIRECT = re.compile(r"(^|[^0-9&<>])(>>?|>\||&>)\s*['\"]?(?![&/~])\S", re.I)  # to a relative path (after a cd inside)
EDITORS = re.compile(r"\bsed\b[^|;&]*\s(-[a-zA-Z]*i|--in-place)|\bperl\b[^|;&]*\s-\w*i|\bawk\b[^|;&]*-i\s*inplace"
                     r"|\b(rm|rmdir|mv|truncate|shred|unlink)\b|\bgit\b(\s+-[Cc]\s+\S+)*\s+(checkout|restore|mv|rm|apply|am|stash|clean)\b|\bdd\b[^|;&]*\bof=|\bfind\b[^|;&]*\s-delete\b"
                     r"|\b(Set-Content|Add-Content|Clear-Content|Out-File|Remove-Item|Copy-Item|Move-Item|Rename-Item|New-Item)\b"
                     r"|\bprettier\b[^|;&]*\s(--write|-w)\b|\bsponge\b|\bunzip\b|\btar\b[^|;&]*\s(-\w*x|--extract)|\bvim?\b|\bnano\b|\bemacs\b|\bed\s"
                     , re.I)
# write calls inside a one-line script (python -c, node -e, ruby -e): its ; are the script's, so the whole command counts
CALLS = re.compile(r"\.write_(text|bytes)\(|\bos\.(replace|rename|remove|unlink|truncate)\(|\bshutil\.\w+\("
                   r"|\bwriteFile(Sync)?\(|\bFile\.write\b|\bopen\([^)]*,\s*(mode\s*=\s*)?['\"][rbt]*[wax+]", re.I)
TEE_ONTO = re.compile(r"\btee\b(\s+-\w+)*\s+['\"]?\S*" + LOCKED, re.I)
UNPACK = re.compile(r"\b(tar\b(?=[^|;&]*\s(-\w*x|--extract|x\w*\s))|unzip\b)[^|;&]*\s(-C|-d)\s*['\"]?(\S*/)?app(/data)?/?['\"]?(\s|$)", re.I)
# what a commit, a pull request or a note only says: its message is not a command
MESSAGE = re.compile(r"(\s(-m|--message|--body|--title|--notes)(\s+|=))"
                     r"(\"\$\(cat\s*<<-?\s*'(\w+)'\n.*?\n\5\n\s*\)\"|'[^']*'|\"(?:[^\"$`\\]|\\.|\$(?!\())*\")", re.S)
COPY_ONTO = re.compile(r"\b(cp|rsync|install|ln)\b[^|;&]*\s['\"]?\S*" + LOCKED + r"\S*['\"]?\s*($|[;&|)])", re.I)
UPDATE = re.compile(r"scripture_lock(\.py)?\b[^;&|]*--update|scripture_lock\b.*\.update\(", re.I | re.S)  # the owner's alone
# cp -t / --target-directory, python -m json.tool IN OUT, prettier --write over a glob of app or app/data
TARGET_DIR = re.compile(r"\b(cp|mv|install|ln)\b[^|;&]*\s(-t|--target-directory)(\s+|=)['\"]?\S*" + LOCKED, re.I)
JSON_TOOL = re.compile(r"-m\s+json\.tool\s+\S+\s+['\"]?\S*" + LOCKED, re.I)
PRETTIER_GLOB = re.compile(r"\bprettier\b[^|;&]*\s(--write|-w)\b[^|;&]*\s['\"]?(\S*/)?app(/data)?/(\*|\{)", re.I)
COPY_REL = re.compile(r"^(\S*/)?(cp|rsync|install|ln)\b.*\s['\"]?(?![/~])[^\s'\"]+['\"]?\s*$")
COPY_PARENT = re.compile(r"\b(cp\b(?=[^|;&]*\s-\w*[rRa])|rsync\b)[^|;&]*\s['\"]?(\S*/)?app(/data)?/?['\"]?\s*($|[;&|)])", re.I)
CWD_INSIDE = re.compile(r"(^|/)app(/data(/(bibles|orig|redletter)(/.*)?)?)?$", re.I)
SPLIT = re.compile(r"\s*(?:;|&&|\|\||\||\n)\s*")
REASON = ("The Bible text (app/data/bibles, orig, redletter and tests/scripture.sha256) may not be changed by an AI "
          "tool. It changes only when the owner rebuilds it from its published sources (see AGENTS.md).")


def norm_path(p):
    p = str(p or "").replace("\\", "/")
    return posixpath.normpath(p) if p else ""


def norm_command(cmd):
    """Each path-like word normalised (app/./data, app//data, app/data/../data), so the patterns see one spelling."""
    return re.sub(r"[^\s'\"=`(<>|;&]*/[^\s'\"`)<>|;&]*", lambda m: posixpath.normpath(m.group(0)), cmd)


def writes(cmd, inside=False):
    cmd = norm_command(MESSAGE.sub(r"\1''", cmd))
    if any(rx.search(cmd) for rx in (UPDATE, INTO, UNPACK, TEE_ONTO, TARGET_DIR, JSON_TOOL, PRETTIER_GLOB)):
        return True
    if PROTECTED.search(cmd) and CALLS.search(cmd):
        return True
    for part in SPLIT.split(cmd):
        if INSIDE.search(part):
            inside = True
        touches = inside or PROTECTED.search(part)
        if touches and (EDITORS.search(part) or (inside and REDIRECT.search(part))):
            return True
        if COPY_ONTO.search(part) or COPY_PARENT.search(part) or (inside and COPY_REL.search(part)):
            return True
    return False


def denied(event):
    tool, data = event.get("tool_name", ""), event.get("tool_input") or {}
    if tool in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
        return bool(PROTECTED.search(norm_path(data.get("file_path") or data.get("notebook_path"))))
    cmd = data.get("command")
    if tool == "PowerShell" and isinstance(cmd, str):
        cmd = cmd.replace("\\", "/")
    here = norm_path(posixpath.join(str(event.get("cwd") or ""), str(data.get("cwd") or "")))
    return isinstance(cmd, str) and writes(cmd, bool(CWD_INSIDE.search(here)))


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
