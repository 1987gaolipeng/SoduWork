"""Conditionally update one organization connection; server-generated versions exclude secrets."""
from __future__ import annotations

import hashlib
import hmac
import json
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from ..config import get_settings
from ..models import AppSetting
from . import mcp_servers as mcp


def revision(value):
    encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hmac.new(get_settings().auth_secret.encode(),
                    ("mcp-company-v1:" + encoded).encode(), hashlib.sha256).hexdigest()


def public(row):
    return {**mcp.mask(row), "revision": revision(row)}


def view(rows):
    return {"servers": [public(row) for row in rows], "revision": revision(rows)}


async def locked_rows(session):
    # PostgreSQL row locks serialize merges; save-time CAS also protects SQLite and initial-row races.
    query = select(AppSetting).where(AppSetting.key == mcp.SETTING_KEY).with_for_update().execution_options(populate_existing=True)
    row = (await session.execute(query)).scalar_one_or_none()
    if row is None:
        # Ensure the first connection has a lockable catalog row; concurrent creation must reuse the committed winner.
        try:
            async with session.begin_nested():
                session.add(AppSetting(key=mcp.SETTING_KEY, value="[]"))
                await session.flush()
        except IntegrityError:
            pass
        await session.execute(query)
    return await mcp.load(session)


def expected(original, old):
    if not isinstance(original, dict) or not old or original.get("id") != old["id"]:
        raise HTTPException(409, "连接已改变或不存在，请刷新后重试")
    if not hmac.compare_digest(str(original.get("revision") or ""), revision(old)):
        raise HTTPException(409, "连接刚被其他管理员修改，请刷新后重试")


async def save_one(session, body):
    raw = body.get("server")
    if not isinstance(raw, dict) or not str(raw.get("id") or "").strip() or len(str(raw["id"])) > 36:
        raise HTTPException(400, "请提供连接及固定标识")
    rows = await locked_rows(session)
    old = next((row for row in rows if row["id"] == raw["id"]), None)
    original = body.get("original")
    if old:
        expected(original, old)
    elif original is not None:
        raise HTTPException(409, "连接已删除，请刷新后重试")
    restored = mcp.restore(raw, old or {})
    if not str(restored.get("name") or "").strip():
        raise HTTPException(400, "请填写连接名称")
    following = [restored if row["id"] == raw["id"] else row for row in rows]
    if old is None:
        following.append(restored)
    return await save(session, following)


async def delete_one(session, item_id, body):
    rows = await locked_rows(session)
    old = next((row for row in rows if row["id"] == item_id), None)
    expected(body.get("original"), old)
    return await save(session, [row for row in rows if row["id"] != item_id])


async def save(session, rows):
    try:
        return await mcp.save(session, rows)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


async def legacy_save(session, body):
    if not isinstance(body.get("servers"), list):
        raise HTTPException(400, "servers 必须是数组")
    rows = await locked_rows(session)
    supplied = body.get("revision")
    old = {row["id"]: row for row in rows}
    raw = [mcp.restore(row, old.get(str(row.get("id") or ""), {}))
           for row in body["servers"] if isinstance(row, dict)]
    if len(raw) != len(body["servers"]):
        raise HTTPException(400, "连接条目格式不正确")
    clean = [mcp._clean_one(row) for row in raw]
    if supplied is not None:
        if not hmac.compare_digest(str(supplied), revision(rows)):
            raise HTTPException(409, "连接目录刚被更新，请刷新后重试")
    elif rows and clean != rows:
        # Support legacy initial saves and idempotent retries without inferring deletion from an unversioned overwrite.
        raise HTTPException(409, "请刷新管理页面后重试；旧版保存缺少连接目录版本，不能安全覆盖")
    return await save(session, raw)
