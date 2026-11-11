# -*- coding: utf-8 -*-
"""Real HTTP plugin-start tests with isolated records and dependency-ordered cleanup."""
import asyncio
import io
import os
import shutil
import sys

import httpx
from sqlalchemy import delete, select

sys.path.insert(0, ".")

DB = os.path.abspath(".smoke-plugin-client-api.db")
DATA = os.path.abspath(".smoke-plugin-client-api-data")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
shutil.rmtree(DATA, ignore_errors=True)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
os.environ["SODUWORK_DATA_ROOT"] = DATA

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.api import plugin_client_runs as plugin_api  # noqa: E402
from app.services import (device_auth, plugin_compat, workflow_context,
                          workflow_engine, workflow_runs)  # noqa: E402

CID, SECRET = "c-smoke-plugin-client", "plugin-client-secret-" + ("s" * 32)
OTHER_CID, OTHER_SECRET = "c-smoke-plugin-other", "plugin-other-secret-" + ("o" * 32)
USER_ID, OTHER_USER_ID = "u-smoke-plugin-client", "u-smoke-plugin-other"
TID, OTHER_TID, WRONG_TID = (
    "t-smoke-plugin-client", "t-smoke-plugin-other", "t-smoke-plugin-wrong-project")
PROJECT, OTHER_PROJECT = "p-smoke-plugin-client", "p-smoke-plugin-other"
REPO, OTHER_REPO = "r-smoke-plugin-client", "r-smoke-plugin-client-other"
PLUGIN, VERSION, BINDING = (
    "plg-smoke-plugin-client", "plv-smoke-plugin-client", "plb-smoke-plugin-client")
ok = fail = 0
log = []
TOKENS = {}


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        log.append("  PASS  " + name)
    else:
        fail += 1
        log.append("  FAIL  " + name + ("  << " + str(extra)[:400] if extra else ""))


def headers(cid=CID, secret=SECRET):
    del secret  # Current clients use short-lived sessions, never the long-lived key.
    return {"Authorization": "Device " + TOKENS.get(cid, "")}


async def purge():
    async with SessionLocal() as session:
        task_ids = [TID, OTHER_TID, WRONG_TID]
        run_ids = list((await session.execute(select(am.WorkflowRun.id).where(
            am.WorkflowRun.task_id.in_(task_ids)))).scalars())
        if run_ids:
            await session.execute(delete(am.WorkflowEvent).where(am.WorkflowEvent.run_id.in_(run_ids)))
            await session.execute(delete(am.WorkflowOutbox).where(am.WorkflowOutbox.run_id.in_(run_ids)))
            await session.execute(delete(am.NodeRun).where(am.NodeRun.run_id.in_(run_ids)))
            await session.execute(delete(am.WorkflowRun).where(am.WorkflowRun.id.in_(run_ids)))
        await session.execute(delete(models.TaskEvent).where(models.TaskEvent.task_id.in_(task_ids)))
        await session.execute(delete(models.Task).where(models.Task.id.in_(task_ids)))
        await session.execute(delete(models.Repo).where(models.Repo.id.in_([REPO, OTHER_REPO])))
        await session.execute(delete(am.PluginBinding).where(am.PluginBinding.id == BINDING))
        await session.execute(delete(am.PluginVersion).where(am.PluginVersion.id == VERSION))
        await session.execute(delete(am.Plugin).where(am.Plugin.id == PLUGIN))
        await session.execute(delete(models.Project).where(
            models.Project.id.in_([PROJECT, OTHER_PROJECT])))
        await session.execute(delete(models.Client).where(
            models.Client.id.in_([CID, OTHER_CID])))
        await session.execute(delete(models.User).where(
            models.User.id.in_([USER_ID, OTHER_USER_ID])))
        await session.commit()


async def seed():
    await purge()
    async with SessionLocal() as session:
        session.add_all([
            models.User(id=USER_ID, username="plugin-client-smoke",
                        display_name="Plugin client smoke", is_active=True),
            models.User(id=OTHER_USER_ID, username="plugin-other-smoke",
                        display_name="Plugin other smoke", is_active=True),
        ])
        session.add_all([
            models.Client(id=CID, name="插件客户端冒烟", secret_hash=device_auth.hash_secret(SECRET),
                          auth_state="active", user_ref=USER_ID),
            models.Client(id=OTHER_CID, name="无关客户端",
                          secret_hash=device_auth.hash_secret(OTHER_SECRET),
                          auth_state="active", user_ref=OTHER_USER_ID),
            models.Project(id=PROJECT, name="插件客户端项目"),
            models.Project(id=OTHER_PROJECT, name="另一个项目"),
            models.Repo(id=REPO, project_id=PROJECT, name="客户端", local_dir="client"),
            models.Repo(id=OTHER_REPO, project_id=PROJECT, name="服务端", local_dir="server"),
            models.Task(id=TID, title="从客户端启动插件", owner_client_id=CID,
                        project_id=PROJECT, status="todo"),
            models.Task(id=OTHER_TID, title="别人的任务", owner_client_id=OTHER_CID,
                        project_id=PROJECT, status="todo"),
            models.Task(id=WRONG_TID, title="绑定不属于这个项目", owner_client_id=CID,
                        project_id=OTHER_PROJECT, status="todo"),
            am.Plugin(id=PLUGIN, key="smoke-plugin-client", name="客户端插件冒烟",
                      description="验证普通用户能看到并启动企业方法",
                      enabled=True, source_kind="adapter"),
            am.PluginVersion(
                id=VERSION, plugin_id=PLUGIN, version="1.0.0", checksum="smoke-client-api",
                manifest={"inputs": [
                    {"key": "audience", "label": "目标用户", "type": "text", "required": True},
                    {"key": "confirm", "label": "确认范围", "type": "boolean"},
                    {"key": "../unsafe", "label": "不安全字段", "type": "secret"},
                ]}, workflow={"nodes": [{
                    "key": "ready", "type": "condition",
                    "name": "检查输入", "config": {"inputKey": "confirm", "equals": True}}]},
                capability_report={"nodeTypes": ["condition"], "skills": ["product"],
                                   "mcpServers": [], "network": False},
                trust_state="approved", enabled=True),
            am.PluginBinding(id=BINDING, plugin_id=PLUGIN, version_id=VERSION,
                             project_id=PROJECT, config={"agentKind": "local:pi"},
                             secret_refs={"llm": "secret-hidden"}, enabled=True),
        ])
        await session.commit()
        for client_id in (CID, OTHER_CID):
            client = await session.get(models.Client, client_id)
            TOKENS[client_id] = device_auth.issue_session(client)[0]


async def main():
    await init_db()
    await seed()
    from route_test_support import api_routes
    paths = {route.path for route in api_routes(app)}
    chk("管理端和客户端都有明确的质量关重试动作",
        "/api/v1/admin/plugin-runs/{run_id}/retry-quality" in paths
        and "/api/v1/plugin-runs/{run_id}/retry-quality" in paths, sorted(paths))
    chk("客户端恢复入口把纯 Git 固定提交视为一等产出",
        plugin_api._has_recoverable_output({"gitHead": "a" * 40})
        and not plugin_api._has_recoverable_output({}))
    route = workflow_engine.execution_route(
        {"execution": {"agentKind": "local:opencode", "model": "run-model"}},
        {"agentKind": "local:claude"},
        {"execution": {"agentKind": "local:pi", "model": "node-model",
                       "fallbackMode": "strict", "runnerTags": ["研发"]}}, "build")
    chk("节点级底座与模型优先于整条运行的默认选择",
        route == {"agentKind": "local:pi", "model": "node-model",
                  "fallbackMode": "strict", "runnerTags": ["研发"],
                  "reasoningEffort": "",
                  "manual": False}, route)
    overridden = workflow_engine.execution_route(
        {"execution": {"agentKind": "local:opencode", "model": "run-model"}},
        {"nodeOverrides": {"build": {"execution": {
            "agentKind": "local:codex", "model": "project-model"}}}},
        {"agentKind": "local:pi", "model": "node-model"}, "build")
    chk("项目可以只覆盖指定节点的执行配置",
        overridden["agentKind"] == "local:codex"
        and overridden["model"] == "project-model", overridden)
    normalized = workflow_runs.normalize_binding_execution({
        "agentKind": "local:pi", "nodeOverrides": {
            "build": {"execution": {"agentKind": "local:opencode", "model": "node-model", "fallbackMode": "strict"}}}},
        {"nodes": [{"key": "build", "type": "ai"}, {"key": "gate", "type": "quality"}]})
    chk("绑定配置会规范化节点级 Agent、模型与降级策略",
        normalized["agentKind"] == "local:pi" and normalized["nodeOverrides"]["build"]["execution"]["model"] == "node-model", normalized)
    rejected = False
    try:
        workflow_runs.normalize_binding_execution({"nodeOverrides": {"gate": {"agentKind": "local:pi"}}},
                                                   {"nodes": [{"key": "gate", "type": "quality"}]})
    except ValueError:
        rejected = True
    chk("非 AI 节点不能伪装成 Agent 执行节点", rejected)
    invalid_shape = False
    try:
        workflow_runs.normalize_binding_execution({"nodeOverrides": {"build": "local:pi"}},
                                                   {"nodes": [{"key": "build", "type": "ai"}]})
    except ValueError:
        invalid_shape = True
    chk("节点执行覆盖必须是结构化配置", invalid_shape)
    old_version = {
        "version": "1.0.0", "manifest": {"inputs": []},
        "workflow": {"nodes": [{
            "key": "build", "type": "ai", "config": {"prompt": "build"},
            "outputs": [{"key": "code", "kind": "git", "required": True}],
            "inputs": []}]},
        "capabilities": {"skills": [], "mcpServers": [], "network": False},
    }
    breaking_version = {
        "version": "2.0.0", "manifest": {"inputs": []},
        "workflow": {"nodes": [{
            "key": "build", "type": "ai", "config": {"prompt": "build better"},
            "outputs": [
                {"key": "code", "kind": "git", "required": True},
                {"key": "report", "kind": "file", "path": "report.md", "required": True}],
            "inputs": []}]},
        "capabilities": {"skills": ["review"], "mcpServers": [], "network": False},
    }
    compatibility = plugin_compat.between(old_version, breaking_version)
    chk("新增必交产出会被识别为破坏性插件升级",
        compatibility["level"] == "breaking"
        and any(x["code"] == "output.required_added"
                for x in compatibility["changes"]), compatibility)
    review_version = {
        **old_version, "version": "1.1.0",
        "capabilities": {"skills": ["review"], "mcpServers": [], "network": True},
    }
    capability_change = plugin_compat.between(old_version, review_version)
    chk("新增技能或网络权限会要求重新审查但不会伪装成无变化",
        capability_change["level"] == "review"
        and len(capability_change["changes"]) == 2, capability_change)
    handoff = workflow_context.dependency_handoff({"dependencies": {
        "analyze": {"summary": "需求已经确认", "decisions": ["使用现有仓库"]}}})
    chk("上游节点结构化输出会进入后续 Agent 上下文",
        "需求已经确认" in handoff["prompt"]
        and handoff["snapshot"]["dependencyKeys"] == ["analyze"], handoff)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
            transport=transport, base_url="http://test", timeout=30) as client:
        available = await client.get(f"/api/v1/tasks/{TID}/plugins", headers=headers())
        choices = available.json().get("items") if available.status_code == 200 else []
        choice = choices[0] if choices else {}
        chk("客户端能列出当前项目已审批的方法插件",
            available.status_code == 200 and len(choices) == 1
            and choice.get("bindingId") == BINDING and choice.get("projectSpecific") is True,
            available.text)
        chk("插件清单是安全且可直接渲染的摘要",
            choice.get("agentKind") == "local:pi"
            and [x.get("key") for x in choice.get("inputs") or []] == ["audience", "confirm"]
            and choice.get("workflow") == [{"key": "ready", "type": "condition", "name": "检查输入"}]
            and "secretRefs" not in choice and "packagePath" not in choice,
            available.text)

        wrong_available = await client.get(
            f"/api/v1/tasks/{WRONG_TID}/plugins", headers=headers())
        chk("别的项目不会看到不适用的插件绑定",
            wrong_available.status_code == 200 and wrong_available.json().get("items") == [],
            wrong_available.text)
        foreign_available = await client.get(
            f"/api/v1/tasks/{TID}/plugins", headers=headers(OTHER_CID, OTHER_SECRET))
        chk("其他客户端不能探测这条任务可用的插件",
            foreign_available.status_code == 404, foreign_available.text)

        invalid_runner = await client.post(
            f"/api/v1/tasks/{TID}/plugin-runs", headers=headers(),
            json={"bindingId": BINDING, "inputs": {"confirm": True, "audience": "测试同事"},
                  "execution": {"agentKind": "runner:someone:pi"}})
        chk("普通用户只能选底座，不能越权点名某一台 Runner",
            invalid_runner.status_code == 409 and "底座" in invalid_runner.text,
            invalid_runner.text)

        missing_required = await client.post(
            f"/api/v1/tasks/{TID}/plugin-runs", headers=headers(),
            json={"bindingId": BINDING, "inputs": {"confirm": True},
                  "execution": {"agentKind": "local:pi"}})
        chk("服务端也会阻止绕过界面漏掉插件必填项",
            missing_required.status_code == 409 and "目标用户" in missing_required.text,
            missing_required.text)

        started = await client.post(
            f"/api/v1/tasks/{TID}/plugin-runs", headers=headers(),
            json={"pluginId": PLUGIN, "inputs": {"confirm": True, "audience": "一线同事"},
                  "instruction": "先形成证据，不要中途询问",
                  "repoId": REPO,
                  "execution": {"agentKind": "local:opencode", "model": "smoke-model"}})
        body = started.json() if started.status_code == 200 else {}
        run_id = body.get("id") or ""
        chk("任务归属人可从客户端启动项目已批准插件",
            started.status_code == 200 and run_id and body.get("taskId") == TID, started.text)
        async with SessionLocal() as session:
            persisted = await session.get(am.WorkflowRun, run_id) if run_id else None
            persisted_task = await session.get(models.Task, TID)
            context = dict((persisted.context if persisted else {}) or {})
            chk("每次运行独立保存底座、模型与补充要求",
                context.get("execution") == {"agentKind": "local:opencode", "model": "smoke-model"}
                and context.get("instruction") == "先形成证据，不要中途询问", context)
            chk("多工程项目会使用用户在客户端明确选择的工程",
                persisted_task is not None and persisted_task.repo_id == REPO,
                getattr(persisted_task, "repo_id", ""))

        duplicate = await client.post(
            f"/api/v1/tasks/{TID}/plugin-runs", headers=headers(),
            json={"pluginId": PLUGIN, "inputs": {"confirm": True}})
        chk("同一任务已有活动流程时拒绝重复启动", duplicate.status_code == 409, duplicate.text)

        hidden = await client.get(f"/api/v1/tasks/{TID}/plugin-runs",
                                  headers=headers(OTHER_CID, OTHER_SECRET))
        chk("其他客户端看不到这条任务的插件运行", hidden.status_code == 404, hidden.text)

        foreign_task = await client.post(
            f"/api/v1/tasks/{OTHER_TID}/plugin-runs", headers=headers(),
            json={"pluginId": PLUGIN, "inputs": {"confirm": True}})
        chk("客户端不能给别人的任务启动插件", foreign_task.status_code == 404, foreign_task.text)

        wrong_binding = await client.post(
            f"/api/v1/tasks/{WRONG_TID}/plugin-runs", headers=headers(),
            json={"bindingId": BINDING, "inputs": {"confirm": True}})
        chk("客户端不能把别的项目绑定套到自己的任务上",
            wrong_binding.status_code == 409 and "项目" in wrong_binding.text, wrong_binding.text)

        listed = await client.get(f"/api/v1/tasks/{TID}/plugin-runs", headers=headers())
        detail = await client.get(f"/api/v1/plugin-runs/{run_id}", headers=headers())
        chk("客户端能查看自己任务的运行列表与完整证据",
            listed.status_code == 200 and len(listed.json().get("items") or []) == 1
            and detail.status_code == 200 and detail.json().get("id") == run_id,
            (listed.text, detail.text))

        no_artifacts = await client.post(
            f"/api/v1/plugin-runs/{run_id}/recover-artifacts", headers=headers())
        chk("没有 AI 节点的流程不会伪造可恢复产出",
            no_artifacts.status_code == 409, no_artifacts.text)

        not_failed_quality = await client.post(
            f"/api/v1/plugin-runs/{run_id}/retry-quality", headers=headers())
        chk("普通用户不能把尚未失败的流程强行改成质量重试",
            not_failed_quality.status_code == 409, not_failed_quality.text)
        not_failed_gate = await client.post(
            f"/api/v1/plugin-runs/{run_id}/retry-gate", headers=headers())
        chk("普通用户不能把尚未失败的流程强行改成关卡重试",
            not_failed_gate.status_code == 409, not_failed_gate.text)
        foreign_retry = await client.post(
            f"/api/v1/plugin-runs/{run_id}/retry-quality",
            headers=headers(OTHER_CID, OTHER_SECRET))
        chk("别的客户端不能重试不属于自己的流程",
            foreign_retry.status_code == 404, foreign_retry.text)
        foreign_gate = await client.post(
            f"/api/v1/plugin-runs/{run_id}/retry-gate",
            headers=headers(OTHER_CID, OTHER_SECRET))
        chk("别的客户端不能续跑不属于自己的失败关卡",
            foreign_gate.status_code == 404, foreign_gate.text)


async def guarded():
    try:
        await main()
    finally:
        await purge()
        async with SessionLocal() as session:
            chk("客户端插件冒烟数据清理干净",
                await session.get(models.Task, TID) is None
                and await session.get(models.Client, CID) is None)
        await engine.dispose()


asyncio.run(guarded())
log.append("")
log.append("PASS=%d FAIL=%d" % (ok, fail))
with io.open("smoke_plugin_client_api.out.txt", "w", encoding="utf-8") as file:
    file.write("\n".join(log))
print("PASS=%d FAIL=%d" % (ok, fail))
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
shutil.rmtree(DATA, ignore_errors=True)
sys.exit(1 if fail else 0)
