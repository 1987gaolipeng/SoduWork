# -*- coding: utf-8 -*-
"""Runner quality-gate tests for fixed revisions, structured commands, evidence, failure, and
idempotency.
"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(tempfile.mkdtemp(prefix="soduwork-quality-smoke-"))
DATA = ROOT / "data"
SOURCE = ROOT / "source"
ORIGIN = ROOT / "origin.git"
MIRROR = ROOT / "mirror"
os.environ["SODUWORK_DATA_ROOT"] = str(DATA)
sys.path.insert(0, ".")

from app.services import runner_quality, runner_scm  # noqa: E402

ok = fail = 0
lines = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        lines.append("  PASS  " + name)
    else:
        fail += 1
        lines.append("  FAIL  " + name + ("  << " + str(extra)[:240] if extra else ""))


def git(cwd: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=cwd, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", timeout=60, shell=False)
    if proc.returncode:
        raise RuntimeError(proc.stdout)
    return (proc.stdout or "").strip()


def wait(run_id, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        out = runner_quality.status(run_id)
        if out.get("state") in ("succeeded", "failed"):
            return out
        time.sleep(0.05)
    return runner_quality.status(run_id)


def run_spec(run_id: str, commands: list[dict], repository: dict) -> dict:
    return {"runId": run_id, "repository": dict(repository), "commands": commands}


def remove_readonly(func, path, _exc):
    os.chmod(path, stat.S_IWRITE)
    func(path)


old_ready = runner_scm._ready
try:
    git(ROOT, "init", "--bare", str(ORIGIN))
    git(ROOT, "clone", str(ORIGIN), str(SOURCE))
    git(SOURCE, "config", "user.name", "SoduWork Smoke")
    git(SOURCE, "config", "user.email", "smoke@soduwork.local")
    git(SOURCE, "checkout", "-b", "main")
    (SOURCE / "backend").mkdir()
    (SOURCE / "backend" / ".keep").write_text("", encoding="utf-8")
    (SOURCE / "candidate.txt").write_text("base\n", encoding="utf-8")
    git(SOURCE, "add", ".")
    git(SOURCE, "commit", "-m", "base")
    git(SOURCE, "push", "-u", "origin", "main")
    git(SOURCE, "checkout", "-b", "feat/quality")
    (SOURCE / "candidate.txt").write_text("candidate\n", encoding="utf-8")
    git(SOURCE, "commit", "-am", "candidate")
    git(SOURCE, "push", "-u", "origin", "feat/quality")
    expected = git(SOURCE, "rev-parse", "HEAD")
    git(ROOT, "clone", str(ORIGIN), str(MIRROR))
    runner_scm._ready = lambda _payload: (str(MIRROR), {"ok": True, "created": False})
    repository = {
        "gitUrl": str(ORIGIN), "branch": "feat/quality", "target": "main",
        "commit": expected, "taskId": "quality-smoke",
    }

    success = run_spec("quality-smoke-success", [
        {"name": "生成证据", "argv": [sys.executable, "-c",
         "open('quality-ok.txt','w',encoding='utf-8').write('ok'); print('quality pass')"]},
        {"name": "核对固定版本", "argv": [sys.executable, "-c",
         "from pathlib import Path; import sys; sys.exit(0 if Path('candidate.txt').read_text().strip() == 'candidate' else 2)"],
         "timeoutSeconds": 10},
    ], repository)
    started = runner_quality.start(success, str(ROOT / "unused-work-root"))
    done = wait(success["runId"])
    chk("质量门禁异步接单并只验证已推送的固定提交",
        started.get("ok") and done.get("state") == "succeeded"
        and (done.get("result") or {}).get("commit") == expected, done)
    checks = (done.get("result") or {}).get("checks") or []
    chk("每条检查保存退出码、耗时和结果证据",
        len(checks) == 2 and all(x.get("ok") for x in checks)
        and all("durationMs" in x for x in checks), checks)
    chk("质量日志可以回传给审批证据面板", "quality pass" in done.get("log", ""))
    chk("同一节点运行号重复启动保持幂等",
        runner_quality.start(success, str(ROOT)).get("state") == "succeeded")

    nested = run_spec("quality-smoke-working-dir", [
        {"name": "子工程目录", "workingDir": "backend", "argv": [sys.executable, "-c",
         "import os,sys; sys.exit(0 if os.path.basename(os.getcwd()) == 'backend' else 3)"]},
    ], repository)
    runner_quality.start(nested, str(ROOT))
    nested_done = wait(nested["runId"])
    chk("每条质量命令可以选择固定提交内的子目录",
        nested_done.get("state") == "succeeded", nested_done)

    bad_nested = run_spec("quality-smoke-working-dir-escape", [
        {"name": "子目录越界", "workingDir": "../outside",
         "argv": [sys.executable, "-c", "print(1)"]},
    ], repository)
    runner_quality.start(bad_nested, str(ROOT))
    bad_nested_done = wait(bad_nested["runId"])
    chk("单条质量命令不能越过固定提交根目录",
        bad_nested_done.get("state") == "failed" and "目录" in bad_nested_done.get("error", ""),
        bad_nested_done)

    failure = run_spec("quality-smoke-failure", [
        {"name": "故意失败", "argv": [sys.executable, "-c",
         "print('bad evidence'); raise SystemExit(7)"]},
    ], repository)
    runner_quality.start(failure, str(ROOT))
    failed = wait(failure["runId"])
    failure_checks = (failed.get("result") or {}).get("checks") or []
    chk("命令失败会中止门禁并保留明确证据",
        failed.get("state") == "failed" and bool(failure_checks)
        and failure_checks[0].get("exitCode") == 7
        and "bad evidence" in failed.get("log", ""), failed)

    unsafe = run_spec("quality-smoke-unsafe", [
        {"name": "整段 shell", "argv": "echo unsafe"},
    ], repository)
    runner_quality.start(unsafe, str(ROOT))
    unsafe_done = wait(unsafe["runId"])
    chk("质量门禁拒绝整段 shell 字符串",
        unsafe_done.get("state") == "failed" and "argv" in unsafe_done.get("error", ""),
        unsafe_done)

    with open("runner_main.py", encoding="utf-8") as f:
        runner_source = f.read()
    chk("Runner 回执始终用传输层关联号覆盖业务结果里的同名 id",
        '{"op": "reply", "id": m.get("id"), **res}' not in runner_source
        and runner_source.count('{**res, "op": "reply", "id": m.get("id")}') >= 5)
finally:
    runner_scm._ready = old_ready
    shutil.rmtree(ROOT, onerror=remove_readonly)

print("\n".join(lines))
print(f"\nquality smoke: {ok} passed, {fail} failed")
raise SystemExit(1 if fail else 0)
