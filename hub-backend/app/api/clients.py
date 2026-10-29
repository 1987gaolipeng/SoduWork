"""Client registration, heartbeats, and team summaries; registration reports availability and
version.
"""
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..config import get_settings
from ..deps import current_client
from ..models import Client, User
from ..schemas import ClientRegister, client_to_api
from ..services import inbox as inbox_svc
from ..services import team as team_svc
from ..services import client_access, device_auth, rbac

router = APIRouter(prefix="/api/v1", tags=["clients"])
settings = get_settings()


@router.post("/clients/enroll")
async def enroll(
    body: ClientRegister,
    x_device_key: str | None = Header(default=None, alias="X-Device-Key"),
    session: AsyncSession = Depends(get_session),
):
    """Register metadata and issue a session only for an activated device.

    New devices remain pending until an administrator binds and activates them.
    The long-lived key is supplied by the Electron main process and stored only
    as a SHA-256 digest on the Hub.
    """
    try:
        device = device_auth.validate_device_id(body.device)
        key = device_auth.validate_secret(x_device_key or "")
    except device_auth.DeviceAuthError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc

    c = await session.get(Client, device)
    digest = device_auth.hash_secret(key)
    if c is None:
        c = Client(id=device, secret_hash=digest, auth_state="pending")
        session.add(c)
    else:
        if c.auth_state == "revoked":
            raise HTTPException(status_code=403, detail="这台 SoduWork 已被停用，请联系管理员重新登记")
        if c.secret_hash and not device_auth.secret_matches(c, key):
            raise HTTPException(status_code=401, detail="设备密钥不正确")
        if not c.secret_hash:
            legacy_ok = bool(c.secret and secrets.compare_digest(c.secret, key))
            if c.secret and not legacy_ok:
                raise HTTPException(status_code=401, detail="设备密钥不正确")
            c.secret_hash = digest
            c.secret = None
            # An assigned row without a credential is not proof of possession.
            # The new key must still pass an explicit administrator activation.
            c.auth_state = "pending"
        if c.auth_state == "active":
            try:
                await device_auth.assert_active_owner(session, c)
            except device_auth.DeviceAuthError as exc:
                raise HTTPException(status_code=exc.status, detail=str(exc)) from exc

    if body.name is not None:
        c.name = body.name
    if body.platform is not None:
        c.platform = body.platform
    if body.version is not None:
        c.app_version = body.version
    if body.workRoot:
        c.work_root = str(body.workRoot).strip()[:400]
    c.last_seen_at = datetime.now(timezone.utc)
    await session.commit()
    await session.refresh(c)
    response = client_to_api(c)
    response["activationRequired"] = c.auth_state != "active"
    if c.auth_state == "active":
        try:
            await device_auth.assert_active_owner(session, c)
            # Trusted-device renewal must remain available for final accounting.
            # Every work admission still checks quota independently.
            quota = await client_access.quota_status(
                session, str(c.user_ref or ""))
            response["session"], response["expiresIn"] = device_auth.issue_session(c)
            owner = await session.get(User, str(c.user_ref or ""))
            if owner is not None:
                from .client_auth import _safe_user
                response["user"] = _safe_user(owner)
            response["quota"] = quota
        except device_auth.DeviceAuthError as exc:
            raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
        except client_access.ClientAccessError as exc:
            raise HTTPException(
                status_code=exc.status, detail=exc.detail()) from exc
    return response


@router.post("/clients/register")
async def register(
    body: ClientRegister,
    x_soduwork_secret: str | None = Header(default=None, alias="X-Soduwork-Secret"),
    session: AsyncSession = Depends(get_session),
):
    """Pre-v1 compatibility enrollment.

    It may issue a key once to an old client, but the Hub persists only its
    digest and the device remains pending until an administrator activates it.
    """
    if not settings.device_auth_compat:
        raise HTTPException(status_code=404, detail="Legacy device registration is disabled")
    try:
        device = device_auth.validate_device_id(body.device)
    except device_auth.DeviceAuthError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    c = await session.get(Client, device)
    issued = None
    if c is None:
        issued = secrets.token_urlsafe(32)
        c = Client(id=device, secret_hash=device_auth.hash_secret(issued), auth_state="pending")
        session.add(c)
    elif c.auth_state == "revoked":
        raise HTTPException(status_code=403, detail="这台 SoduWork 已被停用")
    elif c.secret_hash:
        if not device_auth.secret_matches(c, x_soduwork_secret or ""):
            raise HTTPException(status_code=401, detail="设备密钥不正确")
        c.secret = None
        if c.auth_state == "active":
            try:
                await device_auth.assert_active_owner(session, c)
            except device_auth.DeviceAuthError as exc:
                raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    else:
        legacy = str(c.secret or "")
        if legacy:
            if not x_soduwork_secret or not secrets.compare_digest(legacy, x_soduwork_secret):
                raise HTTPException(status_code=401, detail="设备密钥不正确")
            c.secret_hash = device_auth.hash_secret(x_soduwork_secret)
            c.secret = None
        else:
            issued = secrets.token_urlsafe(32)
            c.secret_hash = device_auth.hash_secret(issued)
            c.auth_state = "pending"
    if body.name is not None:
        c.name = body.name
    if body.platform is not None:
        c.platform = body.platform
    if body.version is not None:
        c.app_version = body.version
    # Update the workspace only when the client supplies a nonempty value.
    # Partial registration requests must not erase a directory needed for automatic dispatch.
    if body.workRoot:
        c.work_root = str(body.workRoot).strip()[:400]
    c.last_seen_at = datetime.now(timezone.utc)
    await session.commit()
    await session.refresh(c)
    resp = client_to_api(c)
    if issued:
        resp["secret"] = issued
    return resp


@router.get("/team")
async def team(
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Return departmental-subtree team workload, devices, and sources; unassigned devices see only
    themselves with assigned=False.
    """
    return await team_svc.team_overview(session, client)


@router.get("/team/capability")
async def team_cap(
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Check whether the device owner can manage teams, controlling visibility of the team entry
    point.
    """
    return await team_svc.team_capability(session, client)


@router.get("/team/tasks")
async def team_tasks(
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """List departmental-subtree tasks and assigners for authorized team managers."""
    return await team_svc.team_tasks(session, client)


@router.post("/team/tasks")
async def create_team_task(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Dispatch a task to a team member and send a live desktop notification."""
    r = await team_svc.create_team_task(session, client, body)
    if not r.get("ok"):
        msg = {"forbidden": "无团队管理权限", "no_title": "请填需求标题",
               "no_assignee": "请选择指派成员", "out_of_scope": "该成员不在你的团队内",
               "no_box": "该成员还没有绑定 SoduWork，无法派需求", "inactive": "该成员已停用，无法派需求"}.get(r.get("reason"), "派需求失败")
        raise HTTPException(status_code=400, detail=msg)
    return r


@router.post("/team/tasks/{tid}/status")
async def set_team_task_status(
    tid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Update a team member's task status, including completion on their behalf, and notify their
    client.
    """
    r = await team_svc.set_team_task_status(session, client, tid, body.get("status") or "")
    if not r.get("ok"):
        msg = {"forbidden": "无团队管理权限", "bad_status": "非法状态", "not_found": "需求不存在",
               "out_of_scope": "该需求不在你的团队内",
               "engine_managed": "这条活正被流程引擎接管，状态由流程决定"}.get(r.get("reason"), "操作失败")
        raise HTTPException(status_code=400, detail=msg)
    return r


@router.post("/team/tasks/{tid}/nudge")
async def nudge_team_task(
    tid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Send a reminder or message to a task holder directly from the desktop team view."""
    r = await team_svc.nudge_team_task(session, client, tid, body.get("note") or "")
    if not r.get("ok"):
        msg = {"forbidden": "无团队管理权限", "not_found": "需求不存在", "already_done": "需求已完成，不用催了",
               "out_of_scope": "该需求不在你的团队内", "self": "这是你自己的需求，就别催自己了"}.get(r.get("reason"), "催办失败")
        raise HTTPException(status_code=400, detail=msg)
    return r


# Legacy team advance/reject routes were retired with FlowTemplate.
# Plugin runs manage stage transitions; human confirmation uses the approval inbox.


@router.get("/team/inbox")
async def team_inbox(
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """List ownerless tasks in the department subtree for team members to claim."""
    return await inbox_svc.list_inbox(session, client)


@router.post("/team/inbox/{tid}/claim")
async def claim_inbox_task(
    tid: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Claim a task for this client; return HTTP 409 if another member already claimed it."""
    r = await inbox_svc.claim(session, client, tid)
    if not r.get("ok"):
        code = {"already_claimed": 409, "not_found": 404}.get(r.get("reason"), 400)
        msg = {"unassigned": "本设备未归属组织", "not_found": "需求不存在",
               "already_claimed": "该需求已被别人认领", "out_of_scope": "该需求不在你的团队收件箱内"}.get(r.get("reason"), "认领失败")
        raise HTTPException(status_code=code, detail=msg)
    return r


@router.post("/team/inbox/{tid}/assign")
async def assign_inbox_task_from_box(
    tid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Assign an inbox task to a team member and notify their client. Requires canManage and
    matches the administrative assignment endpoint.
    """
    from ..models import User
    me = await session.get(User, client.user_ref) if client.user_ref else None
    if not await team_svc._can_manage(session, me):
        raise HTTPException(status_code=403, detail="无团队管理权限")
    uid = (body.get("userId") or "").strip()
    target = await session.get(User, uid) if uid else None
    if target is None:
        raise HTTPException(status_code=404, detail="成员不存在")
    if not target.is_active:
        raise HTTPException(status_code=400, detail="该成员已停用，无法分配需求")
    # The target must belong to the caller's department subtree.
    from ..services import rbac
    scope = await rbac.subtree_org_ids(session, me.org_id) if me.org_id else set()
    if target.org_id not in (scope or set()):
        raise HTTPException(status_code=403, detail="该成员不在你的团队内")
    r = await inbox_svc.assign_to_user(session, tid, target,
                                       await inbox_svc.scope_for_user(session, me),
                                       actor_name=me.display_name or me.username, actor_id=me.id)
    if not r.get("ok"):
        code = {"already_claimed": 409, "not_found": 404}.get(r.get("reason"), 400)
        msg = {"not_found": "需求不存在", "already_claimed": "该需求已被认领或已派走",
               "not_in_inbox": "该需求不在收件箱里", "out_of_scope": "该需求不在你的收件箱范围内",
               "no_box": "该成员还没有绑定 SoduWork，无法分配"}.get(r.get("reason"), "分配失败")
        raise HTTPException(status_code=code, detail=msg)
    return r


@router.post("/tasks/{tid}/release")
async def release_task(
    tid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Return an owned task to the team inbox; workflow tasks use stage rejection instead."""
    r = await inbox_svc.release(session, client, tid, body.get("note") or "")
    if not r.get("ok"):
        msg = {"not_found": "需求不存在", "not_owner": "这不是你持有的需求",
               "already_done": "需求已完成，不能退回收件箱",
               "is_flow": "流程需求请用「退回上一步」", "unassigned": "本设备未归属组织，无团队收件箱"}.get(r.get("reason"), "退回失败")
        raise HTTPException(status_code=400, detail=msg)
    return r


@router.get("/team/mates")
async def list_teammates(
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """List active colleagues other than the caller as transfer targets; transferring owned work
    does not require management permission.
    """
    return await team_svc.my_teammates(session, client)


@router.post("/team/mates/{uid}/message")
async def message_teammate(
    uid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Send a short mention notification using the organization-wide colleague directory."""
    r = await team_svc.message_mate(session, client, uid, str(body.get("text") or ""), body)
    if not r.get("ok"):
        msg = {"no_user": "本 SoduWork 还没绑定用户，请让管理员分配归属",
               "empty": "消息内容不能为空",
               "target_out_of_scope": "这位同事不在当前企业的可用人员中",
               "no_box": "这位同事还没有 SoduWork，消息送不过去"}.get(r.get("reason"), "消息没有发出去")
        raise HTTPException(status_code=400, detail=msg)
    return r


@router.get("/team/messages")
async def list_mate_messages(folder: str = "received", limit: int = 100, before: str = "",
                             client: Client = Depends(current_client),
                             session: AsyncSession = Depends(get_session)):
    from ..services import mate_messages
    return await mate_messages.list_for(session, client, folder, limit, before)


@router.get("/team/messages/{message_id}/preview/{asset_path:path}")
async def preview_mate_message(message_id: str, asset_path: str, ticket: str = Query(default=""),
                               session: AsyncSession = Depends(get_session)):
    """Serve a packaged website from Hub storage, never the sender's localhost."""
    from ..auth import verify_claims
    from ..services import storage
    from ..models import Attachment, MateMessage
    import io, mimetypes, posixpath, zipfile
    claims = verify_claims(ticket, token_type="mate-preview")
    if not claims or str(claims.get("messageId") or "") != str(message_id):
        raise HTTPException(status_code=401, detail="Preview ticket is invalid or expired")
    row = await session.get(MateMessage, message_id)
    if row is None or str(claims.get("recipientId") or "") != str(row.recipient_id):
        raise HTTPException(status_code=404, detail="Preview does not exist")
    names = [str(item.get("name") or "") for item in row.attachments or [] if isinstance(item, dict)]
    zip_id = next((str(item.get("id")) for item in row.attachments or []
                   if isinstance(item, dict) and str(item.get("name") or "").lower().endswith(".zip")), "")
    if not zip_id:
        raise HTTPException(status_code=404, detail="Preview does not exist??")
    attachment = await session.get(Attachment, zip_id)
    if attachment is None or attachment.filename not in names:
        raise HTTPException(status_code=404, detail="Preview does not exist?")
    try:
        data = await __import__("asyncio").to_thread(storage.get, attachment.storage_key, attachment.backend)
        archive = zipfile.ZipFile(io.BytesIO(data))
        clean = posixpath.normpath("/" + str(asset_path or "index.html")).lstrip("/")
        if clean == "." or clean.startswith("../") or "/../" in clean:
            raise KeyError(clean)
        entry = archive.getinfo(clean)
        body = archive.read(entry)
    except (FileNotFoundError, KeyError, zipfile.BadZipFile):
        raise HTTPException(status_code=404, detail="Preview does not exist")
    media = mimetypes.guess_type(clean)[0] or "application/octet-stream"
    headers = {"Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff",
               "Content-Security-Policy": "sandbox allow-scripts allow-forms; default-src 'self' data: blob:; connect-src 'none'; frame-ancestors 'none'"}
    return Response(content=body, media_type=media, headers=headers)


@router.post("/team/messages/{message_id}/read")
async def read_mate_message(message_id: str,
                            client: Client = Depends(current_client),
                            session: AsyncSession = Depends(get_session)):
    from ..services import mate_messages
    return await mate_messages.mark_read(session, client, message_id)


@router.post("/team/messages/{message_id}/delivered")
async def delivered_mate_message(message_id: str,
                                 client: Client = Depends(current_client),
                                 session: AsyncSession = Depends(get_session)):
    from ..services import mate_messages
    return await mate_messages.mark_delivered(session, client, message_id)


@router.post("/team/message-draft")
async def mate_message_draft(body: dict = Body(default_factory=dict),
                             client: Client = Depends(current_client),
                             session: AsyncSession = Depends(get_session)):
    from ..services import mate_message_draft as drafts
    return await drafts.draft(session, client, body)


@router.get("/team/message-capabilities")
async def mate_message_capabilities(client: Client = Depends(current_client)):
    return {"files": True, "maxFiles": 20, "maxTotalBytes": 24 * 1024 * 1024}


@router.get("/team/message-files/{aid}")
async def mate_message_file(aid: str, client: Client = Depends(current_client),
                            session: AsyncSession = Depends(get_session)):
    from ..services import mate_message_files
    return await mate_message_files.access(session, client, aid)


@router.post("/tasks/{tid}/handoff")
async def handoff_my_task(
    tid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Transfer the caller's own task to a colleague without requiring management permission."""
    r = await team_svc.handoff_my_task(session, client, tid,
                                       str(body.get("assigneeUserId") or ""),
                                       str(body.get("note") or "")[:300])
    if not r.get("ok"):
        msg = {"not_found": "这不是你持有的需求", "already_done": "需求已完成，不用再转给别人",
               "no_user": "本 SoduWork 还没绑定用户，请让管理员分配归属",
               "target_out_of_scope": "这位同事不在当前企业的可用人员中",
               "no_box": "这位同事还没有 SoduWork，转不过去"}.get(r.get("reason"), "转发失败")
        raise HTTPException(status_code=400, detail=msg)
    return r


@router.post("/tasks/assigned")
async def create_assigned_task(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Create a task directly for one coworker; no manager role is required."""
    r = await team_svc.create_assigned_task(session, client, body)
    if not r.get("ok"):
        msg = {
            "no_user": "这台 SoduWork 尚未绑定有效用户，请联系管理员",
            "no_title": "需求标题不能为空",
            "target_out_of_scope": "接收人不在当前企业或已停用",
            "no_box": "接收人暂时没有可接收需求的 SoduWork",
            "bad_task_id": "需求编号格式不正确",
            "id_conflict": "需求编号已被其他需求占用，请重试",
        }.get(r.get("reason"), "创建交办需求失败")
        raise HTTPException(
            status_code=409 if r.get("reason") == "id_conflict" else 400,
            detail=msg,
        )
    return r


@router.post("/team/tasks/{tid}/reassign")
async def reassign_team_task(
    tid: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Allow a team manager to reassign a task to another member and notify the new holder."""
    r = await team_svc.reassign_team_task(session, client, tid, body.get("assigneeUserId") or "")
    if not r.get("ok"):
        msg = {"forbidden": "无团队管理权限", "not_found": "需求不存在", "out_of_scope": "该需求不在你的团队内",
               "already_done": "需求已完成，无需转派",
               "target_out_of_scope": "目标成员不在你的团队内", "no_box": "该成员还没有 SoduWork"}.get(r.get("reason"), "改派失败")
        raise HTTPException(status_code=400, detail=msg)
    return r
