# -*- coding: utf-8 -*-
"""Quality checks must inspect the fixed remote commit rather than later AI workspace changes."""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, ".")

from app.services import runner_quality, runner_scm  # noqa: E402

_TEMP = tempfile.TemporaryDirectory(prefix="soduwork-smoke-runner-quality-")
ROOT = Path(_TEMP.name) / "fixture"


def remove_readonly(func, path, _exc):
    os.chmod(path, stat.S_IWRITE)
    func(path)


def clean_root():
    for attempt in range(5):
        if not ROOT.exists():
            return
        try:
            shutil.rmtree(ROOT, onerror=remove_readonly)
        except OSError:
            if attempt == 4:
                raise
            time.sleep(0.1 * (attempt + 1))


clean_root()
ROOT.mkdir(parents=True)
ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS ", name)
    else:
        fail += 1
        print("  FAIL ", name, "<<", str(extra)[:300])


def git(cwd: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=cwd, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", timeout=60, shell=False)
    if proc.returncode:
        raise RuntimeError(proc.stdout)
    return (proc.stdout or "").strip()


try:
    origin, source, mirror = ROOT / "origin.git", ROOT / "source", ROOT / "mirror"
    git(ROOT, "init", "--bare", str(origin))
    git(ROOT, "clone", str(origin), str(source))
    git(source, "config", "user.name", "SoduWork Smoke")
    git(source, "config", "user.email", "smoke@soduwork.local")
    git(source, "checkout", "-b", "main")
    (source / "candidate.txt").write_text("base\n", encoding="utf-8")
    git(source, "add", "candidate.txt")
    git(source, "commit", "-m", "base")
    git(source, "push", "-u", "origin", "main")
    git(source, "checkout", "-b", "feat/quality")
    (source / "candidate.txt").write_text("candidate\n", encoding="utf-8")
    git(source, "commit", "-am", "candidate")
    git(source, "push", "-u", "origin", "feat/quality")
    expected = git(source, "rev-parse", "HEAD")
    git(ROOT, "clone", str(origin), str(mirror))

    quality_root = ROOT / "quality"
    quality_root.mkdir()
    old_root, old_ready = runner_quality._root, runner_scm._ready
    runner_quality._root = lambda: str(quality_root)
    runner_scm._ready = lambda _payload: (str(mirror), {"ok": True, "created": False})

    # Modify the development worktree after commit and verify quality still sees the pushed candidate only.
    (source / "candidate.txt").write_text("dirty-later-change\n", encoding="utf-8")
    spec = {
        "runId": "quality-fixed-001",
        "repository": {"gitUrl": str(origin), "branch": "feat/quality",
                       "target": "main", "commit": expected, "taskId": "quality-smoke"},
        "commands": [
            {"name": "固定内容", "argv": [sys.executable, "-c",
             "from pathlib import Path; assert Path('candidate.txt').read_text().strip() == 'candidate'"]},
            {"name": "差异完整性", "argv": ["git", "diff", "--check"]},
        ],
    }
    runner_quality._worker(spec, "")
    result = runner_quality.status(spec["runId"])
    chk("质量命令运行在固定提交的隔离副本", result.get("state") == "succeeded", result)
    chk("质量证据记录被验证的完整提交号",
        (result.get("result") or {}).get("commit") == expected, result)
    chk("质量结束后清理隔离工作树",
        not (quality_root / "checkouts" / spec["runId"]).exists())

    # Reject branch/version drift rather than silently testing either an unauthorized new tip or stale content.
    git(source, "reset", "--hard", expected)
    (source / "candidate.txt").write_text("new-version\n", encoding="utf-8")
    git(source, "commit", "-am", "new candidate")
    git(source, "push", "origin", "feat/quality")
    mismatch = {**spec, "runId": "quality-fixed-002"}
    runner_quality._worker(mismatch, "")
    result2 = runner_quality.status(mismatch["runId"])
    chk("远端分支产生新版本后拒绝沿用旧质量授权",
        result2.get("state") == "failed" and "不一致" in str(result2.get("error") or ""),
        result2)
finally:
    if "old_root" in globals():
        runner_quality._root = old_root
        runner_scm._ready = old_ready
    clean_root()
    _TEMP.cleanup()

print(f"\nrunner quality smoke: {ok} passed, {fail} failed")
raise SystemExit(1 if fail else 0)
