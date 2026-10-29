# -*- coding: utf-8 -*-
"""AI code-review attestation smoke test; isolated DB and stored report are always removed."""
import asyncio
import json
import os
import shutil
import sys
from datetime import datetime, timedelta, timezone

DB = os.path.abspath(".smoke-ai-review.db")
DATA = os.path.abspath(".smoke-ai-review-data")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
shutil.rmtree(DATA, ignore_errors=True)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
os.environ["SODUWORK_DATA_ROOT"] = DATA
sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import (plugin_packages, release_control, storage,  # noqa: E402
                          workflow_contracts, workflow_inputs)

ok = fail = 0
lines = []
STORAGE_KEYS = []


def chk(name, condition, extra=""):
    global ok, fail
    if condition:
        ok += 1
        lines.append("  PASS  " + name)
    else:
        fail += 1
        lines.append("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


def package(node):
    return {
        "schemaVersion": 1, "key": "smoke-ai-review", "name": "AI 审查冒烟",
        "version": "1.0.0", "workflow": {"nodes": [node]},
    }


async def main():
    await init_db()
    missing_prompt = False
    try:
        plugin_packages.normalize(package({"key": "review", "type": "ai_review"}))
    except ValueError as exc:
        missing_prompt = "prompt" in str(exc)
    chk("AI 审查节点必须声明审查提示", missing_prompt)
    manifest, workflow, _ = plugin_packages.normalize(package({
        "key": "review", "type": "ai_review",
        "config": {"prompt": "审查固定提交并输出结构化报告"},
    }))
    chk("AI 审查是受支持的独立节点类型",
        manifest["key"] == "smoke-ai-review" and workflow["nodes"][0]["type"] == "ai_review")

    async with SessionLocal() as session:
        await release_control.bootstrap(session)
        user = models.User(id="u-ai-review-smoke", username="ai-review-smoke",
                           display_name="AI 审查冒烟", is_active=True)
        client = models.Client(id="c-ai-review-smoke", name="AI 审查执行机",
                               user_ref=user.id)
        task = models.Task(id="t-ai-review-smoke", title="验证 AI 审查自动合并",
                           owner_client_id=client.id, requester_user_id=user.id)
        plugin = am.Plugin(id="p-ai-review-smoke", key="smoke-ai-review-runtime",
                           name="AI 审查运行插件", enabled=True)
        version = am.PluginVersion(
            id="v-ai-review-smoke", plugin_id=plugin.id, version="1.0.0",
            checksum="review-version", manifest={}, workflow={"nodes": []},
            trust_state="approved", enabled=True)
        binding = am.PluginBinding(
            id="b-ai-review-smoke", plugin_id=plugin.id, version_id=version.id,
            enabled=True)
        run = am.WorkflowRun(
            id="r-ai-review-smoke", task_id=task.id, plugin_id=plugin.id,
            plugin_version_id=version.id, binding_id=binding.id, state="running")
        session.add_all([user, client, task, plugin, version, binding, run])
        await session.flush()
        commit = "a" * 40
        artifact, created = await release_control.ensure_code_candidate(session, task, {
            "branch": "soduwork/task-ai-review", "target": "main",
            "commits": [{"sha": commit, "subject": "finish feature"}],
            "files": [{"name": "app.py"}],
        })
        requests = list((await session.execute(select(am.ApprovalRequest).where(
            am.ApprovalRequest.task_id == task.id))).scalars())
        chk("插件管理的代码候选不会提前制造人工审阅", created and not requests, requests)

        stale_key = "smoke-ai-review/stale.json"
        stale_raw = json.dumps({
            "schemaVersion": 1, "verdict": "pass", "summary": "旧报告",
            "findings": [], "checks": []}, ensure_ascii=False).encode()
        STORAGE_KEYS.append((stale_key, storage.put(stale_key, stale_raw, "application/json")))
        session.add(models.Attachment(
            id="a-ai-review-stale", task_id=task.id, filename="code-review.json",
            size=len(stale_raw), storage_key=stale_key, backend=STORAGE_KEYS[-1][1],
            created_at=datetime.now(timezone.utc) - timedelta(hours=1)))
        await session.flush()
        try:
            await workflow_inputs.code_review_report(
                session, task.id, datetime.now(timezone.utc) - timedelta(minutes=1))
            current_only = False
        except workflow_contracts.WorkflowContractError:
            current_only = True
        chk("AI 审查不会误用上一轮同名报告", current_only)

        report_key = "smoke-ai-review/current.json"
        report_raw = json.dumps({
            "schemaVersion": 1, "verdict": "pass", "summary": "未发现阻断合并的问题",
            "findings": [{"severity": "minor", "file": "app.py", "line": 8,
                          "message": "可补充注释", "suggestion": "后续维护时完善"}],
            "checks": ["需求覆盖", "权限边界", "测试证据"],
        }, ensure_ascii=False).encode()
        STORAGE_KEYS.append((report_key, storage.put(report_key, report_raw, "application/json")))
        started_at = datetime.now(timezone.utc) - timedelta(seconds=2)
        attachment = models.Attachment(
            id="a-ai-review-current", task_id=task.id, filename="code-review.json",
            size=len(report_raw), storage_key=report_key, backend=STORAGE_KEYS[-1][1],
            created_at=datetime.now(timezone.utc))
        session.add(attachment)
        await session.flush()
        report = await workflow_inputs.code_review_report(session, task.id, started_at)
        attestation = await release_control.record_ai_review(
            session, task, artifact, report,
            source={"runId": run.id, "nodeId": "review-node"})
        await session.flush()
        authorized_artifact, authorized = await release_control.merge_authorization(
            session, task.id)
        chk("结构化 AI 审查凭证绑定固定提交并自动放行合并",
            authorized and authorized_artifact.id == artifact.id
            and attestation["commit"] == commit
            and artifact.state == "reviewed"
            and task.reviewed_by_name == "SoduWork AI Code Review", attestation)
        artifact.commit_sha = "b" * 40
        _, tampered = await release_control.merge_authorization(session, task.id)
        chk("固定提交变化后 AI 审查凭证立即失效", not tampered)

        invalid_key = "smoke-ai-review/inconsistent.json"
        invalid_raw = json.dumps({
            "schemaVersion": 1, "verdict": "pass", "summary": "错误地声称通过",
            "findings": [{"severity": "major", "file": "app.py", "line": 12,
                          "message": "存在阻断问题"}], "checks": [],
        }, ensure_ascii=False).encode()
        STORAGE_KEYS.append((invalid_key, storage.put(
            invalid_key, invalid_raw, "application/json")))
        invalid_started = datetime.now(timezone.utc)
        session.add(models.Attachment(
            id="a-ai-review-invalid", task_id=task.id, filename="code-review.json",
            size=len(invalid_raw), storage_key=invalid_key, backend=STORAGE_KEYS[-1][1],
            created_at=invalid_started + timedelta(seconds=1)))
        await session.flush()
        inconsistent_rejected = False
        try:
            await workflow_inputs.code_review_report(session, task.id, invalid_started)
        except workflow_contracts.WorkflowContractError:
            inconsistent_rejected = True
        chk("报告不能一边保留重大问题一边放行合并", inconsistent_rejected)


async def run():
    try:
        await main()
    finally:
        await engine.dispose()


try:
    asyncio.run(run())
finally:
    for key, backend in STORAGE_KEYS:
        storage.delete(key, backend)
    for suffix in ("", "-shm", "-wal"):
        try:
            os.remove(DB + suffix)
        except FileNotFoundError:
            pass
    shutil.rmtree(DATA, ignore_errors=True)

print("\n".join(lines))
print("\nAI review smoke: %d passed, %d failed" % (ok, fail))
raise SystemExit(1 if fail else 0)
