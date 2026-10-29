# -*- coding: utf-8 -*-
"""Delivery-board tests require one latest attempt per task, one group per task, and a
recent-completion window. Successful reruns must not inherit obsolete failed-gate intervention
state.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

DB = os.path.abspath(".smoke-delivery-board.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import delivery_board  # noqa: E402

ok = fail = 0
NOW = datetime.now(timezone.utc)


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:200] if extra else ""))


def at(minutes_ago):
    return NOW - timedelta(minutes=minutes_ago)


async def main():
    await init_db()
    async with SessionLocal() as s:
        s.add(am.Plugin(id="pl", key="gerrit-autopilot", name="Gerrit 全自动交付"))
        s.add(am.PluginVersion(id="pv", plugin_id="pl", version="1.0.0", checksum="x",
                               workflow={"nodes": [{"key": "implement", "name": "改代码", "type": "ai"},
                                                   {"key": "publish", "name": "建版本并部署",
                                                    "type": "publish"}]}))
        s.add(am.PluginBinding(id="b", plugin_id="pl", version_id="pv", enabled=True))

        # Failed workflows require attention.
        s.add(models.Task(id="t-bad", title="发布没成的活", status="doing", owner_client_id="c1"))
        s.add(am.WorkflowRun(id="r-bad", task_id="t-bad", plugin_id="pl", plugin_version_id="pv",
                             binding_id="b", state="failed", created_at=at(30)))
        s.add(am.NodeRun(id="nb", run_id="r-bad", node_key="publish", node_type="publish",
                         attempt=1, state="failed", idempotency_key="nb",
                         started_at=at(28), finished_at=at(27), error="制品还没构建好"))

        # Human-waiting gates require attention.
        s.add(models.Task(id="t-wait", title="等人审的活", status="doing", owner_client_id="c1"))
        s.add(am.WorkflowRun(id="r-wait", task_id="t-wait", plugin_id="pl", plugin_version_id="pv",
                             binding_id="b", state="waiting", created_at=at(20)))
        s.add(am.NodeRun(id="nw", run_id="r-wait", node_key="publish", node_type="approval",
                         attempt=1, state="waiting_human", idempotency_key="nw", started_at=at(19)))

        # Active machine execution belongs in running.
        s.add(models.Task(id="t-run", title="AI 正在改的活", status="doing", owner_client_id="c1"))
        s.add(am.WorkflowRun(id="r-run", task_id="t-run", plugin_id="pl", plugin_version_id="pv",
                             binding_id="b", state="running", created_at=at(10)))
        s.add(am.NodeRun(id="nr", run_id="r-run", node_key="implement", node_type="ai",
                         attempt=1, state="running", idempotency_key="nr", started_at=at(9)))

        # A successful retry belongs in completed, not attention-required.
        s.add(models.Task(id="t-ok", title="重试后成功的活", status="done", owner_client_id="c1"))
        s.add(am.WorkflowRun(id="r-ok", task_id="t-ok", plugin_id="pl", plugin_version_id="pv",
                             binding_id="b", state="succeeded", created_at=at(60),
                             finished_at=at(40)))
        s.add(am.NodeRun(id="no1", run_id="r-ok", node_key="publish", node_type="publish",
                         attempt=1, state="failed", idempotency_key="no1",
                         started_at=at(50), finished_at=at(49), error="制品还没构建好"))
        s.add(am.NodeRun(id="no2", run_id="r-ok", node_key="publish", node_type="publish",
                         attempt=2, state="succeeded", idempotency_key="no2",
                         started_at=at(45), finished_at=at(41)))

        # Count only the latest workflow attempt for one task.
        s.add(models.Task(id="t-twice", title="重跑过两次的活", status="doing", owner_client_id="c1"))
        s.add(am.WorkflowRun(id="r-old", task_id="t-twice", plugin_id="pl", plugin_version_id="pv",
                             binding_id="b", state="failed", created_at=at(120), finished_at=at(118)))
        s.add(am.WorkflowRun(id="r-new", task_id="t-twice", plugin_id="pl", plugin_version_id="pv",
                             binding_id="b", state="running", created_at=at(5)))
        s.add(am.NodeRun(id="nt", run_id="r-new", node_key="implement", node_type="ai",
                         attempt=1, state="running", idempotency_key="nt", started_at=at(4)))

        # Exclude completions outside the recent window.
        s.add(models.Task(id="t-old", title="上周的活", status="done", owner_client_id="c1"))
        s.add(am.WorkflowRun(id="r-very-old", task_id="t-old", plugin_id="pl", plugin_version_id="pv",
                             binding_id="b", state="succeeded", created_at=at(60 * 24 * 3),
                             finished_at=at(60 * 24 * 3 - 10)))
        await s.commit()

    async with SessionLocal() as s:
        board = await delivery_board.board(s)

    def ids(group):
        return [x["taskId"] for x in board[group]]

    chk("① 失败的进「要人管」", "t-bad" in ids("attention"), ids("attention"))
    chk("② 等人处理的也进「要人管」", "t-wait" in ids("attention"), ids("attention"))
    chk("③ 在跑的进「正在跑」", "t-run" in ids("running"), ids("running"))
    chk("④ ★重试后成功的进「刚完成」，不是「要人管」",
        "t-ok" in ids("recent") and "t-ok" not in ids("attention"),
        {"recent": ids("recent"), "attention": ids("attention")})
    chk("⑤ 一条活只出现一次（重跑两次也是一行）",
        [x for x in ids("running") + ids("attention") + ids("recent")].count("t-twice") == 1)
    chk("⑤ 认的是最新那次（新的在跑，归「正在跑」）", "t-twice" in ids("running"), ids("running"))
    chk("⑥ 三天前就结束的不占这一屏",
        "t-old" not in ids("attention") + ids("running") + ids("recent"))
    chk("★一条活只落一个格子",
        len(set(ids("attention")) & set(ids("running"))) == 0
        and len(set(ids("running")) & set(ids("recent"))) == 0)
    chk("数字与列表对得上",
        board["counts"]["attention"] == len(board["attention"])
        and board["counts"]["running"] == len(board["running"]), board["counts"])
    chk("近一天交付数只数跑成功的", board["counts"]["doneToday"] == 1, board["counts"])
    bad = next(x for x in board["attention"] if x["taskId"] == "t-bad")
    chk("★卡片直接给「卡在哪一关 + 为什么」（不用再点进去猜）",
        (bad["stage"] or {}).get("name") == "建版本并部署"
        and "制品" in str((bad["stage"] or {}).get("error")), bad["stage"])
    chk("★失败的那条能一步「重试这一关」", bad["canRetry"] is True, bad)
    chk("卡片带流程名与进度（一行就能判断跑到哪了）",
        bad["pluginName"] == "Gerrit 全自动交付" and bad["progress"]["total"] == 2, bad)

    print("\n%s  通过 %d / %d" % ("全绿" if not fail else "有红", ok, ok + fail))
    return 0 if not fail else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
