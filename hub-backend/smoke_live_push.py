# -*- coding: utf-8 -*-
"""Verify live session-event push and replay semantics. Advance marks only after successful send,
and exercise a real Runner process through stdout parsing to Hub persistence. Retain pull-based
recovery and server sequence deduplication.
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid

sys.path.insert(0, ".")
WORK = os.path.abspath(".smoke-livepush")

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


# Verify acknowledged-send mark semantics.
def t_marks():
    import runner_main
    from app.services import ai_local

    r = runner_main.Runner("http://127.0.0.1:9", "", "", "r-lp")
    runs = [{"ref": "ref-lp", "taskId": "t-lp", "state": "running", "seq": 2,
             "started": 1, "cli": "pi"}]
    items = [{"seq": 1, "kind": "say", "text": "第一句"},
             {"seq": 2, "kind": "do", "tool": "read", "text": "a.md"}]
    real_list, real_sess = ai_local.console_list_sync, ai_local.session_sync
    ai_local.console_list_sync = lambda cfg, allowed: {"runs": runs}
    ai_local.session_sync = lambda cfg, ref, since, limit: {
        "items": [x for x in items if x["seq"] > since]}
    try:
        sessions, advances = r._session_snapshots()
        chk("① 取样带回增量与推进建议", len(sessions) == 1
            and len(sessions[0]["items"]) == 2 and advances == [("ref-lp", 2, "running")],
            (sessions, advances))
        chk("① 取样本身不动 marks（发送成功前）", r._session_marks == {}, r._session_marks)
        sessions2, _ = r._session_snapshots()
        chk("①★发送失败（没 apply）→ 重取拿到同一段（断线不丢）",
            len(sessions2) == 1 and len(sessions2[0]["items"]) == 2, sessions2)
        r._apply_marks(advances)
        sessions3, _ = r._session_snapshots()
        chk("① apply 后再取＝空（不重复）", sessions3 == [], sessions3)
        try:
            asyncio.run(r._send_strict({"op": "x"}))
            chk("① 未连接时 _send_strict 抛错（marks 因此不会误推进）", False, "没抛")
        except Exception:
            chk("① 未连接时 _send_strict 抛错（marks 因此不会误推进）", True)
    finally:
        ai_local.console_list_sync, ai_local.session_sync = real_list, real_sess


# Exercise real Runner push into Hub persistence.
HUB = os.environ.get("SMOKE_BASE", "http://127.0.0.1:9080").rstrip("/")
CID = "u-smoke-livepush"
UID = "smoke-livepush-user"
BAD_TID = "tsmokelivepush2"
TID = "tsmokelivepush1"
RID = "runner-smoke-livepush"
SECRET = "smoke-livepush-device-secret-0123456789abcdef"


def _req(method, path, body=None):
    req = urllib.request.Request(HUB + "/api/v1" + path, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Soduwork-Device", CID)
    req.add_header("X-Soduwork-Secret", SECRET)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, data, timeout=15) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return {"httpError": e.code, "detail": e.read().decode("utf-8", "replace")[:300]}


async def _purge():
    from sqlalchemy import delete, select

    from app import automation_models as am, models
    from app.db import SessionLocal
    async with SessionLocal() as s:
        task_ids = (TID, BAD_TID)
        ids = list((await s.execute(select(am.ExecutionSession.id).where(
            am.ExecutionSession.task_id.in_(task_ids)))).scalars().all())
        if ids:
            await s.execute(delete(am.ExecutionEvent).where(
                am.ExecutionEvent.session_id.in_(ids)))
        await s.execute(delete(am.ExecutionSession).where(am.ExecutionSession.task_id.in_(task_ids)))
        await s.execute(delete(models.TaskEvent).where(models.TaskEvent.task_id.in_(task_ids)))
        await s.execute(delete(models.Task).where(models.Task.id.in_(task_ids)))
        await s.execute(delete(am.RunnerNode).where(am.RunnerNode.id == RID))
        await s.execute(delete(models.Client).where(models.Client.id == CID))
        await s.execute(delete(models.User).where(models.User.id == UID))
        await s.commit()


async def _event_count(ref: str) -> int:
    from sqlalchemy import func, select

    from app import automation_models as am
    from app.db import SessionLocal
    async with SessionLocal() as s:
        row = (await s.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.ref == ref))).scalar_one_or_none()
        if row is None:
            return 0
        return int(await s.scalar(select(func.count(am.ExecutionEvent.id)).where(
            am.ExecutionEvent.session_id == row.id)) or 0)


def _fake_pi(appdata_dir: str) -> str:
    """Create a deterministic Pi-compatible subprocess emitting real protocol lines on a schedule.
    Feed the actual stdout/parser/memory/push path rather than editing archives externally;
    isolate APPDATA to install only the test CLI fixture.
    """
    d = os.path.join(appdata_dir, "npm", "node_modules",
                     "@earendil-works", "pi-coding-agent", "dist")
    os.makedirs(d, exist_ok=True)
    cli_path = os.path.join(d, "cli.js")
    with open(cli_path, "w", encoding="utf-8") as f:
        f.write(
            "if(process.argv.indexOf('--version')>=0){console.log('0.0.0-fake');process.exit(0)}\n"
            "function say(t){console.log(JSON.stringify("
            "{assistantMessageEvent:{type:'text_end',content:t}}))}\n"
            "say('第一句：开工');\n"
            "setTimeout(function(){say('第二句：五秒后又说了一句');"
            "setTimeout(function(){process.exit(0)},800)},5000);\n")
    return cli_path


def t_live():
    from app import models
    from app.db import SessionLocal

    data_root = os.path.join(WORK, "runner-data")
    appdata_dir = os.path.join(WORK, "appdata")
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(data_root, exist_ok=True)
    fake_pi = _fake_pi(appdata_dir)
    db_loop = asyncio.new_event_loop()

    async def seed():
        from app.services import device_auth

        async with SessionLocal() as s:
            user = await s.get(models.User, UID)
            if user is None:
                user = models.User(id=UID, username="smoke_livepush",
                                   display_name="（冒烟）实况推送", is_active=True)
                s.add(user)
            else:
                user.is_active = True
            c = await s.get(models.Client, CID)
            if c is None:
                c = models.Client(id=CID, name="（冒烟）实况推送",
                                  work_root=os.path.join(WORK, "work"))
                s.add(c)
            c.secret = None
            c.secret_hash = device_auth.hash_secret(SECRET)
            device_auth.activate(c, user)
            for task_id, title in (
                (TID, "（冒烟）实况推送：假 pi 真链路"),
                (BAD_TID, "（冒烟）实况推送：失败与重试"),
            ):
                if await s.get(models.Task, task_id) is None:
                    s.add(models.Task(id=task_id, title=title,
                                      owner_client_id=CID, status="doing"))
            await s.commit()
    # One loop owns all async SQLAlchemy work.  Repeated asyncio.run() may reuse a pooled
    # asyncpg connection created by an already-closed loop and makes the Live gate flaky.
    db_loop.run_until_complete(_purge())
    db_loop.run_until_complete(seed())

    env = {**os.environ, "SODUWORK_DATA_ROOT": data_root,
           "SODUWORK_HUB": HUB, "SODUWORK_CLIENT_ID": CID, "SODUWORK_DEVICE_SECRET": SECRET,
           "SODUWORK_RUNNER_ID": RID, "SODUWORK_WORK_ROOT": os.path.join(WORK, "work"),
           "SODUWORK_RUNNER_TAGS": "soduwork-client,smoke",
           # Cross-platform deterministic Pi injection.  APPDATA only affects Windows;
           # on Linux the old test silently selected the server's real global Pi.
           "SODUWORK_BUNDLED_PI_CLI": fake_pi,
           "APPDATA": appdata_dir}
    env.pop("DATABASE_URL", None)
    env.pop("SODUWORK_RUNNER_TOKEN", None)
    env.pop("SODUWORK_RUNNER_KEY", None)
    proc = subprocess.Popen([sys.executable, "runner_main.py"], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            stdin=subprocess.DEVNULL)

    async def _say_times(tid: str) -> list:
        """Read persisted sequence and event time so polling delay is not counted as transport
        latency.
        """
        from sqlalchemy import select
        from app import automation_models as am
        from app.db import SessionLocal as SL
        async with SL() as s:
            rows = (await s.execute(select(am.ExecutionSession).where(
                am.ExecutionSession.task_id == tid))).scalars().all()
            if not rows:
                return []
            out = []
            for row in rows:
                evs = (await s.execute(select(am.ExecutionEvent).where(
                    am.ExecutionEvent.session_id == row.id,
                    am.ExecutionEvent.kind == "say"))).scalars().all()
                out.extend((int(e.seq), e.at.timestamp(), e.text) for e in evs)
            return sorted(out, key=lambda item: (item[1], item[0]))

    try:
        # Wait for confirmed Runner readiness and detected test runtime rather than sleeping blindly.
        t_wait = time.time()
        ready = False
        while time.time() - t_wait < 30:
            rs = (_req("GET", "/runners") or {}).get("runners") or []
            mine = next((x for x in rs if x.get("runnerId") == RID), None)
            if mine and mine.get("online") and any(
                    a.get("key") == "pi" for a in (mine.get("agents") or [])):
                ready = True
                break
            time.sleep(0.5)
        chk("② 假 runner 上线且假 pi 进了 agents 名单", ready)
        # Dispatch through the real HTTP API to the selected test Runner.
        # This also exercises immediate execution persistence.
        r = _req("POST", "/tasks/%s/ai-dispatch" % TID,
                 {"assigneeId": "runner:%s:pi" % RID, "assigneeType": "agent",
                  "brief": "实况推送冒烟：按时刻表说两句话"})
        chk("② 派活成功（假 pi 真链路）", bool(r.get("ok") or r.get("issueId")), r)

        seen = []
        t0 = time.time()
        while time.time() - t0 < 40:
            seen = db_loop.run_until_complete(_say_times(TID))
            if len(seen) >= 2:
                break
            time.sleep(0.3)
        if len(seen) < 2:
            # Capture Runner metadata and bounded raw output before cleanup on failure.
            base = os.path.join(data_root, "local-runs")
            for d in (os.listdir(base) if os.path.isdir(base) else []):
                mp = os.path.join(base, d, "meta.json")
                try:
                    with open(mp, encoding="utf-8") as f:
                        meta = json.load(f)
                    print("    [现场] meta:", {k: meta.get(k) for k in
                          ("state", "error", "exit", "cli", "seq", "pid")})
                except Exception as e:  # noqa: BLE001
                    print("    [现场] meta 读不到:", e)
                rp = os.path.join(base, d, "raw.log")
                if os.path.isfile(rp):
                    with open(rp, encoding="utf-8", errors="replace") as f:
                        print("    [现场] raw 头 500 字:", f.read(500))
        chk("② 两句话都到库（%d 条 say）" % len(seen), len(seen) >= 2, seen)
        expected_says = ["第一句：开工", "第二句：五秒后又说了一句"]
        chk("② 假 Pi 的两句协议输出均原样入库",
            [x[2] for x in seen[:2]] == expected_says, seen)
        if len(seen) >= 2:
            gap = seen[1][1] - seen[0][1]
            # The fixture emits messages at a known interval.
            # Persisted timing must reflect live delivery rather than heartbeat batching.
            chk("②★第二句入库时刻差 ≈5s（实测 %.1fs）：事件驱动推送，不是心跳搭车" % gap,
                3.5 <= gap <= 7.5, gap)

        # Exercise failure through the same real HTTP path and expose its reason immediately.
        # Retrying the same runtime must move the task back into execution.
        bad = _req("POST", "/tasks/%s/ai-dispatch" % BAD_TID,
                   {"assigneeId": "runner:missing-runner:pi", "assigneeType": "agent"})
        try:
            bad_detail = json.loads(bad.get("detail") or "{}").get("detail") or {}
        except (TypeError, ValueError):
            bad_detail = {}
        chk("③ 不存在的 Runner 返回结构化可重试原因",
            bad.get("httpError") == 409
            and bad_detail.get("code") == "AI_DISPATCH_FAILED"
            and bad_detail.get("phase") == "routing"
            and bad_detail.get("retryable") is True, (bad, bad_detail))
        failed_task = _req("GET", "/tasks/%s" % BAD_TID)
        chk("③ 失败状态无需整表刷新即可从单任务接口看见",
            (failed_task.get("ai") or {}).get("state") == "failed"
            and bool((failed_task.get("ai") or {}).get("error")), failed_task.get("ai"))
        retried = _req("POST", "/tasks/%s/ai-dispatch" % BAD_TID,
                       {"assigneeId": "runner:%s:pi" % RID, "assigneeType": "agent",
                        "brief": "原地重试冒烟"})
        retry_task = _req("GET", "/tasks/%s" % BAD_TID)
        chk("③ 原地重试同一个 Pi 后状态从 failed 收敛回 running",
            bool(retried.get("ok") or retried.get("issueId"))
            and (retry_task.get("ai") or {}).get("state") == "running",
            (retried, retry_task.get("ai")))
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:  # noqa: BLE001
                proc.kill()
        db_loop.run_until_complete(_purge())
        db_loop.close()
        shutil.rmtree(WORK, ignore_errors=True)


t_marks()
t_live()
print(f"\n{ok} PASS / {fail} FAIL")
sys.exit(1 if fail else 0)
