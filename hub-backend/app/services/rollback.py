"""Public module behavior and service contracts."""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy.ext.asyncio import AsyncSession

from . import optional_internal_features, task_events

log = logging.getLogger("uvicorn.error")

_DONE = {"SUCCESS"}


def _entries(node):
    """Yield structured deployment records without extracting IDs from nearby JSON text."""
    if isinstance(node, dict):
        if "productVersionId" in node:
            yield node
        for value in node.values():
            yield from _entries(value)
    elif isinstance(node, list):
        for item in node:
            yield from _entries(item)


def _pick(rows: list[dict], *, version: str) -> dict:
    """Select the deployment record by its exact version number.
    
    Never substitute a recent successful deployment when the requested version is missing.
    Several products can share an environment; an environment-only fallback could select
    another product's release and roll it back. Report a missing match explicitly.
    """
    if not version:
        return {}
    for row in rows:
        if str(row.get("productVersion") or "") == version:
            return row
    return {}


def _query(customer: str, product: str, cicd_url: str, size: int = 50) -> list[dict]:
    """Query deployment history for the specific customer and product, newest first. Product
    filtering is required when a customer hosts multiple products.
    """
    optional_internal_features.require("cicd")
    from .cicd_publish import CicdMcp
    mcp = CicdMcp(cicd_url) if cicd_url else CicdMcp()
    args = {"customer_name": customer, "size": size}
    if product:
        args["product_name"] = product
    return list(_entries(mcp.call_tool("cicd_query_deployments", args)))


async def latest_published(session: AsyncSession, task_id: str) -> dict:
    """Return the task's latest publication facts, or empty when absent."""
    from sqlalchemy import select

    from .. import automation_models as am
    run_ids = list((await session.execute(select(am.WorkflowRun.id).where(
        am.WorkflowRun.task_id == task_id))).scalars().all())
    if not run_ids:
        return {}
    rows = list((await session.execute(select(am.NodeRun).where(
        am.NodeRun.run_id.in_(run_ids), am.NodeRun.node_type == "publish"
    ).order_by(am.NodeRun.created_at.desc()))).scalars().all())
    for row in rows:
        out = dict(row.output or {})
        if out.get("customer"):
            return out
    return {}


async def plan(session: AsyncSession, task, published: dict) -> dict:
    """Read-only rollback plan showing the current version and previous version from publication
    evidence.
    """
    customer = str(published.get("customer") or "").strip()
    environment = str(published.get("environment") or "").strip()
    version = str(published.get("version") or "").strip()
    cicd_url = str(published.get("cicdMcpUrl") or "")
    if not customer:
        return {"ok": False, "why": "这条需求没有发布记录（或者不是走公司 CICD 发的）"}
    if not version:
        return {"ok": False, "why": "这次发布没留下版本号，认不出该退哪条——不能猜着回滚"}
    optional_internal_features.require("cicd")
    from .cicd_publish import PRODUCT_HINT
    product = str(published.get("product") or PRODUCT_HINT or "")
    try:
        rows = await asyncio.to_thread(_query, customer, product, cicd_url)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "why": "查不到部署记录（%s）" % type(e).__name__}
    row = _pick(rows, version=version)
    if not row:
        return {"ok": False,
                "why": "在 %s 的部署记录里认不出这次发的那条（版本 %s）——"
                       "不能拿别的产品的版本去退，请到 CICD 里人工确认"
                       % (customer, version)}
    # Verify that the environment still runs the version this task deployed.
    # A later deployment must not be undone as part of rolling back this task.
    # Reject stale rollback plans rather than removing unrelated newer changes.
    latest = next((x for x in rows if str(x.get("status") or "").upper() in _DONE), {})
    running = str(latest.get("productVersion") or "")
    if running and running != version:
        return {"ok": False, "customer": customer, "product": product,
                "environment": str(latest.get("environmentName") or environment),
                "current": {"version": running, "id": str(latest.get("productVersionId") or ""),
                            "status": str(latest.get("status") or "")},
                "why": "环境现在跑的是 %s，这次发的 %s 早被后面的版本覆盖了——"
                       "回滚这一条没有意义。要退版本请针对当前这一版来做。" % (running, version)}
    prev_id = str(row.get("lastProductVersionId") or "")
    prev = str(row.get("lastProductVersion") or "")
    out = {
        "ok": bool(prev_id),
        "customer": customer, "environment": str(row.get("environmentName") or environment),
        "product": str(row.get("productName") or ""),
        "current": {"version": str(row.get("productVersion") or ""),
                    "id": str(row.get("productVersionId") or ""),
                    "status": str(row.get("status") or "")},
        "previous": {"version": prev, "id": prev_id},
        "ids": {"customerId": str(row.get("customerId") or ""),
                "environmentId": str(row.get("environmentId") or ""),
                "productId": str(row.get("productId") or "")},
        "cicdMcpUrl": cicd_url,
    }
    if not prev_id:
        out["why"] = "这是该环境的第一版，没有可退回的版本"
    return out


def _deploy(ids: dict, version_id: str, cicd_url: str) -> dict:
    optional_internal_features.require("cicd")
    from .cicd_publish import CicdMcp
    mcp = CicdMcp(cicd_url) if cicd_url else CicdMcp()
    return mcp.call_tool("cicd_deploy_product", {
        "customer_id": ids["customerId"], "environment_id": ids["environmentId"],
        "product_id": ids["productId"], "product_version_id": version_id,
        # Use FULL rollback because incremental rollback semantics are not defined.
        "deployment_volume_type": "FULL",
    }) or {}


async def execute(session: AsyncSession, task, current_plan: dict, *, actor: str = "") -> dict:
    """Deploy the previous version only through an explicit human rollback request."""
    optional_internal_features.require("cicd")
    if not current_plan.get("ok"):
        raise ValueError(current_plan.get("why") or "这条需求没有可回滚的版本")
    ids = dict(current_plan.get("ids") or {})
    if not all(ids.get(k) for k in ("customerId", "environmentId", "productId")):
        raise ValueError("CICD 那边缺客户/环境/产品 id，回滚不能猜着发")
    target = dict(current_plan.get("previous") or {})
    # Persist rollback intent before deployment so interruption leaves an auditable target version.
    task_events.record(session, task.id, "release.rollback_requested", {
        "customer": current_plan.get("customer"), "environment": current_plan.get("environment"),
        "from": (current_plan.get("current") or {}).get("version"),
        "to": target.get("version"), "by": actor or "SoduWork",
    }, actor=actor or "SoduWork")
    await session.commit()
    try:
        result = await asyncio.to_thread(_deploy, ids, str(target.get("id")),
                                         str(current_plan.get("cicdMcpUrl") or ""))
    except Exception as e:  # noqa: BLE001
        task_events.record(session, task.id, "release.rollback_failed",
                           {"to": target.get("version"), "error": str(e)[:300]},
                           actor=actor or "SoduWork")
        await session.commit()
        raise
    task_events.record(session, task.id, "release.rolled_back", {
        "customer": current_plan.get("customer"), "environment": current_plan.get("environment"),
        "to": target.get("version"), "result": result,
    }, actor=actor or "SoduWork")
    await session.commit()
    try:
        from . import notify
        await notify.notify_and_alert(
            session, task, "已把 %s（%s）回滚到 %s。请确认环境是否恢复。" % (
                current_plan.get("customer"), current_plan.get("environment"),
                target.get("version")))
    except Exception:  # noqa: BLE001 - Notification failure must not affect rollback execution.
        pass
    return {"ok": True, "to": target.get("version"), "result": result}
