# -*- coding: utf-8 -*-
"""Verify stage-specific agent and model selection without starting AI processes. Reuse an
unconfigured or unchanged agent, include prior-stage handoff when switching agents, and apply
model overrides only to the dispatched configuration.
"""
import asyncio
import io
import os
import shutil
import sys
import tempfile
import uuid

SMOKE_ROOT = tempfile.mkdtemp(prefix="soduwork-stage-agent-")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + os.path.join(SMOKE_ROOT, ".smoke-stage-agent.db").replace("\\", "/")
sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app import models  # noqa: E402
from app.api import tasks as T  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import ai_exec, task_events as ev  # noqa: E402

ok = fail = 0
log = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        log.append("  PASS  " + name)
    else:
        fail += 1
        log.append("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


class M:                       # Provide only milestone fields used by the selection logic.
    def __init__(self, agent_id="", agent_type="", model="", seq=1, title="第 N 环", note=""):
        self.id = "m-" + uuid.uuid4().hex[:6]
        self.agent_id, self.agent_type, self.model = agent_id, agent_type, model
        self.seq, self.title, self.note, self.status = seq, title, note, "planned"


async def main():
    await init_db()
    async with SessionLocal() as s:
        # Create a temporary task and dispatch event, then roll back all writes.
        # Use an existing owner client to satisfy task.owner_client_id foreign keys.
        # PostgreSQL enforces this constraint even when SQLite's default configuration does not.
        if await s.get(models.Client, "u-smoke") is None:
            s.add(models.Client(id="u-smoke", name="（冒烟）临时机",
                                agent_models={"pi": "原模型"}))
            await s.flush()
        # Managed seats now resolve only models admitted by the real catalog.
        # Seed that catalog; never replace admission checks just to reach dispatch.
        s.add(models.ModelProvider(id="stage-fixture", name="Stage fixture",
                                   base_url="https://stage-fixture.invalid/v1",
                                   api_key="fixture-only-key", enabled=True))
        for name in ("原模型", "model-X"):
            s.add(models.ModelDef(id="stage-fixture:" + name, provider_id="stage-fixture",
                                 name=name, label=name, enabled=True))
        t = models.Task(title="（冒烟）分环节派活", owner_client_id="u-smoke", status="doing")
        s.add(t)
        await s.flush()
        ev.record(s, t.id, ai_exec.EV_DISPATCHED,
                  {"ref": "ref-1", "issueId": "ref-1", "assigneeId": "local:opencode",
                   "assigneeName": "本机 OpenCode"}, actor="冒烟")
        await s.flush()

        # Verify whether the stage switches agents.
        chk("没配执行者 → 沿用（发评论，不新起单）",
            await T._stage_switch(s, t.id, M(), "ref-1") is None)
        chk("配的就是当前这家 → 沿用",
            await T._stage_switch(s, t.id, M(agent_id="local:opencode"), "ref-1") is None)
        sw = await T._stage_switch(s, t.id, M(agent_id="local:pi"), "ref-1")
        chk("★配了别人 → 换人", (sw or {}).get("id") == "local:pi", sw)
        chk("换人时带上类型（默认 agent）", (sw or {}).get("type") == "agent", sw)
        sw2 = await T._stage_switch(s, t.id, M(agent_id="sq-1", agent_type="squad"), "ref-1")
        chk("小队也认", (sw2 or {}).get("type") == "squad", sw2)

        # Intercept process creation and inspect the dispatched arguments.
        seen = {}

        def fake_dispatch(ctx, task, files, assignee, extra):
            seen["ctx"] = ctx
            seen["extra"] = extra
            seen["assignee"] = assignee
            return {"ok": True, "issueId": "ref-2", "identifier": "LOCAL-ref2",
                    "assigneeName": "本机 Pi", "assigneeCli": "Pi", "provider": "local"}

        def fake_resolve(ctx, aid, atype="", client_id="", *args):
            return {"id": aid, "type": atype or "agent", "name": "本机 Pi"}

        real_d, real_r = ai_exec.dispatch_sync, ai_exec.resolve_requested_sync
        ai_exec.dispatch_sync, ai_exec.resolve_requested_sync = fake_dispatch, fake_resolve
        try:
            # Completed stages have summaries that must appear in the handoff.
            for i, (ti, note) in enumerate([("搭骨架", "建好了目录和路由"), ("写接口", "加了 3 个接口并自测通过")]):
                s.add(models.Milestone(task_id=t.id, seq=i, title=ti, status="done", note=note))
            m = M(agent_id="local:pi", model="model-X", seq=5, title="做前端页面")
            await s.flush()
            # Use the real context structure so the assertion exercises the production configuration path.
            # The local context has the shape {"name": "local", "cfg": {"llm": ...}}.
            # Local dispatch reads cfg, so the model override must update that field.
            base_ctx = {"name": "local",
                        "cfg": {"llm": {"base": "b", "key": "k", "model": "原模型"}}}
            r = await T._run_stage_with(s, t, m, 3, 5, {"path": "D:/x", "flow": True},
                                        base_ctx, {"id": "local:pi", "type": "agent"}, "冒烟", "本轮口径：做前端页面")
            chk("换人派活成功并回了新 ref", r.get("ok") and r.get("ref") == "ref-2", r)
            brief = (seen.get("extra") or {}).get("brief", "")
            chk("★正文里有本轮口径", "做前端页面" in brief, brief[:120])
            chk("★正文里有上一环的交接", "写接口" in brief and "加了 3 个接口" in brief, brief[-260:])
            chk("交接里提醒别重做", "别把已经做好的又重做一遍" in brief)
            # Apply the override to the configuration dispatch actually reads: cfg for name=local.
            chk("★这一环的模型覆盖落进了 cfg",
                ((seen["ctx"].get("cfg") or {}).get("llm") or {}).get("model") == "model-X",
                seen["ctx"])
            chk("★不污染原来那份 cfg",
                base_ctx["cfg"]["llm"]["model"] == "原模型", base_ctx)
            rows = (await s.execute(select(models.TaskEvent).where(
                models.TaskEvent.task_id == t.id, models.TaskEvent.kind == ai_exec.EV_DISPATCHED))).scalars().all()
            # Locate the event by its new execution reference, not by unordered query position.
            # Transaction timestamps may be identical, so ordering only by at is also insufficient.
            last = next((r.detail or {} for r in rows
                         if (r.detail or {}).get("issueId") == "ref-2"), {})
            chk("新起的单记了是为哪一环起的", (last.get("stage") or {}).get("title") == "做前端页面", last)
            chk("新起的单记了执行者", last.get("assigneeId") == "local:pi", last)
            # An unconfigured model must preserve the original context object.
            # Run this after the previous assertions because it records another dispatch event.
            seen.clear()
            m0 = M(agent_id="local:pi", model="", seq=6, title="不指定模型")
            await T._run_stage_with(s, t, m0, 4, 5, {"path": "D:/x"}, base_ctx,
                                    {"id": "local:pi", "type": "agent"}, "冒烟", "口径")
            chk("没配模型 → 沿用原来的",
                ((seen["ctx"].get("cfg") or {}).get("llm") or {}).get("model") == "原模型",
                seen["ctx"])
            seen.clear()
            rejected = await T._run_stage_with(s, t, M(agent_id="local:pi", model="removed-model"),
                4, 5, {}, base_ctx, {"id": "local:pi", "type": "agent"}, "冒烟", "口径")
            chk("不可用的显式模型不能被静默替换或派活",
                not rejected.get("ok") and "当前不可用" in rejected.get("error", "") and not seen)
        finally:
            ai_exec.dispatch_sync, ai_exec.resolve_requested_sync = real_d, real_r
            await s.rollback()      # Leave no test records in the database.

    log.append("")
    log.append("PASS=%d FAIL=%d" % (ok, fail))
    with io.open("smoke_stage_agent.out.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(log))
    print("PASS=%d FAIL=%d" % (ok, fail))


try:
    asyncio.run(main())
finally:
    asyncio.run(engine.dispose())
    shutil.rmtree(SMOKE_ROOT, ignore_errors=True)
sys.exit(1 if fail else 0)
