"""MCP import and credential-free company submission; authenticated device/admin APIs."""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, File, Query, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_client, require_perm
from ..models import AppSetting, Client, User
from ..services import capability_catalog, connector_catalog, mcp_export, mcp_import, mcp_servers, runner_hub

router = APIRouter()
admin_router = APIRouter()
PREFIX = "mcp_share_"


async def upload(file):
    try:
        return mcp_import.parse(await file.read(mcp_import._MAX_BYTES + 1), file.filename or "")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


def personal_candidates(parsed):
    for item in parsed["items"]:
        row = item["row"]
        if not item["valid"]:
            continue
        if row.get("command") == "soduwork-api":
            row.update(approved=True, approvedTarget="api:" + row["apiDefinition"]["id"])
            try:
                item["row"] = mcp_servers.personal_spec(row)
            except ValueError as exc:
                item["valid"] = False
                item["errors"].append(str(exc))
            continue
        if row["type"] == "stdio":
            template = next((t for t in capability_catalog.MCP_TEMPLATES
                             if t.get("template", {}).get("command") == row["command"]
                             and t.get("template", {}).get("args", []) == row["args"]
                             and (t.get("configurable") or t.get("template", {}).get("env", {}) == row["env"])), None)
            if not template:
                item["valid"] = False
                item["errors"].append("自定义本地命令需管理员导入；个人连接仅支持可信模板")
                continue
            row["templateKey"] = template["key"]
        row.update(approved=True, approvedTarget=row.get("templateKey") or row["url"])
        try:
            item["row"] = mcp_servers.personal_spec(row)
        except ValueError as exc:
            item["valid"] = False
            item["errors"].append(str(exc))
    return parsed


@router.post("/mcp-servers/export")
async def export_personal(body: dict = Body(default_factory=dict),
                          client: Client = Depends(current_client)):
    try:
        result = mcp_export.personal(client.mcp_servers or [], body)
    except mcp_export.ExportError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@router.post("/mcp-servers/import/preview")
async def preview(file: UploadFile = File(...), client: Client = Depends(current_client),
                  session: AsyncSession = Depends(get_session)):
    parsed = personal_candidates(await upload(file))
    names = [r["name"] for r in [*mcp_servers.personal_load(client), *await mcp_servers.load(session)]]
    return mcp_import.public_preview(parsed, names)


@router.post("/mcp-servers/import")
async def import_personal(file: UploadFile = File(...), confirmed: bool = Query(False),
                          client: Client = Depends(current_client),
                          session: AsyncSession = Depends(get_session)):
    if not confirmed:
        raise HTTPException(400, "请先确认连接目标和权限范围；导入后保持停用")
    parsed = personal_candidates(await upload(file))
    await session.refresh(client, with_for_update=True)
    current = mcp_servers.personal_load(client)
    company = {r["name"].casefold() for r in await mcp_servers.load(session)}
    for item in parsed["items"]:
        item["row"]["id"] = str(uuid.uuid5(uuid.NAMESPACE_URL, client.id + parsed["checksum"] + item["name"]))
        if item["name"].casefold() in company:
            item["valid"] = False
    result = mcp_import.import_rows(parsed, current, max_total=20)
    if result["imported"]:
        try:
            await mcp_servers.personal_save(session, client, result["rows"])
            await session.commit()
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
    view = await mcp_servers.client_view(session, client)
    imported_names = {r["name"] for r in result["imported"]}
    # The editor needs the newly imported, credential-masked rows immediately
    # so the client can open a prefilled review form instead of making the user
    # find the connection and copy every field by hand.
    imported_rows = [row for row in view.get("personal", [])
                     if row.get("name") in imported_names]
    return {"ok": True, **view,
            "imported": [r["name"] for r in result["imported"]],
            "importedRows": imported_rows, "skipped": result["skipped"]}


def public(record):
    return {k: record.get(k) for k in ("id", "name", "submittedBy", "submittedAt", "status",
                                      "note", "requiredCredentials", "spec", "publishedId")}


async def records(session):
    rows = (await session.execute(select(AppSetting).where(
        AppSetting.key.startswith(PREFIX)).order_by(AppSetting.key).limit(1000))).scalars()
    return [(row, json.loads(row.value)) for row in rows]


@router.get("/mcp-servers/submissions")
async def own_submissions(client: Client = Depends(current_client),
                          session: AsyncSession = Depends(get_session)):
    return {"items": [public(r) for _, r in await records(session) if r["owner"] == client.id]}


@router.post("/mcp-servers/{server_id}/share")
async def share(server_id: str, body: dict = Body(default_factory=dict),
                client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    if body.get("confirmed") is not True:
        raise HTTPException(400, "请确认共享配置，不包含个人密钥")
    spec = next((r for r in mcp_servers.personal_load(client) if r["id"] == server_id), None)
    if spec is None:
        raise HTTPException(404, "个人连接不存在")
    name = str(body.get("name") or (spec["name"] + "-company")).strip()
    if not name or len(name) > 60:
        raise HTTPException(400, "公司连接名称为 1–60 个字符")
    required = [field + "." + key for field in ("env", "headers") for key in spec[field]]
    catalog = capability_catalog.mcp_template(spec.get("templateKey", ""))
    if connector_catalog.configurable(catalog):
        required = ["env." + field["key"] for field in catalog["connectionFields"] if field.get("required")]
    try:
        clean = mcp_export.shared_spec(spec, name)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    signature = json.dumps(clean, sort_keys=True, ensure_ascii=False)
    key = PREFIX + hashlib.sha256((client.id + server_id + signature).encode()).hexdigest()[:50]
    found = await session.get(AppSetting, key)
    if found:
        record = json.loads(found.value)
        if record["status"] == "rejected":
            previous = found.value
            record.update(status="pending", note="", submittedAt=datetime.now(timezone.utc).isoformat())
            changed = await session.execute(update(AppSetting).where(
                AppSetting.key == key, AppSetting.value == previous).values(
                    value=json.dumps(record, ensure_ascii=False)).execution_options(synchronize_session=False))
            if changed.rowcount != 1:
                raise HTTPException(409, "申请状态已变化，请刷新后重试")
            await session.commit()
        return {"ok": True, "item": public(record)}
    if any(r["name"].casefold() == name.casefold() for r in await mcp_servers.load(session)):
        raise HTTPException(409, "公司已有同名连接，请使用其他名称，避免覆盖")
    existing = await records(session)
    if sum(r["owner"] == client.id and r["status"] == "pending" for _, r in existing) >= 20:
        raise HTTPException(409, "最多保留 20 个待审核连接")
    record = {"id": key, "owner": client.id, "name": name, "submittedBy": client.name,
              "submittedAt": datetime.now(timezone.utc).isoformat(), "status": "pending",
              "note": "", "requiredCredentials": required, "spec": clean}
    session.add(AppSetting(key=key, value=json.dumps(record, ensure_ascii=False)))
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        found = await session.get(AppSetting, key)
        if not found:
            raise
        record = json.loads(found.value)
    return {"ok": True, "item": public(record)}


@admin_router.get("/mcp/submissions")
async def submissions(user: User = Depends(require_perm("integration.manage")),
                      session: AsyncSession = Depends(get_session)):
    return {"items": [public(r) for _, r in await records(session)]}


@admin_router.post("/mcp/submissions/{submission_id}/review")
async def review(submission_id: str, body: dict = Body(default_factory=dict),
                 user: User = Depends(require_perm("integration.manage")),
                 session: AsyncSession = Depends(get_session)):
    row = await session.get(AppSetting, submission_id) if submission_id.startswith(PREFIX) else None
    if row is None:
        raise HTTPException(404, "共享申请不存在")
    previous = row.value
    record = json.loads(previous)
    if record["status"] != "pending":
        return {"ok": True, "item": public(record)}
    action = body.get("action")
    if action == "reject":
        record.update(status="rejected", note=str(body.get("note") or "请完善连接配置后重新提交")[:400])
    elif action == "publish":
        spec = dict(body.get("server") or {})
        spec.update(id=str(uuid.uuid5(uuid.NAMESPACE_URL, submission_id)), name=record["name"], enabled=True)
        try:
            mcp_servers.validate_controls(spec)
            mcp_servers.validate_size(spec)
            if spec.get("type") == "http":
                spec["url"] = mcp_servers._safe_http_url(spec.get("url", ""))
            for key in record["requiredCredentials"]:
                field, name = key.split(".", 1)
                if not str((spec.get(field) or {}).get(name) or "").strip():
                    raise ValueError("请补充公司凭据：" + name)
            result = await mcp_servers.probe_managed(spec)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if not result.get("ok"):
            raise HTTPException(422, str(result.get("error") or "连接实测未通过")[:600])
        from ..services import mcp_company_write
        current = await mcp_company_write.locked_rows(session)
        if any(r["name"].casefold() == record["name"].casefold() for r in current):
            raise HTTPException(409, "已有同名公司连接，不能覆盖；请刷新处理")
        if len(current) >= 200:
            raise HTTPException(409, "公司连接已达到容量上限")
        try:
            await mcp_servers.save(session, [*current, spec])
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        record.update(status="approved", publishedId=spec["id"],
                      note=("工具清单已加载，业务授权待验证；已向公司客户端开放"
                            if spec.get("command") == connector_catalog.COMMAND
                            else "实测通过，已向公司客户端开放"))
    else:
        raise HTTPException(400, "请选择发布或退回")
    changed = await session.execute(update(AppSetting).where(
        AppSetting.key == submission_id, AppSetting.value == previous).values(
            value=json.dumps(record, ensure_ascii=False)).execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        await session.rollback()
        raise HTTPException(409, "申请已被其他管理员处理，请刷新")
    await session.commit()
    from ..services import audit
    await audit.log(session, user, "mcp.share." + action, "setting", submission_id,
                    record["name"], {"status": record["status"], "name": record["name"]})
    return {"ok": True, "item": public(record)}


@router.post("/mcp-servers/company/{server_id}/probe")
async def probe_company(server_id: str, client: Client = Depends(current_client),
                        session: AsyncSession = Depends(get_session)):
    spec = next((r for r in await mcp_servers.load(session)
                 if r["id"] == server_id and r.get("enabled")), None)
    if spec is None:
        raise HTTPException(404, "公司连接已停用或不存在")
    if spec["type"] != "http":
        runner = runner_hub.for_client(client.id)
        if runner is None:
            from ..services import connector_health
            return connector_health.result("offline")
    else:
        runner = None
    result = await mcp_servers.probe_managed(spec, preferred_runner=runner)
    # No raw response or credential-bearing target is returned.
    return {k: v for k, v in result.items() if k in (
        "ok", "error", "tools", "blockedTools", "discoveredTools", "missingEnabledTools", "runOn", "runnerHost", "authenticationTested", "connectionState", "checkedAt", "message", "verificationScope")}
