# -*- coding: utf-8 -*-
"""Offline tests for controlled commit/environment placeholder expansion in shell=False deployment
argv. Values come only from the selected deployment run.
"""
import os
import sys

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///.smoke-argv.db")
sys.path.insert(0, ".")

from app.services import runner_deploy as R  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra) if extra else ""))


SPEC = {"commit": "ed5b70f9c1", "environmentKey": "production"}

got = R._argv(["ssh", "root@h", "deploy.sh {env} {commit}"], "部署命令", SPEC)
chk("commit 与 env 都被替换", got[-1] == "deploy.sh production ed5b70f9c1", got)
chk("其它参数原样不动", got[:2] == ["ssh", "root@h"], got)

got = R._argv(["a", "b"], "部署命令", SPEC)
chk("没有占位符时一个字都不改", got == ["a", "b"], got)

got = R._argv(["x {commit} y {commit}"], "部署命令", SPEC)
chk("同一个占位符出现多次都替换", got == ["x ed5b70f9c1 y ed5b70f9c1"], got)

try:
    R._argv(["deploy.sh {commit}"], "部署命令", {"commit": "", "environmentKey": "test"})
    chk("★没有 commit 却用了 {commit} → 必须报错，不能发成空", False)
except ValueError as e:
    chk("★没有 commit 却用了 {commit} → 报错拦住", "{commit}" in str(e), e)

try:
    R._argv([], "部署命令", SPEC)
    chk("空 argv 仍被拒", False)
except ValueError:
    chk("空 argv 仍被拒", True)

try:
    R._argv(["s {env}"], "部署命令", None)
    chk("没传 spec 又用占位符 → 报错（不静默发错环境）", False)
except ValueError:
    chk("没传 spec 又用占位符 → 报错（不静默发错环境）", True)

print("\ndeploy argv smoke: %d passed, %d failed" % (ok, fail))
sys.exit(1 if fail else 0)
