"""Explicit personal IM configuration and short-lived, single-use pairing grants."""
import hashlib
import json
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import func, select, update

from .. import automation_models as am, im_models as im, models
from ..config import get_settings
from . import client_access, connector_oauth_registry, im_transport


def now():
    return datetime.now(timezone.utc)


def enabled():
    if not get_settings().im_enabled:
        raise HTTPException(503, "管理员尚未启用 IM 远程办公")


def pack(value):
    try:
        return connector_oauth_registry.cipher().encrypt(json.dumps(value).encode()).decode()
    except ValueError:
        raise HTTPException(503, "请管理员配置连接器授权加密密钥") from None


def unpack(connection):
    try:
        return json.loads(connector_oauth_registry.cipher().decrypt(connection.credentials.encode()))
    except Exception:
        raise HTTPException(503, "平台凭据不可用，请重新配置连接") from None


def callback(connection_id):
    try:
        base = connector_oauth_registry.callback_url().split("/api/v1/", 1)[0]
    except ValueError:
        raise HTTPException(503, "请管理员配置 Hub 公网 HTTPS 地址") from None
    return base + "/api/v1/im/webhooks/" + connection_id


async def authorize(session, connection, *, active=True, quota=False):
    if connection is None or (active and not connection.enabled):
        raise HTTPException(403, "远程连接已停用")
    client = await session.get(models.Client, connection.owner_client_id, populate_existing=True)
    user = await session.get(models.User, connection.owner_user_id, populate_existing=True)
    if (client is None or user is None or not user.is_active or client.auth_state != "active"
            or client.user_ref != connection.owner_user_id
            or int(client.auth_version or 1) != connection.client_version
            or int(user.auth_version or 1) != connection.user_version):
        raise HTTPException(403, "账号或设备授权已变更，请重新配置连接")
    if quota:
        try:
            await client_access.assert_quota(session, user.id)
        except client_access.ClientAccessError as exc:
            raise HTTPException(exc.status, "当前账号额度或使用权限不足") from None
    return client, user


async def owned(session, client, connection_id):
    connection = await session.get(im.IMConnection, connection_id, populate_existing=True)
    if connection is None or connection.owner_client_id != client.id or connection.owner_user_id != client.user_ref:
        raise HTTPException(404, "连接不存在")
    await authorize(session, connection, active=False)
    return connection


def public(connection):
    try:
        webhook_url = callback(connection.id)
    except HTTPException as exc:
        if exc.status_code != 503:
            raise
        webhook_url = ""
    return {"id": connection.id, "provider": connection.provider, "name": connection.name,
            "enabled": connection.enabled, "webhookUrl": webhook_url,
            "botUsername": (connection.config or {}).get("bot_username", ""), "credentialsConfigured": bool(connection.credentials)}


async def create(session, client, body):
    enabled()
    if not isinstance(body, dict) or set(body) - {"provider", "name", "credentials"}:
        raise HTTPException(400, "连接配置不正确")
    provider = body.get("provider")
    try:
        credentials = im_transport.validate_credentials(provider, body.get("credentials"))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    name = body.get("name") or provider
    if not isinstance(name, str) or not 1 <= len(name) <= 100:
        raise HTTPException(400, "连接名称不正确")
    user = await session.get(models.User, client.user_ref or "")
    if not user or not user.is_active or client.auth_state != "active":
        raise HTTPException(403, "请先登录有效账号")
    count = await session.scalar(select(func.count()).select_from(im.IMConnection).where(
        im.IMConnection.owner_user_id == user.id, im.IMConnection.credentials != ""))
    if count >= 10:
        raise HTTPException(409, "每个账号最多配置 10 个远程连接")
    if provider == "telegram":
        credentials["webhook_secret"] = secrets.token_urlsafe(32)
    connection = im.IMConnection(id=str(uuid.uuid4()), owner_user_id=user.id, owner_client_id=client.id,
        user_version=int(user.auth_version or 1), client_version=int(client.auth_version or 1),
        provider=provider, name=name, enabled=False, credentials=pack(credentials), config={})
    callback(connection.id)
    view = public(connection)
    session.add(connection)
    await session.commit()
    return view


async def connect(session, client, connection_id):
    enabled()
    connection = await owned(session, client, connection_id)
    if connection.enabled:
        return public(connection)
    original_credentials = connection.credentials
    try:
        config = await im_transport.connect(connection.provider, unpack(connection), callback(connection.id))
    except im_transport.TransportError:
        raise HTTPException(502, "平台连接失败，请检查应用权限、凭据与公网地址") from None
    # Recheck after the provider call so an in-flight connect cannot undo revocation.
    await session.refresh(connection)
    await authorize(session, connection, active=False)
    if connection.credentials != original_credentials:
        raise HTTPException(409, "连接已变更，请重新操作")
    connection.config, connection.enabled = config, True
    await session.commit()
    return public(connection)


async def revoke(session, client, connection_id):
    connection = await session.get(im.IMConnection, connection_id)
    if not connection or connection.owner_client_id != client.id or connection.owner_user_id != client.user_ref:
        raise HTTPException(404, "连接不存在")
    connection.enabled, connection.credentials = False, ""
    await session.execute(update(im.IMBinding).where(im.IMBinding.connection_id == connection_id).values(enabled=False))
    await session.execute(update(im.IMPairing).where(im.IMPairing.connection_id == connection_id).values(used_at=now()))
    await session.commit()
    return {"ok": True}


async def target(session, connection, task_id, runner_id, *, quota=False):
    client, user = await authorize(session, connection, quota=quota)
    task = await session.get(models.Task, task_id, populate_existing=True)
    runner = await session.get(am.RunnerNode, runner_id, populate_existing=True)
    if not task or task.owner_client_id != client.id or not runner:
        raise HTTPException(403, "只能操作本人任务和执行机")
    if runner.client_id:
        owner = await session.get(models.Client, runner.client_id, populate_existing=True)
        allowed = owner and owner.auth_state == "active" and owner.user_ref == user.id
    else:
        allowed = runner.owner_user_id == user.id
    if not allowed or runner.auth_state == "revoked" or runner.management_state:
        raise HTTPException(403, "执行机授权已失效")
    return client, task, runner


async def pairing(session, client, connection_id, body):
    enabled()
    connection = await owned(session, client, connection_id)
    if not isinstance(body, dict) or set(body) - {"taskId", "runnerId", "allowStart", "agentId", "model"}:
        raise HTTPException(400, "绑定配置不正确")
    for key, limit in (("taskId", 36), ("runnerId", 80), ("agentId", 80), ("model", 200)):
        value = body.get(key, "")
        if not isinstance(value, str) or len(value) > limit or "\0" in value:
            raise HTTPException(400, "绑定字段不正确")
    if type(body.get("allowStart", False)) is not bool:
        raise HTTPException(400, "请明确选择是否允许启动任务")
    client, task, runner = await target(session, connection, body.get("taskId"), body.get("runnerId"), quota=True)
    from . import ai_exec
    dispatch = await ai_exec.last_dispatch_event(session, body["taskId"])
    if dispatch and (dispatch.detail or {}).get("runnerId") != body["runnerId"]:
        raise HTTPException(409, "请绑定任务当前使用的执行机")
    if not dispatch and not body.get("allowStart"):
        raise HTTPException(409, "任务尚未启动，请先启动或明确授权远程启动")
    if body.get("allowStart"):
        from . import im_targets
        await im_targets.validate_start(session, client, task, runner, body)
    count = await session.scalar(select(func.count()).select_from(im.IMPairing).where(
        im.IMPairing.connection_id == connection_id, im.IMPairing.used_at.is_(None), im.IMPairing.expires_at > now()))
    if count >= 10:
        raise HTTPException(429, "有效配对码过多，请等待过期或使用已有配对码")
    code = secrets.token_urlsafe(18)
    session.add(im.IMPairing(code_hash=hashlib.sha256(code.encode()).hexdigest(), connection_id=connection_id,
        task_id=body["taskId"], runner_id=body["runnerId"],
        options={key: body[key] for key in ("allowStart", "agentId", "model") if key in body},
        expires_at=now() + timedelta(minutes=10)))
    await session.commit()
    command = "/pair " + code
    if connection.provider == "telegram" and (connection.config or {}).get("bot_username"):
        command = "/pair@" + connection.config["bot_username"] + " " + code
    elif connection.provider in {"slack", "teams"}:
        command = "pair " + code
    elif connection.provider == "discord":
        command = "/pair code:" + code
    return {"code": code, "command": command, "expiresIn": 600}
