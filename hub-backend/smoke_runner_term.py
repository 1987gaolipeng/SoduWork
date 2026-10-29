# -*- coding: utf-8 -*-
"""Regression checks for public module contracts."""
import asyncio
import io
import json
import re
import subprocess
import sys
import time
import urllib.request
import os
import socket
import shutil

sys.path.insert(0, ".")
WORK = os.path.abspath(".smoke-runner-term")
shutil.rmtree(WORK, ignore_errors=True)
os.makedirs(WORK, exist_ok=True)
os.environ["SODUWORK_DATA_ROOT"] = os.path.join(WORK, "server-data")
os.environ["DATABASE_URL"] = (
    "sqlite+aiosqlite:///" + os.path.join(WORK, "hub.db").replace("\\", "/"))
os.environ["DB_MIGRATION_MODE"] = "auto"

import websockets  # noqa: E402

from app import models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402

ok = fail = 0
log = []
HUB = ""
WS = ""
CID = "u-smoke-runner"
UID = "user-smoke-runner"
TID = "tsmokerunner01"
SECRET = os.environ.get("SMOKE_SECRET", "smoke-runner-device-secret-0123456789abcdef")
TOKEN = "SODUWORK_TERM_OK"
SEEDED_REF = ""


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        log.append("  PASS  " + name)
    else:
        fail += 1
        log.append("  FAIL  " + name + ("  << " + str(extra)[:400] if extra else ""))


async def seed():
    await init_db()
    os.makedirs(WORK, exist_ok=True)
    async with SessionLocal() as s:
        user = await s.get(models.User, UID)
        if user is None:
            user = models.User(id=UID, username=UID, display_name="终端冒烟用户",
                               is_active=True)
            s.add(user)
        c = await s.get(models.Client, CID)
        if c is None:
            c = models.Client(id=CID)
            s.add(c)
        from app.services import device_auth
        c.secret = None
        c.secret_hash = device_auth.hash_secret(SECRET)
        c.auth_state = "active"
        c.user_ref = UID
        c.work_root = WORK
        t = await s.get(models.Task, TID)
        if t is None:
            t = models.Task(id=TID, title="（冒烟）执行机终端", owner_client_id=CID)
            s.add(t)
        t.owner_client_id = CID
        await s.commit()


async def purge():
    from sqlalchemy import delete, select

    from app import automation_models as am
    async with SessionLocal() as s:
        for m, i in ((models.Task, TID), (models.Client, CID)):
            row = await s.get(m, i)
            if row is not None:
                await s.delete(row)
        # Test-started Runners create persisted node and execution records.
        # Remove those records so live tests do not leave fake machines in usage reports.
        ids = list((await s.execute(select(am.ExecutionSession.id).where(
            am.ExecutionSession.task_id == TID))).scalars().all())
        if ids:
            await s.execute(delete(am.ExecutionEvent).where(
                am.ExecutionEvent.session_id.in_(ids)))
        await s.execute(delete(am.ExecutionSession).where(am.ExecutionSession.task_id == TID))
        await s.execute(delete(models.TaskEvent).where(models.TaskEvent.task_id == TID))
        await s.execute(delete(am.RunnerNode).where(am.RunnerNode.id == "runner-smoke-term"))
        user = await s.get(models.User, UID)
        if user is not None:
            await s.delete(user)
        await s.commit()


def start_smoke_hub():
    """Run an isolated real Hub process; never point this smoke at a business database."""
    global HUB, WS
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    HUB = "http://127.0.0.1:%d" % port
    WS = "ws://127.0.0.1:%d/api/v1/term" % port
    log_file = open(os.path.join(WORK, "hub.log"), "w", encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
         "--port", str(port), "--log-level", "warning"],
        cwd=os.path.dirname(os.path.abspath(__file__)), env=dict(os.environ),
        stdin=subprocess.DEVNULL, stdout=log_file, stderr=subprocess.STDOUT,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(120):
        if proc.poll() is not None:
            break
        try:
            with opener.open(HUB + "/healthz", timeout=1) as response:
                if response.status == 200:
                    return proc, log_file
        except Exception:  # noqa: BLE001
            time.sleep(0.1)
    log_file.flush()
    raise RuntimeError("隔离后端没有在 12 秒内启动：" + os.path.join(WORK, "hub.log"))


async def seed_dispatch() -> str:
    """Create isolated dispatch and archive facts for a Pi session and return its session ID."""
    import uuid

    from app.services import task_events

    ref = str(uuid.uuid4())
    ws_dir = WORK
    os.makedirs(ws_dir, exist_ok=True)
    # Place the fixture archive beneath the independent Runner's data root.
    # A backend-only archive could hide remote fallback to an ordinary shell.
    d = os.path.join(WORK, "runner-data", "local-runs", ref)
    os.makedirs(d, exist_ok=True)
    # Match actual metadata keys and populate only required fields.
    meta = {"cli": "pi", "cliSid": "", "ctxWindow": 0, "ctxWindowKnown": False,
            "detached": False, "ended": 0, "error": "", "exit": 0, "mode": "work",
            "pid": 0, "ref": ref, "segment": 0, "seq": 1, "started": int(time.time()),
            "state": "done", "taskId": TID, "title": "（冒烟）执行机终端",
            "tokens": 0, "ws": ws_dir}
    with io.open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
        f.write(json.dumps(meta, ensure_ascii=False))
    async with SessionLocal() as s:
        task_events.record(s, TID, "ai.dispatched",
                           {"ref": ref, "issueId": ref, "by": "smoke"}, actor="smoke")
        await s.commit()
    return ref


def start_smoke_runner():
    """Start an isolated Runner rather than depending on a manually running developer process."""
    os.makedirs(WORK, exist_ok=True)
    log_file = open(os.path.join(WORK, "runner.log"), "w", encoding="utf-8")
    argv = [
        sys.executable, "runner_main.py", "--hub", HUB,
        "--client", CID, "--secret", SECRET, "--id", "runner-smoke-term",
        "--work-root", WORK, "--data-root", os.path.join(WORK, "runner-data"),
    ]
    proc = subprocess.Popen(
        argv, cwd=os.path.dirname(os.path.abspath(__file__)),
        stdin=subprocess.DEVNULL, stdout=log_file, stderr=subprocess.STDOUT,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    return proc, log_file


def runners():
    """Use only HTTP/WebSocket calls to the running backend so it owns the PTY lifetime."""
    import urllib.error
    try:
        req = urllib.request.Request(HUB + "/api/v1/runners")
        req.add_header("X-Soduwork-Device", CID)
        req.add_header("X-Soduwork-Secret", SECRET)
        op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with op.open(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8")).get("runners", [])
    except Exception:  # noqa: BLE001
        return []


async def open_term(host: str, mode: str = "shell", quiet_secs: float = 3.0,
                    ready_secs: float = 25.0):
    """Wait for ready with its own startup deadline, then collect output for quiet_secs. Separating
    budgets prevents slow cold starts from becoming test-induced connection failures.
    """
    url = (f"{WS}?device={CID}&secret={SECRET}&task={TID}&cols=100&rows=30&mode={mode}"
           + (f"&host={host}" if host else ""))
    ws = await websockets.connect(url, max_size=8 * 1024 * 1024)
    ready, buf, err = None, [], None
    t0 = time.time()
    while ready is None and err is None and time.time() - t0 < ready_secs:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=ready_secs)
        except asyncio.TimeoutError:
            break
        m = json.loads(raw)
        if m.get("t") == "ready":
            ready = m.get("d")
        elif m.get("t") == "o":
            buf.append(m.get("d") or "")
        elif m.get("t") == "err":
            err = m.get("d")
    t1 = time.time()
    while err is None and time.time() - t1 < quiet_secs:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=quiet_secs)
        except asyncio.TimeoutError:
            break
        m = json.loads(raw)
        if m.get("t") == "o":
            buf.append(m.get("d") or "")
        elif m.get("t") == "err":
            err = m.get("d")
    return ready, "".join(buf), err, ws


async def type_and_read(ws, text: str, secs: float = 6.0) -> str:
    await ws.send(json.dumps({"t": "i", "d": text}))
    buf = []
    t0 = time.time()
    while time.time() - t0 < secs:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=secs)
        except asyncio.TimeoutError:
            break
        m = json.loads(raw)
        if m.get("t") == "o":
            buf.append(m.get("d") or "")
            if TOKEN in "".join(buf)[len(text):]:
                break
    return "".join(buf)


async def main(seeded=False):
    if not seeded:
        await seed()
    rs = runners()
    chk("有在线的执行机（没有就先跑 runner_main.py）", bool(rs), rs)
    if not rs:
        return
    rid = rs[0]["runnerId"]
    log.append("  ----  执行机 %s @ %s" % (rid, rs[0].get("host")))

    # Verify the existing local terminal path.
    lready, lout, lerr, lws = await open_term("", "shell")
    chk("★本机终端照常能开（回归：这一版不许把老路改坏）", lerr is None and lready, (lerr, lready))
    lecho = await type_and_read(lws, "echo %s\r" % TOKEN)
    chk("本机终端敲字有反应", TOKEN in lecho, lecho[-160:])
    await lws.send(json.dumps({"t": "kill"}))
    await lws.close()

    # Verify remote Runner forwarding.
    rready, rout, rerr, rws = await open_term(rid, "shell")
    chk("★★经 runner 开出终端", rerr is None and rready is not None, (rerr, rready))
    if rready is None:
        return
    chk("ready 里带着是哪台机器开的", bool(rready.get("host")), rready)
    chk("★两条路给出的 ready 形状一致（同一份 term.info()）",
        set(rready.keys()) >= (set(lready.keys()) if lready else set()),
        (sorted(rready.keys()), sorted((lready or {}).keys())))

    # Require real PTY behavior rather than line-oriented logs.
    # Check ANSI control sequences from terminal initialization.
    chk("★★真的是 PTY —— 输出里有 ANSI 控制序列（不是被清洗过的日志）",
        "\x1b" in rout, repr(rout[:160]))

    # Verify input actually executes and returns output.
    recho = await type_and_read(rws, "echo %s\r" % TOKEN)
    chk("★★敲字进去真的跑了，输出回来了（真交互，不是只读）",
        TOKEN in recho, repr(recho[-200:]))

    # Resize the terminal through the browser protocol.
    await rws.send(json.dumps({"t": "size", "cols": 120, "rows": 40}))
    await asyncio.sleep(0.6)
    alive = await type_and_read(rws, "echo %s\r" % TOKEN, secs=6.0)
    chk("改完窗口大小还能接着用", TOKEN in alive, repr(alive[-160:]))

    # Disconnect and reconnect without destroying the PTY.
    await rws.close()
    await asyncio.sleep(1.0)
    r2ready, r2out, r2err, r2ws = await open_term(rid, "shell", quiet_secs=2.5)
    chk("★断开再连回来，终端还在（没被关掉）", r2err is None and r2ready is not None,
        (r2err, r2ready))
    chk("★重连能看到刚才的画面（回放）", TOKEN in r2out, repr(r2out[-200:]))
    # Smoke cleanup: do not leave a test PTY keeping runner.busy at 1.
    await r2ws.send(json.dumps({"t": "kill"}))
    await r2ws.close()


    # Create a synthetic dispatch event and archived meta.json to represent an earlier dispatch.
    # Match the production metadata keys and populate only cli.
    # Leave cliSid empty to exercise the own_session fallback; Pi uses ref as the session ID.
    # This also matches legacy archives. Pi creates a session when the requested ID does not exist,
    # so the test starts a real Pi TUI without accessing any user's actual session.
    has_pi = any(a.get("key") == "pi" for a in (rs[0].get("agents") or []))
    if not has_pi:
        log.append("  --    （这台执行机没装 Pi，真实 Pi 会话断言跳过；真 PTY/输入/重连已验）")
    else:
        sid = SEEDED_REF
        sready, sout, serr, sws = await open_term(rid, "session", quiet_secs=8.0)
        chk("★★会话控制台经 runner 开起来了", serr is None and sready is not None, (serr, sready))
        if sready is not None:
            chk("★★回的 mode 真是 session（退回 shell 的话这儿会是 shell）",
                sready.get("mode") == "session", sready)
            chk("★★起的是这条活自己的 CLI（pi），不是随便一个 shell",
                "pi" in str(sready.get("cmd") or "").lower() or
                "pi" in str(sready.get("cli") or "").lower(), sready)
            plain = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", sout)
            plain = re.sub(r"\x1b[78]", "", plain)
            if "上面是上一段终端的记录" in plain:
                plain = plain.rsplit("上面是上一段终端的记录", 1)[-1]
            chk("★★会话终端里没有 shell 的启动失败（带空格的 exe 路径最容易中）",
                not any(k in plain for k in ("语法不正确", "syntax is incorrect",
                                             "不是内部或外部命令", "is not recognized")),
                repr(plain[:200]))
            chk("★★那个 CLI 真的起来了（看得到它自己的动静，不只是 ConPTY 的初始化）",
                ("]0;pi" in sout) or ("session" in plain.lower()), repr(plain[:200]))
            chk("★命令行里带着这条活的会话 id（接的是它那条会话）",
                sid[:8] in str(sready.get("cmd") or ""), (sid[:8], sready.get("cmd")))
        await sws.send(json.dumps({"t": "kill"}))
        await sws.close()

    # An unavailable Runner returns an actionable error rather than waiting indefinitely.
    _, _, e3, w3 = await open_term("no-such-runner", "shell", quiet_secs=2.0)
    chk("指了台不在线的执行机 → 明说，不干等", bool(e3) and "不在线" in str(e3), e3)
    await w3.close()

    await asyncio.sleep(1.0)
    after = next((x for x in runners() if x.get("runnerId") == rid), {})
    chk("runner releases test terminal load immediately", int(after.get("busy") or 0) == 0, after)

async def guarded_main():
    global SEEDED_REF
    proc = log_file = hub_proc = hub_log = None
    try:
        await seed()
        SEEDED_REF = await seed_dispatch()
        hub_proc, hub_log = start_smoke_hub()
        proc, log_file = start_smoke_runner()
        for _ in range(30):
            if any(x.get("runnerId") == "runner-smoke-term" for x in runners()):
                break
            await asyncio.sleep(0.2)
        await main(seeded=True)
    finally:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
        if log_file is not None:
            log_file.close()
        if hub_proc is not None and hub_proc.poll() is None:
            hub_proc.terminate()
            try:
                hub_proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                hub_proc.kill()
                hub_proc.wait(timeout=5)
        if hub_log is not None:
            hub_log.close()
        await purge()
        async with SessionLocal() as s:
            chk("★冒烟数据清干净了",
                await s.get(models.Task, TID) is None and await s.get(models.Client, CID) is None)
        await engine.dispose()
        if not fail:
            shutil.rmtree(WORK, ignore_errors=True)


asyncio.run(guarded_main())
log.append("")
log.append("PASS=%d FAIL=%d" % (ok, fail))
with io.open("smoke_runner_term.out.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(log))
print("PASS=%d FAIL=%d" % (ok, fail))
sys.exit(1 if fail else 0)
