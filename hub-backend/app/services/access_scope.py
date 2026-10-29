"""Concrete workspace targets and literal read-only queries; never a sandbox."""
from __future__ import annotations
import os
import re

# Reading work instructions is normal; changing them changes future execution.
_PROTECTED = re.compile(r"(?:^|[\\/])(?:\.git|\.ssh|\.aws|\.azure|\.kube|\.codex|\.claude|\.qwen|\.pi|\.soduwork|\.agents|\.opencode|\.env(?:\.[^\\/]*)?|\.npmrc|\.pypirc|\.netrc)(?:[\\/]|$)", re.I)
_INSTRUCTIONS = re.compile(r"(?:^|[\\/])(?:AGENTS\.md|SKILL\.md|CLAUDE\.md|GEMINI\.md)(?:[\\/]|$)", re.I)

def protected(value: str, write=False) -> bool:
    if os.name == "nt" and ":" in os.path.splitdrive(value)[1]:
        return True
    return bool(_PROTECTED.search(value) or write and _INSTRUCTIONS.search(value))

def resolve(workspace: str, value: str) -> str:
    return os.path.realpath(os.path.abspath(os.path.join(workspace, value)))

def inside(workspace: str, target: str) -> bool:
    try:
        return os.path.normcase(os.path.commonpath((os.path.realpath(workspace), target))) == os.path.normcase(os.path.realpath(workspace))
    except ValueError:
        return False

def automatic_path(workspace: str, value: str, write=False) -> bool:
    if not isinstance(value, str) or not value or "\0" in value:
        return False
    source = os.path.abspath(os.path.join(workspace, value))
    target = resolve(workspace, value)
    return inside(workspace, target) and not protected(source, write) and not protected(target, write)

def query_words(command):
    if not isinstance(command, str) or not command.strip() or len(command) > 8192 or re.search(r"[\x00-\x1f\x7f\\]", command):
        return None
    result, end = [], 0
    for match in re.finditer(r'''"[^"]*"|'[^']*'|[^\s"']+''', command):
        if command[end:match.start()].strip() or end and match.start() == end:
            return None
        token = match[0]
        if ((token[0] == '"' and re.search(r"[$\x60%]", token)) or
                (token[0] not in "\"'" and re.search(r"[$\x60;&|<>(){}\[\]*?!~%]", token))):
            return None
        result.append(token[1:-1] if token[0] in "\"'" else token)
        end = match.end()
    return None if command[end:].strip() else result

def query_targets(argv):
    if not isinstance(argv, list) or not argv or any(not isinstance(v, str) or not v or re.search(r"[\x00-\x1f\x7f]", v) for v in argv):
        return None
    name, args = argv[0], argv[1:]
    if name == "pwd":
        return [(".", "directory")] if all(v in ("-L", "-P") for v in args) else None
    if name not in ("ls", "cat", "head", "tail", "wc", "rg", "grep"):
        return None
    result, positional, pattern_seen, index = [], False, False, 0
    list_files = name == "rg" and "--files" in args
    while index < len(args):
        value = args[index]
        index += 1
        if not positional and value == "--":
            positional = True
            continue
        if not positional and value.startswith("-"):
            if name == "ls" and (re.fullmatch(r"-[lahd1Ftr]+", value) or value in ("--all", "--almost-all", "--directory", "--human-readable")):
                continue
            if name == "cat" and re.fullmatch(r"-[nbsETv]+", value):
                continue
            if name == "wc" and re.fullmatch(r"-[lcwmL]+", value):
                continue
            if name in ("head", "tail") and value in ("-n", "-c") and index < len(args) and re.fullmatch(r"\d{1,7}", args[index]):
                index += 1
                continue
            if name in ("head", "tail") and re.fullmatch(r"-[nc]\d{1,7}", value):
                continue
            if name in ("head", "tail") and re.fullmatch(r"-\d{1,7}|(?:--lines|--bytes)=\d{1,7}", value):
                continue
            if name == "rg" and (value in ("--no-config", "--files") or not list_files and (re.fullmatch(r"-[niFwlcsv]+", value) or value in ("--line-number", "--ignore-case", "--fixed-strings", "--count", "--no-heading", "--hidden"))):
                continue
            if name in ("rg", "grep") and not list_files and value in ("-A", "-B", "-C", "-m", "--max-count") and index < len(args) and re.fullmatch(r"\d{1,7}", args[index]):
                index += 1
                continue
            if name == "grep" and (re.fullmatch(r"-[nHiFEwclqsv]+", value) or value in ("--line-number", "--ignore-case", "--fixed-strings", "--count")):
                continue
            return None
        if name in ("rg", "grep") and not list_files and not pattern_seen:
            pattern_seen = True
            continue
        if value.startswith("-"):
            return None
        result.append((value, "either" if name in ("ls", "rg") else "file"))
    if not result and name in ("ls", "rg"):
        result.append((".", "directory"))
    return result if result and (name not in ("rg", "grep") or list_files or pattern_seen) else None


_SEARCH_EXCLUDES = (".git", ".ssh", ".aws", ".azure", ".kube", ".codex", ".claude", ".qwen", ".pi", ".soduwork", ".agents", ".opencode",
                    ".env", ".env.*", ".npmrc", ".pypirc", ".netrc", "credential", "credential.*", "credentials", "credentials.*", "auth.json", "token.json", "tokens.json",
                    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "*.pem", "*.key", "*.p12", "*.pfx")


def query_execution_args(argv):
    """Host-owned argv; callers must never execute an admitted raw rg command."""
    if not query_targets(argv):
        return None
    if argv[0] != "rg":
        return argv[1:]
    exclusions = [value for name in _SEARCH_EXCLUDES for value in ("--iglob", "!**/" + name, "--iglob", "!**/" + name + "/**")]
    return ["--no-config", "--no-follow", *exclusions, *argv[1:]]

def automatic_query(workspace: str, command, *, cwd=None, args=None, env=None, read_scope=None) -> bool:
    # Overrides could redefine tools or inject configuration/startup scripts.
    def readable(value):
        if read_scope and read_scope.contains(workspace, value):
            return read_scope.allows(workspace, value)
        return automatic_path(workspace, value)
    if env or not readable(cwd or workspace):
        return False
    directory = resolve(workspace, cwd or workspace)
    argv = query_words(command) if args is None else [command, *args]
    targets = query_targets(argv)
    if not targets:
        return False
    for value, kind in targets:
        target = resolve(directory, value)
        if not readable(os.path.join(directory, value)):
            return False
        if kind == "file" and not os.path.isfile(target):
            return False
        if kind == "directory" and not os.path.isdir(target):
            return False
    return True


def trusted_program(name: str, workspace: str) -> str:
    if name not in ("pwd", "ls", "cat", "head", "tail", "wc", "rg", "grep"):
        return ""
    directories = os.environ.get("PATH", "").split(os.pathsep)
    if os.name == "nt":
        for key, suffix in (("ProgramFiles", "Git/usr/bin"), ("ProgramFiles(x86)", "Git/usr/bin"), ("LOCALAPPDATA", "Programs/Git/usr/bin")):
            if os.environ.get(key):
                directories.append(os.path.join(os.environ[key], suffix))
    for directory in directories:
        if not os.path.isabs(directory):
            continue
        target = os.path.realpath(os.path.join(directory, name + (".exe" if os.name == "nt" else "")))
        if inside(workspace, target) or not os.path.isfile(target):
            continue
        if os.access(target, os.F_OK if os.name == "nt" else os.X_OK):
            return target
    return ""
