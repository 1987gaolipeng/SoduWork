"""Real HTTP + WebSocket smoke for Runner session reporting and replay.

The Runner is a separate process.  This script only prepares a production-shaped
archive, talks to the already-running backend over HTTP, and removes every test row.
No model is called and no user's Runner or task data is touched.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

import websockets
from sqlalchemy import delete, select

from app import automation_models as am
from app import models
from app.db import SessionLocal
from app.services import runner_release
from live_test_support import seed_active_device


HUB = os.environ.get("SMOKE_BASE", "http://127.0.0.1:9080").rstrip("/")
BASE = HUB + "/api/v1"
WS_BASE = ("wss://" + HUB[8:] if HUB.startswith("https://")
           else "ws://" + HUB.removeprefix("http://"))
HERE = os.path.dirname(os.path.abspath(__file__))
CID = "u-smoke-execution-live"
DEVICE_SECRET = "smoke-execution-device-secret-0123456789abcdef"
RUNNER_ID = "smoke-execution-live"
PASSED = 0
FAILED = 0


def check(name: str, ok: bool, detail=None) -> None:
    global PASSED, FAILED
    if ok:
        PASSED += 1
        print("  PASS ", name)
    else:
        FAILED += 1
        print("  FAIL ", name, detail if detail is not None else "")


def request(method: str, path: str, body=None, secret: str = ""):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Soduwork-Device", CID)
    if secret:
        req.add_header("X-Soduwork-Secret", secret)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=15) as res:
        raw = res.read()
        return json.loads(raw.decode("utf-8")) if raw else {}


async def seed_dispatch(task_id: str, ref: str) -> None:
    async with SessionLocal() as session:
        session.add(models.TaskEvent(
            task_id=task_id, kind="ai.dispatched", actor="smoke",
            detail={"ref": ref, "issueId": ref, "provider": "runner",
                    "runnerId": RUNNER_ID, "host": "SMOKE-HOST", "assigneeCli": "pi"},
        ))
        await session.commit()


def write_archive(root: str, task_id: str, ref: str) -> None:
    run_dir = os.path.join(root, "local-runs", ref)
    work_dir = os.path.join(root, "work")
    os.makedirs(run_dir, exist_ok=True)
    os.makedirs(work_dir, exist_ok=True)
    now = time.time()
    meta = {
        "cli": "pi", "cliSid": ref, "ctxWindow": 128000,
        "ctxWindowKnown": True, "detached": False, "ended": now,
        "error": "", "exit": 0, "mode": "work", "pid": 0, "ref": ref,
        "segment": 1, "seq": 3, "started": now - 3, "state": "done",
        "taskId": task_id, "title": "Runner 会话回放冒烟",
        "tokens": {"input": 120, "output": 36, "total": 156}, "ws": work_dir,
    }
    events = [
        {"kind": "step", "tool": "", "text": "第 1 步 · 正在分析", "seq": 1,
         "at": "2026-08-02T08:00:00", "seg": 1},
        {"kind": "do", "tool": "read", "text": "requirements.md", "seq": 2,
         "at": "2026-08-02T08:00:01", "seg": 1},
        {"kind": "say", "tool": "", "text": "验证完成，结果已经交付。", "seq": 3,
         "at": "2026-08-02T08:00:02", "seg": 1},
    ]
    with open(os.path.join(run_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)
    with open(os.path.join(run_dir, "base.json"), "w", encoding="utf-8") as f:
        json.dump({}, f)
    with open(os.path.join(run_dir, "events.jsonl"), "w", encoding="utf-8") as f:
        for item in events:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")


async def cleanup(task_id: str) -> bool:
    async with SessionLocal() as session:
        ids = list((await session.execute(select(am.ExecutionSession.id).where(
            am.ExecutionSession.task_id == task_id))).scalars().all())
        if ids:
            await session.execute(delete(am.ExecutionEvent).where(
                am.ExecutionEvent.session_id.in_(ids)))
        await session.execute(delete(am.ExecutionSession).where(
            am.ExecutionSession.task_id == task_id))
        await session.execute(delete(models.TaskEvent).where(models.TaskEvent.task_id == task_id))
        await session.execute(delete(models.Task).where(models.Task.id == task_id))
        await session.execute(delete(models.Client).where(models.Client.id == CID))
        # Clean up persisted Runner registrations as well as other live-test records.
        # Otherwise test machines could appear as real rows in usage reports.
        await session.execute(delete(am.RunnerNode).where(am.RunnerNode.id == RUNNER_ID))
        await session.commit()
    async with SessionLocal() as session:
        return (await session.get(models.Client, CID)) is None and (
            await session.get(models.Task, task_id)) is None and (
            await session.get(am.RunnerNode, RUNNER_ID)) is None


async def terminal_roundtrip(task_id: str, secret: str) -> tuple[dict, str]:
    """Use the same terminal WebSocket as the desktop client."""
    url = (WS_BASE + "/api/v1/term"
           f"?device={CID}&secret={secret}&task={task_id}"
           f"&host={RUNNER_ID}&mode=shell&cols=96&rows=28")
    ready: dict = {}
    output: list[str] = []
    token = "SODUWORK_TERM_LIVE_OK"
    async with websockets.connect(url, max_size=8 * 1024 * 1024) as ws:
        deadline = time.time() + 6
        while time.time() < deadline and not ready:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=6))
            if msg.get("t") == "ready":
                ready = dict(msg.get("d") or {})
            elif msg.get("t") == "err":
                return {}, str(msg.get("d") or "")
            elif msg.get("t") == "o":
                output.append(str(msg.get("d") or ""))
        # The full marker is deliberately absent from the typed command.  This
        # proves the platform shell executed it instead of merely echoing input.
        if os.name == "nt":
            first = "set SODUWORK_PART=SODUWORK_TERM_\r"
            second = "echo %SODUWORK_PART%LIVE_OK\r"
        else:
            first = "SODUWORK_PART=SODUWORK_TERM_\r"
            second = "printf '%s%s\\n' \"$SODUWORK_PART\" LIVE_OK\r"
        await ws.send(json.dumps({"t": "i", "d": first}))
        await asyncio.sleep(0.25)
        await ws.send(json.dumps({"t": "i", "d": second}))
        deadline = time.time() + 8
        while time.time() < deadline and token not in "".join(output):
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
            except asyncio.TimeoutError:
                continue
            if msg.get("t") == "o":
                output.append(str(msg.get("d") or ""))
            elif msg.get("t") == "err":
                output.append(str(msg.get("d") or ""))
                break
        await ws.send(json.dumps({"t": "kill"}))
    return ready, "".join(output)


async def main() -> int:
    task_id = ""
    secret = DEVICE_SECRET
    proc = None
    log_file = None
    with tempfile.TemporaryDirectory(prefix="soduwork-live-session-") as tmp:
        try:
            await cleanup("")
            async with SessionLocal() as session:
                await seed_active_device(
                    session, CID, secret, name="（冒烟）执行会话",
                    platform="live-smoke", app_version="1.4.0",
                    work_root=os.path.join(tmp, "work"))
                await session.commit()
            check("真鉴权·临时设备按生产形状激活且只存密钥摘要", True)
            task = request("POST", "/tasks", {
                "title": "Runner 会话回放冒烟", "note": "不调用模型", "status": "doing",
            }, secret)
            task_id = str(task.get("id") or "")
            check("真接口·测试任务建立", bool(task_id), task)
            ref = str(uuid.uuid4())
            await seed_dispatch(task_id, ref)
            data_root = os.path.join(tmp, "runner-data")
            write_archive(data_root, task_id, ref)
            config = {
                "hub": HUB, "clientId": CID, "secret": secret,
                "workRoot": os.path.join(tmp, "work"), "dataRoot": data_root,
                "tags": ["soduwork-client", "smoke"],
            }
            config_path = os.path.join(tmp, "runner.json")
            with open(config_path, "w", encoding="utf-8") as f:
                json.dump(config, f)
            try:
                os.chmod(config_path, 0o600)
            except OSError:
                pass
            log_file = open(os.path.join(tmp, "runner.log"), "w+", encoding="utf-8")
            runner_env = dict(os.environ)
            # The one-off Hub container may inherit the server Runner's tags.  The temporary
            # client must prove that its own JSON configuration wins in a clean client process.
            runner_env.pop("SODUWORK_RUNNER_TAGS", None)
            if os.name == "nt":
                # Reproduce the packaged Electron environment that triggered
                # `cmd.exe not found`: no System32 in PATH and no ComSpec hint.
                runner_env["PATH"] = os.path.dirname(sys.executable)
                runner_env.pop("ComSpec", None)
                runner_env.pop("COMSPEC", None)
            proc = subprocess.Popen(
                [sys.executable, os.path.join(HERE, "runner_main.py"), "--config", config_path,
                 "--id", RUNNER_ID], cwd=HERE, stdin=subprocess.DEVNULL,
                stdout=log_file, stderr=subprocess.STDOUT, text=True,
                creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
                env=runner_env,
            )
            runners = []
            for _ in range(40):
                try:
                    runners = request("GET", "/runners", secret=secret).get("runners") or []
                    # Runner inventory now survives disconnects.  A persisted offline row is
                    # not enough for the terminal roundtrip; wait for this process's live socket.
                    if any(x.get("runnerId") == RUNNER_ID
                           and x.get("version") == runner_release.RUNNER_VERSION
                           and x.get("online") and x.get("embedded") is True
                           and "smoke" in (x.get("tags") or [])
                           for x in runners):
                        break
                except Exception:
                    pass
                await asyncio.sleep(0.25)
            check("真链路·新版 Runner 通过 WebSocket 上线", any(
                x.get("runnerId") == RUNNER_ID
                and x.get("version") == runner_release.RUNNER_VERSION
                and x.get("online") and x.get("embedded") is True
                and "smoke" in (x.get("tags") or [])
                for x in runners), runners)
            term_ready, term_output = await terminal_roundtrip(task_id, secret)
            shell = str(term_ready.get("shell") or "")
            check("真链路·当前平台能打开 Runner 真实终端",
                  bool(term_ready.get("alive")) and bool(shell)
                  and (os.name != "nt" or shell.lower().endswith("cmd.exe")),
                  term_ready or term_output[-500:])
            check("真链路·终端输入被真实执行并回传，不是只读日志",
                  "SODUWORK_TERM_LIVE_OK" in term_output, term_output[-500:])
            replay = {}
            for _ in range(40):
                try:
                    replay = request("GET", f"/tasks/{task_id}/ai-session?since=0", secret=secret)
                    if replay.get("ok") and len(replay.get("items") or []) == 3:
                        break
                except Exception as e:
                    replay = {"error": str(e)}
                await asyncio.sleep(0.25)
            check("真链路·客户端接口拿到完整结构化会话", replay.get("ok")
                  and [x.get("seq") for x in replay.get("items") or []] == [1, 2, 3], replay)
            inc = request("GET", f"/tasks/{task_id}/ai-session?since=2", secret=secret)
            check("真链路·断线续读只返回水位之后事件", inc.get("ok")
                  and [x.get("seq") for x in inc.get("items") or []] == [3], inc)
            check("真链路·执行机、底座、目录与终态齐全", replay.get("runnerId") == RUNNER_ID
                  and replay.get("engine") == "pi" and replay.get("status") == "done"
                  and bool(replay.get("workDir")), replay)
        finally:
            if proc is not None and proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
            if log_file is not None:
                log_file.close()
            if task_id:
                try:
                    request("DELETE", "/tasks/" + task_id, secret=secret)
                except (OSError, urllib.error.HTTPError):
                    pass
            check("清理·测试任务、会话和设备均已还原", await cleanup(task_id))
    print(f"\n{PASSED} 通过 / {FAILED} 失败")
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
