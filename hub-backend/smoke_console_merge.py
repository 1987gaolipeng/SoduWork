# -*- coding: utf-8 -*-
"""Regression checks for execution console and conversation routing."""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

DB = os.path.abspath(".smoke-console.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import execution_sessions  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra) if extra else ""))


async def main():
    await init_db()
    now = datetime.now(timezone.utc)
    async with SessionLocal() as s:
        s.add_all([
            models.Client(id="c-me", name="我的机器"),
            models.Client(id="c-other", name="别人的机器"),
            models.Task(id="t1", title="做个官网", status="doing", owner_client_id="c-me"),
            models.Task(id="t2", title="改个 bug", status="doing", owner_client_id="c-me"),
            models.Task(id="t3", title="别人的活", status="doing", owner_client_id="c-other"),
        ])
        s.add(am.ExecutionSession(
            id="es1", task_id="t1", ref="runner:rn-a:pi#1", runner_id="rn-a",
            runner_client_id="c-me", host="DESKTOP-FIXTURE", engine="pi",
            model="deepseek-v3", state="running", seq=12, work_dir="D:/work/site",
            started_at=now - timedelta(minutes=5),
            metadata_={"tokens": {"input": 8000, "output": 900}, "ctxPct": 6.4,
                       "ctxWindow": 800000, "ctxWindowKnown": True, "segment": 2}))
        s.add(am.ExecutionSession(
            id="es2", task_id="t2", ref="runner:rn-b:opencode#7", runner_id="rn-b",
            runner_client_id="c-me", host="abcdef012345", engine="opencode",
            state="done", seq=3, started_at=now - timedelta(hours=2),
            finished_at=now - timedelta(hours=1), metadata_={"error": ""}))
        s.add(am.ExecutionSession(
            id="es3", task_id="t3", ref="runner:rn-a:pi#9", runner_id="rn-a",
            runner_client_id="c-other", host="DESKTOP-FIXTURE", engine="pi",
            state="running", seq=1, started_at=now))
        await s.commit()

        rows = await execution_sessions.console_rows(s, "c-me")
        refs = [r["ref"] for r in rows]
        chk("★runner 上的会话真的出现在控制台一览里", len(rows) == 2, refs)
        chk("★不是自己的活不给看", "runner:rn-a:pi#9" not in refs, refs)
        chk("在跑的排在前面", refs and refs[0] == "runner:rn-a:pi#1", refs)

        live = rows[0]
        chk("★状态是 running（「叫停」按钮就是靠它才渲染的）", live["state"] == "running", live["state"])
        chk("带着任务标题", live["title"] == "做个官网", live["title"])
        chk("带着 CLI 名", live["cli"] == "pi", live["cli"])
        chk("带着水位与 token", live["ctxPct"] == 6.4 and live["tokens"]["input"] == 8000, live)
        chk("带着真实上下文窗口而不是默认值", live["ctxWindow"] == 800000 and live["ctxWindowKnown"], live)
        chk("带着工作目录（「打开产出目录」靠它）", live["workDir"] == "D:/work/site", live["workDir"])
        chk("★标明了是哪台机器在干", live["runnerId"] == "rn-a" and live["host"] == "DESKTOP-FIXTURE", live)
        chk("标明了用的哪个模型", live["model"] == "deepseek-v3", live["model"])
        chk("标明了不是本机会话", live["local"] is False, live["local"])
        chk("开始时间是秒级时间戳（和本机那份对齐）",
            isinstance(live["started"], float) and live["started"] > 1_000_000_000, live["started"])
        done = rows[1]
        chk("干完的会话也留着（能回看）", done["state"] == "done" and done["ended"] > 0, done)

        # Deduplicate sessions already present locally by execution ref.
        rows2 = await execution_sessions.console_rows(
            s, "c-me", exclude_refs={"runner:rn-a:pi#1"})
        chk("★本机已列出的会话不再重复", [r["ref"] for r in rows2] == ["runner:rn-b:opencode#7"],
            [r["ref"] for r in rows2])

        rows3 = await execution_sessions.console_rows(s, "c-me", limit=1)
        chk("条数上限有效（这接口前端每两秒问一次）", len(rows3) == 1, rows3)

    print("\nconsole merge smoke: %d passed, %d failed" % (ok, fail))
    return 1 if fail else 0


sys.exit(asyncio.run(main()))
