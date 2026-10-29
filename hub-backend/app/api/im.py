"""Opt-in IM setup and verified callbacks; platform events never authenticate as devices."""
import json

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy import select, update

from .. import automation_models as am, im_models as im, models
from ..config import get_settings
from ..db import get_session
from ..deps import current_client
from ..services import im_adapters, im_connections as connections, im_ingress, runner_hub

router = APIRouter(prefix="/api/v1/im", tags=["im"])
from ..services.im_provider_registry import public as provider_catalog


async def raw_body(request):
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > im_adapters.MAX_BODY:
            raise HTTPException(413, "请求内容过大")
    return bytes(data)


async def json_body(request):
    try:
        return json.loads(await raw_body(request))
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(400, "请求格式不正确") from None


@router.get("")
async def catalog(client=Depends(current_client), session=Depends(get_session)):
    rows = list((await session.scalars(select(im.IMConnection).where(
        im.IMConnection.owner_client_id == client.id, im.IMConnection.owner_user_id == client.user_ref)
        .order_by(im.IMConnection.created_at.desc()).limit(100))).all())
    return {"available": get_settings().im_enabled, "providers": provider_catalog(),
            "connections": [connections.public(row) for row in rows]}


@router.post("/connections")
async def create(request: Request, client=Depends(current_client), session=Depends(get_session)):
    return await connections.create(session, client, await json_body(request))


@router.post("/connections/{connection_id}/connect")
async def connect(connection_id: str, client=Depends(current_client), session=Depends(get_session)):
    return await connections.connect(session, client, connection_id)


@router.delete("/connections/{connection_id}")
async def revoke(connection_id: str, client=Depends(current_client), session=Depends(get_session)):
    return await connections.revoke(session, client, connection_id)


@router.get("/connections/{connection_id}/targets")
async def targets(connection_id: str, client=Depends(current_client), session=Depends(get_session)):
    connection = await connections.owned(session, client, connection_id)
    own_clients = select(models.Client.id).where(models.Client.user_ref == client.user_ref, models.Client.auth_state == "active")
    runners = list((await session.scalars(select(am.RunnerNode).where(
        (am.RunnerNode.client_id.in_(own_clients)) | (am.RunnerNode.owner_user_id == client.user_ref)))).all())
    tasks = list((await session.scalars(select(models.Task).where(models.Task.owner_client_id == client.id,
        models.Task.status != "cancel", models.Task.archived_at.is_(None)).order_by(models.Task.updated_at.desc()).limit(100))).all())
    from ..services import im_execution, im_targets
    choices = await im_targets.models(session, client)
    runner_agents = {runner.id: im_targets.agents(client, runner, choices)
        if runner.client_id == client.id and runner_hub.CLIENT_TAG in (runner.tags or []) else [] for runner in runners}
    result = []
    for task in tasks:
        execution = await im_execution.execution(session, task.id)
        for runner in runners:
            if runner.auth_state == "revoked" or runner.management_state or (execution and execution.runner_id != runner.id):
                continue
            result.append({"taskId": task.id, "title": task.title, "runnerId": runner.id,
                "runnerName": runner.enroll_name or runner.host or runner.id,
                "online": bool(runner_hub.get(runner.id)), "started": bool(execution),
                "agentId": execution.engine if execution else "",
                "runnerKind": "desktop" if runner.client_id else "cloud", "agents": runner_agents[runner.id]})
    return {"targets": result[:200]}


@router.post("/connections/{connection_id}/pairings")
async def pairing(connection_id: str, request: Request, client=Depends(current_client), session=Depends(get_session)):
    return await connections.pairing(session, client, connection_id, await json_body(request))


@router.get("/connections/{connection_id}/bindings")
async def bindings(connection_id: str, client=Depends(current_client), session=Depends(get_session)):
    await connections.owned(session, client, connection_id)
    rows = list((await session.scalars(select(im.IMBinding).where(im.IMBinding.connection_id == connection_id)
        .order_by(im.IMBinding.created_at.desc()).limit(100))).all())
    return {"bindings": [{"id": row.id, "taskId": row.task_id, "runnerId": row.runner_id,
        "enabled": row.enabled, "external": row.external_identity} for row in rows]}


@router.delete("/bindings/{binding_id}")
async def revoke_binding(binding_id: str, client=Depends(current_client), session=Depends(get_session)):
    row = await session.get(im.IMBinding, binding_id)
    if not row:
        raise HTTPException(404, "绑定不存在")
    await connections.owned(session, client, row.connection_id)
    row.enabled = False
    await session.commit()
    return {"ok": True}


@router.get("/connections/{connection_id}/messages")
async def messages(connection_id: str, client=Depends(current_client), session=Depends(get_session)):
    await connections.owned(session, client, connection_id)
    rows = list((await session.scalars(select(im.IMInbox).where(im.IMInbox.connection_id == connection_id)
        .order_by(im.IMInbox.created_at.desc()).limit(50))).all())
    outgoing = list((await session.scalars(select(im.IMOutbox).where(im.IMOutbox.inbox_id.in_([row.id for row in rows])))).all())
    return {"messages": [{"id": row.id, "taskId": row.task_id, "status": row.status, "detail": row.detail,
        "createdAt": row.created_at.isoformat(), "outgoing": [{"status": item.status, "kind": item.kind,
            "detail": item.detail} for item in outgoing if item.inbox_id == row.id]} for row in rows]}


@router.post("/messages/{message_id}/dismiss")
async def dismiss(message_id: str, client=Depends(current_client), session=Depends(get_session)):
    row = await session.get(im.IMInbox, message_id)
    if not row:
        raise HTTPException(404, "消息不存在")
    await connections.owned(session, client, row.connection_id)
    if row.status == "uncertain":
        row.status, row.detail = "cancelled", "已人工结束核对；未重新发送"
        await session.execute(update(im.IMRoute).where(im.IMRoute.task_id == row.task_id,
            im.IMRoute.active_inbox_id == row.id).values(active_inbox_id=""))
    changed = await session.execute(update(im.IMOutbox).where(im.IMOutbox.inbox_id == row.id,
        im.IMOutbox.status == "uncertain").values(status="cancelled", detail="已人工结束核对；未重新发送"))
    if row.status != "cancelled" and not changed.rowcount:
        raise HTTPException(409, "只有待核对消息可以人工解除")
    await session.commit()
    return {"ok": True, "resent": False}


@router.api_route("/webhooks/{connection_id}", methods=["GET", "POST"])
async def webhook(connection_id: str, request: Request, session=Depends(get_session)):
    connections.enabled()
    connection = await session.get(im.IMConnection, connection_id)
    if not connection:
        raise HTTPException(404, "连接不存在")
    await connections.authorize(session, connection, active=False)
    if request.method == "GET" and connection.provider != "wecom":
        raise HTTPException(405, "平台回调方法不正确")
    raw = await raw_body(request)
    credentials = connections.unpack(connection)
    if connection.provider == "teams":
        from ..services import im_teams
        event, response = await im_teams.parse(credentials, request.headers, raw)
    else:
        event, response = im_adapters.parse(connection.provider, credentials,
            connection.config or {}, request.headers, raw, query=request.query_params, method=request.method)
    if event is not None:
        if not connection.enabled:
            raise HTTPException(409, "请先启用远程连接")
        await im_ingress.record_verification(session, connection, event)
        await im_ingress.accept(session, connection, event)
    return PlainTextResponse(response) if isinstance(response, str) else response
