# -*- coding: utf-8 -*-
"""Offline personal-plugin automation tests covering schedule identity/version metadata, dispatch
forwarding, device-side pinned/latest resolution, integrity checks, MCP ticket injection, prompt
composition, and explicit failure when method context is missing.
"""
import asyncio
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

DB = os.path.abspath(".smoke-personal-automation.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import personal_plugin_runtime as ppr  # noqa: E402
from app.services import schedules as sch  # noqa: E402

ok = fail = 0
CHECK_V1 = "a" * 64
CHECK_V2 = "b" * 64


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:260] if extra else ""))


def raises(fn, needle):
    try:
        fn()
    except ValueError as exc:
        return needle in str(exc), str(exc)
    return False, "没抛 ValueError"


# Validate Hub keys, mutually exclusive bindings, and schedule updates.
chk("合法 key 原样通过", sch.clean_personal_plugin_key(" daily-report ") == "daily-report")
chk("空 key 回空串", sch.clean_personal_plugin_key("") == "")
hit, msg = raises(lambda: sch.clean_personal_plugin_key("Bad_Key"), "不合法")
chk("大写/下划线 key 被拒", hit, msg)
hit, msg = raises(lambda: sch.clean_personal_plugin_key("x"), "不合法")
chk("单字符 key 被拒（与客户端 KEY 同形状）", hit, msg)

from app.api.admin import _sch_apply  # noqa: E402

row = SimpleNamespace(title="", note="", every="daily", at_hour=9, at_minute=0,
                      weekday=1, time_zone="Asia/Shanghai", assignee_id="local:pi",
                      assignee_type="agent", repo_id="", owner_client_id="", flow=False,
                      plugin_binding_id="", personal_plugin_key="", plugin_inputs={},
                      personal_plugin_version_policy="latest",
                      personal_plugin_version="", personal_plugin_checksum="",
                      required_capabilities=[], retry_limit=2, retry_delay_minutes=5,
                      retry_count=3, next_retry_at=datetime.now(timezone.utc), enabled=True)
_sch_apply(row, {
    "personalPluginKey": "  daily-report  ",
    "personalPluginVersionPolicy": "pinned",
    "personalPluginVersion": "0.1.0",
    "personalPluginChecksum": CHECK_V1,
})
chk("_sch_apply 收下 personalPluginKey 并去空白", row.personal_plugin_key == "daily-report")
chk("_sch_apply 收下可验证固定版本",
    row.personal_plugin_version_policy == "pinned"
    and row.personal_plugin_version == "0.1.0"
    and row.personal_plugin_checksum == CHECK_V1)
chk("换了工作方法 ⇒ 重试进度清零", row.retry_count == 0 and row.next_retry_at is None)
_sch_apply(row, {"personalPluginKey": "", "personalPluginVersionPolicy": "pinned",
                 "personalPluginVersion": "9.9.9", "personalPluginChecksum": CHECK_V2})
chk("清空插件时不会残留隐藏版本字段",
    row.personal_plugin_version_policy == "latest"
    and not row.personal_plugin_version and not row.personal_plugin_checksum)


async def hub_side():
    await init_db()
    async with SessionLocal() as session:
        session.add(models.Client(id="c-pa", name="我的机器"))
        await session.commit()

        both = models.AiSchedule(title="双选", owner_client_id="c-pa",
                                 assignee_id="local:pi", plugin_binding_id="b-1",
                                 personal_plugin_key="daily-report")
        await sch.validate_execution(session, both)
        chk("旧企业工作流绑定被移除，个人插件仍用于普通对话",
            not both.plugin_binding_id and both.personal_plugin_key == "daily-report"
            and not both.flow)

        noagent = models.AiSchedule(title="没执行人", owner_client_id="c-pa",
                                    personal_plugin_key="daily-report")
        try:
            await sch.validate_execution(session, noagent)
            chk("个人插件必须选执行 Agent", False)
        except ValueError as exc:
            chk("个人插件必须选执行 Agent", "执行 Agent" in str(exc), exc)

        good = models.AiSchedule(title="好计划", owner_client_id="c-pa",
                                 assignee_id="local:pi", personal_plugin_key="daily-report",
                                 plugin_inputs={"city": "合肥", "bad key!": "x", "n": 3})
        await sch.validate_execution(session, good)
        chk("个人插件计划通过校验，参数洗掉不合法键",
            good.plugin_inputs == {"city": "合肥", "n": 3}, good.plugin_inputs)

        out = await sch.preflight_execution(session, models.AiSchedule(
            title="孤儿", personal_plugin_key="daily-report", assignee_id="local:pi"))
        chk("预检：没选归属 SoduWork ⇒ blocked 且 mode=personal",
            out.get("state") == "blocked" and out.get("mode") == "personal", out)

        broken = await sch.preflight_execution(session, models.AiSchedule(
            title="坏快照", personal_plugin_key="daily-report",
            personal_plugin_version_policy="pinned",
            personal_plugin_version="0.1.0", personal_plugin_checksum="",
            assignee_id="local:pi"))
        chk("预检：固定版本缺校验值会就地阻断并返回检查项",
            broken.get("state") == "blocked" and broken.get("mode") == "personal"
            and (broken.get("checks") or [])[0].get("key") == "plugin", broken)

        # Verify run_one forwards personalPlugin into dispatch.
        yesterday = datetime.now(timezone.utc) - timedelta(days=1)
        plan = models.AiSchedule(id="s-pa", title="每日城市简报", note="按方法写简报",
                                 every="daily", at_hour=9, at_minute=0,
                                 owner_client_id="c-pa", assignee_id="local:pi",
                                 assignee_type="agent", enabled=True,
                                 personal_plugin_key="daily-report",
                                 personal_plugin_version_policy="pinned",
                                 personal_plugin_version="0.1.0",
                                 personal_plugin_checksum=CHECK_V1,
                                 plugin_inputs={"city": "合肥"}, created_at=yesterday)
        session.add(plan)
        await session.commit()

        from sqlalchemy import select
        from unittest.mock import AsyncMock, patch
        from app.services import schedule_conversations as chats, task_dispatch
        with patch.object(task_dispatch, "dispatch", AsyncMock()) as dispatch:
            out = await sch.execute_one(session, plan, trigger="manual")
            await session.commit()
        chk("普通会话已排队而未伪称执行完成",
            out.get("ok") is True and out.get("waitingForDevice") is True, out)
        chk("不调用任务派发", dispatch.await_count == 0)
        run_row = await session.scalar(select(models.AiScheduleRun).where(
            models.AiScheduleRun.schedule_id == "s-pa"))
        receipt = run_row.receipt or {}
        body = receipt.get("conversationInput") or {}
        chk("会话保留个人插件标识", body.get("personalPlugin", {}).get("key") == "daily-report", body)
        chk("会话固化版本和校验值", body.get("personalPlugin") == {
            "key": "daily-report", "versionPolicy": "pinned", "version": "0.1.0",
            "checksum": CHECK_V1}, body)
        chk("完整说明与参数进入会话", "按方法写简报" in body["text"] and "合肥" in body["text"])
        chk("执行记录 mode=personal", receipt.get("mode") == "personal", receipt)
        chk("排队时不伪造实际执行机", not receipt.get("route", {}).get("resolved"), receipt)
        chk("保留请求路由", receipt.get("route", {}).get("requested", {}).get("assigneeId") == "local:pi")
        chk("不产生任务或工作流", not run_row.task_id and not run_row.workflow_run_id
            and await session.scalar(select(models.Task.id)) is None)
        client = await session.get(models.Client, "c-pa")
        claimed = await chats.claim(session, client, run_row.id, "worker-personal")
        chk("归属设备领取不可变插件快照", claimed.get("input", {}).get("personalPlugin") == body["personalPlugin"])
        plan.personal_plugin_version = "0.2.0"
        plan.personal_plugin_checksum = CHECK_V2
        await session.commit()
        replay = await chats.claim(session, client, run_row.id, "worker-personal")
        chk("编辑计划不会改变本次已领取的版本", replay["input"] == claimed["input"])
        await chats.acknowledge(session, client, run_row.id, {
            "instanceId": "worker-personal", "state": "running", "conversationId": "chat-personal"})
        await chats.acknowledge(session, client, run_row.id, {
            "instanceId": "worker-personal", "state": "succeeded", "conversationId": "chat-personal"})
        chk("实际对话回执关闭执行记录", run_row.state == "succeeded"
            and run_row.receipt["conversationId"] == "chat-personal" and run_row.finished_at is not None)



def _async(value):
    async def _inner():
        return value
    return _inner()


asyncio.run(hub_side())

# Test execution-device personal-plugin loading.
hit, msg = raises(lambda: ppr.load_plugin("daily-report", ""), "客户端")
chk("没有插件库路径 ⇒ 一句能照做的人话", hit, msg)

STORE = os.path.abspath(".smoke-personal-plugins.json")
with open(STORE, "w", encoding="utf-8") as f:
    json.dump({"schemaVersion": 1, "plugins": [
        {"id": "local:1", "key": "daily-report", "name": "每日简报", "enabled": True,
         "currentVersion": "0.2.0", "versions": [
             {"version": "0.2.0", "checksum": CHECK_V2, "body": {
                 "name": "每日简报", "version": "0.2.0",
                 "instructions": "先查天气，再写三段式简报。",
                 "inputs": [
                     {"key": "city", "label": "城市", "type": "text", "required": True},
                     {"key": "limit", "label": "条数", "type": "number", "default": 5},
                 ],
                 "mcpServers": ["crm"], "runtime": ["browser"],
                 "evaluationCriteria": ["有结论", "有证据"]}},
             {"version": "0.1.0", "checksum": CHECK_V1,
              "body": {"name": "每日简报", "version": "0.1.0",
                                           "instructions": "旧版方法。"}},
         ]},
        {"id": "local:2", "key": "off-one", "name": "停用的", "enabled": False,
         "currentVersion": "0.1.0", "versions": [
             {"version": "0.1.0", "body": {"instructions": "x"}}]},
        {"id": "local:3", "key": "interactive-board", "name": "交互看板",
         "enabled": True, "currentVersion": "0.1.0", "versions": [
             {"version": "0.1.0", "checksum": CHECK_V1, "body": {
                 "name": "交互看板", "version": "0.1.0",
                 "instructions": "打开可见页面后协助用户处理。", "ui": {
                     "contributions": [{"id": "board", "title": "工作看板"}]}}}]},
    ]}, f, ensure_ascii=False)

body = ppr.load_plugin("daily-report", STORE)
chk("按 currentVersion 取当前版本（不是数组第一个）",
    body.get("version") == "0.2.0" and "三段式" in body.get("instructions", ""), body)
chk("旧计划跟随最新版时也记录实际内容校验值",
    (body.get("_soduworkSnapshot") or {}).get("versionPolicy") == "latest"
    and (body.get("_soduworkSnapshot") or {}).get("checksum") == CHECK_V2, body)
pinned = ppr.load_plugin(
    "daily-report", STORE, "0.1.0", CHECK_V1, "pinned")
chk("固定版本不受当前版本切换影响",
    pinned.get("version") == "0.1.0" and "旧版方法" in pinned.get("instructions", ""), pinned)
hit, msg = raises(lambda: ppr.load_plugin(
    "daily-report", STORE, "9.9.9", CHECK_V1, "pinned"), "已不在本机")
chk("固定版本已删除时拒绝悄悄改跑最新版", hit, msg)
hit, msg = raises(lambda: ppr.load_plugin(
    "daily-report", STORE, "0.1.0", CHECK_V2, "pinned"), "校验失败")
chk("固定版本内容校验值不一致时拒绝运行", hit, msg)
hit, msg = raises(lambda: ppr.load_plugin("off-one", STORE), "停用")
chk("停用的插件拒绝执行", hit, msg)
hit, msg = raises(lambda: ppr.load_plugin("gone", STORE), "不存在")
chk("不存在的 key 拒绝执行", hit, msg)

os.environ[ppr.ENV_STORE] = STORE
hit, msg = raises(lambda: ppr.apply(
    {"personalPlugin": {"key": "interactive-board"}}, {}, "task-ui"),
    "不能用于后台自动化")
chk("带页面的个人插件拒绝进入 Runner 后台自动化", hit, msg)

hit, msg = raises(lambda: ppr.merge_inputs(body.get("inputs"), {}), "城市")
chk("缺必填参数 ⇒ 报参数名", hit, msg)
values = ppr.merge_inputs(body.get("inputs"), {"city": "合肥"})
chk("参数合并：给的值 + 声明的默认值", dict(values) == {"城市": "合肥", "条数": 5}, values)

text = ppr.context_text(body, values)
chk("方法上下文含插件名与版本", "每日简报」v0.2.0" in text, text[:120])
chk("方法上下文含工作方法与参数", "工作方法" in text and "城市：合肥" in text)
chk("方法上下文含 MCP 桥口径", "plugin_mcp_list" in text and "crm" in text)
chk("方法上下文含完成标准", "有结论" in text)

hit, msg = raises(lambda: ppr.grant_mcp(["crm"], {}), "设备身份")
chk("没有设备身份不能换 MCP 票", hit, msg)

os.environ[ppr.ENV_STORE] = STORE
real_grant = ppr.grant_mcp
ppr.grant_mcp = lambda names, identity, ref="": {"ticket": "tk-1", "servers": names}
try:
    ctx = {"personalPlugin": {
               "key": "daily-report", "versionPolicy": "pinned",
               "version": "0.2.0", "checksum": CHECK_V2,
               "inputs": {"city": "合肥"}},
           "mcpConfig": {"servers": {"crm-direct": {"type": "stdio"}}}}
    ppr.apply(ctx, {"base": "http://hub.local:9080", "clientId": "c1", "secret": "s1"},
              "task-1")
    server = (ctx.get("mcpConfig") or {}).get("servers", {}).get(ppr.GRANT_SERVER) or {}
    chk("MCP 票并进本轮 mcpConfig（不覆盖既有连接）",
        server.get("url") == "http://hub.local:9080/api/v1/mcp"
        and server.get("headers", {}).get("Authorization") == "Bearer tk-1"
        and "crm-direct" in ctx["mcpConfig"]["servers"], ctx.get("mcpConfig"))
    chk("方法上下文挂进 ctx", "三段式" in ctx.get("personalPluginContext", ""))
    meta = ctx.get("personalPluginMeta") or {}
    chk("元信息可供留痕",
        meta.get("version") == "0.2.0" and meta.get("checksum") == CHECK_V2
        and meta.get("versionPolicy") == "pinned"
        and meta.get("executionMode") == "method", meta)
finally:
    ppr.grant_mcp = real_grant

# Plugins without MCP load without ticket exchange or device credentials.
with open(STORE, "r+", encoding="utf-8") as f:
    data = json.load(f)
    data["plugins"][0]["versions"][0]["body"]["mcpServers"] = []
    f.seek(0)
    json.dump(data, f, ensure_ascii=False)
    f.truncate()
ctx2 = {"personalPlugin": {"key": "daily-report", "inputs": {"city": "合肥"}}}
ppr.apply(ctx2, {}, "task-2")
chk("无 MCP 插件不需要设备身份", "personalPluginContext" in ctx2 and "mcpConfig" not in ctx2)

# Verify prompt context and missing-load rejection.
from app.services import ai_local  # noqa: E402

prompt = ai_local._compose(SimpleNamespace(id="t1", title="写简报", note=""),
                           {"personalPluginContext": ctx2["personalPluginContext"]})
chk("方法上下文进派活正文", "三段式" in prompt and "写简报" in prompt)

guard = ai_local.dispatch_sync({}, SimpleNamespace(id="t2", title="x"), None,
                               {"id": "local:pi"},
                               {"personalPlugin": {"key": "daily-report"}})
chk("没装载就派 ⇒ 直接失败并说清在哪能跑",
    guard.get("ok") is False and "装载" in str(guard.get("error"))
    and "客户端" in str(guard.get("error")), guard)

for path in (STORE, DB, DB + "-shm", DB + "-wal"):
    try:
        os.remove(path)
    except OSError:
        # Windows database handles may remain until process exit; later setup cleans the temporary file.
        pass
os.environ.pop(ppr.ENV_STORE, None)

print("\npersonal automation smoke: %d passed, %d failed" % (ok, fail))
sys.exit(1 if fail else 0)
