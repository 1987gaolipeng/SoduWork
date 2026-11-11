# -*- coding: utf-8 -*-
"""Real HTTP approval-inbox regression tests using a disposable Hub and temporary SQLite database.
Fixtures prepare prerequisites only; test access, detail, decisions, and history through live
HTTP before removing the temporary data.
"""
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

import httpx

sys.path.insert(0, ".")

BASE = ""
DATA_ROOT = ""
UID = "u-smoke-approval"
CREATOR_UID = "u-smoke-approval-creator"
CID = "c-smoke-approval"
OUT_UID = "u-smoke-approval-out"
OUT_CID = "c-smoke-approval-out"
TID = "t-smoke-approval"
SECRET = secrets.token_urlsafe(32)
OUT_SECRET = secrets.token_urlsafe(32)
REVIEW_UID = "u-smoke-approval-reviewer"
REVIEW_CID = "c-smoke-approval-reviewer"
REVIEW_SECRET = secrets.token_urlsafe(32)
ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:400] if extra else ""))


def headers(client_id=CID, secret=SECRET):
    return {"X-Soduwork-Device": client_id, "X-Soduwork-Secret": secret}


@contextlib.contextmanager
def isolated_hub():
    """Start an isolated real Hub and configure fixture processes to use only its temporary
    database.
    """
    global BASE, DATA_ROOT
    keys = (
        "DATABASE_URL", "DB_MIGRATION_MODE", "ADMIN_USER", "ADMIN_PASS",
        "AUTH_SECRET", "SODUWORK_DATA_ROOT", "REPORT_AUTO",
        "POLL_INTERVAL_SECONDS", "MINIO_ENDPOINT", "MINIO_ACCESS_KEY",
        "MINIO_SECRET_KEY",
    )
    previous = {key: os.environ.get(key) for key in keys}
    with tempfile.TemporaryDirectory(prefix="soduwork-smoke-approval-e2e-") as folder:
        root = pathlib.Path(folder).resolve()
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            port = int(probe.getsockname()[1])
        BASE = f"http://127.0.0.1:{port}"
        DATA_ROOT = str(root)
        isolated = {
            "DATABASE_URL": "sqlite+aiosqlite:///" + (root / "hub.db").as_posix(),
            "DB_MIGRATION_MODE": "auto",
            "ADMIN_USER": "smoke-approval-admin",
            "ADMIN_PASS": secrets.token_urlsafe(24),
            "AUTH_SECRET": secrets.token_urlsafe(36),
            "SODUWORK_DATA_ROOT": str(root / "data"),
            "REPORT_AUTO": "false",
            "POLL_INTERVAL_SECONDS": "0",
            "MINIO_ENDPOINT": "",
            "MINIO_ACCESS_KEY": "",
            "MINIO_SECRET_KEY": "",
        }
        os.environ.update(isolated)
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
                startup_timeout = float(os.environ.get("SODUWORK_SMOKE_STARTUP_TIMEOUT", "45"))
                started = time.monotonic()
                deadline = started + startup_timeout
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                while time.monotonic() < deadline and proc.poll() is None:
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
                    detail = log_path.read_text(
                        encoding="utf-8", errors="replace")[-3000:]
                    raise RuntimeError("一次性审批 Hub 没有启动成功：\n" + detail)
                print(f"Isolated approval Hub ready in {time.monotonic() - started:.1f}s "
                      f"(startup budget {startup_timeout:.0f}s)", flush=True)
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
    """Create approval prerequisites only in temporary SQLite, never the business database."""
    from sqlalchemy import select
    from app import automation_models as am, models
    from app.db import SessionLocal
    from app.services import device_auth, release_control

    async with SessionLocal() as session:
        await release_control.bootstrap(session)
        owner = models.User(
            id=UID, username="smoke-approval", display_name="冒烟发起人",
            is_active=True)
        creator = models.User(
            id=CREATOR_UID, username="smoke-approval-creator",
            display_name="后台代建人", is_active=True)
        outsider = models.User(
            id=OUT_UID, username="smoke-approval-out",
            display_name="无关人员", is_active=True)
        box = models.Client(id=CID, name="审批冒烟 SoduWork")
        box.secret_hash = device_auth.hash_secret(SECRET)
        device_auth.activate(box, owner)
        other = models.Client(id=OUT_CID, name="无关 SoduWork")
        other.secret_hash = device_auth.hash_secret(OUT_SECRET)
        device_auth.activate(other, outsider)
        task = models.Task(
            id=TID, title="确认论坛需求基线", note="验证客户端审批闭环",
            owner_client_id=CID, created_by=CREATOR_UID,
            created_by_name=creator.display_name,
            requester_user_id=UID, assignee_user_id=UID)
        session.add_all([owner, creator, outsider, box, other, task])
        await session.flush()
        artifact, _ = await release_control.ensure_requirement_candidate(
            session, task, {
                "files": [{"id": "requirements", "name": "requirements.md", "size": 320}],
                "acceptanceCriteria": [
                    "审批人能看到固定版本", "通过后从待办消失"],
                "assumptions": ["后台代建后由任务负责人确认"],
                "risks": ["新版本必须使旧审批失效"],
            }, who="SoduWork")
        request = (await session.execute(
            select(am.ApprovalRequest).where(
                am.ApprovalRequest.artifact_version_id == artifact.id)
        )).scalar_one()
        await session.commit()
        return request.id, artifact.id


async def seed_uat():
    """Prepare a UAT gate whose health check passes but screenshot is missing."""
    from app import automation_models as am, models
    from app.db import SessionLocal
    from app.services import device_auth, release_control

    async with SessionLocal() as session:
        reviewer = models.User(
            id=REVIEW_UID, username="smoke-approval-reviewer",
            display_name="独立验收人", is_active=True)
        reviewer_box = models.Client(id=REVIEW_CID, name="验收人 SoduWork")
        reviewer_box.secret_hash = device_auth.hash_secret(REVIEW_SECRET)
        device_auth.activate(reviewer_box, reviewer)
        task = models.Task(
            id=TID + "-uat", title="确认 trial 试用环境", note="验证截图证据门禁",
            owner_client_id=CID, created_by=CREATOR_UID,
            created_by_name="后台代建人", requester_user_id=UID, assignee_user_id=UID)
        env = am.Environment(id="env-smoke-uat", key="trial-trial", name="trial 试用环境", tier="trial")
        artifact = am.ArtifactVersion(
            id="artifact-smoke-uat", task_id=task.id, seq=1, kind="code",
            source_ref="runner:smoke-uat", commit_sha="abc123def456",
            checksum="sha256-smoke-uat", manifest={}, created_by_name="SoduWork")
        session.add_all([reviewer, reviewer_box, task, env, artifact])
        await session.flush()
        request = await release_control.ensure_request(
            session, task, artifact, "uat", env.id,
            context={"acceptanceCriteria": ["首页可用", "核心操作有截图证据"]})
        session.add(am.ApprovalAssignment(
            request_id=request.id, user_id=reviewer.id, user_name=reviewer.display_name,
            sources=[{"kind": "uat", "label": "Independent UAT reviewer"}],
        ))
        session.add(am.DeploymentRun(
            id="deploy-smoke-uat", task_id=task.id, artifact_version_id=artifact.id,
            environment_id=env.id, target_id="target-smoke-uat", state="succeeded",
            attempt=1, idempotency_key="deploy-smoke-uat-1", runner_id="runner-trial",
            commit_sha=artifact.commit_sha,
            result={"checks": [{"name": "HTTP health", "ok": True, "detail": "200 OK"}]},
        ))
        await session.commit()
        return request.id, artifact.id

async def persisted(request_id):
    from sqlalchemy import select
    from app import automation_models as am
    from app.db import SessionLocal

    async with SessionLocal() as session:
        request = await session.get(am.ApprovalRequest, request_id)
        decisions = list((await session.execute(
            select(am.ApprovalDecision).where(
                am.ApprovalDecision.request_id == request_id)
        )).scalars())
        return request, decisions


async def main():
    request_id, artifact_id = await seed()
    db_path = pathlib.Path(
        os.environ["DATABASE_URL"].removeprefix("sqlite+aiosqlite:///")).resolve()
    chk("审批走查使用一次性隔离数据库",
        str(db_path).startswith(DATA_ROOT + os.sep), db_path)

    async with httpx.AsyncClient(base_url=BASE, timeout=30, trust_env=False) as client:
        inbox = await client.get("/api/v1/approvals", headers=headers())
        body = inbox.json() if inbox.status_code == 200 else {}
        chk("需求提出人能在客户端收到需求基线审批",
            inbox.status_code == 200 and body.get("count") == 1
            and body.get("pendingCount") == 1 and body.get("doneCount") == 0
            and body["items"][0]["id"] == request_id, body)
        chk("审批卡带齐任务、动作与不可变制品版本",
            body.get("items") and body["items"][0]["action"] == "baseline"
            and body["items"][0]["artifact"]["id"] == artifact_id
            and body["items"][0]["task"]["id"] == TID, body)

        hidden = await client.get(
            "/api/v1/approvals", headers=headers(OUT_CID, OUT_SECRET))
        hidden_body = hidden.json() if hidden.status_code == 200 else {}
        chk("无关人员看不到不属于自己的审批",
            hidden.status_code == 200 and hidden_body.get("count") == 0,
            hidden_body)

        detail = await client.get(
            f"/api/v1/approvals/{request_id}", headers=headers())
        detail_body = detail.json() if detail.status_code == 200 else {}
        manifest = (
            (detail_body.get("item") or {}).get("artifact") or {}
        ).get("manifest") or {}
        trace = detail_body.get("trace") or {}
        chk("审批详情带需求、证据与运行视图",
            detail.status_code == 200
            and len(manifest.get("acceptanceCriteria") or []) == 2
            and trace.get("task", {}).get("id") == TID
            and isinstance(trace.get("runs"), list)
            and isinstance(trace.get("deployments"), list)
            and isinstance(trace.get("attachments"), list)
            and isinstance(trace.get("timeline"), list), detail_body)

        bad = await client.post(
            f"/api/v1/approvals/{request_id}/decision",
            headers=headers(), json={"decision": "reject"})
        chk("退回必须填写可执行的修改意见",
            bad.status_code == 400, bad.text)

        approved = await client.post(
            f"/api/v1/approvals/{request_id}/decision",
            headers=headers(),
            json={"decision": "approve", "note": "范围清晰，可以开发"})
        approved_body = approved.json() if approved.status_code == 200 else {}
        chk("客户端批准后固定该版需求基线",
            approved.status_code == 200
            and approved_body.get("artifact", {}).get("state") == "baselined",
            approved_body)

        empty = await client.get("/api/v1/approvals", headers=headers())
        empty_body = empty.json() if empty.status_code == 200 else {}
        chk("已处理审批立即从待办箱消失",
            empty.status_code == 200 and empty_body.get("count") == 0
            and empty_body.get("pendingCount") == 0
            and empty_body.get("doneCount") == 1, empty_body)

        done = await client.get(
            "/api/v1/approvals?view=done", headers=headers())
        done_body = done.json() if done.status_code == 200 else {}
        chk("本人处理过的决定进入只读已办",
            done.status_code == 200 and done_body.get("count") == 1
            and done_body.get("view") == "done"
            and done_body["items"][0].get("myDecision", {}).get("decision")
            == "approve"
            and done_body["items"][0].get("artifact", {}).get("id")
            == artifact_id, done_body)

        done_detail = await client.get(
            f"/api/v1/approvals/{request_id}", headers=headers())
        done_detail_body = (
            done_detail.json() if done_detail.status_code == 200 else {})
        chk("审批完成后本人仍能查看当时的完整证据",
            done_detail.status_code == 200
            and done_detail_body.get("item", {}).get(
                "myDecision", {}).get("note") == "范围清晰，可以开发",
            done_detail_body)

        outsider_done = await client.get(
            "/api/v1/approvals?view=done",
            headers=headers(OUT_CID, OUT_SECRET))
        outsider_body = (
            outsider_done.json() if outsider_done.status_code == 200 else {})
        chk("无关人员也看不到别人的已办记录",
            outsider_done.status_code == 200
            and outsider_body.get("count") == 0, outsider_body)

    uat_request_id, uat_artifact_id = await seed_uat()
    async with httpx.AsyncClient(base_url=BASE, timeout=30, trust_env=False) as client:
        uat_detail = await client.get(
            f"/api/v1/approvals/{uat_request_id}", headers=headers(REVIEW_CID, REVIEW_SECRET))
        uat_body = uat_detail.json() if uat_detail.status_code == 200 else {}
        gate = (uat_body.get("item") or {}).get("gate") or {}
        chk("UAT 门禁明确展示缺少的验收截图",
            uat_detail.status_code == 200
            and gate.get("readiness", {}).get("canApprove") is False
            and any("截图" in str(x) for x in gate.get("readiness", {}).get("blockers", [])),
            uat_body)

        blocked = await client.post(
            f"/api/v1/approvals/{uat_request_id}/decision", headers=headers(REVIEW_CID, REVIEW_SECRET),
            json={"decision": "approve", "note": "试图绕过证据"})
        chk("缺少截图时后端拒绝批准而非只禁用按钮",
            blocked.status_code == 409 and "门禁证据" in blocked.text, blocked.text)

        fake = await client.post(
            f"/api/v1/approvals/{uat_request_id}/evidence", headers=headers(REVIEW_CID, REVIEW_SECRET),
            files={"file": ("fake.png", b"\x89PNG\r\n\x1a\n", "image/png")})
        chk("伪造文件头不能冒充验收截图", fake.status_code == 415, fake.text)

        png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
        uploaded = await client.post(
            f"/api/v1/approvals/{uat_request_id}/evidence", headers=headers(REVIEW_CID, REVIEW_SECRET),
            files={"file": ("uat-home.png", png, "image/png")})
        upload_body = uploaded.json() if uploaded.status_code == 200 else {}
        upload_gate = upload_body.get("gate") or {}
        chk("真实验收截图绑定当前门禁并可预览",
            uploaded.status_code == 200
            and upload_gate.get("readiness", {}).get("canApprove") is True
            and any(x.get("kind") == "image" and x.get("url")
                    for x in upload_gate.get("evidence", [])), upload_body)

        approved_uat = await client.post(
            f"/api/v1/approvals/{uat_request_id}/decision", headers=headers(REVIEW_CID, REVIEW_SECRET),
            json={"decision": "approve", "note": "健康检查和页面截图均已核对"})
        chk("证据齐全后同一门禁可以正常批准",
            approved_uat.status_code == 200
            and approved_uat.json().get("artifact", {}).get("id") == uat_artifact_id,
            approved_uat.text)
    request, decisions = await persisted(request_id)
    chk("审批决定与审批人被持久记录",
        request is not None and request.status == "approved"
        and len(decisions) == 1 and decisions[0].user_id == UID)

    from app.db import engine
    await engine.dispose()


if __name__ == "__main__":
    with isolated_hub():
        asyncio.run(main())
    print("\nPASS=%d FAIL=%d" % (ok, fail))
    sys.exit(1 if fail else 0)
