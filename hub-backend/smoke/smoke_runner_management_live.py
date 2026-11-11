# -*- coding: utf-8 -*-
"""Test Runner management through real HTTP/WebSocket traffic and remove temporary nodes and
devices.
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from sqlalchemy import delete

sys.path.insert(0, ".")
from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from live_test_support import seed_active_device  # noqa: E402

BASE = os.environ.get("SMOKE_BASE", "http://127.0.0.1:9080").rstrip("/") + "/api/v1"
CID = "u-smoke-runner-manage-live"
SECRET = "runner-manage-live-device-secret-0123456789abcdef"
RID = "runner-smoke-manage-live"
ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    print(("PASS  " if cond else "FAIL  ") + name + ((" << " + str(extra)[:240]) if extra and not cond else ""))
    ok += int(bool(cond)); fail += int(not cond)


def http(path, method="GET", body=None, timeout=20):
    data = json.dumps(body or {}).encode("utf-8") if method != "GET" else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("X-Soduwork-Device", CID)
    req.add_header("X-Soduwork-Secret", SECRET)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {"detail": e.read().decode("utf-8", "replace")[:300]}
    except Exception as e:  # noqa: BLE001
        return 0, {"detail": type(e).__name__ + ": " + str(e)[:200]}


async def seed():
    async with SessionLocal() as s:
        await s.execute(delete(am.RunnerNode).where(am.RunnerNode.id == RID))
        await seed_active_device(
            s, CID, SECRET, name="（冒烟）Runner 管理",
            platform="live-smoke", app_version="live-gate")
        await s.commit()


async def purge():
    async with SessionLocal() as s:
        await s.execute(delete(am.RunnerNode).where(am.RunnerNode.id == RID))
        row = await s.get(models.Client, CID)
        if row is not None:
            await s.delete(row)
        await s.commit()


def find_node(payload):
    return next((x for x in (payload.get("runners") or []) if x.get("runnerId") == RID), None)


async def main():
    await seed()
    tmp = tempfile.mkdtemp(prefix="soduwork-runner-live-")
    # Windows virtualenv Python can launch an additional interpreter process.
    # Use the base interpreter with virtualenv packages so cleanup owns one actual Runner process.
    run_env = os.environ.copy()
    site = os.path.join(sys.prefix, "Lib", "site-packages")
    run_env["PYTHONPATH"] = site + (os.pathsep + run_env["PYTHONPATH"] if run_env.get("PYTHONPATH") else "")
    proc = subprocess.Popen([
        getattr(sys, "_base_executable", sys.executable), "runner_main.py", "--hub",
        os.environ.get("SMOKE_BASE", "http://127.0.0.1:9080").rstrip("/"),
        "--client", CID, "--secret", SECRET, "--id", RID,
        "--work-root", tmp, "--data-root", os.path.join(tmp, "data"), "--tags", "dev,smoke",
    ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=run_env,
       creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    try:
        node = None
        for _ in range(40):
            status, payload = http("/runners", timeout=5)
            node = find_node(payload) if status == 200 else None
            if node and node.get("online"):
                break
            await asyncio.sleep(.25)
        chk("真链路·Runner 经 WebSocket 上线并登记", bool(node and node.get("online")), node)
        chk("真链路·工作目录与标签来自执行机", node and node.get("workRoot") == tmp
            and {"dev", "smoke"} <= set(node.get("tags") or []), node)

        status, probe = http("/runners/" + RID + "/probe", "POST", {}, 20)
        chk("真链路·就地探活得到 Runner 真回执", status == 200 and probe.get("ok") is True
            and (probe.get("data") or {}).get("runnerId") == RID, probe)
        chk("真链路·探活包含延迟和磁盘余量", probe.get("latencyMs", -1) >= 0
            and (probe.get("data") or {}).get("freeBytes", 0) > 0, probe)

        status, changed = http("/runners/" + RID + "/mode", "POST", {"mode": "draining"})
        _, payload = http("/runners")
        node = find_node(payload)
        chk("真链路·暂停接单立即生效", status == 200 and changed.get("mode") == "draining"
            and node and node.get("accepting") is False, (changed, node))

        status, changed = http("/runners/" + RID + "/mode", "POST", {"mode": "accepting"})
        _, payload = http("/runners")
        node = find_node(payload)
        chk("真链路·恢复接单立即生效", status == 200 and node and node.get("accepting") is True, node)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill(); proc.wait(timeout=5)
        for _ in range(40):
            _, payload = http("/runners", timeout=3)
            node = find_node(payload)
            if node and not node.get("online"):
                break
            await asyncio.sleep(.25)
        chk("真链路·离线后节点仍可管理", bool(node and not node.get("online")), node)
        await purge()
        shutil.rmtree(tmp, ignore_errors=True)
    print("\n%d 通过 / %d 失败" % (ok, fail))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
