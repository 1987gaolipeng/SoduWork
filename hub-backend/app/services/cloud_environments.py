"""Personal cloud Runner environments exposed to an authenticated client.

Each account may own one independent RunnerNode. Legacy rows whose owner is
NULL remain available to operator/admin inventory APIs, but this client API
never exposes or dispatches to them. The plaintext enrollment key is returned
only by create/credentials and is never persisted or included in list/update.
"""
from __future__ import annotations

import ipaddress
from pathlib import PureWindowsPath
from urllib.parse import urlsplit, urlunsplit

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..agent_catalog import AGENTS
from ..automation_models import RunnerNode
from ..config import get_settings
from . import audit, conversation_handoffs, runner_enroll, runner_hub, runner_registry
from .execution_host_policy import cloud_runner_allowed
from .runner_access_policy import require_personal_mutation


def agent_setup():
    install = AGENTS.get("pi", {}).get("install") or {}
    package = str(install.get("pkg") or "@earendil-works/pi-coding-agent")
    # Keep the fallback deterministic if an older catalog omits the version.
    version = str(install.get("version") or "0.84.4").strip()
    if version:
        package += "@" + version
    return {"name": "Pi", "prerequisites": "Node.js 22.19 或更新版本",
            "command": "npm install -g " + package,
            "note": "使用与执行服务相同的账号安装；确保 Node/npm/pi 在服务 PATH；重启执行机后检查连接"}


def safe_hub_url(value):
    try:
        return runner_enroll.validate_hub_url(value)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def _loopback(host):
    if str(host or "").lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def service_info(request_base):
    requested = safe_hub_url(str(request_base))
    preferred = get_settings().hub_public_url.strip()
    parts = urlsplit(requested)
    local = _loopback(parts.hostname)
    suggested = preferred or requested
    if not preferred and local:
        lan = runner_enroll._lan_ip()
        if lan:
            host = ("[" + lan + "]") if ":" in lan else lan
            suggested = urlunsplit((parts.scheme, host + (":" + str(parts.port) if parts.port else ""),
                                    parts.path, "", ""))
    suggested = safe_hub_url(suggested)
    return {"url": requested, "recommendedHub": suggested, "local": local,
            "note": ("当前连接本机服务。关闭客户端后云端执行可继续，但这台电脑和后台服务仍需保持运行；关闭电脑需要将后台部署到远程服务器。"
                     if local else "云端执行依赖当前 SoduWork 服务和远程执行机持续在线。")}


async def _user(session, client):
    return await conversation_handoffs.owner(session, client)


async def _own_row(session, user_id, runner_id, *, lock=False):
    if lock:
        from .runner_access_policy import acquire_runner_policy_lock
        await acquire_runner_policy_lock(session, runner_id)
    query = select(RunnerNode).where(RunnerNode.id == str(runner_id or ""),
                                     RunnerNode.owner_user_id == str(user_id or "")).execution_options(
                                         populate_existing=True)
    if lock:
        query = query.with_for_update()
    return await session.scalar(query)


def _validate_root(value):
    root = value or ""
    if not isinstance(root, str) or len(root) > 500 or any(ord(c) < 32 or c == '"' for c in root):
        raise HTTPException(422, "工作目录格式不正确")
    if root and not (root.startswith("/") or PureWindowsPath(root).is_absolute()):
        raise HTTPException(422, "工作目录需要填写远程机器上的绝对路径，或留空使用默认目录")
    return root.strip()


def _name(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 80 or any(ord(c) < 32 for c in value):
        raise HTTPException(422, "请填写 1 至 80 个字符的环境名称")
    return value.strip()


def _status(row, live):
    management = str(getattr(row, "management_state", "") or "")
    if management:
        return management, {
            "disabled": "已由管理员停用，现有工作可完成，不能启动新工作",
            "pending_setup": "管理员正在安全交接此云端电脑，重新接入并启用后可使用",
            "retired": "此云端电脑身份已回收",
        }.get(management, "此云端电脑暂不可用，请联系管理员")
    if not cloud_runner_allowed(row.id, live.client_id if live else row.client_id):
        return "deployment_restricted", "当前部署未允许使用此个人执行机"
    if row.auth_state == "revoked":
        return "revoked", "接入凭据已撤销"
    if not live:
        return ("pending", "等待执行机连接") if not row.last_seen_at else ("offline", "执行机离线")
    code = conversation_handoffs._target_reason(
        live, current_device=False,
        ready=runner_hub.can_dispatch(live) and bool(live.work_root)
        and "handoff1" in live.caps and runner_hub.supports_capabilities(live, ["files", "terminal"])
        and any(a.get("key") in AGENTS and a.get("auth") != "unauthed" for a in live.agents))
    if code == "ready" and not runner_hub.has_capacity(live):
        code = "at_capacity"
    return code, conversation_handoffs._TARGET_REASONS[code][0]


def _available_agents(live_agents):
    """Return a small user-facing Harness list for a personal cloud machine.

    The catalog remains server-owned; the client only receives display
    metadata and installation state. Unsupported account-only adapters stay
    out of the one-click cloud flow until they have a reviewed cloud adapter.
    """
    installed = {a.get("key"): a for a in (live_agents or [])
                 if isinstance(a, dict) and a.get("key")}
    rows = []
    for key, spec in sorted(AGENTS.items(), key=lambda pair: pair[1].get("order", 999)):
        access = spec.get("accessControl") or {}
        runner = spec.get("runner") or {}
        install = spec.get("install") or {}
        if not access.get("supported") or spec.get("transport") not in {"runner", "direct"}:
            continue
        current = installed.get(key) or {}
        ready = bool(current) and str(current.get("auth") or "").lower() != "unauthed"
        rows.append({
            "id": key,
            "name": spec.get("displayName") or key,
            "summary": spec.get("summary") or "",
            "installed": bool(current),
            "ready": ready,
            "version": str(current.get("version") or "")[:80],
            "reason": "请在云端电脑上完成此底座的登录" if current and not ready else "",
            "installable": (install.get("installer") in {"npm", "managed"}
                            or key == "harness2" and install.get("installer") == "bundled"),
            "installer": install.get("installer") or "",
            "adapter": runner.get("adapter") or "",
        })
    return rows


def public(row, live, *, can_manage=True):
    status, text = _status(row, live)
    management = str(getattr(row, "management_state", "") or "")
    can_manage = bool(can_manage and not management)
    labels = {"pending": "等待连接", "offline": "已离线", "revoked": "已撤销",
        "disabled": "管理员已停用", "pending_setup": "等待安全接入", "retired": "已回收",
        "deployment_restricted": "部署未允许", "ready": "可执行", "starting": "准备中",
        "paused": "暂停接单", "update_required": "需更新", "missing_workspace": "未设目录",
        "missing_capabilities": "能力未就绪", "missing_agent": "缺少 Agent",
        "auth_required": "需要登录", "at_capacity": "负载已满", "service_unavailable": "服务异常"}
    action = (conversation_handoffs._TARGET_REASONS.get(status) or ("", "check_connection"))[1]
    agents = (live.agents if live else row.agents) or []
    return {"id": row.id, "name": row.enroll_name or row.host or row.id,
        "host": live.host if live else row.host, "os": live.os if live else row.os,
        "online": live is not None, "status": status, "statusText": labels.get(status, "待检查"),
        "statusReason": text, "action": action,
        "eligible": not management and status != "deployment_restricted",
        "managementState": management,
        "agents": [{"id": a.get("key", ""), "name": a.get("name") or a.get("key", ""),
                    "ready": bool(live and a.get("key") in AGENTS and a.get("auth") != "unauthed")}
                   for a in agents if isinstance(a, dict) and a.get("key")],
        "availableAgents": _available_agents(agents),
        "busy": runner_hub.effective_load(live) if live else max(0, row.busy or 0),
        "maxConcurrent": max(1, int(live.max_concurrent if live else row.max_concurrent or 1)),
        "mode": "disabled" if management else (live.dispatch_mode if live else row.dispatch_mode),
        "canManage": bool(can_manage), "ownerUserId": row.owner_user_id or "",
        "orgId": row.org_id or "", "workRoot": row.work_root or "",
        "credential": {"configured": bool(row.secret_hash and row.auth_state == "active"),
                       "canRotate": bool(can_manage)},
        "lastSeen": int(live.last_beat) if live else runner_registry._epoch(row.last_seen_at),
        "version": live.version if live else row.version,
        "workspaceConfigured": bool(live.work_root if live else row.work_root)}


async def list_environments(session, client, request_base):
    user = await _user(session, client)
    row = await session.scalar(select(RunnerNode).where(RunnerNode.owner_user_id == user.id))
    environments = [public(row, runner_hub.get(row.id))] if row is not None else []
    return {"ok": True, "environments": environments, "ownership": "personal",
        "permissions": {"canCreate": row is None, "limit": 1,
                        "canManage": bool(row and not getattr(row, "management_state", ""))},
        "organizations": [], "service": service_info(request_base), "agentSetup": agent_setup(),
        "routing": {"mode": "auto", "description": "开始云端执行时，系统自动选择你已接入且匹配底座的个人环境；同一会话后续始终在原环境继续。"}}


async def create(session, client, body, request_base):
    user = await _user(session, client)
    if not isinstance(body, dict) or set(body) - {"name", "hub", "workRoot"}:
        raise HTTPException(422, "个人云端环境只支持 name、hub、workRoot，不能指定组织或其他归属")
    existing = await session.scalar(select(RunnerNode).where(
        RunnerNode.owner_user_id == user.id).with_for_update())
    if existing is not None:
        raise HTTPException(409, "每个账号只能配置一台个人云端环境")
    name = _name(body.get("name"))
    hub = safe_hub_url(body.get("hub") or service_info(request_base)["recommendedHub"])
    if _loopback(urlsplit(hub).hostname) or urlsplit(hub).hostname in {"0.0.0.0", "::"}:
        raise HTTPException(422, "远程执行机不能连接本机回环地址，请使用它可访问的 SoduWork 服务地址")
    root = _validate_root(body.get("workRoot"))
    try:
        enrolled = await runner_enroll.enroll(session, host=name, org_id=user.org_id or None,
                                               hub=hub, work_root=root, owner_user_id=user.id)
        row = await session.get(RunnerNode, enrolled["runnerId"])
        row.work_root = root
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(409, "每个账号只能配置一台个人云端环境") from exc
    await audit.log(session, user, "runner.enroll", "runner", row.id, name,
                    {"orgId": row.org_id or "", "source": "personal-cloud-environment"})
    return {"ok": True, "environment": public(row, None),
            # `hub` is the address the remote machine uses in its install
            # command.  `clientHub` is the origin of the authenticated client
            # that created this setup response; a local client may expose a
            # LAN-reachable `hub` while its credential vault is scoped to
            # 127.0.0.1.  Keeping both prevents a valid setup from being
            # rejected during the automatic SSH install step.
            "setup": {"runnerId": row.id, "hub": hub,
                      "clientHub": service_info(request_base)["url"], "key": enrolled["key"],
                      "commands": enrolled["commands"], "packages": enrolled["packages"],
                      "agentSetup": agent_setup()}}


async def update(session, client, runner_id, body):
    user = await _user(session, client)
    row = await _own_row(session, user.id, runner_id, lock=True)
    if row is None:
        raise HTTPException(404, "云端环境不存在或不属于当前账号")
    require_personal_mutation(row)
    if not isinstance(body, dict) or not body or set(body) - {"name", "mode", "workRoot"}:
        raise HTTPException(422, "仅支持修改环境名称、工作目录和接单状态")
    root = _validate_root(body["workRoot"]) if "workRoot" in body else row.work_root or ""
    if "workRoot" in body and root != (row.work_root or ""):
        raise HTTPException(409, "修改工作目录需要停止执行机，再更新接入密钥并使用新命令重新接入")
    if "name" in body:
        row.enroll_name = _name(body["name"])
    if "mode" in body:
        if not isinstance(body["mode"], str) or body["mode"] not in runner_registry.MODES:
            raise HTTPException(422, "接单状态不正确")
        await runner_registry.set_mode(session, row.id, body["mode"])
    await session.commit()
    await audit.log(session, user, "runner.configure", "runner", row.id, row.enroll_name,
                    {"fields": sorted(body), "source": "personal-cloud-environment"})
    return {"ok": True, "environment": public(row, runner_hub.get(row.id))}


async def rotate_credentials(session, client, runner_id, body, request_base):
    user = await _user(session, client)
    row = await _own_row(session, user.id, runner_id, lock=True)
    if row is None:
        raise HTTPException(404, "云端环境不存在或不属于当前账号")
    require_personal_mutation(row)
    if not isinstance(body, dict) or set(body) - {"hub", "workRoot"}:
        raise HTTPException(422, "密钥轮换只支持 hub、workRoot")
    blocker = await runner_registry.removal_blocker(session, row.id)
    if blocker:
        raise HTTPException(409, "执行机在线或仍有运行中的会话，暂不能轮换接入凭据")
    hub = safe_hub_url(body.get("hub") or service_info(request_base)["recommendedHub"])
    if _loopback(urlsplit(hub).hostname) or urlsplit(hub).hostname in {"0.0.0.0", "::"}:
        raise HTTPException(422, "远程执行机不能连接本机回环地址，请使用它可访问的 SoduWork 服务地址")
    root = _validate_root(body["workRoot"]) if "workRoot" in body else row.work_root or ""
    row.work_root = root
    enrolled = await runner_enroll.enroll(session, runner_id=row.id, host=row.enroll_name or row.host,
                                           hub=hub, work_root=root, org_id=row.org_id,
                                           owner_user_id=user.id)
    await session.commit()
    await audit.log(session, user, "runner.credentials.rotate", "runner", row.id,
                    row.enroll_name or row.host, {"source": "personal-cloud-environment"})
    return {"ok": True, "environment": public(row, None),
            "setup": {"runnerId": row.id, "hub": hub,
                      "clientHub": service_info(request_base)["url"], "key": enrolled["key"],
                      "commands": enrolled["commands"], "packages": enrolled["packages"],
                      "agentSetup": agent_setup()}}


async def delete(session, client, runner_id):
    user = await _user(session, client)
    row = await _own_row(session, user.id, runner_id, lock=True)
    if row is None:
        raise HTTPException(404, "云端环境不存在或不属于当前账号")
    require_personal_mutation(row)
    # Idle online sockets can be evicted immediately; only active work blocks.
    blocker = await runner_registry.active_session_blocker(session, row.id)
    if blocker:
        raise HTTPException(409, blocker)
    runner_key = row.id
    name = row.enroll_name or row.host
    await runner_registry.revoke_key(session, runner_key)
    await session.delete(row)
    await session.commit()
    await runner_hub.disconnect_runner(runner_key)
    await audit.log(session, user, "runner.delete", "runner", runner_id, name,
                    {"source": "personal-cloud-environment"})
    return {"ok": True, "id": runner_id}
