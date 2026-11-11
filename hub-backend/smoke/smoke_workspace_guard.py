# -*- coding: utf-8 -*-
"""Read-only workflow-node repository guard, backed by a real Git worktree."""
import io
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, ".")

from app.services import workspace_guard  # noqa: E402


passed = failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
    else:
        failed += 1
        print("FAIL", name, str(detail)[:500])


def git(cwd, *args):
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True,
        encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL,
        timeout=60, check=False,
    )


root = tempfile.mkdtemp(prefix="soduwork-guard-")
try:
    git(root, "init", "-q", "-b", "main")
    io.open(os.path.join(root, "app.txt"), "w", encoding="utf-8").write("baseline\n")
    git(root, "add", "app.txt")
    git(root, "-c", "user.name=SoduWork", "-c", "user.email=soduwork@local",
        "commit", "-q", "-m", "baseline")
    baseline = workspace_guard.capture(
        root, {"mutation": "outputs-only"}, [
            {"kind": "file", "path": "requirements.md"},
            {"kind": "decision", "path": "workflow-decision.json"},
        ])
    check("clean repository guard starts ready", baseline.get("ok"), baseline)
    check("declared output paths are normalized",
          baseline.get("allowedPaths") == ["requirements.md", "workflow-decision.json"], baseline)

    io.open(os.path.join(root, "requirements.md"), "w", encoding="utf-8").write("# scope\n")
    allowed = workspace_guard.evaluate(root, baseline)
    check("declared output is allowed", allowed.get("ok"), allowed)
    check("declared output remains visible as evidence",
          allowed.get("changedPaths") == ["requirements.md"], allowed)

    io.open(os.path.join(root, "app.txt"), "w", encoding="utf-8").write("unauthorized\n")
    violated = workspace_guard.evaluate(root, baseline)
    check("tracked source mutation is rejected", not violated.get("ok"), violated)
    check("violation names the real source path",
          violated.get("violatingPaths") == ["app.txt"], violated)

    git(root, "checkout", "--", "app.txt")
    git(root, "checkout", "-q", "-b", "surprise")
    branch = workspace_guard.evaluate(root, baseline)
    check("branch creation is rejected even without source changes",
          not branch.get("ok") and branch.get("identityChanged"), branch)

    missing = workspace_guard.capture(root, {"mutation": "outputs-only"}, [])
    check("outputs-only guard requires declared paths", not missing.get("ok"), missing)
finally:
    shutil.rmtree(root, ignore_errors=True)

print("PASS=%d FAIL=%d" % (passed, failed))
sys.exit(1 if failed else 0)
