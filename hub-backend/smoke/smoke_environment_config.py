# -*- coding: utf-8 -*-
"""Test arbitrary environment categories, acyclic progression, policy snapshots, and approval
participant safeguards.
"""
import asyncio
import os
import sys
from pathlib import Path

DB = os.path.abspath(".smoke-environment-config.db")
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
from app.services import (approval_policies, environment_service,
                          preflight_evidence, release_control)  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS ", name)
    else:
        fail += 1
        print("  FAIL ", name, "<<", str(extra)[:240])


async def main():
    await init_db()
    async with SessionLocal() as s:
        await release_control.bootstrap(s)
        org = models.OrgUnit(id="org-env-config", name="示例公司")
        position = models.Position(id="position-release-manager", name="发布经理")
        owner = models.User(id="u-env-owner", username="env-owner", display_name="任务负责人",
                            org_id=org.id, is_active=True)
        manager = models.User(id="u-env-manager", username="env-manager", display_name="发布经理",
                              org_id=org.id, positions=[position.id], is_active=True)
        client = models.Client(id="c-env-owner", name="负责人 SoduWork", user_ref=owner.id)
        project = models.Project(id="p-env-config", name="环境配置项目", org_id=org.id,
                                 owner_user_id=owner.id)
        repo = models.Repo(id="r-env-config", project_id=project.id, name="应用仓库",
                           org_id=org.id, merge_branch="main")
        task = models.Task(id="t-env-config", title="验证任意环境", owner_client_id=client.id,
                           project_id=project.id, repo_id=repo.id,
                           assignee_user_id=owner.id, created_by=owner.id, status="doing")
        s.add_all([org, position, owner, manager, client, project, repo, task])
        await s.commit()

        created = []
        specs = [
            ("developer-lab", "开发联调", "dev", [], False, False),
            ("qa-cluster", "质量验证", "quality", ["developer-lab"], False, False),
            ("customer-preview", "客户预生产", "customer-staging", ["qa-cluster"], True, False),
            ("customer-live", "客户生产", "customer-production", ["customer-preview"], True, True),
            ("audit-mirror", "监管镜像", "regulated", ["customer-live"], False, True),
        ]
        for index, (key, name, category, requires, guarded, boundary) in enumerate(specs):
            created.append(await environment_service.save_environment(s, {
                "orgId": org.id, "key": key, "name": name, "tier": category, "sort": index,
                "promotionPolicy": {"autoStart": True, "requires": requires,
                                    "requiresApproval": guarded, "marksDelivery": boundary},
            }))
        chk("企业可配置任意数量和分类的环境",
            len(created) == 5 and created[2].tier == "customer-staging")
        chk("任意长度的前置链按稳定 key 保存",
            created[-1].promotion_policy["requires"] == ["customer-live"])

        targets = []
        for index, environment in enumerate(created):
            config = {"argv": ["deploy", environment.key]}
            if index == 0:
                config["clientReleaseUpload"] = {
                    "enabled": True, "baseUrl": "http://192.0.2.10:8989/",
                }
            targets.append(await environment_service.save_target(s, {
                "repoId": repo.id, "environmentId": environment.id,
                "name": f"目标 {index + 1}", "provider": "runner-command",
                "config": config,
            }))
        chk("client release upload config survives target normalization",
            targets[0].config.get("clientReleaseUpload") == {
                "enabled": True, "baseUrl": "http://192.0.2.10:8989"})
        unsafe_upload_blocked = False
        try:
            environment_service._target_config({
                "argv": ["deploy"],
                "clientReleaseUpload": {"baseUrl": "https://user:pass@example.com"},
            })
        except ValueError:
            unsafe_upload_blocked = True
        chk("client release upload URL rejects embedded credentials", unsafe_upload_blocked)
        unprobed = await environment_service.preflight_chain(
            s, repo, allowed_clients=set(), require_online=False)
        chk("没有真实探测证据时不能把发布链误报为就绪",
            not unprobed["ok"] and any(
                x["code"] == "target-unprobed" for x in unprobed["blockers"]),
            unprobed)
        for target, environment in zip(targets, created):
            await preflight_evidence.record(
                s, subject_kind="deployment_target", subject_id=target.id,
                check_kind="deploy.preflight",
                config_fingerprint=environment_service.target_probe_fingerprint(
                    target, environment, repo, {}),
                ok=True, summary="冒烟中的真实执行通路已验证",
                executor_id="runner-smoke", executor_name="冒烟 Runner")
        await s.commit()
        delivery_blocked = await environment_service.preflight_chain(
            s, repo, allowed_clients=set(), require_online=False)
        chk("交付终点没有健康检查时必须阻断",
            not delivery_blocked["ok"] and any(
                x["code"] == "delivery-health-check" for x in delivery_blocked["blockers"]),
            delivery_blocked)

        created[0] = await environment_service.save_environment(s, {
            "rollback": {"mode": "automatic"},
        }, created[0])
        inherited = environment_service.effective_rollback(created[0], targets[0])
        chk("环境可以声明自动回滚且不会被目标默认手动策略降级",
            inherited.get("mode") == "automatic" and not inherited.get("argv"), inherited)
        rollback_policy_blocked = await environment_service.preflight_chain(
            s, repo, allowed_clients=set(), require_online=False)
        chk("自动回滚策略缺少目标执行命令时必须阻断",
            not rollback_policy_blocked["ok"] and any(
                x["code"] == "rollback-command" for x in rollback_policy_blocked["blockers"]),
            rollback_policy_blocked)

        for target, environment in zip(targets, created):
            changed = False
            if environment.id == created[0].id:
                target.rollback = environment_service._rollback({
                    "mode": "automatic", "argv": [sys.executable, "-c", "pass"]})
                changed = True
            if environment_service.promotion_policy(environment.promotion_policy).get("marksDelivery"):
                target.health_checks = environment_service._checks([{
                    "type": "command", "name": "交付版本可用",
                    "argv": [sys.executable, "-c", "pass"],
                }])
                changed = True
            if changed:
                await preflight_evidence.record(
                    s, subject_kind="deployment_target", subject_id=target.id,
                    check_kind="deploy.preflight",
                    config_fingerprint=environment_service.target_probe_fingerprint(
                        target, environment, repo, {}),
                    ok=True, summary="策略变更后已重新探测",
                    executor_id="runner-smoke", executor_name="冒烟 Runner")
        await s.commit()
        ready = await environment_service.preflight_chain(
            s, repo, allowed_clients=set(), require_online=False)
        chk("整条环境链有真实证据后才允许启动任务",
            ready["ok"] and len(ready["stages"]) == 5
            and any(x["marksDelivery"] for x in ready["stages"]), ready)
        original_policies = [dict(row.promotion_policy or {}) for row in created]
        for row in created:
            row.promotion_policy = {**dict(row.promotion_policy or {}), "marksDelivery": False}
        await s.commit()
        no_boundary = await environment_service.preflight_chain(
            s, repo, allowed_clients=set(), require_online=False)
        chk("没有交付边界时预检明确阻止流程启动",
            not no_boundary["ok"] and any(
                x["code"] == "no-delivery-boundary" for x in no_boundary["blockers"]),
            no_boundary)
        for row, policy_snapshot in zip(created, original_policies):
            row.promotion_policy = policy_snapshot
        await s.commit()
        rollback_blocked = False
        try:
            environment_service._rollback({"mode": "automatic"})
        except ValueError as exc:
            rollback_blocked = "回滚命令" in str(exc)
        chk("自动回滚没有可执行命令时拒绝保存", rollback_blocked)

        cycle_blocked = False
        try:
            await environment_service.save_environment(s, {
                "promotionPolicy": {"autoStart": True, "requires": ["audit-mirror"],
                                    "marksDelivery": False}}, created[0])
        except ValueError as exc:
            cycle_blocked = "循环" in str(exc)
            await s.rollback()
            for row in created:
                await s.refresh(row)
            for row in (org, position, owner, manager, client, project, repo, task):
                await s.refresh(row)
        chk("环境推进关系出现循环时当场阻止保存", cycle_blocked)

        policy = await approval_policies.save(s, {
            "orgId": org.id, "key": "customer-release-duty", "name": "客户环境发布职责",
            "description": "任务负责人和发布经理共同确认",
            "rules": {"actions": ["deploy"], "required": 2,
                      "separationOfDuties": False, "approvers": [
                          {"type": "task_assignee", "label": "任务负责人"},
                          {"type": "position", "ids": [position.id], "label": "发布经理"},
                      ]},
        })
        created[2].approval_policy_id = policy.id
        created[2].promotion_policy = {**created[2].promotion_policy, "requiresApproval": True}
        await s.commit()
        artifact, _ = await release_control.ensure_code_candidate(s, task, {
            "commits": [{"sha": "env123", "subject": "environment"}],
            "files": ["deploy.yml"], "branch": "feat/env", "target": "main",
        }, who="SoduWork")
        artifact.state = "merged"
        await s.commit()
        request = await release_control.ensure_request(
            s, task, artifact, "deploy", created[2].id,
            {"approvalPolicyId": policy.id, "summary": "发布到客户预生产"})
        assignments = list((await s.execute(select(am.ApprovalAssignment).where(
            am.ApprovalAssignment.request_id == request.id))).scalars())
        chk("环境绑定的审批职责生成明确人员快照",
            {x.user_id for x in assignments} == {owner.id, manager.id}
            and request.required_count == 2,
            [(x.user_id, x.sources) for x in assignments])
        manager.positions = []
        await s.commit()
        unchanged = list((await s.execute(select(am.ApprovalAssignment).where(
            am.ApprovalAssignment.request_id == request.id))).scalars())
        chk("审批发出后组织变化不改写历史分配", len(unchanged) == 2)

        source = Path("app/services/deployments.py").read_text(encoding="utf-8")
        chk("运行时不再按测试/生产分类分支",
            'env.tier == "test"' not in source and 'env.tier == "production"' not in source
            and 'env.tier != "test"' not in source)

    await engine.dispose()
    for suffix in ("", "-shm", "-wal"):
        try:
            os.remove(DB + suffix)
        except FileNotFoundError:
            pass
    print(f"\nenvironment config smoke: {ok} passed, {fail} failed")
    raise SystemExit(1 if fail else 0)


asyncio.run(main())
