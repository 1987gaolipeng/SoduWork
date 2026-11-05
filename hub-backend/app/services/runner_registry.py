"""Durable inventory and dispatch policy for execution runners."""
from __future__ import annotations

import hashlib
import hmac
import secrets as _secrets
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from . import agent_naming, execution_capabilities
from .runner_identity_error import RunnerIdentityConflict

MODES = {"accepting", "draining", "disabled"}
_ACTIVE_SESSION = {"queued", "dispatching", "running", "waiting_external"}
PERSIST_EVERY_S = 45


# Per-machine keys for standalone Runners.
# Embedded Runners use device credentials; shared runner_token remains transitional.
# Store SHA-256 hashes of high-entropy keys and reveal plaintext only once at issuance.

def _key_hash(key: str) -> str:
    return hashlib.sha256(str(key or "").encode("utf-8")).hexdigest()


async def issue_key(session: AsyncSession, runner_id: str, host: str = "",
                    org_id: str | None = None,
                    owner_user_id: str | None = None) -> str:
    """Issue or rotate a standalone Runner key, preregistering the node if necessary. Rotation
    immediately invalidates the old key.
    """
    runner_id = str(runner_id or "").strip()[:80]
    if not runner_id:
        raise ValueError("执行机 id 不能为空")
    row = await session.get(am.RunnerNode, runner_id)
    if row is not None and str(getattr(row, "management_state", "") or "") in {"retired", "pending_setup"}:
        raise ValueError("此执行机身份已回收或尚未完成安全交接，不能签发接入凭据")
    from . import runner_hub
    live = runner_hub.get(runner_id)
    if (row and (row.client_id or runner_hub.CLIENT_TAG in set(row.tags or []))) or (
            live and runner_hub.is_client_runtime(live)):
        raise ValueError("个人客户端使用设备身份，不能为它签发独立执行机钥匙；请新建云端执行机")
    requested_owner = str(owner_user_id or "").strip()[:36]
    if row is not None and requested_owner and row.owner_user_id not in (None, requested_owner):
        # A credentials request may never claim another user's environment.
        raise ValueError("执行机已归属于其他账号")
    if row is None:
        row = am.RunnerNode(id=runner_id, dispatch_mode="accepting",
                            host=str(host or "")[:100], owner_user_id=requested_owner or None)
        session.add(row)
    elif requested_owner and row.owner_user_id is None:
        # Only the personal cloud-environment enrollment path passes an owner;
        # regular/admin runner registration omits it and cannot implicitly claim
        # a legacy shared row.
        row.owner_user_id = requested_owner
    if org_id:
        row.org_id = str(org_id)[:36]
    key = _secrets.token_urlsafe(32)
    row.secret_hash = _key_hash(key)
    row.auth_state = "active"
    return key


async def revoke_key(session: AsyncSession, runner_id: str) -> am.RunnerNode | None:
    """Revoke one machine's key by clearing its hash and marking that node revoked."""
    row = await session.get(am.RunnerNode, str(runner_id or ""))
    if row is None:
        return None
    row.secret_hash = ""
    row.auth_state = "revoked"
    return row


async def active_session_blocker(session: AsyncSession, runner_id: str) -> str:
    """Return a user-facing reason when a Runner still owns live work."""
    running = await session.scalar(select(am.ExecutionSession.id).where(
        am.ExecutionSession.runner_id == runner_id,
        am.ExecutionSession.state.in_(_ACTIVE_SESSION),
    ).limit(1))
    if running:
        return "此环境还有未结束的会话，请先确认执行状态再移除"
    return ""


async def removal_blocker(session: AsyncSession, runner_id: str) -> str:
    """Both management surfaces preserve an offline Runner's unfinished work."""
    from . import runner_hub
    if runner_hub.get(runner_id) is not None:
        return "执行机仍在线，请先停止该远程执行机再移除环境；正在运行的会话不会被中断"
    running = await session.scalar(select(am.ExecutionSession.id).where(
        am.ExecutionSession.runner_id == runner_id,
        am.ExecutionSession.state.in_(_ACTIVE_SESSION),
    ).limit(1))
    if running:
        return "此环境还有未结束的会话，请先确认执行状态再移除"
    return ""


async def verify_key(session: AsyncSession, runner_id: str, key: str) -> bool:
    row = await session.get(am.RunnerNode, str(runner_id or ""))
    if (row is None or row.auth_state != "active" or not row.secret_hash
            or str(getattr(row, "management_state", "") or "") in {"retired", "pending_setup"}):
        return False
    return hmac.compare_digest(row.secret_hash, _key_hash(key))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _epoch(value: datetime | None) -> int:
    if value is None:
        return 0
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return int(value.timestamp())


def _clean_agents(value) -> list[dict]:
    out = []
    for item in value or []:
        if not isinstance(item, dict) or not str(item.get("key") or "").strip():
            continue
        row = {
            "key": str(item.get("key") or "")[:40],
            "name": str(item.get("name") or item.get("key") or "")[:80],
            "version": str(item.get("version") or "")[:40],
        }
        if str(item.get("auth") or "") in ("authed", "unauthed"):
            row["auth"] = str(item.get("auth"))
        out.append(row)
    return out[:20]


def _clean_tags(value) -> list[str]:
    return [str(x).strip().lower()[:40] for x in (value or []) if str(x).strip()][:20]


async def record(session: AsyncSession, runner, *, force: bool = False) -> am.RunnerNode:
    """Upsert the latest runner facts while preserving the operator's dispatch policy."""
    now_ts = time.time()
    row = await session.get(am.RunnerNode, str(runner.id))
    if row is None:
        # Handshake recording and list-time preregistration can race to insert the same Runner.
        # Both may initially observe no row.
        # Use a savepoint so a duplicate insert rolls back only that operation, then update the existing row.
        try:
            async with session.begin_nested():
                row = am.RunnerNode(id=str(runner.id), dispatch_mode="accepting")
                session.add(row)
                await session.flush()
        except Exception:  # noqa: BLE001 - Another transaction may have inserted the row first.
            row = await session.get(am.RunnerNode, str(runner.id))
            if row is None:
                raise
    management = str(getattr(row, "management_state", "") or "")
    if management in {"retired", "pending_setup"}:
        raise ValueError("执行机身份已回收或尚未完成安全交接")
    reported_client = str(getattr(runner, "client_id", "") or "")[:64]
    if reported_client and row.secret_hash:
        raise ValueError("A device credential cannot replace an independently enrolled Runner")
    if row.client_id and row.client_id != reported_client:
        raise RunnerIdentityConflict()
    if row.dispatch_mode == "draining" and reported_client:
        # A crashed updater cannot send its final release event.  Its embedded
        # Runner heartbeat is the recovery clock: once the persisted lease has
        # expired, accepting mode is restored before dispatch facts are copied.
        from . import update_safety
        await update_safety.expire_for_client(session, reported_client)
    runner.management_state = management
    runner.dispatch_mode = ("disabled" if management else
                            row.dispatch_mode if row.dispatch_mode in MODES else "disabled")
    reported_org = str(getattr(runner, "org_id", "") or "")[:36]
    if str(getattr(runner, "client_id", "") or "") and reported_org:
        row.org_id = reported_org
    runner.org_id = str(row.org_id or reported_org or "")[:36]
    runner.owner_user_id = str(row.owner_user_id or "")
    last_write = float(getattr(runner, "_registry_write", 0) or 0)
    if not force and now_ts - last_write < PERSIST_EVERY_S:
        return row
    row.client_id = str(getattr(runner, "client_id", "") or "")[:64]
    reported_host = str(getattr(runner, "host", "") or "")[:100]
    # Personal cloud environments store the owner-entered SSH address. Keep it
    # as the public/reachable host for previews; the Runner hello commonly
    # reports a private hostname (or a container name) that a desktop cannot
    # resolve. Shared runners have no owner-entered address and continue to
    # follow the live hello value.
    if not row.owner_user_id or not row.host:
        row.host = reported_host
    if row.owner_user_id and row.host:
        runner.host = str(row.host)[:80]
    row.os = str(getattr(runner, "os", "") or "")[:100]
    row.version = str(getattr(runner, "version", "") or "")[:40]
    row.work_root = str(getattr(runner, "work_root", "") or "")[:700]
    row.tags = _clean_tags(getattr(runner, "tags", []))
    row.agents = _clean_agents(getattr(runner, "agents", []))
    row.capabilities = execution_capabilities.clean_report(
        getattr(runner, "capabilities", None))
    row.busy = max(0, int(getattr(runner, "busy", 0) or 0))
    from . import runner_hub
    row.max_concurrent = runner_hub.clean_max_concurrent(
        getattr(runner, "max_concurrent", None), getattr(row, "max_concurrent", 1) or 1)
    row.last_seen_at = _now()
    runner._registry_write = now_ts
    return row


async def mark_offline(session: AsyncSession, runner_id: str) -> bool:
    """Clear volatile load only when the exact live connection was removed."""
    row = await session.get(am.RunnerNode, str(runner_id or ""))
    if row is None:
        return False
    row.busy = 0
    return True


async def reconcile_stale_busy(session: AsyncSession, cutoff_seconds: int = 30) -> int:
    """Recover heartbeat load left by a crashed Hub or an unclean disconnect."""
    cutoff = _now() - timedelta(seconds=max(30, int(cutoff_seconds or 30)))
    active = select(am.ExecutionSession.runner_id).where(
        am.ExecutionSession.runner_id != "",
        am.ExecutionSession.state.in_(_ACTIVE_SESSION),
    )
    result = await session.execute(
        update(am.RunnerNode)
        .where(
            am.RunnerNode.busy > 0,
            am.RunnerNode.last_seen_at.is_not(None),
            am.RunnerNode.last_seen_at < cutoff,
            ~am.RunnerNode.id.in_(active),
        )
        .values(busy=0)
    )
    return max(0, int(result.rowcount or 0))


async def set_mode(session: AsyncSession, runner_id: str, mode: str) -> am.RunnerNode | None:
    mode = str(mode or "").strip().lower()
    if mode not in MODES:
        raise ValueError("执行节点状态只能是 accepting、draining 或 disabled")
    row = await session.get(am.RunnerNode, str(runner_id or ""))
    if row is None:
        return None
    if mode == "accepting" and str(getattr(row, "management_state", "") or ""):
        raise ValueError("此云端电脑已被管理员停用或正在交接，请通过管理流程启用")
    row.dispatch_mode = mode
    from . import runner_hub
    live = runner_hub.get(row.id)
    if live is not None:
        live.dispatch_mode = mode
        live.management_state = str(getattr(row, "management_state", "") or "")
        from .cluster_runtime import RemoteRunner
        if isinstance(live, RemoteRunner):
            await live.call("$policy", {"mode": mode, "managementState": live.management_state}, 10)
    return row


def is_shared(client_id: str) -> bool:
    """Identify shared standalone Runners without an owning desktop client. Preserve their
    visibility and dispatch eligibility within the authorized organization scope rather than
    filtering them out as unowned.
    """
    return not str(client_id or "").strip()


async def list_nodes(session: AsyncSession, allowed_client_ids: set[str] | None = None,
                     allowed_org_ids: set[str] | None = None,
                     allowed_owner_user_ids: set[str] | None = None, *,
                     include_personal_admin: bool = False) -> list[dict]:
    # Client callers must explicitly name account owners. Only the scoped admin
    # inventory opts into personal rows within its existing organization range.
    owner_scope = {str(x) for x in (allowed_owner_user_ids or set()) if str(x)}
    query = select(am.RunnerNode).where(am.RunnerNode.management_state != "retired").order_by(
        am.RunnerNode.updated_at.desc())
    if not owner_scope and not include_personal_admin:
        query = query.where(am.RunnerNode.owner_user_id.is_(None))
    if allowed_client_ids is not None or allowed_org_ids is not None:
        from sqlalchemy import or_
        owned = am.RunnerNode.client_id.in_(allowed_client_ids or {"__none__"})
        shared = ((am.RunnerNode.client_id == "") | am.RunnerNode.client_id.is_(None)) & \
            am.RunnerNode.org_id.in_(allowed_org_ids or {"__none__"})
        scoped_personal = (am.RunnerNode.owner_user_id.in_(owner_scope)
                           if owner_scope else False)
        query = query.where(or_(owned, shared, scoped_personal))
    elif owner_scope and not include_personal_admin:
        query = query.where(am.RunnerNode.owner_user_id.in_(owner_scope))
    rows = list((await session.execute(query)).scalars().all())

    from . import runner_hub
    live = {x.id: x for x in runner_hub.online()}
    row_ids = {x.id for x in rows}
    # A just-connected runner can be visible before its first transaction is committed.
    for item in live.values():
        if (getattr(item, "management_state", "") in {"retired", "pending_setup"}
                or (getattr(item, "owner_user_id", "") and
                    not include_personal_admin and item.owner_user_id not in owner_scope)):
            continue
        if item.id not in row_ids and runner_hub.in_scope(
                item, allowed_client_ids, allowed_org_ids):
            if await session.get(am.RunnerNode, item.id) is not None:
                continue  # A filtered durable row is not an unregistered socket.
            rows.append(await record(session, item, force=True))
            row_ids.add(item.id)

    active: dict[str, list[am.ExecutionSession]] = {}
    if row_ids:
        sessions = list((await session.execute(select(am.ExecutionSession).where(
            am.ExecutionSession.runner_id.in_(row_ids),
            am.ExecutionSession.state.in_(_ACTIVE_SESSION)
        ).order_by(am.ExecutionSession.updated_at.desc()))).scalars().all())
        for item in sessions:
            active.setdefault(item.runner_id, []).append(item)
        task_ids = {x.task_id for x in sessions if x.task_id}
        titles = {x.id: x.title for x in list((await session.execute(
            select(models.Task.id, models.Task.title).where(models.Task.id.in_(task_ids or {"__none__"}))
        )).all())}
    else:
        titles = {}

    # Use the activated account for Runner ownership; Client.name is a legacy fallback.
    owner_ids = {row.client_id for row in rows if row.client_id} | {
        (live.get(row.id).client_id if live.get(row.id) else "") for row in rows}
    clients = list((await session.execute(
        select(models.Client.id, models.Client.user_ref, models.Client.name)
        .where(models.Client.id.in_(owner_ids or {"__none__"}))
    )).all())
    user_ids = {client.user_ref for client in clients if client.user_ref} | {
        str(row.owner_user_id) for row in rows if row.owner_user_id}
    users = {user.id: (user.display_name or user.username or "")
             for user in list((await session.execute(
                 select(models.User.id, models.User.display_name, models.User.username)
                 .where(models.User.id.in_(user_ids or {"__none__"}))
             )).all())}
    owners = {
        client.id: users.get(client.user_ref or "", "") or (client.name or "")
        for client in clients
    }

    org_ids = {str((live.get(row.id).org_id if live.get(row.id) else row.org_id) or "")
               for row in rows}
    orgs = {item.id: item.name for item in list((await session.execute(
        select(models.OrgUnit).where(models.OrgUnit.id.in_(org_ids or {"__none__"}))
    )).scalars().all())}

    from . import execution_aliases
    aliases = await execution_aliases.load(session)

    def _mkey(row, current):
        return agent_naming.machine_key(
            host=(current.host if current else row.host) or "", runner_id=row.id)

    def _owner(row, current):
        client_id = (current.client_id if current else row.client_id) or ""
        return str(getattr(current, "owner_name", "") or
                   users.get(str(row.owner_user_id or ""), "") or
                   owners.get(client_id, ""))


    # Compute display labels for the whole machine set to resolve collisions.
    labels = agent_naming.unique_machine_labels([{
        "key": _mkey(row, live.get(row.id)),
        "alias": execution_aliases.machine_name(aliases, _mkey(row, live.get(row.id))),
        "host": (live.get(row.id).host if live.get(row.id) else row.host) or "",
        "osName": (live.get(row.id).os if live.get(row.id) else row.os) or "",
        "runnerId": row.id,
        "person": _owner(row, live.get(row.id)),
    } for row in rows])

    out = []
    for row in rows:
        current = live.get(row.id)
        online = bool(current and current.alive())
        management = str(getattr(row, "management_state", "") or "")
        mode = "disabled" if management else str(row.dispatch_mode or "disabled")
        session_rows = active.get(row.id, [])
        mkey = _mkey(row, current)
        raw_tags = list((current.tags if current else row.tags) or [])
        embedded = runner_hub.CLIENT_TAG in set(raw_tags)
        out.append({
            "runnerId": row.id,
            "clientId": (current.client_id if current else row.client_id) or "",
            "orgId": (current.org_id if current else row.org_id) or "",
            "orgName": orgs.get((current.org_id if current else row.org_id) or "", ""),
            # The enrollment host is the address the owner used to reach this
            # machine (and the address a desktop can use for a cloud preview).
            # Runner hello reports socket.gethostname(), which is often an
            # internal/container name and cannot be opened by the client.
            "host": (row.host or (current.host if current else "")) or row.id[:12],
            # Return owner and readable machine label directly to the UI.
            "owner": _owner(row, current),
            "ownerUserId": str(row.owner_user_id or ""),
            "managementState": management,
            # Prefer the installation label over aliases or inferred host labels.
            # Explicit labels distinguish multiple Runners on one physical host.
            "label": row.enroll_name or labels.get(mkey) or agent_naming.auto_machine_label(
                host=(current.host if current else row.host) or "", runner_id=row.id,
                os_name=(current.os if current else row.os) or ""),
            # Use stable host identity for aliases so replacing a Runner does not lose its name.
            "machineKey": mkey,
            "alias": execution_aliases.machine_name(aliases, mkey),
            "os": (current.os if current else row.os) or "",
            "version": (current.version if current else row.version) or "",
            "workRoot": (current.work_root if current else row.work_root) or "",
            # Keep reserved scheduling tags internal; expose the readable embedded state instead.
            "tags": [x for x in raw_tags if x != runner_hub.CLIENT_TAG],
            "embedded": embedded,
            "agents": _clean_agents((current.agents if current else row.agents) or []),
            "skills": list(getattr(current, "skills", []) if current else []),
            "skillsKnown": bool(current and getattr(current, "skills_known", False)),
            "capabilities": execution_capabilities.clean_report(
                (getattr(current, "capabilities", None) if current
                 else getattr(row, "capabilities", None))),
            "busy": max(0, int((current.busy if current else row.busy) or 0)),
            "pending": (max(0, runner_hub.effective_load(current) -
                            max(0, int(current.busy or 0))) if current else 0),
            "load": (runner_hub.effective_load(current) if current
                     else max(0, int(row.busy or 0))),
            "maxConcurrent": runner_hub.clean_max_concurrent(
                (current.max_concurrent if current else row.max_concurrent), 1),
            "adaptiveLimit": runner_hub.clean_max_concurrent(
                (getattr(current, "adaptive_limit", None) if current else row.max_concurrent), 1),
            "concurrencyCeiling": runner_hub.clean_max_concurrent(
                (getattr(current, "concurrency_ceiling", None) if current else row.max_concurrent), 1),
            "queueDepth": runner_hub.clean_counter(
                getattr(current, "queue_depth", 0) if current else 0),
            "queuedConversations": runner_hub.clean_counter(
                getattr(current, "queued_conversations", 0) if current else 0),
            "queuedTasks": runner_hub.clean_counter(
                getattr(current, "queued_tasks", 0) if current else 0),
            "taskOutstanding": runner_hub.clean_counter(
                getattr(current, "task_outstanding", 0) if current else 0),
            "taskQueueCapacity": runner_hub.clean_counter(
                getattr(current, "task_queue_capacity", 0) if current else 0,
                maximum=10_000),
            "cpuPercent": round(runner_hub.clean_percent(
                getattr(current, "cpu_percent", 0) if current else 0), 1),
            "memoryPercent": round(runner_hub.clean_percent(
                getattr(current, "memory_percent", 0) if current else 0), 1),
            "memoryAvailableBytes": runner_hub.clean_counter(
                getattr(current, "memory_available_bytes", 0) if current else 0,
                maximum=1 << 60),
            "resourcePressure": str(
                getattr(current, "resource_pressure", "") if current else "")[:20],
            "available": bool(not management and mode == "accepting" and
                              current and runner_hub.has_capacity(current)),
            "shared": bool(not row.owner_user_id and
                            is_shared((current.client_id if current else row.client_id) or "")),
            "scopeState": "assigned" if ((current.org_id if current else row.org_id) or "") else "unassigned",
            # Display preregistered nodes separately from machines never enrolled.
            "enrolled": bool(row.auth_state == "active" and not row.last_seen_at),
            "online": online,
            "mode": mode,
            "authState": row.auth_state or "",   # Key state: empty for device/shared-token authentication, active for issued keys, revoked for disabled keys.
            "accepting": online and mode == "accepting" and bool(
                (current.client_id if current else row.client_id) or
                (current.org_id if current else row.org_id)),
            "since": int(current.connected_at) if current else 0,
            "lastSeen": int(current.last_beat) if current else _epoch(row.last_seen_at),
            "sessions": [{
                "id": item.id, "taskId": item.task_id,
                "title": titles.get(item.task_id, "") or "未命名任务",
                "engine": item.engine or "", "status": item.state or "",
                "startedAt": item.started_at.isoformat() if item.started_at else "",
            } for item in session_rows[:5]],
        })
    out.sort(key=lambda x: (not x["online"], x["mode"] != "accepting", x["busy"], x["host"]))
    return out
