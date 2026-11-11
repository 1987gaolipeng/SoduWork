# -*- coding: utf-8 -*-
"""Verify operational analytics against representative persisted facts and explicit aggregation
rules.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

DB = os.path.abspath(".smoke-ops-insights.db")
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
from app.services import operations_insights  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:260] if extra else ""))


async def main():
    # 16:30 UTC is already the next business day in the product's +08:00 view.
    chk("运营趋势按北京时间切日", operations_insights._product_day(
        datetime(2026, 9, 18, 16, 30, tzinfo=timezone.utc)).isoformat() == "2026-09-19")
    await init_db()
    now = datetime.now(timezone.utc)
    async with SessionLocal() as s:
        s.add(models.OrgUnit(id="o-p", name="产品部"))
        s.add(models.User(id="u-a", username="ua", display_name="甲人",
                          org_id="o-p", is_active=True))
        s.add(models.User(id="u-b", username="ub", display_name="乙人",
                          org_id="o-p", is_active=True))
        s.add(models.Client(id="c-a", name="甲", user_ref="u-a"))
        s.add(models.Client(id="c-b", name="乙", user_ref="u-b"))
        # Create online and offline Runner facts with runtime authentication state.
        s.add(am.RunnerNode(id="r-on", host="ON", last_seen_at=now,
                            agents=[{"key": "codex", "name": "Codex", "version": "0.147",
                                     "auth": "authed"},
                                    {"key": "pi", "name": "Pi", "version": "0.83"}]))
        s.add(am.RunnerNode(id="r-off", host="OFF", last_seen_at=now - timedelta(hours=3),
                            agents=[{"key": "codex", "name": "Codex", "version": "0.147",
                                     "auth": "unauthed"}]))
        # Create plugin installation, workflow-result, and conversation-grant facts.
        s.add(am.Plugin(id="pl-1", key="popular", name="热门插件", enabled=True))
        s.add(am.PluginVersion(id="pv-1", plugin_id="pl-1", version="1.2.0", checksum="x",
                               trust_state="approved", enabled=True,
                               manifest={"category": "office"}))
        s.add(am.PluginVersion(id="pv-2", plugin_id="pl-1", version="1.10.0", checksum="y",
                               trust_state="approved", enabled=True,
                               manifest={"category": "office"}))
        s.add(am.PluginInstallation(user_id="u-1", plugin_id="pl-1",
                                    version_id="pv-1", enabled=True))
        s.add(am.PluginInstallation(user_id="u-2", plugin_id="pl-1",
                                    version_id="pv-1", enabled=True))
        s.add(models.Task(id="t-1", title="活", status="done", owner_client_id="c-a"))
        for i, state in enumerate(("succeeded", "succeeded", "failed")):
            s.add(am.WorkflowRun(id=f"wr-{i}", task_id="t-1", plugin_id="pl-1",
                                 plugin_version_id="pv-1", binding_id="b", state=state))
        for i in range(2):
            s.add(models.AuditLog(action="plugin.conversation_grant", target_type="plugin",
                                  target_id="pl-1", actor_name="张三"))
        # Include a historical structured error stored as Python representation.
        # The read model must return readable text rather than raw dictionary syntax.
        DICT_ERR = ("{'message': '当前没有可接这条任务的在线执行机，请检查所选底座与能力授权', "
                    "'code': 'AI_DISPATCH_FAILED', 'phase': 'routing', "
                    "'phaseName': '选择执行机', 'retryable': True, 'attemptId': '%s'}")
        s.add(models.AiSchedule(id="s-1", title="日报", every="daily", enabled=True,
                                owner_client_id="c-a", assignee_id="a",
                                last_error=DICT_ERR % "at-1"))
        s.add(models.AiSchedule(id="s-2", title="停用的", every="daily", enabled=False,
                                owner_client_id="c-a", assignee_id="a"))
        # Include a schedule whose latest success cleared last_error but whose reporting window contains a failure.
        # Display the most recent failed run's error in that case.
        s.add(models.AiSchedule(id="s-3", title="清过错的", every="daily", enabled=True,
                                owner_client_id="c-a", assignee_id="a", last_error=""))
        s.add(models.AiScheduleRun(schedule_id="s-3", owner_client_id="c-a",
                                   trigger="timer", state="failed",
                                   error="网络超时", started_at=now))
        s.add(models.AiScheduleRun(schedule_id="s-1", owner_client_id="c-a",
                                   trigger="timer", state="running", started_at=now))
        for i in range(2):
            s.add(models.AiScheduleRun(schedule_id="s-1", owner_client_id="c-a",
                                       trigger="timer", state="failed",
                                       error="执行机不在线", started_at=now))
        # Create identical failures with different attempt IDs.
        # Normalized aggregation must count them together.
        for i in range(2):
            s.add(models.AiScheduleRun(schedule_id="s-1", owner_client_id="c-a",
                                       trigger="timer", state="failed",
                                       error=DICT_ERR % f"at-{i}", started_at=now))
        # Include recent sessions for two devices.
        s.add(am.ExecutionSession(task_id="t-1", ref="e-1", runner_client_id="c-a"))
        s.add(am.ExecutionSession(task_id="t-1", ref="e-2", runner_client_id="c-b"))
        await s.commit()

    async with SessionLocal() as s:
        data = await operations_insights.insights(s)

    a = data["adoption"]
    chk("7 天活跃设备按会话去重", a["activeClients7d"] == 2, a)
    chk("执行机在线/总数（5 分钟内心跳算在线）",
        a["runnersOnline"] == 1 and a["runnersTotal"] == 2, a)
    chk("★codex 装备与登录态汇总（装 2 台、1 台已登录 1 台没登录）",
        a["agents"].get("codex") == {"installed": 2, "authed": 1, "unauthed": 1},
        a.get("agents"))
    chk("pi 没有登录态概念，只计安装",
        a["agents"].get("pi") == {"installed": 1, "authed": 0, "unauthed": 0},
        a.get("agents"))

    p = next(item for item in data["plugins"] if item["key"] == "popular")
    chk("插件安装人数", p["installs"] == 2, p)
    chk("30 天运行数与成败", p["runs30d"] == 3 and p["succeeded30d"] == 2
        and p["failed30d"] == 1, p)
    chk("成功率按已结束的算（2/3=67%）", p["successRate"] == 67, p)
    chk("★对话调用次数来自 conversation_grant 审计", p["conversationUses30d"] == 2, p)
    chk("分类与版本带出（运营页要能按类看）",
        p["category"] == "office" and p["version"] == "1.10.0", p)

    auto = data["automation"]
    chk("自动化总数/启用数", auto["schedules"] == 3 and auto["enabled"] == 2, auto)
    chk("7 天触发与失败", auto["runs7d"] == 6 and auto["failed7d"] == 5, auto)
    errors = {item["error"]: item for item in auto["topErrors"]}
    chk("失败 top 原因聚合（纯文本原样）", "执行机不在线" in errors
        and errors["执行机不在线"]["n"] == 2, auto["topErrors"])
    chk("★dict repr 错误人话化＋跨 attemptId 聚合（不再散成一堆各 1 次）",
        "当前没有可接这条任务的在线执行机，请检查所选底座与能力授权" in errors
        and errors["当前没有可接这条任务的在线执行机，请检查所选底座与能力授权"]["n"] == 2
        and errors["当前没有可接这条任务的在线执行机，请检查所选底座与能力授权"]["code"]
        == "AI_DISPATCH_FAILED", auto["topErrors"])

    out = data["output"]
    chk("30 天任务与会话计数", out["tasksCreated30d"] == 1
        and out["tasksDone30d"] == 1 and out["aiSessions30d"] == 2, out)

    trend = data["trend"]
    today = trend[-1]
    chk("★趋势是 30 个按天桶、今天的桶接住了全部事实",
        len(trend) == 30 and today["tasksCreated"] == 1 and today["aiSessions"] == 2
        and today["automationRuns"] == 6 and today["automationFailed"] == 5, today)
    chk("★每日活跃设备有自己的真数据（KPI 卡的趋势线不许挂别人的数）",
        today["activeClients"] == 2
        and all(d["activeClients"] == 0 for d in trend[:-1]), today)
    chk("历史空天补零（画趋势线不许有窟窿）",
        all(d["tasksCreated"] == 0 for d in trend[:-1]), trend[0])

    deps = data["departments"]
    chk("★部门维度：设备换算成人再挂部门（两台设备=两个人，同部门）",
        len(deps) == 1 and deps[0]["org"] == "产品部" and deps[0]["activeUsers7d"] == 2
        and deps[0]["tasks30d"] == 1, deps)

    failing = data["automation"]["failing"]
    chk("★失败中的计划带名字/失败次数/最后错误（可直接去处理）",
        len(failing) == 2 and failing[0]["title"] == "日报" and failing[0]["failed7d"] == 4
        and "执行机" in failing[0]["lastError"], failing)
    cleared = next((f for f in failing if f["title"] == "清过错的"), None)
    chk("★last_error 被成功清空后回落到最近失败 run 的错误",
        cleared is not None and cleared["lastError"] == "网络超时", failing)
    chk("★失败计划的 lastError 已人话化（dict repr 不出门）＋带 code 与最近失败时间",
        not failing[0]["lastError"].startswith("{")
        and failing[0]["lastErrorCode"] == "AI_DISPATCH_FAILED"
        and failing[0]["lastFailedAt"], failing)

    chk("采用度带上一周期基准（环比要有分母）",
        data["adoption"]["activeClientsPrev7d"] == 0, data["adoption"])

    # Schedule persistence and notifications also normalize failures at the source.
    from app.services.schedules import error_text
    chk("error_text：结构体取 message、缺 message 退 code、纯文本原样",
        error_text({"message": "人话", "code": "X"}) == "人话"
        and error_text({"code": "AI_DISPATCH_FAILED"}) == "AI_DISPATCH_FAILED"
        and error_text("直接的字符串") == "直接的字符串", None)
    trunc = operations_insights._humanize_error(
        "{'message': '被四百字上限拦腰截断的错误', 'code': 'X_CUT', 'attemptId': '")
    chk("★被 400 字截断的 repr 也能抠出人话（正则兜底）",
        trunc["text"] == "被四百字上限拦腰截断的错误" and trunc["code"] == "X_CUT", trunc)

    print(f"\n{ok} PASS / {fail} FAIL")
    return fail


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(main()) else 0)
