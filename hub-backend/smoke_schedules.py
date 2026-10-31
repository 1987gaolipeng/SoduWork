# -*- coding: utf-8 -*-
"""Verify schedule cadence and due checks against exact timestamps to catch missed runs and
duplicate triggers.
"""
import atexit
import io
import asyncio
import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

ROOT = os.path.abspath(os.path.dirname(__file__))
SMOKE_ROOT = tempfile.mkdtemp(prefix="soduwork-schedule-smoke-")
SMOKE_DB = os.path.join(SMOKE_ROOT, "schedule.db")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + SMOKE_DB.replace("\\", "/")
atexit.register(lambda: shutil.rmtree(SMOKE_ROOT, ignore_errors=True))
sys.path.insert(0, ROOT)
from app.services import schedules as S  # noqa: E402

ok = fail = 0
log = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        log.append("  PASS  " + name)
    else:
        fail += 1
        log.append("  FAIL  " + name + ("  << " + str(extra)[:200] if extra else ""))


class Sch:                       # Use a lightweight schedule with only timing fields.
    def __init__(self, **kw):
        self.every = kw.get("every", "daily")
        self.at_hour = kw.get("at_hour", 9)
        self.at_minute = kw.get("at_minute", 0)
        self.weekday = kw.get("weekday", 1)
        self.time_zone = kw.get("time_zone", "Asia/Shanghai")
        self.last_run_at = kw.get("last_run_at")
        self.created_at = kw.get("created_at")
        self.created_by = kw.get("created_by", "")
        self.created_by_name = kw.get("created_by_name", "")



BASE = datetime(2026, 7, 31, 10, 30)

# Daily schedules.
s = Sch(every="daily", at_hour=9, at_minute=0)
chk("每天 09:00，现在 10:30 → 明天 09:00", S.next_run_after(s, BASE) == datetime(2026, 8, 1, 9, 0),
    S.next_run_after(s, BASE))
chk("每天 09:00，现在 08:00 → 今天 09:00",
    S.next_run_after(s, datetime(2026, 7, 31, 8, 0)) == datetime(2026, 7, 31, 9, 0))
chk("正好卡在点上 → 推到明天（别一轮跑两次）",
    S.next_run_after(s, datetime(2026, 7, 31, 9, 0)) == datetime(2026, 8, 1, 9, 0))

# Hourly schedules.
h = Sch(every="hourly", at_minute=15)
chk("每小时 15 分，现在 10:30 → 11:15", S.next_run_after(h, BASE) == datetime(2026, 7, 31, 11, 15))
chk("每小时 15 分，现在 10:05 → 10:15",
    S.next_run_after(h, datetime(2026, 7, 31, 10, 5)) == datetime(2026, 7, 31, 10, 15))

# Weekly schedules.
w = Sch(every="weekly", weekday=1, at_hour=9, at_minute=0)      # Monday at 09:00.
chk("周五 10:30 → 下周一 09:00", S.next_run_after(w, BASE) == datetime(2026, 8, 3, 9, 0),
    S.next_run_after(w, BASE))
w5 = Sch(every="weekly", weekday=5, at_hour=18, at_minute=0)    # Friday at 18:00.
chk("周五 10:30 → 当天 18:00", S.next_run_after(w5, BASE) == datetime(2026, 7, 31, 18, 0))
chk("周五 18:30 → 下周五 18:00",
    S.next_run_after(w5, datetime(2026, 7, 31, 18, 30)) == datetime(2026, 8, 7, 18, 0))

# Interpret database timestamps, including naive SQLite values, as UTC.
utc_now = datetime.now(timezone.utc)
past = Sch(every="daily", at_hour=9, at_minute=0,
           last_run_at=utc_now - timedelta(days=2))
chk("两天没跑过 → 该跑了", S.due(past, utc_now) is True)
justnow = Sch(every="daily", at_hour=9, at_minute=0, last_run_at=utc_now)
chk("刚刚跑过 → 不该再跑", S.due(justnow, utc_now) is False)
fresh = Sch(every="daily", at_hour=9, at_minute=0, created_at=utc_now)
chk("刚建好的不立刻补跑", S.due(fresh, utc_now) is False)
never = Sch(every="hourly", at_minute=0,
            created_at=utc_now - timedelta(hours=3))
chk("建了三小时的每小时计划 → 该跑", S.due(never, utc_now) is True)
chk("没有 last_run 也没有 created_at → 不跑（别拿 None 去算）",
    S.due(Sch(), utc_now) is False)

# Verify time-zone handling and independent schedule-loop cadence.
daily_18 = Sch(every="daily", at_hour=18, at_minute=0,
               time_zone="Asia/Shanghai")
before = datetime(2026, 8, 18, 1, 0, tzinfo=timezone.utc)
next_18 = S.next_run_instant(daily_18, before)
chk("东八区 18:00 转成明确 UTC 时刻",
    next_18 == datetime(2026, 8, 18, 10, 0, tzinfo=timezone.utc), next_18)

# Simulate a UTC database timestamp returned without tzinfo.
# Restore UTC semantics so the next run occurs on the following day rather than every tick.
sqlite_last_run = datetime(2026, 8, 18, 10, 0)
chk("SQLite 丢失 tzinfo 后两分钟巡检不重复触发",
    S.due(Sch(every="daily", at_hour=18, at_minute=0,
              time_zone="Asia/Shanghai", last_run_at=sqlite_last_run),
          datetime(2026, 8, 18, 10, 2, tzinfo=timezone.utc)) is False)
chk("同一计划下一天到点仍正常触发",
    S.due(Sch(every="daily", at_hour=18, at_minute=0,
              time_zone="Asia/Shanghai", last_run_at=sqlite_last_run),
          datetime(2026, 8, 19, 10, 0, tzinfo=timezone.utc)) is True)

dst = Sch(every="daily", at_hour=2, at_minute=30,
          time_zone="America/New_York")
spring = S.next_run_instant(
    dst, datetime(2026, 3, 8, 5, 0, tzinfo=timezone.utc))
chk("夏令时跳时把不存在的 02:30 归一到首个真实时刻",
    spring == datetime(2026, 3, 8, 7, 30, tzinfo=timezone.utc), spring)
fall = Sch(every="daily", at_hour=1, at_minute=30,
           time_zone="America/New_York")
first_fold = S.next_run_instant(
    fall, datetime(2026, 11, 1, 4, 0, tzinfo=timezone.utc))
after_fold = S.next_run_instant(fall, first_fold)
chk("冬令时重复小时只触发一次",
    first_fold == datetime(2026, 11, 1, 5, 30, tzinfo=timezone.utc) and
    after_fold == datetime(2026, 11, 2, 6, 30, tzinfo=timezone.utc),
    (first_fold, after_fold))

# Verify serialized schedule shape.
chk("保留三种周期并支持一次性", S.EVERY == ("hourly", "daily", "weekly", "once"))
bad = Sch(every="every-minute", at_hour=99, at_minute=99)
n = S.next_run_after(bad, BASE)
chk("乱填的时分被夹住、节奏退回每天", n.hour <= 23 and n.minute <= 59, n)

from app.services.schedule_access import is_owner
owner = SimpleNamespace(id="device", user_ref="user-current")
stored = SimpleNamespace(owner_client_id="device", owner_user_id="user-original")
legacy = SimpleNamespace(owner_client_id="device", owner_user_id=None)
chk("设备换号不接管原账号的普通会话", not is_owner(stored, owner))
chk("未绑定账号的旧计划不泄露给新登录账号", not is_owner(legacy, owner))
chk("原账号和设备共同决定归属", is_owner(stored, SimpleNamespace(id="device", user_ref="user-original")))

# Verify capability contracts and bounded retries.
caps = S.clean_required_capabilities([
    "browser-use", "computer", "officecli", "browser", "unknown"])
chk("能力别名归一且去重", caps == ["browser", "computer", "office"], caps)
chk("执行能力映射到明确 Skill",
    S.required_skill_names(caps) == ["browser-use", "computer-use", "office"])

retry_due = Sch(every="daily", at_hour=23, at_minute=59, created_at=BASE)
retry_due.next_retry_at = BASE - timedelta(minutes=1)
chk("失败重试到点时优先于原周期触发", S.due(retry_due, BASE) is True)
retry_due.next_retry_at = BASE + timedelta(minutes=1)
chk("失败重试未到点时不会提前触发", S.due(retry_due, BASE) is False)

attempt_at = datetime(2026, 8, 1, 1, 0, tzinfo=timezone.utc)
retrying = SimpleNamespace(
    plugin_binding_id="", retry_limit=2, retry_delay_minutes=5,
    retry_count=0, next_retry_at=None, last_run_at=None,
    last_task_id="", last_error="")
first_retry = S.apply_outcome(
    retrying, {"ok": False, "error": "Runner 离线", "taskId": "task-1"},
    attempt_at)
chk("直接自动化失败后进入有界重试", first_retry.get("retrying") is True)
chk("重试沿用原任务标识", retrying.last_task_id == "task-1")
chk("首次重试按配置延后五分钟",
    retrying.next_retry_at == attempt_at + timedelta(minutes=5))
second_retry = S.apply_outcome(
    retrying, {"ok": False, "error": "Runner 仍离线", "taskId": "task-1"},
    attempt_at + timedelta(minutes=5))
chk("第二次失败仍在上限内", second_retry.get("retryCount") == 2)
final_retry = S.apply_outcome(
    retrying, {"ok": False, "error": "Runner 仍离线", "taskId": "task-1"},
    attempt_at + timedelta(minutes=10))
chk("达到上限后停止自动重试",
    final_retry.get("retrying") is False and retrying.next_retry_at is None)
S.apply_outcome(retrying, {"ok": True, "taskId": "task-1"},
                attempt_at + timedelta(minutes=11))
chk("执行成功会清空错误和重试状态",
    retrying.last_error == "" and retrying.retry_count == 0)

# Dispatch success is not execution completion in the immutable run ledger.
accepted = SimpleNamespace(
    task_id="", workflow_run_id="", receipt={}, state="starting", error="", finished_at=None)
S.apply_attempt_outcome(
    accepted, {"ok": True, "taskId": "task-accepted", "identifier": "exec-1"}, attempt_at)
chk("派发成功只进入执行中，不伪装成完成",
    accepted.state == "running" and accepted.finished_at is None)
chk("执行记录保留任务和底座标识",
    accepted.task_id == "task-accepted" and accepted.receipt.get("identifier") == "exec-1")
failed_attempt = SimpleNamespace(
    task_id="", workflow_run_id="", receipt={}, state="starting", error="", finished_at=None)
S.apply_attempt_outcome(
    failed_attempt, {"ok": False, "taskId": "task-failed", "error": "执行机离线"}, attempt_at)
chk("启动失败立即形成终态回执",
    failed_attempt.state == "failed" and failed_attempt.finished_at == attempt_at)
chk("任务完成才把自动化记录对账为完成",
    S.derive_run_state(task_status="done") == "succeeded")
chk("AI 交回结果但任务未验收时进入待确认",
    S.derive_run_state(task_status="doing", ai_state="done") == "waiting")
chk("工作流人工门禁映射为待确认",
    S.derive_run_state(workflow_state="running", waiting_human=True) == "waiting")
chk("AI 执行失败不会被任务进行中覆盖",
    S.derive_run_state(task_status="doing", ai_state="failed") == "failed")


async def _execute_ledger_contract(outcome):
    original_run_one = S.run_one

    async def fake_run_one(session, schedule, who="", schedule_run_id=""):
        session.observed_run_id = schedule_run_id
        return dict(outcome)

    class FakeSession:
        def __init__(self):
            self.run = None
            self.observed_run_id = ""

        def add(self, value):
            self.run = value

        async def flush(self):
            if self.run is not None and not self.run.id:
                self.run.id = "schedule-run-1"

    schedule = SimpleNamespace(
        id="schedule-1", org_id="org-1", owner_client_id="client-1",
        plugin_binding_id="", next_retry_at=None, retry_count=0,
        retry_limit=0, retry_delay_minutes=5, last_run_at=None,
        last_task_id="", last_error="")
    session = FakeSession()
    S.run_one = fake_run_one
    try:
        result = await S.execute_one(session, schedule, trigger="manual")
        return result, session.run, session.observed_run_id
    finally:
        S.run_one = original_run_one


ledger_result, ledger_run, observed_run_id = asyncio.run(
    _execute_ledger_contract({"ok": True, "taskId": "task-ledger"}))
chk("执行前先生成稳定记录标识",
    ledger_result.get("scheduleRunId") == observed_run_id == "schedule-run-1")
chk("手动触发类型进入不可变回执",
    ledger_run.trigger == "manual" and ledger_run.task_id == "task-ledger")
chk("统一执行入口仍把已接单状态记为执行中", ledger_run.state == "running")



# Plugin schedules store public inputs only and use the automation entry point.
dirty_inputs = {
    "topic": "周报",
    "confirmed": True,
    "_bad": "drop",
    "x": "a" * 7998 + "结尾",
}
clean_inputs = S.clean_plugin_inputs(dirty_inputs)
chk("自动化输入只接受公开字段名", "_bad" not in clean_inputs)
chk("自动化输入保留布尔类型", clean_inputs.get("confirmed") is True)
chk("自动化输入保留单项 8000 字符边界全文", clean_inputs.get("x") == dirty_inputs["x"])
for input_size in (8001, 9000):
    oversized_inputs = {"x": "a" * input_size}
    try:
        S.clean_plugin_inputs(oversized_inputs)
        chk("自动化输入拒绝超限 %s 字符而非截断" % input_size, False)
    except ValueError as exc:
        chk("自动化输入拒绝超限 %s 字符而非截断" % input_size,
            "8000" in str(exc) and "没有被截断保存" in str(exc)
            and len(oversized_inputs["x"]) == input_size)


async def _plugin_validation_contract():
    from app import automation_models as am, models
    from app.services import plugin_service

    original_resolve, original_inputs = plugin_service.resolve_binding, plugin_service.public_inputs
    calls = []

    async def fake_resolve(session, task, **kwargs):
        calls.append(kwargs)
        return SimpleNamespace(version_id="version-1", id="binding-1")

    plugin_service.resolve_binding = fake_resolve
    plugin_service.public_inputs = lambda manifest: [
        {"key": "topic", "label": "主题", "type": "text", "required": True},
        {"key": "confirmed", "label": "确认", "type": "boolean", "required": False},
    ]

    class FakeSession:
        async def get(self, model, key, **kwargs):
            if model is models.Client:
                return SimpleNamespace(id=key)
            if model is am.PluginVersion:
                return SimpleNamespace(manifest={})
            return None

    schedule = SimpleNamespace(
        plugin_binding_id="binding-1", plugin_inputs={
            "topic": "团队周报", "confirmed": True, "undeclared": "drop"},
        owner_client_id="client-1", repo_id="")
    try:
        binding = await S.validate_execution(FakeSession(), schedule)
        return binding, schedule, calls
    finally:
        plugin_service.resolve_binding, plugin_service.public_inputs = original_resolve, original_inputs


binding, validated, validation_calls = asyncio.run(_plugin_validation_contract())
chk("自动化计划固定使用明确绑定", binding.id == "binding-1")
chk("绑定解析明确要求 automation 入口",
    validation_calls and validation_calls[0].get("entrypoint") == "automation")
chk("未声明输入不会进入工作流", "undeclared" not in validated.plugin_inputs)


async def _direct_run_contract():
    from app import models
    from app.services import ai_exec, task_dispatch

    original_validate, original_push = S.validate_execution, S._push_new
    original_load, original_configured = ai_exec.load, ai_exec.configured
    original_dispatch = task_dispatch.dispatch
    observed = {"pushes": 0, "routes": []}

    async def fake_validate(session, schedule, org_ids=None):
        return None

    async def fake_push(session, task):
        observed["pushes"] += 1

    async def fake_load(session, force=False):
        return {"configured": True}

    async def fake_dispatch_task(tid, body, client, session):
        observed["routes"].append(dict(session.task.work_routing or {}))
        return {"identifier": "run-" + str(len(observed["routes"]))}

    class FakeSession:
        def __init__(self):
            self.task = None

        def add(self, task):
            self.task = task

        async def flush(self):
            if not self.task.id:
                self.task.id = "task-direct"

        async def get(self, model, key, **kwargs):
            if model is models.Client:
                return SimpleNamespace(id=key, user_ref="user-1")
            if model is models.Task and self.task is not None and self.task.id == key:
                return self.task
            return None

    session = FakeSession()
    schedule = SimpleNamespace(
        id="schedule-1", owner_client_id="client-1", repo_id="",
        plugin_binding_id="", plugin_inputs={}, title="填报工时", note="完成系统填报",
          owner_user_id="user-1", created_by="user-1", created_by_name="测试用户", assignee_id="local:pi",
        assignee_type="agent", required_capabilities=["browser-use", "computer"],
        next_retry_at=None, last_task_id="")
    S.validate_execution, S._push_new = fake_validate, fake_push
    ai_exec.load, ai_exec.configured = fake_load, lambda ctx: True
    task_dispatch.dispatch = fake_dispatch_task
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            client = models.Client(id="client-smoke", user_ref="owner")
            session.add(client)
            await session.flush()  # Owner snapshot listeners read the persisted device.
            plan = models.AiSchedule(id="plan-smoke", title="汇总周报", note="形成可审阅简报",
                owner_client_id=client.id, owner_user_id="owner", assignee_id="local:pi",
                required_capabilities=["browser", "computer"], every="daily",
                plugin_binding_id="retired-enterprise-binding", flow=True,
                plugin_inputs={"topic": "团队周报"})
            session.add_all([client, plan]); await session.commit()
            # Capability authorization has a separate real policy suite; isolate
            # this handoff test from installed enterprise skill catalogs.
            with patch.object(S, "validate_execution", AsyncMock()), \
                 patch.object(task_dispatch, "dispatch", AsyncMock()) as task_rpc, \
                 patch.object(workflow_engine, "start", AsyncMock()) as workflow_rpc:
                first = await S.execute_one(session, plan, trigger="timer", idempotency_key="smoke:occurrence")
                assert first.get("ok"), first
                await session.commit()
                again = await S.execute_one(session, plan, trigger="timer", idempotency_key="smoke:occurrence")
                chk("普通会话入口成功排队", first.get("ok") and first.get("waitingForDevice"), first)
                chk("同一触发重试复用记录", again.get("deduplicated") and first["scheduleRunId"] == again["scheduleRunId"])
                chk("旧企业绑定不会启动任务或工作流", task_rpc.await_count == 0 and workflow_rpc.await_count == 0)
            run = await session.get(models.AiScheduleRun, first["scheduleRunId"])
            envelope = run.receipt["conversationInput"]
            chk("执行前生成稳定标识", envelope["runId"] == run.id)
            chk("触发类型保留", run.trigger == "timer")
            chk("能力合同固化到会话", envelope["capabilities"] == ["browser", "computer"])
            chk("对应 Skill 固化到会话", envelope["skills"] == ["browser-use", "computer-use"])
            chk("完整说明和公开参数不丢失", "形成可审阅简报" in envelope["text"] and "团队周报" in envelope["text"])
            chk("旧工作流路由被清除", not plan.plugin_binding_id and not plan.flow)
            chk("不制造隐藏任务", await session.scalar(select(models.Task.id)) is None)
            await session.refresh(client)  # A duplicate claim rolled back and expired ORM identities.
            claimed = await chats.claim(session, client, run.id, "worker-smoke")
            plan.note, plan.plugin_inputs = "新说明", {"topic": "后来修改"}
            await session.commit()
            replay = await chats.claim(session, client, run.id, "worker-smoke")
            chk("已落盘会话可重领且说明保持原快照", claimed["input"] == replay["input"] == envelope)
            for state in ("running", "succeeded"):
                await chats.acknowledge(session, client, run.id, {"instanceId": "worker-smoke", "state": state, "conversationId": "chat-smoke"})
                chk("真实普通会话回执：" + state, run.state == state)
            chk("完成后保留同一会话和完成时间", run.receipt["conversationId"] == "chat-smoke" and run.finished_at is not None)
    finally:
        await engine.dispose()


direct_first, direct_second, direct_observed = asyncio.run(_direct_run_contract())
chk("直接自动化把能力合同冻结到任务",
    direct_observed["routes"][0].get("requiredAgentCapabilities") ==
    ["browser", "computer"])
chk("直接自动化把对应 Skill 冻结到任务",
    direct_observed["routes"][0].get("requiredSkills") ==
    ["browser-use", "computer-use"])
chk("重试复用同一任务而不是制造重复任务",
    direct_first.get("taskId") == direct_second.get("taskId") and
    direct_observed["pushes"] == 1)


async def _plugin_run_contract():
    from app import automation_models as am, models
    from app.services import workflow_engine

    original_validate, original_push, original_start = (
        S.validate_execution, S._push_new, workflow_engine.start)
    observed = {}
    binding = SimpleNamespace(
        id="binding-1", plugin_id="plugin-1", version_id="version-1")

    async def fake_validate(session, schedule, org_ids=None):
        return binding

    async def fake_push(session, task):
        observed["pushed"] = task.id

    async def fake_start(session, task, selected, inputs, **kwargs):
        observed.update({
            "status": task.status, "binding": selected.id, "inputs": inputs,
            "entrypoint": kwargs.get("entrypoint"), "instruction": kwargs.get("instruction"),
        })
        return SimpleNamespace(id="run-1")

    class FakeSession:
        def add(self, task):
            self.task = task

        async def flush(self):
            self.task.id = "task-1"

        async def get(self, model, key, **kwargs):
            if model is am.PluginVersion:
                return SimpleNamespace(id=key, version="1.2.0", checksum="a" * 64)
            if model is am.Plugin:
                return SimpleNamespace(id=key, key="weekly-report", name="Team weekly report")
            if model is models.Client:
                return SimpleNamespace(id=key, user_ref="user-1")
            return None

    schedule = SimpleNamespace(
        owner_client_id="client-1", repo_id="", plugin_binding_id="binding-1",
        plugin_inputs={"topic": "团队周报"}, title="汇总周报", note="形成可审阅简报",
          owner_user_id="user-1", created_by="user-1", created_by_name="测试用户")
    S.validate_execution, S._push_new, workflow_engine.start = (
        fake_validate, fake_push, fake_start)
    try:
        result = await S.run_one(FakeSession(), schedule)
        return result, observed
    finally:
        S.validate_execution, S._push_new, workflow_engine.start = (
            original_validate, original_push, original_start)


run_result, run_observed = asyncio.run(_plugin_run_contract())
chk("插件计划创建任务后启动工作流", run_result.get("workflowRunId") == "run-1")
chk("插件任务由工作流统一推进进行中状态", run_observed.get("status") == "todo")
chk("计划启动不会退回普通任务入口", run_observed.get("entrypoint") == "automation")


chk("enterprise plugin run pins exact version snapshot",
    run_result.get("pluginSnapshot", {}).get("version") == "1.2.0")


async def _plugin_deferred_schedule_contract():
    from app import automation_models as am, models
    from app.services import workflow_engine

    original_validate, original_push, original_start, original_persisted = (
        S.validate_execution, S._push_new, workflow_engine.start, S._persisted_workflow)
    binding = SimpleNamespace(
        id="binding-1", plugin_id="plugin-1", version_id="version-1")

    async def fake_validate(session, schedule, org_ids=None):
        return binding

    async def fake_push(session, task):
        return None

    async def fake_start(*args, **kwargs):
        raise RuntimeError("first dispatch unavailable")

    async def fake_persisted(session, task_id, binding_id):
        return SimpleNamespace(id="run-recoverable")

    class FakeSession:
        def add(self, task):
            self.task = task

        async def flush(self):
            self.task.id = "task-recoverable"

        async def get(self, model, key, **kwargs):
            if model is am.PluginVersion:
                return SimpleNamespace(id=key, version="1.2.0", checksum="a" * 64)
            if model is am.Plugin:
                return SimpleNamespace(id=key, key="weekly-report", name="Team weekly report")
            if model is models.Client:
                return SimpleNamespace(id=key, user_ref="user-1")
            return None

    schedule = SimpleNamespace(
        owner_client_id="client-1", repo_id="", plugin_binding_id="binding-1",
          plugin_inputs={}, title="恢复测试", note="", owner_user_id="user-1", created_by="user-1",
        created_by_name="测试用户")
    S.validate_execution, S._push_new, workflow_engine.start, S._persisted_workflow = (
        fake_validate, fake_push, fake_start, fake_persisted)
    try:
        return await S.run_one(FakeSession(), schedule)
    finally:
        S.validate_execution, S._push_new, workflow_engine.start, S._persisted_workflow = (
            original_validate, original_push, original_start, original_persisted)


deferred_result = asyncio.run(_plugin_deferred_schedule_contract())
chk("已落盘流程首次调度失败时交给后台恢复", deferred_result.get("ok") is True)
chk("延后恢复不会丢失工作流标识",
    deferred_result.get("workflowRunId") == "run-recoverable")
chk("延后恢复向界面提供明确状态", deferred_result.get("deferredSchedule") is True)
chk("deferred enterprise plugin keeps exact version snapshot",
    deferred_result.get("pluginSnapshot", {}).get("version") == "1.2.0")

log.append("")
log.append("PASS=%d FAIL=%d" % (ok, fail))
with io.open(os.path.join(SMOKE_ROOT, "smoke_schedules.out.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(log))
print("PASS=%d FAIL=%d" % (ok, fail))
sys.exit(1 if fail else 0)
