"""Isolated full desktop Hub: real APIs, loopback SMTP and mock model provider.

This never imports app.main or starts its production lifespan. Five test accounts
must be registered by the real client; this fixture only seeds an organization,
its ordinary role, legal settings and a clearly named local mock model.
"""
import argparse
import asyncio
from contextlib import asynccontextmanager
import importlib
import ipaddress
import json
import os
import platform
from pathlib import Path
import secrets
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True)
args = parser.parse_args()
root = Path(args.root).resolve()
if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith("soduwork-account-five-"):
    raise RuntimeError("A dedicated soduwork-account-five-* system temporary directory is required")
root.mkdir(exist_ok=True)
if (root / ".smoke-full-client.db").exists():
    raise RuntimeError("Refusing to reuse an existing fixture database")
os.chdir(root)
repo = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(repo / "hub-backend"))
isolated_environment = {
    "DATABASE_URL": "sqlite+aiosqlite:///" + (root / ".smoke-full-client.db").as_posix(),
    "AUTH_SECRET": secrets.token_urlsafe(40), "ADMIN_PASS": secrets.token_urlsafe(24),
    "SODUWORK_ENV": "development", "DEVICE_AUTH_COMPAT": "false", "CLUSTER_REDIS_URL": "",
    "SODUWORK_DATA_ROOT": str(root / "hub-data"), "SKIN_DATA_ROOT": str(root / "skin-data"),
    "HUB_LOCAL_EXECUTION_ENABLED": "false", "POLL_INTERVAL_SECONDS": "0", "REPORT_AUTO": "false",
    "LIBRARY_STORAGE_BACKEND": "local", "LIBRARY_STORAGE_DIR": str(root / "library"),
    "MINIO_ENDPOINT": "", "LIBRARY_MINIO_ENDPOINT": "", "LIBRARY_NFS_HOST": "",
    "APPDATA": str(root / "appdata"), "LOCALAPPDATA": str(root / "localappdata"),
    "USERPROFILE": str(root / "home"), "CORS_ORIGINS": "null",
}
os.environ.update(isolated_environment)
for variable in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
    os.environ.pop(variable, None)
os.environ["NO_PROXY"] = "localhost,127.0.0.1,::1"
from app.config import Settings
Settings.model_config["env_file"] = None
# Do not inherit any real service configuration from the invoking shell.
for field in Settings.model_fields:
    if field.upper() not in isolated_environment:
        os.environ.pop(field.upper(), None)
for directory in ("hub-data", "skin-data", "library", "appdata", "localappdata", "home"):
    (root / directory).mkdir(exist_ok=True)

blocked_outbound = []
real_connect, real_connect_ex = socket.socket.connect, socket.socket.connect_ex
real_getaddrinfo = socket.getaddrinfo


def local_only(address):
    if not isinstance(address, tuple):
        raise RuntimeError("Only loopback network addresses are allowed in this fixture")
    host = str(address[0]).strip("[]").lower()
    try:
        allowed = host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        allowed = host == "localhost"
    if not allowed:
        blocked_outbound.append(host)
        raise RuntimeError("External networking is disabled in the isolated client fixture")


def guarded_connect(sock, address):
    local_only(address)
    return real_connect(sock, address)


def guarded_connect_ex(sock, address):
    local_only(address)
    return real_connect_ex(sock, address)


socket.socket.connect = guarded_connect
socket.socket.connect_ex = guarded_connect_ex


def guarded_getaddrinfo(host, port, *args, **kwargs):
    if host is not None:
        local_only((host.decode() if isinstance(host, bytes) else host, port))
    return real_getaddrinfo(host, port, *args, **kwargs)


socket.getaddrinfo = guarded_getaddrinfo


def no_subprocess(*args, **kwargs):
    raise RuntimeError("Hub subprocesses and local Runner execution are disabled in this fixture")


# The standard library can run Windows' read-only `ver` fallback once while
# discovering platform metadata. Cache it before denying business subprocesses.
platform.uname()
subprocess.Popen = no_subprocess

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from app import models
from app.db import SessionLocal, engine, init_db
from app.mail_models import MailOutbox
from app.account_models import EmailChallenge
from app.services import account_legal, account_mail, client_access, model_transport, work_catalog
from account_smtp_fixture import TLSSMTP

control_key = secrets.token_urlsafe(24)
provider_key = secrets.token_urlsafe(24)
smtp = TLSSMTP(root)
trusted = ssl.create_default_context(cafile=str(smtp.cert))
original_context = account_mail.ssl.create_default_context
account_mail.ssl.create_default_context = lambda *a, **k: trusted
request_log = []
model_calls = []
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
port = sock.getsockname()[1]
server = None


@asynccontextmanager
async def lifespan(app):
    # Windows Proactor uses Overlapped.ConnectEx and can bypass socket.connect;
    # enforce the same boundary before any async transport is opened.
    loop = asyncio.get_running_loop()
    real_create_connection, real_sock_connect = loop.create_connection, loop.sock_connect

    async def guarded_create_connection(protocol_factory, host=None, port=None, *args, **kwargs):
        if host is not None:
            local_only((host, port))
        elif kwargs.get("sock") is not None:
            local_only(kwargs["sock"].getpeername())
        else:
            raise RuntimeError("An explicit loopback peer is required")
        return await real_create_connection(protocol_factory, host, port, *args, **kwargs)

    async def guarded_sock_connect(sock, address):
        local_only(address)
        return await real_sock_connect(sock, address)

    loop.create_connection, loop.sock_connect = guarded_create_connection, guarded_sock_connect
    # This is the actual current Alembic/init_db path, against a fresh temp DB.
    await init_db()
    async with SessionLocal() as session:
        session.add(models.OrgUnit(id="fixture-company-org", name="总部门"))
        session.add(models.OrgUnit(id="fixture-default-org", name="研发部-试用组", parent_id="fixture-company-org"))
        session.add(models.Role(id="fixture-normal-role", name="普通成员", permissions=[]))
        session.add(models.ModelProvider(id="fixture", name="本地 Mock 模型", kind="openai-compat",
            base_url=f"http://127.0.0.1:{port}/__fixture__/provider/v1", api_key=provider_key, enabled=True))
        session.add(models.ModelDef(id="fixture:fixture-chat", provider_id="fixture", name="fixture-chat",
            label="本地 Mock 对话模型", enabled=True, ctx_window=32768, config={"maxOutputTokens": 4096}))
        await session.commit()
        await client_access.update_policy(session, {"defaultOrgId": "fixture-default-org", "defaultRoleId": "fixture-normal-role"})
        await account_legal.save_settings(session, {"operatorName": "本地隔离验收环境", "contactEmail": "privacy@example.test"})
        await account_mail.save_settings(session, {"enabled": True, "host": "localhost", "port": smtp.server_address[1],
            "security": "ssl", "username": "sender@example.test", "senderAddress": "sender@example.test",
            "senderName": "SoduWork 本地验收", "password": "fixture-smtp-password"})
        await session.commit()
        await work_catalog.bootstrap(session)

    async def mail_loop():
        while True:
            await account_mail.process_one(SessionLocal)
            await asyncio.sleep(0.15)

    jobs = [asyncio.create_task(mail_loop())]
    print("ACCOUNT_FIXTURE_READY " + json.dumps({"port": port, "key": control_key,
        "root": str(root), "model": "fixture-chat", "mockBoundaries": ["smtp", "model-provider"]}), flush=True)
    try:
        yield
    finally:
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        await model_transport.shutdown()
        await engine.dispose()
        smtp.stop()
        account_mail.ssl.create_default_context = original_context


app = FastAPI(title="SoduWork isolated desktop acceptance", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["null"], allow_methods=["*"], allow_headers=["*"])
# Production router implementations, without production worker/bootstrap imports.
router_names = (
    "account_profile", "client_email_auth", "client_auth", "clients", "tasks", "task_options",
    "aidesk", "config", "model_runtime", "model_capabilities", "work_catalog", "identity", "capabilities",
    "approvals", "delivery", "deliveries", "environments", "repomap", "repositories", "repository_issues",
    "attachments", "ingest", "library", "plugins", "plugin_publishers", "plugin_client_catalog",
    "plugin_client_runs", "plugin_activity", "plugin_permissions", "client_updates", "updates", "download",
    "ws", "term", "agents", "runner_ws", "usage", "ai_proxy", "trace", "evolution", "task_mcp",
    "operations", "reports", "cloud_environments", "cloud_conversations", "conversation_handoffs",
    "session_memory", "memory_records", "retired_endpoints",
)
for module_name in router_names:
    module = importlib.import_module("app.api." + module_name)
    app.include_router(module.router)
    if module_name == "plugins":
        app.include_router(module.run_router)


@app.middleware("http")
async def record_requests(request: Request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/__fixture__/"):
        request_log.append({"method": request.method, "path": request.url.path, "status": response.status_code})
        del request_log[:-2000]
    return response


@app.get("/healthz")
async def health():
    return {"ok": True, "service": "isolated-full-client-fixture", "mock": ["smtp", "model-provider"]}


def authorize_control(key):
    if not secrets.compare_digest(key, control_key):
        raise HTTPException(403)


@app.post("/__fixture__/shutdown")
async def shutdown(x_fixture_key: str = Header(default="")):
    authorize_control(x_fixture_key)
    if server is None:
        raise HTTPException(503, "Fixture server has not started")
    # Uvicorn drains this response and active connections before lifespan
    # cleanup stops SMTP, the mail worker, transports and database resources.
    server.should_exit = True
    return {"ok": True, "shuttingDown": True}


@app.get("/__fixture__/mail/{challenge_id}")
async def delivered_mail(challenge_id: str, x_fixture_key: str = Header(default="")):
    authorize_control(x_fixture_key)
    async with SessionLocal() as session:
        row = await session.scalar(select(MailOutbox).where(MailOutbox.challenge_id == challenge_id))
        if row is None or row.state != "sent":
            return {"ready": False}
        challenge = await session.get(EmailChallenge, challenge_id)
        if challenge is None or not challenge.email_normalized.endswith("@example.test"):
            raise HTTPException(404)
        code = smtp.last_code(challenge.email_normalized)
    return {"ready": True, "code": code, "smtpDelivered": True} if code else {"ready": False}


@app.get("/__fixture__/summary")
async def summary(x_fixture_key: str = Header(default="")):
    authorize_control(x_fixture_key)
    async with SessionLocal() as session:
        users = list((await session.scalars(select(models.User))).all())
        tasks = list((await session.scalars(select(models.Task))).all())
        clients = list((await session.scalars(select(models.Client))).all())
        organizations = list((await session.scalars(select(models.OrgUnit))).all())
    return {"organizations": [{"id": o.id, "name": o.name, "parentId": o.parent_id} for o in organizations],
        "users": [{"id": u.id, "email": u.email, "active": u.is_active,
        "verified": bool(u.email_verified_at), "orgId": u.org_id, "roleId": u.role_id} for u in users],
        "tasks": [{"id": t.id, "title": t.title, "ownerClientId": t.owner_client_id, "ownerUserId": t.owner_user_id, "status": t.status,
            "createdBy": t.created_by, "creatorUserId": t.created_by, "assigneeUserId": t.assignee_user_id,
            "visibility": "organization" if t.shared_org_id else "related", "sharedOrgId": t.shared_org_id}
            for t in tasks],
        "clients": [{"id": c.id, "userId": c.user_ref} for c in clients],
        "modelCalls": model_calls, "requests": request_log, "blockedOutbound": blocked_outbound}


def message_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(item.get("text") or "") for item in content if isinstance(item, dict))
    return ""


@app.post("/__fixture__/provider/v1/chat/completions")
async def mock_completion(request: Request):
    if request.headers.get("authorization") != "Bearer " + provider_key:
        raise HTTPException(401)
    body = await request.json()
    messages = list(body.get("messages") or [])
    user_text = next((message_text(m.get("content")) for m in reversed(messages) if m.get("role") == "user"), "")
    system = "\n".join(message_text(m.get("content")) for m in messages if m.get("role") in ("system", "developer"))
    parse_request = "需求录入助手" in system
    if parse_request:
        text = json.dumps({"title": user_text.strip()[:20] or "本地验收需求", "note": user_text[:1500],
            "priority": "normal", "kind": "requirement", "assignee": "me", "flow": "",
            "checklist": ["需求成功保存并能在需求列表查看", "需求标题与提交内容一致"],
            "reason": "本地 Mock 模型提供验收用预填字段"}, ensure_ascii=False)
    else:
        text = "已收到你的消息。这里使用本地 Mock 模型验证注册后的对话链路；你可以继续通过页面创建需求。"
    model_calls.append({"number": len(model_calls) + 1, "model": body.get("model"),
        "stream": bool(body.get("stream")), "purpose": "task-parse" if parse_request else "chat",
        "userMessageLength": len(user_text)})
    identity = "chatcmpl-fixture-" + uuid.uuid4().hex
    created = int(time.time())
    envelope = {"id": identity, "object": "chat.completion", "created": created, "model": "fixture-chat"}
    usage = {"prompt_tokens": 80, "completion_tokens": 50, "total_tokens": 130}
    if not body.get("stream"):
        return {**envelope, "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
            "finish_reason": "stop"}], "usage": usage}

    async def events():
        header = {**envelope, "object": "chat.completion.chunk"}
        chunks = [{"role": "assistant", "content": ""}] + [{"content": text[i:i+12]} for i in range(0, len(text), 12)]
        for delta in chunks:
            yield "data: " + json.dumps({**header, "choices": [{"index": 0, "delta": delta,
                "finish_reason": None}]}, ensure_ascii=False) + "\n\n"
            await asyncio.sleep(0.01)
        yield "data: " + json.dumps({**header, "choices": [{"index": 0, "delta": {},
            "finish_reason": "stop"}], "usage": usage}) + "\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(events(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error", access_log=False)
    server = uvicorn.Server(config)
    asyncio.run(server.serve(sockets=[sock]))
