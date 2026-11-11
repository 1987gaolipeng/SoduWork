# -*- coding: utf-8 -*-
"""Regression checks for public module contracts."""
import asyncio
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(BASE, ".smoke-pluginready.db")


def _cleanup_db():
    for sfx in ("", "-shm", "-wal"):
        try:
            os.remove(DB + sfx)
        except FileNotFoundError:
            pass


_cleanup_db()
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, BASE)

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import (agent_route_selection, ai_exec, execution_capabilities,  # noqa: E402
                          plugin_packages, plugin_service, runner_hub)
from app.services import workflow_engine  # noqa: E402
from app.services import plugin_route_readiness  # noqa: E402
from app.services import plugin_readiness  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:260] if extra else ""))


def _manifest(nodes):
    return {"schemaVersion": 1, "key": "smoke-ready", "version": "1.0.0",
            "name": "导入可用冒烟", "workflow": {"nodes": nodes}}


def t_normalize():
    # Normalize legacy script argv into commands.
    _, wf, _ = plugin_packages.normalize(_manifest([
        {"key": "build", "type": "script", "config": {"argv": ["echo", "hi"],
                                                      "timeoutSeconds": 30}},
    ]))
    node = wf["nodes"][0]
    chk("①★script 老写法 argv 规范化成 commands（规范≠运行时的坑焊死）",
        node["config"]["commands"][0]["argv"] == ["echo", "hi"]
        and node["config"]["commands"][0]["timeoutSeconds"] == 30, node["config"])
    try:
        plugin_packages.normalize(_manifest([{"key": "b", "type": "script", "config": {}}]))
        chk("① script 没命令导入即拒", False)
    except ValueError as e:
        chk("① script 没命令导入即拒（错误带节点 key 与字段说明）",
            "b" in str(e) and "commands" in str(e), str(e))

    # Reject unregistered tool names during import.
    try:
        plugin_packages.normalize(_manifest([
            {"key": "t", "type": "tool", "config": {"tool": "rm_rf"}}]))
        chk("②★tool 未登记的工具导入即拒", False)
    except ValueError as e:
        chk("②★tool 未登记的工具导入即拒（列出可用清单）",
            "受信名单" in str(e) and "http_check" in str(e), str(e))
    _, wf, _ = plugin_packages.normalize(_manifest([
        {"key": "t", "type": "tool",
         "config": {"tool": "http_check", "args": {"url": "https://x/"}}}]))
    chk("② 登记过的工具正常通过", wf["nodes"][0]["config"]["tool"] == "http_check")


def t_route_selection():
    originals = (ai_exec.LOCAL_AGENT_KINDS, ai_exec.agent_kinds,
                 ai_exec.model_choices, ai_exec.resolve_kind)
    try:
        ai_exec.LOCAL_AGENT_KINDS = (
            "local:pi", "local:opencode", "local:codex")
        ai_exec.agent_kinds = lambda: [
            {"key": "local:pi", "name": "Pi", "modelPick": True},
            {"key": "local:opencode", "name": "OpenCode", "modelPick": True},
            {"key": "local:codex", "name": "Codex", "modelPick": False},
        ]
        ai_exec.model_choices = lambda ctx: {
            "default": "company-default", "list": ["review-model"]}
        ai_exec.resolve_kind = lambda ctx, kind, *args, **kwargs: {
            "id": kind, "name": kind} if kind in {
                "local:pi", "local:opencode", "local:codex"} else None
        exact = agent_route_selection.resolve_sync(
            {}, "local:pi", fallback_mode="strict", model="review-model")
        native = agent_route_selection.resolve_sync(
            {}, "local:codex", fallback_mode="best-effort", model="review-model")
        blocked = agent_route_selection.resolve_sync(
            {}, "local:pi", fallback_mode="strict", model="private-model")
        chk("③ Agent 与模型使用同一个路由器校验",
            exact["ok"] and exact["resolvedKind"] == "local:pi"
            and native["ok"] and native["resolvedKind"] == "local:codex"
            and not native["fallbackKind"]
            and not blocked["ok"]
            and "未在当前企业开放" in blocked["modelErrors"][0],
            (exact, native, blocked))
    finally:
        (ai_exec.LOCAL_AGENT_KINDS, ai_exec.agent_kinds,
         ai_exec.model_choices, ai_exec.resolve_kind) = originals


async def t_readiness():
    await init_db()
    async with SessionLocal() as s:
        s.add(models.Project(id="p-empty", name="空项目", owner_user_id="u1"))
        s.add(models.Project(id="p-ok", name="齐项目", owner_user_id="u1"))
        s.add(models.Repo(id="r-ok", project_id="p-ok", name="仓", git_url="https://x/r.git",
                          default_branch="main", merge_branch="main", server_dir=r"C:\srv\ok"))
        s.add(am.Environment(id="e-t", key="test", name="测试", enabled=True,
                             promotion_policy={"autoStart": True}))
        await s.commit()

    dev_nodes = [
        {"key": "impl", "type": "ai", "config": {"prompt": "干活" * 10},
         "outputs": [{"key": "code", "kind": "git", "required": True}]},
        {"key": "gate", "type": "quality", "dependsOn": ["impl"],
         "config": {"commands": [{"name": "c", "argv": ["git", "diff", "--check"]}]}},
        {"key": "ship", "type": "deploy", "dependsOn": ["gate"],
         "config": {"environmentKey": "test"}},
    ]
    _, wf, _ = plugin_packages.normalize(_manifest(dev_nodes))
    async with SessionLocal() as s:
        ver = am.PluginVersion(id="pv-ready", plugin_id="pl-r", version="1.0.0",
                               checksum="x", trust_state="approved", enabled=True,
                               workflow=wf)
        s.add(ver)
        await s.commit()

    async with SessionLocal() as s:
        ver = await s.get(am.PluginVersion, "pv-ready")
        p_empty = await s.get(models.Project, "p-empty")
        p_ok = await s.get(models.Project, "p-ok")
        r = await plugin_service.binding_readiness(s, ver, p_empty, None)
        chk("③★项目没有工程 -> blocker（导入/启用时就说，不等跑挂）",
            not r["ok"] and any("一个工程都没有" in x for x in r["blockers"]), r)
        r = await plugin_service.binding_readiness(s, ver, p_ok, None)
        chk("③ 项目配齐 -> 放行", r["ok"], r)
        chk("③ 没配部署目标 -> warning 说出来但不拦",
            any("部署目标" in x for x in r["warnings"]), r)

    # Report a missing environment.
    bad_env = [{"key": "ship", "type": "deploy", "config": {"environmentKey": "prod-x"}}]
    _, wf2, _ = plugin_packages.normalize(_manifest(bad_env))
    async with SessionLocal() as s:
        ver2 = am.PluginVersion(id="pv-env", plugin_id="pl-r", version="1.0.1",
                                checksum="y", trust_state="approved", workflow=wf2)
        s.add(ver2)
        await s.commit()
    async with SessionLocal() as s:
        ver2 = await s.get(am.PluginVersion, "pv-env")
        p_ok = await s.get(models.Project, "p-ok")
        r = await plugin_service.binding_readiness(s, ver2, p_ok, None)
        chk("③★deploy 声明的环境不存在 -> blocker（指去环境中心建）",
            not r["ok"] and any("prod-x" in x and "环境中心" in x for x in r["blockers"]), r)

    # Detect unavailable MCP dependencies during binding or simulation rather than after dispatch.
    mcp_manifest = {
        "schemaVersion": 1, "key": "mcp-ready", "version": "1.0.2",
        "name": "MCP 就绪检查", "instructions": "使用知识库完成任务",
        "capabilities": {"mcpServers": ["knowledge-base"], "network": True},
    }
    normalized_mcp, mcp_workflow, mcp_report = plugin_packages.normalize(mcp_manifest)
    async with SessionLocal() as s:
        s.add(am.PluginVersion(
            id="pv-mcp", plugin_id="pl-r", version="1.0.2", checksum="m",
            trust_state="approved", enabled=True, manifest=normalized_mcp,
            workflow=mcp_workflow, capability_report=mcp_report))
        await s.commit()
    async with SessionLocal() as s:
        mcp_version = await s.get(am.PluginVersion, "pv-mcp")
        readiness = await plugin_service.binding_readiness(s, mcp_version, None, None)
        chk("③★缺少 MCP 在派发前阻断并返回结构化检查",
            not readiness["ok"]
            and any("knowledge-base" in x for x in readiness["blockers"])
            and any(x["key"] == "mcp" and not x["ok"]
                    for x in readiness.get("checks") or []), readiness)

    async with SessionLocal() as s:
        s.add(am.PluginVersion(
            id="pv-runtime", plugin_id="pl-r", version="1.0.3", checksum="rt",
            trust_state="approved", enabled=True,
            workflow={"nodes": [
                {"key": "browse", "type": "ai", "name": "网页处理",
                 "capabilities": {"explicit": True, "runtime": ["browser"]},
                 "config": {"prompt": "处理网页"}},
                {"key": "office", "type": "ai", "name": "文档处理",
                 "capabilities": {"explicit": True, "runtime": ["office"]},
                 "config": {"prompt": "处理文档"}},
            ]}, capability_report={"runtime": ["browser", "office"]}))
        await s.commit()
    old_online = runner_hub.online
    old_local = execution_capabilities.runtime_report
    try:
        runner_hub.online = lambda: [
            type("Runner", (), {"capabilities": {"available": ["browser"]}})(),
            type("Runner", (), {"capabilities": {"available": ["office"]}})(),
        ]
        execution_capabilities.runtime_report = lambda *args, **kwargs: {
            "available": []}
        async with SessionLocal() as s:
            version = await s.get(am.PluginVersion, "pv-runtime")
            split_ready = await plugin_service.binding_readiness(
                s, version, None, None)
        runner_hub.online = lambda: [
            type("Runner", (), {"capabilities": {"available": ["browser"]}})()]
        async with SessionLocal() as s:
            version = await s.get(am.PluginVersion, "pv-runtime")
            missing = await plugin_service.binding_readiness(
                s, version, None, None)
        async with SessionLocal() as s:
            version = await s.get(am.PluginVersion, "pv-runtime")
            remaining = await plugin_readiness.scoped_binding_readiness(
                s, version, None, None, node_keys={"browse"})
        chk("③ 断点续跑只检查尚待执行节点，不被历史节点的旧能力误阻断",
            remaining["ok"], remaining)

        chk("③ 多节点可由不同 Runner 分别承接，缺能力时在启动前硬阻断",
            split_ready["ok"] and not missing["ok"]
            and any("文档处理" in x or "办公文档" in x
                    or "Office" in x or "office" in x
                    for x in missing["blockers"]), (split_ready, missing))
        async with SessionLocal() as s:
            s.add_all([
                am.Plugin(id="pl-start-ready", key="start-ready",
                          name="启动硬闸", enabled=True),
                am.PluginVersion(
                    id="pv-start-ready", plugin_id="pl-start-ready",
                    version="1.0.0", checksum="start-ready",
                    trust_state="approved", enabled=True,
                    workflow={"nodes": [{
                        "key": "office", "type": "ai", "name": "生成文档",
                        "capabilities": {
                            "explicit": True, "runtime": ["office"]},
                        "config": {"prompt": "生成文档"},
                    }]}, capability_report={"runtime": ["office"]}),
                am.PluginBinding(
                    id="pb-start-ready", plugin_id="pl-start-ready",
                    version_id="pv-start-ready", enabled=True),
                models.Task(id="t-start-ready", title="验证启动前硬闸"),
            ])
            await s.commit()
        async with SessionLocal() as s:
            task = await s.get(models.Task, "t-start-ready")
            binding = await s.get(am.PluginBinding, "pb-start-ready")
            rejected = ""
            try:
                await workflow_engine.start(s, task, binding, {})
            except ValueError as exc:
                rejected = str(exc)
            rows = list((await s.execute(am.WorkflowRun.__table__.select().where(
                am.WorkflowRun.task_id == task.id))).all())
            await s.refresh(task)
            chk("③ 直接启动也强制预检且失败不落运行记录、不改变任务状态",
                "运行前检查未通过" in rejected and not rows
                and task.status == "todo", (rejected, rows, task.status))
    finally:
        runner_hub.online = old_online
        execution_capabilities.runtime_report = old_local
    old_load = ai_exec.load
    async def broken_agent_directory(*args, **kwargs):
        raise RuntimeError("directory offline")
    try:
        ai_exec.load = broken_agent_directory
        marker = await plugin_route_readiness.context_for_task(None, None)
        async with SessionLocal() as s:
            version = await s.get(am.PluginVersion, "pv-runtime")
            directory_failure = await plugin_route_readiness.check(
                s, version, ctx=marker, node_keys={"browse"})
        chk("③ 执行机目录故障返回可恢复中文阻断，不让目录或启动接口报 500",
            not directory_failure["ok"]
            and any("检查 Hub 与 Runner 连接" in x
                    for x in directory_failure["blockers"]), directory_failure)
    finally:
        ai_exec.load = old_load


    # Third-party packages may enter quarantine for review, but unsupported components must not be advertised as executable.
    async with SessionLocal() as s:
        s.add(am.PluginVersion(
            id="pv-adapter", plugin_id="pl-r", version="0.0.0+adapter",
            checksum="z", trust_state="quarantined", enabled=False, workflow={"nodes": [{
                "key": "execute", "type": "ai", "name": "执行", "dependsOn": [],
                "config": {"prompt": "执行插件方法"}, "outputs": [],
            }]}, capability_report={
                "externalSkills": [], "bundledSkills": [],
                "adapterBlockers": ["包内没有可转换的 Agent Skill"],
            }))
        await s.commit()
    async with SessionLocal() as s:
        ver3 = await s.get(am.PluginVersion, "pv-adapter")
        p_ok = await s.get(models.Project, "p-ok")
        readiness = await plugin_service.binding_readiness(s, ver3, p_ok, None)
        chk("④ 第三方包无法转换时可审查但不能绑定运行",
            not readiness["ok"] and any("Agent Skill" in x for x in readiness["blockers"]),
            readiness)
        simulation = await plugin_service.simulate(s, ver3, p_ok, None, "local:pi")
        chk("④ 模拟只做干跑并一次列清信任、技能、执行机与项目检查",
            simulation["dryRun"] and not simulation["ok"]
            and {x["key"] for x in simulation["checks"]} == {
                "trust", "skills", "agent", "project"}, simulation)

    # Allow staged binding setup before configuration is complete.
    # Save unready bindings disabled and enforce readiness whenever any entry point enables them.
    async with SessionLocal() as s:
        plugin = am.Plugin(id="pl-r", key="smoke-ready", name="导入可用冒烟", enabled=True)
        s.add(plugin)
        await s.commit()
    async with SessionLocal() as s:
        plugin = await s.get(am.Plugin, "pl-r")
        row = await plugin_service.save_binding(s, plugin, {
            "versionId": "pv-ready", "projectId": "p-empty",
            "config": {}, "enabled": False})
        chk("⑧ 未就绪绑定允许先停用保存并继续补配置",
            row is not None and not row.enabled)
        ver = await s.get(am.PluginVersion, "pv-ready")
        p_empty2 = await s.get(models.Project, "p-empty")
        r = await plugin_service.binding_readiness(s, ver, p_empty2, row.org_id)
        chk("⑧ 可用性结论随手可取、问题在启用前说明",
            not r["ok"] and r["blockers"], r)
        rejected = ""
        try:
            await plugin_service.save_binding(s, plugin, {"enabled": True}, row)
        except ValueError as exc:
            rejected = str(exc)
            await s.rollback()
        chk("⑧ 未通过体检的绑定不能被任何入口启用",
            "启用前体检未通过" in rejected, rejected)



async def _run():
    try:
        await t_readiness()
    finally:
        await engine.dispose()


try:
    t_normalize()
    t_route_selection()
    asyncio.run(_run())
finally:
    _cleanup_db()

print(f"\n{ok} PASS / {fail} FAIL")
sys.exit(1 if fail else 0)
