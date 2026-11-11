# -*- coding: utf-8 -*-
"""Delivery-version tests for bound review, approval gates, explicit merging, and declarative
environments.
"""
import asyncio
import inspect
import os
import sys

DB = os.path.abspath(".smoke-release.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.api import release as release_api, tasks as task_api  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import (ai_remote, code_delivery, deployments, environment_service,  # noqa: E402
                          gate_contract, git_ops, preflight_evidence, rbac, release_control)

ok = fail = 0
lines = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        lines.append("  PASS  " + name)
    else:
        fail += 1
        lines.append("  FAIL  " + name + ("  << " + str(extra)[:240] if extra else ""))


async def main():
    await init_db()
    real_git = git_ops._git
    try:
        def fake_identity_git(_cwd, *args, **_kwargs):
            key = tuple(args)
            if key == ("branch", "--show-current"):
                return 0, "fix/task-alias"
            if key == ("rev-parse", "HEAD"):
                return 0, "a" * 40
            if key == ("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"):
                return 128, "no upstream"
            if key[0] == "for-each-ref":
                return 0, "origin/feat/existing\t%s\norigin/develop\t%s" % ("a" * 40, "b" * 40)
            return 1, "unexpected"

        git_ops._git = fake_identity_git
        identity = git_ops.worktree_identity(".")
        chk("验证任务能把本地别名还原成同提交的远端分支",
            identity.get("branch") == "fix/task-alias"
            and identity.get("remoteBranch") == "feat/existing"
            and identity.get("head") == "a" * 40, identity)

        def fake_detached_default_git(_cwd, *args, **_kwargs):
            key = tuple(args)
            if key == ("branch", "--show-current"):
                return 0, ""
            if key == ("rev-parse", "HEAD"):
                return 0, "c" * 40
            if key == ("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"):
                return 128, "no upstream"
            if key[0] == "for-each-ref":
                return 0, "origin\t%s\norigin/main\t%s" % ("c" * 40, "c" * 40)
            return 1, "unexpected"

        git_ops._git = fake_detached_default_git
        identity = git_ops.worktree_identity(".")
        chk("detached worktree ignores the remote namespace pseudo-ref",
            identity.get("branch") == ""
            and identity.get("remoteBranch") == "main"
            and identity.get("head") == "c" * 40, identity)
    finally:
        git_ops._git = real_git
    async with SessionLocal() as s:
        legacy_system = models.Role(
            id="role-release-system", name="系统管理员", is_system=True,
            permissions=["task.view"])
        legacy_department = models.Role(
            id="role-release-department", name="部门管理员", is_system=True,
            permissions=["task.dispatch"])
        s.add_all([legacy_system, legacy_department])
        await s.commit()
        await rbac.upgrade_builtin_role_permissions(s)
        chk("旧版系统管理员角色升级后补齐新增权限",
            "release.approve" in legacy_system.permissions
            and "environment.manage" in legacy_system.permissions
            and "release.approve" not in legacy_department.permissions)
        legacy_department.permissions = ["task.dispatch"]
        await s.commit()
        await rbac.upgrade_builtin_role_permissions(s)
        chk("内置角色权限迁移只执行一次，不覆盖企业后续调整",
            legacy_department.permissions == ["task.dispatch"])
        await release_control.bootstrap(s)
        envs = list((await s.execute(select(am.Environment).order_by(am.Environment.sort))).scalars())
        chk("平台不把测试和生产环境强塞给所有企业", envs == [], [x.key for x in envs])
        test_env = am.Environment(
            id=release_control.ENV_TEST, key="verify", name="甲公司验证环境", tier="verification",
            sort=10, promotion_policy={"autoStart": True, "requires": [],
                                       "requiresApproval": False, "marksDelivery": False})
        prod_env = am.Environment(
            id=release_control.ENV_PRODUCTION, key="customer-live", name="客户交付环境",
            tier="customer-production", sort=20,
            approval_policy_id=release_control.POLICY_PRODUCTION,
            acceptance_policy_id=release_control.POLICY_UAT,
            promotion_policy={"autoStart": True, "requires": ["verify"],
                              "requiresApproval": True, "requiresAcceptance": True,
                              "marksDelivery": True})
        s.add_all([test_env, prod_env])
        await s.commit()
        chk("环境分类、前置关系和交付边界均来自配置",
            prod_env.tier == "customer-production"
            and prod_env.promotion_policy["requires"] == ["verify"]
            and prod_env.promotion_policy["marksDelivery"])

        root_a = models.OrgUnit(id="org-release-a", name="甲公司")
        child_a = models.OrgUnit(id="org-release-a-dev", name="甲公司研发部",
                                 parent_id=root_a.id)
        root_b = models.OrgUnit(id="org-release-b", name="乙公司")
        creator = models.User(id="u-release-creator", username="release-creator",
                              display_name="需求负责人", is_active=True, org_id=child_a.id)
        reviewer = models.User(id="u-release-reviewer", username="release-reviewer",
                               display_name="发布审批人", is_active=True, org_id=root_a.id,
                               role_id="role-release-approver")
        stranger = models.User(id="u-release-stranger", username="release-stranger",
                               display_name="无关人员", is_active=True)
        colleague = models.User(id="u-release-colleague", username="release-colleague",
                                display_name="同公司同事", is_active=True, org_id=root_a.id)
        outsider = models.User(id="u-release-outsider", username="release-outsider",
                               display_name="别家公司", is_active=True, org_id=root_b.id,
                               role_id="role-release-approver")
        release_role = models.Role(id="role-release-approver", name="发布审批人",
                                   permissions=["release.approve"])
        reviewer._perms = {"release.approve"}
        creator._perms = set()
        stranger._perms = set()
        box = models.Client(
            id="c-release", user_ref=creator.id, name="审核人的 SoduWork",
            git_creds={"name": "需求负责人", "email": "owner@example.com",
                       "user": "owner", "token": "token-smoke"})
        peer_box = models.Client(id="c-release-peer", user_ref=colleague.id, name="同公司 SoduWork")
        foreign_box = models.Client(id="c-release-foreign", user_ref=outsider.id, name="别家公司 SoduWork")
        s.add_all([root_a, child_a, root_b, release_role, creator, reviewer, stranger,
                   colleague, outsider, box, peer_box, foreign_box])
        task = models.Task(id="t-release-files", owner_client_id=box.id, title="输出原型",
                           created_by=creator.id, created_by_name=creator.display_name)
        s.add(task)
        await s.flush()
        allowed = await environment_service.client_runner_clients(s, box)
        chk("设备只能看到同一家公司组织树内的 Runner",
            box.id in allowed and peer_box.id in allowed and foreign_box.id not in allowed,
            sorted(allowed))
        s.add(models.Attachment(id="att-release-1", task_id=task.id, filename="prototype.html",
                                content_type="text/html", size=321, storage_key="smoke/file",
                                backend="local", uploaded_by="agent:runner", role="output",
                                evidence_meta={"category": "primary",
                                               "verification": {"state": "passed"}}))
        await s.commit()

        a1, made1 = await release_control.ensure_current_output(s, task, who="SoduWork")
        await s.commit()
        a1b, made1b = await release_control.ensure_current_output(s, task, who="SoduWork")
        chk("相同产出重复回流不重复建版本", made1 and not made1b and a1.id == a1b.id)
        chk("附件快照绑定附件 id 而不泄露存储路径",
            a1.manifest["files"][0]["id"] == "att-release-1"
            and "storage" not in str(a1.manifest).lower(), a1.manifest)
        text_task = models.Task(
            id="t-release-text", owner_client_id=box.id, title="回答一个办公问题",
            created_by=creator.id, created_by_name=creator.display_name)
        s.add(text_task)
        await s.flush()
        text_artifact, made_text = await release_control.ensure_current_output(
            s, text_task, source_ref="text-session", text="SODUWORK_DISPATCH_OK", who="SoduWork")
        await s.commit()
        text_request = (await s.execute(select(am.ApprovalRequest).where(
            am.ApprovalRequest.artifact_version_id == text_artifact.id
        ))).scalar_one()
        text_packet = await gate_contract.packet(
            s, text_task, text_request, text_artifact)
        chk("纯文本 AI 成果形成可审阅的固定版本",
            made_text and text_artifact.kind == "text"
            and text_artifact.manifest.get("complete") is True
            and text_artifact.manifest.get("text") == "SODUWORK_DISPATCH_OK",
            text_artifact.manifest)
        chk("人工门禁展示标准文本成果证据",
            any(item.get("kind") == "text"
                and item.get("value") == "SODUWORK_DISPATCH_OK"
                for item in text_packet.get("evidence") or []),
            text_packet.get("evidence"))

        denied = await release_control.decide(
            s, task, stranger, action="review", decision="approve", artifact_version_id=a1.id)
        chk("无关人员不能审阅", denied.get("reason") == "forbidden", denied)
        reviewed = await release_control.decide(
            s, task, creator, action="review", decision="approve", note="达到要求",
            artifact_version_id=a1.id)
        chk("审阅绑定不可变版本并兼容旧审核章",
            reviewed.get("ok") and reviewed["artifact"]["id"] == a1.id
            and task.reviewed_by == creator.id)

        requirement, made_spec = await release_control.ensure_requirement_candidate(s, task, {
            "files": [{"id": "att-requirement", "name": "requirements.md", "size": 800}],
            "acceptanceCriteria": ["用户可以完成核心操作", "错误状态给出明确反馈"],
            "assumptions": ["首版仅服务内部用户"], "risks": ["权限边界需回归"],
        }, who="SoduWork")
        await s.commit()
        chk("需求基线与交付制品使用独立版本流",
            made_spec and (await release_control.latest_requirement(s, task.id)).id == requirement.id
            and (await release_control.latest_artifact(s, task.id)).id == a1.id
            and a1.state == "reviewed")
        baseline = await release_control.decide(
            s, task, creator, action="baseline", decision="approve",
            artifact_version_id=requirement.id)
        chk("需求确认绑定固定版本并保存结构化验收标准",
            baseline.get("ok") and baseline["artifact"]["state"] == "baselined"
            and len(requirement.manifest.get("acceptanceCriteria") or []) == 2, baseline)
        requirement2, _ = await release_control.ensure_requirement_candidate(s, task, {
            "files": [{"id": "att-requirement-v2", "name": "requirements.md", "size": 900}],
            "acceptanceCriteria": ["新的可测试标准"],
        }, who="SoduWork")
        old_requirement = await s.get(am.ArtifactVersion, requirement.id)
        chk("需求出现新版本会撤销旧基线但不污染交付版本",
            requirement2.id != requirement.id and old_requirement.state == "superseded"
            and a1.state == "reviewed")
        no_note = await release_control.decide(
            s, task, creator, action="baseline", decision="reject",
            artifact_version_id=requirement2.id)
        chk("所有审批入口的退回都必须带可执行说明", no_note.get("reason") == "note", no_note)

        project = models.Project(id="p-release", name="发布项目", created_by=creator.id)
        repo = models.Repo(id="r-release", project_id=project.id, name="主仓库",
                           git_url="https://git.example.test/release.git",
                           server_dir="X:/smoke/repo", merge_branch="main")
        code_task = models.Task(id="t-release-code", owner_client_id=box.id, title="修复发布问题",
                                created_by=creator.id, project_id=project.id, repo_id=repo.id,
                                status="doing")
        s.add_all([project, repo, code_task])
        await s.commit()

        separation_task = models.Task(
            id="t-release-separation", owner_client_id=box.id,
            title="职责分离验证", created_by=creator.id,
            assignee_user_id=reviewer.id, project_id=project.id, repo_id=repo.id,
            status="doing")
        s.add(separation_task)
        await s.flush()
        separation_artifact, _ = await release_control.ensure_code_candidate(s, separation_task, {
            "commits": [{"sha": "separate111", "subject": "separation"}],
            "files": ["release.py"], "branch": "feat/separation", "target": "main",
        }, who="SoduWork")
        separation_blocked = ""
        try:
            await release_control.ensure_request(
                s, separation_task, separation_artifact, "deploy",
                release_control.ENV_PRODUCTION)
        except ValueError as exc:
            separation_blocked = str(exc)
        chk("纯人工任务仍在发出审批前排除任务执行负责人",
            "当前只能分配给 0 人" in separation_blocked, separation_blocked)
        s.add(models.TaskEvent(task_id=separation_task.id, kind="ai.dispatched",
                               detail={"provider": "runner", "ref": "smoke"}, actor="SoduWork"))
        await s.flush()
        ai_request = await release_control.ensure_request(
            s, separation_task, separation_artifact, "deploy",
            release_control.ENV_PRODUCTION)
        ai_assignments = list((await s.execute(select(am.ApprovalAssignment).where(
            am.ApprovalAssignment.request_id == ai_request.id
        ))).scalars())
        chk("AI 执行时任务负责人仍可承担人工授权",
            reviewer.id in {x.user_id for x in ai_assignments},
            [(x.user_id, x.sources) for x in ai_assignments])
        separation_artifact.created_by_kind = "user"
        separation_artifact.created_by_id = reviewer.id
        allowed, why = await release_control.can_decide(
            s, separation_task, ai_request, reviewer)
        chk("制品明确由本人制作时仍禁止自审", not allowed and "职责分离" in why, why)
        separation_artifact.created_by_kind = "system"
        separation_artifact.created_by_id = ""

        bad_shell = False
        try:
            await environment_service.save_target(s, {
                "repoId": repo.id, "environmentId": release_control.ENV_TEST,
                "name": "错误目标", "provider": "runner-command",
                "config": {"argv": "deploy.sh --force"},
            })
        except ValueError:
            bad_shell = True
        chk("部署命令拒绝整段 shell 字符串，只收参数数组", bad_shell)
        bad_secret = False
        try:
            await environment_service.save_target(s, {
                "repoId": repo.id, "environmentId": release_control.ENV_TEST,
                "name": "泄密目标", "provider": "runner-command",
                "config": {"argv": ["deploy"], "apiToken": "plaintext"},
            })
        except ValueError:
            bad_secret = True
        chk("部署配置拒绝疑似凭据明文", bad_secret)
        secret_ref = am.SecretReference(id="secret-release", name="发布令牌",
                                        provider="runner-env", locator="DEPLOY_TOKEN")
        s.add(secret_ref)
        await s.commit()
        target = await environment_service.save_target(s, {
            "repoId": repo.id, "environmentId": release_control.ENV_TEST,
            "name": "测试集群", "provider": "runner-command",
            "config": {"argv": ["deploy", "--env", "test"], "timeoutSeconds": 120},
            "secretRefs": {"DEPLOY_TOKEN": secret_ref.id},
            "runnerSelector": {"tags": ["TEST", "test"]},
        })
        chk("部署目标只保存密钥引用并规范化执行机标签",
            target.secret_refs == {"DEPLOY_TOKEN": secret_ref.id}
            and target.runner_selector == {"tags": ["test"]}
            and target.config["argv"] == ["deploy", "--env", "test"])
        deploy_probe = am.DeploymentRun(
            id="deploy-spec-probe", task_id=code_task.id,
            artifact_version_id="artifact-probe", environment_id=test_env.id,
            target_id=target.id, commit_sha="abc123")
        spec = await deployments._spec(s, deploy_probe, test_env, target, repo, code_task)
        chk("部署克隆私有仓库时随本次运行使用任务归属人的代码账号",
            spec.get("git", {}).get("token") == "token-smoke"
            and spec.get("git", {}).get("email") == "owner@example.com", spec.get("git"))
        prod_target = await environment_service.save_target(s, {
            "repoId": repo.id, "environmentId": release_control.ENV_PRODUCTION,
            "name": "生产集群", "provider": "runner-command",
            "config": {"argv": ["deploy", "--env", "production"]},
            "healthChecks": [{"type": "http", "name": "生产入口",
                              "url": "https://service.example/health",
                              "expectStatus": 200}],
            "runnerSelector": {"tags": ["production"]},
        })
        for row, environment, refs in (
            (target, test_env, {secret_ref.id: secret_ref}),
            (prod_target, prod_env, {}),
        ):
            await preflight_evidence.record(
                s, subject_kind="deployment_target", subject_id=row.id,
                check_kind="deploy.preflight",
                config_fingerprint=environment_service.target_probe_fingerprint(
                    row, environment, repo, refs),
                ok=True, summary="发布护照冒烟已核对真实执行通路",
                executor_id="runner-release", executor_name="发布 Runner")
        await s.commit()

        head = {"sha": "aaa1111", "subject": "first"}
        merged_calls = []
        old_ensure, old_find, old_commits, old_merge = (
            git_ops.ensure_server_repo, git_ops.find_task_branch,
            git_ops.branch_commits, git_ops.merge_to)
        find_calls = []
        credential_calls = []
        git_ops.ensure_server_repo = lambda *_args, **_kw: (
            credential_calls.append(_args[2] if len(_args) > 2 else {})
            or {"ok": True, "created": False})
        git_ops.find_task_branch = lambda *_: (find_calls.append(True) or "task/t-release-code")
        def fake_commits(*args, **_kw):
            credential_calls.append(args[5] if len(args) > 5 else {})
            return {"ok": True, "commits": [dict(head)], "files": ["app.py"],
                    "head": head["sha"]}
        git_ops.branch_commits = fake_commits
        def fake_merge(*args, **_kw):
            credential_calls.append(args[3] if len(args) > 3 else {})
            merged_calls.append(dict(head))
            return {"ok": True, "commit": "merge999", "output": "ok"}
        git_ops.merge_to = fake_merge
        try:
            found = await code_delivery.check(
                s, code_task, force=True,
                branch_hint="feat/experience-teajing", head_hint="aaa1111")
            v1 = await release_control.latest_artifact(s, code_task.id)
            chk("执行会话上报的语义分支可建立候选版本且不靠任务号猜测",
                found.get("stage") == "committed"
                and found.get("branch") == "feat/experience-teajing"
                and not find_calls and not merged_calls and v1 is not None)
            chk("服务端克隆、刷新与合并统一使用任务归属人的代码账号",
                credential_calls and all(x.get("token") == "token-smoke"
                                         for x in credential_calls), credential_calls)
            mismatched = await code_delivery.check(
                s, code_task, force=True,
                branch_hint="feat/experience-teajing", head_hint="different-head")
            chk("执行会话提交与远端分支不一致时拒绝建立新交付证据",
                mismatched.get("stage") == "none" and "不一致" in mismatched.get("error", ""),
                mismatched)
            blocked = await code_delivery.merge_approved(s, code_task, who="发布审批人")
            chk("没有审阅和合并审批时绝不写 Git",
                not blocked.get("ok") and not merged_calls, blocked)

            await release_control.decide(s, code_task, creator, action="review",
                                         decision="approve", artifact_version_id=v1.id)
            merge_request = (await s.execute(select(am.ApprovalRequest).where(
                am.ApprovalRequest.artifact_version_id == v1.id,
                am.ApprovalRequest.action == "merge"
            ))).scalar_one()
            merge_assignments = list((await s.execute(select(am.ApprovalAssignment).where(
                am.ApprovalAssignment.request_id == merge_request.id
            ))).scalars())
            assignment_ids = {x.user_id for x in merge_assignments}
            chk("合并审批固化项目负责人和职责角色，并排除组织范围外人员",
                {creator.id, reviewer.id}.issubset(assignment_ids)
                and outsider.id not in assignment_ids,
                [(x.user_id, x.sources) for x in merge_assignments])
            await release_control.decide(s, code_task, reviewer, action="merge",
                                         decision="approve", artifact_version_id=v1.id)
            _, allowed_v1 = await release_control.merge_authorization(s, code_task.id)
            chk("审阅后才产生并可批准合并授权", allowed_v1)

            head.update(sha="bbb2222", subject="second")
            await code_delivery.check(s, code_task, force=True)
            v2 = await release_control.latest_artifact(s, code_task.id)
            _, old_still_allowed = await release_control.merge_authorization(s, code_task.id)
            old = await s.get(am.ArtifactVersion, v1.id)
            chk("新提交产生新版本并使旧授权失效",
                v2.id != v1.id and v2.seq == v1.seq + 1
                and old.state == "superseded" and not old_still_allowed,
                (release_control.artifact_api(old), release_control.artifact_api(v2)))

            await release_control.decide(s, code_task, creator, action="review",
                                         decision="approve", artifact_version_id=v2.id)
            await release_control.decide(s, code_task, reviewer, action="merge",
                                         decision="approve", artifact_version_id=v2.id)
            shipped = await code_delivery.merge_approved(s, code_task, who="发布审批人")
            chk("明确审批后显式合并；有环境目标时不会提前办结任务",
                shipped.get("ok") and len(merged_calls) == 1 and code_task.status == "doing"
                and (shipped.get("deployment") or {}).get("runs"), shipped)
            deploy_run = (await s.execute(select(am.DeploymentRun).where(
                am.DeploymentRun.task_id == code_task.id))).scalars().first()
            deploy_run.state = "succeeded"
            deploy_run.result = {"checks": [{"name": "smoke", "ok": True}]}
            await s.commit()
            await deployments._after_terminal(s, deploy_run)
            current = await release_control.latest_artifact(s, code_task.id)
            release_view = await release_control.view(s, code_task.id)
            prod_req = next((x for x in release_view["approvals"]
                             if x["action"] == "deploy"), None)
            chk("任意前置环境成功后按配置自动申请下一环境审批，但不提前办结",
                code_task.status == "doing" and current.state == "merged"
                and prod_req and prod_req["status"] == "pending", release_view)
            await release_control.decide(
                s, code_task, reviewer, action="deploy", decision="approve",
                artifact_version_id=current.id, environment_id=release_control.ENV_PRODUCTION)
            prod_out = await deployments.request_environment(
                s, code_task, release_control.ENV_PRODUCTION, "发布审批人")
            prod_run = (await s.execute(select(am.DeploymentRun).where(
                am.DeploymentRun.task_id == code_task.id,
                am.DeploymentRun.target_id == prod_target.id))).scalars().first()
            chk("受控环境审批通过后才排入 Runner", prod_out.get("ok") and prod_run is not None,
                prod_out)
            if prod_run is not None:
                prod_run.state = "succeeded"
                prod_run.result = {"checks": [{"name": "smoke", "ok": True}]}
                await s.commit()
                await deployments._after_terminal(s, prod_run)
                uat_req = (await s.execute(select(am.ApprovalRequest).where(
                    am.ApprovalRequest.task_id == code_task.id,
                    am.ApprovalRequest.action == "uat",
                    am.ApprovalRequest.environment_id == prod_env.id
                ))).scalar_one_or_none()
                chk("环境运行成功后按配置发起业务验收，不把部署成功冒充交付完成",
                    code_task.status == "doing" and uat_req is not None
                    and uat_req.status == "pending", uat_req)
                s.add(models.Attachment(
                    id="att-uat-proof", task_id=code_task.id, filename="uat.png",
                    content_type="image/png", size=2048, storage_key="uat-proof",
                    role="verification", source_ref=current.source_ref, uploaded_by="creator",
                    evidence_meta={"kind": "screenshot", "gateRequestId": uat_req.id,
                                   "verification": {"state": "passed", "by": "creator"}},
                ))
                await s.commit()
                await release_control.decide(
                    s, code_task, creator, action="uat", decision="approve",
                    artifact_version_id=current.id, environment_id=prod_env.id)
                final_chain = await deployments.continue_after_acceptance(
                    s, code_task, prod_env.id, "需求负责人")
                chk("标记为交付边界的环境通过业务验收后才发布并结算任务",
                    final_chain.get("complete") and code_task.status == "doing"
                    and (await release_control.latest_artifact(s, code_task.id)).state == "released",
                    final_chain)
            again = await code_delivery.merge_approved(s, code_task, who="发布审批人")
            chk("重复执行已合并命令幂等，不会二次碰 Git",
                again.get("already") and len(merged_calls) == 1, again)
            admin_view = await release_api.task_release(code_task.id, creator, s)
            chk("管理端交付详情按需返回工作流与质量证据入口",
                "workflowRuns" in admin_view and "workflow" in admin_view, admin_view)

            gateway_repo = models.Repo(
                id="r-release-gateway", project_id=project.id, name="内网仓库",
                git_url="https://git.example/repo.git", server_dir="X:/unreachable",
                merge_branch="develop")
            gateway_task = models.Task(
                id="t-release-gateway", owner_client_id=box.id, title="Runner 代理合并",
                created_by=creator.id, project_id=project.id, repo_id=gateway_repo.id,
                status="doing")
            s.add_all([gateway_repo, gateway_task])
            await s.commit()
            scm_calls = []
            old_inspect, old_remote_merge = ai_remote.git_inspect_sync, ai_remote.git_merge_sync
            ai_remote.git_inspect_sync = lambda route, payload: (
                scm_calls.append(("inspect", route, payload)) or {
                    "ok": True, "head": "ccc3333",
                    "commits": [{"sha": "ccc3333", "subject": "gateway"}],
                    "files": ["gateway.py"]})
            ai_remote.git_merge_sync = lambda route, payload: (
                scm_calls.append(("merge", route, payload)) or {
                    "ok": True, "commit": "gateway999", "output": "ok"})
            try:
                route = {"provider": "runner", "runnerId": "runner-private", "ref": "job-private"}
                gateway_found = await code_delivery.check(
                    s, gateway_task, force=True, branch_hint="feat/private-network",
                    head_hint="ccc3333", scm_hint=route)
                gateway_artifact = await release_control.latest_artifact(s, gateway_task.id)
                await release_control.decide(
                    s, gateway_task, creator, action="review", decision="approve",
                    artifact_version_id=gateway_artifact.id)
                await release_control.decide(
                    s, gateway_task, reviewer, action="merge", decision="approve",
                    artifact_version_id=gateway_artifact.id)
                gateway_merged = await code_delivery.merge_approved(
                    s, gateway_task, who="发布审批人")
                chk("Hub 无法直连代码平台时由原 Runner 的干净镜像检查并合并",
                    gateway_found.get("scm") == route and gateway_merged.get("ok")
                    and [x[0] for x in scm_calls] == ["inspect", "inspect", "merge"],
                    (gateway_found, gateway_merged, scm_calls))
                chk("Runner 代理 Git 同样只接收任务归属人的代码账号",
                    all(x[2].get("git", {}).get("token") == "token-smoke"
                        for x in scm_calls), scm_calls)
            finally:
                ai_remote.git_inspect_sync, ai_remote.git_merge_sync = (
                    old_inspect, old_remote_merge)

            existing_task = models.Task(
                id="t-release-existing", owner_client_id=box.id,
                title="验证已存在的代码版本", created_by=creator.id,
                project_id=project.id, repo_id=gateway_repo.id, status="doing")
            s.add(existing_task)
            await s.commit()
            previous_commits = git_ops.branch_commits
            git_ops.branch_commits = lambda *_args, **_kw: {
                "ok": True, "head": "ddd4444", "commits": [], "files": [], "merged": True}
            try:
                existing = await code_delivery.check(
                    s, existing_task, force=True,
                    branch_hint="feat/already-there", head_hint="ddd4444")
                existing_artifact = await release_control.latest_artifact(s, existing_task.id)
                persisted = await code_delivery.read_state(s, existing_task.id)
                chk("目标分支已有同一提交时仍固定候选版本并持久化交付事实",
                    existing.get("stage") == "merged" and existing.get("alreadyMerged")
                    and existing_artifact is not None
                    and existing_artifact.commit_sha == "ddd4444"
                    and persisted.get("stage") == "merged", (existing, persisted))
                reviewed_existing = await release_control.decide(
                    s, existing_task, creator, action="review", decision="approve",
                    artifact_version_id=existing_artifact.id)
                merge_request = (await s.execute(select(am.ApprovalRequest).where(
                    am.ApprovalRequest.artifact_version_id == existing_artifact.id,
                    am.ApprovalRequest.action == "merge"))).scalar_one_or_none()
                await s.refresh(existing_task)
                chk("审阅已合并版本后直接继续交付，不再申请无意义的合并授权",
                    reviewed_existing.get("ok") and merge_request is None
                    and existing_task.status == "doing"
                    and not dict(reviewed_existing.get("delivery") or {}).get("delivered"),
                    reviewed_existing)
            finally:
                git_ops.branch_commits = previous_commits

            workflow_plugin = am.Plugin(
                id="p-release-active", key="release-active", name="活动流程", enabled=True)
            workflow_version = am.PluginVersion(
                id="pv-release-active", plugin_id=workflow_plugin.id, version="1.0.0",
                checksum="release-active", trust_state="approved", enabled=True,
                workflow={"nodes": []})
            workflow_run = am.WorkflowRun(
                id="run-release-active", task_id=gateway_task.id,
                plugin_id=workflow_plugin.id, plugin_version_id=workflow_version.id,
                state="running")
            s.add_all([workflow_plugin, workflow_version, workflow_run])
            await s.commit()
            chk("活动插件流程会接管候选发现与审批时机",
                await code_delivery.managed_by_active_workflow(s, gateway_task.id))
            workflow_run.state = "succeeded"
            await s.commit()
            chk("插件结束后普通代码交付兼容链恢复",
                not await code_delivery.managed_by_active_workflow(s, gateway_task.id))
        finally:
            (git_ops.ensure_server_repo, git_ops.find_task_branch,
             git_ops.branch_commits, git_ops.merge_to) = (
                old_ensure, old_find, old_commits, old_merge)

        sweep_src = inspect.getsource(code_delivery.sweep)
        chk("后台巡检只发现候选，不调用合并命令",
            "merge_approved" not in sweep_src and "merge_to" not in sweep_src)
        chk("★★后台巡检跳过由活动插件掌控的任务",
            "managed_by_active_workflow" in sweep_src, sweep_src)
        status_src = inspect.getsource(task_api.ai_status_task)
        chk("★★客户端普通状态轮询不会绕过插件质量门提前创建审批",
            "managedByWorkflow" in status_src
            and "not code[\"managedByWorkflow\"]" in status_src, status_src)
        chk("★★直派代码任务用 Runner 回传的远端分支和提交指纹发现交付",
            "gitRemoteBranch" in status_src and "branch_hint=" in status_src
            and "head_hint=" in status_src and "scm_hint=" in status_src,
            status_src)
        chk("background sweep keeps runner remote branch, commit and SCM route",
            "status_sync" in sweep_src and "gitRemoteBranch" in sweep_src
            and "branch_hint=" in sweep_src and "head_hint=" in sweep_src
            and "scm_hint=" in sweep_src, sweep_src)

    await engine.dispose()


async def guarded():
    try:
        await main()
    finally:
        await engine.dispose()


try:
    asyncio.run(guarded())
finally:
    for suffix in ("", "-shm", "-wal"):
        try:
            os.remove(DB + suffix)
        except FileNotFoundError:
            pass

print("\n".join(lines))
print(f"\nrelease smoke: {ok} passed, {fail} failed")
raise SystemExit(1 if fail else 0)
