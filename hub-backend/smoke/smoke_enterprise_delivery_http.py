# -*- coding: utf-8 -*-
"""Real HTTP enterprise-release boundary tests with isolated processes, database, and files."""
import asyncio
import base64
import contextlib
import os
import pathlib
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

import httpx

sys.path.insert(0, ".")

BASE = ""
DATA_ROOT = ""
UID = "u-smoke-delivery-http"
CID = "c-smoke-delivery-http"
TID = "t-smoke-delivery-http"
ENV_ID = "env-smoke-delivery-http"
TARGET_ID = "target-smoke-delivery-http"
ARTIFACT_ID = "artifact-smoke-delivery-http"
RUN_ID = "deploy-smoke-delivery-http"
SECRET = secrets.token_urlsafe(32)
TOKEN = ""
ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:500] if extra else ""))


def headers():
    return {"Authorization": "Device " + TOKEN}


@contextlib.contextmanager
def isolated_hub():
    global BASE, DATA_ROOT
    keys = (
        "DATABASE_URL", "DB_MIGRATION_MODE", "ADMIN_USER", "ADMIN_PASS",
        "AUTH_SECRET", "SODUWORK_DATA_ROOT", "REPORT_AUTO",
        "POLL_INTERVAL_SECONDS", "MINIO_ENDPOINT", "MINIO_ACCESS_KEY",
        "MINIO_SECRET_KEY",
    )
    previous = {key: os.environ.get(key) for key in keys}
    with tempfile.TemporaryDirectory(prefix="soduwork-smoke-delivery-http-") as folder:
        root = pathlib.Path(folder).resolve()
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            port = int(probe.getsockname()[1])
        BASE = f"http://127.0.0.1:{port}"
        DATA_ROOT = str(root)
        os.environ.update({
            "DATABASE_URL": "sqlite+aiosqlite:///" + (root / "hub.db").as_posix(),
            "DB_MIGRATION_MODE": "auto",
            "ADMIN_USER": "smoke-delivery-admin",
            "ADMIN_PASS": secrets.token_urlsafe(24),
            "AUTH_SECRET": secrets.token_urlsafe(36),
            "SODUWORK_DATA_ROOT": str(root / "data"),
            "REPORT_AUTO": "false",
            "POLL_INTERVAL_SECONDS": "0",
            "MINIO_ENDPOINT": "",
            "MINIO_ACCESS_KEY": "",
            "MINIO_SECRET_KEY": "",
        })
        log_path = root / "hub.log"
        with log_path.open("w+b") as log_file:
            proc = subprocess.Popen([
                sys.executable, "-m", "uvicorn", "app.main:app",
                "--host", "127.0.0.1", "--port", str(port),
            ], cwd=pathlib.Path(__file__).resolve().parent.parent,
                env=os.environ.copy(), stdin=subprocess.DEVNULL,
                stdout=log_file, stderr=subprocess.STDOUT)
            try:
                ready = False
                deadline = time.time() + 45
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                while time.time() < deadline and proc.poll() is None:
                    try:
                        with opener.open(BASE + "/healthz", timeout=2) as response:
                            ready = response.status == 200
                    except (OSError, urllib.error.URLError):
                        ready = False
                    if ready:
                        break
                    time.sleep(0.25)
                if not ready:
                    log_file.flush()
                    detail = log_path.read_text(encoding="utf-8", errors="replace")[-3000:]
                    raise RuntimeError("一次性发布验收 Hub 没有启动成功：\n" + detail)
                yield
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=5)
                time.sleep(1)
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


async def seed():
    global TOKEN
    from app import automation_models as am, models
    from app.db import SessionLocal
    from app.services import (device_auth, environment_service, preflight_evidence,
                              release_control, task_events)

    async with SessionLocal() as session:
        await release_control.bootstrap(session)
        user = models.User(
            id=UID, username="smoke-delivery", display_name="业务验收人",
            is_active=True)
        box = models.Client(id=CID, name="验收人的 SoduWork")
        box.secret_hash = device_auth.hash_secret(SECRET)
        device_auth.activate(box, user)
        TOKEN, _ = device_auth.issue_session(box)
        project = models.Project(
            id="p-smoke-delivery-http", name="企业发布闭环", owner_user_id=UID)
        repo = models.Repo(
            id="r-smoke-delivery-http", project_id=project.id, name="业务服务",
            git_url="https://git.example/soduwork/service.git",
            default_branch="main", merge_branch="main")
        task = models.Task(
            id=TID, title="发布并验收业务版本", status="doing",
            owner_client_id=CID, created_by=UID, created_by_name=user.display_name,
            requester_user_id=UID, assignee_user_id=UID,
            project_id=project.id, repo_id=repo.id)
        env = am.Environment(
            id=ENV_ID, key="customer-live", name="客户生产环境", tier="custom",
            enabled=True, promotion_policy={
                "autoStart": True, "requires": [],
                "requiresAcceptance": True, "marksDelivery": True,
            }, health_checks=[{
                "type": "http", "name": "版本与业务就绪",
                "url": "https://service.example/health", "expectStatus": 200,
            }])
        target = am.DeploymentTarget(
            id=TARGET_ID, repo_id=repo.id, environment_id=ENV_ID,
            name="客户生产 Web", provider="runner-command", enabled=True,
            config={"argv": ["deploy", "service"]},
            rollback={"mode": "automatic", "argv": ["rollback", "service"]})
        artifact = am.ArtifactVersion(
            id=ARTIFACT_ID, task_id=TID, seq=1, kind="code",
            checksum="delivery-http-checksum", commit_sha="a" * 40,
            branch="feat/release", target="main", state="merged",
            manifest={"files": ["src/app.js"], "checks": ["unit", "build"]})
        now = datetime.now(timezone.utc)
        run = am.DeploymentRun(
            id=RUN_ID, task_id=TID, artifact_version_id=ARTIFACT_ID,
            environment_id=ENV_ID, target_id=TARGET_ID, state="succeeded",
            attempt=1, idempotency_key=f"{ARTIFACT_ID}:{TARGET_ID}",
            runner_id="runner-smoke-trial", commit_sha="a" * 40,
            started_at=now, finished_at=now,
            result={
                "stage": "check", "version": "v1.11.0-beta.2",
                "checksPlanned": 1, "checksPassed": 1,
                "checks": [{
                    "type": "http", "name": "版本与业务就绪", "ok": True,
                    "detail": "200 / version v1.11.0-beta.2",
                }],
            })
        plugin = am.Plugin(
            id="plugin-smoke-delivery-http", key="release-to-acceptance",
            name="需求到发布验收", enabled=True)
        version = am.PluginVersion(
            id="plugin-version-smoke-delivery-http", plugin_id=plugin.id,
            version="1.0.0", checksum="workflow-delivery-http-checksum",
            trust_state="trusted", enabled=True,
            workflow={"nodes": [{
                "key": "publish", "name": "发布并等待业务验收",
                "type": "publish", "outputs": [],
            }]})
        workflow_run = am.WorkflowRun(
            id="workflow-smoke-delivery-http", task_id=TID,
            plugin_id=plugin.id, plugin_version_id=version.id,
            state="succeeded", started_at=now, finished_at=now,
            output={"artifactVersionId": ARTIFACT_ID, "environmentId": ENV_ID})
        publish_node = am.NodeRun(
            id="node-publish-smoke-delivery-http", run_id=workflow_run.id,
            node_key="publish", node_type="publish", state="succeeded",
            idempotency_key="workflow-smoke-delivery-http:publish:1",
            started_at=now, finished_at=now,
            output={"artifactVersionId": ARTIFACT_ID,
                    "environmentId": ENV_ID, "deploymentRunId": RUN_ID})
        session.add_all([
            user, box, project, repo, task, env, target, artifact, run,
            plugin, version, workflow_run, publish_node,
        ])
        await session.flush()
        task_events.record(session, task.id, "ai.dispatched", {
            "assignee": "runner:smoke:pi", "provider": "runner",
        }, actor="SoduWork")
        await preflight_evidence.record(
            session, subject_kind="deployment_target", subject_id=target.id,
            check_kind="deploy.preflight",
            config_fingerprint=environment_service.target_probe_fingerprint(
                target, env, repo, {}),
            ok=True, summary="trial Runner 与部署入口已真实探测",
            executor_id="runner-smoke-trial", executor_name="trial Runner")
        request = await release_control.ensure_request(
            session, task, artifact, "uat", ENV_ID,
            {"summary": "生产发布完成，请核对真实页面与业务结果"})
        await session.commit()
        return request.id


async def persisted(request_id):
    from app import automation_models as am, models
    from app.db import SessionLocal
    async with SessionLocal() as session:
        return (
            await session.get(models.Task, TID),
            await session.get(am.ArtifactVersion, ARTIFACT_ID),
            await session.get(am.ApprovalRequest, request_id),
        )


async def main():
    request_id = await seed()
    db_path = pathlib.Path(
        os.environ["DATABASE_URL"].removeprefix("sqlite+aiosqlite:///"),
    ).resolve()
    chk("真实 HTTP 用例使用一次性隔离数据库",
        str(db_path).startswith(DATA_ROOT + os.sep), db_path)

    async with httpx.AsyncClient(base_url=BASE, timeout=30, trust_env=False) as client:
        inbox = await client.get("/api/v1/approvals", headers=headers())
        inbox_body = inbox.json() if inbox.status_code == 200 else {}
        item = (inbox_body.get("items") or [{}])[0]
        chk("客户端收到发布后业务验收门禁",
            inbox.status_code == 200 and item.get("id") == request_id
            and item.get("action") == "uat" and item.get("environmentId") == ENV_ID,
            inbox_body)

        detail = await client.get(f"/api/v1/approvals/{request_id}", headers=headers())
        detail_body = detail.json() if detail.status_code == 200 else {}
        deployments = (detail_body.get("trace") or {}).get("deployments") or []
        deployment = deployments[0] if deployments else {}
        verification = deployment.get("verification") or {}
        chk("验收前能看到固定版本、环境和健康检查证据",
            detail.status_code == 200
            and (detail_body.get("item") or {}).get("artifact", {}).get("id") == ARTIFACT_ID
            and deployment.get("environmentId") == ENV_ID
            and verification.get("state") == "passed"
            and verification.get("completed") == 1
            and (verification.get("checks") or [{}])[0].get("ok") is True,
            detail_body)

        png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
        screenshot = await client.post(
            f"/api/v1/approvals/{request_id}/evidence", headers=headers(),
            files={"file": ("uat-proof.png", png, "image/png")})
        screenshot_body = screenshot.json() if screenshot.status_code == 200 else {}
        chk("UAT screenshot evidence unlocks the standardized gate",
            screenshot.status_code == 200
            and (screenshot_body.get("gate") or {}).get("readiness", {}).get("canApprove") is True,
            screenshot_body)

        approved = await client.post(
            f"/api/v1/approvals/{request_id}/decision", headers=headers(),
            json={"decision": "approve", "note": "真实页面、版本号和核心业务均已核对"})
        approved_body = approved.json() if approved.status_code == 200 else {}
        chk("客户端验收通过后自动完成交付边界",
            approved.status_code == 200
            and approved_body.get("artifact", {}).get("state") == "released"
            and (approved_body.get("execution") or {}).get("complete") is True,
            approved_body)

        pending = await client.get("/api/v1/approvals", headers=headers())
        done = await client.get("/api/v1/approvals?view=done", headers=headers())
        pending_body = pending.json() if pending.status_code == 200 else {}
        done_body = done.json() if done.status_code == 200 else {}
        chk("验收决定从待办进入已办且保留说明",
            pending_body.get("pendingCount") == 0
            and done_body.get("doneCount") == 1
            and (done_body.get("items") or [{}])[0].get("myDecision", {}).get("note")
            == "真实页面、版本号和核心业务均已核对",
            {"pending": pending_body, "done": done_body})

    task, artifact, request = await persisted(request_id)
    chk("数据库最终状态是任务办结、版本发布、验收批准",
        task.status == "done" and artifact.state == "released"
        and request.status == "approved",
        {"task": task.status, "artifact": artifact.state, "approval": request.status})

    from app.db import engine
    await engine.dispose()


if __name__ == "__main__":
    with isolated_hub():
        asyncio.run(main())
    print("\nPASS=%d FAIL=%d" % (ok, fail))
    sys.exit(1 if fail else 0)
