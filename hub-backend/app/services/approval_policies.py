"""Approval responsibility catalog: permissions govern configuration access; these policies
determine who reviews each request.
"""
from __future__ import annotations

import re

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am

_KEY = re.compile(r"^[a-z][a-z0-9-]{1,62}$")
_ACTIONS = {"baseline", "review", "merge", "uat", "deploy"}
_DIRECT = {"requester", "task_creator", "task_assignee", "owner_client", "project_owner"}
_CATALOG = {"user", "role", "position", "permission"}


def api(row: am.ApprovalPolicy) -> dict:
    return {
        "id": row.id, "orgId": row.org_id, "key": row.key, "name": row.name,
        "description": row.description, "rules": row.rules or {},
        "enabled": row.enabled, "isSystem": row.is_system,
    }


def _text(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _rules(value) -> dict:
    raw = dict(value or {}) if isinstance(value, dict) else {}
    actions = []
    for item in raw.get("actions") or []:
        action = _text(item, 32).lower()
        if action not in _ACTIONS:
            raise ValueError(f"不支持的审批场景：{action or '空'}")
        if action not in actions:
            actions.append(action)
    if not actions:
        raise ValueError("至少选择一个适用场景")
    approvers = []
    for source in (raw.get("approvers") or [])[:30]:
        if not isinstance(source, dict):
            continue
        kind = _text(source.get("type"), 32)
        if kind not in _DIRECT | _CATALOG:
            raise ValueError(f"不支持的审批职责：{kind or '空'}")
        item = {"type": kind, "label": _text(source.get("label"), 80) or "流程指定审批人"}
        if kind in _CATALOG:
            ids = [str(x)[:64] for x in (source.get("ids") or [source.get("id")]) if x]
            key = _text(source.get("key"), 80)
            if kind == "permission":
                if not key:
                    raise ValueError("权限职责缺少权限标识")
                item["key"] = key
            elif not ids:
                raise ValueError("请选择具体岗位、角色或人员")
            else:
                item["ids"] = list(dict.fromkeys(ids))[:50]
        approvers.append(item)
    if not approvers:
        raise ValueError("至少选择一种审批职责")
    # A role selector may expand to several people; do not cap countersigners by selector count.
    required = min(50, max(1, int(raw.get("required") or 1)))
    return {
        "actions": actions, "mode": "any" if required == 1 else "threshold",
        "required": required, "approvers": approvers,
        "invalidateOnNewVersion": True,
        "separationOfDuties": bool(raw.get("separationOfDuties")),
    }


async def list_visible(session: AsyncSession, org_ids: set[str] | None) -> list[dict]:
    q = select(am.ApprovalPolicy).order_by(am.ApprovalPolicy.is_system.desc(),
                                           am.ApprovalPolicy.created_at)
    if org_ids is not None:
        q = q.where((am.ApprovalPolicy.org_id.in_(org_ids or {"__none__"})) |
                    am.ApprovalPolicy.org_id.is_(None))
    return [api(x) for x in (await session.execute(q)).scalars().all()]


async def save(session: AsyncSession, body: dict, row: am.ApprovalPolicy | None = None
               ) -> am.ApprovalPolicy:
    creating = row is None
    key = _text(body.get("key") if creating else body.get("key", row.key), 64).lower()
    if not _KEY.fullmatch(key):
        raise ValueError("策略标识只允许小写字母、数字和短横线")
    org_id = body.get("orgId") if creating else row.org_id
    duplicate = await session.scalar(select(func.count(am.ApprovalPolicy.id)).where(
        am.ApprovalPolicy.key == key, am.ApprovalPolicy.org_id == org_id,
        am.ApprovalPolicy.id != (row.id if row else "__new__")))
    if duplicate:
        raise ValueError("策略标识已经存在")
    rules = _rules(body.get("rules") if creating else body.get("rules", row.rules))
    if creating:
        row = am.ApprovalPolicy(org_id=org_id, key=key,
                                name=_text(body.get("name"), 100) or key)
        session.add(row)
    else:
        row.key = key
        if "name" in body:
            row.name = _text(body.get("name"), 100) or row.name
    row.rules = rules
    if "description" in body:
        row.description = _text(body.get("description"), 400)
    if "enabled" in body:
        row.enabled = bool(body.get("enabled"))
    await session.commit()
    await session.refresh(row)
    return row


async def delete(session: AsyncSession, row: am.ApprovalPolicy) -> None:
    if row.is_system:
        raise ValueError("内置策略可以调整，不能删除")
    used = await session.scalar(select(func.count(am.Environment.id)).where(
        am.Environment.approval_policy_id == row.id))
    if used:
        raise ValueError("仍有环境使用这项审批职责，先更换环境策略")
    await session.delete(row)
    await session.commit()
