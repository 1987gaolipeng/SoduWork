"""Scoped administration and safe ownership handover of personal cloud hosts.

Handover rotates the execution identity, not just the displayed owner. Existing
sessions retain their old (revoked) identity and cannot operate the new owner's
host. OS access and user data require an operator's clean-host procedure; this
service deliberately never presents a database reassignment as an OS wipe.
"""
from __future__ import annotations

from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..automation_models import RunnerNode
from ..models import AuditLog, User
from . import rbac, runner_enroll, runner_hub, runner_registry
from .cloud_environments import _validate_root


async def _row(session, actor, runner_id, expected_owner):
    from .runner_access_policy import acquire_runner_policy_lock
    await acquire_runner_policy_lock(session, runner_id)
    row = await session.scalar(select(RunnerNode).where(
        RunnerNode.id == runner_id).with_for_update().execution_options(populate_existing=True))
    scope = await rbac.scope_org_ids(session, actor)
    if row is None or (scope is not None and row.org_id not in scope):
        raise HTTPException(404, "云主机不存在或不在管理范围内")
    if row.management_state == "retired":
        raise HTTPException(409, "原执行身份已退役，请刷新列表")
    if not row.owner_user_id or row.client_id:
        raise HTTPException(409, "此操作仅适用于用户添加的云主机")
    if row.owner_user_id != expected_owner:
        raise HTTPException(409, "主机归属已变化，请刷新后重试")
    return row


def _audit(session, actor, row, action, detail):
    # Ownership changes and their audit record must commit atomically.
    session.add(AuditLog(actor_id=actor.id, actor_name=actor.display_name or actor.username,
        actor_org_id=actor.org_id, action=action, target_type="runner",
        target_id=row.id, target_label=row.enroll_name or row.host or row.id, detail=detail))


async def assignees(session, actor, query=""):
    scope = await rbac.scope_org_ids(session, actor)
    used = select(RunnerNode.owner_user_id).where(RunnerNode.owner_user_id.is_not(None))
    stmt = select(User).where(User.is_active.is_(True), User.org_id.is_not(None), User.org_id != "", ~User.id.in_(used))
    if scope is not None:
        stmt = stmt.where(User.org_id.in_(scope or {"__none__"}))
    if query.strip():
        term = query.strip()[:80]
        stmt = stmt.where(User.display_name.contains(term, autoescape=True) |
                          User.username.contains(term, autoescape=True))
    rows = list((await session.scalars(stmt.order_by(User.display_name, User.id).limit(100))).all())
    return {"items": [{"id": u.id, "name": u.display_name or u.username,
                       "username": u.username, "orgId": u.org_id or ""} for u in rows]}


async def availability(session, actor, runner_id, expected_owner, enabled):
    row = await _row(session, actor, runner_id, expected_owner)
    if row.management_state == "pending_setup":
        raise HTTPException(409, "请先完成安全交接并重新接入，再启用")
    if enabled and (row.auth_state != "active" or not row.secret_hash):
        raise HTTPException(409, "接入凭据尚未配置，请先重新登记")
    before = row.management_state
    row.management_state = "" if enabled else "disabled"
    row.dispatch_mode = "accepting" if enabled else "disabled"
    _audit(session, actor, row, "runner.enable" if enabled else "runner.disable",
           {"ownerUserId": row.owner_user_id, "before": before, "after": row.management_state})
    await session.commit()
    # Durable authority is checked again by the RPC boundary, including on a
    # remote Hub. Mirror policy for immediate UI/scheduler feedback as well.
    live = runner_hub.get(row.id)
    if live is not None:
        live.dispatch_mode = row.dispatch_mode
        live.management_state = row.management_state
        from .cluster_runtime import RemoteRunner
        if isinstance(live, RemoteRunner):
            try:
                await live.call("$policy", {"mode": row.dispatch_mode,
                    "managementState": row.management_state}, 10)
            except Exception:
                pass  # Durable admission remains authoritative during an outage.
    return {"ok": True, "runnerId": row.id, "managementState": row.management_state,
            "mode": row.dispatch_mode}


async def transfer(session, actor, runner_id, expected_owner, target_user_id):
    row = await _row(session, actor, runner_id, expected_owner)
    if row.management_state != "disabled":
        raise HTTPException(409, "请先停用云主机，等待执行结束后再分配")
    if runner_hub.get(row.id) is not None:
        raise HTTPException(409, "请先停止原主机的执行服务，离线后再重新分配")
    if expected_owner == target_user_id:
        raise HTTPException(422, "请选择其他用户")
    target = await session.scalar(select(User).where(User.id == target_user_id).with_for_update())
    scope = await rbac.scope_org_ids(session, actor)
    if (target is None or not target.is_active or not target.org_id or
            (scope is not None and target.org_id not in scope)):
        raise HTTPException(404, "目标用户不存在、已停用或不在管理范围内")
    existing = await session.scalar(select(RunnerNode.id).where(
        RunnerNode.owner_user_id == target.id))
    if existing:
        raise HTTPException(409, "该用户已有云主机，每个账号最多分配一台")
    live = runner_hub.get(row.id)
    if (await runner_registry.active_session_blocker(session, row.id) or
            (live is not None and runner_hub.effective_load(live) > 0) or row.busy):
        raise HTTPException(409, "主机仍有执行或排队中的会话，结束后才能重新分配")
    # A new identity cuts all old session-reference and cached-RPC routes. The
    # tombstone must remain: shared-token auth cannot reclaim its former ID.
    replacement = RunnerNode(id="rn-" + uuid4().hex, owner_user_id=target.id,
        org_id=target.org_id, host=row.host, enroll_name=row.enroll_name,
        dispatch_mode="disabled", management_state="pending_setup", auth_state="revoked")
    row.owner_user_id = None
    row.management_state = "retired"
    row.dispatch_mode = "disabled"
    row.secret_hash = ""
    row.auth_state = "revoked"
    session.add(replacement)
    _audit(session, actor, row, "runner.reassign", {"previousOwnerUserId": expected_owner,
        "ownerUserId": target.id, "replacementRunnerId": replacement.id,
        "state": "pending_setup"})
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(409, "目标用户的云主机已变化，请刷新后重试") from exc
    if live is not None:
        live.dispatch_mode = "disabled"
        live.management_state = "retired"
        # A disconnected/offline channel is safe too; revocation is durable
        # even when a network failure prevents immediate socket teardown.
        try:
            await runner_hub.disconnect_runner(row.id)
        except Exception:
            pass
    return {"ok": True, "runnerId": replacement.id, "previousRunnerId": row.id,
            "ownerUserId": target.id, "managementState": "pending_setup"}


async def provision(session, actor, runner_id, expected_owner, body, request_base):
    row = await _row(session, actor, runner_id, expected_owner)
    if row.management_state not in {"pending_setup", "disabled"}:
        raise HTTPException(409, "请先停用云主机再配置接入")
    if await runner_registry.removal_blocker(session, row.id):
        raise HTTPException(409, "请先停止远程执行服务，并确认没有未结束的会话")
    if body.get("hostResetConfirmed") is not True:
        raise HTTPException(422, "请确认已重建主机并撤销原用户的主机访问及旧凭据")
    root = _validate_root(body.get("workRoot"))
    if not root:
        raise HTTPException(422, "请填写清理后的独立工作目录")
    label = row.enroll_name
    row.management_state = "disabled"
    row.work_root = root
    try:
        out = await runner_enroll.enroll(session, runner_id=row.id,
            host=row.host or row.enroll_name, tags=row.tags, hub=body.get("hub") or "",
            request_base=request_base, work_root=root, org_id=row.org_id,
            owner_user_id=row.owner_user_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    row.enroll_name = label or row.enroll_name
    _audit(session, actor, row, "runner.reprovision", {"ownerUserId": row.owner_user_id,
        "hostResetConfirmed": True, "workRoot": root})
    await session.commit()
    return {"ok": True, **out, "managementState": "disabled"}
