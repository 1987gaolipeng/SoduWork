"""Report new Ruff findings in Hub application files relative to a Git revision."""

import json
import re
import subprocess
import sys
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path


def git(*args):
    return subprocess.check_output(["git", *args])


def changed_files(base):
    # NUL delimiters preserve spaces and quoted characters in repository paths.
    changes = iter(git("diff", "--relative", "--name-status", "-z", "--find-renames",
                       "--diff-filter=AMRT", base, "--", "app").decode().split("\0"))
    for status in changes:
        if not status:
            break
        old_path = next(changes)
        new_path = next(changes) if status.startswith("R") else old_path
        if new_path.endswith(".py") and not Path(new_path).is_symlink():
            yield None if status == "A" or not old_path.endswith(".py") else old_path, new_path
    untracked = git("ls-files", "--others", "--exclude-standard", "-z", "--", "app").decode()
    for path in untracked.split("\0"):
        if path.endswith(".py") and not Path(path).is_symlink():
            yield None, path


def findings(path, source):
    # --exit-zero applies to lint findings only. Configuration or invocation errors still fail CI.
    result = subprocess.run([
        sys.executable, "-m", "ruff", "check", "--select=E4,E7,E9,F,I,W", "--config=lint.ignore=[]",
        "--exit-zero", "--output-format=json", "--stdin-filename", path, "-",
    ], input=source, stdout=subprocess.PIPE, check=True)
    return json.loads(result.stdout)


def signature(item, first, last):
    # Some messages (e.g. F811) quote a source line number that can shift after an unrelated edit.
    message = re.sub(r"\bfrom line \d+\b", "from an earlier line", item["message"])
    return (item["code"], message, first, item["location"]["column"], last, item["end_location"]["column"])


def new_findings(path, before, after):
    current = findings(path, after)
    if not before or not current:
        return current
    previous = Counter(signature(item, item["location"]["row"], item["end_location"]["row"])
                       for item in findings(path, before))
    unchanged = {}
    for old, new, length in SequenceMatcher(None, before.splitlines(), after.splitlines(),
                                            autojunk=False).get_matching_blocks():
        for offset in range(1, length + 1):
            unchanged[new + offset] = old + offset
    added = []
    for item in current:
        first, last = item["location"]["row"], item["end_location"]["row"]
        old = unchanged.get(first)
        if old is not None and all(unchanged.get(n) == old + n - first for n in range(first, last + 1)):
            key = signature(item, old, old + last - first)
            if previous[key]:
                previous[key] -= 1
                continue
        added.append(item)
    return added


def main(base):
    failed = False
    for old_path, new_path in changed_files(base):
        before = git("show", f"{base}:./{old_path}") if old_path else b""
        for item in new_findings(new_path, before, Path(new_path).read_bytes()):
            at = item["location"]
            print(f"{new_path}:{at['row']}:{at['column']}: {item['code']} {item['message']}")
            failed = True
    return int(failed)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage from hub-backend: python scripts/check_changed_lint.py <base-revision>")
    sys.exit(main(sys.argv[1]))
