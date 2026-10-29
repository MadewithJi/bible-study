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

LOCKED = r"(app/data/(bibles|orig|redletter)(?=[/\s'\"`;&|)]|$)|app/data/\{[^}\s]*\b(bibles|orig|redletter)\b[^}\s]*\}|(tests/)?scripture\.sha256(?![\w.-]))"
PROTECTED = re.compile(r"(^|[/\s'\"=`(])" + LOCKED, re.I)
INTO = re.compile(r"(>>?|>\||&>)\s*['\"]?[^\s'\"]*" + LOCKED, re.I)
REDIRECT = re.compile(r"(^|[^0-9&<>])(>>?|>\||&>)\s*(?!['\"]?[&/~])['\"]?\S", re.I)  # to a relative path (after a cd inside)
EDITORS = re.compile(r"\bsed\b[^|;&]*\s(-[a-zA-Z]*i|--in-place)|\bperl\b[^|;&]*\s-\w*i|\bawk\b[^|;&]*-i\s*inplace"
                     r"|\b(rm|rmdir|mv|truncate|shred|unlink)\b|\bgit\b(\s+-[Cc]\s+\S+)*\s+(checkout|restore|mv|rm|apply|am|stash|clean)\b|\bdd\b[^|;&]*\bof=|\bfind\b[^|;&]*\s-delete\b"
                     r"|\b(Set-Content|Add-Content|Clear-Content|Out-File|Remove-Item|Copy-Item|Move-Item|Rename-Item|New-Item)\b"
                     r"|\bprettier\b[^|;&]*\s(--write|-w)\b|\bsponge\b|(^|[;&|(]\s*)patch\s|\bunzip\b|\btar\b[^|;&]*\s(-\w*x|--extract)|\bvim?\b|\bnano\b|\bemacs\b|\bed\s"
                     , re.I)
# write calls inside a one-line script (python -c, node -e, ruby -e): its ; are the script's, so the whole command counts
CALLS = re.compile(r"\.write_(text|bytes)\(|\bos\.(replace|rename|remove|unlink|truncate)\(|\bshutil\.\w+\("
                   r"|\bwriteFile(Sync)?\(|\bFile\.write\b|\bopen\([^)]*,\s*(mode\s*=\s*)?['\"][rbt]*[wax+]"
                   r"|\.open\(\s*(mode\s*=\s*)?['\"][rbt]*[wax+][rbt+]*['\"]", re.I)
TEE_ONTO = re.compile(r"\btee\b(\s+-\w+)*\s+['\"]?\S*" + LOCKED, re.I)
# what a commit, a pull request or a note only says: its message is not a command
MSG = r"(\s(-m|--message|--body|--title|--notes)(\s+|=))"
MESSAGE = re.compile(MSG + r"('[^']*'|\"(?:[^\"$`\\]|\\.|\$(?!\())*\")")
MESSAGE_HEREDOC = re.compile(MSG + r"\"\$\(cat\s*<<-?\s*(['\"]?)(\w+)\4\n(.*?)\n\5\n\s*\)\"", re.S)
COPY_ONTO = re.compile(r"\b(cp|rsync|install|ln)\b[^|;&]*\s['\"]?\S*" + LOCKED + r"\S*['\"]?\s*($|[;&|)])", re.I)
UPDATE = re.compile(r"scripture_lock(\.py)?\b[^;&|]*--update|scripture_lock\b.*\.update\(", re.I | re.S)  # the owner's alone
# cp -t / --target-directory, python -m json.tool IN OUT, prettier --write over a glob of app or app/data
TARGET_DIR = re.compile(r"\b(cp|mv|install|ln)\b[^|;&]*\s(-t|--target-directory)(\s+|=)['\"]?\S*" + LOCKED, re.I)
DOWNLOAD = re.compile(r"\bcurl\b[^|;&]*\s(-\w*o|--output)(\s+|=)['\"]?\S*" + LOCKED + r"|\bwget\b[^|;&]*\s(-O|--output-document)(\s*|=)['\"]?\S*" + LOCKED)
JSON_TOOL = re.compile(r"-m\s+json\.tool\s+\S+\s+['\"]?\S*" + LOCKED, re.I)
PRETTIER_GLOB = re.compile(r"\bprettier\b[^|;&]*\s(--write|-w)\b[^|;&]*\s['\"]?(\S*/)?app(/data)?/(\*|\{)", re.I)
COPY_REL = re.compile(r"^(\S*/)?(cp|rsync|install|ln)\b.*\s['\"]?(?![/~])[^\s'\"]+['\"]?\s*$")
# a script handed to a shell (bash -c '…'): its own commands are read as commands; with find or xargs around it,
# the paths it is given come from outside it
SHELL_SCRIPT = re.compile(r"\b(?:ba|z|da|k)?sh\b[^|;&]*?\s-\w*c\s+('([^']*)'|\"((?:[^\"\\]|\\.)*)\")", re.I)
FEEDS = re.compile(r"\b(find|xargs)\b")
# where a command runs: inside a text folder every relative write counts; in app/ or app/data/ relative paths are
# read from there (data/bibles, bibles), so a cd or a working directory never hides the text, nor blocks other work
TEXT_DIR = re.compile(r"(^|/)app/data/(bibles|orig|redletter)(/.*)?$", re.I)
APP_DIR = re.compile(r"(^|/)app(/data)?$", re.I)
CD = re.compile(r"^\s*[({]?\s*(?:cd|pushd)\s+['\"]?([^'\"\s;&|()]+)['\"]?(\s*\d?>&?\s*(/dev/null|&?\d))*\s*$")
FOR_IN = re.compile(r"\bfor\b[^;]*\bin\b[^;]*" + LOCKED, re.I)
QUOTED = re.compile(r"'[^']*'|\"(?:[^\"\\$`]|\\.|\$(?!\())*\"")  # literal text only: never one that runs $( ) or ` `
ANY_QUOTED = re.compile(r"'[^']*'|\"(?:[^\"\\]|\\.)*\"")
# 2. emptying or filling a parent of the text: rm -rf app/data, or (from app/data) a copy into .
PARENT = (r"['\"]?(\./|(\$\{?CLAUDE_PROJECT_DIR\}?|\S*/bible-study(/\.worktrees/[^/\s'\"]+)?)/)?app(/data)?"
          r"(/\.?\*+)?/?['\"]?")
UNPACK = re.compile(r"\b(tar\b(?=[^|;&]*\s(-\w*x|--extract|x\w*\s))|unzip\b)[^|;&]*\s(-C|-d)\s*" + PARENT + r"(\s|$)", re.I)
COPY_PARENT = re.compile(r"\b(cp\b(?=[^|;&]*\s-\w*[rRa])|rsync\b)[^|;&]*\s" + PARENT + r"\s*($|[;&|)])", re.I)
PARENT_DELETE = re.compile(r"\b(rm|rmdir)\b[^|;&]*\s" + PARENT + r"(\s|$)"
                           r"|\bfind\s+" + PARENT + r"\s[^|;&]*-delete\b", re.I)
SPLIT = re.compile(r"\s*(?:;|&&|\|\||\||\n)\s*")
REASON = ("The Bible text (app/data/bibles, orig, redletter and tests/scripture.sha256) may not be changed by an AI "
          "tool. It changes only when the owner rebuilds it from its published sources (see AGENTS.md). If this command "
          "only reads the text, or writes some other file while naming these paths, use the Read and Edit tools, or a "
          "command that does not write and name the text at once.")


def norm_path(p):
    p = str(p or "").replace("\\", "/")
    return posixpath.normpath(p) if p else ""


def norm_command(cmd):
    """Each path-like word normalised (app/./data, app//data, app/data/../data), so the patterns see one spelling."""
    return re.sub(r"[^\s'\"=`(<>|;&]*/[^\s'\"`)<>|;&]*", lambda m: posixpath.normpath(m.group(0)), cmd)


def place(path):
    """'text' inside a text folder, 'app' or 'app/data' there, else ''."""
    path = norm_path(path)
    if TEXT_DIR.search(path):
        return "text"
    m = APP_DIR.search(path)
    return ("app/data" if m.group(2) else "app") if m else ""


END = r"(?=[/\s'\"`;&|)]|$)(?!\s*[=(.])"  # a path word, not a variable (orig = …, orig.get)


def from_root(part, where, strict=False):
    """A part's relative paths as from the project root: from app/, data/bibles is app/data/bibles and data is app/data;
    from app/data/, bibles is app/data/bibles and . is app/data. strict: only words that go on into the folder
    (bibles/kjv/01.json), for a whole script whose bare words may be its variables (orig = …)."""
    end = r"(?=/)" if strict else END
    if where == "app":
        part = re.sub(r"(?<![\w/.~-])(\./)?data/(bibles|orig|redletter)" + end, r"app/data/\2", part, flags=re.I)
        part = re.sub(r"(?<=\bfind\s)(\./)?data/?(?=\s)", "app/data", part)
        return re.sub(r"(?<=\s)(\./)?data(/\.?\*+)?/?(?=\s*($|[;&|)]))", r"app/data\2", part)
    if where == "app/data":
        part = re.sub(r"(?<![\w/.~-])(\./)?(bibles|orig|redletter)" + end, r"app/data/\2", part, flags=re.I)
        part = re.sub(r"(?<=\bfind\s)\.(/)?(?=\s)", "app/data", part)
        return re.sub(r"(?<=\s)(\./?)?(\.?\*+)?(?<=[.*/])(?=\s*($|[;&|)]))", lambda m: "app/data" + ("/" + m.group(2) if m.group(2) else ""), part)
    return part


def parts(cmd):
    """The command cut where the shell cuts it (; && || | and new lines), never inside quotes."""
    masked = ANY_QUOTED.sub(lambda m: "x" * len(m.group(0)), cmd)
    out, at = [], 0
    for m in SPLIT.finditer(masked):
        out.append(cmd[at:m.start()]); at = m.end()
    out.append(cmd[at:])
    return [p for p in out if p.strip()]


# a here-document fed to something that is not an interpreter (git commit -F -, gh … --body-file -, cat > /tmp/…) is
# text: its lines are not commands. One fed to python, node, a shell … is a script and is read. An unquoted one that
# runs $( ) or ` ` is read too.
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1([^\n]*)\n(.*?)\n\2(?=\n|$)", re.S)
INTERPRETER = re.compile(r"\b(python[\d.]*|node|deno|bun|ruby|perl|php|osascript|(ba|z|da|k)?sh)\b")


def strip_heredocs(cmd):
    def one(m):
        line = cmd[cmd.rfind("\n", 0, m.start()) + 1:m.start()] + m.group(3)  # the line that starts it
        if INTERPRETER.search(line) or (not m.group(1) and ("$(" in m.group(4) or "`" in m.group(4))):
            return m.group(0)
        return m.group(0)[:m.start(4) - m.start()] + m.group(0)[m.end(4) - m.start():]
    return HEREDOC.sub(one, cmd)


def strip_messages(cmd):
    def heredoc(m):
        return m.group(0) if not m.group(4) and ("$(" in m.group(6) or "`" in m.group(6)) else m.group(1) + "''"
    return MESSAGE.sub(r"\1''", MESSAGE_HEREDOC.sub(heredoc, cmd))


def writes(cmd, here=""):
    cmd = norm_command(strip_messages(strip_heredocs(cmd)))
    where = place(here)
    whole = from_root(cmd, where, strict=True)
    if PROTECTED.search(whole) and CALLS.search(cmd):
        return True
    # the whole command too (a >| redirect, or a script's own ; between import and update()), then each part after a cd
    if any(rx.search(whole) for rx in (UPDATE, INTO, UNPACK, TEE_ONTO, TARGET_DIR, JSON_TOOL, PRETTIER_GLOB, DOWNLOAD)):
        return True
    looping = False
    cut = parts(cmd)
    for i, part in enumerate(cut):
        m = CD.match(part)
        if m:  # follow the cd, in and out; a script after it names the text from there
            here = posixpath.join(here, m.group(1)) if here or not m.group(1).startswith("/") else m.group(1)
            where = place(here)
            rest = "\n".join(cut[i + 1:])
            if PROTECTED.search(from_root(rest, where, strict=True)) and CALLS.search(rest):
                return True
            continue
        sh = SHELL_SCRIPT.search(part)
        if sh:
            inner = sh.group(2) if sh.group(2) is not None else sh.group(3)
            if writes(inner, here):
                return True
            if FEEDS.search(part) and PROTECTED.search(from_root(part, where)) and EDITORS.search(QUOTED.sub("''", inner)):
                return True
        part = from_root(part, where)
        if any(rx.search(part) for rx in (UPDATE, INTO, UNPACK, TEE_ONTO, TARGET_DIR, JSON_TOOL, PRETTIER_GLOB, DOWNLOAD)):
            return True
        looping = looping or bool(FOR_IN.search(part))
        inside = where == "text"
        bare = QUOTED.sub("''", part)  # a grep pattern, a jq filter or a message: words, not commands
        if (inside or looping or PROTECTED.search(part)) and EDITORS.search(bare):
            return True
        if inside and (REDIRECT.search(part) or COPY_REL.search(part)):
            return True
        words = re.sub(r"'[^']*\s[^']*'|\"(?:[^\"\\$`]|\\.|\$(?!\())*\s(?:[^\"\\$`]|\\.|\$(?!\())*\"", "''", part)  # a pattern or a sentence, not a path
        if COPY_ONTO.search(words) or COPY_PARENT.search(words) or PARENT_DELETE.search(words):
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
    return isinstance(cmd, str) and writes(cmd, here)


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
