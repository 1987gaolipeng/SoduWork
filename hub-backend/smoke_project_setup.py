# -*- coding: utf-8 -*-
"""Verify project setup resolves one default workflow binding and reuses real environment and
Runner configuration.
"""
import asyncio
import json
import os
import sys
from types import SimpleNamespace

DB = os.path.abspath(".smoke-project-setup.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import (environment_service, managed_delivery_context,  # noqa: E402
                          plugin_service, project_setup, release_control, runner_hub,
                          workflow_engine)

ok = fail = 0


def chk(name, value, extra=""):
    global ok, fail
    if value:
        ok += 1
        print("  PASS ", name)
    else:
        fail += 1
        print("  FAIL ", name, extra)


async def main():
    await init_db()
    async with SessionLocal() as session:
        await release_control.bootstrap(session)
        await plugin_service.bootstrap_example(session)
        development_plugin = (await session.execute(select(am.Plugin).where(
            am.Plugin.key == "engineering-delivery"))).scalar_one()
        development_versions = list((await session.execute(select(am.PluginVersion).where(
            am.PluginVersion.plugin_id == development_plugin.id))).scalars().all())
        development_version = max(
            development_versions, key=lambda row: project_setup._version_key(row.version))
        development_nodes = list(development_version.workflow.get("nodes") or [])
        development_by_key = {row["key"]: row for row in development_nodes}
        chk("纯研发闭环作为独立内置工作方法注册",
            [row["key"] for row in development_nodes] == [
                "scope", "implement", "quality", "review", "merge", "receipt"])
        chk("纯研发闭环显式允许自动合并且不包含环境发布节点",
            development_by_key["merge"]["config"].get("autoSubmit") is True
            and not any(row["type"] in {"deploy", "deploy_chain"}
                        for row in development_nodes))
        chk("纯研发闭环第一关必须交付机器可判定的继续/阻断结论",
            any(output.get("kind") == "decision"
                and output.get("path") == "workflow-decision.json"
                for output in development_by_key["scope"].get("outputs") or []))
        actor = models.User(id="u-owner", username="owner", display_name="项目负责人",
                            password_hash="x", is_super=True, is_active=True)
        client = models.Client(id="client-demo", name="项目负责人电脑", user_ref=actor.id,
                               auth_state="active",
                               git_creds={
                                   "name": "项目负责人",
                                   "email": "owner@example.com",
                                   "user": "owner",
                                   "token": "x",
                               })
        project = models.Project(id="p-demo", name="演示工程")
        repo = models.Repo(id="r-demo", project_id=project.id, name="网站", kind="frontend",
                           git_url="https://git.example/demo.git", default_branch="develop",
                           merge_branch="develop", local_dir="demo")
        env = am.Environment(id="env-demo", key="verify", name="验证环境", tier="custom",
                             enabled=True, promotion_policy={
                                 "autoStart": True, "requires": [], "requiresApproval": True,
                                 "requiresAcceptance": True, "marksDelivery": True,
                             }, runner_selector={"tags": ["verify"]})
        target = am.DeploymentTarget(
            id="target-demo", repo_id=repo.id, environment_id=env.id, name="演示发布",
            provider="runner-command", config={"argv": ["deploy-demo"]}, enabled=True,
            health_checks=[{"type": "http", "url": "http://demo/health"}],
            rollback={"mode": "manual"})
        session.add_all([actor, client, project, repo, env, target])
        await session.commit()

        fake = SimpleNamespace(id="runner-demo", host="runner-host", client_id=client.id)
        fake.agents = [{"key": "pi", "name": "Pi", "version": "0.83.0"},
                       {"key": "codex", "name": "Codex", "version": "1.0.0"}]
        fake.version = "smoke"
        fake.busy = False
        fake.os = "linux"
        fake.org_id = ""
        fake.owner_name = "项目负责人"
        fake.work_root = "/workspace"
        fake.tags = ["verify", "docker"]
        fake.skills = []
        fake.skills_known = True
        fake.connected_at = 0
        fake.last_beat = 0
        fake.dispatch_mode = "accepting"
        fake.ready = True
        fake.inventory_ready = True
        fake.capabilities = {"available": ["files", "terminal", "repository", "browser", "office", "computer"]}
        fake.alive = lambda: True
        fake.api = lambda: {
            "online": True, "runnerId": fake.id, "clientId": client.id,
            "orgId": fake.org_id, "host": fake.host, "os": fake.os,
            "version": fake.version, "workRoot": fake.work_root, "tags": list(fake.tags),
            "agents": list(fake.agents), "skills": list(fake.skills),
            "skillsKnown": fake.skills_known, "capabilities": dict(fake.capabilities),
            "busy": fake.busy, "mode": fake.dispatch_mode, "accepting": True,
            "since": fake.connected_at, "lastSeen": fake.last_beat,
        }
        old_api, old_pick = runner_hub.api_list, runner_hub.pick_by_tags
        old_pick_for, old_call, old_get = runner_hub.pick_for, runner_hub.call_sync, runner_hub.get
        old_for_client = runner_hub.for_client
        old_online = runner_hub.online
        old_dispatchable = runner_hub.dispatchable
        runner_hub.api_list = lambda: [{
            "online": True, "runnerId": fake.id, "clientId": "client-demo",
            # Use the actual Runner inventory shape: installed entries with version-based availability.
            "host": fake.host, "agents": list(fake.agents),
        }]
        runner_hub.online = lambda: [fake]
        runner_hub.online = lambda: [fake]
        runner_hub.dispatchable = lambda: [fake]
        runner_hub.pick_by_tags = lambda *args, **kwargs: fake
        runner_hub.pick_for = lambda *args, **kwargs: fake
        runner_hub.get = lambda runner_id: fake if runner_id == fake.id else None
        runner_hub.for_client = lambda client_id: fake if client_id == client.id else None
        runner_hub.call_sync = lambda _runner, op, _data, timeout=60: {
            "ok": True, "data": {"ok": True, "target": "develop", "head": "abc123"}
        } if op == "git.probe" else {
            "ok": True, "commandState": "repository_relative", "secrets": []}
        try:
            before = await project_setup.status(
                session, project, {"client-demo"}, "validation")
            default_before = await project_setup.status(
                session, project, {"client-demo"})
            chk("未配置交付方式的项目默认选择纯研发闭环而不是发布链",
                default_before["mode"] == "development", default_before["mode"])
            chk("界面只返回五项用户语言检查", len(before["checks"]) == 5)
            chk("缺少负责人时不静默拿当前管理员顶替", before["autoFixCount"] == 1
                and not before["canAutoConfigure"],
                before["checks"])
            chk("未做真实预检的发布环境不会被虚假标绿",
                not next(x for x in before["checks"] if x["key"] == "environment")["ok"]
                and not next(x for x in before["checks"] if x["key"] == "runner")["ok"])
            chk("界面拿到业务语言的执行路径",
                [x["label"] for x in before["journey"]] == [
                    "稳定复现与执行预检", "修复与自测", "质量检查", "独立代码审查",
                    "自动合并与发布", "发布后回归检查", "业务验收", "交付事实核对"])
            chk("界面拿到项目真实环境路径且明确尚未测通",
                before["environmentPath"] == [{
                    "id": "env-demo", "name": "验证环境", "ready": False, "delivery": True}])
            chk("下一步只暴露第一个阻塞项",
                before["nextAction"]["key"] == "source", before["nextAction"])

            blocked = ""
            try:
                await project_setup.apply(session, project, "validation", actor)
            except ValueError as exc:
                blocked = str(exc)
            chk("没有明确负责人时拒绝自动配置", "选择一位有效负责人" in blocked, blocked)
            project.owner_user_id = actor.id
            await session.commit()
            development_profile = await project_setup.apply(
                session, project, "development", actor)
            development = await project_setup.preflight(
                session, project, {"client-demo"}, "development")
            chk("纯研发闭环不要求配置发布环境也能就绪",
                development_profile.mode == "development" and development["ready"]
                and development["environmentPath"] == [],
                development["checks"])
            chk("纯研发闭环只保留自动节点，不制造人工合并审批",
                development["approvalPlan"] == []
                and development["journey"][-1]["label"] == "仓库回执"
                and development["modes"][0]["destination"] == "代码合并到项目目标分支",
                {"approval": development["approvalPlan"],
                 "journey": development["journey"]})
            profile = await project_setup.apply(session, project, "validation", actor, {
                "executionClientId": client.id, "agentKind": "local:codex"})
            chk("project profile persists the portable Agent default",
                dict(profile.config or {}).get("agentKind") == "local:codex", profile.config)
            after = await project_setup.preflight(
                session, project, {"client-demo"}, "validation")
            chk("一次配置写入项目默认交付方式", profile.mode == "validation")
            chk("配置保留用户明确选择的负责人", project.owner_user_id == actor.id)
            chk("配置完成后全链路就绪", after["ready"], after["checks"])
            chk("就绪后不再制造下一步", after["nextAction"] is None, after["nextAction"])
            chk("就绪结果带回唯一任务归属和工程选择",
                after["launch"]["clientId"] == client.id and
                after["launch"]["defaultRepoId"] == repo.id and
                after["launch"]["methodName"], after["launch"])

            pinned_binding = await session.get(am.PluginBinding, profile.binding_id)
            pinned_version = await session.get(am.PluginVersion, pinned_binding.version_id)
            session.add(am.PluginVersion(
                plugin_id=pinned_version.plugin_id, version="99.0.0",
                checksum="f" * 64, manifest=dict(pinned_version.manifest or {}),
                workflow=dict(pinned_version.workflow or {}),
                capability_report=dict(pinned_version.capability_report or {}),
                provenance=dict(pinned_version.provenance or {}),
                package_path=pinned_version.package_path, trust_state="approved",
                visibility=pinned_version.visibility, enabled=True,
                created_by="smoke"))
            await session.commit()
            pinned = await project_setup.status(
                session, project, {"client-demo"}, "validation")
            method_check = next(x for x in pinned["checks"] if x["key"] == "method")
            chk("项目固定的已审批版本不会因目录出现新版而被误判失效",
                method_check["ok"] and
                pinned["launch"]["methodVersion"] == pinned_version.version,
                {"check": method_check, "launch": pinned["launch"]})

            client.git_creds = {**dict(client.git_creds or {}), "token": "y"}
            await session.commit()
            changed_credentials = await project_setup.status(
                session, project, {"client-demo"}, "validation")
            chk("代码凭据变化后旧仓库预检立即失效",
                not changed_credentials["ready"] and
                changed_credentials["sourceProbes"][repo.id]["stale"] and
                changed_credentials["canPreflight"],
                changed_credentials["sourceProbes"][repo.id])
            await project_setup.preflight(
                session, project, {"client-demo"}, "validation")

            client.git_creds = {"user": "owner", "token": "y"}
            await session.commit()
            missing_identity = await project_setup.status(
                session, project, {"client-demo"}, "validation")
            chk("缺少提交人身份时项目不能启动或继续预检",
                not missing_identity["ready"] and
                not missing_identity["canPreflight"] and
                not missing_identity["assignment"]["codeAccount"]["identityReady"],
                missing_identity["checks"])
            task_count_before = len(list((await session.execute(
                select(models.Task.id))).scalars().all()))
            blocked_launch = ""
            try:
                await project_setup.launch(
                    session, project, {"client-demo"}, "validation", actor, {
                        "requestId": "22222222-2222-4222-8222-222222222222",
                        "title": "凭据不完整时不得创建假运行任务",
                    })
            except ValueError as exc:
                blocked_launch = str(exc)
            task_count_after = len(list((await session.execute(
                select(models.Task.id))).scalars().all()))
            chk("凭据不完整时启动失败且不创建任务",
                "提交人" in blocked_launch and task_count_after == task_count_before,
                {"error": blocked_launch, "before": task_count_before,
                 "after": task_count_after})
            client.git_creds = {
                "name": "项目负责人",
                "email": "owner@example.com",
                "user": "owner",
                "token": "y",
            }
            await session.commit()
            await project_setup.preflight(
                session, project, {"client-demo"}, "validation")

            spare = models.Client(id="client-spare", name="项目负责人备用电脑",
                                  user_ref=actor.id, auth_state="active")
            outsider = models.User(id="u-other", username="other", display_name="其他同事",
                                   password_hash="x", is_super=False, is_active=True)
            outsider_client = models.Client(id="client-other", name="其他同事电脑",
                                             user_ref=outsider.id, auth_state="active")
            session.add_all([spare, outsider, outsider_client])
            await session.commit()
            fixed = await project_setup.status(
                session, project, {client.id, spare.id}, "validation")
            chk("负责人增加备用电脑后仍固定使用明确配置的设备",
                fixed["assignment"]["clientId"] == client.id and fixed["ready"],
                fixed["assignment"])
            profile.config = {}
            await session.commit()
            ambiguous = await project_setup.status(
                session, project, {client.id, spare.id}, "validation")
            chk("负责人有多台设备且未选择时不按最近在线静默猜测",
                not ambiguous["ready"] and ambiguous["assignment"]["requiresSelection"]
                and not ambiguous["launch"]["clientId"], ambiguous["assignment"])
            cross_error = ""
            try:
                await project_setup.apply(session, project, "validation", actor, {
                    "executionClientId": outsider_client.id, "agentKind": "local:codex"})
            except ValueError as exc:
                cross_error = str(exc)
            chk("项目配置拒绝选择其他人的电脑",
                "不属于项目负责人" in cross_error, cross_error)
            profile = await project_setup.apply(session, project, "validation", actor, {
                "executionClientId": client.id, "agentKind": "local:codex"})
            codex_route = await project_setup.status(
                session, project, {client.id, spare.id}, "validation")
            chk("项目可固定为负责人电脑上的 Codex",
                codex_route["ready"] and codex_route["assignment"]["agentKinds"] ==
                ["local:codex"], codex_route["assignment"])

            old_schedule = workflow_engine._schedule
            async def no_schedule(_session, _run):
                return None
            workflow_engine._schedule = no_schedule
            try:
                started = await project_setup.launch(
                    session, project, {client.id}, "validation", actor, {
                        "requestId": "11111111-1111-4111-8111-111111111111",
                        "title": "修复论坛分享入口",
                        "note": "分享经验按钮无法点击",
                    })
                repeated = await project_setup.launch(
                    session, project, {client.id}, "validation", actor, {
                        "requestId": "11111111-1111-4111-8111-111111111111",
                        "title": "网络重试不应重复创建",
                    })
            finally:
                workflow_engine._schedule = old_schedule
            launched_task = await session.get(models.Task, started["task"]["id"])
            launched_runs = list((await session.execute(select(am.WorkflowRun).where(
                am.WorkflowRun.task_id == launched_task.id))).scalars().all())
            chk("一次动作创建任务并立即进入工作流",
                launched_task.status == "doing" and launched_task.project_id == project.id and
                launched_task.repo_id == repo.id and len(launched_runs) == 1,
                {"task": started["task"], "runs": len(launched_runs)})
            readiness = dict(launched_runs[0].context or {}).get("deliveryReadiness") or {}
            readiness_text = json.dumps(readiness, ensure_ascii=False).lower()
            chk("受管项目启动时把全绿预检作为脱敏事实固定到工作流",
                readiness.get("ready") is True
                and len(readiness.get("checks") or []) == 5
                and all(item.get("ok") for item in readiness.get("checks") or [])
                and bool(readiness.get("sourceProbes"))
                and bool(readiness.get("environmentPath")), readiness)
            chk("工作流预检事实不包含代码或发布凭据",
                all(word not in readiness_text for word in (
                    "password", "token", "secret", "privatekey", "private_key")),
                readiness_text)
            readiness_prompt = managed_delivery_context.prompt(readiness)
            chk("AI 节点收到受控边界说明而不是被要求在工作区寻找发布凭据",
                "SODUWORK MANAGED DELIVERY PREFLIGHT — READY" in readiness_prompt
                and "do not treat their absence" in readiness_prompt
                and "codeAccount" not in readiness_prompt,
                readiness_prompt)
            chk("启动任务同时固定负责人和其明确选择的设备",
                launched_task.assignee_user_id == actor.id and
                launched_task.owner_client_id == client.id,
                {"assignee": launched_task.assignee_user_id, "client": launched_task.owner_client_id})
            chk("启动请求可安全重试且不重复建任务",
                repeated["reused"] and repeated["task"]["id"] == launched_task.id and
                repeated["run"]["id"] == started["run"]["id"])
            uat_policy = await session.get(
                am.ApprovalPolicy, release_control.POLICY_UAT)
            uat_policy.rules = {**dict(uat_policy.rules or {}), "required": 2}
            await session.commit()
            short_staffed = await project_setup.status(
                session, project, {"client-demo"}, "validation")
            review_check = next(
                item for item in short_staffed["checks"] if item["key"] == "review")
            chk("会签人数超过真实可分配人员时在启动前阻断",
                not review_check["ok"] and "需要 2 人" in review_check["detail"],
                short_staffed["approvalPlan"])
            uat_policy.rules = {**dict(uat_policy.rules or {}), "required": 1}
            await session.commit()
            target.config = {**dict(target.config or {}), "argv": ["deploy-demo-v2"]}
            await session.commit()
            stale = await project_setup.status(
                session, project, {"client-demo"}, "validation")
            stale_chain = await environment_service.preflight_chain(
                session, repo, {"client-demo"})
            chk("部署配置变化后旧探测证据自动失效",
                not stale["ready"] and any(
                    item.get("code") == "target-probe-stale"
                    for item in stale_chain.get("blockers") or []), stale["checks"])

            task = models.Task(id="t-demo", title="修复问题", project_id=project.id,
                               repo_id=repo.id, status="todo")
            session.add(task)
            await session.commit()
            binding = await plugin_service.resolve_binding(session, task)
            chk("任务不传 binding id 也会使用项目默认方法", binding.id == profile.binding_id)
            available = await plugin_service.available_bindings(session, task)
            chk("客户端方法列表把默认方法排在首位",
                bool(available) and available[0]["bindingId"] == binding.id and
                available[0]["isDefault"])

            prototype = (await session.execute(select(am.Plugin).where(
                am.Plugin.key == "product-prototype"))).scalar_one()
            versions = list((await session.execute(select(am.PluginVersion).where(
                am.PluginVersion.plugin_id == prototype.id))).scalars().all())
            latest = max(versions, key=lambda x: project_setup._version_key(x.version))
            nodes = {x["key"]: x for x in latest.workflow["nodes"]}
            chk("智能体产品设计声明需求与产品契约",
                {x["path"] for x in nodes["define"]["outputs"]}
                == {"requirements.md", "agent-design.md"})
            chk("智能体产品设计声明原型文件契约",
                nodes["prototype"]["outputs"][0]["path"] == "prototype.html")
            chk("智能体产品设计使用高能力 Codex 并独立审查",
                all(nodes[key]["config"].get("agentKind") == "local:codex"
                    and nodes[key]["config"].get("model") == "gpt-5.6-sol"
                    for key in ("define", "prototype", "experience-review"))
                and nodes["experience-review"]["type"] == "ai_review")
        finally:
            runner_hub.api_list, runner_hub.pick_by_tags = old_api, old_pick
            runner_hub.pick_for, runner_hub.call_sync, runner_hub.get = old_pick_for, old_call, old_get
            runner_hub.for_client = old_for_client
            runner_hub.online = old_online
            runner_hub.dispatchable = old_dispatchable
    await engine.dispose()


asyncio.run(main())
print(f"\nproject setup smoke: {ok} passed, {fail} failed")
try:
    os.remove(DB)
except FileNotFoundError:
    pass
raise SystemExit(1 if fail else 0)
