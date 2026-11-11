# -*- coding: utf-8 -*-
"""Offline semantic JavaScript-step tests: derive package-manager commands from packageManager
before lockfiles, falling back to npm. Stale locks must not override explicit migration intent.
"""
import os
import shutil
import sys
import tempfile

sys.path.insert(0, ".")

from app.services.runner_quality import _detect_pm, _resolve_step  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:200] if extra else ""))


def _dir(files: dict) -> str:
    d = tempfile.mkdtemp(prefix="gs-")
    for rel, content in files.items():
        with open(os.path.join(d, rel), "w", encoding="utf-8") as f:
            f.write(content)
    return d


dirs = []
try:
    d = _dir({"package.json": '{"packageManager":"pnpm@10.33.0"}',
              "package-lock.json": "{}"})
    dirs.append(d)
    chk("★packageManager 字段优先于残留 lockfile(迁 pnpm 的真实事故)",
        _detect_pm(d) == "pnpm", _detect_pm(d))

    d = _dir({"yarn.lock": "#"})
    dirs.append(d)
    chk("无声明按 lockfile 推断(yarn)", _detect_pm(d) == "yarn")

    d = _dir({})
    dirs.append(d)
    chk("啥都没有兜底 npm", _detect_pm(d) == "npm")

    d = _dir({"package.json": "{"})
    dirs.append(d)
    chk("package.json 坏了不炸,回落推断", _detect_pm(d) == "npm")

    d_npm = _dir({})
    dirs.append(d_npm)
    r = _resolve_step(["js:install"], d_npm)
    chk("js:install 翻成 npm install --no-save(容忍过期 lock 且不改写)",
        r[1:] == ["install", "--no-save"] and "npm" in os.path.basename(r[0]).lower(), r)

    d_pnpm = _dir({"pnpm-lock.yaml": "#"})
    dirs.append(d_pnpm)
    r = _resolve_step(["js:install"], d_pnpm)
    chk("★pnpm 的 js:install 带 --lockfile=false(不生成第二套锁)",
        r[-1] == "--lockfile=false", r)

    r = _resolve_step(["js:what"], d_npm)
    chk("未知 js:* 原样保留(明确失败好过静默跳过)", r == ["js:what"], r)

    r = _resolve_step(["git", "diff", "--check"], d_npm)
    chk("非 js:* 命令原样不动", r == ["git", "diff", "--check"], r)

    r = _resolve_step(["js:build"], d_npm)
    chk("Windows 上首词解析成真实可执行路径(裸名 CreateProcess 找不到 .cmd)",
        os.path.isabs(r[0]) or shutil.which(r[0]) is not None, r)
finally:
    for d in dirs:
        shutil.rmtree(d, ignore_errors=True)

print(f"\n{ok} PASS / {fail} FAIL")
sys.exit(1 if fail else 0)
